/**
 * Runtime ids (docs/ARCHITECTURE.md section 3, "Ids").
 *
 *   craft that was launched                 craftId, issued by an injected CraftIdSource; never changes
 *   craft that left another as a piece      <parent craft id>.<instance id of its root part>   (pieceCraftId)
 *   part, outside its vessel                craftId/instanceId (the PART KEY; instanceId is unique within the craft)
 *   vessel of one launched craft            vesselId = craftId
 *   vessel of one piece craft               <launched craft at the top of its lineage>~<instance id of its root part>
 *   vessel of two or more craft             a~<lowest vessel id of the two that first docked>~<tick>
 *
 * CRAFT IDS ARE UNIQUE. A craft has one part tree with one root. At a separation the piece that holds a
 * craft's root part keeps the craft (its id and its live stage stack); every other piece that takes parts
 * of it away is a NEW craft whose id is derived from its parent's and whose `parent` records the lineage.
 * Two former pieces of one craft are therefore two craft, and docking them again is ordinary docking.
 * A vehicle whose file mates two trees by docking ports assembles into as many craft as it has trees.
 *
 * Alphabet. An id issued by a source and a part's instance id contain neither '/' (the part key's
 * separator), nor '~' (the separator of derived vessel ids), nor '.' (the separator of a piece craft's
 * lineage); so every composed form parses without a table, and a derived craft id cannot collide with an
 * issued one. The vessel id of a piece keeps the form it always had, so whatever is keyed by vessel id
 * (presentation state, worldlines) is unaffected by pieces being craft.
 *
 * Every id is a deterministic function of ids and ticks: a replay, a rollback and a re-run of a split
 * issue the same ones (a piece craft's id does not come from the counter of a source).
 */
import type { CraftRuntime, PartRuntime, Vessel } from './types';

/** Issues the ids of launched craft. The universe injects one; ids are unique within it and never reused. */
export interface CraftIdSource {
  /** The id of a new craft built from vehicle `vehicleId`. It contains none of the separators (assertIssuedId). */
  next(vehicleId: string): string;
}

/** The characters that compose ids: none of them may be inside an issued craft id or an instance id. */
export const ID_SEPARATORS: readonly string[] = ['/', '~', '.'];

/** Throws unless `id` is usable as an issued craft id or an instance id: not empty, none of the separators inside. */
export function assertIssuedId(id: string, what: string): void {
  if (typeof id !== 'string' || id === '') throw new Error(`${what}: an id must be a non-empty string`);
  for (const sep of ID_SEPARATORS) {
    if (id.includes(sep)) throw new Error(`${what}: "${id}" contains '${sep}', which composes runtime ids ('/' the part key, '~' derived vessel ids, '.' the lineage of a piece craft)`);
  }
}

/** The id of the craft that leaves craft `parentCraftId` as the piece whose root part is `rootInstanceId`. */
export const pieceCraftId = (parentCraftId: string, rootInstanceId: string): string => `${parentCraftId}.${rootInstanceId}`;

/** The launched craft at the top of a craft's lineage (the craft itself when it was launched). */
export function launchedCraftId(craftId: string): string {
  const dot = craftId.indexOf('.');
  return dot < 0 ? craftId : craftId.slice(0, dot);
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
      const id = n === 1 ? `${seed}${vehicleId}` : `${seed}${vehicleId}-${n}`;
      assertIssuedId(id, 'seededCraftIds');
      return id;
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
 * Index of the part a PART KEY names, -1 when it is not on this vessel. A key is `craftId/instanceId`: a
 * string without a '/' is not a key and names nothing (an instance id alone is ambiguous outside its craft;
 * inside one, use findCraftPart).
 */
export function findPartByKey(vessel: Vessel, key: string): number {
  const slash = key.indexOf('/');
  if (slash < 0) return -1;
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

/** Instance id of the root part of a craft (the part the craft's identity goes with). */
export function craftRootInstanceId(craft: CraftRuntime): string {
  return craft.root;
}

/** The record of the craft that leaves `from` at `tick` as the piece whose root part is `rootInstanceId`: a copy of the stage state under a new id, with the lineage. */
export function pieceCraft(from: CraftRuntime, rootInstanceId: string, tick: number): CraftRuntime {
  return {
    ...from,
    craftId: pieceCraftId(from.craftId, rootInstanceId),
    parent: from.craftId,
    root: rootInstanceId,
    joinedTick: tick,
    pending: [],
    policy: { ...from.policy, helm: typeof from.policy.helm === 'string' ? from.policy.helm : from.policy.helm.slice() },
  };
}

/**
 * The id of a vessel of ONE craft: the craft id for a craft that was launched; for a piece craft the form
 * a piece always had, `<launched craft of its lineage>~<instance id of its root part>`.
 */
export function singleCraftVesselId(craft: CraftRuntime): string {
  return craft.parent === null ? craft.craftId : `${launchedCraftId(craft.craftId)}~${craft.root}`;
}
