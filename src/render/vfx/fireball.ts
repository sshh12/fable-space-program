/**
 * Fireballs: the volume of an explosion (a ruptured tank, a destroyed part). A turbulent ball that bursts
 * out in a few directional lobes, grows fast and cools: white-yellow fire first, then orange, then - where
 * there is air - a rising, lengthening cloud of dark smoke lit by the sun. In vacuum the gas only expands and
 * fades. A large explosion is followed by smaller ones around it and throws out burning fragments that fall
 * in arcs and leave smoke (the trail system draws it). Everything lives in the effect domain and lights its
 * surroundings while it burns.
 */
import type { FrameContext, LocalLight, RenderContext } from '@/core/contracts/render';
import { hashToUnit, hashU32, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { FireballSpawn } from './director';
import { applyRebase, type DomainFrame, type DomainRebase } from './domain';
import type { EmitterDesc } from './particles';
import { createVolumePipeline, type EmitterHint, type VolumeItem } from './volumes';

export const MAX_FIREBALLS = 16;
export const FIREBALL_LOBES = 6;
const INST_FLOATS = 24 + 4 * FIREBALL_LOBES;
/** The boiling surface of the ball lies within this many radii of its centre whatever the noise does. */
const BALL_BOUND = 1.56;
/** A lobe ends this many radii beyond its reach (its tip is 0.36 radii wide), and the warp moves everything by up to this much. */
const LOBE_TIP = 0.78;
const WARP = 0.3;

interface Fireball {
  pos: Vec3;
  vel: Vec3;
  start: number;
  radiusMax: number;
  duration: number;
  seed: number;
  /** Unit directions (domain axes) and reach (radii) of the lobes. */
  lobes: { dir: Vec3; reach: number }[];
}

/** A burning piece thrown out by an explosion. */
interface Fragment {
  key: string;
  pos: Vec3;
  vel: Vec3;
  born: number;
  /** Seconds it burns, and the radius of its smoke at birth, m. */
  burn: number;
  radius: number;
  seed: number;
}

/** What a fragment leaves in the air this frame (for the trail system). */
export interface FragmentTrail {
  key: string;
  bodyId: string;
  /** Position relative to the camera (ROOT axes). */
  rel: Vec3;
  radius: number;
  /** Smoke optical depth across the trail at birth, glow luminance (cd/m^2) and colour. */
  smoke: number;
  glow: number;
  color: Vec3Tuple;
}

const WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct FireballInst {
  centre: vec4f,   // xyz = centre relative to the camera, w = radius now (m)
  state: vec4f,    // x = heat 0..1, y = smoke 0..1 (grows as the fire dies, 0 in vacuum), z = seed, w = radius of the sphere that holds everything, in radii
  color: vec4f,    // rgb = fire colour x luminance (cd/m^2), w = march steps
  smoke: vec4f,    // rgb = smoke albedo, w = noise scroll (m)
  axis: vec4f,     // xyz = unit axis along which the cloud is drawn out (ROOT axes), w = how much there is to make soot of (0 in vacuum .. 1)
  stretch: vec4f,  // x = how much the cloud is drawn out along the axis (1 = a ball)
  lobes: array<vec4f, ${FIREBALL_LOBES}>,   // xyz = unit direction of a lobe (ROOT axes), w = its reach in radii (0 = none)
}
@group(2) @binding(0) var<storage, read> fireballs: array<FireballInst, ${MAX_FIREBALLS}>;

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
const AX = vec3f(1.0, 0.0, 0.0);
const AY = vec3f(0.0, 1.0, 0.0);
const AZ = vec3f(0.0, 0.0, 1.0);
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let I = fireballs[ii];
  var o: VOut;
  let b = I.state.w * I.centre.w * I.stretch.x;
  o.pos = volumeBoxVertex(vi, I.centre.xyz, AX, AY, AZ, vec3f(-b), vec3f(b));
  o.inst = ii;
  return o;
}

