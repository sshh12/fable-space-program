/**
 * WGSL of the sky feature. Every HDR write goes through writeHdr(); luminance is cd/m^2 times
 * frame.exposure.x. Formulas mirror photometry.ts (unit-tested there).
 *
 *   SKY_COMMON        uniforms shared by the background passes, scintillation, Chapman air mass
 *   BACKGROUND_FS     Milky Way cube + analytic solar disc (fullscreen, depth == 0 only, additive)
 *   STARS             catalogue stars as instanced Gaussian PSF quads (depth == 0 only, additive)
 *   IMPOSTOR          distant bodies under 6 px: PSF blob cross-faded over their geometry (transparent stage)
 *   FLARE_VIS_CS      fraction of the solar disc visible through 'scene.depth' x 'clouds.screen'.a (compute)
 *   FLARE             starburst, glare halo and chromatic ghosts (transparent stage, additive)
 *   PROBE_*           the analytic environment probe: face evaluation, mip chain, SH9 projection, GGX
 *                     prefilter, temporal blend into the published cube and SH buffer
 */
import { FLARE_HALO_SHARE, HALO_POWER, SPIKE_LAMBDA } from './flare';
import { IMPOSTOR_FULL_PX, IMPOSTOR_NONE_PX, SCINTILLATION_ZENITH_VARIANCE, STAR_PSF_SIGMA_PX } from './photometry';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

export const SKY_COMMON_WGSL = /* wgsl */ `
const STAR_SIGMA_PX = ${f(STAR_PSF_SIGMA_PX)};
const SCINT_ZENITH = ${f(SCINTILLATION_ZENITH_VARIANCE)};
struct SkyUniforms {
  mw: vec4f,        // x = Milky Way cd/m^2 per stored unit, y = 1 when the cube is loaded, z = 1 = draw the sun disc, w = 1 = draw stars
  limb: vec4f,      // rgb = linear limb-darkening coefficients u, a = 1 / (pi sin^2 theta_sun)
  scint: vec4f,     // x = 1 when the camera is inside an atmosphere, y = camera altitude (m), z = scale height (m), w = (R + h) / H
  scintUp: vec4f,   // xyz = local vertical at the camera (ROOT), w = scintillation clock (s; frozen when frame.time.w == 0)
  px: vec4f,        // x = solid angle of a pixel on the view axis (sr), y = star quad half size (px), z = pixel angle on the axis (rad), w = 0
}
@group(1) @binding(0) var<uniform> sky: SkyUniforms;

/// e^(y^2) erfc(y), y >= 0 (photometry.ts erfcx: asymptotic series above 3, Abramowitz & Stegun 7.1.26 below).
fn erfcx(y: f32) -> f32 {
  if (y >= 3.0) {
    let r = 1.0 / (y * y);
    return (1.0 - 0.5 * r + 0.75 * r * r - 1.875 * r * r * r) / (1.7724539 * y);
  }
  let t = 1.0 / (1.0 + 0.3275911 * y);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
}
/// Chapman function: slant column / vertical column for x = r / H, mu = cos(zenith angle) >= 0.
fn chapman(x: f32, mu: f32) -> f32 { return sqrt(PI * 0.5 * x) * erfcx(max(mu, 0.0) * sqrt(0.5 * x)); }

/// Unit-variance, smoothly varying noise in time for one star and channel (hashed Gaussians interpolated).
fn starNoise(star: u32, t: f32, channel: i32) -> f32 {
  let k = floor(t);
  let w = smoothstep(0.0, 1.0, t - k);
  let ki = i32(k);
  var g0 = 0.0;
  var g1 = 0.0;
  for (var i = 0; i < 4; i++) {
    g0 += hash_to_unit(hash4(i32(star), ki, channel, i));
    g1 += hash_to_unit(hash4(i32(star), ki + 1, channel, i));
  }
  // Irwin-Hall(4) - 2 has variance 1/3; the interpolation of two independent values is renormalised.
  let a = (g0 - 2.0) * 1.7320508;
  let b = (g1 - 2.0) * 1.7320508;
  return (a * (1.0 - w) + b * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
}

/// Mean-preserving log-normal intensity factor of a star seen through turbulent air (photometry.ts
/// scintillationVariance): sigma_I^2 = s / (1 + s), s = S0 X^(11/6) e^(-h/H). Colours decorrelate near the horizon.
fn scintillation(dir: vec3f, star: u32) -> vec3f {
  if (sky.scint.x < 0.5) { return vec3f(1.0); }
  let mu = dot(dir, sky.scintUp.xyz);
  if (mu < -0.02) { return vec3f(1.0); }
  let X = chapman(sky.scint.w, mu);
  let s = SCINT_ZENITH * pow(X, 11.0 / 6.0) * exp(-max(sky.scint.y, 0.0) / sky.scint.z);
  let v = s / (1.0 + s);
  let sl2 = log(1.0 + v);
  let sl = sqrt(sl2);
  // Twinkling has most of its power at a few to tens of Hz; 6 Hz survives the TAA history.
  let t = sky.scintUp.w * 6.0;
  let gAll = starNoise(star, t, 0);
  let rho = exp(-X / 8.0);
  let q = sqrt(max(1.0 - rho * rho, 0.0));
  let g = vec3f(gAll) * rho + vec3f(starNoise(star, t, 1), starNoise(star, t, 2), starNoise(star, t, 3)) * q;
  return exp(g * sl - vec3f(0.5 * sl2));
}
`;

