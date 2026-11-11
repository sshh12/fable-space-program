/**
 * Geometry vocabulary of the vehicle and pad generators: surfaces of revolution with painted regions and
 * corrugation, swept tubes, extrusions, boxes, parametric patches and loop zippers. Everything emits into a
 * MeshBuilder with analytic normals, tangents along the surface's "around" direction and UVs in metres.
 *
 * Azimuth `phi` is measured about +Y from +Z toward +X (the mould-line convention of the definitions):
 * P(r, phi, y) = (r sin phi, y, r cos phi).
 */
import type { Vec3Tuple } from '@/core/math';
import { uTilesPerMetre, type MatId } from '../materials';
import { add3, cross3, dot3, len3, norm3, scale3, sub3, xf, type MeshBuilder, type Xf } from './builder';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------- profiles

interface PPoint {
  r: number;
  y: number;
  hard: boolean;
  /** Material of the segment that STARTS at this point (undefined = the builder's current material). */
  mat: MatId | undefined;
}

/** A lathe profile in the (r, y) half plane. The surface normal is on the RIGHT of the travel direction. */
export class Profile {
  readonly pts: PPoint[] = [];
  loop = false;
  private cur: MatId | undefined;
  private readonly marks = new Map<string, number>();

  static at(r: number, y: number): Profile {
    const p = new Profile();
    p.pts.push({ r, y, hard: true, mat: undefined });
    return p;
  }

  /** Smooth point. */
  to(r: number, y: number): this {
    const last = this.pts[this.pts.length - 1]!;
    if (Math.abs(last.r - r) < 1e-9 && Math.abs(last.y - y) < 1e-9) return this;
    this.pts.push({ r, y, hard: false, mat: this.cur });
    last.mat = last.mat ?? this.cur;
    return this;
  }

  /** Point with a crease (split normals). */
  corner(r: number, y: number): this {
    this.to(r, y);
    this.pts[this.pts.length - 1]!.hard = true;
    return this;
  }

  /** Mark the last point as a crease. */
  hard(): this {
    this.pts[this.pts.length - 1]!.hard = true;
    return this;
  }

  /** Material of the segments that follow. */
  mat(id: MatId): this {
    this.cur = id;
    this.pts[this.pts.length - 1]!.mat = id;
    return this;
  }

  /** Remember the index of the last point under a name (for region spans). */
  mark(name: string): this {
    this.marks.set(name, this.pts.length - 1);
    return this;
  }

  index(name: string): number {
    const i = this.marks.get(name);
    if (i === undefined) throw new Error(`Profile: unknown mark "${name}"`);
    return i;
  }

  /** Circular arc about (cr, cy) from angle a0 to a1 (radians, 0 = +r, pi/2 = +y), n segments, smooth. */
  arc(cr: number, cy: number, radius: number, a0: number, a1: number, n: number): this {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      this.to(cr + radius * Math.cos(a), cy + radius * Math.sin(a));
    }
    return this;
  }

  /** Elliptical arc: r = cr + a cos t, y = cy + b sin t. */
  ellipse(cr: number, cy: number, a: number, b: number, t0: number, t1: number, n: number): this {
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      this.to(cr + a * Math.cos(t), cy + b * Math.sin(t));
    }
    return this;
  }

  /** Points of a function, t = 0..1 (the first sample is skipped when it repeats the last point). */
  fn(n: number, f: (t: number) => [number, number]): this {
    for (let i = 0; i <= n; i++) {
      const [r, y] = f(i / n);
      this.to(r, y);
    }
    return this;
  }

  /** Straight run to (r, y) cut into n equal segments. */
  line(r: number, y: number, n: number): this {
    const a = this.pts[this.pts.length - 1]!;
    const r0 = a.r;
    const y0 = a.y;
    for (let i = 1; i <= n; i++) this.to(r0 + ((r - r0) * i) / n, y0 + ((y - y0) * i) / n);
    return this;
  }

  /**
   * Make the profile run counter-clockwise in the (r, y) half plane (bottom outward, up the outside, top
   * inward), which is the direction that puts the normals outside a solid. Profiles written top-down are
   * reversed in place; segment materials and creases stay on their segments and points.
   */
  outward(): this {
    const n = this.pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i]!;
      const c = this.pts[(i + 1) % n]!;
      area += a.r * c.y - c.r * a.y;
    }
    if (area >= 0) return this;
    const mats = this.pts.map((p) => p.mat);
    this.pts.reverse();
    for (let j = 0; j < n; j++) this.pts[j]!.mat = j < n - 1 ? mats[n - 2 - j] : undefined;
    for (const [k, v] of this.marks) this.marks.set(k, n - 1 - v);
    return this;
  }

  /** Close the loop back to the first point (ring cross-sections). */
  close(): this {
    const f = this.pts[0]!;
    this.to(f.r, f.y);
    this.loop = true;
    return this;
  }

  /**
   * Insert points at the given heights on the straight segments between the marks `from` and `to`
   * (indices shift; marks are kept consistent).
   */
  splitAtY(from: string, to: string, ys: number[]): this {
    for (const y of ys) {
      const i0 = this.index(from);
      const i1 = this.index(to);
      for (let i = i0; i < i1; i++) {
        const a = this.pts[i]!;
        const c = this.pts[i + 1]!;
        const lo = Math.min(a.y, c.y);
        const hi = Math.max(a.y, c.y);
        if (y > lo + 1e-4 && y < hi - 1e-4) {
          const t = (y - a.y) / (c.y - a.y);
          this.pts.splice(i + 1, 0, { r: a.r + (c.r - a.r) * t, y, hard: false, mat: a.mat });
          for (const [k, v] of this.marks) if (v > i) this.marks.set(k, v + 1);
          break;
        }
      }
    }
    return this;
  }
}

