/**
 * WGSL of the cockpit feature. The chunk "cockpit_cabin" holds the per-frame cabin uniforms and the light
 * transport inside the cabin; the pipelines below include it.
 *
 * Interior light (docs/handoff/cockpit.md, section "Light"). Every interior pixel is lit here and written
 * as emission; the G-buffer gets ambient occlusion 0, and the core's sun never reaches the cabin because
 * the window openings are closed in the core's cascades (feature.ts, drawShadow):
 *  - the sun: the core's BRDFs (brdfStandardDirect / brdfClothDirect) times the cabin's own sun shadow map
 *    (sunmap.ts: the interior and the window wells through the wall, 2 mm texels, vessel-fixed), filtered
 *    with a blocker search and a fixed Poisson PCF whose radius follows the blocker distance and the true
 *    solar diameter, so a patch edge has its physical penumbra and no noise;
 *  - every other source is a Lambertian polygon evaluated per pixel with the vector form factor (Lambert's
 *    polygon formula), times the vertex's baked visibility of that source (occlusion.ts): the windows
 *    (radiance = what the environment probe sees through them, plus the reentry shock layer), the sun
 *    patches (the window outlines projected onto the surface the sun hits, glowing with their reflected
 *    sunlight; occluded by the vertex's ambient occlusion), the flood light diffusers and the three
 *    displays (mean luminance of their current image from the last mip);
 *  - the inter-reflection of all that light is an integrating-sphere term rho / (S (1 - rho)) x flux,
 *    times the ambient occlusion;
 *  - glossy surfaces add a representative-point GGX lobe for the windows and floodlights.
 *
 * Bind group 1 of every pipeline except the shadow casters (see CABIN_DECLS): 0 cabin uniform, 1 controls,
 * 2 materials, 3 label atlas, 4 MFD array, 5 navball image, 6 ambient pass output, 7 cabin sun map,
 * 8 / 9 detail texture arrays, 10.. the scene sets env, atmosphereLuts, transparency.
 */
import { MAX_DISPLAYS, MAX_WINDOWS } from './layout';
import { MAX_CABIN_POLYS } from './lighting';

export const CONTROL_FLOATS = 24;
/** vec4s of the cabin uniform's header (CabinFrame in CABIN_CHUNK, before `polys`). */
export const CABIN_HEADER_VEC4 = 28 + 4 * MAX_WINDOWS;
export const CABIN_HEADER_FLOATS = 4 * CABIN_HEADER_VEC4;
export const CABIN_POLY_FLOATS = 4 * 6;
export const CABIN_UNIFORM_FLOATS = CABIN_HEADER_FLOATS + MAX_CABIN_POLYS * CABIN_POLY_FLOATS;
export const MAX_MATERIALS = 48;
export const MATERIAL_FLOATS = 20;

/** Header slots (vec4 index) of CabinFrame. */
export const CABIN = {
  m: 0,
  q: 3,
  sun: 6,
  sunColor: 7,
  atmo: 8,
  bounce: 9,
  legend: 10,
  plasma: 11,
  display: 12,
  counts: 13,
  sunU: 14,
  sunV: 15,
  sunL: 16,
  sunMap: 17,
  sunPart: 18,
  misc: 19,
  tint: 20,
  view: 21,
  glare: 22,
  ballOcc: 23,
  glassSun: 27,
  apertures: 28,
} as const;

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
@group(1) @binding(7) var cabinSunMap: texture_depth_2d;
@group(1) @binding(8) var detailN: texture_2d_array<f32>;
@group(1) @binding(9) var detailM: texture_2d_array<f32>;
fn cabinAmbient() -> CabinAmbient {
  var o: CabinAmbient;
  o.uniformE = cabinAmb[0].xyz;
  o.brightness = cabinAmb[0].w;
  o.sunT = cabinAmb[1].xyz;
  o.cloudT = cabinAmb[1].w;
  return o;
}
fn cabinPolyRadiance(i: u32) -> vec3f { return cabinAmb[2u + i].xyz; }
${scene}
`;

/** First binding of the scene sets in the cabin group (after the cabin's own bindings 0..9). */
export const CABIN_SCENE_BINDING = 10;

/**
 * One invocation per frame: the cabin quantities every pixel shares (uniform inter-reflection irradiance,
 * display brightness, the atmosphere's and the clouds' transmittance of the sun at the vessel), from the
 * environment probe, the displays' mean and the atmosphere tables. Group 1: cabin uniform, display array,
 * output, then the scene sets.
 */
export const AMBIENT_WGSL = (scene: string): string => /* wgsl */ `
#include "frame"
@group(1) @binding(0) var<uniform> cabin: CabinFrame;
@group(1) @binding(1) var mfdTex: texture_2d_array<f32>;
@group(1) @binding(2) var<storage, read_write> outAmb: array<vec4f, ${AMBIENT_VEC4S}>;
fn cabinPolyRadiance(i: u32) -> vec3f { return outAmb[2u + i].xyz; }
${scene}
#include "cockpit_cabin"

/// Cloud transmittance of the sun at the vessel (RENDER_API section 7: near optical-depth map around the
/// camera, coverage map beyond, both placed by the frame uniforms).
fn cabinCloudTransmittance() -> f32 {
  let bi = i32(cabin.sunColor.w);
  if (bi < 0) { return 1.0; }
  let b = frame.bodies[bi];
  let pos = vec3f(cabin.m0.w, cabin.m1.w, cabin.m2.w);
  let rel = pos - b.center.xyz;
  let r = length(rel);
  let up = rel / max(r, 1.0);
  let sunDir = b.sunDir.xyz;
  let muS = max(dot(up, sunDir), 0.05);
  var far = 1.0;
  if (i32(frame.cloudFar.x) == bi && r < frame.cloudFar.y) {
    let bq = dot(rel, sunDir);
    let t = -bq + sqrt(max(bq * bq - (r * r - frame.cloudFar.y * frame.cloudFar.y), 0.0));
    let d = normalize(rootToFixed(u32(bi), rel + sunDir * t));
    let lon = atan2(d.y, d.x) + frame.cloudFar.w;
    let uv = vec2f(fract(lon / TWO_PI + 0.5), acos(clamp(d.z, -1.0, 1.0)) / PI);
    far = exp(-textureSampleLevel(cloudCoverageMapTex, linearClamp, uv, 0.0).r * frame.cloudFar.z / muS);
  }
  let he = frame.cloudNear0.w;
  if (he > 0.0 && i32(frame.cloudNear1.w) == bi) {
    let q = vec2f(dot(pos - frame.cloudNear0.xyz, frame.cloudNear1.xyz), dot(pos - frame.cloudNear0.xyz, frame.cloudNear2.xyz)) / he;
    let edge = 1.0 - max(abs(q.x), abs(q.y));
    if (edge > 0.0) {
      let tau = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0).r * frame.cloudNear2.w;
      return mix(far, exp(-tau / muS), saturate(edge * 8.0));
    }
  }
  return far;
}

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
    let cloudT = cabinCloudTransmittance();
    var total = cabin.bounce.y * sunT * cloudT * cabin.sunColor.rgb + vec3f(cabin.bounce.z);
    for (var k = 0u; k < ${MAX_CABIN_POLYS}u; k++) { total += wFlux[k]; }
    // Display brightness follows the light the cabin receives (ambient sensor), never below the night floor.
    let eCabin = luminance(total) * cabin.bounce.x / max(cabin.bounce.w, 1e-3);
    let brightness = clamp(sqrt(eCabin / cabin.display.z), cabin.display.y, 1.0);
    outAmb[1] = vec4f(sunT, cloudT);
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

