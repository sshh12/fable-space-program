/**
 * WGSL chunk "ocean_waves": the per-frame ocean uniform block, the chart mapping (plane offset from the
 * reference point -> sphere offset, cancellation-free), the shared analytic swell, the FFT cascades, vessel
 * damping and splash ripples, and the displaced-surface evaluation used by the surface vertex shader and by
 * the readback compute shader (so the readback measures exactly what is drawn).
 *
 * The including module declares, before including this chunk:
 *   oceanU: OceanUniforms (uniform),  oceanDisp: texture_2d_array<f32> ('ocean.displacement'),
 *   oceanDispPrev: texture_2d_array<f32> (previous frame), oceanDeriv: texture_2d_array<f32> ('ocean.derivatives'),
 *   oceanFoam: texture_2d_array<f32>, oceanWake: texture_2d<f32>,
 * and includes "frame" (samplers).
 *
 * Conventions: all wave maths is in BODY-FIXED axes; plane coordinates (x along e = east, y along f = north
 * at the anchor) are offsets from the frame's reference point c (the camera's nadir on the sea-level sphere);
 * cascade texture coordinates are plane coordinates / L plus the float64-reduced fraction of the reference.
 */
import { MAX_SWELL } from '../swell';
import { CASCADE_COUNT, CASCADE_MIPS } from '../spectrum';

export const MAX_VESSELS = 8;
export const MAX_RIPPLES = 8;
/** Number of vec4 in OceanUniforms (see packOceanUniforms). */
export const OCEAN_UNIFORM_VEC4 = 76;
export const OCEAN_UNIFORM_BYTES = OCEAN_UNIFORM_VEC4 * 16;

