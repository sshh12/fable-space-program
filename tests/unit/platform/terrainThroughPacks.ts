/**
 * The terrain guard through the pack source, in Node (platform-delivery acceptance, the server path): the real
 * TerrainProvider over createTileSource({ kind: 'pack' }) reading the local packs (whole-pack mode), asked at
 * the guard's recorded directions; the collision heights must equal the guard's bits.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tests/unit/platform/terrainThroughPacks.ts [points]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createPackTileSource } from '../../../src/terrain/packSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { createLocalPackFetch, LOCAL_PACK_LIST_URL } from '../../../tools/pack/localPacks';
import { bitsHex, directionsOf, HEIGHTS_FILE, type GuardHeights } from '../terrain-core/terrain-guard';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const N = Number(process.argv[2] ?? 2000);
const recorded = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8')) as GuardHeights;
const defs = await loadDefs(fsDefSource(path.join(REPO, 'data', 'defs')));
const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(path.join(REPO, 'data', 'packs')) });
const terrain = await createTerrainProvider(defs, src);
let bad = 0;
for (const bodyId of Object.keys(recorded.bodies).sort()) {
  const body = recorded.bodies[bodyId]!;
  const dirs = directionsOf(body.directions).slice(0, N);
  let hex = '';
  for (const d of dirs) {
    await terrain.ensureLoaded(bodyId, d, 40, 'terrain-through-packs');
    hex += bitsHex(terrain.heightAt(bodyId, d));
  }
  const want = body.collision.slice(0, dirs.length * 16);
  let diff = 0;
  for (let i = 0; i < dirs.length; i++) if (hex.slice(i * 16, i * 16 + 16) !== want.slice(i * 16, i * 16 + 16)) diff++;
  bad += diff;
  console.log(`${bodyId}: ${dirs.length} collision heights through the packs, ${diff} differ from the guard (tile set recorded ${body.tilesetContentHash})`);
}
console.log(JSON.stringify(src.stats().requests));
process.exitCode = bad === 0 ? 0 : 1;
