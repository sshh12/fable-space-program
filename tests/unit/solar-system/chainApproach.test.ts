/**
 * Closest approaches between two conic chains (src/sim/orbit/chainApproach.ts) against brute force: the
 * separation sampled every second (each discrete minimum refined by a parabola through its three samples),
 * within 1 m and 0.1 s; across an SOI change of the own chain; the cost of three low-orbit revolutions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManeuverNode } from '../../../src/core/contracts/sim';
import { DEG } from '../../../src/core/math/scalar';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import { chainClosestApproaches, chainOf, ownChain, targetApproachMarkers, type ChainApproach } from '../../../src/sim/orbit/chainApproach';
import { propagate } from '../../../src/sim/orbit/kepler';
import { predictPatchesWithOrbits, type PatchWithOrbit } from '../../../src/sim/orbit/patches';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { loadShipped, utOf } from './fixtures';

let sys: BodySystem;
let earth: string;
let moon: string;
beforeAll(async () => {
  sys = (await loadShipped()).system;
  earth = sys.rootId;
  moon = sys.body(earth).childIds[0]!;
});

/** Circular orbit state about `bodyId`: radius, inclination, node and argument of latitude (rad). */
function circular(bodyId: string, radius: number, inc: number, node: number, u: number): { bodyId: string; r: Vec3; v: Vec3 } {
  const mu = sys.body(bodyId).mu;
  const vc = Math.sqrt(mu / radius);
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const P = { x: cO, y: sO, z: 0 };
  const Q = { x: -sO * ci, y: cO * ci, z: si };
  const r = v3.add(v3.scale(P, radius * Math.cos(u)), v3.scale(Q, radius * Math.sin(u)));
  const v = v3.add(v3.scale(P, -vc * Math.sin(u)), v3.scale(Q, vc * Math.cos(u)));
  return { bodyId, r, v };
}

/** A chain over `span` seconds: the predictor's current list, followed to a node placed at the end. */
function chain(state: { bodyId: string; r: Vec3; v: Vec3 }, ut: number, span: number): PatchWithOrbit[] {
  const node: ManeuverNode = { id: 'end', ut: ut + span, dv: { prograde: 0, normal: 0, radial: 0 } };
  return predictPatchesWithOrbits(sys, state, ut, [node], { maxPatches: 16 }).current;
}

/** Brute force: separation every `step` s through the chains' own patches, discrete minima refined by a parabola. */
function bruteForce(own: PatchWithOrbit[], target: PatchWithOrbit[], t0: number, t1: number, step: number): { t: number; d: number }[] {
  const a = chainOf(own);
  const b = chainOf(target);
  const D = (t: number): number => {
    const pa = a.items[a.indexAt(t)]!;
    const pb = b.items[b.indexAt(t)]!;
    const sa = propagate(pa.orbit, t);
    const sb = propagate(pb.orbit, t);
    const off = pa.patch.bodyId === pb.patch.bodyId ? { x: 0, y: 0, z: 0 } : sys.stateRelative(pb.patch.bodyId, pa.patch.bodyId, t).r;
    return v3.len(v3.add(off, v3.sub(sb.r, sa.r)));
  };
  const out: { t: number; d: number }[] = [];
  let tPrev = t0;
  let dPrev = D(t0);
  let tCur = t0 + step;
  let dCur = D(tCur);
  for (let t = tCur + step; t <= t1; t += step) {
    const d = D(t);
    if (dCur < dPrev && dCur <= d) {
      // parabola through (tPrev, dPrev), (tCur, dCur), (t, d)
      const denom = dPrev - 2 * dCur + d;
      const x = denom > 0 ? tCur + (step * (dPrev - d)) / (2 * denom) : tCur;
      // then a fine local search around it, 1 ms
      let best = { t: x, d: D(x) };
      for (let k = -100; k <= 100; k++) {
        const tt = x + k * 1e-3;
        const dd = D(tt);
        if (dd < best.d) best = { t: tt, d: dd };
      }
      out.push(best);
    }
    tPrev = tCur;
    dPrev = dCur;
    tCur = t;
    dCur = d;
  }
  return out;
}

function expectAgree(found: ChainApproach[], brute: { t: number; d: number }[], n: number): void {
  expect(found.length).toBe(Math.min(n, brute.length));
  for (let i = 0; i < found.length; i++) {
    expect(Math.abs(found[i]!.ut - brute[i]!.t)).toBeLessThan(0.1);
    expect(Math.abs(found[i]!.distance - brute[i]!.d)).toBeLessThan(1);
  }
}

