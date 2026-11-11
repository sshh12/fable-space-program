/**
 * Breakpoint re-use of the map's line sampling (src/map/sampler.ts `resample`, src/map/scene.ts
 * BreakpointCache): a line whose conic keeps its shape is drawn from the breakpoints of an earlier build,
 * verified piece by piece for the current view. Checked here: the result is as exact as a fresh sampling on
 * every frame of a turning, zooming and time-advancing view; the fast path is actually taken; and vertex
 * counts do not pile up after zooming in and out.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { conicFromState, conicPosition, conicTrueAnomaly, conicVelocity, type ConicElements } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { ViewConic } from '@/map/conicCurve';
import { CHORD_ERROR_PX, CHORD_TOLERANCE_PX, DEBRIS_CHORD_TOLERANCE_PX, FAINT_CHORD_TOLERANCE_PX } from '@/map/constants';
import { MapController } from '@/map/controller';
import { Projector, type Viewport } from '@/map/projection';
import { pointSegmentDistance2D, Sampler } from '@/map/sampler';
import type { MapScene } from '@/map/scene';
import { lookAtCamera, orbitCamera } from '@/map/testing/camera';
import { createSyntheticFixture } from '@/map/testing/syntheticSnapshots';

const MU = 3.986004418e14;
const VIEWPORT: Viewport = { width: 1280, height: 720, pxScale: 1 };
const CSS: [number, number] = [1280, 720];
/** Faint lines (0.9 px); bulk debris orbits use 1.5 px, zone rings the trajectory tolerance. */
const FAINT_KINDS = new Set(['vesselOrbit']);

function conic(rp: number, e: number, tilt = 0.4, spin = 0.7): ConicElements {
  const q = quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, spin), quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, tilt));
  const r = quat.rotate(q, { x: rp, y: 0, z: 0 });
  const v = quat.rotate(q, { x: 0, y: Math.sqrt((MU * (1 + e)) / rp), z: 0 });
  return conicFromState(MU, r, v, 0);
}

/** Greatest distance (device px) of exactly projected curve points from the chord of their own piece. */
function chordError(curve: ViewConic, proj: Projector, u: ArrayLike<number>, sx: ArrayLike<number>, sy: ArrayLike<number>, start: number, count: number, perPiece = 24): number {
  const tmp = new Float64Array(4);
  let worst = 0;
  for (let i = start; i + 1 < start + count; i++) {
    const ax = sx[i]!;
    const ay = sy[i]!;
    const bx = sx[i + 1]!;
    const by = sy[i + 1]!;
    if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
    for (let k = 1; k < perPiece; k++) {
      curve.perifocalWithDerivative(u[i]! + ((u[i + 1]! - u[i]!) * k) / perPiece, tmp);
      const sp = proj.projectView({
        x: curve.ox + curve.px * tmp[0]! + curve.qx * tmp[1]!,
        y: curve.oy + curve.py * tmp[0]! + curve.qy * tmp[1]!,
        z: curve.oz + curve.pz * tmp[0]! + curve.qz * tmp[1]!,
      });
      if (!sp.front || !proj.onScreen(sp.x, sp.y, 2)) continue;
      worst = Math.max(worst, pointSegmentDistance2D(sp.x, sp.y, ax, ay, bx, by));
    }
  }
  return worst;
}

/** Worst chord error of every conic line of a scene relative to its own tolerance (1 = at the tolerance). */
function sceneError(scene: MapScene): { worst: number; line: string; vertices: number } {
  let worst = 0;
  let line = '';
  let vertices = 0;
  for (const l of scene.lines) {
    if (!l.curve) continue;
    vertices += l.count;
    const limit = l.kind === 'debrisOrbit' ? DEBRIS_CHORD_TOLERANCE_PX + 0.01 : FAINT_KINDS.has(l.kind) ? FAINT_CHORD_TOLERANCE_PX + 0.01 : CHORD_ERROR_PX;
    const err = chordError(l.curve, scene.proj, scene.verts.u, scene.verts.sx, scene.verts.sy, l.start, l.count) / limit;
    if (err > worst) {
      worst = err;
      line = l.id;
    }
  }
  return { worst, line, vertices };
}

