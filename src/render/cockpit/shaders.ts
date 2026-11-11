/**
 * WGSL of the cockpit feature. The chunk "cockpit_cabin" holds the per-frame cabin uniforms and the light
 * transport inside the cabin; the pipelines below include it.
 *
 * Interior light (docs/handoff/cockpit.md, section "Light"):
 *  - the sun through the windows comes from the core's deferred sun term and the vessel-anchored cascade 0
 *    (hard patches that sweep across the panels), because the cabin is a closed shell with real openings;
 *  - every other source is a Lambertian polygon evaluated here per pixel with the vector form factor
 *    (Lambert's polygon formula): the windows (radiance = what the environment probe sees through them, plus
 *    the reentry shock layer), the sun patches (the window outlines projected onto the surface the sun
 *    hits, glowing with their reflected sunlight), the floodlight diffusers and the three displays (mean
 *    luminance of their current image from the last mip);
 *  - the inter-reflection of all that light is an integrating-sphere term rho / (S (1 - rho)) x flux;
 *  - glossy surfaces add a representative-point GGX lobe for the windows and floodlights.
 * Interior pixels write ambient occlusion 0 to RT0.a so the core's environment ambient (the open sky)
 * does not reach them: the cabin's own ambient is part of the emitted term written here.
 *
 * Bind group 1 of every pipeline except the shadow caster (see CABIN_DECLS): 0 cabin uniform, 1 controls,
 * 2 materials, 3 label atlas, 4 MFD array, 5 navball image, 6.. the scene sets env, atmosphereLuts,
 * transparency and shadow.
 */
import { MAX_CABIN_POLYS } from './lighting';

export const CONTROL_FLOATS = 24;
export const CABIN_HEADER_FLOATS = 4 * 18;
export const CABIN_POLY_FLOATS = 4 * 6;
export const CABIN_UNIFORM_FLOATS = CABIN_HEADER_FLOATS + MAX_CABIN_POLYS * CABIN_POLY_FLOATS;
export const MAX_MATERIALS = 48;

/** Declarations of group 1 (prefix of every cabin module); `scene` is the createSceneBindings WGSL. */
export const CABIN_DECLS = (scene: string): string => /* wgsl */ `
@group(1) @binding(0) var<uniform> cabin: CabinFrame;
@group(1) @binding(1) var<storage, read> controls: array<Control>;
@group(1) @binding(2) var<uniform> materials: array<Material, ${MAX_MATERIALS}>;
@group(1) @binding(3) var labelAtlas: texture_2d<f32>;
@group(1) @binding(4) var mfdTex: texture_2d_array<f32>;
@group(1) @binding(5) var navballTex: texture_2d<f32>;
/// The per-frame cabin quantities, computed once per frame by AMBIENT_WGSL: CabinAmbient, then the radiance
/// of every cabin polygon whose radiance comes from the GPU (windows: the probe; displays: their mean).
@group(1) @binding(6) var<storage, read> cabinAmb: array<vec4f, ${AMBIENT_VEC4S}>;
fn cabinAmbient() -> CabinAmbient {
  var o: CabinAmbient;
  o.uniformE = cabinAmb[0].xyz;
  o.brightness = cabinAmb[0].w;
  o.sunT = cabinAmb[1].xyz;
  return o;
}
fn cabinPolyRadiance(i: u32) -> vec3f { return cabinAmb[2u + i].xyz; }
${scene}
`;

/** First binding of the scene sets in the cabin group (after the cabin's own bindings 0..6). */
export const CABIN_SCENE_BINDING = 7;

/**
 * One invocation per frame: the cabin quantities every pixel shares (uniform inter-reflection irradiance,
 * display brightness, sun transmittance), from the environment probe, the displays' mean and the
 * atmosphere's transmittance. Group 1: cabin uniform, display array, output, then the scene sets.
 */
