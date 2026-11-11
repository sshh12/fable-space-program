/**
 * Core WGSL chunks, part 1: frame uniforms + bind group 0, fullscreen triangle, noise, G-buffer encoding.
 * The struct layouts here are mirrored by src/render/core/frame/uniforms.ts and documented in
 * docs/RENDER_API.md; change all three together.
 */
import { HDR_MAX, MATERIAL_ID, NEAR_PLANE, WATER_DEPTH_ENCODE_MAX } from '@/core/contracts/render';

export const MAX_BODIES = 4;
export const MAX_LIGHTS = 16;
/** Planetshine receivers: one per frame body plus one for "free space at the camera". */
export const SHINE_RECEIVERS = MAX_BODIES + 1;
export const SHINE_PER_RECEIVER = 2;
export const BLUE_NOISE_SIZE = 64;

export const BODY_FLAG = { star: 1, atmosphere: 2, ocean: 4, hapke: 8, terrain: 16 } as const;

export const FRAME_WGSL = /* wgsl */ `
const PI = 3.14159265358979;
const TWO_PI = 6.28318530717959;
const HDR_MAX = ${HDR_MAX.toFixed(1)};
const NEAR_PLANE = ${NEAR_PLANE};
const MAX_BODIES = ${MAX_BODIES}u;
const MAX_LIGHTS = ${MAX_LIGHTS}u;
const BODY_FLAG_STAR = ${BODY_FLAG.star}u;
const BODY_FLAG_ATMOSPHERE = ${BODY_FLAG.atmosphere}u;
const BODY_FLAG_OCEAN = ${BODY_FLAG.ocean}u;
const BODY_FLAG_HAPKE = ${BODY_FLAG.hapke}u;
const BODY_FLAG_TERRAIN = ${BODY_FLAG.terrain}u;

// One entry per FrameContext.bodies[i] (first MAX_BODIES bodies of the snapshot, same order). 256 bytes.
struct BodyUniform {
  center: vec4f,        // xyz = body centre relative to the camera (ROOT axes, m), w = reference radius (m)
  prevCenter: vec4f,    // xyz = centre relative to the PREVIOUS camera, w = atmosphere top radius (0 = no atmosphere)
  cameraUp: vec4f,      // xyz = unit vector from the body centre to the camera, w = camera distance from the centre (m)
  sunDir: vec4f,        // xyz = unit direction body -> star (ROOT axes), w = camera altitude above the reference radius (m, from float64)
  fixedX: vec4f,        // xyz = body-fixed +X axis in ROOT axes, w = atmosphere LUT layer (-1 = none)
  fixedY: vec4f,        // xyz = body-fixed +Y axis, w = sea-level radius (0 = no ocean)
  fixedZ: vec4f,        // xyz = body-fixed +Z axis (spin axis), w = flags (BODY_FLAG_*, as a float)
  meanColor: vec4f,     // rgb = BodyDef.render.meanColor, a = geometricAlbedo
  hapke: vec4f,         // b0, hS, bP, cP
  ocean: vec4f,         // rgb = absorption per metre, a = wind speed at 10 m (m/s)
  rayleigh: vec4f,      // rgb = Rayleigh scattering per metre, a = Rayleigh scale height (m)
  mie: vec4f,           // scattering, absorption (per metre), scale height (m), phase g
  ozone: vec4f,         // rgb = ozone absorption per metre, a = ozone layer centre altitude (m)
  misc: vec4f,          // ozone half width (m), ground albedo, cloud bottom radius, cloud top radius (0 = no clouds)
  reserved0: vec4f,
  reserved1: vec4f,
}

struct LightUniform {
  posRange: vec4f,      // xyz = camera-relative position, w = influence radius (m)
  endKind: vec4f,       // xyz = second end point (capsule; the position itself for point and spot), w = 0 point / 1 capsule / 2 spot
  intensity: vec4f,     // rgb = linear-sRGB luminous intensity (cd; on the beam axis for a spot), a = source radius (m)
  shape: vec4f,         // xy = octahedral-encoded unit beam axis (spot), z = cos(inner half angle), w = cos(outer half angle)
}

struct ShineLight {
  dir: vec4f,           // xyz = unit direction towards the shining body (ROOT axes), w = its frame body index (-1 = not a frame body)
  illuminance: vec4f,   // rgb = illuminance at the receiver (lux, unoccluded), a = angular radius of the shining body (rad)
}

struct FrameUniforms {
  view: mat4x4f,               // ROOT axes -> view, rotation only
  proj: mat4x4f,               // reversed-Z infinite, with TAA jitter
  projUnjittered: mat4x4f,
  viewProj: mat4x4f,           // proj * view (jittered): the matrix to rasterise with
  viewProjUnjittered: mat4x4f, // for motion vectors (current)
  prevViewProj: mat4x4f,       // unjittered, previous frame; apply to positions relative to the PREVIOUS eye
  cameraRight: vec4f,          // xyz (ROOT axes), w = tan(fovX / 2)
  cameraUp: vec4f,             // xyz, w = tan(fovY / 2)
  cameraForward: vec4f,        // xyz, w = near plane (m)
  prevEyeOffset: vec4f,        // xyz = previous eye - current eye (m, from float64)
  renderSize: vec4f,           // w, h, 1/w, 1/h of the internal render targets
  displaySize: vec4f,          // w, h, 1/w, 1/h of the canvas
  jitter: vec4f,               // xy = jitter in render pixels, zw = the same in NDC units (already in proj)
  time: vec4f,                 // realTime (s), realDt (s), frameIndex, animate (1 or 0)
  exposure: vec4f,             // exposure multiplier, ev100, qualityScale, renderScale
  sunDir: vec4f,               // xyz = unit direction to the star at the camera (ROOT axes), w = angular radius (rad)
  sunIlluminance: vec4f,       // rgb = colour * illuminance at the camera (lux, no occlusion), a = illuminance (lux)
  misc: vec4f,                 // x = map fill light fraction, y = sun visibility at the camera (0..1), zw = blue-noise offset (texels)
  counts: vec4u,               // x = body count, y = light count, z = frame index, w = star body index (or 0xffffffff)
  cloudNear0: vec4f,           // xyz = cloud shadow map origin relative to the camera, w = half extent (m, 0 = no map)
  cloudNear1: vec4f,           // xyz = unit U axis (ROOT), w = body index
  cloudNear2: vec4f,           // xyz = unit V axis (ROOT), w = optical depth scale
  cloudFar: vec4f,             // x = body index (-1 none), y = layer radius (m), z = optical depth at coverage 1, w = longitude offset (rad)
  bodies: array<BodyUniform, ${MAX_BODIES}>,
  shine: array<ShineLight, ${SHINE_RECEIVERS * SHINE_PER_RECEIVER}>,   // receiver r (body index, or MAX_BODIES for free space) owns [2r, 2r+1]
  lights: array<LightUniform, ${MAX_LIGHTS}>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var linearClamp: sampler;
@group(0) @binding(2) var linearRepeat: sampler;
@group(0) @binding(3) var nearestClamp: sampler;
@group(0) @binding(4) var shadowCompare: sampler_comparison;   // compare 'less-equal', linear
@group(0) @binding(5) var blueNoiseTex: texture_2d<f32>;       // ${BLUE_NOISE_SIZE} x ${BLUE_NOISE_SIZE} rgba8unorm, 4 decorrelated channels
@group(0) @binding(6) var anisoRepeat: sampler;                // trilinear, 8x anisotropic, repeat

/// Clamp a pre-exposed radiance for the HDR target: NaN and negatives -> 0, +Inf and anything above -> HDR_MAX.
/// Bit tests are used on purpose: WGSL compilers may assume NaN never occurs and fold x != x away.
fn writeHdr(rgb: vec3f) -> vec3f {
  let b = bitcast<vec3u>(rgb);
  let nonFinite = (b & vec3u(0x7f800000u)) == vec3u(0x7f800000u);
  let isNan = nonFinite & ((b & vec3u(0x007fffffu)) != vec3u(0u));
  let isNeg = (b & vec3u(0x80000000u)) != vec3u(0u);
  var c = select(rgb, vec3f(HDR_MAX), nonFinite);
  c = select(c, vec3f(0.0), isNan | isNeg);
  return min(c, vec3f(HDR_MAX));
}
fn writeHdr4(c: vec4f) -> vec4f {
  let a = writeHdr(vec3f(c.a, 0.0, 0.0)).x;
  return vec4f(writeHdr(c.rgb), min(a, 1.0));
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn saturate3(v: vec3f) -> vec3f { return clamp(v, vec3f(0.0), vec3f(1.0)); }
fn sq(x: f32) -> f32 { return x * x; }

/// Distance along the view axis (m) of a reversed-Z depth sample. Sky (depth 0) returns +large.
fn viewZFromDepth(depth: f32) -> f32 { return frame.cameraForward.w / max(depth, 1e-37); }

/// Unnormalised camera-relative ray through the centre of the pixel at 'uv' (render target UV, y down),
/// with unit component along the view axis; the TAA jitter is removed. pos = ray * viewZ.
fn viewRay(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) - frame.jitter.zw;
  return frame.cameraForward.xyz + frame.cameraRight.xyz * (ndc.x * frame.cameraRight.w) + frame.cameraUp.xyz * (ndc.y * frame.cameraUp.w);
}
/// Camera-relative position (ROOT axes, m) of a depth sample.
fn positionFromDepth(uv: vec2f, depth: f32) -> vec3f { return viewRay(uv) * viewZFromDepth(depth); }

/// Screen UV (y down) of a camera-relative position under the UNJITTERED projection, xy = uv, z = reversed depth, w = clip w.
fn projectToUv(posRelCam: vec3f) -> vec4f {
  let c = frame.viewProjUnjittered * vec4f(posRelCam, 1.0);
  let ndc = c.xyz / c.w;
  return vec4f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z, c.w);
}

/// Screen-space velocity (UV units, current - previous) from two UNJITTERED clip positions.
fn velocityFromClip(currClip: vec4f, prevClip: vec4f) -> vec2f {
  let a = currClip.xy / currClip.w;
  let b = prevClip.xy / prevClip.w;
  return (a - b) * vec2f(0.5, -0.5);
}

/// Four decorrelated blue-noise values in [0, 1) for a pixel; re-offset every frame while frame.time.w == 1.
fn blueNoise(pixel: vec2u) -> vec4f {
  let o = vec2u(frame.misc.zw);
  return textureLoad(blueNoiseTex, (pixel + o) % vec2u(${BLUE_NOISE_SIZE}u), 0);
}

fn bodyFlags(i: u32) -> u32 { return u32(frame.bodies[i].fixedZ.w); }

/// Index of the body whose surface is nearest to a camera-relative point (stars excluded); -1 when the frame has none.
fn nearestBody(posRelCam: vec3f) -> i32 {
  var best = -1;
  var bestAlt = 3.0e38;
  for (var i = 0u; i < frame.counts.x; i++) {
    if ((bodyFlags(i) & BODY_FLAG_STAR) != 0u) { continue; }
    let alt = distance(posRelCam, frame.bodies[i].center.xyz) - frame.bodies[i].center.w;
    if (alt < bestAlt) { bestAlt = alt; best = i32(i); }
  }
  return best;
}

/// ROOT-axes vector -> body-fixed axes of body i (rotation only).
fn rootToFixed(i: u32, v: vec3f) -> vec3f {
  return vec3f(dot(v, frame.bodies[i].fixedX.xyz), dot(v, frame.bodies[i].fixedY.xyz), dot(v, frame.bodies[i].fixedZ.xyz));
}
`;

