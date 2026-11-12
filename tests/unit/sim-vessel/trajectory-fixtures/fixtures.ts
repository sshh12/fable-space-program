/**
 * The six trajectory fixtures of the trajectory guard (MIGRATION_V2 principle 4, step 3.2): scripted flights
 * of the vessel dynamics (`stepVessel` on analytic environments, no world, no pilot) through the regimes
 * the refactor must not disturb: ascent from the pad with the clamp release, staging, entry, touchdown on
 * legs, splashdown under parachutes, lunar ascent. Each run records every vessel of the flight (the
 * continuing one first, then the ones it sheds, in the order they appear) at fixed steps: position,
 * velocity, attitude, body rate and mass as float64 BIT PATTERNS, and every event type with its step.
 *
 * The recordings in this directory (`<name>.json`) were made once on the tick-grid tree
 * (tests/unit/sim-vessel/trajectory-fixtures/record.ts) and are compared bit for bit by
 * trajectory-fixtures.test.ts. They are never re-recorded: a change that moves one of these numbers has
 * changed the physics. When the vessel model changes, only the DRIVERS below may be adapted (how a stage is
 * pressed, how a vessel is assembled), never the numbers.
 *
 * The drivers touch a vessel only through what every model keeps: `assembleVessel`, `fireNextStage`,
 * `stepVessel`, the SAS setters, and the pose fields `r`, `v`, `q`, `w`.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, fireNextStage, setRcsEnabled, setSasEnabled, setSasHoldDirection, setSasMode, stepVessel, type Vessel } from '@/sim/vessel';
import { controls, DT, earthAir, makeEnv, MOON_MU, MOON_RADIUS, placeUpright, STANDARD_DENSITY, VEHICLE, type FakeEnv } from '../helpers';
import { drain, stageScenario } from '../scenarios';

export const FIXTURE_NAMES = ['ascent', 'staging', 'entry', 'touchdown', 'splashdown', 'lunar-ascent'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface VesselSample {
  /** Float64 bit patterns, 16 hex digits each: r (3), v (3), q (x, y, z, w), w (3), mass. */
  r: string[];
  v: string[];
  q: string[];
  w: string[];
  mass: string;
  parts: number;
  hold: string | null;
  destroyed: boolean;
}

export interface FixtureRun {
  label: string;
  steps: number;
  samples: { step: number; vessels: VesselSample[] }[];
  /** `<step>:<event type>` in the order the steps reported them. */
  events: string[];
}

export interface FixtureRecording {
  name: FixtureName;
  description: string;
  dt: number;
  runs: FixtureRun[];
}

const scratch = new DataView(new ArrayBuffer(8));
/** The bit pattern of a float64 (sign of zero and every NaN payload kept). */
export function bits(x: number): string {
  scratch.setFloat64(0, x);
  return scratch.getUint32(0).toString(16).padStart(8, '0') + scratch.getUint32(4).toString(16).padStart(8, '0');
}
export function fromBits(hex: string): number {
  scratch.setUint32(0, parseInt(hex.slice(0, 8), 16));
  scratch.setUint32(4, parseInt(hex.slice(8), 16));
  return scratch.getFloat64(0);
}

const sampleOf = (v: Vessel): VesselSample => ({
  r: [bits(v.r.x), bits(v.r.y), bits(v.r.z)],
  v: [bits(v.v.x), bits(v.v.y), bits(v.v.z)],
  q: [bits(v.q.x), bits(v.q.y), bits(v.q.z), bits(v.q.w)],
  w: [bits(v.w.x), bits(v.w.y), bits(v.w.z)],
  mass: bits(v.mp.mass),
  parts: v.parts.length,
  hold: v.hold,
  destroyed: v.destroyed,
});

interface Flight {
  env: FakeEnv;
  /** vessels[0] is the continuing vessel; the ones it sheds are appended as they appear. */
  vessels: Vessel[];
  events: string[];
  step: number;
}