/** Common include block of the cabin modules: frame chunks, the declarations, the cabin chunk, the sun. */
const HEAD = (decls: string): string => `
#include "frame"
#include "gbuffer"
#include "noise"
#include "transparency"
${decls}
#include "cockpit_cabin"
${SUN_WGSL}
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
struct Material {
  a: vec4f,           // albedo (linear), roughness
  b: vec4f,           // metallic, shading (1 = cloth), anisotropy, clearcoat
  c: vec4f,           // procedural pattern (0 none, 1 quilt, 2 ribbed, 3 knurl), detail strength, translucency, detail layer + 1 (0 = none)
  d: vec4f,           // detail tile (m), edge wear 0..1, grime 0..1, part-to-part variation
  e: vec4f,           // colour under worn paint (linear), its metallic
}
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
  atmo: vec4f,                         // x = radius of the vessel from that body's centre (m), y = mu of the sun there, z = FDAI integral lighting (cd/m^2 at white), w = sun angular radius (rad)
  bounce: vec4f,                       // x = rho / (S (1 - rho)), y = rho x sun flux through the windows (lm, no atmosphere), z = lamp flux (lm), w = cabin albedo
  legend: vec4f,                       // rgb = back-lit legend luminance (cd/m^2), w = wall-clock time (s)
  plasma: vec4f,                       // rgb = shock-layer radiance seen through the windows (cd/m^2), w = plasma intensity
  display: vec4f,                      // x = display luminance at full brightness (cd/m^2), y = minimum brightness, z = full-brightness ambient (lux), w = screen px per texel where the pixel structure starts
  counts: vec4u,                       // x = polygons, y = windows (the first y polygons; also the apertures), z = displays, w = flags (bit 0 = camera inside the cabin)
  sunU: vec4f,                         // cabin sun map: u = dot(xyz, p_part) + w
  sunV: vec4f,                         //                v = dot(xyz, p_part) + w
  sunL: vec4f,                         //                depth = dot(xyz, p_part) + w (0 at the sun side .. 1)
  sunMap: vec4f,                       // x = texel (m), y = depth range (m), z = map size (texels), w = 1 when the sun lights the cabin this frame
  sunPart: vec4f,                      // xyz = unit direction to the sun (part frame), w = penumbra slope 2 tan(angular radius)
  misc: vec4f,                         // x = glass transmittance (mean), y = dust density, z = scratch density, w = pane ior
  tint: vec4f,                         // rgb = transmittance of one pane (tint and Fresnel at normal incidence)
  view: vec4f,                         // xyz = camera position in the part frame, w = 1 when the camera is inside the cabin
  glare: vec4f,                        // x = display cover glass reflectance (relative to bare glass), y = its anti-glare roughness, z = screen px per texel where the pixel structure is resolved, w = 0
  ballOcc: array<vec4f, 4>,            // the occlusion record (occlusion.ts) at the front of the attitude ball
  glassSun: vec4f,                     // rgb = the glazing's transmittance at normal incidence (all panes), w = panes
  apertures: array<vec4f, ${4 * MAX_WINDOWS}>,  // per window (WindowMeta.aperture): outer-end centre + half width, inward normal + half height, tangent + corner radius, generator + prism length
  polys: array<CabinPoly, ${MAX_CABIN_POLYS}>,
}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn toRoot(m0: vec4f, m1: vec4f, m2: vec4f, p: vec3f) -> vec3f { return vec3f(dot(m0.xyz, p) + m0.w, dot(m1.xyz, p) + m1.w, dot(m2.xyz, p) + m2.w); }
fn dirRoot(v: vec3f) -> vec3f { return vec3f(dot(cabin.m0.xyz, v), dot(cabin.m1.xyz, v), dot(cabin.m2.xyz, v)); }
/// ROOT direction -> part frame (the transpose of the rotation rows).
fn dirPart(v: vec3f) -> vec3f { return cabin.m0.xyz * v.x + cabin.m1.xyz * v.y + cabin.m2.xyz * v.z; }

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
  /// the atmosphere's and the clouds' transmittance of the sun at the vessel.
  uniformE: vec3f,
  brightness: f32,
  sunT: vec3f,
  cloudT: f32,
}

/// Baked visibility of the cabin's sources at a point (occlusion.ts): ambient, floods, each window, each display.
struct Occ {
  ao: f32,
  flood: f32,
  w: array<f32, ${MAX_WINDOWS}>,
  d: array<f32, ${MAX_DISPLAYS}>,
}
fn occUnpack(o0: vec4f, o1: vec4f, o2: vec4f, o3: vec4f) -> Occ {
  var o: Occ;
  o.ao = o0.x;
  o.flood = o0.y;
  o.w = array<f32, ${MAX_WINDOWS}>(o0.z, o0.w, o1.x, o1.y, o1.z, o1.w, o2.x, o2.y);
  o.d = array<f32, ${MAX_DISPLAYS}>(o2.z, o2.w, o3.x, o3.y);
  return o;
}

struct CabinLight {
  diffuse: vec3f,    // irradiance (lux) to be multiplied by albedo / pi
  specular: vec3f,   // reflected luminance (cd/m^2)
}

/// Light arriving at a cabin surface from every cabin polygon (pos camera-relative ROOT, unit n and v),
/// each source weighted by its baked visibility at the surface. sunScale = the atmosphere's and the
/// clouds' transmittance of the sun (the sun patches' radiance is given without them).
fn cabinLight(pos: vec3f, n: vec3f, v: vec3f, roughness: f32, f0: vec3f, occIn: Occ, sunScale: vec3f) -> CabinLight {
  var occ = occIn;
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
    var vis: f32;
    let index = u32(P.p1.w);
    if (kind == POLY_WINDOW) {
      vis = occ.w[min(index, ${MAX_WINDOWS - 1}u)];
    } else if (kind == POLY_DISPLAY) {
      vis = occ.d[min(index, ${MAX_DISPLAYS - 1}u)];
    } else if (kind == POLY_PATCH) {
      vis = occ.ao;
    } else {
      vis = occ.flood;
    }
    // A source this point cannot see (baked) costs nothing.
    if (vis <= 0.004) { continue; }
    let V = polyVector(pos, P.p0.xyz, P.p1.xyz, P.p2.xyz, P.p3.xyz);
    let lenV = length(V);
    if (lenV < 1e-7) { continue; }
    let ff = max(dot(n, V), 0.0);
    var L: vec3f;
    if (kind == POLY_WINDOW || kind == POLY_DISPLAY) {
      L = cabinPolyRadiance(i);
    } else if (kind == POLY_PATCH) {
      L = P.radiance.rgb * sunScale;
    } else {
      L = P.radiance.rgb;
    }
    let E = L * (PI * ff) * vis;
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

/**
 * The sun inside the cabin: the fraction of the solar disc seen through each window's aperture (exact
 * penumbra, analytic), times the cabin's own shadow map for the interior's occluders (needs cabinSunMap),
 * times the glazing's transmittance. Included by every cabin module after the declarations.
 */
const SUN_WGSL = /* wgsl */ `
/// Poisson disc (unit radius) of the shadow map's blocker search.
const SUN_TAPS = array<vec2f, 16>(
  vec2f(0.1036, -0.4339), vec2f(0.5183, -0.1975), vec2f(0.4122, 0.4402), vec2f(-0.0619, 0.6466), vec2f(-0.5683, 0.3426),
  vec2f(-0.6439, -0.2342), vec2f(-0.2706, -0.6466), vec2f(0.3075, -0.7004), vec2f(0.7428, 0.1121), vec2f(0.6311, 0.5862),
  vec2f(0.1729, 0.8396), vec2f(-0.4089, 0.7871), vec2f(-0.8282, 0.2391), vec2f(-0.8565, -0.3214), vec2f(-0.5321, -0.7957),
  vec2f(0.0247, -0.9442));

