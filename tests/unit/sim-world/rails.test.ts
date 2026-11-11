/**
 * Rails and integration: a rails revolution against an independent Kepler propagation, the exactness of
 * the hand-over between rails and integration in both directions, and SOI transitions at their predicted
 * times.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { makeOrbit, propagate } from '@/sim/orbit';
import { active, comState, controls, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

describe('rails', () => {
  it('one rails revolution matches Kepler to 1 m (and much better)', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-leo', 'earth', 185000, 260000, 4), terrain);
    const s0 = sim.peek();
    const v0 = active(s0);
    expect(v0.translationMode).toBe('rails');
    const c0 = comState(v0);
    const orbit = makeOrbit('earth', defs.bodies['earth']!.mu, c0.r, c0.v, s0.simUt);
    const period = orbit.period!;
    expect(period).toBeGreaterThan(5200);
    // The HUD's period is that of the same (centre-of-mass) orbit.
    expect(s0.readouts.period!).toBeCloseTo(period, 6);
    // Rails warp in chunks (as the runner does), checking against the reference on the way.
    let worst = 0;
    const end = s0.simUt + period;
    while (sim.peek().simUt < end) {
      const t = Math.min(end, sim.peek().simUt + 50 / 60);
      const reached = sim.advanceRails(t);
      expect(reached).toBeGreaterThan(s0.simUt);
      const s = sim.peek();
      const c = comState(active(s));
      worst = Math.max(worst, v3.dist(c.r, propagate(orbit, s.simUt).r));
    }
    const s1 = sim.peek();
    expect(s1.simUt).toBeCloseTo(end, 6);
    const c1 = comState(active(s1));
    // Back where it started after exactly one period.
    expect(v3.dist(c1.r, c0.r)).toBeLessThan(1);
    expect(v3.dist(c1.r, c0.r)).toBeLessThan(1e-3);
    expect(worst).toBeLessThan(1e-3);
    expect(active(s1).translationMode).toBe('rails');
    expect(s1.cheatCounter).toBe(0);
  });

  it('a coasting vessel stepped at 1x stays exactly on its conic while its attitude is free', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-leo-step', 'earth', 200000, 300000, 4), terrain);
    const s0 = sim.peek();
    const c0 = comState(active(s0));
    const orbit = makeOrbit('earth', defs.bodies['earth']!.mu, c0.r, c0.v, s0.simUt);
    sim.commands.setSasEnabled(true);
    sim.commands.setRcsEnabled(true);
    // Turn the stack with the stick while it coasts: rotation does not perturb the orbit.
    sim.setControls(controls({ pitch: 1 }));
    for (let i = 0; i < 600; i++) sim.step();
    sim.setControls(controls());
    for (let i = 0; i < 600; i++) sim.step();
    const s = sim.peek();
    const v = active(s);
    expect(v.translationMode).toBe('rails');
    expect(v3.len(v.w)).toBeGreaterThan(0);
    const c = comState(v);
    const ref = propagate(orbit, s.simUt);
    expect(v3.dist(c.r, ref.r)).toBeLessThan(1e-4);
    expect(v3.dist(c.v, ref.v)).toBeLessThan(1e-6);
    expect(s.simUt - s0.simUt).toBeCloseTo(1200 * PHYSICS_DT, 6);
  });

  it('hand-over between rails and integration is exact both ways', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-handover', 'earth', 200000, 300000, 4), terrain);
    const mu = defs.bodies['earth']!.mu;
    sim.commands.setSasEnabled(true);
    const s0 = sim.peek();
    const c0 = comState(active(s0));
    const before = makeOrbit('earth', mu, c0.r, c0.v, s0.simUt);
    for (let i = 0; i < 240; i++) sim.step();
    // Rails -> integrated: throttle up. The state the burn starts from is the Kepler state.
    let s = sim.peek();
    expect(active(s).translationMode).toBe('rails');
    sim.setControls(controls({ throttle: 1 }));
    sim.step();
    s = sim.peek();
    expect(active(s).translationMode).toBe('integrated');
    // One step of spool-up changes the velocity by far less than the comparison allows for a jump.
    const c1 = comState(active(s));
    const ref1 = propagate(before, s.simUt);
    expect(v3.dist(c1.r, ref1.r)).toBeLessThan(1e-3);
    expect(v3.dist(c1.v, ref1.v)).toBeLessThan(0.2);
    for (let i = 0; i < 480; i++) sim.step();
    expect(active(sim.peek()).thrust).toBeGreaterThan(5e5);
    sim.setControls(controls());
    // Integrated -> rails: after the tail-off and half a second of coasting. Track every step: the
    // position is continuous and consistent with the velocity through the switch.
    let prev = comState(active(sim.peek()));
    let switched = -1;
    let railsRef: ReturnType<typeof makeOrbit> | null = null;
    let worstStep = 0;
    for (let i = 0; i < 600; i++) {
      sim.step();
      const sn = sim.peek();
      const c = comState(active(sn));
      const predicted = v3.addScaled(prev.r, v3.scale(v3.add(prev.v, c.v), 0.5), PHYSICS_DT);
      worstStep = Math.max(worstStep, v3.dist(c.r, predicted));
      if (switched < 0 && active(sn).translationMode === 'rails') {
        switched = i;
        railsRef = makeOrbit('earth', mu, c.r, c.v, sn.simUt);
      }
      prev = c;
    }
    expect(switched).toBeGreaterThan(30);
    expect(switched).toBeLessThan(300);
    // Trapezoid prediction error of one step under gravity and (early on) thrust: millimetres, no jump.
    expect(worstStep).toBeLessThan(5e-3);
    const sEnd = sim.peek();
    const cEnd = comState(active(sEnd));
    const refEnd = propagate(railsRef!, sEnd.simUt);
    expect(v3.dist(cEnd.r, refEnd.r)).toBeLessThan(1e-4);
    // The new orbit differs from the old one: the burn was real.
    expect(v3.dist(cEnd.v, propagate(before, sEnd.simUt).v)).toBeGreaterThan(10);
  });
});

describe('SOI transitions', () => {
  it('entering the Moon SOI happens at the predicted time (within 2 s; in fact to the millisecond)', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s0 = sim.peek();
    const first = s0.patches.current[0]!;
    expect(first.bodyId).toBe('earth');
    expect(first.endReason).toBe('soiEnter');
    expect(first.nextBodyId).toBe('moon');
    const predicted = first.tEnd;
    expect(predicted - s0.simUt).toBeGreaterThan(86400);
    let guard = 0;
    while (active(sim.peek()).bodyId !== 'moon' && guard++ < 100000) {
      sim.commands.setWarpLevel(10);
      sim.advance(1 / 60);
      // Time never runs past the transition without it being processed.
      const s = sim.peek();
      if (active(s).bodyId === 'earth') expect(s.simUt).toBeLessThanOrEqual(predicted + 1e-6);
    }
    const s = sim.peek();
    expect(active(s).bodyId).toBe('moon');
    const ev = s.events.find((e) => e.type === 'soiChange');
    expect(ev).toBeDefined();
    expect(Math.abs(ev!.ut - predicted)).toBeLessThan(2);
    expect(Math.abs(ev!.ut - predicted)).toBeLessThan(1e-2);
    // Continuous in ROOT across the transition: distance from the Moon equals the SOI radius.
    const moon = s.bodies.find((b) => b.id === 'moon')!;
    expect(v3.len(active(s).r)).toBeLessThanOrEqual(moon.soiRadius! * 1.0001);
    // The patches now start inside the Moon's SOI.
    expect(s.patches.current[0]!.bodyId).toBe('moon');
  });

  it('leaving the Moon SOI on the way home happens at the predicted time', async () => {
    // A departure flown by hand from the lunar-orbit scenario: prograde until well past escape.
    const lunar = await makeSim(defs, 'qa-lunar-orbit', terrain);
    lunar.commands.setSasEnabled(true);
    lunar.commands.setSasMode('prograde');
    lunar.commands.setRcsEnabled(true);
    // Point prograde, then burn out of lunar orbit by hand.
    for (let i = 0; i < 120 * 40; i++) lunar.step();
    lunar.setControls(controls({ throttle: 1 }));
    let guard = 0;
    while ((lunar.peek().readouts.eccentricity < 1.3 || lunar.peek().readouts.period !== null) && guard++ < 120 * 400) lunar.step();
    lunar.setControls(controls());
    for (let i = 0; i < 240; i++) lunar.step();
    const s0 = lunar.peek();
    expect(active(s0).translationMode).toBe('rails');
    const first = s0.patches.current[0]!;
    expect(first.endReason).toBe('soiExit');
    const predicted = first.tEnd;
    guard = 0;
    while (active(lunar.peek()).bodyId === 'moon' && guard++ < 100000) {
      lunar.commands.setWarpLevel(10);
      lunar.advance(1 / 60);
    }
    const s = lunar.peek();
    const ev = s.events.filter((e) => e.type === 'soiChange').pop();
    expect(ev).toBeDefined();
    expect(Math.abs(ev!.ut - predicted)).toBeLessThan(1e-2);
    expect(active(s).bodyId).toBe('earth');
  });
});
