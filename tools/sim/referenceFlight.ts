/**
 * The same-start reference of the tick-grid step (MIGRATION_V2 step 3.1; lead decision in
 * docs/requests/sim-core-v2-1.md): the ascent of `lunar-direct` as the v1 clock flew it from the
 * tick-aligned start, kept in tests/mission/reference-v1-aligned.json, and the comparison of a flight with it.
 *
 * Why a second reference beside tests/mission/baseline-v1.json: the scripted pilot decides at 30 Hz control
 * ticks, so a flight whose start is not bit-identical to the baseline's parts from it after the first
 * decision (measured: the v1 code itself, with its start moved by 2 ms, differs from the baseline by 5e-5 in
 * the elements at the first staging and by tens of seconds at the later events). At the SAME start the two
 * clocks fly the same ascent: every event of the ascent at the same time and the same orbit elements. That
 * is what this reference pins down, up to and including the milestone EARTH_ORBIT; after it the rails
 * landings of the two clocks differ (v1 landed on arbitrary float instants) and so do the pilot's ticks.
 *
 * The reference holds, for every milestone up to `lastMilestone` and for the first control tick at or after
 * every SAMPLE_SECONDS of mission elapsed time until then: the time, the SOI body, the state vector of the
 * active vessel in BCI, its classical elements, altitude and mass.
 *
 * The file was recorded once, from the v1 `src/sim/world/sim.ts` (commit 6f012fe) while that code could
 * still be run; it cannot be recorded again and is never rewritten.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/referenceFlight.ts
 *
 * flies the tree's mission and prints the table of differences from the reference (the mission test
 * tests/mission/full-mission.test.ts asserts the same comparison on its own flight).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { Vec3 } from '@/core/math/vec3';
import { elementsOf, type Elements } from '../dev/mission-baseline';
import { repoRoot } from './realWorld';

export const REFERENCE_FILE = path.join(repoRoot, 'tests', 'mission', 'reference-v1-aligned.json');
/** Mission elapsed time between two samples of the ascent, s. */
export const SAMPLE_SECONDS = 30;

export interface ReferenceState {
  /** Milestone id, or `T+<seconds>` for a sample. */
  id: string;
  kind: 'milestone' | 'sample';
  /** Time of the milestone record (a sample: the time of its control tick), and the time of the snapshot the state is from. */
  ut: number;
  captureUt: number;
  /** Ordinal of the control tick the state was taken at (0 = the first tick of the flight). */
  controlTick: number;
  met: number;
  bodyId: string;
  /** State of the active vessel in BCI(bodyId), m and m/s. */
  r: [number, number, number];
  v: [number, number, number];
  elements: Elements;
  altitudeAsl: number;
  mass: number;
}

export interface ReferenceFlight {
  description: string;
  source: string;
  scenario: string;
  startUt: number;
  lastMilestone: string;
  sampleSeconds: number;
  /** The whole reference flight, for the record: where the v1 clock ended from this start. */
  flight: { stateHash: string; steps: number; railsAdvances: number; controlTicks: number; simSeconds: number };
  states: ReferenceState[];
}

type Pending = Omit<ReferenceState, 'elements'>;

/** Observer of a flight: call `onTick` at every control tick; `states(mu)` is what was recorded up to `lastMilestone`. */
export function referenceRecorder(lastMilestone: string): { onTick: (s: SimSnapshot) => void; states: (mu: (bodyId: string) => number) => ReferenceState[]; complete: () => boolean } {
  const pending: Pending[] = [];
  let milestones = 0;
  let tick = -1;
  let nextSample = 1;
  let done = false;
  const take = (s: SimSnapshot, id: string, kind: ReferenceState['kind'], ut: number): Pending => {
    const vessel = s.vessels.find((x) => x.id === s.activeVesselId)!;
    return {
      id,
      kind,
      ut,
      captureUt: s.simUt,
      controlTick: tick,
      met: s.readouts.met,
      bodyId: vessel.bodyId,
      r: [vessel.r.x, vessel.r.y, vessel.r.z],
      v: [vessel.v.x, vessel.v.y, vessel.v.z],
      altitudeAsl: s.readouts.altitudeAsl,
      mass: vessel.mass,
    };
  };
  return {
    complete: () => done,
    onTick: (s: SimSnapshot): void => {
      tick++;
      if (done) return;
      while (s.readouts.met >= nextSample * SAMPLE_SECONDS) {
        pending.push(take(s, `T+${nextSample * SAMPLE_SECONDS}`, 'sample', s.simUt));
        nextSample++;
      }
      for (; milestones < s.milestones.length && !done; milestones++) {
        const m = s.milestones[milestones]!;
        pending.push(take(s, m.id, 'milestone', m.ut));
        if (m.id === lastMilestone) done = true;
      }
    },
    states: (mu) => pending.map((p) => ({ ...p, elements: elementsOf(mu(p.bodyId), { x: p.r[0], y: p.r[1], z: p.r[2] }, { x: p.v[0], y: p.v[1], z: p.v[2] }) })),
  };
}

export function readReference(file: string = REFERENCE_FILE): ReferenceFlight {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ReferenceFlight;
}

