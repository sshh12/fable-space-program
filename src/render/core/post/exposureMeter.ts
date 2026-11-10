/**
 * Milestone A: exposure comes from the photometric prior alone (no histogram pass yet). Milestone B adds
 * the GPU luminance histograms behind the same interface.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { Perf } from '../perf';
import type { CoreShaderLibrary } from '../shaders/library';
import { adaptEv100, HISTOGRAM_BINS, meterExposure, type MeterInput, type MeterResult } from './exposure';

export class ExposureMeter {
  private readonly empty = new Uint32Array(HISTOGRAM_BINS);
  private result: MeterResult = { targetEv100: 0, litFraction: 0, histogramWeight: 0, evHistogram: 0, evPrior: 0 };
  private sunVis = 1;
  constructor(_ctx: RenderContext, _shaders: CoreShaderLibrary) {}
  evaluate(input: Omit<MeterInput, 'histogram' | 'histogramNear' | 'sampleCount'>): MeterResult {
    this.sunVis = input.sunVisibility;
    this.result = meterExposure({ ...input, histogram: this.empty, histogramNear: this.empty, sampleCount: 1 });
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
  warm(): void {}
  run(_encoder: GPUCommandEncoder, _frame: FrameContext, _perf: Perf, _frameGroup: GPUBindGroup, _hdr: GPUTextureView, _depth: GPUTextureView): void {}
  afterSubmit(): void {}
}
