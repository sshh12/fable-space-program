/**
 * Runtime ids (docs/ARCHITECTURE.md section 3, "Ids").
 *
 *   craft                                   craftId, issued by an injected CraftIdSource; never changes
 *   part, outside its vessel                craftId/instanceId (the PART KEY; instanceId is unique within the craft)
 *   whole single craft (holds its root)     vesselId = craftId
 *   piece of one craft without its root     <craftId>~<root part instance id of the piece>
 *   vessel of two or more craft             a~<lowest vessel id of the two that first docked>~<tick>
 *
 * Every id is a deterministic function of ids and ticks, so a replay issues the same ones.
 */
import type { CraftRuntime, PartRuntime, Vessel } from './types';

/** Issues craft ids. The universe injects one; ids are unique within it and never reused. */
export interface CraftIdSource {
  /** The id of a new craft built from vehicle `vehicleId`. */
  next(vehicleId: string): string;
}

/**
 * The local universe's source: a seeded counter per vehicle, so tests and replays are reproducible. The
 * first craft of a vehicle is `<seed><vehicleId>`, the n-th `<seed><vehicleId>-<n>`.
 */
export function seededCraftIds(seed = ''): CraftIdSource {
  const issued = new Map<string, number>();
  return {
    next(vehicleId: string): string {
      const n = (issued.get(vehicleId) ?? 0) + 1;
      issued.set(vehicleId, n);
      return n === 1 ? `${seed}${vehicleId}` : `${seed}${vehicleId}-${n}`;
    },
  };
}

export const ASSEMBLY_ID_PREFIX = 'a~';

/** The id of a vessel of two or more craft that is formed at `tick` by the vessels `idA` and `idB`. */
export function assemblyId(idA: string, idB: string, tick: number): string {
  return `${ASSEMBLY_ID_PREFIX}${idA < idB ? idA : idB}~${tick}`;
}

export const isAssemblyId = (vesselId: string): boolean => vesselId.startsWith(ASSEMBLY_ID_PREFIX);

/** The part key of a part: how it is addressed outside its vessel. */
export const partKey = (craftId: string, instanceId: string): string => `${craftId}/${instanceId}`;

export function partKeyOf(vessel: Vessel, index: number): string {
  const p = vessel.parts[index]!;
  return partKey(vessel.crafts[p.craft]!.craftId, p.instanceId);
}

/**
 * Index of the part a key names, -1 when it is not on this vessel. A bare instance id (no '/') is accepted
 * when exactly one part of the vessel carries it.
 */
export function findPartByKey(vessel: Vessel, key: string): number {
  const slash = key.indexOf('/');
  if (slash < 0) {
    let found = -1;
    for (let i = 0; i < vessel.parts.length; i++) {
      if (vessel.parts[i]!.instanceId !== key) continue;
      if (found >= 0) return -1;
      found = i;
    }
    return found;
  }
  const craftId = key.slice(0, slash);
  const instanceId = key.slice(slash + 1);
  for (let i = 0; i < vessel.parts.length; i++) {
    const p = vessel.parts[i]!;
    if (p.instanceId === instanceId && vessel.crafts[p.craft]!.craftId === craftId) return i;
  }
  return -1;
}

/** Index of the part `instanceId` of craft `craft` (an index into `vessel.crafts`), -1 when it is not aboard. */
export function findCraftPart(vessel: Vessel, craft: number, instanceId: string): number {
  const parts = vessel.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.craft === craft && p.instanceId === instanceId) return i;
  }
  return -1;
}

/**
 * The `partId` an event names a part with. A vessel of ONE craft names it by its instance id, which is what
 * every consumer of the v1 events matches against `PartSnapshot.instanceId`; a vessel of several craft names
 * it by its part key, the only unambiguous form there. (The presentation sweep moves the consumers to part
 * keys; from then on this can return the key always.)
 */
export function eventPartId(vessel: Vessel, part: PartRuntime): string {
  return vessel.crafts.length === 1 ? part.instanceId : partKey(vessel.crafts[part.craft]!.craftId, part.instanceId);
}

/** Instance id of the root part of a craft's vehicle (the part the craft's identity goes with). */
export function craftRootInstanceId(craft: CraftRuntime): string {
  const root = craft.vehicle.parts.find((p) => p.parent === null);
  return root ? root.id : '';
}

/**
 * The id of a vessel of ONE craft made of `parts` (in vessel order): the craft id when it holds the craft's
 * root part, else the piece form with the instance id of its first part.
 */
export function singleCraftVesselId(craft: CraftRuntime, parts: readonly PartRuntime[]): string {
  const rootId = craftRootInstanceId(craft);
  return parts.some((p) => p.instanceId === rootId) ? craft.craftId : `${craft.craftId}~${parts[0]!.instanceId}`;
}
