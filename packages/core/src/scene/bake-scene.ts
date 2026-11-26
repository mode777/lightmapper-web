/**
 * The scene model for lightmap baking — the browser-side equivalent of
 * Godot's `Lightmapper` API surface (scene/3d/lightmapper.h) as consumed
 * by `LightmapGI::_bake` and `LightmapperRD`.
 *
 * Provenance (semantics): godot/modules/lightmapper_rd/lightmapper_rd.cpp
 * (`add_mesh` validation, `add_probe`), godot/scene/3d/lightmap_gi.cpp
 * (`_bake` steps 1–2: mesh collection, probe generation) @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Not a line-by-line port: this is our public API (docs/DESIGN.md §1).
 * Godot-faithful behavior lives in the modules it delegates to
 * (scene/lights.ts, scene/probes.ts). Input typed arrays are treated as
 * immutable after being added — copy them beforehand if you mutate.
 */

import type {
  DirectionalLightInput,
  Environment,
  GenerateProbesMode,
  MeshInput,
  OmniLightInput,
  SceneLight,
  SpotLightInput,
} from './types.js';
import { generateProbes, type ProbeGeneration } from './probes.js';
import type { Vec3 } from '../layout/structs.js';

const fr = Math.fround;

/**
 * A mesh expanded to the triangle-soup form Godot consumes (`MeshData`):
 * one position/normal (and later uv2) per triangle corner, indices baked in.
 */
export interface ResolvedMesh {
  /** xyz per corner, triangle soup (length = triangleCount * 9). */
  positions: Float32Array;
  /** xyz per corner; user-supplied or flat-computed. */
  normals: Float32Array;
  /** xy per corner in 0-1 chart space, or undefined when unwrap is pending. */
  uv2: Float32Array | undefined;
  triangleCount: number;
  texelSize: number;
  lightmapSizeHint: [number, number] | undefined;
  albedoOnUv2: MeshInput['albedoOnUv2'];
  emissionOnUv2: MeshInput['emissionOnUv2'];
  material: MeshInput['material'];
  cullMode: NonNullable<MeshInput['cullMode']>;
}

/** Default texel size when `MeshInput.texelSize` is omitted (Godot `LightmapGI` default texel_size). */
export const DEFAULT_TEXEL_SIZE = 0.2;

export class BakeScene {
  private readonly meshInputs: MeshInput[] = [];
  private readonly lightInputs: SceneLight[] = [];
  private readonly userProbes: Vec3[] = [];
  private environmentValue: Environment | null = null;
  private probeMode: GenerateProbesMode = 'disabled';
  private resolvedMeshCache: (ResolvedMesh | undefined)[] = [];
  private resolvedProbesCache: ProbeGeneration | null = null;

  /* ---------------------------------------------------------------- */
  /* Meshes                                                            */
  /* ---------------------------------------------------------------- */

  /** Add a mesh in world space. Mirrors `LightmapperRD::add_mesh` validation. */
  addMesh(mesh: MeshInput): this {
    if (!(mesh.positions instanceof Float32Array) || mesh.positions.length === 0) {
      throw new TypeError('addMesh: positions must be a non-empty Float32Array');
    }
    if (mesh.positions.length % 3 !== 0) {
      throw new TypeError(`addMesh: positions length ${mesh.positions.length} is not a multiple of 3`);
    }
    const vertexCount = mesh.positions.length / 3;
    if (mesh.normals !== undefined) {
      if (mesh.normals.length !== mesh.positions.length) {
        throw new TypeError(`addMesh: normals length ${mesh.normals.length} does not match positions (${mesh.positions.length})`);
      }
    }
    if (mesh.uv2 !== undefined && mesh.uv2.length !== vertexCount * 2) {
      throw new TypeError(`addMesh: uv2 length ${mesh.uv2.length} does not match vertex count ${vertexCount} (need 2 floats per vertex)`);
    }
    if (mesh.indices !== undefined) {
      if (mesh.indices.length % 3 !== 0) {
        throw new TypeError(`addMesh: indices length ${mesh.indices.length} is not a multiple of 3`);
      }
      for (let i = 0; i < mesh.indices.length; i++) {
        if (mesh.indices[i] >= vertexCount) {
          throw new RangeError(`addMesh: indices[${i}] = ${mesh.indices[i]} is out of range (vertex count ${vertexCount})`);
        }
      }
    }
    // GODOT-QUIRK (add_mesh ERR_FAIL_COND): when both UV2 images are
    // supplied they must have identical dimensions.
    if (
      mesh.albedoOnUv2 !== undefined &&
      mesh.emissionOnUv2 !== undefined &&
      (mesh.albedoOnUv2.width !== mesh.emissionOnUv2.width ||
        mesh.albedoOnUv2.height !== mesh.emissionOnUv2.height)
    ) {
      throw new TypeError('addMesh: albedoOnUv2 and emissionOnUv2 must have the same dimensions');
    }

    this.meshInputs.push(mesh);
    this.resolvedMeshCache.length = this.meshInputs.length;
    this.resolvedProbesCache = null;
    return this;
  }

