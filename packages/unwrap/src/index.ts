/**
 * Lightmap UV unwrapping — port of Godot's `xatlas_unwrap` module glue.
 *
 * Provenance: godot/modules/xatlas_unwrap/register_types.cpp
 * (`xatlas_mesh_lightmap_unwrap_callback`) @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md). The xatlas
 * runtime is consumed via the `xatlas-wasm` package (WebAssembly build of
 * upstream xatlas, MIT) — the "own emscripten wrapper" fallback path of
 * ADR-0002, materialized.
 *
 * Godot's presets are reproduced exactly:
 *   ChartOptions: fixWinding = true
 *   PackOptions:  padding = 1,
 *                 maxChartSize = 4094  (lightmap atlas needs 2px between
 *                                       meshes, so 4096 - 2),
 *                 blockAlign = true,
 *                 texelsPerUnit = 1 / texelSize
 * and the output contract: per-vertex `xref` back-mapping plus UVs
 * normalized by the atlas dimensions (`uv / width`, `uv / height`).
 *
 * PORT notes:
 *  - Godot's MD5-based editor unwrap *cache* is omitted — it only avoids
 *    recompute inside the editor; bake behavior is identical without it.
 *  - Degenerate triangles are passed through to xatlas exactly like the
 *    Godot wrapper (no epsilon pre-filter there either).
 */

import createXAtlas, { type ChartOptions, type PackOptions, type XAtlas, type XAtlasModule } from 'xatlas-wasm';

const fr = Math.fround;

/** Godot's chart options (single preset — `fixWinding`). */
export const GODOT_CHART_OPTIONS: ChartOptions = {
  fixWinding: true,
};

/** Godot's pack options as a function of the requested texel size. */
export function godotPackOptions(texelSize: number): PackOptions {
  return {
    padding: 1,
    maxChartSize: 4094, // Lightmap atlassing needs 2 for padding between meshes, so 4096-2
    blockAlign: true,
    texelsPerUnit: 1 / texelSize,
  };
}

/** Unwrap input: flat xyz positions/normals plus optional triangle indices. */
export interface UnwrapInput {
  positions: Float32Array;
  normals: Float32Array;
  /** Triangle-list indices into the vertex arrays; sequential soup if omitted. */
  indices?: Uint32Array;
  /** World units per lightmap texel (Godot `p_texel_size`; must be > 0). */
  texelSize: number;
}

/** Unwrap output, mirroring the C++ callback's return arrays. */
export interface UnwrapResult {
  /**
   * UV per OUTPUT vertex, normalized to 0–1 by the atlas dims
   * (Godot: `uv / w`, `uv / h`, binary32).
   */
  uv: Float32Array;
  /** xref per output vertex → input vertex index (C++ `r_vertex`). */
  vertexMap: Uint32Array;
  /** Output triangle indices (C++ `r_index`; count matches the input). */
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  /** Atlas dimensions (C++ `r_size_hint`). */
  sizeHint: [number, number];
}

/** Module-level wasm instance (loading is async and expensive; share it). */
let modulePromise: Promise<XAtlasModule> | null = null;

/** Get (or create) the shared xatlas wasm module. */
export function getXAtlasModule(): Promise<XAtlasModule> {
  modulePromise ??= createXAtlas();
  return modulePromise;
}

/**
 * Unwrap one mesh into lightmap UVs (port of the non-cached branch of
 * `xatlas_mesh_lightmap_unwrap_callback`).
 */
export async function unwrapMesh(input: UnwrapInput): Promise<UnwrapResult> {
  if (!(input.texelSize > 0)) {
    // ERR_FAIL_COND_V_MSG(p_texel_size <= 0.0f, ...)
    throw new RangeError('Texel size must be greater than 0.');
  }

  const xatlas = await getXAtlasModule();
  let atlas: XAtlas | null = null;
  try {
    atlas = xatlas.createAtlas();

    const err = atlas.addMesh({
      positions: input.positions,
      normals: input.normals,
      indices: input.indices,
    });
    if (err !== 0) {
      throw new Error(`xatlas AddMesh failed: ${xatlas.addMeshErrorString(err)}`);
    }

    atlas.generate(GODOT_CHART_OPTIONS, godotPackOptions(input.texelSize));

    const w = atlas.width;
    const h = atlas.height;
    if (w === 0 || h === 0) {
      throw new Error('xatlas could not generate an atlas: the mesh has no area'); // "no area"
    }

    const mesh = atlas.getMesh(0);
    const uv = new Float32Array(mesh.vertexCount * 2);
    const vertexMap = new Uint32Array(mesh.vertexCount);
    for (let i = 0; i < mesh.vertexCount; i++) {
      vertexMap[i] = mesh.vertices[i].xref;
      // Normalize by atlas dimensions, exactly like the C++ float math.
      uv[i * 2] = fr(mesh.vertices[i].uv[0] / w);
      uv[i * 2 + 1] = fr(mesh.vertices[i].uv[1] / h);
    }

    const indices = mesh.indices.slice();

    return {
      uv,
      vertexMap,
      indices,
      vertexCount: mesh.vertexCount,
      indexCount: mesh.indexCount,
      sizeHint: [w, h],
    };
  } finally {
    atlas?.destroy();
  }
}

/**
 * A mesh fully prepared for the bake pipeline: triangle soup with UV2
 * attached, rebuilt the way `ImporterMesh::lightmap_unwrap_cached`
 * reassembles surfaces — position/normal come from the ORIGINAL vertex
 * (via xref), the lightmap UV comes from the OUTPUT vertex.
 */
export interface UnwrappedSoup {
  /** Triangle soup, xyz (xref-expanded original positions). */
  positions: Float32Array;
  /** Triangle soup normals (xref-expanded originals). */
  normals: Float32Array;
  /** Normalized atlas-space UV2 per soup corner. */
  uv2: Float32Array;
  triangleCount: number;
  /** Lightmap image dimensions this mesh expects (size hint). */
  sizeHint: [number, number];
}

/**
 * Unwrap a triangle soup (or indexed mesh) and rebuild it as the
 * atlas-ready soup the accel structure consumes (`uv2` attached).
 */
export async function unwrapSoup(
  positions: Float32Array,
  normals: Float32Array,
  texelSize: number,
  indices?: Uint32Array,
): Promise<UnwrappedSoup> {
  const result = await unwrapMesh({ positions, normals, indices, texelSize });

  const triangleCount = result.indexCount / 3;
  const outPositions = new Float32Array(triangleCount * 9);
  const outNormals = new Float32Array(triangleCount * 9);
  const outUv2 = new Float32Array(triangleCount * 6);
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const outputVertex = result.indices[t * 3 + k];
      const sourceVertex = result.vertexMap[outputVertex];
      outPositions.set(positions.subarray(sourceVertex * 3, sourceVertex * 3 + 3), (t * 3 + k) * 3);
      outNormals.set(normals.subarray(sourceVertex * 3, sourceVertex * 3 + 3), (t * 3 + k) * 3);
      outUv2.set(result.uv.subarray(outputVertex * 2, outputVertex * 2 + 2), (t * 3 + k) * 2);
    }
  }

  return {
    positions: outPositions,
    normals: outNormals,
    uv2: outUv2,
    triangleCount,
    sizeHint: result.sizeHint,
  };
}

/* Browser worker hosting (the classes are lazy — constructing the worker
 * is the only browser-specific step). */
export { UnwrapWorker } from './unwrap-worker-client.js';
export type { UnwrapRequestMessage, UnwrapResponseMessage } from './worker.js';

