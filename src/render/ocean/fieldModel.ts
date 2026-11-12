/**
 * The planet-fixed roughness field of the water's unresolved slope variance, on the CPU (float64): the reference
 * of the WGSL in shaders/waterBrdf.ts (WATER_FIELD_WGSL), used to normalise the field's mean to 1 per body and by
 * the unit tests. Same integer hash, same recipe; the two agree to float32 rounding.
 *
 * Coordinates: the WIND CHART of a body, a Mercator chart of its sea-level sphere rotated so that x runs along the
 * compass direction the wind blows toward and y across it (to the right), in metres at the equator. Mercator is
 * conformal and turns a constant compass direction into a straight line, so "along the wind" is one axis of one
 * chart for the whole planet; lengths on the surface are chart lengths x cos(latitude).
 *
 * The field m (mean 1) multiplies the Cox-Munk slope variance. It is what gives the sun glint its structure from a
 * hundred metres up to orbit. A real glint is a smooth silver sheen in which surface films show: they are swept
 * together by the surface currents into filaments that lie ALONG THE STREAMLINES of those currents (bundles of
 * thin, nearly parallel lines that wind around eddies, of uneven width and spacing, that start and stop), and into
 * broad fronts with one sharp and one feathered edge. So the recipe starts from the currents:
 *  - a STREAM FUNCTION psi of the surface currents (three octaves of eddies, 42, 13 and 4 km; its amplitude falls
 *    with scale as in two-dimensional turbulence, so the small eddies bend the streamlines of the large ones
 *    rather than break them into rings). Its level sets are the streamlines;
 *  - mesoscale wind (110 km and 30 km): log-normal changes of the wind sea;
 *  - where the wind is light, slick FILAMENTS: single streamlines psi = const, at most one per 1 / FIELD.lines of
 *    psi, each with its own place, width (tens to a few hundred metres on the sea, wider where the current is
 *    slow) and stretches where it thins to nothing; and FRONTS: bands between two streamlines, calm behind a sharp
 *    edge and returning to the open sea's roughness over a feathered one;
 *  - gusts (cat's paws, 0.9 x 1.8 km and 0.3 x 0.6 km), weak and broad: a soft change of the lobe's width, not a
 *    texture of strokes along the wind;
 *  - packets of internal waves (parallel bands 1.3 km apart, bent by the currents) in a few places.
 * Every term is filtered with the footprint it is seen with. A footprint is an ellipse (a pixel on the sea is long
 * along the view): a line is covered by the footprint's extent ACROSS the line (so a filament seen end-on at a
 * grazing angle stays a line, and one that crosses the view fades instead of breaking into dashes), an octave
 * fades out before the footprint's long axis could alias it.
 */

export interface FieldParams {
  /** Log amplitude of the mesoscale wind term. */
  windVariability: number;
  /** Depth of fronts (0..1). */
  slickStrength: number;
  /** Log amplitude of gusts. */
  gustVariability: number;
  /** Depth of slick filaments (0..1). */
  filamentStrength: number;
}

/** Scales of the recipe (chart metres); mirrored as constants in the WGSL. */
export const FIELD = {
  wind: 110000,
  wind2: 30000,
  /** Eddy sizes of the stream function, and the amplitudes of the two finer octaves relative to the first. */
  psi0: 42000,
  psi1: 13000,
  psi2: 4000,
  psiA1: 0.172,
  psiA2: 0.0294,
  /** Filament cells per unit of psi (a cell holds at most one filament). */
  lines: 34,
  /**
   * Filaments come in bundles: runs of lineBundle cells, a share lineDense of which are dense (a cell of a dense run
   * holds a filament with probability lineInBundle, of the others with lineOutside).
   */
  lineBundle: 6,
  lineDense: 0.5,
  lineInBundle: 0.85,
  lineOutside: 0.1,
  /** A filament's half-width in cells, from..to; the widest it gets on the sea (m). */
  lineHalfMin: 0.03,
  lineHalfMax: 0.14,
  lineHalfCap: 220,
  /**
   * Filaments fade out where the current is slower than this (|grad psi| per m, from..to): around the centre of an
   * eddy a streamline is a small ring, which a film swept there fills as a patch and does not trace.
   */
  lineSlow0: 1.2e-5,
  lineSlow1: 3.0e-5,
  /** Scale of the noise that makes filaments start and stop. */
  lineGate: 9000,
  /** Covered fraction where a footprint holds many filaments. */
  lineMean: 0.05,
  /**
   * Fronts: the level set frontLevel of a noise of this scale, bent by the currents (frontBend x psi); calm water
   * behind it returns to the open sea's roughness over frontTail (m); the edge itself is frontEdge (m) wide.
   */
  front: 260000,
  frontLevel: 0.2,
  frontBend: 0.15,
  frontTail: 14000,
  frontEdge: 150,
  /** Gusts: patches of gust0Along x gust0Across (m) along the wind, and a finer, round octave of gust1 (m), turned. */
  gust0Along: 1800,
  gust0Across: 900,
  gust1: 450,
  internalWave: 1300,
  internalPatch: 48000,
  /** How far (m per unit of psi) the currents bend the crests of internal waves. */
  internalBend: 20000,
  /** Scale of fieldNoise2: its standard deviation is 0.41, its range about +-1.3 (tests/unit/ocean/field.test.ts). */
  noiseScale: 1.9,
} as const;

