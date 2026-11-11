/**
 * CPU half of the cabin light (the shader half is the "cockpit_cabin" chunk in shaders.ts): the polygon
 * sources of this frame in the capsule part frame.
 *
 *  - windows: the inner pane outline as an area-equivalent quad, outward normal, glass transmittance;
 *  - sun patches: for every window the sun shines into, the window quad projected along the sun onto the
 *    surface its centre ray hits (inner wall, floor, docking hatch, or one of the build's proxy boxes),
 *    glowing with that surface's reflected sunlight rho E cos / pi;
 *  - floodlights (lens strips, luminance = flux / (pi area)) and displays (their image's mean is read on the
 *    GPU from the last mip).
 * Pure: unit-tested without a GPU.
 */
import { v3, type Vec3 } from '@/core/math';
import type { CockpitModel } from './build';
import type { ProxyBox, WindowMeta } from './cabin/context';
import { radiusOf } from './mould';

export const MAX_CABIN_POLYS = 24;
export const POLY_WINDOW = 0;
export const POLY_PATCH = 1;
export const POLY_FLOOD = 2;
export const POLY_DISPLAY = 3;

export interface CabinPoly {
  kind: number;
  /** Corners in the part frame, wound consistently. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** Emitting / outward normal (part frame). */
  normal: Vec3;
  /** Radiance (cd/m^2; windows: glass transmittance per channel; displays: unused) and area (m^2). */
  radiance: [number, number, number];
  area: number;
  on: boolean;
  /** Display layer / window index. */
  index: number;
}

export interface SunInput {
  /** Unit direction to the sun in the PART frame, illuminance at the vessel (lux, eclipses included, no atmosphere) and colour. */
  dirPart: Vec3;
  illuminance: number;
  color: [number, number, number];
}

/** Area-equivalent quad of a window's inner pane in its own plane. */
export function windowQuad(w: WindowMeta): { corners: [Vec3, Vec3, Vec3, Vec3]; area: number; centre: Vec3; outward: Vec3 } {
  const pane = w.panes[w.panes.length - 1]!;
  const f = pane.frame;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pane.outline) {
    const d = v3.sub(p, f.o);
    const a = v3.dot(d, f.x);
    const b = v3.dot(d, f.y);
    x0 = Math.min(x0, a);
    x1 = Math.max(x1, a);
    y0 = Math.min(y0, b);
    y1 = Math.max(y1, b);
  }
  const area = w.area;
  const k = Math.sqrt(area / Math.max(1e-6, (x1 - x0) * (y1 - y0)));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = ((x1 - x0) / 2) * k;
  const hy = ((y1 - y0) / 2) * k;
  const at = (a: number, b: number): Vec3 => v3.add(f.o, v3.add(v3.scale(f.x, a), v3.scale(f.y, b)));
  return { corners: [at(cx - hx, cy - hy), at(cx + hx, cy - hy), at(cx + hx, cy + hy), at(cx - hx, cy + hy)], area, centre: at(cx, cy), outward: v3.neg(f.n) };
}

/** Per-pane transmittance at normal incidence (two surfaces, Fresnel F0 from the ior) times the tint, for all panes. */
export function glassTransmittance(model: CockpitModel): [number, number, number] {
  const w = model.layout.windows;
  const f0 = ((w.ior - 1) / (w.ior + 1)) ** 2;
  const per = (1 - f0) ** 2;
  const n = w.panes.length;
  return [(per * w.tint[0]) ** n, (per * w.tint[1]) ** n, (per * w.tint[2]) ** n];
}

interface Hit {
  t: number;
  n: Vec3;
  albedo: number;
}

