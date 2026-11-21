/**
 * Port of `Geometry3D::triangle_box_overlap` (separating axis theorem).
 *
 * Provenance: godot/core/math/geometry_3d.h (triangle_box_overlap,
 * planeBoxOverlap, FINDMINMAX / AXISTEST_* macros) @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * This is the exact SAT variant Godot uses (based on Akenine-Möller);
 * both the lightmapper's acceleration grid plotting and the probe
 * octree rely on its exact boundary semantics:
 *
 *  - axis tests reject when `min > rad || max < -rad` (touching passes);
 *  - `planeBoxOverlap` accepts only when `dot(vmax) + d >= 0` — a
 *    triangle coplanar with a box face from the *outside* returns false;
 *  - a fully degenerate (zero-area) triangle overlapping the box
 *    degenerates to a point-in-box test and can return true.
 *
 * All arithmetic is per-op binary32 (`Math.fround`) to match Godot's
 * float32 Vector3 operators (float32 discipline — playbook §1).
 */

import type { Vec3 } from '../layout/structs.js';

const fr = Math.fround;

/** Port of `planeBoxOverlap(p_normal, p_d, p_maxbox)`. */
function planeBoxOverlap(normal: Vec3, d: number, maxbox: Vec3): boolean {
  const vmin: Vec3 = [0, 0, 0];
  const vmax: Vec3 = [0, 0, 0];
  for (let q = 0; q <= 2; q++) {
    if (normal[q] > 0) {
      vmin[q] = -maxbox[q];
      vmax[q] = maxbox[q];
    } else {
      vmin[q] = maxbox[q];
      vmax[q] = -maxbox[q];
    }
  }
  const dotVmin = fr(fr(fr(normal[0] * vmin[0]) + fr(normal[1] * vmin[1])) + fr(normal[2] * vmin[2]));
  if (fr(dotVmin + d) > 0) {
    return false;
  }
  const dotVmax = fr(fr(fr(normal[0] * vmax[0]) + fr(normal[1] * vmax[1])) + fr(normal[2] * vmax[2]));
  if (fr(dotVmax + d) >= 0) {
    return true;
  }

  return false;
}

/**
 * Port of `Geometry3D::triangle_box_overlap(p_box_center, p_box_half_size, p_triverts)`.
 * `triVerts` are the three triangle vertices.
 */
