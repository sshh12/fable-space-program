/**
 * Transfer flights (solar-system-sim acceptance; tests, not mission proofs): the generic transfer pilot
 * (src/pilot/generic/transfer.ts) on createSession with the staged Sun-rooted library takes the 6.5 km/s stack of
 * data/defs/scenarios/transfer-leo-200.json from a 200 km Earth orbit into a bound orbit about Mars (e < 1 after
 * the capture burn), from three start dates two days before three windows.
 *
 * Minutes of CPU per flight: run on demand (and by session-switch on LocalSession) with
 *   SOLAR_SYSTEM_FLIGHTS=1 node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/solar-system/transferFlight.test.ts
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { createTransferPilot } from '../../../src/pilot/generic/transfer';
import { runHeadless } from '../../../src/pilot/runner';
import { createSession } from '../../../src/session';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { loadStaged, repoRoot } from './fixtures';

const TILES = path.join(repoRoot, 'data', 'tiles');
const RUN = process.env['SOLAR_SYSTEM_FLIGHTS'] === '1' && existsSync(path.join(TILES, 'earth', 'manifest.json'));

/** Fly the transfer scenario from `startUt` to `targetId`; the end state and the pilot's record. */
async function fly(targetId: string, startUt: number): Promise<{ bodyId: string; e: number; periapsisAltitude: number; failure: string | null; log: string[]; flown: Record<string, number> }> {
  const { defs: base } = await loadStaged();
  const sc = { ...base.scenarios['transfer-leo-200']!, startUt };
  const defs: DefLibrary = { ...base, scenarios: { ...base.scenarios, [sc.id]: sc } };
  const terrain = await createTerrainProvider(defs, createFsTileSource(TILES), { preload: 'launchSystems' });
  const sim = createSession(defs, sc.id, { terrain });
  const log: string[] = [];
  const pilot = createTransferPilot(defs, sim.scenario!, { targetId, onLog: (e) => log.push(`${((e.ut - startUt) / 86400).toFixed(2)} d ${e.phase}: ${e.note}`) });
  await runHeadless(sim, pilot, { maxSimTime: 3 * 365 * 86400 });
  const s = sim.snapshot();
  const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
  if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(log.join('\n'));
  return { bodyId: v.bodyId, e: s.readouts.eccentricity, periapsisAltitude: s.readouts.periapsisAltitude, failure: pilot.failure, log, flown: { ...pilot.flown } };
}

describe.skipIf(!RUN)('transfer flights on the staged library', () => {
  // two days before the pilot's Hohmann windows of 2031, 2033 and 2035 (whole seconds: on the tick grid)
  it.each([981244800, 1047686400, 1115467200])('a 6.5 km/s stack from a 200 km Earth orbit into a bound orbit about Mars (start %i)', async (startUt) => {
    const r = await fly('mars', startUt);
    expect(r.failure, r.log.join('\n')).toBeNull();
    expect(r.bodyId).toBe('mars');
    expect(r.e).toBeLessThan(1);
    expect(r.periapsisAltitude).toBeGreaterThan(0);
  }, 1_800_000);
});