/** Nearest hit of a ray inside the cabin: inner cone, apex tunnel, docking hatch, floor, proxy boxes. */
export function castCabinRay(model: CockpitModel, o: Vec3, d: Vec3): Hit | null {
  const m = model.mould;
  const wall = m.wallThickness;
  let best: Hit | null = null;
  const consider = (h: Hit | null): void => {
    if (h && h.t > 1e-4 && (!best || h.t < best.t)) best = h;
  };
  // Inner cone: r = a + b y with a = r0 - slope y0 - offset, b = slope.
  const prof = model.mould.profile;
  const r0 = model.mould.heatShield.maxDiameter / 2;
  const c = model.mould.cone;
  const slope = (c.radiusTop - r0) / (c.yTop - c.yBottom);
  const nR = (c.yTop - c.yBottom) / Math.hypot(c.radiusTop - r0, c.yTop - c.yBottom);
  const offset = wall / nR;
  const A = r0 - slope * c.yBottom - offset;
  // x^2 + z^2 = (A + B y)^2 along o + t d.
  const B = slope;
  const qa = d.x * d.x + d.z * d.z - B * B * d.y * d.y;
  const qb = 2 * (o.x * d.x + o.z * d.z - (A + B * o.y) * B * d.y);
  const qc = o.x * o.x + o.z * o.z - (A + B * o.y) ** 2;
  const disc = qb * qb - 4 * qa * qc;
  const tunnelR = m.apexTunnel.radius - wall;
  const joinY = (tunnelR - A) / B;
  if (disc >= 0 && Math.abs(qa) > 1e-12) {
    for (const s of [-1, 1]) {
      const t = (-qb + s * Math.sqrt(disc)) / (2 * qa);
      const p = v3.addScaled(o, d, t);
      if (t > 1e-4 && p.y >= m.cabinFloorY && p.y <= joinY && A + B * p.y > 0) {
        const r = radiusOf(p) || 1;
        const n = v3.normalize({ x: (-p.x / r) * nR, y: -Math.sqrt(1 - nR * nR), z: (-p.z / r) * nR });
        consider({ t, n, albedo: 0.55 });
      }
    }
  }
  // Floor and docking hatch planes.
  if (Math.abs(d.y) > 1e-9) {
    const tf = (m.cabinFloorY - o.y) / d.y;
    const pf = v3.addScaled(o, d, tf);
    if (radiusOf(pf) < A + B * m.cabinFloorY) consider({ t: tf, n: { x: 0, y: 1, z: 0 }, albedo: 0.08 });
    const dockY = model.layout.hatch.dockingHatchY - 0.03;
    const td = (dockY - o.y) / d.y;
    const pd = v3.addScaled(o, d, td);
    if (radiusOf(pd) < tunnelR) consider({ t: td, n: { x: 0, y: -1, z: 0 }, albedo: 0.55 });
  }
  for (const box of model.proxies) consider(rayBox(box, o, d));
  void prof;
  return best;
}

/** Ray against an oriented box (slab test); the normal of the face that was entered. */
function rayBox(b: ProxyBox, o: Vec3, d: Vec3): Hit | null {
  const f = b.frame;
  const axes = [f.x, f.y, f.n];
  const rel = v3.sub(o, f.o);
  let tmin = -Infinity;
  let tmax = Infinity;
  let nEnter: Vec3 = f.n;
  for (let k = 0; k < 3; k++) {
    const ax = axes[k]!;
    const e = v3.dot(rel, ax);
    const dd = v3.dot(d, ax);
    const h = b.half[k]!;
    if (Math.abs(dd) < 1e-12) {
      if (e < -h || e > h) return null;
      continue;
    }
    let t1 = (-h - e) / dd;
    let t2 = (h - e) / dd;
    let n1 = v3.neg(ax);
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      n1 = ax;
    }
    if (t1 > tmin) {
      tmin = t1;
      nEnter = n1;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0 || tmin < 1e-4) return null;
  return { t: tmin, n: nEnter, albedo: b.albedo };
}

export interface CabinSources {
  polys: CabinPoly[];
  /** Sun flux through all windows (lm, without atmosphere) and the lamps' flux (lm). */
  sunFlux: number;
  lampFlux: number;
}

