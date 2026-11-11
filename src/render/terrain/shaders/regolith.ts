/**
 * The `brdf_regolith` chunk of the terrain package (an override of the render core's default, RENDER_API
 * "Overridable BRDF chunks"): the same Hapke function, with a terminator that knows about the slopes a
 * pixel does not resolve.
 *
 * The default switches a pixel off when its normal turns away from the sun. Under a low sun a normal map
 * whose slopes are near the sun's elevation then flips between lit and black from pixel to pixel: noise,
 * where a photograph shows the mean of many small lit and shadowed facets. The terrain and rock shaders of
 * this package write, for MATERIAL_REGOLITH, the RMS slope of what neighbouring pixels disagree about into
 * the G-buffer's metallic channel (x 2; regolith has no metal, and any other writer leaves 0 there, which
 * gives the default behaviour exactly). With facet slopes normally distributed about the pixel's normal,
 * the fraction of facets facing the sun is Phi(mu0 / sigma) and their mean cosine of incidence is
 * mu0 + sigma phi / Phi; the pixel is that fraction of a Hapke surface lit at that cosine.
 */
export const REGOLITH_BRDF_WGSL = /* wgsl */ `
// "brdf_regolith" (MATERIAL_REGOLITH), terrain package. s.param = crater freshness 0..1,
// s.metallic = 2 x RMS slope of the facets within the pixel (0 = a plane).

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
  var lit = 1.0;
  let sigma = 0.5 * s.metallic;
  if (sigma > 0.004) {
    let f = regolithFacets(mu0, sigma);
    lit = f.x;
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
  return s.albedo * (a.skyIrradiance + a.envIrradiance) * (s.ao / PI);
}
`;
