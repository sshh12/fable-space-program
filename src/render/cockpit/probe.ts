/**
 * The cabin probe: the lit interior seen from the cabin's centre, in the capsule part frame, as a small cube
 * map with blurred mips. Re-rendered every frame the cabin is drawn (the outside-near detail level, the
 * displays and what comes in through the windows; diffuse light only), it gives the interior what a
 * constant ambient term cannot:
 *
 *  - reflections: every glossy and metallic surface, the window panes and the cover glasses look up the
 *    cabin along their reflected ray (parallax-corrected against the cabin's cone, shaders.ts
 *    cabinProbeAt), so a frame next to a window shows the bright window and the dark console;
 *  - bounce light with a direction: nine spherical-harmonic coefficients of the luminance of the probe's
 *    reflecting surfaces (the interior shader's cabinBounce), fed back into the next frame's probe, so the
 *    inter-reflection converges over a few frames and normals and detail maps shade.
 *
 * One render pass (the six faces side by side in an atlas, 'cockpit.probe') and one compute pass (atlas ->
 * cube level 0, the blurred levels, the coefficients; 'cockpit.probeFilter').
 */
import { v3, type Vec3 } from '@/core/math';
import { AMBIENT_VEC4S, PROBE_MIPS_WGSL, PROBE_SCALE, PROBE_SH_WGSL } from './shaders';

export const PROBE_FORMAT: GPUTextureFormat = 'rgba16float';
export const PROBE_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Cube faces in WebGPU's order (+X, -X, +Y, -Y, +Z, -Z): forward, right and up of the camera that fills each. */
export const PROBE_FACES: readonly { f: Vec3; r: Vec3; u: Vec3 }[] = [
  { f: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: -1 }, u: { x: 0, y: 1, z: 0 } },
  { f: { x: -1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 1 }, u: { x: 0, y: 1, z: 0 } },
  { f: { x: 0, y: 1, z: 0 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: -1 } },
  { f: { x: 0, y: -1, z: 0 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 } },
  { f: { x: 0, y: 0, z: 1 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 } },
  { f: { x: 0, y: 0, z: -1 }, r: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 } },
];

/**
 * View-projection of one cube face (column-major mat4, part frame -> clip; 90 degree field of view, depth
 * 0 at `near` .. 1 at `far`) for a probe at `centre`.
 */
export function probeFaceMatrix(face: number, centre: Vec3, near: number, far: number): Float32Array {
  const { f, r, u } = PROBE_FACES[face]!;
  const k = far / (far - near);
  const m = new Float32Array(16);
  const row = (i: number, a: Vec3, scale: number, w: number): void => {
    m[i] = a.x * scale;
    m[4 + i] = a.y * scale;
    m[8 + i] = a.z * scale;
    m[12 + i] = w;
  };
  row(0, r, 1, -v3.dot(r, centre));
  row(1, u, 1, -v3.dot(u, centre));
  row(2, f, k, -k * v3.dot(f, centre) - k * near);
  row(3, f, 1, -v3.dot(f, centre));
  return m;
}

/** Direction of a face's texel centre (uv with (0, 0) at the top left), as the shaders' cubeDir. */
export function probeDirection(face: number, u: number, v: number): Vec3 {
  const { f, r, u: up } = PROBE_FACES[face]!;
  return v3.normalize(v3.add(f, v3.add(v3.scale(r, 2 * u - 1), v3.scale(up, 1 - 2 * v))));
}

/** Texels of a cube face per texel of the bounce map (one work group of the copy pass). */
export const PROBE_BOUNCE_BLOCK = 8;

/**
 * Atlas -> cube level 0, and the bounce map: per 8 x 8 block of a face the mean luminance of its reflecting
 * surfaces (rgb x alpha, summed by the work group that copies the block), which the coefficient pass
 * integrates. Group 0: the atlas, the level to write, the bounce map.
 */
