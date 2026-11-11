/**
 * createTerrainFeature: the terrain RenderFeature. For every body with BodyDef.terrain and a baked tile set
 * it runs the quadtree selection per LOD observer, streams tiles through the worker pool, and draws the
 * terrain, the far sea-level sheet and (rocks.ts) the rock field into the G-buffer and the sun shadow
 * cascades.
 */
import type { BodyDef, DefLibrary } from '@/core/contracts/defs';
import { MATERIAL_ID, RENDER_FORMATS, type BodyPose, type FrameContext, type RenderContext, type RenderFeature, type ShadowCascadeView } from '@/core/contracts/render';
import { TILE_LAYER, type TileManifest } from '@/core/contracts/terrain';
import { dirToTile, latLonToDir, type TileKey } from '@/core/geo/cubeSphere';
import { DEG, mat3, quat, v3, type Mat3, type Vec3 } from '@/core/math';
import { coreOf, MAX_BODIES, type SceneBindings, type Tracked } from '@/render/core';
import { createFetchTileSource, type TerrainAuthority } from '@/terrain';
import { createGridMesh, GRID_VERTEX_LAYOUT, type GridMesh } from './gridMesh';
import { loadLowResAlbedo, srgbToLinear } from './lowResAlbedo';
import { capMaxLevel, capMorph, GRID_QUADS, GRID_VERTS, levelRange, lodK, morphWindow, smooth01, warpLevelCap } from './lod';
import { buildMaterialUniform, createNoiseTexture, loadMaterialSet, readSurfaceParams, type MaterialSet, type SurfaceParams } from './materials';
import { BodyQuadtree, TILE_READY, type DrawItem, type LodObserverFixed, type SelectParams, type TileNode, type ViewFrustum } from './quadtree';
import { buildRecordConstants, resolveOwners, type PadDisc, type RecordContext } from './records';
import { RockRenderer } from './rocks';
import { BODY_UNIFORM_BYTES, MAX_OBSERVERS, RECORD_BYTES, RECORD_FLOATS, TERRAIN_SHADOW_WGSL } from './shaders/common';
import { MATERIAL_UNIFORM_FLOATS, TERRAIN_GBUFFER_WGSL, TERRAIN_WATER_WGSL } from './shaders/surface';
import { TileStreamer, type StreamBody, type StreamerOptions, type StreamStats } from './streamer';
import type { BoundSphere } from './tileMath';

/** Supplies the main-thread height authority (the one the simulation uses, so rocks and collision agree). */
export type TerrainProviderFactory = (ctx: RenderContext) => TerrainAuthority | Promise<TerrainAuthority>;

export interface TerrainFeatureOptions {
  id?: string;
  order?: number;
  streamer?: Partial<StreamerOptions>;
  /** Levels 0..pinLevel of every body are always resident (default 2). */
  pinLevel?: number;
  /** Levels up to this one are loaded ahead for a body the camera is within 16 radii of (default 3). */
  preloadLevel?: number;
  /** Draw the rock field (default true). */
  rocks?: boolean;
}

export interface TerrainBodyStats {
  /** Tiles (whole or by quadrants) of the last camera selection, and how many of them are in view. */
  selected: number;
  visible: number;
  waterTiles: number;
  /** Tiles drawn into shadow cascades this frame. */
  casters: number;
  deepestLevel: number;
  /** Fractional warp cap and the ground speed per wall-clock second it follows (m/s). */
  cap: number;
  groundSpeed: number;
  fading: number;
  nodes: number;
  K: number;
}

export interface TerrainDebug {
  /**
   * selectMs = CPU time of the frame's LOD selection (every body, what is drawn); prefetchMs = time of the
   * request-only passes that ran in the same frame (two frames in eight: 2 s ahead, predicted impact).
   */
  stats(): { stream: StreamStats; bodies: Record<string, TerrainBodyStats>; records: number; instances: number; selectMs: number; prefetchMs: number; rocks: { instances: number; chunks: number; triangles: number } };
  /** Delay every tile by `ms` between the worker and the upload (tests of late streaming). */
  setStreamDelay(ms: number): void;
  /**
   * Switch geomorphing and fade-ins off (tiles then pop in and out): the control experiment that shows the
   * pop detector of the browser specs is not blind. Never used by the app.
   */
  setMorphEnabled(on: boolean): void;
  /** Draw the rock field or not (performance attribution: the rocks' share is the difference). */
  setRocksEnabled(on: boolean): void;
  /** The main-thread height authority. */
  provider(): TerrainAuthority;
  /** READY tiles of a level, nearest to a point first (at most `limit`). */
  readyTiles(bodyId: string, level: number, latDeg: number, lonDeg: number, limit: number): TileKey[];
  /** Deepest READY tile containing a point, or null. */
  readyTileAt(bodyId: string, latDeg: number, lonDeg: number, maxLevel?: number): TileKey | null;
  /** Read back a READY tile's GPU data: 65 x 65 heights; and for tiles with image data the albedo (sRGB bytes, rgba) and aux (rg) texels. */
  readTile(bodyId: string, key: TileKey): Promise<{ heights: Float32Array; albedo: Uint8Array | null; aux: Uint8Array | null; normal: Uint8Array }>;
  /** Ids of the bodies drawn. */
  bodies(): string[];
}

export interface TerrainFeature extends RenderFeature {
  readonly debug: TerrainDebug;
}

