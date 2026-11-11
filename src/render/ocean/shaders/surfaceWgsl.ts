/**
 * Forward near-field water (`drawWater`): the CDLOD patch mesh on the chart, displaced by swell + FFT chop +
 * ripples in the vertex shader, shaded per pixel by the shared brdf_water with the same lighting terms as the
 * deferred pass (sun x eclipse x transmittance x cloud shadow x cascade shadow, sky irradiance, planetshine,
 * local lights, map fill light), plus what only the near field can do: resolved wave normals with their
 * footprint-filtered variance, refraction of the seabed from 'scene.colorCopy' / 'scene.depthOpaque' with a
 * chromatic offset in the shallows and caustics on the bed, foam (whitecaps of the foam map, surf, wake, all
 * drawn through the foam lace), reflections of vessels. The hand-over (ARCHITECTURE 10.2): detail, refraction and
 * depth-based foam fade to zero by fadeStart; between fadeStart and fadeEnd the surface is the flat sea-level
 * sheet with the radiance brdf_water gave the sheet's own G-buffer inputs in the deferred pass (read from
 * 'scene.colorCopy'), opacity falling from 1 to 0.
 */
import { FOAM_LEVELS, FOAM_SIZE } from '../foamMap';
import { LACE_SIZE } from '../foamLace';
import { LOD_RANGE, MORPH_FRACTION, PATCH_CELLS } from '../nearField';

/**
 * A wave layer filtered beyond this mip keeps under 0.1 % of its slope variance (filteredSlopeFraction): its slopes
 * are not sampled (their variance is unresolved, in the GGX lobe). A layer that no pixel of the frame can see
 * sharper than this is not even updated (oceanFeature).
 */
export const OCEAN_LOD_CUT = 4.5;
/** The lace is sampled a second time this many times smaller (the tile stays periodic): bubbles close to the camera. */
export const LACE_FINE = 9;

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
@group(2) @binding(5) var oceanFoam: texture_2d_array<f32>;   // the foam map (foamMap.ts): r = breaker, g = what it left
@group(2) @binding(6) var oceanWake: texture_2d<f32>;
@group(2) @binding(7) var oceanSampler: sampler;   // trilinear, repeat, 4x anisotropic
@group(2) @binding(8) var oceanField: texture_2d<f32>; // roughness field of brdf_water, baked over the near field (fieldWgsl.ts)
@group(2) @binding(9) var oceanLace: texture_2d<f32>;  // the foam lace (foamLace.ts): r = E[T], g = E[T^2]
#include "ocean_waves"
#include "ocean_water_forward"

const OCEAN_LOD_RANGE = ${LOD_RANGE.toFixed(4)};
const OCEAN_MORPH = ${MORPH_FRACTION.toFixed(4)};
const OCEAN_PATCH_CELLS = ${PATCH_CELLS.toFixed(1)};
const OCEAN_DEEP = 10000.0;
// The band is evaluated by the forward pass out to this multiple of fadeStart, beyond it read from the deferred pass.
const OCEAN_BAND_EVAL = 1.05;
const OCEAN_LOD_CUT = ${OCEAN_LOD_CUT.toFixed(2)};
// Below this the vertical march finds the seabed under a water point; deeper water changes neither the TMA
// attenuation (every band at full strength from about 15 m) nor the surf.
const OCEAN_VERTICAL_REACH = 24.0;
const OCEAN_FOAM_LEVELS = ${FOAM_LEVELS};
const OCEAN_FOAM_SIZE = ${FOAM_SIZE}.0;
const OCEAN_LACE_SIZE = ${LACE_SIZE}.0;
const OCEAN_LACE_FINE = ${LACE_FINE}.0;
// Slopes of the summed wave layers are limited softly from this slope on (a wave steeper than about 0.45 breaks).
const OCEAN_SLOPE_KNEE = 0.4;

/// Vertical water depth (m, below sea level) of the opaque surface seen at screen uv 'uv' with reversed depth
/// 'd' along the ray of a water point at eye distance 'waterDist'; OCEAN_DEEP where it says nothing (sky,
/// or an object in front of the water). This is the depth where the VIEW RAY meets the bed (the refraction path).
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

/// What the G-buffer says about the point 'q' (camera-relative) of a vertical under the water: x = eye distance of
/// the stored surface along q's pixel minus q's own (> 0: q is still above it), y = 1 when that surface is the
/// seabed (terrain), 0 when it says nothing about the bed (an object in the water, a stray fragment, sky, off screen).
fn oceanBedProbe(q: vec3f) -> vec2f {
  let pu = projectToUv(q);
  if (pu.w <= 0.0 || any(pu.xy < vec2f(0.0)) || any(pu.xy > vec2f(1.0))) { return vec2f(0.0); }
  let size = frame.renderSize.xy;
  let px = vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0));
  let d = textureLoad(sceneDepthOpaqueTex, px, 0);
  let id = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
  if (d <= 0.0 || (id != MATERIAL_TERRAIN && id != MATERIAL_REGOLITH)) { return vec2f(0.0); }
  return vec2f(length(positionFromDepth((vec2f(px) + 0.5) / size, d)) - length(q), 1.0);
}