export const AMBIENT_WGSL = (scene: string): string => /* wgsl */ `
#include "frame"
@group(1) @binding(0) var<uniform> cabin: CabinFrame;
@group(1) @binding(1) var mfdTex: texture_2d_array<f32>;
@group(1) @binding(2) var<storage, read_write> outAmb: array<vec4f, ${AMBIENT_VEC4S}>;
fn cabinPolyRadiance(i: u32) -> vec3f { return outAmb[2u + i].xyz; }
${scene}
#include "cockpit_cabin"
// One invocation per cabin polygon; texture fetches run in parallel, the sums in invocation 0.
var<workgroup> wFlux: array<vec3f, ${MAX_CABIN_POLYS}>;
var<workgroup> wShared: vec4f;
@compute @workgroup_size(${MAX_CABIN_POLYS}) fn main(@builtin(local_invocation_index) i: u32) {
  let n = cabin.counts.x;
  var kind = 255u;
  var P: CabinPoly;
  if (i < n) {
    P = cabin.polys[i];
    kind = u32(P.p0.w);
  }
  // Windows: the flux they let in (for the uniform inter-reflection term) and what a cabin surface sees
  // through them: the probe about the outward axis, filtered over the cone the cabin's surfaces look out
  // through (about 1.5 sr).
  var L = vec3f(0.0);
  var flux = vec3f(0.0);
  if (kind == POLY_WINDOW) {
    flux = windowRadiance(-P.normal.xyz, 6.28, P.radiance.rgb) * (PI * P.radiance.w);
    L = windowRadiance(-P.normal.xyz, 1.5, P.radiance.rgb);
  }
  wFlux[i] = flux;
  workgroupBarrier();
  if (i == 0u) {
    let sunT = cabinSunTransmittance();
    var total = cabin.bounce.y * sunT * cabin.sunColor.rgb + vec3f(cabin.bounce.z);
    for (var k = 0u; k < ${MAX_CABIN_POLYS}u; k++) { total += wFlux[k]; }
    // Display brightness follows the light the cabin receives (ambient sensor), never below the night floor.
    let eCabin = luminance(total) * cabin.bounce.x / max(cabin.bounce.w, 1e-3);
    let brightness = clamp(sqrt(eCabin / cabin.display.z), cabin.display.y, 1.0);
    outAmb[1] = vec4f(sunT, 0.0);
    wShared = vec4f(total, brightness);
  }
  workgroupBarrier();
  let brightness = wShared.w;
  var dflux = vec3f(0.0);
  if (kind == POLY_DISPLAY) {
    L = displayMean(u32(P.p1.w)) * brightness;
    dflux = L * (PI * P.radiance.w);
  }
  wFlux[i] = dflux;
  if (i < n) { outAmb[2u + i] = vec4f(L, 0.0); }
  workgroupBarrier();
  if (i == 0u) {
    var total = wShared.xyz;
    for (var k = 0u; k < ${MAX_CABIN_POLYS}u; k++) { total += wFlux[k]; }
    outAmb[0] = vec4f(total * cabin.bounce.x, brightness);
  }
}
`;

/** vec4s of the ambient pass's output: CabinAmbient (2), then one per cabin polygon. */
export const AMBIENT_VEC4S = 2 + MAX_CABIN_POLYS;

/** First binding of the scene sets in the ambient pass's group. */
export const AMBIENT_SCENE_BINDING = 3;

/** Common include block of the cabin modules. */
const HEAD = (decls: string): string => `
#include "frame"
#include "gbuffer"
#include "noise"
#include "shadows"
#include "transparency"
${decls}
#include "cockpit_cabin"
`;

