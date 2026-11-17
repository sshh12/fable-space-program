/**
 * The HUD's resource groups against the computation of before the presentation sweep.
 *
 * Before the sweep `describeResources` read the vehicle definition: a part's group from `VehicleDef.parts`,
 * the groups in the order of `VehicleDef.stageGroups`, a group's label from that list. Since the sweep it
 * reads the snapshot alone (`PartSnapshot.stageGroup` / `stageLabel`), and the groups come in the order of
 * the part list, because a snapshot does not state the order of a craft's stage groups. The two orders are
 * the same for a vehicle whose file lists its groups in the order in which its parts first carry a resource.
 *
 * This test holds every vehicle of the library to that, in the real session (`createSession`), through
 * every stage of its stack and in every scenario of the library: what the HUD's resource panel and the MFD's
 * systems page are built from is equal, field for field, to what the computation of before gives. A vehicle
 * file whose groups are listed in another order fails here, and its HUD would list them in the other order.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, VehicleDef } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { formatPercent } from '@/ui/format';
import { describeResources, summarizeResources, type ResourceGroupView } from '@/ui/model';
import { active, flatTerrain, loadLibrary, makeSim, orbitScenario } from '../sim-world/helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;

beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

/**
 * `describeResources` as it was before the sweep (commit 1a93c40^), for a vessel whose vehicle definition
 * the caller names: groups by `VehicleDef.parts`, ordered and labelled by `VehicleDef.stageGroups`.
 */
function resourcesBefore(v: VesselSnapshot, vehicle: VehicleDef): ResourceGroupView[] {
  const groupOf = new Map<string, string>();
  for (const p of vehicle.parts) groupOf.set(p.id, p.stageGroup);
  const sums = new Map<string, Map<string, { amount: number; capacity: number }>>();
  const mainFeed = new Map<string, Set<string>>();
  const fixedFeed = new Map<string, Set<string>>();
  const ablators = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, g: string, rid: string): void => {
    let set = m.get(g);
    if (!set) m.set(g, (set = new Set()));
    set.add(rid);
  };
  for (const part of v.parts) {
    const def = defs.parts[part.def];
    if (!def) continue;
    const g = groupOf.get(part.instanceId) ?? v.id;
    for (const md of def.modules) {
      if (md.type === 'engine') for (const p of md.propellants) add(md.fixedBurn ? fixedFeed : mainFeed, g, p.resource);
      else if (md.type === 'heatShield') add(ablators, g, md.ablatorResource);
    }
    if (!def.resources) continue;
    let m = sums.get(g);
    if (!m) sums.set(g, (m = new Map()));
    for (const r of def.resources) {
      const e = m.get(r.resource) ?? { amount: 0, capacity: 0 };
      e.amount += part.resources[r.resource] ?? 0;
      e.capacity += r.capacity;
      m.set(r.resource, e);
    }
  }
  const order = vehicle.stageGroups.map((g) => g.id);
  const ids = [...sums.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  return ids.map((id) => {
    const entries = [...sums.get(id)!.entries()];
    const main = mainFeed.get(id);
    const held = (rid: string): boolean => main?.has(rid) === true;
    const ablator = (rid: string): boolean => ablators.get(id)?.has(rid) ?? false;
    const other = (rid: string): boolean => !ablator(rid) && !(fixedFeed.get(id)?.has(rid) ?? false);
    const isPrimary = entries.some(([rid]) => held(rid)) ? held : entries.some(([rid]) => other(rid)) ? other : (rid: string): boolean => !ablator(rid);
    return {
      id,
      label: vehicle.stageGroups.find((g) => g.id === id)?.label ?? v.name,
      bars: entries.map(([rid, e]) => ({
        resourceId: rid,
        name: defs.resources[rid]?.name ?? rid,
        fraction: e.capacity > 0 ? Math.max(0, Math.min(1, e.amount / e.capacity)) : 0,
        amount: e.capacity > 0 ? formatPercent(e.amount / e.capacity) : '—',
        primary: isPrimary(rid),
      })),
    };
  });
}

/** Every vehicle of the library that has stage groups (each of them: a vehicle without one cannot be assembled). */
const libraryVehicles = (): VehicleDef[] => Object.values(defs.vehicles).filter((v) => v.stageGroups.length > 0);

