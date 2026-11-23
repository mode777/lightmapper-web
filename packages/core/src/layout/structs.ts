/**
 * Byte-exact GPU struct layouts for the WebGPU port of Godot's lightmapper.
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.h (C++ structs) and
 * godot/modules/lightmapper_rd/lm_common_inc.glsl (GLSL declarations)
 * @ 67421f36e5069e62573c44beb8dd2f8f91e065b0 — License: MIT (see NOTICE.md).
 *
 * WGSL alignment rules (vec3f → 16, vec2f → 8, scalars → 4) reproduce Godot's
 * std140/std430 layouts *byte for byte* for these specific structs. This is a
 * deliberate feature (ADR-0008): it lets us golden-test our buffers against
 * native Godot dumps and keeps the WGSL declarations in
 * packages/shaders/wgsl/*.wgsl in lock-step with these tables.
 *
 * The authoritative byte-offset tables live in docs/DESIGN.md §4 — keep this
 * file, the WGSL structs and the design doc in sync (test/structs.test.ts
 * enforces the offsets on this side).
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Sizes in bytes (all multiples of 16). */
export const STRUCT_SIZES = {
  vertex: 32,
  triangle: 48,
  light: 128,
  clusterAABB: 32,
  bakeParameters: 128,
  params: 32,
  rasterPushConstant: 64,
  denoiseParams: 32,
} as const;

/* ------------------------------------------------------------------ */
/* Storage-buffer structs (std430-equivalent)                          */
/* ------------------------------------------------------------------ */

/** Mirrors GLSL `Vertex` (32 bytes). */
export interface GpuVertex {
  position: Vec3;
  normalZ: number;
  uv: Vec2;
  normalXY: Vec2;
}

/** Mirrors GLSL `Triangle` (48 bytes). */
export interface GpuTriangle {
  indices: [number, number, number]; // uvec3
  slice: number; // u32
  minBounds: Vec3;
  cullMode: number; // u32 — 0 disabled, 1 front, 2 back
  maxBounds: Vec3;
  pad1: number; // u32
}

export const CULL_DISABLED = 0;
export const CULL_FRONT = 1;
export const CULL_BACK = 2;

export const LIGHT_TYPE_DIRECTIONAL = 0;
export const LIGHT_TYPE_OMNI = 1;
export const LIGHT_TYPE_SPOT = 2;
export const LIGHT_TYPE_AREA = 3;

/** Mirrors GLSL `Light` (128 bytes). Field order must match lm_common_inc.glsl. */
export interface GpuLight {
  position: Vec3;
  type: number; // u32, LIGHT_TYPE_*
  direction: Vec3;
  energy: number;
  color: Vec3;
  size: number;
  range: number;
  attenuation: number;
  cosSpotAngle: number;
  invSpotAttenuation: number;
  indirectEnergy: number;
  shadowBlur: number;
  staticBake: number; // u32 (bool)
  pad: number; // u32
  areaWidth: [number, number, number, number];
  areaHeight: [number, number, number, number];
  areaTextureRect: [number, number, number, number];
}

/** Mirrors GLSL `ClusterAABB` (32 bytes). */
export interface GpuClusterAABB {
  minBounds: Vec3;
  pad0: number;
  maxBounds: Vec3;
  pad1: number;
}

/* ------------------------------------------------------------------ */
/* Uniform-buffer structs                                              */
/* ------------------------------------------------------------------ */

/**
 * Mirrors GLSL `BakeParameters` (128 bytes, group 0 binding 0).
 * `envTransform` is a column-major mat3x4 exactly as Godot uploads it.
 */
export interface GpuBakeParameters {
  worldSize: Vec3;
  bias: number;
  toCellOffset: Vec3;
  gridSize: number; // i32
  toCellSize: Vec3;
  lightCount: number; // u32
  /** Column-major 3x4: 3 columns of vec4 = 12 floats. */
  envTransform: number[];
  atlasSize: Vec2; // i32 x 2
  exposureNormalization: number;
  bounces: number; // u32
  bounceIndirectEnergy: number;
  shadowmaskLightIdx: number; // i32
  transparencyRays: number; // u32
  supersamplingFactor: number;
}

/**
 * Mirrors the compute push-constant `Params` (32 bytes). WebGPU has no push
 * constants: this is uploaded as a dynamic-offset uniform buffer at group 2
 * binding 0 (ADR-0003).
 */
export interface GpuParams {
  atlasSlice: number; // u32
  rayCount: number; // u32
  rayFrom: number; // u32
  rayTo: number; // u32
  regionOfs: Vec2; // i32 x 2
  probeCount: number; // u32
  denoiserRange: number; // u32
}

