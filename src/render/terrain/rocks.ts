/**
 * Rock field: the instances of terrain-core's RockField around the LOD observers, drawn as instanced
 * procedural meshes into the G-buffer and the near shadow cascades (body-fixed casters).
 *
 * Rocks are gathered per chunk (a cube-sphere tile of about 40 m), each chunk with the smallest rock size
 * that can still cover `rockMinPixels` on screen at the chunk's distance. A rock is visible out to
 * radius x rangePerRadius (at most rockRangeM) and grows from nothing over the outer 30 % of that range,
 * so neither a rock nor a chunk ever pops in. A collidable rock is the ellipsoidal cap of the height
 * function: its mesh is the unit rock (a polyhedron around the unit ball, rockMesh.ts) scaled by the cap's
 * radius and height, centred on the base point: the lower part of the block is in the ground. The rock
 * carries the near layer of the set's rock material, triplanar in its own axes.
 */
import type { BodyDef } from '@/core/contracts/defs';
import { MATERIAL_ID, RENDER_FORMATS, type FrameContext, type RenderContext, type ShadowCascadeView } from '@/core/contracts/render';
import { dirToTile, tileUvToDir, type TileKey } from '@/core/geo/cubeSphere';
import { hash4, hashToUnit, mat3, quat, v3, type Mat3, type Vec3 } from '@/core/math';
import { coreOf, type Tracked } from '@/render/core';
import type { TerrainAuthority } from '@/terrain';
import type { MaterialSet, SurfaceParams } from './materials';
import type { LodObserverFixed } from './quadtree';
import { buildRockMesh, ROCK_LODS, ROCK_VARIANTS } from './rockMesh';
import { tileId } from './tileMath';

export interface RockBodyInfo {
  id: string;
  def: BodyDef;
  params: SurfaceParams;
  set: MaterialSet;
  /** Linear albedo of the body's low-resolution colour map at a body-fixed direction. */
  albedoAt: (dir: Vec3) => [number, number, number];
}

const ROCK_FLOATS = 16;
const MAX_ROCKS = 49152;
const MAX_CHUNKS = 1024;
const MAX_ROCK_INSTANCES = 1 << 17;
/** Chunk queries per frame are limited by time (ms). */
const BUILD_BUDGET_MS = 0.6;
/** Shadow cascades with texels larger than this hold no rocks. */
const SHADOW_MAX_TEXEL = 0.6;

const ROCK_WGSL = /* wgsl */ `
struct RockBody {
  rot: mat3x3f,
  prevRot: mat3x3f,
  p0: vec4f,       // range per metre of rock radius, largest range (m), material id, frame body index
  p1: vec4f,       // roughness, detail layer, detail tiling (1/m), unused
}
struct RockRecord {
  pos: vec4f,      // xyz = base point relative to the chunk origin (body-fixed, m), w = horizontal radius (m)
  q: vec4f,        // rock axes -> body-fixed (rock +Z = local up)
  misc: vec4f,     // vertical semi-axis (m), chunk slot, texture offset, elongation along the rock's x axis
  tint: vec4f,     // rgb = linear albedo
}
struct RockChunk { origin: vec4f, prevOrigin: vec4f }
@group(2) @binding(0) var<uniform> rockBody: RockBody;
@group(2) @binding(1) var<storage, read> rocks: array<RockRecord>;
@group(2) @binding(2) var<storage, read> chunks: array<RockChunk>;
@group(2) @binding(3) var<storage, read> rockInstances: array<u32>;

fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

struct RockVertex {
  local: vec3f,    // position in rock axes (m), after the range scale
  fixed: vec3f,    // offset from the chunk origin (body-fixed)
  pos: vec3f,      // camera-relative
  normal: vec3f,   // body-fixed
  rock: u32,
}
fn rockVertex(position: vec3f, normal: vec3f, instance: u32) -> RockVertex {
  let ri = rockInstances[instance];
  let r = rocks[ri];
  let c = chunks[u32(r.misc.y)];
  let centre = rockBody.rot * r.pos.xyz + c.origin.xyz;
  let range = min(r.pos.w * rockBody.p0.x, rockBody.p0.y);
  let grow = saturate((range - length(centre)) / (0.3 * range));
  let scale = vec3f(r.pos.w * r.misc.w, r.pos.w, r.misc.x);
  var o: RockVertex;
  o.local = position * scale * grow;
  o.fixed = quatRotate(r.q, o.local) + r.pos.xyz;
  o.pos = rockBody.rot * o.fixed + c.origin.xyz;
  o.normal = quatRotate(r.q, normalize(normal / scale));
  o.rock = ri;
  return o;
}
`;

const ROCK_GBUFFER_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"
${ROCK_WGSL}
@group(2) @binding(4) var detailA: texture_2d_array<f32>;
@group(2) @binding(5) var detailB: texture_2d_array<f32>;
@group(2) @binding(6) var<uniform> rockMean: vec4f;