export const CABIN_CHUNK = /* wgsl */ `
#include "frame"
#include "brdf"
#include "atmosphere_common"

const MAX_CABIN_POLYS = ${MAX_CABIN_POLYS}u;
const POLY_WINDOW = 0u;
const POLY_PATCH = 1u;
const POLY_FLOOD = 2u;
const POLY_DISPLAY = 3u;

struct Control {
  pivot: vec4f,       // xyz = pivot (part frame)
  rot: vec4f,         // rotation quaternion about the pivot, this frame
  offset: vec4f,      // xyz = translation (part frame), w = bitcast u32 segment mask
  prevRot: vec4f,
  prevOffset: vec4f,
  emit: vec4f,        // rgb = emitted luminance (cd/m^2, not pre-exposed), w = 1 when lit
}
struct Material { a: vec4f, b: vec4f, c: vec4f }   // albedo + roughness | metallic, shading, anisotropy, clearcoat | detail, strength, translucency, -
struct CabinPoly {
  p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f,  // corners, camera-relative ROOT axes (m); p0.w = kind, p1.w = display layer / window index
  radiance: vec4f,                             // rgb cd/m^2 (NOT pre-exposed; windows: glass transmittance), w = area (m^2)
  normal: vec4f,                               // xyz = emitting / outward normal (ROOT), w = 1 when the source is on
}
struct CabinFrame {
  m0: vec4f, m1: vec4f, m2: vec4f,     // part frame -> camera-relative ROOT (rows; translation in w), this frame
  q0: vec4f, q1: vec4f, q2: vec4f,     // the same for the previous frame, relative to the previous eye
  sun: vec4f,                          // xyz = sun direction (ROOT), w = sun illuminance at the vessel incl. eclipses (lux, no atmosphere)
  sunColor: vec4f,                     // rgb = sun colour, w = atmosphere body index (-1 = none)
  atmo: vec4f,                         // x = radius of the vessel from that body's centre (m), y = mu of the sun there, z = FDAI integral lighting (cd/m^2 at white)
  bounce: vec4f,                       // x = rho / (S (1 - rho)), y = rho x sun flux through the windows (lm, no atmosphere), z = lamp flux (lm), w = cabin albedo
  legend: vec4f,                       // rgb = back-lit legend luminance (cd/m^2), w = wall-clock time (s)
  plasma: vec4f,                       // rgb = shock-layer radiance seen through the windows (cd/m^2), w = plasma intensity
  display: vec4f,                      // x = display luminance at full brightness (cd/m^2), y = minimum brightness, z = full-brightness ambient (lux), w = pixel structure on (1)
  counts: vec4u,                       // x = polygons, y = windows (the first y polygons), z = displays, w = flags (bit 0 = camera inside the cabin)
  vib: vec4f,                          // reserved (zero)
  misc: vec4f,                         // x = glass transmittance (mean), y = dust density, z = scratch density, w = pane ior
  tint: vec4f,                         // rgb = transmittance of one pane (tint and Fresnel at normal incidence)
  view: vec4f,                         // xyz = camera position in the part frame, w = 1 when the camera is inside the cabin
  polys: array<CabinPoly, ${MAX_CABIN_POLYS}>,
}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn toRoot(m0: vec4f, m1: vec4f, m2: vec4f, p: vec3f) -> vec3f { return vec3f(dot(m0.xyz, p) + m0.w, dot(m1.xyz, p) + m1.w, dot(m2.xyz, p) + m2.w); }
fn dirRoot(v: vec3f) -> vec3f { return vec3f(dot(cabin.m0.xyz, v), dot(cabin.m1.xyz, v), dot(cabin.m2.xyz, v)); }

/// Vector irradiance of a polygon (Lambert): the cosine-weighted directions over its solid angle, over pi.
/// dot(n, V) is the form factor from a point with normal n (without horizon clipping).
fn edgeVec(a: vec3f, b: vec3f) -> vec3f {
  // theta / sin(theta) by the rational fit of Hill and Heitz (no acos, no length).
  let x = dot(a, b);
  let y = abs(x);
  let p = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let q = 3.4175940 + (4.1616724 + y) * y;
  let k = p / q;
  let thetaOverSin = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - k, k, x > 0.0);
  return cross(a, b) * thetaOverSin;
}
fn polyVector(pos: vec3f, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  let u0 = normalize(a - pos);
  let u1 = normalize(b - pos);
  let u2 = normalize(c - pos);
  let u3 = normalize(d - pos);
  var V = (edgeVec(u0, u1) + edgeVec(u1, u2) + edgeVec(u2, u3) + edgeVec(u3, u0)) * (0.5 / PI);
  // Orientation-free: V points toward the polygon.
  if (dot(V, (a + c) * 0.5 - pos) < 0.0) { V = -V; }
  return V;
}

/// Radiance coming in through a window along direction d (ROOT): the environment probe plus the shock layer.
fn windowRadiance(d: vec3f, solidAngle: f32, trans: vec3f) -> vec3f {
  let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
  // Mip whose texel spans the solid angle the window subtends (64^2 faces: one texel ~ 2.4e-4 sr).
  let mip = clamp(0.5 * log2(max(solidAngle, 1e-6) / 2.4e-4), 0.0, mips);
  return (textureSampleLevel(envProbeCube, linearClamp, d, mip).rgb + cabin.plasma.rgb) * trans;
}

/// Transmittance of the atmosphere along the sun ray at the vessel (1 outside atmospheres).
fn cabinSunTransmittance() -> vec3f {
  let bi = i32(cabin.sunColor.w);
  if (bi < 0) { return vec3f(1.0); }
  return atmosphereSunTransmittance(transmittanceLut, u32(bi), cabin.atmo.x, cabin.atmo.y);
}

/// Mean emitted luminance of display layer k at full brightness (cd/m^2): its smallest mip.
fn displayMean(layer: u32) -> vec3f {
  let top = f32(textureNumLevels(mfdTex)) - 1.0;
  return textureSampleLevel(mfdTex, linearClamp, vec2f(0.5), layer, top).rgb * cabin.display.x;
}

struct CabinAmbient {
  /// Uniform inter-reflection irradiance (lux), the display brightness that follows the cabin's light, and
  /// the atmosphere's transmittance of the sun at the vessel.
  uniformE: vec3f,
  brightness: f32,
  sunT: vec3f,
}

struct CabinLight {
  diffuse: vec3f,    // irradiance (lux) to be multiplied by albedo / pi
  specular: vec3f,   // reflected luminance (cd/m^2)
}

/// Light arriving at a cabin surface from every cabin polygon (pos camera-relative ROOT, unit n and v).
fn cabinLight(pos: vec3f, n: vec3f, v: vec3f, roughness: f32, f0: vec3f, amb: CabinAmbient) -> CabinLight {
  var o: CabinLight;
  o.diffuse = vec3f(0.0);
  o.specular = vec3f(0.0);
  let NoV = max(dot(n, v), 1e-3);
  for (var i = 0u; i < cabin.counts.x; i++) {
    let P = cabin.polys[i];
    if (P.normal.w < 0.5) { continue; }
    let kind = u32(P.p0.w);
    let toP = P.p0.xyz - pos;
    if (kind == POLY_WINDOW) {
      // Light from outside enters through the window's inner side: the receiver must be inside.
      if (dot(toP, P.normal.xyz) < 0.0) { continue; }
    } else if (dot(toP, P.normal.xyz) > 0.0) {
      // Emitters light only the side they face.
      continue;
    }
    let V = polyVector(pos, P.p0.xyz, P.p1.xyz, P.p2.xyz, P.p3.xyz);
    let lenV = length(V);
    if (lenV < 1e-7) { continue; }
    let ff = max(dot(n, V), 0.0);
    var L: vec3f;
    if (kind == POLY_WINDOW || kind == POLY_DISPLAY) {
      L = cabinPolyRadiance(i);
    } else if (kind == POLY_PATCH) {
      L = P.radiance.rgb * amb.sunT;
    } else {
      L = P.radiance.rgb;
    }
    let E = L * (PI * ff);
    o.diffuse += E;
    // Representative-point specular for the bright, compact sources (windows, floodlights).
    if ((kind == POLY_WINDOW || kind == POLY_FLOOD) && roughness < 0.75) {
      let l = V / lenV;
      let NoL = dot(n, l);
      if (NoL > 0.0) {
        let h = normalize(v + l);
        // Widen the lobe by the angular size of the source.
        let a = sqrt(sq(max(roughness * roughness, 0.002)) + lenV * 0.5);
        let D = D_GGX(saturate(dot(n, h)), a);
        let Vis = V_SmithGGXCorrelated(NoV, NoL, a);
        let F = F_Schlick(f0, saturate(dot(v, h)));
        o.specular += D * Vis * F * E;
      }
    }
  }
  return o;
}
`;

