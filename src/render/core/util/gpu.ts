/**
 * Small GPU utilities shared by the core and exported to features: half-float conversion, checked
 * allocation (out-of-memory error scopes), solid textures, mip generation, texture readback.
 */

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);

/** IEEE float32 -> float16 bits (round to nearest; overflow -> Inf). */
export function f32ToF16(value: number): number {
  f32buf[0] = value;
  const x = u32buf[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant = (mant | 0x800000) >> (1 - e);
    return sign | ((mant + 0x1000) >> 13);
  }
  const h = sign | (e << 10) | (mant >> 13);
  return mant & 0x1000 ? h + 1 : h;
}

export function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * Create a texture inside out-of-memory and validation error scopes; failures are reported through
 * `onError` instead of surfacing as uncaptured errors later. Use for every large allocation.
 */
export function createTextureChecked(device: GPUDevice, desc: GPUTextureDescriptor, onError: (message: string) => void): GPUTexture {
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  const tex = device.createTexture(desc);
  void device.popErrorScope().then((e) => {
    if (e) onError(`texture ${desc.label ?? '(unnamed)'}: validation error: ${e.message}`);
  });
  void device.popErrorScope().then((e) => {
    if (e) onError(`texture ${desc.label ?? '(unnamed)'}: out of GPU memory: ${e.message}`);
  });
  return tex;
}

export function createBufferChecked(device: GPUDevice, desc: GPUBufferDescriptor, onError: (message: string) => void): GPUBuffer {
  device.pushErrorScope('out-of-memory');
  const buf = device.createBuffer(desc);
  void device.popErrorScope().then((e) => {
    if (e) onError(`buffer ${desc.label ?? '(unnamed)'}: out of GPU memory: ${e.message}`);
  });
  return buf;
}

export type SolidFormat = 'rgba8unorm' | 'rgba8unorm-srgb' | 'r8unorm' | 'rgba16float' | 'r16float' | 'r32float' | 'rg32float';

/** A width x height x layers texture filled with one value (defaults for SharedResources, missing material maps). */
export function createSolidTexture(
  device: GPUDevice,
  label: string,
  format: SolidFormat,
  value: readonly number[],
  opts: { dimension?: GPUTextureDimension; layers?: number; usage?: GPUTextureUsageFlags } = {},
): GPUTexture {
  const layers = opts.layers ?? 1;
  const tex = device.createTexture({
    label,
    format,
    dimension: opts.dimension ?? '2d',
    size: [1, 1, layers],
    usage: opts.usage ?? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let texel: ArrayBufferView<ArrayBuffer>;
  switch (format) {
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
      texel = new Uint8Array([0, 1, 2, 3].map((i) => Math.round((value[i] ?? 0) * 255)));
      break;
    case 'r8unorm':
      texel = new Uint8Array([Math.round((value[0] ?? 0) * 255), 0, 0, 0]);
      break;
    case 'rgba16float':
      texel = new Uint16Array([0, 1, 2, 3].map((i) => f32ToF16(value[i] ?? 0)));
      break;
    case 'r16float':
      texel = new Uint16Array([f32ToF16(value[0] ?? 0), 0]);
      break;
    case 'r32float':
      texel = new Float32Array([value[0] ?? 0]);
      break;
    case 'rg32float':
      texel = new Float32Array([value[0] ?? 0, value[1] ?? 0]);
      break;
  }
  for (let z = 0; z < layers; z++) device.queue.writeTexture({ texture: tex, origin: [0, 0, z] }, texel, {}, [1, 1, 1]);
  return tex;
}

export const mipCount = (width: number, height: number): number => Math.floor(Math.log2(Math.max(width, height))) + 1;

/** Render-based mip chain generation (box filter through a linear sampler), for 2D textures and array layers. */
export class MipGenerator {
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private readonly sampler: GPUSampler;
  private readonly module: GPUShaderModule;

  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({ label: 'mipgen', minFilter: 'linear', magFilter: 'linear' });
    this.module = device.createShaderModule({
      label: 'mipgen',
      code: /* wgsl */ `
        struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
        @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
          let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
          return V(vec4f(q * 2.0 - 1.0, 0.0, 1.0), vec2f(q.x, 1.0 - q.y));
        }
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var smp: sampler;
        @fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(src, smp, v.uv, 0.0); }`,
    });
  }

  /** Fill mip levels 1.. of `texture` (which must have RENDER_ATTACHMENT | TEXTURE_BINDING usage). */
  generate(texture: GPUTexture): void {
    if (texture.mipLevelCount <= 1) return;
    let pipeline = this.pipelines.get(texture.format);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `mipgen.${texture.format}`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint: 'fs', targets: [{ format: texture.format }] },
      });
      this.pipelines.set(texture.format, pipeline);
    }
    const encoder = this.device.createCommandEncoder({ label: 'mipgen' });
    for (let layer = 0; layer < texture.depthOrArrayLayers; layer++) {
      for (let level = 1; level < texture.mipLevelCount; level++) {
        const src = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level - 1, mipLevelCount: 1 });
        const dst = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
        const bind = this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: src },
            { binding: 1, resource: this.sampler },
          ],
        });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
      }
    }
    this.device.queue.submit([encoder.finish()]);
  }
}

