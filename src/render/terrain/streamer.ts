/**
 * Tile streaming: the worker pool, the request queue (priorities, cancellation of stale requests), the
 * per-frame upload budget, the fixed GPU pools and LRU eviction. One streamer serves every terrain body.
 *
 * Life of a tile: EMPTY -> QUEUED (wanted by a selection pass) -> LOADING (a worker bakes and decodes it)
 * -> UPLOADING (result waits for its turn in the upload budget) -> READY (layers written, mips encoded).
 * A READY tile with READY children, a pinned tile (always-resident levels) and a tile touched recently are
 * never evicted, so a drawn tile's parents and image owners are always resident.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderContext } from '@/core/contracts/render';
import type { TileLayerManifest } from '@/core/contracts/terrain';
import { coreOf } from '@/render/core';
import { BatchMipGenerator, LayerPool } from './gpuPools';
import { GRID_VERTS } from './lod';
import { BodyQuadtree, NIGHT_DARK, TILE_EMPTY, TILE_LOADING, TILE_QUEUED, TILE_READY, TILE_UPLOADING, type TileNode } from './quadtree';
import { ownsData } from './records';
import type { TileJob, TileResult, WorkerInit, WorkerResponse } from './workerProtocol';

export interface StreamBody {
  id: string;
  tileset: string;
  tree: BodyQuadtree;
  albedoLayer: TileLayerManifest;
  /** Night-light layer, when the body shows night lights and its tile set has one. */
  nightLayer: TileLayerManifest | undefined;
}

export interface StreamerOptions {
  /** Module workers (default min(8, cores - 2)). */
  workers: number;
  /** Layers of the height and normal/material arrays (one of each per render tile). */
  tileLayers: number;
  /** Layers of the albedo and aux arrays (one of each per tile with image data of its own). */
  imageLayers: number;
  /** Layers of the night-light array (one channel; dark tiles take none). */
  nightLayers: number;
  /** Upload budget per frame: tiles and milliseconds, whichever is reached first. */
  uploadTiles: number;
  uploadMs: number;
  /** Decoded-tile cache of each worker's height authority, bytes. */
  workerCacheBytes: number;
}

export const DEFAULT_STREAMER_OPTIONS: StreamerOptions = {
  workers: Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2)),
  tileLayers: 1280,
  imageLayers: 1024,
  nightLayers: 512,
  uploadTiles: 8,
  uploadMs: 2,
  workerCacheBytes: 96 * 1024 * 1024,
};

/** Frames a queued request survives without being wanted again (prefetch passes run every few frames). */
const STALE_FRAMES = 12;
/** Frames a READY tile is protected from eviction after it was last touched. */
const KEEP_FRAMES = 90;
const IMAGE_SIZE = 256;

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  job: { id: number; node: TileNode; body: StreamBody } | null;
}

interface Arrived {
  result: TileResult;
  node: TileNode;
  body: StreamBody;
  /** performance.now() from which the result may be uploaded (artificial streaming delay). */
  at: number;
}

export interface StreamStats {
  queued: number;
  loading: number;
  uploading: number;
  ready: number;
  freeTileLayers: number;
  freeImageLayers: number;
  freeNightLayers: number;
  uploadedTotal: number;
  evictedTotal: number;
  cancelledTotal: number;
  /** Uploads that had to wait because a pool was full and nothing could be evicted. */
  stalledTotal: number;
  /** Bakes the height authority flagged as computed on incomplete data. */
  incompleteBakes: number;
  /** Largest number of tiles and milliseconds spent on uploads in one frame. */
  maxUploadTiles: number;
  maxUploadMs: number;
  /** 99th percentile of the upload time over the last 512 frames that uploaded something, ms. */
  uploadMsP99: number;
  lastUploadMs: number;
  /** Mean worker times of completed jobs, ms. */
  bakeMs: number;
  imageMs: number;
  jobs: number;
  /** Bytes of the terrain texture pools. */
  poolBytes: number;
}

