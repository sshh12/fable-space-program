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
import { BLADE_COUNT, GHOSTS, POLY_EQ_CIRCLE, RAY_REACH, SPIKE_COUNT, SPIKE_LAMBDA, STREAK_COUNT } from './flare';
import { IMPOSTOR_KERNEL_CUT, SCINTILLATION_ZENITH_VARIANCE, STAR_PSF_SIGMA_PX, STAR_WING_ALPHA_PX, STAR_WING_FLOOR, STAR_WING_MAX_PX, STAR_WING_SHARE } from './photometry';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * Cap of every ADDITIVE write of this feature (stars, impostors, each flare term), pre-exposed. Blending cannot
 * clamp, and the solar disc already sits at HDR_MAX (60,000): a full-strength additive draw over it would reach
 * 120,000 and overflow rgba16float (65,504) to Inf. With this cap the worst stack over a disc pixel (two stars,
 * an impostor, five flare terms) stays at 64,000. 500 is about 2,800 x mid-grey: far above display white, so the
 * cap changes no tonemapped pixel; it only limits the bloom of a grossly overexposed point.
 */
export const ADDITIVE_CAP = 500;
const CAP_WGSL = `const ADDITIVE_CAP = ${f(ADDITIVE_CAP)};
fn capAdditive(c: vec3f) -> vec3f { return min(writeHdr(c), vec3f(ADDITIVE_CAP)); }`;

export const SKY_COMMON_WGSL = /* wgsl */ `
${CAP_WGSL}
const STAR_SIGMA_PX = ${f(STAR_PSF_SIGMA_PX)};
const SCINT_ZENITH = ${f(SCINTILLATION_ZENITH_VARIANCE)};
struct SkyUniforms {
  mw: vec4f,        // x = Milky Way cd/m^2 per stored unit, y = 1 when the cube is loaded, z = 1 = draw the sun disc, w = 1 = draw stars
  limb: vec4f,      // rgb = linear limb-darkening coefficients u, a = 1 / (pi sin^2 theta_sun)
  scint: vec4f,     // x = 1 when the camera is inside an atmosphere, y = camera altitude (m), z = scale height (m), w = (R + h) / H
  scintUp: vec4f,   // xyz = local vertical at the camera (ROOT), w = scintillation clock (s; frozen when frame.time.w == 0)
  px: vec4f,        // x = solid angle of a pixel on the view axis (sr), y = half size of a star's core quad (px), z = pixel angle on the axis (rad), w = texel angle of the Milky Way detail layer at a face centre (rad; 0 = none)
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
@group(1) @binding(2) var milkyWayDetail: texture_cube<f32>;

/// The Milky Way and the stars fainter than the catalogue: the colour cube (trilinear), and where a pixel is
/// smaller than its texels the luminance of the next finer baked level with the colour cube's chromaticity
/// (the 2 x 2 mean of the detail layer is the colour cube's luminance, so the two agree where they cross-fade).
fn milkyWayRadiance(dir: vec3f) -> vec3f {
  var c = textureSample(milkyWay, linearClamp, dir).rgb;
  if (sky.px.w > 0.0) {
    let pa = sky.px.z * pow(max(dot(dir, frame.cameraForward.xyz), 0.05), 1.5);
    // 1 where a pixel is no larger than a detail texel, 0 where it is as large as a texel of the colour cube.
    let w = saturate(1.0 - log2(pa / sky.px.w));
    if (w > 0.0) {
      let l = textureSampleLevel(milkyWayDetail, linearClamp, dir, 0.0).r;
      c = mix(c, c * min(l / max(luminance(c), 1e-9), 8.0), w);
    }
  }
  return c * sky.mw.x;
}

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
  if (sky.mw.y > 0.5) { L += milkyWayRadiance(dir); }
  if (sky.mw.z > 0.5) { L += sunDisc(dir); }
  return vec4f(writeHdr(L * frame.exposure.x), 1.0);
}
`;

/**
 * Catalogue stars: 4-vertex triangle strips, one instance per star, at clip z = 0 (depth == 0 only). Each is the
 * point-spread function of photometry.ts (Gaussian core + r^-3 wings, starPsf) times the star's flux; the quad
 * reaches out to where the wings fall under STAR_WING_FLOOR at the frame's exposure, so only the bright stars of
 * the moment get large quads.
 */
