# Extracting Godot's Lightmapper into a Standalone, Browser-Based (WebGPU) Package

**Research report — 2026-11-21**
Analyzed against Godot `master` @ `67421f36e5069e62573c44beb8dd2f8f91e065b0` (Nov 20, 2026)
and cross-checked against the `4.5` stable branch (same module layout; area lights are master/4.6-only).

---

## 1. TL;DR

**Verdict: very feasible, and far easier than it sounds — this is a port, not a rewrite.**

Godot's GPU lightmapper is an unusually good extraction candidate:

- Since 4.5 it lives in a **self-contained module** (`modules/lightmapper_rd/`, ~5,000 LOC total including shaders).
- It is **100% software ray tracing in compute shaders** (DDA grid traversal + triangle clusters). No hardware RT, no Vulkan ray queries, no vendor extensions — exactly the technique that ports cleanly to WebGPU compute.
- The bake already runs on a **private, locally-created RenderingDevice** — it never shares the engine's main renderer. In browser terms: "create your own `GPUDevice`". This was designed-in isolation.
- Its **input contract is already plain data**: per-mesh `positions / normals / uv2 / albedo-on-UV2 image / emission-on-UV2 image`, plus a light list and probe positions. No scene graph, no engine object model crosses the boundary (`scene/3d/lightmapper.h` defines the whole interface in 195 lines).
- The GPU API surface it consumes is tiny: **~35 distinct `RenderingDevice` calls** (buffer/texture create, compute lists, draw lists, submit/sync). Godot's `RenderingDevice` is 12,650 lines; you need none of it.
- The shaders use **no shared memory, no subgroup ops, no atomics, no recursion**; local sizes are 8×8 and 64×1×1 — comfortably inside even WebGPU's *compatibility profile* limits.

