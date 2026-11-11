/**
 * GPU ballast for the cockpit perf spec: a fullscreen burn in the compute hook so the GPU is as busy as a
 * game frame while the cockpit's passes are timed (RENDER_API section 14: an RTX 5090 with only a lab's
 * 1-2 ms of work clocks down and reads 2-5 x slower). An empty pass right behind the burn takes the tail
 * of the burn that is still in flight at its end timestamp, so it is not charged to the next pass.
 */
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import { coreOf, type ManagedTarget, type Tracked } from '@/render/core';

export interface BallastFeature extends RenderFeature {
  /** Loop iterations per pixel of the burn (0 = off). */
  iterations: number;
}

export function createBallastFeature(initial: number): BallastFeature {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  const f: BallastFeature = {
    id: 'cockpit-lab-ballast',
    order: 1000,
    iterations: initial,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('cockpit-lab-ballast.scratch', 'rgba16float', 1);
      uniform = c.device.createBuffer({ label: 'cockpit-lab-ballast', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ label: 'cockpit-lab-ballast', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ label: 'cockpit-lab-ballast', layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = core.fullscreenPipeline({
        label: 'cockpit-lab-ballast.burn',
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
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([f.iterations, 0, 0, 0]));
    },
    compute(frame, encoder) {
      if (f.iterations <= 0) return;
      const burn = ctx.perf.gpuPass('cockpit-lab-ballast.burn') as GPURenderPassTimestampWrites | undefined;
      const pass = encoder.beginRenderPass({ label: 'cockpit-lab-ballast.burn', colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], ...(burn ? { timestampWrites: burn } : {}) });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
      const tail = ctx.perf.gpuPass('cockpit-lab-ballast.tail') as GPURenderPassTimestampWrites | undefined;
      encoder.beginRenderPass({ label: 'cockpit-lab-ballast.tail', colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], ...(tail ? { timestampWrites: tail } : {}) }).end();
    },
    dispose() {
      uniform?.destroy();
    },
  };
  return f;
}
