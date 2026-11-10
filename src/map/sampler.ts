/**
 * Adaptive float64 sampling of a conic arc to a screen-space chord error.
 *
 * 1. The arc is cut into initial pieces whose velocity direction turns by at most 22.5 degrees (45 for
 *    faint lines) and whose eccentric anomaly spans at most 90 degrees, so every piece lies inside the
 *    sphere that has its chord as diameter (Thales): a piece whose sphere is outside the view frustum is
 *    kept as one chord without further work, and a whole ellipse outside the frustum is not sampled at all.
 * 2. The chord error of a piece is computed EXACTLY, without evaluating the curve again. A conic arc is a
 *    rational quadratic Bezier curve: end points A, B, control point T (where the end tangents meet) and
 *    middle weight w (cos of half the eccentric-anomaly span; cosh of half the hyperbolic-anomaly span).
 *    A perspective projection maps it to a rational quadratic Bezier on screen with control points A', T',
 *    B' and weights (depth A, w depth T, depth B), as long as A, T and B lie in front of the eye. With the
 *    end weights normalised, w' = w depth(T) / sqrt(depth(A) depth(B)), and the curve's greatest distance
 *    from the chord LINE is exactly h w' / (1 + w'), h being the distance of T' from that line (reached at
 *    the parameter midpoint). When T' projects inside the chord (both base angles of the triangle A'T'B'
 *    acute) every curve point does, so that is also the distance to the chord SEGMENT. Otherwise (a hairpin
 *    of an orbit seen nearly edge-on, where the curve overshoots an end point) the curve lies inside the
 *    triangle A'T'B', so its distance to the segment is bounded by that of T', and the piece is split until
 *    the triangle is acute. Pieces are refined greatest-error-first (a max-heap) until every error is under
 *    the tolerance or the vertex cap is reached; each refinement step evaluates exactly one new vertex.
 * 3. A piece whose triangle reaches the near plane (it passes right next to or behind the eye) evaluates its
 *    midpoint instead and uses the angle its 3-D sagitta subtends at the eye, in pixels.
 * In the parabolic band (|e - 1| < 1e-6, sampled in true anomaly) T comes from the end tangents and the
 * weight is not known: h itself (w' / (1 + w') < 1) bounds the error there.
 */
import { CHORD_TOLERANCE_PX, MAX_POINTS_PER_CURVE } from './constants';
import type { ViewConic } from './conicCurve';
import type { Projector } from './projection';

/** Largest velocity-direction turn of an initial piece (patches); faint lines may pass up to pi/4. */
const MAX_TURN = Math.PI / 8;
export const FAINT_MAX_TURN = Math.PI / 4;
/** Largest eccentric-anomaly span of an initial piece (keeps the Bezier control point finite and close). */
const MAX_E_SPAN = Math.PI / 2;
/** Largest number of initial pieces (pathological ranges are capped, never looped forever). */
const MAX_INITIAL_PIECES = 512;
/** Frustum margin in device pixels (line half width + anti-aliasing + label slack). */
const CULL_MARGIN_PX = 16;
/** The near-plane fallback measures the deviation at one point only: keep a margin below the tolerance. */
const MIDPOINT_MARGIN = 0.85;

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

