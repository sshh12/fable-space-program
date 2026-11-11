/**
 * WGSL of the volumetric clouds: the density model (chunk "atmosphere_cloud_density"), the quarter-area
 * ray march, the temporal checkerboard resolve, the near-field shadow map, and the one-off noise
 * generation.
 *
 * Density model. The baked global map gives, per column, a coverage c and a cloud-top altitude. From them:
 *   low layer   cumulus / stratocumulus between the shell bottom and a low top: where the (histogram-
 *               equalised) Perlin-Worley shape noise times a height gradient exceeds 1 - c_low, so the
 *               covered area fraction equals c_low at the base and domes close towards the top;
 *   high layer  a stratiform sheet (altostratus, cirrus shield, anvil) under the map's cloud top, smooth
 *               and thin, its opacity growing with c;
 *   deep column the space between the two fills in where c approaches 1 (fronts, deep convection).
 * Shape noise is sampled at the mip level of the pixel footprint. What the mip chain has averaged away is
 * accounted for analytically as a cloud FRACTION (the share of the footprint above the threshold), so the
 * same function gives resolved cumulus near the camera and the right partial cover from orbit and beyond.
 *
 * Fractions along a ray are combined with maximum overlap (clouds are columns): the march tracks the
 * largest fraction met so far and the mean transmittance / radiance of that cloudy part of the footprint.
 */
import { ATMO_UNIFORM_WGSL } from '../uniforms';

/** Half-resolution pixel marched in each of the four frames of the checkerboard cycle. */
export const CLOUD_PHASE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

/**
 * Needs from the includer: `atmo` (AtmoU), `atmoCoverageTex: texture_2d<f32>` (r = coverage, g = cloud
 * top / 12750 m), `cloudBaseNoise`, `cloudDetailNoise: texture_3d<f32>`, and chunk "atmosphere_model".
 */
