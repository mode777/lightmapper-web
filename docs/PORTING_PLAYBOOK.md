# Porting playbook

*The manual for porting Godot's lightmapper units into this repo — written for
AI agents and humans doing the porting. Read the relevant section **before**
touching a kernel or CPU function. The reference implementation is always the
Godot source at the pinned commit — never intuition.*

Reference checkout commands: `AGENTS.md § Godot reference source`.
Pinned commit: `67421f36e5069e62573c44beb8dd2f8f91e065b0` (master 2026-11-20;
4.5-stable has identical layout except `lm_area_lights_inc.glsl`).

---

## 1. Non-negotiable rules

1. **Fidelity.** Port behavior exactly, including quirks (mark `// GODOT-QUIRK:`).
   Improvements require an ADR *before* implementation.
2. **Provenance header.** Every ported file begins with upstream path, commit,
   license pointer. Copy the format from `packages/shaders/wgsl/lm_dilate.wgsl`.
3. **Float32 discipline.** Godot's floats are binary32. In TS: `Float32Array`
   storage; `Math.fround` for intermediates that matter (hashing, bias math,
   grid coordinates). Hashes always via `murmur3OneFloat` (it narrows).
4. **Wire format.** Struct layouts are frozen (DESIGN §4, ADR-0008). Do not
   reorder, do not repad.
5. **Scope.** One kernel / one CPU function per PR. No drive-by refactors of
   unrelated units.

## 2. Unit inventory & tracking

### 2.1 Shaders (WGSL ports)

| Target file | Godot source | Kernel | Workgroup | Difficulty | Gotchas |
|---|---|---|---|---|---|
| `lm_raster.wgsl` (+split variant) | `lm_raster.glsl` | gbuffer raster (vertex+fragment) | raster | M | **DONE (M2)** — split passes are two fragment entry points (ADR-0004 note); `dpdx/dpdy` for texel size; half-pixel uv_offset; `FA_SMOOTHEN_POSITION`; wireframe→edge expansion (ADR-0007); flat varyings; vertex pulling |
| `lm_blendseams_lines.wgsl` | `lm_blendseams.glsl#lines` | raster | raster | M | line-list; seams indexing (`seam_subidx` 0..3 pairing); push constants per draw |
| `lm_blendseams_triangles.wgsl` | `lm_blendseams.glsl#triangles` | raster | raster | E | z-mask draw; blend=0 |
| `lm_unocclude.wgsl` | `lm_compute.glsl#unocclude` | compute | 8×8 | M | **DONE (M2)** — read_write rgba32f storage images; `bias×10` quirk; store mask into unocclude.a→r |
| `lm_primary.wgsl` | `lm_compute.glsl#primary` | compute | 8×8 | H | `trace_ray` traversal (**already ported in `lm_trace_inc.wgsl`, M2** — bit-trick cluster/triangle masks, `firstTrailingBit`); hit-outside-cell rejection; front-face bias quirk; cull modes; `trace_direct_light` soft-shadow Vogel disk + penumbra early-inference; transparency chain; SH L1 accumulation variant; shadowmask variant |
| `lm_secondary.wgsl` | `lm_compute.glsl#secondary` | compute | 8×8 | H | `trace_indirect_light` full path loop; `depth -= 1` transparency juggling; Russian roulette; emission × albedo_alpha.a; `USE_LIGHT_TEXTURE_FOR_BOUNCES` define; env equirect mapping |
| `lm_light_probes.wgsl` | `lm_compute.glsl#light_probes` | compute | 64×1×1 | M | one invocation per probe; SH L2 table; accumulate across dispatches when `ray_from > 0`; final-chunk `×4/ray_count` |
| `lm_pack_l1.wgsl` | `lm_compute.glsl#pack_coeffs` | compute | 8×8 | E | divide-by-8L0 quirk; clamp + 0.5 |
| `lm_dilate.wgsl` | `lm_compute.glsl#dilate` | compute | 8×8 | E | **DONE — reference example** |
| `lm_denoise.wgsl` | `lm_compute.glsl#denoise` | compute | 8×8 | H | JNLM: verbatim constants; patch window 3; feature weights; SH 4-slice mode (`×4` L0 delta); region chunking (size/2 for SH); keep MIT attribution block |

(`lm_area_lights_inc.glsl` is master-only — port only with area-light support,
post-M6.)

