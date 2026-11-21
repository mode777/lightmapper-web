// lm_dilate.wgsl — WebGPU port of Godot's lightmapper "dilate" kernel.
//
// Provenance: godot/modules/lightmapper_rd/lm_compute.glsl, version `dilate`
// (MODE_DILATE) @ 67421f36e5069e62573c44beb8dd2f8f91e065b0 (Nov 20, 2026).
// Ported faithfully, including behavioral quirks (see GODOT-QUIRK notes).
//
// License: MIT — Godot Engine contributors. See NOTICE.md.
//
// Purpose: fill padding texels of each lightmap atlas slice by copying the
// nearest lit texel (alpha > 0.5) within `4 * supersampling_factor` texels.
//
// Binding map (see docs/DESIGN.md §5 for the canonical map):
//   group 0 — shared "base" set (lm_common):
//     binding 0: BakeParameters uniform buffer
//   group 1 — kernel I/O:
//     binding 0: dest_light   — texture_storage_2d_array<rgba16float, write>
//     binding 1: source_light — texture_2d_array<f32> (sampled, texelFetch-style)
//   group 2 — per-dispatch Params (push-constant replacement, ADR-0003):
//     binding 0: Params uniform buffer (dynamic offset)

struct BakeParameters {
  world_size: vec3<f32>,
  bias: f32,
  to_cell_offset: vec3<f32>,
  grid_size: i32,
  to_cell_size: vec3<f32>,
  light_count: u32,
  // Column-major mat3x4, exactly as Godot uploads it (48 bytes).
  env_transform: mat3x4<f32>,
  atlas_size: vec2<i32>,
  exposure_normalization: f32,
  bounces: u32,
  bounce_indirect_energy: f32,
  shadowmask_light_idx: i32,
  transparency_rays: u32,
  supersampling_factor: f32,
}

// Mirrors the GLSL push-constant `Params` (32 bytes).
struct Params {
  atlas_slice: u32,
  ray_count: u32,
  ray_from: u32,
  ray_to: u32,
  region_ofs: vec2<i32>,
  probe_count: u32,
  denoiser_range: u32,
}

@group(0) @binding(0) var<uniform> bake_params: BakeParameters;
@group(1) @binding(0) var dest_light: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(1) var source_light: texture_2d_array<f32>;
@group(2) @binding(0) var<uniform> params: Params;

// Module-scope var (not const) so runtime indexing is portable across WGSL
// implementations.
var<private> directions = array<vec2<i32>, 8>(
  vec2<i32>(-1, 0),
  vec2<i32>(0, 1),
  vec2<i32>(1, 0),
  vec2<i32>(0, -1),
  vec2<i32>(-1, -1),
  vec2<i32>(-1, 1),
  vec2<i32>(1, -1),
  vec2<i32>(1, 1),
);

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Check if invocation is out of bounds.
  let atlas_pos = vec2<i32>(gid.xy) + params.region_ofs;
  if (atlas_pos.x >= bake_params.atlas_size.x || atlas_pos.y >= bake_params.atlas_size.y) {
    return;
  }

  let slice = i32(params.atlas_slice);
  let dims = vec2<i32>(textureDimensions(source_light));
  let max_radius = i32(4.0 * bake_params.supersampling_factor);

  var texel_color = textureLoad(source_light, atlas_pos, slice, 0);

  // GODOT-QUIRK: the original nests an early `break` out of two loops. The
  // `done` flag reproduces the exact traversal order: per radius, scan the 8
  // directions and take the *first* lit neighbor — even if the center texel
  // itself is already lit (a lit center can still be overwritten by the
  // radius-1 scan before the outer break triggers).
  var done = false;
  for (var radius = 1; radius <= max_radius; radius++) {
    if (done) {
      break;
    }
    for (var i = 0; i < 8; i++) {
      if (done) {
        break;
      }
      let sample_pos = atlas_pos + directions[i] * radius;
      // Texture bounds check for robustness.
      if (sample_pos.x < 0 || sample_pos.y < 0 || sample_pos.x >= dims.x || sample_pos.y >= dims.y) {
        continue;
      }
      let neighbor_color = textureLoad(source_light, sample_pos, slice, 0);
      if (neighbor_color.a > 0.5) {
        texel_color = neighbor_color;
        done = true;
      }
    }

    if (texel_color.a > 0.5) {
      done = true;
    }
  }

  textureStore(dest_light, atlas_pos, slice, texel_color);
}
