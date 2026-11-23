# Design

*Last updated: 2026-11-22 (M2). This document is the **authoritative**
specification for the public API, data contracts and WGSL binding map.
Implementation files (TS + WGSL) must stay in lock-step with it.*

## 1. Public API sketch (M1 target; refinements welcome via ADR)

```ts
import { Lightmapper, BakeScene } from '@lightmapper/core';

const baker = new Lightmapper({
  // device?: GPUDevice        — bring your own; otherwise a private one is created
  // powerPreference?: 'high-performance' | 'low-power'
  // maxStorageBufferBindingSize?: number — requested limit raise for big scenes
});

const scene = new BakeScene();

scene.addMesh({
  // Triangle soup or indexed geometry, world space.
  positions: Float32Array,            // xyz *
  normals?: Float32Array,             // xyz; computed flat if omitted
  indices?: Uint32Array,              // triangle list; sequential if omitted
  uv2?: Float32Array,                 // xy *; if omitted, unwrapped via xatlas (M1)
  texelSize?: number,                 // world units per lightmap texel (unwrap hint)
  lightmapSizeHint?: [number, number],// texels; drives gbuffer image size (default 64×64)
  // Either user-supplied UV2-space images …
  albedoOnUv2?:  { width: number; height: number; data: Uint8Array },   // rgba8, alpha = opacity
  emissionOnUv2?:{ width: number; height: number; data: Uint16Array },  // rgbah
  // … or material description rendered by @lightmapper/gbuffer (M2)
  material?: GltfLikeMaterial,
  cullMode?: 'back' | 'front' | 'none',
});

scene.addDirectionalLight({ direction, color, energy, indirectEnergy,
  angularSizeDeg, shadowBlur, static: true });
scene.addOmniLight({ position, color, energy, indirectEnergy,
  range, attenuation, size, shadowBlur, static: true });
scene.addSpotLight({ position, direction, color, energy, indirectEnergy,
  range, attenuation, angleDeg, spotAttenuation, size, shadowBlur, static: true });

scene.setEnvironment({
  panorama?: ImageBitmap | { width; height; data: Float32Array },  // equirect; converted to rgba16f (ADR-0006)
  rotation?: Mat3,                                                  // env_transform
});

scene.addProbe([x, y, z]);
scene.generateProbes('subdiv_8');       // Godot GenerateProbes enum

const result = await baker.bake(scene, {
  quality: 'low' | 'medium' | 'high' | 'ultra',   // rayCount 32/128/512/2048
  probeQuality?: same,                            // probe ray count 64/256/512/2048
  bounces: 3,
  bounceIndirectEnergy: 1,
  bias: 0.01,                      // world units
  atlasMaxSize: 2048,
  supersampling: 1,
  denoise: { strength: 1, range: 8 } | null,      // JNLM; null disables
  bakeDirectionalSH: false,                       // 4-slice L1 lightmaps
  bakeShadowmask: false,
  textureForBounces: true,                        // USE_LIGHT_TEXTURE_FOR_BOUNCES
  exposureNormalization: 1,
  regionSize: 512,                                // watchdog chunking
  raysPerPass?: number,                           // default 4, raise on desktop
  onProgress?: (fraction: number, message: string) => boolean,  // false cancels
});

if (result.ok) {
  result.lightmaps   // { width, height, slices, data: Uint16Array /*rgbah*/ }[]
  result.meshRects   // [{ slice, offset: [x,y], scale: [x,y] }] per addMesh
  result.probes      // { positions: Float32Array, sh9: Float32Array /* 9*3 per probe */ } | null
  result.shadowmasks // per-slice r8 arrays | null
} else {
  result.error       // typed BakeError
}
```

Semantics notes:

- Units/coordinates: world-space right-handed, Y-up assumed (Godot convention);
  equirect panorama sampled via `atan(x,z)` mapping exactly as
  `trace_environment_color` in `lm_compute.glsl`.
- Cancellation is cooperative between regions/draws; see ARCHITECTURE §6.

## 2. Quality presets (Godot defaults, `register_types.cpp`)

| Preset | rayCount | probeRayCount |
|---|---|---|
| low | 32 | 64 |
| medium | 128 | 256 |
| high | 512 | 512 |
| ultra | 2048 | 2048 |

Fixed performance knobs (Godot defaults): `maxRaysPerPass = 4`,
`maxRaysPerProbePass = 64`, `maxTransparencyRays = 8`, `regionSize = 512`,
`gridSize = 128`, `clusterSize = 16`.

