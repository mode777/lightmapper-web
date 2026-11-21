# AGENTS.md — operating guide for AI coding agents

This repository is developed **by AI agents and humans together**. If you are
an agent (OpenCode, Claude, Codex, …) making changes here, follow this guide.
It is short on purpose; the details live in `docs/` and are linked where
needed.

## Orientation (read in this order before your first change)

1. `README.md` — what this is.
2. `docs/ARCHITECTURE.md` — system shape; where your change belongs.
3. `docs/DESIGN.md` — API + data contracts (byte layouts, WGSL binding map). **Authoritative.**
4. `docs/PORTING_PLAYBOOK.md` — the porting manual. **Read the relevant section before porting any kernel or CPU function.** It contains per-kernel gotchas that will bite you otherwise.
5. `docs/ROADMAP.md` — pick work from the current milestone only; keep scope small.
6. `docs/DECISIONS.md` — do not contradict an ADR; if you must, add a new ADR superseding it.

## Ground rules

1. **Fidelity to Godot.** This is a *port*. Translate `modules/lightmapper_rd` faithfully — including behavioral quirks (mark them `// GODOT-QUIRK:`). Deliberate deviations are marked `// PORT:` and require an ADR if architectural. Never "improve" the algorithm while porting it.
2. **Provenance headers.** Every ported file starts with: upstream file, Godot commit (`67421f36e5069e62573c44beb8dd2f8f91e065b0` unless proven otherwise), MIT attribution pointer to `NOTICE.md`. See `packages/shaders/wgsl/lm_dilate.wgsl` for the reference format.
3. **Float32 discipline.** All CPU-side math feeding hashes or GPU buffers must be binary32. Use `Float32Array` for storage, `Math.fround` where intermediates matter, and the shared `murmur3OneFloat` helper (it narrows and normalizes like Godot). Never hash f64 bits.
4. **Wire-format compatibility.** GPU struct layouts are byte-identical to Godot's (ADR-0008). Do not reorder fields. `packages/core/src/layout/structs.ts` and the WGSL structs must stay in lock-step with the tables in `docs/DESIGN.md §4` (tests pin the TS side).
5. **WGSL binding map.** Follow `docs/DESIGN.md §5` exactly: group 0 = shared base set, group 1 = kernel I/O, group 2 = `Params` dynamic-offset UBO (push-constant replacement). Reserved WGSL words are suffixed with `_` (`type_`, `size_`, `range_`).
6. **No extensive e2e tests.** The verification ladder is:
   1. `npm run typecheck` — must pass.
   2. `npm test` — unit tests; add/extend tests for anything bit-exact or pure-logic.
   3. WGSL must validate under naga (CI runs it; locally `npm run check:shaders` if you have cargo).
   4. Visual verification happens by humans on the GitHub Pages deployment. If your change is visible in the demo, say so in the PR body ("verify at <pages-url> after merge").
   Do not add Playwright/browser test suites.
7. **Small, conventional commits.** Imperative subject (`port lm_unocclude kernel`, `fix atlas padding scaling`), one logical change per PR. Port *one kernel or one CPU function* per PR where practical.
8. **Keep docs current.** Finishing a roadmap task? Tick its checkbox. Made an architectural choice? Append an ADR. New binding or struct change? Update `docs/DESIGN.md` (both the table and the TS/WGSL sides).
9. **Do not modify** `docs/research/REPORT.md` (historical research snapshot) or license headers.
10. **Secrets/third-party code**: never commit credentials; never vendor code without its license header (Godot, watlas and JNLM are all MIT — keep their notices).

## Environment

- Node 20+, npm workspaces: `npm install` at root installs everything.
- Rust is *optional* locally (only for `npm run check:shaders`); CI validates WGSL regardless.
- **No GPU is available in CI**, and the SSH verification box has no usable GPU either. Anything GPU-executable is verified visually via Pages, or against golden dumps produced on a real machine (see playbook §Golden testing). Design your work so the non-GPU parts (packing, hashing, accel structure, struct packing) are unit-testable without a device.

### Godot reference source

When porting, check out the exact reference commit sparsely (do not clone the
whole tree; do not commit it into this repo):

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/godotengine/godot.git godot-ref
cd godot-ref && git checkout 67421f36e5069e62573c44beb8dd2f8f91e065b0
git sparse-checkout set modules/lightmapper_rd modules/xatlas_unwrap \
  servers/rendering scene/3d scene/resources core/templates core/math editor
```

(The commit is master 2026-11-20; `4.5`-stable has the same layout minus area
lights — `lm_area_lights_inc.glsl` is master-only.)

## Definition of done (per ported unit)

A kernel or CPU function is **done** when:

- [ ] ported from the reference commit with provenance header,
- [ ] quirks marked, deviations marked and ADR'd where architectural,
- [ ] naga-valid (shaders) or unit-tested (pure logic; bit-exact where applicable),
- [ ] wired into the demo or driver if its milestone requires it,
- [ ] roadmap checkbox ticked + `packages/shaders/README.md` status table updated.

When in doubt about *how* something should behave, the answer is in the
Godot source — not in intuition.
