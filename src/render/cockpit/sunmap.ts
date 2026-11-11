/**
 * The cabin's own sun shadow map: an orthographic depth map along the sun in the capsule part frame,
 * covering the interior's bounding sphere (about 2 mm texels at 2048^2), re-rendered every frame the sun
 * reaches the cabin from the interior at its current detail level plus the window wells through the
 * pressure wall (shadow-only geometry from the shared mould line). Sampled by the cabin shaders
 * (SUN_WGSL in shaders.ts) with a blocker search and a fixed Poisson PCF, so a sun patch's edge has the
 * penumbra of the real window edge and no noise.
 *
 * Why not the core's cascade 0: inside the cabin the patch edges are judged from 0.4 to 1 m; the core's
 * general filter (12 taps rotated per pixel by blue noise, at least 1.5 texels of a 6 m cascade) leaves a
 * grainy band several centimetres wide there (request cockpit-4). The core's cascades still carry the
 * interior as a moving caster with its openings closed, so that the core's sun never lights the cabin.
 */
import { v3, type Vec3 } from '@/core/math';
import { VERTEX_STRIDE } from './mesh';
import { SUNMAP_WGSL } from './shaders';

export const SUN_MAP_FORMAT: GPUTextureFormat = 'depth32float';

export interface SunMapTransform {
  /** u, v, depth = dot(axis, p_part) + w; all in 0..1 over the map. */
  u: [number, number, number, number];
  v: [number, number, number, number];
  l: [number, number, number, number];
  /** Texel size and depth range, m. */
  texel: number;
  range: number;
}

/** Map transform for the unit direction to the sun `sunPart` (part frame) around a sphere (centre, radius). */
export function sunMapTransform(sunPart: Vec3, centre: Vec3, radius: number, size: number): SunMapTransform {
  const l = v3.neg(v3.normalize(sunPart));
  const u = v3.normalize(v3.cross(Math.abs(l.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }, l));
  const w = v3.cross(l, u);
  const k = 1 / (2 * radius);
  const row = (a: Vec3): [number, number, number, number] => [a.x * k, a.y * k, a.z * k, 0.5 - v3.dot(a, centre) * k];
  return { u: row(u), v: row(w), l: row(l), texel: (2 * radius) / size, range: 2 * radius };
}

/** Bounding sphere of every vertex of a mesh (part frame) about a given centre. */
export function boundingRadius(vertices: ArrayBuffer, count: number, centre: Vec3): number {
  const f32 = new Float32Array(vertices);
  let r2 = 0;
  for (let i = 0; i < count; i++) {
    const o = (i * VERTEX_STRIDE) / 4;
    const dx = f32[o]! - centre.x;
    const dy = f32[o + 1]! - centre.y;
    const dz = f32[o + 2]! - centre.z;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(r2);
}

export class CabinSunMap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: number;
  private readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  private readonly xf: GPUBuffer;
  private readonly xfData = new Float32Array(12);

  constructor(
    private readonly device: GPUDevice,
    size: number,
    createModule: (label: string, code: string) => GPUShaderModule,
    createTexture: (desc: GPUTextureDescriptor) => GPUTexture,
  ) {
    this.size = size;
    this.texture = createTexture({ label: 'cockpit.sunMap', format: SUN_MAP_FORMAT, size: [size, size], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.view = this.texture.createView();
    this.xf = device.createBuffer({ label: 'cockpit.sunMap.xf', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({
      label: 'cockpit.sunMap',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'cockpit.sunMap',
      layout: device.createPipelineLayout({ label: 'cockpit.sunMap', bindGroupLayouts: [this.layout] }),
      vertex: {
        module: createModule('cockpit.sunMap', SUNMAP_WGSL),
        entryPoint: 'vs',
        buffers: [{ arrayStride: VERTEX_STRIDE, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }, { shaderLocation: 6, format: 'uint16x2', offset: 44 }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SUN_MAP_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  /** Bind group of a model's control buffer for this map. */
  group(controls: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'cockpit.sunMap',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.xf } },
        { binding: 1, resource: { buffer: controls } },
      ],
    });
  }

  /** Render the given index ranges of a model into the map with transform t. */
  render(encoder: GPUCommandEncoder, t: SunMapTransform, group: GPUBindGroup, vertex: GPUBuffer, index: GPUBuffer, ranges: { start: number; count: number }[], timestampWrites?: GPURenderPassTimestampWrites): void {
    this.xfData.set([...t.u, ...t.v, ...t.l]);
    this.device.queue.writeBuffer(this.xf, 0, this.xfData);
    const pass = encoder.beginRenderPass({
      label: 'cockpit.sunMap',
      colorAttachments: [],
      depthStencilAttachment: { view: this.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, vertex);
    pass.setIndexBuffer(index, 'uint32');
    for (const r of ranges) if (r.count > 0) pass.drawIndexed(r.count, 1, r.start);
    pass.end();
  }

  dispose(): void {
    this.texture.destroy();
    this.xf.destroy();
  }
}
