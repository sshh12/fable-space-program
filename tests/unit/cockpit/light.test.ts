/**
 * Light transport of the cockpit interior on the CPU: the BVH against brute force, the occlusion bake
 * (the same sampling the GPU bake runs) at probe points whose answer is known from the geometry, the sun
 * map transform and its casters, the plugs for the core's cascades, and the sun-patch ray cast's receiver albedo.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math';
import { bvhRay } from '@/render/cockpit/bvh';
import { meshPositions, sunRange, type CockpitModel } from '@/render/cockpit/build';
import { FLAG_ENCLOSURE, FLAG_OVERLAY, seatFrames } from '@/render/cockpit/cabin/context';
import { cabinSources, castCabinRay, coveredWindows } from '@/render/cockpit/lighting';
import { insideDistance } from '@/render/cockpit/mould';
import { occlusionAt, occlusionSources, type OccSources } from '@/render/cockpit/occlusion';
import { probeDirection, probeFaceMatrix, PROBE_FACES } from '@/render/cockpit/probe';
import { sunEnters, sunMapLayout, sunTileUniform } from '@/render/cockpit/sunmap';
import { testDefs, testModel } from './helpers';

let model: CockpitModel;
let sources: OccSources;

beforeAll(async () => {
  model = await testModel();
  sources = occlusionSources(model);
});

/** Brute-force closest hit over the full-detail triangles, overlays left out as in the bake's BVH. */
function bruteClosest(o: Vec3, d: Vec3): number {
  const pos = meshPositions(model.mesh);
  const r = model.mesh.ranges.lod0!;
  const idx = model.mesh.indices;
  const P = (k: number): Vec3 => ({ x: pos[k * 3]!, y: pos[k * 3 + 1]!, z: pos[k * 3 + 2]! });
  const u8 = new Uint8Array(model.mesh.vertices);
  let best = Infinity;
  for (let i = r.start; i < r.start + r.count; i += 3) {
    if ((u8[idx[i]! * 48 + 42]! & FLAG_OVERLAY) !== 0) continue;
    const a = P(idx[i]!);
    const e1 = v3.sub(P(idx[i + 1]!), a);
    const e2 = v3.sub(P(idx[i + 2]!), a);
    const pv = v3.cross(d, e2);
    const det = v3.dot(e1, pv);
    if (Math.abs(det) < 1e-14) continue;
    const tv = v3.sub(o, a);
    const u = v3.dot(tv, pv) / det;
    if (u < 0 || u > 1) continue;
    const qv = v3.cross(tv, e1);
    const w = v3.dot(d, qv) / det;
    if (w < 0 || u + w > 1) continue;
    const t = v3.dot(e2, qv) / det;
    if (t > 1e-4 && t < best) best = t;
  }
  return best;
}