/// Water depth (m) of the seabed straight BELOW the sea-level point 'posRel' (camera-relative, ROOT; 'up' its unit
/// up), independent of the view and of anything floating or sunk in the water: the vertical is marched down through
/// the depth copy to where it passes behind the stored SEABED (samples that show an object say nothing and are
/// skipped), then the crossing is bisected. 'guess' is a depth near which the bed is expected (where the view ray
/// meets it, when the pixel shows the bed): it sets how far the march reaches. 'fallback' is returned when the
/// vertical never shows the bed (hidden, or out of the frame). A bed deeper than the march returns the end of the
/// march, a lower bound; OCEAN_DEEP when even OCEAN_VERTICAL_REACH did not reach it.
fn oceanDepthBelow(posRel: vec3f, up: vec3f, guess: f32, fallback: f32) -> f32 {
  if (guess > 2.5 * OCEAN_VERTICAL_REACH) { return OCEAN_DEEP; }
  let reach = min(2.0 * guess + 2.0, OCEAN_VERTICAL_REACH);
  var tAbove = -1.0;
  var gapAbove = 0.0;
  var tBelow = -1.0;
  var gapBelow = 0.0;
  // The deepest samples said nothing (hidden by an object, or out of the frame): the bed may lie there.
  var blind = true;
  for (var i = 0u; i <= 6u; i++) {
    let t = reach * sq(f32(i) / 6.0);
    let pr = oceanBedProbe(posRel - up * t);
    if (pr.y < 0.5) {
      blind = true;
      continue;
    }
    blind = false;
    if (pr.x <= 0.0) {
      tBelow = t;
      gapBelow = pr.x;
      break;
    }
    tAbove = t;
    gapAbove = pr.x;
  }
  if (tBelow < 0.0) {
    if (blind) { return fallback; }
    return select(reach, OCEAN_DEEP, reach >= OCEAN_VERTICAL_REACH);
  }
  if (tAbove < 0.0) { return tBelow; }
  for (var k = 0u; k < 2u; k++) {
    let tm = 0.5 * (tAbove + tBelow);
    let pr = oceanBedProbe(posRel - up * tm);
    if (pr.y < 0.5) { break; }
    if (pr.x <= 0.0) {
      tBelow = tm;
      gapBelow = pr.x;
    } else {
      tAbove = tm;
      gapAbove = pr.x;
    }
  }
  return mix(tAbove, tBelow, saturate(gapAbove / max(gapAbove - gapBelow, 1e-4)));
}

/// Where to look for the seabed below a water point whose pixel shows an OBJECT in the water at vertical depth
/// 'objectDepth' along the view ray: a few metres below the object (the march then reaches about twice that; a bed
/// it does not find is deeper than its reach, which is all that the waves and the foam need to know).
fn oceanObjectGuess(objectDepth: f32) -> f32 { return clamp(objectDepth + 2.0, 3.0, 0.5 * OCEAN_VERTICAL_REACH - 1.0); }

