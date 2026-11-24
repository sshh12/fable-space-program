/**
 * Prediction at solar-system scale on the staged library (ARCHITECTURE 8.4; the audit's section 5.4):
 *  - a low-Earth departure with a 3,600 m/s node: Earth's SOI exit, then a heliocentric patch;
 *  - a heliocentric trajectory built to pass 4,000 km over Mars 120 days later: a Mars patch of non-zero length
 *    WITH its periapsis marker (the zero-length-patch defect of the 60-day horizon counted from the list start);
 *  - Phobos' 16.6 km sphere entered at 2 km/s relative; a Neptune approach finds Triton;
 *  - measured: the heliocentric predictPatches cost and the 32-body snapshot cost (SOLAR_SYSTEM_VERBOSE=1).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManeuverNode, Patch } from '../../../src/core/contracts/sim';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { predictPatches } from '../../../src/sim/orbit/patches';
import { brentRoot } from '../../../src/sim/orbit/roots';
import { loadStaged, utOf } from './fixtures';

let sys: BodySystem;
beforeAll(async () => {
  sys = (await loadStaged()).system;
});

const verbose = (s: string): void => {
  if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(s);
};
const describePatches = (ps: readonly Patch[]): string => ps.map((p) => `${p.bodyId}: ${p.endReason} ${((p.tEnd - p.tStart) / 86400).toFixed(3)} d`).join(' > ');

/**
 * A heliocentric (or planet-centred) state at t0 whose patched-conic future passes the child `childId` at
 * periapsis radius rp with excess speed vinf at `tPeri`: the flyby hyperbola about the child, run back to its
 * SOI entry, handed to the parent and run back on the parent's conic to t0.
 */
function aimedAt(childId: string, rp: number, vinf: number, tPeri: number, t0: number, tilt = 0.3): { bodyId: string; r: Vec3; v: Vec3 } {
  const child = sys.body(childId);
  const parentId = child.parentId!;
  const cs = sys.stateRelParent(childId, tPeri);
  // periapsis direction: perpendicular to the child's velocity, tilted out of its plane
  const n = v3.normalize(v3.cross(cs.r, cs.v));
  const along = v3.normalize(cs.v);
  const rHat = v3.normalize(v3.add(v3.scale(v3.normalize(v3.cross(along, n)), Math.cos(tilt)), v3.scale(n, Math.sin(tilt))));
  const vHat = v3.normalize(v3.cross(v3.cross(rHat, along), rHat));
  const vp = Math.sqrt(vinf * vinf + (2 * child.mu) / rp);
  const hyp = makeOrbit(childId, child.mu, v3.scale(rHat, rp), v3.scale(vHat, vp), tPeri);
  const soi = child.soiRadius!;
  const f = (dt: number): number => v3.len(propagate(hyp, tPeri - dt).r) - soi * 0.999;
  let hi = 1000;
  while (f(hi) < 0) hi *= 2;
  const dtIn = brentRoot(f, 0, hi, 1e-6);
  const tIn = tPeri - dtIn;
  const sIn = propagate(hyp, tIn);
  const cIn = sys.stateRelParent(childId, tIn);
  const parent = sys.body(parentId);
  const pOrbit = makeOrbit(parentId, parent.mu, v3.add(sIn.r, cIn.r), v3.add(sIn.v, cIn.v), tIn);
  const s0 = propagate(pOrbit, t0);
  return { bodyId: parentId, r: s0.r, v: s0.v };
}

