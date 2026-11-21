/**
 * Port of Godot's light-probe position generation.
 *
 * Provenance: godot/scene/3d/lightmap_gi.cpp — the "STEP 2, CREATE PROBES"
 * block of `LightmapGI::_bake`, plus `LightmapGI::_plot_triangle_into_octree`
 * and `LightmapGI::_gen_new_positions_from_octree` @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * Also godot/modules/lightmapper_rd/lightmapper_rd.cpp (`LightmapperRD::add_probe`).
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Godot splits this work across two layers: the LightmapGI *node* decides
 * where probes go (user probes + octree subdivision over the scene bounds),
 * then hands plain positions to LightmapperRD. We reproduce that split:
 * this module is the scene-layer equivalent; the bake driver later uploads
 * the result unchanged (`vec4` positions, w = 0).
 *
 * Behavior ported faithfully, including quirks:
 *  - bounds for probe placement are grown by `size.length() * 0.001` *and*
 *    then snapped (non-longest axes only) to whole probe cells — probe grids
 *    can extend past the geometry bounds;
 *  - when generation is disabled, Godot still creates 8 probes on the
 *    bounds' endpoints;
 *  - generated probes closer than `cell_size * 0.5` to a *user* probe are
 *    dropped (user probes win); endpoint probes skip this check;
 *  - positions are recomputed as `bounds.position + Vector3i(pos) * cell`
 *    every time ("use same formula for numerical stability").
 */

import { triangleBoxOverlap } from '../math/geometry3d.js';
import {
  aabbAt,
  aabbExpandTo,
  aabbGetCenter,
  aabbGetEndpoint,
  aabbGetLongestAxisIndex,
  aabbGrowBy,
  aabbSizeLength,
  distanceSquaredTo,
  type Aabb,
} from '../math/aabb.js';
import type { Vec3 } from '../layout/structs.js';
import { GENERATE_PROBES_SUBDIV, type GenerateProbesMode } from './types.js';

const fr = Math.fround;

/** Godot `LightmapGI::GenProbesOctree` — a cell of the probe-placement octree. */
interface ProbesOctreeCell {
  offset: [number, number, number];
  size: number;
  children: (ProbesOctreeCell | null)[]; // length 8
}

/** Result of probe generation. */
export interface ProbeGeneration {
  /** xyzw-packed probe positions (w = 0), row-major vec4 per probe. */
  positions: Float32Array;
  /** The (cell-snapped) bounds the probes were placed in. */
  bounds: Aabb;
  /** Integer cell-grid limit per axis (equal to `subdiv` on the longest axis). */
  boundLimit: [number, number, number];
  /** Probe cell size in world units (0 when disabled). */
  cellSize: number;
  /** User probes (kept first, in insertion order — Godot's `probes_found`). */
  userProbes: Vec3[];
  /** Generated probes appended after the user probes. */
  generatedProbes: Vec3[];
}

/** Port of `LightmapGI::_plot_triangle_into_octree` (triangle points relative to `bounds.position`). */
function plotTriangleIntoOctree(
  cell: ProbesOctreeCell,
  cellSize: number,
  triangle: readonly [Vec3, Vec3, Vec3],
): void {
  for (let i = 0; i < 8; i++) {
    const pos: [number, number, number] = [cell.offset[0], cell.offset[1], cell.offset[2]];
    const halfSize = (cell.size / 2) | 0; // uint32_t half_size = p_cell->size / 2
    if (i & 1) {
      pos[0] += halfSize;
    }
    if (i & 2) {
      pos[1] += halfSize;
    }
    if (i & 4) {
      pos[2] += halfSize;
    }

    const subcell: Aabb = {
      position: [fr(pos[0] * cellSize), fr(pos[1] * cellSize), fr(pos[2] * cellSize)],
      size: [fr(fr(halfSize) * cellSize), fr(fr(halfSize) * cellSize), fr(fr(halfSize) * cellSize)],
    };

    const center = aabbGetCenter(subcell);
    const half: Vec3 = [
      fr(subcell.size[0] * 0.5),
      fr(subcell.size[1] * 0.5),
      fr(subcell.size[2] * 0.5),
    ];
    if (!triangleBoxOverlap(center, half, triangle)) {
      continue;
    }

    if (cell.children[i] === null) {
      const child: ProbesOctreeCell = {
        offset: [pos[0], pos[1], pos[2]],
        size: halfSize,
        children: [null, null, null, null, null, null, null, null],
      };
      cell.children[i] = child;
    }

    if (halfSize > 1) {
      //still levels missing
      plotTriangleIntoOctree(cell.children[i]!, cellSize, triangle);
    }
  }
}

