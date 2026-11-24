/**
 * Reach by refuelling (fleet-data scope E): every body of the staged 32-body library closes with the Albatross and
 * a stated number of Pelican Heavy depot flights (reachTable.ts: deltaVToOrbit's legs at their best window over
 * six years, broken-plane arcs, no aerobraking, finite-burn losses per leg). The margins under 5 % of their cost
 * are named MARGINAL here exactly, so a change in either direction is seen; they are not flown (hand-off).
 * And one answer: `analyzeVehicle`'s ladder, given the same reach function, states the same margins.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { reachCostFor, reachTable, stagedLibrary, type ReachTable } from './reachTable';

/** Bodies whose margin is under 5 % of their cost (fleet-data hand-off: closed on paper, not flown). */
const MARGINAL = ['dione', 'enceladus', 'io', 'mercury', 'mimas', 'miranda'];

// The reach function searches six years of windows for every body: these tests take tens of seconds.
vi.setConfig({ testTimeout: 300_000 });

let defs: DefLibrary;
let table: ReachTable;
beforeAll(async () => {
  defs = await stagedLibrary();
  table = reachTable(defs);
}, 120_000);

describe('reach by refuelling: the Albatross and the Pelican Heavy depots', () => {
  it('covers every attractor of the staged library but the launch body', () => {
    const attractors = Object.values(defs.bodies).filter((b) => b.gravityRole === 'attractor' && b.id !== 'earth').map((b) => b.id);
    expect(table.rows.map((r) => r.bodyId).sort()).toEqual(attractors.sort());
    expect(attractors.length).toBeGreaterThanOrEqual(31);
  });

  it('every body closes with a stated number of depot flights (at most two of them as drop tanks)', () => {
    for (const r of table.rows) {
      expect(r.margin, `${r.bodyId}: margin ${r.margin.toFixed(0)} with ${r.depots} depot flights`).toBeGreaterThan(0);
      expect(r.depots).toBeLessThanOrEqual(6);
      if (r.dropTank) expect(r.dropTanks!).toBeLessThanOrEqual(2);
    }
    expect(table.rows.filter((r) => r.marginal).map((r) => r.bodyId).sort()).toEqual(MARGINAL);
    console.log(`reach: every body closes; depot flights ${table.rows.map((r) => `${r.bodyId} ${r.depots}`).join(', ')}`);
  });

  it("analyzeVehicle's ladder, given the same reach function, states the table's margins (one answer)", () => {
    const albatross = defs.vehicles['meridian-albatross']!;
    const caps = analyzeVehicle(defs, albatross, { reachCost: reachCostFor(defs, table.cruiser), depotPropellants: table.depot.propellants });
    for (const r of table.rows) {
      const entry = caps.reach.find((e) => e.bodyId === r.bodyId && e.kind === 'orbit')!;
      expect(entry, r.bodyId).toBeDefined();
      if (r.depots === 0) {
        expect(entry.needsRefuel, r.bodyId).toBe(false);
        expect(entry.margin, r.bodyId).toBeCloseTo(r.directMargin, 0);
      } else if (r.singleRefuelMargin >= 0) {
        expect(entry.needsRefuel, r.bodyId).toBe(true);
        expect(entry.margin, r.bodyId).toBeCloseTo(r.singleRefuelMargin, 0);
      } else expect(entry.margin, `${r.bodyId}: a drop tank is the table's, not the ladder's`).toBeLessThan(0);
    }
  });

  it('the ladder offers a refuel only to a craft that reaches the refuel orbit and whose propellants a depot carries', () => {
    const cost = reachCostFor(defs, table.cruiser);
    const atoll = analyzeVehicle(defs, defs.vehicles['solstice-atoll']!, { reachCost: cost, depotPropellants: table.depot.propellants });
    expect(atoll.reach.some((e) => e.needsRefuel)).toBe(false);
    const albatross = analyzeVehicle(defs, defs.vehicles['meridian-albatross']!, { reachCost: cost, depotPropellants: table.depot.propellants });
    expect(albatross.reach.some((e) => e.needsRefuel)).toBe(true);
    // Without a reach function the ladder is empty: the costs come from src/sim/nav, which src/sim/vessel may not import.
    expect(analyzeVehicle(defs, defs.vehicles['meridian-albatross']!).reach).toEqual([]);
  });
});
