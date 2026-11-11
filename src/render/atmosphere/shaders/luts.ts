/**
 * Compute shaders of the atmosphere tables: transmittance (256 x 64 per atmosphere body), multi-scattering
 * (32 x 32, closed-form infinite series), sky irradiance (64 x 16), the sky-view table around the camera
 * (192 x 108) and the camera-frustum aerial-perspective volume (32^3).
 *
 * Every module declares group 1 binding 0 = AtmoU; the other bindings are listed per shader.
 */
import { AERIAL_SIZE, MULTISCATTER_LUT_SIZE, SKY_IRRADIANCE_LUT_SIZE, SKY_VIEW_LUT_SIZE, TRANSMITTANCE_LUT_SIZE } from '../math';
import { ATMO_UNIFORM_WGSL } from '../uniforms';

const HEADER = /* wgsl */ `
#include "atmosphere_model"
${ATMO_UNIFORM_WGSL}
@group(1) @binding(0) var<uniform> atmo: AtmoU;
`;

const f = (x: number): string => x.toFixed(1);

/** Bindings: 1 = output (texture_storage_2d_array rgba16float). */
export const TRANSMITTANCE_COMPUTE_WGSL = /* wgsl */ `
${HEADER}
@group(1) @binding(1) var outTex: texture_storage_2d_array<rgba16float, write>;

const STEPS = 256;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${TRANSMITTANCE_LUT_SIZE[0]}u || id.y >= ${TRANSMITTANCE_LUT_SIZE[1]}u || i32(id.z) >= atmo.layers.z) { return; }
  let bi = u32(atmo.lutBody[id.z]);
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let top = rt - rb;
  // The texel in the cancellation-free form of the Bruneton mapping: altitude h, distance d to the top.
  let xMu = f32(id.x) / ${f(TRANSMITTANCE_LUT_SIZE[0] - 1)};
  let xR = f32(id.y) / ${f(TRANSMITTANCE_LUT_SIZE[1] - 1)};
  let H = sqrt(top * (rt + rb));
  let rho = H * xR;
  let r = sqrt(rho * rho + rb * rb);
  let h = rho * rho / (r + rb);
  let dMin = top - h;
  let dMax = rho + H;
  let d = dMin + xMu * (dMax - dMin);
  // 2 r mu, from |p + d ray| = rt.
  var twoRMu = 2.0 * r;
  if (d > 0.0) { twoRMu = clamp((H * H - rho * rho - d * d) / d, -2.0 * r, 2.0 * r); }
  // Samples quadratically denser at the start of the ray, where an upward ray is in the densest air.
  var tau = vec3f(0.0);
  var uPrev = 0.0;
  for (var i = 0; i < STEPS; i++) {
    let uNext = f32(i + 1) / f32(STEPS);
    let uMid = (f32(i) + 0.5) / f32(STEPS);
    let t = d * uMid * uMid;
    let q = twoRMu * t + t * t;
    let hs = h + q / (sqrt(max(r * r + q, 0.0)) + r);
    tau += atmoMedium(bi, hs).ext * (d * (uNext * uNext - uPrev * uPrev));
    uPrev = uNext;
  }
  textureStore(outTex, id.xy, id.z, vec4f(exp(-tau), 1.0));
}
`;

