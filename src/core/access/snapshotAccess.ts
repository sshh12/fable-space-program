/**
 * What presentation reads of a snapshot through one function instead of a field: the v2 fields that are
 * optional until the contract tighten after sub-wave 3.2 (MIGRATION_V2 section 3), each with the neutral
 * value its comment in src/core/contracts/sim.ts states, and the ONE place outside the simulation that still
 * reads a deprecated field on a consumer's behalf.
 *
 * Why it is in src/core: every presentation package imports src/core only, so a helper that the HUD, the
 * map, the camera rigs, the render features and the audio engine share has to live here (the lead's answer
 * to request presentation-sweep-1 gave it this directory). The functions are pure, hold no state besides a
 * per-object cache, and import contracts only.
 *
 * At the tighten step:
 *  - `revisionOf` becomes `snapshot.revision` (the field is required then, and `tick` is gone);
 *  - `targetOf` becomes `readouts.target` (`TargetView` is the part of `TargetReadout` that can be derived from
 *    the deprecated pair, with the same field names, so a call site changes by its callee only);
 *  - `craftsOf`, `craftIdOf` and `parentOf` lose their fallbacks.
 */
import type { DefLibrary } from '../contracts/defs';
import type { TargetRef } from '../contracts/net';
import type { CraftSnapshot, PartSnapshot, Readouts, SimSnapshot, VesselSnapshot } from '../contracts/sim';

/** The counter that changes whenever anything in the snapshot may have changed (`SimSnapshot.revision`; a producer older than it states `tick`). */
export function revisionOf(snapshot: SimSnapshot): number {
  return snapshot.revision ?? snapshot.tick;
}

/**
 * The selected target as every consumer reads it: the fields of `TargetReadout` (`Readouts.target`) that exist
 * for a session that does not produce the readout yet. A `TargetReadout` is a `TargetView`.
 */
export interface TargetView {
  ref: TargetRef;
  /** Relative inclination to the target's orbit plane, rad; null when the two are not about the same body. */
  relativeInclination: number | null;
  /** The next closest approaches in time order, at most three; `relSpeed` (m/s) only where the session states it. */
  closestApproaches: readonly { ut: number; distance: number; relSpeed?: number }[];
}

const derivedTargets = new WeakMap<Readouts, TargetView | null>();

/**
 * The selected target, or null without one: `Readouts.target` when the session fills it, else derived from
 * the deprecated `targetBodyId` and `targetClosestApproach` (the contract: "Absent = derive from the
 * deprecated fields"). The derived view of one readouts block is built once.
 */
export function targetOf(readouts: Readouts): TargetView | null {
  if (readouts.target !== undefined) return readouts.target;
  let view = derivedTargets.get(readouts);
  if (view === undefined) {
    view =
      readouts.targetBodyId === null
        ? null
        : {
            ref: { kind: 'body', id: readouts.targetBodyId },
            relativeInclination: readouts.targetRelativeInclination,
            closestApproaches: readouts.targetClosestApproach ? [readouts.targetClosestApproach] : [],
          };
    derivedTargets.set(readouts, view);
  }
  return view;
}

/** The id of the targeted body; null without a target and for a vessel or port target. */
export function targetBodyOf(readouts: Readouts): string | null {
  const target = targetOf(readouts);
  return target !== null && target.ref.kind === 'body' ? target.ref.id : null;
}

/**
 * The name of the selected target as the HUD, the displays and the map show it, or null without a target: the
 * name the session's target readout states, else the body's, the vessel's or (for a port) its vessel's name;
 * an id that names nothing known is shown as it is.
 */
export function targetNameOf(snapshot: SimSnapshot, defs: DefLibrary): string | null {
  const target = targetOf(snapshot.readouts);
  if (target === null) return null;
  const stated = snapshot.readouts.target?.name;
  if (stated !== undefined) return stated;
  const ref = target.ref;
  if (ref.kind === 'body') return defs.bodies[ref.id]?.name ?? ref.id;
  const vesselId = ref.kind === 'vessel' ? ref.id : ref.vesselId;
  const vessels = snapshot.vessels;
  for (let i = 0; i < vessels.length; i++) if (vessels[i]!.id === vesselId) return vessels[i]!.name;
  return vesselId;
}

/** The `TargetRef` of a body (what `PlayerCommands.setTarget` takes for it). */
export const bodyTarget = (bodyId: string): TargetRef => ({ kind: 'body', id: bodyId });

/**
 * The vessel the viewer is seated in, or null: there is none in the menu, for a spectator and between ships
 * (`activeVesselId` is nullable from the tighten step), and an id the snapshot no longer holds names none.
 */
export function activeVesselOf(snapshot: SimSnapshot): VesselSnapshot | null {
  const id: string | null = snapshot.activeVesselId;
  if (id === null) return null;
  const vessels = snapshot.vessels;
  for (let i = 0; i < vessels.length; i++) if (vessels[i]!.id === id) return vessels[i]!;
  return null;
}

const NO_CRAFTS: readonly CraftSnapshot[] = Object.freeze([]);

/** The craft of a vessel, base craft first. A hand-built snapshot without the block has none to describe. */
export function craftsOf(vessel: VesselSnapshot): readonly CraftSnapshot[] {
  return vessel.crafts ?? NO_CRAFTS;
}

