/**
 * Preview helpers — visualize G-buffer readbacks as rgba8 images / PNG data
 * URLs for the demo and for eyeballing against native `DEBUG_TEXTURES`
 * dumps (PORTING_PLAYBOOK §7).
 *
 * Not a port: presentation-only.
 */

import { f16ToF32 } from '../math/float16.js';
import type { Aabb } from '../math/aabb.js';
import type { ReadbackImage16F, ReadbackImage32F, ReadbackImage8 } from './readback.js';

export type Rgba8Image = ReadbackImage8;

/** Encode an rgba8 image as a PNG data URL (browser only). */
export function rgba8ToPngDataUrl(image: Rgba8Image): string {
  if (typeof document === 'undefined') {
    throw new Error('rgba8ToPngDataUrl requires a browser DOM (canvas)');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('rgba8ToPngDataUrl: 2D canvas context unavailable');
  }
  const imageData = ctx.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Position atlas → normalized-by-bounds rgb (alpha = coverage). */
export function positionToPreview(image: ReadbackImage32F, bounds: Aabb): Rgba8Image {
  const out = new Uint8Array(image.width * image.height * 4);
  const sx = 255 / Math.max(bounds.size[0], 1e-12);
  const sy = 255 / Math.max(bounds.size[1], 1e-12);
  const sz = 255 / Math.max(bounds.size[2], 1e-12);
  for (let i = 0; i < image.width * image.height; i++) {
    const a = image.data[i * 4 + 3];
    out[i * 4 + 0] = a < 0.5 ? 0 : Math.max(0, Math.min(255, (image.data[i * 4 + 0] - bounds.position[0]) * sx));
    out[i * 4 + 1] = a < 0.5 ? 0 : Math.max(0, Math.min(255, (image.data[i * 4 + 1] - bounds.position[1]) * sy));
    out[i * 4 + 2] = a < 0.5 ? 0 : Math.max(0, Math.min(255, (image.data[i * 4 + 2] - bounds.position[2]) * sz));
    out[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Normal atlas (rgbah words) → 0.5·n+0.5 octahedral-ish rgb view. */
export function normalToPreview(image: ReadbackImage16F): Rgba8Image {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const nx = f16ToF32(image.data[i * 4 + 0]);
    const ny = f16ToF32(image.data[i * 4 + 1]);
    const nz = f16ToF32(image.data[i * 4 + 2]);
    out[i * 4 + 0] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
    out[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Unocclude mask (r = 0/1 after the kernel) → red-tinted view. */
export function unoccludeToPreview(image: ReadbackImage32F): Rgba8Image {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    out[i * 4 + 0] = image.data[i * 4 + 0] > 0.5 ? 255 : 32;
    out[i * 4 + 1] = image.data[i * 4 + 0] > 0.5 ? 64 : 32;
    out[i * 4 + 2] = image.data[i * 4 + 0] > 0.5 ? 64 : 32;
    out[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Draw an rgba8 image into a canvas 2D context, scaled to the canvas size. */
export function drawRgba8ToCanvas(ctx: CanvasRenderingContext2D, image: Rgba8Image): void {
  const canvas = ctx.canvas;
  const offscreen = new Uint8ClampedArray(image.data);
  const imageData = new ImageData(offscreen, image.width, image.height);
  if (typeof createImageBitmap === 'function') {
    // Scale smoothly through an ImageBitmap.
    void createImageBitmap(imageData).then((bitmap) => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    });
  } else {
    const tmp = document.createElement('canvas');
    tmp.width = image.width;
    tmp.height = image.height;
    tmp.getContext('2d')?.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }
}
