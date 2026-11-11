/**
 * The `brdf_terrain` and `brdf_regolith` chunks of the terrain package (overrides of the render core's
 * defaults, RENDER_API "Overridable BRDF chunks").
 *
 * Both read one thing the defaults do not: G-buffer RT4.b (`s.clearcoat`, which the lighting pass hands
 * through for every material) as the share of the sun that relief below the mesh keeps off the pixel. The
 * terrain and ground-cover shaders of this package write it (the height maps of the detail layers marched
 * towards the sun; the shade inside a tussock); every other writer of these materials leaves 0 there and
 * gets the default behaviour exactly.
 *
 * Regolith, in addition:
 *  - The default switches a pixel off when its normal turns away from the sun. Under a low sun a normal map
 *    whose slopes are near the sun's elevation then flips between lit and black from pixel to pixel: noise,
 *    where a photograph shows the mean of many small lit and shadowed facets. The terrain and rock shaders
 *    write, for MATERIAL_REGOLITH, the RMS slope of what neighbouring pixels disagree about into the
 *    G-buffer's metallic channel (x 2; regolith has no metal, and any other writer leaves 0 there). With
 *    facet slopes normally distributed about the pixel's normal, the fraction of facets facing the sun is
 *    Phi(mu0 / sigma) and their mean cosine of incidence is mu0 + sigma phi / Phi; the pixel is that fraction
 *    of a Hapke surface lit at that cosine.
 *  - Light bounced off the sunlit ground. An airless body has no sky, and the environment probe holds space:
 *    without this a shadow is zero signal, which no photograph of the lunar surface shows (the shaded side of
 *    a block is about a fifth of the sunlit soil around it, the ground under an overhang a third). A surface
 *    receives the sun's illuminance on level ground (E mu_sun) times a share that grows with how much of the
 *    lit ground it faces: `bounceFlat` for level ground inside a shadow (lit clods and slopes around it),
 *    rising linearly with (1 - n . up) / 2 to `bounceDown` for a face that looks straight down.
 */
export interface RegolithLightParams {
  bounceFlat: number;
  bounceDown: number;
}

export const DEFAULT_REGOLITH_LIGHT: RegolithLightParams = { bounceFlat: 0.1, bounceDown: 0.45 };

export const TERRAIN_BRDF_WGSL = /* wgsl */ `
// "brdf_terrain" (MATERIAL_TERRAIN), terrain package. s.param = wetness 0..1, s.clearcoat = share of the sun
// that relief below the mesh keeps off the pixel.
fn terrainWet(s: Surface) -> vec4f {
  // Wet rock and sand: darker, and shinier in the mean of what is a film here and dry grain there.
  let w = s.param;
  return vec4f(s.albedo * mix(1.0, 0.55, w), mix(s.roughness, min(s.roughness, 0.45), w));
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
  return (m.rgb / PI + vec3f(spec)) * (NoL * (1.0 - s.clearcoat));
}
fn brdfTerrainAmbient(s: Surface, a: AmbientInput) -> vec3f {
  let m = terrainWet(s);
  let NoV = max(dot(s.n, s.v), 1e-4);
  let dfg = envBrdfApprox(max(m.w, 0.25), NoV);
  return (m.rgb * a.skyIrradiance / PI + a.skyReflection * (0.03 * dfg.x + dfg.y)) * s.ao;
}
`;

export const regolithBrdfWgsl = (p: RegolithLightParams = DEFAULT_REGOLITH_LIGHT): string => /* wgsl */ `
// "brdf_regolith" (MATERIAL_REGOLITH), terrain package. s.param = crater freshness 0..1,
// s.metallic = 2 x RMS slope of the facets within the pixel (0 = a plane), s.clearcoat = share of the sun
// that relief below the mesh keeps off the pixel.
const REGOLITH_BOUNCE_FLAT = ${p.bounceFlat.toFixed(4)};
const REGOLITH_BOUNCE_DOWN = ${p.bounceDown.toFixed(4)};

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
/// Facets of a pixel whose slopes are normal with RMS sigma about a normal at cosine mu0 to the sun:
/// x = the fraction that faces the sun, y = their mean cosine of incidence.
fn regolithFacets(mu0: f32, sigma: f32) -> vec2f {
  let x = mu0 / sigma;
  // Normal CDF through erf (Abramowitz and Stegun 7.1.26, error below 2e-7).
  let z = abs(x) * 0.70710678;
  let t = 1.0 / (1.0 + 0.3275911 * z);
  let poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  let tail = 0.5 * poly * exp(-z * z);
  let lit = select(tail, 1.0 - tail, x >= 0.0);
  let density = 0.39894228 * exp(-0.5 * x * x);
  return vec2f(lit, mu0 + sigma * density / max(lit, 1e-6));
}
fn brdfRegolithDirect(s: Surface, l: vec3f) -> vec3f {
  var mu0 = dot(s.n, l);
  var lit = 1.0 - s.clearcoat;
  let sigma = 0.5 * s.metallic;
  if (sigma > 0.004) {
    let f = regolithFacets(mu0, sigma);
    lit *= f.x;
    mu0 = f.y;
  }
  if (mu0 <= 0.0 || lit < 1e-3) { return vec3f(0.0); }
  let mu = max(dot(s.n, s.v), 1e-3);
  let g = min(acos(clamp(dot(l, s.v), -1.0, 1.0)), 3.1);
  var p = frame.bodies[max(s.bodyIndex, 0)].hapke;
  // Fresh ejecta: a wider, weaker opposition surge than mature soil.
  p.x *= 1.0 - 0.3 * s.param;
  p.y *= 1.0 + s.param;
  return lit * hapke(hapkeW(s.albedo, s.bodyIndex), mu0, mu, g, p);
}
fn brdfRegolithAmbient(s: Surface, a: AmbientInput) -> vec3f {
  // At most one of the two is non-zero: the sky table on a body with an atmosphere, the probe on an airless one.
  var e = a.skyIrradiance + a.envIrradiance;
  if (s.bodyIndex >= 0) {
    // Light off the sunlit ground around the pixel (see the header of shaders/lighting.ts).
    let muS = saturate(dot(s.up, frame.bodies[s.bodyIndex].sunDir.xyz));
    let down = 0.5 * (1.0 - dot(s.n, s.up));
    e += frame.sunIlluminance.rgb * (muS * mix(REGOLITH_BOUNCE_FLAT, REGOLITH_BOUNCE_DOWN, down));
  }
  return s.albedo * e * (s.ao / PI);
}
`;
