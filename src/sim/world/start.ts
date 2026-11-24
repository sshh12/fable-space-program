/**
 * The start state of a scenario: the scenario's vehicle assembled and placed (on a pad, on an orbit, at a
 * state, or set down on a surface). Spawn poses on pads take this over in `src/universe` (MIGRATION_V2
 * section 5); the placing itself is v1's, unchanged.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import { PHYSICS_DT, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import { padLocationOf } from '@/core/defs/sites';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { utOfTick } from '../clock';
import { dirFromLatLon } from '../frames/bodyFrames';
import { resolvePadElevation } from '../frames/padState';
import { IslandEnv } from '../island/environment';
import { IMPACT_PREDICTION_LAMBDA, type BodyFrames } from '../island/frames';
import { assembleVessel, holdOnGround, rideBody, stepVessel, structureOf, type CraftIdSource, type Vessel } from '../vessel';
import { applyPose, applyStartResources, landedPose, orbitPose, padPose, statePose } from './scenarioStart';

/** Seconds a 'landed' scenario vessel is given to come to rest before startUt, and the height it is let down from, m. */
const LANDED_SETTLE_TIME = 40;
const LANDED_DROP_HEIGHT = 0.25;

/**
 * Build the scenario vessel and place it at `tick`. `final` = the terrain under the start point is resident
 * (the pad elevation and the surface under a landed vessel are the collision surface's; before that the
 * band-limited one). A vessel that stands on the ground is held there; its sun sample is taken.
 */
export function placeStart(defs: DefLibrary, frames: BodyFrames, sc: ScenarioDef, startPad: string, craft: { craftId: string; ids: CraftIdSource }, tick: number, final: boolean): { vessel: Vessel; bodyId: string; env: IslandEnv } {
  const system = frames.system;
  const terrain = frames.terrain;
  const vessel = assembleVessel(defs, sc.vehicle, { stagesAlreadyFired: sc.stagesAlreadyFired, craft: { craftId: craft.craftId, joinedTick: tick, ids: craft.ids } });
  if (sc.resources) applyStartResources(vessel, sc.resources);
  const start = sc.start;
  const ut = sc.startUt;
  let bodyId: string;
  switch (start.kind) {
    case 'pad': {
      const site = defs.sites[sc.site]!;
      bodyId = site.bodyId;
      const where = padLocationOf(site, startPad);
      const dir = dirFromLatLon(where.latDeg * DEG, where.lonDeg * DEG);
      const elevation = resolvePadElevation(site, frames.base(bodyId).hasTerrain ? terrain.heightAt(bodyId, dir, final ? undefined : IMPACT_PREDICTION_LAMBDA) : 0, startPad);
      applyPose(vessel, padPose(system, site, vessel, ut, elevation, startPad));
      break;
    }
    case 'orbit': {
      const pose = orbitPose(system, start);
      bodyId = pose.bodyId;
      applyPose(vessel, pose);
      break;
    }
    case 'state': {
      const pose = statePose(start);
      bodyId = pose.bodyId;
      applyPose(vessel, pose);
      break;
    }
    case 'landed': {
      bodyId = start.bodyId;
      const dir = dirFromLatLon(start.latDeg * DEG, start.lonDeg * DEG);
      const h = frames.base(bodyId).hasTerrain ? terrain.heightAt(bodyId, dir, final ? undefined : IMPACT_PREDICTION_LAMBDA) : 0;
      applyPose(vessel, landedPose(system, bodyId, start.latDeg, start.lonDeg, vessel, ut, h, 0));
      break;
    }
  }
  if (!defs.bodies[bodyId]) throw new Error(`scenarios/${sc.id}.json: unknown body "${bodyId}"`);
  if (!(vessel.mp.mass > 0)) structureOf(vessel);
  const env = new IslandEnv(terrain);
  if (vessel.hold !== null || start.kind === 'landed') holdOnGround(vessel, frames.aim(env, bodyId, vessel.r, ut));
  vessel.sun = frames.sunSample(bodyId, vessel.r, ut);
  env.sunDir = vessel.sun.dir;
  env.sunVisibility = vessel.sun.visibility;
  return { vessel, bodyId, env };
}

/** Let a 'landed' scenario vessel come to rest on the real surface before startUt: it is let down and stepped until then. */
export function settleLanded(frames: BodyFrames, sc: ScenarioDef, placed: { vessel: Vessel; bodyId: string; env: IslandEnv }, tick: number): void {
  if (sc.start.kind !== 'landed') return;
  const v = placed.vessel;
  const bodyId = placed.bodyId;
  const terrain = frames.terrain;
  const steps = Math.round(LANDED_SETTLE_TIME / PHYSICS_DT);
  const tick0 = tick - steps;
  const t0 = utOfTick(tick0);
  const dir = dirFromLatLon(sc.start.latDeg * DEG, sc.start.lonDeg * DEG);
  const base = frames.base(bodyId);
  // Highest terrain under the footprint, so that no probe starts below the surface.
  let h = base.hasTerrain ? terrain.heightAt(bodyId, dir) : 0;
  if (base.hasTerrain) {
    const foot = structureOf(v).boundingRadius;
    const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, dir));
    const north = v3.cross(dir, east);
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      for (const f of [0.5, 1]) {
        const d = v3.normalize(v3.add(dir, v3.scale(v3.add(v3.scale(east, Math.cos(a)), v3.scale(north, Math.sin(a))), (foot * f) / base.info.radius)));
        h = Math.max(h, terrain.heightAt(bodyId, d));
      }
    }
  }
  v.hold = null;
  v.surface = 'none';
  applyPose(v, landedPose(frames.system, bodyId, sc.start.latDeg, sc.start.lonDeg, v, t0, h, LANDED_DROP_HEIGHT));
  const aim = (ut: number): IslandEnv => frames.aim(placed.env, bodyId, v.r, ut);
  for (let i = 0; i < steps; i++) {
    stepVessel(v, aim(utOfTick(tick0 + i)), NEUTRAL_CONTROLS, PHYSICS_DT);
    if (v.destroyed) throw new Error(`scenarios/${sc.id}.json: the vessel broke up while being set down`);
  }
  if (v.hold === null) holdOnGround(v, aim(sc.startUt));
  else rideBody(v, aim(sc.startUt), 0);
}
