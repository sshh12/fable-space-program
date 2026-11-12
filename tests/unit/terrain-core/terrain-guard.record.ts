/**
 * Records the terrain guard (see terrain-guard.ts). The lead's act; work packages never run it.
 *
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --resample
 *       keep the stored directions, sample the heights again (after a change of heights the lead has
 *       accepted, e.g. new flatten discs: run the test first and check which points changed)
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --add-place <bodyId> <key> <latDeg> <lonDeg>
 *       APPEND a group of points in discs about a new place (a new site: key `site:<id>`); every existing
 *       point keeps its index, direction and recorded height
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles-additions [--changed <tileset>/<dir> ...]
 *       AFTER A BAKE THAT ADDED TILES: read every file once, hold the result against the recording, and
 *       write the new summary ONLY IF every recorded directory is byte-identical (files, names, bytes and
 *       content) except the directories named by --changed (a tile set's root with its manifest:
 *       `earth/.`), which must be there and must differ. Prints the added directories by layer, face and
 *       level, to be held against the package's own list, and writes the whole audit to
 *       out/terrain-guard/additions.json. Exit 1 and nothing written on any violation.
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles
 *       the directory summaries, in the full form (every file read: bytes and content hash), with no
 *       comparison: for a first recording, or after a change of existing tiles that the lead has accepted
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --new-heights
 *       start the heights file over: a uniform group and one group per place the library names today for
 *       every baked terrain body. This REPLACES every direction; it is for a body's first recording only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  auditAdditions,
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
  const tileset = bakedTerrainBodies(defs).find((b) => b.bodyId === bodyId)?.tileset;
  if (!tileset) throw new Error(`${bodyId} has no baked tile set on this machine`);
  // The group states the tile set it was first sampled on: the body's own field is that of its first recording.
  const group: GuardGroup = { key, count: PLACE_POINTS, latDeg, lonDeg, recordedOn: contentHash(tileset) };
  const dirs = groupDirections(bodyId, group, body.radius);
  const sampled = await sampleHeights(await openTerrain(defs), bodyId, dirs);
  body.groups.push(group);
  body.directions += directionsHex(dirs);
  body.collision += sampled.collision;
  for (const l of BAND_LIMITS) body.band[String(l)] += sampled.band[String(l)]!;
  writeHeights(heights);
} else if (argv.includes('--tiles-additions')) {
  const expectChanged = argv.flatMap((a, i) => (a === '--changed' && argv[i + 1] ? [argv[i + 1]!] : []));
  const recorded = JSON.parse(fs.readFileSync(TILES_FILE, 'utf8')) as GuardTiles;
  const baked = bakedTerrainBodies(defs).map((b) => b.tileset);
  const tiles: GuardTiles = { tilesets: {} };
  const report: Record<string, unknown> = {};
  const violations: string[] = [];
  for (const t of Object.keys(recorded.tilesets)) if (!baked.includes(t)) violations.push(`${t}: recorded, but not a baked tile set of the library now`);
  for (const c of expectChanged) if (!baked.some((t) => c.startsWith(`${t}/`))) violations.push(`--changed ${c}: names no baked tile set (write <tileset>/<directory>, the root is <tileset>/.)`);
  for (const tileset of baked) {
    const rec = recorded.tilesets[tileset];
    if (!rec) {
      violations.push(`${tileset}: never recorded: a first recording is --tiles`);
      continue;
    }
    const t0 = Date.now();
    const summary = await summariseTileset(tileset, true);
    tiles.tilesets[tileset] = summary;
    const audit = auditAdditions(rec, summary, expectChanged.filter((c) => c.startsWith(`${tileset}/`)).map((c) => c.slice(tileset.length + 1)));
    for (const v of audit.violations) violations.push(`${tileset}/${v}`);
    // Added directories by their parent (layer/face/level): what a package's own list is held against.
    const byParent = new Map<string, { directories: number; files: number; bytes: number }>();
    for (const d of audit.added) {
      const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '.';
      const at = byParent.get(parent) ?? { directories: 0, files: 0, bytes: 0 };
      at.directories++;
      at.files += summary[d]!.files;
      at.bytes += summary[d]!.bytes;
      byParent.set(parent, at);
    }
    const files = Object.values(summary).reduce((n, d) => n + d.files, 0);
    const bytes = Object.values(summary).reduce((n, d) => n + d.bytes, 0);
    const addedFiles = audit.added.reduce((n, d) => n + summary[d]!.files, 0);
    const addedBytes = audit.added.reduce((n, d) => n + summary[d]!.bytes, 0);
    console.log(
      `terrain guard: ${tileset}: ${Object.keys(rec).length} directories recorded: ${audit.unchanged} byte-identical, ${audit.changed.length} changed as named, ${audit.violations.length} violations; ` +
        `${audit.added.length} directories added (${addedFiles} files, ${(addedBytes / 1e9).toFixed(3)} GB); now ${Object.keys(summary).length} directories, ${files} files, ${(bytes / 1e9).toFixed(2)} GB; read in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
    for (const c of audit.changed) console.log(`  changed as named: ${tileset}/${c}`);
    for (const [parent, n] of [...byParent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`  added under ${tileset}/${parent}: ${n.directories} directories, ${n.files} files`);
    report[tileset] = { recorded: Object.keys(rec).length, unchanged: audit.unchanged, changed: audit.changed, violations: audit.violations, added: audit.added, addedByParent: Object.fromEntries(byParent), now: { directories: Object.keys(summary).length, files, bytes } };
  }
  const out = path.join(REPO_ROOT, 'out', 'terrain-guard');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'additions.json'), `${JSON.stringify({ at: new Date().toISOString(), expectChanged, violations, tilesets: report }, null, 1)}\n`);
  if (violations.length > 0) {
    console.error(`terrain guard: NOT re-recorded: ${violations.length} violations of "a bake that adds tiles changes nothing that was recorded" (the whole list: out/terrain-guard/additions.json):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v}`);
    process.exit(1);
  }
  fs.writeFileSync(TILES_FILE, `${JSON.stringify(tiles)}\n`);
  console.log(`terrain guard: every recorded directory is byte-identical but the ${expectChanged.length} named; wrote ${path.relative(REPO_ROOT, TILES_FILE)} (the audit: out/terrain-guard/additions.json)`);
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
  console.error('usage: terrain-guard.record.ts --resample | --add-place <bodyId> <key> <latDeg> <lonDeg> | --tiles-additions [--changed <tileset>/<dir> ...] | --tiles | --new-heights');
  process.exit(2);
}
