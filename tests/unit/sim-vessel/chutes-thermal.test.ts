/**
 * Parachutes (terminal velocities, reefing, envelopes, destruction) and the aerothermal model
 * (Sutton-Graves and radiative flux against hand-computed values, exposure, wake shielding, ablation,
 * overheating).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AtmosphereHeatingDef, DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { STEFAN_BOLTZMANN } from '@/sim/dynamics/thermal';
import { assembleVessel, chuteEnvelope, convectiveFlux, fireNextStage, inflationAt, nextChuteEnvelope, radiativeFlux, stagnationFlux, vesselReadouts, type Vessel } from '@/sim/vessel';
import type { ParachuteDef } from '@/sim/vessel/types';
import { controls, DT, loadLibrary, makeEnv, run, runAll, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
let heating: AtmosphereHeatingDef;
let drogue: ParachuteDef;
let main: ParachuteDef;
beforeAll(async () => {
  defs = await loadLibrary();
  heating = defs.bodies['earth']!.atmosphere!.heating;
  const chutes = defs.parts['kestrel-capsule']!.modules.filter((m) => m.type === 'parachute') as ParachuteDef[];
  drogue = chutes.find((c) => c.mode === 'drogue')!;
  main = chutes.find((c) => c.mode === 'main')!;
});

/** Uniform sea-level air (density 1.225 kg/m^3 at every altitude). */
const seaLevelAir = (): FakeEnv => makeEnv({ atmosphere: { rho0: 1.225, scaleHeight: 1e12, temperature: 288.15, top: 1e9 } });

function capsule(env: FakeEnv, fired: number, altitude: number, speedDown: number): Vessel {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: fired });
  v.r = { x: 0, y: env.radius + altitude, z: 0 };
  v.v = { x: 0, y: -speedDown, z: 0 };
  return v;
}

