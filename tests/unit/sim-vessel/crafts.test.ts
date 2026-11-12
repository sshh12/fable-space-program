/**
 * The craft model (docs/ARCHITECTURE.md 7.2 and section 3; MIGRATION_V2 step 3.3): a vessel is a forest of
 * craft plus dock links. The momentum-conserving dock merge and its split, rings, per-craft stage stacks
 * and flow groups, the id rules through dock, undock and re-dock, pre-mated ports, the command part.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import {
  addLink,
  assembleVessel,
  cloneVessel,
  combinedMomentum,
  computeMassProps,
  dockBase,
  dockMerge,
  eventPartId,
  findPartByKey,
  fireNextStage,
  mergeVessels,
  momentumOf,
  partKeyOf,
  seededCraftIds,
  snapPose,
  stagingInfo,
  stepVessel,
  structureOf,
  undock,
  vesselStateHash,
  type Momentum,
  type Vessel,
} from '@/sim/vessel';
import type { StepContext } from '@/sim/vessel/types';
import { dockingLibrary, ferry, hub, mate, offsetTug, partIndex, partPoses } from './dockingFixtures';
import { controls, DT, earthAir, loadLibrary, makeEnv, placeUpright, VEHICLE } from './helpers';

let lib: DefLibrary;
beforeAll(async () => {
  lib = dockingLibrary(await loadLibrary());
});

const ctxAt = (tick: number): StepContext => ({ ut: tick / 120, env: null, instant: false, events: [], spawned: [] });
const relative = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => v3.dist(a, b) / Math.max(v3.len(b), 1e-30);
const total = (vessels: readonly Vessel[]): Momentum => combinedMomentum(vessels.map(momentumOf));

/** Two ferries nose to nose, port on port, each with its own velocity and spin. `scale` moves the pair out to an orbital radius. */
function pair(origin: { x: number; y: number; z: number }): { a: Vessel; b: Vessel } {
  const a = ferry(lib, 'ferry-a');
  const b = ferry(lib, 'ferry-b');
  a.r = v3.clone(origin);
  a.q = quat.normalize({ x: 0.12, y: -0.31, z: 0.2, w: 0.92 });
  // Port on port, the second ferry rolled about the port axis by an angle that is nothing round.
  mate(a, partIndex(a, 'ferry-a/port'), b, partIndex(b, 'ferry-b/port'), 0.6435);
  a.v = { x: 7612.4, y: -31.7, z: 250.3 };
  a.w = { x: 0.6 * DEG, y: -0.2 * DEG, z: 0.35 * DEG };
  b.v = { x: 7612.52, y: -31.61, z: 250.22 };
  b.w = { x: -0.4 * DEG, y: 0.9 * DEG, z: 0.1 * DEG };
  // Drain one side so the two masses differ.
  b.parts[partIndex(b, 'ferry-b/tank')]!.resources[0] = 2500;
  computeMassProps(a);
  computeMassProps(b);
  return { a, b };
}

