/**
 * The trajectory guard of the mission (MIGRATION_V2 principle 4, step 3.2): tests/mission/trajectory-guard.json.
 *
 * Recorded once on the tick-grid tree from the flight `npm run test:mission` flies (`lunar-direct`, the real
 * tiles, the scripted pilot), it holds:
 *
 *  - the ATTENDED craft (the vessel the pilot is seated in) at 400 control ticks of the flight: the tick, its
 *    SOI body, and its body-centred position, velocity, attitude and mass as float64 BIT PATTERNS. The 400
 *    are the control tick at which each of the 17 milestones is first on record and 383 ticks spread evenly
 *    over the flight's control ticks;
 *  - at the same ticks the FIRST vessel the craft shed, as long as it exists: the launch clamps, which the
 *    release welds into one held ground structure that rides the rotating Earth;
 *  - the debris by FATE: every vessel the world removed (impact, burn-up, expiry: time, body, sub-point) and
 *    every other vessel that still exists at the end (body, situation, state).
 *
 * Comparison: the attended craft and the first shed vessel BIT FOR BIT; the debris within 2 s and 500 m (its
 * stepping tier changes by design when the 25 km bubble becomes islands), a survivor on the same orbit or at
 * the same place within 500 m.
 *
 * The file is not re-recorded by a package: `record` below refuses to overwrite it, and
 * tools/dev/guard-pins.test.ts holds its content. Only the lead re-records it, for a decided change of the
 * flight (done once: the tick-pure rule of src/sim/clock.ts). What may be adapted when ids or the
 * snapshot change is how a vessel is FOUND (by role, never by id: "the active vessel", "the first vessel
 * shed"), never the numbers.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/trajectoryGuard.ts            (compare; exit 1 on a difference)
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/trajectoryGuard.ts --record   (first recording only)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';
import { elementsOf } from '../dev/mission-baseline';
import { repoRoot } from './realWorld';

export const GUARD_FILE = path.join(repoRoot, 'tests', 'mission', 'trajectory-guard.json');
export const GUARD_SAMPLES = 400;
/** Tolerances of the debris comparison: seconds and metres. */
export const DEBRIS_TIME_TOLERANCE = 2;
export const DEBRIS_DISTANCE_TOLERANCE = 500;

export interface GuardVessel {
  bodyId: string;
  /** Float64 bit patterns, 16 hex digits each: r (3), v (3), q (x, y, z, w), mass. */
  r: string[];
  v: string[];
  q: string[];
  mass: string;
}

export interface GuardSample {
  /** Ordinal of the control tick (0 = the first tick of the flight) and the universe tick of the state. */
  controlTick: number;
  tick: number;
  /** A milestone id when this is the tick that first sees that milestone, else 'grid'. */
  why: string;
  attended: GuardVessel;
  /** The first vessel the attended craft shed; null before the release and once the world has removed it. */
  firstShed: GuardVessel | null;
}

