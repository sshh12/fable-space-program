/**
 * Transfer flights (solar-system-sim acceptance; tests, not mission proofs): the generic transfer pilot
 * (src/pilot/generic/transfer.ts) on createSession with the staged Sun-rooted library flies a craft from a 200 km
 * Earth parking orbit into a bound orbit about its target (e < 1 after the capture burn) under real physics,
 * through the player's commands only: the 6.5 km/s stack of data/defs/scenarios/transfer-leo-200.json to Mars
 * from three start dates (one day before the pilot's own Lambert windows of 2030-12, 2033 and 2035).
 *
 * Minutes of CPU per flight, so gated: run on demand (and by session-switch on LocalSession) with
 *   SOLAR_SYSTEM_FLIGHTS=1 node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/solar-system/transferFlight.test.ts
 * (SOLAR_SYSTEM_FLIGHTS=<target id> flies only that target's flights; SOLAR_SYSTEM_VERBOSE=1 prints the log.)
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { createTransferPilot } from '../../../src/pilot/generic/transfer';
import { runHeadless } from '../../../src/pilot/runner';
import { createSession } from '../../../src/session';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { loadStaged, repoRoot } from './fixtures';
import { departurePlane } from './flightPlane';

const TILES = path.join(repoRoot, 'data', 'tiles');
const GATE = process.env['SOLAR_SYSTEM_FLIGHTS'] ?? '';
const HAVE_TILES = existsSync(path.join(TILES, 'earth', 'manifest.json'));
const runs = (targetId: string): boolean => HAVE_TILES && (GATE === '1' || GATE.split(',').includes(targetId));

export interface FlightResult {
  bodyId: string;
  e: number;
  periapsisAltitude: number;
  apoapsisAltitude: number;
  failure: string | null;
  log: string[];
  flown: Record<string, number>;
  /** Delta-v flown in all, m/s; what the craft had at the start, m/s. */
  total: number;
  deltaVStart: number;
  simDays: number;
  wallSeconds: number;
}

/** Fly scenario `scenarioId` from `startUt` to `targetId`, in the departure plane of its window; the end state and the pilot's record. */
export async function fly(scenarioId: string, targetId: string, startUt: number): Promise<FlightResult> {
  const t0 = performance.now();
  const { defs: base } = await loadStaged();
  const sc0 = base.scenarios[scenarioId]!;
  if (sc0.start.kind !== 'orbit') throw new Error(`${scenarioId}: not an orbit start`);
  const plane = await departurePlane(targetId, startUt, sc0.start.inclinationDeg, base.bodies['earth']!.radius + sc0.start.periapsisAltitude);
  const sc = { ...sc0, startUt, start: { ...sc0.start, ...plane } };
  const defs: DefLibrary = { ...base, scenarios: { ...base.scenarios, [sc.id]: sc } };
  const terrain = await createTerrainProvider(defs, createFsTileSource(TILES), { preload: 'launchSystems' });
  const sim = createSession(defs, sc.id, { terrain });
  const log: string[] = [];
  const wall = (): string => `${((performance.now() - t0) / 1000).toFixed(0)} s`;
  const pilot = createTransferPilot(defs, sim.scenario!, { targetId, onLog: (e) => log.push(`${((e.ut - startUt) / 86400).toFixed(3)} d [${wall()}] ${e.phase}: ${e.note}`) });
  await sim.ready;
  const deltaVStart = sim.peek().readouts.deltaVTotal;
  let run: Awaited<ReturnType<typeof runHeadless>>;
  try {
    run = await runHeadless(sim, pilot, { maxSimTime: 8 * 365.25 * 86400, record: false });
  } catch (e) {
    console.log(log.join('\n'));
    throw e;
  }
  const s = sim.snapshot();
  const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
  const flown = { ...pilot.flown };
  const total = Object.values(flown).reduce((a, b) => a + b, 0);
  const wallSeconds = (performance.now() - t0) / 1000;
  log.unshift(`parking orbit: ${sc.start.kind === 'orbit' ? `${sc.start.inclinationDeg.toFixed(2)} deg, node ${sc.start.lanDeg.toFixed(2)} deg` : ''}`);
  log.push(`end: ${run.reason}, body ${v.bodyId}, e ${s.readouts.eccentricity.toFixed(4)}, flown ${total.toFixed(0)} of ${deltaVStart.toFixed(0)} m/s, ${(run.simTime / 86400).toFixed(1)} d, ${wallSeconds.toFixed(0)} s wall`);
  if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(log.join('\n'));
  return {
    bodyId: v.bodyId,
    e: s.readouts.eccentricity,
    periapsisAltitude: s.readouts.periapsisAltitude,
    apoapsisAltitude: s.readouts.apoapsisAltitude,
    failure: pilot.failure ?? (run.reason === 'done' ? null : `${run.reason}: ${run.failure ?? ''}`),
    log,
    flown,
    total,
    deltaVStart,
    simDays: run.simTime / 86400,
    wallSeconds,
  };
}

describe.skipIf(!runs('mars'))('transfer flights to Mars on the staged library', () => {
  // one day before the pilot's Lambert windows of 2030-12-24, 2033-04-16 and 2035-06-26 (whole hours: on the tick grid)
  it.each([977493600, 1050422400, 1119636000])('the 6.5 km/s stack from a 200 km Earth orbit into a bound orbit about Mars (start %i)', async (startUt) => {
    const r = await fly('transfer-leo-200', 'mars', startUt);
    expect(r.failure, r.log.join('\n')).toBeNull();
    expect(r.bodyId).toBe('mars');
    expect(r.e).toBeLessThan(1);
    expect(r.periapsisAltitude).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(r.deltaVStart);
  }, 3_600_000);
});

describe.skipIf(!runs('venus'))('a transfer flight to an inner planet: Venus', () => {
  // one day before the pilot's Lambert window of 2031-06-05
  it('the 6.5 km/s stack from a 200 km Earth orbit into a bound orbit about Venus', async () => {
    const r = await fly('transfer-leo-200', 'venus', 991573200);
    expect(r.failure, r.log.join('\n')).toBeNull();
    expect(r.bodyId).toBe('venus');
    expect(r.e).toBeLessThan(1);
    expect(r.periapsisAltitude).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(r.deltaVStart);
  }, 3_600_000);
});

describe.skipIf(!runs('callisto'))('a transfer flight to a moon of a giant: Callisto', () => {
  // one day before the pilot's Lambert window of 2030-01-25 (a 910-day arc to Jupiter, the flyby tangent to Callisto's orbit)
  it('the Albatross cruiser (10.9 km/s) from a 200 km Earth orbit into a bound orbit about Callisto', async () => {
    const r = await fly('transfer-albatross-leo-200', 'callisto', 948790800);
    expect(r.failure, r.log.join('\n')).toBeNull();
    expect(r.bodyId).toBe('callisto');
    expect(r.e).toBeLessThan(1);
    expect(r.periapsisAltitude).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(r.deltaVStart);
  }, 3_600_000);
});
