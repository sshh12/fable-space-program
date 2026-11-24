/**
 * The island as a host uses it (docs/ARCHITECTURE.md 7.1-7.4; src/sim/island/api.ts): the codec with a
 * checkpoint at a staging tick, a U5 pair and an occupied capture slot; the replay of an input list; the
 * pair regime forced through the hook; operations as data; the order of a merge; the two step modes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '@/core/math/vec3';
import { decodeIsland, islandHash, IslandOpError, type Island, type IslandInput, type IslandOp, type PairHook } from '@/sim/island';
import { encodeVessel, stateHash } from '@/sim/vessel';
import { blob, controls, input, islandAt, loadLibrary, orbiter, PILOT, relative, setup, steps, THRESHOLD_EVENTS, TICK0, type Setup } from './helpers';

const EARTH_MU = 3.986004418e14;
const LEO = 6_771_000;

describe('the island', () => {
  let s: Setup;
  beforeAll(async () => {
    s = setup(await loadLibrary());
  });

  /** The parking-orbit stack (third stage, lander, capsule) with a pilot, and a second craft 20 m off. */
  function pairInOrbit(mode: 'authoritative' | 'predict' = 'authoritative'): Island {
    const island = islandAt(s, 'earth', mode);
    island.add(orbiter(s.defs, 'alpha', 4, EARTH_MU, LEO), { pilot: PILOT, attended: true });
    island.add(orbiter(s.defs, 'bravo', 7, EARTH_MU, LEO, { x: 0, y: 20, z: 0 }));
    return island;
  }

  describe('codec', () => {
    /** Fly `island` and a copy restored from its bytes side by side for `n` steps; the hashes agree at every check. */
    function continueBoth(island: Island, n: number, drive: (i: Island, k: number) => void = () => undefined): void {
      const bytes = island.encode();
      const copy = decodeIsland(s.deps, bytes);
      expect(copy.hash()).toBe(island.hash());
      expect(islandHash(bytes)).toBe(island.hash());
      for (let k = 0; k < n; k++) {
        drive(island, k);
        drive(copy, k);
        island.step();
        copy.step();
        if (k % 500 === 499 && copy.hash() !== island.hash()) throw new Error(`the restored island differs after ${k + 1} steps`);
      }
      expect(copy.tick).toBe(island.tick);
      expect(copy.members.map((m) => m.vessel.id)).toEqual(island.members.map((m) => m.vessel.id));
      expect(copy.hash()).toBe(island.hash());
    }

    it('a checkpoint at a staging tick restores the stage and its booster still ignoring each other; 6,000 steps on, the hash is the uninterrupted run\'s', () => {
      const island = pairInOrbit();
      island.applyInput(input(island.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ throttle: 1 }), sasHold: null }));
      steps(island, 240);
      const before = island.members.length;
      const receipt = island.applyInput(input(island.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }));
      expect(receipt.outcome?.ok).toBe(true);
      // The separation follows the engine's shutdown: the staging tick is the one at which the booster is a vessel of its own.
      for (let k = 0; k < 1200 && island.members.length === before; k++) island.step();
      expect(island.members.length).toBeGreaterThan(before);
      // The pieces of the split are nascent pairs at the staging tick.
      expect(island.nascentPairs.length).toBeGreaterThan(0);
      const restored = decodeIsland(s.deps, island.encode());
      expect(restored.nascentPairs).toEqual(island.nascentPairs);
      continueBoth(island, 6000);
    }, 120_000);

    it('with a U5 pair, with an occupied capture slot and with queued inputs: bit-identical for 6,000 steps', () => {
      const island = pairInOrbit();
      island.setClearing({ a: 'alpha', b: 'bravo', sinceTick: island.tick - 7 }, true);
      island.setCapture({ a: 'bravo', b: 'alpha', aPort: 3, bPort: 5, state: new Uint8Array([1, 2, 3, 250]), clampTicks: 4, ageTicks: 77, dwellTicks: 0 }, true);
      // Inputs stamped ahead wait in the queue, which is state.
      island.applyInput(input(island.tick + 900, { kind: 'controls', vesselId: 'alpha', controls: controls({ throttle: 0.5, pitch: 0.25 }), sasHold: null }));
      island.applyInput(input(island.tick + 1500, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }));
      island.applyInput(input(island.tick + 2400, { kind: 'timer', vesselId: 'alpha', timer: 'latchEnd' }));
      const copy = decodeIsland(s.deps, island.encode());
      expect(copy.clearingPairs).toEqual([{ a: 'alpha', b: 'bravo', sinceTick: island.tick - 7 }]);
      expect(copy.captures).toEqual([{ a: 'alpha', b: 'bravo', aPort: 5, bPort: 3, state: new Uint8Array([1, 2, 3, 250]), clampTicks: 4, ageTicks: 77, dwellTicks: 0 }]);
      continueBoth(island, 6000);
      expect(island.members.length).toBeGreaterThan(2);
    }, 120_000);

    it('names are carried and not hashed; a foreign blob is refused by name', () => {
      const island = pairInOrbit();
      const hash = island.hash();
      island.member('alpha')!.vessel.name = 'Another name';
      island.member('alpha')!.vessel.crafts[0]!.name = 'Renamed craft';
      expect(island.hash()).toBe(hash);
      const copy = decodeIsland(s.deps, island.encode());
      expect(copy.member('alpha')!.vessel.name).toBe('Another name');
      expect(copy.member('alpha')!.vessel.crafts[0]!.name).toBe('Renamed craft');
      expect(decodeIsland(s.deps, island.encode({ names: false })).hash()).toBe(hash);
      expect(() => decodeIsland(s.deps, new Uint8Array([1, 2, 3, 4, 5]))).toThrow(IslandOpError);
      const bytes = island.encode();
      expect(() => decodeIsland(s.deps, bytes.subarray(0, bytes.length - 40))).toThrow(IslandOpError);
    });
  });

  it('a replay of the recorded input list (controls, commands, an admission, a remove, timer-derived inputs) reproduces the hash', () => {
    const start = pairInOrbit().encode();
    const charlie = encodeVessel(orbiter(s.defs, 'charlie', 7, EARTH_MU, LEO, { x: 0, y: -400, z: 30 }), { defsHash: 'test' });
    const list: IslandInput[] = [
      input(TICK0, { kind: 'controls', vesselId: 'alpha', controls: controls({ throttle: 1, yaw: 0.1 }), sasHold: null }),
      input(TICK0 + 40, { kind: 'command', vesselId: 'alpha', command: { kind: 'sas', on: true } }),
      input(TICK0 + 120, { kind: 'add', vessel: charlie, bornTick: TICK0 + 120, admittedFromHead: TICK0 - 50_000 }, 'directory'),
      input(TICK0 + 121, { kind: 'reservation', vesselId: 'charlie', state: 'granted' }, 'directory'),
      input(TICK0 + 300, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }),
      input(TICK0 + 600, { kind: 'timer', vesselId: 'alpha', timer: 'socketLost' }),
      input(TICK0 + 630, { kind: 'timer', vesselId: 'alpha', timer: 'deadManRotation' }),
      input(TICK0 + 840, { kind: 'timer', vesselId: 'alpha', timer: 'deadManThrottle' }),
      input(TICK0 + 1000, { kind: 'remove', vesselId: 'bravo', reason: 'left' }, 'directory'),
      input(TICK0 + 1200, { kind: 'rate', rate: 2 }, 'directory'),
    ];
    const fly = (feed: 'ahead' | 'at tick'): Island => {
      const island = decodeIsland(s.deps, start);
      if (feed === 'ahead') for (const i of list) island.applyInput(i);
      for (let k = 0; k < 2400; k++) {
        if (feed === 'at tick') for (const i of list) if (i.tick === island.tick) island.applyInput(i);
        island.step();
      }
      return island;
    };
    const a = fly('ahead');
    const b = fly('at tick');
    expect(a.member('charlie')!.admittedFromHead).toBe(TICK0 - 50_000);
    expect(a.member('bravo')).toBeNull();
    expect(a.seatOf(PILOT)!.controls.throttle).toBe(0);
    expect(a.seatOf(PILOT)!.latchOpenTick).toBe(TICK0 + 600);
    expect(a.rate).toBe(2);
    expect(a.members.length).toBeGreaterThan(2);
    expect(b.hash()).toBe(a.hash());
    // And from a checkpoint in the middle of the list.
    const mid = decodeIsland(s.deps, start);
    for (const i of list) mid.applyInput(i);
    steps(mid, 500);
    const resumed = decodeIsland(s.deps, mid.encode());
    steps(resumed, 1900);
    expect(resumed.hash()).toBe(a.hash());
  }, 120_000);

  describe('the pair regime', () => {
    it('two craft 20 m apart in low orbit cross the boundary in both directions: both switch at the same tick and gain under 0.1 mm/s', () => {
      const N = 1200;
      const inContact = (tick: number): boolean => {
        const k = tick - TICK0;
        return (k >= 100 && k < 260) || (k >= 500 && k < 505) || (k >= 800 && k < 1100);
      };
      const run = (forced: boolean): { island: Island; switches: number[] } => {
        const island = islandAt(s, 'earth');
        island.add(orbiter(s.defs, 'alpha', 7, EARTH_MU, LEO));
        island.add(orbiter(s.defs, 'bravo', 7, EARTH_MU, LEO, { x: 0, y: 20, z: 0 }));
        const solved: number[] = [];
        const hook: PairHook = { regime: (_a, _b, tick) => (inContact(tick) ? 'contact' : 'free'), solve: (_a, _b, runA, runB, tick, sub) => void (runA && runB && sub === 0 && solved.push(tick)) };
        if (forced) island.setPairHook(hook);
        const switches: number[] = [];
        let last = 0;
        for (let k = 0; k < N; k++) {
          island.step();
          const now = island.counters.pairSubsteps;
          // Both vessels take the sub-stepped path in a tick of the regime, and neither outside it.
          expect(now - last, `tick ${island.tick - 1}`).toBe(forced && inContact(island.tick - 1) ? 2 : 0);
          if ((now - last > 0) !== (switches.length % 2 === 1)) switches.push(island.tick - 1);
          last = now;
        }
        if (forced) expect(solved.length).toBe(160 + 5 + 300);
        return { island, switches };
      };
      const free = run(false);
      const forced = run(true);
      expect(forced.switches).toEqual([TICK0 + 100, TICK0 + 260, TICK0 + 500, TICK0 + 505, TICK0 + 800, TICK0 + 1100]);
      expect(free.island.counters.pairSubsteps).toBe(0);
      expect(forced.island.counters.probeSubsteps).toBe(0);
      const a = relative(free.island, 'alpha', 'bravo');
      const b = relative(forced.island, 'alpha', 'bravo');
      const gained = v3.dist(a.v, b.v);
      expect(gained).toBeLessThan(1e-4);
      expect(v3.dist(a.r, b.r)).toBeLessThan(1e-3);
    }, 120_000);
  });

  describe('operations as data', () => {
    it('a split recorded by the authoritative step, applied to a copy of the state before it, gives the same vessels and the same checksum', () => {
      const island = pairInOrbit();
      (island as unknown as { recordOps: boolean }).recordOps = true;
      steps(island, 30);
      const before = island.encode();
      const receipt = island.applyInput(input(island.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }));
      const split = receipt.report!.ops.find((o) => o.body.op === 'split');
      // A staging action that fires at once is in the receipt; one that is delayed is reported by the step that runs it.
      const ops = split ? [split] : [];
      for (let k = 0; k < 600 && ops.length === 0; k++) for (const o of island.step().ops) if (o.body.op === 'split') ops.push(o);
      expect(ops.length).toBe(1);
      const op = ops[0]!;
      expect(op.checksum).not.toBeNull();
      const replica = decodeIsland(s.deps, before);
      while (replica.tick < op.tick) replica.step();
      const slotBefore = replica.members.findIndex((m) => m.vessel.id === 'alpha');
      expect((op.body as Extract<IslandOp, { op: 'split' }>).slot).toBe(slotBefore);
      const checksum = replica.applyOp(op.body);
      expect(checksum).toEqual(op.checksum);
      expect(replica.checksumOf('alpha')).toEqual(island.checksumOf('alpha'));
      for (const id of (op.body as Extract<IslandOp, { op: 'split' }>).newVesselIds) expect(replica.member(id), id).not.toBeNull();
    }, 60_000);

    it('an operation that does not fit the state is refused by name', () => {
      const island = pairInOrbit();
      expect(() => island.applyOp({ op: 'split', slot: 9, cutJoints: [1], newVesselIds: [] })).toThrow(/no member at slot 9/);
      expect(() => island.applyOp({ op: 'split', slot: 0, cutJoints: [0], newVesselIds: [] })).toThrow(/root/);
      expect(() => island.applyOp({ op: 'split', slot: 0, cutJoints: [3], newVesselIds: ['not-this'] })).toThrow(/states \[not-this\]/);
    });

    it('add, replace and remove carry a vessel as a blob; the member takes the blob\'s whole state', () => {
      const island = pairInOrbit();
      const other = orbiter(s.defs, 'bravo', 7, EARTH_MU, LEO, { x: 5, y: 60, z: -5 }, { x: 0.25, y: 0, z: 0 });
      island.applyOp({ op: 'replace', slot: island.member('bravo')!.slot, vessel: blob(encodeVessel(other, { defsHash: 'x' })) });
      expect(stateHash(island.member('bravo')!.vessel)).toBe(stateHash(other));
      const charlie = orbiter(s.defs, 'charlie', 7, EARTH_MU, LEO, { x: 0, y: -90, z: 0 });
      island.applyOp({ op: 'add', vesselId: 'charlie', vessel: blob(encodeVessel(charlie, { defsHash: 'x' })) });
      expect(island.members.map((m) => m.vessel.id)).toEqual(['alpha', 'bravo', 'charlie']);
      expect(island.applyOp({ op: 'remove', slot: 1, reason: 'left' })).toBeNull();
      expect(island.members.map((m) => m.vessel.id)).toEqual(['alpha', 'charlie']);
    });
  });

  it('a merge of two islands is independent of the order in which the vessels arrive', () => {
    const ids = ['delta', 'alpha', 'echo', 'charlie', 'bravo'];
    const make = (order: readonly string[]): Island => {
      const island = islandAt(s, 'earth');
      for (const id of order) island.add(orbiter(s.defs, id, 7, EARTH_MU, LEO, { x: ids.indexOf(id) * 3, y: ids.indexOf(id) * 250, z: 0 }), id === 'charlie' ? { pilot: PILOT, attended: true } : {});
      island.refreshMargins();
      return island;
    };
    const a = make(ids);
    const b = make(['bravo', 'charlie', 'alpha', 'echo', 'delta']);
    expect(a.members.map((m) => m.vessel.id)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    expect(a.anchorId).toBe('charlie');
    expect(b.hash()).toBe(a.hash());
    steps(a, 600);
    steps(b, 600);
    expect(b.hash()).toBe(a.hash());
    // An unattended island's anchor is its lowest id.
    a.applyInput(input(a.tick, { kind: 'seat', vesselId: 'charlie', aboard: false }));
    expect(a.anchorId).toBe('alpha');
  }, 60_000);

  describe('the two step modes', () => {
    it('a pending merge tick is never passed', () => {
      const island = pairInOrbit();
      island.applyInput(input(island.tick, { kind: 'mergeAt', mergeTick: island.tick + 10 }, 'directory'));
      steps(island, 10);
      expect(() => island.step()).toThrow(/merge tick/);
      island.applyInput(input(island.tick, { kind: 'mergeAt', mergeTick: null }, 'directory'));
      island.step();
      expect(island.tick).toBe(TICK0 + 11);
    });

    it('predict mode produces no threshold outcome where the authoritative mode does, on the same inputs', () => {
      // The capsule stack thrown at the atmosphere far too steep and fast, chutes out: heat, loads and canopies all pass their limits.
      const fly = (mode: 'authoritative' | 'predict'): { events: Set<string>; parts: number; alive: boolean } => {
        const island = islandAt(s, 'earth', mode);
        const v = orbiter(s.defs, 'alpha', 7, EARTH_MU, 6_371_000 + 60_000, v3.zero(), { x: -3000, y: 0, z: 0 });
        island.add(v, { pilot: PILOT, attended: true });
        const seen = new Set<string>();
        for (let k = 0; k < 4000 && island.members.length > 0; k++) {
          if (k === 20 || k === 40) island.applyInput(input(island.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }));
          for (const e of island.step().events) if (THRESHOLD_EVENTS.includes(e.type)) seen.add(e.type);
        }
        const m = island.member('alpha');
        return { events: seen, parts: m ? m.vessel.parts.length : 0, alive: m ? m.vessel.crewAlive : false };
      };
      const authoritative = fly('authoritative');
      const predict = fly('predict');
      expect(authoritative.events.size).toBeGreaterThan(0);
      expect([...predict.events]).toEqual([]);
      expect(predict.alive).toBe(true);
      expect(predict.parts).toBeGreaterThan(0);
    }, 120_000);
  });
});
