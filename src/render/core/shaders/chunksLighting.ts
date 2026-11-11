/**
 * Core WGSL chunks, part 2: BRDFs (incl. the three overridable chunks), eclipse, atmosphere helpers,
 * sun shadow sampling, transparency helper, depth-aware upsample. Signatures are documented in
 * docs/RENDER_API.md and are part of the public API.
 */
export const SHADOW_MAX_CASCADES = 8;

export const BRDF_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"

/// A shaded point. Filled by the deferred pass from the G-buffer; forward shaders fill it themselves.
struct Surface {
  pos: vec3f,              // camera-relative position (ROOT axes, m)
  viewDist: f32,           // distance from the eye (m)
  n: vec3f,                // unit shading normal (ROOT axes)
  ao: f32,                 // baked AO x screen-space AO, 0..1
  v: vec3f,                // unit vector towards the eye
  roughness: f32,          // perceptual roughness
  albedo: vec3f,           // linear base colour
  metallic: f32,
  t: vec3f,                // unit tangent (anisotropy direction)
  anisotropy: f32,         // -1..1
  up: vec3f,               // local vertical of the nearest body at the point (unit); n when there is no body
  altitude: f32,           // height above the nearest body's reference radius (m)
  clearcoat: f32,
  clearcoatRoughness: f32,
  param: f32,              // material parameter (MATERIAL_PARAM)
  lightAlpha: f32,         // extra GGX alpha of the light being evaluated (angular radius of the source); set per light by the caller
  materialId: u32,
  bodyIndex: i32,          // nearest frame body, -1 = none
}

/// Ambient light arriving at a surface, prepared by the caller. The two irradiance terms are ALTERNATIVES:
/// the probe already contains the sky (rendering-design 8.3), so no surface may add both. Terrain and water
/// take skyIrradiance (valid per pixel at any distance); standard and cloth take envIrradiance (the probe
/// at the active vessel) and ignore skyIrradiance; for regolith the caller sets envIrradiance only on a
/// body without an atmosphere table (where skyIrradiance is 0).
struct AmbientInput {
  skyIrradiance: vec3f,    // lux from the sky hemisphere ('atmosphere.skyIrradianceLut'), already tilted to the surface normal
  envIrradiance: vec3f,    // lux from the environment probe SH ('env.sh9') along the normal (0 for terrain and water)
  envSpecular: vec3f,      // cd/m^2, prefiltered 'env.probeCube' along the reflection vector at the surface roughness
  envSpecularCoat: vec3f,  // the same at the clearcoat roughness
  skyReflection: vec3f,    // cd/m^2, sky radiance along the reflection vector, valid at any distance (water)
  specularOcclusion: f32,
}

fn pow5(x: f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }
fn D_GGX(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * d * d);
}
fn V_SmithGGXCorrelated(NoV: f32, NoL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}
fn D_GGX_Anisotropic(NoH: f32, ToH: f32, BoH: f32, at: f32, ab: f32) -> f32 {
  let a2 = at * ab;
  let d = vec3f(ab * ToH, at * BoH, a2 * NoH);
  let w2 = a2 / max(dot(d, d), 1e-12);
  return a2 * w2 * w2 / PI;
}
fn V_SmithGGXCorrelated_Anisotropic(at: f32, ab: f32, ToV: f32, BoV: f32, ToL: f32, BoL: f32, NoV: f32, NoL: f32) -> f32 {
  let lv = NoL * length(vec3f(at * ToV, ab * BoV, NoV));
  let ll = NoV * length(vec3f(at * ToL, ab * BoL, NoL));
  return 0.5 / max(lv + ll, 1e-6);
}
fn F_Schlick(f0: vec3f, VoH: f32) -> vec3f { return f0 + (vec3f(1.0) - f0) * pow5(1.0 - VoH); }
fn Fd_Burley(NoV: f32, NoL: f32, LoH: f32, roughness: f32) -> f32 {
  let f90 = 0.5 + 2.0 * roughness * LoH * LoH;
  return (1.0 + (f90 - 1.0) * pow5(1.0 - NoL)) * (1.0 + (f90 - 1.0) * pow5(1.0 - NoV)) / PI;
}
/// Karis' analytic fit of the split-sum environment BRDF: specular = f0 * x + y.
fn envBrdfApprox(roughness: f32, NoV: f32) -> vec2f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}
/// Multiple-scattering energy compensation factor for the specular lobe (Kulla-Conty via the split-sum albedo).
fn energyCompensation(f0: vec3f, roughness: f32, NoV: f32) -> vec3f {
  let dfg = envBrdfApprox(roughness, NoV);
  return vec3f(1.0) + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
}
fn ggxAlpha(roughness: f32, lightAlpha: f32) -> f32 {
  let a = max(roughness * roughness, 0.0015);
  return sqrt(a * a + lightAlpha * lightAlpha);
}

