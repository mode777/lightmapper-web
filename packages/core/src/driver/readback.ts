/**
 * Texture readback — the port of Godot's `rd->texture_get_data(tex, slice)`
 * usage in the bake flow (and the `DEBUG_TEXTURES` dumps).
 *
 * Provenance (semantics): godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. Godot copies each slice out of
 * the texture array; WebGPU requires a staging buffer with `bytesPerRow`
 * aligned to 256 (docs/PORTING_PLAYBOOK.md §5.4), per-slice
 * `copyTextureToBuffer`, then `mapAsync` after submission.
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Not a line-by-line port: the mechanics are WebGPU-specific.
 */

import { BUFFER_USAGE, MAP_MODE } from './gpu-constants.js';

export interface ReadbackImage32F {
  width: number;
  height: number;
  /** rgba, 4 floats per texel. */
  data: Float32Array<ArrayBuffer>;
}

export interface ReadbackImage16F {
  width: number;
  height: number;
  /** rgba, 4 half-float *words* per texel (rgbah, as uploaded by Godot). */
  data: Uint16Array<ArrayBuffer>;
}

export interface ReadbackImage8 {
  width: number;
  height: number;
  /** rgba, 4 bytes per texel. */
  data: Uint8Array<ArrayBuffer>;
}

const BYTES_PER_PIXEL = {
  rgba32float: 16,
  rgba16float: 8,
  rgba8unorm: 4,
} as const;

export type ReadbackFormat = keyof typeof BYTES_PER_PIXEL;

/** Round up to WebGPU's 256-byte copy alignment. */
export function align256(n: number): number {
  return Math.ceil(n / 256) * 256;
}

/**
 * Copy one array layer of `texture` to a fresh staging buffer and map it.
 * Returns raw bytes with per-row padding stripped, reinterpreted per format.
 */
export async function readbackSlice(
  device: GPUDevice,
  texture: GPUTexture,
  format: ReadbackFormat,
  layer: number,
): Promise<ReadbackImage32F | ReadbackImage16F | ReadbackImage8> {
  const width = texture.width;
  const height = texture.height;
  const bpp = BYTES_PER_PIXEL[format];
  const bytesPerRow = align256(width * bpp);
  const staging = device.createBuffer({
    label: `lightmapper-readback-${format}-${layer}`,
    size: bytesPerRow * height,
    usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: { x: 0, y: 0, z: layer } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await staging.mapAsync(MAP_MODE.READ);

  const mapped = staging.getMappedRange();
  let data: Float32Array | Uint16Array | Uint8Array;
  switch (format) {
    case 'rgba32float': {
      const out = new Float32Array(width * height * 4);
      const src = new Float32Array(mapped);
      for (let y = 0; y < height; y++) {
        out.set(src.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + width * 4), y * width * 4);
      }
      data = out;
      break;
    }
    case 'rgba16float': {
      const out = new Uint16Array(width * height * 4);
      const src = new Uint16Array(mapped);
      for (let y = 0; y < height; y++) {
        out.set(src.subarray((y * bytesPerRow) / 2, (y * bytesPerRow) / 2 + width * 4), y * width * 4);
      }
      data = out;
      break;
    }
    case 'rgba8unorm': {
      const out = new Uint8Array(width * height * 4);
      const src = new Uint8Array(mapped);
      for (let y = 0; y < height; y++) {
        out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      }
      data = out;
      break;
    }
  }
  staging.unmap();
  staging.destroy();

  return { width, height, data } as ReadbackImage32F | ReadbackImage16F | ReadbackImage8;
}