/** Press the next stage of the continuing vessel. */
function press(f: Flight): void {
  const res = fireNextStage(f.vessels[0]!, f.env);
  if (!res.ok) throw new Error(`stage press refused at step ${f.step}: ${res.reason ?? ''}`);
  for (const e of res.events) f.events.push(`${f.step}:${e.type}`);
  f.vessels.push(...res.spawned);
}

/**
 * Step every vessel of the flight `steps` times (the first with the controls of `pilot`, the others
 * neutral), sampling every `every` steps and after the last one. `pilot` is called before each step.
 */
function fly(f: Flight, steps: number, every: number, samples: FixtureRun['samples'], pilot: (step: number) => ControlInputs): void {
  const neutral = controls();
  for (let i = 0; i < steps; i++) {
    const c = pilot(f.step);
    // Vessels a step sheds are in the state of the step START, so they take the same step too.
    for (let k = 0; k < f.vessels.length; k++) {
      const v = f.vessels[k]!;
      if (v.destroyed) continue;
      const res = stepVessel(v, f.env, k === 0 ? c : neutral, DT);
      for (const e of res.events) f.events.push(`${f.step}:${e.type}`);
      f.vessels.push(...res.spawned);
    }
    f.env.advance(DT);
    f.step++;
    if (f.step % every === 0 || i === steps - 1) samples.push({ step: f.step, vessels: f.vessels.map(sampleOf) });
  }
}

const start = (env: FakeEnv, vessels: Vessel[]): { f: Flight; samples: FixtureRun['samples'] } => {
  const f: Flight = { env, vessels, events: [], step: 0 };
  return { f, samples: [{ step: 0, vessels: vessels.map(sampleOf) }] };
};
const finish = (label: string, f: Flight, samples: FixtureRun['samples']): FixtureRun => ({ label, steps: f.step, samples, events: f.events });

/** Spin rates of the Earth and of the Moon, rad/s. */
const EARTH_SPIN = 7.2921159e-5;
const MOON_SPIN = 2.6617e-6;

// ------------------------------------------------------------------------------------------------ ascent

/** From the pad of a rotating Earth: ignition, the clamp release three seconds later, 130 s of the pitch programme through max-q. */
function ascent(defs: DefLibrary): FixtureRun[] {
  const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, spinRate: EARTH_SPIN });
  const v = assembleVessel(defs, VEHICLE);
  placeUpright(v, env, 120);
  setSasEnabled(v, true);
  setSasMode(v, 'prograde');
  const padRadius = v3.len(v.r);
  // East is the way the ground moves.
  const east = v3.normalize(v3.cross(env.spin, v.r));
  const { f, samples } = start(env, [v]);
  press(f);
  const c = controls({ throttle: 1 });
  fly(f, 130 * 120, 240, samples, () => {
    const up = v3.normalize(v.r);
    const altitude = v3.len(v.r) - padRadius;
    let pitch = 90;
    if (altitude > 800) pitch = Math.max(22, 90 - 68 * Math.pow((altitude - 800) / 65000, 0.6));
    const horizon = v3.normalize(v3.reject(east, up));
    setSasHoldDirection(v, v3.add(v3.scale(up, Math.sin(pitch * DEG)), v3.scale(horizon, Math.cos(pitch * DEG))));
    return c;
  });
  return [finish('pad to T+130 s', f, samples)];
}

// ----------------------------------------------------------------------------------------------- staging

/** The three stagings of the launcher in their nominal flight conditions, each followed for 12 s with every vessel it sheds. */
function staging(defs: DefLibrary): FixtureRun[] {
  const labels = ['first-stage separation at 68 km', 'tower and fairing jettison at 100 km', 'second-stage separation in low orbit'];
  return [1, 2, 3].map((index, k) => {
    const s = stageScenario(defs, index);
    const { f, samples } = start(s.env, s.vessels);
    for (const e of s.events) f.events.push(`0:${e.type}`);
    const c = controls({ throttle: s.throttle });
    fly(f, 12 * 120, 60, samples, () => c);
    return finish(labels[k]!, f, samples);
  });
}

