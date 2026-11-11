/**
 * Engine and thruster plumes: analytic jets marched at half resolution inside a bounding box per cluster.
 * The WGSL field below is the same code for the march and for the density slices the tests measure.
 */
import type { RenderContext } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { PlumeCluster } from './clusters';
import type { VfxCommon } from './common';
import { BULK_SLOPE, type JetShape } from './plumeModel';

export const MAX_PLUME_INSTANCES = 64;
export const MAX_PLUME_NOZZLES = 256;
const INSTANCE_FLOATS = 64;
const NOZZLE_FLOATS = 24;
/** March steps of an engine cluster and of an RCS jet at quality 1. */
export const PLUME_STEPS = 40;
export const RCS_STEPS = 14;

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
  afterColor: vec4f,   // rgb = afterburning colour x luminance, w = density exponent of the core emission
  smoke: vec4f,        // rgb = albedo x scattering optical depth per exit diameter, w = extinction optical depth per exit diameter
  flashColor: vec4f,   // rgb = start-up flash colour x core luminance, w = first nozzle index
  noise: vec4f,        // x = 1 / feature size (1/m), y = amount 0..1, z = scroll along +X (m, wrapped), w = march steps
  merged0: vec4f,      // x = distance where the jets merge (1e30 = never), y = merged exit radius, z = merged emission scale, w = merged throttle
  merged1: vec4f,      // merged jet: tan(theta), Lexp, mixing slope, mixing development length
  merged2: vec4f,      // merged jet: core, shear and afterburn e-folding lengths (m), oxygen factor
  light: vec4f,        // x = light probe index, y = unused, z = unused, w = largest exit radius (m)
  extra: vec4f,        // x, y = bounding cone about +X: radius = x + y * distance along X
}
struct PlumeNozzle {
  posRe: vec4f,        // xyz = exit centre in the cluster frame, w = exit radius (m)
  dirThr: vec4f,       // xyz = unit exhaust direction (cluster frame), w = emission throttle 0..1
  shape: vec4f,        // tan(theta), Lexp (m), mixing slope, mixing development length (m)
  cells: vec4f,        // shock-cell spacing (m), cell amplitude 0..1, core e-folding length (m), oxygen factor 0..1
  lens: vec4f,         // shear length (m), afterburn length (m), start-up front distance (m), start-up flash gain
  misc: vec4f,         // x = seed, y = residual flame 0..1
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
  sc: vec3f,    // scattering coefficient x albedo, 1/m (multiply by sun illuminance / 4 pi)
  gas: f32,     // relative gas density (for density slices)
  core: f32,    // relative core density including the shock cells (for density slices)
}
fn jetZero() -> JetOut { return JetOut(vec3f(0.0), 0.0, vec3f(0.0), 0.0, 0.0); }

