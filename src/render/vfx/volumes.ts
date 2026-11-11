/**
 * The half-resolution volume pass and its composite.
 *
 * preTransparent: every analytic volume (plume clusters, reentry plasma, fireballs, trail segments) is drawn
 * back to front into the emitter target with premultiplied "over" blending, each fragment marching its own
 * bounding box against THIS frame's 'scene.depthHalf'. A second target accumulates the opacity-weighted
 * log-distance of what was drawn, so the smoke march (smoke.ts) can place the emitters inside the smoke.
 * drawTransparent: one fullscreen composite with the core's depth-aware upsample.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import type { Vec3 } from '@/core/math';
import type { ManagedTarget, Tracked } from '@/render/core';
import type { VfxCommon } from './common';

/**
 * A luminous thing the exposure meter should know about (CoreApi.addEmissiveHint): an ellipse with half-axes
 * `a` x `b` metres facing the camera at `rel` (relative to the camera, ROOT axes), of mean luminance
 * `luminance` (cd/m^2, not pre-exposed).
 */
export interface EmitterHint {
  rel: Vec3;
  a: number;
  b: number;
  luminance: number;
  /** Stops over the meter's white the emitter is meant to sit at (default 3: a flame clips; 0: a faint glow keeps its shape). */
  clipStops?: number;
  /** Largest luminance the meter is told about, cd/m^2 (a flame in daylight must not stop the camera down below the daylight exposure). */
  cap?: number;
}

export interface VolumeItem {
  /** Distance from the eye, m (items are drawn far to near). */
  distance: number;
  draw(pass: GPURenderPassEncoder): void;
}

/** A pass that turns the emitter targets into the final half-resolution image (the pad smoke march). */
export interface VolumeCombiner {
  /** True when it has something to draw this frame. */
  active(): boolean;
  /** Render into `target` (the image) and `targetMoment` (its distances) reading the emitter colour and moment targets. */
  run(frame: FrameContext, encoder: GPUCommandEncoder, emit: ManagedTarget, moment: ManagedTarget, target: ManagedTarget, targetMoment: ManagedTarget, haveEmitters: boolean): void;
}

const COMPOSITE_WGSL = /* wgsl */ `
#include "vfx_common"
#include "upsample"
@group(2) @binding(0) var volumeTex: texture_2d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
  let v = upsampleDepthAware(volumeTex, sceneDepthHalfTex, in.uv, d, false);
  return vec4f(writeHdr(v.rgb), saturate(v.a));
}
`;