/**
 * The id of the craft a part belongs to: `PartSnapshot.craftId`; absent = the vessel's only craft, which in a
 * snapshot without craft blocks is known by the vessel's own id.
 */
export function craftIdOf(vessel: VesselSnapshot, part: PartSnapshot): string {
  return part.craftId ?? vessel.crafts?.[0]?.id ?? vessel.id;
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
  if (!crafts) return null;
  for (let i = 0; i < crafts.length; i++) if (crafts[i]!.id === craftId) return crafts[i]!;
  return null;
}

/** The craft a craft separated from (`CraftSnapshot.parent`); null for a launched craft and where it is not produced. */
export const parentOf = (craft: CraftSnapshot): string | null => craft.parent ?? null;

/**
 * The part of a vessel that an EVENT names (`partId`, `otherPartId`, `partsDestroyed`). Until the tighten
 * step an event part id has two forms (the contract's `SimEvent`): a part key `craftId/instanceId` in a vessel
 * of several craft, the instance id of the vessel's only craft otherwise; telling them apart by the '/' is
 * the one test on an id string the contract allows.
 */
export function eventPartOf(vessel: VesselSnapshot, eventPartId: string): PartSnapshot | null {
  const parts = vessel.parts;
  if (eventPartId.includes('/')) {
    for (let i = 0; i < parts.length; i++) if (partKeyOf(vessel, parts[i]!) === eventPartId) return parts[i]!;
    return null;
  }
  for (let i = 0; i < parts.length; i++) if (parts[i]!.instanceId === eventPartId) return parts[i]!;
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

/** The part of `vessel` that an event part id names (the two forms as in `findEventPart`), or null. */
function eventPartIn(snapshot: SimSnapshot, vessel: VesselSnapshot, eventPartId: string, keyed: boolean): PartSnapshot | null {
  const parts = vessel.parts;
  for (let j = 0; j < parts.length; j++) {
    const part = parts[j]!;
    if (!keyed) {
      if (part.instanceId === eventPartId) return part;
      continue;
    }
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
 * The part an EVENT names, with the vessel that holds it now. A separation in the tick of the event may
 * already have moved the part into a piece, which is a craft of its own (`CraftSnapshot.parent` names the
 * craft it left), while the event still names the part by the craft it was a part of: so in the part-key form
 * a part answers to the key of its own craft and of every craft up its line of descent that the snapshot
 * describes. Keys are composed and compared; no id is taken apart.
 *
 * `event` is the event the id comes from (any `SimEvent`). Its own vessel is searched first, then the vessels
 * it made, in its order: the part is in one of them unless a later separation took it further. That order
 * decides the instance-id form, because an instance id is unique within a craft only: another vessel of the
 * same vehicle carries the same ids, so in a vessel the event does not name an instance id is evidence of
 * nothing and is not looked for there (the part a jettisoned fairing was is in no vessel any more; the
 * fairing of the vehicle beside it is not it). A part key is unique in the snapshot and is looked for in
 * every vessel. Without `event` every vessel is searched in the snapshot's order, in both forms: that is for
 * a caller that has the id and nothing else.
 */
export function findEventPart(snapshot: SimSnapshot, eventPartId: string, event?: EventVessels): { vessel: VesselSnapshot; part: PartSnapshot } | null {
  const keyed = eventPartId.includes('/');
  const vessels = snapshot.vessels;
  if (event !== undefined) {
    const made = event.newVesselIds;
    const count = made === undefined ? 0 : made.length;
    for (let n = -1; n < count; n++) {
      const id = n < 0 ? event.vesselId : made![n]!;
      for (let i = 0; i < vessels.length; i++) {
        const vessel = vessels[i]!;
        if (vessel.id !== id) continue;
        const part = eventPartIn(snapshot, vessel, eventPartId, keyed);
        if (part !== null) return { vessel, part };
      }
    }
    if (!keyed) return null;
  }
  for (let i = 0; i < vessels.length; i++) {
    const vessel = vessels[i]!;
    const part = eventPartIn(snapshot, vessel, eventPartId, keyed);
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
    if (!crafts) continue;
    for (let j = 0; j < crafts.length; j++) if (crafts[j]!.id === craftId) return crafts[j]!.parent ?? null;
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
 * probe whose first-person view is the sensor camera, a hand-built snapshot without craft blocks.
 */
export function cabinOf(vessel: VesselSnapshot): CabinRef | null {
  const crafts = vessel.crafts;
  if (!crafts) return null;
  const helm = vessel.helm?.craftId;
  // Two passes over the same list: the helm's craft, then the others in their order.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < crafts.length; i++) {
      const craft = crafts[i]!;
      if ((craft.id === helm) !== (pass === 0)) continue;
      const cabin = craft.cockpit;
      if (!cabin || cabin.id === null || craft.commandPart === null) continue;
      const parts = vessel.parts;
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j]!;
        if (part.instanceId === craft.commandPart && craftIdOf(vessel, part) === craft.id) return { craft, part, cockpitId: cabin.id, cameraSeat: cabin.cameraSeat };
      }
    }
  }
  return null;
}
