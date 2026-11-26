/**
 * The M2 bake orchestrator — the G-buffer subset of `LightmapperRD::bake`
 * (godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0). License: MIT (see NOTICE.md).
 *
 * Stages ported here (matching the C++ flow order):
 *   STEP 1  per-mesh lightmap image sizing + `bake_render_uv2` replacement
 *           (@lightmapper/gbuffer renders materials onto UV2) + atlas
 *           layout (`blitMeshesIntoAtlas`) + slice blitting;
 *   STEP 2  acceleration structures (worker, M1 port);
 *   then    BakeParameters/global buffer assembly and the M2 GPU stages
 *           (`runGBufferStage`: raster split passes + unocclude).
 *
 * Progress fractions copy Godot's `p_step_function` calls (0.1 atlas,
 * 0.2 blit, 0.3+0.1·i plotting, 0.47 shaders, 0.49 unocclude) — they
 * define the UX. Returning `false` from `onProgress` aborts
 * (BAKE_ERROR_USER_ABORTED).
 */

import { blitMeshesIntoAtlas, type AtlasLayoutResult } from '../atlas/pack.js';
import { blitAtlasSlices, type MeshAtlasImages } from '../atlas/blit.js';
import { packClusterData, type AccelMesh, type AccelStructures } from '../accel/accel.js';
import { AccelWorkerHost } from '../accel/accel-worker-client.js';
import { assembleLights, packLightsBuffer } from '../scene/lights.js';
import type { BakeScene } from '../scene/bake-scene.js';
import { GRID_SIZE } from '../accel/accel.js';
import { CULL_BACK, CULL_DISABLED, CULL_FRONT, type GpuBakeParameters } from '../layout/structs.js';
import { requestBakeDevice, raceDeviceLost } from './device.js';
import { runGBufferStage, type GBufferStageOutputs } from './stages/gbuffer.js';
import type { ReadbackImage16F, ReadbackImage32F } from './readback.js';
import type { Aabb } from '../math/aabb.js';

const fr = Math.fround;

/** Godot default when a mesh carries no lightmap size hint (lightmap_gi.cpp). */
export const DEFAULT_LIGHTMAP_SIZE: readonly [number, number] = [64, 64];

/** Fixed performance knob defaults (docs/DESIGN.md §2). */
export const MAX_TRANSPARENCY_RAYS = 8;

export interface BakeGBufferOptions {
  /** Bring your own GPUDevice; otherwise a private one is created. */
  device?: GPUDevice;
  powerPreference?: 'high-performance' | 'low-power';
  /** World-units ray bias (Godot `p_bias`). Default 0.01. */
  bias?: number;
  /** Max atlas dimension (Godot `p_max_texture_size`). Default 2048. */
  atlasMaxSize?: number;
  /** Supersampling factor (Godot `p_supersampling_factor`). Default 1. */
  supersampling?: number;
  /** JNLM denoiser settings; null disables (drives padding + unocclude range). Default { strength: 1, range: 8 }. */
  denoise?: { strength: number; range: number } | null;
  exposureNormalization?: number;
  bounces?: number;
  bounceIndirectEnergy?: number;
  /** Cooperative cancellation + progress (Godot BakeStepFunc). */
  onProgress?: (fraction: number, message: string) => boolean;
}

export type BakeGBufferError =
  | 'noWebGPU'
  | 'noAdapter'
  | 'deviceRequestFailed'
  | 'noMeshes'
  | 'meshMissingUv2'
  | 'lightmapTooSmall'
  | 'textureExceedsDeviceLimit'
  | 'textureExceedsMaxSize'
  | 'atlasTooSmall'
  | 'deviceLost'
  | 'aborted';

/** One mesh's atlas rect in atlas-UV terms (DESIGN §6). */
export interface MeshRect {
  slice: number;
  /** Atlas-UV offset of the mesh's lightmap region. */
  offset: [number, number];
  /** Atlas-UV scale (lightmap size / atlas size). */
  scale: [number, number];
}

