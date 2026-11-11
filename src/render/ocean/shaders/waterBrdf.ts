/**
 * The shared water shading function: registered as the overridable chunk "brdf_water", so the deferred
 * lighting of the far sea-level sheet and the ocean's forward near-field pass evaluate the SAME code with the
 * same inputs. Fixed signatures (docs/RENDER_API.md section 5): brdfWaterDirect(s, l), brdfWaterAmbient(s, a),
 * plus waterAlpha(s) and waterBodyColor(s).
 *
 * Model
 *  - Specular: GGX, F0 = 0.02. The slope variance not carried by the shading normal is unresolved and goes into
 *    the lobe: sigma^2_unresolved = (1 - s.roughness) x (0.003 + 0.00512 U10) (Cox-Munk mean square slope),
 *    alpha = GGX_KAPPA x sigma, which gives the GGX lobe the half-maximum width of the Gaussian Cox-Munk slope
 *    distribution. The far sheet (s.roughness = 0, flat normal) gets the whole Cox-Munk lobe: the broad glint
 *    seen from orbit. The near field resolves most slopes in its normal and keeps only the remainder: the
 *    glitter path at the surface. One formula.
 *  - Sky reflection: the environment probe (when one is published, 'env.sh9' non-zero) or the camera's sky-view
 *    table, blurred over the lobe, near the camera; the local sky irradiance / pi far away (the core's rule for
 *    camera-centred tables, 50 km). Rays reflected below the horizon are folded back above it.
 *  - Body colour: the shallow-water remote-sensing reflectance of Lee et al. (1998/1999) with per-channel
 *    absorption a (BodyDef.render.ocean.absorption) and backscatter bb (params), single scattering of the
 *    water column (rrs_deep = (0.084 + 0.17 u) u, u = bb / (a + bb)) attenuated along the refracted sun and
 *    view paths, and the bottom seen through the column: rrs = rrs_deep (1 - e^-(1/muW + Du/muV) K H) +
 *    (rho_b / pi) e^-(1/muW + Db/muV) K H, Rrs = 0.5 rrs / (1 - 1.5 rrs). H = decodeWaterDepth(s.param); the
 *    bottom albedo rho_b is the imagery colour (s.albedo: turquoise over shelves), whose chroma also tints the
 *    deep term (regional colour: plankton, sediment). Fresnel transmission at grazing sun and view angles.
 *  - Foam: statistical whitecap coverage (Monahan & O'Muircheartaigh 1980, 3.84e-6 U^3.41, aged-foam
 *    reflectance factor 0.4) everywhere; the forward pass hands its resolved foam in (below).
 *
 * Surface fields for MATERIAL_WATER (what the far sheet writes leaves the extras 0):
 *   n         shading normal (the sheet's normal, or the resolved wave normal)
 *   roughness FRACTION of the Cox-Munk slope variance already carried by n (0 = none, the far sheet)
 *   albedo    imagery colour of the water;  param = encodeWaterDepth(depth below the sea surface)
 *   metallic  resolved foam coverage, clearcoatRoughness its weight against the statistical whitecaps (0 far)
 */
import type { OceanTunables } from '../params';
import { GGX_KAPPA } from '../params';
import { MAX_BODIES } from '@/render/core';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Statistical whitecap coverage x aged-foam factor, the same in WGSL. */
export const whitecapCoverage = (windSpeed: number): number => Math.min(0.2, 3.84e-6 * windSpeed ** 3.41) * 0.4;

/**
 * WGSL of the chunk with the per-body constants of the frame body list `bodies` (index = frame body index;
 * null = no ocean).
 */