export const CLOUD_DENSITY_WGSL = /* wgsl */ `
struct CloudColumn {
  cLow: f32,       // coverage of the low layer, 0..1
  lowTop: f32,     // top altitude of the low layer (m)
  cHigh: f32,      // amount of the high layer, 0..1
  highBase: f32,   // its bottom and top altitude (m)
  highTop: f32,
  deep: f32,       // fill of the column between the layers, 0..1
}

struct CloudDensity {
  sigma: f32,      // extinction of the cloudy part of the footprint, 1 / m
  frac: f32,       // share of the footprint that is cloudy, 0..1
  above: f32,      // optical depth scale of the cloud above the point (vertical), for the ambient terms
  below: f32,      // the same below the point
  relief: f32,     // depth (m) of the billows carved into the top of the sheet here (0 = a smooth sheet)
}

/// A camera-relative vector (ROOT axes) in the cloud noise frame: body-fixed axes turned about the spin
/// axis by the wind drift. For positions: relative to the camera.
fn cloudNoiseVec(bi: u32, v: vec3f) -> vec3f {
  let f = rootToFixed(bi, v);
  return vec3f(atmo.noiseRot.x * f.x + atmo.noiseRot.y * f.y, atmo.noiseRot.x * f.y - atmo.noiseRot.y * f.x, f.z);
}

/// Camera-relative ray through the centre of the pixel at 'uv' WITHOUT the sub-pixel TAA jitter (unit
/// component along the view axis). The cloud buffers are rendered and reprojected on this fixed lattice.
fn cloudViewRay(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return frame.cameraForward.xyz + frame.cameraRight.xyz * (ndc.x * frame.cameraRight.w) + frame.cameraUp.xyz * (ndc.y * frame.cameraUp.w);
}

/// Share of the shape-noise amplitude that the mip level 'lod' has averaged away (0 = none, 1 = all).
fn cloudNoiseFade(lod: f32) -> f32 {
  let table = array<f32, 8>(atmo.noiseFadeA.x, atmo.noiseFadeA.y, atmo.noiseFadeA.z, atmo.noiseFadeA.w, atmo.noiseFadeB.x, atmo.noiseFadeB.y, atmo.noiseFadeB.z, atmo.noiseFadeB.w);
  let l = clamp(lod, 0.0, 7.0);
  let i = u32(floor(l));
  return mix(table[i], table[min(i + 1u, 7u)], l - f32(i));
}

/// What the coverage map and the large noise scales say about the column through a point. 'q' = the point
/// in the noise frame relative to the camera, 'footprint' = size of the pixel there (m).
fn cloudColumnAt(bi: u32, pos: vec3f, q: vec3f, footprint: f32) -> CloudColumn {
  let dfix = normalize(rootToFixed(bi, pos - frame.bodies[bi].center.xyz));
  let lon = atan2(dfix.y, dfix.x) + atmo.noiseRot.z;
  let uv = vec2f(lon / TWO_PI + 0.5, clamp(acos(clamp(dfix.z, -1.0, 1.0)) / PI, 0.0005, 0.9995));
  let texel = TWO_PI * frame.bodies[bi].center.w / atmo.noiseRot.w;
  let m = textureSampleLevel(atmoCoverageTex, linearRepeat, uv, log2(max(footprint / texel, 1.0)));
  let c = m.r;
  let ct = m.g * 12750.0;
  let nLarge = textureSampleLevel(cloudBaseNoise, linearRepeat, (atmo.noiseLarge.xyz + q) * atmo.noiseLarge.w, log2(max(footprint * atmo.noiseLarge.w * 128.0, 1.0))).b;
  let mesoLod = log2(max(footprint * atmo.noiseMeso.w * 128.0, 1.0));
  let nMeso = textureSampleLevel(cloudBaseNoise, linearRepeat, (atmo.noiseMeso.xyz + q) * atmo.noiseMeso.w, mesoLod).g;
  // Both modulations average out to nothing once the pixel is as large as their features: they are faded
  // to their means there instead of being sampled from the last few texels of a mip chain.
  let mesoKeep = 1.0 - smoothstep(0.03, 0.12, footprint * atmo.noiseMeso.w);
  let largeKeep = 1.0 - smoothstep(0.03, 0.15, footprint * atmo.noiseLarge.w);

  var col: CloudColumn;
  // Fair-weather fields where the infrared map is clear, placed by the weather-scale noise.
  let fair = atmo.cloudLow2.x * mix(0.375, smoothstep(0.45, 0.8, nLarge), largeKeep) * (1.0 - smoothstep(0.0, 0.3, c));
  let c0 = saturate(c * atmo.cloudLow.w + fair);
  // The mesoscale cells break the map's texels up without changing the mean.
  col.cLow = saturate(c0 + (nMeso - 0.5) * mesoKeep * atmo.cloudLow2.y * 4.0 * c0 * (1.0 - c0));
  let zb = atmo.cloudShell.z;
  let zt = atmo.cloudShell.w;
  col.lowTop = min(zb + atmo.cloudLow.x * mix(0.5, 1.0, col.cLow) * (0.8 + 0.4 * mix(0.5, nMeso, mesoKeep)), zt);
  col.cHigh = smoothstep(atmo.cloudHigh2.x, atmo.cloudHigh2.y, c);
  col.deep = smoothstep(atmo.cloudHigh2.z, atmo.cloudHigh2.w, c);
  col.highTop = clamp(ct, zb + 600.0, zt);
  col.highBase = max(col.highTop - mix(atmo.cloudHigh.x, atmo.cloudHigh.y, col.cHigh), min(col.lowTop, col.highTop - 200.0));
  return col;
}

/// Integral of the high layer's bell profile 4 x (1 - x) from 0 to x (x clamped to the layer).
fn cloudBellIntegral(x: f32) -> f32 {
  let c = saturate(x);
  return c * c * (2.0 - (4.0 / 3.0) * c);
}

/// Density at altitude h in a column, for a march step that covers the altitudes h - span .. h + span.
/// 'footprint' = size of what the sample stands for (m); 'footprintTop' = the same measured along a level
/// surface (the footprint divided by the sine of the angle at which the ray meets the layer: a cloud top
/// seen at a shallow angle is stretched out along the line of sight, and its billows are filtered to that).
/// 'detail' adds the small-scale erosion (skipped for light samples and beyond the detail fade footprint).
fn cloudDensityAt(col: CloudColumn, h: f32, span: f32, q: vec3f, footprint: f32, footprintTop: f32, detail: bool) -> CloudDensity {
  var out: CloudDensity;
  out.sigma = 0.0;
  out.frac = 1.0;
  out.above = 0.0;
  out.below = 0.0;
  out.relief = 0.0;
  let zb = atmo.cloudShell.z;
  if (h <= zb || h >= atmo.cloudShell.w) { return out; }
  let inLow = h < col.lowTop && col.cLow > 0.004;
  let inHigh = h + span > col.highBase && h - span < col.highTop && col.cHigh > 0.0;
  let inDeep = col.deep > 0.0 && h >= col.lowTop && h <= col.highBase;
  if (!(inLow || inHigh || inDeep)) { return out; }

  let pb = (atmo.noiseBase.xyz + q + atmo.cloudWind.xyz * (h - zb)) * atmo.noiseBase.w;
  // (One level above the footprint's own: the smallest features kept are two pixels across, not one. A
  // field of shapes smaller than that is a smooth cloud fraction, not a lattice of dots.)
  let lodB = log2(max(footprint * atmo.noiseBase.w * 256.0, 1.0));
  let nb = textureSampleLevel(cloudBaseNoise, linearRepeat, pb, lodB);
  let fade = cloudNoiseFade(lodB);

  var sigmaLow = 0.0;
  var fracLow = 1.0;
  if (inLow) {
    let hl = (h - zb) / (col.lowTop - zb);
    // Flat bases, domed tops: the gradient is 1 just above the base and falls towards the top.
    let g = saturate(hl * 14.0) * (1.0 - smoothstep(0.18, 1.0, hl));
    // Where the shapes are not resolved the covered share is that of the whole column, whatever the height
    // of the sample (maximum overlap), and the cloudy part has the mean density of a cloud.
    let gf = mix(g, 0.95, fade);
    let thr = 1.0 - col.cLow;
    let x = nb.r * gf - thr;
    // What the mip has averaged away varies inside the footprint with the spread sqrt(1 - kept^2) of the
    // whole (variances add): the share of the footprint above the threshold follows from it.
    let spread = sqrt(max(1.0 - (1.0 - fade) * (1.0 - fade), 0.0));
    fracLow = saturate(x / (spread * gf + 1e-3) + 0.5);
    if (fracLow > 0.0) {
      let soft = atmo.cloudLow.z;
      // (0.52 = mean of the height gradient: unresolved, the cloudy part is uniform over the layer's depth.)
      var dl = mix(saturate((nb.r * g - thr) / soft), saturate(0.5 * (gf - thr) / soft) * 0.52, fade);
      if (detail && dl > 0.0 && dl < 1.0) {
        let k = atmo.cloudLow2.z * (1.0 - smoothstep(0.4 * atmo.cloudLow2.w, atmo.cloudLow2.w, footprint));
        if (k > 0.0) {
          let pd = (atmo.noiseDetail.xyz + q + vec3f(0.0, 0.0, atmo.cloudWind.w)) * atmo.noiseDetail.w;
          let nd = textureSampleLevel(cloudDetailNoise, linearRepeat, pd, log2(max(footprint * atmo.noiseDetail.w * 32.0, 1.0)));
          let fbm = nd.r * 0.625 + nd.g * 0.25 + nd.b * 0.125;
          // Wispy at the base, billowing towards the top.
          let e = k * mix(fbm, 1.0 - fbm, saturate(hl * 4.0));
          dl = saturate((dl - e) / (1.0 - e));
        }
      }
      // A little of the high-frequency cells in the cores keeps large clouds from being featureless.
      sigmaLow = atmo.cloudLow.y * dl * mix(1.0, 0.75 + 0.5 * nb.a, 1.0 - fade);
      out.above = sigmaLow * (col.lowTop - h) * 0.5;
      out.below = sigmaLow * (h - zb) * 0.5;
    }
  }
  var sigmaOther = 0.0;
  if (inHigh) {
    // The thin sheet is integrated over the altitudes of the step, not sampled at a point: a step longer
    // than the sheet is thick can neither miss it nor count it twice.
    let thickness = col.highTop - col.highBase;
    let hh = (h - col.highBase) / thickness;
    let hs = max(span / thickness, 1e-3);
    let bell = (cloudBellIntegral(hh + hs) - cloudBellIntegral(hh - hs)) / (2.0 * hs);
    // Streaks: the smooth channel sampled at a third of the base frequency.
    // They fade to their mean once the pixel is as large as they are.
    let streakKeep = 1.0 - smoothstep(0.03, 0.12, footprint * atmo.noiseBase.w * 0.31);
    let w = mix(0.5, textureSampleLevel(cloudBaseNoise, linearRepeat, pb * 0.31 + vec3f(0.37, 0.11, 0.73), max(lodB - 1.7, 0.0)).b, streakKeep);
    var amount = col.cHigh * bell * saturate(mix(0.3, 1.0, col.cHigh) + (w - 0.5) * mix(1.4, 0.5, col.cHigh) + (nb.r - 0.5) * 0.35 * (1.0 - fade));
    // The top of a thick sheet is not flat: the shape noise carves billows into it (a cloud sea from above).
    // (Only where the billows are resolved: a point test against a surface has no place in a step that
    // integrates the whole sheet.)
    let lodTop = log2(max(footprintTop * atmo.noiseBase.w * 128.0, 1.0));
    let relief = atmo.cloudLight.z * smoothstep(0.4, 0.9, col.cHigh) * (1.0 - cloudNoiseFade(lodTop));
    if (relief > 1.0) {
      out.relief = relief;
      let nTop = textureSampleLevel(cloudBaseNoise, linearRepeat, pb, lodTop).r;
      let topLocal = col.highTop - relief * (1.0 - nTop) * (0.6 + 0.8 * w);
      amount *= saturate((topLocal - h) / max(0.15 * relief, 20.0));
    }
    // Extinction grows geometrically with the amount: a veil at the edge of a system, an opaque shield inside.
    let ext = mix(atmo.cloudHigh.z * pow(atmo.cloudHigh.w / atmo.cloudHigh.z, col.cHigh), atmo.cloudDeep.x, col.deep);
    let s = ext * amount;
    sigmaOther += s;
    out.above += s * max(col.highTop - h, 0.0) * 0.5;
    out.below += s * max(h - col.highBase, 0.0) * 0.5 + atmo.cloudDeep.x * col.deep * (col.highBase - col.lowTop);
  }
  if (inDeep) {
    let s = atmo.cloudDeep.x * col.deep * saturate(0.6 + (nb.r - 0.5) * (1.0 - fade));
    sigmaOther += s;
    out.above += s * (col.highTop - h);
    out.below += s * (h - col.lowTop);
  }
  out.sigma = sigmaLow * step(1e-6, fracLow) + sigmaOther;
  if (out.sigma > 0.0) { out.frac = (sigmaLow * fracLow + sigmaOther) / out.sigma; }
  return out;
}

/// The parts of a camera ray inside the cloud shell, in order of distance, each as (start, end) in metres
/// from the start of the ray's path in the atmosphere, with its kind: 1 = the low shell (from the bottom of the layer to the highest top a low
/// cloud can have: where cumulus live, marched finely), 2 = the shell above it (thin sheets and the filled
/// columns of deep systems: smooth, marched coarsely), 0 = none.
struct CloudSpans {
  span: array<vec2f, 4>,
  kind: array<i32, 4>,
}

fn cloudSpans(ray: AtmoRay) -> CloudSpans {
  var s: CloudSpans;
  for (var i = 0; i < 4; i++) {
    s.span[i] = vec2f(0.0, -1.0);
    s.kind[i] = 0;
  }
  // Distances are measured from the start of the ray's path in the atmosphere (see AtmoRay).
  let r0 = ray.r;
  let h0 = ray.h;
  let mu = ray.mu;
  let zb = atmo.cloudShell.z;
  let zt = atmo.cloudShell.w;
  // No low cloud is higher than this (see cloudColumnAt).
  let zm = min(zb + atmo.cloudLow.x * 1.2, zt);
  let top = atmoRaySphere(r0, h0 - zt, mu, atmo.cloudShell.y);
  if (top.y <= top.x || top.y <= 0.0) { return s; }
  let mid = atmoRaySphere(r0, h0 - zm, mu, atmo.cloudShell.x + (zm - zb));
  if (mid.y <= mid.x || mid.y <= 0.0) {
    s.span[0] = vec2f(max(top.x, 0.0), top.y);
    s.kind[0] = 2;
    return s;
  }
  s.span[0] = vec2f(max(top.x, 0.0), max(mid.x, 0.0));
  s.kind[0] = 2;
  let bot = atmoRaySphere(r0, h0 - zb, mu, atmo.cloudShell.x);
  if (bot.y <= bot.x || bot.y <= 0.0) {
    s.span[1] = vec2f(max(mid.x, 0.0), mid.y);
    s.kind[1] = 1;
  } else {
    s.span[1] = vec2f(max(mid.x, 0.0), max(bot.x, 0.0));
    s.kind[1] = 1;
    s.span[2] = vec2f(max(bot.y, 0.0), mid.y);
    s.kind[2] = 1;
  }
  s.span[3] = vec2f(mid.y, top.y);
  s.kind[3] = 2;
  return s;
}

/// A column with its sheet raised by dz (m): the column a little further along a ray over a sloping top.
fn cloudColumnRaised(col: CloudColumn, dz: f32) -> CloudColumn {
  var c = col;
  c.highTop += dz;
  c.highBase += dz;
  return c;
}

/// Cloudy part of a footprint under maximum overlap: 'cover' = largest fraction met so far, 'T' and 'L' =
/// mean transmittance and radiance of that part.
struct CloudStack {
  cover: f32,
  T: f32,
  L: vec3f,
}

/// One march step through a layer of fraction 'frac' whose cloudy part has step transmittance 'seg' and
/// source 'J' (radiance per unit of opacity).
fn cloudStackStep(st: ptr<function, CloudStack>, frac: f32, seg: f32, J: vec3f) {
  if (frac > (*st).cover) {
    // More of the footprint becomes cloud: the newcomers arrive untouched.
    (*st).T = ((*st).cover * (*st).T + (frac - (*st).cover)) / frac;
    (*st).L *= (*st).cover / frac;
    (*st).cover = frac;
  }
  let share = frac / max((*st).cover, 1e-6);
  (*st).L += J * ((*st).T * (1.0 - seg) * share);
  (*st).T *= 1.0 - share * (1.0 - seg);
}
`;

