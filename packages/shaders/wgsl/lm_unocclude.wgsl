// lm_unocclude.wgsl — WebGPU port of Godot's lightmapper "unocclude"
// kernel: pushes G-buffer positions out of near geometry so later light
// rays do not self-intersect.
//
// Provenance: godot/modules/lightmapper_rd/lm_compute.glsl, version
// `unocclude` (MODE_UNOCCLUDE) @ 67421f36e5069e62573c44beb8dd2f8f91e065b0
// (Nov 20, 2026) — main() bounds-check prologue + the MODE_UNOCCLUDE block;
// traversal via lm_trace_inc.wgsl (trace_ray).
// License: MIT — Godot Engine contributors. See NOTICE.md.
//
// PORT: upstream binds `position`/`unocclude` as read_write rgba32f images.
// read-write rgba32f storage textures are not universally available
// (SwiftShader among others rejects them), so the documented fallback
// (ARCHITECTURE §4) is realized here: *sampled* source textures plus
// *write-only* destination textures (ping-pong). Every texel in bounds is
// stored, covered or not, so the destinations are fully defined without a
// clear. The kernel math is unchanged; the driver swaps the texture
// references afterwards (Godot uses SWAP() macros for the same purpose).
//
// Binding map (docs/DESIGN.md §5):
//   group 0 — shared base set (lm_common_inc.wgsl)
//   group 1 — kernel I/O:
//     binding 0: position_src   — texture_2d_array<f32> (rgba32float, load)
//     binding 1: unocclude_src  — texture_2d_array<f32> (rgba32float, load)
//     binding 2: position_dst   — texture_storage_2d_array<rgba32float, write>
//     binding 3: unocclude_dst  — texture_storage_2d_array<rgba32float, write>
//   group 2 — per-dispatch Params (push-constant replacement, ADR-0003):
//     binding 0: Params uniform buffer (dynamic offset)

#include "lm_common_inc.wgsl"
#include "lm_trace_inc.wgsl"

// Mirrors the compute push-constant `Params` (32 bytes, std430).
struct Params {
  atlas_slice: u32,
  ray_count: u32,
  ray_from: u32,
  ray_to: u32,
  region_ofs: vec2<i32>,
  probe_count: u32,
  denoiser_range: u32,
}

@group(1) @binding(0) var position_src: texture_2d_array<f32>;
@group(1) @binding(1) var unocclude_src: texture_2d_array<f32>;
@group(1) @binding(2) var position_dst: texture_storage_2d_array<rgba32float, write>;
@group(1) @binding(3) var unocclude_dst: texture_storage_2d_array<rgba32float, write>;
@group(2) @binding(0) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Check if invocation is out of bounds.
  let atlas_pos = vec2<i32>(gid.xy) + params.region_ofs;
  if (atlas_pos.x >= bake_params.atlas_size.x || atlas_pos.y >= bake_params.atlas_size.y) {
    return;
  }

  //texel_size = 0.5;
  //compute tangents

  var position_alpha = textureLoad(position_src, atlas_pos, i32(params.atlas_slice), 0);
  if (position_alpha.a < 0.5) {
    // Pass the empty texel through so the destination stays fully defined.
    textureStore(position_dst, atlas_pos, i32(params.atlas_slice), position_alpha);
    textureStore(unocclude_dst, atlas_pos, i32(params.atlas_slice), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  var vertex_pos = position_alpha.xyz;
  let normal_tsize = textureLoad(unocclude_src, atlas_pos, i32(params.atlas_slice), 0);

  let face_normal = normal_tsize.xyz;
  let texel_size = normal_tsize.w;

  let v0 = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(face_normal.z) < 0.999);
  let tangent = normalize(cross(v0, face_normal));
  let bitangent = normalize(cross(tangent, face_normal));
  let base_pos = vertex_pos + face_normal * bake_params.bias; // Raise a bit.

  var rays = array<vec3<f32>, 4>(tangent, bitangent, -tangent, -bitangent);
  var min_d = 1e20;
  var unocclude_mask = 0.0;

  for (var i = 0u; i < 4u; i++) {
    let ray_to = base_pos + rays[i] * texel_size * f32(params.denoiser_range);
    var d: f32;
    var norm: vec3<f32>;

    if (trace_ray_closest_hit_distance(base_pos, ray_to, &d, &norm) == RAY_BACK) {
      unocclude_mask = 1.0;
      if (d <= texel_size && d < min_d) {
        // This bias needs to be greater than the regular bias, because
        // otherwise later, rays will go the other side when pointing back.
        // GODOT-QUIRK: bias × 10 for the push-out along the occluder normal.
        vertex_pos = base_pos + rays[i] * d + norm * bake_params.bias * 10.0;
        min_d = d;
      }
    }
  }

  // GLSL `position_alpha.xyz = vertex_pos;` — WGSL has no swizzle
  // assignment, so rebuild the vec4 (alpha keeps the rasterized 1.0).
  position_alpha = vec4<f32>(vertex_pos, position_alpha.a);

  textureStore(position_dst, atlas_pos, i32(params.atlas_slice), position_alpha);
  textureStore(unocclude_dst, atlas_pos, i32(params.atlas_slice), vec4<f32>(unocclude_mask, 0.0, 0.0, 0.0));
}