export const STARS_WGSL = /* wgsl */ `
#include "frame"
#include "hash"
${SKY_COMMON_WGSL}
const WING_SHARE = ${f(STAR_WING_SHARE)};
const WING_ALPHA2 = ${f(STAR_WING_ALPHA_PX * STAR_WING_ALPHA_PX)};
const WING_FLOOR = ${f(STAR_WING_FLOOR)};
const WING_MAX_PX = ${f(STAR_WING_MAX_PX)};
struct StarIn {
  @location(0) dirLux: vec4f,       // unit direction (ROOT), illuminance at the observer (lux)
  @location(1) colourMag: vec4f,    // linear-sRGB colour with luminance 1, V magnitude
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
}
struct StarOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,                      // pixel offset from the projected (jittered) centre
  @location(1) @interpolate(flat) flux: vec3f,       // pre-exposed sum of the image's pixels (colour x illuminance / pixel solid angle x exposure)
  @location(2) @interpolate(flat) wing: vec2f,       // amplitude and floor of the wings (photometry.ts starWing)
}
@vertex fn vs(in: StarIn) -> StarOut {
  var o: StarOut;
  let dir = in.dirLux.xyz;
  let clip = frame.viewProj * vec4f(dir, 0.0);
  let cosOff = dot(dir, frame.cameraForward.xyz);
  if (clip.w <= 1e-6 || cosOff <= 0.0 || sky.mw.w < 0.5) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    o.offsetPx = vec2f(0.0);
    o.flux = vec3f(0.0);
    o.wing = vec2f(0.0);
    return o;
  }
  // Pixel solid angle along this direction (pinhole: on-axis value x cos^3).
  let omega = sky.px.x * cosOff * cosOff * cosOff;
  let p = in.dirLux.w / omega * frame.exposure.x;
  // Image radius: where the wings fall under the floor (photometry.ts starImageRadius), from the unmodulated flux.
  let q = pow(p * WING_SHARE / (TWO_PI * WING_ALPHA2 * WING_FLOOR), 2.0 / 3.0);
  let R = clamp(sqrt(WING_ALPHA2 * max(q - 1.0, 0.0)), sky.px.y, WING_MAX_PX);
  let qq = 1.0 + R * R / WING_ALPHA2;
  let fl = pow(qq, -1.5);
  o.wing = vec2f(WING_SHARE / (TWO_PI * WING_ALPHA2 * (1.0 - inverseSqrt(qq)) - PI * R * R * fl), fl);
  let corner = vec2f(f32(in.vi & 1u), f32(in.vi >> 1u)) * 2.0 - 1.0;
  let off = corner * R;
  // Pixels -> NDC (y down in pixels, up in NDC). All four corners share clip.w, so offsetPx interpolates linearly.
  o.pos = vec4f(clip.xy + off * vec2f(2.0, -2.0) * frame.renderSize.zw * clip.w, 0.0, clip.w);
  o.offsetPx = off;
  o.flux = in.colourMag.rgb * p * scintillation(dir, in.ii);
  return o;
}
@fragment fn fs(in: StarOut) -> @location(0) vec4f {
  let r2 = dot(in.offsetPx, in.offsetPx);
  let core = (1.0 - WING_SHARE) * exp(-0.5 * r2 / (STAR_SIGMA_PX * STAR_SIGMA_PX)) / (TWO_PI * STAR_SIGMA_PX * STAR_SIGMA_PX);
  let wing = in.wing.x * max(pow(1.0 + r2 / WING_ALPHA2, -1.5) - in.wing.y, 0.0);
  return vec4f(capAdditive(in.flux * (core + wing)), 1.0);
}
`;

/**
 * Distant bodies: the analytic far image of a sunlit sphere. The sunlit lune of the disc is sampled on a grid
 * fixed to the body (photometry.ts impostorLune: latitude / longitude about the axis perpendicular to the
 * sun-observer plane, so every sample is lit however thin the crescent), every sample shaded with the body's own
 * photometric function (Lambert with the albedo of its geometric albedo, or its Hapke function) and spread with
 * the point-spread function, so the image carries the phase shape (a crescent a few pixels across is an
 * off-centre sliver), does not depend on the pixel grid or on the temporal resolve, and becomes a star-like
 * point as the body shrinks. Its pixels add up to the body's phase-integrated flux (the grid's sum is normalised
 * to it on the CPU for coarse grids; fine grids are within 2 % by themselves). Each pixel only visits the
 * samples within 2.8 sigma of it: a fragment's work is a few dozen samples whatever the size of the body.
 * Drawn in the transparent stage so that it can replace the body's own geometry: on a pixel whose depth belongs
 * to the body the blend is (1 - a) x geometry + image, a = weight x (the whole disc for a small body, its
 * sunlit part for a larger one, so the night side keeps what the geometry shows there); elsewhere the image is
 * added.
 */
