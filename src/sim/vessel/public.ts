/**
 * FROZEN facade of the vessel package for the vehicle, cockpit and vfx teams (labs and tests) - the only
 * module of src/sim they may import (docs/ARCHITECTURE.md section 2). Nothing here needs a
 * VesselEnvironment. The signatures below must not change; see docs/handoff/sim-vessel.md.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { PartSnapshot } from '@/core/contracts/sim';
import { buildVehicle, cloneVessel, type CraftIdentity } from './assemble';
import { vesselPartSnapshots as partSnapshots } from './facade';
import { computeMassProps } from './massProps';
import { applyStageInstant } from './staging';
import { structureOf } from './structure';
import type { Vessel } from './types';

export type { Vessel } from './types';

/**
 * Build the runtime vessel of `vehicleId`: attach nodes resolved into part poses (PartSnapshot.localPos /
 * localRot in the VES frame of the root part), full tanks, neutral module states.
 *
 * `stagesAlreadyFired` = n applies stage-stack entries 0..n-1 structurally: dropped parts are discarded,
 * engines ignited by those stages are armed (`active`, no thrust until throttle is applied by a
 * simulation), spent solid motors are empty, deployed legs / parachutes are in their end state.
 * The vessel sits at the origin with identity attitude; placing it in the world is the orchestrator's job.
 *
 * The vessel is one craft (ARCHITECTURE 7.2). `craft` says who it is: its id from the universe's id source,
 * its owner, name, the tick it was made at and its lend policy; without it the craft id (and so the vessel
 * id) is the vehicle id, nobody owns it and it lends by the default policy, which is what a lab's display
 * vessel needs.
 */
export function assembleVessel(defs: DefLibrary, vehicleId: string, options: { stagesAlreadyFired?: number; craft?: CraftIdentity } = {}): Vessel {
  const vessel = buildVehicle(defs, vehicleId, options.craft);
  const fired = options.stagesAlreadyFired ?? 0;
  const stages = vessel.crafts[0]!.vehicle.stages.length;
  if (!Number.isInteger(fired) || fired < 0 || fired > stages) {
    throw new Error(`assembleVessel: stagesAlreadyFired must be an integer in 0..${stages}`);
  }
  for (let i = 0; i < fired; i++) applyStageInstant(vessel, i);
  computeMassProps(vessel);
  structureOf(vessel);
  return vessel;
}

/**
 * Part poses and module states of a vessel as PartSnapshot[] (deep copies, shielding flags set).
 * Fits FakeSimOptions.parts and SimSnapshot vessels[].parts.
 */
export function vesselPartSnapshots(vessel: Vessel): PartSnapshot[] {
  return partSnapshots(vessel);
}

/**
 * Lab helper: merge `patch` into module `moduleIndex` of part `instanceId` inside a PartSnapshot[] (in
 * place), e.g. `{ throttleActual: 1, thrust: 4.0e6 }` on an engine, `{ deploy: 1 }` on legs,
 * `{ state: 'full', inflation: 1 }` on a parachute. The module `type` cannot be changed.
 * Throws when the part or module does not exist.
 */
export function setModuleStateForLab(parts: PartSnapshot[], instanceId: string, moduleIndex: number, patch: Record<string, unknown>): void {
  const part = parts.find((p) => p.instanceId === instanceId);
  if (!part) throw new Error(`setModuleStateForLab: no part "${instanceId}"`);
  const module = part.modules[moduleIndex];
  if (!module) throw new Error(`setModuleStateForLab: part "${instanceId}" has no module ${moduleIndex}`);
  if ('type' in patch && patch['type'] !== module.type) throw new Error('setModuleStateForLab: the module type cannot be changed');
  Object.assign(module, patch);
}

/**
 * The structural result of firing stage-stack entry `stageIndex` on `vessel`, without dynamics: every
 * action of the stage is applied at once. Returns a NEW continuing vessel and the separated vessels
 * (spent stages, the launch clamps as one vessel, one vessel per fairing panel with instance id
 * `<fairingId>#panel<k>`); the input vessel is not modified. All vessels share the position and attitude
 * conventions of the input: each spawned vessel's `r`, `q` place its own root part where it was at
 * separation, so drawing every returned vessel reproduces the stack at the instant of separation.
 * Fire stages in order (0, 1, 2, ...) by feeding the returned `vessel` back in.
 */
export function splitForStage(defs: DefLibrary, vessel: Vessel, stageIndex: number): { vessel: Vessel; spawned: Vessel[] } {
  const vehicleId = vessel.crafts[vessel.helm.craft]!.vehicleId;
  if (!defs.vehicles[vehicleId]) throw new Error(`splitForStage: unknown vehicle "${vehicleId}"`);
  const next = cloneVessel(vessel);
  const spawned = applyStageInstant(next, stageIndex);
  computeMassProps(next);
  for (const v of spawned) {
    computeMassProps(v);
    structureOf(v);
  }
  return { vessel: next, spawned };
}