// --------------------------------------------------------------------------------------------- lathe

export interface LatheRegion {
  /** Azimuth range (radians; phi1 > phi0, may run past 2 pi) and height range. */
  phi0: number;
  phi1: number;
  y0: number;
  y1: number;
  mat: MatId;
  /** Atlas rectangle [uLeft, vTop, uRight, vBottom]; without it the material tiles in metres. */
  uv?: [number, number, number, number];
  /** Rotate the image a quarter turn counter-clockwise (text reads upward). */
  rot?: boolean;
  /** Restrict to the profile segments between two marks. */
  span?: [string, string];
  /** Leave the cells out: an opening through the surface (declare the lathe `closed: false`). */
  hole?: boolean;
}

export interface MaskOut {
  wear: number;
  ao: number;
  soot: number;
  frost: number;
}

export interface LatheOpts {
  /** Segments around the full circle (ignored when `phis` is given). */
  segs?: number;
  /** Explicit ascending azimuths; the first and last bound the surface (a full turn when they differ by 2 pi). */
  phis?: number[];
  regions?: LatheRegion[];
  /** Per-vertex masks; starts from the builder's current mask values. */
  mask?: (y: number, phi: number, r: number, m: MaskOut) => void;
  /** Radial corrugation r + amp cos(n phi) on the profile points between two marks. */
  corr?: { n: number; amp: number; span: [string, string] };
  /** Declare the component watertight (default: full turn and the profile is a loop or starts and ends on the axis). */
  closed?: boolean;
  /** Partial revolution of a loop profile: close both cut faces with flat caps (a watertight sector). */
  capEnds?: boolean;
  /** Material of the cut faces (default: the builder's current material). */
  capMat?: MatId;
  /** Emit into the component that is already open instead of starting a new one. */
  join?: boolean;
  tag?: string;
}

/** n + 1 uniformly spaced azimuths over [phi0, phi1]. */
export function uniformPhis(n: number, phi0 = 0, phi1 = TAU): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(phi0 + ((phi1 - phi0) * i) / n);
  return out;
}

/**
 * A uniform grid of `segs` azimuths over the full circle with the nearest grid line moved onto each of
 * `bounds` (region edges), so painted regions end on grid lines without sliver cells.
 */
export function phisWith(segs: number, bounds: number[]): number[] {
  const phis = uniformPhis(segs);
  const taken = new Set<number>();
  const minGap = (TAU / segs) * 0.08;
  for (const raw of bounds) {
    const b = ((raw % TAU) + TAU) % TAU;
    let best = -1;
    let bd = Infinity;
    let nearest = Infinity;
    for (let i = 0; i <= segs; i++) {
      const d = Math.abs(phis[i]! - b);
      if (d < nearest) nearest = d;
      if (i > 0 && i < segs && d < bd && !taken.has(i)) {
        bd = d;
        best = i;
      }
    }
    // A line is already there (shared edge of two regions, or the seam): nothing to move.
    if (nearest < minGap || best < 0) continue;
    phis[best] = b;
    taken.add(best);
  }
  // Moving a line past a neighbour is harmless once the list is ascending again.
  phis.sort((a, c) => a - c);
  return phis;
}

