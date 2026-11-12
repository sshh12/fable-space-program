/**
 * The staged outputs of the planet bake (data/staged, git-ignored until activation moves them into
 * data/defs): every giant's map descriptor and maps, Saturn's ring strip over the staged RingDef radii, and
 * data/staged/credits.json listing every source of every config with a redistributable licence. Runs when the
 * staged files exist (PLANET_BAKE_REQUIRE=1 makes their absence a failure).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configs, readJson, REPO_ROOT } from './shared';

const STAGED = path.join(REPO_ROOT, 'data/staged');
const REQUIRE = process.env['PLANET_BAKE_REQUIRE'] === '1';
const giants = configs().filter((c) => c.kind === 'giant');

interface MapEntry {
  path: string;
  width: number;
  height: number;
  channels: string[];
  format: 'png' | 'webp';
  kind: 'equirect' | 'radial';
  credit: string;
  innerKm?: number;
  outerKm?: number;
}

/** Width and height from a PNG (IHDR) or a WebP (VP8 / VP8L / VP8X) header. */
function imageSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  if (b.subarray(1, 4).toString('ascii') === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  const chunk = b.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
}

describe('planet-bake staged outputs', () => {
  for (const g of giants) {
    const desc = path.join(STAGED, 'render', `${g.id}.maps.json`);
    it.runIf(REQUIRE || existsSync(desc))(`${g.id}: every configured map is staged at its size`, () => {
      const d = readJson<{ body: string; maps: Record<string, MapEntry> }>(desc);
      expect(d.body).toBe(g.id);
      for (const m of g.globals!) {
        const e = d.maps[m.name];
        expect(e, m.name).toBeDefined();
        const f = path.join(STAGED, 'render', e!.path);
        expect(statSync(f).size).toBeGreaterThan(0);
        expect(imageSize(f)).toEqual({ w: m.width, h: m.height });
        expect(e!.credit.length).toBeGreaterThan(10);
      }
    });
  }

  const sat = path.join(STAGED, 'render', 'saturn.maps.json');
  it.runIf(REQUIRE || existsSync(sat))('Saturn ring strip spans the staged RingDef radii (74,658-136,780 km)', () => {
    const d = readJson<{ maps: Record<string, MapEntry> }>(sat);
    const r = d.maps['saturn-rings']!;
    expect(r.kind).toBe('radial');
    expect([r.innerKm, r.outerKm]).toEqual([74658, 136780]);
    expect(r.channels).toEqual(['r', 'g', 'b', 'a']);
  });

  const credits = path.join(STAGED, 'credits.json');
  it.runIf(REQUIRE || existsSync(credits))('credits.json lists every source of every config, each with a redistributable licence', () => {
    const doc = readJson<{ entries: { id: string; licence: string; attribution: string; bodies: string[] }[] }>(credits);
    const have = new Map(doc.entries.map((e) => [e.id, e]));
    for (const c of configs()) {
      for (const id of c.credits) {
        const e = have.get(id);
        expect(e, `${c.id}: ${id}`).toBeDefined();
        expect(e!.bodies).toContain(c.name);
        expect(/public domain|cc by|no access or use constraints/i.test(e!.licence), e!.licence).toBe(true);
      }
    }
  });
});
