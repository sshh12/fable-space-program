/**
 * Exhaust and reentry trails: what a vehicle leaves behind in the air, along its flight path.
 *
 * A trail is a polyline of nodes fixed in the body frame (the air co-rotates with the body, and nothing
 * blows: the tube only widens by its initial momentum and by diffusion, and thins as it widens). Each
 * segment is a tube with a Gaussian cross-section whose optical depth along a view ray has a closed form,
 * so there is no march: one box per segment in the half-resolution volume pass, cut at the planes it shares
 * with its neighbours. Towards its newest end a trail thins out to nothing over its taper length (what is
 * drawn there is the plume or the wake itself), and a tube the eye stands in is not drawn: seen from inside,
 * a tube of uniform gas is a flat veil over the whole frame.
 *
 *  - exhaust smoke: grey, short-lived, strongest low in the atmosphere;
 *  - condensation: white and persistent where the air is cold and dense enough (upper troposphere);
 *  - reentry: a glowing wake that fades in seconds, visible from far away.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { quat, v3, type Vec3, type Vec3Tuple } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { FragmentTrail } from './fireball';
import type { PlacedCluster } from './plumes';
import type { EmitterHint, VolumeItem } from './volumes';

const SEG_FLOATS = 36;
const CHUNK = 8;

export interface TrailNode {
  /** Body-fixed position, m (float64). */
  pos: Vec3;
  /** Effect time of birth, s. */
  born: number;
  radius0: number;
  /** Speed of the initial spreading, m/s (exhaust momentum; small for a wake). */
  spread: number;
  /** Diffusivity of this node's gas, m^2/s (default: the trail data's). */
  diffusivity?: number;
  /** Optical depth across the diameter at birth: exhaust smoke and condensation. */
  smoke0: number;
  contrail0: number;
  /** Glow luminance at birth (cd/m^2), its e-folding time (s) and colour. */
  glow0: number;
  glowLife: number;
  glowColor: Vec3Tuple;
  /** A second, faint and long-lived glow (the persistent train of a reentry): luminance at birth (cd/m^2) and e-folding time (s). */
  train0?: number;
  trainLife?: number;
}

