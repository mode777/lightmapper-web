/**
 * @lightmapper/shaders — the WGSL kernel sources of the WebGPU port of
 * Godot's lightmapper, exported as ready-to-compile source strings.
 *
 * The canonical sources are the `.wgsl` files in `../wgsl/` (validated by
 * `tools/wgsl-check` with naga in CI). PORT: WGSL has no preprocessor, so
 * Godot's `#include "lm_common_inc.glsl"` is reproduced with a tiny
 * same-directory `#include "name.wgsl"` resolution here — byte-for-byte the
 * same rule `tools/wgsl-check/src/main.rs` applies (keep them in lock-step).
 */

/// <reference path="./raw.d.ts" />

import lmCommonIncSource from '../wgsl/lm_common_inc.wgsl?raw';
import lmTraceIncSource from '../wgsl/lm_trace_inc.wgsl?raw';
import lmDilateSource from '../wgsl/lm_dilate.wgsl?raw';
import lmRasterSource from '../wgsl/lm_raster.wgsl?raw';
import lmUnoccludeSource from '../wgsl/lm_unocclude.wgsl?raw';

/** Include-name → source for every shared snippet. */
const INCLUDES: Record<string, string> = {
  'lm_common_inc.wgsl': lmCommonIncSource,
  'lm_trace_inc.wgsl': lmTraceIncSource,
};

/** Matches `#include "name.wgsl"` lines (same rule as tools/wgsl-check). */
const INCLUDE_RE = /^\s*#include\s+"([^"]+)"\s*$/;

/**
 * Inline `#include "name.wgsl"` directives (same-directory includes only).
 * Each file is inlined at most once per composition — the same include-once
 * semantics as Godot's shader preprocessor and tools/wgsl-check.
 * Kernels must be resolved before `createShaderModule`.
 */
export function resolveIncludes(source: string): string {
  const included = new Set<string>();
  const resolve = (src: string): string => {
    const out: string[] = [];
    for (const line of src.split('\n')) {
      const match = INCLUDE_RE.exec(line);
      if (match === null) {
        out.push(line);
        continue;
      }
      const name = match[1]!;
      if (included.has(name)) {
        continue; // already inlined (include-once)
      }
      const include = INCLUDES[name];
      if (include === undefined) {
        throw new Error(`resolveIncludes: unknown include ${name}`);
      }
      included.add(name);
      out.push(resolve(include));
    }
    return out.join('\n');
  };
  return resolve(source);
}

/** Shared declarations (port of `lm_common_inc.glsl`). Not a kernel. */
export const lmCommonInc = lmCommonIncSource;

/** Shared ray-traversal core (`ray_hits_triangle`, `ray_box_test`, `trace_ray`). Not a kernel. */
export const lmTraceInc = lmTraceIncSource;

/** G-buffer raster kernel (split pass A/B + edge expansion), render pipelines. */
export const lmRaster = resolveIncludes(lmRasterSource);

/** Un-occlude kernel (MODE_UNOCCLUDE), compute 8×8. */
export const lmUnocclude = resolveIncludes(lmUnoccludeSource);

/** Dilate kernel (MODE_DILATE), compute 8×8 — the reference port. */
export const lmDilate = resolveIncludes(lmDilateSource);
