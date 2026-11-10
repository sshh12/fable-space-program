/**
 * Ground contact, landing legs, sleep, and water: leg drop tests on slopes, static tip-over, resting
 * without jitter, crash tolerances, buoyancy equilibrium and self-righting, splashdown.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { oceanSwellHeight } from '@/core/geo/oceanSwell';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, computeMassProps, fireNextStage, needsIntegration, radarAltitude, setSasEnabled, structureOf, toggleLegs, vesselReadouts, type Vessel } from '@/sim/vessel';
import { controls, earthAir, loadLibrary, makeEnv, MOON_MU, MOON_RADIUS, run, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

function moonSlope(deg: number, spinRate = 0): FakeEnv {
  const t = Math.tan(deg * DEG);
  // Plane rising toward +X through the point (0, R, 0).
  return makeEnv({ mu: MOON_MU, radius: MOON_RADIUS, terrain: (d) => t * MOON_RADIUS * d.x, friction: 0.7, spinRate });
}

/** Lander at touchdown mass (descent stage 7 % full), legs down. */
function lander(): Vessel {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
  for (const p of v.parts) if (p.def.id === 'heron-descent-stage') p.resources = p.resources.map((x, i) => (i < 2 ? x * 0.07 : x));
  return v;
}

function lowestFoot(v: Vessel): number {
  let low = Infinity;
  for (const lg of structureOf(v).legs) for (const pr of lg.probes) low = Math.min(low, pr.y - pr.radius);
  return low;
}

/** Upright (aligned with gravity) above a slope, the first foot `gap` above the ground, descending at vDown. */
function dropUpright(env: FakeEnv, slopeDeg: number, gap: number, vDown: number): Vessel {
  const v = lander();
  const legs = defs.parts['heron-landing-legs']!.modules[0]!;
  if (legs.type !== 'legs') throw new Error('no legs');
  const footX = Math.max(...legs.legs.map((l) => l.footDeployed[0]));
  v.r = { x: 0, y: env.radius - lowestFoot(v) + Math.tan(slopeDeg * DEG) * (footX + 0.4) + gap, z: 0 };
  v.v = v3.add(v3.cross(env.spin, v.r), { x: 0, y: -vDown, z: 0 });
  v.w = quat.rotateInv(v.q, env.spin);
  return v;
}

const tiltFrom = (v: Vessel, n: { x: number; y: number; z: number }): number => v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), n) / DEG;
const UP = { x: 0, y: 1, z: 0 };
const legState = (v: Vessel) => {
  const m = v.parts.find((p) => p.def.id === 'heron-landing-legs')?.modules[0];
  return m && m.type === 'legs' ? m : null;
};

