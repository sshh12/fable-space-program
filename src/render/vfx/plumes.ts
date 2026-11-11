/**
 * Engine and thruster plumes: analytic jets marched at half resolution inside a bounding box per cluster.
 * The WGSL field below is the same code for the march and for the density slices the tests measure.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { PlumeCluster } from './clusters';
import type { VfxCommon } from './common';
import { BULK_SLOPE, type JetShape } from './plumeModel';

/** Frequency of the large eddies of a jet in air, in the coordinates in which the jet has radius 1 (tiles per unit). */
const EDDY_FREQUENCY = 0.3;
/** The eddies ride down the jet at this fraction of the speed of the fine turbulence. */
const EDDY_SPEED = 0.4;

export const MAX_PLUME_INSTANCES = 64;
export const MAX_PLUME_NOZZLES = 256;
const INSTANCE_FLOATS = 84;
const NOZZLE_FLOATS = 28;
/** March steps of an engine cluster and of an RCS jet at quality 1. */
export const PLUME_STEPS = 28;
/** A free expansion is smooth (no cells, no eddies): it is marched with this much fewer steps. */
export const FAR_STEPS_SAVED = 0.57;
export const RCS_STEPS = 14;
/**
 * A plume that covers more of the frame than this is marched with fewer steps per ray (down to STEPS_FLOOR
 * of them, as 1 / sqrt(coverage)): seen from close up there are more rays through every eddy, and the cost
 * of a plume that fills the view stays bounded.
 */
export const STEPS_FULL_COVERAGE = 0.06;
export const STEPS_FLOOR = 0.6;

/** A cluster placed in the frame: origin and axes camera-relative in ROOT axes. */
export interface PlacedCluster {
  cluster: PlumeCluster;
  originRelCam: Vec3;
  axisX: Vec3;
  axisY: Vec3;
  axisZ: Vec3;
  /** Nozzle exits and directions in the cluster frame. */
  nozzlePos: Vec3[];
  nozzleDir: Vec3[];
  /** Light probe index for sun scattering. */
  probe: number;
}