## 3. WGSL module conventions

- One file per kernel where practical: `lm_primary.wgsl`, `lm_secondary.wgsl`,
  `lm_unocclude.wgsl`, `lm_light_probes.wgsl`, `lm_dilate.wgsl` (✅ reference
  example), `lm_denoise.wgsl`, `lm_pack_l1.wgsl`, `lm_raster.wgsl`,
  `lm_blendseams_lines.wgsl`, `lm_blendseams_triangles.wgsl`.
- Shared declarations are **include snippets**: `lm_common_inc.wgsl` (the
  port of `lm_common_inc.glsl` — base set + structs) and `lm_trace_inc.wgsl`
  (the `trace_ray` traversal core). Kernels reference them with
  `#include "name.wgsl"`, resolved before compilation by
  `@lightmapper/shaders` (`resolveIncludes`) and `tools/wgsl-check` —
  same-directory includes, **include-once** (Godot preprocessor semantics).
  PORT: WGSL has no preprocessor; keep the TS and Rust resolvers in
  lock-step.
- Variants that Godot expresses as `#define` (`USE_SH_LIGHTMAPS`,
  `USE_SHADOWMASK`, `USE_LIGHT_TEXTURE_FOR_BOUNCES`, split-pass defines) are
  resolved by the build/driver via string-substitution on a `// DEFS:` marker
  block — same trick Godot's `#[versions]` uses. The substitution must happen
  before `createShaderModule`; `tools/wgsl-check` validates the un-substituted
  file (keep the marker block valid WGSL — use `if (false && OVERRIDES)`-free
  patterns; see playbook §4.3). *Realized alternatives so far:* the raster
  split passes (ADR-0004) are **two fragment entry points** in one module —
  WGSL cannot make output structs conditional on constant overrides — and
  the merged cluster buffer's AABB offset (ADR-0005) is a pipeline
  **override constant** (`cluster_aabb_offset_u32`).
- Reserved words: WGSL reserves `type`, `size`, `range`, `filter`, `from`,
  `pad`, … — suffix with `_` (`type_`, `size_`, `range_`) and keep the GLSL
  name in comments.
- Provenance header + `// GODOT-QUIRK:` / `// PORT:` markers are mandatory.

## 4. GPU data contracts (byte-exact with Godot — ADR-0008)

All little-endian. TS writers: `packages/core/src/layout/structs.ts`
(unit-tested offsets). WGSL declarations must match.

### 4.1 `Vertex` — 32 bytes (storage buffer)

| Offset | Field | Type |
|---|---|---|
| 0 | position | vec3⟨f32⟩ |
| 12 | normal_z | f32 |
| 16 | uv | vec2⟨f32⟩ (atlas space) |
| 24 | normal_xy | vec2⟨f32⟩ |

### 4.2 `Triangle` — 48 bytes (storage buffer)

| Offset | Field | Type |
|---|---|---|
| 0 | indices | uvec3 |
| 12 | slice | u32 |
| 16 | min_bounds | vec3⟨f32⟩ |
| 28 | cull_mode | u32 (0 disabled, 1 front, 2 back) |
| 32 | max_bounds | vec3⟨f32⟩ |
| 44 | pad1 | u32 |

### 4.3 `Light` — 128 bytes (storage buffer)

| Offset | Field | Type |
|---|---|---|
| 0 | position | vec3⟨f32⟩ |
| 12 | type | u32 (0 dir, 1 omni, 2 spot, 3 area) |
| 16 | direction | vec3⟨f32⟩ |
| 28 | energy | f32 |
| 32 | color | vec3⟨f32⟩ |
| 44 | size | f32 |
| 48 | range | f32 |
| 52 | attenuation | f32 |
| 56 | cos_spot_angle | f32 |
| 60 | inv_spot_attenuation | f32 |
| 64 | indirect_energy | f32 |
| 68 | shadow_blur | f32 |
| 72 | static_bake | u32 (bool) |
| 76 | pad | u32 |
| 80 | area_width | vec4⟨f32⟩ |
| 96 | area_height | vec4⟨f32⟩ |
| 112 | area_texture_rect | vec4⟨f32⟩ |

### 4.4 `ClusterAABB` — 32 bytes; `Seam` — 16 bytes (`uvec2 a; uvec2 b`)

### 4.5 `BakeParameters` — 128 bytes (uniform, group 0 binding 0)

