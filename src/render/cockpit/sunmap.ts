/**
 * The cabin's own sun shadow map: orthographic depth maps along the sun in the capsule part frame, one TILE
 * per window the sun enters, each fitted to the cross-section of that window's beam (the shared opening
 * seen along the sun, plus a margin for the penumbra). A beam is 0.2-0.6 m across, so a tile of the 2048^2
 * atlas resolves it at a few tenths of a millimetre: the shadow of a bezel or a housing on a panel the
 * light only grazes keeps a straight edge (a map over the whole cabin, 2 mm texels, drew such edges as
 * combs of stretched texels). Re-rendered every frame the sun reaches the cabin from the interior's
 * occluders at the drawn detail level (not the enclosure: the windows' analytic apertures bound the light
 * that enters). Sampled by the cabin shaders (SUN_WGSL in shaders.ts) with a blocker search and a fixed
 * grid of bilinear comparisons, so an edge has the penumbra of the real sun and no noise.
 *
 * Why not the core's cascade 0: inside the cabin the patch edges are judged from 0.4 to 1 m; the core's
 * general filter (12 taps rotated per pixel by blue noise, at least 1.5 texels of a 6 m cascade) leaves a
 * grainy band several centimetres wide there (request cockpit-4). The core's cascades still carry the
 * interior as a moving caster with its openings closed, so that the core's sun never lights the cabin.
 */
import { v3, type Vec3 } from '@/core/math';
import type { ApertureMeta } from './cabin/context';
import { MAX_WINDOWS } from './layout';
import { VERTEX_STRIDE } from './mesh';
import { SUNMAP_WGSL } from './shaders';

export const SUN_MAP_FORMAT: GPUTextureFormat = 'depth32float';
/** Margin of a tile around its window's beam (m): the widest filtered penumbra and the filter's reach. */
export const SUN_TILE_MARGIN = 0.02;

export interface SunTile {
  /** Index of the window (the model's window order). */
  window: number;
  /** Tile-local u, v = dot(axis, p_part) + w, both 0..1 over the tile. */
  u: [number, number, number, number];
  v: [number, number, number, number];
  /** Metres the tile spans along u and v. */
  spanU: number;
  spanV: number;
  /** The tile's place in the atlas. */
  col: number;
  row: number;
}

export interface SunMapLayout {
  tiles: SunTile[];
  /** Tiles per side of the atlas (1, 2 or 3). */
  perSide: number;
  /** depth = dot(xyz, p_part) + w, 0 at the sun side .. 1, shared by the tiles; and its range, m. */
  l: [number, number, number, number];
  range: number;
}

/** Whether the sun (unit direction to it, part frame) shines into a window with inward normal `inward`. */
export const sunEnters = (inward: Vec3, sunPart: Vec3): boolean => v3.dot(inward, sunPart) < -0.03;

/**
 * The tiles for the unit direction to the sun `sunPart` (part frame): one per window the sun enters, fitted
 * to the outer end of its aperture seen along the sun; depth over the sphere (centre, radius) that holds
 * the interior. Null when the sun enters no window.
 */
export function sunMapLayout(sunPart: Vec3, apertures: readonly ApertureMeta[], centre: Vec3, radius: number): SunMapLayout | null {
  const l = v3.neg(v3.normalize(sunPart));
  const lit = apertures.map((a, i) => ({ a, i })).filter(({ a }) => sunEnters(a.inward, sunPart)).slice(0, MAX_WINDOWS);
  if (lit.length === 0) return null;
  const perSide = Math.ceil(Math.sqrt(lit.length));
  const k = 1 / (2 * radius);
  const tiles = lit.map(({ a, i }, n): SunTile => {
    // Axes across the beam: the window's long axis seen along the sun, and its perpendicular.
    let u = v3.reject(a.g, l);
    if (v3.len(u) < 0.05) u = v3.reject(a.t, l);
    u = v3.normalize(u);
    const w = v3.cross(l, u);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const st of [-1, 1]) {
      for (const sg of [-1, 1]) {
        const p = v3.add(a.centre, v3.add(v3.scale(a.t, st * a.hw), v3.scale(a.g, sg * a.hh)));
        u0 = Math.min(u0, v3.dot(u, p));
        u1 = Math.max(u1, v3.dot(u, p));
        v0 = Math.min(v0, v3.dot(w, p));
        v1 = Math.max(v1, v3.dot(w, p));
      }
    }
    u0 -= SUN_TILE_MARGIN;
    u1 += SUN_TILE_MARGIN;
    v0 -= SUN_TILE_MARGIN;
    v1 += SUN_TILE_MARGIN;
    const spanU = u1 - u0;
    const spanV = v1 - v0;
    return {
      window: i,
      u: [u.x / spanU, u.y / spanU, u.z / spanU, -u0 / spanU],
      v: [w.x / spanV, w.y / spanV, w.z / spanV, -v0 / spanV],
      spanU,
      spanV,
      col: n % perSide,
      row: Math.floor(n / perSide),
    };
  });
  return { tiles, perSide, l: [l.x * k, l.y * k, l.z * k, 0.5 - v3.dot(l, centre) * k], range: 2 * radius };
}

