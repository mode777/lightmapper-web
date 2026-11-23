/**
 * IEEE 754 binary16 conversions — shared by emission uploads (rgbah) and
 * readback decoding.
 *
 * Not a port: Godot keeps half floats opaque (`Image::FORMAT_RGBAH` data);
 * we must cross the JS boundary, so here are the standard bit algorithms
 * (round-to-nearest-even, matching `Image::FORMAT_RGBAH` semantics).
 */

const scratch = new ArrayBuffer(4);
const scratchF32 = new Float32Array(scratch);
const scratchU32 = new Uint32Array(scratch);

/** binary32 → binary16 bits (round-to-nearest-even; narrows via f32 store). */
export function f32ToF16(value: number): number {
  scratchF32[0] = value; // binary32 narrowing, like the GPU upload path
  const f = scratchU32[0];

  const sign = (f >>> 16) & 0x8000;
  let exponent = (f >>> 23) & 0xff;
  let mantissa = f & 0x7fffff;

  if (exponent === 0xff) {
    // Inf / NaN.
    return sign | 0x7c00 | (mantissa !== 0 ? 0x3e0 : 0);
  }

  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) {
    // Overflow → ±Inf.
    return sign | 0x7c00;
  }
  if (exponent <= 0) {
    // Subnormal or zero.
    if (exponent < -10) {
      return sign; // rounds to zero
    }
    mantissa |= 0x800000; // hidden bit
    const shift = 14 - exponent;
    const half = mantissa >>> shift;
    const rest = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    let out = half;
    if (rest > halfway || (rest === halfway && (half & 1) !== 0)) {
      out = half + 1; // can carry into the exponent — that is correct
    }
    return sign | out;
  }

  const half = mantissa >>> 13;
  const rest = mantissa & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1) !== 0)) {
    // Round up. A 10-bit mantissa overflow carries into the exponent.
    const rounded = half + 1;
    if (rounded === 0x400) {
      return sign | ((exponent + 1) << 10);
    }
    return sign | (exponent << 10) | rounded;
  }
  return sign | (exponent << 10) | half;
}

/** binary16 bits → binary32 number. */
export function f16ToF32(half: number): number {
  const sign = (half & 0x8000) >>> 15;
  const exponent = (half & 0x7c00) >>> 10;
  const mantissa = half & 0x03ff;

  if (exponent === 0) {
    if (mantissa === 0) {
      return sign === 1 ? -0 : 0;
    }
    // Subnormal: shift until the hidden bit position is set, adjusting the
    // exponent. value = (man/0x400) × 2^(-14 - shifts).
    let shifts = 0;
    let man = mantissa;
    while ((man & 0x400) === 0) {
      man <<= 1;
      shifts++;
    }
    scratchU32[0] = (sign << 31) | ((127 - 14 - shifts) << 23) | ((man & 0x3ff) << 13);
    return scratchF32[0];
  }
  if (exponent === 0x1f) {
    return mantissa !== 0 ? Number.NaN : sign === 1 ? -Infinity : Infinity;
  }

  scratchU32[0] = (sign << 31) | ((exponent - 15 + 127) << 23) | (mantissa << 13);
  return scratchF32[0];
}
