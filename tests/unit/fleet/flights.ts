/**
 * The fleet's flights on `createSession` (World, this wave): a scenario of data/defs/scenarios/fleet-*.json
 * flown by a pilot through PlayerCommands and the stick, with a record of what the acceptance asks for:
 * the orbit reached, every stage separation with the clearance between the pieces over the 30 s after it, the
 * peak dynamic pressure and q x angle of attack against the stack's structural limits, the propellant left.
 *
 * The terrain is the flat stand-in of the sim-world tests (one height per body, everything resident): an
 * ascent leaves the ground in seconds, and the ocean stands everywhere on Earth for a splashdown.
 */
import type { Pilot } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { createSession, diagnosticsOf } from '@/session';
import { runHeadless, type RunResult } from '@/pilot/runner';
import { flatTerrain } from '../sim-world/helpers';

export interface SeparationRecord {
  /** When pieces left the active vessel, and their vessel ids (the root part of a piece names what it is). */
  ut: number;
  pieces: string[];
  /**
   * Per piece: the age (s) from which the clearance to the active vessel stayed positive (the pieces of a split
   * are born touching or nested, as an engine in its interstage: ARCHITECTURE 7.4), and the least clearance (m)
   * from then to the end of the window. A piece that comes back within the window shows a late positive-from.
   */
  positiveFrom: Record<string, number>;
  minClearance: Record<string, number>;
  /** Clearance at the end of the window. */
  endClearance: Record<string, number>;
}

export interface FlightRecord {
  result: RunResult;
  separations: SeparationRecord[];
  maxQ: number;
  maxQAlpha: number;
  /** Destructive events of the flight (a part destroyed, a joint broken, a chute failed), with when and why. */
  damage: { type: string; ut: number; detail: string }[];
  final: SimSnapshot;
  active: VesselSnapshot | undefined;
}

export const CLEARANCE_WINDOW = 30;

export function fleetTerrain(defs: DefLibrary): TerrainProvider {
  // The Earth's ground under the sea level everywhere (a splashdown is in water), the Moon's at its datum.
  return flatTerrain(defs, { earth: -100, moon: 0 });
}

/** Fly `pilot` on the scenario and watch every separation for CLEARANCE_WINDOW seconds. */
export async function fly(defs: DefLibrary, scenarioId: string, pilot: Pilot, opts: { maxSimTime: number; until?: (s: SimSnapshot) => boolean }): Promise<FlightRecord> {
  const session = createSession(defs, scenarioId, { terrain: fleetTerrain(defs) });
  const diag = diagnosticsOf(session);
  const separations: SeparationRecord[] = [];
  let maxQ = 0;
  let maxQAlpha = 0;
  let known = new Set<string>();
  let activeId: string | null = null;
  const damage: FlightRecord['damage'] = [];
  const seenEvents = new Set<string>();
  const result = await runHeadless(session, pilot, {
    maxSimTime: opts.maxSimTime,
    record: false,
    ...(opts.until ? { until: opts.until } : {}),
    onTick: (s) => {
      for (const e of s.events) {
        if (e.type !== 'partDestroyed' && e.type !== 'jointBroken' && e.type !== 'chuteFailed') continue;
        const key = `${e.type}|${e.ut}|${JSON.stringify(e)}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        const { type: _t, ut: _u, ...rest } = e as unknown as Record<string, unknown>;
        damage.push({ type: e.type, ut: e.ut, detail: JSON.stringify(rest) });
      }
      const active = s.vessels.find((v) => v.id === s.activeVesselId);
      if (!active) return;
      maxQ = Math.max(maxQ, s.readouts.dynamicPressure);
      maxQAlpha = Math.max(maxQAlpha, s.readouts.dynamicPressure * Math.abs(s.readouts.angleOfAttack));
      const ids = new Set(s.vessels.map((v) => v.id));
      if (activeId === null) {
        activeId = active.id;
        known = ids;
      }
      const fresh = [...ids].filter((id) => !known.has(id) && id !== active.id);
      if (fresh.length > 0) {
        separations.push({ ut: s.simUt, pieces: fresh, positiveFrom: {}, minClearance: {}, endClearance: {} });
      }
      known = ids;
      for (const sep of separations) {
        const age = s.simUt - sep.ut;
        if (age > CLEARANCE_WINDOW) continue;
        for (const piece of sep.pieces) {
          if (!ids.has(piece)) continue;
          const c = diag.clearance(active.id, piece);
          if (c === null) continue;
          if (!(c > 0)) {
            sep.positiveFrom[piece] = Infinity;
            delete sep.minClearance[piece];
          } else {
            if (!Number.isFinite(sep.positiveFrom[piece] ?? Infinity)) sep.positiveFrom[piece] = age;
            sep.minClearance[piece] = Math.min(sep.minClearance[piece] ?? Infinity, c);
          }
          sep.endClearance[piece] = c;
        }
      }
    },
  });
  const final = session.peek();
  return { result, separations, maxQ, maxQAlpha, damage, final, active: final.vessels.find((v) => v.id === final.activeVesselId) };
}