/**
 * The shader's record of a tile (CabinFrame.sunTiles, three vec4): atlas u and v of a part-frame point,
 * then metres per unit of atlas u and v and the tile's first atlas u and v. tileUv = the tile's size in atlas
 * uv (CabinSunMap.tileUv).
 */
export function sunTileUniform(t: SunTile, tileUv: number): number[] {
  const s = tileUv;
  return [t.u[0] * s, t.u[1] * s, t.u[2] * s, (t.u[3] + t.col) * s, t.v[0] * s, t.v[1] * s, t.v[2] * s, (t.v[3] + t.row) * s, t.spanU / s, t.spanV / s, t.col * s, t.row * s];
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

/** Uniform slots of the tile transforms (one per tile of the largest atlas, 3 x 3). */
const SLOTS = 9;
const SLOT_BYTES = 256;

export class CabinSunMap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: number;
  private readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  private readonly xf: GPUBuffer;
  private readonly xfData = new Float32Array((SLOTS * SLOT_BYTES) / 4);

  constructor(
    private readonly device: GPUDevice,
    size: number,
    createModule: (label: string, code: string) => GPUShaderModule,
    createTexture: (desc: GPUTextureDescriptor) => GPUTexture,
  ) {
    this.size = size;
    this.texture = createTexture({ label: 'cockpit.sunMap', format: SUN_MAP_FORMAT, size: [size, size], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.view = this.texture.createView();
    this.xf = device.createBuffer({ label: 'cockpit.sunMap.xf', size: SLOTS * SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({
      label: 'cockpit.sunMap',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
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
      // Slope-scaled: a caster the light grazes (the panel that also receives the patch) is pushed back by
      // what its depth changes across a texel, so it does not shade itself.
      depthStencil: { format: SUN_MAP_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 0, depthBiasSlopeScale: 1.5 },
    });
  }

  /** Size of one tile in atlas uv for an atlas of perSide x perSide tiles (whole texels). */
  tileUv(perSide: number): number {
    return Math.floor(this.size / perSide) / this.size;
  }

  /** Bind group of a model's control buffer for this map. */
  group(controls: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'cockpit.sunMap',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.xf, offset: 0, size: 48 } },
        { binding: 1, resource: { buffer: controls } },
      ],
    });
  }

  /** Render the given index ranges of a model into every tile of the layout. */
  render(encoder: GPUCommandEncoder, t: SunMapLayout, group: GPUBindGroup, vertex: GPUBuffer, index: GPUBuffer, ranges: { start: number; count: number }[], timestampWrites?: GPURenderPassTimestampWrites): void {
    t.tiles.forEach((tile, i) => this.xfData.set([...tile.u, ...tile.v, ...t.l], (i * SLOT_BYTES) / 4));
    this.device.queue.writeBuffer(this.xf, 0, this.xfData, 0, (t.tiles.length * SLOT_BYTES) / 4);
    const pass = encoder.beginRenderPass({
      label: 'cockpit.sunMap',
      colorAttachments: [],
      depthStencilAttachment: { view: this.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, vertex);
    pass.setIndexBuffer(index, 'uint32');
    const T = Math.floor(this.size / t.perSide);
    t.tiles.forEach((tile, i) => {
      pass.setViewport(tile.col * T, tile.row * T, T, T, 0, 1);
      pass.setScissorRect(tile.col * T, tile.row * T, T, T);
      pass.setBindGroup(0, group, [i * SLOT_BYTES]);
      for (const r of ranges) if (r.count > 0) pass.drawIndexed(r.count, 1, r.start);
    });
    pass.end();
  }

  dispose(): void {
    this.texture.destroy();
    this.xf.destroy();
  }
}
