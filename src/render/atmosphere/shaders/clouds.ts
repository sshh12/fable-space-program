/**
 * WGSL of the volumetric clouds: the density model (chunk "atmosphere_cloud_density"), the quarter-area
 * ray march, the temporal checkerboard resolve, the near-field shadow map, and the one-off noise
 * generation.
 *
 * Density model. The baked global map gives, per column, a coverage c and a cloud-top altitude. From them:
 *   low layer    cumulus and stratocumulus above the shell bottom: cloud is where the shape noise (a
 *                Perlin-Worley field already eroded by three Worley octaves, histogram-equalised) exceeds a
 *                threshold that is 1 - cover at the base and rises with height, so that every cloud has a
 *                flat base and a dome whose height follows how far the noise is above the threshold; a field
 *                of small cover is a field of small flat clouds, a cover near 1 a closed deck whose top is
 *                pitted between its cells. The surface is then eroded by the detail noise (two lookups of a
 *                Worley fBm, the position warped by the shape noise), deep enough to open holes;
 *   upper body   altostratus, nimbostratus and anvils under the map's cloud top, where the map's coverage
 *                is high and its top lies well above the low layer: the same construction with the shape
 *                noise at a larger scale; it reaches down to the low layer where c approaches 1.
 * The map's c is an opacity as much as a cover: the low layer's extinction grows with it and is mottled at
 * the mesoscale, and the cover itself is broken up by three scales of cells (7 to 90 km).
 * Shape noise is sampled at the mip level of the PIXEL footprint (never of the step). What the mip chain
 * has averaged away is accounted for analytically as a cloud FRACTION (the share of the footprint above the
 * threshold), so the same function gives resolved cumulus near the camera and the right partial cover from
 * orbit and beyond. Past the mip level where next to nothing is left, the noise is replaced by its mean
 * exactly (the last levels of a tiling texture, sampled by a pixel lattice, show the tile as a stipple).
 *
 * Fractions along a ray are combined with maximum overlap (clouds are columns): the march tracks the
 * largest fraction met so far and the mean transmittance / radiance of that cloudy part of the footprint.
 */
import { ATMO_UNIFORM_WGSL } from '../uniforms';

/**
 * Needs from the includer: `atmo` (AtmoU), `atmoCoverageTex: texture_2d<f32>` (r = coverage, g = cloud
 * top / 12750 m), `cloudBaseNoise`, `cloudDetailNoise: texture_3d<f32>`, and chunk "atmosphere_model".
 */
