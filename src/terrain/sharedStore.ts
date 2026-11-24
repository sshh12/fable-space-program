/**
 * The shard-wide read-only store of decoded tiles (ARCHITECTURE 10.5): one per shard, its tiles in
 * SharedArrayBuffers that every worker isolate of the shard reads. It is IMPLEMENTED by `server-persistence`
 * (server/: the cap per stage, the ten-minute release of tiles outside the resident pyramids, reads by range
 * from the bucket straight into it); a terrain provider is CREATED OVER one with
 * `TerrainProviderOptions.sharedStore`, and then takes every tile from it instead of decoding its own copy
 * (src/terrain/tileStore.ts). The provider's own cache then holds only bookkeeping and its collision memo.
 *
 * The contract:
 *  - A tile is identified by its tile set, layer and key, as on the tile source.
 *  - Height tiles are held as the provider would decode them itself: 259 x 259 int16 counts (row-major, row =
 *    v, the 1-sample border included), value = offset + scale * count, with the tile's hMin / hMax; u8 layers
 *    as 256 x 256 x channels bytes. So a provider over the store answers every query bit for bit as a provider
 *    over the tile source does (tested: tests/unit/terrain-core/sharedStore.test.ts).
 *  - The arrays are VIEWS INTO SHARED MEMORY and are never written by a provider: the seam reconciliation of
 *    height tiles (src/terrain/seams.ts), which writes canonical values into shared border samples, copies a
 *    shared tile into the provider's own memory before its first write (copy-on-write).
 *  - `acquire` resolves when the tile is in the store (reading it from the store's own source if needed); each
 *    acquire is matched by one `release` when the provider drops the tile; the store may keep a released tile
 *    under its own policy. `acquire` resolves to null when the tile set has no such tile.
 *  - The store never changes a tile it has handed out (tiles are immutable for the life of a build of the data).
 */

/** A tile of a tile set: the tile source's key with its set and layer. */
export interface SharedTileKey {
  tileset: string;
  layer: string;
  face: number;
  level: number;
  x: number;
  y: number;
}

/** A decoded height tile (frt1-height): int16 counts and their scale and offset, metres. */
export interface SharedHeightTile {
  kind: 'height';
  q: Int16Array;
  scale: number;
  offset: number;
  hMin: number;
  hMax: number;
}

/** A decoded byte tile (frt1-u8): 256 x 256 x channels. */
export interface SharedU8Tile {
  kind: 'u8';
  channels: number;
  data: Uint8Array;
}

export type SharedTile = SharedHeightTile | SharedU8Tile;

export interface SharedTileStore {
  /** The tile when the store holds it now (no I/O), else null. */
  peek(key: SharedTileKey): SharedTile | null;
  /** The tile, brought into the store if needed; null when the tile set has no such tile. One `release` per call. */
  acquire(key: SharedTileKey): Promise<SharedTile | null>;
  /** The caller no longer reads the tile it acquired. */
  release(key: SharedTileKey): void;
  /** The store's cap, bytes (a setting per stage: 256 MB at stage 0). */
  readonly capBytes: number;
}
