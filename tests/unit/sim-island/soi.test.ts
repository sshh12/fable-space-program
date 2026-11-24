/**
 * An island of two across a sphere-of-influence boundary (ARCHITECTURE 7.3, "SOI hand-over as a unit";
 * island-core acceptance: "an island crossing an SOI boundary keeps relative positions to 1 um, an Armed
 * member included"). The island changes frame as one, at one instant, with one body state: on rails at the
 * anchor's event instant, integrated at the control tick that sees the anchor across. Whichever of the two
 * is geometrically first through the sphere, both change body in the same tick; a pair in the contact regime
 * stays in lockstep through it; a checkpoint taken before the crossing continues to the same hash.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { v3, type Vec3 } from '@/core/math/vec3';
import { utOfTick } from '@/sim/clock';
import { decodeIsland, type Island, type PairHook } from '@/sim/island';
import { assembleVessel, seededCraftIds, type Vessel } from '@/sim/vessel';
import { islandAt, loadLibrary, PILOT, setup, TICK0, VEHICLE, type Setup } from './helpers';

/** Speed toward the Moon at the boundary, and the sideways speed that keeps the pass clear of the surface, m/s. */
const INWARD = 900;
const SIDEWAYS = 1200;

describe('an island of two across a sphere of influence', () => {
  let s: Setup;
  let soi: number;
  /** Unit vectors at the entry point: from the Moon outward, and across the track. */
  let out: Vec3;
  let across: Vec3;
  beforeAll(async () => {
    s = setup(await loadLibrary());
    soi = s.system.body('moon').soiRadius!;
    const moon = s.system.stateRelParent('moon', utOfTick(TICK0));
    // Enter on the side that faces the Earth.
    out = v3.normalize(v3.neg(moon.r));
    across = v3.normalize(v3.cross(out, { x: 0, y: 0, z: 1 }));
  });

  /** A capsule-sized craft `outside` metres outside the Moon's sphere at TICK0, `along` metres further out and `side` metres across, falling in. */
  function craft(id: string, outside: number, along = 0, side = 0): Vessel {
    const vessel = assembleVessel(s.defs, VEHICLE, { stagesAlreadyFired: 7, craft: { craftId: id, joinedTick: TICK0, ids: seededCraftIds() } });
    const moon = s.system.stateRelParent('moon', utOfTick(TICK0));
    vessel.r = v3.add(moon.r, v3.add(v3.scale(out, soi + outside + along), v3.scale(across, side)));
    vessel.v = v3.add(moon.v, v3.add(v3.scale(out, -INWARD), v3.scale(across, SIDEWAYS)));
    vessel.hold = null;
    vessel.surface = 'none';
    vessel.anchor = null;
    return vessel;
  }

  const separation = (island: Island): { r: Vec3; v: Vec3 } => {
    const a = island.stateOf('alpha')!;
    const b = island.stateOf('bravo')!;
    return { r: v3.sub(b.r, a.r), v: v3.sub(b.v, a.v) };
  };

  /** Step until the island is about the Moon; returns the events of the crossing step and the separation just before and just after it. */
  function cross(island: Island, limit = 600): { events: SimEvent[]; before: { r: Vec3; v: Vec3 }; after: { r: Vec3; v: Vec3 }; tick: number } {
    for (let k = 0; k < limit; k++) {
      const before = separation(island);
      const report = island.step();
      if (island.bodyId === 'moon') return { events: report.events.filter((e) => e.type === 'soiChange'), before, after: separation(island), tick: island.tick };
      expect(report.events.some((e) => e.type === 'soiChange')).toBe(false);
    }
    throw new Error('the island did not reach the sphere of influence');
  }

  it('on rails, one member Armed: both change body in one step at the anchor\'s instant; the separation is carried over to under 1 um and 1 um/s', () => {
    const island = islandAt(s, 'earth');
    island.add(craft('alpha', 250), { pilot: PILOT, attended: true });
    // 600 m across: inside the join distance, outside the armed margin.
    island.add(craft('bravo', 250, 0, 600));
    island.settle('alpha');
    island.settle('bravo');
    island.refreshMargins();
    expect(island.anchorId).toBe('alpha');
    expect(island.member('alpha')!.mode).toBe('rails');
    expect(island.member('alpha')!.railsEvent?.kind).toBe('soiEnter');
    expect(island.member('bravo')!.mode).toBe('armed');
    const x = cross(island);
    expect(x.events.map((e) => e.vesselId).sort()).toEqual(['alpha', 'bravo']);
    expect(x.events[0]!.ut).toBe(x.events[1]!.ut);
    // The instant is the anchor's event: inside the step that crossed, not on its grid.
    expect(x.events[0]!.ut).toBeGreaterThan(utOfTick(x.tick - 1));
    expect(x.events[0]!.ut).toBeLessThanOrEqual(utOfTick(x.tick));
    // One step of coasting apart at the relative velocity; the frame change adds under a micrometre.
    const expected = v3.addScaled(x.before.r, x.before.v, PHYSICS_DT);
    expect(v3.dist(x.after.r, expected)).toBeLessThan(1e-6);
    expect(v3.dist(x.after.v, x.before.v)).toBeLessThan(1e-6);
    expect(island.member('bravo')!.tier).toBe('armed');
    expect(island.member('bravo')!.orbit!.bodyId).toBe('moon');
    expect(island.counters.freeSteps + island.counters.probeSubsteps + island.counters.pairSubsteps).toBeGreaterThan(0);
    expect(island.counters.pairSubsteps).toBe(0);
  });

  it('a rails advance across the boundary lands where the steps do, to under 1 um between the two members', () => {
    const make = (): Island => {
      const island = islandAt(s, 'earth');
      island.add(craft('alpha', 250), { pilot: PILOT, attended: true });
      island.add(craft('bravo', 250, 0, 600));
      island.settle('alpha');
      island.settle('bravo');
      island.refreshMargins();
      return island;
    };
    const stepped = make();
    const advanced = make();
    for (let k = 0; k < 480; k++) stepped.step();
    const report = advanced.advanceTo(TICK0 + 480);
    expect(advanced.tick).toBe(TICK0 + 480);
    expect(stepped.bodyId).toBe('moon');
    expect(advanced.bodyId).toBe('moon');
    expect(report.events.filter((e) => e.type === 'soiChange')).toHaveLength(2);
    expect(report.frameChange).toMatchObject({ fromBodyId: 'earth', toBodyId: 'moon' });
    expect(v3.dist(separation(stepped).r, separation(advanced).r)).toBeLessThan(1e-6);
    expect(v3.dist(stepped.stateOf('alpha')!.r, advanced.stateOf('alpha')!.r)).toBeLessThan(1e-4);
  });

  it('a member whose own conic grazes the sphere while the island stays outside keeps its conic and its later events', () => {
    const island = islandAt(s, 'earth');
    // Both drift past the Moon at 300 m/s, on closed orbits about the Earth: alpha 3,000 km outside the Moon's
    // sphere all the way, bravo 200 km inside it at its nearest (it is in the sphere from a quarter of an hour
    // on, for nearly ten hours).
    const moon = s.system.stateRelParent('moon', utOfTick(TICK0));
    const place = (id: string, clear: number): Vessel => {
      const v = craft(id, 0);
      v.r = v3.add(moon.r, v3.add(v3.scale(out, soi + clear), v3.scale(across, -5_400_000)));
      v.v = v3.add(moon.v, v3.scale(across, 300));
      return v;
    };
    island.add(place('alpha', 3_000_000), { pilot: PILOT, attended: true });
    island.add(place('bravo', -200_000));
    island.settle('alpha');
    island.settle('bravo');
    expect(island.member('alpha')!.railsEvent?.kind ?? 'none').not.toBe('soiEnter');
    expect(island.member('bravo')!.railsEvent?.kind).toBe('soiEnter');
    island.advanceTo(TICK0 + 120 * 3600 * 12);
    // The island is about the Earth still, bravo on its Earth conic, and its conic is still watched for what comes next.
    expect(island.bodyId).toBe('earth');
    const b = island.member('bravo')!;
    expect(b.orbit).not.toBeNull();
    expect(b.orbit!.bodyId).toBe('earth');
    expect(b.railsEvent).not.toBeNull();
    expect(b.railsEvent!.ut).toBeGreaterThan(island.ut);
  });

  describe('a pair in the contact regime (forced by the hook)', () => {
    const solved: { tick: number; both: boolean }[] = [];
    const hook: PairHook = { regime: () => 'contact', solve: (_a, _b, runA, runB, tick, sub) => void (sub === 0 && solved.push({ tick, both: runA !== null && runB !== null })) };

    function pair(along: number): Island {
      const island = islandAt(s, 'earth');
      island.add(craft('alpha', 150), { pilot: PILOT, attended: true });
      island.add(craft('bravo', 150, along, 20));
      island.setPairHook(hook);
      return island;
    }

    // bravo 20 m beside alpha; 100 m ahead of it (through the sphere about 13 ticks earlier); 100 m behind it.
    for (const [name, along] of [
      ['together', 0],
      ['bravo first', -100],
      ['alpha first', 100],
    ] as const) {
      it(`${name}: both change body in the same tick, the lockstep holds through it, the relative velocity gains under 0.1 mm/s`, () => {
        solved.length = 0;
        const island = pair(along);
        const free = islandAt(s, 'earth', 'authoritative', 'free');
        free.add(craft('alpha', 150), { pilot: PILOT, attended: true });
        free.add(craft('bravo', 150, along, 20));
        let subs = 0;
        let crossedAt = -1;
        let crossing: SimEvent[] = [];
        let before = separation(island);
        let after = before;
        for (let k = 0; k < 240; k++) {
          const sepBefore = separation(island);
          const report = island.step();
          free.step();
          // Both vessels take the sub-stepped path in every tick, the crossing tick included.
          expect(island.counters.pairSubsteps - subs, `tick ${island.tick - 1}`).toBe(2);
          subs = island.counters.pairSubsteps;
          const changes = report.events.filter((e) => e.type === 'soiChange');
          if (changes.length > 0) {
            expect(crossedAt).toBe(-1);
            crossedAt = island.tick;
            crossing = changes;
            before = sepBefore;
            after = separation(island);
          }
        }
        expect(island.bodyId).toBe('moon');
        expect(crossing.map((e) => e.vesselId).sort()).toEqual(['alpha', 'bravo']);
        expect(crossing[0]!.ut).toBe(crossing[1]!.ut);
        // An integrated anchor is seen across at a control tick: the hand-over is at that tick's instant.
        expect(crossedAt % 4).toBe(0);
        expect(crossing[0]!.ut).toBe(utOfTick(crossedAt));
        // The pair pass ran once per sub-step group in every tick, with both runs.
        expect(solved).toHaveLength(240);
        expect(solved.every((x) => x.both)).toBe(true);
        expect(island.counters.probeSubsteps).toBe(0);
        // Across the hand-over step: one step of relative motion, nothing added by the frame change.
        expect(v3.dist(after.r, v3.addScaled(before.r, before.v, PHYSICS_DT))).toBeLessThan(1e-6);
        expect(v3.dist(after.v, before.v)).toBeLessThan(1e-6);
        // Against the same flight on the free path (which crosses at the same tick): the regime gained under 0.1 mm/s.
        expect(free.bodyId).toBe('moon');
        expect(v3.dist(separation(island).v, separation(free).v)).toBeLessThan(1e-4);
        expect(v3.dist(separation(island).r, separation(free).r)).toBeLessThan(1e-3);
      });
    }

    it('a checkpoint taken before the crossing, restored and continued through it, has the hash of the uninterrupted run at every control tick', () => {
      const island = pair(-100);
      for (let k = 0; k < 8; k++) island.step();
      const bytes = island.encode();
      const restored = decodeIsland(s.deps, bytes);
      restored.setPairHook(hook);
      expect(restored.hash()).toBe(island.hash());
      let crossed = false;
      for (let k = 0; k < 240; k++) {
        island.step();
        restored.step();
        if (island.bodyId === 'moon') crossed = true;
        if (island.tick % 4 === 0) expect(restored.hash(), `tick ${island.tick}`).toBe(island.hash());
      }
      expect(crossed).toBe(true);
      expect(restored.bodyId).toBe('moon');
      // And a checkpoint taken on the tick of the crossing itself.
      const again = pair(-100);
      while (again.bodyId !== 'moon') again.step();
      const after = decodeIsland(s.deps, again.encode());
      after.setPairHook(hook);
      for (let k = 0; k < 120; k++) {
        again.step();
        after.step();
      }
      expect(after.hash()).toBe(again.hash());
    });
  });
});
