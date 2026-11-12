/**
 * The shared water shading function: registered as the overridable chunk "brdf_water", so the deferred
 * lighting of the far sea-level sheet and the ocean's forward near-field pass evaluate the SAME code with the
 * same inputs. Fixed signatures (docs/RENDER_API.md section 5): brdfWaterDirect(s, l), brdfWaterAmbient(s, a),
 * plus waterAlpha(s) and waterBodyColor(s).
 *
 * Model
 *  - Specular, F0 = 0.02. The slope variance not carried by the shading normal is unresolved and goes into the
 *    lobe: sigma^2_unresolved = (1 - resolved fraction) x (0.003 + 0.00512 U10) (Cox-Munk mean square slope) x the
 *    roughness field. The sun and the other lights are mirrored with the Gaussian slope distribution of that
 *    variance itself (Beckmann, Smith shadowing); the sky reflection's lobe is a GGX alpha = GGX_KAPPA x sigma of
 *    the same half-maximum width. One formula for the broad glint from orbit and the glitter path at the surface.
 *  - Glitter: the lobe is the EXPECTATION of the sun's image in the unresolved facets. A cell of the sea that
 *    holds N facets (its area / glintFacetSizeM^2) has on average k = N x P(slope) (n.h) Omega_sun / (4 l.h) of
 *    them mirroring the sun (P = the sea's Gaussian slope distribution); the lobe is multiplied by a factor of
 *    expectation 1 drawn per cell, (1 + k) / k x u^(1/k) for u uniform in (0, 1): for k << 1 nearly every cell is
 *    dark and a few carry the whole energy (a sparkle of up to the sun's own radiance on one facet), for k >> 1
 *    every cell is near the mean. Continuous in k, so two shadings of one point that differ a little (the forward
 *    and the deferred pass at the hand-over) differ a little. Cells are sea-anchored squares no larger than the
 *    pixel (two levels of 2^k / 64 m, blended), re-drawn about 14 times a second, cell by cell; cells of more than
 *    a few metres hold so many facets that one sparkle is below the sea's own radiance: there the lobe is smooth.
 *    From orbit and from 10 km the glint is a sheen; from a parachute it is sparkles on dark water.
 *  - Far waves: where the surface it is handed is the flat sheet (or the near field fading out), the shading
 *    normal is tilted by the far-wave bank (farWaves.ts), each component band-limited by the pixel footprint along
 *    its own direction, its variance taken out of the lobe.
 *  - Roughness field (fieldModel.ts): wind, slicks, gusts and wind rows in the planet-fixed wind chart.
 *  - Sky reflection: mean Fresnel of the visible facets (Schlick at the cosine the roughness leaves at grazing
 *    angles) x the sky along the mirror direction of the mean visible facet (lifted from the horizon by the
 *    roughness), from the environment probe (kept above the horizon) or the sky-view table near the camera, the
 *    local sky irradiance / pi far away.
 *  - Body colour: the shallow-water remote-sensing reflectance of Lee et al. (1998/1999) with per-channel
 *    absorption a (BodyDef.render.ocean.absorption) and backscatter bb (params), single scattering of the
 *    water column (rrs_deep = (0.084 + 0.17 u) u, u = bb / (a + bb)) attenuated along the refracted sun and
 *    view paths, and the bottom seen through the column: rrs = rrs_deep (1 - e^-(1/muW + Du/muV) K H) +
 *    (rho_b / pi) e^-(1/muW + Db/muV) K H, Rrs = 0.5 rrs / (1 - 1.5 rrs). H = decodeWaterDepth(s.param); the
 *    bottom albedo rho_b is the imagery colour (s.albedo: turquoise over shelves), whose chroma also tints the
 *    deep term (regional colour: plankton, sediment). Fresnel transmission at grazing sun and view angles.
 *  - Foam: statistical whitecap coverage (Monahan & O'Muircheartaigh 1980, 3.84e-6 U^3.41, aged-foam
 *    reflectance factor 0.4) everywhere; the forward pass hands its resolved foam in (below). Foam is a diffuse
 *    layer lit on the wave's own slope; it hides the specular and the body under it.
 *
 * Surface fields for MATERIAL_WATER (what the far sheet writes leaves the extras 0):
 *   n         shading normal (the sheet's normal, or the resolved wave normal)
 *   roughness FRACTION of the Cox-Munk slope variance already carried by n (0 = none, the far sheet)
 *   albedo    imagery colour of the water;  param = encodeWaterDepth(depth below the sea surface)
 *   metallic  resolved foam coverage x opacity, clearcoatRoughness its weight against the statistical whitecaps
 *             (0 far), clearcoat the albedo of that foam relative to the body's foam albedo
 *   t         where clearcoatRoughness is set (the forward pass): the normal of the foam's own relief
 *
 * Private inputs a forward pass may set before calling (the deferred pass leaves the defaults):
 *   waterAnchor    xyz = a camera-relative point, w = how far (0..1) it replaces the point brdf_water looks its
 *                  planet-fixed lattices up at (glitter cells, far waves, field: by default where the eye ray
 *                  meets the sea-level sphere); the near field passes its surface point and its wave detail
 *   waterFarWeight amplitude of the far-wave bank (default 1; the near field passes sqrt(1 - detail^2))
 *   waterFieldValue / waterFieldBaked (variant "ocean_water_forward" only) the roughness field from the pass's
 *                  baked texture and how far it replaces the evaluated field (1 = wholly)
 */
import { MAX_BODIES } from '@/render/core';
import { FAR_WAVE_COUNT, type FarWave } from '../farWaves';
import { FIELD } from '../fieldModel';
import type { OceanTunables } from '../params';
import { GGX_KAPPA } from '../params';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Statistical whitecap coverage x aged-foam factor, the same in WGSL. */
export const whitecapCoverage = (windSpeed: number): number => Math.min(0.2, 3.84e-6 * windSpeed ** 3.41) * 0.4;

/** What the chunk compiles in per body with an ocean. */
export interface WaterBody {
  tunables: OceanTunables;
  /** Mean of the raw roughness field (fieldModel.fieldMean): the shader divides by it. */
  fieldMean: number;
  /** The far-wave bank (FAR_WAVE_COUNT components). */
  farWaves: readonly FarWave[];
}

/**
 * The wind chart, its noise and the roughness field (the WGSL of fieldModel.ts). Needs the chunk "frame" (PI,
 * TWO_PI, sq). Included by the brdf chunk and by the bake of the field texture (fieldWgsl.ts).
 */
