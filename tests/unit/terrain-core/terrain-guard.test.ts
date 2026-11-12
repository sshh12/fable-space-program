/**
 * The terrain guard (see terrain-guard.ts): the recorded heights bit for bit at the STORED directions, and
 * the summary of every tile directory. Runs on the real baked tiles; a body whose tile set is not baked on
 * this machine is skipped with a note (CI has no tiles), a body that is baked but was never recorded fails.
 */
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import {
  auditAdditions,
  auditTiles,
  BAND_LIMITS,
  bakedTerrainBodies,
  bitsHex,
  CLUSTER_RADII,
  directionsHex,
  directionsOf,
  distanceTo,
  groupDirections,
  groupOf,
  heightDifferences,
  HEIGHTS_FILE,
  hexToNumber,
  latLonOf,
  loadRealDefs,
  openTerrain,
  PLACE_POINTS,
  sampleHeights,
  seedOf,
  spliceGroup,
  summariseTileset,
  tileDifferences,
  TILES_FILE,
  UNIFORM_POINTS,
  type GuardBodyHeights,
  type GuardHeights,
  type GuardTiles,
} from './terrain-guard';

const FULL = !!process.env.TERRAIN_GUARD_FULL;

describe('terrain guard', () => {
  let defs: DefLibrary;
  let baked: { bodyId: string; tileset: string }[];
  let recordedHeights: GuardHeights;
  let recordedTiles: GuardTiles;

  beforeAll(async () => {
    defs = await loadRealDefs();
    baked = bakedTerrainBodies(defs);
    recordedHeights = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8')) as GuardHeights;
    recordedTiles = JSON.parse(fs.readFileSync(TILES_FILE, 'utf8')) as GuardTiles;
  });

  it('the bit encoding is exact, including the sign of zero and non-finite values', () => {
    for (const x of [0, -0, 1, -1736.25, 8848.86, 1e-320, Number.MAX_VALUE, Infinity, -Infinity]) expect(Object.is(hexToNumber(bitsHex(x)), x)).toBe(true);
    expect(Number.isNaN(hexToNumber(bitsHex(Number.NaN)))).toBe(true);
    expect(bitsHex(1)).toBe('3ff0000000000000');
    expect(bitsHex(-0)).toBe('8000000000000000');
    const dirs = [{ x: 0.6, y: -0.8, z: 0 }, { x: 0, y: 0, z: -1 }];
    expect(directionsOf(directionsHex(dirs))).toEqual(dirs);
  });

  it('the stored directions are unit vectors laid out in their groups: 2,800 on Earth and 2,000 on the Moon today', () => {
    expect(recordedHeights.format).toBe(2);
    for (const [bodyId, body] of Object.entries(recordedHeights.bodies)) {
      const dirs = directionsOf(body.directions);
      const total = body.groups.reduce((n, g) => n + g.count, 0);
      expect(dirs.length, bodyId).toBe(total);
      expect(total, bodyId).toBeGreaterThanOrEqual(UNIFORM_POINTS + PLACE_POINTS);
      expect(body.collision.length, bodyId).toBe(total * 16);
      for (const l of BAND_LIMITS) expect(body.band[String(l)]!.length, bodyId).toBe(total * 16);
      for (const d of dirs) expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-12);
      expect(body.groups[0], bodyId).toEqual({ key: 'uniform', count: UNIFORM_POINTS });
      expect(new Set(body.groups.map((g) => g.key)).size, bodyId).toBe(body.groups.length);
      // Every point of a place group lies inside the largest disc about its place, a quarter inside the smallest.
      let start = 0;
      for (const g of body.groups) {
        if (g.latDeg !== undefined && g.lonDeg !== undefined) {
          const dist = dirs.slice(start, start + g.count).map((d) => distanceTo(latLonOf(d), g.latDeg!, g.lonDeg!, body.radius));
          expect(Math.max(...dist), `${bodyId} ${g.key}`).toBeLessThanOrEqual(CLUSTER_RADII[0] * 1.001);
          expect(dist.filter((x) => x <= CLUSTER_RADII[CLUSTER_RADII.length - 1]! * 1.001).length, `${bodyId} ${g.key}`).toBeGreaterThanOrEqual(g.count / CLUSTER_RADII.length);
        }
        start += g.count;
      }
    }
    expect(Object.fromEntries(Object.entries(recordedHeights.bodies).map(([id, b]) => [id, b.groups.reduce((n, g) => n + g.count, 0)]))).toMatchObject({ earth: 2800, moon: 2000 });
    // Groups are only ever appended: the two of the first recording, then the place added with the Madrakah
    // region (site-bake, 2026-11-12), about the reference pad the site had then. Its directions never move;
    // its heights are those of the tile set named in `recordedOn` (the region was re-baked on GLO-30 the same
    // day and the group, and only the group, re-recorded).
    const earth = recordedHeights.bodies['earth']!;
    expect(earth.groups.map((g) => g.key)).toEqual(['uniform', 'site:ka-lae-lc1', 'site:madrakah']);
    expect(earth.groups[1]).toEqual({ key: 'site:ka-lae-lc1', count: PLACE_POINTS, latDeg: 18.987556, lonDeg: -155.603239 });
    expect(earth.groups[2]).toEqual({ key: 'site:madrakah', count: PLACE_POINTS, latDeg: 18.996043, lonDeg: 57.793818, recordedOn: 'f5e6ef420bda7cea' });
    expect(recordedHeights.bodies['moon']!.groups.map((g) => g.key)).toEqual(['uniform', 'landing:0.661471,23.435999']);
  });

  it('a group is a function of the body id, its key and its place only: other bodies and other places do not move it', () => {
    // The seed is a hash of the names, never an index into the library.
    expect(seedOf('earth:uniform')).toBe(seedOf('earth:uniform'));
    expect(seedOf('earth:uniform')).not.toBe(seedOf('moon:uniform'));
    expect(seedOf('earth:site:a')).not.toBe(seedOf('earth:site:b'));
    const near = (a: { x: number; y: number; z: number }[], b: { x: number; y: number; z: number }[]): number => Math.max(...a.map((d, i) => Math.hypot(d.x - b[i]!.x, d.y - b[i]!.y, d.z - b[i]!.z)));
    for (const [bodyId, body] of Object.entries(recordedHeights.bodies)) {
      // The stored directions are what the generator gives for the stored groups. (To rounding: the stored
      // bits are the truth, and a later runtime may round a cosine differently.)
      const regenerated = body.groups.flatMap((g) => groupDirections(bodyId, g, body.radius));
      const stored = directionsOf(body.directions);
      expect(regenerated.length, bodyId).toBe(stored.length);
      expect(near(regenerated, stored), bodyId).toBeLessThan(1e-12);
    }
    // Appending a place leaves every earlier point where it was.
    const earth = recordedHeights.bodies['earth'];
    if (earth) {
      const added = { key: 'site:planted', count: PLACE_POINTS, latDeg: 19.0, lonDeg: 57.8 };
      const stored = directionsOf(earth.directions);
      const after = [...earth.groups, added].flatMap((g) => groupDirections('earth', g, earth.radius));
      expect(after.length).toBe(stored.length + PLACE_POINTS);
      expect(near(after.slice(0, stored.length), stored)).toBeLessThan(1e-12);
      expect(groupOf([...earth.groups, added], after.length - 1)!.key).toBe('site:planted');
      // And so does a library with more bodies in it: nothing here takes the library as an argument.
      expect(groupDirections.length).toBe(3);
    }
  });

  it('a changed height is reported with its point, group and place', () => {
    const body: GuardBodyHeights = { tilesetContentHash: 'x', radius: 1000, groups: [{ key: 'uniform', count: 1 }, { key: 'site:s', count: 2, latDeg: 10, lonDeg: 20 }], directions: directionsHex([{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]), collision: '', band: {} };
    const recorded = bitsHex(5) + bitsHex(6) + bitsHex(7);
    expect(heightDifferences(body, recorded, recorded)).toEqual([]);
    const changed = heightDifferences(body, recorded, bitsHex(5) + bitsHex(6) + bitsHex(7.5));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ index: 2, group: 'site:s', recorded: 7, current: 7.5 });
    expect(changed[0]!.latDeg).toBeCloseTo(90, 9);
    expect(distanceTo({ latDeg: 0, lonDeg: 0 }, 0, 90, 1000)).toBeCloseTo((1000 * Math.PI) / 2, 6);
  });

  it('the audit of a bake that adds tiles: a recorded directory gone or changed is a violation, the named root may change, the rest is added', () => {
    const dir = (files: number, bytes: number, content: string): { files: number; names: string; bytes: number; content: string } => ({ files, names: `n${files}`, bytes, content });
    const recorded = { '.': dir(1, 15109, 'm1'), 'height/2/7/40': dir(3, 300, 'a'), 'albedo/2/7/40': dir(3, 900, 'b'), 'globals': dir(2, 50, 'g') };
    const additive = { ...recorded, '.': dir(1, 21925, 'm2'), 'height/2/8/43': dir(9, 900, 'c'), 'height/2/8/44': dir(9, 900, 'd') };
    const ok = auditAdditions(recorded, additive, ['.']);
    expect(ok.violations).toEqual([]);
    expect(ok.unchanged).toBe(3);
    expect(ok.changed).toEqual(['.: 15109 bytes recorded, 21925 now']);
    expect(ok.added).toEqual(['height/2/8/43', 'height/2/8/44']);
    // The manifest changed and nobody said so.
    expect(auditAdditions(recorded, additive).violations).toEqual(['.: 15109 bytes recorded, 21925 now']);
    // An existing tile rewritten with the same size: only the content hash sees it.
    const rewritten = { ...additive, 'albedo/2/7/40': dir(3, 900, 'B') };
    expect(auditAdditions(recorded, rewritten, ['.']).violations).toEqual(['albedo/2/7/40: content changed (b -> B)']);
    // A file added to an existing directory, a directory removed, a named change that is none, a name never recorded.
    expect(auditAdditions(recorded, { ...additive, 'height/2/7/40': dir(4, 400, 'a2') }, ['.']).violations).toEqual(['height/2/7/40: 3 files recorded, 4 now (names n3 -> n4)']);
    const without = Object.fromEntries(Object.entries(additive).filter(([k]) => k !== 'globals'));
    expect(auditAdditions(recorded, without, ['.']).violations).toEqual(['globals: directory is gone (had 2 files)']);
    expect(auditAdditions(recorded, { ...additive, '.': recorded['.'] }, ['.']).violations).toEqual(['.: named as changed, but it is byte-identical']);
    expect(auditAdditions(recorded, additive, ['.', 'night']).violations).toEqual(['night: named as changed, but it was never recorded']);
    // The every-commit form (no content hashes) cannot answer the question.
    const statOnly = Object.fromEntries(Object.entries(additive).map(([k, d]) => [k, { files: d.files, names: d.names, bytes: d.bytes }]));
    expect(auditAdditions(recorded, statOnly, ['.']).violations.length).toBeGreaterThan(0);
    expect(auditAdditions(recorded, statOnly, ['.']).violations.every((v) => /no content hash/.test(v))).toBe(true);
  });

  it('the audit of a bake that replaces a region: only footprint directories may differ, with their file names; nothing is added or removed', () => {
    const dir = (files: number, bytes: number, content: string): { files: number; names: string; bytes: number; content: string } => ({ files, names: `n${files}`, bytes, content });
    const recorded = { '.': dir(1, 21925, 'm2'), 'height/2/8/43': dir(9, 900, 'sea'), 'height/2/8/44': dir(9, 900, 'old'), 'albedo/2/8/44': dir(9, 5000, 'old'), 'height/5/8/10': dir(9, 900, 'kalae'), 'globals': dir(2, 50, 'g') };
    const footprint = new Set(['height/2/8/43', 'height/2/8/44', 'albedo/2/8/44']);
    const rebaked = { ...recorded, '.': dir(1, 22126, 'm3'), 'height/2/8/44': dir(9, 900, 'new'), 'albedo/2/8/44': dir(9, 4800, 'new') };
    const ok = auditTiles(recorded, rebaked, { expectChanged: ['.'], mayChange: footprint, additions: false });
    expect(ok.violations).toEqual([]);
    expect(ok.replaced).toEqual(['albedo/2/8/44', 'height/2/8/44']);
    expect(ok.changed).toEqual(['.: 21925 bytes recorded, 22126 now']);
    // The sea column of the footprint came out byte-identical: it counts as unchanged, with the two outside it.
    expect(ok.unchanged).toBe(3);
    expect(ok.added).toEqual([]);
    // A directory OUTSIDE the footprint that differs, even by content alone, stops the re-recording.
    expect(auditTiles(recorded, { ...rebaked, 'height/5/8/10': dir(9, 900, 'KALAE') }, { expectChanged: ['.'], mayChange: footprint, additions: false }).violations).toEqual(['height/5/8/10: content changed (kalae -> KALAE)']);
    // Without the footprint every replaced directory is a violation: the footprint is the lead's, not the package's.
    expect(auditTiles(recorded, rebaked, { expectChanged: ['.'], additions: false }).violations).toEqual(['albedo/2/8/44: 5000 bytes recorded, 4800 now', 'height/2/8/44: content changed (old -> new)']);
    // A replacing bake adds no directory and no file, and removes none, inside the footprint or outside.
    expect(auditTiles(recorded, { ...rebaked, 'height/2/8/45': dir(9, 900, 'x') }, { expectChanged: ['.'], mayChange: footprint, additions: false }).violations).toEqual(['height/2/8/45: new directory (9 files): a bake that replaces adds none']);
    expect(auditTiles(recorded, { ...rebaked, 'height/2/8/44': dir(10, 1000, 'new') }, { expectChanged: ['.'], mayChange: footprint, additions: false }).violations[0]).toMatch(/^height\/2\/8\/44: inside the footprint, but its files changed: 9 files recorded, 10 now/);
    const gone = Object.fromEntries(Object.entries(rebaked).filter(([k]) => k !== 'height/2/8/43'));
    expect(auditTiles(recorded, gone, { expectChanged: ['.'], mayChange: footprint, additions: false }).violations).toEqual(['height/2/8/43: directory is gone (had 9 files)']);
    // A footprint entry that was never recorded is a mistake in the footprint.
    expect(auditTiles(recorded, rebaked, { expectChanged: ['.'], mayChange: new Set([...footprint, 'height/2/8/99']), additions: false }).violations).toEqual(['height/2/8/99: in the footprint, but it was never recorded']);
  });

  it('re-recording ONE group: its heights come from the new sampling, every other point stays as recorded, a change outside it is named', () => {
    const body: GuardBodyHeights = {
      tilesetContentHash: 'x', radius: 1000,
      groups: [{ key: 'uniform', count: 2 }, { key: 'site:a', count: 2, latDeg: 10, lonDeg: 20 }, { key: 'site:b', count: 1, latDeg: -5, lonDeg: 40 }],
      directions: directionsHex([{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }]),
      collision: [1, 2, 3, 4, 5].map(bitsHex).join(''),
      band: { '25': [1, 2, 3, 4, 5].map(bitsHex).join(''), '1000': [1.5, 2.5, 3.5, 4.5, 5.5].map(bitsHex).join('') },
    };
    // The region of site:a was re-baked: its two points moved on the collision query, one of them on a band query.
    const sampled = { collision: [1, 2, 30, 40, 5].map(bitsHex).join(''), band: { '25': [1, 2, 3, 41, 5].map(bitsHex).join(''), '1000': body.band['1000']! } };
    const clean = spliceGroup(body, 'site:a', sampled);
    expect(clean.outside).toEqual([]);
    expect(clean.changedInGroup).toEqual({ collision: 2, 'band 25 m': 1, 'band 1000 m': 0 });
    expect(clean.body.collision).toBe(sampled.collision);
    expect(clean.body.band['25']).toBe(sampled.band['25']);
    expect(clean.body.directions).toBe(body.directions);
    expect(clean.body.groups).toEqual(body.groups);
    // A point of another group moved as well (index 4, site:b) and so did a uniform one (index 0): both are named,
    // and the spliced strings still hold the RECORDED values there.
    const dirty = spliceGroup(body, 'site:a', { ...sampled, collision: [1.25, 2, 30, 40, 55].map(bitsHex).join('') });
    expect(dirty.outside.map((d) => [d.query, d.index, d.group, d.recorded, d.current])).toEqual([['collision', 0, 'uniform', 1, 1.25], ['collision', 4, 'site:b', 5, 55]]);
    expect(dirty.body.collision).toBe([1, 2, 30, 40, 5].map(bitsHex).join(''));
    expect(() => spliceGroup(body, 'site:c', sampled)).toThrow(/no group site:c/);
    expect(() => spliceGroup(body, 'site:a', { ...sampled, collision: sampled.collision.slice(16) })).toThrow(/the sampling has 4 points, the recording 5/);
  });

  it('heights at the stored directions are bit-identical to the recording: collision and band-limited queries', async () => {
    if (baked.length === 0) {
      console.log('[terrain guard] no tile set is baked on this machine: the height comparison is skipped');
      return;
    }
    const terrain = await openTerrain(defs);
    const problems: string[] = [];
    for (const { bodyId } of baked) {
      const rec = recordedHeights.bodies[bodyId];
      if (!rec) {
        problems.push(`${bodyId}: baked but never recorded (the lead records it: terrain-guard.record.ts)`);
        continue;
      }
      const cur = await sampleHeights(terrain, bodyId, directionsOf(rec.directions));
      const check = (kind: string, a: string, b: string): void => {
        const diffs = heightDifferences(rec, a, b);
        if (diffs.length === 0) return;
        const shown = diffs.slice(0, 8).map((d) => `#${d.index} (${d.group}, ${d.latDeg.toFixed(4)} N ${d.lonDeg.toFixed(4)} E) ${d.recorded} -> ${d.current}`);
        problems.push(`${bodyId} ${kind}: ${diffs.length} points changed: ${shown.join('; ')}`);
      };
      check('collision', rec.collision, cur.collision);
      for (const l of BAND_LIMITS) check(`band ${l} m`, rec.band[String(l)] ?? '', cur.band[String(l)]!);
      console.log(`[terrain guard] ${bodyId}: ${rec.groups.map((g) => `${g.key} ${g.count}`).join(' + ')} directions x ${1 + BAND_LIMITS.length} queries (recorded on tile set ${rec.tilesetContentHash})`);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it(`every tile directory matches its recorded summary (${FULL ? 'file names, bytes and content' : 'file count, names and bytes; TERRAIN_GUARD_FULL=1 also reads every file'})`, async () => {
    if (baked.length === 0) {
      console.log('[terrain guard] no tile set is baked on this machine: the directory comparison is skipped');
      return;
    }
    const problems: string[] = [];
    for (const { tileset } of baked) {
      const rec = recordedTiles.tilesets[tileset];
      if (!rec) {
        problems.push(`${tileset}: baked but never recorded (the lead records it: terrain-guard.record.ts)`);
        continue;
      }
      const t0 = Date.now();
      const cur = await summariseTileset(tileset, FULL);
      for (const d of tileDifferences(rec, cur, FULL)) problems.push(`${tileset}/${d}`);
      const total = Object.values(cur);
      console.log(`[terrain guard] ${tileset}: ${total.length} directories, ${total.reduce((n, d) => n + d.files, 0)} files, ${(total.reduce((n, d) => n + d.bytes, 0) / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    expect(problems).toEqual([]);
  }, 3_600_000);
});
