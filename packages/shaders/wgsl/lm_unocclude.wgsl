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
// Binding map (docs/DESIGN.md §5):
//   group 0 — shared base set (lm_common_inc.wgsl)
//   group 1 — kernel I/O:
//     binding 0: position   — texture_storage_2d_array<rgba32float, read_write>
//     binding 1: unocclude  — texture_storage_2d_array<rgba32float, read_write>
//   group 2 — per-dispatch Params (push-constant replacement, ADR-0003):
//     binding 0: Params uniform buffer (dynamic offset)
//
// PORT: Godot binds these as GLSL `image2DArray` with rgba32f — WebGPU
// read_write storage textures (ARCHITECTURE §4; ping-pong fallback would be
// a documented deviation if an adapter rejects read-write rgba32f).

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

@group(1) @binding(0) var position_tex: texture_storage_2d_array<rgba32float, read_write>;
@group(1) @binding(1) var unocclude_tex: texture_storage_2d_array<rgba32float, read_write>;
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

  var position_alpha = textureLoad(position_tex, atlas_pos, i32(params.atlas_slice));
  if (position_alpha.a < 0.5) {
    return;
  }

  var vertex_pos = position_alpha.xyz;
  let normal_tsize = textureLoad(unocclude_tex, atlas_pos, i32(params.atlas_slice));

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

  textureStore(position_tex, atlas_pos, i32(params.atlas_slice), position_alpha);
  textureStore(unocclude_tex, atlas_pos, i32(params.atlas_slice), vec4<f32>(unocclude_mask, 0.0, 0.0, 0.0));
}
