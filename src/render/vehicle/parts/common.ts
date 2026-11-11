/**
 * Shared building blocks of the part generators: LOD model assembly, livery regions, structural detail
 * (stringers, weld seams, raceways, umbilical plates, vents, thrusters) and the soot / frost mask rules.
 */
import type { Vec3Tuple } from '@/core/math';
import type { DecalSheet } from '../decals';
import { MeshBuilder, cross3, unifyMaterials, xf, type Xf } from '../geom/builder';
import { DEG, Profile, TAU, around, bolt, box, extrude, frustum, lathe, radialFrame, rectPoly, uniformPhis, type LatheRegion } from '../geom/prims';
import type { MatId } from '../materials';
import type { PartModel } from './types';

/** Build the three LODs of a model with one function (`b.lod` / `b.pick` select the detail). */
export function buildModel(name: string, fn: (b: MeshBuilder) => void, lodPixels?: readonly number[]): PartModel {
  const lods = [0, 1, 2].map((l) => {
    const b = new MeshBuilder(l);
    fn(b);
    return b.build();
  });
  const u = unifyMaterials(lods);
  return { name, lods: u.lods, materials: u.materials, ...(lodPixels ? { lodPixels } : {}) };
}

/**
 * Livery region for a decal centred at azimuth `phiDeg` and height `y` on a cylinder of radius `r`:
 * `height` is the size along the axis in metres (the long side for a rotated decal); the other side
 * follows from the decal's aspect ratio.
 */
export function decalRegion(sheet: DecalSheet, name: string, r: number, phiDeg: number, y: number, height: number, rot = false, span?: [string, string]): LatheRegion {
  const aspect = sheet.aspect(name);
  const alongAxis = height;
  const around = rot ? height / aspect : height * aspect;
  const half = around / (2 * r);
  const phi = phiDeg * DEG;
  return { phi0: phi - half, phi1: phi + half, y0: y - alongAxis / 2, y1: y + alongAxis / 2, mat: 'decal', uv: sheet.uv(name), rot, ...(span ? { span } : {}) };
}

/** Painted band (plain material) over an azimuth range. */
export function bandRegion(mat: MatId, phi0Deg: number, phi1Deg: number, y0: number, y1: number, span?: [string, string]): LatheRegion {
  return { phi0: phi0Deg * DEG, phi1: phi1Deg * DEG, y0, y1, mat, ...(span ? { span } : {}) };
}

/** All azimuth bounds of a region list (for `phisWith`). */
export function regionBounds(regions: LatheRegion[]): number[] {
  const out: number[] = [];
  for (const r of regions) out.push(r.phi0, r.phi1);
  return out;
}

/** All height bounds of a region list (for `Profile.splitAtY`). */
export function regionHeights(regions: LatheRegion[]): number[] {
  const out = new Set<number>();
  for (const r of regions) {
    out.add(r.y0);
    out.add(r.y1);
  }
  return [...out].sort((a, b) => a - b);
}

/** External hat stringers on a cylinder or cone between two heights. */
export function stringers(b: MeshBuilder, r0: number, y0: number, r1: number, y1: number, count: number, width: number, depth: number, phase = 0): void {
  const hat = rectPoly(width / 2, depth / 2, Math.min(width, depth) * 0.25);
  for (let i = 0; i < count; i++) {
    const phi = phase + (i / count) * TAU;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const a: Vec3Tuple = [(r0 + depth * 0.45) * s, y0, (r0 + depth * 0.45) * c];
    const e: Vec3Tuple = [(r1 + depth * 0.45) * s, y1, (r1 + depth * 0.45) * c];
    // Section x = tangential, z = radial.
    b.at(xf.along(a, e, [c, 0, -s]), () => extrude(b, hat, 0, Math.hypot(r1 - r0, y1 - y0), false, 'stringer'));
  }
}

