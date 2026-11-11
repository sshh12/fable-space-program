/**
 * Capsule mould-line geometry for the cockpit interior. Everything here is derived from the shared
 * CapsuleMouldLineDef (data/defs/visuals/shared/<capsule>-mouldline.json); nothing restates its numbers.
 *
 * Frame: the capsule part frame (+Y nose, +X starboard, +Z dorsal). Azimuth A is measured about +Y from +Z
 * toward +X, so a point at radius r and azimuth A is (r sin A, y, r cos A).
 *
 * Openings (windows, hatch) are rounded rectangles in surface coordinates around their centre on the mould
 * line: u = arc length along the circle of constant y (tangential, +u toward increasing azimuth), v =
 * distance along the cone generator (+v toward the apex). Their inner outline, where the cockpit frames sit,
 * is the outer outline carried inward along the surface normal by the wall thickness.
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import { DEG, v3, type Vec3 } from '@/core/math';

export interface ConeGeometry {
  /** Outer cone: radius at y = yBottom and the slope dr/dy (negative). */
  r0: number;
  y0: number;
  y1: number;
  slope: number;
  /** Unit generator direction in the meridian plane (radial, y), pointing toward the apex. */
  genR: number;
  genY: number;
  /** Unit outward normal in the meridian plane (radial, y). */
  nR: number;
  nY: number;
  /** Horizontal distance between the outer and the inner (offset) cone. */
  radialOffset: number;
}

export interface Mould {
  def: CapsuleMouldLineDef;
  cone: ConeGeometry;
  wall: number;
  floorY: number;
  /** Inner radius of the apex tunnel and the y at which the inner cone meets it. */
  tunnelInnerRadius: number;
  tunnelJoinY: number;
  /** Outer radius of the cone at height y (valid on the cone's y range). */
  outerRadius(y: number): number;
  /** Inner (pressure wall + insulation offset) radius at height y, including the tunnel above tunnelJoinY. */
  innerRadius(y: number): number;
}

export function mouldOf(def: CapsuleMouldLineDef): Mould {
  const c = def.cone;
  const dr = c.radiusTop - def.heatShield.maxDiameter / 2;
  const dy = c.yTop - c.yBottom;
  const len = Math.hypot(dr, dy);
  const genR = dr / len;
  const genY = dy / len;
  // Outward normal: generator rotated by -90 deg in the (radial, y) plane.
  const nR = genY;
  const nY = -genR;
  const wall = def.wallThickness;
  const radialOffset = wall / nR;
  const r0 = def.heatShield.maxDiameter / 2;
  const slope = dr / dy;
  const tunnelInnerRadius = def.apexTunnel.radius - wall;
  const outerRadius = (y: number): number => r0 + slope * (y - c.yBottom);
  // The inner cone is the outer cone moved inward by `radialOffset`; it meets the inner tunnel wall where
  // its radius falls to the tunnel's inner radius.
  const tunnelJoinY = c.yBottom + (tunnelInnerRadius + radialOffset - r0) / slope;
  return {
    def,
    cone: { r0, y0: c.yBottom, y1: c.yTop, slope, genR, genY, nR, nY, radialOffset },
    wall,
    floorY: def.cabinFloorY,
    tunnelInnerRadius,
    tunnelJoinY,
    outerRadius,
    innerRadius: (y) => (y >= tunnelJoinY ? tunnelInnerRadius : outerRadius(y) - radialOffset),
  };
}

/** Unit radial direction at azimuth A (radians). */
export const radialDir = (az: number): Vec3 => ({ x: Math.sin(az), y: 0, z: Math.cos(az) });
/** Unit tangential direction (increasing azimuth) at azimuth A. */
export const tangentDir = (az: number): Vec3 => ({ x: Math.cos(az), y: 0, z: -Math.sin(az) });

