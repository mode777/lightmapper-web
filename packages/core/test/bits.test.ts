import { describe, expect, it } from 'vitest';
import { divisionRoundUp, nearestPowerOf2, nextPowerOf2 } from '../src/math/bits.js';

/**
 * Ports of godot/core/math/math_funcs_binary.h @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0.
 */
describe('power-of-2 helpers', () => {
  it('nextPowerOf2 rounds up (0 -> 0)', () => {
    expect(nextPowerOf2(0)).toBe(0);
    expect(nextPowerOf2(1)).toBe(1);
    expect(nextPowerOf2(2)).toBe(2);
    expect(nextPowerOf2(3)).toBe(4);
    expect(nextPowerOf2(5)).toBe(8);
    expect(nextPowerOf2(70)).toBe(128);
    expect(nextPowerOf2(128)).toBe(128);
  });

  it('nearestPowerOf2 matches the templated variant for ints', () => {
    expect(nearestPowerOf2(0)).toBe(0); // --(-0)|smear|++ wraps to 0, like the C++
    expect(nearestPowerOf2(1)).toBe(1);
    expect(nearestPowerOf2(102)).toBe(128);
  });

  it('divisionRoundUp', () => {
    expect(divisionRoundUp(0, 16)).toBe(0);
    expect(divisionRoundUp(1, 16)).toBe(1);
    expect(divisionRoundUp(16, 16)).toBe(1);
    expect(divisionRoundUp(17, 16)).toBe(2);
  });
});