/** Milky Way + solar disc, one fullscreen triangle at clip z = 0 with depthCompare 'equal' (sky pixels only). */
export const BACKGROUND_FS = /* wgsl */ `
#include "hash"
${SKY_COMMON_WGSL}
@group(1) @binding(1) var milkyWay: texture_cube<f32>;

/// Solar disc of angular radius frame.sunDir.w with per-channel linear limb darkening; the edge is
/// anti-aliased by the pixel footprint. A disc smaller than one pixel becomes a Gaussian of the same flux.
fn sunDisc(dir: vec3f) -> vec3f {
  let s = frame.sunDir.xyz;
  let rs = frame.sunDir.w;
  if (frame.sunIlluminance.a <= 0.0 || rs <= 0.0) { return vec3f(0.0); }
  let c = max(dot(dir, frame.cameraForward.xyz), 0.05);
  let pa = sky.px.z * pow(c, 1.5);
  let theta = atan2(length(cross(dir, s)), dot(dir, s));
  let rpx = rs / pa;
  if (rpx < 1.0) {
    let sigma = sqrt(STAR_SIGMA_PX * STAR_SIGMA_PX + 0.25 * rpx * rpx) * pa;
    if (theta > 5.0 * sigma) { return vec3f(0.0); }
    return frame.sunIlluminance.rgb * exp(-0.5 * theta * theta / (sigma * sigma)) / (TWO_PI * sigma * sigma);
  }
  if (theta > rs + pa) { return vec3f(0.0); }
  let t = min(theta / rs, 1.0);
  let mu = sqrt(max(1.0 - t * t, 0.0));
  let u = sky.limb.rgb;
  let centre = frame.sunIlluminance.rgb * sky.limb.a / (vec3f(1.0) - u / 3.0);
  let coverage = saturate((rs - theta) / pa + 0.5);
  return centre * (vec3f(1.0) - u * (1.0 - mu)) * coverage;
}

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let dir = normalize(viewRay(in.uv));
  var L = vec3f(0.0);
  if (sky.mw.y > 0.5) { L += textureSample(milkyWay, linearClamp, dir).rgb * sky.mw.x; }
  if (sky.mw.z > 0.5) { L += sunDisc(dir); }
  return vec4f(writeHdr(L * frame.exposure.x), 1.0);
}
`;

/** Catalogue stars: 4-vertex triangle strips, one instance per star, at clip z = 0 (depth == 0 only). */
export const STARS_WGSL = /* wgsl */ `
#include "frame"
#include "hash"
${SKY_COMMON_WGSL}
struct StarIn {
  @location(0) dirLux: vec4f,       // unit direction (ROOT), illuminance at the observer (lux)
  @location(1) colourMag: vec4f,    // linear-sRGB colour with luminance 1, V magnitude
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
}
struct StarOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,                      // pixel offset from the projected (jittered) centre
  @location(1) @interpolate(flat) peak: vec3f,       // pre-exposed peak luminance of the Gaussian
}
@vertex fn vs(in: StarIn) -> StarOut {
  var o: StarOut;
  let dir = in.dirLux.xyz;
  let clip = frame.viewProj * vec4f(dir, 0.0);
  let cosOff = dot(dir, frame.cameraForward.xyz);
  if (clip.w <= 1e-6 || cosOff <= 0.0 || sky.mw.w < 0.5) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    o.offsetPx = vec2f(0.0);
    o.peak = vec3f(0.0);
    return o;
  }
  let corner = vec2f(f32(in.vi & 1u), f32(in.vi >> 1u)) * 2.0 - 1.0;
  let off = corner * sky.px.y;
  // Pixels -> NDC (y down in pixels, up in NDC). All four corners share clip.w, so offsetPx interpolates linearly.
  o.pos = vec4f(clip.xy + off * vec2f(2.0, -2.0) * frame.renderSize.zw * clip.w, 0.0, clip.w);
  o.offsetPx = off;
  // Pixel solid angle along this direction (pinhole: on-axis value x cos^3), Gaussian normalisation 2 pi sigma^2.
  let omega = sky.px.x * cosOff * cosOff * cosOff;
  let e = in.dirLux.w * scintillation(dir, in.ii);
  o.peak = in.colourMag.rgb * e / (omega * TWO_PI * STAR_SIGMA_PX * STAR_SIGMA_PX) * frame.exposure.x;
  return o;
}
@fragment fn fs(in: StarOut) -> @location(0) vec4f {
  let g = exp(-0.5 * dot(in.offsetPx, in.offsetPx) / (STAR_SIGMA_PX * STAR_SIGMA_PX));
  return vec4f(writeHdr(in.peak * g), 1.0);
}
`;

/**
 * Distant bodies: a Gaussian blob of the body's phase-integrated flux (computed on the CPU, Lambert sphere),
 * drawn in the transparent stage so that it can replace the body's own geometry pixels: on a pixel whose
 * depth belongs to the body the blend is (1 - w) x geometry + w x impostor, elsewhere the blob is added.
 */