export type BakeGBufferResult =
  | {
      ok: true;
      atlasSize: [number, number];
      atlasSlices: number;
      /** Per addMesh, in insertion order. */
      meshRects: MeshRect[];
      position: ReadbackImage32F[];
      unocclude: ReadbackImage32F[];
      normal: ReadbackImage16F[];
      /** Grown scene bounds used for the grid (feeds previews). */
      bounds: Aabb;
      /** Destroy GPU resources held by this bake (readbacks stay valid). */
      destroy: () => void;
    }
  | { ok: false; error: BakeGBufferError };

/** Render one mesh's albedo/emission-on-UV2 images (bake_render_uv2 replacement). */
type MaterialRenderer = (
  mesh: { positions: Float32Array; uv2: Float32Array; triangleCount: number },
  material: unknown,
  size: { width: number; height: number },
) => MeshAtlasImages;

/** Lazily load @lightmapper/gbuffer (keeps core↔gbuffer workspace circularity dynamic). */
async function loadMaterialRenderer(): Promise<MaterialRenderer> {
  const gbuffer = (await import('@lightmapper/gbuffer')) as {
    renderMaterialOnUv2: MaterialRenderer;
  };
  return gbuffer.renderMaterialOnUv2;
}

/**
 * Compute the per-mesh lightmap image size: Godot takes the mesh's
 * lightmap size hint (default 64×64) and multiplies by supersampling —
 * `Size2i(Size2(hint) * …) * factor`, where Vector2i×float truncates
 * per axis (same float→int quirk as the atlas padding). A zero axis is
 * Godot's `BAKE_ERROR_LIGHTMAP_TOO_SMALL` (`ERR_FAIL_COND_V` on
 * lightmap_size in lightmap_gi.cpp) — the caller fails the bake on it.
 * (Exported for unit tests; `bakeGBuffer` is the only caller.)
 */
export function lightmapImageSize(
  hint: readonly [number, number] | undefined,
  supersampling: number,
): { width: number; height: number } {
  const [hx, hy] = hint ?? DEFAULT_LIGHTMAP_SIZE;
  return {
    width: Math.trunc(hx * supersampling),
    height: Math.trunc(hy * supersampling),
  };
}

/**
 * Build the 12-float column-major mat3x4 env transform (BakeParameters
 * layout, docs/DESIGN.md §4.5). (Exported for unit tests.)
 */
export function envTransform12(rotation: number[] | undefined): number[] {
  const m = rotation ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // C++ fills columns: rows[0][0], rows[1][0], rows[2][0], 0, … — with our
  // column-major Mat3 (three column vectors) that is m[0..2], m[3..5], m[6..8].
  return [
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
  ];
}

/** Signals thrown by the bake body; the wrapper maps them to typed results. */
class Aborted extends Error {
  constructor() {
    super('bake aborted by onProgress');
  }
}

class LightmapTooSmall extends Error {
  constructor() {
    super('a lightmap image size computed to zero');
  }
}

class DeviceLostError extends Error {
  constructor(info: GPUDeviceLostInfo) {
    super(`device lost: ${info.reason ?? 'unknown'} ${info.message}`);
  }
}

/** Who owns (and must destroy) a device created for this bake. */
interface BakeContext {
  ownedDevice: GPUDevice | null;
}

/**
 * Bake the G-buffer stage (M2): atlas → accel → raster + unocclude →
 * position/normal/unocclude atlas readbacks.
 *
 * Cancellation is cooperative (Godot `BakeStepFunc`): `onProgress`
 * returning `false` aborts at the next step and resolves to
 * `{ ok: false, error: 'aborted' }` — resources created so far are freed.
 */
export async function bakeGBuffer(
  scene: BakeScene,
  options: BakeGBufferOptions = {},
): Promise<BakeGBufferResult> {
  const ctx: BakeContext = { ownedDevice: null };
  try {
    return await bakeGBufferBody(scene, options, ctx);
  } catch (error) {
    ctx.ownedDevice?.destroy();
    if (error instanceof Aborted) return { ok: false, error: 'aborted' };
    if (error instanceof LightmapTooSmall) return { ok: false, error: 'lightmapTooSmall' };
    if (error instanceof DeviceLostError) return { ok: false, error: 'deviceLost' };
    throw error;
  }
}