export class TileStreamer {
  readonly heights: LayerPool;
  readonly normals: LayerPool;
  readonly albedo: LayerPool;
  readonly aux: LayerPool;
  readonly night: LayerPool;
  readonly options: StreamerOptions;
  private readonly mips: BatchMipGenerator;
  private readonly bodies: StreamBody[] = [];
  private readonly workers: WorkerSlot[] = [];
  private readonly queue = new Set<TileNode>();
  private readonly queueBody = new Map<TileNode, StreamBody>();
  private readonly arrived: Arrived[] = [];
  private readonly jobs = new Map<number, WorkerSlot>();
  private nextJob = 1;
  private frame = 0;
  private delayMs = 0;
  private readyCount = 0;
  private failed = false;
  private disposed = false;
  private readonly s: StreamStats = {
    queued: 0,
    loading: 0,
    uploading: 0,
    ready: 0,
    freeTileLayers: 0,
    freeImageLayers: 0,
    freeNightLayers: 0,
    uploadedTotal: 0,
    evictedTotal: 0,
    cancelledTotal: 0,
    stalledTotal: 0,
    incompleteBakes: 0,
    maxUploadTiles: 0,
    maxUploadMs: 0,
    uploadMsP99: 0,
    lastUploadMs: 0,
    bakeMs: 0,
    imageMs: 0,
    jobs: 0,
    poolBytes: 0,
  };
  /** Running mean of the main-thread cost of uploading one tile, ms. */
  private tileUploadMs = 0.3;
  /** Running estimate of the cost of encoding and submitting the mip passes of a frame's uploads, ms. */
  private mipMs = 0.4;
  private readonly uploadTimes = new Float32Array(512);
  private uploadTimeCount = 0;
  private bakeSum = 0;
  private imageSum = 0;

  constructor(
    private readonly ctx: RenderContext,
    defs: DefLibrary,
    bodyIds: string[],
    options: Partial<StreamerOptions> = {},
  ) {
    this.options = { ...DEFAULT_STREAMER_OPTIONS, ...options };
    const o = this.options;
    this.heights = new LayerPool(ctx, 'terrain.heights', 'r32float', GRID_VERTS, o.tileLayers, false, 4);
    this.normals = new LayerPool(ctx, 'terrain.normals', 'rgba8unorm', IMAGE_SIZE, o.tileLayers, true, 4);
    this.albedo = new LayerPool(ctx, 'terrain.albedo', 'rgba8unorm-srgb', IMAGE_SIZE, o.imageLayers, true, 4);
    this.aux = new LayerPool(ctx, 'terrain.aux', 'rg8unorm', IMAGE_SIZE, o.imageLayers, true, 2);
    // Night lights keep one channel (the sRGB-encoded red of the image; the colour is a per-body tint), so that
    // every always-resident tile can hold its lights within the VRAM budget.
    this.night = new LayerPool(ctx, 'terrain.night', 'r8unorm', IMAGE_SIZE, o.nightLayers, true, 1);
    this.s.poolBytes = this.heights.bytes + this.normals.bytes + this.albedo.bytes + this.aux.bytes + this.night.bytes;
    this.mips = new BatchMipGenerator(ctx);

    // The height authority in a worker needs the body and site definitions only.
    const workerDefs: DefLibrary = { bodies: defs.bodies, rootBodyId: defs.rootBodyId, sites: defs.sites, resources: {}, parts: {}, vehicles: {}, scenarios: {}, sections: {} };
    const init: WorkerInit = { type: 'init', defs: workerDefs, tilesUrl: new URL(ctx.tilesUrl, globalThis.location.href).href, bodies: bodyIds, cacheBytes: o.workerCacheBytes };
    for (let i = 0; i < o.workers; i++) {
      const worker = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module', name: `terrain-tiles-${i}` });
      const slot: WorkerSlot = { worker, ready: false, job: null };
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(slot, ev.data);
      worker.onerror = (ev) => this.fail(`terrain tile worker ${i}: ${ev.message || 'failed to start'}`);
      worker.postMessage(init);
      this.workers.push(slot);
    }
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.failed = true;
    coreOf(this.ctx).reportError(message);
  }

  addBody(body: StreamBody): void {
    this.bodies.push(body);
  }

  /** Delay every worker result by `ms` before it may be uploaded (tests of late streaming). */
  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /**
   * Levels 0..pinLevel of a body are always resident (never evicted); levels up to `preloadLevel` are
   * loaded now as well and then kept like any other tile (evicted only when a pool is full and they have
   * not been touched for a while).
   */
  setResidentLevels(body: StreamBody, pinLevel: number, preloadLevel: number): void {
    const visit = (n: TileNode): void => {
      const pin = n.level <= pinLevel;
      if (n.state === TILE_EMPTY && !n.failed) {
        // Pinned while it loads, so that the request is neither cancelled nor dropped on arrival.
        n.pinned = true;
        n.preload = !pin;
        this.enqueue(n, body, 1e9 - n.level * 1e6);
      } else if (n.state === TILE_READY) {
        n.pinned = pin;
        n.preload = false;
      } else if (pin) {
        n.pinned = true;
        n.preload = false;
      }
      if (n.level < Math.max(pinLevel, preloadLevel)) for (const c of body.tree.childrenOf(n)) visit(c);
    };
    for (const root of body.tree.roots) visit(root);
  }

