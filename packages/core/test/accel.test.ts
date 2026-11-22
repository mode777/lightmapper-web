import { describe, expect, it } from 'vitest';
import {
  CLUSTER_SIZE,
  GRID_SIZE,
  createAccelerationStructures,
  packClusterData,
  type AccelMesh,
} from '../src/accel/accel.js';

/**
 * Port of LightmapperRD::_create_acceleration_structures @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. Byte-level fidelity against
 * the Godot C++ is verified out-of-band (standalone extraction + random
 * scene harness); these tests pin hand-derived structure in-repo.
 */

/** Two triangles forming a quad in the xy plane; soup helpers below. */
function meshFromSoup(
  positions: number[],
  normals: number[],
  uv2: number[],
  opts: Partial<AccelMesh> = {},
): AccelMesh {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uv2: new Float32Array(uv2),
    lightmapSize: [64, 64],
    slice: 0,
    offset: [0, 0],
    cullMode: 2,
    ...opts,
  };
}

const FLAT_NORMALS = (triangles: number) => new Array(triangles * 9).fill(0);

describe('vertex deduplication', () => {
  it('merges corners with equal position/normal/UV (8-float equality)', () => {
    // Quad: 2 triangles sharing 2 corners, identical UVs per corner.
    const mesh = meshFromSoup(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 0,
      ],
      FLAT_NORMALS(2),
      [
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
      ],
    );
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, CLUSTER_SIZE);
    expect(out.vertices.byteLength).toBe(4 * 32); // 4 unique vertices
    const view = new DataView(out.triangles);
    expect([
      view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true),
    ]).toEqual([0, 1, 2]);
    expect([
      view.getUint32(48, true), view.getUint32(52, true), view.getUint32(56, true),
    ]).toEqual([0, 2, 3]);
  });

  it('keeps same-position vertices apart when atlas UVs differ', () => {
    // Two triangles with identical positions but disjoint UVs: the atlas
    // transform happens BEFORE dedup, so nothing merges.
    const mesh = meshFromSoup(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 0, 0, 1, 1, 0,
      ],
      FLAT_NORMALS(2),
      [
        0, 0, 0.5, 0, 0.5, 0.5,
        0.5, 0.5, 1, 0.5, 1, 1,
      ],
    );
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, CLUSTER_SIZE);
    expect(out.vertices.byteLength).toBe(6 * 32);
  });

  it('transforms uv2 into atlas space before dedup', () => {
    // uv2 (0.5, 0.5) with a 64x64 lightmap at offset (16,16) in a 256
    // atlas: 0.5 * (64/256) + 16/256 = 0.1875 exactly in f32.
    const mesh = meshFromSoup(
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
      FLAT_NORMALS(1),
      [0, 0, 1, 0, 0.5, 0.5],
      { offset: [16, 16] },
    );
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, CLUSTER_SIZE);
    const view = new DataView(out.vertices);
    expect(view.getFloat32(2 * 32 + 16, true)).toBeCloseTo(0.1875, 7); // vertex 2 uv.x
  });
});