/** Bindings: 1 = transmittance (texture_2d_array), 2 = output (texture_storage_2d_array rgba16float). */
export const MULTISCATTER_COMPUTE_WGSL = /* wgsl */ `
${HEADER}
@group(1) @binding(1) var transLut: texture_2d_array<f32>;
@group(1) @binding(2) var outTex: texture_storage_2d_array<rgba16float, write>;

const SQRT_DIRS = 8;
const STEPS = 20;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${MULTISCATTER_LUT_SIZE[0]}u || id.y >= ${MULTISCATTER_LUT_SIZE[1]}u || i32(id.z) >= atmo.layers.z) { return; }
  let bi = u32(atmo.lutBody[id.z]);
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let top = rt - rb;
  let muS = f32(id.x) / ${f(MULTISCATTER_LUT_SIZE[0] - 1)} * 2.0 - 1.0;
  let h = clamp(f32(id.y) / ${f(MULTISCATTER_LUT_SIZE[1] - 1)} * top, 1.0, top - 1.0);
  let r = rb + h;
  let sinS = sqrt(max(1.0 - muS * muS, 0.0));
  var l2 = vec3f(0.0);
  var fms = vec3f(0.0);
  for (var a = 0; a < SQRT_DIRS; a++) {
    for (var b = 0; b < SQRT_DIRS; b++) {
      let mu = 1.0 - 2.0 * (f32(a) + 0.5) / f32(SQRT_DIRS);
      let phi = TWO_PI * (f32(b) + 0.5) / f32(SQRT_DIRS);
      let nu = mu * muS + sqrt(max(1.0 - mu * mu, 0.0)) * sinS * cos(phi);
      let ground = atmoRaySphere(r, h, mu, rb);
      let hitsGround = mu < 0.0 && ground.y > ground.x && ground.x > 0.0;
      var len = max(atmoRaySphere(r, h - top, mu, rt).y, 0.0);
      if (hitsGround) { len = ground.x; }
      let dt = len / f32(STEPS);
      var T = vec3f(1.0);
      var L = vec3f(0.0);
      var F = vec3f(0.0);
      for (var s = 0; s < STEPS; s++) {
        let t = (f32(s) + 0.5) * dt;
        let hs = altitudeAt(t, r, h, mu);
        let rs = rb + max(hs, 0.0);
        let muSs = clamp((r * muS + t * nu) / rs, -1.0, 1.0);
        let m = atmoMedium(bi, hs);
        let scat = m.scatR + vec3f(m.scatM);
        let sun = atmosphereSunTransmittance(transLut, bi, rs, muSs) * atmoHorizonVisibility(rs, rb, muSs);
        let k = atmoSegment(m.ext, dt);
        L += T * sun * scat * (k / (4.0 * PI));
        F += T * scat * k;
        T *= exp(-m.ext * dt);
      }
      if (hitsGround) {
        let muSg = clamp((r * muS + len * nu) / rb, -1.0, 1.0);
        let sun = atmosphereSunTransmittance(transLut, bi, rb, muSg) * atmoHorizonVisibility(rb, rb, muSg);
        L += T * sun * (max(muSg, 0.0) * frame.bodies[bi].misc.y / PI);
      }
      l2 += L;
      fms += F;
    }
  }
  let n = f32(SQRT_DIRS * SQRT_DIRS);
  // Means over the sphere: second-order luminance per unit illuminance, and the fraction of isotropic unit
  // luminance that is scattered back to the point. Orders 2..infinity: l2 / (1 - fms).
  textureStore(outTex, id.xy, id.z, vec4f((l2 / n) / (vec3f(1.0) - min(fms / n, vec3f(0.999))), 1.0));
}
`;

