/**
 * Forward near-field water (`drawWater`): the CDLOD patch mesh on the chart, displaced by swell + FFT chop +
 * ripples in the vertex shader, shaded per pixel by the shared brdf_water with the same lighting terms as the
 * deferred pass (sun x eclipse x transmittance x cloud shadow x cascade shadow, sky irradiance, planetshine,
 * local lights, map fill light), plus what only the near field can do: resolved wave normals with their
 * footprint-filtered variance, refraction of the seabed from 'scene.colorCopy' / 'scene.depthOpaque' with a
 * chromatic offset in the shallows, foam (Jacobian folding, shore, wake). The hand-over (ARCHITECTURE 10.2):
 * detail, refraction and depth-based foam fade to zero by fadeStart; between fadeStart and fadeEnd the
 * surface is the flat sea-level sheet shaded from the G-buffer's own inputs, opacity falling from 1 to 0.
 */
import { LOD_RANGE, MORPH_FRACTION, PATCH_CELLS } from '../nearField';

export const SURFACE_PIPELINE_WGSL = (sceneBindings: string): string => /* wgsl */ `
#include "frame"
#include "gbuffer"
#include "brdf"
#include "eclipse"
#include "atmosphere_common"
#include "shadows"
${sceneBindings}
@group(2) @binding(0) var<uniform> oceanU: OceanUniforms;
@group(2) @binding(1) var<storage, read> oceanPatches: array<vec4f>;
@group(2) @binding(2) var oceanDisp: texture_2d_array<f32>;
@group(2) @binding(3) var oceanDispPrev: texture_2d_array<f32>;
@group(2) @binding(4) var oceanDeriv: texture_2d_array<f32>;
@group(2) @binding(5) var oceanFoam: texture_2d_array<f32>;
@group(2) @binding(6) var oceanWake: texture_2d<f32>;
@group(2) @binding(7) var oceanSampler: sampler;   // trilinear, repeat, 4x anisotropic
#include "ocean_waves"
#include "brdf_water"

const OCEAN_LOD_RANGE = ${LOD_RANGE.toFixed(4)};
const OCEAN_MORPH = ${MORPH_FRACTION.toFixed(4)};
const OCEAN_PATCH_CELLS = ${PATCH_CELLS.toFixed(1)};
const OCEAN_DEEP = 10000.0;
const OCEAN_FOAM_WEIGHT = vec4f(1.0, 0.85, 0.45, 0.0);

/// Vertical water depth (m, below sea level) of the opaque surface seen at screen uv 'uv' with reversed depth
/// 'd' along the ray of a water point at eye distance 'waterDist'; OCEAN_DEEP where it says nothing (sky,
/// or an object in front of the water).
fn oceanColumnDepth(uv: vec2f, d: f32, waterDist: f32) -> f32 {
  if (d <= 0.0) { return OCEAN_DEEP; }
  let p = positionFromDepth(uv, d);
  let t = length(p);
  if (t < waterDist - 0.25) { return OCEAN_DEEP; }
  let ray = p / max(t, 1e-6);
  let b = frame.bodies[i32(oceanU.refRel.w)];
  let alt = altitudeAt(t, b.cameraUp.w, b.sunDir.w, dot(ray, b.cameraUp.xyz));
  return oceanU.misc.x - alt;
}

/// The same for a camera-relative position (vertex stage).
fn oceanColumnDepthAt(posRel: vec3f) -> f32 {
  let pu = projectToUv(posRel);
  if (pu.w <= 0.0) { return OCEAN_DEEP; }
  let size = vec2f(textureDimensions(sceneDepthOpaqueTex));
  let px = vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0));
  // Only the seabed (terrain) tells the depth of the water; an object in the water does not.
  let id = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
  if (id != MATERIAL_TERRAIN && id != MATERIAL_REGOLITH) { return OCEAN_DEEP; }
  return oceanColumnDepth((vec2f(px) + 0.5) / size, textureLoad(sceneDepthOpaqueTex, px, 0), length(posRel));
}

/// Cloud transmittance towards the sun (the placement documented in RENDER_API section 7).
fn oceanCloudShadow(pos: vec3f, bodyIndex: i32, up: vec3f, r: f32, sunDir: vec3f) -> f32 {
  let muS = max(dot(up, sunDir), 0.05);
  var far = 1.0;
  if (i32(frame.cloudFar.x) == bodyIndex && r < frame.cloudFar.y) {
    let b = frame.bodies[bodyIndex];
    let rel = pos - b.center.xyz;
    let bq = dot(rel, sunDir);
    let t = -bq + sqrt(max(bq * bq - (r * r - frame.cloudFar.y * frame.cloudFar.y), 0.0));
    let d = normalize(rootToFixed(u32(bodyIndex), rel + sunDir * t));
    let lon = atan2(d.y, d.x) + frame.cloudFar.w;
    let uvc = vec2f(fract(lon / TWO_PI + 0.5), acos(clamp(d.z, -1.0, 1.0)) / PI);
    far = exp(-textureSampleLevel(cloudCoverageMapTex, linearClamp, uvc, 0.0).r * frame.cloudFar.z / muS);
  }
  let he = frame.cloudNear0.w;
  if (he > 0.0 && i32(frame.cloudNear1.w) == bodyIndex) {
    let rel = pos - frame.cloudNear0.xyz;
    let q = vec2f(dot(rel, frame.cloudNear1.xyz), dot(rel, frame.cloudNear2.xyz)) / he;
    let edge = 1.0 - max(abs(q.x), abs(q.y));
    if (edge > 0.0) {
      let tau = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0).r * frame.cloudNear2.w;
      return mix(far, exp(-tau / muS), saturate(edge * 8.0));
    }
  }
  return far;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) posRel: vec3f,
  @location(1) plane0: vec2f,
  @location(2) planeF: vec2f,
  @location(3) currClip: vec4f,
  @location(4) prevClip: vec4f,
  @location(5) height: f32,
}

@vertex fn vs(@location(0) grid: vec2f, @builtin(instance_index) inst: u32) -> VsOut {
  let pt = oceanPatches[inst];
  let cell = pt.z;
  var p = pt.xy + grid * cell;
  let camH = oceanU.axisF.w;
  // CDLOD morph towards the parent grid over the outer part of this level's range (same distance as the CPU selection).
  let range = OCEAN_LOD_RANGE * cell * 2.0 * OCEAN_PATCH_CELLS;
  let mStart = range * (1.0 - OCEAN_MORPH);
  let morph = saturate((length(vec3f(p, camH)) - mStart) / (range - mStart));
  let odd = grid - 2.0 * floor(grid * 0.5);
  p -= odd * cell * morph;
  let dist = length(vec3f(p, camH));
  // Band limit of the displacement: continuous in distance, about 1.35 x the coarsest cell found there.
  let fw = dist / 36.0;
  let detail = oceanDetail(dist);
  let delta0 = oceanSphereOffset(p);
  let up0 = oceanUpAt(delta0);
  var h = OCEAN_DEEP;
  if (detail > 0.0) { h = oceanColumnDepthAt(oceanU.refRel.xyz + oceanRot(delta0)); }
  let amp = oceanAmplitudes(p, h);
  let sp = oceanSurfaceFrom(p, delta0, up0, fw, detail, amp, false);
  let lift = oceanU.fade.w * (1.0 - detail);
  let posRel = oceanU.refRel.xyz + oceanRot(sp.delta + sp.up * (sp.height + lift));
  var prevRel = posRel + frame.prevEyeOffset.xyz * -1.0;
  if (oceanU.refRelPrev.w > 0.5) {
    let pp = oceanSurfaceFrom(p, delta0, up0, fw, detail, amp, true);
    prevRel = oceanU.refRelPrev.xyz + oceanRotPrev(pp.delta + pp.up * (pp.height + lift));
  }
  var o: VsOut;
  o.position = frame.viewProj * vec4f(posRel, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(posRel, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(prevRel, 1.0);
  o.posRel = posRel;
  o.plane0 = p;
  o.planeF = sp.finalPlane;
  o.height = sp.height + lift;
  return o;
}

struct FsOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
}

@fragment fn fs(in: VsOut) -> FsOut {
  // Derivatives first, in uniform control flow.
  let dpx = dpdx(in.plane0);
  let dpy = dpdy(in.plane0);
  let fpMaj = max(length(dpx), length(dpy));
  let fpMin = min(length(dpx), length(dpy));
  let pix = vec2u(in.position.xy);
  let uv = in.position.xy * frame.renderSize.zw;
  let posRel = in.posRel;
  let dist = length(posRel);
  let fadeStart = oceanU.fade.x;
  let fadeEnd = oceanU.fade.y;
  if (dist >= fadeEnd) { discard; }
  let opacity = 1.0 - smoothstep(fadeStart, fadeEnd, dist);
  let detail = oceanDetail(dist);
  let bi = i32(oceanU.refRel.w);
  let b = frame.bodies[bi];

  // What the G-buffer holds under this pixel: the far sheet (between fadeStart and fadeEnd), else the seabed.
  let gm = textureLoad(gbufferMaterialTex, pix, 0);
  let gId = u32(gm.b * 255.0 + 0.5);
  let ga = textureLoad(gbufferAlbedoTex, pix, 0);
  let sheet = gId == MATERIAL_WATER;
  let dOpaque = textureLoad(sceneDepthOpaqueTex, pix, 0);
  // Water column above the opaque surface under the pixel (refraction path). Only the seabed (terrain) is a
  // depth of WATER for shore foam and the TMA attenuation; an object in the water is not.
  let seabed = gId == MATERIAL_TERRAIN || gId == MATERIAL_REGOLITH;
  var column = OCEAN_DEEP;
  if (!sheet) { column = oceanColumnDepth(uv, dOpaque, dist); }
  let seaDepth = select(OCEAN_DEEP, column, seabed);

  // Resolved wave slopes: FFT cascades (anisotropic, footprint-filtered), swell, ripples.
  let amp = oceanAmplitudes(in.plane0, seaDepth) * detail;
  var sx = 0.0;
  var sy = 0.0;
  var jxx = 1.0;
  var jyy = 1.0;
  var resolved = 0.0;
  var foamJ = 0.0;
  var lace = 0.0;
  var shoreNoise = 0.0;
  for (var c = 0u; c < OCEAN_CASCADES; c++) {
    let cs = oceanU.cascades[c];
    // The hardware keeps about the minor axis of the footprint (4:1 anisotropy here): what it averages away is
    // unresolved. A cascade filtered away entirely at this footprint is not sampled at all.
    let lod = log2(max(max(fpMin, fpMaj / 4.0) * 256.0 * cs.geom.y, 1e-6));
    if (amp[c] == 0.0 || lod > 7.5) { continue; }
    let uvc = oceanCascadeUv(c, in.plane0);
    let gx = dpx * cs.geom.y;
    let gy = dpy * cs.geom.y;
    let der = textureSampleGrad(oceanDeriv, oceanSampler, uvc, c, gx, gy);
    sx += der.x * amp[c];
    sy += der.y * amp[c];
    jxx += der.z * amp[c];
    jyy += der.w * amp[c];
    // Lace: the short cascades' convergence (-div D, normalised by its spread) breaks foam into bubbles and streaks.
    if (c >= 2u) { lace += -(der.z + der.w) / max(oceanU.wind.w * sqrt(cs.stats.x), 1e-4) * select(0.45, 0.55, c == 3u); }
    resolved += oceanFilteredFraction(c, lod) * cs.stats.x * sq(amp[c]);
    if (c < 3u) {
      let fm = textureSampleGrad(oceanFoam, oceanSampler, uvc, c, gx, gy);
      // Whitecaps belong to the breaking chop: the long cascades carry them, the capillary cascade none.
      foamJ = 1.0 - (1.0 - foamJ) * (1.0 - saturate(fm.r) * amp[c] * OCEAN_FOAM_WEIGHT[c]);
      // Lace: the shortest foam cascade's Jacobian, normalised by its spread, gives foam its bubbly breakup.
      if (c == 2u) { shoreNoise = saturate(fm.r * 2.0 + (1.0 - fm.g) * 2.0); }
    }
  }
  // Coverage follows the folding density; inside it the lace decides which bubbles are white.
  let laceN = saturate(0.5 + 0.3 * lace);
  foamJ = smoothstep(1.0 - foamJ * 1.15 - 0.08, 1.0 - foamJ * 1.15 + 0.08, laceN) * min(foamJ * 3.0, 1.0);
  // Capillary detail: the finest cascade again, compressed and rotated, carrying the slope variance that the
  // JONSWAP cascades do not (Cox-Munk counts the capillaries); resolved only where a pixel is that small.
  {
    let c3 = oceanU.cascades[3];
    for (var k = 0u; k < 2u; k++) {
      let lay = oceanU.detail[k];
      let sc = lay.x * c3.geom.y;
      let lod = log2(max(max(fpMin, fpMaj / 4.0) * 256.0 * sc, 1e-6));
      if (amp[3] == 0.0 || lod > 7.5) { continue; }
      let rot = mat2x2f(lay.y, lay.z, -lay.z, lay.y);
      let org = select(oceanU.detailOrigin.xy, oceanU.detailOrigin.zw, k == 1u);
      let uvd = org + (rot * in.plane0) * sc;
      let der = textureSampleGrad(oceanDeriv, oceanSampler, uvd, 3, (rot * dpx) * sc, (rot * dpy) * sc);
      let slope = transpose(rot) * der.xy * (lay.w * amp[3]);
      sx += slope.x;
      sy += slope.y;
      resolved += oceanFilteredFraction(3u, lod) * c3.stats.x * sq(lay.w * amp[3]);
    }
  }
  let deltaF = oceanSphereOffset(in.planeF);
  let upF = oceanUpAt(deltaF);
  let sw = oceanSwellEval(deltaF, upF, fpMaj, false);
  let rp = oceanRipples(in.planeF, false) * detail;
  let e = oceanU.axisE.xyz;
  let f = oceanU.axisF.xyz;
  let grad = sw.grad * detail + e * (sx / max(jxx, 0.25) + rp.y) + f * (sy / max(jyy, 0.25) + rp.z);
  let nFixed = normalize(upF - grad);
  resolved += sw.variance * sq(detail);

  // Foam: Jacobian folding (whitecaps), shore (shallow water lapping with the swell), wake around hulls.
  let dynDepth = seaDepth + in.height;
  var shore = 0.0;
  if (seaDepth < OCEAN_DEEP * 0.5) {
    // Swash: foam where the water running up the shore is shallow, broken into lace, thickest at the waterline.
    let swash = 1.0 - smoothstep(0.0, oceanU.shore.x, dynDepth);
    shore = smoothstep(1.0 - swash, 1.0 - swash + 0.25, 0.5 * laceN + 0.5 * shoreNoise) * swash * detail;
  }
  var wake = 0.0;
  if ((oceanU.counts.w & 1u) != 0u) {
    let wuv = (in.planeF - oceanU.wake.xy) * oceanU.wake.w + 0.5;
    let edge = saturate(min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)) * 12.0);
    let w = textureSampleLevel(oceanWake, linearClamp, wuv, 0.0).r * edge;
    // Wake foam is bubbly too: the same lace decides where the churned water is white.
    wake = smoothstep(1.0 - w, 1.0 - w + 0.35, laceN) * min(w * 2.0, 1.0);
  }
  let foamRes = 1.0 - (1.0 - foamJ) * (1.0 - shore) * (1.0 - wake);

  var s: Surface;
  s.pos = posRel;
  s.viewDist = dist;
  s.v = -posRel / max(dist, 1e-6);
  s.n = oceanRot(nFixed);
  s.up = oceanRot(upF);
  s.ao = 1.0;
  s.metallic = foamRes;
  s.clearcoat = 0.0;
  s.clearcoatRoughness = max(detail, wake);
  s.anisotropy = 0.0;
  s.t = vec3f(1.0, 0.0, 0.0);
  s.lightAlpha = 0.0;
  s.materialId = MATERIAL_WATER;
  s.bodyIndex = bi;
  s.altitude = oceanU.misc.x + in.height;
  s.roughness = clamp(resolved / oceanU.wind.y, 0.0, 1.0);
  // Imagery colour: the sheet's (band) or the seabed's (near field: the terrain draws it with its albedo layer).
  s.albedo = select(vec3f(0.0), ga.rgb, sheet || seabed);
  if (sheet) {
    // Between fadeStart and fadeEnd: exactly the deferred pixel's inputs (detail is zero here).
    s.param = gm.a;
    s.roughness = gm.r;
    s.n = octDecode(textureLoad(gbufferNormalTex, pix, 0).xy);
  } else {
    // The G-buffer's encoded depth semantics: 8-bit encodeWaterDepth of the vertical depth.
    s.param = round(encodeWaterDepth(max(seaDepth, 0.0)) * 255.0) / 255.0;
  }

  // ---- lighting: the deferred pass's terms, through the same brdf_water
  let sunDir = b.sunDir.xyz;
  let r = b.center.w + s.altitude;
  let muS = dot(s.up, sunDir);
  var lit = vec3f(0.0);
  var bottomFar = vec3f(0.0);
  // The seabed contributes only where light can make the round trip through the column: beyond about
  // 6 / (2 kappa_min) metres (about 95 m of clear ocean) it is invisible, and refraction is skipped.
  let kMin = min(min(frame.bodies[bi].ocean.r, frame.bodies[bi].ocean.g), frame.bodies[bi].ocean.b);
  let seeBottom = detail > 0.02 && !sheet && dOpaque > 0.0 && column * kMin < 3.0;
  var sunEff = vec3f(0.0);
  let vis = sunVisibility(posRel, sunDir);
  if (vis > 0.0) {
    var sunE = frame.sunIlluminance.rgb * vis;
    sunE *= atmosphereSunTransmittance(transmittanceLut, u32(bi), r, muS);
    sunE *= oceanCloudShadow(posRel, bi, s.up, r, sunDir);
    let shadow = sampleSunShadow(posRel, s.n, pix);
    if (shadow > 0.0) {
      s.lightAlpha = 0.6 * frame.sunDir.w;
      lit += brdfWaterDirect(s, sunDir) * sunE * shadow;
      if (seeBottom) { bottomFar += waterBodyDirect(s, sunDir).bottom * sunE * shadow; }
      sunEff = sunE * shadow;
    }
  }
  s.lightAlpha = 0.0;
  var amb: AmbientInput;
  amb.skyIrradiance = vec3f(0.0);
  amb.envIrradiance = vec3f(0.0);
  amb.envSpecular = vec3f(0.0);
  amb.envSpecularCoat = vec3f(0.0);
  amb.skyReflection = vec3f(0.0);
  amb.specularOcclusion = 1.0;
  let layer = i32(b.fixedX.w);
  if (layer >= 0 && r < b.prevCenter.w) {
    let suv = skyIrradianceUvFromRMuS(max(r, b.center.w), muS, b.center.w, b.prevCenter.w);
    amb.skyIrradiance = textureSampleLevel(skyIrradianceLut, linearClamp, suv, layer, 0.0).rgb * (0.5 + 0.5 * dot(s.n, s.up));
  }
  lit += brdfWaterAmbient(s, amb);
  if (seeBottom) { bottomFar += waterBodyAmbient(s, amb).bottom; }
  var receiver = MAX_BODIES;
  if (s.altitude < 0.5 * b.center.w) { receiver = u32(bi); }
  for (var k = 0u; k < 2u; k++) {
    let sh = frame.shine[receiver * 2u + k];
    // Planetshine far below the sunlight on this pixel (moonlight by day) changes nothing visible: skipped.
    let shE = sh.illuminance.r + sh.illuminance.g + sh.illuminance.b;
    if (shE > 0.0 && shE > 1e-5 * (sunEff.r + sunEff.g + sunEff.b)) {
      lit += brdfWaterDirect(s, sh.dir.xyz) * sh.illuminance.rgb;
      if (seeBottom) { bottomFar += waterBodyDirect(s, sh.dir.xyz).bottom * sh.illuminance.rgb; }
    }
  }
  for (var i = 0u; i < min(frame.counts.y, MAX_LIGHTS); i++) {
    let L = frame.lights[i];
    var toL = L.posRange.xyz - posRel;
    if (L.endKind.w > 0.5) {
      let ab = L.endKind.xyz - L.posRange.xyz;
      let t = saturate(dot(posRel - L.posRange.xyz, ab) / max(dot(ab, ab), 1e-6));
      toL = L.posRange.xyz + ab * t - posRel;
    }
    let d2 = dot(toL, toL);
    let range2 = L.posRange.w * L.posRange.w;
    if (d2 < range2) {
      let window = sq(saturate(1.0 - sq(d2 / range2)));
      lit += brdfWaterDirect(s, toL * inverseSqrt(max(d2, 1e-8))) * L.intensity.rgb * (window / max(d2, 1e-4));
    }
  }
  lit += s.albedo * frame.sunIlluminance.rgb * (frame.misc.x / PI);

  // ---- refraction of the real seabed (near field only): replaces the modelled bottom term of the body colour.
  if (seeBottom) {
    // March the refracted ray through the depth copy (6 steps, denser near the surface) to the first opaque
    // surface behind the water: a submerged object or the seabed seen through the waves, no screen-space ghosts.
    let tdir = refract(-s.v, s.n, 1.0 / WATER_IOR);
    let size = frame.renderSize.xy;
    let cosT = max(dot(tdir, -s.up), 0.15);
    let reach = min(max(column, 0.0) / cosT, 40.0) * 1.25 + 0.05;
    // Path length in the water to what the refracted ray meets (refined between the last two steps).
    var tHit = min(max(column, 0.0) / cosT, 40.0);
    var hitUv = uv;
    var tPrev = 0.0;
    for (var i = 1u; i <= 6u; i++) {
      let t = reach * sq(f32(i) / 6.0);
      let q = posRel + tdir * t;
      let pu = projectToUv(q);
      if (pu.w <= 0.0) { break; }
      let px = vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0));
      let d = textureLoad(sceneDepthOpaqueTex, px, 0);
      if (d <= 0.0) { break; }
      if (pu.z <= d) {
        let behind = length(positionFromDepth(pu.xy, d));
        if (behind >= dist - 0.05) {
          // The opaque surface lies between the last two samples; take the point of the ray at its eye distance.
          let qPrev = posRel + tdir * tPrev;
          let f = saturate((behind - length(qPrev)) / max(length(q) - length(qPrev), 1e-4));
          tHit = mix(tPrev, t, f);
          hitUv = projectToUv(posRel + tdir * tHit).xy;
        }
        break;
      }
      tPrev = t;
    }
    let uvR = uv + (hitUv - uv) * (oceanU.shore.y * detail);
    let dR = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(uvR * size, vec2f(0.0), size - 1.0)), 0);
    if (dR > 0.0 && length(positionFromDepth(uvR, dR)) >= dist - 0.05) {
      let hitDepth = tHit * cosT;
      let ch = oceanU.shore.z * saturate(1.0 - hitDepth / 6.0);
      let seen = vec3f(
        textureSampleLevel(sceneColorTex, linearClamp, uv + (uvR - uv) * (1.0 - ch), 0.0).r,
        textureSampleLevel(sceneColorTex, linearClamp, uvR, 0.0).g,
        textureSampleLevel(sceneColorTex, linearClamp, uv + (uvR - uv) * (1.0 + ch), 0.0).b) / max(frame.exposure.x, 1e-30);
      var so = s;
      so.param = encodeWaterDepth(hitDepth);
      let o = waterOptics(so);
      let NoV = max(dot(s.n, s.v), 1e-4);
      let tr = (1.0 - waterFresnel(max(muS, 0.0))) * (1.0 - waterFresnel(NoV)) / 0.9604;
      let att = waterRrsOf(o, vec3f(0.0), waterRefractedCos(max(muS, 0.05)), cosT).bottomAttenuation * tr;
      lit += (seen * att - bottomFar) * (detail * (1.0 - waterFoamCoverage(s)));
    }
  }

  // Debug views (OCEAN_DEBUG_VIEWS): one term at a time, same exposure.
  let view = (oceanU.counts.w >> 8u) & 15u;
  if (view != 0u) {
    var d = vec3f(0.0);
    let NoV = max(dot(s.n, s.v), 1e-4);
    let alpha = waterAlpha(s);
    let dfg = envBrdfApprox(sqrt(alpha), NoV);
    let cov = waterFoamCoverage(s);
    switch (view) {
      case 1u: { d = waterSkyRadiance(s, reflect(-s.v, s.n), alpha) * (0.02 * dfg.x + dfg.y) * (1.0 - cov); }
      case 2u: { d = (waterBodyAmbient(s, amb).total + waterBodyDirect(s, sunDir).total * sunEff) * (1.0 - cov); }
      case 3u: {
        var ss = s;
        ss.lightAlpha = 0.6 * frame.sunDir.w;
        ss.albedo = vec3f(0.0);
        d = (brdfWaterDirect(ss, sunDir) - waterBodyDirect(ss, sunDir).total * (1.0 - cov)) * sunEff;
      }
      case 4u: { d = vec3f(cov) * 2000.0; }
      case 5u: { d = (s.n * 0.5 + 0.5) * 2000.0; }
      case 6u: { d = vec3f(s.roughness, sqrt(waterAlpha(s)), detail) * 2000.0; }
      default: { d = lit; }
    }
    lit = d;
  }

  var o: FsOut;
  o.color = vec4f(writeHdr(lit * frame.exposure.x) * opacity, opacity);
  o.velocity = velocityFromClip(in.currClip, in.prevClip);
  return o;
}
`;