const u32 = (x: number): number => x >>> 0;

/** Integer hash of a lattice point (the WGSL waterHash). */
export function fieldHash(ix: number, iy: number, seed: number): number {
  let h = u32(Math.imul(ix | 0, 0x8da6b343) ^ Math.imul(iy | 0, 0xd8163841) ^ Math.imul(seed | 0, 0xcb1ab31f));
  h = u32(Math.imul(h ^ (h >>> 16), 0x7feb352d));
  h = u32(Math.imul(h ^ (h >>> 15), 0x846ca68b));
  return u32(h ^ (h >>> 16));
}

/** Gradient vector of a lattice point: one of eight directions (four diagonals, four axes). */
function gradVec(ix: number, iy: number, seed: number): [number, number] {
  const hb = fieldHash(ix, iy, seed) & 7;
  const sx = hb & 1 ? -1 : 1;
  const sy = hb & 2 ? -1 : 1;
  if (hb < 4) return [0.70710678 * sx, 0.70710678 * sy];
  return hb & 1 ? [0, sy] : [sy, 0];
}

/** 2-D gradient noise with its gradient per lattice unit: value about [-1.3, 1.3], standard deviation 0.41. */
export function fieldNoise2G(x: number, y: number, seed: number): { v: number; dx: number; dy: number } {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const ga = gradVec(ix, iy, seed);
  const gb = gradVec(ix + 1, iy, seed);
  const gc = gradVec(ix, iy + 1, seed);
  const gd = gradVec(ix + 1, iy + 1, seed);
  const a = ga[0] * fx + ga[1] * fy;
  const b = gb[0] * (fx - 1) + gb[1] * fy;
  const c = gc[0] * fx + gc[1] * (fy - 1);
  const d = gd[0] * (fx - 1) + gd[1] * (fy - 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  const gx0 = ga[0] + (gb[0] - ga[0]) * ux;
  const gx1 = gc[0] + (gd[0] - gc[0]) * ux;
  const gy0 = ga[1] + (gb[1] - ga[1]) * ux;
  const gy1 = gc[1] + (gd[1] - gc[1]) * ux;
  const s = FIELD.noiseScale;
  return {
    v: (ab + (cd - ab) * uy) * s,
    dx: (gx0 + (gx1 - gx0) * uy + dux * (b - a + (d - c - (b - a)) * uy)) * s,
    dy: (gy0 + (gy1 - gy0) * uy + duy * (cd - ab)) * s,
  };
}

/** 2-D gradient noise, about [-1.3, 1.3], standard deviation 0.41. */
export const fieldNoise2 = (x: number, y: number, seed: number): number => fieldNoise2G(x, y, seed).v;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const saturate = (x: number): number => Math.min(1, Math.max(0, x));

/** Weight of a noise octave of period `scale` seen with `footprint`: 1 well resolved, 0 below about two pixels. */
export const fieldOctave = (footprint: number, scale: number): number => 1 - smoothstep(0.25, 0.6, footprint / scale);

/**
 * Fraction of a footprint `fp` (in noise units) centred `dist` (noise units, >= 0) from a line that lies within
 * `half` of the line (its edges soft over half its width even where the footprint is sharp).
 */
export function lineCover(dist: number, half: number, fp: number): number {
  const w = Math.max(fp, 0.5 * half, 1e-9);
  const lo = Math.max(dist - 0.5 * w, -half);
  const hi = Math.min(dist + 0.5 * w, half);
  return saturate((hi - lo) / w);
}

/** The stream function of the surface currents and its gradient per chart metre, seen with `footprint` (m). */
export function fieldStream(x: number, y: number, footprint: number): { psi: number; gx: number; gy: number } {
  const F = FIELD;
  const z0 = fieldNoise2G(x / F.psi0 + 3.1, y / F.psi0 + 7.7, 13);
  const z1 = fieldNoise2G(x / F.psi1 + 4.4, y / F.psi1 + 2.9, 22);
  let psi = z0.v + F.psiA1 * z1.v;
  let gx = z0.dx / F.psi0 + (F.psiA1 * z1.dx) / F.psi1;
  let gy = z0.dy / F.psi0 + (F.psiA1 * z1.dy) / F.psi1;
  const o2 = fieldOctave(footprint, F.psi2);
  if (o2 > 0) {
    const z2 = fieldNoise2G(x / F.psi2 + 6.3, y / F.psi2 + 8.1, 23);
    psi += F.psiA2 * o2 * z2.v;
    gx += (F.psiA2 * o2 * z2.dx) / F.psi2;
    gy += (F.psiA2 * o2 * z2.dy) / F.psi2;
  }
  return { psi, gx, gy };
}

/**
 * The field before normalisation at wind-chart position (x along, y across; m). The footprint it is seen with is an
 * ellipse (chart m): `footprint` across the view, `major` along the unit direction (`vx`, `vy`) of the view on the
 * sea. With the defaults it is a disc.
 */
export function fieldRaw(x: number, y: number, p: FieldParams, footprint: number, major = footprint, vx = 1, vy = 0): number {
  const F = FIELD;
  const n0 = fieldNoise2(x / F.wind, y / F.wind, 11);
  let n1 = 0;
  const ow = fieldOctave(major, F.wind2);
  if (ow > 0) n1 = fieldNoise2(x / F.wind2 + 1.9, y / F.wind2 + 5.3, 12) * ow;
  const wind = Math.exp(1.3 * p.windVariability * (n0 + 0.5 * n1));
  // Surface films survive where the wind is light: fronts only there, filaments over a wider range of wind.
  const calm = smoothstep(0.35, -0.1, n0);
  const active = smoothstep(0.45, -0.3, n0);
  const st = fieldStream(x, y, major);
  let slick = 0;
  let front = 0;
  {
    if (active > 0) {
      const gl = Math.hypot(st.gx, st.gy);
      // The footprint's extent across the streamlines (along the gradient of psi).
      const al = gl > 0 ? Math.abs(st.gx * vx + st.gy * vy) / gl : 0;
      const fpd = Math.sqrt((major * al) ** 2 + footprint * footprint * (1 - al * al));
      // Filaments: one streamline per cell of psi x lines, in the cells that hold one. Where it lies in its cell, how
      // wide it is and where along its length it shows are the cell's own; its width on the sea is its width in psi
      // over the current's speed. The cells on either side are looked at too, so a footprint that reaches across a
      // cell boundary sees the neighbour's line.
      const g = F.lines * gl;
      const v = st.psi * F.lines;
      const ci = Math.floor(v);
      const fpv = fpd * g;
      const gate = fieldNoise2(x / F.lineGate, y / F.lineGate, 16);
      let cov = 0;
      for (let j = -1; j <= 1; j++) {
        const h = fieldHash(ci + j, 7, 41);
        const dense = (fieldHash(Math.floor((ci + j) / F.lineBundle), 9, 47) & 1023) / 1024 < F.lineDense;
        if ((h & 1023) / 1024 >= (dense ? F.lineInBundle : F.lineOutside)) continue;
        const r2 = ((h >>> 10) & 1023) / 1024;
        const r3 = ((h >>> 20) & 1023) / 1024;
        const shown = smoothstep(-0.35, 0.25, gate + (r2 - 0.5) * 0.9);
        const half = Math.min((F.lineHalfMin + (F.lineHalfMax - F.lineHalfMin) * r3) * shown, F.lineHalfCap * g);
        cov += lineCover(Math.abs(v - (ci + j + 0.2 + 0.6 * r2)), half, fpv);
      }
      const many = smoothstep(0.8, 1.6, fpv);
      slick = (Math.min(cov, 1) * (1 - many) + F.lineMean * many) * active * smoothstep(F.lineSlow0, F.lineSlow1, gl);
    }
    if (calm > 0) {
      // Fronts: one long line (a level set of a slow noise, bent by the currents), calm right behind it, the open
      // sea's roughness again some kilometres further on. Distances from the function's value over its gradient.
      const zf = fieldNoise2G(x / F.front + 2.7, y / F.front + 6.1, 18);
      const phi = zf.v - F.frontLevel + F.frontBend * st.psi;
      const px = zf.dx / F.front + F.frontBend * st.gx;
      const py = zf.dy / F.front + F.frontBend * st.gy;
      const pl = Math.max(Math.hypot(px, py), 1e-12);
      const d = phi / pl;
      const ax = Math.abs(px * vx + py * vy) / pl;
      const edge = Math.max(Math.sqrt((major * ax) ** 2 + footprint * footprint * (1 - ax * ax)), F.frontEdge);
      front = smoothstep(-edge, edge, d) * Math.exp(-Math.max(d, 0) / F.frontTail) * calm;
    }
  }
  // Gusts (cat's paws): broad and weak.
  let gust = 0;
  const og = fieldOctave(major, F.gust0Across);
  if (og > 0) {
    gust = fieldNoise2(x / F.gust0Along, y / F.gust0Across, 20) * og;
    const o1 = fieldOctave(major, F.gust1);
    // (Turned by atan(0.6 / 0.8) against the first octave's lattice.)
    if (o1 > 0) gust += 0.6 * fieldNoise2((0.8 * x + 0.6 * y) / F.gust1, (0.8 * y - 0.6 * x) / F.gust1, 24) * o1;
  }
  // Internal-wave packets in a few places: narrow rough bands 1.3 km apart (where the wave's convergence crosses),
  // bent by the currents, on calmer water between them. (0.2256 = the mean of the crest profile.)
  const oi = fieldOctave(major, 0.5 * F.internalWave);
  let iw = 0;
  if (oi > 0) {
    const patch = smoothstep(0.45, 0.6, fieldNoise2(x / F.internalPatch + 5.5, y / F.internalPatch + 2.5, 21));
    if (patch > 0) {
      // Trains of eight crests, the leading one strongest (a soliton packet), not an endless grating.
      const xw = x + F.internalBend * st.psi;
      const u = xw / (8 * F.internalWave);
      const train = Math.exp(-3 * (u - Math.floor(u)));
      iw = ((0.5 + 0.5 * Math.sin((6.283185307 * xw) / F.internalWave)) ** 6 - 0.2256) * 1.5 * patch * oi * train;
    }
  }
  return wind * Math.exp(1.5 * p.gustVariability * gust) * (1 + 0.18 * iw) * (1 - 0.9 * p.filamentStrength * slick) * (1 - 0.55 * p.slickStrength * front);
}

/**
 * Wind-chart coordinates (m at the equator; x along the compass direction `windDir` the wind blows toward, rad
 * clockwise from north; y across it to the right) of the body-fixed unit direction `dir` on a sea-level sphere of
 * `radius`, and the cosine of its latitude (surface metres per chart metre). The WGSL `waterChartOf` forms the same
 * coordinates from a camera-relative split.
 */
export function windChart(dir: { x: number; y: number; z: number }, radius: number, windDir: number): { x: number; y: number; cosLat: number } {
  const u = Math.min(0.9995, Math.max(-0.9995, dir.z / Math.hypot(dir.x, dir.y, dir.z)));
  const east = radius * Math.atan2(dir.y, dir.x);
  const north = radius * Math.atanh(u);
  return { x: east * Math.sin(windDir) + north * Math.cos(windDir), y: east * Math.cos(windDir) - north * Math.sin(windDir), cosLat: Math.sqrt(1 - u * u) };
}

/**
 * The roughness field (mean 1: `mean` = fieldMean of the same parameters) at body-fixed direction `dir`, seen with
 * `footprint` metres on the surface. What brdf_water multiplies the Cox-Munk slope variance with there.
 */
export function fieldAt(dir: { x: number; y: number; z: number }, radius: number, windDir: number, p: FieldParams, mean: number, footprint: number): number {
  const c = windChart(dir, radius, windDir);
  return fieldRaw(c.x, c.y, p, footprint / c.cosLat) / mean;
}

/** Mean of the raw field over a 1200 km square (fully resolved): the normalisation the shader divides by. */
export function fieldMean(p: FieldParams): number {
  let s = 0;
  let n = 0;
  // A lattice with an irrational step, so no sample row falls on a noise lattice line.
  for (let j = 0; j < 240; j++) {
    for (let i = 0; i < 240; i++) {
      s += fieldRaw(1.7e6 + i * 5003.7, -2.3e6 + j * 4999.3, p, 0);
      n++;
    }
  }
  return s / n;
}
