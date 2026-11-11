/**
 * The unified per-pixel atmosphere march (half resolution) and its composite into the HDR target.
 *
 * March: one ray per half-resolution pixel through every atmosphere body it crosses (up to two), from the
 * eye to the farthest scene depth of its 2 x 2 block. The state of the path is also recorded at the cloud
 * depth of the pixel and at the nearest depth of the block, so the pass yields two complete candidates:
 *   far  = everything behind the farthest surface of the block,
 *   near = everything behind its nearest surface,
 * each as (add, mul) with  final = add + mul x scene.  Clouds are folded in here:
 *   add = inscatterFront + T_toCloud L_cloud + T_cloud inscatterBack,   mul = T_cloud T_total.
 *
 * Composite: per full-resolution pixel, each of the four surrounding half-resolution texels gives its two
 * candidates; the value at the pixel's own depth is interpolated between them, the taps are blended with
 * bilinear x depth-agreement weights (nearest-depth fallback), and one dual-source blend writes
 * add + mul x destination.
 */
import { ATMO_UNIFORM_WGSL } from '../uniforms';

/**
 * Chunk "atmosphere_cloud_shadow": needs `atmo`, `atmoShadowTex` (the MOMENT map of the cloud shadow pass:
 * r = optical depth of the direct beam along the sun line, g, b = r x mean and mean squared altitude of the
 * extinction, altitudes as fractions of the cloud shell) and `atmoCoverageTex` declared by the includer.
 */
