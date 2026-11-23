/**
 * Port of `LightmapperRD::_create_acceleration_structures` — the CPU stage
 * that turns an atlas-packed scene into the GPU buffers the kernels trace
 * against.
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0 (mesh loop, vertex dedup, seam
 * detection, grid plotting via `_plot_triangle_into_triangle_index_list`,
 * cluster building via `_sort_triangle_clusters`, grid texture assembly).
 * Sorting uses the SortArray port (accel/sort-array.ts); overlap testing
 * uses the Geometry3D port (math/geometry3d.ts); hashing uses math/hash.ts.
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Faithfulness notes:
 *  - VERIFIED out-of-band against a standalone C++ extraction of the
 *    upstream functions (f32 structs + SortArray + hashfuncs + SAT, scene
 *    stream via a shared LCG): 400 random scenes, every buffer — vertices,
 *    triangles, triangle indices, cluster indices/AABBs, grid, seams,
 *    slice counts, bounds — byte-identical (grid sizes 8/16, cluster sizes
 *    4/16, shared/reversed/wound edges, probes, multi-slice).
 *  - UVs are transformed to atlas space (`uv2 * uv_scale + uv_offset`)
 *    BEFORE dedup, exactly like the C++ — so vertices sharing position and
 *    normal but with different atlas UVs stay separate.
 *  - Vertex dedup keys on `vertexHash` buckets but equality compares all 8
 *    floats (C++ `operator==`: -0 == +0, NaN != NaN — JS `===` matches).
 *  - GODOT-QUIRK: `Edge` hashing ignores the normals but `Edge` equality
 *    includes them, so same-endpoint edges with different normals are
 *    distinct map entries. Replicated via hash-keyed buckets.
 *  - GODOT-QUIRK: `EdgeUV2` equality compares only the UVs, never the
 *    vertex indices — an edge re-encountered with identical UVs never
 *    becomes a seam ("shared UV space, no need to blend").
 *  - `triangles`/`seams`/`triangle_sort` sorts use Godot's unstable
 *    introsort port so equal-key order matches native byte-for-byte.
 *  - `cluster_data` is NOT merged here (ADR-0005 merging happens at upload;
 *    this module emits `clusterIndices` and `clusterAabbs` separately).
 */

import {
  CULL_BACK,
  STRUCT_SIZES,
  pack,
  writeClusterAABB,
  writeTriangle,
  writeVertex,
  type GpuVertex,
} from '../layout/structs.js';
import { edgeHash, vertexHash } from '../math/hash.js';
import { triangleBoxOverlap } from '../math/geometry3d.js';
import {
  aabbAt,
  aabbExpandTo,
  aabbGetCenter,
  aabbGetEnd,
  aabbGetLongestAxisIndex,
  aabbGrowBy,
  aabbMergeWith,
  type Aabb,
} from '../math/aabb.js';
import { nextPowerOf2 } from '../math/bits.js';
import { sortArray, sortArrayRange } from './sort-array.js';
import type { Vec2, Vec3 } from '../layout/structs.js';

const fr = Math.fround;

/** Grid resolution Godot uses (`gridSize = 128`). */
export const GRID_SIZE = 128;
/** Triangles per cluster (`clusterSize = 16`). */
export const CLUSTER_SIZE = 16;

/** One mesh in atlas-packed form (the C++ `MeshInstance` + its slot). */
export interface AccelMesh {
  /** Triangle-soup positions, world space. */
  positions: Float32Array;
  /** Triangle-soup normals. */
  normals: Float32Array;
  /** Triangle-soup UV2 in 0–1 chart space (unwrapped). */
  uv2: Float32Array;
  /** Lightmap image size (C++ `albedo_on_uv2` dimensions). */
  lightmapSize: Vec2;
  /** Atlas slot from `blitMeshesIntoAtlas` (offset includes the +1). */
  slice: number;
  offset: Vec2;
  /** GPU cull mode: 0 disabled, 1 front, 2 back. */
  cullMode: number;
}