export const WATER_FIELD_WGSL = /* wgsl */ `
/// A point in the wind chart of a body (a Mercator chart of its sea-level sphere, x along the compass direction the
/// wind blows toward, y across it to the right; metres at the equator), split so that float32 keeps it exact: the
/// coordinates of an ORIGIN near the point (large; the same for every pixel of a frame) and the offset of the point
/// from it (small, formed without cancellation).
struct WaterChart {
  base: vec2f,
  d: vec2f,
  cosLat: f32,    // surface metres per chart metre at the point
  seam: f32,      // 0 = this chart alone .. 1 = the chart cut on the other side of the planet alone
}

fn waterAtanh(x: f32) -> f32 {
  if (abs(x) < 0.1) {
    let x2 = x * x;
    return x * (1.0 + x2 * (0.33333333 + x2 * (0.2 + x2 * 0.14285714)));
  }
  return 0.5 * log((1.0 + x) / (1.0 - x));
}

/// c = body-fixed position of the origin (m from the body's centre: the camera, or a bake's reference point),
/// dlt = body-fixed offset of the point from it, radius = sea-level radius, wind = (sin, cos) of the compass
/// direction the wind blows toward. variant 0 = the chart cut along the +-180 deg meridian, 1 = the same chart cut
/// along the prime meridian (used, blended over 'seam', within 12 deg of the +-180 deg meridian).
fn waterChartOf(c: vec3f, dlt: vec3f, radius: f32, wind: vec2f, variant: f32) -> WaterChart {
  let p = c + dlt;
  let rc = max(length(c), 1.0);
  let rp = max(length(p), 1.0);
  var lonC = atan2(c.y, c.x);
  let dLon = atan2(c.x * dlt.y - c.y * dlt.x, c.x * c.x + c.y * c.y + c.x * dlt.x + c.y * dlt.y);
  let lonP = lonC + dLon;
  var o: WaterChart;
  o.seam = smoothstep(2.94, 3.04, abs(lonP - TWO_PI * floor(lonP / TWO_PI + 0.5)));
  if (variant > 0.5) { lonC -= select(-PI, PI, lonC >= 0.0); }
  let lonBase = lonC - TWO_PI * floor((lonC + dLon) / TWO_PI + 0.5);
  let uC = clamp(c.z / rc, -0.9995, 0.9995);
  let dr = (2.0 * dot(c, dlt) + dot(dlt, dlt)) / (rp + rc);
  let dU = (dlt.z * rc - c.z * dr) / (rc * rp);
  let uP = clamp(uC + dU, -0.9995, 0.9995);
  let dPsi = waterAtanh(dU / (1.0 - uP * uC));
  let xb = radius * lonBase;
  let yb = radius * 0.5 * log((1.0 + uC) / (1.0 - uC));
  let xd = radius * dLon;
  let yd = radius * dPsi;
  o.base = vec2f(xb * wind.x + yb * wind.y, xb * wind.y - yb * wind.x);
  o.d = vec2f(xd * wind.x + yd * wind.y, xd * wind.y - yd * wind.x);
  o.cosLat = sqrt(max(1.0 - uP * uP, 1e-6));
  return o;
}

fn waterHash(i: vec2i, seed: i32) -> u32 {
  var h = (u32(i.x) * 0x8da6b343u) ^ (u32(i.y) * 0xd8163841u) ^ (u32(seed) * 0xcb1ab31fu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn waterGradVec(i: vec2i, seed: i32) -> vec2f {
  let hb = waterHash(i, seed) & 7u;
  let sx = select(1.0, -1.0, (hb & 1u) != 0u);
  let sy = select(1.0, -1.0, (hb & 2u) != 0u);
  let axis = select(vec2f(sy, 0.0), vec2f(0.0, sy), (hb & 1u) != 0u);
  return select(axis, vec2f(0.70710678 * sx, 0.70710678 * sy), hb < 4u);
}
/// 2-D gradient noise (fieldNoise2G) at the lattice coordinate cell + off: 'cell' is the large part (its integer
/// part and its fraction are taken exactly), 'off' the small precise part. x = the value, yz = its gradient per
/// lattice unit.
fn waterNoise2G(cell: vec2f, off: vec2f, seed: i32) -> vec3f {
  let cb = floor(cell);
  let x = (cell - cb) + off;
  let xf = floor(x);
  let i = vec2i(cb) + vec2i(xf);
  let t = x - xf;
  let u = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  let du = 30.0 * t * t * (t * (t - 2.0) + 1.0);
  let ga = waterGradVec(i, seed);
  let gb = waterGradVec(i + vec2i(1, 0), seed);
  let gc = waterGradVec(i + vec2i(0, 1), seed);
  let gd = waterGradVec(i + vec2i(1, 1), seed);
  let a = dot(ga, t);
  let b = dot(gb, t - vec2f(1.0, 0.0));
  let c = dot(gc, t - vec2f(0.0, 1.0));
  let d = dot(gd, t - vec2f(1.0, 1.0));
  let ab = mix(a, b, u.x);
  let cd = mix(c, d, u.x);
  let g = mix(mix(ga, gb, u.x), mix(gc, gd, u.x), u.y) + vec2f(du.x * mix(b - a, d - c, u.y), du.y * (cd - ab));
  return vec3f(mix(ab, cd, u.y), g) * ${f(FIELD.noiseScale)};
}
/// The same, the value alone.
fn waterNoise2(cell: vec2f, off: vec2f, seed: i32) -> f32 {
  let cb = floor(cell);
  let x = (cell - cb) + off;
  let xf = floor(x);
  let i = vec2i(cb) + vec2i(xf);
  let t = x - xf;
  let u = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  let a = dot(waterGradVec(i, seed), t);
  let b = dot(waterGradVec(i + vec2i(1, 0), seed), t - vec2f(1.0, 0.0));
  let c = dot(waterGradVec(i + vec2i(0, 1), seed), t - vec2f(0.0, 1.0));
  let d = dot(waterGradVec(i + vec2i(1, 1), seed), t - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * ${f(FIELD.noiseScale)};
}
/// Noise of the chart point, lattice period 'scale' (along, across), lattice offset 'o'.
fn waterChartNoise(ch: WaterChart, scale: vec2f, o: vec2f, seed: i32) -> f32 {
  return waterNoise2(ch.base / scale, ch.d / scale + o, seed);
}
/// Weight of a noise octave of period 'scale' (m) seen with 'footprint' (m): 1 well resolved, 0 below about two pixels.
fn waterOctave(footprint: f32, scale: f32) -> f32 { return 1.0 - smoothstep(0.25, 0.6, footprint / scale); }
/// Fraction of a footprint 'fp' (noise units) centred 'dist' from a line that lies within 'hw' of the line (the
/// line's edges soft over half its width even where the footprint is sharp).
fn waterLineCover(dist: f32, hw: f32, fp: f32) -> f32 {
  let w = max(max(fp, 0.5 * hw), 1e-9);
  return saturate((min(dist + 0.5 * w, hw) - max(dist - 0.5 * w, -hw)) / w);
}

/// The stream function of the surface currents at chart point 'ch' (fieldStream): psi, and its gradient per chart
/// metre. Its level sets are the streamlines that slick filaments and fronts lie along.
struct WaterStream { psi: f32, g: vec2f }
fn waterStream(ch: WaterChart, footprint: f32) -> WaterStream {
  let z0 = waterNoise2G(ch.base / ${f(FIELD.psi0)}, ch.d / ${f(FIELD.psi0)} + vec2f(3.1, 7.7), 13);
  let z1 = waterNoise2G(ch.base / ${f(FIELD.psi1)}, ch.d / ${f(FIELD.psi1)} + vec2f(4.4, 2.9), 22);
  var s: WaterStream;
  s.psi = z0.x + ${f(FIELD.psiA1)} * z1.x;
  s.g = z0.yz / ${f(FIELD.psi0)} + z1.yz * ${f(FIELD.psiA1 / FIELD.psi1)};
  let o2 = waterOctave(footprint, ${f(FIELD.psi2)});
  if (o2 > 0.0) {
    let z2 = waterNoise2G(ch.base / ${f(FIELD.psi2)}, ch.d / ${f(FIELD.psi2)} + vec2f(6.3, 8.1), 23);
    s.psi += ${f(FIELD.psiA2)} * o2 * z2.x;
    s.g += z2.yz * (${f(FIELD.psiA2 / FIELD.psi2)} * o2);
  }
  return s;
}

/// The roughness field before normalisation (fieldModel.fieldRaw) at chart point 'ch'. The footprint it is seen with
/// is an ellipse on the sea (surface m): fpS.x across the view, fpS.y along the unit direction 'vh' of the view in
/// the chart's axes. q = (wind variability, front strength, gust variability, filament strength).
fn waterFieldRaw(ch: WaterChart, q: vec4f, fpS: vec2f, vh: vec2f) -> f32 {
  let fp = fpS.x / ch.cosLat;
  let fpM = max(fpS.x, fpS.y) / ch.cosLat;
  let n0 = waterChartNoise(ch, vec2f(${f(FIELD.wind)}), vec2f(0.0), 11);
  var n1 = 0.0;
  let ow = waterOctave(fpM, ${f(FIELD.wind2)});
  if (ow > 0.0) { n1 = waterChartNoise(ch, vec2f(${f(FIELD.wind2)}), vec2f(1.9, 5.3), 12) * ow; }
  let wind = exp(1.3 * q.x * (n0 + 0.5 * n1));
  // Surface films survive where the wind is light: fronts only there, filaments over a wider range of wind.
  let calm = 1.0 - smoothstep(-0.1, 0.35, n0);
  let films = 1.0 - smoothstep(-0.3, 0.45, n0);
  let st = waterStream(ch, fpM);
  var slick = 0.0;
  var front = 0.0;
  if (films > 0.0) {
    let gl = length(st.g);
    // The footprint's extent across the streamlines (along the gradient of psi).
    var al = 0.0;
    if (gl > 0.0) { al = abs(dot(st.g, vh)) / gl; }
    let fpd = sqrt(sq(fpM * al) + sq(fp) * (1.0 - al * al));
    {
      // Filaments: one streamline per cell of psi x lines, in the cells that hold one; where it lies in its cell,
      // how wide it is and where along its length it shows are the cell's own, its width on the sea its width in
      // psi over the current's speed. The cells on either side are looked at too (a footprint that reaches across
      // a cell boundary sees the neighbour's line).
      let g = ${f(FIELD.lines)} * gl;
      let v = st.psi * ${f(FIELD.lines)};
      let ci = floor(v);
      let fpv = fpd * g;
      let gate = waterChartNoise(ch, vec2f(${f(FIELD.lineGate)}), vec2f(0.0), 16);
      var cov = 0.0;
      for (var j = -1; j <= 1; j++) {
        let cj = ci + f32(j);
        let h = waterHash(vec2i(i32(cj), 7), 41);
        // (Filaments come in bundles: runs of cells, dense or nearly empty.)
        let dense = f32(waterHash(vec2i(i32(floor(cj / ${f(FIELD.lineBundle)})), 9), 47) & 1023u) / 1024.0 < ${f(FIELD.lineDense)};
        if (f32(h & 1023u) / 1024.0 >= select(${f(FIELD.lineOutside)}, ${f(FIELD.lineInBundle)}, dense)) { continue; }
        let r2 = f32((h >> 10u) & 1023u) / 1024.0;
        let r3 = f32((h >> 20u) & 1023u) / 1024.0;
        let shown = smoothstep(-0.35, 0.25, gate + (r2 - 0.5) * 0.9);
        let hw = min((${f(FIELD.lineHalfMin)} + ${f(FIELD.lineHalfMax - FIELD.lineHalfMin)} * r3) * shown, ${f(FIELD.lineHalfCap)} * g);
        cov += waterLineCover(abs(v - (cj + 0.2 + 0.6 * r2)), hw, fpv);
      }
      slick = mix(min(cov, 1.0), ${f(FIELD.lineMean)}, smoothstep(0.8, 1.6, fpv)) * films * smoothstep(${f(FIELD.lineSlow0)}, ${f(FIELD.lineSlow1)}, gl);
    }
  }
  if (calm > 0.0) {
    // Fronts: one long line (a level set of a slow noise, bent by the currents), calm right behind it, the open
    // sea's roughness again some kilometres further on. Distances from the function's value over its gradient.
    let zf = waterNoise2G(ch.base / ${f(FIELD.front)}, ch.d / ${f(FIELD.front)} + vec2f(2.7, 6.1), 18);
    let phi = zf.x - ${f(FIELD.frontLevel)} + ${f(FIELD.frontBend)} * st.psi;
    let gp = zf.yz / ${f(FIELD.front)} + ${f(FIELD.frontBend)} * st.g;
    let pl = max(length(gp), 1e-12);
    let d = phi / pl;
    let ax = abs(dot(gp, vh)) / pl;
    let edge = max(sqrt(sq(fpM * ax) + sq(fp) * (1.0 - ax * ax)), ${f(FIELD.frontEdge)});
    front = smoothstep(-edge, edge, d) * exp(-max(d, 0.0) / ${f(FIELD.frontTail)}) * calm;
  }
  // Gusts (cat's paws): broad and weak.
  var gust = 0.0;
  let og = waterOctave(fpM, ${f(FIELD.gust0Across)});
  if (og > 0.0) {
    gust = waterChartNoise(ch, vec2f(${f(FIELD.gust0Along)}, ${f(FIELD.gust0Across)}), vec2f(0.0), 20) * og;
    let o1 = waterOctave(fpM, ${f(FIELD.gust1)});
    // (Turned by atan(0.6 / 0.8) against the first octave's lattice.)
    if (o1 > 0.0) {
      let rb = vec2f(0.8 * ch.base.x + 0.6 * ch.base.y, 0.8 * ch.base.y - 0.6 * ch.base.x);
      let rd = vec2f(0.8 * ch.d.x + 0.6 * ch.d.y, 0.8 * ch.d.y - 0.6 * ch.d.x);
      gust += 0.6 * waterNoise2(rb / ${f(FIELD.gust1)}, rd / ${f(FIELD.gust1)}, 24) * o1;
    }
  }
  // Internal-wave packets in a few places: narrow rough bands (where the wave's convergence crosses) 1.3 km apart,
  // bent by the currents, on calmer water between them.
  var iw = 0.0;
  let oi = waterOctave(fpM, ${f(0.5 * FIELD.internalWave)});
  if (oi > 0.0) {
    let packet = smoothstep(0.45, 0.6, waterChartNoise(ch, vec2f(${f(FIELD.internalPatch)}), vec2f(5.5, 2.5), 21));
    if (packet > 0.0) {
      let xw = ch.d.x + ${f(FIELD.internalBend)} * st.psi;
      let crest = pow(0.5 + 0.5 * sin(TWO_PI * (fract(ch.base.x / ${f(FIELD.internalWave)}) + xw / ${f(FIELD.internalWave)})), 6.0);
      // Trains of eight crests, the leading one strongest (a soliton packet), not an endless grating.
      let train = exp(-3.0 * fract(fract(ch.base.x / ${f(8 * FIELD.internalWave)}) + xw / ${f(8 * FIELD.internalWave)}));
      iw = (crest - 0.2256) * 1.5 * packet * oi * train;
    }
  }
  return wind * exp(1.5 * q.z * gust) * (1.0 + 0.18 * iw) * (1.0 - 0.9 * q.w * slick) * (1.0 - 0.55 * q.y * front);
}
/// The roughness field (mean 1) at the chart point of variant 0 'ch'; 'c', 'dlt', 'radius', 'wind' as it was made
/// from (the other cut of the chart is blended in near the +-180 deg meridian). invMean = 1 / fieldMean.
fn waterField(ch: WaterChart, c: vec3f, dlt: vec3f, radius: f32, wind: vec2f, q: vec4f, invMean: f32, fpS: vec2f, vh: vec2f) -> f32 {
  var m = waterFieldRaw(ch, q, fpS, vh);
  if (ch.seam > 0.0) { m = mix(m, waterFieldRaw(waterChartOf(c, dlt, radius, wind, 1.0), q, fpS, vh), ch.seam); }
  return m * invMean;
}
`;

