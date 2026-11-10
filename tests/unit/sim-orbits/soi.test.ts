/**
 * SOI entry/exit times of the predictor against a brute-force patched-gravity RK4 reference
 * (acceptance: within 0.5 s, at least 20 randomised translunar and return trajectories including grazing
 * passes, no missed encounter).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Prng } from '../../../src/core/math/hash';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { predictPatches } from '../../../src/sim/orbit/patches';
import { loadWorld, mainIds, utOf } from './fixtures';

let sys: BodySystem;
let EARTH = '';
let MOON = '';
const T0 = utOf(2028, 5, 10, 6);

beforeAll(async () => {
  ({ system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON } = mainIds(sys));
});

interface Transition {
  kind: 'enter' | 'exit';
  t: number;
}

function rk4(r: Vec3, v: Vec3, h: number, mu: number): [Vec3, Vec3] {
  const acc = (p: Vec3): Vec3 => v3.scale(p, -mu / Math.pow(v3.lenSq(p), 1.5));
  const a1 = acc(r);
  const r2 = v3.addScaled(r, v, h / 2);
  const v2 = v3.addScaled(v, a1, h / 2);
  const a2 = acc(r2);
  const r3 = v3.addScaled(r, v2, h / 2);
  const vv3 = v3.addScaled(v, a2, h / 2);
  const a3 = acc(r3);
  const r4 = v3.addScaled(r, vv3, h);
  const v4 = v3.addScaled(v, a3, h);
  const a4 = acc(r4);
  return [
    v3.add(r, v3.scale(v3.add(v3.add(v, v4), v3.scale(v3.add(v2, vv3), 2)), h / 6)),
    v3.add(v, v3.scale(v3.add(v3.add(a1, a4), v3.scale(v3.add(a2, a3), 2)), h / 6)),
  ];
}

/** Patched-gravity RK4 reference: only the central body's gravity, frame switched at the SOI boundary. */
function reference(startBody: string, r0: Vec3, v0: Vec3, t0: number, tEnd: number): { events: Transition[]; stoppedAt: number } {
  const muE = sys.body(EARTH).mu;
  const muM = sys.body(MOON).mu;
  const Rsoi = sys.body(MOON).soiRadius!;
  const Rtop = sys.body(EARTH).radius + sys.body(EARTH).def.atmosphere!.simTop;
  const RM = sys.body(MOON).radius;
  let central = startBody;
  let r = v3.clone(r0);
  let v = v3.clone(v0);
  let t = t0;
  const events: Transition[] = [];
  const g = (c: string, rr: Vec3, tt: number): number => (c === EARTH ? v3.dist(rr, sys.stateRelParent(MOON, tt).r) - Rsoi : Rsoi - v3.len(rr));
  while (t < tEnd) {
    const mu = central === EARTH ? muE : muM;
    const rm = v3.len(r);
    if (central === EARTH && rm < Rtop) break;
    if (central === MOON && rm < RM) break;
    const gNow = g(central, r, t);
    const vRel = central === EARTH ? v3.dist(v, sys.stateRelParent(MOON, t).v) : v3.len(v);
    let h = Math.min(0.002 * Math.sqrt((rm * rm * rm) / mu), 600, Math.max(2, gNow / (4 * (vRel + 50))));
    h = Math.min(h, tEnd - t);
    const [r1, v1] = rk4(r, v, h, mu);
    const g1 = g(central, r1, t + h);
    if (g1 <= 0) {
      let lo = 0;
      let hi = h;
      while (hi - lo > 1e-5) {
        const mid = 0.5 * (lo + hi);
        const [rm2] = rk4(r, v, mid, mu);
        if (g(central, rm2, t + mid) > 0) lo = mid;
        else hi = mid;
      }
      const [rx, vx] = rk4(r, v, hi, mu);
      const tx = t + hi;
      const m = sys.stateRelParent(MOON, tx);
      if (central === EARTH) {
        events.push({ kind: 'enter', t: tx });
        r = v3.sub(rx, m.r);
        v = v3.sub(vx, m.v);
        central = MOON;
      } else {
        events.push({ kind: 'exit', t: tx });
        r = v3.add(rx, m.r);
        v = v3.add(vx, m.v);
        central = EARTH;
      }
      t = tx;
      continue;
    }
    r = r1;
    v = v1;
    t += h;
  }
  return { events, stoppedAt: t };
}

