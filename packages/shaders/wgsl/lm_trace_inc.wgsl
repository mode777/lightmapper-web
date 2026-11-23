// lm_trace_inc.wgsl — WebGPU port of Godot's lightmapper ray-traversal
// core: the shared `ray_hits_triangle` / `ray_box_test` / `trace_ray`
// functions used by the unocclude, primary and secondary kernels.
//
// Provenance: godot/modules/lightmapper_rd/lm_compute.glsl @
// 67421f36e5069e62573c44beb8dd2f8f91e065b0 (Nov 20, 2026) — functions
// `ray_hits_triangle`, `ray_box_test`, `trace_ray`,
// `trace_ray_closest_hit_distance` (verbatim from the MODE_UNOCCLUDE /
// MODE_DIRECT_LIGHT common section).
// License: MIT — Godot Engine contributors. See NOTICE.md.
//
// PORT notes:
//  - GLSL `out` parameters become `ptr<function, T>` arguments.
//  - GLSL scalar/vector implicit conversions (e.g. `1.0 / vec3`) are made
//    explicit (`vec3<f32>(1.0) / …`) — WGSL has no mixed-type arithmetic.
//  - `findLSB(x)` → `firstTrailingBit(x)`; bit ops on u32.
//  - CLUSTER_SIZE is a fixed knob (16, docs/DESIGN.md §2), so Godot's
//    `#if CLUSTER_SIZE > 32` CLUSTER_TRIANGLE_ITERATION branch is never
//    taken and is omitted (the inner block runs once, exactly as compiled
//    upstream for the default cluster size).
//  - ClusterAABBs are read from the merged `cluster_data` buffer via
//    `load_cluster_aabb` (ADR-0005; upstream indexes `cluster_aabbs.data`).
//  - Cluster indices are read from the merged `cluster_data` region
//    (upstream: `cluster_indices.data`, binding 12).

#include "lm_common_inc.wgsl"

// CLUSTER_SIZE is fixed at 16 (docs/DESIGN.md §2 "Fixed performance knobs").
const CLUSTER_SIZE: u32 = 16u;

const RAY_MISS: u32 = 0u;
const RAY_FRONT: u32 = 1u;
const RAY_BACK: u32 = 2u;
const RAY_ANY: u32 = 3u;

// check it, but also return distance and barycentric coords (for uv lookup)
fn ray_hits_triangle(
  from_: vec3<f32>, // GLSL: from (reserved in WGSL)
  dir: vec3<f32>,
  max_dist: f32,
  p0: vec3<f32>,
  p1: vec3<f32>,
  p2: vec3<f32>,
  r_distance: ptr<function, f32>,
  r_barycentric: ptr<function, vec3<f32>>,
) -> bool {
  const EPSILON = 0.00001;
  let e0 = p1 - p0;
  let e1 = p0 - p2;
  let triangle_normal = cross(e1, e0);

  let n_dot_dir = dot(triangle_normal, dir);

  if (abs(n_dot_dir) < EPSILON) {
    return false;
  }

  let e2 = (p0 - from_) / n_dot_dir;
  let i = cross(dir, e2);

  (*r_barycentric).y = dot(i, e1);
  (*r_barycentric).z = dot(i, e0);
  (*r_barycentric).x = 1.0 - ((*r_barycentric).z + (*r_barycentric).y);
  (*r_distance) = dot(triangle_normal, e2);

  return ((*r_distance) > bake_params.bias) && ((*r_distance) < max_dist) &&
    all((*r_barycentric) >= vec3<f32>(0.0));
}

fn ray_box_test(p_from: vec3<f32>, p_inv_dir: vec3<f32>, p_box_min: vec3<f32>, p_box_max: vec3<f32>) -> bool {
  let t0 = (p_box_min - p_from) * p_inv_dir;
  let t1 = (p_box_max - p_from) * p_inv_dir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return max(tmin.x, max(tmin.y, tmin.z)) <= min(tmax.x, min(tmax.y, tmax.z));
}

