/**
 * Pads, classes and waits for the spawn flow (ARCHITECTURE 5.9, 9.3, 9.4; user decision of 2026-11-13).
 *
 * Every count comes from the site files (`padsOf`) and every state from the lobby's pad states
 * (`ClientStores.pads`); every rate and threshold from the rules document in force. Nothing here states a pad
 * count, a rate or a horizon. A pad hosts its class and anything smaller, so a vehicle of a class may use the
 * pads of that class and of every larger one, and each class has its own figures.
 */
import { TICKS_PER_SECOND, type PadClass, type PadState, type UniverseRules } from '@/core/contracts/net';
import type { LaunchSiteDef } from '@/core/contracts/defs';
import { padsOf } from '@/core/defs/sites';

/** Classes from the smallest to the largest: the order in which a pad hosts "its class and anything smaller". */
export const PAD_CLASSES: readonly PadClass[] = ['light', 'medium', 'heavy'];

/** True when a pad of class `pad` takes a vehicle of class `vehicle`. */
export const padHosts = (pad: PadClass, vehicle: PadClass): boolean => PAD_CLASSES.indexOf(pad) >= PAD_CLASSES.indexOf(vehicle);

/** Classes a vehicle of class `vehicle` may launch from, its own first. */
export const usableClasses = (vehicle: PadClass): PadClass[] => PAD_CLASSES.filter((c) => padHosts(c, vehicle));

/** One pad as the pad screen lists it: the definition's name and class, and the lobby's state when it has one. */
export interface PadRow {
  siteId: string;
  padId: string;
  name: string;
  class: PadClass;
  /** The lobby's state of the pad; null when the lobby has published none (the screen says so). */
  state: PadState | null;
  /** True when the chosen vehicle's class may use the pad. */
  usable: boolean;
  /** Seconds until its next live slot from the live tick (0 = free now), null when none inside the cohort horizon or unknown. */
  liveWaitSeconds: number | null;
}

/** What one class may expect across the whole launch complex. */
export interface ClassOutlook {
  vehicleClass: PadClass;
  /** Pads in the subscribed sites that take this class (from the site files). */
  padCount: number;
  /** Of them, free at the live tick. */
  freeNow: number;
  /** Shortest wait for a live slot on any pad the class may use, s; null when no live slot exists inside the horizon. */
  liveWaitSeconds: number | null;
  /** Earliest cohort slot on any pad the class may use, as a tick; null when none inside the cohort horizon. */
  cohortTick: number | null;
  /** True when the menu offers the cohort slot (the live wait exceeds `rules.time.cohortOfferWait`). */
  offerCohort: boolean;
  /** True when neither a live nor a cohort slot is free inside the horizon (ARCHITECTURE 5.9: say so plainly). */
  horizonFull: boolean;
}

const waitSeconds = (tick: number | null, liveTick: number): number | null => (tick === null ? null : Math.max(0, (tick - liveTick) / TICKS_PER_SECOND));

/** The pads of `sites` with the lobby's states, the site order of the definitions and each site's pad order. */
export function padRows(sites: readonly LaunchSiteDef[], states: readonly PadState[], vehicleClass: PadClass, liveTick: number): PadRow[] {
  const rows: PadRow[] = [];
  for (const site of sites) {
    for (const pad of padsOf(site)) {
      const state = states.find((s) => s.siteId === site.id && s.padId === pad.id) ?? null;
      rows.push({
        siteId: site.id,
        padId: pad.id,
        name: pad.name,
        class: pad.class,
        state,
        usable: padHosts(pad.class, vehicleClass),
        liveWaitSeconds: state === null ? null : state.state === 'free' ? 0 : waitSeconds(state.nextLiveTick, liveTick),
      });
    }
  }
  return rows;
}

/** The outlook of one vehicle class over the pads of `sites`. */
export function classOutlook(sites: readonly LaunchSiteDef[], states: readonly PadState[], vehicleClass: PadClass, liveTick: number, rules: UniverseRules): ClassOutlook {
  const rows = padRows(sites, states, vehicleClass, liveTick).filter((r) => r.usable);
  const waits = rows.map((r) => r.liveWaitSeconds).filter((w): w is number => w !== null);
  const cohorts = rows.map((r) => r.state?.nextCohortTick ?? null).filter((t): t is number => t !== null);
  const liveWaitSeconds = waits.length > 0 ? Math.min(...waits) : null;
  const cohortTick = cohorts.length > 0 ? Math.min(...cohorts) : null;
  return {
    vehicleClass,
    padCount: rows.length,
    freeNow: rows.filter((r) => r.state?.state === 'free').length,
    liveWaitSeconds,
    cohortTick,
    offerCohort: cohortTick !== null && (liveWaitSeconds === null || liveWaitSeconds > rules.time.cohortOfferWait),
    horizonFull: rows.length > 0 && rows.every((r) => r.state !== null) && liveWaitSeconds === null && cohortTick === null,
  };
}

/** The outlook of every class: what the pad screen shows per class. */
export const classOutlooks = (sites: readonly LaunchSiteDef[], states: readonly PadState[], liveTick: number, rules: UniverseRules): ClassOutlook[] =>
  PAD_CLASSES.map((c) => classOutlook(sites, states, c, liveTick, rules));

/**
 * Launch slots per wall hour that `padCount` pads give with a mean pad cycle of `cycleSeconds` (ARCHITECTURE
 * 5.9: pads x 3600 / cycle). The cycle is a rules figure (request shell-menu-1); with none the rate is unknown
 * and the screen does not state one.
 */
export function launchesPerHour(padCount: number, cycleSeconds: number | null): number | null {
  if (cycleSeconds === null || !(cycleSeconds > 0)) return null;
  return (padCount * 3600) / cycleSeconds;
}

/** How far ahead of the live clock a cohort slot is, s. */
export const cohortLeadSeconds = (cohortTick: number, liveTick: number): number => (cohortTick - liveTick) / TICKS_PER_SECOND;

/**
 * The pad class a vehicle needs, from what is known about it: the analysis (`VehicleCapabilities.padClass`)
 * first, then the definition's pad interface. Null when neither states one (the screen says so and offers only
 * the largest class, `assumedPadClass`).
 */
export function vehiclePadClass(capabilityClass: PadClass | null, interfaceClass: PadClass | null): PadClass | null {
  return capabilityClass ?? interfaceClass;
}

/** The class assumed for a vehicle whose class nothing states: the largest, so no pad that cannot take it is offered. */
export const assumedPadClass = (): PadClass => PAD_CLASSES[PAD_CLASSES.length - 1]!;
