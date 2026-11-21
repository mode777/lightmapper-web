/**
 * Bit-exact TypeScript port of Godot's hashing primitives.
 *
 * Provenance: godot/core/templates/hashfuncs.{h,cpp} @ 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * The lightmapper's CPU-side vertex deduplication and seam detection hash
 * *floats by their bit patterns*. Any drift from Godot's exact arithmetic
 * changes which vertices merge and which seams blend, so this module is
 * deliberately pedantic:
 *
 *  - all arithmetic is uint32 (`>>> 0`, `Math.imul`), never float;
 *  - all float inputs are narrowed to IEEE-754 binary32 before hashing;
 *  - `-0` is normalized to `+0` and NaN to the canonical quiet NaN
 *    (mirroring `hash_murmur3_one_float` in hashfuncs.cpp).
 *
 * Reference vectors live in `test/hash.test.ts` and were generated
 * independently from the C++ source (see docs/PORTING_PLAYBOOK.md).
 */

/** Godot's `HASH_MURMUR3_SEED` (core/templates/hashfuncs.h). */
export const MURMUR3_DEFAULT_SEED = 0x07f07c65;

/** MurmurHash3 32-bit finalization step (`hash_murmur3_one_32`). */
export function murmur3One32(input: number, seed: number = MURMUR3_DEFAULT_SEED): number {
  let k = Math.imul(input, 0xcc9e2d51) >>> 0;
  k = ((k << 15) | (k >>> 17)) >>> 0;
  k = Math.imul(k, 0x1b873593) >>> 0;

  let h = (seed ^ k) >>> 0;
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  return h;
}

// Shared buffer used to bitcast JS numbers to IEEE-754 binary32.
const f32View = new Float32Array(1);
const u32View = new Uint32Array(f32View.buffer);

/** Godot's canonical quiet-NaN bit pattern (std::numeric_limits<float>::quiet_NaN()). */
const CANONICAL_NAN_BITS = 0x7fc00000;

/** `hash_murmur3_one_float`: murmur3 over the binary32 bit pattern of `value`. */
export function murmur3OneFloat(value: number, seed: number = MURMUR3_DEFAULT_SEED): number {
  f32View[0] = value; // double -> float narrowing happens here
  let bits = u32View[0];

  if (value === 0) {
    // Covers both +0 and -0 (in JS, -0 === 0 is true).
    bits = 0;
  } else if (Number.isNaN(value)) {
    bits = CANONICAL_NAN_BITS;
  }

  return murmur3One32(bits, seed);
}

/** `hash_fmix32`. */
export function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** Logical GPU vertex as consumed by the lightmapper (see docs/DESIGN.md §4.1). */
export interface HashableVertex {
  /** World-space position, binary32. */
  position: [number, number, number];
  /** Atlas-space UV2, binary32. */
  uv: [number, number];
  /** Smooth normal, split the way Godot packs it into the GPU vertex. */
  normalXY: [number, number];
  normalZ: number;
}

/**
 * Port of `LightmapperRD::VertexHash` (modules/lightmapper_rd/lightmapper_rd.h):
 * murmur3 chain over [px, py, pz, uv.x, uv.y, nxy.x, nxy.y, nz], then `fmix32`.
 */
export function vertexHash(v: HashableVertex, seed: number = MURMUR3_DEFAULT_SEED): number {
  let h = seed;
  h = murmur3OneFloat(v.position[0], h);
  h = murmur3OneFloat(v.position[1], h);
  h = murmur3OneFloat(v.position[2], h);
  h = murmur3OneFloat(v.uv[0], h);
  h = murmur3OneFloat(v.uv[1], h);
  h = murmur3OneFloat(v.normalXY[0], h);
  h = murmur3OneFloat(v.normalXY[1], h);
  h = murmur3OneFloat(v.normalZ, h);
  return fmix32(h);
}

/**
 * Port of `LightmapperRD::EdgeHash`: murmur3 chain over
 * [a.x, a.y, a.z, b.x, b.y, b.z] — no final fmix32.
 */
export function edgeHash(
  a: [number, number, number],
  b: [number, number, number],
  seed: number = MURMUR3_DEFAULT_SEED,
): number {
  let h = seed;
  h = murmur3OneFloat(a[0], h);
  h = murmur3OneFloat(a[1], h);
  h = murmur3OneFloat(a[2], h);
  h = murmur3OneFloat(b[0], h);
  h = murmur3OneFloat(b[1], h);
  h = murmur3OneFloat(b[2], h);
  return h;
}
