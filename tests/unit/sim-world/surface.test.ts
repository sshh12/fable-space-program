/**
 * Resting on real surfaces: the lander on the baked lunar terrain of the landing region for 600 s (and
 * after being pushed about), and the capsule on the swell of the real ocean after a splashdown under its
 * parachutes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { RAD } from '@/core/math/scalar';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { createMissionPilot, runHeadless } from '@/pilot';
import { createSim, type SimWorld } from '@/sim';
import { active, controls, createRealTerrain, loadLibrary, makeSim, settleTerrain, stepUntil } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

/** Position of the active vessel in the frame fixed to the body it is on. */
function fixedPosition(s: SimSnapshot): Vec3 {
  const v = active(s);
  const body = s.bodies.find((b) => b.id === v.bodyId)!;
  return quat.rotateInv(body.qFixedToRoot, v.r);
}

const legsOf = (s: SimSnapshot) => {
  const m = active(s)
    .parts.flatMap((p) => p.modules)
    .find((x) => x.type === 'legs');
  if (!m || m.type !== 'legs') throw new Error('no landing legs');
  return m;
};

describe('landed on real lunar terrain', () => {
  let terrain: TerrainProvider;
  let sim: SimWorld;
  beforeAll(async () => {
    terrain = await createRealTerrain(defs);
    sim = await makeSim(defs, 'qa-lunar-surface', terrain);
    await settleTerrain(sim);
  });

  it('stands on its four legs on the finest data of the landing region', () => {
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('moon');
    expect(v.situation).toBe('landed');
    expect(s.terrain.complete).toBe(true);
    const res = terrain.residency('moon', v3.normalize(fixedPosition(s)));
    expect(res.availableLevel).toBeGreaterThanOrEqual(12);
    expect(res.residentLevel).toBe(res.availableLevel);
    expect(res.complete).toBe(true);
    const legs = legsOf(s);
    expect(legs.deploy).toBe(1);
    expect(legs.contact).toEqual([true, true, true, true]);
    expect(legs.broken).toEqual([false, false, false, false]);
    for (const c of legs.compression) {
      expect(c).toBeGreaterThan(0.02);
      expect(c).toBeLessThan(0.6);
    }
    expect(s.readouts.tiltFromVertical * RAD).toBeLessThan(6);
    // The feet are on the ground that is drawn: the collision surface under the vessel is the terrain height.
    expect(s.readouts.altitudeRadar).toBe(0);
  });

  it('pushed sideways by its thrusters it flexes a few millimetres on its legs and comes to rest again', async () => {
    const p0 = fixedPosition(sim.peek());
    sim.commands.setRcsEnabled(true);
    sim.setControls(controls({ translate: { x: 1, y: 0, z: 0 } }));
    let worst = 0;
    for (let i = 0; i < 120 * 3; i++) {
      sim.step();
      if (i % 12 === 0) worst = Math.max(worst, v3.dist(fixedPosition(sim.peek()), p0));
    }
    // Under the push the vessel is integrated with its contacts, not held.
    expect(active(sim.peek()).translationMode).toBe('integrated');
    expect(worst).toBeGreaterThan(0.0005);
    expect(worst).toBeLessThan(0.05);
    sim.setControls(controls());
    sim.commands.setRcsEnabled(false);
    const rest = stepUntil(sim, (s) => active(s).translationMode === 'landed', 120 * 20);
    expect(rest).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) sim.step();
    await settleTerrain(sim);
    const s = sim.peek();
    expect(v3.dist(fixedPosition(s), p0)).toBeLessThan(0.05);
    expect(legsOf(s).broken).toEqual([false, false, false, false]);
    expect(s.readouts.speedSurface).toBeLessThan(1e-6);
  });

  it('stays where it is for 600 s: no creep, no tilt, no leg lost, nothing asked of unfinished terrain', async () => {
    const start = sim.peek();
    const p0 = fixedPosition(start);
    const tilt0 = start.readouts.tiltFromVertical;
    const compression0 = legsOf(start).compression.slice();
    let worstDrift = 0;
    let worstTilt = 0;
    for (let second = 0; second < 600; second++) {
      for (let i = 0; i < 120; i++) sim.step();
      if (second % 60 === 59) await settleTerrain(sim);
      const s = sim.peek();
      expect(active(s).situation).toBe('landed');
      worstDrift = Math.max(worstDrift, v3.dist(fixedPosition(s), p0));
      worstTilt = Math.max(worstTilt, Math.abs(s.readouts.tiltFromVertical - tilt0));
    }
    const end = sim.peek();
    expect(end.simUt - start.simUt).toBeCloseTo(600, 3);
    expect(worstDrift).toBeLessThan(1e-3);
    expect(worstTilt * RAD).toBeLessThan(0.01);
    expect(legsOf(end).broken).toEqual([false, false, false, false]);
    expect(legsOf(end).contact).toEqual([true, true, true, true]);
    for (let i = 0; i < 4; i++) expect(legsOf(end).compression[i]!).toBeCloseTo(compression0[i]!, 3);
    expect(end.terrain.incompleteQueries).toBe(0);
    expect(end.mission.failed).toBe(false);
    // Still the same place on the Moon: the target is where it was.
    expect(end.readouts.landingTarget!.distance).toBeCloseTo(start.readouts.landingTarget!.distance, 3);
  });
});

