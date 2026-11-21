# Tech stack

*Last updated: 2026-11-21 (M0).*

## Chosen stack

| Layer | Choice | Since |
|---|---|---|
| Language (CPU/orchestration) | **TypeScript** (strict, ES2022) | M0 |
| Language (GPU) | **WGSL** (WebGPU Shading Language) | M0 |
| GPU API | **WebGPU** (browser-native; offscreen compute + raster, no canvas required) | M0 |
| Module system / repo | npm workspaces monorepo | M0 |
| Build (demo) | **Vite** | M0 |
| Unit tests | **Vitest** | M0 |
| Types for WebGPU | `@webgpu/types` | M0 |
| Shader validation (no GPU) | **naga** via `tools/wgsl-check` (Rust, CI-only locally optional) | M0 |
| UV unwrapping | **watlas** (xatlas compiled to wasm, near-native API, MIT) | M1 |
| Demo hosting / visual verification | **GitHub Pages** via Actions | M0 |
| CI | GitHub Actions (`ci.yml`, `deploy-demo.yml`) | M0 |

## Rationale (and alternatives rejected)

### TypeScript + WGSL over C++/Emscripten or Rust/wgpu

Three architectures were evaluated in the feasibility study
(`research/REPORT.md §7`):

- **A. TypeScript + WGSL** *(chosen)* — the CPU side of Godot's lightmapper is
  ~2.5k lines of container glue, hashing, packing and dispatch loops; the GPU
  side is self-contained GLSL. Porting both to TS/WGSL yields a web-native,
  debuggable, dependency-light package. The only CPU-heavy part (acceleration
  structure) is worker-friendly and can later become a wasm leaf if profiling
  demands (see RISKS R8).
- **B. C++ extraction + Emscripten + `webgpu.h` mini-RD shim** — maximal
  fidelity (copy `lightmapper_rd.cpp`), but you maintain a rendering-device
  shim, GLSL→WGSL translation in the build, wasm toolchain in every
  contributor loop, and harder debugging. Viable fallback, not the default.
- **C. Rust + wgpu → wasm** — great shader-translation story (naga ingests the
  GLSL nearly verbatim), but the C++ still needs rewriting, and the npm-facing
  surface grows a wasm-bindgen layer + Rust toolchain requirement.

Decision: **A**, recorded as ADR-0001. B remains the documented escape hatch if
bit-exact tracking of upstream becomes the dominant need.

### WebGPU over WebGL2

- Godot's pipeline is compute-shaped (software RT); compute shaders are the
  natural fit and avoid the fragment-shader contortions of WebGL2 ray tracers.
- WebGL2 float support is extension-dependent; WebGPU guarantees rgba16f/rgba32f
  storage images and storage buffers.
- WebGL2 fallback would mean a different algorithm; rejected (non-goal).

### watlas over rolling our own xatlas build

- Godot's glue is 240 lines of options around **unpatched upstream xatlas**;
  watlas wraps the same code, is MIT, maintained (gltf-transform uses it), and
  exposes chart/pack phases separately which our UI wants.
- Rolling our own emscripten build adds a toolchain for zero functional gain
  (ADR-0002).

### naga for CI shader validation

- CI runners (and the maintainer SSH box) have no GPU; naga parses *and*
  validates WGSL against WebGPU-core capabilities, catching the vast majority
  of porting errors (types, bindings, format/access mismatches) without a
  device. Runtime `createShaderModule` errors remain the backstop on real
  machines.
- Pinned major version in `tools/wgsl-check/Cargo.toml`; bump deliberately.

### Vitest over Jest

- Native ESM + TypeScript, zero config in workspaces, same family as Vite.

## Version policy

- Node ≥ 20 (CI on 22). Browsers: WebGPU-capable (Chrome/Edge 113+, Safari
  18+, Firefox 141+ for Windows/macOS; Linux Firefox behind flag/rollout).
  The demo surfaces a capability probe and graceful failure message.
- npm dependency ranges are kept loose within a major (`^`); `package-lock.json`
  is committed and CI uses `npm ci`.
- The Rust dependency (naga) is CI-only and does not affect npm consumers.

## Tooling matrix (per task)

| Task | Command | Where |
|---|---|---|
| Typecheck | `npm run typecheck` | local + CI |
| Unit tests | `npm test` | local + CI |
| Demo build | `npm run build:demo` | local + CI + Pages |
| WGSL validation | `npm run check:shaders` | CI (Rust); local optional |
| Everything | `npm run verify` | local pre-PR |
| Demo dev server | `npm run dev -w demos/cornell` | local |
| Visual verification | Pages deployment | humans, post-merge |
