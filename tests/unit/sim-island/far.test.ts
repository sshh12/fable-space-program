/**
 * The objects of a clock outside its island (src/sim/island/far.ts; ARCHITECTURE 6.2, 7.3).
 *  - A piece in the Reduced tier steps at 2 Hz. Whoever compares it with states of a tick, or takes it into
 *    an island at a tick, gets its state AT that tick, not at its last half-second step (fix round, finding
 *    4; request lead-12: at 11 km/s the stale state was 1,833 m behind).
 *  - The Reduced tier is for debris only (lead decision, fix round, finding 8): a vessel somebody can
 *    command, or with crew aboard, a deployed chute, a docked craft, or one the host protects, is never a
 *    2 Hz point mass. `receive` refuses it; one whose conic meets the air asks its host for a run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PartDef } from '@/core/contracts/defs';
import { v3 } from '@/core/math/vec3';
import { BodyFrames, FarSet, isDebris, type FarObject, type Island } from '@/sim/island';
import { createCraft, structureOf, type Vessel } from '@/sim/vessel';
import { createPart, emptyVessel } from '@/sim/vessel/assemble';
import { islandAt, loadLibrary, orbiter, PILOT, setup, TICK0, VEHICLE, type Setup } from './helpers';

describe('the far set', () => {
  let s: Setup;
  let mu: number;
  let radius: number;
  beforeAll(async () => {
    s = setup(await loadLibrary());
    mu = s.system.body('earth').mu;
    radius = s.system.body('earth').radius;
  });

  /** One part as a vessel of its own, on the circular orbit of `r0`, `along` metres ahead on the track. */
  function fragment(id: string, def: PartDef, r0: number, along: number): Vessel {
    const v = emptyVessel(id, def.name, createCraft(s.defs.vehicles[VEHICLE]!, { craftId: id }));
    v.parts.push(createPart(def.id, def, 'debris'));
    v.r = { x: r0, y: along, z: 0 };
    v.v = { x: 0, y: Math.sqrt(mu / r0), z: 0 };
    structureOf(v);
    return v;
  }

  function world(): { island: Island; far: FarSet; frames: BodyFrames; asked: FarObject[] } {
    const frames = new BodyFrames(s.system, s.deps.terrain);
    const asked: FarObject[] = [];
    const far = new FarSet(frames, { event: () => undefined, removed: () => undefined, needsRun: (o) => void asked.push(o) });
    return { island: islandAt(s, 'earth'), far, frames, asked };
  }

  it('a Reduced piece is compared and admitted with its state at the tick: 1.8 km ahead of a craft at orbital speed it does not join, and taken between two of its steps it is where the tick says', () => {
    const { island, far } = world();
    // 120 km up: inside the atmosphere's top, nearly no air.
    const r0 = radius + 120_000;
    island.add(orbiter(s.defs, 'alpha', 7, mu, r0), { pilot: PILOT, attended: true });
    const piece = fragment('piece', s.defs.parts['meridian-interstage-2']!, r0, 1800);
    const o = far.add(piece, 'earth', TICK0, { bornTick: TICK0, revision: 0, orbit: null, railsEvent: null, order: 1 });
    expect(o.tier).toBe('reduced');
    let joined = 0;
    for (let k = 0; k < 58; k++) {
      island.step();
      far.step(island.tick);
      if (island.tick % 4 === 0) joined += far.joinInto(island, island.tick);
    }
    // The craft moved 3.8 km in those 58 ticks; a piece read at its last step would have seemed to come within the join distance.
    expect(joined).toBe(0);
    expect(o.reducedTick).toBe(TICK0);
    // Taken now, 58 ticks after its last step: its state is the state of this tick (still 1.8 km ahead, on the same orbit).
    const taken = far.take('piece', island.tick)!;
    expect(taken.reducedTick).toBe(island.tick);
    const range = v3.dist(taken.vessel.r, island.stateOf('alpha')!.r);
    expect(Math.abs(range - 1800)).toBeLessThan(20);
    expect(v3.dist(taken.vessel.v, island.stateOf('alpha')!.v)).toBeLessThan(5);
  });

  it('only debris is reduced: a crewed capsule in the air is refused by receive and stays a member; in vacuum it leaves on its conic; a bare stage is taken either way', () => {
    const { island, far } = world();
    const low = radius + 100_000;
    island.add(orbiter(s.defs, 'alpha', 7, mu, low), { pilot: PILOT, attended: true });
    island.add(orbiter(s.defs, 'bravo', 7, mu, low, { x: 0, y: 5000, z: 0 }));
    island.add(fragment('stage', s.defs.parts['meridian-interstage-2']!, low, 9000));
    expect(isDebris(island.member('bravo')!.vessel)).toBe(false);
    expect(isDebris(island.member('stage')!.vessel)).toBe(true);
    expect(far.receive(island, 'bravo', 1)).toBeNull();
    expect(island.member('bravo')).not.toBeNull();
    const stage = far.receive(island, 'stage', 2)!;
    expect(stage.tier).toBe('reduced');
    // The host's own reasons (a target, an owner's session) protect a vessel that the structure calls debris.
    const { island: other, far: guarded } = world();
    other.add(orbiter(s.defs, 'alpha', 7, mu, low), { pilot: PILOT, attended: true });
    other.add(fragment('stage', s.defs.parts['meridian-interstage-2']!, low, 9000));
    guarded.protect = (v) => v.id === 'stage';
    expect(guarded.receive(other, 'stage', 1)).toBeNull();
    // In vacuum nothing is reduced: the capsule leaves the island on its conic, passive.
    const { island: high, far: passive } = world();
    const up = radius + 400_000;
    high.add(orbiter(s.defs, 'alpha', 7, mu, up), { pilot: PILOT, attended: true });
    high.add(orbiter(s.defs, 'bravo', 7, mu, up, { x: 0, y: 5000, z: 0 }));
    const left = passive.receive(high, 'bravo', 1)!;
    expect(left.tier).toBe('rails');
    expect(left.orbit).not.toBeNull();
  });

  it('a commandable craft on rails whose conic meets the air is not reduced: it waits at the entry for the run its host is asked for', () => {
    const { far, asked } = world();
    // A capsule on an ellipse from 400 km down to 60 km: it meets the top of the air within half a revolution.
    const ra = radius + 400_000;
    const rp = radius + 60_000;
    const capsule = orbiter(s.defs, 'bravo', 7, mu, ra);
    capsule.v = { x: 0, y: Math.sqrt((2 * mu * rp) / (ra * (ra + rp))), z: 0 };
    const o = far.add(capsule, 'earth', TICK0, { bornTick: TICK0, revision: 0, orbit: null, railsEvent: null, order: 0 });
    expect(o.tier).toBe('rails');
    expect(o.railsEvent?.kind).toBe('atmosphere');
    far.advanceTo(TICK0 + 120 * 3600);
    expect(o.tier).toBe('rails');
    expect(o.waiting).toBe(true);
    expect(asked).toEqual([o]);
    // It stands at the top of the air, at the tick of its entry, until it is taken.
    const top = s.defs.bodies['earth']!.atmosphere!.simTop;
    expect(Math.abs(v3.len(o.vessel.r) - radius - top)).toBeLessThan(2000);
    const at = v3.clone(o.vessel.r);
    far.advanceTo(TICK0 + 120 * 7200);
    expect(v3.dist(o.vessel.r, at)).toBe(0);
    expect(asked).toHaveLength(1);
    // The same ellipse flown by a bare stage: the Reduced tier takes it and flies it on.
    const { far: other, asked: none } = world();
    const stage = fragment('stage', s.defs.parts['meridian-interstage-2']!, ra, 0);
    stage.v = v3.clone(capsule.v);
    const d = other.add(stage, 'earth', TICK0, { bornTick: TICK0, revision: 0, orbit: null, railsEvent: null, order: 0 });
    other.advanceTo(TICK0 + 120 * 3600);
    expect(none).toHaveLength(0);
    expect(d.waiting).toBe(false);
    expect(d.tier === 'reduced' || d.removed).toBe(true);
  });
});
