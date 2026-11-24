/**
 * What presentation reads of a snapshot through one function instead of a field: the questions several
 * packages ask of it (the vessel the viewer is seated in, the craft of a part, the key of a part, the part an
 * event names, the lineage of a craft, the cabin of a vessel), each answered in one place.
 *
 * Why it is in src/core: every presentation package imports src/core only, so a helper that the HUD, the
 * map, the camera rigs, the render features and the audio engine share has to live here (the lead's answer
 * to request presentation-sweep-1 gave it this directory). The functions are pure, hold no state besides a
 * per-object cache, and import contracts only.
 *
 * Since the tighten step after sub-wave 3.2 every v2 field of a snapshot is required, so nothing here has a
 * fallback for a missing one: a consumer reads `snapshot.revision` and `readouts.target` themselves (the
 * functions `revisionOf` and `targetOf` that stood in front of them are gone), `craftsOf`, `craftIdOf` and
 * `parentOf` are the fields, and an event names a part by its part key only.
 */
import type { TargetRef } from '../contracts/net';
import type { CraftSnapshot, PartSnapshot, Readouts, SimSnapshot, VesselSnapshot } from '../contracts/sim';

/** The id of the targeted body; null without a target and for a vessel or port target. */
export function targetBodyOf(readouts: Readouts): string | null {
  const target = readouts.target;
  return target !== null && target.ref.kind === 'body' ? target.ref.id : null;
}

/**
 * The name of the selected target as the HUD, the displays and the map show it, or null without a target: the
 * name the session's target readout states (`TargetReadout.name`).
 */
export function targetNameOf(snapshot: SimSnapshot): string | null {
  const target = snapshot.readouts.target;
  return target === null ? null : target.name;
}

/** The `TargetRef` of a body (what `PlayerCommands.setTarget` takes for it). */
export const bodyTarget = (bodyId: string): TargetRef => ({ kind: 'body', id: bodyId });

/**
 * The vessel the viewer is seated in, or null: there is none in the menu, for a spectator and between ships
 * (`activeVesselId` is null), and an id the snapshot no longer holds names none.
 */
export function activeVesselOf(snapshot: SimSnapshot): VesselSnapshot | null {
  const id = snapshot.activeVesselId;
  if (id === null) return null;
  const vessels = snapshot.vessels;
  for (let i = 0; i < vessels.length; i++) if (vessels[i]!.id === id) return vessels[i]!;
  return null;
}

/** The craft of a vessel, base craft first (`VesselSnapshot.crafts`). */
export function craftsOf(vessel: VesselSnapshot): readonly CraftSnapshot[] {
  return vessel.crafts;
}

/** The id of the craft a part belongs to (`PartSnapshot.craftId`; the vessel is not consulted). */
export function craftIdOf(_vessel: VesselSnapshot, part: PartSnapshot): string {
  return part.craftId;
}

/** The part key `craftId/instanceId`: how a part is addressed outside its craft (the contract's "Ids"). */
export function partKeyOf(vessel: VesselSnapshot, part: PartSnapshot): string {
  return `${craftIdOf(vessel, part)}/${part.instanceId}`;
}

/** The part key of an instance id within a craft. */
export const partKey = (craftId: string, instanceId: string): string => `${craftId}/${instanceId}`;

/** The craft `craftId` of a vessel, or null. */
export function craftOf(vessel: VesselSnapshot, craftId: string): CraftSnapshot | null {
  const crafts = vessel.crafts;
  for (let i = 0; i < crafts.length; i++) if (crafts[i]!.id === craftId) return crafts[i]!;
  return null;
}

/** The craft a craft separated from (`CraftSnapshot.parent`); null for a launched craft. */
export const parentOf = (craft: CraftSnapshot): string | null => craft.parent;

/**
 * The part of a vessel that an EVENT names (`partId`, `otherPartId`, `partsDestroyed`): the part whose part
 * key `craftId/instanceId` the id is (the one form of an event part id, the contract's `SimEvent`). Keys are
 * composed and compared; no id is taken apart.
 */
export function eventPartOf(vessel: VesselSnapshot, eventPartId: string): PartSnapshot | null {
  const parts = vessel.parts;
  for (let i = 0; i < parts.length; i++) if (partKeyOf(vessel, parts[i]!) === eventPartId) return parts[i]!;
  return null;
}