export function buildWaterBrdfWgsl(bodies: readonly (OceanTunables | null)[], options: { directSpecular?: boolean } = {}): string {
  const rows: string[] = [];
  for (let i = 0; i < MAX_BODIES; i++) {
    const t = bodies[i] ?? null;
    if (t) rows.push(`vec4f(${f(t.backscatter[0])}, ${f(t.backscatter[1])}, ${f(t.backscatter[2])}, ${f(t.imageryTint)})`, `vec4f(${f(t.foamAlbedo)}, ${f(t.windDir)}, ${f(t.windVariability)}, ${f(t.slickStrength)})`);
    else rows.push('vec4f(0.002, 0.003, 0.0045, 0.0)', 'vec4f(0.7, 0.0, 0.0, 0.0)');
  }
  return /* wgsl */ `
// OVERRIDABLE chunk "brdf_water", provided by the ocean package (src/render/ocean/shaders/waterBrdf.ts).
// Needs in scope: chunks frame, gbuffer, brdf; skyViewLut, skyIrradianceLut (set 'atmosphereLuts'),
// envProbeCube, envSh9 (set 'env'). See the module comment for the meaning of the Surface fields.
#include "noise"
const WATER_IOR = 1.34;
const WATER_GGX_KAPPA = ${GGX_KAPPA};
// 1 = normal; 0 isolates the direct specular for tests (debug hook of the ocean feature).
const WATER_DIRECT_SPECULAR = ${options.directSpecular === false ? '0.0' : '1.0'};
// Per frame body: (backscatter rgb per m, imagery tint), (foam albedo, wind direction (rad, compass, toward),
// relative wind-speed variability, slick strength).
const WATER_BODY = array<vec4f, ${MAX_BODIES * 2}>(${rows.join(', ')});

fn waterBodyParam(s: Surface, k: u32) -> vec4f { return WATER_BODY[u32(max(s.bodyIndex, 0)) * 2u + k]; }
fn waterWind(s: Surface) -> f32 { return frame.bodies[max(s.bodyIndex, 0)].ocean.a; }
fn waterCoxMunk(s: Surface) -> f32 { return 0.003 + 0.00512 * waterWind(s); }

/// GGX alpha of the slopes the shading normal does not carry (without the light's own angular size).
/// Planet-fixed variability of the unresolved slope variance (mean about 1): mesoscale wind-speed changes
/// (tens of km) and surfactant slicks (calm bands along the wind, a few km wide, in patches), which give
/// the glint seen from altitude its structure. A function of the body-fixed position only, so the deferred and
/// the forward path agree, and the pattern is fixed to the sea.
fn waterRoughnessField(s: Surface) -> f32 {
  if (s.bodyIndex < 0) { return 1.0; }
  let bi = u32(s.bodyIndex);
  let b = frame.bodies[bi];
  let p = rootToFixed(bi, s.pos - b.center.xyz);
  let q = waterBodyParam(s, 1u);
  let up = normalize(p);
  var east = cross(vec3f(0.0, 0.0, 1.0), up);
  if (dot(east, east) < 1e-10) { east = vec3f(1.0, 0.0, 0.0); }
  east = normalize(east);
  let north = cross(up, east);
  let along = east * sin(q.y) + north * cos(q.y);
  let across = cross(up, along);
  // Wind: two octaves of smooth noise, 25-90 km.
  let wind = gradientNoise3(p / 90000.0, 11) * 0.7 + gradientNoise3(p / 25000.0, 12) * 0.3;
  // Slicks: broad calm bands stretched along the wind (about 30 km x 2.5 km), present in patches.
  let sp = along * (dot(p, along) / 30000.0) + across * (dot(p, across) / 2500.0) + up * (dot(p, up) / 30000.0);
  let streak = gradientNoise3(sp, 13) * 0.75 + gradientNoise3(sp * 2.1, 14) * 0.25;
  let slick = smoothstep(0.15, 0.6, streak) * smoothstep(0.0, 0.5, gradientNoise3(p / 60000.0, 15));
  return exp(q.z * wind) * (1.0 - q.w * slick);
}

fn waterAlpha(s: Surface) -> f32 {
  let unresolved = waterCoxMunk(s) * waterRoughnessField(s) * clamp(1.0 - s.roughness, 0.0, 1.0);
  return sqrt(WATER_GGX_KAPPA * WATER_GGX_KAPPA * unresolved + 1e-6);
}

fn waterFoamCoverage(s: Surface) -> f32 {
  let stat = min(0.2, 3.84e-6 * pow(waterWind(s), 3.41)) * 0.4;
  return clamp(mix(stat, s.metallic, s.clearcoatRoughness), 0.0, 1.0);
}

struct WaterOptics {
  kappa: vec3f,     // attenuation a + bb, 1/m
  u: vec3f,         // bb / (a + bb)
  rrsDeep: vec3f,   // subsurface remote-sensing reflectance of optically deep water, 1/sr (tinted)
  depth: f32,       // m
}
fn waterOptics(s: Surface) -> WaterOptics {
  var o: WaterOptics;
  let a = max(frame.bodies[max(s.bodyIndex, 0)].ocean.rgb, vec3f(1e-4));
  let p = waterBodyParam(s, 0u);
  let bb = p.xyz;
  o.kappa = a + bb;
  o.u = bb / o.kappa;
  var deep = (0.084 + 0.17 * o.u) * o.u;
  let li = luminance(s.albedo);
  if (li > 1e-4) {
    let tint = clamp((s.albedo / li) / (deep / max(luminance(deep), 1e-7)), vec3f(0.25), vec3f(4.0));
    deep *= mix(vec3f(1.0), tint, p.w);
  }
  o.rrsDeep = deep;
  o.depth = decodeWaterDepth(s.param);
  return o;
}
/// Cosine of the refracted (in-water) zenith angle for an above-water cosine mu.
fn waterRefractedCos(mu: f32) -> f32 { return sqrt(max(1.0 - (1.0 - mu * mu) / (WATER_IOR * WATER_IOR), 0.0)); }
fn waterFresnel(mu: f32) -> f32 { return 0.02 + 0.98 * pow5(1.0 - saturate(mu)); }

struct WaterRrs { total: vec3f, bottom: vec3f, bottomAttenuation: vec3f }
/// Above-surface remote-sensing reflectance (1/sr) for in-water sun / view cosines, split into the total and the
/// part due to the bottom; bottomAttenuation = the factor the column applies to light reflected by the bottom.
fn waterRrsOf(o: WaterOptics, bottomAlbedo: vec3f, muW: f32, muV: f32) -> WaterRrs {
  let du = 1.03 * sqrt(1.0 + 2.4 * o.u);
  let db = 1.04 * sqrt(1.0 + 5.4 * o.u);
  let mw = max(muW, 0.05);
  let mv = max(muV, 0.05);
  let tc = exp(-(1.0 / mw + du / mv) * o.kappa * o.depth);
  let tb = exp(-(1.0 / mw + db / mv) * o.kappa * o.depth);
  let column = o.rrsDeep * (1.0 - tc);
  let rrs = column + bottomAlbedo * (tb / PI);
  var r: WaterRrs;
  r.total = 0.5 * rrs / (1.0 - 1.5 * rrs);
  r.bottom = r.total - 0.5 * column / (1.0 - 1.5 * column);
  r.bottomAttenuation = tb * 0.5 / (1.0 - 1.5 * rrs);
  return r;
}

/// Diffuse-equivalent reflectance of the water body (pi Rrs) for overhead sun and view.
fn waterBodyColor(s: Surface) -> vec3f { return PI * waterRrsOf(waterOptics(s), s.albedo, 1.0, 1.0).total; }

/// Water-leaving body term per unit illuminance of a light along l (the bottom part separately): BRDF x NoL.
struct WaterBody { total: vec3f, bottom: vec3f, bottomAttenuation: vec3f }
fn waterBodyDirect(s: Surface, l: vec3f) -> WaterBody {
  var w: WaterBody;
  w.total = vec3f(0.0);
  w.bottom = vec3f(0.0);
  w.bottomAttenuation = vec3f(0.0);
  let NoL = dot(s.n, l);
  if (NoL <= 0.0) { return w; }
  let NoV = max(dot(s.n, s.v), 1e-4);
  let t = (1.0 - waterFresnel(NoL)) * (1.0 - waterFresnel(NoV)) / 0.9604;
  let r = waterRrsOf(waterOptics(s), s.albedo, waterRefractedCos(NoL), waterRefractedCos(NoV));
  w.total = r.total * (NoL * t);
  w.bottom = r.bottom * (NoL * t);
  w.bottomAttenuation = r.bottomAttenuation * t;
  return w;
}
fn waterBodyAmbient(s: Surface, a: AmbientInput) -> WaterBody {
  var w: WaterBody;
  let NoV = max(dot(s.n, s.v), 1e-4);
  // Diffuse sky light enters at a mean in-water cosine of about 0.86 (refraction squeezes it into the Snell cone).
  let t = (1.0 - 0.066) * (1.0 - waterFresnel(NoV)) / 0.9604;
  let r = waterRrsOf(waterOptics(s), s.albedo, 0.86, waterRefractedCos(NoV));
  w.total = r.total * a.skyIrradiance * t;
  w.bottom = r.bottom * a.skyIrradiance * t;
  w.bottomAttenuation = r.bottomAttenuation * t;
  return w;
}

/// Sky radiance (cd/m^2) along 'dir' seen by a water surface, blurred over a GGX lobe of alpha 'alpha'.
fn waterSkyRadiance(s: Surface, dir: vec3f, alpha: f32) -> vec3f {
  if (s.bodyIndex < 0) { return vec3f(0.0); }
  let b = frame.bodies[s.bodyIndex];
  let sunDir = b.sunDir.xyz;
  var d = dir;
  var fold = 1.0;
  let du = dot(d, s.up);
  if (du < 0.0) {
    // Reflected below the horizon: the ray meets the sea again and, mostly by reflection, sees the sky near the horizon.
    d = normalize(d - 2.0 * du * s.up);
    fold = 0.85;
  }
  var far = vec3f(0.0);
  let layer = i32(b.fixedX.w);
  let rb = b.center.w;
  let r = rb + s.altitude;
  if (layer >= 0 && r < b.prevCenter.w) {
    let uv = skyIrradianceUvFromRMuS(max(r, rb), dot(s.up, sunDir), rb, b.prevCenter.w);
    far = textureSampleLevel(skyIrradianceLut, linearClamp, uv, layer, 0.0).rgb / PI;
  }
  let near = saturate(1.0 - s.viewDist / 50000.0);
  var nearL = vec3f(0.0);
  if (near > 0.0) {
    let c0 = envSh9.c[0].rgb;
    if (c0.r + c0.g + c0.b > 0.0) {
      let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
      nearL = textureSampleLevel(envProbeCube, linearClamp, d, sqrt(clamp(alpha, 0.0, 1.0)) * mips).rgb;
    } else {
      let camUp = b.cameraUp.xyz;
      let tf = tangentFrame(d);
      let spread = min(alpha * 0.75, 0.6);
      nearL = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(d, camUp, sunDir), 0.0).rgb * 0.4;
      for (var k = 0u; k < 4u; k++) {
        let ang = f32(k) * 1.5707963 + 0.785398;
        var dk = normalize(d + (tf[0] * cos(ang) + tf[1] * sin(ang)) * spread);
        let dku = dot(dk, s.up);
        if (dku < 0.0) { dk = normalize(dk - 2.0 * dku * s.up); }
        nearL += textureSampleLevel(skyViewLut, linearClamp, skyViewUv(dk, camUp, sunDir), 0.0).rgb * 0.15;
      }
    }
  }
  return mix(far, nearL, near) * fold;
}

fn brdfWaterDirect(s: Surface, l: vec3f) -> vec3f {
  let NoL = dot(s.n, l);
  var spec = 0.0;
  if (NoL > 0.0) {
    let h = normalize(s.v + l);
    let NoV = max(dot(s.n, s.v), 1e-4);
    let a = sqrt(sq(waterAlpha(s)) + sq(s.lightAlpha));
    let fr = 0.02 + 0.98 * pow5(1.0 - saturate(dot(l, h)));
    spec = D_GGX(saturate(dot(s.n, h)), a) * V_SmithGGXCorrelated(NoV, NoL, a) * fr * NoL * WATER_DIRECT_SPECULAR;
  }
  let body = waterBodyDirect(s, l).total;
  let c = waterFoamCoverage(s);
  let foam = waterBodyParam(s, 1u).x / PI * max(dot(s.up, l), 0.0);
  return (vec3f(spec) + body) * (1.0 - c) + vec3f(foam * c);
}

fn brdfWaterAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let NoV = max(dot(s.n, s.v), 1e-4);
  let alpha = waterAlpha(s);
  let rough = sqrt(alpha);
  let dfg = envBrdfApprox(rough, NoV);
  let refl = reflect(-s.v, s.n);
  let spec = waterSkyRadiance(s, refl, alpha) * (0.02 * dfg.x + dfg.y);
  let body = waterBodyAmbient(s, a).total;
  let c = waterFoamCoverage(s);
  let foam = a.skyIrradiance * (waterBodyParam(s, 1u).x / PI);
  return (spec + body) * (1.0 - c) + foam * c;
}
`;
}