| Offset | Field |
|---|---|
| 0 | world_size vec3 + bias f32 |
| 16 | to_cell_offset vec3 + grid_size i32 |
| 32 | to_cell_size vec3 + light_count u32 |
| 48 | env_transform mat3x4 (3 columns × vec4, 48 B) |
| 96 | atlas_size ivec2 + exposure_normalization f32 + bounces u32 |
| 112 | bounce_indirect_energy f32, shadowmask_light_idx i32, transparency_rays u32, supersampling_factor f32 |

### 4.6 `Params` — 32 bytes (uniform, group 2 binding 0, **dynamic offset**)

| Offset | Field |
|---|---|
| 0 | atlas_slice u32, ray_count u32, ray_from u32, ray_to u32 |
| 16 | region_ofs ivec2, probe_count u32, denoiser_range u32 |

### 4.7 `DenoiseParams` — 32 bytes (uniform)

spatial/light/albedo/normal bandwidths (f32), half_search_window i32,
filter_strength f32, slice_count u32, pad u32.

### 4.8 `RasterPushConstant` — 64 bytes (uniform, group 2 binding 0, dynamic offset)

The push constant of `lm_raster.glsl` (std430). Note `atlas_size` is
**float2** here, unlike `BakeParameters.atlas_size` (int2). Writers:
`writeRasterPushConstant`; pinned by `test/structs.test.ts`.

| Offset | Field | Type |
|---|---|---|
| 0 | atlas_size | vec2⟨f32⟩ |
| 8 | uv_offset | vec2⟨f32⟩ (−0.5/atlas half-pixel quirk) |
| 16 | to_cell_size | vec3⟨f32⟩ |
| 28 | base_triangle | u32 |
| 32 | to_cell_offset | vec3⟨f32⟩ |
| 44 | bias | f32 |
| 48 | grid_size | vec3⟨i32⟩ |
| 60 | pad2 | u32 |

## 5. Canonical WGSL binding map

Mirrors `lm_common_inc.glsl` with the deltas called out (ADR-0005).

### group 0 — shared base set (all kernels)

| Binding | Resource | Notes |
|---|---|---|
| 0 | `BakeParameters` uniform | |
| 1 | `vertices` storage (read) | `Vertex[]` |
| 2 | `triangles` storage (read) | `Triangle[]` |
| 3 | `triangle_indices` storage (read) | `u32[]` |
| 4 | `lights` storage (read) | `Light[]` |
| 5 | `seams` storage (read) | `Seam[]` |
| 6 | `probes` storage (read) | `vec4[]` positions |
| 7 | `grid` texture_3d⟨u32⟩ | rg32uint, 128³; `textureLoad` |
| 8 | `albedo_tex` texture_2d_array⟨f32⟩ | rgba8unorm |
| 9 | `emission_tex` texture_2d_array⟨f32⟩ | rgba16float |
| 10 | `linear_sampler` sampler | |
| 11 | `area_light_sampler` sampler | clamp-to-edge |
| 12 | `cluster_data` storage (read) | **PORT:** merged `u32[] indices` then `u32[]`-viewed `ClusterAABB[]` (Godot uses two buffers at 12/13) |
| 13 | *(reserved)* | kept free for future base-set additions |

### group 1 — kernel I/O

Per kernel, mirroring Godot's set 1 (e.g. dilate: 0 = dest storage image,
1 = source texture array; primary adds 2–5 position/normal/accum/shadowmask,
6 area-light atlas). See each `lm_*.wgsl` header.

### group 2 — per-dispatch `Params`

Single binding 0: `Params` uniform with **dynamic offset** (256 B-aligned ring
buffer; ADR-0003). Render passes reuse it for their push constants
(`RasterPushConstant`, `RasterSeamsPushConstant` — same mechanism).

## 6. Outputs

- Lightmaps: per-slice `Uint16Array` (rgba16float), plus `meshRects` (slice,
  offset, scale in atlas UV terms) — directly consumable as WebGPU textures or
  convertible by `@lightmapper/io` to PNG (tonemapped) / EXR (HDR).
- Probes: positions + 9×3 SH coefficients per probe (Godot scales by
  `4 / ray_count` on the final chunk — preserve).
- Shadowmasks (optional): r8 per slice.

## 7. Naming & style

- Files `lowercase-dash`; WGSL `snake_case` matching GLSL; TS `camelCase`,
  exported types `Gpu*` for wire structs (`GpuVertex`, …).
- Keep Godot's function names in WGSL comments next to ports
  (`// trace_ray()` etc.) to make diffs against upstream reviewable.
