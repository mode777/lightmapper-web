// lm_raster.wgsl — WebGPU port of Godot's lightmapper G-buffer raster
// kernel: rasterizes the scene geometry into atlas textures in UV2 space
// (position + unocclude data + normal).
//
// Provenance: godot/modules/lightmapper_rd/lm_raster.glsl @
// 67421f36e5069e62573c44beb8dd2f8f91e065b0 (Nov 20, 2026) — vertex +
// fragment stages, verbatim math including FA_SMOOTHEN_POSITION and the
// dFdx/dFdy texel-size estimate.
// License: MIT — Godot Engine contributors. See NOTICE.md.
//
// PORT (ADR-0004): upstream writes three color attachments (position
// rgba32f, normal rgbah, unocclude rgba32f = 48 B/sample) in one pass;
// WebGPU's core limit is 32 B/sample. The pass is split A/B:
//   pass A (fa_main): { position, unocclude }  — 32 B
//   pass B (fb_main): { normal }               — 8 B
// WGSL cannot make output *structs* conditional on constant overrides, so
// the two passes are two fragment entry points in one module sharing the
// same vertex stage and body (the WGSL-native realization of the
// "two pipeline variants via a define" decision).
//
// PORT (ADR-0007): upstream re-draws the triangles with a *wireframe*
// rasterization pipeline to cover texels missed by fill rasterization
// (conservative-rasterization trick). WebGPU has no wireframe fill mode;
// `vs_edges_main` emulates it by pushing each vertex outward from the
// UV-space triangle centroid by ~1 texel before projecting. Because
// gl_Position.z is a constant (0.0001) for every vertex, the depth test
// (LESS, write enabled) makes the expanded pass land only in texels the
// fill pass did not cover — same net behavior as upstream's wire draw.
//
// PORT: vertex pulling — vertices/triangles are read from storage buffers
// in the vertex stage (core WebGPU) instead of using real vertex buffers.
//
// Binding map (docs/DESIGN.md §5):
//   group 0 — shared base set (lm_common_inc.wgsl)
//   group 2 — RasterParams uniform buffer (dynamic offset, ADR-0003)

#include "lm_common_inc.wgsl"

// Mirrors the GLSL push-constant `Params` of lm_raster.glsl (64 bytes,
// std430 — atlas_size is float2 here, unlike BakeParameters.atlas_size!).
struct RasterParams {
  atlas_size: vec2<f32>,
  uv_offset: vec2<f32>,
  to_cell_size: vec3<f32>,
  base_triangle: u32,
  to_cell_offset: vec3<f32>,
  bias: f32,
  grid_size: vec3<i32>,
  pad2: u32,
}

@group(2) @binding(0) var<uniform> params: RasterParams;

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vertex_interp: vec3<f32>,
  @location(1) normal_interp: vec3<f32>,
  @location(2) uv_interp: vec2<f32>,
  @location(3) barycentric: vec3<f32>,
  @location(4) @interpolate(flat) vertex_indices: vec3<u32>,
  @location(5) @interpolate(flat) face_normal: vec3<f32>,
  @location(6) @interpolate(flat) fragment_action: u32,
}

// PORT (ADR-0007): push a UV-space vertex one texel away from the triangle
// centroid (input and output are in texel units). Degenerate UV triangles
// (all vertices at one point) are left as-is — a wireframe draw would cover
// no texels either.
fn expand_edge_vertex(uv: vec2<f32>, centroid: vec2<f32>) -> vec2<f32> {
  let dir = uv - centroid;
  if (length(dir) < 1e-8) {
    return uv;
  }
  return uv + normalize(dir); // exactly 1 texel outward
}