export const CLOUD_DENSITY_WGSL = /* wgsl */ `
struct CloudColumn {
  cLow: f32,       // cover of the low layer, 0..1.3 (above 1: a closed deck)
  lowTop: f32,     // highest altitude (m) a low cloud of this column can reach
  dens: f32,       // multiplier of the low layer's extinction (thin cloud where the map's opacity is low, mottled at the mesoscale)
  amtUp: f32,      // amount of the upper body, 0..1
  upBase: f32,     // its bottom and top altitude (m)
  upTop: f32,
  extUp: f32,      // its extinction, 1 / m
  relief: f32,     // depth (m) of the relief of its top
}

struct CloudDensity {
  sigma: f32,      // extinction of the cloudy part of the footprint, 1 / m
  frac: f32,       // share of the footprint that is cloudy, 0..1
  above: f32,      // optical depth of the cloud above the point (vertical), for the diffuse and ambient terms
  below: f32,      // the same below the point
  layer: f32,      // 0 = a shape with sides (lit as a body), 1 = a layer or an unresolved field (lit as a slab)
}

/// Share of the shape noise kept at mip level 'lod': 1 while the mip chain still holds a pattern, 0 from
/// the level at which its remaining texels would only show the period of the tile.
fn cloudNoiseKeep(lod: f32) -> f32 { return 1.0 - smoothstep(4.0, 5.5, lod); }

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
/// in the noise frame relative to the camera, 'footprint' = size of the pixel there (m), 'hLow' = the lowest
/// altitude (m) the caller will ask this column about: above every cloud top the map allows there, the
/// column is returned empty without the noise lookups (most steps of a ray through clear upper air).
fn cloudColumnAt(bi: u32, pos: vec3f, q: vec3f, footprint: f32, hLow: f32) -> CloudColumn {
  let dfix = normalize(rootToFixed(bi, pos - frame.bodies[bi].center.xyz));
  let lon = atan2(dfix.y, dfix.x) + atmo.noiseRot.z;
  let uv = vec2f(lon / TWO_PI + 0.5, clamp(acos(clamp(dfix.z, -1.0, 1.0)) / PI, 0.0005, 0.9995));
  let texel = TWO_PI * frame.bodies[bi].center.w / atmo.noiseRot.w;
  let m = textureSampleLevel(atmoCoverageTex, linearRepeat, uv, log2(max(footprint / texel, 1.0)));
  let c = m.r;
  let ct = m.g * 12750.0;
  let zb = atmo.cloudShell.z;
  let zt = atmo.cloudShell.w;
  var col: CloudColumn;
  col.upTop = clamp(ct, zb + 600.0, zt);
  // The low layer is as deep as the map's cloud top allows, up to one and a half times its nominal depth.
  let lowDepth = clamp(ct - zb, 0.25 * atmo.cloudLow.x, 1.5 * atmo.cloudLow.x);
  if (hLow >= col.upTop && hLow >= zb + lowDepth * 1.2) {
    col.cLow = 0.0;
    col.lowTop = zb + 0.4 * lowDepth;
    col.dens = 1.0;
    col.amtUp = 0.0;
    col.upBase = col.upTop - 200.0;
    col.extUp = 0.0;
    col.relief = 0.0;
    return col;
  }
  let large = textureSampleLevel(cloudBaseNoise, linearRepeat, (atmo.noiseLarge.xyz + q) * atmo.noiseLarge.w, log2(max(footprint * atmo.noiseLarge.w * 128.0, 1.0)));
  let meso = textureSampleLevel(cloudBaseNoise, linearRepeat, (atmo.noiseMeso.xyz + q) * atmo.noiseMeso.w, log2(max(footprint * atmo.noiseMeso.w * 128.0, 1.0)));
  // Every modulation averages out to nothing once the pixel is as large as its features: it is faded to its
  // mean there instead of being sampled from the last few texels of a mip chain.
  let mesoKeep = 1.0 - smoothstep(0.03, 0.12, footprint * atmo.noiseMeso.w);
  let mesoFineKeep = 1.0 - smoothstep(0.008, 0.035, footprint * atmo.noiseMeso.w);
  let largeKeep = 1.0 - smoothstep(0.015, 0.07, footprint * atmo.noiseLarge.w);
  let cellKeep = 1.0 - smoothstep(0.008, 0.035, footprint * atmo.noiseLarge.w);
  let nLarge = mix(0.5, large.b, largeKeep);

  // Fair-weather fields where the infrared map is clear, placed by the weather-scale noise and broken into
  // cells and streets by its finer octaves.
  let fair = atmo.cloudLow2.x * mix(0.375, smoothstep(0.45, 0.8, nLarge) * mix(0.62, 0.25 + 1.5 * large.a * large.g, cellKeep), largeKeep) * (1.0 - smoothstep(0.0, 0.3, c));
  let c0 = saturate(c * atmo.cloudLow.w + fair);
  // Three scales of cells (clusters of tens of kilometres, cells of ten, cells of a few) break the cover up
  // without changing its mean: popcorn fields, open and closed cells, clear lanes.
  let pattern = 0.3 * mix(0.5, large.a, cellKeep) + 0.42 * mix(0.5, meso.g, mesoKeep) + 0.28 * mix(0.5, meso.a, mesoFineKeep);
  let cover = saturate(c0 + (pattern - 0.5) * atmo.cloudLow2.y * 5.0 * c0 * (1.0 - c0));
  // A cover near 1 is a closed deck: the threshold drops under the lowest noise value.
  col.cLow = cover + 0.3 * smoothstep(0.72, 0.98, cover);
  let calm = mix(0.5, meso.b, mesoKeep);
  col.lowTop = min(zb + lowDepth * mix(0.45, 1.0, saturate(cover)) * (0.8 + 0.4 * calm), zt);
  // Extinction of the low layer: fair-weather cumulus are dense whatever the map says; cloud the map
  // itself shows is as thin as its opacity is low. Both are mottled at the mesoscale.
  let thin = mix(mix(atmo.cloudLow3.x, 1.0, smoothstep(0.0, 0.6, c)), 1.0, saturate(fair / max(c0, 1e-4)));
  col.dens = thin * exp2(((mix(0.5, meso.r, mesoKeep) - 0.5) + (nLarge - 0.5) * 0.8) * 2.0 * atmo.cloudLow3.y);

  // The upper body: only where the map's top leaves room above the low layer. Its outline wanders with the
  // weather-scale and mesoscale noise: veils with irregular edges instead of the map's contour lines.
  let wander = ((nLarge - 0.5) * 0.3 + (calm - 0.5) * 0.24) * smoothstep(0.02, 0.3, c);
  let room = smoothstep(500.0, 2000.0, col.upTop - (zb + lowDepth));
  col.amtUp = smoothstep(atmo.cloudHigh2.x, atmo.cloudHigh2.y, c + wander) * room;
  let deep = smoothstep(atmo.cloudHigh2.z, atmo.cloudHigh2.w, c) * room;
  col.upBase = max(mix(col.upTop - mix(atmo.cloudHigh.x, atmo.cloudHigh.y, col.amtUp), col.lowTop - 300.0, deep), zb + 200.0);
  col.extUp = mix(atmo.cloudHigh.z * pow(atmo.cloudHigh.w / atmo.cloudHigh.z, col.amtUp), atmo.cloudDeep.x, deep);
  col.relief = min(atmo.cloudLight.z * mix(0.6, 1.6, deep), 0.6 * (col.upTop - col.upBase));
  return col;
}

/// Density at altitude h of a column. 'q' = the point in the noise frame, 'footprint' = size of what the
/// sample stands for (m). 'detail': 0 = shapes only, 1 = with the small-scale erosion (faded out beyond the
/// detail fade footprint), 2 = also its finer octave for clouds close to the eye.
fn cloudDensityAt(col: CloudColumn, h: f32, q: vec3f, footprint: f32, detail: i32) -> CloudDensity {
  var out: CloudDensity;
  out.sigma = 0.0;
  out.frac = 1.0;
  out.above = 0.0;
  out.below = 0.0;
  out.layer = 0.0;
  let zb = atmo.cloudShell.z;
  if (h <= zb || h >= atmo.cloudShell.w) { return out; }
  let inLow = h < col.lowTop && col.cLow > 0.004;
  let inUp = col.amtUp > 0.0 && h > col.upBase - 200.0 && h < col.upTop;
  if (!(inLow || inUp)) { return out; }

  let pb = (atmo.noiseBase.xyz + q + atmo.cloudWind.xyz * (h - zb)) * atmo.noiseBase.w;
  // The level of the pixel footprint, half a level up: the smallest features kept are a pixel and a half
  // across. (Of the pixel alone: a march coarser than the shapes is dithered and accumulated, not blurred.)
  let lodB = log2(max(footprint * atmo.noiseBase.w * 180.0, 1.0));

  var sigmaLow = 0.0;
  var fracLow = 1.0;
  var layerLow = 0.0;
  if (inLow) {
    let nb = textureSampleLevel(cloudBaseNoise, linearRepeat, pb, lodB);
    let keep = cloudNoiseKeep(lodB);
    let fade = mix(1.0, cloudNoiseFade(lodB), keep);
    let n = mix(0.5, nb.r, keep);
    let depth = col.lowTop - zb;
    let hl = saturate((h - zb) / depth);
    // Flat bases, domed tops: the threshold is at its lowest just above the base and rises towards the top
    // (over most of the depth for scattered cumulus, over the top quarter for a deck).
    let deck = smoothstep(0.72, 1.0, col.cLow);
    let g0 = mix(0.12, 0.72, deck);
    let g = saturate((h - zb) / 60.0) * (1.0 - smoothstep(g0, 1.0, hl));
    // Detail erosion carves billows and holes into resolved shapes: it lowers the excess over the threshold
    // by up to k, most where the detail noise is high. (It removes half its strength on average: the
    // threshold is lowered by as much, so that the covered share stays the one the map gives.)
    var k = 0.0;
    if (detail > 0) { k = atmo.cloudLow2.z * (1.0 - smoothstep(0.4 * atmo.cloudLow2.w, atmo.cloudLow2.w, footprint)) * (1.0 - fade); }
    // Excess over the threshold at the base level (which columns are cloudy at all) and at this height.
    let e0 = n - (1.0 - col.cLow) + 0.5 * k;
    // What the mip has averaged away varies inside the footprint with the spread sqrt(1 - kept^2) of the
    // whole (variances add): the share of the footprint above the threshold follows from it. Where the
    // shapes are not resolved the covered share is that of the whole column (maximum overlap).
    let spread = sqrt(max(1.0 - (1.0 - fade) * (1.0 - fade), 0.0));
    fracLow = saturate((e0 - (1.0 - mix(g, 1.0, fade))) / (spread + 1e-3) + 0.5);
    if (fracLow > 0.0) {
      var x = e0 - (1.0 - g);
      let soft = atmo.cloudLow.z;
      if (k > 0.0 && x > 0.0 && x < soft + k + 0.25) {
        // The detail lookup is warped by the shape noise (wisps that curl instead of a lattice of cells).
        let warp = (vec3f(nb.g, nb.b, nb.a) - 0.5) * (0.22 / atmo.noiseDetail.w);
        let pd = (atmo.noiseDetail.xyz + q + warp + vec3f(0.0, 0.0, atmo.cloudWind.w)) * atmo.noiseDetail.w;
        let nd = textureSampleLevel(cloudDetailNoise, linearRepeat, pd, log2(max(footprint * atmo.noiseDetail.w * 64.0, 1.0)));
        var fbm = nd.r;
        // A finer octave of the same texture for clouds close to the camera (their pixels are metres wide).
        let fine = 1.0 - smoothstep(10.0, 36.0, footprint);
        if (detail > 1 && fine > 0.0) {
          let nf = textureSampleLevel(cloudDetailNoise, linearRepeat, pd * 4.3 + vec3f(0.31, 0.57, 0.83), log2(max(footprint * atmo.noiseDetail.w * 4.3 * 64.0, 1.0)));
          fbm = saturate(fbm + (nf.g - 0.5) * 0.5 * fine);
        }
        // Wispy at the base, billowing towards the top; strongest at the surface, weaker in the core.
        x -= k * mix(1.0 - fbm, fbm, saturate(hl * 5.0)) * (1.0 - 0.6 * saturate((x - k) / 0.25));
      }
      // A crisp edge, then a density that goes on rising towards the core and with height (liquid water
      // content grows upwards in a cumulus).
      let shape = saturate(x / soft) * (0.4 + 0.6 * saturate(x / 0.2)) * mix(0.7, 1.15, hl);
      // Unresolved, the cloudy part of the footprint is the mean cloud: its density, and how many of the
      // cloudy columns reach this height.
      let reach = saturate((col.cLow - (1.0 - g)) / max(col.cLow, 1e-3));
      let dl = mix(shape, 0.62 * reach, fade);
      sigmaLow = atmo.cloudLow.y * col.dens * dl;
      // Vertical optical depths above and below the point, from the height the column's cloud reaches.
      let top = zb + depth * (g0 + (1.0 - g0) * pow(saturate(mix(e0, 0.5 * col.cLow, fade)), 0.6));
      let mean = atmo.cloudLow.y * col.dens * 0.6;
      out.above = mean * max(top - h, 0.0);
      out.below = mean * max(h - zb, 0.0);
      layerLow = max(fade, deck);
    }
  }
  var sigmaUp = 0.0;
  var fracUp = 1.0;
  var layerUp = 1.0;
  if (inUp) {
    // The same construction with shapes two and a half times larger: banks and towers of several kilometres.
    let p2 = pb * 0.37 + vec3f(0.37, 0.11, 0.73);
    let lod2 = max(lodB - 1.43, 0.0);
    let n2s = textureSampleLevel(cloudBaseNoise, linearRepeat, p2, lod2);
    let keep2 = cloudNoiseKeep(lod2);
    let fade2 = mix(1.0, cloudNoiseFade(lod2), keep2);
    let n2 = mix(0.5, n2s.r, keep2);
    let relief = max(col.relief, 1.0);
    let gT = 1.0 - smoothstep(col.upTop - relief, col.upTop, h);
    let gB = smoothstep(col.upBase - 200.0, col.upBase + 200.0, h);
    let gU = gT * gB;
    let coverU = col.amtUp * 1.35;
    let eU = n2 - (1.0 - coverU);
    let spread2 = sqrt(max(1.0 - (1.0 - fade2) * (1.0 - fade2), 0.0));
    fracUp = saturate((eU - 1.35 * (1.0 - mix(gU, step(col.upBase, h), fade2))) / (spread2 + 1e-3) + 0.5);
    if (fracUp > 0.0) {
      var x = eU - 1.35 * (1.0 - gU);
      // Its own, coarser erosion: the fine Worley octaves of the shape lookup (fibres and lumps of a few
      // hundred metres), faded with the footprint like the low layer's.
      let kU = 0.5 * atmo.cloudLow2.z * (1.0 - fade2) * (1.0 - smoothstep(atmo.cloudLow2.w, 4.0 * atmo.cloudLow2.w, footprint));
      x -= kU * (n2s.a - 0.5) * 2.0 * (1.0 - 0.6 * saturate(x / 0.3));
      let softU = 2.5 * atmo.cloudLow.z;
      let shape = saturate(x / softU) * (0.35 + 0.65 * saturate(x / 0.3));
      sigmaUp = col.extUp * mix(shape, 0.6, fade2);
      let mean = col.extUp * 0.6 * col.amtUp;
      out.above += mean * max(col.upTop - 0.5 * relief - h, 0.0);
      out.below += mean * max(h - col.upBase, 0.0) + atmo.cloudLow.y * col.dens * 0.3 * saturate(col.cLow) * max(col.lowTop - zb, 0.0);
      layerUp = mix(saturate(1.0 - relief / 900.0), 1.0, fade2);
    }
  } else if (col.amtUp > 0.0 && h < col.upBase) {
    // Under the upper body: it is part of what lies above.
    out.above += col.extUp * 0.6 * col.amtUp * (col.upTop - col.upBase);
  }
  let sl = sigmaLow * step(1e-6, fracLow);
  let su = sigmaUp * step(1e-6, fracUp);
  out.sigma = sl + su;
  if (out.sigma > 0.0) {
    out.frac = (sl * fracLow + su * fracUp) / out.sigma;
    out.layer = (sl * layerLow + su * layerUp) / out.sigma;
  }
  return out;
}

/// The parts of a camera ray inside the cloud shell, in order of distance, each as (start, end) in metres
/// from the start of the ray's path in the atmosphere, with its kind: 1 = the low shell (from the bottom of
/// the layer to the highest top a low cloud can have: where cumulus live, marched finely), 2 = the shell
/// above it (the upper body: larger shapes, marched coarsely), 0 = none.
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
  let r0 = ray.r;
  let h0 = ray.h;
  let mu = ray.mu;
  let zb = atmo.cloudShell.z;
  let zt = atmo.cloudShell.w;
  // No low cloud is higher than this (see cloudColumnAt).
  let zm = min(zb + atmo.cloudLow.x * 1.8, zt);
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
 * 4 = transmittance, 5 = sky irradiance (texture_2d_array), 6 = cloud shadow moments, 7 = 'scene.depthHalf'.
 * Targets: 0 = rgba16float (rgb = pre-exposed radiance, premultiplied; a = transmittance),
 * 1 = rgba32float cloud geometry along the ray: r = distance where the cloud begins, g = where it ends (or
 * becomes opaque), b = opacity-weighted mean distance; 3.0e38 = no cloud.
 *
 * March. Steps grow with the distance from the eye; the position of the sample inside every step is a
 * blue-noise value of the pixel advanced by a golden-ratio sequence from one march of the pixel to the next
 * (also in deterministic mode: the sequence is a function of the march index, and the resolve averages it
 * away), so that neighbouring rays never share a step pattern: no contour lines, no bars along the rows.
 * A sample that finds cloud after clear air sends the march back to the start of its step with half steps,
 * which it keeps until three samples in a row are clear. When the planned steps run out the remaining
 * steps lengthen, so that every ray reaches the end of its path: opacity does not depend on the budget.
 *
 * Lighting of a sample (per unit of opacity):
 *   sun, low orders   three octaves of the dual-lobe Henyey-Greenstein phase (each wider and weaker), each
 *                     attenuated by the optical depth towards the sun (six cone samples through the cloud,
 *                     then the shadow map / coverage map beyond their reach);
 *   sun, high orders  the diffuse field of the two-stream solution: of the flux that falls on the lit
 *                     boundary, a cloud of optical depth tau returns k tau / (1 + k tau) and passes the
 *                     rest, and the field at a point between the boundaries follows from the optical depth
 *                     towards the light (tauNear) and away from it (tauFar):
 *                       E mu / pi x (1 + k tauFar) x k tau / (1 + k tau)^2,   tau = tauNear + tauFar.
 *                     For a layer (a deck, a sheet, an unresolved field) mu is the sun's zenith cosine and
 *                     tauNear the vertical depth: its brightness falls with the sun. For a shape with sides
 *                     the flux falls on whichever side faces the sun: mu = 1, tauNear = the depth towards
 *                     the sun. Dark flat bases, bright tops and sunward flanks follow from it;
 *   ambient           sky irradiance from above and the sunlit ground from below, each through the cloud
 *                     in between (the same two-stream form).
 * The sun's colour is the transmittance table at the sample (red tops at the terminator).
 *
 * `fine` = true: FOUR rays per FULL-resolution pixel of the rectangle `atmo.tile` (binding 7 =
 * 'scene.depth'; a rotated grid inside the pixel, a different step phase each) into tile targets: the
 * cloud layer of a planet seen from afar (see marchFsWgsl). No temporal filter stands behind this path, so
 * the pixel is anti-aliased here.
 */
export function cloudMarchFsWgsl(fine: boolean): string {
  return /* wgsl */ `
