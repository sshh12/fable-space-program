/**
 * Lab-only GPU ballast for the perf spec. An RTX-class GPU that only has this lab's fraction of a millisecond of
 * work per frame drops into a low clock state, and small passes then read several times slower with a p99 that
 * jumps from run to run (docs/handoff/render-core.md section 4.1). The navball budget (ARCHITECTURE 17.1) is for
 * the game's frame, which keeps the GPU busy for 9-11 ms, so the perf spec measures with this pass burning a
 * set number of hash iterations per pixel of a 2560 x 1440 scratch target (about 7 ms once calibrated).
 *
 * It is encoded and submitted before the HUD renders the navball, followed by an empty pass of its own: the tail
 * of a long pass that is still in flight at its end timestamp is charged to whatever is encoded next, which is
 * then this empty pass instead of the navball.
 */
import type { GpuHandle } from '@/core/gpu/device';
import type { GpuTimer } from './gpuTimer';

const WIDTH = 2560;
const HEIGHT = 1440;

const WGSL = /* wgsl */ `
struct U { v: vec4f }
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let steps = i32(u.v.x);
  var a = vec3f(pos.xy / vec2f(${WIDTH}.0, ${HEIGHT}.0), 0.5);
  for (var i = 0; i < steps; i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
  return vec4f(a, 1.0);
}
`;

export interface GpuBallast {
  /** Hash iterations per pixel (0 = off). */
  iterations: number;
  /** Encode and submit the ballast for this frame (nothing when off). */
  submit(): void;
}

export function createGpuBallast(gpu: GpuHandle, timer: GpuTimer, iterations = 0): GpuBallast {
  const device = gpu.device;
  const target = device.createTexture({ label: 'lab.ballast.scratch', size: [WIDTH, HEIGHT], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const view = target.createView();
  const uniform = device.createBuffer({ label: 'lab.ballast.uniform', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ label: 'lab.ballast', code: WGSL });
  const pipeline = device.createRenderPipeline({ label: 'lab.ballast', layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
  const values = new Float32Array(4);

  const ballast: GpuBallast = {
    iterations,
    submit() {
      if (ballast.iterations <= 0) return;
      values[0] = ballast.iterations;
      device.queue.writeBuffer(uniform, 0, values);
      const encoder = device.createCommandEncoder({ label: 'lab.ballast' });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: timer.gpuPass('lab.ballast') });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }], timestampWrites: timer.gpuPass('lab.ballast.tail') }).end();
      device.queue.submit([encoder.finish()]);
    },
  };
  return ballast;
}