const PROBE_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var bounce: texture_storage_2d_array<rgba16float, write>;
var<workgroup> part: array<vec3f, ${PROBE_BOUNCE_BLOCK * PROBE_BOUNCE_BLOCK}>;
@compute @workgroup_size(${PROBE_BOUNCE_BLOCK}, ${PROBE_BOUNCE_BLOCK}, 1) fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let size = textureDimensions(dst);
  let c = textureLoad(atlas, vec2u((id.z % 3u) * size.x + id.x, (id.z / 3u) * size.y + id.y), 0);
  textureStore(dst, id.xy, id.z, c);
  part[li] = c.rgb * c.a;
  workgroupBarrier();
  if (li == 0u) {
    var sum = vec3f(0.0);
    for (var k = 0u; k < ${PROBE_BOUNCE_BLOCK * PROBE_BOUNCE_BLOCK}u; k++) { sum += part[k]; }
    textureStore(bounce, wg.xy, wg.z, vec4f(sum / ${PROBE_BOUNCE_BLOCK * PROBE_BOUNCE_BLOCK}.0, 1.0));
  }
}
`;

export interface ProbeDraw {
  /** Frame bind group and the cabin group with the black stand-in cube at the probe's binding. */
  frameGroup: GPUBindGroup;
  cabinGroup: GPUBindGroup;
  centre: Vec3;
  /** Draws the cabin into the current face (pipelines and buffers are the feature's). */
  draw(pass: GPURenderPassEncoder): void;
  /** The cabin's ambient buffer the coefficients are written to. */
  shGroup: GPUBindGroup;
  timestamps?: { render?: GPURenderPassTimestampWrites; filter?: GPUComputePassTimestampWrites };
}

export class CabinProbe {
  readonly size: number;
  readonly levels: number;
  readonly cube: GPUTexture;
  /** The probe as the cabin shaders sample it, and a black cube for the pass that renders it. */
  readonly view: GPUTextureView;
  readonly blackView: GPUTextureView;
  readonly faceLayout: GPUBindGroupLayout;
  private readonly black: GPUTexture;
  private readonly bounce: GPUTexture;
  private readonly atlas: GPUTexture;
  private readonly atlasView: GPUTextureView;
  private readonly depth: GPUTexture;
  private readonly depthView: GPUTextureView;
  private readonly faces: GPUBuffer;
  private readonly faceGroups: GPUBindGroup[] = [];
  private readonly params: GPUBuffer;
  private readonly copyPipe: GPUComputePipeline;
  private readonly copyGroup: GPUBindGroup;
  private readonly mipPipe: GPUComputePipeline;
  private readonly mipGroups: GPUBindGroup[] = [];
  private readonly shPipe: GPUComputePipeline;
  private readonly shLayout: GPUBindGroupLayout;
  private centre: Vec3 | null = null;
  private warm = 0;

  constructor(
    private readonly device: GPUDevice,
    size: number,
    createModule: (label: string, code: string) => GPUShaderModule,
    createTexture: (desc: GPUTextureDescriptor) => GPUTexture,
  ) {
    if (size % PROBE_BOUNCE_BLOCK !== 0) throw new Error(`cockpit probe: face size ${size} is not a multiple of ${PROBE_BOUNCE_BLOCK}`);
    this.size = size;
    // Down to 4 x 4 faces: below that a level says no more than the coefficients do.
    this.levels = Math.max(1, Math.round(Math.log2(size)) - 1);
    this.cube = createTexture({
      label: 'cockpit.probe',
      format: PROBE_FORMAT,
      size: [size, size, 6],
      mipLevelCount: this.levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.view = this.cube.createView({ dimension: 'cube' });
    this.black = createTexture({ label: 'cockpit.probe.black', format: PROBE_FORMAT, size: [1, 1, 6], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.blackView = this.black.createView({ dimension: 'cube' });
    this.bounce = createTexture({
      label: 'cockpit.probe.bounce',
      format: PROBE_FORMAT,
      size: [size / PROBE_BOUNCE_BLOCK, size / PROBE_BOUNCE_BLOCK, 6],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.atlas = createTexture({ label: 'cockpit.probe.atlas', format: PROBE_FORMAT, size: [3 * size, 2 * size], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.atlasView = this.atlas.createView();
    this.depth = createTexture({ label: 'cockpit.probe.depth', format: PROBE_DEPTH_FORMAT, size: [3 * size, 2 * size], usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthView = this.depth.createView();

    this.faceLayout = device.createBindGroupLayout({ label: 'cockpit.probe.face', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this.faces = device.createBuffer({ label: 'cockpit.probe.faces', size: 6 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    for (let i = 0; i < 6; i++) {
      this.faceGroups.push(device.createBindGroup({ label: `cockpit.probe.face${i}`, layout: this.faceLayout, entries: [{ binding: 0, resource: { buffer: this.faces, offset: i * 256, size: 64 } }] }));
    }
    this.params = device.createBuffer({ label: 'cockpit.probe.params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const level = (m: number, dimension: GPUTextureViewDimension): GPUTextureView => this.cube.createView({ dimension, baseMipLevel: m, mipLevelCount: 1 });
    this.copyPipe = device.createComputePipeline({ label: 'cockpit.probe.copy', layout: 'auto', compute: { module: createModule('cockpit.probe.copy', PROBE_COPY_WGSL), entryPoint: 'main' } });
    this.copyGroup = device.createBindGroup({
      label: 'cockpit.probe.copy',
      layout: this.copyPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.atlasView },
        { binding: 1, resource: level(0, '2d-array') },
        { binding: 2, resource: this.bounce.createView({ dimension: '2d-array' }) },
      ],
    });
    this.mipPipe = device.createComputePipeline({ label: 'cockpit.probe.mips', layout: 'auto', compute: { module: createModule('cockpit.probe.mips', PROBE_MIPS_WGSL), entryPoint: 'main' } });
    const sampler = device.createSampler({ label: 'cockpit.probe', magFilter: 'linear', minFilter: 'linear' });
    for (let m = 1; m < this.levels; m++) {
      this.mipGroups.push(
        device.createBindGroup({
          label: `cockpit.probe.mip${m}`,
          layout: this.mipPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: level(m - 1, 'cube') },
            { binding: 1, resource: sampler },
            { binding: 2, resource: level(m, '2d-array') },
          ],
        }),
      );
    }
    this.shLayout = device.createBindGroupLayout({
      label: 'cockpit.probe.sh',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.shPipe = device.createComputePipeline({
      label: 'cockpit.probe.sh',
      layout: device.createPipelineLayout({ label: 'cockpit.probe.sh', bindGroupLayouts: [this.shLayout] }),
      compute: { module: createModule('cockpit.probe.sh', PROBE_SH_WGSL), entryPoint: 'main' },
    });
  }

  /** Bind group of the coefficient pass for a cabin ambient buffer (AMBIENT_VEC4S vec4). */
  shGroup(ambient: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'cockpit.probe.sh',
      layout: this.shLayout,
      entries: [
        { binding: 0, resource: this.bounce.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: { buffer: ambient, size: AMBIENT_VEC4S * 16 } },
        { binding: 2, resource: { buffer: this.params } },
      ],
    });
  }

  /** Forget the probe's history (another cabin, or the cabin was not drawn for a while). */
  reset(): void {
    this.warm = 0;
  }

  /** Which half of the faces the last frame rendered (0: faces 0..2, 1: faces 3..5). */
  private half = 1;

  /**
   * Render the faces and filter them: the probe and the bounce coefficients are current after this. The first
   * frames render all six faces; after that three faces a frame, the two halves in turn (the cabin's light
   * changes slowly, and the cabin is closed: every texel of a face is drawn again when its half comes round,
   * so the other half is simply kept). The filter runs every frame over the whole cube.
   */
  render(encoder: GPUCommandEncoder, d: ProbeDraw): void {
    const S = this.size;
    if (!this.centre || v3.dist(this.centre, d.centre) > 1e-6) {
      this.centre = d.centre;
      const data = new Float32Array(6 * 64);
      for (let i = 0; i < 6; i++) data.set(probeFaceMatrix(i, d.centre, 0.03, 8), i * 64);
      this.device.queue.writeBuffer(this.faces, 0, data);
      this.warm = 0;
    }
    // The coefficients feed the next frame's probe: the first frames take the new value outright (the
    // inter-reflection builds up bounce by bounce), later ones are filtered a little against flicker.
    this.device.queue.writeBuffer(this.params, 0, new Float32Array([1 / PROBE_SCALE, this.warm < 12 ? 1 : 0.5, 0, 0]));
    const all = this.warm < 2;
    this.warm++;
    this.half = all ? 1 : 1 - this.half;
    const firstFace = all ? 0 : this.half * 3;
    const faceCount = all ? 6 : 3;
    const pass = encoder.beginRenderPass({
      label: 'cockpit.probe',
      colorAttachments: [{ view: this.atlasView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: all ? 'clear' : 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      ...(d.timestamps?.render ? { timestampWrites: d.timestamps.render } : {}),
    });
    pass.setBindGroup(0, d.frameGroup);
    pass.setBindGroup(1, d.cabinGroup);
    for (let i = firstFace; i < firstFace + faceCount; i++) {
      pass.setViewport((i % 3) * S, Math.floor(i / 3) * S, S, S, 0, 1);
      pass.setScissorRect((i % 3) * S, Math.floor(i / 3) * S, S, S);
      pass.setBindGroup(2, this.faceGroups[i]!);
      d.draw(pass);
    }
    pass.end();
    const filter = encoder.beginComputePass({ label: 'cockpit.probeFilter', ...(d.timestamps?.filter ? { timestampWrites: d.timestamps.filter } : {}) });
    filter.setPipeline(this.copyPipe);
    filter.setBindGroup(0, this.copyGroup);
    filter.dispatchWorkgroups(Math.ceil(S / 8), Math.ceil(S / 8), 6);
    filter.setPipeline(this.mipPipe);
    for (let m = 1; m < this.levels; m++) {
      const s = Math.max(1, S >> m);
      filter.setBindGroup(0, this.mipGroups[m - 1]!);
      filter.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
    }
    filter.setPipeline(this.shPipe);
    filter.setBindGroup(0, d.shGroup);
    filter.dispatchWorkgroups(1);
    filter.end();
  }

  dispose(): void {
    this.cube.destroy();
    this.black.destroy();
    this.bounce.destroy();
    this.atlas.destroy();
    this.depth.destroy();
    this.faces.destroy();
    this.params.destroy();
  }
}
