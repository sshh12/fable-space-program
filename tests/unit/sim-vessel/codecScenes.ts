/**
 * Vessels caught in the regimes the codec must carry exactly (docs/ARCHITECTURE.md 7.2), for the codec
 * tests and for the corpus of blobs (codec-corpus/): a lander 60 and 150 steps into a touchdown, a capsule
 * at peak heating, a stack in the middle of a staging, a coasting vessel, and the 38-part stack in ascent.
 * Each scene gives the vessel at its instant, a way to make the environment of that instant again, and
 * the controls of the flight that follows.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, fireNextStage, setRcsEnabled, setSasEnabled, setSasHoldDirection, setSasMode, stepVessel, type Vessel } from '@/sim/vessel';
import { controls, DT, earthAir, makeEnv, MOON_MU, MOON_RADIUS, placeUpright, STANDARD_DENSITY, VEHICLE, type FakeEnv, type FakeEnvOptions } from './helpers';
import { drain, stageScenario } from './scenarios';

export const SCENE_NAMES = ['lander-touchdown-60', 'lander-touchdown-150', 'capsule-peak-heating', 'stack-mid-staging', 'coasting', 'stack-ascent'] as const;
export type SceneName = (typeof SCENE_NAMES)[number];

export interface Scene {
  name: SceneName;
  describe: string;
  vessel: Vessel;
  /** Steps flown to reach the scene. */
  steps: number;
  /** A fresh environment at the scene's instant. */
  env(): FakeEnv;
  /** Called before every step of the flight that follows, with the vessel being stepped; returns its controls. */
  pilot(v: Vessel, step: number): ControlInputs;
}

function envAt(options: FakeEnvOptions, steps: number): FakeEnv {
  const env = makeEnv(options);
  for (let i = 0; i < steps; i++) env.advance(DT);
  return env;
}

/** Step `v` (and nothing it sheds) `n` times. */
function fly(v: Vessel, env: FakeEnv, n: number, pilot: (v: Vessel, step: number) => ControlInputs, from = 0): void {
  for (let i = 0; i < n; i++) {
    stepVessel(v, env, pilot(v, from + i), DT);
    env.advance(DT);
  }
}

const neutral = (): ControlInputs => controls();

function landerTouchdown(defs: DefLibrary, after: number, name: SceneName): Scene {
  const slope = Math.tan(8 * DEG);
  const options: FakeEnvOptions = { mu: MOON_MU, radius: MOON_RADIUS, terrain: (d: Vec3) => slope * MOON_RADIUS * d.x, friction: 0.7, spinRate: 2.6617e-6 };
  const env = makeEnv(options);
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
  drain(v, 'heron-descent-stage', 0.07);
  v.r = { x: 0, y: env.radius + 10.2, z: 0 };
  v.v = v3.add(v3.cross(env.spin, v.r), { x: 0, y: -0.8, z: 0 });
  v.w = quat.rotateInv(v.q, env.spin);
  let steps = 0;
  while (!v.contact.anyContact && steps < 600) {
    fly(v, env, 1, neutral);
    steps++;
  }
  fly(v, env, after, neutral);
  steps += after;
  return { name, describe: `the lunar lander ${after} steps after its first foot touched an 8 degree slope`, vessel: v, steps, env: () => envAt(options, steps), pilot: neutral };
}

function capsulePeakHeating(defs: DefLibrary): Scene {
  const options: FakeEnvOptions = { densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, terrain: () => -3000, ocean: { density: 1025 } };
  const env = makeEnv(options);
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
  const gamma = -6.5 * DEG;
  v.r = { x: 0, y: env.radius + 122000, z: 0 };
  v.v = { x: 11000 * Math.cos(gamma), y: 11000 * Math.sin(gamma), z: 0 };
  const yAxis = v3.neg(v3.normalize(v.v));
  const upPerp = v3.normalize(v3.reject(v3.normalize(v.r), yAxis));
  const side = v3.normalize(v3.cross(upPerp, yAxis));
  const zAxis = v3.neg(v3.normalize(v3.add(v3.scale(upPerp, Math.cos(60 * DEG)), v3.scale(side, Math.sin(60 * DEG)))));
  v.q = quat.fromBasis(v3.cross(yAxis, zAxis), yAxis, zAxis);
  setRcsEnabled(v, true);
  setSasEnabled(v, true);
  setSasMode(v, 'retrograde');
  const pilot = (x: Vessel, step: number): ControlInputs => {
    if (step % 4 === 0) setSasHoldDirection(x, v3.neg(v3.normalize(x.v)));
    return controls();
  };
  // Fly until the heat flux has passed its peak (the first step at which it is 0.5 % under the largest seen).
  let steps = 0;
  let peak = 0;
  while (steps < 30000) {
    fly(v, env, 1, pilot, steps);
    steps++;
    if (v.aero.heatFlux > peak) peak = v.aero.heatFlux;
    else if (peak > 1e5 && v.aero.heatFlux < 0.995 * peak) break;
  }
  return { name: 'capsule-peak-heating', describe: 'the capsule at the peak of its entry heating, shield first on SAS with thrusters, ablating', vessel: v, steps, env: () => envAt(options, steps), pilot: (x, step) => pilot(x, steps + step) };
}