/** Surface of revolution of `prof` about +Y. */
export function lathe(b: MeshBuilder, prof: Profile, o: LatheOpts = {}): void {
  const pts = prof.pts;
  const K = pts.length;
  if (K < 2) throw new Error('lathe: profile needs two points');
  const phis = o.phis ?? uniformPhis(o.segs ?? b.pick(96, 48, 16));
  const nPhi = phis.length - 1;
  const full = Math.abs(phis[nPhi]! - phis[0]! - TAU) < 1e-9;
  const onAxis = (k: number): boolean => pts[k]!.r < 1e-7;
  const capped = !full && !!o.capEnds && prof.loop;
  const closed = o.closed ?? (capped || (full && (prof.loop || (onAxis(0) && onAxis(K - 1)))));
  if (!o.join) b.begin(closed, o.tag ?? 'lathe');
  const baseMat = b.material;

  // Segment normals (right of travel) and cumulative arc length.
  const snr: number[] = [];
  const sny: number[] = [];
  const s: number[] = [0];
  for (let k = 0; k < K - 1; k++) {
    const dr = pts[k + 1]!.r - pts[k]!.r;
    const dy = pts[k + 1]!.y - pts[k]!.y;
    const l = Math.hypot(dr, dy);
    snr.push(dy / l);
    sny.push(-dr / l);
    s.push(s[k]! + l);
  }
  // Rings: one per smooth point, two per crease. ringA[k] ends segment k - 1, ringB[k] starts segment k.
  interface Ring {
    k: number;
    nr: number;
    ny: number;
  }
  const rings: Ring[] = [];
  const ringA: number[] = [];
  const ringB: number[] = [];
  const avg = (i: number, j: number): [number, number] => {
    const x = snr[i]! + snr[j]!;
    const y = sny[i]! + sny[j]!;
    const l = Math.hypot(x, y);
    return l > 1e-9 ? [x / l, y / l] : [snr[j]!, sny[j]!];
  };
  for (let k = 0; k < K; k++) {
    const first = k === 0;
    const last = k === K - 1;
    if (first || last) {
      const seg = first ? 0 : K - 2;
      let nr = snr[seg]!;
      let ny = sny[seg]!;
      if (prof.loop && !pts[0]!.hard) [nr, ny] = avg(K - 2, 0);
      else if (onAxis(k) && Math.abs(ny) > 0.5) {
        // Pole of a dome: the normal is the axis.
        nr = 0;
        ny = Math.sign(ny);
      }
      rings.push({ k, nr, ny });
      ringA[k] = ringB[k] = rings.length - 1;
    } else if (pts[k]!.hard) {
      rings.push({ k, nr: snr[k - 1]!, ny: sny[k - 1]! });
      ringA[k] = rings.length - 1;
      rings.push({ k, nr: snr[k]!, ny: sny[k]! });
      ringB[k] = rings.length - 1;
    } else {
      const [nr, ny] = avg(k - 1, k);
      rings.push({ k, nr, ny });
      ringA[k] = ringB[k] = rings.length - 1;
    }
  }

  const regions = o.regions ?? [];
  const spans = regions.map((r) => (r.span ? [prof.index(r.span[0]), prof.index(r.span[1])] : null));
  const corr = o.corr ? { n: o.corr.n, amp: o.corr.amp, i0: prof.index(o.corr.span[0]), i1: prof.index(o.corr.span[1]) } : null;
  // u radius per material: an integer number of tiles around the mean radius of the profile.
  let rRef = 0;
  for (const p of pts) rRef = Math.max(rRef, p.r);
  const ruOf = new Map<MatId, number>();
  const ru = (m: MatId): number => {
    let v = ruOf.get(m);
    if (v === undefined) {
      const t = uTilesPerMetre(m);
      v = t > 0 && full ? Math.max(1, Math.round(TAU * rRef * t)) / (TAU * t) : rRef;
      ruOf.set(m, v);
    }
    return v;
  };

  const nDomain = regions.length + 1;
  const vmap = new Map<number, number>();
  const mk: MaskOut = { wear: 0, ao: 1, soot: 0, frost: 0 };
  let domMat: MatId = baseMat;
  const vertex = (ring: number, i: number, dom: number, segMat: MatId): number => {
    // Base-domain vertices are shared only between cells of the same material (u scale depends on it).
    const key = (ring * (nPhi + 1) + i) * nDomain * 64 + dom * 64 + (dom === 0 ? matSlot(segMat) : 0);
    const hit = vmap.get(key);
    if (hit !== undefined) return hit;
    const R = rings[ring]!;
    const p = pts[R.k]!;
    const phi = phis[i]!;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    let r = p.r;
    let nr = R.nr;
    const ny = R.ny;
    let tgx = 0;
    if (corr && R.k >= corr.i0 && R.k <= corr.i1) {
      r += corr.amp * Math.cos(corr.n * phi);
      // The normal tilts against the radial slope dr/dphi.
      tgx = (corr.amp * corr.n * Math.sin(corr.n * phi)) / Math.max(r, 1e-6);
    }
    // Normal = nr * radial + ny * Y, tilted along the tangent by the corrugation slope.
    let nx = nr * sp + tgx * nr * cp;
    let nz = nr * cp - tgx * nr * sp;
    let nyy = ny;
    const nl = Math.hypot(nx, nyy, nz);
    nx /= nl;
    nyy /= nl;
    nz /= nl;
    // Tangent: around the axis, orthogonalised against the normal.
    let tx = cp;
    let ty = 0;
    let tz = -sp;
    const d = tx * nx + ty * nyy + tz * nz;
    tx -= d * nx;
    ty -= d * nyy;
    tz -= d * nz;
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let u: number;
    let v: number;
    if (dom === 0) {
      u = (phi - phis[0]!) * ru(segMat);
      v = s[R.k]!;
    } else {
      const g = regions[dom - 1]!;
      const tp = (phi - g.phi0 - TAU * Math.round((phi - (g.phi0 + g.phi1) / 2) / TAU)) / (g.phi1 - g.phi0);
      const tv = (p.y - g.y0) / (g.y1 - g.y0);
      if (g.uv) {
        const [u0, v0, u1, v1] = g.uv;
        if (g.rot) {
          u = u0 + (u1 - u0) * tv;
          v = v0 + (v1 - v0) * tp;
        } else {
          u = u0 + (u1 - u0) * tp;
          v = v1 + (v0 - v1) * tv;
        }
      } else {
        u = (phi - phis[0]!) * ru(g.mat);
        v = s[R.k]!;
      }
    }
    const idx = b.v(r * sp, p.y, r * cp, nx, nyy, nz, tx, ty, tz, u, v);
    if (o.mask) {
      mk.wear = b.wear;
      mk.ao = b.ao;
      mk.soot = b.soot;
      mk.frost = b.frost;
      o.mask(p.y, phi, r, mk);
      b.setMask(idx, mk.wear, mk.ao, mk.soot, mk.frost);
    }
    vmap.set(key, idx);
    return idx;
  };
  const slots = new Map<MatId, number>();
  const matSlot = (m: MatId): number => {
    let v = slots.get(m);
    if (v === undefined) {
      v = slots.size;
      if (v >= 64) throw new Error('lathe: too many materials in one profile');
      slots.set(m, v);
    }
    return v;
  };

  for (let k = 0; k < K - 1; k++) {
    const a = pts[k]!;
    const c = pts[k + 1]!;
    const segMat = a.mat ?? baseMat;
    const yc = (a.y + c.y) / 2;
    const ra = ringB[k]!;
    const rc = ringA[k + 1]!;
    const poleA = a.r < 1e-7;
    const poleC = c.r < 1e-7;
    if (poleA && poleC) continue;
    for (let i = 0; i < nPhi; i++) {
      const pc = (phis[i]! + phis[i + 1]!) / 2;
      let dom = 0;
      let m = segMat;
      for (let g = regions.length - 1; g >= 0; g--) {
        const R = regions[g]!;
        const sp = spans[g];
        if (sp && (k < sp[0]! || k >= sp[1]!)) continue;
        if (yc < R.y0 || yc > R.y1) continue;
        const rel = (((pc - R.phi0) % TAU) + TAU) % TAU;
        if (rel > R.phi1 - R.phi0) continue;
        dom = g + 1;
        m = R.mat;
        break;
      }
      if (dom > 0 && regions[dom - 1]!.hole) continue;
      if (m !== domMat) {
        b.mat(m);
        domMat = m;
      }
      const v00 = vertex(ra, i, dom, m);
      const v01 = vertex(ra, i + 1, dom, m);
      const v10 = vertex(rc, i, dom, m);
      const v11 = vertex(rc, i + 1, dom, m);
      if (poleA) b.tri(v00, v11, v10);
      else if (poleC) b.tri(v00, v01, v10);
      else b.quad(v00, v01, v11, v10);
    }
  }
  if (capped) {
    // Flat caps on the two cut faces. The loop runs counter-clockwise in (r, y), which is counter-clockwise
    // seen from the side the tangent points AWAY from: as is on the first face, reversed on the last.
    b.mat(o.capMat ?? baseMat);
    const poly: [number, number][] = [];
    for (let k = 0; k < K - 1; k++) poly.push([pts[k]!.r, pts[k]!.y]);
    const tris = triangulate(poly);
    for (const end of [0, 1]) {
      const phi = phis[end === 0 ? 0 : nPhi]!;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      const sgn = end === 0 ? -1 : 1;
      const ids = poly.map(([r, y]) => b.v(r * sp, y, r * cp, sgn * cp, 0, -sgn * sp, sp, 0, cp, r, y, end === 0 ? 1 : -1));
      for (let t = 0; t < tris.length; t += 3) {
        if (end === 0) b.tri(ids[tris[t]!]!, ids[tris[t + 1]!]!, ids[tris[t + 2]!]!);
        else b.tri(ids[tris[t]!]!, ids[tris[t + 2]!]!, ids[tris[t + 1]!]!);
      }
    }
  }
  if (b.material !== baseMat) b.mat(baseMat);
}

