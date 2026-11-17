/**
 * The terrain feature's tile source as plain data (ARCHITECTURE 10.2, 10.4): one `TileSourceSpec` names where
 * the tile bytes come from, and the main thread and every tile worker turn it into a `TileSource` with
 * `createTileSource` of src/terrain. The default is the plain files of `RenderContext.tilesUrl`.
 */
import type { PackList, TileSourceSpec } from '@/core/contracts/terrain';

/** The plain files under `tilesUrl` (the dev server's /tiles): what the feature streams from when no spec is given. */
export function fetchTileSourceSpec(tilesUrl: string): TileSourceSpec {
  return { kind: 'fetch', baseUrl: tilesUrl };
}

/**
 * The spec with its URLs made absolute against `base` (the page's address). A worker resolves a relative
 * URL against its own script, not against the page, so the spec is handed to it in this form.
 */
export function absoluteTileSourceSpec(spec: TileSourceSpec, base: string): TileSourceSpec {
  switch (spec.kind) {
    case 'fetch':
      return { kind: 'fetch', baseUrl: new URL(spec.baseUrl, base).href };
    case 'pack':
      return { ...spec, packListUrl: new URL(spec.packListUrl, base).href };
    case 'fs':
      return spec;
  }
}

/**
 * The tile sets the source can serve, or null when it does not say (every body with terrain is then tried).
 *   fetch  the dev server lists the baked sets at `<baseUrl>/index.json`; a server without the list answers
 *          with an error status and the result is null (asking for a manifest that is not there would log a 404);
 *   pack   the sets of the pack list.
 */
export async function listTileSets(spec: TileSourceSpec): Promise<string[] | null> {
  switch (spec.kind) {
    case 'fetch': {
      const listing = await fetch(`${spec.baseUrl}/index.json`, { cache: 'no-cache' });
      return listing.ok ? ((await listing.json()) as { tilesets: string[] }).tilesets : null;
    }
    case 'pack': {
      const r = await fetch(spec.packListUrl, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`terrain: the pack list ${spec.packListUrl} answered HTTP ${r.status}`);
      return Object.keys(((await r.json()) as PackList).sets);
    }
    case 'fs':
      throw new Error(`terrain: a tile source of kind "fs" (${spec.root}) reads the file system and cannot be streamed from in a browser`);
  }
}