/** WGSL chunk "vfx_volume": the box proxy and the two outputs shared by the analytic volumes. */
const VOLUME_WGSL = /* wgsl */ `
const VOLUME_CUBE = array<u32, 36>(0u, 2u, 3u, 0u, 3u, 1u, 4u, 5u, 7u, 4u, 7u, 6u, 0u, 1u, 5u, 0u, 5u, 4u, 2u, 6u, 7u, 2u, 7u, 3u, 0u, 4u, 6u, 0u, 6u, 2u, 1u, 3u, 7u, 1u, 7u, 5u);
/// Clip position of vertex 'vi' (0..35) of the box [bmin, bmax] in the frame (origin, X, Y, Z); draw with cull mode 'front'.
fn volumeBoxVertex(vi: u32, origin: vec3f, X: vec3f, Y: vec3f, Z: vec3f, bmin: vec3f, bmax: vec3f) -> vec4f {
  let ci = VOLUME_CUBE[vi];
  let l = mix(bmin, bmax, vec3f(f32(ci & 1u), f32((ci >> 1u) & 1u), f32((ci >> 2u) & 1u)));
  return frame.viewProjUnjittered * vec4f(origin + X * l.x + Y * l.y + Z * l.z, 1.0);
}
struct VolumeRay {
  ro: vec3f,       // ray origin in the volume frame
  rd: vec3f,       // unit ray direction in the volume frame
  t0: f32,         // entry and exit distance along the ray (m); t1 <= t0: nothing to march
  t1: f32,
  uv: vec2f,       // screen UV of the fragment
}
/// The view ray of a fragment of the half-resolution volume pass, cut by the box and by this frame's scene depth.
fn volumeRay(fragPos: vec4f, origin: vec3f, X: vec3f, Y: vec3f, Z: vec3f, bmin: vec3f, bmax: vec3f) -> VolumeRay {
  var r: VolumeRay;
  r.uv = fragPos.xy * vfx.half.zw;
  let ray = viewRay(r.uv);
  let rayLen = length(ray);
  let dW = ray / rayLen;
  let tScene = viewZFromDepth(textureLoad(sceneDepthHalfTex, vec2i(fragPos.xy), 0).r) * rayLen;
  r.ro = -vec3f(dot(origin, X), dot(origin, Y), dot(origin, Z));
  r.rd = vec3f(dot(dW, X), dot(dW, Y), dot(dW, Z));
  r.rd = select(r.rd, vec3f(1e-7), abs(r.rd) < vec3f(1e-7));
  let ta = (bmin - r.ro) / r.rd;
  let tb = (bmax - r.ro) / r.rd;
  let tmn = min(ta, tb);
  let tmx = max(ta, tb);
  r.t0 = max(max(tmn.x, max(tmn.y, tmn.z)), 0.0);
  r.t1 = min(min(tmx.x, min(tmx.y, tmx.z)), tScene);
  return r;
}
struct VolumeOut {
  @location(0) color: vec4f,    // premultiplied pre-exposed radiance, a = opacity
  @location(1) moment: vec4f,   // r = weight x log2(distance), g = weight
}
fn volumeNone() -> VolumeOut { return VolumeOut(vec4f(0.0), vec4f(0.0)); }
/// Pack a marched result: 'radiance' in cd/m^2 (not pre-exposed), 'transmittance' of the volume, mean distance of what was seen.
fn volumeOut(uv: vec2f, radiance: vec3f, transmittance: f32, tMean: f32) -> VolumeOut {
  let rgb = min(radiance * frame.exposure.x, vec3f(HDR_MAX * 0.25));
  let c = vfxAtmosphere(uv, tMean, rgb, 1.0 - transmittance);
  var o: VolumeOut;
  o.color = vec4f(writeHdr(c.rgb), saturate(c.a));
  let lum = luminance(o.color.rgb);
  let mw = saturate(max(o.color.a, lum / (lum + 1.0)));
  o.moment = vec4f(mw * log2(max(tMean, 1e-3)), mw, 0.0, 0.0);
  return o;
}
`;

/** Render pipeline of an analytic volume: box proxy (36 vertices per instance), drawn into the two volume targets. */
export function createVolumePipeline(ctx: RenderContext, common: VfxCommon, label: string, wgsl: string, layout: GPUBindGroupLayout): Tracked<GPURenderPipeline> {
  const over: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const add: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  return common.core.shaders.tracked(() => {
    const module = ctx.shaders.createModule(label, wgsl);
    return ctx.device.createRenderPipeline({
      label,
      layout: ctx.device.createPipelineLayout({ label, bindGroupLayouts: [ctx.frameBindGroupLayout, common.layout, layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: over }, { format: 'rg16float', blend: add }] },
      primitive: { topology: 'triangle-list', cullMode: 'front' },
    });
  });
}

