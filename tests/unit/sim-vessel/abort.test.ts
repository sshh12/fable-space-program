/**
 * Launch-escape aborts flown through to the parachutes (sim-design section 11): the escape motor's thrust
 * line passes through the centre of mass of capsule + tower, so the burn is straight (with a small
 * deliberate pitch-over on the pad), the tower rides along until the dynamic pressure has dropped, and a
 * pilot with ordinary reactions survives. The g-load the crew feel includes the rotation of the capsule.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG, G0 } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { abort, assembleVessel, computeMassProps, fireNextStage, nextChuteEnvelope, setSasEnabled, vesselBaseY, type Vessel } from '@/sim/vessel';
import { controls, earthAir, loadLibrary, makeEnv, placeUpright, run, runAll, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const tilt = (v: Vessel): number => v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), v3.normalize(v.r)) / DEG;

interface AbortLog {
  tiltAtBurnout: number;
  apogee: number;
  peakG: number;
  peakRateBurn: number;
  peakAoaBurn: number;
  jettisonAt: number;
  qAtJettison: number;
  peakRateFree: number;
  /** Highest g-load at the seats between tower jettison and the first parachute press (the turn-round). */
  peakGFree: number;
  presses: { t: number; stage: number; altitude: number }[];
  touchdownSpeed: number;
  endedAt: number;
  events: SimEvent[];
}

/**
 * Press Backspace, then fly hands-off. The pilot presses Space `reaction` seconds after the envelope light
 * of the next parachute stage has turned (and stayed) green, once the tower has gone.
 */
function flyAbort(v: Vessel, env: FakeEnv, vessels: Vessel[], reaction: number, maxTime: number, until: (v: Vessel) => boolean): AbortLog {
  const res = abort(v, env);
  expect(res.ok).toBe(true);
  vessels.push(...res.spawned);
  const h0 = v3.len(v.r) - env.radius;
  const log: AbortLog = { tiltAtBurnout: NaN, apogee: 0, peakG: 0, peakRateBurn: 0, peakAoaBurn: 0, jettisonAt: -1, qAtJettison: 0, peakRateFree: 0, peakGFree: 0, presses: [], touchdownSpeed: NaN, endedAt: -1, events: [...res.events] };
  let safeSince = -1;
  let elapsed = 0;
  while (elapsed < maxTime && log.endedAt < 0) {
    log.events.push(
      ...runAll(vessels, env, 0.5, controls(), (dt) => {
        if (log.endedAt >= 0) return;
        const t = elapsed + dt;
        const rate = v3.len(v.w) / DEG;
        const h = v3.len(v.r) - env.radius;
        log.apogee = Math.max(log.apogee, h - h0);
        log.peakG = Math.max(log.peakG, v.gLoad);
        if (Math.abs(t - 3.5) < 0.004) log.tiltAtBurnout = tilt(v);
        if (v.parts.some((p) => p.instanceId === 'les')) {
          log.peakRateBurn = Math.max(log.peakRateBurn, rate);
          if (t < 3.5) log.peakAoaBurn = Math.max(log.peakAoaBurn, v.aero.aoa / DEG);
        } else {
          if (log.jettisonAt < 0) {
            log.jettisonAt = t;
            log.qAtJettison = v.aero.q;
          }
          log.peakRateFree = Math.max(log.peakRateFree, rate);
          if (log.presses.length === 0) log.peakGFree = Math.max(log.peakGFree, v.gLoad);
          if (nextChuteEnvelope(v, env) === 'safe') {
            if (safeSince < 0) safeSince = t;
          } else {
            safeSince = -1;
          }
          if (safeSince >= 0 && t - safeSince >= reaction) {
            const press = fireNextStage(v, env);
            if (press.ok) {
              const fired = press.events.find((e) => e.type === 'stageFired');
              log.presses.push({ t, stage: fired && fired.type === 'stageFired' ? fired.stageIndex : -1, altitude: h - h0 });
              log.events.push(...press.events);
              vessels.push(...press.spawned);
              safeSince = -1;
            }
          }
        }
        if (v.contact.anyContact && Number.isNaN(log.touchdownSpeed)) log.touchdownSpeed = v3.len(v.aero.airVelocity);
        if (v.destroyed || !v.crewAlive || until(v)) log.endedAt = t;
      }),
    );
    elapsed += 0.5;
  }
  return log;
}