const CLOUD_HEADER = /* wgsl */ `
#include "atmosphere_model"
${ATMO_UNIFORM_WGSL}
@group(1) @binding(0) var<uniform> atmo: AtmoU;
@group(1) @binding(1) var atmoCoverageTex: texture_2d<f32>;
@group(1) @binding(2) var cloudBaseNoise: texture_3d<f32>;
@group(1) @binding(3) var cloudDetailNoise: texture_3d<f32>;
#include "atmosphere_cloud_density"
`;

/**
 * Cloud march, one ray per 2 x 2 block of the half-resolution target (the pixel of the block chosen by the
 * checkerboard phase). Bindings (group 1): 0 = AtmoU, 1 = coverage, 2 = base noise, 3 = detail noise,
 * 4 = transmittance, 5 = sky irradiance (texture_2d_array), 6 = cloud shadow map, 7 = 'scene.depthHalf'.
 * Targets: 0 = rgba16float (rgb = pre-exposed radiance, premultiplied; a = transmittance),
 * 1 = rgba32float cloud geometry along the ray: r = distance where the cloud begins, g = where it ends (or
 * becomes opaque), b = opacity-weighted mean distance; 3.0e38 = no cloud.
 *
 * Lighting of a sample (per unit of opacity):
 *   sun, low orders   three octaves of the dual-lobe Henyey-Greenstein phase (each wider and weaker), each
 *                     attenuated by the optical depth towards the sun (six cone samples through the cloud,
 *                     then the shadow map / coverage map beyond their reach);
 *   sun, high orders  the diffuse field of an optically thick cloud in the two-stream form
 *                     E / pi x (0.4 + 0.6 mu_sun) / (1 + k tau), faded out where the cloud is thin;
 *   ambient           sky irradiance from above and the sunlit ground from below, each attenuated by the
 *                     cloud in between (two-stream).
 * The sun's colour is the transmittance table at the sample (red tops at the terminator).
 */