  /** Meshes as added (inputs are treated as immutable). */
  get meshes(): readonly MeshInput[] {
    return this.meshInputs;
  }

  /**
   * Expand mesh `i` to the triangle-soup form the bake consumes
   * (indices baked in, flat normals computed when omitted).
   * Results are cached; inputs must not be mutated after `addMesh`.
   */
  resolveMesh(i: number): ResolvedMesh {
    const cached = this.resolvedMeshCache[i];
    if (cached !== undefined) {
      return cached;
    }
    const mesh = this.meshInputs[i];
    if (mesh === undefined) {
      throw new RangeError(`resolveMesh: no mesh at index ${i}`);
    }

    const triangleCount = (mesh.indices !== undefined ? mesh.indices.length : mesh.positions.length / 3) / 3;
    const positions = new Float32Array(triangleCount * 9);
    const normals = new Float32Array(triangleCount * 9);

    for (let t = 0; t < triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const srcVertex = mesh.indices !== undefined ? mesh.indices[t * 3 + k] : t * 3 + k;
        positions[t * 9 + k * 3 + 0] = mesh.positions[srcVertex * 3 + 0];
        positions[t * 9 + k * 3 + 1] = mesh.positions[srcVertex * 3 + 1];
        positions[t * 9 + k * 3 + 2] = mesh.positions[srcVertex * 3 + 2];
      }
      // PORT: Godot always receives per-vertex normals from the mesh
      // surface; computing flat face normals is our convenience for
      // normals-less inputs (docs/DESIGN.md §1).
      if (mesh.normals !== undefined) {
        for (let k = 0; k < 3; k++) {
          const srcVertex = mesh.indices !== undefined ? mesh.indices[t * 3 + k] : t * 3 + k;
          normals[t * 9 + k * 3 + 0] = mesh.normals[srcVertex * 3 + 0];
          normals[t * 9 + k * 3 + 1] = mesh.normals[srcVertex * 3 + 1];
          normals[t * 9 + k * 3 + 2] = mesh.normals[srcVertex * 3 + 2];
        }
      } else {
        const n = flatFaceNormal(
          positions[t * 9 + 0], positions[t * 9 + 1], positions[t * 9 + 2],
          positions[t * 9 + 3], positions[t * 9 + 4], positions[t * 9 + 5],
          positions[t * 9 + 6], positions[t * 9 + 7], positions[t * 9 + 8],
        );
        for (let k = 0; k < 3; k++) {
          normals[t * 9 + k * 3 + 0] = n[0];
          normals[t * 9 + k * 3 + 1] = n[1];
          normals[t * 9 + k * 3 + 2] = n[2];
        }
      }
    }

    let uv2: Float32Array | undefined;
    if (mesh.uv2 !== undefined) {
      uv2 = new Float32Array(triangleCount * 6);
      for (let t = 0; t < triangleCount; t++) {
        for (let k = 0; k < 3; k++) {
          const srcVertex = mesh.indices !== undefined ? mesh.indices[t * 3 + k] : t * 3 + k;
          uv2[t * 6 + k * 2 + 0] = mesh.uv2[srcVertex * 2 + 0];
          uv2[t * 6 + k * 2 + 1] = mesh.uv2[srcVertex * 2 + 1];
        }
      }
    }