// Deferred path: the field per shaded point (evaluated once per point by waterPoint).
const FIELD_PER_PIXEL = /* wgsl */ `
fn waterFieldOf(ch: WaterChart, c: vec3f, dlt: vec3f, radius: f32, wind: vec2f, q: vec4f, invMean: f32, fpS: vec2f, vh: vec2f) -> f32 {
  return waterField(ch, c, dlt, radius, wind, q, invMean, fpS, vh);
}`;

// Forward near field: the pass sets waterFieldValue from its baked field texture before lighting (the noise
// itself cost that pass 0.15 ms at 1440p), and waterFieldBaked to how far that value is used: towards fadeStart
// (and for the sheet's own pixels in the band) the pass asks for the field as the deferred pass evaluates it, so
// the two passes shade the same field where they meet.
const FIELD_FROM_PASS = /* wgsl */ `
var<private> waterFieldValue: f32 = 1.0;
var<private> waterFieldBaked: f32 = 1.0;
fn waterFieldOf(ch: WaterChart, c: vec3f, dlt: vec3f, radius: f32, wind: vec2f, q: vec4f, invMean: f32, fpS: vec2f, vh: vec2f) -> f32 {
  if (waterFieldBaked >= 1.0) { return waterFieldValue; }
  return mix(waterField(ch, c, dlt, radius, wind, q, invMean, fpS, vh), waterFieldValue, waterFieldBaked);
}`;