/** Point on a surface of revolution at radius r, height y and azimuth A. */
export const revPoint = (r: number, y: number, az: number): Vec3 => ({ x: r * Math.sin(az), y, z: r * Math.cos(az) });

/** Radius about the Y axis and azimuth of a point. */
export const radiusOf = (p: Vec3): number => Math.hypot(p.x, p.z);
export const azimuthOf = (p: Vec3): number => Math.atan2(p.x, p.z);

/** Outward unit normal of the cone at azimuth A. */
export function coneNormal(m: Mould, az: number): Vec3 {
  const r = radialDir(az);
  return { x: r.x * m.cone.nR, y: m.cone.nY, z: r.z * m.cone.nR };
}

/** Generator direction (toward the apex) at azimuth A. */
export function coneGenerator(m: Mould, az: number): Vec3 {
  const r = radialDir(az);
  return { x: r.x * m.cone.genR, y: m.cone.genY, z: r.z * m.cone.genR };
}

/**
 * Point of the outer cone (`depth` = 0) or of a cone offset inward by `depth` along the normal, at surface
 * coordinates (u, v) around a centre given by azimuth and y on the OUTER mould line.
 */
export function conePointAt(m: Mould, centreAzDeg: number, centreY: number, u: number, v: number, depth = 0): Vec3 {
  const az0 = centreAzDeg * DEG;
  // Along the generator from the centre: the radius and height change linearly with v.
  const rC = m.outerRadius(centreY);
  const r = rC + v * m.cone.genR;
  const y = centreY + v * m.cone.genY;
  // u is arc length along the circle of the OUTER surface at that height.
  const az = az0 + u / r;
  const outer = revPoint(r, y, az);
  if (depth === 0) return outer;
  return v3.sub(outer, v3.scale(coneNormal(m, az), depth));
}

/** Local frame of an opening at its centre: tangential (+u), generator (+v), outward normal, all unit. */
export function openingFrame(m: Mould, azDeg: number, y: number): { t: Vec3; g: Vec3; n: Vec3; centreOuter: Vec3; centreInner: Vec3 } {
  const az = azDeg * DEG;
  const n = coneNormal(m, az);
  const centreOuter = revPoint(m.outerRadius(y), y, az);
  return { t: tangentDir(az), g: coneGenerator(m, az), n, centreOuter, centreInner: v3.sub(centreOuter, v3.scale(n, m.wall)) };
}

/**
 * Outline of a rounded rectangle (width along u, height along v, corner radius) as `count` points in (u, v),
 * counter-clockwise seen from inside the cabin looking out... (from +n looking inward it is clockwise),
 * starting at the middle of the +u edge. Points are spent where the outline curves: half of them on the four
 * corner arcs (an arc of 16 chords at 128 points: a machined radius, not a polygon), the rest along the
 * straight edges in proportion to their lengths.
 */
export function roundedRectOutline(width: number, height: number, cornerRadius: number, count: number): [number, number][] {
  const hw = width / 2;
  const hh = height / 2;
  const rc = Math.max(0, Math.min(cornerRadius, hw, hh));
  const sx = hw - rc;
  const sy = hh - rc;
  // Chords per corner, per vertical edge (even: the outline starts at its middle) and per horizontal edge.
  const straight = sx > 1e-9 || sy > 1e-9;
  let nc = rc > 1e-9 ? Math.max(1, straight ? Math.round(count / 8) : Math.floor(count / 4)) : 0;
  let rest = count - 4 * nc;
  let mv = 0;
  let mh = 0;
  const split = (): void => {
    const half = rest / 2;
    mv = sy > 1e-9 ? Math.max(2, 2 * Math.round((half * sy) / (sx + sy) / 2)) : 0;
    mh = sx > 1e-9 ? Math.max(1, Math.round(half - mv)) : 0;
    if (sx <= 1e-9) mv = Math.max(2, 2 * Math.round(half / 2));
  };
  split();
  // Whatever rounding left over goes to (or comes from) the corners.
  while (2 * mv + 2 * mh + 4 * nc > count && nc > 1) nc--;
  rest = count - 4 * nc;
  split();
  const out: [number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, n: number): void => {
    for (let i = 0; i < n; i++) out.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  const arc = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i < nc; i++) {
      const a = a0 + ((Math.PI / 2) * i) / nc;
      out.push([cx + rc * Math.cos(a), cy + rc * Math.sin(a)]);
    }
  };
  line(hw, 0, hw, sy, mv / 2);
  arc(sx, sy, 0);
  line(sx, hh, -sx, hh, mh);
  arc(-sx, sy, Math.PI / 2);
  line(-hw, sy, -hw, -sy, mv);
  arc(-sx, -sy, Math.PI);
  line(-sx, -hh, sx, -hh, mh);
  arc(sx, -sy, 1.5 * Math.PI);
  line(hw, -sy, hw, 0, mv / 2);
  return out;
}

