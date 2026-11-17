/**
 * The engines a part carries and the key a part's presentation state is filed under, both from the snapshot
 * alone (ARCHITECTURE 18.7; presentation-sweep): no vehicle definition is indexed by a runtime id and no id is
 * taken apart.
 *
 *  - `engineMounts` gives, for every vehicle of the library as the simulation assembles it, exactly the
 *    engine's parent in the vehicle tree (what the vessel feature read from the definition before the sweep);
 *  - two craft of one vehicle in one vessel never share a mount or a state key;
 *  - a piece that leaves a craft keeps the key its parts had, through any number of separations, and also
 *    after the craft it left has gone from the snapshot.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CraftSnapshot, PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { CraftLineage, craftIdOf, partKeyOf } from '@/core/access/snapshotAccess';
import { v3 } from '@/core/math';
import { engineMounts } from '@/render/vehicle/mounts';
import { assembleVessel, splitForStage, vesselPartSnapshots, type Vessel } from '@/sim/vessel/public';

let defs: DefLibrary;
let base: SimSnapshot;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  base = createFakeSim(defs, { scene: 'lowOrbit' }).peek();
});

const isEngine = (defId: string): boolean => defs.parts[defId]!.modules.some((m) => m.type === 'engine');

const craftBlock = (id: string, parent: string | null, vehicleId: string): CraftSnapshot => ({
  id,
  parent,
  vehicleId,
  name: id,
  ownerId: null,
  ownerCallsign: null,
  commandPart: null,
  staging: { nextStage: 0, stages: [], lockout: false },
  chase: { defaultDistance: 100, minDistance: 10, maxDistance: 1000 },
  policy: { lendAttitude: true, lendEngines: true, lendPropellant: true, helm: 'owner' },
});

/** A vessel snapshot of the given parts and craft, on the fake's flight state. */
const vesselOf = (id: string, parts: PartSnapshot[], crafts: CraftSnapshot[]): VesselSnapshot => ({ ...base.vessels[0]!, id, parts, crafts, links: [] });

const snapshotOf = (vessels: VesselSnapshot[]): SimSnapshot => ({ ...base, vessels, activeVesselId: vessels[0]!.id });

const blocksOf = (vessel: Vessel): CraftSnapshot[] => vessel.crafts.map((c) => craftBlock(c.craftId, c.parent, c.vehicleId));

