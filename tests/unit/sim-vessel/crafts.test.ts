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
import { dockingLibrary, ferry, hub, mate, partIndex, partPoses } from './dockingFixtures';
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
    expect(() => mergeVessels(a, b)).toThrow(/welds pieces of one craft/);
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
    expect(spawned[0]!.crafts.map((c) => c.craftId)).toEqual(['ferry-b']);
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

  it('a part is found by its key, and a bare instance id only when it is unambiguous', () => {
    const v = docked();
    expect(v.parts[findPartByKey(v, 'ferry-b/capsule')]!.craft).toBe(1);
    expect(findPartByKey(v, 'capsule')).toBe(-1);
    expect(findPartByKey(v, 'ferry-c/capsule')).toBe(-1);
    const single = ferry(lib, 'ferry-x');
    expect(findPartByKey(single, 'capsule')).toBe(0);
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

  it('pieces of one craft: the piece with the root part is the craft, the others carry the id of their first part', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c7', ownerId: 'acct' } });
    expect(v.id).toBe('c7');
    const env = makeEnv({ atmosphere: earthAir });
    placeUpright(v, env, 120);
    const spawned = [...fireNextStage(v, env).spawned];
    for (let i = 0; i < 480; i++) spawned.push(...stepVessel(v, env, controls({ throttle: 1 }), DT).spawned);
    expect(v.id).toBe('c7');
    expect(spawned.map((s) => s.id)).toEqual(['c7~clamp-1']);
    expect(spawned[0]!.crafts[0]).toMatchObject({ craftId: 'c7', ownerId: 'acct' });
    expect(spawned[0]!.crafts[0]).not.toBe(v.crafts[0]);
  });
});

describe('pre-mated ports and the command part', () => {
  it('two ports mated in the vehicle file are a dock link; the stage action undock releases it', () => {
    const v = assembleVessel(lib, 'test-tandem', { craft: { craftId: 't1' } });
    expect(v.crafts).toHaveLength(1);
    expect(v.links).toHaveLength(1);
    expect([partKeyOf(v, v.links[0]!.a), partKeyOf(v, v.links[0]!.b)]).toEqual(['t1/port', 't1/tug-port']);
    // The tug is its own tree: its port is a root, the faces coincide.
    expect(v.parts.filter((p) => p.parent < 0).map((p) => p.instanceId)).toEqual(['capsule', 'tug-port']);
    const face = (i: number) => v3.add(v.parts[i]!.pos, quat.rotate(v.parts[i]!.rot, { x: 0, y: 0.4, z: 0 }));
    expect(v3.dist(face(v.links[0]!.a), face(v.links[0]!.b))).toBeLessThan(1e-12);
    const env = makeEnv({});
    v.r = { x: 0, y: 6771000, z: 0 };
    v.v = { x: 7670, y: 0, z: 0 };
    expect(fireNextStage(v, env).ok).toBe(true);
    for (let i = 0; i < 80; i++) stepVessel(v, env, controls(), DT);
    const before = momentumOf(v);
    const res = fireNextStage(v, env);
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual(['stageFired', 'engineShutdown', 'undocked'].filter((t) => res.events.some((e) => e.type === t)));
    expect(res.events.some((e) => e.type === 'undocked')).toBe(true);
    expect(res.spawned).toHaveLength(1);
    expect(v.id).toBe('t1');
    expect(res.spawned[0]!.id).toBe('t1~tug-port');
    expect(v.links).toHaveLength(0);
    expect(v.parts.map((p) => p.instanceId)).toEqual(['capsule', 'port']);
    expect(relative(total([v, res.spawned[0]!]).linear, before.linear)).toBeLessThan(1e-12);
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
