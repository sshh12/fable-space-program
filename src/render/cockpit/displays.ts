/**
 * The three MFDs: each paints its MfdPainter page into its own OffscreenCanvas (1024 x 768) at 15 Hz,
 * staggered so that at most one display paints per frame, and is copied into one layer of an
 * rgba8unorm-srgb texture array with a full mip chain (the smallest mip is the image's mean, which the
 * cabin light uses for the display glow). The array is published as 'ui.mfd'. A page change repaints that
 * display on the next frame.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { PerfRecorder } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage, MfdPainter } from '@/core/contracts/ui';
import { mipCount } from '@/render/core';

export const MFD_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

const MIP_WGSL = /* wgsl */ `
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(q * 2.0 - 1.0, 0.0, 1.0), vec2f(q.x, 1.0 - q.y));
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(src, smp, v.uv, 0.0); }
`;

export interface DisplayStats {
  /** Pages painted and their main-thread cost (paint + copy + mip encode), ms. */
  paints: number;
  cpuMs: number;
  /** Split of cpuMs: Canvas 2D painting, the copy into the texture, the mip encode. */
  paintMs: number;
  copyMs: number;
  mipMs: number;
  /** Frames over which the stats were collected. */
  frames: number;
}

export class MfdDisplays {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  private readonly canvases: OffscreenCanvas[] = [];
  private readonly contexts: OffscreenCanvasRenderingContext2D[] = [];
  private readonly next: number[] = [];
  private readonly dirty = new Set<number>();
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly mipViews: GPUTextureView[][] = [];
  private readonly mipGroups: GPUBindGroup[][] = [];
  private readonly period: number;
  /** Page each layer shows and the snapshot tick it was painted from. */
  readonly painted: { page: MfdPage | null; tick: number; at: number }[] = [];
  stats: DisplayStats = { paints: 0, cpuMs: 0, paintMs: 0, copyMs: 0, mipMs: 0, frames: 0 };

  constructor(
    private readonly device: GPUDevice,
    count: number,
    width: number,
    height: number,
    rateHz: number,
    private readonly painter: MfdPainter,
    private readonly defs: DefLibrary,
    private readonly perf: PerfRecorder,
  ) {
    this.width = width;
    this.height = height;
    this.period = 1 / rateHz;
    const levels = mipCount(width, height);
    this.texture = device.createTexture({
      label: 'cockpit.mfd',
      format: MFD_FORMAT,
      size: [width, height, count],
      mipLevelCount: levels,
      // COPY_SRC: tests and tools read the published pages back.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
    const module = device.createShaderModule({ label: 'cockpit.mfdMips', code: MIP_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'cockpit.mfdMips',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: MFD_FORMAT }] },
    });
    this.sampler = device.createSampler({ label: 'cockpit.mfdMips', minFilter: 'linear', magFilter: 'linear' });
    for (let i = 0; i < count; i++) {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('cockpit displays: no 2D context for an OffscreenCanvas');
      this.canvases.push(c);
      this.contexts.push(ctx);
      // Staggered: display i first paints i / count of a period after start.
      this.next.push((i / count) * this.period);
      this.dirty.add(i);
      this.painted.push({ page: null, tick: -1, at: -1 });
      const views: GPUTextureView[] = [];
      const groups: GPUBindGroup[] = [];
      for (let l = 0; l < levels; l++) views.push(this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1, baseMipLevel: l, mipLevelCount: 1 }));
      for (let l = 1; l < levels; l++) {
        groups.push(
          device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: views[l - 1]! },
              { binding: 1, resource: this.sampler },
            ],
          }),
        );
      }
      this.mipViews.push(views);
      this.mipGroups.push(groups);
    }
  }

  markDirty(display: number): void {
    this.dirty.add(display);
  }

  /**
   * Paint what is due this frame: every dirty display (page changes, first frame), else the one display
   * whose 15 Hz slot has come. Encodes the mip passes on `encoder` (call from a hook that has one).
   */
  update(time: number, snapshot: SimSnapshot, pageOf: (display: number) => MfdPage, encoder: GPUCommandEncoder): void {
    this.stats.frames++;
    const due: number[] = [...this.dirty];
    if (due.length === 0) {
      let best = -1;
      for (let i = 0; i < this.next.length; i++) if (time >= this.next[i]! && (best < 0 || this.next[i]! < this.next[best]!)) best = i;
      if (best >= 0) due.push(best);
    }
    if (due.length === 0) return;
    const t0 = performance.now();
    for (const i of due) {
      this.dirty.delete(i);
      this.next[i] = Math.max(this.next[i]! + this.period, time + this.period * 0.5);
      const page = pageOf(i);
      const a = performance.now();
      this.painter.paint(this.contexts[i]!, this.width, this.height, page, snapshot, this.defs);
      const b = performance.now();
      this.device.queue.copyExternalImageToTexture({ source: this.canvases[i]! }, { texture: this.texture, origin: [0, 0, i] }, [this.width, this.height]);
      const c = performance.now();
      this.encodeMips(i, encoder);
      this.stats.paintMs += b - a;
      this.stats.copyMs += c - b;
      this.stats.mipMs += performance.now() - c;
      this.painted[i] = { page, tick: snapshot.tick, at: time };
      this.stats.paints++;
    }
    this.stats.cpuMs += performance.now() - t0;
  }

  private encodeMips(layer: number, encoder: GPUCommandEncoder): void {
    const views = this.mipViews[layer]!;
    const groups = this.mipGroups[layer]!;
    for (let l = 1; l < views.length; l++) {
      // Every level is timed under one name; the recorder sums repeated names within a frame.
      const ts = this.perf.gpuPass('cockpit.mfdUpload') as GPURenderPassTimestampWrites | undefined;
      const pass = encoder.beginRenderPass({
        label: `cockpit.mfdMips.${layer}.${l}`,
        colorAttachments: [{ view: views[l]!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        ...(ts ? { timestampWrites: ts } : {}),
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, groups[l - 1]!);
      pass.draw(3);
      pass.end();
    }
  }

  resetStats(): void {
    this.stats = { paints: 0, cpuMs: 0, paintMs: 0, copyMs: 0, mipMs: 0, frames: 0 };
  }

  dispose(): void {
    this.texture.destroy();
  }
}