/// MATERIAL_STANDARD: BRDF x NoL for unit light direction l. Isotropic or anisotropic GGX (height-correlated
/// Smith) + Burley diffuse + multiscatter compensation, optional clearcoat.
fn brdfStandardDirect(s: Surface, l: vec3f) -> vec3f {
  let NoL = dot(s.n, l);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let h = normalize(s.v + l);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let NoH = saturate(dot(s.n, h));
  let LoH = saturate(dot(l, h));
  let f0 = mix(vec3f(0.04), s.albedo, s.metallic);
  let diffuseColor = s.albedo * (1.0 - s.metallic);
  let a = ggxAlpha(s.roughness, s.lightAlpha);
  var dv: f32;
  if (s.anisotropy != 0.0) {
    let at = max(a * (1.0 + s.anisotropy), 0.0015);
    let ab = max(a * (1.0 - s.anisotropy), 0.0015);
    let b = normalize(cross(s.n, s.t));
    dv = D_GGX_Anisotropic(NoH, dot(s.t, h), dot(b, h), at, ab)
       * V_SmithGGXCorrelated_Anisotropic(at, ab, dot(s.t, s.v), dot(b, s.v), dot(s.t, l), dot(b, l), NoV, NoL);
  } else {
    dv = D_GGX(NoH, a) * V_SmithGGXCorrelated(NoV, NoL, a);
  }
  let spec = dv * F_Schlick(f0, LoH) * energyCompensation(f0, s.roughness, NoV);
  var c = diffuseColor * Fd_Burley(NoV, NoL, LoH, s.roughness) + spec;
  if (s.clearcoat > 0.0) {
    let ac = ggxAlpha(max(s.clearcoatRoughness, 0.03), s.lightAlpha);
    let fc = (0.04 + 0.96 * pow5(1.0 - LoH)) * s.clearcoat;
    c = c * (1.0 - fc) + vec3f(D_GGX(NoH, ac) * (0.25 / max(LoH * LoH, 1e-4)) * fc);
  }
  return c * NoL;
}
fn brdfStandardAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let NoV = max(dot(s.n, s.v), 1e-4);
  let f0 = mix(vec3f(0.04), s.albedo, s.metallic);
  let dfg = envBrdfApprox(s.roughness, NoV);
  // Diffuse ambient is the probe alone: 'env.sh9' already holds the sky, adding a.skyIrradiance would count it twice.
  let diffuse = s.albedo * (1.0 - s.metallic) * a.envIrradiance * (s.ao / PI);
  let spec = a.envSpecular * (f0 * dfg.x + vec3f(dfg.y)) * energyCompensation(f0, s.roughness, NoV) * a.specularOcclusion;
  var c = diffuse + spec;
  if (s.clearcoat > 0.0) {
    let fc = (0.04 + 0.96 * pow5(1.0 - NoV)) * s.clearcoat;
    c = c * (1.0 - fc) + a.envSpecularCoat * (fc * a.specularOcclusion);
  }
  return c;
}

/// MATERIAL_CLOTH: Charlie sheen + wrapped diffuse; s.param = thin-surface translucency (back-lighting).
fn brdfClothDirect(s: Surface, l: vec3f) -> vec3f {
  let NoLs = dot(s.n, l);
  let NoL = saturate(NoLs);
  let h = normalize(s.v + l);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let NoH = saturate(dot(s.n, h));
  let a = max(s.roughness * s.roughness, 0.05);
  let sin2 = max(1.0 - NoH * NoH, 0.0078125);
  let dCharlie = (2.0 + 1.0 / a) * pow(sin2, 0.5 / a) / TWO_PI;
  let vNeubelt = 1.0 / (4.0 * (NoL + NoV - NoL * NoV) + 1e-4);
  let sheen = mix(vec3f(0.04), s.albedo, 0.35) * (dCharlie * vNeubelt);
  let wrap = saturate((NoLs + 0.3) / 1.69);
  let front = s.albedo * (wrap / PI) * (1.0 - 0.5 * s.param) + sheen * NoL;
  // Light arriving on the far side shines through the fabric: diffuse transmission with a forward lobe.
  let back = saturate(-NoLs);
  let forward = 0.6 + 0.4 * pow(saturate(dot(-s.v, l)), 4.0) * 4.0;
  let through = s.albedo * s.albedo * (s.param * back * forward / PI);
  return front + through;
}
fn brdfClothAmbient(s: Surface, a: AmbientInput) -> vec3f {
  return s.albedo * a.envIrradiance * (s.ao / PI);   // the probe alone, as for standard materials
}
`;

export const BRDF_TERRAIN_WGSL = /* wgsl */ `
// OVERRIDABLE chunk "brdf_terrain" (MATERIAL_TERRAIN). Fixed signatures:
//   fn brdfTerrainDirect(s: Surface, l: vec3f) -> vec3f      BRDF x NoL for unit light direction l
//   fn brdfTerrainAmbient(s: Surface, a: AmbientInput) -> vec3f   luminance from ambient light
// s.param = wetness 0..1 (the caller has NOT applied it). Default: Lambert + a low GGX lobe.
fn terrainWet(s: Surface) -> vec4f {
  let w = s.param;
  return vec4f(s.albedo * mix(1.0, 0.55, w), mix(s.roughness, min(s.roughness, 0.3), w));
}
fn brdfTerrainDirect(s: Surface, l: vec3f) -> vec3f {
  let NoL = dot(s.n, l);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let m = terrainWet(s);
  let h = normalize(s.v + l);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let a = ggxAlpha(max(m.w, 0.25), s.lightAlpha);
  let f0 = mix(0.02, 0.04, s.param);
  let spec = D_GGX(saturate(dot(s.n, h)), a) * V_SmithGGXCorrelated(NoV, NoL, a) * (f0 + (1.0 - f0) * pow5(1.0 - saturate(dot(l, h))));
  return (m.rgb / PI + vec3f(spec)) * NoL;
}
fn brdfTerrainAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let m = terrainWet(s);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let dfg = envBrdfApprox(max(m.w, 0.25), NoV);
  return (m.rgb * a.skyIrradiance / PI + a.skyReflection * (0.03 * dfg.x + dfg.y)) * s.ao;
}
`;

export const BRDF_REGOLITH_WGSL = /* wgsl */ `
// OVERRIDABLE chunk "brdf_regolith" (MATERIAL_REGOLITH). Fixed signatures:
//   fn brdfRegolithDirect(s: Surface, l: vec3f) -> vec3f
//   fn brdfRegolithAmbient(s: Surface, a: AmbientInput) -> vec3f
// Requires 'hapkeLut' (texture_2d<f32>, 256 x MAX_BODIES r16float: albedo -> single-scattering albedo w per
// body row), which the deferred lighting module binds. s.param = crater freshness 0..1.
// Default: the Hapke function of rendering-design 8.2 (shadow-hiding opposition surge, Lommel-Seeliger limb).