describe('seam detection (roadmap: seam-bearing quad pair)', () => {
  // TWO quads in ONE mesh sharing the geometric edge P1-P2, with quad 2's
  // UVs mapping that edge elsewhere — exactly a lightmap seam:
  //
  //   quad1 (z=0): P0(0,0,0) P1(1,0,0) P2(1,1,0) P3(0,1,0), uv (0,0)..(1,1)
  //   quad2 (x=1): P1(1,0,0) P2(1,1,0) P4(1,1,1) P5(1,0,1), uv (0,0)..(1,1)
  //
  // GODOT-QUIRK: the Edge->EdgeUV2 map is per-MeshInstance (declared inside
  // the mesh loop), so seams are only blended WITHIN a mesh — the same edge
  // split across two different meshes produces no seam. Both quads must be
  // one mesh here.
  const seamScene = () =>
    meshFromSoup(
      [
        // quad1 tri A: P0 P1 P2
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        // quad1 tri B: P0 P2 P3
        0, 0, 0, 1, 1, 0, 0, 1, 0,
        // quad2 tri C: P1 P2 P4
        1, 0, 0, 1, 1, 0, 1, 1, 1,
        // quad2 tri D: P1 P4 P5
        1, 0, 0, 1, 1, 1, 1, 0, 1,
      ],
      FLAT_NORMALS(4),
      [
        0, 0, 1, 0, 1, 1, // A
        0, 0, 1, 1, 0, 1, // B
        0, 0, 1, 0, 1, 1, // C
        0, 0, 1, 1, 0, 1, // D
      ],
    );

  it('detects the shared edge with differing UVs as exactly one seam', () => {
    const out = createAccelerationStructures([seamScene()], [256, 256], 1, null, 8, CLUSTER_SIZE);
    expect(out.seams.byteLength).toBe(16); // exactly one seam
    const view = new DataView(out.seams);
    // Hand-derived: quad1 corner indices are v0..v3; quad2's copies of
    // P1/P2 (different atlas UVs -> no dedup) are v4/v5. The canonical
    // edge (P1,P2) is found first in tri A (indices 1,2) and again in
    // tri C (indices 4,5): seam = { a: second = (4,5), b: first = (1,2) }.
    expect([
      view.getUint32(0, true), view.getUint32(4, true),
      view.getUint32(8, true), view.getUint32(12, true),
    ]).toEqual([4, 5, 1, 2]);
    expect(out.sliceSeamCount[0]).toBe(1);
  });

  it('produces no seam when the same edge is split across two MESHES (GODOT-QUIRK)', () => {
    const quad1 = meshFromSoup(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 0,
      ],
      FLAT_NORMALS(2),
      [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
    );
    const quad2 = meshFromSoup(
      [
        1, 0, 0, 1, 1, 0, 1, 1, 1,
        1, 0, 0, 1, 1, 1, 1, 0, 1,
      ],
      FLAT_NORMALS(2),
      [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
    );
    const out = createAccelerationStructures([quad1, quad2], [256, 256], 1, null, 8, CLUSTER_SIZE);
    expect(out.seams.byteLength).toBe(32); // zero-seam quirk buffer
    expect(out.sliceSeamCount[0]).toBe(0);
  });

  it('does NOT seam an interior shared edge with shared UVs', () => {
    // A single quad's two triangles share a diagonal edge with equal UVs.
    const mesh = meshFromSoup(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 0,
      ],
      FLAT_NORMALS(2),
      [
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
      ],
    );
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, CLUSTER_SIZE);
    // GODOT-QUIRK: no seams -> buffer still exists (32 bytes, zeroed).
    expect(out.seams.byteLength).toBe(32);
    expect(new Uint8Array(out.seams)).toEqual(new Uint8Array(32));
    expect(out.sliceSeamCount[0]).toBe(0);
  });
});

