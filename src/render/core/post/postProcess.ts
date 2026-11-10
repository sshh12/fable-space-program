/**
 * Milestone A: the HDR target goes straight to the tonemapper (no TAA, no bloom). Milestone B replaces this
 * file with TAA / TAAU, bloom and dynamic-resolution handling behind the same interface.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { CoreApi } from '../coreApi';
import type { Perf } from '../perf';
import type { CoreShaderLibrary } from '../shaders/library';
import { createSolidTexture } from '../util/gpu';

export interface PostInputs {
  hdr: GPUTextureView;
  velocity: GPUTextureView;
  depth: GPUTextureView;
  reset: boolean;
  historyScale: number;
}
export interface PostOutputs {
  color: GPUTextureView;
  bloom: GPUTextureView;
  bloomMix: number;
  sharpness: number;
}

export class PostProcess {
  /** True when the projection must be jittered (temporal anti-aliasing active). */
  readonly temporal = false;
  private readonly black: GPUTextureView;
  constructor(ctx: RenderContext, _shaders: CoreShaderLibrary, _core: CoreApi, _rg11b10: boolean) {
    this.black = createSolidTexture(ctx.device, 'post.black', 'rgba16float', [0, 0, 0, 1]).createView();
  }
  resize(_w: number, _h: number): void {}
  warm(): void {}
  resolvedTexture(): GPUTexture | null {
    return null;
  }
  run(_encoder: GPUCommandEncoder, _frame: FrameContext, _perf: Perf, _frameGroup: GPUBindGroup, inputs: PostInputs): PostOutputs {
    return { color: inputs.hdr, bloom: this.black, bloomMix: 0, sharpness: 0 };
  }
}