function describeLog(name: string, l: AbortLog): string {
  return (
    `${name}: tilt at burnout ${l.tiltAtBurnout.toFixed(1)} deg, apogee +${l.apogee.toFixed(0)} m, peak ${l.peakG.toFixed(1)} g, ` +
    `burn: max rate ${l.peakRateBurn.toFixed(0)} deg/s, max angle of attack ${l.peakAoaBurn.toFixed(0)} deg; tower off at ${l.jettisonAt.toFixed(1)} s (q ${(l.qAtJettison / 1000).toFixed(1)} kPa), ` +
    `then max rate ${l.peakRateFree.toFixed(0)} deg/s and ${l.peakGFree.toFixed(1)} g at the seats; presses ${l.presses.map((p) => `stage ${p.stage + 1} at ${p.t.toFixed(1)} s (+${p.altitude.toFixed(0)} m)`).join(', ')}; ` +
    `touchdown ${l.touchdownSpeed.toFixed(1)} m/s at ${l.endedAt.toFixed(1)} s`
  );
}

describe('launch escape aborts', () => {
  it('pad abort: straight burn with a gentle pitch-over, more than 1 km of height, survivable with a 2.5 s pilot', () => {
    for (const sas of [true, false]) {
      const env = makeEnv({ atmosphere: earthAir });
      const v = assembleVessel(defs, VEHICLE);
      placeUpright(v, env, -vesselBaseY(v));
      setSasEnabled(v, sas);
      const vessels = [v];
      runAll(vessels, env, 1, controls());
      expect(v.hold).toBe('clamps');
      const pad = v3.clone(v.r);
      const l = flyAbort(v, env, vessels, 2.5, 400, (x) => x.contact.anyContact && x.surface === 'landed');
      console.log(describeLog(`pad abort, SAS ${sas ? 'on' : 'off'}`, l));
      // The stack stays on the pad, shut down and still clamped.
      expect(vessels[1]!.hold).toBe('clamps');
      // The burn: no pitch-over into the ground. A few degrees of deliberate lean carry the capsule off the pad.
      expect(l.tiltAtBurnout).toBeGreaterThan(5);
      expect(l.tiltAtBurnout).toBeLessThan(30);
      expect(l.peakRateBurn).toBeLessThan(40);
      expect(l.apogee).toBeGreaterThan(1000);
      expect(l.peakG).toBeLessThan(10.5);
      expect(v.gDose).toBeLessThan(1);
      // Tower off 14 s after the abort, near the top of the arc, where the capsule turns round gently.
      expect(l.jettisonAt).toBeGreaterThan(13.9);
      expect(l.jettisonAt).toBeLessThan(14.1);
      expect(l.qAtJettison).toBeLessThan(5000);
      expect(l.peakRateFree).toBeLessThan(200);
      expect(l.peakGFree).toBeLessThan(4);
      // First press after the abort is the drogue stage, the second the mains; nothing rips.
      expect(l.presses.map((p) => p.stage)).toEqual([8, 9]);
      expect(l.events.some((e) => e.type === 'chuteFailed')).toBe(false);
      const chutes = v.parts[0]!.modules.filter((m) => m.type === 'parachute');
      expect(chutes.map((m) => (m.type === 'parachute' ? m.state : ''))).toEqual(['cut', 'full']);
      // Down on three mains, alive, well clear of the pad.
      expect(v.crewAlive).toBe(true);
      expect(v.destroyed).toBe(false);
      expect(l.touchdownSpeed).toBeLessThan(8.5);
      expect(v3.dist(v.r, pad)).toBeGreaterThan(250);
    }
  }, 120000);

  it('max-q abort: the burn holds a small angle of attack, the tumble after tower jettison is bounded and costs no dose', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 12000, z: 0 };
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, -25 * DEG);
    v.v = v3.scale(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), 450);
    setSasEnabled(v, true);
    const vessels = [v];
    runAll(vessels, env, 1, controls({ throttle: 1 }));
    expect(v.aero.q).toBeGreaterThan(20000);
    const stack = v3.clone(v.r);
    let mainsFullAt = -1;
    const l = flyAbort(v, env, vessels, 2.5, 400, (x) => {
      const mains = x.parts[0]!.modules.find((m, i) => m.type === 'parachute' && x.parts[0]!.def.modules[i]!.type === 'parachute' && (x.parts[0]!.def.modules[i] as { mode: string }).mode === 'main');
      if (mains && mains.type === 'parachute' && mains.state === 'full' && mains.inflation >= 1 && mainsFullAt < 0) mainsFullAt = x.age;
      return mainsFullAt >= 0 && x.age - mainsFullAt > 10;
    });
    console.log(describeLog('max-q abort (12 km, 450 m/s)', l));
    expect(l.peakG).toBeLessThan(10.5);
    expect(l.peakAoaBurn).toBeLessThan(25);
    expect(l.peakRateBurn).toBeLessThan(40);
    expect(v3.dist(v.r, stack)).toBeGreaterThan(1000);
    // Tower off at 14 s with the dynamic pressure down from 30 to under 10 kPa; the capsule swings round
    // shield-first. The rate is bounded and what the crew feel at their seats stays far below the dose threshold.
    expect(l.qAtJettison).toBeLessThan(10000);
    expect(l.peakRateFree).toBeLessThan(360);
    expect(l.peakGFree).toBeLessThan(5);
    expect(v.gDose).toBe(0);
    expect(l.presses.map((p) => p.stage)).toEqual([8, 9]);
    expect(l.events.some((e) => e.type === 'chuteFailed')).toBe(false);
    expect(v.crewAlive).toBe(true);
    // Hanging under three open mains.
    expect(mainsFullAt).toBeGreaterThan(0);
    expect(v3.len(v.aero.airVelocity)).toBeLessThan(12);
    expect(tilt(v)).toBeLessThan(15);
  }, 120000);

  it('the pilot can drop the tower early: a press during the coast fires the tower jettison stage', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 30000, z: 0 };
    v.v = { x: 0, y: 900, z: 0 };
    const vessels = [v];
    vessels.push(...abort(v, env).spawned);
    runAll(vessels, env, 6, controls());
    expect(v.parts.some((p) => p.instanceId === 'les')).toBe(true);
    const press = fireNextStage(v, env);
    expect(press.ok).toBe(true);
    expect(press.events[0]).toMatchObject({ type: 'stageFired', stageIndex: 2 });
    expect(press.events.some((e) => e.type === 'decoupled' && e.partId === 'les')).toBe(true);
    vessels.push(...press.spawned);
    expect(v.parts.map((p) => p.instanceId).sort()).toEqual(['apex-cover', 'capsule']);
    // The automatic jettison at 14 s then finds nothing to do, and the next press is the drogue stage.
    const later = runAll(vessels, env, 10, controls());
    expect(later.some((e) => e.type === 'decoupled')).toBe(false);
    const drogues = fireNextStage(v, env);
    expect(drogues.events[0]).toMatchObject({ type: 'stageFired', stageIndex: 8 });
  });

  it('the escape motor thrust line passes through the centre of mass of capsule + tower', () => {
    const env = makeEnv({});
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 400000, z: 0 };
    v.v = { x: 7600, y: 0, z: 0 };
    const vessels = [v];
    const res = abort(v, env);
    vessels.push(...res.spawned);
    // The loaded capsule's CoM is 16 cm off the axis, the stack's 9 cm: an axial motor (800 kN) would turn
    // it over with 70 kN m. The canted motor's resultant passes within 2.5 cm of the CoM from ignition to
    // burnout; what is left is the deliberate pitch-over bias.
    const les = v.parts.find((p) => p.instanceId === 'les')!;
    const motor = les.def.modules.find((m) => m.type === 'engine');
    if (!motor || motor.type !== 'engine') throw new Error('no escape motor');
    const leverArm = (): number => {
      computeMassProps(v);
      let force = v3.zero();
      let torque = v3.zero();
      for (const nz of motor.nozzles) {
        const f = v3.neg(v3.normalize(quat.rotate(les.rot, v3.fromTuple(nz.dir))));
        const at = v3.sub(v3.add(les.pos, quat.rotate(les.rot, v3.fromTuple(nz.pos))), v.mp.com);
        force = v3.add(force, f);
        torque = v3.add(torque, v3.cross(at, f));
      }
      // The resultant leans a degree off the axis, toward the side opposite to the CoM offset.
      expect(v3.angle(force, { x: 0, y: 1, z: 0 }) / DEG).toBeGreaterThan(0.8);
      expect(v3.angle(force, { x: 0, y: 1, z: 0 }) / DEG).toBeLessThan(1.5);
      expect(force.z).toBeGreaterThan(0);
      return v3.len(torque) / v3.len(force);
    };
    expect(v.mp.com.z).toBeLessThan(-0.08);
    const armFull = leverArm();
    const solid = les.resources.slice();
    les.resources = les.resources.map(() => 0);
    const armEmpty = leverArm();
    les.resources = solid;
    computeMassProps(v);
    console.log(`escape motor: resultant passes ${(armFull * 100).toFixed(1)} cm from the CoM at ignition, ${(armEmpty * 100).toFixed(1)} cm at burnout (CoM offset ${(-v.mp.com.z * 100).toFixed(1)} cm)`);
    expect(armFull).toBeLessThan(0.025);
    expect(armEmpty).toBeLessThan(0.025);
    const q0 = quat.clone(v.q);
    expect(v.sas.enabled).toBe(false);
    let peakRate = 0;
    runAll(vessels, env, 3.6, controls(), () => {
      peakRate = Math.max(peakRate, v3.len(v.w) / DEG);
    });
    // In vacuum, with nothing but the motor acting (SAS off, no air to weathercock in), the bias turns the
    // stack by less than 60 degrees over the whole burn - the axial motor did 135 degrees in the air.
    const turned = v3.angle(quat.rotate(q0, { x: 0, y: 1, z: 0 }), quat.rotate(v.q, { x: 0, y: 1, z: 0 })) / DEG;
    console.log(`escape burn in vacuum, SAS off: attitude change ${turned.toFixed(1)} deg, peak rate ${peakRate.toFixed(1)} deg/s`);
    expect(turned).toBeLessThan(60);
    expect(peakRate).toBeLessThan(30);
  });
});

