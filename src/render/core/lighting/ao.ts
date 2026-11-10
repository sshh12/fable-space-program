/**
 * Milestone A: screen-space ambient occlusion and contact shadows are not computed yet; the lighting pass
 * receives a neutral (fully unoccluded) half-resolution target. Milestone B replaces this file with the
 * GTAO + contact-shadow pass behind the same interface.
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { CoreApi } from '../coreApi';
import type { Perf } from '../perf';
import type { CoreShaderLibrary } from '../shaders/library';
import { createSolidTexture } from '../util/gpu';

export class AmbientOcclusion {
  readonly view: GPUTextureView;
  readonly depthView: GPUTextureView;
  constructor(ctx: RenderContext, _shaders: CoreShaderLibrary, _core: CoreApi) {
    this.view = createSolidTexture(ctx.device, 'ao.neutral', 'rgba8unorm', [1, 1, 1, 1]).createView();
    this.depthView = createSolidTexture(ctx.device, 'ao.neutralDepth', 'r32float', [0]).createView();
  }
  resize(_w: number, _h: number): void {}
  warm(): void {}
  run(_encoder: GPUCommandEncoder, _frame: FrameContext, _perf: Perf, _frameGroup: GPUBindGroup, _normal: GPUTextureView): void {}
}
