/**
 * Spec-defined values of WebGPU's runtime flag globals.
 *
 * `GPUBufferUsage`, `GPUTextureUsage`, `GPUMapMode` and `GPUShaderStage`
 * only exist inside a browser. The driver must be importable — and its
 * bookkeeping unit-testable — in node without a device (ARCHITECTURE §7:
 * design the non-GPU parts so they need no device), so it uses the values
 * frozen by the WebGPU spec instead of the globals. A wrong value here is
 * not silent: the stage's validation error scope rejects on buffer/texture
 * creation, and `assertSpecConstants()` cross-checks against the real
 * globals whenever a device is requested.
 */

/** WebGPU spec §GPUBufferUsage. */
export const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

/** WebGPU spec §GPUTextureUsage. */
export const TEXTURE_USAGE = {
  COPY_SRC: 0x0001,
  COPY_DST: 0x0002,
  TEXTURE_BINDING: 0x0004,
  STORAGE_BINDING: 0x0008,
  RENDER_ATTACHMENT: 0x0010,
} as const;

/** WebGPU spec §GPUShaderStage. */
export const SHADER_STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

/** WebGPU spec §GPUMapMode. */
export const MAP_MODE = {
  READ: 0x0001,
  WRITE: 0x0002,
} as const;

type FlagTable = Record<string, number>;

function matches(local: FlagTable, runtime: unknown, name: string): boolean {
  if (typeof runtime !== 'object' || runtime === null) {
    return true; // no globals here (node) — nothing to cross-check
  }
  const globals = runtime as Record<string, number>;
  for (const key of Object.keys(local)) {
    if (globals[key] !== local[key]) {
      throw new Error(
        `${name}.${key}: spec constant 0x${local[key].toString(16)} ≠ runtime 0x${(globals[key] ?? NaN).toString(16)}`,
      );
    }
  }
  return true;
}

/**
 * Cross-check the spec constants against the platform's globals. Call once
 * per device request; throws if a browser ever disagrees with the spec.
 */
export function assertSpecConstants(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  matches(BUFFER_USAGE, g.GPUBufferUsage, 'GPUBufferUsage');
  matches(TEXTURE_USAGE, g.GPUTextureUsage, 'GPUTextureUsage');
  matches(SHADER_STAGE, g.GPUShaderStage, 'GPUShaderStage');
  matches(MAP_MODE, g.GPUMapMode, 'GPUMapMode');
}