${CLOUD_HEADER}
@group(1) @binding(4) var transLut: texture_2d_array<f32>;
@group(1) @binding(5) var irradianceLut: texture_2d_array<f32>;
@group(1) @binding(6) var atmoShadowTex: texture_2d<f32>;
${fine ? '@group(1) @binding(7) var sceneDepthTex: texture_depth_2d;' : '@group(1) @binding(7) var depthHalfTex: texture_2d<f32>;'}
#include "atmosphere_cloud_shadow"

struct CloudMarchOut {
  @location(0) color: vec4f,
  @location(1) depth: vec4f,
}

const CLOUD_OFFSETS = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 1), vec2i(1, 0), vec2i(0, 1));
// Cumulative fractions of the sun reach at which the six cone samples end.
const CLOUD_CONE = array<f32, 6>(0.02, 0.06, 0.14, 0.3, 0.6, 1.0);
// Sub-pixel positions of the rays of the full-resolution path (rotated grid).
const CLOUD_SUB = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));

fn cloudHg(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
/// Dual-lobe Henyey-Greenstein with both lobes narrowed by 'scale' (the multi-scatter octaves widen them).
fn cloudPhase(c: f32, scale: f32) -> f32 {
  return mix(cloudHg(c, atmo.cloudPhase.y * scale), cloudHg(c, atmo.cloudPhase.x * scale), atmo.cloudPhase.z);
}

/// Number of steps that the rule  dt = clamp(m x factor x t, min, m x max)  takes from distance a to
/// distance b from the eye (m >= 1 = how much the rule is coarsened).
fn cloudStepCount(a: f32, b: f32, m: f32) -> f32 {
  if (b <= a) { return 0.0; }
  let tMin = atmo.cloudMarch.y / (m * atmo.cloudMarch.x);
  let tMax = atmo.cloudMarch.z / atmo.cloudMarch.x;
  var n = max(min(tMin, b) - a, 0.0) / atmo.cloudMarch.y;
  let ga = max(a, tMin);
  let gb = min(b, tMax);
  if (gb > ga) { n += log(gb / ga) / (m * atmo.cloudMarch.x); }
  return n + max(b - max(a, tMax), 0.0) / (m * atmo.cloudMarch.z);
}

struct CloudRay {
  color: vec4f,   // rgb = pre-exposed premultiplied radiance, a = transmittance
  geom: vec3f,    // begin, end, opacity-weighted mean distance from the eye (3.0e38 = no cloud)
}

/// One cloud ray: unit direction d, up to distance tScene from the eye; 'xi' = position of the sample
/// inside each step (0..1), 'pixelAngle' = angle of the pixel the ray stands for (rad).
fn cloudMarchRay(bi: u32, d: vec3f, tScene: f32, xi: f32, pixelAngle: f32) -> CloudRay {
  var o: CloudRay;
  o.color = vec4f(0.0, 0.0, 0.0, 1.0);
  o.geom = vec3f(3.0e38);
  // Everything below is measured along the ray from where it enters the atmosphere shell (the eye when it
  // is inside): altitudes from the stable formula started there are exact to centimetres from any distance.
  let ray = atmoRay(bi, d);
  if (ray.len <= 0.0) { return o; }
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let sMax = min(ray.len, tScene - ray.t0);
  var spans = cloudSpans(ray);
  var total = 0.0;
  for (var k = 0; k < 4; k++) {
    spans.span[k].y = min(spans.span[k].y, sMax);
    total += max(spans.span[k].y - spans.span[k].x, 0.0);
  }
  if (total <= 0.0) { return o; }

  // Steps grow with the distance from the eye (never under the minimum step, capped far away): fine where a
  // cloud fills the view, coarse where it is a few pixels; three times longer in the shell above the low
  // layer, whose shapes are larger. Where that rule would need more steps than the budget (long rays:
  // towards the horizon, inside a deck), the whole rule is coarsened by the factor that makes it fit. A
  // third of the budget is kept for the half steps inside cloud.
  let budget = max(atmo.steps.w, 12.0);
  var coarsen = 1.0;
  for (var i = 0; i < 3; i++) {
    var need = 0.0;
    for (var k = 0; k < 4; k++) {
      let a = ray.t0 + spans.span[k].x;
      let b = ray.t0 + spans.span[k].y;
      if (spans.kind[k] == 1) { need += cloudStepCount(a, b, coarsen); } else if (spans.kind[k] == 2) { need += cloudStepCount(a, b, 3.0 * coarsen); }
    }
    coarsen = max(1.0, coarsen * need / (budget * 0.67));
  }
  let sunDir = frame.bodies[bi].sunDir.xyz;
  let sunNoise = cloudNoiseVec(bi, sunDir);
  let cosTheta = dot(d, sunDir);
  let layerIndex = i32(frame.bodies[bi].fixedX.w);
  let gain = atmo.cloudDeep.w;
  let phase = vec3f(cloudPhase(cosTheta, 1.0), cloudPhase(cosTheta, gain) * gain, cloudPhase(cosTheta, gain * gain) * gain * gain);
  let kd = atmo.cloudLight.y;
  // Below 0.85 of quality scale the eye does without the finest octave of the erosion and the far cone
  // samples are merged. Step sizes, thresholds and opacity are the same at every quality scale.
  var detailEye = 2;
  if (atmo.cloudLight.w < 0.85) { detailEye = 1; }

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
    var inCloud = false;   // the march is inside a cloud: stratified half steps from its surface
    var misses = 0;        // samples in a row that found nothing while inside
    var sClear = s;        // last position known to be clear
    while (s < sEnd && steps < 2.0 * budget + 24.0 && (st.T >= 0.004 || st.cover < 0.98)) {
      var m = coarsen;
      if (!low) { m *= 3.0; }
      // Past the budget the steps lengthen, a quarter more with each: the ray still reaches its end.
      m *= 1.0 + 0.25 * max(steps - budget, 0.0);
      var dt = clamp((ray.t0 + s) * atmo.cloudMarch.x * m, atmo.cloudMarch.y, atmo.cloudMarch.z * m);
      if (inCloud) { dt *= 0.5; }
      dt = min(dt, max(sEnd - s, 1.0));
      // In clear air the sample sits at the pixel's own phase of the step (a thin cloud is met by some
      // marches of the pixel and missed by others, in proportion to its depth); inside a cloud the steps
      // are counted from its surface and sampled at their middle: the same picture from every march.
      var ss = s + dt * xi;
      if (inCloud) { ss = s + 0.5 * dt; }
      steps += 1.0;
      let footprint = (ray.t0 + ss) * pixelAngle;
      let pos = d * (ray.t0 + ss);
      let q = cloudNoiseVec(bi, pos);
      let hS = atmoRayAltitude(ray, ss);
      let col = cloudColumnAt(bi, pos, q, footprint, hS - 0.5 * abs(atmoRayAltitude(ray, s + dt) - atmoRayAltitude(ray, s)));
      let den = cloudDensityAt(col, hS, q, footprint, detailEye);
      if (den.sigma <= 0.0) {
        sClear = ss;
        if (inCloud) {
          misses += 1;
          if (misses >= 2) { inCloud = false; }
        }
        s += dt;
        continue;
      }
      misses = 0;
      if (!inCloud) {
        // Cloud after clear air: its surface is found between the last clear position and this sample by
        // bisection (to a sixteenth of the step), and the march goes on from there. What the cloud returns
        // comes from its first mean free paths: steps that start on the surface split that layer the same
        // way for every ray.
        var lo = sClear;
        var hi = ss;
        for (var i = 0; i < 4; i++) {
          let sm = 0.5 * (lo + hi);
          let dm = cloudDensityAt(col, atmoRayAltitude(ray, sm), cloudNoiseVec(bi, d * (ray.t0 + sm)), footprint, 1);
          if (dm.sigma > 0.0) { hi = sm; } else { lo = sm; }
        }
        inCloud = true;
        // (A field that is only a fraction of the footprint has no surface: the march goes on from the
        // start of the step.)
        s = mix(max(hi - 0.02 * dt, sClear), s, den.layer * den.layer);
        if (steps < budget) { continue; }
      }
      let sIn = s;
      s += dt;
      // Light the step where its opacity sits: the opacity-weighted mean depth behind the step's start (one
      // mean free path into a dense cloud, the middle of a thin one).
      let x = den.sigma * dt;
      let seg = exp(-x);
      var meanDepth = 0.5 - x / 12.0;
      if (x > 0.05) { meanDepth = 1.0 / x - seg / (1.0 - seg); }
      let sl = sIn + dt * meanDepth;
      let hl = atmoRayAltitude(ray, sl);
      let posL = d * (ray.t0 + sl);
      let ql = cloudNoiseVec(bi, posL);
      let up = normalize(posL - frame.bodies[bi].center.xyz);
      let r = rb + hl;
      let muS = dot(up, sunDir);
      var J = vec3f(0.0);
      // A step that adds next to nothing to the pixel (deep inside a cloud already entered) takes the light
      // of the step before it.
      let share = st.T * (1.0 - seg) * den.frac;
      if (haveLight && share < 0.004) {
        J = lastLight;
      } else {
        let vis = atmoSunVisibility(posL, sunDir, bi).x;
        if (vis > 0.0) {
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
            // (The near samples see the billows the eye sees: what shades one side of a bump and not the other.)
            let dj = cloudDensityAt(col, hj, ql + sunNoise * cm, max(footprint, 0.3 * ds), select(0, 1, j < 3));
            tau += dj.sigma * dj.frac * ds;
            cPrev = cNext;
          }
          // Beyond the reach: radius of the end point from the same stable form.
          let qe = 2.0 * r * muS * reach + reach * reach;
          let endR = r + qe / (sqrt(max(r * r + qe, 1.0)) + r);
          let endPos = posL + sunDir * reach;
          tau += atmoCloudTauAt(endPos, bi, normalize(endPos - frame.bodies[bi].center.xyz), endR, muS, 1.0);
          let e = frame.sunIlluminance.rgb * atmosphereSunTransmittance(transLut, bi, r, muS) * vis;
          let lowOrders = phase.x * exp(-tau) + phase.y * exp(-tau * gain) + phase.z * exp(-tau * gain * gain);
          // High orders: the two-stream field (see the header).
          let mu0 = saturate(muS);
          let muE = mix(1.0, mu0, den.layer);
          let tauNear = mix(tau, min(tau * mu0, den.above + 0.5 * x), den.layer);
          let tauFar = den.below;
          let tt = kd * (tauNear + tauFar);
          let highOrders = atmo.cloudLight.x * muE * (1.0 + kd * tauFar) * tt / ((1.0 + tt) * (1.0 + tt) * PI);
          J = e * (lowOrders + highOrders);
        }
        // Ambient: sky from above, the sunlit ground from below (what the clouds of the column leave of
        // it), each through the cloud in between.
        let sky = textureSampleLevel(irradianceLut, linearClamp, skyIrradianceUvFromRMuS(r, muS, rb, rt), layerIndex, 0.0).rgb;
        let groundE = (sky + frame.sunIlluminance.rgb * atmosphereSunTransmittance(transLut, bi, rb, muS) * (max(muS, 0.0) * vis * (1.0 - 0.7 * saturate(col.cLow)))) * atmo.cloudDeep.y;
        let both = 1.0 + kd * (den.above + den.below);
        J += (sky * ((1.0 + kd * den.below) / both) + groundE * ((1.0 + kd * den.above) / both)) * (atmo.cloudDeep.z / PI);
        lastLight = J;
        haveLight = true;
      }

      let before = st.cover * (1.0 - st.T);
      cloudStackStep(&st, den.frac, seg, J);
      let w = st.cover * (1.0 - st.T) - before;
      wSum += w;
      tSum += w * (ray.t0 + sl);
      tFront = min(tFront, ray.t0 + sIn);
      tBack = ray.t0 + s;
    }
  }
  if (wSum <= 1e-5) { return o; }
  var T = 1.0 - st.cover * (1.0 - st.T);
  if (T < 0.004) { T = 0.0; }
  o.color = vec4f(st.L * (st.cover * frame.exposure.x), T);
  o.geom = vec3f(max(tFront, 0.0), tBack, tSum / wSum);
  return o;
}

