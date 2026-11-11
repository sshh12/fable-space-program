/// <reference lib="webworker" />
/**
 * Terrain tile worker (module worker). Owns one terrain-core height authority fed by a fetch TileSource and
 * answers tile jobs: geometry + normal/material bake, and the decode of the image layers (albedo, night:
 * createImageBitmap; water mask, land cover: tileCodec).
 */
import { deepestAvailable, layerHasTile, TILE_LAYER, type TileLayerManifest, type TileManifest, type TileSource } from '@/core/contracts/terrain';
import type { TileKey } from '@/core/geo/cubeSphere';
import { decodeTileFile, IMAGE_TILE_SIZE } from '@/core/geo/tileCodec';
import { createFetchTileSource, createTerrainProvider, type TerrainAuthority } from '@/terrain';
import { IMAGE_DECODE_OPTIONS, type TileJob, type TileResult, type WorkerInit, type WorkerRequest, type WorkerResponse } from './workerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);

let provider: TerrainAuthority | null = null;
let source: TileSource | null = null;
let ready: Promise<void> | null = null;
const manifests = new Map<string, TileManifest>();
const N = IMAGE_TILE_SIZE;

async function init(msg: WorkerInit): Promise<void> {
  source = createFetchTileSource(msg.tilesUrl);
  // Levels 0..2 of the pyramid per body (17 MB) instead of the manifest's resident level: a worker bakes
  // tiles, it never answers collision queries.
  provider = await createTerrainProvider(msg.defs, source, { bodies: msg.bodies, residentLevel: 2, cacheBytes: msg.cacheBytes });
  for (const id of msg.bodies) {
    const tileset = msg.defs.bodies[id]!.terrain!.tileset;
    manifests.set(tileset, await source.manifest(tileset));
  }
}

/** Small cache of decoded u8 tiles of coarser levels (aux data of tiles deeper than the layer's data). */
const u8Cache = new Map<string, Promise<Uint8Array | null>>();
function u8Tile(tileset: string, layer: string, key: TileKey): Promise<Uint8Array | null> {
  const id = `${tileset}/${layer}/${key.face}/${key.level}/${key.x}/${key.y}`;
  let p = u8Cache.get(id);
  if (!p) {
    p = (async () => {
      const bytes = await source!.tile(tileset, layer, key);
      if (!bytes) return null;
      const t = await decodeTileFile(bytes);
      if (t.kind !== 'u8' || t.width !== N || t.height !== N) throw new Error(`${id}: not a ${N} x ${N} u8 tile`);
      return t.data;
    })();
    u8Cache.set(id, p);
    if (u8Cache.size > 48) u8Cache.delete(u8Cache.keys().next().value!);
  }
  return p;
}

/**
 * One byte channel of a 256 x 256 aux tile for `key` from `layer`: the layer's own tile when it has one,
 * else the sub-rectangle of its deepest ancestor (bilinear for a mask, nearest for class ids).
 */
async function auxChannel(tileset: string, layer: TileLayerManifest | undefined, name: string, key: TileKey, nearest: boolean, out: Uint8Array, channel: number): Promise<void> {
  if (!layer) return;
  const src = deepestAvailable(layer, key);
  if (!layerHasTile(layer, src)) return;
  const data = await u8Tile(tileset, name, src);
  if (!data) return;
  if (src.level === key.level) {
    for (let i = 0, o = channel; i < N * N; i++, o += 2) out[o] = data[i]!;
    return;
  }
  const d = key.level - src.level;
  const scale = 1 / 2 ** d;
  const u0 = (key.x - src.x * 2 ** d) * scale;
  const v0 = (key.y - src.y * 2 ** d) * scale;
  for (let j = 0; j < N; j++) {
    const fy = (v0 + ((j + 0.5) / N) * scale) * N - 0.5;
    for (let i = 0; i < N; i++) {
      const fx = (u0 + ((i + 0.5) / N) * scale) * N - 0.5;
      let value: number;
      if (nearest) {
        const x = Math.min(N - 1, Math.max(0, Math.round(fx)));
        const y = Math.min(N - 1, Math.max(0, Math.round(fy)));
        value = data[y * N + x]!;
      } else {
        const x0 = Math.min(N - 1, Math.max(0, Math.floor(fx)));
        const y0 = Math.min(N - 1, Math.max(0, Math.floor(fy)));
        const x1 = Math.min(N - 1, x0 + 1);
        const y1 = Math.min(N - 1, y0 + 1);
        const tx = Math.min(1, Math.max(0, fx - x0));
        const ty = Math.min(1, Math.max(0, fy - y0));
        value = Math.round((data[y0 * N + x0]! * (1 - tx) + data[y0 * N + x1]! * tx) * (1 - ty) + (data[y1 * N + x0]! * (1 - tx) + data[y1 * N + x1]! * tx) * ty);
      }
      out[(j * N + i) * 2 + channel] = value;
    }
  }
}

