import { describe, expect, it } from 'vitest';
import {
  computeProbeBounds,
  generateProbesFromBounds,
  packProbesBuffer,
} from '../src/scene/probes.js';

/**
 * Ports of LightmapGI::_plot_triangle_into_octree /
 * _gen_new_positions_from_octree and the "STEP 2, CREATE PROBES" block @
 * 67421f36e5069e62573c44beb8dd2f8f91e065b0. Expected values were
 * hand-derived by stepping through the C++ (see each case).
 */

describe('computeProbeBounds', () => {
  it('unions mesh points and user probes, then grows by size.length() * 0.001', () => {
    const quad = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      2, 2, 0,
    ]);
    const bounds = computeProbeBounds([quad], []);
    // length (2,2,0) = sqrt(8) = 2.8284271 (f32); grow = 0.0028284271.
    // Size-scale values are one binary32 ULP coarser than double math,
    // hence 6-digit tolerance here.
    expect(bounds.position[0]).toBeCloseTo(-0.0028284271, 9);
    expect(bounds.position[1]).toBeCloseTo(-0.0028284271, 9);
    expect(bounds.position[2]).toBeCloseTo(-0.0028284271, 9);
    expect(bounds.size[0]).toBeCloseTo(2.00565685, 6);
    expect(bounds.size[1]).toBeCloseTo(2.00565685, 6);
    expect(bounds.size[2]).toBeCloseTo(0.00565685, 6);
  });

  it('includes user probes in the bounds', () => {
    const quad = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0]);
    const bounds = computeProbeBounds([quad], [[3, 1, 0]]);
    // pre-grow size (3,2,0); length sqrt(13) = 3.6055512; grow 0.0036055513
    expect(bounds.size[0]).toBeCloseTo(3.00721110, 6);
    expect(bounds.size[1]).toBeCloseTo(2.00721110, 6);
    expect(bounds.size[2]).toBeCloseTo(0.00721110, 6);
  });

  it('throws for an empty scene', () => {
    expect(() => computeProbeBounds([], [])).toThrow();
  });
});

describe('generateProbesFromBounds — disabled mode', () => {
  it('generates exactly the 8 bounds endpoints in get_endpoint order', () => {
    const gen = generateProbesFromBounds(
      { position: [1, 2, 3], size: [4, 5, 6] },
      [],
      [],
      'disabled',
    );
    expect(gen.generatedProbes).toEqual([
      [1, 2, 3],
      [1, 2, 9], // i & 1 -> z
      [1, 7, 3], // i & 2 -> y
      [1, 7, 9],
      [5, 2, 3], // i & 4 -> x
      [5, 2, 9],
      [5, 7, 3],
      [5, 7, 9],
    ]);
    expect(gen.cellSize).toBe(0);
    expect(gen.boundLimit).toEqual([0, 0, 0]);
    // Packed vec4s, user probes first.
    expect(Array.from(gen.positions.slice(0, 4))).toEqual([1, 2, 3, 0]);
    expect(gen.positions.length).toBe(8 * 4);
  });

  it('prepends user probes unchanged', () => {
    const gen = generateProbesFromBounds(
      { position: [0, 0, 0], size: [1, 1, 1] },
      [],
      [[0.5, 0.5, 0.5]],
      'disabled',
    );
    expect(Array.from(gen.positions.slice(0, 4))).toEqual([0.5, 0.5, 0.5, 0]);
    expect(gen.positions.length).toBe(9 * 4);
  });
});

