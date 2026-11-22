# Architecture

*Last updated: 2026-11-22 (M1 done). Keep this document current with reality.*

## 1. Mission & non-goals

**Mission:** a standalone, MIT-licensed, browser-native package that bakes
lightmap atlases and light probes on the GPU via WebGPU, feature-parity with
Godot 4.5's RD lightmapper for the features that matter on the web.

**Non-goals:**

- being a renderer (we only *bake*; consuming the lightmaps is the app's job),
- hardware ray tracing (Godot's lightmapper doesn't use it either),
- running inside a Godot web export (impossible by design; that's why this repo exists),
- a CPU/WebGL2 fallback path (may be delegated to other packages via adapters later),
- exhaustive e2e/browser test automation (visual verification via Pages instead — see `ROADMAP.md §Verification`).

## 2. System shape

```
                        ┌──────────────────────────────────────────────────────────┐
                        │                      Browser (main thread)               │
                        │                                                          │
  glTF / raw buffers ──▶│  BakeScene (packages/core)                               │
  meshes, lights,       │   ├── MeshInput: positions/normals/uv2/indices           │
  probes, environment   │   │     + albedoOnUv2 / emissionOnUv2 images             │
                        │   │     (rendered by packages/gbuffer or user-supplied)  │
                        │   ├── LightInput[] (directional/omni/spot[/area])        │
                        │   ├── ProbeInput[] / generateProbes(subdiv)              │
                        │   └── Environment (equirect panorama + rotation)         │
                        │                                                          │
                        │  unwrap (packages/unwrap → watlas/xatlas-wasm, worker)   │
                        │   └── uv2 = chart+pack(positions, texelSize)             │
                        │                                                          │
                        │  accel (packages/core/src/accel, Web Worker)             │
                        │   ├── vertex dedup (murmur3 float hash — bit-exact)      │
                        │   ├── seam detection (edge hash)                         │
                        │   ├── 128³ grid plotting + 16-tri clusters (AABBs)       │
                        │   └── outputs byte-exact Godot-compatible buffers        │
                        │                                                          │
                        │  atlas packer (packages/core)                             │
                        │   └── bruteforce power-of-2 rect packing → size/slices    │
                        │                                                          │
                        │  bake driver (packages/core/src/driver)                   │
                        │   ├── owns a private GPUDevice (no canvas needed)         │
                        │   ├── stage graph: raster → unocclude → primary →        │
                        │   │   secondary → probes → packL1 → denoise → dilate →   │
                        │   │   blendseams → readback                              │
                        │   ├── region-chunked dispatches, await onSubmitted…()     │
                        │   └── progress / cancellation callbacks                   │
                        │                                                          │
                        │  result → packages/io (rgbah arrays, PNG, EXR)           │
                        │           → packages/adapters (three.js …)               │
                        └──────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                        WGSL kernels (packages/shaders, group 0/1/2 binding map)
```

## 3. Package responsibilities

| Package | Responsibility | Milestone |
|---|---|---|
| `@lightmapper/core` | Scene model, atlas packing, acceleration structure, struct packing, bake driver, GPU resource management | M1–M5 |
| `@lightmapper/shaders` | WGSL kernels + shared struct declarations; consumed as source strings | M2–M5 |
| `@lightmapper/unwrap` | watlas wrapper with Godot's chart/pack presets | M1 |
| `@lightmapper/gbuffer` | Rasterizes albedo/emission-on-UV2 from glTF-ish materials (replaces Godot's `bake_render_uv2`) | M2 |
| `@lightmapper/io` | glTF input, rgbah/PNG/EXR output, Float16 helpers | M6 (input earlier if needed) |
| `@lightmapper/adapters` | three.js integration helpers | M6 |
| `tools/wgsl-check` | naga validation of all `.wgsl` (CI gate) | M0 ✅ |
| `demos/cornell` | The GitHub Pages demo | M0 (shell) ✅ → M6 (bake) |

## 4. Bake pipeline (port of `LightmapperRD::bake`)

Stage-by-stage mapping from Godot's `lightmapper_rd.cpp` to this repo:

| # | Godot stage | Port lives in | GPU work | Notes / deltas |
|---|---|---|---|---|
| 0 | atlas layout bruteforce | `core/src/atlas/pack.ts` | — | port `Geometry2D::partial_pack_rects` semantics; padding = `max(2, denoiserRange) × supersampling` |
| 1 | blit albedo/emission | `core/src/atlas/blit.ts` | copy | typed-array blits, rgbah emission |
| 2 | acceleration structure | `core/src/accel/*` (worker) | — | byte-exact buffers; cluster indices+AABBs merged into **one** buffer (ADR-0005) |
| 3 | G-buffer raster (UV2 space) | `core/src/driver/stages/gbuffer.ts` + `lm_raster.wgsl` | render | **split into two passes** (48 B/sample > WebGPU 32 B cap, ADR-0004); wireframe pass replaced by edge-expansion (ADR-0007) |
| 4 | un-occlude | `lm_unocclude.wgsl` | compute 8×8 | read_write storage textures; ping-pong fallback documented |
| 5 | direct light | `lm_primary.wgsl` | compute 8×8 | Halton AA, Vogel soft shadows, transparency via albedo alpha, optional SH/`shadowmask` variants via `PORT:` defines |
| 6 | indirect light | `lm_secondary.wgsl` | compute 8×8 | ray-chunked accumulation; env panorama sampled as **rgba16f** (ADR-0006) |
| 7 | light probes | `lm_light_probes.wgsl` | compute 64×1 | SH L2 accumulation across dispatches |
| 8 | pack L1 | `lm_pack_l1.wgsl` | compute 8×8 | SH mode only |
| 9 | JNLM denoise | `lm_denoise.wgsl` | compute 8×8 | port verbatim incl. MIT attribution block |
| 10 | dilate | `lm_dilate.wgsl` ✅ | compute 8×8 | ported (reference kernel) |
| 11 | seam blend | `lm_blendseams_*.wgsl` | render | line-list + triangle passes, alpha blend on rgbah |
| 12 | readback | `core/src/driver/readback.ts` | copy | 256 B row padding, per-slice staging |

## 5. Execution model

- **Private device.** The driver creates its own `GPUDevice` (compute + raster,
  offscreen; no canvas is required). Mirrors Godot's *local rendering device*.
- **Region-chunked dispatches.** Godot submits+syncs per ≤512² region to avoid
  GPU watchdog resets; we keep the chunking but `await
  device.queue.onSubmittedWorkDone()` instead of blocking (ADR-0009). This
  yields to the event loop, feeds progress callbacks and enables cancellation
  between regions.
- **Ray chunking.** Secondary/probe passes split ray counts into chunks
  (Godot default 4 / 64). We keep the defaults and allow raising them on
  desktop-class adapters (fewer dispatches, same result — accumulation order
  changes are acceptable and documented).
- **Workers.** The acceleration-structure build is pure CPU (sorts, hashing,
  recursion) and runs in a Web Worker with transferable typed arrays. The bake
  driver stays on the main thread (it is I/O-bound around GPU submissions).
- **Memory.** Targets are destroyed as soon as their last consumer completes
  (improvement over Godot, which frees everything at the end). ~70–100 bytes
  per atlas texel × slice; see RISKS.md R3 for the budget table.

## 6. Error handling & cancellation

- `bake()` is async and accepts `onProgress(fraction, message)` → returning
  `false` cancels at the next region boundary (mirrors Godot's `BakeStepFunc`).
- GPU device loss surfaces as a `BakeError.deviceLost` result after the in-flight
  region completes; partial results are not returned.
- Capability mismatches (missing WebGPU, atlas > device limits) fail fast with
  typed errors before any GPU allocation.

## 7. Verification architecture

- **CI (no GPU):** `tsc`, vitest unit tests (bit-exact ports: hashes, struct
  layouts, packers, accel structure), naga WGSL validation, demo build.
- **Visual:** `deploy-demo.yml` publishes `demos/cornell` to GitHub Pages on
  every push to `main`; humans verify visually.
- **Golden (optional, on-GPU machines):** stage dumps compared against native
  Godot `DEBUG_TEXTURES` output — methodology in `PORTING_PLAYBOOK.md §7`.
- The SSH build/verification server available to maintainers has **no usable
  GPU**; treat it as a build box only (see RISKS.md R12).
