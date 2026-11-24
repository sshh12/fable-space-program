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

/**
 * What a search over a body's motion needs to know without evaluating it (src/sim/orbit/events.ts,
 * findSoiEntry): bounds on the distance from the parent and on the speed relative to it, valid at every
 * instant of [t0, t1].
 */
export interface EphemerisBounds {
  rMin: number;
  rMax: number;
  vMax: number;
}

/** An orbit ephemeris of the body system (v2): every kind the body contract states. */
export interface OrbitEphemeris extends Ephemeris {
  /** Bounds on distance and speed over [t0, t1] (any order; a frozen ellipse ignores the interval). */
  bounds(t0: number, t1: number): EphemerisBounds;
  /** Unit normal of the orbit plane at ut (parent BCI axes): the plane AN/DN markers and relative inclinations refer to. */
  normalAt(ut: number): Vec3;
  /** Mean orbit period, s (the period of the mean anomaly or of the mean longitude). */
  readonly meanPeriod: number;
}

/** Seconds in a Julian century (the unit of `KeplerOrbitDef.rates`). */
export const JULIAN_CENTURY_S = 36525 * 86400;

/** Rotation from ecliptic to equatorial components: Rx(+obliquity). */
export const Q_ECLIPTIC_TO_EQUATORIAL: Quat = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, OBLIQUITY_J2000);

export class KeplerEphemeris implements OrbitEphemeris {
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

  get meanPeriod(): number {
    return this.period;
  }

  normalAt(): Vec3 {
    return this.normal;
  }