@fragment fn fs(in: FullscreenOut) -> CloudMarchOut {
  var o: CloudMarchOut;
  o.color = vec4f(0.0, 0.0, 0.0, 1.0);
  o.depth = vec4f(3.0e38, 3.0e38, 3.0e38, 0.0);
  let bi = u32(atmo.bodies.z);
${
  fine
    ? `  let hp = vec2i(in.position.xy) + vec2i(atmo.tile.xy);
  let sceneZ = viewZFromDepth(textureLoad(sceneDepthTex, hp, 0));
  let bn = blueNoise(vec2u(hp)).y;
  var rgb = vec3f(0.0);
  var a = 0.0;
  var front = 3.0e38;
  var back = 0.0;
  var wSum = 0.0;
  var tSum = 0.0;
  for (var k = 0; k < 4; k++) {
    let rayDir = viewRay((vec2f(hp) + 0.5 + CLOUD_SUB[k]) * frame.renderSize.zw);
    let len = length(rayDir);
    let ray = cloudMarchRay(bi, rayDir / len, sceneZ * len, fract(bn + f32(k) * 0.61803398875), 0.5 * atmo.cloudMarch.w);
    rgb += ray.color.rgb * 0.25;
    a += ray.color.a * 0.25;
    if (ray.geom.b < 1.0e37) {
      let w = 1.0 - ray.color.a;
      front = min(front, ray.geom.r);
      back = max(back, ray.geom.g);
      wSum += w;
      tSum += w * ray.geom.b;
    }
  }
  o.color = vec4f(writeHdr(rgb), a);
  if (wSum > 1e-5) { o.depth = vec4f(front, back, tSum / wSum, 0.0); }`
    : `  let hp = min(vec2i(in.position.xy) * 2 + CLOUD_OFFSETS[atmo.layers.w], vec2i(atmo.halfSize.xy) - 1);
  let rayDir = cloudViewRay((vec2f(hp) + 0.5 + atmo.cloudJitter.xy) * atmo.halfSize.zw);
  let sceneZ = viewZFromDepth(textureLoad(depthHalfTex, hp, 0).r);
  let len = length(rayDir);
  // Step phase: a blue-noise value of the pixel, advanced by the golden ratio with every march of the pixel.
  let xi = fract(blueNoise(vec2u(hp)).y + atmo.cloudJitter.z);
  let ray = cloudMarchRay(bi, rayDir / len, sceneZ * len, xi, atmo.cloudMarch.w);
  o.color = vec4f(writeHdr(ray.color.rgb), ray.color.a);
  if (ray.geom.b < 1.0e37) { o.depth = vec4f(ray.geom, 0.0); }`
}
  return o;
}
`;
}

/**
 * Temporal checkerboard resolve to the half-resolution cloud buffers. Bindings (group 1): 0 = AtmoU,
 * 1 = fresh radiance (quarter area), 2 = fresh cloud geometry, 3 = history radiance, 4 = history geometry.
 * Targets: 0 = 'clouds.screen' (rgba16float), 1 = 'clouds.depth' (rg32float: where the cloud begins and
 * ends), 2 = cloud geometry (rgba32float: begin, end, mean distance; a = number of marches of the pixel
 * that its radiance averages), which the atmosphere march and the next frame's resolve read, 3 = the
 * radiance again, into the history target of the next frame (the geometry and history targets alternate
 * between two textures each; nothing is copied after the pass).
 *
 * A pixel is marched every fourth frame, each time through another point of its area and at another step
 * phase. While it stands still its radiance is the running mean of its marches (weight 1 / n, n up to
 * `atmo.misc.z`): the four pixels of a block, marched in different frames, converge on the same picture.
 * A pixel that moves follows its newest march, one that jumped (a cut) starts again, and when the light
 * changes (the sun moves under time warp, an eclipse begins) `atmo.misc.w` bounds the weight from below so
 * that the history follows within a few marches.
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
  @location(3) history: vec4f,
}

const CLOUD_OFFSETS = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 1), vec2i(1, 0), vec2i(0, 1));
const NO_CLOUD = vec3f(3.0e38, 3.0e38, 3.0e38);

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
  var nearGeom = NO_CLOUD;
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
  var count = 0.0;
  if (isFresh) {
    color = fresh;
    geom = textureLoad(freshGeomTex, qp, 0).rgb;
    count = 1.0;
  }
  var hg = NO_CLOUD;   // the geometry this pixel had in the previous frame
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
    // (The border texels have a history like every other: the lookup is clamped to the texel centres.)
    if (clip.w > 0.0 && all(uvPrev > vec2f(0.0)) && all(uvPrev < vec2f(1.0))) {
      var hist = textureSampleLevel(historyTex, linearClamp, uvPrev, 0.0);
      hist = vec4f(hist.rgb * atmo.misc.x, hist.a);
      // Neighbourhood clamp against the fresh samples: what rejects stale history when the view moves.
      // The fresh samples are sparse (one per 2 x 2 block), so the clamp also cuts real detail between them:
      // it is applied in proportion to the motion of the pixel since the last frame and not at all to a
      // pixel that has not moved, whose history is its own march of a few frames ago.
      let motion = length((uvPrev - (vec2f(hp) + 0.5) * atmo.halfSize.zw) * atmo.halfSize.xy);
      let slack = (hi - lo) * 0.08 + vec4f(1e-4);
      let clamped = mix(hist, clamp(hist, lo - slack, hi + slack), saturate(motion * 4.0 - 0.1));
      let h4 = textureLoad(historyGeomTex, clamp(vec2i(uvPrev * atmo.halfSize.xy), vec2i(0), vec2i(atmo.halfSize.xy) - 1), 0);
      hg = h4.rgb;
      // How many marches the history stands for: all of them while the pixel is still, fewer the faster it
      // moves, none after a jump; never more than the light allows.
      let cut = saturate((motion - 8.0) / 8.0);
      let kept = min(h4.a * (1.0 - saturate(motion * 2.0)) * (1.0 - cut), 1.0 / max(atmo.misc.w, 1e-3) - 1.0);
      if (isFresh) {
        color = mix(clamped, fresh, max(1.0 / (kept + 1.0), cut));
        count = min(kept + 1.0, atmo.misc.z);
      } else {
        color = mix(clamped, est, max(cut, select(0.0, 1.0, h4.a < 0.5)));
        count = min(h4.a, 1.0 / max(atmo.misc.w, 1e-3) - 1.0) * (1.0 - cut);
        // The geometry too is the pixel's own, of its march up to three frames ago, while it has not moved:
        // the distance of a cloud decides how much air is drawn in front of it, and a distance borrowed
        // from a neighbouring ray (which may have hit a cloud a hundred kilometres nearer) shows as blocks
        // and bars wherever cloud layers are seen edge-on. With motion the estimate from this frame's
        // samples takes over.
        let still = motion < 0.15;
        if (still && h4.a >= 0.5) {
          geom = hg;
        } else if (geomNow.b > 1.0e37 && hg.b < 1.0e37 && clamped.a < 0.999) {
          geom = hg;
        }
      }
    }
  }
  // An edge that the sub-pixel positions of the rays straddle: the newest march of the pixel found no cloud
  // while its averaged radiance still holds some. The cloud is then where this pixel last had it, or where
  // its neighbours have it (without a distance it would be drawn behind all the air of the path).
  if (geom.b > 1.0e37 && color.a < 0.999) {
    if (hg.b < 1.0e37) { geom = hg; } else if (geomNow.b < 1.0e37) { geom = geomNow; }
  }
  var o: ResolveOut;
  o.color = vec4f(writeHdr(color.rgb), saturate(color.a));
  if (o.color.a > 0.9995 || geom.b > 1.0e37) {
    // No cloud: no radiance either (the two buffers never disagree about whether there is one).
    o.color = vec4f(0.0, 0.0, 0.0, 1.0);
    o.geom = vec4f(NO_CLOUD, count);
    o.depth = vec4f(3.0e38, 3.0e38, 0.0, 0.0);
  } else {
    o.geom = vec4f(geom, count);
    o.depth = vec4f(geom.r, max(geom.g, geom.r), 0.0, 0.0);
  }
  o.history = o.color;
  return o;
}
`;