function stackMidStaging(defs: DefLibrary): Scene {
  // The first-stage separation: the press is made, retro and ullage motors burn, the second-stage ignition is queued.
  const s = stageScenario(defs, 1);
  const v = s.vessels[0]!;
  const c = controls({ throttle: s.throttle });
  const before = s.env.ut;
  fly(v, s.env, 40, () => c);
  const ut = s.env.ut;
  return {
    name: 'stack-mid-staging',
    describe: 'the stack 40 steps into the first-stage separation: a decoupling and an ignition queued, separation motors burning',
    vessel: v,
    steps: 40,
    env: () => {
      const env = makeEnv({ atmosphere: earthAir });
      // The staging scenario flew its own lead-in: put a fresh environment at the same instant.
      while (env.ut < before - 1e-9) env.advance(DT);
      for (let i = 0; i < 40; i++) env.advance(DT);
      if (Math.abs(env.ut - ut) > 1e-9) throw new Error('the staging scene lost its clock');
      env.ut = ut;
      return env;
    },
    pilot: () => c,
  };
}

function coasting(defs: DefLibrary): Scene {
  const options: FakeEnvOptions = {};
  const env = makeEnv(options);
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 7 });
  v.r = { x: 0, y: env.radius + 2500000, z: 0 };
  v.v = { x: 6700, y: 900, z: 0 };
  v.q = quat.normalize({ x: 0.2, y: -0.1, z: 0.35, w: 0.9 });
  v.w = { x: 0.5 * DEG, y: 0.5 * DEG, z: 0.7 * DEG };
  fly(v, env, 240, neutral);
  return { name: 'coasting', describe: 'the ascent stage and capsule coasting 2,500 km up, tumbling slowly', vessel: v, steps: 240, env: () => envAt(options, 240), pilot: neutral };
}

function stackAscent(defs: DefLibrary): Scene {
  const options: FakeEnvOptions = { densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating, spinRate: 7.2921159e-5 };
  const env = makeEnv(options);
  const v = assembleVessel(defs, VEHICLE);
  placeUpright(v, env, 120);
  setSasEnabled(v, true);
  setSasMode(v, 'prograde');
  const padRadius = v3.len(v.r);
  const east = v3.normalize(v3.cross(env.spin, v.r));
  const c = controls({ throttle: 1 });
  const pilot = (x: Vessel): ControlInputs => {
    const up = v3.normalize(x.r);
    const altitude = v3.len(x.r) - padRadius;
    let pitch = 90;
    if (altitude > 800) pitch = Math.max(22, 90 - 68 * Math.pow((altitude - 800) / 65000, 0.6));
    const horizon = v3.normalize(v3.reject(east, up));
    setSasHoldDirection(x, v3.add(v3.scale(up, Math.sin(pitch * DEG)), v3.scale(horizon, Math.cos(pitch * DEG))));
    return c;
  };
  fireNextStage(v, env);
  const steps = 60 * 120;
  fly(v, env, steps, pilot);
  return { name: 'stack-ascent', describe: 'the 38-part stack 60 s after ignition: nine engines burning, in the air near max-q', vessel: v, steps, env: () => envAt(options, steps), pilot };
}

/** Build a scene. Each call flies it afresh, so two calls give two equal, independent vessels. */
export function buildScene(defs: DefLibrary, name: SceneName): Scene {
  switch (name) {
    case 'lander-touchdown-60':
      return landerTouchdown(defs, 60, name);
    case 'lander-touchdown-150':
      return landerTouchdown(defs, 150, name);
    case 'capsule-peak-heating':
      return capsulePeakHeating(defs);
    case 'stack-mid-staging':
      return stackMidStaging(defs);
    case 'coasting':
      return coasting(defs);
    case 'stack-ascent':
      return stackAscent(defs);
  }
}

/** Fly a vessel on from a scene for `n` steps; returns the number of vessels it shed. */
export function flyOn(scene: Scene, v: Vessel, env: FakeEnv, n: number, each?: (step: number) => void): number {
  let shed = 0;
  for (let i = 0; i < n; i++) {
    shed += stepVessel(v, env, scene.pilot(v, i), DT).spawned.length;
    env.advance(DT);
    each?.(i + 1);
    if (v.destroyed) break;
  }
  return shed;
}
