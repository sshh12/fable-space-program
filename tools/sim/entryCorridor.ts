/**
 * Re-entry corridor sweep: the capsule alone on a lunar-return trajectory with a chosen vacuum perigee,
 * flown by the mission pilot's entry and parachute phases through the real Sim on the real Earth tiles.
 * For each perigee: the outcome class, the peak load, the down-range from the entry point of the predicted
 * trajectory (atmosphere top, the `atmosphereEntry` marker) to the splash point, and what is left of the
 * ablator and of the thruster propellant at drogue deployment.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/entryCorridor.ts [--from 10] [--to 90] [--step 10]
 */
import path from 'node:path';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { DEG, RAD } from '@/core/math/scalar';
import { createMissionPilot, runHeadless } from '@/pilot';
import { createSession } from '@/session';
import { createRealTerrain, loadLibrary } from './realWorld';

export type EntryOutcome = 'landed' | 'skipped' | 'crewLost' | 'destroyed' | 'timeout';

export interface CorridorResult {
  perigeeKm: number;
  outcome: EntryOutcome;
  /** Ground distance from the entry point of the vacuum trajectory (atmosphere top) to the splash point, km. */
  downRangeKm: number;
  /** Seconds from the entry point to splashdown. */
  flightTime: number;
  peakG: number;
  gDose: number;
  ablatorLeft: number;
  rcsLeftAtDrogues: number;
  splashSpeed: number;
  entrySpeed: number;
  entryFlightPathDeg: number;
  onWater: boolean;
  /** Why the mission failed (crew lost, capsule destroyed), null otherwise. */
  failure: string | null;
}

/** Semi-major axis of the return ellipse (apogee near the Moon's distance), m. */
const RETURN_APOGEE = 384.4e6;

/**
 * A capsule-only scenario on a return ellipse with the given vacuum perigee, starting `startAltitude`
 * above the datum on the inbound leg, in a plane of the given inclination, coming down over
 * (`entryLatDeg`, `entryLonDeg`) heading `headingDeg` at the start point.
 */
export function entryScenario(defs: DefLibrary, base: ScenarioDef, perigeeAltitude: number, opts: { startAltitude?: number; latDeg?: number; lonDeg?: number; headingDeg?: number; startUt?: number; id?: string } = {}): ScenarioDef {
  const earth = defs.bodies[defs.rootBodyId]!;
  const mu = earth.mu;
  const R = earth.radius;
  const rp = R + perigeeAltitude;
  const a = 0.5 * (rp + RETURN_APOGEE);
  const r0 = R + (opts.startAltitude ?? 400000);
  const v0 = Math.sqrt(mu * (2 / r0 - 1 / a));
  const vp = Math.sqrt(mu * (2 / rp - 1 / a));
  const cosGamma = (rp * vp) / (r0 * v0);
  const gamma = -Math.acos(Math.min(1, cosGamma));
  const lat = (opts.latDeg ?? 0) * DEG;
  const lon = (opts.lonDeg ?? -150) * DEG;
  const heading = (opts.headingDeg ?? 90) * DEG;
  const startUt = opts.startUt ?? base.startUt;
  // Body-fixed frame at the start point, then to inertial with the Earth's orientation at startUt.
  const rot = earth.rotation;
  if (rot.mode !== 'fixedRate') throw new Error('entryScenario: the root body needs a fixed-rate rotation');
  const W = (rot.w0Deg + (rot.rateDegPerDay * (startUt - rot.epochUt)) / 86400) * DEG + Math.PI / 2;
  // Earth: pole = +Z, so BCBF -> BCI is a rotation about Z by W (the 90 degree node offset is part of the IAU form).
  const lonI = lon + W;
  const up = [Math.cos(lat) * Math.cos(lonI), Math.cos(lat) * Math.sin(lonI), Math.sin(lat)];
  const east = [-Math.sin(lonI), Math.cos(lonI), 0];
  const north = [-Math.sin(lat) * Math.cos(lonI), -Math.sin(lat) * Math.sin(lonI), Math.cos(lat)];
  const horiz = [0, 1, 2].map((i) => east[i]! * Math.sin(heading) + north[i]! * Math.cos(heading));
  const r: [number, number, number] = [up[0]! * r0, up[1]! * r0, up[2]! * r0];
  const v: [number, number, number] = [0, 1, 2].map((i) => v0 * (Math.cos(gamma) * horiz[i]! + Math.sin(gamma) * up[i]!)) as [number, number, number];
  return {
    id: opts.id ?? `entry-${Math.round(perigeeAltitude / 1000)}`,
    name: `Entry, vacuum perigee ${(perigeeAltitude / 1000).toFixed(0)} km`,
    vehicle: base.vehicle,
    site: base.site,
    startUt,
    start: { kind: 'state', bodyId: earth.id, r, v, attitude: 'retrograde' },
    stagesAlreadyFired: 8,
    target: base.target,
    suggestedLanding: base.suggestedLanding,
    milestones: [
      { id: 'ENTRY', trigger: { kind: 'altitudeCrossing', bodyId: earth.id, altitude: 122000, direction: 'descending' } },
      { id: 'DROGUES', trigger: { kind: 'chuteDeployed', mode: 'drogue' }, after: ['ENTRY'] },
      { id: 'MAINS', trigger: { kind: 'chuteDeployed', mode: 'main' }, after: ['DROGUES'] },
      { id: 'SPLASHDOWN', trigger: { kind: 'touchdown', bodyId: earth.id, surface: 'any', settleTime: 30 }, after: ['MAINS'] },
    ],
  };
}

