/**
 * Reach by refuelling (fleet-data scope E): the Albatross against every body of the solar system, on the staged
 * body library (data/staged/bodies over data/defs: the 32 bodies of the activation), with solar-system-sim's
 * `deltaVToOrbit` (src/sim/nav/reach.ts) for the legs and these choices:
 *   - the heliocentric leg: the best window over SEARCH_SPAN (several synodic periods), a broken-plane arc where it
 *     is cheaper (`brokenPlane`); no aerobraking (the cruiser has no heat shield: `entrySpeedLimit` null);
 *   - FINITE-BURN LOSS per leg instead of the function's flat allowance: Robbins' (omega t)^2 / 24 of the leg, with
 *     t the burn time at the cruiser's thrust and mass and omega the angular rate at the burn point (the perigee
 *     of the parking or refuel orbit for burns at the launch body, a near-parabolic periapsis at the target);
 *     the corrections allowance is kept;
 *   - the profile: the cruiser leaves the pad with two of its four tanks full, burns from low orbit to the refuel
 *     orbit (the high elliptical orbit of deltaVToOrbit), takes what it needs from Pelican Heavy depots there (each
 *     brings DEPOT_LOAD), and departs; where four full tanks are not enough, one more depot stays docked at its
 *     H port as a drop tank (fed across the port, then cast off).
 * One answer: the single-refuel margins here are what `analyzeVehicle`'s ladder states when it is given the same
 * reach function (reach.test.ts holds them equal).
 *
 *   npx tsx tests/unit/fleet/reachTable.ts      prints the table
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs, overlayDefSource } from '@/core/defs/loader';
import { deltaVToOrbit, launchBodyOf, type ReachResult } from '@/sim/nav/reach';
import { analyzeVehicle, type ReachCost } from '@/sim/vessel/analyze';

export const G0 = 9.80665;
/** Window search for the heliocentric leg, s: six years, several synodic periods of every pair. */
export const SEARCH_SPAN = 6 * 365.25 * 86400;
/** A margin under this share of the cost is MARGINAL (the losses of a real flight can take it). */
export const MARGINAL_SHARE = 0.05;

export async function stagedLibrary(): Promise<DefLibrary> {
  return loadDefs(overlayDefSource(fsDefSource(), fsDefSource('data/staged')));
}

/** The cruiser as the analysis states it. */
export interface Cruiser {
  dry: number;
  /** Full tanks (kg of LH2), what it has in low orbit after its own ascent, exhaust speed, thrust. */
  capacity: number;
  afterAscent: number;
  ve: number;
  thrust: number;
}

export function cruiserOf(defs: DefLibrary): Cruiser {
  const v = defs.vehicles['meridian-albatross']!;
  const caps = analyzeVehicle(defs, v);
  const stage = caps.stages.find((s) => s.label === 'Cruiser separation')!;
  const ve = stage.deltaVVac / Math.log(stage.massStart / stage.massEnd);
  const dry = stage.massEnd;
  // The cruiser's own tanks (the M-2 below it holds LH2 too).
  const capacity = v.parts.filter((p) => p.id.startsWith('sc-') && defs.parts[p.def]!.resources?.some((r) => r.resource === 'LH2')).reduce((s, p) => s + defs.parts[p.def]!.resources!.find((r) => r.resource === 'LH2')!.capacity, 0);
  const afterAscent = dry * (Math.exp((caps.deltaVInOrbit ?? 0) / ve) - 1);
  const earth = defs.bodies[launchBodyOf(defs)]!;
  return { dry, capacity, afterAscent: Math.min(afterAscent, stage.massStart - dry), ve, thrust: stage.twrVac * stage.massStart * (earth.mu / earth.radius ** 2) };
}

/** The depot: its LH2 load and dry mass (the tank, ring, port and quads it leaves when it is cast off). */
export function depotOf(defs: DefLibrary): { load: number; dry: number; propellants: string[] } {
  const v = defs.vehicles['meridian-pelican-heavy']!;
  const caps = analyzeVehicle(defs, v);
  const load = v.parts.find((p) => p.id === 'dp-tank')!.resources?.['LH2'] ?? 0;
  // What stays docked when it is a drop tank: every part of the depot but the interstage it leaves on the M-3.
  const dry = v.parts.filter((p) => p.id.startsWith('dp-') && p.id !== 'dp-interstage').reduce((s, p) => s + defs.parts[p.def]!.dryMass, 0);
  return { load, dry, propellants: caps.transferable };
}