describe('landing legs', () => {
  it('drop tests: 1 and 3 m/s land on 0, 10 and 20 degree slopes, 5 m/s collapses the gear', () => {
    const log: string[] = [];
    for (const slope of [0, 10, 20]) {
      for (const speed of [1, 3, 5]) {
        const env = moonSlope(slope);
        const v = dropUpright(env, slope, 0.02, speed);
        let asleepAt = -1;
        let maxTilt = 0;
        const res = run(v, env, 25, controls(), (t) => {
          if (asleepAt < 0 && v.hold === 'asleep') asleepAt = t;
          if (!v.destroyed) maxTilt = Math.max(maxTilt, tiltFrom(v, UP));
        });
        const legs = legState(v);
        const collapsed = res.events.some((e) => e.type === 'jointBroken') || res.events.some((e) => e.type === 'partDestroyed');
        log.push(`slope ${slope} deg, ${speed} m/s: ${collapsed ? 'COLLAPSE' : 'landed'}, asleep after ${asleepAt.toFixed(1)} s, max tilt ${maxTilt.toFixed(1)} deg`);
        const touchdown = res.events.find((e) => e.type === 'touchdown');
        expect(touchdown).toBeDefined();
        if (touchdown?.type === 'touchdown') {
          expect(touchdown.surface).toBe('land');
          expect(touchdown.partId).toBe('landing-legs');
          expect(touchdown.vesselId).toBe(v.id);
          expect(touchdown.speed).toBeGreaterThan(speed * 0.95);
          expect(touchdown.speed).toBeLessThan(speed + 0.5);
        }
        if (speed <= 3) {
          expect(collapsed, `slope ${slope} speed ${speed}`).toBe(false);
          expect(legs!.broken).toEqual([false, false, false, false]);
          expect(v.parts).toHaveLength(9);
          expect(v.hold, `slope ${slope} speed ${speed}`).toBe('asleep');
          // Settled on the slope: within 3 degrees of the surface normal, never close to going over.
          expect(Math.abs(tiltFrom(v, UP) - slope)).toBeLessThan(3);
          expect(maxTilt).toBeLessThan(38);
          expect(v.crewAlive).toBe(true);
        } else {
          expect(collapsed, `slope ${slope} speed ${speed}`).toBe(true);
          expect(res.events.filter((e) => e.type === 'jointBroken').length).toBeGreaterThanOrEqual(2);
        }
      }
    }
    console.log(log.join('\n'));
  });

  it('static tip-over near 40 degrees', () => {
    const rest = (slope: number): { tilt: number; asleep: boolean; intact: boolean } => {
      const env = moonSlope(slope);
      const v = lander();
      // Standing on the slope, aligned with its normal. Pad friction is raised so that the test isolates
      // tipping from sliding (tan 40 deg is close to the pad's friction coefficient of 0.9).
      for (const lg of structureOf(v).legs) for (const pr of lg.probes) pr.mu = 5;
      const th = slope * DEG;
      const n = { x: -Math.sin(th), y: Math.cos(th), z: 0 };
      v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, th);
      v.r = v3.add({ x: 0, y: env.radius, z: 0 }, v3.scale(n, -lowestFoot(v) + 0.02));
      run(v, env, 25, controls());
      return { tilt: v.destroyed ? 180 : tiltFrom(v, n), asleep: v.hold === 'asleep', intact: v.parts.length === 9 };
    };
    for (const slope of [30, 36]) {
      const r = rest(slope);
      expect(r.asleep, `stable at ${slope}`).toBe(true);
      expect(r.tilt).toBeLessThan(1);
      expect(r.intact).toBe(true);
    }
    for (const slope of [42, 45]) {
      // In lunar gravity the fall is slow: after 25 s the lander is clearly going over.
      const r = rest(slope);
      expect(r.tilt, `tips at ${slope}`).toBeGreaterThan(10);
    }
    // Bisect the threshold.
    let lo = 36;
    let hi = 42;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      if (rest(mid).tilt < 5) lo = mid;
      else hi = mid;
    }
    console.log(`static tip-over between ${lo.toFixed(2)} and ${hi.toFixed(2)} degrees`);
    expect(lo).toBeGreaterThanOrEqual(37);
    expect(hi).toBeLessThanOrEqual(42);
    // Rigid geometry gives atan(tipping-axis distance / CoM height); strut compliance takes about a degree off.
    const v = lander();
    computeMassProps(v);
    const comAbovePads = v.mp.com.y - lowestFoot(v);
    const padRadius = Math.hypot(...(defs.parts['heron-landing-legs']!.contactPoints![0]!.pos.filter((_, i) => i !== 1) as [number, number]));
    expect(Math.atan((padRadius * Math.SQRT1_2) / comAbovePads) / DEG).toBeGreaterThan(38);
    expect(Math.atan((padRadius * Math.SQRT1_2) / comAbovePads) / DEG).toBeLessThan(42);
  });

  it('the lander rests without jitter, sleeps within 5 s, stays put on a rotating body and wakes on thrust', () => {
    const spin = 2.6617e-6 * 50; // 50x the Moon's rotation rate, to make any frame error visible
    const env = moonSlope(0, spin);
    const v = dropUpright(env, 0, 0.02, 0.5);
    let asleepAt = -1;
    let jitter = 0;
    let restFixed: ReturnType<typeof quat.rotateInv> | null = null;
    run(v, env, 6, controls(), (t) => {
      if (asleepAt < 0 && v.hold === 'asleep') asleepAt = t;
      // After the first 2.5 s the vessel must be still relative to the ground.
      if (t > 2.5 && asleepAt < 0) {
        const fixed = quat.rotateInv(env.qFixedToInertial, v.r);
        if (restFixed) jitter = Math.max(jitter, v3.dist(fixed, restFixed));
        else restFixed = fixed;
      }
    });
    expect(asleepAt).toBeGreaterThan(2);
    expect(asleepAt).toBeLessThan(5);
    expect(jitter).toBeLessThan(0.002);
    expect(v.surface).toBe('landed');
    expect(needsIntegration(v, env)).toBe(false);
    expect(radarAltitude(v, env)).toBe(0);
    expect(vesselReadouts(v, env).legsDeployed).toBe(true);
    const legs = legState(v)!;
    expect(legs.contact).toEqual([true, true, true, true]);
    // Static stroke: each strut carries a quarter of the weight along its inclined axis,
    // s = (W / (4 cos(strut, vertical)) - preload) / k.
    const perLeg = (v.mp.mass * (MOON_MU / MOON_RADIUS ** 2)) / 4;
    const legDef = defs.parts['heron-landing-legs']!.modules[0]!;
    if (legDef.type !== 'legs') throw new Error('no legs');
    const l0 = legDef.legs[0]!;
    const strut = v3.normalize(v3.sub(v3.fromTuple(l0.hinge), v3.fromTuple(l0.footDeployed)));
    for (const c of legs.compression) expect(c).toBeCloseTo((perLeg / strut.y - l0.preload) / l0.k, 2);
    expect(l0).toMatchObject({ stroke: 0.6, k: 180000, c: 45000, preload: 2000 });

    // 600 s asleep on the rotating body: exactly fixed in the body frame, co-rotating in the inertial one.
    const fixed0 = quat.rotateInv(env.qFixedToInertial, v.r);
    const q0 = quat.mul(quat.conj(env.qFixedToInertial), v.q);
    run(v, env, 600, controls());
    expect(v3.dist(quat.rotateInv(env.qFixedToInertial, v.r), fixed0)).toBeLessThan(1e-6);
    expect(quat.angleBetween(quat.mul(quat.conj(env.qFixedToInertial), v.q), q0)).toBeLessThan(1e-7);
    expect(v3.len(v.v)).toBeCloseTo(spin * v3.len(v.r), 4);
    expect(v.gLoad).toBeCloseTo(MOON_MU / MOON_RADIUS ** 2 / 9.80665, 2);

    // Throttle up (Lyra-D is armed): the vessel wakes and lifts off.
    const h0 = v3.len(v.r);
    setSasEnabled(v, true);
    run(v, env, 6, controls({ throttle: 1 }));
    expect(v.hold).toBeNull();
    expect(v3.len(v.r) - h0).toBeGreaterThan(5);
    expect(v.surface).toBe('none');
    expect(needsIntegration(v, env)).toBe(true);
  });

  it('deploy over 4 s; with the gear up the structure takes the ground and breaks at 3 m/s', () => {
    const env = moonSlope(0);
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 5 });
    v.r = { x: 0, y: env.radius + 400, z: 0 };
    expect(vesselReadouts(v, env).legsDeployed).toBe(false);
    const res = fireNextStage(v, env);
    expect(res.events.some((e) => e.type === 'legsToggled' && e.deployed)).toBe(true);
    run(v, env, 2, controls());
    expect(legState(v)!.deploy).toBeCloseTo(0.5, 2);
    run(v, env, 2.1, controls());
    expect(legState(v)!.deploy).toBe(1);
    // Toggle up again (G key).
    const up = toggleLegs(v, env.ut);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ type: 'legsToggled', deployed: false });
    run(v, env, 4.1, controls());
    expect(legState(v)!.deploy).toBe(0);

    const soft = lander();
    const softLegs = legState(soft)!;
    softLegs.deploy = 0;
    for (const p of soft.parts) for (const rt of p.rt) if (rt.type === 'legs') rt.target = 0;
    const base = Math.min(...structureOf(soft).probes.map((pr) => pr.y - pr.radius));
    soft.r = { x: 0, y: env.radius - base + 0.02, z: 0 };
    soft.v = { x: 0, y: -1, z: 0 };
    const gentle = run(soft, env, 10, controls());
    expect(gentle.events.some((e) => e.type === 'partDestroyed')).toBe(false);
    expect(gentle.events.find((e) => e.type === 'touchdown')).toMatchObject({ surface: 'land' });
    expect(soft.hold).toBe('asleep');

    const hard = lander();
    legState(hard)!.deploy = 0;
    for (const p of hard.parts) for (const rt of p.rt) if (rt.type === 'legs') rt.target = 0;
    hard.r = { x: 0, y: env.radius - base + 0.02, z: 0 };
    hard.v = { x: 0, y: -3, z: 0 };
    const crash = run(hard, env, 3, controls());
    const destroyed = crash.events.filter((e) => e.type === 'partDestroyed').map((e) => (e.type === 'partDestroyed' ? `${e.partId}:${e.cause}` : ''));
    expect(destroyed.some((d) => d.endsWith(':impact'))).toBe(true);
    // The descent tanks still held propellant: they explode.
    expect(crash.events.some((e) => e.type === 'explosion')).toBe(true);
  });
});

