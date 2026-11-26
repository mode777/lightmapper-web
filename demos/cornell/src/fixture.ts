/**
 * The fixture scene for the Cornell demo — hand-authored so it can be
 * recreated in native Godot for golden comparisons (PORTING_PLAYBOOK §7:
 * keep this file in lock-step with any golden dump).
 *
 * Not a port: deterministic test geometry. A Cornell-style room (red/green
 * side walls), two boxes, and an emissive ceiling panel; one omni light +
 * one faint directional. UV2 is explicit (per-face charts); normals are
 * omitted so the flat-face path computes them in Godot's clockwise-front
 * convention (room quads face *into* the room, boxes outward). The
 * lightmapper rasterizes unculled, but the winding still decides
 * `face_normal` — the un-occlusion tangent frame and bias direction — so it
 * has to agree with the vertex normals.
 */

import { BakeScene } from '@lightmapper/core';

export interface FixtureOptions {
  atlasMaxSize?: number;
}

type Vec3 = [number, number, number];
type Quad = readonly [Vec3, Vec3, Vec3, Vec3]; // p00, p10, p11, p01 (u right, v up)

/**
 * Append one quad (two triangles) with UVs mapped onto a chart rect.
 *
 * `p00, p10, p11, p01` is the chart order (u right, v up). Seen from the
 * side where that order reads naturally the loop is counter-clockwise, so
 * the right-hand-rule normal of (p00, p10, p11) points AT that viewer.
 * Godot's front faces are clockwise, so each triangle is emitted reversed:
 * the clockwise-front normal (what `face_normal` in lm_raster.wgsl and
 * `flatFaceNormal` compute) then points at that same viewer.
 */
function pushQuad(
  mesh: { positions: number[]; uv2: number[] },
  q: Quad,
  chart: { u0: number; u1: number; v0: number; v1: number },
): void {
  const [p00, p10, p11, p01] = q;
  const uvs: Array<[number, number]> = [
    [chart.u0, chart.v0],
    [chart.u1, chart.v0],
    [chart.u1, chart.v1],
    [chart.u0, chart.v1],
  ];
  // Reversed triangle order → clockwise front faces (Godot convention).
  const tris: Array<Array<number>> = [
    [0, 2, 1],
    [0, 3, 2],
  ];
  for (const tri of tris) {
    for (const k of tri) {
      const p = q[k];
      const uv = uvs[k];
      mesh.positions.push(p[0], p[1], p[2]);
      mesh.uv2.push(uv[0], uv[1]);
    }
  }
}

// Wall charts span 2 % .. 98 % of the lightmap. With 256-texel walls that
// puts every chart edge at a fractional texel offset of 0.12/0.88, so the
// first ring of texels outside each edge sits 0.12 texels out (reachable
// only by the edge-expanded draw, never by the fill pass) and the second
// ring 1.12 texels out (beyond any expansion) — deterministic for
// tools/verify-demo-remote.py.
const FULL_CHART = { u0: 0.02, u1: 0.98, v0: 0.02, v1: 0.98 };