describe('parachutes', () => {
  it('terminal velocity 7.9 m/s on three mains and 9.7 m/s on two at sea-level density', () => {
    const env = seaLevelAir();
    const three = capsule(env, 10, 3000, 12);
    run(three, env, 60, controls());
    expect(v3.len(three.aero.airVelocity)).toBeGreaterThan(7.6);
    expect(v3.len(three.aero.airVelocity)).toBeLessThan(8.2);
    // Hanging shield-down, steady, at 1 g.
    expect(three.aero.aoa / DEG).toBeGreaterThan(165);
    expect(three.gLoad).toBeCloseTo(1, 1);

    const env2 = seaLevelAir();
    const two = capsule(env2, 10, 3000, 12);
    const rt = two.parts[0]!.rt.find((r, i) => r.type === 'parachute' && two.parts[0]!.def.modules[i] === main);
    if (!rt || rt.type !== 'parachute') throw new Error('no main chute');
    rt.canopies = 2;
    run(two, env2, 60, controls());
    expect(v3.len(two.aero.airVelocity)).toBeGreaterThan(9.4);
    expect(v3.len(two.aero.airVelocity)).toBeLessThan(10.0);
    // Hand value: v = sqrt(2 m g / (rho (n CdA + Cd A_capsule))).
    const g = env.mu / (env.radius + 2500) ** 2;
    const hand = (n: number): number => Math.sqrt((2 * three.mp.mass * g) / (1.225 * (n * 420 + 0.9 * Math.PI * 4)));
    expect(v3.len(three.aero.airVelocity)).toBeCloseTo(hand(3), 1);
    expect(v3.len(two.aero.airVelocity)).toBeCloseTo(hand(2), 1);
  });

  it('reefing schedule: drogues 40 % for 4 s then full in 1.5 s; mains 8 %, 30 %, then full in 3 s', () => {
    expect(inflationAt(drogue, 0)).toBe(0);
    expect(inflationAt(drogue, 2)).toBeCloseTo(0.4, 9);
    expect(inflationAt(drogue, 3.99)).toBeCloseTo(0.4, 9);
    expect(inflationAt(drogue, 4.75)).toBeCloseTo(0.7, 9);
    expect(inflationAt(drogue, 5.5)).toBe(1);
    expect(inflationAt(main, 3)).toBeCloseTo(0.08, 9);
    expect(inflationAt(main, 9)).toBeCloseTo(0.3, 9);
    expect(inflationAt(main, 13.5)).toBeCloseTo(0.65, 9);
    expect(inflationAt(main, 15)).toBe(1);
    // Monotonic.
    let prev = 0;
    for (let t = 0; t <= 16; t += 0.05) {
      const f = inflationAt(main, t);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f;
    }
    expect(drogue.count).toBe(2);
    expect(main.count).toBe(3);
    expect(drogue.cdAFull).toBe(20);
    expect(main.cdAFull).toBe(420);
  });

  it('envelope lights follow sim-design 10.4', () => {
    expect(chuteEnvelope(drogue, 9000, 0.6, 180, 6000)).toBe('safe');
    expect(chuteEnvelope(drogue, 13000, 0.6, 180, 6000)).toBe('risky');
    expect(chuteEnvelope(drogue, 9000, 0.95, 280, 6000)).toBe('risky');
    expect(chuteEnvelope(drogue, 9000, 0.6, 180, 12000)).toBe('risky');
    expect(chuteEnvelope(drogue, 9000, 1.25, 380, 6000)).toBe('unsafe');
    expect(chuteEnvelope(drogue, 9000, 0.6, 180, 15000)).toBe('unsafe');
    expect(chuteEnvelope(main, 3000, 0.2, 60, 1500)).toBe('safe');
    expect(chuteEnvelope(main, 5000, 0.2, 60, 1500)).toBe('risky');
    expect(chuteEnvelope(main, 3000, 0.3, 100, 1500)).toBe('risky');
    expect(chuteEnvelope(main, 3000, 0.4, 135, 1500)).toBe('unsafe');
    expect(chuteEnvelope(main, 3000, 0.2, 60, 4600)).toBe('unsafe');
  });

  it('a drogue deployed at Mach 1.5 is torn away; one deployed in the envelope holds', () => {
    const env = makeEnv({ atmosphere: { rho0: 1.225, scaleHeight: 7200, temperature: 250 } });
    const fast = capsule(env, 8, 20000, 480);
    run(fast, env, 0.5, controls());
    expect(fast.aero.mach).toBeGreaterThan(1.3);
    expect(nextChuteEnvelope(fast, env)).toBe('unsafe');
    expect(vesselReadouts(fast, env).chuteEnvelope).toBe('unsafe');
    const events: SimEvent[] = [...fireNextStage(fast, env).events];
    events.push(...run(fast, env, 2, controls()).events);
    expect(events.some((e) => e.type === 'chuteDeployed')).toBe(true);
    expect(events.some((e) => e.type === 'chuteFailed')).toBe(true);
    expect(fast.parts[0]!.modules.find((m) => m.type === 'parachute')).toMatchObject({ state: 'failed', inflation: 0 });

    const env2 = makeEnv({ atmosphere: { rho0: 1.225, scaleHeight: 7200, temperature: 250 } });
    const ok = capsule(env2, 8, 7000, 110);
    run(ok, env2, 2, controls());
    expect(nextChuteEnvelope(ok, env2)).toBe('safe');
    const vessels = [ok];
    const res = fireNextStage(ok, env2);
    vessels.push(...res.spawned);
    let peakG = 0;
    const ev = runAll(vessels, env2, 12, controls(), () => {
      peakG = Math.max(peakG, ok.gLoad);
    });
    expect(ev.some((e) => e.type === 'chuteFailed')).toBe(false);
    expect(ev.some((e) => e.type === 'chuteInflated')).toBe(true);
    const chute = ok.parts[0]!.modules.find((m) => m.type === 'parachute');
    if (!chute || chute.type !== 'parachute') throw new Error('no chute');
    // The canopy trails the airflow: straight up for a capsule falling shield-down.
    expect(chute.lineDir.y).toBeGreaterThan(0.95);
    expect(peakG).toBeGreaterThan(1.5);
    expect(peakG).toBeLessThan(6);
    expect(v3.len(ok.aero.airVelocity)).toBeLessThan(75);
  });

  it('mains deployed too fast rip off; a main riding past its limit fails too', () => {
    const env = makeEnv({ atmosphere: { rho0: 1.225, scaleHeight: 7200, temperature: 250 } });
    const v = capsule(env, 9, 3000, 150);
    // Cut the (instantly deployed) drogues so the capsule keeps its speed.
    for (const m of v.parts[0]!.modules) if (m.type === 'parachute' && m.state === 'full') m.state = 'cut';
    run(v, env, 0.3, controls());
    expect(v3.len(v.aero.airVelocity)).toBeGreaterThan(130);
    const ev: SimEvent[] = [...fireNextStage(v, env).events];
    ev.push(...run(v, env, 2, controls()).events);
    expect(ev.filter((e) => e.type === 'chuteFailed')).toHaveLength(1);
    const mains = v.parts[0]!.modules.filter((m) => m.type === 'parachute')[1];
    expect(mains).toMatchObject({ state: 'failed' });
  });
});

