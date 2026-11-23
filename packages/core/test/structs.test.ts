import { describe, expect, it } from 'vitest';
import {
  CULL_BACK,
  LIGHT_TYPE_OMNI,
  STRUCT_SIZES,
  writeBakeParameters,
  writeClusterAABB,
  writeDenoiseParams,
  writeLight,
  writeParams,
  writeRasterPushConstant,
  writeTriangle,
  writeVertex,
  type GpuBakeParameters,
  type GpuClusterAABB,
  type GpuDenoiseParams,
  type GpuLight,
  type GpuParams,
  type GpuRasterPushConstant,
  type GpuTriangle,
  type GpuVertex,
} from '../src/layout/structs.js';

/**
 * These tests pin the byte offsets documented in docs/DESIGN.md §4.
 * WGSL structs in packages/shaders/wgsl/*.wgsl must stay in lock-step.
 */
describe('GPU struct layouts (byte-exact with Godot)', () => {
  it('Vertex is 32 bytes with the documented field offsets', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.vertex);
    const view = new DataView(buf);
    const v: GpuVertex = {
      position: [1, 2, 3],
      normalZ: 4,
      uv: [5, 6],
      normalXY: [7, 8],
    };
    writeVertex(view, 0, v);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getFloat32(12, true)).toBe(4); // normal_z
    expect(view.getFloat32(16, true)).toBe(5); // uv.x
    expect(view.getFloat32(20, true)).toBe(6); // uv.y
    expect(view.getFloat32(24, true)).toBe(7); // normal_xy.x
    expect(view.getFloat32(28, true)).toBe(8); // normal_xy.y
  });

  it('Triangle is 48 bytes; u32 and f32 fields interleave correctly', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.triangle);
    const view = new DataView(buf);
    const t: GpuTriangle = {
      indices: [0x11111111, 0x22222222, 0x33333333],
      slice: 7,
      minBounds: [-1, -2, -3],
      cullMode: CULL_BACK,
      maxBounds: [4, 5, 6],
      pad1: 0,
    };
    writeTriangle(view, 0, t);
    expect(view.getUint32(0, true)).toBe(0x11111111);
    expect(view.getUint32(8, true)).toBe(0x33333333);
    expect(view.getUint32(12, true)).toBe(7); // slice
    expect(view.getFloat32(16, true)).toBe(-1); // min_bounds.x
    expect(view.getUint32(28, true)).toBe(CULL_BACK); // cull_mode
    expect(view.getFloat32(32, true)).toBe(4); // max_bounds.x
  });

  it('Light is 128 bytes with Godot field order', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.light);
    const view = new DataView(buf);
    const l: GpuLight = {
      position: [1, 2, 3],
      type: LIGHT_TYPE_OMNI,
      direction: [0, -1, 0],
      energy: 10,
      color: [1, 0.5, 0.25],
      size: 0.5,
      range: 20,
      attenuation: 1,
      cosSpotAngle: 0,
      invSpotAttenuation: 0,
      indirectEnergy: 1,
      shadowBlur: 1,
      staticBake: 1,
      pad: 0,
      areaWidth: [0, 0, 0, 0],
      areaHeight: [0, 0, 0, 0],
      areaTextureRect: [0, 0, 0, 0],
    };
    writeLight(view, 0, l);
    expect(view.getUint32(12, true)).toBe(LIGHT_TYPE_OMNI); // type after position
    expect(view.getFloat32(28, true)).toBe(10); // energy after direction
    expect(view.getFloat32(44, true)).toBe(0.5); // size after color
    expect(view.getFloat32(48, true)).toBe(20); // range
    expect(view.getFloat32(64, true)).toBe(1); // indirect_energy
    expect(view.getUint32(72, true)).toBe(1); // static_bake
    expect(view.getFloat32(80, true)).toBe(0); // area_width.x begins vec4 block
    expect(view.getFloat32(112, true)).toBe(0); // area_texture_rect.x
  });

  it('ClusterAABB is 32 bytes', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.clusterAABB);
    const view = new DataView(buf);
    const c: GpuClusterAABB = {
      minBounds: [0, 1, 2],
      pad0: 0,
      maxBounds: [3, 4, 5],
      pad1: 0,
    };
    writeClusterAABB(view, 0, c);
    expect(view.getFloat32(0, true)).toBe(0);
    expect(view.getFloat32(16, true)).toBe(3);
  });

  it('BakeParameters is 128 bytes; envTransform mat3x4 occupies bytes 48..95', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.bakeParameters);
    const view = new DataView(buf);
    const envTransform = Array.from({ length: 12 }, (_, i) => i + 1);
    const p: GpuBakeParameters = {
      worldSize: [10, 20, 30],
      bias: 0.05,
      toCellOffset: [-5, -6, -7],
      gridSize: 128,
      toCellSize: [12.8, 6.4, 4.2],
      lightCount: 3,
      envTransform,
      atlasSize: [2048, 2048],
      exposureNormalization: 1,
      bounces: 3,
      bounceIndirectEnergy: 1,
      shadowmaskLightIdx: -1,
      transparencyRays: 8,
      supersamplingFactor: 1,
    };
    writeBakeParameters(view, 0, p);
    expect(view.getFloat32(0, true)).toBe(10);
    expect(view.getFloat32(12, true)).toBe(Math.fround(0.05)); // bias (f32 rounding)
    expect(view.getInt32(28, true)).toBe(128);
    expect(view.getUint32(44, true)).toBe(3);
    expect(view.getFloat32(48, true)).toBe(1); // env_transform[0]
    expect(view.getFloat32(92, true)).toBe(12); // env_transform[11]
    expect(view.getInt32(96, true)).toBe(2048); // atlas_size.x
    expect(view.getUint32(108, true)).toBe(3); // bounces
    expect(view.getInt32(116, true)).toBe(-1); // shadowmask_light_idx
    expect(view.getFloat32(124, true)).toBe(1); // supersampling_factor
  });

  it('BakeParameters rejects malformed envTransform', () => {
    const view = new DataView(new ArrayBuffer(STRUCT_SIZES.bakeParameters));
    const p = {
      worldSize: [1, 1, 1],
      bias: 0,
      toCellOffset: [0, 0, 0],
      gridSize: 128,
      toCellSize: [1, 1, 1],
      lightCount: 0,
      envTransform: [1, 2, 3],
      atlasSize: [16, 16],
      exposureNormalization: 1,
      bounces: 0,
      bounceIndirectEnergy: 1,
      shadowmaskLightIdx: -1,
      transparencyRays: 8,
      supersamplingFactor: 1,
    } as unknown as GpuBakeParameters;
    expect(() => writeBakeParameters(view, 0, p)).toThrow();
  });

  it('Params (push-constant replacement) is 32 bytes', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.params);
    const view = new DataView(buf);
    const p: GpuParams = {
      atlasSlice: 2,
      rayCount: 512,
      rayFrom: 0,
      rayTo: 4,
      regionOfs: [64, 128],
      probeCount: 0,
      denoiserRange: 8,
    };
    writeParams(view, 0, p);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getUint32(4, true)).toBe(512);
    expect(view.getInt32(16, true)).toBe(64);
    expect(view.getInt32(20, true)).toBe(128);
    expect(view.getUint32(28, true)).toBe(8);
  });

  it('DenoiseParams is 32 bytes', () => {
    const buf = new ArrayBuffer(STRUCT_SIZES.denoiseParams);
    const view = new DataView(buf);
    const p: GpuDenoiseParams = {
      spatialBandwidth: 5,
      lightBandwidth: 1,
      albedoBandwidth: 1,
      normalBandwidth: 0.1,
      halfSearchWindow: 8,
      filterStrength: 10,
      sliceCount: 1,
      pad: 0,
    };
    writeDenoiseParams(view, 0, p);
    expect(view.getFloat32(0, true)).toBe(5);
    expect(view.getInt32(16, true)).toBe(8);
    expect(view.getUint32(24, true)).toBe(1);
  });

  it('RasterPushConstant (lm_raster.glsl Params) is 64 bytes, std430', () => {
    expect(STRUCT_SIZES.rasterPushConstant).toBe(64);
    const buf = new ArrayBuffer(STRUCT_SIZES.rasterPushConstant);
    const view = new DataView(buf);
    const p: GpuRasterPushConstant = {
      atlasSize: [1024, 1024],
      uvOffset: [-0.00048828125, -0.00048828125], // -0.5/1024
      toCellSize: [12.8, 42.66666793823242, 25.6],
      baseTriangle: 48,
      toCellOffset: [-2.1, 0, -2.5],
      bias: 0.01,
      gridSize: [128, 128, 128],
      pad2: 0,
    };
    writeRasterPushConstant(view, 0, p);
    // Offsets per docs/DESIGN.md §4.8 (std430: vec2@0, vec2@8, vec3@16,
    // u32@28, vec3@32, f32@44, ivec3@48, u32@60).
    expect(view.getFloat32(0, true)).toBe(1024);
    expect(view.getFloat32(4, true)).toBe(1024);
    expect(view.getFloat32(8, true)).toBeCloseTo(-0.5 / 1024, 10);
    expect(view.getFloat32(16, true)).toBeCloseTo(12.8, 6);
    expect(view.getFloat32(24, true)).toBeCloseTo(25.6, 6);
    expect(view.getUint32(28, true)).toBe(48);
    expect(view.getFloat32(32, true)).toBeCloseTo(-2.1, 6);
    expect(view.getFloat32(44, true)).toBeCloseTo(0.01, 8);
    expect(view.getInt32(48, true)).toBe(128);
    expect(view.getInt32(56, true)).toBe(128);
    expect(view.getUint32(60, true)).toBe(0);
  });
});