export class VolumePass {
  readonly emit: ManagedTarget;
  readonly moment: ManagedTarget;
  readonly combined: ManagedTarget;
  readonly combinedMoment: ManagedTarget;
  /** 1 x 1 stand-in for the image and its distances in frames without volumes. */
  private readonly empty: GPUTextureView;
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly composite: Tracked<GPURenderPipeline>;
  private groups: { emit: GPUBindGroup; combined: GPUBindGroup } | null = null;
  private groupVersion = -1;
  private result: 'none' | 'emit' | 'combined' = 'none';
  private readonly ceiling: Tracked<GPURenderPipeline>;
  /** Volumes drawn in the last frame. */
  drawn = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
  ) {
    const core = common.core;
    ctx.shaders.register('vfx_volume', VOLUME_WGSL);
    this.emit = core.createTarget('vfx.volume.emit', 'rgba16float', 0.5);
    this.moment = core.createTarget('vfx.volume.moment', 'rg16float', 0.5);
    this.combined = core.createTarget('vfx.volume.combined', 'rgba16float', 0.5);
    this.combinedMoment = core.createTarget('vfx.volume.combinedMoment', 'rg16float', 0.5);
    this.empty = core.createTextureChecked({ label: 'vfx.volume.empty', format: 'rgba16float', size: [1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }).createView();
    this.compositeLayout = ctx.device.createBindGroupLayout({ label: 'vfx.composite', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.composite = core.fullscreenPipeline({
      label: 'vfx.composite',
      fragment: COMPOSITE_WGSL,
      layouts: [common.layout, this.compositeLayout],
      targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.composite.get();
    // Blending adds to what is already in the HDR target, and the sum of two values below HDR_MAX can exceed
    // it. A fullscreen 'min' blend against HDR_MAX after the feature's last transparent draw restores the limit.
    this.ceiling = core.fullscreenPipeline({
      label: 'vfx.ceiling',
      fragment: /* wgsl */ `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(HDR_MAX, HDR_MAX, HDR_MAX, 1.0); }`,
      targets: [
        {
          format: RENDER_FORMATS.hdr,
          blend: { color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'min', srcFactor: 'one', dstFactor: 'one' } },
          writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
        },
      ],
      depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.ceiling.get();
  }

  /** Clamp the HDR target to HDR_MAX (after the last blended draw of the feature). */
  drawCeiling(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.ceiling.get());
    pass.draw(3);
  }

  /** True when the half-resolution image holds something this frame. */
  get hasImage(): boolean {
    return this.result !== 'none';
  }

  /**
   * The half-resolution image of this frame and the distances of what it shows (r = weight x log2(distance),
   * g = weight), for what is drawn after it (particles). Valid after `run`; `version` changes when a view does.
   */
  get image(): { color: GPUTextureView; moment: GPUTextureView; version: number } {
    if (this.result === 'combined') return { color: this.combined.view, moment: this.combinedMoment.view, version: 4 * (this.combined.version + this.combinedMoment.version) + 1 };
    if (this.result === 'emit') return { color: this.emit.view, moment: this.moment.view, version: 4 * (this.emit.version + this.moment.version) + 2 };
    return { color: this.empty, moment: this.empty, version: 0 };
  }

  /** Size of the half-resolution targets in this frame (valid from prepare on). */
  get size(): [number, number] {
    return this.emit.size;
  }

  /** preTransparent: draw the volumes, then let the combiner (smoke) finish the image. */
  run(frame: FrameContext, encoder: GPUCommandEncoder, items: VolumeItem[], combiner: VolumeCombiner | null): void {
    this.drawn = items.length;
    const combine = combiner !== null && combiner.active();
    if (items.length === 0 && !combine) {
      this.result = 'none';
      return;
    }
    if (items.length > 0) {
      items.sort((a, b) => b.distance - a.distance);
      const pass = encoder.beginRenderPass({
        label: 'vfx.volumes',
        colorAttachments: [
          { view: this.emit.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          { view: this.moment.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
        timestampWrites: this.ctx.perf.gpuPass('vfx.volumes') as GPURenderPassTimestampWrites | undefined,
      });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, this.common.bindGroup());
      for (const item of items) item.draw(pass);
      pass.end();
    }
    if (combine) {
      combiner.run(frame, encoder, this.emit, this.moment, this.combined, this.combinedMoment, items.length > 0);
      this.result = 'combined';
    } else {
      this.result = 'emit';
    }
  }

  /** drawTransparent: blend the half-resolution image into the HDR target. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.result === 'none') return;
    const v = this.emit.version + this.combined.version;
    if (!this.groups || v !== this.groupVersion) {
      this.groupVersion = v;
      const mk = (view: GPUTextureView): GPUBindGroup => this.ctx.device.createBindGroup({ label: 'vfx.composite', layout: this.compositeLayout, entries: [{ binding: 0, resource: view }] });
      this.groups = { emit: mk(this.emit.view), combined: mk(this.combined.view) };
    }
    pass.setPipeline(this.composite.get());
    pass.setBindGroup(1, this.common.bindGroup());
    pass.setBindGroup(2, this.result === 'emit' ? this.groups.emit : this.groups.combined);
    pass.draw(3);
  }

  dispose(): void {
    this.emit.destroy();
    this.moment.destroy();
    this.combined.destroy();
    this.combinedMoment.destroy();
  }
}
