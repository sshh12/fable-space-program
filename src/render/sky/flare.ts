/**
 * Lens flare terms and their normalisation. The angular profiles here are the ones evaluated by FLARE_WGSL;
 * each is integrated numerically over the sphere outside the solar disc so that a term of energy fraction k
 * delivers exactly k x the illuminance at the lens (the part of it that falls inside the frame is what the
 * screen shows). The sum of all terms is FLARE_TOTAL_ENERGY, under the 1 % of the brief.
 *
 * Geometry: the starburst (glare halo + diffraction spikes) is a function of the angle from the sun over the
 * whole sphere and is drawn as a fullscreen pass; every ghost is a soft disc of fixed angular radius around a
 * direction, drawn on the screen-space bounding box of its cone (ghostCone*), so no profile is ever cut by
 * the geometry it is drawn with.
 *
 * Sun outside the frame: the lens has a rectangular hood matched to the frame (it does not vignette any
 * direction inside the field), HOOD_DEPTH entrance-pupil diameters deep. A source beyond the frame edge lights
 * the part of the pupil the hood does not shadow (hoodTransmission), so the glare fades out over a few
 * degrees beyond the edge instead of ending when the disc leaves the frame.
 */
import type { Vec3, Vec3Tuple } from '@/core/math';

/** Share of the starburst term that goes into the glare halo (the rest into the diffraction spikes). */
export const FLARE_HALO_SHARE = 0.55;
/** Halo profile (1 + (theta / c)^2)^-HALO_POWER: veiling glare of the lens, falls as theta^-3 over the whole frame. */
export const HALO_POWER = 1.5;
/** Diffraction spikes: two per aperture blade for an odd blade count (7 blades -> 14 spikes). */
export const SPIKE_COUNT = 14;
/** Depth of the lens hood in entrance-pupil diameters (rectangular, matched to the frame). */
export const HOOD_DEPTH = 2;

export interface StarburstDef {
  energy: number;
  /** Halo core angle (rad). */
  haloCore: number;
  /** Spike half width across (rad) and length scale (rad; 1/theta^2 beyond it). */
  spikeWidth: number;
  spikeLength: number;
  tint: Vec3Tuple;
}
export interface GhostDef {
  /** Position on the line from the image centre (0) to the sun (1), in NDC multiples of the sun's position. */
  k: number;
  /** Angular radius (rad). */
  radius: number;
  /** Width of the soft edge in units of the radius, and radial chromatic shift per channel (fraction). */
  softness: number;
  chroma: number;
  energy: number;
  tint: Vec3Tuple;
}

const normaliseTint = (c: Vec3Tuple): Vec3Tuple => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
};

export const STARBURST: StarburstDef = { energy: 0.004, haloCore: 0.012, spikeWidth: 0.0009, spikeLength: 0.012, tint: [1, 1, 1] };
export const GHOSTS: GhostDef[] = [
  { k: -0.35, radius: 0.03, softness: 0.35, chroma: 0.03, energy: 0.00012, tint: normaliseTint([1.0, 0.84, 0.6]) },
  { k: -0.7, radius: 0.016, softness: 0.45, chroma: 0.04, energy: 0.00006, tint: normaliseTint([0.62, 0.86, 1.0]) },
  { k: 0.42, radius: 0.045, softness: 0.3, chroma: 0.04, energy: 0.0001, tint: normaliseTint([0.85, 0.72, 1.0]) },
  { k: -1.2, radius: 0.08, softness: 0.25, chroma: 0.05, energy: 0.00008, tint: normaliseTint([0.72, 1.0, 0.8]) },
];
export const FLARE_TOTAL_ENERGY = STARBURST.energy + GHOSTS.reduce((s, g) => s + g.energy, 0);

/** Relative wavelength per channel (R, G, B) of the spikes' chromatic length. */
export const SPIKE_LAMBDA: Vec3Tuple = [1.12, 1.0, 0.84];

export const haloProfile = (theta: number, core: number): number => (1 + (theta / core) ** 2) ** -HALO_POWER;
/** Spike profile at angle theta from the sun, dphi from the nearest spike, channel wavelength scale lambda. */
export function spikeProfile(theta: number, dphi: number, width: number, length: number, lambda: number): number {
  const across = theta * Math.sin(dphi);
  return Math.exp((-0.5 * across * across) / (width * width)) / (1 + (theta * theta) / (length * length * lambda * lambda)) / lambda;
}
/** Ghost profile at r = angle / radius for one channel's shift s (+-chroma, 0 for green). */
export function ghostProfile(r: number, softness: number, s: number): number {
  const disc = Math.min(1, Math.max(0, (1 - r * (1 + s)) / softness));
  const t = Math.min(1, Math.max(0, (r - 0.6) / 0.4));
  return disc * (0.55 + 0.45 * t * t * (3 - 2 * t));
}
/** Angular radius (rad) beyond which a ghost is zero in every channel (the red channel reaches radius / (1 - chroma)). */
export const ghostSupport = (g: GhostDef): number => g.radius / (1 - g.chroma);