/// Sun-map coordinates (u, v, depth) of a part-frame point.
fn sunCoord(p: vec3f) -> vec3f {
  return vec3f(dot(cabin.sunU.xyz, p) + cabin.sunU.w, dot(cabin.sunV.xyz, p) + cabin.sunV.w, dot(cabin.sunL.xyz, p) + cabin.sunL.w);
}

/// Share of a disc cut off by a straight edge at signed distance x (in disc radii, + = the centre is past
/// the edge): the area of the part of the disc on the open side, over the disc's area.
fn discFraction(x: f32) -> f32 {
  let c = clamp(x, -1.0, 1.0);
  return (acos(c) - c * sqrt(1.0 - c * c)) / PI;
}

/// Fraction of the solar disc seen from p (part frame) through window i, and the cosine of the sun's
/// incidence on it. The window is a prism of the shared rounded rectangle along its inward normal, from the
/// outer mould line to the bezel's inner edge (WindowMeta.aperture): both ends clip the disc, each with the
/// disc's footprint there (radius = distance x tan(angular radius), stretched along the sun's direction by
/// 1 / cos of the incidence).
fn apertureVisibility(p: vec3f, i: u32) -> vec2f {
  let a0 = cabin.apertures[4u * i];
  let a1 = cabin.apertures[4u * i + 1u];
  let a2 = cabin.apertures[4u * i + 2u];
  let a3 = cabin.apertures[4u * i + 3u];
  let ls = cabin.sunPart.xyz;
  let n = a1.xyz;
  let cosI = -dot(ls, n);
  if (cosI <= 1e-3) { return vec2f(0.0); }
  let tanA = 0.5 * cabin.sunPart.w;
  let halfSize = vec2f(a0.w, a1.w);
  let rc = a2.w;
  let e = vec2f(dot(ls, a2.xyz), dot(ls, a3.xyz));
  let el = length(e);
  let e2 = select(vec2f(1.0, 0.0), e / max(el, 1e-6), el > 1e-6);
  var vis = 1.0;
  for (var k = 0u; k < 2u; k++) {
    let c = a0.xyz + n * select(0.0, a3.w, k == 1u);
    let dist = dot(p - c, n);
    if (dist <= 0.0) {
      // Outside the hull, no sun from this window; within the prism (the panes, the bezel's tunnel) only
      // the outer end clips the light.
      if (k == 0u) { return vec2f(0.0); }
      continue;
    }
    let t = dist / cosI;
    let h = p + ls * t - c;
    let uv = vec2f(dot(h, a2.xyz), dot(h, a3.xyz));
    let q = abs(uv) - (halfSize - vec2f(rc));
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rc;
    var grad = vec2f(0.0, sign(uv.y));
    if (q.x > 0.0 && q.y > 0.0) { grad = sign(uv) * normalize(q); } else if (q.x > q.y) { grad = vec2f(sign(uv.x), 0.0); }
    let r = t * tanA * length(vec2f(dot(grad, e2) / cosI, grad.x * e2.y - grad.y * e2.x));
    vis = min(vis, discFraction(d / max(r, 1e-5)));
  }
  return vec2f(vis, cosI);
}

/// The sun's light through the windows at p: the best window's disc fraction times its glazing's
/// transmittance (per channel; Fresnel at the incidence on every surface of every pane).
fn sunThroughWindows(p: vec3f) -> vec3f {
  var best = vec2f(0.0);
  for (var i = 0u; i < cabin.counts.y; i++) {
    let a = apertureVisibility(p, i);
    if (a.x > best.x) { best = a; }
  }
  if (best.x <= 0.0) { return vec3f(0.0); }
  let ior = cabin.misc.w;
  let f0 = sq((ior - 1.0) / (ior + 1.0));
  let fr = f0 + (1.0 - f0) * pow5(1.0 - best.y);
  return cabin.glassSun.rgb * pow((1.0 - fr) / (1.0 - f0), 2.0 * cabin.glassSun.w) * best.x;
}

