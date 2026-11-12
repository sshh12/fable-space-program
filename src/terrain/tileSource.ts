/**
 * Tile sources (ARCHITECTURE 10.2, 10.4).
 *
 * `createTileSource(spec)` turns a `TileSourceSpec` (plain data: a tile worker receives it in its init
 * message) into a `TileSource`:
 *   fetch  plain files over HTTP: `createFetchTileSource(baseUrl)` below, unchanged;
 *   pack   content-addressed packs from an ordered mirror list (`createPackTileSource`, packSource.ts), with
 *          the OPFS cache in front when the spec asks for it (opfsCache.ts; asking for it where there is no
 *          OPFS throws at once, while at run time any error of the cache is a miss);
 *   fs     a directory of plain files. It needs the Node file system, which browser code must never import,
 *          so this module (part of the client bundle) does not construct it: Node code calls
 *          `createTileSource` of `tileSource.node.ts`, which builds `fs` with `createFsTileSource` (unchanged)
 *          and hands the other kinds to this function. Asking this module for `fs` is an error that says so.
 *
 * The fetch source: body-agnostic, every tile set is served at {baseUrl}/{tileset}/manifest.json and
 * {baseUrl}/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext} (ARCHITECTURE section 10.1). The manifest is
 * fetched once per tile set and cached; tiles the manifest does not promise are never requested
 * (`layerHasTile` decides) and resolve to null; a failed request for a promised tile rejects (a 404 there is
 * a bake bug, not a normal condition).
 */
import type { TileKey } from '../core/geo/cubeSphere';
import { tilePath } from '../core/geo/cubeSphere';
import type { TileManifest, TileSource, TileSourceSpec } from '../core/contracts/terrain';
import { layerHasTile } from '../core/contracts/terrain';
import { openOpfsCache, opfsAvailable } from './opfsCache';
import { createPackTileSource } from './packSource';

/** A TileSource from its plain-data description (browser main thread, workers and Node; `fs` only through tileSource.node.ts). */
export function createTileSource(spec: TileSourceSpec): TileSource {
  switch (spec.kind) {
    case 'fetch':
      return createFetchTileSource(spec.baseUrl);
    case 'pack':
      // Asking for the OPFS cache where there is none (Node) is a configuration error, said at once; at run
      // time every error of the cache is a miss (opfsCache.ts, packSource.ts).
      if (spec.cache && !opfsAvailable()) throw new Error('createTileSource: the pack spec asks for the OPFS cache, but the origin-private file system is not available here (a browser page or worker is needed)');
      return createPackTileSource({
        packListUrl: spec.packListUrl,
        cache: spec.cache ? openOpfsCache({ maxBytes: spec.cache.maxBytes }) : null,
      });
    case 'fs':
      throw new Error(`createTileSource: the "fs" kind (${spec.root}) reads the file system; in Node use createTileSource from src/terrain/tileSource.node.ts`);
  }
}

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