/// BRDF x mu0 of a Hapke surface. p = (b0, hS, bP, cP).
fn hapke(w: vec3f, mu0: f32, mu: f32, g: f32, p: vec4f) -> vec3f {
  let B = p.x / (1.0 + tan(g * 0.5) / p.y);
  let cg = cos(g);
  let P = 1.0 + p.z * cg + p.w * (1.5 * cg * cg - 0.5);
  let gam = sqrt(vec3f(1.0) - w);
  let H0 = (1.0 + 2.0 * mu0) / (vec3f(1.0) + 2.0 * mu0 * gam);
  let H = (1.0 + 2.0 * mu) / (vec3f(1.0) + 2.0 * mu * gam);
  return w / (4.0 * PI) * (mu0 / (mu0 + mu)) * ((1.0 + B) * P + H0 * H - 1.0);
}
fn hapkeW(albedo: vec3f, bodyIndex: i32) -> vec3f {
  let v = (f32(max(bodyIndex, 0)) + 0.5) / f32(MAX_BODIES);
  let u = clamp(albedo, vec3f(0.0), vec3f(1.0)) * (255.0 / 256.0) + 0.5 / 256.0;
  return vec3f(textureSampleLevel(hapkeLut, linearClamp, vec2f(u.r, v), 0.0).r,
               textureSampleLevel(hapkeLut, linearClamp, vec2f(u.g, v), 0.0).r,
               textureSampleLevel(hapkeLut, linearClamp, vec2f(u.b, v), 0.0).r);
}
fn brdfRegolithDirect(s: Surface, l: vec3f) -> vec3f {
  let mu0 = dot(s.n, l);
  if (mu0 <= 0.0) { return vec3f(0.0); }
  let mu = max(dot(s.n, s.v), 1e-3);
  let g = min(acos(clamp(dot(l, s.v), -1.0, 1.0)), 3.1);
  var p = frame.bodies[max(s.bodyIndex, 0)].hapke;
  // Fresh ejecta: a wider, weaker opposition surge than mature soil.
  p.x *= 1.0 - 0.3 * s.param;
  p.y *= 1.0 + s.param;
  return hapke(hapkeW(s.albedo, s.bodyIndex), mu0, mu, g, p);
}
fn brdfRegolithAmbient(s: Surface, a: AmbientInput) -> vec3f {
  // At most one of the two is non-zero: the sky table on a body with an atmosphere, the probe on an airless one.
  return s.albedo * (a.skyIrradiance + a.envIrradiance) * (s.ao / PI);
}
`;

export const BRDF_WATER_WGSL = /* wgsl */ `
// OVERRIDABLE chunk "brdf_water" (MATERIAL_WATER; also what a forward water pass should call). Fixed signatures:
//   fn brdfWaterDirect(s: Surface, l: vec3f) -> vec3f
//   fn brdfWaterAmbient(s: Surface, a: AmbientInput) -> vec3f
// s.param = encodeWaterDepth(depth), s.albedo = imagery colour of the water, s.roughness = resolved roughness.
// Default: GGX with F0 0.02 and the Cox-Munk unresolved slope variance, sky reflection, depth colour.