// -------------------------------------------------------------------------------- simple solids (lathes)

/** Closed frustum along +Y between y0 (radius r0) and y1 (radius r1). */
export function frustum(b: MeshBuilder, r0: number, r1: number, y0: number, y1: number, segs: number, tag = 'frustum'): void {
  lathe(b, Profile.at(0, y0).corner(r0, y0).corner(r1, y1).corner(0, y1), { segs, tag });
}

/** Closed cylinder between two points. */
export function rod(b: MeshBuilder, from: Vec3Tuple, to: Vec3Tuple, radius: number, segs: number, tag = 'rod'): void {
  const l = len3(sub3(to, from));
  if (l < 1e-6) return;
  b.at(xf.along(from, to), () => frustum(b, radius, radius, 0, l, segs, tag));
}

/** Closed ring of rectangular cross-section. */
export function ringSolid(b: MeshBuilder, rIn: number, rOut: number, y0: number, y1: number, segs: number, tag = 'ring'): void {
  lathe(b, Profile.at(rIn, y0).corner(rOut, y0).corner(rOut, y1).corner(rIn, y1).corner(rIn, y0).close(), { segs, tag });
}

/** Torus about +Y: major radius R at height y, tube radius r. */
export function torus(b: MeshBuilder, R: number, r: number, y: number, segs: number, tubeSegs: number, tag = 'torus'): void {
  const p = new Profile();
  for (let i = 0; i <= tubeSegs; i++) {
    // Travel counter-clockwise in (r, y): the right-hand normal then points out of the tube.
    const a = (i / tubeSegs) * TAU;
    const pr = R + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) p.pts.push({ r: pr, y: py, hard: false, mat: undefined });
    else if (i === tubeSegs) p.close();
    else p.to(pr, py);
  }
  lathe(b, p, { segs, tag });
}

/** Sphere (or ellipsoid with half height hy) centred on the axis at height y. */
export function ball(b: MeshBuilder, radius: number, y: number, segs: number, rings: number, hy = radius, tag = 'ball'): void {
  const p = Profile.at(0, y - hy);
  for (let i = 1; i < rings; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / rings;
    p.to(radius * Math.cos(a), y + hy * Math.sin(a));
  }
  p.to(0, y + hy);
  p.pts[0]!.hard = false;
  lathe(b, p, { segs, tag });
}