/** Raised circumferential band (weld land, ring frame cap, tension strap): three faces, open underneath. */
export function band(b: MeshBuilder, r: number, y: number, width: number, proud: number, segs: number, tag = 'band'): void {
  const p = Profile.at(r - 0.002, y - width / 2)
    .to(r + proud, y - width / 2 + proud * 0.8)
    .to(r + proud, y + width / 2 - proud * 0.8)
    .to(r - 0.002, y + width / 2);
  p.pts[0]!.hard = false;
  lathe(b, p, { segs, closed: false, tag });
}

/** Longitudinal weld seams / splice straps on a cylinder between two heights. */
export function seams(b: MeshBuilder, r: number, y0: number, y1: number, count: number, width: number, proud: number, phase = 0): void {
  for (let i = 0; i < count; i++) {
    const phi = phase + (i / count) * TAU;
    b.at(radialFrame(r - 0.002, phi, (y0 + y1) / 2), () => box(b, y1 - y0, proud + 0.002, width, [0, (proud + 0.002) / 2, 0], 'seam'));
  }
}

/**
 * Systems tunnel (raceway) along the axis at azimuth phi: a chamfered cover with bracket ribs and end
 * fairings. `r` is the skin radius; the cover stands `depth` proud.
 */
export function raceway(b: MeshBuilder, r: number, phi: number, y0: number, y1: number, width: number, depth: number, mat: MatId, r1 = r): void {
  const prev = b.material;
  b.mat(mat);
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const from: Vec3Tuple = [(r - 0.01) * s, y0, (r - 0.01) * c];
  const to: Vec3Tuple = [(r1 - 0.01) * s, y1, (r1 - 0.01) * c];
  const len = Math.hypot(r1 - r, y1 - y0);
  // Section in (x = tangential, z = radial outward).
  const hw = width / 2;
  const poly: [number, number][] = [
    [-hw, 0],
    [hw, 0],
    [hw, depth * 0.55],
    [hw - depth * 0.45, depth + 0.01],
    [-hw + depth * 0.45, depth + 0.01],
    [-hw, depth * 0.55],
  ];
  const frame = xf.along(from, to, [c, 0, -s]);
  b.at(frame, () => {
    extrude(b, poly, 0, len, false, 'raceway');
    if (b.lod === 0) {
      // Cover splice straps and fastener rows.
      const n = Math.max(2, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) {
        const y = (len * i) / n;
        box(b, width + 0.03, 0.05, 0.012, [0, Math.min(Math.max(y, 0.03), len - 0.03), depth + 0.014], 'strap');
      }
    }
  });
  b.mat(prev);
}

/** A surface of revolution about +Y, given as its radius at height y (a number is a cylinder). */
export type Surface = number | ((y: number) => number);

export const surfaceRadius = (s: Surface, y: number): number => (typeof s === 'number' ? s : s(y));

/** dr/dy of a surface at height y. */
export const surfaceSlope = (s: Surface, y: number): number => (typeof s === 'number' ? 0 : (s(y + 0.005) - s(y - 0.005)) / 0.01);

/**
 * Frame on a surface of revolution at azimuth phi / height y: +Y = the outward surface normal, +X = up the
 * meridian, +Z = around the axis (increasing azimuth). The origin stands `lift` above the surface. On a
 * cylinder this is `radialFrame`; on a cone the fitting leans with the wall.
 */
export function surfaceFrame(s: Surface, phi: number, y: number, lift = 0): Xf {
  const k = surfaceSlope(s, y);
  const l = Math.hypot(1, k);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const m: Vec3Tuple = [(k * sp) / l, 1 / l, (k * cp) / l];
  const n: Vec3Tuple = [sp / l, -k / l, cp / l];
  const r = surfaceRadius(s, y);
  return xf.fromAxes([r * sp + n[0] * lift, y + n[1] * lift, r * cp + n[2] * lift], m, n, cross3(m, n));
}

/**
 * Panel that follows a surface of revolution (door, carrier plate, doubler): centred at azimuth phi /
 * height y, `w` wide along the arc and `h` high along the meridian, standing `proud` above the skin and
 * sunk `sink` into it. A watertight sector, so it lies on a cone or a cylinder without a gap at any edge.
 */
