/**
 * Public scene-input types for @lightmapper/core.
 *
 * These define the data contract sketched in docs/DESIGN.md §1 (M1 target).
 * Units are world-space, right-handed, Y-up (Godot convention); colors are
 * linear RGB. Names map to Godot's `Lightmapper::MeshData` and the
 * `LightmapperRD::add_*_light` parameters as noted below.
 *
 * Not a port: this is our own API surface, so defaults follow Godot's
 * Light3D property defaults where a 1:1 mapping exists (documented per
 * field). Field *packing* into the GPU `Light` struct is ported faithfully
 * in scene/lights.ts.
 */

import type { Vec3 } from '../layout/structs.js';

/** Linear-space RGB color tuple. */
export type ColorRgb = [number, number, number];

/** Mesh face culling, mirrors `LightmapperRD::CullMode` GPU values (0 disabled, 1 front, 2 back). */
export type CullMode = 'back' | 'front' | 'none';

/** Godot `Lightmapper::GenerateProbes` enum (scene/3d/lightmapper.h). */
export type GenerateProbesMode = 'disabled' | 'subdiv_4' | 'subdiv_8' | 'subdiv_16' | 'subdiv_32';

/** Godot's subdivision value per `GenerateProbesMode` (`subdiv_values` in scene/3d/lightmap_gi.cpp). */
export const GENERATE_PROBES_SUBDIV: Record<GenerateProbesMode, number> = {
  disabled: 0,
  subdiv_4: 4,
  subdiv_8: 8,
  subdiv_16: 16,
  subdiv_32: 32,
};