/** Bindings: 1 = transmittance, 2 = multi-scattering (texture_2d_array), 3 = output (texture_storage_2d_array rgba16float). */
export const SKY_IRRADIANCE_COMPUTE_WGSL = /* wgsl */ `
${HEADER}
@group(1) @binding(1) var transLut: texture_2d_array<f32>;
@group(1) @binding(2) var msLut: texture_2d_array<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d_array<rgba16float, write>;

const N_MU = 16;
const N_PHI = 16;   // over half the circle; the sky is symmetric about the sun's vertical plane
const STEPS = 16;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${SKY_IRRADIANCE_LUT_SIZE[0]}u || id.y >= ${SKY_IRRADIANCE_LUT_SIZE[1]}u || i32(id.z) >= 2 * atmo.layers.z) { return; }
  // Layers 0 .. n - 1: the irradiance of the whole sky on a horizontal surface (the contract). Layers
  // n .. 2n - 1: that of the half of the sky away from the sun, doubled: what lights a surface in shade.
  let away = i32(id.z) >= atmo.layers.z;
  let layer = i32(id.z) % atmo.layers.z;
  let bi = u32(atmo.lutBody[layer]);
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let top = rt - rb;
  let muS = f32(id.x) / ${f(SKY_IRRADIANCE_LUT_SIZE[0] - 1)} * 1.2 - 0.2;
  let h = clamp(f32(id.y) / ${f(SKY_IRRADIANCE_LUT_SIZE[1] - 1)} * top, 1.0, top - 1.0);
  let r = rb + h;
  let sinS = sqrt(max(1.0 - muS * muS, 0.0));
  let g = frame.bodies[bi].mie.w;
  var E = vec3f(0.0);
  for (var a = 0; a < N_MU; a++) {
    let mu = (f32(a) + 0.5) / f32(N_MU);
    let sinV = sqrt(max(1.0 - mu * mu, 0.0));
    let len = max(atmoRaySphere(r, h - top, mu, rt).y, 0.0);
    for (var b = 0; b < N_PHI; b++) {
      if (away && b < N_PHI / 2) { continue; }
      let phi = PI * (f32(b) + 0.5) / f32(N_PHI);
      let nu = mu * muS + sinV * sinS * cos(phi);
      let phaseR = atmoPhaseR(nu);
      let phaseM = atmoPhaseM(nu, g);
      var T = vec3f(1.0);
      var L = vec3f(0.0);
      var uPrev = 0.0;
      for (var s = 0; s < STEPS; s++) {
        let uNext = f32(s + 1) / f32(STEPS);
        let uMid = (f32(s) + 0.5) / f32(STEPS);
        let t = len * uMid * uMid;
        let dt = len * (uNext * uNext - uPrev * uPrev);
        uPrev = uNext;
        let hs = altitudeAt(t, r, h, mu);
        let rs = rb + max(hs, 0.0);
        let muSs = clamp((r * muS + t * nu) / rs, -1.0, 1.0);
        let m = atmoMedium(bi, hs);
        let sun = atmosphereSunTransmittance(transLut, bi, rs, muSs) * atmoHorizonVisibility(rs, rb, muSs);
        let src = sun * (m.scatR * phaseR + vec3f(m.scatM * phaseM)) + atmoMultiScatter(msLut, layer, hs, muSs, top) * (m.scatR + vec3f(m.scatM));
        L += T * src * atmoSegment(m.ext, dt);
        T *= exp(-m.ext * dt);
      }
      // d(omega) = d(mu) d(phi), both half-circles, times the cosine to the horizontal plane.
      E += L * (mu * 2.0 * (1.0 / f32(N_MU)) * (PI / f32(N_PHI)));
    }
  }
  textureStore(outTex, id.xy, id.z, vec4f(E * frame.sunIlluminance.rgb * select(1.0, 2.0, away), 1.0));
}
`;

/**
 * Bindings: 1 = transmittance, 2 = multi-scattering (texture_2d_array), 3 = output (texture_storage_2d
 * rgba16float), 4 = cloud coverage map, 5 = sky irradiance (texture_2d_array).
 *
 * The table is what water and the environment probe reflect. Seen from under the cloud layer, the clouds
 * are part of that sky: each direction above the horizon takes the cover of the coverage map where it
 * meets the cloud base (more of it at a slant: clouds have sides) and, for that share, the radiance of a
 * cloud base instead of the clear sky behind it. A sea under an overcast reflects grey, not blue.
 */
