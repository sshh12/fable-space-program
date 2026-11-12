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
import { capMaxLevel, capMorph, fitLodScale, GRID_QUADS, GRID_VERTS, GroundSpeed, levelRange, LOD_K_MAX, LOD_K_MIN, lodK, morphWindow, POOL_LOW, smooth01, warpLevelCap, type ReliefFloor } from './lod';
import { buildMaterialUniform, createNoiseTexture, loadMaterialSet, readSurfaceParams, type MaterialSet, type SiteGroundPlan, type SurfaceParams } from './materials';
import { BodyQuadtree, TILE_READY, type DrawItem, type LodObserverFixed, type SelectParams, type TileNode, type ViewFrustum } from './quadtree';
import { CoverRenderer, type CoverBodyInfo, type CoverSite } from './cover';
import { buildRecordConstants, type RecordContext, type SiteDisc } from './records';
import { RockRenderer } from './rocks';
import { BODY_UNIFORM_BYTES, MAX_OBSERVERS, RECORD_BYTES, RECORD_FLOATS, TERRAIN_SHADOW_WGSL, TILE_FRAME_BYTES, TILE_FRAME_FLOATS } from './shaders/common';
import { regolithBrdfWgsl, TERRAIN_BRDF_WGSL } from './shaders/lighting';
import { buildSitePlan, MAX_SITES } from './sitePlan';
import { MATERIAL_UNIFORM_FLOATS, TERRAIN_GBUFFER_WGSL, TERRAIN_WATER_WGSL } from './shaders/surface';
import { TileStreamer, type PoolDemand, type StreamBody, type StreamerOptions, type StreamStats } from './streamer';
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
  /** Draw the ground cover: tussocks, shrubs, trees, loose stones (default true). */
  cover?: boolean;
  /**
   * Leave the rock draws to the companion feature `TerrainFeature.rocks` (default false: the terrain feature
   * draws them in its own hooks). Performance attribution times every feature's hooks in passes of their
   * own, so a lab that adds the companion gets the rocks' G-buffer and shadow cost as measured lines
   * (`<id>-rocks.gbuffer`, `<id>-rocks.shadow`). The ground cover is then left to `TerrainFeature.cover` in
   * the same way (`<id>-cover.gbuffer`, `<id>-cover.shadow`).
   */
  rocksSeparate?: boolean;
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

/** The last settled view of a surface with a vessel on it, kept resident while the camera is in the map view. */
interface ParkedView {
  /** The camera of that view (body-fixed), its frustum and its K. */
  eye: LodObserverFixed;
  frustum: ViewFrustum;
  K: number;
  /** Where the vessel observer nearest to the eye stood (body-fixed): the view is dropped when it has left. */
  anchor: Vec3;
}

export interface TerrainDebug {
  /**
   * selectMs = CPU time of the frame's LOD selection (every body, what is drawn); prefetchMs = time of the
   * request-only passes that ran in the same frame (two frames in eight: 2 s ahead, predicted impact).
   */
  stats(): {
    stream: StreamStats;
    bodies: Record<string, TerrainBodyStats>;
    records: number;
    instances: number;
    selectMs: number;
    prefetchMs: number;
    /**
     * Factor on the split distances that fits the view into the tile pools (1 = the full ranges of the
     * render height, lod.ts `fitLodScale`) and the live demand it is fitted to.
     */
    lodScale: number;
    demand: PoolDemand;
    /**
     * Main-thread time of the last frame, ms: `hooks` = everything the feature did (prepare and every draw
     * hook); its parts: `stream` (requests, dispatch, uploads; `upload` of it is the tile uploads), `build`
     * (records, instance lists, uniforms), `rocks` (rock lists of prepare and of the shadow hooks), `shadow`
     * (caster walks and draws of the terrain), `gbuffer`. `hooks - upload` is what the budget line
     * "quadtree + cascades" covers; uploads have their own line.
     */
    cpu: { hooks: number; stream: number; upload: number; build: number; rocks: number; cover: number; shadow: number; gbuffer: number };
    /** Bytes of the detail material arrays of every body. */
    materialBytes: number;
    rocks: { instances: number; chunks: number; triangles: number };
    /** Ground cover: instances in this frame's lists (shadow lists included), chunks held, triangles of the G-buffer lists. */
    cover: { instances: number; chunks: number; triangles: number };
  };
  /** Delay every tile by `ms` between the worker and the upload (tests of late streaming). */
  setStreamDelay(ms: number): void;
  /**
   * Upload budget per frame: tiles and milliseconds (default 8 tiles, 2 ms: StreamerOptions). A loading screen
   * may raise it while nobody watches the frames (request app-integration-11) and must set it back.
   */
  setUploadBudget(tiles: number, ms: number): void;
  /**
   * Switch geomorphing and fade-ins off (tiles then pop in and out): the control experiment that shows the
   * pop detector of the browser specs is not blind. Never used by the app.
   */
  setMorphEnabled(on: boolean): void;
  /** Draw the rock field or not (performance attribution: the rocks' share is the difference). */
  setRocksEnabled(on: boolean): void;
  /** Draw the ground cover or not. */
  setCoverEnabled(on: boolean): void;
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
  /**
   * What the latest camera selection of a body wants and has (request app-integration-11), per level
   * 0..maxRenderLevel: `wanted[l]` = tiles of level l the selection uses (drawn, parents of drawn tiles, and
   * tiles it asked for), `resident[l]` = those of them that are READY; `wantedLevel` = the deepest level
   * wanted, `residentLevel` = the deepest level down to which every wanted tile is resident. A tile that was
   * given up for want of a pool layer is not wanted until it is retried. Null for a body that is not drawn.
   * One walk over the body's nodes: cheap enough for every frame of a loading screen.
   */
  residency(bodyId: string): { wantedLevel: number; residentLevel: number; wanted: number[]; resident: number[] } | null;
}