export const CLOUD_SHADOW_WGSL = /* wgsl */ `
/// Optical depth of the cloud between a camera-relative point of body 'bi' and the sun, along the sun line.
/// 'up' = local vertical at the point, r = its radius, muS = dot(up, sun direction). Near the camera the
/// moment map gives a depth-resolved answer (the share of a line's extinction that lies above the point's
/// altitude; the three moments interpolate, so a lookup across a cloud edge is a thinner cloud, not a
/// ramp of unlike quantities); beyond it the coverage map at the point where the sun ray leaves the layer.
/// 'lod' = level of the moment map: 0 = its texels, higher = blurred (the penumbra far from the cloud, and
/// all that a few samples along a sight line can carry).
fn atmoCloudTauAt(pos: vec3f, bi: u32, up: vec3f, r: f32, muS: f32, lod: f32) -> f32 {
  if (i32(bi) != atmo.bodies.z || r >= atmo.cloudShell.y) { return 0.0; }
  let m = max(muS, 0.05);
  // The near map first: inside it (all but its outer eighth) the coverage map is not needed at all.
  var nearTau = 0.0;
  var nearW = 0.0;
  let he = atmo.shadowOrigin.w;
  if (he > 0.0) {
    let rel = pos - atmo.shadowOrigin.xyz;
    let q = vec2f(dot(rel, atmo.shadowU.xyz), dot(rel, atmo.shadowV.xyz)) / he;
    let edge = 1.0 - max(abs(q.x), abs(q.y));
    if (edge > 0.0) {
      let b = textureSampleLevel(atmoShadowTex, linearClamp, q * 0.5 + 0.5, lod);
      if (b.r > 1e-4) {
        let mean = b.g / b.r;
        let sd = sqrt(max(b.b / b.r - mean * mean, 1e-5));
        let hn = (r - atmo.cloudShell.x) / (atmo.cloudShell.y - atmo.cloudShell.x);
        // (The extinction of a line spread evenly over mean +- sqrt(3) sd; a small floor keeps a thin
        // layer from becoming a step.)
        nearTau = b.r * saturate(0.5 + (mean - hn) / (3.4641 * sd + 0.02)) * atmo.shadowV.w / m;
      }
      nearW = saturate(edge * 8.0);
      if (nearW >= 1.0) { return nearTau; }
    }
  }
  var farTau = 0.0;
  if (atmo.far.w > 0.5 && r < atmo.far.x) {
    let sunDir = frame.bodies[bi].sunDir.xyz;
    let bq = r * muS;
    let t = -bq + sqrt(max(bq * bq + (atmo.far.x - r) * (atmo.far.x + r), 0.0));
    let dfix = normalize(rootToFixed(bi, up * r + sunDir * t));
    let lon = atan2(dfix.y, dfix.x) + atmo.far.z;
    let uv = vec2f(fract(lon / TWO_PI + 0.5), acos(clamp(dfix.z, -1.0, 1.0)) / PI);
    // Points well below the layer are under all of it; inside the layer the term fades out towards the
    // layer radius instead of switching. (Read at the size of the pixel that asks: from far away one pixel
    // covers many texels of the map. The map's coverage is an opacity: the optical depth of the direct beam
    // grows steeply with it.)
    let lod = max(log2(length(pos) * atmo.cloudMarch.w * atmo.noiseRot.w / (TWO_PI * frame.bodies[bi].center.w)), 0.0);
    let c = textureSampleLevel(atmoCoverageTex, linearClamp, uv, lod).r;
    farTau = c * (1.0 + 7.0 * c) * atmo.far.y / m * saturate((atmo.far.x - r) / 600.0);
  }
  return mix(farTau, nearTau, nearW);
}

/// Share of the sun's illuminance that passes a cloud of optical depth tau along the sun line: x = in the
/// direct beam, y = in the beam and diffusely together (two-stream, plus the light that the lit sides of the
/// clouds around send into a shadow: 8 % of the sun's). The ground under an overcast is dim, not black.
fn atmoCloudPass(tau: f32) -> vec2f {
  let direct = exp(-tau);
  return vec2f(direct, min(direct + (1.0 - direct) * (1.0 / (1.0 + atmo.cloudLight.y * tau) + 0.08), 1.0));
}

/// Transmittance of the cloud layer between a point and the sun (direct beam; 1 = none).
fn atmoCloudShadowAt(pos: vec3f, bi: u32, up: vec3f, r: f32, muS: f32) -> f32 {
  return exp(-atmoCloudTauAt(pos, bi, up, r, muS, 0.0));
}

/// atmoCloudPass for the point at distance s along the path of 'ray' (camera ray d); (1, 1) for bodies
/// without clouds.
fn atmoCloudPassOnRay(bi: u32, d: vec3f, ray: AtmoRay, s: f32) -> vec2f {
  if (i32(bi) != atmo.bodies.z) { return vec2f(1.0); }
  let pos = d * (ray.t0 + s);
  let up = normalize(pos - frame.bodies[bi].center.xyz);
  return atmoCloudPass(atmoCloudTauAt(pos, bi, up, frame.bodies[bi].center.w + max(atmoRayAltitude(ray, s), 0.0), dot(up, frame.bodies[bi].sunDir.xyz), 2.5));
}

/// What the air at a point under cloud scatters towards the eye, given its clear-sky source terms: the
/// singly scattered sunlight is that of the light the cloud lets through (beam and diffuse), and the
/// multiply scattered light, which comes from the whole sky, keeps a floor and follows the same share.
fn atmoCloudedSource(direct: vec3f, multi: vec3f, passed: vec2f) -> vec3f {
  return direct * passed.y + multi * (0.3 + 0.7 * passed.y);
}
`;

/**
 * The march. Bindings (group 1): 0 = AtmoU, 1 = transmittance, 2 = multi-scattering (texture_2d_array),
 * 3 = cloud shadow map, 4 = coverage map, 5 = 'scene.depthHalf', 6 = cloud radiance / transmittance,
 * 7 = cloud geometry (begin, end, mean distance), 8 = 'scene.depth'.
 *
 * `fine` = false: the half-resolution march described above (four targets: far and near candidates).
 * `fine` = true: one ray per FULL-resolution pixel of the rectangle `atmo.tile` into two tile targets
 * (add, mul), to the pixel's own depth, with the buffers of the full-resolution cloud march read texel for
 * texel. Used while the shells in view fit into the tile (a planet seen from afar): there one
 * half-resolution texel spans hundreds of kilometres, more than the whole atmosphere is deep, and neither
 * the two-candidate interpolation nor a bilinear cloud lookup across the silhouette means anything.
 */