/// GGX alpha of the unresolved sea-surface slopes: sigma^2 = 0.003 + 0.00512 U10 (Cox-Munk).
fn waterAlpha(s: Surface) -> f32 {
  let wind = frame.bodies[max(s.bodyIndex, 0)].ocean.a;
  let sigma2 = 0.003 + 0.00512 * wind;
  return sqrt(sigma2 + pow(s.roughness, 4.0));
}
/// Diffuse body colour of the water column: imagery colour in the shallows, modelled deep colour below.
fn waterBodyColor(s: Surface) -> vec3f {
  let k = max(frame.bodies[max(s.bodyIndex, 0)].ocean.rgb, vec3f(1e-4));
  let depth = decodeWaterDepth(s.param);
  let backscatter = vec3f(0.0025);
  let chroma = s.albedo / max(luminance(s.albedo), 1e-3);
  let deep = 0.33 * backscatter / (k + backscatter) * mix(vec3f(1.0), chroma, 0.5);
  let t = exp(-k * depth * 2.5);
  return s.albedo * t + deep * (vec3f(1.0) - t);
}
fn brdfWaterDirect(s: Surface, l: vec3f) -> vec3f {
  let NoL = dot(s.n, l);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let h = normalize(s.v + l);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let a = sqrt(sq(waterAlpha(s)) + sq(s.lightAlpha));
  let f = 0.02 + 0.98 * pow5(1.0 - saturate(dot(l, h)));
  let spec = D_GGX(saturate(dot(s.n, h)), a) * V_SmithGGXCorrelated(NoV, NoL, a) * f;
  return (waterBodyColor(s) * ((1.0 - f) / PI) + vec3f(spec)) * NoL;
}
fn brdfWaterAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let NoV = max(dot(s.n, s.v), 1e-4);
  let dfg = envBrdfApprox(sqrt(waterAlpha(s)), NoV);
  let f = 0.02 * dfg.x + dfg.y;
  return waterBodyColor(s) * a.skyIrradiance * ((1.0 - f) / PI) + a.skyReflection * f;
}
`;

export const ECLIPSE_WGSL = /* wgsl */ `
#include "frame"
/// Visible fraction (0..1) of a disc of angular radius rs whose centre is at angular distance d from the
/// centre of an occluding disc of angular radius ro (radians; exact lens area, penumbra and annular cases;
/// a straight-edge form is used when the occluder is much larger than the source, e.g. a horizon).
fn discVisibleFraction(rs: f32, ro: f32, d: f32) -> f32 {
  if (d >= rs + ro) { return 1.0; }
  if (d <= ro - rs) { return 0.0; }
  if (d <= rs - ro) { return 1.0 - (ro * ro) / (rs * rs); }
  if (ro > 40.0 * rs) {
    let x = clamp((d - ro) / rs, -1.0, 1.0);
    return 1.0 - (acos(x) - x * sqrt(max(1.0 - x * x, 0.0))) / PI;
  }
  let a1 = acos(clamp((d * d + rs * rs - ro * ro) / (2.0 * d * rs), -1.0, 1.0));
  let a2 = acos(clamp((d * d + ro * ro - rs * rs) / (2.0 * d * ro), -1.0, 1.0));
  let k = max((-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro), 0.0);
  let lens = rs * rs * a1 + ro * ro * a2 - 0.5 * sqrt(k);
  return clamp(1.0 - lens / (PI * rs * rs), 0.0, 1.0);
}
/// Fraction of the solar disc visible from a camera-relative point, against every non-star frame body
/// (lunar and solar eclipses, a planet's own night side and terminator penumbra).
fn sunVisibility(posRelCam: vec3f, sunDir: vec3f) -> f32 {
  var vis = 1.0;
  for (var i = 0u; i < frame.counts.x; i++) {
    if ((bodyFlags(i) & BODY_FLAG_STAR) != 0u) { continue; }
    let toBody = frame.bodies[i].center.xyz - posRelCam;
    let dist = length(toBody);
    let dir = toBody / max(dist, 1e-3);
    let ro = asin(min(frame.bodies[i].center.w / max(dist, 1e-3), 1.0));
    let sep = atan2(length(cross(dir, sunDir)), dot(dir, sunDir));
    vis *= discVisibleFraction(frame.sunDir.w, ro, sep);
  }
  return vis;
}
`;

export const ATMOSPHERE_COMMON_WGSL = /* wgsl */ `
#include "frame"
const TRANSMITTANCE_LUT_SIZE = vec2f(256.0, 64.0);
const SKY_IRRADIANCE_LUT_SIZE = vec2f(64.0, 16.0);
const AERIAL_SLICES = 32.0;

/// Altitude (m) at distance t along a ray from a point at radius r0 / altitude h0 with mu = dot(rayDir, up).
/// Exact and cancellation-free for t from 1 m to 1e8 m (rendering-design 2.3).
fn altitudeAt(t: f32, r0: f32, h0: f32, mu: f32) -> f32 {
  let r = sqrt(r0 * r0 + 2.0 * r0 * mu * t + t * t);
  return h0 + (2.0 * r0 * mu * t + t * t) / (r + r0);
}

fn lutUnitToTexCoord(x: f32, size: f32) -> f32 { return 0.5 / size + x * (1.0 - 1.0 / size); }
fn lutTexCoordToUnit(u: f32, size: f32) -> f32 { return (u - 0.5 / size) / (1.0 - 1.0 / size); }

