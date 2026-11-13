/**
 * The three MFDs: each paints its MfdPainter page into its own OffscreenCanvas (1024 x 768) when the pacing
 * rule says so (pacing.ts: fast flight-data pages at 15 Hz or better, other pages within a main-thread
 * budget, staggered so that one display paints per frame), and is copied into one layer of an
 * rgba8unorm-srgb texture array with a full mip chain (the smallest mip is the image's mean, which the
 * cabin light uses for the display glow). The array is published as 'ui.mfd'. A page change repaints that
 * display on the next frame.
 *
 * Upload: the canvas becomes a VideoFrame imported as an external texture and is drawn into mip 0 by a
 * render pass, then the mips by more passes, all on the frame's encoder and all timed as
 * 'cockpit.mfdUpload', so the GPU cost of the whole upload is measured (a queue copy cannot be timed).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { PerfRecorder } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage, MfdPainter } from '@/core/contracts/ui';
import { mipCount } from '@/render/core';
import { DisplayPacer, type PacingRule } from './pacing';

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

/** Mip 0 from the painted canvas: an external texture (sRGB-encoded values), decoded for the sRGB target. */
const UPLOAD_WGSL = /* wgsl */ `
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(q * 2.0 - 1.0, 0.0, 1.0), vec2f(q.x, 1.0 - q.y));
}
@group(0) @binding(0) var src: texture_external;
@group(0) @binding(1) var smp: sampler;
fn srgbToLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
@fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(srgbToLinear(textureSampleBaseClampToEdge(src, smp, v.uv).rgb), 1.0); }
`;

export interface DisplayStats {
  /** Pages painted and their main-thread cost (paint + copy + mip encode), ms. */
  paints: number;
  cpuMs: number;
  /** Split of cpuMs: Canvas 2D painting, the upload (frame import and pass encode), the mip encode. */
  paintMs: number;
  copyMs: number;
  mipMs: number;
  /** Frames over which the stats were collected. */
  frames: number;
  /** Paints of each display. */
  perDisplay: number[];
}

/**
 * Main-thread time the displays may take per second of wall time, all of them together (ms): 0.36 ms per
 * frame at 60 frames a second, under the 0.4 ms line of the brief. Displays showing fast flight-data pages
 * are painted at the full rate whatever they cost; the others share what those leave of this (pacing.ts).
 */
export const DISPLAY_CPU_BUDGET = 21.6;

/** Most paints of one display in one frame with frozen time, until a paint changes nothing. */
const EXACT_SETTLE_PAINTS = 600;

export class MfdDisplays {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  private readonly canvases: OffscreenCanvas[] = [];
  private readonly contexts: OffscreenCanvasRenderingContext2D[] = [];
  private readonly pipeline: GPURenderPipeline;
  private readonly upload: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  /** Frames imported this update: closed at the next update, after the encoder that uses them was submitted. */
  private frames: VideoFrame[] = [];
  private readonly mipViews: GPUTextureView[][] = [];
  private readonly mipGroups: GPUBindGroup[][] = [];
  /** When each display is painted (the rule is pacing.ts's). */
  readonly pacer: DisplayPacer;
  /** Page each layer shows and the snapshot tick it was painted from. */
  readonly painted: { page: MfdPage | null; tick: number; at: number }[] = [];
  stats: DisplayStats = { paints: 0, cpuMs: 0, paintMs: 0, copyMs: 0, mipMs: 0, frames: 0, perDisplay: [] };

  constructor(
    private readonly device: GPUDevice,
    count: number,
    width: number,
    height: number,
    rule: PacingRule,
    private readonly painter: MfdPainter,
    private readonly defs: DefLibrary,
    private readonly perf: PerfRecorder,
  ) {
    this.width = width;
    this.height = height;
    this.pacer = new DisplayPacer(count, rule);
    const levels = mipCount(width, height);
    this.texture = device.createTexture({
      label: 'cockpit.mfd',
      format: MFD_FORMAT,
      size: [width, height, count],
      mipLevelCount: levels,
      // COPY_SRC: tests and tools read the published pages back.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
    const module = device.createShaderModule({ label: 'cockpit.mfdMips', code: MIP_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'cockpit.mfdMips',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: MFD_FORMAT }] },
    });
    const uploadModule = device.createShaderModule({ label: 'cockpit.mfdUpload', code: UPLOAD_WGSL });
    this.upload = device.createRenderPipeline({
      label: 'cockpit.mfdUpload',
      layout: 'auto',
      vertex: { module: uploadModule, entryPoint: 'vs' },
      fragment: { module: uploadModule, entryPoint: 'fs', targets: [{ format: MFD_FORMAT }] },
    });
    this.sampler = device.createSampler({ label: 'cockpit.mfdMips', minFilter: 'linear', magFilter: 'linear' });
    for (let i = 0; i < count; i++) {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('cockpit displays: no 2D context for an OffscreenCanvas');
      this.canvases.push(c);
      this.contexts.push(ctx);
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
    this.pacer.markDirty(display);
  }

