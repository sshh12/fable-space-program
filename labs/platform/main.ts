/**
 * Lab for the pack source (platform-delivery; tests/browser/platform). No drawing: a cross-origin-isolated page
 * that reads tiles through createTileSource({ kind: 'pack' }) on the main thread and in a module worker, with
 * or without the OPFS cache, and computes terrain heights through the real TerrainProvider on the pack source.
 * The spec drives it through window.__platform; the pack list URL comes from the spec (the local stack's).
 */
import type { Vec3 } from '@/core/math/vec3';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { acquireGpu } from '@/core/gpu/device';
import { installTestApi } from '@/core/testing/testApi';
import { loadDefs } from '@/core/defs/loader';
import type { TileKey } from '@/core/geo/cubeSphere';
import { openOpfsCache, OPFS_CACHE_DIR } from '@/terrain/opfsCache';
import { createPackTileSource, type PackSourceStats } from '@/terrain/packSource';
import { createTerrainProvider } from '@/terrain/provider';
import { createTileSource } from '@/terrain/tileSource';
import { digestTiles, type TileReq } from './shared';

declare global {
  interface Window {
    __platform?: PlatformApi;
  }
}

export interface ReadResult {
  hashes: (string | null)[];
  stats: PackSourceStats;
  ms: number;
  isolated: boolean;
}

interface PlatformApi {
  readMain(packListUrl: string, set: string, tiles: TileReq[], cacheBytes: number | null): Promise<ReadResult>;
  readWorker(packListUrl: string, set: string, tiles: TileReq[], cacheBytes: number | null): Promise<ReadResult>;
  terrainBits(packListUrl: string, bodyId: string, dirs: Vec3[], radius: number): Promise<string>;
  clearCache(): Promise<void>;
  /** A pack list held in the page (a blob: URL), for lists the spec builds (mirror only, expired URLs). */
  listUrl(listJson: string): string;
  /** Time to the first tile's bytes and to it decoded (an image layer through createImageBitmap). */
  firstTile(packListUrl: string, set: string, req: TileReq): Promise<{ bytesMs: number; decodedMs: number; bytes: number; stats: PackSourceStats }>;
  specFromCreateTileSource(packListUrl: string): Promise<string>;
  /** The OPFS cache across two contexts (this page and a worker) and with a truncated entry (fix round, item 4). */
  opfsOwnership(): Promise<OpfsOwnership>;
}

export interface OpfsOwnership {
  mainMode: string;
  workerMode: string;
  /** Bytes the worker read of the entry the page wrote (null: a miss). */
  workerGot: number | null;
  /** The worker's put left no file. */
  workerPutIgnored: boolean;
  /** A file whose size is not its key's length: a miss, and removed. */
  truncatedMiss: boolean;
  truncatedRemoved: boolean;
  /** After the page closed its cache, a new one is the owner. */
  reopenedMode: string;
}

const info = document.getElementById('info')!;
const say = (s: string): void => {
  info.textContent = s;
};