/**
 * Near-field cloud shadow map: orthographic along the projection direction (the sun's, kept a few degrees
 * above the horizon of the map centre). Two targets per texel, for the line through it:
 *   0 ('clouds.shadowMap', the render core's deferred lighting):
 *       r = optical depth of the whole cloud layer along the line AS THE GROUND SEES IT: of the light a
 *           cloud takes out of the direct beam, part comes down diffusely; r is -log of the share of the
 *           sun's illuminance that arrives either way (two-stream), so that the ground under an overcast
 *           is dim, not black;
 *       g = distance along the line (from the map plane, towards the sun) where the cloud begins,
 *       b = r / depth of the cloud along the line (1 / m),
 *       a = the direct beam's own optical depth divided by r (>= 1).
 *     A point at distance s along its line has  tau = clamp((g - s) b, 0, r)  between it and the sun.
 *   1 (the package's own lookups: clouds, air, aerial volume): moments of the extinction over altitude,
 *       r = optical depth of the direct beam, g = r x mean altitude, b = r x mean squared altitude
 *       (altitudes as fractions of the cloud shell). Unlike a front distance these interpolate: a bilinear
 *       lookup between a cloudy and a clear texel is a thinner cloud at the same height, not a ramp.
 * The line is marched in two parts (the low shell with two thirds of the steps, the shell above it with the
 * rest); the number of steps grows as the sun gets low and the share of texels refreshed per frame falls
 * with it (a sixteenth to a sixty-fourth). `inPlace` = true: the pass draws into the maps themselves and
 * leaves the other texels as they are. `inPlace` = false: the map origin has moved by whole texels; the
 * pass draws into scratch targets, taking the other texels from the maps at that shift (bindings 4, 5), and
 * CLOUD_SHADOW_BLIT_FS_WGSL writes the scratch targets back.
 * Bindings (group 1): 0 = AtmoU, 1 = coverage, 2 = base noise, 3 = detail noise.
 */
