import { describe, expect, it } from 'vitest';
import { partialPackRects } from '../src/atlas/stb-rect-pack.js';
import { atlasPadding, blitMeshesIntoAtlas } from '../src/atlas/pack.js';

/**
 * Ports of Geometry2D::partial_pack_rects (stb_rect_pack v1.01 skyline
 * bottom-left) and LightmapperRD::_blit_meshes_into_atlas @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. Expected layouts were
 * hand-derived by stepping through the skyline algorithm.
 */
describe('partialPackRects (stb_rect_pack skyline BL)', () => {
  it('packs four equal quads into the four quadrants', () => {
    const result = partialPackRects(
      [
        [2, 2],
        [2, 2],
        [2, 2],
        [2, 2],
      ],
      4,
      4,
    );
    expect(result).toEqual([
      [0, 0, 1],
      [2, 0, 1],
      [0, 2, 1],
      [2, 2, 1],
    ]);
  });

  it('sorts by height descending before packing', () => {
    // Tall rect goes bottom-left first, wide rect stacks above it.
    const result = partialPackRects(
      [
        [4, 1],
        [1, 3],
      ],
      4,
      4,
    );
    expect(result[0]).toEqual([0, 3, 1]); // wide, packed after tall
    expect(result[1]).toEqual([0, 0, 1]); // tall, first position
  });

  it('reports overflow rects with MAXVAL sentinel coordinates', () => {
    const result = partialPackRects(
      [
        [2, 2],
        [2, 2],
        [2, 2],
      ],
      4,
      2,
    );
    expect(result[0]).toEqual([0, 0, 1]);
    expect(result[1]).toEqual([2, 0, 1]);
    expect(result[2]).toEqual([0x7fffffff, 0x7fffffff, 0]);
  });

  it('empty rects (w=0 or h=0) are trivially packed at origin', () => {
    expect(partialPackRects([[0, 5]], 4, 4)[0]).toEqual([0, 0, 1]);
    expect(partialPackRects([[5, 0]], 4, 4)[0]).toEqual([0, 0, 1]);
  });

  it('rects wider or taller than the atlas never pack', () => {
    expect(partialPackRects([[5, 2]], 4, 4)[0][2]).toBe(0);
    expect(partialPackRects([[2, 5]], 4, 4)[0][2]).toBe(0);
  });

  it('is deterministic across calls', () => {
    const sizes = Array.from({ length: 8 }, (_, i) => [3 + i, 9 - i] as [number, number]);
    const a = partialPackRects(sizes, 16, 16);
    const b = partialPackRects(sizes, 16, 16);
    expect(a).toEqual(b);
  });
});

describe('atlasPadding', () => {
  it('padding = max(2, denoiserRange) * int(supersamplingFactor)', () => {
    expect(atlasPadding(0, 1)).toBe(2);
    expect(atlasPadding(8, 1)).toBe(8);
    expect(atlasPadding(8, 2)).toBe(16);
  });

  it('GODOT-QUIRK: fractional supersampling truncates to int (1.5x pads like 1x)', () => {
    expect(atlasPadding(8, 1.5)).toBe(8);
    expect(atlasPadding(8, 2.9)).toBe(16);
  });
});

