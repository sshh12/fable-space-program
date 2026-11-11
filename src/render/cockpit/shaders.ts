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
import { QUILT, UPHOLSTERY } from './cabin/quilt';
import { MAX_DISPLAYS, MAX_FLOODS, MAX_WINDOWS } from './layout';
import { MAX_CABIN_POLYS } from './lighting';
import { EDGE_SPAN } from './mesh';

export const CONTROL_FLOATS = 24;
/** vec4s of one occlusion record as the shaders unpack it (occlusion.ts: 24 bytes per vertex). */
export const OCC_VEC4 = 6;
/** vec4s of the cabin uniform's header (CabinFrame in CABIN_CHUNK, before `polys`). */
export const CABIN_HEADER_VEC4 = 24 + OCC_VEC4 + 7 * MAX_WINDOWS;
export const CABIN_HEADER_FLOATS = 4 * CABIN_HEADER_VEC4;
export const CABIN_POLY_FLOATS = 4 * 6;
export const CABIN_UNIFORM_FLOATS = CABIN_HEADER_FLOATS + MAX_CABIN_POLYS * CABIN_POLY_FLOATS;
export const MAX_MATERIALS = 48;
export const MATERIAL_FLOATS = 20;
/** Luminance (cd/m^2) is stored in the cabin probe times this (rgba16float holds 65504). */
export const PROBE_SCALE = 1 / 32;

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
  probe: 14,
  proxy: 15,
  sunL: 16,
  sunMap: 17,
  sunPart: 18,
  misc: 19,
  tint: 20,
  view: 21,
  glare: 22,
  glassSun: 23,
  ballOcc: 24,
  apertures: 24 + OCC_VEC4,
  sunTiles: 24 + OCC_VEC4 + 4 * MAX_WINDOWS,
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
/// The cabin probe (probe.ts): the lit interior seen from the cabin's centre, part-frame axes, prefiltered
/// mips, luminance x cabin.probe.w^-1. While the probe itself is rendered a black cube is bound here.
@group(1) @binding(10) var cabinProbe: texture_cube<f32>;
fn cabinAmbient() -> CabinAmbient {
  var o: CabinAmbient;
  o.brightness = cabinAmb[0].w;
  o.sunT = cabinAmb[1].xyz;
  o.cloudT = cabinAmb[1].w;
  return o;
}
fn cabinPolyRadiance(i: u32) -> vec3f { return cabinAmb[2u + i].xyz; }
/// Irradiance (lux) of the cabin's inter-reflected light on a surface with unit normal n (PART frame): the
/// probe's bounce light as nine spherical-harmonic coefficients (the compute pass PROBE_SH_WGSL).
fn cabinBounce(n: vec3f) -> vec3f {
  let b = ${2 + MAX_CABIN_POLYS}u;
  let e = cabinAmb[b].xyz + cabinAmb[b + 1u].xyz * n.y + cabinAmb[b + 2u].xyz * n.z + cabinAmb[b + 3u].xyz * n.x
        + cabinAmb[b + 4u].xyz * (n.x * n.y) + cabinAmb[b + 5u].xyz * (n.y * n.z) + cabinAmb[b + 6u].xyz * (3.0 * n.z * n.z - 1.0)
        + cabinAmb[b + 7u].xyz * (n.x * n.z) + cabinAmb[b + 8u].xyz * (n.x * n.x - n.y * n.y);
  return max(e, vec3f(0.0));
}
${scene}
`;

/** First binding of the scene sets in the cabin group (after the cabin's own bindings 0..10). */
export const CABIN_SCENE_BINDING = 11;

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
#include "cloud_shadow"

/// Cloud transmittance of the sun at the vessel: the core's depth-resolved lookup (RENDER_API section 7,
/// chunk cloud_shadow), so a cabin above a cloud deck is not shaded by the deck below it.
fn cabinCloudTransmittance() -> f32 {
  let bi = i32(cabin.sunColor.w);
  if (bi < 0) { return 1.0; }
  let b = frame.bodies[bi];
  let pos = vec3f(cabin.m0.w, cabin.m1.w, cabin.m2.w);
  let rel = pos - b.center.xyz;
  let r = length(rel);
  return cloudShadow(pos, bi, rel / max(r, 1.0), r, b.sunDir.xyz);
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
    flux = windowRadiance(-P.normal.xyz, 6.28, P.radiance.rgb, P.p2.w) * (PI * P.radiance.w);
    L = windowRadiance(-P.normal.xyz, 1.5, P.radiance.rgb, P.p2.w);
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

/**
 * vec4s of the cabin's per-frame GPU quantities: CabinAmbient (2), one per cabin polygon (the ambient pass),
 * then the nine irradiance coefficients of the probe's bounce light (PROBE_SH_WGSL).
 */
export const AMBIENT_VEC4S = 2 + MAX_CABIN_POLYS + 9;

/** First binding of the scene sets in the ambient pass's group. */
export const AMBIENT_SCENE_BINDING = 3;

/** Bind group 2 of the cabin probe's pipelines: one cube face's view-projection (part frame -> clip). */
const PROBE_FACE_WGSL = /* wgsl */ `
struct ProbeFace { viewProj: mat4x4f }
@group(2) @binding(0) var<uniform> probeFace: ProbeFace;
`;

/**
 * Direction of a cube face's texel (face index in WebGPU's order +X, -X, +Y, -Y, +Z, -Z; uv with (0, 0) at
 * the top left): forward + (2u - 1) right + (1 - 2v) up, the axes PROBE_FACES (probe.ts) renders with.
 */
const CUBE_DIR_WGSL = /* wgsl */ `
fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  let a = uv.x * 2.0 - 1.0;
  let b = 1.0 - uv.y * 2.0;
  switch (face) {
    case 0u: { return normalize(vec3f(1.0, b, -a)); }
    case 1u: { return normalize(vec3f(-1.0, b, a)); }
    case 2u: { return normalize(vec3f(a, 1.0, -b)); }
    case 3u: { return normalize(vec3f(a, -1.0, b)); }
    case 4u: { return normalize(vec3f(a, b, 1.0)); }
    default: { return normalize(vec3f(-a, b, -1.0)); }
  }
}
`;

/** Common include block of the cabin modules: frame chunks, the declarations, the cabin chunk, the sun. */
const HEAD = (decls: string): string => `
#include "frame"
#include "gbuffer"
#include "noise"
#include "transparency"
${decls}
#include "cockpit_cabin"
${PROBE_FN_WGSL}
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
  p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f,  // corners, camera-relative ROOT axes (m); p0.w = kind, p1.w = display layer / window / flood index, p2.w = windows: share of the entry plasma this window sees, p3.w = windows: depth of the well over its width
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
  probe: vec4f,                        // xyz = the cabin probe's centre (part frame), w = cd/m^2 per unit stored in the probe
  proxy: vec4f,                        // the cabin as the probe's parallax proxy: inner cone radius = x - y * height, between the floor (z) and the tunnel joint (w), part frame
  sunL: vec4f,                         // cabin sun map: depth = dot(xyz, p_part) + w (0 at the sun side .. 1)
  sunMap: vec4f,                       // x = size of one window's tile in atlas uv, y = depth range (m), z = atlas size (texels), w = 1 when the sun lights the cabin this frame
  sunPart: vec4f,                      // xyz = unit direction to the sun (part frame), w = penumbra slope 2 tan(angular radius)
  misc: vec4f,                         // x = glass transmittance (mean), y = dust density, z = scratch density, w = pane ior
  tint: vec4f,                         // rgb = transmittance of one pane (tint and Fresnel at normal incidence)
  view: vec4f,                         // xyz = camera position in the part frame, w = 1 when the camera is inside the cabin
  glare: vec4f,                        // x = display cover glass reflectance (relative to bare glass), y = its anti-glare roughness, z = screen px per texel where the pixel structure is resolved, w = 0
  glassSun: vec4f,                     // rgb = the glazing's transmittance at normal incidence (all panes), w = panes
  ballOcc: array<vec4f, ${OCC_VEC4}>,  // the occlusion record (occlusion.ts) at the front of the attitude ball
  apertures: array<vec4f, ${4 * MAX_WINDOWS}>,  // per window (WindowMeta.aperture): outer-end centre + half width, inward normal + half height, tangent + corner radius, generator + prism length
  sunTiles: array<vec4f, ${3 * MAX_WINDOWS}>,   // per window, its tile of the cabin sun map: atlas u = dot(xyz, p_part) + w; atlas v likewise; x, y = metres per unit of atlas u, v (0 = the sun does not enter here), z, w = the tile's first atlas u, v
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