export interface ReferenceDifference {
  id: string;
  kind: ReferenceState['kind'];
  /** Same SOI body and the same control tick of the flight. */
  sameBody: boolean;
  sameControlTick: boolean;
  /** Time of the record and of the capture minus the reference's, s. */
  dUt: number;
  dCaptureUt: number;
  /** Relative differences of a, energy, h and mass; e absolute; i, lan and argPe as wrapped absolute differences, rad. */
  da: number;
  de: number;
  di: number;
  dlan: number;
  dargPe: number;
  dEnergy: number;
  dh: number;
  dMass: number;
  dAltitude: number;
  /**
   * Distance between the two positions in BCI at the same control tick, that is at equal mission time, m. (A
   * flight whose lift-off is dt later in absolute time flies the same path over the ground, turned with the
   * Earth by its spin rate times dt.)
   */
  dPosition: number;
  /** Difference of the velocities, m/s. */
  dVelocity: number;
}

const wrapPi = (x: number): number => {
  const t = ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t > Math.PI ? t - 2 * Math.PI : t;
};
const vec = (a: [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });

/** Differences of a flight's recorded states from the reference's, state by state (throws when the sequences differ). */
export function compareToReference(reference: ReferenceFlight, states: readonly ReferenceState[]): ReferenceDifference[] {
  if (states.length !== reference.states.length) throw new Error(`the flight recorded ${states.length} states, the reference has ${reference.states.length}`);
  return reference.states.map((b, k) => {
    const c = states[k]!;
    if (c.id !== b.id) throw new Error(`state ${k}: the flight recorded ${c.id}, the reference has ${b.id}`);
    const rel = (x: number, y: number): number => (x === y ? 0 : Math.abs(x - y) / Math.abs(y));
    const dt = c.captureUt - b.captureUt;
    const rb = vec(b.r);
    const vb = vec(b.v);
    const rc = vec(c.r);
    const vc = vec(c.v);
    return {
      id: b.id,
      kind: b.kind,
      sameBody: c.bodyId === b.bodyId,
      sameControlTick: c.controlTick === b.controlTick,
      dUt: c.ut - b.ut,
      dCaptureUt: dt,
      da: rel(c.elements.a, b.elements.a),
      de: Math.abs(c.elements.e - b.elements.e),
      di: Math.abs(c.elements.i - b.elements.i),
      dlan: Math.abs(wrapPi(c.elements.lan - b.elements.lan)),
      dargPe: Math.abs(wrapPi(c.elements.argPe - b.elements.argPe)),
      dEnergy: rel(c.elements.energy, b.elements.energy),
      dh: rel(c.elements.h, b.elements.h),
      dMass: rel(c.mass, b.mass),
      dAltitude: c.altitudeAsl - b.altitudeAsl,
      dPosition: Math.hypot(rc.x - rb.x, rc.y - rb.y, rc.z - rb.z),
      dVelocity: Math.hypot(vc.x - vb.x, vc.y - vb.y, vc.z - vb.z),
    };
  });
}

const exp = (x: number): string => (x === 0 ? '0' : x.toExponential(1));

export function referenceTable(rows: readonly ReferenceDifference[]): string {
  const head = '| State | dt record, s | dt capture, s | da/a | de | di, rad | dLAN, rad | dargPe, rad | dE/E | dh/h | dm/m | d altitude, m | d position, m | d velocity, m/s |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  return [
    head,
    sep,
    ...rows.map(
      (r) =>
        `| ${r.id}${r.sameBody && r.sameControlTick ? '' : ' (OTHER TICK OR BODY)'} | ${exp(r.dUt)} | ${exp(r.dCaptureUt)} | ${exp(r.da)} | ${exp(r.de)} | ${exp(r.di)} | ${exp(r.dlan)} | ${exp(r.dargPe)} | ${exp(r.dEnergy)} | ${exp(r.dh)} | ${exp(r.dMass)} | ${exp(r.dAltitude)} | ${exp(r.dPosition)} | ${exp(r.dVelocity)} |`,
    ),
  ].join('\n');
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).split(path.sep).join('/').endsWith('tools/sim/referenceFlight.ts');
if (invokedDirectly) {
  const { fly } = await import('../../tests/mission/harness');
  const reference = readReference();
  const rec = referenceRecorder(reference.lastMilestone);
  const flight = await fly({ scenario: reference.scenario, untilMilestone: reference.lastMilestone, onPilotTick: (s) => rec.onTick(s) });
  // The run stops at the control tick that first sees the last milestone, before its observers are called.
  if (!rec.complete()) rec.onTick(flight.run.last);
  if (flight.scenario.startUt !== reference.startUt) throw new Error(`the scenario starts at ${flight.scenario.startUt}, the reference at ${reference.startUt}`);
  const rows = compareToReference(reference, rec.states((id) => flight.defs.bodies[id]!.mu));
  console.log(referenceTable(rows));
  const worst = (f: (r: ReferenceDifference) => number): string => Math.max(...rows.map((r) => Math.abs(f(r)))).toExponential(2);
  console.log(
    `
worst over ${rows.length} states: record time ${worst((r) => r.dUt)} s, capture time ${worst((r) => r.dCaptureUt)} s, da/a ${worst((r) => r.da)}, de ${worst((r) => r.de)}, di ${worst((r) => r.di)} rad, dLAN ${worst((r) => r.dlan)} rad, ` +
      `dargPe ${worst((r) => r.dargPe)} rad, dE/E ${worst((r) => r.dEnergy)}, dh/h ${worst((r) => r.dh)}, dm/m ${worst((r) => r.dMass)}, altitude ${worst((r) => r.dAltitude)} m, position ${worst((r) => r.dPosition)} m, velocity ${worst((r) => r.dVelocity)} m/s; ` +
      `same control tick and body at every state: ${rows.every((r) => r.sameBody && r.sameControlTick)}`,
  );
}