/**
 * The vessels an EVENT names: the one it happened to (`vesselId`, which every event states) and the ones it
 * made (`newVesselIds` of a separation). Every `SimEvent` is one.
 */
export interface EventVessels {
  vesselId: string;
  newVesselIds?: readonly string[];
}

/** The part of `vessel` that an event part id names (a part key, as in `findEventPart`), or null. */
function eventPartIn(snapshot: SimSnapshot, vessel: VesselSnapshot, eventPartId: string): PartSnapshot | null {
  const parts = vessel.parts;
  for (let j = 0; j < parts.length; j++) {
    const part = parts[j]!;
    let craftId: string | null = craftIdOf(vessel, part);
    // (The bound only ends a malformed cycle of parents.)
    for (let hops = 0; craftId !== null && hops < 256; hops++) {
      if (partKey(craftId, part.instanceId) === eventPartId) return part;
      craftId = parentInSnapshot(snapshot, craftId);
    }
  }
  return null;
}

/**
 * The part an EVENT names, with the vessel that holds it now. An event names a part by its part key
 * `craftId/instanceId`. A separation in the tick of the event may already have moved the part into a piece,
 * which is a craft of its own (`CraftSnapshot.parent` names the craft it left), while the event still names
 * the part by the craft it was a part of: so a part answers to the key of its own craft and of every craft up
 * its line of descent that the snapshot describes. Keys are composed and compared; no id is taken apart.
 *
 * `event` is the event the id comes from (any `SimEvent`). Its own vessel is searched first, then the vessels
 * it made, in its order: the part is in one of them unless a later separation took it further, and then every
 * vessel of the snapshot is searched in the snapshot's order (a part key is unique in the snapshot: another
 * vessel of the same vehicle carries the same instance ids under another craft id, so its parts do not answer
 * to it; the part a jettisoned fairing was is in no vessel any more and is found nowhere). Without `event`
 * every vessel is searched in the snapshot's order: that is for a caller that has the id and nothing else.
 */
export function findEventPart(snapshot: SimSnapshot, eventPartId: string, event?: EventVessels): { vessel: VesselSnapshot; part: PartSnapshot } | null {
  const vessels = snapshot.vessels;
  if (event !== undefined) {
    const made = event.newVesselIds;
    const count = made === undefined ? 0 : made.length;
    for (let n = -1; n < count; n++) {
      const id = n < 0 ? event.vesselId : made![n]!;
      for (let i = 0; i < vessels.length; i++) {
        const vessel = vessels[i]!;
        if (vessel.id !== id) continue;
        const part = eventPartIn(snapshot, vessel, eventPartId);
        if (part !== null) return { vessel, part };
      }
    }
  }
  for (let i = 0; i < vessels.length; i++) {
    const vessel = vessels[i]!;
    const part = eventPartIn(snapshot, vessel, eventPartId);
    if (part !== null) return { vessel, part };
  }
  return null;
}

/**
 * The lineage of craft, for whoever keeps presentation state per part across a separation (wear and soot of
 * the vehicle feature, emitters and decals of the effects, voices of the audio engine).
 *
 * A part keeps its instance id when a separation moves it into a new craft (a piece of debris is a craft of
 * its own whose `parent` is the craft it left), so the state of a part is filed under the LINEAGE KEY: the
 * part key of the launched craft at the top of its craft's line of descent and its instance id. Two launched
 * craft of one vehicle are two lineages, docked or not, so their parts never share a key; a piece and the
 * part it was share one.
 *
 * The top of a line is found by following `CraftSnapshot.parent` while the parent is described: by this
 * snapshot, or by an earlier one this table saw. A parent that has left the snapshot is still named by its
 * piece, so the chain ends at the first craft nobody described. The answer for a craft is remembered, and so
 * is the same in every later frame, whatever leaves the snapshot afterwards. No id is taken apart.
 *
 * The table is as large as its holder lets it be: `retain` forgets every craft the holder's state can no
 * longer reach (a flight sheds stages, petals and debris without end; each is a craft). A craft that was
 * forgotten and is seen again is resolved afresh from the snapshot it is seen in, so the holder forgets a
 * craft together with the state it filed under the keys of that craft's parts.
 */
export class CraftLineage {
  private readonly roots = new Map<string, string>();