/// Radiance coming in through a window along direction d (ROOT): the environment probe plus this window's
/// share of the shock layer's glow (plasmaShare; the share flickers and differs from window to window).
fn windowRadiance(d: vec3f, solidAngle: f32, trans: vec3f, plasmaShare: f32) -> vec3f {
  let mips = f32(textureNumLevels(envProbeCube)) - 1.0;
  // Mip whose texel spans the solid angle the window subtends (64^2 faces: one texel ~ 2.4e-4 sr).
  let mip = clamp(0.5 * log2(max(solidAngle, 1e-6) / 2.4e-4), 0.0, mips);
  return (textureSampleLevel(envProbeCube, linearClamp, d, mip).rgb + cabin.plasma.rgb * plasmaShare) * trans;
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
  /// The display brightness that follows the cabin's light, and the atmosphere's and the clouds'
  /// transmittance of the sun at the vessel.
  brightness: f32,
  sunT: vec3f,
  cloudT: f32,
}

/// Baked visibility of the cabin's sources at a point (occlusion.ts): ambient, each window, each display,
/// each flood light.
struct Occ {
  ao: f32,
  w: array<f32, ${MAX_WINDOWS}>,
  d: array<f32, ${MAX_DISPLAYS}>,
  f: array<f32, ${MAX_FLOODS}>,
}
fn occUnpack(o0: vec4f, o1: vec4f, o2: vec4f, o3: vec4f, o4: vec4f, o5: vec4f) -> Occ {
  var o: Occ;
  o.ao = o0.x;
  o.w = array<f32, ${MAX_WINDOWS}>(o0.z, o0.w, o1.x, o1.y, o1.z, o1.w, o2.x, o2.y);
  o.d = array<f32, ${MAX_DISPLAYS}>(o2.z, o2.w, o3.x, o3.y);
  o.f = array<f32, ${MAX_FLOODS}>(o4.x, o4.y, o4.z, o4.w, o5.x, o5.y, o5.z, o5.w);
  return o;
}

/// Light arriving at a cabin surface from every cabin polygon as irradiance (lux; pos camera-relative ROOT,
/// unit n), each source weighted by its baked visibility at the surface. sunScale = the atmosphere's and
/// the clouds' transmittance of the sun (the sun patches' radiance is given without them). The specular
/// reflection of the same sources comes from the cabin probe, which holds their images.
fn cabinLight(pos: vec3f, n: vec3f, occIn: Occ, sunScale: vec3f) -> vec3f {
  var occ = occIn;
  var diffuse = vec3f(0.0);
  for (var i = 0u; i < cabin.counts.x; i++) {
    let P = cabin.polys[i];
    if (P.normal.w < 0.5) { continue; }
    let kind = u32(P.p0.w);
    let toP = P.p0.xyz - pos;
    var well = 1.0;
    if (kind == POLY_WINDOW) {
      // Light from outside enters through the window's inner side: the receiver must be inside.
      if (dot(toP, P.normal.xyz) < 0.0) { continue; }
      // The outside is seen through the window's well (the hull's thickness and the bezel, p3.w = its depth
      // over its width): from a direction far off the window's axis the well's own walls fill the opening,
      // not the sky. A surface beside the window on the same wall gets none of its light.
      let d = normalize(pos - (P.p0.xyz + P.p2.xyz) * 0.5);
      let ca = max(-dot(d, P.normal.xyz), 0.0);
      well = saturate(1.0 - P.p3.w * sqrt(max(1.0 - ca * ca, 0.0)) / max(ca, 1e-3));
      if (well <= 0.0) { continue; }
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
      vis = occ.f[min(index, ${MAX_FLOODS - 1}u)];
    }
    // A source this point cannot see (baked) costs nothing.
    if (vis <= 0.004) { continue; }
    let V = polyVector(pos, P.p0.xyz, P.p1.xyz, P.p2.xyz, P.p3.xyz);
    let ff = max(dot(n, V), 0.0);
    if (ff <= 0.0) { continue; }
    var L: vec3f;
    if (kind == POLY_WINDOW || kind == POLY_DISPLAY) {
      L = cabinPolyRadiance(i);
    } else if (kind == POLY_PATCH) {
      L = P.radiance.rgb * sunScale;
    } else {
      L = P.radiance.rgb;
    }
    diffuse += L * (PI * ff) * (vis * well);
  }
  return diffuse;
}
`;

/**
 * Lookups of the cabin probe (included after the declarations by the modules that shade with it): the lit
 * cabin along a ray, parallax-corrected against the cabin's own shape, prefiltered for a roughness.
 */
const PROBE_FN_WGSL = /* wgsl */ `
/// Direction in which the probe sees what a ray from p along d (both PART frame, d unit) hits: the ray is
/// intersected with the cabin's proxy (the inner cone between the floor and the tunnel joint).
fn cabinProbeDir(p: vec3f, d: vec3f) -> vec3f {
  let b = cabin.proxy.y;
  let rr = cabin.proxy.x - b * p.y;
  let A = d.x * d.x + d.z * d.z - b * b * d.y * d.y;
  let B = 2.0 * (p.x * d.x + p.z * d.z + b * rr * d.y);
  let C = p.x * p.x + p.z * p.z - rr * rr;
  var t = 6.0;
  let disc = B * B - 4.0 * A * C;
  if (abs(A) > 1e-6 && disc >= 0.0) {
    let s = sqrt(disc);
    let t0 = (-B - s) / (2.0 * A);
    let t1 = (-B + s) / (2.0 * A);
    // The nearest crossing ahead that lies on the cabin's nappe of the cone.
    if (t0 > 1e-3 && cabin.proxy.x - b * (p.y + d.y * t0) > 0.0) { t = min(t, t0); }
    if (t1 > 1e-3 && cabin.proxy.x - b * (p.y + d.y * t1) > 0.0) { t = min(t, t1); }
  }
  if (d.y < -1e-5) { t = min(t, max((cabin.proxy.z - p.y) / d.y, 0.0)); }
  if (d.y > 1e-5) { t = min(t, max((cabin.proxy.w - p.y) / d.y, 0.0)); }
  return p + d * t - cabin.probe.xyz;
}
/// Probe mip that holds the cabin blurred for a GGX lobe of this roughness.
fn cabinProbeLod(roughness: f32) -> f32 {
  let texelsPerRad = f32(textureDimensions(cabinProbe).x) / 1.5708;
  return clamp(log2(max(roughness * roughness, 1e-3) * texelsPerRad * 1.4), 0.0, f32(textureNumLevels(cabinProbe)) - 1.0);
}
/// Luminance (cd/m^2) the cabin sends toward p (PART frame) from direction d, blurred for a roughness.
fn cabinProbeAt(p: vec3f, d: vec3f, roughness: f32) -> vec3f {
  return textureSampleLevel(cabinProbe, linearClamp, cabinProbeDir(p, d), cabinProbeLod(roughness)).rgb * cabin.probe.w;
}
/// Specular occlusion from the baked ambient occlusion (Lagarde and de Rousiers 2014).
fn cabinSpecOcclusion(NoV: f32, ao: f32, roughness: f32) -> f32 {
  return saturate(pow(NoV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
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
  // A sun that only skims the window's plane does not get through its well (the hull's thickness).
  if (cosI <= 0.03) { return vec2f(0.0); }
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
      // Outside the hull, no sun from this window. Between the two ends only the outer end clips the light,
      // and only for what stands in the opening itself (the panes, the bezel's tunnel): the wall and what
      // lies on it beside the opening is behind the hull, however the sun grazes.
      if (k == 0u) { return vec2f(0.0); }
      let pu = vec2f(dot(p - a0.xyz, a2.xyz), dot(p - a0.xyz, a3.xyz));
      let pq = abs(pu) - (halfSize - vec2f(rc));
      if (length(max(pq, vec2f(0.0))) + min(max(pq.x, pq.y), 0.0) - rc > 0.006) { return vec2f(0.0); }
      continue;
    }
    let t = dist / cosI;
    let h = p + ls * t - c;
    let uv = vec2f(dot(h, a2.xyz), dot(h, a3.xyz));
    let q = abs(uv) - (halfSize - vec2f(rc));
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rc;
    var grad = vec2f(0.0, sign(uv.y));
    if (q.x > 0.0 && q.y > 0.0) { grad = sign(uv) * normalize(q); } else if (q.x > q.y) { grad = vec2f(sign(uv.x), 0.0); }
    // (Bounded: the penumbra of an edge a cabin's width away is under two centimetres; the stretch along a
    // grazing sun must not turn the whole cabin into half shade.)
    let r = min(t * tanA * length(vec2f(dot(grad, e2) / cosI, grad.x * e2.y - grad.y * e2.x)), 0.03);
    vis = min(vis, discFraction(d / max(r, 1e-5)));
  }
  return vec2f(vis * smoothstep(0.03, 0.1, cosI), cosI);
}

