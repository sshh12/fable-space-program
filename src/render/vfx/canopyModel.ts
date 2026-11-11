/**
 * Geometry of a ring-sail parachute canopy as pure functions (no GPU): the meridian of the cloth for a given
 * inflation, the table of meridians the vertex shader interpolates, the mesh topology (gores, rings with
 * slots, vent), and how the canopies of a cluster stand apart.
 *
 * `inflation` is ModuleState.parachute.inflation: the drag area as a fraction of the fully open canopy. The
 * drag area goes with the projected area, so the projected radius is R sqrt(inflation) (never thinner than
 * the streaming canopy): the canopy area follows `inflation` by construction.
 *
 * Units: everything in units of the inflated projected radius R (canopyDiameter / 2), y up from the skirt.
 */
import type { CanopyStyleDef } from './data';

/** Samples of a meridian (vent edge to skirt, uniform in cloth length) and inflation levels in the table. */
export const PROFILE_SAMPLES = 33;
export const PROFILE_LEVELS = 32;
/** Subdivision of one cloth panel (a ring of one gore): columns across the gore, rows along the meridian. */
export const PANEL_COLS = 4;
export const PANEL_ROWS = 3;
/** Floats per canopy vertex: s (0 vent .. 1 skirt), gore coordinate (gore index + u), ring coordinate (ring index + v). */
export const CANOPY_VERTEX_FLOATS = 3;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Projected radius of the canopy (units of R) at an inflation. */
export function canopyRadius(style: CanopyStyleDef, inflation: number): number {
  return Math.max(Math.sqrt(Math.min(1, Math.max(inflation, 0))), style.streamRadius);
}

export interface CanopyProfile {
  /** Radius and height above the skirt at PROFILE_SAMPLES points from the vent edge to the skirt. */
  r: Float32Array;
  y: Float32Array;
  /** Largest radius (the projected radius) and the radius of the skirt (the mouth). */
  radius: number;
  mouth: number;
  height: number;
}

/**
 * Meridian of the cloth: an elliptical crown from the vent to the widest point, then a skirt that curves in
 * to the mouth. The cloth has a fixed length (goreLengthRatio, less the vent), so a reefed canopy - narrow
 * at its widest - is a bulb on a long throat, and a streaming one is a tube.
 */
export function canopyProfile(style: CanopyStyleDef, inflation: number): CanopyProfile {
  const f = Math.min(1, Math.max(inflation, 0));
  const a = canopyRadius(style, f);
  const cloth = style.goreLengthRatio * (1 - style.ventFraction);
  const vent = Math.min(style.ventFraction * style.goreLengthRatio, 0.45 * a);
  const phi0 = Math.asin(vent / a);
  const N = 96;
  // Crown: r = a sin(phi), y = b cos(phi), phi from the vent edge to the equator. A full canopy is flatter
  // than a reefed bulb; the crown may not use more than 94 % of the cloth.
  const crownLength = (b: number): number => {
    let len = 0;
    let pr = a * Math.sin(phi0);
    let py = b * Math.cos(phi0);
    for (let i = 1; i <= N; i++) {
      const phi = phi0 + ((Math.PI / 2 - phi0) * i) / N;
      const r = a * Math.sin(phi);
      const y = b * Math.cos(phi);
      len += Math.hypot(r - pr, y - py);
      pr = r;
      py = y;
    }
    return len;
  };
  let b = a * (1.25 + (0.74 - 1.25) * smooth(0.25, 1, f));
  if (crownLength(b) > 0.94 * cloth) {
    let lo = 0;
    let hi = b;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (crownLength(mid) > 0.94 * cloth) hi = mid;
      else lo = mid;
    }
    b = lo;
  }
  const lc = crownLength(b);
  const ls = Math.max(cloth - lc, 1e-4);
  // Skirt: r = a - (a - mouth) t^2, y = -h t; h from the remaining cloth length.
  const mouth = a * (0.62 + (0.96 - 0.62) * smooth(0.3, 1, f));
  const skirtLength = (h: number): number => {
    let len = 0;
    let pr = a;
    let py = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const r = a - (a - mouth) * t * t;
      const y = -h * t;
      len += Math.hypot(r - pr, y - py);
      pr = r;
      py = y;
    }
    return len;
  };
  let lo = 0;
  let hi = ls;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (skirtLength(mid) > ls) hi = mid;
    else lo = mid;
  }
  const h = lo;

  // Polyline of the whole meridian, then resampled uniformly in cloth length.
  const pr: number[] = [];
  const py: number[] = [];
  for (let i = 0; i <= N; i++) {
    const phi = phi0 + ((Math.PI / 2 - phi0) * i) / N;
    pr.push(a * Math.sin(phi));
    py.push(h + b * Math.cos(phi));
  }
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    pr.push(a - (a - mouth) * t * t);
    py.push(h - h * t);
  }
  const cum: number[] = [0];
  for (let i = 1; i < pr.length; i++) cum.push(cum[i - 1]! + Math.hypot(pr[i]! - pr[i - 1]!, py[i]! - py[i - 1]!));
  const total = cum[cum.length - 1]!;
  const r = new Float32Array(PROFILE_SAMPLES);
  const y = new Float32Array(PROFILE_SAMPLES);
  let k = 0;
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const target = (total * i) / (PROFILE_SAMPLES - 1);
    while (k < cum.length - 2 && cum[k + 1]! < target) k++;
    const span = Math.max(cum[k + 1]! - cum[k]!, 1e-9);
    const t = Math.min(1, Math.max(0, (target - cum[k]!) / span));
    r[i] = pr[k]! + (pr[k + 1]! - pr[k]!) * t;
    y[i] = py[k]! + (py[k + 1]! - py[k]!) * t;
  }
  return { r, y, radius: a, mouth, height: h + b * Math.cos(phi0) };
}