/** The 6 outward faces of a box, each mapped to one chart of a 3×2 grid. */
function boxMesh(center: Vec3, hx: number, hy: number, hz: number, inset = 0.02): {
  positions: Float32Array;
  uv2: Float32Array;
} {
  const [cx, cy, cz] = center;
  const mesh = { positions: [] as number[], uv2: [] as number[] };
  const faces: Quad[] = [
    // +x (seen from +x: right = −z, up = +y)
    [
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx + hx, cy + hy, cz + hz],
    ],
    // −x (right = +z, up = +y)
    [
      [cx - hx, cy - hy, cz - hz],
      [cx - hx, cy - hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz - hz],
    ],
    // +y (right = +x, up = −z)
    [
      [cx - hx, cy + hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx + hx, cy + hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
    ],
    // −y (right = +x, up = +z)
    [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz + hz],
      [cx - hx, cy - hy, cz + hz],
    ],
    // +z (right = +x, up = +y)
    [
      [cx - hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ],
    // −z (right = −x, up = +y)
    [
      [cx + hx, cy - hy, cz - hz],
      [cx - hx, cy - hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
    ],
  ];
  faces.forEach((face, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cw = 1 / 3;
    const ch = 1 / 2;
    pushQuad(mesh, face, {
      u0: col * cw + inset,
      u1: (col + 1) * cw - inset,
      v0: row * ch + inset,
      v1: (row + 1) * ch - inset,
    });
  });
  return {
    positions: new Float32Array(mesh.positions),
    uv2: new Float32Array(mesh.uv2),
  };
}

/** One single-sided wall quad wound so its flat normal points into the room. */
function wallMesh(q: Quad): {
  positions: Float32Array;
  uv2: Float32Array;
} {
  const mesh = { positions: [] as number[], uv2: [] as number[] };
  pushQuad(mesh, q, FULL_CHART);
  return {
    positions: new Float32Array(mesh.positions),
    uv2: new Float32Array(mesh.uv2),
  };
}

/** Room: x ∈ [−2, 2], y ∈ [0, 3], z ∈ [−2.5, 2.5], viewed from inside. */
const ROOM = { hx: 2, hy: 1.5, hz: 2.5 };

/** Build the fixture scene (deterministic). */
export function fixtureScene(): BakeScene {
  const scene = new BakeScene();
  const { hx, hy, hz } = ROOM;
  const cy = hy;

  const white = { baseColor: [0.73, 0.71, 0.68] as [number, number, number] };
  const red = { baseColor: [0.66, 0.09, 0.05] as [number, number, number] };
  const green = { baseColor: [0.12, 0.45, 0.09] as [number, number, number] };

  // Walls — each chart loop reads counter-clockwise from inside the room,
  // so the emitted clockwise-front normal points inward (see pushQuad).
  // The u/v axes listed per wall are the chart's (u = p00→p10, v = p00→p01).
  const wallOpts = { lightmapSizeHint: [256, 256] as [number, number], material: white };
  // floor (−y face): inward +y — u = +x, v = −z
  scene.addMesh({ ...wallOpts, ...wallMesh([
    [-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz], [-hx, 0, -hz],
  ]) });
  // ceiling (+y face): inward −y — u = +x, v = +z
  scene.addMesh({ ...wallOpts, ...wallMesh([
    [-hx, 2 * hy, -hz], [hx, 2 * hy, -hz], [hx, 2 * hy, hz], [-hx, 2 * hy, hz],
  ]) });
  // back wall (−z face): inward +z — u = +x, v = +y
  scene.addMesh({ ...wallOpts, ...wallMesh([
    [-hx, 0, -hz], [hx, 0, -hz], [hx, 2 * hy, -hz], [-hx, 2 * hy, -hz],
  ]) });
  // front wall (+z face): inward −z — u = +x, v = −y (top edge at v=0)
  scene.addMesh({ ...wallOpts, ...wallMesh([
    [-hx, 2 * hy, hz], [hx, 2 * hy, hz], [hx, 0, hz], [-hx, 0, hz],
  ]) });
  // left wall (−x face, red): inward +x — u = +z, v = −y (top edge at v=0)
  scene.addMesh({ ...wallOpts, material: red, ...wallMesh([
    [-hx, 2 * hy, -hz], [-hx, 2 * hy, hz], [-hx, 0, hz], [-hx, 0, -hz],
  ]) });
  // right wall (+x face, green): inward −x — u = −z, v = −y (top edge at v=0)
  scene.addMesh({ ...wallOpts, material: green, ...wallMesh([
    [hx, 2 * hy, hz], [hx, 2 * hy, -hz], [hx, 0, -hz], [hx, 0, hz],
  ]) });

  // Tall box (left-back) and short box (right-front) — closed, outward normals.
  scene.addMesh({
    lightmapSizeHint: [128, 128],
    material: { baseColor: [0.63, 0.6, 0.55] },
    ...boxMesh([-1.15, 1.0, -1.55], 0.5, 1.0, 0.5),
  });
  scene.addMesh({
    lightmapSizeHint: [128, 128],
    material: { baseColor: [0.25, 0.32, 0.62] },
    ...boxMesh([1.05, 0.35, 1.45], 0.7, 0.35, 0.7),
  });

  // Emissive ceiling panel (the "lamp").
  scene.addMesh({
    lightmapSizeHint: [64, 64],
    material: { baseColor: [0.05, 0.05, 0.05], emission: [1, 0.95, 0.85], emissionEnergy: 4 },
    ...boxMesh([0, 2.9, 0], 0.45, 0.06, 0.45),
  });

  // Lights (consumed from M3 on; they ride along for buffer parity).
  scene.addOmniLight({ position: [0, 2.62, 0], color: [1, 0.96, 0.9], energy: 3, range: 9, size: 0.35, shadowBlur: 0.1 });
  scene.addDirectionalLight({ direction: [0.25, -1, 0.15], color: [0.65, 0.75, 0.9], energy: 0.25 });

  return scene;
}
