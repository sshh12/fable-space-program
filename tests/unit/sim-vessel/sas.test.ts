/**
 * SAS: settling from a 90 degree error for every vessel configuration, stability capture and re-capture,
 * per-axis player override, fine control, deadband, actuator allocation, and the authority-aware
 * anti-windup that lets a lifting capsule ride its aerodynamic trim.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, setFineControl, setRcsEnabled, setSasEnabled, setSasHoldDirection, setSasMode, type Vessel } from '@/sim/vessel';
import { controls, loadLibrary, makeEnv, run, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const nose = (v: Vessel): Vec3 => quat.rotate(v.q, { x: 0, y: 1, z: 0 });

function inOrbit(fired: number, env: FakeEnv): Vessel {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: fired });
  v.r = { x: 0, y: env.radius + 400000, z: 0 };
  v.v = { x: 7600, y: 0, z: 0 };
  // RCS on (the thrusters armed by the stages fired so far take part).
  setRcsEnabled(v, true);
  setSasEnabled(v, true);
  return v;
}

interface Slew {
  settle: number;
  overshoot: number;
  finalError: number;
}

/** Command a direction 90 degrees from the nose (about the pitch or yaw axis) and record the response. */
function slew90(v: Vessel, env: FakeEnv, axis: 'pitch' | 'yaw', throttle: number, seconds = 40): Slew {
  const target = quat.rotate(v.q, axis === 'pitch' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 });
  setSasMode(v, 'prograde');
  setSasHoldDirection(v, target);
  let settle = -1;
  let reached = false;
  let overshoot = 0;
  run(v, env, seconds, controls({ throttle }), (t) => {
    const err = v3.angle(nose(v), target) / DEG;
    if (err < 1) {
      if (settle < 0) settle = t;
    } else settle = -1;
    // Overshoot: how far the nose swings away again after first coming within 1 degree of the target.
    if (err < 1) reached = true;
    else if (reached) overshoot = Math.max(overshoot, err);
  });
  return { settle: settle < 0 ? Infinity : settle, overshoot, finalError: v3.angle(nose(v), target) / DEG };
}

describe('settling from a 90 degree error', () => {
  const cases: { name: string; fired: number; throttle: number }[] = [
    { name: 'full stack on M-1 thrust', fired: 1, throttle: 1 },
    { name: 'M-3 stack (Vela-2V burning)', fired: 4, throttle: 1 },
    { name: 'lander stack (Lyra-D burning)', fired: 5, throttle: 1 },
    { name: 'ascent stage (coasting: CMGs + RCS)', fired: 7, throttle: 0 },
    { name: 'capsule (wheels + RCS)', fired: 8, throttle: 0 },
  ];
  const log: string[] = [];
  for (const c of cases) {
    it(c.name, () => {
      for (const axis of ['pitch', 'yaw'] as const) {
        const env = makeEnv({});
        const v = inOrbit(c.fired, env);
        run(v, env, c.throttle > 0 ? 3 : 0.1, controls({ throttle: c.throttle }));
        const r = slew90(v, env, axis, c.throttle);
        log.push(`${c.name}, ${axis}: settled (< 1 deg) after ${r.settle.toFixed(1)} s, overshoot ${r.overshoot.toFixed(2)} deg, error at 40 s ${r.finalError.toFixed(3)} deg`);
        expect(r.settle, `${c.name} ${axis}`).toBeLessThan(20);
        expect(r.overshoot, `${c.name} ${axis}`).toBeLessThan(5);
        expect(r.finalError).toBeLessThan(0.3);
        expect(v3.len(v.w) / DEG).toBeLessThan(0.2);
      }
    });
  }
  it('other configurations, for the record', () => {
    for (const c of [
      { name: 'M-2 stack (6 x Vela-2 burning)', fired: 2, throttle: 1, limit: 20 },
      { name: 'ascent stage (Lyra-A burning)', fired: 7, throttle: 1, limit: 20 },
      { name: 'lander stack coasting (RCS + CMGs only)', fired: 5, throttle: 0, limit: 35 },
      { name: 'M-3 stack coasting (two RCS pods only)', fired: 4, throttle: 0, limit: 90 },
    ]) {
      const env = makeEnv({});
      const v = inOrbit(c.fired, env);
      run(v, env, c.throttle > 0 ? 3 : 0.1, controls({ throttle: c.throttle }));
      const r = slew90(v, env, 'yaw', c.throttle, 110);
      log.push(`${c.name}, yaw: settled after ${r.settle.toFixed(1)} s, overshoot ${r.overshoot.toFixed(2)} deg, final error ${r.finalError.toFixed(3)} deg`);
      expect(r.settle, c.name).toBeLessThan(c.limit);
      expect(r.overshoot, c.name).toBeLessThan(5);
    }
    console.log(log.join('\n'));
  });
});

