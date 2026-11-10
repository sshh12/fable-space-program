/**
 * Adaptive float64 sampling of a conic arc to a screen-space chord error.
 *
 * 1. The arc is cut into initial pieces whose velocity direction turns by at most 22.5 degrees (45 for
 *    faint lines), so every piece lies inside the sphere that has its chord as diameter (Thales): a piece
 *    whose sphere is outside the view frustum is kept as one chord without further work, and a whole
 *    ellipse outside the frustum is not sampled at all.
 * 2. Every vertex carries its analytic screen-space tangent. A conic arc in front of the eye projects to a
 *    convex arc, which lies inside the triangle formed by its chord and the tangent lines at its ends, so
 *    the triangle's height is a RIGOROUS bound of the chord error, obtained without evaluating the curve
 *    again. Pieces are refined greatest-bound-first (a max-heap) until every bound is under the tolerance or
 *    the vertex cap is reached; each refinement step evaluates exactly one new vertex.
 * 3. Where the bound does not apply (a piece touching the near plane, a degenerate tangent, a hairpin
 *    turning 90 degrees or more against its chord) the midpoint is evaluated and its distance to the chord
 *    is used instead (for near-plane pieces: the angle the sagitta subtends at the eye, in pixels).
 */
import { CHORD_TOLERANCE_PX, MAX_POINTS_PER_CURVE } from './constants';
import type { ViewConic } from './conicCurve';
import type { Projector } from './projection';

/** Largest velocity-direction turn of an initial piece (patches); faint lines may pass up to pi/4. */
const MAX_TURN = Math.PI / 8;
export const FAINT_MAX_TURN = Math.PI / 4;
/** Largest number of initial pieces (pathological ranges are capped, never looped forever). */
const MAX_INITIAL_PIECES = 512;
/** Frustum margin in device pixels (line half width + anti-aliasing + label slack). */
const CULL_MARGIN_PX = 16;
/** The midpoint fallback measures the deviation at one point only: keep a margin below the tolerance. */
const MIDPOINT_MARGIN = 0.85;
/** Tangent bound applies while both end tangents are within acos(0.05) = 87 degrees of the chord. */
const MIN_TANGENT_COS = 0.05;

/** Output of one sampled curve, in arrays owned by the Sampler (valid until the next call). */
export interface SampledCurve {
  count: number;
  /** Sampling parameter of every vertex (see ViewConic). */
  u: Float64Array;
  /** View-space position. */
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /** Screen position (device px); NaN when the vertex is behind the near plane. */
  sx: Float64Array;
  sy: Float64Array;
  /** True when the vertex cap stopped the refinement before every piece met the tolerance. */
  capped: boolean;
  /** Curve evaluations spent on this call (the cost measure: about one per output vertex). */
  evaluations: number;
}

const FRONT = 1;
const TANGENT = 2;

export class Sampler {
  private cap: number;
  // Scratch point storage (unordered); pieces refer to point indices.
  private pu: Float64Array;
  private px: Float64Array;
  private py: Float64Array;
  private pz: Float64Array;
  private psx: Float64Array;
  private psy: Float64Array;
  /** Unit screen tangent (direction of increasing parameter). */
  private ptx: Float64Array;
  private pty: Float64Array;
  private pflags: Uint8Array;
  private nPoints = 0;
  // Pieces: endpoints a, b, evaluated midpoint m (-1: none), error bound, list link.
  private ka: Int32Array;
  private kb: Int32Array;
  private km: Int32Array;
  private kerr: Float64Array;
  private knext: Int32Array;
  private nPieces = 0;
  private heap: Int32Array;
  private heapSize = 0;
  private readonly tmp = new Float64Array(4);
  // Per-call constants: frustum planes (view space, widened by CULL_MARGIN_PX) and projection.
  private ftx = 1;
  private fty = 1;
  private fnx = 1;
  private fny = 1;
  private curve: ViewConic | null = null;
  private near = 0;
  private focal = 1;
  private cx = 0;
  private cy = 0;
  readonly out: SampledCurve;