  /** The pacing back to "nothing painted" (CockpitFeature.resetTemporal). */
  resetTemporal(): void {
    this.pacer.reset();
  }

  /** A camera can read the screens and one of them still waits for the paint of what it shows now. */
  pending(): boolean {
    return this.readable && this.pacer.hasDirty();
  }

  private readable = false;
  private scratch: OffscreenCanvasRenderingContext2D | null = null;

  /** A digest of display i's canvas at half size (exact mode: whether another paint changed the page). */
  private digest(i: number): number {
    if (!this.scratch) this.scratch = new OffscreenCanvas(this.width >> 1, this.height >> 1).getContext('2d', { willReadFrequently: true })!;
    const s = this.scratch;
    s.drawImage(this.contexts[i]!.canvas, 0, 0, s.canvas.width, s.canvas.height);
    const d = s.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
    let h = 2166136261;
    for (let k = 0; k < d.length; k += 4) h = Math.imul(Math.imul(Math.imul(h ^ d[k]!, 16777619) ^ d[k + 1]!, 16777619) ^ d[k + 2]!, 16777619);
    return h >>> 0;
  }

  /**
   * Paint what the pacing rule (pacing.ts) says is due this frame: one display, a dirty one first (a page
   * change, the first frame, a cabin that comes back into view), else the one whose slot has come; a display
   * showing a fast flight-data page that is a whole period late is painted in the same frame. Encodes the
   * upload and mip passes on `encoder`.
   *
   * `visible` false (no camera can read the screens: the cabin is drawn at a far detail level, or not at
   * all, or the view is the map): nothing is painted; every display is repainted within three frames of the
   * cabin coming back into view (request app-integration-12).
   *
   * `exact` (the frame is rendered with frozen time: a deterministic screenshot, a frame-exact capture): the
   * page is painted to its finished state within the frame and the pacing ignores what the paint cost, so
   * which display shows what after N frames is a function of the snapshot and N.
   */
  update(time: number, snapshot: SimSnapshot, pageOf: (display: number) => MfdPage, encoder: GPUCommandEncoder, visible = true, exact = false): void {
    this.readable = visible;
    this.stats.frames++;
    for (const f of this.frames) f.close();
    this.frames = [];
    if (!visible) {
      this.pacer.hidden();
      return;
    }
    const due = this.pacer.due(time, pageOf);
    if (due.length === 0) return;
    const t0 = performance.now();
    for (const i of due) {
      const page = pageOf(i);
      const a = performance.now();
      this.painter.paint(this.contexts[i]!, this.width, this.height, page, snapshot, this.defs);
      if (exact) {
        // A page may be built over several paints against a wall-clock budget (the ORB page's body graphic):
        // how far it is at a given frame is then not a function of the frames. With frozen time the page is
        // painted until another paint changes nothing, so what is uploaded is the finished page.
        let h = this.digest(i);
        for (let n = 0; n < EXACT_SETTLE_PAINTS; n++) {
          this.painter.paint(this.contexts[i]!, this.width, this.height, page, snapshot, this.defs);
          const again = this.digest(i);
          if (again === h) break;
          h = again;
        }
      }
      const b = performance.now();
      this.encodeUpload(i, encoder);
      const c = performance.now();
      this.encodeMips(i, encoder);
      this.stats.paintMs += b - a;
      this.stats.copyMs += c - b;
      this.stats.mipMs += performance.now() - c;
      this.painted[i] = { page, tick: snapshot.tick, at: time };
      this.stats.paints++;
      this.stats.perDisplay[i] = (this.stats.perDisplay[i] ?? 0) + 1;
      // (Frozen time: the pacing takes no measured cost, every page is at the plain rate.)
      this.pacer.painted(i, time, page, exact ? 0 : performance.now() - a, pageOf);
    }
    this.stats.cpuMs += performance.now() - t0;
  }

  /** Mip 0 of a layer from its canvas, drawn in a timed pass. */
  private encodeUpload(layer: number, encoder: GPUCommandEncoder): void {
    const frame = new VideoFrame(this.canvases[layer]!, { timestamp: 0, alpha: 'discard' });
    this.frames.push(frame);
    const group = this.device.createBindGroup({
      layout: this.upload.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.device.importExternalTexture({ source: frame }) },
        { binding: 1, resource: this.sampler },
      ],
    });
    const ts = this.perf.gpuPass('cockpit.mfdUpload') as GPURenderPassTimestampWrites | undefined;
    const pass = encoder.beginRenderPass({
      label: `cockpit.mfdUpload.${layer}`,
      colorAttachments: [{ view: this.mipViews[layer]![0]!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      ...(ts ? { timestampWrites: ts } : {}),
    });
    pass.setPipeline(this.upload);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
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
    this.stats = { paints: 0, cpuMs: 0, paintMs: 0, copyMs: 0, mipMs: 0, frames: 0, perDisplay: [] };
  }

  dispose(): void {
    for (const f of this.frames) f.close();
    this.texture.destroy();
  }
}
