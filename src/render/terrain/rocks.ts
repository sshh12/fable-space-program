/**
 * Rock field: the instances of terrain-core's RockField around the LOD observers, drawn as instanced
 * procedural meshes into the G-buffer and the near shadow cascades (body-fixed casters).
 *
 * Rocks are gathered per chunk (a cube-sphere tile of about 40 m), each chunk with the smallest rock size
 * that can still cover `rockMinPixels` on screen at the chunk's distance. A rock is visible out to
 * radius x rangePerRadius (at most rockRangeM) and grows from nothing over the outer 30 % of that range,
 * so neither a rock nor a chunk ever pops in. A collidable rock is the ellipsoidal cap of the height
 * function: its mesh is the unit rock scaled by the cap's radius and height, centred on the base point.
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
  let albedo = clamp(r.tint.rgb * mix(vec3f(luminance(ratio)), ratio, 0.5), vec3f(0.0), vec3f(1.0));
  // Contact shading: the part of the rock near the ground sees less sky.
  let contact = mix(0.45, 1.0, saturate(in.local.z / max(0.6 * r.misc.x, 1e-3)));
  let id = u32(rockBody.p0.z);
  // Rock is fresh material: on a regolith body the opposition surge is weaker than on mature soil.
  let param = select(0.0, 1.0, id == MATERIAL_REGOLITH);
  return gbufferPack(albedo, ao * contact, n, mix(rockBody.p1.x, rough, 0.5), 0.0, id, param, velocityFromClip(in.currClip, in.prevClip), vec3f(0.0));
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
  built: boolean;
  lastUsed: number;
  /** Offset of the chunk's rocks in the GPU rock buffer and its slot in the per-frame chunk buffer. */
  base: number;
  slot: number;
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
  minRadius: number;
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
  private readonly buckets: number[][] = Array.from({ length: ROCK_VARIANTS * ROCK_LODS }, () => []);
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
        device.queue.writeBuffer(indexBuffer, 0, m.indices);
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
      const mean = info.set.manifest.materials[rockLayer]!.meanAlbedo;
      device.queue.writeBuffer(meanBuffer, 0, new Float32Array([mean[0], mean[1], mean[2], rockLayer]));
      const group = device.createBindGroup({
        label: `terrain.rocks.${info.id}`,
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.rockBuffer } },
          { binding: 2, resource: { buffer: this.chunkBuffer } },
          { binding: 3, resource: { buffer: this.instanceBuffer } },
          { binding: 4, resource: info.set.viewA },
          { binding: 5, resource: info.set.viewB },
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
        minRadius: 0,
      });
    }
  }

  private readonly emptyGroup: GPUBindGroup;

  private buildChunk(b: RockBody, c: Chunk, minRadius: number): void {
    const id = b.info.id;
    const R = b.info.def.radius;
    const found = this.provider.rocksNear(id, c.centre, c.reach * 1.05, minRadius);
    const out = new Float32Array(found.length * ROCK_FLOATS);
    let n = 0;
    const collideRadius = 0.25;
    const band = b.chunkSize / 2 ** (b.info.def.terrain!.maxRenderLevel - b.chunkLevel) / 32;
    const tint = b.info.albedoAt(c.centre);
    const scale = b.info.params.rockAlbedoScale;
    for (const rock of found) {
      const tile = dirToTile(rock.dir, b.chunkLevel).key;
      if (tile.face !== c.key.face || tile.x !== c.key.x || tile.y !== c.key.y) continue;
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
      out[o + 15] = rock.variant % ROCK_VARIANTS;
      const shade = scale * (0.85 + 0.3 * u3);
      out[o + 12] = Math.min(1, tint[0] * shade);
      out[o + 13] = Math.min(1, tint[1] * shade);
      out[o + 14] = Math.min(1, tint[2] * shade);
      n++;
    }
    c.data = out;
    c.count = n;
    c.minRadius = minRadius;
    c.built = true;
    this.dirty = true;
  }

  /** Ground height above the reference radius under a direction, m (coarse: for range decisions only). */
  private groundHeight(b: RockBody, dir: Vec3): number {
    return this.provider.heightAt(b.info.id, dir, 20);
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
      const R = b.info.def.radius;

      // Chunks within range of observers that are near the ground.
      const wanted: { c: Chunk; need: number }[] = [];
      a.observers.forEach((o, oi) => {
        if (oi >= 4) return;
        const ground = this.groundHeight(b, o.dir);
        const height = o.r - R - ground;
        if (height > range) return;
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
        const steps = Math.ceil(range / step);
        for (let j = -steps; j <= steps; j++) {
          for (let i = -steps; i <= steps; i++) {
            if (Math.hypot(i, j) * step > range + b.chunkSize) continue;
            const dir = v3.normalize(v3.add(v3.scale(o.dir, R), v3.add(v3.scale(east, i * step), v3.scale(north, j * step))));
            const key = dirToTile(dir, b.chunkLevel).key;
            const id = tileId(key.face, key.level, key.x, key.y);
            let c = b.chunks.get(id);
            if (!c) {
              const slot = this.freeSlots.pop();
              if (slot === undefined) continue;
              const centre = tileUvToDir(key, 0.5, 0.5);
              c = { key, id, centre, origin: v3.scale(centre, R + this.groundHeight(b, centre)), reach: 0.75 * b.chunkSize * 1.3, data: new Float32Array(0), count: 0, minRadius: Infinity, built: false, lastUsed: -1, base: 0, slot };
              b.chunks.set(id, c);
            }
            if (c.lastUsed === this.frameIndex) continue;
            c.lastUsed = this.frameIndex;
            // Only inside the disc whose height data is resident.
            if (v3.dist(c.origin, loaded.centre) + c.reach > loaded.radius) continue;
            const dist = Math.max(0, v3.dist(c.origin, o.pos) - c.reach);
            if (dist > range) continue;
            wanted.push({ c, need: dist / b.rangePerRadius });
          }
        }
      });
      // Build or refine chunks, nearest first, within the time budget.
      wanted.sort((x, y) => x.need - y.need);
      for (const w of wanted) {
        const c = w.c;
        if (c.built && c.minRadius <= w.need * 1.05 + 1e-6) continue;
        if (performance.now() - t0 > BUILD_BUDGET_MS) {
          this.unbuilt++;
          continue;
        }
        this.buildChunk(b, c, Math.max(0, w.need * 0.7));
      }
      // Forget chunks that have not been in range for a while.
      if (this.frameIndex % 120 === 0) {
        for (const [id, c] of b.chunks) {
          if (c.lastUsed < this.frameIndex - 600) {
            b.chunks.delete(id);
            this.freeSlots.push(c.slot);
            if (c.built) this.dirty = true;
          }
        }
      }
      b.active = wanted.length > 0;
      if (!b.active) continue;

      // Chunk origins of this frame.
      for (const w of wanted) {
        const c = w.c;
        const pc = mat3.mulVec(b.rot, c.origin);
        const qc = mat3.mulVec(b.prevRot, c.origin);
        this.chunkData.set([pc.x + b.centre.x, pc.y + b.centre.y, pc.z + b.centre.z, 0, qc.x + b.prevCentre.x, qc.y + b.prevCentre.y, qc.z + b.prevCentre.z, 0], c.slot * 8);
      }
    }
    if (this.dirty) this.packRocks();
    for (const b of this.bodies) {
      if (!b.active) continue;
      this.buildDraws(b, pixelAngle);
      const u = new Float32Array(32);
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

  private buildDraws(b: RockBody, pixelAngle: number): void {
    for (const bucket of this.buckets) bucket.length = 0;
    const camOrigin = b.centre;
    const range = b.info.params.rockRangeM;
    for (const c of b.chunks.values()) {
      if (!c.built || c.base < 0 || c.lastUsed !== this.frameIndex) continue;
      const co = mat3.mulVec(b.rot, c.origin);
      const ox = co.x + camOrigin.x;
      const oy = co.y + camOrigin.y;
      const oz = co.z + camOrigin.z;
      const d = c.data;
      for (let i = 0; i < c.count; i++) {
        const o = i * ROCK_FLOATS;
        // Rock position relative to the camera; the rotation of the small local offset is applied exactly in the shader.
        const lx = d[o]!;
        const ly = d[o + 1]!;
        const lz = d[o + 2]!;
        const px = ox + b.rot[0] * lx + b.rot[1] * ly + b.rot[2] * lz;
        const py = oy + b.rot[3] * lx + b.rot[4] * ly + b.rot[5] * lz;
        const pz = oz + b.rot[6] * lx + b.rot[7] * ly + b.rot[8] * lz;
        const dist = Math.hypot(px, py, pz);
        const radius = d[o + 3]!;
        if (dist >= Math.min(radius * b.rangePerRadius, range)) continue;
        const pixels = (2 * radius) / (Math.max(dist, 0.05) * pixelAngle);
        const lod = pixels > 90 ? 0 : pixels > 22 ? 1 : 2;
        this.buckets[d[o + 15]! * ROCK_LODS + lod]!.push(c.base + i);
      }
    }
    for (let k = 0; k < this.buckets.length; k++) {
      const bucket = this.buckets[k]!;
      const count = Math.min(bucket.length, MAX_ROCK_INSTANCES - this.instanceCount);
      b.draws[k * 2] = this.instanceCount;
      b.draws[k * 2 + 1] = count;
      for (let i = 0; i < count; i++) this.instances[this.instanceCount++] = bucket[i]!;
      this.triangles += (count * this.meshes[k]!.indexCount) / 3;
    }
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

  /** Rocks are body-fixed casters: they go into every cascade of their body that is fine enough to hold them. */
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView, bodyId: string): void {
    if (cascade.texelSize > SHADOW_MAX_TEXEL) return;
    const b = this.bodies.find((x) => x.info.id === bodyId);
    if (!b || !b.active) return;
    const m = cascade.viewProj;
    const minRadius = 0.5 * cascade.texelSize;
    const range = b.info.params.rockRangeM;
    const start0 = this.instanceCount;
    const ranges: number[] = [];
    // One list per variant, the coarsest mesh that still has the silhouette at this texel size.
    for (const bucket of this.buckets) bucket.length = 0;
    for (const c of b.chunks.values()) {
      if (!c.built || c.base < 0 || c.lastUsed !== this.frameIndex) continue;
      const co = mat3.mulVec(b.rot, c.origin);
      const ox = co.x + b.centre.x;
      const oy = co.y + b.centre.y;
      const oz = co.z + b.centre.z;
      const d = c.data;
      for (let i = 0; i < c.count; i++) {
        const o = i * ROCK_FLOATS;
        const radius = d[o + 3]!;
        if (radius < minRadius) continue;
        const lx = d[o]!;
        const ly = d[o + 1]!;
        const lz = d[o + 2]!;
        const px = ox + b.rot[0] * lx + b.rot[1] * ly + b.rot[2] * lz;
        const py = oy + b.rot[3] * lx + b.rot[4] * ly + b.rot[5] * lz;
        const pz = oz + b.rot[6] * lx + b.rot[7] * ly + b.rot[8] * lz;
        if (Math.hypot(px, py, pz) >= Math.min(radius * b.rangePerRadius, range)) continue;
        const cx = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
        const cy = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
        const margin = 1 + (2 * radius) / (cascade.texelSize * 1024);
        if (Math.abs(cx) > margin || Math.abs(cy) > margin) continue;
        const lod = radius > 24 * cascade.texelSize ? 1 : 2;
        this.buckets[d[o + 15]! * ROCK_LODS + lod]!.push(c.base + i);
      }
    }
    for (let k = 0; k < this.buckets.length; k++) {
      const bucket = this.buckets[k]!;
      const count = Math.min(bucket.length, MAX_ROCK_INSTANCES - this.instanceCount);
      ranges.push(this.instanceCount, count);
      for (let i = 0; i < count; i++) this.instances[this.instanceCount++] = bucket[i]!;
    }
    if (this.instanceCount === start0) return;
    this.device.queue.writeBuffer(this.instanceBuffer, start0 * 4, this.instances, start0, this.instanceCount - start0);
    pass.setPipeline(this.shadow.get());
    pass.setBindGroup(2, b.group);
    for (let k = 0; k < this.buckets.length; k++) {
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