/** Circle outline in (u, v). */
export function circleOutline(radius: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    out.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return out;
}

export interface Opening {
  id: string;
  kind: 'window' | 'hatch' | 'hatchWindow';
  azDeg: number;
  y: number;
  /** Outline in surface coordinates (u, v), closed implicitly. */
  outline(count: number): [number, number][];
  width: number;
  height: number;
  /** Corner radius of the rounded rectangle (half the width for a round opening). */
  cornerRadius: number;
}

/** Every opening of the shared file: the windows, the hatch and the hatch's round window (at the hatch centre). */
export function openingsOf(m: Mould): Opening[] {
  const out: Opening[] = m.def.windows.map((w) => ({
    id: w.id,
    kind: 'window' as const,
    azDeg: w.azimuthDeg,
    y: w.y,
    width: w.width,
    height: w.height,
    cornerRadius: w.shape === 'round' ? w.width / 2 : w.cornerRadius,
    outline: (n: number) => (w.shape === 'round' ? circleOutline(w.width / 2, n) : roundedRectOutline(w.width, w.height, w.cornerRadius, n)),
  }));
  const h = m.def.hatch;
  out.push({ id: 'hatch', kind: 'hatch', azDeg: h.azimuthDeg, y: h.y, width: h.width, height: h.height, cornerRadius: h.cornerRadius, outline: (n) => roundedRectOutline(h.width, h.height, h.cornerRadius, n) });
  out.push({ id: 'hatch-window', kind: 'hatchWindow', azDeg: h.azimuthDeg, y: h.y, width: 2 * h.window.radius, height: 2 * h.window.radius, cornerRadius: h.window.radius, outline: (n) => circleOutline(h.window.radius, n) });
  return out;
}

/** The inner outline of an opening (cabin side of the wall) as 3-D points in the part frame. */
export function innerOutline(m: Mould, o: Opening, count: number): Vec3[] {
  return o.outline(count).map(([u, v]) => conePointAt(m, o.azDeg, o.y, u, v, m.wall));
}

/**
 * Signed distance (m) of a point in the part frame from the OUTER mould line, positive inside the capsule.
 * Distances are to the profile polyline in the (radius, y) half-plane; points outside the closed profile
 * (closed by the axis) are negative. The tunnel's open top end is not a wall.
 */
export function insideDistance(def: CapsuleMouldLineDef, p: Vec3): number {
  const r = radiusOf(p);
  const y = p.y;
  const prof = def.profile;
  let best = Infinity;
  for (let i = 0; i + 1 < prof.length; i++) {
    const [ax, ay] = prof[i]!;
    const [bx, by] = prof[i + 1]!;
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((r - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    const d = Math.hypot(r - (ax + ex * t), y - (ay + ey * t));
    if (d < best) best = d;
  }
  // Inside test: crossing count of a ray toward +r against the polygon closed along the axis.
  const poly = [...prof, [0, prof[prof.length - 1]![1]] as [number, number]];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && r < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? best : -best;
}
