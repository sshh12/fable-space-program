/**
 * A readable name for a cabin seat, for the toast the game shows when the player changes couches (the `ui:nextSeat`
 * key, request core-6): the cockpit layout's label of the seat where it has one, else the name of the crew
 * member the vehicle definition puts in that seat, else the seat's id.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { listSections } from '@/core/defs/loader';
import { cockpitHost } from '@/camera';

/** What this file reads of a cockpit layout section (`visuals/cockpits/<id>`, the cockpit package's data). */
interface LayoutSeatLabels {
  couches?: { seats?: Record<string, { label?: unknown } | undefined> };
}

export function seatName(defs: DefLibrary, vessel: VesselSnapshot, seatId: string): string {
  const host = cockpitHost(defs, vessel);
  if (host) {
    const label = listSections<LayoutSeatLabels>(defs, 'visuals/cockpits/')[host.cockpitId]?.couches?.seats?.[seatId]?.label;
    if (typeof label === 'string' && label !== '') return label;
  }
  const crew = defs.vehicles[vessel.vehicleId]?.crew.find((c) => c.seat === seatId)?.name;
  return crew ?? seatId;
}
