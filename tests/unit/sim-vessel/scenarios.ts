/**
 * Nominal flight conditions for each of the ten stage events (sim-design 13.3 / 16.2), used by the
 * staging and separation-clearance tests. Each scenario starts from the vehicle with the earlier stages
 * already fired, flies it into the state in which the stage is normally fired - including a residual
 * attitude rate of up to 1 deg/s - and presses the stage.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, fireNextStage, setSasEnabled, type Vessel } from '@/sim/vessel';
import { controls, earthAir, makeEnv, MOON_MU, MOON_RADIUS, placeUpright, runAll, VEHICLE, type FakeEnv } from './helpers';

export interface StageScenario {
  index: number;
  env: FakeEnv;
  /** vessels[0] is the continuing (crewed) vessel. */
  vessels: Vessel[];
  /** Throttle held after the stage is fired. */
  throttle: number;
  /** Events of the stage press itself (delayed actions report through the steps that follow). */
  events: SimEvent[];
}

function fly(v: Vessel, env: FakeEnv, altitude: number, speed: number, tiltDeg: number): void {
  v.r = { x: 0, y: env.radius + altitude, z: 0 };
  v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, -tiltDeg * DEG);
  v.v = v3.scale(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), speed);
  v.w = v3.zero();
}

/** Leave the fraction `keep` of every engine propellant in the parts of one definition (thruster propellant untouched). */
export function drain(v: Vessel, defId: string, keep: number): void {
  for (const p of v.parts) {
    if (p.def.id !== defId) continue;
    (p.def.resources ?? []).forEach((r, k) => {
      if (r.resource !== 'RCSProp') p.resources[k] = r.capacity * keep;
    });
  }
}

function press(s: StageScenario): void {
  const res = fireNextStage(s.vessels[0]!, s.env);
  if (!res.ok) throw new Error(`stage ${s.index} refused: ${res.reason}`);
  s.events.push(...res.events);
  s.vessels.push(...res.spawned);
}

/** Build the scenario for stage `index` (0-based) and fire the stage. */
export function stageScenario(defs: DefLibrary, index: number): StageScenario {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: index });
  const rate = (x: number, y: number, z: number): void => {
    v.w = { x: x * DEG, y: y * DEG, z: z * DEG };
  };
  let env: FakeEnv;
  let throttle = 1;
  const vessels = [v];
  switch (index) {
    case 0: {
      // On the pad of a rotating Earth, throttle up.
      env = makeEnv({ atmosphere: earthAir, spinRate: 7.2921159e-5 });
      placeUpright(v, env, 120);
      runAll(vessels, env, 0.5, controls({ throttle: 1 }));
      break;
    }
    case 1: {
      // M-1 burnout at 68 km, 2.3 km/s, pitched 60 degrees from the vertical.
      env = makeEnv({ atmosphere: earthAir });
      drain(v, 'meridian-m1', 0.012);
      fly(v, env, 68000, 2300, 60);
      runAll(vessels, env, 1.2, controls({ throttle: 1 }));
      rate(1, 0, 0);
      break;
    }
    case 2: {
      // M-2 burning at 100 km: tower and fairing go while the stack accelerates.
      env = makeEnv({ atmosphere: earthAir });
      fly(v, env, 100000, 3000, 75);
      runAll(vessels, env, 4, controls({ throttle: 1 }));
      rate(0.6, 0.5, 0.6);
      break;
    }
    case 3: {
      // M-2 nearly empty in low orbit, still thrusting at 3 g.
      env = makeEnv({ atmosphere: earthAir });
      drain(v, 'meridian-m2', 0.03);
      fly(v, env, 185000, 7700, 90);
      runAll(vessels, env, 3, controls({ throttle: 1 }));
      rate(1, 0, 0);
      break;
    }
    case 4: {
      // After TLI: engine off, coasting.
      env = makeEnv({});
      drain(v, 'meridian-m3', 0.08);
      fly(v, env, 300000, 10800, 90);
      rate(0, 0, 1);
      throttle = 0;
      break;
    }
    case 5: {
      // Lunar orbit before the descent: gear down.
      env = makeEnv({ mu: MOON_MU, radius: MOON_RADIUS });
      fly(v, env, 100000, 1633, 90);
      throttle = 0;
      break;
    }
    case 6: {
      // Landed on the Moon with the descent stage nearly dry; lift off under SAS.
      env = makeEnv({ mu: MOON_MU, radius: MOON_RADIUS });
      drain(v, 'heron-descent-stage', 0.07);
      placeUpright(v, env, 13.6);
      runAll(vessels, env, 8, controls());
      setSasEnabled(v, true);
      break;
    }
    case 7: {
      // Trans-Earth coast, 2 500 km up.
      env = makeEnv({});
      drain(v, 'heron-ascent-stage', 0.1);
      fly(v, env, 2500000, 8000, 120);
      rate(0.5, 0.5, 0.7);
      throttle = 0;
      break;
    }
    case 8: {
      // Capsule falling shield-first through 7 km.
      env = makeEnv({ atmosphere: earthAir });
      v.r = { x: 0, y: env.radius + 7200, z: 0 };
      v.v = { x: 0, y: -115, z: 0 };
      runAll(vessels, env, 3, controls());
      rate(0.5, 0, 0.5);
      throttle = 0;
      break;
    }
    case 9: {
      // Under the drogues at 3 km.
      env = makeEnv({ atmosphere: earthAir });
      v.r = { x: 0, y: env.radius + 3100, z: 0 };
      v.v = { x: 0, y: -45, z: 0 };
      runAll(vessels, env, 3, controls());
      throttle = 0;
      break;
    }
    default:
      throw new Error(`no scenario for stage ${index}`);
  }
  const s: StageScenario = { index, env, vessels, throttle, events: [] };
  press(s);
  return s;
}