export const IMPOSTOR_WGSL = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "transparency"
${bindings}
const IMPOSTOR_FULL_PX = ${f(IMPOSTOR_FULL_PX)};
const IMPOSTOR_NONE_PX = ${f(IMPOSTOR_NONE_PX)};
struct Impostor {
  centre: vec4f,     // xyz = body centre relative to the camera (ROOT, m), w = radius (m)
  flux: vec4f,       // rgb = illuminance at the camera (lux, colour x lux), a = weight w (1 below 3 px, 0 above 6 px)
  shape: vec4f,      // x = Gaussian sigma (px), y = quad half size (px), z = distance to the near side (m), w = 1 / pixel solid angle on the axis
}
struct Impostors { count: vec4u, list: array<Impostor, 16> }
@group(2) @binding(0) var<uniform> impostors: Impostors;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,
  @location(1) @interpolate(flat) index: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let im = impostors.list[ii];
  let d = length(im.centre.xyz);
  let dir = im.centre.xyz / d;
  // Clip position of the near side of the body: its depth is what the geometry pixels of the body hold.
  let clip = frame.viewProj * vec4f(dir * im.shape.z, 1.0);
  o.index = ii;
  if (clip.w <= 0.0) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    o.offsetPx = vec2f(0.0);
    return o;
  }
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let off = corner * im.shape.y;
  o.pos = vec4f(clip.xy + off * vec2f(2.0, -2.0) * frame.renderSize.zw * clip.w, clip.z, clip.w);
  o.offsetPx = off;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let im = impostors.list[in.index];
  let pix = vec2i(in.pos.xy);
  let uv = in.pos.xy * frame.renderSize.zw;
  // Does this pixel show the body's own geometry? (scene depth within the body's sphere)
  let depth = textureLoad(sceneDepthTex, pix, 0);
  var alpha = 0.0;
  if (depth > 0.0) {
    let p = positionFromDepth(uv, depth);
    if (distance(p, im.centre.xyz) < im.centre.w * 1.02 + 2e-6 * length(im.centre.xyz)) { alpha = im.flux.a; }
  }
  let dir = normalize(viewRay(uv));
  let cosOff = max(dot(dir, frame.cameraForward.xyz), 1e-3);
  let sigma = im.shape.x;
  let g = exp(-0.5 * dot(in.offsetPx, in.offsetPx) / (sigma * sigma)) / (TWO_PI * sigma * sigma);
  let lum = im.flux.rgb * g * im.shape.w / (cosOff * cosOff * cosOff);
  let c = applyAtmosphere(uv, im.shape.z, lum * im.flux.a * frame.exposure.x, alpha);
  return vec4f(writeHdr(c.rgb), c.a);
}
`;

/**
 * Visible fraction of the solar disc: 64 Vogel-disc samples of 'scene.depth' over the disc (a sample outside
 * the render target counts as hidden), times the cloud transmittance 'clouds.screen'.a at the sun's
 * position where a cloud lies in front ('clouds.depth' < 3e38), times the atmosphere's transmittance towards
 * the sun at the camera. Written to a storage buffer read by the flare shaders (no CPU readback).
 */
export const FLARE_VIS_CS = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "atmosphere_common"
${bindings}
struct FlareVisParams { atmo: vec4f }   // x = frame body index of the camera's atmosphere (-1 none), y = camera radius (m), z = mu of the sun there
struct FlareState { visible: vec4f, transmittance: vec4f }  // visible.x = disc fraction, .y = cloud transmittance, .z = on-screen samples; transmittance.rgb
@group(2) @binding(0) var<uniform> visParams: FlareVisParams;
@group(2) @binding(1) var<storage, read_write> flareState: FlareState;
var<workgroup> hits: array<f32, 64>;

@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) {
  let s = frame.sunDir.xyz;
  let rs = frame.sunDir.w;
  // Orthonormal basis around the sun direction.
  let a = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(s.z) > 0.9);
  let e1 = normalize(cross(s, a));
  let e2 = cross(s, e1);
  let k = f32(li) + 0.5;
  let r = sqrt(k / 64.0) * rs;
  let phi = f32(li) * 2.39996323;
  let d = normalize(s + (e1 * cos(phi) + e2 * sin(phi)) * tan(r));
  let c = frame.viewProjUnjittered * vec4f(d, 0.0);
  var h = 0.0;
  if (c.w > 0.0) {
    let ndc = c.xy / c.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let size = vec2f(textureDimensions(sceneDepthTex));
      let depth = textureLoad(sceneDepthTex, vec2i(uv * size), 0);
      h = select(0.0, 1.0, depth == 0.0);
    }
  }
  hits[li] = h;
  workgroupBarrier();
  if (li == 0u) {
    var sum = 0.0;
    for (var i = 0u; i < 64u; i++) { sum += hits[i]; }
    var cloud = 1.0;
    var inView = 0.0;
    let cc = frame.viewProjUnjittered * vec4f(s, 0.0);
    if (cc.w > 0.0) {
      let ndc = cc.xy / cc.w;
      let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
      if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
        inView = 1.0;
        let cs = vec2i(textureDimensions(cloudsScreenTex));
        let q = clamp(vec2i(uv * vec2f(cs)), vec2i(0), cs - 1);
        if (textureLoad(cloudsDepthTex, q, 0).r < 3.0e38) { cloud = textureLoad(cloudsScreenTex, q, 0).a; }
      }
    }
    var t = vec3f(1.0);
    let bi = i32(visParams.atmo.x);
    if (bi >= 0) { t = atmosphereSunTransmittance(transmittanceLut, u32(bi), visParams.atmo.y, visParams.atmo.z); }
    flareState.visible = vec4f(sum / 64.0, saturate(cloud), inView, 0.0);
    flareState.transmittance = vec4f(t, 1.0);
  }
}
`;

/**
 * Lens flare in the transparent stage. Instance 0 = starburst + glare halo around the sun (6 diffraction
 * spikes of a hexagonal aperture, chromatic: spike length scales with wavelength), instances 1.. = ghosts
 * (soft discs on the line from the sun through the image centre). Each term's angular profile is normalised
 * on the CPU so its luminance integrates to `energy` x the illuminance at the lens; the sum is under 1 %.
 * Additive (alpha 0); applyAtmosphere at distance 0 is exactly neutral: the flare forms inside the lens.
 */
