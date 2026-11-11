/**
 * Fixed-size texture-array pools for tile data and the batched mip generator that fills the mip chains of
 * newly uploaded layers. Arrays are allocated once (under out-of-memory scopes, each well under 2 GiB);
 * layers are recycled through free lists, never reallocated.
 */
import type { RenderContext } from '@/core/contracts/render';
import { coreOf } from '@/render/core';

export class LayerPool {
  readonly texture: GPUTexture;
  /** View of the whole array with every mip (what shaders bind). */
  readonly view: GPUTextureView;
  readonly mipLevels: number;
  readonly bytes: number;
  private readonly free: number[] = [];
  private readonly mipViews: GPUTextureView[] = [];
  private readonly layerViews = new Map<number, GPUTextureView>();

  constructor(
    ctx: RenderContext,
    readonly label: string,
    readonly format: GPUTextureFormat,
    readonly size: number,
    readonly layers: number,
    mips: boolean,
    bytesPerTexel: number,
  ) {
    this.mipLevels = mips ? Math.floor(Math.log2(size)) + 1 : 1;
    let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    // Mip generation renders into the layers; copyExternalImageToTexture needs the attachment usage too.
    if (mips) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
    this.texture = coreOf(ctx).createTextureChecked({ label, format, size: [size, size, layers], mipLevelCount: this.mipLevels, usage });
    this.view = this.texture.createView({ label, dimension: '2d-array' });
    let texels = 0;
    for (let m = 0; m < this.mipLevels; m++) texels += Math.max(1, size >> m) ** 2;
    this.bytes = texels * bytesPerTexel * layers;
    for (let i = layers - 1; i >= 0; i--) this.free.push(i);
  }

  get freeLayers(): number {
    return this.free.length;
  }

  /** A free layer, or -1 when the pool is exhausted. */
  alloc(): number {
    return this.free.length > 0 ? this.free.pop()! : -1;
  }

  release(layer: number): void {
    if (layer >= 0) this.free.push(layer);
  }

  /** Array view restricted to one mip level (source of a downsample). */
  mipView(mip: number): GPUTextureView {
    return (this.mipViews[mip] ??= this.texture.createView({ label: `${this.label}.mip${mip}`, dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 }));
  }

  /** 2-D view of one layer and mip (target of a downsample). */
  layerView(layer: number, mip: number): GPUTextureView {
    const key = layer * 16 + mip;
    let v = this.layerViews.get(key);
    if (!v) {
      v = this.texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip, mipLevelCount: 1 });
      this.layerViews.set(key, v);
    }
    return v;
  }

  destroy(): void {
    this.texture.destroy();
  }
}

const MAX_BATCH = 8;

/**
 * Mip chains for up to 8 freshly written layers of one pool per pass: mip m of every layer is rendered in
 * ONE pass with one colour attachment per layer, so a frame's uploads cost at most `mipLevels - 1` small
 * passes per pool instead of one pass per layer and level.
 */
export class BatchMipGenerator {
  private readonly device: GPUDevice;
  private readonly sampler: GPUSampler;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly layout: GPUBindGroupLayout;
  private readonly uniforms: GPUBuffer[] = [];
  private nextUniform = 0;

  constructor(private readonly ctx: RenderContext) {
    this.device = ctx.device;
    this.sampler = this.device.createSampler({ label: 'terrain.mipgen', minFilter: 'linear', magFilter: 'linear' });
    this.layout = this.device.createBindGroupLayout({
      label: 'terrain.mipgen',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    for (let i = 0; i < 16; i++) this.uniforms.push(this.device.createBuffer({ label: `terrain.mipgen.${i}`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  }

  private pipeline(format: GPUTextureFormat, count: number): GPURenderPipeline {
    const key = `${format}:${count}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    const outs = Array.from({ length: count }, (_, i) => `@location(${i}) c${i}: vec4f,`).join(' ');
    const body = Array.from({ length: count }, (_, i) => `o.c${i} = textureSampleLevel(src, smp, v.uv, u.layers[${i >> 2}][${i & 3}], 0.0);`).join('\n  ');
    const module = this.device.createShaderModule({
      label: `terrain.mipgen.${key}`,
      code: /* wgsl */ `
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(q * 2.0 - 1.0, 0.0, 1.0), vec2f(q.x, 1.0 - q.y));
}
struct U { layers: array<vec4u, 2> }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct Out { ${outs} }
@fragment fn fs(v: V) -> Out {
  var o: Out;
  ${body}
  return o;
}`,
    });
    p = this.device.createRenderPipeline({
      label: `terrain.mipgen.${key}`,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: Array.from({ length: count }, () => ({ format })) },
    });
    this.pipelines.set(key, p);
    return p;
  }

  /** Encode the mip chains of `layers` of `pool` (mip 0 must already be written). */
  generate(encoder: GPUCommandEncoder, pool: LayerPool, layers: readonly number[]): void {
    if (pool.mipLevels <= 1) return;
    for (let start = 0; start < layers.length; start += MAX_BATCH) {
      const batch = layers.slice(start, start + MAX_BATCH);
      const uniform = this.uniforms[this.nextUniform++ % this.uniforms.length]!;
      const data = new Uint32Array(8);
      batch.forEach((l, i) => (data[i] = l));
      this.device.queue.writeBuffer(uniform, 0, data);
      const pipeline = this.pipeline(pool.format, batch.length);
      for (let mip = 1; mip < pool.mipLevels; mip++) {
        const bind = this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: pool.mipView(mip - 1) },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: { buffer: uniform } },
          ],
        });
        const pass = encoder.beginRenderPass({
          label: `terrain.mipgen.${pool.label}`,
          colorAttachments: batch.map((l) => ({ view: pool.layerView(l, mip), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })),
          timestampWrites: this.ctx.perf.gpuPass('terrain.mipgen') as GPURenderPassTimestampWrites | undefined,
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
      }
    }
  }
}