describe('engine mounts from the part list', () => {
  it('are the parents of the vehicle tree, for every vehicle of the library', () => {
    for (const vehicle of Object.values(defs.vehicles)) {
      const parts = vesselPartSnapshots(assembleVessel(defs, vehicle.id));
      const expected = new Map<string, string[]>();
      for (const p of vehicle.parts) {
        if (p.parent === null || !isEngine(p.def)) continue;
        expected.set(p.parent, [...(expected.get(p.parent) ?? []), p.id].sort());
      }
      const got = new Map<string, string[]>();
      for (const [host, engines] of engineMounts(defs, parts, () => vehicle.id)) got.set(parts[host]!.instanceId, engines.map((e) => parts[e]!.instanceId).sort());
      expect([...got.entries()].sort(), vehicle.id).toEqual([...expected.entries()].sort());
      // The stack has engines on node mounts and motor packs without nodes: both kinds are in the comparison.
      const engines = vehicle.parts.filter((p) => isEngine(p.def));
      expect(engines.some((p) => defs.parts[p.def]!.attachNodes.length > 0)).toBe(true);
      expect(engines.some((p) => defs.parts[p.def]!.attachNodes.length === 0)).toBe(true);
    }
  });

  it('stay the same after every stage of the stack, in what flies on and in what is left behind', () => {
    const vehicle = Object.values(defs.vehicles)[0]!;
    const parentOf = new Map(vehicle.parts.map((p) => [p.id, p.parent]));
    let vessel = assembleVessel(defs, vehicle.id);
    for (let stage = 0; stage < vehicle.stages.length; stage++) {
      const res = splitForStage(defs, vessel, stage);
      vessel = res.vessel;
      for (const piece of [res.vessel, ...res.spawned]) {
        const parts = vesselPartSnapshots(piece);
        const present = new Set(parts.map((p) => p.instanceId));
        for (const [host, engines] of engineMounts(defs, parts, (p) => p.craftId ?? piece.id)) {
          for (const e of engines) {
            const parent = parentOf.get(parts[e]!.instanceId);
            // An engine whose own mount went with another piece hangs on nothing of the tree any more; every
            // engine that still has its parent aboard is found on it.
            if (parent !== null && parent !== undefined && present.has(parent)) expect(parts[host]!.instanceId, `${parts[e]!.instanceId} after stage ${stage}`).toBe(parent);
          }
        }
      }
    }
  });

  it('never cross from one craft to another of the same vehicle in one vessel', () => {
    const vehicle = Object.values(defs.vehicles)[0]!;
    const a = vesselPartSnapshots(assembleVessel(defs, vehicle.id, { craft: { craftId: 'craft-a', ownerId: null, name: 'A', joinedTick: 0 } }));
    // The second craft of the same vehicle stands beside the first: every part 30 m to starboard.
    const b = vesselPartSnapshots(assembleVessel(defs, vehicle.id, { craft: { craftId: 'craft-b', ownerId: null, name: 'B', joinedTick: 0 } })).map((p) => ({ ...p, localPos: v3.add(p.localPos, v3.new(30, 0, 0)) }));
    const parts = [...a, ...b];
    expect(new Set(parts.map((p) => p.craftId))).toEqual(new Set(['craft-a', 'craft-b']));
    const alone = engineMounts(defs, a, (p) => p.craftId!);
    const both = engineMounts(defs, parts, (p) => p.craftId!);
    expect(both.size).toBe(alone.size * 2);
    for (const [host, engines] of both) for (const e of engines) expect(parts[e]!.craftId).toBe(parts[host]!.craftId);
    // Put on top of each other (the worst case for a rule that looked at places only), they still never mix.
    const stacked = engineMounts(defs, [...a, ...b.map((p, i) => ({ ...p, localPos: a[i]!.localPos }))], (p) => p.craftId!);
    for (const [host, engines] of stacked) for (const e of engines) expect(parts[e]!.craftId).toBe(parts[host]!.craftId);
    expect(stacked.size).toBe(alone.size * 2);
  });
});