export const SKY_VIEW_COMPUTE_WGSL = /* wgsl */ `
${HEADER}
@group(1) @binding(1) var transLut: texture_2d_array<f32>;
@group(1) @binding(2) var msLut: texture_2d_array<f32>;
@group(1) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var atmoCoverageTex: texture_2d<f32>;
@group(1) @binding(5) var irradianceLut: texture_2d_array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${SKY_VIEW_LUT_SIZE[0]}u || id.y >= ${SKY_VIEW_LUT_SIZE[1]}u) { return; }
  let bi = u32(atmo.bodies.w);
  let layer = i32(frame.bodies[bi].fixedX.w);
  // Inverse of skyViewUv (chunk atmosphere_common): elevation above the local horizontal, azimuth from the sun's.
  let uv = (vec2f(id.xy) + 0.5) / vec2f(${f(SKY_VIEW_LUT_SIZE[0])}, ${f(SKY_VIEW_LUT_SIZE[1])});
  let c = (0.5 - uv.y) * 2.0;
  let l = sign(c) * c * c * (PI * 0.5);
  let az = (uv.x - 0.5) * TWO_PI;
  let up = frame.bodies[bi].cameraUp.xyz;
  let sunDir = frame.bodies[bi].sunDir.xyz;
  var e = sunDir - up * dot(sunDir, up);
  if (dot(e, e) < 1e-8) { e = cross(up, vec3f(0.0, 0.0, 1.0)) + cross(up, vec3f(1.0, 0.0, 0.0)) * 1e-3; }
  e = normalize(e);
  let nrm = cross(up, e);
  let d = normalize(cos(l) * (cos(az) * e + sin(az) * nrm) + sin(l) * up);
  let path = atmoIntegrate(transLut, msLut, bi, layer, d, atmoRay(bi, d), i32(atmo.steps.z));
  var L = path.L;
  var a = dot(path.T, vec3f(1.0 / 3.0));
  let h0 = frame.bodies[bi].sunDir.w;
  let mu = dot(d, up);
  if (atmo.bodies.z == i32(bi) && atmo.cloudShell.x > 0.0 && h0 < atmo.cloudShell.z && mu > 0.0) {
    let rb = frame.bodies[bi].center.w;
    let tc = atmoRaySphere(frame.bodies[bi].cameraUp.w, h0 - atmo.cloudShell.z, mu, atmo.cloudShell.x).y;
    if (tc > 0.0) {
      let pos = d * tc;
      let upC = normalize(pos - frame.bodies[bi].center.xyz);
      let dfix = normalize(rootToFixed(bi, pos - frame.bodies[bi].center.xyz));
      let lon = atan2(dfix.y, dfix.x) + atmo.noiseRot.z;
      let uvC = vec2f(lon / TWO_PI + 0.5, clamp(acos(clamp(dfix.z, -1.0, 1.0)) / PI, 0.0005, 0.9995));
      // (One texel of the table is about three degrees: the map is read at that size.)
      let texel = TWO_PI * rb / atmo.noiseRot.w;
      let c = textureSampleLevel(atmoCoverageTex, linearRepeat, uvC, log2(max(0.05 * tc / texel, 1.0))).r;
      // The low layer's cover as the density model has it on average (fair-weather fields included).
      let cover = saturate(c * atmo.cloudLow.w + atmo.cloudLow2.x * 0.375 * (1.0 - smoothstep(0.0, 0.3, c)));
      let share = 1.0 - pow(1.0 - min(cover, 0.98), 1.0 / max(dot(d, upC), 0.2));
      // A cloud base: what the column passes of the sun's light, and half the sky's from its sides.
      let muS = dot(upC, sunDir);
      let tau = atmo.cloudLow.y * 0.6 * atmo.cloudLow.x * mix(0.45, 1.0, cover);
      let rc = rb + atmo.cloudShell.z;
      let sun = frame.sunIlluminance.rgb * atmosphereSunTransmittance(transLut, bi, rc, muS) * (atmoHorizonVisibility(rc, rb, muS) * saturate(muS) * (1.0 / (1.0 + atmo.cloudLight.y * tau) + 0.08));
      let sky = textureSampleLevel(irradianceLut, linearClamp, skyIrradianceUvFromRMuS(rc, muS, rb, frame.bodies[bi].prevCenter.w), layer + atmo.layers.z, 0.0).rgb;
      let base = (sun + 0.5 * sky) / PI;
      // (The air in front of the cloud: what the path to it has not let through is the clear sky's light.)
      let front = exp(-atmoMedium(bi, 0.5 * (h0 + atmo.cloudShell.z)).ext * tc);
      L = L * (vec3f(1.0) - share * front) + base * (share * front);
      a *= 1.0 - share;
    }
  }
  // rgb = sky luminance (cd/m^2); a = mean transmittance of the path (to space, or to the reference sphere).
  textureStore(outTex, id.xy, vec4f(L, a));
}
`;

