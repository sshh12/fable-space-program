/**
 * Reentry plasma: the bow-shock layer wrapped around the windward side of a vessel and the streaked wake
 * behind it, marched at half resolution in a box aligned with the air flow.
 *
 * The vessel is represented by a shape proxy (pure function `reentryProxy`): a rounded cylinder about the
 * vessel's long axis, from PartVisualDef.reentryShape of its windward part when present, else from the
 * parts' bounds. The shock stands off the wall by `standoff x nose radius` at the stagnation point and
 * further where the wall turns away from the flow. Emission follows heatFlux^0.75, the colour runs from
 * orange through pink to white-violet with the air speed, and the whole flickers at 8 - 30 Hz.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, LocalLight, RenderContext } from '@/core/contracts/render';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { hashToUnit, hashU32, quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import { createVolumePipeline, type EmitterHint, type VolumeItem } from './volumes';

export const MAX_PLASMA = 4;
const INST_FLOATS = 32;

export interface ReentryProxy {
  /** Centre of the proxy and its unit long axis, vessel frame. */
  centreVes: Vec3;
  axisVes: Vec3;
  /** Radius and half length of the rounded cylinder, radius of its edges, m. */
  radius: number;
  halfLength: number;
  rounding: number;
  /** Nose radius of the windward face, m. */
  noseRadius: number;
}

/**
 * Shape proxy of a vessel for the shock layer. `windVes` = unit direction the air flows in, vessel frame.
 * The windward part is the one that reaches furthest upstream; its reentryShape (or its thermal nose radius,
 * or its bounds) gives the nose radius.
 */