/** Pressure vessel: cylinder of the given length between hemi-ellipsoidal ends (total length = length + 2 dome). */
export function bottle(b: MeshBuilder, radius: number, length: number, dome: number, segs: number, tag = 'bottle'): void {
  const n = b.pick(8, 5, 3);
  const p = Profile.at(0, -dome);
  for (let i = 1; i <= n; i++) {
    const a = -Math.PI / 2 + ((Math.PI / 2) * i) / n;
    p.to(radius * Math.cos(a), dome * Math.sin(a));
  }
  for (let i = 0; i <= n; i++) {
    const a = ((Math.PI / 2) * i) / n;
    p.to(radius * Math.cos(a), length + dome * Math.sin(a));
  }
  p.pts[0]!.hard = false;
  lathe(b, p, { segs, tag });
}

// ----------------------------------------------------------------------------------------------- box

/** Axis-aligned closed box centred at `c` with full extents (sx, sy, sz). */
export function box(b: MeshBuilder, sx: number, sy: number, sz: number, c: Vec3Tuple = [0, 0, 0], tag = 'box'): void {
  b.begin(true, tag);
  const h: Vec3Tuple = [sx / 2, sy / 2, sz / 2];
  // normal axis, sign, tangent axis, bitangent axis with n = t x b.
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0],
  ];
  for (const [a, sgn, ta, ba] of faces) {
    const n: Vec3Tuple = [0, 0, 0];
    n[a] = sgn;
    const t: Vec3Tuple = [0, 0, 0];
    t[ta] = 1;
    const ids: number[] = [];
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const) {
      const p: Vec3Tuple = [c[0], c[1], c[2]];
      p[a]! += sgn * h[a]!;
      p[ta]! += (u * 2 - 1) * h[ta]!;
      p[ba]! += (v * 2 - 1) * h[ba]!;
      ids.push(b.vt(p, n, t, u * 2 * h[ta]!, v * 2 * h[ba]!));
    }
    b.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
  }
}

/** Box between two points: length along the segment, width along `xHint`, depth along the third axis. */
export function beam(b: MeshBuilder, from: Vec3Tuple, to: Vec3Tuple, width: number, depth: number, xHint: Vec3Tuple = [1, 0, 0], tag = 'beam'): void {
  const l = len3(sub3(to, from));
  if (l < 1e-6) return;
  b.at(xf.along(from, to, xHint), () => box(b, width, l, depth, [0, l / 2, 0], tag));
}

// ------------------------------------------------------------------------------------------ extrusion

/** Ear-clipping triangulation of a simple polygon (counter-clockwise). Returns index triples. */
export function triangulate(poly: readonly (readonly [number, number])[]): number[] {
  const n = poly.length;
  const idx: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const cross = (a: number, b2: number, c: number): number => {
    const A = poly[a]!;
    const B = poly[b2]!;
    const C = poly[c]!;
    return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  };
  // Closed test: a vertex ON the ear's diagonal also blocks the ear (it would become a T-junction).
  const inside = (a: number, b2: number, c: number, p: number): boolean => cross(a, b2, p) >= -1e-12 && cross(b2, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]!;
      const b2 = idx[i]!;
      const c = idx[(i + 1) % idx.length]!;
      if (cross(a, b2, c) <= 1e-12) continue;
      let ear = true;
      for (const p of idx) {
        if (p !== a && p !== b2 && p !== c && inside(a, b2, c, p)) {
          ear = false;
          break;
        }
      }
      if (ear) {
        out.push(a, b2, c);
        idx.splice(i, 1);
        cut = true;
        break;
      }
    }
    if (!cut) {
      // Collinear remainder: drop a vertex so the loop terminates.
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3 && Math.abs(cross(idx[0]!, idx[1]!, idx[2]!)) > 1e-12) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/**
 * Closed prism: polygon `poly` in the local XZ plane as [x, z] pairs, counter-clockwise seen from +Y
 * (looking down the -Y direction), extruded from y0 to y1. `smooth` shades the side as one curved surface.
 */
export function extrude(b: MeshBuilder, poly: readonly (readonly [number, number])[], y0: number, y1: number, smooth = false, tag = 'extrude'): void {
  b.begin(true, tag);
  const n = poly.length;
  // Seen from +Y a polygon that is counter-clockwise in (x, z) with z toward the viewer's bottom is
  // clockwise in the right-handed (z, x) sense; the side normal of edge a -> c is (dz, 0, -dx).
  const en: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const c = poly[(i + 1) % n]!;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    en.push([dz / l, -dx / l]);
  }
  let run = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const c = poly[(i + 1) % n]!;
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const prev = en[(i + n - 1) % n]!;
    const cur = en[i]!;
    const next = en[(i + 1) % n]!;
    const na: [number, number] = smooth ? norm2(prev[0] + cur[0], prev[1] + cur[1]) : cur;
    const nc: [number, number] = smooth ? norm2(cur[0] + next[0], cur[1] + next[1]) : cur;
    // Tangent T = Y x N, so that cross(N, T) = +Y (v runs up the extrusion, u from c toward a).
    const ta: Vec3Tuple = [na[1], 0, -na[0]];
    const tc: Vec3Tuple = [nc[1], 0, -nc[0]];
    const v0 = b.v(a[0], y0, a[1], na[0], 0, na[1], ta[0], 0, ta[2], -run, 0);
    const v1 = b.v(c[0], y0, c[1], nc[0], 0, nc[1], tc[0], 0, tc[2], -(run + l), 0);
    const v2 = b.v(c[0], y1, c[1], nc[0], 0, nc[1], tc[0], 0, tc[2], -(run + l), y1 - y0);
    const v3 = b.v(a[0], y1, a[1], na[0], 0, na[1], ta[0], 0, ta[2], -run, y1 - y0);
    b.quad(v0, v3, v2, v1);
    run += l;
  }
  const tris = triangulate(poly);
  const top: number[] = [];
  const bot: number[] = [];
  for (const p of poly) {
    top.push(b.v(p[0], y1, p[1], 0, 1, 0, 1, 0, 0, p[0], -p[1]));
    bot.push(b.v(p[0], y0, p[1], 0, -1, 0, 1, 0, 0, p[0], p[1]));
  }
  for (let i = 0; i < tris.length; i += 3) {
    // The polygon is counter-clockwise in (x, z), which is clockwise seen from +Y.
    b.tri(top[tris[i]!]!, top[tris[i + 2]!]!, top[tris[i + 1]!]!);
    b.tri(bot[tris[i]!]!, bot[tris[i + 1]!]!, bot[tris[i + 2]!]!);
  }
}

