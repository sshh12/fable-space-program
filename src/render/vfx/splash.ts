/**
 * What a splashdown does to the water.
 *
 *  - The crown: a sheet of white water thrown up around the body, leaning outwards, that rises on the
 *    speed of the impact, thins, tears from its rim downwards into ligaments and falls back. A volume in
 *    the half-resolution pass (a thin shell marched around the entry point), lit white by sun and sky. The
 *    droplets that leave its rim and the mist are particles (director.ts).
 *  - The foam: a patch of white water at the entry point that spreads as a ring and breaks up over half a
 *    minute. A decal on the water surface in the transparent pass: on whatever water the scene holds there
 *    (the far sheet of the G-buffer or the forward-drawn sea in front of the opaque scene), so it rides the
 *    swell and never paints a hull.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import type { SceneBindings, Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { SplashSpawn } from './director';
import { applyRebase, type DomainFrame, type DomainRebase } from './domain';
import { createVolumePipeline, type VolumeItem } from './volumes';

export const MAX_FOAM = 8;
const INST_FLOATS = 8;
const CROWN_FLOATS = 16;
const GRAVITY_FALLBACK = 9.81;

/** Rim height of a crown (m) `age` seconds after an impact that throws the sheet up at `speed` m/s. */
export function crownHeight(speed: number, gravity: number, age: number): number {
  return Math.max(0, speed * age - 0.5 * gravity * age * age);
}

const FOAM_WGSL = (scene: string): string => /* wgsl */ `
#include "vfx_common"
#include "gbuffer"
${scene}
struct Foam {
  centre: vec4f,   // xyz = entry point in domain coordinates, w = radius now (m)
  state: vec4f,    // x = age / lifetime, y = strength 0..1, z = seed, w = radius of the body that fell in (m)
}
struct FoamU { albedo: vec4f, count: vec4f }   // albedo.w = half height of the band of water levels the decal follows (m)
@group(2) @binding(0) var<uniform> foamU: FoamU;
@group(2) @binding(1) var<storage, read> foams: array<Foam, ${MAX_FOAM}>;

const CUBE = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);
struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let F = foams[ii];
  let ci = CUBE[vi];
  let c = vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u)) * 2.0 - 1.0;
  // A flat box around the patch, built on the local vertical, as high as the swell may stand.
  let up = vfx.domUp.xyz;
  var t1 = cross(up, vec3f(0.0, 0.0, 1.0));
  if (dot(t1, t1) < 1e-4) { t1 = cross(up, vec3f(1.0, 0.0, 0.0)); }
  t1 = normalize(t1);
  let t2 = cross(up, t1);
  let p = F.centre.xyz + (t1 * c.x + t2 * c.z) * (F.centre.w * 1.1) + up * (c.y * (foamU.albedo.w + 1.0));
  var o: VOut;
  o.pos = frame.viewProj * vec4f(vfxDomainToRel(p), 1.0);
  o.inst = ii;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let F = foams[in.inst];
  let px = vec2i(in.pos.xy);
  let depth = textureLoad(sceneDepthTex, px, 0);
  if (depth <= 0.0) { discard; }
  // Water only: the forward-drawn sea stands in front of the opaque scene, the far sheet is in the G-buffer.
  let opaque = textureLoad(sceneDepthOpaqueTex, px, 0);
  let material = u32(textureLoad(gbufferMaterialTex, px, 0).b * 255.0 + 0.5);
  if (!(depth > opaque * 1.000001 || material == MATERIAL_WATER)) { discard; }
  let uv = in.pos.xy * frame.renderSize.zw;
  let rel = positionFromDepth(uv, depth);
  let d = vfxRelToDomain(rel) - F.centre.xyz;
  let up = vfx.domUp.xyz;
  let h = dot(d, up);
  // The decal lies on the water wherever the swell has carried it, within the band.
  let band = foamU.albedo.w;
  if (abs(h) > band) { discard; }
  let hz = d - up * h;
  let rho = length(hz) / F.centre.w;
  if (rho >= 1.0) { discard; }
  let age = F.state.x;
  // An expanding ring of churned water and a mottled patch inside it that breaks up with time.
  let n = vfxNoise(hz * 0.09 + vec3f(F.state.z));
  let n2 = vfxNoise(hz * 0.37 + vec3f(F.state.z * 3.0));
  // The ring is ragged: its radius wanders and it is torn where the noise is low.
  let rhoN = rho + (n.r - 0.5) * 0.22 + (n2.g - 0.5) * 0.08;
  let ring = exp(-sq((rhoN - 0.78) / 0.11)) * smoothstep(0.3, 0.75, 0.6 * n.g + 0.75 * n2.b) * 1.5;
  let mottle = smoothstep(0.35 + 0.55 * age, 0.75 + 0.3 * age, 0.55 * n.g + 0.45 * n2.b + 0.35 * (1.0 - rho)) * (1.0 - smoothstep(0.75, 1.0, rho));
  let a = saturate((0.9 * ring * (1.0 - age) + mottle) * F.state.y * (1.0 - smoothstep(0.6, 1.0, age))) * (1.0 - smoothstep(0.7 * band, band, abs(h)));
  if (a < 0.003) { discard; }
  let probe = vfxProbes[0];
  let lum = foamU.albedo.rgb * (probe.sun.rgb * saturate(dot(probe.up.xyz, frame.sunDir.xyz)) + vfxProbeAmbient(0u)) * (1.0 / PI);
  let c = vfxAtmosphere(uv, length(rel), lum * frame.exposure.x * a, a);
  return vec4f(writeHdr(c.rgb), saturate(c.a));
}
`;