/** Interior G-buffer: animated controls, procedural surface detail, labels, emitters, cabin light. */
export const INTERIOR_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}

const FLAG_LABEL = 1u;
const FLAG_BACKLIT = 4u;
const FLAG_EMISSIVE = 8u;
const FLAG_SEGMENT = 16u;

const LABEL_COLORS = array<vec3f, 6>(
  vec3f(0.82, 0.83, 0.82), vec3f(0.02, 0.02, 0.02), vec3f(0.72, 0.52, 0.02),
  vec3f(0.55, 0.04, 0.03), vec3f(0.3, 0.32, 0.33), vec3f(0.04, 0.3, 0.12));

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec4f,
  @location(2) tan: vec4f,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) misc: vec4u,
  @location(6) ctl: vec2u,
}
struct VOut {
  // Invariant: the depth pre-pass and the shading pass produce bit-identical depth (depth test 'equal').
  @invariant @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) t: vec4f,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) @interpolate(flat) misc: vec4u,
  @location(6) @interpolate(flat) ctl: vec2u,
  @location(7) currClip: vec4f,
  @location(8) prevClip: vec4f,
}

@vertex fn vs(v: VIn) -> VOut {
  var p = v.pos;
  var pp = v.pos;
  var n = v.nrm.xyz;
  var t = v.tan.xyz;
  if (v.ctl.x > 0u) {
    let C = controls[v.ctl.x - 1u];
    p = C.pivot.xyz + qrot(C.rot, v.pos - C.pivot.xyz) + C.offset.xyz;
    pp = C.pivot.xyz + qrot(C.prevRot, v.pos - C.pivot.xyz) + C.prevOffset.xyz;
    n = qrot(C.rot, n);
    t = qrot(C.rot, t);
  }
  let w = toRoot(cabin.m0, cabin.m1, cabin.m2, p);
  let wp = toRoot(cabin.q0, cabin.q1, cabin.q2, pp);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(w, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(w, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(wp, 1.0);
  o.world = w;
  o.n = dirRoot(n);
  o.t = vec4f(dirRoot(t), v.tan.w);
  o.uv0 = v.uv0;
  o.uv1 = v.uv1;
  o.misc = v.misc;
  o.ctl = v.ctl;
  return o;
}

// ------------------------------------------------------------------------------------------- detail
struct Detail { albedo: f32, rough: f32, bump: vec2f, ao: f32 }

fn vnoise2(p: vec2f, seed: i32) -> f32 { return valueNoise3(vec3f(p, 0.37), seed); }

/// Procedural surface detail from metric surface coordinates: an albedo factor, a roughness offset, a
/// tangent-space slope (bump) and a cavity term.
/// Fade of a pattern of spatial frequency f (cycles per metre) given the pixel footprint fw (m): patterns
/// finer than about two pixels are filtered out instead of aliasing into moire.
fn aaFade(f: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.2, 0.45, f * fw); }

fn surfaceDetail(kind: u32, strength: f32, uv: vec2f, fw: f32) -> Detail {
  var d: Detail;
  d.albedo = 1.0;
  d.rough = 0.0;
  d.bump = vec2f(0.0);
  d.ao = 1.0;
  // Broad grime: handling marks and dust, shared by every material that shows it.
  let grime = vnoise2(uv * 3.1, 11) * 0.6 + vnoise2(uv * 11.0, 12) * 0.4;
  switch (kind) {
    case 1u: { // paint: orange peel and soft wear
      d.bump = vec2f(gradientNoise3(vec3f(uv * 190.0, 1.5), 22), gradientNoise3(vec3f(uv * 190.0, 0.5), 21)) * 0.03 * strength * aaFade(190.0, fw);
      d.albedo = 1.0 - 0.12 * strength * smoothstep(0.55, 0.85, grime);
      d.rough = 0.08 * strength * (grime - 0.5);
    }
    case 2u: { // brushed metal: fine streaks along u
      let s = (vnoise2(vec2f(uv.x * 4.0, uv.y * 900.0), 31) - 0.5) * aaFade(900.0, fw);
      d.bump = vec2f(0.0, s) * 0.05 * strength;
      d.rough = 0.06 * s * strength;
      d.albedo = 1.0 - 0.06 * strength * smoothstep(0.6, 0.9, grime);
    }
    case 3u: { // quilted blanket: stitched diamond cells puffing between seams, fine weave
      let q = 1.0 / 0.07;
      let a = vec2f(uv.x + uv.y, uv.x - uv.y) * (q * 0.7071);
      let f = fract(a) - 0.5;
      let seam = min(0.5 - abs(f.x), 0.5 - abs(f.y));
      let puff = smoothstep(0.0, 0.1, seam);
      d.ao = mix(0.8, 1.0, puff);
      // Slope of the puffed quilt: toward the seams the surface dips a little.
      d.bump = vec2f(f.x + f.y, f.x - f.y) * (1.0 - puff) * 0.18 * strength;
      let weave = sin(uv.x * 2200.0) * sin(uv.y * 2200.0) * aaFade(350.0, fw);
      d.bump += vec2f(weave, -weave) * 0.03;
      d.albedo = (0.93 + 0.07 * puff) * (1.0 - 0.1 * smoothstep(0.6, 0.9, grime));
      // Stitch line: short dashes along each seam.
      let stitch = step(seam, 0.012) * step(0.5, fract((a.x + a.y) * 9.0));
      d.albedo *= 1.0 - 0.3 * stitch;
    }
    case 4u: { // woven fabric
      let k = aaFade(240.0, fw);
      let w = sin(uv.x * 1500.0) * sin(uv.y * 1500.0) * k;
      d.bump = vec2f(cos(uv.x * 1500.0), cos(uv.y * 1500.0)) * 0.08 * strength * k;
      d.albedo = 0.95 + 0.05 * w - 0.1 * smoothstep(0.65, 0.95, grime);
    }
    case 5u: { // webbing: herringbone along the strap
      let k = aaFade(260.0, fw);
      let w = fract(uv.x * 260.0 + abs(fract(uv.y * 50.0) - 0.5) * 2.0);
      d.bump = vec2f(w - 0.5, 0.0) * 0.12 * strength * k;
      d.albedo = 0.9 + 0.1 * mix(0.5, w, k);
    }
    case 6u: { // velcro loops: dense random fuzz
      let f = mix(0.5, vnoise2(uv * 900.0, 61), aaFade(900.0, fw));
      d.bump = vec2f(f - 0.5, vnoise2(uv * 900.0, 62) - 0.5) * 0.3 * strength * aaFade(900.0, fw);
      d.albedo = 0.85 + 0.25 * f;
      d.ao = 0.8 + 0.2 * f;
    }
    case 7u: { // ribbed duct: ribs along the tube
      let r = sin(uv.x * 260.0) * aaFade(41.0, fw);
      d.bump = vec2f(r * 0.35 * strength, 0.0);
      d.ao = 0.85 + 0.15 * r;
    }
    case 8u: { // knurled grip
      let k = sin((uv.x + uv.y) * 1800.0) * sin((uv.x - uv.y) * 1800.0) * aaFade(400.0, fw);
      d.bump = vec2f(k, -k) * 0.2 * strength;
      d.rough = 0.1;
    }
    case 9u: { // rubber / plastic: soft grain
      d.bump = vec2f(gradientNoise3(vec3f(uv * 400.0, 2.0), 91), gradientNoise3(vec3f(uv * 400.0, 3.0), 92)) * 0.04 * strength;
      d.rough = 0.05 * strength * (grime - 0.5);
    }
    case 10u: { // cast / anodised: fine grain
      d.bump = vec2f(gradientNoise3(vec3f(uv * 700.0, 4.0), 93), gradientNoise3(vec3f(uv * 700.0, 5.0), 94)) * 0.025 * strength;
    }
    default: {}
  }
  return d;
}

/// Depth pre-pass: the shading pass then runs once per visible pixel (depth test 'equal', no overdraw).
@fragment fn fsDepth() -> GBufferOut {
  var o: GBufferOut;
  return o;
}

@fragment fn fs(in: VOut) -> GBufferOut {
  let mat = materials[in.misc.x];
  let shading = u32(mat.b.y + 0.5);
  var albedo = mat.a.rgb;
  var roughness = mat.a.w;
  var metallic = mat.b.x;
  let fw = max(length(dpdx(in.uv0)), length(dpdy(in.uv0)));
  let det = surfaceDetail(u32(mat.c.x + 0.5), mat.c.y, in.uv0, fw);
  albedo *= det.albedo;
  roughness = clamp(roughness + det.rough, 0.04, 1.0);
  let bakedAo = (f32(in.misc.y) / 255.0) * det.ao;

  var N = normalize(in.n);
  let viewDir = normalize(-in.world);
  // Two-sided: the vertex normal is flipped when it lies on the far side of the visible face.
  var faceN = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(faceN, viewDir) < 0.0) { faceN = -faceN; }
  if (dot(N, faceN) < 0.0) { N = -N; }
  var T = in.t.xyz - N * dot(in.t.xyz, N);
  T = select(normalize(T), tangentFrame(N)[0], dot(T, T) < 1e-8);
  let B = cross(N, T) * in.t.w;
  let n = normalize(N + T * det.bump.x + B * det.bump.y);

  // Labels: ink from the atlas over the face material.
  var emissive = vec3f(0.0);
  let flags = in.misc.z;
  var ink = 0.0;
  let uvDx = dpdx(in.uv1);
  let uvDy = dpdy(in.uv1);
  if ((flags & FLAG_LABEL) != 0u) {
    ink = textureSampleGrad(labelAtlas, linearClamp, in.uv1, uvDx, uvDy).r;
    let inkColor = LABEL_COLORS[min(in.misc.w, 5u)];
    if ((flags & FLAG_EMISSIVE) == 0u) {
      albedo = mix(albedo, inkColor, ink);
      roughness = mix(roughness, 0.55, ink);
      metallic *= 1.0 - ink;
      if ((flags & FLAG_BACKLIT) != 0u) { emissive += cabin.legend.rgb * ink; }
    }
  }

  // Emitters: lamp lenses (legend brighter than the lens field), seven-segment segments, floodlight diffusers.
  if ((flags & FLAG_EMISSIVE) != 0u && in.ctl.x > 0u) {
    let C = controls[in.ctl.x - 1u];
    var lit = C.emit.w;
    if ((flags & FLAG_SEGMENT) != 0u) {
      let mask = bitcast<u32>(C.offset.w);
      lit = f32((mask >> in.ctl.y) & 1u) * C.emit.w;
    }
    let legend = select(1.0, 0.3 + 0.7 * ink, (flags & FLAG_LABEL) != 0u);
    emissive += C.emit.rgb * lit * legend;
    if ((flags & FLAG_LABEL) != 0u) {
      // Unlit legend: light grey lettering on the dark lens.
      albedo = mix(albedo, vec3f(0.35), ink * (1.0 - lit));
    }
  }

  // Cabin light (everything but the sun): emitted term, so it reaches no pixel outside the cabin.
  let amb = cabinAmbient();
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let cl = cabinLight(in.world, n, viewDir, roughness, f0, amb);
  let diffuseColor = albedo * (1.0 - metallic);
  let ambientSpec = amb.uniformE * (f0 * 0.5 + 0.02) * (1.0 - roughness) / PI;
  emissive += diffuseColor * (cl.diffuse + amb.uniformE * bakedAo) / PI + (cl.specular + ambientSpec) * bakedAo;

  // Specular anti-aliasing (Kaplanyan-Hill) on the perturbed normal.
  let du = dpdx(n);
  let dv = dpdy(n);
  let kernel = min(2.0 * 0.25 * (dot(du, du) + dot(dv, dv)), 0.18);
  let a = roughness * roughness;
  roughness = sqrt(sqrt(saturate(a * a + kernel)));

  let materialId = select(MATERIAL_STANDARD, MATERIAL_CLOTH, shading == 1u);
  let param = select(0.0, mat.c.z, shading == 1u);
  var o = gbufferPack(albedo, 0.0, n, roughness, metallic, materialId, param,
                      velocityFromClip(in.currClip, in.prevClip), emissive * frame.exposure.x);
  if (materialId == MATERIAL_STANDARD) {
    let Ta = normalize(T - n * dot(T, n));
    o.extra = gbufferExtra(n, Ta, mat.b.z, mat.b.w, 0.08);
  }
  return o;
}
`;

/** Depth pre-pass entry of INTERIOR_WGSL: no colour is written (every target's write mask is 0). */
export const INTERIOR_DEPTH_ENTRY = 'fsDepth';

/** Depth-only shadow caster: the same vertices with the animated controls. */
export const SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
struct CabinXf { m0: vec4f, m1: vec4f, m2: vec4f }
struct Control { pivot: vec4f, rot: vec4f, offset: vec4f, prevRot: vec4f, prevOffset: vec4f, emit: vec4f }
@group(2) @binding(0) var<uniform> xf: CabinXf;
@group(2) @binding(1) var<storage, read> controls: array<Control>;
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
@vertex fn vs(@location(0) pos: vec3f, @location(6) ctl: vec2u) -> @builtin(position) vec4f {
  var p = pos;
  if (ctl.x > 0u) {
    let C = controls[ctl.x - 1u];
    p = C.pivot.xyz + qrot(C.rot, pos - C.pivot.xyz) + C.offset.xyz;
  }
  let w = vec3f(dot(xf.m0.xyz, p) + xf.m0.w, dot(xf.m1.xyz, p) + xf.m1.w, dot(xf.m2.xyz, p) + xf.m2.w);
  return shadowPass.viewProj * vec4f(w, 1.0);
}
`;

