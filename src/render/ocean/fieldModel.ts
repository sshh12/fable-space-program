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
 * hundred metres up to orbit:
 *  - mesoscale wind (about 110 km): log-normal changes of the wind sea, carried by a flow (two octaves of
 *    displacement) that everything below follows;
 *  - surface films where the wind is light: slick FILAMENTS (the zero set of a flow-warped noise stretched along
 *    the wind: single meandering lines kilometres to tens of kilometres long, 50-500 m wide, that end and rejoin:
 *    bright threads inside the glint, dark ones outside it) and calm POOLS (hard-edged tongues along the wind);
 *  - gusts (cat's paws, 0.8 x 3 km) and wind rows (streaks 75-230 m apart, many times longer than wide), all
 *    along the wind;
 *  - packets of internal waves (parallel bands 1.3 km apart) in places.
 * Every term is filtered with the footprint it is seen with: an octave fades out before it could alias, a line
 * contributes its covered fraction.
 */

export interface FieldParams {
  /** Log amplitude of the mesoscale wind term. */
  windVariability: number;
  /** Depth of calm pools (0..1). */
  slickStrength: number;
  /** Log amplitude of gusts and wind rows. */
  gustVariability: number;
  /** Depth of slick lines (0..1). */
  filamentStrength: number;
}

/** Scales of the recipe (chart metres); mirrored as constants in the WGSL. */
export const FIELD = {
  wind: 110000,
  warp0: 45000,
  warp0Amp: 14000,
  warp1: 11000,
  warp1Amp: 4000,
  line1Along: 30000,
  line1Across: 6000,
  line1Half: 75,
  lineGate: 9000,
  line2Along: 12000,
  line2Across: 2000,
  line2Half: 28,
  line3Along: 4500,
  line3Across: 800,
  line3Half: 14,
  poolAlong: 140000,
  poolAcross: 7000,
  row1Along: 2600,
  row1Across: 230,
  row2Along: 800,
  row2Across: 75,
  gustAlong: 3200,
  gustAcross: 800,
  internalWave: 1300,
  internalPatch: 48000,
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

function grad2(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const hb = fieldHash(ix, iy, seed) & 7;
  const sx = hb & 1 ? -1 : 1;
  const sy = hb & 2 ? -1 : 1;
  if (hb < 4) return 0.70710678 * (sx * dx + sy * dy);
  return sy * (hb & 1 ? dy : dx);
}

/** 2-D gradient noise, about [-1.3, 1.3], standard deviation 0.41. */
export function fieldNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad2(ix, iy, seed, fx, fy);
  const b = grad2(ix + 1, iy, seed, fx - 1, fy);
  const c = grad2(ix, iy + 1, seed, fx, fy - 1);
  const d = grad2(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return (a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uy) * FIELD.noiseScale;
}

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
  const w = Math.max(fp, 0.5 * half);
  const lo = Math.max(dist - 0.5 * w, -half);
  const hi = Math.min(dist + 0.5 * w, half);
  return saturate((hi - lo) / w);
}

/** The field before normalisation at wind-chart position (x along, y across; m) seen with `footprint` (chart m). */
export function fieldRaw(x: number, y: number, p: FieldParams, footprint: number): number {
  const F = FIELD;
  // The flow that films and calm water follow: two octaves of displacement (marbling).
  let wx = fieldNoise2(x / F.warp0 + 3.1, y / F.warp0 + 7.7, 13) * F.warp0Amp;
  let wy = fieldNoise2(x / F.warp0 + 9.2, y / F.warp0 + 1.3, 14) * F.warp0Amp;
  wx += fieldNoise2(x / F.warp1 + 4.4, y / F.warp1 + 2.9, 22) * F.warp1Amp;
  wy += fieldNoise2(x / F.warp1 + 6.3, y / F.warp1 + 8.1, 23) * F.warp1Amp;
  const n0 = fieldNoise2((x + 0.5 * wx) / F.wind, (y + 0.5 * wy) / F.wind, 11);
  const wind = Math.exp(1.3 * p.windVariability * n0);
  // Surface films survive where the wind is light: calm pools only there, filaments (swept together by the
  // currents) over a wider range of wind.
  const calm = smoothstep(0.35, -0.1, n0);
  const calmL = smoothstep(0.65, 0, n0);
  let slick = 0;
  let pool = 0;
  if (calmL > 0) {
    // Slick filaments: the ZERO SET of a flow-warped noise stretched along the wind (single lines that meander along
    // the wind, end and rejoin; never the nested rings of a contour map), width and strength varying along them
    // with a gate, antialiased by the footprint.
    const gate = fieldNoise2((x + wx) / F.lineGate, (y + wy) / F.lineGate, 16);
    const t1 = fieldNoise2((x + wx) / F.line1Along, (y + wy) / F.line1Across, 15);
    const g1 = 0.9 / F.line1Across;
    const l1 = lineCover(Math.abs(t1), F.line1Half * g1 * (0.5 + 1.5 * smoothstep(-0.2, 0.6, gate)), footprint * g1) * smoothstep(-0.45, 0.05, gate);
    const t2 = fieldNoise2((x + 0.7 * wx) / F.line2Along, (y + 0.7 * wy) / F.line2Across, 17);
    const g2 = 0.9 / F.line2Across;
    const l2 = lineCover(Math.abs(t2), F.line2Half * g2 * (0.6 + 0.8 * smoothstep(0.5, -0.5, gate)), footprint * g2) * smoothstep(0.25, -0.35, gate);
    // Fine threads wound more tightly by the flow (the marbling of a glint seen from orbit).
    const t3 = fieldNoise2((x + 1.25 * wx) / F.line3Along, (y + 1.25 * wy) / F.line3Across, 25);
    const g3 = 0.9 / F.line3Across;
    const l3 = lineCover(Math.abs(t3), F.line3Half * g3, footprint * g3) * smoothstep(-0.3, 0.2, gate);
    slick = Math.max(l1, 0.8 * l2, 0.6 * l3) * calmL;
    // Calm pools: hard-edged tongues of the same flow.
    // (The finer line noise frays their edges into streaks.)
    const tp = fieldNoise2((x + wx) / F.poolAlong, (y + wy) / F.poolAcross, 18) + 0.15 * t2;
    const ep = 0.012 + 0.5 * (0.9 / F.poolAcross) * footprint;
    pool = smoothstep(0.3 - ep, 0.3 + ep, tp) * calm;
  }
  // Gusts (cat's paws) and wind rows: streaks along the wind.
  let rows = 0;
  const og = fieldOctave(footprint, F.gustAcross);
  if (og > 0) {
    rows = 1.1 * fieldNoise2((x + 0.05 * wx) / F.gustAlong, (y + 0.05 * wy) / F.gustAcross, 20) * og;
    const o1 = fieldOctave(footprint, F.row1Across);
    if (o1 > 0) {
      rows += fieldNoise2(x / F.row1Along, y / F.row1Across, 24) * o1;
      const o2 = fieldOctave(footprint, F.row2Across);
      if (o2 > 0) rows += 0.7 * fieldNoise2(x / F.row2Along, y / F.row2Across, 19) * o2;
    }
  }
  // Internal-wave packets in a few places: narrow rough bands 1.3 km apart (where the wave's convergence crosses),
  // bent by the flow, on calmer water between them. (0.2256 = the mean of the crest profile.)
  const oi = fieldOctave(footprint, 0.5 * F.internalWave);
  let iw = 0;
  if (oi > 0) {
    const patch = smoothstep(0.45, 0.6, fieldNoise2(x / F.internalPatch + 5.5, y / F.internalPatch + 2.5, 21));
    if (patch > 0) {
      // Trains of eight crests, the leading one strongest (a soliton packet), not an endless grating.
      const u = (x + wx) / (8 * F.internalWave);
      const train = Math.exp(-3 * (u - Math.floor(u)));
      iw = ((0.5 + 0.5 * Math.sin((6.283185307 * (x + wx)) / F.internalWave)) ** 6 - 0.2256) * 1.5 * patch * oi * train;
    }
  }
  return wind * Math.exp(1.5 * p.gustVariability * rows) * (1 + 0.25 * iw) * (1 - 0.9 * p.filamentStrength * slick) * (1 - 0.55 * p.slickStrength * pool);
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
