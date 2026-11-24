/**
 * A readable name for a cabin seat, for the toast the game shows when the player changes couches (the `ui:nextSeat`
 * key, request core-6): the cockpit layout's label of the seat where it has one, else the name of the crew
 * member the craft states for that seat, else the seat's id.
 *
 * The cabin is the craft's own (`cabinOf`: its command part and the layout id the snapshot states), and so is
 * the crew (`CraftCockpit.crew`): no vehicle definition is read. A craft that states no crew is named by its
 * seat ids.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { listSections } from '@/core/defs/loader';
import { cabinOf } from '@/core/access/snapshotAccess';

/** What this file reads of a cockpit layout section (`visuals/cockpits/<id>`, the cockpit package's data). */
interface LayoutSeatLabels {
  couches?: { seats?: Record<string, { label?: unknown } | undefined> };
}

export function seatName(defs: DefLibrary, vessel: VesselSnapshot, seatId: string): string {
  const cabin = cabinOf(vessel);
  if (cabin) {
    const label = listSections<LayoutSeatLabels>(defs, 'visuals/cockpits/')[cabin.cockpitId]?.couches?.seats?.[seatId]?.label;
    if (typeof label === 'string' && label !== '') return label;
  }
  const crew = cabin?.craft.cockpit?.crew.find((c) => c.seat === seatId)?.name;
  return crew ?? seatId;
}
