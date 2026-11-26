/**
 * Port of the M2 GPU stages of `LightmapperRD::bake`:
 *   STEP 3  `_raster_geometry` — raster the scene to UV2 atlas coords
 *           (position/unocclude/normal G-buffer) and
 *   the UNOCCLUDE compute dispatch (`lm_compute.glsl` version `unocclude`).
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0 — texture creation block,
 * `base_uniforms` assembly, `_raster_geometry` (pipeline/draw-list flow,
 * per-slice push constants), unocclude pipeline + dispatch loop.
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Faithfulness notes (deltas are ADR'd):
 *  - ADR-0004: upstream's single 3-target raster pass (48 B/sample) is two
 *    passes A {position, unocclude} / B {normal}; each pass clears depth to
 *    1.0 exactly like the single upstream pass (identical geometry ⇒
 *    identical depth outcomes across the split).
 *  - ADR-0007: the wireframe re-draw is an edge-expanded draw (second
 *    vertex entry point of lm_raster.wgsl); the constant gl_Position.z
 *    keeps it out of already-filled texels under depth-compare LESS.
 *  - ADR-0005: cluster buffers are merged into one binding-12 buffer; the
 *    AABB region offset goes to the kernel as a pipeline override constant.
 *  - ADR-0003: raster/unocclude push constants live in the group-2 Params
 *    ring buffer (dynamic offsets) instead of API push constants.
 *  - PORT: unocclude is a ping-pong (sampled sources → write-only
 *    destinations) instead of upstream's read_write rgba32f images, which
 *    not every implementation supports; the destination textures become
 *    the canonical post-unocclude textures (no copies needed).
 *  - Ordering: Godot ends the draw list, then begins the compute list —
 *    "no barrier, let them run all together" per slice. WebGPU's automatic
 *    pass-ordering handles the render→compute dependency in one submit.
 */

import { lmRaster, lmUnocclude } from '@lightmapper/shaders';
import { createBaseBindGroup, createBaseBindGroupLayout, createBaseSamplers, createParamsBindGroup } from '../bind-groups.js';
import { ParamsRing } from '../params-ring.js';
import { readbackSlice, type ReadbackImage16F, type ReadbackImage32F } from '../readback.js';
import { GpuResourceRegistry } from '../registry.js';
import { STRUCT_SIZES, writeBakeParameters, writeParams, writeRasterPushConstant, type GpuBakeParameters } from '../../layout/structs.js';
import type { ClusterData } from '../../accel/accel.js';
import type { AccelStructures } from '../../accel/accel.js';

/** Everything the GPU stages need (packed by the bake orchestrator). */
export interface GBufferStageInputs {
  accel: AccelStructures;
  /** Merged cluster indices + AABBs (ADR-0005) with its AABB element offset. */
  clusterData: ClusterData;
  /** Packed `Light[]` bytes (scene/lights.ts `packLightsBuffer`). */
  lightsBytes: ArrayBuffer;
  /** Packed vec4 probe positions, or null (a 16 B dummy is uploaded). */
  probesBytes: ArrayBuffer | null;
  /** Fully populated BakeParameters (world_size, to_cell_*, grid_size…). */
  bakeParameters: GpuBakeParameters;
  atlasSize: [number, number];
  atlasSlices: number;
  /** Atlas-assembled albedo slices (atlas/blit.ts), rgba8 per slice. */
  albedoSlices: Uint8Array<ArrayBuffer>[];
  /** Atlas-assembled emission slices, rgbah words per slice. */
  emissionSlices: Uint16Array<ArrayBuffer>[];
  /** `push_constant.denoiser_range` value (Godot: `useDenoiser ? range : 1`). */
  denoiserRange: number;
}

