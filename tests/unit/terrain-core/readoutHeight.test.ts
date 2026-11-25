/**
 * Request island-core-3: a read-out's band-limited height must be a function of the position alone. A plain
 * band-limited query (`heightAt` with `lambdaMin` finer than the pinned pyramid) answers from the finest RESIDENT
 * level, so it moves when an unrelated request loads finer tiles nearby; `stableHeightAt` clamps the band to
 * `pinnedBand` (the data wavelength of the resident level) and does not. The point and the disc are the
 * request's: the Moon at latitude 2.5877 deg, longitude 171.5265 deg (LUNAR_ORBIT's sub-point), a band of 2,100 m,
 * a 30 km disc made resident 24 km away. Skipped without the baked tiles.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { REPO_ROOT } from './helpers';

const TILES = path.join(REPO_ROOT, 'data', 'tiles');
const HAS_MOON = existsSync(path.join(TILES, 'moon', 'manifest.json'));
const DEG = Math.PI / 180;
const dirOf = (latDeg: number, lonDeg: number): { x: number; y: number; z: number } => ({
  x: Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG),
  y: Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG),
  z: Math.sin(latDeg * DEG),
});

describe.skipIf(!HAS_MOON)('read-out heights do not depend on the cache (request island-core-3)', () => {
  it('the same point under two residency states: heightAt moves, stableHeightAt is equal to the bit', async () => {
    const defs = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data', 'defs')));
    const tp = await createTerrainProvider(defs, createFsTileSource(TILES));
    const lat = 2.5877;
    const lon = 171.5265;
    const p = dirOf(lat, lon);
    const band = 2100;
    const pinned = tp.pinnedBand('moon');
    // the request measured: equal at 4,000 m and coarser, different at 2,100 m
    expect(pinned).toBeGreaterThan(2100);
    expect(pinned).toBeLessThanOrEqual(4000);
    const plainBefore = tp.heightAt('moon', p, band);
    const stableBefore = tp.stableHeightAt('moon', p, band);
    const coarseBefore = tp.heightAt('moon', p, 4000);
    // an unrelated request: a 30 km disc centred 24 km from the point
    const R = defs.bodies['moon']!.radius;
    await tp.ensureLoaded('moon', dirOf(lat, lon + (24e3 / R / Math.cos(lat * DEG)) / DEG), 30e3, 'other');
    const plainAfter = tp.heightAt('moon', p, band);
    const stableAfter = tp.stableHeightAt('moon', p, band);
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(`pinned band ${pinned.toFixed(1)} m; heightAt(2,100) ${plainBefore} -> ${plainAfter}; stableHeightAt ${stableBefore} -> ${stableAfter}`);
    expect(plainAfter).not.toBe(plainBefore);
    expect(stableAfter).toBe(stableBefore);
    expect(tp.heightAt('moon', p, 4000)).toBe(coarseBefore);
    // at or above the pinned band the two queries are the same query
    expect(tp.stableHeightAt('moon', p, 5000)).toBe(tp.heightAt('moon', p, 5000));
    expect(stableBefore).toBe(tp.heightAt('moon', p, pinned));
  }, 120_000);
});