/// The sun's light through the windows at p: rgb = the best window's disc fraction times its glazing's
/// transmittance (per channel; Fresnel at the incidence on every surface of every pane), w = that window.
fn sunThroughWindows(p: vec3f) -> vec4f {
  var best = vec2f(0.0);
  var which = 0u;
  for (var i = 0u; i < cabin.counts.y; i++) {
    let a = apertureVisibility(p, i);
    if (a.x > best.x) {
      best = a;
      which = i;
    }
  }
  if (best.x <= 0.0) { return vec4f(0.0); }
  let ior = cabin.misc.w;
  let f0 = sq((ior - 1.0) / (ior + 1.0));
  let fr = f0 + (1.0 - f0) * pow5(1.0 - best.y);
  return vec4f(cabin.glassSun.rgb * pow((1.0 - fr) / (1.0 - f0), 2.0 * cabin.glassSun.w) * best.x, f32(which));
}

/// Widest penumbra radius the sun map filters (m): the penumbra of a blocker 0.65 m from the receiver.
const SUN_PENUMBRA_MAX = 0.006;

/// Visibility of the sun past the interior's own occluders at a part-frame point with geometric normal ng
/// (turned to the sun by the caller), lit through window wi: 0 .. 1. Every window the sun enters has its own
/// tile of the cabin sun map, fitted to the cross-section of its beam (sunmap.ts): a few tenths of a
/// millimetre per texel, so an occluder's edge stays straight on a receiver the light only grazes. The
/// receiver's plane is known analytically (ng and the tile's axes), so taps over a sloped receiver compare
/// at the receiver's own depth. PCSS: a blocker search, then a 6 x 6 grid of bilinear comparisons over the
/// penumbra the blocker distance and the solar diameter give.
fn sunMapVisibility(p: vec3f, ng: vec3f, NoL: f32, wi: u32) -> f32 {
  let tu = cabin.sunTiles[3u * wi];
  let tv = cabin.sunTiles[3u * wi + 1u];
  let ti = cabin.sunTiles[3u * wi + 2u];
  if (ti.x <= 0.0) { return 1.0; }
  let range = cabin.sunMap.y;
  let size = cabin.sunMap.z;
  let mPerUv = ti.xy;
  let texelM = max(mPerUv.x, mPerUv.y) / size;
  // Depth of the receiver's plane per metre along the tile's axes (the light travels along -sunPart).
  let slope = clamp(vec2f(dot(ng, tu.xyz) * mPerUv.x, dot(ng, tv.xyz) * mPerUv.y) / max(NoL, 0.06), vec2f(-12.0), vec2f(12.0));
  let dzduv = slope * mPerUv / range;
  let sinL = sqrt(max(1.0 - NoL * NoL, 0.0));
  let q0 = p + ng * (texelM * (1.0 + 2.0 * sinL) + 0.0003);
  let q = vec3f(dot(tu.xyz, q0) + tu.w, dot(tv.xyz, q0) + tv.w, dot(cabin.sunL.xyz, q0) + cabin.sunL.w);
  // What is left after the plane fit: the map's own interpolation within a texel of a sloped caster.
  let bias = (0.0004 + texelM * (1.0 + 0.75 * sinL / max(NoL, 0.06))) / range;
  let guard = vec2f(1.5 / size);
  let lo = ti.zw + guard;
  let hi = ti.zw + vec2f(cabin.sunMap.x) - guard;
  // Blocker search over the widest penumbra that is filtered.
  let searchUv = vec2f(SUN_PENUMBRA_MAX) / mPerUv;
  var zBlock = 0.0;
  var nBlock = 0.0;
  for (var k = 0u; k < 16u; k++) {
    let o = SUN_TAPS[k] * searchUv;
    let zr = q.z + dot(o, dzduv) - bias;
    let d4 = textureGather(cabinSunMap, nearestClamp, clamp(q.xy + o, lo, hi));
    let m = select(vec4f(0.0), vec4f(1.0), d4 < vec4f(zr));
    nBlock += m.x + m.y + m.z + m.w;
    zBlock += dot(d4, m);
  }
  if (nBlock < 0.5) { return 1.0; }
  if (nBlock > 63.5) { return 0.0; }
  zBlock /= nBlock;
  // Penumbra radius (m): blocker distance x the sun's angular radius, at least a texel and a half.
  let pen = clamp((q.z - zBlock) * range * 0.5 * cabin.sunPart.w, 1.5 * texelM, SUN_PENUMBRA_MAX);
  let stepUv = vec2f(pen / 3.0) / mPerUv;
  var lit = 0.0;
  for (var j = 0; j < 6; j++) {
    for (var i = 0; i < 6; i++) {
      let o = (vec2f(f32(i), f32(j)) - 2.5) * stepUv;
      lit += textureSampleCompareLevel(cabinSunMap, shadowCompare, clamp(q.xy + o, lo, hi), q.z + dot(o, dzduv) - bias);
    }
  }
  return lit / 36.0;
}

