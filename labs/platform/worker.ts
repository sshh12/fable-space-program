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

self.onmessage = async (e: MessageEvent<Job>) => {
  const t0 = performance.now();
  try {
    const { packListUrl, set, tiles, cacheBytes } = e.data;
    const src = createPackTileSource({ packListUrl, cache: cacheBytes ? openOpfsCache({ maxBytes: cacheBytes }) : null });
    const hashes = await digestTiles(src, set, tiles);
    self.postMessage({ hashes, stats: src.stats(), ms: performance.now() - t0, isolated: self.crossOriginIsolated });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