/// One jet. 'n' / 'n2' = coarse and fine noise samples (0..1 per channel; 0.5 = no turbulence).
/// 'k0' = throttle / (2 re of one nozzle) x scale.
fn jetSample(inst: PlumeInstance, pos: vec3f, dir: vec3f, re: f32, shape: vec4f, cells: vec4f, lens: vec4f, k0: f32, p: vec3f, n: vec4f, n2: vec4f) -> JetOut {
  let g = jetGeom(pos, dir, re, shape, p);
  if (g.x < -0.4 * re || g.r > 1.8 * g.rb + 2.0 * re) { return jetZero(); }
  let xc = max(g.x, 0.0);
  let inlet = smoothstep(-0.4 * re, 0.3 * re, g.x);
  let front = 1.0 - smoothstep(lens.z - 2.0 * re, lens.z + 2.0 * re, g.x);
  let k = k0 * inlet * front;
  // Turbulence grows downstream of the nozzle: ragged edges and filaments.
  let turb = saturate(xc / (10.0 * re)) * inst.noise.y;
  let rr = g.r * (1.0 + ((n.r - 0.5) * 1.1 + (n2.b - 0.5) * 0.5) * turb);
  let fil = mix(1.0, (0.25 + 1.5 * n.g) * (0.45 + 1.1 * n2.b), min(1.0, turb * 1.4));

  // Core: emission follows the gas density and decays along the jet; shock cells brighten it at the Mach
  // discs. A jet that balloons keeps its gas around the axis (bulk radius), the boundary holds a thin halo.
  let rBulk = min(g.rb, 2.0 * re + BULK_SLOPE * xc);
  let cr = inst.coreColor.w * rBulk;
  let coreProfile = exp(-sq(g.r / cr));
  let dens = pow(sq(re / rBulk), inst.afterColor.w);
  let axial = exp(-xc / cells.z);
  // Shock cells: a Mach disc at u = 0.75 + k (u = distance in cell lengths), a bright diamond tapering
  // behind it, and the converging shocks brightening the core just ahead of the next disc.
  let u = xc / cells.x + (n.a - 0.5) * turb * 0.7;
  let decay = exp(-max(u - 0.75, 0.0) / inst.shearColor.w);
  let sc = fract(u - 0.75);
  let lead = smoothstep(0.8, 1.0, sc);
  let tail = exp(-3.5 * sc) * step(0.75, u);
  let env = max(0.75 * cr * (max(1.0 - 1.3 * sc, 0.0) * step(0.75, u) + lead), 0.04 * cr);
  let disc = cells.y * decay * (tail + 0.7 * lead) * exp(-sq(g.r / env));
  // An over- or under-expanded jet is dim where it leaves the nozzle and lights up at the first shock.
  let ramp = mix(1.0, 0.3 + 0.7 * smoothstep(0.0, 0.75, u), cells.y);
  var o: JetOut;
  o.e = inst.coreColor.rgb * (k * dens * coreProfile * axial * ramp * mix(1.0, 0.5 + n.g, turb))
      + inst.diamondColor.rgb * (k * dens * axial * disc * inst.diamondColor.w);
  o.gas = g.dil * g.edge;
  o.core = sq(re / rBulk) * coreProfile * (ramp + disc * inst.diamondColor.w);

  // Afterburning with ambient air: a thin ring in the shear layer, then a turbulent flame brush downstream.
  let ox = cells.w;
  if (ox > 0.002) {
    let ringW = 0.08 * re + 0.4 * g.mixing + 0.14 * max(g.rb - re, 0.0);
    let ring = exp(-sq((rr - (g.rb - 0.35 * g.mixing)) / ringW)) * sqrt(min(2.0, 0.25 * re / ringW));
    o.e += inst.shearColor.rgb * (k * ox * ring * smoothstep(0.0, 2.5 * re, xc) * exp(-xc / lens.x) * fil);
    let brush = exp(-sq(rr / (0.8 * g.rb))) * smoothstep(0.0, 0.25 * lens.y, xc) * exp(-xc / lens.y);
    o.e += inst.afterColor.rgb * (k * ox * brush * sqrt(g.dil) * fil);
  }
  // Start-up flash at the nozzle.
  o.e += inst.flashColor.rgb * (lens.w * k0 * inlet * exp(-xc / (8.0 * re)) * exp(-sq(g.r / (1.3 * g.rb + re))));
  // Particulates: extinction and sunlight scattering follow the gas density (bulk and halo).
  let part = k * (0.8 * sq(re / rBulk) * exp(-sq(rr / (1.3 * cr))) + 0.2 * g.dil * g.edge) * mix(1.0, 0.3 + 1.4 * n.g, turb);
  o.s = inst.smoke.w * part;
  o.sc = inst.smoke.rgb * part;
  return o;
}

fn jetAdd(a: JetOut, b: JetOut, w: f32) -> JetOut {
  return JetOut(a.e + b.e * w, a.s + b.s * w, a.sc + b.sc * w, a.gas + b.gas * w, a.core + b.core * w);
}

