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

describe('read-outs of a vessel that is not flying through air (request flight-ui-9)', () => {
  const G0 = 9.80665;

  it('the chute envelope says nothing where there is no air, and what it said under the drogues', async () => {
    for (const id of ['qa-lunar-orbit', 'qa-lunar-surface', 'qa-translunar', 'qa-leo']) {
      const sim = await makeSim(defs, id, terrain);
      for (let i = 0; i < 8; i++) sim.step();
      const s = sim.peek();
      expect(active(s).aero.airDensity, id).toBe(0);
      expect(s.readouts.chuteEnvelope, id).toBeNull();
    }
    // In air the light is judged: on the pad, at entry interface speed (not safe) and under the drogues.
    const pad = await makeSim(defs, 'lunar-direct', flatTerrain(defs, { earth: 0, moon: 0 }));
    expect(pad.peek().readouts.chuteEnvelope).not.toBeNull();
    const drogues = await makeSim(defs, 'qa-drogues', terrain);
    for (let i = 0; i < 8; i++) drogues.step();
    expect(active(drogues.peek()).aero.airDensity).toBeGreaterThan(0.1);
    expect(['safe', 'risky', 'unsafe']).toContain(drogues.peek().readouts.chuteEnvelope);
  });

  it('on the launch clamps: the radar altitude is the height of the vehicle over the ground and goes on through the release; the g load is the local gravity', async () => {
    const sim = await makeSim(defs, 'lunar-direct', flatTerrain(defs, { earth: 0, moon: 0 }));
    const site = defs.sites[defs.scenarios['lunar-direct']!.site]!;
    const s0 = sim.peek();
    expect(active(s0).situation).toBe('prelaunch');
    // The vehicle's lowest point stands on the launch mount, the mount height above the pad; the pad
    // surface is its elevation above the (flat, 0 m) terrain of this test.
    const expected = site.pads![0]!.mountHeight + (site.location.padElevation as number);
    // (The lowest contact probe of the stack is within two metres of the point it stands on.)
    expect(Math.abs(s0.readouts.altitudeRadar - expected)).toBeLessThan(2);
    // What the simulation's own rules read is unchanged: a held vessel is on the ground.
    expect((sim as unknown as { radarAltitude(): number }).radarAltitude()).toBe(0);
    // 1.00 g on the pad (the local gravity at the pad's radius), steady from the first snapshot.
    const r = v3.len(active(s0).r);
    expect(s0.readouts.gLoad).toBe(defs.bodies['earth']!.mu / (r * r) / G0);
    expect(Math.abs(s0.readouts.gLoad - 1)).toBeLessThan(0.01);
    expect(active(s0).gLoad).toBe(s0.readouts.gLoad);
    for (let i = 0; i < 240; i++) sim.step();
    expect(Math.abs(sim.peek().readouts.gLoad - s0.readouts.gLoad)).toBeLessThan(1e-12);
    // Ignition and release: the number continues (no jump from 0), then grows as the vehicle climbs.
    sim.setControls({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 1 });
    sim.commands.stage();
    let before = sim.peek().readouts.altitudeRadar;
    let worstJump = 0;
    let released = false;
    for (let i = 0; i < 2400 && !(released && sim.peek().readouts.altitudeRadar > expected + 5); i++) {
      sim.step();
      const s = sim.peek();
      if (active(s).situation !== 'prelaunch') released = true;
      worstJump = Math.max(worstJump, Math.abs(s.readouts.altitudeRadar - before));
      before = s.readouts.altitudeRadar;
    }
    expect(released).toBe(true);
    // Step to step the altimeter moves by the vehicle's own motion: centimetres, never the 18 m of the mount.
    expect(worstJump).toBeLessThan(0.3);
    expect(sim.peek().readouts.altitudeRadar).toBeGreaterThan(expected + 5);
  });

  it('landed on the Moon: 0.17 g, the feet on the ground, no chute light', async () => {
    const sim = await makeSim(defs, 'qa-lunar-surface', terrain);
    const s = sim.peek();
    expect(active(s).situation).toBe('landed');
    const r = v3.len(active(s).r);
    expect(s.readouts.gLoad).toBe(defs.bodies['moon']!.mu / (r * r) / G0);
    expect(Math.abs(s.readouts.gLoad - 0.1654)).toBeLessThan(0.003);
    expect(s.readouts.altitudeRadar).toBeLessThan(0.5);
    expect(s.readouts.chuteEnvelope).toBeNull();
  });
});
