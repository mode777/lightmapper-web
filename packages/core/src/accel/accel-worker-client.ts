/**
 * Main-thread handle for the acceleration-structure worker (browser only).
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
    this.worker.addEventListener('messageerror', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error('accel worker: message error'));
      }
      this.pending.clear();
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
    for (const [, entry] of this.pending) {
      entry.reject(new Error('accel worker: disposed'));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
