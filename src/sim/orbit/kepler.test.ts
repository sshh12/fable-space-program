import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '../../core/math/vec3';
import { quat } from '../../core/math/quat';
import { lagrangeCoefficients, makeOrbit, propagate, solveUniversalAnomaly, specificEnergy, stumpff, type Orbit } from './kepler';

const MU = 3.986004418e14;
const RP = 7.0e6;
const T0 = 8.9e8;
const ECCS = [0, 0.01, 0.5, 0.97, 1 - 1e-9, 1 + 1e-9, 1.3, 5];

/** Orbit with periapsis radius RP and eccentricity e, starting at true anomaly nu0, in a tilted plane. */
function orbitFor(e: number, nu0: number): Orbit {
  const p = RP * (1 + e);
  const r = p / (1 + e * Math.cos(nu0));
  const k = Math.sqrt(MU / p);
  const rPf: Vec3 = { x: r * Math.cos(nu0), y: r * Math.sin(nu0), z: 0 };
  const vPf: Vec3 = { x: -k * Math.sin(nu0), y: k * (e + Math.cos(nu0)), z: 0 };
  const q = quat.mul(quat.fromAxisAngle(v3.unitZ(), 0.7), quat.fromAxisAngle(v3.unitX(), 0.45));
  return makeOrbit('earth', MU, quat.rotate(q, rPf), quat.rotate(q, vPf), T0);
}

/** Test times: within a few periods for closed orbits, moderate flights for open ones. */
function timesFor(o: Orbit): number[] {
  if (o.period !== null) {
    const P = o.period;
    return [P / 7, P / 2, 0.9 * P, 3.3 * P, -2.1 * P, -0.37 * P];
  }
  return [500, 3000, 20000, -500, -3000];
}

function rk4(mu: number, r0: Vec3, v0: Vec3, duration: number, k = 1e-3): { r: Vec3; v: Vec3 } {
  let r = v3.clone(r0);
  let v = v3.clone(v0);
  const acc = (p: Vec3): Vec3 => v3.scale(p, -mu / Math.pow(v3.lenSq(p), 1.5));
  let t = 0;
  const sgn = duration >= 0 ? 1 : -1;
  while (sgn * (duration - t) > 0) {
    const rm = v3.len(r);
    let h = k * Math.sqrt((rm * rm * rm) / mu);
    if (h > sgn * (duration - t)) h = sgn * (duration - t);
    h *= sgn;
    const a1 = acc(r);
    const r2 = v3.addScaled(r, v, h / 2);
    const v2 = v3.addScaled(v, a1, h / 2);
    const a2 = acc(r2);
    const r3 = v3.addScaled(r, v2, h / 2);
    const v3_ = v3.addScaled(v, a2, h / 2);
    const a3 = acc(r3);
    const r4 = v3.addScaled(r, v3_, h);
    const v4 = v3.addScaled(v, a3, h);
    const a4 = acc(r4);
    r = v3.add(r, v3.scale(v3.add(v3.add(v, v4), v3.scale(v3.add(v2, v3_), 2)), h / 6));
    v = v3.add(v, v3.scale(v3.add(v3.add(a1, a4), v3.scale(v3.add(a2, a3), 2)), h / 6));
    t += h;
  }
  return { r, v };
}

describe('universal-variable Kepler propagation', () => {
  it('Stumpff series and closed forms agree at the switch', () => {
    // psi = +/-1 uses the series, the next double beyond uses the closed form.
    for (const psi of [1, -1]) {
      const a = stumpff(psi);
      const b = stumpff(psi * (1 + Number.EPSILON));
      expect(Math.abs(a.c2 - b.c2)).toBeLessThan(1e-15);
      expect(Math.abs(a.c3 - b.c3)).toBeLessThan(1e-15);
    }
    expect(stumpff(0)).toEqual({ c2: 0.5, c3: 1 / 6 });
  });

  for (const e of ECCS) {
    describe(`e = ${e}`, () => {
      const nu0 = e > 1.5 ? -0.8 : -1.0;
      const o = orbitFor(e, nu0);

      it('f*gdot - fdot*g = 1 to 1e-12', () => {
        for (const dt of timesFor(o)) {
          const c = lagrangeCoefficients(o, T0 + dt);
          expect(Math.abs(c.f * c.gdot - c.fdot * c.g - 1)).toBeLessThan(1e-12);
        }
      });

      it('conserves energy and angular momentum to 1e-10', () => {
        const e0 = specificEnergy(MU, o.r0, o.v0);
        const h0 = v3.cross(o.r0, o.v0);
        const vScale = MU / RP; // energy scale (|E| -> 0 for parabolas)
        for (const dt of timesFor(o)) {
          const s = propagate(o, T0 + dt);
          expect(Math.abs(specificEnergy(MU, s.r, s.v) - e0) / vScale).toBeLessThan(1e-10);
          expect(v3.dist(v3.cross(s.r, s.v), h0) / v3.len(h0)).toBeLessThan(1e-10);
        }
      });

      it('round-trips forward and backward', () => {
        for (const dt of timesFor(o)) {
          const s = propagate(o, T0 + dt);
          const back = makeOrbit('earth', MU, s.r, s.v, T0 + dt);
          const s0 = propagate(back, T0);
          expect(v3.dist(s0.r, o.r0) / o.r0m).toBeLessThan(1e-10);
          expect(v3.dist(s0.v, o.v0) / v3.len(o.v0)).toBeLessThan(1e-10);
        }
      });

      it('agrees with an RK4 reference to 1e-6 over one period', () => {
        const duration = o.period ?? 20000;
        const ref = rk4(MU, o.r0, o.v0, duration);
        const s = propagate(o, T0 + duration);
        expect(v3.dist(ref.r, s.r) / v3.len(s.r)).toBeLessThan(1e-6);
        expect(v3.dist(ref.v, s.v) / v3.len(s.v)).toBeLessThan(1e-6);
      });

      it('bisection fallback gives the Laguerre-Conway solution', () => {
        for (const dt of timesFor(o)) {
          const red = o.period !== null ? dt - o.period * Math.round(dt / o.period) : dt;
          const a = solveUniversalAnomaly(o, red);
          const b = solveUniversalAnomaly(o, red, 0);
          expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(a)));
        }
      });

      if (e < 1 - 1e-6) {
        it('stays exact 1e6 periods ahead', () => {
          const P = o.period!;
          for (const frac of [0, 0.31, 0.77]) {
            const near = propagate(o, T0 + frac * P);
            const far = propagate(o, T0 + 1e6 * P + frac * P);
            expect(v3.dist(near.r, far.r) / v3.len(near.r)).toBeLessThan(1e-6);
          }
        });
      }
    });
  }

  it('propagate(t0) returns the epoch state', () => {
    const o = orbitFor(0.3, 0.2);
    const s = propagate(o, T0);
    expect(v3.dist(s.r, o.r0)).toBe(0);
    expect(v3.dist(s.v, o.v0)).toBe(0);
  });

  it('handles a purely radial trajectory without NaN', () => {
    const o = makeOrbit('earth', MU, { x: 7e6, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }, T0);
    expect(o.radial).toBe(true);
    const s = propagate(o, T0 + 500);
    expect(v3.isFinite(s.r)).toBe(true);
    expect(s.r.x).toBeGreaterThan(7e6);
    expect(Math.abs(s.r.y) + Math.abs(s.r.z)).toBeLessThan(1e-6);
  });
});
