/**
 * The generic ascent pilot beyond the fleet as shipped:
 *   - from a real pad on the real terrain (the baked tiles; skipped explicitly where they are absent): one launch at
 *     each site, Ka Lae lc-3 and Madrakah lc-11;
 *   - across the lift-off thrust-to-weight a builder's vehicle may have: the fleet spans 1.25 to 1.34 at sea level;
 *     variants with the first stage off-loaded (the same parts, less propellant) reach about 1.6 and 2.0. The range
 *     the pilot is shown to hold for is 1.25 to 2.0 (stated in the hand-off).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, ScenarioDef, VehicleDef } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { createRealTerrain } from '../../../tools/sim/realWorld';
import { ascentToOrbit } from './ascent';

const TILES = fs.existsSync(path.join('data', 'tiles', 'earth', 'manifest.json'));
let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

/** A library with a variant of `base` whose part `partId` holds `share` of its propellant, and a pad scenario for it. */
function offloaded(lib: DefLibrary, base: string, partId: string, share: number): { lib: DefLibrary; id: string } {
  const id = `${base}-offload-${Math.round(share * 100)}`;
  const v = JSON.parse(JSON.stringify(lib.vehicles[base]!)) as VehicleDef;
  v.id = id;
  const placement = v.parts.find((p) => p.id === partId)!;
  placement.resources = Object.fromEntries((lib.parts[placement.def]!.resources ?? []).map((r) => [r.resource, r.capacity * share]));
  const scenario: ScenarioDef = { ...lib.scenarios[`fleet-${base}`]!, id: `fleet-${id}`, vehicle: id };
  return { lib: { ...lib, vehicles: { ...lib.vehicles, [id]: v }, scenarios: { ...lib.scenarios, [scenario.id]: scenario } }, id };
}

describe('the generic ascent pilot on the real terrain', () => {
  it.skipIf(!TILES)('Ka Lae lc-3: Solstice / Kestrel LF', async () => {
    await ascentToOrbit(defs, 'solstice-kestrel', false, { terrain: await createRealTerrain(defs) });
  }, 300_000);
  it.skipIf(!TILES)('Madrakah lc-11: Azimuth 1 / Pathfinder', async () => {
    await ascentToOrbit(defs, 'azimuth-pathfinder', false, { scenario: 'fleet-azimuth-pathfinder-madrakah', terrain: await createRealTerrain(defs) });
  }, 300_000);
});

describe('the generic ascent pilot across lift-off thrust-to-weight', () => {
  for (const [base, part, share] of [['solstice-pelican', 'lv-s1', 0.72], ['azimuth-pathfinder', 'lv-s1', 0.55]] as const) {
    it(`${base} with its first stage at ${Math.round(share * 100)} %`, async () => {
      const { lib, id } = offloaded(defs, base, part, share);
      const twr = analyzeVehicle(lib, lib.vehicles[id]!).stages[0]!.twrSeaLevel;
      expect(twr).toBeGreaterThan(1.55);
      console.log(`${id}: lift-off thrust-to-weight ${twr.toFixed(2)} at sea level`);
      await ascentToOrbit(lib, id, false);
    }, 300_000);
  }
});
