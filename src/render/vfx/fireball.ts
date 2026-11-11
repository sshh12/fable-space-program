/**
 * Fireballs: the volume of an explosion (a ruptured tank, a destroyed part). A turbulent sphere that grows
 * fast and cools: white-yellow fire first, then orange, then - where there is air - a rising ball of dark
 * smoke lit by the sun. In vacuum the gas only expands and fades. Each one lives in the effect domain and
 * lights its surroundings while it burns.
 */
import type { FrameContext, LocalLight, RenderContext } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { FireballSpawn } from './director';
import { applyRebase, type DomainFrame, type DomainRebase } from './domain';
import { createVolumePipeline, type EmitterHint, type VolumeItem } from './volumes';

export const MAX_FIREBALLS = 8;
const INST_FLOATS = 16;

interface Fireball {
  pos: Vec3;
  vel: Vec3;
  start: number;
  radiusMax: number;
  duration: number;
  seed: number;
}

const WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct FireballInst {
  centre: vec4f,   // xyz = centre relative to the camera, w = radius now (m)
  state: vec4f,    // x = heat 0..1, y = smoke 0..1 (grows as the fire dies, 0 in vacuum), z = seed, w = age / duration
  color: vec4f,    // rgb = fire colour x luminance (cd/m^2), w = march steps
  smoke: vec4f,    // rgb = smoke albedo, w = noise scroll (m)
}
@group(2) @binding(0) var<storage, read> fireballs: array<FireballInst, ${MAX_FIREBALLS}>;

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
const AX = vec3f(1.0, 0.0, 0.0);
const AY = vec3f(0.0, 1.0, 0.0);
const AZ = vec3f(0.0, 0.0, 1.0);
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let I = fireballs[ii];
  var o: VOut;
  o.pos = volumeBoxVertex(vi, I.centre.xyz, AX, AY, AZ, vec3f(-1.25 * I.centre.w), vec3f(1.25 * I.centre.w));
  o.inst = ii;
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let I = fireballs[in.inst];
  let R = I.centre.w;
  let ray = volumeRay(in.pos, I.centre.xyz, AX, AY, AZ, vec3f(-1.25 * R), vec3f(1.25 * R));
  if (ray.t1 <= ray.t0) { return volumeNone(); }
  let steps = max(8.0, floor(I.color.w * vfx.time.w + 0.5));
  let dt = (ray.t1 - ray.t0) / steps;
  let jitter = blueNoise(vec2u(in.pos.xy)).a;
  let heat = I.state.x;
  let smokeAmount = I.state.y;
  let probe = vfxProbes[0];
  let sun = probe.sun.rgb * (0.8 / PI);
  let amb = vfxProbeAmbient(0u) * (1.0 / PI);
  let seed = vec3f(I.state.z, I.state.z * 1.7, I.state.z * 0.3);
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = ray.t0 + (i + jitter) * dt;
    let p = ray.ro + ray.rd * t;
    let rr = length(p) / R;
    if (rr > 1.25) { continue; }
    let q = p / R;
    let n = vfxNoiseLod(q * 0.45 + seed + vec3f(0.0, 0.0, -I.smoke.w / R * 0.2), dt / R * 0.45);
    let n2 = vfxNoiseLod(q * 1.3 + seed * 3.1, dt / R * 1.3);
    // A sphere with a boiling surface.
    let lobes = vfxNoiseLod(q * 0.35 + seed * 1.7, dt / R * 0.35);
    let shape = 1.0 - smoothstep(0.55, 0.95, rr * (0.66 + 0.7 * smoothstep(0.3, 0.7, lobes.r)) + (n.g - 0.5) * 1.0 + (n2.b - 0.5) * 0.45);
    if (shape <= 0.0) { continue; }
    // Hot in the middle and in the folds; the fire dies from the outside in.
    // While the ball is young it is hot right out to its surface.
    let local = saturate(heat * (1.35 - rr * (1.0 - 0.5 * heat)) * (0.45 + 1.1 * n.r) * (0.6 + 0.8 * n2.g));
    let fire = I.color.rgb * (local * local * local * 4.0) + I.color.rgb * vec3f(1.0, 1.6, 3.2) * (pow(local, 6.0) * 2.5);
    let sigma = shape * (2.5 * heat + 5.0 * smokeAmount * (0.3 + 1.4 * n.g * (0.5 + n2.b))) / R;
    // Smoke shades itself: one more look at the shape a quarter radius towards the sun.
    let ps = q + frame.sunDir.xyz * 0.25;
    let ns = vfxNoiseLod(ps * 0.45 + seed + vec3f(0.0, 0.0, -I.smoke.w / R * 0.2), dt / R * 0.45);
    let towardSun = 1.0 - smoothstep(0.55, 0.95, length(ps) + (ns.g - 0.5) * 0.9);
    let shade = exp(-towardSun * 2.2 * smokeAmount) * (0.25 + 0.75 * saturate(0.5 + 0.5 * dot(p / (R * max(rr, 0.05)), frame.sunDir.xyz)));
    let lit = I.smoke.rgb * (sun * shade + amb * (0.5 + 0.5 * shape)) * smokeAmount;
    let stepT = exp(-sigma * dt);
    let c = (fire + lit) * (1.0 - stepT);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * t;
    T *= stepT;
    if (T < 0.004) { break; }
  }
  if (wsum < 1e-9 && T > 0.999) { return volumeNone(); }
  return volumeOut(ray.uv, L, T, clamp(tsum / max(wsum, 1e-20), ray.t0, ray.t1));
}
`;

export class FireballRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_FIREBALLS * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private balls: Fireball[] = [];
  private distances: number[] = [];
  readonly lights: { light: LocalLight; power: number }[] = [];
  readonly hints: EmitterHint[] = [];

  constructor(
    ctx: RenderContext,
    common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.buffer = device.createBuffer({ label: 'vfx.fireball', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ label: 'vfx.fireball', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.group = device.createBindGroup({ label: 'vfx.fireball', layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
    this.pipeline = createVolumePipeline(ctx, common, 'vfx.fireball', WGSL, layout);
    this.pipeline.get();
  }

  spawn(s: FireballSpawn, effectTime: number): void {
    const E = this.vfx.explosion;
    const k = Math.cbrt(Math.max(s.energy, 1));
    const radiusMax = Math.min(E.maxRadius, Math.max(E.minRadius, E.radiusPerCbrtJoule * k));
    if (this.balls.length >= MAX_FIREBALLS) {
      // Full: the new one replaces the smallest, unless it is smaller still.
      let smallest = 0;
      for (let i = 1; i < this.balls.length; i++) if (this.balls[i]!.radiusMax < this.balls[smallest]!.radiusMax) smallest = i;
      if (this.balls[smallest]!.radiusMax >= radiusMax) return;
      this.balls.splice(smallest, 1);
    }
    this.balls.push({
      pos: v3.clone(s.pos),
      vel: v3.clone(s.vel),
      start: effectTime,
      radiusMax,
      duration: Math.max(E.minDuration, E.durationPerCbrtJoule * k),
      seed: (s.seed % 997) / 997,
    });
  }

  rebase(rb: DomainRebase): void {
    for (const b of this.balls) {
      const r = applyRebase(rb, b.pos, b.vel);
      b.pos = r.p;
      b.vel = r.v;
    }
  }

  clear(): void {
    this.balls = [];
  }

  /** Move, age and pack the fireballs; `density` = air density at the domain origin (kg/m^3). */
  update(frame: FrameContext, dom: DomainFrame, effectTime: number, dt: number, density: number): void {
    const E = this.vfx.explosion;
    const D = this.data;
    this.lights.length = 0;
    this.hints.length = 0;
    this.distances = [];
    const air = Math.min(1, density / 1.2);
    const originRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    this.balls = this.balls.filter((b) => effectTime - b.start < b.duration * (air > 0.01 ? 4 : 1.5));
    this.balls.forEach((b, i) => {
      const age = effectTime - b.start;
      // The air stops the cloud and lifts it; in vacuum it keeps the velocity of what exploded.
      if (air > 0.001) {
        b.vel = v3.scale(b.vel, Math.exp(-dt * 1.2 * air));
        b.vel = v3.addScaled(b.vel, dom.up, 6 * air * Math.min(1, age / b.duration) * dt);
      }
      b.pos = v3.addScaled(b.pos, b.vel, dt);
      const grow = Math.pow(1 - Math.exp((-4 * age) / b.duration), 0.6);
      const radius = b.radiusMax * (0.15 + 0.85 * grow) * (air > 0.01 ? 1 + 0.12 * (age / b.duration) : 1 + 0.8 * (age / b.duration));
      const heat = Math.exp(-age / (0.32 * b.duration));
      const fadeOut = 1 - Math.min(1, Math.max(0, (age - 2.5 * b.duration) / (1.5 * b.duration)));
      const smoke = air > 0.01 ? Math.sqrt(air) * (1 - heat) * fadeOut : 0;
      const rel = v3.add(originRel, quat.rotate(dom.q, b.pos));
      const o = i * INST_FLOATS;
      D.set([rel.x, rel.y, rel.z, radius], o);
      D.set([heat * (air > 0.01 ? 1 : Math.exp(-age / (0.4 * b.duration))), smoke, b.seed, age / b.duration], o + 4);
      D.set([E.color[0] * E.luminance, E.color[1] * E.luminance, E.color[2] * E.luminance, E.steps], o + 8);
      D.set([E.smokeAlbedo[0], E.smokeAlbedo[1], E.smokeAlbedo[2], age * 4], o + 12);
      this.distances.push(v3.len(rel));
      if (heat > 0.05) this.hints.push({ rel, a: 0.8 * radius, b: 0.8 * radius, luminance: E.luminance * heat * heat * heat });
      const power = E.lightEfficacy * E.luminance * heat * heat * Math.PI * radius * radius;
      if (power > 1) this.lights.push({ power, light: { kind: 'point', posRelCam: rel, intensity: [E.color[0] * power, E.color[1] * power, E.color[2] * power], range: Math.min(20000, 60 * radius) } });
    });
    if (this.balls.length > 0) this.device.queue.writeBuffer(this.buffer, 0, D, 0, this.balls.length * INST_FLOATS);
  }

  get count(): number {
    return this.balls.length;
  }

  items(): VolumeItem[] {
    return this.distances.map((distance, i) => ({
      distance,
      draw: (pass: GPURenderPassEncoder) => {
        pass.setPipeline(this.pipeline.get());
        pass.setBindGroup(2, this.group);
        pass.draw(36, 1, 0, i);
      },
    }));
  }

  dispose(): void {
    this.buffer.destroy();
  }
}