export class Sampler {
  private cap: number;
  // Scratch point storage (unordered); pieces refer to point indices.
  private pu: Float64Array;
  private px: Float64Array;
  private py: Float64Array;
  private pz: Float64Array;
  /** Unit-curve coordinates of the point: (cos E, sin E), (cosh H, sinh H) or (cos nu, sin nu). */
  private pc: Float64Array;
  private ps: Float64Array;
  private psx: Float64Array;
  private psy: Float64Array;
  private pfront: Uint8Array;
  private nPoints = 0;
  // Pieces: endpoints a, b, evaluated midpoint m (-1: none), error, list link.
  private ka: Int32Array;
  private kb: Int32Array;
  private km: Int32Array;
  private kerr: Float64Array;
  private knext: Int32Array;
  private nPieces = 0;
  private heap: Int32Array;
  private heapSize = 0;
  private readonly tmp = new Float64Array(4);
  private readonly tmp2 = new Float64Array(4);
  private readonly breaks: number[] = [];
  private readonly stack: number[] = [];
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
    this.pc = new Float64Array(nPts);
    this.ps = new Float64Array(nPts);
    this.psx = new Float64Array(nPts);
    this.psy = new Float64Array(nPts);
    this.pfront = new Uint8Array(nPts);
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
    const breaks = this.breaks;
    breaks.length = 0;
    breaks.push(u0);
    const rate = curve.maxTurnRate();
    if (rate !== null && rate < 2) {
      // Ellipse of moderate eccentricity: uniform steps bounded by the maximum turning rate (a/b >= 1, so
      // the eccentric-anomaly span of a piece stays under maxTurn as well).
      const n = Math.min(MAX_INITIAL_PIECES, Math.max(2, Math.ceil(((u1 - u0) * rate) / maxTurn)));
      for (let i = 1; i <= n; i++) breaks.push(u0 + ((u1 - u0) * i) / n);
    } else {
      // Otherwise: 4 uniform pieces, split any whose heading turns more than maxTurn (or, on an ellipse,
      // whose eccentric anomaly spans more than MAX_E_SPAN).
      const stack = this.stack;
      stack.length = 0;
      const n0 = 4;
      for (let i = n0; i >= 1; i--) stack.push(u0 + ((u1 - u0) * i) / n0);
      const spanLimit = curve.kind === 'E' ? MAX_E_SPAN : Infinity;
      let ua = u0;
      let ha = curve.heading(ua);
      while (stack.length > 0) {
        const ub = stack[stack.length - 1]!;
        const hb = curve.heading(ub);
        if ((Math.abs(hb - ha) > maxTurn || ub - ua > spanLimit) && breaks.length + stack.length < MAX_INITIAL_PIECES && ub - ua > 1e-12 * Math.max(1, Math.abs(ub))) {
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

  /** Evaluate the view-space position and projection at parameter u; returns the point index. */
  private evalPoint(curve: ViewConic, u: number): number {
    const i = this.nPoints++;
    let c: number;
    let s: number;
    let X: number;
    let Y: number;
    if (curve.kind === 'E') {
      c = Math.cos(u);
      s = Math.sin(u);
      X = curve.aAbs * (c - curve.e);
      Y = curve.b * s;
    } else if (curve.kind === 'H') {
      c = Math.cosh(u);
      s = Math.sinh(u);
      X = curve.aAbs * (curve.e - c);
      Y = curve.b * s;
    } else {
      c = Math.cos(u);
      s = Math.sin(u);
      const r = curve.p / (1 + curve.e * c);
      X = r * c;
      Y = r * s;
    }
    const x = curve.ox + curve.px * X + curve.qx * Y;
    const y = curve.oy + curve.py * X + curve.qy * Y;
    const z = curve.oz + curve.pz * X + curve.qz * Y;
    this.pu[i] = u;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.pc[i] = c;
    this.ps[i] = s;
    const depth = -z;
    if (depth > this.near) {
      const k = this.focal / depth;
      this.psx[i] = this.cx + x * k;
      this.psy[i] = this.cy - y * k;
      this.pfront[i] = 1;
    } else {
      this.psx[i] = NaN;
      this.psy[i] = NaN;
      this.pfront[i] = 0;
    }
    return i;
  }

  /**
   * Bezier control point of piece (a, b) in perifocal coordinates, written to tmp[0..1]. Returns its weight
   * (NaN when unknown: parabolic band), or null when the piece has no usable control point.
   */
  private controlPoint(curve: ViewConic, a: number, b: number): number | null {
    const t = this.tmp;
    if (curve.kind === 'E' || curve.kind === 'H') {
      const ca = this.pc[a]!;
      const sa = this.ps[a]!;
      const cb = this.pc[b]!;
      const sb = this.ps[b]!;
      // cos / cosh of the parameter span (cosh from the span itself: the products cancel badly far out).
      const cosSpan = curve.kind === 'E' ? ca * cb + sa * sb : Math.cosh(this.pu[b]! - this.pu[a]!);
      const den = 1 + cosSpan;
      if (!(den > 1e-6)) return null;
      // On the unit circle / hyperbola the tangents at the ends meet at the chord midpoint divided by
      // cos^2(span / 2) = (1 + cos span) / 2; the perifocal conic is an affine image of it.
      const tu = (ca + cb) / den;
      const tv = (sa + sb) / den;
      t[0] = curve.kind === 'E' ? curve.aAbs * (tu - curve.e) : curve.aAbs * (curve.e - tu);
      t[1] = curve.b * tv;
      return Math.sqrt(den / 2);
    }
    // Parabolic band: intersect the end tangents (perifocal plane).
    const da = this.tmp2;
    curve.perifocalWithDerivative(this.pu[a]!, da);
    const ax = da[0]!;
    const ay = da[1]!;
    const tax = da[2]!;
    const tay = da[3]!;
    curve.perifocalWithDerivative(this.pu[b]!, da);
    const bx = da[0]!;
    const by = da[1]!;
    const tbx = da[2]!;
    const tby = da[3]!;
    // a + s ta = b - r tb
    const det = tax * tby - tay * tbx;
    const ex = bx - ax;
    const ey = by - ay;
    if (Math.abs(det) <= 1e-12 * Math.hypot(tax, tay) * Math.hypot(tbx, tby)) {
      // Parallel tangents: a straight piece (its control point is anywhere on the chord).
      t[0] = (ax + bx) / 2;
      t[1] = (ay + by) / 2;
      return NaN;
    }
    const sParam = (ex * tby - ey * tbx) / det;
    const rParam = (tax * ey - tay * ex) / det;
    if (sParam < 0 || rParam < 0) return null;
    t[0] = ax + sParam * tax;
    t[1] = ay + sParam * tay;
    return NaN;
  }

  /** Exact chord error of a piece in device px (0 when it is outside the frustum); see the module comment. */
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
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const mz = (az + bz) / 2;
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const rad = 0.51 * Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-6 * Math.sqrt(mx * mx + my * my + mz * mz);
    if (this.sphereOutside(mx, my, mz, rad)) return 0;
    const curve = this.curve!;
    if (this.pfront[a]! & this.pfront[b]!) {
      const w = this.controlPoint(curve, a, b);
      if (w !== null) {
        const X = this.tmp[0]!;
        const Y = this.tmp[1]!;
        const tx = curve.ox + curve.px * X + curve.qx * Y;
        const ty = curve.oy + curve.py * X + curve.qy * Y;
        const tz = curve.oz + curve.pz * X + curve.qz * Y;
        const dT = -tz;
        if (dT > this.near) {
          const f = this.focal / dT;
          const Tx = this.cx + tx * f;
          const Ty = this.cy - ty * f;
          const sax = this.psx[a]!;
          const say = this.psy[a]!;
          const cxs = this.psx[b]! - sax;
          const cys = this.psy[b]! - say;
          const qx = Tx - sax;
          const qy = Ty - say;
          const L2 = cxs * cxs + cys * cys;
          if (!(L2 > 1e-18)) return Math.sqrt(qx * qx + qy * qy);
          const lambda = (qx * cxs + qy * cys) / L2;
          if (lambda >= 0 && lambda <= 1) {
            const h = Math.abs(qx * cys - qy * cxs) / Math.sqrt(L2);
            if (Number.isNaN(w)) return h;
            const wn = (w * dT) / Math.sqrt(-az * -bz);
            return (h * wn) / (1 + wn);
          }
          // Obtuse base angle: bounded by the distance of T' from the segment.
          const ox = lambda < 0 ? qx : Tx - this.psx[b]!;
          const oy = lambda < 0 ? qy : Ty - this.psy[b]!;
          return Math.sqrt(ox * ox + oy * oy);
        }
      }
    }
    // Near the eye: evaluate the midpoint; the angle its 3-D sagitta subtends at the eye, in pixels (x1.5
    // for the off-axis stretch), with a margin because one point is measured.
    let m = this.km[k]!;
    if (m < 0) {
      m = this.evalPoint(curve, (this.pu[a]! + this.pu[b]!) / 2);
      this.km[k] = m;
    }
    const px = this.px[m]!;
    const py = this.py[m]!;
    const pz = this.pz[m]!;
    const dev = pointSegmentDistance3D(px, py, pz, ax, ay, az, bx, by, bz);
    const dist = Math.max(Math.sqrt(px * px + py * py + pz * pz), this.near);
    return ((dev / dist) * this.focal * 1.5) / MIDPOINT_MARGIN + (dev > 0 ? 1e-9 : 0);
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
