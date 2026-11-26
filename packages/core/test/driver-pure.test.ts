import { describe, expect, it } from 'vitest';
import {
  CULL_BACK,
  CULL_DISABLED,
  CULL_FRONT,
  STRUCT_SIZES,
  BUFFER_USAGE,
  TEXTURE_USAGE,
  assertSpecConstants,
  cullModeValue,
  envTransform12,
  lightmapImageSize,
} from '../src/index.js';
import { GpuResourceRegistry } from '../src/driver/registry.js';
import { ParamsRing } from '../src/driver/params-ring.js';
import { align256 } from '../src/driver/readback.js';

/**
 * Unit tests for the GPU-free parts of the M2 driver skeleton: pure helpers
 * that feed GPU buffers (wire format / truncation quirks) and the ring /
 * registry bookkeeping, exercised against a minimal fake GPUDevice.
 */

describe('driver pure helpers', () => {
  it('lightmapImageSize: Godot default 64×64 and Vector2i×float truncation', () => {
    expect(lightmapImageSize(undefined, 1)).toEqual({ width: 64, height: 64 });
    expect(lightmapImageSize([128, 96], 1)).toEqual({ width: 128, height: 96 });
    // Size2i(Size2(hint) * supersampling) truncates per axis.
    expect(lightmapImageSize([64, 64], 1.5)).toEqual({ width: 96, height: 96 });
    expect(lightmapImageSize([65, 65], 1.5)).toEqual({ width: 97, height: 97 }); // 97.5 → 97
    expect(lightmapImageSize([100, 100], 2)).toEqual({ width: 200, height: 200 });
    // ERR_FAIL_COND_V(lightmap_size.x == 0 …): clamp to at least one texel.
    expect(lightmapImageSize([2, 2], 0.4)).toEqual({ width: 1, height: 1 });
  });

  it('envTransform12: column-major mat3x4 exactly as the C++ fills it', () => {
    // bake_parameters.env_transform[0..2] = rows[*][0] (column 0), then a
    // 0 pad, likewise for columns 1 and 2. Our Mat3 is three column vectors.
    const cols = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(envTransform12(cols)).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    // Default: identity.
    expect(envTransform12(undefined)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('cullModeValue: Godot LightmapperRD::CullMode GPU values', () => {
    expect(cullModeValue('none')).toBe(CULL_DISABLED);
    expect(cullModeValue('front')).toBe(CULL_FRONT);
    expect(cullModeValue('back')).toBe(CULL_BACK);
    expect([CULL_DISABLED, CULL_FRONT, CULL_BACK]).toEqual([0, 1, 2]);
  });

  it('align256: readback row alignment', () => {
    expect(align256(0)).toBe(0);
    expect(align256(1)).toBe(256);
    expect(align256(256)).toBe(256);
    expect(align256(1025)).toBe(1280);
    expect(align256(16384)).toBe(16384);
  });

  it('assertSpecConstants: passes without globals, rejects a platform that disagrees', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { b: g.GPUBufferUsage, t: g.GPUTextureUsage, s: g.GPUShaderStage, m: g.GPUMapMode };
    try {
      delete g.GPUBufferUsage; delete g.GPUTextureUsage; delete g.GPUShaderStage; delete g.GPUMapMode;
      expect(() => assertSpecConstants()).not.toThrow();
      g.GPUBufferUsage = { ...BUFFER_USAGE };
      g.GPUTextureUsage = { ...TEXTURE_USAGE, RENDER_ATTACHMENT: 0x20 }; // wrong
      expect(() => assertSpecConstants()).toThrow(/GPUTextureUsage\.RENDER_ATTACHMENT/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[`GPU${k === 'b' ? 'BufferUsage' : k === 't' ? 'TextureUsage' : k === 's' ? 'ShaderStage' : 'MapMode'}`];
        else g[`GPU${k === 'b' ? 'BufferUsage' : k === 't' ? 'TextureUsage' : k === 's' ? 'ShaderStage' : 'MapMode'}`] = v;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Minimal fake device: only what the ring / registry touch.           */
/* ------------------------------------------------------------------ */

interface FakeGpuObject {
  destroyed: number;
}

/** A tracked fake GPU object whose destroy() bumps its own counter. */
function fakeObject(list: FakeGpuObject[]): FakeGpuObject & { destroy: () => void } {
  const obj: FakeGpuObject = { destroyed: 0 };
  list.push(obj);
  return Object.assign(obj, { destroy: () => void obj.destroyed++ });
}

function fakeDevice(): {
  device: GPUDevice;
  buffers: FakeGpuObject[];
  textures: FakeGpuObject[];
  writes: Array<{ size: number; offset: number }>;
} {
  const buffers: FakeGpuObject[] = [];
  const textures: FakeGpuObject[] = [];
  const writes: Array<{ size: number; offset: number }> = [];
  const device = {
    createBuffer: () => fakeObject(buffers),
    createTexture: () => fakeObject(textures),
    queue: {
      writeBuffer: (_buffer: unknown, offset: number, data: unknown, _dataOffset?: number, size?: number) => {
        writes.push({ offset, size: size ?? (data as ArrayBuffer).byteLength });
      },
    },
  } as unknown as GPUDevice;
  return { device, buffers, textures, writes };
}

describe('ParamsRing (ADR-0003)', () => {
  it('hands out 256-byte-aligned dynamic offsets and writes whole slots', () => {
    const { device, writes } = fakeDevice();
    const ring = new ParamsRing(device, 4);
    expect(ring.next(new ArrayBuffer(64))).toBe(0);
    expect(ring.next(new ArrayBuffer(32))).toBe(256);
    expect(ring.next(new ArrayBuffer(64))).toBe(512);
    expect(writes.map((w) => [w.offset, w.size])).toEqual([[0, 256], [256, 256], [512, 256]]);
  });

  it('wraps after its capacity and says so beforehand', () => {
    const { device } = fakeDevice();
    const ring = new ParamsRing(device, 2);
    expect(ring.next(new ArrayBuffer(32))).toBe(0);
    expect(ring.willWrap).toBe(false); // next write still goes to slot 1
    expect(ring.next(new ArrayBuffer(32))).toBe(256);
    expect(ring.willWrap).toBe(true); // next write reuses slot 0 → sync first
    expect(ring.next(new ArrayBuffer(32))).toBe(0);
  });

  it('rejects structs that do not fit a slot', () => {
    const { device } = fakeDevice();
    const ring = new ParamsRing(device, 1);
    expect(() => ring.next(new ArrayBuffer(STRUCT_SIZES.rasterPushConstant))).not.toThrow();
    expect(() => ring.next(new ArrayBuffer(257))).toThrow(/must fit/);
  });

  it('zero-fills the tail of a slot (params structs are shorter than 256 B)', () => {
    const { device } = fakeDevice();
    const ring = new ParamsRing(device, 1);
    let seen: Uint8Array | null = null;
    (device.queue as unknown as { writeBuffer: (b: unknown, o: number, d: ArrayBuffer, off?: number, size?: number) => void })
      .writeBuffer = (_b, _o, d, off, size) => {
      seen = new Uint8Array(d, off ?? 0, size ?? d.byteLength);
    };
    ring.next(new Uint8Array([0xab, 0xcd]));
    expect(seen).not.toBeNull();
    expect(seen!.length).toBe(256);
    expect(seen![0]).toBe(0xab);
    expect(seen![1]).toBe(0xcd);
    expect(seen!.subarray(2).every((b) => b === 0)).toBe(true);
  });
});

describe('GpuResourceRegistry', () => {
  it('tracks and destroys every created resource exactly once', () => {
    const { device, buffers, textures } = fakeDevice();
    const registry = new GpuResourceRegistry(device);
    registry.buffer({ size: 16, usage: BUFFER_USAGE.UNIFORM });
    const texture = registry.texture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE.TEXTURE_BINDING,
    });
    registry.bufferWithData({ size: 16, usage: BUFFER_USAGE.STORAGE }, new ArrayBuffer(16));
    expect(registry.size).toBe(3);
    expect(buffers).toHaveLength(2);
    expect(textures).toHaveLength(1);

    registry.destroyTexture(texture);
    expect(textures[0]!.destroyed).toBe(1);
    expect(registry.size).toBe(2);
    registry.destroyTexture(texture); // idempotent
    expect(textures[0]!.destroyed).toBe(1);

    registry.destroyAll();
    for (const b of buffers) expect(b.destroyed).toBe(1);
    expect(registry.size).toBe(0);
  });

  it('refuses to create resources after destroyAll', () => {
    const { device } = fakeDevice();
    const registry = new GpuResourceRegistry(device);
    registry.destroyAll();
    expect(() => registry.buffer({ size: 16, usage: 0 })).toThrow(/destroyAll/);
  });
});