/// The seabed depth under a camera-relative sea-level position (vertex stage).
fn oceanColumnDepthAt(posRel: vec3f, up: vec3f) -> f32 {
  let pu = projectToUv(posRel);
  if (pu.w <= 0.0) { return OCEAN_DEEP; }
  let size = vec2f(textureDimensions(sceneDepthOpaqueTex));
  let px = vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0));
  // The view ray's own depth is a guess only where the pixel shows the seabed; an object in the water says nothing.
  let id = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
  let along = oceanColumnDepth((vec2f(px) + 0.5) / size, textureLoad(sceneDepthOpaqueTex, px, 0), length(posRel));
  if (id == MATERIAL_TERRAIN || id == MATERIAL_REGOLITH) { return oceanDepthBelow(posRel, up, along, along); }
  let guess = oceanObjectGuess(along);
  return oceanDepthBelow(posRel, up, guess, 2.0 * guess + 2.0);
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
  if (detail > 0.0) { h = oceanColumnDepthAt(oceanU.refRel.xyz + oceanRot(delta0), oceanRot(up0)); }
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
  // Derivatives and the foam lace first, in uniform control flow.
  let dpx = dpdx(in.plane0);
  let dpy = dpdy(in.plane0);
  let lx = length(dpx);
  let ly = length(dpy);
  let fpMin = min(lx, ly);
  // The long axis of the footprint (along the view at grazing angles) is filtered twice as wide once the footprint
  // is elongated: a wave only two pixels long there does not survive to stripe the rows of the image.
  let widen = 1.0 + smoothstep(1.5, 4.0, max(lx, ly) / max(fpMin, 1e-9));
  let dqx = dpx * select(1.0, widen, lx >= ly);
  let dqy = dpy * select(1.0, widen, ly > lx);
  let fpMaj = max(lx, ly) * widen;
  // What the 4x anisotropic filter keeps: the minor axis, or a quarter of the major one.
  let fpTex = max(fpMin, fpMaj / 4.0);
  // The foam lace: mean and second moment of T over the footprint, and T again much finer for the bubbles.
  let g3 = oceanU.cascades[3].geom.y;
  let laceUv = oceanCascadeUv(3u, in.plane0);
  let laceM = textureSampleGrad(oceanLace, oceanSampler, laceUv, dpx * g3, dpy * g3).rg;
  let laceFine = textureSampleGrad(oceanLace, oceanSampler, laceUv * OCEAN_LACE_FINE, dpx * (g3 * OCEAN_LACE_FINE), dpy * (g3 * OCEAN_LACE_FINE)).r;
  let bubbles = 1.0 - smoothstep(0.0, 1.5, log2(max(fpTex * g3 * OCEAN_LACE_FINE * OCEAN_LACE_SIZE, 1e-6)));
  let laceT = laceM.x + 0.15 * (laceFine - 0.5) * bubbles;
  // Half-width of the foam edge: T's spread inside the footprint, at least the change of T across a pixel.
  let laceHalf = max(1.7320508 * sqrt(max(laceM.y - laceM.x * laceM.x, 0.0)), max(0.75 * fwidth(laceT), 0.004));

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
  let size = frame.renderSize.xy;

  // What the G-buffer holds under this pixel. Between fadeStart and fadeEnd: the terrain's far sheet, already lit
  // by the deferred pass with this same brdf_water from the same inputs (the surface here is that flat sheet,
  // detail is zero): the forward surface takes exactly that radiance from the copy instead of evaluating it again,
  // and its opacity falls to 0 over the identical pixel underneath. Not next to fadeStart, though: there the
  // core's screen-space terms of the deferred pass (AO, 1.5 % of the distance wide) see the depth step down to the
  // seabed inside fadeStart and darken the sheet by up to 17 %; over OCEAN_BAND_EVAL x fadeStart the forward pass
  // evaluates brdf_water itself from the sheet's G-buffer inputs (below), which is what the deferred pass would
  // give without that step.
  let gm = textureLoad(gbufferMaterialTex, pix, 0);
  let gId = u32(gm.b * 255.0 + 0.5);
  let sheet = gId == MATERIAL_WATER && dist >= fadeStart;
  if (sheet && dist >= fadeStart * OCEAN_BAND_EVAL) {
    var ob: FsOut;
    ob.color = vec4f(writeHdr(textureLoad(sceneColorTex, pix, 0).rgb) * opacity, opacity);
    ob.velocity = velocityFromClip(in.currClip, in.prevClip);
    return ob;
  }
  // Inside fadeStart the terrain has discarded its sheet: the G-buffer holds the seabed, an object, or nothing.
  // A WATER fragment found there anyway is not this surface (a misplaced sheet fragment, request
  // terrain-render-cs-1) and tells nothing about the bottom: the pixel keeps its waves as open, deep water.
  let ga = textureLoad(gbufferAlbedoTex, pix, 0);
  let strayWater = gId == MATERIAL_WATER && !sheet;
  let dOpaque = textureLoad(sceneDepthOpaqueTex, pix, 0);
  let seabedPix = gId == MATERIAL_TERRAIN || gId == MATERIAL_REGOLITH;
  // Water column along the view ray to the opaque surface under the pixel (the refraction path).
  var column = OCEAN_DEEP;
  if (!strayWater && !sheet) { column = oceanColumnDepth(uv, dOpaque, dist); }
  let deltaF = oceanSphereOffset(in.planeF);
  let upF = oceanUpAt(deltaF);
  let upR = oceanRot(upF);
  // Depth of the WATER: the seabed straight below the water point, whatever floats or lies in the water (an
  // object under the pixel is not the bottom and does not change the waves, the foam or the colour of the water
  // above it).
  var seaDepth = OCEAN_DEEP;
  if (!sheet && !strayWater && dOpaque > 0.0) {
    if (detail > 0.0) {
      let guess = select(oceanObjectGuess(column), column, seabedPix);
      seaDepth = oceanDepthBelow(posRel - upR * in.height, upR, guess, select(2.0 * guess + 2.0, column, seabedPix));
    } else if (seabedPix) {
      seaDepth = column;
    }
  }

  // Resolved wave slopes: FFT cascades (anisotropic, footprint-filtered), capillary and long-wave layers, swell, ripples.
  // Around a vessel the chop's DISPLACEMENT is damped (the waterline follows the swell); the slopes of the short
  // cascades stay: ripples of centimetres do not move the waterline, and they are what the hull's image breaks on.
  var amp = oceanAmplitudes(in.plane0, seaDepth) * detail;
  amp[2] = oceanTma(2u, seaDepth) * oceanU.misc.z * oceanLayerOn(2u) * detail;
  amp[3] = oceanTma(3u, seaDepth) * oceanU.misc.z * oceanLayerOn(3u) * detail;
  var chop = vec2f(0.0);    // slopes of the cascades in Lagrangian coordinates (their own displacement pinches them)
  var extra = vec2f(0.0);   // slopes of the layers that carry no displacement
  var jxx = 1.0;
  var jyy = 1.0;
  var resolved = 0.0;
  for (var c = 0u; c < OCEAN_CASCADES; c++) {
    let cs = oceanU.cascades[c];
    // A cascade filtered beyond OCEAN_LOD_CUT is not sampled at all; it fades out over the mip before.
    let lod = log2(max(fpTex * 256.0 * cs.geom.y, 1e-6));
    let keep = 1.0 - smoothstep(OCEAN_LOD_CUT - 1.0, OCEAN_LOD_CUT, lod);
    if (amp[c] == 0.0 || keep <= 0.0) { continue; }
    let a = amp[c] * keep;
    let der = textureSampleGrad(oceanDeriv, oceanSampler, oceanCascadeUv(c, in.plane0), c, dqx * cs.geom.y, dqy * cs.geom.y);
    chop += der.xy * a;
    jxx += der.z * a;
    jyy += der.w * a;
    resolved += oceanFilteredFraction(c, lod) * cs.stats.x * sq(a);
  }
  // Capillary detail: the finest cascade again, compressed and rotated, carrying the slope variance that the
  // JONSWAP cascades do not (Cox-Munk counts the capillaries); resolved only where a pixel is that small.
  {
    let c3 = oceanU.cascades[3];
    for (var k = 0u; k < 2u; k++) {
      let lay = oceanU.detail[k];
      let sc = lay.x * c3.geom.y;
      let lod = log2(max(fpTex * 256.0 * sc, 1e-6));
      let keep = 1.0 - smoothstep(OCEAN_LOD_CUT - 1.0, OCEAN_LOD_CUT, lod);
      let a = lay.w * amp[3] * keep;
      if (a <= 0.0) { continue; }
      let rot = mat2x2f(lay.y, lay.z, -lay.z, lay.y);
      let org = select(oceanU.detailOrigin.xy, oceanU.detailOrigin.zw, k == 1u);
      let uvd = org + (rot * in.plane0) * sc;
      let der = textureSampleGrad(oceanDeriv, oceanSampler, uvd, 3, (rot * dqx) * sc, (rot * dqy) * sc);
      extra += transpose(rot) * der.xy * a;
      resolved += oceanFilteredFraction(3u, lod) * c3.stats.x * sq(a);
    }
  }
  // Long-wave normals layer: the wind sea above the high-pass wavelength that the four-component physics swell does
  // not carry, slopes only (the drawn height stays the swell). Two copies of one FFT layer, rotated a little apart,
  // each with half its variance: their sum does not repeat.
  {
    let lw = oceanU.long;
    let aL = 0.70710678 * detail * oceanTmaOmega(lw.stats.z, seaDepth) * oceanU.misc.z * oceanLayerOn(OCEAN_LONG_LAYER);
    let g = lw.geom.y;
    let lod = log2(max(fpTex * 256.0 * g, 1e-6));
    let keep = 1.0 - smoothstep(OCEAN_LOD_CUT - 1.0, OCEAN_LOD_CUT, lod);
    if (aL > 0.0 && keep > 0.0) {
      let ff = oceanFilteredFractionOf(lw, lod);
      for (var k = 0u; k < 2u; k++) {
        let cr = select(oceanU.longRot.xy, oceanU.longRot.zw, k == 1u);
        let rot = mat2x2f(cr.x, cr.y, -cr.y, cr.x);
        let uvl = select(oceanU.longOrigin.xy, oceanU.longOrigin.zw, k == 1u) + (rot * in.plane0) * g;
        let der = textureSampleGrad(oceanDeriv, oceanSampler, uvl, OCEAN_LONG_LAYER, (rot * dqx) * g, (rot * dqy) * g);
        extra += transpose(rot) * der.xy * (aL * keep);
        resolved += ff * lw.stats.x * sq(aL * keep);
      }
    }
  }
  let rp = oceanRipples(in.planeF, false) * detail;
  // The cascades' horizontal displacement pinches their own slopes at the crests (and only theirs); the summed
  // slope is limited softly, so no facet spikes out of the lobe along a crest.
  var slope = chop / vec2f(max(jxx, 0.4), max(jyy, 0.4)) + extra + rp.yz;
  let sl = length(slope);
  if (sl > OCEAN_SLOPE_KNEE) { slope *= (OCEAN_SLOPE_KNEE + 0.5 * tanh((sl - OCEAN_SLOPE_KNEE) / 0.5)) / sl; }
  // The swell, each component band-limited by the footprint along its own direction of travel.
  let vFix = oceanRotInv(posRel / max(dist, 1e-6));
  var vHor = vFix - upF * dot(vFix, upF);
  vHor = vHor / max(length(vHor), 1e-4);
  let sw = oceanSwellEvalAlong(deltaF, upF, fpMin, vec4f(vHor, fpMaj), false);
  let e = oceanU.axisE.xyz;
  let f = oceanU.axisF.xyz;
  let grad = sw.grad * detail + e * slope.x + f * slope.y;
  let nFixed = normalize(upF - grad);
  resolved += sw.variance * sq(detail);

  var s: Surface;
  s.pos = posRel;
  s.viewDist = dist;
  s.v = -posRel / max(dist, 1e-6);
  s.n = oceanRot(nFixed);
  // A facet facing away from the eye is turned to the silhouette (what lies behind it is not visible).
  let nv = dot(s.n, s.v);
  if (nv < 0.02) { s.n = normalize(s.n + s.v * (0.02 - nv)); }
  s.up = upR;
  s.ao = 1.0;
  s.anisotropy = 0.0;
  s.t = vec3f(1.0, 0.0, 0.0);
  s.lightAlpha = 0.0;
  s.materialId = MATERIAL_WATER;
  s.bodyIndex = bi;
  s.altitude = oceanU.misc.x + in.height;
  // The slopes this pixel does not resolve: everything filtered away above, and at least the shortest capillaries.
  s.roughness = clamp(min(resolved, oceanU.wind.y - oceanU.glint.y) / oceanU.wind.y, 0.0, 1.0);
  // The planet-fixed roughness field of brdf_water, from the texture baked over the near field (mip-filtered with
  // this pixel's footprint, as the deferred path filters its octaves).
  waterFieldValue = textureSampleGrad(oceanField, oceanSampler, (in.planeF - oceanU.field.xy) * oceanU.field.w + 0.5, dpx * oceanU.field.w, dpy * oceanU.field.w).r;
  // (Towards fadeStart brdf_water evaluates the field itself, as the deferred pass does for the sheet beyond.)
  waterFieldBaked = smoothstep(0.15, 0.4, detail);
  // The far waves take over as the near field's own waves fade; the planet-fixed lattices of brdf_water (glitter,
  // far waves, field) are anchored on the surface point while it carries waves and, as the detail fades, on the
  // point where the eye ray meets the sea-level sphere, which is the far sheet's.
  waterFarWeight = sqrt(max(1.0 - detail * detail, 0.0));
  waterAnchor = vec4f(posRel, detail);

  // ---- refraction of the real seabed (near field only): where the refracted ray meets the opaque scene.
  let sunDir = b.sunDir.xyz;
  let muS = dot(s.up, sunDir);
  let kMin = min(min(b.ocean.r, b.ocean.g), b.ocean.b);
  // The seabed contributes only where light can make the round trip through the column: beyond about
  // 6 / (2 kappa_min) metres (about 95 m of clear ocean) it is invisible, and refraction is skipped.
  let seeBottom = detail > 0.02 && !strayWater && !sheet && dOpaque > 0.0 && column * kMin < 3.0;
  var conf = 0.0;
  var uvR = uv;
  var hitDepth = 0.0;
  // Cosine of the refracted ray to the vertical as the attenuation uses it: a ray refracted at a real sea surface
  // stays inside the Snell cone of that surface (48.6 deg) plus the steepest wave slope.
  var cosPath = 1.0;
  var bedHit = vec2f(0.0);   // horizontal offset (plane axes, m) from the water point to where the refracted ray ends
  if (seeBottom) {
    // March the refracted ray through the depth copy (6 steps, denser near the surface) to the first opaque
    // surface behind the water: a submerged object or the seabed seen through the waves, no screen-space ghosts.
    let tdir = refract(-s.v, s.n, 1.0 / WATER_IOR);
    let cosT = max(dot(tdir, -s.up), 0.05);
    cosPath = max(cosT, 0.4);
    // The refracted ray is steeper than the view ray: it meets the bed about where the bed lies below the water
    // point (and an object in the water where the view ray does): the march reaches half as far again as the deeper
    // of the two, at least 4 m down; when it meets nothing it samples where it ends.
    let reach = min(max(max(column, min(seaDepth, 40.0)), 4.0) / max(cosT, 0.15), 60.0) * 1.5;
    var tHit = reach;
    var hitUv = uv;
    var lastUv = uv;
    var tLast = reach;
    var found = false;
    var hidden = false;
    var bedUv = vec2f(-1.0);   // the seabed seen beside the ray so far
    var tPrev = 0.0;
    for (var i = 1u; i <= 6u; i++) {
      let t = reach * sq(f32(i) / 6.0);
      let q = posRel + tdir * t;
      let pu = projectToUv(q);
      // Off screen there is nothing to see: keep the last sample that was on screen.
      if (pu.w <= 0.0 || any(pu.xy < vec2f(0.0)) || any(pu.xy > vec2f(1.0))) { break; }
      let px = vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0));
      let d = textureLoad(sceneDepthOpaqueTex, px, 0);
      if (d <= 0.0) { break; }
      let below = length(positionFromDepth(pu.xy, d)) >= dist - 0.05;
      if (below) { lastUv = pu.xy; tLast = t; }
      if (pu.z <= d) {
        if (below) {
          // Behind an opaque surface since the last sample: bisect to where the ray went behind it.
          var lo = tPrev;
          var hi = t;
          for (var k = 0u; k < 3u; k++) {
            let tm = 0.5 * (lo + hi);
            let pm = projectToUv(posRel + tdir * tm);
            let dm = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(pm.xy * size, vec2f(0.0), size - 1.0)), 0);
            if (pm.z <= dm) { hi = tm; } else { lo = tm; }
          }
          let ph = projectToUv(posRel + tdir * hi);
          let dh = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(ph.xy * size, vec2f(0.0), size - 1.0)), 0);
          // A surface the ray really enters is met at its own depth. A ray that only passes BEHIND something nearer
          // to the eye (a float, a hull) crosses that thing's outline far behind it: what the ray meets then is
          // not in the picture.
          if (ph.w - viewZFromDepth(dh) < 0.3 + 0.03 * ph.w + 0.2 * (hi - lo) * 8.0) {
            tHit = 0.5 * (lo + hi);
            hitUv = ph.xy;
            found = true;
          } else {
            hidden = true;
          }
        }
        break;
      }
      let sid = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
      if (below && (sid == MATERIAL_TERRAIN || sid == MATERIAL_REGOLITH)) { bedUv = pu.xy; }
      tPrev = t;
    }
    // How far the refracted image is trusted over the bed straight behind the pixel: fully for a hit well inside
    // the march and the frame, fading out as the hit nears the end of the march or the frame border, so
    // neighbouring pixels never switch between the two. Where the pixel shows an object in the water there is no
    // bed straight behind it: the refracted hit is all there is; a ray whose end is hidden takes the bed it passed
    // (the colour of the bed beside the object, through the column down to the bed), and one that met nothing
    // samples where the march ended.
    if (found) {
      let edge = min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y));
      conf = saturate(edge * 8.0) * (1.0 - smoothstep(0.6, 1.0, tHit / reach));
      if (!seabedPix) { conf = 1.0; }
    } else if (!seabedPix) {
      if (bedUv.x >= 0.0 && seaDepth < 0.5 * OCEAN_DEEP) {
        hitUv = bedUv;
        tHit = clamp(seaDepth, 0.2, 60.0) / max(cosT, 0.15);
      } else {
        hitUv = lastUv;
        tHit = tLast;
      }
      conf = 1.0;
    }
    uvR = uv + (hitUv - uv) * (oceanU.shore.y * detail);
    let dR = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(uvR * size, vec2f(0.0), size - 1.0)), 0);
    if (dR <= 0.0 || length(positionFromDepth(uvR, dR)) < dist - 0.05) { conf = 0.0; }
    hitDepth = tHit * cosT;
    let hf = oceanRotInv(tdir) * tHit;
    bedHit = vec2f(dot(hf, e), dot(hf, f));
  }
  // One depth for the body colour and for the refracted bed: where the refracted ray is trusted, the depth it
  // found (under an object: the object's), elsewhere the seabed below the point.
  let bodyDepth = mix(max(seaDepth, 0.0), hitDepth, conf * detail);

  // ---- foam: whitecaps of the foam map, surf, wake; one density, drawn through the lace.
  var breaker = 0.0;   // thick, fresh foam (0..1)
  var density = 0.0;   // share of the surface covered around the point
  var mapped = 0.0;    // how far the whitecaps are those of the foam map (the rest: the statistical coverage)
  if (detail > 0.0) {
    var wc = vec2f(0.0);
    for (var l = OCEAN_FOAM_LEVELS - 1; l >= 0; l--) {
      let lv = oceanU.foamLevel[l];
      if (lv.w < 0.5) { continue; }
      let fuv = (in.plane0 - lv.xy) / (lv.z * OCEAN_FOAM_SIZE) + 0.5 / OCEAN_FOAM_SIZE;
      let m = min(fuv, 1.0 - fuv);
      // A level is used inside its window (fading over the outer sixteenth) while the pixel resolves its texels.
      let w = saturate(min(m.x, m.y) * 16.0) * (1.0 - smoothstep(1.0, 2.5, fpTex / lv.z));
      if (w <= 0.0) { continue; }
      wc = mix(wc, textureSampleLevel(oceanFoam, linearClamp, fuv, l, 0.0).rg, w);
      mapped = mix(mapped, 1.0, w);
    }
    mapped *= detail;
    // Shallow water damps the chop that breaks.
    wc *= oceanTma(1u, seaDepth) * mapped;
    breaker = wc.x;
    // What a breaker left stays dense and loses AREA as it ages (it tears and shrinks; it does not thin to dust).
    density = saturate(wc.x + oceanU.foam.x * smoothstep(0.25, 0.6, wc.y) * (1.0 - wc.x));
  }
  // Surf: where the water is shallower than the swell can stand in, bores run shoreward at sqrt(g h) (lines of
  // constant travel time to the shore, a sharp front with the foam it leaves behind it), and the swash laps over
  // the last decimetres.
  if (seaDepth < OCEAN_DEEP * 0.5 && detail > 0.0) {
    let dyn = max(seaDepth + in.height, 0.0);
    let swash = 1.0 - smoothstep(0.0, oceanU.shore.x, dyn);
    var bore = 0.0;
    var front = 0.0;
    if (seaDepth < oceanU.surf.x) {
      // Phase: travel time from this depth to the shore over the bore period, plus time; the swell's own height
      // makes the lines irregular along the shore.
      let u = fract(oceanU.surf.y * sqrt(max(seaDepth, 0.0)) + oceanU.time.x * oceanU.surf.z + 0.12 * sw.height);
      let env = smoothstep(oceanU.surf.x, 0.55 * oceanU.surf.x, seaDepth) * saturate(0.75 + 0.5 * sw.height);
      front = smoothstep(0.0, 0.03, u) * (1.0 - smoothstep(0.03, 0.3, u)) * env;
      bore = smoothstep(0.0, 0.03, u) * exp(-u / 0.45) * env;
    }
    let shore = max(0.85 * swash, bore) * detail;
    breaker = max(breaker, max(front, 0.6 * swash) * detail);
    density = 1.0 - (1.0 - density) * (1.0 - shore);
  }
  if ((oceanU.counts.w & 1u) != 0u) {
    let wuv = (in.planeF - oceanU.wake.xy) * oceanU.wake.w + 0.5;
    let edge = saturate(min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)) * 12.0);
    let w = textureSampleLevel(oceanWake, linearClamp, wuv, 0.0).r * edge * detail;
    breaker = max(breaker, saturate(2.0 * w - 0.8));
    density = 1.0 - (1.0 - density) * (1.0 - w);
  }
  // The thinnest foam dissolves instead of leaving single specks.
  density = saturate((density - 0.08) / 0.92);
  // Covered fraction of the pixel: T inside its footprint is uniform about its mean with the measured spread
  // (within [0, 1], the range of T), and foam is where T > 1 - density.
  let laceLo = max(laceT - laceHalf, 0.0);
  let laceHi = min(laceT + laceHalf, 1.0);
  let cover = saturate((laceHi - (1.0 - density)) / max(laceHi - laceLo, 1e-4));
  // Thickness: fresh foam is thick, opaque and white everywhere; what it leaves is thick only well inside the
  // lace (where T is far above the threshold) and thins to a grey film the water shows through at its edges and
  // around its holes.
  let fresh = saturate(1.6 * breaker);
  let thick = max(fresh, saturate((laceT - (1.0 - density)) / 0.3));
  let foamOpaque = cover * mix(0.45, 1.0, thick);
  let statistical = oceanU.shore.w * (1.0 - mapped);
  s.metallic = 1.0 - (1.0 - foamOpaque) * (1.0 - statistical);
  s.clearcoatRoughness = 1.0;
  s.clearcoat = mix(1.0, mix(oceanU.foam.y, 1.0, thick) * (0.8 + 0.2 * laceFine), foamOpaque / max(s.metallic, 1e-5));

  // Imagery colour: the sheet's (band), the seabed's (the terrain draws it with its albedo layer) or that of a stray
  // water fragment.
  s.albedo = select(vec3f(0.0), ga.rgb, sheet || strayWater || seabedPix);
  if (sheet) {
    // The band next to fadeStart: exactly the deferred pixel's inputs (detail is zero here), its own point included.
    s.pos = positionFromDepth(uv, dOpaque);
    s.viewDist = length(s.pos);
    s.v = -s.pos / max(s.viewDist, 1e-6);
    s.param = gm.a;
    s.roughness = gm.r;
    s.n = octDecode(textureLoad(gbufferNormalTex, pix, 0).xy);
    s.metallic = gm.g;
    s.clearcoat = 0.0;
    s.clearcoatRoughness = 0.0;
    waterFarWeight = 1.0;
    waterAnchor = vec4f(0.0);
    waterFieldBaked = 0.0;
  } else {
    // The exact depth while the waves are drawn; towards fadeStart the 8-bit depth the sheet's G-buffer carries.
    let enc = encodeWaterDepth(bodyDepth);
    s.param = mix(round(enc * 255.0) / 255.0, enc, detail);
  }

  // ---- lighting: the deferred pass's terms, through the same brdf_water
  let r = b.center.w + s.altitude;
  var lit = vec3f(0.0);
  var bottomFar = vec3f(0.0);
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
  let cov = waterFoamCoverage(s);

  // ---- the bed through the water, from the scene itself (the seabed as the deferred pass lit it, seen through
  // the column): the refracted image where the march is trusted, the bed straight behind the pixel elsewhere (the
  // same bed, the same light, the same column: no second look to switch to), brightened and darkened by the
  // caustics of the short waves. The modelled bottom of brdf_water takes over only as the detail fades.
  if (seeBottom) {
    var bed = bottomFar;
    let NoV = max(dot(s.n, s.v), 1e-4);
    let tr = (1.0 - waterFresnel(max(muS, 0.0))) * (1.0 - waterFresnel(NoV)) / 0.9604;
    let muW = waterRefractedCos(max(muS, 0.05));
    var so = s;
    var scene = vec3f(0.0);
    var known = 0.0;
    var straight = 0.0;
    if (seabedPix) {
      straight = 1.0;
      so.param = encodeWaterDepth(max(seaDepth, 0.0));
      let att = waterRrsOf(waterOptics(so), vec3f(0.0), muW, waterRefractedCos(max(dot(s.v, s.up), 0.0))).bottomAttenuation * tr;
      scene = textureLoad(sceneColorTex, pix, 0).rgb / max(frame.exposure.x, 1e-30) * att;
      known = 1.0;
    }
    if (conf > 0.0) {
      let ch = oceanU.shore.z * saturate(1.0 - hitDepth / 6.0);
      let seen = vec3f(
        textureSampleLevel(sceneColorTex, linearClamp, uv + (uvR - uv) * (1.0 - ch), 0.0).r,
        textureSampleLevel(sceneColorTex, linearClamp, uvR, 0.0).g,
        textureSampleLevel(sceneColorTex, linearClamp, uv + (uvR - uv) * (1.0 + ch), 0.0).b) / max(frame.exposure.x, 1e-30);
      so.param = encodeWaterDepth(hitDepth);
      let att = waterRrsOf(waterOptics(so), vec3f(0.0), muW, cosPath).bottomAttenuation * tr;
      scene = mix(scene, seen * att, max(conf, 1.0 - straight));
      known = max(known, conf);
    }
    bed = mix(bottomFar, scene, known * detail);
    // Caustics: sunlight reaching the bed point entered the surface up-sun of it; the short waves there focus it
    // (under a crest) or spread it (under a trough). The bundle's area changes by |det(1 + a H)|, a = (1 - 1/n) x
    // path, H the Hessian of the height: taken from the layers' convergence (curvature = mean wavenumber x
    // convergence / choppiness), as the footprint resolves them.
    if (bodyDepth < 12.0 && muS > 0.05 && sunEff.g > 0.0) {
      let sunW = refract(-sunDir, s.up, 1.0 / WATER_IOR);
      let cosW = max(dot(sunW, -s.up), 0.4);
      let hs = oceanRotInv(sunW - s.up * dot(sunW, s.up)) / cosW;
      let pS = in.planeF + bedHit * conf - vec2f(dot(hs, e), dot(hs, f)) * bodyDepth;
      var curv = 0.0;
      for (var c = 2u; c < OCEAN_CASCADES; c++) {
        let cs = oceanU.cascades[c];
        let lod = log2(max(fpTex * 256.0 * cs.geom.y, 1e-6));
        if (amp[c] == 0.0 || lod >= OCEAN_LOD_CUT) { continue; }
        let d = textureSampleLevel(oceanDeriv, linearRepeat, oceanCascadeUv(c, pS), c, max(lod, 0.0));
        curv += -(d.z + d.w) * amp[c] * sqrt(cs.stats.x) / max(cs.stats.y * oceanU.wind.w, 1e-6);
      }
      let q = 1.0 - 0.5 * (1.0 - 1.0 / WATER_IOR) * (bodyDepth / cosW) * curv;
      // 1 / |q|, softened where the bundle focuses to a line (a caustic is as bright as the sun's size and the
      // water's scattering let it be: about three times the mean).
      let focus = 0.95 / sqrt(q * q + 0.1);
      bed *= mix(1.0, focus, exp(-bodyDepth / 4.0) * detail * saturate(luminance(sunEff) / max(luminance(sunEff) + luminance(amb.skyIrradiance), 1e-9)));
    }
    lit += (bed - bottomFar) * (1.0 - cov);
  }

  // ---- vessels in the water: their image in the surface (a short march of the mirrored ray through the scene
  // copies), and their bulk hiding the sky where the march finds nothing.
  var near = 0.0;
  var hull = vec4f(0.0);
  for (var i = 0u; i < min(oceanU.counts.y, OCEAN_MAX_VESSELS); i++) {
    let v = oceanU.vessels[i];
    let w = (1.0 - smoothstep(4.0 * v.b.z, 9.0 * v.b.z, distance(in.planeF, v.a.xy))) * detail;
    if (w > near) {
      near = w;
      hull = vec4f(v.a.xy, v.b.z, v.b.w);
    }
  }
  if (near > 0.0) {
    let pt = waterPoint(s);
    let alpha = waterAlphaOf(s, pt);
    var m = waterMirror(s, pt, alpha);
    // The slopes the pixel does not resolve soften the image: one facet of them per pixel (a slope drawn from their
    // distribution, at a quarter of its spread, turns the mirrored ray by twice its angle), on top of the break-up by the
    // ripples the pixel does resolve.
    let bn = blueNoise(pix).xy - 0.5;
    let tf = tangentFrame(m.xyz);
    m = vec4f(normalize(m.xyz + (tf[0] * bn.x + tf[1] * bn.y) * (1.2 * alpha / WATER_GGX_KAPPA)), m.w);
    let reach = 7.0 * hull.z;
    var hit = false;
    var tPrev = 0.0;
    var tHit = 0.0;
    for (var i = 1u; i <= 12u; i++) {
      let t = reach * sq(f32(i) / 12.0);
      let pu = projectToUv(posRel + m.xyz * t);
      if (pu.w <= 0.0 || any(pu.xy < vec2f(0.0)) || any(pu.xy > vec2f(1.0))) { break; }
      let d = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(pu.xy * size, vec2f(0.0), size - 1.0)), 0);
      // Behind something no thicker than a hull: the ray has entered it between this sample and the last.
      if (d > 0.0 && pu.z <= d && pu.w - viewZFromDepth(d) < 2.0 * hull.z) {
        var lo = tPrev;
        var hi = t;
        for (var k = 0u; k < 3u; k++) {
          let tm = 0.5 * (lo + hi);
          let pm = projectToUv(posRel + m.xyz * tm);
          let dm = textureLoad(sceneDepthOpaqueTex, vec2i(clamp(pm.xy * size, vec2f(0.0), size - 1.0)), 0);
          if (dm > 0.0 && pm.z <= dm) { hi = tm; } else { lo = tm; }
        }
        tHit = hi;
        hit = true;
        break;
      }
      tPrev = t;
    }
    let sky = waterSkyRadiance(s, m.xyz, alpha);
    if (hit) {
      let hu = projectToUv(posRel + m.xyz * tHit).xy;
      let hp = vec2i(clamp(hu * size, vec2f(0.0), size - 1.0));
      let id = u32(textureLoad(gbufferMaterialTex, hp, 0).b * 255.0 + 0.5);
      // Only what stands in the air mirrors in the water (not the bed seen through it, not the far sheet).
      if (id != MATERIAL_TERRAIN && id != MATERIAL_REGOLITH && id != MATERIAL_WATER) {
        let edge = saturate(min(min(hu.x, 1.0 - hu.x), min(hu.y, 1.0 - hu.y)) * 12.0);
        let image = textureSampleLevel(sceneColorTex, linearClamp, hu, 0.0).rgb / max(frame.exposure.x, 1e-30);
        lit += (image - sky) * (m.w * (1.0 - cov) * near * edge);
      }
    } else {
      // The mirrored ray misses on screen but passes through the hull's bulk: the hull, not the sky, is mirrored
      // there (its shaded side, about a quarter of the sky).
      let cRel = oceanU.refRel.xyz + oceanRot(oceanSphereOffset(hull.xy)) + upR * (hull.w + 0.55 * hull.z);
      let oc = cRel - posRel;
      let tc = max(dot(oc, m.xyz), 0.0);
      let miss = length(oc - m.xyz * tc);
      let block = (1.0 - smoothstep(0.45 * hull.z, 0.8 * hull.z, miss)) * near;
      lit -= sky * (0.75 * block * m.w * (1.0 - cov));
    }
  }

  // Debug views (OCEAN_DEBUG_VIEWS): one term at a time, same exposure.
  let view = (oceanU.counts.w >> 8u) & 15u;
  if (view != 0u) {
    var d = vec3f(0.0);
    let pt = waterPoint(s);
    let alpha = waterAlphaOf(s, pt);
    let m = waterMirror(s, pt, alpha);
    switch (view) {
      case 1u: { d = waterSkyRadiance(s, m.xyz, alpha) * m.w * (1.0 - cov); }
      case 2u: { d = (waterBodyAmbient(s, amb).total + waterBodyDirect(s, sunDir).total * sunEff) * (1.0 - cov); }
      case 3u: {
        var ss = s;
        ss.lightAlpha = 0.6 * frame.sunDir.w;
        ss.albedo = vec3f(0.0);
        d = (brdfWaterDirect(ss, sunDir) - waterBodyDirect(ss, sunDir).total * (1.0 - cov)) * sunEff;
      }
      case 4u: { d = vec3f(cov * s.clearcoat) * 2000.0; }
      case 5u: { d = (s.n * 0.5 + 0.5) * 2000.0; }
      case 6u: { d = vec3f(s.roughness, sqrt(alpha), detail) * 2000.0; }
      case 7u: { d = vec3f(breaker, density, mapped) * 2000.0; }
      case 8u: { d = vec3f(conf, min(seaDepth, 10.0) * 0.1, hitDepth * 0.1) * 2000.0; }
      default: { d = lit; }
    }
    lit = d;
  }

  var o: FsOut;
  o.color = vec4f(writeHdr(lit * frame.exposure.x) * opacity, opacity);
  // Motion vectors of the surface itself (water particle motion, swell, body rotation, camera). The evolving
  // wave pattern has no single motion vector (dispersive, many directions): TAA treats it like any change.
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
