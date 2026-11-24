/**
 * The transfer pilot's own arithmetic (src/pilot/generic/transferMath.ts; the pilot imports src/core only, so it
 * carries its own copy) held against the simulation's: its Lambert solver against src/sim/orbit/lambert.ts, the
 * bodies' osculating conics of the snapshot against the ephemeris, the 3-D periapsis ejection against the
 * asymptote it is built for, and its window against src/sim/nav/transfer.ts's porkchop with the same cost.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { BodySnapshot } from '../../../src/core/contracts/sim';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import { bestWindow, bodyStateAt, ejectionBurn, ejectionDeltaV, lambert, meanOrbit, positionOnConic, synodic } from '../../../src/pilot/generic/transferMath';
import { conicFromState } from '../../../src/core/math/conic';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { solveLambert } from '../../../src/sim/orbit/lambert';
import { bestTransfer } from '../../../src/sim/nav/transfer';
import { loadStaged, utOf, type World } from './fixtures';

let w: World;
beforeAll(async () => {
  w = await loadStaged();
});

const AU = 149597870700;
const MU_SUN = 1.32712440041279e20;
const MU_EARTH = 3.986004418e14;

describe("the transfer pilot's arithmetic", () => {
  it('its Lambert solver gives the simulation solver’s velocities', () => {
    const r1 = { x: AU, y: 0, z: 0 };
    const z = { x: 0, y: 0, z: 1 };
    for (const [r2, tof] of [
      [{ x: -1.2 * AU, y: 0.8 * AU, z: 0.05 * AU }, 200 * 86400],
      [{ x: 0.2 * AU, y: 1.4 * AU, z: -0.02 * AU }, 90 * 86400],
      [{ x: 0.5 * AU, y: -1.3 * AU, z: 0.1 * AU }, 300 * 86400],
      [{ x: 0.3 * AU, y: 0.9 * AU, z: 0 }, 5 * 86400],
    ] as const) {
      const a = lambert(MU_SUN, r1, r2, tof, z)!;
      const b = solveLambert(MU_SUN, r1, r2, tof, true, z)!;
      expect(v3.len(v3.sub(a.v1, b.v1))).toBeLessThan(1e-3);
      expect(v3.len(v3.sub(a.v2, b.v2))).toBeLessThan(1e-3);
    }
  });

  it("a body's osculating conic from the snapshot stays on the ephemeris to a few parts in 1e5 over a transfer", () => {
    const t0 = utOf(2031, 1, 1);
    const snaps = w.system.buildBodySnapshots(t0);
    const by = (id: string): BodySnapshot => snaps.find((b) => b.id === id)!;
    for (const [id, days] of [
      ['mars', 210],
      ['venus', 130],
      ['jupiter', 900],
    ] as const) {
      const t = t0 + days * 86400;
      const p = bodyStateAt(by(id), by('sun'), t).r;
      const truth = w.system.stateRelative(id, 'sun', t).r;
      expect(v3.len(v3.sub(p, truth)) / v3.len(truth), id).toBeLessThan(1e-3);
      expect(v3.len(v3.sub(bodyStateAt(by(id), by('sun'), t0).r, w.system.stateRelative(id, 'sun', t0).r))).toBeLessThan(1);
    }
  });

  it('a hyperbola from its periapsis state is where Kepler puts it', () => {
    const rp = 6.578e6;
    const vp = Math.sqrt(3000 * 3000 + (2 * MU_EARTH) / rp);
    const r = { x: rp, y: 0, z: 0 };
    const v = { x: 0, y: vp * 0.8, z: vp * 0.6 };
    const c = conicFromState(MU_EARTH, r, v, 1000);
    const o = makeOrbit('earth', MU_EARTH, r, v, 1000);
    for (const t of [1000, 5000, 50000, 200000]) expect(v3.len(v3.sub(positionOnConic(c, t), propagate(o, t).r))).toBeLessThan(1);
  });

  it('the periapsis ejection leaves on the asymptote it is built for; in the plane it costs the coplanar burn', () => {
    const rp = 6.578e6;
    const vc = Math.sqrt(MU_EARTH / rp);
    const inc = (28 * Math.PI) / 180;
    const r = { x: rp, y: 0, z: 0 };
    const v = { x: 0, y: vc * Math.cos(inc), z: vc * Math.sin(inc) };
    const W = v3.normalize(v3.cross(r, v));
    for (const [vinf, outOfPlaneDeg] of [
      [3600, 0],
      [3600, 12],
      [4200, -25],
    ] as const) {
      // an asymptote at the stated angle to the parking plane
      const inPlane = v3.normalize(v3.add({ x: 0.3, y: 0.7, z: 0 }, { x: 0, y: 0, z: 0 }));
      const ip = v3.normalize(v3.reject(inPlane, W));
      const a = (outOfPlaneDeg * Math.PI) / 180;
      const s: Vec3 = v3.add(v3.scale(ip, Math.cos(a)), v3.scale(W, Math.sin(a)));
      const b = ejectionBurn(MU_EARTH, r, v, v3.scale(s, vinf), 0)!;
      expect(b).not.toBeNull();
      // state at the burn: on the circular orbit dt later, plus the burn in the node frame
      const o = makeOrbit('earth', MU_EARTH, r, v, 0);
      const at = propagate(o, b.dt);
      const pro = v3.normalize(at.v);
      const nrm = v3.normalize(v3.cross(at.r, at.v));
      const rad = v3.cross(pro, nrm);
      const after = v3.add(at.v, v3.add(v3.scale(pro, b.prograde), v3.add(v3.scale(nrm, b.normal), v3.scale(rad, b.radial))));
      const far = propagate(makeOrbit('earth', MU_EARTH, at.r, after, b.dt), b.dt + 60 * 86400);
      expect(Math.acos(Math.min(1, v3.dot(v3.normalize(far.v), s))), `asymptote ${outOfPlaneDeg} deg`).toBeLessThan(0.01);
      expect(Math.abs(v3.len(far.v) - vinf)).toBeLessThan(0.01 * vinf);
      if (outOfPlaneDeg === 0) {
        expect(b.deltaV).toBeCloseTo(ejectionDeltaV(MU_EARTH, rp, vinf), 3);
        expect(b.planeChange).toBeLessThan(1e-6);
      } else expect(b.deltaV).toBeGreaterThan(ejectionDeltaV(MU_EARTH, rp, vinf));
    }
    // an asymptote too far out of the plane for a periapsis on it
    expect(ejectionBurn(MU_EARTH, r, v, v3.scale(W, 3600), 0)).toBeNull();
  });

  it('its Mars window of 2031 is the simulation planner’s, by departure, time of flight and cost', () => {
    const t0 = utOf(2030, 10, 1);
    const snaps = w.system.buildBodySnapshots(t0);
    const by = (id: string): BodySnapshot => snaps.find((b) => b.id === id)!;
    const muS = w.system.body('sun').mu;
    const rPark = 6.578e6;
    const vinfCost = (x: number): number => ejectionDeltaV(MU_EARTH, rPark, x) + x;
    const span = 0.8 * synodic(muS, meanOrbit(by('earth'), by('sun'), muS).a, meanOrbit(by('mars'), by('sun'), muS).a);
    const mine = bestWindow({ origin: by('earth'), planet: by('mars'), parent: by('sun'), muParent: muS, departCost: (x) => ejectionDeltaV(MU_EARTH, rPark, v3.len(x)), arriveCost: (x) => x, fromUt: t0, toUt: t0 + span })!;
    const sim = bestTransfer(w.system, 'earth', 'mars', t0, t0 + span, { cost: (a, b) => vinfCost(v3.len(a)) - v3.len(a) + v3.len(b) })!;
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(`pilot ${mine.departUt} ${mine.tof / 86400} ${mine.cost}; sim ${sim.departUt} ${sim.tof / 86400} ${sim.cost}`);
    expect(Math.abs(mine.departUt - sim.departUt) / 86400).toBeLessThan(3);
    expect(Math.abs(mine.tof - sim.tof) / 86400).toBeLessThan(5);
    expect(Math.abs(mine.cost - sim.cost) / sim.cost).toBeLessThan(0.01);
  });
});
