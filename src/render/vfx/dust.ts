/**
 * Dust sheets: what an engine blows off loose ground where there is no air. The grains leave the foot of
 * the jet at shallow angles and fly ballistic, so the dust is a thin sheet that hugs the surface, streams
 * radially in streaks and never billows; seen from the side it is a bright haze a hand high near the jet and
 * a few metres high far out, seen from above it blurs the ground radially.
 *
 * Drawn as a volume in the half-resolution pass: per ray a few stretches, each integrated in closed form
 * over the height (the vertical profile is exponential), so the sheet is caught however thin it is. The
 * sheet lies on the ground plane the director found and, where the ray ends on terrain inside the sheet, on
 * that terrain. The grains themselves are particles (director.ts); this is the body between them.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { DomainFrame } from './domain';
import { createVolumePipeline, type VolumeItem } from './volumes';

export const MAX_DUST_SHEETS = 4;
const INST_FLOATS = 16;

/** One sheet, from the director: where a jet meets the ground. */
export interface DustSheetSpawn {
  /** Foot of the jet on the ground, domain coordinates. */
  pos: Vec3;
  /** Radius of the scoured spot under the jet (no dust inside it), m. */
  innerRadius: number;
  /** 0..1: how hard the jet works the ground (thrust and height). */
  strength: number;
  seed: number;
}