export function curvedPanel(b: MeshBuilder, s: Surface, phi: number, y: number, w: number, h: number, proud: number, tag = 'panel', sink = 0.004): void {
  const dy = h / 2 / Math.hypot(1, surfaceSlope(s, y));
  const rows = typeof s === 'number' ? 1 : b.pick(3, 2, 1);
  const half = w / (2 * surfaceRadius(s, y));
  const yAt = (i: number): number => y - dy + (2 * dy * i) / rows;
  const p = Profile.at(surfaceRadius(s, yAt(0)) - sink, yAt(0));
  p.corner(surfaceRadius(s, yAt(0)) + proud, yAt(0));
  for (let i = 1; i <= rows; i++) p.to(surfaceRadius(s, yAt(i)) + proud, yAt(i));
  p.hard();
  p.corner(surfaceRadius(s, yAt(rows)) - sink, yAt(rows));
  for (let i = rows - 1; i >= 1; i--) p.to(surfaceRadius(s, yAt(i)) - sink, yAt(i));
  p.corner(surfaceRadius(s, yAt(0)) - sink, yAt(0)).close();
  const segs = Math.max(2, Math.round(w / b.pick(0.1, 0.22, 0.5)));
  lathe(b, p, { phis: uniformPhis(segs, phi - half, phi + half), capEnds: true, tag });
}

/**
 * Umbilical plate on a surface of revolution at azimuth phi / height y: a carrier plate that follows the
 * skin, with quick-disconnect ports standing on it along the surface normal.
 */
export function umbilicalPlate(b: MeshBuilder, s: Surface, phi: number, y: number, w: number, h: number, ports: number): void {
  const prev = b.material;
  // Small plates are proportionally thinner.
  const d = Math.min(1, Math.max(w, h) / 1.0);
  const l = Math.hypot(1, surfaceSlope(s, y));
  const r = surfaceRadius(s, y);
  /** Frame at (along the meridian, around the arc) from the plate centre, on the plate's outer face. */
  const on = (up: number, across: number): Xf => surfaceFrame(s, phi + across / r, y + up / l, 0.07 * d);
  b.mat('steel-brushed');
  curvedPanel(b, s, phi, y, w, h, 0.07 * d, 'umbilical', 0.01);
  if (b.lod < 2) {
    b.mat('steel-dark');
    const cols = Math.ceil(ports / 2);
    for (let i = 0; i < ports; i++) {
      const cx = ((i % 2) - 0.5) * h * 0.42;
      const cz = (Math.floor(i / 2) - (cols - 1) / 2) * (w / (cols + 0.4));
      const pr = Math.min(h, w / cols) * 0.17;
      b.at(on(cx, cz), () => {
        frustum(b, pr, pr * 0.9, -0.004, 0.06 * d, b.pick(14, 8, 6), 'port');
        if (b.lod === 0) frustum(b, pr * 0.55, pr * 0.55, 0.06 * d, 0.09 * d, 10, 'port');
      });
    }
    if (b.lod === 0) {
      b.mat('steel-bare');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(on(sx * (h / 2 - 0.05 * d), sz * (w / 2 - 0.05 * d)), () => bolt(b, 0.018 * d, 0.014 * d));
    }
  }
  b.mat(prev);
}

/** Small vent / relief port with a flanged tube standing on the surface along its normal. */
export function ventPort(b: MeshBuilder, s: Surface, phi: number, y: number, radius: number, length: number): void {
  const prev = b.material;
  b.mat('steel-bare');
  b.at(surfaceFrame(s, phi, y, -0.005), () => {
    frustum(b, radius * 1.7, radius * 1.7, 0, 0.02, b.pick(16, 10, 6), 'vent');
    lathe(b, Profile.at(0, 0.02).corner(radius, 0.02).corner(radius, length).corner(radius * 0.8, length).corner(radius * 0.8, length * 0.4).corner(0, length * 0.4), { segs: b.pick(16, 10, 6), tag: 'vent' });
  });
  b.mat(prev);
}