export const CLOUD_MARCH_FS_WGSL = /* wgsl */ `
${CLOUD_HEADER}
@group(1) @binding(4) var transLut: texture_2d_array<f32>;
@group(1) @binding(5) var irradianceLut: texture_2d_array<f32>;
@group(1) @binding(6) var atmoShadowTex: texture_2d<f32>;
@group(1) @binding(7) var depthHalfTex: texture_2d<f32>;
#include "atmosphere_cloud_shadow"

struct CloudMarchOut {
  @location(0) color: vec4f,
  @location(1) depth: vec4f,
}

const CLOUD_OFFSETS = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 1), vec2i(1, 0), vec2i(0, 1));
// Cumulative fractions of the sun reach at which the six cone samples end.
const CLOUD_CONE = array<f32, 6>(0.04, 0.1, 0.2, 0.36, 0.62, 1.0);

fn cloudHg(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
/// Dual-lobe Henyey-Greenstein with both lobes narrowed by 'scale' (the multi-scatter octaves widen them).
fn cloudPhase(c: f32, scale: f32) -> f32 {
  return mix(cloudHg(c, atmo.cloudPhase.y * scale), cloudHg(c, atmo.cloudPhase.x * scale), atmo.cloudPhase.z);
}

/// Number of steps, times m, that the step rule  dt = clamp(m x factor x t, min, m x max)  takes from
/// distance a to distance b from the eye (m >= 1 = how much the rule is coarsened).
fn cloudStepCount(a: f32, b: f32, m: f32) -> f32 {
  if (b <= a) { return 0.0; }
  let tMin = atmo.cloudMarch.y / (m * atmo.cloudMarch.x);
  let tMax = atmo.cloudMarch.z / atmo.cloudMarch.x;
  var n = max(min(tMin, b) - a, 0.0) * m / atmo.cloudMarch.y;
  let ga = max(a, tMin);
  let gb = min(b, tMax);
  if (gb > ga) { n += log(gb / ga) * (1.0 / atmo.cloudMarch.x + 0.5 * m); }
  return n + max(b - max(a, tMax), 0.0) / atmo.cloudMarch.z;
}

@fragment fn fs(in: FullscreenOut) -> CloudMarchOut {
  var o: CloudMarchOut;
  o.color = vec4f(0.0, 0.0, 0.0, 1.0);
  o.depth = vec4f(3.0e38, 3.0e38, 3.0e38, 0.0);
  let bi = u32(atmo.bodies.z);
  let hp = min(vec2i(in.position.xy) * 2 + CLOUD_OFFSETS[atmo.layers.w], vec2i(atmo.halfSize.xy) - 1);
  let rayDir = cloudViewRay((vec2f(hp) + 0.5) * atmo.halfSize.zw);
  let len = length(rayDir);
  let d = rayDir / len;
  // Everything below is measured along the ray from where it enters the atmosphere shell (the eye when it
  // is inside): altitudes from the stable formula started there are exact to centimetres from any distance.
  let ray = atmoRay(bi, d);
  if (ray.len <= 0.0) { return o; }
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let sMax = min(ray.len, viewZFromDepth(textureLoad(depthHalfTex, hp, 0).r) * len - ray.t0);
  var spans = cloudSpans(ray);
  // Path length in the low shell and above it; two thirds of the step budget go to the low shell.
  var total = vec2f(0.0);
  for (var k = 0; k < 4; k++) {
    spans.span[k].y = min(spans.span[k].y, sMax);
    let l = max(spans.span[k].y - spans.span[k].x, 0.0);
    if (spans.kind[k] == 1) { total.x += l; } else if (spans.kind[k] == 2) { total.y += l; }
  }
  if (total.x + total.y <= 0.0) { return o; }

  // Steps grow with the distance from the eye (never under the minimum step, capped far away): fine where a
  // cloud fills the view, coarse where it is a few pixels. Where that rule would need more steps than the
  // budget (long rays: towards the horizon, inside a deck), the whole rule is coarsened by the factor that
  // makes it fit, separately for the low shell (two thirds of the budget) and the smooth shell above it
  // (one third, steps three times longer): the near field keeps its share of the detail either way.
  let budget = max(atmo.steps.w, 12.0);
  // (The governor's quality scale lengthens every step as well: cloudLight.w = 1 / qualityScale.)
  var coarsen = vec2f(atmo.cloudLight.w);
  for (var i = 0; i < 4; i++) {
    var need = vec2f(0.0);
    for (var k = 0; k < 4; k++) {
      let a = ray.t0 + spans.span[k].x;
      let b = ray.t0 + spans.span[k].y;
      if (spans.kind[k] == 1) { need.x += cloudStepCount(a, b, coarsen.x); } else if (spans.kind[k] == 2) { need.y += cloudStepCount(a, b, coarsen.y); }
    }
    coarsen = max(vec2f(atmo.cloudLight.w), vec2f(need.x / (budget * 0.667), need.y / budget));
  }
  // Step phase: blue noise while frames accumulate; the middle of the step when noise is frozen.
  let xi = 0.5 + (blueNoise(vec2u(hp)).y - 0.5) * atmo.misc.z;
  let pixelAngle = atmo.cloudMarch.w;
  let sunDir = frame.bodies[bi].sunDir.xyz;
  let sunNoise = cloudNoiseVec(bi, sunDir);
  let cosTheta = dot(d, sunDir);
  let layer = i32(frame.bodies[bi].fixedX.w);
  let gain = atmo.cloudDeep.w;
  let phase = vec3f(cloudPhase(cosTheta, 1.0), cloudPhase(cosTheta, gain) * gain, cloudPhase(cosTheta, gain * gain) * gain * gain);
  let kd = atmo.cloudLight.y;

  var st: CloudStack;
  st.cover = 0.0;
  st.T = 1.0;
  st.L = vec3f(0.0);
  var wSum = 0.0;
  var tSum = 0.0;
  var tFront = 3.0e38;
  var tBack = 0.0;
  var steps = 0.0;
  var haveLight = false;
  var lastLight = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    var s = spans.span[k].x;
    let sEnd = spans.span[k].y;
    let low = spans.kind[k] == 1;
    var sClear = s;       // last position known to be clear of cloud
    var clearOut = 0.0;   // how far outside the sheet's altitudes the ray was there (m; 0 = unknown or inside them)
    var prevS = -1.0;     // where the previous sample read its column (< 0: none yet), and the sheet top there
    var prevTop = 0.0;
    var inside = false;   // the previous sample was in cloud
    var fine = false;     // ... in a cloud with a surface (marched with half steps)
    while (s < sEnd && steps < budget && (st.T >= 0.004 || st.cover < 0.98)) {
      var dt = clamp((ray.t0 + s) * atmo.cloudMarch.x * coarsen.x, atmo.cloudMarch.y, atmo.cloudMarch.z * coarsen.x);
      if (!low) { dt = 3.0 * clamp((ray.t0 + s) * atmo.cloudMarch.x * coarsen.y, atmo.cloudMarch.y, atmo.cloudMarch.z * coarsen.y); }
      // Half steps while in a cloud with a surface.
      if (fine) { dt *= 0.5; }
      dt = min(dt, max(sEnd - s, 1.0));
      var sIn = s;                       // the slab of this step: [sIn, sOut]
      var sOut = s + dt;
      var ss = min(s + dt * xi, sEnd);
      steps += 1.0;
      // What one sample stands for: the pixel across the ray, the step along it. The noise is read at the
      // level of the larger of the two, so that a march coarser than the shapes (grazing rays, the far field)
      // sees them pre-filtered instead of sampling them at random: no streaks along the rows of a cloud deck
      // seen at a shallow angle.
      let footprint = max((ray.t0 + ss) * pixelAngle, 0.25 * dt);
      var q = cloudNoiseVec(bi, d * (ray.t0 + ss));
      let col = cloudColumnAt(bi, d * (ray.t0 + ss), q, footprint);
      let span = 0.5 * abs(atmoRayAltitude(ray, sOut) - atmoRayAltitude(ray, sIn));
      let footprintTop = footprint / sqrt(clamp(2.0 * span / max(sOut - sIn, 1.0), 0.03, 1.0));
      var den = cloudDensityAt(col, atmoRayAltitude(ray, ss), span, q, footprint, footprintTop, true);
      // The column is read once per step, at the sample. Its sheet top is carried to the other points of the
      // step (where the cloud begins, where it is lit) along its slope from the previous sample: a ray that
      // skims a rising cloud top meets it well before the sample, and a point lit as if it lay under the top
      // of the column ahead would be in shadow.
      let sCol = ss;
      var topSlope = 0.0;
      if (prevS >= 0.0 && sCol > prevS + 1.0) { topSlope = (col.highTop - prevTop) / (sCol - prevS); }
      prevS = sCol;
      prevTop = col.highTop;
      if (den.sigma <= 0.0) {
        sClear = ss;
        var bottomClear = col.highBase;
        if (col.deep > 0.0) { bottomClear = col.lowTop; }
        clearOut = max(max(atmoRayAltitude(ray, ss) - col.highTop, bottomClear - atmoRayAltitude(ray, ss)), 0.0);
        inside = false;
        fine = false;
        s = sOut;
        continue;
      }
      // Shapes with a surface: the low shell's cumulus, and the billowed top of a thick sheet wherever the
      // billows are resolved. Smooth sheets are integrated analytically over each step.
      let shaped = low || den.relief > 1.0;
      // Entering a cloud, the slabs are restarted where it begins. The light a dense cloud returns comes from
      // its first mean free paths, and one lighting sample per slab stands for it: slabs cut at fixed distances
      // from the eye would split that layer differently for every ray (contour bands, sand); slabs that start
      // on the cloud split it the same way for all of them.
      if (!inside && !shaped) {
        // A smooth sheet: it begins where the ray crosses its top (or its bottom, from below): between the
        // last clear sample and this one when both are known, the top taken as a straight line between them.
        var bottom = col.highBase;
        if (col.deep > 0.0) { bottom = col.lowTop; }
        let hS = atmoRayAltitude(ray, ss);
        let outNow = max(hS - col.highTop, bottom - hS);
        var sEntry = sIn;
        var moved = false;
        if (clearOut > 0.0 && outNow < 0.0 && ss > sClear + 1.0) {
          sEntry = sClear + (ss - sClear) * clearOut / (clearOut - outNow);
          moved = true;
        } else {
          let hA = atmoRayAltitude(ray, sIn);
          let hB = atmoRayAltitude(ray, sOut);
          if (abs(hB - hA) > 1.0) {
            let enter = saturate(min((clamp(hA, bottom, col.highTop) - hA) / (hB - hA), (clamp(hB, bottom, col.highTop) - hA) / (hB - hA)));
            if (enter > 0.0) {
              sEntry = sIn + (sOut - sIn) * enter;
              moved = true;
            }
          }
        }
        if (moved) {
          sIn = sEntry;
          sOut = min(sIn + dt, sEnd);
          ss = 0.5 * (sIn + sOut);
          q = cloudNoiseVec(bi, d * (ray.t0 + ss));
          let again = cloudDensityAt(cloudColumnRaised(col, topSlope * (ss - sCol)), atmoRayAltitude(ray, ss), 0.5 * abs(atmoRayAltitude(ray, sOut) - atmoRayAltitude(ray, sIn)), q, footprint, footprintTop, true);
          if (again.sigma > 0.0) { den = again; }
        }
      }
      var sliver = false;
      if (!inside && shaped) {
        // A surface: found between the last clear sample and this one by bisection, to a fraction of a mean
        // free path and of the in-cloud step (an error of that size in where the cloud begins shows as shading,
        // and as contour lines where the slabs behind it sample a soft edge).
        var lo = sClear;
        var hi = ss;
        var denHi = den;
        for (var i = 0; i < 8; i++) {
          if (((hi - lo) * denHi.sigma < 0.4 && hi - lo < 0.06 * dt) || hi - lo < 3.0) { break; }
          let sm = 0.5 * (lo + hi);
          let dm = cloudDensityAt(cloudColumnRaised(col, topSlope * (sm - sCol)), atmoRayAltitude(ray, sm), 0.0, cloudNoiseVec(bi, d * (ray.t0 + sm)), footprint, footprintTop, true);
          if (dm.sigma > 0.0) { hi = sm; denHi = dm; } else { lo = sm; }
        }
        sIn = hi;
        sOut = min(hi + 0.5 * dt, sEnd);
        ss = 0.5 * (sIn + sOut);
        q = cloudNoiseVec(bi, d * (ray.t0 + ss));
        den = cloudDensityAt(cloudColumnRaised(col, topSlope * (ss - sCol)), atmoRayAltitude(ray, ss), 0.5 * span, q, footprint, footprintTop, true);
        // A sliver thinner than the slab (the ray clips a bump and is out again by the middle of the slab):
        // what the bisection found stands for it, and the march goes on as in clear air, so that the next
        // cloud is entered at its own surface.
        if (den.sigma <= 0.0) {
          den = denHi;
          sliver = true;
        }
      }
      inside = !sliver;
      fine = shaped && !sliver;
      if (sliver) {
        sClear = ss;
        clearOut = 0.0;
      }
      s = sOut;
      let dtCloud = max(sOut - sIn, 0.0);
      // Light the step where its opacity sits: the opacity-weighted mean depth behind the step's start (one
      // mean free path into a dense cloud, the middle of a thin one). Neighbouring rays then light the same
      // point of the cloud instead of wherever their step phase happened to put the sample.
      let x = den.sigma * dtCloud;
      let seg = exp(-x);
      var meanDepth = 0.5 - x / 12.0;
      if (x > 0.05) { meanDepth = 1.0 / x - seg / (1.0 - seg); }
      // A sheet thinner than the step: the opacity sits where the ray is inside the sheet, not anywhere in
      // the step (a point above it would be lit as if nothing shaded it, a point below as if all of it did).
      var sA = sIn;
      var sB = sOut;
      if (!shaped) {
        let hA = atmoRayAltitude(ray, sIn);
        let hB = atmoRayAltitude(ray, sOut);
        if (abs(hB - hA) > 1.0) {
          let top = col.highTop + topSlope * (sIn - sCol);
          var bottom = col.highBase + topSlope * (sIn - sCol);
          if (col.deep > 0.0) { bottom = col.lowTop; }
          let fa = (clamp(hA, bottom, top) - hA) / (hB - hA);
          let fb = (clamp(hB, bottom, top) - hA) / (hB - hA);
          sA = sIn + dtCloud * saturate(min(fa, fb));
          sB = sIn + dtCloud * saturate(max(fa, fb));
        }
      }
      let sl = sA + (sB - sA) * meanDepth;
      let hl = atmoRayAltitude(ray, sl);
      let colL = cloudColumnRaised(col, topSlope * (sl - sCol));
      let posL = d * (ray.t0 + sl);
      let ql = cloudNoiseVec(bi, posL);
      let up = normalize(posL - frame.bodies[bi].center.xyz);
      let r = rb + hl;
      let muS = dot(up, sunDir);
      let vis = atmoSunVisibility(posL, sunDir, bi).x;
      var J = vec3f(0.0);
      // A slab that adds next to nothing to the pixel (deep inside a cloud already entered, or one more layer
      // of a thin veil) takes the light of the slab before it instead of marching towards the sun again.
      let reuse = haveLight && st.T * (1.0 - seg) * den.frac < 0.03;
      if (reuse) {
        J = lastLight;
      } else if (vis > 0.0) {
        // Optical depth towards the sun: six cone samples through the same column, then the far term.
        let reach = max(atmo.cloudPhase.w, footprint * 3.0);
        var tau = 0.0;
        var cPrev = 0.0;
        for (var j = 0; j < 6; j++) {
          let cNext = reach * CLOUD_CONE[j];
          let cm = 0.5 * (cPrev + cNext);
          let qq = 2.0 * r * muS * cm + cm * cm;
          let hj = hl + qq / (sqrt(max(r * r + qq, 1.0)) + r);
          let ds = cNext - cPrev;
          tau += cloudDensityAt(colL, hj, 0.5 * ds * abs(muS), ql + sunNoise * cm, max(footprint, 0.5 * ds), max(footprintTop, 0.5 * ds), j < 2).sigma * ds;
          cPrev = cNext;
        }
        // Beyond the reach: radius of the end point from the same stable form, direction from the sum.
        let qe = 2.0 * r * muS * reach + reach * reach;
        let endR = r + qe / (sqrt(max(r * r + qe, 1.0)) + r);
        let endPos = posL + sunDir * reach;
        tau += -log(max(atmoCloudShadowAt(endPos, bi, normalize(endPos - frame.bodies[bi].center.xyz), endR, muS), 1e-6));
        let e = frame.sunIlluminance.rgb * atmosphereSunTransmittance(transLut, bi, r, muS) * vis;
        let lowOrders = phase.x * exp(-tau) + phase.y * exp(-tau * gain) + phase.z * exp(-tau * gain * gain);
        // High orders: only where the cloud around the sample is thick enough to hold a diffuse field.
        let thick = 1.0 - exp(-0.5 * (tau + den.above + den.below));
        let highOrders = atmo.cloudLight.x * thick * (0.4 + 0.6 * saturate(muS)) / (PI * (1.0 + kd * tau * max(muS, 0.15)));
        J = e * (lowOrders + highOrders);
      }
      if (!reuse) {
        // Ambient: sky from above, the sunlit ground from below, each through the cloud in between.
        let sky = textureSampleLevel(irradianceLut, linearClamp, skyIrradianceUvFromRMuS(r, muS, rb, rt), layer, 0.0).rgb;
        let groundE = sky + frame.sunIlluminance.rgb * atmosphereSunTransmittance(transLut, bi, rb, muS) * (max(muS, 0.0) * vis);
        J += (sky / (1.0 + kd * den.above) + groundE * (atmo.cloudDeep.y / (1.0 + kd * den.below))) * (atmo.cloudDeep.z * 0.5 / PI);
        lastLight = J;
        haveLight = true;
      }

      let before = st.cover * (1.0 - st.T);
      cloudStackStep(&st, den.frac, seg, J);
      let w = st.cover * (1.0 - st.T) - before;
      wSum += w;
      tSum += w * (ray.t0 + sl);
      tFront = min(tFront, ray.t0 + sIn);
      tBack = ray.t0 + sOut;
    }
  }
  if (wSum <= 1e-5) { return o; }
  var T = 1.0 - st.cover * (1.0 - st.T);
  if (T < 0.004) { T = 0.0; }
  o.color = vec4f(writeHdr(st.L * (st.cover * frame.exposure.x)), T);
  o.depth = vec4f(max(tFront, 0.0), tBack, tSum / wSum, 0.0);
  return o;
}
`;