describe('splashdown and flotation', () => {
  it('the capsule comes down under its mains, cuts them in the water and rides the swell upright', async () => {
    const terrain = await createRealTerrain(defs);
    const sim = createSim(defs, 'qa-drogues', { terrain });
    const pilot = createMissionPilot(defs, sim.scenario);
    // Sink rate over the last five seconds before the water (steady under the mains).
    const recent: number[] = [];
    let splashSpeed = NaN;
    const run = await runHeadless(sim, pilot, {
      maxSimTime: 3600,
      onTick: (s) => {
        if (active(s).contact.waterSubmersion > 0 || active(s).situation === 'splashed') {
          if (Number.isNaN(splashSpeed)) splashSpeed = Math.max(...recent);
          return;
        }
        recent.push(-s.readouts.verticalSpeed);
        if (recent.length > 150) recent.shift();
      },
    });
    expect(run.reason).toBe('done');
    expect(run.failure).toBeNull();
    let s = sim.peek();
    expect(active(s).situation).toBe('splashed');
    expect(s.mission.crewAlive).toBe(true);
    expect(s.terrain.incompleteQueries).toBe(0);
    // Under the three mains: 7 to 9 m/s at the water.
    expect(splashSpeed).toBeGreaterThan(5);
    expect(splashSpeed).toBeLessThanOrEqual(9.5);
    const chutes = active(s)
      .parts.flatMap((p) => p.modules)
      .filter((m) => m.type === 'parachute');
    expect(chutes.length).toBeGreaterThan(0);
    for (const c of chutes) expect(c.type === 'parachute' && c.state).toBe('cut');
    // Three more minutes on the water.
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let maxTilt = 0;
    let maxSpeed = 0;
    let minSubmersion = 1;
    let maxSubmersion = 0;
    for (let i = 0; i < 120 * 180; i++) {
      sim.step();
      if (i % 12 !== 0) continue;
      if (i % 1200 === 0) await settleTerrain(sim);
      s = sim.peek();
      const v = active(s);
      expect(v.situation).toBe('splashed');
      minAlt = Math.min(minAlt, s.readouts.altitudeAsl);
      maxAlt = Math.max(maxAlt, s.readouts.altitudeAsl);
      maxTilt = Math.max(maxTilt, s.readouts.tiltFromVertical * RAD);
      maxSpeed = Math.max(maxSpeed, s.readouts.speedSurface);
      minSubmersion = Math.min(minSubmersion, v.contact.waterSubmersion);
      maxSubmersion = Math.max(maxSubmersion, v.contact.waterSubmersion);
    }
    // It rides the swell: up and down with the sea, never under, never flung off.
    expect(maxAlt - minAlt).toBeGreaterThan(0.3);
    expect(minAlt).toBeGreaterThan(-4);
    expect(maxAlt).toBeLessThan(4);
    expect(maxSpeed).toBeLessThan(3);
    expect(minSubmersion).toBeGreaterThan(0.15);
    expect(maxSubmersion).toBeLessThan(0.85);
    // Upright: the list of the offset centre of mass plus the slope of the waves.
    expect(maxTilt).toBeLessThan(30);
    expect(s.mission.failed).toBe(false);
    expect(s.mission.crewAlive).toBe(true);
    expect(s.readouts.altitudeRadar).toBe(0);
    expect(s.terrain.incompleteQueries).toBe(0);
  }, 120_000);
});
