# lightmapper-web

**Godot 4's GPU lightmapper, ported to WebGPU.** A standalone, browser-native
package that bakes lightmap atlases and light probes for arbitrary scenes —
no engine, no server, no native build step. Feed it meshes, lights and an
environment; get HDR lightmaps back.

> Status: **M1 done** — the CPU data plane (scene model, unwrap via xatlas,
> atlas packer, acceleration structure) is complete and byte-verified against
> C++ extractions of the upstream code. Next: the M2 GPU driver. See the
> [roadmap](docs/ROADMAP.md) for the path to a working browser demo.
>
> 🎬 **Live demo (capability probe for now):** https://mode777.github.io/lightmapper-web/

## Why this exists

Godot 4 ships an excellent GPU lightmapper: software ray tracing in compute
shaders (DDA grid traversal + triangle clusters), multi-bounce path-traced GI,
soft shadows, transparency, SH directional lightmaps, light probes, a JNLM
denoiser, seam blending and atlas slicing. It is:

- **self-contained** — a module (`modules/lightmapper_rd/`, ~5k LOC incl. shaders) that runs on its *own* private rendering device,
- **already software-RT** — no hardware ray tracing, no vendor extensions; exactly what ports cleanly to WebGPU compute,
- **data-driven** — its input contract is plain arrays and images, not an engine scene graph.

And it can never run in a browser inside Godot (web exports use the GL
compatibility renderer; the RD lightmapper is Vulkan/Metal/D3D-only). This
project extracts it instead. The full feasibility analysis lives in
[`docs/research/REPORT.md`](docs/research/REPORT.md).

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | TypeScript orchestration core: scene model, atlas packing, acceleration structure, bake driver |
| `packages/shaders` | WGSL ports of Godot's lightmapper shaders (one `lm_*.wgsl` per kernel) |
| `packages/unwrap`, `packages/gbuffer`, `packages/io`, `packages/adapters` | Future: xatlas/watlas wrapper, albedo/emission raster, glTF/PNG/EXR I/O, three.js adapters (M1+/M2+) |
| `tools/wgsl-check` | naga-based WGSL validator used in CI (no GPU needed) |
| `demos/cornell` | The browser demo (deployed to GitHub Pages) |
| `docs` | Architecture, design, decisions, risks, roadmap, porting playbook, research report |

## Documentation

Start here, in order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, data flow, execution model
2. [`docs/DESIGN.md`](docs/DESIGN.md) — public API, data contracts, byte layouts, WGSL binding map
3. [`docs/PORTING_PLAYBOOK.md`](docs/PORTING_PLAYBOOK.md) — the kernel-by-kernel porting manual (read before porting anything)
4. [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones M0–M6 to the working demo
5. [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decision records
6. [`docs/RISKS.md`](docs/RISKS.md) — risk register
7. [`docs/TECH_STACK.md`](docs/TECH_STACK.md) — technology choices and rationale

Agents and humans contributing code should read [`AGENTS.md`](AGENTS.md) first.

## Developing

Requirements: Node 20+. Rust (stable) is optional — only needed to run the
WGSL validator locally; CI always runs it.

```sh
npm install          # workspaces: packages/*, demos/*
npm run verify       # typecheck + unit tests + demo build
npm run check:shaders  # optional: naga WGSL validation (needs cargo)
npm run dev -w demos/cornell   # demo dev server
```

CI (GitHub Actions):

- **ci.yml** — typecheck, unit tests, demo build, naga WGSL validation on every push/PR
- **deploy-demo.yml** — builds and deploys the demo to GitHub Pages on every push to `main`

Verification philosophy: **no extensive e2e test suites.** Correctness is
pinned by unit tests (bit-exact ports), naga shader validation, and *visual*
verification via the Pages deployment — see `docs/ROADMAP.md §Verification`.

## License

MIT — see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md) for upstream
attribution (Godot Engine, JNLM/YoctoImageDenoiser, xatlas/watlas).
