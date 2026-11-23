/// <reference lib="webworker" />
/**
 * Acceleration-structure worker — hosts `createAccelerationStructures`
 * off the main thread (ARCHITECTURE §5: the build is pure CPU — sorts,
 * hashing, recursion).
 *
 * Provenance (semantics): the worker-hosting itself is our infrastructure;
 * everything computed here is the M1 port in accel/accel.ts
 * (LightmapperRD::_create_acceleration_structures @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0). License: MIT (see NOTICE.md).
 */

import { createAccelerationStructures, type AccelMesh, type AccelStructures } from './accel.js';

export interface AccelRequestMessage {
  type: 'accel';
  id: number;
  meshes: AccelMesh[];
  atlasSize: [number, number];
  atlasSlices: number;
  probePositions: Float32Array | null;
  gridSize?: number;
  clusterSize?: number;
}

export type AccelResponseMessage =
  | { type: 'result'; id: number; result: AccelStructures }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<AccelRequestMessage>) => {
  const msg = event.data;
  if (msg === undefined || msg.type !== 'accel') {
    return;
  }
  try {
    const result = createAccelerationStructures(
      msg.meshes,
      msg.atlasSize,
      msg.atlasSlices,
      msg.probePositions,
      msg.gridSize,
      msg.clusterSize,
    );
    // Transfer every fresh buffer back to the main thread.
    const transfer: ArrayBuffer[] = [
      result.vertices,
      result.triangles,
      result.triangleIndices.buffer as ArrayBuffer,
      result.clusterIndices.buffer as ArrayBuffer,
      result.clusterAabbs,
      result.grid.buffer as ArrayBuffer,
      result.seams,
    ];
    const response: AccelResponseMessage = { type: 'result', id: msg.id, result };
    ctx.postMessage(response, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response: AccelResponseMessage = { type: 'error', id: msg.id, message };
    ctx.postMessage(response);
  }
});