export const IMPOSTOR_WGSL = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "transparency"
${bindings}
${CAP_WGSL}
const WING_ALPHA2 = ${f(STAR_WING_ALPHA_PX * STAR_WING_ALPHA_PX)};
const KERNEL_CUT = ${f(IMPOSTOR_KERNEL_CUT)};
// A Gaussian cut at KERNEL_CUT sigma holds 1 - exp(-cut^2 / 2) of its integral: the kernel is scaled back to 1.
const KERNEL_NORM = ${f(1 / (1 - Math.exp(-0.5 * IMPOSTOR_KERNEL_CUT * IMPOSTOR_KERNEL_CUT)))};
struct Impostor {
  centre: vec4f,   // xyz = body centre relative to the camera (ROOT, m), w = radius (m)
  axis: vec4f,     // xy = unit direction of the sun in the image plane at the body (x right, y up), z = phase angle (rad), w = weight of the image
  scale: vec4f,    // rgb = radiance of a sample per unit of its photometric term: sunlight x albedo / pi (Lambert) or sunlight x w / (4 pi) (Hapke); a = 1 for Hapke
  gamma: vec4f,    // Hapke: xyz = sqrt(1 - w) per channel, w = (1 + B(g)) P(g) (opposition surge x phase function at this phase angle)
  flux: vec4f,     // rgb = phase-integrated radiance of the disc per unit radius^2, a = share of the wings
  shape: vec4f,    // x = radius (px), y = quad half size (px), z = distance to the near side (m), w = kernel sigma (px)
  lune: vec4f,     // x = rows, y = samples of the equatorial row, z = 0 whole disc .. 1 sunlit part only (alpha over the geometry), w = normalisation of the grid's sum
  wing: vec4f,     // x = amplitude, y = floor, z = radius (px) of the wings (photometry.ts starWing), w = photocentre along the sun's direction (px)
}
struct Impostors { count: vec4u, list: array<Impostor, 16> }
@group(2) @binding(0) var<uniform> impostors: Impostors;

