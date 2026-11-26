import { describe, expect, it } from 'vitest';
import { renderMaterialOnUv2 } from '@lightmapper/gbuffer';
import {
  blitMeshesIntoAtlas,
  createAccelerationStructures,
  f32ToF16,
  f16ToF32,
} from '@lightmapper/core';
import { fixtureScene } from '../src/fixture.js';

/**
 * End-to-end CPU pipeline check for the demo fixture (everything before the
 * GPU stages): gbuffer material images → atlas layout → acceleration
 * structures at the production grid size (128). The large grid is what
 * drives the accel sort into its heap path (see the sort-array regression
 * test) — keep this test at grid 128.
 */
describe('demo fixture — CPU pipeline', () => {
  it('renders material images, packs an atlas and builds accel structures', () => {
    const scene = fixtureScene();
    expect(scene.meshes.length).toBe(9); // 6 walls + 2 boxes + lamp
    expect(scene.lights.length).toBe(2);

    const meshes = scene.resolveMeshes();
    const images = meshes.map((mesh) =>
      renderMaterialOnUv2(
        { positions: mesh.positions, uv2: mesh.uv2!, triangleCount: mesh.triangleCount },
        mesh.material,
        {
          width: mesh.lightmapSizeHint?.[0] ?? 64,
          height: mesh.lightmapSizeHint?.[1] ?? 64,
        },
      ),
    );

    // Wall meshes use the full chart; box meshes use 3×2 chart grids — the
    // image center is a chart *gutter* there, so probe a cell center.
    for (const img of images) {
      const idx = ((img.albedo.height >> 2) * img.albedo.width + (img.albedo.width >> 1)) * 4;
      expect(img.albedo.data[idx + 3], 'chart-cell texel covered').toBe(255);
    }

    const layout = blitMeshesIntoAtlas(
      images.map((i) => ({ width: i.albedo.width, height: i.albedo.height })),
      { maxTextureSize: 1024, deviceMaxTextureSize: 8192, denoiserRange: 8, supersamplingFactor: 1 },
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;

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
      null,
      128,
    );

    // 6 wall quads (2 tris each) + 3 closed boxes (12 tris each).
    expect(accel.sliceTriangleCount.reduce((a, b) => a + b, 0)).toBe(48);
    expect(accel.vertices.byteLength % 32).toBe(0);
    expect(accel.grid.some((v) => v !== 0)).toBe(true);
  });

  it('emissive panel material encodes into rgbah', () => {
    const scene = fixtureScene();
    const lamp = scene.resolveMesh(8); // last mesh = ceiling panel
    const img = renderMaterialOnUv2(
      { positions: lamp.positions, uv2: lamp.uv2!, triangleCount: lamp.triangleCount },
      lamp.material,
      { width: 64, height: 64 },
    );
    const idx = (16 * 64 + 32) * 4; // center of the top-middle chart cell
    expect(f16ToF32(img.emission.data[idx])).toBeCloseTo(4.0, 4); // 1 × energy 4
    expect(f32ToF16(4.0)).toBe(img.emission.data[idx]);
  });
});