describe('resource groups of a single-craft vessel: the computation of before the sweep and the one of today', () => {
  it('every vehicle of the library, in the real session, with 0 to all of its stages fired: the same groups in the same order, with the same labels and bars', async () => {
    const vehicles = libraryVehicles();
    expect(vehicles.length).toBe(Object.keys(defs.vehicles).length);
    expect(vehicles.length).toBeGreaterThan(0);
    let compared = 0;
    let most = 0;
    for (const vehicle of vehicles) {
      const base = Object.values(defs.scenarios).find((x) => x.vehicle === vehicle.id);
      expect(base, `a scenario that flies ${vehicle.id}`).toBeDefined();
      for (let fired = 0; fired <= vehicle.stages.length; fired++) {
        const session = await makeSim(defs, orbitScenario(base!, `resources-${vehicle.id}-${fired}`, defs.rootBodyId, 300_000, 300_000, fired), terrain);
        const s = session.snapshot();
        const v = active(s);
        expect(v.crafts?.length ?? 1, `${vehicle.id} after ${fired} stages`).toBe(1);
        const now = describeResources(s, defs);
        const before = resourcesBefore(v, vehicle);
        expect(now.map((g) => g.id), `${vehicle.id} after ${fired} stages: the order of the groups`).toEqual(before.map((g) => g.id));
        expect(now, `${vehicle.id} after ${fired} stages`).toEqual(before);
        expect(summarizeResources(now)).toEqual(summarizeResources(before));
        // The groups are the vehicle's, in the order of its file.
        const order = vehicle.stageGroups.map((g) => g.id);
        expect(now.map((g) => order.indexOf(g.id)).every((x, i, all) => x >= 0 && (i === 0 || x > all[i - 1]!))).toBe(true);
        most = Math.max(most, now.length);
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(vehicles.length * 2);
    // The comparison is of something: a whole stack has several groups, whose order could differ.
    expect(most).toBeGreaterThan(3);
  });

  it('the comparison can fail: were two fuelled groups listed the other way round in the vehicle file, the order of before would follow the file and the order of today follows the parts', async () => {
    const vehicle = libraryVehicles()[0]!;
    const base = Object.values(defs.scenarios).find((x) => x.vehicle === vehicle.id)!;
    const session = await makeSim(defs, orbitScenario(base, 'resources-whole', defs.rootBodyId, 300_000, 300_000, 0), terrain);
    const s = session.snapshot();
    const now = describeResources(s, defs);
    const listed = now.map((g) => g.id);
    expect(listed.length).toBeGreaterThan(2);
    // The file with its last two groups that hold a resource in each other's place. The session states the
    // same snapshot for either file: a part names its group and the group's label, found by the group's id,
    // and nothing in a snapshot says where a group stands in the list.
    const [a, b] = listed.slice(-2) as [string, string];
    const swapped: VehicleDef = { ...vehicle, stageGroups: vehicle.stageGroups.map((g) => (g.id === a ? vehicle.stageGroups.find((x) => x.id === b)! : g.id === b ? vehicle.stageGroups.find((x) => x.id === a)! : g)) };
    const before = resourcesBefore(active(s), swapped);
    expect(before.map((g) => g.id)).toEqual([...listed.slice(0, -2), b, a]);
    // The same groups with the same bars either way: the order is all that differs.
    expect([...now].sort((x, y) => x.id.localeCompare(y.id))).toEqual([...before].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('every scenario of the library as its session starts it (the pad, the orbits, the lunar surface, the entry)', async () => {
    let started = 0;
    for (const vehicle of libraryVehicles()) {
      for (const scenario of Object.values(defs.scenarios).filter((x) => x.vehicle === vehicle.id)) {
        const session = await makeSim(defs, scenario.id, terrain);
        const s = session.snapshot();
        const now = describeResources(s, defs);
        expect(now.length, scenario.id).toBeGreaterThan(0);
        expect(now, scenario.id).toEqual(resourcesBefore(active(s), vehicle));
        started++;
      }
    }
    expect(started).toBe(Object.keys(defs.scenarios).length);
    expect(started).toBeGreaterThan(3);
  });
});
