/**
 * Fetch-based TileSource for the browser main thread and module workers. Body-agnostic: every tile set is
 * served at {baseUrl}/{tileset}/manifest.json and {baseUrl}/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}
 * (ARCHITECTURE section 7.1). The manifest is fetched once per tile set and cached; tiles the manifest does
 * not promise are never requested (`layerHasTile` decides) and resolve to null; a failed request for a
 * promised tile rejects (a 404 there is a bake bug, not a normal condition).
 */
import type { TileKey } from '../core/geo/cubeSphere';
import { tilePath } from '../core/geo/cubeSphere';
import type { TileManifest, TileSource } from '../core/contracts/terrain';
import { layerHasTile } from '../core/contracts/terrain';

/** Validate the parts of a manifest the height authority relies on; throws with the tile set name. */
export function validateTileManifest(m: unknown, tileset: string): TileManifest {
  const fail = (msg: string): never => {
    throw new Error(`tile set "${tileset}": manifest ${msg}`);
  };
  if (typeof m !== 'object' || m === null) return fail('is not an object');
  const t = m as Partial<TileManifest>;
  if (t.formatVersion !== 1) fail('formatVersion must be 1');
  if (t.mapping !== 'gnomonic-cube') fail(`mapping must be "gnomonic-cube"`);
  if (typeof t.radius !== 'number' || !(t.radius > 0)) fail('radius missing');
  if (typeof t.layers !== 'object' || t.layers === null) fail('layers missing');
  if (typeof t.residentHeightLevel !== 'number') fail('residentHeightLevel missing');
  for (const [name, layer] of Object.entries(t.layers!)) {
    if (typeof layer.globalMaxLevel !== 'number') fail(`layer ${name}: globalMaxLevel missing`);
    if (typeof layer.ext !== 'string') fail(`layer ${name}: ext missing`);
    if (layer.coverage === undefined) (layer as { coverage: TileManifest['layers'][string]['coverage'] }).coverage = {};
  }
  return t as TileManifest;
}

function cacheBust(m: TileManifest): string {
  return typeof m.contentHash === 'string' && m.contentHash.length > 0 ? `?v=${encodeURIComponent(m.contentHash)}` : '';
}

/**
 * `baseUrl` is the tile root without a trailing slash, e.g. "/tiles" (the dev server maps it to data/tiles).
 * Uses the global `fetch`, so it works unchanged on the main thread and inside workers.
 */
export function createFetchTileSource(baseUrl: string): TileSource {
  const root = baseUrl.replace(/\/+$/, '');
  const manifests = new Map<string, Promise<TileManifest>>();

  const manifest = (tileset: string): Promise<TileManifest> => {
    let p = manifests.get(tileset);
    if (!p) {
      p = fetch(`${root}/${tileset}/manifest.json`, { cache: 'no-cache' }).then(async (r) => {
        if (!r.ok) throw new Error(`tile set "${tileset}": manifest HTTP ${r.status}`);
        return validateTileManifest(await r.json(), tileset);
      });
      // A failed manifest fetch is not cached, so a later call can retry.
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
      const url = `${root}/${tilePath(tileset, layer, key, lm.ext)}${cacheBust(m)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`tile ${tileset}/${layer}/${key.face}/${key.level}/${key.x}/${key.y}: HTTP ${r.status} for a tile the manifest promises`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async file(tileset: string, relPath: string): Promise<Uint8Array> {
      const m = await manifest(tileset);
      const r = await fetch(`${root}/${tileset}/${relPath.replace(/^\/+/, '')}${cacheBust(m)}`);
      if (!r.ok) throw new Error(`tile set "${tileset}": file ${relPath}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}