/// Visibility of the sun past the interior's own occluders (the cabin sun map) at a part-frame point with
/// geometric normal ng (turned to the sun by the caller): 0 .. 1. sc and its screen derivatives (taken in
/// uniform control flow by the caller) give the receiver plane, so taps over a sloped receiver compare at
/// the receiver's own depth. PCSS: a blocker search, then a PCF whose radius follows the blocker distance.
fn sunMapVisibility(p: vec3f, ng: vec3f, NoL: f32, sc: vec3f, scdx: vec3f, scdy: vec3f) -> f32 {
  let texel = cabin.sunMap.x;
  let range = cabin.sunMap.y;
  let size = cabin.sunMap.z;
  let mPerUv = texel * size;
  let det = scdx.x * scdy.y - scdx.y * scdy.x;
  var dzduv = vec2f(0.0);
  if (abs(det) > 1e-14) { dzduv = vec2f(scdy.y * scdx.z - scdx.y * scdy.z, scdx.x * scdy.z - scdy.x * scdx.z) / det; }
  // Bounded: at grazing incidence a tap must not compare against a depth far off the receiver.
  let maxSlope = 12.0 * mPerUv / range;
  dzduv = clamp(dzduv, vec2f(-maxSlope), vec2f(maxSlope));
  let sinL = sqrt(max(1.0 - NoL * NoL, 0.0));
  // Normal offset (part frame) and constant bias grow toward grazing incidence, where a texel spans more depth.
  let q = sunCoord(p + ng * texel * (0.5 + 3.0 * sinL));
  let bias = (1.5 + 2.0 * sinL) * texel / range;
  // Blocker search over the widest penumbra a cabin-sized blocker distance gives (3 m).
  let slope = cabin.sunPart.w;
  let searchUv = max(3.0 * slope, 3.0 * texel) / mPerUv;
  var zBlock = 0.0;
  var nBlock = 0.0;
  for (var k = 0u; k < 16u; k++) {
    let o = SUN_TAPS[k] * searchUv;
    let zr = q.z + dot(o, dzduv) - bias;
    let d4 = textureGather(cabinSunMap, nearestClamp, q.xy + o);
    let m = select(vec4f(0.0), vec4f(1.0), d4 < vec4f(zr));
    nBlock += m.x + m.y + m.z + m.w;
    zBlock += dot(d4, m);
  }
  if (nBlock < 0.5) { return 1.0; }
  zBlock /= nBlock;
  // Penumbra radius in texels (blocker distance x solar diameter), filtered by a fixed 8 x 8 grid of
  // bilinear comparisons no more than a texel apart: smooth, with neither noise nor banding. The grid
  // reaches 4 texels (8 mm), the penumbra of a blocker 0.9 m away; farther interior blockers keep 8 mm.
  let penTexels = clamp((q.z - zBlock) * range * slope / texel, 1.0, 4.0);
  let stepUv = (penTexels / 4.0) / size;
  var lit = 0.0;
  for (var j = 0; j < 8; j++) {
    for (var i = 0; i < 8; i++) {
      let o = (vec2f(f32(i), f32(j)) - 3.5) * stepUv;
      lit += textureSampleCompareLevel(cabinSunMap, shadowCompare, q.xy + o, q.z + dot(o, dzduv) - bias);
    }
  }
  return lit / 64.0;
}

/// The sun at a part-frame point of a cabin surface with geometric normal ngIn (part frame): rgb
/// transmittance of windows, glazing and interior occluders. Cloth (two-sided) uses the normal turned to
/// the sun.
fn cabinSun(p: vec3f, ngIn: vec3f, twoSided: bool, sc: vec3f, scdx: vec3f, scdy: vec3f) -> vec3f {
  if (cabin.sunMap.w < 0.5) { return vec3f(0.0); }
  let ls = cabin.sunPart.xyz;
  var ng = ngIn;
  if (twoSided && dot(ng, ls) < 0.0) { ng = -ng; }
  let NoL = dot(ng, ls);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let through = sunThroughWindows(p);
  if (max(through.r, max(through.g, through.b)) <= 0.0) { return vec3f(0.0); }
  return through * sunMapVisibility(p, ng, NoL, sc, scdx, scdy);
}