  private enqueue(n: TileNode, body: StreamBody, priority: number): void {
    n.state = TILE_QUEUED;
    n.priority = priority;
    this.queue.add(n);
    this.queueBody.set(n, body);
  }

  private onMessage(slot: WorkerSlot, msg: WorkerResponse): void {
    if (this.disposed) return;
    if (msg.type === 'ready') {
      slot.ready = true;
      return;
    }
    if (msg.type === 'error') {
      this.fail(`terrain tile worker: ${msg.message}`);
      const job = slot.job;
      if (job && job.id === msg.id) {
        slot.job = null;
        this.jobs.delete(job.id);
        job.node.state = TILE_EMPTY;
        job.node.failed = true;
      }
      return;
    }
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    slot.job = null;
    this.jobs.delete(job.id);
    // prepareTile loads everything a bake reads, so an incomplete bake is a defect of the height authority
    // (docs/requests/terrain-render-1.md was one): report it with the tile key, and count it.
    if (!msg.complete) {
      this.s.incompleteBakes++;
      coreOf(this.ctx).reportError(`terrain tile ${job.body.id} ${job.node.key.face}/${job.node.key.level}/${job.node.key.x}/${job.node.key.y}: baked on incomplete data`);
    }
    this.bakeSum += msg.bakeMs;
    this.imageSum += msg.imageMs;
    this.s.jobs++;
    job.node.state = TILE_UPLOADING;
    this.arrived.push({ result: msg, node: job.node, body: job.body, at: performance.now() + this.delayMs });
  }

  /**
   * Once per frame, after the selection passes: take the bodies' wanted tiles, cancel stale requests,
   * hand jobs to idle workers by priority, and upload finished tiles within the budget.
   */
  update(frameIndex: number): void {
    this.frame = frameIndex;
    for (const body of this.bodies) {
      for (const n of body.tree.wanted) {
        if (n.state === TILE_EMPTY && !n.failed) this.enqueue(n, body, n.priority);
      }
      body.tree.wanted.length = 0;
    }
    // Cancel requests nobody has asked for lately (the camera moved on) before a worker starts them.
    for (const n of this.queue) {
      if (!n.pinned && n.lastTouched < frameIndex - STALE_FRAMES) {
        this.queue.delete(n);
        this.queueBody.delete(n);
        n.state = TILE_EMPTY;
        this.s.cancelledTotal++;
      }
    }
    this.dispatch();
    this.upload();
    const st = this.s;
    st.queued = this.queue.size;
    st.loading = this.jobs.size;
    st.uploading = this.arrived.length;
    st.ready = this.readyCount;
    st.freeTileLayers = this.heights.freeLayers;
    st.freeImageLayers = this.albedo.freeLayers;
    st.freeNightLayers = this.night.freeLayers;
    st.bakeMs = st.jobs > 0 ? this.bakeSum / st.jobs : 0;
    st.imageMs = st.jobs > 0 ? this.imageSum / st.jobs : 0;
  }

  private dispatch(): void {
    if (this.queue.size === 0) return;
    for (const slot of this.workers) {
      if (!slot.ready || slot.job) continue;
      let best: TileNode | null = null;
      for (const n of this.queue) if (!best || n.priority > best.priority) best = n;
      if (!best) return;
      const body = this.queueBody.get(best)!;
      this.queue.delete(best);
      this.queueBody.delete(best);
      best.state = TILE_LOADING;
      const id = this.nextJob++;
      const job: TileJob = { type: 'tile', id, bodyId: body.id, tileset: body.tileset, key: best.key, image: ownsData(body.albedoLayer, best), night: ownsData(body.nightLayer, best) };
      slot.job = { id, node: best, body };
      this.jobs.set(id, slot);
      slot.worker.postMessage(job);
    }
  }

  private discard(a: Arrived): void {
    a.result.albedo?.close();
    a.result.night?.close();
    a.node.state = TILE_EMPTY;
  }