describe('aerothermal flux', () => {
  it('Sutton-Graves matches the hand-computed value', () => {
    // 1.7415e-4 * sqrt(3e-4 / 4.8) * 7000^3 = 1.7415e-4 * 7.90569e-3 * 3.43e11
    expect(convectiveFlux(heating, 3e-4, 7000, 4.8)).toBeCloseTo(1.7415e-4 * Math.sqrt(3e-4 / 4.8) * 7000 ** 3, 3);
    expect(convectiveFlux(heating, 3e-4, 7000, 4.8) / 472236).toBeCloseTo(1, 3);
    // A smaller nose is hotter by 1/sqrt(Rn); in vacuum nothing.
    expect(convectiveFlux(heating, 3e-4, 7000, 1.2) / convectiveFlux(heating, 3e-4, 7000, 4.8)).toBeCloseTo(2, 9);
    expect(convectiveFlux(heating, 0, 7000, 4.8)).toBe(0);
  });

  it('the radiative term matches the hand-computed value and vanishes below 9 km/s', () => {
    // a = min(1, 1.072e6 * 11000^-1.88 * (3e-4)^-0.325) = 0.3771
    const a = Math.min(1, 1.072e6 * Math.pow(11000, -1.88) * Math.pow(3e-4, -0.325));
    expect(a).toBeCloseTo(0.377, 2);
    // q = 0.5 * 4.736e8 * 4.8^a * (3e-4)^1.22 * f(11000 m/s) with f = 151
    const hand = 0.5 * 4.736e8 * Math.pow(4.8, a) * Math.pow(3e-4, 1.22) * 151;
    expect(hand / 3.25e6).toBeGreaterThan(0.97);
    expect(hand / 3.25e6).toBeLessThan(1.03);
    expect(radiativeFlux(heating, 3e-4, 11000, 4.8)).toBeCloseTo(hand, 3);
    // Table interpolation between 10 000 (35) and 10 250 (55).
    const mid = 0.5 * 4.736e8 * Math.pow(4.8, Math.min(1, 1.072e6 * Math.pow(10100, -1.88) * Math.pow(1e-4, -0.325))) * Math.pow(1e-4, 1.22) * 43;
    expect(radiativeFlux(heating, 1e-4, 10100, 4.8)).toBeCloseTo(mid, 3);
    expect(radiativeFlux(heating, 3e-4, 8999, 4.8)).toBe(0);
    expect(stagnationFlux(heating, 3e-4, 11000, 4.8)).toBeCloseTo(convectiveFlux(heating, 3e-4, 11000, 4.8) + hand, 3);
  });
});

