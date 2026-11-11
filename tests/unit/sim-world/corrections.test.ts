/**
 * Trans-Earth corrections of the mission pilot (brief: "later corrections keep both targets"). On the way
 * home the pilot aims at two things at once: a vacuum perigee of 45 km and a predicted splash point - the
 * atmosphere-entry marker carried down-range - inside a recovery zone. The first correction settles both;
 * the later ones (at 150 000 km and 50 000 km) fly nothing while both hold, and restore both after the
 * trajectory has been disturbed.
 *
 * Flown from the `qa-trans-earth` start through `Sim.advance` in 60 Hz frames. The disturbance is a
 * velocity change made with the debug API (a test of the pilot's correction logic, not a mission flight).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, SurfaceTarget } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3, type Vec3 } from '@/core/math/vec3';
import { createMissionPilot, entryDownRange, type MissionPilot } from '@/pilot';
import { predictSplash, zoneMisses } from '@/pilot/targets';
import { createSim, type SimWorld } from '@/sim';
import { active, flatTerrain, loadLibrary, settleTerrain } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

const PERIGEE = 45000;

interface Flight {
  sim: SimWorld;
  pilot: MissionPilot;
  drive(until: (s: SimSnapshot) => boolean, maxFrames: number): Promise<number>;
}

async function start(): Promise<Flight> {
  const sim = createSim(defs, 'qa-trans-earth', { terrain });
  const pilot = createMissionPilot(defs, sim.scenario);
  await sim.ready;
  let prevUt = sim.peek().simUt;
  const onTick = (): void => {
    const s = sim.peek();
    sim.setControls(pilot.update(s, sim.commands, s.simUt - prevUt));
    prevUt = s.simUt;
  };
  const drive = async (until: (s: SimSnapshot) => boolean, maxFrames: number): Promise<number> => {
    for (let frames = 1; frames <= maxFrames; frames++) {
      await settleTerrain(sim);
      sim.advance(1 / 60, onTick);
      sim.snapshot();
      if (pilot.failure !== null || until(sim.peek())) return frames;
    }
    return -1;
  };
  return { sim, pilot, drive };
}

/** Where the current trajectory comes down, as the pilot predicts it, against the recovery zone it is nearest to. */
function arrival(s: SimSnapshot): { perigee: number; latitude: number; longitude: number; zone: SurfaceTarget; miss: number } {
  const earth = s.bodies.find((b) => b.id === 'earth')!;
  const R = defs.bodies['earth']!.radius;
  const splash = predictSplash(s.patches.current, earth, R, entryDownRange)!;
  const nearest = zoneMisses(s.surfaceTargets, 'earth', R, splash.latitude, splash.longitude)[0]!;
  return { perigee: splash.vacuumPerigeeAltitude, latitude: splash.latitude, longitude: splash.longitude, zone: nearest.zone, miss: nearest.distance };
}

const groundDistance = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number => {
  const dir = (p: { latitude: number; longitude: number }): Vec3 => ({ x: Math.cos(p.latitude) * Math.cos(p.longitude), y: Math.cos(p.latitude) * Math.sin(p.longitude), z: Math.sin(p.latitude) });
  return v3.angle(dir(a), dir(b)) * defs.bodies['earth']!.radius;
};

describe('trans-Earth corrections', () => {
  it('undisturbed: the first correction settles the perigee and the splash point; the later ones fly nothing', async () => {
    const f = await start();
    expect(await f.drive(() => f.pilot.phase === 'entryPrep', 60 * 1200)).toBeGreaterThan(0);
    expect(f.pilot.failure).toBeNull();
    const report = f.pilot.report;
    expect(report['tec1SplashMiss']).toBeDefined();
    expect(report['tec2DeltaV']).toBeUndefined();
    expect(report['tec3DeltaV']).toBeUndefined();
    const a = arrival(f.sim.peek());
    expect(Math.abs(a.perigee - PERIGEE)).toBeLessThan(2500);
    expect(a.miss).toBeLessThan(a.zone.radius);
    // The capsule is let go where the pilot meant to (2 500 km, at most twenty seconds of flight early).
    const alt = f.sim.peek().readouts.altitudeAsl;
    expect(alt).toBeLessThan(2.8e6);
    expect(alt).toBeGreaterThan(2.3e6);
    expect(f.sim.cheatCounter).toBe(0);
  }, 120_000);

  it('disturbed after the first correction: the next one restores the perigee and the splash point', async () => {
    const f = await start();
    expect(await f.drive(() => f.pilot.report['tec1SplashMiss'] !== undefined, 60 * 600)).toBeGreaterThan(0);
    const settled = arrival(f.sim.peek());
    expect(Math.abs(settled.perigee - PERIGEE)).toBeLessThan(1000);
    expect(f.sim.peek().readouts.altitudeAsl).toBeGreaterThan(2e8);
    // Half a metre per second across the line of sight to the Earth and a metre per second along it: the
    // perigee moves by tens of kilometres, the arrival time by minutes (the Earth turns 28 km a minute).
    const v = active(f.sim.peek());
    const up = v3.normalize(v.r);
    const across = v3.cross(v3.normalize(v3.cross(v.r, v.v)), up);
    f.sim.debug.setVesselState(v.id, v.bodyId, v.r, v3.add(v.v, v3.add(v3.scale(across, 0.5), v3.scale(up, 1))));
    expect(await f.drive(() => true, 600)).toBeGreaterThan(0);
    const disturbed = arrival(f.sim.peek());
    expect(Math.abs(disturbed.perigee - PERIGEE)).toBeGreaterThan(10000);
    expect(groundDistance(disturbed, settled)).toBeGreaterThan(20000);
    // On to the capsule separation: the correction at 150 000 km takes care of both.
    expect(await f.drive(() => f.pilot.phase === 'entryPrep', 60 * 1200)).toBeGreaterThan(0);
    expect(f.pilot.failure).toBeNull();
    const report = f.pilot.report;
    expect(report['tec2DeltaV']!).toBeGreaterThan(0.3);
    const flown = (report['tec2DeltaV'] ?? 0) + (report['tec3DeltaV'] ?? 0);
    expect(flown).toBeLessThan(40);
    const restored = arrival(f.sim.peek());
    expect(Math.abs(restored.perigee - PERIGEE)).toBeLessThan(2500);
    expect(restored.zone.id).toBe(settled.zone.id);
    expect(restored.miss).toBeLessThan(restored.zone.radius);
    // The splash point is back where the first correction had put it (inside the pilot's band of 50 km of
    // miss from the zone centre), not merely wherever the perigee fix happened to leave it.
    expect(restored.miss).toBeLessThan(settled.miss + 50000);
    expect(groundDistance(restored, settled)).toBeLessThan(groundDistance(disturbed, settled));
  }, 120_000);
});
