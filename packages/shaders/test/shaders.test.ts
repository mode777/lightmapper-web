import { describe, expect, it } from 'vitest';
import { lmDilate, lmRaster, lmTraceInc, lmUnocclude, resolveIncludes } from '../src/index.js';

describe('resolveIncludes', () => {
  it('inlines shared snippets into kernels', () => {
    expect(lmRaster).toContain('struct BakeParameters');
    expect(lmRaster).toContain('fn vertex_main_impl');
    expect(lmUnocclude).toContain('fn trace_ray(');
    expect(lmDilate).toContain('fn main(');
  });

  it('inlines each file at most once (Godot preprocessor include-once)', () => {
    // lm_unocclude includes lm_common_inc directly *and* via lm_trace_inc.
    expect(lmUnocclude.match(/struct BakeParameters \{/g)).toHaveLength(1);
  });

  it('drops the #include directives from the composed source', () => {
    for (const source of [lmRaster, lmUnocclude, lmDilate]) {
      expect(source).not.toMatch(/^\s*#include/m);
    }
  });

  it('keeps the shared snippets exportable on their own', () => {
    expect(lmTraceInc).toContain('fn trace_ray_closest_hit_distance');
  });

  it('throws on unknown includes', () => {
    expect(() => resolveIncludes('#include "nope.wgsl"')).toThrow(/unknown include/);
    expect(() => resolveIncludes('let x = 1;')).not.toThrow();
  });
});

describe('kernel provenance markers', () => {
  it('every kernel carries the pinned commit + license pointer', () => {
    for (const source of [lmRaster, lmUnocclude, lmDilate, lmTraceInc]) {
      expect(source).toContain('67421f36e5069e62573c44beb8dd2f8f91e065b0');
      expect(source).toContain('NOTICE.md');
    }
  });
});