export interface GuardFate {
  name: string;
  reason: string;
  ut: number;
  bodyId: string;
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface GuardSurvivor {
  name: string;
  bodyId: string;
  situation: string;
  /** State in BCI(bodyId) at the end of the flight, m and m/s. */
  r: [number, number, number];
  v: [number, number, number];
}

export interface TrajectoryGuard {
  description: string;
  scenario: string;
  startTick: number;
  /** The flight the guard was recorded from. */
  flight: { steps: number; railsAdvances: number; controlTicks: number; endTick: number };
  samples: GuardSample[];
  debris: GuardFate[];
  survivors: GuardSurvivor[];
}

const scratch = new DataView(new ArrayBuffer(8));
export function bits(x: number): string {
  scratch.setFloat64(0, x);
  return scratch.getUint32(0).toString(16).padStart(8, '0') + scratch.getUint32(4).toString(16).padStart(8, '0');
}
export function fromBits(hex: string): number {
  scratch.setUint32(0, parseInt(hex.slice(0, 8), 16));
  scratch.setUint32(4, parseInt(hex.slice(8), 16));
  return scratch.getFloat64(0);
}

const vesselOf = (v: VesselSnapshot): GuardVessel => ({
  bodyId: v.bodyId,
  r: [bits(v.r.x), bits(v.r.y), bits(v.r.z)],
  v: [bits(v.v.x), bits(v.v.y), bits(v.v.z)],
  q: [bits(v.q.x), bits(v.q.y), bits(v.q.z), bits(v.q.w)],
  mass: bits(v.mass),
});

/** The 400 control ticks of a flight of `controlTicks` ticks whose milestones were first seen at `milestoneTicks`. */
export function sampleTicks(controlTicks: number, milestoneTicks: readonly number[]): number[] {
  const chosen = new Set<number>(milestoneTicks);
  const grid = GUARD_SAMPLES - chosen.size;
  for (let i = 0; i < grid; i++) {
    let k = Math.round((i * (controlTicks - 1)) / (grid - 1));
    while (chosen.has(k)) k = k + 1 < controlTicks ? k + 1 : 0;
    chosen.add(k);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Observer of a flight: call `onTick` at every control tick. With `ticks` it records the guard's samples at
 * those control ticks; without, it only counts the ticks and notes where each milestone is first seen.
 */
export function guardObserver(ticks: readonly number[] | null): {
  onTick: (s: SimSnapshot) => void;
  controlTicks: () => number;
  milestoneTicks: () => number[];
  samples: () => GuardSample[];
} {
  const wanted = ticks ? new Set(ticks) : null;
  const samples: GuardSample[] = [];
  const milestoneTicks: number[] = [];
  let tick = -1;
  let firstShed: string | null = null;
  return {
    controlTicks: () => tick + 1,
    milestoneTicks: () => milestoneTicks,
    samples: () => samples,
    onTick: (s: SimSnapshot): void => {
      tick++;
      let why = 'grid';
      for (let k = milestoneTicks.length; k < s.milestones.length; k++) {
        milestoneTicks.push(tick);
        why = s.milestones[k]!.id;
      }
      // The first vessel shed: the one beside the active vessel when the snapshot first holds two.
      if (firstShed === null && s.vessels.length > 1) firstShed = s.vessels.find((v) => v.id !== s.activeVesselId)!.id;
      if (!wanted || !wanted.has(tick)) return;
      const attended = s.vessels.find((v) => v.id === s.activeVesselId)!;
      const shed = firstShed === null ? undefined : s.vessels.find((v) => v.id === firstShed);
      samples.push({ controlTick: tick, tick: Math.round(s.simUt * 120), why, attended: vesselOf(attended), firstShed: shed ? vesselOf(shed) : null });
    },
  };
}

export const fatesOf = (debris: readonly { name: string; reason: string; ut: number; bodyId: string; latitudeDeg: number; longitudeDeg: number }[]): GuardFate[] =>
  debris.map((f) => ({ name: f.name, reason: f.reason, ut: f.ut, bodyId: f.bodyId, latitudeDeg: f.latitudeDeg, longitudeDeg: f.longitudeDeg }));

export const survivorsOf = (last: SimSnapshot): GuardSurvivor[] =>
  last.vessels
    .filter((v) => v.id !== last.activeVesselId)
    .map((v) => ({ name: v.name, bodyId: v.bodyId, situation: v.situation, r: [v.r.x, v.r.y, v.r.z] as [number, number, number], v: [v.v.x, v.v.y, v.v.z] as [number, number, number] }));

export function readGuard(file: string = GUARD_FILE): TrajectoryGuard {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TrajectoryGuard;
}

// --------------------------------------------------------------------------------------------- comparison

const FIELDS: (keyof Pick<GuardVessel, 'r' | 'v' | 'q'>)[] = ['r', 'v', 'q'];

function vesselDifference(what: string, recorded: GuardVessel | null, flown: GuardVessel | null): string | null {
  if (recorded === null || flown === null) return recorded === flown ? null : `${what}: ${flown === null ? 'absent' : 'present'}, recorded ${recorded === null ? 'absent' : 'present'}`;
  if (recorded.bodyId !== flown.bodyId) return `${what}: about ${flown.bodyId}, recorded about ${recorded.bodyId}`;
  for (const f of FIELDS) {
    for (let c = 0; c < recorded[f].length; c++) {
      if (recorded[f][c] !== flown[f][c]) {
        const a = fromBits(recorded[f][c]!);
        const b = fromBits(flown[f][c]!);
        return `${what}: ${f}[${c}] = ${b} (${flown[f][c]}), recorded ${a} (${recorded[f][c]}); difference ${b - a}`;
      }
    }
  }
  if (recorded.mass !== flown.mass) return `${what}: mass ${fromBits(flown.mass)}, recorded ${fromBits(recorded.mass)}`;
  return null;
}

/** BIT-EXACT part: the first difference of the samples of a flight from the guard's, in words (null = equal). */
export function sampleDifference(guard: TrajectoryGuard, samples: readonly GuardSample[]): string | null {
  if (samples.length !== guard.samples.length) return `${samples.length} samples, the guard has ${guard.samples.length}`;
  for (let i = 0; i < guard.samples.length; i++) {
    const a = guard.samples[i]!;
    const b = samples[i]!;
    const where = `sample ${i} (control tick ${a.controlTick}, ${a.why})`;
    if (a.controlTick !== b.controlTick) return `${where}: taken at control tick ${b.controlTick}`;
    if (a.tick !== b.tick) return `${where}: at tick ${b.tick}, recorded at tick ${a.tick} (${((b.tick - a.tick) / 120).toFixed(4)} s)`;
    if (a.why !== b.why) return `${where}: is ${b.why} in this flight`;
    const d = vesselDifference(`${where}, attended craft`, a.attended, b.attended) ?? vesselDifference(`${where}, first shed vessel`, a.firstShed, b.firstShed);
    if (d) return d;
  }
  return null;
}

export interface DebrisDifference {
  name: string;
  /** Seconds and metres from the recorded fate, or the reason the two cannot be compared. */
  dTime: number;
  distance: number;
  problem: string | null;
}

const surfaceDistance = (latA: number, lonA: number, latB: number, lonB: number, radius: number): number => {
  // Through the chord: exact for coincident points (the arc cosine of a dot product is not).
  const rad = Math.PI / 180;
  const dir = (lat: number, lon: number): Vec3 => ({ x: Math.cos(lat * rad) * Math.cos(lon * rad), y: Math.cos(lat * rad) * Math.sin(lon * rad), z: Math.sin(lat * rad) });
  const a = dir(latA, lonA);
  const b = dir(latB, lonB);
  const chord = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return 2 * Math.asin(Math.min(1, chord / 2)) * radius;
};

/** Pair the entries of two lists by name, the k-th of a name with the k-th of the same name. */
function pairByName<T extends { name: string }>(recorded: readonly T[], flown: readonly T[]): { a: T; b: T | undefined }[] {
  const seen = new Map<string, number>();
  return recorded.map((a) => {
    const k = seen.get(a.name) ?? 0;
    seen.set(a.name, k + 1);
    return { a, b: flown.filter((x) => x.name === a.name)[k] };
  });
}

/**
 * TOLERANCE part: every recorded fate and survivor against the flight's. A removed vessel: the same reason
 * on the same body within DEBRIS_TIME_TOLERANCE and DEBRIS_DISTANCE_TOLERANCE of the recorded sub-point. A
 * survivor: on the surface within the distance tolerance of the recorded place; in flight on the same orbit
 * (semi-major axis and periapsis radius within the distance tolerance, plane within 1e-4 rad).
 */
export function debrisDifferences(guard: TrajectoryGuard, fates: readonly GuardFate[], survivors: readonly GuardSurvivor[], body: (id: string) => { mu: number; radius: number }): DebrisDifference[] {
  const out: DebrisDifference[] = [];
  if (fates.length !== guard.debris.length) out.push({ name: '(fates)', dTime: NaN, distance: NaN, problem: `${fates.length} vessels were removed, the guard has ${guard.debris.length}` });
  if (survivors.length !== guard.survivors.length) out.push({ name: '(survivors)', dTime: NaN, distance: NaN, problem: `${survivors.length} vessels remain, the guard has ${guard.survivors.length}` });
  for (const { a, b } of pairByName(guard.debris, fates)) {
    if (!b) {
      out.push({ name: a.name, dTime: NaN, distance: NaN, problem: 'no such fate in this flight' });
      continue;
    }
    const dTime = b.ut - a.ut;
    const distance = a.bodyId === b.bodyId ? surfaceDistance(a.latitudeDeg, a.longitudeDeg, b.latitudeDeg, b.longitudeDeg, body(a.bodyId).radius) : NaN;
    let problem: string | null = null;
    if (a.bodyId !== b.bodyId) problem = `on ${b.bodyId}, recorded on ${a.bodyId}`;
    else if (a.reason !== b.reason) problem = `${b.reason}, recorded ${a.reason}`;
    else if (!(Math.abs(dTime) <= DEBRIS_TIME_TOLERANCE)) problem = `${dTime.toFixed(3)} s from the recorded time`;
    else if (!(distance <= DEBRIS_DISTANCE_TOLERANCE)) problem = `${distance.toFixed(1)} m from the recorded place`;
    out.push({ name: a.name, dTime, distance, problem });
  }
  for (const { a, b } of pairByName(guard.survivors, survivors)) {
    if (!b) {
      out.push({ name: a.name, dTime: 0, distance: NaN, problem: 'does not exist at the end of this flight' });
      continue;
    }
    const ra: Vec3 = { x: a.r[0], y: a.r[1], z: a.r[2] };
    const rb: Vec3 = { x: b.r[0], y: b.r[1], z: b.r[2] };
    const apart = Math.hypot(ra.x - rb.x, ra.y - rb.y, ra.z - rb.z);
    let problem: string | null = null;
    let distance = apart;
    if (a.bodyId !== b.bodyId) problem = `about ${b.bodyId}, recorded about ${a.bodyId}`;
    else if (a.situation !== b.situation) problem = `${b.situation}, recorded ${a.situation}`;
    else if (a.situation === 'landed' || a.situation === 'splashed' || a.situation === 'prelaunch') {
      if (!(apart <= DEBRIS_DISTANCE_TOLERANCE)) problem = `${apart.toFixed(1)} m from the recorded place`;
    } else {
      const mu = body(a.bodyId).mu;
      const ea = elementsOf(mu, ra, { x: a.v[0], y: a.v[1], z: a.v[2] });
      const eb = elementsOf(mu, rb, { x: b.v[0], y: b.v[1], z: b.v[2] });
      const dA = Math.abs(ea.a - eb.a);
      const dPe = Math.abs(ea.a * (1 - ea.e) - eb.a * (1 - eb.e));
      const cosPlane = Math.sin(ea.i) * Math.sin(eb.i) * Math.cos(ea.lan - eb.lan) + Math.cos(ea.i) * Math.cos(eb.i);
      const plane = Math.acos(Math.max(-1, Math.min(1, cosPlane)));
      distance = Math.max(dA, dPe);
      if (!(dA <= DEBRIS_DISTANCE_TOLERANCE) || !(dPe <= DEBRIS_DISTANCE_TOLERANCE)) problem = `another orbit: semi-major axis ${dA.toFixed(1)} m, periapsis ${dPe.toFixed(1)} m from the recorded one`;
      else if (!(plane <= 1e-4)) problem = `another orbit plane: ${plane.toExponential(2)} rad from the recorded one`;
    }
    out.push({ name: a.name, dTime: 0, distance, problem });
  }
  return out;
}

/** Attitude helper for readers of the file: the quaternion of a recorded vessel. */
export const attitudeOf = (v: GuardVessel): Quat => ({ x: fromBits(v.q[0]!), y: fromBits(v.q[1]!), z: fromBits(v.q[2]!), w: fromBits(v.q[3]!) });

// ---------------------------------------------------------------------------------------------------- main

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).split(path.sep).join('/').endsWith('tools/sim/trajectoryGuard.ts');
if (invokedDirectly) {
  const { fly } = await import('../../tests/mission/harness');
  const SCENARIO = 'lunar-direct';
  if (process.argv.includes('--record')) {
    if (fs.existsSync(GUARD_FILE)) {
      console.error(`${path.relative(repoRoot, GUARD_FILE)} exists: the trajectory guard is recorded once and never again.`);
      process.exit(1);
    }
    // First flight: how many control ticks there are and where the milestones are first seen.
    const count = guardObserver(null);
    const first = await fly({ scenario: SCENARIO, onPilotTick: (s) => count.onTick(s) });
    if (first.run.failure) throw new Error(`the flight failed: ${first.run.failure}`);
    const ticks = sampleTicks(count.controlTicks(), count.milestoneTicks());
    // Second flight: the samples. A third: they must be reproduced bit for bit before they are written.
    const record = async (): Promise<{ guard: TrajectoryGuard; hash: string }> => {
      const obs = guardObserver(ticks);
      const f = await fly({ scenario: SCENARIO, onPilotTick: (s) => obs.onTick(s) });
      if (f.run.failure || f.run.last.cheatCounter !== 0 || f.run.last.terrain.incompleteQueries !== 0) throw new Error('the flight is not a clean mission');
      if (obs.controlTicks() !== count.controlTicks()) throw new Error('the flights differ in their control ticks');
      return {
        hash: f.hash,
        guard: {
          description:
            'Trajectory guard of lunar-direct (MIGRATION_V2 principle 4): the attended craft and the first vessel it shed (the launch clamps) at 400 control ticks as float64 bit patterns, compared bit for bit; the debris by fate, compared within 2 s and 500 m. Recorded once on the tick-grid tree; never re-recorded (tools/sim/trajectoryGuard.ts).',
          scenario: SCENARIO,
          startTick: Math.round(f.scenario.startUt * 120),
          flight: { steps: f.run.stats.steps, railsAdvances: f.run.stats.railsAdvances, controlTicks: f.run.stats.ticks, endTick: Math.round(f.run.finalUt * 120) },
          samples: obs.samples(),
          debris: fatesOf(f.debris),
          survivors: survivorsOf(f.run.last),
        },
      };
    };
    const a = await record();
    const b = await record();
    const text = `${JSON.stringify(a.guard, null, 1)}\n`;
    if (text !== `${JSON.stringify(b.guard, null, 1)}\n`) throw new Error('two flights gave different guards: not recorded');
    fs.writeFileSync(GUARD_FILE, text);
    const g = a.guard;
    console.log(`trajectory guard: wrote ${path.relative(repoRoot, GUARD_FILE)} (${(text.length / 1024).toFixed(0)} kB): ${g.samples.length} samples (${g.samples.filter((s) => s.why !== 'grid').length} at milestones, ${g.samples.filter((s) => s.firstShed !== null).length} with the first shed vessel), ${g.debris.length} fates, ${g.survivors.length} survivors; the flight: ${g.flight.steps} steps, ${g.flight.controlTicks} control ticks, state hash ${a.hash} (both flights: ${a.hash === b.hash})`);
    for (const f of g.debris) console.log(`  fate: ${f.name}: ${f.reason} on ${f.bodyId} at ${f.latitudeDeg.toFixed(3)}, ${f.longitudeDeg.toFixed(3)}, T+${(f.ut - g.startTick / 120).toFixed(1)} s`);
    for (const s of g.survivors) console.log(`  survivor: ${s.name}: ${s.situation} about ${s.bodyId}`);
  } else {
    const guard = readGuard();
    const obs = guardObserver(guard.samples.map((s) => s.controlTick));
    const f = await fly({ scenario: SCENARIO, onPilotTick: (s) => obs.onTick(s) });
    const diff = sampleDifference(guard, obs.samples());
    const debris = debrisDifferences(guard, fatesOf(f.debris), survivorsOf(f.run.last), (id) => f.defs.bodies[id]!);
    const bad = debris.filter((d) => d.problem !== null);
    console.log(diff === null ? `trajectory guard: all ${guard.samples.length} samples bit-identical (attended craft and first shed vessel)` : `trajectory guard: DIFFERENT. ${diff}`);
    console.log(
      bad.length === 0
        ? `debris: all ${debris.length} fates and survivors within ${DEBRIS_TIME_TOLERANCE} s and ${DEBRIS_DISTANCE_TOLERANCE} m (worst ${Math.max(...debris.map((d) => Math.abs(d.dTime))).toFixed(3)} s, ${Math.max(...debris.map((d) => d.distance)).toFixed(3)} m)`
        : `debris: ${bad.length} of ${debris.length} outside: ${bad.map((d) => `${d.name}: ${d.problem}`).join('; ')}`,
    );
    process.exit(diff === null && bad.length === 0 ? 0 : 1);
  }
}