/** Finite-burn loss of an impulsive leg dv (m/s) for a burn starting at mass m0 (kg) at angular rate omega (rad/s). */
export function burnLoss(dv: number, m0: number, c: Cruiser, omega: number): number {
  const mdot = c.thrust / c.ve;
  const t = (m0 * (1 - Math.exp(-dv / c.ve))) / mdot;
  return dv * Math.min(0.25, (omega * t) ** 2 / 24);
}

export interface Costed {
  /** Effective delta-v (impulsive legs + finite-burn losses + corrections) before the refuel point and after it. */
  before: number;
  after: number;
  /** The capture burns among the 'after' legs (a flyby is the rest). */
  capture: number;
  result: ReachResult;
}

/** The legs of `deltaVToOrbit` with the finite-burn losses of a cruiser that starts the 'after' legs at mass m0After. */
export function costed(defs: DefLibrary, bodyId: string, refuelled: boolean, c: Cruiser, m0Before: number, m0After: number): Costed | null {
  const origin = launchBodyOf(defs);
  const body = defs.bodies[bodyId]!;
  if (refuelled && body.parent === origin) return null;
  const result = deltaVToOrbit(defs, bodyId, { refuel: refuelled ? 'highOrbit' : 'none', brokenPlane: true, searchSpan: SEARCH_SPAN, aerobrake: false });
  const earth = defs.bodies[origin]!;
  const r0 = earth.radius + 200e3;
  const circ = Math.sqrt(earth.mu / r0 ** 3);
  const rateAt = (t: typeof body): number => Math.SQRT2 * Math.sqrt(t.mu / (t.radius * 1.05) ** 3);
  const planet = body.parent ? defs.bodies[body.parent] : undefined;
  let before = 0;
  let after = 0;
  let m = m0Before;
  let pastRefuel = !refuelled;
  let capture = 0;
  if (pastRefuel) m = m0After;
  for (const leg of result.legs) {
    const atOrigin = /raise|departure|transfer to/i.test(leg.name);
    const atPlanet = /planet/i.test(leg.name) && /capture/i.test(leg.name) && !/flyby/i.test(leg.name) && planet;
    const omega = /plane change/i.test(leg.name) ? 0 : atOrigin ? (/departure from the high/i.test(leg.name) ? 1.39 * circ : /raise/i.test(leg.name) ? circ : Math.SQRT2 * circ) : rateAt(atPlanet ? planet : body);
    if (/departure from the high/i.test(leg.name) && !pastRefuel) {
      pastRefuel = true;
      m = m0After;
    }
    const eff = leg.deltaV + burnLoss(leg.deltaV, m, c, omega);
    m = m * Math.exp(-eff / c.ve);
    if (refuelled && !pastRefuel) before += eff;
    else after += eff;
    if (/capture/i.test(leg.name)) capture += eff;
  }
  after += result.allowances.corrections;
  return { before, after, capture, result };
}

export interface ReachRow {
  bodyId: string;
  /** From low orbit with what the ascent left, no depot. */
  direct: number;
  directMargin: number;
  /** Refuelled once to full tanks at the refuel orbit (the ladder's number). */
  before: number;
  after: number;
  singleRefuelMargin: number;
  /** The cheapest profile that closes: depot flights it needs (0 = direct), with a drop tank or not, and its margin. */
  depots: number;
  dropTank: boolean;
  /** Depots docked as drop tanks (0 to the cruiser's H ports). */
  dropTanks?: number;
  margin: number;
  cost: number;
  marginal: boolean;
}

export interface ReachTable {
  cruiser: Cruiser;
  depot: { load: number; dry: number; propellants: string[] };
  rows: ReachRow[];
}