describe('heating of a vessel', () => {
  // Uniform thin air so that the flux is steady: rho = 3e-4 kg/m^3 everywhere.
  const thinAir = (): FakeEnv => makeEnv({ mu: 1, atmosphere: { rho0: 3e-4, scaleHeight: 1e12, temperature: 220, top: 1e9 }, heating });

  it('shield-first the ablator chars away at the modelled rate while the structure stays cool', () => {
    const env = thinAir();
    const v = capsule(env, 8, 60000, 0);
    // Flying along +X at 7 km/s with the shield (-Y) leading; gravity is negligible in this environment.
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG);
    v.v = { x: 7000, y: 0, z: 0 };
    const shieldDef = defs.parts['kestrel-capsule']!.modules.find((m) => m.type === 'heatShield');
    if (!shieldDef || shieldDef.type !== 'heatShield') throw new Error('no shield');
    const ablator0 = v.parts[0]!.resources[1]!;
    run(v, env, 0.05, controls());
    const flux = v.aero.heatFlux;
    // Stagnation flux on the shield at its actual angle to the flow (the capsule starts at zero incidence).
    expect(flux / convectiveFlux(heating, 3e-4, v3.len(v.aero.airVelocity), 4.8)).toBeGreaterThan(0.93);
    expect(v.aero.plasmaIntensity).toBeGreaterThan(0.2);
    const t0 = v.parts[0]!.temps[0]!;
    const a0 = v.parts[0]!.resources[1]!;
    // dm = area (q - qThreshold) / Heff, integrated with the flux of every step (it varies as the capsule
    // swings about its trim angle and decelerates).
    let expected = 0;
    let fluxSum = 0;
    let steps = 0;
    run(v, env, 1, controls(), () => {
      expected += (shieldDef.area * (v.aero.heatFlux - shieldDef.qThreshold) * DT) / shieldDef.heff;
      fluxSum += v.aero.heatFlux;
      steps++;
    });
    const burned = a0 - v.parts[0]!.resources[1]!;
    expect(burned).toBeGreaterThan(0.1);
    expect(burned / expected).toBeGreaterThan(0.99);
    expect(burned / expected).toBeLessThan(1.01);
    expect(ablator0).toBe(200);
    const state = v.parts[0]!.modules.find((m) => m.type === 'heatShield');
    if (!state || state.type !== 'heatShield') throw new Error('no shield state');
    expect(state.ablatorFraction).toBeCloseTo(v.parts[0]!.resources[1]! / 200, 9);
    // Char surface near radiative equilibrium, substrate heated by 2 % of the flux only.
    const tEq = Math.pow(v.aero.heatFlux / (0.85 * STEFAN_BOLTZMANN), 0.25);
    expect(state.surfaceTemp / tEq).toBeGreaterThan(0.97);
    expect(state.surfaceTemp).toBeLessThanOrEqual(3100);
    const rise = v.parts[0]!.temps[0]! - t0;
    expect(rise).toBeGreaterThan(0.2);
    expect(rise).toBeLessThan(((0.02 * fluxSum) / steps / 20000) * 1.05);
    expect(flux).toBeGreaterThan(4e5);
    // The back shell sits in the wake of the shield: hardly heated.
    expect(v.parts[0]!.temps[1]!).toBeLessThan(320);
    expect(vesselReadouts(v, env).ablatorFraction).toBeCloseTo(state.ablatorFraction, 12);
  });

  it('without ablator the shield burns through', () => {
    const env = thinAir();
    const v = capsule(env, 8, 60000, 0);
    v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG);
    // Lunar-return speed: about 2 MW/m^2 on a bare substrate of 20 kJ/m^2K with a 1 400 K limit.
    v.v = { x: 10000, y: 0, z: 0 };
    v.parts[0]!.resources[1] = 0;
    const res = run(v, env, 30, controls());
    expect(v.age).toBeGreaterThan(5);
    expect(v.age).toBeLessThan(25);
    const destroyed = res.events.find((e) => e.type === 'partDestroyed');
    expect(destroyed).toMatchObject({ partId: 'capsule', cause: 'overheat' });
    expect(res.events.some((e) => e.type === 'crewLost')).toBe(true);
    expect(v.crewAlive).toBe(false);
  });

  it('apex-first entry destroys the capsule; overheating destroys an unshielded lander but not one inside the fairing', () => {
    const env = thinAir();
    // Apex-first the back shell takes the stagnation flux of its own, smaller nose radius (the capsule is
    // monostable and turns shield-first within seconds, so only the first half second is examined).
    const apex = capsule(env, 8, 60000, 0);
    apex.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, -90 * DEG);
    apex.v = { x: 7000, y: 0, z: 0 };
    run(apex, env, 0.5, controls());
    const backShellRate = (apex.parts[0]!.temps[1]! - 290) / 0.5;
    expect(backShellRate).toBeGreaterThan(0.9 * (convectiveFlux(heating, 3e-4, 7000, 2.0) / 14000) * 0.9);
    expect(apex.aero.heatFlux).toBeGreaterThan(6e5);

    // Lander stack flying nose-first with the fairing gone (stage 3 fired, M-2 still attached).
    const env2 = thinAir();
    const bare = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 3 });
    bare.r = { x: 0, y: env2.radius + 60000, z: 0 };
    bare.v = { x: 0, y: 5000, z: 0 };
    const vessels = [bare];
    const ev = runAll(vessels, env2, 14, controls());
    const lost = ev.filter((e) => e.type === 'partDestroyed' && e.cause === 'overheat').map((e) => (e.type === 'partDestroyed' ? e.partId : ''));
    expect(lost).toContain('descent-stage');

    // Same flight with the fairing on: the lander inside does not heat at all.
    const env3 = thinAir();
    const covered = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 });
    covered.r = { x: 0, y: env3.radius + 60000, z: 0 };
    covered.v = { x: 0, y: 5000, z: 0 };
    const t0 = covered.parts.find((p) => p.instanceId === 'descent-stage')!.temps[0]!;
    const fairing0 = covered.parts.find((p) => p.instanceId === 'fairing')!.temps[0]!;
    run(covered, env3, 4, controls());
    const descent = covered.parts.find((p) => p.instanceId === 'descent-stage');
    expect(descent).toBeDefined();
    expect(descent!.shielded).toBe(true);
    expect(descent!.temps[0]! - t0).toBeLessThan(1);
    expect(covered.parts.find((p) => p.instanceId === 'fairing')!.temps[0]! - fairing0).toBeGreaterThan(20);
    // Stack shadowing: M-1's engines ride in the wake of the stack, M-2's shoulder does not exist here (M-1 gone).
    const vela = covered.parts.find((p) => p.instanceId === 'vela-2-1')!;
    expect(vela.temps[0]! - 290).toBeLessThan(5);
  });

  it('parts radiate to their environment and plasma intensity follows the flux', () => {
    const env = makeEnv({ heating });
    const v = capsule(env, 8, 400000, 0);
    v.v = { x: 7600, y: 0, z: 0 };
    v.parts[0]!.temps[1] = 900;
    run(v, env, 5, controls());
    // 14 kJ/m^2K at 900 K with emissivity 0.85: about 2.2 K/s.
    const expected = (0.85 * STEFAN_BOLTZMANN * (900 ** 4 - 254 ** 4)) / 14000;
    expect((900 - v.parts[0]!.temps[1]!) / 5).toBeGreaterThan(0.9 * expected * 0.95);
    expect((900 - v.parts[0]!.temps[1]!) / 5).toBeLessThan(expected * 1.01);
    expect(v.aero.heatFlux).toBe(0);
    expect(v.aero.plasmaIntensity).toBe(0);
    expect(vesselReadouts(v, env).maxTempFraction).toBeGreaterThan(0.4);
  });
});