    const resolved: ResolvedMesh = {
      positions,
      normals,
      uv2,
      triangleCount,
      texelSize: mesh.texelSize ?? DEFAULT_TEXEL_SIZE,
      lightmapSizeHint: mesh.lightmapSizeHint,
      albedoOnUv2: mesh.albedoOnUv2,
      emissionOnUv2: mesh.emissionOnUv2,
      material: mesh.material,
      cullMode: mesh.cullMode ?? 'back',
    };
    this.resolvedMeshCache[i] = resolved;
    return resolved;
  }

  /** All meshes in resolved soup form. */
  resolveMeshes(): ResolvedMesh[] {
    return this.meshInputs.map((_, i) => this.resolveMesh(i));
  }

  /* ---------------------------------------------------------------- */
  /* Lights                                                            */
  /* ---------------------------------------------------------------- */

  addDirectionalLight(light: DirectionalLightInput): this {
    this.lightInputs.push({ kind: 'directional', ...light });
    return this;
  }

  addOmniLight(light: OmniLightInput): this {
    this.lightInputs.push({ kind: 'omni', ...light });
    return this;
  }

  addSpotLight(light: SpotLightInput): this {
    this.lightInputs.push({ kind: 'spot', ...light });
    return this;
  }

  /** Lights in insertion order; GPU assembly + type sort happens in scene/lights.ts at bake time. */
  get lights(): readonly SceneLight[] {
    return this.lightInputs;
  }

  /* ---------------------------------------------------------------- */
  /* Environment                                                       */
  /* ---------------------------------------------------------------- */

  setEnvironment(env: Environment): this {
    if (env.rotation !== undefined) {
      if (!Array.isArray(env.rotation) || env.rotation.length !== 9) {
        throw new TypeError('setEnvironment: rotation must be a column-major Mat3 (9 numbers)');
      }
    }
    this.environmentValue = env;
    return this;
  }

  get environment(): Environment | null {
    return this.environmentValue;
  }

  /* ---------------------------------------------------------------- */
  /* Probes                                                            */
  /* ---------------------------------------------------------------- */

  /** Add a user-submitted probe position (Godot `add_probe`). */
  addProbe(position: Vec3): this {
    if (!Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2])) {
      throw new TypeError('addProbe: position components must be finite');
    }
    this.userProbes.push([position[0], position[1], position[2]]);
    this.resolvedProbesCache = null;
    return this;
  }

  /** User probe positions in insertion order. */
  get probes(): readonly Vec3[] {
    return this.userProbes;
  }

  /**
   * Select probe generation (Godot `GenerateProbes` enum). Positions are
   * resolved on demand by `resolveProbes()` — the same point in the flow
   * where Godot's `LightmapGI::_bake` creates them (after all meshes are
   * collected, before the lightmapper runs).
   */
  generateProbes(mode: GenerateProbesMode): this {
    this.probeMode = mode;
    this.resolvedProbesCache = null;
    return this;
  }

  get generateProbesMode(): GenerateProbesMode {
    return this.probeMode;
  }

  /**
   * Resolve all probe positions (user first, then generated) packed as
   * `vec4` positions with w = 0. See scene/probes.ts for the port notes.
   */
  resolveProbes(): ProbeGeneration {
    if (this.resolvedProbesCache !== null) {
      return this.resolvedProbesCache;
    }
    const meshPositions = this.meshInputs.map((_, i) => this.resolveMesh(i).positions);
    this.resolvedProbesCache = generateProbes(meshPositions, this.userProbes, this.probeMode);
    return this.resolvedProbesCache;
  }
}

/**
 * Flat face normal for a triangle, in Godot's winding convention.
 *
 * Godot's front faces are CLOCKWISE (`RD::PipelineRasterizationState`
 * defaults to `POLYGON_FRONT_FACE_CLOCKWISE`), so the geometric front
 * normal is `-(v1 - v0) × (v2 - v0)`. This is byte-for-byte the expression
 * the lightmapper kernels use — `face_normal` in lm_raster.glsl and
 * `normal` in lm_compute.glsl's `trace_ray`:
 *   `-normalize(cross(v0 - v1, v0 - v2))`
 * — and the same as `SurfaceTool::generate_normals()`
 * (`Plane(v0, v1, v2, CLOCKWISE)`). The convenience must agree with the
 * kernels: they derive front/back and the bias direction from the winding,
 * so normals computed the other way round would light the back of every
 * normals-less mesh. Degenerate triangles yield the zero vector.
 */
function flatFaceNormal(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
): Vec3 {
  // cross(v0 - v1, v0 - v2), negated — same operand order as the GLSL so
  // the arithmetic follows the kernels' face_normal (GPU normalize() may
  // still differ in the last ulp; the SIGN convention is what matters here).
  const ax = fr(x0 - x1);
  const ay = fr(y0 - y1);
  const az = fr(z0 - z1);
  const bx = fr(x0 - x2);
  const by = fr(y0 - y2);
  const bz = fr(z0 - z2);
  const cx = fr(fr(ay * bz) - fr(az * by));
  const cy = fr(fr(az * bx) - fr(ax * bz));
  const cz = fr(fr(ax * by) - fr(ay * bx));
  const len = fr(Math.sqrt(fr(fr(cx * cx) + fr(cy * cy)) + fr(cz * cz)));
  if (len === 0) {
    return [0, 0, 0];
  }
  return [fr(-cx / len), fr(-cy / len), fr(-cz / len)];
}