function key(pos: readonly [number, number, number]): string {
  return `${pos[0]},${pos[1]},${pos[2]}`;
}

/**
 * Port of `LightmapGI::_gen_new_positions_from_octree`.
 * @param cellSize probe cell size (subdiv_cell_size)
 * @param userProbes user-submitted positions (`probe_positions` upstream)
 * @param newProbePositions accumulator (`new_probe_positions` upstream)
 * @param positionsUsed `HashMap<Vector3i, bool>` — string-keyed Map
 * @param bounds cell-snapped scene bounds
 */
function genNewPositionsFromOctree(
  cell: ProbesOctreeCell,
  cellSize: number,
  userProbes: readonly Vec3[],
  newProbePositions: Vec3[],
  positionsUsed: Map<string, boolean>,
  bounds: Aabb,
): void {
  for (let i = 0; i < 8; i++) {
    const pos: [number, number, number] = [cell.offset[0], cell.offset[1], cell.offset[2]];
    if (i & 1) {
      pos[0] += cell.size;
    }
    if (i & 2) {
      pos[1] += cell.size;
    }
    if (i & 4) {
      pos[2] += cell.size;
    }

    if (cell.size === 1 && !positionsUsed.has(key(pos))) {
      //new position to insert!
      const realPos: Vec3 = [
        fr(bounds.position[0] + fr(pos[0] * cellSize)),
        fr(bounds.position[1] + fr(pos[1] * cellSize)),
        fr(bounds.position[2] + fr(pos[2] * cellSize)),
      ];
      //see if a user submitted probe is too close
      let exists = false;
      const threshold = fr(cellSize * 0.5);
      for (const pp of userProbes) {
        // Vector3::distance_to = sqrt of the f32-accumulated squared distance
        if (fr(Math.sqrt(distanceSquaredTo(pp, realPos))) < threshold) {
          exists = true;
          break;
        }
      }

      if (!exists) {
        newProbePositions.push(realPos);
      }

      positionsUsed.set(key(pos), true);
    }

    if (cell.children[i] !== null) {
      genNewPositionsFromOctree(cell.children[i]!, cellSize, userProbes, newProbePositions, positionsUsed, bounds);
    }
  }
}

/**
 * Port of the bounds computation in `LightmapGI::_bake` steps 1–2:
 * union of all mesh points and user probes, then
 * `grow_by(bounds.size.length() * 0.001)`.
 *
 * @param meshPositions per-mesh position soups (indexed geometry must be expanded first)
 */
export function computeProbeBounds(meshPositions: readonly Float32Array[], userProbes: readonly Vec3[]): Aabb {
  if (meshPositions.length === 0 && userProbes.length === 0) {
    throw new Error('cannot compute probe bounds: scene has no meshes and no probes');
  }

  const bounds = aabbAt([0, 0, 0]);
  let seeded = false;
  for (const positions of meshPositions) {
    for (let i = 0; i < positions.length; i += 3) {
      const p: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
      if (!seeded) {
        bounds.position = [p[0], p[1], p[2]];
        seeded = true;
      } else {
        aabbExpandTo(bounds, p);
      }
    }
  }

  //bounds need to include the user probes
  for (const pp of userProbes) {
    aabbExpandTo(bounds, pp);
  }

  aabbGrowBy(bounds, fr(aabbSizeLength(bounds) * 0.001));
  return bounds;
}

/**
 * Generate probe positions from an explicit bounds (use
 * `computeProbeBounds` for the Godot-faithful scene bounds).
 *
 * Port of the `gen_probes` branch of `LightmapGI::_bake` step 2, including
 * cell-snapping of the bounds on the non-longest axes.
 */