export function cloudShadowFsWgsl(inPlace: boolean): string {
  return /* wgsl */ `
${CLOUD_HEADER}
${inPlace ? '' : '@group(1) @binding(4) var prevTex: texture_2d<f32>;\n@group(1) @binding(5) var prevMomentTex: texture_2d<f32>;'}

const CLOUD_FILL = 0.08;

struct ShadowOut {
  @location(0) core: vec4f,
  @location(1) moments: vec4f,
}

@fragment fn fs(in: FullscreenOut) -> ShadowOut {
  let pix = vec2i(in.position.xy);
  let n = i32(atmo.shadowShift.w);
  let phase = i32(atmo.shadowShift.z);
  // One texel of every 4 x 4 block per frame, in an order that spreads successive frames over the block;
  // with a longer period, only every second or fourth block (diagonals) per round.
  let order = array<i32, 16>(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  let rounds = i32(atmo.shadowFilter.z);
  let mine = order[(pix.x & 3) + 4 * (pix.y & 3)] == (phase & 15) && (((pix.x >> 2u) + (pix.y >> 2u)) % rounds) == (phase >> 4u);
  var o: ShadowOut;
  if (!mine && atmo.shadowL.w > 0.5) {
${
  inPlace
    ? '    discard;'
    : `    let src = pix + vec2i(atmo.shadowShift.xy);
    if (all(src >= vec2i(0)) && all(src < vec2i(n))) {
      o.core = textureLoad(prevTex, src, 0);
      o.moments = textureLoad(prevMomentTex, src, 0);
      return o;
    }`
}
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
  let zb = atmo.cloudShell.z;
  let zt = atmo.cloudShell.w;
  let rTop = atmo.cloudShell.y;
  let rBot = atmo.cloudShell.x;
  let rMid = rBot + min(atmo.cloudLow.x * 1.8, zt - zb);
  o.core = vec4f(0.0, -3.0e30, 0.0, 1.0);
  o.moments = vec4f(0.0);
  let discTop = b * b - (dist - rTop) * (dist + rTop);
  if (discTop <= 0.0) { return o; }
  let sTop = -b + sqrt(discTop);
  // The sun-side crossing of the layer: from where the line leaves the bottom sphere (or from its perigee
  // when it passes above the bottom) to where it leaves the top; the low shell ends at the middle sphere.
  let discBot = b * b - (dist - rBot) * (dist + rBot);
  var sBot = -b;
  if (discBot > 0.0) { sBot = -b + sqrt(discBot); }
  let discMid = b * b - (dist - rMid) * (dist + rMid);
  var sMid = sBot;
  if (discMid > 0.0) { sMid = clamp(-b + sqrt(discMid), sBot, sTop); }
  let count = max(i32(atmo.shadowU.w), 6);
  var nLow = (count * 2) / 3;
  if (sMid <= sBot + 1.0) { nLow = 0; }
  let nUp = count - nLow;
  let rb = frame.bodies[bi].center.w;
  var tau = 0.0;
  var m1 = 0.0;
  var m2 = 0.0;
  var sFront = sBot;
  var sBack = sTop;
  var found = false;
  for (var i = 0; i < count; i++) {
    // From the sun side downwards: first the upper shell, then the low one.
    var ds = (sTop - sMid) / f32(max(nUp, 1));
    var s = sTop - (f32(i) + 0.5) * ds;
    if (i >= nUp) {
      ds = (sMid - sBot) / f32(max(nLow, 1));
      s = sMid - (f32(i - nUp) + 0.5) * ds;
    }
    let pos = p0 + dir * s;
    let h = length(pos - frame.bodies[bi].center.xyz) - rb;
    let q = cloudNoiseVec(bi, pos);
    // (Band-limited to what the screen resolves and to what the steps can carry: a map finer than the
    // pixels that read it, or than its own sampling along the line, would alias.)
    let fp = max(max(texel, atmo.shadowFilter.x), 0.3 * ds);
    let col = cloudColumnAt(bi, pos, q, fp, h - 0.5 * ds * atmo.shadowV.w);
    let den = cloudDensityAt(col, h, q, fp, 0);
    if (den.sigma > 0.0) {
      // The footprint's mean transmittance over the step (fractional cover included), as an optical depth.
      let dtau = -log(max(1.0 - den.frac * (1.0 - exp(-den.sigma * ds)), 1e-9));
      let hn = saturate((h - zb) / (zt - zb));
      tau += dtau;
      m1 += dtau * hn;
      m2 += dtau * hn * hn;
      if (!found) { sFront = s + 0.5 * ds; found = true; }
      sBack = s - 0.5 * ds;
    }
  }
  // (Clear: no extinction. The front distance of such a texel only matters when a lookup interpolates it
  // with a cloudy neighbour: the top of the layer stands in for it, which keeps that blend smooth.)
  o.core = vec4f(0.0, sTop, 0.0, 1.0);
  if (!found) { return o; }
  tau = min(tau, 400.0);
  // What reaches the ground in a cloud's shadow: the diffusely transmitted light (two-stream), and what the
  // lit sides of the clouds around send into it (CLOUD_FILL of the sun's illuminance: the diffuse light under
  // a sky with clouds is brighter and whiter than under a clear one).
  let kd = atmo.cloudLight.y;
  let direct = exp(-tau);
  let total = direct + (1.0 - direct) * (1.0 / (1.0 + kd * tau) + CLOUD_FILL);
  let tauGround = -log(max(total, 1e-9));
  o.core = vec4f(tauGround, sFront, tauGround / max(sFront - sBack, 50.0), tau / max(tauGround, 1e-6));
  let scale = min(tau, 60.0) / max(tau, 1e-6);
  o.moments = vec4f(tau * scale, m1 * scale, m2 * scale, 1.0);
  return o;
}
`;
}

