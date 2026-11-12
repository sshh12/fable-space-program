/**
 * Mission records and their comparison with tests/mission/baseline-v1.json (lead-owned). The two
 * comparisons, EXACT and ENVELOPE, and why there are two, are in tools/dev/mission-baseline.ts.
 *
 * Comparisons (nothing flies):
 *   npx tsx tools/dev/record-mission-baseline.ts --exact <record.json>
 *       EXACT against the baseline: every milestone equal; prints where a difference starts. Exit 1 on one.
 *   npx tsx tools/dev/record-mission-baseline.ts --envelope <record.json> --controls <controls.json>
 *       ENVELOPE against the baseline: per milestone the event mission time and da/a within twice the
 *       largest difference among the control flights of the controls file; prints the table. Exit 1 when a
 *       milestone is outside. `--reference <record.json>` compares against another record than the baseline.
 *
 * Flights (each flies the tree's `lunar-direct` once, about a minute; through the gate):
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --check
 *       fly and compare EXACT against the baseline
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --out <file> [--label <text>]
 *       fly and write the record to <file> (a candidate for --envelope, or one control flight)
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --record-baseline
 *       fly and REWRITE tests/mission/baseline-v1.json: the lead's act only.
 *
 * A step's owner who needs flights this script cannot make (control flights with shifted starts) uses
 * `captureMilestones()` below with its own `fly()` set-up and writes the records with `writeRecord()`; a
 * controls file is `{ "controls": [ <record>, ... ] }`.
 *
 * The flight is the one `npm run test:mission` flies (tests/mission/harness.ts `fly()`: the real session on
 * the real baked tiles, the scripted pilot, the terrain await protocol). At the first control tick at which a
 * milestone is on record, the capture notes the active vessel's state from `peek()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../src/core/contracts/defs';
import type { MilestoneRecord, SimSnapshot } from '../../src/core/contracts/sim';
import { COMPARE_DOC, compareEnvelope, compareExact, describeEnvelope, describeExact, elementsOf, normaliseRecord, parseControls, type MilestoneState, type MissionRecord } from './mission-baseline';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_FILE = path.join(repoRoot, 'tests', 'mission', 'baseline-v1.json');
const SCENARIO = 'lunar-direct';

type PendingState = Omit<MilestoneState, 'elements'>;

function stateOf(s: SimSnapshot, m: MilestoneRecord): PendingState {
  const vessel = s.vessels.find((x) => x.id === s.activeVesselId);
  if (!vessel) throw new Error(`milestone ${m.id}: no active vessel in the snapshot`);
  const rd = s.readouts;
  return {
    id: m.id,
    ut: m.ut,
    captureUt: s.simUt,
    captureOffset: s.simUt - m.ut,
    met: rd.met,
    vesselId: vessel.id,
    bodyId: vessel.bodyId,
    situation: vessel.situation,
    r: [vessel.r.x, vessel.r.y, vessel.r.z],
    v: [vessel.v.x, vessel.v.y, vessel.v.z],
    apoapsisAltitude: rd.apoapsisAltitude,
    periapsisAltitude: rd.periapsisAltitude,
    latitude: rd.latitude,
    longitude: rd.longitude,
    altitudeAsl: rd.altitudeAsl,
    speedOrbital: rd.speedOrbital,
    speedSurface: rd.speedSurface,
    mass: vessel.mass,
    data: m.data,
  };
}

/** What `finish` needs of a finished flight (the `Flight` of tests/mission/harness.ts has all of it). */
export interface FinishedFlight {
  defs: DefLibrary;
  scenario: { startUt: number };
  hash: string;
  milestones: MilestoneRecord[];
  run: { last: SimSnapshot; simTime: number; failure?: string | null; stats: { steps: number; railsAdvances: number; ticks: number } };
}

/**
 * Capture the milestone states of a flight: pass `onPilotTick` to `fly()` (tests/mission/harness.ts) and call
 * `finish` with the finished flight and the tile-set hashes it flew on.
 */