  private upload(): void {
    if (this.arrived.length === 0) {
      this.s.lastUploadMs = 0;
      return;
    }
    const t0 = performance.now();
    const o = this.options;
    const device = this.ctx.device;
    const fresh = { normals: [] as number[], albedo: [] as number[], aux: [] as number[], night: [] as number[] };
    let count = 0;
    let i = 0;
    // At least one tile per frame; after that, stop before the tile that would take the frame over the
    // time budget, judging by the mean cost of a tile so far.
    while (i < this.arrived.length && count < o.uploadTiles && (count === 0 || performance.now() - t0 + this.tileUploadMs + this.mipMs < o.uploadMs)) {
      const a = this.arrived[i]!;
      if (a.at > t0) {
        i++;
        continue;
      }
      const n = a.node;
      const r = a.result;
      // The camera has moved on while the tile was baked: drop it rather than spend a layer on it.
      if (!n.pinned && n.lastTouched < this.frame - STALE_FRAMES) {
        this.arrived.splice(i, 1);
        this.discard(a);
        this.s.cancelledTotal++;
        continue;
      }
      const needImage = r.albedo !== null;
      const needNight = r.night !== null;
      if (!this.reserve(n, needImage, needNight)) {
        this.s.stalledTotal++;
        // A pinned tile that finds no room means the pools are too small for the always-resident levels.
        if (n.pinned && !this.failed && t0 - a.at > 20_000) this.fail(`terrain: no free texture layer for an always-resident tile of "${a.body.id}" (pools too small)`);
        i++;
        continue;
      }
      this.arrived.splice(i, 1);
      const layer = this.heights.alloc();
      n.heightLayer = layer;
      n.normalLayer = layer;
      this.normals.alloc();
      device.queue.writeTexture({ texture: this.heights.texture, origin: [0, 0, layer] }, r.heights, { bytesPerRow: GRID_VERTS * 4, rowsPerImage: GRID_VERTS }, [GRID_VERTS, GRID_VERTS, 1]);
      device.queue.writeTexture({ texture: this.normals.texture, origin: [0, 0, layer] }, r.normal, { bytesPerRow: IMAGE_SIZE * 4, rowsPerImage: IMAGE_SIZE }, [IMAGE_SIZE, IMAGE_SIZE, 1]);
      fresh.normals.push(layer);
      if (r.albedo) {
        const il = this.albedo.alloc();
        this.aux.alloc();
        n.imageLayer = il;
        device.queue.copyExternalImageToTexture({ source: r.albedo }, { texture: this.albedo.texture, origin: [0, 0, il], premultipliedAlpha: false }, [IMAGE_SIZE, IMAGE_SIZE]);
        r.albedo.close();
        device.queue.writeTexture({ texture: this.aux.texture, origin: [0, 0, il] }, r.aux!, { bytesPerRow: IMAGE_SIZE * 2, rowsPerImage: IMAGE_SIZE }, [IMAGE_SIZE, IMAGE_SIZE, 1]);
        fresh.albedo.push(il);
        fresh.aux.push(il);
      }
      if (r.night) {
        const nl = this.night.alloc();
        n.nightLayer = nl;
        device.queue.copyExternalImageToTexture({ source: r.night }, { texture: this.night.texture, origin: [0, 0, nl], premultipliedAlpha: false }, [IMAGE_SIZE, IMAGE_SIZE]);
        r.night.close();
        fresh.night.push(nl);
      } else if (r.nightDark) {
        n.nightLayer = NIGHT_DARK;
      }
      n.slopeScale = r.slopeScale;
      a.body.tree.applyBake(n, r.hMin, r.hMax);
      n.h0 = 0.5 * (r.hMin + r.hMax);
      const rr = a.body.tree.radius + n.h0;
      n.origin = { x: n.frame.cHat.x * rr, y: n.frame.cHat.y * rr, z: n.frame.cHat.z * rr };
      n.constants = null;
      n.imageOwner = null;
      n.nightOwner = null;
      n.state = TILE_READY;
      n.lastTouched = Math.max(n.lastTouched, this.frame);
      if (n.preload) {
        n.preload = false;
        n.pinned = false;
      }
      if (n.parent) n.parent.readyChildren++;
      this.readyCount++;
      this.s.uploadedTotal++;
      count++;
    }
    const tMips = performance.now();
    if (count > 0) {
      const encoder = device.createCommandEncoder({ label: 'terrain.upload' });
      this.mips.generate(encoder, this.normals, fresh.normals);
      this.mips.generate(encoder, this.albedo, fresh.albedo);
      this.mips.generate(encoder, this.aux, fresh.aux);
      this.mips.generate(encoder, this.night, fresh.night);
      device.queue.submit([encoder.finish()]);
    }
    const ms = performance.now() - t0;
    if (count > 0) {
      const mips = performance.now() - tMips;
      // Running estimates, leaning towards the expensive frames (a budget is about the worst ones).
      const perTile = (tMips - t0) / count;
      this.tileUploadMs += (perTile - this.tileUploadMs) * (perTile > this.tileUploadMs ? 0.5 : 0.05);
      this.mipMs += (mips - this.mipMs) * (mips > this.mipMs ? 0.5 : 0.05);
    }
    this.s.lastUploadMs = ms;
    if (count > 0) {
      this.uploadTimes[this.uploadTimeCount++ % this.uploadTimes.length] = ms;
      const n = Math.min(this.uploadTimeCount, this.uploadTimes.length);
      const sorted = Array.from(this.uploadTimes.subarray(0, n)).sort((p, q) => p - q);
      this.s.uploadMsP99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))]!;
    }
    if (count > this.s.maxUploadTiles) this.s.maxUploadTiles = count;
    if (ms > this.s.maxUploadMs) this.s.maxUploadMs = ms;
  }

  /** Make sure the pools have a layer of every kind the tile needs, evicting least-recently-used tiles if not. */
  private reserve(n: TileNode, image: boolean, night: boolean): boolean {
    for (let guard = 0; guard < 8; guard++) {
      const needTile = this.heights.freeLayers === 0;
      const needImage = image && this.albedo.freeLayers === 0;
      const needNight = night && this.night.freeLayers === 0;
      if (!needTile && !needImage && !needNight) return true;
      if (!this.evictOne(n, needImage, needNight)) return false;
    }
    return false;
  }

  private evictOne(keep: TileNode, needImage: boolean, needNight: boolean): boolean {
    let best: TileNode | null = null;
    let bestBody: StreamBody | null = null;
    const limit = this.frame - KEEP_FRAMES;
    for (const body of this.bodies) {
      for (const n of body.tree.allNodes()) {
        if (n.state !== TILE_READY || n.pinned || n.readyChildren > 0 || n.lastTouched >= limit || n === keep) continue;
        if (needImage && n.imageLayer < 0) continue;
        if (needNight && !needImage && n.nightLayer < 0) continue;
        if (n.children && n.children.some((c) => c.state === TILE_LOADING || c.state === TILE_UPLOADING)) continue;
        if (!best || n.lastTouched < best.lastTouched) {
          best = n;
          bestBody = body;
        }
      }
    }
    if (!best || !bestBody) return false;
    this.evict(best, bestBody);
    return true;
  }

  private evict(n: TileNode, body: StreamBody): void {
    if (n.children) {
      for (const c of n.children) {
        if (c.state === TILE_QUEUED) {
          this.queue.delete(c);
          this.queueBody.delete(c);
          c.state = TILE_EMPTY;
        }
      }
      body.tree.dropChildren(n);
    }
    this.heights.release(n.heightLayer);
    this.normals.release(n.normalLayer);
    if (n.imageLayer >= 0) {
      this.albedo.release(n.imageLayer);
      this.aux.release(n.imageLayer);
    }
    if (n.nightLayer >= 0) this.night.release(n.nightLayer);
    n.heightLayer = -1;
    n.normalLayer = -1;
    n.imageLayer = -1;
    n.nightLayer = -1;
    n.constants = null;
    n.imageOwner = null;
    n.nightOwner = null;
    n.state = TILE_EMPTY;
    n.lastCovered = -2;
    if (n.parent) n.parent.readyChildren--;
    this.readyCount--;
    this.s.evictedTotal++;
  }

  /** Nothing queued, baking or waiting for upload (also after a reported worker failure, so callers do not wait forever). */
  isIdle(): boolean {
    return this.failed || (this.queue.size === 0 && this.jobs.size === 0 && this.arrived.length === 0 && this.workers.every((w) => w.ready));
  }

  get workersReady(): boolean {
    return this.workers.every((w) => w.ready);
  }

  stats(): StreamStats {
    return { ...this.s };
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.worker.terminate();
    for (const a of this.arrived) {
      a.result.albedo?.close();
      a.result.night?.close();
    }
    this.arrived.length = 0;
    this.heights.destroy();
    this.normals.destroy();
    this.albedo.destroy();
    this.aux.destroy();
    this.night.destroy();
  }
}
