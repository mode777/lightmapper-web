/**
 * Port of the light-assembly path of Godot's RD lightmapper.
 *
 * Provenance: godot/modules/lightmapper_rd/lightmapper_rd.cpp —
 * `LightmapperRD::add_directional_light`, `add_omni_light`, `add_spot_light`
 * and the `lights.sort()` in `_create_acceleration_structures` @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * Field packing is faithful, including the derived fields:
 *   directional: `size = tan(deg_to_rad(angular_distance))`
 *   spot: `cos_spot_angle = cos(deg_to_rad(spot_angle))`,
 *         `inv_spot_attenuation = 1 / spot_attenuation`
 * and the zero-init of everything else (`Light l;` in C++ zero-initializes).
 *
 * Area-light fields (`area_width`/`area_height`/`area_texture_rect`) stay
 * zero: area lights are post-M6 (see ROADMAP.md).
 */

import {
  LIGHT_TYPE_DIRECTIONAL,
  LIGHT_TYPE_OMNI,
  LIGHT_TYPE_SPOT,
  STRUCT_SIZES,
  pack,
  writeLight,
  type GpuLight,
} from '../layout/structs.js';
import type { ColorRgb, DirectionalLightInput, OmniLightInput, SceneLight, SpotLightInput } from './types.js';

/** Godot `Math::deg_to_rad` (computed in double precision like the C++ template, narrowed on store). */
function degToRad(deg: number): number {
  return (Math.PI * deg) / 180.0;
}

/** Port of `add_directional_light` field packing. */
export function packDirectionalLight(input: DirectionalLightInput): GpuLight {
  const l: GpuLight = zeroLight();
  l.type = LIGHT_TYPE_DIRECTIONAL;
  l.direction = [...input.direction];
  const color: ColorRgb = input.color ?? [1, 1, 1];
  l.color = [...color];
  l.energy = input.energy ?? 1;
  l.indirectEnergy = input.indirectEnergy ?? 1;
  l.staticBake = (input.static ?? true) ? 1 : 0;
  l.size = Math.fround(Math.tan(degToRad(input.angularSizeDeg ?? 0)));
  l.shadowBlur = input.shadowBlur ?? 0.1;
  return l;
}

/** Port of `add_omni_light` field packing. */
export function packOmniLight(input: OmniLightInput): GpuLight {
  const l: GpuLight = zeroLight();
  l.type = LIGHT_TYPE_OMNI;
  l.position = [...input.position];
  l.range = input.range;
  l.attenuation = input.attenuation ?? 1;
  const color: ColorRgb = input.color ?? [1, 1, 1];
  l.color = [...color];
  l.energy = input.energy ?? 1;
  l.indirectEnergy = input.indirectEnergy ?? 1;
  l.staticBake = (input.static ?? true) ? 1 : 0;
  l.size = input.size ?? 0;
  l.shadowBlur = input.shadowBlur ?? 0.1;
  return l;
}

/** Port of `add_spot_light` field packing. */
export function packSpotLight(input: SpotLightInput): GpuLight {
  const l: GpuLight = zeroLight();
  l.type = LIGHT_TYPE_SPOT;
  l.position = [...input.position];
  l.direction = [...input.direction];
  l.range = input.range;
  l.attenuation = input.attenuation ?? 1;
  l.cosSpotAngle = Math.fround(Math.cos(degToRad(input.angleDeg ?? 45)));
  l.invSpotAttenuation = Math.fround(1 / (input.spotAttenuation ?? 1));
  const color: ColorRgb = input.color ?? [1, 1, 1];
  l.color = [...color];
  l.energy = input.energy ?? 1;
  l.indirectEnergy = input.indirectEnergy ?? 1;
  l.staticBake = (input.static ?? true) ? 1 : 0;
  l.size = input.size ?? 0;
  l.shadowBlur = input.shadowBlur ?? 0.1;
  return l;
}

/** C++ `Light l;` — zero-initialized struct (all fields zero / empty tuples). */
function zeroLight(): GpuLight {
  return {
    position: [0, 0, 0],
    type: 0,
    direction: [0, 0, 0],
    energy: 0,
    color: [0, 0, 0],
    size: 0,
    range: 0,
    attenuation: 0,
    cosSpotAngle: 0,
    invSpotAttenuation: 0,
    indirectEnergy: 0,
    shadowBlur: 0,
    staticBake: 0,
    pad: 0,
    areaWidth: [0, 0, 0, 0],
    areaHeight: [0, 0, 0, 0],
    areaTextureRect: [0, 0, 0, 0],
  };
}

/** Pack one stored scene light to its GPU representation. */
export function toGpuLight(light: SceneLight): GpuLight {
  switch (light.kind) {
    case 'directional':
      return packDirectionalLight(light);
    case 'omni':
      return packOmniLight(light);
    case 'spot':
      return packSpotLight(light);
  }
}

/**
 * Assemble the GPU light list: pack every light, then sort by type
 * (`lights.sort()` in `_create_acceleration_structures`, ordered by
 * `Light::operator<` = directional < omni < spot < area).
 *
 * PORT: Godot's `SortArray` is an unstable introsort, so the relative order
 * of same-type lights is unspecified upstream. We use a stable sort, which
 * preserves insertion order for equal types — a deterministic choice that
 * only affects GPU accumulation order, never the light set.
 */
export function assembleLights(lights: readonly SceneLight[]): GpuLight[] {
  return lights
    .map((light) => toGpuLight(light))
    .sort((a, b) => a.type - b.type); // JS sort is stable (ES2019+)
}

/**
 * Pack the assembled light list into the `lights` storage buffer
 * (128 bytes per light, docs/DESIGN.md §4.3).
 *
 * GODOT-QUIRK: "Even when there are no lights, the buffer must exist" —
 * Godot creates a buffer holding one zeroed `Light` (its
 * `static const Light empty_lights[1]`). We mirror that so bind groups and
 * golden dumps stay byte-identical.
 */
export function packLightsBuffer(lights: readonly GpuLight[]): ArrayBuffer {
  if (lights.length === 0) {
    return new ArrayBuffer(STRUCT_SIZES.light);
  }
  return pack(STRUCT_SIZES.light, lights.length, lights as GpuLight[], writeLight);
}
