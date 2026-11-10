/**
 * Clearance between two vessels: the minimum distance between their parts' envelopes, negative when
 * they interpenetrate. Vessels do not collide in this simulation (ARCHITECTURE section 1, row 27); this
 * query is how the staging tests and the mission test prove that every separation is clean.
 *
 * Envelopes (all solid, so nothing can pass through one unnoticed):
 *  - a part is the solid cylinder PartDef.bounds (radius, yMin..yMax about the part's Y axis);
 *  - a part with a `legs` module is the cylinder around its hinges and its feet at the CURRENT deployment;
 *  - one jettisoned fairing panel (`#panel<k>`) is the solid sector of its panel between 0.6 and 1.0 of
 *    the bounds radius over the full height - a thick stand-in that contains the thin shell and its
 *    taper. The sector is covered by PANEL_WEDGES convex prisms (each wedge between the chord of the
 *    inner arc and the tangent of the outer arc, so the cover is a superset of the sector: at most
 *    0.9 % of the radius larger), and distances are measured to those prisms.
 * Distances between convex envelopes come from alternating projections (exact to about a millimetre); a
 * negative value is the smallest overlap along the separating-axis candidates, i.e. how far the parts
 * would have to move apart at least.
 */
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { legFootLocal, panelAzimuth } from './structure';
import type { PartRuntime, Vessel } from './types';

/** Number of convex wedges that cover one fairing panel. */
export const PANEL_WEDGES = 6;
export const PANEL_INNER_FRACTION = 0.6;

interface Cyl {
  kind: 'cyl';
  c: Vec3;
  a: Vec3;
  r: number;
  hh: number;
  bound: number;
}
/** Right prism: a convex polygon in the plane spanned by u, w (coordinates relative to c), extruded +-hh along a. */
interface Prism {
  kind: 'prism';
  c: Vec3;
  a: Vec3;
  u: Vec3;
  w: Vec3;
  /** Polygon vertices, counter-clockwise in (u, w) coordinates: [u0, w0, u1, w1, ...]. */
  poly: number[];
  /** Outward unit edge normals in (u, w) coordinates, same layout (edge k runs from vertex k to k + 1). */
  normals: number[];
  hh: number;
  bound: number;
}
type Convex = Cyl | Prism;
interface Shape {
  c: Vec3;
  bound: number;
  pieces: Convex[];
}

function makePrism(c: Vec3, a: Vec3, u: Vec3, w: Vec3, pts: number[], hh: number): Prism {
  // Order the vertices counter-clockwise and derive the outward edge normals.
  const n = pts.length / 2;
  let area = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    area += pts[2 * k]! * pts[2 * j + 1]! - pts[2 * j]! * pts[2 * k + 1]!;
  }
  const poly: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = area >= 0 ? k : n - 1 - k;
    poly.push(pts[2 * s]!, pts[2 * s + 1]!);
  }
  const normals: number[] = [];
  let bound = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ex = poly[2 * j]! - poly[2 * k]!;
    const ey = poly[2 * j + 1]! - poly[2 * k + 1]!;
    const l = Math.hypot(ex, ey);
    normals.push(ey / l, -ex / l);
    bound = Math.max(bound, Math.hypot(poly[2 * k]!, poly[2 * k + 1]!, hh));
  }
  return { kind: 'prism', c, a, u, w, poly, normals, hh, bound };
}