/** Copy a rectangle of a texture (one mip, one layer) into CPU memory. `bytesPerPixel` must match the format. */
export async function readTexturePixels(
  device: GPUDevice,
  texture: GPUTexture,
  rect: { x: number; y: number; width: number; height: number },
  bytesPerPixel: number,
  aspect: GPUTextureAspect = 'all',
): Promise<ArrayBuffer> {
  const bytesPerRow = Math.ceil((rect.width * bytesPerPixel) / 256) * 256;
  const buffer = device.createBuffer({ label: 'readback', size: bytesPerRow * rect.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: 'readback' });
  encoder.copyTextureToBuffer({ texture, origin: [rect.x, rect.y, 0], aspect }, { buffer, bytesPerRow }, [rect.width, rect.height, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(rect.width * rect.height * bytesPerPixel);
  for (let y = 0; y < rect.height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + rect.width * bytesPerPixel), y * rect.width * bytesPerPixel);
  buffer.unmap();
  buffer.destroy();
  return out.buffer;
}

/** Deterministic 64 x 64 x 4-channel blue-noise texture data (void-and-cluster ranking; channels are toroidal shifts). */
export function generateBlueNoise(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const n = size * size;
  const sigma = 1.9;
  const reach = Math.ceil(sigma * 3.5);
  const kernel: number[] = [];
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) kernel.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
  const energy = new Float32Array(n);
  const rank = new Int32Array(n).fill(-1);
  let state = seed >>> 0 || 1;
  const rnd = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const splat = (p: number): void => {
    const px = p % size;
    const py = (p / size) | 0;
    let k = 0;
    for (let dy = -reach; dy <= reach; dy++) {
      const y = (py + dy + size) % size;
      for (let dx = -reach; dx <= reach; dx++) {
        const x = (px + dx + size) % size;
        energy[y * size + x]! += kernel[k++]!;
      }
    }
  };
  // Tiny random perturbation breaks ties so the first samples do not line up on a lattice.
  for (let i = 0; i < n; i++) energy[i] = rnd() * 1e-3;
  for (let r = 0; r < n; r++) {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (rank[i]! < 0 && energy[i]! < bestE) {
        bestE = energy[i]!;
        best = i;
      }
    }
    rank[best] = r;
    splat(best);
  }
  const out = new Uint8Array(n * 4);
  const shifts = [
    [0, 0],
    [size >> 1, (size * 17) >> 6],
    [(size * 23) >> 6, (size * 41) >> 6],
    [(size * 47) >> 6, (size * 13) >> 6],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        const sx = (x + shifts[c]![0]!) % size;
        const sy = (y + shifts[c]![1]!) % size;
        out[(y * size + x) * 4 + c] = Math.min(255, Math.floor((rank[sy * size + sx]! / n) * 256));
      }
    }
  }
  return out;
}