const CROWN_WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct Crown {
  centre: vec4f,   // xyz = entry point on the water, domain coordinates, w = radius of the crown's foot now (m)
  shape: vec4f,    // x = height of the rim now (m), y = outward lean (m per m of height), z = thickness of the sheet at its foot (m), w = age (s)
  look: vec4f,     // x = optical depth across the sheet at its foot, y = break-up 0..1, z = seed, w = march steps
  bound: vec4f,    // x = radius of the proxy (m), y = its height (m), z = 1 while the sheet still rises, w unused
}
struct CrownU { albedo: vec4f }
@group(2) @binding(0) var<uniform> crownU: CrownU;
@group(2) @binding(1) var<storage, read> crowns: array<Crown, ${MAX_FOAM}>;

struct CrownFrame { origin: vec3f, X: vec3f, Y: vec3f, Z: vec3f }
/// The crown's frame relative to the camera: Y = local vertical, origin on the water.
fn crownFrame(C: Crown) -> CrownFrame {
  var f: CrownFrame;
  f.origin = vfxDomainToRel(C.centre.xyz);
  f.Y = vfxDomainDir(vfx.domUp.xyz);
  var t = cross(f.Y, vec3f(0.0, 0.0, 1.0));
  if (dot(t, t) < 1e-4) { t = cross(f.Y, vec3f(1.0, 0.0, 0.0)); }
  f.X = normalize(t);
  f.Z = cross(f.X, f.Y);
  return f;
}

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let C = crowns[ii];
  let f = crownFrame(C);
  var o: VOut;
  o.pos = volumeBoxVertex(vi, f.origin, f.X, f.Y, f.Z, vec3f(-C.bound.x, -0.5, -C.bound.x), vec3f(C.bound.x, C.bound.y, C.bound.x));
  o.inst = ii;
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let C = crowns[in.inst];
  let f = crownFrame(C);
  let R = volumeRay(in.pos, f.origin, f.X, f.Y, f.Z, vec3f(-C.bound.x, -0.5, -C.bound.x), vec3f(C.bound.x, C.bound.y, C.bound.x));
  if (R.t1 <= R.t0) { return volumeNone(); }
  let foot = C.centre.w;
  let H = max(C.shape.x, 0.05);
  let lean = C.shape.y;
  let thick = C.shape.z;
  let breakup = C.look.y;
  let seed = C.look.z;
  let steps = max(10.0, floor(C.look.w * vfx.time.w + 0.5));
  let dt = (R.t1 - R.t0) / steps;
  let jitter = blueNoise(vec2u(in.pos.xy)).g;
  let probe = vfxProbes[0];
  let sunL = vec3f(dot(frame.sunDir.xyz, f.X), dot(frame.sunDir.xyz, f.Y), dot(frame.sunDir.xyz, f.Z));
  let amb = vfxProbeAmbient(0u);
  let fp = 2.0 * frame.cameraUp.w * vfx.half.w;
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = R.t0 + (i + jitter) * dt;
    let p = R.ro + R.rd * t;
    if (p.y < 0.0) { continue; }
    let r = length(p.xz);
    let ang = p.xz / max(r, 1e-3);
    // The rim stands higher here and lower there: fingers, coarse and fine.
    let lod = max(t * fp, 0.5 * dt) / foot;
    let rimN = vfxNoiseLod(vec3f(ang * 0.55, seed), lod * 0.3);
    let rimF = vfxNoiseLod(vec3f(ang * 1.9, seed * 2.7 + 0.3), lod);
    let rim = H * (0.5 + 0.75 * rimN.r + 0.3 * (rimF.g - 0.5));
    let s = p.y / max(rim, 0.05);
    if (s > 1.0) { continue; }
    // The sheet: leaning outwards, more so towards the rim, thinner towards the rim.
    let rs = foot + p.y * lean * (1.0 + 0.35 * s);
    let w = thick * (1.0 - 0.7 * s) + 0.03;
    let across = (r - rs) / w;
    if (abs(across) > 2.6) { continue; }
    // It tears from the rim downwards: holes where the noise is low, more of them with time; what is left
    // between them are the ligaments.
    let tear = vfxNoiseLod(vec3f(ang * 2.6, p.y / foot * 0.9 - C.shape.w * 0.25 + seed * 5.1), lod * 1.3);
    let fine = vfxNoiseLod(vec3f(ang * 7.0, p.y / foot * 2.8 - C.shape.w * 0.6 + seed * 1.3), lod * 3.5);
    let hold = 0.62 * tear.g + 0.38 * fine.b;
    let cut = breakup * (0.25 + 1.0 * s) - 0.12;
    let whole = smoothstep(cut, cut + 0.16, hold) * (1.0 - smoothstep(0.86, 1.0, s));
    if (whole <= 0.0) { continue; }
    let sigma = C.look.x / thick * exp(-across * across) * whole;
    let stepT = exp(-sigma * dt);
    // White water: light from both sides gets through a sheet this thin, a little more from the side it faces.
    let nrm = normalize(vec3f(ang.x, -lean, ang.y) * sign(across + 1e-4));
    let facing = dot(nrm, sunL);
    let sun = probe.sun.rgb * (0.38 + 0.42 * saturate(facing) + 0.2 * saturate(-facing));
    let J = crownU.albedo.rgb * (sun + amb * (0.75 + 0.25 * nrm.y)) * (1.0 / PI);
    let c = J * (1.0 - stepT);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * t;
    T *= stepT;
    if (T < 0.01) { break; }
  }
  if (T > 0.999) { return volumeNone(); }
  return volumeOut(R.uv, L, T, clamp(tsum / max(wsum, 1e-20), R.t0, R.t1));
}
`;

interface FoamPatch {
  pos: Vec3;
  start: number;
  bodyRadius: number;
  strength: number;
  seed: number;
  /** Speed at which the crown is thrown up, m/s. */
  crownSpeed: number;
}

export class FoamRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_FOAM * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly waterLayout: GPUBindGroupLayout;
  private readonly water: SceneBindings;
  private waterGroup: GPUBindGroup | null = null;
  private waterVersion = -1;
  private readonly crownData = new Float32Array(MAX_FOAM * CROWN_FLOATS);
  private readonly crownBuffer: GPUBuffer;
  private readonly crownGroup: GPUBindGroup;
  private readonly crownPipeline: Tracked<GPURenderPipeline>;
  private crownDistances: number[] = [];
  private patches: FoamPatch[] = [];

  constructor(
    ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    const S = vfx.splash;
    this.buffer = device.createBuffer({ label: 'vfx.foam', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniform = device.createBuffer({ label: 'vfx.foam.u', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([...S.foamAlbedo, S.foamSwell, 0, 0, 0, 0]));
    const layout = device.createBindGroupLayout({
      label: 'vfx.foam',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.group = device.createBindGroup({ label: 'vfx.foam', layout, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: this.buffer } }] });
    // What tells water from a hull: the opaque depth and the G-buffer material, in a group of their own.
    this.water = common.core.createSceneBindings(3, 0, ['sceneDepthOpaque', 'gbuffer']);
    this.waterLayout = device.createBindGroupLayout({ label: 'vfx.foam.water', entries: this.water.layoutEntries });
    this.pipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.foam', FOAM_WGSL(this.water.wgsl));
      return device.createRenderPipeline({
        label: 'vfx.foam',
        layout: device.createPipelineLayout({ label: 'vfx.foam', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, layout, this.waterLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        // Back faces without a depth test: the box is drawn once per pixel whether the eye is inside it or not.
        primitive: { topology: 'triangle-list', cullMode: 'front' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
      });
    });
    this.pipeline.get();

    this.crownBuffer = device.createBuffer({ label: 'vfx.crown', size: this.crownData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const crownUniform = device.createBuffer({ label: 'vfx.crown.u', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(crownUniform, 0, new Float32Array([...S.crown.albedo, 0]));
    const crownLayout = device.createBindGroupLayout({
      label: 'vfx.crown',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.crownGroup = device.createBindGroup({ label: 'vfx.crown', layout: crownLayout, entries: [{ binding: 0, resource: { buffer: crownUniform } }, { binding: 1, resource: { buffer: this.crownBuffer } }] });
    this.crownPipeline = createVolumePipeline(ctx, common, 'vfx.crown', CROWN_WGSL, crownLayout);
    this.crownPipeline.get();
  }

  spawn(s: SplashSpawn, effectTime: number): void {
    if (this.patches.length >= MAX_FOAM) this.patches.shift();
    this.patches.push({
      pos: v3.clone(s.pos),
      start: effectTime,
      bodyRadius: s.radius,
      strength: Math.min(1, s.speed / 6),
      seed: (s.seed % 251) / 251,
      crownSpeed: s.speed * this.vfx.splash.crownSpeedFactor * this.vfx.splash.crown.rise,
    });
  }

  rebase(rb: DomainRebase): void {
    for (const p of this.patches) p.pos = applyRebase(rb, p.pos, v3.zero()).p;
  }

  clear(): void {
    this.patches = [];
    this.crownDistances = [];
  }

  /** Age the patches and pack the foam decals and the crowns. */
  update(frame: FrameContext, dom: DomainFrame, effectTime: number): void {
    const S = this.vfx.splash;
    const K = S.crown;
    this.patches = this.patches.filter((p) => effectTime - p.start < S.foamTime);
    this.crownDistances = [];
    const originRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    const gravity = dom.gravity > 0.1 ? dom.gravity : GRAVITY_FALLBACK;
    const lean = Math.tan(((90 - 0.5 * (S.crownAngleDeg[0] + S.crownAngleDeg[1])) * Math.PI) / 180);
    this.patches.forEach((p, i) => {
      const age = effectTime - p.start;
      const radius = p.bodyRadius * (1.2 + S.foamRadiusFactor * (1 - Math.exp(-age / 2.5)) + 0.04 * age);
      this.data.set([p.pos.x, p.pos.y, p.pos.z, radius, age / S.foamTime, p.strength, p.seed, p.bodyRadius], i * INST_FLOATS);
      // The crown: up on the speed of the impact, down under gravity; it has torn apart by the time its rim is back at the water.
      const flight = (2 * p.crownSpeed) / gravity;
      const life = age / flight;
      if (life >= 1 || p.strength <= 0) return;
      const peak = (p.crownSpeed * p.crownSpeed) / (2 * gravity);
      const height = crownHeight(p.crownSpeed, gravity, age);
      const foot = p.bodyRadius * (1.05 + K.spread * (1 - Math.exp(-age / (0.35 * flight))));
      const thick = K.thickness * p.bodyRadius * (1 - 0.55 * life);
      const o = this.crownDistances.length * CROWN_FLOATS;
      const C = this.crownData;
      C.set([p.pos.x, p.pos.y, p.pos.z, foot], o);
      C.set([height, lean, thick, age], o + 4);
      C.set([K.opticalDepth * p.strength * (1 - 0.6 * life * life), Math.min(1, K.breakup * Math.pow(life, 0.8)), p.seed, K.steps], o + 8);
      // The rim reaches 1.4 heights where the noise stands it highest; the sheet leans out by up to 1.35 lean x height.
      const top = 1.4 * Math.max(height, 0.05);
      C.set([foot + 1.35 * lean * top + 2.6 * thick + 0.1, top + 0.2, age < 0.5 * flight ? 1 : 0, peak], o + 12);
      this.crownDistances.push(v3.len(v3.add(originRel, quat.rotate(dom.q, p.pos))));
    });
    if (this.patches.length > 0) this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.patches.length * INST_FLOATS);
    if (this.crownDistances.length > 0) this.device.queue.writeBuffer(this.crownBuffer, 0, this.crownData, 0, this.crownDistances.length * CROWN_FLOATS);
  }

  get count(): number {
    return this.patches.length;
  }

  /** Crowns standing this frame. */
  get crownCount(): number {
    return this.crownDistances.length;
  }

  /** Volume-pass items: the crowns. */
  items(): VolumeItem[] {
    return this.crownDistances.map((distance, i) => ({
      distance,
      draw: (pass: GPURenderPassEncoder) => {
        pass.setPipeline(this.crownPipeline.get());
        pass.setBindGroup(2, this.crownGroup);
        pass.draw(36, 1, 0, i);
      },
    }));
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.patches.length === 0) return;
    const v = this.water.version();
    if (!this.waterGroup || v !== this.waterVersion) {
      this.waterVersion = v;
      this.waterGroup = this.device.createBindGroup({ label: 'vfx.foam.water', layout: this.waterLayout, entries: this.water.entries() });
    }
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.group);
    pass.setBindGroup(3, this.waterGroup);
    pass.draw(36, this.patches.length);
  }

  dispose(): void {
    this.buffer.destroy();
    this.crownBuffer.destroy();
  }
}