export const PLUME_FIELD_WGSL = /* wgsl */ `
const BULK_SLOPE = ${BULK_SLOPE};
struct PlumeInstance {
  origin: vec4f,       // xyz = cluster origin relative to the camera (ROOT axes), w = length of the box along +X (m)
  axisX: vec4f,        // xyz = +X (mean exhaust direction), w = radius of the box about X (m)
  axisY: vec4f,        // xyz = +Y, w = start of the box along X (m, <= 0)
  axisZ: vec4f,        // xyz = +Z, w = nozzle count
  coreColor: vec4f,    // rgb = core colour x luminance (cd/m^2 seen through the exit diameter), w = core radius / boundary radius
  diamondColor: vec4f, // rgb = Mach-disc colour x core luminance, w = gain
  shearColor: vec4f,   // rgb = shear-layer colour x luminance, w = e-folding number of shock cells
  afterColor: vec4f,   // rgb = flame colour x luminance, w = density exponent of the core emission
  smoke: vec4f,        // rgb = albedo x scattering optical depth per exit diameter, w = extinction optical depth per exit diameter
  flashColor: vec4f,   // rgb = start-up puff colour x core luminance, w = first nozzle index
  noise: vec4f,        // x = 1 / feature size (1/m), y = amount 0..1, z = scroll along +X (m, wrapped), w = march steps
  merged0: vec4f,      // x = distance where the jets merge (1e30 = never), y = merged exit radius, z = merged emission scale, w = merged throttle
  merged1: vec4f,      // merged jet: tan(theta), Lexp, mixing slope, mixing development length
  merged2: vec4f,      // merged jet: core and shear e-folding lengths, flame length (m), oxygen factor
  light: vec4f,        // x = light probe index, y = share of the particulates spread over the whole jet (the rest follows the core), z = their decay along the jet (1/m), w = largest exit radius (m)
  extra: vec4f,        // x, y = bounding cone about +X: radius = x + y * distance along X; z = core emission far from the nozzle as a fraction of that at the exit (thin gas radiates little), w = distance over which it gets there (m)
  farColor: vec4f,     // rgb = albedo x scattering optical depth per exit diameter of the condensed exhaust of a free expansion, w = exponent of its angular distribution
  sun: vec4f,          // xyz = unit direction to the sun in the cluster frame, w = strength of the radial striations of a free expansion
  glowColor: vec4f,    // rgb = colour x luminance of an opaque column of incandescent particulates at the exit, w = 1 / their cooling length (1/m)
  misc2: vec4f,        // x = exponent of the thinning of the particulates with the jet's radius, y = frequency of the large eddies in jet coordinates, z = 1 when the cluster is a free expansion (striations instead of eddies), w = scroll of the eddies (jet coordinates, wrapped)
  merged3: vec4f,      // merged jet: free-expansion weight 0..1, on-axis density factor, pi / (2 limiting angle), unused
}
struct PlumeNozzle {
  posRe: vec4f,        // xyz = exit centre in the cluster frame, w = exit radius (m)
  dirThr: vec4f,       // xyz = unit exhaust direction (cluster frame), w = emission throttle 0..1
  shape: vec4f,        // tan(theta), Lexp (m), mixing slope, mixing development length (m)
  cells: vec4f,        // shock-cell spacing (m), cell amplitude 0..1, core e-folding length (m), oxygen factor 0..1
  lens: vec4f,         // shear length (m), flame length (m), start-up front distance (m), start-up puff gain
  misc: vec4f,         // x = seed, y = residual flame 0..1, z = shift of the shock cells (cell lengths), w = flicker gain
  far: vec4f,          // free-expansion weight 0..1, on-axis density factor, pi / (2 limiting angle), radius of the start-up puff (m)
}

struct JetGeom {
  x: f32,      // distance along the jet from the exit plane (m)
  r: f32,      // distance from the axis (m)
  rb: f32,     // boundary radius: half-density contour (m)
  mixing: f32, // thickness the mixing layer has added (m)
  dil: f32,    // relative gas density (re / rb)^2
  edge: f32,   // 1 inside the jet .. 0 outside, 0.5 on the boundary
}
/// Geometry of a jet: boundary r(x) = re + Lexp tan(theta) (1 - exp(-x / Lexp)) + mixing layer (zero slope at the lip).
fn jetGeom(pos: vec3f, dir: vec3f, re: f32, shape: vec4f, p: vec3f) -> JetGeom {
  var g: JetGeom;
  let d = p - pos;
  g.x = dot(d, dir);
  let xc = max(g.x, 0.0);
  g.r = length(d - dir * g.x);
  let inviscid = re + shape.y * shape.x * (1.0 - exp(-xc / shape.y));
  g.mixing = shape.z * (xc - shape.w * (1.0 - exp(-xc / shape.w)));
  g.rb = max(inviscid + g.mixing, 0.08 * re);
  g.dil = sq(re / g.rb);
  let sig = 0.05 * re + 0.6 * g.mixing + 0.12 * max(g.rb - re, 0.0);
  g.edge = 1.0 - smoothstep(g.rb - 1.5 * sig, g.rb + 1.5 * sig, g.r);
  return g;
}

struct JetOut {
  e: vec3f,     // emission, cd/m^2 per metre of path
  s: f32,       // extinction, 1/m
  sc: vec3f,    // scattering coefficient x albedo, 1/m (multiply by the ambient illuminance / 4 pi)
  scs: vec3f,   // the same times the transmittance towards the sun (multiply by the sun illuminance / 4 pi)
  gas: f32,     // relative gas density (for density slices)
  core: f32,    // relative core density including the shock cells (for density slices)
}
fn jetZero() -> JetOut { return JetOut(vec3f(0.0), 0.0, vec3f(0.0), vec3f(0.0), 0.0, 0.0); }

/// One jet. 'n' / 'n2' = coarse and fine noise samples drawn out along the flow, 'nS' = noise that is constant
/// along a streamline of a free expansion; 0..1 per channel, 0.5 = none. 'fp' = sample spacing along the ray
/// (m; negative: no noise at all, for the density slices).
/// 'k0' = throttle / (2 re of one nozzle) x scale.
/// 'vary' = x: shift of the shock cells in cell lengths, y = flicker gain (each nozzle has its own).
/// 'farv' = free-expansion weight, on-axis density factor, pi / (2 limiting angle), radius of the start-up puff.
fn jetSample(inst: PlumeInstance, pos: vec3f, dir: vec3f, re: f32, shape: vec4f, cells: vec4f, lens: vec4f, vary: vec2f, farv: vec4f, k0: f32, p: vec3f, n: vec4f, n2: vec4f, nS: vec4f, fp: f32) -> JetOut {
  let g = jetGeom(pos, dir, re, shape, p);
  let xc = max(g.x, 0.0);
  var o = jetZero();
  let far = farv.x;
  // The large eddies of a jet in air: noise in coordinates in which the jet is a cylinder of radius 1 (they are
  // as large as the jet wherever they are, and ride down it). A free expansion has striations instead.
  var n3 = nS;
  if (far < 0.999 && fp >= 0.0) {
    let slope = max(shape.x, 0.0) + shape.z + 0.04;
    let rc = 1.5 * re + slope * xc;
    var e1 = cross(dir, vec3f(0.0, 0.0, 1.0));
    if (dot(e1, e1) < 0.01) { e1 = cross(dir, vec3f(0.0, 1.0, 0.0)); }
    e1 = normalize(e1);
    let dd = p - pos;
    let q = vec3f(log(1.0 + slope * xc / (1.5 * re)) / slope - inst.misc2.w, dot(dd, e1) / rc, dot(dd, cross(dir, e1)) / rc);
    n3 = vfxNoiseLod(q * inst.misc2.y + vec3f(0.19, 0.43, 0.71) + vec3f(0.37 * vary.x), fp / rc * inst.misc2.y * 0.1);
  }
  // Start-up: a puff of burning propellant that leaves the nozzle and expands in every direction, soft on all
  // sides, wispy, thinner as it grows (its light falls with the square root of the cube of its radius).
  if (lens.w > 0.001) {
    let rp = farv.w;
    let dq = (p - (pos + dir * (0.5 * rp))) / rp;
    let q2 = dot(dq, dq) * (1.0 + 1.1 * (n.r - 0.5) + 0.6 * (n3.g - 0.5));
    if (q2 < 7.0) {
      let wisp = (0.3 + 1.4 * n.g) * (0.55 + 0.9 * n2.b);
      o.e = inst.flashColor.rgb * (lens.w * (0.565 / re) * pow(re / rp, 2.5) * exp(-q2) * wisp);
    }
  }
  if (g.x < -0.4 * re || g.r > 2.6 * g.rb + 2.0 * re) { return o; }
  let inlet = smoothstep(-0.4 * re, 0.3 * re, g.x);
  let front = 1.0 - smoothstep(lens.z - 2.0 * re, lens.z + 2.0 * re, g.x);
  let k = k0 * inlet * front * vary.y;
  // Turbulence grows downstream of the nozzle: ragged edges and filaments, then eddies as large as the jet.
  let turb = saturate(xc / (10.0 * re)) * inst.noise.y;
  let grow = saturate(xc / (14.0 * re)) * (1.0 - far);
  let big = clamp((n3.r - 0.5) * 4.5, -1.0, 1.0);
  let rr = g.r * (1.0 + ((n.r - 0.5) * 0.7 + (n2.b - 0.5) * 0.3) * turb);
  let fil = mix(1.0, (0.25 + 1.5 * n.g) * (0.45 + 1.1 * n2.b), min(1.0, turb * 1.4));

  // Core: emission follows the gas density and decays along the jet; shock cells brighten it at the Mach
  // discs. A jet that balloons keeps its gas around the axis (bulk radius), the boundary holds a thin halo.
  let rBulk = min(g.rb, 2.0 * re + BULK_SLOPE * xc);
  let cr = inst.coreColor.w * rBulk;
  let coreProfile = exp(-sq(g.r / cr));
  let dens = pow(sq(re / rBulk), inst.afterColor.w);
  let axial = exp(-xc / cells.z);
  // Shock cells: a Mach disc at u = 0.75 + k (u = distance in cell lengths): a thin bright plate across the
  // core, the diamond of hot gas that tapers behind it between the reflected shocks, and the converging
  // shocks that brighten the core just ahead of the next disc. The cells of one nozzle end before the jets merge.
  let u = max(xc / cells.x - vary.x, 0.0) + (n.a - 0.5) * turb * 0.25;
  let decay = exp(-max(u - 0.75, 0.0) / inst.shearColor.w) * (1.0 - smoothstep(0.5 * inst.merged0.x, 0.9 * inst.merged0.x, g.x));
  let sc = fract(u - 0.75);
  let on = step(0.75, u);
  let lead = smoothstep(0.8, 1.0, sc);
  let tail = exp(-3.5 * sc) * on;
  let env = max(0.8 * cr * (max(1.0 - 1.3 * sc, 0.0) * on + lead), 0.04 * cr);
  let diamond = 1.0 - smoothstep(0.7 * env, 1.08 * env, g.r);
  let plate = exp(-25.0 * sc) * on * (1.0 - smoothstep(0.5 * cr, 0.62 * cr, g.r));
  let disc = cells.y * decay * ((tail + 0.7 * lead) * diamond + 1.5 * plate);
  // An over- or under-expanded jet is dim where it leaves the nozzle and lights up at the first shock.
  let ramp = mix(1.0, 0.3 + 0.7 * smoothstep(0.0, 0.75, u), cells.y);
  // Close to the nozzle the gas is as dense and hot as at the exit whatever the ambient pressure; further
  // out a jet that expands into (near) vacuum radiates only a fraction of that.
  let thin = mix(1.0, inst.extra.z, 1.0 - exp(-xc / inst.extra.w));
  let eColumn = inst.coreColor.rgb * (k * thin * dens * coreProfile * axial * ramp * mix(1.0, 0.5 + n.g, turb))
      + inst.diamondColor.rgb * (k * thin * dens * axial * disc * inst.diamondColor.w);
  o.gas = g.dil * g.edge;
  o.core = sq(re / rBulk) * coreProfile * (ramp + disc * inst.diamondColor.w);

  // Free expansion (high altitude, vacuum, thrusters): the gas leaves a point one exit radius inside the nozzle
  // along straight streamlines, density ~ (re / R)^2 cos^k of the scaled angle. Nothing closes it: where the
  // ambient pressure still holds the jet the boundary of jetGeom does, in vacuum nothing does. The gas glows
  // by collisions (density squared: a small brilliant core at the exit) and its condensate scatters sunlight
  // (density: a fan that fades with distance and has no edge).
  var dFar = 0.0;
  if (far > 0.001) {
    let q = p - (pos - dir * re);
    let R = max(length(q), re);
    let ang = acos(clamp(dot(q, dir) / R, -1.0, 1.0)) * farv.z;
    if (ang < 1.5707) {
      let stri = 1.0 + inst.sun.w * big * saturate(R / (8.0 * re) - 0.25);
      dFar = min(1.0, farv.y * sq(re / R) * pow(cos(ang), inst.farColor.w)) * g.edge * stri * inlet;
    }
  }
  let eFar = inst.coreColor.rgb * (k0 * front * vary.y * (dFar * dFar + inst.extra.z * dFar * exp(-xc / cells.z)));
  o.e += mix(eColumn, eFar, far);

  // Afterburning with ambient air: a thin ring in the shear layer, then the turbulent flame: it fills the jet
  // downstream of the potential core, is pushed about by eddies as large as the jet, cools from the colour of
  // the look towards deep orange and ends in a ragged tip at the flame length.
  let ox = cells.w;
  if (ox > 0.002) {
    let ringW = 0.08 * re + 0.4 * g.mixing + 0.14 * max(g.rb - re, 0.0);
    let ring = exp(-sq((rr - (g.rb - 0.35 * g.mixing)) / ringW)) * sqrt(min(2.0, 0.25 * re / ringW));
    o.e += inst.shearColor.rgb * (k * ox * ring * smoothstep(0.0, 2.5 * re, xc) * exp(-xc / lens.x) * fil);
    let s = xc / lens.y;
    let tip = 1.0 - smoothstep(0.45, 1.0, s + (n3.r - 0.5) * 1.3 * grow + (n3.a - 0.5) * 0.5 * grow + (n.r - 0.5) * 0.3 * turb);
    if (tip > 0.0) {
      let rf = g.rb * (1.0 + 0.55 * big * grow);
      let body = 1.0 - smoothstep(0.4 * rf, 1.12 * rf, rr);
      let begin = smoothstep(4.0 * re, 16.0 * re, xc);
      let cool = mix(vec3f(1.0), vec3f(1.0, 0.6, 0.3), saturate(1.25 * s));
      let tex = mix(1.0, (0.45 + 1.1 * n3.b) * (0.6 + 0.8 * n.g) * (0.75 + 0.5 * n2.b), min(1.0, grow + turb));
      // The middle of the flame is the hottest and brightest (white-yellow); its skin is the colour of the look.
      let heart = saturate(1.4 * body - 0.45) * (1.0 - saturate(1.2 * s));
      let colour = mix(inst.afterColor.rgb * cool, vec3f(1.9, 1.7, 1.25) * luminance(inst.afterColor.rgb), heart);
      o.e += colour * (1.3 * k * ox * body * tip * begin * sqrt(g.dil) * tex);
    }
  }

  // Particulates: extinction, sunlight scattering and (solid motors) their own incandescence. In a column they
  // follow the gas density (bulk and halo) out to a boundary that billows with the large eddies; in a free
  // expansion they ride with the gas. They thin out along the jet.
  let halo = inst.light.y;
  let rrS = rr - 0.45 * big * grow * g.rb;
  let sig = 0.05 * re + 0.6 * g.mixing + 0.12 * max(g.rb - re, 0.0);
  let ragged = 1.0 - smoothstep(g.rb - 1.5 * sig, g.rb + 1.5 * sig, rrS);
  let lump = mix(1.0, 0.3 + 1.4 * n.g, turb) * mix(1.0, 0.3 + 1.4 * n3.g, grow);
  let along = exp(-xc * inst.light.z);
  // (Gas thins with the square of the jet's radius; the smoke of a solid motor keeps condensing and stays opaque: its own exponent.)
  let spread = pow(re / g.rb, inst.misc2.x);
  let partColumn = ((1.0 - halo) * sq(re / rBulk) * exp(-sq(rrS / (1.3 * cr))) + halo * spread * ragged) * lump;
  let part = k * mix(partColumn, dFar, far) * along;
  o.s = inst.smoke.w * part;
  o.sc = inst.smoke.rgb * part + inst.farColor.rgb * (k * dFar * far * along);
  // The side of a smoky jet that faces the sun is lit, the other side is in the jet's own shade: optical depth
  // of the mean column along the chord from here to the boundary, towards the sun.
  let off = (p - pos) - dir * g.x;
  let sunP = inst.sun.xyz - dir * dot(inst.sun.xyz, dir);
  let sl = max(length(sunP), 0.25);
  let b = dot(off, sunP) / sl;
  let rs = max(g.rb, g.r);
  let chord = (sqrt(max(rs * rs - g.r * g.r + b * b, 0.0)) - b) / sl;
  let meanExt = inst.smoke.w * k * mix((1.0 - halo) * 0.4 * sq(re / rBulk) + halo * spread, dFar, far) * along;
  o.scs = o.sc * exp(-meanExt * chord);
  let cooled = 1.0 - exp(-2.0 * xc * inst.glowColor.w);
  // (In a free expansion the particulates cool by radiation alone and nothing burns after them: their glow goes with the density.)
  // (They cool faster and faster: beyond two cooling lengths nothing of the glow is left in the smoke.)
  o.e += inst.glowColor.rgb * mix(vec3f(1.0), vec3f(1.0, 0.5, 0.16), cooled) * (exp(-sq(xc * inst.glowColor.w / 1.5)) * mix(1.0, dFar, far) * o.s);
  return o;
}

fn jetAdd(a: JetOut, b: JetOut, w: f32) -> JetOut {
  return JetOut(a.e + b.e * w, a.s + b.s * w, a.sc + b.sc * w, a.scs + b.scs * w, a.gas + b.gas * w, a.core + b.core * w);
}

/// All jets of a cluster at point 'p' of the cluster frame: the separate jets near the nozzles, blended into
/// one merged jet downstream of the merge distance.
fn plumeField(inst: PlumeInstance, p: vec3f, n: vec4f, n2: vec4f, nS: vec4f, fp: f32) -> JetOut {
  var o = jetZero();
  // Everything fades to nothing at the bounding cone and at the reach of the cluster (no visible cut).
  let bound = inst.extra.x + inst.extra.y * max(p.x, 0.0);
  let window = (1.0 - smoothstep(0.72, 1.0, length(p.yz) / bound)) * (1.0 - smoothstep(0.75, 1.0, length(p) / inst.origin.w));
  if (window <= 0.0) { return o; }
  let xm = inst.merged0.x;
  let w = smoothstep(xm, 1.5 * xm, p.x);
  // The jets of a cluster that merges are thin where they are still apart: their large eddies belong to the
  // merged jet (and are looked up once there, not once per nozzle).
  let fpN = select(fp, -1.0, xm < 1e20 && fp >= 0.0);
  if (w < 0.999) {
    let first = u32(inst.flashColor.w);
    let count = u32(inst.axisZ.w);
    for (var i = 0u; i < count; i++) {
      let nz = plumeNozzles[first + i];
      if (nz.dirThr.w <= 0.0 && nz.lens.w <= 0.001) { continue; }
      // Most samples lie outside most jets: a cone that holds this jet's reach (its boundary never grows faster
      // than its lip angle plus the mixing slope) rejects them before any of the jet's shape is worked out.
      if (nz.lens.w <= 0.001) {
        let dq = p - nz.posRe.xyz;
        let along = dot(dq, nz.dirThr.xyz);
        let reach = 4.6 * nz.posRe.w + 2.6 * (max(nz.shape.x, 0.0) + nz.shape.z) * max(along, 0.0);
        if (along < -0.4 * nz.posRe.w || dot(dq, dq) - along * along > reach * reach) { continue; }
      }
      // Neighbouring jets flicker independently: odd seeds swap the two Perlin channels.
      let nn = select(n, n.agbr, (u32(nz.misc.x) & 1u) == 1u);
      o = jetAdd(o, jetSample(inst, nz.posRe.xyz, nz.dirThr.xyz, nz.posRe.w, nz.shape, nz.cells, nz.lens, nz.misc.zw, nz.far, nz.dirThr.w / (2.0 * nz.posRe.w), p, nn, n2, nS, fpN), 1.0 - w);
    }
  }
  if (w > 0.001) {
    let cells = vec4f(1.0, 0.0, inst.merged2.x, inst.merged2.w);
    let lens = vec4f(inst.merged2.y, inst.merged2.z, 1e9, 0.0);
    o = jetAdd(o, jetSample(inst, vec3f(0.0), vec3f(1.0, 0.0, 0.0), inst.merged0.y, inst.merged1, cells, lens, vec2f(0.0, 1.0), inst.merged3, inst.merged0.w * inst.merged0.z / (2.0 * inst.light.w), p, n, n2, nS, fp), w);
  }
  o.e *= window;
  o.s *= window;
  o.sc *= window;
  o.scs *= window;
  return o;
}
`;