### 2.2 CPU functions (TS ports into `packages/core`)

| Target module | Godot source (function) | Difficulty | Gotchas |
|---|---|---|---|
| `math/hash.ts` | `hashfuncs.h` | — | **DONE** (bit-exact, reference-vector tested) |
| `layout/structs.ts` | `lightmapper_rd.h` structs | — | **DONE** (offset-tested) |
| `atlas/pack.ts` | `_blit_meshes_into_atlas`, `Geometry2D::partial_pack_rects` | M | bruteforce size loop; `mem_used = w·h·slices` minimization; `+1` centering offset; padding scaling with supersampling |
| `accel/dedup.ts` | vertex dedup loop in `_create_acceleration_structures` | M | exact `vertexHash`; equality must compare all 8 floats; UV pre-transform `uv2 * uv_scale + uv_offset` happens *before* dedup |
| `accel/seams.ts` | edge/seam detection | M | `edgeHash` (no fmix); canonical edge ordering (`b < a` swap incl. normals & indices); `seam_found` guard; per-slice counts |
| `accel/grid.ts` | `_plot_triangle_into_triangle_index_list` | M | recursive 8-way; `triangle_box_overlap` port (core/math/geometry_3d.h — read it!); `cell_index = x + y·g + z·g²` |
| `accel/clusters.ts` | `_sort_triangle_clusters` | M | median split on longest axis; `next_pow2(count/2)` lower-bounded by cluster size; cluster indices layout for merged buffer (ADR-0005) |
| `accel/bounds.ts` | AABB merge/grow | E | grow by 0.1; include probe positions |
| `driver/*.ts` | `bake()` stage graph | H | M2 subset ✅ (`bakeGBuffer`: device/registry/params-ring/bind-groups + `stages/gbuffer.ts`, `readback.ts`); still to port with M3+: region/ray-chunk loops; texture ping-pongs (`SWAP`s); submit+await per region; probe buffer retrieval |
| `driver/readback.ts` | `texture_get_data` usage | M | 256 B row alignment; rgbah/rgba8 decode; per-slice staging buffers |
| `lights.ts` | `add_*_light` field packing | E | `size = tan(angular_distance)`; `inv_spot_attenuation = 1/attenuation`; area fields unused until post-M6 |
| `unwrap/index.ts` | `xatlas_unwrap/register_types.cpp` | E | watlas options: `fixWinding`, `padding 1`, `maxChartSize 4094`, `blockAlign`, `texelsPerUnit 1/texelSize`; normalize UVs by atlas dims; degenerate-triangle epsilon filter |

### 2.3 Engine helpers to port (as needed, into `core/src/math/`)

- `Geometry3D::triangle_box_overlap` (core/math/geometry_3d.h) — needed by
  grid plotting; port the exact SAT variant Godot uses.
- `AABB` ops used above (expand_to, merge_with, get_longest_axis_index,
  grow_by) — trivial; keep f32 semantics.
- `Math::next_power_of_2`, `nearest_power_of_2_templated`,
  `division_round_up` — one-liners.
- `SortArray` semantics: JS `Array.prototype.sort` is fine *only* where the
  comparator is a total order on the sorted key (it is, in our uses — key
  equality must preserve relative order only for `triangles.sort()` by slice;
  verify stability requirements case-by-case, prefer explicit stable sorts).

## 3. GLSL → WGSL cheat sheet