describe('dock merge', () => {
  it('conserves linear momentum to 1e-6 and angular momentum about the common centre of mass to 1e-9, and re-roots no tree', () => {
    for (const origin of [{ x: 120, y: -40, z: 310 }, { x: 4.1e6, y: -3.9e6, z: 3.3e6 }]) {
      const { a, b } = pair(origin);
      const before = total([a, b]);
      const roots = [...a.parts, ...b.parts].filter((p) => p.parent < 0).map((p) => p.instanceId);
      const parents = new Map([...a.parts.map((p, i) => [partKeyOf(a, i), p.parent < 0 ? null : partKeyOf(a, p.parent)] as const), ...b.parts.map((p, i) => [partKeyOf(b, i), p.parent < 0 ? null : partKeyOf(b, p.parent)] as const)]);
      const base = dockBase(a, b);
      const other = base === a ? b : a;
      expect(base).toBe(a);
      dockMerge(base, other, partIndex(base, 'ferry-a/port'), partIndex(other, 'ferry-b/port'), 1000);
      const after = momentumOf(base);
      expect(Math.abs(after.mass - before.mass) / before.mass).toBeLessThan(1e-14);
      expect(relative(after.linear, before.linear)).toBeLessThan(1e-12);
      expect(relative(after.angular, before.angular)).toBeLessThan(1e-9);
      expect(v3.dist(after.com, before.com)).toBeLessThan(1e-8);
      // The forest: both craft keep their tree and their root; the joint is a link.
      expect(base.crafts.map((c) => c.craftId)).toEqual(['ferry-a', 'ferry-b']);
      expect(base.parts.filter((p) => p.parent < 0).map((p) => p.instanceId)).toEqual(roots);
      base.parts.forEach((p, i) => expect(p.parent < 0 ? null : partKeyOf(base, p.parent)).toBe(parents.get(partKeyOf(base, i))));
      expect(base.links).toHaveLength(1);
      expect(partKeyOf(base, base.links[0]!.a)).toBe('ferry-a/port');
      expect(partKeyOf(base, base.links[0]!.b)).toBe('ferry-b/port');
      expect(base.crafts[1]!.joinedTick).toBe(1000);
      expect(other.parts).toHaveLength(0);
    }
  });

  it('merge then split restores every part pose and conserves both momenta', () => {
    const report: string[] = [];
    for (const [label, origin, tolerance] of [
      ['near the origin', { x: 120, y: -40, z: 310 }, 1e-9],
      ['at an orbital radius', { x: 4.1e6, y: -3.9e6, z: 3.3e6 }, 1e-9],
    ] as const) {
      const { a, b } = pair(origin);
      const before = total([a, b]);
      const poses = partPoses([a, b]);
      dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'ferry-b/port'), 1000);
      expect(a.id).toBe('a~ferry-a~1000');
      const ctx = ctxAt(1200);
      const created = undock(a, 0, 0, ctx);
      expect(created).toHaveLength(1);
      const pieces = [a, ...created];
      expect(pieces.map((v) => v.id).sort()).toEqual(['ferry-a', 'ferry-b']);
      expect(pieces.every((v) => v.links.length === 0 && v.crafts.length === 1)).toBe(true);
      const now = partPoses(pieces);
      expect([...now.keys()].sort()).toEqual([...poses.keys()].sort());
      let worstPos = 0;
      let worstDir = 0;
      for (const [key, p] of poses) {
        const q = now.get(key)!;
        worstPos = Math.max(worstPos, v3.dist(p.pos, q.pos));
        worstDir = Math.max(worstDir, v3.dist(p.x, q.x), v3.dist(p.y, q.y));
      }
      // Measured: 3.6e-15 m near the origin, 0 m at an orbital radius (where a float64 position resolves 9.3e-10 m).
      expect(worstPos, label).toBeLessThan(tolerance);
      expect(worstDir, label).toBeLessThan(1e-12);
      const after = total(pieces);
      expect(relative(after.linear, before.linear), label).toBeLessThan(1e-6);
      expect(relative(after.angular, before.angular), label).toBeLessThan(1e-9);
      report.push(`${label}: part poses within ${worstPos.toExponential(2)} m and ${worstDir.toExponential(2)} of a unit axis; linear momentum ${relative(after.linear, before.linear).toExponential(2)}, angular ${relative(after.angular, before.angular).toExponential(2)} relative`);
      expect(ctx.events.map((e) => e.type)).toEqual(['undocked']);
    }
    console.log(`merge then split: ${report.join('; ')}`);
  });

  it('the undock spring acts at the port: equal and opposite, a push and a turn, momentum conserved', () => {
    const { a, b } = pair({ x: 120, y: -40, z: 310 });
    dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'ferry-b/port'), 1000);
    const before = momentumOf(a);
    const ctx = ctxAt(1200);
    const [other] = undock(a, 0, 600, ctx);
    const after = total([a, other!]);
    expect(relative(after.linear, before.linear)).toBeLessThan(1e-9);
    expect(relative(after.angular, before.angular)).toBeLessThan(1e-9);
    // 600 N s on a ferry of some 16 t: centimetres per second apart along the port axis.
    const axis = quat.rotate(a.q, quat.rotate(a.parts[partIndex(a, 'ferry-a/port')]!.rot, { x: 0, y: 1, z: 0 }));
    const closing = v3.dot(v3.sub(momentumOf(other!).comVelocity, momentumOf(a).comVelocity), axis);
    expect(closing).toBeGreaterThan(0.03);
    expect(closing).toBeLessThan(0.2);
  });

  it('snapPose puts the two port faces exactly on each other', () => {
    const { a, b } = pair({ x: 120, y: -40, z: 310 });
    // A capture leaves a residual: millimetres and a fraction of a degree.
    b.r = v3.add(b.r, { x: 0.003, y: -0.002, z: 0.004 });
    b.q = quat.normalize(quat.mul(b.q, quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, 0.08 * DEG)));
    const ia = partIndex(a, 'ferry-a/port');
    const ib = partIndex(b, 'ferry-b/port');
    dockMerge(a, b, ia, ib, 1000, snapPose(a, b, ia, ib));
    const pa = a.parts[a.links[0]!.a]!;
    const pb = a.parts[a.links[0]!.b]!;
    const face = (p: typeof pa) => v3.add(p.pos, quat.rotate(p.rot, { x: 0, y: 0.4, z: 0 }));
    expect(v3.dist(face(pa), face(pb))).toBeLessThan(1e-12);
    expect(v3.dot(quat.rotate(pa.rot, { x: 0, y: 1, z: 0 }), quat.rotate(pb.rot, { x: 0, y: 1, z: 0 }))).toBeCloseTo(-1, 12);
  });

  it('refuses a part without a docking face, a craft that is in both vessels, and the clamp weld for two craft', () => {
    const { a, b } = pair({ x: 0, y: 0, z: 0 });
    expect(() => dockMerge(a, b, partIndex(a, 'ferry-a/capsule'), partIndex(b, 'ferry-b/port'), 1)).toThrow(/attach node of kind "dock"/);
    const twin = ferry(lib, 'ferry-a');
    expect(() => dockMerge(a, twin, partIndex(a, 'ferry-a/port'), partIndex(twin, 'ferry-a/port'), 1)).toThrow(/craft "ferry-a" is in both vessels/);
    expect(() => mergeVessels(a, b)).toThrow(/welds pieces that left one craft/);
  });
});