export function marchFsWgsl(fine: boolean): string {
  return /* wgsl */ `
#include "atmosphere_model"
${ATMO_UNIFORM_WGSL}
@group(1) @binding(0) var<uniform> atmo: AtmoU;
@group(1) @binding(1) var transLut: texture_2d_array<f32>;
@group(1) @binding(2) var msLut: texture_2d_array<f32>;
@group(1) @binding(3) var atmoShadowTex: texture_2d<f32>;
@group(1) @binding(4) var atmoCoverageTex: texture_2d<f32>;
@group(1) @binding(5) var depthHalfTex: texture_2d<f32>;
@group(1) @binding(6) var cloudTex: texture_2d<f32>;
@group(1) @binding(7) var cloudGeomTex: texture_2d<f32>;
@group(1) @binding(8) var sceneDepthTex: texture_depth_2d;
#include "atmosphere_cloud_shadow"

/// Distance along the centre ray d of a 2 x 2 block that stands for the surface point of one of its pixels
/// (that pixel's own ray dp, distance tp). Near the camera the two rays are the same path and the distance
/// is kept. Far away half a block of lateral offset moves the end point by kilometres of altitude (a planet
/// seen from space: the centre ray would stop short of the ground, or run on below it), and what the path
/// collects depends on the altitude it ends at: there the point of EQUAL ALTITUDE on the centre ray is taken.
fn marchEquivalent(bi: u32, ray: AtmoRay, tp: f32, dp: vec3f) -> vec2f {
  let rayP = atmoRay(bi, dp);
  let sp = tp - rayP.t0;
  let sc = tp - ray.t0;
  // A surface point outside the shell on either ray: the atmosphere does not see the difference.
  if (rayP.len <= 0.0 || ray.len <= 0.0 || sp <= 0.0 || sc <= 0.0) { return vec2f(tp, 3.0e38); }
  let hp = atmoRayAltitude(rayP, sp);
  let w = smoothstep(50.0, 400.0, abs(atmoRayAltitude(ray, sc) - hp));
  if (w <= 0.0) { return vec2f(tp, hp); }
  let roots = atmoRaySphere(ray.r, ray.h - hp, ray.mu, frame.bodies[bi].center.w + hp);
  // The centre ray never reaches that altitude (a block across the limb): its lowest point stands in.
  var s = max(-ray.r * ray.mu, 0.0);
  if (roots.y >= roots.x) {
    s = roots.x;
    if (abs(roots.y - sc) < abs(roots.x - sc)) { s = roots.y; }
  }
  if (s <= 0.0) { return vec2f(tp, hp); }
  return vec2f(mix(tp, ray.t0 + s, w), hp);
}

const HDR_SLACK = 8.0;

struct MarchOut {
  @location(0) addFar: vec4f,
  @location(1) mulFar: vec4f,
${
  fine
    ? ''
    : `  @location(2) addNear: vec4f,
  @location(3) mulNear: vec4f,`
}
}

@fragment fn fs(in: FullscreenOut) -> MarchOut {
${
  fine
    ? `  // The full-resolution pixel of this tile texel, its own ray and its own depth.
  let tp = vec2i(in.position.xy);
  let pix = tp + vec2i(atmo.tile.xy);
  let ray = viewRay((vec2f(pix) + 0.5) * frame.renderSize.zw);
  let len = length(ray);
  let d = ray / len;
  let tFar = viewZFromDepth(textureLoad(sceneDepthTex, pix, 0)) * len;
  let tNear = tFar;
  let cloudSize = vec2i(textureDimensions(cloudGeomTex));
  let ctp = min(tp, cloudSize - 1);
  let cloud = textureLoad(cloudTex, ctp, 0);
  let cloudGeom = textureLoad(cloudGeomTex, ctp, 0).rgb;`
    : `  let pix = vec2i(in.position.xy);
  let dh = textureLoad(depthHalfTex, pix, 0).rg;
  let ray = viewRay(in.uv);
  let len = length(ray);
  let d = ray / len;
  var tFar = viewZFromDepth(dh.r) * len;
  var tNear = viewZFromDepth(dh.g) * len;
  var hNear = 3.0e38;   // altitude of the nearest surface point of the block above body 0 (when it is in its shell)
  let nearSpread = min(tFar - tNear, 0.25 * tNear);
  if (dh.r != dh.g && atmo.bodies.x >= 0) {
    // Which pixels of the block hold its nearest and its farthest depth, and what stands for them on this ray.
    let full = vec2i(textureDimensions(sceneDepthTex));
    var offNear = vec2i(0);
    var offFar = vec2i(0);
    for (var k = 0; k < 4; k++) {
      let o = vec2i(k & 1, k >> 1);
      let z = textureLoad(sceneDepthTex, min(pix * 2 + o, full - 1), 0);
      if (z == dh.g) { offNear = o; }
      if (z == dh.r) { offFar = o; }
    }
    let b0 = u32(atmo.bodies.x);
    let ray0 = atmoRay(b0, d);
    let rayNear = viewRay((vec2f(pix * 2 + offNear) + 0.5) * frame.renderSize.zw);
    let eqNear = marchEquivalent(b0, ray0, viewZFromDepth(dh.g) * length(rayNear), normalize(rayNear));
    tNear = eqNear.x;
    hNear = eqNear.y;
    if (dh.r > 0.0) {
      let rayFar = viewRay((vec2f(pix * 2 + offFar) + 0.5) * frame.renderSize.zw);
      tFar = max(marchEquivalent(b0, ray0, viewZFromDepth(dh.r) * length(rayFar), normalize(rayFar)).x, tNear);
    }
  }
  // The cloud buffers live on the unjittered pixel lattice: look them up where this (jittered) ray points.
  let uvCloud = in.uv - frame.jitter.xy * frame.renderSize.zw;
  let cloudSize = vec2i(textureDimensions(cloudGeomTex));
  let cloud = textureSampleLevel(cloudTex, linearClamp, uvCloud, 0.0);
  // r = where the cloud begins along the ray, g = where it ends, b = its opacity-weighted mean distance:
  // read with the same four texels and weights as the radiance (over those that hold a cloud), so that
  // wherever the radiance has cloud there is a distance for it, and the far and the near candidate below
  // agree about it.
  let cst = uvCloud * vec2f(cloudSize) - 0.5;
  let cfr = cst - floor(cst);
  var geomSum = vec3f(0.0);
  var geomW = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let g = textureLoad(cloudGeomTex, clamp(vec2i(floor(cst)) + o, vec2i(0), cloudSize - 1), 0).rgb;
    let w = select(1.0 - cfr.x, cfr.x, o.x == 1) * select(1.0 - cfr.y, cfr.y, o.y == 1);
    if (g.b < 1.0e37) { geomSum += g * w; geomW += w; }
  }
  var cloudGeom = vec3f(3.0e38);
  if (geomW > 1e-4) { cloudGeom = geomSum / geomW; }`
}
  let tCloud = cloudGeom.b;
  let xi = blueNoise(vec2u(pix)).x;

  // Two points along the ray at which the path state is recorded, in order of distance.
  let cloudFirst = tCloud <= tNear;
  var evT = array<f32, 2>(min(tCloud, tNear), max(tCloud, tNear));
  var evL = array<vec3f, 2>(vec3f(0.0), vec3f(0.0));
  var evTr = array<vec3f, 2>(vec3f(1.0), vec3f(1.0));
  var evDone = array<bool, 2>(false, false);

  var L = vec3f(0.0);
  var T = vec3f(1.0);
  for (var a = 0; a < 2; a++) {
    let bix = atmo.bodies[a];
    if (bix < 0) { continue; }
    let bi = u32(bix);
    let ray = atmoRay(bi, d);
    // Path of this body in distances from its start: up to the scene surface.
    let sEnd = min(ray.len, tFar - ray.t0);
    if (sEnd <= 0.0) { continue; }
    for (var e = 0; e < 2; e++) {
      if (!evDone[e] && evT[e] <= ray.t0) { evL[e] = L; evTr[e] = T; evDone[e] = true; }
    }
    let n = max(i32(atmo.steps[a]), 4);
    let cosSun = dot(d, frame.bodies[bi].sunDir.xyz);
    let phase = vec2f(atmoPhaseR(cosSun), atmoPhaseM(cosSun, frame.bodies[bi].mie.w));
    var cdf = atmoBuildCdf(bi, ray, 0.0, sEnd);
    let othersA = atmoOtherVisibility(d * ray.t0, frame.bodies[bi].sunDir.xyz, bi);
    let othersB = atmoOtherVisibility(d * (ray.t0 + sEnd), frame.bodies[bi].sunDir.xyz, bi);
    var sPrev = 0.0;
    var kLo = 0;   // knot interval in which the current stratum begins
    for (var i = 0; i < n; i++) {
      let kHere = kLo;
      var sNext = sEnd;
      if (i < n - 1) {
        kLo = atmoCdfInterval(&cdf, f32(i + 1) / f32(n), kLo);
        sNext = atmoCdfAt(&cdf, f32(i + 1) / f32(n), kLo);
      }
      // The medium and the smooth part of the light are taken at the middle of the stratum: no noise in a
      // clear sky. Only the cloud shadow, which has edges, is looked up at a blue-noise position inside the
      // stratum (a different one for every sample: golden-ratio sequence), so shafts dither instead of band.
      let sm = atmoInvCdf(&cdf, (f32(i) + 0.5) / f32(n), kHere);
      let o = atmoSampleAt(transLut, msLut, bi, atmo.layers[a], d, ray, sm, phase, mix(othersA, othersB, sm / sEnd));
      var src = o.direct + o.multi;
      if (bix == atmo.bodies.z) {
        let sj = atmoInvCdf(&cdf, (f32(i) + fract(0.5 + (xi - 0.5) * frame.time.w + f32(i) * 0.61803398875)) / f32(n), kHere);
        src = atmoCloudedSource(o.direct, o.multi, atmoCloudPassOnRay(bi, d, ray, sj));
      }
      var segA = sPrev;
      for (var e = 0; e < 2; e++) {
        if (!evDone[e] && evT[e] - ray.t0 < sNext) {
          let cut = max(evT[e] - ray.t0, segA);
          let dtc = cut - segA;
          L += T * src * atmoSegment(o.ext, dtc);
          T *= exp(-o.ext * dtc);
          evL[e] = L;
          evTr[e] = T;
          evDone[e] = true;
          segA = cut;
        }
      }
      let dt = sNext - segA;
      L += T * src * atmoSegment(o.ext, dt);
      T *= exp(-o.ext * dt);
      sPrev = sNext;
    }
  }
  for (var e = 0; e < 2; e++) {
    if (!evDone[e]) { evL[e] = L; evTr[e] = T; }
  }

  let iCloud = select(1, 0, cloudFirst);
  let iNear = 1 - iCloud;
  let ex = frame.exposure.x;
  let cap = vec3f(HDR_MAX);

  // Far candidate: the whole path, with the cloud at its depth.
  let Lc = evL[iCloud];
  let Tc = evTr[iCloud];
  let mulFar = T * cloud.a;
  let addFar = (Lc + (L - Lc) * cloud.a) * ex + Tc * cloud.rgb;

  var o: MarchOut;
  // add + mul x HDR_MAX never exceeds HDR_MAX by more than HDR_SLACK: the blended result stays inside the
  // HDR range (the half-float target has steps of 32 at HDR_MAX, so the slack cannot even be stored). The
  // slack is there for the thinnest air: where 1 - mul is below float32 resolution a bound without it would
  // erase the glow of the upper atmosphere one colour channel at a time.
  o.mulFar = vec4f(saturate3(mulFar), 1.0);
  o.addFar = vec4f(min(writeHdr(addFar), max(cap * (vec3f(1.0) - o.mulFar.rgb), vec3f(HDR_SLACK))), 1.0);
${
  fine
    ? ''
    : `  // Near candidate: the path up to the nearest surface of the block; the cloud only if it lies in front of it.
  let Ln = evL[iNear];
  let Tn = evTr[iNear];
  // Is the nearest surface behind the cloud? By distance: it lies beyond where the cloud ends (with a
  // margin for the cloud having been marched along a ray half a pixel away: half the depth range of the
  // block). Where altitude decides it outright it does: a surface under the layer is behind every cloud
  // seen from above the layer, and in front of every cloud seen from under it.
  var behind = saturate((tNear + 0.5 * nearSpread - cloudGeom.r) / max(cloudGeom.g - cloudGeom.r, 1.0));
  // From anywhere above the cloud base: a cloud that begins nearer than the surface is in front of it (the
  // ray is under the base before it reaches the surface). Without this, a cloud end interpolated from a
  // neighbouring texel whose surface lies further away would put part of the cloud behind this one: the
  // near and the far candidate would then disagree, and the rows of a block with them.
  if (atmo.bodies.z >= 0 && atmo.bodies.z == atmo.bodies.x && hNear < atmo.cloudShell.z) {
    let h0 = frame.bodies[u32(atmo.bodies.x)].sunDir.w;
    if (h0 < atmo.cloudShell.z) { behind = 0.0; } else if (cloudGeom.r < tNear) { behind = 1.0; }
  }
  let Lcn = min(Lc, Ln);
  let Tcn = max(Tc, Tn);
  let mulNear = Tn * (1.0 + (cloud.a - 1.0) * behind);
  let addNear = mix(Ln * ex, (Lcn + (Ln - Lcn) * cloud.a) * ex + Tcn * cloud.rgb, behind);

  o.mulNear = vec4f(saturate3(mulNear), 1.0);
  o.addNear = vec4f(min(writeHdr(addNear), max(cap * (vec3f(1.0) - o.mulNear.rgb), vec3f(HDR_SLACK))), 1.0);`
}
  return o;
}
`;
}