interface Case {
  label: string;
  bodyId: string;
  r: Vec3;
  v: Vec3;
  grazing: boolean;
}

function buildCases(): Case[] {
  const rng = new Prng(20281105);
  const cases: Case[] = [];
  const muE = sys.body(EARTH).mu;
  const Rsoi = sys.body(MOON).soiRadius!;
  const RE = sys.body(EARTH).radius;
  // Translunar arrivals designed backwards from a chosen Moon-relative pass, then propagated back 2-3.5 days.
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99, 0.999, 0.9999, 0.99999, 1.00001, 1.0001, 1.001, 1.05, 0.6, 0.2, 0.4, 0.8, 0.9, 0.995];
  let k = 0;
  while (cases.length < fractions.length) {
    const f = fractions[k % fractions.length]!;
    k++;
    const tc = T0 + rng.range(2.5, 4) * 86400;
    const m = sys.stateRelParent(MOON, tc);
    const u = rng.range(0.7, 1.3) * 1000;
    // relative velocity: roughly against the Moon's motion with random tilt, like a translunar arrival
    const dir = v3.normalize(v3.add(v3.scale(v3.normalize(m.v), -0.7), { x: rng.range(-0.6, 0.6), y: rng.range(-0.6, 0.6), z: rng.range(-0.6, 0.6) }));
    const vrel = v3.scale(dir, u);
    const side = v3.normalize(v3.reject({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) }, dir));
    const rc = v3.add(m.r, v3.scale(side, f * Rsoi));
    const vc = v3.add(m.v, vrel);
    const back = makeOrbit(EARTH, muE, rc, vc, tc);
    const s = propagate(back, T0);
    // reject starts inside the SOI or trajectories that dip into the atmosphere on the way
    if (v3.dist(s.r, sys.stateRelParent(MOON, T0).r) < Rsoi * 1.05) continue;
    if (back.conic.p / (1 + back.conic.e) < RE + 1000e3) continue;
    cases.push({ label: `arrival f=${f}`, bodyId: EARTH, r: s.r, v: s.v, grazing: false });
  }
  // Genuinely grazing passes: the design offset is bisected until the TRUE minimum of |r - r_moon| - Rsoi
  // on the Earth conic (dense sampling + golden section, independent of the predictor) equals a depth.
  const depths = [-1, -20, -500, -5000, 2, 300];
  const pending = depths.slice();
  for (let attempt = 0; attempt < 60 && pending.length > 0; attempt++) {
    const depth = pending[0]!;
    const tc = T0 + rng.range(2.5, 3.5) * 86400;
    const m = sys.stateRelParent(MOON, tc);
    const dir = v3.normalize(v3.add(v3.scale(v3.normalize(m.v), -0.7), { x: rng.range(-0.5, 0.5), y: rng.range(-0.5, 0.5), z: rng.range(-0.5, 0.5) }));
    const vrel = v3.scale(dir, rng.range(0.8, 1.2) * 1000);
    const side = v3.normalize(v3.reject({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) }, dir));
    const conicFor = (f: number) => makeOrbit(EARTH, muE, v3.add(m.r, v3.scale(side, f * Rsoi)), v3.add(m.v, vrel), tc);
    const minD = (f: number): number => {
      const o = conicFor(f);
      const D = (t: number): number => v3.dist(propagate(o, t).r, sys.stateRelParent(MOON, t).r) - Rsoi;
      let tBest = tc;
      let dBest = Infinity;
      for (let t = tc - 1.5 * 86400; t <= tc + 1.5 * 86400; t += 120) {
        const d = D(t);
        if (d < dBest) {
          dBest = d;
          tBest = t;
        }
      }
      let lo = tBest - 120;
      let hi = tBest + 120;
      for (let i = 0; i < 60; i++) {
        const a = lo + (hi - lo) * 0.382;
        const b = lo + (hi - lo) * 0.618;
        if (D(a) < D(b)) hi = b;
        else lo = a;
      }
      return D(0.5 * (lo + hi));
    };
    let lo = 0.8;
    let hi = 1.2;
    if (!(minD(lo) < depth && minD(hi) > depth)) continue;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (minD(mid) < depth) lo = mid;
      else hi = mid;
    }
    const f = 0.5 * (lo + hi);
    const o = conicFor(f);
    const s = propagate(o, T0);
    if (o.conic.p / (1 + o.conic.e) < RE + 1000e3) continue;
    if (v3.dist(s.r, sys.stateRelParent(MOON, T0).r) < Rsoi * 1.05) continue;
    cases.push({ label: `graze ${depth} m`, bodyId: EARTH, r: s.r, v: s.v, grazing: true });
    pending.shift();
  }
  // TLI-like departures from a 185 km parking orbit (start right after the burn).
  const kM = sys.body(MOON).kepler!;
  for (let i = 0; i < 4; i++) {
    const rp = RE + 185e3;
    const ang = (i * Math.PI) / 2 + 0.3;
    const dirR = v3.add(v3.scale(kM.P, Math.cos(ang)), v3.scale(kM.Q, Math.sin(ang)));
    const vp = Math.sqrt(muE / rp) + 3130 + 15 * i;
    cases.push({ label: `tli ${i}`, bodyId: EARTH, r: v3.scale(dirR, rp), v: v3.scale(v3.cross(kM.normal, dirR), vp), grazing: false });
  }
  // Returns: lunar departures (hyperbolic and long ellipses) leaving the SOI.
  const muM = sys.body(MOON).mu;
  const RM = sys.body(MOON).radius;
  for (let i = 0; i < 8; i++) {
    const rr = RM + rng.range(50e3, 3000e3);
    const dirR = v3.normalize({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) });
    const t = v3.normalize(v3.reject({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) }, dirR));
    const vesc = Math.sqrt((2 * muM) / rr);
    const vv = vesc * rng.range(0.995, 1.6);
    const vel = v3.add(v3.scale(t, vv * Math.cos(0.3)), v3.scale(dirR, vv * Math.sin(0.3)));
    cases.push({ label: `return ${i}`, bodyId: MOON, r: v3.scale(dirR, rr), v: vel, grazing: false });
  }
  return cases;
}

