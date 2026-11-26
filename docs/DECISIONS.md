# Architecture decision records

Chronological. New decisions are appended; superseding happens by adding a
new ADR that references the old one — never edit history.

---

## ADR-0001: TypeScript + WGSL core (Option A)

- **Status:** Accepted (2026-11-21)
- **Context:** Three extraction architectures were evaluated
  (research/REPORT.md §7): (A) TS orchestration + WGSL kernels,
  (B) C++/Emscripten + mini-RD shim over `webgpu.h`,
  (C) Rust/wgpu compiled to wasm.
- **Decision:** Option A. The CPU side of Godot's lightmapper is small and
  glue-shaped; the GPU side is self-contained GLSL. Web-native tooling wins.
- **Consequences:** wasm appears only as optional leaves (`watlas` now; a
  possible accel-structure leaf later — R8). Architecture B remains a
  documented escape hatch if bit-exact upstream tracking ever dominates.

## ADR-0002: UV unwrapping via watlas (xatlas-wasm)

- **Status:** Accepted (2026-11-21) — dependency realized as `xatlas-wasm`
  (2026-11-22, see note)
- **Context:** Arbitrary input meshes need lightmap UVs; Godot's glue around
  xatlas is ~240 lines with known options (`fixWinding`, `padding=1`,
  `blockAlign=true`, `maxChartSize=4094`, `texelsPerUnit=1/texelSize`).
- **Decision:** Consume **watlas** (xatlas → wasm) with Godot's presets as
  defaults; expose chart/pack phases.
- **Consequences:** Chart layout parity with Godot. Fallback if watlas stalls:
  build our own emscripten wrapper of unpatched upstream xatlas (1–2 days).
- **Note (2026-11-22):** M1 landed on the documented fallback path — the
  `xatlas-wasm` package (same wrapper concept, MIT, worker-capable, published
  on npm) is consumed by `@lightmapper/unwrap` instead of `watlas`. The Godot
  preset surface and output contract are identical; no decision change.

## ADR-0003: Push constants → dynamic-offset uniform buffer

- **Status:** Accepted (2026-11-21)
- **Context:** WebGPU has no push constants; Godot's kernels take a 32–64 B
  struct per dispatch/draw.
- **Decision:** Group 2 binding 0 holds the struct as a uniform buffer bound
  with **dynamic offsets** from a 256 B-aligned ring buffer. One write +
  rebind per dispatch.
- **Consequences:** Negligible cost at our dispatch rates; uniform struct
  layouts stay byte-identical to the GLSL push-constant layouts.
- **Note (2026-11-26, M2 realization):** two WebGPU details this relies on.
  (1) A pipeline layout's array index *is* the `@group()` index, so render
  kernels (groups 0 + 2) take an empty placeholder layout and bind group in
  slot 1. (2) The dynamic-offset binding must declare an explicit `size`
  (one ring slot) — with the default whole-buffer range every non-zero
  offset is a validation error, and validation errors are silent no-ops
  (see the playbook §5.10). (3) The ring is sized for the writes of one
  submit and `markSynced()` is awaited afterwards — `next()` throws rather
  than overwrite a slot the GPU may still read (the 256-slot default would
  silently corrupt bakes above 128 atlas slices).

## ADR-0004: Split the G-buffer raster pass

- **Status:** Accepted (2026-11-21)
- **Context:** Godot renders position(rgba32f) + normal(rgbah) +
  unocclude(rgba32f) = 48 B/sample; WebGPU core caps
  `maxColorAttachmentBytesPerSample` at 32.
- **Decision:** Two render passes: A {position, unocclude} (32 B), B {normal}
  (8 B). Two pipeline variants via a define; same vertex shader.
- **Consequences:** One extra pass per slice; negligible. Enables future
  request-limit raise to collapse the passes back.
- **Note (2026-11-22, M2 realization):** WGSL cannot make *output structs*
  conditional on constant overrides, so the "two pipeline variants via a
  define" materialized as **two fragment entry points** (`fa_main` /
  `fb_main`) in one `lm_raster.wgsl` module sharing the same vertex stage —
  the WGSL-native equivalent. Each pass clears depth to 1.0 exactly like the
  single upstream pass; identical geometry yields identical depth outcomes
  across the split.

## ADR-0005: Merge cluster buffers to stay ≤ 8 storage buffers per stage