export async function flyEntry(defs: DefLibrary, terrain: TerrainProvider, perigeeAltitude: number, opts: Parameters<typeof entryScenario>[3] = {}): Promise<CorridorResult> {
  const base = defs.scenarios['lunar-direct']!;
  const sc = entryScenario(defs, base, perigeeAltitude, opts);
  const lib: DefLibrary = { ...defs, scenarios: { ...defs.scenarios, [sc.id]: sc } };
  const sim = createSession(lib, sc.id, { terrain });
  const pilot = createMissionPilot(lib, sc);
  await sim.ready;
  const first = sim.peek();
  const entry = first.patches.current.flatMap((p) => p.markers).find((m) => m.kind === 'atmosphereEntry');
  let rcsAtDrogues = NaN;
  let escaped = false;
  let peakG = 0;
  let peakDose = 0;
  const run = await runHeadless(sim, pilot, {
    maxSimTime: 3 * 3600,
    until: (s) => {
      // A skip: back above the atmosphere after the entry, going up.
      if (s.milestones.some((m) => m.id === 'ENTRY') && s.readouts.altitudeAsl > 150000 && s.readouts.verticalSpeed > 0) escaped = true;
      return escaped;
    },
    onTick: (s) => {
      if (s.readouts.gLoad > peakG) peakG = s.readouts.gLoad;
      if (s.readouts.gDose > peakDose) peakDose = s.readouts.gDose;
      const d = s.milestones.find((m) => m.id === 'DROGUES');
      if (d && Number.isNaN(rcsAtDrogues)) rcsAtDrogues = d.data['rcsFraction'] ?? NaN;
    },
  });
  const last = run.last;
  const splash = last.milestones.find((m) => m.id === 'SPLASHDOWN');
  let outcome: EntryOutcome;
  if (splash) outcome = 'landed';
  else if (escaped) outcome = 'skipped';
  else if (!last.mission.crewAlive) outcome = 'crewLost';
  else if (last.mission.failed) outcome = 'destroyed';
  else outcome = 'timeout';
  let downRange = NaN;
  let flightTime = NaN;
  if (entry && entry.latitude !== undefined && entry.longitude !== undefined) {
    const a = [Math.cos(entry.latitude) * Math.cos(entry.longitude), Math.cos(entry.latitude) * Math.sin(entry.longitude), Math.sin(entry.latitude)];
    const lat = last.readouts.latitude;
    const lon = last.readouts.longitude;
    const b = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const dot = Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
    downRange = (Math.acos(dot) * defs.bodies[defs.rootBodyId]!.radius) / 1000;
    flightTime = last.simUt - entry.ut;
  }
  const d = splash?.data ?? last.milestones[last.milestones.length - 1]?.data ?? {};
  return {
    perigeeKm: perigeeAltitude / 1000,
    outcome,
    downRangeKm: downRange,
    flightTime,
    peakG: Math.max(peakG, splash?.data['peakG'] ?? 0),
    gDose: Math.max(peakDose, splash?.data['peakGDose'] ?? 0),
    ablatorLeft: last.readouts.ablatorFraction ?? d['ablatorFraction'] ?? NaN,
    rcsLeftAtDrogues: rcsAtDrogues,
    splashSpeed: d['touchdownVerticalSpeed'] ?? NaN,
    entrySpeed: entry?.value ?? NaN,
    entryFlightPathDeg: (entry?.flightPathAngle ?? NaN) * RAD,
    onWater: (d['surfaceWater'] ?? 0) === 1,
    failure: last.mission.failed ? last.mission.failureReason : null,
  };
}

export async function corridorSweep(perigeesKm: readonly number[]): Promise<CorridorResult[]> {
  const defs = await loadLibrary();
  const terrain = await createRealTerrain(defs);
  const out: CorridorResult[] = [];
  for (const km of perigeesKm) out.push(await flyEntry(defs, terrain, km * 1000));
  return out;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('tools/sim/entryCorridor.ts');
if (invokedDirectly) {
  const num = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const from = num('from', 10);
  const to = num('to', 90);
  const step = num('step', 10);
  const list: number[] = [];
  for (let k = from; k <= to + 1e-9; k += step) list.push(k);
  const res = await corridorSweep(list);
  console.log('perigee km | outcome  | down-range km | flight s | peak g | g-dose | ablator left | RCS left at drogues | splash m/s | entry km/s | FPA deg');
  for (const r of res) {
    console.log(
      `${r.perigeeKm.toFixed(0).padStart(10)} | ${r.outcome.padEnd(8)} | ${r.downRangeKm.toFixed(0).padStart(13)} | ${r.flightTime.toFixed(0).padStart(8)} | ${r.peakG.toFixed(2).padStart(6)} | ${r.gDose.toFixed(2).padStart(6)} | ${(r.ablatorLeft * 100).toFixed(1).padStart(11)}% | ${(r.rcsLeftAtDrogues * 100).toFixed(1).padStart(18)}% | ${r.splashSpeed.toFixed(2).padStart(10)} | ${(r.entrySpeed / 1000).toFixed(3).padStart(10)} | ${r.entryFlightPathDeg.toFixed(2)}${r.failure ? ` | ${r.failure}` : ''}`,
    );
  }
}
