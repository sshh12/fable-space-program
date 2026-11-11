/**
 * Ballast for the budget runs (docs/RENDER_API.md section 14): a fullscreen march that keeps the GPU as busy
 * as the full game's frame, so that it does not clock down and inflate every pass time.
 *
 * It is encoded LAST in the frame: in the overlay hook, which in perf attribution mode is a pass of its own
 * ('lab-ballast.overlay') after the tone map, blended so that the canvas keeps its picture. A long pass in
 * the middle of the frame disturbs what follows it: with the render-core lab's ballast, which is encoded
 * first, the first compute pass after it (the ocean's wake step on the pad, the sky's probe step elsewhere)
 * read about 0.23 ms too long in one frame out of four, 0.25 ms instead of 0.01-0.03, and neither an empty
 * pass, a small draw, a short second burn nor a small compute pass placed in between took that time instead
 * (measured per frame; without the ballast the same passes show no such frames). Behind the last game pass
 * there is nothing left to disturb, and the next frame begins milliseconds after this pass has ended.
 */
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import { coreOf, type Tracked } from '@/render/core';

export const BALLAST_PASS = 'lab-ballast.overlay';

export function createEndBallast(): { feature: RenderFeature; setIterations(n: number): void } {
  let iterations = 0;
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  const keep: GPUBlendComponent = { srcFactor: 'zero', dstFactor: 'one', operation: 'add' };
  return {
    setIterations(n) {
      iterations = Math.max(0, Math.round(n));
    },
    feature: {
      id: 'lab-ballast',
      // After every other overlay (cockpit tunnel vision, lab views): the last thing the frame encodes.
      order: 1e9,
      init(c) {
        ctx = c;
        uniform = c.device.createBuffer({ label: 'lab-ballast', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        pipeline = coreOf(c).fullscreenPipeline({
          label: BALLAST_PASS,
          layouts: [layout],
          fragment: /* wgsl */ `struct BallastU { v: vec4f }
            @group(1) @binding(0) var<uniform> ballast: BallastU;
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let steps = i32(ballast.v.x);
              var a = vec3f(in.uv, 0.5);
              for (var i = 0; i < steps; i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
              return vec4f(a, 1.0);
            }`,
          // The canvas keeps what the tone map wrote: the march is paid for and its result is dropped.
          targets: [{ format: c.canvasFormat, blend: { color: keep, alpha: keep } }],
        });
        pipeline.get();
      },
      prepare() {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([iterations, 0, 0, 0]));
      },
      drawOverlay(_frame, pass) {
        if (iterations <= 0) return;
        pass.setPipeline(pipeline.get());
        pass.setBindGroup(1, group);
        pass.draw(3);
      },
    },
  };
}