/// Sun illuminance (lux, rgb) at the vessel through the atmosphere and the clouds (before the windows).
fn cabinSunIlluminance(amb: CabinAmbient) -> vec3f {
  return cabin.sun.w * cabin.sunColor.rgb * amb.sunT * amb.cloudT;
}
`;

/** Interior G-buffer: animated controls, textured surface detail, labels, emitters, the sun, cabin light. */
export const INTERIOR_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}

const FLAG_LABEL = 1u;
const FLAG_EDGE = 2u;
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
  @location(7) occ0: vec4f,
  @location(8) occ1: vec4f,
  @location(9) occ2: vec4f,
  @location(10) occ3: vec4f,
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
  @location(9) part: vec3f,
  @location(10) occ0: vec4f,
  @location(11) occ1: vec4f,
  @location(12) occ2: vec4f,
  @location(13) occ3: vec4f,
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
  o.part = p;
  o.occ0 = v.occ0;
  o.occ1 = v.occ1;
  o.occ2 = v.occ2;
  o.occ3 = v.occ3;
  return o;
}

// ------------------------------------------------------------------------------------------- detail
struct Detail { albedo: f32, rough: f32, slope: vec2f, cavity: f32, wear: f32, grime: f32 }

fn partHash(seed: u32, k: i32) -> f32 { return hash_to_unit(hash4(i32(seed), k, 71, 19)); }
/// Fade of a pattern of spatial frequency f (cycles per metre) given the pixel footprint fw (m): patterns
/// finer than about two pixels are filtered out instead of aliasing into moire.
fn aaFade(f: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.2, 0.45, f * fw); }

/// Surface detail of a material at metric surface coordinates uv: the baked detail textures (tone, gloss,
/// normal, cavity, wear and grime masks) with a per-part phase, tone and gloss, plus the procedural patterns
/// that follow the geometry (quilting, duct ribs, knurling).
fn materialDetail(mat: Material, uv: vec2f, dx: vec2f, dy: vec2f, fw: f32, seed: u32, edge: bool) -> Detail {
  var d: Detail;
  let strength = mat.c.y;
  let variation = mat.d.w;
  d.albedo = 1.0 + (partHash(seed, 0) - 0.5) * variation;
  d.rough = (partHash(seed, 1) - 0.5) * variation;
  d.slope = vec2f(0.0);
  d.cavity = 1.0;
  d.wear = 0.0;
  d.grime = 0.0;
  let layer = i32(mat.c.w + 0.5) - 1;
  if (layer >= 0) {
    let tile = mat.d.x;
    let shift = vec2f(partHash(seed, 2), partHash(seed, 3));
    let t = uv / tile + shift;
    // Trilinear: the detail is fine and low in contrast, anisotropic filtering would cost more than it shows.
    let tN = textureSampleGrad(detailN, linearRepeat, t, layer, dx / tile, dy / tile);
    let tM = textureSampleGrad(detailM, linearRepeat, t, layer, dx / tile, dy / tile);
    d.slope = (tN.xy * 2.0 - 1.0) * strength;
    d.cavity = mix(1.0, tN.z, strength);
    d.albedo *= mix(1.0, tM.r * 2.0, strength);
    d.rough += (tM.g - 0.5) * strength;
    // Paint wears through on edges where the wear mask is highest; mat.d.y is how much of the edge goes.
    d.wear = select(0.0, smoothstep(1.0 - mat.d.y, 1.0 - mat.d.y + 0.15, tM.b), edge && mat.d.y > 0.0);
    d.grime = tM.a;
  }
  switch (u32(mat.c.x + 0.5)) {
    case 1u: { // quilted blanket: stitched diamond cells, each bay sewn a little differently
      let cell = mix(0.062, 0.08, partHash(seed, 4));
      let ang = (partHash(seed, 5) - 0.5) * 0.16;
      let cs = cos(ang);
      let sn = sin(ang);
      var q = vec2f(cs * uv.x - sn * uv.y, sn * uv.x + cs * uv.y) / cell + vec2f(partHash(seed, 6), partHash(seed, 7));
      // Hand-sewn seams wander.
      q += vec2f(valueNoise3(vec3f(uv * 6.0, 0.3), 31) - 0.5, valueNoise3(vec3f(uv * 6.0, 0.7), 32) - 0.5) * 0.18;
      let a = vec2f(q.x + q.y, q.x - q.y) * 0.7071;
      let f = fract(a) - 0.5;
      let id = floor(a);
      let seam = min(0.5 - abs(f.x), 0.5 - abs(f.y));
      // Each cell puffs by its own amount (filling settles unevenly).
      let fill = mix(0.55, 1.25, hash_to_unit(hash4(i32(id.x), i32(id.y), i32(seed), 33)));
      let puff = smoothstep(0.0, 0.11 * fill, seam);
      d.cavity *= mix(0.7, 1.0, puff);
      d.slope += vec2f(f.x + f.y, f.x - f.y) * (1.0 - puff) * 0.22 * strength * fill;
      d.albedo *= 0.94 + 0.06 * puff;
      let stitch = step(seam, 0.013) * step(0.45, fract((a.x + a.y) * 9.0)) * aaFade(140.0 / cell, fw);
      d.albedo *= 1.0 - 0.28 * stitch;
      d.grime = max(d.grime, (1.0 - puff) * 0.6);
    }
    case 2u: { // ribbed duct: ribs along the tube
      let r = sin(uv.x * 260.0) * aaFade(41.0, fw);
      d.slope += vec2f(r * 0.35 * strength, 0.0);
      d.cavity *= 0.85 + 0.15 * r;
    }
    case 3u: { // knurled grip
      let k = sin((uv.x + uv.y) * 1800.0) * sin((uv.x - uv.y) * 1800.0) * aaFade(400.0, fw);
      d.slope += vec2f(k, -k) * 0.2 * strength;
      d.rough += 0.1;
      d.cavity *= 0.9 + 0.1 * k;
    }
    default: {}
  }
  return d;
}

/// Depth pre-pass: the shading pass then runs once per visible pixel (depth test 'equal', no overdraw). Its
/// vertex shader reads only the position and the control (the same expressions as vs, both invariant).
struct VDepth { @invariant @builtin(position) clip: vec4f }
@vertex fn vsDepth(@location(0) pos: vec3f, @location(6) ctl: vec2u) -> VDepth {
  var p = pos;
  if (ctl.x > 0u) {
    let C = controls[ctl.x - 1u];
    p = C.pivot.xyz + qrot(C.rot, pos - C.pivot.xyz) + C.offset.xyz;
  }
  var o: VDepth;
  o.clip = frame.viewProj * vec4f(toRoot(cabin.m0, cabin.m1, cabin.m2, p), 1.0);
  return o;
}
@fragment fn fsDepth() -> GBufferOut {
  var o: GBufferOut;
  return o;
}

/// Shade an interior fragment. decal: a label drawn over its face after the interior, blended by its ink
/// (RT0 and RT5 only), so the face underneath shows through unchanged where there is no ink.
fn shade(in: VOut, decal: bool) -> GBufferOut {
  let mat = materials[in.misc.x];
  let shading = u32(mat.b.y + 0.5);
  let flags = in.misc.z;
  let isLabel = (flags & FLAG_LABEL) != 0u;
  // Screen derivatives in uniform control flow: detail filtering, label filtering, the sun map's receiver plane.
  let duvx = dpdx(in.uv0);
  let duvy = dpdy(in.uv0);
  let fw = max(length(duvx), length(duvy));
  let uvDx = dpdx(in.uv1);
  let uvDy = dpdy(in.uv1);
  let sc = sunCoord(in.part);
  let scdx = dpdx(sc);
  let scdy = dpdy(sc);
  let faceRaw = cross(dpdx(in.world), dpdy(in.world));

  let seed = select(in.misc.w, 0u, isLabel);
  let det = materialDetail(mat, in.uv0, duvx, duvy, fw, seed, (flags & FLAG_EDGE) != 0u);
  var occ = occUnpack(in.occ0, in.occ1, in.occ2, in.occ3);
  // Modelled cavity (vertex) and texture cavity darken the cabin's ambient light only.
  let cavity = (f32(in.misc.y) / 255.0) * det.cavity;

  var albedo = mat.a.rgb * det.albedo;
  var roughness = clamp(mat.a.w + det.rough, 0.04, 1.0);
  var metallic = mat.b.x;
  // Worn edges show what is under the paint.
  albedo = mix(albedo, mat.e.rgb, det.wear);
  metallic = mix(metallic, mat.e.w, det.wear);
  roughness = mix(roughness, 0.32, det.wear);
  // Grime settles where little light and few hands reach: cavities and occluded corners.
  let grime = saturate(det.grime * mat.d.z * (1.6 - occ.ao - 0.6 * cavity));
  albedo *= 1.0 - 0.45 * grime;
  roughness = mix(roughness, 0.85, grime * 0.5);

  var N = normalize(in.n);
  let viewDir = normalize(-in.world);
  // Two-sided: the vertex normal is flipped when it lies on the far side of the visible face.
  var faceN = normalize(faceRaw);
  if (dot(faceN, viewDir) < 0.0) { faceN = -faceN; }
  if (dot(N, faceN) < 0.0) { N = -N; }
  var T = in.t.xyz - N * dot(in.t.xyz, N);
  T = select(normalize(T), tangentFrame(N)[0], dot(T, T) < 1e-8);
  let B = cross(N, T) * in.t.w;
  let n = normalize(N + T * det.slope.x + B * det.slope.y);

  // Labels: ink from the atlas over the face material.
  var emissive = vec3f(0.0);
  var ink = 0.0;
  if (isLabel) {
    ink = textureSampleGrad(labelAtlas, linearClamp, in.uv1, uvDx, uvDy).r;
    let inkColor = LABEL_COLORS[min(in.misc.w, 5u)];
    if ((flags & FLAG_EMISSIVE) == 0u) {
      // A decal is the ink alone (its coverage blends it over the face); otherwise ink over the face.
      let cover = select(ink, 1.0, decal);
      albedo = mix(albedo, inkColor, cover);
      roughness = mix(roughness, 0.55, cover);
      metallic *= 1.0 - cover;
      if ((flags & FLAG_BACKLIT) != 0u) { emissive += cabin.legend.rgb * cover; }
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
    let legend = select(1.0, 0.3 + 0.7 * ink, isLabel);
    emissive += C.emit.rgb * lit * legend;
    if (isLabel) {
      // Unlit legend: light grey lettering on the dark lens.
      albedo = mix(albedo, vec3f(0.35), ink * (1.0 - lit));
    }
  }

  // Specular anti-aliasing (Kaplanyan-Hill) on the perturbed normal.
  let du = dpdx(n);
  let dv = dpdy(n);
  let kernel = min(2.0 * 0.25 * (dot(du, du) + dot(dv, dv)), 0.18);
  let a = roughness * roughness;
  roughness = sqrt(sqrt(saturate(a * a + kernel)));

  // Cabin light (everything but the sun): emitted term, so it reaches no pixel outside the cabin.
  let amb = cabinAmbient();
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let cl = cabinLight(in.world, n, viewDir, roughness, f0, occ, amb.sunT * amb.cloudT);
  let diffuseColor = albedo * (1.0 - metallic);
  let ambientSpec = amb.uniformE * (f0 * 0.5 + 0.02) * (1.0 - roughness) / PI;
  emissive += diffuseColor * (cl.diffuse + amb.uniformE * occ.ao * cavity) / PI + cl.specular + ambientSpec * occ.ao * cavity;

  // The sun through the windows, through the core's BRDFs and the cabin's own shadow map.
  let materialId = select(MATERIAL_STANDARD, MATERIAL_CLOTH, shading == 1u);
  let ngPart = dirPart(faceN);
  let sunVis = cabinSun(in.part, ngPart, shading == 1u, sc, scdx, scdy);
  if (max(sunVis.r, max(sunVis.g, sunVis.b)) > 0.0) {
    var s: Surface;
    s.pos = in.world;
    s.viewDist = length(in.world);
    s.n = n;
    s.ao = 1.0;
    s.v = viewDir;
    s.roughness = roughness;
    s.albedo = albedo;
    s.metallic = metallic;
    s.t = normalize(T - n * dot(T, n));
    s.anisotropy = select(0.0, mat.b.z, materialId == MATERIAL_STANDARD);
    s.up = n;
    s.altitude = 0.0;
    s.clearcoat = select(0.0, mat.b.w, materialId == MATERIAL_STANDARD);
    s.clearcoatRoughness = 0.08;
    s.param = select(0.0, mat.c.z, shading == 1u);
    s.lightAlpha = 0.6 * cabin.atmo.w;
    s.materialId = materialId;
    s.bodyIndex = -1;
    let l = cabin.sun.xyz;
    var f = brdfStandardDirect(s, l);
    if (shading == 1u) { f = brdfClothDirect(s, l); }
    emissive += f * cabinSunIlluminance(amb) * sunVis;
  }

  let param = select(0.0, mat.c.z, shading == 1u);
  var o = gbufferPack(albedo, 0.0, n, roughness, metallic, materialId, param,
                      velocityFromClip(in.currClip, in.prevClip), emissive * frame.exposure.x);
  if (materialId == MATERIAL_STANDARD) {
    let Ta = normalize(T - n * dot(T, n));
    o.extra = gbufferExtra(n, Ta, mat.b.z, mat.b.w, 0.08);
  }
  if (decal) {
    o.albedo.a = ink;
    o.emissive.a = ink;
  }
  return o;
}

@fragment fn fs(in: VOut) -> GBufferOut { return shade(in, false); }
@fragment fn fsDecal(in: VOut) -> GBufferOut { return shade(in, true); }
`;

