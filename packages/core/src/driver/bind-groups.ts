/**
 * The canonical group-0 ("base set") bind group — the port of Godot's
 * `base_uniforms` assembly in `LightmapperRD::bake`
 * (godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0). License: MIT (see NOTICE.md).
 *
 * One layout + one bind group is shared by every kernel (and the render
 * passes), mirroring `lm_common_inc.glsl`'s set 0 with the ADR-0005 delta:
 * bindings 12/13 are merged into `cluster_data` at binding 12.
 *
 * Entries a kernel does not statically use are simply absent from that
 * pipeline's interface — WebGPU allows a bind group to supply more entries
 * than the pipeline consumes, so the canonical set stays valid everywhere.
 */

import { SHADER_STAGE } from './gpu-constants.js';

export interface BaseSetResources {
  /** BakeParameters uniform (128 B, GpuBakeParameters). */
  bakeParams: GPUBuffer;
  /** Vertex[] storage (read). */
  vertices: GPUBuffer;
  /** Triangle[] storage (read), sorted by slice. */
  triangles: GPUBuffer;
  /** u32[] triangle indices storage (read). */
  triangleIndices: GPUBuffer;
  /** Light[] storage (read). */
  lights: GPUBuffer;
  /** Seam[] storage (read); the always-present 32 B dummy when empty. */
  seams: GPUBuffer;
  /** vec4[] probe positions storage (read). */
  probes: GPUBuffer;
  /** rg32uint 128³ grid texture (texture_3d). */
  grid: GPUTexture;
  /** rgba8unorm 2D array albedo atlas (binding 8). */
  albedo: GPUTexture;
  /** rgba16float 2D array emission atlas (binding 9). */
  emission: GPUTexture;
  /** Merged cluster indices + ClusterAABBs (ADR-0005, binding 12). */
  clusterData: GPUBuffer;
}

// Shader-stage visibility bits come from the shared spec-constant table
// (no runtime globals: the module must import cleanly in node tests).
const ALL_STAGES = SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT | SHADER_STAGE.COMPUTE;
const NON_VERTEX = SHADER_STAGE.FRAGMENT | SHADER_STAGE.COMPUTE;


/** Create the canonical group-0 bind group layout (DESIGN §5). */
export function createBaseBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'lightmapper-base-set',
    entries: [
      { binding: 0, visibility: ALL_STAGES, buffer: { type: 'uniform', minBindingSize: 128 } },
      { binding: 1, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: SHADER_STAGE.COMPUTE, texture: { sampleType: 'uint', viewDimension: '3d' } },
      { binding: 8, visibility: NON_VERTEX, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 9, visibility: NON_VERTEX, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 10, visibility: NON_VERTEX, sampler: { type: 'filtering' } },
      { binding: 11, visibility: NON_VERTEX, sampler: { type: 'filtering' } },
      { binding: 12, visibility: ALL_STAGES, buffer: { type: 'read-only-storage' } },
    ],
  });
}

/** Create the samplers Godot pairs with the base set. */
export function createBaseSamplers(device: GPUDevice): { linearSampler: GPUSampler; areaLightSampler: GPUSampler } {
  // RD::SamplerState defaults are CLAMP_TO_EDGE for repeat_u/v/w; the
  // lightmapper overrides mag/min to LINEAR and max_lod = 0. On single-mip
  // textures with lodMaxClamp 0, a 'nearest' mip filter is the exact
  // equivalent of "no mipmapping" ('none' is newer than @webgpu/types).
  const linear = {
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
    lodMinClamp: 0,
    lodMaxClamp: 0,
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  } as const satisfies GPUSamplerDescriptor;
  return {
    linearSampler: device.createSampler({ label: 'lightmapper-linear', ...linear }),
    // The area-light atlas sampler additionally sets clamp-to-edge — which
    // is already the default here (area lights are post-M6).
    areaLightSampler: device.createSampler({ label: 'lightmapper-area-atlas', ...linear }),
  };
}

/** Create the canonical group-0 bind group. */
export function createBaseBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  res: BaseSetResources,
  samplers?: { linearSampler: GPUSampler; areaLightSampler: GPUSampler },
): GPUBindGroup {
  const s = samplers ?? createBaseSamplers(device);
  return device.createBindGroup({
    label: 'lightmapper-base-set',
    layout,
    entries: [
      { binding: 0, resource: { buffer: res.bakeParams } },
      { binding: 1, resource: { buffer: res.vertices } },
      { binding: 2, resource: { buffer: res.triangles } },
      { binding: 3, resource: { buffer: res.triangleIndices } },
      { binding: 4, resource: { buffer: res.lights } },
      { binding: 5, resource: { buffer: res.seams } },
      { binding: 6, resource: { buffer: res.probes } },
      { binding: 7, resource: res.grid.createView({ dimension: '3d' }) },
      { binding: 8, resource: res.albedo.createView({ dimension: '2d-array' }) },
      { binding: 9, resource: res.emission.createView({ dimension: '2d-array' }) },
      { binding: 10, resource: s.linearSampler },
      { binding: 11, resource: s.areaLightSampler },
      { binding: 12, resource: { buffer: res.clusterData } },
    ],
  });
}

/**
 * Group 2 — the per-dispatch `Params` uniform with dynamic offset
 * (ADR-0003). One layout + one bind group serve every kernel and render
 * pass. The binding's `size` is one ring slot (it must be set explicitly —
 * without it the bound range is the whole buffer and every non-zero
 * dynamic offset is out of bounds); `minBindingSize` covers the largest
 * push constant in the port (RasterPushConstant, 64 B; compute Params is
 * 32 B).
 */
export function createParamsBindGroup(device: GPUDevice, ring: { buffer: GPUBuffer; slotBytes: number }): {
  layout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
} {
  const layout = device.createBindGroupLayout({
    label: 'lightmapper-params',
    entries: [
      {
        binding: 0,
        visibility: ALL_STAGES,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
      },
    ],
  });
  const bindGroup = device.createBindGroup({
    label: 'lightmapper-params',
    layout,
    entries: [{ binding: 0, resource: { buffer: ring.buffer, size: ring.slotBytes } }],
  });
  return { layout, bindGroup };
}