The real work is: (1) translating ~2,150 lines of GLSL to WGSL (mechanical, with a handful of documented gotchas), (2) re-implementing ~2,500 lines of CPU orchestration (atlas packing, accel-structure build, seam hashing, dispatch loop) in TypeScript, (3) replacing the two engine-side inputs the editor normally provides — **UV2 unwrapping** (use existing `watlas`/xatlas-wasm; Godot's glue is only ~240 lines) and **albedo/emission-on-UV2 rendering** (a small glTF-style raster pass).

**Estimate: ~2–3 weeks for a working spike; ~8–14 weeks for a production-quality, validated npm package.** Recommended shape: TypeScript + WGSL core (`lightmapper-web`), `watlas` for charting/packing, optional wasm module for the accel-structure build on huge meshes.

---

## 2. What the Godot lightmapper actually is

### 2.1 Pipeline stages (`LightmapperRD::bake`, `lightmapper_rd.cpp`)

| # | Stage | Where | Notes |
|---|-------|-------|-------|
| 0 | Atlas layout | CPU | Bruteforce rectangle packing over power-of-2 sizes to minimize `w·h·slices`; uses `Geometry2D::partial_pack_rects`. Padding = max(2, denoiser_range)×supersampling. |
| 1 | Blit albedo/emission | CPU | Copies each mesh's pre-rendered `albedo_on_uv2` (rgba8) and `emission_on_uv2` (rgbah) images into the atlas slices. |
| 2 | Acceleration structure | CPU | Vertex dedup (hash of pos+uv2+normal), seam detection (edge hashing), triangle list sorted by slice; uniform 128³ grid where each cell → triangle-count + index into "clusters" of 16 triangles with AABBs (median-split). Uploaded as storage buffers + one `rg32uint` **3D texture**. |
| 3 | G-buffer raster | GPU (raster) | Renders triangles *in UV2 space* to `position` (rgba32f), `normal` (rgbah), `unocclude` (rgba32f: face normal + world-space texel size) + depth32. Two pipelines: fill + **wireframe** (conservative-rasterization trick to catch edge texels — from ndotl's "baking artifact-free lightmaps"). |
| 4 | Un-occlude | GPU (compute 8×8) | Pushes texel positions out of occlusion along 4 tangents (ray-traced against the grid). |
| 5 | Direct light | GPU (compute 8×8) | Per texel, per light: shadow rays with Halton-disk AA over the texel, Vogel-disk soft shadows for light size, transparency continuation via albedo alpha, optional SH L1 (4-slice directional lightmaps), optional shadowmask output. Region-chunked (512px) with submit+sync per region to dodge GPU watchdog. |
| 6 | Indirect light | GPU (compute 8×8) | Cosine-weighted hemisphere rays, `ray_count` (32/128/512/2048 by quality) split into passes of `max_rays_per_pass` (4), full path tracing with Russian-roulette termination, emission gathering, env-map (equirect panorama) miss color, `bounces` depth. Accumulates additively into `accum_light` across dispatches. |
| 7 | Light probes | GPU (compute 64) | One invocation per probe; uniform-sphere rays through the same `trace_indirect_light`; accumulates SH L2 (9 coefficients × rgb) into a storage buffer across ray-chunk dispatches. |
| 8 | Pack L1 | GPU (compute) | (SH mode) folds L0/L1 ratio into 4 storable slices. |
| 9 | Denoise | GPU (compute) | **JNLM** (joint non-local means) denoiser — patch/search windows over light + albedo + normal + occlusion features. (An external-OIDN path exists too; irrelevant for browser.) |
| 10 | Dilate | GPU (compute) | 8-direction dilation to fill padding. |
| 11 | Blend seams | GPU (raster) | Line pass copies across seam edges (from the seam buffer built on CPU), triangle pass fills z-buffer as a mask, second line pass blends surroundings. Custom alpha blend on rgbah. |
| 12 | Readback | CPU→ | `texture_get_data` per slice → images; probe buffer read → SH values. |

Quality/feature inputs map 1:1 to the bake signature: quality (ray count), bounces, bounce_indirect_energy, bias, max texture size, bake_sh, bake_shadowmask, texture_for_bounces, supersampling, exposure normalization, env panorama + transform, denoiser strength/range, probe generation.

### 2.2 Source inventory

| File | LOC | Role |
|------|-----|------|
| `modules/lightmapper_rd/lightmapper_rd.cpp` | 2,511 | Orchestration + accel structure + all GPU calls |
| `modules/lightmapper_rd/lightmapper_rd.h` | 332 | Data structures (mirrored in shaders) |
| `modules/lightmapper_rd/lm_compute.glsl` | 1,348 | 7 kernels via `#[versions]`: `primary`, `secondary`, `unocclude`, `light_probes`, `dilate`, `denoise`, `pack_coeffs` |
| `modules/lightmapper_rd/lm_raster.glsl` | 167 | G-buffer vertex/fragment (+ wireframe variant) |
| `modules/lightmapper_rd/lm_blendseams.glsl` | 108 | Seam-blend raster (lines + triangles) |
| `modules/lightmapper_rd/lm_common_inc.glsl` | 137 | Bindings + structs (byte layouts) |
| `modules/lightmapper_rd/lm_area_lights_inc.glsl` | 398 | LTC area-light evaluation (master only; 4.5 lacks it) |
| `scene/3d/lightmapper.h` | 195 | Public interface (`MeshData`, light/probe adders, `bake()`) |
| `modules/xatlas_unwrap/register_types.cpp` | 243 | Godot's entire xatlas glue (chart/pack options + cache) |
| `thirdparty/xatlas/xatlas.cpp` | 10,044 | Unmodified upstream xatlas (no Godot patches found) |
| `scene/3d/lightmap_gi.cpp` | ~1,400 | *Engine-side* driver: collects meshes/lights, calls `bake_render_uv2` to produce albedo/emission images, stores results |

### 2.3 What is *not* inside the module (the only engine coupling)

1. **`RenderingDevice`** — but a dedicated local instance, and only ~35 calls of it (§4.3).
2. **`Image`** — used as a byte container; trivially replaced by `TypedArray` + `{width,height,format}`.
3. **`bake_render_uv2()`** — engine-side rasterization of each mesh's materials into `albedo_on_uv2` / `emission_on_uv2` (this is where BaseMaterial3D, textures, UV0→UV2 projection happen). **The lightmapper itself only consumes the resulting images.** A standalone package replaces this with a small raster pass or user-supplied textures.
4. **UV2 unwrapping** — `modules/xatlas_unwrap` (240 lines of glue around vanilla xatlas: `fixWinding=true`, `padding=1`, `maxChartSize=4094`, `blockAlign=true`, `texelsPerUnit=1/texel_size`).
5. Misc core types: `Vector`, `LocalVector`, `HashMap`, `AABB`, `Geometry2D/3D` helpers, `SortArray` — all standard, portable logic.
6. Engine config: quality presets / region size / rays-per-pass are project settings with defaults registered in `register_types.cpp` (§6.2) — just constants for us.

Note: Godot's **web export cannot run this today** — the web build uses the GL compatibility renderer, `create_local_rendering_device()` returns null, and the Vulkan/Metal fallback paths are desktop-only. Extraction is the only route.

---

## 3. WebGPU capability audit (exact, vs. spec)

Core limits from the WebGPU CR draft (Nov 2026, §3.6.2) — "compat" = the new compatibility tier where shown:

| Requirement of the lightmapper | WebGPU core | Compat tier | Verdict |
|---|---|---|---|
| Atlas 2D textures ≤ 8192 | 8192 | 4096 | ✓ (cap user atlas at 4096 for compat devices) |
| 2D array layers = atlas slices (small) | 256 | 256 | ✓ |
| Grid 3D texture `rg32uint` 128³, `textureLoad` | 2048 max dim | — | ✓ |
| Compute local size 8×8, 64×1×1 | 256 invocations | 128 | ✓ (both tiers) |
| Workgroup shared memory | **not used** | 16 KB core | ✓ (nothing to port) |
| Storage images `rgba32f`, `rgba16f`, `rgba8` (incl. read_write) | core plain formats | — | ✓ (see risk R4 for `read_write` fallback) |
| Depth32float render target | core | — | ✓ |
| Blending on `rgba16float` (seam pass) | core | — | ✓ |
| Dispatch counts (regions ÷ 8) ≤ 512 | 65,535/dim | — | ✓ |
| **G-buffer attachments = 3×16 B + depth = 48 B/sample** | **maxColorAttachmentBytesPerSample = 32** | 32 | ✗ → **must split into two render passes** (see §5.1) |
| Set-0 storage buffers = 8 (+1 for probes in set 1 = 9) | maxStorageBuffersPerShaderStage = 8 | 8 | ✗ on minimum devices → merge 2 buffers or split bind groups (§5.2) |
| Env panorama `rgba32f` sampled **bilinearly** | needs `float32-filterable` | — | ✗ core → convert panorama to rgba16f (or request feature when available) |
| Vertex-pulling from storage buffer in vertex stage | core (now has explicit vertex-stage storage limits) | — | ✓ (fallback: real vertex buffers, trivial) |
| Push constants (32–48 B per dispatch/draw) | **not in WebGPU** | — | → dynamic-offset uniform buffers (§5.3) |
| `findLSB`, `texelFetch`, `textureLod`, `dFdx/dFdy` | `firstTrailingBit`, `textureLoad`, `textureSampleLevel`, `dpdx/dpdy` | — | ✓ |
| Wireframe (fill-mode) pipeline for edge texels | **no wireframe in WebGPU** | — | → emulate (§5.4) |
| Float32 storage buffers (vertex/triangle/etc.) | 128 MiB binding default, 256 MiB maxBufferSize | — | ✓ for typical scenes; raise limits for huge ones |
| Compute dispatches that run minutes | browser watchdogs / `_device.lost` | — | → keep Godot's region+sync design (§5.5) |

Struct layout bonus: the GPU structs (`Vertex` 32 B, `Triangle` 48 B, `Light` 128 B, `ClusterAABB` 32 B, `BakeParameters`) pack to identical byte offsets under WGSL alignment rules if declared naturally (vec3+scalar pairs). **You can keep the wire format byte-compatible with Godot** — invaluable for golden-testing the browser port against native dumps.

---

## 4. Port mechanics

### 4.1 Shaders (the crown jewels — translate, don't redesign)

~2,150 GLSL lines total. The translation is mechanical:

| GLSL | WGSL |
|---|---|
| `#[versions]` `#define MODE_X` variants | preprocessor step (string replace) or one WGSL file per mode with `const` switches — recommend per-mode files or `overrides` in build |
| `layout(set=0/1, binding=n)` | `@group(n) @binding(n)` |
| `texelFetch(tex, ivec3, 0)` | `textureLoad(tex, coords, 0)` (add explicit clamps where shaders rely on GLSL's return-zero OOB) |
| `textureLod(sampler2DArray(...))` | `textureSampleLevel(tex_2d_array<f32>, samp, uv, arrayIndex, 0)` |
| `imageLoad/imageStore` on arrays | `textureLoad`/`textureStore` on `texture_storage_2d_array<fmt, read_write>` |
| `findLSB(mask)` | `firstTrailingBit(mask)` |
| push constants | small uniform buffer w/ dynamic offset (256 B alignment) |
| `mat3x4` env transform | `mat3x4f` (keep byte layout) |
| `dFdx/dFdy` in raster | `dpdx/dpdy` |
| `bool` in UBO | `u32` |

Suggested strategy: **bootstrap with `naga`** (GLSL 440 compute in → WGSL out, Vulkan-style bindings supported) to get a compiling baseline fast, then hand-clean per mode. Budget 1.5–3 weeks including validation. The JNLM denoiser (largest kernel, ~180 lines) is the most iteration-sensitive — port it verbatim.

### 4.2 CPU side (re-implementation, not translation)

Everything is simple, allocation-light logic that ports naturally to TypeScript with `TypedArray`s:

- Atlas packing: port `partial_pack_rects` (a max-rects-style packer, ~150 lines) or use a JS shelf/max-rects packer and keep the bruteforce-size loop.
- Accel structure: vertex dedup + seam hashing (port `hash_murmur3_one_float` / `hash_fmix32` **bit-exactly** — bitcast floats via `Float32Array`/`Uint32Array` views; this preserves Godot's seam grouping), grid plotting (recursive 8-way subdivision with `triangle_box_overlap`), cluster median-split + sorts. ~600–800 lines of TS. Runs in a Web Worker; optional wasm port later if profiling demands.
- Bake driver: mirrors `bake()` — resource creation, the region/ray-chunk dispatch loops, swap/ping-pong of accum textures, readback, probe buffer retrieval. ~600 lines of TS.

### 4.3 GPU API surface actually used (measured)

```
texture_create(14)  free_rid(40)  compute_list_{begin,end,dispatch,bind_*,set_push_constant}
draw_list_{begin,end,draw,bind_*,set_push_constant}  uniform_set_create  shader_create_from_spirv
compute_pipeline_create  render_pipeline_create  framebuffer_{create,get_format}
storage_buffer_create  uniform_buffer_create  buffer_update  buffer_get_data
texture_{clear,copy,update,get_data,create_shared_from_slice}  sampler_create
submit  sync  limit_get  initialize
```
That's the entire abstraction you must provide over `GPUDevice`/`GPUQueue`. (An Emscripten + `webgpu.h` C++ shim of just these ~35 calls is the fallback architecture, §7-B.)

---

## 5. Required adaptations (the honest gotcha list)

1. **Split the G-buffer render pass.** Godot renders position(rgba32f) + normal(rgbah) + unocclude(rgba32f) = 48 B/sample; WebGPU caps at 32 B. Split into pass A {position, unocclude} (32 B) and pass B {normal} — two pipeline variants via a define, negligible cost. (Verify whether your target browsers accept a raised `maxColorAttachmentBytesPerSample` at `requestDevice`; design for 32 regardless.)
2. **9 storage buffers in probe mode vs. core 8.** Merge `seams` + `probe_positions` into one buffer (or move probes to group 2). Trivial, but do it from day one so minimum-spec devices work. (Most real adapters grant >8, but core guarantees only 8.)
3. **Push constants → dynamic uniform buffers.** Keep one 256 B-aligned ring buffer per frame; `setPushConstants` becomes `writeBuffer` + `setBindGroup(..., dynamicOffset)`. Alternatively per-dispatch uniform buffers (dispatch count is modest).
4. **No wireframe fill mode.** The wire pass exists to cover texels the fill rasterization misses at triangle edges (artifact-free lightmaps). Emulations, in order of fidelity: (a) render an edge-expanded triangle per triangle (push vertices outward from the UV centroid by ~1 texel — closest to intent, cheap in the vertex shader), (b) `line-list` topology over edges (1 px, acceptable), (c) skip and rely on dilate (degrades edge quality). **Plan (a) + validate against native.**
5. **Keep the region + await pattern.** Godot already submits/syncs per 512² region to avoid GPU-TDR. In the browser this maps perfectly: one command buffer per region, `await device.queue.onSubmittedWorkDone()`, report progress, check cancellation. This also yields to the event loop — required to keep the tab alive. Consider raising `max_rays_per_pass` (Godot default is only 4) on desktop-class adapters to cut dispatch count; make it adaptive.
6. **Env panorama filtering.** Convert to rgba16f at upload (default), or request `float32-filterable` when present. Document the precision trade.
7. **`read_write` storage textures** are used by `unocclude` and bounce-accumulation (load-modify-store in one kernel). Core WebGPU supports `read_write` on plain formats — but keep a ping-pong fallback in your abstraction in case a target driver objects.
8. **Readback discipline.** `copyTextureToBuffer` per slice with 256 B `bytesPerRow` padding; unpad in JS. Output Float16 lightmaps directly (data is rgbah anyway) + tone-mapped PNG via canvas; optional EXR writer.
9. **fp32 semantics in JS.** All CPU math that feeds hashes/UBOs must stay f32 (`Math.fround`, `Float32Array`) or seam detection and bias handling will drift from native behavior.
10. **Memory headroom.** Rough VRAM per atlas texel × slice: albedo 4 B + emission 8 B + position 16 B + normal 8 B + unocclude 16 B + source/accum/dest rgbah ×(2–3, ×4 if SH) + shadowmask 4 B ≈ **70–100 B/texel**. A 2048² single-slice bake ≈ 300–420 MB — fine on desktop, heavy on mobile. Cap defaults (1024–2048), expose atlas size and SH explicitly, free raster targets before the trace phase (Godot frees nothing mid-bake — you can do better with explicit `destroy()`).
11. **No canvas needed.** The whole thing runs offscreen (compute + offscreen render passes). A demo viewer is a separate concern.

---

## 6. Proposed package architecture

### 6.1 Recommendation: TypeScript + WGSL core, wasm leaves

```
lightmapper-web/
├── packages/
│   ├── core/          # orchestrator: atlas pack, dispatch loops, readback, API
│   ├── shaders/       # WGSL ports (per-mode files + shared common.wgsl)
│   ├── accel/         # vertex dedup, seam hash, grid+cluster build (Web Worker)
│   ├── gbuffer/       # albedo/emission-on-UV2 raster pass from glTF-ish materials
│   │                  #   (albedo×(1−metallic), alpha, emission; the same
│   │                  #    contract Godot's bake_render_uv2 produces)
│   ├── unwrap/        # watlas (xatlas-wasm) wrapper with Godot presets
│   ├── io/            # glTF in; Float16/PNG/EXR out; three.js/WebGPU adapter
│   └── adapters/      # three.js (WebGPURenderer + WebGLRenderer) helpers
└── apps/demo/         # cornell-box style playground + golden-image tests
```

Dependencies: `watlas` (MIT, maintained; near-native xatlas API — used by gltf-transform). Everything else is dependency-free.

### 6.2 API sketch (mirrors Godot's `Lightmapper` interface)

```ts
const baker = new Lightmapper();                    // own GPUDevice (compute+raster, offscreen)

const scene = new BakeScene();
scene.addMesh({
  positions: Float32Array, normals: Float32Array,
  indices: Uint32Array,
  uv2?: Vec2[],                                     // optional; auto-unwrapped via xatlas if omitted
  albedoOnUv2:  { width, height, data /*rgba8*/  }, // or let gbuffer pass render it from materials
  emissionOnUv2:{ width, height, data /*rgbah*/ },
});
scene.addDirectionalLight({ direction, color, energy, angularSize, shadowBlur, bake: 'static' });
scene.addOmniLight({ position, color, energy, range, attenuation, size, ... });
scene.addSpotLight({ ... });
scene.setEnvironment({ panorama: ImageBitmap|Float32Array, rotation });   // equirect
scene.addProbe([x,y,z]);  // or scene.generateProbes('subdiv_8')

const result = await baker.bake(scene, {
  quality: 'high',            // rayCount 32/128/512/2048 — Godot's presets
  bounces: 3, bounceIndirectEnergy: 1, bias: 0.01,
  atlasMaxSize: 2048, supersampling: 1,
  denoise: { strength: 1, range: 8 },   // JNLM; {enabled:false} to skip
  bakeDirectionalSH: false, bakeShadowmask: false,
  onProgress: (fraction, msg) => keepGoing /* return false to cancel */,
});
// result.lightmaps : { width, height, slices, data: Uint16Array (rgbah) }[]
// result.meshRects : [{ slice, offset, scale }] per input mesh
// result.probes    : { positions: Float32Array, sh9: Float32Array } | null
// result.shadowmasks? : per-slice r8
```

Progress callbacks and cancellation map directly onto the region-chunked dispatch loop (§5.5). Bake runs across `await` points — the UI never freezes.

### 6.3 xatlas: include it

Yes — include xatlas in the architecture (via `watlas`):
- UV2 unwrap is mandatory for arbitrary input; expecting pre-unwrapped meshes kills usability.
- Godot's glue is 240 lines of options + cache — reproduce options exactly (`fixWinding`, `padding=1`, `blockAlign`, `maxChartSize=4094`, `texelsPerUnit=1/texelSize`) and you get chart layout parity with Godot.
- `watlas` exposes chart/pack phases separately, which also enables the "repack at different texel density" workflow Godot's cache supports.
- Godot's vendored xatlas is unpatched upstream, so watlas is a drop-in equivalent (both MIT).

---

## 7. Alternative architectures (considered)

**A. TypeScript + WGSL (recommended).** Port shaders to WGSL, re-implement orchestration in TS. *Pros:* web-native debugging, no wasm toolchain, tree-shakeable, easiest API surface for three.js/Babylon adapters, workers for free. *Cons:* accel-structure build is JS-speed (mitigate: worker + typed arrays; wasm leaf later). The engine coupling is small enough that you lose almost nothing by not reusing the C++.

**B. C++ extraction + Emscripten + `webgpu.h`.** Copy `lightmapper_rd.cpp`, write a ~1.5–2 kLOC mini-RD shim implementing the 35 calls over WebGPU, port engine containers (`LocalVector`, `HashMap`, `AABB`) — mostly mechanical — and translate GLSL→WGSL with `naga` at build time (Emscripten's WebGPU takes WGSL, not SPIR-V). *Pros:* maximum fidelity to upstream, easy diff-tracking of future Godot changes. *Cons:* wasm toolchain in the loop, harder to debug, shims forever, pthreads need COOP/COEP if you want threaded BVH. Choose this if bit-exact parity with Godot is the top priority.

**C. Rust + wgpu compiled to wasm.** Rewrite orchestration in Rust; `naga` ingests the GLSL compute nearly verbatim. *Pros:* safest translation story for shaders, one language, mature WebGPU backend. *Cons:* the C++ still isn't directly reusable (it's C++, not Rust), and the npm-facing API needs a wasm-bindgen layer; you inherit wasm sizes (~1–2 MB) and a Rust toolchain for all contributors.

**Rejected:** running Godot itself in a web export (compat renderer only — the RD lightmapper cannot run there, which is the whole problem); building a new path tracer from scratch (discards a tuned, artifact-hardened pipeline — seam blending, un-occlusion, texel AA and JNLM encode years of bugfixes); full `RenderingDevice` port (12.6 kLOC for 35 calls).

---

## 8. Validation plan

1. **Byte-level parity for CPU structures.** With the wire-format-compatible structs (§3), feed identical mesh data to a small native harness (build `lightmapper_rd.cpp` standalone with a null-device stub, or instrument Godot) and to the TS port; diff vertex/triangle/cluster/grid buffers.
2. **Stage-by-stage golden images.** Godot has a built-in `#define DEBUG_TEXTURES` that dumps every intermediate (position/normal/unocclude/direct/bounce/denoised/dilated/seams) as EXR. Run it natively (verification box or any Vulkan-capable machine — note: the container's llvmpipe may need lavapipe/mesa-vulkan present; check before relying on it), then dump the same stages from the browser port and compare with per-channel RMSE + a perceptual threshold. This catches translation drift in the denoiser and seam passes immediately.
3. **Browser headless CI.** `chrome-headless-shell` with `--headless=new --no-sandbox --enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader --enable-features=Vulkan --disable-vulkan-surface` gives CPU-rendered WebGPU for correctness tests (slow but deterministic-ish); use Dawn's `dawn-node` for a non-browser WebGPU in Node if preferred. Hardware-dependent quality checks stay on real GPUs.
4. **Scene suite.** Cornell box (indirect + color bleeding), sun+shadowmask scene, soft-shadow penumbra scene, transparent-curtain scene, seam-heavy unwrapped mesh, SH directional mode, probe grid vs. reference.
5. **Watchdog soak test.** 4096² ultra-quality bake on mid-range hardware; assert no device loss, cancellation works mid-bake.

---

## 9. Risks & mitigations

| # | Risk | Likelihood | Mitigation |
|---|------|-----------|------------|
| R1 | Shader translation drift (denoiser/seams) | Medium | naga bootstrap + hand port; golden-image suite (§8.2) |
| R2 | Edge-texel artifacts from missing wireframe pass | Medium | Edge-expansion emulation (§5.4); validate on seam-heavy meshes |
| R3 | Mobile/tile-GPU memory pressure | High if targeted | Default atlas caps, destroy raster targets pre-trace, expose quality presets, docs |
| R4 | `read_write` storage texture gaps on some drivers | Low | Ping-pong fallback behind abstraction |
| R5 | Browser GPU watchdog kills long traces | Medium | Keep region+await pattern (already Godot's design); adaptive region size |
| R6 | `float32-filterable` absence | Certain (core) | rgbah panorama default (§5.6) |
| R7 | Storage-buffer slot count on min-spec | Low | Buffer merge from day one (§5.2) |
| R8 | TS accel-build perf on multi-million-tri scenes | Medium | Worker pool; optional wasm leaf reusing Godot's C++ verbatim |
| R9 | Upstream drift (area lights landed in master; 4.6 will evolve) | Certain over time | Port from 4.5-stable layout first (area lights optional add-on); keep a mapping doc file↔package |
| R10 | Safari/iOS WebGPU quirks | Medium | Capability probe + WebGL2 path via interop (e.g., delegate to a WebGL baker for legacy) or graceful refusal |

---

## 10. Prior-art landscape (positioning)

| Project | Approach | Gap vs. this proposal |
|---|---|---|
| **three-lightmap-baker / lightmap-baker** (Ibrahim-3d) | WebGL2-only three.js baker, path-traced GI, BVH, AO, denoise | Explicitly does not target WebGPU/headless/next-gen backend — the README leaves that niche open |
| **67.js `light-bake`** (codepawl) | three.js WebGPU addon lightmap baking | In-ecosystem, not a general-purpose Godot-parity pipeline |
| **Babylon.js path-traced lightmapper** (community) | C++/WASM baker for Babylon scenes | WASM, Babylon-centric, not a reusable GPU pipeline |
| **PlayCanvas lightmapper** | WebGL2 fragment-shader ray tracing, editor-baked | Fragment-shader (pre-compute-shader) design; closed ecosystem |
| **watlas** (toji) | xatlas→wasm, native-like API | The UV building block this package should consume, not compete with |
| **WebGPU samples / path tracers** (cornell-box compute RT, etc.) | Toy renderers | No lightmap-specific machinery (atlas, seams, un-occlusion, JNLM, probes) |

No existing project ships a browser-native, WebGPU-compute lightmapper with Godot's feature set (atlas slices, SH lightmaps, probes, shadowmask, seam blending, denoising, area lights). The niche is genuinely open, and Godot's implementation is the most extraction-ready of the open-source lightmappers.

---

## 11. Licensing

- Godot (`modules/lightmapper_rd`, `scene/3d/lightmapper.*`): **MIT** — keep copyright headers in ported files, add a NOTICE entry.
- JNLM denoiser kernel: **MIT** (ManuelPrandini/YoctoImageDenoiser) — already attributed in `lm_compute.glsl`; preserve.
- xatlas & watlas: **MIT**. Everything composes into an MIT package with no copyleft contamination.

---

## 12. Suggested roadmap

| Phase | Duration | Deliverable |
|---|---|---|
| 0. Spike | 2–3 wk | Direct+1-bounce directional/omni bake on a hand-unwrapped mesh; rgbah output; no denoise/seams; proves WGSL trace kernel + region loop |
| 1. Parity core | 3–4 wk | Full kernel set incl. bounces, probes, dilate, JNLM, seam blending; xatlas integration; golden harness running |
| 2. Productization | 2–3 wk | glTF input + gbuffer material pass, three.js adapter, progress/cancel API, memory tuning, docs |
| 3. Hardening | 1–2 wk | CI (headless WebGPU), mobile presets, edge-case suite (degenerate geometry, empty lights), packaging |
| 4. Optional | — | Area lights (master-only feature), shadowmask mode, wasm accel leaf, OIDN-style external denoiser hook |

Total to production quality: **~8–14 focused weeks**.