/** Rows of WATER_BODY per frame body. */
const BODY_ROWS = 4;

/**
 * WGSL of the chunk with the per-body constants of the frame body list `bodies` (index = frame body index;
 * null = no ocean). `fieldFromPass`: the variant of the forward near-field pass ("ocean_water_forward"), which
 * reads the roughness field from the private `waterFieldValue` its fragment shader sets.
 */
export function buildWaterBrdfWgsl(bodies: readonly (WaterBody | null)[], options: { directSpecular?: boolean; fieldFromPass?: boolean } = {}): string {
  const rows: string[] = [];
  const farA: string[] = [];
  const farB: string[] = [];
  for (let i = 0; i < MAX_BODIES; i++) {
    const b = bodies[i] ?? null;
    if (b) {
      const t = b.tunables;
      rows.push(
        `vec4f(${f(t.backscatter[0])}, ${f(t.backscatter[1])}, ${f(t.backscatter[2])}, ${f(t.imageryTint)})`,
        `vec4f(${f(t.foamAlbedo)}, ${f(Math.sin(t.windDir))}, ${f(Math.cos(t.windDir))}, ${f(1 / b.fieldMean)})`,
        `vec4f(${f(t.windVariability)}, ${f(t.slickStrength)}, ${f(t.gustVariability)}, ${f(t.filamentStrength)})`,
        `vec4f(${f(t.glintFacetSize * t.glintFacetSize)}, ${f(Math.max(t.unresolvedFloor, 1e-6))}, 0.0, 0.0)`,
      );
      if (b.farWaves.length !== FAR_WAVE_COUNT) throw new Error(`ocean: the far-wave bank of ${t.bodyId} has ${b.farWaves.length} components, expected ${FAR_WAVE_COUNT}`);
      for (const w of b.farWaves) {
        const k = Math.hypot(w.kAlong, w.kAcross);
        farA.push(`vec4f(${f(w.kAlong)}, ${f(w.kAcross)}, ${f(w.slope)}, ${f(w.omega)})`);
        farB.push(`vec4f(${f(w.kAlong / k)}, ${f(w.kAcross / k)}, ${f(k)}, ${f(w.phase)})`);
      }
    } else {
      rows.push('vec4f(0.002, 0.003, 0.0045, 0.0)', 'vec4f(0.7, 0.0, 1.0, 1.0)', 'vec4f(0.0)', 'vec4f(0.0025, 0.001, 0.0, 0.0)');
      for (let k = 0; k < FAR_WAVE_COUNT; k++) {
        farA.push('vec4f(0.0)');
        farB.push('vec4f(1.0, 0.0, 1.0, 0.0)');
      }
    }
  }
  return /* wgsl */ `
// OVERRIDABLE chunk "brdf_water", provided by the ocean package (src/render/ocean/shaders/waterBrdf.ts).
// Needs in scope: chunks frame, gbuffer, brdf; skyViewLut, skyIrradianceLut (set 'atmosphereLuts'),
// envProbeCube, envSh9 (set 'env'). See the module comment for the meaning of the Surface fields.
const WATER_IOR = 1.34;
const WATER_GGX_KAPPA = ${GGX_KAPPA};
// 1 = normal; 0 isolates the direct specular for tests (debug hook of the ocean feature).
const WATER_DIRECT_SPECULAR = ${options.directSpecular === false ? '0.0' : '1.0'};
// Per frame body: (backscatter rgb per m, imagery tint), (foam albedo, sin / cos of the compass direction the wind
// blows toward, 1 / mean of the raw roughness field), (wind variability, slick strength, gust variability,
// filament strength), (area of a glitter facet in m^2, slope variance left to the lobe below every wave layer, 0, 0).
const WATER_BODY = array<vec4f, ${MAX_BODIES * BODY_ROWS}>(${rows.join(', ')});
// The far-wave bank per frame body: (k along the wind, k across it (rad per chart m), slope amplitude, omega) and
// (unit direction along / across, |k|, phase at t = 0).
const WATER_FAR_N = ${FAR_WAVE_COUNT}u;
const WATER_FAR_A = array<vec4f, ${MAX_BODIES * FAR_WAVE_COUNT}>(${farA.join(', ')});
const WATER_FAR_B = array<vec4f, ${MAX_BODIES * FAR_WAVE_COUNT}>(${farB.join(', ')});
// Glitter cells of level k are 2^(k - 6) m wide (the finest about one facet: a facet seen closer than that is a
// round glint of the source's own radiance).
const WATER_GLINT_BASE = 0.015625;
// Re-draws of a glitter cell per second.
const WATER_GLINT_RATE = 14.0;

var<private> waterAnchor: vec4f = vec4f(0.0);
var<private> waterFarWeight: f32 = 1.0;

fn waterBodyParam(s: Surface, k: u32) -> vec4f { return WATER_BODY[u32(max(s.bodyIndex, 0)) * ${BODY_ROWS}u + k]; }
fn waterWind(s: Surface) -> f32 { return frame.bodies[max(s.bodyIndex, 0)].ocean.a; }
fn waterCoxMunk(s: Surface) -> f32 { return 0.003 + 0.00512 * waterWind(s); }

${WATER_FIELD_WGSL}
${options.fieldFromPass ? FIELD_FROM_PASS : FIELD_PER_PIXEL}

/// What is evaluated once per shaded point and shared by every light and the ambient term.
struct WaterPoint {
  key: vec4f,       // s.pos and s.bodyIndex + 1 of the point it was made for
  n: vec3f,         // shading normal: s.n tilted by the far waves, turned into the visible hemisphere
  resolved: f32,    // fraction of the Cox-Munk slope variance carried by n
  field: f32,       // roughness field (mean 1)
  glintU: vec2f,    // uniform random numbers of the pixel's glitter cells at the two levels
  glintN: vec2f,    // facets per cell at the two levels
  glintT: f32,      // blend from the finer level to the coarser
  glintW: f32,      // weight of the drawn factor (0 = the smooth lobe: the pixel resolves the facets)
}
var<private> waterPt: WaterPoint;

fn waterPoint(s: Surface) -> WaterPoint {
  let key = vec4f(s.pos, f32(s.bodyIndex) + 1.0);
  if (all(key == waterPt.key)) { return waterPt; }
  var pt: WaterPoint;
  pt.key = key;
  pt.n = s.n;
  pt.resolved = clamp(s.roughness, 0.0, 1.0);
  pt.field = 1.0;
  pt.glintU = vec2f(0.5);
  pt.glintN = vec2f(1.0);
  pt.glintT = 0.0;
  pt.glintW = 0.0;
  if (s.bodyIndex >= 0) {
    let bi = u32(s.bodyIndex);
    let b = frame.bodies[bi];
    let wb = waterBodyParam(s, 1u);
    let wind = wb.yz;
    let radius = select(b.center.w, b.fixedY.w, b.fixedY.w > 0.0);
    // The point whose planet-fixed position the field, the far waves and the glitter cells are looked up at. For
    // water at sea level it is where the pixel's eye ray meets the sea-level SPHERE, not the surface point itself:
    // the same point whichever pass shades the pixel and however its geometry sits on the sphere (the far sheet's
    // tessellation sags centimetres below it, the forward surface is lifted centimetres above; at a grazing angle
    // those are metres along the ray). Water away from sea level (a lake, a wave seen against the horizon) keeps
    // its own point, and so does the near field while it draws waves (waterAnchor: weight = wave detail).
    var cp = s.pos;
    let r0 = b.cameraUp.w;
    let hs = b.sunDir.w - (radius - b.center.w);
    let mu = -dot(b.cameraUp.xyz, s.v);
    let disc = sq(r0 * mu) - hs * (r0 + radius);
    if (mu < 0.0 && hs > 0.0 && disc > 0.0) {
      let t = hs * (r0 + radius) / (-r0 * mu + sqrt(disc));
      if (abs(t - s.viewDist) < 0.003 * s.viewDist + 3.0) { cp = -s.v * t; }
    }
    cp = mix(cp, waterAnchor.xyz, waterAnchor.w);
    // The chart point: camera position (coarse) + that point's offset from it (precise), body-fixed.
    let cF = rootToFixed(bi, -b.center.xyz);
    let dF = rootToFixed(bi, cp);
    let ch = waterChartOf(cF, dF, radius, wind, 0.0);
    // Footprint of the pixel on the sea: across the view, and along it (longer by 1 / sin of the grazing angle).
    let fpMinor = s.viewDist * 2.0 * frame.cameraUp.w * frame.renderSize.w;
    let sinG = max(dot(s.v, s.up), 0.02);
    let fpMajor = fpMinor / sinG;
    // The wind axes on the surface (the chart's axes), and the direction of the view in them.
    var east = cross(b.fixedZ.xyz, s.up);
    if (dot(east, east) < 1e-10) { east = b.fixedX.xyz; }
    east = normalize(east);
    let north = cross(s.up, east);
    let along = east * wind.x + north * wind.y;
    let across = east * wind.y - north * wind.x;
    var vh = vec2f(dot(s.v, along), dot(s.v, across));
    vh = vh / max(length(vh), 1e-4);
    pt.field = waterFieldOf(ch, cF, dF, radius, wind, waterBodyParam(s, 2u), wb.w, vec2f(fpMinor, fpMajor), vh);

    // Far waves: the bank's slopes in the wind axes. A component is drawn where the pixel resolves it in EVERY
    // direction: the footprint's long axis counts whatever the wave's heading. (Band-limited along its own heading
    // only, a wave that crosses the view survives to the horizon while its neighbours along the view are gone, and
    // the sea is combed into lines that fan out from the camera; a sea of real heights shows the opposite.)
    let fpe = sqrt(0.5 * (fpMinor * fpMinor + fpMajor * fpMajor));
    if (waterFarWeight > 0.0 && fpe < 110.0) {
      var g = vec2f(0.0);
      var variance = 0.0;
      let time = frame.time.x;
      for (var k = 0u; k < 2u; k++) {
        var c2 = ch;
        var wgt = 1.0 - ch.seam;
        if (k == 1u) {
          if (ch.seam <= 0.0) { break; }
          c2 = waterChartOf(cF, dF, radius, wind, 1.0);
          wgt = ch.seam;
        }
        if (wgt <= 0.0) { continue; }
        for (var i = 0u; i < WATER_FAR_N; i++) {
          let wa = WATER_FAR_A[bi * WATER_FAR_N + i];
          let wd = WATER_FAR_B[bi * WATER_FAR_N + i];
          let band = exp(-0.5 * sq(1.3 * wd.z / c2.cosLat * fpe));
          if (band < 0.01) { continue; }
          let ph = TWO_PI * fract(dot(wa.xy, c2.base) / TWO_PI) + dot(wa.xy, c2.d) + wd.w - wa.w * time;
          let a = wa.z * band * wgt;
          g -= a * sin(ph) * wd.xy;
          variance += 0.5 * a * a;
        }
      }
      let fw = waterFarWeight;
      pt.n = normalize(pt.n - (along * g.x + across * g.y) * fw);
      pt.resolved = clamp(pt.resolved + variance * fw * fw / waterCoxMunk(s), 0.0, 1.0);
    }

    // Glitter cells: two levels of sea-anchored cells about as wide as the pixel is on the sea (half of it to all
    // of it for the finer level). At grazing angles a cell is up to three times wider than the pixel and many times
    // shorter than the pixel's footprint is long, so a sparkle of a distant sun path is a short dash across the view.
    let fpGeo = fpMinor * sqrt(min(fpMajor / fpMinor, 9.0));
    let lv = max(log2(fpGeo / WATER_GLINT_BASE) - 1.0, 0.0);
    let l0 = floor(lv);
    pt.glintT = lv - l0;
    let gp = waterBodyParam(s, 3u);
    let facet = max(gp.x, 1e-6);
    // Glitter is drawn where the pixel does NOT resolve the slopes that mirror the light: where the shading normal
    // carries all but the capillary remainder of them (close to the eye) the lobe on that normal is the glint
    // itself, a filled highlight on each ripple; from where the unresolved slopes are a few times that remainder,
    // they are facets inside the pixel, and the lobe is their expectation.
    pt.glintW = smoothstep(1.6, 4.0, waterCoxMunk(s) * pt.field * (1.0 - pt.resolved) / gp.y);
    if (pt.glintW > 0.0) {
      let tk = frame.time.x * WATER_GLINT_RATE;
      for (var k = 0u; k < 2u; k++) {
        let level = l0 + f32(k);
        let cs = WATER_GLINT_BASE * exp2(level);
        // Powers of two: the division of the coarse coordinate is exact, so the lattice is fixed to the planet.
        let cb = ch.base / cs;
        let x = (cb - floor(cb)) + ch.d / cs;
        let xf = floor(x);
        let idx = vec2i(floor(cb)) + vec2i(xf);
        let h = waterHash(idx, i32(level) + 301);
        // Each cell is re-drawn at its own instants.
        let ti = i32(floor(tk + f32(h & 1023u) / 1024.0));
        let h2 = waterHash(vec2i(i32(h >> 10u), ti), 977);
        pt.glintU[k] = (f32(h2 >> 8u) + 0.5) / 16777216.0;
        // The facets the pixel integrates: those of its whole footprint on the sea (at a grazing angle many cells
        // long), or of the cell where the pixel is smaller than one. The cell's draw stands for the pixel.
        // (At least four: slopes a pixel does not resolve vary within it.)
        pt.glintN[k] = max(max(cs * cs, fpMinor * fpMajor) / facet, 4.0);
      }
    }
  }
  // A shading normal facing away from the eye (a wave face seen from behind at a grazing angle) is turned to the
  // silhouette: nothing behind it is visible.
  let nv = dot(pt.n, s.v);
  if (nv < 0.02) { pt.n = normalize(pt.n + s.v * (0.02 - nv)); }
  waterPt = pt;
  return pt;
}

/// GGX alpha of the slopes the shading normal does not carry (without the light's own angular size).
fn waterAlphaOf(s: Surface, pt: WaterPoint) -> f32 {
  let unresolved = waterCoxMunk(s) * pt.field * (1.0 - pt.resolved);
  return sqrt(WATER_GGX_KAPPA * WATER_GGX_KAPPA * unresolved + 1e-6);
}
fn waterAlpha(s: Surface) -> f32 { return waterAlphaOf(s, waterPoint(s)); }

/// Standard normal deviate for a uniform random number (Tukey's lambda distribution: within 1 % out to 3 sigma).
fn waterNormalOf(u: f32) -> f32 { return 5.0633 * (pow(u, 0.135) - pow(1.0 - u, 0.135)); }

/// The glitter factor of one cell that holds on average 'mean' facets mirroring the source, for the cell's uniform
/// random number u: a Poisson number of lit facets over its mean (expectation 1). Few facets: most cells show the
/// dark water and a few a sparkle of one facet's radiance; many: a grain, then a sheen. A single facet counts for at
/// most 32 times the lobe (five stops over it): rarer, brighter ones are drawn as more, fainter ones, so far out on
/// the flanks of the path the sparkles fade with the lobe instead of standing alone as stray stars.
fn waterGlintCell(u: f32, mean: f32) -> f32 {
  let k = max(mean, 0.03125);
  var draw = 1.0;
  // From three facets on a normal deviate about the mean does; between two and three the two are blended.
  let wide = smoothstep(2.0, 3.0, k);
  if (wide < 1.0) {
    // The inverse of the Poisson distribution's cumulative sum, each of its steps a short ramp (three tenths of
    // the smaller of the two probabilities it separates, to each side) instead of a jump: the count stays k on
    // average and is CONTINUOUS in k, so two shadings of one point whose inputs differ in the fourth digit (the
    // forward and the deferred pass at the hand-over) do not differ by a whole facet in a pixel that sits on a step.
    var p = exp(-k);
    var c = p;
    var n = 0.0;
    for (var i = 0; i < 12; i++) {
      let pn = p * k / f32(i + 1);
      let h = 0.3 * min(p, pn);
      if (u <= c - h) { break; }
      n += saturate((u - (c - h)) / max(2.0 * h, 1e-12));
      p = pn;
      c += p;
    }
    draw = n / k;
  }
  if (wide > 0.0) { draw = mix(draw, max(1.0 + waterNormalOf(u) * inverseSqrt(k), 0.0), wide); }
  // The glints of a real sea are not equal: beside the few bright ones a footprint holds many faint ones, a sheen
  // whose share grows with their number (a dense path is bright between its sparkles, not holed).
  return mix(draw, 1.0, k / (k + 6.0));
}
/// The glitter factor of the lobe for a source that one facet mirrors with probability 'pFacet'.
fn waterGlint(pt: WaterPoint, pFacet: f32) -> f32 {
  if (pt.glintW <= 0.0) { return 1.0; }
  let f0 = waterGlintCell(pt.glintU.x, pFacet * pt.glintN.x);
  let f1 = waterGlintCell(pt.glintU.y, pFacet * pt.glintN.y);
  return mix(1.0, mix(f0, f1, pt.glintT), pt.glintW);
}

fn waterFoamCoverage(s: Surface) -> f32 {
  let stat = min(0.2, 3.84e-6 * pow(waterWind(s), 3.41)) * 0.4;
  return clamp(mix(stat, s.metallic, s.clearcoatRoughness), 0.0, 1.0);
}
/// Albedo of the foam on this surface (the forward pass hands thin lace in greyer than fresh foam).
fn waterFoamAlbedo(s: Surface) -> f32 { return waterBodyParam(s, 1u).x * mix(1.0, s.clearcoat, s.clearcoatRoughness); }

struct WaterOptics {
  kappa: vec3f,     // attenuation a + bb, 1/m
  u: vec3f,         // bb / (a + bb)
  rrsDeep: vec3f,   // subsurface remote-sensing reflectance of optically deep water, 1/sr (tinted)
  depth: f32,       // m
}
fn waterOptics(s: Surface) -> WaterOptics {
  var o: WaterOptics;
  let a = max(frame.bodies[max(s.bodyIndex, 0)].ocean.rgb, vec3f(1e-4));
  let p = waterBodyParam(s, 0u);
  let bb = p.xyz;
  o.kappa = a + bb;
  o.u = bb / o.kappa;
  var deep = (0.084 + 0.17 * o.u) * o.u;
  let li = luminance(s.albedo);
  if (li > 1e-4) {
    let tint = clamp((s.albedo / li) / (deep / max(luminance(deep), 1e-7)), vec3f(0.25), vec3f(4.0));
    deep *= mix(vec3f(1.0), tint, p.w);
  }
  o.rrsDeep = deep;
  o.depth = decodeWaterDepth(s.param);
  return o;
}
/// Cosine of the refracted (in-water) zenith angle for an above-water cosine mu.
fn waterRefractedCos(mu: f32) -> f32 { return sqrt(max(1.0 - (1.0 - mu * mu) / (WATER_IOR * WATER_IOR), 0.0)); }
fn waterFresnel(mu: f32) -> f32 { return 0.02 + 0.98 * pow5(1.0 - saturate(mu)); }

struct WaterRrs { total: vec3f, bottom: vec3f, bottomAttenuation: vec3f }
/// Above-surface remote-sensing reflectance (1/sr) for in-water sun / view cosines, split into the total and the
/// part due to the bottom; bottomAttenuation = the factor the column applies to light reflected by the bottom.
fn waterRrsOf(o: WaterOptics, bottomAlbedo: vec3f, muW: f32, muV: f32) -> WaterRrs {
  let du = 1.03 * sqrt(1.0 + 2.4 * o.u);
  let db = 1.04 * sqrt(1.0 + 5.4 * o.u);
  let mw = max(muW, 0.05);
  let mv = max(muV, 0.05);
  let tc = exp(-(1.0 / mw + du / mv) * o.kappa * o.depth);
  let tb = exp(-(1.0 / mw + db / mv) * o.kappa * o.depth);
  let column = o.rrsDeep * (1.0 - tc);
  let rrs = column + bottomAlbedo * (tb / PI);
  var r: WaterRrs;
  r.total = 0.5 * rrs / (1.0 - 1.5 * rrs);
  r.bottom = r.total - 0.5 * column / (1.0 - 1.5 * column);
  r.bottomAttenuation = tb * 0.5 / (1.0 - 1.5 * rrs);
  return r;
}

/// Diffuse-equivalent reflectance of the water body (pi Rrs) for overhead sun and view.
fn waterBodyColor(s: Surface) -> vec3f { return PI * waterRrsOf(waterOptics(s), s.albedo, 1.0, 1.0).total; }

/// Water-leaving body term per unit illuminance of a light along l (the bottom part separately): BRDF x NoL.
struct WaterBody { total: vec3f, bottom: vec3f, bottomAttenuation: vec3f }
fn waterBodyDirect(s: Surface, l: vec3f) -> WaterBody {
  var w: WaterBody;
  w.total = vec3f(0.0);
  w.bottom = vec3f(0.0);
  w.bottomAttenuation = vec3f(0.0);
  let NoL = dot(s.n, l);
  if (NoL <= 0.0) { return w; }
  let NoV = max(dot(s.n, s.v), 1e-4);
  let t = (1.0 - waterFresnel(NoL)) * (1.0 - waterFresnel(NoV)) / 0.9604;
  let r = waterRrsOf(waterOptics(s), s.albedo, waterRefractedCos(NoL), waterRefractedCos(NoV));
  w.total = r.total * (NoL * t);
  w.bottom = r.bottom * (NoL * t);
  w.bottomAttenuation = r.bottomAttenuation * t;
  return w;
}
fn waterBodyAmbient(s: Surface, a: AmbientInput) -> WaterBody {
  var w: WaterBody;
  let NoV = max(dot(s.n, s.v), 1e-4);
  // Diffuse sky light enters at a mean in-water cosine of about 0.86 (refraction squeezes it into the Snell cone).
  let t = (1.0 - 0.066) * (1.0 - waterFresnel(NoV)) / 0.9604;
  let r = waterRrsOf(waterOptics(s), s.albedo, 0.86, waterRefractedCos(NoV));
  w.total = r.total * a.skyIrradiance * t;
  w.bottom = r.bottom * a.skyIrradiance * t;
  w.bottomAttenuation = r.bottomAttenuation * t;
  return w;
}

/// Sky radiance (cd/m^2) along 'dir' seen by a water surface, blurred over a GGX lobe of alpha 'alpha'.
fn waterSkyRadiance(s: Surface, dir: vec3f, alpha: f32) -> vec3f {
  if (s.bodyIndex < 0) { return vec3f(0.0); }
  let b = frame.bodies[s.bodyIndex];
  let sunDir = b.sunDir.xyz;
  var d = dir;
  var fold = 1.0;
  let du = dot(d, s.up);
  if (du < 0.0) {
    // Reflected below the horizon: the ray meets the sea again and, mostly by reflection, sees the sky near the horizon.
    d = normalize(d - 2.0 * du * s.up);
    fold = 0.85;
  }
  var far = vec3f(0.0);
  let layer = i32(b.fixedX.w);
  let rb = b.center.w;
  let r = rb + s.altitude;
  if (layer >= 0 && r < b.prevCenter.w) {
    let uv = skyIrradianceUvFromRMuS(max(r, rb), dot(s.up, sunDir), rb, b.prevCenter.w);
    far = textureSampleLevel(skyIrradianceLut, linearClamp, uv, layer, 0.0).rgb / PI;
  }
  let near = saturate(1.0 - s.viewDist / 50000.0);
  var nearL = vec3f(0.0);
  if (near > 0.0) {
    let c0 = envSh9.c[0].rgb;
    if (c0.r + c0.g + c0.b > 0.0) {
      let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
      let mip = sqrt(clamp(alpha, 0.0, 1.0)) * mips;
      // The filter of that level reaches about a texel to each side. The lower half of the probe is the ground or
      // the sea itself, which a wave facet near the horizon does not mirror: the lookup stays that far above it.
      let reach = min(1.5708 * exp2(mip) / f32(textureDimensions(envProbeCube).x), 1.2);
      let dd = normalize(d + s.up * max(sin(reach) - dot(d, s.up), 0.0));
      nearL = textureSampleLevel(envProbeCube, linearClamp, dd, mip).rgb;
    } else {
      let camUp = b.cameraUp.xyz;
      let spread = min(alpha * 0.75, 0.6);
      let centre = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(d, camUp, sunDir), 0.0).rgb;
      // A lobe narrower than the table's own smoothness needs no blur (where the near field resolves the waves only
      // a few hundredths of a radian are left): one tap there, the four-tap ring fading in over the next few.
      let blur = smoothstep(0.03, 0.08, spread);
      nearL = centre;
      if (blur > 0.0) {
        let tf = tangentFrame(d);
        var ring = vec3f(0.0);
        for (var k = 0u; k < 4u; k++) {
          let ang = f32(k) * 1.5707963 + 0.785398;
          var dk = normalize(d + (tf[0] * cos(ang) + tf[1] * sin(ang)) * spread);
          let dku = dot(dk, s.up);
          if (dku < 0.0) { dk = normalize(dk - 2.0 * dku * s.up); }
          ring += textureSampleLevel(skyViewLut, linearClamp, skyViewUv(dk, camUp, sunDir), 0.0).rgb * 0.25;
        }
        nearL = mix(centre, centre * 0.4 + ring * 0.6, blur);
      }
    }
  }
  return mix(far, nearL, near) * fold;
}

/// What the water mirrors of its surroundings: xyz = the direction the mean visible facet reflects the eye into,
/// w = the mean Fresnel reflectance of the visible facets. At grazing angles the facets a viewer sees are the
/// ones tilted towards him: their mean incidence cosine does not fall below about 1.1 sigma of the unresolved
/// slopes (a rough sea mirrors a third of the horizon sky, a flat one nearly all of it), and they look higher into
/// the sky than a flat sea would.
fn waterMirror(s: Surface, pt: WaterPoint, alpha: f32) -> vec4f {
  let sigma = alpha / WATER_GGX_KAPPA;
  let NoV = max(dot(pt.n, s.v), 1e-4);
  let mu = sqrt(sqrt(sq(sq(NoV)) + sq(sq(1.12 * sigma))));
  var refl = reflect(-s.v, pt.n);
  refl = normalize(refl + s.up * (0.9 * sigma * (1.0 - saturate(dot(refl, s.up)))));
  return vec4f(refl, 0.02 + 0.98 * pow5(1.0 - saturate(mu)));
}

/// Smith Lambda of a Gaussian (Beckmann) slope distribution of mean square slope sig2 for a direction at cosine c
/// to the mean normal (Walter et al. 2007, rational fit).
fn waterLambda(c: f32, sig2: f32) -> f32 {
  let cc = clamp(c, 1e-4, 1.0);
  let a = cc / sqrt(max(sig2 * (1.0 - cc * cc), 1e-12));
  if (a >= 1.6) { return 0.0; }
  return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
}

fn brdfWaterDirect(s: Surface, l: vec3f) -> vec3f {
  let pt = waterPoint(s);
  let NoL = dot(pt.n, l);
  var spec = 0.0;
  if (NoL > 0.0) {
    let h = normalize(s.v + l);
    let NoV = max(dot(pt.n, s.v), 1e-4);
    let NoH = saturate(dot(pt.n, h));
    let LoH = saturate(dot(l, h));
    let a = sqrt(sq(waterAlphaOf(s, pt)) + sq(s.lightAlpha));
    let fr = 0.02 + 0.98 * pow5(1.0 - LoH);
    // The sun and the other lights are mirrored by the facets themselves, whose slopes are Gaussian (Cox and
    // Munk): the lobe is the Gaussian slope distribution of the same variance as the GGX alpha above (same
    // half-maximum width), with its Smith shadowing. GGX's long tail would be a sheen of the sun far outside the
    // path (a sun 60 deg behind the camera on steep faces, a grey halo around a moon path), which a real sea
    // never shows: the sun's radiance makes even a tail of 1e-4 of the peak visible.
    let sig2 = max(a * a / (WATER_GGX_KAPPA * WATER_GGX_KAPPA), 1e-7);
    let nh2 = max(NoH * NoH, 1e-6);
    let dFacet = exp(-(1.0 - nh2) / (nh2 * sig2)) / (PI * sig2 * nh2 * nh2);
    let G = 1.0 / (1.0 + waterLambda(NoV, sig2) + waterLambda(NoL, sig2));
    spec = dFacet * G / (4.0 * NoV) * fr * WATER_DIRECT_SPECULAR;
    if (spec > 0.0) {
      // Probability that one facet mirrors the source into the eye: the facet normals that do fill the solid angle
      // of the source / (4 l.h) around h. Sources without a stated size (planetshine, lamps) count as a lunar disc.
      let rl = max(s.lightAlpha / 0.6, 0.0046);
      spec *= waterGlint(pt, dFacet * NoH * PI * rl * rl / (4.0 * max(LoH, 0.05)));
    }
  }
  let body = waterBodyDirect(s, l).total;
  let c = waterFoamCoverage(s);
  // Foam: a diffuse layer of bubbles, lit on the slope of the wave it rides or, where the pass hands it in, on its
  // own relief; light spreads inside it, so its terminator is soft.
  var nFoam = normalize(pt.n + s.up);
  if (s.clearcoatRoughness > 0.5) { nFoam = s.t; }
  let foam = waterFoamAlbedo(s) / PI * saturate((dot(nFoam, l) + 0.25) / 1.25);
  return (vec3f(spec) + body) * (1.0 - c) + vec3f(foam * c);
}

fn brdfWaterAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let pt = waterPoint(s);
  let alpha = waterAlphaOf(s, pt);
  let m = waterMirror(s, pt, alpha);
  let spec = waterSkyRadiance(s, m.xyz, alpha) * m.w;
  let body = waterBodyAmbient(s, a).total;
  let c = waterFoamCoverage(s);
  let foam = a.skyIrradiance * (waterFoamAlbedo(s) / PI);
  return (spec + body) * (1.0 - c) + foam * c;
}
`;
}
