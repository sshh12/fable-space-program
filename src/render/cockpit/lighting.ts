/**
 * CPU half of the cabin light (the shader half is the "cockpit_cabin" chunk in shaders.ts): the polygon
 * sources of this frame in the capsule part frame.
 *
 *  - windows: the inner pane outline as an area-equivalent quad, outward normal, glass transmittance;
 *  - (the sunlight a patch on a panel or a couch throws back into the cabin is not a polygon: the cabin
 *    probe sees the lit surfaces themselves, whatever their shape, and its bounce light carries them);
 *  - floodlights (lens strips, luminance = flux / (pi area)) and displays (their image's mean is read on the
 *    GPU from the last mip).
 * Pure: unit-tested without a GPU.
 */
import { v3, type Vec3 } from '@/core/math';
import { bvhRay } from './bvh';
import type { CockpitModel } from './build';
import type { WindowMeta } from './cabin/context';

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

/**
 * Which of the cabin's windows another part of the vessel covers (true = covered), from the parts' visual
 * definitions: a part whose visual `params.windowPorts` lists window ids (a JSON list, or a "a;b" string) is
 * a cover over the capsule (the launch escape system's boost cover); every window it does not list is shut
 * by it (no sky, no sun, no entry glow comes in). Once the covering part is gone from the vessel (jettisoned)
 * the window is open again. Pure.
 */
export function coveredWindows(windowIds: readonly string[], partDefs: readonly string[], defs: { parts: Record<string, { visual: { params: Record<string, unknown> } | null } | undefined> }): boolean[] {
  const covered = windowIds.map(() => false);
  for (const id of partDefs) {
    const ports = defs.parts[id]?.visual?.params?.['windowPorts'];
    if (ports === undefined) continue;
    const list = Array.isArray(ports) ? ports.map(String) : typeof ports === 'string' ? ports.split(';').map((s) => s.trim()) : [];
    windowIds.forEach((w, i) => {
      if (!list.includes(w)) covered[i] = true;
    });
  }
  return covered;
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
  /** Unit normal of the surface that was hit (either orientation) and its diffuse reflectance. */
  n: Vec3;
  albedo: number;
}

/**
 * Nearest hit of a ray (unit direction d) against the interior's full-detail geometry; the receiver's
 * diffuse reflectance is its material's: luminance of the base colour times (1 - metallic).
 */
export function castCabinRay(model: CockpitModel, o: Vec3, d: Vec3): Hit | null {
  const h = bvhRay(model.bvh, o, d, 1e-4, 16, false);
  if (!h) return null;
  const m = model.layout.materials[model.materialNames[h.material]!]!;
  const albedo = (0.2126 * m.albedo[0] + 0.7152 * m.albedo[1] + 0.0722 * m.albedo[2]) * (1 - (m.metallic ?? 0));
  return { t: h.t, n: v3.normalize(h.normal), albedo };
}

export interface CabinSources {
  polys: CabinPoly[];
  /** Sun flux through all windows (lm, without atmosphere) and the lamps' flux (lm). */
  sunFlux: number;
  lampFlux: number;
}

/**
 * The polygon sources of one frame (part frame). Windows always come first (the shader uses the first
 * `windows.length` polygons for the inter-reflection term). `floods`: the flood lights' level, 0..1 of their
 * full flux (true = full, false = off; see floodLevel).
 */
export function cabinSources(model: CockpitModel, sun: SunInput | null, floods: boolean | number, covered: readonly boolean[] = []): CabinSources {
  const level = typeof floods === 'number' ? Math.max(0, Math.min(1, floods)) : floods ? 1 : 0;
  const polys: CabinPoly[] = [];
  const T = glassTransmittance(model);
  const quads = model.windows.map((w) => windowQuad(w));
  // A covered window (coveredWindows) lets nothing in: dark, off, no sun.
  quads.forEach((q, i) => polys.push({ kind: POLY_WINDOW, corners: q.corners, normal: q.outward, radiance: covered[i] ? [0, 0, 0] : T, area: q.area, on: !covered[i], index: i }));
  let sunFlux = 0;
  if (sun && sun.illuminance > 0) {
    const s = sun.dirPart;
    const tMean = (T[0] + T[1] + T[2]) / 3;
    quads.forEach((q, i) => {
      if (covered[i]) return;
      const cosW = v3.dot(q.outward, s);
      if (cosW <= 0.01) return;
      sunFlux += sun.illuminance * tMean * cosW * q.area;
    });
  }
  let lampFlux = 0;
  for (const f of model.floods) {
    if (polys.length >= MAX_CABIN_POLYS) break;
    const along = v3.normalize(v3.sub(f.p1, f.p0));
    const across = v3.scale(v3.normalize(v3.cross(f.n, along)), 0.018);
    const area = v3.dist(f.p0, f.p1) * 0.036;
    const L = (f.lumens * level) / (Math.PI * area);
    polys.push({
      kind: POLY_FLOOD,
      corners: [v3.sub(f.p0, across), v3.sub(f.p1, across), v3.add(f.p1, across), v3.add(f.p0, across)],
      normal: f.n,
      radiance: [L * f.color[0], L * f.color[1], L * f.color[2]],
      area,
      on: level > 0,
      index: model.floods.indexOf(f),
    });
    lampFlux += f.lumens * level;
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

/**
 * The flood lights' level (0..1 of their full flux): full with the vessel's lights command on, the layout's
 * standby share otherwise. A crewed cabin is never flown dark: the lights command brightens it.
 */
export function floodLevel(model: CockpitModel, lightsOn: boolean): number {
  return lightsOn ? 1 : Math.max(0, Math.min(1, model.layout.lighting.floodStandby));
}

/** Luminance (cd/m^2, linear colour) of a floodlight's diffuser at `level` of its full flux. */
export function floodLuminance(model: CockpitModel, i: number, level = 1): [number, number, number] {
  const f = model.floods[i];
  if (!f) return [0, 0, 0];
  const area = v3.dist(f.p0, f.p1) * 0.036;
  const L = (f.lumens * level) / (Math.PI * area);
  return [L * f.color[0], L * f.color[1], L * f.color[2]];
}