/** Displays: the MFD images as emitters behind glass (MATERIAL_ID.display), with the RGB stripe structure up close. */
export const DISPLAY_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}

struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f, @location(3) layer: f32 }
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) currClip: vec4f,
  @location(3) prevClip: vec4f,
  @location(4) n: vec3f,
}
@vertex fn vs(v: VIn) -> VOut {
  let w = toRoot(cabin.m0, cabin.m1, cabin.m2, v.pos);
  let wp = toRoot(cabin.q0, cabin.q1, cabin.q2, v.pos);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(w, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(w, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(wp, 1.0);
  o.uv = v.uv;
  o.layer = u32(v.layer + 0.5);
  o.n = dirRoot(v.nrm);
  return o;
}

@fragment fn fs(in: VOut) -> GBufferOut {
  let size = vec2f(textureDimensions(mfdTex));
  var img = textureSample(mfdTex, anisoRepeat, in.uv, in.layer).rgb;
  // Pixel structure: when one display pixel covers several screen pixels the R, G and B stripes and the
  // black matrix between them resolve (energy preserving: each stripe carries three times its channel).
  let texelPx = 1.0 / max(max(length(dpdx(in.uv * size)), length(dpdy(in.uv * size))), 1e-6);
  let k = smoothstep(2.5, 6.0, texelPx) * cabin.display.w;
  let exact = textureSampleLevel(mfdTex, nearestClamp, (floor(in.uv * size) + 0.5) / size, in.layer, 0.0).rgb;
  if (k > 0.0) {
    let cell = fract(in.uv * size);
    let stripe = floor(cell.x * 3.0);
    let inStripe = fract(cell.x * 3.0);
    let matrix = smoothstep(0.0, 0.12, inStripe) * smoothstep(1.0, 0.88, inStripe) * smoothstep(0.0, 0.08, cell.y) * smoothstep(1.0, 0.92, cell.y);
    let mask = vec3f(f32(stripe == 0.0), f32(stripe == 1.0), f32(stripe == 2.0)) * 3.0 * matrix / 0.66;
    img = mix(img, exact * mask, k);
  }
  let amb = cabinAmbient();
  let n = normalize(in.n);
  return gbufferPack(vec3f(0.012, 0.013, 0.015), 0.0, n, 0.16, 0.0, MATERIAL_DISPLAY, amb.brightness,
                     velocityFromClip(in.currClip, in.prevClip), img * (cabin.display.x * frame.exposure.x));
}
`;

/** Navball instrument ball: the shared 'ui.navball' image on a dome, lit by the cabin plus its integral lamps. */
export const BALL_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}

struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f }
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) currClip: vec4f,
  @location(4) prevClip: vec4f,
}
@vertex fn vs(v: VIn) -> VOut {
  let w = toRoot(cabin.m0, cabin.m1, cabin.m2, v.pos);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(w, 1.0);
  o.currClip = frame.viewProjUnjittered * vec4f(w, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(toRoot(cabin.q0, cabin.q1, cabin.q2, v.pos), 1.0);
  o.world = w;
  o.n = dirRoot(v.nrm);
  o.uv = v.uv;
  return o;
}
fn srgbToLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
@fragment fn fs(in: VOut) -> GBufferOut {
  let t = textureSample(navballTex, linearClamp, in.uv);
  // Premultiplied sRGB image: un-premultiply, decode; outside the ball the cavity is black.
  let c = select(vec3f(0.0), srgbToLinear(min(t.rgb / max(t.a, 1e-3), vec3f(1.0))), t.a > 0.004);
  let albedo = c * t.a * 0.85;
  let n = normalize(in.n);
  let v = normalize(-in.world);
  let amb = cabinAmbient();
  let cl = cabinLight(in.world, n, v, 0.35, vec3f(0.04), amb);
  let emissive = albedo * (cl.diffuse + amb.uniformE) / PI + cl.specular + albedo * cabin.atmo.z;
  return gbufferPack(albedo, 0.0, n, 0.38, 0.0, MATERIAL_STANDARD, 0.0, velocityFromClip(in.currClip, in.prevClip), emissive * frame.exposure.x);
}
`;

/**
 * Window and cover glass in the transparent pass. Two draws per pane: a multiplicative one for the
 * transmittance (tint and Fresnel loss on everything behind the glass) and an additive one for what the
 * glass sends to the eye (reflection of the cabin or of the outside, dust and scratches lit by the sun).
 */
export const GLASS_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}

struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f, @location(3) info: vec2f }
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) info: vec2f,
}
@vertex fn vs(v: VIn) -> VOut {
  let w = toRoot(cabin.m0, cabin.m1, cabin.m2, v.pos);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.n = normalize(dirRoot(v.nrm));
  o.uv = v.uv;
  o.info = v.info;
  return o;
}