fn vertex_main_impl(vertex_index: u32, expand_edges: bool) -> VsOut {
  let triangle_idx = params.base_triangle + vertex_index / 3u;
  let triangle_subidx = vertex_index % 3u;

  let vertex_indices = triangles[triangle_idx].indices;

  var vertex_idx: u32;
  var barycentric: vec3<f32>;
  if (triangle_subidx == 0u) {
    vertex_idx = vertex_indices.x;
    barycentric = vec3<f32>(1.0, 0.0, 0.0);
  } else if (triangle_subidx == 1u) {
    vertex_idx = vertex_indices.y;
    barycentric = vec3<f32>(0.0, 1.0, 0.0);
  } else {
    vertex_idx = vertex_indices.z;
    barycentric = vec3<f32>(0.0, 0.0, 1.0);
  }

  let vertex_interp = vertices[vertex_idx].position;
  let uv_interp = vertices[vertex_idx].uv;
  let normal_interp = vec3<f32>(vertices[vertex_idx].normal_xy, vertices[vertex_idx].normal_z);

  let face_normal = -normalize(
    cross(
      (vertices[vertex_indices.x].position - vertices[vertex_indices.y].position),
      (vertices[vertex_indices.x].position - vertices[vertex_indices.z].position),
    ),
  );

  var fragment_action: u32;
  {
    const FLAT_THRESHOLD = 0.99;
    let norm_a = vec3<f32>(vertices[vertex_indices.x].normal_xy, vertices[vertex_indices.x].normal_z);
    let norm_b = vec3<f32>(vertices[vertex_indices.y].normal_xy, vertices[vertex_indices.y].normal_z);
    let norm_c = vec3<f32>(vertices[vertex_indices.z].normal_xy, vertices[vertex_indices.z].normal_z);
    // WGSL has no ternary — GLSL `cond ? FA_SMOOTHEN_POSITION : FA_NONE`.
    fragment_action = select(FA_NONE, FA_SMOOTHEN_POSITION,
      dot(norm_a, norm_b) < FLAT_THRESHOLD || dot(norm_a, norm_c) < FLAT_THRESHOLD ||
      dot(norm_b, norm_c) < FLAT_THRESHOLD);
  }

  var out: VsOut;
  out.vertex_interp = vertex_interp;
  out.normal_interp = normal_interp;
  out.uv_interp = uv_interp;
  out.barycentric = barycentric;
  out.vertex_indices = vertex_indices;
  out.face_normal = face_normal;
  out.fragment_action = fragment_action;

  var clip_uv = uv_interp;
  if (expand_edges) {
    // PORT (ADR-0007): expand in texel space so the offset is ~1 texel
    // regardless of atlas resolution; the shared depth behavior then keeps
    // the expanded pass out of already-filled texels.
    let texel_scale = params.atlas_size;
    let uv_a = vertices[vertex_indices.x].uv * texel_scale;
    let uv_b = vertices[vertex_indices.y].uv * texel_scale;
    let uv_c = vertices[vertex_indices.z].uv * texel_scale;
    let centroid = (uv_a + uv_b + uv_c) / 3.0;
    clip_uv = expand_edge_vertex(uv_interp * texel_scale, centroid) / texel_scale;
  }

  // PORT: Vulkan's clip-space Y points DOWN (framebuffer row 0 is clip
  // y = -1), WebGPU's points UP. Flip Y so atlas texel row 0 stays uv v = 0
  // exactly like upstream — the CPU-side atlas blits, `meshRects` and every
  // later kernel's texel↔uv mapping rely on that orientation.
  let clip = (clip_uv + params.uv_offset) * 2.0 - vec2<f32>(1.0);
  out.position = vec4<f32>(clip.x, -clip.y, 0.0001, 1.0);
  return out;
}

// Fill pass (upstream: default rasterization pipeline).
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VsOut {
  return vertex_main_impl(vertex_index, false);
}

// Edge-expansion pass (upstream: wireframe pipeline, ADR-0007).
@vertex
fn vs_edges_main(@builtin(vertex_index) vertex_index: u32) -> VsOut {
  return vertex_main_impl(vertex_index, true);
}

struct GBufferOutputs {
  position: vec4<f32>,
  normal: vec4<f32>,
  unocclude: vec4<f32>,
}