  constructor(cap = MAX_POINTS_PER_CURVE) {
    this.cap = cap;
    const nPts = 2 * (cap + MAX_INITIAL_PIECES) + 8;
    const nPieces = cap + MAX_INITIAL_PIECES + 8;
    this.pu = new Float64Array(nPts);
    this.px = new Float64Array(nPts);
    this.py = new Float64Array(nPts);
    this.pz = new Float64Array(nPts);
    this.psx = new Float64Array(nPts);
    this.psy = new Float64Array(nPts);
    this.ptx = new Float64Array(nPts);
    this.pty = new Float64Array(nPts);
    this.pflags = new Uint8Array(nPts);
    this.ka = new Int32Array(nPieces);
    this.kb = new Int32Array(nPieces);
    this.km = new Int32Array(nPieces);
    this.kerr = new Float64Array(nPieces);
    this.knext = new Int32Array(nPieces);
    this.heap = new Int32Array(nPieces);
    const n = cap + MAX_INITIAL_PIECES + 2;
    this.out = {
      count: 0,
      u: new Float64Array(n),
      vx: new Float64Array(n),
      vy: new Float64Array(n),
      vz: new Float64Array(n),
      sx: new Float64Array(n),
      sy: new Float64Array(n),
      capped: false,
      evaluations: 0,
    };
  }

  /**
   * Sample `curve` between parameters u0 < u1 so that the polyline stays within `tolerancePx` device pixels
   * of the projected curve. Returns this.out (overwritten by the next call).
   */
  sample(curve: ViewConic, u0: number, u1: number, proj: Projector, tolerancePx = CHORD_TOLERANCE_PX, cap = this.cap, maxTurn = MAX_TURN): SampledCurve {
    this.nPoints = 0;
    this.nPieces = 0;
    this.heapSize = 0;
    const out = this.out;
    out.capped = false;
    out.evaluations = 0;
    if (!(u1 > u0) || !Number.isFinite(u0) || !Number.isFinite(u1)) {
      out.count = 0;
      return out;
    }
    const maxVerts = Math.min(cap, this.cap);
    this.ftx = proj.tanHalfX * (1 + (2 * CULL_MARGIN_PX) / proj.width);
    this.fty = proj.tanHalfY * (1 + (2 * CULL_MARGIN_PX) / proj.height);
    this.fnx = 1 / Math.sqrt(1 + this.ftx * this.ftx);
    this.fny = 1 / Math.sqrt(1 + this.fty * this.fty);
    this.near = proj.near;
    this.focal = proj.focal;
    this.cx = proj.cx;
    this.cy = proj.cy;
    this.curve = curve;
    // A whole ellipse outside the view frustum (sphere about its centre with radius a) is not sampled at all.
    if (curve.kind === 'E') {
      const ae = curve.aAbs * curve.e;
      if (this.sphereOutside(curve.ox - ae * curve.px, curve.oy - ae * curve.py, curve.oz - ae * curve.pz, curve.aAbs * 1.001)) {
        out.count = 0;
        return out;
      }
    }
    const first = this.initialPieces(curve, u0, u1, Math.min(maxTurn, Math.PI / 2));
    // Refinement, greatest error first; every step adds one vertex.
    let vertices = this.nPieces + 1;
    while (this.heapSize > 0) {
      const k = this.heap[0]!;
      const err = this.kerr[k]!;
      if (err <= tolerancePx) break;
      if (vertices >= maxVerts) {
        out.capped = true;
        break;
      }
      this.heapPop();
      const a = this.ka[k]!;
      const b = this.kb[k]!;
      const ua = this.pu[a]!;
      const ub = this.pu[b]!;
      let m = this.km[k]!;
      if (m < 0) m = this.evalPoint(curve, (ua + ub) / 2);
      const um = this.pu[m]!;
      if (!(um > ua && ub > um)) continue; // parameter exhausted: accept as is
      const r = this.nPieces++;
      this.ka[r] = m;
      this.kb[r] = b;
      this.km[r] = -1;
      this.knext[r] = this.knext[k]!;
      this.kb[k] = m;
      this.km[k] = -1;
      this.knext[k] = r;
      this.kerr[k] = this.pieceError(k);
      this.kerr[r] = this.pieceError(r);
      this.heapPush(k);
      this.heapPush(r);
      vertices++;
    }
    let n = 0;
    for (let k = first; k >= 0; k = this.knext[k]!) {
      this.emit(n++, this.ka[k]!);
      if (this.knext[k]! < 0) this.emit(n++, this.kb[k]!);
    }
    out.count = n;
    out.evaluations = this.nPoints;
    return out;
  }

  private emit(n: number, i: number): void {
    const o = this.out;
    o.u[n] = this.pu[i]!;
    o.vx[n] = this.px[i]!;
    o.vy[n] = this.py[i]!;
    o.vz[n] = this.pz[i]!;
    o.sx[n] = this.psx[i]!;
    o.sy[n] = this.psy[i]!;
  }