/// The shape as a "radius" in units of the fireball's radius: below about 0.7 inside, 1.55 and more is always
/// empty. 'q' = position in radii, with the stretch along the axis taken out.
fn fireballField(I: FireballInst, q: vec3f) -> f32 {
  var f = length(q);
  for (var i = 0; i < ${FIREBALL_LOBES}; i++) {
    let lobe = I.lobes[i];
    if (lobe.w <= 0.0) { continue; }
    // A blunt, tapering tongue from the centre outwards.
    let h = clamp(dot(q, lobe.xyz), 0.0, lobe.w);
    let width = 0.66 - 0.3 * h / lobe.w;
    f = min(f, length(q - lobe.xyz * h) / width * 0.72);
  }
  return f;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let I = fireballs[in.inst];
  let R = I.centre.w;
  let b = I.state.w * R * I.stretch.x;
  var ray = volumeRay(in.pos, I.centre.xyz, AX, AY, AZ, vec3f(-b), vec3f(b));
  // Inside the box, only the sphere that holds everything is marched.
  let pb = dot(ray.ro, ray.rd);
  let disc = pb * pb - (dot(ray.ro, ray.ro) - b * b);
  if (disc <= 0.0) { return volumeNone(); }
  let sq_ = sqrt(disc);
  ray.t0 = max(ray.t0, -pb - sq_);
  ray.t1 = min(ray.t1, -pb + sq_);
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
  let squeeze = 1.0 - 1.0 / I.stretch.x;
  let boil = vec3f(0.0, 0.0, -I.smoke.w / R * 0.2);
  // Size of a pixel of this pass at one metre; the first frames are a flash: everything white-hot.
  let pixel = 2.0 * frame.cameraUp.w * vfx.half.w;
  let flash = exp(-I.smoke.w * 0.25 / 0.045);
  let fireLum = luminance(I.color.rgb);
  let air = I.axis.w;
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = ray.t0 + (i + jitter) * dt;
    let p = ray.ro + ray.rd * t;
    var q = p / R;
    q -= I.axis.xyz * (dot(q, I.axis.xyz) * squeeze);
    if (dot(q, q) > sq(I.state.w)) { continue; }
    // The whole shape is bent by slow noise: no straight jets, no round ball.
    let bend = vfxNoiseLod(q * 0.21 + seed * 1.7, dt / R * 0.2);
    q += (vec3f(bend.r, bend.a, bend.g) - 0.5) * (2.0 * ${WARP});
    let f = fireballField(I, q);
    if (f > ${BALL_BOUND}) { continue; }
    // Detail finer than a pixel of this pass is left out; what is left goes down to a fiftieth of the radius.
    let foot = max(dt, pixel * t) / R;
    let n = vfxNoiseLod(q * 0.45 + seed + boil, foot * 0.2);
    let n2 = vfxNoiseLod(q * 1.3 + seed * 3.1 + boil * 2.0, foot * 0.6);
    let n3 = vfxNoiseLod(q * 3.3 + seed * 5.3 + boil * 3.0, foot * 1.6);
    let n4 = vfxNoiseLod(q * 8.7 + seed * 7.9 + boil * 4.0, foot * 4.3);
    // A boiling surface with a hard edge: the noise moves it by up to 0.65 radii (cauliflower at every scale
    // the pass can show), and it ends at 1.55 whatever the noise does.
    let surface = f + (n.g - 0.5) * 0.7 + (n2.b - 0.5) * 0.35 + (n3.g - 0.5) * 0.12 + (n4.b - 0.5) * 0.05;
    let shape = 1.0 - smoothstep(0.62, 0.86, surface);
    if (shape <= 0.0) { continue; }
    // Temperature: hot in the middle and in the cells of the turbulence, cold in the folds between them and
    // towards the surface; the fire dies from the outside in. While the ball is young it is hot right out to
    // its surface. Hot gas shines by its temperature (white, yellow, orange, dull red); gas that has cooled
    // is soot: black-brown, opaque, wrapped around the fire from the first moment, so that the fire shows
    // through cracks.
    let cellsT = (0.3 + 1.4 * n.r) * (0.5 + 1.0 * n2.g) * (0.72 + 0.56 * n3.b);
    let temp = 0.85 * pow(heat, 0.55) * saturate(1.3 - surface * mix(0.5, 1.25, 1.0 - heat)) * cellsT * (1.0 + 2.5 * flash);
    let glowT = smoothstep(0.22, 1.0, temp);
    var hue = mix(vec3f(1.0, 0.1, 0.012), vec3f(1.0, 0.42, 0.07), smoothstep(0.25, 0.5, temp));
    hue = mix(hue, vec3f(1.0, 0.78, 0.36), smoothstep(0.55, 0.9, temp));
    hue = mix(hue, vec3f(1.0, 0.98, 0.9), smoothstep(0.95, 1.3, temp));
    let fire = hue * (fireLum * glowT * glowT * glowT * glowT * (1.0 + 6.0 * flash));
    let soot = air * (1.0 - smoothstep(0.2, 0.55, temp)) * (0.35 + 1.3 * n2.b);
    let sigmaHot = 2.2 * glowT;
    let sigmaSoot = 6.0 * max(soot * (0.35 + 0.65 * (1.0 - heat)), smokeAmount * (0.3 + 1.4 * n.g * (0.5 + n2.b)));
    let sigma = shape * (sigmaHot + sigmaSoot) / R;
    // Smoke shades itself: one more look at the shape a quarter radius towards the sun.
    let ps = q + frame.sunDir.xyz * 0.25;
    let ns = vfxNoiseLod(ps * 0.45 + seed + boil, dt / R * 0.3);
    let towardSun = 1.0 - smoothstep(0.6, 0.9, fireballField(I, ps) + (ns.g - 0.5) * 0.8);
    let shade = exp(-towardSun * 3.2) * (0.15 + 0.85 * saturate(0.5 + 0.5 * dot(normalize(q + vec3f(1e-4)), frame.sunDir.xyz)));
    // The fire inside lights the smoke around it.
    // (The cells of the fine noise are lumps with crevices between them: darker there.)
    let lumps = 0.45 + 0.85 * smoothstep(0.15, 0.7, n3.b);
    let lit = I.smoke.rgb * (sun * shade * lumps + amb * (0.35 + 0.4 * shape) * lumps) + I.color.rgb * (0.008 * heat * shape);
    let stepT = exp(-sigma * dt);
    // Source function of the mixture: hot gas radiates, soot reflects.
    let c = (fire * sigmaHot + lit * sigmaSoot) / max(sigmaHot + sigmaSoot, 1e-6) * (1.0 - stepT);
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

const rand = (seed: number, k: number): number => hashToUnit(hashU32((seed * 2654435761 + k * 40503) >>> 0));

/** A unit vector from two random numbers, uniformly over the sphere. */
function randomDir(a: number, b: number): Vec3 {
  const z = 2 * a - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * Math.cos(2 * Math.PI * b), y: r * Math.sin(2 * Math.PI * b), z };
}

