/** The platform lab's module worker: the same pack source code as the page, in a worker. */
import { openOpfsCache } from '@/terrain/opfsCache';
import { createPackTileSource } from '@/terrain/packSource';
import { digestTiles, type TileReq } from './shared';

interface Job {
  packListUrl: string;
  set: string;
  tiles: TileReq[];
  cacheBytes: number | null;
}

interface OpfsProbe {
  kind: 'opfs-probe';
  dirName: string;
  read: string;
  write: string;
}

self.onmessage = async (e: MessageEvent<Job | OpfsProbe>) => {
  const t0 = performance.now();
  if ('kind' in e.data) {
    // The OPFS cache opened while the page holds it: read-only here.
    try {
      const { dirName, read, write } = e.data;
      const c = await openOpfsCache({ maxBytes: 1e6, dirName });
      const got = await c.get(read);
      await c.put(write, new Uint8Array(10));
      self.postMessage({ mode: c.mode, got: got ? got.length : null });
    } catch (err) {
      self.postMessage({ error: (err as Error).message });
    }
    return;
  }
  try {
    const { packListUrl, set, tiles, cacheBytes } = e.data;
    const src = createPackTileSource({ packListUrl, cache: cacheBytes ? openOpfsCache({ maxBytes: cacheBytes }) : null });
    const hashes = await digestTiles(src, set, tiles);
    self.postMessage({ hashes, stats: src.stats(), ms: performance.now() - t0, isolated: self.crossOriginIsolated });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