/// Bruneton (r, mu) -> UV of 'atmosphere.transmittanceLut' (256 x 64). rb / rt = bottom / top radius.
/// mu must be above the horizon of the bottom sphere (rays that hit the ground are not in the table).
fn transmittanceUvFromRMu(r: f32, mu: f32, rb: f32, rt: f32) -> vec2f {
  let H = sqrt(rt * rt - rb * rb);
  let rho = sqrt(max(r * r - rb * rb, 0.0));
  let d = max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + rt * rt, 0.0)), 0.0);
  let dMin = rt - r;
  let dMax = rho + H;
  let xMu = (d - dMin) / max(dMax - dMin, 1e-3);
  let xR = rho / H;
  return vec2f(lutUnitToTexCoord(clamp(xMu, 0.0, 1.0), TRANSMITTANCE_LUT_SIZE.x), lutUnitToTexCoord(clamp(xR, 0.0, 1.0), TRANSMITTANCE_LUT_SIZE.y));
}
/// Inverse of transmittanceUvFromRMu: returns (r, mu).
fn rMuFromTransmittanceUv(uv: vec2f, rb: f32, rt: f32) -> vec2f {
  let xMu = lutTexCoordToUnit(uv.x, TRANSMITTANCE_LUT_SIZE.x);
  let xR = lutTexCoordToUnit(uv.y, TRANSMITTANCE_LUT_SIZE.y);
  let H = sqrt(rt * rt - rb * rb);
  let rho = H * xR;
  let r = sqrt(rho * rho + rb * rb);
  let dMin = rt - r;
  let dMax = rho + H;
  let d = dMin + xMu * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0); }
  return vec2f(r, mu);
}
/// (r, mu_s) -> UV of 'atmosphere.skyIrradianceLut' (64 x 16): u = (mu_s + 0.2) / 1.2, v = (r - rb) / (rt - rb).
fn skyIrradianceUvFromRMuS(r: f32, muS: f32, rb: f32, rt: f32) -> vec2f {
  return vec2f(lutUnitToTexCoord(clamp((muS + 0.2) / 1.2, 0.0, 1.0), SKY_IRRADIANCE_LUT_SIZE.x),
               lutUnitToTexCoord(clamp((r - rb) / (rt - rb), 0.0, 1.0), SKY_IRRADIANCE_LUT_SIZE.y));
}
fn rMuSFromSkyIrradianceUv(uv: vec2f, rb: f32, rt: f32) -> vec2f {
  return vec2f(rb + lutTexCoordToUnit(uv.y, SKY_IRRADIANCE_LUT_SIZE.y) * (rt - rb),
               lutTexCoordToUnit(uv.x, SKY_IRRADIANCE_LUT_SIZE.x) * 1.2 - 0.2);
}
/// Direction -> UV of 'atmosphere.skyViewLut' (192 x 108) around the camera: u = azimuth from the sun azimuth
/// / 2 pi + 0.5, v = 0.5 + 0.5 sign(l) sqrt(|l| / (pi / 2)) with l the elevation above the local horizontal.
fn skyViewUv(dir: vec3f, up: vec3f, sunDir: vec3f) -> vec2f {
  let l = asin(clamp(dot(dir, up), -1.0, 1.0));
  var e = sunDir - up * dot(sunDir, up);
  if (dot(e, e) < 1e-8) { e = cross(up, vec3f(0.0, 0.0, 1.0)) + cross(up, vec3f(1.0, 0.0, 0.0)) * 1e-3; }
  e = normalize(e);
  let nrm = cross(up, e);
  let az = atan2(dot(dir, nrm), dot(dir, e));
  return vec2f(az / TWO_PI + 0.5, 0.5 - 0.5 * sign(l) * sqrt(abs(l) / (PI * 0.5)));
}
/// Distance (m) of aerial-perspective slice coordinate s in [0, 32]; the texel centre of layer k is s = k + 0.5.
fn aerialSliceToDistance(s: f32) -> f32 { return 50.0 * (exp2(0.5 * s) - 1.0); }
fn aerialDistanceToSlice(d: f32) -> f32 { return clamp(2.0 * log2(max(d, 0.0) / 50.0 + 1.0), 0.0, AERIAL_SLICES); }

/// Transmittance from a point (radius r from the body centre, mu = cos of the angle between the local
/// vertical and the sun) to the sun through body 'bodyIndex's atmosphere. Handles points above the shell
/// (the ray is moved to its entry point). Does NOT include the solid body's shadow: multiply by sunVisibility().
fn atmosphereSunTransmittance(lut: texture_2d_array<f32>, bodyIndex: u32, r: f32, mu: f32) -> vec3f {
  let b = frame.bodies[bodyIndex];
  let rt = b.prevCenter.w;
  let layer = i32(b.fixedX.w);
  if (rt <= 0.0 || layer < 0) { return vec3f(1.0); }
  let rb = b.center.w;
  var rr = max(r, rb);
  var m = mu;
  if (rr > rt) {
    // Outside the shell: only rays that dip into it are attenuated.
    let rp2 = rr * rr * (1.0 - m * m);
    if (m >= 0.0 || rp2 >= rt * rt) { return vec3f(1.0); }
    m = -sqrt(max(1.0 - rp2 / (rt * rt), 0.0));
    rr = rt;
  }
  let muHorizon = -sqrt(max(1.0 - (rb * rb) / (rr * rr), 0.0));
  let uv = transmittanceUvFromRMu(rr, max(m, muHorizon), rb, rt);
  return textureSampleLevel(lut, linearClamp, uv, layer, 0.0).rgb;
}
`;

export const SHADOWS_WGSL = /* wgsl */ `
#include "frame"
// Requires the including module to declare (see sceneBindings 'shadow'):
//   shadowCascades: texture_depth_2d_array   ('shadow.cascades')
//   shadowU: ShadowUniforms (uniform)        ('shadow.uniforms')
const SHADOW_MAX_CASCADES = ${SHADOW_MAX_CASCADES}u;
struct ShadowCascade {
  viewProj: mat4x4f,   // camera-relative ROOT axes -> shadow clip; xy in [-1, 1], z = 0 at the sun side .. 1; valid for THIS frame
  params: vec4f,       // x = world size of one texel along u (m), y = world length of the clip z range (m), z = blend weight 0..1, w = world size of one texel along v (m; smaller than x in a cascade fitted to its receivers)
  lightDir: vec4f,     // xyz = unit direction towards the sun of this cascade (ROOT axes), w = half extent along u (m)
  axisU: vec4f,        // xyz = world direction of +u in the shadow map (unit), w = layer of 'shadow.cascades' holding this cascade
  axisV: vec4f,        // xyz = world direction of +v (texture y, down), w = flags: 1 = re-rendered every frame, 2 = fitted to a whole body
}
struct ShadowUniforms {
  count: vec4u,        // x = cascades in use
  settings: vec4f,     // x = penumbra slope (2 tan(sun angular radius)), y = 1 / map size, z = map size, w = normal offset (texels)
  cascades: array<ShadowCascade, ${SHADOW_MAX_CASCADES}>,
}