/**
 * The polygon sources of one frame (part frame). Windows always come first (the shader uses the first
 * `windows.length` polygons for the inter-reflection term).
 */
export function cabinSources(model: CockpitModel, sun: SunInput | null, lightsOn: boolean): CabinSources {
  const polys: CabinPoly[] = [];
  const T = glassTransmittance(model);
  const quads = model.windows.map((w) => windowQuad(w));
  quads.forEach((q, i) => polys.push({ kind: POLY_WINDOW, corners: q.corners, normal: q.outward, radiance: T, area: q.area, on: true, index: i }));
  let sunFlux = 0;
  if (sun && sun.illuminance > 0) {
    const s = sun.dirPart;
    const into = v3.neg(s);
    const tMean = (T[0] + T[1] + T[2]) / 3;
    quads.forEach((q) => {
      const cosW = v3.dot(q.outward, s);
      if (cosW <= 0.01) return;
      sunFlux += sun.illuminance * tMean * cosW * q.area;
      const hit = castCabinRay(model, v3.addScaled(q.centre, into, 0.01), into);
      if (!hit || polys.length >= MAX_CABIN_POLYS) return;
      const p = v3.addScaled(q.centre, into, 0.01 + hit.t);
      let n = hit.n;
      if (v3.dot(n, s) < 0) n = v3.neg(n);
      const cosR = v3.dot(n, s);
      if (cosR <= 0.01) return;
      // Corners projected along the sun onto the plane of the centre's hit.
      const corners = q.corners.map((c) => {
        const t = v3.dot(v3.sub(p, c), n) / v3.dot(into, n);
        return v3.addScaled(c, into, t);
      }) as [Vec3, Vec3, Vec3, Vec3];
      const L = (hit.albedo * sun.illuminance * tMean * cosR) / Math.PI;
      polys.push({ kind: POLY_PATCH, corners, normal: n, radiance: [L * sun.color[0], L * sun.color[1], L * sun.color[2]], area: (q.area * cosW) / cosR, on: true, index: 0 });
    });
  }
  let lampFlux = 0;
  for (const f of model.floods) {
    if (polys.length >= MAX_CABIN_POLYS) break;
    const along = v3.normalize(v3.sub(f.p1, f.p0));
    const across = v3.scale(v3.normalize(v3.cross(f.n, along)), 0.018);
    const area = v3.dist(f.p0, f.p1) * 0.036;
    const L = f.lumens / (Math.PI * area);
    polys.push({
      kind: POLY_FLOOD,
      corners: [v3.sub(f.p0, across), v3.sub(f.p1, across), v3.add(f.p1, across), v3.add(f.p0, across)],
      normal: f.n,
      radiance: [L * f.color[0], L * f.color[1], L * f.color[2]],
      area,
      on: lightsOn,
      index: 0,
    });
    if (lightsOn) lampFlux += f.lumens;
  }
  for (const d of model.displays) {
    if (polys.length >= MAX_CABIN_POLYS) break;
    const f = d.frame;
    const at = (a: number, b: number): Vec3 => v3.add(f.o, v3.add(v3.scale(f.x, a), v3.scale(f.y, b)));
    const hw = d.width / 2;
    const hh = d.height / 2;
    polys.push({ kind: POLY_DISPLAY, corners: [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)], normal: f.n, radiance: [0, 0, 0], area: d.width * d.height, on: true, index: d.index });
  }
  return { polys, sunFlux, lampFlux };
}

/** Luminance (cd/m^2, linear colour) of a floodlight's diffuser when it is on. */
export function floodLuminance(model: CockpitModel, i: number): [number, number, number] {
  const f = model.floods[i];
  if (!f) return [0, 0, 0];
  const area = v3.dist(f.p0, f.p1) * 0.036;
  const L = f.lumens / (Math.PI * area);
  return [L * f.color[0], L * f.color[1], L * f.color[2]];
}
