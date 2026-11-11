/**
 * Shared fixtures of the sim-world tests: the real definition library, a flat stand-in TerrainProvider
 * for tests of pure world logic (rails, warp, interpolation, commands, milestones), the real terrain
 * authority on the baked tiles for the tests that are about terrain, and small driving helpers.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { Sim, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider, TerrainResidency } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { createSim, type SimWorld } from '@/sim';
import { createRealTerrain, loadLibrary } from '../../../tools/sim/realWorld';

export { loadLibrary, createRealTerrain };

/**
 * A terrain authority without tiles: a constant height per body, everything resident. Only for tests of
 * world logic that is not about terrain; nothing in the mission proof uses it.
 */
export function flatTerrain(defs: DefLibrary, heights: Record<string, number> = {}): TerrainProvider & { requests: string[] } {
  const requests: string[] = [];
  const done: TerrainResidency = { residentLevel: 0, availableLevel: 0, effectiveLevel: 0, complete: true };
  return {
    requests,
    heightAt: (bodyId: string): number => heights[bodyId] ?? 0,
    normalAt: (_bodyId: string, dir: Vec3): Vec3 => v3.normalize(dir),
    surfaceKind: (bodyId: string) => {
      const ocean = defs.bodies[bodyId]?.ocean;
      return ocean && (heights[bodyId] ?? 0) < ocean.seaLevel ? 'water' : 'land';
    },
    ensureLoaded: (_bodyId: string, _dir: Vec3, _radius: number, slot?: string): Promise<void> => {
      requests.push(slot ?? 'default');
      return Promise.resolve();
    },
    prewarmCollision: (): number => 0,
    residency: (): TerrainResidency => done,
    elevationRange: (bodyId: string) => {
      const t = defs.bodies[bodyId]?.terrain;
      return { min: t ? t.minElevation : 0, max: t ? t.maxElevation : 0 };
    },
  };
}

/** The library with one more (or replaced) scenario. */
export function withScenario(defs: DefLibrary, scenario: ScenarioDef): DefLibrary {
  return { ...defs, scenarios: { ...defs.scenarios, [scenario.id]: scenario } };
}

export async function makeSim(defs: DefLibrary, scenario: ScenarioDef | string, terrain: TerrainProvider): Promise<SimWorld> {
  const lib = typeof scenario === 'string' ? defs : withScenario(defs, scenario);
  const sim = createSim(lib, typeof scenario === 'string' ? scenario : scenario.id, { terrain });
  await sim.ready;
  return sim;
}

export const controls = (c: Partial<ControlInputs> = {}): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 0, ...c });

export const active = (s: SimSnapshot): VesselSnapshot => s.vessels.find((v) => v.id === s.activeVesselId)!;

/** Centre-of-mass state of a vessel snapshot in BCI of its body. */
export function comState(v: VesselSnapshot): { r: Vec3; v: Vec3 } {
  return { r: v3.add(v.r, quat.rotate(v.q, v.comLocal)), v: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, v.comLocal))) };
}

/** Step until `cond` holds (checked after every step); returns the number of steps, -1 on the limit. */
export function stepUntil(sim: Sim, cond: (s: SimSnapshot) => boolean, maxSteps: number): number {
  for (let i = 1; i <= maxSteps; i++) {
    sim.step();
    if (cond(sim.peek())) return i;
  }
  return -1;
}

/** Wait for every terrain request of the sim (the await protocol). */
export async function settleTerrain(sim: Sim): Promise<void> {
  for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;
}

/** An 'orbit' scenario about a body with the vehicle configuration of `stagesAlreadyFired`. */
export function orbitScenario(base: ScenarioDef, id: string, bodyId: string, periapsisAltitude: number, apoapsisAltitude: number, stagesAlreadyFired: number, extra: Partial<{ inclinationDeg: number; lanDeg: number; argPeDeg: number; trueAnomalyDeg: number }> = {}): ScenarioDef {
  return {
    ...base,
    id,
    name: id,
    start: { kind: 'orbit', bodyId, periapsisAltitude, apoapsisAltitude, inclinationDeg: extra.inclinationDeg ?? 20, lanDeg: extra.lanDeg ?? 30, argPeDeg: extra.argPeDeg ?? 40, trueAnomalyDeg: extra.trueAnomalyDeg ?? 10 },
    stagesAlreadyFired,
    milestones: [],
  };
}
