/**
 * Adaptive float64 sampling of a conic arc to a screen-space chord error.
 *
 * The arc is first cut into pieces whose velocity direction turns by at most 22.5 degrees (so every piece
 * lies inside the sphere that has its chord as diameter, which makes frustum culling of whole pieces
 * exact). Pieces are then refined greatest-error-first (a max-heap) until the projected midpoint of every
 * visible piece lies within CHORD_TOLERANCE_PX of its projected chord, or the vertex cap is reached.
 * Pieces wholly outside the view frustum are kept as single chords. Pieces that touch the near plane are
 * measured by the angle their sagitta subtends at the eye instead of in screen space.
 */
import { CHORD_TOLERANCE_PX, MAX_POINTS_PER_CURVE } from './constants';
import type { ViewConic } from './conicCurve';
import type { Projector } from './projection';

const MAX_TURN = Math.PI / 8;
/** Largest number of initial pieces (pathological ranges are capped, never looped forever). */
const MAX_INITIAL_PIECES = 512;
/** Frustum margin in device pixels (line half width + anti-aliasing + label slack). */
const CULL_MARGIN_PX = 16;

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
  /** Number of refinement steps that hit the vertex cap (0 = converged). */
  capped: boolean;
}

export class Sampler {
  private cap: number;
  // Scratch point storage (unordered); pieces refer to point indices.
  private pu: Float64Array;
  private px: Float64Array;
  private py: Float64Array;
  private pz: Float64Array;
  private psx: Float64Array;
  private psy: Float64Array;
  private pfront: Uint8Array;
  private nPoints = 0;
  // Pieces: endpoints a, b and midpoint m (point indices), error, list link.
  private ka: Int32Array;
  private kb: Int32Array;
  private km: Int32Array;
  private kerr: Float64Array;
  private knext: Int32Array;
  private nPieces = 0;
  private heap: Int32Array;
  private heapSize = 0;
  private readonly tmp = new Float64Array(2);
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
    };
  }

  /**
   * Sample `curve` between parameters u0 < u1. `tolerancePx` is the accepted chord error in device pixels.
   * Returns this.out (overwritten by the next call).
   */
  sample(curve: ViewConic, u0: number, u1: number, proj: Projector, tolerancePx = CHORD_TOLERANCE_PX, cap = this.cap): SampledCurve {
    this.nPoints = 0;
    this.nPieces = 0;
    this.heapSize = 0;
    const out = this.out;
    out.capped = false;
    if (!(u1 > u0) || !Number.isFinite(u0) || !Number.isFinite(u1)) {
      out.count = 0;
      return out;
    }
    const maxVerts = Math.min(cap, this.cap);
    // Initial pieces: bounded turning angle.
    const first = this.initialPieces(curve, u0, u1, proj);
    // Refinement, greatest error first.
    let vertices = this.nPieces + 1;
    while (this.heapSize > 0) {
      const k = this.heap[0]!;
      if (this.kerr[k]! <= tolerancePx) break;
      if (vertices >= maxVerts) {
        out.capped = true;
        break;
      }
      this.heapPop();
      const a = this.ka[k]!;
      const b = this.kb[k]!;
      const m = this.km[k]!;
      const ua = this.pu[a]!;
      const ub = this.pu[b]!;
      const um = this.pu[m]!;
      if (!(um > ua && ub > um)) continue; // parameter exhausted: accept as is
      const m1 = this.evalPoint(curve, (ua + um) / 2, proj);
      const m2 = this.evalPoint(curve, (um + ub) / 2, proj);
      // Piece k becomes the left half, a new piece follows it.
      const r = this.nPieces++;
      this.ka[r] = m;
      this.kb[r] = b;
      this.km[r] = m2;
      this.knext[r] = this.knext[k]!;
      this.kb[k] = m;
      this.km[k] = m1;
      this.knext[k] = r;
      this.kerr[k] = this.pieceError(k, proj);
      this.kerr[r] = this.pieceError(r, proj);
      this.heapPush(k);
      this.heapPush(r);
      vertices++;
    }
    // Walk the ordered list.
    let n = 0;
    for (let k = first; k >= 0; k = this.knext[k]!) {
      this.emit(n++, this.ka[k]!);
      if (this.knext[k]! < 0) this.emit(n++, this.kb[k]!);
    }
    out.count = n;
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

  private initialPieces(curve: ViewConic, u0: number, u1: number, proj: Projector): number {
    // Breakpoints: start with 4 uniform pieces, split any whose heading turns more than MAX_TURN.
    const stack: number[] = [];
    const breaks: number[] = [u0];
    const n0 = 4;
    for (let i = n0; i >= 1; i--) stack.push(u0 + ((u1 - u0) * i) / n0);
    let ua = u0;
    let ha = curve.heading(ua);
    while (stack.length > 0) {
      const ub = stack[stack.length - 1]!;
      const hb = curve.heading(ub);
      if (Math.abs(hb - ha) > MAX_TURN && breaks.length + stack.length < MAX_INITIAL_PIECES && ub - ua > 1e-12 * Math.max(1, Math.abs(ub))) {
        stack.push((ua + ub) / 2);
        continue;
      }
      stack.pop();
      breaks.push(ub);
      ua = ub;
      ha = hb;
    }
    let prevPoint = this.evalPoint(curve, breaks[0]!, proj);
    let firstPiece = -1;
    let prevPiece = -1;
    for (let i = 1; i < breaks.length; i++) {
      const b = this.evalPoint(curve, breaks[i]!, proj);
      const m = this.evalPoint(curve, (breaks[i - 1]! + breaks[i]!) / 2, proj);
      const k = this.nPieces++;
      this.ka[k] = prevPoint;
      this.kb[k] = b;
      this.km[k] = m;
      this.knext[k] = -1;
      if (prevPiece >= 0) this.knext[prevPiece] = k;
      else firstPiece = k;
      prevPiece = k;
      this.kerr[k] = this.pieceError(k, proj);
      this.heapPush(k);
      prevPoint = b;
    }
    return firstPiece;
  }

  private evalPoint(curve: ViewConic, u: number, proj: Projector): number {
    const i = this.nPoints++;
    const t = this.tmp;
    curve.perifocal(u, t);
    const X = t[0]!;
    const Y = t[1]!;
    const x = curve.ox + curve.px * X + curve.qx * Y;
    const y = curve.oy + curve.py * X + curve.qy * Y;
    const z = curve.oz + curve.pz * X + curve.qz * Y;
    this.pu[i] = u;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    const depth = -z;
    if (depth > proj.near) {
      const k = proj.focal / depth;
      this.psx[i] = proj.cx + x * k;
      this.psy[i] = proj.cy - y * k;
      this.pfront[i] = 1;
    } else {
      this.psx[i] = NaN;
      this.psy[i] = NaN;
      this.pfront[i] = 0;
    }
    return i;
  }

  /** Screen-space (or eye-angle) chord error of a piece; 0 when the piece is outside the frustum. */
  private pieceError(k: number, proj: Projector): number {
    const a = this.ka[k]!;
    const b = this.kb[k]!;
    const m = this.km[k]!;
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
    const rad = 0.5 * Math.hypot(bx - ax, by - ay, bz - az) * 1.02 + 1e-6 * Math.hypot(cx, cy, cz);
    if (this.sphereOutside(cx, cy, cz, rad, proj)) return 0;
    if (this.pfront[a] && this.pfront[b] && this.pfront[m]) {
      return pointSegmentDistance2D(this.psx[m]!, this.psy[m]!, this.psx[a]!, this.psy[a]!, this.psx[b]!, this.psy[b]!);
    }
    // Near-plane piece: angle subtended by the sagitta at the eye, in pixels (x1.5 for off-axis stretch).
    const mx = this.px[m]!;
    const my = this.py[m]!;
    const mz = this.pz[m]!;
    const dev = pointSegmentDistance3D(mx, my, mz, ax, ay, az, bx, by, bz);
    const dist = Math.max(Math.hypot(mx, my, mz), proj.near);
    return (dev / dist) * proj.focal * 1.5 + (dev > 0 ? 1e-9 : 0);
  }

  private sphereOutside(x: number, y: number, z: number, r: number, proj: Projector): boolean {
    if (z - r > -proj.near) return true; // wholly behind the near plane
    const tx = proj.tanHalfX * (1 + (2 * CULL_MARGIN_PX) / proj.width);
    const ty = proj.tanHalfY * (1 + (2 * CULL_MARGIN_PX) / proj.height);
    const nx = 1 / Math.sqrt(1 + tx * tx);
    const ny = 1 / Math.sqrt(1 + ty * ty);
    if ((x + z * tx) * nx > r) return true;
    if ((-x + z * tx) * nx > r) return true;
    if ((y + z * ty) * ny > r) return true;
    if ((-y + z * ty) * ny > r) return true;
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
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
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
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t), pz - (az + dz * t));
}
