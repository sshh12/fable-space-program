/**
 * Which vehicles of a library can be SHOWN (lead decision of 2026-11-24; requests fleet-data-2,
 * capability-settings-2 and fleet-data-3).
 *
 * A vehicle is PRESENTABLE when every one of its parts has a visual definition (`PartDef.visual`, which is
 * null until the part's model is authored: the fleet's data lands a wave before its models). This is derived
 * from the definitions HERE and nowhere else: no list of names, no flag in a file. Everything that shows a
 * vehicle goes by it:
 *   - the vessel feature warms and builds the models of presentable vehicles only, and does not draw a vessel
 *     one of whose parts has no visual (it says so once per vehicle, in its `status()`);
 *   - the effects follow the vessels that are shown (`isPresentableVessel`);
 *   - the menu offers presentable vehicles only (`presentableVehicleIds`);
 *   - a lab or a test that wants "a vehicle of the library" takes the first presentable one
 *     (`firstPresentableVehicleId`) or names its own; one that wants only what can be shown takes
 *     `presentableLibrary`.
 * Pure functions of the definitions; the set of parts without a visual is computed once per library.
 */
import type { DefLibrary, VehicleDef } from '../contracts/defs';

const missing = new WeakMap<DefLibrary, ReadonlySet<string>>();

/** The part definitions of the library that have no visual definition. */
function partsMissingVisual(defs: DefLibrary): ReadonlySet<string> {
  let set = missing.get(defs);
  if (!set) {
    const ids = new Set<string>();
    for (const part of Object.values(defs.parts)) if (!part.visual) ids.add(part.id);
    set = ids;
    missing.set(defs, set);
  }
  return set;
}

/** True when the part definition exists and has a visual definition. */
export function partHasVisual(defs: DefLibrary, partDefId: string): boolean {
  return defs.parts[partDefId] !== undefined && !partsMissingVisual(defs).has(partDefId);
}

/**
 * The part definitions among `partDefIds` that cannot be shown (no visual definition, or not in the library),
 * each once, in the order of their first appearance. Empty = everything can be shown.
 */
export function partsWithoutVisual(defs: DefLibrary, partDefIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of partDefIds) if (!partHasVisual(defs, id) && !out.includes(id)) out.push(id);
  return out;
}

/** True when the vehicle exists and every one of its parts has a visual definition. */
export function isPresentableVehicle(defs: DefLibrary, vehicleId: string): boolean {
  const vehicle = defs.vehicles[vehicleId];
  if (!vehicle) return false;
  for (const p of vehicle.parts) if (!partHasVisual(defs, p.def)) return false;
  return true;
}

/** The presentable vehicles of the library, in the library's order. */
export function presentableVehicleIds(defs: DefLibrary): string[] {
  return Object.keys(defs.vehicles).filter((id) => isPresentableVehicle(defs, id));
}

/** The definitions of the presentable vehicles of the library, in the library's order. */
export function presentableVehicles(defs: DefLibrary): VehicleDef[] {
  return Object.values(defs.vehicles).filter((v) => isPresentableVehicle(defs, v.id));
}

/**
 * The library with its presentable vehicles only and the scenarios that fly them; everything else is the
 * library's own. For a page that wants nothing in it that cannot be shown (a lab, a bench).
 */
export function presentableLibrary(defs: DefLibrary): DefLibrary {
  const vehicles = Object.fromEntries(presentableVehicles(defs).map((v) => [v.id, v]));
  const scenarios = Object.fromEntries(Object.entries(defs.scenarios).filter(([, s]) => s.vehicle in vehicles));
  return { ...defs, vehicles, scenarios };
}

/** The first presentable vehicle of the library, or null when it has none. */
export function firstPresentableVehicleId(defs: DefLibrary): string | null {
  for (const id of Object.keys(defs.vehicles)) if (isPresentableVehicle(defs, id)) return id;
  return null;
}

/**
 * True when a vessel of a snapshot can be shown: every part it has has a visual definition. (A vessel is
 * judged by its own parts, not by its vehicle id: a piece of a vehicle, or an assembly of several craft, is
 * what its part list says.) No allocation: called per vessel and frame.
 */
export function isPresentableVessel(defs: DefLibrary, vessel: { readonly parts: readonly { readonly def: string }[] }): boolean {
  const none = partsMissingVisual(defs);
  for (const p of vessel.parts) if (none.has(p.def) || defs.parts[p.def] === undefined) return false;
  return true;
}