export const OCEAN_WAVES_WGSL = /* wgsl */ `
const OCEAN_MAX_SWELL = ${MAX_SWELL}u;
const OCEAN_CASCADES = ${CASCADE_COUNT}u;
const OCEAN_CASCADE_MIPS = ${CASCADE_MIPS}.0;
const OCEAN_MAX_VESSELS = ${MAX_VESSELS}u;
const OCEAN_MAX_RIPPLES = ${MAX_RIPPLES}u;
const OCEAN_G = 9.80665;

struct OceanCascade {
  geom: vec4f,    // x = patch length L (m), y = 1 / L, z / w = plane coordinates of the reference point / L, modulo 1
  filt0: vec4f,   // fraction of the slope variance that survives the texture filter at mips 0..3
  filt1: vec4f,   // ... at mips 4..7 (mip 8 and coarser: 0)
  stats: vec4f,   // x = slope variance, y = height RMS (m), z = band mean omega (rad/s, TMA), w = residual amplitude inside a vessel's damping zone
}
struct OceanVessel {
  a: vec4f,       // xy = plane offset of the vessel from the reference point (m), z = hull radius (m), w = outer damping radius (m)
  b: vec4f,       // x = damping strength 0..1, y = waterline wobble bound (m), zw = 0
}
struct OceanUniforms {
  cHat: vec4f,          // xyz = unit body-fixed direction of the reference point, w = sea-level radius R (m)
  axisE: vec4f,         // xyz = chart east axis e (unit, body-fixed), w = 1 / (R |q_c|)
  axisF: vec4f,         // xyz = chart north axis f (unit), w = camera height above sea level (m, float64)
  rot0: vec4f, rot1: vec4f, rot2: vec4f,             // body-fixed -> ROOT, columns (this frame)
  prevRot0: vec4f, prevRot1: vec4f, prevRot2: vec4f, // previous frame
  refRel: vec4f,        // xyz = reference point - camera (ROOT axes, m), w = frame body index
  refRelPrev: vec4f,    // xyz = reference point - previous camera (previous ROOT axes), w = 1 when valid
  fade: vec4f,          // x = fadeStart, y = fadeEnd, z = radius of complete wave detail, w = lift of the flat band surface (m)
  wind: vec4f,          // x = U10 (m/s), y = Cox-Munk mean square slope, z = slope variance below the finest cascade, w = choppiness (already in the textures)
  time: vec4f,          // x = tau = frac(t / T), y = tau of the previous frame, z = T (s), w = dt (s)
  foam: vec4f,          // x = decay (1/s), y = Jacobian threshold, z = gain, w = foam albedo
  shore: vec4f,         // x = shore foam depth (m), y = refraction distortion, z = chromatic offset, w = statistical whitecap coverage
  counts: vec4u,        // x = swell components, y = vessels, z = ripples, w = flags (1 = wake texture valid)
  wake: vec4f,          // xy = plane offset of the wake texture centre from the reference point, z = extent (m), w = 1 / extent
  swellDirK: array<vec4f, ${MAX_SWELL}>,    // xyz = unit body-fixed direction, w = wavenumber k
  swellAmpPhase: array<vec4f, ${MAX_SWELL}>, // x = amplitude, y = phase at the reference point now, z = d . cHat, w = phase one frame earlier
  cascades: array<OceanCascade, ${CASCADE_COUNT}>,
  vessels: array<OceanVessel, ${MAX_VESSELS}>,
  ripples: array<vec4f, ${MAX_RIPPLES}>,     // xy = plane offset from the reference point, z = age now (s), w = amplitude (m)
  rippleParams: vec4f,  // x = wavenumber k, y = lifetime (s), z = group speed (m/s), w = omega (rad/s)
  misc: vec4f,          // x = sea level above the reference radius (m), y = wave height bound (m), zw = 0
}

fn oceanRot(v: vec3f) -> vec3f { return oceanU.rot0.xyz * v.x + oceanU.rot1.xyz * v.y + oceanU.rot2.xyz * v.z; }
fn oceanRotPrev(v: vec3f) -> vec3f { return oceanU.prevRot0.xyz * v.x + oceanU.prevRot1.xyz * v.y + oceanU.prevRot2.xyz * v.z; }
fn oceanRotInv(v: vec3f) -> vec3f { return vec3f(dot(v, oceanU.rot0.xyz), dot(v, oceanU.rot1.xyz), dot(v, oceanU.rot2.xyz)); }

/// Offset R (n - cHat) (body-fixed, m) of the sphere point at plane offset p from the reference point.
/// Cancellation-free for any |p| up to hundreds of km (rendering-design 2.3).
fn oceanSphereOffset(p: vec2f) -> vec3f {
  let c = oceanU.cHat.xyz;
  let d = (oceanU.axisE.xyz * p.x + oceanU.axisF.xyz * p.y) * oceanU.axisE.w;
  let e = 2.0 * dot(c, d) + dot(d, d);
  let s = sqrt(1.0 + e);
  let inv = -e / (s * (1.0 + s));
  return (d * (1.0 + inv) + c * inv) * oceanU.cHat.w;
}
/// Unit up (body-fixed) at a sphere offset.
fn oceanUpAt(delta: vec3f) -> vec3f { return normalize(oceanU.cHat.xyz + delta / oceanU.cHat.w); }

fn oceanWrapPhase(ph: f32) -> f32 { return ph - TWO_PI * floor(ph / TWO_PI); }

struct OceanSwellSample {
  height: f32,        // m
  grad: vec3f,        // tangential gradient of the height (body-fixed, m/m)
  disp: vec2f,        // horizontal (Gerstner) particle displacement in plane axes (m), for the Lagrangian chop
  variance: f32,      // slope variance carried by the components at this filter width
}

/// The shared swell at sphere offset 'delta' (body-fixed, m) and unit up 'up'. prev = evaluate one frame earlier.
/// 'filterWidth' (m) band-limits each component (0 = exact, the physics surface). Mirrors oceanSwellHeight.
fn oceanSwellEval(delta: vec3f, up: vec3f, filterWidth: f32, prev: bool) -> OceanSwellSample {
  var o: OceanSwellSample;
  o.height = 0.0;
  o.grad = vec3f(0.0);
  o.disp = vec2f(0.0);
  o.variance = 0.0;
  let invR = 1.0 / oceanU.cHat.w;
  for (var i = 0u; i < min(oceanU.counts.x, OCEAN_MAX_SWELL); i++) {
    let dk = oceanU.swellDirK[i];
    let ap = oceanU.swellAmpPhase[i];
    let dd = dot(dk.xyz, delta);
    let dn = ap.z + dd * invR;
    let sinAng = sqrt(max(0.0, 1.0 - dn * dn));
    let w = smoothstep(0.15, 0.5, sinAng);
    if (w == 0.0) { continue; }
    let ph = oceanWrapPhase(select(ap.y, ap.w, prev) + dk.w * dd);
    let band = exp(-0.125 * sq(dk.w * filterWidth));
    let a = ap.x * w * band;
    let c = cos(ph);
    let s = sin(ph);
    o.height += a * c;
    // d(phase)/d(surface position) = k (d - (d . n) n): the component's wavevector on the sphere.
    let kt = dk.xyz - up * dot(dk.xyz, up);
    o.grad += -a * dk.w * s * kt;
    let dir = kt / max(length(kt), 1e-6);
    o.disp += -a * s * vec2f(dot(dir, oceanU.axisE.xyz), dot(dir, oceanU.axisF.xyz));
    o.variance += 0.5 * sq(a * dk.w * sinAng);
  }
  return o;
}

/// TMA depth factor (amplitude) of a cascade band in water of depth 'h' (m): sqrt(Phi(omega sqrt(h / g))).
fn oceanTma(c: u32, h: f32) -> f32 {
  let wh = oceanU.cascades[c].stats.z * sqrt(max(h, 0.0) / OCEAN_G);
  var phi = 1.0;
  if (wh < 1.0) { phi = 0.5 * wh * wh; } else if (wh < 2.0) { phi = 1.0 - 0.5 * sq(2.0 - wh); }
  return sqrt(phi);
}

/// Amplitude factor of cascade c at plane offset p: 1 in the open sea, the residual inside vessels' damping zones.
fn oceanDamping(c: u32, p: vec2f) -> f32 {
  var m = 1.0;
  for (var i = 0u; i < min(oceanU.counts.y, OCEAN_MAX_VESSELS); i++) {
    let v = oceanU.vessels[i];
    let d = distance(p, v.a.xy);
    let inside = (1.0 - smoothstep(v.a.z, v.a.w, d)) * v.b.x;
    m = min(m, mix(1.0, oceanU.cascades[c].stats.w, inside));
  }
  return m;
}

/// Radial splash ripples: height and plane-space gradient at plane offset p. prev = one frame earlier.
fn oceanRipples(p: vec2f, prev: bool) -> vec3f {
  var o = vec3f(0.0);
  let k = oceanU.rippleParams.x;
  let life = oceanU.rippleParams.y;
  let cg = oceanU.rippleParams.z;
  let omega = oceanU.rippleParams.w;
  for (var i = 0u; i < min(oceanU.counts.z, OCEAN_MAX_RIPPLES); i++) {
    let r = oceanU.ripples[i];
    let age = r.z - select(0.0, oceanU.time.w, prev);
    if (age <= 0.0 || age >= life) { continue; }
    let rel = p - r.xy;
    let dist = length(rel);
    let front = cg * age;
    let width = 1.2 * TWO_PI / k + 0.25 * front;
    let env = exp(-sq((dist - front) / width)) * sq(1.0 - age / life) * inverseSqrt(1.0 + dist / 3.0);
    let ph = k * dist - omega * age;
    let a = r.w * env;
    o.x += a * cos(ph);
    let dir = rel / max(dist, 1e-3);
    o.y += -a * k * sin(ph) * dir.x;
    o.z += -a * k * sin(ph) * dir.y;
  }
  return o;
}

/// Cascade texture coordinates of plane offset p.
fn oceanCascadeUv(c: u32, p: vec2f) -> vec2f {
  let g = oceanU.cascades[c].geom;
  return g.zw + p * g.y;
}

struct OceanFftSample {
  disp: vec3f,     // x / z = horizontal displacement along e / f (m), y = height (m)
  dxdz: f32,       // d Dx / d y (cross term of the Jacobian)
}

/// FFT displacement at plane offset p, band-limited to 'filterWidth' (m) by the texture mip, with per-cascade
/// amplitude factors 'amp' (damping x TMA x detail). prev = the previous frame's field.
fn oceanFftDisplacement(p: vec2f, filterWidth: f32, amp: vec4f, prev: bool) -> OceanFftSample {
  var o: OceanFftSample;
  o.disp = vec3f(0.0);
  o.dxdz = 0.0;
  for (var c = 0u; c < OCEAN_CASCADES; c++) {
    if (amp[c] == 0.0) { continue; }
    let g = oceanU.cascades[c].geom;
    let lod = clamp(log2(max(filterWidth * 256.0 * g.y, 1e-6)), 0.0, OCEAN_CASCADE_MIPS - 1.0);
    let uv = oceanCascadeUv(c, p);
    var t: vec4f;
    if (prev) { t = textureSampleLevel(oceanDispPrev, linearRepeat, uv, c, lod); }
    else { t = textureSampleLevel(oceanDisp, linearRepeat, uv, c, lod); }
    o.disp += t.xyz * amp[c];
    o.dxdz += t.w * amp[c];
  }
  return o;
}

/// Fraction (0..1) of complete wave detail at eye distance d: 1 inside fade.z, 0 from fadeStart on.
fn oceanDetail(d: f32) -> f32 { return 1.0 - smoothstep(oceanU.fade.z, oceanU.fade.x, d); }

struct OceanSurfacePoint {
  delta: vec3f,      // final sphere offset of the displaced point from the reference (body-fixed, m), on the sea-level sphere
  up: vec3f,         // unit up there
  height: f32,       // total height above the sea-level sphere (m)
  swell: f32,        // swell part of it (oceanSwellHeight at the final horizontal position)
  fft: f32,          // FFT part (render-only)
  ripple: f32,       // splash ripple part (render-only)
  finalPlane: vec2f, // final horizontal position, plane offset (m)
}

/// The displaced surface for Lagrangian plane offset p0: horizontal Gerstner motion of the swell plus FFT chop
/// move the point to p = p0 + D; the height is the swell evaluated AT p (so the drawn surface's height at any
/// horizontal position equals oceanSwellHeight there) plus the FFT height carried from p0 plus ripples.
fn oceanSurfaceAt(p0: vec2f, filterWidth: f32, detail: f32, amp: vec4f, prev: bool) -> OceanSurfacePoint {
  var o: OceanSurfacePoint;
  let delta0 = oceanSphereOffset(p0);
  let up0 = oceanUpAt(delta0);
  let sw0 = oceanSwellEval(delta0, up0, filterWidth, prev);
  let f = oceanFftDisplacement(p0, filterWidth, amp * detail, prev);
  let p = p0 + (sw0.disp * detail + f.disp.xz);
  o.finalPlane = p;
  o.delta = oceanSphereOffset(p);
  o.up = oceanUpAt(o.delta);
  let sw = oceanSwellEval(o.delta, o.up, filterWidth, prev);
  let rp = oceanRipples(p, prev);
  o.swell = sw.height * detail;
  o.fft = f.disp.y;
  o.ripple = rp.x * detail;
  o.height = o.swell + o.fft + o.ripple;
  return o;
}

/// Per-cascade amplitude factors (vessel damping x TMA in water of depth h) at plane offset p.
fn oceanAmplitudes(p: vec2f, h: f32) -> vec4f {
  var a = vec4f(1.0);
  for (var c = 0u; c < OCEAN_CASCADES; c++) { a[c] = oceanDamping(c, p) * oceanTma(c, h); }
  return a;
}

/// Filtered fraction of cascade c's slope variance at (fractional) mip level l.
fn oceanFilteredFraction(c: u32, l: f32) -> f32 {
  let cs = oceanU.cascades[c];
  let li = clamp(l, 0.0, 8.0);
  let i0 = u32(floor(li));
  let t = li - f32(i0);
  var v = array<f32, 9>(cs.filt0.x, cs.filt0.y, cs.filt0.z, cs.filt0.w, cs.filt1.x, cs.filt1.y, cs.filt1.z, cs.filt1.w, 0.0);
  return mix(v[min(i0, 8u)], v[min(i0 + 1u, 8u)], t);
}
`;
