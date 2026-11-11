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
import type { ManagedTarget, Tracked } from '@/render/core';
import type { VfxCommon } from './common';

export interface VolumeItem {
  /** Distance from the eye, m (items are drawn far to near). */
  distance: number;
  draw(pass: GPURenderPassEncoder): void;
}

/** A pass that turns the emitter targets into the final half-resolution image (the pad smoke march). */
export interface VolumeCombiner {
  /** True when it has something to draw this frame. */
  active(): boolean;
  /** Render into `target` reading the emitter colour and moment targets. */
  run(frame: FrameContext, encoder: GPUCommandEncoder, emit: ManagedTarget, moment: ManagedTarget, target: ManagedTarget, haveEmitters: boolean): void;
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

export class VolumePass {
  readonly emit: ManagedTarget;
  readonly moment: ManagedTarget;
  readonly combined: ManagedTarget;
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly composite: Tracked<GPURenderPipeline>;
  private groups: { emit: GPUBindGroup; combined: GPUBindGroup } | null = null;
  private groupVersion = -1;
  private result: 'none' | 'emit' | 'combined' = 'none';
  /** Volumes drawn in the last frame. */
  drawn = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly common: VfxCommon,
  ) {
    const core = common.core;
    this.emit = core.createTarget('vfx.volume.emit', 'rgba16float', 0.5);
    this.moment = core.createTarget('vfx.volume.moment', 'rg16float', 0.5);
    this.combined = core.createTarget('vfx.volume.combined', 'rgba16float', 0.5);
    this.compositeLayout = ctx.device.createBindGroupLayout({ label: 'vfx.composite', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.composite = core.fullscreenPipeline({
      label: 'vfx.composite',
      fragment: COMPOSITE_WGSL,
      layouts: [common.layout, this.compositeLayout],
      targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.composite.get();
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
      combiner.run(frame, encoder, this.emit, this.moment, this.combined, items.length > 0);
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
  }
}