- **Status:** Accepted (2026-11-21)
- **Context:** Godot's set 0 declares 8 storage buffers; the probe kernel adds
  a 9th in set 1 — above WebGPU's core guarantee of 8
  (`maxStorageBuffersPerShaderStage`).
- **Decision:** Merge `cluster_indices` (u32[]) and `cluster_aabbs` into a
  single `cluster_data` storage buffer at binding 12 (AABBs viewed as u32
  pairs at a known element offset). Keep Godot numbering elsewhere.
- **Consequences:** Worst-case storage-buffer usage is exactly 8. Documented
  delta from `lm_common_inc.glsl` (DESIGN §5).
- **Note (2026-11-26, M2 realization):** the "known element offset" travels
  as a WGSL **pipeline override constant** (`override
  cluster_aabb_offset_u32`), set by the driver at pipeline creation from
  `packClusterData().aabbOffsetU32`; the include ships
  `load_cluster_aabb()` so kernels never index the merged buffer by hand.
  This keeps `BakeParameters` byte-identical to the GLSL struct (ADR-0008).

## ADR-0006: Environment panorama as rgba16f

- **Status:** Accepted (2026-11-21)
- **Context:** Godot bilinearly samples an rgba32f panorama; WebGPU core does
  not guarantee filterable rgba32f (`float32-filterable` is optional).
- **Decision:** Convert panoramas to rgba16f at upload by default;
  feature-detect `float32-filterable` and keep rgba32f when available.
- **Consequences:** Slight precision loss in env lighting; matches the
  precision of the lightmap accumulator anyway.

## ADR-0007: Wireframe pass replaced by edge-expansion

- **Status:** Accepted (2026-11-21)
- **Context:** Godot's raster stage re-draws triangles as *wireframe* to
  cover texels missed by fill rasterization (conservative-rasterization trick
  for artifact-free lightmaps). WebGPU has no wireframe fill mode.
- **Decision:** Emulate with an "edge-expanded" draw: vertex shader pushes each
  vertex outward from the UV-space triangle centroid by ~1 texel. Keep the
  two-draw structure (fill, then expanded) and the shared depth behavior.
- **Consequences:** Must be validated visually against native dumps (R2);
  fallback if insufficient: line-list topology over edges.
