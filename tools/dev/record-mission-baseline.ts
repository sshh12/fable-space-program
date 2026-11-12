/**
 * Records tests/mission/baseline-v1.json: the milestone states of the headless `lunar-direct` mission on the
 * v1 clock, which the tick-grid step (MIGRATION_V2 step 3.1) is compared against BY TOLERANCE
 * (MIGRATION_V2 principle 3): orbit elements at each milestone to 1e-6 relative, the touchdown point within
 * 50 m, the splashdown inside the same recovery zone, event times within 1 s.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts            (writes the file)
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --check    (flies again, compares)
 *
 * The flight is the one `npm run test:mission` flies (tests/mission/harness.ts `fly()`: the real session on
 * the real baked tiles, the scripted pilot, the terrain await protocol). At the first control tick at which a
 * milestone is on record, the recorder notes the active vessel's state from `peek()`: its SOI body, position
 * and velocity in BCI, the classical elements derived from them, and the readouts a comparison needs. The
 * elements of a coasting milestone do not depend on that tick; for a milestone under thrust (lift-off, max-q,
 * the stage events, the deploys) they are the state `captureUt - ut` seconds after the event, so compare those
 * through `ut`, `altitudeAsl` and the milestone's own `data`.
 *
 * Re-recording is the lead's act. Step 3.1 never rewrites this file: it reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimSnapshot } from '../../src/core/contracts/sim';
import type { Vec3 } from '../../src/core/math/vec3';
import { fly, tileContentHashes } from '../../tests/mission/harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(repoRoot, 'tests', 'mission', 'baseline-v1.json');
const SCENARIO = 'lunar-direct';

interface Elements {
  /** Semi-major axis, m (negative on a hyperbola). */
  a: number;
  e: number;
  /** Inclination, longitude of the ascending node, argument of periapsis and true anomaly, rad, in BCI axes. */
  i: number;
  lan: number;
  argPe: number;
  nu: number;
  /** Specific orbital energy, J/kg, and specific angular momentum, m^2/s. */
  energy: number;
  h: number;
}

export interface MilestoneState {
  id: string;
  /** Time the milestone was recorded at by the simulation, and the time of the snapshot the state is from. */
  ut: number;
  captureUt: number;
  /** Mission elapsed time at the capture, s. */
  met: number;
  vesselId: string;
  bodyId: string;
  situation: string;
  /** State in BCI(bodyId), m and m/s. */
  r: [number, number, number];
  v: [number, number, number];
  elements: Elements;
  apoapsisAltitude: number;
  periapsisAltitude: number;
  /** Sub-point (rad) and altitude above the reference radius, m. */
  latitude: number;
  longitude: number;
  altitudeAsl: number;
  speedOrbital: number;
  speedSurface: number;
  mass: number;
  /** The milestone's own captured facts (MilestoneRecord.data). */
  data: Record<string, number>;
}

export interface MissionBaseline {
  scenario: string;
  /** What 3.1 compares with, and how (MIGRATION_V2 principle 3). */
  tolerances: { elementsRelative: number; touchdownMetres: number; eventSeconds: number; splashdown: string };
  stateHash: string;
  steps: number;
  railsAdvances: number;
  controlTicks: number;
  simSeconds: number;
  startUt: number;
  tiles: Record<string, string>;
  node: string;
  milestones: MilestoneState[];
  /** Where the flight ended (the splashed capsule). */
  final: { ut: number; vesselId: string; bodyId: string; situation: string; latitude: number; longitude: number; recoveryZone: string | null };
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: Vec3): number => Math.sqrt(dot(a, a));
const wrap = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Classical elements of the state (r, v) about a body of gravitational parameter mu, BCI axes. */
export function elementsOf(mu: number, r: Vec3, v: Vec3): Elements {
  const rm = len(r);
  const hv = cross(r, v);
  const h = len(hv);
  const energy = dot(v, v) / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const rv = dot(r, v);
  const k = dot(v, v) - mu / rm;
  const ev: Vec3 = { x: (k * r.x - rv * v.x) / mu, y: (k * r.y - rv * v.y) / mu, z: (k * r.z - rv * v.z) / mu };
  const e = len(ev);
  const i = Math.acos(Math.max(-1, Math.min(1, hv.z / h)));
  const n: Vec3 = { x: -hv.y, y: hv.x, z: 0 };
  const nm = len(n);
  const lan = nm > 1e-12 * h ? wrap(Math.atan2(n.y, n.x)) : 0;
  // Angles measured in the orbit plane from the node line (or from +X for an equatorial orbit).
  const nodeDir: Vec3 = nm > 1e-12 * h ? { x: n.x / nm, y: n.y / nm, z: 0 } : { x: 1, y: 0, z: 0 };
  const inPlane = cross({ x: hv.x / h, y: hv.y / h, z: hv.z / h }, nodeDir);
  const angle = (d: Vec3): number => wrap(Math.atan2(dot(d, inPlane), dot(d, nodeDir)));
  const argPe = e > 1e-12 ? angle(ev) : 0;
  const nu = wrap(angle(r) - argPe);
  return { a, e, i, lan, argPe, nu, energy, h };
}