fn fresnelDielectric(cosi: f32, eta: f32) -> f32 {
  let c = clamp(cosi, 0.0, 1.0);
  let s2 = 1.0 - c * c;
  let t2 = 1.0 - s2 / (eta * eta);
  if (t2 <= 0.0) { return 1.0; }
  let ct = sqrt(t2);
  let rs = (c - eta * ct) / (c + eta * ct);
  let rp = (eta * c - ct) / (eta * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

/// What the cabin looks like along a ray from the glass: the displays, floodlights and sun patches where the
/// ray hits them (real images of the screens), the uniform cabin luminance otherwise.
fn cabinRadianceAlong(o: vec3f, d: vec3f, amb: CabinAmbient) -> vec3f {
  var L = amb.uniformE * cabin.bounce.w / PI * 1.6;
  var best = 1e9;
  for (var i = 0u; i < cabin.counts.x; i++) {
    let P = cabin.polys[i];
    let kind = u32(P.p0.w);
    if ((kind != POLY_DISPLAY && kind != POLY_FLOOD && kind != POLY_PATCH) || P.normal.w < 0.5) { continue; }
    let nn = P.normal.xyz;
    let den = dot(d, nn);
    if (den >= -1e-4) { continue; }
    let t = dot(P.p0.xyz - o, nn) / den;
    if (t <= 0.0 || t > best) { continue; }
    let h = o + d * t;
    let e1 = P.p1.xyz - P.p0.xyz;
    let e3 = P.p3.xyz - P.p0.xyz;
    let s = dot(h - P.p0.xyz, e1) / dot(e1, e1);
    let r = dot(h - P.p0.xyz, e3) / dot(e3, e3);
    if (s < 0.0 || s > 1.0 || r < 0.0 || r > 1.0) { continue; }
    best = t;
    if (kind == POLY_DISPLAY) {
      L = textureSampleLevel(mfdTex, linearClamp, vec2f(s, 1.0 - r), u32(P.p1.w), 1.5).rgb * cabin.display.x * amb.brightness;
    } else if (kind == POLY_PATCH) {
      L = P.radiance.rgb * amb.sunT;
    } else {
      L = P.radiance.rgb;
    }
  }
  return L;
}

/// Dust specks, smudges and fine scratches of the cabin-side surface (coverage 0..1), uv in metres.
fn grime(uv: vec2f) -> f32 {
  let cell = floor(uv * 260.0);
  let h = hash_to_unit(hash4(i32(cell.x), i32(cell.y), 7, 41));
  let f = fract(uv * 260.0) - 0.5;
  let speck = step(h, 0.06 * cabin.misc.y) * smoothstep(0.32, 0.12, length(f));
  let smudge = smoothstep(0.62, 0.9, valueNoise3(vec3f(uv * 7.0, 1.0), 42)) * 0.25;
  // Scratches: short straight lines in random cells and directions.
  let sc = floor(uv * 40.0);
  let hs = hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 43));
  let ang = hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 44)) * PI;
  let q = fract(uv * 40.0) - 0.5;
  let along = dot(q, vec2f(cos(ang), sin(ang)));
  let across = dot(q, vec2f(-sin(ang), cos(ang)));
  let scratch = step(hs, cabin.misc.z * 0.5) * smoothstep(0.02, 0.0, abs(across)) * step(abs(along), 0.35);
  return clamp(speck * 0.5 + smudge * cabin.misc.y + scratch * 0.4, 0.0, 1.0);
}