// ------------------------------------------------------------------------------------------------- entry

/** Bank of the capsule's lift from the vertical plane during the entry run, degrees. */
const ENTRY_BANK_DEG = 60;

/** The capsule from the entry interface at 11 km/s and -6.5 degrees, shield first on SAS, its lift to the side: 300 s through peak heating and peak load. */
function entry(defs: DefLibrary): FixtureRun[] {
  const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, terrain: () => -3000, ocean: { density: 1025 } });
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
  const gamma = -6.5 * DEG;
  v.r = { x: 0, y: env.radius + 122000, z: 0 };
  v.v = { x: 11000 * Math.cos(gamma), y: 11000 * Math.sin(gamma), z: 0 };
  // Shield first: nose = -v. The lift (body -Z) is banked ENTRY_BANK from the vertical plane, so that the
  // entry neither skips out nor steepens beyond what the crew survives.
  const yAxis = v3.neg(v3.normalize(v.v));
  const upPerp = v3.normalize(v3.reject(v3.normalize(v.r), yAxis));
  const side = v3.normalize(v3.cross(upPerp, yAxis));
  const bank = ENTRY_BANK_DEG * DEG;
  const zAxis = v3.neg(v3.normalize(v3.add(v3.scale(upPerp, Math.cos(bank)), v3.scale(side, Math.sin(bank)))));
  v.q = quat.fromBasis(v3.cross(yAxis, zAxis), yAxis, zAxis);
  setRcsEnabled(v, true);
  setSasEnabled(v, true);
  setSasMode(v, 'retrograde');
  const { f, samples } = start(env, [v]);
  const c = controls();
  fly(f, 300 * 120, 480, samples, (step) => {
    // The hold direction is refreshed at the control-tick cadence, as the world does it.
    if (step % 4 === 0) setSasHoldDirection(v, v3.neg(v3.normalize(v.v)));
    return c;
  });
  return [finish('entry interface to T+300 s', f, samples)];
}

// --------------------------------------------------------------------------------------------- touchdown

/**
 * Height of the lander's origin above the datum at the start of the touchdown run, m: its feet are 9.0 m
 * below the origin, the slope rises 0.7 m under the uphill foot, and the first foot starts half a metre up.
 */
const TOUCHDOWN_ORIGIN_HEIGHT = 10.2;
/** Height of the origin of the landed stack with its feet two centimetres above the ground, m. */
const LANDED_ORIGIN_HEIGHT = 9.02;

/** The lander on its legs onto an 8 degree slope of a rotating Moon at about 1.5 m/s, then at rest until it sleeps. */
function touchdown(defs: DefLibrary): FixtureRun[] {
  const slope = Math.tan(8 * DEG);
  const env = makeEnv({ mu: MOON_MU, radius: MOON_RADIUS, terrain: (d: Vec3) => slope * MOON_RADIUS * d.x, friction: 0.7, spinRate: MOON_SPIN });
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
  // Touchdown mass: the descent stage has 7 % of its propellant left.
  drain(v, 'heron-descent-stage', 0.07);
  v.r = { x: 0, y: env.radius + TOUCHDOWN_ORIGIN_HEIGHT, z: 0 };
  v.v = v3.add(v3.cross(env.spin, v.r), { x: 0, y: -0.8, z: 0 });
  v.w = quat.rotateInv(v.q, env.spin);
  const { f, samples } = start(env, [v]);
  const c = controls();
  fly(f, 20 * 120, 30, samples, () => c);
  return [finish('drop onto an 8 degree slope', f, samples)];
}

// -------------------------------------------------------------------------------------------- splashdown