export function reachTable(defs: DefLibrary): ReachTable {
  const c = cruiserOf(defs);
  const depot = depotOf(defs);
  const full = c.dry + c.capacity;
  const ascent = c.dry + c.afterAscent;
  const dvFull = c.ve * Math.log(full / c.dry);
  const dvAscent = c.ve * Math.log(ascent / c.dry);
  // Depots docked at the cruiser's H ports as drop tanks (fed across the port, then cast off).
  const dropPorts = analyzeVehicle(defs, defs.vehicles['meridian-albatross']!).ports.filter((p) => p.portType === 'h').length;
  const withDrop = (k: number): number => c.ve * Math.log((full + k * (depot.dry + depot.load)) / (full + k * depot.dry)) + dvFull;
  const rows: ReachRow[] = [];
  const origin = launchBodyOf(defs);
  for (const b of Object.values(defs.bodies).sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (b.gravityRole !== 'attractor' || b.id === origin) continue;
    const direct = costed(defs, b.id, false, c, ascent, ascent)!;
    const directMargin = dvAscent - direct.after;
    const refuel = costed(defs, b.id, true, c, ascent, full);
    let row: ReachRow;
    if (directMargin >= 0 || !refuel) {
      row = { bodyId: b.id, direct: direct.after, directMargin, before: refuel?.before ?? 0, after: refuel?.after ?? direct.after, singleRefuelMargin: directMargin, depots: 0, dropTank: false, margin: directMargin, cost: direct.after, marginal: false };
    } else {
      // At the refuel orbit with what is left; the propellant the 'after' legs need from there.
      const atRefuel = ascent * Math.exp(-refuel.before / c.ve) - c.dry;
      const need = c.dry * (Math.exp(refuel.after / c.ve) - 1);
      const single = Math.min(dvAscent - refuel.before, dvFull - refuel.after);
      if (need <= c.capacity) {
        const depots = Math.max(1, Math.ceil((need - atRefuel) / depot.load));
        row = { bodyId: b.id, direct: direct.after, directMargin, before: refuel.before, after: refuel.after, singleRefuelMargin: single, depots, dropTank: false, margin: single, cost: refuel.before + refuel.after, marginal: false };
      } else {
        // Four full tanks are not enough: depots stay docked as drop tanks, one or two (its departure losses: heavier, longer).
        let best: ReachRow | null = null;
        for (let k = 1; k <= dropPorts && (best === null || best.margin < 0); k++) {
          const heavy = costed(defs, b.id, true, c, ascent, full + k * (depot.dry + depot.load))!;
          const depots = Math.ceil((c.capacity - atRefuel) / depot.load) + k;
          const m = Math.min(dvAscent - heavy.before, withDrop(k) - heavy.after);
          best = { bodyId: b.id, direct: direct.after, directMargin, before: heavy.before, after: heavy.after, singleRefuelMargin: single, depots, dropTank: true, dropTanks: k, margin: m, cost: heavy.before + heavy.after, marginal: false };
        }
        row = best!;
      }
    }
    row.marginal = row.margin < MARGINAL_SHARE * row.cost;
    rows.push(row);
  }
  return { cruiser: c, depot, rows };
}

/** The reach function `analyzeVehicle` takes, on the same legs and losses (one answer for the ladder and the table). */
export function reachCostFor(defs: DefLibrary, c: Cruiser): (bodyId: string, refuelled: boolean) => ReachCost | null {
  const ascent = c.dry + c.afterAscent;
  const full = c.dry + c.capacity;
  return (bodyId, refuelled) => {
    const k = costed(defs, bodyId, refuelled, c, ascent, refuelled ? full : ascent);
    if (!k) return null;
    const flyby = k.after - k.capture;
    return refuelled ? { flyby, orbit: k.after, beforeRefuel: k.before } : { flyby, orbit: k.after };
  };
}

if (process.argv[1]?.endsWith('reachTable.ts')) {
  const defs = await stagedLibrary();
  const t = reachTable(defs);
  const c = t.cruiser;
  console.log(`cruiser: dry ${(c.dry / 1000).toFixed(1)} t, ${(c.capacity / 1000).toFixed(0)} t LH2 full (${(c.ve * Math.log((c.dry + c.capacity) / c.dry)).toFixed(0)} m/s), ${(c.afterAscent / 1000).toFixed(1)} t after its ascent; depot ${(t.depot.load / 1000).toFixed(0)} t, dry ${(t.depot.dry / 1000).toFixed(1)} t`);
  for (const r of t.rows) console.log(`${r.bodyId.padEnd(10)} direct ${r.direct.toFixed(0).padStart(6)} (${r.directMargin.toFixed(0).padStart(6)})  refuel ${r.before.toFixed(0).padStart(5)}+${r.after.toFixed(0).padStart(6)} single ${r.singleRefuelMargin.toFixed(0).padStart(6)}  depots ${r.depots}${r.dropTank ? ` (${r.dropTanks} as drop tanks)` : ''} margin ${r.margin.toFixed(0)}${r.marginal ? ' MARGINAL' : ''}`);
}