window.__platform = {
  async readMain(packListUrl, set, tiles, cacheBytes) {
    const t0 = performance.now();
    const src = createPackTileSource({ packListUrl, cache: cacheBytes ? openOpfsCache({ maxBytes: cacheBytes }) : null });
    const hashes = await digestTiles(src, set, tiles);
    say(`main thread: ${tiles.length} tiles of ${set} in ${(performance.now() - t0).toFixed(0)} ms`);
    return { hashes, stats: src.stats(), ms: performance.now() - t0, isolated: crossOriginIsolated };
  },
  readWorker(packListUrl, set, tiles, cacheBytes) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ReadResult | { error: string }>) => {
        w.terminate();
        if ('error' in e.data) reject(new Error(e.data.error));
        else {
          say(`worker: ${tiles.length} tiles of ${set} in ${e.data.ms.toFixed(0)} ms`);
          resolve(e.data);
        }
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ packListUrl, set, tiles, cacheBytes });
    });
  },
  async terrainBits(packListUrl, bodyId, dirs, radius) {
    const defs = await loadDefs(fetchDefSource());
    const tp = await createTerrainProvider(defs, createTileSource({ kind: 'pack', packListUrl }), { bodies: [bodyId] });
    const view = new DataView(new ArrayBuffer(8));
    let hex = '';
    for (const d of dirs) {
      await tp.ensureLoaded(bodyId, d, radius, 'platform-lab');
      view.setFloat64(0, tp.heightAt(bodyId, d));
      hex += view.getBigUint64(0).toString(16).padStart(16, '0');
    }
    say(`terrain: ${dirs.length} heights of ${bodyId} through the pack source`);
    return hex;
  },
  async clearCache() {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_CACHE_DIR, { recursive: true }).catch(() => undefined);
  },
  listUrl(listJson) {
    return URL.createObjectURL(new Blob([listJson], { type: 'application/json' }));
  },
  async firstTile(packListUrl, set, [layer, face, level, x, y]) {
    const t0 = performance.now();
    const src = createPackTileSource({ packListUrl });
    const b = await src.tile(set, layer, { face: face as TileKey['face'], level, x, y });
    const bytesMs = performance.now() - t0;
    if (!b) throw new Error('no such tile');
    const bmp = await createImageBitmap(new Blob([new Uint8Array(b)], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    bmp.close();
    return { bytesMs, decodedMs: performance.now() - t0, bytes: b.length, stats: src.stats() };
  },
  async opfsOwnership() {
    const dirName = 'fsp-packs-lab-ownership';
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dirName, { recursive: true }).catch(() => undefined);
    const h = 'b'.repeat(32);
    const a = await openOpfsCache({ maxBytes: 1e6, dirName });
    await a.put(`${h}.0.1000`, new Uint8Array(1000).fill(5));
    await a.flush();
    const worker = await new Promise<{ mode: string; got: number | null }>((resolve, reject) => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ mode: string; got: number | null } | { error: string }>) => {
        w.terminate();
        if ('error' in e.data) reject(new Error(e.data.error));
        else resolve(e.data);
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ kind: 'opfs-probe', dirName, read: `${h}.0.1000`, write: `${h}.1000.10` });
    });
    const dir = await root.getDirectoryHandle(dirName);
    const exists = async (name: string): Promise<boolean> => dir.getFileHandle(name).then(() => true, () => false);
    const workerPutIgnored = !(await exists(`${h}.1000.10`));
    // A file cut short (as a crash or a cleared write could leave it): 10 bytes under a key of 100.
    const truncated = `${h}.5000.100`;
    const fw = await (await dir.getFileHandle(truncated, { create: true })).createWritable();
    await fw.write(new Uint8Array(10));
    await fw.close();
    await a.close();
    const c = await openOpfsCache({ maxBytes: 1e6, dirName });
    const truncatedMiss = (await c.get(truncated)) === null;
    const truncatedRemoved = !(await exists(truncated));
    const out: OpfsOwnership = { mainMode: a.mode, workerMode: worker.mode, workerGot: worker.got, workerPutIgnored, truncatedMiss, truncatedRemoved, reopenedMode: c.mode };
    await c.close();
    await root.removeEntry(dirName, { recursive: true }).catch(() => undefined);
    say(`opfs ownership: ${JSON.stringify(out)}`);
    return out;
  },
  async specFromCreateTileSource(packListUrl) {
    const src = createTileSource({ kind: 'pack', packListUrl });
    const m = await src.manifest('moon');
    return m.contentHash;
  },
};
// The harness contract (labs/template): the test API, the adapter report, ready. The lab draws nothing; the
// adapter is asserted because every browser spec runs on the real GPU.
const testApi = installTestApi({ kind: 'lab', name: 'platform', scenarioId: 'none' });
acquireGpu({ onError: testApi.reportError }).then(
  (gpu) => {
    testApi.setAdapter(gpu.report);
    say('pack source lab: ready');
    testApi.markReady(true);
  },
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? err.message : String(err));
    testApi.markReady(false);
  },
);

export type { TileKey };