  /** The craft at the top of the lineage of `craftId`: itself for a launched craft and for one nobody described. */
  rootOf(snapshot: SimSnapshot, craftId: string): string {
    const known = this.roots.get(craftId);
    if (known !== undefined) return known;
    let id = craftId;
    // A lineage is as deep as a craft was cut into pieces of pieces; the bound only ends a malformed cycle.
    for (let hops = 0; hops < 256; hops++) {
      const resolved = this.roots.get(id);
      if (resolved !== undefined) {
        id = resolved;
        break;
      }
      const parent = parentInSnapshot(snapshot, id);
      if (parent === null) break;
      id = parent;
    }
    this.roots.set(craftId, id);
    return id;
  }

  /** As `rootOf` for a craft this table has resolved before; a craft it never saw is its own root. */
  knownRootOf(craftId: string): string {
    return this.roots.get(craftId) ?? craftId;
  }

  /** The lineage key of a part of a vessel of `snapshot`. */
  keyOf(snapshot: SimSnapshot, vessel: VesselSnapshot, part: PartSnapshot): string {
    return partKey(this.rootOf(snapshot, craftIdOf(vessel, part)), part.instanceId);
  }

  /** The lineage key of the part `instanceId` of the craft `craftId`, from what the table has resolved. */
  knownKeyOf(craftId: string, instanceId: string): string {
    return partKey(this.knownRootOf(craftId), instanceId);
  }

  /** True when the table holds an answer for `craftId`: it resolved the craft and has not forgotten it since. */
  knows(craftId: string): boolean {
    return this.roots.has(craftId);
  }

  /**
   * Forget every craft that is not in `live`: the craft the holder's state can still reach (those that the
   * parts of the vessels it shows are of). The answers for the craft in `live` stay as they are, also where
   * the line of one passes through a craft that is forgotten here.
   */
  retain(live: ReadonlySet<string>): void {
    for (const craftId of this.roots.keys()) if (!live.has(craftId)) this.roots.delete(craftId);
  }

  /** The number of craft the table holds an answer for. */
  get size(): number {
    return this.roots.size;
  }

  clear(): void {
    this.roots.clear();
  }
}

/** `CraftSnapshot.parent` of the craft `craftId` where the snapshot holds that craft; null otherwise. */
function parentInSnapshot(snapshot: SimSnapshot, craftId: string): string | null {
  const vessels = snapshot.vessels;
  for (let i = 0; i < vessels.length; i++) {
    const crafts = vessels[i]!.crafts;
    for (let j = 0; j < crafts.length; j++) if (crafts[j]!.id === craftId) return crafts[j]!.parent;
  }
  return null;
}

/** A cabin of a vessel: the craft that has it, its command part in the part list, and what the craft states of it. */
export interface CabinRef {
  craft: CraftSnapshot;
  part: PartSnapshot;
  /** Cockpit interior layout id (`CraftCockpit.id`). */
  cockpitId: string;
  /** The seat of the command part the craft puts its camera in (`CraftCockpit.cameraSeat`). */
  cameraSeat: string | null;
}

/**
 * The cabin the viewer looks out of in a vessel: the craft at the helm when it has one, else the first other
 * craft with one. A cabin is what the craft states (`CraftSnapshot.commandPart` and `.cockpit` with a layout
 * id) and the part of THAT craft with the command part's instance id, so two craft of one vehicle in an
 * assembly each have their own; no vehicle definition is read. Null for a vessel without a cabin: debris, a
 * probe whose first-person view is the sensor camera.
 */
export function cabinOf(vessel: VesselSnapshot): CabinRef | null {
  const crafts = vessel.crafts;
  const helm = vessel.helm.craftId;
  // Two passes over the same list: the helm's craft, then the others in their order.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < crafts.length; i++) {
      const craft = crafts[i]!;
      if ((craft.id === helm) !== (pass === 0)) continue;
      const cabin = craft.cockpit;
      if (cabin === null || cabin.id === null || craft.commandPart === null) continue;
      const parts = vessel.parts;
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j]!;
        if (part.instanceId === craft.commandPart && craftIdOf(vessel, part) === craft.id) return { craft, part, cockpitId: cabin.id, cameraSeat: cabin.cameraSeat };
      }
    }
  }
  return null;
}