const norm2 = (x: number, y: number): [number, number] => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};

/** Regular polygon in (x, z), counter-clockwise in that plane. */
export function ngon(n: number, radius: number, rot = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    out.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return out;
}

/** Rectangle polygon (x half width, z half depth), optional chamfer. */
export function rectPoly(hx: number, hz: number, chamfer = 0): [number, number][] {
  if (chamfer <= 0)
    return [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ];
  const c = chamfer;
  return [
    [-hx + c, -hz],
    [hx - c, -hz],
    [hx, -hz + c],
    [hx, hz - c],
    [hx - c, hz],
    [-hx + c, hz],
    [-hx, hz - c],
    [-hx, -hz + c],
  ];
}

/** Prism of a section polygon between two points (I-beams, channels, hat stringers). */
export function section(b: MeshBuilder, poly: readonly (readonly [number, number])[], from: Vec3Tuple, to: Vec3Tuple, xHint: Vec3Tuple = [1, 0, 0], tag = 'section'): void {
  const l = len3(sub3(to, from));
  if (l < 1e-6) return;
  b.at(xf.along(from, to, xHint), () => extrude(b, poly, 0, l, false, tag));
}

/** I-beam section polygon: flange width w, depth d, flange and web thickness t. */
export function iSection(w: number, d: number, t: number): [number, number][] {
  const hw = w / 2;
  const hd = d / 2;
  const ht = t / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, -hd + t],
    [ht, -hd + t],
    [ht, hd - t],
    [hw, hd - t],
    [hw, hd],
    [-hw, hd],
    [-hw, hd - t],
    [-ht, hd - t],
    [-ht, -hd + t],
    [-hw, -hd + t],
  ];
}

// ---------------------------------------------------------------------------------------------- tubes

/** Polyline with every interior corner replaced by an arc of the given bend radius. */
export function fillet(points: Vec3Tuple[], radius: number, steps: number): Vec3Tuple[] {
  if (points.length < 3 || radius <= 0 || steps < 1) return points.slice();
  const out: Vec3Tuple[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const a = sub3(points[i - 1]!, p);
    const c = sub3(points[i + 1]!, p);
    const la = len3(a);
    const lc = len3(c);
    const ua = scale3(a, 1 / la);
    const uc = scale3(c, 1 / lc);
    const cosT = Math.max(-1, Math.min(1, dot3(ua, uc)));
    const theta = Math.acos(cosT);
    if (theta > Math.PI - 1e-3 || theta < 1e-3) {
      out.push(p);
      continue;
    }
    // Distance from the corner to the tangent points, limited by the leg lengths.
    const dMax = Math.min(la, lc) * 0.49;
    const d = Math.min(radius / Math.tan(theta / 2), dMax);
    const r = d * Math.tan(theta / 2);
    const bis = norm3(add3(ua, uc));
    const centre = add3(p, scale3(bis, r / Math.sin(theta / 2)));
    const t0 = add3(p, scale3(ua, d));
    const t1 = add3(p, scale3(uc, d));
    const e0 = sub3(t0, centre);
    const e1 = sub3(t1, centre);
    const sweep = Math.PI - theta;
    for (let k = 0; k <= steps; k++) {
      const w = k / steps;
      // Spherical interpolation of the radius vector.
      const s0 = Math.sin((1 - w) * sweep) / Math.sin(sweep);
      const s1 = Math.sin(w * sweep) / Math.sin(sweep);
      out.push(add3(centre, add3(scale3(e0, s0), scale3(e1, s1))));
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Arc about the +Y axis at height y from phi0 to phi1. */
export function arcPath(radius: number, y: number, phi0: number, phi1: number, steps: number): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = phi0 + ((phi1 - phi0) * i) / steps;
    out.push([radius * Math.sin(p), y, radius * Math.cos(p)]);
  }
  return out;
}

/** Catmull-Rom spline through the points, `steps` samples per span. */
export function spline(points: Vec3Tuple[], steps: number): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const q: Vec3Tuple = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        q[c] = 0.5 * (2 * p1[c]! + (-p0[c]! + p2[c]!) * t + (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * t2 + (-p0[c]! + 3 * p1[c]! - 3 * p2[c]! + p3[c]!) * t3);
      }
      out.push(q);
    }
  }
  out.push(points[n - 1]!);
  return out;
}

