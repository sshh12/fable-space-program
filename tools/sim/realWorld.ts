/**
 * Node-side construction of the real simulation for tools and tests: the definition library from
 * data/defs, the terrain authority on the baked tiles under data/tiles (fs tile source), and createSim.
 *
 * The tiles are required: `loadRealWorld` throws (it never falls back to synthetic terrain) when a tile
 * set is missing, so that a mission test fails instead of passing on made-up ground.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '@/core/contracts/defs';
import type { TerrainProvider, TileSource } from '@/core/contracts/terrain';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createSim, type SimWorld } from '@/sim';
import { createTerrainProvider, type TerrainAuthority } from '@/terrain';
import { createFsTileSource } from '@/terrain/fsTileSource';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const tilesRoot = path.join(repoRoot, 'data', 'tiles');

let defsPromise: Promise<DefLibrary> | null = null;

export function loadLibrary(): Promise<DefLibrary> {
  defsPromise ??= loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs')));
  return defsPromise;
}

/** Tile sets every terrain body of the library needs; throws naming the first one that is not baked. */
export function requireTiles(defs: DefLibrary): void {
  for (const b of Object.values(defs.bodies)) {
    if (!b.terrain) continue;
    const manifest = path.join(tilesRoot, b.terrain.tileset, 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(`baked tiles are missing: ${manifest} (run the ${b.terrain.tileset} bake; the mission is never flown on synthetic terrain)`);
  }
}

export interface RealTerrainOptions {
  /** Wrap the fs tile source (e.g. to delay tile I/O in the terrain-protocol test). */
  wrapSource?: (source: TileSource) => TileSource;
  cacheBytes?: number;
}

export async function createRealTerrain(defs: DefLibrary, opts: RealTerrainOptions = {}): Promise<TerrainAuthority> {
  requireTiles(defs);
  const base = createFsTileSource(tilesRoot);
  const source = opts.wrapSource ? opts.wrapSource(base) : base;
  return createTerrainProvider(defs, source, opts.cacheBytes !== undefined ? { cacheBytes: opts.cacheBytes } : {});
}

/**
 * A tile source whose answers arrive late and out of step with the simulation: every read is held back by
 * a few turns of the event loop, every eighth by a timer. Deterministic pattern (a counter, no clock).
 */
export function delayedSource(source: TileSource): TileSource & { reads: number } {
  let count = 0;
  const hold = async (): Promise<void> => {
    const n = ++count;
    for (let i = 0; i < 1 + (n % 4); i++) await new Promise<void>((resolve) => setImmediate(resolve));
    if (n % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 3));
  };
  const wrapped = {
    reads: 0,
    manifest: (tileset: string) => source.manifest(tileset),
    tile: async (tileset: string, layer: string, key: Parameters<TileSource['tile']>[2]) => {
      const data = await source.tile(tileset, layer, key);
      wrapped.reads++;
      await hold();
      return data;
    },
    file: async (tileset: string, relPath: string) => {
      const data = await source.file(tileset, relPath);
      await hold();
      return data;
    },
  };
  return wrapped;
}

export interface RealWorld {
  defs: DefLibrary;
  terrain: TerrainProvider;
  sim: SimWorld;
}

/** The real Sim of a scenario on the real baked terrain; `sim.ready` is awaited. */
export async function loadRealWorld(scenarioId: string, opts: RealTerrainOptions & { terrain?: TerrainProvider } = {}): Promise<RealWorld> {
  const defs = await loadLibrary();
  const terrain = opts.terrain ?? (await createRealTerrain(defs, opts));
  const sim = createSim(defs, scenarioId, { terrain });
  await sim.ready;
  return { defs, terrain, sim };
}