describe('Sampler.resample', () => {
  const cases: [string, ConicElements, number, number][] = [
    ['ellipse e = 0.4', conic(6.771e6, 0.4), 0, 2 * Math.PI],
    ['ellipse e = 0.95', conic(6.771e6, 0.95), 0, 2 * Math.PI],
    ['hyperbola e = 1.5', conic(2e6, 1.5, 0.2, 1.1), -1.6, 1.6],
  ];
  it.each(cases)('%s: breakpoints of one view verify in a slightly turned view and the result is exact', (_name, c, nu0, nu1) => {
    const centre = v3.scale(v3.add(conicPosition(c, nu0 === 0 ? 0 : nu0), conicPosition(c, nu0 === 0 ? Math.PI : nu1)), 0.5);
    const size = v3.len(v3.sub(conicPosition(c, nu0 === 0 ? Math.PI : nu1), centre));
    const eyeDir = v3.normalize(v3.add(c.W, v3.scale(c.Q, 0.4)));
    const projA = new Projector(lookAtCamera(v3.addScaled(centre, eyeDir, 4 * size), centre), VIEWPORT);
    const curveA = new ViewConic().setFromElements(c, v3.zero(), projA);
    const sampler = new Sampler();
    const a = sampler.sample(curveA, curveA.nuToU(nu0), curveA.nuToU(nu1), projA, 0.8 * CHORD_TOLERANCE_PX);
    expect(a.count).toBeGreaterThan(a.initial); // the view needs refinement, so breakpoints matter
    const n = a.count;
    const us = a.u.slice(0, n);
    const cs = a.c.slice(0, n);
    const ss = a.s.slice(0, n);

    // The same curve from an eye turned by 0.3 degrees about the target and 2 % closer.
    const turned = quat.rotate(quat.fromAxisAngle(v3.normalize(v3.add(c.P, c.W)), 0.005), eyeDir);
    const projB = new Projector(lookAtCamera(v3.addScaled(centre, turned, 3.92 * size), centre), VIEWPORT);
    const curveB = new ViewConic().setFromElements(c, v3.zero(), projB);
    const b = sampler.resample(curveB, us, cs, ss, n, projB, CHORD_TOLERANCE_PX);
    expect(b).not.toBeNull();
    expect(b!.count).toBe(n);
    expect(b!.evaluations).toBeLessThanOrEqual(n + 2);
    for (let i = 0; i < n; i++) expect(b!.u[i]).toBe(us[i]);
    expect(b!.maxError).toBeLessThanOrEqual(CHORD_TOLERANCE_PX);
    expect(chordError(curveB, projB, b!.u, b!.sx, b!.sy, 0, n)).toBeLessThan(CHORD_ERROR_PX);
    // The vertices are the exact curve points of the new view (same as a direct evaluation).
    const fresh = new Sampler().sample(curveB, us[0]!, us[n - 1]!, projB, 1e9);
    expect(b!.sx[0]).toBeCloseTo(fresh.sx[0]!, 9);
    expect(b!.sy[n - 1]).toBeCloseTo(fresh.sy[fresh.count - 1]!, 9);

    // From four times closer the old breakpoints are too coarse: the call says so instead of returning them.
    const projC = new Projector(lookAtCamera(v3.addScaled(centre, eyeDir, size), centre), VIEWPORT);
    const curveC = new ViewConic().setFromElements(c, v3.zero(), projC);
    expect(sampler.resample(curveC, us, cs, ss, n, projC, CHORD_TOLERANCE_PX)).toBeNull();
  });

  it('refuses fewer than two breakpoints', () => {
    const c = conic(6.771e6, 0.2);
    const proj = new Projector(lookAtCamera(v3.scale(c.W, 5e7), v3.zero()), VIEWPORT);
    const curve = new ViewConic().setFromElements(c, v3.zero(), proj);
    expect(new Sampler().resample(curve, new Float64Array([0]), new Float64Array([1]), new Float64Array([0]), 1, proj, 1)).toBeNull();
  });
});

