# @lightmapper/shaders

WGSL ports of Godot's lightmapper shaders
(`godot/modules/lightmapper_rd/*.glsl` @ `67421f36e5069e62573c44beb8dd2f8f91e065b0`).

## Conventions (binding to follow for every new kernel)

See `docs/PORTING_PLAYBOOK.md` and `docs/DESIGN.md §5` for the full contract:

- `group(0)` — the shared base set, mirroring `lm_common_inc.glsl`:
  - `@binding(0)` `BakeParameters` uniform buffer
  - `@binding(1..6)` storage buffers (vertices, triangles, triangle indices,
    lights, seams, probes) — note: Godot numbering is preserved but the
    cluster buffers are merged into one (ADR-0005)
  - `@binding(7)` grid `texture_3d<u32>`
  - `@binding(8,9)` albedo/emission `texture_2d_array<f32>`
  - `@binding(10,11)` samplers
  - `@binding(12)` merged cluster data (indices + AABBs)
- `group(1)` — kernel-specific I/O, mirroring the GLSL set 1.
- `group(2)` — `Params` uniform buffer with **dynamic offset**: the
  push-constant replacement (ADR-0003). One write per dispatch, one bind group.
- One file per Godot shader *version* where practical, named `lm_*.wgsl`
  (`lm_primary.wgsl`, `lm_secondary.wgsl`, `lm_unocclude.wgsl`,
  `lm_light_probes.wgsl`, `lm_dilate.wgsl`, `lm_denoise.wgsl`,
  `lm_pack_l1.wgsl`, `lm_raster.wgsl`, `lm_blendseams_*.wgsl`).
- Every file starts with a provenance header (source file, version, commit,
  license) and marks deliberate deviations with `// PORT:` and preserved
  behavioral quirks with `// GODOT-QUIRK:`.

## Status

| Kernel | Godot source | Status |
|---|---|---|
| `lm_dilate.wgsl` | `lm_compute.glsl#dilate` | ✅ ported (reference example) |
| `lm_unocclude.wgsl` | `lm_compute.glsl#unocclude` | ⬜ M2 |
| `lm_primary.wgsl` | `lm_compute.glsl#primary` | ⬜ M3 |
| `lm_secondary.wgsl` | `lm_compute.glsl#secondary` | ⬜ M4 |
| `lm_light_probes.wgsl` | `lm_compute.glsl#light_probes` | ⬜ M4 |
| `lm_pack_l1.wgsl` | `lm_compute.glsl#pack_coeffs` | ⬜ M5 |
| `lm_denoise.wgsl` | `lm_compute.glsl#denoise` (JNLM) | ⬜ M5 |
| `lm_raster.wgsl` (+ split pass variant) | `lm_raster.glsl` | ⬜ M2 |
| `lm_blendseams_lines.wgsl` | `lm_blendseams.glsl#lines` | ⬜ M5 |
| `lm_blendseams_triangles.wgsl` | `lm_blendseams.glsl#triangles` | ⬜ M5 |

All files are validated by `tools/wgsl-check` (naga) in CI
(`npm run check:shaders` locally if you have Rust installed).