/** Integral over the sphere of the halo between the solar disc and the antisolar point (sr). */
export function haloIntegral(core: number, sunRadius: number): number {
  let s = 0;
  const n = 6000;
  const la = Math.log(sunRadius);
  const lb = Math.log(Math.PI);
  for (let i = 0; i < n; i++) {
    // Logarithmic steps in theta: the halo is concentrated within a few core angles.
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / n);
    const dth = (th * (lb - la)) / n;
    s += haloProfile(th, core) * 2 * Math.PI * Math.sin(th) * dth;
  }
  return s;
}

/** Integral of the spike profile of one channel over the sphere outside the disc (sr). */
export function spikeIntegral(width: number, length: number, lambda: number, sunRadius: number): number {
  let s = 0;
  const nt = 1500;
  const np = 720;
  const la = Math.log(sunRadius);
  const lb = Math.log(Math.PI);
  const seg = (2 * Math.PI) / SPIKE_COUNT;
  for (let i = 0; i < nt; i++) {
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / nt);
    const dth = (th * (lb - la)) / nt;
    let ring = 0;
    for (let j = 0; j < np; j++) {
      const phi = ((j + 0.5) * 2 * Math.PI) / np;
      const dphi = Math.abs(phi - seg * Math.round(phi / seg));
      ring += spikeProfile(th, dphi, width, length, lambda);
    }
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * dth;
  }
  return s;
}

/** Integral of a ghost's (green channel) profile over the sphere (sr). */
export function ghostIntegral(g: GhostDef): number {
  let s = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n;
    const th = r * g.radius;
    s += ghostProfile(r, g.softness, 0) * 2 * Math.PI * Math.sin(th) * (g.radius / n);
  }
  return s;
}

export interface FlareNormalisation {
  /** 1 / integral (1/sr) of the halo, of the spikes (green channel), of each ghost (green channel). */
  halo: number;
  spikes: number;
  ghosts: number[];
  /** Solar angular radius (rad) the integrals were computed for. */
  sunRadius: number;
}

let normCache: FlareNormalisation | null = null;

/** Normalisation of the flare profiles for a solar disc of angular radius `sunRadius` (recomputed when it changes by 0.1 %). */
export function flareNormalisation(sunRadius: number): FlareNormalisation {
  if (normCache && Math.abs(sunRadius - normCache.sunRadius) < 1e-3 * sunRadius) return normCache;
  normCache = {
    halo: 1 / haloIntegral(STARBURST.haloCore, sunRadius),
    spikes: 1 / spikeIntegral(STARBURST.spikeWidth, STARBURST.spikeLength, 1, sunRadius),
    ghosts: GHOSTS.map((g) => 1 / ghostIntegral(g)),
    sunRadius,
  };
  return normCache;
}

/** Geometry of one frame's flare: camera, unit direction to the sun, its angular radius and NDC position (unjittered). */
export interface FlareGeometry {
  view: FlareView;
  sun: Vec3;
  sunRadius: number;
  sunNdc: [number, number];
}

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const angleBetween = (a: Vec3, b: Vec3): number => {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), dot3(a, b));
};

/**
 * CPU model of FLARE_WGSL: the radiance (rgb, cd/m^2 per lux of source illuminance) the flare adds along unit
 * direction d, over the whole sphere (no quads). Zero on the disc and its 1.5 px rim (`pixelAngle` = pixel
 * angle on the view axis), which the shader leaves alone. Tests integrate it over the screen as the reference
 * of the GPU image.
 */