/** The capsule from 7 km: drogues, mains, into a sea with a running swell, then afloat. */
function splashdown(defs: DefLibrary): FixtureRun[] {
  const swell = (dir: Vec3, ut: number): number => 0.6 * Math.sin(2 * Math.PI * (ut / 7.5 + (dir.x * 6371000) / 95)) + 0.25 * Math.sin(2 * Math.PI * (ut / 4.1 - (dir.z * 6371000) / 40));
  const env = makeEnv({ atmosphere: earthAir, terrain: () => -500, ocean: { density: 1025, height: swell } });
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
  v.r = { x: 0, y: env.radius + 7200, z: 0 };
  v.v = { x: 0, y: -115, z: 0 };
  const { f, samples } = start(env, [v]);
  const c = controls();
  fly(f, 3 * 120, 720, samples, () => c);
  press(f); // drogues
  fly(f, 75 * 120, 720, samples, () => c);
  press(f); // mains
  fly(f, 522 * 120, 720, samples, () => c);
  return [finish('7 km to the sea and afloat', f, samples)];
}

// ------------------------------------------------------------------------------------------ lunar ascent

/** The landed stack on a rotating Moon: eight seconds at rest, the ascent stage lights and leaves the descent stage, 45 s of climb pitching over. */
function lunarAscent(defs: DefLibrary): FixtureRun[] {
  const env = makeEnv({ mu: MOON_MU, radius: MOON_RADIUS, spinRate: MOON_SPIN });
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
  placeUpright(v, env, LANDED_ORIGIN_HEIGHT);
  const { f, samples } = start(env, [v]);
  fly(f, 8 * 120, 60, samples, () => controls());
  setSasEnabled(v, true);
  setSasMode(v, 'prograde');
  const east = v3.normalize(v3.cross(env.spin, v.r));
  press(f);
  const c = controls({ throttle: 1 });
  const lift = f.step;
  fly(f, 45 * 120, 60, samples, (step) => {
    const up = v3.normalize(v.r);
    const t = (step - lift) * DT;
    // Vertical for six seconds, then down to 35 degrees above the horizon over the next twenty.
    const pitch = t < 6 ? 90 : Math.max(35, 90 - (55 * (t - 6)) / 20);
    const horizon = v3.normalize(v3.reject(east, up));
    setSasHoldDirection(v, v3.add(v3.scale(up, Math.sin(pitch * DEG)), v3.scale(horizon, Math.cos(pitch * DEG))));
    return c;
  });
  return [finish('rest, lift-off and 45 s of climb', f, samples)];
}

const DESCRIPTIONS: Record<FixtureName, string> = {
  ascent: 'The whole stack from the pad of a rotating Earth: ignition, clamp release (the clamp pieces welded into one held ground structure), 130 s of the pitch programme through max-q on SAS.',
  staging: 'First-stage separation with its retro and ullage motors, tower and fairing jettison, second-stage separation: each from its nominal flight condition, followed for 12 s with every vessel it sheds.',
  entry: 'The capsule from the entry interface (122 km, 11 km/s, -6.5 degrees), shield first on SAS with thrusters, its lift to the side, for 300 s: heating, ablation, peak load.',
  touchdown: 'The lunar lander on its legs onto an 8 degree slope of a rotating Moon at about 1.5 m/s: leg contact, friction, rest, sleep.',
  splashdown: 'The capsule from 7 km: drogues, mains, the sea with a running swell, buoyancy, afloat.',
  'lunar-ascent': 'The landed stack on a rotating Moon: at rest, the ascent stage lights and leaves the descent stage on the ground, 45 s of climb pitching over on SAS.',
};

const DRIVERS: Record<FixtureName, (defs: DefLibrary) => FixtureRun[]> = { ascent, staging, entry, touchdown, splashdown, 'lunar-ascent': lunarAscent };

/** Fly one fixture and return what it records. */
export function flyFixture(defs: DefLibrary, name: FixtureName): FixtureRecording {
  return { name, description: DESCRIPTIONS[name], dt: DT, runs: DRIVERS[name](defs) };
}