/// Radiance (rgb) of the sample at latitude cosine a, longitude psi from the bright limb, times its area on the
/// unit disc (photometry.ts farBodyRadiance: Lambert, or the Hapke function of rendering-design 8.2).
fn farSample(im: Impostor, a: f32, psi: f32, cell: f32) -> vec3f {
  let sp = sin(psi);
  let mu = a * sp;
  let mu0 = a * sin(psi + im.axis.z);
  if (mu0 <= 0.0 || mu <= 0.0) { return vec3f(0.0); }
  let dA = a * a * sp * cell;
  if (im.scale.a > 0.5) {
    let H0 = (1.0 + 2.0 * mu0) / (vec3f(1.0) + 2.0 * mu0 * im.gamma.xyz);
    let H = (1.0 + 2.0 * mu) / (vec3f(1.0) + 2.0 * mu * im.gamma.xyz);
    return im.scale.rgb * (mu0 / (mu0 + mu) * dA) * (vec3f(im.gamma.w - 1.0) + H0 * H);
  }
  return im.scale.rgb * (mu0 * dA);
}
fn rowSamples(cols: f32, a: f32) -> i32 { return max(2, i32(ceil(cols * a))); }

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) offsetPx: vec2f,                       // pixel offset from the projected centre (x right, y down)
  @location(1) @interpolate(flat) index: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let d = length(impostors.list[ii].centre.xyz);
  let dir = impostors.list[ii].centre.xyz / d;
  // Clip position of the near side of the body: its depth is what the geometry pixels of the body hold.
  let clip = frame.viewProj * vec4f(dir * impostors.list[ii].shape.z, 1.0);
  o.index = ii;
  if (clip.w <= 0.0) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    o.offsetPx = vec2f(0.0);
    return o;
  }
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let off = corner * impostors.list[ii].shape.y;
  o.pos = vec4f(clip.xy + off * vec2f(2.0, -2.0) * frame.renderSize.zw * clip.w, clip.z, clip.w);
  o.offsetPx = off;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let im = impostors.list[in.index];
  let pix = vec2i(in.pos.xy);
  let uv = in.pos.xy * frame.renderSize.zw;
  // This pixel in the sun-aligned image frame (x towards the sun), in radii.
  let t = im.axis.xy;
  let p = vec2f(in.offsetPx.x, -in.offsetPx.y);
  let pp = vec2f(dot(p, t), dot(p, vec2f(-t.y, t.x))) / im.shape.x;
  let sigma = im.shape.w / im.shape.x;
  let cut = KERNEL_CUT * sigma;
  let rows = i32(im.lune.x);
  let dBeta = PI / im.lune.x;
  let span = PI - im.axis.z;
  // Rows within the kernel's reach of the pixel, and in each row the samples within it.
  let jLo = clamp(i32(floor((asin(clamp(pp.y - cut, -1.0, 1.0)) + 0.5 * PI) / dBeta - 0.5)), 0, rows - 1);
  let jHi = clamp(i32(ceil((asin(clamp(pp.y + cut, -1.0, 1.0)) + 0.5 * PI) / dBeta - 0.5)), 0, rows - 1);
  let k = KERNEL_NORM / (TWO_PI * sigma * sigma);
  var core = vec3f(0.0);
  var lit = 0.0;
  for (var j = jLo; j <= jHi; j++) {
    let beta = -0.5 * PI + (f32(j) + 0.5) * dBeta;
    let a = cos(beta);
    let y = sin(beta);
    let dy = pp.y - y;
    // Half width of the kernel's disc along this row.
    let reach2 = cut * cut - dy * dy;
    if (reach2 <= 0.0) { continue; }
    let reach = sqrt(reach2);
    let cLo = (pp.x - reach) / a;
    if (cLo > 1.0) { continue; }
    let psiLo = acos(clamp((pp.x + reach) / a, -1.0, 1.0));
    if (psiLo > span) { continue; }
    let psiHi = acos(clamp(cLo, -1.0, 1.0));
    let nj = rowSamples(im.lune.y, a);
    let dPsi = span / f32(nj);
    let iLo = clamp(i32(floor(psiLo / dPsi - 0.5)), 0, nj - 1);
    let iHi = clamp(i32(ceil(psiHi / dPsi - 0.5)), 0, nj - 1);
    for (var i = iLo; i <= iHi; i++) {
      let psi = (f32(i) + 0.5) * dPsi;
      let dx = pp.x - a * cos(psi);
      let d2 = dx * dx + dy * dy;
      if (d2 > cut * cut) { continue; }
      let g = k * exp(-0.5 * d2 / (sigma * sigma));
      core += farSample(im, a, psi, dPsi * dBeta) * g;
      lit += a * a * sin(psi) * dPsi * dBeta * g;
    }
  }
  var lum = core * im.lune.w * (1.0 - im.flux.a);
  // Wings of a point-like body: the star's, about the photocentre.
  let dc = p - t * im.wing.w;
  let r2 = dot(dc, dc);
  if (im.flux.a > 0.0 && r2 < im.wing.z * im.wing.z) {
    lum += im.flux.rgb * (im.shape.x * im.shape.x) * im.wing.x * (pow(1.0 + r2 / WING_ALPHA2, -1.5) - im.wing.y);
  }
  // Does this pixel show the body's own geometry? (scene depth within the body's sphere)
  let depth = textureLoad(sceneDepthTex, pix, 0);
  var alpha = 0.0;
  if (depth > 0.0) {
    let pos = positionFromDepth(uv, depth);
    if (distance(pos, im.centre.xyz) < im.centre.w * 1.02 + 2e-6 * length(im.centre.xyz)) { alpha = im.axis.w * mix(1.0, saturate(2.0 * lit), im.lune.z); }
  }
  let c = applyAtmosphere(uv, im.shape.z, lum * im.axis.w * frame.exposure.x, alpha);
  return vec4f(capAdditive(c.rgb), c.a);
}
`;

/**
 * Visible fraction of the solar disc: 64 Vogel-disc samples over the disc, each tested against 'scene.depth'
 * where it falls inside the render target and against the frame bodies' reference spheres where it does not
 * (the depth buffer does not cover it: a sun just outside the frame still lights the lens, unless a body hides
 * it), times the cloud transmittance 'clouds.screen'.a at the sun's position where a cloud lies in front
 * ('clouds.depth' < 3e38; off screen, at the nearest edge pixel), times the atmosphere's transmittance towards
 * the sun at the camera. Written to a storage buffer read by the flare shaders (no CPU readback).
 */
export const FLARE_VIS_CS = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "atmosphere_common"
${bindings}
struct FlareVisParams { atmo: vec4f }   // x = frame body index of the camera's atmosphere (-1 none), y = camera radius (m), z = mu of the sun there
struct FlareState { visible: vec4f, transmittance: vec4f }  // visible.x = disc fraction, .y = cloud transmittance, .z = 1 when the sun centre is on screen; transmittance.rgb
@group(2) @binding(0) var<uniform> visParams: FlareVisParams;
@group(2) @binding(1) var<storage, read_write> flareState: FlareState;
var<workgroup> hits: array<f32, 64>;

/// True when the ray from the camera along unit d meets the reference sphere of a non-star frame body that the
/// camera is above (a camera below a body's datum sees its ground through 'scene.depth' only).
fn bodyHides(d: vec3f) -> bool {
  for (var i = 0u; i < frame.counts.x; i++) {
    if ((bodyFlags(i) & BODY_FLAG_STAR) != 0u || frame.bodies[i].sunDir.w <= 0.0) { continue; }
    let c = frame.bodies[i].center.xyz;
    let R = frame.bodies[i].center.w;
    if (dot(d, c) <= 0.0) { continue; }
    let cr = cross(d, c);
    if (dot(cr, cr) < R * R) { return true; }
  }
  return false;
}

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
  var onScreen = false;
  var h = 0.0;
  if (c.w > 0.0) {
    let ndc = c.xy / c.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      onScreen = true;
      let size = vec2f(textureDimensions(sceneDepthTex));
      let depth = textureLoad(sceneDepthTex, vec2i(uv * size), 0);
      h = select(0.0, 1.0, depth == 0.0);
    }
  }
  if (!onScreen) { h = select(1.0, 0.0, bodyHides(d)); }
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
      let uvSun = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
      inView = select(0.0, 1.0, all(uvSun >= vec2f(0.0)) && all(uvSun <= vec2f(1.0)));
      // A sun outside the frame: the cloud at the nearest edge pixel stands for the cloud in front of it.
      let uv = clamp(uvSun, vec2f(0.0), vec2f(1.0));
      let cs = vec2i(textureDimensions(cloudsScreenTex));
      let q = clamp(vec2i(uv * vec2f(cs)), vec2i(0), cs - 1);
      if (textureLoad(cloudsDepthTex, q, 0).r < 3.0e38) { cloud = textureLoad(cloudsScreenTex, q, 0).a; }
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
 * Lens flare in the transparent stage (flare.ts has the model and its CPU twin). Instance 0 = the starburst
 * around the sun, drawn over the whole frame: the wide violet-blue halo that carries the bloom's glare on to
 * the frame edge, the fourteen diffraction rays of the 7-blade iris (as wide as the solar disc at the base,
 * narrow fans, each blade with its own strength, length, fan and angular error and two unequal rays; angles
 * scale with the wavelength, so a ray shows colour fringes and ends red) and the lens's table of fine streaks
 * between them (a pixel visits the streak of its azimuth cell and of the two cells beside it). Instances
 * 1.. = the ghosts: images of the iris on the line from the sun through the image centre, no two alike (sharp
 * or defocused, oval, hollow, cut to a cat's eye or to a crescent), each on the screen-space bounding box of
 * its cone. Every term's profile is normalised on the CPU so its luminance integrates to its energy fraction
 * x the illuminance at the lens; the sum is under 1 %. The source is the sun's illuminance x the visible disc
 * fraction, cloud and atmosphere transmittance (FLARE_VIS_CS) x the lens hood's transmission for a sun
 * outside the frame (flare.ts hoodTransmission). Additive (alpha 0). The flare forms inside the lens, at
 * distance 0, where applyAtmosphere is exactly neutral: it is not called (three texture lookups a pixel).
 */
export const FLARE_WGSL = (bindings: string): string => /* wgsl */ `
#include "frame"
#include "transparency"
${bindings}
${CAP_WGSL}
const SPIKE_COUNT = ${SPIKE_COUNT};
const BLADE_COUNT = ${BLADE_COUNT};
const STREAK_COUNT = ${STREAK_COUNT};
const SPIKE_LAMBDA = vec3f(${SPIKE_LAMBDA.map(f).join(', ')});
const POLY_EQ_CIRCLE = ${f(POLY_EQ_CIRCLE)};
const RAY_REACH = ${f(RAY_REACH)};
struct FlareState { visible: vec4f, transmittance: vec4f }
struct Blade {
  dir: vec4f,     // x = sin, y = cos of the edge normal's angle in the image plane (from up towards right), z = its angular error (rad)
  ray: vec4f,     // x = ray length (rad), y = fan (across width per radian from the sun), z = strength of its first ray, w = of its second
}
struct Ghost {
  pos: vec4f,     // xy = centre in NDC, z = apothem of the iris image (rad), w = +1 / -1 (inverted image)
  tint: vec4f,    // rgb = coating tint (luminance 1), a = energy fraction x normalisation (1/sr)
  shape: vec4f,   // x = edge blur (rad), y = roundness, z = rim, w = fill gradient per radian along the axis
  extra: vec4f,   // x = lateral colour of the blue image (fraction of the apothem), y = cat's-eye shift (rad), z = cat's-eye radius (rad), w = support (rad)
  more: vec4f,    // x = stretch along the axis, y = hollow, z = radius of the crescent cut (rad; 0 = none), w = its centre along the axis (rad)
  quad: vec4f,    // NDC bounds: xy = min, zw = max
}
struct FlareUniforms {
  count: vec4u,
  sun: vec4f,     // x = lens hood transmission, y = halo angle (rad), zw = unit axis-to-sun direction in the image plane (right, up)
  halo: vec4f,    // rgb = halo tint x energy x normalisation
  rays: vec4f,    // x = knee angle (rad), y = ray energy x normalisation, z = across sigma at the sun (rad), w = streak energy x normalisation
  lines: vec4f,   // x = fringe depth, y = 2 pi / fringe period (1/rad), z = streak fan, w = 1 / fringe reach (1/rad)
  blades: array<Blade, ${BLADE_COUNT}>,
  streaks: array<vec4f, ${STREAK_COUNT}>,   // x = azimuth (rad), y = amplitude, z = length (rad)
  ghosts: array<Ghost, ${GHOSTS.length}>,
}
@group(2) @binding(0) var<uniform> flare: FlareUniforms;
@group(2) @binding(1) var<storage, read> flareState: FlareState;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) index: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
  var q = vec4f(-1.0, -1.0, 1.0, 1.0);
  if (ii > 0u) { q = flare.ghosts[ii - 1u].quad; }
  o.pos = vec4f(mix(q.xy, q.zw, corner), 0.0, 1.0);
  o.index = ii;
  return o;
}