export interface TubeOpts {
  segs?: number;
  /** Close the path into a loop (no caps). */
  loop?: boolean;
  /** Leave the ends open (the component is then declared open). */
  open?: boolean;
  tag?: string;
}

/**
 * Tube of circular section swept along a path with parallel-transport frames. `radius` may vary along the
 * path (bellows, reducers). Capped and watertight unless `open`.
 */
export function tube(b: MeshBuilder, path: Vec3Tuple[], radius: number | ((i: number, n: number) => number), o: TubeOpts = {}): void {
  const segs = o.segs ?? b.pick(12, 8, 5);
  // Drop repeated points.
  const P: Vec3Tuple[] = [];
  for (const p of path) if (P.length === 0 || len3(sub3(p, P[P.length - 1]!)) > 1e-6) P.push(p);
  if (o.loop && P.length > 2 && len3(sub3(P[0]!, P[P.length - 1]!)) < 1e-6) P.pop();
  const n = P.length;
  if (n < 2) return;
  const loop = !!o.loop;
  b.begin(!o.open, o.tag ?? 'tube');
  const rad = (i: number): number => (typeof radius === 'number' ? radius : radius(i, n));
  const dirAt = (i: number): Vec3Tuple => {
    const a = P[loop ? (i + n - 1) % n : Math.max(0, i - 1)]!;
    const c = P[loop ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    return norm3(sub3(c, a));
  };
  const count = loop ? n + 1 : n;
  // Parallel-transport frames along the path.
  const frames: Vec3Tuple[] = [];
  const d0 = dirAt(0);
  let nx: Vec3Tuple = Math.abs(d0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  for (let k = 0; k < count; k++) {
    const dn = dirAt(k % n);
    nx = norm3(sub3(nx, scale3(dn, dot3(nx, dn))));
    frames.push(nx);
  }
  // A closed path can come back twisted: spread the opposite rotation over the rows so the last row
  // lands exactly on the first.
  let twist = 0;
  if (loop) {
    const a = frames[0]!;
    const c = frames[n]!;
    twist = Math.atan2(dot3(cross3(a, c), d0), dot3(a, c));
  }
  const rows: number[][] = [];
  // Ring positions in the caller's frame (the builder stores them transformed), for the end caps.
  const local: Vec3Tuple[][] = [];
  let run = 0;
  for (let k = 0; k < count; k++) {
    const i = k % n;
    const d = dirAt(i);
    let fx = frames[k]!;
    if (twist !== 0) {
      const w = (-twist * k) / n;
      const side = cross3(d, fx);
      fx = add3(scale3(fx, Math.cos(w)), scale3(side, Math.sin(w)));
    }
    const by = cross3(d, fx);
    if (k > 0) run += len3(sub3(P[i]!, P[(k - 1) % n]!));
    const r = rad(i);
    const row: number[] = [];
    const ringLocal: Vec3Tuple[] = [];
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * TAU;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const nrm: Vec3Tuple = [fx[0] * c + by[0] * s, fx[1] * c + by[1] * s, fx[2] * c + by[2] * s];
      // Around-direction tangent dN/da: cross(N, T) runs along the path, where v increases.
      const tg: Vec3Tuple = [by[0] * c - fx[0] * s, by[1] * c - fx[1] * s, by[2] * c - fx[2] * s];
      const p = P[i]!;
      ringLocal.push([p[0] + nrm[0] * r, p[1] + nrm[1] * r, p[2] + nrm[2] * r]);
      row.push(b.v(p[0] + nrm[0] * r, p[1] + nrm[1] * r, p[2] + nrm[2] * r, nrm[0], nrm[1], nrm[2], tg[0], tg[1], tg[2], a * r, run));
    }
    rows.push(row);
    local.push(ringLocal);
  }
  for (let k = 0; k < rows.length - 1; k++) {
    const r0 = rows[k]!;
    const r1 = rows[k + 1]!;
    for (let j = 0; j < segs; j++) b.quad(r0[j]!, r0[j + 1]!, r1[j + 1]!, r1[j]!);
  }
  if (loop || o.open) return;
  for (const end of [0, 1]) {
    const i = end === 0 ? 0 : n - 1;
    const dn = scale3(dirAt(i), end === 0 ? -1 : 1);
    const row = local[end === 0 ? 0 : local.length - 1]!;
    const t: Vec3Tuple = norm3(sub3(row[0]!, P[i]!));
    const c = b.vt(P[i]!, dn, t, 0, 0);
    const ring: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const q = row[j]!;
      const rel = sub3(q, P[i]!);
      ring.push(b.vt(q, dn, t, dot3(rel, t), dot3(rel, cross3(dn, t))));
    }
    for (let j = 0; j < segs; j++) {
      if (end === 0) b.tri(c, ring[j + 1]!, ring[j]!);
      else b.tri(c, ring[j]!, ring[j + 1]!);
    }
  }
}

/** Pipe through way-points with rounded bends. */
export function pipe(b: MeshBuilder, points: Vec3Tuple[], radius: number, bend: number, o: TubeOpts = {}): void {
  tube(b, fillet(points, bend, b.pick(5, 3, 1)), radius, o);
}

