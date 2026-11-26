# Risk register

*Last updated: 2026-11-21 (M0). Review at every milestone boundary.
IDs are stable; never renumber.*

## Summary

| ID | Risk | L | I | Mitigation | Status |
|----|------|---|---|------------|--------|
| R1 | Shader translation drift (esp. JNLM denoiser, seam blending) | M | H | naga validation gate; faithful-port rule with `GODOT-QUIRK` markers; golden-image comparison vs native Godot dumps (playbook §7) | Open |
| R2 | Edge-texel artifacts from missing wireframe pass | M | M | Edge-expansion emulation (ADR-0007); validated analytically in M2 on the fixture: the ring the fill pass misses is covered (0 missed, 0 bleed). Two open deltas vs upstream's 1-px wire — shape-dependent ring width (down to ~0.17 texel on thin triangles) and ring positions off by up to ~1 texel along the surface (ADR-0007 note). Decide on native goldens | Open |
| R3 | Mobile/tile-GPU memory pressure (~70–100 B per atlas texel × slice) | H* | M | Default atlas caps (1024–2048), explicit `destroy()` of stage targets (better than Godot), quality presets, docs. *High only if mobile is targeted | Open |
| R4 | `read_write` storage-texture gaps on some drivers | **realized** | M | Dawn rejects read-write rgba32f storage ("does not support storage texture access ReadWrite"). Unocclude uses the ping-pong (sampled source + write-only destination) since M2; do the same for bounce accumulation (M4) — only rgba16f read-write may exist, and it is not worth relying on | Mitigated |
| R5 | Browser GPU watchdog kills long traces / device lost | M | H | Keep Godot's region chunking + `await onSubmittedWorkDone()` between regions (ADR-0009); adaptive region size; cancellation support | Open |
| R6 | `float32-filterable` absent (env panorama) | C | L | Convert panorama to rgba16f at upload (ADR-0006); optional feature-detect to keep rgba32f where available | Open |
| R7 | 9 storage buffers in probe mode vs core-guaranteed 8 | L | M | Cluster buffers merged into one from day one (ADR-0005) → 8 max | Mitigated by design |
| R8 | TS accel-build perf on multi-million-triangle scenes | M | M | Web Worker + typed arrays from the start; optional wasm leaf (reusing Godot's C++ verbatim) if profiling demands | Open |
| R9 | Upstream drift (area lights landed in master/4.6; 4.7 will evolve) | C | L | Port from 4.5-stable semantics; area lights are an optional add-on; provenance headers make diffs against upstream mechanical | Accepted |
| R10 | Safari/iOS WebGPU quirks (limits, storage textures, fp16 filtering) | M | M | Capability probe in demo; feature-detect `read_write` storage textures & `float32-filterable`; document per-browser matrix in demo | Open |
| R11 | Scope creep toward a full path tracer / renderer | M | M | Non-goals in ARCHITECTURE §1; roadmap gates features by milestone; ADR required for anything smelling like a renderer | Open |
| R12 | Maintainer SSH verification box has no usable GPU | C | L | Treat as build box, plus its software WebGPU (SwiftShader in headless Chrome) for the analytic check `tools/verify-demo-remote.py`; GPU-class verification via Pages (humans) or contributor machines; CI stays GPU-free by design | Accepted |
| R13 | Loss of bit-exact hash/struct parity during refactors | M | H | Reference-vector unit tests (hash), offset-pinning tests (structs); CI-enforced; rule in AGENTS.md | Mitigated by tests |
| R14 | watlas maintenance stall | L | M | watlas is a thin wrapper over unpatched upstream xatlas; building our own emscripten wrapper is a documented 1–2 day fallback (ADR-0002) | Open |
| R15 | Float64 leakage in JS math (hashing, bias, grid math) | M | H | f32 discipline rule (AGENTS.md), `Float32Array` storage, `Math.fround` in hot paths, review checklist item | Open |

## Notes on likelihood (L) / impact (I)

- **C = certain, H = high, M = medium, L = low.**
- R3 marked `H*`: only high if we promise mobile support; the demo targets
  desktop-class WebGPU initially and the probe page communicates capability.

## Memory budget reference (R3)

Per atlas texel × slice (bytes): albedo 4 + emission 8 + position 16 +
normal 8 + unocclude 16 + source/accum/dest rgbah 8×(2–3, ×4 with SH) +
shadowmask 4 ⇒ roughly:

| Atlas | Slices | Non-SH | SH (×4 accum) |
|---|---|---|---|
| 1024² | 1 | ~70 MB | ~200 MB |
| 2048² | 1 | ~280 MB | ~800 MB |
| 2048² | 4 | ~1.1 GB | n/a (use smaller) |

Driver must free raster targets before trace phases and cap defaults
accordingly (see ARCHITECTURE §5 Memory).
