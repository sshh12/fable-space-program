/**
 * Every baked simple-body tile set loads through the real TerrainProvider, one body at a time (a provider is
 * created for that body only, used, and dropped before the next): manifests promise only tiles that exist and
 * none is empty, the collision surface and the band-limited height are finite and inside the recorded
 * elevation range, the DEM landmarks of the config hold through the height authority, and the provider
 * holds tiles of that body only. Runs for the tile sets present under data/tiles (git-ignored data); with
 * PLANET_BAKE_REQUIRE=1 a configured body that is not baked fails.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { layerHasTile } from '../../../src/core/contracts/terrain';
import { latLonToDir, tilePath, type FaceId } from '../../../src/core/geo/cubeSphere';
import { DEG } from '../../../src/core/math/scalar';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { bodyDefFor, configs, manifestOf, referenceTerm, REPO_ROOT, TILES } from './shared';

const solids = configs().filter((c) => c.kind === 'solid');
const baked = solids.filter((c) => manifestOf(c.id) !== null);
const REQUIRE = process.env['PLANET_BAKE_REQUIRE'] === '1';

let base: DefLibrary;
beforeAll(async () => {
  base = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data/defs')));
});

describe('planet-bake tile sets', () => {
  it.runIf(REQUIRE)('every configured solid body is baked', () => {
    expect(solids.filter((c) => manifestOf(c.id) === null).map((c) => c.id)).toEqual([]);
  });

  for (const c of baked) {
    it(`${c.id}: the manifest promises only tiles that exist, none of them empty`, () => {
      const m = manifestOf(c.id)!;
      for (const [name, layer] of Object.entries(m.layers)) {
        for (let L = 0; L <= layer.globalMaxLevel; L++) {
          for (let f = 0; f < 6; f++) {
            for (let x = 0; x < 2 ** L; x++) {
              for (let y = 0; y < 2 ** L; y++) {
                const key = { face: f as FaceId, level: L, x, y };
                expect(layerHasTile(layer, key)).toBe(true);
                const p = path.join(TILES, tilePath(c.id, name, key, layer.ext));
                const st = existsSync(p) ? statSync(p).size : -1;
                if (st <= 0) expect.fail(`${p}: ${st < 0 ? 'missing' : 'empty'}`);
              }
            }
          }
        }
        expect(layerHasTile(layer, { face: 0, level: layer.globalMaxLevel + 1, x: 0, y: 0 })).toBe(false);
      }
    });

    it(`${c.id}: loads lazily through the TerrainProvider, alone, and answers inside its elevation range`, { timeout: 120_000 }, async () => {
      const m = manifestOf(c.id)!;
      const def = bodyDefFor(c, m);
      const defs: DefLibrary = { ...base, bodies: { [c.id]: def }, rootBodyId: c.id };
      const tp = await createTerrainProvider(defs, createFsTileSource(TILES), { bodies: [c.id] });
      expect(tp.bodyIds).toEqual([c.id]);
      expect(tp.cachedTiles().every((k) => k.startsWith(`${c.id}/`))).toBe(true);
      const elev = (m.layers['height'] as unknown as { elevation: { min: number; max: number } }).elevation;
      for (let i = 0; i < 24; i++) {
        const lat = Math.asin(((i * 37) % 24) / 12 - 0.96);
        const lon = ((i * 2.399963) % (2 * Math.PI)) - Math.PI;
        const d = latLonToDir(lat, lon);
        await tp.ensureLoaded(c.id, d, 50, 'test');
        const hc = tp.heightAt(c.id, d);
        const hb = tp.heightAt(c.id, d, 1000);
        expect(Number.isFinite(hc) && Number.isFinite(hb)).toBe(true);
        expect(hb).toBeGreaterThanOrEqual(elev.min - 1500);
        expect(hb).toBeLessThanOrEqual(elev.max + 1500);
        expect(tp.residency(c.id, d).complete).toBe(true);
      }
      expect(tp.cachedTiles().every((k) => k.replace(/^\*/, '').startsWith(`${c.id}/`))).toBe(true);
    });

    const dem = (c.landmarks ?? []).filter((l) => l.kind === 'demHeight');
    if (dem.length > 0) {
      it(`${c.id}: DEM landmarks hold through the height authority (${dem.map((l) => l.name).join(', ')})`, { timeout: 120_000 }, async () => {
        const m = manifestOf(c.id)!;
        const defs: DefLibrary = { ...base, bodies: { [c.id]: bodyDefFor(c, m) }, rootBodyId: c.id };
        const tp = await createTerrainProvider(defs, createFsTileSource(TILES), { bodies: [c.id] });
        for (const l of dem) {
          const d = latLonToDir(l.latDeg! * DEG, l.lonDegE! * DEG);
          await tp.ensureLoaded(c.id, d, 1000, 'landmark');
          const data = tp.heightParts(c.id, d, 1).data - referenceTerm(c, d);
          expect(Math.abs(data - l.expectM!), `${l.name}: ${data.toFixed(0)} m`).toBeLessThanOrEqual(l.toleranceM!);
        }
      });
    }
  }
});