describe('SOI transitions vs a patched-gravity RK4 reference', () => {
  it('match within 0.5 s for 32 trajectories (grazing included), with no missed encounter', () => {
    const cases = buildCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
    let compared = 0;
    let grazingEntries = 0;
    let worst = 0;
    for (const c of cases) {
      const { current } = predictPatches(sys, { bodyId: c.bodyId, r: c.r, v: c.v }, T0, [], { maxPatches: 8 });
      const last = current[current.length - 1]!;
      const tEnd = Math.min(last.tEnd, T0 + 12 * 86400);
      const ref = reference(c.bodyId, c.r, c.v, T0, tEnd);
      const predicted: Transition[] = [];
      for (const p of current) {
        if (p.endReason === 'soiEnter' && p.tEnd <= tEnd) predicted.push({ kind: 'enter', t: p.tEnd });
        if (p.endReason === 'soiExit' && p.tEnd <= tEnd) predicted.push({ kind: 'exit', t: p.tEnd });
      }
      const refEvents = ref.events.filter((e) => e.t <= tEnd - 1);
      const predEvents = predicted.filter((e) => e.t <= tEnd - 1);
      if (process.env['SIM_ORBITS_VERBOSE']) {
        const fmt = (e: Transition[]): string => e.map((x) => `${x.kind}@${((x.t - T0) / 3600).toFixed(3)}h`).join(' ');
        const dts = refEvents.map((e, i) => (predEvents[i] ? Math.abs(predEvents[i]!.t - e.t).toExponential(1) : 'missing')).join(' ');
        console.log(`${c.label.padEnd(18)} ref: ${fmt(refEvents)} | pred: ${fmt(predEvents)} | dt: ${dts} | patches: ${current.map((p) => p.endReason).join(',')}`);
      }
      expect(predEvents.map((e) => e.kind), c.label).toEqual(refEvents.map((e) => e.kind));
      for (let i = 0; i < refEvents.length; i++) {
        const dt = Math.abs(predEvents[i]!.t - refEvents[i]!.t);
        worst = Math.max(worst, dt);
        expect(dt, `${c.label} transition ${i}`).toBeLessThan(0.5);
        compared++;
        if (c.grazing && refEvents[i]!.kind === 'enter') grazingEntries++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(20);
    // the four inside-grazing designs (-1 m .. -5 km) must all be found by both
    expect(grazingEntries).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => c.grazing).length).toBe(6);
    expect(worst).toBeLessThan(0.5);
  });
});