describe('rings and chains', () => {
  /** Three hubs in a chain A-B-C, closed into a ring by a third link C-A. */
  function ring(): Vessel {
    const a = hub(lib, 'hub-a');
    const b = hub(lib, 'hub-b');
    const c = hub(lib, 'hub-c');
    mate(a, partIndex(a, 'hub-a/port-top'), b, partIndex(b, 'hub-b/port-bottom'));
    dockMerge(a, b, partIndex(a, 'hub-a/port-top'), partIndex(b, 'hub-b/port-bottom'), 500);
    mate(a, partIndex(a, 'hub-b/port-top'), c, partIndex(c, 'hub-c/port-bottom'));
    dockMerge(a, c, partIndex(a, 'hub-b/port-top'), partIndex(c, 'hub-c/port-bottom'), 600);
    addLink(a, partIndex(a, 'hub-c/port-top'), partIndex(a, 'hub-a/port-bottom'));
    return a;
  }
  const linkBetween = (v: Vessel, x: string, y: string): number => v.links.findIndex((l) => [partKeyOf(v, l.a), partKeyOf(v, l.b)].sort().join() === [x, y].sort().join());

  it('a ring of three links: one release separates nothing, the second splits where the two releases are', () => {
    const v = ring();
    expect(v.id).toBe('a~hub-a~500');
    expect(v.links).toHaveLength(3);
    expect(v.crafts.map((c) => c.craftId)).toEqual(['hub-a', 'hub-b', 'hub-c']);
    const parts = v.parts.length;
    const before = momentumOf(v);

    // Release B-C: the ring is still held by A-B and C-A.
    const ctx1 = ctxAt(700);
    expect(undock(v, linkBetween(v, 'hub-b/port-top', 'hub-c/port-bottom'), 500, ctx1)).toHaveLength(0);
    expect(v.links).toHaveLength(2);
    expect(v.parts).toHaveLength(parts);
    expect(v.id).toBe('a~hub-a~500');
    expect(relative(momentumOf(v).linear, before.linear)).toBe(0);
    expect(ctx1.events).toHaveLength(1);
    expect(ctx1.events[0]).toMatchObject({ type: 'undocked', newVesselIds: [] });

    // Release A-B: B leaves alone; A and C stay together through C-A and keep the assembly id.
    const ctx2 = ctxAt(800);
    const created = undock(v, linkBetween(v, 'hub-a/port-top', 'hub-b/port-bottom'), 0, ctx2);
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe('hub-b');
    expect(created[0]!.crafts.map((c) => c.craftId)).toEqual(['hub-b']);
    expect(created[0]!.parts.map((p) => p.instanceId).sort()).toEqual(['core', 'port-bottom', 'port-top']);
    expect(v.id).toBe('a~hub-a~500');
    expect(v.crafts.map((c) => c.craftId)).toEqual(['hub-a', 'hub-c']);
    expect(v.links).toHaveLength(1);
    expect(v.parts).toHaveLength(6);
    expect(relative(total([v, created[0]!]).linear, before.linear)).toBeLessThan(1e-12);
    // Every part still belongs to its craft and every link joins two port parts of the vessel.
    for (const piece of [v, created[0]!]) {
      piece.parts.forEach((p) => expect(piece.crafts[p.craft]).toBeDefined());
      for (const l of piece.links) expect(piece.parts[l.a]!.def.id === 'test-port' && piece.parts[l.b]!.def.id === 'test-port').toBe(true);
    }
  });

  it('a chain of four cut in the middle: the tie of two craft each goes to the piece with the lowest craft id', () => {
    const vs = ['hub-a', 'hub-b', 'hub-c', 'hub-d'].map((id) => hub(lib, id));
    const v = vs[0]!;
    for (let k = 1; k < 4; k++) {
      const from = `hub-${'abcd'[k - 1]}/port-top`;
      const to = `hub-${'abcd'[k]}/port-bottom`;
      mate(v, partIndex(v, from), vs[k]!, partIndex(vs[k]!, to));
      dockMerge(v, vs[k]!, partIndex(v, from), partIndex(vs[k]!, to), 100 * k);
    }
    expect(v.id).toBe('a~hub-a~100');
    const ctx = ctxAt(900);
    const created = undock(v, v.links.findIndex((l) => partKeyOf(v, l.a) === 'hub-b/port-top'), 0, ctx);
    expect(created).toHaveLength(1);
    expect(v.id).toBe('a~hub-a~100');
    expect(v.crafts.map((c) => c.craftId)).toEqual(['hub-a', 'hub-b']);
    expect(created[0]!.id).toBe('a~hub-c~900');
    expect(created[0]!.crafts.map((c) => c.craftId)).toEqual(['hub-c', 'hub-d']);
    expect(created[0]!.links).toHaveLength(1);
  });
});

