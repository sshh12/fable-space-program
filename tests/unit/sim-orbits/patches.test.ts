import { beforeAll, describe, expect, it } from 'vitest';
import type { ManeuverNode, Patch } from '../../../src/core/contracts/sim';
import { conicPosition, conicVelocity } from '../../../src/core/math/conic';
import { quat } from '../../../src/core/math/quat';
import { DEG, RAD, TWO_PI } from '../../../src/core/math/scalar';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { conicStateAtTime, makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { estimateBurnTime, nodeBurnInfo, nodeDeltaVInertial } from '../../../src/sim/orbit/maneuver';
import { patchOrbit, predictPatches, predictPatchesWithOrbits, stateOnPatches } from '../../../src/sim/orbit/patches';
import { nextWarpEvent } from '../../../src/sim/orbit/warp';
import { meanAnomalyFromTrue } from '../../../src/sim/orbit/anomaly';
import { computeOrbitalReadouts } from '../../../src/sim/nav/readouts';
import { loadWorld, mainIds, utOf } from './fixtures';

let sys: BodySystem;
let EARTH = '';
let MOON = '';
const T0 = utOf(2028, 3, 1);

beforeAll(async () => {
  ({ system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON } = mainIds(sys));
});

/** Circular orbit of radius rc about `bodyId`, in the plane with normal n, starting along unit direction d. */
function circular(bodyId: string, rc: number, n: Vec3, d: Vec3): { bodyId: string; r: Vec3; v: Vec3 } {
  const mu = sys.body(bodyId).mu;
  const dir = v3.normalize(v3.reject(d, n));
  return { bodyId, r: v3.scale(dir, rc), v: v3.scale(v3.cross(n, dir), Math.sqrt(mu / rc)) };
}

const node = (id: string, ut: number, prograde: number, normal = 0, radial = 0): ManeuverNode => ({ id, ut, dv: { prograde, normal, radial } });

function marker(p: Patch | undefined, kind: string) {
  return p?.markers.find((m) => m.kind === kind);
}

describe('trans-lunar injection and lunar capture', () => {
  let parking: { bodyId: string; r: Vec3; v: Vec3 };
  let best: { tNode: number; planned: Patch[] } | null = null;

  beforeAll(() => {
    const k = sys.body(MOON).kepler!;
    const R = sys.body(EARTH).radius;
    parking = circular(EARTH, R + 185e3, k.normal, k.P);
    const P = makeOrbit(EARTH, sys.body(EARTH).mu, parking.r, parking.v, T0).period!;
    let bestErr = Infinity;
    for (let i = 0; i < 180; i++) {
      const tNode = T0 + 600 + (P * i) / 180;
      const { planned } = predictPatches(sys, parking, T0, [node('tli', tNode, 3150)]);
      const moonPatch = planned[1];
      const pe = marker(moonPatch, 'periapsis');
      if (planned[0]?.endReason !== 'soiEnter' || moonPatch?.bodyId !== MOON || !pe) continue;
      const err = Math.abs(pe.altitude! - 100e3);
      if (pe.altitude! > 20e3 && err < bestErr) {
        bestErr = err;
        best = { tNode, planned };
      }
    }
  });

  it('a ~3,150 m/s prograde node at the right phase gives Earth -> Moon with a perilune marker', () => {
    expect(best).not.toBeNull();
    const [earthPatch, moonPatch] = best!.planned;
    expect(earthPatch!.bodyId).toBe(EARTH);
    expect(earthPatch!.endReason).toBe('soiEnter');
    expect(earthPatch!.nextBodyId).toBe(MOON);
    expect(earthPatch!.afterNodeId).toBe('tli');
    expect(marker(earthPatch, 'soiEnter')).toBeDefined();
    expect(moonPatch!.bodyId).toBe(MOON);
    expect(moonPatch!.tStart).toBe(earthPatch!.tEnd);
    const pe = marker(moonPatch, 'periapsis')!;
    expect(pe.altitude!).toBeGreaterThan(20e3);
    expect(pe.altitude!).toBeLessThan(3000e3);
    // continuity of the ROOT-frame state across the SOI boundary
    const tx = earthPatch!.tEnd;
    const a = propagate(patchOrbit(earthPatch!), tx);
    const b = propagate(patchOrbit(moonPatch!), tx);
    const m = sys.stateRelParent(MOON, tx);
    expect(v3.dist(a.r, v3.add(b.r, m.r))).toBeLessThan(1e-3);
    expect(v3.dist(a.v, v3.add(b.v, m.v))).toBeLessThan(1e-6);
    // bodyPosAtEnd is the ROOT position of the patch body at tEnd
    expect(v3.dist(moonPatch!.bodyPosAtEnd, sys.stateRoot(MOON, moonPatch!.tEnd).r)).toBe(0);
  });

  it('the current (node-free) trajectory stays the parking orbit with the node marked on it', () => {
    const P = makeOrbit(EARTH, sys.body(EARTH).mu, parking.r, parking.v, T0).period!;
    for (const tNode of [T0 + 0.5 * P, T0 + 1.5 * P]) {
      const { current } = predictPatches(sys, parking, T0, [node('tli', tNode, 3150)]);
      expect(current).toHaveLength(1);
      const c = current[0]!;
      if (tNode <= T0 + P) {
        // node within the first revolution: a full closed ellipse, node marked on it
        expect(c.endReason).toBe('closed');
        expect(c.nuEnd - c.nuStart).toBeCloseTo(TWO_PI, 12);
      } else {
        // node beyond one revolution: followed to the node
        expect(c.endReason).toBe('maneuver');
        expect(c.tEnd).toBe(tNode);
        expect((c.nuEnd - c.nuStart) / TWO_PI).toBeCloseTo(1.5, 9);
      }
      const mk = marker(c, 'maneuverNode')!;
      expect(mk.nodeId).toBe('tli');
      expect(mk.ut).toBe(tNode);
    }
  });

  it('a retrograde node at perilune gives a closed lunar patch', () => {
    const moonPatch = best!.planned[1]!;
    const pe = marker(moonPatch, 'periapsis')!;
    const c = moonPatch.conic;
    const rp = c.p / (1 + c.e);
    const vp = Math.sqrt(c.mu / c.p) * (1 + c.e);
    const dv = -(vp - Math.sqrt(c.mu / rp));
    const nodes = [node('tli', best!.tNode, 3150), node('loi', pe.ut, dv)];
    const { planned } = predictPatches(sys, parking, T0, nodes);
    expect(planned.map((p) => p.bodyId)).toEqual([EARTH, MOON, MOON]);
    expect(planned[1]!.endReason).toBe('maneuver');
    expect(planned[1]!.tEnd).toBe(pe.ut);
    expect(marker(planned[1], 'maneuverNode')!.nodeId).toBe('loi');
    const lunar = planned[2]!;
    expect(lunar.afterNodeId).toBe('loi');
    expect(lunar.endReason).toBe('closed');
    expect(lunar.conic.e).toBeLessThan(1e-6);
    expect(marker(lunar, 'apoapsis')).toBeDefined();
  });

  it('with the Moon as target: AN/DN and closest-approach markers, encounter replaces closest approach', () => {
    const { current, planned } = predictPatches(sys, parking, T0, [node('tli', best!.tNode, 3150)], { targetBodyId: MOON });
    // parking orbit is in the Moon's plane: nodes undefined (coplanar), closest approach present
    expect(marker(current[0], 'ascendingNode')).toBeUndefined();
    expect(marker(current[0], 'closestApproach')).toBeDefined();
    // the transfer patch enters the Moon's SOI: no closest-approach marker there
    expect(marker(planned[0], 'closestApproach')).toBeUndefined();
    // an inclined orbit gets AN and DN at the relative inclination
    const k = sys.body(MOON).kepler!;
    const tilted = v3.normalize(v3.add(k.normal, v3.scale(k.P, Math.tan(10 * DEG))));
    const inc = circular(EARTH, sys.body(EARTH).radius + 300e3, tilted, k.Q);
    const p = predictPatches(sys, inc, T0, [], { targetBodyId: MOON }).current[0]!;
    const an = marker(p, 'ascendingNode')!;
    const dn = marker(p, 'descendingNode')!;
    expect(an.value! * RAD).toBeCloseTo(10, 6);
    expect(dn.value! * RAD).toBeCloseTo(10, 6);
    // at the AN the vessel crosses the Moon's plane northward (toward +normal)
    const s = propagate(patchOrbit(p), an.ut);
    expect(Math.abs(v3.dot(v3.normalize(s.r), k.normal))).toBeLessThan(1e-9);
    expect(v3.dot(s.v, k.normal)).toBeGreaterThan(0);
  });
});

describe('return from the Moon with an atmosphere-entry marker', () => {
  let found: { planned: Patch[]; state: { bodyId: string; r: Vec3; v: Vec3 }; nodes: ManeuverNode[] } | null = null;

  beforeAll(() => {
    const k = sys.body(MOON).kepler!;
    const lunar = circular(MOON, sys.body(MOON).radius + 100e3, k.normal, k.P);
    const P = makeOrbit(MOON, sys.body(MOON).mu, lunar.r, lunar.v, T0).period!;
    const dv = 840;
    const hOf = (phase: number): number | null => {
      const nodes = [node('tei', T0 + 300 + phase * P, dv)];
      const { planned } = predictPatches(sys, lunar, T0, nodes);
      if (planned[0]?.endReason !== 'soiExit' || !planned[1]) return null;
      return v3.dot(v3.scale(planned[1].conic.W, Math.sqrt(planned[1].conic.mu * planned[1].conic.p)), k.normal);
    };
    const target = Math.sqrt(2 * sys.body(EARTH).mu * (sys.body(EARTH).radius + 50e3));
    let prevPhase = 0;
    let prevH = hOf(0);
    for (let i = 1; i <= 180 && !found; i++) {
      const phase = i / 180;
      const h = hOf(phase);
      if (h !== null && prevH !== null && (h - target) * (prevH - target) < 0) {
        let lo = prevPhase;
        let hi = phase;
        const flo = prevH - target;
        for (let j = 0; j < 50; j++) {
          const mid = 0.5 * (lo + hi);
          const fm = hOf(mid);
          if (fm === null) break;
          if ((fm - target) * flo > 0) lo = mid;
          else hi = mid;
        }
        const nodes = [node('tei', T0 + 300 + lo * P, dv)];
        const { planned } = predictPatches(sys, lunar, T0, nodes);
        if (planned[1]?.endReason === 'atmosphere') found = { planned, state: lunar, nodes };
      }
      prevPhase = phase;
      prevH = h;
    }
  });

  it('yields Moon -> Earth ending with an atmosphereEntry marker', () => {
    expect(found).not.toBeNull();
    const [moonPatch, earthPatch] = found!.planned;
    expect(moonPatch!.bodyId).toBe(MOON);
    expect(moonPatch!.endReason).toBe('soiExit');
    expect(moonPatch!.nextBodyId).toBe(EARTH);
    expect(marker(moonPatch, 'soiExit')).toBeDefined();
    expect(earthPatch!.bodyId).toBe(EARTH);
    expect(earthPatch!.endReason).toBe('atmosphere');
    const m = marker(earthPatch, 'atmosphereEntry')!;
    expect(m.altitude!).toBeCloseTo(sys.body(EARTH).def.atmosphere!.simTop, 3);
    expect(m.value!).toBeGreaterThan(10.5e3);
    expect(m.value!).toBeLessThan(11.2e3);
    expect(m.flightPathAngle!).toBeLessThan(0);
    expect(m.vacuumPeriapsisAltitude!).toBeLessThan(140e3);
  });

  it('entry latitude/longitude equal an independent propagation and Earth rotation within 0.01 deg', () => {
    const [moonPatch, earthPatch] = found!.planned;
    const m = marker(earthPatch, 'atmosphereEntry')!;
    // independent: Moon-patch end state + Moon ephemeris at the exit, two-body propagation to the marker time
    const tx = moonPatch!.tEnd;
    const sx = propagate(patchOrbit(moonPatch!), tx);
    const ms = sys.stateRelParent(MOON, tx);
    const o = makeOrbit(EARTH, sys.body(EARTH).mu, v3.add(sx.r, ms.r), v3.add(sx.v, ms.v), tx);
    const r = propagate(o, m.ut).r;
    const gmst = ((280.46061837 + 360.98564736629 * (m.ut / 86400)) % 360) * DEG;
    const x = Math.cos(gmst) * r.x + Math.sin(gmst) * r.y;
    const y = -Math.sin(gmst) * r.x + Math.cos(gmst) * r.y;
    const lat = Math.atan2(r.z, Math.hypot(x, y));
    const lon = Math.atan2(y, x);
    expect(Math.abs(lat - m.latitude!) * RAD).toBeLessThan(0.01);
    const dLon = Math.atan2(Math.sin(lon - m.longitude!), Math.cos(lon - m.longitude!));
    expect(Math.abs(dLon) * RAD).toBeLessThan(0.01);
    if (process.env["SIM_ORBITS_VERBOSE"]) console.log("entry lat/lon error deg", Math.abs(lat - m.latitude!) * RAD, Math.abs(dLon) * RAD);
    expect(Math.abs(v3.len(r) - (sys.body(EARTH).radius + 140e3))).toBeLessThan(1);
  });

  it('impact on an airless body carries body-fixed latitude/longitude', () => {
    const R = sys.body(MOON).radius;
    // 100 km x (-20 km) lunar orbit: hits the reference sphere
    const rA = R + 100e3;
    const rP = R - 20e3;
    const a = (rA + rP) / 2;
    const vA = Math.sqrt(sys.body(MOON).mu * (2 / rA - 1 / a));
    const state = { bodyId: MOON, r: { x: rA, y: 0, z: 0 }, v: { x: 0, y: vA, z: 0 } };
    const { current } = predictPatches(sys, state, T0, []);
    expect(current).toHaveLength(1);
    expect(current[0]!.endReason).toBe('impact');
    const imp = marker(current[0], 'impact')!;
    // no height function: the reference sphere, found analytically
    expect(Math.abs(v3.len(imp.r) - R)).toBeLessThan(1e-3);
    expect(imp.altitude).toBe(0);
    const fixed = quat.rotateInv(sys.orientation(MOON, imp.ut), imp.r);
    expect(imp.latitude!).toBeCloseTo(Math.atan2(fixed.z, Math.hypot(fixed.x, fixed.y)), 12);
    expect(imp.longitude!).toBeCloseTo(Math.atan2(fixed.y, fixed.x), 12);
  });

  it('terrain march finds the first contact with a coarse height function', () => {
    const R = sys.body(MOON).radius;
    const rA = R + 100e3;
    const rP = R + 3e3;
    const a = (rA + rP) / 2;
    const vA = Math.sqrt(sys.body(MOON).mu * (2 / rA - 1 / a));
    const state = { bodyId: MOON, r: { x: rA, y: 0, z: 0 }, v: { x: 0, y: vA, z: 0 } };
    // a 5 km plateau everywhere: the 3 km periapsis is below it
    const flat = predictPatches(sys, state, T0, [], { terrainHeight: () => 5000 }).current[0]!;
    expect(flat.endReason).toBe('impact');
    const imp = marker(flat, 'impact')!;
    expect(imp.altitude).toBe(5000);
    expect(Math.abs(v3.len(imp.r) - (R + 5000))).toBeLessThan(0.01 * 600);
    // flat 1 km terrain: no impact, the orbit stays closed
    const low = predictPatches(sys, state, T0, [], { terrainHeight: () => 1000 }).current[0]!;
    expect(low.endReason).toBe('closed');
  });
});

describe('multi-revolution maneuver nodes', () => {
  const mk = (e: number, nu0: number, t0: number) => {
    const mu = sys.body(EARTH).mu;
    const rp = sys.body(EARTH).radius + 300e3;
    const p = rp * (1 + e);
    return makeOrbit(EARTH, mu, conicPosition({ mu, p, e, a: 0, P: v3.unitX(), Q: v3.unitY(), W: v3.unitZ(), tPeriapsis: 0, period: null, inc: 0, lan: 0, argPe: 0 }, nu0), conicVelocity({ mu, p, e, a: 0, P: v3.unitX(), Q: v3.unitY(), W: v3.unitZ(), tPeriapsis: 0, period: null, inc: 0, lan: 0, argPe: 0 }, nu0), t0);
  };

  function check(orbitEpoch: number, ut: number, revs: number, e: number): void {
    const o = mk(e, 0.4, orbitEpoch);
    const s = propagate(o, ut);
    const P = o.period!;
    const n = node('far', ut + revs * P, 25);
    const { current, planned } = predictPatches(sys, { bodyId: EARTH, ...s }, ut, [n]);
    expect(current).toHaveLength(1);
    const c = current[0]!;
    expect(c.endReason).toBe('maneuver');
    expect(c.tEnd).toBe(n.ut);
    const k = Math.floor(revs);
    const nuNode = Math.atan2(v3.dot(propagate(o, n.ut).r, v3.unitY()), v3.dot(propagate(o, n.ut).r, v3.unitX()));
    const nuStart = Math.atan2(s.r.y, s.r.x);
    let frac = nuNode - nuStart;
    frac -= TWO_PI * Math.floor(frac / TWO_PI);
    const expected = e === 0 ? revs * TWO_PI : k * TWO_PI + frac;
    expect(Math.abs(c.nuEnd - c.nuStart - expected)).toBeLessThan(1e-6);
    expect(marker(c, 'maneuverNode')!.nodeId).toBe('far');
    // planned starts at the node with the node's delta-v applied
    expect(planned.length).toBeGreaterThan(0);
    expect(planned[0]!.tStart).toBe(n.ut);
    expect(planned[0]!.afterNodeId).toBe('far');
    const pre = stateOnPatches(current, n.ut)!;
    const post = propagate(patchOrbit(planned[0]!), n.ut);
    const dvI = nodeDeltaVInertial(n.dv, pre.r, pre.v);
    expect(v3.dist(v3.add(pre.v, dvI), post.v)).toBeLessThan(1e-6);
    expect(v3.len(dvI)).toBeCloseTo(25, 9);
    // nodeBurn timing inputs
    const engine = { mass: 20000, thrust: 1e5, isp: 450, availableDeltaV: 3000 };
    const info = nodeBurnInfo(n, dvI, ut, engine);
    const bt = estimateBurnTime(25, 20000, 1e5, 450);
    expect(info.timeToNode).toBeCloseTo(revs * P, 6);
    expect(info.burnTime).toBeCloseTo(bt, 12);
    expect(info.timeToBurnStart!).toBeCloseTo(n.ut - bt / 2 - ut, 6);
    expect(info.insufficientDeltaV).toBe(false);
    // the warp look-ahead reports the node, however many revolutions ahead
    // (5x: its 140 km altitude limit is below this 300 km perigee, so only the node limits warp)
    const ev = nextWarpEvent({ system: sys, ut, bodyId: EARTH, r: s.r, v: s.v, patches: current, nodes: [{ node: n, burnTime: bt }], warpIndex: 4 });
    expect(ev?.kind).toBe('node');
    expect(ev!.ut).toBeCloseTo(n.ut - bt / 2 - 30, 6);
  }

  it('node 3.4 periods ahead on a circular orbit', () => check(T0, T0, 3.4, 0));
  it('node 3.4 periods ahead on an eccentric orbit', () => check(T0, T0, 3.4, 0.2));
  it('same with the orbit epoch far in the past', () => check(T0 - 1e7, T0, 3.4, 0.2));
  it('node 1000.4 periods ahead of the patch start (patch started long before the node)', () => check(T0, T0, 1000.4, 0));
});

describe('prediction edge cases', () => {
  it('past nodes are ignored and an unreachable node leaves planned empty', () => {
    const R = sys.body(MOON).radius;
    const rA = R + 100e3;
    const rP = R - 50e3;
    const a = (rA + rP) / 2;
    const vA = Math.sqrt(sys.body(MOON).mu * (2 / rA - 1 / a));
    const state = { bodyId: MOON, r: { x: rA, y: 0, z: 0 }, v: { x: 0, y: vA, z: 0 } };
    const p = predictPatches(sys, state, T0, [node('old', T0 - 10, 50), node('late', T0 + 1e6, 50)]);
    expect(p.current[0]!.endReason).toBe('impact');
    expect(p.planned).toEqual([]);
  });

  it('hyperbolic escape from the Moon ends with soiExit then an Earth patch', () => {
    const R = sys.body(MOON).radius;
    const r = R + 200e3;
    const v = Math.sqrt((2 * sys.body(MOON).mu) / r) * 1.2;
    const { current } = predictPatches(sys, { bodyId: MOON, r: { x: r, y: 0, z: 0 }, v: { x: 0, y: v, z: 0 } }, T0, []);
    expect(current[0]!.endReason).toBe('soiExit');
    expect(current[0]!.conic.e).toBeGreaterThan(1);
    expect(current[1]!.bodyId).toBe(EARTH);
    // the true anomaly increases monotonically along an open patch
    expect(current[0]!.nuEnd).toBeGreaterThan(current[0]!.nuStart);
    // the periapsis of a hyperbola that starts at periapsis is on the patch
    expect(marker(current[0], 'periapsis')!.ut).toBeCloseTo(T0, 3);
  });

  it('a state just outside the SOI moving out exits immediately; just inside moving in does not', () => {
    const soi = sys.body(MOON).soiRadius!;
    const out = predictPatches(sys, { bodyId: MOON, r: { x: soi * 1.000001, y: 0, z: 0 }, v: { x: 800, y: 300, z: 0 } }, T0, []);
    expect(out.current[0]!.endReason).toBe('soiExit');
    expect(out.current[0]!.tEnd).toBe(T0);
    expect(out.current[1]!.bodyId).toBe(EARTH);
    // the Earth patch must not re-enter the Moon immediately (hysteresis + outward motion)
    expect(out.current[1]!.tEnd - out.current[1]!.tStart).toBeGreaterThan(1000);
  });

  it('radial trajectories (dropped from rest, straight up): exact impact time and apoapsis', () => {
    const mu = sys.body(MOON).mu;
    const R = sys.body(MOON).radius;
    // drop from rest at 2 km: radial Kepler fall time t = sqrt(r0^3 / 2mu) (sqrt(x(1 - x)) + acos(sqrt(x))), x = R/r0
    const r0 = R + 2000;
    const x = R / r0;
    const tFall = Math.sqrt((r0 * r0 * r0) / (2 * mu)) * (Math.sqrt(x * (1 - x)) + Math.acos(Math.sqrt(x)));
    const drop = predictPatches(sys, { bodyId: MOON, r: { x: 0, y: 0, z: r0 }, v: v3.zero() }, T0, []).current;
    expect(drop[0]!.endReason).toBe('impact');
    expect(drop[0]!.tEnd - T0).toBeCloseTo(tFall, 6);
    // straight up at 1 km/s from the surface: apoapsis from the energy, back down at the same time by symmetry
    const v0 = 1000;
    const up = predictPatches(sys, { bodyId: MOON, r: { x: 0, y: 0, z: R + 1 }, v: { x: 0, y: 0, z: v0 } }, T0, []).current[0]!;
    const ra = mu / (mu / (R + 1) - (v0 * v0) / 2);
    const ap = up.markers.find((m) => m.kind === 'apoapsis')!;
    expect(ap.altitude! + R).toBeCloseTo(ra, 3);
    expect(up.endReason).toBe('impact');
    // impact on the reference sphere, 1 m below the start: 1 m / 1 km/s later than the mirror time
    expect(up.tEnd - T0 - 2 * (ap.ut - T0)).toBeCloseTo(1 / v0, 5);
    const ro = computeOrbitalReadouts({ system: sys, bodyId: MOON, r: { x: 0, y: 0, z: R + 1 }, v: { x: 0, y: 0, z: v0 }, ut: T0 });
    expect(ro.apoapsisAltitude + R).toBeCloseTo(ra, 3);
    expect(ro.timeToApoapsis!).toBeCloseTo(ap.ut - T0, 3);
  });

  it('radial and near-radial patches: self-consistent conic, stateOnPatches never throws and matches the exact propagation', () => {
    const M = sys.body(MOON);
    const E = sys.body(EARTH);
    const pole = M.radius + 2000;
    const cases: { body: string; r: Vec3; v: Vec3; radial: boolean }[] = [
      { body: MOON, r: { x: 0, y: 0, z: pole }, v: v3.zero(), radial: true }, // hover / drop at the lunar pole
      { body: MOON, r: { x: 0, y: 0, z: M.radius + 1 }, v: { x: 0, y: 0, z: 1000 }, radial: true }, // straight up, falls back
      { body: MOON, r: { x: 0, y: 0, z: M.radius + 1 }, v: { x: 0, y: 0, z: 3000 }, radial: true }, // radial escape (hyperbolic)
      { body: EARTH, r: { x: 3e8, y: 0, z: 0 }, v: { x: -100, y: 0, z: 0 }, radial: true }, // radial fall from far out
      ...[1e-7, 1e-5, 1e-3, 0.01, 1].map((vt) => ({ body: MOON, r: { x: 0, y: 0, z: pole }, v: { x: vt, y: 0, z: 0 }, radial: false })),
      { body: MOON, r: { x: 0, y: 0, z: M.radius + 1 }, v: { x: 0.01, y: 0, z: 3000 }, radial: false },
      { body: EARTH, r: { x: 0, y: 1e7, z: 0 }, v: { x: 1e-6, y: -50, z: 0 }, radial: false },
    ];
    for (const c of cases) {
      const mu = sys.body(c.body).mu;
      const o = makeOrbit(c.body, mu, c.r, c.v, T0);
      expect(o.radial).toBe(c.radial);
      expect(o.nearRadial).toBe(true);
      const k = o.conic;
      // conic: a from the energy, period non-null exactly when e < 1 (bound near-radial: e strictly below 1)
      expect(k.a).toBeCloseTo(1 / o.alpha, 6);
      if (o.alpha > 0 && !c.radial) expect(k.e).toBeLessThan(1);
      if (o.alpha < 0) expect(k.e).toBeGreaterThanOrEqual(1);
      expect(k.period).toBe(k.e < 1 ? o.period : null);
      if (c.radial) {
        expect(k.e).toBe(1);
        expect(k.p).toBe(0);
        expect(v3.dist(k.P, v3.neg(v3.normalize(c.r)))).toBeLessThan(1e-15);
      }
      const items = predictPatchesWithOrbits(sys, { bodyId: c.body, r: c.r, v: c.v }, T0, []).current;
      const patches = items.map((x) => x.patch);
      const first = patches[0]!;
      if (c.radial) {
        expect(first.nuStart).toBe(Math.PI);
        expect(first.nuEnd).toBe(Math.PI);
      }
      // the patch conic alone rebuilds the trajectory (time form from the periapsis passage): sub-mm
      for (let i = 0; i < items.length; i++) {
        const p = items[i]!.patch;
        expect(() => patchOrbit(p)).not.toThrow();
        for (let j = 0; j <= 16; j++) {
          const t = p.tStart + ((p.tEnd - p.tStart) * j) / 16;
          const exact = propagate(items[i]!.orbit, t);
          const s = stateOnPatches(patches, t)!;
          if (s.patchIndex !== i) continue;
          expect(v3.dist(s.r, exact.r)).toBeLessThan(1e-3);
          expect(v3.dist(s.v, exact.v)).toBeLessThan(1e-5);
          // with the orbits passed, the state is the exact propagation itself
          const w = stateOnPatches(items, t)!;
          expect(w.r).toEqual(exact.r);
          expect(w.v).toEqual(exact.v);
        }
      }
      // conicStateAtTime from the conic agrees with the epoch state at the epoch, to |v| x ~1e-7 s (the
      // resolution of t - tPeriapsis at ut ~ 9e8 s)
      const s0 = conicStateAtTime(k, T0);
      expect(v3.dist(s0.r, c.r)).toBeLessThan(2e-7 * v3.len(c.v) + 1e-5);
      expect(v3.dist(s0.v, c.v)).toBeLessThan(1e-6);
    }
    // the reviewer's case: 0.01 m/s tangential, 10 s after the start (was 6.75 m off)
    const nr = predictPatches(sys, { bodyId: MOON, r: { x: 0, y: 0, z: pole }, v: { x: 0.01, y: 0, z: 0 } }, T0, []).current;
    const exact = propagate(makeOrbit(MOON, M.mu, { x: 0, y: 0, z: pole }, { x: 0.01, y: 0, z: 0 }, T0), T0 + 10);
    expect(v3.dist(stateOnPatches(nr, T0 + 10)!.r, exact.r)).toBeLessThan(1e-4);
    // ordinary conics keep the true-anomaly reconstruction (exact to rounding)
    const leo = predictPatchesWithOrbits(sys, { bodyId: EARTH, r: { x: E.radius + 300e3, y: 0, z: 0 }, v: { x: 0, y: 7700, z: 100 } }, T0, []).current[0]!;
    const tq = leo.patch.tStart + 1234.5;
    expect(v3.dist(propagate(patchOrbit(leo.patch), tq).r, propagate(leo.orbit, tq).r)).toBeLessThan(1e-6);
  });

  it('orbit inside the atmosphere going up: vacuum conic re-enters (atmosphere) or impacts', () => {
    const R = sys.body(EARTH).radius;
    const up = { bodyId: EARTH, r: { x: R + 80e3, y: 0, z: 0 }, v: { x: 2000, y: 7200, z: 0 } };
    const p = predictPatches(sys, up, T0, []).current;
    expect(p[0]!.endReason).toBe('atmosphere');
    const low = { bodyId: EARTH, r: { x: R + 50e3, y: 0, z: 0 }, v: { x: 1000, y: 2000, z: 0 } };
    const q = predictPatches(sys, low, T0, []).current;
    expect(q[0]!.endReason).toBe('impact');
    expect(marker(q[0], 'impact')!.latitude).toBeDefined();
  });
});

// keep the helper used (mean anomaly relation sanity)
it('mean anomaly relation is odd and monotonic', () => {
  let prev = -Infinity;
  for (let nu = -3.1; nu <= 3.1; nu += 0.1) {
    const M = meanAnomalyFromTrue(0.3, nu);
    expect(M).toBeGreaterThan(prev);
    expect(meanAnomalyFromTrue(0.3, -nu)).toBeCloseTo(-M, 12);
    prev = M;
  }
});