/**
 * Temporal checkerboard resolve to the half-resolution cloud buffers. Bindings (group 1): 0 = AtmoU,
 * 1 = fresh radiance (quarter area), 2 = fresh cloud geometry, 3 = history radiance, 4 = history geometry.
 * Targets: 0 = 'clouds.screen' (rgba16float), 1 = 'clouds.depth' (r32float), 2 = cloud geometry
 * (rgba32float: begin, end, mean distance), which the atmosphere march and the next frame's resolve read.
 *
 * 'clouds.depth' is what the render core's applyAtmosphere() compares a transparent fragment's distance d
 * with: it attenuates the fragment by the cloud transmittance over smoothstep(0.9, 1.1, d / depth). The
 * value written is therefore not simply the mean distance: it is chosen so that everything behind the
 * cloud's far side is fully attenuated (depth <= end / 1.1) and, where the cloud is deep enough for both,
 * nothing in front of its near side is (depth >= begin / 0.9).
 */
export const CLOUD_RESOLVE_FS_WGSL = /* wgsl */ `
${ATMO_UNIFORM_WGSL}
@group(1) @binding(0) var<uniform> atmo: AtmoU;
@group(1) @binding(1) var freshTex: texture_2d<f32>;
@group(1) @binding(2) var freshGeomTex: texture_2d<f32>;
@group(1) @binding(3) var historyTex: texture_2d<f32>;
@group(1) @binding(4) var historyGeomTex: texture_2d<f32>;

struct ResolveOut {
  @location(0) color: vec4f,
  @location(1) depth: vec4f,
  @location(2) geom: vec4f,
}

const CLOUD_OFFSETS = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 1), vec2i(1, 0), vec2i(0, 1));
const NO_CLOUD = vec4f(3.0e38, 3.0e38, 3.0e38, 0.0);

@fragment fn fs(in: FullscreenOut) -> ResolveOut {
  let hp = vec2i(in.position.xy);
  let off = CLOUD_OFFSETS[atmo.layers.w];
  let qsize = vec2i(textureDimensions(freshTex));
  let qp = min(hp >> vec2u(1u), qsize - 1);
  let isFresh = (hp.x & 1) == off.x && (hp.y & 1) == off.y;

  // The fresh samples around this pixel: bilinear estimate, colour box, cloud geometry.
  let st = (vec2f(hp) - vec2f(off)) * 0.5;
  let base = vec2i(floor(st));
  let fr = st - floor(st);
  var est = vec4f(0.0);
  var estGeom = vec3f(0.0);
  var estGeomW = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let ip = clamp(base + o, vec2i(0), qsize - 1);
    let w = select(1.0 - fr.x, fr.x, o.x == 1) * select(1.0 - fr.y, fr.y, o.y == 1);
    est += textureLoad(freshTex, ip, 0) * w;
    let g = textureLoad(freshGeomTex, ip, 0).rgb;
    if (g.b < 1.0e37) { estGeom += g * w; estGeomW += w; }
  }
  var lo = vec4f(3.0e38);
  var hi = vec4f(-3.0e38);
  var nearGeom = NO_CLOUD.rgb;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let ip = clamp(qp + vec2i(x, y), vec2i(0), qsize - 1);
      let c = textureLoad(freshTex, ip, 0);
      lo = min(lo, c);
      hi = max(hi, c);
      let g = textureLoad(freshGeomTex, ip, 0).rgb;
      if (g.b < nearGeom.b) { nearGeom = g; }
    }
  }
  var geomNow = nearGeom;
  if (estGeomW > 0.0) { geomNow = estGeom / estGeomW; }

  let fresh = textureLoad(freshTex, qp, 0);
  var color = est;
  var geom = geomNow;
  if (isFresh) {
    color = fresh;
    geom = textureLoad(freshGeomTex, qp, 0).rgb;
  }
  if (atmo.misc.y > 0.5) {
    // Reproject by the distance of the cloud (a point fixed to the body): prev = p + M p + t, relative to
    // the previous eye. Where there is no cloud the direction alone is reprojected (a far point). The cloud
    // buffers live on the unjittered pixel lattice, so the previous position is a history texel position.
    let ndc = vec2f((f32(hp.x) + 0.5) * atmo.halfSize.z * 2.0 - 1.0, 1.0 - (f32(hp.y) + 0.5) * atmo.halfSize.w * 2.0);
    let ray = frame.cameraForward.xyz + frame.cameraRight.xyz * (ndc.x * frame.cameraRight.w) + frame.cameraUp.xyz * (ndc.y * frame.cameraUp.w);
    let p = normalize(ray) * min(geomNow.b, 2.0e7);
    let prev = p + vec3f(dot(atmo.reproj0.xyz, p), dot(atmo.reproj1.xyz, p), dot(atmo.reproj2.xyz, p)) + atmo.reprojT.xyz;
    let clip = frame.prevViewProj * vec4f(prev, 1.0);
    let uvPrev = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    let texel = atmo.halfSize.zw;
    if (clip.w > 0.0 && all(uvPrev > texel) && all(uvPrev < vec2f(1.0) - texel)) {
      var hist = textureSampleLevel(historyTex, linearClamp, uvPrev, 0.0);
      hist = vec4f(hist.rgb * atmo.misc.x, hist.a);
      // Neighbourhood clamp against the fresh samples: what rejects stale history when the view moves.
      // The fresh samples are sparse (one per 2 x 2 block), so the clamp also cuts real detail between them:
      // it is applied in proportion to the motion of the pixel since the last frame and not at all to a
      // pixel that has not moved, whose history is its own march of a few frames ago.
      let motion = length((uvPrev - (vec2f(hp) + 0.5) * atmo.halfSize.zw) * atmo.halfSize.xy);
      let slack = (hi - lo) * 0.08 + vec4f(1e-4);
      let clamped = mix(hist, clamp(hist, lo - slack, hi + slack), saturate(motion * 4.0 - 0.1));
      if (isFresh) {
        color = mix(clamped, fresh, atmo.misc.w);
      } else {
        color = clamped;
        let hg = textureLoad(historyGeomTex, vec2i(uvPrev * atmo.halfSize.xy), 0).rgb;
        if (geomNow.b > 1.0e37 && hg.b < 1.0e37 && clamped.a < 0.999) { geom = hg; }
      }
    }
  }
  var o: ResolveOut;
  o.color = vec4f(writeHdr(color.rgb), saturate(color.a));
  if (o.color.a > 0.9995 || geom.b > 1.0e37) {
    o.geom = NO_CLOUD;
    o.depth = vec4f(3.0e38, 0.0, 0.0, 0.0);
  } else {
    o.geom = vec4f(geom, 0.0);
    // See the header: hide what lies behind the cloud; spare what lies in front where the cloud is deep.
    o.depth = vec4f(min(max(geom.b, geom.r / 0.9), geom.g / 1.1), 0.0, 0.0, 0.0);
  }
  return o;
}
`;