describe('blitMeshesIntoAtlas', () => {
  const options = {
    maxTextureSize: 4096,
    deviceMaxTextureSize: 8192,
    denoiserRange: 8,
    supersamplingFactor: 1,
  };

  it('single mesh: minimum pow2 atlas, one slice, +1 centering offset', () => {
    const result = blitMeshesIntoAtlas([{ width: 62, height: 62 }], options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // padded 70 -> nearest pow2 = 128
    expect(result.atlasSize).toEqual([128, 128]);
    expect(result.atlasSlices).toBe(1);
    expect(result.slots).toEqual([{ slice: 0, offset: [1, 1] }]);
    expect(result.paddedSizes).toEqual([[70, 70]]);
  });

  it('two large meshes: memory tie keeps the first (squarest) layout', () => {
    // Two 102x102 padded rects: 128x128 needs 2 slices (mem 32768);
    // 256x128 needs 1 slice (mem 32768). Godot's strict `<` keeps the
    // first candidate, so the 2-slice 128x128 atlas wins.
    const result = blitMeshesIntoAtlas(
      [
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ],
      { ...options, denoiserRange: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atlasSize).toEqual([128, 128]);
    expect(result.atlasSlices).toBe(2);
    expect(result.slots[0]).toEqual({ slice: 0, offset: [1, 1] });
    expect(result.slots[1]).toEqual({ slice: 1, offset: [1, 1] });
  });

  it('packs mixed-size meshes onto one slice with disjoint offsets', () => {
    // 62x62 (padded 70) and 8x8 (padded 16) on a 128x128 slice: the small
    // mesh lands next to the big one (x = 70), each +1 centered.
    const result = blitMeshesIntoAtlas(
      [
        { width: 62, height: 62 },
        { width: 8, height: 8 },
      ],
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atlasSize).toEqual([128, 128]);
    expect(result.atlasSlices).toBe(1);
    expect(result.slots[0]).toEqual({ slice: 0, offset: [1, 1] });
    expect(result.slots[1]).toEqual({ slice: 0, offset: [71, 1] });
  });

  it('equal-size meshes keep the minimal square atlas across memory ties', () => {
    // Four 33x33 meshes (padded 41): 64x64 holds one per slice (mem
    // 16384); 128x64 and 128x128 both also total 16384 — Godot's strict
    // `<` keeps the FIRST candidate: 64x64 with 4 slices.
    const result = blitMeshesIntoAtlas(
      Array.from({ length: 4 }, () => ({ width: 33, height: 33 })),
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atlasSize).toEqual([64, 64]);
    expect(result.atlasSlices).toBe(4);
    for (const slot of result.slots) {
      expect(slot.slice).toBeLessThan(4);
      expect(slot.offset).toEqual([1, 1]); // first rect on every slice
    }
  });

  it('errors when the padded mesh exceeds the max texture size', () => {
    const result = blitMeshesIntoAtlas(
      [{ width: 62, height: 62 }],
      { ...options, maxTextureSize: 64 }, // padded 70 -> needs 128 > 64
    );
    expect(result).toEqual({ ok: false, error: 'textureExceedsMaxSize' });
  });

  it('distinguishes the device-limit error', () => {
    const result = blitMeshesIntoAtlas(
      [{ width: 62, height: 62 }],
      { ...options, maxTextureSize: 64, deviceMaxTextureSize: 64 },
    );
    expect(result).toEqual({ ok: false, error: 'textureExceedsDeviceLimit' });
  });

  it('supersampling scales the atlas size limit (int-truncated)', () => {
    // maxTextureSize 256 at 2x -> limit 512: a mesh needing a 128x128
    // atlas at pad*2 still fits.
    const result = blitMeshesIntoAtlas(
      [{ width: 62, height: 62 }],
      { ...options, maxTextureSize: 256, supersamplingFactor: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // padded 62 + 16 = 78 -> 128; limit = min(int(256*2), 8192) = 512
    expect(result.atlasSize).toEqual([128, 128]);
    expect(result.paddedSizes).toEqual([[78, 78]]);
  });

  it('supersampling 0.5 halves the limit and kills the padding (int(0.5) = 0)', () => {
    // GODOT-QUIRK: int(0.5) truncates to 0, so padding vanishes entirely;
    // the limit is int(max * 0.5) = 128, which still fits the 100x100 mesh.
    const result = blitMeshesIntoAtlas(
      [{ width: 100, height: 100 }],
      { ...options, maxTextureSize: 256, supersamplingFactor: 0.5 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paddedSizes).toEqual([[100, 100]]);
    expect(result.atlasSize).toEqual([128, 128]);
    expect(result.atlasSlices).toBe(1);

    // A 200x200 mesh at 0.5x no longer fits the halved limit
    // (needs 256 > int(256 * 0.5) = 128).
    const tooBig = blitMeshesIntoAtlas(
      [{ width: 200, height: 200 }],
      { ...options, maxTextureSize: 256, supersamplingFactor: 0.5 },
    );
    expect(tooBig).toEqual({ ok: false, error: 'textureExceedsMaxSize' });
  });
});