export const FLARE_WGSL = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "transparency"
${bindings}
const FLARE_HALO_SHARE = ${f(FLARE_HALO_SHARE)};
const FLARE_HALO_POWER = ${f(HALO_POWER)};
const SPIKE_LAMBDA = vec3f(${SPIKE_LAMBDA.map(f).join(', ')});
struct FlareState { visible: vec4f, transmittance: vec4f }
struct FlareTerm {
  pos: vec4f,     // xy = centre in NDC (ghosts) or unused (starburst: the sun), z = radius (rad, ghosts) / spike length scale (rad), w = kind (0 starburst, 1 ghost)
  tint: vec4f,    // rgb = relative colour (luminance 1), a = energy fraction of the source
  shape: vec4f,   // starburst: x = halo core (rad), y = halo norm (1/sr), z = spike width (rad), w = spike norm (1/sr); ghost: x = edge softness, y = disc norm (1/sr), z = chroma shift
  quad: vec4f,    // xy = quad half size in NDC
}
struct FlareUniforms { count: vec4u, sunNdc: vec4f, terms: array<FlareTerm, 8> }
@group(2) @binding(0) var<uniform> flare: FlareUniforms;
@group(2) @binding(1) var<storage, read> flareState: FlareState;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) index: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let t = flare.terms[ii];
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  var centre = t.pos.xy;
  if (t.pos.w < 0.5) { centre = flare.sunNdc.xy; }
  let p = centre + corner * t.quad.xy;
  o.pos = vec4f(p, 0.0, 1.0);
  o.index = ii;
  return o;
}