  private initialPieces(curve: ViewConic, u0: number, u1: number, maxTurn: number): number {
    const breaks: number[] = [u0];
    const rate = curve.maxTurnRate();
    if (rate !== null && rate < 2) {
      // Ellipse of moderate eccentricity: uniform steps bounded by the maximum turning rate (a/b).
      const n = Math.min(MAX_INITIAL_PIECES, Math.max(2, Math.ceil(((u1 - u0) * rate) / maxTurn)));
      for (let i = 1; i <= n; i++) breaks.push(u0 + ((u1 - u0) * i) / n);
    } else {
      // Otherwise: 4 uniform pieces, split any whose heading turns more than maxTurn.
      const stack: number[] = [];
      const n0 = 4;
      for (let i = n0; i >= 1; i--) stack.push(u0 + ((u1 - u0) * i) / n0);
      let ua = u0;
      let ha = curve.heading(ua);
      while (stack.length > 0) {
        const ub = stack[stack.length - 1]!;
        const hb = curve.heading(ub);
        if (Math.abs(hb - ha) > maxTurn && breaks.length + stack.length < MAX_INITIAL_PIECES && ub - ua > 1e-12 * Math.max(1, Math.abs(ub))) {
          stack.push((ua + ub) / 2);
          continue;
        }
        stack.pop();
        breaks.push(ub);
        ua = ub;
        ha = hb;
      }
    }
    let prevPoint = this.evalPoint(curve, breaks[0]!);
    let firstPiece = -1;
    let prevPiece = -1;
    for (let i = 1; i < breaks.length; i++) {
      const b = this.evalPoint(curve, breaks[i]!);
      const k = this.nPieces++;
      this.ka[k] = prevPoint;
      this.kb[k] = b;
      this.km[k] = -1;
      this.knext[k] = -1;
      if (prevPiece >= 0) this.knext[prevPiece] = k;
      else firstPiece = k;
      prevPiece = k;
      this.kerr[k] = this.pieceError(k);
      this.heapPush(k);
      prevPoint = b;
    }
    return firstPiece;
  }

