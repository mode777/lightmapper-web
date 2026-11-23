import { describe, expect, it } from 'vitest';
import { f16ToF32 } from '@lightmapper/core';
import { renderMaterialOnUv2 } from '../src/index.js';

/** A quad (2 triangles) covering the full 0–1 UV2 chart. */
function fullQuad(uv2 = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])): {
  positions: Float32Array;
  uv2: Float32Array;
  triangleCount: number;
} {
  return {
    positions: new Float32Array(6 * 3),
    uv2,
    triangleCount: 2,
  };
}

describe('renderMaterialOnUv2', () => {
  it('fills covered texels with base color and opacity', () => {
    const images = renderMaterialOnUv2(
      fullQuad(),
      { baseColor: [1, 0, 0], opacity: 0.5 },
      { width: 8, height: 8 },
    );
    expect(images.albedo.width).toBe(8);
    // Interior texel center (4+0.5)/8 = 0.5625 → inside.
    const idx = (4 * 8 + 4) * 4;
    expect(images.albedo.data[idx]).toBe(255);
    expect(images.albedo.data[idx + 1]).toBe(0);
    expect(images.albedo.data[idx + 2]).toBe(0);
    expect(images.albedo.data[idx + 3]).toBe(128); // 0.5 opacity rounded
    // Emission defaults to black (f16 zeros).
    expect(images.emission.data[idx + 1]).toBe(0);
  });

  it('metallic removes diffuse albedo (albedo × (1−metallic))', () => {
    const images = renderMaterialOnUv2(
      fullQuad(),
      { baseColor: [1, 1, 1], metallic: 1 },
      { width: 4, height: 4 },
    );
    const idx = (2 * 4 + 2) * 4;
    expect(images.albedo.data[idx]).toBe(0);
    expect(images.albedo.data[idx + 3]).toBe(255); // opacity untouched
  });

  it('emission × energy lands in rgbah', () => {
    const images = renderMaterialOnUv2(
      fullQuad(),
      { emission: [2, 4, 0.5], emissionEnergy: 2 },
      { width: 4, height: 4 },
    );
    const idx = (2 * 4 + 2) * 4;
    expect(f16ToF32(images.emission.data[idx])).toBeCloseTo(4, 5);
    expect(f16ToF32(images.emission.data[idx + 1])).toBeCloseTo(8, 4);
    expect(f16ToF32(images.emission.data[idx + 2])).toBeCloseTo(1, 6);
  });

  it('leaves uncovered texels black/transparent (chart padding)', () => {
    // Small triangle in the corner of the chart.
    const mesh = {
      positions: new Float32Array(9),
      uv2: new Float32Array([0, 0, 0.2, 0, 0, 0.2]),
      triangleCount: 1,
    };
    const images = renderMaterialOnUv2(mesh, { baseColor: [1, 1, 1] }, { width: 16, height: 16 });
    const far = (12 * 16 + 12) * 4;
    expect(images.albedo.data[far]).toBe(0);
    expect(images.albedo.data[far + 3]).toBe(0);
    const near = (1 * 16 + 1) * 4;
    expect(images.albedo.data[near + 3]).toBe(255);
  });

  it('samples the base color texture in the same UV space', () => {
    // 2×2 texture: red top-left, green bottom-right.
    const texture = {
      width: 2,
      height: 2,
      data: new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 255, 0, 255,
        255, 0, 0, 255,
      ]),
    };
    const images = renderMaterialOnUv2(fullQuad(), { baseColorTexture: texture }, { width: 8, height: 8 });
    // UV (0.3, 0.3) → texel (0,0) red; (0.7, 0.7) → (1,1) red; (0.3,0.7) → (0,1) green.
    const at = (u: number, v: number): readonly number[] => {
      const x = Math.min(7, Math.floor(u * 8));
      const y = Math.min(7, Math.floor(v * 8));
      const i = (y * 8 + x) * 4;
      return [images.albedo.data[i], images.albedo.data[i + 1], images.albedo.data[i + 2]];
    };
    expect(at(0.31, 0.31)[0]).toBe(255);
    expect(at(0.31, 0.71)[1]).toBe(255);
  });

  it('defaults to white diffuse for missing materials', () => {
    const images = renderMaterialOnUv2(fullQuad(), undefined, { width: 4, height: 4 });
    const idx = (2 * 4 + 2) * 4;
    expect(images.albedo.data[idx]).toBe(255);
    expect(images.albedo.data[idx + 1]).toBe(255);
    expect(images.albedo.data[idx + 3]).toBe(255);
  });
});