/// Smallest PCF kernel radius and largest penumbra radius, in texels; radius of the blocker search.
const SHADOW_MIN_KERNEL = 1.5;
const SHADOW_MAX_KERNEL = 12.0;
const SHADOW_SEARCH = 6.0;
/// Staggered cascades: how far the smallest kernel may grow across the light to become round on the receiver.
const SHADOW_STRETCH_MAX = 4.0;
/// Slope by which a blocker must stand clear of the receiver plane to count for the widened part of the kernel.
const SHADOW_CONE = 0.3;

fn shadowVogel(i: u32, n: u32, phi: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(n));
  let a = f32(i) * 2.39996323 + phi;
  return vec2f(cos(a), sin(a)) * r;
}

/// PCSS-lite lookup in one cascade: 8-tap blocker search, 12-tap rotated Vogel PCF with a penumbra from the
/// true solar angular size, normal-offset and receiver-plane slope bias.
///
/// The kernel is laid out in metres on the map plane, along two axes given by the receiver: 'along' (the
/// direction in which the receiver plane recedes from the light: one metre of map covers 1 / NoL metres of
/// receiver there) and 'across' (constant depth, unstretched). Its smallest size is SHADOW_MIN_KERNEL
/// texels. In a staggered cascade that minimum is widened across the light until the kernel is round ON THE
/// RECEIVER (at most SHADOW_STRETCH_MAX times): at low sun a one-texel step of a shadow edge is 1 / sin(sun
/// elevation) texels long on the ground, and a kernel that is only 1.5 texels wide across the light leaves
/// those steps standing as teeth (14 deg sun) or as a comb at the shadow tip (6 deg). Every-frame cascades
/// keep the round map-space minimum, so the thin shadows of nearby hardware stay crisp.
fn shadowSampleCascade(i: u32, p: vec3f, n: vec3f, noise: vec4f) -> f32 {
  let cas = shadowU.cascades[i];
  let texel = vec2f(cas.params.x, cas.params.w);
  let texelMax = max(texel.x, texel.y);
  let zRange = cas.params.y;
  let layer = i32(cas.axisU.w);
  let staggered = (u32(cas.axisV.w) & 1u) == 0u;
  let l = cas.lightDir.xyz;
  let NoL = dot(n, l);
  if (NoL <= 0.0) { return 1.0; }   // back faces are dark through the BRDF; avoids acne at the terminator
  let sinT = sqrt(saturate(1.0 - NoL * NoL));
  let po = p + n * (texelMax * shadowU.settings.w * sinT) + l * (texelMax * 0.5);
  let c = cas.viewProj * vec4f(po, 1.0);
  let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  let zr = c.z;
  // Map metres -> uv.
  let toUv = shadowU.settings.y / texel;
  // Receiver-plane depth gradient per metre along u and v (world dz = dot(step, n) / NoL), clamped, in clip z.
  let nUV = vec2f(dot(cas.axisU.xyz, n), dot(cas.axisV.xyz, n));
  let g = clamp(nUV / max(NoL, 0.02), vec2f(-40.0), vec2f(40.0)) / zRange;
  var alongDir = vec2f(1.0, 0.0);
  if (dot(nUV, nUV) > 1e-8) { alongDir = normalize(nUV); }
  let acrossDir = vec2f(-alongDir.y, alongDir.x);
  let minAlong = SHADOW_MIN_KERNEL * length(alongDir * texel);
  let minAcross0 = SHADOW_MIN_KERNEL * length(acrossDir * texel);
  var minAcross = minAcross0;
  if (staggered) { minAcross = max(minAcross0, min(minAlong / max(NoL, 1e-3), minAcross0 * SHADOW_STRETCH_MAX)); }
  let phi = noise.x * TWO_PI;
  let search = max(SHADOW_SEARCH * texelMax, minAcross);
  var blockerSum = 0.0;
  var blockers = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let w = shadowVogel(k, 8u, phi) * search;
    let d = textureSampleLevel(shadowCascades, nearestClamp, uv + w * toUv, layer, 0);
    let zref = zr + dot(g, w) - texelMax / zRange;
    if (d < zref) { blockerSum += d; blockers += 1.0; }
  }
  if (blockers == 0.0) { return 1.0; }
  let blockerDist = max(zr - blockerSum / blockers, 0.0) * zRange;
  let penumbra = blockerDist * shadowU.settings.x * 0.5;
  let largest = SHADOW_MAX_KERNEL * texelMax;
  let rAlong = min(max(penumbra, minAlong), largest);
  let rAcross = min(max(penumbra, minAcross), largest);
  var lit = 0.0;
  for (var k = 0u; k < 12u; k++) {
    let dk = shadowVogel(k, 12u, phi + 1.3);
    let w = alongDir * (dk.x * rAlong) + acrossDir * (dk.y * rAcross);
    // Beyond the basic kernel a tap only counts blockers that stand clear of the receiver plane by a slope
    // of SHADOW_CONE, so relief beside the receiver (a crater wall across the light) does not darken it.
    let bias = 0.75 * texelMax + SHADOW_CONE * max(abs(dk.y) * rAcross - max(penumbra, minAcross0), 0.0);
    let zref = zr + dot(g, w) - bias / zRange;
    lit += textureSampleCompareLevel(shadowCascades, shadowCompare, uv + w * toUv, layer, zref);
  }
  return lit / 12.0;
}

