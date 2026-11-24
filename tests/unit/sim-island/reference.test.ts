/**
 * The island in the star's sphere of influence (ARCHITECTURE section 4): it integrates offsets from its
 * reference orbit (Encke's method with Battin's f(q)), on the staged Sun-rooted library. Heliocentric
 * float64 positions resolve a millimetre at 30 AU; the offsets do not lose that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '@/core/math/vec3';
import { decodeIsland, type Island, type PairHook } from '@/sim/island';
import { islandAt, loadLibraryOver, orbiter, PILOT, relative, setup, TICK0, type Setup } from './helpers';

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
});