describe('breakpoint re-use in the scene builder', () => {
  let defs: DefLibrary;
  let snapshot: SimSnapshot;
  beforeAll(async () => {
    defs = await loadDefs(fsDefSource());
    snapshot = createSyntheticFixture(defs, { correctionNodes: 3 }).snapshot;
  });
  const earthOf = (s: SimSnapshot): Vec3 => s.bodies.find((b) => b.id === defs.rootBodyId)!.rRoot;

  it('a turning view is drawn from kept breakpoints and stays within tolerance on every frame', () => {
    const map = new MapController(defs);
    map.setActive(true);
    map.setDebrisOrbits(true); // the load case: every debris orbit drawn
    const fresh = new MapController(defs);
    fresh.setActive(true);
    const focus = earthOf(snapshot);
    let resampled = 0;
    let lines = 0;
    let evalsReuse = 0;
    let evalsFresh = 0;
    let worst = 0;
    for (let f = 0; f < 240; f++) {
      const cam: CameraState = orbitCamera(focus, 0.4 + 0.002 * f, 0.5, 9e7);
      map.frame(snapshot, cam, CSS);
      const e = sceneError(map.currentScene!);
      expect(e.worst, `frame ${f}, line ${e.line}`).toBeLessThan(1);
      worst = Math.max(worst, e.worst);
      const st = map.stats();
      if (f > 0) {
        resampled += st.reuse.resampled;
        lines += st.reuse.resampled + st.reuse.fresh;
        evalsReuse += st.lines.reduce((a, l) => a + l.evaluations, 0);
        // What the same frame costs without anything kept: a controller that never saw the previous frame.
        const cold = new MapController(defs);
        cold.setActive(true);
        cold.setDebrisOrbits(true);
        cold.frame(snapshot, cam, CSS);
        evalsFresh += cold.stats().lines.reduce((a, l) => a + l.evaluations, 0);
      }
    }
    expect(worst).toBeGreaterThan(0.3); // the measure sees real chord error, it is not vacuous
    expect(resampled / lines).toBeGreaterThan(0.9);
    // Vertex evaluations stay close to a fresh sampling's (the saving is refinement, heap and trigonometry).
    expect(evalsReuse).toBeLessThan(1.25 * evalsFresh);
  });

  it('zooming in and back out neither leaves the tolerance nor piles up vertices', () => {
    const map = new MapController(defs);
    map.setActive(true);
    map.setDebrisOrbits(true); // the load case: every debris orbit drawn
    const focus = earthOf(snapshot);
    const distances: number[] = [];
    for (let i = 0; i <= 60; i++) distances.push(9e7 * 0.95 ** i);
    for (let i = 59; i >= 0; i--) distances.push(9e7 * 0.95 ** i);
    let vertices = 0;
    for (const d of distances) {
      map.frame(snapshot, orbitCamera(focus, 0.4, 0.5, d), CSS);
      const e = sceneError(map.currentScene!);
      expect(e.worst, `distance ${d}, line ${e.line}`).toBeLessThan(1);
      vertices = e.vertices;
    }
    // Two more frames at the final view let lines flagged as over-refined be sampled afresh.
    for (let i = 0; i < 2; i++) map.frame(snapshot, orbitCamera(focus, 0.4, 0.5, 9e7), CSS);
    vertices = sceneError(map.currentScene!).vertices;
    const cold = new MapController(defs);
    cold.setActive(true);
    cold.setDebrisOrbits(true);
    cold.frame(snapshot, orbitCamera(focus, 0.4, 0.5, 9e7), CSS);
    const coldVertices = sceneError(cold.currentScene!).vertices;
    expect(vertices).toBeLessThan(1.5 * coldVertices);
  });

  it('vessels moving along their orbits keep their breakpoints (a whole revolution may start anywhere)', () => {
    const map = new MapController(defs);
    map.setActive(true);
    map.setDebrisOrbits(true); // the load case: every debris orbit drawn
    const focus = earthOf(snapshot);
    const cam = orbitCamera(focus, 0.4, 0.5, 9e7);
    map.frame(snapshot, cam, CSS);
    let resampledOrbits = 0;
    let orbits = 0;
    for (let f = 1; f <= 40; f++) {
      // Advance every other vessel by 3 degrees of true anomaly per frame (the snapshot time moves with it,
      // so nothing is served from the orbit cache).
      const moved: SimSnapshot = {
        ...snapshot,
        ut: snapshot.ut + f,
        vessels: snapshot.vessels.map((v) => {
          if (v.id === snapshot.activeVesselId) return v;
          const c = conicFromState(defs.bodies[v.bodyId]!.mu, v.r, v.v, snapshot.ut);
          const nu = conicTrueAnomaly(c, v.r) + (3 * f * Math.PI) / 180;
          const r = conicPosition(c, nu);
          const body = snapshot.bodies.find((b) => b.id === v.bodyId)!;
          return { ...v, r, v: conicVelocity(c, nu), rRoot: v3.add(body.rRoot, r) };
        }),
      };
      map.frame(moved, cam, CSS);
      const scene = map.currentScene!;
      const e = sceneError(scene);
      expect(e.worst, `frame ${f}, line ${e.line}`).toBeLessThan(1);
      for (const l of scene.lines) {
        if (l.kind !== 'debrisOrbit' && l.kind !== 'vesselOrbit') continue;
        orbits++;
        // A line drawn from kept breakpoints spends one evaluation per vertex and no more.
        if (l.evaluations <= l.count) resampledOrbits++;
        // The line still starts at the vessel and closes on itself.
        const v = moved.vessels.find((x) => `vessel:${x.id}` === l.id)!;
        const p = scene.proj.projectRoot(v.rRoot);
        expect(Math.hypot(scene.verts.sx[l.start]! - p.x, scene.verts.sy[l.start]! - p.y)).toBeLessThan(1e-6);
        const last = l.start + l.count - 1 - l.seam;
        expect(Math.hypot(scene.verts.sx[last]! - p.x, scene.verts.sy[last]! - p.y)).toBeLessThan(1e-6);
        for (let i = l.start + 1; i < l.start + l.count; i++) expect(scene.verts.u[i]!).toBeGreaterThan(scene.verts.u[i - 1]!);
      }
    }
    expect(orbits).toBeGreaterThan(20 * 40 - 1);
    expect(resampledOrbits / orbits).toBeGreaterThan(0.9);
  });

  it('a line whose conic changes shape is sampled afresh', () => {
    const map = new MapController(defs);
    map.setActive(true);
    map.setDebrisOrbits(true); // the load case: every debris orbit drawn
    const focus = earthOf(snapshot);
    map.frame(snapshot, orbitCamera(focus, 0.4, 0.5, 9e7), CSS);
    const lines = map.stats().lines.length;
    expect(map.stats().reuse).toEqual({ resampled: 0, fresh: lines });
    // The scene is rebuilt only when the camera or the snapshot changes: turn the view a little.
    map.frame(snapshot, orbitCamera(focus, 0.401, 0.5, 9e7), CSS);
    expect(map.stats().reuse).toEqual({ resampled: lines, fresh: 0 });
    // Give one debris object 2 % more speed: its eccentricity changes, the others keep theirs.
    const changed: SimSnapshot = { ...snapshot, vessels: snapshot.vessels.map((v) => (v.id === 'debris-3' ? { ...v, v: v3.scale(v.v, 1.02) } : v)) };
    map.frame(changed, orbitCamera(focus, 0.402, 0.5, 9e7), CSS);
    expect(map.stats().reuse.fresh).toBe(1);
    expect(sceneError(map.currentScene!).worst).toBeLessThan(1);
  });
});
