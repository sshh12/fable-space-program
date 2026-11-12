/**
 * The flood lights' shadow maps: one perspective depth map per lamp, seen from the middle of its lens along
 * the lens normal over the whole of its beam (shaders.ts floodBeam: nothing beyond LAMP_HALF_ANGLE), into one
 * layer of a depth array. The casters are the cabin's own parts at full detail without the enclosure (the
 * wall, the floor and the blankets receive, nothing lies behind them), in the capsule part frame, so a map is
 * valid until a control moves: the layers are rendered at start and again, one per frame, after a switch
 * lever, a guard or a hand controller has moved.
 *
 * Read by the cabin shaders (cabinLight: lampVisibility) in place of the per-vertex baked visibility of the
 * floods: a lever, a guard, a strap, a bag, the console itself throw their own shadows, and what stands on a
 * wall sits in a contact shadow on the side away from the lamp. The baked visibility remains the test of
 * whether a lamp can reach a surface at all (a pixel no vertex of whose triangle sees the lamp is not looked
 * up).
 */
import { mat4, v3, type Mat4, type Vec3 } from '@/core/math';
import type { FloodMeta } from './cabin/context';
import { MAX_FLOODS } from './layout';
import { VERTEX_STRIDE } from './mesh';
import { LAMP_HALF_ANGLE, LAMP_NEAR, LAMPMAP_WGSL } from './shaders';

export { LAMP_HALF_ANGLE, LAMP_NEAR };

export const LAMP_MAP_FORMAT: GPUTextureFormat = 'depth32float';
/** Far plane (m): beyond the cabin's largest dimension. */
export const LAMP_FAR = 6;

/**
 * Part frame -> clip space of a lamp's map (column-major; depth 0 at LAMP_NEAR .. 1 at LAMP_FAR, standard
 * perspective): the eye at the middle of the lens, looking along the lens normal, the lens's long axis across.
 */
export function lampMatrix(f: FloodMeta): Mat4 {
  const eye = v3.scale(v3.add(f.p0, f.p1), 0.5);
  const fwd = v3.normalize(f.n);
  const right = v3.normalize(v3.reject(v3.sub(f.p1, f.p0), fwd));
  const up = v3.cross(right, fwd);
  const t = 1 / Math.tan(LAMP_HALF_ANGLE);
  const a = LAMP_FAR / (LAMP_FAR - LAMP_NEAR);
  const b = -LAMP_NEAR * a;
  // Rows: x = t right.(p - eye), y = t up.(p - eye), z = a fwd.(p - eye) + b, w = fwd.(p - eye).
  const row = (s: number, d: Vec3, c: number): [number, number, number, number] => [s * d.x, s * d.y, s * d.z, -s * v3.dot(d, eye) + c];
  const rx = row(t, right, 0);
  const ry = row(t, up, 0);
  const rz = row(a, fwd, b);
  const rw = row(1, fwd, 0);
  const m = mat4.identity();
  for (let c = 0; c < 4; c++) {
    m[4 * c] = rx[c]!;
    m[4 * c + 1] = ry[c]!;
    m[4 * c + 2] = rz[c]!;
    m[4 * c + 3] = rw[c]!;
  }
  return m;
}

/** A part-frame point in a lamp's map: uv (0..1, v down), depth 0..1 and the distance along the lens normal. */
export function lampProject(m: Mat4, p: Vec3): { u: number; v: number; depth: number; w: number } {
  const c = mat4.transformPoint(m, p);
  return { u: 0.5 + (0.5 * c.x) / c.w, v: 0.5 - (0.5 * c.y) / c.w, depth: c.z / c.w, w: c.w };
}

const SLOT_BYTES = 256;

export class CabinLampMaps {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: number;
  readonly layers: number;
  private readonly layerViews: GPUTextureView[] = [];
  private readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  private readonly xf: GPUBuffer;

  constructor(
    private readonly device: GPUDevice,
    size: number,
    createModule: (label: string, code: string) => GPUShaderModule,
    createTexture: (desc: GPUTextureDescriptor) => GPUTexture,
  ) {
    this.size = size;
    this.layers = MAX_FLOODS;
    this.texture = createTexture({ label: 'cockpit.lampMaps', format: LAMP_MAP_FORMAT, size: [size, size, this.layers], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.view = this.texture.createView({ dimension: '2d-array' });
    for (let i = 0; i < this.layers; i++) this.layerViews.push(this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    this.xf = device.createBuffer({ label: 'cockpit.lampMaps.xf', size: this.layers * SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({
      label: 'cockpit.lampMaps',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'cockpit.lampMaps',
      layout: device.createPipelineLayout({ label: 'cockpit.lampMaps', bindGroupLayouts: [this.layout] }),
      vertex: {
        module: createModule('cockpit.lampMaps', LAMPMAP_WGSL),
        entryPoint: 'vs',
        buffers: [{ arrayStride: VERTEX_STRIDE, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }, { shaderLocation: 6, format: 'uint16x2', offset: 44 }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Slope-scaled: a caster the light grazes is pushed back by what its depth changes across a texel.
      depthStencil: { format: LAMP_MAP_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 0, depthBiasSlopeScale: 1.75 },
    });
  }

  /** Bind group of a model's control buffer for these maps. */
  group(controls: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'cockpit.lampMaps',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.xf, offset: 0, size: 64 } },
        { binding: 1, resource: { buffer: controls } },
      ],
    });
  }

  /** The lamps' matrices (lampMatrix), written once per model before its layers are rendered. */
  setLamps(matrices: readonly Mat4[]): void {
    const data = new Float32Array((this.layers * SLOT_BYTES) / 4);
    matrices.slice(0, this.layers).forEach((m, i) => data.set(m, (i * SLOT_BYTES) / 4));
    this.device.queue.writeBuffer(this.xf, 0, data);
  }

  /** Render the casters (index ranges of a model) into one lamp's layer. */
  render(encoder: GPUCommandEncoder, lamp: number, group: GPUBindGroup, vertex: GPUBuffer, index: GPUBuffer, ranges: { start: number; count: number }[], timestampWrites?: GPURenderPassTimestampWrites): void {
    const pass = encoder.beginRenderPass({
      label: `cockpit.lampMap.${lamp}`,
      colorAttachments: [],
      depthStencilAttachment: { view: this.layerViews[lamp]!, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, vertex);
    pass.setIndexBuffer(index, 'uint32');
    pass.setBindGroup(0, group, [lamp * SLOT_BYTES]);
    for (const r of ranges) if (r.count > 0) pass.drawIndexed(r.count, 1, r.start);
    pass.end();
  }

  dispose(): void {
    this.texture.destroy();
    this.xf.destroy();
  }
}