/**
 * Near-field cloud shadow map: orthographic along the projection direction (the sun's, kept at least a few
 * degrees above the horizon of the map centre). Each texel holds, for the line through it:
 *   r = optical depth of the whole cloud layer along the line (what the deferred lighting reads),
 *   g = distance along the line (from the map plane, towards the sun) where the cloud begins on the sun side,
 *   b = mean extinction along the line behind that point (1 / m).
 * A point at distance s along its line has  tau = clamp((g - s) b, 0, r)  between it and the sun.
 * A sixteenth of the texels is re-marched per frame; the others are copied from the previous frame at the
 * whole-texel shift of the origin. Bindings (group 1): 0 = AtmoU, 1 = coverage, 2 = base noise,
 * 3 = detail noise, 4 = previous map.
 */
export const CLOUD_SHADOW_FS_WGSL = /* wgsl */ `
${CLOUD_HEADER}
@group(1) @binding(4) var prevTex: texture_2d<f32>;

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let pix = vec2i(in.position.xy);
  let n = i32(atmo.shadowShift.w);
  let phase = i32(atmo.shadowShift.z);
  // One texel of every 4 x 4 block per frame, in an order that spreads successive frames over the block.
  let order = array<i32, 16>(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  let mine = order[(pix.x & 3) + 4 * (pix.y & 3)] == phase;
  if (!mine && atmo.shadowL.w > 0.5) {
    let src = pix + vec2i(atmo.shadowShift.xy);
    if (all(src >= vec2i(0)) && all(src < vec2i(n))) { return textureLoad(prevTex, src, 0); }
  }
  let bi = u32(atmo.bodies.z);
  let he = atmo.shadowOrigin.w;
  let texel = 2.0 * he / f32(n);
  let qm = ((vec2f(pix) + 0.5) / f32(n) * 2.0 - 1.0) * he;
  let dir = atmo.shadowL.xyz;
  let p0 = atmo.shadowOrigin.xyz + atmo.shadowU.xyz * qm.x + atmo.shadowV.xyz * qm.y;
  let pc = p0 - frame.bodies[bi].center.xyz;
  let dist = length(pc);
  let b = dot(pc, dir);
  let rTop = atmo.cloudShell.y;
  let rBot = atmo.cloudShell.x;
  let discTop = b * b - (dist - rTop) * (dist + rTop);
  if (discTop <= 0.0) { return vec4f(0.0, -3.0e30, 0.0, 1.0); }
  let sTop = -b + sqrt(discTop);
  let discBot = b * b - (dist - rBot) * (dist + rBot);
  // The sun-side crossing of the layer: from where the line leaves the bottom sphere (or from its perigee
  // when it passes above the bottom) to where it leaves the top.
  var sBot = -b;
  if (discBot > 0.0) { sBot = -b + sqrt(discBot); }
  let count = max(i32(atmo.shadowU.w), 4);
  let ds = (sTop - sBot) / f32(count);
  let rb = frame.bodies[bi].center.w;
  var st: CloudStack;
  st.cover = 0.0;
  st.T = 1.0;
  st.L = vec3f(0.0);
  var sFront = sBot;
  var sBack = sTop;
  var found = false;
  for (var i = 0; i < count; i++) {
    let s = sTop - (f32(i) + 0.5) * ds;
    let pos = p0 + dir * s;
    let h = length(pos - frame.bodies[bi].center.xyz) - rb;
    let q = cloudNoiseVec(bi, pos);
    let col = cloudColumnAt(bi, pos, q, texel);
    let den = cloudDensityAt(col, h, 0.5 * ds * atmo.shadowV.w, q, texel, texel, false);
    if (den.sigma > 0.0) {
      cloudStackStep(&st, den.frac, exp(-den.sigma * ds), vec3f(0.0));
      if (!found) { sFront = s + 0.5 * ds; found = true; }
      sBack = s - 0.5 * ds;
    }
  }
  if (!found) { return vec4f(0.0, sBot, 0.0, 1.0); }
  // Transmittance of the texel's footprint (fractional cover included), expressed as an optical depth.
  let tau = min(-log(max(1.0 - st.cover * (1.0 - st.T), 1e-9)), 40.0);
  return vec4f(tau, sFront, tau / max(sFront - sBack, ds), 1.0);
}
`;