  /** Fixed ellipse: periapsis and apoapsis distance, and the periapsis speed sqrt(mu / p) (1 + e). */
  bounds(): EphemerisBounds {
    const p = this.a * (1 - this.e * this.e);
    return { rMin: this.a * (1 - this.e), rMax: this.a * (1 + this.e), vMax: Math.sqrt(this.mu / p) * (1 + this.e) };
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

/**
 * A Kepler orbit with the v2 members of `KeplerOrbitDef` (ARCHITECTURE 8.2, 8.3): secular rates of a, e, i, the
 * node and the argument of periapsis per Julian century, linear from `epochUt`, and the fitted mean motion
 * `meanMotionDegPerDay` (absent: sqrt(mu / a^3) with a at the instant, as the reference evaluator does). The
 * velocity is the EXACT time derivative of the position, the rates' terms included (the convention of
 * docs/handoff/bodies-ephemeris.md section 2; reference: tools/bodies/lib/kepler.mjs `keplerState`), so a vessel
 * crossing the sphere of influence feels no kick. Plane frames as KeplerEphemeris (the caller passes the
 * plane's rotation into the parent's BCI axes).
 *
 * Used for every orbit that states `rates` or `meanMotionDegPerDay`; a frozen ellipse (neither) stays a
 * KeplerEphemeris, whose arithmetic is v1's to the bit.
 */
export class SecularKeplerEphemeris implements OrbitEphemeris {
  readonly epochUt: number;
  /** Mean-anomaly rate, rad/s (null: from mu and the semi-major axis at each instant). */
  private readonly nFixed: number | null;
  private readonly def: KeplerOrbitDef;
  /** Rates per century as stated (absent members 0). */
  private readonly cy: { a: number; e: number; iDeg: number; lanDeg: number; argPeDeg: number };
  /** Element rates per second (a m/s, e 1/s, angles rad/s): the derivative terms of the velocity. */
  private readonly rate: { a: number; e: number; i: number; node: number; argPe: number };

  constructor(
    def: KeplerOrbitDef,
    readonly mu: number,
    private readonly qPlaneToBci: Quat,
  ) {
    if (!(def.a > 0) || !(def.e >= 0 && def.e < 1)) throw new Error(`SecularKeplerEphemeris: need a > 0 and 0 <= e < 1 (a=${def.a}, e=${def.e})`);
    this.def = def;
    this.epochUt = def.epochUt;
    const r = def.rates ?? {};
    this.cy = { a: r.a ?? 0, e: r.e ?? 0, iDeg: r.iDeg ?? 0, lanDeg: r.lanDeg ?? 0, argPeDeg: r.argPeDeg ?? 0 };
    const perSecond = (x: number): number => x / JULIAN_CENTURY_S;
    this.rate = { a: perSecond(this.cy.a), e: perSecond(this.cy.e), i: perSecond(this.cy.iDeg) * DEG, node: perSecond(this.cy.lanDeg) * DEG, argPe: perSecond(this.cy.argPeDeg) * DEG };
    this.nFixed = def.meanMotionDegPerDay !== undefined ? (def.meanMotionDegPerDay * DEG) / 86400 : null;
    if (this.nFixed !== null && !(this.nFixed > 0)) throw new Error(`SecularKeplerEphemeris: meanMotionDegPerDay must be positive (${def.meanMotionDegPerDay})`);
  }

  /** Elements at ut (angles in radians) and the mean-anomaly rate there, by the reference's expressions. */
  elementsAt(ut: number): { a: number; e: number; i: number; node: number; argPe: number; M: number; n: number } {
    const d = this.def;
    const c = this.cy;
    const dtCy = (ut - d.epochUt) / JULIAN_CENTURY_S;
    const a = d.a + c.a * dtCy;
    const n = this.nFixed ?? Math.sqrt(this.mu / a ** 3);
    return {
      a,
      e: d.e + c.e * dtCy,
      i: (d.iDeg + c.iDeg * dtCy) * DEG,
      node: (d.lanDeg + c.lanDeg * dtCy) * DEG,
      argPe: (d.argPeDeg + c.argPeDeg * dtCy) * DEG,
      M: d.meanAnomalyDeg * DEG + n * (ut - d.epochUt),
      n,
    };
  }

  get meanPeriod(): number {
    return TWO_PI / (this.nFixed ?? Math.sqrt(this.mu / this.def.a ** 3));
  }

  stateAt(ut: number): StateVector {
    const el = this.elementsAt(ut);
    const rt = this.rate;
    const e = el.e;
    const E = eccentricFromMean(e, el.M);
    const cE = Math.cos(E);
    const sE = Math.sin(E);
    const sq = Math.sqrt(1 - e * e);
    const x = el.a * (cE - e);
    const y = el.a * sq * sE;
    // M = E - e sin E with dM/dt = n  =>  dE/dt = (n + de/dt sin E) / (1 - e cos E)
    const ED = (el.n + rt.e * sE) / (1 - e * cE);
    const xD = rt.a * (cE - e) + el.a * (-sE * ED - rt.e);
    const yD = rt.a * sq * sE + el.a * ((-e * rt.e) / sq) * sE + el.a * sq * cE * ED;
    const cO = Math.cos(el.node);
    const sO = Math.sin(el.node);
    const cw = Math.cos(el.argPe);
    const sw = Math.sin(el.argPe);
    const ci = Math.cos(el.i);
    const si = Math.sin(el.i);
    const P: Vec3 = { x: cO * cw - sO * sw * ci, y: sO * cw + cO * sw * ci, z: sw * si };
    const Q: Vec3 = { x: -cO * sw - sO * cw * ci, y: -sO * sw + cO * cw * ci, z: cw * si };
    // dP/dnode, dQ/dnode, dP/di, dQ/di; dP/dargPe = Q, dQ/dargPe = -P
    const OD = rt.node;
    const wD = rt.argPe;
    const iD = rt.i;
    const PD: Vec3 = {
      x: (-sO * cw - cO * sw * ci) * OD + Q.x * wD + sO * sw * si * iD,
      y: (cO * cw - sO * sw * ci) * OD + Q.y * wD + -cO * sw * si * iD,
      z: Q.z * wD + sw * ci * iD,
    };
    const QD: Vec3 = {
      x: (sO * sw - cO * cw * ci) * OD - P.x * wD + sO * cw * si * iD,
      y: (-cO * sw - sO * cw * ci) * OD - P.y * wD + -cO * cw * si * iD,
      z: -P.z * wD + cw * ci * iD,
    };
    const r: Vec3 = { x: P.x * x + Q.x * y, y: P.y * x + Q.y * y, z: P.z * x + Q.z * y };
    const v: Vec3 = {
      x: PD.x * x + QD.x * y + P.x * xD + Q.x * yD,
      y: PD.y * x + QD.y * y + P.y * xD + Q.y * yD,
      z: PD.z * x + QD.z * y + P.z * xD + Q.z * yD,
    };
    return { r: quat.rotate(this.qPlaneToBci, r), v: quat.rotate(this.qPlaneToBci, v) };
  }

  normalAt(ut: number): Vec3 {
    const el = this.elementsAt(ut);
    const si = Math.sin(el.i);
    return quat.rotate(this.qPlaneToBci, { x: si * Math.sin(el.node), y: -si * Math.cos(el.node), z: Math.cos(el.i) });
  }

  /**
   * a and e are linear in time, so their extremes over [t0, t1] are at the ends. The speed bound adds to the
   * in-plane periapsis speed n a sqrt((1 + e) / (1 - e)) the turning of the plane and of the apsides (rates x
   * the largest radius) and the drift of a and e.
   */
  bounds(t0: number, t1: number): EphemerisBounds {
    const ends = [this.elementsAt(Math.min(t0, t1)), this.elementsAt(Math.max(t0, t1))];
    let rMin = Infinity;
    let rMax = 0;
    let vMax = 0;
    const rt = this.rate;
    for (const el of ends) {
      const e = Math.min(Math.max(el.e, 0), 0.999999);
      rMin = Math.min(rMin, el.a * (1 - e));
      rMax = Math.max(rMax, el.a * (1 + e));
      const vPlane = el.n * el.a * Math.sqrt((1 + e) / (1 - e));
      const vTurn = (Math.abs(rt.node) + Math.abs(rt.argPe) + Math.abs(rt.i)) * el.a * (1 + e);
      const vDrift = Math.abs(rt.a) * (1 + e) + el.a * Math.abs(rt.e) * (1 + 1 / Math.sqrt(1 - e * e));
      vMax = Math.max(vMax, vPlane + vTurn + vDrift);
    }
    return { rMin, rMax, vMax };
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

/** Bounds of the Almanac Sun's distance (AU factor 1.00014 - 0.01671 cos g - 0.00014 cos 2g) and speed. */
const SUN_R_MIN = (1.00014 - 0.01671 - 0.00014) * AU;
const SUN_R_MAX = (1.00014 + 0.01671 + 0.00014) * AU;
const SUN_V_MAX = ((0.01671 + 0.00028) * SUN_DG * AU + SUN_R_MAX * (SUN_DL + (1.915 + 0.04) * DEG * SUN_DG + 0.0000004 * DEG)) / 86400;

/**
 * The Almanac low-precision Sun as an orbit: the Sun about its parent (v1: the star about the Earth), or, with
 * `inverted` (v2, `SunLowPrecisionOrbitDef.inverted`), the parent about the Sun: minus that vector, so that
 * the Sun's direction at the Earth reproduces v1 to the bit.
 */
export class SunLowPrecisionEphemeris implements OrbitEphemeris {
  constructor(readonly inverted = false) {}

  stateAt(ut: number): StateVector {
    const s = sunLowPrecisionState(ut);
    return this.inverted ? { r: v3.neg(s.r), v: v3.neg(s.v) } : s;
  }

  /** Mean period of the mean longitude L (0.9856474 deg/day). */
  get meanPeriod(): number {
    return (TWO_PI / SUN_DL) * 86400;
  }

  /** Normal of the instantaneous orbit plane (r x v): the same for the inverted and the plain vector. */
  normalAt(ut: number): Vec3 {
    const s = sunLowPrecisionState(ut);
    return v3.normalize(v3.cross(s.r, s.v));
  }

  bounds(): EphemerisBounds {
    return { rMin: SUN_R_MIN, rMax: SUN_R_MAX, vMax: SUN_V_MAX };
  }
}