/**
 * Mirrors the `Params` uniform buffer (dynamic offset, group 2 binding 0)
 * of the raster kernels — the GLSL push constant of `lm_raster.glsl`
 * (std430, 64 bytes). Note `atlasSize` is **float2** here, unlike
 * `GpuBakeParameters.atlasSize` (int2).
 */
export interface GpuRasterPushConstant {
  atlasSize: Vec2; // f32 × 2
  uvOffset: Vec2; // f32 × 2 (half-pixel quirk, see lm_raster.wgsl)
  toCellSize: Vec3; // f32 × 3
  baseTriangle: number; // u32
  toCellOffset: Vec3; // f32 × 3
  bias: number; // f32
  gridSize: Vec3; // i32 × 3
  pad2: number; // u32
}

/** Mirrors the `DenoiseParams` uniform (32 bytes). */
export interface GpuDenoiseParams {
  spatialBandwidth: number;
  lightBandwidth: number;
  albedoBandwidth: number;
  normalBandwidth: number;
  halfSearchWindow: number; // i32
  filterStrength: number;
  sliceCount: number; // u32
  pad: number; // u32
}

/* ------------------------------------------------------------------ */
/* Writers                                                             */
/* ------------------------------------------------------------------ */

/** Little-endian DataView writers; offsets follow docs/DESIGN.md §4. */

export function writeVertex(view: DataView, o: number, v: GpuVertex): void {
  view.setFloat32(o + 0, v.position[0], true);
  view.setFloat32(o + 4, v.position[1], true);
  view.setFloat32(o + 8, v.position[2], true);
  view.setFloat32(o + 12, v.normalZ, true);
  view.setFloat32(o + 16, v.uv[0], true);
  view.setFloat32(o + 20, v.uv[1], true);
  view.setFloat32(o + 24, v.normalXY[0], true);
  view.setFloat32(o + 28, v.normalXY[1], true);
}

export function writeTriangle(view: DataView, o: number, t: GpuTriangle): void {
  view.setUint32(o + 0, t.indices[0], true);
  view.setUint32(o + 4, t.indices[1], true);
  view.setUint32(o + 8, t.indices[2], true);
  view.setUint32(o + 12, t.slice, true);
  view.setFloat32(o + 16, t.minBounds[0], true);
  view.setFloat32(o + 20, t.minBounds[1], true);
  view.setFloat32(o + 24, t.minBounds[2], true);
  view.setUint32(o + 28, t.cullMode, true);
  view.setFloat32(o + 32, t.maxBounds[0], true);
  view.setFloat32(o + 36, t.maxBounds[1], true);
  view.setFloat32(o + 40, t.maxBounds[2], true);
  view.setUint32(o + 44, t.pad1, true);
}

export function writeLight(view: DataView, o: number, l: GpuLight): void {
  view.setFloat32(o + 0, l.position[0], true);
  view.setFloat32(o + 4, l.position[1], true);
  view.setFloat32(o + 8, l.position[2], true);
  view.setUint32(o + 12, l.type, true);
  view.setFloat32(o + 16, l.direction[0], true);
  view.setFloat32(o + 20, l.direction[1], true);
  view.setFloat32(o + 24, l.direction[2], true);
  view.setFloat32(o + 28, l.energy, true);
  view.setFloat32(o + 32, l.color[0], true);
  view.setFloat32(o + 36, l.color[1], true);
  view.setFloat32(o + 40, l.color[2], true);
  view.setFloat32(o + 44, l.size, true);
  view.setFloat32(o + 48, l.range, true);
  view.setFloat32(o + 52, l.attenuation, true);
  view.setFloat32(o + 56, l.cosSpotAngle, true);
  view.setFloat32(o + 60, l.invSpotAttenuation, true);
  view.setFloat32(o + 64, l.indirectEnergy, true);
  view.setFloat32(o + 68, l.shadowBlur, true);
  view.setUint32(o + 72, l.staticBake, true);
  view.setUint32(o + 76, l.pad, true);
  for (let i = 0; i < 4; i++) view.setFloat32(o + 80 + i * 4, l.areaWidth[i], true);
  for (let i = 0; i < 4; i++) view.setFloat32(o + 96 + i * 4, l.areaHeight[i], true);
  for (let i = 0; i < 4; i++) view.setFloat32(o + 112 + i * 4, l.areaTextureRect[i], true);
}

export function writeClusterAABB(view: DataView, o: number, c: GpuClusterAABB): void {
  view.setFloat32(o + 0, c.minBounds[0], true);
  view.setFloat32(o + 4, c.minBounds[1], true);
  view.setFloat32(o + 8, c.minBounds[2], true);
  view.setUint32(o + 12, c.pad0, true);
  view.setFloat32(o + 16, c.maxBounds[0], true);
  view.setFloat32(o + 20, c.maxBounds[1], true);
  view.setFloat32(o + 24, c.maxBounds[2], true);
  view.setUint32(o + 28, c.pad1, true);
}