/**
 * One-off noise generation (compute). Group 0: binding 0 = output (texture_storage_3d rgba16float),
 * binding 1 = uniform (x = resolution, y = 0 base / 1 detail).
 *   base (128^3):  r = Perlin-Worley shape, g = Worley cells (mesoscale use), b = smooth Perlin fBm
 *                  (weather scale, streaks), a = high-frequency Worley fBm
 *   detail (32^3): r, g, b = Worley at 2, 4 and 8 cells per tile
 * All channels tile seamlessly; lattice values come from the engine's integer hash, so the textures are
 * the same on every run.
 */
export const CLOUD_NOISE_COMPUTE_WGSL = /* wgsl */ `
#include "hash"
struct NoiseU { size: vec4u }
@group(0) @binding(0) var outTex: texture_storage_3d<rgba16float, write>;
@group(0) @binding(1) var<uniform> gen: NoiseU;

fn wrapCell(c: vec3i, period: i32) -> vec3i { return ((c % period) + period) % period; }

fn cellPoint(c: vec3i, period: i32, seed: i32) -> vec3f {
  let w = wrapCell(c, period);
  let h1 = hash4(w.x, w.y, w.z, seed);
  let h2 = hash_u32(h1);
  let h3 = hash_u32(h2);
  return vec3f(hash_to_unit(h1), hash_to_unit(h2), hash_to_unit(h3));
}

/// Inverted Worley noise (1 at a feature point, 0 one cell away), periodic over 'period' cells.
fn worley(p: vec3f, period: i32, seed: i32) -> f32 {
  let ci = vec3i(floor(p));
  let f = fract(p);
  var dmin = 10.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3i(x, y, z);
        let pt = cellPoint(ci + o, period, seed) + vec3f(o) - f;
        dmin = min(dmin, dot(pt, pt));
      }
    }
  }
  return 1.0 - min(sqrt(dmin), 1.0);
}
fn worleyFbm(p: vec3f, freq: i32, seed: i32) -> f32 {
  return worley(p * f32(freq), freq, seed) * 0.625 + worley(p * f32(freq * 2), freq * 2, seed + 1) * 0.25 + worley(p * f32(freq * 4), freq * 4, seed + 2) * 0.125;
}

fn gradient(c: vec3i, period: i32, seed: i32) -> vec3f {
  let w = wrapCell(c, period);
  let h = hash4(w.x, w.y, w.z, seed);
  let z = hash_to_unit(h) * 2.0 - 1.0;
  let a = hash_to_unit(hash_u32(h)) * 6.28318530718;
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(a), r * sin(a), z);
}
/// Gradient noise in about [-1, 1], periodic over 'period' cells.
fn perlin(p: vec3f, period: i32, seed: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var n: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    n[k] = dot(gradient(i + o, period, seed), f - vec3f(o));
  }
  let x0 = mix(n[0], n[1], u.x);
  let x1 = mix(n[2], n[3], u.x);
  let x2 = mix(n[4], n[5], u.x);
  let x3 = mix(n[6], n[7], u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z) * 1.6;
}
fn perlinFbm(p: vec3f, freq: i32, octaves: i32, seed: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var fq = freq;
  for (var o = 0; o < octaves; o++) {
    s += a * perlin(p * f32(fq), fq, seed + o);
    fq *= 2;
    a *= 0.5;
  }
  return s;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = gen.size.x;
  if (any(id >= vec3u(n))) { return; }
  let p = (vec3f(id) + 0.5) / f32(n);
  var v = vec4f(0.0);
  if (gen.size.y == 0u) {
    let pf = saturate(perlinFbm(p, 4, 6, 11) * 0.75 + 0.5);
    let wf = worleyFbm(p, 4, 31);
    // Perlin-Worley: the Perlin field dilated by the inverted Worley cells (billows that stay connected).
    v.r = saturate((pf - (wf - 1.0)) / (2.0 - wf) * 1.25 - 0.125);
    v.g = worleyFbm(p, 4, 57);
    v.b = saturate(perlinFbm(p, 3, 4, 83) * 0.8 + 0.5);
    v.a = worleyFbm(p, 8, 101);
  } else {
    v.r = worley(p * 2.0, 2, 131);
    v.g = worley(p * 4.0, 4, 151);
    v.b = worley(p * 8.0, 8, 173);
    v.a = 1.0;
  }
  textureStore(outTex, id, v);
}
`;
