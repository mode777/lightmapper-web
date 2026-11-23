/**
 * GPU resource registry — tracks every texture/buffer created for a bake so
 * they can be destroyed deterministically ("targets are destroyed as soon as
 * their last consumer completes" — ARCHITECTURE §5, an improvement over
 * Godot which frees everything at the end of bake()).
 *
 * Not a port: resource lifetime is WebGPU-specific bookkeeping.
 */

export class GpuResourceRegistry {
  private readonly textures: GPUTexture[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private destroyed = false;

  /** Create a tracked texture (throws after destroy()). */
  texture(descriptor: GPUTextureDescriptor): GPUTexture {
    this.assertLive();
    const texture = this.device.createTexture(descriptor);
    this.textures.push(texture);
    return texture;
  }

  /** Create a tracked buffer. */
  buffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    this.assertLive();
    const buffer = this.device.createBuffer(descriptor);
    this.buffers.push(buffer);
    return buffer;
  }

  /** Create a tracked storage/uniform buffer and upload bytes to it. */
  bufferWithData(descriptor: GPUBufferDescriptor, data: GPUAllowSharedBufferSource): GPUBuffer {
    const buffer = this.buffer(descriptor);
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  /** Destroy a tracked texture immediately (idempotent). */
  destroyTexture(texture: GPUTexture): void {
    const i = this.textures.indexOf(texture);
    if (i >= 0) {
      this.textures.splice(i, 1);
      texture.destroy();
    }
  }

  /** Destroy a tracked buffer immediately (idempotent). */
  destroyBuffer(buffer: GPUBuffer): void {
    const i = this.buffers.indexOf(buffer);
    if (i >= 0) {
      this.buffers.splice(i, 1);
      buffer.destroy();
    }
  }

  /** Destroy everything still tracked. */
  destroyAll(): void {
    for (const texture of this.textures) texture.destroy();
    for (const buffer of this.buffers) buffer.destroy();
    this.textures.length = 0;
    this.buffers.length = 0;
    this.destroyed = true;
  }

  /** Number of live tracked resources (testing/telemetry). */
  get size(): number {
    return this.textures.length + this.buffers.length;
  }

  constructor(public readonly device: GPUDevice) {}

  private assertLive(): void {
    if (this.destroyed) {
      throw new Error('GpuResourceRegistry: used after destroyAll()');
    }
  }
}