export function writeBakeParameters(view: DataView, o: number, p: GpuBakeParameters): void {
  if (p.envTransform.length !== 12) {
    throw new Error(`envTransform must have 12 elements (mat3x4), got ${p.envTransform.length}`);
  }
  view.setFloat32(o + 0, p.worldSize[0], true);
  view.setFloat32(o + 4, p.worldSize[1], true);
  view.setFloat32(o + 8, p.worldSize[2], true);
  view.setFloat32(o + 12, p.bias, true);
  view.setFloat32(o + 16, p.toCellOffset[0], true);
  view.setFloat32(o + 20, p.toCellOffset[1], true);
  view.setFloat32(o + 24, p.toCellOffset[2], true);
  view.setInt32(o + 28, p.gridSize, true);
  view.setFloat32(o + 32, p.toCellSize[0], true);
  view.setFloat32(o + 36, p.toCellSize[1], true);
  view.setFloat32(o + 40, p.toCellSize[2], true);
  view.setUint32(o + 44, p.lightCount, true);
  for (let i = 0; i < 12; i++) view.setFloat32(o + 48 + i * 4, p.envTransform[i], true);
  view.setInt32(o + 96, p.atlasSize[0], true);
  view.setInt32(o + 100, p.atlasSize[1], true);
  view.setFloat32(o + 104, p.exposureNormalization, true);
  view.setUint32(o + 108, p.bounces, true);
  view.setFloat32(o + 112, p.bounceIndirectEnergy, true);
  view.setInt32(o + 116, p.shadowmaskLightIdx, true);
  view.setUint32(o + 120, p.transparencyRays, true);
  view.setFloat32(o + 124, p.supersamplingFactor, true);
}

export function writeParams(view: DataView, o: number, p: GpuParams): void {
  view.setUint32(o + 0, p.atlasSlice, true);
  view.setUint32(o + 4, p.rayCount, true);
  view.setUint32(o + 8, p.rayFrom, true);
  view.setUint32(o + 12, p.rayTo, true);
  view.setInt32(o + 16, p.regionOfs[0], true);
  view.setInt32(o + 20, p.regionOfs[1], true);
  view.setUint32(o + 24, p.probeCount, true);
  view.setUint32(o + 28, p.denoiserRange, true);
}

/** Mirrors the lm_raster.glsl push constant (std430, 64 bytes). */
export function writeRasterPushConstant(view: DataView, o: number, p: GpuRasterPushConstant): void {
  view.setFloat32(o + 0, p.atlasSize[0], true);
  view.setFloat32(o + 4, p.atlasSize[1], true);
  view.setFloat32(o + 8, p.uvOffset[0], true);
  view.setFloat32(o + 12, p.uvOffset[1], true);
  view.setFloat32(o + 16, p.toCellSize[0], true);
  view.setFloat32(o + 20, p.toCellSize[1], true);
  view.setFloat32(o + 24, p.toCellSize[2], true);
  view.setUint32(o + 28, p.baseTriangle, true);
  view.setFloat32(o + 32, p.toCellOffset[0], true);
  view.setFloat32(o + 36, p.toCellOffset[1], true);
  view.setFloat32(o + 40, p.toCellOffset[2], true);
  view.setFloat32(o + 44, p.bias, true);
  view.setInt32(o + 48, p.gridSize[0], true);
  view.setInt32(o + 52, p.gridSize[1], true);
  view.setInt32(o + 56, p.gridSize[2], true);
  view.setUint32(o + 60, p.pad2, true);
}

export function writeDenoiseParams(view: DataView, o: number, p: GpuDenoiseParams): void {
  view.setFloat32(o + 0, p.spatialBandwidth, true);
  view.setFloat32(o + 4, p.lightBandwidth, true);
  view.setFloat32(o + 8, p.albedoBandwidth, true);
  view.setFloat32(o + 12, p.normalBandwidth, true);
  view.setInt32(o + 16, p.halfSearchWindow, true);
  view.setFloat32(o + 20, p.filterStrength, true);
  view.setUint32(o + 24, p.sliceCount, true);
  view.setUint32(o + 28, p.pad, true);
}

/** Allocate and fill an ArrayBuffer with `count` packed structs. */
export function pack<T>(size: number, count: number, items: T[], write: (view: DataView, o: number, item: T) => void): ArrayBuffer {
  const buffer = new ArrayBuffer(count * size);
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) write(view, i * size, items[i]);
  return buffer;
}
