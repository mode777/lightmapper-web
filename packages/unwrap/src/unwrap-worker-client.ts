/**
 * Main-thread handle for the unwrap worker (browser only).
 *
 * Usage:
 *   const worker = new UnwrapWorker();
 *   const result = await worker.unwrapMesh({ ... });
 *   worker.dispose();   // or reuse across meshes/bakes
 */

import type { UnwrapInput, UnwrapResult } from './index.js';
import type { UnwrapRequestMessage, UnwrapResponseMessage } from './worker.js';

export class UnwrapWorker {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: UnwrapResult) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<UnwrapResponseMessage>) => {
      const data = event.data;
      const entry = data && this.pending.get(data.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(data.id);
      if (data.type === 'result') {
        entry.resolve(data.result);
      } else {
        entry.reject(new Error(data.message));
      }
    });
    this.worker.addEventListener('messageerror', () => {
      // Fail every pending request; the worker is in an unknown state.
      for (const [, entry] of this.pending) {
        entry.reject(new Error('unwrap worker: message error'));
      }
      this.pending.clear();
    });
  }

  /** Unwrap one mesh in the worker (input arrays are transferred in). */
  unwrapMesh(input: UnwrapInput): Promise<UnwrapResult> {
    const id = this.nextId++;
    const request: UnwrapRequestMessage = { type: 'unwrap', id, input };
    const transfer: ArrayBuffer[] = [];
    if (input.indices !== undefined) {
      transfer.push(input.indices.buffer as ArrayBuffer);
    }

    return new Promise<UnwrapResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error('unwrap worker: disposed'));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