/// Unit view ray through an unjittered NDC point.
fn ndcRay(n: vec2f) -> vec3f {
  return normalize(frame.cameraForward.xyz + frame.cameraRight.xyz * (n.x * frame.cameraRight.w) + frame.cameraUp.xyz * (n.y * frame.cameraUp.w));
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let st = flareState;
  let source = frame.sunIlluminance.rgb * st.transmittance.rgb * (st.visible.x * st.visible.y);
  if (dot(source, source) <= 0.0) { discard; }
  let t = flare.terms[in.index];
  // The ray this (jittered) pixel samples, as for the scene behind it.
  let uv = in.pos.xy * frame.renderSize.zw;
  let dir = normalize(viewRay(uv));
  var L = vec3f(0.0);
  if (t.pos.w < 0.5) {
    // Starburst + glare around the sun direction.
    let s = frame.sunDir.xyz;
    let theta = atan2(length(cross(dir, s)), dot(dir, s));
    if (theta < frame.sunDir.w) { discard; }   // the disc itself is saturated already
    // Halo: (1 + (theta / c)^2)^-p (flare.ts haloProfile); shape.y normalises its integral to 1.
    let x = theta / t.shape.x;
    let halo = t.shape.y * pow(1.0 + x * x, -FLARE_HALO_POWER);
    // Spikes: angle about the sun in the image plane.
    let toS = normalize(dir - s * dot(dir, s));
    let up = normalize(frame.cameraUp.xyz - s * dot(frame.cameraUp.xyz, s));
    let rt = cross(s, up);
    let phi = atan2(dot(toS, rt), dot(toS, up));
    // Distance to the nearest of 6 spikes (every 60 deg), as an angle across the spike.
    let seg = PI / 3.0;
    let dphi = abs(phi - seg * round(phi / seg));
    let across = theta * sin(dphi);
    let w = t.shape.z;
    let gw = exp(-0.5 * across * across / (w * w));
    // Along the spike: a Fraunhofer edge falls off as theta^-2 beyond the core; length scales with wavelength.
    let lambda = SPIKE_LAMBDA;
    let along = vec3f(1.0) / (vec3f(1.0) + (theta * theta) / (t.pos.z * t.pos.z * lambda * lambda));
    let spikes = t.shape.w * gw * along / lambda;
    // tint.a = energy of the whole term; shape.y and shape.w normalise halo and spikes to 1 each (CPU, numeric).
    L = source * t.tint.rgb * t.tint.a * (halo * FLARE_HALO_SHARE + spikes * (1.0 - FLARE_HALO_SHARE));
  } else {
    // Ghost: a soft disc of angular radius t.pos.z, chromatic fringe by a radial shift per channel.
    let c = ndcRay(t.pos.xy);
    let r = atan2(length(cross(dir, c)), dot(dir, c)) / t.pos.z;
    let soft = t.shape.x;
    let shift = t.shape.z;
    let disc = saturate((vec3f(1.0) - vec3f(r * (1.0 - shift), r, r * (1.0 + shift))) / soft);
    let ring = disc * (vec3f(0.55) + 0.45 * smoothstep(vec3f(0.6), vec3f(1.0), vec3f(r)));
    L = source * t.tint.rgb * t.tint.a * t.shape.y * ring;
  }
  let c = applyAtmosphere(uv, 0.0, L * frame.exposure.x, 0.0);
  return vec4f(writeHdr(c.rgb), 0.0);
}
`;

// --------------------------------------------------------------------------------------------- probe

/** Shared by the probe kernels: cube texel directions (WebGPU face table, photometry.ts cubeTexelDirection). */
const CUBE_WGSL = /* wgsl */ `
fn cubeDir(face: u32, x: f32, y: f32, size: f32) -> vec3f {
  let u = 2.0 * (x + 0.5) / size - 1.0;
  let v = 2.0 * (y + 0.5) / size - 1.0;
  var d: vec3f;
  switch (face) {
    case 0u: { d = vec3f(1.0, -v, -u); }
    case 1u: { d = vec3f(-1.0, -v, u); }
    case 2u: { d = vec3f(u, 1.0, v); }
    case 3u: { d = vec3f(u, -1.0, -v); }
    case 4u: { d = vec3f(u, -v, 1.0); }
    default: { d = vec3f(-u, -v, -1.0); }
  }
  return normalize(d);
}
fn cubeArea(x: f32, y: f32) -> f32 { return atan2(x * y, sqrt(x * x + y * y + 1.0)); }
/// Exact solid angle of texel (x, y) of a face of 'size' texels.
fn cubeTexelSolidAngle(x: f32, y: f32, size: f32) -> f32 {
  let x0 = 2.0 * x / size - 1.0;
  let x1 = 2.0 * (x + 1.0) / size - 1.0;
  let y0 = 2.0 * y / size - 1.0;
  let y1 = 2.0 * (y + 1.0) / size - 1.0;
  return cubeArea(x0, y0) - cubeArea(x0, y1) - cubeArea(x1, y0) + cubeArea(x1, y1);
}
`;

export const PROBE_STEP_WGSL = /* wgsl */ `
struct ProbeStep {
  a: vec4u,   // x = face being evaluated, y = layer of the cube being prefiltered (next * 6), z = prev * 6, w = cur * 6
  b: vec4f,   // x = blend weight prev -> cur, y = SH slot next, z = SH slot prev, w = SH slot cur
}
`;

/**
 * One face of the raw probe cube at the active vessel, evaluated analytically: the nearest body hit by the
 * texel's ray (cancellation-free sphere test), lit by the sun (eclipses, the atmosphere's transmittance, the
 * far cloud shadow), the sky irradiance table and planetshine, with the albedo of the body's albedoLowRes map
 * (or its mean colour), cloud tops from 'clouds.coverageMap' over it, the view path's transmittance and the
 * in-scatter of the sky-view table in front; misses return the sky-view table plus the Milky Way through the
 * atmosphere. The sun disc is not in the probe (it is the directional light).
 */
export const PROBE_FACE_CS = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "atmosphere_common"
#include "eclipse"
${bindings}
${CUBE_WGSL}
${PROBE_STEP_WGSL}
const CLOUD_G = 0.85;
struct ProbeBody {
  centre: vec4f,   // xyz = body centre relative to the probe (ROOT, m), w = radius (m)
  info: vec4f,     // x = frame body index, y = probe altitude above the radius (m, from float64), z = weight in the probe (1 - planetshine weight), w = albedo map slot (-1 = mean colour)
}
struct ProbeUniforms {
  probeRelCam: vec4f,   // xyz = probe relative to the camera (m), w = number of bodies
  misc: vec4f,          // x = Milky Way cd/m^2 per stored unit (0 = not loaded), y = Milky Way mip for probe texels, z = sky-view body (frame index, -1 none), w = 0
  bodies: array<ProbeBody, 4>,
}
@group(2) @binding(0) var<uniform> probe: ProbeUniforms;
@group(2) @binding(1) var<uniform> step: ProbeStep;
@group(2) @binding(2) var albedo0: texture_2d<f32>;
@group(2) @binding(3) var albedo1: texture_2d<f32>;
@group(2) @binding(4) var albedo2: texture_2d<f32>;
@group(2) @binding(5) var albedo3: texture_2d<f32>;
@group(2) @binding(6) var milkyWay: texture_cube<f32>;
@group(2) @binding(7) var outFace: texture_storage_2d_array<rgba16float, write>;

/// Distance along unit ray d to a sphere of radius rs centred at 'c' (relative to the ray origin), for an
/// origin at altitude h above it. Cancellation-free near the surface and from far away. -1 = miss.
fn hitSphere(d: vec3f, c: vec3f, h: f32, rs: f32) -> f32 {
  let r0 = length(c);
  let up = -c / r0;
  let mu = dot(d, up);
  if (h <= 0.0 || mu >= 0.0) { return -1.0; }
  let cr = cross(d, up);
  let disc = rs * rs - r0 * r0 * dot(cr, cr);
  if (disc < 0.0) { return -1.0; }
  return h * (2.0 * rs + h) / (r0 * -mu + sqrt(disc));
}
/// Far intersection (exit) or near intersection of a sphere of radius rr around c from inside/outside.
fn sphereCross(d: vec3f, c: vec3f, rr: f32, far: bool) -> f32 {
  let b = dot(d, c);
  let det = b * b - dot(c, c) + rr * rr;
  if (det < 0.0) { return -1.0; }
  let s = sqrt(det);
  return select(b - s, b + s, far);
}

fn albedoAt(slot: i32, uv: vec2f, lod: f32) -> vec3f {
  switch (slot) {
    case 0: { return textureSampleLevel(albedo0, linearRepeat, uv, lod).rgb; }
    case 1: { return textureSampleLevel(albedo1, linearRepeat, uv, lod).rgb; }
    case 2: { return textureSampleLevel(albedo2, linearRepeat, uv, lod).rgb; }
    default: { return textureSampleLevel(albedo3, linearRepeat, uv, lod).rgb; }
  }
}
fn equirectUv(bi: u32, nRoot: vec3f, lonOffset: f32) -> vec2f {
  let nf = rootToFixed(bi, nRoot);
  return vec2f(fract((atan2(nf.y, nf.x) + lonOffset) / TWO_PI + 0.5), 0.5 - asin(clamp(nf.z, -1.0, 1.0)) / PI);
}

/// Fraction of the solar disc visible from a point (relative to the probe) with outward normal n of body 'self':
/// the body's own horizon (straight edge) and every other probe body.
fn sunVisibleAt(p: vec3f, n: vec3f, selfIndex: u32, sunDir: vec3f) -> f32 {
  let rs = frame.sunDir.w;
  var vis = discVisibleFraction(rs, 1.5707963, atan2(length(cross(-n, sunDir)), dot(-n, sunDir)));
  for (var j = 0u; j < u32(probe.probeRelCam.w); j++) {
    if (j == selfIndex) { continue; }
    let to = probe.bodies[j].centre.xyz - p;
    let dist = length(to);
    let ro = asin(min(probe.bodies[j].centre.w / max(dist, 1.0), 1.0));
    vis *= discVisibleFraction(rs, ro, atan2(length(cross(to, sunDir)), dot(to, sunDir)));
  }
  return vis;
}

/// Illuminance (lux, colour) on a horizontal surface element at radius r (normal n) of frame body bi:
/// direct sun (eclipses, atmosphere transmittance) + sky irradiance table + planetshine. No cloud shadow.
fn surfaceIlluminance(bi: u32, selfIndex: u32, p: vec3f, n: vec3f, r: f32) -> vec3f {
  let b = frame.bodies[bi];
  let sunDir = b.sunDir.xyz;
  let muS = dot(n, sunDir);
  var e = vec3f(0.0);
  let vis = sunVisibleAt(p, n, selfIndex, sunDir);
  if (vis > 0.0 && muS > 0.0) {
    e += frame.sunIlluminance.rgb * vis * muS * atmosphereSunTransmittance(transmittanceLut, bi, r, muS);
  }
  let layer = i32(b.fixedX.w);
  let rt = b.prevCenter.w;
  if (layer >= 0 && rt > b.center.w) {
    e += textureSampleLevel(skyIrradianceLut, linearClamp, skyIrradianceUvFromRMuS(max(r, b.center.w), muS, b.center.w, rt), layer, 0.0).rgb;
  }
  for (var k = 0u; k < 2u; k++) {
    let sh = frame.shine[bi * 2u + k];
    e += sh.illuminance.rgb * max(dot(n, sh.dir.xyz), 0.0);
  }
  return e;
}

/// Transmittance of the atmosphere of frame body bi between the probe and a point at radius rp with outward
/// normal np, seen along d: T(point -> top along -d) / T(probe -> top along -d).
fn viewTransmittance(bi: u32, d: vec3f, rp: f32, np: vec3f, probeR: f32, probeUp: vec3f) -> vec3f {
  let tp = atmosphereSunTransmittance(transmittanceLut, bi, rp, dot(np, -d));
  let tc = atmosphereSunTransmittance(transmittanceLut, bi, probeR, dot(probeUp, -d));
  return min(tp / max(tc, vec3f(1e-6)), vec3f(1.0));
}

fn coverageAt(bi: u32, n: vec3f) -> f32 {
  return textureSampleLevel(cloudCoverageMapTex, linearRepeat, equirectUv(bi, n, frame.cloudFar.w), 0.0).r;
}
fn cloudReflectance(tau: f32) -> f32 { return (1.0 - CLOUD_G) * tau / (2.0 + (1.0 - CLOUD_G) * tau); }

fn skyInScatter(d: vec3f) -> vec3f {
  let sv = i32(probe.misc.z);
  if (sv < 0) { return vec3f(0.0); }
  let b = frame.bodies[u32(sv)];
  return textureSampleLevel(skyViewLut, linearClamp, skyViewUv(d, b.cameraUp.xyz, b.sunDir.xyz), 0.0).rgb;
}

fn bodyRadiance(i: u32, d: vec3f, t: f32, texelAngle: f32) -> vec3f {
  let pb = probe.bodies[i];
  let bi = u32(pb.info.x);
  let b = frame.bodies[bi];
  let R = pb.centre.w;
  let p = d * t;
  let n = normalize(p - pb.centre.xyz);
  let probeR = R + pb.info.y;
  let probeUp = -pb.centre.xyz / length(pb.centre.xyz);
  // Albedo: the body's global map (footprint-matched mip) or its mean colour.
  var albedo = b.meanColor.rgb;
  let slot = i32(pb.info.w);
  if (slot >= 0) {
    let footprint = t * texelAngle / max(dot(n, -d), 0.05);
    var mapW = f32(textureDimensions(albedo0).x);
    switch (slot) {
      case 1: { mapW = f32(textureDimensions(albedo1).x); }
      case 2: { mapW = f32(textureDimensions(albedo2).x); }
      case 3: { mapW = f32(textureDimensions(albedo3).x); }
      default: {}
    }
    let lod = log2(max(footprint * mapW / (TWO_PI * R), 1.0));
    albedo = albedoAt(slot, equirectUv(bi, n, 0.0), lod);
  }
  let eGround = surfaceIlluminance(bi, i, p, n, R);
  var L: vec3f;
  let clouds = i32(frame.cloudFar.x) == i32(bi) && frame.cloudFar.y > R;
  if (clouds && probeR > frame.cloudFar.y) {
    // Seen from above the layer: cloud tops (two-stream reflectance) over the ground (adding method).
    let tc = sphereCross(d, pb.centre.xyz, frame.cloudFar.y, false);
    let q = d * tc;
    let nq = normalize(q - pb.centre.xyz);
    let tau = coverageAt(bi, nq) * frame.cloudFar.z;
    let rc = cloudReflectance(tau);
    let eTop = surfaceIlluminance(bi, i, q, nq, frame.cloudFar.y);
    let ground = (1.0 - rc) * (1.0 - rc) * albedo / (vec3f(1.0) - rc * albedo);
    L = viewTransmittance(bi, d, frame.cloudFar.y, nq, probeR, probeUp) * eTop * (rc / PI)
      + viewTransmittance(bi, d, R, n, probeR, probeUp) * eGround * ground / PI;
  } else {
    var e = eGround;
    if (clouds) {
      // Below the layer: the far cloud shadow of the render core, exp(-coverage tau / max(mu_s, 0.05)).
      let sunDir = b.sunDir.xyz;
      let muS = max(dot(n, sunDir), 0.05);
      let ts = sphereCross(sunDir, pb.centre.xyz - p, frame.cloudFar.y, true);
      let nq = normalize(p + sunDir * ts - pb.centre.xyz);
      let shadow = exp(-coverageAt(bi, nq) * frame.cloudFar.z / muS);
      // Only the direct sun is shadowed; sky light and planetshine pass (the sky table already holds the clouds' absence).
      let vis = sunVisibleAt(p, n, i, sunDir);
      let direct = frame.sunIlluminance.rgb * vis * max(dot(n, sunDir), 0.0) * atmosphereSunTransmittance(transmittanceLut, bi, R, dot(n, sunDir));
      e = e - direct * (1.0 - shadow);
    }
    L = viewTransmittance(bi, d, R, n, probeR, probeUp) * e * albedo / PI;
  }
  return L + skyInScatter(d);
}

fn missRadiance(d: vec3f) -> vec3f {
  var L = skyInScatter(d);
  var T = vec3f(1.0);
  // Through the atmosphere of the body the probe is in (or above): the Milky Way is attenuated.
  for (var i = 0u; i < u32(probe.probeRelCam.w); i++) {
    let pb = probe.bodies[i];
    let bi = u32(pb.info.x);
    let b = frame.bodies[bi];
    if (b.prevCenter.w <= 0.0) { continue; }
    let probeR = pb.centre.w + pb.info.y;
    let up = -pb.centre.xyz / length(pb.centre.xyz);
    T *= atmosphereSunTransmittance(transmittanceLut, bi, probeR, dot(up, d));
    // From below a cloud layer the sky is seen through it: base lit by the transmitted sunlight.
    if (i32(frame.cloudFar.x) == i32(bi) && probeR < frame.cloudFar.y) {
      let tc = sphereCross(d, pb.centre.xyz, frame.cloudFar.y, true);
      let q = d * tc;
      let nq = normalize(q - pb.centre.xyz);
      let tau = coverageAt(bi, nq) * frame.cloudFar.z;
      let muV = max(dot(d, nq), 0.02);
      let direct = exp(-tau / muV);
      let sunDir = b.sunDir.xyz;
      let muS = dot(nq, sunDir);
      var top = vec3f(0.0);
      if (muS > 0.0) { top = frame.sunIlluminance.rgb * muS * sunVisibleAt(q, nq, i, sunDir) * atmosphereSunTransmittance(transmittanceLut, bi, frame.cloudFar.y, muS); }
      let base = top * (1.0 - cloudReflectance(tau)) / PI;
      L = L * direct + base * (1.0 - direct);
      T *= direct;
    }
  }
  if (probe.misc.x > 0.0) { L += textureSampleLevel(milkyWay, linearClamp, d, probe.misc.y).rgb * probe.misc.x * T; }
  return L;
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(outFace).x;
  if (gid.x >= size || gid.y >= size) { return; }
  let fsize = f32(size);
  let d = cubeDir(step.a.x, f32(gid.x), f32(gid.y), fsize);
  let texelAngle = 2.0 / fsize;
  var best = 3.0e38;
  var hit = -1;
  for (var i = 0u; i < u32(probe.probeRelCam.w); i++) {
    let pb = probe.bodies[i];
    let t = hitSphere(d, pb.centre.xyz, pb.info.y, pb.centre.w);
    if (t > 0.0 && t < best) { best = t; hit = i32(i); }
  }
  var L: vec3f;
  if (hit >= 0) {
    // Bodies whose light the render core already adds as planetshine are scaled out (no double counting).
    let w = probe.bodies[u32(hit)].info.z;
    L = bodyRadiance(u32(hit), d, best, texelAngle) * w + missRadiance(d) * (1.0 - w);
  } else {
    L = missRadiance(d);
  }
  textureStore(outFace, vec2i(gid.xy), i32(step.a.x), vec4f(max(L, vec3f(0.0)), 1.0));
}
`;

