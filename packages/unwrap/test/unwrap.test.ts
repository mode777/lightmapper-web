import { describe, expect, it } from 'vitest';
import {
  GODOT_CHART_OPTIONS,
  godotPackOptions,
  unwrapMesh,
  unwrapSoup,
} from '../src/index.js';

/**
 * Port of godot/modules/xatlas_unwrap/register_types.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. The presets and the output
 * contract (xref + atlas-normalized UVs) are pinned here; chart/pack
 * geometry itself is upstream xatlas behavior.
 */

const quad = () => ({
  positions: new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]),
  normals: new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

describe('Godot presets', () => {
  it('chart options: fixWinding', () => {
    expect(GODOT_CHART_OPTIONS.fixWinding).toBe(true);
  });

  it('pack options: padding 1, maxChartSize 4094, blockAlign, texelsPerUnit = 1/texelSize', () => {
    const pack = godotPackOptions(0.2);
    expect(pack.padding).toBe(1);
    expect(pack.maxChartSize).toBe(4094); // 4096 - 2 for atlas padding
    expect(pack.blockAlign).toBe(true);
    expect(pack.texelsPerUnit).toBe(1 / 0.2);
  });
});

describe('unwrapMesh', () => {
  it('unwraps a unit quad with the Godot output contract', async () => {
    const q = quad();
    const result = await unwrapMesh({ ...q, texelSize: 0.25 });
    expect(result.indexCount).toBe(6);
    expect(result.vertexCount).toBeGreaterThanOrEqual(4);
    expect(result.sizeHint[0]).toBeGreaterThan(0);
    expect(result.sizeHint[1]).toBeGreaterThan(0);
    // xref maps back into the input vertices
    for (let i = 0; i < result.vertexCount; i++) {
      expect(result.vertexMap[i]).toBeLessThan(4);
      // UVs normalized by the atlas dims
      expect(result.uv[i * 2]).toBeGreaterThanOrEqual(0);
      expect(result.uv[i * 2]).toBeLessThanOrEqual(1);
      expect(result.uv[i * 2 + 1]).toBeGreaterThanOrEqual(0);
      expect(result.uv[i * 2 + 1]).toBeLessThanOrEqual(1);
    }
  });

  it('splits UV seams: a shared-corner cube unwraps to more vertices than it has', async () => {
    // Classic 8-corner cube: 12 triangles sharing vertices. Chart cuts
    // duplicate corners at UV seams, so the output must exceed 8.
    const corners = [
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // bottom ring (z=0)
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // top ring (z=1)
    ];
    const positions = new Float32Array(corners);
    const normals = new Float32Array(8 * 3); // flat normals; xatlas only charts with them
    normals.fill(0);
    // +Z, -Z, +X, -X, +Y, -Y (CCW from outside), indices into 0..7
    const faces: number[][] = [
      [4, 5, 6, 4, 6, 7], // +Z
      [1, 0, 3, 1, 3, 2], // -Z
      [5, 1, 2, 5, 2, 6], // +X
      [0, 4, 7, 0, 7, 3], // -X
      [7, 6, 2, 7, 2, 3], // +Y
      [0, 1, 5, 0, 5, 4], // -Y
    ];
    const indices = new Uint32Array(faces.flat());
    const result = await unwrapMesh({ positions, normals, indices, texelSize: 0.5 });
    expect(result.indexCount).toBe(36);
    expect(result.vertexCount).toBeGreaterThan(8);
    // xref still maps back into the 8 input corners
    for (let i = 0; i < result.vertexCount; i++) {
      expect(result.vertexMap[i]).toBeLessThan(8);
    }
  });

  it('throws for texelSize <= 0 (ERR_FAIL_COND)', async () => {
    const q = quad();
    await expect(unwrapMesh({ ...q, texelSize: 0 })).rejects.toThrow(RangeError);
    await expect(unwrapMesh({ ...q, texelSize: -1 })).rejects.toThrow(RangeError);
  });
});

describe('unwrapSoup', () => {
  it('rebuilds the soup with uv2 attached (xref expansion)', async () => {
    const q = quad();
    const soup = await unwrapSoup(q.positions, q.normals, 0.25, q.indices);
    expect(soup.triangleCount).toBe(2);
    expect(soup.positions.length).toBe(18);
    expect(soup.uv2.length).toBe(12);
    // xatlas re-indexes freely, so assert via membership: every soup corner
    // is one of the original quad corners, with its original normal.
    const corners = new Set(
      Array.from({ length: 4 }, (_, i) => Array.from(q.positions.slice(i * 3, i * 3 + 3)).join(',')),
    );
    for (let i = 0; i < 6; i++) {
      const p = Array.from(soup.positions.slice(i * 3, i * 3 + 3)).join(',');
      expect(corners.has(p)).toBe(true);
      expect(Array.from(soup.normals.slice(i * 3, i * 3 + 3))).toEqual([0, 0, 1]);
      // uv2 in 0..1 per corner
      expect(soup.uv2[i * 2]).toBeGreaterThanOrEqual(0);
      expect(soup.uv2[i * 2]).toBeLessThanOrEqual(1);
      expect(soup.uv2[i * 2 + 1]).toBeGreaterThanOrEqual(0);
      expect(soup.uv2[i * 2 + 1]).toBeLessThanOrEqual(1);
    }
  });
});
