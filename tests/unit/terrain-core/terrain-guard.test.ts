/**
 * The terrain guard (see terrain-guard.ts): the recorded heights bit for bit, and the summary of every tile
 * directory. Runs on the real baked tiles; a body whose tile set is not baked on this machine is skipped
 * with a note (CI has no tiles), a body that is baked but was never recorded fails.
 */
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import {
  BAND_LIMITS,
  bakedTerrainBodies,
  bitsHex,
  guardDirections,
  heightDifferences,
  HEIGHTS_FILE,
  hexToNumber,
  loadRealDefs,
  POINTS_PER_BODY,
  sampleHeights,
  summariseTileset,
  tileDifferences,
  TILES_FILE,
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
  });

  it('the fixed directions are unit vectors, the same on every call, 2,000 per body', () => {
    for (const { bodyId } of baked) {
      const a = guardDirections(defs, bodyId);
      const b = guardDirections(defs, bodyId);
      expect(a).toHaveLength(POINTS_PER_BODY);
      expect(a).toEqual(b);
      for (const d of a) expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-12);
    }
  });

  it('heights at the fixed directions are bit-identical to the recording: collision and band-limited queries', async () => {
    if (baked.length === 0) {
      console.log('[terrain guard] no tile set is baked on this machine: the height comparison is skipped');
      return;
    }
    const current = await sampleHeights(defs);
    const problems: string[] = [];
    for (const { bodyId } of baked) {
      const rec = recordedHeights.bodies[bodyId];
      const cur = current.bodies[bodyId]!;
      if (!rec) {
        problems.push(`${bodyId}: baked but never recorded (the lead records it: terrain-guard.record.ts)`);
        continue;
      }
      const describe = (kind: string, a: string, b: string): void => {
        if (a === b) return;
        const diffs = heightDifferences(a, b);
        problems.push(`${bodyId} ${kind}: ${diffs.map((d) => `#${d.index} ${d.recorded} -> ${d.current} (${(d.current - d.recorded).toExponential(2)} m)`).join('; ')}`);
      };
      describe('collision', rec.collision, cur.collision);
      for (const l of BAND_LIMITS) describe(`band ${l} m`, rec.band[String(l)] ?? '', cur.band[String(l)]!);
      console.log(`[terrain guard] ${bodyId}: ${cur.points} directions x ${1 + BAND_LIMITS.length} queries (tile set ${cur.tilesetContentHash}, recorded on ${rec.tilesetContentHash})`);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it(`every tile directory matches its recorded summary (${FULL ? 'file names, bytes and content' : 'file count and names; TERRAIN_GUARD_FULL=1 also reads every file'})`, () => {
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
      const cur = summariseTileset(tileset, FULL);
      for (const d of tileDifferences(rec, cur, FULL)) problems.push(`${tileset}/${d}`);
      console.log(`[terrain guard] ${tileset}: ${Object.keys(cur).length} directories, ${Object.values(cur).reduce((n, d) => n + d.files, 0)} files`);
    }
    expect(problems).toEqual([]);
  }, 3_600_000);
});
