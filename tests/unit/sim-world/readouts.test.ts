/**
 * Read-outs that must describe the place the vessel is at now: the Mach number outside an atmosphere
 * (request flight-ui-6) and the thrust-to-weight ratio of the stages after a coast on rails, across a
 * sphere-of-influence change included (request flight-ui-8).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { active, flatTerrain, loadLibrary, makeSim } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

describe('Mach number', () => {
  it('reads 0 in orbit about the Moon and on the way there, and a real value under the drogues', async () => {
    for (const id of ['qa-lunar-orbit', 'qa-translunar', 'qa-leo']) {
      const sim = await makeSim(defs, id, terrain);
      for (let i = 0; i < 8; i++) sim.step();
      const s = sim.peek();
      expect(active(s).aero.airDensity, id).toBe(0);
      expect(active(s).aero.mach, id).toBe(0);
      expect(s.readouts.mach, id).toBe(0);
      expect(s.readouts.speedOrbital, id).toBeGreaterThan(500);
    }
    const sim = await makeSim(defs, 'qa-drogues', terrain);
    for (let i = 0; i < 8; i++) sim.step();
    const s = sim.peek();
    expect(active(s).aero.airDensity).toBeGreaterThan(0.1);
    expect(s.readouts.mach).toBeGreaterThan(0.1);
    expect(s.readouts.mach).toBeLessThan(1);
    expect(active(s).aero.mach).toBe(s.readouts.mach);
  });
});

describe('thrust-to-weight ratio of the stages', () => {
  /** Local gravity at the active vessel, m/s^2, as the staging info weighs a stage. */
  const gravity = (s: SimSnapshot): number => {
    const v = active(s);
    return defs.bodies[v.bodyId]!.mu / v3.lenSq(v.r);
  };

  it('is restated at the local gravity after a coast on rails and after the sphere-of-influence change', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s0 = sim.peek();
    const g0 = gravity(s0);
    const withEngines = s0.staging.stages.map((st, i) => (st.twr > 0 ? i : -1)).filter((i) => i >= 0);
    expect(withEngines.length).toBeGreaterThanOrEqual(2);
    const acceleration = s0.staging.stages.map((st) => st.twr * g0);
    const dv = s0.staging.stages.map((st) => st.deltaVVac);

    // Six hours of coast toward the Moon on rails: no physics step, the vehicle unchanged.
    let reached = s0.simUt;
    while (reached < s0.simUt + 6 * 3600) reached = sim.advanceRails(s0.simUt + 6 * 3600);
    const s1 = sim.peek();
    const g1 = gravity(s1);
    expect(g1).toBeLessThan(0.5 * g0);
    for (const i of withEngines) {
      const st = s1.staging.stages[i]!;
      expect(st.twr * g1, `${st.label} after the coast`).toBeCloseTo(acceleration[i]!, 9);
      expect(st.twr).toBeGreaterThan(1.9 * s0.staging.stages[i]!.twr);
      expect(st.deltaVVac).toBe(dv[i]);
    }

    // On to the Moon's sphere of influence, still on rails.
    for (let guard = 0; guard < 4000 && active(sim.peek()).bodyId !== 'moon'; guard++) {
      const before = sim.peek().simUt;
      if (!(sim.advanceRails(Math.min(sim.nextEventUt, before + 20000)) > before)) sim.step();
    }
    const s2 = sim.peek();
    expect(active(s2).bodyId).toBe('moon');
    const g2 = gravity(s2);
    // 60,000 km and more from the Moon: a thousandth of a metre per second squared.
    expect(g2).toBeLessThan(0.01);
    for (const i of withEngines) {
      const st = s2.staging.stages[i]!;
      expect(st.twr * g2, `${st.label} at the Moon's sphere of influence`).toBeCloseTo(acceleration[i]!, 6);
      expect(st.deltaVVac).toBeCloseTo(dv[i]!, 9);
    }
    expect(s2.cheatCounter).toBe(0);
  });
});