describe('cabin BVH', () => {
  it('finds the same closest hits as brute force', () => {
    const cdr = seatFrames(model.mould)[0]!;
    let hits = 0;
    for (let k = 0; k < 40; k++) {
      // Rays from the commander's eye in a spiral over the sphere.
      const z = 1 - (2 * (k + 0.5)) / 40;
      const a = k * 2.39996;
      const d = { x: Math.sqrt(1 - z * z) * Math.cos(a), y: z, z: Math.sqrt(1 - z * z) * Math.sin(a) };
      const h = bvhRay(model.bvh, cdr.eye, d, 1e-4, 50, false);
      const ref = bruteClosest(cdr.eye, d);
      if (ref === Infinity) expect(h).toBeNull();
      else {
        expect(h, `ray ${k}`).not.toBeNull();
        expect(h!.t).toBeCloseTo(ref, 6);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(30);
  });
});

describe('occlusion bake', () => {
  // Probe points on the cabin floor (normal up): open floor by the hatch, and under the pilot's couch.
  const floorPoint = (x: number, z: number): Vec3 => ({ x, y: model.mould.cabinFloorY + 0.003, z });
  const up = { x: 0, y: 1, z: 0 };

  it('hides the flood lights from the floor under the couches and occludes the corner at the wall', () => {
    // The floods that stand above the couches (higher than the seats' eye points) are hidden from the floor
    // under the pilot's back and hips, and seen from the open floor ahead of the couches. (The low floods by
    // the floor shine across it, under the couches: they are no part of this.)
    const plt = seatFrames(model.mould).find((s) => s.id === 'plt')!;
    const overhead = model.floods.map((f, i) => (Math.min(f.p0.y, f.p1.y) > plt.eye.y ? i : -1)).filter((i) => i >= 0);
    expect(overhead.length).toBeGreaterThanOrEqual(2);
    const mean = (o: { floods: number[] }): number => overhead.reduce((s, i) => s + o.floods[i]!, 0) / overhead.length;
    const floorR = model.mesh.bounds.max.x;
    const under = occlusionAt(model, model.bvh, sources, floorPoint(plt.eye.x, plt.eye.z + plt.U.z * model.layout.couches.hipU * 0.8), up, 1);
    const open = occlusionAt(model, model.bvh, sources, floorPoint(0, 0.7 * floorR), up, 2);
    expect(mean(open)).toBeGreaterThan(mean(under) + 0.3);
    expect(mean(under)).toBeLessThan(0.25);
    // Where the floor meets the sloping wall, the wall takes a large part of the hemisphere.
    const r = model.mould.heatShield.maxDiameter / 2;
    const corner = occlusionAt(model, model.bvh, sources, floorPoint(0.3, -(r - 0.4)), up, 3);
    const middle = occlusionAt(model, model.bvh, sources, floorPoint(0, 0), up, 4);
    expect(middle.ao).toBeGreaterThan(corner.ao + 0.15);
  });

  it('lets a face that looks straight at a window see it, and hides it behind the wall', () => {
    // From the commander's eye, looking at the left forward window: no occluder in between.
    const w = model.windows.findIndex((x) => x.id === 'fwd-left');
    const cdr = seatFrames(model.mould).find((s) => s.id === 'cdr')!;
    const toWindow = v3.normalize(v3.sub(model.windows[w]!.centre, cdr.eye));
    const eye = occlusionAt(model, model.bvh, sources, cdr.eye, toWindow, 3);
    expect(eye.windows[w]).toBeGreaterThan(0.9);
    // From behind the console face (inside the console body), the window is blocked by the console.
    const d = model.displays[0]!;
    const behind = v3.addScaled(d.frame.o, d.frame.n, -0.05);
    const hidden = occlusionAt(model, model.bvh, sources, behind, toWindow, 4);
    expect(hidden.windows[w]).toBeLessThan(0.2);
  });

  it('keeps every value in 0..1 with one slot per window and display', () => {
    const o = occlusionAt(model, model.bvh, sources, floorPoint(0.5, 0.5), up, 5);
    expect(o.windows).toHaveLength(model.windows.length);
    expect(o.displays).toHaveLength(model.displays.length);
    for (const x of [o.ao, o.flood, ...o.windows, ...o.displays]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe('cabin probe', () => {
  it('renders every cube face with the axes its texels are read back with', () => {
    const c = { x: 0.1, y: 1.3, z: -0.2 };
    for (let face = 0; face < 6; face++) {
      const m = probeFaceMatrix(face, c, 0.03, 8);
      const clip = (p: Vec3): [number, number, number, number] => [0, 1, 2, 3].map((r) => m[r]! * p.x + m[4 + r]! * p.y + m[8 + r]! * p.z + m[12 + r]!) as [number, number, number, number];
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.2], [0.9, 0.7], [0.3, 0.95]] as const) {
        const d = probeDirection(face, u, v);
        const [x, y, z, w] = clip(v3.addScaled(c, d, 1.7));
        expect(w).toBeGreaterThan(0);
        // Texel (u, v), v down from the top, is where the point along its direction is drawn.
        expect(x / w).toBeCloseTo(2 * u - 1, 6);
        expect(y / w).toBeCloseTo(1 - 2 * v, 6);
        expect(z / w).toBeGreaterThan(0);
        expect(z / w).toBeLessThan(1);
      }
      // The face looks along its own axis: a point one metre along it is one metre in front of the camera.
      expect(clip(v3.add(c, PROBE_FACES[face]!.f))[3]).toBeCloseTo(1, 6);
    }
    // The probe's centre lies in the open cabin: nothing within a hand's breadth of it.
    const seats = seatFrames(model.mould);
    const centre = seats.reduce((s, x) => v3.add(s, v3.scale(v3.addScaled(x.eye, x.L, 0.28), 1 / seats.length)), v3.zero());
    for (let k = 0; k < 200; k++) {
      const z = 1 - (2 * (k + 0.5)) / 200;
      const r = Math.sqrt(1 - z * z);
      const h = bvhRay(model.bvh, centre, { x: r * Math.cos(k * 2.4), y: z, z: r * Math.sin(k * 2.4) }, 1e-4, 10, false);
      if (h) expect(h.t).toBeGreaterThan(0.08);
    }
  });
});

describe('the cabin is closed', () => {
  it('lets no ray out of the cabin except through a window pane', () => {
    // Rays from the cabin's middle and from each seat's eye in directions spread over the sphere: every one
    // hits the interior, or leaves through the opening of a window (its pane is glass, drawn separately).
    // The side hatch's seam, the tunnel and the floor's edge are shut.
    const eyes = [...seatFrames(model.mould).map((s) => v3.addScaled(s.eye, s.L, 0.05)), { x: 0, y: 1.5, z: 0 }];
    let escaped = 0;
    let leaks = 0;
    const N = 6000;
    for (const o of eyes) {
      for (let k = 0; k < N; k++) {
        const z = 1 - (2 * (k + 0.5)) / N;
        const r = Math.sqrt(1 - z * z);
        const a = k * 2.399963;
        const d = { x: r * Math.cos(a), y: z, z: r * Math.sin(a) };
        if (bvhRay(model.bvh, o, d, 1e-4, 20, true)) continue;
        escaped++;
        // Through which window? The ray must cross a window's inner pane inside its outline.
        const through = model.windows.some((w) => {
          const pane = w.panes[w.panes.length - 1]!;
          const den = v3.dot(d, pane.frame.n);
          if (Math.abs(den) < 1e-9) return false;
          const t = v3.dot(v3.sub(pane.frame.o, o), pane.frame.n) / den;
          if (t <= 0) return false;
          const h = v3.sub(v3.addScaled(o, d, t), pane.frame.o);
          const reach = Math.max(...pane.outline.map((p) => v3.dist(p, pane.frame.o)));
          return v3.len(h) <= reach;
        });
        if (!through) leaks++;
      }
    }
    expect(escaped).toBeGreaterThan(0);
    expect(leaks).toBe(0);
  });
});

describe('cabin sun map', () => {
  it('gives every window the sun enters a tile that holds its whole beam at sub-millimetre texels', () => {
    const b = model.mesh.bounds;
    const c = v3.scale(v3.add(b.min, b.max), 0.5);
    const pos = meshPositions(model.mesh);
    let radius = 0;
    for (let i = 0; i < pos.length; i += 3) radius = Math.max(radius, v3.dist({ x: pos[i]!, y: pos[i + 1]!, z: pos[i + 2]! }, c));
    const apertures = model.windows.map((w) => w.aperture);
    // Straight into each window, and obliquely across the cabin.
    const suns = [...model.windows.map((w) => v3.neg(w.inward)), v3.normalize({ x: 1, y: 0.6, z: 0.3 }), v3.normalize({ x: -0.3, y: 0.9, z: 0.4 })];
    let layouts = 0;
    for (const sun of suns) {
      const t = sunMapLayout(sun, apertures, c, radius + 0.05);
      const lit = apertures.filter((a) => sunEnters(a.inward, sun)).length;
      expect(t === null).toBe(lit === 0);
      if (!t) continue;
      layouts++;
      expect(t.tiles).toHaveLength(lit);
      expect(t.perSide * t.perSide).toBeGreaterThanOrEqual(lit);
      const tileTexels = Math.floor(2048 / t.perSide);
      const depth = (p: Vec3): number => t.l[0] * p.x + t.l[1] * p.y + t.l[2] * p.z + t.l[3];
      for (const tile of t.tiles) {
        // Texels: well under a millimetre (the old cabin-wide map had 2 mm).
        expect(Math.max(tile.spanU, tile.spanV) / tileTexels).toBeLessThan(0.001);
        const a = apertures[tile.window]!;
        // Both ends of the aperture's prism, carried along the sun, lie inside the tile.
        for (const end of [0, a.innerDepth]) {
          for (const [st, sg] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
            const p = v3.add(v3.addScaled(a.centre, a.inward, end), v3.add(v3.scale(a.t, st * a.hw), v3.scale(a.g, sg * a.hh)));
            if (end > 0) continue;
            for (const row of [tile.u, tile.v]) {
              const x = row[0] * p.x + row[1] * p.y + row[2] * p.z + row[3];
              expect(x).toBeGreaterThan(0);
              expect(x).toBeLessThan(1);
            }
            // The shader's atlas coordinates of the same point lie inside the tile's cell of the atlas.
            const tileUv = tileTexels / 2048;
            const rec = sunTileUniform(tile, tileUv);
            const au = rec[0]! * p.x + rec[1]! * p.y + rec[2]! * p.z + rec[3]!;
            const av = rec[4]! * p.x + rec[5]! * p.y + rec[6]! * p.z + rec[7]!;
            expect(au).toBeGreaterThan(rec[10]!);
            expect(au).toBeLessThan(rec[10]! + tileUv);
            expect(av).toBeGreaterThan(rec[11]!);
            expect(av).toBeLessThan(rec[11]! + tileUv);
          }
        }
      }
      // Depth: every interior vertex inside 0..1, growing away from the sun.
      for (let i = 0; i < pos.length; i += 3 * 331) {
        const d = depth({ x: pos[i]!, y: pos[i + 1]!, z: pos[i + 2]! });
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThan(1);
      }
      expect(depth(v3.addScaled(c, sun, 1))).toBeLessThan(depth(v3.addScaled(c, sun, -1)));
    }
    expect(layouts).toBeGreaterThanOrEqual(model.windows.length);
  });

  it('closes the openings for the core and leaves the enclosure out of the cabin map', () => {
    const pos = meshPositions(model.mesh);
    const wall = model.mould.wallThickness;
    const vr = model.mesh.vertexRanges;
    // Plugs: on the inner wall (one wall thickness inside the mould line).
    expect(vr.plugs!.count).toBeGreaterThan(0);
    for (let i = vr.plugs!.start; i < vr.plugs!.start + vr.plugs!.count; i++) {
      const d = insideDistance(model.mould, { x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });
      expect(d).toBeGreaterThan(wall - 0.03);
      expect(d).toBeLessThan(wall + 0.03);
    }
    // The sun map's casters: every full-detail triangle except the enclosure (wall, floor, tunnel, bezels).
    const u8 = new Uint8Array(model.mesh.vertices);
    const idx = model.mesh.indices;
    const lod0 = model.mesh.ranges.lod0!;
    const sun = model.mesh.ranges[sunRange('lod0')]!;
    let kept = 0;
    for (let i = lod0.start; i < lod0.start + lod0.count; i += 3) if ((u8[idx[i]! * 48 + 42]! & FLAG_ENCLOSURE) === 0) kept++;
    expect(sun.count / 3).toBe(kept);
    expect(kept).toBeLessThan(lod0.count / 3);
    for (let i = sun.start; i < sun.start + sun.count; i++) expect(u8[idx[i]! * 48 + 42]! & FLAG_ENCLOSURE).toBe(0);
  });
});

describe('sun patches', () => {
  it('take the receiver albedo from the material the ray hits', () => {
    // Straight down onto the floor, from the first point of a grid whose ray reaches it.
    const floorIndex = model.materialNames.indexOf('floor');
    let from: Vec3 | null = null;
    for (let x = -1.2; x <= 1.2 && !from; x += 0.1) {
      for (let z = -1.2; z <= 1.2 && !from; z += 0.1) {
        const h = bvhRay(model.bvh, { x, y: 1.2, z }, { x: 0, y: -1, z: 0 }, 1e-4, 5, false);
        if (h && h.material === floorIndex) from = { x, y: 1.2, z };
      }
    }
    expect(from).not.toBeNull();
    const hit = castCabinRay(model, from!, { x: 0, y: -1, z: 0 })!;
    const floor = model.layout.materials.floor!;
    const expected = 0.2126 * floor.albedo[0] + 0.7152 * floor.albedo[1] + 0.0722 * floor.albedo[2];
    expect(hit.albedo).toBeCloseTo(expected, 6);
    expect(Math.abs(hit.n.y)).toBeGreaterThan(0.99);
  });
});

describe('covered windows', () => {
  it("take the boost cover's ports from its visual params: every other window is shut while the cover is on", async () => {
    const defs = await testDefs();
    const ids = model.windows.map((w) => w.id);
    const vehicle = Object.values(defs.vehicles).find((v) => v.cockpit === 'kestrel')!;
    const parts = vehicle.parts.map((p) => p.def);
    const lib = defs as unknown as Parameters<typeof coveredWindows>[2];
    const withCover = coveredWindows(ids, parts, lib);
    const ports = defs.parts['kestrel-les']!.visual!.params['windowPorts'] as unknown as string[];
    expect(Array.isArray(ports)).toBe(true);
    ids.forEach((id, i) => expect(withCover[i], id).toBe(!ports.includes(id)));
    expect(withCover.some((c) => c)).toBe(true);
    // Once the tower and its cover are gone every window sees out again.
    expect(coveredWindows(ids, parts.filter((p) => p !== 'kestrel-les'), lib).every((c) => !c)).toBe(true);
    // A covered window is a dark source that is off and lets no sun in.
    const src = cabinSources(model, { dirPart: v3.normalize({ x: 0.1, y: 0.9, z: 0.4 }), illuminance: 1e5, color: [1, 1, 1] }, false, withCover);
    src.polys.filter((p) => p.kind === 0).forEach((p) => {
      if (withCover[p.index]) {
        expect(p.on).toBe(false);
        expect(p.radiance).toEqual([0, 0, 0]);
      }
    });
    const open = cabinSources(model, { dirPart: v3.normalize({ x: 0.1, y: 0.9, z: 0.4 }), illuminance: 1e5, color: [1, 1, 1] }, false);
    expect(src.sunFlux).toBeLessThanOrEqual(open.sunFlux);
  });
});