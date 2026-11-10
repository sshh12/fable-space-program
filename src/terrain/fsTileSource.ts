/**
 * Node-only TileSource over a tile root on disk (vitest, tools, the headless mission). Browser code never
 * imports this module (enforced by tools/dev/boundaries.test.ts); use createFetchTileSource there.
 *
 * Layout: {rootDir}/{tileset}/manifest.json and {rootDir}/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TileKey } from '../core/geo/cubeSphere';
import { tilePath } from '../core/geo/cubeSphere';
import type { TileManifest, TileSource } from '../core/contracts/terrain';
import { layerHasTile } from '../core/contracts/terrain';
import { validateTileManifest } from './tileSource';

/** `rootDir` is the tile root, e.g. <repo>/data/tiles. */
export function createFsTileSource(rootDir: string): TileSource {
  const manifests = new Map<string, Promise<TileManifest>>();

  const manifest = (tileset: string): Promise<TileManifest> => {
    let p = manifests.get(tileset);
    if (!p) {
      p = fs.readFile(path.join(rootDir, tileset, 'manifest.json'), 'utf8').then((text) => validateTileManifest(JSON.parse(text) as unknown, tileset));
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
        const buf = await fs.readFile(file);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (e) {
        throw new Error(`tile ${tileset}/${layer}/${key.face}/${key.level}/${key.x}/${key.y}: ${(e as Error).message} (the manifest promises this tile)`);
      }
    },
    async file(tileset: string, relPath: string): Promise<Uint8Array> {
      const buf = await fs.readFile(path.join(rootDir, tileset, relPath));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}
