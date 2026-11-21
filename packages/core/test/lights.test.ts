import { describe, expect, it } from 'vitest';
import {
  assembleLights,
  packDirectionalLight,
  packLightsBuffer,
  packOmniLight,
  packSpotLight,
} from '../src/scene/lights.js';
import {
  LIGHT_TYPE_DIRECTIONAL,
  LIGHT_TYPE_OMNI,
  LIGHT_TYPE_SPOT,
  STRUCT_SIZES,
} from '../src/layout/structs.js';
import type { SceneLight } from '../src/scene/types.js';

/**
 * Ports of LightmapperRD::add_{directional,omni,spot}_light @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. The derived-field formulas
 * (tan/cos/1-over) and the zero-init of untouched fields are the load-
 * bearing parts.
 */
describe('light field packing', () => {
  it('directional: size = tan(deg_to_rad(angular_distance))', () => {
    const l = packDirectionalLight({
      direction: [0, -1, 0],
      angularSizeDeg: 30,
    });
    expect(l.type).toBe(LIGHT_TYPE_DIRECTIONAL);
    expect(l.size).toBe(Math.fround(Math.tan((Math.PI * 30) / 180.0)));
    expect(l.size).toBeCloseTo(0.5773502691896257, 7);
    // Defaults mirror Light3D.
    expect(l.color).toEqual([1, 1, 1]);
    expect(l.energy).toBe(1);
    expect(l.indirectEnergy).toBe(1);
    expect(l.shadowBlur).toBeCloseTo(0.1, 7);
    expect(l.staticBake).toBe(1);
    // Zero-init like C++ `Light l;`
    expect(l.range).toBe(0);
    expect(l.attenuation).toBe(0);
    expect(l.cosSpotAngle).toBe(0);
    expect(l.invSpotAttenuation).toBe(0);
    expect(l.areaWidth).toEqual([0, 0, 0, 0]);
  });

  it('omni: fields copied, no derived math', () => {
    const l = packOmniLight({
      position: [1, 2, 3],
      range: 10,
      attenuation: 2,
      size: 0.5,
      shadowBlur: 0.3,
      color: [1, 0.5, 0.25],
      energy: 4,
      indirectEnergy: 5,
      static: false,
    });
    expect(l.type).toBe(LIGHT_TYPE_OMNI);
    expect(l.position).toEqual([1, 2, 3]);
    expect(l.range).toBe(10);
    expect(l.attenuation).toBe(2);
    expect(l.size).toBe(0.5);
    expect(l.shadowBlur).toBe(0.3);
    expect(l.color).toEqual([1, 0.5, 0.25]);
    expect(l.energy).toBe(4);
    expect(l.indirectEnergy).toBe(5);
    expect(l.staticBake).toBe(0);
    expect(l.direction).toEqual([0, 0, 0]);
  });

  it('spot: cos_spot_angle = cos(rad), inv_spot_attenuation = 1/x', () => {
    const l = packSpotLight({
      position: [0, 5, 0],
      direction: [0, -1, 0],
      range: 8,
      angleDeg: 60,
      spotAttenuation: 2,
    });
    expect(l.type).toBe(LIGHT_TYPE_SPOT);
    expect(l.cosSpotAngle).toBe(Math.fround(Math.cos((Math.PI * 60) / 180.0)));
    expect(l.cosSpotAngle).toBeCloseTo(0.5, 7);
    expect(l.invSpotAttenuation).toBe(0.5);
    expect(l.direction).toEqual([0, -1, 0]);
    expect(l.range).toBe(8);
    expect(l.staticBake).toBe(1);
  });
});

describe('assembleLights', () => {
  it('sorts by type: directional < omni < spot', () => {
    const lights: SceneLight[] = [
      { kind: 'spot', position: [0, 0, 0], direction: [0, -1, 0], range: 5 },
      { kind: 'directional', direction: [0, -1, 0], energy: 11 },
      { kind: 'omni', position: [0, 0, 0], range: 5 },
      { kind: 'directional', direction: [1, 0, 0], energy: 22 },
    ];
    const gpu = assembleLights(lights);
    expect(gpu.map((l) => l.type)).toEqual([
      LIGHT_TYPE_DIRECTIONAL,
      LIGHT_TYPE_DIRECTIONAL,
      LIGHT_TYPE_OMNI,
      LIGHT_TYPE_SPOT,
    ]);
    // PORT: stable sort keeps insertion order among equal types.
    expect(gpu[0].energy).toBe(11);
    expect(gpu[1].energy).toBe(22);
  });
});

describe('packLightsBuffer', () => {
  it('packs 128 bytes per light at the documented offsets', () => {
    const l = packDirectionalLight({
      direction: [1, 2, 3],
      color: [0.5, 0.25, 1],
      energy: 2,
      indirectEnergy: 3,
      angularSizeDeg: 30,
      shadowBlur: 0.2,
      static: false,
    });
    const buf = packLightsBuffer([l]);
    expect(buf.byteLength).toBe(STRUCT_SIZES.light);

    const view = new DataView(buf);
    expect(view.getUint32(12, true)).toBe(LIGHT_TYPE_DIRECTIONAL); // type
    expect(view.getFloat32(16, true)).toBe(1); // direction.x
    expect(view.getFloat32(24, true)).toBe(3); // direction.z
    expect(view.getFloat32(28, true)).toBe(2); // energy
    expect(view.getFloat32(32, true)).toBe(0.5); // color.r
    expect(view.getFloat32(40, true)).toBe(1); // color.b
    expect(view.getFloat32(44, true)).toBe(Math.fround(Math.tan((Math.PI * 30) / 180.0))); // size
    expect(view.getFloat32(64, true)).toBe(3); // indirect_energy
    expect(view.getFloat32(68, true)).toBeCloseTo(0.2, 7); // shadow_blur
    expect(view.getUint32(72, true)).toBe(0); // static_bake (false)
    expect(view.getUint32(76, true)).toBe(0); // pad
  });

  it('GODOT-QUIRK: empty light list still produces one zeroed Light (128 bytes)', () => {
    const buf = packLightsBuffer([]);
    expect(buf.byteLength).toBe(STRUCT_SIZES.light);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array(STRUCT_SIZES.light));
  });
});