const WGSL = /* wgsl */ `
#include "vfx_common"
#include "vfx_volume"
struct DustSheet {
  centre: vec4f,   // xyz = foot of the jet on the ground, domain coordinates, w = inner radius (m)
  shape: vec4f,    // x = outer radius (m), y = tan of the highest elevation of the grains (the top of the sheet), z = optical depth of the sheet seen from above at the inner radius, w = scroll of the streaks (m)
  look: vec4f,     // rgb = albedo, w = seed
  misc: vec4f,     // x = march stretches, y = height of the proxy (m), zw unused
}
@group(2) @binding(0) var<storage, read> dustSheets: array<DustSheet, ${MAX_DUST_SHEETS}>;

struct SheetFrame { origin: vec3f, X: vec3f, Y: vec3f, Z: vec3f }
/// The sheet's frame relative to the camera: Y = local vertical.
fn sheetFrame(S: DustSheet) -> SheetFrame {
  var f: SheetFrame;
  f.origin = vfxDomainToRel(S.centre.xyz);
  f.Y = vfxDomainDir(vfx.domUp.xyz);
  var t = cross(f.Y, vec3f(0.0, 0.0, 1.0));
  if (dot(t, t) < 1e-4) { t = cross(f.Y, vec3f(1.0, 0.0, 0.0)); }
  f.X = normalize(t);
  f.Z = cross(f.X, f.Y);
  return f;
}

struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let S = dustSheets[ii];
  let f = sheetFrame(S);
  var o: VOut;
  o.pos = volumeBoxVertex(vi, f.origin, f.X, f.Y, f.Z, vec3f(-S.shape.x, -4.0, -S.shape.x), vec3f(S.shape.x, S.misc.y, S.shape.x));
  o.inst = ii;
  return o;
}

@fragment fn fs(in: VOut) -> VolumeOut {
  let S = dustSheets[in.inst];
  let f = sheetFrame(S);
  let rMax = S.shape.x;
  let r0 = S.centre.w;
  let R = volumeRay(in.pos, f.origin, f.X, f.Y, f.Z, vec3f(-rMax, -4.0, -rMax), vec3f(rMax, S.misc.y, rMax));
  if (R.t1 <= R.t0) { return volumeNone(); }
  // Where the ray ends on the ground inside the sheet, the sheet lies on that ground (not on the plane).
  let uv = R.uv;
  let ray = viewRay(uv);
  let tScene = viewZFromDepth(textureLoad(sceneDepthHalfTex, vec2i(in.pos.xy), 0).r) * length(ray);
  var lift = 0.0;
  if (tScene <= R.t1 * 1.0001) {
    let hit = R.ro + R.rd * tScene;
    if (length(hit.xz) < rMax) { lift = clamp(hit.y, -4.0, 4.0); }
  }
  let steps = max(6.0, floor(S.misc.x * vfx.time.w + 0.5));
  // The sheet reaches hundreds of metres (grains thrown at hundreds of metres per second fly that far in
  // vacuum) but is dense only near the jet: the stretches grow exponentially with the distance from the point
  // of the ray nearest to the foot of the jet.
  let rdh = R.rd.xz;
  let tc = clamp(-dot(R.ro.xz, rdh) / max(dot(rdh, rdh), 1e-6), R.t0, R.t1);
  let dc = length(R.ro.xz + rdh * tc);
  let d0 = max(0.5 * r0, 0.3 * dc);
  let w0 = sign(R.t0 - tc) * log(1.0 + abs(R.t0 - tc) / d0);
  let w1 = sign(R.t1 - tc) * log(1.0 + abs(R.t1 - tc) / d0);
  let jitter = blueNoise(vec2u(in.pos.xy)).r;
  let probe = vfxProbes[0];
  let dW = normalize(ray);
  let cosT = dot(dW, frame.sunDir.xyz);
  let g = 0.55;
  // (Against a low sun the sheet is brighter than the ground under it, about twice: more, and a hover seen
  // towards the sun is a white-out.)
  let phase = mix(1.0, (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5), 0.45);
  let amb = vfxProbeAmbient(0u);
  let seed = S.look.w;
  let fp = 2.0 * frame.cameraUp.w * vfx.half.w;
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    // One stretch of the ray; the dust in it is integrated over the height in closed form.
    let wa = mix(w0, w1, i / steps);
    let wb = mix(w0, w1, (i + 1.0) / steps);
    let ta = tc + sign(wa) * d0 * (exp(abs(wa)) - 1.0);
    let dt = tc + sign(wb) * d0 * (exp(abs(wb)) - 1.0) - ta;
    let tm = ta + jitter * dt;
    let p = R.ro + R.rd * tm;
    let r = length(p.xz);
    if (r > rMax) { continue; }
    // Without air the grains fly ballistic from the foot of the jet at a few degrees of elevation at most: there
    // is NO dust above that cone (nothing for it to hang in), so the sheet has a top, at r tan(elevation), and
    // a level line of sight from a camera a few metres up passes over all of it: the sky stays black down to
    // the horizon. Vertical profile 3 (1 - h / H)^2 / H (its integral over the height is 1), integrated in
    // closed form over the stretch so that the sheet is caught however thin it is.
    let H = max(r, r0) * S.shape.y;
    let hA = (R.ro.y + R.rd.y * ta - lift) / H;
    let hB = (R.ro.y + R.rd.y * (ta + dt) - lift) / H;
    let a = saturate(hA);
    let b = saturate(hB);
    // (Mean of the profile over the stretch; the part of it above the top or below the ground holds nothing.)
    var prof = 3.0 * sq(1.0 - a) * step(0.0, hA) * step(hA, 1.0);
    if (abs(hB - hA) > 1e-4) { prof = abs(sq(1.0 - a) * (1.0 - a) - sq(1.0 - b) * (1.0 - b)) / abs(hB - hA); }
    let column = prof / H * dt;
    if (column < 1e-5) { continue; }
    // A continuous sheet, not a fan of rays: its streaks are fine, three to one at most, they break along the
    // radius and stream outwards. Under the jet the ground is scoured and the haze is thinner, never absent.
    let ang = p.xz / max(r, 1e-3);
    let lod = max(tm * fp, 0.3 * dt) / r0;
    let s1 = vfxNoiseLod(vec3f(ang * 5.3, 0.22 * (r - S.shape.w) / r0 + seed), lod * 0.5);
    let s2 = vfxNoiseLod(vec3f(ang * 19.0, 0.7 * (r - 1.6 * S.shape.w) / r0 + seed * 3.1), lod * 1.8);
    let streak = (0.3 + 1.4 * s1.g) * (0.55 + 0.9 * s2.b);
    // (Seen from above the sheet is translucent: the ground, its rocks and the lander's shadow show through it.
    // It thins quickly with distance: the grains spread over a growing ring and fly apart, 1 / r^1.5 near the
    // foot and faster than 1 / r^3 beyond ten radii of the scoured spot.)
    let rr = max(r, r0);
    let amount = S.shape.z * mix(0.5, 1.0, smoothstep(0.3 * r0, 1.25 * r0, r)) * pow(r0 / rr, 1.5) / (1.0 + sq(rr / (10.0 * r0))) * (1.0 - smoothstep(0.55 * rMax, rMax, r));
    let tau = amount * streak * column;
    let stepT = exp(-tau);
    let rel = f.origin + f.X * p.x + f.Y * p.y + f.Z * p.z;
    let lit = sampleSunShadow(rel, frame.sunDir.xyz, vec2u(in.pos.xy));
    // Dust this fine and this thick sends back about what the ground under it does, and more towards a low sun.
    let J = S.look.rgb * ((probe.sun.rgb * (lit * (0.6 + 0.4 * phase)) + vfxLocalLights(rel)) * (1.0 / (2.0 * PI)) + amb * (1.0 / PI) * 0.25);
    let c = J * (1.0 - stepT);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * tm;
    T *= stepT;
  }
  if (T > 0.9995) { return volumeNone(); }
  // No line of sight is veiled by more than about half: the sheet softens the ground, it never hides it.
  let cover = 1.0 - T;
  let keep = min(1.0, 0.5 / cover);
  return volumeOut(uv, L * keep, 1.0 - cover * keep, clamp(tsum / max(wsum, 1e-20), R.t0, R.t1));
}
`;

