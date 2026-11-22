/**
 * Port of `LightmapperRD::_blit_meshes_into_atlas` — the bruteforce atlas
 * sizing and slot-assignment stage of Godot's lightmapper.
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.cpp @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * (packing core: godot/core/math/geometry_2d.cpp `partial_pack_rects` +
 * thirdparty/misc/stb_rect_pack.h — see atlas/stb-rect-pack.ts)
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * This port covers the *layout*: atlas size/slice search and per-mesh
 * slice+offset assignment. The albedo/emission image blitting onto the
 * slices (RGBA8/RGBAH) lives with the gbuffer/io stages (M2+); the same
 * offsets feed both.
 *
 * Behavior ported faithfully, including quirks:
 *  - padding per axis = `max(2, denoiserRange) * int(supersamplingFactor)`
 *    — GODOT-QUIRK: `Vector2i * float` in C++ truncates the float to int
 *    (Vector2i has no float multiply; the free operator delegates to
 *    `operator*(int32_t)` via implicit conversion), so 1.5x supersampling
 *    pads exactly like 1x;
 *  - `atlas_size_limit = int(maxTextureSize * supersamplingFactor)` — the
 *    same float->int truncation applies;
 *  - packed rects are stored at `offset + (1,1)` — "Center lightmap in the
 *    reserved oversized region";
 *  - memory ties (`w * h * slices`) keep the FIRST (smallest-square) atlas:
 *    the comparison is strictly `<`;
 *  - the `source_sizes[i] > atlas_size` guard uses Vector2i's LEXICOGRAPHIC
 *    `operator>` (x first, then y) — it cannot actually fire because the
 *    minimum atlas size is the pow2 ceiling of the largest padded rect.
 */

import { partialPackRects } from './stb-rect-pack.js';
import { nearestPowerOf2 } from '../math/bits.js';

/** Slot assigned to one mesh: atlas slice + texel offset (with the +1 centering applied). */
export interface AtlasSlot {
  slice: number;
  offset: [number, number];
}

/** Padding added to each mesh's lightmap size on each axis. */
export function atlasPadding(denoiserRange: number, supersamplingFactor: number): number {
  // Size2i(2, 2).maxi(denoiserRange) * supersamplingFactor — see header
  // quirk note: the float factor truncates to int exactly like the C++.
  return Math.max(2, denoiserRange) * Math.trunc(supersamplingFactor);
}

export type AtlasLayoutError =
  | 'textureExceedsDeviceLimit'
  | 'textureExceedsMaxSize'
  | 'atlasTooSmall';

export type AtlasLayoutResult =
  | {
      ok: true;
      atlasSize: [number, number];
      atlasSlices: number;
      /** One per input mesh, in input order. */
      slots: AtlasSlot[];
      /** Padded sizes actually reserved per mesh (size + padding). */
      paddedSizes: Array<[number, number]>;
    }
  | {
      ok: false;
      error: AtlasLayoutError;
    };

/**
 * Determine the atlas layout for the given per-mesh lightmap image sizes
 * (Godot takes them from `albedo_on_uv2`; any of the pair has the same
 * dims — enforced by add_mesh).
 */
export function blitMeshesIntoAtlas(
  meshImageSizes: ReadonlyArray<{ width: number; height: number }>,
  options: {
    maxTextureSize: number;
    deviceMaxTextureSize: number;
    denoiserRange: number;
    supersamplingFactor: number;
  },
): AtlasLayoutResult {
  const sizes: Array<[number, number]> = meshImageSizes.map((s) => [s.width, s.height]);
  let largestMeshLightmapSize: [number, number] = [0, 0];

  const padding = atlasPadding(options.denoiserRange, options.supersamplingFactor);

  for (const s of sizes) {
    const padded: [number, number] = [s[0] + padding, s[1] + padding];
    largestMeshLightmapSize = [
      Math.max(largestMeshLightmapSize[0], padded[0]),
      Math.max(largestMeshLightmapSize[1], padded[1]),
    ];
  }

  const minAtlasSize = Math.max(
    nearestPowerOf2(largestMeshLightmapSize[0]),
    nearestPowerOf2(largestMeshLightmapSize[1]),
  );

  const atlasSizeLimit = Math.min(
    Math.trunc(options.maxTextureSize * options.supersamplingFactor),
    options.deviceMaxTextureSize,
  );
  if (minAtlasSize > atlasSizeLimit) {
    return {
      ok: false,
      error:
        minAtlasSize > options.deviceMaxTextureSize
          ? 'textureExceedsDeviceLimit'
          : 'textureExceedsMaxSize',
    };
  }

  let atlasWidth = minAtlasSize;
  let atlasHeight = minAtlasSize;

  let bestAtlasSize: [number, number] = [0, 0];
  let bestAtlasSlices = 0;
  let bestAtlasMemory = 0x7fffffff;
  let bestAtlasOffsets: Array<[number, number, number]> | null = null;

  // Determine best texture array atlas size by bruteforce fitting.
  while (atlasWidth <= atlasSizeLimit && atlasHeight <= atlasSizeLimit) {
    // Add padding between lightmaps.
    // Scale the padding if the lightmap will be downsampled at the end of
    // the baking process — otherwise the padding would be insufficient.
    const sourceSizes: Array<[number, number]> = sizes.map((s) => [s[0] + padding, s[1] + padding]);
    const sourceIndices: number[] = sizes.map((_, i) => i);
    const atlasOffsets: Array<[number, number, number] | undefined> = new Array(sourceSizes.length);

    // Ensure the sizes can all fit into a single atlas layer. This should
    // always happen; the check only prevents an infinite loop (and is
    // lexicographic — see header quirk note).
    for (const source of sourceSizes) {
      if (source[0] > atlasWidth || (source[0] === atlasWidth && source[1] > atlasHeight)) {
        return { ok: false, error: 'atlasTooSmall' };
      }
    }

    let slices = 0;

    while (sourceSizes.length > 0) {
      const offsets = partialPackRects(sourceSizes, atlasWidth, atlasHeight);
      const newIndices: number[] = [];
      const newSources: Array<[number, number]> = [];
      for (let i = 0; i < offsets.length; i++) {
        const ofs = offsets[i];
        const sidx = sourceIndices[i];
        if (ofs[2] > 0) {
          //valid
          // Center lightmap in the reserved oversized region
          atlasOffsets[sidx] = [ofs[0] + 1, ofs[1] + 1, slices];
        } else {
          newIndices.push(sidx);
          newSources.push(sourceSizes[i]);
        }
      }

      sourceSizes.splice(0, sourceSizes.length, ...newSources);
      sourceIndices.splice(0, sourceIndices.length, ...newIndices);
      slices++;
    }

    const memUsed = atlasWidth * atlasHeight * slices;
    if (memUsed < bestAtlasMemory) {
      bestAtlasSize = [atlasWidth, atlasHeight];
      bestAtlasOffsets = atlasOffsets as Array<[number, number, number]>;
      bestAtlasSlices = slices;
      bestAtlasMemory = memUsed;
    }

    if (atlasWidth === atlasHeight) {
      atlasWidth *= 2;
    } else {
      atlasHeight *= 2;
    }
  }

  return {
    ok: true,
    atlasSize: bestAtlasSize,
    atlasSlices: bestAtlasSlices,
    slots: (bestAtlasOffsets ?? []).map((o) => ({ slice: o[2], offset: [o[0], o[1]] })),
    paddedSizes: sizes.map((s) => [s[0] + padding, s[1] + padding]),
  };
}