/** Depth pre-pass entry of INTERIOR_WGSL: no colour is written (every target's write mask is 0). */
export const INTERIOR_DEPTH_ENTRY = 'fsDepth';
/** Label decals of INTERIOR_WGSL: RT0 and RT5 blended by the ink coverage (alpha), the other targets kept. */
export const INTERIOR_DECAL_ENTRY = 'fsDecal';

/** Depth-only casters: the core's cascades (group 2) and the cabin's own sun map (group 0). */
const CASTER_COMMON = /* wgsl */ `
struct Control { pivot: vec4f, rot: vec4f, offset: vec4f, prevRot: vec4f, prevOffset: vec4f, emit: vec4f }
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn animated(pos: vec3f, ctl: vec2u) -> vec3f {
  if (ctl.x == 0u) { return pos; }
  let C = controls[ctl.x - 1u];
  return C.pivot.xyz + qrot(C.rot, pos - C.pivot.xyz) + C.offset.xyz;
}
`;

/** The interior in the core's sun cascades (bind group 2: the part transform rows, the controls). */
export const SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
struct CabinXf { m0: vec4f, m1: vec4f, m2: vec4f }
@group(2) @binding(0) var<uniform> xf: CabinXf;
@group(2) @binding(1) var<storage, read> controls: array<Control>;
${CASTER_COMMON}
@vertex fn vs(@location(0) pos: vec3f, @location(6) ctl: vec2u) -> @builtin(position) vec4f {
  let p = animated(pos, ctl);
  let w = vec3f(dot(xf.m0.xyz, p) + xf.m0.w, dot(xf.m1.xyz, p) + xf.m1.w, dot(xf.m2.xyz, p) + xf.m2.w);
  return shadowPass.viewProj * vec4f(w, 1.0);
}
`;

/** The cabin's own sun shadow map (sunmap.ts): orthographic along the sun in the part frame. */
export const SUNMAP_WGSL = /* wgsl */ `
struct SunXf { u: vec4f, v: vec4f, l: vec4f }
@group(0) @binding(0) var<uniform> xf: SunXf;
@group(0) @binding(1) var<storage, read> controls: array<Control>;
${CASTER_COMMON}
@vertex fn vs(@location(0) pos: vec3f, @location(6) ctl: vec2u) -> @builtin(position) vec4f {
  let p = animated(pos, ctl);
  let u = dot(xf.u.xyz, p) + xf.u.w;
  let v = dot(xf.v.xyz, p) + xf.v.w;
  return vec4f(u * 2.0 - 1.0, 1.0 - v * 2.0, dot(xf.l.xyz, p) + xf.l.w, 1.0);
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
  @location(5) part: vec3f,
  @location(6) nPart: vec3f,
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
  o.part = v.pos;
  o.nPart = v.nrm;
  return o;
}

