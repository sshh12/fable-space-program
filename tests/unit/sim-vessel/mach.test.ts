/**
 * The Mach number a vessel reports (request flight-ui-6): 0 where there is no air, the model's value in an
 * atmosphere. The model's own value (speed over the sample's speed of sound, which VACUUM also carries) is
 * untouched: the dynamics and the parachute envelopes use it exactly as before.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { VACUUM } from '@/core/contracts/simInternal';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, chuteEnvelope, nextChuteEnvelope, reportedMach, stepVessel, toVesselSnapshot, vesselReadouts, type Vessel } from '@/sim/vessel';
import { controls, DT, earthAir, loadLibrary, makeEnv, placeUpright, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

/** The capsule under its parachute stages (nine stages fired: the drogues are next), moving at `speed` through the air. */
function capsuleAt(env: FakeEnv, altitude: number, speed: number): Vessel {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 9 });
  placeUpright(v, env, altitude);
  v.v = { x: speed, y: 0, z: 0 };
  stepVessel(v, env, controls(), DT);
  return v;
}

const snapshotOf = (v: Vessel) =>
  toVesselSnapshot(v, { bodyId: 'test-body', tier: 'full', situation: 'flying', translationMode: 'integrated', rRoot: v3.clone(v.r), vRoot: v3.clone(v.v), sunVisibility: 1 });

describe('reported Mach number', () => {
  it('is 0 above the atmosphere and on an airless body, whatever the speed', () => {
    for (const env of [makeEnv({ atmosphere: earthAir }), makeEnv()]) {
      for (const speed of [275, 1650, 7700]) {
        const v = capsuleAt(env, 300000, speed);
        expect(v.aero.density).toBe(0);
        // The model's value is the speed over the nominal speed of sound of the vacuum sample, as before.
        expect(v.aero.mach).toBeCloseTo(v3.len(v.aero.airVelocity) / VACUUM.speedOfSound, 12);
        expect(v.aero.mach).toBeGreaterThan(0.9);
        expect(reportedMach(v)).toBe(0);
        expect(snapshotOf(v).aero.mach).toBe(0);
        expect(vesselReadouts(v, env).mach).toBe(0);
        // The other air data keep their meaning: no dynamic pressure, the geometric angle of attack.
        expect(snapshotOf(v).aero.q).toBe(0);
        expect(vesselReadouts(v, env).angleOfAttack).toBe(v.aero.aoa);
      }
    }
  });

  it('is the model Mach number inside an atmosphere', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = capsuleAt(env, 7000, 130);
    expect(v.aero.density).toBeGreaterThan(0.1);
    const mach = v3.len(v.aero.airVelocity) / env.atmosphereAt(7000).speedOfSound;
    expect(mach).toBeGreaterThan(0.3);
    expect(v.aero.mach).toBeCloseTo(mach, 12);
    expect(reportedMach(v)).toBe(v.aero.mach);
    expect(snapshotOf(v).aero.mach).toBe(v.aero.mach);
    expect(vesselReadouts(v, env).mach).toBe(v.aero.mach);
  });

  it('leaves the parachute envelope as it was: in vacuum it is still judged with the model value, not with 0', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = capsuleAt(env, 300000, 7700);
    const part = v.parts.find((p) => p.def.modules.some((m) => m.type === 'parachute' && m.mode === 'drogue'))!;
    const def = part.def.modules.find((m) => m.type === 'parachute' && m.mode === 'drogue')!;
    if (def.type !== 'parachute') throw new Error('no drogue');
    const speed = v3.len(v.aero.airVelocity);
    const altitude = v3.len(v.r) - env.radius;
    const withModel = chuteEnvelope(def, altitude, v.aero.mach, speed, v.aero.q);
    expect(nextChuteEnvelope(v, env)).toBe(withModel);
    expect(vesselReadouts(v, env).chuteEnvelope).toBe(withModel);
    expect(withModel).toBe('unsafe');
  });
});
