import { describe, expect, it } from 'vitest';
import { renderMaterialOnUv2 } from '@lightmapper/gbuffer';
import { BakeScene } from '../src/scene/bake-scene.js';
import { blitMeshesIntoAtlas } from '../src/atlas/pack.js';
import { blitAtlasSlices } from '../src/atlas/blit.js';
import { createAccelerationStructures, packClusterData, GRID_SIZE } from '../src/accel/accel.js';
import { assembleLights, packLightsBuffer } from '../src/scene/lights.js';

/**
 * Integration test of the M2 CPU path (everything before the GPU stages):
 * scene → material UV2 rendering → atlas layout → slice blit →
 * acceleration structures. Mirrors what bakeGBuffer does up to
 * runGBufferStage, minus the device-dependent parts.
 */

function boxScene(): BakeScene {
  const scene = new BakeScene();
  // A room-ish box: two quads with inward flat normals, one red wall.
  scene.addMesh({
    positions: new Float32Array([-2, 0, 2, 2, 0, 2, 2, 0, -2, -2, 0, 2, 2, 0, -2, -2, 0, -2]),
    uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    lightmapSizeHint: [64, 64],
    material: { baseColor: [0.8, 0.8, 0.8] },
  });
  scene.addMesh({
    positions: new Float32Array([-2, 0, -2, 2, 0, -2, 2, 3, -2, -2, 0, -2, 2, 3, -2, -2, 3, -2]),
    uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    lightmapSizeHint: [64, 64],
    material: { baseColor: [0.7, 0.1, 0.1] },
  });
  scene.addOmniLight({ position: [0, 2, 0], energy: 2, range: 8 });
  return scene;
}

describe('M2 CPU path (scene → gbuffer images → atlas → accel)', () => {
  it('runs end-to-end with sane invariants', () => {
    const scene = boxScene();
    const meshes = scene.resolveMeshes();
    expect(meshes).toHaveLength(2);

    // bake_render_uv2 replacement.
    const images = meshes.map((mesh) =>
      renderMaterialOnUv2(
        { positions: mesh.positions, uv2: mesh.uv2!, triangleCount: mesh.triangleCount },
        mesh.material,
        { width: 64, height: 64 },
      ),
    );
    for (const img of images) {
      expect(img.albedo.width).toBe(64);
      // Interior texel covered and colored.
      const idx = (32 * 64 + 32) * 4;
      expect(img.albedo.data[idx + 3]).toBe(255);
    }

    // Atlas layout.
    const layout = blitMeshesIntoAtlas(
      images.map((i) => ({ width: i.albedo.width, height: i.albedo.height })),
      { maxTextureSize: 1024, deviceMaxTextureSize: 8192, denoiserRange: 8, supersamplingFactor: 1 },
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.atlasSlices).toBeGreaterThanOrEqual(1);

    // Slice blit.
    const slices = blitAtlasSlices(images, layout.slots, layout.atlasSize, layout.atlasSlices);
    expect(slices.albedo).toHaveLength(layout.atlasSlices);
    for (const slot of layout.slots) {
      const idx = (slot.offset[1] * layout.atlasSize[0] + slot.offset[0]) * 4;
      expect(slices.albedo[slot.slice][idx + 3]).toBe(255);
    }

    // Acceleration structures.
    const probes = scene.resolveProbes();
    const accel = createAccelerationStructures(
      meshes.map((mesh, i) => ({
        positions: mesh.positions,
        normals: mesh.normals,
        uv2: mesh.uv2!,
        lightmapSize: [images[i].albedo.width, images[i].albedo.height],
        slice: layout.slots[i].slice,
        offset: layout.slots[i].offset,
        cullMode: 2,
      })),
      layout.atlasSize,
      layout.atlasSlices,
      probes.positions.length > 0 ? probes.positions : null,
      GRID_SIZE,
    );
    const totalTriangles = accel.sliceTriangleCount.reduce((a, b) => a + b, 0);
    expect(totalTriangles).toBe(4);
    expect(accel.vertices.byteLength % 32).toBe(0);
    expect(accel.triangles.byteLength).toBe(4 * 48);
    expect(accel.grid.length).toBe(GRID_SIZE ** 3 * 2);
    // At least one solid cell was plotted.
    expect(accel.grid.some((v) => v !== 0)).toBe(true);

    // Merged cluster buffer (ADR-0005).
    const clusterData = packClusterData(accel.clusterIndices, accel.clusterAabbs);
    expect(clusterData.aabbOffsetU32 % 8).toBe(0); // ClusterAABB stride-aligned
    expect(clusterData.buffer.byteLength).toBeGreaterThan(accel.clusterIndices.byteLength);

    // Lights.
    const lightsBytes = packLightsBuffer(assembleLights(scene.lights));
    expect(lightsBytes.byteLength).toBe(128); // 1 light × 128 B
  });

  it('meshes without UV2 are rejected by the M2 flow precondition', () => {
    const scene = new BakeScene();
    scene.addMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
    expect(scene.resolveMesh(0).uv2).toBeUndefined();
  });
});
