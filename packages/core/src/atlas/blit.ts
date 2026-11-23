/**
 * Port of the blit tail of `LightmapperRD::_blit_meshes_into_atlas` —
 * assembling the per-mesh albedo/emission lightmap images into the
 * atlas-sized RGBA8 / RGBAH slice images that get uploaded as texture-array
 * layers.
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0 (the `albedo_images` /
 * `emission_images` creation + `blit_rect` loop; the sizing/packing half of
 * the function lives in atlas/pack.ts).
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Faithfulness notes:
 *  - slices are created black (`set_as_black`) — emission black = f16 zeros,
 *    albedo black = {0,0,0,0};
 *  - each mesh image is copied 1:1 at its packed offset (`mi.offset`,
 *    which already includes the +1 centering quirk from pack.ts);
 *  - `Image::blit_rect` copies the full source rect — sources smaller than
 *    their reserved (padded) region leave the padding black, exactly like
 *    upstream.
 */

import type { AlbedoOnUv2Image, EmissionOnUv2Image } from '../scene/types.js';
import type { AtlasSlot } from './pack.js';

/** Per-mesh lightmap images (either user-supplied or gbuffer-rendered). */
export interface MeshAtlasImages {
  albedo: AlbedoOnUv2Image;
  emission: EmissionOnUv2Image;
}

/** Atlas-ready slice images (one per texture-array layer). */
export interface AtlasSlices {
  /** rgba8, width*height*4 per slice. */
  albedo: Uint8Array<ArrayBuffer>[];
  /** rgbah (f16 words), width*height*4 per slice. */
  emission: Uint16Array<ArrayBuffer>[];
}

/**
 * Blit the per-mesh images into the atlas slices (`_blit_meshes_into_atlas`
 * tail). `slots` come from `blitMeshesIntoAtlas` in input order.
 */
export function blitAtlasSlices(
  images: readonly MeshAtlasImages[],
  slots: readonly AtlasSlot[],
  atlasSize: readonly [number, number] | readonly number[],
  atlasSlices: number,
): AtlasSlices {
  if (images.length !== slots.length) {
    throw new Error(`blitAtlasSlices: ${images.length} images vs ${slots.length} slots`);
  }
  const width = atlasSize[0];
  const height = atlasSize[1];
  const albedo: Uint8Array<ArrayBuffer>[] = [];
  const emission: Uint16Array<ArrayBuffer>[] = [];
  for (let i = 0; i < atlasSlices; i++) {
    albedo.push(new Uint8Array(width * height * 4)); // set_as_black
    emission.push(new Uint16Array(width * height * 4)); // set_as_black (f16 zeros)
  }

  for (let m = 0; m < images.length; m++) {
    const slot = slots[m];
    const src = images[m];
    if (src.albedo.width !== src.emission.width || src.albedo.height !== src.emission.height) {
      throw new Error(`blitAtlasSlices: mesh ${m} albedo/emission dimension mismatch`);
    }
    const dst = albedo[slot.slice];
    const dstE = emission[slot.slice];
    const ox = slot.offset[0];
    const oy = slot.offset[1];
    const w = src.albedo.width;
    const h = src.albedo.height;
    if (ox + w > width || oy + h > height) {
      throw new Error(`blitAtlasSlices: mesh ${m} lightmap ${w}×${h} at ${ox},${oy} exceeds atlas ${width}×${height}`);
    }
    for (let y = 0; y < h; y++) {
      const srcRow = y * w * 4;
      const dstRow = ((oy + y) * width + ox) * 4;
      dst.set(src.albedo.data.subarray(srcRow, srcRow + w * 4), dstRow);
      dstE.set(src.emission.data.subarray(srcRow, srcRow + w * 4), dstRow);
    }
  }

  return { albedo, emission };
}