const PANEL_ALBEDO = vec3f(0.012, 0.013, 0.015);

@fragment fn fs(in: VOut) -> GBufferOut {
  let size = vec2f(textureDimensions(mfdTex));
  let sc = sunCoord(in.part);
  let scdx = dpdx(sc);
  let scdy = dpdy(sc);
  let uvSize = in.uv * size;
  let texelPx = 1.0 / max(max(length(dpdx(uvSize)), length(dpdy(uvSize))), 1e-6);
  var img = textureSample(mfdTex, anisoRepeat, in.uv, in.layer).rgb;
  // Pixel structure: when one display pixel covers several screen pixels the R, G and B stripes and the
  // black matrix between them resolve (energy preserving: each stripe carries three times its channel).
  let k = smoothstep(cabin.display.w, cabin.glare.z, texelPx);
  let exact = textureSampleLevel(mfdTex, nearestClamp, (floor(uvSize) + 0.5) / size, in.layer, 0.0).rgb;
  if (k > 0.0) {
    let cell = fract(uvSize);
    let stripe = floor(cell.x * 3.0);
    let inStripe = fract(cell.x * 3.0);
    let matrix = smoothstep(0.0, 0.12, inStripe) * smoothstep(1.0, 0.88, inStripe) * smoothstep(0.0, 0.08, cell.y) * smoothstep(1.0, 0.92, cell.y);
    let mask = vec3f(f32(stripe == 0.0), f32(stripe == 1.0), f32(stripe == 2.0)) * 3.0 * matrix / 0.66;
    img = mix(img, exact * mask, k);
  }
  let amb = cabinAmbient();
  let n = normalize(in.n);
  // The sun on the screen: the dark panel's diffuse reflection (the cover glass adds its own reflection).
  let sunVis = cabinSun(in.part, normalize(in.nPart), false, sc, scdx, scdy);
  let sunLit = PANEL_ALBEDO / PI * max(dot(n, cabin.sun.xyz), 0.0) * cabinSunIlluminance(amb) * sunVis;
  var o = gbufferPack(PANEL_ALBEDO, 0.0, n, 0.16, 0.0, MATERIAL_DISPLAY, amb.brightness,
                      velocityFromClip(in.currClip, in.prevClip), img * (cabin.display.x * frame.exposure.x));
  // RT5 carries the image at full brightness (the core scales it); the sunlit panel is added in proportion.
  o.emissive = vec4f(o.emissive.rgb + writeHdr(sunLit * frame.exposure.x / max(amb.brightness, 1e-3)), 1.0);
  return o;
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
  @location(5) part: vec3f,
  @location(6) nPart: vec3f,
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
  o.part = v.pos;
  o.nPart = v.nrm;
  return o;
}
fn srgbToLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
@fragment fn fs(in: VOut) -> GBufferOut {
  let sc = sunCoord(in.part);
  let scdx = dpdx(sc);
  let scdy = dpdy(sc);
  let t = textureSample(navballTex, linearClamp, in.uv);
  // Premultiplied sRGB image: un-premultiply, decode; outside the ball the cavity is black.
  let c = select(vec3f(0.0), srgbToLinear(min(t.rgb / max(t.a, 1e-3), vec3f(1.0))), t.a > 0.004);
  let albedo = c * t.a * 0.85;
  let n = normalize(in.n);
  let v = normalize(-in.world);
  let amb = cabinAmbient();
  // The ball sits in the instrument's cavity: the occlusion baked at the front of the ball.
  let occ = occUnpack(cabin.ballOcc[0], cabin.ballOcc[1], cabin.ballOcc[2], cabin.ballOcc[3]);
  let cl = cabinLight(in.world, n, v, 0.35, vec3f(0.04), occ, amb.sunT * amb.cloudT);
  var emissive = albedo * (cl.diffuse + amb.uniformE * occ.ao) / PI + cl.specular + albedo * cabin.atmo.z;
  let sunVis = cabinSun(in.part, normalize(in.nPart), false, sc, scdx, scdy);
  emissive += albedo / PI * max(dot(n, cabin.sun.xyz), 0.0) * cabinSunIlluminance(amb) * sunVis;
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
  @location(4) part: vec3f,
  @location(5) nPart: vec3f,
}
@vertex fn vs(v: VIn) -> VOut {
  let w = toRoot(cabin.m0, cabin.m1, cabin.m2, v.pos);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.n = normalize(dirRoot(v.nrm));
  o.uv = v.uv;
  o.info = v.info;
  o.part = v.pos;
  o.nPart = v.nrm;
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

/// What the cabin looks like along a ray from bare window glass: the displays, floodlights and sun patches
/// where the ray hits them (real images of the screens), the uniform cabin luminance otherwise.
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
      L = P.radiance.rgb * amb.sunT * amb.cloudT;
    } else {
      L = P.radiance.rgb;
    }
  }
  return L;
}

