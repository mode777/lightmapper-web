/**
 * The `Params` ring buffer — WebGPU's push-constant replacement (ADR-0003).
 *
 * Provenance (semantics): Godot sets a 32–64 B push constant per compute
 * dispatch / render draw (`compute_list_set_push_constant`,
 * `draw_list_set_push_constant`), godot/modules/lightmapper_rd/
 * lightmapper_rd.cpp @ 67421f36e5069e62573c44beb8dd2f8f91e065b0.
 * WebGPU has no push constants, so group 2 binding 0 holds the struct in a
 * uniform buffer bound with **dynamic offsets**; this class hands out
 * 256 B-aligned slots for each write. License: MIT (see NOTICE.md).
 *
 * Slot size 256 B satisfies `minUniformBufferOffsetAlignment` on every
 * WebGPU implementation (spec floor is 256).
 *
 * Usage contract: `queue.writeBuffer` happens at *encode* time, so a slot's
 * bytes stay stable only until the ring hands the slot out again. Write the
 * slots you need (size the ring for them), submit, `await
 * onSubmittedWorkDone()`, then `markSynced()`. Writing past the capacity
 * before that throws instead of overwriting params the GPU may still read.
 */

import { BUFFER_USAGE } from './gpu-constants.js';
import type { GpuResourceRegistry } from './registry.js';

const SCRATCH = new ArrayBuffer(256);
const SCRATCH_BYTES = new Uint8Array(SCRATCH);

export class ParamsRing {
  readonly buffer: GPUBuffer;
  readonly slotBytes = 256;
  readonly capacity: number;
  private cursor = 0;
  private inFlight = 0;

  constructor(
    private readonly device: GPUDevice,
    capacity = 256,
    registry?: GpuResourceRegistry,
  ) {
    this.capacity = capacity;
    const descriptor: GPUBufferDescriptor = {
      label: 'lightmapper-params-ring',
      size: capacity * this.slotBytes,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    };
    // Created through the registry when given, so a failed stage frees the
    // ring together with everything else it created.
    this.buffer = registry !== undefined ? registry.buffer(descriptor) : device.createBuffer(descriptor);
  }

  /**
   * Write one params struct (≤ 256 B) and return its **dynamic offset** for
   * `pass.setBindGroup(2, bindGroup, [offset])`. Throws when every slot has
   * been handed out since the last `markSynced()` — enlarging the ring (or
   * submitting + awaiting earlier) is the caller's job.
   */
  next(data: ArrayBufferView | ArrayBuffer): number {
    if (this.inFlight >= this.capacity) {
      throw new Error(
        `ParamsRing: ${this.capacity} slots written since the last markSynced() — ` +
          'the next write would overwrite params the GPU may still be reading. ' +
          'Size the ring for the dispatches of one submit, or submit + await in between.',
      );
    }
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > this.slotBytes) {
      throw new Error(`ParamsRing: params struct is ${bytes.byteLength} B, must fit in ${this.slotBytes} B`);
    }
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.inFlight++;
    SCRATCH_BYTES.fill(0, 0, this.slotBytes);
    SCRATCH_BYTES.set(bytes, 0);
    this.device.queue.writeBuffer(this.buffer, slot * this.slotBytes, SCRATCH, 0, this.slotBytes);
    return slot * this.slotBytes;
  }

  /**
   * Acknowledge that the GPU has consumed everything written so far — call
   * after `await device.queue.onSubmittedWorkDone()`. Makes the whole ring
   * available again.
   */
  markSynced(): void {
    this.inFlight = 0;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}
