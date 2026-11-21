# NOTICE

This project ports substantial portions of the Godot Engine lightmapper and
depends on or reuses ideas and code from the following projects. Their
copyright notices and MIT licenses apply to the derived code; the full license
texts are retained in the source files and linked below.

## Godot Engine

- **What:** `modules/lightmapper_rd/*` (C++ orchestration and GLSL shaders),
  `scene/3d/lightmapper.h` (interface), `core/templates/hashfuncs.{h,cpp}`
  (hashing), `modules/xatlas_unwrap/register_types.cpp` (xatlas configuration
  reference), `scene/resources/mesh.cpp` (unwrap glue reference).
- **Source:** https://github.com/godotengine/godot
- **Reference commit:** `67421f36e5069e62573c44beb8dd2f8f91e065b0` (master,
  2026-11-20). Files derived from `4.5`-stable carry their own provenance
  headers where they differ.
- **License:** MIT — https://github.com/godotengine/godot/blob/master/COPYRIGHT.txt
- **Copyright:** (c) 2014-present Godot Engine contributors, (c) 2007-2014
  Juan Linietsky, Ariel Manzur.
- Every ported file begins with a provenance header identifying the upstream
  file and commit. Behavioral quirks preserved deliberately are marked with
  `// GODOT-QUIRK:`; deliberate deviations are marked with `// PORT:`.

## JNLM denoiser

- **What:** the `denoise` kernel (`lm_denoise.wgsl`, future) is a port of the
  JNLM implementation inside Godot's `lm_compute.glsl`, which itself derives
  from YoctoImageDenoiser and the paper "Nonlinearly Weighted First-order
  Regression for Denoising Monte Carlo Renderings" (Bitterli et al.).
- **Upstream:** https://github.com/ManuelPrandini/YoctoImageDenoiser (MIT,
  Copyright (c) 2020 ManuelPrandini) — attribution block is preserved in the
  ported shader.
- **Paper:** https://benedikt-bitterli.me/nfor/nfor.pdf

## xatlas / watlas (planned dependency, M1)

- **What:** UV charting, parameterization and atlas packing for lightmap UVs.
- **Upstream:** https://github.com/jpcy/xatlas (MIT) — Godot vendors an
  unmodified copy; the browser package consumes the wasm build
  **watlas** (https://github.com/toji/watlas, MIT).

## Unocclusion technique

The texel un-occlusion approach follows
https://ndotl.wordpress.com/2018/08/29/baking-artifact-free-lightmaps/
(as documented in Godot's `lm_raster.glsl` / `lm_compute.glsl` comments).
