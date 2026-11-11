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
  shape: vec4f,    // x = outer radius (m), y = tan of the mean elevation of the grains, z = optical depth of the sheet seen from above at the inner radius, w = scroll of the streaks (m)
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
  let dt = (R.t1 - R.t0) / steps;
  let jitter = blueNoise(vec2u(in.pos.xy)).r;
  let probe = vfxProbes[0];
  let dW = normalize(ray);
  let cosT = dot(dW, frame.sunDir.xyz);
  let g = 0.55;
  let phase = mix(1.0, (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5), 0.7);
  let amb = vfxProbeAmbient(0u);
  let seed = S.look.w;
  let fp = 2.0 * frame.cameraUp.w * vfx.half.w;
  var L = vec3f(0.0);
  var T = 1.0;
  var wsum = 0.0;
  var tsum = 0.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    // One stretch of the ray; the dust in it is integrated over the height in closed form.
    let ta = R.t0 + i * dt;
    let tm = ta + jitter * dt;
    let p = R.ro + R.rd * tm;
    let r = length(p.xz);
    if (r > rMax || r < 0.4 * r0) { continue; }
    let H = max(r, r0) * S.shape.y;
    let ha = max(R.ro.y + R.rd.y * ta - lift, 0.0);
    let hb = max(R.ro.y + R.rd.y * (ta + dt) - lift, 0.0);
    let x = (hb - ha) / H;
    var mean = 1.0 - 0.5 * x;
    if (abs(x) > 1e-3) { mean = (1.0 - exp(-x)) / x; }
    let column = exp(-ha / H) / H * dt * mean;
    if (column < 1e-5) { continue; }
    // Streaks: narrow in angle, long along the radius, streaming outwards.
    let ang = p.xz / max(r, 1e-3);
    let lod = max(tm * fp, 0.3 * dt) / r0;
    let s1 = vfxNoiseLod(vec3f(ang * 2.9, 0.05 * (r - S.shape.w) / r0 + seed), lod * 0.3);
    let s2 = vfxNoiseLod(vec3f(ang * 10.3, 0.17 * (r - 1.6 * S.shape.w) / r0 + seed * 3.1), lod * 0.9);
    let streak = (0.1 + 2.4 * s1.g * s1.g) * (0.25 + 1.5 * s2.b);
    let amount = S.shape.z * smoothstep(0.55 * r0, 1.25 * r0, r) * (r0 / max(r, r0)) * (1.0 - smoothstep(0.55 * rMax, rMax, r));
    let tau = amount * streak * column;
    let stepT = exp(-tau);
    let rel = f.origin + f.X * p.x + f.Y * p.y + f.Z * p.z;
    let lit = sampleSunShadow(rel, frame.sunDir.xyz, vec2u(in.pos.xy));
    let J = S.look.rgb * ((probe.sun.rgb * (lit * phase) + vfxLocalLights(rel)) * (1.0 / (4.0 * PI)) + amb * (1.0 / PI) * 0.25);
    let c = J * (1.0 - stepT);
    let lw = T * luminance(c) + 1e-12;
    L += T * c;
    wsum += lw;
    tsum += lw * tm;
    T *= stepT;
  }
  if (T > 0.9995) { return volumeNone(); }
  return volumeOut(uv, L, T, clamp(tsum / max(wsum, 1e-20), R.t0, R.t1));
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
    const tanE = Math.tan((0.5 * (P.elevationDeg[0] + P.elevationDeg[1]) * Math.PI) / 180);
    [...sheets]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_DUST_SHEETS)
      .forEach((s, i) => {
        const outer = Math.max(P.sheetMinReach, P.sheetReachRadii * s.innerRadius);
        const o = i * INST_FLOATS;
        D.set([s.pos.x, s.pos.y, s.pos.z, s.innerRadius], o);
        D.set([outer, tanE, P.sheetDepth * s.strength, (noiseTime * P.sheetSpeed) % (400 * s.innerRadius)], o + 4);
        D.set([P.albedo[0], P.albedo[1], P.albedo[2], (s.seed % 211) / 211], o + 8);
        D.set([P.sheetSteps, Math.max(2, 5 * outer * tanE), 0, 0], o + 12);
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