/// Unit view ray through an unjittered NDC point.
fn ndcRay(n: vec2f) -> vec3f {
  return normalize(frame.cameraForward.xyz + frame.cameraRight.xyz * (n.x * frame.cameraRight.w) + frame.cameraUp.xyz * (n.y * frame.cameraUp.w));
}
fn smooth01(x: f32) -> f32 { return smoothstep(0.0, 1.0, x); }

/// Light per unit length along a ray or streak of length 'len' at angle theta, per channel (flare.ts alongProfile).
fn alongProfile(theta: f32, len: f32) -> vec3f {
  let t = vec3f(theta) / SPIKE_LAMBDA;
  let w = max(vec3f(1.0) - (t / len) * (t / len), vec3f(0.0));
  let tk = t / flare.rays.x;
  return w * w / (vec3f(1.0) + tk * tk) / SPIKE_LAMBDA;
}

/// A ghost at tangent-plane point p (rad; right, up) from its centre (flare.ts ghostShape); c = lateral colour of
/// this image (0 for red and green, the ghost's for blue).
fn ghostShape(gh: Ghost, p: vec2f, axis: vec2f, c: f32) -> f32 {
  let R0 = gh.pos.z;
  let R = R0 * (1.0 + c);
  let s = gh.shape.x;
  let q0 = p - axis * (c * R0);
  let u = dot(q0, axis) / gh.more.x;
  let v = dot(q0, vec2f(-axis.y, axis.x));
  let q = axis * u + vec2f(-axis.y, axis.x) * v;
  var poly = -1.0e9;
  for (var b = 0; b < BLADE_COUNT; b++) { poly = max(poly, gh.pos.w * dot(q, flare.blades[b].dir.xy)); }
  let d = mix(poly, length(q) / POLY_EQ_CIRCLE, gh.shape.y);
  let mask = smooth01(0.5 - (d - R) / (2.0 * s));
  let rel = min(d / R, 1.0);
  let fill = (1.0 + gh.shape.z * (smooth01((rel - 0.55) / 0.45) - 0.5)) * (1.0 - gh.more.y * (1.0 - rel * rel));
  let grad = max(0.0, 1.0 + gh.shape.w * u);
  let dv = length(q0 + axis * gh.extra.y);
  var clip = smooth01(0.5 - (dv - gh.extra.z) / (2.0 * s));
  if (gh.more.z > 0.0) { clip *= smooth01(0.5 + (length(q0 - axis * gh.more.w) - gh.more.z) / (2.0 * s)); }
  return mask * fill * grad * clip;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let st = flareState;
  let source = frame.sunIlluminance.rgb * st.transmittance.rgb * (st.visible.x * st.visible.y * flare.sun.x);
  if (dot(source, source) <= 0.0) { discard; }
  // The ray this (jittered) pixel samples, as for the scene behind it.
  let uv = in.pos.xy * frame.renderSize.zw;
  let dir = normalize(viewRay(uv));
  let s = frame.sunDir.xyz;
  let theta = atan2(length(cross(dir, s)), dot(dir, s));
  // Nothing is added on the solar disc (including its anti-aliased rim): it is at HDR_MAX already, and the
  // ghosts of a source on the optical axis fall onto the source itself.
  if (theta < frame.sunDir.w + 1.5 * 2.0 * frame.cameraUp.w * frame.renderSize.w) { discard; }
  var L = vec3f(0.0);
  if (in.index == 0u) {
    let xh = theta / flare.sun.y;
    let vh = 1.0 + xh * xh;
    var lines = vec3f(0.0);
    if (theta < RAY_REACH) {
      // Azimuth about the sun in the image plane, from the camera's up towards its right.
      let toS = normalize(dir - s * dot(dir, s));
      let up = normalize(frame.cameraUp.xyz - s * dot(frame.cameraUp.xyz, s));
      let rt = cross(s, up);
      let phi = atan2(dot(toS, rt), dot(toS, up));
      let w0 = flare.rays.z;
      // Rays: the nearest of the fourteen. Rays 2b and 2b + BLADE_COUNT belong to blade b (both directions
      // perpendicular to its edge); the even one is its first ray.
      let seg = TWO_PI / f32(SPIKE_COUNT);
      let j = round(phi / seg);
      let m = (i32(j) + SPIKE_COUNT) % SPIKE_COUNT;
      let first = (m & 1) == 0;
      let blade = flare.blades[select((m + BLADE_COUNT) % SPIKE_COUNT, m, first) / 2];
      let across = theta * sin(phi - j * seg - blade.dir.z);
      let fan = blade.ray.y * theta;
      let sigma2 = w0 * w0 + fan * fan;
      // Fringes: in step at the sun for every wavelength, apart further out, washed out beyond a few bands.
      let xf = theta * flare.lines.w;
      let fringe = vec3f(1.0) + (flare.lines.x * exp(-xf * xf)) * cos(vec3f(theta * flare.lines.y) / SPIKE_LAMBDA);
      lines = (flare.rays.y * select(blade.ray.w, blade.ray.z, first) * exp(-0.5 * across * across / sigma2) / (2.5066282746 * sqrt(sigma2))) * alongProfile(theta, blade.ray.x) * fringe;
      // Streaks: this azimuth cell's and its neighbours'.
      let cell = TWO_PI / f32(STREAK_COUNT);
      let ci = clamp(i32(floor((phi + PI) / cell)), 0, STREAK_COUNT - 1);
      let sfan = flare.lines.z * theta;
      let ss2 = w0 * w0 + sfan * sfan;
      var streaks = vec3f(0.0);
      for (var k = -1; k <= 1; k++) {
        let sk = flare.streaks[(ci + k + STREAK_COUNT) % STREAK_COUNT];
        let ac = theta * sin(phi - sk.x);
        streaks += (sk.y * exp(-0.5 * ac * ac / ss2)) * alongProfile(theta, sk.z);
      }
      lines += streaks * (flare.rays.w / (2.5066282746 * sqrt(ss2)));
    }
    L = source * (flare.halo.rgb / (vh * sqrt(vh)) + lines);
  } else {
    let gh = flare.ghosts[in.index - 1u];
    let c = ndcRay(gh.pos.xy);
    let a = atan2(length(cross(dir, c)), dot(dir, c));
    if (a > gh.extra.w) { discard; }
    let upc = normalize(frame.cameraUp.xyz - c * dot(frame.cameraUp.xyz, c));
    let rtc = cross(c, upc);
    let tv = dir - c * dot(dir, c);
    let tvl = length(tv);
    var p = vec2f(0.0);
    if (tvl > 0.0) { p = vec2f(dot(tv, rtc), dot(tv, upc)) * (a / tvl); }
    let axis = flare.sun.zw;
    // Red and green share one image; the blue one is larger on the side away from the image centre.
    let img = ghostShape(gh, p, axis, 0.0);
    var blue = img;
    if (gh.extra.x > 0.0) { blue = ghostShape(gh, p, axis, gh.extra.x); }
    L = source * gh.tint.rgb * gh.tint.a * vec3f(img, img, blue);
  }
  return vec4f(capAdditive(L * frame.exposure.x), 0.0);
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
  centre: vec4f,   // xyz = body centre relative to the probe (ROOT, m), w = radius of the body's ground sphere in the probe (m; probeScene.ts probeGroundSphere)
  info: vec4f,     // x = frame body index, y = probe height above that sphere (m, from float64), z = weight in the probe (1 - planetshine weight), w = albedo map slot (-1 = mean colour)
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
/// origin at altitude h above it. Cancellation-free near the surface and from far away; the origin's radius is
/// taken as rs + h (float64 on the CPU), consistent with h to the last metre. -1 = miss.
fn hitSphere(d: vec3f, c: vec3f, h: f32, rs: f32) -> f32 {
  let r0 = rs + h;
  let up = -c / length(c);
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

/// Illuminance (lux, colour) of the direct sun on a surface facing it at radius r (normal n) of frame body bi:
/// eclipses and the atmosphere's transmittance; zero below the horizon. No cloud shadow.
fn sunDirect(bi: u32, selfIndex: u32, p: vec3f, n: vec3f, r: f32) -> vec3f {
  let sunDir = frame.bodies[bi].sunDir.xyz;
  let muS = dot(n, sunDir);
  let vis = sunVisibleAt(p, n, selfIndex, sunDir);
  if (vis <= 0.0 || muS <= 0.0) { return vec3f(0.0); }
  return frame.sunIlluminance.rgb * vis * atmosphereSunTransmittance(transmittanceLut, bi, r, muS);
}

/// Illuminance (lux, colour) on a horizontal surface element at radius r (normal n) of frame body bi from
/// everything but the direct sun: sky irradiance table + planetshine.
fn surfaceAmbient(bi: u32, n: vec3f, r: f32) -> vec3f {
  let b = frame.bodies[bi];
  let muS = dot(n, b.sunDir.xyz);
  var e = vec3f(0.0);
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

/// Cloud coverage averaged over the footprint of a probe texel on the cloud layer (radius rLayer) around unit
/// normal n: 4 x 4 taps over a patch 'across' m wide and 'along' m long in the direction of 'view' projected on
/// the layer (a texel's footprint grows with the distance and stretches towards the limb), each tap at the mip
/// that matches the tap spacing where the map has mips. A single tap is a point sample of a 5 km map texel under
/// a footprint of tens to hundreds of km: isolated white texels and a dashed limb in mirror reflections.
fn coverageOver(bi: u32, n: vec3f, view: vec3f, rLayer: f32, across: f32, along: f32) -> f32 {
  var ta = view - n * dot(view, n);
  let tl = length(ta);
  if (tl < 1e-4) {
    ta = normalize(cross(n, select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.9)));
  } else {
    ta = ta / tl;
  }
  let tb = cross(n, ta);
  let al = min(along, 0.6 * rLayer);
  let mapW = f32(textureDimensions(cloudCoverageMapTex).x);
  let lod = log2(max(0.25 * max(across, al) * mapW / (TWO_PI * rLayer), 1.0));
  var sum = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let o = (vec2f(f32(i), f32(j)) + vec2f(0.5)) * 0.25 - vec2f(0.5);
      let m = normalize(n + (ta * (o.x * al) + tb * (o.y * across)) / rLayer);
      sum += textureSampleLevel(cloudCoverageMapTex, linearRepeat, equirectUv(bi, m, frame.cloudFar.w), lod).r;
    }
  }
  return sum / 16.0;
}