/** Raw cube mip m from mip m - 1: 2 x 2 box. */
export const PROBE_DOWN_CS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst).x;
  if (gid.x >= size || gid.y >= size) { return; }
  let p = vec2i(gid.xy) * 2;
  let l = i32(gid.z);
  let c = textureLoad(src, p, l, 0) + textureLoad(src, p + vec2i(1, 0), l, 0) + textureLoad(src, p + vec2i(0, 1), l, 0) + textureLoad(src, p + vec2i(1, 1), l, 0);
  textureStore(dst, vec2i(gid.xy), l, c * 0.25);
}
`;

/**
 * SH9 projection of the raw cube (one mip with exact texel solid angles), convolved with the cosine lobe:
 * irradiance coefficients in the order and normalisation of 'env.sh9'. One workgroup of 64 threads.
 */
export const PROBE_SH_CS = /* wgsl */ `
${CUBE_WGSL}
${PROBE_STEP_WGSL}
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> shSlots: array<vec4f, 27>;
@group(0) @binding(2) var<uniform> step: ProbeStep;
var<workgroup> partial: array<array<vec3f, 9>, 64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(src).x;
  let fsize = f32(size);
  let total = size * size * 6u;
  var acc: array<vec3f, 9>;
  for (var k = 0u; k < 9u; k++) { acc[k] = vec3f(0.0); }
  for (var i = li; i < total; i += 64u) {
    let face = i / (size * size);
    let rem = i % (size * size);
    let x = rem % size;
    let y = rem / size;
    let d = cubeDir(face, f32(x), f32(y), fsize);
    let L = textureLoad(src, vec2i(i32(x), i32(y)), i32(face), 0).rgb * cubeTexelSolidAngle(f32(x), f32(y), fsize);
    acc[0] += L * 0.282095;
    acc[1] += L * (0.488603 * d.y);
    acc[2] += L * (0.488603 * d.z);
    acc[3] += L * (0.488603 * d.x);
    acc[4] += L * (1.092548 * d.x * d.y);
    acc[5] += L * (1.092548 * d.y * d.z);
    acc[6] += L * (0.315392 * (3.0 * d.z * d.z - 1.0));
    acc[7] += L * (1.092548 * d.x * d.z);
    acc[8] += L * (0.546274 * (d.x * d.x - d.y * d.y));
  }
  partial[li] = acc;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (li < s) { for (var k = 0u; k < 9u; k++) { partial[li][k] += partial[li + s][k]; } }
    workgroupBarrier();
  }
  if (li == 0u) {
    let slot = u32(step.b.y) * 9u;
    // Cosine lobe: pi, 2 pi / 3, pi / 4 per band.
    var a = array<f32, 9>(3.14159265, 2.09439510, 2.09439510, 2.09439510, 0.78539816, 0.78539816, 0.78539816, 0.78539816, 0.78539816);
    for (var k = 0u; k < 9u; k++) { shSlots[slot + k] = vec4f(partial[0][k] * a[k], 0.0); }
  }
}
`;

/**
 * GGX prefilter of the raw cube into mip m of the cube under construction (roughness m / (mips - 1); mip 0 is a
 * copy), filtered importance sampling (Karis 2013, Colbert & Krivanek 2007) from the raw cube's own mips.
 */
export const PROBE_PREFILTER_CS = /* wgsl */ `
${CUBE_WGSL}
${PROBE_STEP_WGSL}
const PI = 3.14159265358979;
@group(0) @binding(0) var rawCube: texture_cube<f32>;
@group(0) @binding(1) var rawArray: texture_2d_array<f32>;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> step: ProbeStep;
@group(0) @binding(4) var cubeSampler: sampler;
override MIP: u32 = 1u;
override MIPS: u32 = 5u;
fn radicalInverse(i: u32) -> f32 { return f32(reverseBits(i)) * 2.3283064365386963e-10; }
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst).x;
  if (gid.x >= size || gid.y >= size) { return; }
  let face = gid.z;
  let layer = i32(step.a.y + face);
  if (MIP == 0u) {
    textureStore(dst, vec2i(gid.xy), layer, vec4f(textureLoad(rawArray, vec2i(gid.xy), i32(face), 0).rgb, 1.0));
    return;
  }
  let n = cubeDir(face, f32(gid.x), f32(gid.y), f32(size));
  let rough = f32(MIP) / f32(MIPS - 1u);
  let a = rough * rough;
  let a2 = a * a;
  let tz = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.999);
  let tx = normalize(cross(tz, n));
  let ty = cross(n, tx);
  let rawSize = f32(textureDimensions(rawCube).x);
  let saTexel = 4.0 * PI / (6.0 * rawSize * rawSize);
  let levels = f32(textureNumLevels(rawCube) - 1u);
  const COUNT = 64u;
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0u; i < COUNT; i++) {
    let xi = vec2f((f32(i) + 0.5) / f32(COUNT), radicalInverse(i));
    let phi = 2.0 * PI * xi.x;
    let cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sinT = sqrt(1.0 - cosT * cosT);
    let h = tx * (sinT * cos(phi)) + ty * (sinT * sin(phi)) + n * cosT;
    let l = 2.0 * dot(n, h) * h - n;
    let nl = dot(n, l);
    if (nl <= 0.0) { continue; }
    // pdf of l for v = n: D(h) / 4; the solid angle a sample stands for picks the source mip.
    let dd = cosT * cosT * (a2 - 1.0) + 1.0;
    let D = a2 / (PI * dd * dd);
    let saSample = 1.0 / (f32(COUNT) * D * 0.25 + 1e-6);
    let lod = clamp(0.5 * log2(saSample / saTexel) + 1.0, 0.0, levels);
    sum += textureSampleLevel(rawCube, cubeSampler, l, lod).rgb * nl;
    wsum += nl;
  }
  textureStore(dst, vec2i(gid.xy), layer, vec4f(sum / max(wsum, 1e-6), 1.0));
}
`;

/** Published cube mip m = mix(prev, cur, t) of the two latest completed probes. */
export const PROBE_BLEND_CS = /* wgsl */ `
${PROBE_STEP_WGSL}
@group(0) @binding(0) var probes: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> step: ProbeStep;
override MIP: i32 = 0;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst).x;
  if (gid.x >= size || gid.y >= size) { return; }
  let p = vec2i(gid.xy);
  let a = textureLoad(probes, p, i32(step.a.z + gid.z), MIP);
  let b = textureLoad(probes, p, i32(step.a.w + gid.z), MIP);
  textureStore(dst, p, i32(gid.z), mix(a, b, step.b.x));
}
`;

/** Published SH = mix(prev, cur, t). */
export const PROBE_SH_BLEND_CS = /* wgsl */ `
${PROBE_STEP_WGSL}
@group(0) @binding(0) var<storage, read> shSlots: array<vec4f, 27>;
@group(0) @binding(1) var<storage, read_write> shOut: array<vec4f, 9>;
@group(0) @binding(2) var<uniform> step: ProbeStep;
@compute @workgroup_size(9) fn main(@builtin(local_invocation_index) k: u32) {
  shOut[k] = mix(shSlots[u32(step.b.z) * 9u + k], shSlots[u32(step.b.w) * 9u + k], step.b.x);
}
`;