export interface TerrainFeature extends RenderFeature {
  readonly debug: TerrainDebug;
  /** With `rocksSeparate`: the feature that draws the rock field (add it after this one); else null. */
  readonly rocks: RenderFeature | null;
  /** With `rocksSeparate`: the feature that draws the ground cover (add it after this one); else null. */
  readonly cover: RenderFeature | null;
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
  /** Launch sites on the body with their ground plans (nothing of the ground cover stands on them). */
  sites: CoverSite[];
  landcover: TileManifest['layers'][string] | undefined;
  materialBuffer: GPUBuffer;
  uniform: GPUBuffer;
  uniformData: Float32Array<ArrayBuffer>;
  tileGroup: GPUBindGroup;
  surfaceGroup: GPUBindGroup | null;
  surfaceVersion: number;
  hasOcean: boolean;
  seaLevel: number;
  /** Levels up to the preload level are drawn within RELIEF_RADII radii, whatever their size on screen. */
  relief: ReliefFloor;
  /** Per frame. */
  frameIndex: number;
  bodyIndex: number;
  rot: Mat3;
  centre: Vec3;
  prevRot: Mat3;
  prevCentre: Vec3;
  prevCamFixed: Vec3 | null;
  /** Ground speed of the camera and of the frame's other observers (by their place in the list), for their warp caps. */
  speedTrack: GroundSpeed;
  observerTracks: { prev: Vec3 | null; track: GroundSpeed }[];
  speed: number;
  velFixed: Vec3;
  /** Warp cap of the camera (the other observers carry their own). */
  cap: number;
  /** Per level, for this frame: the morph floor of the warp cap and 1 / range(level). */
  capMorph: Float32Array;
  invRange: Float32Array;
  K: number;
  /** K the smoothed `K` is heading for (full K of the render height times the pool fit). */
  targetK: number;
  pinNear: boolean | null;
  /** After a cut (and at the start): ask for the whole chain of tiles under the view until one selection wants nothing. */
  eager: boolean;
  parked: ParkedView | null;
  observers: LodObserverFixed[];
  lists: { full: [number, number]; quad: [number, number]; waterFull: [number, number]; waterQuad: [number, number] };
  stats: TerrainBodyStats;
}