/** Writes the scratch targets of the shifted shadow pass back into the maps. Bindings (group 1): 0, 1 = scratch. */
export const CLOUD_SHADOW_BLIT_FS_WGSL = /* wgsl */ `
@group(1) @binding(0) var srcTex: texture_2d<f32>;
@group(1) @binding(1) var srcMomentTex: texture_2d<f32>;
struct BlitOut {
  @location(0) core: vec4f,
  @location(1) moments: vec4f,
}
@fragment fn fs(in: FullscreenOut) -> BlitOut {
  let p = vec2i(in.position.xy);
  return BlitOut(textureLoad(srcTex, p, 0), textureLoad(srcMomentTex, p, 0));
}
`;

/** One level of the moment map from the level before it: the mean of 2 x 2 texels. Binding (group 1): 0 = that level. */
export const CLOUD_SHADOW_MIP_FS_WGSL = /* wgsl */ `
@group(1) @binding(0) var srcTex: texture_2d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, linearClamp, in.uv, 0.0);
}
`;

/**
 * One-off noise generation (compute). Group 0: binding 0 = output (texture_storage_3d rgba16float),
 * binding 1 = uniform (x = resolution, y = 0 base / 1 detail).
 *   base (128^3):  r = the shape noise: Perlin-Worley (a Perlin fBm dilated by Worley cells) eroded by a
 *                      Worley fBm of three higher octaves: connected billowing bodies,
 *                  g = Worley fBm, 4 / 8 / 16 cells per tile (mesoscale cells),
 *                  b = smooth Perlin fBm (weather scale, warp),
 *                  a = Worley fBm, 10 / 20 / 40 cells per tile (fine cells, fibres)
 *   detail (64^3): r = Worley fBm, 3 / 6 / 12 cells per tile, g = Worley fBm, 5 / 10 / 20 cells per tile
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
    let pf = saturate(perlinFbm(p, 3, 5, 11) * 0.75 + 0.5);
    let wf = worleyFbm(p, 3, 31);
    // Perlin-Worley: the Perlin field dilated by the inverted Worley cells (billows that stay connected),
    // then eroded by three higher Worley octaves (the cauliflower).
    let pw = saturate((pf - (wf - 1.0)) / (2.0 - wf));
    let hf = worleyFbm(p, 6, 211) * 0.6 + worleyFbm(p, 12, 223) * 0.4;
    v.r = saturate((pw - (1.0 - hf) * 0.55) / (1.0 - (1.0 - hf) * 0.55));
    v.g = worleyFbm(p, 4, 57);
    v.b = saturate(perlinFbm(p, 3, 4, 83) * 0.8 + 0.5);
    v.a = worleyFbm(p, 10, 101);
  } else {
    v.r = worleyFbm(p, 3, 131);
    v.g = worleyFbm(p, 5, 151);
    v.b = worley(p * 8.0, 8, 173);
    v.a = 1.0;
  }
  textureStore(outTex, id, v);
}
`;
