import { describe, expect, it } from 'vitest';
import { BakeScene, DEFAULT_TEXEL_SIZE } from '../src/scene/bake-scene.js';

describe('BakeScene.addMesh validation', () => {
  it('rejects empty or non-multiple-of-3 positions', () => {
    const scene = new BakeScene();
    expect(() => scene.addMesh({ positions: new Float32Array(0) })).toThrow(TypeError);
    expect(() => scene.addMesh({ positions: new Float32Array([1, 2]) })).toThrow(TypeError);
  });

  it('rejects mismatched normals / uv2 lengths', () => {
    const scene = new BakeScene();
    expect(() =>
      scene.addMesh({ positions: new Float32Array(9), normals: new Float32Array(6) }),
    ).toThrow(TypeError);
    expect(() =>
      scene.addMesh({ positions: new Float32Array(9), uv2: new Float32Array(4) }),
    ).toThrow(TypeError);
  });

  it('rejects out-of-range indices', () => {
    const scene = new BakeScene();
    expect(() =>
      scene.addMesh({
        positions: new Float32Array(9),
        indices: new Uint32Array([0, 1, 5]),
      }),
    ).toThrow(RangeError);
  });

  it('GODOT-QUIRK (add_mesh): albedo/emission images must have equal dimensions', () => {
    const scene = new BakeScene();
    expect(() =>
      scene.addMesh({
        positions: new Float32Array(9),
        albedoOnUv2: { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) },
        emissionOnUv2: { width: 8, height: 4, data: new Uint16Array(8 * 4 * 4) },
      }),
    ).toThrow(TypeError);
  });
});

describe('BakeScene.resolveMesh', () => {
  const quadIndexed = () =>
    new BakeScene().addMesh({
      positions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 1, 0,
      ]),
      indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
      uv2: new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
      ]),
    });

  it('expands indices to triangle soup', () => {
    const mesh = quadIndexed().resolveMesh(0);
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.positions.length).toBe(18);
    expect(Array.from(mesh.positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.positions.slice(9, 18))).toEqual([0, 1, 0, 1, 0, 0, 1, 1, 0]);
  });

  it('computes flat face normals in Godot’s clockwise-front convention', () => {
    const mesh = quadIndexed().resolveMesh(0);
    // The quad is counter-clockwise seen from +z (OpenGL/WebGPU front), so
    // in Godot’s convention its FRONT face points -z: the kernels derive
    // `face_normal` from the winding (lm_raster.glsl /
    // SurfaceTool::generate_normals()), and the convenience must agree with
    // them. normal.x/y are -0 here (IEEE negation of the +0 cross terms).
    expect(mesh.normals[0]).toBeCloseTo(0, 20);
    expect(mesh.normals[1]).toBeCloseTo(0, 20);
    expect(mesh.normals[2]).toBe(-1);
    expect(mesh.normals[9]).toBeCloseTo(0, 20);
    expect(mesh.normals[10]).toBeCloseTo(0, 20);
    expect(mesh.normals[11]).toBe(-1);
  });

  it('flips flat normals when the winding is reversed (clockwise-front = +z)', () => {
    // Same quad, index order swapped per triangle → clockwise from +z.
    const scene = new BakeScene().addMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    });
    const mesh = scene.resolveMesh(0);
    expect(mesh.normals[2]).toBe(1);
    expect(mesh.normals[11]).toBe(1);
  });

  it('passes provided normals through, indexed', () => {
    const scene = new BakeScene().addMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    });
    const mesh = scene.resolveMesh(0);
    expect(mesh.normals).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  });

  it('expands uv2 alongside positions', () => {
    const mesh = quadIndexed().resolveMesh(0);
    expect(mesh.uv2!.length).toBe(12);
    expect(Array.from(mesh.uv2!.slice(6, 12))).toEqual([0, 1, 1, 0, 1, 1]);
  });

  it('applies defaults (texelSize, cullMode)', () => {
    const scene = new BakeScene().addMesh({ positions: new Float32Array(9) });
    const mesh = scene.resolveMesh(0);
    expect(mesh.texelSize).toBe(DEFAULT_TEXEL_SIZE);
    expect(mesh.cullMode).toBe('back');
  });

  it('caches resolution and is invalidated by later adds', () => {
    const scene = quadIndexed();
    expect(scene.resolveMesh(0)).toBe(scene.resolveMesh(0)); // cached
    scene.addMesh({ positions: new Float32Array(9) });
    expect(() => scene.resolveMesh(1)).not.toThrow();
  });
});

describe('BakeScene lights / environment / probes', () => {
  it('stores lights with a kind discriminant, in insertion order', () => {
    const scene = new BakeScene()
      .addDirectionalLight({ direction: [0, -1, 0] })
      .addOmniLight({ position: [1, 2, 3], range: 10 })
      .addSpotLight({ position: [0, 5, 0], direction: [0, -1, 0], range: 8 });
    expect(scene.lights.map((l) => l.kind)).toEqual(['directional', 'omni', 'spot']);
  });

  it('validates the environment rotation matrix', () => {
    const scene = new BakeScene();
    expect(() => scene.setEnvironment({ rotation: [1, 0, 0] })).toThrow(TypeError);
    expect(scene.setEnvironment({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).environment)
      .toMatchObject({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  });

  it('default probe mode is disabled -> 8 endpoint probes', () => {
    const scene = new BakeScene().addMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    });
    const probes = scene.resolveProbes();
    expect(probes.generatedProbes.length).toBe(8);
    expect(probes.positions.length).toBe(8 * 4);
  });

  it('resolveProbes is cached and invalidated by addProbe/generateProbes', () => {
    const scene = new BakeScene().addMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    });
    const first = scene.resolveProbes();
    expect(scene.resolveProbes()).toBe(first);

    scene.addProbe([0.5, 0.5, 0.5]);
    expect(scene.resolveProbes()).not.toBe(first);
    expect(scene.resolveProbes().userProbes).toEqual([[0.5, 0.5, 0.5]]);

    scene.generateProbes('subdiv_4');
    expect(scene.generateProbesMode).toBe('subdiv_4');
    expect(scene.resolveProbes().cellSize).toBeGreaterThan(0);
  });

  it('addProbe rejects non-finite positions', () => {
    const scene = new BakeScene();
    expect(() => scene.addProbe([Number.NaN, 0, 0])).toThrow(TypeError);
  });
});
