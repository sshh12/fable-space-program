/**
 * The foam a splashdown leaves on the water: a patch of white water at the entry point that spreads as a
 * ring and breaks up over half a minute. Drawn as a decal on whatever surface is in the scene depth at that
 * place (the sea), in the transparent pass. The spray itself is particles (director.ts).
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';
import type { Tracked } from '@/render/core';
import type { VfxCommon } from './common';
import type { VfxData } from './data';
import type { SplashSpawn } from './director';
import { applyRebase, type DomainRebase } from './domain';

export const MAX_FOAM = 8;
const INST_FLOATS = 8;

const WGSL = /* wgsl */ `
#include "vfx_common"
struct Foam {
  centre: vec4f,   // xyz = entry point in domain coordinates, w = radius now (m)
  state: vec4f,    // x = age / lifetime, y = strength 0..1, z = seed, w = radius of the body that fell in (m)
}
struct FoamU { albedo: vec4f, count: vec4f }
@group(2) @binding(0) var<uniform> foamU: FoamU;
@group(2) @binding(1) var<storage, read> foams: array<Foam, ${MAX_FOAM}>;

const CUBE = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);
struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) inst: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let F = foams[ii];
  let ci = CUBE[vi];
  let c = vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u)) * 2.0 - 1.0;
  // A flat box around the patch, built on the local vertical.
  let up = vfx.domUp.xyz;
  var t1 = cross(up, vec3f(0.0, 0.0, 1.0));
  if (dot(t1, t1) < 1e-4) { t1 = cross(up, vec3f(1.0, 0.0, 0.0)); }
  t1 = normalize(t1);
  let t2 = cross(up, t1);
  let p = F.centre.xyz + (t1 * c.x + t2 * c.z) * (F.centre.w * 1.1) + up * (c.y * 4.0);
  var o: VOut;
  o.pos = frame.viewProj * vec4f(vfxDomainToRel(p), 1.0);
  o.inst = ii;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let F = foams[in.inst];
  let depth = textureLoad(sceneDepthTex, vec2i(in.pos.xy), 0);
  if (depth <= 0.0) { discard; }
  let uv = in.pos.xy * frame.renderSize.zw;
  let rel = positionFromDepth(uv, depth);
  let d = vfxRelToDomain(rel) - F.centre.xyz;
  let up = vfx.domUp.xyz;
  let h = dot(d, up);
  if (abs(h) > 3.0) { discard; }
  let hz = d - up * h;
  let rho = length(hz) / F.centre.w;
  if (rho >= 1.0) { discard; }
  let age = F.state.x;
  // An expanding ring of churned water and a mottled patch inside it that breaks up with time.
  let n = vfxNoise(hz * 0.09 + vec3f(F.state.z));
  let n2 = vfxNoise(hz * 0.37 + vec3f(F.state.z * 3.0));
  let ring = exp(-sq((rho - 0.82) / 0.12)) * (0.6 + 0.8 * n.g);
  let mottle = smoothstep(0.35 + 0.55 * age, 0.75 + 0.3 * age, 0.55 * n.g + 0.45 * n2.b + 0.35 * (1.0 - rho)) * (1.0 - smoothstep(0.75, 1.0, rho));
  let a = saturate((0.9 * ring * (1.0 - age) + mottle) * F.state.y * (1.0 - smoothstep(0.6, 1.0, age)));
  if (a < 0.003) { discard; }
  let probe = vfxProbes[0];
  let lum = foamU.albedo.rgb * (probe.sun.rgb * saturate(dot(probe.up.xyz, frame.sunDir.xyz)) + vfxProbeAmbient(0u)) * (1.0 / PI);
  let c = vfxAtmosphere(uv, length(rel), lum * frame.exposure.x * a, a);
  return vec4f(writeHdr(c.rgb), saturate(c.a));
}
`;

interface FoamPatch {
  pos: Vec3;
  start: number;
  bodyRadius: number;
  strength: number;
  seed: number;
}

export class FoamRenderer {
  private readonly device: GPUDevice;
  private readonly data = new Float32Array(MAX_FOAM * INST_FLOATS);
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private patches: FoamPatch[] = [];

  constructor(
    ctx: RenderContext,
    private readonly common: VfxCommon,
    private readonly vfx: VfxData,
  ) {
    const device = (this.device = ctx.device);
    this.buffer = device.createBuffer({ label: 'vfx.foam', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniform = device.createBuffer({ label: 'vfx.foam.u', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([...vfx.splash.foamAlbedo, 1, 0, 0, 0, 0]));
    const layout = device.createBindGroupLayout({
      label: 'vfx.foam',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.group = device.createBindGroup({ label: 'vfx.foam', layout, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: this.buffer } }] });
    this.pipeline = common.core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('vfx.foam', WGSL);
      return device.createRenderPipeline({
        label: 'vfx.foam',
        layout: device.createPipelineLayout({ label: 'vfx.foam', bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        // Back faces without a depth test: the box is drawn once per pixel whether the eye is inside it or not.
        primitive: { topology: 'triangle-list', cullMode: 'front' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
      });
    });
    this.pipeline.get();
  }

  spawn(s: SplashSpawn, effectTime: number): void {
    if (this.patches.length >= MAX_FOAM) this.patches.shift();
    this.patches.push({ pos: v3.clone(s.pos), start: effectTime, bodyRadius: s.radius, strength: Math.min(1, s.speed / 6), seed: (s.seed % 251) / 251 });
  }

  rebase(rb: DomainRebase): void {
    for (const p of this.patches) p.pos = applyRebase(rb, p.pos, v3.zero()).p;
  }

  clear(): void {
    this.patches = [];
  }

  update(_frame: FrameContext, effectTime: number): void {
    const S = this.vfx.splash;
    this.patches = this.patches.filter((p) => effectTime - p.start < S.foamTime);
    this.patches.forEach((p, i) => {
      const age = effectTime - p.start;
      const radius = p.bodyRadius * (1.2 + S.foamRadiusFactor * (1 - Math.exp(-age / 2.5)) + 0.04 * age);
      this.data.set([p.pos.x, p.pos.y, p.pos.z, radius, age / S.foamTime, p.strength, p.seed, p.bodyRadius], i * INST_FLOATS);
    });
    if (this.patches.length > 0) this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.patches.length * INST_FLOATS);
  }

  get count(): number {
    return this.patches.length;
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.patches.length === 0) return;
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.group);
    pass.draw(36, this.patches.length);
  }

  dispose(): void {
    this.buffer.destroy();
  }
}
