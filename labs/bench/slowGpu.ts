/**
 * A slower GPU, simulated: a march over every pixel of the INTERNAL resolution in a pass of its own
 * ('bench-slow-gpu.march', in `preTransparent`, into a target of its own), so its cost follows the pixel
 * count as the frame's own screen-space work does and the calibration counts it as fixed cost. The bench
 * lab's `&ballast=<iterations>` (and `window.__bench.setBallast`) is the "GPU ballast flag" of the
 * capability-settings acceptance: with it the calibration must choose a lower profile that still holds the
 * frame rate. Unlike the budget runs' ballast (labs/integration/ballast.ts), which keeps a fast GPU from
 * clocking down and is excluded from every sum, this one is the load.
 */
import type { FrameContext, RenderContext, RenderFeature } from '@/core/contracts/render';
import { coreOf, type ManagedTarget, type Tracked } from '@/render/core';

export const SLOW_GPU_PASS = 'bench-slow-gpu.march';

export function createSlowGpu(): { feature: RenderFeature; setIterations(n: number): void; iterations(): number } {
  let iterations = 0;
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  let target: ManagedTarget;
  return {
    setIterations(n) {
      iterations = Math.max(0, Math.round(n));
    },
    iterations: () => iterations,
    feature: {
      id: 'bench-slow-gpu',
      init(c) {
        ctx = c;
        uniform = c.device.createBuffer({ label: 'bench-slow-gpu', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        target = coreOf(c).createTarget('bench-slow-gpu', 'r8unorm', 1);
        pipeline = coreOf(c).fullscreenPipeline({
          label: SLOW_GPU_PASS,
          layouts: [layout],
          fragment: /* wgsl */ `struct SlowU { v: vec4f }
            @group(1) @binding(0) var<uniform> slow: SlowU;
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              var a = vec3f(in.uv, 0.5);
              for (var i = 0; i < i32(slow.v.x); i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
              return vec4f(a.x, 0.0, 0.0, 1.0);
            }`,
          targets: [{ format: 'r8unorm' }],
        });
        return coreOf(c).shaders.warm([pipeline]);
      },
      prepare() {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([iterations, 0, 0, 0]));
      },
      preTransparent(_frame: FrameContext, encoder: GPUCommandEncoder) {
        if (iterations <= 0) return;
        const pass = encoder.beginRenderPass({
          label: SLOW_GPU_PASS,
          colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
          timestampWrites: ctx.perf.gpuPass(SLOW_GPU_PASS) as GPURenderPassTimestampWrites | undefined,
        });
        pass.setPipeline(pipeline.get());
        pass.setBindGroup(0, _frame.frameBindGroup);
        pass.setBindGroup(1, group);
        pass.draw(3);
        pass.end();
      },
    },
  };
}