export class DustSheetRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_DUST_SHEETS * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private distances: number[] = [];

  constructor(
    ctx: RenderContext,
    common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.buffer = device.createBuffer({ label: 'vfx.dust', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ label: 'vfx.dust', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.group = device.createBindGroup({ label: 'vfx.dust', layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
    this.pipeline = createVolumePipeline(ctx, common, 'vfx.dust', WGSL, layout);
    this.pipeline.get();
  }

  /** Pack this frame's sheets (the strongest first when there are more than the renderer holds). */
  update(frame: FrameContext, dom: DomainFrame, sheets: DustSheetSpawn[], noiseTime: number): void {
    const P = this.vfx.particles.dust;
    const D = this.data;
    this.distances = [];
    const originRel = v3.sub(dom.originRoot, frame.camera.positionRoot);
    // The top of the sheet: the highest elevation the grains leave the foot of the jet at.
    const tanE = Math.tan((P.elevationDeg[1] * Math.PI) / 180);
    [...sheets]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_DUST_SHEETS)
      .forEach((s, i) => {
        const outer = Math.max(P.sheetMinReach, P.sheetReachRadii * s.innerRadius);
        const o = i * INST_FLOATS;
        D.set([s.pos.x, s.pos.y, s.pos.z, s.innerRadius], o);
        D.set([outer, tanE, P.sheetDepth * Math.pow(s.strength, 1.6), (noiseTime * P.sheetSpeed) % (400 * s.innerRadius)], o + 4);
        D.set([P.albedo[0], P.albedo[1], P.albedo[2], (s.seed % 211) / 211], o + 8);
        D.set([P.sheetSteps, Math.max(2, outer * tanE + 1), 0, 0], o + 12);
        this.distances.push(v3.len(v3.add(originRel, quat.rotate(dom.q, s.pos))));
      });
    if (this.distances.length > 0) this.device.queue.writeBuffer(this.buffer, 0, D, 0, this.distances.length * INST_FLOATS);
  }

  /** Nothing to draw (no surface domain this frame). */
  clear(): void {
    this.distances = [];
  }

  get count(): number {
    return this.distances.length;
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
