/**
 * The outside of an interior view at its own exposure (request cockpit-16): one fullscreen triangle at the
 * depth of INTERIOR_RANGE multiplies the HDR target by a gain under 1 wherever the scene lies beyond it (the
 * world in the windows, the sky included), after the transparents and before the temporal resolve and the
 * bloom. The depth test is the mask: per pixel, with the frame's jitter, so the resolve anti-aliases the
 * window's edge as it does every other edge, and nothing is blurred into a halo. What the gain is:
 * `interiorFarGain` in exposure.ts.
 */
import { NEAR_PLANE, RENDER_FORMATS, type RenderContext } from '@/core/contracts/render';
import type { CoreShaderLibrary, Tracked } from '../shaders/library';
import { INTERIOR_RANGE } from './exposure';

const FAR_EXPOSURE_WGSL = /* wgsl */ `
struct FarExposure { gain: vec4f }   // x = gain, y = clip-space depth of the range (reversed z)
@group(0) @binding(0) var<uniform> far: FarExposure;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, far.gain.y, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(far.gain.xxx, 1.0); }
`;

export class FarExposure {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: Tracked<GPURenderPipeline>;
  private readonly uniform: GPUBuffer;
  private readonly group: GPUBindGroup;

  constructor(
    private readonly ctx: RenderContext,
    shaders: CoreShaderLibrary,
  ) {
    const device = ctx.device;
    this.layout = device.createBindGroupLayout({ label: 'core.interiorFar', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.uniform = device.createBuffer({ label: 'core.interiorFar', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.group = device.createBindGroup({ label: 'core.interiorFar', layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    this.pipeline = shaders.tracked(() => {
      const module = shaders.createModule('core.interiorFar', FAR_EXPOSURE_WGSL);
      return device.createRenderPipeline({
        label: 'core.interiorFar',
        layout: device.createPipelineLayout({ label: 'core.interiorFar', bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          // target = target x gain; alpha is left as it is.
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
        },
        primitive: { topology: 'triangle-list' },
        // Reversed z: the triangle passes where it is nearer than the scene, i.e. where the scene is beyond the range (the sky, at depth 0, included).
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater' },
      });
    });
  }

  /** The stage's tracked pipeline, for `shaders.warm`. */
  pipelines(): Tracked<unknown>[] {
    return [this.pipeline];
  }

  /** Inside a pass on the HDR target with the scene depth attached read-only. */
  draw(pass: GPURenderPassEncoder, gain: number): void {
    this.ctx.device.queue.writeBuffer(this.uniform, 0, new Float32Array([gain, NEAR_PLANE / INTERIOR_RANGE, 0, 0]));
    pass.setPipeline(this.pipeline.get());
    pass.setBindGroup(0, this.group);
    pass.draw(3);
  }
}
