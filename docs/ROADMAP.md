# Roadmap

*From empty repo → a browser demo that bakes a scene. Effort estimates assume
senior-dev or capable-AI-agent pace, calendar-time with review cycles.
Each milestone ends with something a human can see or a test can prove.*

## Verification model (applies to all milestones)

- **CI (every push/PR, no GPU):** typecheck, unit tests, naga WGSL validation,
  demo build. Non-negotiable green.
- **Visual:** anything user-visible lands in `demos/cornell` and is verified by
  a human on GitHub Pages after merge (deploy is automatic from `main`).
- **Golden (on-demand):** byte/image comparison against native Godot dumps on
  a GPU machine (methodology: PORTING_PLAYBOOK §7). Recommended at M2, M3, M5
  boundaries; not a CI gate.
- **No extensive e2e suites** (project policy, ADR-0011). One smoke check that
  the demo page loads without console errors is the maximum browser
  automation we want.
- The maintainer SSH box has no GPU — treat it as a build machine only (R12).

---

## M0 — Foundations ✅ (done 2026-11-21)

- [x] Public repo, MIT license, NOTICE with upstream attribution
- [x] npm-workspaces monorepo (core / shaders / demo), Vite + Vitest + strict TS
- [x] CI: typecheck + unit tests + demo build (node) and naga WGSL validation (rust)
- [x] Pages deployment workflow + demo shell with WebGPU capability probe
- [x] `packages/core`: bit-exact Godot hash ports (`murmur3One32/OneFloat`,
      `fmix32`, `vertexHash`, `edgeHash`) with independent reference vectors
- [x] `packages/core`: byte-exact GPU struct layouts + offset-pinning tests
- [x] `packages/shaders`: `lm_dilate.wgsl` ported as the **reference kernel**
      (conventions, provenance header, quirk markers)
- [x] Docs: architecture, design, tech stack, risks, decisions, playbook, roadmap

## M1 — Data plane (CPU: scene → GPU buffers) ✅ (done 2026-11-22)

Everything here is unit-testable without a GPU.