| GLSL | WGSL | Notes |
|---|---|---|
| `layout(local_size_x=8, local_size_y=8)` | `@compute @workgroup_size(8, 8)` | probes: `(64,1,1)` |
| `layout(set=s, binding=b)` | `@group(s) @binding(b)` | binding map: DESIGN §5 |
| push constants | group 2 binding 0 uniform + dynamic offset | ADR-0003; keep struct bytes identical |
| `gl_GlobalInvocationID.xy` | `@builtin(global_invocation_id) gid` | |
| `texelFetch(tex, ivec3(p, layer), 0)` | `textureLoad(tex, p, layer, 0)` | WGSL OOB → zero; keep explicit bounds checks where GLSL relied on them |
| `textureLod(sampler2DArray(t, s), uvw, 0)` | `textureSampleLevel(t, s, uv, layer, 0)` | |
| `imageLoad/Store(img, ivec3(p, layer))` | `textureLoad/Store(img, p, layer)` | storage textures; `read_write` access needs the format to support it (rgba16f/rgba32f do) |
| `findLSB(x)` | `firstTrailingBit(x)` | |
| `mix(a,b,t)` / `clamp` / `smoothstep` | `mix/clamp/smoothstep` | same |
| `dFdx/dFdy` | `dpdx/dpdy` | fragment only |
| `mod(x,y)` (GLSL = x − y·floor(x/y)) | `x % y` in WGSL is *truncated* — use `x - y * floor(x/y)` | not used in kernels AFAIK; double-check when porting |
| `uint`/`int` literal casts | `u32(...)`/`i32(...)`/`f32(...)` | |
| `bool` in buffers | `u32` (0/1) | GLSL std140 bools are 4 B anyway |
| `mat3(env_transform)` (mat3x4 → mat3) | `mat3x3f(env_transform)` implicit? — construct explicitly | check WGSL: `mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz)` |
| `flat out/in` | `@interpolate(flat)` | |
| `gl_VertexIndex` | `@builtin(vertex_index)` | |
| `gl_Position` | `@builtin(position)` out | |
| fragment `out vec4 x` | `@location(n) out` | |
| `#[versions]` defines | driver-side string substitution before `createShaderModule` | see §4.3 |
| reserved words (`type`, `size`, `range`, `filter`, …) | suffix `_` | `type_`, `size_`, `range_` |

Layout equivalence (why our bytes match): WGSL aligns `vec3<f32>` to 16 and
`vec2<f32>` to 8 exactly like std140/std430 for these struct shapes. Every
Godot vec3+scalar pair packs into one 16 B row. Keep new fields following the
same pattern and re-run the struct tests.

## 4. Porting procedure (per unit)

### 4.1 Shaders

1. Read the GLSL top-to-bottom, including comments (they encode intent and
   paper references — copy them).
2. Create `packages/shaders/wgsl/lm_<name>.wgsl` with the provenance header.
3. Translate mechanically via §3; keep function names and order identical
   (`trace_ray`, `trace_direct_light`, …) so diffs against upstream review.
4. Mark quirks `// GODOT-QUIRK:` and deviations `// PORT:`.
5. `npm run check:shaders` locally (or rely on CI) — must validate under naga
   with core capabilities.
6. Update the status table in `packages/shaders/README.md`.

### 4.2 CPU functions

1. Read the C++ incl. callees you must port alongside (§2.3).
2. Write TS with typed arrays; no classes where plain functions suffice.
3. Unit tests: bit-exact where deterministic (hashes, packing, layout);
   property tests where combinatorial (packing always fits, no overlap).
4. Where Godot depends on `HashMap` iteration order — it doesn't in the
   lightmapper's hot paths except *seam pairing stability*: seam detection
   iterates triangles in order and uses first-inserted edge wins; replicate
   with insertion-ordered maps (JS `Map` is insertion-ordered — good).

### 4.3 Define variants (`#[versions]` / `#VERSION_DEFINES`)

Godot compiles the same GLSL with `#define MODE_X` etc. We reproduce with a
tiny substitution utility in the driver:

```
// DEFS_BEGIN
// DEF:USE_SH_LIGHTMAPS
// DEFS_END
```

Driver scans `// DEF:<NAME>` markers and prepends `NAME=true|false` override
declarations. Keep the base file valid WGSL with `const USE_SH_LIGHTMAPS =
false;`-style defaults so naga validates the unsubstituted file. (Final
mechanism may evolve — if you change it, update this section + DESIGN §3.)

Shared *declarations* (not defines) take a different route: `#include
"name.wgsl"` snippets (`lm_common_inc.wgsl`, `lm_trace_inc.wgsl`) resolved
include-once by `@lightmapper/shaders` and `tools/wgsl-check` before
compilation — see DESIGN §3 and the shaders README.

### 4.4 Driver wiring

Kernels never touch WebGPU directly — the driver owns devices, buffers,
layouts, bind groups, dispatch loops and readback, mirroring the C++ `bake()`
flow stage by stage. When wiring a new kernel:

1. Add pipeline + bind group construction next to its siblings.
2. Wire the stage into the region/ray-chunk loops with progress fractions
   copied from Godot's `p_step_function` calls (they define the UX).
3. Respect ping-pong texture swaps (`SWAP(light_accum_tex, light_accum_tex2)`
   etc.) — these are load-bearing for denoise/dilate/pack ordering.

