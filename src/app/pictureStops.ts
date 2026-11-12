/**
 * Picture stops: the frames a spec wants to look at, named by what happens in the flight. The spec hands the
 * game a list of stops as data (`window.__app.setPictureStops`); the frame loop checks the list against every
 * new snapshot and, in the frame a stop is due, holds the simulation (no `advance`, the picture keeps
 * rendering, the same as the pause key without its label) until the spec has taken its pictures and resumes.
 * A stop is exact to the frame: "0.2 s after the splash" is the first frame whose time is at least that.
 *
 * Nothing here writes simulation state, and a held simulation is the game's pause: a flight with stops is the
 * same flight (the pilot acts in the simulation's control ticks, which stand still with it).
 *
 * Triggers (all by data: no id of a milestone, body or event is named in this file):
 *  - `{ milestone }`             the milestone record with that id exists (its own time is the trigger time);
 *  - `{ event, ... }`            an event of that type in a snapshot's `events`; `active` = of the active vessel
 *                                only (debris has splashes of its own); `match` = fields that must be equal;
 *                                `occurrence` = the n-th such event (default the first);
 *  - `{ radarBelow, bodyId? }`   the active vessel is below that radar altitude and coming down;
 *  - `{ peak, floor, drop }`     that readout has been at `floor` or more and has since fallen by the fraction
 *                                `drop` below its maximum (just past the peak of the heating or of the load).
 * `seconds` (default 0) is simulation time after the trigger. `after` names a milestone that must be on record
 * before the trigger is looked for at all (the load of the entry, not of the ascent; a peak is then the largest
 * value since that milestone).
 */
import type { SimEvent, SimSnapshot } from '@/core/contracts/sim';

export type PictureTrigger =
  | { milestone: string }
  | { event: SimEvent['type']; active?: boolean; match?: Record<string, string | number | boolean>; occurrence?: number }
  | { radarBelow: number; bodyId?: string }
  | { peak: 'heatFlux' | 'gLoad' | 'dynamicPressure'; floor: number; drop: number };

export interface PictureStop {
  /** Name of the stop (the spec's name for its pictures); unique in a list. */
  id: string;
  trigger: PictureTrigger;
  /** Simulation seconds after the trigger (default 0: the frame the trigger is seen in). */
  seconds?: number;
  /** Id of a milestone that must be on record before the trigger counts. */
  after?: string;
}

export interface PictureStopHit {
  id: string;
  /** Simulation time of the frame the stop is held at, and of its trigger, s. */
  ut: number;
  triggerUt: number;
}

export interface PictureStops {
  /** Replace the list (stops that have fired stay in `fired()`). */
  set(stops: readonly PictureStop[]): void;
  /**
   * Once per frame in which the simulation advanced, with that frame's snapshot. Returns the stop that is due
   * (the earliest, when several are), or null. A stop is returned once.
   */
  check(s: SimSnapshot): PictureStopHit | null;
  /** Stops that have been returned, in order. */
  fired(): PictureStopHit[];
  /** Ids of the stops that have not fired yet. */
  pending(): string[];
}

interface Armed {
  stop: PictureStop;
  triggerUt: number | null;
  /** Matching events seen so far (event triggers). */
  seen: number;
  /** Largest value seen (peak triggers). */
  max: number;
}

function triggerTime(a: Armed, s: SimSnapshot): number | null {
  const t = a.stop.trigger;
  if ('milestone' in t) return s.milestones.find((m) => m.id === t.milestone)?.ut ?? null;
  if ('event' in t) {
    for (const e of s.events) {
      if (e.type !== t.event) continue;
      if (t.active && e.vesselId !== s.activeVesselId) continue;
      if (t.match && !Object.entries(t.match).every(([k, v]) => (e as unknown as Record<string, unknown>)[k] === v)) continue;
      a.seen++;
      if (a.seen === (t.occurrence ?? 1)) return e.ut;
    }
    return null;
  }
  if ('radarBelow' in t) {
    const r = s.readouts;
    if (!(r.altitudeRadar < t.radarBelow) || !(r.verticalSpeed < -0.05)) return null;
    if (t.bodyId !== undefined && s.vessels.find((v) => v.id === s.activeVesselId)?.bodyId !== t.bodyId) return null;
    return s.ut;
  }
  const x = s.readouts[t.peak];
  if (!Number.isFinite(x)) return null;
  if (x > a.max) a.max = x;
  return a.max >= t.floor && x <= (1 - t.drop) * a.max ? s.ut : null;
}

export function createPictureStops(): PictureStops {
  let armed: Armed[] = [];
  const fired: PictureStopHit[] = [];
  return {
    set(stops) {
      const ids = new Set<string>();
      for (const st of stops) {
        if (ids.has(st.id)) throw new Error(`picture stops: two stops are called "${st.id}"`);
        ids.add(st.id);
      }
      armed = stops.filter((st) => !fired.some((f) => f.id === st.id)).map((stop) => ({ stop, triggerUt: null, seen: 0, max: Number.NEGATIVE_INFINITY }));
    },
    check(s) {
      // Every stop looks at the frame first (an event is in one snapshot only), then the earliest due one fires.
      let due: Armed | null = null;
      for (const a of armed) {
        if (a.triggerUt === null && (a.stop.after === undefined || s.milestones.some((m) => m.id === a.stop.after))) a.triggerUt = triggerTime(a, s);
        if (a.triggerUt === null || s.ut < a.triggerUt + (a.stop.seconds ?? 0)) continue;
        if (due === null || a.triggerUt + (a.stop.seconds ?? 0) < due.triggerUt! + (due.stop.seconds ?? 0)) due = a;
      }
      if (due === null) return null;
      armed = armed.filter((a) => a !== due);
      const hit = { id: due.stop.id, ut: s.ut, triggerUt: due.triggerUt! };
      fired.push(hit);
      return hit;
    },
    fired: () => fired.map((f) => ({ ...f })),
    pending: () => armed.map((a) => a.stop.id),
  };
}