const MARCH_WGSL = /* wgsl */ `
#include "vfx_common"
@group(2) @binding(0) var<storage, read> plumeInstances: array<PlumeInstance>;
@group(2) @binding(1) var<storage, read> plumeNozzles: array<PlumeNozzle>;
${PLUME_FIELD_WGSL}

const CUBE_IDX = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);

/// Noise coordinates are compressed along the jet: eddies become streaks about three times as long as wide.
const STREAK = vec3f(0.34, 1.0, 1.0);

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) inst: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let inst = plumeInstances[ii];
  let ci = CUBE_IDX[vi];
  let c = vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u));
  let l = vec3f(mix(inst.axisY.w, inst.origin.w, c.x), (c.y * 2.0 - 1.0) * inst.axisX.w, (c.z * 2.0 - 1.0) * inst.axisX.w);
  let world = inst.origin.xyz + inst.axisX.xyz * l.x + inst.axisY.xyz * l.y + inst.axisZ.xyz * l.z;
  var o: VOut;
  o.pos = frame.viewProjUnjittered * vec4f(world, 1.0);
  o.inst = ii;
  return o;
}

struct FOut {
  @location(0) color: vec4f,    // premultiplied pre-exposed radiance, a = opacity
  @location(1) moment: vec4f,   // r = weight x log2(distance), g = weight
}
@fragment fn fs(in: VOut) -> FOut {
  let inst = plumeInstances[in.inst];
  let uv = in.pos.xy * vfx.half.zw;
  let ray = viewRay(uv);
  let rayLen = length(ray);
  let dW = ray / rayLen;
  let tScene = viewZFromDepth(textureLoad(sceneDepthHalfTex, vec2i(in.pos.xy), 0).r) * rayLen;
  let o3 = inst.origin.xyz;
  let ro = -vec3f(dot(o3, inst.axisX.xyz), dot(o3, inst.axisY.xyz), dot(o3, inst.axisZ.xyz));
  var rd = vec3f(dot(dW, inst.axisX.xyz), dot(dW, inst.axisY.xyz), dot(dW, inst.axisZ.xyz));
  rd = select(rd, vec3f(1e-7), abs(rd) < vec3f(1e-7));
  let bmin = vec3f(inst.axisY.w, -inst.axisX.w, -inst.axisX.w);
  let bmax = vec3f(inst.origin.w, inst.axisX.w, inst.axisX.w);
  let ta = (bmin - ro) / rd;
  let tb = (bmax - ro) / rd;
  let tmn = min(ta, tb);
  let tmx = max(ta, tb);
  var t0 = max(max(tmn.x, max(tmn.y, tmn.z)), 0.0);
  var t1 = min(min(tmx.x, min(tmx.y, tmx.z)), tScene);
  // The bounding cone r = r0 + s x is much tighter than the box for a narrow jet: march only inside it.
  let cs = inst.extra.y;
  let cr0 = inst.extra.x + cs * ro.x;
  let qa = rd.y * rd.y + rd.z * rd.z - cs * cs * rd.x * rd.x;
  // (A fan wider than about 35 degrees is left to the box: its cone would cut what lies beside the nozzles.)
  if (qa > 1e-3 && cs < 0.7) {
    let qb = ro.y * rd.y + ro.z * rd.z - cs * cr0 * rd.x;
    let qc = ro.y * ro.y + ro.z * ro.z - cr0 * cr0;
    let disc = qb * qb - qa * qc;
    if (disc <= 0.0) { t1 = t0; }
    else {
      let sq_ = sqrt(disc);
      t0 = max(t0, (-qb - sq_) / qa);
      t1 = min(t1, (-qb + sq_) / qa);
    }
  }
  var out: FOut;
  out.color = vec4f(0.0);
  out.moment = vec4f(0.0);
  if (t1 <= t0) { return out; }

  // Steps grow exponentially with the distance from the point of the ray nearest to the nozzles, where the
  // jets are thin and the shock cells are; d0 is the step scale there.
  let tc = -dot(ro, rd);
  let dc = length(ro + rd * tc);
  let d0 = max(0.75 * inst.light.w, 0.3 * dc);
  let s0 = t0 - tc;
  let s1 = t1 - tc;
  let w0 = sign(s0) * log(1.0 + abs(s0) / d0);
  let w1 = sign(s1) * log(1.0 + abs(s1) / d0);
  let steps = max(8.0, floor(inst.noise.w * vfx.time.w + 0.5));
  let jitter = blueNoise(vec2u(in.pos.xy)).r;
  let sun = vfxProbes[u32(inst.light.x)].sun.rgb * (1.0 / (4.0 * PI));
  let ambient = vfxProbeAmbient(u32(inst.light.x)) * (1.0 / (4.0 * PI));
  let scroll = vec3f(inst.noise.z, 0.0, 0.0);


  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let w = mix(w0, w1, (i + jitter) / steps);
    let ew = exp(abs(w));
    let t = tc + sign(w) * d0 * (ew - 1.0);
    let dt = d0 * ew * (w1 - w0) / steps;
    let p = ro + rd * t;
    // Turbulent structure is drawn out along the flow; the footprint is a fraction of the step (the jitter
    // and the temporal filter take care of what that leaves under-sampled along the ray).
    // (A free expansion has no turbulence to look up: its two samples are spared.)
    var n = vec4f(0.5);
    var n2 = vec4f(0.5);
    if (inst.noise.y > 0.08) {
      n = vfxNoiseLod((p - scroll) * (inst.noise.x * STREAK), dt * inst.noise.x * 0.3);
      n2 = vfxNoiseLod((p - scroll * 1.7) * (inst.noise.x * 2.9 * STREAK) + vec3f(0.37, 0.11, 0.73), dt * inst.noise.x * 0.6);
    }
    // A free expansion has faint striations along its streamlines: noise that depends on the direction from the nozzles only.
    var nS = vec4f(0.5);
    if (inst.misc2.z > 0.5) { nS = vfxNoiseLod(normalize(p + vec3f(inst.light.w, 0.0, 0.0)) * 1.3 + vec3f(0.31, 0.57, 0.11), 0.0); }
    let f = plumeField(inst, p, n, n2, nS, dt);
    let od = f.s * dt;
    let stepT = exp(-od);
    let src = f.e + f.scs * sun + f.sc * ambient;
    let c = src * select(dt, (1.0 - stepT) / max(f.s, 1e-9), od > 1e-4);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * t;
    T *= stepT;
    if (T < 0.004) { break; }
  }
  let tMean = clamp(tsum / max(wsum, 1e-20), t0, t1);
  // Fine structure: two more octaves of streaks, looked up where the light of this ray comes from on average
  // (they ride with the gas, and are finer than the march could resolve along the ray).
  let pm = ro + rd * tMean;
  let fineScale = inst.noise.x * 6.5;
  let pixel = 2.0 * tMean * frame.cameraUp.w * vfx.half.w;
  let d1 = vfxNoiseLod((pm - scroll * 2.3) * (fineScale * STREAK) + vec3f(0.61, 0.23, 0.05), pixel * fineScale);
  let d2 = vfxNoiseLod((pm - scroll * 3.1) * (fineScale * 2.7 * STREAK) + vec3f(0.13, 0.77, 0.41), pixel * fineScale * 2.7);
  let grown = saturate(max(pm.x, 0.0) / (5.0 * inst.light.w)) * inst.noise.y;
  L *= mix(1.0, (0.7 + 0.6 * d1.g) * (0.8 + 0.4 * d2.b), min(1.0, 1.5 * grown));
  let rgb = min(L * frame.exposure.x, vec3f(HDR_MAX * 0.25));
  let c = vfxAtmosphere(uv, tMean, rgb, 1.0 - T);
  out.color = vec4f(writeHdr(c.rgb), saturate(c.a));
  let lum = luminance(out.color.rgb);
  let mw = saturate(max(out.color.a, lum / (lum + 1.0)));
  out.moment = vec4f(mw * log2(max(tMean, 1e-3)), mw, 0.0, 0.0);
  return out;
}
`;

