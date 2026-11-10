/**
 * Node-only TileSource over a tile root on disk (vitest, tools, the headless mission). Browser code never
 * imports this module (enforced by tools/dev/boundaries.test.ts); use createFetchTileSource there.
 *
 * Layout: {rootDir}/{tileset}/manifest.json and {rootDir}/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}.
 *
 * Reads are queued so that at most MAX_OPEN_READS files are open at once: one ensureLoaded over land cover and
 * heights can request thousands of tiles, and an unbounded fan-out of readFile fails with EMFILE (the browser
 * queues fetches itself). The queue only delays I/O; the tile cache's decisions never depend on I/O timing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TileKey } from '../core/geo/cubeSphere';
import { tilePath } from '../core/geo/cubeSphere';
import type { TileManifest, TileSource } from '../core/contracts/terrain';
import { layerHasTile } from '../core/contracts/terrain';
import { validateTileManifest } from './tileSource';

/** Most files one fs tile source keeps open at the same time. */
export const MAX_OPEN_READS = 64;

/** `rootDir` is the tile root, e.g. <repo>/data/tiles. */
export function createFsTileSource(rootDir: string): TileSource {
  const manifests = new Map<string, Promise<TileManifest>>();
  let open = 0;
  const waiting: (() => void)[] = [];

  /** readFile through the open-file queue (FIFO). */
  const read = async (file: string): Promise<Buffer> => {
    if (open >= MAX_OPEN_READS) await new Promise<void>((resolve) => waiting.push(resolve));
    else open++;
    try {
      return await fs.readFile(file);
    } finally {
      const next = waiting.shift();
      // Hand the slot straight to the next waiter (open stays the same), or free it.
      if (next) next();
      else open--;
    }
  };

  const manifest = (tileset: string): Promise<TileManifest> => {
    let p = manifests.get(tileset);
    if (!p) {
      p = read(path.join(rootDir, tileset, 'manifest.json')).then((buf) => validateTileManifest(JSON.parse(buf.toString('utf8')) as unknown, tileset));
      p.catch(() => manifests.delete(tileset));
      manifests.set(tileset, p);
    }
    return p;
  };

  return {
    manifest,
    async tile(tileset: string, layer: string, key: TileKey): Promise<Uint8Array | null> {
      const m = await manifest(tileset);
      const lm = m.layers[layer];
      if (!lm || !layerHasTile(lm, key)) return null;
      const file = path.join(rootDir, tilePath(tileset, layer, key, lm.ext));
      try {
        const buf = await read(file);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (e) {
        throw new Error(`tile ${tileset}/${layer}/${key.face}/${key.level}/${key.x}/${key.y}: ${(e as Error).message} (the manifest promises this tile)`);
      }
    },
    async file(tileset: string, relPath: string): Promise<Uint8Array> {
      const buf = await read(path.join(rootDir, tileset, relPath));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}
