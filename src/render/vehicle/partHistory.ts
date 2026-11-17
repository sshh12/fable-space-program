/**
 * The presentation state the vessel feature keeps per part (`PartAnim`: the nozzle temperature after a burn,
 * soot, frost that sheds after lift-off, eased arms, antennas and lamps), filed under the part's LINEAGE key
 * (`CraftLineage`): a piece that leaves a craft keeps the state of the parts it took, and two craft of one
 * vehicle never share any.
 *
 * It is bounded by what is drawn. `prune` forgets the state of every part that is in no vessel of the
 * snapshot and in no vessel still fading out, and with it the lineage of every craft those vessels have no
 * part of: a flight that sheds stages, petals and debris for hours holds the state of the parts that exist,
 * not of every part that ever did. A vessel that leaves the snapshot and comes back starts from what the
 * snapshot shows of it, as a vessel seen for the first time does.
 *
 * Pure: no GPU and no clock. The feature says when to prune.
 */
import type { PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { CraftLineage, craftIdOf, partKey } from '@/core/access/snapshotAccess';
import { NEUTRAL_ANIM, type PartAnim } from './parts/types';

/** True when a part of the craft `craftId` is in a vessel of the snapshot. */
function holdsCraft(snapshot: SimSnapshot, craftId: string): boolean {
  for (const vessel of snapshot.vessels) for (const part of vessel.parts) if (craftIdOf(vessel, part) === craftId) return true;
  return false;
}

export class PartHistory {
  private readonly anims = new Map<string, PartAnim>();
  /** Whose parts a craft's parts continue. */
  private readonly lineage = new CraftLineage();

  /** The state filed under a lineage key. A part that has none starts neutral, its frost not taken yet (-1). */
  private at(key: string): PartAnim {
    let a = this.anims.get(key);
    if (!a) {
      a = { ...NEUTRAL_ANIM, frost: -1 };
      this.anims.set(key, a);
    }
    return a;
  }

  /** The state of a part of a vessel of `snapshot`. */
  of(snapshot: SimSnapshot, vessel: VesselSnapshot, part: PartSnapshot): PartAnim {
    return this.at(this.lineage.keyOf(snapshot, vessel, part));
  }

  /**
   * The state of the part `instanceId` of the craft `craftId`, for a caller that has the two ids and no
   * snapshot (a lab, a test). `latest` is the last snapshot the holder was given, null before the first.
   *
   * A craft that was resolved before answers as it did. A craft that `latest` holds and that was not resolved
   * (nothing of it was drawn) is resolved through its line of descent now, so the state of a piece's part is
   * the state of the part it was. A craft that no snapshot has shown is taken for a launched craft and nothing
   * is remembered about it: should it turn out to be a piece, its parts do not reach what was filed for it
   * here, and that goes with the next `prune`.
   */
  byId(latest: SimSnapshot | null, craftId: string, instanceId: string): PartAnim {
    if (!this.lineage.knows(craftId) && latest !== null && holdsCraft(latest, craftId)) return this.at(partKey(this.lineage.rootOf(latest, craftId), instanceId));
    return this.at(this.lineage.knownKeyOf(craftId, instanceId));
  }

  /**
   * Forget what nothing drawn can reach: the state of every part that is neither in a vessel of `snapshot`
   * nor in one of `held` (the vessels that left the snapshot and are still shown, fading out), and the lineage
   * of every craft none of those vessels has a part of.
   */
  prune(snapshot: SimSnapshot, held: readonly VesselSnapshot[]): void {
    const keys = new Set<string>();
    const crafts = new Set<string>();
    for (const vessel of snapshot.vessels) {
      for (const part of vessel.parts) {
        crafts.add(craftIdOf(vessel, part));
        keys.add(this.lineage.keyOf(snapshot, vessel, part));
      }
    }
    // A held vessel is not in the snapshot any more: its craft are known from the frames it was drawn in, and
    // stay known for as long as it is held.
    for (const vessel of held) {
      for (const part of vessel.parts) {
        const craftId = craftIdOf(vessel, part);
        crafts.add(craftId);
        keys.add(this.lineage.knownKeyOf(craftId, part.instanceId));
      }
    }
    for (const key of this.anims.keys()) if (!keys.has(key)) this.anims.delete(key);
    this.lineage.retain(crafts);
  }

  /** The number of parts that have a state, and of craft whose lineage is remembered. */
  get size(): number {
    return this.anims.size;
  }
  get crafts(): number {
    return this.lineage.size;
  }

  clear(): void {
    this.anims.clear();
    this.lineage.clear();
  }
}