export class FireballRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_FIREBALLS * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private balls: Fireball[] = [];
  private pending: { at: number; spawn: FireballSpawn; scale: number }[] = [];
  private fragments: Fragment[] = [];
  private distances: number[] = [];
  readonly lights: { light: LocalLight; power: number }[] = [];
  readonly hints: EmitterHint[] = [];
  /** What the burning fragments leave behind this frame. */
  readonly trails: FragmentTrail[] = [];

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

  /**
   * A new fireball. `up` = local vertical in domain axes, `air` = 0..1 (1 = sea-level density). An explosion
   * (`s.secondaries`) is followed by smaller fireballs around it and throws burning fragments.
   */
  spawn(s: FireballSpawn, effectTime: number, up: Vec3, air: number): void {
    const E = this.vfx.explosion;
    this.add(s, effectTime, 1, up, air);
    if (!s.secondaries) return;
    const seed = s.seed >>> 0;
    const k = Math.cbrt(Math.max(s.energy, 1));
    const radius = Math.min(E.maxRadius, Math.max(E.minRadius, E.radiusPerCbrtJoule * k));
    for (let i = 0; i < E.secondaries; i++) {
      // In air the cloud stands on the ground side of nothing: later bursts come from the upper half-space as often as not.
      // They break out of the side of the first ball: near enough to merge with it, far enough to change its outline.
      const dir = randomDir(rand(seed, 11 + i), rand(seed, 31 + i));
      const offset = v3.scale(dir, radius * (0.25 + 0.3 * rand(seed, 51 + i)));
      this.pending.push({
        at: effectTime + 0.12 + 0.75 * rand(seed, 71 + i) * (1 + i * 0.35),
        scale: 0.5 + 0.25 * rand(seed, 91 + i),
        spawn: { ...s, pos: v3.add(s.pos, offset), vel: v3.addScaled(s.vel, dir, (0.15 * radius) / Math.max(E.minDuration, E.durationPerCbrtJoule * k)), seed: seed + 97 * (i + 1), secondaries: false },
      });
    }
    // Fragments outrun the fireball (which reaches its radius in about a quarter of its duration).
    const speed = (E.fragmentSpeed * radius) / Math.max(E.minDuration, 0.25 * E.durationPerCbrtJoule * k);
    for (let i = 0; i < E.fragments; i++) {
      let dir = randomDir(rand(seed, 111 + i), rand(seed, 131 + i));
      // Where there is air there is ground below sooner or later: most pieces go up and out.
      if (air > 0.01 && v3.dot(dir, up) < -0.2) dir = v3.normalize(v3.addScaled(dir, up, -2 * v3.dot(dir, up)));
      const v = speed * (0.4 + 0.6 * rand(seed, 151 + i));
      this.fragments.push({
        key: `fragment|${seed}|${i}`,
        pos: v3.addScaled(s.pos, dir, 0.25 * radius),
        vel: v3.addScaled(s.vel, dir, v),
        born: effectTime,
        burn: E.fragmentBurn[0] + (E.fragmentBurn[1] - E.fragmentBurn[0]) * rand(seed, 171 + i),
        radius: radius * (0.002 + 0.003 * rand(seed, 191 + i)),
        seed: seed + i,
      });
    }
    if (this.fragments.length > 4 * MAX_FIREBALLS) this.fragments.splice(0, this.fragments.length - 4 * MAX_FIREBALLS);
  }

  private add(s: FireballSpawn, effectTime: number, scale: number, up: Vec3, air: number): void {
    const E = this.vfx.explosion;
    const k = Math.cbrt(Math.max(s.energy, 1));
    const radiusMax = scale * Math.min(E.maxRadius, Math.max(E.minRadius, E.radiusPerCbrtJoule * k));
    if (this.balls.length >= MAX_FIREBALLS) {
      // Full: the new one replaces the smallest, unless it is smaller still.
      let smallest = 0;
      for (let i = 1; i < this.balls.length; i++) if (this.balls[i]!.radiusMax < this.balls[smallest]!.radiusMax) smallest = i;
      if (this.balls[smallest]!.radiusMax >= radiusMax) return;
      this.balls.splice(smallest, 1);
    }
    const seed = s.seed >>> 0;
    const lobes: Fireball['lobes'] = [];
    const count = 3 + Math.floor(rand(seed, 1) * (FIREBALL_LOBES - 2));
    for (let i = 0; i < count; i++) {
      let dir = randomDir(rand(seed, 201 + i), rand(seed, 221 + i));
      // No lobe straight down into the ground.
      if (air > 0.01 && v3.dot(dir, up) < -0.3) dir = v3.normalize(v3.addScaled(dir, up, -1.6 * v3.dot(dir, up)));
      lobes.push({ dir, reach: 0.8 + 0.45 * rand(seed, 241 + i) });
    }
    this.balls.push({
      pos: v3.clone(s.pos),
      vel: v3.clone(s.vel),
      start: effectTime,
      radiusMax,
      duration: Math.max(E.minDuration, E.durationPerCbrtJoule * k) * (0.55 + 0.45 * scale),
      seed: (s.seed % 997) / 997,
      lobes,
    });
  }

  rebase(rb: DomainRebase): void {
    for (const b of this.balls) {
      const r = applyRebase(rb, b.pos, b.vel);
      b.pos = r.p;
      b.vel = r.v;
    }
    for (const f of this.fragments) {
      const r = applyRebase(rb, f.pos, f.vel);
      f.pos = r.p;
      f.vel = r.v;
    }
    for (const p of this.pending) {
      const r = applyRebase(rb, p.spawn.pos, p.spawn.vel);
      p.spawn = { ...p.spawn, pos: r.p, vel: r.v };
    }
  }

  clear(): void {
    this.balls = [];
    this.pending = [];
    this.fragments = [];
  }

  /**
   * Move, age and pack the fireballs and their fragments; `density` = air density at the domain origin
   * (kg/m^3), `floor` = ground or water level as dot(up, p) (null = none). Returns the sparks the fragments shed.
   */
  update(frame: FrameContext, dom: DomainFrame, effectTime: number, dt: number, density: number, floor: number | null): EmitterDesc[] {
    const E = this.vfx.explosion;
    const P = this.vfx.particles;
    const D = this.data;
    this.lights.length = 0;
    this.hints.length = 0;
    this.trails.length = 0;
    this.distances = [];
    const emitters: EmitterDesc[] = [];
    const air = Math.min(1, density / 1.2);
    const originRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (effectTime < p.at) continue;
      this.add(p.spawn, effectTime, p.scale, dom.up, air);
      this.pending.splice(i, 1);
    }
    this.balls = this.balls.filter((b) => effectTime - b.start < b.duration * (air > 0.01 ? 4 : 1.5));
    this.balls.forEach((b, i) => {
      const age = effectTime - b.start;
      const life = age / b.duration;
      // The air stops the cloud and lifts it; in vacuum it keeps the velocity of what exploded.
      if (air > 0.001) {
        b.vel = v3.scale(b.vel, Math.exp(-dt * 1.2 * air));
        b.vel = v3.addScaled(b.vel, dom.up, 6 * air * Math.min(1, life) * dt);
      }
      b.pos = v3.addScaled(b.pos, b.vel, dt);
      const grow = Math.pow(1 - Math.exp(-4 * life), 0.6);
      const radius = b.radiusMax * (0.15 + 0.85 * grow) * (air > 0.01 ? 1 + 0.12 * life : 1 + 0.8 * life);
      const heat = Math.exp(-age / (0.32 * b.duration));
      const fadeOut = 1 - Math.min(1, Math.max(0, (age - 2.5 * b.duration) / (1.5 * b.duration)));
      const smoke = air > 0.01 ? Math.sqrt(air) * (1 - heat) * fadeOut : 0;
      const rel = v3.add(originRel, quat.rotate(dom.q, b.pos));
      // The rising cloud lengthens along the vertical (its top climbs faster than its foot).
      const axis = quat.rotate(dom.q, dom.up);
      const stretch = air > 0.01 ? 1 + 0.45 * air * Math.min(1.5, life) : 1;
      const o = i * INST_FLOATS;
      D.set([rel.x, rel.y, rel.z, radius], o);
      // The jets shoot out ahead of the ball and are caught up by it as it grows.
      const jet = 1 - 0.62 * Math.min(1, 1.5 * life);
      let bound = BALL_BOUND;
      for (const lobe of b.lobes) bound = Math.max(bound, lobe.reach * jet + LOBE_TIP);
      D.set([heat * (air > 0.01 ? 1 : Math.exp(-age / (0.4 * b.duration))), smoke, b.seed, bound + WARP], o + 4);
      D.set([E.color[0] * E.luminance, E.color[1] * E.luminance, E.color[2] * E.luminance, E.steps], o + 8);
      D.set([E.smokeAlbedo[0], E.smokeAlbedo[1], E.smokeAlbedo[2], age * 4], o + 12);
      D.set([axis.x, axis.y, axis.z, air > 0.01 ? Math.sqrt(air) : 0.15], o + 16);
      D.set([stretch, 0, 0, 0], o + 20);
      for (let k = 0; k < FIREBALL_LOBES; k++) {
        const lobe = b.lobes[k];
        if (lobe) {
          const d = quat.rotate(dom.q, lobe.dir);
          D.set([d.x, d.y, d.z, lobe.reach * jet], o + 24 + 4 * k);
        } else D.set([0, 0, 1, 0], o + 24 + 4 * k);
      }
      this.distances.push(v3.len(rel));
      if (heat > 0.05) this.hints.push({ rel, a: 0.8 * radius, b: 0.8 * radius, luminance: 0.5 * E.luminance * heat * heat });
      const power = E.lightEfficacy * E.luminance * heat * heat * Math.PI * radius * radius;
      if (power > 1) this.lights.push({ power, light: { kind: 'point', posRelCam: rel, intensity: [E.color[0] * power, E.color[1] * power, E.color[2] * power], range: Math.min(20000, 60 * radius) } });
    });
    if (this.balls.length > 0) this.device.queue.writeBuffer(this.buffer, 0, D, 0, this.balls.length * INST_FLOATS);

    // Fragments: ballistic, slowed by the air, burning for a while; what they shed is drawn by the trails and the particles.
    this.fragments = this.fragments.filter((f) => effectTime - f.born < f.burn + 0.5);
    for (const f of this.fragments) {
      const age = effectTime - f.born;
      if (dom.state.kind === 'surface') f.vel = v3.addScaled(f.vel, dom.up, -dom.gravity * dt);
      f.vel = v3.scale(f.vel, 1 / (1 + 0.004 * air * v3.len(f.vel) * dt));
      f.pos = v3.addScaled(f.pos, f.vel, dt);
      if (floor !== null && v3.dot(dom.up, f.pos) < floor) {
        f.burn = Math.min(f.burn, age);
        continue;
      }
      const burning = Math.max(0, 1 - age / f.burn);
      if (burning <= 0) continue;
      const rel = v3.add(originRel, quat.rotate(dom.q, f.pos));
      // Smoke hangs in air that turns with the body; in vacuum or in orbit there is nothing for a trail to hang in.
      if (dom.state.kind === 'surface' && air > 0.001) {
        this.trails.push({ key: f.key, bodyId: dom.state.bodyId, rel, radius: f.radius, smoke: E.fragmentSmoke * Math.sqrt(air) * (0.4 + 0.6 * burning), glow: E.fragmentGlow * burning, color: E.color });
      }
      const n = Math.floor(dt * 240 * burning * frame.qualityScale + rand(f.seed, Math.floor(effectTime * 60)));
      if (n > 0) {
        emitters.push({
          kind: 'spark',
          shape: 'sphere',
          pos: f.pos,
          axis: dom.up,
          radius: 0.6 * f.radius,
          vel: v3.scale(f.vel, 0.7),
          sweep: v3.scale(f.vel, dt),
          speed: [1, 14],
          polar: [0, Math.PI],
          life: [0.3, 1.1],
          size: P.sparks.size,
          color: [1, 1, 1],
          opacity: 1,
          aux: P.sparks.temperature,
          count: n,
          seed: (f.seed * 131 + Math.floor(effectTime * 60)) >>> 0,
        });
      }
    }
    return emitters;
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
