/**
 * The sim's anomaly/time relations against the core ones that UI consumers of Patch.conic evaluate
 * (src/core/math/conic.ts), and the periapsis-anchored state reconstruction of src/sim/orbit/kepler.ts.
 */
import { describe, expect, it } from 'vitest';
import { conicFromState, conicMaxTrueAnomaly, timeSincePeriapsis } from '../../../src/core/math/conic';
import { v3 } from '../../../src/core/math/vec3';
import { timeFromPeriapsis } from '../../../src/sim/orbit/anomaly';
import { conicStateAtTime, makeOrbit, propagate, timeSincePeriapsisOfState } from '../../../src/sim/orbit/kepler';

const MU = 3.986004418e14;
const RP = 6.6e6;

/** Conic with periapsis RP and eccentricity e, periapsis passage at t = 0. */
function conicOf(e: number) {
  const vp = Math.sqrt((MU * (1 + e)) / RP);
  return conicFromState(MU, { x: RP, y: 0, z: 0 }, { x: 0, y: vp, z: 0 }, 0);
}

describe('time since periapsis: sim relation vs core timeSincePeriapsis', () => {
  // Outside the core's Barker band (|e - 1| < 1e-9) both are exact relations; the core's E - e sin E and
  // e sinh H - H lose ~1e-16/|1 - e| relative near e = 1, which bounds the agreement there.
  const es = [0, 1e-6, 0.01, 0.3, 0.7, 0.97, 0.999, 0.99999, 1 - 1e-7, 1 - 2e-9, 1, 1 + 2e-9, 1 + 1e-7, 1.0001, 1.01, 1.3, 2, 3.5, 5];
  for (const e of es) {
    it(`e = ${e}`, () => {
      const c = conicOf(e);
      const numax = conicMaxTrueAnomaly(c);
      const tol = e === 1 ? 1e-14 : 1e-13 + 4e-16 / Math.abs(1 - c.e);
      for (let i = -200; i <= 200; i++) {
        const nu = (0.999 * numax * i) / 200;
        const core = timeSincePeriapsis(c, nu);
        const sim = timeFromPeriapsis(c.e, c.p, MU, nu);
        expect(Number.isFinite(sim)).toBe(true);
        expect(Math.abs(core - sim) / Math.max(Math.abs(sim), 1)).toBeLessThanOrEqual(tol);
      }
    });
  }

  it('inside the core Barker band the two agree near periapsis (core drops the (1 - e) terms)', () => {
    for (const e of [1 - 5e-10, 1 + 5e-10]) {
      const c = conicOf(e);
      for (let nu = -2; nu <= 2; nu += 0.05) {
        const sim = timeFromPeriapsis(c.e, c.p, MU, nu);
        expect(Math.abs(timeSincePeriapsis(c, nu) - sim) / Math.max(Math.abs(sim), 1)).toBeLessThan(1e-7);
      }
    }
  });

  it('the state-based relation (near-radial tPeriapsis) equals the true-anomaly one on ordinary conics', () => {
    for (const e of [0.1, 0.5, 0.97, 1.5, 4]) {
      const c = conicOf(e);
      for (const t of [-3000, -200, 0.5, 700, 5000]) {
        const s = propagate(makeOrbit('earth', MU, { x: RP, y: 0, z: 0 }, { x: 0, y: Math.sqrt((MU * (1 + e)) / RP), z: 0 }, 0), t);
        if (c.period !== null && Math.abs(t) > c.period / 2) continue;
        const rm = v3.len(s.r);
        const alpha = 2 / rm - v3.lenSq(s.v) / MU;
        const dt = timeSincePeriapsisOfState(Math.sqrt(MU), alpha, rm, v3.dot(s.r, s.v) / Math.sqrt(MU), RP);
        expect(dt).toBeCloseTo(t, 6);
      }
    }
  });

  it('conicStateAtTime reproduces the propagation for ellipses, hyperbolas and the parabola', () => {
    for (const e of [0, 0.3, 0.97, 1, 1.2, 5]) {
      const vp = Math.sqrt((MU * (1 + e)) / RP);
      const o = makeOrbit('earth', MU, { x: RP, y: 0, z: 0 }, { x: 0, y: vp * 0.8, z: vp * 0.6 }, 0);
      for (const t of [-4000, -10, 0, 33.3, 2500, 9000]) {
        const a = conicStateAtTime(o.conic, t);
        const b = propagate(o, t);
        expect(v3.dist(a.r, b.r) / v3.len(b.r)).toBeLessThan(1e-11);
        expect(v3.dist(a.v, b.v) / v3.len(b.v)).toBeLessThan(1e-11);
      }
    }
  });
});