/** Inflation of table row `level` (the first rows are spaced finely: reefing stages are small fractions). */
export const profileLevelInflation = (level: number): number => Math.pow(level / (PROFILE_LEVELS - 1), 2);
/** Table row coordinate (0..1) of an inflation. */
export const profileLevelCoord = (inflation: number): number => Math.sqrt(Math.min(1, Math.max(inflation, 0)));

/** PROFILE_LEVELS x PROFILE_SAMPLES table, 4 floats per texel: r, y, 0, 0 (row = inflation level, column = s). */
export function buildProfileTable(style: CanopyStyleDef): Float32Array {
  const out = new Float32Array(PROFILE_LEVELS * PROFILE_SAMPLES * 4);
  for (let level = 0; level < PROFILE_LEVELS; level++) {
    const p = canopyProfile(style, profileLevelInflation(level));
    for (let i = 0; i < PROFILE_SAMPLES; i++) {
      const o = (level * PROFILE_SAMPLES + i) * 4;
      out[o] = p.r[i]!;
      out[o + 1] = p.y[i]!;
    }
  }
  return out;
}

export interface CanopyMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Cloth panels (rings x gores). */
  panels: number;
}

/**
 * Topology of one canopy: `rings` cloth rings of `gores` panels each; every ring leaves the upper
 * `slotFraction` of its width open (the slots of the crown, the crescent gaps of the sails).
 */
export function buildCanopyMesh(style: CanopyStyleDef): CanopyMesh {
  const { gores, rings } = style;
  const vertsPerPanel = (PANEL_COLS + 1) * (PANEL_ROWS + 1);
  const vertices = new Float32Array(gores * rings * vertsPerPanel * CANOPY_VERTEX_FLOATS);
  const indices = new Uint32Array(gores * rings * PANEL_COLS * PANEL_ROWS * 6);
  let v = 0;
  let i = 0;
  for (let ring = 0; ring < rings; ring++) {
    const s0 = (ring + style.slotFraction) / rings;
    const s1 = (ring + 1) / rings;
    for (let gore = 0; gore < gores; gore++) {
      const base = v / CANOPY_VERTEX_FLOATS;
      for (let row = 0; row <= PANEL_ROWS; row++) {
        for (let col = 0; col <= PANEL_COLS; col++) {
          vertices[v++] = s0 + ((s1 - s0) * row) / PANEL_ROWS;
          vertices[v++] = gore + col / PANEL_COLS;
          vertices[v++] = ring + row / PANEL_ROWS;
        }
      }
      for (let row = 0; row < PANEL_ROWS; row++) {
        for (let col = 0; col < PANEL_COLS; col++) {
          const a = base + row * (PANEL_COLS + 1) + col;
          const b = a + PANEL_COLS + 1;
          indices[i++] = a;
          indices[i++] = b;
          indices[i++] = a + 1;
          indices[i++] = a + 1;
          indices[i++] = b;
          indices[i++] = b + 1;
        }
      }
    }
  }
  return { vertices, indices, panels: gores * rings };
}

/**
 * Half-angle between the axis of a cluster and the axis of each of its `count` canopies: the canopies stand
 * side by side (centres `clusterGap` projected diameters apart) at the end of lines `lineLength` long.
 * `radius` = projected radius in metres at the current inflation.
 */
export function clusterAngle(style: CanopyStyleDef, count: number, radius: number, lineLength: number): number {
  if (count <= 1) return 0;
  const spacing = 2 * radius * style.clusterGap;
  const circumradius = spacing / (2 * Math.sin(Math.PI / count));
  return Math.asin(Math.min(0.6, circumradius / Math.max(lineLength, 1e-3)));
}