export function triangleBoxOverlap(boxCenter: Vec3, boxHalfSize: Vec3, triVerts: readonly [Vec3, Vec3, Vec3]): boolean {
  /* use separating axis theorem to test overlap between triangle and box */
  /* need to test for overlap in these directions: */
  /* 1) the {x,y,z}-directions (actually, since we use the AABB of the triangle */
  /*    we do not even need to test these) */
  /* 2) normal of the triangle */
  /* 3) crossproduct(edge from tri, {x,y,z}-directin) */
  /*    this gives 3x3=9 more tests */
  let min = 0;
  let max = 0;
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let rad = 0;

  /* move everything so that the boxcenter is in (0,0,0) */
  const v0: Vec3 = [fr(triVerts[0][0] - boxCenter[0]), fr(triVerts[0][1] - boxCenter[1]), fr(triVerts[0][2] - boxCenter[2])];
  const v1: Vec3 = [fr(triVerts[1][0] - boxCenter[0]), fr(triVerts[1][1] - boxCenter[1]), fr(triVerts[1][2] - boxCenter[2])];
  const v2: Vec3 = [fr(triVerts[2][0] - boxCenter[0]), fr(triVerts[2][1] - boxCenter[1]), fr(triVerts[2][2] - boxCenter[2])];

  /* compute triangle edges */
  const e0: Vec3 = [fr(v1[0] - v0[0]), fr(v1[1] - v0[1]), fr(v1[2] - v0[2])]; /* tri edge 0 */
  const e1: Vec3 = [fr(v2[0] - v1[0]), fr(v2[1] - v1[1]), fr(v2[2] - v1[2])]; /* tri edge 1 */
  const e2: Vec3 = [fr(v0[0] - v2[0]), fr(v0[1] - v2[1]), fr(v0[2] - v2[2])]; /* tri edge 2 */

  /* Bullet 3: */
  /*  test the 9 tests first (this was faster) */
  {
    const fex = Math.abs(e0[0]);
    const fey = Math.abs(e0[1]);
    const fez = Math.abs(e0[2]);
    // AXISTEST_X01(e0.z, e0.y, fez, fey)
    p0 = fr(fr(e0[2] * v0[1]) - fr(e0[1] * v0[2]));
    p2 = fr(fr(e0[2] * v2[1]) - fr(e0[1] * v2[2]));
    if (p0 < p2) {
      min = p0;
      max = p2;
    } else {
      min = p2;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[1]) + fr(fey * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Y02(e0.z, e0.x, fez, fex)
    p0 = fr(fr(-e0[2] * v0[0]) + fr(e0[0] * v0[2]));
    p2 = fr(fr(-e0[2] * v2[0]) + fr(e0[0] * v2[2]));
    if (p0 < p2) {
      min = p0;
      max = p2;
    } else {
      min = p2;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[0]) + fr(fex * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Z12(e0.y, e0.x, fey, fex)
    p1 = fr(fr(e0[1] * v1[0]) - fr(e0[0] * v1[1]));
    p2 = fr(fr(e0[1] * v2[0]) - fr(e0[0] * v2[1]));
    if (p2 < p1) {
      min = p2;
      max = p1;
    } else {
      min = p1;
      max = p2;
    }
    rad = fr(fr(fey * boxHalfSize[0]) + fr(fex * boxHalfSize[1]));
    if (min > rad || max < -rad) {
      return false;
    }
  }

  {
    const fex = Math.abs(e1[0]);
    const fey = Math.abs(e1[1]);
    const fez = Math.abs(e1[2]);
    // AXISTEST_X01(e1.z, e1.y, fez, fey)
    p0 = fr(fr(e1[2] * v0[1]) - fr(e1[1] * v0[2]));
    p2 = fr(fr(e1[2] * v2[1]) - fr(e1[1] * v2[2]));
    if (p0 < p2) {
      min = p0;
      max = p2;
    } else {
      min = p2;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[1]) + fr(fey * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Y02(e1.z, e1.x, fez, fex)
    p0 = fr(fr(-e1[2] * v0[0]) + fr(e1[0] * v0[2]));
    p2 = fr(fr(-e1[2] * v2[0]) + fr(e1[0] * v2[2]));
    if (p0 < p2) {
      min = p0;
      max = p2;
    } else {
      min = p2;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[0]) + fr(fex * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Z0(e1.y, e1.x, fey, fex)
    p0 = fr(fr(e1[1] * v0[0]) - fr(e1[0] * v0[1]));
    p1 = fr(fr(e1[1] * v1[0]) - fr(e1[0] * v1[1]));
    if (p0 < p1) {
      min = p0;
      max = p1;
    } else {
      min = p1;
      max = p0;
    }
    rad = fr(fr(fey * boxHalfSize[0]) + fr(fex * boxHalfSize[1]));
    if (min > rad || max < -rad) {
      return false;
    }
  }

  {
    const fex = Math.abs(e2[0]);
    const fey = Math.abs(e2[1]);
    const fez = Math.abs(e2[2]);
    // AXISTEST_X2(e2.z, e2.y, fez, fey)
    p0 = fr(fr(e2[2] * v0[1]) - fr(e2[1] * v0[2]));
    p1 = fr(fr(e2[2] * v1[1]) - fr(e2[1] * v1[2]));
    if (p0 < p1) {
      min = p0;
      max = p1;
    } else {
      min = p1;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[1]) + fr(fey * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Y1(e2.z, e2.x, fez, fex)
    p0 = fr(fr(-e2[2] * v0[0]) + fr(e2[0] * v0[2]));
    p1 = fr(fr(-e2[2] * v1[0]) + fr(e2[0] * v1[2]));
    if (p0 < p1) {
      min = p0;
      max = p1;
    } else {
      min = p1;
      max = p0;
    }
    rad = fr(fr(fez * boxHalfSize[0]) + fr(fex * boxHalfSize[2]));
    if (min > rad || max < -rad) {
      return false;
    }
    // AXISTEST_Z12(e2.y, e2.x, fey, fex)
    p1 = fr(fr(e2[1] * v1[0]) - fr(e2[0] * v1[1]));
    p2 = fr(fr(e2[1] * v2[0]) - fr(e2[0] * v2[1]));
    if (p2 < p1) {
      min = p2;
      max = p1;
    } else {
      min = p1;
      max = p2;
    }
    rad = fr(fr(fey * boxHalfSize[0]) + fr(fex * boxHalfSize[1]));
    if (min > rad || max < -rad) {
      return false;
    }
  }

  /* Bullet 1: */
  /*  first test overlap in the {x,y,z}-directions */
  /*  find min, max of the triangle each direction, and test for overlap in */
  /*  that direction -- this is equivalent to testing a minimal AABB around */
  /*  the triangle against the AABB */

  // FINDMINMAX + test in X-direction
  min = max = v0[0];
  if (v1[0] < min) min = v1[0];
  if (v1[0] > max) max = v1[0];
  if (v2[0] < min) min = v2[0];
  if (v2[0] > max) max = v2[0];
  if (min > boxHalfSize[0] || max < -boxHalfSize[0]) {
    return false;
  }

  // FINDMINMAX + test in Y-direction
  min = max = v0[1];
  if (v1[1] < min) min = v1[1];
  if (v1[1] > max) max = v1[1];
  if (v2[1] < min) min = v2[1];
  if (v2[1] > max) max = v2[1];
  if (min > boxHalfSize[1] || max < -boxHalfSize[1]) {
    return false;
  }

  // FINDMINMAX + test in Z-direction
  min = max = v0[2];
  if (v1[2] < min) min = v1[2];
  if (v1[2] > max) max = v1[2];
  if (v2[2] < min) min = v2[2];
  if (v2[2] > max) max = v2[2];
  if (min > boxHalfSize[2] || max < -boxHalfSize[2]) {
    return false;
  }

  /* Bullet 2: */
  /*  test if the box intersects the plane of the triangle */
  /*  compute plane equation of triangle: normal*x+d=0 */
  const nx = fr(fr(e0[1] * e1[2]) - fr(e0[2] * e1[1]));
  const ny = fr(fr(e0[2] * e1[0]) - fr(e0[0] * e1[2]));
  const nz = fr(fr(e0[0] * e1[1]) - fr(e0[1] * e1[0]));
  const normal: Vec3 = [nx, ny, nz];
  const d = -fr(fr(fr(nx * v0[0]) + fr(ny * v0[1])) + fr(nz * v0[2])); /* plane eq: normal.x+d=0 */
  return planeBoxOverlap(normal, d, boxHalfSize); /* if true, box and triangle overlaps */
}
