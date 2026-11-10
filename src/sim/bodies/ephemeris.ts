/**
 * Body ephemerides (docs/research/sim-design.md 2.3). Every ephemeris is a pure function of `ut` giving the
 * body's state relative to its parent in the parent's BCI axes (= ROOT axes).
 *
 *  - 'kepler': fixed mean elements (no nodal regression, so the conic stays exact for prediction), referred
 *    to the J2000 ecliptic (rotated into the equatorial frame by the J2000 obliquity) or to the parent's
 *    equator (rotated by the parent's pole orientation). Mean motion uses mu_parent + mu_body.
 *  - 'sunLowPrecision': the Astronomical Almanac low-precision Sun, exactly as sim-design 2.3, with its
 *    analytic time derivative as the velocity.
 */
import type { StateVector } from '../../core/contracts/simInternal';
import type { KeplerOrbitDef } from '../../core/contracts/defs';
import { quat, type Quat } from '../../core/math/quat';
import { DEG, TWO_PI } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import { eccentricFromMean } from '../orbit/anomaly';

/** J2000 mean obliquity of the ecliptic, rad. */
export const OBLIQUITY_J2000 = 23.4392911 * DEG;
/** Astronomical unit, m. */
export const AU = 149597870700;

export interface Ephemeris {
  /** State relative to the parent, parent BCI axes. */
  stateAt(ut: number): StateVector;
}

/** Rotation from ecliptic to equatorial components: Rx(+obliquity). */
export const Q_ECLIPTIC_TO_EQUATORIAL: Quat = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, OBLIQUITY_J2000);

export class KeplerEphemeris implements Ephemeris {
  readonly a: number;
  readonly e: number;
  /** Mean motion, rad/s. */
  readonly n: number;
  readonly M0: number;
  readonly epochUt: number;
  readonly mu: number;
  /** Perifocal unit vectors in the parent's BCI axes. */
  readonly P: Vec3;
  readonly Q: Vec3;
  private readonly b: number;

  /**
   * @param def        orbital elements from the body definition
   * @param mu         gravitational parameter for the mean motion (mu_parent + mu_body)
   * @param qPlaneToBci rotation from the elements' reference frame to the parent's BCI axes
   */
  constructor(def: KeplerOrbitDef, mu: number, qPlaneToBci: Quat) {
    if (!(def.a > 0) || !(def.e >= 0 && def.e < 1)) throw new Error(`KeplerEphemeris: need a > 0 and 0 <= e < 1 (a=${def.a}, e=${def.e})`);
    this.a = def.a;
    this.e = def.e;
    this.mu = mu;
    this.n = Math.sqrt(mu / (def.a * def.a * def.a));
    this.M0 = def.meanAnomalyDeg * DEG;
    this.epochUt = def.epochUt;
    this.b = def.a * Math.sqrt(1 - def.e * def.e);
    const i = def.iDeg * DEG;
    const O = def.lanDeg * DEG;
    const w = def.argPeDeg * DEG;
    const cO = Math.cos(O);
    const sO = Math.sin(O);
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const ci = Math.cos(i);
    const si = Math.sin(i);
    const P: Vec3 = { x: cO * cw - sO * sw * ci, y: sO * cw + cO * sw * ci, z: sw * si };
    const Q: Vec3 = { x: -cO * sw - sO * cw * ci, y: -sO * sw + cO * cw * ci, z: cw * si };
    this.P = quat.rotate(qPlaneToBci, P);
    this.Q = quat.rotate(qPlaneToBci, Q);
  }

  /** Orbit period, s. */
  get period(): number {
    return TWO_PI / this.n;
  }

  /** Unit orbit normal (P x Q). */
  get normal(): Vec3 {
    return v3.normalize(v3.cross(this.P, this.Q));
  }

  /** Mean anomaly at ut (unreduced). */
  meanAnomaly(ut: number): number {
    return this.M0 + this.n * (ut - this.epochUt);
  }

  stateAt(ut: number): StateVector {
    const E = eccentricFromMean(this.e, this.meanAnomaly(ut));
    const cE = Math.cos(E);
    const sE = Math.sin(E);
    const x = this.a * (cE - this.e);
    const y = this.b * sE;
    const Edot = this.n / (1 - this.e * cE);
    const vx = -this.a * sE * Edot;
    const vy = this.b * cE * Edot;
    const P = this.P;
    const Q = this.Q;
    return {
      r: { x: x * P.x + y * Q.x, y: x * P.y + y * Q.y, z: x * P.z + y * Q.z },
      v: { x: vx * P.x + vy * Q.x, y: vx * P.y + vy * Q.y, z: vx * P.z + vy * Q.z },
    };
  }
}

const SUN_DL = 0.9856474 * DEG; // rad per day
const SUN_DG = 0.9856003 * DEG;

/**
 * Astronomical Almanac low-precision Sun (sim-design 2.3), d = ut / 86400:
 *   L = 280.460 + 0.9856474 d, g = 357.528 + 0.9856003 d, lambda = L + 1.915 sin g + 0.020 sin 2g,
 *   eps = 23.439 - 0.0000004 d, R = (1.00014 - 0.01671 cos g - 0.00014 cos 2g) AU,
 *   r = R (cos lambda, cos eps sin lambda, sin eps sin lambda).
 * Velocity is the exact time derivative of that expression.
 */
export function sunLowPrecisionState(ut: number): StateVector {
  const d = ut / 86400;
  const Ldeg = (280.46 + 0.9856474 * d) % 360;
  const gdeg = (357.528 + 0.9856003 * d) % 360;
  const g = gdeg * DEG;
  const sg = Math.sin(g);
  const cg = Math.cos(g);
  const s2g = Math.sin(2 * g);
  const c2g = Math.cos(2 * g);
  const lambda = Ldeg * DEG + (1.915 * sg + 0.02 * s2g) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const R = (1.00014 - 0.01671 * cg - 0.00014 * c2g) * AU;
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const ce = Math.cos(eps);
  const se = Math.sin(eps);
  // derivatives per day
  const dLambda = SUN_DL + (1.915 * cg + 0.04 * c2g) * DEG * SUN_DG;
  const dEps = -0.0000004 * DEG;
  const dR = (0.01671 * sg + 0.00028 * s2g) * SUN_DG * AU;
  const k = 1 / 86400;
  return {
    r: { x: R * cl, y: R * ce * sl, z: R * se * sl },
    v: {
      x: (dR * cl - R * sl * dLambda) * k,
      y: (dR * ce * sl + R * (-se * dEps * sl + ce * cl * dLambda)) * k,
      z: (dR * se * sl + R * (ce * dEps * sl + se * cl * dLambda)) * k,
    },
  };
}

export class SunLowPrecisionEphemeris implements Ephemeris {
  stateAt(ut: number): StateVector {
    return sunLowPrecisionState(ut);
  }
}