- **Note (2026-11-26, M2 measurements):** implemented as decided
  (`vs_edges_main`). Measured on the fixture with
  `tools/verify-demo-remote.py`: the expanded draw covers exactly the ring
  the fill pass cannot reach (984 texels, 0 missed) and stops there (0 bled
  past 1.12 texels). Two deltas from upstream's 1-px wire are inherent to
  "move the clip position, keep the vertex attributes" and remain **open**
  until native goldens can be compared:
  1. *Ring width is shape-dependent.* A 1-texel centroid push moves an edge
     out by the push's perpendicular component: 0.45–0.71 texel for the
     fixture's right triangles, but as little as ~0.17 texel on the long
     edges of thin triangles (upstream: ~0.5 texel everywhere).
  2. *Ring positions are not exact extrapolations.* The interpolant still
     passes through the original corner values, so a ring texel reads the
     plane at (sample − barycentric-weighted push): up to ~1 texel along
     the surface (measured 0.87 texel at a corner), on-plane and
     tangential. Upstream's lines interpolate exactly.
  Options if goldens show a difference, in order of fidelity: extrapolate
  the expanded vertices' attributes through the uv→world Jacobian (exact
  positions, still an "edge-expanded" draw), a miter offset of 0.5 texel
  (matches the wire's width for every shape), or the line-list fallback.

## ADR-0008: Byte-compatible wire format with Godot

- **Status:** Accepted (2026-11-21)
- **Context:** WGSL alignment rules can reproduce Godot's std140/std430
  layouts byte-for-byte for all lightmapper structs.
- **Decision:** Keep layouts identical (DESIGN §4); pin with unit tests on the
  TS side and keep WGSL declarations in lock-step.
- **Consequences:** Golden-testing against native Godot buffer/EXR dumps
  becomes possible; diffs against upstream stay reviewable.

## ADR-0009: Region-chunked async execution

- **Status:** Accepted (2026-11-21)
- **Context:** Godot submits+syncs per ≤512² region to avoid GPU watchdog
  resets; browsers additionally require event-loop yielding for long work.
- **Decision:** Keep region chunking; after each region, submit and
  `await device.queue.onSubmittedWorkDone()`, then run progress/cancel
  callbacks. Region size adaptive (smaller on `device.lost` heuristics /
  mobile defaults).
- **Consequences:** Matches Godot's TDR mitigation; enables cancellation and
  responsive UI. Slightly more submit overhead than one mega-batch — accepted.

## ADR-0010: JNLM denoiser ported verbatim

- **Status:** Accepted (2026-11-21)
- **Context:** The denoiser is the most iteration-sensitive kernel; it embeds
  an MIT attribution block from YoctoImageDenoiser.
- **Decision:** Port `MODE_DENOISE` verbatim (constants included), preserve the
  attribution block, expose Godot's parameter surface (`strength`, `range`).
  No "improvements" without a dedicated ADR.
- **Consequences:** Predictable parity; MIT obligations met (NOTICE.md).

## ADR-0011: GPU-free CI, visual verification via Pages

- **Status:** Accepted (2026-11-21)
- **Context:** No GPU in CI or on the maintainer verification box (R12);
  project policy is to avoid extensive e2e test suites.
- **Decision:** CI = typecheck + unit tests + naga WGSL validation + demo
  build. Visual/runtime verification happens by humans on the GitHub Pages
  deployment (auto-deployed from `main`). Golden-dump comparison is available
  for on-demand use on GPU machines but is not a CI gate.
- **Consequences:** Fast, reliable CI; runtime regressions are caught late by
  humans — mitigated by the faithful-port discipline and naga coverage.

## ADR-0012: npm workspaces monorepo, source-first packages

- **Status:** Accepted (2026-11-21)
- **Context:** Multiple packages (core/shaders/unwrap/gbuffer/io/adapters) +
  demo; no need for published artifacts yet.
- **Decision:** npm workspaces; packages export TypeScript source until M6
  (then add `tsup` builds if external consumers want them). Demo consumes
  source via Vite alias.
- **Consequences:** Zero build step for contributors; publish story deferred.

## ADR-0013: Godot reference commit & provenance discipline

- **Status:** Accepted (2026-11-21)
- **Context:** The port must stay auditable against upstream.
- **Decision:** Reference commit
  `67421f36e5069e62573c44beb8dd2f8f91e065b0` (master, 2026-11-20; 4.5-stable
  layout equivalent minus area lights). Every ported file carries a
  provenance header; quirks/deviations are marked `GODOT-QUIRK`/`PORT`.
- **Consequences:** Mechanical re-diffs when we choose to track 4.6/4.7
  features (e.g. area lights) later.

## ADR-0014: Mesh winding follows Godot — clockwise front faces

- **Status:** Accepted (2026-11-26)
- **Context:** The lightmapper derives geometry-facing information from the
  triangle *winding*: `face_normal` in `lm_raster.glsl` (the un-occlusion
  tangent frame and bias direction) and `normal` in `trace_ray` (front/back
  hits, hence `cullMode`). Godot's rasterizer convention is clockwise front
  faces (`RD::PipelineRasterizationState` defaults to
  `POLYGON_FRONT_FACE_CLOCKWISE`), and both expressions equal
  `SurfaceTool::generate_normals()` (`Plane(v0, v1, v2, CLOCKWISE)`). Until
  M2, `MeshInput` left the winding undefined and the `flatFaceNormal`
  convenience used the right-hand rule (counter-clockwise front), so a
  normals-less mesh contradicted the kernels and was un-occluded from its
  back side — invisible in M1, caught by the M2 analytic check on the demo
  fixture (0.1 % of the floor flagged instead of ~1 %).
- **Decision:** `MeshInput` triangles follow Godot: a front face is the side
  its vertices appear *clockwise* from, geometric front normal
  `-(v1 - v0) × (v2 - v0)`. `flatFaceNormal` computes exactly the kernels'
  expression. Shaders stay verbatim; `cullMode: 'front' | 'back'` keeps
  Godot's meaning. glTF and most WebGPU data are counter-clockwise front —
  input adapters (`@lightmapper/io`, M6) reverse the index order, exactly
  as Godot's own glTF importer does (`modules/gltf/gltf_document.cpp`:
  "Swap around indices, convert ccw to cw for front face").
- **Consequences:** Verbatim kernels and Godot-meaningful cull modes at the
  cost of a documented surprise for web-native mesh data (DESIGN §1).
  The verification fixture follows the contract, so the analytic checks in
  `tools/verify-demo-remote.py` would catch a regression in either side.
