/**
 * GPU side of auto-exposure: a compute pass builds two 256-bin log-luminance histograms of the HDR scene
 * (every 4th pixel in x and y; geometry only: depth != 0, luminance above the absolute floor; one over
 * everything, one over geometry within INTERIOR_RANGE of the eye). The bins are read back asynchronously
 * and evaluated on the CPU by the rules in exposure.ts (ARCHITECTURE 10.4).
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { Perf } from '../perf';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { adaptEv100, HISTOGRAM_BINS, HISTOGRAM_MIN_LOG2, HISTOGRAM_RANGE_LOG2, INTERIOR_RANGE, LUMINANCE_FLOOR, meterExposure, type MeterInput, type MeterResult } from './exposure';

const STRIDE = 4;

const HISTOGRAM_CS = /* wgsl */ `
#include "frame"
struct Histogram { bins: array<atomic<u32>, ${HISTOGRAM_BINS * 2}> }
@group(1) @binding(0) var<storage, read_write> histogram: Histogram;
@group(1) @binding(1) var hdrTex: texture_2d<f32>;
@group(1) @binding(2) var depthTex: texture_depth_2d;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(hdrTex);
  let p = id.xy * ${STRIDE}u + vec2u(${STRIDE >> 1}u);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let d = textureLoad(depthTex, p, 0);
  if (d == 0.0) { return; }                       // sky, stars, sun disc: never metered
  // Absolute luminance in cd/m^2 (the target is pre-exposed).
  let lum = luminance(writeHdr(textureLoad(hdrTex, p, 0).rgb)) / frame.exposure.x;
  if (!(lum >= ${LUMINANCE_FLOOR})) { return; }
  let b = u32(clamp((log2(lum) - (${HISTOGRAM_MIN_LOG2}.0)) / ${HISTOGRAM_RANGE_LOG2}.0 * ${HISTOGRAM_BINS}.0, 0.0, ${HISTOGRAM_BINS - 1}.0));
  atomicAdd(&histogram.bins[b], 1u);
  if (viewZFromDepth(d) < ${INTERIOR_RANGE}.0) { atomicAdd(&histogram.bins[${HISTOGRAM_BINS}u + b], 1u); }
}
`;

export class ExposureMeter {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPUComputePipeline>;
  private readonly buffer: GPUBuffer;
  private readonly free: GPUBuffer[] = [];
  private inFlight = 0;
  private group: GPUBindGroup | null = null;
  private hdr: GPUTextureView | null = null;
  private depth: GPUTextureView | null = null;
  private pendingRead: { buffer: GPUBuffer; samples: number } | null = null;
  private histogram = new Uint32Array(HISTOGRAM_BINS);
  private histogramNear = new Uint32Array(HISTOGRAM_BINS);
  private sampleCount = 1;
  private result: MeterResult = { targetEv100: 0, litFraction: 0, histogramWeight: 0, evHistogram: 0, evPrior: 0, outsideFraction: 0, evOutside: 0, outsideWeight: 0, sunlitFloor: 0 };
  private sunVis = 1;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
  ) {
    const device = ctx.device;
    this.layout = device.createBindGroupLayout({
      label: 'core.histogram',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
      ],
    });
    this.buffer = device.createBuffer({ label: 'core.histogram', size: HISTOGRAM_BINS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.pipeline = shaders.tracked(() =>
      device.createComputePipeline({
        label: 'core.histogram',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, this.layout] }),
        compute: { module: shaders.createModule('core.histogram', HISTOGRAM_CS), entryPoint: 'main' },
      }),
    );
  }

  warm(): void {
    this.pipeline.get();
  }

  /** Target EV100 for this frame from the most recent histogram that has been read back. */
  evaluate(input: Omit<MeterInput, 'histogram' | 'histogramNear' | 'sampleCount'>): MeterResult {
    this.sunVis = input.sunVisibility;
    this.result = meterExposure({ ...input, histogram: this.histogram, histogramNear: this.histogramNear, sampleCount: this.sampleCount });
    return this.result;
  }

  adapt(current: number, target: number, dt: number): number {
    return adaptEv100(current, target, dt);
  }

  last(): MeterResult {
    return this.result;
  }

  lastSunVisibility(): number {
    return this.sunVis;
  }

  run(encoder: GPUCommandEncoder, frame: FrameContext, perf: Perf, frameGroup: GPUBindGroup, hdr: GPUTextureView, depth: GPUTextureView): void {
    const device = this.ctx.device;
    if (!this.group || hdr !== this.hdr || depth !== this.depth) {
      this.hdr = hdr;
      this.depth = depth;
      this.group = device.createBindGroup({
        label: 'core.histogram',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer } },
          { binding: 1, resource: hdr },
          { binding: 2, resource: depth },
        ],
      });
    }
    const gx = Math.ceil(frame.renderSize[0] / STRIDE);
    const gy = Math.ceil(frame.renderSize[1] / STRIDE);
    encoder.clearBuffer(this.buffer);
    const pass = encoder.beginComputePass({ label: 'histogram', timestampWrites: perf.gpuPass('core.histogram') });
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, this.group);
    pass.dispatchWorkgroups(Math.ceil(gx / 8), Math.ceil(gy / 8));
    pass.end();
    if (this.inFlight < 3) {
      const buffer = this.free.pop() ?? device.createBuffer({ label: 'core.histogramRead', size: HISTOGRAM_BINS * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyBufferToBuffer(this.buffer, 0, buffer, 0, HISTOGRAM_BINS * 8);
      this.pendingRead = { buffer, samples: Math.floor((frame.renderSize[0] + STRIDE - (STRIDE >> 1) - 1) / STRIDE) * Math.floor((frame.renderSize[1] + STRIDE - (STRIDE >> 1) - 1) / STRIDE) };
    }
  }

  /** Call after queue.submit(): starts the asynchronous read of this frame's histogram. */
  afterSubmit(): void {
    const read = this.pendingRead;
    if (!read) return;
    this.pendingRead = null;
    this.inFlight++;
    read.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const data = new Uint32Array(read.buffer.getMappedRange().slice(0));
        read.buffer.unmap();
        this.free.push(read.buffer);
        this.inFlight--;
        this.histogram = data.subarray(0, HISTOGRAM_BINS);
        this.histogramNear = data.subarray(HISTOGRAM_BINS);
        this.sampleCount = Math.max(1, read.samples);
      },
      () => {
        this.inFlight--;
      },
    );
  }
}