/// The sun at a part-frame point of a cabin surface with geometric normal ngIn (part frame): rgb
/// transmittance of windows, glazing and interior occluders. Cloth (two-sided) uses the normal turned to
/// the sun.
fn cabinSun(p: vec3f, ngIn: vec3f, twoSided: bool) -> vec3f {
  if (cabin.sunMap.w < 0.5) { return vec3f(0.0); }
  let ls = cabin.sunPart.xyz;
  var ng = ngIn;
  if (twoSided && dot(ng, ls) < 0.0) { ng = -ng; }
  let NoL = dot(ng, ls);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let through = sunThroughWindows(p);
  if (max(through.r, max(through.g, through.b)) <= 0.0) { return vec3f(0.0); }
  // Soft goods under a sun that only skims them: their own relief (pillows, folds), which is not in the
  // sun map, shades them entirely.
  let skim = select(1.0, smoothstep(0.03, 0.14, NoL), twoSided);
  return through.rgb * (skim * sunMapVisibility(p, ng, NoL, u32(through.w + 0.5)));
}

/// Sun illuminance (lux, rgb) at the vessel through the atmosphere and the clouds (before the windows).
fn cabinSunIlluminance(amb: CabinAmbient) -> vec3f {
  return cabin.sun.w * cabin.sunColor.rgb * amb.sunT * amb.cloudT;
}
`;

/**
 * Interior: animated controls, textured surface detail, labels, emitters, the sun, cabin light. Entry points:
 * vsDepth / fsDepth (depth pre-pass), vs / fs (G-buffer), fsDecal (label decals), vsProbe / fsProbe (the
 * cabin probe: the same surfaces seen from the cabin's centre, diffuse light only; bind group 2 holds the
 * cube face's view-projection).
 */
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

${PROBE_FACE_WGSL}
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
  @location(11) occ4: vec4f,
  @location(12) occ5: vec4f,
}
struct VOut {
  // Invariant: the depth pre-pass and the shading pass produce bit-identical depth (depth test 'equal').
  @invariant @builtin(position) clip: vec4f,
  @location(0) part: vec3f,
  @location(1) n: vec3f,
  @location(2) t: vec4f,
  @location(3) uv: vec4f,                 // xy = uv0 (surface coordinates), zw = uv1 (label atlas)
  @location(4) @interpolate(flat) misc: vec4u,
  @location(5) @interpolate(flat) ctl: vec2u,
  @location(6) currClip: vec4f,
  @location(7) prevClip: vec4f,
  @location(8) occ0: vec4f,
  @location(9) occ1: vec4f,
  @location(10) occ2: vec4f,
  @location(11) occ3: vec4f,
  @location(12) occ4: vec4f,
  @location(13) occ5: vec4f,
}

fn vertexOut(v: VIn) -> VOut {
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
  o.n = dirRoot(n);
  o.t = vec4f(dirRoot(t), v.tan.w);
  o.uv = vec4f(v.uv0, v.uv1);
  o.misc = v.misc;
  o.ctl = v.ctl;
  o.part = p;
  o.occ0 = v.occ0;
  o.occ1 = v.occ1;
  o.occ2 = v.occ2;
  o.occ3 = v.occ3;
  o.occ4 = v.occ4;
  o.occ5 = v.occ5;
  return o;
}
@vertex fn vs(v: VIn) -> VOut { return vertexOut(v); }
@vertex fn vsProbe(v: VIn) -> VOut {
  var o = vertexOut(v);
  o.clip = probeFace.viewProj * vec4f(o.part, 1.0);
  return o;
}

// ------------------------------------------------------------------------------------------- detail
/// slope: tangent-space normal offset (texture detail); dh: screen derivatives of a height field in metres
/// (procedural relief: the surface-gradient form, independent of how the pattern lies in the tangent frame).
struct Detail { albedo: f32, rough: f32, slope: vec2f, dh: vec2f, cavity: f32, wear: f32, grime: f32 }

fn partHash(seed: u32, k: i32) -> f32 { return hash_to_unit(hash4(i32(seed), k, 71, 19)); }
/// Fade of a pattern of spatial frequency f (cycles per metre) given the pixel footprint fw (m): patterns
/// finer than about two pixels are filtered out instead of aliasing into moire.
fn aaFade(f: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.2, 0.45, f * fw); }

const QUILT_CELL = ${QUILT.cell};
const QUILT_HEIGHT = ${QUILT.height};
const QUILT_POWER = ${QUILT.power};

/// Surface detail of a material at surface coordinates uv (metres; quilted blankets: quilt cells, cabin/quilt.ts):
/// the baked detail textures (tone, gloss, normal, cavity, wear and grime masks) with a per-part phase, tone
/// and gloss, plus the procedural patterns that follow the geometry (quilting, duct ribs, knurling).
fn materialDetail(mat: Material, uvIn: vec2f, dxIn: vec2f, dyIn: vec2f, fwIn: f32, seed: u32, edge: bool) -> Detail {
  var d: Detail;
  let strength = mat.c.y;
  let variation = mat.d.w;
  let pattern = u32(mat.c.x + 0.5);
  // Metric coordinates for the textures (a quilt's coordinates count cells).
  let unit = select(1.0, QUILT_CELL, pattern == 1u);
  let uv = uvIn * unit;
  let dx = dxIn * unit;
  let dy = dyIn * unit;
  let fw = fwIn * unit;
  d.albedo = 1.0 + (partHash(seed, 0) - 0.5) * variation;
  d.rough = (partHash(seed, 1) - 0.5) * variation;
  d.slope = vec2f(0.0);
  d.dh = vec2f(0.0);
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
    // Paint wears through along the middle of a chamfer (uv.y runs 0 .. EDGE_SPAN across it), in runs: a
    // slow variation along the edge decides where a run is worn (mat.d.y of the edge's length), the fine
    // mask frays the line and the ends of each run into chips.
    if (edge && mat.d.y > 0.0) {
      let run = valueNoise3(vec3f(uv.x * 11.0 + f32(seed) * 3.7, f32(seed) * 0.37, 0.5), 51);
      let worn = smoothstep(1.0 - mat.d.y - 0.1, 1.0 - mat.d.y + 0.1, run * 0.8 + 0.1 + (tM.b - 0.5) * 0.25);
      let across = 1.0 - abs(2.0 * uv.y / ${EDGE_SPAN} - 1.0);
      d.wear = smoothstep(0.5, 0.72, across * (0.45 + 0.75 * worn) + (tM.b - 0.5) * 0.3) * worn;
    }
    d.grime = tM.a;
  }
  switch (pattern) {
    case 1u: { // quilted blanket: every diamond cell a pillow pinched along its stitched seams
      let a = vec2f(uvIn.x + uvIn.y, uvIn.x - uvIn.y) * 0.7071;
      let f = fract(a) - 0.5;
      let id = floor(a);
      // Each cell is filled a little differently (the batting settles).
      let fill = mix(0.75, 1.15, hash_to_unit(hash4(i32(id.x), i32(id.y), i32(seed), 33)));
      let c = max(cos(PI * f.x) * cos(PI * f.y), 1e-4);
      let ce = pow(c, QUILT_POWER);
      // Gradient of the pillow height (m) in cell coordinates. The crease at the seam is as sharp as the
      // pixel footprint resolves (fwIn = cells per pixel): from afar the cloth dives into the seam more
      // gently, so a crease narrower than a pixel does not sparkle.
      let soft = clamp(fwIn * 9.0, 0.04, 0.8);
      var ga = -(QUILT_HEIGHT * fill * QUILT_POWER * PI) * ce * sin(PI * f) / (cos(PI * f) + vec2f(soft));
      // Distance to the nearest seam (cells) and which pair of seams it belongs to.
      let sd = vec2f(0.5) - abs(f);
      let seam = min(sd.x, sd.y);
      let seamM = seam * QUILT_CELL;
      // Puckers: the cloth gathers along each seam in short ripples across it.
      let along = select(a.x, a.y, sd.x < sd.y);
      let ph = hash_to_unit(hash4(i32(id.x), i32(id.y), i32(sd.x < sd.y), 34)) * 6.28;
      let pk = 2.0 * PI * QUILT_CELL / 0.011;
      let pucker = 0.00045 * exp(-seamM / 0.008) * aaFade(1.0 / 0.011, fw);
      let gp = pucker * pk * cos(along * pk + ph);
      ga += select(vec2f(gp, 0.0), vec2f(0.0, gp), sd.x < sd.y);
      let lim = 1.2 * QUILT_CELL;
      ga = clamp(ga, vec2f(-lim), vec2f(lim));
      // Chain rule to the screen: cells -> uv0 (a rotation) -> pixels.
      let gq = vec2f(ga.x + ga.y, ga.x - ga.y) * 0.7071;
      let fade = aaFade(1.0 / QUILT_CELL, fw * 0.5);
      d.dh = vec2f(dot(gq, dxIn), dot(gq, dyIn)) * fade;
      // The stitched groove: a narrow shaded line, and the thread as dashes along it.
      let groove = 1.0 - smoothstep(0.0015, 0.0045, seamM);
      d.cavity *= mix(1.0, 0.62, groove);
      d.albedo *= 1.0 - 0.1 * groove;
      let thread = (1.0 - smoothstep(0.0006, 0.0012, seamM)) * step(0.4, fract(along * QUILT_CELL / 0.0035)) * aaFade(1.0 / 0.0035, fw);
      d.albedo *= 1.0 + 0.22 * thread;
      d.rough -= 0.1 * thread;
      // Dust gathers a little in the grooves, handling polishes the crowns.
      d.grime = max(d.grime * 0.6, groove * 0.5);
      d.rough -= 0.05 * ce;
    }
    case 4u: { // channelled upholstery: the cover stitched down across the pad every ${UPHOLSTERY.pitch} m
      let a = uvIn.y / ${UPHOLSTERY.pitch};
      let f = fract(a) - 0.5;
      let ce = pow(max(cos(PI * f), 1e-4), ${UPHOLSTERY.power});
      let soft = clamp(fwIn / ${UPHOLSTERY.pitch} * 2.5, 0.03, 0.6);
      // Slope of the channel's height across the pad (m per m), bounded at the seam's crease.
      let g = clamp(-(${UPHOLSTERY.height} * ${UPHOLSTERY.power} * PI / ${UPHOLSTERY.pitch}) * ce * sin(PI * f) / (cos(PI * f) + soft), -1.2, 1.2);
      d.dh = vec2f(g * dxIn.y, g * dyIn.y) * aaFade(1.0 / ${UPHOLSTERY.pitch}, fw * 0.5);
      let seamM = (0.5 - abs(f)) * ${UPHOLSTERY.pitch};
      let groove = 1.0 - smoothstep(0.0012, 0.004, seamM);
      d.cavity *= mix(1.0, 0.6, groove);
      let thread = (1.0 - smoothstep(0.0005, 0.001, seamM)) * step(0.4, fract(uvIn.x / 0.004)) * aaFade(250.0, fw);
      d.albedo *= 1.0 + 0.5 * thread;
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

struct Shaded {
  albedo: vec3f,
  n: vec3f,
  t: vec3f,
  roughness: f32,
  metallic: f32,
  materialId: u32,
  param: f32,
  anisotropy: f32,
  clearcoat: f32,
  /// Luminance toward the eye (cd/m^2, not pre-exposed) and the share of it that is reflected light (the
  /// probe's bounce light: everything but what the surface emits itself, whose light reaches the cabin as
  /// polygon sources).
  luminance: vec3f,
  bounceShare: f32,
  ink: f32,
}

/// Shade an interior fragment seen from 'eye' (camera-relative ROOT; the camera itself, or the probe's
/// centre). decal: a label drawn over its face after the interior, blended by its ink (RT0 and RT5 only), so
/// the face underneath shows through unchanged where there is no ink. probe: diffuse light only.
fn shade(in: VOut, eye: vec3f, decal: bool, probe: bool) -> Shaded {
  let mat = materials[in.misc.x];
  let shading = u32(mat.b.y + 0.5);
  let flags = in.misc.z;
  let isLabel = (flags & FLAG_LABEL) != 0u;
  let world = toRoot(cabin.m0, cabin.m1, cabin.m2, in.part);
  // Screen derivatives in uniform control flow: detail filtering, label filtering, the face normal.
  let duvx = dpdx(in.uv.xy);
  let duvy = dpdy(in.uv.xy);
  let fw = max(length(duvx), length(duvy));
  let uvDx = dpdx(in.uv.zw);
  let uvDy = dpdy(in.uv.zw);
  let sigmaX = dpdx(world);
  let sigmaY = dpdy(world);
  let faceRaw = cross(sigmaX, sigmaY);

  let seed = select(in.misc.w, 0u, isLabel);
  let det = materialDetail(mat, in.uv.xy, duvx, duvy, fw, seed, (flags & FLAG_EDGE) != 0u);
  var occ = occUnpack(in.occ0, in.occ1, in.occ2, in.occ3, in.occ4, in.occ5);
  // Modelled cavity (vertex) and texture cavity darken the cabin's ambient light only.
  let cavity = (f32(in.misc.y) / 255.0) * det.cavity;

  var albedo = mat.a.rgb * det.albedo;
  var roughness = clamp(mat.a.w + det.rough, 0.04, 1.0);
  var metallic = mat.b.x;
  // Worn edges show what is under the paint or the anodising.
  albedo = mix(albedo, mat.e.rgb, det.wear);
  metallic = mix(metallic, mat.e.w, det.wear);
  roughness = mix(roughness, 0.5, det.wear);
  // Grime settles where few hands reach: the texture's mask in modelled cavities (the same on every
  // identical part; the baked occlusion does not enter).
  let grime = saturate(det.grime * mat.d.z * (1.5 - cavity));
  albedo *= 1.0 - 0.4 * grime;
  roughness = mix(roughness, 0.85, grime * 0.5);

  var N = normalize(in.n);
  let viewDir = normalize(eye - world);
  // Two-sided: the vertex normal is flipped when it lies on the far side of the visible face.
  var faceN = normalize(faceRaw);
  if (dot(faceN, viewDir) < 0.0) { faceN = -faceN; }
  if (dot(N, faceN) < 0.0) { N = -N; }
  var T = in.t.xyz - N * dot(in.t.xyz, N);
  T = select(normalize(T), tangentFrame(N)[0], dot(T, T) < 1e-8);
  let B = cross(N, T) * in.t.w;
  // Procedural relief as a surface gradient (Mikkelsen): grad h = (dh/dx R1 + dh/dy R2) / det.
  let r1 = cross(sigmaY, N);
  let r2 = cross(N, sigmaX);
  let dt = dot(sigmaX, r1);
  var grad = vec3f(0.0);
  if (abs(dt) > 1e-12) { grad = (det.dh.x * r1 + det.dh.y * r2) / dt; }
  let n = normalize(N + T * det.slope.x + B * det.slope.y - grad);

  // Labels: ink from the atlas over the face material.
  var emissive = vec3f(0.0);
  var ink = 0.0;
  if (isLabel) {
    ink = textureSampleGrad(labelAtlas, anisoRepeat, in.uv.zw, uvDx, uvDy).r;
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
      albedo = mix(albedo, vec3f(0.42), ink * (1.0 - lit));
    }
  }

  // Specular anti-aliasing (Kaplanyan-Hill) on the perturbed normal.
  let du = dpdx(n);
  let dv = dpdy(n);
  let kernel = min(2.0 * 0.25 * (dot(du, du) + dot(dv, dv)), 0.18);
  let a = roughness * roughness;
  roughness = sqrt(sqrt(saturate(a * a + kernel)));

  // Cabin light (everything but the sun): the sources as polygons with their baked visibility, the light
  // the cabin's own surfaces reflect (the probe's bounce irradiance about the normal), and for glossy
  // surfaces the probe's image of the cabin along the reflected ray.
  let amb = cabinAmbient();
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let materialId = select(MATERIAL_STANDARD, MATERIAL_CLOTH, shading == 1u);
  let nPart = dirPart(n);
  let NoV = max(dot(n, viewDir), 1e-3);
  let E = cabinLight(world, n, occ, amb.sunT * amb.cloudT) + cabinBounce(nPart) * (occ.ao * cavity);
  // In the probe a metal counts as a diffuse reflector of its own colour (it holds no specular light).
  let diffuseColor = select(albedo * (1.0 - metallic), albedo, probe);
  var reflected = diffuseColor * E / PI;
  let Ta = normalize(T - n * dot(T, n));
  if (!probe) {
    if (shading == 1u) {
      // Cloth: fibres standing off the weave scatter light toward a grazing eye.
      reflected += mix(vec3f(0.07), albedo, 0.35) * E * (sq(1.0 - NoV) * 1.6 / PI);
    } else {
      let vPart = dirPart(viewDir);
      var rn = nPart;
      if (mat.b.z > 0.0) {
        // Brushed metal: the lobe stretches across the grain (Filament's bent normal).
        let g = dirPart(cross(n, Ta) * in.t.w);
        let an = cross(cross(g, vPart), g);
        rn = normalize(mix(nPart, an, mat.b.z * saturate(5.0 * roughness)));
      }
      let dfg = envBrdfApprox(roughness, NoV);
      let so = cabinSpecOcclusion(NoV, occ.ao * cavity, roughness);
      reflected += cabinProbeAt(in.part, reflect(-vPart, rn), roughness) * (f0 * dfg.x + vec3f(dfg.y)) * so;
      if (mat.b.w > 0.0) {
        let fc = (0.04 + 0.96 * pow5(1.0 - NoV)) * mat.b.w;
        reflected = reflected * (1.0 - fc) + cabinProbeAt(in.part, reflect(-vPart, nPart), 0.08) * (fc * so);
      }
    }
  }

  // The sun through the windows, through the core's BRDFs and the cabin's own shadow map.
  var sunLit = vec3f(0.0);
  // Soft goods take the sun on their smooth surface (the interpolated normal): the facets of a blanket's
  // mesh are coarser than its quilting.
  let ngPart = dirPart(select(faceN, N, shading == 1u));
  let sunVis = cabinSun(in.part, ngPart, shading == 1u);
  if (max(sunVis.r, max(sunVis.g, sunVis.b)) > 0.0) {
    var s: Surface;
    s.pos = world;
    s.viewDist = length(world - eye);
    s.n = n;
    s.ao = 1.0;
    s.v = viewDir;
    s.roughness = roughness;
    s.albedo = albedo;
    s.metallic = select(metallic, 0.0, probe);
    s.t = Ta;
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
    if (probe) { f = albedo * (max(dot(n, l), 0.0) / PI); }
    sunLit = f * cabinSunIlluminance(amb) * sunVis;
  }

  var o: Shaded;
  o.albedo = albedo;
  o.n = n;
  o.t = Ta;
  o.roughness = roughness;
  o.metallic = metallic;
  o.materialId = materialId;
  o.param = select(0.0, mat.c.z, shading == 1u);
  o.anisotropy = mat.b.z;
  o.clearcoat = mat.b.w;
  o.luminance = reflected + sunLit + emissive;
  o.bounceShare = saturate(luminance(reflected + sunLit) / max(luminance(o.luminance), 1e-6));
  o.ink = ink;
  return o;
}

fn pack(in: VOut, s: Shaded, decal: bool) -> GBufferOut {
  var o = gbufferPack(s.albedo, 0.0, s.n, s.roughness, s.metallic, s.materialId, s.param,
                      velocityFromClip(in.currClip, in.prevClip), s.luminance * frame.exposure.x);
  if (s.materialId == MATERIAL_STANDARD) {
    o.extra = gbufferExtra(s.n, s.t, s.anisotropy, s.clearcoat, 0.08);
  }
  if (decal) {
    o.albedo.a = s.ink;
    o.emissive.a = s.ink;
  }
  return o;
}

@fragment fn fs(in: VOut) -> GBufferOut { return pack(in, shade(in, vec3f(0.0), false, false), false); }
@fragment fn fsDecal(in: VOut) -> GBufferOut { return pack(in, shade(in, vec3f(0.0), true, false), true); }
/// The cabin probe: luminance / cabin.probe.w, alpha = the share that is reflected cabin light.
@fragment fn fsProbe(in: VOut) -> @location(0) vec4f {
  let s = shade(in, toRoot(cabin.m0, cabin.m1, cabin.m2, cabin.probe.xyz), false, true);
  return vec4f(min(s.luminance / cabin.probe.w, vec3f(60000.0)), s.bounceShare);
}
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

/** How far the closed shell is blown up about the cabin's centre in the core's sun cascades. */
export const SHADOW_SHELL_INFLATE = 1.03;

/**
 * The interior in the core's sun cascades (bind group 2: the head of the cabin uniform, the controls): the
 * closed shell of the far detail level. That level is a coarse polygon of the cabin (chords a few
 * millimetres inside the true wall), and the full-detail interior lies against the true wall: drawn as it
 * is, the shell would leave slivers of the interior (blanket rims, the hatch's seal) outside itself, in the
 * core's sun. So the shell is blown up a few per cent about the cabin's centre: it stays inside the hull's
 * thickness and holds every interior surface.
 */
export const SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
struct CabinXf { m0: vec4f, m1: vec4f, m2: vec4f, skip: array<vec4f, ${CABIN.probe - 3}>, probe: vec4f }
@group(2) @binding(0) var<uniform> xf: CabinXf;
@group(2) @binding(1) var<storage, read> controls: array<Control>;
${CASTER_COMMON}
@vertex fn vs(@location(0) pos: vec3f, @location(6) ctl: vec2u) -> @builtin(position) vec4f {
  let p = xf.probe.xyz + (animated(pos, ctl) - xf.probe.xyz) * ${SHADOW_SHELL_INFLATE};
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

/** Displays: the MFD images as emitters behind glass (MATERIAL_ID.display), with the RGB stripe structure up close; and in the cabin probe. */
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
  let sunVis = cabinSun(in.part, normalize(in.nPart), false);
  let sunLit = PANEL_ALBEDO / PI * max(dot(n, cabin.sun.xyz), 0.0) * cabinSunIlluminance(amb) * sunVis;
  var o = gbufferPack(PANEL_ALBEDO, 0.0, n, 0.16, 0.0, MATERIAL_DISPLAY, amb.brightness,
                      velocityFromClip(in.currClip, in.prevClip), img * (cabin.display.x * frame.exposure.x));
  // RT5 carries the image at full brightness (the core scales it); the sunlit panel is added in proportion.
  o.emissive = vec4f(o.emissive.rgb + writeHdr(sunLit * frame.exposure.x / max(amb.brightness, 1e-3)), 1.0);
  return o;
}

// The same screens in the cabin probe: emitters (alpha 0: their light reaches surfaces as polygon sources).
${PROBE_FACE_WGSL}
@vertex fn vsProbe(v: VIn) -> VOut {
  var o: VOut;
  o.clip = probeFace.viewProj * vec4f(v.pos, 1.0);
  o.uv = v.uv;
  o.layer = u32(v.layer + 0.5);
  o.n = dirRoot(v.nrm);
  o.part = v.pos;
  o.nPart = v.nrm;
  return o;
}
@fragment fn fsProbe(in: VOut) -> @location(0) vec4f {
  let img = textureSampleLevel(mfdTex, linearClamp, in.uv, in.layer, 3.0).rgb;
  return vec4f(img * (cabin.display.x * cabinAmbient().brightness / cabin.probe.w), 0.0);
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
  let t = textureSample(navballTex, linearClamp, in.uv);
  // Premultiplied sRGB image: un-premultiply, decode; outside the ball the cavity is black.
  let c = select(vec3f(0.0), srgbToLinear(min(t.rgb / max(t.a, 1e-3), vec3f(1.0))), t.a > 0.004);
  let albedo = c * t.a * 0.85;
  let n = normalize(in.n);
  let v = normalize(-in.world);
  let amb = cabinAmbient();
  // The ball sits in the instrument's cavity: the occlusion baked at the front of the ball.
  let occ = occUnpack(cabin.ballOcc[0], cabin.ballOcc[1], cabin.ballOcc[2], cabin.ballOcc[3], cabin.ballOcc[4], cabin.ballOcc[5]);
  let nP = normalize(in.nPart);
  let E = cabinLight(in.world, n, occ, amb.sunT * amb.cloudT) + cabinBounce(nP) * occ.ao;
  // A satin ball: its faint image of the cabin on top of the painted sphere.
  let NoV = max(dot(n, v), 1e-3);
  let dfg = envBrdfApprox(0.38, NoV);
  let spec = cabinProbeAt(in.part, reflect(-dirPart(v), nP), 0.38) * (0.04 * dfg.x + dfg.y) * cabinSpecOcclusion(NoV, occ.ao, 0.38);
  var emissive = albedo * E / PI + spec + albedo * cabin.atmo.z;
  let sunVis = cabinSun(in.part, nP, false);
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

/// What the cabin looks like along a ray from bare window glass (o camera-relative ROOT, oPart the same
/// point in the part frame, d ROOT): the cabin probe's image of the lit interior, and over it the displays
/// and the flood lights where the ray hits them (sharp images of the screens and the lamps).
fn cabinRadianceAlong(o: vec3f, oPart: vec3f, d: vec3f, amb: CabinAmbient) -> vec3f {
  var L = textureSampleLevel(cabinProbe, linearClamp, cabinProbeDir(oPart, dirPart(d)), 0.0).rgb * cabin.probe.w;
  var best = 1e9;
  for (var i = 0u; i < cabin.counts.x; i++) {
    let P = cabin.polys[i];
    let kind = u32(P.p0.w);
    if ((kind != POLY_DISPLAY && kind != POLY_FLOOD) || P.normal.w < 0.5) { continue; }
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
    } else {
      L = P.radiance.rgb;
    }
  }
  return L;
}

/// Film on the cabin-side surface of a pane (coverage 0..1), uv in metres: an even veil of fine dust (a
/// little uneven where the pane was wiped: faint arcs), a few specks and fibres, hairline scratches.
fn grime(uv: vec2f) -> f32 {
  let density = cabin.misc.y;
  // The veil: nearly even, a slow variation and the arcs of the last wipe.
  let slow = valueNoise3(vec3f(uv * 5.0, 0.5), 45);
  let wipeC = vec2f(-0.35, -0.5);
  let wipe = 0.5 + 0.5 * sin(length(uv - wipeC) * 140.0 + 6.0 * valueNoise3(vec3f(uv * 3.0, 1.5), 46));
  let veil = density * (0.1 + 0.05 * slow + 0.035 * wipe * smoothstep(0.35, 0.7, valueNoise3(vec3f(uv * 2.2, 3.0), 47)));
  // Specks: sparse (well under one in a hundred cells of 1.2 mm), a few of them fibres.
  let g = uv * 820.0;
  let cell = floor(g);
  let h = hash4(i32(cell.x), i32(cell.y), 7, 41);
  let jitter = vec2f(hash_to_unit(hash4(i32(cell.x), i32(cell.y), 8, 41)), hash_to_unit(hash4(i32(cell.x), i32(cell.y), 9, 41))) - 0.5;
  let size = 0.1 + 0.25 * pow(hash_to_unit(hash4(i32(cell.x), i32(cell.y), 10, 41)), 4.0);
  let fq = fract(g) - 0.5 - jitter * 0.5;
  let fa = hash_to_unit(hash4(i32(cell.x), i32(cell.y), 11, 41)) * PI;
  let fibre = vec2f(dot(fq, vec2f(cos(fa), sin(fa))) * select(1.0, 0.3, hash_to_unit(hash4(i32(cell.x), i32(cell.y), 12, 41)) > 0.8), dot(fq, vec2f(-sin(fa), cos(fa))));
  let speck = step(hash_to_unit(h), density * 0.004) * smoothstep(size, size * 0.4, length(fibre));
  let smudge = veil;
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
  return clamp(smudge + speck * 0.5 + scratch * 0.3, 0.0, 1.0);
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
  // info.y: 1 = a window pane, 0.5 .. 1 = the glass of an instrument (bare, but small and curved: its image
  // of the cabin is taken a little soft), below = a display's coated cover glass.
  let coverGlass = in.info.y < 0.5;
  let instrument = in.info.y < 1.0 && !coverGlass;
  var refl: vec3f;
  let nPart = normalize(in.nPart);
  let nvPart = select(-nPart, nPart, fromInside);
  if (!fromInside) {
    refl = textureSampleLevel(envProbeCube, linearClamp, reflect(-v, nv), 0.0).rgb;
  } else if (coverGlass) {
    // Anti-glare (etched) cover glass: the cabin through a lobe of the glass's roughness, so a lamp becomes
    // a soft glow instead of a sharp image over the data.
    refl = cabinProbeAt(in.part + nvPart * 0.002, reflect(-dirPart(v), nvPart), cabin.glare.y);
  } else if (instrument) {
    refl = cabinProbeAt(in.part + nvPart * 0.002, reflect(-dirPart(v), nvPart), 0.14);
  } else {
    // Bare glass mirrors the cabin; each pane is drawn where it is, so the two panes' images lie a little
    // apart (the doubled reflection of a real window).
    refl = cabinRadianceAlong(in.world + nv * 0.002, in.part + nvPart * 0.002, reflect(-v, nv), amb);
  }
  // info.y: reflectance of the pane relative to bare glass (the displays' coated cover glass is lower).
  var add = refl * (2.0 * F * in.info.y);
  // The film of dust on the cabin side scatters the sun that shines through it toward the eye.
  let sunN = dot(frame.sunDir.xyz, -n);
  if (sunN > 0.0 && cabin.sun.w > 0.0) {
    // The pane lies in its window's aperture: only the windows clip the light that reaches it.
    let lit = sunThroughWindows(in.part).rgb;
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

/**
 * The window panes in the cabin probe: what comes in through them (the environment probe along the ray
 * from the cabin's centre, plus the window's share of the entry plasma), as emitters (alpha 0). Vertex
 * buffer: the glass panes of feature.ts (the window panes only are drawn).
 */
export const PROBE_WINDOW_WGSL = (decls: string): string => /* wgsl */ `
${HEAD(decls)}
${PROBE_FACE_WGSL}
struct VOut { @builtin(position) clip: vec4f, @location(0) part: vec3f, @location(1) @interpolate(flat) window: u32 }
@vertex fn vs(@location(0) pos: vec3f, @location(3) info: vec2f) -> VOut {
  var o: VOut;
  o.clip = probeFace.viewProj * vec4f(pos, 1.0);
  o.part = pos;
  o.window = u32(info.x + 0.5);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let d = dirRoot(normalize(in.part - cabin.probe.xyz));
  let P = cabin.polys[min(in.window, MAX_CABIN_POLYS - 1u)];
  let L = (textureSampleLevel(envProbeCube, linearClamp, d, 0.0).rgb + cabin.plasma.rgb * P.p2.w) * P.radiance.rgb;
  return vec4f(min(L / cabin.probe.w, vec3f(60000.0)), 0.0);
}
`;

/**
 * Mips of the cabin probe: every level is the level above seen through a small disc of directions (eight
 * taps about each texel's direction, sampled across the cube's faces), so level k holds the cabin blurred
 * for a lobe 2^k texels wide. Group 0: the previous level as a cube, the level to write (all six faces).
 */
export const PROBE_MIPS_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
${CUBE_DIR_WGSL}
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  var sum = vec4f(0.0);
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982 + 0.39;
    let r = select(0.45, 0.9, (k & 1) == 1);
    let uv = (vec2f(id.xy) + 0.5 + vec2f(cos(a), sin(a)) * r) / vec2f(size);
    sum += textureSampleLevel(src, smp, cubeDir(id.z, uv), 0.0);
  }
  textureStore(dst, id.xy, id.z, sum / 8.0);
}
`;