describe('per-craft stage stacks and flow groups', () => {
  function docked(): Vessel {
    const a = ferry(lib, 'ferry-a');
    const b = ferry(lib, 'ferry-b');
    mate(a, partIndex(a, 'ferry-a/port'), b, partIndex(b, 'ferry-b/port'));
    a.r = { x: 0, y: 6771000, z: 0 };
    mate(a, partIndex(a, 'ferry-a/port'), b, partIndex(b, 'ferry-b/port'));
    a.v = b.v = { x: 7670, y: 0, z: 0 };
    dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'ferry-b/port'), 240);
    return a;
  }
  const engineOf = (v: Vessel, craft: string) => {
    const m = v.parts[partIndex(v, `${craft}/engine`)]!.modules[0]!;
    if (m.type !== 'engine') throw new Error('no engine');
    return m;
  };
  const tank = (v: Vessel, craft: string): number => v.parts[partIndex(v, `${craft}/tank`)]!.resources[0]!;

  it('two craft of the same vehicle in one vessel fire only their own stages', () => {
    const v = docked();
    const env = makeEnv({});
    expect(v.crafts.map((c) => c.vehicleId)).toEqual(['test-ferry', 'test-ferry']);
    // B's owner presses: B's engine, not A's (same instance id "engine").
    const press = fireNextStage(v, env, 1);
    expect(press.ok).toBe(true);
    expect(press.events[0]).toMatchObject({ type: 'stageFired', stageIndex: 0, label: 'Engine' });
    expect(engineOf(v, 'ferry-b').active).toBe(true);
    expect(engineOf(v, 'ferry-a').active).toBe(false);
    expect(v.crafts.map((c) => c.nextStage)).toEqual([0, 1]);
    expect(v.crafts.map((c) => c.stageLockout > 0)).toEqual([false, true]);
    // The helm's press is A's (the helm is on the base craft).
    expect(v.helm.craft).toBe(0);
    expect(stagingInfo(v, env).map((s) => s.fired)).toEqual([false, false]);
    expect(stagingInfo(v, env, 1).map((s) => s.fired)).toEqual([true, false]);

    // Under throttle only B's engine burns, and only from B's tanks: docking pools nothing.
    const a0 = tank(v, 'ferry-a');
    const b0 = tank(v, 'ferry-b');
    for (let i = 0; i < 240; i++) stepVessel(v, env, controls({ throttle: 1 }), DT);
    expect(engineOf(v, 'ferry-b').thrust).toBeGreaterThan(1000);
    expect(engineOf(v, 'ferry-a').thrust).toBe(0);
    expect(tank(v, 'ferry-a')).toBe(a0);
    expect(tank(v, 'ferry-b')).toBeLessThan(b0 - 1);
    expect(structureOf(v).engines.find((e) => v.parts[e.part]!.craft === 1)!.tanks.flat().every((t) => v.parts[t.part]!.craft === 1)).toBe(true);

    // B's second stage drops B's service module; A's is untouched and the vessel stays an assembly.
    const parts = v.parts.length;
    let spawned: Vessel[] = [];
    for (let i = 0; i < 80 && spawned.length === 0; i++) {
      const res = fireNextStage(v, env, 1);
      if (res.ok) spawned = res.spawned;
      else stepVessel(v, env, controls(), DT);
    }
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.id).toBe('ferry-b~sep');
    // What left is a craft of its own: a new id, the lineage, its own root. The vessel id has the piece's form.
    expect(spawned[0]!.crafts.map((c) => [c.craftId, c.parent, c.root])).toEqual([['ferry-b.sep', 'ferry-b', 'sep']]);
    expect(v.crafts.map((c) => [c.craftId, c.parent, c.root])).toEqual([['ferry-a', null, 'capsule'], ['ferry-b', null, 'capsule']]);
    expect(spawned[0]!.crafts[0]!.ownerId).toBe('owner-of-ferry-b');
    expect(spawned[0]!.parts.map((p) => p.instanceId).sort()).toEqual(['engine', 'sep', 'tank']);
    expect(v.parts).toHaveLength(parts - 3);
    expect(v.id).toBe('a~ferry-a~240');
    expect(partIndex(v, 'ferry-a/tank')).toBeGreaterThanOrEqual(0);
    expect(partIndex(v, 'ferry-b/tank')).toBe(-1);
    expect(v.crafts.map((c) => c.nextStage)).toEqual([0, 2]);
    // Events of an assembly name parts by key; a vessel of one craft by instance id.
    expect(eventPartId(v, v.parts[partIndex(v, 'ferry-a/engine')]!)).toBe('ferry-a/engine');
    expect(eventPartId(spawned[0]!, spawned[0]!.parts[0]!)).toBe('sep');
  });

  it('a part is found by its key; an instance id alone is not a key and names nothing', () => {
    const v = docked();
    expect(v.parts[findPartByKey(v, 'ferry-b/capsule')]!.craft).toBe(1);
    expect(findPartByKey(v, 'capsule')).toBe(-1);
    expect(findPartByKey(v, 'ferry-c/capsule')).toBe(-1);
    const single = ferry(lib, 'ferry-x');
    expect(findPartByKey(single, 'capsule')).toBe(-1);
    expect(findPartByKey(single, 'ferry-x/capsule')).toBe(0);
  });
});

