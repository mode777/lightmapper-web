import { describe, expect, it } from 'vitest';
import {
  edgeHash,
  fmix32,
  murmur3One32,
  murmur3OneFloat,
  vertexHash,
} from '../src/math/hash.js';

/**
 * Reference vectors generated independently from the C++ source
 * (godot/core/templates/hashfuncs.{h,cpp}) — see docs/PORTING_PLAYBOOK.md.
 * They pin the port bit-exactly; do not update them to "fix" failures —
 * a failure means the implementation drifted from Godot.
 */
describe('murmur3One32', () => {
  it('matches Godot reference vectors', () => {
    expect(murmur3One32(0)).toBe(873697370);
    expect(murmur3One32(1)).toBe(1446504008);
    expect(murmur3One32(0xdeadbeef)).toBe(1467545638);
  });

  it('chains deterministically', () => {
    const a = murmur3One32(murmur3One32(1), murmur3One32(2));
    expect(a).toBe(murmur3One32(murmur3One32(1), murmur3One32(2)));
    expect(a).not.toBe(murmur3One32(murmur3One32(2), murmur3One32(1)));
  });
});

describe('murmur3OneFloat', () => {
  it('matches Godot reference vectors', () => {
    expect(murmur3OneFloat(1.0)).toBe(1347139349);
    expect(murmur3OneFloat(-1.5, 12345)).toBe(4128512032);
  });

  it('narrows doubles to binary32 like a C++ float parameter', () => {
    // 0.1 in JS (f64) is not representable in f32; the f32 rounding must
    // participate in the hash exactly as it would in Godot.
    const once = murmur3OneFloat(0.1);
    expect(once).toBe(murmur3OneFloat(Math.fround(0.1)));
    expect(once).not.toBe(murmur3One32(0x3dcccccd, 0x07f07c65) === once ? -1 : once); // sanity: defined
  });

  it('normalizes -0 and NaN the way Godot does', () => {
    expect(murmur3OneFloat(-0)).toBe(murmur3OneFloat(0)); // both -> +0 bits
    expect(murmur3OneFloat(Number.NaN)).toBe(murmur3OneFloat(Number.NaN)); // canonical NaN
    expect(murmur3OneFloat(-0)).toBe(873697370); // same as hashing u32 0
  });
});

describe('fmix32', () => {
  it('matches Godot reference vectors', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(0x12345678)).toBe(3816608188);
  });
});

describe('LightmapperRD hash ports', () => {
  it('VertexHash matches reference vectors', () => {
    expect(
      vertexHash({
        position: [1, 2, 3],
        uv: [0.5, 0.25],
        normalXY: [0, 0],
        normalZ: 1,
      }),
    ).toBe(2329546626);

    expect(
      vertexHash({
        position: [0, 0, 0],
        uv: [0, 0],
        normalXY: [0, 0],
        normalZ: 0,
      }),
    ).toBe(127460286);

    expect(
      vertexHash({
        position: [-1.5, 2.25, -3.75],
        uv: [0.125, 0.875],
        normalXY: [0.1, -0.2],
        normalZ: 0.9,
      }),
    ).toBe(1567245180);
  });

  it('EdgeHash matches reference vectors (no fmix32)', () => {
    expect(edgeHash([0, 0, 0], [1, 1, 1])).toBe(1326815704);
    expect(edgeHash([-1.5, 2.25, -3.75], [0.125, 0.875, 0.1])).toBe(2126695110);
  });
});
