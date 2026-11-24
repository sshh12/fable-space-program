/**
 * The island in the star's sphere of influence (ARCHITECTURE section 4): it integrates offsets from its
 * reference orbit (Encke's method with Battin's f(q)), on the staged Sun-rooted library. Heliocentric
 * float64 positions resolve a millimetre at 30 AU; the offsets do not lose that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '@/core/math/vec3';
import { checksumsAgree, comStateOf, decodeIsland, REFERENCE_OFFSET_MAX, REFERENCE_SETTLE_SPEED, type AdvanceReport, type Island, type PairHook } from '@/sim/island';
import { controls, input, islandAt, loadLibraryOver, orbiter, PILOT, relative, setup, TICK0, type Setup } from './helpers';

const AU = 1.495978707e11;

describe('an island at 30 AU', () => {
  let s: Setup;
  let mu: number;
  let star: string;
  beforeAll(async () => {
    s = setup(await loadLibraryOver());
    star = s.system.starId;
    mu = s.system.body(star).mu;
  });

  function pair(separation: number): Island {
    const island = islandAt(s, star);
    island.add(orbiter(s.defs, 'alpha', 7, mu, 30 * AU), { pilot: PILOT, attended: true });
    island.add(orbiter(s.defs, 'bravo', 7, mu, 30 * AU, { x: 0, y: separation, z: 0 }));
    island.refreshMargins();
    // The reference orbit is made for the member set at the first step, advance or encoding: here.
    island.hash();
    return island;
  }

  it('the root star is the frame body and the island has a reference orbit at its anchor', () => {
    expect(s.system.rootId).toBe(star);
    const island = pair(100);
    expect(island.reference).not.toBeNull();
    expect(island.anchorId).toBe('alpha');
    // The members' own states are offsets: metres, not astronomical units.
    expect(v3.len(island.member('bravo')!.vessel.r)).toBeLessThan(200);
    expect(v3.len(island.stateOf('bravo')!.r)).toBeGreaterThan(29 * AU);
  });

  it('two vessels 100 m apart keep their relative velocity to under 1 mm/s for ten minutes', () => {
    const island = pair(100);
    const v0 = relative(island, 'alpha', 'bravo').v;
    let worst = 0;
    for (let k = 0; k < 72_000; k++) {
      island.step();
      if (k % 120 === 119) worst = Math.max(worst, v3.dist(relative(island, 'alpha', 'bravo').v, v0));
    }
    // Inside the armed margin both are integrated, in the frame of the reference orbit.
    expect(island.member('bravo')!.mode).toBe('integrated');
    expect(island.counters.freeSteps).toBeGreaterThan(100_000);
    expect(worst).toBeLessThan(1e-3);
    expect(Math.abs(v3.len(relative(island, 'alpha', 'bravo').r) - 100)).toBeLessThan(0.5);
  }, 120_000);

  it('two craft 20 m apart cross the pair-regime boundary in both directions: the same tick for both, under 0.1 mm/s gained', () => {
    const inContact = (tick: number): boolean => {
      const k = tick - TICK0;
      return (k >= 100 && k < 260) || (k >= 800 && k < 1100);
    };
    const run = (forced: boolean): Island => {
      const island = pair(20);
      const hook: PairHook = { regime: (_a, _b, tick) => (inContact(tick) ? 'contact' : 'free'), solve: () => undefined };
      if (forced) island.setPairHook(hook);
      let last = 0;
      for (let k = 0; k < 1200; k++) {
        island.step();
        const now = island.counters.pairSubsteps;
        expect(now - last, `tick ${island.tick - 1}`).toBe(forced && inContact(island.tick - 1) ? 2 : 0);
        last = now;
      }
      return island;
    };
    const free = relative(run(false), 'alpha', 'bravo');
    const forced = relative(run(true), 'alpha', 'bravo');
    expect(v3.dist(free.v, forced.v)).toBeLessThan(1e-4);
    expect(v3.dist(free.r, forced.r)).toBeLessThan(1e-3);
  }, 60_000);

  it('the reference orbit is state: a restored island goes on bit for bit', () => {
    const island = pair(100);
    for (let k = 0; k < 300; k++) island.step();
    const copy = decodeIsland(s.deps, island.encode());
    expect(copy.reference).toEqual(island.reference);
    for (let k = 0; k < 1200; k++) {
      island.step();
      copy.step();
    }
    expect(copy.hash()).toBe(island.hash());
  });

  it('the reference orbit follows the anchor: replaced when the anchor has finished a burn, and when its offset passes 30 km; each is a rebase operation and moves nothing', () => {
    const island = pair(100);
    const rebases = (report: AdvanceReport): number => report.ops.filter((o) => o.body.op === 'rebase').length;
    const anchorOffset = (): { r: number; v: number } => {
      const v = island.member('alpha')!.vessel;
      const com = comStateOf(v);
      return { r: v3.len(com.r), v: v3.len(com.v) };
    };
    // The first step reports the operation that made the reference orbit for the member set; coasting, the anchor
    // stays on it and nothing is replaced.
    expect(rebases(island.step())).toBe(1);
    let count = 0;
    for (let k = 0; k < 240; k++) count += rebases(island.step());
    expect(count).toBe(0);
    expect(anchorOffset().r).toBeLessThan(1e-3);
    // A translation burn of the anchor with its thrusters: 4 s of it.
    expect(island.applyInput(input(island.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'rcs', on: true } })).outcome?.ok).toBe(true);
    island.applyInput(input(island.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ translate: { x: 0, y: 1, z: 0 } }), sasHold: null }));
    for (let k = 0; k < 480; k++) count += rebases(island.step());
    // While it burns the reference stands: the anchor has left it by the burn's delta-v.
    expect(count).toBe(0);
    expect(island.member('alpha')!.mode).toBe('integrated');
    const burned = anchorOffset();
    expect(burned.v).toBeGreaterThan(REFERENCE_SETTLE_SPEED * 10);
    // The burn ends: at the next control tick the reference orbit is the anchor's again.
    const before = relative(island, 'alpha', 'bravo');
    const state = v3.clone(island.stateOf('bravo')!.r);
    island.applyInput(input(island.tick, { kind: 'controls', vesselId: 'alpha', controls: controls(), sasHold: null }));
    let report = island.step();
    let waited = 1;
    while (rebases(report) === 0 && waited < 8) {
      report = island.step();
      waited++;
    }
    expect(rebases(report)).toBe(1);
    expect(waited).toBeLessThanOrEqual(4);
    expect(report.frameChange).toMatchObject({ fromBodyId: star, toBodyId: star });
    expect(island.reference!.tick).toBe(island.tick);
    expect(anchorOffset().r).toBeLessThan(1e-3);
    expect(anchorOffset().v).toBeLessThan(1e-9);
    // Nothing moved: the two are where the steps put them (their separation changes by the steps alone).
    const after = relative(island, 'alpha', 'bravo');
    expect(v3.dist(after.v, before.v)).toBeLessThan(1e-6);
    expect(v3.dist(after.r, before.r)).toBeLessThan(burned.v * waited * (1 / 120) + 1e-3);
    expect(v3.dist(island.stateOf('bravo')!.r, state)).toBeLessThan(30_000);
    // And it is not replaced again while the anchor coasts.
    count = 0;
    for (let k = 0; k < 240; k++) count += rebases(island.step());
    expect(count).toBe(0);
    // A checkpoint taken in the middle of a burn rebases at the same tick as the island it was taken from.
    const burning = pair(100);
    burning.applyInput(input(burning.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'rcs', on: true } }));
    burning.applyInput(input(burning.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ translate: { x: 1, y: 0, z: 0 } }), sasHold: null }));
    for (let k = 0; k < 200; k++) burning.step();
    const copy = decodeIsland(s.deps, burning.encode());
    for (const i of [burning, copy]) i.applyInput(input(burning.tick + 40, { kind: 'controls', vesselId: 'alpha', controls: controls(), sasHold: null }));
    count = 0;
    for (let k = 0; k < 120; k++) {
      const a = rebases(burning.step());
      const b = rebases(copy.step());
      expect(b, `tick ${burning.tick}`).toBe(a);
      count += a;
    }
    expect(count).toBe(1);
    expect(copy.hash()).toBe(burning.hash());
  }, 60_000);

  it('a long burn: the reference orbit is replaced when the anchor is 30 km from it, while it still burns; the server\u2019s rebase operation applied to a replica that rebased itself changes nothing', () => {
    // A stack with a main engine: the lunar stack's upper part, staged until an engine burns, at 40 % throttle (the
    // tank lasts for 21 km of offset at full throttle).
    const island = islandAt(s, star);
    island.add(orbiter(s.defs, 'alpha', 3, mu, 30 * AU), { pilot: PILOT, attended: true });
    island.add(orbiter(s.defs, 'bravo', 7, mu, 30 * AU, { x: 0, y: 100, z: 0 }));
    island.applyInput(input(island.tick, { kind: 'controls', vesselId: 'alpha', controls: controls({ throttle: 0.4 }), sasHold: null }));
    for (let n = 0; n < 4 && island.member('alpha')!.vessel.thrust === 0; n++) {
      island.applyInput(input(island.tick, { kind: 'command', vesselId: 'alpha', command: { kind: 'stage' } }));
      for (let k = 0; k < 360; k++) island.step();
    }
    expect(island.member('alpha')!.vessel.thrust).toBeGreaterThan(0);
    let farthest = 0;
    let op: AdvanceReport['ops'][number] | null = null;
    // (A rebase at each staging on the way here is behind us: from now on the engine burns without a pause.)
    for (let k = 0; k < 160_000 && op === null; k++) {
      farthest = Math.max(farthest, v3.len(comStateOf(island.member('alpha')!.vessel).r));
      const report = island.step();
      op = report.ops.find((o) => o.body.op === 'rebase') ?? null;
    }
    expect(op).not.toBeNull();
    // (`farthest` is read before each step; the limit is looked at on the control-tick cadence after it.)
    expect(farthest).toBeGreaterThan(REFERENCE_OFFSET_MAX - 500);
    expect(farthest).toBeLessThan(REFERENCE_OFFSET_MAX + 500);
    expect(island.member('alpha')!.mode).toBe('integrated');
    expect(v3.len(comStateOf(island.member('alpha')!.vessel).r)).toBeLessThan(1e-3);
    // A replica (the same state, the same code) has rebased at the same tick: the operation finds its reference in place.
    const replica = decodeIsland(s.deps, island.encode(), { mode: 'predict' });
    const before = replica.hash();
    if (op!.body.op === 'rebase') expect(checksumsAgree(replica.applyOp(op!.body)!, op!.checksum!)).toBe(true);
    expect(replica.hash()).toBe(before);
    expect(replica.hash()).toBe(island.hash());
  }, 120_000);

  for (const [name, distance] of [
    ['1 AU', AU],
    ['30 AU', 30 * AU],
  ] as const) {
    it(`at ${name} three vessels added in two orders are one island: the reference orbit and every offset are a function of the set`, () => {
      const make = (order: readonly string[]): Island => {
        const island = islandAt(s, star);
        for (const id of order) {
          const k = ['alpha', 'bravo', 'charlie'].indexOf(id);
          island.add(orbiter(s.defs, id, 7, mu, distance, { x: 40 * k, y: 150 * k, z: -30 * k }), id === 'bravo' ? { pilot: PILOT, attended: true } : {});
        }
        island.refreshMargins();
        return island;
      };
      const x = make(['alpha', 'bravo', 'charlie']);
      const y = make(['charlie', 'alpha', 'bravo']);
      const z = make(['bravo', 'charlie', 'alpha']);
      // The anchor is the attended member, whichever was added first.
      for (const i of [x, y, z]) expect(i.anchorId).toBe('bravo');
      expect(y.hash()).toBe(x.hash());
      expect(z.hash()).toBe(x.hash());
      expect(x.reference).not.toBeNull();
      expect(y.reference).toEqual(x.reference);
      for (let k = 0; k < 600; k++) for (const i of [x, y, z]) i.step();
      expect(y.hash()).toBe(x.hash());
      expect(z.hash()).toBe(x.hash());
    });
  }
});