/** CPU-side mirrors of the C++ structs (pre-packing). */
interface CpuTriangle {
  indices: [number, number, number];
  slice: number;
  minBounds: Vec3;
  cullMode: number;
  maxBounds: Vec3;
  pad1: number;
}

interface CpuSeam {
  a: [number, number];
  b: [number, number];
  slice: number;
}

/** C++ `TriangleSort`. */
interface TriangleSort {
  cellIndex: number;
  triangleIndex: number;
  triangleAabb: Aabb;
}

/** Result of the acceleration-structure build (upload-ready buffers). */
export interface AccelStructures {
  /** `Vertex[]` storage-buffer bytes. */
  vertices: ArrayBuffer;
  /** `Triangle[]` storage-buffer bytes (sorted by slice). */
  triangles: ArrayBuffer;
  /** u32 triangle indices, cell-cluster order. */
  triangleIndices: Uint32Array<ArrayBuffer>;
  /** u32 pairs per solid cell: [cluster_start, triangle_start]. */
  clusterIndices: Uint32Array<ArrayBuffer>;
  /** `ClusterAABB[]` bytes. */
  clusterAabbs: ArrayBuffer;
  /** rg32uint grid texture data: gridSize³ × [count, solid_cell_index]. */
  grid: Uint32Array<ArrayBuffer>;
  /** `Seam[]` bytes (uvec2 a, uvec2 b — 16 B per seam), sorted by slice. */
  seams: ArrayBuffer;
  /** Triangles per atlas slice. */
  sliceTriangleCount: number[];
  /** Seams per atlas slice. */
  sliceSeamCount: number[];
  /** Grown scene bounds (feeds BakeParameters / raster push constants). */
  bounds: Aabb;
  gridSize: number;
}

/* ------------------------------------------------------------------ */
/* C++ view of the vertex used for hashing/equality                   */
/* ------------------------------------------------------------------ */

interface VertexKey {
  position: Vec3;
  uv: Vec2;
  normalXY: Vec2;
  normalZ: number;
}

function vertexEqual(a: VertexKey, b: VertexKey): boolean {
  // C++ operator== on 8 floats; JS === shares its -0/NaN semantics.
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.uv[0] === b.uv[0] &&
    a.uv[1] === b.uv[1] &&
    a.normalXY[0] === b.normalXY[0] &&
    a.normalXY[1] === b.normalXY[1] &&
    a.normalZ === b.normalZ
  );
}

/** Lexicographic Vector3 `operator<` (x, then y, then z). */
function vec3Less(a: Vec3, b: Vec3): boolean {
  if (a[0] === b[0]) {
    if (a[1] === b[1]) {
      return a[2] < b[2];
    }
    return a[1] < b[1];
  }
  return a[0] < b[0];
}