/** Albedo-on-UV2 image, rgba8 (`data` = width*height*4 bytes, alpha = opacity). */
export interface AlbedoOnUv2Image {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

/** Emission-on-UV2 image, rgbah (`data` = width*height*4 f16 words). */
export interface EmissionOnUv2Image {
  width: number;
  height: number;
  data: Uint16Array<ArrayBuffer>;
}

/**
 * Minimal glTF-like material consumed by `@lightmapper/gbuffer` (M2) to
 * render `albedoOnUv2` / `emissionOnUv2` when those are not supplied
 * directly. Godot's equivalent input is the mesh's material RID.
 */
export interface GltfLikeMaterial {
  /** Linear base color; defaults to white. */
  baseColor?: ColorRgb;
  /** Base color texture (rgba8, sRGB-decoded by the supplier); optional. */
  baseColorTexture?: { width: number; height: number; data: Uint8Array<ArrayBuffer> };
  /** 0–1; metallic surfaces contribute no diffuse albedo. Default 0. */
  metallic?: number;
  /** 0–1, unused by the bake (kept for glTF fidelity). Default 1. */
  roughness?: number;
  /** 0–1 opacity; < 1 marks the surface transparent to light rays. Default 1. */
  opacity?: number;
  /** Linear emission color; multiplied by `emissionEnergy`. Default black. */
  emission?: ColorRgb;
  /** Emission multiplier. Default 1. */
  emissionEnergy?: number;
}

/**
 * One mesh to bake, in world space.
 *
 * Godot consumes a triangle *soup* (`MeshData`: points/uv2/normal per
 * corner); `indices` is our convenience — expanded to soup when the scene
 * is resolved. `normals` may be omitted, in which case flat face normals
 * are computed (PORT: Godot always receives normals from the mesh surface).
 *
 * **Winding (Godot convention):** a triangle's front face is the side its
 * vertices appear *clockwise* from (`PolygonFrontFace`), so its geometric
 * front normal is `-(v1 - v0) × (v2 - v0)`. This is not cosmetic — the
 * lightmapper kernels derive `face_normal` (bias direction, tangent frame)
 * and front/back hits (`trace_ray`, `cullMode`) from the winding. Supply
 * vertex normals pointing to the lit side and wind triangles clockwise
 * seen from that side. glTF and most WebGPU data are counter-clockwise
 * front: reverse each triangle's index order first.
 */
export interface MeshInput {
  /** xyz per vertex, triangle soup or indexed by `indices`. */
  positions: Float32Array;
  /** xyz per vertex; flat face normals in the winding convention above if omitted. */
  normals?: Float32Array;
  /** Triangle-list indices into the vertex arrays; sequential if omitted. Clockwise = front face. */
  indices?: Uint32Array;
  /** xy per vertex, lightmap UVs in 0–1 chart space; unwrapped in M1 if omitted. */
  uv2?: Float32Array;
  /** World units per lightmap texel — unwrap/packing hint (Godot `texel_size`). Default 0.2. */
  texelSize?: number;
  /**
   * Lightmap image size hint for `@lightmapper/gbuffer` rendering, in texels
   * (Godot: `Mesh.get_lightmap_size_hint()`, defaulting to 64×64 when unset).
   * Ignored when `albedoOnUv2`/`emissionOnUv2` are supplied directly.
   */
  lightmapSizeHint?: [number, number];
  /** User-supplied albedo image on the mesh's UV2 (Godot `albedo_on_uv2`). */
  albedoOnUv2?: AlbedoOnUv2Image;
  /** User-supplied emission image on the mesh's UV2 (Godot `emission_on_uv2`, rgbah). */
  emissionOnUv2?: EmissionOnUv2Image;
  /** Material description rendered by `@lightmapper/gbuffer` when images are absent. */
  material?: GltfLikeMaterial;
  /** Default 'back' (Godot meshes default to back-face culling). */
  cullMode?: CullMode;
}

/** Directional light (Godot `LightmapperRD::add_directional_light`). */
export interface DirectionalLightInput {
  /** Direction the light *travels* (Godot convention: away from the light). */
  direction: Vec3;
  /** Default white. */
  color?: ColorRgb;
  /** Default 1. */
  energy?: number;
  /** Default 1. */
  indirectEnergy?: number;
  /** Angular diameter in degrees; packed as `tan(rad)` into `size` (Godot `angular_distance`). Default 0. */
  angularSizeDeg?: number;
  /** Default 0.1 (Light3D). */
  shadowBlur?: number;
  /** Participates in bake. Default true. */
  static?: boolean;
}

/** Omni light (Godot `LightmapperRD::add_omni_light`). */
export interface OmniLightInput {
  position: Vec3;
  /** Default white. */
  color?: ColorRgb;
  /** Default 1. */
  energy?: number;
  /** Default 1. */
  indirectEnergy?: number;
  /** Cutoff radius. */
  range: number;
  /** Default 1 (Light3D). */
  attenuation?: number;
  /** Light radius for soft shadows (Godot `size`). Default 0. */
  size?: number;
  /** Default 0.1 (Light3D). */
  shadowBlur?: number;
  /** Default true. */
  static?: boolean;
}

/** Spot light (Godot `LightmapperRD::add_spot_light`). */
export interface SpotLightInput {
  position: Vec3;
  /** Direction the light points (axis of the cone). */
  direction: Vec3;
  /** Default white. */
  color?: ColorRgb;
  /** Default 1. */
  energy?: number;
  /** Default 1. */
  indirectEnergy?: number;
  /** Cutoff radius. */
  range: number;
  /** Default 1 (Light3D). */
  attenuation?: number;
  /** Apex angle in degrees; packed as `cos(rad)` (Godot `spot_angle`). Default 45. */
  angleDeg?: number;
  /** Spot falloff exponent; packed as `1/x` (Godot `spot_attenuation`). Default 1. */
  spotAttenuation?: number;
  /** Light radius for soft shadows (Godot `size`). Default 0. */
  size?: number;
  /** Default 0.1 (Light3D). */
  shadowBlur?: number;
  /** Default true. */
  static?: boolean;
}

/** Discriminated union stored by `BakeScene`. */
export type SceneLight =
  | ({ kind: 'directional' } & DirectionalLightInput)
  | ({ kind: 'omni' } & OmniLightInput)
  | ({ kind: 'spot' } & SpotLightInput);

/** Equirectangular environment panorama (converted to rgba16f at upload — ADR-0006). */
export type EnvironmentPanorama =
  | ImageBitmap
  | { width: number; height: number; data: Float32Array /* rgb or rgba per pixel */ };

/** Column-major 3x3 rotation, 9 floats (Godot `Basis`, 3 column vectors). */
export type Mat3 = number[];

/** Scene environment (Godot `environment_panorama` + `environment_transform`). */
export interface Environment {
  panorama?: EnvironmentPanorama;
  rotation?: Mat3;
}