struct GlassOut { transmit: vec3f, add: vec3f }

fn glass(in: VOut) -> GlassOut {
  let n = normalize(in.n);              // points into the cabin
  let v = normalize(-in.world);
  let fromInside = dot(v, n) > 0.0;
  let nv = select(-n, n, fromInside);
  let cosv = abs(dot(v, n));
  let F = fresnelDielectric(cosv, cabin.misc.w);
  // One pane, two surfaces: reflectance about 2F, transmittance (1 - F)^2 x tint (normalised to normal incidence).
  let F0 = sq((cabin.misc.w - 1.0) / (cabin.misc.w + 1.0));
  let T = cabin.tint.rgb * sq((1.0 - F) / (1.0 - F0));
  let r = reflect(-v, nv);
  let amb = cabinAmbient();
  var refl: vec3f;
  if (fromInside) {
    refl = cabinRadianceAlong(in.world + nv * 0.002, r, amb);
  } else {
    refl = textureSampleLevel(envProbeCube, linearClamp, r, 0.0).rgb;
  }
  // info.y: reflectance factor of the pane (anti-reflection coated display cover glass about 1/8).
  var add = refl * (2.0 * F * in.info.y);
  // Dust and scratches on the cabin side light up when the sun shines through at a grazing angle.
  let sunN = dot(frame.sunDir.xyz, -n);
  if (sunN > 0.0 && cabin.sun.w > 0.0) {
    let lit = sampleSunShadow(in.world - n * 0.03, -n, vec2u(in.clip.xy));
    let g = grime(in.uv) * lit;
    let cosTh = dot(-v, frame.sunDir.xyz);
    let hg = (1.0 - 0.49) / pow(1.0 + 0.49 - 1.4 * cosTh, 1.5) / (4.0 * PI);
    let grazing = 1.0 / max(sunN, 0.15);
    add += cabin.sun.w * cabin.sunColor.rgb * amb.sunT * g * hg * grazing * 0.004;
  }
  var o: GlassOut;
  o.transmit = T;
  o.add = add;
  return o;
}