/// All jets of a cluster at point 'p' of the cluster frame: the separate jets near the nozzles, blended into
/// one merged jet downstream of the merge distance.
fn plumeField(inst: PlumeInstance, p: vec3f, n: vec4f, n2: vec4f) -> JetOut {
  var o = jetZero();
  // Everything fades to nothing at the bounding cone and at the far end of the box (no visible cut).
  let bound = inst.extra.x + inst.extra.y * max(p.x, 0.0);
  let window = (1.0 - smoothstep(0.72, 1.0, length(p.yz) / bound)) * (1.0 - smoothstep(0.8, 1.0, p.x / inst.origin.w));
  if (window <= 0.0) { return o; }
  let xm = inst.merged0.x;
  let w = smoothstep(xm, 2.0 * xm, p.x);
  if (w < 0.999) {
    let first = u32(inst.flashColor.w);
    let count = u32(inst.axisZ.w);
    for (var i = 0u; i < count; i++) {
      let nz = plumeNozzles[first + i];
      if (nz.dirThr.w <= 0.0) { continue; }
      // Neighbouring jets flicker independently: odd seeds swap the two Perlin channels.
      let nn = select(n, n.agbr, (u32(nz.misc.x) & 1u) == 1u);
      o = jetAdd(o, jetSample(inst, nz.posRe.xyz, nz.dirThr.xyz, nz.posRe.w, nz.shape, nz.cells, nz.lens, nz.dirThr.w / (2.0 * nz.posRe.w), p, nn, n2), 1.0 - w);
    }
  }
  if (w > 0.001) {
    let cells = vec4f(1.0, 0.0, inst.merged2.x, inst.merged2.w);
    let lens = vec4f(inst.merged2.y, inst.merged2.z, 1e9, 0.0);
    o = jetAdd(o, jetSample(inst, vec3f(0.0), vec3f(1.0, 0.0, 0.0), inst.merged0.y, inst.merged1, cells, lens, inst.merged0.w * inst.merged0.z / (2.0 * inst.light.w), p, n, n2), w);
  }
  o.e *= window;
  o.s *= window;
  o.sc *= window;
  return o;
}
`;

const MARCH_WGSL = /* wgsl */ `
#include "vfx_common"
@group(2) @binding(0) var<storage, read> plumeInstances: array<PlumeInstance>;
@group(2) @binding(1) var<storage, read> plumeNozzles: array<PlumeNozzle>;
${PLUME_FIELD_WGSL}

const CUBE_IDX = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);

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
  if (qa > 1e-3) {
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
    let n = vfxNoiseLod((p - scroll) * inst.noise.x, dt * inst.noise.x);
    let n2 = vfxNoiseLod((p - scroll * 1.7) * (inst.noise.x * 2.9) + vec3f(0.37, 0.11, 0.73), dt * inst.noise.x * 2.9);
    let f = plumeField(inst, p, n, n2);
    let od = f.s * dt;
    let stepT = exp(-od);
    let src = f.e + f.sc * sun;
    let c = src * select(dt, (1.0 - stepT) / max(f.s, 1e-9), od > 1e-4);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * t;
    T *= stepT;
    if (T < 0.004) { break; }
  }
  let tMean = clamp(tsum / max(wsum, 1e-20), t0, t1);
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
    f = jetSample(inst, nz.posRe.xyz, nz.dirThr.xyz, nz.posRe.w, nz.shape, nz.cells, nz.lens, nz.dirThr.w / (2.0 * nz.posRe.w), p, vec4f(0.5), vec4f(0.5));
  } else {
    f = plumeField(inst, vec3f(x, r, 0.0), vec4f(0.5), vec4f(0.5));
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
  update(placed: PlacedCluster[], noiseTime: number): void {
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
      const cl = fl * (1 + (look.core.vacuumGain - 1) * (c.nozzles[0]?.shape.vacuum ?? 0));
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
      put(I, o + 40, 1 / (feature * 4), look.noise.amount, (look.noise.speed * noiseTime) % (feature * 4), c.kind === 'rcs' ? RCS_STEPS : Math.round(PLUME_STEPS * (1 - 0.45 * (c.nozzles[0]?.shape.vacuum ?? 0))));
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
      put(I, o + 56, pc.probe, 0, 0, reMax);
      put(I, o + 60, c.coneR0, c.coneSlope, 0, 0);
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
        put(N, q + 20, nz.seed, nz.residual, 0, 0);
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
