/**
 * The island in the star's sphere of influence (ARCHITECTURE section 4): it integrates offsets from its
 * reference orbit (Encke's method with Battin's f(q)), on the staged Sun-rooted library. Heliocentric
 * float64 positions resolve a millimetre at 30 AU; the offsets do not lose that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '@/core/math/vec3';
import { comStateOf, decodeIsland, REFERENCE_OFFSET_MAX, REFERENCE_SETTLE_SPEED, type AdvanceReport, type Island, type PairHook } from '@/sim/island';
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
    // Coasting: the anchor stays on the reference orbit and nothing is replaced.
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
    // The offset limit: a reference point 40 km from the anchor (given as a rebase operation) is replaced at the next control tick.
    const far = island.stateOf('alpha')!;
    island.applyOp({ op: 'rebase', anchor: island.member('alpha')!.slot, bodyId: star, r: v3.add(far.r, { x: 40_000, y: 0, z: 0 }), v: far.v });
    expect(anchorOffset().r).toBeGreaterThan(REFERENCE_OFFSET_MAX);
    count = 0;
    for (let k = 0; k < 4; k++) count += rebases(island.step());
    expect(count).toBe(1);
    expect(anchorOffset().r).toBeLessThan(1);
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
});