export function captureMilestones(label: string): { onPilotTick: (s: SimSnapshot) => void; finish: (flight: FinishedFlight, tiles: Record<string, string>) => MissionRecord } {
  const pending: PendingState[] = [];
  return {
    onPilotTick: (s) => {
      for (let k = pending.length; k < s.milestones.length; k++) pending.push(stateOf(s, s.milestones[k]!));
    },
    finish: (flight, tiles) => {
      if (flight.run.failure) throw new Error(`the flight failed: ${flight.run.failure}`);
      if (pending.length !== flight.milestones.length) throw new Error(`captured ${pending.length} milestone states for ${flight.milestones.length} milestones`);
      const last = flight.run.last;
      if (last.cheatCounter !== 0) throw new Error('the flight used a debug mutator');
      if (last.terrain.incompleteQueries !== 0) throw new Error(`the flight had ${last.terrain.incompleteQueries} incomplete terrain queries`);
      // The elements need the gravitational parameter of each state's body, from the library the flight loaded.
      const milestones: MilestoneState[] = pending.map((st) => {
        const body = flight.defs.bodies[st.bodyId];
        if (!body) throw new Error(`unknown body ${st.bodyId}`);
        return { ...st, elements: elementsOf(body.mu, { x: st.r[0], y: st.r[1], z: st.r[2] }, { x: st.v[0], y: st.v[1], z: st.v[2] }) };
      });
      const active = last.vessels.find((x) => x.id === last.activeVesselId)!;
      const splash = flight.milestones[flight.milestones.length - 1];
      const zone = last.surfaceTargets.filter((t) => t.kind === 'recovery').find((t) => Math.abs(t.radius - (splash?.data['recoveryZoneRadius'] ?? Number.NaN)) < 1);
      return {
        format: 2,
        label,
        scenario: SCENARIO,
        compare: COMPARE_DOC,
        stateHash: flight.hash,
        steps: flight.run.stats.steps,
        railsAdvances: flight.run.stats.railsAdvances,
        controlTicks: flight.run.stats.ticks,
        simSeconds: flight.run.simTime,
        startUt: flight.scenario.startUt,
        tiles,
        node: process.version,
        milestones,
        final: { ut: last.simUt, vesselId: active.id, bodyId: active.bodyId, situation: active.situation, latitude: last.readouts.latitude, longitude: last.readouts.longitude, recoveryZone: zone?.name ?? null },
      };
    },
  };
}

export function writeRecord(file: string, record: MissionRecord): void {
  fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
}

export function readRecord(file: string, label = path.basename(file)): MissionRecord {
  return normaliseRecord(JSON.parse(fs.readFileSync(file, 'utf8')) as MissionRecord, label);
}

/** Fly the tree's mission once and return its record. The simulation is imported only here. */
async function flyRecord(label: string): Promise<MissionRecord> {
  const { fly, tileContentHashes } = await import('../../tests/mission/harness');
  const capture = captureMilestones(label);
  const flight = await fly({ scenario: SCENARIO, onPilotTick: capture.onPilotTick });
  return capture.finish(flight, tileContentHashes(flight.defs));
}

async function main(argv: string[]): Promise<number> {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const referenceFile = value('--reference') ?? BASELINE_FILE;

  if (argv.includes('--exact')) {
    const reference = readRecord(referenceFile);
    const candidate = readRecord(path.resolve(value('--exact') ?? ''));
    const diffs = compareExact(reference, candidate);
    console.log(describeExact(reference, candidate, diffs));
    return diffs.length === 0 ? 0 : 1;
  }
  if (argv.includes('--envelope')) {
    const controlsFile = value('--controls');
    if (!controlsFile) throw new Error('--envelope needs --controls <controls.json> (the control flights of the reference code with shifted starts)');
    const reference = readRecord(referenceFile);
    const candidate = readRecord(path.resolve(value('--envelope') ?? ''));
    const controls = parseControls(JSON.parse(fs.readFileSync(path.resolve(controlsFile), 'utf8')));
    const rows = compareEnvelope(reference, candidate, controls);
    console.log(`reference ${reference.label}, flight ${candidate.label}, ${controls.length} controls (${controls.map((c) => c.label).join(', ')})`);
    console.log(describeEnvelope(rows));
    return rows.every((r) => r.pass) ? 0 : 1;
  }
  if (argv.includes('--check')) {
    const reference = readRecord(referenceFile);
    const candidate = await flyRecord('check');
    const diffs = compareExact(reference, candidate);
    console.log(describeExact(reference, candidate, diffs));
    return diffs.length === 0 && candidate.stateHash === reference.stateHash ? 0 : 1;
  }
  if (argv.includes('--out')) {
    const file = path.resolve(value('--out') ?? '');
    const record = await flyRecord(value('--label') ?? path.basename(file, '.json'));
    writeRecord(file, record);
    console.log(`mission record: wrote ${path.relative(repoRoot, file)}: state hash ${record.stateHash}, ${record.steps} steps, ${record.milestones.length} milestones`);
    return 0;
  }
  if (argv.includes('--record-baseline')) {
    const record = await flyRecord('v1');
    writeRecord(BASELINE_FILE, record);
    console.log(`mission baseline: wrote ${path.relative(repoRoot, BASELINE_FILE)}: state hash ${record.stateHash}, ${record.steps} steps, ${record.milestones.length} milestones; splashdown in "${record.final.recoveryZone}"`);
    return 0;
  }
  console.error('usage: record-mission-baseline.ts --exact <record> | --envelope <record> --controls <file> [--reference <record>] | --check | --out <file> [--label <text>] | --record-baseline');
  return 2;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(await main(process.argv.slice(2)));
