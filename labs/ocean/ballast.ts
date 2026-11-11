/**
 * GPU ballast for perf measurements: a fullscreen pass of adjustable cost encoded first in the frame (compute
 * hook), so the GPU runs at the clock of a real 9-11 ms frame while the ocean's passes are timed (an idle RTX
 * 5090 reads 2-5 times slower; docs/handoff/render-core.md 4.1). An empty pass right behind it absorbs the
 * tail of the burn that is still in flight at its end timestamp.
 */
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import { coreOf, type ManagedTarget, type Tracked } from '@/render/core';

export interface Ballast extends RenderFeature {
  iterations: number;
}

export function createBallastFeature(): Ballast {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  const b: Ballast = {
    id: 'lab-ballast',
    order: -1000,
    iterations: 0,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('lab-ballast.scratch', 'rgba16float', 1);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = core.fullscreenPipeline({
        label: 'lab-ballast.burn',
        layouts: [layout],
        fragment: /* wgsl */ `struct BallastU { v: vec4f }
          @group(1) @binding(0) var<uniform> ballast: BallastU;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            var a = vec3f(in.uv, 0.5);
            for (var i = 0; i < i32(ballast.v.x); i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
            return vec4f(a, 1.0);
          }`,
        targets: [{ format: 'rgba16float' }],
      });
      pipeline.get();
    },
    prepare() {
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([b.iterations, 0, 0, 0]));
    },
    compute(frame, encoder) {
      if (b.iterations <= 0) return;
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-ballast.burn') as GPURenderPassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
      encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-ballast.tail') as GPURenderPassTimestampWrites | undefined }).end();
    },
  };
  return b;
}
