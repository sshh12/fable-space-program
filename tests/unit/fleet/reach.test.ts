/**
 * Reach by refuelling (fleet-data scope E): the Albatross refuelled by the Pelican Heavy depot in a high Earth
 * orbit, against solar-system-sim's deltaVToOrbit on the staged library of 32 bodies. Every body whose margin is
 * positive is held positive; the bodies this fleet cannot close are named here exactly (they go to the user
 * as OPEN_QUESTIONS Q17), so a change in either direction is seen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { reachTable, stagedLibrary, type ReachTable } from './reachTable';

/** Bodies the refuelled profile does not close (fleet-data hand-off, Q17), with their shortfall in m/s at the time of writing. */
const NOT_CLOSED: Record<string, number> = { charon: -5042, mercury: -1162, mimas: -382, pluto: -4808 };

let defs: DefLibrary;
let table: ReachTable;
beforeAll(async () => {
  defs = await stagedLibrary();
  table = reachTable(defs);
}, 120_000);

describe('reach by refuelling: the Albatross and the Pelican Heavy depot', () => {
  it('covers every attractor of the staged library but the launch body', () => {
    const attractors = Object.values(defs.bodies).filter((b) => b.gravityRole === 'attractor' && b.id !== 'earth').map((b) => b.id);
    expect(table.rows.map((r) => r.bodyId).sort()).toEqual(attractors.sort());
    expect(attractors.length).toBeGreaterThanOrEqual(31);
  });

  it('the cruiser has 10.9 km/s with full tanks and keeps them full through its ascent', () => {
    expect(Math.abs(table.cruiserFull - 10900) / 10900).toBeLessThan(0.02);
    expect(table.cruiserInLowOrbit).toBeCloseTo(table.cruiserFull, 0);
  });

  it('the depot carries what the cruiser burns on its way to the refuel orbit, with a margin', () => {
    expect(table.depotLoad).toBeGreaterThan(table.cruiserBurnToRefuel * 1.05);
  });

  it('gives a positive margin for every body but the ones named for Q17', () => {
    for (const r of table.rows) {
      if (r.bodyId in NOT_CLOSED) {
        expect(r.best, r.bodyId).toBeLessThan(0);
        expect(r.best, r.bodyId).toBeCloseTo(NOT_CLOSED[r.bodyId]!, -2);
      } else expect(r.best, `${r.bodyId}: margin ${r.best.toFixed(0)}`).toBeGreaterThan(0);
    }
    const closed = table.rows.filter((r) => r.best > 0).length;
    console.log(`reach: ${closed} of ${table.rows.length} bodies closed; not closed: ${Object.keys(NOT_CLOSED).join(', ')}`);
  });
});