/// Sun visibility (0 shadowed .. 1 lit) of a camera-relative point with unit normal n (ROOT axes) from the
/// sun shadow cascades. 'pixel' seeds the blue-noise rotation and the cross-cascade dither.
/// Returns 1 where no cascade covers the point and with the default (empty) resources.
fn sampleSunShadow(posRelCam: vec3f, n: vec3f, pixel: vec2u) -> f32 {
  let noise = blueNoise(pixel);
  let count = min(shadowU.count.x, SHADOW_MAX_CASCADES);
  for (var i = 0u; i < count; i++) {
    let cas = shadowU.cascades[i];
    let c = cas.viewProj * vec4f(posRelCam, 1.0);
    let edge = 1.0 - max(abs(c.x), abs(c.y));
    if (edge <= 0.0 || c.z <= 0.0 || c.z >= 1.0) { continue; }
    let fade = saturate(edge * 10.0) * saturate((1.0 - c.z) * 20.0) * cas.params.z;
    if (fade < 1.0 && noise.b >= fade) { continue; }   // dithered cross-fade into the next cascade
    return shadowSampleCascade(i, posRelCam, n, noise);
  }
  return 1.0;
}
/// Index of the cascade sampleSunShadow would use without dithering (-1 = none); for debug views.
fn shadowCascadeIndex(posRelCam: vec3f) -> i32 {
  let count = min(shadowU.count.x, SHADOW_MAX_CASCADES);
  for (var i = 0u; i < count; i++) {
    let c = shadowU.cascades[i].viewProj * vec4f(posRelCam, 1.0);
    if (max(abs(c.x), abs(c.y)) < 1.0 && c.z > 0.0 && c.z < 1.0) { return i32(i); }
  }
  return -1;
}
`;

export const CLOUD_SHADOW_WGSL = /* wgsl */ `
#include "frame"
// Requires the including module to declare (see sceneBindings 'cloudShadow'):
//   cloudShadowMapTex: texture_2d<f32>     ('clouds.shadowMap')
//   cloudCoverageMapTex: texture_2d<f32>   ('clouds.coverageMap')

/// What the clouds leave of the sun's illuminance at a camera-relative point 'pos' of body 'bodyIndex' ('up'
/// = local vertical there, 'r' = its distance from the body centre): x = the share that arrives in the
/// direct beam, y = the share that arrives at all (the beam plus what the cloud passes on diffusely). y - x
/// is light from the cloud base: white and not directional. The near map around the camera, the coverage
/// map beyond it. The near map is depth-resolved: a receiver above the cloud is not shadowed by it, one
/// inside it by the part above it only. Exactly (1, 1) with the default resources and parameters.
/// 'clouds.shadowMap': r = optical depth of the whole layer as the ground sees it (beam + diffuse), g =
/// where the cloud begins on the sun side, b = mean extinction behind that point, a = optical depth of the
/// direct beam alone divided by r (1 and more; a texel below 1, the default's 0 included, counts as 1: a
/// map that does not tell beam from diffuse casts its whole shadow in the beam).
fn cloudLight(pos: vec3f, bodyIndex: i32, up: vec3f, r: f32, sunDir: vec3f) -> vec2f {
  let muS = max(dot(up, sunDir), 0.05);
  var far = vec2f(1.0);
  if (i32(frame.cloudFar.x) == bodyIndex && r < frame.cloudFar.y) {
    // Point where the sun ray crosses the layer mid-height.
    let b = frame.bodies[bodyIndex];
    let rel = pos - b.center.xyz;
    let bq = dot(rel, sunDir);
    let t = -bq + sqrt(max(bq * bq - (r * r - frame.cloudFar.y * frame.cloudFar.y), 0.0));
    let d = normalize(rootToFixed(u32(bodyIndex), rel + sunDir * t));
    let lon = atan2(d.y, d.x) + frame.cloudFar.w;
    let uv = vec2f(fract(lon / TWO_PI + 0.5), acos(clamp(d.z, -1.0, 1.0)) / PI);
    // Coverage c stands for the optical depth c x cloudFar.z as the ground sees it; the beam meets
    // (1 + 7 c) times that (thin cloud passes most of its light in the beam, a deck almost none).
    let c = textureSampleLevel(cloudCoverageMapTex, linearClamp, uv, 0.0).r;
    let tau = c * frame.cloudFar.z / muS;
    far = vec2f(exp(-tau * (1.0 + 7.0 * c)), exp(-tau));
  }
  let he = frame.cloudNear0.w;
  if (he > 0.0 && i32(frame.cloudNear1.w) == bodyIndex) {
    let rel = pos - frame.cloudNear0.xyz;
    let q = vec2f(dot(rel, frame.cloudNear1.xyz), dot(rel, frame.cloudNear2.xyz)) / he;
    let edge = 1.0 - max(abs(q.x), abs(q.y));
    if (edge > 0.0) {
      // The map's projection direction (unit, towards the sun) and the receiver's place along it.
      let s = dot(rel, cross(frame.cloudNear1.xyz, frame.cloudNear2.xyz));
      // r = optical depth of the whole layer on this line, g = where the cloud begins on the sun side
      // (distance along the projection direction from the map plane), b = mean extinction behind that point.
      let m = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0);
      let tau = clamp((m.g - s) * m.b, 0.0, m.r) * frame.cloudNear2.w / muS;
      return mix(far, vec2f(exp(-tau * max(m.a, 1.0)), exp(-tau)), saturate(edge * 8.0));
    }
  }
  return far;
}

