/**
 * Staging: the ten stages fire in order with their documented events, vessels and debris; momentum is
 * conserved at every split; launch clamps hold until the thrust check passes; the abort sequence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, StageAction } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { abort, assembleVessel, computeMassProps, fireNextStage, needsIntegration, nextLiveStage, stagingInfo, type Vessel } from '@/sim/vessel';
import { executeAction } from '@/sim/vessel/staging';
import type { StepContext } from '@/sim/vessel/types';
import { controls, DT, earthAir, loadLibrary, makeEnv, momentum, placeUpright, run, runAll, VEHICLE } from './helpers';
import { stageScenario } from './scenarios';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const count = (events: SimEvent[], type: SimEvent['type']): number => events.filter((e) => e.type === type).length;
const ids = (v: Vessel): string[] => v.parts.map((p) => p.instanceId).sort();

describe('launch clamps', () => {
  it('hold the vehicle on the rotating pad and release only above the thrust threshold', () => {
    const env = makeEnv({ atmosphere: earthAir, spinRate: 7.2921159e-5 });
    const v = assembleVessel(defs, VEHICLE);
    placeUpright(v, env, 120);
    expect(v.hold).toBe('clamps');
    expect(needsIntegration(v, env)).toBe(false);
    const r0 = quat.rotateInv(env.qFixedToInertial, v.r);
    run(v, env, 5, controls());
    // Rides the body: same body-fixed position, inertial speed = spin x r.
    const r1 = quat.rotateInv(env.qFixedToInertial, v.r);
    expect(v3.dist(r0, r1)).toBeLessThan(1e-6);
    expect(v3.len(v.v)).toBeCloseTo(7.2921159e-5 * (env.radius + 120), 6);
    expect(v.surface).toBe('prelaunch');
    expect(v.gLoad).toBeGreaterThan(0.95);

    // Throttle at 50 %: 9 engines at 75 % give 26 MN, below 1.1 x weight -> pad abort, clamps stay closed.
    let res = fireNextStage(v, env);
    expect(res.ok).toBe(true);
    expect(needsIntegration(v, env)).toBe(true);
    const low = run(v, env, 4, controls({ throttle: 0.5 }));
    expect(count(low.events, 'engineIgnition')).toBe(9);
    expect(count(low.events, 'clampsReleased')).toBe(0);
    expect(low.spawned).toHaveLength(0);
    expect(v.hold).toBe('clamps');
    expect(v.nextStage).toBe(0);
    const down = run(v, env, 3, controls({ throttle: 0.5 }));
    expect(count(down.events, 'engineShutdown')).toBe(9);
    expect(v.thrust).toBe(0);

    // Full throttle: release 3 s after the press, at 1.30 g.
    res = fireNextStage(v, env);
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual(['stageFired']);
    const early = run(v, env, 2.9, controls({ throttle: 1 }));
    expect(count(early.events, 'clampsReleased')).toBe(0);
    expect(v.hold).toBe('clamps');
    const go = run(v, env, 0.2, controls({ throttle: 1 }));
    expect(count(go.events, 'clampsReleased')).toBe(1);
    expect(v.hold).toBeNull();
    expect(go.spawned).toHaveLength(1);
    const clamps = go.spawned[0]!;
    expect(ids(clamps)).toEqual(['clamp-1', 'clamp-2', 'clamp-3', 'clamp-4']);
    expect(clamps.hold).toBe('ground');
    expect(clamps.surface).toBe('landed');
    expect(needsIntegration(clamps, env)).toBe(false);
    // Two ignitions used on every booster engine.
    for (const p of v.parts) if (p.def.id === 'atlas-9m') expect(p.modules[0]).toMatchObject({ ignitionsLeft: 1 });
    const vessels = [v, clamps];
    const padFixed = quat.rotateInv(env.qFixedToInertial, clamps.r);
    runAll(vessels, env, 6, controls({ throttle: 1 }));
    expect(v3.len(v.r) - env.radius).toBeGreaterThan(150);
    expect(v.gLoad).toBeGreaterThan(1.28);
    expect(v.gLoad).toBeLessThan(1.4);
    expect(v3.dist(quat.rotateInv(env.qFixedToInertial, clamps.r), padFixed)).toBeLessThan(1e-6);
  });

  it('refuses a second press inside the 0.5 s lockout', () => {
    const env = makeEnv({});
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 5 });
    placeUpright(v, env, 200000);
    expect(fireNextStage(v, env).ok).toBe(true);
    const again = fireNextStage(v, env);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/lock/i);
    run(v, env, 0.6, controls());
    expect(v.stageLockout).toBe(0);
  });
});

describe('the ten stages', () => {
  const expected: { label: string; spawned: string[][]; check: (events: SimEvent[], main: Vessel, all: Vessel[]) => void }[] = [
    {
      label: 'Launch',
      spawned: [['clamp-1', 'clamp-2', 'clamp-3', 'clamp-4']],
      check: (ev) => {
        expect(count(ev, 'engineIgnition')).toBe(9);
        expect(count(ev, 'clampsReleased')).toBe(1);
      },
    },
    {
      label: 'M-1 separation',
      spawned: [['atlas-1', 'atlas-2', 'atlas-3', 'atlas-4', 'atlas-5', 'atlas-6', 'atlas-7', 'atlas-8', 'atlas-9', 'interstage-1', 'm1', 'm1-retro']],
      check: (ev, main) => {
        expect(count(ev, 'engineShutdown')).toBeGreaterThanOrEqual(9);
        expect(ev.filter((e) => e.type === 'decoupled' && e.partId === 'interstage-1')).toHaveLength(1);
        const ign = ev.filter((e) => e.type === 'engineIgnition').map((e) => (e.type === 'engineIgnition' ? e.partId : ''));
        expect(ign).toContain('m2-ullage');
        expect(ign).toContain('m1-retro');
        expect(ign.filter((x) => x.startsWith('vela-2-'))).toHaveLength(6);
        expect(main.thrust).toBeGreaterThan(6.5e6);
      },
    },
    {
      label: 'Tower + fairing jettison',
      spawned: [['les', 'les-jettison-motor'], ['fairing#panel0'], ['fairing#panel1'], ['fairing#panel2'], ['fairing#panel3']],
      check: (ev, main) => {
        expect(ev.filter((e) => e.type === 'decoupled' && e.partId === 'les')).toHaveLength(1);
        const f = ev.find((e) => e.type === 'fairingJettisoned');
        expect(f && f.type === 'fairingJettisoned' ? f.newVesselIds : []).toHaveLength(4);
        expect(ev.some((e) => e.type === 'engineIgnition' && e.partId === 'les-jettison-motor')).toBe(true);
        // The lander is no longer shielded.
        expect(main.parts.find((p) => p.instanceId === 'descent-stage')!.shielded).toBe(false);
        expect(main.parts.find((p) => p.instanceId === 'capsule')!.shielded).toBe(false);
      },
    },
    {
      label: 'M-2 separation',
      spawned: [['interstage-2', 'm2', 'm2-ullage', 'vela-2-1', 'vela-2-2', 'vela-2-3', 'vela-2-4', 'vela-2-5', 'vela-2-6']],
      check: (ev, main) => {
        expect(count(ev, 'engineShutdown')).toBe(6);
        expect(ev.some((e) => e.type === 'decoupled' && e.partId === 'interstage-2')).toBe(true);
        expect(ev.some((e) => e.type === 'engineIgnition' && e.partId === 'vela-2v')).toBe(true);
        expect(main.thrust).toBeGreaterThan(0.99e6);
        expect(main.rcsEnabled).toBe(true);
      },
    },
    {
      label: 'M-3 separation',
      spawned: [['m3', 'm3-rcs-pod-a', 'm3-rcs-pod-b', 'payload-adapter', 'vela-2v']],
      check: (ev, main, all) => {
        expect(ev.some((e) => e.type === 'decoupled' && e.partId === 'payload-adapter')).toBe(true);
        // Retro-evasion burn of the two pods on the spent stage.
        expect(ev.filter((e) => e.type === 'engineIgnition' && e.partId.startsWith('m3-rcs-pod')).length).toBe(2);
        expect(main.parts.find((p) => p.instanceId === 'lyra-d')!.modules[0]).toMatchObject({ active: true, thrust: 0 });
        expect(all[1]!.parts.find((p) => p.instanceId === 'm3-rcs-pod-a')!.resources[0]).toBeLessThan(120);
      },
    },
    {
      label: 'Landing gear',
      spawned: [],
      check: (ev, main) => {
        expect(ev.filter((e) => e.type === 'legsToggled' && e.deployed)).toHaveLength(1);
        expect(main.parts.find((p) => p.instanceId === 'landing-legs')!.modules[0]).toMatchObject({ deploy: 1 });
      },
    },
    {
      label: 'Lunar lift-off',
      spawned: [['descent-stage', 'landing-legs', 'lyra-d', 'stage-separator']],
      check: (ev, main, all) => {
        expect(ev.some((e) => e.type === 'decoupled' && e.partId === 'stage-separator')).toBe(true);
        expect(ev.some((e) => e.type === 'engineIgnition' && e.partId === 'lyra-a')).toBe(true);
        expect(count(ev, 'partDestroyed')).toBe(0);
        expect(main.thrust).toBeGreaterThan(59000);
        // The descent stage stays behind, intact and asleep on its legs.
        expect(all[1]!.hold).toBe('asleep');
        expect(all[1]!.parts.find((p) => p.instanceId === 'landing-legs')!.modules[0]).toMatchObject({ broken: [false, false, false, false] });
      },
    },
    {
      label: 'Capsule separation',
      spawned: [['ascent-stage', 'capsule-adapter', 'lyra-a']],
      check: (ev, main) => {
        expect(ev.some((e) => e.type === 'decoupled' && e.partId === 'capsule-adapter')).toBe(true);
        expect(ids(main)).toEqual(['apex-cover', 'capsule']);
        const rcs = main.parts[0]!.modules.find((m) => m.type === 'rcs');
        expect(rcs).toMatchObject({ enabled: true });
        expect(main.rcsEnabled).toBe(true);
      },
    },
    {
      label: 'Drogues',
      spawned: [['apex-cover']],
      check: (ev, main) => {
        expect(ev.some((e) => e.type === 'decoupled' && e.partId === 'apex-cover')).toBe(true);
        expect(ev.filter((e) => e.type === 'chuteDeployed' && e.mode === 'drogue')).toHaveLength(1);
        expect(count(ev, 'chuteInflated')).toBe(1);
        expect(count(ev, 'chuteFailed')).toBe(0);
        expect(main.parts[0]!.modules.find((m) => m.type === 'parachute')).toMatchObject({ state: 'full', inflation: 1 });
      },
    },
    {
      label: 'Mains',
      spawned: [],
      check: (ev, main) => {
        expect(count(ev, 'chuteCut')).toBe(1);
        expect(ev.filter((e) => e.type === 'chuteDeployed' && e.mode === 'main')).toHaveLength(1);
        expect(count(ev, 'chuteInflated')).toBe(1);
        const chutes = main.parts[0]!.modules.filter((m) => m.type === 'parachute');
        expect(chutes[0]).toMatchObject({ state: 'cut' });
        expect(chutes[1]).toMatchObject({ state: 'full' });
      },
    },
  ];

  for (let index = 0; index < 10; index++) {
    it(`stage ${index + 1}: ${expected[index]!.label}`, () => {
      const s = stageScenario(defs, index);
      const exp = expected[index]!;
      expect(s.events[0]).toMatchObject({ type: 'stageFired', stageIndex: index, label: exp.label });
      const events = [...s.events, ...runAll(s.vessels, s.env, 20, controls({ throttle: s.throttle }))];
      const [main, ...spawned] = s.vessels;
      expect(main!.nextStage).toBe(index + 1);
      expect(spawned.map(ids)).toEqual(exp.spawned);
      for (const v of spawned) expect(v.id.startsWith('meridian-lunar~')).toBe(true);
      if (index === 1) expect(spawned[0]!.name).toBe('Meridian M-1');
      if (index === 3) expect(spawned[0]!.name).toBe('Meridian M-2');
      if (index === 6) expect(spawned[0]!.name).toBe('Heron descent stage');
      if (index === 8) expect(spawned[0]!.name).toBe('Kestrel apex cover');
      expect(new Set(s.vessels.map((v) => v.id)).size).toBe(s.vessels.length);
      expect(main!.parts.some((p) => p.instanceId === 'capsule')).toBe(true);
      expect(main!.crewAlive).toBe(true);
      exp.check(events, main!, s.vessels);
      // The stack display agrees.
      const info = stagingInfo(main!, s.env);
      expect(info.filter((x) => x.fired)).toHaveLength(index + 1);
    });
  }
});

describe('momentum at every split', () => {
  const total = (vs: Vessel[]): { p: Vec3; m: number } => {
    let p = v3.zero();
    let m = 0;
    for (const v of vs) {
      computeMassProps(v);
      p = v3.add(p, momentum(v));
      m += v.mp.mass;
    }
    return { p, m };
  };
  const cases: { fired: number; actions: StageAction[] }[] = [
    { fired: 1, actions: [{ kind: 'decouple', part: 'interstage-1' }] },
    { fired: 2, actions: [{ kind: 'jettisonLES', part: 'les' }, { kind: 'jettisonFairing', part: 'fairing' }] },
    { fired: 3, actions: [{ kind: 'decouple', part: 'interstage-2' }] },
    { fired: 4, actions: [{ kind: 'decouple', part: 'payload-adapter' }] },
    { fired: 6, actions: [{ kind: 'decouple', part: 'stage-separator' }] },
    { fired: 7, actions: [{ kind: 'decouple', part: 'capsule-adapter' }] },
    { fired: 8, actions: [{ kind: 'decouple', part: 'apex-cover' }] },
  ];
  for (const c of cases) {
    it(`${c.actions.map((a) => a.kind).join(' + ')} after ${c.fired} stages conserves linear momentum to 1e-6`, () => {
      const env = makeEnv({});
      const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: c.fired });
      v.r = { x: 1000, y: env.radius + 200000, z: -500 };
      v.q = quat.normalize({ x: 0.2, y: -0.1, z: 0.35, w: 0.9 });
      v.v = { x: 5200, y: 310, z: -2100 };
      v.w = { x: 1 * DEG, y: -0.4 * DEG, z: 0.8 * DEG };
      const before = total([v]);
      const ctx: StepContext = { ut: 0, env, instant: false, events: [], spawned: [] };
      for (const a of c.actions) executeAction(v, a, c.fired, ctx);
      expect(ctx.spawned.length).toBeGreaterThan(0);
      const after = total([v, ...ctx.spawned]);
      expect(Math.abs(after.m - before.m) / before.m).toBeLessThan(1e-12);
      expect(v3.dist(after.p, before.p) / v3.len(before.p)).toBeLessThan(1e-6);
      // Each piece moved apart: the separation impulse changed the pieces' velocities.
      for (const s of ctx.spawned) expect(v3.dist(s.v, v.v)).toBeGreaterThan(0.05);
    });
  }

  it('a split without impulse also conserves angular momentum about the origin', () => {
    const env = makeEnv({});
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 4 });
    v.r = { x: 0, y: env.radius + 300000, z: 0 };
    v.v = { x: 7000, y: 0, z: 0 };
    v.w = { x: 0.02, y: 0.01, z: -0.03 };
    const angular = (vs: Vessel[]): Vec3 => {
      let L = v3.zero();
      for (const x of vs) {
        computeMassProps(x);
        const rc = v3.add(x.r, quat.rotate(x.q, x.mp.com));
        const I = x.mp.i;
        const w = x.w;
        const spin = { x: I[0] * w.x + I[3] * w.y + I[4] * w.z, y: I[3] * w.x + I[1] * w.y + I[5] * w.z, z: I[4] * w.x + I[5] * w.y + I[2] * w.z };
        L = v3.add(L, v3.add(v3.cross(rc, momentum(x)), quat.rotate(x.q, spin)));
      }
      return L;
    };
    const before = angular([v]);
    // A joint broken by over-stress separates without any impulse: use the decoupler with zero impulse
    // by cutting through the structural-failure path.
    const ctx: StepContext = { ut: 0, env, instant: false, events: [], spawned: [] };
    v.parts.find((p) => p.instanceId === 'payload-adapter')!.def = { ...v.parts.find((p) => p.instanceId === 'payload-adapter')!.def, modules: [{ type: 'decoupler', impulse: 0, separationPlaneY: 1.2 }] };
    executeAction(v, { kind: 'decouple', part: 'payload-adapter' }, 4, ctx);
    const after = angular([v, ...ctx.spawned]);
    expect(v3.dist(after, before) / v3.len(before)).toBeLessThan(1e-9);
  });
});

describe('abort', () => {
  it('pulls the capsule off the stack with the escape motor, then jettisons the tower', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    v.r = { x: 0, y: env.radius + 9000, z: 0 };
    v.v = { x: 0, y: 250, z: 0 };
    const vessels = [v];
    runAll(vessels, env, 2, controls({ throttle: 1 }));
    const res = abort(v, env);
    expect(res.ok).toBe(true);
    expect(res.events.some((e) => e.type === 'lesFired' && e.partId === 'les')).toBe(true);
    expect(res.events.some((e) => e.type === 'decoupled' && e.partId === 'capsule-adapter')).toBe(true);
    vessels.push(...res.spawned);
    expect(ids(v)).toEqual(['apex-cover', 'capsule', 'les', 'les-jettison-motor']);
    let peakG = 0;
    const stackV = vessels[1]!;
    const events = runAll(vessels, env, 3.4, controls({ throttle: 1 }), () => {
      peakG = Math.max(peakG, v.gLoad);
    });
    // 800 kN on 9 t: about 9 g, well away from the stack.
    expect(peakG).toBeGreaterThan(7);
    expect(peakG).toBeLessThan(10.5);
    expect(v.gDose).toBeLessThan(1);
    expect(v3.dist(v.r, stackV.r)).toBeGreaterThan(150);
    expect(count(events, 'engineShutdown')).toBeGreaterThanOrEqual(9);
    // The tower stays on through the coast (the stack flies apex-first like a dart) and goes 14 s after the abort.
    const coast = runAll(vessels, env, 9, controls());
    expect(coast.some((e) => e.type === 'decoupled' && e.partId === 'les')).toBe(false);
    expect(ids(v)).toEqual(['apex-cover', 'capsule', 'les', 'les-jettison-motor']);
    const later = runAll(vessels, env, 2, controls());
    expect(later.some((e) => e.type === 'decoupled' && e.partId === 'les')).toBe(true);
    expect(ids(v)).toEqual(['apex-cover', 'capsule']);
    expect(v.crewAlive).toBe(true);
    // The capsule is free and its RCS is on, so "Capsule separation" has nothing left to do: the very next
    // press is the drogue stage, the one after that the mains (sim-design section 11).
    run(v, env, 1, controls());
    expect(v.rcsEnabled).toBe(true);
    expect(nextLiveStage(v)).toBe(8);
    // The staging stack shows everything up to "Capsule separation" as done.
    expect(stagingInfo(v, env).map((i) => i.fired)).toEqual([true, true, true, true, true, true, true, true, false, false]);
    const drogue = fireNextStage(v, env);
    expect(drogue.ok).toBe(true);
    expect(drogue.events[0]).toMatchObject({ type: 'stageFired', stageIndex: 8, label: 'Drogues' });
    run(v, env, 1, controls());
    expect(nextLiveStage(v)).toBe(9);
    // A second abort has nothing left to do but is harmless.
    run(v, env, 1, controls());
    expect(abort(v, env).ok).toBe(true);
    expect(DT).toBeGreaterThan(0);
  });
});
