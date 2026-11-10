/**
 * Clearance between two vessels: the minimum distance between their parts' envelopes, negative when
 * they interpenetrate. Vessels do not collide in this simulation (ARCHITECTURE section 1, row 27); this
 * query is how the staging tests and the mission test prove that every separation is clean.
 *
 * Envelopes:
 *  - a part is the solid cylinder PartDef.bounds (radius, yMin..yMax about the part's Y axis);
 *  - a part with a `legs` module is the cylinder around its hinges and its feet at the CURRENT deployment;
 *  - one jettisoned fairing panel (`#panel<k>`) is the solid sector of its panel between 0.6 and 1.0 of
 *    the bounds radius over the full height, sampled on a grid of PANEL_SAMPLES points (spacing about
 *    0.9 m for the lander fairing): the thick sector is a conservative stand-in for the thin shell.
 * Cylinder-cylinder distances are exact to about a millimetre (alternating projections); a negative value
 * is the smallest overlap along the separating-axis candidates, i.e. how far the parts would have to move
 * apart at least.
 */
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { legFootLocal, panelAzimuth } from './structure';
import type { PartRuntime, Vessel } from './types';

/** Panel sampling: radial x azimuthal x axial points. */
export const PANEL_SAMPLES = { radial: 3, azimuthal: 7, axial: 11 } as const;
export const PANEL_INNER_FRACTION = 0.6;

interface Cyl {
  kind: 'cyl';
  c: Vec3;
  a: Vec3;
  r: number;
  hh: number;
  bound: number;
}
interface Cloud {
  kind: 'cloud';
  c: Vec3;
  pts: Vec3[];
  bound: number;
}
type Shape = Cyl | Cloud;

function partShape(vessel: Vessel, p: PartRuntime, origin: Vec3): Shape {
  const b = p.def.bounds;
  const toWorld = (local: Vec3): Vec3 => v3.sub(v3.add(vessel.r, quat.rotate(vessel.q, v3.add(p.pos, quat.rotate(p.rot, local)))), origin);
  if (p.panel) {
    const pts: Vec3[] = [];
    const half = Math.PI / p.panel.count;
    const az0 = panelAzimuth(p.panel.index, p.panel.count);
    for (let i = 0; i < PANEL_SAMPLES.radial; i++) {
      const rad = b.radius * (PANEL_INNER_FRACTION + ((1 - PANEL_INNER_FRACTION) * i) / (PANEL_SAMPLES.radial - 1));
      for (let j = 0; j < PANEL_SAMPLES.azimuthal; j++) {
        const az = az0 - half + (2 * half * j) / (PANEL_SAMPLES.azimuthal - 1);
        for (let k = 0; k < PANEL_SAMPLES.axial; k++) {
          const y = b.yMin + ((b.yMax - b.yMin) * k) / (PANEL_SAMPLES.axial - 1);
          pts.push(toWorld({ x: rad * Math.sin(az), y, z: rad * Math.cos(az) }));
        }
      }
    }
    const c = toWorld({ x: 0, y: (b.yMin + b.yMax) / 2, z: 0 });
    let bound = 0;
    for (const q of pts) bound = Math.max(bound, v3.dist(q, c));
    return { kind: 'cloud', c, pts, bound };
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
  return {
    kind: 'cyl',
    c: toWorld({ x: 0, y: (yMin + yMax) / 2, z: 0 }),
    a: quat.rotate(vessel.q, quat.rotate(p.rot, { x: 0, y: 1, z: 0 })),
    r: radius,
    hh,
    bound: Math.hypot(radius, hh),
  };
}

/** Closest point of the solid cylinder to p. */
function projectCyl(c: Cyl, p: Vec3): Vec3 {
  const d = v3.sub(p, c.c);
  let y = v3.dot(d, c.a);
  const rad = v3.addScaled(d, c.a, -y);
  const rl = v3.len(rad);
  y = y < -c.hh ? -c.hh : y > c.hh ? c.hh : y;
  const s = rl > c.r ? c.r / rl : 1;
  return { x: c.c.x + c.a.x * y + rad.x * s, y: c.c.y + c.a.y * y + rad.y * s, z: c.c.z + c.a.z * y + rad.z * s };
}

/** Signed distance of a point to the solid cylinder (negative inside). */
function pointCyl(c: Cyl, p: Vec3): number {
  const d = v3.sub(p, c.c);
  const y = v3.dot(d, c.a);
  const rl = v3.len(v3.addScaled(d, c.a, -y));
  const dr = rl - c.r;
  const dy = Math.abs(y) - c.hh;
  if (dr <= 0 && dy <= 0) return Math.max(dr, dy);
  return Math.hypot(Math.max(dr, 0), Math.max(dy, 0));
}

function extent(c: Cyl, d: Vec3): number {
  const da = v3.dot(d, c.a);
  return c.hh * Math.abs(da) + c.r * Math.sqrt(Math.max(0, 1 - da * da));
}

function cylCyl(a: Cyl, b: Cyl): number {
  // Alternating projections onto two convex sets converge to a closest pair.
  let x = projectCyl(a, b.c);
  let y = projectCyl(b, x);
  let dist = v3.dist(x, y);
  for (let i = 0; i < 200; i++) {
    x = projectCyl(a, y);
    y = projectCyl(b, x);
    const d = v3.dist(x, y);
    const done = dist - d < 1e-7;
    dist = d;
    if (done || d < 1e-9) break;
  }
  if (dist > 1e-6) return dist;
  // Overlapping: smallest overlap along the candidate separating axes.
  const dc = v3.sub(b.c, a.c);
  const axes: Vec3[] = [a.a, b.a];
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
  if (a.kind === 'cyl' && b.kind === 'cyl') return cylCyl(a, b);
  if (a.kind === 'cloud' && b.kind === 'cloud') {
    let best = Infinity;
    for (const p of a.pts) for (const q of b.pts) best = Math.min(best, v3.dist(p, q));
    return best;
  }
  const cloud = (a.kind === 'cloud' ? a : b) as Cloud;
  const cyl = (a.kind === 'cyl' ? a : b) as Cyl;
  let best = Infinity;
  for (const p of cloud.pts) best = Math.min(best, pointCyl(cyl, p));
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
