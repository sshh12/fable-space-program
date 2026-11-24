/**
 * Inputs and seats of an island (ARCHITECTURE 6.1 "same-tick ordering is canonical", 6.2, 7.2, 7.5; fix
 * round, findings 2, 3, 5, 11):
 *  - an input queued for a later tick is applied AT that tick, whether the host steps or coasts on rails;
 *  - inputs of one tick are applied in the order (tick, account, sequence), not in the order they arrived,
 *    and the hash does not depend on the order they were queued in;
 *  - several accounts may sit in one vessel; the helm's seat alone steers it and sets the SAS hold, and an
 *    island restored at any tick goes on as the one it was taken from.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '@/core/math/vec3';
import { comStateOf, decodeIsland, type Island } from '@/sim/island';
import { controls, input, islandAt, loadLibrary, orbiter, PILOT, setup, TICK0, type Setup } from './helpers';

describe('inputs and seats', () => {
  let s: Setup;
  let mu: number;
  let leo: number;
  beforeAll(async () => {
    s = setup(await loadLibrary());
    mu = s.system.body('earth').mu;
    leo = s.system.body('earth').radius + 300_000;
  });

  function coasting(): Island {
    const island = islandAt(s, 'earth');
    island.add(orbiter(s.defs, 'alpha', 7, mu, leo), { pilot: PILOT, attended: true });
    island.settle('alpha');
    return island;
  }

  it('an input queued for a later tick is applied at that tick: a rails advance lands there, and the flight is the stepped one', () => {
    const fly = (rails: boolean): { island: Island; applied: number[]; landings: number[] } => {
      const island = coasting();
      // A thruster burn planned ahead: thrusters on at +50, a push from +100 to +200.
      const receipts = [
        island.applyInput(input(TICK0 + 50, { kind: 'command', vesselId: 'alpha', command: { kind: 'rcs', on: true } })),
        island.applyInput(input(TICK0 + 100, { kind: 'controls', vesselId: 'alpha', controls: controls({ translate: { x: 0, y: 1, z: 0 } }), sasHold: null })),
        island.applyInput(input(TICK0 + 200, { kind: 'controls', vesselId: 'alpha', controls: controls(), sasHold: null })),
      ];
      expect(receipts.map((r) => r.appliedTick)).toEqual([TICK0 + 50, TICK0 + 100, TICK0 + 200]);
      const applied: number[] = [];
      const landings: number[] = [];
      while (island.tick < TICK0 + 6000) {
        const before = island.tick;
        let report = rails && !island.mustIntegrate() ? island.advanceTo(TICK0 + 6000) : null;
        if (island.tick === before) report = island.step();
        else landings.push(island.tick - TICK0);
        for (const c of report!.commands) applied.push(c.tick - TICK0);
      }
      return { island, applied, landings };
    };
    const stepped = fly(false);
    const coasted = fly(true);
    // The command's outcome carries the tick it was stamped for, either way.
    expect(stepped.applied).toEqual([50]);
    expect(coasted.applied).toEqual([50]);
    // The coast stops at each queued input (and goes on after the burn).
    expect(coasted.landings.slice(0, 2)).toEqual([50, 100]);
    expect(coasted.island.counters.railsAdvances).toBeGreaterThan(2);
    // Centres of mass: a rails advance stops a slow residual turn (the thrusters left 0.03 deg/s), which moves the
    // vessel's origin about its centre of mass by centimetres and changes nothing of the flight.
    const a = comStateOf(stepped.island.member('alpha')!.vessel);
    const b = comStateOf(coasted.island.member('alpha')!.vessel);
    // The burn changed the orbit (centimetres per second, metres of position by the end); both flights have the same one.
    const unburned = coasting();
    for (let k = 0; k < 6000; k++) unburned.step();
    const c = comStateOf(unburned.member('alpha')!.vessel);
    expect(v3.dist(a.v, c.v)).toBeGreaterThan(0.01);
    expect(v3.dist(a.r, c.r)).toBeGreaterThan(1);
    expect(v3.dist(a.r, b.r)).toBeLessThan(1e-3);
    expect(v3.dist(a.v, b.v)).toBeLessThan(1e-5);
  });

  it('inputs of one tick are applied by (account, sequence), whichever arrived first, and the queue is hashed in that order', () => {
    const at = TICK0 + 10;
    const leave = { ...input(at, { kind: 'seat', vesselId: 'alpha', aboard: false }), seq: 0 };
    const lights = { ...input(at, { kind: 'command', vesselId: 'alpha', command: { kind: 'lights' } }), seq: 1 };
    // Both queued ahead, in either order: the same state, hashed the same before they are applied.
    const x = coasting();
    const y = coasting();
    x.applyInput(leave);
    x.applyInput(lights);
    y.applyInput(lights);
    y.applyInput(leave);
    expect(y.hash()).toBe(x.hash());
    // The second one arrives at its tick, when the first is still queued for it: applied after it all the same.
    const z = coasting();
    z.applyInput(leave);
    for (let k = 0; k < 10; k++) z.step();
    expect(z.tick).toBe(at);
    const receipt = z.applyInput(lights);
    // The pilot had left by then (sequence 0): the command of sequence 1 finds nobody at the helm.
    expect(receipt.accepted).toBe(false);
    expect(z.member('alpha')!.vessel.lightsOn).toBe(false);
    expect(z.seatOf(PILOT)).toBeNull();
    for (const i of [x, y]) for (let k = 0; k < 10; k++) i.step();
    for (const i of [x, y, z]) for (let k = 0; k < 20; k++) i.step();
    expect(x.member('alpha')!.vessel.lightsOn).toBe(false);
    expect(y.hash()).toBe(x.hash());
    expect(z.hash()).toBe(x.hash());
  });

  for (const accounts of [
    ['bravo', 'charlie', 'alfa'],
    ['mike', 'kilo'],
  ]) {
    it(`${accounts.length} accounts seated in one vessel: the first is the helm and alone steers; an island restored at any tick goes on the same`, () => {
      const island = islandAt(s, 'earth');
      island.add(orbiter(s.defs, 'alpha', 7, mu, leo));
      const helm = accounts[0]!;
      // Seated in an order that is not the order of their ids.
      for (const account of accounts) expect(island.applyInput(input(TICK0, { kind: 'seat', vesselId: 'alpha', aboard: true }, account)).accepted).toBe(true);
      expect(island.member('alpha')!.pilot).toBe(helm);
      for (const account of accounts) expect(island.seatOf(account)?.vesselId).toBe('alpha');
      // The helm holds orbital prograde; a passenger's inputs are refused and change nothing.
      expect(island.applyInput(input(TICK0, { kind: 'reference', vesselId: 'alpha', reference: 'orbit' }, helm)).accepted).toBe(true);
      expect(island.applyInput(input(TICK0, { kind: 'command', vesselId: 'alpha', command: { kind: 'sas', on: true } }, helm)).outcome?.ok).toBe(true);
      expect(island.applyInput(input(TICK0, { kind: 'command', vesselId: 'alpha', command: { kind: 'sasMode', mode: 'prograde' } }, helm)).outcome?.ok).toBe(true);
      for (const passenger of accounts.slice(1)) {
        expect(island.applyInput(input(TICK0, { kind: 'controls', vesselId: 'alpha', controls: controls({ pitch: 1 }), sasHold: null }, passenger))).toMatchObject({ accepted: false, reason: 'Not at the helm' });
        expect(island.applyInput(input(TICK0, { kind: 'reference', vesselId: 'alpha', reference: 'surface' }, passenger)).accepted).toBe(false);
        expect(island.applyInput(input(TICK0, { kind: 'command', vesselId: 'alpha', command: { kind: 'sasMode', mode: 'retrograde' } }, passenger)).accepted).toBe(false);
      }
      let restored = decodeIsland(s.deps, island.encode());
      for (let k = 0; k < 240; k++) {
        island.step();
        restored.step();
        expect(restored.hash(), `tick ${island.tick}`).toBe(island.hash());
        // The hold is the helm's: prograde of the velocity about the body, not of the velocity over the ground.
        const m = island.member('alpha')!.vessel;
        expect(v3.angle(m.sas.holdDir!, island.stateOf('alpha')!.v)).toBeLessThan(1e-3);
        restored = decodeIsland(s.deps, island.encode());
      }
      // The helm leaves: the seat is vacant until it is granted, the passengers are still aboard and the vessel is attended.
      island.applyInput(input(island.tick, { kind: 'seat', vesselId: 'alpha', aboard: false }, helm));
      expect(island.member('alpha')!.pilot).toBeNull();
      expect(island.member('alpha')!.attended).toBe(true);
      expect(island.seatOf(accounts[1]!)?.vesselId).toBe('alpha');
      const next = accounts[1]!;
      island.applyInput(input(island.tick, { kind: 'helm', vesselId: 'alpha', pilot: next, craftId: null, controlPartKey: null }, next));
      expect(island.member('alpha')!.pilot).toBe(next);
      expect(island.applyInput(input(island.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ pitch: 1 }), sasHold: null }, next)).accepted).toBe(true);
    });
  }
});