type PendingState = Omit<MilestoneState, 'elements'>;

function stateOf(s: SimSnapshot, id: string, ut: number, data: Record<string, number>): PendingState {
  const vessel = s.vessels.find((x) => x.id === s.activeVesselId);
  if (!vessel) throw new Error(`milestone ${id}: no active vessel in the snapshot`);
  const rd = s.readouts;
  return {
    id,
    ut,
    captureUt: s.simUt,
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
    data,
  };
}

async function record(): Promise<MissionBaseline> {
  const pending: PendingState[] = [];
  const flight = await fly({
    scenario: SCENARIO,
    onPilotTick: (s) => {
      for (let k = pending.length; k < s.milestones.length; k++) {
        const m = s.milestones[k]!;
        pending.push(stateOf(s, m.id, m.ut, m.data));
      }
    },
  });
  // The elements need the gravitational parameter of each state's body, from the library the flight loaded.
  const states: MilestoneState[] = pending.map((st) => {
    const body = flight.defs.bodies[st.bodyId];
    if (!body) throw new Error(`unknown body ${st.bodyId}`);
    return { ...st, elements: elementsOf(body.mu, { x: st.r[0], y: st.r[1], z: st.r[2] }, { x: st.v[0], y: st.v[1], z: st.v[2] }) };
  });
  if (flight.run.failure) throw new Error(`the baseline flight failed: ${flight.run.failure}`);
  if (states.length !== flight.milestones.length) throw new Error(`recorded ${states.length} milestone states for ${flight.milestones.length} milestones`);
  const last = flight.run.last;
  if (last.cheatCounter !== 0) throw new Error('the baseline flight used a debug mutator');
  if (last.terrain.incompleteQueries !== 0) throw new Error(`the baseline flight had ${last.terrain.incompleteQueries} incomplete terrain queries`);
  const active = last.vessels.find((x) => x.id === last.activeVesselId)!;
  const splash = flight.milestones[flight.milestones.length - 1]!;
  const zone = last.surfaceTargets.filter((t) => t.kind === 'recovery').find((t) => Math.abs(t.radius - (splash.data['recoveryZoneRadius'] ?? Number.NaN)) < 1);
  return {
    scenario: SCENARIO,
    tolerances: { elementsRelative: 1e-6, touchdownMetres: 50, eventSeconds: 1, splashdown: 'inside the same recovery zone' },
    stateHash: flight.hash,
    steps: flight.run.stats.steps,
    railsAdvances: flight.run.stats.railsAdvances,
    controlTicks: flight.run.stats.ticks,
    simSeconds: flight.run.simTime,
    startUt: flight.scenario.startUt,
    tiles: tileContentHashes(flight.defs),
    node: process.version,
    milestones: states,
    final: {
      ut: last.simUt,
      vesselId: active.id,
      bodyId: active.bodyId,
      situation: active.situation,
      latitude: last.readouts.latitude,
      longitude: last.readouts.longitude,
      recoveryZone: zone?.name ?? null,
    },
  };
}

const check = process.argv.includes('--check');
const baseline = await record();
const text = `${JSON.stringify(baseline, null, 1)}\n`;
if (check) {
  const stored = fs.readFileSync(FILE, 'utf8');
  if (stored !== text) {
    console.error('mission baseline: the flight differs from tests/mission/baseline-v1.json');
    process.exit(1);
  }
  console.log(`mission baseline: identical to ${path.relative(repoRoot, FILE)} (state hash ${baseline.stateHash}, ${baseline.steps} steps)`);
} else {
  fs.writeFileSync(FILE, text);
  console.log(`mission baseline: wrote ${path.relative(repoRoot, FILE)}: state hash ${baseline.stateHash}, ${baseline.steps} steps, ${baseline.milestones.length} milestones (${baseline.milestones.map((m) => m.id).join(', ')}); splashdown in "${baseline.final.recoveryZone}"`);
}