describe('water', () => {
  const sea = (height?: (dir: { x: number; y: number; z: number }, ut: number) => number): FakeEnv => makeEnv({ atmosphere: earthAir, terrain: () => -500, ocean: { density: 1025, height } });
  const floating = (env: FakeEnv, tiltDeg: number): Vessel => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 10 });
    for (const m of v.parts[0]!.modules) if (m.type === 'parachute') m.state = 'cut';
    v.r = { x: 0, y: env.radius + 0.3, z: 0 };
    v.q = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, tiltDeg * DEG);
    return v;
  };

  it('the capsule floats upright with about 55 % reserve buoyancy', () => {
    const env = sea();
    const v = floating(env, 0);
    const res = run(v, env, 40, controls());
    expect(res.events.filter((e) => e.type === 'splash')).toHaveLength(1);
    expect(res.events.some((e) => e.type === 'partDestroyed')).toBe(false);
    const volume = structureOf(v).buoyVolume;
    // Archimedes: the submerged fraction equals mass / (rho V).
    expect(v.contact.waterSubmersion).toBeCloseTo(v.mp.mass / (1025 * volume), 2);
    const reserve = 1 - v.contact.waterSubmersion;
    expect(reserve).toBeGreaterThan(0.5);
    expect(reserve).toBeLessThan(0.6);
    expect(tiltFrom(v, UP)).toBeLessThan(12);
    expect(v3.len(v.v)).toBeLessThan(0.01);
    expect(v.surface).toBe('splashed');
    expect(v.hold).toBeNull();
    expect(needsIntegration(v, env)).toBe(true);
    expect(v.gLoad).toBeCloseTo(1, 2);
    console.log(`capsule afloat: reserve buoyancy ${(reserve * 100).toFixed(1)} %, list ${tiltFrom(v, UP).toFixed(1)} deg`);
  });

  it('self-rights from 120 degrees (and from nearly inverted)', () => {
    for (const tilt of [120, 175]) {
      const env = sea();
      const v = floating(env, tilt);
      run(v, env, 40, controls());
      expect(tiltFrom(v, UP), `from ${tilt}`).toBeLessThan(12);
      expect(v3.len(v.w) / DEG).toBeLessThan(0.5);
    }
  });

  it('rides the shared swell', () => {
    const swell = defs.bodies['earth']!.ocean!.swell;
    const g = 9.81;
    const env = sea((dir, ut) => oceanSwellHeight(swell, g, 6371000, dir, ut));
    const v = floating(env, 0);
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let maxError = 0;
    run(v, env, 90, controls(), (t) => {
      if (t < 30) return;
      const alt = v3.len(v.r) - env.radius;
      minAlt = Math.min(minAlt, alt);
      maxAlt = Math.max(maxAlt, alt);
      const dir = quat.rotateInv(env.qFixedToInertial, v3.normalize(v.r));
      maxError = Math.max(maxError, Math.abs(alt + 0.64 - env.ocean!.waterHeight(dir)));
    });
    // The capsule heaves with the waves (several decimetres) and follows the local surface closely.
    expect(maxAlt - minAlt).toBeGreaterThan(0.4);
    expect(maxError).toBeLessThan(0.35);
    expect(tiltFrom(v, UP)).toBeLessThan(25);
  });

  it('splashdown under three mains is survived and cuts the chutes; 15 m/s is not', () => {
    const env = sea();
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 10 });
    v.r = { x: 0, y: env.radius + 30, z: 0 };
    v.v = { x: 0, y: -8, z: 0 };
    let peakG = 0;
    const res = run(v, env, 20, controls(), () => {
      peakG = Math.max(peakG, v.gLoad);
    });
    const splash = res.events.find((e) => e.type === 'splash');
    expect(splash && splash.type === 'splash' ? splash.speed : 0).toBeGreaterThan(7);
    expect(splash && splash.type === 'splash' ? splash.speed : 99).toBeLessThan(9);
    expect(res.events.some((e) => e.type === 'partDestroyed')).toBe(false);
    expect(res.events.filter((e) => e.type === 'chuteCut')).toHaveLength(1);
    expect(v.surface).toBe('splashed');
    expect(v.crewAlive).toBe(true);
    expect(peakG).toBeGreaterThan(1.5);
    expect(peakG).toBeLessThan(10);
    expect(tiltFrom(v, UP)).toBeLessThan(15);

    const env2 = sea();
    const fast = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 10 });
    for (const m of fast.parts[0]!.modules) if (m.type === 'parachute') m.state = 'cut';
    fast.r = { x: 0, y: env2.radius + 3, z: 0 };
    fast.v = { x: 0, y: -15, z: 0 };
    const crash = run(fast, env2, 2, controls());
    expect(crash.events.find((e) => e.type === 'partDestroyed')).toMatchObject({ partId: 'capsule', cause: 'impact' });
    expect(crash.events.some((e) => e.type === 'crewLost')).toBe(true);
    expect(fast.destroyed).toBe(true);
  });

  it('the capsule survives 8 m/s on land but not 11 m/s', () => {
    const land = (speed: number) => {
      const env = makeEnv({ atmosphere: earthAir });
      const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 10 });
      for (const m of v.parts[0]!.modules) if (m.type === 'parachute') m.state = 'cut';
      v.r = { x: 0, y: env.radius + 0.6, z: 0 };
      v.v = { x: 0, y: -speed, z: 0 };
      return { v, res: run(v, env, 8, controls()) };
    };
    const ok = land(8);
    expect(ok.res.events.some((e) => e.type === 'partDestroyed')).toBe(false);
    expect(ok.res.events.find((e) => e.type === 'touchdown')).toMatchObject({ surface: 'land', partId: 'capsule' });
    expect(ok.v.hold).toBe('asleep');
    const bad = land(11);
    expect(bad.res.events.find((e) => e.type === 'partDestroyed')).toMatchObject({ partId: 'capsule', cause: 'impact' });
  });
});
