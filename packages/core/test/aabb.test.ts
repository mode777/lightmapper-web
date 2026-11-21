import { describe, expect, it } from 'vitest';
import {
  aabbAt,
  aabbExpandTo,
  aabbGetCenter,
  aabbGetEndpoint,
  aabbGetEnd,
  aabbGetLongestAxisIndex,
  aabbGrowBy,
  aabbMergeWith,
  aabbSizeLength,
  distanceSquaredTo,
  type Aabb,
} from '../src/math/aabb.js';

/**
 * Ports of godot/core/math/aabb.{h,cpp} @ 67421f36e5069e62573c44beb8dd2f8f91e065b0.
 * Vectors below were hand-derived from the C++ sources.
 */
describe('AABB ports', () => {
  it('aabbExpandTo grows around the seed point', () => {
    const b = aabbAt([1, 2, 3]);
    aabbExpandTo(b, [4, 2, 3]);
    aabbExpandTo(b, [0, 5, 3]);
    aabbExpandTo(b, [1, 2, 9]);
    expect(b.position).toEqual([0, 2, 3]);
    expect(b.size).toEqual([4, 3, 6]);
  });

  it('aabbExpandTo keeps the box unchanged for interior points', () => {
    const b = aabbAt([0, 0, 0]);
    aabbExpandTo(b, [1, 1, 1]);
    aabbExpandTo(b, [0.5, 0.5, 0.5]);
    expect(b.position).toEqual([0, 0, 0]);
    expect(b.size).toEqual([1, 1, 1]);
  });

  it('aabbGrowBy expands by the amount on every side', () => {
    const b = aabbAt([1, 1, 1]);
    aabbExpandTo(b, [3, 3, 3]); // size (2,2,2)
    aabbGrowBy(b, 0.5);
    expect(b.position).toEqual([0.5, 0.5, 0.5]);
    expect(b.size).toEqual([3, 3, 3]);
  });

  it('aabbGetEndpoint follows Godot bit order (i&1→z, i&2→y, i&4→x)', () => {
    const b = aabbAt([1, 2, 3]);
    aabbExpandTo(b, [5, 7, 9]); // size (4,5,6)
    expect(aabbGetEndpoint(b, 0)).toEqual([1, 2, 3]);
    expect(aabbGetEndpoint(b, 1)).toEqual([1, 2, 9]);
    expect(aabbGetEndpoint(b, 2)).toEqual([1, 7, 3]);
    expect(aabbGetEndpoint(b, 3)).toEqual([1, 7, 9]);
    expect(aabbGetEndpoint(b, 4)).toEqual([5, 2, 3]);
    expect(aabbGetEndpoint(b, 5)).toEqual([5, 2, 9]);
    expect(aabbGetEndpoint(b, 6)).toEqual([5, 7, 3]);
    expect(aabbGetEndpoint(b, 7)).toEqual([5, 7, 9]);
  });

  it('aabbGetLongestAxisIndex: x wins ties; y/z must be strictly longer', () => {
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [1, 1, 1] })).toBe(0);
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [1, 2, 1] })).toBe(1);
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [1, 1, 2] })).toBe(2);
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [1, 2, 3] })).toBe(2);
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [3, 2, 3] })).toBe(0); // z not > x
    expect(aabbGetLongestAxisIndex({ position: [0, 0, 0], size: [1, 3, 3] })).toBe(1); // z not > y
  });

  it('aabbMergeWith unions two boxes', () => {
    const a: Aabb = { position: [0, 0, 0], size: [2, 2, 2] }; // [0,2]^3
    aabbMergeWith(a, { position: [1, 1, 1], size: [4, 1, 1] }); // x[1,5] y[1,2] z[1,2]
    expect(a.position).toEqual([0, 0, 0]);
    expect(a.size).toEqual([5, 2, 2]);
  });

  it('aabbGetEnd / aabbGetCenter', () => {
    const b: Aabb = { position: [1, 2, 3], size: [4, 6, 8] };
    expect(aabbGetEnd(b)).toEqual([5, 8, 11]);
    expect(aabbGetCenter(b)).toEqual([3, 5, 7]);
  });

  it('aabbSizeLength is binary32 sqrt (3,4,0 -> 5)', () => {
    expect(aabbSizeLength({ position: [0, 0, 0], size: [3, 4, 0] })).toBe(5);
    expect(aabbSizeLength({ position: [0, 0, 0], size: [1, 0, 0] })).toBe(1);
  });

  it('distanceSquaredTo matches component-wise f32 math', () => {
    expect(distanceSquaredTo([0, 0, 0], [3, 4, 0])).toBe(25);
    expect(distanceSquaredTo([1, 1, 1], [1, 1, 1])).toBe(0);
  });
});