describe('generateProbesFromBounds — subdiv modes', () => {
  // A small triangle inside cell [1,2]^3 of a subdiv-4 grid over the
  // bounds [0,4]^3: the octree descends root -> (0,0,0,s2) -> (1,1,1,s1),
  // so exactly one leaf cell exists and its 8 corners become probes.
  const smallTriangle = new Float32Array([
    1.25, 1.25, 1.5,
    1.75, 1.25, 1.5,
    1.25, 1.75, 1.5,
  ]);

  it('subdiv_4: endpoints + all corners of the single touched leaf cell', () => {
    const gen = generateProbesFromBounds(
      { position: [0, 0, 0], size: [4, 4, 4] },
      [smallTriangle],
      [],
      'subdiv_4',
    );

    expect(gen.cellSize).toBe(1);
    expect(gen.boundLimit).toEqual([4, 4, 4]);

    expect(gen.generatedProbes).toEqual([
      // 8 endpoints of the bound_limit box (bit order i&1 -> x here!)
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
      [4, 4, 0],
      [0, 0, 4],
      [4, 0, 4],
      [0, 4, 4],
      [4, 4, 4],
      // 8 corners of the leaf cell (1,1,1) size 1
      [1, 1, 1],
      [2, 1, 1],
      [1, 2, 1],
      [2, 2, 1],
      [1, 1, 2],
      [2, 1, 2],
      [1, 2, 2],
      [2, 2, 2],
    ]);
    expect(gen.positions.length).toBe(16 * 4);
    // w components are zero (Godot Probe.position[3] = 0)
    expect(gen.positions[3]).toBe(0);
    expect(gen.positions[63]).toBe(0);
  });

  it('drops generated probes within cell_size * 0.5 of a user probe', () => {
    // User probe (1.25,1,1) is 0.25 from corner (1,1,1) -> dropped;
    // every other corner is >= 0.75 away -> kept.
    const gen = generateProbesFromBounds(
      { position: [0, 0, 0], size: [4, 4, 4] },
      [smallTriangle],
      [[1.25, 1, 1]],
      'subdiv_4',
    );

    expect(gen.userProbes).toEqual([[1.25, 1, 1]]);
    expect(gen.generatedProbes).not.toContainEqual([1, 1, 1]);
    expect(gen.generatedProbes).toContainEqual([2, 1, 1]);
    expect(gen.generatedProbes.length).toBe(15); // 8 endpoints + 7 corners
    expect(gen.positions.length).toBe(16 * 4);
  });

  it('snaps non-longest axes up to whole cells (bounds compensation quirk)', () => {
    // Bounds (4, 3.5, 3.5): x is longest -> cell 1 -> limits (4, 4, 4),
    // and the *bounds themselves* are re-sized to (4,4,4). Probe (0,4,4)
    // lies outside the original geometry bounds — Godot does this too.
    const gen = generateProbesFromBounds(
      { position: [0, 0, 0], size: [4, 3.5, 3.5] },
      [],
      [],
      'subdiv_4',
    );

    expect(gen.bounds.size).toEqual([4, 4, 4]);
    expect(gen.boundLimit).toEqual([4, 4, 4]);
    expect(gen.generatedProbes).toContainEqual([0, 4, 4]);
    expect(gen.generatedProbes).toContainEqual([4, 4, 4]);
    expect(gen.generatedProbes.length).toBe(8); // no meshes -> endpoints only
  });

  it('offsets probe positions by the bounds position', () => {
    const gen = generateProbesFromBounds(
      { position: [10, 20, 30], size: [4, 4, 4] },
      [new Float32Array([11.25, 21.25, 31.5, 11.75, 21.25, 31.5, 11.25, 21.75, 31.5])],
      [],
      'subdiv_4',
    );
    expect(gen.generatedProbes).toContainEqual([10, 20, 30]);
    expect(gen.generatedProbes).toContainEqual([12, 22, 32]);
    expect(gen.generatedProbes).toContainEqual([11, 21, 31]);
  });
});

describe('packProbesBuffer', () => {
  it('packs vec4 positions byte-exactly', () => {
    const positions = new Float32Array([1, 2, 3, 0, 4, 5, 6, 0]);
    const buf = packProbesBuffer(positions);
    expect(buf.byteLength).toBe(32);
    const view = new DataView(buf);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(12, true)).toBe(0);
    expect(view.getFloat32(16, true)).toBe(4);
  });

  it('GODOT-QUIRK: empty probe list still produces one zeroed Probe (16 bytes)', () => {
    const buf = packProbesBuffer(new Float32Array(0));
    expect(buf.byteLength).toBe(16);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array(16));
  });
});
