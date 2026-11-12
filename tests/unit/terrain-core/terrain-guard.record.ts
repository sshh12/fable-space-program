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
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles-replaced --footprint <file.json> [--changed <tileset>/<dir> ...]
 *       AFTER A BAKE THAT REPLACED THE TILES OF A REGION IN PLACE: the same single pass, and the new summary
 *       is written ONLY IF no directory was added or removed and every recorded directory OUTSIDE the
 *       footprint is byte-identical (the named ones excepted, as above). The footprint is a JSON array of
 *       `<tileset>/<directory>` that MAY differ; the lead takes it from the guard's own history (the
 *       directories the region's first bake added: `git show <commit>:.../terrain-guard.tiles.json`), never
 *       from the package. A footprint directory keeps its file names. Prints the replaced directories by
 *       layer, face and level with their column ranges; the audit goes to out/terrain-guard/replaced.json.
 *   node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --resample-group <bodyId> <key> [--dry-run]
 *       re-record the heights of ONE place group (after its region was re-baked). Every stored direction of
 *       every baked body is sampled; nothing is written if a point OUTSIDE that group differs from the
 *       recording, on any body, in any query. --dry-run stops after the audit (out/terrain-guard/heights.json).
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
  auditTiles,
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
  spliceGroup,
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
} else if (argv.includes('--resample-group')) {
  const [bodyId, key] = argv.slice(argv.indexOf('--resample-group') + 1);
  if (!bodyId || !key || key.startsWith('--')) throw new Error('usage: --resample-group <bodyId> <key> [--dry-run]');
  const dryRun = argv.includes('--dry-run');
  const heights = readHeights();
  if (!heights.bodies[bodyId]) throw new Error(`${bodyId} has no recorded directions`);
  const terrain = await openTerrain(defs);
  const baked = bakedTerrainBodies(defs);
  const violations: string[] = [];
  const report: Record<string, unknown> = {};
  let spliced: GuardBodyHeights | null = null;
  for (const id of Object.keys(heights.bodies)) if (!baked.some((b) => b.bodyId === id)) violations.push(`${id}: recorded, but its tile set is not baked on this machine: its points cannot be shown unchanged`);
  for (const { bodyId: id, tileset } of baked) {
    const body = heights.bodies[id];
    if (!body) {
      violations.push(`${id}: baked but never recorded`);
      continue;
    }
    const sampled = await sampleHeights(terrain, id, directionsOf(body.directions));
    const points = body.groups.reduce((n, g) => n + g.count, 0);
    if (id === bodyId) {
      const result = spliceGroup(body, key, sampled);
      for (const d of result.outside) violations.push(`${id} ${d.query}: point #${d.index} (${d.group}, ${d.latDeg.toFixed(4)} N ${d.lonDeg.toFixed(4)} E) ${d.recorded} -> ${d.current}`);
      const group = result.body.groups.find((g) => g.key === key)!;
      // The group now holds what this tile set gives; the other groups keep the tile set they were recorded on.
      spliced = { ...result.body, groups: result.body.groups.map((g) => (g.key === key ? { ...g, recordedOn: contentHash(tileset) } : g)) };
      console.log(`terrain guard: ${id}: ${points} points sampled on ${contentHash(tileset)}; group ${key} (${group.count} points): ${Object.entries(result.changedInGroup).map(([q, n]) => `${n} changed on ${q}`).join(', ')}; outside the group: ${result.outside.length} changed`);
      report[id] = { points, group: key, count: group.count, changedInGroup: result.changedInGroup, changedOutside: result.outside };
    } else {
      const other: string[] = [];
      for (const [query, recorded, current] of [['collision', body.collision, sampled.collision], ...BAND_LIMITS.map((l) => [`band ${l} m`, body.band[String(l)] ?? '', sampled.band[String(l)]!])] as [string, string, string][]) {
        if (recorded !== current) other.push(`${id} ${query}: differs from the recording`);
      }
      violations.push(...other);
      console.log(`terrain guard: ${id}: ${points} points sampled on ${contentHash(tileset)}: ${other.length === 0 ? 'every height as recorded' : other.join('; ')}`);
      report[id] = { points, changed: other };
    }
  }
  const out = path.join(REPO_ROOT, 'out', 'terrain-guard');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'heights.json'), `${JSON.stringify({ at: new Date().toISOString(), body: bodyId, group: key, dryRun, violations, bodies: report }, null, 1)}\n`);
  if (violations.length > 0 || !spliced) {
    console.error(`terrain guard: NOT re-recorded: ${violations.length} heights changed outside the group ${key} of ${bodyId} (the whole list: out/terrain-guard/heights.json):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v}`);
    process.exit(1);
  }
  if (dryRun) console.log(`terrain guard: dry run: every point outside ${key} of ${bodyId} is as recorded on every body; nothing written`);
  else {
    heights.bodies[bodyId] = spliced;
    writeHeights(heights);
  }
} else if (argv.includes('--tiles-additions') || argv.includes('--tiles-replaced')) {
  const replacing = argv.includes('--tiles-replaced');
  const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const expectChanged = values('--changed');
  const footprintFile = values('--footprint')[0];
  if (replacing && !footprintFile) throw new Error('--tiles-replaced needs --footprint <file.json>: a JSON array of <tileset>/<directory> that may differ');
  if (!replacing && footprintFile) throw new Error('--footprint belongs to --tiles-replaced: a bake that adds tiles changes no recorded directory');
  const footprint: string[] = footprintFile ? (JSON.parse(fs.readFileSync(footprintFile, 'utf8')) as string[]) : [];
  if (!Array.isArray(footprint) || footprint.some((d) => typeof d !== 'string')) throw new Error('the footprint file must be a JSON array of strings');
  const recorded = JSON.parse(fs.readFileSync(TILES_FILE, 'utf8')) as GuardTiles;
  const baked = bakedTerrainBodies(defs).map((b) => b.tileset);
  const tiles: GuardTiles = { tilesets: {} };
  const report: Record<string, unknown> = {};
  const violations: string[] = [];
  for (const t of Object.keys(recorded.tilesets)) if (!baked.includes(t)) violations.push(`${t}: recorded, but not a baked tile set of the library now`);
  for (const c of [...expectChanged, ...footprint]) if (!baked.some((t) => c.startsWith(`${t}/`))) violations.push(`${c}: names no baked tile set (write <tileset>/<directory>, the root is <tileset>/.)`);
  // Column ranges of a set of directories under one parent ("43-51", "87-95, 99-102"); names that are not numbers are listed.
  const ranges = (names: string[]): string => {
    const numbers = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < numbers.length; ) {
      let j = i;
      while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
      parts.push(i === j ? String(numbers[i]) : `${numbers[i]}-${numbers[j]}`);
      i = j + 1;
    }
    return [...parts, ...names.filter((n) => !/^\d+$/.test(n))].join(', ');
  };
  const byParentOf = (dirs: string[], summary: Record<string, { files: number; bytes: number }>): Map<string, { directories: number; files: number; bytes: number; names: string[] }> => {
    const byParent = new Map<string, { directories: number; files: number; bytes: number; names: string[] }>();
    for (const d of dirs) {
      const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '.';
      const at = byParent.get(parent) ?? { directories: 0, files: 0, bytes: 0, names: [] };
      at.directories++;
      at.files += summary[d]!.files;
      at.bytes += summary[d]!.bytes;
      at.names.push(d.slice(d.lastIndexOf('/') + 1));
      byParent.set(parent, at);
    }
    return new Map([...byParent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  for (const tileset of baked) {
    const rec = recorded.tilesets[tileset];
    if (!rec) {
      violations.push(`${tileset}: never recorded: a first recording is --tiles`);
      continue;
    }
    const t0 = Date.now();
    const summary = await summariseTileset(tileset, true);
    tiles.tilesets[tileset] = summary;
    const own = (list: string[]): string[] => list.filter((c) => c.startsWith(`${tileset}/`)).map((c) => c.slice(tileset.length + 1));
    const mayChange = new Set(own(footprint));
    const audit = auditTiles(rec, summary, { expectChanged: own(expectChanged), mayChange, additions: !replacing });
    for (const v of audit.violations) violations.push(`${tileset}/${v}`);
    const files = Object.values(summary).reduce((n, d) => n + d.files, 0);
    const bytes = Object.values(summary).reduce((n, d) => n + d.bytes, 0);
    const added = byParentOf(audit.added, summary);
    const replaced = byParentOf(audit.replaced, summary);
    const sum = (m: Map<string, { files: number; bytes: number }>, of: 'files' | 'bytes'): number => [...m.values()].reduce((n, x) => n + x[of], 0);
    console.log(
      `terrain guard: ${tileset}: ${Object.keys(rec).length} directories recorded: ${audit.unchanged} byte-identical, ${audit.changed.length} changed as named, ` +
        (replacing ? `${audit.replaced.length} of the footprint's ${mayChange.size} replaced (${sum(replaced, 'files')} files, ${(sum(replaced, 'bytes') / 1e9).toFixed(3)} GB), ` : '') +
        `${audit.added.length} added${replacing ? '' : ` (${sum(added, 'files')} files, ${(sum(added, 'bytes') / 1e9).toFixed(3)} GB)`}, ${audit.violations.length} violations; ` +
        `now ${Object.keys(summary).length} directories, ${files} files, ${(bytes / 1e9).toFixed(2)} GB; read in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
    for (const c of audit.changed) console.log(`  changed as named: ${tileset}/${c}`);
    for (const [parent, n] of added) console.log(`  added under ${tileset}/${parent}: ${n.directories} directories, ${n.files} files`);
    for (const [parent, n] of replaced) console.log(`  replaced under ${tileset}/${parent}: ${n.directories} directories (${ranges(n.names)})`);
    const plain = (m: Map<string, { directories: number; files: number; bytes: number; names: string[] }>): Record<string, unknown> => Object.fromEntries([...m.entries()].map(([k, v]) => [k, { directories: v.directories, files: v.files, bytes: v.bytes, columns: ranges(v.names) }]));
    report[tileset] = {
      recorded: Object.keys(rec).length, unchanged: audit.unchanged, changed: audit.changed, violations: audit.violations,
      added: audit.added, addedByParent: plain(added), footprint: mayChange.size, replaced: audit.replaced, replacedByParent: plain(replaced),
      now: { directories: Object.keys(summary).length, files, bytes },
    };
  }
  const out = path.join(REPO_ROOT, 'out', 'terrain-guard');
  fs.mkdirSync(out, { recursive: true });
  const reportFile = replacing ? 'replaced.json' : 'additions.json';
  fs.writeFileSync(path.join(out, reportFile), `${JSON.stringify({ at: new Date().toISOString(), kind: replacing ? 'a bake that replaced the tiles of a region' : 'a bake that added tiles', expectChanged, footprint: footprint.length, violations, tilesets: report }, null, 1)}\n`);
  if (violations.length > 0) {
    console.error(`terrain guard: NOT re-recorded: ${violations.length} violations of "${replacing ? 'a bake that replaces a region changes nothing outside its footprint and adds or removes no directory' : 'a bake that adds tiles changes nothing that was recorded'}" (the whole list: out/terrain-guard/${reportFile}):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v}`);
    process.exit(1);
  }
  fs.writeFileSync(TILES_FILE, `${JSON.stringify(tiles)}\n`);
  console.log(`terrain guard: every recorded directory ${replacing ? 'outside the footprint ' : ''}is byte-identical but the ${expectChanged.length} named; wrote ${path.relative(REPO_ROOT, TILES_FILE)} (the audit: out/terrain-guard/${reportFile})`);
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
  console.error('usage: terrain-guard.record.ts --resample | --add-place <bodyId> <key> <latDeg> <lonDeg> | --resample-group <bodyId> <key> [--dry-run] | --tiles-additions [--changed <tileset>/<dir> ...] | --tiles-replaced --footprint <file.json> [--changed <tileset>/<dir> ...] | --tiles | --new-heights');
  process.exit(2);
}