interface BodyState {
  id: string;
  def: BodyDef;
  tree: BodyQuadtree;
  stream: StreamBody;
  recordCtx: RecordContext;
  params: SurfaceParams;
  set: MaterialSet;
  albedoAt: (dir: Vec3) => [number, number, number];
  materialBuffer: GPUBuffer;
  uniform: GPUBuffer;
  uniformData: Float32Array<ArrayBuffer>;
  tileGroup: GPUBindGroup;
  surfaceGroup: GPUBindGroup | null;
  surfaceVersion: number;
  hasOcean: boolean;
  seaLevel: number;
  /** Per frame. */
  frameIndex: number;
  bodyIndex: number;
  rot: Mat3;
  centre: Vec3;
  prevRot: Mat3;
  prevCentre: Vec3;
  prevCamFixed: Vec3 | null;
  lastStep: number;
  speed: number;
  velFixed: Vec3;
  cap: number;
  K: number;
  pinNear: boolean | null;
  observers: LodObserverFixed[];
  lists: { full: [number, number]; quad: [number, number]; waterFull: [number, number]; waterQuad: [number, number] };
  stats: TerrainBodyStats;
}

const MAX_RECORDS = 6144;
const MAX_INSTANCES = 1 << 16;
/** The second selection pass (prefetch) runs every this many frames. */
const PREFETCH_EVERY = 8;
/** Fade-in used for a few seconds after a camera cut, s (there is no continuity to protect right after a cut). */
const FAST_FADE_SECONDS = 0.12;
const FAST_FADE_WINDOW = 3;
const FADE_SECONDS = 0.35;

const mat3Columns = (m: Readonly<Mat3>, out: Float32Array, o: number): void => {
  out[o] = m[0];
  out[o + 1] = m[3];
  out[o + 2] = m[6];
  out[o + 4] = m[1];
  out[o + 5] = m[4];
  out[o + 6] = m[7];
  out[o + 8] = m[2];
  out[o + 9] = m[5];
  out[o + 10] = m[8];
};