describe('g-load at the seats', () => {
  it('a spinning capsule loads the crew although its centre of mass is in free fall', () => {
    const env = makeEnv({});
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
    v.r = { x: 0, y: env.radius + 400000, z: 0 };
    v.v = { x: 7600, y: 0, z: 0 };
    const rate = 300 * DEG;
    v.w = { x: rate, y: 0, z: 0 };
    run(v, env, 1, controls());
    computeMassProps(v);
    const command = v.parts[0]!.def.modules.find((m) => m.type === 'command');
    if (!command || command.type !== 'command') throw new Error('no command module');
    let worst = 0;
    for (const seat of command.seats) worst = Math.max(worst, Math.hypot(seat.pos[1] - v.mp.com.y, seat.pos[2] - v.mp.com.z));
    // Tumbling about a principal-ish axis in vacuum: centripetal acceleration w^2 r at the worst seat.
    const w = v3.len(v.w);
    expect(w / DEG).toBeGreaterThan(290);
    expect(v.gLoad).toBeGreaterThan(0.8 * ((rate * rate * worst) / G0));
    expect(v.gLoad).toBeLessThan(1.25 * ((rate * rate * worst) / G0));
    expect(v.gLoad).toBeGreaterThan(1.5);
    // The proper acceleration of the centre of mass itself stays zero.
    expect(v3.len(v.properAccel)).toBeLessThan(1e-6);
    // 800 deg/s puts more than 10 g on the seats and the dose climbs.
    v.w = { x: 800 * DEG, y: 0, z: 0 };
    run(v, env, 2, controls());
    expect(v.gLoad).toBeGreaterThan(10);
    expect(v.gDose).toBeGreaterThan(0);
  });

  it('an uncrewed stage spinning in free fall reports no load', () => {
    const env = makeEnv({});
    const stack = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 7 });
    stack.r = { x: 0, y: env.radius + 400000, z: 0 };
    stack.v = { x: 7600, y: 0, z: 0 };
    const res = fireNextStage(stack, env);
    const vessels = [stack, ...res.spawned];
    runAll(vessels, env, 2, controls());
    const stage = vessels.find((x) => x !== stack && x.parts.some((p) => p.instanceId === 'ascent-stage'))!;
    stage.w = { x: 300 * DEG, y: 0, z: 0 };
    run(stage, env, 1, controls());
    expect(stage.gLoad).toBeLessThan(0.01);
  });
});
