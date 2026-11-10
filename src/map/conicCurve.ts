/**
 * A conic arc placed in view space, ready to be sampled: origin (the focus, i.e. the central body's
 * centre relative to the eye) and the perifocal axes P, Q rotated into view axes. Circles (SOI outlines,
 * recovery zones) are conics with e = 0 and p = radius.
 *
 * The sampling parameter u is the eccentric anomaly for ellipses, the hyperbolic anomaly for hyperbolas and
 * the true anomaly in a narrow band around e = 1, so that equal parameter steps are close to equal arc
 * length. All conversions accept unwrapped true anomalies (multi-revolution ranges keep their turns).
 */
import type { ConicElements } from '@/core/math/conic';
import type { Vec3 } from '@/core/math/vec3';
import type { Projector } from './projection';

const TWO_PI = 2 * Math.PI;
/** |e - 1| below this is sampled in true anomaly (parabolic band). */
const PARABOLIC_BAND = 1e-6;

export type ParamKind = 'E' | 'H' | 'nu';

export class ViewConic {
  ox = 0;
  oy = 0;
  oz = 0;
  px = 1;
  py = 0;
  pz = 0;
  qx = 0;
  qy = 1;
  qz = 0;
  p = 1;
  e = 0;
  /** Semi-major axis magnitude and semi-minor axis (ellipse) / conjugate axis (hyperbola). */
  aAbs = 1;
  b = 1;
  kind: ParamKind = 'E';
  private sq1me = 1;
  private sq1pe = 1;
  private sqRatio = 1;

  /** Place a conic whose focus is at the ROOT position `focusRoot`. */
  setFromElements(c: ConicElements, focusRoot: Vec3, proj: Projector): this {
    const o = proj.toView(focusRoot);
    const P = proj.rotate(c.P);
    const Q = proj.rotate(c.Q);
    return this.set(o, P, Q, c.p, c.e);
  }

  /** Place a circle of radius `r` centred at view-space `centre` spanned by unit view-space axes `u`, `v`. */
  setCircle(centre: Vec3, u: Vec3, v: Vec3, r: number): this {
    return this.set(centre, u, v, r, 0);
  }

  set(o: Vec3, P: Vec3, Q: Vec3, p: number, e: number): this {
    this.ox = o.x;
    this.oy = o.y;
    this.oz = o.z;
    this.px = P.x;
    this.py = P.y;
    this.pz = P.z;
    this.qx = Q.x;
    this.qy = Q.y;
    this.qz = Q.z;
    this.p = p;
    this.e = e;
    if (Math.abs(e - 1) < PARABOLIC_BAND) {
      this.kind = 'nu';
      this.aAbs = Infinity;
      this.b = Infinity;
    } else if (e < 1) {
      this.kind = 'E';
      this.aAbs = p / (1 - e * e);
      this.b = this.aAbs * Math.sqrt(1 - e * e);
      this.sq1me = Math.sqrt(1 - e);
      this.sq1pe = Math.sqrt(1 + e);
    } else {
      this.kind = 'H';
      this.aAbs = p / (e * e - 1);
      this.b = this.aAbs * Math.sqrt(e * e - 1);
      this.sqRatio = Math.sqrt((e - 1) / (e + 1));
    }
    return this;
  }

  /** Unwrapped true anomaly -> sampling parameter. */
  nuToU(nu: number): number {
    if (this.kind === 'nu') return nu;
    if (this.kind === 'E') {
      const w = nu - TWO_PI * Math.round(nu / TWO_PI);
      const E = 2 * Math.atan2(this.sq1me * Math.sin(w / 2), this.sq1pe * Math.cos(w / 2));
      return E + (nu - w);
    }
    return 2 * Math.atanh(this.sqRatio * Math.tan(nu / 2));
  }

  /** Sampling parameter -> unwrapped true anomaly. */
  uToNu(u: number): number {
    if (this.kind === 'nu') return u;
    if (this.kind === 'E') {
      const w = u - TWO_PI * Math.round(u / TWO_PI);
      const nu = 2 * Math.atan2(this.sq1pe * Math.sin(w / 2), this.sq1me * Math.cos(w / 2));
      return nu + (u - w);
    }
    return 2 * Math.atan(Math.tanh(u / 2) / this.sqRatio);
  }

  /** Perifocal coordinates and their derivatives with respect to u: out = [X, Y, dX/du, dY/du]. */
  perifocalWithDerivative(u: number, out: Float64Array): void {
    if (this.kind === 'E') {
      const c = Math.cos(u);
      const s = Math.sin(u);
      out[0] = this.aAbs * (c - this.e);
      out[1] = this.b * s;
      out[2] = -this.aAbs * s;
      out[3] = this.b * c;
    } else if (this.kind === 'H') {
      const ch = Math.cosh(u);
      const sh = Math.sinh(u);
      out[0] = this.aAbs * (this.e - ch);
      out[1] = this.b * sh;
      out[2] = -this.aAbs * sh;
      out[3] = this.b * ch;
    } else {
      const c = Math.cos(u);
      const s = Math.sin(u);
      const den = 1 + this.e * c;
      const r = this.p / den;
      const dr = (this.p * this.e * s) / (den * den);
      out[0] = r * c;
      out[1] = r * s;
      out[2] = dr * c - r * s;
      out[3] = dr * s + r * c;
    }
  }

  /**
   * Mean anomaly at parameter u (E - e sin E, or e sinh H - H), unwrapped like u; NaN in the parabolic band.
   * Time between two parameters is the mean-anomaly difference divided by the mean motion sqrt(mu/|a|^3).
   */
  meanAnomaly(u: number): number {
    if (this.kind === 'E') return u - this.e * Math.sin(u);
    if (this.kind === 'H') return this.e * Math.sinh(u) - u;
    return NaN;
  }

  /**
   * Upper bound of the velocity-direction turning per unit parameter for ellipses (a/b, reached at the
   * apsides); null when only the per-point heading can bound it (hyperbolas, parabolic band).
   */
  maxTurnRate(): number | null {
    return this.kind === 'E' ? 1 / Math.sqrt(1 - this.e * this.e) : null;
  }

  /** In-plane direction angle of the velocity at parameter u (monotonic along the curve): nu + pi/2 - flight-path angle. */
  heading(u: number): number {
    const nu = this.uToNu(u);
    const gamma = Math.atan2(this.e * Math.sin(nu), 1 + this.e * Math.cos(nu));
    return nu + Math.PI / 2 - gamma;
  }
}