fn trace_ray(
  p_from: vec3<f32>,
  p_to: vec3<f32>,
  p_any_hit: bool,
  r_distance: ptr<function, f32>,
  r_normal: ptr<function, vec3<f32>>,
  r_triangle: ptr<function, u32>,
  r_barycentric: ptr<function, vec3<f32>>,
) -> u32 {
  // World coordinates.
  let rel = p_to - p_from;
  let rel_len = length(rel);
  let dir = normalize(rel);
  let inv_dir = vec3<f32>(1.0) / dir;

  // Cell coordinates.
  let from_cell = (p_from - bake_params.to_cell_offset) * bake_params.to_cell_size;
  let to_cell = (p_to - bake_params.to_cell_offset) * bake_params.to_cell_size;

  // Prepare DDA.
  let rel_cell = to_cell - from_cell;
  var icell = vec3<i32>(from_cell);
  let iendcell = vec3<i32>(to_cell);
  let dir_cell = normalize(rel_cell);
  // Use bake_params.grid_size as max to prevent infinity values.
  let delta = min(abs(vec3<f32>(1.0) / dir_cell), vec3<f32>(f32(bake_params.grid_size)));
  let step = vec3<i32>(sign(rel_cell));
  // GLSL: vec3(icell) + max(vec3(0), sign(step)) — sign of the ivec is
  // converted to float component-wise.
  let init_next_cell = vec3<f32>(icell) + max(vec3<f32>(0.0), vec3<f32>(sign(step)));
  // Distance to next boundary. GLSL: mix(vec3(0), (init_next_cell -
  // from_cell) / dir_cell, notEqual(step, vec3(0))) — bool-mask mix is
  // select() in WGSL.
  var t_max = select(
    vec3<f32>(0.0),
    (init_next_cell - from_cell) / dir_cell,
    step != vec3<i32>(0),
  );

  var iters: u32 = 0u;
  loop {
    if (!(all(icell >= vec3<i32>(0)) && all(icell < vec3<i32>(bake_params.grid_size)) && (iters < 1000u))) {
      break;
    }
    let cell_data = textureLoad(grid, icell, 0).xy;
    let triangle_count = cell_data.x;
    if (triangle_count > 0u) {
      var hit = RAY_MISS;
      var best_distance = 1e20;
      let cluster_start = cluster_data[cell_data.y * 2u];
      let cell_triangle_start = cluster_data[cell_data.y * 2u + 1u];
      let cluster_count = (triangle_count + CLUSTER_SIZE - 1u) / CLUSTER_SIZE;
      var cluster_base_index: u32 = 0u;
      while (cluster_base_index < cluster_count) {
        // To minimize divergence, all Ray-AABB tests on the clusters contained in the cell are performed
        // before checking against the triangles. We do this 32 clusters at a time and store the intersected
        // clusters on each bit of the 32-bit integer.
        let cluster_test_count = min(32u, cluster_count - cluster_base_index);
        var cluster_hits: u32 = 0u;
        for (var i: u32 = 0u; i < cluster_test_count; i++) {
          let cluster_index = cluster_start + cluster_base_index + i;
          let cluster_aabb = load_cluster_aabb(cluster_index);
          if (ray_box_test(p_from, inv_dir, cluster_aabb.min_bounds, cluster_aabb.max_bounds)) {
            cluster_hits |= (1u << i);
          }
        }

        // Check the triangles in any of the clusters that were intersected by toggling off the bits in the
        // 32-bit integer counter until no bits are left.
        while (cluster_hits > 0u) {
          var cluster_index = firstTrailingBit(cluster_hits);
          cluster_hits &= ~(1u << cluster_index);
          cluster_index += cluster_base_index;

          // Do the same divergence execution trick with triangles as well.
          // (CLUSTER_TRIANGLE_ITERATION omitted — CLUSTER_SIZE ≤ 32.)
          {
            let triangle_start_index = cell_triangle_start + cluster_index * CLUSTER_SIZE;
            let triangle_test_count = min(CLUSTER_SIZE, triangle_count);
            var triangle_hits: u32 = 0u;
            for (var i: u32 = 0u; i < triangle_test_count; i++) {
              let triangle_index = triangle_indices[triangle_start_index + i];
              if (ray_box_test(p_from, inv_dir, triangles[triangle_index].min_bounds, triangles[triangle_index].max_bounds)) {
                triangle_hits |= (1u << i);
              }
            }

            while (triangle_hits > 0u) {
              var cluster_triangle_index = firstTrailingBit(triangle_hits);
              triangle_hits &= ~(1u << cluster_triangle_index);
              cluster_triangle_index += triangle_start_index;

              let triangle_index = triangle_indices[cluster_triangle_index];
              let triangle = triangles[triangle_index];

              // Gather the triangle vertex positions.
              let vtx0 = vertices[triangle.indices.x].position;
              let vtx1 = vertices[triangle.indices.y].position;
              let vtx2 = vertices[triangle.indices.z].position;
              let normal = -normalize(cross((vtx0 - vtx1), (vtx0 - vtx2)));
              var backface = dot(normal, dir) >= 0.0;
              var hit_distance: f32;
              var barycentric: vec3<f32>;
              if (ray_hits_triangle(p_from, dir, rel_len, vtx0, vtx1, vtx2, &hit_distance, &barycentric)) {
                if (p_any_hit) {
                  // Return early if any hit was requested.
                  return RAY_ANY;
                }
                let hit_position = p_from + dir * hit_distance;
                let hit_cell = (hit_position - bake_params.to_cell_offset) * bake_params.to_cell_size;
                // GLSL `icell != ivec3(hit_cell)` is a *scalar* comparison
                // (equality operators are all-components in GLSL).
                if (any(icell != vec3<i32>(hit_cell))) {
                  // It's possible for the ray to hit a triangle in a position outside the bounds of the cell
                  // if it's large enough to cover multiple ones. The hit must be ignored if this is the case.
                  continue;
                }

                if (!backface) {
                  // The case of meshes having both a front and back face in the same plane is more common than
                  // expected, so if this is a front-face, bias it closer to the ray origin, so it always wins
                  // over the back-face.
                  hit_distance = max(bake_params.bias, hit_distance - bake_params.bias);
                }

                if (hit_distance < best_distance) {
                  switch (triangle.cull_mode) {
                    case CULL_DISABLED: {
                      backface = false;
                    }
                    case CULL_FRONT: {
                      backface = !backface;
                    }
                    case CULL_BACK: { // Default behavior.
                    }
                    default: {
                    }
                  }

                  hit = select(RAY_FRONT, RAY_BACK, backface);
                  best_distance = hit_distance;
                  (*r_distance) = hit_distance;
                  (*r_normal) = normal;
                  (*r_triangle) = triangle_index;
                  (*r_barycentric) = barycentric;
                }
              }
            }
          }
        }

        cluster_base_index += 32u;
      }

      if (hit != RAY_MISS) {
        return hit;
      }
    }

    // GLSL `icell == iendcell` is a scalar (all-components) comparison.
    if (all(icell == iendcell)) {
      break;
    }

    // There should be only one axis updated at a time for DDA to work properly.
    if (t_max.x < t_max.y && t_max.x < t_max.z) {
      icell.x += step.x;
      t_max.x += delta.x;
    } else if (t_max.y < t_max.z) {
      icell.y += step.y;
      t_max.y += delta.y;
    } else {
      icell.z += step.z;
      t_max.z += delta.z;
    }
    iters++;
  }

  return RAY_MISS;
}

fn trace_ray_closest_hit_distance(
  p_from: vec3<f32>,
  p_to: vec3<f32>,
  r_distance: ptr<function, f32>,
  r_normal: ptr<function, vec3<f32>>,
) -> u32 {
  var triangle: u32;
  var barycentric: vec3<f32>;
  return trace_ray(p_from, p_to, false, r_distance, r_normal, &triangle, &barycentric);
}
