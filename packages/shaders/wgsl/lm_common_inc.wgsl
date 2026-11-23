// lm_common_inc.wgsl — WebGPU port of Godot's lightmapper shared
// declarations, included by every kernel.
//
// Provenance: godot/modules/lightmapper_rd/lm_common_inc.glsl @
// 67421f36e5069e62573c44beb8dd2f8f91e065b0 (Nov 20, 2026).
// License: MIT — Godot Engine contributors. See NOTICE.md.
//
// PORT: WGSL has no preprocessor. The `#include "lm_common_inc.wgsl"`
// directive seen in kernel files is resolved by @lightmapper/shaders
// (src/index.ts) and tools/wgsl-check before compilation — mirroring Godot's
// own `#include "lm_common_inc.glsl"`.
//
// Byte-layout note (ADR-0008): the struct layouts below are byte-identical
// to the GLSL std430/std140 layouts of the pinned commit. The authoritative
// tables live in docs/DESIGN.md §4; the TS writers in
// packages/core/src/layout/structs.ts are offset-pinned by tests.
//
// Reserved WGSL words are suffixed with `_` (GLSL name kept in comments):
//   type_  (type), size_ (size), range_ (range), pad_ (pad).
//
// PORT (ADR-0005): Godot binds `cluster_indices` (binding 12) and
// `cluster_aabbs` (binding 13) as two separate storage buffers. WebGPU's
// core guarantee is 8 storage buffers per shader stage, so both regions live
// in ONE merged `cluster_data` buffer at binding 12:
//   [ u32 indices … (padded to 32 B) | ClusterAABB[] (8 u32 each) ]
// The pipeline override constant `cluster_aabb_offset_u32` carries the
// u32-element offset where the AABB array starts; the driver sets it at
// pipeline creation (`createComputePipeline({ constants })`).

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

struct Vertex {
  position: vec3<f32>,
  normal_z: f32,
  uv: vec2<f32>,
  normal_xy: vec2<f32>,
}

const CULL_DISABLED: u32 = 0u;
const CULL_FRONT: u32 = 1u;
const CULL_BACK: u32 = 2u;

struct Triangle {
  indices: vec3<u32>,
  slice: u32,
  min_bounds: vec3<f32>,
  cull_mode: u32,
  max_bounds: vec3<f32>,
  pad1: u32,
}

struct ClusterAABB {
  min_bounds: vec3<f32>,
  pad0: u32,
  max_bounds: vec3<f32>,
  pad1: u32,
}

const LIGHT_TYPE_DIRECTIONAL: u32 = 0u;
const LIGHT_TYPE_OMNI: u32 = 1u;
const LIGHT_TYPE_SPOT: u32 = 2u;
const LIGHT_TYPE_AREA: u32 = 3u;

struct Light {
  position: vec3<f32>,
  type_: u32, // GLSL: type
  direction: vec3<f32>,
  energy: f32,
  color: vec3<f32>,
  size_: f32, // GLSL: size
  range_: f32, // GLSL: range
  attenuation: f32,
  cos_spot_angle: f32,
  inv_spot_attenuation: f32,
  indirect_energy: f32,
  shadow_blur: f32,
  static_bake: u32,
  pad_: u32, // GLSL: pad
  area_width: vec4<f32>,
  area_height: vec4<f32>,
  area_texture_rect: vec4<f32>,
}

struct Seam {
  a: vec2<u32>,
  b: vec2<u32>,
}

// Fragment action constants (lm_raster).
const FA_NONE: u32 = 0u;
const FA_SMOOTHEN_POSITION: u32 = 1u;

@group(0) @binding(0) var<uniform> bake_params: BakeParameters;
@group(0) @binding(1) var<storage, read> vertices: array<Vertex>;
@group(0) @binding(2) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read> triangle_indices: array<u32>;
@group(0) @binding(4) var<storage, read> lights: array<Light>;
@group(0) @binding(5) var<storage, read> seams: array<Seam>;
@group(0) @binding(6) var<storage, read> probe_positions: array<vec4<f32>>;
@group(0) @binding(7) var grid: texture_3d<u32>;
@group(0) @binding(8) var albedo_tex: texture_2d_array<f32>;
@group(0) @binding(9) var emission_tex: texture_2d_array<f32>;
@group(0) @binding(10) var linear_sampler: sampler;
@group(0) @binding(11) var area_light_atlas_sampler: sampler;
// PORT (ADR-0005): merged cluster_indices + cluster_aabbs (see header).
@group(0) @binding(12) var<storage, read> cluster_data: array<u32>;

// Element (u32) offset of the ClusterAABB region inside cluster_data —
// set per pipeline by the driver (PORT, ADR-0005).
override cluster_aabb_offset_u32: u32 = 0u;

// Read one ClusterAABB out of the merged cluster_data buffer (std430
// ClusterAABB stride = 32 bytes = 8 u32 elements).
fn load_cluster_aabb(cluster_index: u32) -> ClusterAABB {
  let base = cluster_aabb_offset_u32 + cluster_index * 8u;
  var aabb: ClusterAABB;
  aabb.min_bounds = vec3<f32>(
    bitcast<f32>(cluster_data[base + 0u]),
    bitcast<f32>(cluster_data[base + 1u]),
    bitcast<f32>(cluster_data[base + 2u]),
  );
  aabb.pad0 = cluster_data[base + 3u];
  aabb.max_bounds = vec3<f32>(
    bitcast<f32>(cluster_data[base + 4u]),
    bitcast<f32>(cluster_data[base + 5u]),
    bitcast<f32>(cluster_data[base + 6u]),
  );
  aabb.pad1 = cluster_data[base + 7u];
  return aabb;
}