  /** Evaluate position, projection and screen tangent at parameter u; returns the point index. */
  private evalPoint(curve: ViewConic, u: number): number {
    const i = this.nPoints++;
    let X: number;
    let Y: number;
    let dX: number;
    let dY: number;
    if (curve.kind === 'E') {
      const c = Math.cos(u);
      const s = Math.sin(u);
      X = curve.aAbs * (c - curve.e);
      Y = curve.b * s;
      dX = -curve.aAbs * s;
      dY = curve.b * c;
    } else {
      const t = this.tmp;
      curve.perifocalWithDerivative(u, t);
      X = t[0]!;
      Y = t[1]!;
      dX = t[2]!;
      dY = t[3]!;
    }
    const x = curve.ox + curve.px * X + curve.qx * Y;
    const y = curve.oy + curve.py * X + curve.qy * Y;
    const z = curve.oz + curve.pz * X + curve.qz * Y;
    this.pu[i] = u;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    const depth = -z;
    if (depth > this.near) {
      const inv = 1 / depth;
      const k = this.focal * inv;
      this.psx[i] = this.cx + x * k;
      this.psy[i] = this.cy - y * k;
      // d(screen)/du: x' = F (dx d + x dz) / d^2, y' = -F (dy d + y dz) / d^2 (d = -z)
      const dx = curve.px * dX + curve.qx * dY;
      const dy = curve.py * dX + curve.qy * dY;
      const dz = curve.pz * dX + curve.qz * dY;
      const tx = (dx + x * dz * inv) * k;
      const ty = -(dy + y * dz * inv) * k;
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl > 1e-12) {
        this.ptx[i] = tx / tl;
        this.pty[i] = ty / tl;
        this.pflags[i] = FRONT | TANGENT;
      } else this.pflags[i] = FRONT;
    } else {
      this.psx[i] = NaN;
      this.psy[i] = NaN;
      this.pflags[i] = 0;
    }
    return i;
  }

  /** Chord-error bound of a piece (0 when it is outside the frustum). */
  private pieceError(k: number): number {
    const a = this.ka[k]!;
    const b = this.kb[k]!;
    const ax = this.px[a]!;
    const ay = this.py[a]!;
    const az = this.pz[a]!;
    const bx = this.px[b]!;
    const by = this.py[b]!;
    const bz = this.pz[b]!;
    // Thales sphere of the chord contains the whole piece (heading turns < 90 degrees).
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const cz = (az + bz) / 2;
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const rad = 0.51 * Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-6 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (this.sphereOutside(cx, cy, cz, rad)) return 0;
    const fa = this.pflags[a]!;
    const fb = this.pflags[b]!;
    if (fa & fb & TANGENT) {
      // Tangent-triangle bound in screen space.
      const sx = this.psx[b]! - this.psx[a]!;
      const sy = this.psy[b]! - this.psy[a]!;
      const L = Math.sqrt(sx * sx + sy * sy);
      if (L > 1e-9) {
        const ux = sx / L;
        const uy = sy / L;
        const tax = this.ptx[a]!;
        const tay = this.pty[a]!;
        const tbx = this.ptx[b]!;
        const tby = this.pty[b]!;
        const ca = ux * tax + uy * tay;
        const cb = ux * tbx + uy * tby;
        if (ca > MIN_TANGENT_COS && cb > MIN_TANGENT_COS) {
          const ta = (ux * tay - uy * tax) / ca;
          const tb = (tbx * uy - tby * ux) / cb;
          if (ta * tb >= 0) {
            const t1 = Math.abs(ta);
            const t2 = Math.abs(tb);
            return t1 + t2 > 0 ? (L * t1 * t2) / (t1 + t2) : 0;
          }
          // Not convex within rounding: bounded by the steeper tangent line over the whole chord.
          return L * Math.max(Math.abs(ta), Math.abs(tb));
        }
      }
    }
    // Fallback: evaluate the midpoint and measure it (scaled so the one-point estimate keeps a margin).
    const m = this.evalPoint(this.curve!, (this.pu[a]! + this.pu[b]!) / 2);
    this.km[k] = m;
    const scale = 1 / MIDPOINT_MARGIN;
    if (fa & this.pflags[m]! & fb & FRONT) {
      return pointSegmentDistance2D(this.psx[m]!, this.psy[m]!, this.psx[a]!, this.psy[a]!, this.psx[b]!, this.psy[b]!) * scale;
    }
    // Near-plane piece: angle subtended by the sagitta at the eye, in pixels (x1.5 for off-axis stretch).
    const mx = this.px[m]!;
    const my = this.py[m]!;
    const mz = this.pz[m]!;
    const dev = pointSegmentDistance3D(mx, my, mz, ax, ay, az, bx, by, bz);
    const dist = Math.max(Math.sqrt(mx * mx + my * my + mz * mz), this.near);
    return (dev / dist) * this.focal * 1.5 * scale + (dev > 0 ? 1e-9 : 0);
  }

  private sphereOutside(x: number, y: number, z: number, r: number): boolean {
    if (z - r > -this.near) return true; // wholly behind the near plane
    const tx = this.ftx;
    const ty = this.fty;
    if ((x + z * tx) * this.fnx > r) return true;
    if ((-x + z * tx) * this.fnx > r) return true;
    if ((y + z * ty) * this.fny > r) return true;
    if ((-y + z * ty) * this.fny > r) return true;
    return false;
  }

  // ---------------------------------------------------------------------------------------- max-heap
  private heapPush(k: number): void {
    const h = this.heap;
    const e = this.kerr;
    let i = this.heapSize++;
    h[i] = k;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (e[h[parent]!]! >= e[k]!) break;
      h[i] = h[parent]!;
      i = parent;
    }
    h[i] = k;
  }

  private heapPop(): void {
    const h = this.heap;
    const e = this.kerr;
    const n = --this.heapSize;
    if (n <= 0) return;
    const k = h[n]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && e[h[c + 1]!]! > e[h[c]!]!) c++;
      if (e[h[c]!]! <= e[k]!) break;
      h[i] = h[c]!;
      i = c;
    }
    h[i] = k;
  }
}

export function pointSegmentDistance2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px - (ax + dx * t);
  const qy = py - (ay + dy * t);
  return Math.sqrt(qx * qx + qy * qy);
}

/** Parameter of the closest point on segment ab to p (clamped to [0, 1]). */
export function closestParam2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function pointSegmentDistance3D(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px - (ax + dx * t);
  const qy = py - (ay + dy * t);
  const qz = pz - (az + dz * t);
  return Math.sqrt(qx * qx + qy * qy + qz * qz);
}