describe('ids', () => {
  /** Dock, undock of the base craft alone, re-dock, with a third craft joining: the id of every vessel after each operation. */
  function story(): string[][] {
    const ids = seededCraftIds();
    const make = (): Vessel => assembleVessel(lib, 'test-hub', { craft: { craftId: ids.next('test-hub') } });
    const a = make();
    const b = make();
    const c = make();
    const log: string[][] = [[a.id, b.id, c.id]];
    const key = (v: Vessel, craft: string, part: string): number => partIndex(v, `${craft}/${part}`);
    // A and B dock at tick 100.
    mate(a, key(a, 'test-hub', 'port-top'), b, key(b, 'test-hub-2', 'port-bottom'));
    dockMerge(a, b, key(a, 'test-hub', 'port-top'), key(b, 'test-hub-2', 'port-bottom'), 100);
    log.push([a.id, c.id]);
    // C joins the assembly at tick 200.
    mate(a, key(a, 'test-hub-2', 'port-top'), c, key(c, 'test-hub-3', 'port-bottom'));
    dockMerge(a, c, key(a, 'test-hub-2', 'port-top'), key(c, 'test-hub-3', 'port-bottom'), 200);
    log.push([a.id]);
    // The base craft undocks alone at tick 300: it is its craft id again, the rest keeps the assembly id.
    const ctx = ctxAt(300);
    const rest = undock(a, a.links.findIndex((l) => partKeyOf(a, l.a) === 'test-hub/port-top'), 0, ctx)[0]!;
    log.push([a.id, rest.id]);
    // It docks again at tick 400, now at the other end: the assembly keeps its id.
    mate(rest, key(rest, 'test-hub-3', 'port-top'), a, key(a, 'test-hub', 'port-bottom'));
    dockMerge(rest, a, key(rest, 'test-hub-3', 'port-top'), key(a, 'test-hub', 'port-bottom'), 400);
    log.push([rest.id]);
    // Everything comes apart at tick 500 and 600.
    const ctx5 = ctxAt(500);
    const first = undock(rest, 0, 0, ctx5);
    log.push([rest.id, ...first.map((v) => v.id)]);
    const still = [rest, ...first].find((v) => v.crafts.length > 1)!;
    const ctx6 = ctxAt(600);
    const second = undock(still, 0, 0, ctx6);
    log.push([rest.id, ...first.map((v) => v.id), ...second.map((v) => v.id)].sort());
    return log;
  }

  it('are unique at every step and identical in a replay: dock, base-craft undock, re-dock', () => {
    const log = story();
    expect(log[0]).toEqual(['test-hub', 'test-hub-2', 'test-hub-3']);
    expect(log[1]).toEqual(['a~test-hub~100', 'test-hub-3']);
    expect(log[2]).toEqual(['a~test-hub~100']);
    expect(log[3]).toEqual(['test-hub', 'a~test-hub~100']);
    expect(log[4]).toEqual(['a~test-hub~100']);
    expect(log[6]).toEqual(['test-hub', 'test-hub-2', 'test-hub-3']);
    for (const step of log) expect(new Set(step).size).toBe(step.length);
    expect(story()).toEqual(log);
  });

  it('the seeded source counts per vehicle and never repeats', () => {
    const ids = seededCraftIds('u1:');
    expect([ids.next('x'), ids.next('y'), ids.next('x'), ids.next('x')]).toEqual(['u1:x', 'u1:y', 'u1:x-2', 'u1:x-3']);
  });

  it('a craft id is in one vessel only: the piece with the root part keeps the craft, what leaves is a new craft with its lineage', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c7', ownerId: 'acct' } });
    expect(v.id).toBe('c7');
    const env = makeEnv({ atmosphere: earthAir });
    placeUpright(v, env, 120);
    const spawned = [...fireNextStage(v, env).spawned];
    for (let i = 0; i < 480; i++) spawned.push(...stepVessel(v, env, controls({ throttle: 1 }), DT).spawned);
    expect(v.id).toBe('c7');
    expect(spawned.map((s) => s.id)).toEqual(['c7~clamp-1']);
    expect(spawned[0]!.crafts[0]).toMatchObject({ craftId: 'c7.clamp-1', parent: 'c7', root: 'clamp-1', ownerId: 'acct' });
    expect(v.crafts[0]).toMatchObject({ craftId: 'c7', parent: null, root: 'capsule' });
    // The four clamps left as four pieces and were welded into one held structure: one craft, one id.
    expect(spawned[0]!.parts.filter((p) => p.modules.some((m) => m.type === 'launchClamp')).length).toBe(4);
    expect(spawned[0]!.crafts).toHaveLength(1);
    // Fly on through the first stage separation: every vessel that exists is its own craft.
    const all = [v, ...spawned];
    for (let i = 0; i < 4 && all.length < 3; i++) {
      const res = fireNextStage(v, env);
      all.push(...res.spawned);
      for (let k = 0; k < 240; k++) all.push(...stepVessel(v, env, controls({ throttle: 1 }), DT).spawned);
    }
    const craftIds = all.flatMap((x) => x.crafts.map((c) => c.craftId));
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(new Set(craftIds).size).toBe(craftIds.length);
    for (const x of all.slice(1)) {
      expect(x.crafts[0]!.parent).toBe('c7');
      expect(x.crafts[0]!.craftId).toBe(`c7.${x.crafts[0]!.root}`);
      expect(x.id).toBe(`c7~${x.crafts[0]!.root}`);
      expect(x.parts.some((p) => p.instanceId === x.crafts[0]!.root)).toBe(true);
    }
    // An id that would break the composed forms is refused where it enters.
    expect(() => assembleVessel(lib, VEHICLE, { craft: { craftId: 'c/7' } })).toThrow(/"c\/7" contains '\/'/);
    expect(() => assembleVessel(lib, VEHICLE, { craft: { craftId: 'c~7' } })).toThrow(/contains '~'/);
    expect(() => assembleVessel(lib, VEHICLE, { craft: { craftId: 'c.7' } })).toThrow(/contains '\.'/);
    expect(() => seededCraftIds('u/').next('x')).toThrow(/contains '\/'/);
  });
});