export function reentryProxy(defs: DefLibrary, vessel: VesselSnapshot, windVes: Vec3): ReentryProxy {
  let yMin = Infinity;
  let yMax = -Infinity;
  let radius = 0.3;
  let nose = 0;
  let upstream = Infinity;
  for (const part of vessel.parts) {
    const def = defs.parts[part.def];
    if (!def) continue;
    const axis = quat.rotate(part.localRot, v3.unitY());
    for (const y of [def.bounds.yMin, def.bounds.yMax]) {
      const p = v3.addScaled(part.localPos, axis, y);
      // The stack stands along the vessel's +Y: extent along it, radius about it.
      yMin = Math.min(yMin, p.y);
      yMax = Math.max(yMax, p.y);
      radius = Math.max(radius, Math.hypot(p.x, p.z) + def.bounds.radius * Math.abs(axis.y));
      const reach = v3.dot(p, windVes) - def.bounds.radius * Math.sqrt(Math.max(0, 1 - v3.dot(axis, windVes) ** 2));
      if (reach < upstream) {
        upstream = reach;
        const shape = def.visual?.reentryShape;
        let thermal = 0;
        for (const s of def.thermal.surfaces) thermal = Math.max(thermal, s.noseRadius);
        nose = shape ? shape.noseRadius : thermal > 0 ? thermal : def.bounds.radius;
      }
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = -vessel.boundingRadius;
    yMax = vessel.boundingRadius;
  }
  const halfLength = Math.max(0.5 * (yMax - yMin), 0.2);
  return {
    centreVes: { x: 0, y: 0.5 * (yMin + yMax), z: 0 },
    axisVes: v3.unitY(),
    radius,
    halfLength,
    rounding: Math.min(0.25 * radius, 0.5 * halfLength),
    noseRadius: Math.max(nose, 0.5 * radius),
  };
}

/** Colour of the plasma for an air speed (m/s): orange, pink, white-violet. */
export function plasmaColor(data: VfxData['reentry'], speed: number): Vec3Tuple {
  const [s0, s1, s2] = data.colorSpeeds;
  const [c0, c1, c2] = data.colors;
  const mix = (a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (speed <= s1) return mix(c0, c1, Math.min(1, Math.max(0, (speed - s0) / (s1 - s0))));
  return mix(c1, c2, Math.min(1, (speed - s1) / (s2 - s1)));
}

/** Smooth value noise in [-1, 1] for the flicker. */
function flickerNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashToUnit(hashU32((i + seed * 7919) >>> 0)) * 2 - 1;
  const b = hashToUnit(hashU32((i + 1 + seed * 7919) >>> 0)) * 2 - 1;
  return a + (b - a) * f * f * (3 - 2 * f);
}

const WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct PlasmaInst {
  origin: vec4f,    // xyz = centre of the body proxy relative to the camera, w = length of the box downstream (m)
  windX: vec4f,     // xyz = unit direction of the air flow (ROOT axes), w = radius of the box (m)
  windY: vec4f,     // xyz, w = start of the box upstream (m, negative)
  windZ: vec4f,     // xyz, w = march steps
  bodyAxis: vec4f,  // xyz = long axis of the proxy in the wind frame, w = radius (m)
  bodyDim: vec4f,   // x = half length, y = edge rounding radius, z = shock standoff at the stagnation point (m), w = wake length (m)
  color: vec4f,     // rgb = colour x luminance (cd/m^2), w = flicker gain
  params: vec4f,    // x = noise scroll (m), y = whiteness 0..1, z = seed, w = unused
}
@group(2) @binding(0) var<storage, read> plasmaInst: array<PlasmaInst, ${MAX_PLASMA}>;

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let I = plasmaInst[ii];
  var o: VOut;
  o.pos = volumeBoxVertex(vi, I.origin.xyz, I.windX.xyz, I.windY.xyz, I.windZ.xyz, vec3f(I.windY.w, -I.windX.w, -I.windX.w), vec3f(I.origin.w, I.windX.w, I.windX.w));
  o.inst = ii;
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let I = plasmaInst[in.inst];
  let R = volumeRay(in.pos, I.origin.xyz, I.windX.xyz, I.windY.xyz, I.windZ.xyz, vec3f(I.windY.w, -I.windX.w, -I.windX.w), vec3f(I.origin.w, I.windX.w, I.windX.w));
  if (R.t1 <= R.t0) { return volumeNone(); }
  let Rb = I.bodyAxis.w;
  let a = I.bodyAxis.xyz;
  let hl = I.bodyDim.x;
  let rr = I.bodyDim.y;
  let d0s = I.bodyDim.z;
  let wakeLen = I.bodyDim.w;
  let tc = -dot(R.ro, R.rd);
  let dc = length(R.ro + R.rd * tc);
  let d0 = max(0.25 * Rb, 0.3 * dc);
  let s0 = R.t0 - tc;
  let s1 = R.t1 - tc;
  let w0 = sign(s0) * log(1.0 + abs(s0) / d0);
  let w1 = sign(s1) * log(1.0 + abs(s1) / d0);
  let steps = max(10.0, floor(I.windZ.w * vfx.time.w + 0.5));
  let jitter = blueNoise(vec2u(in.pos.xy)).b;
  let hot = mix(I.color.rgb, vec3f(luminance(I.color.rgb)) * vec3f(1.0, 0.97, 1.05), 0.6);
  var L = vec3f(0.0);
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let w = mix(w0, w1, (i + jitter) / steps);
    let ew = exp(abs(w));
    let t = tc + sign(w) * d0 * (ew - 1.0);
    let dt = d0 * ew * (w1 - w0) / steps;
    let p = R.ro + R.rd * t;
    // Rounded cylinder about the body axis: signed distance and outward normal.
    let h = dot(p, a);
    let radial = p - a * h;
    let rho = length(radial);
    let rdir = radial / max(rho, 1e-4);
    let q = vec2f(rho - (Rb - rr), abs(h) - (hl - rr));
    let m = max(q, vec2f(0.0));
    let sd = min(max(q.x, q.y), 0.0) + length(m) - rr;
    if (sd <= 0.0) { continue; }
    var nrm = select(a * sign(h), rdir, q.x > q.y);
    if (m.x + m.y > 0.0) { nrm = normalize(rdir * m.x + a * (sign(h) * m.y)); }
    let e = saturate(-nrm.x);
    var j = vec3f(0.0);
    // Shock layer on the windward side: a bright front at the standoff distance, glowing gas behind it.
    let delta = d0s * (1.0 + 1.6 * (1.0 - e));
    if (sd < 1.5 * delta && e > 0.12) {
      let n = vfxNoiseLod(p * (0.6 / Rb) - vec3f(I.params.x * 0.4 / Rb, 0.0, 0.0) + vec3f(I.params.z), dt * 0.6 / Rb);
      let layer = smoothstep(1.25 * delta, 0.9 * delta, sd);
      let front = exp(-sq((sd - 0.95 * delta) / (0.2 * delta)));
      let k = (0.16 * layer + 1.0 * front) * pow(smoothstep(0.12, 1.0, e), 1.4) * (0.7 + 0.6 * n.g);
      j += mix(I.color.rgb, hot, e * e) * (k / d0s);
    }
    // Wake: the layer spills over the shoulder into a sheath that necks down behind the body, then a long streaked core.
    let xw = p.x;
    if (xw > -0.6 * Rb) {
      let rw = length(p.yz);
      let Rw = Rb * (0.45 + 0.55 * exp(-max(xw, 0.0) / (1.3 * Rb))) * (1.0 + 0.03 * max(xw, 0.0) / Rb);
      let st = vfxNoiseLod(vec3f((xw - I.params.x) * 0.05, p.y * 0.55, p.z * 0.55) / Rb + vec3f(I.params.z), dt * 0.55 / Rb);
      let st2 = vfxNoiseLod(vec3f((xw - I.params.x * 1.6) * 0.16, p.y * 1.7, p.z * 1.7) / Rb + vec3f(I.params.z * 2.3), dt * 1.7 / Rb);
      let streak = (0.1 + 2.2 * st.g * st.g) * (0.35 + 1.3 * st2.b);
      let sheath = exp(-sq((rw - Rw) / (0.18 * Rw)));
      let core = exp(-sq(rw / (0.6 * Rw)));
      let fade = smoothstep(-0.6 * Rb, 0.6 * Rb, xw) * exp(-max(xw, 0.0) / wakeLen);
      j += I.color.rgb * ((0.55 * sheath + 0.2 * core) * fade * streak * (0.12 / Rb));
    }
    let c = j * (I.color.w * dt);
    let lw = luminance(c) + 1e-12;
    L += c;
    wsum += lw;
    tsum += lw * t;
  }
  if (wsum < 1e-9) { return volumeNone(); }
  return volumeOut(R.uv, L, 1.0, clamp(tsum / wsum, R.t0, R.t1));
}
`;

interface PlacedPlasma {
  originRelCam: Vec3;
  distance: number;
}

export class PlasmaRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_PLASMA * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private placed: PlacedPlasma[] = [];
  readonly lights: { light: LocalLight; power: number }[] = [];
  readonly hints: EmitterHint[] = [];

  constructor(
    private readonly ctx: RenderContext,
    common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.buffer = device.createBuffer({ label: 'vfx.plasma', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ label: 'vfx.plasma', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.group = device.createBindGroup({ label: 'vfx.plasma', layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
    this.pipeline = createVolumePipeline(ctx, common, 'vfx.plasma', WGSL, layout);
    this.pipeline.get();
  }

  /** Gather the vessels with plasma, pack the instances and prepare their lights. */
  update(frame: FrameContext, effectTime: number, noiseTime: number): void {
    const R = this.vfx.reentry;
    const D = this.data;
    this.placed = [];
    this.lights.length = 0;
    this.hints.length = 0;
    const list = frame.snapshot.vessels.filter((v) => v.aero.plasmaIntensity >= R.minIntensity && v3.len(v.aero.airVelocity) > 500).sort((x, y) => y.aero.plasmaIntensity - x.aero.plasmaIntensity);
    for (const vessel of list.slice(0, MAX_PLASMA)) {
      const pose = frame.vesselPose(vessel.id);
      if (!pose) continue;
      const speed = v3.len(vessel.aero.airVelocity);
      const wind = v3.scale(vessel.aero.airVelocity, -1 / speed);
      const windVes = quat.rotateInv(pose.q, wind);
      const proxy = reentryProxy(this.ctx.defs, vessel, windVes);
      const origin = v3.add(pose.originRelCam, quat.rotate(pose.q, proxy.centreVes));
      let ref = quat.rotate(pose.q, v3.unitZ());
      if (Math.abs(v3.dot(ref, wind)) > 0.95) ref = quat.rotate(pose.q, v3.unitX());
      const wy = v3.normalize(v3.reject(ref, wind));
      const wz = v3.cross(wind, wy);
      const axisRoot = quat.rotate(pose.q, proxy.axisVes);
      const axisWind = { x: v3.dot(axisRoot, wind), y: v3.dot(axisRoot, wy), z: v3.dot(axisRoot, wz) };
      const flux = Math.max(vessel.aero.heatFlux, vessel.aero.plasmaIntensity * R.referenceFlux * 0.05);
      const luminance = R.luminance * Math.pow(flux / R.referenceFlux, R.fluxExponent) * Math.min(1, vessel.aero.plasmaIntensity / Math.max(R.minIntensity * 2, 1e-3));
      const color = plasmaColor(R, speed);
      const seed = hashU32(vessel.id.length * 131 + vessel.id.charCodeAt(0)) % 64;
      const flicker = 1 + R.flicker.amount * (0.6 * flickerNoise(effectTime * R.flicker.lowHz, seed) + 0.4 * flickerNoise(effectTime * R.flicker.highHz, seed + 11));
      const extent = Math.hypot(proxy.radius, proxy.halfLength);
      const standoff = R.standoff * proxy.noseRadius;
      const wakeLength = R.wakeLengthRadii * proxy.radius;
      this.hints.push({ rel: origin, a: extent + standoff, b: extent + standoff, luminance: 0.5 * luminance });
      const o = this.placed.length * INST_FLOATS;
      D.set([origin.x, origin.y, origin.z, extent + 3 * wakeLength], o);
      D.set([wind.x, wind.y, wind.z, 2.2 * extent + 4 * standoff], o + 4);
      D.set([wy.x, wy.y, wy.z, -(extent + 5 * standoff)], o + 8);
      D.set([wz.x, wz.y, wz.z, R.steps], o + 12);
      D.set([axisWind.x, axisWind.y, axisWind.z, proxy.radius], o + 16);
      D.set([proxy.halfLength, proxy.rounding, standoff, wakeLength], o + 20);
      D.set([color[0] * luminance, color[1] * luminance, color[2] * luminance, flicker], o + 24);
      const period = 16 * proxy.radius;
      D.set([(noiseTime * Math.min(speed, 900)) % period, Math.min(1, speed / R.colorSpeeds[2]), seed / 64, 0], o + 28);
      this.placed.push({ originRelCam: origin, distance: v3.len(origin) });

      // The glow lights the vessel and its cabin: a point light just ahead of the windward face.
      const power = R.light.efficacy * luminance * Math.PI * proxy.radius * proxy.radius * flicker;
      const at = v3.addScaled(origin, wind, -(extent + standoff));
      this.lights.push({ power: power * (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]), light: { kind: 'point', posRelCam: at, intensity: [color[0] * power, color[1] * power, color[2] * power], range: R.light.range } });
    }
    if (this.placed.length > 0) this.device.queue.writeBuffer(this.buffer, 0, D, 0, this.placed.length * INST_FLOATS);
  }

  get count(): number {
    return this.placed.length;
  }

  items(): VolumeItem[] {
    return this.placed.map((p, i) => ({
      distance: p.distance,
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