/** Readback of the displaced surface at query points (plane offsets from the reference point). */
export const READBACK_WGSL = /* wgsl */ `
#include "frame"
@group(1) @binding(0) var<uniform> oceanU: OceanUniforms;
@group(1) @binding(1) var<storage, read> queries: array<vec4f>;     // xy = plane offset of the horizontal position
@group(1) @binding(2) var<storage, read_write> results: array<vec4f>; // x = total height, y = swell, z = FFT, w = ripple
@group(1) @binding(3) var<storage, read_write> residual: array<f32>;
@group(1) @binding(4) var oceanDisp: texture_2d_array<f32>;
@group(1) @binding(5) var oceanDispPrev: texture_2d_array<f32>;
#include "ocean_waves"
@compute @workgroup_size(64, 1, 1)
fn readback(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&queries)) { return; }
  let q = queries[i].xy;
  let dist = length(vec3f(q, oceanU.axisF.w));
  let detail = oceanDetail(dist);
  // The drawn vertex at Lagrangian p0 lands at p0 + D(p0): solve p0 + D(p0) = q by fixed-point iteration.
  var p0 = q;
  var sp: OceanSurfacePoint;
  for (var k = 0; k < 12; k++) {
    let amp = oceanAmplitudes(p0, 1e4);
    sp = oceanSurfaceAt(p0, 0.0, detail, amp, false);
    p0 += q - sp.finalPlane;
  }
  let amp = oceanAmplitudes(p0, 1e4);
  sp = oceanSurfaceAt(p0, 0.0, detail, amp, false);
  results[i] = vec4f(sp.height, sp.swell, sp.fft, sp.ripple);
  residual[i] = length(q - sp.finalPlane);
}
`;
