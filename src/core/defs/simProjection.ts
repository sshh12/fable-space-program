/**
 * The SIMULATION PROJECTION of a definition: what the simulation reads of a vehicle and of a part's modules,
 * with the presentation-only fields left out (lead decision of 2026-11-12, made at the tighten step after
 * sub-wave 3.2; MIGRATION_V2 principle 5; PACKAGE_RULES 7a).
 *
 * The vessel codec (src/sim/vessel/codec.ts) names a library vehicle by the hash of THIS projection and a
 * part definition by the fingerprint of THIS projection, and both are in the state hash. So:
 *
 *   - a field that is IN the projection is FROZEN the way rule 7a says: changing it changes the hash of
 *     every state that uses the definition (the golden mission hash among them) and, for a part, needs an
 *     entry in the migration registry;
 *   - a field that is OUT of it is FREE: it can change in a definition file without touching a save, a
 *     recorded blob or a golden hash. The snapshot states such a value from the definitions when it is
 *     built (`CraftSnapshot.cockpit`, the stage labels, the crew names, the chase distances).
 *
 * OUT of the projection, and nothing else:
 *   VehicleDef   `name`; `cameras` (the cockpit camera's part and seat, the chase distances); `cockpit`
 *                (the interior's id); the `label` of a stage group; the `label` and `icon` of a stage; the
 *                `name` of a crew member.
 *   ModuleDef    command: `cockpit`, `sensorCamera`, and of each seat `lookDir` and `upDir` (where the camera
 *                looks). A seat's `id` and `pos` stay in: the crew's g dose is taken at the seat.
 *                engine: `plume` and `sound` (references to a visual and to audio).
 * Everything else is IN, also a field added later: a new field is frozen until it is named here, which is
 * the safe side. (A part's `name`, `visual`, bounds and aerodynamics were never in its fingerprint.)
 *
 * Pure functions of the definition; the result is hashed as canonical JSON.
 */
import type { ModuleDef, PartDef, VehicleDef } from '../contracts/defs';

/** What the saved state of a part depends on in one of its module definitions. */
export function moduleSimProjection(module: ModuleDef): unknown {
  if (module.type === 'command') {
    const { cockpit: _cockpit, sensorCamera: _sensorCamera, seats, ...simulated } = module;
    return { ...simulated, seats: seats.map((s) => ({ id: s.id, pos: s.pos })) };
  }
  if (module.type === 'engine') {
    const { plume: _plume, sound: _sound, ...simulated } = module;
    return simulated;
  }
  return module;
}

/**
 * What the saved state of a part depends on in its definition: its dry mass, its resources, the simulation
 * projection of its modules and the number of its thermal surfaces. (Its looks, bounds and aerodynamics
 * are not saved state; a change of those needs no migration.)
 */
export function partSimProjection(def: PartDef): unknown {
  return { dryMass: def.dryMass, resources: def.resources ?? [], modules: def.modules.map(moduleSimProjection), thermalSurfaces: def.thermal.surfaces.length };
}

/** What the simulation reads of a vehicle. */
export function vehicleSimProjection(vehicle: VehicleDef): unknown {
  const { name: _name, cameras: _cameras, cockpit: _cockpit, stageGroups, stages, crew, ...simulated } = vehicle;
  return {
    ...simulated,
    stageGroups: stageGroups.map((g) => g.id),
    stages: stages.map(({ label: _label, icon: _icon, ...stage }) => stage),
    crew: crew.map((c) => c.seat),
  };
}