function partShape(vessel: Vessel, p: PartRuntime, origin: Vec3): Shape {
  const b = p.def.bounds;
  const toWorld = (local: Vec3): Vec3 => v3.sub(v3.add(vessel.r, quat.rotate(vessel.q, v3.add(p.pos, quat.rotate(p.rot, local)))), origin);
  const dirWorld = (local: Vec3): Vec3 => quat.rotate(vessel.q, quat.rotate(p.rot, local));
  if (p.panel) {
    const half = Math.PI / p.panel.count;
    const az0 = panelAzimuth(p.panel.index, p.panel.count) - half;
    const step = (2 * half) / PANEL_WEDGES;
    const inner = b.radius * PANEL_INNER_FRACTION;
    // The outer edge of a wedge is the tangent at its mid azimuth, so the prism contains the arc.
    const outer = b.radius / Math.cos(step / 2);
    const a = dirWorld({ x: 0, y: 1, z: 0 });
    const u = dirWorld({ x: 1, y: 0, z: 0 });
    const w = dirWorld({ x: 0, y: 0, z: 1 });
    const hh = (b.yMax - b.yMin) / 2;
    const yMid = (b.yMin + b.yMax) / 2;
    const pieces: Convex[] = [];
    for (let k = 0; k < PANEL_WEDGES; k++) {
      const a0 = az0 + k * step;
      const a1 = a0 + step;
      // Azimuth is measured about +Y from +Z toward +X: a point is (rho sin az, rho cos az) in (x, z).
      const corners = [inner * Math.sin(a0), inner * Math.cos(a0), outer * Math.sin(a0), outer * Math.cos(a0), outer * Math.sin(a1), outer * Math.cos(a1), inner * Math.sin(a1), inner * Math.cos(a1)];
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < 4; i++) {
        cx += corners[2 * i]! / 4;
        cz += corners[2 * i + 1]! / 4;
      }
      for (let i = 0; i < 4; i++) {
        corners[2 * i] = corners[2 * i]! - cx;
        corners[2 * i + 1] = corners[2 * i + 1]! - cz;
      }
      pieces.push(makePrism(toWorld({ x: cx, y: yMid, z: cz }), a, u, w, corners, hh));
    }
    const c = toWorld({ x: 0, y: yMid, z: 0 });
    let bound = 0;
    for (const piece of pieces) bound = Math.max(bound, v3.dist(piece.c, c) + piece.bound);
    return { c, bound, pieces };
  }
  let radius = b.radius;
  let yMin = b.yMin;
  let yMax = b.yMax;
  for (let m = 0; m < p.def.modules.length; m++) {
    const md = p.def.modules[m]!;
    const ms = p.modules[m]!;
    if (md.type === 'legs' && ms.type === 'legs') {
      radius = 0;
      yMin = Infinity;
      yMax = -Infinity;
      for (let l = 0; l < md.legs.length; l++) {
        const pad = p.def.contactPoints?.[l]?.radius ?? 0.3;
        const foot = legFootLocal(md, l, ms.deploy);
        const hinge = md.legs[l]!.hinge;
        for (const q of [foot, hinge]) {
          radius = Math.max(radius, Math.hypot(q[0], q[2]) + pad);
          yMin = Math.min(yMin, q[1] - pad);
          yMax = Math.max(yMax, q[1] + pad);
        }
      }
    }
  }
  const hh = (yMax - yMin) / 2;
  const cyl: Cyl = {
    kind: 'cyl',
    c: toWorld({ x: 0, y: (yMin + yMax) / 2, z: 0 }),
    a: dirWorld({ x: 0, y: 1, z: 0 }),
    r: radius,
    hh,
    bound: Math.hypot(radius, hh),
  };
  return { c: cyl.c, bound: cyl.bound, pieces: [cyl] };
}

/** Closest point of a solid convex envelope to p. */
function project(s: Convex, p: Vec3): Vec3 {
  const d = v3.sub(p, s.c);
  let y = v3.dot(d, s.a);
  y = y < -s.hh ? -s.hh : y > s.hh ? s.hh : y;
  if (s.kind === 'cyl') {
    const rad = v3.addScaled(d, s.a, -v3.dot(d, s.a));
    const rl = v3.len(rad);
    const k = rl > s.r ? s.r / rl : 1;
    return { x: s.c.x + s.a.x * y + rad.x * k, y: s.c.y + s.a.y * y + rad.y * k, z: s.c.z + s.a.z * y + rad.z * k };
  }
  let pu = v3.dot(d, s.u);
  let pw = v3.dot(d, s.w);
  const poly = s.poly;
  const n = poly.length / 2;
  let outside = false;
  for (let k = 0; k < n; k++) {
    if ((pu - poly[2 * k]!) * s.normals[2 * k]! + (pw - poly[2 * k + 1]!) * s.normals[2 * k + 1]! > 0) {
      outside = true;
      break;
    }
  }
  if (outside) {
    // Closest point on the boundary of the polygon.
    let best = Infinity;
    let bu = pu;
    let bw = pw;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = poly[2 * k]!;
      const ay = poly[2 * k + 1]!;
      const ex = poly[2 * j]! - ax;
      const ey = poly[2 * j + 1]! - ay;
      let t = ((pu - ax) * ex + (pw - ay) * ey) / (ex * ex + ey * ey);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t;
      const qy = ay + ey * t;
      const dd = (pu - qx) * (pu - qx) + (pw - qy) * (pw - qy);
      if (dd < best) {
        best = dd;
        bu = qx;
        bw = qy;
      }
    }
    pu = bu;
    pw = bw;
  }
  return { x: s.c.x + s.a.x * y + s.u.x * pu + s.w.x * pw, y: s.c.y + s.a.y * y + s.u.y * pu + s.w.y * pw, z: s.c.z + s.a.z * y + s.u.z * pu + s.w.z * pw };
}

