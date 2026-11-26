/**
 * Main-thread handle for the acceleration-structure worker (browser only).
 *
 * Provenance (semantics): hosting `LightmapperRD::_create_acceleration_structures`
 * off the main thread is our infrastructure (ARCHITECTURE §5); everything
 * computed is the M1 port in accel/accel.ts @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. License: MIT (see NOTICE.md).
 *
 * Usage:
 *   const worker = new AccelWorkerHost();
 *   const accel = await worker.build({ meshes, atlasSize, atlasSlices, ... });
 *   worker.dispose();   // or reuse across bakes
 */

import type { AccelMesh, AccelStructures } from './accel.js';
import type { AccelRequestMessage, AccelResponseMessage } from './worker.js';

export interface AccelBuildInput {
  meshes: AccelMesh[];
  atlasSize: [number, number];
  atlasSlices: number;
  probePositions: Float32Array | null;
  gridSize?: number;
  clusterSize?: number;
}

export class AccelWorkerHost {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: AccelStructures) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<AccelResponseMessage>) => {
      const data = event.data;
      const entry = data && this.pending.get(data.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(data.id);
      if (data.type === 'result') {
        entry.resolve(data.result);
      } else {
        entry.reject(new Error(`accel worker: ${data.message}`));
      }
    });
    // A failed script load or a top-level throw never produces a message —
    // without this the pending build() would hang forever.
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      this.failAll(new Error(`accel worker: ${event.message || 'failed to load'}`));
    });
    this.worker.addEventListener('messageerror', () => {
      this.failAll(new Error('accel worker: message error'));
    });
  }

  /** Build the acceleration structures in the worker. */
  build(input: AccelBuildInput): Promise<AccelStructures> {
    const id = this.nextId++;
    const request: AccelRequestMessage = { type: 'accel', id, ...input };
    const transfer: ArrayBuffer[] = [];
    if (input.probePositions !== null) {
      transfer.push(input.probePositions.buffer as ArrayBuffer);
    }
    return new Promise<AccelStructures>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  dispose(): void {
    this.failAll(new Error('accel worker: disposed'));
    this.worker.terminate();
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