describe('grid + clusters', () => {
  it('plots a small triangle into a few cells of a coarse grid', () => {
    const mesh = meshFromSoup([0, 0, 0, 1, 0, 0, 0, 1, 0], FLAT_NORMALS(1), [0, 0, 1, 0, 0, 1]);
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, CLUSTER_SIZE);
    // Bounds: min (0,0,0), max (1,1,0) + grow 0.1 -> (-0.1,-0.1,-0.1),
    // size (1.2, 1.2, 0.2). The triangle overlaps only a few cells of the
    // 8x8x8 grid; each solid cell gets exactly one cluster here (one
    // triangle per cell at most).
    let solidCells = 0;
    for (let i = 0; i < out.grid.length / 2; i++) {
      if (out.grid[i * 2] > 0) solidCells++;
    }
    expect(solidCells).toBeGreaterThan(0);
    expect(out.triangleIndices.length).toBe(solidCells); // 1 tri per cell
    expect(out.triangleIndices.length).toBeLessThanOrEqual(8 * 8 * 8);
    expect(out.clusterAabbs.byteLength).toBe(solidCells * 32);
    expect(out.clusterIndices.length).toBe(solidCells * 2);
  });

  it('splits cells with more triangles than the cluster size', () => {
    // 6 triangles roughly on top of each other -> same cell(s), cluster
    // size 4 -> at least 2 clusters for that cell.
    const tris: number[] = [];
    const uvs: number[] = [];
    const norms: number[] = [];
    for (let t = 0; t < 6; t++) {
      tris.push(0, 0, t * 0.01, 1, 0, t * 0.01, 0, 1, t * 0.01);
      uvs.push(0, 0, 1, 0, 0, 1);
      norms.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    }
    const mesh = meshFromSoup(tris, norms, uvs);
    const out = createAccelerationStructures([mesh], [256, 256], 1, null, 8, 4);
    // 6 triangles in one cell -> ceil(6/4) = 2 clusters.
    expect(out.clusterAabbs.byteLength / 32).toBeGreaterThanOrEqual(2);
    expect(out.grid.length).toBe(8 * 8 * 8 * 2);
  });

  it('sorts triangles by slice and counts per slice', () => {
    const a = meshFromSoup([0, 0, 0, 1, 0, 0, 1, 1, 0], FLAT_NORMALS(1), [0, 0, 1, 0, 0, 1], { slice: 1 });
    const b = meshFromSoup([0, 0, 1, 1, 0, 1, 1, 1, 1], FLAT_NORMALS(1), [0, 0, 1, 0, 0, 1], { slice: 0 });
    const out = createAccelerationStructures([a, b], [256, 256], 2, null, 8, CLUSTER_SIZE);
    const view = new DataView(out.triangles);
    expect(view.getUint32(0 * 48 + 12, true)).toBe(0); // slice 0 first
    expect(view.getUint32(1 * 48 + 12, true)).toBe(1);
    expect(out.sliceTriangleCount).toEqual([1, 1]);
  });

  it('grows bounds by 0.1 and includes probe positions', () => {
    const mesh = meshFromSoup([0, 0, 0, 1, 0, 0, 0, 1, 0], FLAT_NORMALS(1), [0, 0, 1, 0, 0, 1]);
    const probes = new Float32Array([5, 0, 0, 0]);
    const out = createAccelerationStructures([mesh], [256, 256], 1, probes, 8, CLUSTER_SIZE);
    // points span [0,1]^2 x {0}; probe x=5; grow 0.1
    expect(out.bounds.position[0]).toBeCloseTo(-0.1, 6);
    expect(out.bounds.position[1]).toBeCloseTo(-0.1, 6);
    expect(out.bounds.size[0]).toBeCloseTo(5 + 0.2, 6);
    expect(out.bounds.size[2]).toBeCloseTo(0.2, 6);
  });

  it('uses the Godot defaults 128 grid / 16 cluster', () => {
    const mesh = meshFromSoup([0, 0, 0, 1, 0, 0, 0, 1, 0], FLAT_NORMALS(1), [0, 0, 1, 0, 0, 1]);
    const out = createAccelerationStructures([mesh], [256, 256], 1, null);
    expect(out.gridSize).toBe(GRID_SIZE);
    expect(out.grid.length).toBe(GRID_SIZE ** 3 * 2);
  });
});

describe('packClusterData (ADR-0005 merged buffer)', () => {
  it('merges indices and AABBs with a 32-byte-aligned AABB region', () => {
    const indices = new Uint32Array([0, 0, 2, 6]); // 2 solid cells
    const aabbs = new ArrayBuffer(32);
    const merged = packClusterData(indices, aabbs);
    expect(merged.buffer.byteLength).toBe(32 + 32); // indices padded 16 -> 32
    expect(merged.aabbOffsetU32).toBe(8);
    const view = new DataView(merged.buffer);
    expect(view.getUint32(0, true)).toBe(0);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getUint32(8, true)).toBe(2);
    expect(view.getUint32(12, true)).toBe(6);
    expect(view.getUint32(28, true)).toBe(0); // padding zero
  });
});
