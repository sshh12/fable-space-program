/**
 * WGSL chunk "atmosphere_model": the participating medium of a body (Rayleigh + Mie + ozone from the
 * BodyUniform), phase functions, the analytic segment integral, cancellation-free ray / shell geometry
 * for camera rays, the sun term (transmittance table x eclipses), the multi-scattering table lookup and
 * the importance distribution of march samples. Used by every pass of the feature.
 *
 * Precision (ARCHITECTURE section 4). A camera ray is described per body by an AtmoRay: the point where
 * it enters the shell (or the eye when the eye is inside) with radius, altitude and vertical cosine there.
 * Altitudes along the ray come from the stable altitude formula started at that point, so that a camera at
 * lunar distance resolves the shell as well as one standing in it; the direction cosine is taken from the
 * cross product where the dot product loses its digits (rays within 45 degrees of the vertical).
 */
import { MULTISCATTER_LUT_SIZE } from '../math';

export const ATMOSPHERE_MODEL_WGSL = /* wgsl */ `
#include "frame"
#include "atmosphere_common"
#include "eclipse"

const ATMO_MS_SIZE = vec2f(${MULTISCATTER_LUT_SIZE[0].toFixed(1)}, ${MULTISCATTER_LUT_SIZE[1].toFixed(1)});
const ATMO_KNOTS = 8;

struct AtmoMedium {
  scatR: vec3f,   // Rayleigh scattering, 1 / m
  scatM: f32,     // Mie scattering, 1 / m
  ext: vec3f,     // total extinction, 1 / m
}

/// Scattering and extinction of body 'bi' at altitude h (m above the reference radius).
fn atmoMedium(bi: u32, h: f32) -> AtmoMedium {
  let hc = max(h, -1000.0);
  let dR = exp(-hc / frame.bodies[bi].rayleigh.a);
  let dM = exp(-hc / frame.bodies[bi].mie.z);
  let dO = max(0.0, 1.0 - abs(hc - frame.bodies[bi].ozone.a) / max(frame.bodies[bi].misc.x, 1.0));
  var m: AtmoMedium;
  m.scatR = frame.bodies[bi].rayleigh.rgb * dR;
  m.scatM = frame.bodies[bi].mie.x * dM;
  m.ext = m.scatR + vec3f((frame.bodies[bi].mie.x + frame.bodies[bi].mie.y) * dM) + frame.bodies[bi].ozone.rgb * dO;
  return m;
}

/// Rayleigh and Cornette-Shanks phase functions, 1 / sr.
fn atmoPhaseR(c: f32) -> f32 { return 0.0596831037 * (1.0 + c * c); }
fn atmoPhaseM(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 0.1193662073 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

/// Integral of exp(-ext s) over s in [0, dt], per channel: Hillaire's analytic segment integral. The series
/// keeps it exact where ext dt is far below float32 resolution (the upper atmosphere).
fn atmoSegment(ext: vec3f, dt: f32) -> vec3f {
  let x = ext * dt;
  let series = dt * (vec3f(1.0) - 0.5 * x + x * x * (1.0 / 6.0));
  let closed = (vec3f(1.0) - exp(-x)) / max(ext, vec3f(1e-30));
  return select(closed, series, x < vec3f(0.01));
}

/// Signed distances (near, far) along a unit ray to the sphere of radius rs around a body centre. The ray
/// starts at radius r0 = rs + dh (dh from float64) with mu = cos(angle between the ray and the local
/// vertical). Returns near > far when the line misses the sphere. No cancellation at the surface: the gap
/// between the sphere and the ray's perigee is formed from dh.
fn atmoRaySphere(r0: f32, dh: f32, mu: f32, rs: f32) -> vec2f {
  let s = sqrt(max(1.0 - mu * mu, 0.0));
  let gap = r0 * (mu * mu / (1.0 + s)) - dh;
  let disc = gap * (rs + r0 * s);
  if (disc < 0.0) { return vec2f(1.0, -1.0); }
  let sq = sqrt(disc);
  let b = r0 * mu;
  let c = dh * (r0 + rs);
  if (b > 0.0) {
    let t0 = -(b + sq);
    return vec2f(t0, c / t0);
  }
  let t1 = sq - b;
  if (t1 <= 0.0) { return vec2f(0.0, 0.0); }
  return vec2f(c / t1, t1);
}

/// cos(angle between unit vectors d and up) with full relative precision near +-1: from the cross product
/// where the dot product has lost its digits.
fn atmoPreciseMu(d: vec3f, up: vec3f) -> f32 {
  let c = dot(d, up);
  if (abs(c) < 0.7) { return c; }
  let s2 = dot(cross(d, up), cross(d, up));
  return sign(c) * sqrt(max(1.0 - s2, 0.0));
}

/// A camera ray against the atmosphere of one body.
struct AtmoRay {
  t0: f32,       // distance from the eye to where the path inside the shell starts (0 with the eye inside)
  len: f32,      // length of the path inside the shell and in front of the reference sphere (<= 0: none)
  r: f32,        // radius of the start point (m)
  h: f32,        // its altitude above the reference radius (m)
  mu: f32,       // cos(angle between the ray and the local vertical) at the start point
  ground: f32,   // 1 when the path ends on the reference sphere
}

fn atmoRay(bi: u32, d: vec3f) -> AtmoRay {
  let up = frame.bodies[bi].cameraUp.xyz;
  let r0 = frame.bodies[bi].cameraUp.w;
  let h0 = frame.bodies[bi].sunDir.w;
  let rb = frame.bodies[bi].center.w;
  let rt = frame.bodies[bi].prevCenter.w;
  let top = rt - rb;
  var ray: AtmoRay;
  ray.t0 = 0.0;
  ray.len = -1.0;
  ray.ground = 0.0;
  if (h0 <= top) {
    // Eye inside the shell: the path starts at the eye.
    ray.r = r0;
    ray.h = h0;
    ray.mu = atmoPreciseMu(d, up);
    ray.len = atmoRaySphere(r0, h0 - top, ray.mu, rt).y;
    if (ray.mu < 0.0 && h0 > 0.0) {
      let g = atmoRaySphere(r0, h0, ray.mu, rb);
      if (g.y > g.x && g.x > 0.0) {
        ray.len = min(ray.len, g.x);
        ray.ground = 1.0;
      }
    }
    return ray;
  }
  // Eye outside: the path starts where the ray enters the shell. Impact parameter p from the cross product.
  let c = dot(d, up);
  let p = r0 * length(cross(d, up));
  if (c >= 0.0 || p >= rt) { return ray; }
  let sinA = p / rt;
  let cosA = sqrt(max(1.0 - sinA * sinA, 0.0));
  ray.r = rt;
  ray.h = top;
  ray.mu = -cosA;
  ray.t0 = max(r0 * sqrt(max(1.0 - (p / r0) * (p / r0), 0.0)) - rt * cosA, 0.0);
  ray.len = 2.0 * rt * cosA;
  if (p < rb) {
    ray.len = rt * cosA - rb * sqrt(max(1.0 - (p / rb) * (p / rb), 0.0));
    ray.ground = 1.0;
  }
  return ray;
}

/// Altitude (m) at distance s from the start of the path: the stable altitude formula from that point.
fn atmoRayAltitude(ray: AtmoRay, s: f32) -> f32 { return altitudeAt(s, ray.r, ray.h, ray.mu); }

/// Fraction of the solar disc above the horizon of the reference sphere, seen from radius r with the sun's
/// centre at zenith cosine muS (the planet's shadow with its penumbra; straight-edge form).
fn atmoHorizonVisibility(r: f32, rb: f32, muS: f32) -> f32 {
  let dip = acos(min(rb / max(r, rb), 1.0));
  let elevation = asin(clamp(muS, -1.0, 1.0)) + dip;
  let x = clamp(elevation / frame.sunDir.w, -1.0, 1.0);
  return 1.0 - (acos(x) - x * sqrt(max(1.0 - x * x, 0.0))) / PI;
}

/// Visible fraction of the solar disc from a camera-relative point: x = against every non-star body,
/// y = against every non-star body except 'own' (what dims the multiply scattered light inside the
/// atmosphere of 'own': its own shadow is already in the multi-scattering table).
fn atmoSunVisibility(pos: vec3f, sunDir: vec3f, own: u32) -> vec2f {
  var vis = vec2f(1.0);
  for (var i = 0u; i < frame.counts.x; i++) {
    if ((bodyFlags(i) & BODY_FLAG_STAR) != 0u) { continue; }
    let toBody = frame.bodies[i].center.xyz - pos;
    let dist = max(length(toBody), 1e-3);
    let dir = toBody / dist;
    let ro = asin(min(frame.bodies[i].center.w / dist, 1.0));
    let sep = atan2(length(cross(dir, sunDir)), dot(dir, sunDir));
    let f = discVisibleFraction(frame.sunDir.w, ro, sep);
    vis.x *= f;
    if (i != own) { vis.y *= f; }
  }
  return vis;
}

/// Visible fraction of the solar disc from a camera-relative point against every non-star body except
/// 'own': eclipses by other bodies. It varies over hundreds of kilometres, so a path through an atmosphere
/// evaluates it at its two ends and interpolates.
fn atmoOtherVisibility(pos: vec3f, sunDir: vec3f, own: u32) -> f32 {
  var vis = 1.0;
  for (var i = 0u; i < frame.counts.x; i++) {
    if (i == own || (bodyFlags(i) & BODY_FLAG_STAR) != 0u) { continue; }
    let toBody = frame.bodies[i].center.xyz - pos;
    let dist = max(length(toBody), 1e-3);
    let dir = toBody / dist;
    let ro = asin(min(frame.bodies[i].center.w / dist, 1.0));
    let sep = atan2(length(cross(dir, sunDir)), dot(dir, sunDir));
    vis *= discVisibleFraction(frame.sunDir.w, ro, sep);
  }
  return vis;
}

/// Multi-scattering transfer (luminance per unit of scattering coefficient and of sun illuminance) at
/// altitude h and sun-zenith cosine muS; 'top' = shell thickness.
fn atmoMultiScatter(ms: texture_2d_array<f32>, layer: i32, h: f32, muS: f32, top: f32) -> vec3f {
  let uv = vec2f(lutUnitToTexCoord(saturate(muS * 0.5 + 0.5), ATMO_MS_SIZE.x), lutUnitToTexCoord(saturate(h / top), ATMO_MS_SIZE.y));
  return textureSampleLevel(ms, linearClamp, uv, layer, 0.0).rgb;
}

struct AtmoSample {
  direct: vec3f,   // singly scattered sunlight towards the eye per metre, cd / m^2 / m (no cloud shadow)
  multi: vec3f,    // multiply scattered light per metre
  ext: vec3f,      // extinction, 1 / m
}

/// Source terms and extinction of body 'bi' at distance s along the path of 'ray' (camera ray d).
/// 'phase' = (Rayleigh, Mie) phase for this ray, 'others' = visible fraction of the sun against the other
/// bodies at the sample (atmoOtherVisibility). Cloud shadows are the caller's business: they multiply
/// 'direct' (see chunk "atmosphere_cloud_shadow").
fn atmoSampleAt(trans: texture_2d_array<f32>, ms: texture_2d_array<f32>, bi: u32, layer: i32, d: vec3f, ray: AtmoRay, s: f32, phase: vec2f, others: f32) -> AtmoSample {
  let rb = frame.bodies[bi].center.w;
  let h = atmoRayAltitude(ray, s);
  let pos = d * (ray.t0 + s);
  let up = normalize(pos - frame.bodies[bi].center.xyz);
  let sunDir = frame.bodies[bi].sunDir.xyz;
  let muS = dot(up, sunDir);
  // The body's own shadow (with its penumbra) from the sample's radius and sun angle; eclipses from 'others'.
  let own = atmoHorizonVisibility(rb + max(h, 0.0), rb, muS) * others;
  let m = atmoMedium(bi, h);
  var sun = vec3f(0.0);
  if (own > 0.0) { sun = atmosphereSunTransmittance(trans, bi, rb + max(h, 0.0), muS) * own; }
  let psi = atmoMultiScatter(ms, layer, h, muS, frame.bodies[bi].prevCenter.w - rb) * others;
  var o: AtmoSample;
  o.direct = frame.sunIlluminance.rgb * sun * (m.scatR * phase.x + vec3f(m.scatM * phase.y));
  o.multi = frame.sunIlluminance.rgb * psi * (m.scatR + vec3f(m.scatM));
  o.ext = m.ext;
  return o;
}

/// Piecewise-linear cumulative distribution of march samples over [sA, sB] of a path: proportional to the
/// density of scatterers at ATMO_KNOTS + 1 knots, with a uniform floor. The knots themselves crowd
/// (quadratically) around the lowest point of the path, where the density peaks: the eye for a camera on
/// the ground, the far end looking down from orbit, the tangent point on the limb. One formula for every
/// camera regime, continuous in every parameter.
struct AtmoCdf {
  c: array<f32, 9>,   // cumulative weight at the knots
  s: array<f32, 9>,   // distance of the knots along the path
}

fn atmoImportance(bi: u32, h: f32) -> f32 {
  let hc = max(h, 0.0);
  let mieWeight = frame.bodies[bi].mie.x / max(frame.bodies[bi].rayleigh.g, 1e-12);
  return exp(-hc / frame.bodies[bi].rayleigh.a) + mieWeight * exp(-hc / frame.bodies[bi].mie.z);
}

fn atmoBuildCdf(bi: u32, ray: AtmoRay, sA: f32, sB: f32) -> AtmoCdf {
  var cdf: AtmoCdf;
  // Where the lowest point of the ray lies on [sA, sB], as a fraction.
  let up = clamp((-ray.r * ray.mu - sA) / max(sB - sA, 1e-3), 0.0, 1.0);
  var w: array<f32, 9>;
  var wMax = 0.0;
  for (var k = 0; k <= ATMO_KNOTS; k++) {
    let u = f32(k) / f32(ATMO_KNOTS);
    var g = up + (u - up) * (u - up) / max(1.0 - up, 1e-4);
    if (u < up) { g = up - (up - u) * (up - u) / max(up, 1e-4); }
    cdf.s[k] = sA + (sB - sA) * saturate(g);
    w[k] = atmoImportance(bi, atmoRayAltitude(ray, cdf.s[k]));
    wMax = max(wMax, w[k]);
  }
  cdf.s[ATMO_KNOTS] = sB;
  let base = 0.06 * wMax + 1e-20;
  cdf.c[0] = 0.0;
  for (var k = 0; k < ATMO_KNOTS; k++) {
    cdf.c[k + 1] = cdf.c[k] + (0.5 * (w[k] + w[k + 1]) + base) * max(cdf.s[k + 1] - cdf.s[k], 0.0);
  }
  return cdf;
}

/// Index of the knot interval that holds cumulative fraction u, searched forward from interval k0 (a
/// lower bound: 0, or the interval of a smaller u - the samples of a march come in increasing order).
fn atmoCdfInterval(cdf: ptr<function, AtmoCdf>, u: f32, k0: i32) -> i32 {
  let goal = u * (*cdf).c[ATMO_KNOTS];
  var k = k0;
  for (var i = k0 + 1; i < ATMO_KNOTS; i++) {
    if ((*cdf).c[i] > goal) { break; }
    k = i;
  }
  return k;
}

/// Distance along the path at cumulative fraction u in [0, 1], which lies in knot interval k.
fn atmoCdfAt(cdf: ptr<function, AtmoCdf>, u: f32, k: i32) -> f32 {
  let goal = u * (*cdf).c[ATMO_KNOTS];
  let f = (goal - (*cdf).c[k]) / max((*cdf).c[k + 1] - (*cdf).c[k], 1e-30);
  return mix((*cdf).s[k], (*cdf).s[k + 1], saturate(f));
}

/// Distance along the path at cumulative fraction u in [0, 1]; k0 = a lower bound of its knot interval.
fn atmoInvCdf(cdf: ptr<function, AtmoCdf>, u: f32, k0: i32) -> f32 {
  return atmoCdfAt(cdf, u, atmoCdfInterval(cdf, u, k0));
}

struct AtmoPath {
  L: vec3f,   // in-scattered luminance, cd / m^2
  T: vec3f,   // transmittance
}

/// In-scatter and transmittance of body 'bi' along the whole path of 'ray' with n samples placed by the
/// importance distribution, each at the middle of its stratum. No cloud shadow.
fn atmoIntegrate(trans: texture_2d_array<f32>, ms: texture_2d_array<f32>, bi: u32, layer: i32, d: vec3f, ray: AtmoRay, n: i32) -> AtmoPath {
  var path: AtmoPath;
  path.L = vec3f(0.0);
  path.T = vec3f(1.0);
  if (ray.len <= 0.0) { return path; }
  let cosSun = dot(d, frame.bodies[bi].sunDir.xyz);
  let phase = vec2f(atmoPhaseR(cosSun), atmoPhaseM(cosSun, frame.bodies[bi].mie.w));
  var cdf = atmoBuildCdf(bi, ray, 0.0, ray.len);
  let othersA = atmoOtherVisibility(d * ray.t0, frame.bodies[bi].sunDir.xyz, bi);
  let othersB = atmoOtherVisibility(d * (ray.t0 + ray.len), frame.bodies[bi].sunDir.xyz, bi);
  var sPrev = 0.0;
  var k = 0;   // knot interval in which the current stratum begins
  for (var i = 0; i < n; i++) {
    let sm = atmoInvCdf(&cdf, (f32(i) + 0.5) / f32(n), k);
    var sNext = ray.len;
    if (i < n - 1) {
      k = atmoCdfInterval(&cdf, f32(i + 1) / f32(n), k);
      sNext = atmoCdfAt(&cdf, f32(i + 1) / f32(n), k);
    }
    let o = atmoSampleAt(trans, ms, bi, layer, d, ray, sm, phase, mix(othersA, othersB, sm / ray.len));
    let dt = sNext - sPrev;
    path.L += path.T * (o.direct + o.multi) * atmoSegment(o.ext, dt);
    path.T *= exp(-o.ext * dt);
    sPrev = sNext;
  }
  return path;
}
`;
