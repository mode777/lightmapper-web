/**
 * @lightmapper/gbuffer — the minimal `bake_render_uv2` replacement.
 *
 * Provenance (semantics): godot/scene/3d/lightmap_gi.cpp
 * (`RS::bake_render_uv2` consumption + the albedo × (1−metallic) multiply)
 * and the BAKE_CHANNEL_ALBEDO_ALPHA / BAKE_CHANNEL_EMISSION outputs @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0.
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * PORT: Godot rasterizes the mesh's *primary* UVs onto its UV2 layout on
 * the GPU with the scene's material shaders. This minimal M2 replacement
 * CPU-rasterizes the material description directly into UV2 space:
 *   albedo   = baseColor × baseColorTexture(uv2) × (1 − metallic), alpha = opacity
 *   emission = emission × emissionEnergy (rgbah)
 * Godot's albedo_on_uv2 alpha carries opacity; emission is RGBAH linear.
 * Coverage rule: a texel is written when its center falls inside a
 * triangle (GPU pixel-center rasterization); later triangles win overlaps.
 */

import { f32ToF16 } from '@lightmapper/core';
import type { AlbedoOnUv2Image, EmissionOnUv2Image, GltfLikeMaterial } from '@lightmapper/core';

/** Triangle-soup mesh in UV2 chart space (0–1). */
export interface Uv2Mesh {
  /** xyz per corner (length = triangleCount * 9). */
  positions: Float32Array;
  /** xy per corner in 0–1 chart space (length = triangleCount * 6). */
  uv2: Float32Array;
  triangleCount: number;
}

/** Default material (Godot surfaces without a material bake as white). */
const DEFAULT_MATERIAL: Readonly<Required<Omit<GltfLikeMaterial, 'baseColorTexture'>>> = {
  baseColor: [1, 1, 1],
  metallic: 0,
  roughness: 1,
  opacity: 1,
  emission: [0, 0, 0],
  emissionEnergy: 1,
};

export interface MaterialImages {
  albedo: AlbedoOnUv2Image;
  emission: EmissionOnUv2Image;
}

/** Linear color quantized to rgba8 (Godot writes RGBA8 albedo). */
function toRgba8(r: number, g: number, b: number, a: number): [number, number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(r * 255))),
    Math.max(0, Math.min(255, Math.round(g * 255))),
    Math.max(0, Math.min(255, Math.round(b * 255))),
    Math.max(0, Math.min(255, Math.round(a * 255))),
  ];
}

/**
 * Render one mesh's albedo/emission-on-UV2 images at the given lightmap
 * size (the `bake_render_uv2` replacement — see header).
 */
export function renderMaterialOnUv2(
  mesh: Uv2Mesh,
  material: GltfLikeMaterial | undefined,
  size: { width: number; height: number },
): MaterialImages {
  const m = { ...DEFAULT_MATERIAL, ...material };
  const { width, height } = size;
  const albedo = new Uint8Array(width * height * 4);
  const emission = new Uint16Array(width * height * 4);

  const diffuse: [number, number, number] = [
    m.baseColor[0] * (1 - m.metallic),
    m.baseColor[1] * (1 - m.metallic),
    m.baseColor[2] * (1 - m.metallic),
  ];
  const emissive: [number, number, number] = [
    m.emission[0] * m.emissionEnergy,
    m.emission[1] * m.emissionEnergy,
    m.emission[2] * m.emissionEnergy,
  ];
  const tex = m.baseColorTexture;
  const texData = tex?.data;
  const texW = tex?.width ?? 1;
  const texH = tex?.height ?? 1;

  for (let t = 0; t < mesh.triangleCount; t++) {
    const u0 = mesh.uv2[t * 6 + 0];
    const v0 = mesh.uv2[t * 6 + 1];
    const u1 = mesh.uv2[t * 6 + 2];
    const v1 = mesh.uv2[t * 6 + 3];
    const u2 = mesh.uv2[t * 6 + 4];
    const v2 = mesh.uv2[t * 6 + 5];

    // Triangle bbox in texel space (UV maps linearly onto the image).
    const minX = Math.max(0, Math.floor(Math.min(u0, Math.min(u1, u2)) * width));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(u0, Math.max(u1, u2)) * width));
    const minY = Math.max(0, Math.floor(Math.min(v0, Math.min(v1, v2)) * height));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(v0, Math.max(v1, v2)) * height));

    const e01 = u1 - u0;
    const e12 = u2 - u1;
    const e20 = u0 - u2;
    const f01 = v1 - v0;
    const f12 = v2 - v1;
    const f20 = v0 - v2;
    const area = e01 * f12 - e12 * f01; // 2×signed area (winding-dependent)

    for (let y = minY; y <= maxY; y++) {
      // Texel-center sampling: Godot rasterizes with pixel centers at
      // (n + 0.5); UV space maps [0,1] onto [0,width], so center = (n+0.5)/w.
      const py = (y + 0.5) / height;
      for (let x = minX; x <= maxX; x++) {
        const px = (x + 0.5) / width;
        // Barycentric coverage via edge functions.
        const w0 = e12 * (py - v1) - f12 * (px - u1);
        const w1 = e20 * (py - v2) - f20 * (px - u2);
        const w2 = e01 * (py - v0) - f01 * (px - u0);
        const inside =
          area > 0
            ? w0 >= 0 && w1 >= 0 && w2 >= 0
            : w0 <= 0 && w1 <= 0 && w2 <= 0;
        if (!inside) {
          continue;
        }
        const idx = (y * width + x) * 4;
        if (texData === undefined) {
          const rgba = toRgba8(diffuse[0], diffuse[1], diffuse[2], m.opacity);
          albedo[idx] = rgba[0];
          albedo[idx + 1] = rgba[1];
          albedo[idx + 2] = rgba[2];
          albedo[idx + 3] = rgba[3];
        } else {
          // Barycentric interpolation of the chart UV (== the texture's own
          // UV here — the texture is authored in the same UV2 space).
          const b0 = area !== 0 ? w0 / area : 0;
          const b1 = area !== 0 ? w1 / area : 0;
          const b2 = area !== 0 ? w2 / area : 0;
          const tu = Math.min(0.999999, Math.max(0, b0 * u0 + b1 * u1 + b2 * u2));
          const tv = Math.min(0.999999, Math.max(0, b0 * v0 + b1 * v1 + b2 * v2));
          const tx = Math.min(texW - 1, Math.floor(tu * texW));
          const ty = Math.min(texH - 1, Math.floor(tv * texH));
          const tidx = (ty * texW + tx) * 4;
          const rgba = toRgba8(
            (texData[tidx] / 255) * diffuse[0],
            (texData[tidx + 1] / 255) * diffuse[1],
            (texData[tidx + 2] / 255) * diffuse[2],
            (texData[tidx + 3] / 255) * m.opacity,
          );
          albedo[idx] = rgba[0];
          albedo[idx + 1] = rgba[1];
          albedo[idx + 2] = rgba[2];
          albedo[idx + 3] = rgba[3];
        }
        emission[idx] = f32ToF16(emissive[0]);
        emission[idx + 1] = f32ToF16(emissive[1]);
        emission[idx + 2] = f32ToF16(emissive[2]);
        emission[idx + 3] = 0;
      }
    }
  }

  return {
    albedo: { width, height, data: albedo },
    emission: { width, height, data: emission },
  };
}
