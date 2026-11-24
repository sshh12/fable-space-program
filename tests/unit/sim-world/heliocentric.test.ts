/**
 * A flight that leaves a planet's sphere on the Sun-rooted (staged) library (request solar-system-sim-4;
 * ARCHITECTURE sections 3 and 4). About the star the island integrates OFFSETS from its reference orbit: a
 * member's own `r`, `v` are metres from the reference point. Everything the view shows is the state about the
 * star all the same (position, velocity, the orbital read-outs, the navball, the patches, the warp ladder),
 * and the render root is the reference-orbit point, so that ROOT positions near the craft stay small.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { WARP_LEVELS, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { v3 } from '@/core/math/vec3';
import { createBodySystem, type BodySystem } from '@/sim/bodies/bodySystem';
import { makeOrbit, propagate } from '@/sim/orbit/kepler';
import { loadLibraryOver } from '../sim-island/helpers';
import { active, flatTerrain, makeSim } from './helpers';

describe('out of a planet\'s sphere on the Sun-rooted library', () => {
  let defs: DefLibrary;
  let system: BodySystem;
  let star: string;
  let scenario: ScenarioDef;
  beforeAll(async () => {
    defs = await loadLibraryOver();
    system = createBodySystem(defs);
    star = system.starId;
    const base = defs.scenarios['lunar-direct']!;
    const soi = system.body('earth').soiRadius!;
    // 20 km inside the Earth's sphere, leaving it at 3 km/s along the Earth's own motion: an ellipse about the star.
    const along = v3.normalize(system.stateRelative('earth', star, base.startUt).v);
    const r = v3.scale(along, soi - 20_000);
    const v = v3.scale(along, 3000);
    scenario = { ...base, id: 't-escape', name: 't-escape', start: { kind: 'state', bodyId: 'earth', r: [r.x, r.y, r.z], v: [v.x, v.y, v.z] }, stagesAlreadyFired: 7, milestones: [], target: null };
  });

  it('the snapshot after the exit is the state about the star, the render root is the reference-orbit point, and the warp reaches the top level', async () => {
    const sim = await makeSim(defs, scenario, flatTerrain(defs));
    let s: SimSnapshot = sim.peek();
    expect(active(s).bodyId).toBe('earth');
    expect(s.frame.origin).toEqual({ kind: 'body', bodyId: 'earth' });
    // Step to the exit (about 7 s); keep the Earth-centred state of the tick before it.
    let before = active(s);
    let beforeUt = s.simUt;
    for (let k = 0; k < 2400 && active(s).bodyId === 'earth'; k++) {
      before = active(s);
      beforeUt = s.simUt;
      sim.step();
      s = sim.peek();
    }
    const a = active(s);
    expect(a.bodyId).toBe(star);
    // The state about the star: the Earth's state about it plus the craft's Earth-centred conic, both at this tick.
    const earth = system.stateRelative('earth', star, s.simUt);
    const coast = propagate(makeOrbit('earth', system.body('earth').mu, before.r, before.v, beforeUt), s.simUt);
    const expected = { r: v3.add(earth.r, coast.r), v: v3.add(earth.v, coast.v) };
    expect(v3.len(a.r)).toBeGreaterThan(1e11);
    expect(v3.dist(a.r, expected.r)).toBeLessThan(1);
    expect(v3.dist(a.v, expected.v)).toBeLessThan(1e-3);
    // The read-outs are those of that state: far above the star, on an ellipse about it.
    const starRadius = system.body(star).radius;
    expect(s.readouts.altitudeAsl).toBeCloseTo(v3.len(a.r) - starRadius, -3);
    expect(s.readouts.speedOrbital).toBeCloseTo(v3.len(a.v), 0);
    expect(s.readouts.eccentricity).toBeLessThan(0.5);
    expect(s.readouts.periapsisAltitude).toBeGreaterThan(1e11);
    expect(s.readouts.twr).toBeLessThan(1e9);
    expect(s.patches.current[0]!.bodyId).toBe(star);
    expect(s.patches.current[0]!.conic.e).toBeLessThan(0.5);
    for (const p of s.patches.current) for (const m of p.markers) expect(m.kind).not.toBe('impact');
    // The render root: the island's reference-orbit point. The craft is metres from it, the star an astronomical unit away.
    expect(s.frame.origin.kind).toBe('orbit');
    if (s.frame.origin.kind === 'orbit') expect(s.frame.origin.bodyId).toBe(star);
    expect(s.frame.epoch).toBeGreaterThan(0);
    expect(v3.len(a.rRoot)).toBeLessThan(100);
    expect(v3.len(a.vRoot)).toBeLessThan(1);
    const sun = s.bodies.find((b) => b.id === star)!;
    expect(v3.dist(sun.rRoot, v3.neg(a.r))).toBeLessThan(100);
    const home = s.bodies.find((b) => b.id === 'earth')!;
    expect(v3.dist(v3.sub(home.rRoot, sun.rRoot), earth.r)).toBeLessThan(1);
    // The snapshot that first carries the new epoch says where the old origin (the Earth's centre) is in the new frame.
    const drained = sim.snapshot();
    expect(drained.frame.rebase).not.toBeNull();
    expect(v3.dist(drained.frame.rebase!.offset, home.rRoot)).toBeLessThan(10);
    // The warp ladder reads the same state: the top rails level, and a cruise of ten days leaves a sane orbit.
    expect(sim.commands.setWarpLevel(WARP_LEVELS.length - 1).ok).toBe(true);
    s = sim.peek();
    expect(s.warp.maxIndex).toBe(WARP_LEVELS.length - 1);
    const ut0 = s.simUt;
    sim.advanceRails(ut0 + 10 * 86400);
    s = sim.peek();
    expect(s.simUt - ut0).toBeGreaterThan(9 * 86400);
    const later = active(s);
    expect(later.bodyId).toBe(star);
    expect(v3.len(later.v)).toBeGreaterThan(2e4);
    expect(v3.len(later.v)).toBeLessThan(5e4);
    expect(v3.len(later.rRoot)).toBeLessThan(100);
    expect(s.readouts.eccentricity).toBeLessThan(0.5);
    expect(Number.isFinite(sim.stateHash().length)).toBe(true);
    // A presentation snapshot (the state lags by part of a tick) is as close to the origin.
    sim.commands.setWarpLevel(0);
    sim.advance(1 / 60 + 0.003);
    const shown = sim.snapshot();
    expect(shown.simUt - shown.ut).toBeGreaterThan(0);
    expect(v3.len(active(shown).rRoot)).toBeLessThan(100);
    expect(v3.len(active(shown).r)).toBeGreaterThan(1e11);
  }, 120_000);
});