/// Hapke reflectance x mu0 of a regolith surface (photometry.ts hapkeBrdfMu0; rendering-design 8.2), p = (b0, hS, bP, cP).
fn probeHapke(w: vec3f, mu0: f32, mu: f32, g: f32, p: vec4f) -> vec3f {
  let B = p.x / (1.0 + tan(g * 0.5) / p.y);
  let cg = cos(g);
  let P = 1.0 + p.z * cg + p.w * (1.5 * cg * cg - 0.5);
  let gam = sqrt(vec3f(1.0) - w);
  let H0 = (1.0 + 2.0 * mu0) / (vec3f(1.0) + 2.0 * mu0 * gam);
  let H = (1.0 + 2.0 * mu) / (vec3f(1.0) + 2.0 * mu * gam);
  return w / (4.0 * PI) * (mu0 / (mu0 + mu)) * ((1.0 + B) * P + H0 * H - 1.0);
}
/// Single-scattering albedo for an albedo-map value: the maps are normalised to incidence 30 deg, emission 0,
/// phase 30 deg (photometry.ts hapkeSingleScattering), bisection to 6e-5.
fn probeHapkeW(albedo: vec3f, p: vec4f) -> vec3f {
  let mu0 = 0.8660254;
  var lo = vec3f(0.0);
  var hi = vec3f(0.999999);
  for (var k = 0; k < 14; k++) {
    let mid = 0.5 * (lo + hi);
    let below = PI * probeHapke(mid, mu0, 1.0, 0.5235988, p) / mu0 < albedo;
    lo = select(lo, mid, below);
    hi = select(mid, hi, below);
  }
  return 0.5 * (lo + hi);
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
  // Light on the ground: the direct sun (per unit area facing it) and everything else (on the horizontal).
  let sunDir = b.sunDir.xyz;
  let muS = dot(n, sunDir);
  let muV = max(dot(n, -d), 1e-3);
  var direct = sunDirect(bi, i, p, n, R);
  let ambient = surfaceAmbient(bi, n, R);
  var L: vec3f;
  let clouds = i32(frame.cloudFar.x) == i32(bi) && frame.cloudFar.y > R;
  let footprintAcross = t * texelAngle;
  if (clouds && probeR > frame.cloudFar.y) {
    // Seen from above the layer: cloud tops (two-stream reflectance) over the ground (adding method).
    let tc = sphereCross(d, pb.centre.xyz, frame.cloudFar.y, false);
    let q = d * tc;
    let nq = normalize(q - pb.centre.xyz);
    let tau = coverageOver(bi, nq, d, frame.cloudFar.y, tc * texelAngle, tc * texelAngle / max(dot(nq, -d), 0.05)) * frame.cloudFar.z;
    let rc = cloudReflectance(tau);
    let eTop = sunDirect(bi, i, q, nq, frame.cloudFar.y) * max(dot(nq, sunDir), 0.0) + surfaceAmbient(bi, nq, frame.cloudFar.y);
    let ground = (1.0 - rc) * (1.0 - rc) * albedo / (vec3f(1.0) - rc * albedo);
    L = viewTransmittance(bi, d, frame.cloudFar.y, nq, probeR, probeUp) * eTop * (rc / PI)
      + viewTransmittance(bi, d, R, n, probeR, probeUp) * (direct * max(muS, 0.0) + ambient) * ground / PI;
  } else {
    if (clouds) {
      // Below the layer: the far cloud shadow of the render core, exp(-coverage tau / max(mu_s, 0.05)), over the
      // texel's footprint on the ground. Only the direct sun is shadowed; sky light and planetshine pass (the sky
      // table already holds the clouds' absence).
      let ts = sphereCross(sunDir, pb.centre.xyz - p, frame.cloudFar.y, true);
      let nq = normalize(p + sunDir * ts - pb.centre.xyz);
      direct *= exp(-coverageOver(bi, nq, d, frame.cloudFar.y, footprintAcross, footprintAcross / max(muV, 0.05)) * frame.cloudFar.z / max(muS, 0.05));
    }
    var reflected = (direct * max(muS, 0.0) + ambient) * albedo / PI;
    if ((bodyFlags(bi) & BODY_FLAG_HAPKE) != 0u) {
      // A regolith body: the sun through its Hapke function, as its terrain is shaded (opposition surge towards the
      // anti-solar point, no dark limb); the diffuse rest stays Lambert.
      let g = acos(clamp(dot(sunDir, -d), -1.0, 1.0));
      reflected = ambient * albedo / PI;
      if (muS > 0.0) { reflected += direct * probeHapke(probeHapkeW(albedo, b.hapke), muS, muV, g, b.hapke); }
    }
    L = viewTransmittance(bi, d, R, n, probeR, probeUp) * reflected;
  }
  return L + skyInScatter(d);
}

fn missRadiance(d: vec3f, texelAngle: f32) -> vec3f {
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
      let tau = coverageOver(bi, nq, d, frame.cloudFar.y, tc * texelAngle, tc * texelAngle / max(dot(d, nq), 0.05)) * frame.cloudFar.z;
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
    L = bodyRadiance(u32(hit), d, best, texelAngle) * w + missRadiance(d, texelAngle) * (1.0 - w);
  } else {
    L = missRadiance(d, texelAngle);
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