describe('pre-mated ports and the command part', () => {
  it('two ports mated in the vehicle file are a dock link; the stage action undock releases it', () => {
    const v = assembleVessel(lib, 'test-tandem', { craft: { craftId: 't1' } });
    // Each tree is a craft: the tree of the vehicle's root has the given id, the tug its own.
    expect(v.crafts.map((c) => [c.craftId, c.parent, c.root])).toEqual([['t1', null, 'capsule'], ['t1-2', null, 'tug-port']]);
    expect(v.id).toBe('a~t1~0');
    expect(v.parts.map((p) => p.craft)).toEqual([0, 0, 1, 1, 1]);
    expect(v.links).toHaveLength(1);
    expect([partKeyOf(v, v.links[0]!.a), partKeyOf(v, v.links[0]!.b)]).toEqual(['t1/port', 't1-2/tug-port']);
    // The tug is its own tree: its port is a root, the faces coincide.
    expect(v.parts.filter((p) => p.parent < 0).map((p) => p.instanceId)).toEqual(['capsule', 'tug-port']);
    const face = (i: number) => v3.add(v.parts[i]!.pos, quat.rotate(v.parts[i]!.rot, { x: 0, y: 0.4, z: 0 }));
    expect(v3.dist(face(v.links[0]!.a), face(v.links[0]!.b))).toBeLessThan(1e-12);
    const env = makeEnv({});
    v.r = { x: 0, y: 6771000, z: 0 };
    v.v = { x: 7670, y: 0, z: 0 };
    // The stage stack is the craft's: the tug's engine and the tug's port are fired by the tug craft.
    expect(fireNextStage(v, env, 1).ok).toBe(true);
    for (let i = 0; i < 80; i++) stepVessel(v, env, controls(), DT);
    const before = momentumOf(v);
    const res = fireNextStage(v, env, 1);
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual(['stageFired', 'engineShutdown', 'undocked'].filter((t) => res.events.some((e) => e.type === t)));
    expect(res.events.some((e) => e.type === 'undocked')).toBe(true);
    expect(res.spawned).toHaveLength(1);
    expect(v.id).toBe('t1');
    expect(res.spawned[0]!.id).toBe('t1-2');
    expect(res.spawned[0]!.crafts.map((c) => c.craftId)).toEqual(['t1-2']);
    expect(v.crafts.map((c) => c.craftId)).toEqual(['t1']);
    expect(v.links).toHaveLength(0);
    expect(v.parts.map((p) => p.instanceId)).toEqual(['capsule', 'port']);
    expect(relative(total([v, res.spawned[0]!]).linear, before.linear)).toBeLessThan(1e-12);
    // The two that were released dock again: two craft, ordinary docking, an assembly of both.
    const tug = res.spawned[0]!;
    mate(v, partIndex(v, 't1/port'), tug, partIndex(tug, 't1-2/tug-port'));
    tug.v = v3.clone(v.v);
    tug.w = v3.zero();
    v.w = v3.zero();
    dockMerge(v, tug, partIndex(v, 't1/port'), partIndex(tug, 't1-2/tug-port'), 2000);
    expect(v.crafts.map((c) => c.craftId)).toEqual(['t1', 't1-2']);
    expect(v.id).toBe('a~t1~2000');
    expect(v.links).toHaveLength(1);
  });

  it('two pieces of what was one craft dock again: the piece that left is a craft of its own', () => {
    const v = ferry(lib, 'ferry-a');
    const env = makeEnv({});
    v.r = { x: 0, y: 6771000, z: 0 };
    v.v = { x: 7670, y: 0, z: 0 };
    expect(fireNextStage(v, env).ok).toBe(true);
    let spawned: Vessel[] = [];
    for (let i = 0; i < 80 && spawned.length === 0; i++) {
      const res = fireNextStage(v, env);
      if (res.ok) spawned = res.spawned;
      else stepVessel(v, env, controls(), DT);
    }
    const sm = spawned[0]!;
    expect([v.crafts[0]!.craftId, sm.crafts[0]!.craftId, sm.crafts[0]!.parent]).toEqual(['ferry-a', 'ferry-a.sep', 'ferry-a']);
    // A second ferry docks to the capsule that kept the craft; its own service module could come back the
    // same way: no craft id is in two vessels, so the "is in both vessels" refusal cannot trip on a piece.
    const other = ferry(lib, 'ferry-b');
    mate(v, partIndex(v, 'ferry-a/port'), other, partIndex(other, 'ferry-b/port'));
    dockMerge(v, other, partIndex(v, 'ferry-a/port'), partIndex(other, 'ferry-b/port'), 3000);
    const ids = [...v.crafts, ...sm.crafts].map((c) => c.craftId);
    expect(ids).toEqual(['ferry-a', 'ferry-b', 'ferry-a.sep']);
    expect(new Set(ids).size).toBe(3);
  });

  it('the command part carries the crew, the cockpit and the camera seat the vehicle names for it', () => {
    const v = assembleVessel(lib, VEHICLE);
    const capsule = v.parts[0]!;
    const vehicle = lib.vehicles[VEHICLE]!;
    expect(capsule.command).not.toBeNull();
    expect(capsule.command!.crew).toEqual(vehicle.crew);
    expect(capsule.command!.cockpit).toBe(vehicle.cockpit);
    expect(capsule.command!.cameraSeat).toBe(vehicle.cameras.cockpit.seat);
    expect(capsule.command!.remote).toBe(false);
    expect(v.parts.filter((p) => p.command !== null)).toHaveLength(1);
    expect(v.helm).toEqual({ accountId: null, craft: 0, controlPart: 0 });
    const m = capsule.modules[capsule.command!.module]!;
    expect(m.type === 'command' && m.crew).toBe(vehicle.crew.length);
    // A copy is a copy.
    const copy = cloneVessel(v);
    copy.parts[0]!.command!.crew.pop();
    copy.crafts[0]!.nextStage = 5;
    expect(v.parts[0]!.command!.crew).toHaveLength(vehicle.crew.length);
    expect(v.crafts[0]!.nextStage).toBe(0);
    // The hub has no command part and is flown from its first part.
    const h = hub(lib, 'hub-x');
    expect(h.parts.every((p) => p.command === null)).toBe(true);
    expect(h.helm.controlPart).toBe(0);
  });

  it('the state hash tells two assemblies apart that differ only in a craft', () => {
    const make = (owner: string): Vessel => {
      const a = hub(lib, 'hub-a');
      const b = assembleVessel(lib, 'test-hub', { craft: { craftId: 'hub-b', ownerId: owner } });
      mate(a, partIndex(a, 'hub-a/port-top'), b, partIndex(b, 'hub-b/port-bottom'));
      dockMerge(a, b, partIndex(a, 'hub-a/port-top'), partIndex(b, 'hub-b/port-bottom'), 10);
      return a;
    };
    expect(vesselStateHash(make('p1'))).toBe(vesselStateHash(make('p1')));
    expect(vesselStateHash(make('p1'))).not.toBe(vesselStateHash(make('p2')));
  });
});

// ------------------------------------------------------------------------------------- review findings