struct RockVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec3f,
  @location(1) normal: vec3f,
  @location(2) currClip: vec4f,
  @location(3) prevClip: vec4f,
  @location(4) @interpolate(flat) rock: u32,
  @location(5) model: vec3f,
  @location(6) fixed: vec3f,
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32) -> RockVaryings {
  let v = rockVertex(position, normal, instance);
  let r = rocks[v.rock];
  let c = chunks[u32(r.misc.y)];
  var o: RockVaryings;
  o.position = frame.viewProj * vec4f(v.pos, 1.0);
  o.local = v.local;
  o.normal = v.normal;
  o.currClip = frame.viewProjUnjittered * vec4f(v.pos, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(rockBody.prevRot * v.fixed + c.prevOrigin.xyz, 1.0);
  o.rock = v.rock;
  o.model = position;
  o.fixed = v.fixed;
  return o;
}

@fragment fn fs(in: RockVaryings) -> GBufferOut {
  let r = rocks[in.rock];
  let layer = i32(rockBody.p1.y);
  // Triplanar rock texture in the rock's own axes (it turns with the rock), in metres.
  let p = (in.local + vec3f(r.misc.z)) * rockBody.p1.z;
  let dpx = dpdx(p);
  let dpy = dpdy(p);
  let nm = normalize(in.model);
  var w = pow(abs(nm), vec3f(6.0));
  w /= w.x + w.y + w.z;
  var ratio = vec3f(0.0);
  var grad = vec3f(0.0);
  var rough = 0.0;
  var ao = 0.0;
  for (var axis = 0; axis < 3; axis++) {
    var uv: vec2f; var dx: vec2f; var dy: vec2f; var au: vec3f; var av: vec3f;
    if (axis == 0) { uv = p.yz; dx = dpx.yz; dy = dpy.yz; au = vec3f(0.0, 1.0, 0.0); av = vec3f(0.0, 0.0, 1.0); }
    else if (axis == 1) { uv = p.zx; dx = dpx.zx; dy = dpy.zx; au = vec3f(0.0, 0.0, 1.0); av = vec3f(1.0, 0.0, 0.0); }
    else { uv = p.xy; dx = dpx.xy; dy = dpy.xy; au = vec3f(1.0, 0.0, 0.0); av = vec3f(0.0, 1.0, 0.0); }
    let a = textureSampleGrad(detailA, anisoRepeat, uv, layer, dx, dy);
    let b = textureSampleGrad(detailB, anisoRepeat, uv, layer, dx, dy);
    let nxy = b.rg * 2.0 - 1.0;
    let nz = sqrt(max(1.0 - dot(nxy, nxy), 0.04));
    ratio += w[axis] * a.rgb / max(rockMean.rgb, vec3f(1e-3));
    grad += w[axis] * (-nxy.x / nz * au - nxy.y / nz * av);
    rough += w[axis] * b.b;
    ao += w[axis] * b.a;
  }
  // Faces of a rock are flat: most of the shading normal is the face normal (from the position
  // derivatives), the rest the smooth vertex normal. Then the detail gradient (rock axes) perturbs it.
  let nv = normalize(in.normal);
  var face = cross(dpdx(in.fixed), dpdy(in.fixed));
  let fl = length(face);
  if (fl > 0.0) { face /= fl; } else { face = nv; }
  if (dot(face, nv) < 0.0) { face = -face; }
  let nf = normalize(mix(nv, face, 0.75));
  var g = quatRotate(r.q, grad);
  g -= nf * dot(g, nf);
  let n = rockBody.rot * normalize(nf - g);
  var albedo = r.tint.rgb * mix(vec3f(luminance(ratio)), ratio, 0.5);
  let id = u32(rockBody.p0.z);
  if (id == MATERIAL_REGOLITH) {
    // Level faces carry a film of the soil the rock sits in (the tint is the soil's colour, brightened).
    let dust = 0.55 * smoothstep(0.55, 0.95, dot(nf, quatRotate(r.q, vec3f(0.0, 0.0, 1.0))));
    albedo = mix(albedo, 0.8 * r.tint.rgb, dust);
  }
  albedo = clamp(albedo, vec3f(0.0), vec3f(1.0));
  // Contact shading: the part of the rock near the ground sees less sky.
  let contact = mix(0.45, 1.0, saturate(in.local.z / max(0.6 * r.misc.x, 1e-3)));
  // Rock is fresh material: on a regolith body the opposition surge is weaker than on mature soil. There
  // the metallic channel is the RMS slope (x 2) of the facets within a pixel (shaders/regolith.ts): a rock
  // face is pitted and granular below what its normal map holds.
  let regolith = id == MATERIAL_REGOLITH;
  let param = select(0.0, 1.0, regolith);
  return gbufferPack(albedo, ao * contact, n, mix(rockBody.p1.x, rough, 0.5), select(0.0, 0.24, regolith), id, param, velocityFromClip(in.currClip, in.prevClip), vec3f(0.0));
}
`;

const ROCK_SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${ROCK_WGSL}
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
  let v = rockVertex(position, normal, instance);
  return shadowPass.viewProj * vec4f(v.pos, 1.0);
}
`;

interface Chunk {
  key: TileKey;
  id: number;
  centre: Vec3;
  /** Chunk origin in the body-fixed frame (float64). */
  origin: Vec3;
  /** Half diagonal of the chunk on the ground, m. */
  reach: number;
  /** Rock records (ROCK_FLOATS each) and how many; the smallest rock radius they were gathered with. */
  data: Float32Array;
  count: number;
  minRadius: number;
  /** Radius of the chunk's largest rock, m (0 without rocks). */
  maxRadius: number;
  built: boolean;
  lastUsed: number;
  /** Offset of the chunk's rocks in the GPU rock buffer and its slot in the per-frame chunk buffer. */
  base: number;
  slot: number;
  /**
   * Rocks are stored by variant, largest first within a variant: variantStart[v] .. variantStart[v + 1] are
   * the rocks of variant v. A size threshold therefore selects a prefix of each variant's range.
   */
  variantStart: Int32Array;
  /** Distance from the camera to the nearest point of the chunk this frame, and to its centre, m. */
  near: number;
  far: number;
}

interface RockBody {
  info: RockBodyInfo;
  chunkLevel: number;
  chunkSize: number;
  chunks: Map<number, Chunk>;
  uniform: GPUBuffer;
  meanBuffer: GPUBuffer;
  group: GPUBindGroup;
  /** Disc of the height authority's data that is resident for rock queries, per observer slot. */
  loaded: ({ centre: Vec3; radius: number } | null)[];
  loading: boolean[];
  /** Instance ranges of this frame per (variant, lod), and of the shadow lists. */
  draws: Int32Array;
  active: boolean;
  bodyIndex: number;
  rot: Mat3;
  centre: Vec3;
  prevRot: Mat3;
  prevCentre: Vec3;
  rangePerRadius: number;
  /** Chunks in range of the observers (rebuilt when an observer has moved a quarter of a chunk). */
  wanted: Chunk[];
  scanned: Vec3[];
}

interface MeshBuffers {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

export class RockRenderer {
  private readonly device: GPUDevice;
  private readonly bodies: RockBody[] = [];
  private readonly meshes: MeshBuffers[] = [];
  private readonly gbuffer: Tracked<GPURenderPipeline>;
  private readonly shadow: Tracked<GPURenderPipeline>;
  private readonly layout: GPUBindGroupLayout;
  private readonly rockBuffer: GPUBuffer;
  private readonly chunkBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly rockData = new Float32Array(MAX_ROCKS * ROCK_FLOATS);
  private readonly chunkData = new Float32Array(MAX_CHUNKS * 8);
  private readonly instances = new Uint32Array(MAX_ROCK_INSTANCES);
  /** Instance lists under construction, per (variant, level of detail): indices into the rock buffer. */
  private bucketData: Uint32Array<ArrayBuffer>[] = Array.from({ length: ROCK_VARIANTS * ROCK_LODS }, () => new Uint32Array(1024));
  private readonly bucketCount = new Int32Array(ROCK_VARIANTS * ROCK_LODS);
  private readonly shadowRanges = new Int32Array(ROCK_VARIANTS * ROCK_LODS * 2);
  private readonly uniformData = new Float32Array(32);
  private instanceCount = 0;
  private dirty = false;
  private pending = 0;
  private frameIndex = 0;
  private triangles = 0;
  private overflow = false;
  private unbuilt = 0;
  private readonly freeSlots: number[] = Array.from({ length: MAX_CHUNKS }, (_, i) => MAX_CHUNKS - 1 - i);

  constructor(
    private readonly ctx: RenderContext,
    private readonly provider: TerrainAuthority,
    infos: RockBodyInfo[],
  ) {
    const device = (this.device = ctx.device);
    const core = coreOf(ctx);
    for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
      for (let lod = 0; lod < ROCK_LODS; lod++) {
        const m = buildRockMesh(variant, lod);
        const vertexBuffer = device.createBuffer({ label: `terrain.rock.${variant}.${lod}`, size: m.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(vertexBuffer, 0, m.vertices);
        const indexBuffer = device.createBuffer({ label: `terrain.rock.${variant}.${lod}.i`, size: Math.ceil(m.indices.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        // Buffer writes are whole 4-byte words: an odd number of 16-bit indices is padded (never drawn).
        const padded = m.indices.length % 2 === 0 ? m.indices : new Uint16Array(m.indices.length + 1);
        if (padded !== m.indices) padded.set(m.indices);
        device.queue.writeBuffer(indexBuffer, 0, padded);
        this.meshes.push({ vertexBuffer, indexBuffer, indexCount: m.indices.length });
      }
    }
    this.rockBuffer = device.createBuffer({ label: 'terrain.rocks', size: this.rockData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.chunkBuffer = device.createBuffer({ label: 'terrain.rockChunks', size: this.chunkData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.instanceBuffer = device.createBuffer({ label: 'terrain.rockInstances', size: this.instances.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'terrain.rocks',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 6, visibility: F, buffer: { type: 'uniform' } },
      ],
    });
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ],
    };
    const emptyLayout = device.createBindGroupLayout({ label: 'terrain.rocks.empty', entries: [] });
    this.emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] });
    this.gbuffer = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('terrain.rocks.gbuffer', ROCK_GBUFFER_WGSL);
      return device.createRenderPipeline({
        label: 'terrain.rocks.gbuffer',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, emptyLayout, this.layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            { format: RENDER_FORMATS.gbufferAlbedo },
            { format: RENDER_FORMATS.gbufferNormal },
            { format: RENDER_FORMATS.gbufferMaterial },
            { format: RENDER_FORMATS.gbufferVelocity },
            { format: RENDER_FORMATS.gbufferExtra },
            { format: RENDER_FORMATS.hdr },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
      });
    });
    this.shadow = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('terrain.rocks.shadow', ROCK_SHADOW_WGSL);
      return device.createRenderPipeline({
        label: 'terrain.rocks.shadow',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, core.shadowPassLayout, this.layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
        depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      });
    });
    this.gbuffer.get();
    this.shadow.get();

    for (const info of infos) {
      const faceSize = (Math.PI * info.def.radius) / 2;
      const chunkLevel = Math.max(0, Math.round(Math.log2(faceSize / 40)));
      const rockLayer = info.set.index.get(info.set.manifest.rockMaterial);
      if (rockLayer === undefined) throw new Error(`terrain material set "${info.set.manifest.id}": rockMaterial "${info.set.manifest.rockMaterial}" is not one of its materials`);
      const uniform = device.createBuffer({ label: `terrain.rocks.body.${info.id}`, size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const meanBuffer = device.createBuffer({ label: `terrain.rocks.mean.${info.id}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const mean = info.set.manifest.materials[rockLayer]!.layers[0].meanAlbedo;
      device.queue.writeBuffer(meanBuffer, 0, new Float32Array([mean[0], mean[1], mean[2], rockLayer]));
      const group = device.createBindGroup({
        label: `terrain.rocks.${info.id}`,
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.rockBuffer } },
          { binding: 2, resource: { buffer: this.chunkBuffer } },
          { binding: 3, resource: { buffer: this.instanceBuffer } },
          { binding: 4, resource: info.set.viewNearA },
          { binding: 5, resource: info.set.viewNearB },
          { binding: 6, resource: { buffer: meanBuffer } },
        ],
      });
      this.bodies.push({
        info,
        chunkLevel,
        chunkSize: faceSize / 2 ** chunkLevel,
        chunks: new Map(),
        uniform,
        meanBuffer,
        group,
        loaded: [null, null, null, null],
        loading: [false, false, false, false],
        draws: new Int32Array(ROCK_VARIANTS * ROCK_LODS * 2),
        active: false,
        bodyIndex: 0,
        rot: mat3.identity(),
        centre: v3.zero(),
        prevRot: mat3.identity(),
        prevCentre: v3.zero(),
        rangePerRadius: 0,
        wanted: [],
        scanned: [],
      });
    }
  }

  private readonly emptyGroup: GPUBindGroup;

  private buildChunk(b: RockBody, c: Chunk, minRadius: number): void {
    const id = b.info.id;
    const R = b.info.def.radius;
    const found = this.provider.rocksNear(id, c.centre, c.reach * 1.05, minRadius).filter((rock) => {
      const tile = dirToTile(rock.dir, b.chunkLevel).key;
      return tile.face === c.key.face && tile.x === c.key.x && tile.y === c.key.y;
    });
    // The height authority names six variants; the seed doubles them, so that neighbours of one variant differ.
    const shape = (rock: (typeof found)[number]): number => ((rock.variant % 6) + 6 * (hash4(rock.seed, 9, 0, 0) & 1)) % ROCK_VARIANTS;
    // By shape, largest first: a size threshold then selects a prefix of each shape.
    found.sort((p, q) => shape(p) - shape(q) || q.radius - p.radius);
    const out = new Float32Array(found.length * ROCK_FLOATS);
    const collideRadius = 0.25;
    const band = b.chunkSize / 2 ** (b.info.def.terrain!.maxRenderLevel - b.chunkLevel) / 32;
    const tint = b.info.albedoAt(c.centre);
    const scale = b.info.params.rockAlbedoScale;
    c.variantStart.fill(found.length);
    found.forEach((rock, n) => {
      const variant = shape(rock);
      for (let v = variant; v >= 0 && c.variantStart[v]! > n; v--) c.variantStart[v] = n;
      const u1 = hashToUnit(hash4(rock.seed, 1, 0, 0));
      const u2 = hashToUnit(hash4(rock.seed, 2, 0, 0));
      const u3 = hashToUnit(hash4(rock.seed, 3, 0, 0));
      // Vertical semi-axis: the cap the height function carries for a collidable rock, else from the seed.
      let cap = rock.radius * (0.4 + 0.4 * u1);
      if (rock.radius >= collideRadius) {
        const bump = this.provider.heightAt(id, rock.dir, band) - rock.baseHeight;
        if (bump > 0.1 * rock.radius) cap = bump;
      }
      const base = v3.scale(rock.dir, R + rock.baseHeight);
      // Rock axes: +Z along the local vertical, turned about it by the seed, tilted a little.
      const up = quat.fromTo({ x: 0, y: 0, z: 1 }, rock.dir);
      const yaw = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, u2 * 2 * Math.PI);
      const tilt = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, (u3 - 0.5) * 0.35);
      const q = quat.mul(up, quat.mul(yaw, tilt));
      const o = n * ROCK_FLOATS;
      out[o] = base.x - c.origin.x;
      out[o + 1] = base.y - c.origin.y;
      out[o + 2] = base.z - c.origin.z;
      out[o + 3] = rock.radius;
      out[o + 4] = q.x;
      out[o + 5] = q.y;
      out[o + 6] = q.z;
      out[o + 7] = q.w;
      out[o + 8] = cap;
      out[o + 9] = c.slot;
      out[o + 10] = u1 * 7;
      // Elongated along one horizontal axis (never narrower than the collision cap).
      out[o + 11] = 1 + 0.5 * hashToUnit(hash4(rock.seed, 4, 0, 0));
      const shade = scale * (0.85 + 0.3 * u3);
      out[o + 12] = Math.min(1, tint[0] * shade);
      out[o + 13] = Math.min(1, tint[1] * shade);
      out[o + 14] = Math.min(1, tint[2] * shade);
      out[o + 15] = variant;
    });
    c.data = out;
    c.count = found.length;
    c.minRadius = minRadius;
    c.maxRadius = found.reduce((m, rock) => Math.max(m, rock.radius), 0);
    c.built = true;
    this.dirty = true;
  }

  /** Ground height above the reference radius under a direction, m (coarse: for range decisions only). */
  private groundHeight(b: RockBody, dir: Vec3): number {
    return this.provider.heightAt(b.info.id, dir, 20);
  }

  /** The chunks within range of the observers that are near the ground (and the data loads they need). */
  private scanChunks(b: RockBody, observers: readonly LodObserverFixed[]): void {
    const range = b.info.params.rockRangeM;
    const R = b.info.def.radius;
    b.wanted.length = 0;
    b.scanned = observers.map((o) => o.pos);
    const seen = new Set<number>();
    observers.forEach((o, oi) => {
      if (oi >= 4) return;
      const ground = this.groundHeight(b, o.dir);
      if (o.r - R - ground > range) return;
      // Height data for the rock queries around this observer (pinned under its own slot).
      const loaded = b.loaded[oi];
      const groundPos = v3.scale(o.dir, R + ground);
      if (!b.loading[oi] && (!loaded || v3.dist(loaded.centre, groundPos) > 0.5 * range)) {
        b.loading[oi] = true;
        this.pending++;
        const radius = 2 * range;
        this.provider.ensureLoaded(b.info.id, o.dir, radius, `terrain-render:rocks:${oi}`).then(
          () => {
            b.loaded[oi] = { centre: groundPos, radius };
            b.loading[oi] = false;
            b.scanned = [];
            this.pending--;
          },
          (e: unknown) => {
            b.loading[oi] = false;
            this.pending--;
            coreOf(this.ctx).reportError(`terrain rocks: ${e instanceof Error ? e.message : String(e)}`);
          },
        );
      }
      if (!loaded) return;
      // Sample the tangent plane on a grid finer than the chunks; the tile under each sample is a chunk.
      const east = v3.normalize(v3.cross(Math.abs(o.dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, o.dir));
      const north = v3.cross(o.dir, east);
      const step = 0.5 * b.chunkSize;
      const steps = Math.ceil((range + b.chunkSize) / step);
      for (let j = -steps; j <= steps; j++) {
        for (let i = -steps; i <= steps; i++) {
          if (Math.hypot(i, j) * step > range + 2 * b.chunkSize) continue;
          const dir = v3.normalize(v3.add(v3.scale(o.dir, R), v3.add(v3.scale(east, i * step), v3.scale(north, j * step))));
          const key = dirToTile(dir, b.chunkLevel).key;
          const id = tileId(key.face, key.level, key.x, key.y);
          if (seen.has(id)) continue;
          seen.add(id);
          let c = b.chunks.get(id);
          if (!c) {
            const slot = this.freeSlots.pop();
            if (slot === undefined) continue;
            const centre = tileUvToDir(key, 0.5, 0.5);
            c = {
              key,
              id,
              centre,
              origin: v3.scale(centre, R + this.groundHeight(b, centre)),
              reach: 0.75 * b.chunkSize * 1.3,
              data: new Float32Array(0),
              count: 0,
              minRadius: Infinity,
              maxRadius: 0,
              built: false,
              lastUsed: -1,
              base: 0,
              slot,
              variantStart: new Int32Array(ROCK_VARIANTS + 1),
              near: 0,
              far: 0,
            };
            b.chunks.set(id, c);
          }
          // Only inside the disc whose height data is resident.
          if (v3.dist(c.origin, loaded.centre) + c.reach > loaded.radius) continue;
          b.wanted.push(c);
        }
      }
    });
  }

  prepare(frame: FrameContext, active: { id: string; bodyIndex: number; observers: readonly LodObserverFixed[] }[]): void {
    this.frameIndex = frame.frameIndex;
    this.instanceCount = 0;
    this.triangles = 0;
    this.unbuilt = 0;
    const t0 = performance.now();
    const pixelAngle = (2 * Math.tan(frame.camera.fovY / 2)) / frame.renderSize[1];
    for (const b of this.bodies) {
      const a = active.find((x) => x.id === b.info.id);
      b.active = false;
      if (!a) continue;
      const p = b.info.params;
      const pose = frame.bodies[a.bodyIndex]!;
      b.bodyIndex = a.bodyIndex;
      b.rot = mat3.fromQuat(pose.qFixedToRoot);
      b.prevRot = mat3.fromQuat(pose.prevQFixedToRoot);
      b.centre = pose.centerRelCam;
      b.prevCentre = pose.prevCenterRelCam;
      b.rangePerRadius = 2 / (Math.max(p.rockMinPixels, 0.5) * pixelAngle);
      const range = p.rockRangeM;

      // Which chunks are in range changes slowly: scan again when an observer has moved a quarter chunk.
      const moved = b.scanned.length !== a.observers.length || a.observers.some((o, i) => v3.dist(o.pos, b.scanned[i]!) > 0.25 * b.chunkSize);
      if (moved) this.scanChunks(b, a.observers);
      if (b.wanted.length === 0) continue;

      // Distances of this frame, and the chunks to build or refine (nearest first, within the time budget).
      let refine: Chunk[] | null = null;
      for (const c of b.wanted) {
        let near = Infinity;
        for (const o of a.observers) {
          const d = Math.max(0, v3.dist(c.origin, o.pos) - c.reach);
          if (d < near) near = d;
        }
        c.near = near;
        c.lastUsed = near <= range ? this.frameIndex : c.lastUsed;
        if (near > range) continue;
        const need = near / b.rangePerRadius;
        if (!c.built || c.minRadius > need * 1.05 + 1e-6) (refine ??= []).push(c);
      }
      if (refine) {
        refine.sort((x, y) => x.near - y.near);
        for (const c of refine) {
          if (performance.now() - t0 > BUILD_BUDGET_MS) {
            this.unbuilt++;
            continue;
          }
          // Well below what is needed now, so that the chunk is not rebuilt for every metre of approach.
          this.buildChunk(b, c, (c.near / b.rangePerRadius) * 0.6);
        }
      }
      // Forget chunks that have not been in range for a while.
      if (this.frameIndex % 120 === 0) {
        for (const [id, c] of b.chunks) {
          if (c.lastUsed < this.frameIndex - 600 && !b.wanted.includes(c)) {
            b.chunks.delete(id);
            this.freeSlots.push(c.slot);
            if (c.built) this.dirty = true;
          }
        }
      }
      b.active = true;

      // Chunk origins of this frame, relative to the camera.
      for (const c of b.wanted) {
        if (c.lastUsed !== this.frameIndex) continue;
        const g = c.origin;
        const m = b.rot;
        const q = b.prevRot;
        const o = c.slot * 8;
        const d = this.chunkData;
        d[o] = m[0] * g.x + m[1] * g.y + m[2] * g.z + b.centre.x;
        d[o + 1] = m[3] * g.x + m[4] * g.y + m[5] * g.z + b.centre.y;
        d[o + 2] = m[6] * g.x + m[7] * g.y + m[8] * g.z + b.centre.z;
        d[o + 4] = q[0] * g.x + q[1] * g.y + q[2] * g.z + b.prevCentre.x;
        d[o + 5] = q[3] * g.x + q[4] * g.y + q[5] * g.z + b.prevCentre.y;
        d[o + 6] = q[6] * g.x + q[7] * g.y + q[8] * g.z + b.prevCentre.z;
        c.far = Math.hypot(d[o]!, d[o + 1]!, d[o + 2]!);
      }
    }
    if (this.dirty) this.packRocks();
    for (const b of this.bodies) {
      if (!b.active) continue;
      this.buildDraws(b, pixelAngle);
      const u = this.uniformData;
      const m = b.rot;
      const pm = b.prevRot;
      u.set([m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0], 0);
      u.set([pm[0], pm[3], pm[6], 0, pm[1], pm[4], pm[7], 0, pm[2], pm[5], pm[8], 0], 12);
      const hapke = b.info.def.render.surface!.brdf === 'hapke';
      u.set([b.rangePerRadius, b.info.params.rockRangeM, hapke ? MATERIAL_ID.regolith : MATERIAL_ID.terrain, b.bodyIndex], 24);
      const rockLayer = b.info.set.index.get(b.info.set.manifest.rockMaterial)!;
      u.set([b.info.params.rockRoughness, rockLayer, 1 / b.info.params.detailScale0M, 0], 28);
      this.device.queue.writeBuffer(b.uniform, 0, u);
    }
    if (this.bodies.some((b) => b.active)) {
      this.device.queue.writeBuffer(this.chunkBuffer, 0, this.chunkData);
      if (this.instanceCount > 0) this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instances, 0, this.instanceCount);
    }
  }

  /** Lay every built chunk's rocks out in the GPU rock buffer. */
  private packRocks(): void {
    this.dirty = false;
    let n = 0;
    for (const b of this.bodies) {
      for (const c of b.chunks.values()) {
        if (!c.built) continue;
        if (n + c.count > MAX_ROCKS) {
          if (!this.overflow) {
            this.overflow = true;
            coreOf(this.ctx).reportError('terrain rocks: rock buffer is full; distant rocks are missing');
          }
          c.base = -1;
          continue;
        }
        c.base = n;
        this.rockData.set(c.data.subarray(0, c.count * ROCK_FLOATS), n * ROCK_FLOATS);
        n += c.count;
      }
    }
    if (n > 0) this.device.queue.writeBuffer(this.rockBuffer, 0, this.rockData, 0, n * ROCK_FLOATS);
  }

  /** Append the rock indices from .. to - 1 to a list. */
  private pushRange(bucket: number, from: number, to: number): void {
    const n = to - from;
    if (n <= 0) return;
    const count = this.bucketCount[bucket]!;
    let data = this.bucketData[bucket]!;
    if (count + n > data.length) {
      const grown = new Uint32Array(Math.max(2 * data.length, count + n));
      grown.set(data.subarray(0, count));
      this.bucketData[bucket] = data = grown;
    }
    for (let i = 0; i < n; i++) data[count + i] = from + i;
    this.bucketCount[bucket] = count + n;
  }

  /**
   * End of the prefix of a chunk's rocks start .. end - 1 (one variant, largest first) whose radius is at
   * least minRadius.
   */
  private static prefixEnd(data: Float32Array, start: number, end: number, minRadius: number): number {
    let lo = start;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid * ROCK_FLOATS + 3]! >= minRadius) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Move the lists built by pushRange into the instance buffer; returns nothing, fills `ranges` (start, count per list). */
  private flushBuckets(ranges: Int32Array): void {
    for (let k = 0; k < this.bucketCount.length; k++) {
      const count = Math.min(this.bucketCount[k]!, MAX_ROCK_INSTANCES - this.instanceCount);
      ranges[k * 2] = this.instanceCount;
      ranges[k * 2 + 1] = count;
      if (count > 0) this.instances.set(this.bucketData[k]!.subarray(0, count), this.instanceCount);
      this.instanceCount += count;
    }
  }

  /**
   * Instance lists of the G-buffer pass, per (variant, level of detail). A rock is in while it can cover
   * rockMinPixels: within a chunk that is a prefix of each variant's rocks (largest first), found with
   * the chunk's nearest distance; the vertex shader applies the exact per-rock range and scale. Only the
   * rocks large enough for a finer level of detail are walked one by one.
   */
  private buildDraws(b: RockBody, pixelAngle: number): void {
    this.bucketCount.fill(0);
    const range = b.info.params.rockRangeM;
    const rpr2 = b.rangePerRadius * b.rangePerRadius;
    const range2 = range * range;
    // Squared size thresholds of the levels of detail: (pixels)^2 = 4 r^2 / (d^2 pixelAngle^2).
    const k = 4 / (pixelAngle * pixelAngle);
    for (const c of b.wanted) {
      if (!c.built || c.base < 0 || c.lastUsed !== this.frameIndex || c.near >= range) continue;
      const d = c.data;
      const minRadius = c.near / b.rangePerRadius;
      if (c.maxRadius < minRadius) continue;
      // A rock below this radius is under the size of the middle level of detail even at the chunk's
      // nearest point: that tail of every variant's prefix goes to the coarse list as it stands (a rock
      // of it that lies beyond its own range is drawn with scale 0 by the vertex shader). Only the larger
      // rocks in front of it are looked at one by one.
      const coarseRadius = c.near * Math.sqrt(484 / k);
      // The camera in the chunk's own (body-fixed) axes: a rock's distance is then three subtractions.
      const slotBase = c.slot * 8;
      const ox = -this.chunkData[slotBase]!;
      const oy = -this.chunkData[slotBase + 1]!;
      const oz = -this.chunkData[slotBase + 2]!;
      const cx = b.rot[0] * ox + b.rot[3] * oy + b.rot[6] * oz;
      const cy = b.rot[1] * ox + b.rot[4] * oy + b.rot[7] * oz;
      const cz = b.rot[2] * ox + b.rot[5] * oy + b.rot[8] * oz;
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        const start = c.variantStart[v]!;
        const end = RockRenderer.prefixEnd(d, start, c.variantStart[v + 1]!, minRadius);
        if (end === start) continue;
        const fine = RockRenderer.prefixEnd(d, start, end, coarseRadius);
        for (let i = start; i < fine; i++) {
          const o = i * ROCK_FLOATS;
          const radius = d[o + 3]!;
          const dx = d[o]! - cx;
          const dy = d[o + 1]! - cy;
          const dz = d[o + 2]! - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const r2 = radius * radius;
          if (d2 >= r2 * rpr2 || d2 >= range2) continue;
          const pixels2 = (k * r2) / (d2 > 0.0025 ? d2 : 0.0025);
          this.pushRange(v * ROCK_LODS + (pixels2 > 8100 ? 0 : pixels2 > 484 ? 1 : 2), c.base + i, c.base + i + 1);
        }
        this.pushRange(v * ROCK_LODS + 2, c.base + fine, c.base + end);
      }
    }
    this.flushBuckets(b.draws);
    for (let j = 0; j < this.bucketCount.length; j++) this.triangles += (b.draws[j * 2 + 1]! * this.meshes[j]!.indexCount) / 3;
  }

  drawGBuffer(pass: GPURenderPassEncoder): void {
    let set = false;
    for (const b of this.bodies) {
      if (!b.active) continue;
      if (!set) {
        pass.setPipeline(this.gbuffer.get());
        pass.setBindGroup(1, this.emptyGroup);
        set = true;
      }
      pass.setBindGroup(2, b.group);
      for (let k = 0; k < ROCK_VARIANTS * ROCK_LODS; k++) {
        const count = b.draws[k * 2 + 1]!;
        if (count === 0) continue;
        const m = this.meshes[k]!;
        pass.setVertexBuffer(0, m.vertexBuffer);
        pass.setIndexBuffer(m.indexBuffer, 'uint16');
        pass.drawIndexed(m.indexCount, count, 0, 0, b.draws[k * 2]!);
      }
    }
  }

  /**
   * Rocks are body-fixed casters: they go into every cascade of their body that is fine enough to hold them.
   * Only rocks that are drawn cast: the lists are prefixes of the same chunks, and the vertex shader gives a
   * rock beyond its own range the same scale 0 as in the G-buffer.
   */
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView, bodyId: string): void {
    if (cascade.texelSize > SHADOW_MAX_TEXEL) return;
    const b = this.bodies.find((x) => x.info.id === bodyId);
    if (!b || !b.active) return;
    const m = cascade.viewProj;
    // A rock smaller than half a texel leaves no mark in the map.
    const texelRadius = 0.5 * cascade.texelSize;
    // The coarsest mesh that still has the silhouette at this texel size.
    const middleRadius = 24 * cascade.texelSize;
    const range = b.info.params.rockRangeM;
    const ndcPerMetre = 1 / (cascade.texelSize * 1024);
    const start0 = this.instanceCount;
    this.bucketCount.fill(0);
    for (const c of b.wanted) {
      if (!c.built || c.base < 0 || c.lastUsed !== this.frameIndex || c.near >= range) continue;
      const minRadius = Math.max(texelRadius, c.near / b.rangePerRadius);
      if (c.maxRadius < minRadius) continue;
      // The chunk against the cascade's rectangle (its casters reach a little beyond its own footprint).
      const o = c.slot * 8;
      const px = this.chunkData[o]!;
      const py = this.chunkData[o + 1]!;
      const pz = this.chunkData[o + 2]!;
      const margin = 1 + (c.reach + 4) * ndcPerMetre;
      if (Math.abs(m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) > margin || Math.abs(m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) > margin) continue;
      const d = c.data;
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        const start = c.variantStart[v]!;
        const end = RockRenderer.prefixEnd(d, start, c.variantStart[v + 1]!, minRadius);
        if (end === start) continue;
        const middle = RockRenderer.prefixEnd(d, start, end, middleRadius);
        this.pushRange(v * ROCK_LODS + 1, c.base + start, c.base + middle);
        this.pushRange(v * ROCK_LODS + 2, c.base + middle, c.base + end);
      }
    }
    const ranges = this.shadowRanges;
    this.flushBuckets(ranges);
    if (this.instanceCount === start0) return;
    this.device.queue.writeBuffer(this.instanceBuffer, start0 * 4, this.instances, start0, this.instanceCount - start0);
    pass.setPipeline(this.shadow.get());
    pass.setBindGroup(2, b.group);
    for (let k = 0; k < this.bucketCount.length; k++) {
      const count = ranges[k * 2 + 1]!;
      if (count === 0) continue;
      const mesh = this.meshes[k]!;
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint16');
      pass.drawIndexed(mesh.indexCount, count, 0, 0, ranges[k * 2]!);
    }
  }

  isIdle(): boolean {
    return this.pending === 0 && this.unbuilt === 0;
  }

  stats(): { instances: number; chunks: number; triangles: number } {
    return { instances: this.instanceCount, chunks: this.bodies.reduce((a, b) => a + b.chunks.size, 0), triangles: Math.round(this.triangles) };
  }

  dispose(): void {
    this.rockBuffer.destroy();
    this.chunkBuffer.destroy();
    this.instanceBuffer.destroy();
    for (const m of this.meshes) {
      m.vertexBuffer.destroy();
      m.indexBuffer.destroy();
    }
  }
}
