/**
 * Engines (shared throttle, minimum throttle, spool lag, ignition / shutdown events and counts,
 * flame-out, fixed-burn solids, gimbal servo), propellant flow inside stage groups, and mass properties.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { DEG, G0 } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, computeMassProps, fireNextStage, setSasEnabled, throttleTarget, type Vessel } from '@/sim/vessel';
import { unitInertia } from '@/sim/vessel/massProps';
import type { EngineState } from '@/sim/vessel/types';
import { controls, DT, earthAir, findPart, loadLibrary, makeEnv, run, runAll, VEHICLE } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const engine = (v: Vessel, id: string): EngineState => {
  const m = findPart(v, id).modules.find((x) => x.type === 'engine');
  if (!m || m.type !== 'engine') throw new Error(`no engine on ${id}`);
  return m;
};
const coasting = (fired: number): { v: Vessel; env: ReturnType<typeof makeEnv> } => {
  const env = makeEnv({});
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: fired });
  v.r = { x: 0, y: env.radius + 300000, z: 0 };
  v.v = { x: 7700, y: 0, z: 0 };
  return { v, env };
};

describe('engines', () => {
  it('throttle mapping: lever 0 is off, anything above starts at the minimum throttle', () => {
    const lyraD = defs.parts['lyra-d']!.modules[0]!;
    const atlas = defs.parts['atlas-9m']!.modules[0]!;
    if (lyraD.type !== 'engine' || atlas.type !== 'engine') throw new Error('not engines');
    expect(throttleTarget(lyraD, 0)).toBe(0);
    expect(throttleTarget(lyraD, 1e-6)).toBeCloseTo(0.1, 5);
    expect(throttleTarget(lyraD, 0.5)).toBeCloseTo(0.55, 12);
    expect(throttleTarget(lyraD, 1)).toBe(1);
    expect(throttleTarget(atlas, 0.5)).toBeCloseTo(0.75, 12);
  });

  it('spools with a first-order lag, emits ignition and shutdown events, and counts ignitions', () => {
    const { v, env } = coasting(4);
    // Vela-2V: spool up 0.8 s, down 0.3 s.
    const e = engine(v, 'vela-2v');
    expect(e.active).toBe(true);
    expect(e.ignitionAge).toBe(-1);
    const up = run(v, env, 0.8, controls({ throttle: 1 }));
    expect(e.throttleActual).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(up.events.filter((x) => x.type === 'engineIgnition')).toHaveLength(1);
    expect(e.ignitionAge).toBeGreaterThan(0.7);
    run(v, env, 6, controls({ throttle: 1 }));
    expect(e.throttleActual).toBeGreaterThan(0.999);
    expect(e.thrust).toBeCloseTo(1e6, -3);
    expect(e.massFlow).toBeCloseTo(1e6 / (452 * G0), 1);
    expect(e.pressureRatio).toBe(1e6);
    // Half lever: 60 % + 40 % * 0.5 = 80 %.
    run(v, env, 5, controls({ throttle: 0.5 }));
    expect(e.throttleActual).toBeCloseTo(0.8, 3);
    // Cut: tail-off with tau 0.3 s, then the shutdown event below 1 %.
    const down = run(v, env, 0.3, controls({ throttle: 0 }));
    expect(e.throttleActual).toBeCloseTo(0.8 * Math.exp(-1), 2);
    expect(down.events.filter((x) => x.type === 'engineShutdown')).toHaveLength(0);
    const off = run(v, env, 2, controls({ throttle: 0 }));
    expect(off.events.filter((x) => x.type === 'engineShutdown' && !x.flameout)).toHaveLength(1);
    expect(e.throttleActual).toBe(0);
    expect(e.thrust).toBe(0);
    expect(e.shutdownAge).toBeGreaterThan(0.5);
    // Restartable without limit.
    expect(e.ignitionsLeft).toBeNull();
    const again = run(v, env, 1, controls({ throttle: 1 }));
    expect(again.events.filter((x) => x.type === 'engineIgnition')).toHaveLength(1);
  });

  it('an engine out of ignitions does not relight', () => {
    const { v, env } = coasting(2);
    const e = engine(v, 'vela-2-1');
    expect(e.ignitionsLeft).toBe(3);
    for (let k = 0; k < 3; k++) {
      run(v, env, 2, controls({ throttle: 1 }));
      expect(e.thrust).toBeGreaterThan(5e5);
      run(v, env, 3, controls({ throttle: 0 }));
      expect(e.thrust).toBe(0);
    }
    expect(e.ignitionsLeft).toBe(0);
    const res = run(v, env, 3, controls({ throttle: 1 }));
    expect(res.events.some((x) => x.type === 'engineIgnition')).toBe(false);
    expect(e.thrust).toBe(0);
    expect(v.thrust).toBe(0);
  });

  it('thrust and ambient pressure are reported; exit pressure ratio falls with throttle', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 12000, z: 0 };
    v.v = { x: 0, y: 300, z: 0 };
    run(v, env, 8, controls({ throttle: 1 }));
    const e = engine(v, 'atlas-1');
    const p = env.atmosphereAt(v3.len(v.r) - env.radius - 97).pressure;
    expect(e.ambientPressure).toBeGreaterThan(0);
    expect(Math.abs(e.ambientPressure - p) / p).toBeLessThan(0.05);
    const isp = 350 - (350 - 327) * (e.ambientPressure / 101325);
    expect(e.thrust / e.throttleActual).toBeCloseTo((4174000 / 350) * isp, -2);
    expect(e.throttleActual).toBeGreaterThan(0.99);
    expect(e.pressureRatio).toBeCloseTo(70000 / e.ambientPressure, 1);
    expect(v.thrust).toBeCloseTo(9 * e.thrust, -3);
  });

  it('M-1 burns for 161 s at full throttle and flames out with both tanks empty', () => {
    const { v, env } = coasting(1);
    setSasEnabled(v, true);
    const events: SimEvent[] = [];
    let burn = 0;
    let peakG = 0;
    for (let t = 0; t < 175 && burn === 0; t += 1) {
      const res = run(v, env, 1, controls({ throttle: 1 }));
      events.push(...res.events);
      peakG = Math.max(peakG, v.gLoad);
      if (res.events.some((e) => e.type === 'engineShutdown')) burn = t + 1;
    }
    // 1.2 s spool-up delays the full flow slightly.
    expect(burn).toBeGreaterThanOrEqual(161);
    expect(burn).toBeLessThanOrEqual(164);
    const outs = events.filter((e) => e.type === 'engineShutdown');
    expect(outs).toHaveLength(9);
    expect(outs.every((e) => e.type === 'engineShutdown' && e.flameout)).toBe(true);
    const m1 = findPart(v, 'm1');
    expect(m1.resources[0]!).toBeLessThan(1);
    expect(m1.resources[1]!).toBeLessThan(1);
    // No cross-feed: M-2 is untouched.
    const m2 = findPart(v, 'm2');
    expect(m2.resources).toEqual(m2.def.resources!.map((r) => r.capacity));
    expect(engine(v, 'atlas-5').flameout).toBe(true);
    // Burnout acceleration 3.85 g (sim-design 10.2): 37.57 MN on 996 t.
    expect(peakG).toBeGreaterThan(3.7);
    expect(peakG).toBeLessThan(3.95);
    expect(v.mp.mass).toBeCloseTo(996100, -2);
  });

  it('solid motors burn for their fixed time whatever the throttle', () => {
    const { v, env } = coasting(1);
    // M-1 at burnout.
    findPart(v, 'm1').resources = [0, 0];
    const vessels = [v];
    const res = fireNextStage(v, env);
    expect(res.ok).toBe(true);
    const events = runAll(vessels, env, 8, controls({ throttle: 0 }));
    const ullage = engine(v, 'm2-ullage');
    const ign = events.filter((e) => e.type === 'engineIgnition').map((e) => (e.type === 'engineIgnition' ? e.partId : ''));
    expect(ign).toContain('m2-ullage');
    expect(ign).toContain('m1-retro');
    // Vela-2 are armed but the lever is at zero.
    expect(engine(v, 'vela-2-3').active).toBe(true);
    expect(engine(v, 'vela-2-3').thrust).toBe(0);
    expect(ullage.thrust).toBe(0);
    expect(findPart(v, 'm2-ullage').resources[0]!).toBeLessThan(2);
    const retro = vessels[1]!;
    expect(findPart(retro, 'm1-retro').resources[0]!).toBeLessThan(5);
    // The retro pack (8 x 180 kN for 0.7 s, canted 12 degrees) slows the 150 t spent stage by about 6.5 m/s;
    // the spring adds 1.2 m/s of relative speed and the ullage motors push the upper stack 1.9 m/s forward.
    const axial = v3.dot(v3.sub(v.v, retro.v), { x: 0, y: 1, z: 0 });
    expect(axial).toBeGreaterThan(8.5);
    expect(axial).toBeLessThan(10.5);
  });

  it('gimbals slew at 20 deg/s to the commanded deflection and return when the input is released', () => {
    const { v, env } = coasting(5);
    run(v, env, 2, controls({ throttle: 1 }));
    const e = engine(v, 'lyra-d');
    run(v, env, 0.1, controls({ throttle: 1, yaw: 1 }));
    expect(Math.abs(e.gimbal[1])).toBeCloseTo(0.1 * 20 * DEG, 2);
    run(v, env, 0.5, controls({ throttle: 1, yaw: 1 }));
    expect(Math.abs(e.gimbal[1])).toBeCloseTo(6 * DEG, 4);
    expect(Math.abs(e.gimbal[0])).toBeLessThan(1e-9);
    run(v, env, 1, controls({ throttle: 1 }));
    expect(Math.abs(e.gimbal[1])).toBeLessThan(1e-9);
  });

  it('nine gimballed engines give roll authority by differential deflection', () => {
    const { v, env } = coasting(1);
    run(v, env, 4, controls({ throttle: 1 }));
    expect(v.authority[1]).toBeGreaterThan(5e6);
    run(v, env, 3, controls({ throttle: 1, roll: 1 }));
    expect(v.w.y).toBeGreaterThan(0.2);
    // The centre engine cannot help with roll and stays straight; ring engines deflect tangentially.
    expect(Math.hypot(...engine(v, 'atlas-1').gimbal)).toBeLessThan(1e-3 * DEG);
    expect(Math.hypot(...engine(v, 'atlas-2').gimbal)).toBeCloseTo(6 * DEG, 3);
    expect(Math.abs(v.w.x) + Math.abs(v.w.z)).toBeLessThan(0.01);
  });
});

describe('mass properties', () => {
  it('inertia shapes follow sim-design 6.2', () => {
    expect(unitInertia({ kind: 'solidCylinder', r: 2, h: 6 })).toEqual([(3 * 4 + 36) / 12, 2, (3 * 4 + 36) / 12]);
    expect(unitInertia({ kind: 'shellCylinder', r: 2, h: 6 })).toEqual([(6 * 4 + 36) / 12, 4, (6 * 4 + 36) / 12]);
    const cone = unitInertia({ kind: 'cone', r: 2, h: 4 });
    expect(cone[0]).toBeCloseTo((3 * 4) / 20 + (3 * 16) / 80, 12);
    expect(cone[1]).toBeCloseTo((3 * 4) / 10, 12);
    expect(unitInertia({ kind: 'sphere', r: 3 })[0]).toBeCloseTo(3.6, 12);
    expect(unitInertia({ kind: 'box', size: [1, 2, 3] })).toEqual([(4 + 9) / 12, (1 + 9) / 12, (1 + 4) / 12]);
  });

  it('a single part reproduces its shape; the parallel-axis term appears with a second part', () => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
    // Capsule + apex cover, RCS and ablator on board.
    computeMassProps(v);
    expect(v.mp.mass).toBeCloseTo(5000, 6);
    const cap = defs.parts['kestrel-capsule']!;
    // Roll inertia: both parts are bodies of revolution about Y, the capsule dry mass is offset in z.
    const capIy = 4590 * (1.75 * 1.75) / 2;
    expect(v.mp.i[1]).toBeGreaterThan(capIy);
    expect(v.mp.i[1]).toBeLessThan(capIy * 1.2);
    expect(v.mp.com.z).toBeCloseTo((4590 * cap.comOffset[2]) / 5000, 9);
    expect(v.mp.com.x).toBeCloseTo(0, 12);
    // Inverse really is the inverse.
    const I = v.mp.i;
    const J = v.mp.inv;
    const xx = I[0] * J[0] + I[3] * J[3] + I[4] * J[4];
    const xy = I[0] * J[3] + I[3] * J[1] + I[4] * J[5];
    expect(xx).toBeCloseTo(1, 12);
    expect(xy).toBeCloseTo(0, 12);
  });

  it('the centre of mass moves as tanks drain and the stack inertia is that of a 100 m rod-like body', () => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    computeMassProps(v);
    const full = v.mp.com.y;
    const ixFull = v.mp.i[0];
    expect(ixFull).toBeGreaterThan(5e8);
    expect(ixFull).toBeLessThan(3e9);
    expect(v.mp.i[1]).toBeLessThan(ixFull / 20);
    // Propellant settles at the bottom of its tank: half-full tanks put the propellant CoM a quarter up.
    const m1 = findPart(v, 'm1');
    m1.resources = m1.resources.map((x) => x / 2);
    computeMassProps(v);
    expect(v.mp.com.y).not.toBeCloseTo(full, 1);
    const res = m1.def.resources![1]!;
    const loxCom = m1.pos.y + res.tankBottomY + res.tankHeight / 4;
    // Remove everything but the LOX to isolate its position.
    const before = v.mp.mass * v.mp.com.y;
    m1.resources[1] = 0;
    computeMassProps(v);
    const after = v.mp.mass * v.mp.com.y;
    expect((before - after) / (res.capacity / 2)).toBeCloseTo(loxCom, 6);
    // Empty M-1: the CoM sits high in the stack.
    m1.resources = [0, 0];
    computeMassProps(v);
    expect(v.mp.com.y).toBeGreaterThan(full + 12);
    expect(v.mp.mass).toBeCloseTo(996100, 3);
  });

  it('unreleased launch clamps carry no flight mass', () => {
    const v = assembleVessel(defs, VEHICLE);
    computeMassProps(v);
    const clamps = v.parts.filter((p) => p.def.id === 'meridian-launch-clamp');
    expect(clamps).toHaveLength(4);
    expect(v.mp.mass).toBeCloseTo(2756100, 3);
    expect(DT).toBeCloseTo(1 / 120, 12);
  });
});