function compositeOutWgsl(mode: 'dual' | 'mul' | 'add'): string {
  return mode === 'dual'
    ? /* wgsl */ `struct CompositeOut {
  @location(0) @blend_src(0) add: vec4f,
  @location(0) @blend_src(1) mul: vec4f,
}
fn pack(add: vec3f, mul: vec3f) -> CompositeOut { return CompositeOut(vec4f(add, 1.0), vec4f(mul, 1.0)); }`
    : /* wgsl */ `struct CompositeOut { @location(0) color: vec4f }
fn pack(add: vec3f, mul: vec3f) -> CompositeOut { return CompositeOut(vec4f(${mode === 'mul' ? 'mul' : 'add'}, 1.0)); }`;
}

/**
 * Composite of the full-resolution tile march: the tile texel of the pixel, as it is. Bindings (group 1):
 * 0 = AtmoU, 1 = add, 2 = mul (tile targets). `mode` as for compositeFsWgsl.
 */
export function compositeFineFsWgsl(mode: 'dual' | 'mul' | 'add'): string {
  return /* wgsl */ `${mode === 'dual' ? 'enable dual_source_blending;' : ''}
#include "frame"
#include "fullscreen"
${ATMO_UNIFORM_WGSL}
@group(1) @binding(0) var<uniform> atmo: AtmoU;
@group(1) @binding(1) var addTex: texture_2d<f32>;
@group(1) @binding(2) var mulTex: texture_2d<f32>;
${compositeOutWgsl(mode)}

@fragment fn fs(in: FullscreenOut) -> CompositeOut {
  let tp = vec2i(in.position.xy) - vec2i(atmo.tile.xy);
  return pack(textureLoad(addTex, tp, 0).rgb, textureLoad(mulTex, tp, 0).rgb);
}
`;
}