type M3 = [number, number, number, number, number, number, number, number, number];
const rotOf = (q: { x: number; y: number; z: number; w: number }): M3 => {
  const ex = quat.rotate(q, { x: 1, y: 0, z: 0 });
  const ey = quat.rotate(q, { x: 0, y: 1, z: 0 });
  const ez = quat.rotate(q, { x: 0, y: 0, z: 1 });
  return [ex.x, ey.x, ez.x, ex.y, ey.y, ez.y, ex.z, ey.z, ez.z];
};
const mul3 = (a: M3, b: M3): M3 => {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j]! += a[3 * i + k]! * b[3 * k + j]!;
  return o;
};
const transpose3 = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const apply3 = (a: M3, v: { x: number; y: number; z: number }) => ({ x: a[0] * v.x + a[1] * v.y + a[2] * v.z, y: a[3] * v.x + a[4] * v.y + a[5] * v.z, z: a[6] * v.x + a[7] * v.y + a[8] * v.z });
const frob = (a: M3): number => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
/** Solve a 3x3 system by Cramer's rule (independent of the vessel package's tensor inverse). */
function solve3(a: M3, b: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const det = (m: M3): number => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const d = det(a);
  const col = (k: number): M3 => a.map((x, i) => (i % 3 === k ? [b.x, b.y, b.z][Math.floor(i / 3)]! : x)) as M3;
  return { x: det(col(0)) / d, y: det(col(1)) / d, z: det(col(2)) / d };
}
interface Rigid {
  mass: number;
  com: { x: number; y: number; z: number };
  vcom: { x: number; y: number; z: number };
  omega: { x: number; y: number; z: number };
  /** Inertia about the centre of mass, world axes. */
  inertia: M3;
}
/** A vessel as a rigid body in world axes, from its raw state and mass properties (nothing of dock.ts). */
function rigid(v: Vessel): Rigid {
  const i = v.mp.i;
  const body: M3 = [i[0]!, i[3]!, i[4]!, i[3]!, i[1]!, i[5]!, i[4]!, i[5]!, i[2]!];
  const R = rotOf(v.q);
  return {
    mass: v.mp.mass,
    com: v3.add(v.r, quat.rotate(v.q, v.mp.com)),
    vcom: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, v.mp.com))),
    omega: quat.rotate(v.q, v.w),
    inertia: mul3(mul3(R, body), transpose3(R)),
  };
}
/** The body two rigid bodies make when they are joined as they are: the parallel-axis composition. */
function compose(bodies: Rigid[]): Rigid & { L: { x: number; y: number; z: number } } {
  const mass = bodies.reduce((s, b) => s + b.mass, 0);
  let com = v3.zero();
  let vcom = v3.zero();
  for (const b of bodies) {
    com = v3.addScaled(com, b.com, b.mass / mass);
    vcom = v3.addScaled(vcom, b.vcom, b.mass / mass);
  }
  const inertia = [0, 0, 0, 0, 0, 0, 0, 0, 0] as M3;
  let L = v3.zero();
  for (const b of bodies) {
    const d = v3.sub(b.com, com);
    const d2 = v3.dot(d, d);
    const shift: M3 = [d2 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, d2 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, d2 - d.z * d.z];
    for (let k = 0; k < 9; k++) inertia[k]! += b.inertia[k]! + b.mass * shift[k]!;
    L = v3.add(L, v3.add(apply3(b.inertia, b.omega), v3.scale(v3.cross(d, v3.sub(b.vcom, vcom)), b.mass)));
  }
  return { mass, com, vcom, omega: solve3(inertia, L), inertia, L };
}

/** A crewed ferry and a tug docked by the tug's flank port: no common axis, unequal masses, both turning. */
function skewPair(): { a: Vessel; b: Vessel } {
  const a = ferry(lib, 'ferry-a');
  const b = offsetTug(lib, 'tug-b');
  // Near the origin of the frame, so that the comparison is not limited by the resolution of positions at an
  // orbital radius (1e-9 m there; the merge at such a radius is the collinear test above).
  a.r = { x: 120, y: -40, z: 310 };
  a.q = quat.normalize({ x: -0.21, y: 0.44, z: 0.17, w: 0.86 });
  mate(a, partIndex(a, 'ferry-a/port'), b, partIndex(b, 'tug-b/side-port'), 37 * DEG);
  a.v = { x: 5210.4, y: 4893.1, z: 1740.9 };
  a.w = { x: 1.3 * DEG, y: -0.7 * DEG, z: 0.9 * DEG };
  b.v = { x: 5210.31, y: 4893.22, z: 1740.83 };
  b.w = { x: -0.8 * DEG, y: 1.6 * DEG, z: -1.1 * DEG };
  // Unequal: the ferry's tanks are nearly dry, the tug's are full.
  a.parts[partIndex(a, 'ferry-a/tank')]!.resources[0] = 300;
  a.parts[partIndex(a, 'ferry-a/tank')]!.resources[1] = 100;
  computeMassProps(a);
  computeMassProps(b);
  return { a, b };
}

