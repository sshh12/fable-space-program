/**
 * The refuelled profile of the fleet against every body of the solar system (fleet-data scope E): the
 * Albatross raises itself from low Earth orbit to the depot's high orbit, fills its tanks from the Pelican
 * Heavy, and departs; its margin per body is what it has left against solar-system-sim's `deltaVToOrbit`
 * (src/sim/nav/reach.ts) on the staged body library (data/staged/bodies over data/defs: the 32 bodies the
 * activation brings). Also the depot's side: the propellant it must deliver at the refuel orbit, against what
 * the Meridian's third stage carries there.
 *
 *   npx tsx tests/unit/fleet/reachTable.ts      prints the table (reach.test.ts holds it)
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs, overlayDefSource } from '@/core/defs/loader';
import { deltaVToOrbit, launchBodyOf, type RefuelPoint } from '@/sim/nav/reach';
import { analyzeVehicle } from '@/sim/vessel/analyze';

export const G0 = 9.80665;

export async function stagedLibrary(): Promise<DefLibrary> {
  return loadDefs(overlayDefSource(fsDefSource(), fsDefSource('data/staged')));
}

export interface ReachRow {
  bodyId: string;
  /** From low Earth orbit with the tanks the ascent left (no refuel). */
  direct: number;
  directMargin: number;
  /** The refuelled profile: what is burnt to the refuel point (from the ascent's tanks) and after it (from full tanks). */
  refuel: RefuelPoint;
  before: number;
  after: number;
  refuelledMargin: number;
  best: number;
}

export interface ReachTable {
  /** The cruiser's delta-v with full tanks, and what it has in low orbit after its own ascent, m/s. */
  cruiserFull: number;
  cruiserInLowOrbit: number;
  rows: ReachRow[];
  /** Propellant the cruiser burns to reach the refuel point (kg of LH2), what the depot delivers there, and the depot's margin. */
  cruiserBurnToRefuel: number;
  depotLoad: number;
}

/** The margins of the refuelled profile for every attractor of the library but the launch body. */
export function reachTable(defs: DefLibrary, refuel: RefuelPoint = 'highOrbit'): ReachTable {
  const alb = analyzeVehicle(defs, defs.vehicles['meridian-albatross']!);
  const cruiserStage = alb.stages.find((s) => s.label === 'Cruiser separation')!;
  const cruiserFull = cruiserStage.deltaVVac;
  // What the cruiser has once in low orbit from its own ascent (the core's leftover counts toward the orbit).
  const cruiserInLowOrbit = Math.min(cruiserFull, alb.deltaVInOrbit ?? 0);
  const isp = cruiserFull / Math.log(cruiserStage.massStart / cruiserStage.massEnd) / G0;
  const rows: ReachRow[] = [];
  let worstBefore = 0;
  const origin = launchBodyOf(defs);
  for (const b of Object.values(defs.bodies).sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (b.gravityRole !== 'attractor') continue;
    const direct = deltaVToOrbit(defs, b.id);
    if (direct.total === 0 && direct.capture.kind === 'none' && direct.legs.length === 0) continue;
    // A moon of the launch body is reached from low orbit directly (the reach function takes no refuel point there).
    const via = b.parent === origin ? direct : deltaVToOrbit(defs, b.id, { refuel });
    const directMargin = cruiserInLowOrbit - direct.total;
    const refuelledMargin = via === direct ? directMargin : Math.min(cruiserInLowOrbit - via.beforeRefuel, cruiserFull - via.afterRefuel);
    worstBefore = Math.max(worstBefore, via.beforeRefuel);
    rows.push({ bodyId: b.id, direct: direct.total, directMargin, refuel, before: via.beforeRefuel, after: via.afterRefuel, refuelledMargin, best: Math.max(directMargin, refuelledMargin) });
  }
  // The cruiser's LH2 burnt from low orbit to the refuel point (full tanks at the start: the worst case).
  const m0 = cruiserStage.massStart;
  const cruiserBurnToRefuel = m0 - m0 / Math.exp(worstBefore / (isp * G0));
  const depot = defs.vehicles['meridian-pelican-heavy']!;
  const load = depot.parts.find((p) => p.id === 'dp-tank')!.resources?.['LH2'] ?? defs.parts['tank-lh2-9m']!.resources![0]!.capacity;
  return { cruiserFull, cruiserInLowOrbit, rows, cruiserBurnToRefuel, depotLoad: load };
}

if (process.argv[1]?.endsWith('reachTable.ts')) {
  const defs = await stagedLibrary();
  const t = reachTable(defs);
  console.log(`cruiser: ${t.cruiserFull.toFixed(0)} m/s full, ${t.cruiserInLowOrbit.toFixed(0)} m/s in low orbit; burns ${t.cruiserBurnToRefuel.toFixed(0)} kg of LH2 to the refuel point; the depot carries ${t.depotLoad.toFixed(0)} kg`);
  for (const r of t.rows) console.log(`${r.bodyId.padEnd(10)} direct ${r.direct.toFixed(0).padStart(6)} (margin ${r.directMargin.toFixed(0).padStart(6)})   refuelled ${r.before.toFixed(0).padStart(5)} + ${r.after.toFixed(0).padStart(6)} (margin ${r.refuelledMargin.toFixed(0).padStart(6)})   best ${r.best.toFixed(0)}`);
}