export function flareRadiance(g: FlareGeometry, d: Vec3, pixelAngle: number): Vec3Tuple {
  const s = g.sun;
  const theta = angleBetween(d, s);
  if (theta < g.sunRadius + 1.5 * pixelAngle) return [0, 0, 0];
  const n = flareNormalisation(g.sunRadius);
  const out: Vec3Tuple = [0, 0, 0];
  // Starburst: halo + spikes about the sun, the spikes' angle measured from the camera's up projected on the image plane.
  const halo = n.halo * haloProfile(theta, STARBURST.haloCore);
  const ds = dot3(d, s);
  const ts = { x: d.x - s.x * ds, y: d.y - s.y * ds, z: d.z - s.z * ds };
  const us = dot3(g.view.up, s);
  const up = { x: g.view.up.x - s.x * us, y: g.view.up.y - s.y * us, z: g.view.up.z - s.z * us };
  const rt = { x: s.y * up.z - s.z * up.y, y: s.z * up.x - s.x * up.z, z: s.x * up.y - s.y * up.x };
  const phi = Math.atan2(dot3(ts, rt) / Math.hypot(rt.x, rt.y, rt.z), dot3(ts, up) / Math.hypot(up.x, up.y, up.z));
  const seg = (2 * Math.PI) / SPIKE_COUNT;
  const dphi = Math.abs(phi - seg * Math.round(phi / seg));
  for (let c = 0; c < 3; c++) {
    const spikes = n.spikes * spikeProfile(theta, dphi, STARBURST.spikeWidth, STARBURST.spikeLength, SPIKE_LAMBDA[c]!);
    out[c] = out[c]! + STARBURST.energy * STARBURST.tint[c]! * (halo * FLARE_HALO_SHARE + spikes * (1 - FLARE_HALO_SHARE));
  }
  // Ghosts: soft discs around the view rays through k x the sun's NDC position; channel shifts -chroma, 0, +chroma.
  GHOSTS.forEach((gh, i) => {
    const r = angleBetween(d, ndcDirection(g.view, g.sunNdc[0] * gh.k, g.sunNdc[1] * gh.k)) / gh.radius;
    const shift = [-gh.chroma, 0, gh.chroma];
    for (let c = 0; c < 3; c++) out[c] = out[c]! + gh.energy * gh.tint[c]! * n.ghosts[i]! * ghostProfile(r, gh.softness, shift[c]!);
  });
  return out;
}

/**
 * Fraction of a circular entrance pupil lit through a rectangular hood matched to the frame, for a source whose
 * image-plane tangents exceed the frame's half-tangents by ex, ey >= 0 (0 inside the frame). Along each axis
 * the hood's edge shadows a straight-edged part of the pupil that grows by HOOD_DEPTH x the excess tangent
 * (in pupil diameters): the lit part is the circular segment beyond it. The two axes are combined as a product.
 */
export function hoodTransmission(ex: number, ey: number): number {
  const lit = (e: number): number => {
    const s = Math.min(1, Math.max(0, e * HOOD_DEPTH));
    if (s <= 0) return 1;
    if (s >= 1) return 0;
    const x = 2 * s - 1;
    return (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
  };
  return lit(ex) * lit(ey);
}

/** Camera basis and half-tangents of the frame (unjittered). */
export interface FlareView {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanX: number;
  tanY: number;
}

/** Unit view direction through an NDC point (the shader's ndcRay). */
export function ndcDirection(v: FlareView, x: number, y: number): Vec3 {
  const d = {
    x: v.forward.x + v.right.x * x * v.tanX + v.up.x * y * v.tanY,
    y: v.forward.y + v.right.y * x * v.tanX + v.up.y * y * v.tanY,
    z: v.forward.z + v.right.z * x * v.tanX + v.up.z * y * v.tanY,
  };
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

/** Number of directions on the cone's rim projected for its bounding box. */
const CONE_RIM = 48;

/**
 * NDC bounding box [minX, minY, maxX, maxY] of the cone of half-angle `angle` around unit direction `c`, by
 * projecting a ring of directions on its rim (inflated by the chord error of the polygon), or the whole screen
 * when the cone reaches the plane of the camera (no finite projection).
 */
export function coneNdcBounds(v: FlareView, c: Vec3, angle: number): [number, number, number, number] {
  const a = Math.abs(c.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let e1 = { x: c.y * a.z - c.z * a.y, y: c.z * a.x - c.x * a.z, z: c.x * a.y - c.y * a.x };
  const l1 = Math.hypot(e1.x, e1.y, e1.z);
  e1 = { x: e1.x / l1, y: e1.y / l1, z: e1.z / l1 };
  const e2 = { x: c.y * e1.z - c.z * e1.y, y: c.z * e1.x - c.x * e1.z, z: c.x * e1.y - c.y * e1.x };
  // A polygon inscribed in the rim misses at most 1 - cos(pi / n) of the radius between its vertices.
  const rim = angle / Math.cos(Math.PI / CONE_RIM);
  const ca = Math.cos(rim);
  const sa = Math.sin(rim);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < CONE_RIM; i++) {
    const phi = (i * 2 * Math.PI) / CONE_RIM;
    const k1 = sa * Math.cos(phi);
    const k2 = sa * Math.sin(phi);
    const d = { x: c.x * ca + e1.x * k1 + e2.x * k2, y: c.y * ca + e1.y * k1 + e2.y * k2, z: c.z * ca + e1.z * k1 + e2.z * k2 };
    const w = d.x * v.forward.x + d.y * v.forward.y + d.z * v.forward.z;
    if (w <= 1e-6) return [-1, -1, 1, 1];
    const x = (d.x * v.right.x + d.y * v.right.y + d.z * v.right.z) / (w * v.tanX);
    const y = (d.x * v.up.x + d.y * v.up.y + d.z * v.up.z) / (w * v.tanY);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}