describe('docking without symmetry', () => {
  it('the merged body is the parallel-axis composition of the two: mass, centre, inertia, both momenta, the turn rate', () => {
    const { a, b } = skewPair();
    // The case is what it claims: the axes of the two are tens of degrees apart, the masses differ.
    const noseA = quat.rotate(a.q, { x: 0, y: 1, z: 0 });
    const noseB = quat.rotate(b.q, { x: 0, y: 1, z: 0 });
    const between = Math.acos(v3.dot(noseA, noseB)) / DEG;
    expect(between).toBeGreaterThan(25);
    expect(between).toBeLessThan(155);
    expect(Math.abs(a.mp.mass - b.mp.mass) / a.mp.mass).toBeGreaterThan(0.2);
    const expected = compose([rigid(a), rigid(b)]);
    dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'tug-b/side-port'), 500);
    const merged = rigid(a);
    expect(Math.abs(merged.mass - expected.mass) / expected.mass).toBeLessThan(1e-14);
    expect(v3.dist(merged.com, expected.com)).toBeLessThan(1e-8);
    expect(relative(merged.vcom, expected.vcom)).toBeLessThan(1e-13);
    expect(frob(merged.inertia.map((x, k) => x - expected.inertia[k]!) as M3) / frob(expected.inertia)).toBeLessThan(1e-11);
    expect(relative(apply3(merged.inertia, merged.omega), expected.L)).toBeLessThan(1e-11);
    expect(relative(merged.omega, expected.omega)).toBeLessThan(1e-10);
    // Large products of inertia in the base's frame: the inverse tensor is not a diagonal one in disguise.
    const i = a.mp.i;
    const offDiagonal = Math.max(Math.abs(i[3]!), Math.abs(i[4]!), Math.abs(i[5]!));
    expect(offDiagonal / Math.min(i[0]!, i[1]!, i[2]!)).toBeGreaterThan(0.05);
    // And the turn rate is not along a principal axis: omega and L are not parallel.
    const cosine = v3.dot(v3.normalize(merged.omega), v3.normalize(expected.L));
    expect(cosine).toBeLessThan(0.9999);
    console.log(`skew dock: axes ${between.toFixed(1)} deg apart, masses ${a.mp.mass.toFixed(0)} kg in all, products of inertia up to ${((100 * offDiagonal) / Math.min(i[0]!, i[1]!, i[2]!)).toFixed(0)} % of the smallest moment; omega against the composition ${relative(merged.omega, expected.omega).toExponential(1)}`);
  });

  it('an undock at the flank port really turns both pieces: each gains (port - its centre) x impulse, the totals are conserved', () => {
    const { a, b } = skewPair();
    dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'tug-b/side-port'), 500);
    const whole = rigid(a);
    const port = a.parts[a.links[0]!.a]!;
    const point = v3.add(a.r, quat.rotate(a.q, v3.add(port.pos, quat.rotate(port.rot, { x: 0, y: 0.4, z: 0 }))));
    const axis = quat.rotate(a.q, quat.rotate(port.rot, { x: 0, y: 1, z: 0 }));
    const before = total([a]);
    const created = undock(a, 0, 600, ctxAt(900));
    expect(created).toHaveLength(1);
    const pieces = [a, created[0]!];
    const after = total(pieces);
    expect(relative(after.linear, before.linear)).toBeLessThan(1e-12);
    expect(relative(after.angular, before.angular)).toBeLessThan(1e-9);
    const turns: number[] = [];
    const moments: number[] = [];
    for (const piece of pieces) {
      const now = rigid(piece);
      // What the piece was doing as part of the whole: the whole's turn rate, its own centre carried round.
      const vBefore = v3.add(whole.vcom, v3.cross(whole.omega, v3.sub(now.com, whole.com)));
      const J = v3.scale(v3.sub(now.vcom, vBefore), now.mass);
      // The impulse is the spring's: 600 N s along the port axis, one way or the other.
      expect(Math.abs(v3.len(J) - 600) / 600).toBeLessThan(1e-9);
      expect(Math.abs(v3.dot(v3.normalize(J), axis))).toBeGreaterThan(1 - 1e-12);
      // The turn it gained is the moment of that impulse about its own centre of mass.
      const gained = apply3(now.inertia, v3.sub(now.omega, whole.omega));
      const moment = v3.cross(v3.sub(point, now.com), J);
      moments.push(v3.len(moment));
      expect(relative(gained, moment)).toBeLessThan(1e-9);
      turns.push(v3.len(v3.sub(now.omega, whole.omega)) / DEG);
    }
    // Both really turn: the port is off both centres of mass, far off the tug's (its flank).
    expect(Math.max(...moments)).toBeGreaterThan(300);
    expect(Math.min(...moments)).toBeGreaterThan(10);
    for (const t of turns) expect(t).toBeGreaterThan(0.05);
    console.log(`skew undock: the pieces gain ${turns.map((t) => t.toFixed(2)).join(' and ')} deg/s`);
  });
});

describe('crew at a dock and an undock', () => {
  it('a live crew that docks to a craft whose crew is lost stays alive, keeps its own dose, and both are themselves again after undocking', () => {
    const { a, b } = pair({ x: 120, y: -40, z: 310 });
    const capsuleOf = (v: Vessel, key: string) => v.parts[partIndex(v, key)]!;
    // B's crew was lost to a dose of 21 g s before the dock; A's carries 4 g s of its own.
    const lost = capsuleOf(b, 'ferry-b/capsule');
    const command = lost.modules[lost.command!.module]!;
    if (command.type !== 'command') throw new Error('fixture');
    command.crewAlive = false;
    lost.command!.gDose = 21;
    b.crewAlive = false;
    b.gDose = 21;
    capsuleOf(a, 'ferry-a/capsule').command!.gDose = 4;
    a.gDose = 4;
    for (const base of [a, b]) {
      const x = cloneVessel(a);
      const y = cloneVessel(b);
      const [first, second] = base === a ? [x, y] : [y, x];
      const keys = base === a ? (['ferry-a/port', 'ferry-b/port'] as const) : (['ferry-b/port', 'ferry-a/port'] as const);
      dockMerge(first, second, partIndex(first, keys[0]), partIndex(second, keys[1]), 100);
      // The assembly has a live crew aboard, whichever of the two was the base.
      expect(first.crewAlive).toBe(true);
      expect(structureOf(first).crew).toBe(1);
      // The dose is each command part's own: nothing was shared, the vessel shows the live crew's.
      expect(capsuleOf(first, 'ferry-a/capsule').command!.gDose).toBe(4);
      expect(capsuleOf(first, 'ferry-b/capsule').command!.gDose).toBe(21);
      expect(first.gDose).toBe(4);
      const created = undock(first, 0, 0, ctxAt(300));
      const pieces = [first, ...created];
      const alive = pieces.find((v) => v.id === 'ferry-a')!;
      const dead = pieces.find((v) => v.id === 'ferry-b')!;
      expect(alive.crewAlive).toBe(true);
      expect(alive.gDose).toBe(4);
      expect(dead.crewAlive).toBe(false);
      expect(dead.gDose).toBe(21);
    }
  });
});