@fragment fn fsMultiply(in: VOut) -> @location(0) vec4f {
  let g = glass(in);
  let uv = in.clip.xy * frame.renderSize.zw;
  let c = applyAtmosphere(uv, length(in.world), vec3f(0.0), 1.0);
  // Behind a cloud or deep in haze the glass's effect fades like everything else.
  return vec4f(mix(vec3f(1.0), g.transmit, c.a), 1.0);
}
@fragment fn fsAdd(in: VOut) -> @location(0) vec4f {
  let g = glass(in);
  let uv = in.clip.xy * frame.renderSize.zw;
  let c = applyAtmosphere(uv, length(in.world), g.add * frame.exposure.x, 0.0);
  return vec4f(writeHdr(c.rgb), 0.0);
}
`;

/** g-induced tunnel vision: peripheral dimming in the LDR overlay (premultiplied black). */
export const TUNNEL_WGSL = /* wgsl */ `
#include "noise"
struct Tunnel { v: vec4f }   // x = strength 0..1, y = aspect, z = max darkening
@group(1) @binding(0) var<uniform> tunnel: Tunnel;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let p = (in.uv - 0.5) * vec2f(tunnel.v.y, 1.0) * 2.0;
  let r = length(p);
  let s = tunnel.v.x;
  // The field narrows from the periphery inward as the retina loses perfusion.
  let inner = mix(1.6, 0.25, s);
  let outer = inner + mix(0.9, 0.55, s);
  let a = smoothstep(inner, outer, r) * tunnel.v.z * smoothstep(0.0, 0.25, s) + 0.18 * s * s;
  let n = interleavedGradientNoise(in.position.xy) / 255.0;
  return vec4f(0.0, 0.0, 0.0, saturate(a + n));
}
`;
