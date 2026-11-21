import { describe, expect, it } from 'vitest';
import { triangleBoxOverlap } from '../src/math/geometry3d.js';
import type { Vec3 } from '../src/layout/structs.js';

/**
 * Port of godot/core/math/geometry_3d.h `triangle_box_overlap` @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0 — the exact SAT variant (Akenine-
 * Möller macros) whose boundary semantics the grid plotting and probe octree
 * depend on. Cases hand-derived from the macro expansion.
 */
describe('triangleBoxOverlap', () => {
  const box = (cx: number, cy: number, cz: number, h = 1): [Vec3, Vec3] => [
    [cx, cy, cz],
    [h, h, h],
  ];

  it('accepts a triangle fully inside the box', () => {
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 1],
        [1.5, 0.5, 1],
        [0.5, 1.5, 1],
      ]),
    ).toBe(true);
  });

  it('rejects a triangle completely outside the box', () => {
    const [c, h] = box(10, 10, 10);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 1],
        [1.5, 0.5, 1],
        [0.5, 1.5, 1],
      ]),
    ).toBe(false);
  });

  it('rejects a triangle separated along z (minmax test)', () => {
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 5],
        [1.5, 0.5, 5],
        [0.5, 1.5, 5],
      ]),
    ).toBe(false);
  });

  it('accepts a large triangle cutting through the box', () => {
    // Horizontal triangle in the plane y = 1 (through the box middle);
    // hand-verified to pass all 9 axis tests and the plane test.
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [5, 1, -5],
        [-5, 1, -5],
        [0, 1, 5],
      ]),
    ).toBe(true);
  });

  it('rejects a large triangle whose plane misses the box', () => {
    // Plane y + 2z = 7; the box corner max is 2 + 2*2 = 6 < 7. Caught by
    // the cross(edge, axis) test (AXISTEST_X01 on e1) before the plane test.
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [10, 10, 0],
        [-10, 10, 0],
        [0, -10, 10],
      ]),
    ).toBe(false);
  });

  it('accepts a triangle touching a box face exactly (planeBoxOverlap >= 0 boundary)', () => {
    // Triangle lies exactly in the plane z = 2 — the top face of the box
    // [0,2]^3 centered at (1,1,1). planeBoxOverlap accepts when
    // dot(vmax) + d >= 0, and exact touching satisfies it: Godot returns
    // TRUE here. This boundary semantics feeds the accel grid / probe
    // octree, so it must be preserved.
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 2],
        [1.5, 0.5, 2],
        [0.5, 1.5, 2],
      ]),
    ).toBe(true);
  });

  it('rejects a coplanar triangle clearly outside the box plane', () => {
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 2.5],
        [1.5, 0.5, 2.5],
        [0.5, 1.5, 2.5],
      ]),
    ).toBe(false);
  });

  it('accepts the same triangle moved slightly inside', () => {
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [0.5, 0.5, 1.9],
        [1.5, 0.5, 1.9],
        [0.5, 1.5, 1.9],
      ]),
    ).toBe(true);
  });

  it('rejects a triangle separated along x (FINDMINMAX direction test)', () => {
    // Triangle AABB starts at x = 3 > box half-extent 1: rejected by the
    // minimal-AABB test (bullet 1) before any cross-product test runs.
    const [c, h] = box(1, 1, 1);
    expect(
      triangleBoxOverlap(c, h, [
        [3, 0, 3],
        [3, 2, 3],
        [5, 1, 3],
      ]),
    ).toBe(false);
  });

  it('degenerate (zero-area) triangle inside the box returns true — GODOT-QUIRK', () => {
    // All edges zero: every axis test trivially passes and the normal is
    // (0,0,0), so planeBoxOverlap sees the zero plane and returns true
    // while the point is inside the box. Godot behaves identically.
    const [c, h] = box(1, 1, 1);
    const p: [number, number, number] = [1, 1, 1];
    expect(triangleBoxOverlap(c, h, [p, p, p])).toBe(true);
  });

  it('degenerate (zero-area) triangle outside the box returns false', () => {
    const [c, h] = box(1, 1, 1);
    const p: [number, number, number] = [5, 5, 5];
    expect(triangleBoxOverlap(c, h, [p, p, p])).toBe(false);
  });
});