export interface GBufferStageOutputs {
  /** Position atlas per slice (rgba32f; alpha = coverage, 1 = filled). */
  position: ReadbackImage32F[];
  /** Unocclude mask per slice (rgba32f; r = mask after the kernel). */
  unocclude: ReadbackImage32F[];
  /** Normal atlas per slice (rgbah words — Godot's `1_normal_*.exr` form). */
  normal: ReadbackImage16F[];
  /** Live G-buffer textures (for later stages: primary samples them in M3). */
  textures: {
    position: GPUTexture;
    normal: GPUTexture;
    unocclude: GPUTexture;
  };
  /** Destroy every resource this stage created. */
  destroy: () => void;
}

/** Run the M2 G-buffer stages (raster split A/B + edge expansion + unocclude). */
export async function runGBufferStage(
  device: GPUDevice,
  inputs: GBufferStageInputs,
): Promise<GBufferStageOutputs> {
  const registry = new GpuResourceRegistry(device);
  const [width, height] = inputs.atlasSize;
  const slices = inputs.atlasSlices;

  // WebGPU validation errors do NOT throw — invalid commands become silent
  // no-ops. Push an error scope around the whole stage so any validation
  // failure surfaces as a rejected promise instead of an empty bake.
  device.pushErrorScope('validation');

  /* --- textures ------------------------------------------------------ */

  const albedoTex = registry.texture({
    label: 'lightmapper-albedo',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const emissionTex = registry.texture({
    label: 'lightmapper-emission',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  for (let i = 0; i < slices; i++) {
    device.queue.writeTexture(
      { texture: albedoTex, origin: { x: 0, y: 0, z: i } },
      inputs.albedoSlices[i],
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.writeTexture(
      { texture: emissionTex, origin: { x: 0, y: 0, z: i } },
      inputs.emissionSlices[i],
      { bytesPerRow: width * 8, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
  }

  // "this will be rastered to" — usage mirrors Godot's texture block.
  const rasterUsage =
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING;
  const positionTex = registry.texture({
    label: 'lightmapper-position',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba32float',
    usage: rasterUsage,
  });
  const unoccludeTex = registry.texture({
    label: 'lightmapper-unocclude',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba32float',
    usage: rasterUsage,
  });
  const normalTex = registry.texture({
    label: 'lightmapper-normal',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba16float',
    usage: rasterUsage,
  });
  const depthTex = registry.texture({
    label: 'lightmapper-depth',
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  /* --- buffers ------------------------------------------------------- */

  const bakeParamsBytes = new ArrayBuffer(STRUCT_SIZES.bakeParameters);
  writeBakeParameters(new DataView(bakeParamsBytes), 0, inputs.bakeParameters);

  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const bakeParamsBuffer = registry.bufferWithData(
    { label: 'lightmapper-bake-params', size: STRUCT_SIZES.bakeParameters, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
    bakeParamsBytes,
  );
  const verticesBuffer = registry.bufferWithData(
    { label: 'lightmapper-vertices', size: inputs.accel.vertices.byteLength, usage: storage },
    inputs.accel.vertices,
  );
  const trianglesBuffer = registry.bufferWithData(
    { label: 'lightmapper-triangles', size: inputs.accel.triangles.byteLength, usage: storage },
    inputs.accel.triangles,
  );
  const triangleIndicesBuffer = registry.bufferWithData(
    { label: 'lightmapper-triangle-indices', size: inputs.accel.triangleIndices.byteLength, usage: storage },
    inputs.accel.triangleIndices,
  );
  const lightsBuffer = registry.bufferWithData(
    { label: 'lightmapper-lights', size: inputs.lightsBytes.byteLength, usage: storage },
    inputs.lightsBytes,
  );
  const seamsBuffer = registry.bufferWithData(
    { label: 'lightmapper-seams', size: inputs.accel.seams.byteLength, usage: storage },
    inputs.accel.seams,
  );
  // Probes may be empty — WebGPU buffers must be non-zero sized.
  const probesBytes = inputs.probesBytes ?? new ArrayBuffer(16);
  const probesBuffer = registry.bufferWithData(
    { label: 'lightmapper-probes', size: Math.max(16, probesBytes.byteLength), usage: storage },
    probesBytes,
  );
  const clusterDataBuffer = registry.bufferWithData(
    { label: 'lightmapper-cluster-data', size: inputs.clusterData.buffer.byteLength, usage: storage },
    inputs.clusterData.buffer,
  );

  // Grid texture (rg32uint, grid_size³). The dense grid data is only
  // uploadable when a row is 256 B aligned (grid_size 128 → 1024 B rows;
  // other sizes would need padded staging buffers).
  if ((inputs.accel.gridSize * 8) % 256 !== 0) {
    throw new Error(
      `runGBufferStage: grid_size ${inputs.accel.gridSize} rows are not 256 B aligned for upload`,
    );
  }
  const gridTex = registry.texture({
    label: 'lightmapper-grid',
    dimension: '3d',
    size: { width: inputs.accel.gridSize, height: inputs.accel.gridSize, depthOrArrayLayers: inputs.accel.gridSize },
    format: 'rg32uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: gridTex },
    inputs.accel.grid,
    { bytesPerRow: inputs.accel.gridSize * 8, rowsPerImage: inputs.accel.gridSize },
    { width: inputs.accel.gridSize, height: inputs.accel.gridSize, depthOrArrayLayers: inputs.accel.gridSize },
  );

  /* --- bind groups / pipelines ---------------------------------------- */

  const baseLayout = createBaseBindGroupLayout(device);
  const samplers = createBaseSamplers(device);
  const baseBindGroup = createBaseBindGroup(device, baseLayout, {
    bakeParams: bakeParamsBuffer,
    vertices: verticesBuffer,
    triangles: trianglesBuffer,
    triangleIndices: triangleIndicesBuffer,
    lights: lightsBuffer,
    seams: seamsBuffer,
    probes: probesBuffer,
    grid: gridTex,
    albedo: albedoTex,
    emission: emissionTex,
    clusterData: clusterDataBuffer,
  }, samplers);

  const ring = new ParamsRing(device);
  const { layout: paramsLayout, bindGroup: paramsBindGroup } = createParamsBindGroup(device, ring);

  const rasterModule = device.createShaderModule({ label: 'lm_raster', code: lmRaster });
  const depthStencil: GPUDepthStencilState = {
    format: 'depth32float',
    depthWriteEnabled: true,
    depthCompare: 'less', // "so it does render same pixel twice"
  };
  // Pipeline-layout array index == @group() index. The raster kernel uses
  // groups 0 and 2 (canonical map, DESIGN §5), so group 1 gets an empty
  // placeholder layout — otherwise the pipelines fail validation and
  // WebGPU silently drops every draw (validation errors don't throw).
  const emptyLayout = device.createBindGroupLayout({ label: 'lightmapper-empty-g1', entries: [] });
  const emptyBindGroup = device.createBindGroup({ label: 'lightmapper-empty-g1', layout: emptyLayout, entries: [] });
  const rasterLayout = device.createPipelineLayout({
    bindGroupLayouts: [baseLayout, emptyLayout, paramsLayout],
  });
  const makeRasterPipeline = (
    vertexEntry: 'vs_main' | 'vs_edges_main',
    fragmentEntry: 'fa_main' | 'fb_main',
    targets: GPUColorTargetState[],
  ): GPURenderPipeline =>
    device.createRenderPipeline({
      label: `lm_raster-${vertexEntry}-${fragmentEntry}`,
      layout: rasterLayout,
      vertex: { module: rasterModule, entryPoint: vertexEntry },
      fragment: { module: rasterModule, entryPoint: fragmentEntry, targets },
      // RD::PipelineRasterizationState defaults: no culling (both sides of
      // every surface are rasterized), so frontFace is irrelevant here.
      // NOTE for future culling passes: Godot's default is
      // POLYGON_FRONT_FACE_CLOCKWISE in framebuffer space, but the Y flip
      // in lm_raster.wgsl mirrors the winding — use frontFace 'ccw' then.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });

  // ADR-0004: pass A {position rgba32f + unocclude rgba32f} = 32 B/sample.
  const targetsA: GPUColorTargetState[] = [
    { format: 'rgba32float' },
    { format: 'rgba32float' },
  ];
  // Pass B {normal rgba16f}.
  const targetsB: GPUColorTargetState[] = [{ format: 'rgba16float' }];

  const fillA = makeRasterPipeline('vs_main', 'fa_main', targetsA);
  const fillB = makeRasterPipeline('vs_main', 'fb_main', targetsB);
  const wireA = makeRasterPipeline('vs_edges_main', 'fa_main', targetsA);
  const wireB = makeRasterPipeline('vs_edges_main', 'fb_main', targetsB);

  // Unocclude pipeline (ADR-0005: pass the merged-buffer AABB offset).
  // PORT: ping-pong instead of upstream's read_write rgba32f images — the
  // kernel samples the raster outputs and stores into fresh destinations
  // (see lm_unocclude.wgsl header). The destinations become the canonical
  // post-unocclude textures handed to later stages.
  const unoccludeModule = device.createShaderModule({ label: 'lm_unocclude', code: lmUnocclude });
  const positionOutTex = registry.texture({
    label: 'lightmapper-position-out',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba32float',
    usage: rasterUsage,
  });
  const unoccludeOutTex = registry.texture({
    label: 'lightmapper-unocclude-out',
    size: { width, height, depthOrArrayLayers: slices },
    format: 'rgba32float',
    usage: rasterUsage,
  });
  const unoccludeGroup1Layout = device.createBindGroupLayout({
    label: 'lm_unocclude-io',
    entries: [
      // rgba32float is only sampleable (never filterable) in core WebGPU.
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d-array' } },
    ],
  });
  const unoccludeBindGroup1 = device.createBindGroup({
    label: 'lm_unocclude-io',
    layout: unoccludeGroup1Layout,
    entries: [
      { binding: 0, resource: positionTex.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: unoccludeTex.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: positionOutTex.createView({ dimension: '2d-array' }) },
      { binding: 3, resource: unoccludeOutTex.createView({ dimension: '2d-array' }) },
    ],
  });
  const unoccludePipeline = device.createComputePipeline({
    label: 'lm_unocclude',
    layout: device.createPipelineLayout({ bindGroupLayouts: [baseLayout, unoccludeGroup1Layout, paramsLayout] }),
    compute: {
      module: unoccludeModule,
      entryPoint: 'main',
      constants: { cluster_aabb_offset_u32: inputs.clusterData.aabbOffsetU32 },
    },
  });

  /* --- STEP 3: raster geometry (split passes, per slice) ---------------- */

  const encoder = device.createCommandEncoder({ label: 'lightmapper-gbuffer' });

  const clearValue = { r: 0, g: 0, b: 0, a: 0 };
  const groupX = Math.ceil(width / 8);
  const groupY = Math.ceil(height / 8);
  let triangleOffset = 0;
  const sliceParamOffsets: number[] = [];

  for (let i = 0; i < slices; i++) {
    // RasterPushConstant per slice (Godot writes it once per draw list;
    // the same bytes serve all four draws of the slice).
    const rpBytes = new ArrayBuffer(STRUCT_SIZES.rasterPushConstant);
    const rp = new DataView(rpBytes);
    writeRasterPushConstant(rp, 0, {
      atlasSize: [width, height],
      // Half pixel offset is required so the rasterizer doesn't output face
      // edges directly aligned into pixels (godotengine/godot#69126).
      uvOffset: [-0.5 / width, -0.5 / height],
      toCellSize: inputs.bakeParameters.toCellSize,
      baseTriangle: triangleOffset,
      toCellOffset: inputs.bakeParameters.toCellOffset,
      bias: inputs.bakeParameters.bias,
      gridSize: [
        inputs.bakeParameters.gridSize,
        inputs.bakeParameters.gridSize,
        inputs.bakeParameters.gridSize,
      ],
      pad2: 0,
    });
    const rasterOffset = ring.next(rpBytes);

    const positionView = positionTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 });
    const unoccludeView = unoccludeTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 });
    const normalView = normalTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 });
    const depthView = depthTex.createView();
    const vertexCount = inputs.accel.sliceTriangleCount[i] * 3;

    const drawInto = (pass: GPURenderPassEncoder, fill: GPURenderPipeline, wire: GPURenderPipeline): void => {
      //draw opaque
      pass.setPipeline(fill);
      pass.setBindGroup(0, baseBindGroup);
      pass.setBindGroup(1, emptyBindGroup); // placeholder for the canonical group 2
      pass.setBindGroup(2, paramsBindGroup, [rasterOffset]);
      pass.draw(vertexCount);
      //draw wire (ADR-0007: edge-expanded emulation)
      pass.setPipeline(wire);
      pass.setBindGroup(0, baseBindGroup);
      pass.setBindGroup(1, emptyBindGroup);
      pass.setBindGroup(2, paramsBindGroup, [rasterOffset]);
      pass.draw(vertexCount);
    };

    // Pass A — {position, unocclude} + depth (cleared per pass like the
    // single upstream pass; identical geometry yields identical depth).
    const passA = encoder.beginRenderPass({
      label: `lm_raster-A-${i}`,
      colorAttachments: [
        { view: positionView, clearValue, loadOp: 'clear', storeOp: 'store' },
        { view: unoccludeView, clearValue, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    drawInto(passA, fillA, wireA);
    passA.end();

    // Pass B — {normal} + depth.
    const passB = encoder.beginRenderPass({
      label: `lm_raster-B-${i}`,
      colorAttachments: [{ view: normalView, clearValue, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    drawInto(passB, fillB, wireB);
    passB.end();

    /* --- UNOCCLUDE (same command buffer; per-slice dispatches) --------- */

    const pBytes = new ArrayBuffer(STRUCT_SIZES.params);
    writeParams(new DataView(pBytes), 0, {
      atlasSlice: i,
      rayCount: 0,
      rayFrom: 0,
      rayTo: 0,
      regionOfs: [0, 0],
      probeCount: 0,
      denoiserRange: inputs.denoiserRange,
    });
    sliceParamOffsets.push(ring.next(pBytes));

    triangleOffset += inputs.accel.sliceTriangleCount[i];
  }

  const computePass = encoder.beginComputePass({ label: 'lm_unocclude' });
  computePass.setPipeline(unoccludePipeline);
  computePass.setBindGroup(0, baseBindGroup);
  computePass.setBindGroup(1, unoccludeBindGroup1);
  for (let i = 0; i < slices; i++) {
    computePass.setBindGroup(2, paramsBindGroup, [sliceParamOffsets[i]]);
    computePass.dispatchWorkgroups(groupX, groupY);
    //no barrier, let them run all together
  }
  computePass.end();

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    throw new Error(`G-buffer stage GPU validation error: ${validationError.message}`);
  }

  // The raster-stage sources are dead once unocclude has run — free them
  // now (ARCHITECTURE §5: destroy targets at their last consumer).
  registry.destroyTexture(positionTex);
  registry.destroyTexture(unoccludeTex);

  /* --- readback (DEBUG_TEXTURES equivalents) --------------------------- */

  const position: ReadbackImage32F[] = [];
  const unocclude: ReadbackImage32F[] = [];
  const normal: ReadbackImage16F[] = [];
  for (let i = 0; i < slices; i++) {
    position.push((await readbackSlice(device, positionOutTex, 'rgba32float', i)) as ReadbackImage32F);
    unocclude.push((await readbackSlice(device, unoccludeOutTex, 'rgba32float', i)) as ReadbackImage32F);
    normal.push((await readbackSlice(device, normalTex, 'rgba16float', i)) as ReadbackImage16F);
  }

  return {
    position,
    unocclude,
    normal,
    // Canonical post-unocclude textures for later stages (M3 samples these).
    textures: { position: positionOutTex, normal: normalTex, unocclude: unoccludeOutTex },
    destroy: () => {
      ring.destroy();
      registry.destroyAll();
    },
  };
}