async function imageTile(tileset: string, layer: string, key: TileKey): Promise<ImageBitmap | null> {
  const bytes = await source!.tile(tileset, layer, key);
  if (!bytes) return null;
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' }), IMAGE_DECODE_OPTIONS);
  if (bitmap.width !== N || bitmap.height !== N) throw new Error(`${tileset}/${layer}/${key.face}/${key.level}/${key.x}/${key.y}: image is ${bitmap.width} x ${bitmap.height}`);
  return bitmap;
}

let probe: OffscreenCanvasRenderingContext2D | null = null;
/** True when no texel of the image is brighter than 3 / 255 (most night tiles: open ocean, wilderness). */
function isDark(bitmap: ImageBitmap): boolean {
  if (!probe) probe = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
  probe.globalCompositeOperation = 'copy';
  probe.drawImage(bitmap, 0, 0);
  const px = probe.getImageData(0, 0, N, N).data;
  for (let i = 0; i < px.length; i += 4) if (px[i]! > 3 || px[i + 1]! > 3 || px[i + 2]! > 3) return false;
  return true;
}

async function runJob(job: TileJob): Promise<void> {
  const p = provider!;
  const t0 = performance.now();
  await p.prepareTile(job.bodyId, job.key, 'render');
  const bake = p.bakeTile(job.bodyId, job.key);
  const t1 = performance.now();
  const manifest = manifests.get(job.tileset)!;
  let albedo: ImageBitmap | null = null;
  let aux: Uint8Array<ArrayBuffer> | null = null;
  let night: ImageBitmap | null = null;
  let nightDark = false;
  if (job.image) {
    aux = new Uint8Array(N * N * 2);
    const [bitmap] = await Promise.all([
      imageTile(job.tileset, TILE_LAYER.albedo, job.key),
      auxChannel(job.tileset, manifest.layers[TILE_LAYER.watermask], TILE_LAYER.watermask, job.key, false, aux, 0),
      auxChannel(job.tileset, manifest.layers[TILE_LAYER.landcover], TILE_LAYER.landcover, job.key, true, aux, 1),
    ]);
    if (!bitmap) throw new Error(`albedo tile ${job.key.face}/${job.key.level}/${job.key.x}/${job.key.y} of "${job.tileset}" does not exist`);
    albedo = bitmap;
  }
  if (job.night) {
    night = await imageTile(job.tileset, TILE_LAYER.night, job.key);
    if (night && isDark(night)) {
      night.close();
      night = null;
    }
    nightDark = night === null;
  }
  const heights = bake.geometry.heights as Float32Array<ArrayBuffer>;
  const normal = bake.normalMaterial.rgba as Uint8Array<ArrayBuffer>;
  const result: TileResult = {
    type: 'tile',
    id: job.id,
    heights,
    hMin: bake.geometry.hMin,
    hMax: bake.geometry.hMax,
    normal,
    slopeScale: bake.normalMaterial.slopeScale,
    complete: bake.geometry.complete && bake.normalMaterial.complete,
    albedo,
    aux,
    night,
    nightDark,
    bakeMs: t1 - t0,
    imageMs: performance.now() - t1,
  };
  const transfer: Transferable[] = [heights.buffer, normal.buffer];
  if (aux) transfer.push(aux.buffer);
  if (albedo) transfer.push(albedo);
  if (night) transfer.push(night);
  post(result, transfer);
}

scope.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const msg = ev.data;
  if (msg.type === 'init') {
    ready = init(msg).then(
      () => post({ type: 'ready' }),
      (e: unknown) => {
        post({ type: 'error', id: -1, message: e instanceof Error ? e.message : String(e) });
        throw e;
      },
    );
    ready.catch(() => undefined);
    return;
  }
  const job = msg;
  (ready ?? Promise.reject(new Error('tile worker: job before init')))
    .then(() => runJob(job))
    .catch((e: unknown) => post({ type: 'error', id: job.id, message: e instanceof Error ? e.message : String(e) }));
};