async function bakeGBufferBody(
  scene: BakeScene,
  options: BakeGBufferOptions,
  ctx: BakeContext,
): Promise<BakeGBufferResult> {
  const bias = options.bias ?? 0.01;
  const supersampling = options.supersampling ?? 1;
  const atlasMaxSize = options.atlasMaxSize ?? 2048;
  const denoise = options.denoise ?? { strength: 1, range: 8 };
  const onProgress = options.onProgress;

  const step = (fraction: number, message: string): void => {
    if (onProgress !== undefined && onProgress(fraction, message) === false) {
      throw new Aborted();
    }
  };

  if (scene.meshes.length === 0) {
    return { ok: false, error: 'noMeshes' };
  }

  // Reject mesh inputs the M2 flow cannot handle yet (unwrap integration is
  // the demo's job for now; Godot always receives uv2 from bake_render_uv2).
  for (let i = 0; i < scene.meshes.length; i++) {
    if (scene.resolveMesh(i).uv2 === undefined) {
      return { ok: false, error: 'meshMissingUv2' };
    }
  }

  /* STEP 1: material images + atlas layout */

  const meshes = scene.resolveMeshes();
  const renderMaterial = await loadMaterialRenderer();
  const images: MeshAtlasImages[] = meshes.map((mesh) => {
    if (mesh.albedoOnUv2 !== undefined && mesh.emissionOnUv2 !== undefined) {
      return { albedo: mesh.albedoOnUv2, emission: mesh.emissionOnUv2 };
    }
    // bake_render_uv2 replacement (@lightmapper/gbuffer).
    const size = lightmapImageSize(mesh.lightmapSizeHint, supersampling);
    if (size.width === 0 || size.height === 0) {
      throw new LightmapTooSmall(); // Godot: BAKE_ERROR_LIGHTMAP_TOO_SMALL
    }
    return renderMaterial(
      { positions: mesh.positions, uv2: mesh.uv2!, triangleCount: mesh.triangleCount },
      mesh.material,
      size,
    );
  });

  // Godot passes the raw denoiser_range to the atlas sizing regardless of
  // whether the denoiser is on (padding always reserves it).
  const denoiserRange = denoise?.range ?? 8;

  const deviceRequest = await requestBakeDevice({
    device: options.device,
    powerPreference: options.powerPreference,
  });
  if (!deviceRequest.ok) {
    return { ok: false, error: deviceRequest.error };
  }
  const device = deviceRequest.device;
  ctx.ownedDevice = deviceRequest.owned ? device : null;

  step(0.1, 'Determining optimal atlas size');
  const layout: AtlasLayoutResult = blitMeshesIntoAtlas(
    images.map((img) => ({ width: img.albedo.width, height: img.albedo.height })),
    {
      maxTextureSize: atlasMaxSize,
      deviceMaxTextureSize: device.limits.maxTextureDimension2D,
      denoiserRange,
      supersamplingFactor: supersampling,
    },
  );
  if (!layout.ok) {
    return { ok: false, error: layout.error }; // the wrapper frees the device
  }

  step(0.2, 'Blitting albedo and emission');
  const slices = blitAtlasSlices(images, layout.slots, layout.atlasSize, layout.atlasSlices);

  /* STEP 2: acceleration structures (worker) */

  const probeGeneration = scene.resolveProbes();
  // Snapshot before the worker call — the worker build *transfers* the
  // typed array's buffer, detaching our copy.
  const probesBytes = new ArrayBuffer(probeGeneration.positions.byteLength);
  new Float32Array(probesBytes).set(probeGeneration.positions);
  const probePositions = probeGeneration.positions.length > 0
    ? new Float32Array(probeGeneration.positions) // transferable copy
    : null;
  const accelMeshes: AccelMesh[] = meshes.map((mesh, i) => ({
    positions: mesh.positions,
    normals: mesh.normals,
    uv2: mesh.uv2!,
    lightmapSize: [images[i].albedo.width, images[i].albedo.height],
    slice: layout.slots[i].slice,
    offset: layout.slots[i].offset,
    cullMode: cullModeValue(mesh.cullMode),
  }));

  // Godot reports one step per mesh while plotting (0.3 … 0.4).
  for (let i = 0; i < accelMeshes.length; i++) {
    const p = ((i + 1) / Math.max(1, accelMeshes.length)) * 0.1;
    step(0.3 + p, `Plotting mesh into acceleration structure ${i + 1}/${accelMeshes.length}`);
  }

  const worker = new AccelWorkerHost();
  let accel: AccelStructures;
  try {
    accel = await worker.build({
      meshes: accelMeshes,
      atlasSize: layout.atlasSize,
      atlasSlices: layout.atlasSlices,
      probePositions: probePositions,
      gridSize: GRID_SIZE,
    });
  } finally {
    worker.dispose();
  }

  /* Global parameters (bake_parameters_buffer assembly) */

  const lights = assembleLights(scene.lights);
  const lightsBytes = packLightsBuffer(lights);

  const bounds = accel.bounds;
  const gridSize = accel.gridSize;
  const bakeParameters: GpuBakeParameters = {
    worldSize: [bounds.size[0], bounds.size[1], bounds.size[2]],
    bias,
    toCellOffset: [bounds.position[0], bounds.position[1], bounds.position[2]],
    gridSize,
    toCellSize: [
      fr((1.0 / bounds.size[0]) * gridSize),
      fr((1.0 / bounds.size[1]) * gridSize),
      fr((1.0 / bounds.size[2]) * gridSize),
    ],
    lightCount: lights.length,
    envTransform: envTransform12(scene.environment?.rotation),
    atlasSize: [layout.atlasSize[0], layout.atlasSize[1]],
    exposureNormalization: options.exposureNormalization ?? 1,
    bounces: options.bounces ?? 3,
    bounceIndirectEnergy: options.bounceIndirectEnergy ?? 1,
    shadowmaskLightIdx: -1,
    transparencyRays: MAX_TRANSPARENCY_RAYS,
    supersamplingFactor: supersampling,
  };

  const clusterData = packClusterData(accel.clusterIndices, accel.clusterAabbs);

  /* GPU stages */

  step(0.47, 'Preparing shaders');
  step(0.49, 'Un-occluding geometry');

  const deviceLost = raceDeviceLost(device).then((info) => {
    throw new DeviceLostError(info);
  });
  // The loser of the race must not surface later as an unhandled rejection
  // (the device may be lost long after a successful bake).
  deviceLost.catch(() => undefined);
  const outputs: GBufferStageOutputs = await Promise.race([
    runGBufferStage(device, {
      accel,
      clusterData,
      lightsBytes,
      probesBytes,
      bakeParameters,
      atlasSize: [layout.atlasSize[0], layout.atlasSize[1]],
      atlasSlices: layout.atlasSlices,
      albedoSlices: slices.albedo,
      emissionSlices: slices.emission,
      denoiserRange: denoise !== null ? denoise.range : 1,
    }),
    deviceLost,
  ]);

  const meshRects: MeshRect[] = meshes.map((mesh, i) => ({
    slice: layout.slots[i].slice,
    offset: [
      layout.slots[i].offset[0] / layout.atlasSize[0],
      layout.slots[i].offset[1] / layout.atlasSize[1],
    ],
    scale: [
      images[i].albedo.width / layout.atlasSize[0],
      images[i].albedo.height / layout.atlasSize[1],
    ],
  }));

  // From here the result owns the device (its destroy() frees everything).
  const ownedDevice = ctx.ownedDevice;
  ctx.ownedDevice = null;
  return {
    ok: true,
    atlasSize: [layout.atlasSize[0], layout.atlasSize[1]],
    atlasSlices: layout.atlasSlices,
    meshRects,
    position: outputs.position,
    unocclude: outputs.unocclude,
    normal: outputs.normal,
    bounds,
    destroy: () => {
      outputs.destroy();
      ownedDevice?.destroy();
    },
  };
}

/** MeshInput.cullMode name → GPU value (CullMode enum). */
export function cullModeValue(mode: 'back' | 'front' | 'none'): number {
  switch (mode) {
    case 'none':
      return CULL_DISABLED;
    case 'front':
      return CULL_FRONT;
    case 'back':
      return CULL_BACK;
  }
}