/**
 * Composite fragment shader. Bindings (group 1): 0..3 = addFar, mulFar, addNear, mulNear (half res),
 * 4 = 'scene.depthHalf', 5 = 'scene.depth'. `mode`: 'dual' = one draw with dual-source blending,
 * 'mul' / 'add' = the two draws of the fallback.
 */
export function compositeFsWgsl(mode: 'dual' | 'mul' | 'add'): string {
  const out = compositeOutWgsl(mode);
  return /* wgsl */ `${mode === 'dual' ? 'enable dual_source_blending;' : ''}
#include "frame"
#include "fullscreen"
@group(1) @binding(0) var addFarTex: texture_2d<f32>;
@group(1) @binding(1) var mulFarTex: texture_2d<f32>;
@group(1) @binding(2) var addNearTex: texture_2d<f32>;
@group(1) @binding(3) var mulNearTex: texture_2d<f32>;
@group(1) @binding(4) var depthHalfTex: texture_2d<f32>;
@group(1) @binding(5) var sceneDepthTex: texture_depth_2d;
${out}

@fragment fn fs(in: FullscreenOut) -> CompositeOut {
  let pix = vec2i(in.position.xy);
  let zFull = viewZFromDepth(textureLoad(sceneDepthTex, pix, 0));
  let size = vec2i(textureDimensions(addFarTex));
  let st = in.uv * vec2f(size) - 0.5;
  let base = floor(st);
  let fr = st - base;
  // The depths the four surrounding texels were marched to, and how far the pixel's own depth is from
  // each: zero at either depth of a texel, growing with the gap in between (a third surface inside the
  // block) and outside the bracket.
  var depths: array<vec2f, 4>;
  var diffs: array<f32, 4>;
  var uniformDepth = true;
  for (var k = 0; k < 4; k++) {
    let ip = clamp(vec2i(base) + vec2i(k & 1, k >> 1), vec2i(0), size - 1);
    let dh = textureLoad(depthHalfTex, ip, 0).rg;
    depths[k] = dh;
    let zF = viewZFromDepth(dh.r);
    let zN = viewZFromDepth(dh.g);
    let below = max(zN - zFull, 0.0);
    let above = max(zFull - zF, 0.0);
    let inside = min(max(zFull - zN, 0.0), max(zF - zFull, 0.0));
    diffs[k] = min((below + above + inside) / max(min(zFull, zF), 1e-3), 1000.0);
    uniformDepth = uniformDepth && dh.r == dh.g && diffs[k] < 2.0e-4;
  }
  // Most of the frame: sky, and surfaces without a depth edge nearby. All four texels agree with the pixel,
  // the weights below reduce to bilinear ones, and the filtering sampler does the same in two lookups.
  if (uniformDepth) {
    return pack(textureSampleLevel(addFarTex, linearClamp, in.uv, 0.0).rgb, textureSampleLevel(mulFarTex, linearClamp, in.uv, 0.0).rgb);
  }
  var sumA = vec3f(0.0);
  var sumM = vec3f(0.0);
  var wsum = 0.0;
  var bestA = vec3f(0.0);
  var bestM = vec3f(1.0);
  var bestDiff = 3.0e38;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let ip = clamp(vec2i(base) + o, vec2i(0), size - 1);
    let dh = depths[k];
    let zF = viewZFromDepth(dh.r);
    let zN = viewZFromDepth(dh.g);
    var a = textureLoad(addFarTex, ip, 0).rgb;
    var m = textureLoad(mulFarTex, ip, 0).rgb;
    let diff = diffs[k];
    if (dh.r != dh.g) {
      // Interpolate between the texel's near and far candidates at the pixel's own depth.
      let w = saturate((zFull - zN) / max(zF - zN, 1e-6 * zN));
      if (w < 1.0) {
        a = mix(textureLoad(addNearTex, ip, 0).rgb, a, w);
        m = mix(textureLoad(mulNearTex, ip, 0).rgb, m, w);
      }
    }
    let bil = select(1.0 - fr.x, fr.x, o.x == 1) * select(1.0 - fr.y, fr.y, o.y == 1);
    let weight = (bil + 0.01) / (1.0 + diff * 200.0) * step(diff, 0.25);
    sumA += a * weight;
    sumM += m * weight;
    wsum += weight;
    if (diff < bestDiff) { bestDiff = diff; bestA = a; bestM = m; }
  }
  if (wsum < 1e-4) { return pack(bestA, bestM); }
  return pack(sumA / wsum, sumM / wsum);
}
`;
}

/** 'src1' (the second blend source of dual-source blending) is newer than the installed WebGPU typings. */
const SRC1 = 'src1' as GPUBlendFactor;

/** Blend states of the composite draws: destination = add + mul x destination; destination alpha is kept. */
export const COMPOSITE_BLEND: Record<'dual' | 'mul' | 'add', GPUBlendState> = {
  dual: { color: { srcFactor: 'one', dstFactor: SRC1, operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
  mul: { color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
  add: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
};
