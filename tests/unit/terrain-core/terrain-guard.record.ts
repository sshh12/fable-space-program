/**
 * Records the terrain guard (see terrain-guard.ts). The lead's act; work packages never run it.
 *
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --resample
 *       keep the stored directions, sample the heights again (after a change of heights the lead has
 *       accepted, e.g. new flatten discs: run the test first and check which points changed)
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --add-place <bodyId> <key> <latDeg> <lonDeg>
 *       APPEND a group of points in discs about a new place (a new site: key `site:<id>`); every existing
 *       point keeps its index, direction and recorded height
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles
 *       the directory summaries, in the full form (every file read: bytes and content hash)
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --new-heights
 *       start the heights file over: a uniform group and one group per place the library names today for
 *       every baked terrain body. This REPLACES every direction; it is for a body's first recording only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BAND_LIMITS,
  bakedTerrainBodies,
  directionsHex,
  directionsOf,
  groupDirections,
  HEIGHTS_FILE,
  loadRealDefs,
  namedPlaces,
  openTerrain,
  PLACE_POINTS,
  REPO_ROOT,
  sampleHeights,
  summariseTileset,
  TILES_FILE,
  TILES_ROOT,
  UNIFORM_POINTS,
  type GuardBodyHeights,
  type GuardGroup,
  type GuardHeights,
  type GuardTiles,
} from './terrain-guard';

const argv = process.argv.slice(2);
const defs = await loadRealDefs();
const contentHash = (tileset: string): string => (JSON.parse(fs.readFileSync(path.join(TILES_ROOT, tileset, 'manifest.json'), 'utf8')) as { contentHash?: string }).contentHash ?? 'unknown';
const readHeights = (): GuardHeights => JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8')) as GuardHeights;
const writeHeights = (h: GuardHeights): void => {
  fs.writeFileSync(HEIGHTS_FILE, `${JSON.stringify(h, null, 1)}\n`);
  console.log(`terrain guard: wrote ${path.relative(REPO_ROOT, HEIGHTS_FILE)}: ${Object.entries(h.bodies).map(([id, b]) => `${id} ${b.groups.map((g) => `${g.key} ${g.count}`).join(' + ')}`).join('; ')}`);
};

if (argv.includes('--new-heights')) {
  const terrain = await openTerrain(defs);
  const heights: GuardHeights = { format: 2, bandLimits: [...BAND_LIMITS], node: process.version, bodies: {} };
  for (const { bodyId, tileset } of bakedTerrainBodies(defs)) {
    const radius = defs.bodies[bodyId]!.radius;
    const groups: GuardGroup[] = [{ key: 'uniform', count: UNIFORM_POINTS }, ...namedPlaces(defs, bodyId)];
    const dirs = groups.flatMap((g) => groupDirections(bodyId, g, radius));
    const sampled = await sampleHeights(terrain, bodyId, dirs);
    heights.bodies[bodyId] = { tilesetContentHash: contentHash(tileset), radius, groups, directions: directionsHex(dirs), ...sampled };
  }
  writeHeights(heights);
} else if (argv.includes('--resample')) {
  const terrain = await openTerrain(defs);
  const heights = readHeights();
  for (const { bodyId, tileset } of bakedTerrainBodies(defs)) {
    const body = heights.bodies[bodyId];
    if (!body) throw new Error(`${bodyId} has no recorded directions: use --new-heights for a first recording`);
    const sampled = await sampleHeights(terrain, bodyId, directionsOf(body.directions));
    heights.bodies[bodyId] = { ...body, tilesetContentHash: contentHash(tileset), ...sampled };
  }
  heights.node = process.version;
  writeHeights(heights);
} else if (argv.includes('--add-place')) {
  const [bodyId, key, lat, lon] = argv.slice(argv.indexOf('--add-place') + 1);
  const latDeg = Number(lat);
  const lonDeg = Number(lon);
  if (!bodyId || !key || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) throw new Error('usage: --add-place <bodyId> <key> <latDeg> <lonDeg>');
  const heights = readHeights();
  const body: GuardBodyHeights | undefined = heights.bodies[bodyId];
  if (!body) throw new Error(`${bodyId} has no recorded directions`);
  if (body.groups.some((g) => g.key === key)) throw new Error(`${bodyId} already has a group ${key}`);
  const group: GuardGroup = { key, count: PLACE_POINTS, latDeg, lonDeg };
  const dirs = groupDirections(bodyId, group, body.radius);
  const sampled = await sampleHeights(await openTerrain(defs), bodyId, dirs);
  body.groups.push(group);
  body.directions += directionsHex(dirs);
  body.collision += sampled.collision;
  for (const l of BAND_LIMITS) body.band[String(l)] += sampled.band[String(l)]!;
  writeHeights(heights);
} else if (argv.includes('--tiles')) {
  const tiles: GuardTiles = { tilesets: {} };
  for (const { tileset } of bakedTerrainBodies(defs)) {
    const t0 = Date.now();
    const summary = await summariseTileset(tileset, true);
    tiles.tilesets[tileset] = summary;
    const files = Object.values(summary).reduce((n, d) => n + d.files, 0);
    const bytes = Object.values(summary).reduce((n, d) => n + d.bytes, 0);
    console.log(`terrain guard: ${tileset}: ${Object.keys(summary).length} directories, ${files} files, ${(bytes / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  fs.writeFileSync(TILES_FILE, `${JSON.stringify(tiles)}\n`);
  console.log(`terrain guard: wrote ${path.relative(REPO_ROOT, TILES_FILE)}`);
} else {
  console.error('usage: terrain-guard.record.ts --resample | --add-place <bodyId> <key> <latDeg> <lonDeg> | --tiles | --new-heights');
  process.exit(2);
}