export function createTerrainFeature(ctx: RenderContext, terrainProviderFactory: TerrainProviderFactory, options: TerrainFeatureOptions = {}): TerrainFeature {
  const device = ctx.device;
  const pinLevel = options.pinLevel ?? 2;
  const preloadLevel = options.preloadLevel ?? 3;
  const bodies: BodyState[] = [];
  let streamer: TileStreamer;
  let provider: TerrainAuthority;
  let rocks: RockRenderer | null = null;
  let gbufferPipeline: Tracked<GPURenderPipeline>;
  let waterPipeline: Tracked<GPURenderPipeline>;
  let shadowPipeline: Tracked<GPURenderPipeline>;
  let tileLayout: GPUBindGroupLayout;
  let surfaceLayout: GPUBindGroupLayout;
  let emptyGroup: GPUBindGroup;
  let nearField: SceneBindings;
  let fullMesh: GridMesh;
  let quadMesh: GridMesh;
  let recordBuffer: GPUBuffer;
  let instanceBuffer: GPUBuffer;
  let tileSampler: GPUSampler;
  let noiseView: GPUTextureView;
  const records = new Float32Array(MAX_RECORDS * RECORD_FLOATS);
  const recordsI = new Int32Array(records.buffer);
  const instances = new Uint32Array(MAX_INSTANCES);
  let recordCount = 0;
  let recordsUploaded = 0;
  let instanceCount = 0;
  let frameIndex = 0;
  let initialised = false;
  let overflowReported = false;
  let fastFadeUntil = -1;
  // Seconds of rendered frames: the clock of the fade-ins. (FrameContext.realTime stands still while a
  // deterministic screenshot is taken; a tile that arrives then must still relax.)
  let clock = 0;
  let morphEnabled = true;
  let rocksEnabled = true;
  let selectMs = 0;
  let prefetchMs = 0;
  const casterScratch: DrawItem[] = [];

  const reportOverflow = (what: string): void => {
    if (overflowReported) return;
    overflowReported = true;
    coreOf(ctx).reportError(`terrain: ${what} buffer is full; some tiles are not drawn this frame`);
  };

  /** Record index of a tile for this frame (records are written once per frame per tile). */
  const recordOf = (b: BodyState, n: TileNode, time: number): number => {
    if (n.recordFrame === frameIndex) return n.recordIndex;
    if (recordCount >= MAX_RECORDS) {
      reportOverflow('tile record');
      return -1;
    }
    if (!n.constants) {
      resolveOwners(n, b.stream.albedoLayer, b.stream.nightLayer);
      n.constants = buildRecordConstants(n, b.recordCtx);
    }
    const idx = recordCount++;
    const o = idx * RECORD_FLOATS;
    records.set(n.constants, o);
    const p = mat3.mulVec(b.rot, n.origin);
    const q = mat3.mulVec(b.prevRot, n.origin);
    let force = 0;
    let invRange = 0;
    if (n.level > 0 && morphEnabled) {
      const age = time - n.activatedAt;
      const fade = n.fadeSeconds > 0 && age < n.fadeSeconds ? 1 - smooth01(age / n.fadeSeconds) : 0;
      force = Math.max(fade, capMorph(n.level, b.cap));
      invRange = 1 / levelRange(n.level, b.K, b.tree.faceSize);
    }
    records[o] = p.x + b.centre.x;
    records[o + 1] = p.y + b.centre.y;
    records[o + 2] = p.z + b.centre.z;
    records[o + 3] = force;
    records[o + 4] = q.x + b.prevCentre.x;
    records[o + 5] = q.y + b.prevCentre.y;
    records[o + 6] = q.z + b.prevCentre.z;
    records[o + 7] = invRange;
    n.recordIndex = idx;
    n.recordFrame = frameIndex;
    return idx;
  };

  const pushInstance = (record: number, quadrant: number): void => {
    if (instanceCount >= MAX_INSTANCES) {
      reportOverflow('tile instance');
      return;
    }
    instances[instanceCount++] = record | ((quadrant + 1) << 20);
  };

  const uploadRecords = (): void => {
    if (recordCount > recordsUploaded) {
      device.queue.writeBuffer(recordBuffer, recordsUploaded * RECORD_BYTES, records, recordsUploaded * RECORD_FLOATS, (recordCount - recordsUploaded) * RECORD_FLOATS);
      recordsUploaded = recordCount;
    }
  };

  const createBody = async (def: BodyDef, manifest: TileManifest): Promise<BodyState> => {
    const surface = def.render.surface!;
    const terrain = def.terrain!;
    const params = readSurfaceParams(def.id, surface);
    const set = await loadMaterialSet(ctx, surface.materialSet);
    const albedoAt = await loadLowResAlbedo(ctx.tilesUrl, manifest, def.render.meanColor);
    const albedoLayer = manifest.layers[TILE_LAYER.albedo];
    if (!albedoLayer) throw new Error(`tile set "${terrain.tileset}" has no albedo layer`);
    const tree = new BodyQuadtree(def.radius, terrain.minElevation, terrain.maxElevation, def.ocean ? def.ocean.seaLevel : null);
    const pads: PadDisc[] = [];
    for (const site of Object.values(ctx.defs.sites)) {
      if (site.bodyId !== def.id || params.apronRadiusM <= 0) continue;
      const dir = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
      // The apron lies on the flattened pad disc; its height is the pad's (the pad is flat within flatRadius).
      const h = typeof site.location.padElevation === 'number' ? site.location.padElevation : provider.heightAt(def.id, dir);
      pads.push({ centre: v3.scale(dir, def.radius + h), radius: Math.min(params.apronRadiusM, site.pad.flatRadius) });
    }
    // Night lights are read `nightMinMip` levels above the layer's deepest level: its source cells are
    // coarser than its texels (the layer is baked at the imagery's resolution), and sampling whole tiles of
    // the coarser level instead of low mips of the finer one gives every drawn tile the same ground
    // resolution, 16 times fewer images per level skipped and as many fewer tile edges in the glow.
    const nightSource = surface.nightLights ? manifest.layers[TILE_LAYER.night] : undefined;
    const nightLayer = nightSource ? { ...nightSource, globalMaxLevel: Math.max(0, nightSource.globalMaxLevel - Math.round(params.nightMinMip)), coverage: {} } : undefined;
    const stream: StreamBody = { id: def.id, tileset: terrain.tileset, tree, albedoLayer, nightLayer };
    const recordCtx: RecordContext = { tree, detailScales: [params.detailScale0M, params.detailScale1M, params.detailScale2M], orbitalWavelength: params.orbitalWavelengthM, pads, albedoLayer };
    const materialData = buildMaterialUniform(set, params);
    const materialBuffer = device.createBuffer({ label: `terrain.material.${def.id}`, size: MATERIAL_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(materialBuffer, 0, materialData);
    const uniform = device.createBuffer({ label: `terrain.body.${def.id}`, size: BODY_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tileGroup = device.createBindGroup({
      label: `terrain.tiles.${def.id}`,
      layout: tileLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: recordBuffer } },
        { binding: 2, resource: { buffer: instanceBuffer } },
        { binding: 3, resource: streamer.heights.view },
      ],
    });
    const zero: [number, number] = [0, 0];
    return {
      id: def.id,
      def,
      tree,
      stream,
      recordCtx,
      params,
      set,
      albedoAt,
      materialBuffer,
      uniform,
      uniformData: new Float32Array(BODY_UNIFORM_BYTES / 4),
      tileGroup,
      surfaceGroup: null,
      surfaceVersion: -1,
      hasOcean: def.ocean !== null,
      seaLevel: def.ocean?.seaLevel ?? 0,
      frameIndex: -1,
      bodyIndex: 0,
      rot: mat3.identity(),
      centre: v3.zero(),
      prevRot: mat3.identity(),
      prevCentre: v3.zero(),
      prevCamFixed: null,
      lastStep: 0,
      speed: 0,
      velFixed: v3.zero(),
      cap: terrain.maxRenderLevel + 1,
      K: 0,
      pinNear: null,
      observers: [],
      lists: { full: zero, quad: zero, waterFull: zero, waterQuad: zero },
      stats: { selected: 0, visible: 0, waterTiles: 0, casters: 0, deepestLevel: 0, cap: 0, groundSpeed: 0, fading: 0, nodes: 0, K: 0 },
    };
  };

  const surfaceGroupOf = (b: BodyState): GPUBindGroup => {
    const version = nearField.version();
    if (!b.surfaceGroup || b.surfaceVersion !== version) {
      b.surfaceVersion = version;
      b.surfaceGroup = device.createBindGroup({
        label: `terrain.surface.${b.id}`,
        layout: surfaceLayout,
        entries: [
          { binding: 0, resource: streamer.normals.view },
          { binding: 1, resource: streamer.albedo.view },
          { binding: 2, resource: streamer.aux.view },
          { binding: 3, resource: streamer.night.view },
          { binding: 4, resource: tileSampler },
          { binding: 5, resource: b.set.viewA },
          { binding: 6, resource: b.set.viewB },
          { binding: 7, resource: noiseView },
          { binding: 8, resource: { buffer: b.materialBuffer } },
          ...nearField.entries(),
        ],
      });
    }
    return b.surfaceGroup;
  };

  /** Frustum of the camera in a body's fixed frame. */
  const frustumOf = (frame: FrameContext, pose: BodyPose): ViewFrustum => {
    const q = frame.camera.qViewToRoot;
    const f = quat.rotate(q, { x: 0, y: 0, z: -1 });
    const r = quat.rotate(q, { x: 1, y: 0, z: 0 });
    const u = quat.rotate(q, { x: 0, y: 1, z: 0 });
    const tanY = Math.tan(frame.camera.fovY / 2);
    const tanX = (tanY * frame.renderSize[0]) / frame.renderSize[1];
    const plane = (a: Vec3, t: number, sign: number): Vec3 => quat.rotateInv(pose.qFixedToRoot, v3.normalize(v3.addScaled(v3.scale(f, t), a, sign)));
    return { eye: pose.cameraFixed, planes: [plane(r, tanX, -1), plane(r, tanX, 1), plane(u, tanY, -1), plane(u, tanY, 1)] };
  };

  const selectBody = (b: BodyState, frame: FrameContext, pose: BodyPose): void => {
    const terrain = b.def.terrain!;
    const dt = Math.max(frame.realDt, 1e-4);
    const cam = pose.cameraFixed;
    const camR = v3.len(cam);
    const camDir = v3.scale(cam, 1 / camR);

    // Ground speed per wall-clock second in the body-fixed frame (time warp included), with single-frame
    // jumps (camera cuts) rejected: the smaller of the last two frame steps, then smoothed.
    let cut = b.prevCamFixed === null;
    if (b.prevCamFixed) {
      const d = v3.sub(cam, b.prevCamFixed);
      const radial = v3.dot(d, camDir);
      const horizontal = Math.sqrt(Math.max(0, v3.lenSq(d) - radial * radial));
      const step = horizontal / dt;
      const accepted = Math.min(step, b.lastStep);
      b.lastStep = step;
      b.speed += (accepted - b.speed) * (1 - Math.exp(-dt / 0.3));
      const moved = v3.len(d);
      cut = moved > Math.max(50, 0.25 * Math.max(pose.cameraAltitude, 0));
      if (!cut) b.velFixed = v3.scale(d, 1 / dt);
    }
    b.prevCamFixed = v3.clone(cam);
    if (cut) fastFadeUntil = clock + FAST_FADE_WINDOW;
    b.cap = warpLevelCap(b.tree.faceSize, b.speed, terrain.maxRenderLevel);

    const targetK = lodK(frame.renderSize[1], frame.camera.fovY, ctx.quality.terrainPxPerQuad);
    b.K = b.K === 0 || cut ? targetK : b.K + (targetK - b.K) * (1 - Math.exp(-dt / 0.25));

    // Observers: the camera first, then the frame's LOD observers that are not the camera itself.
    const obs: LodObserverFixed[] = [{ pos: cam, r: camR, dir: camDir, bias: 0, vessel: false }];
    for (const o of frame.observers) {
      if (obs.length >= MAX_OBSERVERS) break;
      const rel = v3.sub(o.positionRoot, frame.camera.positionRoot);
      if (v3.lenSq(rel) < 1 && o.radiusBias === 0) continue;
      const pos = v3.add(cam, quat.rotateInv(pose.qFixedToRoot, rel));
      const r = v3.len(pos);
      obs.push({ pos, r, dir: v3.scale(pos, 1 / r), bias: o.radiusBias, vessel: true });
    }
    b.observers = obs;

    // Coarse levels: 0..pinLevel always resident; one more level is loaded ahead once the camera is near
    // the body (within 16 radii), so that a cut to anywhere on it starts from 64 tiles per face.
    const near = pose.cameraAltitude < 16 * b.def.radius;
    if (b.pinNear !== near) {
      b.pinNear = near;
      streamer.setResidentLevels(b.stream, pinLevel, near ? preloadLevel : pinLevel);
    }

    const window = morphWindow(b.K);
    const occluder = b.hasOcean ? b.def.radius + b.seaLevel - 100 : b.def.radius + terrain.minElevation;
    const frustum = frustumOf(frame, pose);
    const base: SelectParams = {
      frameIndex,
      time: clock,
      observers: obs,
      K: b.K,
      window,
      cap: b.cap,
      maxLevel: terrain.maxRenderLevel,
      frustum,
      occluderRadius: occluder,
      fadeSeconds: cut || !morphEnabled ? 0 : clock < fastFadeUntil ? FAST_FADE_SECONDS : FADE_SECONDS,
      prefetch: 0,
    };
    b.tree.select(base);

    // Predictive prefetch (request only): where the camera will be in two seconds, and the predicted
    // impact point of the active vessel on this body.
    if (frameIndex % PREFETCH_EVERY !== 0 && frameIndex % PREFETCH_EVERY !== 4) return;
    const tPrefetch = performance.now();
    prefetchBody(b, frame, base, frustum, cut);
    prefetchMs += performance.now() - tPrefetch;
  };

  const prefetchBody = (b: BodyState, frame: FrameContext, base: SelectParams, frustum: ViewFrustum, cut: boolean): void => {
    const cam = base.observers[0]!.pos;
    if (frameIndex % PREFETCH_EVERY === 0 && !cut) {
      const ahead = v3.addScaled(cam, b.velFixed, 2);
      if (v3.dist(ahead, cam) > 1) {
        const r = v3.len(ahead);
        b.tree.select({ ...base, observers: [{ pos: ahead, r, dir: v3.scale(ahead, 1 / r), bias: 0, vessel: false }], frustum: { eye: ahead, planes: frustum.planes }, prefetch: 0.3 });
      }
    } else if (frameIndex % PREFETCH_EVERY === 4) {
      const impact = frame.snapshot.patches.current.flatMap((p) => p.markers).find((m) => m.kind === 'impact' && m.bodyId === b.id && m.latitude !== undefined && m.longitude !== undefined);
      if (impact) {
        const dir = latLonToDir(impact.latitude!, impact.longitude!);
        const ground = v3.scale(dir, b.def.radius + (impact.altitude ?? 0));
        const height = Math.max(3000, 0.3 * v3.dist(ground, cam));
        const eye = v3.addScaled(ground, dir, height);
        // A camera hanging over the impact point, looking straight down with a 90 degree field of view.
        const east = v3.normalize(v3.cross(Math.abs(dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, dir));
        const north = v3.cross(dir, east);
        const side = (a: Vec3, sign: number): Vec3 => v3.normalize(v3.addScaled(v3.neg(dir), a, sign));
        const r = v3.len(eye);
        b.tree.select({
          ...base,
          observers: [{ pos: eye, r, dir: v3.scale(eye, 1 / r), bias: 0, vessel: true }],
          frustum: { eye, planes: [side(east, -1), side(east, 1), side(north, -1), side(north, 1)] },
          occluderRadius: 0,
          prefetch: 0.2,
        });
      }
    }
  };

  /** Records and instance lists of a body's camera selection; body uniform. */
  const buildBody = (b: BodyState, _frame: FrameContext, pose: BodyPose): void => {
    const time = clock;
    const items = b.tree.items;
    const sea = b.seaLevel;
    const list = (water: boolean, quads: boolean): [number, number] => {
      const start = instanceCount;
      for (const it of items) {
        if (!it.visible || it.quadrant >= 0 !== quads) continue;
        if (water && !(it.node.hMin < sea)) continue;
        const rec = recordOf(b, it.node, time);
        if (rec >= 0) pushInstance(rec, it.quadrant);
      }
      return [start, instanceCount - start];
    };
    // Records of selected tiles outside the view are still written: shadow cascades draw them.
    for (const it of items) recordOf(b, it.node, time);
    b.lists.full = list(false, false);
    b.lists.quad = list(false, true);
    if (b.hasOcean) {
      b.lists.waterFull = list(true, false);
      b.lists.waterQuad = list(true, true);
    }

    const u = b.uniformData;
    u.fill(0);
    mat3Columns(b.rot, u, 0);
    mat3Columns(b.prevRot, u, 12);
    b.observers.forEach((o, i) => {
      const rel = mat3.mulVec(b.rot, v3.sub(o.pos, pose.cameraFixed));
      u.set([rel.x, rel.y, rel.z, o.bias], 24 + i * 4);
    });
    const p = b.params;
    const w = morphWindow(b.K);
    u.set([b.def.radius, sea, b.observers.length, b.bodyIndex], 40);
    u.set([w.m0, 1 / (w.m1 - w.m0), 0, 0], 44);
    u.set([1 / p.detailScale0M, 1 / p.detailScale1M, 1 / p.detailScale2M, p.detailFadeDistanceM], 48);
    u.set([p.orbitalWavelengthM, p.orbitalAlbedoStrength, p.orbitalReliefStrength, p.orbitalOctaves], 52);
    u.set([p.nightLuminance, p.nightOnCos, p.nightOffCos, b.stream.nightLayer ? 1 : 0], 56);
    u.set([b.def.render.surface!.brdf === 'hapke' ? MATERIAL_ID.regolith : MATERIAL_ID.terrain, b.hasOcean ? 1 : 0, b.tree.faceSize, p.nightClusterM], 60);
    u.set([p.nightTintR, p.nightTintG, p.nightTintB, p.nightClusterStrength], 64);
    u.set([srgbToLinear(p.deepWaterSrgbR / 255), srgbToLinear(p.deepWaterSrgbG / 255), srgbToLinear(p.deepWaterSrgbB / 255), p.deepWaterDepthM], 68);
    device.queue.writeBuffer(b.uniform, 0, u);

    const s = b.stats;
    s.selected = items.length;
    s.visible = 0;
    s.deepestLevel = 0;
    for (const it of items) {
      if (it.visible) s.visible++;
      if (it.node.level > s.deepestLevel) s.deepestLevel = it.node.level;
    }
    s.waterTiles = b.lists.waterFull[1] + b.lists.waterQuad[1];
    s.casters = 0;
    s.cap = b.cap;
    s.groundSpeed = b.speed;
    s.fading = b.tree.fading;
    s.nodes = b.tree.nodeCount;
    s.K = b.K;
  };

  const drawLists = (pass: GPURenderPassEncoder, full: [number, number], quad: [number, number]): void => {
    if (full[1] > 0) {
      pass.setVertexBuffer(0, fullMesh.vertexBuffer);
      pass.setIndexBuffer(fullMesh.indexBuffer, 'uint16');
      pass.drawIndexed(fullMesh.indexCount, full[1], 0, 0, full[0]);
    }
    if (quad[1] > 0) {
      pass.setVertexBuffer(0, quadMesh.vertexBuffer);
      pass.setIndexBuffer(quadMesh.indexBuffer, 'uint16');
      pass.drawIndexed(quadMesh.indexCount, quad[1], 0, 0, quad[0]);
    }
  };

  const activeBodies = (): BodyState[] => bodies.filter((b) => b.frameIndex === frameIndex);

  const feature: TerrainFeature = {
    id: options.id ?? 'terrain',
    order: options.order ?? -50,

    async init(c: RenderContext) {
      if (c !== ctx) throw new Error('createTerrainFeature: init called with a different RenderContext');
      const core = coreOf(ctx);
      provider = await terrainProviderFactory(ctx);

      // Bodies with terrain whose tile set has been baked (the server lists them; a missing manifest would log a 404).
      const listing = await fetch(`${ctx.tilesUrl}/index.json`, { cache: 'no-cache' });
      const baked = listing.ok ? ((await listing.json()) as { tilesets: string[] }).tilesets : null;
      const source = createFetchTileSource(ctx.tilesUrl);
      const defs: DefLibrary = ctx.defs;
      const candidates = Object.values(defs.bodies).filter((d) => d.terrain && d.render.surface && (!baked || baked.includes(d.terrain.tileset)));

      streamer = new TileStreamer(
        ctx,
        defs,
        candidates.map((d) => d.id),
        options.streamer,
      );
      recordBuffer = device.createBuffer({ label: 'terrain.records', size: MAX_RECORDS * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      instanceBuffer = device.createBuffer({ label: 'terrain.instances', size: MAX_INSTANCES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      fullMesh = createGridMesh(device, GRID_QUADS, 'terrain.grid');
      quadMesh = createGridMesh(device, GRID_QUADS / 2, 'terrain.gridQuadrant');
      tileSampler = device.createSampler({ label: 'terrain.tiles', minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      noiseView = createNoiseTexture(ctx).createView({ dimension: '3d' });

      const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
      tileLayout = device.createBindGroupLayout({
        label: 'terrain.tiles',
        entries: [
          { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
          { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
        ],
      });
      nearField = core.createSceneBindings(3, 9, ['oceanNearField']);
      const F = GPUShaderStage.FRAGMENT;
      const arr = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } });
      surfaceLayout = device.createBindGroupLayout({
        label: 'terrain.surface',
        entries: [
          arr(0),
          arr(1),
          arr(2),
          arr(3),
          { binding: 4, visibility: F, sampler: { type: 'filtering' } },
          arr(5),
          arr(6),
          { binding: 7, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 8, visibility: F, buffer: { type: 'uniform' } },
          ...nearField.layoutEntries,
        ],
      });
      const emptyLayout = device.createBindGroupLayout({ label: 'terrain.empty', entries: [] });
      emptyGroup = device.createBindGroup({ label: 'terrain.empty', layout: emptyLayout, entries: [] });
      const gbufferLayout = device.createPipelineLayout({ label: 'terrain.gbuffer', bindGroupLayouts: [ctx.frameBindGroupLayout, emptyLayout, tileLayout, surfaceLayout] });
      const targets: GPUColorTargetState[] = [
        { format: RENDER_FORMATS.gbufferAlbedo },
        { format: RENDER_FORMATS.gbufferNormal },
        { format: RENDER_FORMATS.gbufferMaterial },
        { format: RENDER_FORMATS.gbufferVelocity },
        { format: RENDER_FORMATS.gbufferExtra },
        { format: RENDER_FORMATS.hdr },
      ];
      const gbuffer = (label: string, wgsl: string): Tracked<GPURenderPipeline> =>
        core.shaders.tracked(() => {
          const module = ctx.shaders.createModule(label, wgsl);
          return device.createRenderPipeline({
            label,
            layout: gbufferLayout,
            vertex: { module, entryPoint: 'vs', buffers: [GRID_VERTEX_LAYOUT] },
            fragment: { module, entryPoint: 'fs', targets },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
          });
        });
      gbufferPipeline = gbuffer('terrain.gbuffer', TERRAIN_GBUFFER_WGSL.replace('OCEAN_NEAR_FIELD_BINDINGS', nearField.wgsl));
      waterPipeline = gbuffer('terrain.water', TERRAIN_WATER_WGSL.replace('OCEAN_NEAR_FIELD_BINDINGS', nearField.wgsl));
      shadowPipeline = core.shaders.tracked(() => {
        const module = ctx.shaders.createModule('terrain.shadow', TERRAIN_SHADOW_WGSL);
        return device.createRenderPipeline({
          label: 'terrain.shadow',
          layout: device.createPipelineLayout({ label: 'terrain.shadow', bindGroupLayouts: [ctx.frameBindGroupLayout, core.shadowPassLayout, tileLayout] }),
          vertex: { module, entryPoint: 'vs', buffers: [GRID_VERTEX_LAYOUT] },
          primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
          depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
        });
      });
      gbufferPipeline.get();
      waterPipeline.get();
      shadowPipeline.get();

      for (const def of candidates) {
        const manifest = await source.manifest(def.terrain!.tileset);
        const b = await createBody(def, manifest);
        bodies.push(b);
        streamer.addBody(b.stream);
        streamer.setResidentLevels(b.stream, 0, 0);
      }
      if (options.rocks !== false) rocks = new RockRenderer(ctx, provider, bodies.map((b) => ({ id: b.id, def: b.def, params: b.params, set: b.set, albedoAt: b.albedoAt })));

      // The six root tiles of every body are there before the first frame: there is always something to draw.
      await new Promise<void>((resolve, reject) => {
        const t0 = performance.now();
        const poll = (): void => {
          streamer.update(0);
          if (bodies.every((b) => b.tree.roots.every((r) => r.state === TILE_READY))) resolve();
          else if (performance.now() - t0 > 60_000) reject(new Error('terrain: the root tiles did not load within 60 s'));
          else setTimeout(poll, 4);
        };
        poll();
      });
      initialised = true;
    },

    prepare(frame: FrameContext) {
      if (!initialised) return;
      frameIndex = frame.frameIndex;
      clock += frame.realDt;
      recordCount = 0;
      recordsUploaded = 0;
      instanceCount = 0;
      const t0 = performance.now();
      prefetchMs = 0;
      ctx.perf.cpuBegin('terrain.select');
      for (const b of bodies) {
        const bodyIndex = frame.bodies.findIndex((p) => p.id === b.id);
        if (bodyIndex < 0 || bodyIndex >= MAX_BODIES) continue;
        const pose = frame.bodies[bodyIndex]!;
        b.frameIndex = frameIndex;
        b.bodyIndex = bodyIndex;
        b.rot = mat3.fromQuat(pose.qFixedToRoot);
        b.prevRot = mat3.fromQuat(pose.prevQFixedToRoot);
        b.centre = pose.centerRelCam;
        b.prevCentre = pose.prevCenterRelCam;
        selectBody(b, frame, pose);
      }
      ctx.perf.cpuEnd('terrain.select');
      selectMs = performance.now() - t0 - prefetchMs;
      ctx.perf.cpuBegin('terrain.stream');
      streamer.update(frameIndex);
      ctx.perf.cpuEnd('terrain.stream');
      for (const b of activeBodies()) buildBody(b, frame, frame.bodies[b.bodyIndex]!);
      uploadRecords();
      if (instanceCount > 0) device.queue.writeBuffer(instanceBuffer, 0, instances, 0, instanceCount);
      rocks?.prepare(frame, rocksEnabled ? activeBodies().map((b) => ({ id: b.id, bodyIndex: b.bodyIndex, observers: b.observers })) : []);
      ctx.perf.counter('terrain.tiles', bodies.reduce((a, b) => a + b.stats.visible, 0));
      ctx.perf.counter('terrain.queue', streamer.stats().queued + streamer.stats().loading);
    },

    drawGBuffer(_frame, pass) {
      if (!initialised) return;
      const active = activeBodies();
      pass.setBindGroup(1, emptyGroup);
      // The sea-level sheet first: the seabed under it then fails the depth test.
      let pipelineSet = false;
      for (const b of active) {
        const l = b.lists;
        if (!b.hasOcean || l.waterFull[1] + l.waterQuad[1] === 0) continue;
        if (!pipelineSet) {
          pass.setPipeline(waterPipeline.get());
          pipelineSet = true;
        }
        pass.setBindGroup(2, b.tileGroup);
        pass.setBindGroup(3, surfaceGroupOf(b));
        drawLists(pass, l.waterFull, l.waterQuad);
      }
      pass.setPipeline(gbufferPipeline.get());
      for (const b of active) {
        const l = b.lists;
        if (l.full[1] + l.quad[1] === 0) continue;
        pass.setBindGroup(2, b.tileGroup);
        pass.setBindGroup(3, surfaceGroupOf(b));
        drawLists(pass, l.full, l.quad);
      }
      rocks?.drawGBuffer(pass);
    },

    drawShadow(frame, pass, cascade: ShadowCascadeView) {
      if (!initialised) return;
      const active = activeBodies();
      let target: BodyState | undefined;
      if (cascade.anchor.kind === 'body') target = active.find((b) => b.id === cascade.anchor.id);
      else {
        // A vessel-anchored cascade is re-rendered every frame, so the ground under the vessel may be in it.
        let best = Infinity;
        for (const b of active) {
          const alt = frame.bodies[b.bodyIndex]!.cameraAltitude;
          if (alt < best) {
            best = alt;
            target = b;
          }
        }
      }
      if (!target) return;
      const b = target;
      // Cascade clip coordinates of a body-fixed point: clip_r = A_r . p + B_r (orthographic, w = 1).
      const m = cascade.viewProj;
      const A = new Float64Array(9);
      const B = new Float64Array(3);
      for (let r = 0; r < 3; r++) {
        for (let j = 0; j < 3; j++) A[r * 3 + j] = m[r]! * b.rot[j]! + m[4 + r]! * b.rot[3 + j]! + m[8 + r]! * b.rot[6 + j]!;
        B[r] = m[r]! * b.centre.x + m[4 + r]! * b.centre.y + m[8 + r]! * b.centre.z + m[12 + r]!;
      }
      const sx = Math.hypot(A[0]!, A[1]!, A[2]!);
      const sy = Math.hypot(A[3]!, A[4]!, A[5]!);
      const inside = (s: BoundSphere): boolean => {
        const cx = A[0]! * s.cx + A[1]! * s.cy + A[2]! * s.cz + B[0]!;
        if (Math.abs(cx) > 1 + s.r * sx) return false;
        const cy = A[3]! * s.cx + A[4]! * s.cy + A[5]! * s.cz + B[1]!;
        return Math.abs(cy) <= 1 + s.r * sy;
      };
      // Caster level: quads of about two shadow texels.
      const quadsWanted = 2 * cascade.texelSize * GRID_QUADS;
      const targetLevel = Math.max(0, Math.min(capMaxLevel(b.cap, b.def.terrain!.maxRenderLevel), Math.ceil(Math.log2(b.tree.faceSize / quadsWanted))));
      casterScratch.length = 0;
      b.tree.selectCasters(frameIndex, targetLevel, inside, casterScratch);
      if (casterScratch.length === 0) return;
      const time = clock;
      const fullStart = instanceCount;
      for (const it of casterScratch) {
        if (it.quadrant >= 0) continue;
        const rec = recordOf(b, it.node, time);
        if (rec >= 0) pushInstance(rec, -1);
      }
      const quadStart = instanceCount;
      for (const it of casterScratch) {
        if (it.quadrant < 0) continue;
        const rec = recordOf(b, it.node, time);
        if (rec >= 0) pushInstance(rec, it.quadrant);
      }
      const end = instanceCount;
      uploadRecords();
      if (end > fullStart) device.queue.writeBuffer(instanceBuffer, fullStart * 4, instances, fullStart, end - fullStart);
      b.stats.casters += end - fullStart;
      pass.setPipeline(shadowPipeline.get());
      pass.setBindGroup(2, b.tileGroup);
      drawLists(pass, [fullStart, quadStart - fullStart], [quadStart, end - quadStart]);
      rocks?.drawShadow(pass, cascade, b.id);
    },

    isIdle() {
      if (!initialised) return false;
      if (!streamer.isIdle()) return false;
      if (rocks && !rocks.isIdle()) return false;
      // A tile still relaxing from its fade-in changes the image.
      return bodies.every((b) => b.frameIndex !== frameIndex || b.tree.fading === 0);
    },

    dispose() {
      streamer?.dispose();
      rocks?.dispose();
    },

    debug: {
      stats() {
        return {
          stream: streamer.stats(),
          bodies: Object.fromEntries(bodies.map((b) => [b.id, { ...b.stats }])),
          records: recordCount,
          instances: instanceCount,
          selectMs,
          prefetchMs,
          rocks: rocks ? rocks.stats() : { instances: 0, chunks: 0, triangles: 0 },
        };
      },
      setStreamDelay(ms: number) {
        streamer.setDelay(ms);
      },
      setMorphEnabled(on: boolean) {
        morphEnabled = on;
      },
      setRocksEnabled(on: boolean) {
        rocksEnabled = on;
      },
      provider: () => provider,
      bodies: () => bodies.map((b) => b.id),
      readyTiles(bodyId, level, latDeg, lonDeg, limit) {
        const b = bodies.find((x) => x.id === bodyId);
        if (!b) return [];
        const dir = latLonToDir(latDeg * DEG, lonDeg * DEG);
        const found: { key: TileKey; d: number }[] = [];
        for (const n of b.tree.allNodes()) {
          if (n.level !== level || n.state !== TILE_READY) continue;
          found.push({ key: n.key, d: Math.hypot(n.frame.cHat.x - dir.x, n.frame.cHat.y - dir.y, n.frame.cHat.z - dir.z) });
        }
        return found
          .sort((p, q) => p.d - q.d)
          .slice(0, limit)
          .map((f) => f.key);
      },
      readyTileAt(bodyId, latDeg, lonDeg, maxLevel = 99) {
        const b = bodies.find((x) => x.id === bodyId);
        if (!b) return null;
        const dir = latLonToDir(latDeg * DEG, lonDeg * DEG);
        let best: TileKey | null = null;
        for (let level = 0; level <= Math.min(maxLevel, b.def.terrain!.maxRenderLevel); level++) {
          const n = b.tree.node(dirToTile(dir, level).key);
          if (!n || n.state !== TILE_READY) break;
          best = n.key;
        }
        return best;
      },
      async readTile(bodyId, key) {
        const b = bodies.find((x) => x.id === bodyId);
        const n = b?.tree.node(key);
        if (!b || !n || n.state !== TILE_READY) throw new Error(`terrain: tile ${key.face}/${key.level}/${key.x}/${key.y} of "${bodyId}" is not ready`);
        const read = async (texture: GPUTexture, layer: number, size: number, bytesPerTexel: number): Promise<ArrayBuffer> => {
          const rowBytes = Math.ceil((size * bytesPerTexel) / 256) * 256;
          const buffer = device.createBuffer({ size: rowBytes * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer] }, { buffer, bytesPerRow: rowBytes, rowsPerImage: size }, [size, size, 1]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const src = new Uint8Array(buffer.getMappedRange());
          const out = new Uint8Array(size * size * bytesPerTexel);
          for (let y = 0; y < size; y++) out.set(src.subarray(y * rowBytes, y * rowBytes + size * bytesPerTexel), y * size * bytesPerTexel);
          buffer.unmap();
          buffer.destroy();
          return out.buffer;
        };
        const heights = new Float32Array(await read(streamer.heights.texture, n.heightLayer, GRID_VERTS, 4));
        const normal = new Uint8Array(await read(streamer.normals.texture, n.normalLayer, 256, 4));
        const albedo = n.imageLayer >= 0 ? new Uint8Array(await read(streamer.albedo.texture, n.imageLayer, 256, 4)) : null;
        const aux = n.imageLayer >= 0 ? new Uint8Array(await read(streamer.aux.texture, n.imageLayer, 256, 2)) : null;
        return { heights, albedo, aux, normal };
      },
    },
  };
  return feature;
}
