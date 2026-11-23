import { describe, expect, it } from 'vitest';
import { blitAtlasSlices, type MeshAtlasImages } from '../src/atlas/blit.js';

function image(w: number, h: number, fill: number, alpha = 255): MeshAtlasImages {
  const albedo = new Uint8Array(w * h * 4);
  const emission = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    albedo[i * 4] = fill;
    albedo[i * 4 + 3] = alpha;
    emission[i * 4 + 1] = fill; // f16 exponent bits for small fills
  }
  return { albedo: { width: w, height: h, data: albedo }, emission: { width: w, height: h, data: emission } };
}

describe('blitAtlasSlices (_blit_meshes_into_atlas tail)', () => {
  it('creates black slices and blits each mesh at its slot offset', () => {
    const slices = blitAtlasSlices(
      [image(2, 2, 7)],
      [{ slice: 1, offset: [1, 2] }],
      [4, 4],
      2,
    );
    expect(slices.albedo).toHaveLength(2);
    expect(slices.emission).toHaveLength(2);
    // Slice 0 untouched (black, transparent).
    expect(slices.albedo[0].every((b) => b === 0)).toBe(true);
    // Mesh texel (0,0) lands at atlas (1,2).
    const idx = (2 * 4 + 1) * 4;
    expect(slices.albedo[1][idx]).toBe(7);
    expect(slices.albedo[1][idx + 3]).toBe(255);
    expect(slices.emission[1][idx + 1]).toBe(7);
    // The texel left of it stays black (padding).
    expect(slices.albedo[1][idx - 4]).toBe(0);
  });

  it('copies full rows (row stride = atlas width)', () => {
    const slices = blitAtlasSlices(
      [image(3, 2, 9)],
      [{ slice: 0, offset: [1, 1] }],
      [8, 8],
      1,
    );
    // Mesh row 1 (y=1) maps to atlas row 2; all 3 texels present.
    for (let x = 0; x < 3; x++) {
      const idx = (2 * 8 + 1 + x) * 4;
      expect(slices.albedo[0][idx]).toBe(9);
    }
    // Texel after the copy in the same atlas row is black.
    expect(slices.albedo[0][(2 * 8 + 4) * 4]).toBe(0);
  });

  it('rejects dimension mismatches and out-of-atlas blits', () => {
    const a = image(2, 2, 1);
    const bad = {
      albedo: a.albedo,
      emission: { width: 3, height: 2, data: new Uint16Array(3 * 2 * 4) },
    };
    expect(() => blitAtlasSlices([bad], [{ slice: 0, offset: [0, 0] }], [4, 4], 1)).toThrow(/dimension/);
    expect(() => blitAtlasSlices([image(4, 4, 1)], [{ slice: 0, offset: [1, 1] }], [4, 4], 1)).toThrow(/exceeds atlas/);
    expect(() =>
      blitAtlasSlices([image(2, 2, 1)], [{ slice: 0, offset: [0, 0] }], [4, 4], 2),
    ).not.toThrow();
  });
});