describe('modes and overrides', () => {
  it('stability mode captures on engage, follows player input, and re-captures on release', () => {
    const env = makeEnv({});
    const v = inOrbit(8, env);
    v.w = { x: 2 * DEG, y: -1 * DEG, z: 1.5 * DEG };
    const q0 = quat.clone(v.q);
    run(v, env, 12, controls());
    // The tumble is stopped and the attitude at engagement is restored.
    expect(v3.len(v.w) / DEG).toBeLessThan(0.05);
    expect(quat.angleBetween(v.q, q0) / DEG).toBeLessThan(0.5);
    // Pitch input: the capsule turns; pitch is not fought.
    run(v, env, 2, controls({ pitch: 1 }));
    expect(v.appliedControls.pitch).toBe(1);
    expect(v.w.x / DEG).toBeGreaterThan(5);
    const turned = quat.angleBetween(v.q, q0) / DEG;
    expect(turned).toBeGreaterThan(5);
    // Release: the rate is damped, then the new attitude is held (no return to the old target).
    run(v, env, 14, controls());
    expect(v3.len(v.w) / DEG).toBeLessThan(0.05);
    const held = quat.clone(v.q);
    expect(quat.angleBetween(held, q0) / DEG).toBeGreaterThan(turned);
    run(v, env, 10, controls());
    expect(quat.angleBetween(v.q, held) / DEG).toBeLessThan(0.2);
    // Disabled: nothing but the player's input.
    setSasEnabled(v, false);
    v.w = { x: 0, y: 3 * DEG, z: 0 };
    run(v, env, 3, controls());
    expect(v.w.y / DEG).toBeCloseTo(3, 3);
    expect(v.appliedControls).toMatchObject({ pitch: 0, yaw: 0, roll: 0 });
  });

  it('direction hold leaves roll to the player and keeps pointing while the vessel is rolled', () => {
    const env = makeEnv({});
    const v = inOrbit(8, env);
    const target = v3.normalize({ x: 0.3, y: 1, z: -0.4 });
    setSasMode(v, 'radialOut');
    setSasHoldDirection(v, target);
    run(v, env, 15, controls());
    expect(v3.angle(nose(v), target) / DEG).toBeLessThan(0.3);
    const dorsal0 = quat.rotate(v.q, { x: 0, y: 0, z: 1 });
    run(v, env, 4, controls({ roll: 1 }));
    expect(v.w.y / DEG).toBeGreaterThan(10);
    run(v, env, 6, controls());
    // Roll rate damped; the roll angle reached is kept (no roll target), the nose still on the direction.
    expect(Math.abs(v.w.y) / DEG).toBeLessThan(0.05);
    expect(v3.angle(nose(v), target) / DEG).toBeLessThan(0.5);
    expect(v3.angle(quat.rotate(v.q, { x: 0, y: 0, z: 1 }), dorsal0) / DEG).toBeGreaterThan(30);
    // A direction mode without a supplied direction behaves as stability.
    setSasHoldDirection(v, null);
    const q1 = quat.clone(v.q);
    run(v, env, 5, controls());
    expect(quat.angleBetween(v.q, q1) / DEG).toBeLessThan(0.2);
  });

  it('control signs: pitch raises the nose toward +Z, yaw turns it toward +X, roll is about +Y', () => {
    const env = makeEnv({});
    for (const [input, check] of [
      [{ pitch: 1 }, (v: Vessel) => v.w.x > 0.01],
      [{ yaw: 1 }, (v: Vessel) => v.w.z < -0.01],
      [{ roll: 1 }, (v: Vessel) => v.w.y > 0.01],
    ] as const) {
      const v = inOrbit(8, env);
      setSasEnabled(v, false);
      run(v, env, 1, controls(input));
      expect(check(v), JSON.stringify(input)).toBe(true);
    }
    // Same signs through gimbals on the lander stack.
    const v = inOrbit(5, env);
    setSasEnabled(v, false);
    setRcsEnabled(v, false);
    run(v, env, 2, controls({ throttle: 1 }));
    const before = nose(v);
    const zAxis = quat.rotate(v.q, { x: 0, y: 0, z: 1 });
    run(v, env, 2, controls({ throttle: 1, pitch: 1 }));
    expect(v3.dot(v3.sub(nose(v), before), zAxis)).toBeGreaterThan(0.01);
    const engine = v.parts.find((p) => p.instanceId === 'lyra-d')!.modules[0]!;
    if (engine.type !== 'engine') throw new Error('no engine');
    expect(Math.abs(engine.gimbal[0])).toBeCloseTo(6 * DEG, 3);
  });

  it('fine control scales player input to 30 %', () => {
    const env = makeEnv({});
    const v = inOrbit(8, env);
    setSasEnabled(v, false);
    setFineControl(v, true);
    run(v, env, 0.5, controls({ pitch: 1, yaw: -1, roll: 0.5, translate: { x: 1, y: 0, z: 0 } }));
    expect(v.appliedControls.pitch).toBeCloseTo(0.3, 12);
    expect(v.appliedControls.yaw).toBeCloseTo(-0.3, 12);
    expect(v.appliedControls.roll).toBeCloseTo(0.15, 12);
    expect(v.appliedControls.translate.x).toBeCloseTo(0.3, 12);
  });

  it('once settled the thrusters go quiet (deadband) and RCS propellant stops flowing', () => {
    const env = makeEnv({});
    const v = inOrbit(8, env);
    v.w = { x: 1 * DEG, y: 0, z: 0 };
    run(v, env, 20, controls());
    const prop = v.parts[0]!.resources[0]!;
    let fired = 0;
    run(v, env, 30, controls(), () => {
      const rcs = v.parts[0]!.modules.find((m) => m.type === 'rcs');
      if (rcs && rcs.type === 'rcs' && rcs.levels.some((l) => l > 0)) fired++;
    });
    expect(fired).toBe(0);
    expect(v.parts[0]!.resources[0]!).toBe(prop);
    expect(prop).toBeLessThan(150);
  });

  it('RCS translation moves the vessel along the commanded axis and stays quiet during a main-engine burn', () => {
    const env = makeEnv({});
    const v = inOrbit(7, env);
    setSasEnabled(v, false);
    const v0 = v3.clone(v.v);
    const fwd = nose(v);
    const res = run(v, env, 5, controls({ translate: { x: 0, y: 1, z: 0 } }));
    const dv = v3.sub(v.v, v0);
    // Four forward-firing 220 N thrusters on the ascent stage push 17.3 t (plus gravity acting on both runs).
    const coast = inOrbit(7, env);
    setSasEnabled(coast, false);
    const c0 = v3.clone(coast.v);
    run(coast, makeEnv({}), 5, controls());
    const net = v3.sub(dv, v3.sub(coast.v, c0));
    expect(v3.dot(net, fwd)).toBeCloseTo((4 * 220 * 5) / v.mp.mass, 2);
    expect(res.events.some((e) => e.type === 'rcsPulse')).toBe(true);

    // During a gimballed burn the pitch/yaw axes are flown on the gimbal alone.
    const burn = inOrbit(5, makeEnv({}));
    const env2 = makeEnv({});
    run(burn, env2, 3, controls({ throttle: 1 }));
    const rcsBefore = burn.parts.filter((p) => p.def.resources?.some((r) => r.resource === 'RCSProp')).reduce((s, p) => s + p.resources[p.def.resources!.findIndex((r) => r.resource === 'RCSProp')]!, 0);
    setSasMode(burn, 'prograde');
    setSasHoldDirection(burn, quat.rotate(burn.q, v3.normalize({ x: 0.3, y: 1, z: 0 })));
    run(burn, env2, 10, controls({ throttle: 1 }));
    const rcsAfter = burn.parts.filter((p) => p.def.resources?.some((r) => r.resource === 'RCSProp')).reduce((s, p) => s + p.resources[p.def.resources!.findIndex((r) => r.resource === 'RCSProp')]!, 0);
    // Roll damping may use a little; pitch and yaw use none.
    expect(rcsBefore - rcsAfter).toBeLessThan(2);
  });
});