/**
 * The probe's bounce light as irradiance: nine spherical-harmonic coefficients (rgb, lux) of the luminance
 * of the probe's reflecting surfaces (emitters are left out, they reach surfaces as polygon sources; sunlit
 * surfaces are in: the sun patches' bounce), convolved with the cosine lobe, written behind the ambient
 * pass's output. Group 0: the probe's bounce map (probe.ts: block means of rgb x alpha, six faces), the
 * cabin's ambient buffer, the pass's parameters.
 */
export const PROBE_SH_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> outAmb: array<vec4f, ${AMBIENT_VEC4S}>;
struct ProbeParams { scale: vec4f }   // x = cd/m^2 per stored unit, y = share of the new value (temporal filter)
@group(0) @binding(2) var<uniform> params: ProbeParams;
${CUBE_DIR_WGSL}
var<workgroup> acc: array<array<vec3f, 9>, 64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(src).x;
  let texels = size * size * 6u;
  let per = texels / 64u;
  var s: array<vec3f, 9>;
  for (var k = 0u; k < 9u; k++) { s[k] = vec3f(0.0); }
  for (var i = 0u; i < per; i++) {
    let t = li * per + i;
    let face = t / (size * size);
    let r = t % (size * size);
    let px = vec2u(r % size, r / size);
    let uv = (vec2f(px) + 0.5) / f32(size);
    let c = textureLoad(src, px, face, 0);
    let d = cubeDir(face, uv);
    let q = uv * 2.0 - 1.0;
    // Solid angle of the texel.
    let w = 4.0 / (f32(size * size) * pow(1.0 + dot(q, q), 1.5));
    let L = c.rgb * w;
    s[0] += L * 0.282095;
    s[1] += L * (0.488603 * d.y);
    s[2] += L * (0.488603 * d.z);
    s[3] += L * (0.488603 * d.x);
    s[4] += L * (1.092548 * d.x * d.y);
    s[5] += L * (1.092548 * d.y * d.z);
    s[6] += L * (0.315392 * (3.0 * d.z * d.z - 1.0));
    s[7] += L * (1.092548 * d.x * d.z);
    s[8] += L * (0.546274 * (d.x * d.x - d.y * d.y));
  }
  acc[li] = s;
  workgroupBarrier();
  if (li == 0u) {
    // Cosine-lobe convolution (pi, 2 pi / 3, pi / 4) and the basis constants of the evaluation (cabinBounce).
    var K = array<f32, 9>(0.886227, 1.023328, 1.023328, 1.023328, 0.858086, 0.858086, 0.247708, 0.858086, 0.429043);
    for (var k = 0u; k < 9u; k++) {
      var sum = vec3f(0.0);
      for (var j = 0u; j < 64u; j++) { sum += acc[j][k]; }
      let now = sum * (K[k] * params.scale.x);
      let b = ${2 + MAX_CABIN_POLYS}u + k;
      outAmb[b] = vec4f(mix(outAmb[b].xyz, now, params.scale.y), 0.0);
    }
  }
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