function vec3Equal(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** C++ `Edge`: endpoints + endpoint normals. */
interface Edge {
  a: Vec3;
  b: Vec3;
  na: Vec3;
  nb: Vec3;
}

/** C++ `EdgeUV2` (equality compares UVs only — GODOT-QUIRK). */
interface EdgeUV2 {
  a: Vec2;
  b: Vec2;
  indices: [number, number];
  seamFound: boolean;
}

function edgeEqual(a: Edge, b: Edge): boolean {
  return (
    vec3Equal(a.a, b.a) && vec3Equal(a.b, b.b) && vec3Equal(a.na, b.na) && vec3Equal(a.nb, b.nb)
  );
}

function edgeUv2Equal(a: EdgeUV2, b: EdgeUV2): boolean {
  return a.a[0] === b.a[0] && a.a[1] === b.a[1] && a.b[0] === b.b[0] && a.b[1] === b.b[1];
}

/* ------------------------------------------------------------------ */
/* Grid plotting (LightmapperRD::_plot_triangle_into_triangle_index_list) */
/* ------------------------------------------------------------------ */

function plotTriangleIntoTriangleIndexList(
  size: number,
  ofs: Vec3,
  cellBounds: Aabb,
  points: readonly [Vec3, Vec3, Vec3],
  triangleIndex: number,
  trianglesSort: TriangleSort[],
  gridSize: number,
): void {
  const halfSize = (size / 2) | 0;

  for (let i = 0; i < 8; i++) {
    const aabb: Aabb = { position: [...cellBounds.position], size: [...cellBounds.size] };
    aabb.size = [
      fr(aabb.size[0] * 0.5),
      fr(aabb.size[1] * 0.5),
      fr(aabb.size[2] * 0.5),
    ];
    const n: Vec3 = [ofs[0], ofs[1], ofs[2]];

    if (i & 1) {
      aabb.position = [fr(aabb.position[0] + aabb.size[0]), aabb.position[1], aabb.position[2]];
      n[0] += halfSize;
    }
    if (i & 2) {
      aabb.position = [aabb.position[0], fr(aabb.position[1] + aabb.size[1]), aabb.position[2]];
      n[1] += halfSize;
    }
    if (i & 4) {
      aabb.position = [aabb.position[0], aabb.position[1], fr(aabb.position[2] + aabb.size[2])];
      n[2] += halfSize;
    }

    {
      // quarter size, for fast aabb test
      const qsize: Vec3 = [
        fr(aabb.size[0] * 0.5),
        fr(aabb.size[1] * 0.5),
        fr(aabb.size[2] * 0.5),
      ];

      if (!triangleBoxOverlap(aabbGetCenter(aabb), qsize, points)) {
        //does not fit in child, go on
        continue;
      }
    }

    if (halfSize === 1) {
      //got to the end
      const ts: TriangleSort = {
        cellIndex: n[0] + n[1] * gridSize + n[2] * gridSize * gridSize,
        triangleIndex,
        triangleAabb: aabbAt(points[0]),
      };
      aabbExpandTo(ts.triangleAabb, points[1]);
      aabbExpandTo(ts.triangleAabb, points[2]);
      trianglesSort.push(ts);
    } else {
      plotTriangleIntoTriangleIndexList(halfSize, n, aabb, points, triangleIndex, trianglesSort, gridSize);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cluster building (LightmapperRD::_sort_triangle_clusters)           */
/* ------------------------------------------------------------------ */

function sortTriangleClusters(
  clusterSize: number,
  clusterIndex: number,
  indexStart: number,
  count: number,
  triangleSort: TriangleSort[],
  clusterAabbs: Array<{ minBounds: Vec3; pad0: number; maxBounds: Vec3; pad1: number }>,
): void {
  if (count === 0) {
    return;
  }

  // Compute AABB for all triangles in the range.
  const clusterAabb: Aabb = { position: [...triangleSort[indexStart].triangleAabb.position], size: [...triangleSort[indexStart].triangleAabb.size] };
  for (let i = 1; i < count; i++) {
    aabbMergeWith(clusterAabb, triangleSort[indexStart + i].triangleAabb);
  }

  if (count > clusterSize) {
    const longestAxisIndex = aabbGetLongestAxisIndex(clusterAabb);
    // C++ sorts the sub-range in place (`sorter.sort(&arr[start], count)`)
    // comparing get_center()[axis]; the same f32 center math per element.
    // Ties keep introsort's (unstable) order — replicated exactly by the
    // SortArray port, matching native buffer bytes.
    const axis = longestAxisIndex;
    sortArrayRange(triangleSort, indexStart, count, (a, b) => {
      const ca = aabbGetCenter(a.triangleAabb)[axis];
      const cb = aabbGetCenter(b.triangleAabb)[axis];
      return ca < cb;
    });

    let leftClusterCount = nextPowerOf2((count / 2) | 0);
    leftClusterCount = Math.max(leftClusterCount, clusterSize);
    leftClusterCount = Math.min(leftClusterCount, count);
    sortTriangleClusters(clusterSize, clusterIndex, indexStart, leftClusterCount, triangleSort, clusterAabbs);

    if (leftClusterCount < count) {
      const clusterIndexRight = clusterIndex + ((leftClusterCount / clusterSize) | 0);
      sortTriangleClusters(clusterSize, clusterIndexRight, indexStart + leftClusterCount, count - leftClusterCount, triangleSort, clusterAabbs);
    }
  } else {
    const aabbEnd = aabbGetEnd(clusterAabb);
    clusterAabbs[clusterIndex] = {
      minBounds: [clusterAabb.position[0], clusterAabb.position[1], clusterAabb.position[2]],
      pad0: 0,
      maxBounds: [aabbEnd[0], aabbEnd[1], aabbEnd[2]],
      pad1: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* The main port                                                       */
/* ------------------------------------------------------------------ */

export function createAccelerationStructures(
  meshes: readonly AccelMesh[],
  atlasSize: Vec2,
  atlasSlices: number,
  probePositions: Float32Array | null,
  gridSize: number = GRID_SIZE,
  clusterSize: number = CLUSTER_SIZE,
): AccelStructures {
  // HashMap<Vertex, uint32_t, VertexHash>: hash buckets + 8-float equality.
  const vertexMap = new Map<number, Array<{ key: VertexKey; index: number }>>();

  //fill triangles array and vertex array
  const triangles: CpuTriangle[] = [];
  const vertexArray: VertexKey[] = [];
  const seams: CpuSeam[] = [];

  const sliceTriangleCount = new Array<number>(atlasSlices).fill(0);
  const sliceSeamCount = new Array<number>(atlasSlices).fill(0);

  const bounds = aabbAt([0, 0, 0]);

  for (let mI = 0; mI < meshes.length; mI++) {
    // HashMap<Edge, EdgeUV2, EdgeHash> — per mesh (hash-keyed buckets,
    // equality incl. normals: GODOT-QUIRK).
    const edges = new Map<number, Array<{ edge: Edge; uv2: EdgeUV2 }>>();

    const mi = meshes[mI];

    const uvScale: Vec2 = [
      fr(mi.lightmapSize[0] / atlasSize[0]),
      fr(mi.lightmapSize[1] / atlasSize[1]),
    ];
    const uvOffset: Vec2 = [
      fr(mi.offset[0] / atlasSize[0]),
      fr(mi.offset[1] / atlasSize[1]),
    ];
    if (mI === 0) {
      bounds.position = [mi.positions[0], mi.positions[1], mi.positions[2]];
    }

    const triangleCount = mi.positions.length / 9;
    for (let t = 0; t < triangleCount; t++) {
      const i = t * 3;
      const vtxs: [Vec3, Vec3, Vec3] = [
        [mi.positions[i * 3], mi.positions[i * 3 + 1], mi.positions[i * 3 + 2]],
        [mi.positions[(i + 1) * 3], mi.positions[(i + 1) * 3 + 1], mi.positions[(i + 1) * 3 + 2]],
        [mi.positions[(i + 2) * 3], mi.positions[(i + 2) * 3 + 1], mi.positions[(i + 2) * 3 + 2]],
      ];
      const uvs: [Vec2, Vec2, Vec2] = [
        [
          fr(fr(mi.uv2[i * 2] * uvScale[0]) + uvOffset[0]),
          fr(fr(mi.uv2[i * 2 + 1] * uvScale[1]) + uvOffset[1]),
        ],
        [
          fr(fr(mi.uv2[(i + 1) * 2] * uvScale[0]) + uvOffset[0]),
          fr(fr(mi.uv2[(i + 1) * 2 + 1] * uvScale[1]) + uvOffset[1]),
        ],
        [
          fr(fr(mi.uv2[(i + 2) * 2] * uvScale[0]) + uvOffset[0]),
          fr(fr(mi.uv2[(i + 2) * 2 + 1] * uvScale[1]) + uvOffset[1]),
        ],
      ];
      const normal: [Vec3, Vec3, Vec3] = [
        [mi.normals[i * 3], mi.normals[i * 3 + 1], mi.normals[i * 3 + 2]],
        [mi.normals[(i + 1) * 3], mi.normals[(i + 1) * 3 + 1], mi.normals[(i + 1) * 3 + 2]],
        [mi.normals[(i + 2) * 3], mi.normals[(i + 2) * 3 + 1], mi.normals[(i + 2) * 3 + 2]],
      ];

      const taabb = aabbAt(vtxs[0]);
      const tri: CpuTriangle = {
        indices: [0, 0, 0],
        slice: mi.slice,
        minBounds: [0, 0, 0],
        cullMode: mi.cullMode,
        maxBounds: [0, 0, 0],
        pad1: 0,
      };
      for (let k = 0; k < 3; k++) {
        aabbExpandTo(bounds, vtxs[k]);

        const v: VertexKey = {
          position: vtxs[k],
          uv: uvs[k],
          normalXY: [normal[k][0], normal[k][1]],
          normalZ: normal[k][2],
        };

        const bucketKey = vertexHash(v);
        let bucket = vertexMap.get(bucketKey);
        if (bucket === undefined) {
          bucket = [];
          vertexMap.set(bucketKey, bucket);
        }
        let existing: number | undefined;
        for (const entry of bucket) {
          if (vertexEqual(entry.key, v)) {
            existing = entry.index;
            break;
          }
        }

        if (existing !== undefined) {
          tri.indices[k] = existing;
        } else {
          const newIndex = vertexArray.length;
          tri.indices[k] = newIndex;
          bucket.push({ key: v, index: newIndex });
          vertexArray.push(v);
        }
      }
      aabbExpandTo(taabb, vtxs[1]);
      aabbExpandTo(taabb, vtxs[2]);

      //compute seams that will need to be blended later
      for (let k = 0; k < 3; k++) {
        const n = (k + 1) % 3;

        const edge: Edge = { a: vtxs[k], b: vtxs[n], na: normal[k], nb: normal[n] };
        const edgeIndices: [number, number] = [tri.indices[k], tri.indices[n]];
        // EdgeUV2 copies `edge_indices` in the C++ constructor — keep them
        // separate and swap both in lock-step below.
        const uv2: EdgeUV2 = {
          a: uvs[k],
          b: uvs[n],
          indices: [edgeIndices[0], edgeIndices[1]],
          seamFound: false,
        };

        if (vec3Equal(edge.b, edge.a)) {
          continue; //degenerate, somehow
        }
        if (vec3Less(edge.b, edge.a)) {
          // SWAP(edge.a, edge.b); SWAP(edge.na, edge.nb);
          // SWAP(uv2.a, uv2.b); SWAP(uv2.indices.x, uv2.indices.y);
          // SWAP(edge_indices.x, edge_indices.y)
          let tmp: Vec3 = edge.a;
          edge.a = edge.b;
          edge.b = tmp;
          tmp = edge.na;
          edge.na = edge.nb;
          edge.nb = tmp;
          let tmpV2: Vec2 = uv2.a;
          uv2.a = uv2.b;
          uv2.b = tmpV2;
          let tmpIdx = uv2.indices[0];
          uv2.indices[0] = uv2.indices[1];
          uv2.indices[1] = tmpIdx;
          tmpIdx = edgeIndices[0];
          edgeIndices[0] = edgeIndices[1];
          edgeIndices[1] = tmpIdx;
        }

        const edgeBucketKey = edgeHash(edge.a, edge.b);
        let edgeBucket = edges.get(edgeBucketKey);
        if (edgeBucket === undefined) {
          edgeBucket = [];
          edges.set(edgeBucketKey, edgeBucket);
        }
        const found = edgeBucket.find((e) => edgeEqual(e.edge, edge));
        if (found === undefined) {
          edgeBucket.push({ edge, uv2 });
        } else {
          if (edgeUv2Equal(found.uv2, uv2)) {
            continue; // seam shared UV space, no need to blend
          }
          if (found.uv2.seamFound) {
            continue; //bad geometry
          }

          seams.push({ a: [...edgeIndices] as [number, number], b: [...found.uv2.indices] as [number, number], slice: mi.slice });
          sliceSeamCount[mi.slice]++;
          found.uv2.seamFound = true;
        }
      }

      tri.minBounds = [taabb.position[0], taabb.position[1], taabb.position[2]];
      tri.maxBounds = [
        fr(taabb.position[0] + Math.max(taabb.size[0], 0.0001)),
        fr(taabb.position[1] + Math.max(taabb.size[1], 0.0001)),
        fr(taabb.position[2] + Math.max(taabb.size[2], 0.0001)),
      ];

      triangles.push(tri);
      sliceTriangleCount[tri.slice]++;
    }
  }

  //also consider probe positions for bounds
  if (probePositions !== null) {
    for (let i = 0; i + 2 < probePositions.length; i += 4) {
      aabbExpandTo(bounds, [probePositions[i], probePositions[i + 1], probePositions[i + 2]]);
    }
  }
  aabbGrowBy(bounds, 0.1); //grow a bit to avoid numerical error

  sortArray(triangles, (a, b) => a.slice < b.slice); //sort by slice
  sortArray(seams, (a, b) => a.slice < b.slice);

  //fill list of triangles in grid
  const triangleSort: TriangleSort[] = [];
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const face: [Vec3, Vec3, Vec3] = [
      vertexPosition(vertexArray, t.indices[0]),
      vertexPosition(vertexArray, t.indices[1]),
      vertexPosition(vertexArray, t.indices[2]),
    ];
    plotTriangleIntoTriangleIndexList(gridSize, [0, 0, 0], bounds, face, i, triangleSort, gridSize);
  }
  //sort it
  sortArray(triangleSort, (a, b) => a.cellIndex < b.cellIndex);

  const clusterIndices: number[] = [];
  const clusterAabbs: Array<{ minBounds: Vec3; pad0: number; maxBounds: Vec3; pad1: number }> = [];
  const triangleIndices = new Uint32Array(triangleSort.length);
  const gridIndices = new Uint32Array(gridSize * gridSize * gridSize * 2);

  {
    // Fill grid with cell indices.
    let lastCell = 0xffffffff;
    let clusterCount = 0;
    let solidCellCount = 0;
    for (let i = 0; i < triangleSort.length; i++) {
      const cell = triangleSort[i].cellIndex;

      if (cell !== lastCell) {
        gridIndices[cell * 2 + 1] = solidCellCount;
        solidCellCount++;
      }

      if (gridIndices[cell * 2] % clusterSize === 0) {
        // Add an extra cluster every time the triangle counter reaches a
        // multiple of the cluster size.
        clusterCount++;
      }

      gridIndices[cell * 2]++;
      lastCell = cell;
    }

    // Build fixed-size triangle clusters for all the cells to speed up the
    // traversal. A cell can hold multiple clusters that each contain a
    // fixed amount of triangles and an AABB. The tracer will check against
    // the AABBs first to know whether it needs to visit the cell's
    // triangles.
    //
    // The building algorithm will divide the triangles recursively
    // contained inside each cell, sorting by the longest axis of the AABB
    // on each step.
    //
    // - If the amount of triangles is less or equal to the cluster size,
    //   the AABB will be stored and the algorithm stops.
    //
    // - The division by two is increased to the next power of two of half
    //   the amount of triangles (with cluster size as the minimum value)
    //   to ensure the first half always fills the cluster.

    clusterAabbs.length = 0;
    for (let i = 0; i < clusterCount; i++) {
      // Zero-initialized slots; every index is written by the recursion
      // below (left counts are cluster-size multiples).
      clusterAabbs.push({ minBounds: [0, 0, 0], pad0: 0, maxBounds: [0, 0, 0], pad1: 0 });
    }

    let i = 0;
    let clusterIndex = 0;
    let solidCellIndex = 0;
    while (i < triangleSort.length) {
      clusterIndices[solidCellIndex * 2] = clusterIndex;
      clusterIndices[solidCellIndex * 2 + 1] = i;

      const cell = triangleSort[i].cellIndex;
      const triangleCount = gridIndices[cell * 2];
      const cellClusterCount = ((triangleCount + clusterSize - 1) / clusterSize) | 0;
      sortTriangleClusters(clusterSize, clusterIndex, i, triangleCount, triangleSort, clusterAabbs);

      for (let j = 0; j < triangleCount; j++) {
        triangleIndices[i + j] = triangleSort[i + j].triangleIndex;
      }

      i += triangleCount;
      clusterIndex += cellClusterCount;
      solidCellIndex++;
    }
  }

  /*****************************/
  /*** CREATE GPU STRUCTURES ***/
  /*****************************/

  // (lights/probes buffers are packed by scene/lights.ts and scene/probes.ts)

  const vertexBuffer = pack(
    STRUCT_SIZES.vertex,
    vertexArray.length,
    vertexArray,
    (view, o, v) =>
      writeVertex(view, o, {
        position: v.position,
        normalZ: v.normalZ,
        uv: v.uv,
        normalXY: v.normalXY,
      }),
  );

  const triangleBuffer = pack(STRUCT_SIZES.triangle, triangles.length, triangles, (view, o, t) =>
    writeTriangle(view, o, {
      indices: t.indices,
      slice: t.slice,
      minBounds: t.minBounds,
      cullMode: t.cullMode,
      maxBounds: t.maxBounds,
      pad1: t.pad1,
    }),
  );

  const clusterAabbBuffer = pack(STRUCT_SIZES.clusterAABB, clusterAabbs.length, clusterAabbs, (view, o, c) =>
    writeClusterAABB(view, o, {
      minBounds: c.minBounds,
      pad0: 0,
      maxBounds: c.maxBounds,
      pad1: 0,
    }),
  );

  // Seams: uvec2 pairs (a, b) — 16 bytes per seam.
  // GODOT-QUIRK: "Even when there are no seams, the buffer must exist" —
  // Godot uploads two zeroed Vector2i (32 bytes) in that case only.
  const seamBytes = new ArrayBuffer(seams.length === 0 ? 32 : seams.length * 16);
  {
    const view = new DataView(seamBytes);
    for (let i = 0; i < seams.length; i++) {
      view.setUint32(i * 16 + 0, seams[i].a[0], true);
      view.setUint32(i * 16 + 4, seams[i].a[1], true);
      view.setUint32(i * 16 + 8, seams[i].b[0], true);
      view.setUint32(i * 16 + 12, seams[i].b[1], true);
    }
  }

  return {
    vertices: vertexBuffer,
    triangles: triangleBuffer,
    triangleIndices,
    clusterIndices: new Uint32Array(clusterIndices),
    clusterAabbs: clusterAabbBuffer,
    grid: gridIndices,
    seams: seamBytes,
    sliceTriangleCount,
    sliceSeamCount,
    bounds,
    gridSize,
  };
}

function vertexPosition(vertexArray: VertexKey[], index: number): Vec3 {
  const v = vertexArray[index];
  return [v.position[0], v.position[1], v.position[2]];
}

/* ------------------------------------------------------------------ */
/* cluster_data merged buffer (ADR-0005, DESIGN §5 binding 12)         */
/* ------------------------------------------------------------------ */

/** Result of merging the cluster arrays into the single binding-12 buffer. */
export interface ClusterData {
  buffer: ArrayBuffer;
  /** Offset (in u32 elements) where the ClusterAABB array starts. */
  aabbOffsetU32: number;
  /** Padded length (in u32 elements) of the indices region. */
  indicesLengthU32: number;
}

/**
 * Merge `clusterIndices` (u32 pairs per solid cell) and `clusterAabbs`
 * into the single `cluster_data` storage buffer Godot splits across two
 * bindings (ADR-0005: stay within WebGPU's 8-storage-buffer core limit).
 * The indices region is zero-padded so the AABB array starts 32-byte
 * aligned (ClusterAABB stride); the WGSL side views both regions from
 * this one buffer.
 */
export function packClusterData(clusterIndices: Uint32Array, clusterAabbs: ArrayBuffer): ClusterData {
  const indicesLengthU32 = ((clusterIndices.length + 7) & ~7) >>> 0; // pad to 32 B
  const buffer = new ArrayBuffer(indicesLengthU32 * 4 + clusterAabbs.byteLength);
  new Uint8Array(buffer, 0, clusterIndices.byteLength).set(
    new Uint8Array(clusterIndices.buffer, clusterIndices.byteOffset, clusterIndices.byteLength),
  );
  new Uint8Array(buffer, indicesLengthU32 * 4, clusterAabbs.byteLength).set(new Uint8Array(clusterAabbs));
  return {
    buffer,
    aabbOffsetU32: indicesLengthU32,
    indicesLengthU32,
  };
}
