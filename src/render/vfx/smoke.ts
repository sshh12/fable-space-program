/**
 * Pad smoke and steam: a density volume anchored to a launch site, advected in compute through an analytic
 * flow (the jet from the vehicle hits the pad, runs out as a wall jet focused along the flame trench, slows,
 * rises on its own heat and drifts with the wind) plus curl-noise turbulence, lit by the sun (a light volume
 * holds the optical depth towards it) and by the plume, eroded with detail noise in the march.
 *
 * Grid: rgba16float, r = extinction of exhaust smoke (1/m), g = extinction of deluge steam (1/m), b = heat
 * 0..1. The cells are 3.75 m at the pad and grow outwards and upwards (x = S a / (1 - c |a|)), so the same
 * 160 x 96 x 160 cells resolve the mount and still hold a cloud 1.8 km across.
 *
 * The march also places the emitters drawn before it (plumes, fireballs) inside the smoke: it accumulates
 * the smoke in front of and behind their mean distance separately and composes the three layers.
 */
import type { LaunchSiteDef } from '@/core/contracts/defs';
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { ManagedTarget, Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import { PROBE_PAD } from './common';
import type { VfxData } from './data';
import type { PlacedCluster } from './plumes';
import type { VolumeCombiner } from './volumes';

const U_FLOATS = 72;

const GRID_WGSL = /* wgsl */ `
struct SmokeU {
  origin: vec4f,      // xyz = pad centre on the ground relative to the camera (ROOT axes), w = source strength 0..1
  axisE: vec4f,       // xyz = east (ROOT axes), w = S: horizontal scale of the grid (m)
  axisU: vec4f,       // xyz = up, w = c: horizontal warp
  axisN: vec4f,       // xyz = north, w = Sy: vertical scale (m)
  grid: vec4f,        // x = cy: vertical warp, y = half extent (m), z = height (m), w = march steps
  source: vec4f,      // xyz = where the jet meets the pad, site frame (east, up, north), w = height of the nozzles above the pad (m)
  rate: vec4f,        // x = smoke source (m^2 of extinction cross-section per second), y = steam source, z = source radius (m), w = trench focus now
  trench: vec4f,      // xy = unit direction of the flame trench (east, north), z = trench length (m), w = unused
  flow: vec4f,        // jet speed at the source (m/s), jet radius (m), buoyant rise at heat 1 (m/s), cooling (1/s)
  flow2: vec4f,       // turbulence, dissipation (1/s), wind east, wind north (m/s)
  sunSite: vec4f,     // xyz = unit direction to the sun in the site frame (east, up, north), w = dt (s)
  lightPos: vec4f,    // xyz = plume light in the site frame, w = 1 when emitters were drawn this frame
  lightColor: vec4f,  // rgb = plume light intensity (cd)
  smokeAlbedo: vec4f, // rgb, w = erosion amount
  steamAlbedo: vec4f, // rgb, w = erosion noise scale (1/m)
  misc: vec4f,        // x = 1: clear the grid, y = time (s)
  glow: vec4f,        // rgb = colour x luminance of gas fresh from the plume (cd/m^2)
  cloud: vec4f,       // a cylinder that holds the cloud: xy = centre (east, north), z = radius (m), w = height (m)
}
fn smokeToUvw(p: vec3f) -> vec3f {
  let S = su.axisE.w;
  let c = su.axisU.w;
  let y = max(p.y, 0.0);
  return vec3f(0.5 + 0.5 * p.x / (S + c * abs(p.x)), y / (su.axisN.w + su.grid.x * y), 0.5 + 0.5 * p.z / (S + c * abs(p.z)));
}
fn smokeFromUvw(u: vec3f) -> vec3f {
  let a = u.x * 2.0 - 1.0;
  let b = u.z * 2.0 - 1.0;
  return vec3f(su.axisE.w * a / (1.0 - su.axisU.w * abs(a)), su.axisN.w * u.y / (1.0 - su.grid.x * u.y), su.axisE.w * b / (1.0 - su.axisU.w * abs(b)));
}
`;

const COMPUTE_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var src: texture_3d<f32>;
@group(2) @binding(2) var dst: texture_storage_3d<rgba16float, write>;

/// The analytic flow at a point of the site frame (east, up, north), m/s. 'heat' = heat of the gas there.
fn smokeVelocity(p: vec3f, heat: f32) -> vec3f {
  let d = p.xz - su.source.xz;
  let r = length(d);
  let rh = d / max(r, 0.5);
  // Wall jet from the foot of the plume: 1 / r decay, thickening with distance, focused along the trench.
  let F = su.rate.w;
  let lobe = pow(max(dot(rh, su.trench.xy), 0.0), 3.0);
  let w = (1.0 - F) + F * 2.6 * lobe;
  let r0 = su.flow.y;
  let delta = 5.0 + 0.14 * r;
  let U = su.origin.w * su.flow.x * (r0 / (r + r0)) * w * exp(-p.y / delta);
  var v = vec3f(rh.x * U, U * 0.22 * (p.y / delta), rh.y * U);
  // Hot gas rises; the wind takes over where the jet has died.
  v.y += su.flow.z * heat * (0.35 + 0.65 * saturate(p.y / 25.0));
  let windShare = (0.3 + 0.7 * saturate(p.y / 120.0)) * (1.0 - saturate(U / 8.0));
  v += vec3f(su.flow2.z, 0.0, su.flow2.w) * windShare;
  // Turbulence: two octaves of divergence-free noise that drift up with the cloud, stronger where the gas is fast.
  let t = su.misc.y;
  let c = vfxCurl(p * 0.0042 + vec3f(0.0, -t * 0.012, 0.0)) + 0.55 * vfxCurl(p * 0.0137 + vec3f(t * 0.008, -t * 0.03, 0.0));
  v += c.xzy * (su.flow2.x * (2.5 + 0.3 * length(v))) * vec3f(1.0, 0.6 + 0.4 * saturate(p.y / 20.0), 1.0);
  return v;
}

@compute @workgroup_size(4, 4, 4) fn advect(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst);
  if (any(id >= dims)) { return; }
  if (su.misc.x > 0.5) { textureStore(dst, id, vec4f(0.0)); return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(dims);
  let p = smokeFromUvw(uvw);
  let dt = su.sunSite.w;
  let here = textureLoad(src, vec3i(id), 0);
  let v = smokeVelocity(p, here.b);
  let p0 = p - v * dt;
  var s = textureSampleLevel(src, linearClamp, smokeToUvw(p0), 0.0);
  // Nothing comes in through the sides or the top.
  if (abs(p0.x) > su.grid.y || abs(p0.z) > su.grid.y || p0.y > su.grid.z) { s = vec4f(0.0); }
  let diss = su.flow2.y;
  s.r *= exp(-diss * dt);
  s.g *= exp(-diss * 3.0 * dt);
  s.b *= exp(-su.flow.w * dt);
  // Sources at the foot of the plume: smoke where the jet comes out of the trench, steam from the deluge around it.
  let R = su.rate.z;
  let H = 5.0;
  let out = su.source.xz + su.trench.xy * (su.trench.z * 0.5 * su.rate.w);
  let dSmoke = p.xz - out;
  let gSmoke = exp(-dot(dSmoke, dSmoke) / (R * R)) * exp(-p.y / H) / (PI * R * R * H);
  let Rw = 2.2 * R;
  let dSteam = p.xz - mix(su.source.xz, out, 0.5);
  let gSteam = exp(-dot(dSteam, dSteam) / (Rw * Rw)) * exp(-p.y / (1.6 * H)) / (PI * Rw * Rw * 1.6 * H);
  s.r += su.rate.x * dt * gSmoke;
  s.g += su.rate.y * dt * gSteam;
  s.b = max(s.b, saturate((su.rate.x * gSmoke + 0.6 * su.rate.y * gSteam) * 40.0));
  textureStore(dst, id, max(s, vec4f(0.0)));
}

fn sigmaAt(p: vec3f) -> f32 {
  if (abs(p.x) > su.grid.y || abs(p.z) > su.grid.y || p.y > su.grid.z || p.y < 0.0) { return 0.0; }
  let s = textureSampleLevel(src, linearClamp, smokeToUvw(p), 0.0);
  return s.r + s.g;
}

/// Light volume: r = optical depth towards the sun, g = optical depth towards the plume light.
@compute @workgroup_size(4, 4, 4) fn light(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst);
  if (any(id >= dims)) { return; }
  let p = smokeFromUvw((vec3f(id) + 0.5) / vec3f(dims));
  var tau = 0.0;
  var step = 5.0;
  var q = p;
  for (var i = 0; i < 7; i++) {
    q += su.sunSite.xyz * step;
    tau += sigmaAt(q) * step;
    step *= 1.7;
  }
  let toL = su.lightPos.xyz - p;
  var tauL = 0.0;
  for (var i = 0; i < 5; i++) {
    tauL += sigmaAt(p + toL * ((f32(i) + 0.5) / 5.0)) * (length(toL) / 5.0);
  }
  textureStore(dst, id, vec4f(tau, tauL, 0.0, 0.0));
}
`;

const MARCH_WGSL = /* wgsl */ `
#include "vfx_common"
${GRID_WGSL}
@group(2) @binding(0) var<uniform> su: SmokeU;
@group(2) @binding(1) var densityTex: texture_3d<f32>;
@group(2) @binding(2) var lightTex: texture_3d<f32>;
@group(2) @binding(3) var emitTex: texture_2d<f32>;
@group(2) @binding(4) var momentTex: texture_2d<f32>;

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let pix = vec2i(in.position.xy);
  var E = vec4f(0.0);
  var tE = 3.0e38;
  if (su.lightPos.w > 0.5) {
    E = textureLoad(emitTex, pix, 0);
    let m = textureLoad(momentTex, pix, 0);
    if (m.g > 1e-4) { tE = exp2(m.r / m.g); }
  }
  let ray = viewRay(in.uv);
  let rayLen = length(ray);
  let dW = ray / rayLen;
  let tScene = viewZFromDepth(textureLoad(sceneDepthHalfTex, pix, 0).r) * rayLen;
  let o = su.origin.xyz;
  let ro = -vec3f(dot(o, su.axisE.xyz), dot(o, su.axisU.xyz), dot(o, su.axisN.xyz));
  var rd = vec3f(dot(dW, su.axisE.xyz), dot(dW, su.axisU.xyz), dot(dW, su.axisN.xyz));
  rd = select(rd, vec3f(1e-7), abs(rd) < vec3f(1e-7));
  let ext = su.grid.y;
  let ta = (vec3f(-ext, 0.0, -ext) - ro) / rd;
  let tb = (vec3f(ext, su.grid.z, ext) - ro) / rd;
  let tmn = min(ta, tb);
  let tmx = max(ta, tb);
  var t0 = max(max(tmn.x, max(tmn.y, tmn.z)), 0.0);
  var t1 = min(min(tmx.x, min(tmx.y, tmx.z)), tScene);
  // The cloud itself is much smaller than the grid: march only through the cylinder that holds it.
  let oc = ro.xz - su.cloud.xy;
  let qa = dot(rd.xz, rd.xz);
  let qb = dot(oc, rd.xz);
  let disc = qb * qb - qa * (dot(oc, oc) - su.cloud.z * su.cloud.z);
  if (disc <= 0.0) { return E; }
  let sq_ = sqrt(disc);
  t0 = max(t0, (-qb - sq_) / qa);
  t1 = min(t1, (-qb + sq_) / qa);
  let ty = (vec2f(0.0, su.cloud.w) - ro.y) / rd.y;
  t0 = max(t0, min(ty.x, ty.y));
  t1 = min(t1, max(ty.x, ty.y));
  if (t1 <= t0) { return E; }

  // Steps grow gently with the distance from the point of the ray nearest to the pad, like the cells of the grid.
  let tc = clamp(-dot(ro, rd), t0, t1);
  let d0 = max(24.0, 0.3 * length(ro + rd * tc));
  let s0 = t0 - tc;
  let s1 = t1 - tc;
  let w0 = sign(s0) * log(1.0 + abs(s0) / d0);
  let w1 = sign(s1) * log(1.0 + abs(s1) / d0);
  let steps = max(12.0, floor(su.grid.w * vfx.time.w + 0.5));
  let dw = (w1 - w0) / steps;
  let jitter = blueNoise(vec2u(pix)).g;
  let probe = vfxProbes[${PROBE_PAD}];
  let sunE = probe.sun.rgb;
  let amb = vfxProbeAmbient(${PROBE_PAD}u);
  let cosT = dot(dW, frame.sunDir.xyz);
  let g = 0.5;
  let phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
  let time = su.misc.y;
  let exposure = frame.exposure.x;
  let scale = su.steamAlbedo.w;
  let scroll = vec3f(-su.flow2.z * time, -3.0 * time, -su.flow2.w * time);

  var Lf = vec3f(0.0); var Tf = 1.0;     // smoke in front of the emitters
  var Lb = vec3f(0.0); var Tb = 1.0;     // smoke behind them
  var slabL = vec3f(0.0); var slabT = 1.0; var slabW = 0.0; var slabD = 0.0;
  var back = false;
  var slabCount = 0;
  // Coarse steps through empty air; where gas is found the march backs up one step and goes on with steps a
  // quarter as long, so that the first metres of a dense cloud (which are all that is seen of it) are resolved.
  var t = t0 + (d0 + abs(t0 - tc)) * dw * jitter;
  var fine = 0.0;
  let maxIter = i32(steps * 2.5);
  for (var i = 0; i < maxIter && t < t1; i++) {
    let base = (d0 + abs(t - tc)) * dw;
    let dt = base * select(1.0, 0.25, fine > 0.0);
    let p = ro + rd * (t + 0.5 * dt);
    let coarse = textureSampleLevel(densityTex, linearClamp, smokeToUvw(p), 0.0);
    var sigma = coarse.r + coarse.g;
    if (sigma > 1e-5 && fine <= 0.0) {
      // Entering gas: redo this stretch finely.
      fine = 6.0;
      continue;
    }
    var cell = coarse;
    if (sigma > 1e-5) {
      // Billows: the density is looked up at a position displaced by two octaves of noise that ride up with
      // the cloud (lumpy edges however smooth the advected field is), then thin gas is eroded.
      let q = (p + scroll) * scale;
      let n = vfxNoiseLod(q, dt * scale);
      let n2 = vfxNoiseLod(q * 3.1 + vec3f(0.37, 0.11, 0.73), dt * scale * 3.1);
      let amp = 0.3 / scale;
      let warp = (vec3f(n.r, n.a, n.g) - 0.5) * (2.0 * amp) + (vec3f(n2.r, n2.a, n2.g) - 0.5) * (0.6 * amp);
      cell = textureSampleLevel(densityTex, linearClamp, smokeToUvw(p + warp), 0.0);
      sigma = cell.r + cell.g;
      let cover = saturate(sigma / 0.03);
      let billow = 0.65 * n.g + 0.35 * n2.b;
      sigma *= saturate((billow - su.smokeAlbedo.w * (1.0 - cover)) * 4.0 + cover);
      fine = 6.0;
    } else {
      fine -= 1.0;
    }
    if (sigma > 1e-5) {
      let lt = textureSampleLevel(lightTex, linearClamp, smokeToUvw(p), 0.0);
      let albedo = (su.smokeAlbedo.rgb * cell.r + su.steamAlbedo.rgb * cell.g) / max(cell.r + cell.g, 1e-6);
      // Sun: single scattering plus two wide octaves standing in for multiple scattering.
      let sun = sunE * (phase * exp(-lt.r) + 1.5 * exp(-0.3 * lt.r) + 1.1 * exp(-0.025 * lt.r)) * (1.0 / (4.0 * PI));
      let toL = su.lightPos.xyz - p;
      let dl2 = max(dot(toL, toL), 25.0);
      let plume = su.lightColor.rgb * ((exp(-lt.g) + 0.5 * exp(-0.3 * lt.g)) / (dl2 * PI));
      let sky = amb * ((0.45 + 0.55 * exp(-0.25 * lt.r)) / PI);
      // Gas fresh from the plume still glows.
      let h2 = cell.b * cell.b;
      let glow = su.glow.rgb * (h2 * h2 * h2 * h2);
      let J = (albedo * (sun + plume + sky) + glow) * exposure;
      let stepT = exp(-sigma * dt);
      slabL += slabT * J * (1.0 - stepT);
      slabT *= stepT;
      slabW += (1.0 - stepT);
      slabD += (1.0 - stepT) * (t + 0.5 * dt);
    }
    t += dt;
    slabCount++;
    // A slab ends every eighth step, where the ray passes the emitters, and at the end.
    let last = t >= t1 || i + 1 >= maxIter;
    let crossing = !back && t >= tE;
    if (last || crossing || slabCount >= 8) {
      if (slabW > 0.0) {
        let c = vfxAtmosphere(in.uv, slabD / slabW, slabL, 1.0 - slabT);
        if (back) { Lb += Tb * c.rgb; Tb *= 1.0 - c.a; } else { Lf += Tf * c.rgb; Tf *= 1.0 - c.a; }
      }
      slabL = vec3f(0.0); slabT = 1.0; slabW = 0.0; slabD = 0.0; slabCount = 0;
      if (crossing) { back = true; }
    }
    if (Tf * Tb < 0.003) { break; }
  }
  let TE = 1.0 - E.a;
  let rgb = Lf + Tf * (E.rgb + TE * Lb);
  return vec4f(writeHdr(rgb), saturate(1.0 - Tf * TE * Tb));
}
`;

export class SmokeSystem implements VolumeCombiner {
  private readonly device: GPUDevice;
  private readonly u = new Float32Array(U_FLOATS);
  private readonly uniform: GPUBuffer;
  private readonly density: [GPUTexture, GPUTexture];
  private readonly lightTex: GPUTexture;
  private readonly computeLayout: GPUBindGroupLayout;
  private readonly marchLayout: GPUBindGroupLayout;
  private readonly advectPipeline: GPUComputePipeline;
  private readonly lightPipeline: GPUComputePipeline;
  private readonly marchPipeline: Tracked<GPURenderPipeline>;
  private readonly advectGroups: [GPUBindGroup, GPUBindGroup];
  private readonly lightGroups: [GPUBindGroup, GPUBindGroup];
  private marchGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private marchVersion = -1;
  private readonly dims: Vec3Tuple;
  /** Index of the density texture that holds the current state. */
  private cur = 0;
  private site: LaunchSiteDef | null = null;
  private lastSource = -1e9;
  private firstSource = -1e9;
  private isActive = false;
  private needsClear = true;
  private stepped = false;
  /** Total source this frame (m^2/s) for diagnostics. */
  sourceRate = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly data: VfxData,
  ) {
    const device = (this.device = ctx.device);
    const S = data.padSmoke;
    this.dims = S.grid;
    this.uniform = device.createBuffer({ label: 'vfx.smoke', size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mk = (label: string, size: Vec3Tuple): GPUTexture =>
      common.core.createTextureChecked({ label, format: 'rgba16float', dimension: '3d', size, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.density = [mk('vfx.smoke.a', S.grid), mk('vfx.smoke.b', S.grid)];
    this.lightTex = mk('vfx.smoke.light', [Math.ceil(S.grid[0] / 2), Math.ceil(S.grid[1] / 2), Math.ceil(S.grid[2] / 2)]);
    this.computeLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.compute',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
      ],
    });
    this.marchLayout = device.createBindGroupLayout({
      label: 'vfx.smoke.march',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const module = ctx.shaders.createModule('vfx.smoke.compute', COMPUTE_WGSL);
    const layout = device.createPipelineLayout({ label: 'vfx.smoke.compute', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, this.computeLayout] });
    this.advectPipeline = device.createComputePipeline({ label: 'vfx.smoke.advect', layout, compute: { module, entryPoint: 'advect' } });
    this.lightPipeline = device.createComputePipeline({ label: 'vfx.smoke.light', layout, compute: { module, entryPoint: 'light' } });
    const views = this.density.map((t) => t.createView());
    const lightView = this.lightTex.createView();
    const group = (srcView: GPUTextureView, dstView: GPUTextureView): GPUBindGroup =>
      device.createBindGroup({ label: 'vfx.smoke.compute', layout: this.computeLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: srcView }, { binding: 2, resource: dstView }] });
    // advectGroups[k]: read texture k, write the other; lightGroups[k]: read texture k, write the light volume.
    this.advectGroups = [group(views[0]!, views[1]!), group(views[1]!, views[0]!)];
    this.lightGroups = [group(views[0]!, lightView), group(views[1]!, lightView)];
    this.marchPipeline = common.core.fullscreenPipeline({ label: 'vfx.smoke.march', fragment: MARCH_WGSL, layouts: [common.layout, this.marchLayout], targets: [{ format: 'rgba16float' }] });
    this.marchPipeline.get();
  }

  active(): boolean {
    return this.isActive;
  }

  /** Site the volume is anchored to (null while inactive). */
  get anchor(): LaunchSiteDef | null {
    return this.isActive ? this.site : null;
  }

  /**
   * Choose the site, measure the sources and upload the uniforms (prepare). Returns the pad centre relative
   * to the camera while the volume is active (for the pad light probe), else null.
   */
  update(frame: FrameContext, clusters: PlacedCluster[], effectTime: number, dt: number): Vec3 | null {
    const S = this.data.padSmoke;
    const defs = this.ctx.defs;
    const snap = frame.snapshot;
    this.stepped = false;

    // Nearest site to anything that burns, on a body of this frame.
    let best: { site: LaunchSiteDef; origin: Vec3; east: Vec3; north: Vec3; up: Vec3 } | null = null;
    let bestDist = Infinity;
    const candidates = this.isActive && this.site ? [this.site] : Object.values(defs.sites);
    for (const site of candidates) {
      const pe = site.location.padElevation;
      if (typeof pe !== 'number' || !snap.bodies.some((b) => b.id === site.bodyId)) continue;
      const pose = frame.bodyPose(site.bodyId);
      const dir = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
      const origin = v3.add(pose.centerRelCam, quat.rotate(pose.qFixedToRoot, v3.scale(dir, defs.bodies[site.bodyId]!.radius + pe)));
      let d = this.isActive ? 0 : Infinity;
      for (const pc of clusters) if (pc.cluster.kind === 'engine' && pc.cluster.look.ground.smoke > 0) d = Math.min(d, v3.dist(pc.originRelCam, origin));
      if (d < bestDist) {
        let e = v3.cross(v3.unitZ(), dir);
        e = v3.lenSq(e) < 1e-12 ? v3.unitY() : v3.normalize(e);
        const n = v3.cross(dir, e);
        bestDist = d;
        best = { site, origin, east: quat.rotate(pose.qFixedToRoot, e), north: quat.rotate(pose.qFixedToRoot, n), up: quat.rotate(pose.qFixedToRoot, dir) };
      }
    }
    if (!best || (!this.isActive && bestDist > S.activationRange)) {
      this.isActive = false;
      return null;
    }

    // Sources: every engine cluster whose jet points at the pad, weighted by how much of it still reaches the ground.
    let smoke = 0;
    let strength = 0;
    let foot = v3.zero();
    let nozzleHeight = 0;
    let weight = 0;
    let light: { pos: Vec3; intensity: Vec3Tuple; power: number } | null = null;
    const toSite = (rel: Vec3): Vec3 => {
      const d = v3.sub(rel, best.origin);
      return { x: v3.dot(d, best.east), y: v3.dot(d, best.up), z: v3.dot(d, best.north) };
    };
    for (const pc of clusters) {
      const c = pc.cluster;
      if (c.kind !== 'engine' || c.look.ground.smoke <= 0) continue;
      const p = toSite(pc.originRelCam);
      const cosDown = -v3.dot(pc.axisX, best.up);
      if (cosDown < 0.3 || p.y <= 0 || Math.hypot(p.x, p.z) > S.activationRange) continue;
      const h = p.y / cosDown;
      const reach = Math.max(0, 1 - h / S.plumeReach) ** 1.5;
      if (reach <= 0) continue;
      const hit = toSite(v3.addScaled(pc.originRelCam, pc.axisX, h));
      const w = c.massFlow * reach * c.look.ground.smoke;
      smoke += w;
      foot = v3.addScaled(foot, hit, w);
      nozzleHeight += p.y * w;
      weight += w;
      strength = Math.max(strength, reach * Math.min(1, c.massFlow / 2000 + 0.25));
      const li = c.look.light;
      const power = li.efficacy * c.thrust;
      if (!light || power > light.power) {
        const lp = toSite(v3.addScaled(pc.originRelCam, pc.axisX, Math.min(h * 0.6, 40)));
        light = { pos: lp, intensity: [li.color[0] * power, li.color[1] * power, li.color[2] * power], power };
      }
    }
    if (weight > 0) {
      foot = v3.scale(foot, 1 / weight);
      nozzleHeight /= weight;
      if (effectTime - this.lastSource > S.linger) this.firstSource = effectTime;
      this.lastSource = effectTime;
    }
    if (effectTime - this.lastSource > S.linger) {
      this.isActive = false;
      this.needsClear = true;
      return null;
    }
    if (!this.isActive || this.site !== best.site) this.needsClear = true;
    this.isActive = true;
    this.site = best.site;

    // The trench of this site, from its structures; the focus fades as the vehicle climbs and its jet hits the open pad.
    const trench = best.site.structures.find((s) => S.trenchModels.includes(s.model));
    const th = (trench?.headingDeg ?? 0) * DEG;
    const focus = trench ? S.trenchFocus * Math.exp(-Math.max(0, nozzleHeight - best.site.pad.clampHeight * 1.5) / 40) : 0;
    const deluge = Math.min(1, (effectTime - this.firstSource) / S.deluge.ramp) * (effectTime - this.firstSource < S.deluge.duration ? 1 : Math.exp(-(effectTime - this.firstSource - S.deluge.duration) / 2));
    const wh = S.wind.headingDeg * DEG;
    const horizontalScale = (S.centerCell * S.grid[0]) / 2;
    const verticalScale = S.bottomCell * S.grid[1];
    const sun = toSite(v3.add(best.origin, frame.sun.dirRoot));
    this.sourceRate = smoke * S.smoke.yield;
    const u = this.u;
    u.set([best.origin.x, best.origin.y, best.origin.z, weight > 0 ? strength : 0], 0);
    u.set([best.east.x, best.east.y, best.east.z, horizontalScale], 4);
    u.set([best.up.x, best.up.y, best.up.z, 1 - horizontalScale / S.halfExtent], 8);
    u.set([best.north.x, best.north.y, best.north.z, verticalScale], 12);
    u.set([1 - verticalScale / S.height, S.halfExtent, S.height, S.steps], 16);
    u.set([foot.x, 0, foot.z, nozzleHeight], 20);
    u.set([smoke * S.smoke.yield, smoke * S.steam.yield * deluge, S.jetRadius, focus], 24);
    u.set([Math.sin(th), Math.cos(th), S.trenchLength, 0], 28);
    u.set([S.jetSpeed, S.jetRadius, S.buoyancy, S.cooling], 32);
    u.set([S.turbulence, S.dissipation, Math.sin(wh) * S.wind.speed, Math.cos(wh) * S.wind.speed], 36);
    u.set([sun.x, sun.y, sun.z, dt], 40);
    u.set([light?.pos.x ?? 0, light?.pos.y ?? 30, light?.pos.z ?? 0, 0], 44);
    u.set([light?.intensity[0] ?? 0, light?.intensity[1] ?? 0, light?.intensity[2] ?? 0, 0], 48);
    u.set([...S.smoke.albedo, S.erosion], 52);
    u.set([...S.steam.albedo, S.erosionScale], 56);
    u.set([this.needsClear ? 1 : 0, effectTime, 0, 0], 60);
    u.set([S.glow.color[0] * S.glow.luminance, S.glow.color[1] * S.glow.luminance, S.glow.color[2] * S.glow.luminance, 0], 64);
    // The cloud front runs out with the wall jet (r ~ sqrt(2 U0 r0 t)), rises on its heat and drifts with the wind.
    const age = effectTime - this.firstSource;
    const drift = S.wind.speed * Math.max(0, age - 10) * 0.6;
    const radius = Math.min(S.halfExtent, 90 + Math.sqrt(2 * S.jetSpeed * S.jetRadius * Math.min(age, 60)) * 1.25 + drift + 1.5 * Math.max(0, age - 60));
    const height = Math.min(S.height, 60 + (S.buoyancy + 4) * Math.min(age, 40) + 2 * Math.max(0, age - 40));
    u.set([foot.x * (weight > 0 ? 1 : 0) + Math.sin(wh) * drift, foot.z * (weight > 0 ? 1 : 0) + Math.cos(wh) * drift, radius, height], 68);
    this.device.queue.writeBuffer(this.uniform, 0, u);
    this.stepped = dt > 0 || this.needsClear;
    return best.origin;
  }

  /** compute hook: one advection step and the light volume. */
  compute(frame: FrameContext, encoder: GPUCommandEncoder): void {
    if (!this.isActive || !this.stepped) return;
    this.needsClear = false;
    const pass = encoder.beginComputePass({ label: 'vfx.smoke', timestampWrites: this.ctx.perf.gpuPass('vfx.smoke.sim') as GPUComputePassTimestampWrites | undefined });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setPipeline(this.advectPipeline);
    pass.setBindGroup(2, this.advectGroups[this.cur]!);
    pass.dispatchWorkgroups(Math.ceil(this.dims[0] / 4), Math.ceil(this.dims[1] / 4), Math.ceil(this.dims[2] / 4));
    this.cur = 1 - this.cur;
    pass.setPipeline(this.lightPipeline);
    pass.setBindGroup(2, this.lightGroups[this.cur]!);
    pass.dispatchWorkgroups(Math.ceil(this.dims[0] / 8), Math.ceil(this.dims[1] / 8), Math.ceil(this.dims[2] / 8));
    pass.end();
  }

  /** The march: smoke composed with the emitters into `target`. */
  run(frame: FrameContext, encoder: GPUCommandEncoder, emit: ManagedTarget, moment: ManagedTarget, target: ManagedTarget, haveEmitters: boolean): void {
    const v = emit.version + moment.version;
    if (!this.marchGroups || v !== this.marchVersion) {
      this.marchVersion = v;
      const lightView = this.lightTex.createView();
      const mk = (k: number): GPUBindGroup =>
        this.device.createBindGroup({
          label: 'vfx.smoke.march',
          layout: this.marchLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: this.density[k]!.createView() },
            { binding: 2, resource: lightView },
            { binding: 3, resource: emit.view },
            { binding: 4, resource: moment.view },
          ],
        });
      this.marchGroups = [mk(0), mk(1)];
    }
    // The flag "emitters were drawn" is only known now: one float of the uniform.
    this.device.queue.writeBuffer(this.uniform, 47 * 4, new Float32Array([haveEmitters ? 1 : 0]));
    const pass = encoder.beginRenderPass({
      label: 'vfx.smoke.march',
      colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      timestampWrites: this.ctx.perf.gpuPass('vfx.smoke.march') as GPURenderPassTimestampWrites | undefined,
    });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.marchGroups[this.cur]!);
    pass.setPipeline(this.marchPipeline.get());
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    for (const t of this.density) t.destroy();
    this.lightTex.destroy();
    this.uniform.destroy();
  }
}
