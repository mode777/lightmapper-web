/**
 * Minimal port of Godot's AABB helpers used by the lightmapper pipeline.
 *
 * Provenance: godot/core/math/aabb.{h,cpp} @ 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Only the operations the lightmapper port needs are provided
 * (docs/PORTING_PLAYBOOK.md §2.3). Godot stores Vector3 components as
 * IEEE-754 binary32 and every C++ vector operator rounds per component,
 * so each arithmetic step below goes through `Math.fround` to keep
 * identical float32 semantics (float32 discipline — playbook §1).
 */

import type { Vec3 } from '../layout/structs.js';

const fr = Math.fround;

/** Godot `AABB`: min-corner `position` plus `size` (may be negative upstream; we never produce that). */
export interface Aabb {
  position: Vec3;
  size: Vec3;
}

/** New AABB at `position` with zero size (Godot's `AABB(p_pos)` / the `AABB()` default is `{0,0,0}`). */
export function aabbAt(position: Vec3): Aabb {
  return { position: [position[0], position[1], position[2]], size: [0, 0, 0] };
}

/** Port of `AABB::expand_to` — grow in-place to contain the point if necessary. */
export function aabbExpandTo(b: Aabb, p: Vec3): void {
  const beginX = b.position[0];
  const beginY = b.position[1];
  const beginZ = b.position[2];
  const endX = fr(beginX + b.size[0]);
  const endY = fr(beginY + b.size[1]);
  const endZ = fr(beginZ + b.size[2]);

  let bx = beginX;
  let by = beginY;
  let bz = beginZ;
  let ex = endX;
  let ey = endY;
  let ez = endZ;

  if (p[0] < bx) bx = p[0];
  if (p[1] < by) by = p[1];
  if (p[2] < bz) bz = p[2];
  if (p[0] > ex) ex = p[0];
  if (p[1] > ey) ey = p[1];
  if (p[2] > ez) ez = p[2];

  b.position = [bx, by, bz];
  b.size = [fr(ex - bx), fr(ey - by), fr(ez - bz)];
}

/** Port of `AABB::merge_with` — union of two boxes (result stored in `a`). */
export function aabbMergeWith(a: Aabb, o: Aabb): void {
  const begX = a.position[0];
  const begY = a.position[1];
  const begZ = a.position[2];
  const endX = fr(a.size[0] + begX);
  const endY = fr(a.size[1] + begY);
  const endZ = fr(a.size[2] + begZ);

  const oBegX = o.position[0];
  const oBegY = o.position[1];
  const oBegZ = o.position[2];
  const oEndX = fr(o.size[0] + oBegX);
  const oEndY = fr(o.size[1] + oBegY);
  const oEndZ = fr(o.size[2] + oBegZ);

  const minX = begX < oBegX ? begX : oBegX;
  const minY = begY < oBegY ? begY : oBegY;
  const minZ = begZ < oBegZ ? begZ : oBegZ;

  const maxX = endX > oEndX ? endX : oEndX;
  const maxY = endY > oEndY ? endY : oEndY;
  const maxZ = endZ > oEndZ ? endZ : oEndZ;

  a.position = [minX, minY, minZ];
  a.size = [fr(maxX - minX), fr(maxY - minY), fr(maxZ - minZ)];
}

/** Port of `AABB::grow_by`. */
export function aabbGrowBy(b: Aabb, amount: number): void {
  b.position = [fr(b.position[0] - amount), fr(b.position[1] - amount), fr(b.position[2] - amount)];
  b.size = [
    fr(b.size[0] + fr(2 * amount)),
    fr(b.size[1] + fr(2 * amount)),
    fr(b.size[2] + fr(2 * amount)),
  ];
}

/** Port of `AABB::get_end` — `position + size`. */
export function aabbGetEnd(b: Aabb): Vec3 {
  return [fr(b.position[0] + b.size[0]), fr(b.position[1] + b.size[1]), fr(b.position[2] + b.size[2])];
}

/** Port of `AABB::get_center` — `position + size * 0.5`. */
export function aabbGetCenter(b: Aabb): Vec3 {
  return [
    fr(b.position[0] + fr(b.size[0] * 0.5)),
    fr(b.position[1] + fr(b.size[1] * 0.5)),
    fr(b.position[2] + fr(b.size[2] * 0.5)),
  ];
}

/**
 * Port of `AABB::get_endpoint` — the 8 corners, bit order `(i & 1) → z`,
 * `(i & 2) → y`, `(i & 4) → x`.
 */
export function aabbGetEndpoint(b: Aabb, i: number): Vec3 {
  const x = (i & 4) !== 0 ? fr(b.position[0] + b.size[0]) : b.position[0];
  const y = (i & 2) !== 0 ? fr(b.position[1] + b.size[1]) : b.position[1];
  const z = (i & 1) !== 0 ? fr(b.position[2] + b.size[2]) : b.position[2];
  return [x, y, z];
}

/** Port of `AABB::get_longest_axis_index` — x wins ties, y/z must be strictly longer. */
export function aabbGetLongestAxisIndex(b: Aabb): number {
  let axis = 0;
  let maxSize = b.size[0];

  if (b.size[1] > maxSize) {
    axis = 1;
    maxSize = b.size[1];
  }

  if (b.size[2] > maxSize) {
    axis = 2;
  }

  return axis;
}

/** Port of `Vector3::length()` on `aabb.size` — `sqrt(x² + y² + z²)` in binary32. */
export function aabbSizeLength(b: Aabb): number {
  const xx = fr(b.size[0] * b.size[0]);
  const yy = fr(b.size[1] * b.size[1]);
  const zz = fr(b.size[2] * b.size[2]);
  return fr(Math.sqrt(fr(fr(xx + yy) + zz)));
}

/** Squared distance between two points with binary32 arithmetic (`Vector3::distance_squared_to`). */
export function distanceSquaredTo(a: Vec3, b: Vec3): number {
  const dx = fr(a[0] - b[0]);
  const dy = fr(a[1] - b[1]);
  const dz = fr(a[2] - b[2]);
  return fr(fr(fr(dx * dx) + fr(dy * dy)) + fr(dz * dz));
}
