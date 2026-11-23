import { describe, expect, it } from 'vitest';
import { f16ToF32, f32ToF16 } from '../src/math/float16.js';

/** IEEE 754 reference vectors (hex half ↔ decimal). */
const VECTORS: Array<[number, number]> = [
  [0x0000, 0.0],
  [0x8000, -0.0],
  [0x3c00, 1.0],
  [0x4000, 2.0],
  [0xc000, -2.0],
  [0x3800, 0.5],
  [0x3555, 0.333251953125], // round-to-nearest-even of 1/3
  [0x2e66, 0.0999755859375], // 0.1 in half precision
  [0x7bff, 65504.0], // largest finite
  [0x0400, 6.103515625e-5], // smallest normal
  [0x0001, 5.960464477539063e-8], // smallest subnormal
  [0x03ff, 6.097555160522461e-5], // largest subnormal
  [0x7c00, Infinity],
  [0xfc00, -Infinity],
];

describe('f16ToF32', () => {
  it('decodes reference vectors', () => {
    for (const [bits, value] of VECTORS) {
      expect(f16ToF32(bits)).toBe(value);
    }
  });

  it('decodes NaN', () => {
    expect(Number.isNaN(f16ToF32(0x7e00))).toBe(true);
  });
});

describe('f32ToF16', () => {
  it('encodes reference vectors (round-to-nearest-even)', () => {
    for (const [bits, value] of VECTORS) {
      expect(f32ToF16(value)).toBe(bits);
    }
  });

  it('encodes NaN as a NaN half', () => {
    expect(f32ToF16(Number.NaN) & 0x7c00).toBe(0x7c00);
    expect(f32ToF16(Number.NaN) & 0x03ff).not.toBe(0);
  });

  it('overflows to infinity', () => {
    expect(f32ToF16(65520)).toBe(0x7c00); // first value that rounds up past 65504
    expect(f32ToF16(1e10)).toBe(0x7c00);
    expect(f32ToF16(-1e10)).toBe(0xfc00);
  });

  it('underflows to zero', () => {
    expect(f32ToF16(2.9802322e-8)).toBe(0x0000); // < half of the min subnormal
    expect(f32ToF16(-2.9802322e-8)).toBe(0x8000);
  });

  it('is the identity over every representable half (roundtrip)', () => {
    // All finite non-NaN halves decode to f32s that encode back exactly.
    let count = 0;
    for (let h = 0; h <= 0x7bff; h++) {
      const decoded = f16ToF32(h);
      if (decoded === 0) continue; // -0 handled below
      expect(f32ToF16(decoded)).toBe(h);
      count++;
    }
    expect(f32ToF16(f16ToF32(0x8000))).toBe(0x8000);
    expect(count).toBeGreaterThan(30000);
  });

  it('rounds ties to even', () => {
    // Midpoint between 1.0 (0x3c00) and the next half up (0x3c01) is
    // 1.0 + 2^-11 (half ULP at 1.0 is 2^-10) → ties to the even mantissa.
    expect(f32ToF16(1.0 + 2 ** -11)).toBe(0x3c00);
    // One f32-epsilon above the midpoint rounds up.
    expect(f32ToF16(1.0 + 2 ** -11 + 2 ** -22)).toBe(0x3c01);
    // Tie at the odd side rounds up: midpoint between 0x3c01 and 0x3c02.
    expect(f32ToF16(1.0 + 3 * 2 ** -11)).toBe(0x3c02);
  });
});