export const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
/// One triangle covering the target; uv has y down (texel (0,0) is the top-left corner). Draw with 3 vertices.
@vertex fn fullscreenVs(@builtin(vertex_index) i: u32) -> FullscreenOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FullscreenOut;
  o.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

export const NOISE_WGSL = /* wgsl */ `
#include "hash"
fn hash3f(p: vec3i, seed: i32) -> f32 { return hash_to_unit(hash4(p.x, p.y, p.z, seed)); }
fn hash2f(p: vec2i, seed: i32) -> f32 { return hash_to_unit(hash4(p.x, p.y, 0, seed)); }
/// Value noise in [0, 1], C1-continuous, lattice period 2^32 (wraps without a seam for integer-valued periods).
fn valueNoise3(p: vec3f, seed: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash3f(i, seed), hash3f(i + vec3i(1, 0, 0), seed), u.x);
  let b = mix(hash3f(i + vec3i(0, 1, 0), seed), hash3f(i + vec3i(1, 1, 0), seed), u.x);
  let c = mix(hash3f(i + vec3i(0, 0, 1), seed), hash3f(i + vec3i(1, 0, 1), seed), u.x);
  let d = mix(hash3f(i + vec3i(0, 1, 1), seed), hash3f(i + vec3i(1, 1, 1), seed), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
fn gradDir3(i: vec3i, seed: i32) -> vec3f {
  let h = hash4(i.x, i.y, i.z, seed);
  let z = hash_to_unit(h) * 2.0 - 1.0;
  let a = hash_to_unit(hash_u32(h)) * 6.28318530718;
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(a), r * sin(a), z);
}
/// Gradient (Perlin-style) noise in about [-1, 1].
fn gradientNoise3(p: vec3f, seed: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var n: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    n[k] = dot(gradDir3(i + o, seed), f - vec3f(o));
  }
  let x0 = mix(n[0], n[1], u.x);
  let x1 = mix(n[2], n[3], u.x);
  let x2 = mix(n[4], n[5], u.x);
  let x3 = mix(n[6], n[7], u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z) * 1.6;
}
/// Fractal sum of gradient noise, 'octaves' <= 8, lacunarity 2, gain 0.5; result in about [-1, 1].
fn fbm3(p: vec3f, octaves: i32, seed: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var o = 0; o < octaves; o++) {
    s += a * gradientNoise3(q, seed + o);
    q *= 2.0;
    a *= 0.5;
  }
  return s;
}
/// Jimenez interleaved gradient noise in [0, 1) (cheap per-pixel dither when blue noise is not bound).
fn interleavedGradientNoise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}
`;