export function generateProbesFromBounds(
  boundsIn: Aabb,
  meshPositions: readonly Float32Array[],
  userProbes: readonly Vec3[],
  mode: GenerateProbesMode,
): ProbeGeneration {
  const bounds: Aabb = { position: [...boundsIn.position], size: [...boundsIn.size] };

  if (mode === 'disabled') {
    // generate 8 probes on bound endpoints
    const generated: Vec3[] = [];
    for (let i = 0; i < 8; i++) {
      generated.push(aabbGetEndpoint(bounds, i));
    }
    return {
      positions: packProbePositions(userProbes, generated),
      bounds,
      boundLimit: [0, 0, 0],
      cellSize: 0,
      userProbes: [...userProbes],
      generatedProbes: generated,
    };
  }

  // detect probes from geometry
  const subdiv = GENERATE_PROBES_SUBDIV[mode];

  let subdivCellSize: number;
  let boundLimit: [number, number, number];
  {
    const longestAxis = aabbGetLongestAxisIndex(bounds);
    subdivCellSize = fr(bounds.size[longestAxis] / subdiv);
    const axisN1 = (longestAxis + 1) % 3;
    const axisN2 = (longestAxis + 2) % 3;

    boundLimit = [0, 0, 0];
    boundLimit[longestAxis] = subdiv;
    boundLimit[axisN1] = Math.trunc(Math.ceil(fr(bounds.size[axisN1] / subdivCellSize)));
    boundLimit[axisN2] = Math.trunc(Math.ceil(fr(bounds.size[axisN2] / subdivCellSize)));
    //compensate bounds
    bounds.size[axisN1] = fr(boundLimit[axisN1] * subdivCellSize);
    bounds.size[axisN2] = fr(boundLimit[axisN2] * subdivCellSize);
  }

  const octree: ProbesOctreeCell = {
    offset: [0, 0, 0],
    size: subdiv,
    children: [null, null, null, null, null, null, null, null],
  };

  for (const positions of meshPositions) {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const triangle: readonly [Vec3, Vec3, Vec3] = [
        [fr(positions[i] - bounds.position[0]), fr(positions[i + 1] - bounds.position[1]), fr(positions[i + 2] - bounds.position[2])],
        [fr(positions[i + 3] - bounds.position[0]), fr(positions[i + 4] - bounds.position[1]), fr(positions[i + 5] - bounds.position[2])],
        [fr(positions[i + 6] - bounds.position[0]), fr(positions[i + 7] - bounds.position[1]), fr(positions[i + 8] - bounds.position[2])],
      ];
      plotTriangleIntoOctree(octree, subdivCellSize, triangle);
    }
  }

  const newProbePositions: Vec3[] = [];
  const positionsUsed = new Map<string, boolean>();
  for (let i = 0; i < 8; i++) {
    //insert bounding endpoints
    const pos: [number, number, number] = [0, 0, 0];
    if (i & 1) {
      pos[0] += boundLimit[0];
    }
    if (i & 2) {
      pos[1] += boundLimit[1];
    }
    if (i & 4) {
      pos[2] += boundLimit[2];
    }

    positionsUsed.set(key(pos), true);
    const realPos: Vec3 = [
      fr(bounds.position[0] + fr(pos[0] * subdivCellSize)),
      fr(bounds.position[1] + fr(pos[1] * subdivCellSize)),
      fr(bounds.position[2] + fr(pos[2] * subdivCellSize)),
    ]; //use same formula for numerical stability
    newProbePositions.push(realPos);
  }
  //skip first level, since probes are always added at bounds endpoints anyway (code above this)
  for (let i = 0; i < 8; i++) {
    if (octree.children[i]) {
      genNewPositionsFromOctree(octree.children[i]!, subdivCellSize, userProbes, newProbePositions, positionsUsed, bounds);
    }
  }

  return {
    positions: packProbePositions(userProbes, newProbePositions),
    bounds,
    boundLimit,
    cellSize: subdivCellSize,
    userProbes: [...userProbes],
    generatedProbes: newProbePositions,
  };
}

/** Pack user + generated probes into the GPU layout: `vec4` positions with w = 0 (Godot `Probe`). */
function packProbePositions(userProbes: readonly Vec3[], generated: readonly Vec3[]): Float32Array {
  const out = new Float32Array((userProbes.length + generated.length) * 4);
  let o = 0;
  for (const p of [...userProbes, ...generated]) {
    out[o++] = p[0];
    out[o++] = p[1];
    out[o++] = p[2];
    out[o++] = 0; // Godot: probe.position[3] = 0
  }
  return out;
}

/**
 * Pack the probe-position storage buffer (group 0 binding 6, `vec4[]`).
 *
 * GODOT-QUIRK: "Even when there are no probes, the buffer must exist" —
 * Godot uploads one zeroed `Probe` (16 bytes). We mirror that.
 */
export function packProbesBuffer(positions: Float32Array): ArrayBuffer {
  if (positions.length === 0) {
    return new ArrayBuffer(16);
  }
  return positions.slice().buffer;
}

/** Convenience: compute scene bounds and generate probes in one call (the order Godot's `_bake` uses). */
export function generateProbes(
  meshPositions: readonly Float32Array[],
  userProbes: readonly Vec3[],
  mode: GenerateProbesMode,
): ProbeGeneration {
  const bounds = computeProbeBounds(meshPositions, userProbes);
  return generateProbesFromBounds(bounds, meshPositions, userProbes, mode);
}