export interface Trail {
  key: string;
  bodyId: string;
  nodes: TrailNode[];
  /** The moving end at the vehicle. */
  head: TrailNode | null;
  lastEmit: number;
  /** Length over which the trail fades in from its newest end, m. */
  taper: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Radius of a node at `age` seconds: initial momentum, then diffusion. */
export function trailRadius(data: VfxData['trail'], node: TrailNode, age: number): number {
  return node.radius0 + node.spread * data.expansionTime * (1 - Math.exp(-age / data.expansionTime)) + Math.sqrt(4 * (node.diffusivity ?? data.diffusivity) * Math.max(age, 0));
}

/** Optical depths across the diameter and glow of a node at `age`: [smoke, condensation, glow luminance]. */
export function trailState(data: VfxData['trail'], node: TrailNode, age: number): [number, number, number] {
  const thin = node.radius0 / trailRadius(data, node, age);
  return [
    node.smoke0 * thin * Math.exp(-age / data.smokeLifetime),
    node.contrail0 * thin * smooth(0.1, 0.9, age) * Math.exp(-age / data.contrailLifetime),
    node.glow0 * Math.exp(-age / Math.max(node.glowLife, 0.01)) + (node.train0 ?? 0) * Math.exp(-age / Math.max(node.trainLife ?? 1, 0.01)),
  ];
}

/** Condensation factor 0..1 from the ambient temperature (K) and pressure (Pa). */
export function contrailFactor(data: VfxData['trail'], temperature: number, pressure: number): number {
  return (1 - smooth(data.contrailTemperature[0], data.contrailTemperature[1], temperature)) * smooth(data.contrailPressure[0], data.contrailPressure[1], pressure);
}

const TRAIL_WGSL = /* wgsl */ `
#include "vfx_common"
struct TrailSeg {
  a: vec4f,          // xyz = node A relative to the camera, w = radius (m)
  b: vec4f,          // xyz = node B, w = radius
  na: vec4f,         // xyz = unit normal of the cut plane at A (pointing into the segment), w = optical depth across the diameter at A
  nb: vec4f,         // xyz = unit normal of the cut plane at B (pointing out of the segment), w = optical depth at B
  albedoA: vec4f,    // rgb = scattering albedo at A, w = glow luminance at A (cd/m^2)
  albedoB: vec4f,    // rgb, w = glow at B
  noise: vec4f,      // xyz = noise coordinate of node A, w = noise scale (1/m)
  glow: vec4f,       // rgb = glow colour, w = noise amount
  taper: vec4f,      // x, y = distance of A and of B from the newest end of the trail along it (m), z = taper length (m), w = length of the whole trail (m)
}
@group(2) @binding(0) var<storage, read> trailSegs: array<TrailSeg>;

const CUBE_IDX = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);
const TRAIL_REACH = 2.4;   // the Gaussian tube is drawn out to this many radii

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) seg: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = trailSegs[ii];
  let ci = CUBE_IDX[vi];
  let c = vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u));
  let u = s.b.xyz - s.a.xyz;
  let len = max(length(u), 1e-3);
  let ux = u / len;
  var uy = cross(ux, vec3f(0.0, 0.0, 1.0));
  if (dot(uy, uy) < 1e-4) { uy = cross(ux, vec3f(0.0, 1.0, 0.0)); }
  uy = normalize(uy);
  let uz = cross(ux, uy);
  // Never thinner than a pixel of the half-resolution target: the box grows with it.
  let pixel = 2.0 * frame.cameraUp.w * vfx.half.w * max(length(s.a.xyz), length(s.b.xyz));
  let r = TRAIL_REACH * max(max(s.a.w, s.b.w), pixel);
  let l = vec3f(mix(-r, len + r, c.x), (c.y * 2.0 - 1.0) * r, (c.z * 2.0 - 1.0) * r);
  var o: VOut;
  o.pos = frame.viewProjUnjittered * vec4f(s.a.xyz + ux * l.x + uy * l.y + uz * l.z, 1.0);
  o.seg = ii;
  return o;
}

fn erfApprox(x: f32) -> f32 {
  let x2 = x * x;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) moment: vec4f,
}
@fragment fn fs(in: VOut) -> FOut {
  let s = trailSegs[in.seg];
  var out: FOut;
  out.color = vec4f(0.0);
  out.moment = vec4f(0.0);
  let uv = in.pos.xy * vfx.half.zw;
  let ray = viewRay(uv);
  let rayLen = length(ray);
  let d = ray / rayLen;
  let tScene = viewZFromDepth(textureLoad(sceneDepthHalfTex, vec2i(in.pos.xy), 0).r) * rayLen;

  // The part of the ray between the two cut planes of the segment.
  var ta = 0.0;
  var tb = tScene;
  let da = dot(d, s.na.xyz);
  let ka = dot(s.a.xyz, s.na.xyz);
  if (abs(da) < 1e-6) { if (ka > 0.0) { return out; } }
  else if (da > 0.0) { ta = max(ta, ka / da); } else { tb = min(tb, ka / da); }
  let db = dot(d, s.nb.xyz);
  let kb = dot(s.b.xyz, s.nb.xyz);
  if (abs(db) < 1e-6) { if (kb < 0.0) { return out; } }
  else if (db > 0.0) { tb = min(tb, kb / db); } else { ta = max(ta, kb / db); }
  if (tb <= ta) { return out; }

  // Closest approach of the ray to the axis of the tube.
  let u = s.b.xyz - s.a.xyz;
  let len = max(length(u), 1e-3);
  let ux = u / len;
  let dPerp = d - ux * dot(d, ux);
  let aPerp = s.a.xyz - ux * dot(s.a.xyz, ux);
  let sin2 = max(dot(dPerp, dPerp), 1e-6);
  let sinT = sqrt(sin2);
  let tm = dot(dPerp, aPerp) / sin2;
  let tMid = clamp(tm, ta, tb);
  let along = saturate(dot(d * tMid - s.a.xyz, ux) / len);
  var radius = mix(s.a.w, s.b.w, along);
  // Thinning out towards the newest end, and gone where the eye is inside the tube (within a few radii of
  // its axis, anywhere along this stretch of it).
  let eyeAlong = -dot(s.a.xyz, ux);
  let eyeNear = length(aPerp) / max(radius, 1e-3);
  let eyeBy = smoothstep(-30.0 * radius, -10.0 * radius, eyeAlong) * (1.0 - smoothstep(len + 10.0 * radius, len + 30.0 * radius, eyeAlong));
  // (A fade-in shorter than a pixel is no fade-in: the trail then starts at the vehicle. The oldest end fades
  // out over a few radii, raggedly: no cut.)
  let pixelMid = 2.0 * frame.cameraUp.w * vfx.half.w * tMid;
  let fromNewest = mix(s.taper.x, s.taper.y, along);
  let fadeIn = max(smoothstep(0.0, 1.0, fromNewest / max(s.taper.z, 1e-3)), smoothstep(0.5, 1.5, pixelMid / max(s.taper.z, 1e-3)));
  let show = fadeIn * mix(1.0, smoothstep(1.2, 3.0, eyeNear), eyeBy);
  var tau0 = mix(s.na.w, s.nb.w, along) * show;
  // The glow decays exponentially with age: interpolated as such between the nodes.
  var glowLum = exp(mix(log(max(s.albedoA.w, 1e-3)), log(max(s.albedoB.w, 1e-3)), along)) * show;
  let albedo = mix(s.albedoA.rgb, s.albedoB.rgb, along);
  // Turbulent structure fixed in the air: it modulates the radius and the amount.
  let closest = d * tMid;
  let n = vfxNoiseLod(s.noise.xyz + (closest - s.a.xyz) * s.noise.w, 2.0 * frame.cameraUp.w * vfx.half.w * tMid * s.noise.w);
  radius *= 1.0 + (n.r - 0.5) * 1.2 * s.glow.w;
  tau0 *= 1.0 + (n.g - 0.5) * 1.6 * s.glow.w;
  tau0 *= smoothstep(0.0, 1.0, (s.taper.w - fromNewest) / max(6.0 * radius, 1e-3) - 0.6 * n.a);
  // Beads: the brightness of a glowing trail varies along it on the scale of a kilometre, however thin it is drawn.
  let bead = vfxNoiseLod(s.noise.xyz * 0.37 + (closest - s.a.xyz) * (1.0 / 1300.0), pixelMid / 1300.0);
  glowLum *= 0.25 + 1.5 * bead.r;
  // The head of a trail seen from so far that the glowing body and its wake are smaller than a pixel: their
  // light is not lost, it is in this pixel (a point that clips and blooms at the front of the line).
  glowLum *= 1.0 + s.taper.z * 2.0 * smoothstep(0.3, 1.5, pixelMid / max(s.taper.z, 1e-3)) * exp(-fromNewest / max(4.0 * pixelMid, 1e-3)) * step(1.0, s.albedoA.w + s.albedoB.w);
  // Sub-pixel tubes are widened to a pixel and thinned by the same factor.
  let pixel = 2.0 * frame.cameraUp.w * vfx.half.w * tMid;
  let rDraw = max(radius, 0.7 * pixel);
  let thin = radius / rDraw;
  // The axis is kinked by the same turbulence (a trail is never a ruled line).
  let q = d * tm - s.a.xyz + (vec3f(n.r, n.a, n.b) - 0.5) * (2.4 * s.glow.w * radius);
  let qPerp = q - ux * dot(q, ux);
  let d2 = dot(qPerp, qPerp);
  let g = exp(-d2 / (rDraw * rDraw));
  let integral = g * 0.5 / sinT * (erfApprox((tb - tm) * sinT / rDraw) - erfApprox((ta - tm) * sinT / rDraw));
  let tau = max(tau0 * thin * integral, 0.0);
  let glowDepth = max(1.6 * thin * integral, 0.0);
  if (tau < 1e-4 && glowLum * glowDepth < 1e-3) { return out; }

  // Shading: a pseudo normal that turns from the tube's cross direction (thin) to its near surface (opaque).
  let opaq = 1.0 - exp(-tau);
  let rim = saturate(sqrt(d2) / rDraw);
  let qDir = qPerp / max(sqrt(d2), 1e-4);
  let nrm = normalize(qDir * rim - (dPerp / sinT) * (sqrt(max(1.0 - rim * rim, 0.0)) * opaq + 1e-3));
  let probe = vfxProbes[0];
  let wrap = saturate(0.5 + 0.5 * dot(nrm, frame.sunDir.xyz));
  let cosT = dot(d, frame.sunDir.xyz);
  let hg = (1.0 - 0.25) / pow(1.25 - cosT, 1.5);
  let sun = probe.sun.rgb * (mix(0.9, 0.15 + 0.85 * wrap * wrap, opaq) * mix(hg, 1.0, opaq)) * (0.8 / PI);
  let local = vfxLocalLights(closest) * (0.5 / PI);
  let sky = vfxProbeAmbient(0u) * ((0.6 + 0.4 * dot(nrm, probe.up.xyz)) / PI);
  var rgb = albedo * (sun + local + sky) * opaq;
  rgb += s.glow.rgb * (glowLum * (1.0 - exp(-glowDepth)));
  rgb = min(rgb * frame.exposure.x, vec3f(HDR_MAX * 0.25));
  let c = vfxAtmosphere(uv, tMid, rgb, opaq);
  out.color = vec4f(writeHdr(c.rgb), saturate(c.a));
  let lum = luminance(out.color.rgb);
  let mw = saturate(max(out.color.a, lum / (lum + 1.0)));
  out.moment = vec4f(mw * log2(max(tMid, 1e-3)), mw, 0.0, 0.0);
  return out;
}
`;

export class TrailSystem {
  readonly trails = new Map<string, Trail>();
  private readonly device: GPUDevice;
  private readonly maxSegs: number;
  private readonly segData: Float32Array;
  private readonly segBuffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private chunks: { first: number; count: number; distance: number }[] = [];
  /** One per trail with a glowing part (a reentry wake): its projected area and mean luminance. */
  readonly hints: EmitterHint[] = [];
  /** Segments drawn in the last frame. */
  segments = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly data: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.maxSegs = data.trail.maxTrails * data.trail.maxNodes;
    this.segData = new Float32Array(this.maxSegs * SEG_FLOATS);
    this.segBuffer = device.createBuffer({ label: 'vfx.trail', size: this.segData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ label: 'vfx.trail', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.group = device.createBindGroup({ label: 'vfx.trail', layout, entries: [{ binding: 0, resource: { buffer: this.segBuffer } }] });
    const over: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const add: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    this.pipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.trail', TRAIL_WGSL);
      return device.createRenderPipeline({
        label: 'vfx.trail',
        layout: device.createPipelineLayout({ label: 'vfx.trail', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: over }, { format: 'rg16float', blend: add }] },
        primitive: { topology: 'triangle-list', cullMode: 'front' },
      });
    });
    this.pipeline.get();
  }

  private trail(key: string, bodyId: string, taper: number): Trail {
    let t = this.trails.get(key);
    if (!t || t.bodyId !== bodyId) {
      if (!t && this.trails.size >= this.data.trail.maxTrails) {
        // Make room: drop the trail whose newest node is oldest.
        let oldest: Trail | null = null;
        for (const x of this.trails.values()) if (!oldest || x.lastEmit < oldest.lastEmit) oldest = x;
        if (oldest) this.trails.delete(oldest.key);
      }
      t = { key, bodyId, nodes: [], head: null, lastEmit: -1e9, taper };
      this.trails.set(key, t);
    }
    t.taper = taper;
    return t;
  }

  private feed(t: Trail, node: TrailNode, effectTime: number): void {
    const D = this.data.trail;
    const last = t.nodes[t.nodes.length - 1];
    if (!last || (effectTime - t.lastEmit >= D.nodeInterval && v3.dist(node.pos, last.pos) >= D.nodeMinSpacing) || v3.dist(node.pos, last.pos) > 2500) {
      t.nodes.push(node);
      t.lastEmit = effectTime;
      if (t.nodes.length >= D.maxNodes) {
        // Thin out the older half (every other node), so the history reaches back further with fewer nodes.
        const half = Math.floor(t.nodes.length / 2);
        t.nodes = [...t.nodes.slice(0, half).filter((_, i) => i % 2 === 0), ...t.nodes.slice(half)];
      }
    }
    t.head = node;
  }

  /** Feed the trails from this frame's plume clusters, reentering vessels and burning fragments, age them, and pack the segments. */
  update(frame: FrameContext, clusters: PlacedCluster[], effectTime: number, fragments: readonly FragmentTrail[] = []): void {
    const D = this.data.trail;
    const R = this.data.reentry;
    const snap: SimSnapshot = frame.snapshot;
    const fed = new Set<string>();
    const toFixed = (bodyId: string, rel: Vec3): Vec3 => {
      const pose = frame.bodyPose(bodyId);
      return quat.rotateInv(pose.qFixedToRoot, v3.sub(rel, pose.centerRelCam));
    };

    for (const pc of clusters) {
      const c = pc.cluster;
      if (c.kind !== 'engine' || c.ambientPressure < D.minPressure) continue;
      const vessel = snap.vessels.find((v) => v.id === c.vesselId);
      if (!vessel) continue;
      let reMax = 0;
      let throttle = 0;
      for (const nz of c.nozzles) {
        reMax = Math.max(reMax, nz.exitRadius);
        throttle += nz.throttle / c.nozzles.length;
      }
      if (throttle < 0.02) continue;
      const reEff = reMax * Math.sqrt(c.nozzles.length);
      const dense = Math.sqrt(Math.min(1, c.ambientPressure / 101325));
      const smoke = D.smokeOpticalDepth * c.look.trail.smoke * throttle * dense;
      const contrail = D.contrailOpticalDepth * c.look.trail.contrail * throttle * contrailFactor(D, vessel.aero.temperature, c.ambientPressure);
      if (smoke + contrail < 0.01) continue;
      const at = v3.addScaled(pc.originRelCam, pc.axisX, Math.min(c.length * 0.5, 30 * reEff));
      this.feed(this.trail(c.key, vessel.bodyId, D.taperRadii * D.initialRadiusRe * reEff), { pos: toFixed(vessel.bodyId, at), born: effectTime, radius0: D.initialRadiusRe * reEff, spread: D.expansionSpeed, smoke0: smoke, contrail0: contrail, glow0: 0, glowLife: 1, glowColor: [0, 0, 0] }, effectTime);
      fed.add(c.key);
    }

    for (const vessel of snap.vessels) {
      const plasma = vessel.aero.plasmaIntensity;
      if (plasma < R.minIntensity) continue;
      const pose = frame.vesselPose(vessel.id);
      const speed = v3.len(vessel.aero.airVelocity);
      if (!pose || speed < 500) continue;
      let radius = 0.5;
      for (const p of vessel.parts) radius = Math.max(radius, this.ctx.defs.parts[p.def]?.bounds.radius ?? 0);
      // The trail starts at the vessel and fades in over the length of the wake volume, which is what is seen there.
      const at = v3.addScaled(pose.originRelCam, vessel.aero.airVelocity, (-0.5 * radius) / speed);
      const k = smooth(R.colorSpeeds[0], R.colorSpeeds[2], speed);
      const color: Vec3Tuple = [0, 1, 2].map((i) => R.colors[0][i]! + (R.colors[2][i]! - R.colors[0][i]!) * k) as Vec3Tuple;
      const key = `reentry|${vessel.id}`;
      this.feed(
        this.trail(key, vessel.bodyId, R.wakeLengthRadii * radius * (0.3 + 0.7 * Math.min(1, plasma))),
        {
          pos: toFixed(vessel.bodyId, at),
          born: effectTime,
          radius0: R.trail.radiusScale * radius,
          spread: 0.1 * D.expansionSpeed,
          smoke0: R.trail.smoke * plasma,
          contrail0: 0,
          glow0: R.trail.luminance * Math.pow(plasma, R.fluxExponent),
          glowLife: R.trail.lifetime,
          glowColor: color,
          train0: R.trail.trainLuminance * Math.pow(plasma, R.fluxExponent),
          trainLife: R.trail.trainLifetime,
        },
        effectTime,
      );
      fed.add(key);
    }

    for (const f of fragments) {
      if (f.smoke <= 0 && f.glow <= 0) continue;
      this.feed(
        this.trail(f.key, f.bodyId, 2 * f.radius),
        { pos: toFixed(f.bodyId, f.rel), born: effectTime, radius0: f.radius, spread: 0.02 * D.expansionSpeed, diffusivity: 0.025 * D.diffusivity, smoke0: f.smoke, contrail0: 0, glow0: f.glow, glowLife: 0.09, glowColor: f.color },
        effectTime,
      );
      fed.add(f.key);
    }

    // Age: drop nodes that no longer show, and trails with nothing left.
    for (const [key, t] of this.trails) {
      if (!fed.has(key)) t.head = null;
      while (t.nodes.length > 0) {
        const n = t.nodes[0]!;
        const [s, c, g] = trailState(D, n, effectTime - n.born);
        if (s + c > 0.004 || g > 20) break;
        t.nodes.shift();
      }
      if (t.nodes.length === 0 && !t.head) this.trails.delete(key);
    }

    // Pack: segments far to near within each trail.
    const S = this.segData;
    let count = 0;
    this.chunks = [];
    this.hints.length = 0;
    for (const t of this.trails.values()) {
      if (!frame.snapshot.bodies.some((b) => b.id === t.bodyId)) continue;
      const pose = frame.bodyPose(t.bodyId);
      const list = t.head && t.head !== t.nodes[t.nodes.length - 1] ? [...t.nodes, t.head] : t.nodes;
      if (list.length < 2) continue;
      const rel = list.map((n) => v3.add(pose.centerRelCam, quat.rotate(pose.qFixedToRoot, n.pos)));
      const dirs = rel.map((_, i) => v3.normalize(v3.sub(rel[Math.min(i + 1, rel.length - 1)]!, rel[Math.max(i - 1, 0)]!)));
      const state = list.map((n) => {
        const age = effectTime - n.born;
        const [s, c, g] = trailState(D, n, age);
        const total = s + c;
        const albedo: Vec3Tuple = total > 1e-9 ? ([0, 1, 2].map((i) => (D.smokeAlbedo[i]! * s + D.contrailAlbedo[i]! * c) / total) as Vec3Tuple) : D.smokeAlbedo;
        return { radius: trailRadius(D, n, age), tau: total, glow: g, albedo };
      });
      // The glowing part as the exposure meter should see it: area of the tubes across the line of sight, of
      // the hot head only (the faint train is meant to be seen as faint: were it counted, a night frame would
      // be exposed until the whole train sat at the meter's white).
      let maxGlow = 0;
      for (const st of state) maxGlow = Math.max(maxGlow, st.glow);
      let area = 0;
      let lumArea = 0;
      let lengthAcross = 0;
      let centre = v3.zero();
      for (let i = 0; i + 1 < list.length; i++) {
        const glow = 0.5 * (state[i]!.glow + state[i + 1]!.glow);
        if (glow < Math.max(1, 0.25 * maxGlow)) continue;
        const mid = v3.scale(v3.add(rel[i]!, rel[i + 1]!), 0.5);
        const seg = v3.sub(rel[i + 1]!, rel[i]!);
        const across = v3.len(v3.reject(seg, v3.normalize(mid)));
        const a = across * 0.6 * (state[i]!.radius + state[i + 1]!.radius);
        area += a;
        lengthAcross += across;
        lumArea += a * 0.6 * glow;
        centre = v3.addScaled(centre, mid, a);
      }
      if (area > 0) {
        // A long thin ellipse of the same length and area.
        const a = Math.max(0.5 * lengthAcross, 1e-3);
        this.hints.push({ rel: v3.scale(centre, 1 / area), a, b: area / (Math.PI * a), luminance: lumArea / area });
      }
      // Distance of every node from the newest end, along the trail.
      const fromEnd = new Array<number>(list.length).fill(0);
      for (let i = list.length - 2; i >= 0; i--) fromEnd[i] = fromEnd[i + 1]! + v3.dist(rel[i]!, rel[i + 1]!);
      const reverse = v3.lenSq(rel[0]!) < v3.lenSq(rel[rel.length - 1]!);
      const first = count;
      for (let k = 0; k + 1 < list.length && count < this.maxSegs; k++) {
        const i = reverse ? list.length - 2 - k : k;
        const o = count * SEG_FLOATS;
        const a = rel[i]!;
        const b = rel[i + 1]!;
        const na = dirs[i]!;
        const nb = dirs[i + 1]!;
        const sa = state[i]!;
        const sb = state[i + 1]!;
        const nodeA = list[i]!;
        S.set([a.x, a.y, a.z, sa.radius, b.x, b.y, b.z, sb.radius], o);
        S.set([na.x, na.y, na.z, sa.tau, nb.x, nb.y, nb.z, sb.tau], o + 8);
        S.set([sa.albedo[0], sa.albedo[1], sa.albedo[2], sa.glow, sb.albedo[0], sb.albedo[1], sb.albedo[2], sb.glow], o + 16);
        const scale = D.noiseScale / Math.max(0.5 * (sa.radius + sb.radius), 1);
        const frac = (x: number): number => x * scale - Math.floor(x * scale);
        S.set([frac(nodeA.pos.x), frac(nodeA.pos.y), frac(nodeA.pos.z), scale], o + 24);
        // The colour of the glow goes with its age: white-hot at the head, the colour of the gas behind it, dull red in the train.
        const base = nodeA.glow0 > 0 ? nodeA.glowColor : list[i + 1]!.glowColor;
        const age = effectTime - 0.5 * (nodeA.born + list[i + 1]!.born);
        const hot = Math.exp(-age / Math.max(0.6 * nodeA.glowLife, 0.01));
        const old = nodeA.train0 ? 1 - Math.exp(-age / (0.25 * (nodeA.trainLife ?? 1))) : 0;
        // (Only a little whiter at its newest end: it starts where the wake has already cooled to orange.)
        const gc: Vec3Tuple = [0, 1, 2].map((c) => (base[c]! + (1 - base[c]!) * (nodeA.train0 ? 0.2 : 0.7) * hot) * (1 - old) + [1, 0.32, 0.12][c]! * old) as Vec3Tuple;
        // A wake that glows for seconds is smooth gas, not a billowing cloud.
        S.set([gc[0], gc[1], gc[2], nodeA.train0 ? 0.2 * D.noiseAmount : D.noiseAmount], o + 28);
        S.set([fromEnd[i]!, fromEnd[i + 1]!, t.taper, fromEnd[0]!], o + 32);
        count++;
      }
      for (let c0 = first; c0 < count; c0 += CHUNK) {
        const n = Math.min(CHUNK, count - c0);
        const mid = c0 + Math.floor(n / 2);
        const o = mid * SEG_FLOATS;
        this.chunks.push({ first: c0, count: n, distance: Math.hypot(S[o]!, S[o + 1]!, S[o + 2]!) });
      }
    }
    this.segments = count;
    if (count > 0) this.device.queue.writeBuffer(this.segBuffer, 0, S, 0, count * SEG_FLOATS);
  }

  /** Volume-pass items: chunks of consecutive segments. */
  items(): VolumeItem[] {
    return this.chunks.map((c) => ({
      distance: c.distance,
      draw: (pass: GPURenderPassEncoder) => {
        pass.setPipeline(this.pipeline.get());
        pass.setBindGroup(2, this.group);
        pass.draw(36, c.count, 0, c.first);
      },
    }));
  }

  /** Total number of nodes (diagnostics). */
  get nodeCount(): number {
    let n = 0;
    for (const t of this.trails.values()) n += t.nodes.length;
    return n;
  }

  dispose(): void {
    this.segBuffer.destroy();
  }
}