const MAX_INSTANCES = 1 << 16;
/** The second selection pass (prefetch) runs every this many frames. */
const PREFETCH_EVERY = 8;
/** A camera that moved less than this share of its distance to the vessel in a frame is a settled view (worth parking). */
const PARK_STEP = 0.02;
/** The parked view is dropped when its vessel has moved this far, m. */
const PARK_REACH = 150;
/** Distance (in body radii) within which the preload level is resident and drawn: the whole-body shadow cascade then casts from tiles with quads of about three of its texels. */
const RELIEF_RADII = 16;
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
  let cover: CoverRenderer | null = null;
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
  // A resident tile has one slot in both record buffers: its layer in the height pool. The constants go up
  // once, when the tile is first drawn; the two camera-dependent rows of the tiles in use go up every frame.
  let slots = 0;
  let records: Float32Array<ArrayBuffer>;
  let tileFrames: Float32Array<ArrayBuffer>;
  let tileFrameBuffer: GPUBuffer;
  let recordDirty: [number, number] = [Infinity, -1];
  let frameDirty: [number, number] = [Infinity, -1];
  let recordsUsed = 0;
  const instances = new Uint32Array(MAX_INSTANCES);
  // Scratch lists of buildBody: whole tiles, quadrants, and the same for the sea sheet.
  const listScratch = [new Uint32Array(MAX_INSTANCES >> 2), new Uint32Array(MAX_INSTANCES >> 2), new Uint32Array(MAX_INSTANCES >> 2), new Uint32Array(MAX_INSTANCES >> 2)];
  const listCount = [0, 0, 0, 0];
  // The visible tiles of a body, to be drawn nearest first: instance word, list (0 whole, 1 quadrant; + 2 with a sea sheet), distance.
  const visWord = new Uint32Array(MAX_INSTANCES >> 2);
  const visList = new Uint8Array(MAX_INSTANCES >> 2);
  // Sort keys: the distance in eighths of a metre, times 65,536, plus the index (a plain numeric sort then orders by distance).
  const visKey = new Float64Array(MAX_INSTANCES >> 2);
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
  let coverEnabled = true;
  let selectMs = 0;
  let prefetchMs = 0;
  // Fit of the view into the tile pools (lod.ts fitLodScale): factor on K, and the demand it was fitted to.
  let lodScale = 1;
  let demand: PoolDemand = { tiles: 0, images: 0, ratio: 0 };
  const cpu = { hooks: 0, stream: 0, upload: 0, build: 0, rocks: 0, cover: 0, shadow: 0, gbuffer: 0 };
  // Time of the frame's prepare and of all its draw hooks so far, ms.
  let prepareMs = 0;
  let drawMs = 0;
  const casterScratch: DrawItem[] = [];
  const cascadeA = new Float64Array(9);
  const cascadeB = new Float64Array(3);

  const reportOverflow = (what: string): void => {
    if (overflowReported) return;
    overflowReported = true;
    coreOf(ctx).reportError(`terrain: ${what} buffer is full; some tiles are not drawn this frame`);
  };

  /** Record slot of a tile, with its camera-dependent rows written for this frame (once per frame per tile). */
  const recordOf = (b: BodyState, n: TileNode, time: number): number => {
    const slot = n.heightLayer;
    if (n.recordFrame === frameIndex) return slot;
    if (!n.constants) {
      n.constants = buildRecordConstants(n, b.recordCtx);
      records.set(n.constants, slot * RECORD_FLOATS);
      if (slot < recordDirty[0]) recordDirty[0] = slot;
      if (slot > recordDirty[1]) recordDirty[1] = slot;
    }
    let force = 0;
    let invRange = 0;
    if (n.level > 0 && morphEnabled) {
      const age = time - n.activatedAt;
      const fade = n.fadeSeconds > 0 && age < n.fadeSeconds ? 1 - smooth01(age / n.fadeSeconds) : 0;
      // The cap of the observers the tile is drawn for (quadtree.ts); the camera's for a tile only a shadow cascade draws.
      force = Math.max(fade, n.capFrame === frameIndex && n.cap !== b.cap ? capMorph(n.level, n.cap) : b.capMorph[n.level]!);
      invRange = b.invRange[n.level]!;
    }
    const m = b.rot;
    const q = b.prevRot;
    const g = n.origin;
    const f = tileFrames;
    const o = slot * TILE_FRAME_FLOATS;
    f[o] = m[0] * g.x + m[1] * g.y + m[2] * g.z + b.centre.x;
    f[o + 1] = m[3] * g.x + m[4] * g.y + m[5] * g.z + b.centre.y;
    f[o + 2] = m[6] * g.x + m[7] * g.y + m[8] * g.z + b.centre.z;
    f[o + 3] = force;
    f[o + 4] = q[0] * g.x + q[1] * g.y + q[2] * g.z + b.prevCentre.x;
    f[o + 5] = q[3] * g.x + q[4] * g.y + q[5] * g.z + b.prevCentre.y;
    f[o + 6] = q[6] * g.x + q[7] * g.y + q[8] * g.z + b.prevCentre.z;
    f[o + 7] = invRange;
    if (slot < frameDirty[0]) frameDirty[0] = slot;
    if (slot > frameDirty[1]) frameDirty[1] = slot;
    n.recordIndex = slot;
    n.recordFrame = frameIndex;
    recordsUsed++;
    return slot;
  };

  const pushInstance = (record: number, quadrant: number): void => {
    if (instanceCount >= MAX_INSTANCES) {
      reportOverflow('tile instance');
      return;
    }
    instances[instanceCount++] = record | ((quadrant + 1) << 20);
  };

  /** Send the rows written since the last call: one contiguous range of each buffer. */
  const uploadRecords = (): void => {
    if (recordDirty[1] >= recordDirty[0]) {
      device.queue.writeBuffer(recordBuffer, recordDirty[0] * RECORD_BYTES, records, recordDirty[0] * RECORD_FLOATS, (recordDirty[1] - recordDirty[0] + 1) * RECORD_FLOATS);
      recordDirty = [Infinity, -1];
    }
    if (frameDirty[1] >= frameDirty[0]) {
      device.queue.writeBuffer(tileFrameBuffer, frameDirty[0] * TILE_FRAME_BYTES, tileFrames, frameDirty[0] * TILE_FRAME_FLOATS, (frameDirty[1] - frameDirty[0] + 1) * TILE_FRAME_FLOATS);
      frameDirty = [Infinity, -1];
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
    const pads: SiteDisc[] = [];
    const sitePlans: SiteGroundPlan[] = [];
    const sites: CoverSite[] = [];
    for (const site of Object.values(ctx.defs.sites)) {
      if (site.bodyId !== def.id || params.apronRadiusM <= 0 || pads.length >= MAX_SITES) continue;
      const dir = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
      // The site's ground plan lies on the flattened pad disc; its height is the pad's (flat within flatRadius).
      const h = typeof site.location.padElevation === 'number' ? site.location.padElevation : provider.heightAt(def.id, dir);
      const plan = buildSitePlan(site, params);
      const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, dir));
      const north = v3.cross(dir, east);
      pads.push({ centre: v3.scale(dir, def.radius + h), radius: plan.reach, index: pads.length });
      sitePlans.push({ plan, east: [east.x, east.y, east.z], north: [north.x, north.y, north.z] });
      sites.push({ centre: v3.scale(dir, def.radius + h), east, north, plan });
    }
    // Night lights are read `nightMinMip` levels above the layer's deepest level: its source cells are
    // coarser than its texels (the layer is baked at the imagery's resolution), and sampling whole tiles of
    // the coarser level instead of low mips of the finer one gives every drawn tile the same ground
    // resolution, 16 times fewer images per level skipped and as many fewer tile edges in the glow.
    const nightSource = surface.nightLights ? manifest.layers[TILE_LAYER.night] : undefined;
    const nightLayer = nightSource ? { ...nightSource, globalMaxLevel: Math.max(0, nightSource.globalMaxLevel - Math.round(params.nightMinMip)), coverage: {} } : undefined;
    const stream: StreamBody = { id: def.id, tileset: terrain.tileset, tree, albedoLayer, nightLayer };
    const recordCtx: RecordContext = { tree, detailScales: [params.detailScale0M, params.detailScale1M, params.detailScale2M, params.detailScale3M], orbitalWavelength: params.orbitalWavelengthM, pads, albedoLayer, nightLayer };
    const materialData = buildMaterialUniform(set, params, sitePlans);
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
        { binding: 4, resource: { buffer: tileFrameBuffer } },
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
      sites,
      landcover: manifest.layers[TILE_LAYER.landcover],
      materialBuffer,
      uniform,
      uniformData: new Float32Array(BODY_UNIFORM_BYTES / 4),
      tileGroup,
      surfaceGroup: null,
      surfaceVersion: -1,
      relief: { level: preloadLevel, range: RELIEF_RADII * def.radius },
      hasOcean: def.ocean !== null,
      seaLevel: def.ocean?.seaLevel ?? 0,
      frameIndex: -1,
      bodyIndex: 0,
      rot: mat3.identity(),
      centre: v3.zero(),
      prevRot: mat3.identity(),
      prevCentre: v3.zero(),
      prevCamFixed: null,
      speedTrack: new GroundSpeed(),
      observerTracks: [],
      speed: 0,
      velFixed: v3.zero(),
      cap: terrain.maxRenderLevel + 1,
      capMorph: new Float32Array(terrain.maxRenderLevel + 2),
      invRange: new Float32Array(terrain.maxRenderLevel + 2),
      K: 0,
      targetK: 0,
      pinNear: null,
      eager: true,
      parked: null,
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
          { binding: 5, resource: b.set.viewNearA },
          { binding: 6, resource: b.set.viewNearB },
          { binding: 7, resource: b.set.viewWideA },
          { binding: 8, resource: b.set.viewWideB },
          { binding: 9, resource: noiseView },
          { binding: 10, resource: { buffer: b.materialBuffer } },
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

    // Ground speed per wall-clock second in the body-fixed frame (time warp included), with camera cuts and
    // view blends rejected (lod.ts GroundSpeed).
    const horizontalStep = (from: Vec3, to: Vec3, dir: Vec3): number => {
      const d = v3.sub(to, from);
      const radial = v3.dot(d, dir);
      return Math.sqrt(Math.max(0, v3.lenSq(d) - radial * radial));
    };
    let cut = b.prevCamFixed === null;
    let moved = 0;
    if (b.prevCamFixed) {
      b.speed = b.speedTrack.update(horizontalStep(b.prevCamFixed, cam, camDir), dt);
      const d = v3.sub(cam, b.prevCamFixed);
      moved = v3.len(d);
      cut = moved > Math.max(50, 0.25 * Math.max(pose.cameraAltitude, 0));
      if (!cut) b.velFixed = v3.scale(d, 1 / dt);
    }
    b.prevCamFixed = v3.clone(cam);
    if (cut) fastFadeUntil = clock + FAST_FADE_WINDOW;
    b.cap = warpLevelCap(b.tree.faceSize, b.speed, terrain.maxRenderLevel);

    // The full K of the render height, shrunk where the view would not fit into the tile pools.
    const targetK = Math.min(LOD_K_MAX, Math.max(LOD_K_MIN, lodK(frame.renderSize[1], frame.camera.fovY, ctx.quality.terrainPxPerQuad) * lodScale));
    b.targetK = targetK;
    b.K = b.K === 0 || cut ? targetK : b.K + (targetK - b.K) * (1 - Math.exp(-dt / 0.25));
    for (let level = 1; level < b.invRange.length; level++) {
      b.invRange[level] = 1 / levelRange(level, b.K, b.tree.faceSize, b.relief);
      b.capMorph[level] = capMorph(level, b.cap);
    }

    // Observers: the camera first, then the frame's LOD observers that are not the camera itself. Each has
    // the warp cap of its own ground speed: a vessel standing on the pad keeps its ground at full depth under
    // a map camera that sweeps the turning planet at two kilometres per second.
    const obs: LodObserverFixed[] = [{ pos: cam, r: camR, dir: camDir, bias: 0, vessel: false, cap: b.cap }];
    for (const o of frame.observers) {
      if (obs.length >= MAX_OBSERVERS) break;
      const rel = v3.sub(o.positionRoot, frame.camera.positionRoot);
      if (v3.lenSq(rel) < 1 && o.radiusBias === 0) continue;
      const pos = v3.add(cam, quat.rotateInv(pose.qFixedToRoot, rel));
      const r = v3.len(pos);
      const dir = v3.scale(pos, 1 / r);
      const i = obs.length - 1;
      const t = (b.observerTracks[i] ??= { prev: null, track: new GroundSpeed() });
      const speed = t.prev ? t.track.update(horizontalStep(t.prev, pos, dir), dt) : 0;
      t.prev = pos;
      let cap = warpLevelCap(b.tree.faceSize, speed, terrain.maxRenderLevel);
      // Riding with the camera (a chase or cockpit view): one cap, and the cheaper selection that goes with it.
      if (Math.abs(cap - b.cap) < 0.05) cap = b.cap;
      obs.push({ pos, r, dir, bias: o.radiusBias, vessel: true, cap });
    }
    for (let i = obs.length - 1; i < b.observerTracks.length; i++) {
      b.observerTracks[i]!.prev = null;
      b.observerTracks[i]!.track.reset();
    }
    b.observers = obs;

    // Coarse levels: 0..pinLevel always resident; one more level is loaded ahead once the camera is near
    // the body (within RELIEF_RADII radii): a cut to anywhere on it starts from 64 tiles per face, and
    // within that distance the level is drawn (the relief floor), so the terminator has shadows to show.
    const near = pose.cameraAltitude < RELIEF_RADII * b.def.radius;
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
      relief: b.relief,
    };
    // After a cut the view is asked for whole, not one level per round trip, until it is complete.
    if (cut) b.eager = true;
    const wantedBefore = b.tree.wanted.length;
    b.tree.select(b.eager ? { ...base, eager: true } : base);
    if (b.eager && b.tree.wanted.length === wantedBefore) b.eager = false;

    // The view a vessel on the surface was last looked at from stays resident while the camera is in the map
    // (request app-integration-6): leaving the map shows the ground as it was left.
    const map = frame.camera.kind === 'map';
    if (!map) {
      let nearest = Infinity;
      let anchor: Vec3 | null = null;
      for (let i = 1; i < obs.length; i++) {
        const d = v3.dist(obs[i]!.pos, cam);
        if (d < nearest) {
          nearest = d;
          anchor = obs[i]!.pos;
        }
      }
      if (!anchor) b.parked = null;
      else if (!cut && moved <= PARK_STEP * Math.max(1, nearest)) b.parked = { eye: { pos: cam, r: camR, dir: camDir, bias: 0, vessel: false, cap: terrain.maxRenderLevel + 1 }, frustum, K: b.K, anchor: v3.clone(anchor) };
    } else if (b.parked) {
      const anchor = b.parked.anchor;
      if (!obs.some((o, i) => i > 0 && v3.dist(o.pos, anchor) < PARK_REACH)) b.parked = null;
      else if (frameIndex % PREFETCH_EVERY === 2) {
        const tPark = performance.now();
        b.tree.select({ ...base, observers: [b.parked.eye, ...obs.slice(1)], frustum: b.parked.frustum, K: b.parked.K, window: morphWindow(b.parked.K), prefetch: 1, counted: true });
        prefetchMs += performance.now() - tPark;
      }
    }

    // Predictive prefetch (request only): where the camera will be in two seconds, and the predicted
    // impact point of the active vessel on this body. Only with room to spare in the pools: what it asks for
    // is not needed yet.
    if (frameIndex % PREFETCH_EVERY !== 0 && frameIndex % PREFETCH_EVERY !== 4) return;
    if (lodScale < 1 || demand.ratio >= POOL_LOW) return;
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
        b.tree.select({ ...base, observers: [{ pos: ahead, r, dir: v3.scale(ahead, 1 / r), bias: 0, vessel: false, cap: base.cap }], frustum: { eye: ahead, planes: frustum.planes }, prefetch: 0.3 });
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
          observers: [{ pos: eye, r, dir: v3.scale(eye, 1 / r), bias: 0, vessel: true, cap: base.cap }],
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
    const ocean = b.hasOcean;
    listCount.fill(0);
    let visible = 0;
    let deepest = 0;
    // One pass: the record of every selected tile (those outside the view too: shadow cascades draw them),
    // and what is in view with its distance.
    const eye = pose.cameraFixed;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const n = it.node;
      const rec = recordOf(b, n, time);
      if (n.level > deepest) deepest = n.level;
      if (!it.visible || visible >= visWord.length) continue;
      const s = n.sphere;
      visWord[visible] = rec | ((it.quadrant + 1) << 20);
      visList[visible] = (it.quadrant >= 0 ? 1 : 0) | (ocean && n.hMin < sea ? 2 : 0);
      const ex = s.cx - eye.x;
      const ey = s.cy - eye.y;
      const ez = s.cz - eye.z;
      visKey[visible] = Math.round(8 * Math.max(0, Math.sqrt(ex * ex + ey * ey + ez * ez) - s.r)) * 65536 + visible;
      visible++;
    }
    // The four lists, nearest tile first: on broken ground seen from eye height a pixel is covered by
    // several hills, and the depth test spares the fragment shader all but the first.
    const order = visKey.subarray(0, visible).sort();
    for (let j = 0; j < visible; j++) {
      const v = order[j]! % 65536;
      const k = visList[v]! & 1;
      listScratch[k]![listCount[k]!++] = visWord[v]!;
      if (visList[v]! & 2) listScratch[k + 2]![listCount[k + 2]!++] = visWord[v]!;
    }
    const lists: [number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const count = Math.min(listCount[k]!, MAX_INSTANCES - instanceCount);
      if (count < listCount[k]!) reportOverflow('tile instance');
      instances.set(listScratch[k]!.subarray(0, count), instanceCount);
      lists.push([instanceCount, count]);
      instanceCount += count;
    }
    b.lists.full = lists[0]!;
    b.lists.quad = lists[1]!;
    b.lists.waterFull = lists[2]!;
    b.lists.waterQuad = lists[3]!;

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
    u.set([w.m0, 1 / (w.m1 - w.m0), p.detailFadeDistanceM, 0], 44);
    u.set([1 / p.detailScale0M, 1 / p.detailScale1M, 1 / p.detailScale2M, 1 / p.detailScale3M], 48);
    u.set([p.orbitalWavelengthM, p.orbitalAlbedoStrength, p.orbitalReliefStrength, p.orbitalOctaves], 52);
    u.set([p.nightLuminance, p.nightOnCos, p.nightOffCos, b.stream.nightLayer ? 1 : 0], 56);
    u.set([b.def.render.surface!.brdf === 'hapke' ? MATERIAL_ID.regolith : MATERIAL_ID.terrain, b.hasOcean ? 1 : 0, b.tree.faceSize, p.nightClusterM], 60);
    u.set([p.nightTintR, p.nightTintG, p.nightTintB, p.nightClusterStrength], 64);
    u.set([srgbToLinear(p.deepWaterSrgbR / 255), srgbToLinear(p.deepWaterSrgbG / 255), srgbToLinear(p.deepWaterSrgbB / 255), p.deepWaterDepthM], 68);
    device.queue.writeBuffer(b.uniform, 0, u);

    const s = b.stats;
    s.selected = items.length;
    s.visible = visible;
    s.deepestLevel = deepest;
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

  const active: BodyState[] = [];

  /** The body whose ground a shadow cascade holds. */
  const cascadeBody = (frame: FrameContext, cascade: ShadowCascadeView): BodyState | undefined => {
    if (cascade.anchor.kind === 'body') return active.find((b) => b.id === cascade.anchor.id);
    // A vessel-anchored cascade is re-rendered every frame, so the ground under the vessel may be in it.
    let target: BodyState | undefined;
    let best = Infinity;
    for (const b of active) {
      const alt = frame.bodies[b.bodyIndex]!.cameraAltitude;
      if (alt < best) {
        best = alt;
        target = b;
      }
    }
    return target;
  };

  const rocksSeparate = options.rocksSeparate === true && options.rocks !== false;
  const coverSeparate = options.rocksSeparate === true && options.cover !== false;
  const coverFeature: RenderFeature | null = coverSeparate
    ? {
        id: `${options.id ?? 'terrain'}-cover`,
        order: (options.order ?? -50) + 2,
        // The ground cover belongs to the terrain feature, which builds it in its own init and prepare.
        init() {},
        drawGBuffer(_frame, pass) {
          if (!initialised) return;
          const t0 = performance.now();
          cover?.drawGBuffer(pass);
          const dt = performance.now() - t0;
          cpu.cover += dt;
          drawMs += dt;
        },
        drawShadow(frame, pass, cascade: ShadowCascadeView) {
          if (!initialised) return;
          const t0 = performance.now();
          const b = cascadeBody(frame, cascade);
          if (b) cover?.drawShadow(pass, cascade, b.id);
          const dt = performance.now() - t0;
          cpu.cover += dt;
          drawMs += dt;
        },
      }
    : null;
  const rocksFeature: RenderFeature | null = rocksSeparate
    ? {
        id: `${options.id ?? 'terrain'}-rocks`,
        order: (options.order ?? -50) + 1,
        // The rock field belongs to the terrain feature, which builds it in its own init and prepare.
        init() {},
        drawGBuffer(_frame, pass) {
          if (!initialised) return;
          const t0 = performance.now();
          rocks?.drawGBuffer(pass);
          const dt = performance.now() - t0;
          cpu.rocks += dt;
          drawMs += dt;
        },
        drawShadow(frame, pass, cascade: ShadowCascadeView) {
          if (!initialised) return;
          const t0 = performance.now();
          const b = cascadeBody(frame, cascade);
          if (b) rocks?.drawShadow(pass, cascade, b.id);
          const dt = performance.now() - t0;
          cpu.rocks += dt;
          drawMs += dt;
        },
      }
    : null;

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
      // Regolith surfaces are lit by this package's version of the regolith BRDF (shaders/lighting.ts).
      if (candidates.some((d) => d.render.surface!.brdf === 'hapke')) ctx.shaders.register('brdf_regolith', regolithBrdfWgsl());
      // Land is lit by this package's version of the terrain BRDF (the shadows of relief below the mesh).
      if (candidates.some((d) => d.render.surface!.brdf !== 'hapke')) ctx.shaders.register('brdf_terrain', TERRAIN_BRDF_WGSL);

      streamer = new TileStreamer(
        ctx,
        defs,
        candidates.map((d) => d.id),
        options.streamer,
      );
      slots = streamer.options.tileLayers;
      records = new Float32Array(slots * RECORD_FLOATS);
      tileFrames = new Float32Array(slots * TILE_FRAME_FLOATS);
      recordBuffer = device.createBuffer({ label: 'terrain.records', size: slots * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      tileFrameBuffer = device.createBuffer({ label: 'terrain.tileFrames', size: slots * TILE_FRAME_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
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
          { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      nearField = core.createSceneBindings(3, 11, ['oceanNearField']);
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
          arr(7),
          arr(8),
          { binding: 9, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 10, visibility: F, buffer: { type: 'uniform' } },
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
        // The always-resident levels are on their way from here on: they bake while the other features start.
        streamer.setResidentLevels(b.stream, pinLevel, pinLevel);
      }
      if (options.rocks !== false) rocks = new RockRenderer(ctx, provider, bodies.map((b) => ({ id: b.id, def: b.def, params: b.params, set: b.set, albedoAt: b.albedoAt })));
      if (options.cover !== false) {
        const covered: CoverBodyInfo[] = [];
        for (const b of bodies) {
          const def = b.set.manifest.cover;
          if (def && b.landcover) covered.push({ id: b.id, def: b.def, cover: def, tileset: b.def.terrain!.tileset, landcover: b.landcover, sites: b.sites, seaLevel: b.hasOcean ? b.seaLevel : null });
        }
        if (covered.length > 0) cover = new CoverRenderer(ctx, provider, source, noiseView, covered);
      }

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
      const t0 = performance.now();
      frameIndex = frame.frameIndex;
      clock += frame.realDt;
      recordsUsed = 0;
      instanceCount = 0;
      prefetchMs = 0;
      active.length = 0;
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
        active.push(b);
        selectBody(b, frame, pose);
      }
      ctx.perf.cpuEnd('terrain.select');
      const t1 = performance.now();
      selectMs = t1 - t0 - prefetchMs;
      ctx.perf.cpuBegin('terrain.stream');
      // Fit the view into the pools: the live demand of the last passes against the capacity, and the factor
      // on K that the next selection runs with (the body nearest to the camera carries almost all of it).
      demand = streamer.demand(frameIndex, PREFETCH_EVERY - 1);
      let lead: BodyState | null = null;
      for (const b of active) if (!lead || frame.bodies[b.bodyIndex]!.cameraAltitude < frame.bodies[lead.bodyIndex]!.cameraAltitude) lead = b;
      if (lead) {
        const fullK = lodK(frame.renderSize[1], frame.camera.fovY, ctx.quality.terrainPxPerQuad);
        // (Never below what K's own floor lets take effect: the way back up would be idle time.)
        lodScale = Math.max(Math.min(1, LOD_K_MIN / fullK), fitLodScale(lodScale, Math.min(1, lead.K / fullK), demand.ratio, frame.realDt));
      }
      streamer.noteFit(lodScale, demand);
      streamer.update(frameIndex);
      ctx.perf.cpuEnd('terrain.stream');
      const t2 = performance.now();
      for (const b of active) buildBody(b, frame, frame.bodies[b.bodyIndex]!);
      uploadRecords();
      if (instanceCount > 0) device.queue.writeBuffer(instanceBuffer, 0, instances, 0, instanceCount);
      const t3 = performance.now();
      rocks?.prepare(frame, rocksEnabled ? active.map((b) => ({ id: b.id, bodyIndex: b.bodyIndex, observers: b.observers })) : []);
      const t3b = performance.now();
      cover?.prepare(
        frame,
        coverEnabled
          ? active.map((b) => {
              const pose = frame.bodies[b.bodyIndex]!;
              const o = b.observers[0]!;
              return { id: b.id, bodyIndex: b.bodyIndex, eye: o.pos, r: o.r, dir: o.dir, frustum: frustumOf(frame, pose) };
            })
          : [],
      );
      ctx.perf.counter('terrain.tiles', bodies.reduce((a, b) => a + b.stats.visible, 0));
      ctx.perf.counter('terrain.queue', streamer.stats().queued + streamer.stats().loading);
      const t4 = performance.now();
      cpu.stream = t2 - t1;
      cpu.upload = streamer.stats().lastUploadMs;
      cpu.build = t3 - t2;
      cpu.rocks = t3b - t3;
      cpu.cover = t4 - t3b;
      cpu.shadow = 0;
      cpu.gbuffer = 0;
      prepareMs = t4 - t0;
      drawMs = 0;
    },

    drawGBuffer(_frame, pass) {
      if (!initialised) return;
      const t0 = performance.now();
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
      if (!rocksSeparate) rocks?.drawGBuffer(pass);
      if (!coverSeparate) cover?.drawGBuffer(pass);
      const dt = performance.now() - t0;
      cpu.gbuffer += dt;
      drawMs += dt;
    },

    drawShadow(frame, pass, cascade: ShadowCascadeView) {
      if (!initialised) return;
      const t0 = performance.now();
      const b = cascadeBody(frame, cascade);
      if (!b) return;
      // Cascade clip coordinates of a body-fixed point: clip_r = A_r . p + B_r (orthographic, w = 1).
      const m = cascade.viewProj;
      const A = cascadeA;
      const B = cascadeB;
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
      if (casterScratch.length > 0) {
        const time = clock;
        const fullStart = instanceCount;
        for (const it of casterScratch) {
          if (it.quadrant >= 0) continue;
          pushInstance(recordOf(b, it.node, time), -1);
        }
        const quadStart = instanceCount;
        for (const it of casterScratch) {
          if (it.quadrant < 0) continue;
          pushInstance(recordOf(b, it.node, time), it.quadrant);
        }
        const end = instanceCount;
        uploadRecords();
        if (end > fullStart) device.queue.writeBuffer(instanceBuffer, fullStart * 4, instances, fullStart, end - fullStart);
        b.stats.casters += end - fullStart;
        pass.setPipeline(shadowPipeline.get());
        pass.setBindGroup(2, b.tileGroup);
        drawLists(pass, [fullStart, quadStart - fullStart], [quadStart, end - quadStart]);
      }
      const t1 = performance.now();
      cpu.shadow += t1 - t0;
      if (!rocksSeparate && casterScratch.length > 0) {
        rocks?.drawShadow(pass, cascade, b.id);
        cpu.rocks += performance.now() - t1;
      }
      if (!coverSeparate && casterScratch.length > 0) {
        const t2 = performance.now();
        cover?.drawShadow(pass, cascade, b.id);
        cpu.cover += performance.now() - t2;
      }
      drawMs += performance.now() - t0;
    },

    isIdle() {
      if (!initialised) return false;
      if (!streamer.isIdle()) return false;
      if (rocks && !rocks.isIdle()) return false;
      if (cover && !cover.isIdle()) return false;
      // A tile still relaxing from its fade-in changes the image, and so do level ranges that are still moving.
      return bodies.every((b) => b.frameIndex !== frameIndex || (b.tree.fading === 0 && Math.abs(b.K - b.targetK) <= 0.002 * b.targetK));
    },

    rocks: rocksFeature,
    cover: coverFeature,

    dispose() {
      streamer?.dispose();
      rocks?.dispose();
      cover?.dispose();
    },

    debug: {
      stats() {
        return {
          stream: streamer.stats(),
          bodies: Object.fromEntries(bodies.map((b) => [b.id, { ...b.stats }])),
          records: recordsUsed,
          instances: instanceCount,
          selectMs,
          prefetchMs,
          lodScale,
          demand: { ...demand },
          cpu: { ...cpu, hooks: prepareMs + drawMs },
          materialBytes: bodies.reduce((a, b) => a + b.set.bytes, 0),
          rocks: rocks ? rocks.stats() : { instances: 0, chunks: 0, triangles: 0 },
          cover: cover ? cover.stats() : { instances: 0, chunks: 0, triangles: 0 },
        };
      },
      setStreamDelay(ms: number) {
        streamer.setDelay(ms);
      },
      setUploadBudget(tiles: number, ms: number) {
        streamer.setUploadBudget(tiles, ms);
      },
      setMorphEnabled(on: boolean) {
        morphEnabled = on;
      },
      setRocksEnabled(on: boolean) {
        rocksEnabled = on;
      },
      setCoverEnabled(on: boolean) {
        coverEnabled = on;
      },
      provider: () => provider,
      bodies: () => bodies.map((b) => b.id),
      residency(bodyId) {
        const b = bodies.find((x) => x.id === bodyId);
        if (!b || b.frameIndex < 0) return null;
        const levels = b.def.terrain!.maxRenderLevel + 1;
        const wanted = new Array<number>(levels).fill(0);
        const resident = new Array<number>(levels).fill(0);
        for (const n of b.tree.allNodes()) {
          if (n.neededFrame !== b.frameIndex || n.level >= levels) continue;
          wanted[n.level]!++;
          if (n.state === TILE_READY) resident[n.level]!++;
        }
        let wantedLevel = 0;
        let residentLevel = -1;
        let complete = true;
        for (let l = 0; l < levels; l++) {
          if (wanted[l]! > 0) wantedLevel = l;
          if (complete && resident[l] === wanted[l]) residentLevel = l;
          else complete = false;
        }
        return { wantedLevel, residentLevel: Math.min(residentLevel, wantedLevel), wanted, resident };
      },
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
