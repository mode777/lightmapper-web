/**
 * The `Params` ring buffer — WebGPU's push-constant replacement (ADR-0003).
 *
 * Provenance (semantics): Godot sets a 32–64 B push constant per compute
 * dispatch / render draw (`compute_list_set_push_constant`,
 * `draw_list_set_push_constant`). WebGPU has no push constants, so group 2
 * binding 0 holds the struct in a uniform buffer bound with **dynamic
 * offsets**; this class hands out 256 B-aligned slots for each write.
 *
 * Slot size 256 B satisfies `minUniformBufferOffsetAlignment` on every
 * WebGPU implementation (spec floor is 256).
 *
 * Usage contract: write a slot, record the commands that use it, submit,
 * then continue. Godot writes one push constant per dispatch inside the
 * command list; `queue.writeBuffer` happens at *encode* time here, so a
 * slot's bytes are stable for everything recorded before the next wrap of
 * the ring. Drivers must `await onSubmittedWorkDone()` before wrapping
 * (ARCHITECTURE §5 region chunking does exactly that).
 */

import { BUFFER_USAGE } from './gpu-constants.js';

const SCRATCH = new ArrayBuffer(256);
const SCRATCH_BYTES = new Uint8Array(SCRATCH);

export class ParamsRing {
  readonly buffer: GPUBuffer;
  readonly slotBytes = 256;
  readonly capacity: number;
  private cursor = 0;

  constructor(
    private readonly device: GPUDevice,
    capacity = 256,
  ) {
    this.capacity = capacity;
    this.buffer = device.createBuffer({
      label: 'lightmapper-params-ring',
      size: capacity * this.slotBytes,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
  }

  /**
   * Write one params struct (≤ 256 B) and return its **dynamic offset** for
   * `pass.setBindGroup(2, bindGroup, [offset])`.
   */
  next(data: ArrayBufferView | ArrayBuffer): number {
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > this.slotBytes) {
      throw new Error(`ParamsRing: params struct is ${bytes.byteLength} B, must fit in ${this.slotBytes} B`);
    }
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    SCRATCH_BYTES.fill(0, 0, this.slotBytes);
    SCRATCH_BYTES.set(bytes, 0);
    this.device.queue.writeBuffer(this.buffer, slot * this.slotBytes, SCRATCH, 0, this.slotBytes);
    return slot * this.slotBytes;
  }

  /** True when the ring will wrap on the next write (drivers await+sync then). */
  get willWrap(): boolean {
    return this.cursor === 0;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}