// -------------------------------------------------------------------------------------------- patches

export interface PatchVertex {
  p: Vec3Tuple;
  n: Vec3Tuple;
  /** Tangent (around direction); orthogonalised against the normal here. */
  t: Vec3Tuple;
  u: number;
  v: number;
}

/** Emit a vertex from a patch description. */
export function patchVertex(b: MeshBuilder, q: PatchVertex): number {
  const n = norm3(q.n);
  const t = norm3(sub3(q.t, scale3(n, dot3(q.t, n))));
  return b.vt(q.p, n, t, q.u, q.v);
}

/**
 * Parametric grid patch: f(s, t) for s, t in [0, 1], (nu x nv) cells, counter-clockwise when the normal is
 * dP/ds x dP/dt. Open sheet; start a component before calling. Returns the vertex index grid [row][col].
 */
export function gridPatch(b: MeshBuilder, nu: number, nv: number, f: (s: number, t: number) => PatchVertex): number[][] {
  const rows: number[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nu; i++) row.push(patchVertex(b, f(i / nu, j / nv)));
    rows.push(row);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) b.quad(rows[j]![i]!, rows[j]![i + 1]!, rows[j + 1]![i + 1]!, rows[j + 1]![i]!);
  return rows;
}

/**
 * Triangulate the band between two closed loops of vertex indices that wind the same way around a common
 * centre. `angA` / `angB` are each loop's angles about that centre, ascending and spanning less than a
 * full turn. `outerFirst` = loop A is the outer one and the front face looks along the loops' winding axis.
 */
export function zipLoops(b: MeshBuilder, A: number[], angA: number[], B: number[], angB: number[], flip = false): void {
  const na = A.length;
  const nb = B.length;
  const frac = (a: number): number => {
    const t = (a - angA[0]!) / TAU;
    return t - Math.floor(t);
  };
  // Loop parameters in [0, 1): A starts at 0; B is rotated to start at its smallest parameter.
  const tA = angA.map(frac);
  tA[0] = 0;
  const tBraw = angB.map(frac);
  let j0 = 0;
  for (let j = 1; j < nb; j++) if (tBraw[j]! < tBraw[j0]!) j0 = j;
  const tB: number[] = [];
  for (let j = 0; j < nb; j++) tB.push(tBraw[(j0 + j) % nb]!);
  let i = 0;
  let j = 0;
  while (i < na || j < nb) {
    const a0 = A[i % na]!;
    const b0 = B[(j0 + j) % nb]!;
    // Advance the loop whose next vertex comes first; each loop ends back on its first vertex.
    const nextA = i < na ? (i + 1 < na ? tA[i + 1]! : 1) : Infinity;
    const nextB = j < nb ? (j + 1 < nb ? tB[j + 1]! : 1 + tB[0]!) : Infinity;
    if (nextA <= nextB) {
      const a1 = A[(i + 1) % na]!;
      if (flip) b.tri(a0, b0, a1);
      else b.tri(a0, a1, b0);
      i++;
    } else {
      const b1 = B[(j0 + j + 1) % nb]!;
      if (flip) b.tri(a0, b0, b1);
      else b.tri(a0, b1, b0);
      j++;
    }
  }
}

// ---------------------------------------------------------------------------------------- small parts

/** Hex-head bolt standing on the local XZ plane at the origin, head height h, across-flats 2 r. */
export function bolt(b: MeshBuilder, r: number, h: number): void {
  extrude(b, ngon(6, r), 0, h, false, 'bolt');
}

/** Bolts on a circle about +Y at height y, heads pointing along +Y (or -Y when `down`). */
export function boltCircle(b: MeshBuilder, radius: number, y: number, count: number, r: number, h: number, down = false, phase = 0): void {
  for (let i = 0; i < count; i++) {
    const phi = phase + (i / count) * TAU;
    const t = xf.mul(xf.translate(radius * Math.sin(phi), y, radius * Math.cos(phi)), down ? xf.rotX(Math.PI) : xf.identity());
    b.at(t, () => bolt(b, r, h));
  }
}

/** Bolts on a cylinder wall, heads pointing radially outward (or inward). */
export function boltRing(b: MeshBuilder, radius: number, y: number, count: number, r: number, h: number, inward = false, phase = 0): void {
  for (let i = 0; i < count; i++) {
    const phi = phase + (i / count) * TAU;
    // Local +Y -> radial direction.
    const rad: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
    const from: Vec3Tuple = [radius * rad[0], y, radius * rad[2]];
    const to: Vec3Tuple = add3(from, scale3(rad, inward ? -1 : 1));
    b.at(xf.along(from, to, [0, 1, 0]), () => bolt(b, r, h));
  }
}

/** Run `fn` once per azimuth with the builder rotated about +Y. */
export function around(b: MeshBuilder, count: number, phase: number, fn: (i: number, phi: number) => void): void {
  for (let i = 0; i < count; i++) {
    const phi = phase + (i / count) * TAU;
    b.at(xf.rotY(phi), () => fn(i, phi));
  }
}

/** Transform that puts local +Y on the radial direction at azimuth phi, origin at (r, y): for radial fittings. */
export function radialFrame(r: number, phi: number, y: number): Xf {
  const rad: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
  const o: Vec3Tuple = [r * rad[0], y, r * rad[2]];
  return xf.along(o, add3(o, rad), [0, 1, 0]);
}