describe('closest approaches between two chains', () => {
  it('two low orbits (400 km and 410 km, 2 deg apart in node): the next three agree with brute force at 1 s within 1 m and 0.1 s', () => {
    const ut = utOf(2030, 1, 1);
    const R = sys.body(earth).radius;
    const own = chain(circular(earth, R + 400e3, 51.6 * DEG, 10 * DEG, 0), ut, 3 * 5560);
    const tgt = chain(circular(earth, R + 410e3, 51.6 * DEG, 12 * DEG, 0.5 * DEG), ut, 3 * 5560);
    const found = chainClosestApproaches(sys, own, tgt, { count: 3 });
    const brute = bruteForce(own, tgt, ut, ut + 3 * 5560 - 1, 1);
    expect(brute.length).toBeGreaterThanOrEqual(3);
    expectAgree(found, brute, 3);
    for (const c of found) {
      expect(c.self.bodyId).toBe(earth);
      expect(c.target.bodyId).toBe(earth);
      expect(c.relSpeed).toBeGreaterThan(0);
      expect(c.onForecast).toBe(false);
    }
  });

  it('a head-on pass in crossing planes (14 km/s): found to 0.1 s and 1 m', () => {
    const ut = utOf(2030, 2, 1);
    const R = sys.body(earth).radius;
    const own = chain(circular(earth, R + 500e3, 30 * DEG, 0, 0), ut, 3 * 5700);
    const tgt = chain(circular(earth, R + 500e3, 150 * DEG, 0, 0.4 * DEG), ut, 3 * 5700);
    const found = chainClosestApproaches(sys, own, tgt, { count: 3 });
    const brute = bruteForce(own, tgt, ut, ut + 3 * 5700 - 1, 1);
    expectAgree(found, brute, 3);
    expect(found[0]!.relSpeed).toBeGreaterThan(10000);
  });

  it('across an SOI change of the own chain (a lunar arrival against a craft in low lunar orbit)', () => {
    const ut = utOf(2030, 3, 1);
    // a vessel 40,000 km from the Moon falling toward it, and a craft in a 100 km lunar orbit
    const ms = sys.stateRelParent(moon, ut);
    const dir = v3.normalize(ms.r);
    const ownState = { bodyId: earth, r: v3.sub(ms.r, v3.scale(dir, 7e7)), v: v3.add(ms.v, v3.scale(dir, 1200)) };
    const own = chain(ownState, ut, 3 * 86400);
    expect(own.some((p) => p.patch.bodyId === moon)).toBe(true);
    const tgt = chain(circular(moon, sys.body(moon).radius + 100e3, 90 * DEG, 0, 0), ut, 3 * 86400);
    const found = chainClosestApproaches(sys, own, tgt, { count: 3, targetHeadUt: ut + 86400 });
    const t1 = Math.min(chainOf(own).tEnd, chainOf(tgt).tEnd);
    const brute = bruteForce(own, tgt, ut, t1 - 1, 1);
    expectAgree(found, brute, 3);
    expect(found.some((c) => c.onForecast)).toBe(found.some((c) => c.ut > ut + 86400));
    const markers = targetApproachMarkers(found, 'craft-b');
    expect(markers[0]!.kind).toBe('targetApproach');
    expect(markers[0]!.otherVesselId).toBe('craft-b');
    expect(markers[0]!.value).toBe(found[0]!.distance);
  });

  it('the own chain of a plan is the current list up to the first planned patch, then the planned list', () => {
    const ut = utOf(2030, 4, 1);
    const R = sys.body(earth).radius;
    const s = circular(earth, R + 300e3, 0, 0, 0);
    const node: ManeuverNode = { id: 'n1', ut: ut + 1000, dv: { prograde: 100, normal: 0, radial: 0 } };
    const p = predictPatchesWithOrbits(sys, s, ut, [node]);
    const c = ownChain(p.current, p.planned);
    expect((c[0] as PatchWithOrbit).patch.tStart).toBe(ut);
    expect((c[c.length - 1] as PatchWithOrbit).patch.afterNodeId).toBe('n1');
  });

  it('costs at most 1 ms for three low orbits (median of 50 runs)', () => {
    const ut = utOf(2030, 1, 1);
    const R = sys.body(earth).radius;
    const own = chain(circular(earth, R + 400e3, 51.6 * DEG, 10 * DEG, 0), ut, 3 * 5560);
    const tgt = chain(circular(earth, R + 410e3, 51.6 * DEG, 12 * DEG, 0.5 * DEG), ut, 3 * 5560);
    for (let i = 0; i < 10; i++) chainClosestApproaches(sys, own, tgt);
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      chainClosestApproaches(sys, own, tgt);
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    const median = times[25]!;
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(`chainClosestApproaches, three LEO orbits: median ${median.toFixed(3)} ms`);
    expect(median).toBeLessThan(1);
  });
});