export const GBUFFER_WGSL = /* wgsl */ `
const MATERIAL_STANDARD = ${MATERIAL_ID.standard}u;
const MATERIAL_TERRAIN = ${MATERIAL_ID.terrain}u;
const MATERIAL_REGOLITH = ${MATERIAL_ID.regolith}u;
const MATERIAL_WATER = ${MATERIAL_ID.water}u;
const MATERIAL_CLOTH = ${MATERIAL_ID.cloth}u;
const MATERIAL_DISPLAY = ${MATERIAL_ID.display}u;
const WATER_DEPTH_ENCODE_MAX = ${WATER_DEPTH_ENCODE_MAX.toFixed(1)};

/// Octahedral encoding of a unit vector into [-1, 1]^2 (stored as rg16float).
fn octEncode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  let s = vec2f(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
  return select((1.0 - abs(p.yx)) * s, p, n.z >= 0.0);
}
fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

/// Canonical tangent frame of a unit normal (columns: tangent, bitangent, normal). Continuous everywhere
/// except at n = (0, 0, -1). RT4.r stores a tangent as its angle in this frame.
fn tangentFrame(n: vec3f) -> mat3x3f {
  if (n.z < -0.99999) { return mat3x3f(vec3f(0.0, -1.0, 0.0), vec3f(-1.0, 0.0, 0.0), n); }
  let a = 1.0 / (1.0 + n.z);
  let b = -n.x * n.y * a;
  return mat3x3f(vec3f(1.0 - n.x * n.x * a, b, -n.x), vec3f(b, 1.0 - n.y * n.y * a, -n.y), n);
}
/// Angle / 2 pi of tangent 't' about normal 'n' in the canonical frame, in [0, 1).
fn encodeTangentAngle(n: vec3f, t: vec3f) -> f32 {
  let f = tangentFrame(n);
  return fract(atan2(dot(t, f[1]), dot(t, f[0])) / TWO_PI + 1.0);
}
fn decodeTangentAngle(n: vec3f, enc: f32) -> vec3f {
  let f = tangentFrame(n);
  let a = enc * TWO_PI;
  return f[0] * cos(a) + f[1] * sin(a);
}

/// Water depth (m) <-> RT2.a for MATERIAL_WATER.
fn encodeWaterDepth(depth: f32) -> f32 { return sqrt(clamp(depth / WATER_DEPTH_ENCODE_MAX, 0.0, 1.0)); }
fn decodeWaterDepth(enc: f32) -> f32 { return enc * enc * WATER_DEPTH_ENCODE_MAX; }

/// Fragment output of every drawGBuffer pipeline (targets in this order).
struct GBufferOut {
  @location(0) albedo: vec4f,     // rgba8unorm-srgb: rgb = base colour (write LINEAR; the target encodes), a = baked AO / cavity
  @location(1) normal: vec2f,     // rg16float: octEncode(world normal, ROOT axes)
  @location(2) material: vec4f,   // rgba8unorm: perceptual roughness, metallic, material id / 255, material parameter
  @location(3) velocity: vec2f,   // rg16float: UV-space velocity (current - previous)
  @location(4) extra: vec4f,      // rgba8unorm: tangent angle, anisotropy * 0.5 + 0.5, clearcoat, clearcoat roughness
  @location(5) emissive: vec4f,   // rgba16float: pre-exposed emitted radiance through writeHdr(); a = 1
}

/// Pack a surface. 'emissivePreExposed' is cd/m^2 * frame.exposure.x. RT4 gets the neutral value (0, 0.5, 0, 0).
fn gbufferPack(albedo: vec3f, ao: f32, n: vec3f, roughness: f32, metallic: f32, materialId: u32, param: f32,
               velocity: vec2f, emissivePreExposed: vec3f) -> GBufferOut {
  var o: GBufferOut;
  o.albedo = vec4f(albedo, ao);
  o.normal = octEncode(n);
  o.material = vec4f(roughness, metallic, f32(materialId) / 255.0, param);
  o.velocity = velocity;
  o.extra = vec4f(0.0, 0.5, 0.0, 0.0);
  o.emissive = vec4f(writeHdr(emissivePreExposed), 1.0);
  return o;
}
/// RT4 for MATERIAL_STANDARD: unit tangent (ROOT axes), anisotropy -1..1, clearcoat weight and perceptual roughness.
fn gbufferExtra(n: vec3f, tangent: vec3f, anisotropy: f32, clearcoat: f32, clearcoatRoughness: f32) -> vec4f {
  return vec4f(encodeTangentAngle(n, tangent), anisotropy * 0.5 + 0.5, clearcoat, clearcoatRoughness);
}

struct GBufferPixel {
  albedo: vec3f,
  ao: f32,
  normal: vec3f,
  roughness: f32,
  metallic: f32,
  materialId: u32,
  param: f32,
  tangent: vec3f,
  anisotropy: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
}
/// Decode texels loaded from RT0 (already linear), RT1, RT2 and RT4.
fn gbufferUnpack(albedoTexel: vec4f, normalTexel: vec4f, materialTexel: vec4f, extraTexel: vec4f) -> GBufferPixel {
  var g: GBufferPixel;
  g.albedo = albedoTexel.rgb;
  g.ao = albedoTexel.a;
  g.normal = octDecode(normalTexel.xy);
  g.roughness = materialTexel.r;
  g.metallic = materialTexel.g;
  g.materialId = u32(materialTexel.b * 255.0 + 0.5);
  g.param = materialTexel.a;
  g.tangent = decodeTangentAngle(g.normal, extraTexel.r);
  g.anisotropy = extraTexel.g * 2.0 - 1.0;
  if (abs(g.anisotropy) < 0.01) { g.anisotropy = 0.0; }
  g.clearcoat = extraTexel.b;
  g.clearcoatRoughness = extraTexel.a;
  return g;
}
`;