const SLICE_WGSL = /* wgsl */ `
#include "vfx_common"
@group(2) @binding(0) var<storage, read> plumeInstances: array<PlumeInstance>;
@group(2) @binding(1) var<storage, read> plumeNozzles: array<PlumeNozzle>;
struct SliceU { range: vec4f, pick: vec4f }   // range: x0, x1 (m along the jet), r half-extent (m), unused; pick: instance, nozzle (-1 = whole cluster)
@group(3) @binding(0) var<uniform> slice: SliceU;
${PLUME_FIELD_WGSL}
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let inst = plumeInstances[u32(slice.pick.x)];
  let x = mix(slice.range.x, slice.range.y, in.uv.x);
  let r = (in.uv.y * 2.0 - 1.0) * slice.range.z;
  var f: JetOut;
  if (slice.pick.y >= 0.0) {
    let nz = plumeNozzles[u32(inst.flashColor.w) + u32(slice.pick.y)];
    var perp = cross(nz.dirThr.xyz, vec3f(0.0, 0.0, 1.0));
    if (dot(perp, perp) < 1e-6) { perp = cross(nz.dirThr.xyz, vec3f(0.0, 1.0, 0.0)); }
    let p = nz.posRe.xyz + nz.dirThr.xyz * x + normalize(perp) * r;
    f = jetSample(inst, nz.posRe.xyz, nz.dirThr.xyz, nz.posRe.w, nz.shape, nz.cells, nz.lens, nz.misc.zw, nz.far, nz.dirThr.w / (2.0 * nz.posRe.w), p, vec4f(0.5), vec4f(0.5), vec4f(0.5), -1.0);
  } else {
    f = plumeField(inst, vec3f(x, r, 0.0), vec4f(0.5), vec4f(0.5), vec4f(0.5), -1.0);
  }
  return vec4f(f.gas, f.core, luminance(f.e), 1.0);
}
`;