fn fragment_main_impl(in: VsOut) -> GBufferOutputs {
  var vertex_pos = in.vertex_interp;

  if (in.fragment_action == FA_SMOOTHEN_POSITION) {
    // smooth out vertex position by interpolating its projection in the 3 normal planes (normal plane is created by vertex pos and normal)
    // because we don't want to interpolate inwards, normals found pointing inwards are pushed out.
    let pos_a = vertices[in.vertex_indices.x].position;
    let pos_b = vertices[in.vertex_indices.y].position;
    let pos_c = vertices[in.vertex_indices.z].position;
    let center = (pos_a + pos_b + pos_c) * 0.3333333;
    var norm_a = vec3<f32>(vertices[in.vertex_indices.x].normal_xy, vertices[in.vertex_indices.x].normal_z);
    var norm_b = vec3<f32>(vertices[in.vertex_indices.y].normal_xy, vertices[in.vertex_indices.y].normal_z);
    var norm_c = vec3<f32>(vertices[in.vertex_indices.z].normal_xy, vertices[in.vertex_indices.z].normal_z);

    {
      let dir_a = normalize(pos_a - center);
      let d_a = dot(dir_a, norm_a);
      if (d_a < 0.0) {
        //pointing inwards
        norm_a = normalize(norm_a - dir_a * d_a);
      }
    }
    {
      let dir_b = normalize(pos_b - center);
      let d_b = dot(dir_b, norm_b);
      if (d_b < 0.0) {
        //pointing inwards
        norm_b = normalize(norm_b - dir_b * d_b);
      }
    }
    {
      let dir_c = normalize(pos_c - center);
      let d_c = dot(dir_c, norm_c);
      if (d_c < 0.0) {
        //pointing inwards
        norm_c = normalize(norm_c - dir_c * d_c);
      }
    }

    let d_a = dot(norm_a, pos_a);
    let d_b = dot(norm_b, pos_b);
    let d_c = dot(norm_c, pos_c);

    let proj_a = vertex_pos - norm_a * (dot(norm_a, vertex_pos) - d_a);
    let proj_b = vertex_pos - norm_b * (dot(norm_b, vertex_pos) - d_b);
    let proj_c = vertex_pos - norm_c * (dot(norm_c, vertex_pos) - d_c);

    let smooth_position = proj_a * in.barycentric.x + proj_b * in.barycentric.y + proj_c * in.barycentric.z;

    if (dot(in.face_normal, smooth_position) > dot(in.face_normal, vertex_pos)) { //only project outwards
      vertex_pos = smooth_position;
    }
  }

  var unocclude: vec4<f32>;
  {
    // unocclusion technique based on:
    // https://ndotl.wordpress.com/2018/08/29/baking-artifact-free-lightmaps/

    // compute texel size (GLSL dFdx/dFdy → WGSL dpdx/dpdy)
    let delta_uv = max(abs(dpdx(in.vertex_interp)), abs(dpdy(in.vertex_interp)));
    var texel_size = max(delta_uv.x, max(delta_uv.y, delta_uv.z));
    texel_size *= sqrt(2.0); //expand to unit box edge length (again, worst case)

    unocclude = vec4<f32>(in.face_normal, texel_size);
    //continued on lm_unocclude.wgsl
  }

  return GBufferOutputs(
    vec4<f32>(vertex_pos, 1.0),
    vec4<f32>(normalize(in.normal_interp), 1.0),
    unocclude,
  );
}

// Pass A — { position, unocclude } (ADR-0004).
struct FragOutA {
  @location(0) position: vec4<f32>,
  @location(1) unocclude: vec4<f32>,
}

@fragment
fn fa_main(in: VsOut) -> FragOutA {
  let outputs = fragment_main_impl(in);
  return FragOutA(outputs.position, outputs.unocclude);
}

// Pass B — { normal } (ADR-0004).
struct FragOutB {
  @location(0) normal: vec4<f32>,
}

@fragment
fn fb_main(in: VsOut) -> FragOutB {
  let outputs = fragment_main_impl(in);
  return FragOutB(outputs.normal);
}