## 5. WebGPU-specific hazards (the §5 of the research report, expanded)

1. **G-buffer split pass** (ADR-0004): pass A {position, unocclude} 32 B,
   pass B {normal}. Two pipelines via define. Same clear values (0,0,0,0) and
   depth 1.0/0? — Godot clears color to 0 and depth 1.0 with compare `LESS`;
   replicate exactly (`depthClearValue: 1.0`).
2. **Params ring buffer**: 256 B-aligned slots (min uniform offset alignment);
   write with `queue.writeBuffer` at `slot * 256`; bind with dynamic offset.
3. **Dispatch ordering**: WebGPU executes dispatches in order within a pass —
   probe/accum read-modify-write across dispatches is safe. Textures used as
   read_write in the *same* pass are fine; do not alias dest/source.
4. **Readback**: `bytesPerRow` must be 256-aligned (`roundUp(width *
   bytesPerPixel, 256)`); copy per layer view into a staging buffer, `mapAsync`
   after `onSubmittedWorkDone`, strip padding.
5. **Storage textures**: bind as `TEXTURE_ATTACHMENT`? No — `STORAGE_BINDING |
   TEXTURE_BINDING` as needed; render-pass targets are separate texture views.
   Godot's `texture_create_shared_from_slice` → `texture.createView({
   dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })`.
6. **Blend state for seam pass**: color = {srcFactor:'src-alpha',
   dstFactor:'one-minus-src-alpha'} with alpha = {srcFactor:'zero',
   dstFactor:'one'} (matches Godot's override), on rgba16float.
7. **Depth format**: depth32float; `depthWriteEnabled: true`, compare 'less'.
8. **Vertex pulling**: reading storage buffers in the vertex stage is core —
   but keep an indexed-draw fallback path behind a capability flag.
9. **Texture usage transitions**: WebGPU computes usage per pass; a texture
   used as storage in one pass and sampled in the next needs both usages set
   at creation and views built per usage (`STORAGE_BINDING` view vs
   `TEXTURE_BINDING` view of the same GPUTexture).

## 6. Memory & performance notes

- Destroy stage targets as soon as their last consumer runs (raster targets
  after unocclude; source/dest light textures after final dilate) — improves
  on Godot which frees at the end.
- Keep dispatch loops chunked (R5); make `raysPerPass` adaptive: start at
  Godot's 4; on desktop adapters (no `powerPreference: 'low-power'`) default
  to 16–64 and reduce on `device.lost`/slow-region heuristics.
- Avoid `DataView` in hot loops after correctness is proven — swap in
  typed-array views during M6 polish only (keep behavior identical; tests
  guard this).

## 7. Golden testing against native Godot (on-demand)

1. Build a headless Godot (or use a desktop install) at the pinned commit;
   uncomment `#define DEBUG_TEXTURES` in `lightmapper_rd.cpp` — it saves
   numbered EXRs per stage (`0_albedo_*`, `1_position_*`, `2_light_primary_*`,
   `4_light_secondary_*`, `5_dilated_*`, `5_blendseams*`, `6_lightprobes.exr`)
   under `res://`.
2. Bake the fixture scene (same meshes/lights/options as the repo fixture,
   defined in `demos/cornell/src/fixture.ts` — keep it in lock-step).
3. Export the upload buffers too: add a temporary dump after
   `_create_acceleration_structures` (vertex/triangle/index/cluster/grid
   arrays) — byte-compare with our packed buffers (ADR-0008 makes this exact).
4. Store dumps out-of-band (git-ignored `golden/`), compare with a small
   script: max-abs-diff + RMSE thresholds per stage (suggest: buffers
   identical; EXRs RMSE < 1e-3 relative for pre-denoise stages, perceptual
   eyeball for final).
5. Never make golden dumps a CI gate (no GPU in CI — ADR-0011); run this when
   porting M2/M3/M5 or after risky changes.

## 8. Reviewer checklist (for humans reviewing agent PRs)

- [ ] Provenance header present and correct
- [ ] No struct/binding map drift (DESIGN §4/§5)
- [ ] Quirks marked, not silently "fixed"
- [ ] Float32 discipline maintained
- [ ] Tests added/extended for deterministic logic
- [ ] Roadmap checkbox + shader status table updated
- [ ] If demo-visible: PR body mentions what to verify on Pages