describe('prediction at solar-system scale', () => {
  it('a low-Earth departure with a 3,600 m/s node: earth soiExit, then a heliocentric patch', () => {
    const ut = utOf(2031, 3, 1);
    const r = 6371e3 + 200e3;
    const vc = Math.sqrt(sys.body('earth').mu / r);
    const state = { bodyId: 'earth', r: { x: r, y: 0, z: 0 }, v: { x: 0, y: vc, z: 0 } };
    const node: ManeuverNode = { id: 'tmi', ut: ut + 600, dv: { prograde: 3600, normal: 0, radial: 0 } };
    const p = predictPatches(sys, state, ut, [node]);
    verbose(`LEO + 3,600 m/s: ${describePatches(p.planned)}`);
    expect(p.planned[0]!.bodyId).toBe('earth');
    expect(p.planned[0]!.endReason).toBe('soiExit');
    expect(p.planned[0]!.nextBodyId).toBe('sun');
    expect(p.planned[1]!.bodyId).toBe('sun');
    expect(p.planned[1]!.tEnd - p.planned[1]!.tStart).toBeGreaterThan(100 * 86400);
  });

  it('a trajectory built to pass 4,000 km over Mars 120 days later: a Mars patch of non-zero length with its periapsis marker', () => {
    const t0 = utOf(2031, 1, 10);
    const tPeri = t0 + 120 * 86400;
    const R = sys.body('mars').radius;
    const state = aimedAt('mars', R + 4000e3, 3000, tPeri, t0);
    const p = predictPatches(sys, state, t0, []);
    verbose(`Mars flyby: ${describePatches(p.current)}`);
    const i = p.current.findIndex((x) => x.bodyId === 'mars');
    expect(i).toBeGreaterThan(0);
    expect(p.current[i - 1]!.endReason).toBe('soiEnter');
    const mp = p.current[i]!;
    expect(mp.tEnd - mp.tStart).toBeGreaterThan(86400);
    const peri = mp.markers.find((m) => m.kind === 'periapsis')!;
    expect(peri).toBeDefined();
    expect(Math.abs(peri.altitude! - 4000e3)).toBeLessThan(1e3);
    // (the construction aims from 0.999 of the sphere; the hand-over at the sphere itself moves the periapsis by seconds)
    expect(Math.abs(peri.ut - tPeri)).toBeLessThan(5);
    expect(mp.endReason).toBe('soiExit');
  });

  it("Phobos' 16.6 km sphere is entered at 2 km/s relative", () => {
    const tPeri = utOf(2032, 5, 5, 3);
    const t0 = tPeri - 3600;
    const R = sys.body('phobos').radius;
    const state = aimedAt('phobos', R + 2000, 2000, tPeri, t0);
    expect(state.bodyId).toBe('mars');
    const p = predictPatches(sys, state, t0, []);
    verbose(`Phobos: ${describePatches(p.current)}`);
    const k = p.current.findIndex((x) => x.endReason === 'soiEnter' && x.nextBodyId === 'phobos');
    expect(k).toBeGreaterThanOrEqual(0);
    const pp = p.current[k + 1]!;
    expect(pp.bodyId).toBe('phobos');
    const peri = pp.markers.find((m) => m.kind === 'periapsis' || m.kind === 'impact')!;
    expect(Math.abs(peri.ut - tPeri)).toBeLessThan(0.5);
    // through the sphere in about 16 s
    expect(pp.tEnd - pp.tStart).toBeGreaterThan(5);
    expect(pp.tEnd - pp.tStart).toBeLessThan(30);
  });

  it('a Neptune approach finds Triton', () => {
    const tPeri = utOf(2045, 2, 2);
    const t0 = tPeri - 2 * 86400;
    const R = sys.body('triton').radius;
    const state = aimedAt('triton', R + 1000e3, 4000, tPeri, t0);
    expect(state.bodyId).toBe('neptune');
    const p = predictPatches(sys, state, t0, []);
    verbose(`Triton: ${describePatches(p.current)}`);
    expect(p.current.some((x) => x.endReason === 'soiEnter' && x.nextBodyId === 'triton')).toBe(true);
    const tp = p.current.find((x) => x.bodyId === 'triton')!;
    const peri = tp.markers.find((m) => m.kind === 'periapsis')!;
    expect(Math.abs(peri.altitude! - 1000e3)).toBeLessThan(1e3);
  });

  it('measured: heliocentric predictPatches (budget 20 ms) and the 32-body snapshot', () => {
    const ut = utOf(2031, 3, 1);
    const r = 6371e3 + 200e3;
    const vc = Math.sqrt(sys.body('earth').mu / r);
    const state = { bodyId: 'earth', r: { x: r, y: 0, z: 0 }, v: { x: 0, y: vc, z: 0 } };
    const node: ManeuverNode = { id: 'tmi', ut: ut + 600, dv: { prograde: 3600, normal: 0, radial: 0 } };
    const t0 = utOf(2031, 1, 10);
    const flyby = aimedAt('mars', sys.body('mars').radius + 4000e3, 3000, t0 + 120 * 86400, t0);
    const median = (f: () => void, n: number): number => {
      for (let i = 0; i < 3; i++) f();
      const ts: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = performance.now();
        f();
        ts.push(performance.now() - a);
      }
      ts.sort((x, y) => x - y);
      return ts[Math.floor(n / 2)]!;
    };
    const tDepart = median(() => predictPatches(sys, state, ut, [node]), 15);
    const tFlyby = median(() => predictPatches(sys, flyby, t0, []), 15);
    const tSnap = median(() => sys.buildBodySnapshots(ut), 200);
    verbose(`predictPatches LEO departure through the Sun's sphere: ${tDepart.toFixed(2)} ms; heliocentric Mars flyby: ${tFlyby.toFixed(2)} ms; buildBodySnapshots (32 bodies): ${(tSnap * 1000).toFixed(1)} us`);
    expect(tDepart).toBeLessThan(20);
    expect(tFlyby).toBeLessThan(20);
    expect(tSnap).toBeLessThan(1);
  });
});