describe('the lineage key of a part', () => {
  it('differs between two craft of one vehicle in one vessel, part for part', () => {
    const vehicle = Object.values(defs.vehicles)[0]!;
    const a = vesselPartSnapshots(assembleVessel(defs, vehicle.id, { craft: { craftId: 'craft-a', ownerId: null, name: 'A', joinedTick: 0 } }));
    const b = vesselPartSnapshots(assembleVessel(defs, vehicle.id, { craft: { craftId: 'craft-b', ownerId: null, name: 'B', joinedTick: 0 } }));
    const vessel = vesselOf('a~craft-a~0', [...a, ...b], [craftBlock('craft-a', null, vehicle.id), craftBlock('craft-b', null, vehicle.id)]);
    const snapshot = snapshotOf([vessel]);
    const lineage = new CraftLineage();
    const keys = vessel.parts.map((p) => lineage.keyOf(snapshot, vessel, p));
    expect(new Set(keys).size).toBe(keys.length);
    expect(a.map((p) => p.instanceId)).toEqual(b.map((p) => p.instanceId));
    expect(keys.slice(0, a.length).every((k, i) => k === `craft-a/${a[i]!.instanceId}`)).toBe(true);
    expect(keys.slice(a.length).every((k, i) => k === `craft-b/${b[i]!.instanceId}`)).toBe(true);
    // The part key itself (what an event names a part of an assembly by) is as distinct.
    expect(new Set(vessel.parts.map((p) => partKeyOf(vessel, p))).size).toBe(keys.length);
  });

  it('is kept by every piece through every stage of the stack, as the simulation names its craft', () => {
    const vehicle = Object.values(defs.vehicles)[0]!;
    const lineage = new CraftLineage();
    let vessel = assembleVessel(defs, vehicle.id);
    const launched = vessel.crafts[0]!.craftId;
    let pieces: Vessel[] = [vessel];
    const toSnapshot = (): SimSnapshot => snapshotOf(pieces.map((p) => vesselOf(p.id, vesselPartSnapshots(p), blocksOf(p))));
    const before = toSnapshot();
    const keysAtLaunch = new Map(before.vessels[0]!.parts.map((p) => [p.instanceId, lineage.keyOf(before, before.vessels[0]!, p)]));
    let separations = 0;
    for (let stage = 0; stage < vehicle.stages.length; stage++) {
      const res = splitForStage(defs, vessel, stage);
      vessel = res.vessel;
      pieces = [res.vessel, ...pieces.slice(1), ...res.spawned];
      separations += res.spawned.length;
      const snapshot = toSnapshot();
      for (const v of snapshot.vessels) {
        for (const p of v.parts) {
          // A fairing petal is a part the launch stack did not list under that instance id; every other
          // part is the part it was at launch.
          const atLaunch = keysAtLaunch.get(p.instanceId);
          const key = lineage.keyOf(snapshot, v, p);
          expect(key).toBe(`${launched}/${p.instanceId}`);
          if (atLaunch !== undefined) expect(key).toBe(atLaunch);
        }
      }
    }
    expect(separations).toBeGreaterThan(3);
    // Pieces of pieces exist in this stack's sequence, or the walk above followed one parent only.
    const final = toSnapshot();
    const depth = (id: string): number => {
      const craft = final.vessels.flatMap((v) => v.crafts ?? []).find((c) => c.id === id);
      return craft?.parent ? 1 + depth(craft.parent) : 0;
    };
    expect(Math.max(...final.vessels.flatMap((v) => (v.crafts ?? []).map((c) => depth(c.id))))).toBeGreaterThanOrEqual(1);
  });

  it('follows the parent while it is described, and remembers the answer when the parent has gone', () => {
    const part = (instanceId: string, craftId: string): PartSnapshot => ({ ...base.vessels[0]!.parts[0]!, instanceId, craftId });
    const launched = vesselOf('ship', [part('capsule', 'ship')], [craftBlock('ship', null, 'v')]);
    const stage = vesselOf('ship~tank', [part('tank', 'ship.tank')], [craftBlock('ship.tank', 'ship', 'v')]);
    const shard = vesselOf('ship~nozzle', [part('nozzle', 'ship.tank.nozzle')], [craftBlock('ship.tank.nozzle', 'ship.tank', 'v')]);
    const lineage = new CraftLineage();
    const all = snapshotOf([launched, stage, shard]);
    expect(lineage.keyOf(all, shard, shard.parts[0]!)).toBe('ship/nozzle');
    expect(lineage.keyOf(all, stage, stage.parts[0]!)).toBe('ship/tank');
    // The stage expires: its shard still answers with the launched craft.
    const later = snapshotOf([launched, shard]);
    expect(lineage.keyOf(later, shard, shard.parts[0]!)).toBe('ship/nozzle');
    expect(lineage.knownKeyOf('ship.tank.nozzle', 'nozzle')).toBe('ship/nozzle');
    // A table that first sees the shard after its parent has gone ends the chain at the craft nobody described.
    const fresh = new CraftLineage();
    expect(fresh.keyOf(later, shard, shard.parts[0]!)).toBe('ship.tank/nozzle');
    // A craft the table never saw is its own root; a snapshot without craft blocks files a part under its vessel.
    expect(fresh.knownKeyOf('other', 'x')).toBe('other/x');
    const bare: VesselSnapshot = { ...base.vessels[0]!, id: 'bare', parts: [{ ...base.vessels[0]!.parts[0]!, instanceId: 'p' }] };
    delete bare.crafts;
    delete bare.parts[0]!.craftId;
    expect(craftIdOf(bare, bare.parts[0]!)).toBe('bare');
    expect(fresh.keyOf(snapshotOf([bare]), bare, bare.parts[0]!)).toBe('bare/p');
  });
});