/** Access door: a thin raised panel that follows the skin, with fasteners round its edge. */
export function accessDoor(b: MeshBuilder, s: Surface, phi: number, y: number, w: number, h: number): void {
  if (b.lod === 2) return;
  const proud = 0.012;
  curvedPanel(b, s, phi, y, w, h, proud, 'door');
  if (b.lod !== 0) return;
  const prev = b.material;
  b.mat('steel-bare');
  const l = Math.hypot(1, surfaceSlope(s, y));
  const r = surfaceRadius(s, y);
  const on = (up: number, across: number): Xf => surfaceFrame(s, phi + across / r, y + up / l, proud);
  const nx = Math.max(2, Math.round(h / 0.14));
  const nz = Math.max(2, Math.round(w / 0.14));
  for (let i = 0; i <= nx; i++) for (const sz of [-1, 1]) b.at(on(-h / 2 + 0.03 + ((h - 0.06) * i) / nx, sz * (w / 2 - 0.03)), () => bolt(b, 0.008, 0.004));
  for (let i = 1; i < nz; i++) for (const sx of [-1, 1]) b.at(on(sx * (h / 2 - 0.03), -w / 2 + 0.03 + ((w - 0.06) * i) / nz), () => bolt(b, 0.008, 0.004));
  b.mat(prev);
}

/**
 * Small thruster: a bell on a short chamber, exit centre at `pos`, exhaust along `dir`. Used for RCS quads
 * and pods; `exit` is the exit radius.
 */
export function thruster(b: MeshBuilder, pos: Vec3Tuple, dir: Vec3Tuple, exit: number, length: number): void {
  const prev = b.material;
  const base: Vec3Tuple = [pos[0] - dir[0] * length, pos[1] - dir[1] * length, pos[2] - dir[2] * length];
  b.mat('nozzle-ext');
  b.at(xf.along(base, pos), () => {
    const n = b.pick(6, 4, 2);
    const p = Profile.at(0, 0).corner(exit * 0.45, 0).to(exit * 0.45, length * 0.25).to(exit * 0.3, length * 0.38);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      p.to(exit * (0.3 + 0.7 * Math.sqrt(t)), length * (0.38 + 0.62 * t));
    }
    p.hard();
    // Lip, then the inner wall back up to a throat plug.
    const wall = Math.min(0.004, exit * 0.08);
    p.corner(exit - wall, length);
    for (let i = n - 1; i >= 0; i--) {
      const t = i / n;
      p.to(exit * (0.3 + 0.7 * Math.sqrt(t)) - wall, length * (0.4 + 0.6 * t));
    }
    p.to(0, length * 0.42);
    lathe(b, p, { segs: b.pick(16, 10, 6), tag: 'thruster' });
  });
  b.mat(prev);
}

/**
 * Parse a list parameter "name@a,b,c;name@a,b" into [name, numbers[], flags[]] entries. Numbers may be
 * ranges written "lo-hi" (two numbers); bare words after the numbers are flags.
 */
export function parseList(text: string): { name: string; n: number[]; flags: string[] }[] {
  const out: { name: string; n: number[]; flags: string[] }[] = [];
  for (const item of text.split(';')) {
    const t = item.trim();
    if (!t) continue;
    const at = t.indexOf('@');
    const name = at < 0 ? '' : t.slice(0, at).trim();
    const n: number[] = [];
    const flags: string[] = [];
    for (const tok of (at < 0 ? t : t.slice(at + 1)).split(',')) {
      const s = tok.trim();
      if (!s) continue;
      const range = /^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(s);
      if (range) n.push(Number(range[1]), Number(range[2]));
      else if (Number.isFinite(Number(s))) n.push(Number(s));
      else flags.push(s);
    }
    out.push({ name, n, flags });
  }
  return out;
}

/** Small deterministic hash in [0, 1) for placing detail. */
export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 8) / 16777216;
}

/** Smooth value noise in [0, 1) over the plane, one feature per unit of x / y (deterministic; for placing wear). */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number): number => hash01(i * 7919 + seed * 104729, j);
  const a = h(xi, yi);
  const c = h(xi + 1, yi);
  const d = h(xi, yi + 1);
  const e = h(xi + 1, yi + 1);
  return a + (c - a) * u + (d - a) * v + (a - c - d + e) * u * v;
}

export { around };
