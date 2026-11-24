/**
 * One acceptance ascent of the fleet (fleet-data acceptance): the vehicle, flown by the generic ascent pilot on
 * createSession from a Ka Lae pad of its class (its fleet-<vehicle>.json scenario), reaches orbit (periapsis at
 * least 160 km) with stage separations that leave positive clearance for 30 s, max-q under the stack's
 * structural limits, and its propellant margin reported.
 */
import { expect } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { createAscentPilot } from '@/pilot/generic/ascent';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { CLEARANCE_WINDOW, fly } from './flights';

/**
 * A separation's pieces part within this long (s) of their split. Pieces are born nested (an engine bell in the
 * interstage or adapter of the stage it leaves: ARCHITECTURE 7.4, "born overlapping"); the springs of a payload
 * separation in orbit take up to about 3.5 s to draw a 2 m bell out of its adapter.
 */
export const PART_WITHIN = 5;

/** The smallest q x angle of attack a joint of the vehicle survives (part data), Pa rad. */
export function weakestJoint(defs: DefLibrary, vehicleId: string): number {
  let min = Infinity;
  for (const p of defs.vehicles[vehicleId]!.parts) {
    const j = defs.parts[p.def]!.joint.maxQAlpha;
    if (j !== undefined) min = Math.min(min, j);
  }
  return min;
}

export async function ascentToOrbit(defs: DefLibrary, vehicleId: string, separateInOrbit: boolean, opts: { scenario?: string; terrain?: TerrainProvider } = {}): Promise<string> {
  const caps = analyzeVehicle(defs, defs.vehicles[vehicleId]!);
  const pilot = createAscentPilot(caps, { separateInOrbit });
  const rec = await fly(defs, opts.scenario ?? `fleet-${vehicleId}`, pilot, { maxSimTime: 2400, ...(opts.terrain ? { terrain: opts.terrain } : {}) });
  expect(rec.result.failure, vehicleId).toBeNull();
  expect(rec.result.reason, vehicleId).toBe('done');
  expect(pilot.orbitUt, vehicleId).not.toBeNull();
  const r = rec.final.readouts;
  // Scope D: a 185-250 km orbit.
  expect(r.periapsisAltitude, vehicleId).toBeGreaterThanOrEqual(185000);
  expect(r.apoapsisAltitude, vehicleId).toBeLessThanOrEqual(250000);
  // Max-q under the structural limits of the stack: q x angle of attack against its weakest joint.
  const weakest = weakestJoint(defs, vehicleId);
  expect(rec.maxQAlpha, vehicleId).toBeLessThan(weakest);
  // Every separation: the pieces part within PART_WITHIN s and stay apart for the CLEARANCE_WINDOW.
  expect(rec.separations.length, vehicleId).toBeGreaterThanOrEqual(3);
  const lines: string[] = [];
  for (const s of rec.separations) {
    const watched = rec.final.simUt - s.ut >= CLEARANCE_WINDOW;
    for (const piece of s.pieces) {
      const from = s.positiveFrom[piece];
      expect(from, `${vehicleId}: ${piece}`).toBeDefined();
      expect(from!, `${vehicleId}: ${piece} parts after ${from} s`).toBeLessThanOrEqual(PART_WITHIN);
      expect(s.minClearance[piece]!, `${vehicleId}: ${piece}`).toBeGreaterThan(0);
      if (watched) expect(s.endClearance[piece]!, `${vehicleId}: ${piece}`).toBeGreaterThan(0.5);
    }
    lines.push(`${s.pieces.map((p) => p.split('~')[1]).join('+')} apart from ${Math.max(...s.pieces.map((p) => s.positiveFrom[p]!)).toFixed(2)} s, ${Math.min(...s.pieces.map((p) => s.endClearance[p] ?? 0)).toFixed(1)} m at ${Math.min(CLEARANCE_WINDOW, rec.final.simUt - s.ut).toFixed(0)} s`);
  }
  const summary = `${vehicleId}: orbit ${(r.periapsisAltitude / 1000).toFixed(1)} x ${(r.apoapsisAltitude / 1000).toFixed(1)} km at T+${(pilot.orbitUt! - rec.final.simUt + rec.result.simTime).toFixed(0)} s; max q ${(rec.maxQ / 1000).toFixed(1)} kPa, q alpha ${rec.maxQAlpha.toFixed(0)} of ${weakest} Pa rad; delta-v left ${r.deltaVTotal.toFixed(0)} m/s (${(r.mass / 1000).toFixed(1)} t); separations: ${lines.join('; ')}`;
  console.log(summary);
  return summary;
}