const put = (f: Float32Array, o: number, x: number, y: number, z: number, w: number): void => {
  f[o] = x;
  f[o + 1] = y;
  f[o + 2] = z;
  f[o + 3] = w;
};
const shapeVec = (f: Float32Array, o: number, s: JetShape): void => put(f, o, s.tanTheta, s.lExp, s.mixSlope, s.mixDev);

export interface PlumeSlice {
  width: number;
  height: number;
  /** Extent of the slice: x from x0 to x1 along the jet (columns), radius from -rMax to +rMax (rows), m. */
  x0: number;
  x1: number;
  rMax: number;
  /** Per pixel: relative gas density, relative core density (with shock cells), emission luminance, 1. */
  data: Float32Array;
}

export class PlumeRenderer {
  private readonly device: GPUDevice;
  private readonly instanceData = new Float32Array(MAX_PLUME_INSTANCES * INSTANCE_FLOATS);
  private readonly nozzleData = new Float32Array(MAX_PLUME_NOZZLES * NOZZLE_FLOATS);
  private readonly instanceBuffer: GPUBuffer;
  private readonly nozzleBuffer: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private slicePipeline: Tracked<GPURenderPipeline> | null = null;
  private sliceLayout: GPUBindGroupLayout | null = null;
  private count = 0;
  private placed: PlacedCluster[] = [];

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
  ) {
    const device = (this.device = ctx.device);
    this.instanceBuffer = device.createBuffer({ label: 'vfx.plume.instances', size: this.instanceData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.nozzleBuffer = device.createBuffer({ label: 'vfx.plume.nozzles', size: this.nozzleData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({
      label: 'vfx.plume',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.group = device.createBindGroup({ label: 'vfx.plume', layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.instanceBuffer } }, { binding: 1, resource: { buffer: this.nozzleBuffer } }] });
    const over: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const add: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    this.pipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.plume.march', MARCH_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.plume.march',
        layout: device.createPipelineLayout({ label: 'vfx.plume.march', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, this.layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: over }, { format: 'rg16float', blend: add }] },
        primitive: { topology: 'triangle-list', cullMode: 'front' },
      });
    });
    this.pipeline.get();
  }

  /** Pack this frame's clusters (at most MAX_PLUME_INSTANCES; nozzles beyond MAX_PLUME_NOZZLES are dropped with their cluster). */
  update(placed: PlacedCluster[], noiseTime: number, frame: FrameContext): void {
    const m = frame.projUnjittered;
    const frameSolidAngle = 4 / (m[0]! * m[5]!);
    const sunRoot = frame.sun.dirRoot;
    const I = this.instanceData;
    const N = this.nozzleData;
    let ni = 0;
    let ii = 0;
    this.placed = [];
    for (const pc of placed) {
      const c = pc.cluster;
      if (ii >= MAX_PLUME_INSTANCES || ni + c.nozzles.length > MAX_PLUME_NOZZLES) break;
      const look = c.look;
      const o = ii * INSTANCE_FLOATS;
      let reMax = 0;
      for (const nz of c.nozzles) reMax = Math.max(reMax, nz.exitRadius);
      put(I, o, pc.originRelCam.x, pc.originRelCam.y, pc.originRelCam.z, c.length);
      put(I, o + 4, pc.axisX.x, pc.axisX.y, pc.axisX.z, c.radius);
      put(I, o + 8, pc.axisY.x, pc.axisY.y, pc.axisY.z, c.xMin);
      put(I, o + 12, pc.axisZ.x, pc.axisZ.y, pc.axisZ.z, c.nozzles.length);
      const fl = look.core.luminance;
      const cl = fl;
      const vacuum = c.nozzles[0]?.shape.vacuum ?? 0;
      put(I, o + 16, look.core.color[0] * cl, look.core.color[1] * cl, look.core.color[2] * cl, look.core.radius);
      put(I, o + 20, look.diamonds.color[0] * cl, look.diamonds.color[1] * cl, look.diamonds.color[2] * cl, look.diamonds.gain);
      const sl = look.shear.luminance;
      put(I, o + 24, look.shear.color[0] * sl, look.shear.color[1] * sl, look.shear.color[2] * sl, look.diamonds.cells);
      const al = look.afterburn.luminance;
      put(I, o + 28, look.afterburn.color[0] * al, look.afterburn.color[1] * al, look.afterburn.color[2] * al, look.core.densityExponent);
      const ss = look.smoke.sunScatter;
      put(I, o + 32, look.smoke.albedo[0] * ss, look.smoke.albedo[1] * ss, look.smoke.albedo[2] * ss, look.smoke.extinction);
      put(I, o + 36, look.ignition.flashColor[0] * fl, look.ignition.flashColor[1] * fl, look.ignition.flashColor[2] * fl, ni);
      const feature = Math.max(look.noise.scaleRe * reMax, 0.05);
      // Share of the frame the luminous part of the cluster covers (its first 1.2 core lengths, side-on).
      let core = 0;
      for (const nz of c.nozzles) core = Math.max(core, nz.shape.coreLength);
      if (c.merged) core = Math.max(core, c.merged.shape.coreLength);
      const bright = Math.min(c.length, 1.2 * core);
      const mid = v3.addScaled(pc.originRelCam, pc.axisX, 0.5 * bright);
      const dist = Math.max(v3.len(mid), 1);
      const along = v3.dot(pc.axisX, mid) / dist;
      const width = 2 * Math.min(c.radius, c.coneR0 + 0.5 * c.coneSlope * bright);
      const coverage = ((bright * Math.sqrt(Math.max(0, 1 - along * along)) + width) * width) / (dist * dist) / frameSolidAngle;
      const thin = Math.min(1, Math.max(STEPS_FLOOR, Math.sqrt(STEPS_FULL_COVERAGE / Math.max(coverage, 1e-6))));
      // A free expansion has no turbulence to show (nothing to mix with): the noise fades with it.
      const far = c.nozzles[0]?.shape.far ?? 0;
      put(I, o + 40, 1 / (feature * 4), look.noise.amount * (1 - 0.9 * far), (look.noise.speed * noiseTime) % (feature * 4), c.kind === 'rcs' ? RCS_STEPS : Math.round(PLUME_STEPS * (1 - FAR_STEPS_SAVED * far) * thin));
      if (c.merged) {
        const m = c.merged;
        const thr = c.nozzles.reduce((s, nz) => s + Math.max(nz.throttle, 0.12 * nz.residual), 0) / c.nozzles.length;
        put(I, o + 44, c.mergeDistance, m.exitRadius, m.scale, thr);
        shapeVec(I, o + 48, m.shape);
        put(I, o + 52, m.shape.coreLength, m.shape.shearLength, m.shape.afterLength, m.shape.oxygen);
      } else {
        put(I, o + 44, 1e30, 1, 0, 0);
        put(I, o + 48, 0, 1, 0, 1);
        put(I, o + 52, 1, 1, 1, 0);
      }
      put(I, o + 56, pc.probe, look.smoke.halo, 1 / (look.smoke.lengthRe * reMax), reMax);
      put(I, o + 60, c.coneR0, c.coneSlope, 1 + (look.core.vacuumGain - 1) * vacuum, look.core.vacuumCoreRe * reMax);
      const fs = look.farField.scatter;
      put(I, o + 64, look.smoke.albedo[0] * fs, look.smoke.albedo[1] * fs, look.smoke.albedo[2] * fs, look.farField.exponent);
      put(I, o + 68, v3.dot(sunRoot, pc.axisX), v3.dot(sunRoot, pc.axisY), v3.dot(sunRoot, pc.axisZ), look.farField.striation);
      const gl = look.smoke.glow;
      put(I, o + 72, look.smoke.glowColor[0] * gl, look.smoke.glowColor[1] * gl, look.smoke.glowColor[2] * gl, 1 / (look.smoke.glowLengthRe * reMax));
      // The eddies ride down the jet at EDDY_SPEED of the gas speed where the jet is four exit radii wide (wrapped at one tile).
      put(I, o + 76, look.smoke.dilution, EDDY_FREQUENCY, far > 0.5 ? 1 : 0, ((EDDY_SPEED * look.noise.speed * noiseTime) / (4 * reMax)) % (1 / EDDY_FREQUENCY));
      if (c.merged) put(I, o + 80, c.merged.shape.far, c.merged.shape.farAmp, Math.PI / (2 * c.merged.shape.thetaLimit), 0);
      else put(I, o + 80, 0, 1, 1, 0);
      for (let k = 0; k < c.nozzles.length; k++) {
        const nz = c.nozzles[k]!;
        const p = pc.nozzlePos[k]!;
        const d = pc.nozzleDir[k]!;
        const q = ni * NOZZLE_FLOATS;
        const emission = Math.max(nz.throttle, 0.12 * nz.residual * (nz.shape.oxygen > 0.01 ? 1 : 0.3));
        put(N, q, p.x, p.y, p.z, nz.exitRadius);
        put(N, q + 4, d.x, d.y, d.z, emission);
        shapeVec(N, q + 8, nz.shape);
        put(N, q + 12, nz.shape.shockSpacing, nz.shape.cellAmp, nz.shape.coreLength, nz.shape.oxygen);
        put(N, q + 16, nz.shape.shearLength, nz.shape.afterLength, nz.front, nz.flash);
        // Every nozzle has its own cells and its own flicker: engines never run alike to the per cent.
        const hs = (nz.seed * 0.6180339887) % 1;
        const cellShift = 0.3 * hs + 0.035 * Math.sin(noiseTime * (17 + (nz.seed % 7) * 2.3) + nz.seed);
        const flicker = 1 + 0.07 * Math.sin(noiseTime * (29 + (nz.seed % 11) * 3.1) + nz.seed * 1.7) + 0.04 * Math.sin(noiseTime * (83 + (nz.seed % 5) * 7.3) + nz.seed * 0.9);
        put(N, q + 20, nz.seed, nz.residual, cellShift, flicker);
        put(N, q + 24, nz.shape.far, nz.shape.farAmp, Math.PI / (2 * nz.shape.thetaLimit), nz.flashRadius);
        ni++;
      }
      this.placed.push(pc);
      ii++;
    }
    this.count = ii;
    if (ii > 0) {
      this.device.queue.writeBuffer(this.instanceBuffer, 0, I, 0, ii * INSTANCE_FLOATS);
      this.device.queue.writeBuffer(this.nozzleBuffer, 0, N, 0, ni * NOZZLE_FLOATS);
    }
  }

  get instanceCount(): number {
    return this.count;
  }

  /** Distance from the eye to the middle of instance i (for back-to-front ordering). */
  distance(i: number): number {
    const pc = this.placed[i]!;
    return v3.len(v3.addScaled(pc.originRelCam, pc.axisX, 0.3 * pc.cluster.length));
  }

  /** Draw instance i into the half-resolution volume pass (groups 0 and 1 are bound by the caller). */
  draw(pass: GPURenderPassEncoder, i: number): void {
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(2, this.group);
    pass.draw(36, 1, 0, i);
  }

  /**
   * Render a density slice of instance `instance` (through the axis of nozzle `nozzle`, or through the cluster
   * axis when nozzle = -1) and read it back: columns x0..x1 along the jet, rows -rMax..+rMax across it.
   */
  async slice(frameBindGroup: GPUBindGroup, instance: number, nozzle: number, x0: number, x1: number, rMax: number, width = 1024, height = 512): Promise<PlumeSlice> {
    const device = this.device;
    if (!this.slicePipeline) {
      this.sliceLayout = device.createBindGroupLayout({ label: 'vfx.plume.slice', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      this.slicePipeline = this.common.core.fullscreenPipeline({ label: 'vfx.plume.slice', fragment: SLICE_WGSL, targets: [{ format: 'rgba32float' }], layouts: [this.common.layout, this.layout, this.sliceLayout] });
    }
    const texture = this.common.core.createTextureChecked({ label: 'vfx.plume.slice', format: 'rgba32float', size: [width, height], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const uniform = device.createBuffer({ label: 'vfx.plume.slice', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([x0, x1, rMax, 0, instance, nozzle, 0, 0]));
    const group = device.createBindGroup({ label: 'vfx.plume.slice', layout: this.sliceLayout!, entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const encoder = device.createCommandEncoder({ label: 'vfx.plume.slice' });
    const pass = encoder.beginRenderPass({ label: 'vfx.plume.slice', colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.group);
    pass.setBindGroup(3, group);
    pass.setPipeline(this.slicePipeline.get());
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const bytesPerRow = Math.ceil((width * 16) / 256) * 256;
    const buffer = device.createBuffer({ label: 'vfx.plume.slice.read', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const copy = device.createCommandEncoder({ label: 'vfx.plume.slice.read' });
    copy.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height, 1]);
    device.queue.submit([copy.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Float32Array(buffer.getMappedRange());
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) data.set(src.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    texture.destroy();
    uniform.destroy();
    return { width, height, x0, x1, rMax, data };
  }

  dispose(): void {
    this.instanceBuffer.destroy();
    this.nozzleBuffer.destroy();
  }
}