/** Half-width of the envelope along the unit direction d (support distance from its centre). */
function extent(s: Convex, d: Vec3): number {
  const da = v3.dot(d, s.a);
  if (s.kind === 'cyl') return s.hh * Math.abs(da) + s.r * Math.sqrt(Math.max(0, 1 - da * da));
  const du = v3.dot(d, s.u);
  const dw = v3.dot(d, s.w);
  let best = -Infinity;
  for (let k = 0; k < s.poly.length; k += 2) best = Math.max(best, s.poly[k]! * du + s.poly[k + 1]! * dw);
  return s.hh * Math.abs(da) + best;
}

/** Candidate separating axes contributed by one envelope: its axis, and for a prism its side-face normals. */
function faceAxes(s: Convex, out: Vec3[]): void {
  out.push(s.a);
  if (s.kind === 'prism') {
    for (let k = 0; k < s.normals.length; k += 2) out.push(v3.add(v3.scale(s.u, s.normals[k]!), v3.scale(s.w, s.normals[k + 1]!)));
  }
}

function convexDistance(a: Convex, b: Convex): number {
  // Alternating projections onto two convex sets converge to a closest pair.
  let x = project(a, b.c);
  let y = project(b, x);
  let dist = v3.dist(x, y);
  for (let i = 0; i < 200; i++) {
    x = project(a, y);
    y = project(b, x);
    const d = v3.dist(x, y);
    const done = dist - d < 1e-7;
    dist = d;
    if (done || d < 1e-9) break;
  }
  if (dist > 1e-6) return dist;
  // Overlapping: smallest overlap along the candidate separating axes.
  const dc = v3.sub(b.c, a.c);
  const axes: Vec3[] = [];
  faceAxes(a, axes);
  faceAxes(b, axes);
  const cr = v3.cross(a.a, b.a);
  if (v3.len(cr) > 1e-6) axes.push(v3.normalize(cr));
  if (v3.len(dc) > 1e-9) axes.push(v3.normalize(dc));
  for (const ax of [a.a, b.a]) {
    const lat = v3.addScaled(dc, ax, -v3.dot(dc, ax));
    if (v3.len(lat) > 1e-9) axes.push(v3.normalize(lat));
  }
  let pen = Infinity;
  for (const d of axes) {
    const o = extent(a, d) + extent(b, d) - Math.abs(v3.dot(dc, d));
    if (o < pen) pen = o;
  }
  return pen > 0 && Number.isFinite(pen) ? -pen : 0;
}

function shapeDistance(a: Shape, b: Shape): number {
  let best = Infinity;
  for (const p of a.pieces) {
    for (const q of b.pieces) {
      if (v3.dist(p.c, q.c) - p.bound - q.bound >= best) continue;
      const d = convexDistance(p, q);
      if (d < best) best = d;
    }
  }
  return best;
}

export interface ClearanceResult {
  /** Minimum distance between the envelopes, m; negative when they interpenetrate. */
  distance: number;
  /** Instance ids of the closest pair of parts (a from the first vessel, b from the second). */
  partA: string;
  partB: string;
}

/** Minimum distance between the part envelopes of two vessels, with the closest pair of parts. */
export function vesselClearanceDetail(a: Vessel, b: Vessel): ClearanceResult {
  const origin = a.r;
  const sa = a.parts.map((p) => partShape(a, p, origin));
  const sb = b.parts.map((p) => partShape(b, p, origin));
  let best = Infinity;
  let ia = -1;
  let ib = -1;
  for (let i = 0; i < sa.length; i++) {
    for (let j = 0; j < sb.length; j++) {
      const lower = v3.dist(sa[i]!.c, sb[j]!.c) - sa[i]!.bound - sb[j]!.bound;
      if (lower >= best) continue;
      const d = shapeDistance(sa[i]!, sb[j]!);
      if (d < best) {
        best = d;
        ia = i;
        ib = j;
      }
    }
  }
  return { distance: best, partA: ia >= 0 ? a.parts[ia]!.instanceId : '', partB: ib >= 0 ? b.parts[ib]!.instanceId : '' };
}

/** Minimum distance between the part envelopes of two vessels, m (negative when interpenetrating). */
export function vesselClearance(a: Vessel, b: Vessel): number {
  return vesselClearanceDetail(a, b).distance;
}