/// What an anti-glare (etched) cover glass reflects: every cabin source through a GGX lobe of the glass's
/// roughness, so a lamp becomes a soft glow instead of a sharp image over the data; F is applied by the caller.
fn cabinGlossyReflection(pos: vec3f, n: vec3f, v: vec3f, roughness: f32, amb: CabinAmbient) -> vec3f {
  var L = amb.uniformE * cabin.bounce.w / PI;
  let NoV = max(dot(n, v), 1e-3);
  for (var i = 0u; i < cabin.counts.x; i++) {
    let P = cabin.polys[i];
    let kind = u32(P.p0.w);
    if (P.normal.w < 0.5) { continue; }
    // Windows let light in from their outside; emitters shine to the side they face.
    let side = dot(P.p0.xyz - pos, P.normal.xyz);
    if ((kind == POLY_WINDOW && side < 0.0) || (kind != POLY_WINDOW && side > 0.0)) { continue; }
    let V = polyVector(pos, P.p0.xyz, P.p1.xyz, P.p2.xyz, P.p3.xyz);
    let lenV = length(V);
    if (lenV < 1e-7) { continue; }
    let l = V / lenV;
    let NoL = dot(n, l);
    if (NoL <= 0.0) { continue; }
    var Ls: vec3f;
    if (kind == POLY_WINDOW || kind == POLY_DISPLAY) { Ls = cabinPolyRadiance(i); } else if (kind == POLY_PATCH) { Ls = P.radiance.rgb * amb.sunT * amb.cloudT; } else { Ls = P.radiance.rgb; }
    let h = normalize(v + l);
    let a = sqrt(sq(max(roughness * roughness, 0.002)) + lenV * 0.5);
    // Microfacet reflection of the source's irradiance (F applied by the caller).
    L += D_GGX(saturate(dot(n, h)), a) * V_SmithGGXCorrelated(NoV, NoL, a) * Ls * (PI * max(dot(n, V), 0.0));
  }
  return L;
}

/// Dust specks, smudges and fine scratches of the cabin-side surface (coverage 0..1), uv in metres. Specks
/// are jittered in their cells, vary in size (many small, few large) and gather in clumps; smudges are
/// wiped streaks; scratches are curved hairlines of random length.
fn grime(uv: vec2f) -> f32 {
  let density = cabin.misc.y;
  // Clumping: the local speck density follows a slow noise.
  let clump = smoothstep(0.3, 0.85, valueNoise3(vec3f(uv * 9.0, 0.5), 45));
  var speck = 0.0;
  for (var s = 0; s < 2; s++) {
    let scale = select(620.0, 230.0, s == 1);
    let g = uv * scale + f32(s) * 17.3;
    let cell = floor(g);
    let h = hash4(i32(cell.x), i32(cell.y), 7 + s, 41);
    let p = hash_to_unit(h);
    let jitter = vec2f(hash_to_unit(hash4(i32(cell.x), i32(cell.y), 8 + s, 41)), hash_to_unit(hash4(i32(cell.x), i32(cell.y), 9 + s, 41))) - 0.5;
    let size = 0.08 + 0.3 * pow(hash_to_unit(hash4(i32(cell.x), i32(cell.y), 10 + s, 41)), 3.0);
    let f = fract(g) - 0.5 - jitter * (0.9 - 2.0 * size);
    let keep = step(p, density * select(0.05, 0.02, s == 1) * (0.25 + 2.2 * clump));
    speck = max(speck, keep * smoothstep(size, size * 0.4, length(f)) * (0.5 + 0.5 * hash_to_unit(hash4(i32(cell.x), i32(cell.y), 11 + s, 41))));
  }
  // Wiped smudges: streaky noise along a direction that turns slowly over the pane.
  let ang = valueNoise3(vec3f(uv * 2.0, 1.5), 46) * PI;
  let dir = vec2f(cos(ang), sin(ang));
  let streak = valueNoise3(vec3f(dot(uv, dir) * 60.0, dot(uv, vec2f(-dir.y, dir.x)) * 6.0, 2.0), 42);
  let smudge = smoothstep(0.62, 0.92, streak) * smoothstep(0.35, 0.75, valueNoise3(vec3f(uv * 4.0, 3.0), 47)) * 0.3;
  // Scratches: hairline arcs in random cells, random length and curvature.
  let sg = uv * 40.0;
  let sc = floor(sg);
  let hs = hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 43));
  let sa = hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 44)) * PI;
  let curve = (hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 48)) - 0.5) * 1.6;
  let len = 0.15 + 0.35 * hash_to_unit(hash4(i32(sc.x), i32(sc.y), 9, 49));
  let q = fract(sg) - 0.5;
  let along = dot(q, vec2f(cos(sa), sin(sa)));
  let across = dot(q, vec2f(-sin(sa), cos(sa))) - curve * along * along;
  let scratch = step(hs, cabin.misc.z * 0.5) * smoothstep(0.012, 0.0, abs(across)) * smoothstep(len, len * 0.7, abs(along));
  return clamp(speck + smudge * density + scratch * 0.4, 0.0, 1.0);
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
  let amb = cabinAmbient();
  let coverGlass = in.info.y < 1.0;
  var refl: vec3f;
  if (!fromInside) {
    refl = textureSampleLevel(envProbeCube, linearClamp, reflect(-v, nv), 0.0).rgb;
  } else if (coverGlass) {
    refl = cabinGlossyReflection(in.world + nv * 0.002, nv, v, cabin.glare.y, amb);
  } else {
    refl = cabinRadianceAlong(in.world + nv * 0.002, reflect(-v, nv), amb);
  }
  // info.y: reflectance of the pane relative to bare glass (the displays' coated cover glass is lower).
  var add = refl * (2.0 * F * in.info.y);
  // Dust and scratches on the cabin side light up when the sun shines through at a grazing angle.
  let nPart = normalize(in.nPart);
  let sunN = dot(frame.sunDir.xyz, -n);
  if (sunN > 0.0 && cabin.sun.w > 0.0) {
    // The pane lies in its window's aperture: only the windows clip the light that reaches it.
    let lit = sunThroughWindows(in.part);
    let g = grime(in.uv) * lit;
    let cosTh = dot(-v, frame.sunDir.xyz);
    let hg = (1.0 - 0.49) / pow(1.0 + 0.49 - 1.4 * cosTh, 1.5) / (4.0 * PI);
    let grazing = 1.0 / max(sunN, 0.15);
    add += cabinSunIlluminance(amb) * g * hg * grazing * 0.004;
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