/// Share of the sun's illuminance that reaches the point at all, beam and diffuse together (cloudLight().y):
/// for a shader that lights with one factor on the sun. One that separates the two uses cloudLight.
fn cloudShadow(pos: vec3f, bodyIndex: i32, up: vec3f, r: f32, sunDir: vec3f) -> f32 {
  return cloudLight(pos, bodyIndex, up, r, sunDir).y;
}
`;

export const TRANSPARENCY_WGSL = /* wgsl */ `
#include "frame"
#include "atmosphere_common"
// Requires the including module to declare (see sceneBindings 'transparency'):
//   aerialPerspectiveTex: texture_3d<f32>   ('atmosphere.aerialPerspective')
//   cloudsScreenTex: texture_2d<f32>        ('clouds.screen')
//   cloudsDepthTex: texture_2d<f32>         ('clouds.depth')

/// Mandatory for everything drawn in drawTransparent. 'uv' = screen UV of the fragment, 'distance' = metres
/// from the eye, 'colour' = pre-exposed PREMULTIPLIED radiance, 'alpha' = opacity. Adds the in-scatter in
/// front of the fragment, applies the transmittance up to it, and attenuates the fragment by the
/// transmittance of the cloud in front of the pixel in proportion to how far into the cloud's span it lies
/// ('clouds.depth': r = begin, g = end): untouched in front of the cloud, fully attenuated behind it.
/// Exactly neutral with the default resources.
fn applyAtmosphere(uv: vec2f, distance: f32, colour: vec3f, alpha: f32) -> vec4f {
  let slice = aerialDistanceToSlice(distance);
  let ap = textureSampleLevel(aerialPerspectiveTex, linearClamp, vec3f(uv, slice / AERIAL_SLICES), 0.0);
  let nearFade = saturate(slice * 2.0);
  let trans = 1.0 + (ap.a - 1.0) * nearFade;
  let c = colour * trans + ap.rgb * (nearFade * frame.exposure.x * alpha);
  let span = textureSampleLevel(cloudsDepthTex, linearClamp, uv, 0.0).rg;
  let cloudTrans = textureSampleLevel(cloudsScreenTex, linearClamp, uv, 0.0).a;
  // (A span of no depth, or a publisher that wrote the begin alone, is a step at the begin.)
  let behind = smoothstep(span.r, max(span.g, span.r * 1.0001), distance);
  let k = 1.0 + (cloudTrans - 1.0) * behind;
  return vec4f(c * k, alpha * k);
}
`;

export const UPSAMPLE_WGSL = /* wgsl */ `
#include "frame"
/// Depth-aware 4-tap upsample of a half-resolution target ('src', same size as 'scene.depthHalf') to a
/// full-resolution pixel with reversed-Z depth 'fullDepth' at 'uv'. Bilinear weights are multiplied by the
/// similarity of view distance; 'useNearest' selects which half-res depth the source was computed against
/// (false: depthHalf.r, the farthest sample of each 2 x 2 block - what a volume marched to; true: .g, the
/// nearest). Falls back to the closest-depth tap at silhouettes.
fn upsampleDepthAware(src: texture_2d<f32>, depthHalf: texture_2d<f32>, uv: vec2f, fullDepth: f32, useNearest: bool) -> vec4f {
  let size = vec2i(textureDimensions(src));
  let st = uv * vec2f(size) - 0.5;
  let base = floor(st);
  let f = st - base;
  let zFull = viewZFromDepth(fullDepth);
  var sum = vec4f(0.0);
  var wsum = 0.0;
  var best = vec4f(0.0);
  var bestDiff = 3.0e38;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let ip = clamp(vec2i(base) + o, vec2i(0), size - 1);
    let dh = textureLoad(depthHalf, ip, 0).rg;
    let z = viewZFromDepth(select(dh.r, dh.g, useNearest));
    let diff = min(abs(z - zFull) / max(min(z, zFull), 1e-3), 1000.0);
    let bil = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    let w = (bil + 0.01) / (1.0 + diff * 200.0) * step(diff, 0.25);
    let v = textureLoad(src, ip, 0);
    sum += v * w;
    wsum += w;
    if (diff < bestDiff) { bestDiff = diff; best = v; }
  }
  if (wsum < 1e-4) { return best; }
  return sum / wsum;
}
`;
