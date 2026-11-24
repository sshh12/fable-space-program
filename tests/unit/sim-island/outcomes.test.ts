/**
 * Threshold outcomes as operations (ARCHITECTURE 6.4; lead decision of the fix round, finding 7). A
 * predicting replica never produces a threshold outcome: it holds the part at its limit. The authoritative
 * island journals each outcome as an operation (`destroy` and `split` for what leaves or parts, `outcome`
 * for what a member is afterwards), and a replica that applies the operations of a step after its own step
 * of that tick IS the authoritative island again, to the bit, at every tick. And the pose-only correction:
 * one member's position, velocity, attitude and rates at a tick, inside stated bounds.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Prng } from '@/core/math/hash';
import { v3 } from '@/core/math/vec3';
import { decodeIsland, IslandOpError, POSE_CORRECTION_MAX_DISTANCE, type AppliedOp, type Island } from '@/sim/island';
import { controls, input, islandAt, loadLibrary, orbiter, PILOT, setup, type Setup } from './helpers';

const EARTH_MU = 3.986004418e14;

describe('threshold outcomes and pose corrections as operations', () => {
  let s: Setup;
  beforeAll(async () => {
    s = setup(await loadLibrary());
  });

  /** An operation the replica made itself in its own step (a command's split): the server's copy of it is not applied twice. */
  const sameOp = (a: AppliedOp, b: AppliedOp): boolean => a.body.op === b.body.op && a.body.op !== 'outcome' && JSON.stringify(a.body) === JSON.stringify(b.body);

  it('a replica that applies the server\'s operations after each of its own steps has the server\'s hash at every tick, through heat, loads, canopies, touchdowns and sleep', () => {
    let withOutcome = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      // The capsule thrown at the atmosphere too steep and too fast, its chutes commanded out at seeded ticks (the
      // scenario of the predict-mode test in island.test.ts).
      const rng = new Prng(seed);
      const server = islandAt(s, 'earth', 'authoritative');
      server.recordOps = true;
      server.add(orbiter(s.defs, 'alpha', 7, EARTH_MU, 6_371_000 + 35_000 + 25_000 * rng.next(), v3.zero(), { x: -2500 - 3500 * rng.next(), y: -4000 * rng.next(), z: 0 }), { pilot: PILOT, attended: true });
      const first = 5 + Math.floor(60 * rng.next());
      const second = first + 5 + Math.floor(60 * rng.next());
      const pitch = controls({ pitch: 2 * rng.next() - 1 });
      const replica: Island = decodeIsland(s.deps, server.encode(), { mode: 'predict' });
      replica.recordOps = true;
      for (const i of [server, replica]) i.applyInput(input(i.tick, { kind: 'controls', vesselId: 'alpha', controls: pitch, sasHold: null }));
      let outcomes = 0;
      for (let k = 0; k < 900 && server.members.length > 0; k++) {
        if (k === first || k === second) for (const i of [server, replica]) i.applyInput({ ...input(i.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }), seq: k });
        const fromServer = server.step();
        const own = replica.step();
        for (const op of fromServer.ops) {
          if (own.ops.some((x) => sameOp(x, op))) continue;
          replica.applyOp(op.body);
          if (op.body.op === 'outcome') {
            outcomes++;
            for (const o of op.body.outcomes) kinds.add(o);
          }
        }
        if (replica.hash() !== server.hash()) throw new Error(`seed ${seed}, tick +${k}: the replica is not the server after its operations [${fromServer.ops.map((o) => o.body.op).join(', ')}]`);
      }
      expect(replica.members.length, `seed ${seed}`).toBe(server.members.length);
      if (outcomes > 0) withOutcome++;
    }
    // Outcomes in (nearly) every run, of several kinds.
    expect(withOutcome).toBeGreaterThan(30);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it('a pose-only correction sets one member\'s position, velocity, attitude and rates; beyond its bounds it is refused', () => {
    const leo = 6_371_000 + 300_000;
    const server = islandAt(s, 'earth');
    server.add(orbiter(s.defs, 'alpha', 7, EARTH_MU, leo), { pilot: PILOT, attended: true });
    server.add(orbiter(s.defs, 'bravo', 7, EARTH_MU, leo, { x: 0, y: 60, z: 0 }));
    // alpha is pushing with its thrusters: an integrated member (one on a conic has its position from the conic).
    server.applyInput(input(server.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'rcs', on: true } }));
    server.applyInput(input(server.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ pitch: 0.3, translate: { x: 0, y: 1, z: 0 } }), sasHold: null }));
    for (let k = 0; k < 240; k++) server.step();
    expect(server.member('alpha')!.mode).toBe('integrated');
    const replica = decodeIsland(s.deps, server.encode(), { mode: 'predict' });
    // The replica has drifted: 3 m and 2 cm/s off, turned a little.
    const m = replica.member('alpha')!.vessel;
    const drifted = { op: 'pose' as const, slot: replica.member('alpha')!.slot, r: v3.add(m.r, { x: 3, y: 0, z: 0 }), v: v3.add(m.v, { x: 0, y: 0.02, z: 0 }), q: { ...m.q }, w: v3.add(m.w, { x: 0.01, y: 0, z: 0 }) };
    replica.applyOp(drifted);
    expect(replica.hash()).not.toBe(server.hash());
    // The server's pose of that member at this tick puts it right, to the bit.
    const truth = server.member('alpha')!.vessel;
    const checksum = replica.applyOp({ op: 'pose', slot: server.member('alpha')!.slot, r: { ...truth.r }, v: { ...truth.v }, q: { ...truth.q }, w: { ...truth.w } });
    expect(checksum).toEqual(server.checksumOf('alpha'));
    expect(replica.hash()).toBe(server.hash());
    for (let k = 0; k < 120; k++) {
      server.step();
      replica.step();
    }
    expect(replica.hash()).toBe(server.hash());
    // Farther than the bound is no correction: the whole vessel is sent then (`replace`).
    const far = { op: 'pose' as const, slot: 0, r: v3.add(server.member('alpha')!.vessel.r, { x: POSE_CORRECTION_MAX_DISTANCE + 1, y: 0, z: 0 }), v: { ...truth.v }, q: { ...truth.q }, w: { ...truth.w } };
    expect(() => replica.applyOp(far)).toThrow(IslandOpError);
    expect(() => replica.applyOp({ ...far, r: { x: Number.NaN, y: 0, z: 0 } })).toThrow(IslandOpError);
  });
});
