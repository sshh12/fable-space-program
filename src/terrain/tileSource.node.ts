/**
 * `createTileSource(spec)` for Node (vitest, tools, the server roles): every kind of `TileSourceSpec`,
 * including `fs`, which needs the Node file system and is therefore built here and not in tileSource.ts
 * (part of the client bundle; browser code never imports this module, enforced by tools/dev/boundaries).
 */
import type { TileSource, TileSourceSpec } from '../core/contracts/terrain';
import { createFsTileSource } from './fsTileSource';
import { createTileSource as createBrowserSafeTileSource } from './tileSource';

export function createTileSource(spec: TileSourceSpec): TileSource {
  return spec.kind === 'fs' ? createFsTileSource(spec.root) : createBrowserSafeTileSource(spec);
}
