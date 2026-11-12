/**
 * Records the terrain guard (see terrain-guard.ts). The lead's act; work packages never run it.
 *
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts            everything
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --heights  the heights only
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles    the directory summaries only
 *
 * The directory summaries are always recorded in the full form (every file read: bytes and content hash).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bakedTerrainBodies, HEIGHTS_FILE, loadRealDefs, REPO_ROOT, sampleHeights, summariseTileset, TILES_FILE, type GuardTiles } from './terrain-guard';

const only = process.argv.slice(2);
const want = (what: string): boolean => only.length === 0 || only.includes(`--${what}`);
const defs = await loadRealDefs();

if (want('heights')) {
  const heights = await sampleHeights(defs, (bodyId, seconds) => console.log(`terrain guard: ${bodyId} sampled in ${seconds.toFixed(1)} s`));
  fs.writeFileSync(HEIGHTS_FILE, `${JSON.stringify(heights, null, 1)}\n`);
  console.log(`terrain guard: wrote ${path.relative(REPO_ROOT, HEIGHTS_FILE)} (${Object.keys(heights.bodies).join(', ')}; ${heights.pointsPerBody} directions each)`);
}

if (want('tiles')) {
  const tiles: GuardTiles = { tilesets: {} };
  for (const { tileset } of bakedTerrainBodies(defs)) {
    const t0 = Date.now();
    const summary = summariseTileset(tileset, true);
    tiles.tilesets[tileset] = summary;
    const files = Object.values(summary).reduce((n, d) => n + d.files, 0);
    const bytes = Object.values(summary).reduce((n, d) => n + (d.bytes ?? 0), 0);
    console.log(`terrain guard: ${tileset}: ${Object.keys(summary).length} directories, ${files} files, ${(bytes / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  fs.writeFileSync(TILES_FILE, `${JSON.stringify(tiles)}\n`);
  console.log(`terrain guard: wrote ${path.relative(REPO_ROOT, TILES_FILE)}`);
}
