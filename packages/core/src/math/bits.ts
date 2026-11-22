/**
 * Small integer helpers ported from Godot's math core.
 *
 * Provenance: godot/core/math/math_funcs_binary.h
 * (`next_power_of_2`, `nearest_power_of_2_templated`) @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 */

/** Port of `Math::next_power_of_2` (uint32): 0 -> 0, else round up to the next power of two. */
export function nextPowerOf2(n: number): number {
  n = n >>> 0;
  if (n === 0) {
    return 0;
  }
  n--;
  n |= n >>> 1;
  n |= n >>> 2;
  n |= n >>> 4;
  n |= n >>> 8;
  n |= n >>> 16;
  return n + 1;
}

/**
 * Port of `Math::nearest_power_of_2_templated<int32_t>`: the classic
 * bit-smearing round-up (same results as `nextPowerOf2` for our inputs).
 */
export function nearestPowerOf2(n: number): number {
  n |= 0;
  n--;
  n |= n >>> 1;
  n |= n >>> 2;
  n |= n >>> 4;
  n |= n >>> 8;
  n |= n >>> 16;
  return n + 1;
}

/** Port of `Math::division_round_up(m, n)`. */
export function divisionRoundUp(m: number, n: number): number {
  return ((m + n - 1) / n) | 0;
}
