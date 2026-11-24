/**
 * The two defaults this package leaves for island-core to flip (request solar-system-sim-1 items 1 and 6), each
 * under BOTH settings, so that the flip is a one-line change with its effect already tested:
 *  - `PredictOptions.encounterRevolutions` (src/sim/orbit/patches.ts): DEFAULT_ENCOUNTER_REVOLUTIONS = 1 (v1's
 *    window: a closed patch is searched for an encounter over its first revolution) and
 *    THREE_PERIOD_ENCOUNTER_SEARCH = 3 (ARCHITECTURE 8.4): an orbit about the Earth that meets the Moon on its
 *    second revolution is 'closed' under the first and ends in the Moon's sphere under the second;
 *  - `TerrainProviderOptions.preload` (src/terrain/provider.ts): 'all' (the default) and 'launchSystems' preload
 *    the same bodies on the shipped library and answer the same heights there; on the staged library 'all'
 *    preloads every terrain body and 'launchSystems' only the Earth and the Moon (the rest load lazily).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '../../../src/core/math/vec3';
import { DEFAULT_ENCOUNTER_REVOLUTIONS, predictPatches, THREE_PERIOD_ENCOUNTER_SEARCH } from '../../../src/sim/orbit/patches';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { loadShipped, loadStaged, repoRoot, utOf, type World } from './fixtures';

let shipped: World;
let staged: World;
beforeAll(async () => {
  shipped = await loadShipped();
  staged = await loadStaged();
});

describe('the encounter search window: encounterRevolutions 1 (default) and 3', () => {
  it('an Earth orbit that meets the Moon on its second revolution: closed under the default, a Moon encounter under the three-period search', () => {
    const sys = shipped.system;
    const mu = sys.body('earth').mu;
    const tEnc = utOf(2030, 3, 1);
    const moon = sys.stateRelative('moon', 'earth', tEnc);
    // apoapsis 20,000 km off the Moon's centre (inside its 66,100 km sphere), the plane of the Moon's orbit
    const n = v3.normalize(v3.cross(moon.r, moon.v));
    const apo = v3.add(moon.r, v3.scale(n, 20e6));
    const ra = v3.len(apo);
    const rp = sys.body('earth').radius + 200e3;
    const a = (ra + rp) / 2;
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    const t0 = tEnc - 1.5 * T;
    const apoHat = v3.scale(apo, 1 / ra);
    const along = v3.normalize(v3.reject(moon.v, apoHat));
    const state = { bodyId: 'earth', r: v3.scale(apoHat, -rp), v: v3.scale(along, -Math.sqrt(mu * (2 / rp - 1 / a))) };
    expect(DEFAULT_ENCOUNTER_REVOLUTIONS).toBe(1);
    expect(THREE_PERIOD_ENCOUNTER_SEARCH).toBe(3);
    const one = predictPatches(sys, state, t0, []).current;
    expect(one[0]!.endReason).toBe('closed');
    expect(one.some((p) => p.bodyId === 'moon')).toBe(false);
    const three = predictPatches(sys, state, t0, [], { encounterRevolutions: THREE_PERIOD_ENCOUNTER_SEARCH }).current;
    expect(three[0]!.endReason).toBe('soiEnter');
    expect(three[0]!.nextBodyId).toBe('moon');
    expect(three[0]!.tEnd).toBeGreaterThan(t0 + T);
    expect(three[0]!.tEnd).toBeLessThan(tEnc);
    expect(three[1]!.bodyId).toBe('moon');
  });
});

const TILES = path.join(repoRoot, 'data', 'tiles');
const HAS_TILES = existsSync(path.join(TILES, 'earth', 'manifest.json')) && existsSync(path.join(TILES, 'moon', 'manifest.json'));

describe.skipIf(!HAS_TILES)("the terrain preload: 'all' (default) and 'launchSystems'", () => {
  it('on the shipped library both preload the Earth and the Moon and answer the same heights', async () => {
    const all = await createTerrainProvider(shipped.defs, createFsTileSource(TILES));
    const launch = await createTerrainProvider(shipped.defs, createFsTileSource(TILES), { preload: 'launchSystems' });
    expect([...all.preloadedIds].sort()).toEqual(['earth', 'moon']);
    expect([...launch.preloadedIds].sort()).toEqual(['earth', 'moon']);
    for (const body of ['earth', 'moon'] as const) {
      for (let i = 0; i < 16; i++) {
        const lat = -1.2 + 0.16 * i;
        const lon = -3 + 0.39 * i;
        const dir = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
        expect(launch.heightAt(body, dir)).toBe(all.heightAt(body, dir));
      }
    }
  }, 120_000);

  it("on the staged library 'launchSystems' preloads only the launch system and leaves every other terrain body lazy", async () => {
    const terrainBodies = Object.keys(staged.defs.bodies).filter((id) => staged.defs.bodies[id]!.terrain !== null);
    const launch = await createTerrainProvider(staged.defs, createFsTileSource(TILES), { preload: 'launchSystems' });
    expect([...launch.preloadedIds].sort()).toEqual(['earth', 'moon']);
    expect([...launch.bodyIds].sort()).toEqual([...terrainBodies].sort());
    expect(launch.loadedBodies()).toEqual(['earth', 'moon']);
  }, 120_000);
});