describe('authority-aware anti-windup', () => {
  // Steady hypersonic flow: uniform density, no gravity to speak of, capsule flying along +X.
  const flow = (rho: number): { env: FakeEnv; air: { rho0: number; scaleHeight: number; temperature: number; top: number } } => {
    const air = { rho0: rho, scaleHeight: 1e12, temperature: 220, top: 1e9 };
    return { env: makeEnv({ mu: 1, atmosphere: air }), air };
  };

  it('a capsule held retrograde rides its trim, keeps the RCS for roll, and gets its hold back when the air thins', () => {
    const { env, air } = flow(4e-4);
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
    v.r = { x: 0, y: env.radius + 60000, z: 0 };
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG); // shield leads along +X
    setRcsEnabled(v, true);
    for (const m of v.parts[0]!.modules) if (m.type === 'rcs') m.enabled = true;
    setSasEnabled(v, true);
    setSasMode(v, 'retrograde');
    const speed = 3000;
    let saturated = 0;
    let worst = 0;
    const hold = (seconds: number, roll = 0): void => {
      run(v, env, seconds, controls({ roll }), () => {
        // Keep the flow steady: constant speed along +X, retrograde hold direction = -velocity.
        v.v = { x: speed, y: 0, z: 0 };
        setSasHoldDirection(v, { x: -1, y: 0, z: 0 });
        const rcs = v.parts[0]!.modules.find((m) => m.type === 'rcs');
        if (!rcs || rcs.type !== 'rcs') throw new Error('no rcs');
        // Thrusters 4..11 are the pitch and yaw jets.
        if (rcs.levels.slice(4).some((l) => l >= 0.999)) saturated += 1 / 120;
        else saturated = 0;
        worst = Math.max(worst, saturated);
      });
    };
    setSasHoldDirection(v, { x: -1, y: 0, z: 0 });
    v.v = { x: speed, y: 0, z: 0 };
    hold(40);
    // q = 1.8 kPa: the trim torque is far beyond 1 kN m of authority. The capsule sits at its trim angle.
    const alpha = 180 - v.aero.aoa / DEG;
    expect(alpha).toBeGreaterThan(15);
    expect(alpha).toBeLessThan(21);
    expect(v.sas.hold[0]).toBeLessThan(0.05);
    expect(Math.abs(v.sas.externalTorque[0])).toBeGreaterThan(3 * v.authority[0]);
    expect(worst).toBeLessThan(2);
    // Steady: propellant use over the next 30 s is negligible.
    const prop0 = v.parts[0]!.resources[0]!;
    saturated = 0;
    worst = 0;
    hold(30);
    expect(prop0 - v.parts[0]!.resources[0]!).toBeLessThan(0.5);
    expect(worst).toBe(0);
    // Roll command: the capsule rolls about its axis, the lift vector with it.
    const lift0 = quat.rotate(v.q, v.aero.liftDirVes!);
    hold(4, 1);
    hold(6, 0);
    expect(v3.angle(quat.rotate(v.q, v.aero.liftDirVes!), lift0) / DEG).toBeGreaterThan(60);
    expect(180 - v.aero.aoa / DEG).toBeGreaterThan(13);
    // The air thins out (end of entry): authority is back, the hold returns with hysteresis.
    air.rho0 = 4e-7;
    hold(40);
    expect(v.sas.hold[0]).toBeGreaterThan(0.95);
    expect(v.sas.hold[2]).toBeGreaterThan(0.95);
    expect(180 - v.aero.aoa / DEG).toBeLessThan(1);
  });

  it('hysteresis: the hold weight does not chatter around the release threshold', () => {
    const { env, air } = flow(1e-6);
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
    v.r = { x: 0, y: env.radius + 60000, z: 0 };
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG);
    setRcsEnabled(v, true);
    for (const m of v.parts[0]!.modules) if (m.type === 'rcs') m.enabled = true;
    setSasEnabled(v, true);
    setSasMode(v, 'retrograde');
    let reversals = 0;
    let previous = 1;
    let direction = 0;
    // Density ramps slowly up through the threshold and back down.
    run(v, env, 120, controls(), (t) => {
      v.v = { x: 3000, y: 0, z: 0 };
      setSasHoldDirection(v, { x: -1, y: 0, z: 0 });
      const phase = t < 60 ? t / 60 : (120 - t) / 60;
      air.rho0 = 1e-6 * Math.pow(400, phase);
      const h = v.sas.hold[0];
      const d = Math.sign(h - previous);
      if (d !== 0 && d !== direction) {
        if (direction !== 0) reversals++;
        direction = d;
      }
      previous = h;
    });
    // Down once, up once.
    expect(reversals).toBe(1);
    expect(v.sas.hold[0]).toBeGreaterThan(0.95);
  });
});