/**
 * Bindings: 1 = transmittance, 2 = multi-scattering (texture_2d_array), 3 = cloud shadow map, 4 = coverage
 * map (texture_2d), 5 = output (texture_storage_3d rgba16float).
 */
export const AERIAL_COMPUTE_WGSL = /* wgsl */ `
${HEADER}
@group(1) @binding(1) var transLut: texture_2d_array<f32>;
@group(1) @binding(2) var msLut: texture_2d_array<f32>;
@group(1) @binding(3) var atmoShadowTex: texture_2d<f32>;
@group(1) @binding(4) var atmoCoverageTex: texture_2d<f32>;
@group(1) @binding(5) var outTex: texture_storage_3d<rgba16float, write>;
#include "atmosphere_cloud_shadow"

const SLICES = ${AERIAL_SIZE};

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${AERIAL_SIZE}u || id.y >= ${AERIAL_SIZE}u) { return; }
  let uv = (vec2f(id.xy) + 0.5) / ${f(AERIAL_SIZE)};
  let d = normalize(viewRay(uv));
  var rays: array<AtmoRay, 2>;
  var phases: array<vec2f, 2>;
  var others: array<vec2f, 2>;   // eclipses by other bodies at the two ends of each path
  for (var a = 0; a < 2; a++) {
    rays[a].len = -1.0;
    let bix = atmo.bodies[a];
    if (bix < 0) { continue; }
    let bi = u32(bix);
    rays[a] = atmoRay(bi, d);
    others[a] = vec2f(atmoOtherVisibility(d * rays[a].t0, frame.bodies[bi].sunDir.xyz, bi), atmoOtherVisibility(d * (rays[a].t0 + max(rays[a].len, 0.0)), frame.bodies[bi].sunDir.xyz, bi));
    let cosSun = dot(d, frame.bodies[bi].sunDir.xyz);
    phases[a] = vec2f(atmoPhaseR(cosSun), atmoPhaseM(cosSun, frame.bodies[bi].mie.w));
  }
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  var tPrev = 0.0;
  for (var k = 0; k < SLICES; k++) {
    // Layer k holds the path from the eye to the distance of its texel centre.
    let tNext = aerialSliceToDistance(f32(k) + 0.5);
    let len = tNext - tPrev;
    let n = clamp(i32(ceil(len / 2500.0)), 1, 6);
    let dt = len / f32(n);
    for (var j = 0; j < n; j++) {
      let ts = tPrev + (f32(j) + 0.5) * dt;
      var src = vec3f(0.0);
      var ext = vec3f(0.0);
      for (var a = 0; a < 2; a++) {
        let s = ts - rays[a].t0;
        if (s <= 0.0 || s >= rays[a].len) { continue; }
        let bi = u32(atmo.bodies[a]);
        let o = atmoSampleAt(transLut, msLut, bi, atmo.layers[a], d, rays[a], s, phases[a], mix(others[a].x, others[a].y, s / rays[a].len));
        src += atmoCloudedSource(o.direct, o.multi, atmoCloudPassOnRay(bi, d, rays[a], s));
        ext += o.ext;
      }
      L += T * src * atmoSegment(ext, dt);
      T *= exp(-ext * dt);
    }
    // (Luminance, not pre-exposed: kept inside what a half float holds.)
    // One transmittance for three channels (the contract's alpha): the luminance-weighted one, so that what a
    // transparent surface loses in brightness over the path is exact for a white emitter.
    textureStore(outTex, vec3u(id.xy, u32(k)), vec4f(min(L, vec3f(HDR_MAX)), dot(T, vec3f(0.2126, 0.7152, 0.0722))));
    tPrev = tNext;
  }
}
`;