- [x] `BakeScene` / input types per DESIGN §1 (meshes, lights, probes, env)
- [x] `@lightmapper/unwrap`: watlas integration, Godot presets (ADR-0002),
      worker-hosted, `uv2` normalization to atlas-space inputs — consumed
      via `xatlas-wasm` (ADR-0002's "own emscripten wrapper of unpatched
      upstream xatlas" fallback, materialized); presets and the xref + UV
      normalization contract ported from `xatlas_unwrap/register_types.cpp`
- [x] Atlas packer: port `_blit_meshes_into_atlas` bruteforce sizing +
      `partial_pack_rects`; padding rule `max(2, denoiserRange) × supersampling`
      — unit tests incl. Godot's "center in oversized region" `+1` offset quirk
- [x] Accel structure (worker): vertex dedup via `vertexHash` (M0 ✅), seam
      detection via `edgeHash` + `EdgeUV2` equality rules, grid plotting
      (recursive 8-subdivision + `triangle_box_overlap`), cluster median-split
      + AABBs, grid texture data (`rg32uint`, `count | cluster_index` pairs)
      — byte-verified against a C++ extraction of the upstream code on 400
      random scenes (worker host lands with the driver wiring, M2)
- [x] Buffer packing: `pack*()` helpers into the M0 struct writers;
      `cluster_data` merged buffer layout (ADR-0005)
- [x] Light list assembly + type-sort (Godot sorts by type — preserve!)
- [x] Probe generation (`subdiv_4/8/16/32` bounds grid → probe positions)
- [x] Unit tests: known-scene accel dumps (hand-computed small cases),
      seam detection on a seam-bearing quad pair
- **Exit criteria:** met — the accel-structure, atlas and packer ports were
  compared byte-for-byte against standalone C++ extractions of the pinned
  upstream code (hash funcs, SAT, SortArray, stb_rect_pack) on randomized
  scene streams; hashes/structs/lights/probes are pinned by reference
  vectors. A native `DEBUG_TEXTURES` golden pass stays recommended at the
  M2 boundary per the verification model.

## M2 — G-buffer stage (first GPU) — est. 2–3 weeks

- [ ] Driver skeleton: private `GPUDevice`, resource registry, bind-group
      factory for the canonical map, `Params` ring buffer (ADR-0003)
- [ ] `lm_raster.wgsl` port: vertex pulling from storage buffer (fallback:
      indexed draw with real vertex buffers), position smoothing
      (`FA_SMOOTHEN_POSITION`), unocclude texel-size via `dpdx/dpdy`
- [ ] Split-pass A/B (ADR-0004) + depth32; half-pixel `uv_offset` quirk
- [ ] Edge-expansion emulation of the wireframe pass (ADR-0007)
- [ ] `lm_unocclude.wgsl` port (4-tangent push-out, `bias × 10` quirk)
- [ ] Readback path: per-slice `copyTextureToBuffer` with 256 B rows, rgbah
      → `Uint16Array` + PNG preview helper
- [ ] `@lightmapper/gbuffer` (minimal): albedo/emission-on-UV2 raster from
      simple materials (albedo texture × (1−metallic), alpha, emission) —
      the `bake_render_uv2` replacement
- [ ] Demo page upgrade: "run M2 stage" button rendering the position/normal
      textures of the fixture scene
- **Exit criteria:** Pages demo shows correct position/normal/unocclude
  atlases (humans verify); golden EXR comparison of `1_position_*.exr` /
  `1_normal_*.exr` vs native if a GPU machine is available.

## M3 — Direct light — est. 2–4 weeks

- [ ] `lm_primary.wgsl` port: `trace_ray` DDA + cluster/triangle bit-trick
      traversal (`firstTrailingBit`), `ray_hits_triangle` with bias rules
      (front-face `distance − bias` quirk), cull-mode handling
- [ ] `trace_direct_light` port: directional/omni/spot attenuation, spot rim,
      Halton-disk AA over texel, Vogel-disk soft shadows incl. the
      early-inference optimization, transparency continuation
      (`transparency_rays`), shadow tracing
- [ ] Region-chunked dispatch loop + `onSubmittedWorkDone` awaits (ADR-0009),
      progress callbacks
- [ ] Demo upgrade: bake direct-only lightmap of the fixture scene, render
      result in-page (2D view of the atlas slices)
- **Exit criteria:** Pages demo produces a plausible direct-light lightmap
  (shadows, penumbrae visible); denoise off; golden `2_light_primary_*.exr`
  comparison recommended.

## M4 — Indirect light + probes — est. 2–4 weeks

- [ ] `lm_secondary.wgsl`: `trace_indirect_light` path loop (Russian
      roulette, transparency depth juggling, emission gathering, albedo
      throughput), `USE_LIGHT_TEXTURE_FOR_BOUNCES` variant,
      env-panorama miss color (rgba16f, ADR-0006)
- [ ] Ray-chunk accumulation across dispatches (accum read-modify-write)
- [ ] `lm_light_probes.wgsl`: SH L2 accumulation, `4 / ray_count` final-chunk
      scaling quirk, cross-dispatch buffer accumulation
- [ ] `lm_pack_l1.wgsl` (SH L0/L1 packing, `×8 + 1e-6` divisor quirk)
- [ ] Demo upgrade: bounces slider, probes overlay visualization (debug
      spheres not required — color pickers on a grid acceptable)
- **Exit criteria:** Pages demo shows color bleeding / bounce light; probe SH
  values sane on the fixture scene (spot-check vs hand-computed single-light
  case).

## M5 — Finishing passes — est. 2–3 weeks

- [ ] `lm_denoise.wgsl`: verbatim JNLM port (ADR-0010) incl. SH 4-slice mode
      and `region_size / 2` chunking for SH
- [ ] Seam blend raster passes (`lm_blendseams_{lines,triangles}.wgsl`), the
      9-offset `uv_offsets` schedule, z-buffer masking, alpha-blend state
- [ ] Wire dilate into the driver (kernel already ported in M0 ✅)
- [ ] Shadowmask mode (optional flag; `USE_SHADOWMASK` define)
- [ ] Tone-mapped PNG + rgbah download buttons in the demo
- **Exit criteria:** visual parity check vs native Godot bake of the same
  fixture scene (side-by-side in the demo or via golden EXRs). Seams smooth,
  denoiser effective at medium quality.

## M6 — The demo & package polish — est. 1–2 weeks

- [ ] Cornell-box scene (procedural geometry + one area-ish light approximation
      via omni; emissive panels) with glTF loading via `@lightmapper/io`
- [ ] Baking UI: quality/bounces/bias/atlas-size controls, progress bar with
      stage messages, cancel button, timing readouts
- [ ] Result viewer: lightmapped scene rendered with the baked atlas
      (WebGPU render pipeline in the demo; three.js adapter optional)
- [ ] `tsup` builds + `exports` map for npm publish (ADR-0012 follow-through)
- [ ] README refresh with real screenshots, browser support matrix
- [ ] Capability gates: friendly errors for missing WebGPU / low limits
- **Exit criteria (the working demo):** open the Pages URL on a desktop
  browser → load/see the scene → click Bake → watch progress → see the scene
  lit by its own baked lightmap + probes. This is the milestone the whole
  roadmap exists for.

## Post-M6 candidates (not scheduled)

- Area lights (master/4.6-only; `lm_area_lights_inc.glsl` + `Light` fields)
- `three.js` / Babylon adapters in `packages/adapters`
- Streaming bake (atlas slices one-at-a-time for memory-constrained devices)
- wasm accel-structure leaf (R8) and worker pool sharding
- Optional OIDN-in-wasm denoiser as an alternative to JNLM
