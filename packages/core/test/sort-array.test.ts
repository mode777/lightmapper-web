import { describe, expect, it } from 'vitest';
import { sortArray, sortArrayRange } from '../src/accel/sort-array.js';

/**
 * Port of godot/core/templates/sort_array.h @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. Full byte-level fidelity
 * (including equal-key permutation) is verified out-of-band against a
 * C++ extraction of Godot's SortArray across the accel-structure harness;
 * these tests pin the observable contract in-repo.
 */
describe('sortArray (Godot introsort port)', () => {
  it('sorts ascending by the strict-less comparator', () => {
    const arr = [5, 3, 8, 1, 9, 2, 7];
    sortArray(arr, (a, b) => a < b);
    expect(arr).toEqual([1, 2, 3, 5, 7, 8, 9]);
  });

  it('handles empty and single-element arrays', () => {
    const empty: number[] = [];
    sortArray(empty, (a, b) => a < b);
    expect(empty).toEqual([]);
    const one = [42];
    sortArray(one, (a, b) => a < b);
    expect(one).toEqual([42]);
  });

  it('keeps every element (no drops) on adversarial input', () => {
    // LCG-driven pseudo-random array with many duplicates.
    let s = 12345;
    const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    const arr = Array.from({ length: 5000 }, () => next() % 100);
    const sorted = [...arr].sort((a, b) => a - b);
    sortArray(arr, (a, b) => a < b);
    expect(arr).toEqual(sorted);
  });

  it('exercises the introsort threshold path (> 16 elements) and heapsort fallback', () => {
    let s = 999;
    const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (const len of [17, 100, 4096]) {
      const arr = Array.from({ length: len }, (_, i) => next() ^ i);
      const sorted = [...arr].sort((a, b) => a - b);
      sortArray(arr, (a, b) => a < b);
      expect(arr).toEqual(sorted);
    }
  });

  it('sortArrayRange sorts only the window, like C++ pointer+count sorts', () => {
    const arr = [9, 8, 7, 3, 1, 2, 6, 5];
    sortArrayRange(arr, 3, 3, (a, b) => a < b); // sort [3,1,2] -> [1,2,3]
    expect(arr).toEqual([9, 8, 7, 1, 2, 3, 6, 5]);
  });
});
