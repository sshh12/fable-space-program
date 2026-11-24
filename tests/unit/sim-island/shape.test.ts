/**
 * Bodies with a shape and bodies without a surface, on the staged Sun-rooted library (request
 * solar-system-sim-1; ARCHITECTURE 8.3): the air a member flies through is sampled at its altitude above the
 * body's spheroid, and a member below the floor of a body without a surface is destroyed, cause
 * 'overstress', by the authoritative mode only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { floorAltitude, surfaceRadius } from '@/sim/bodies/shape';
import { utOfTick } from '@/sim/clock';
import { BodyFrames } from '@/sim/island';
import { islandAt, loadLibraryOver, orbiter, setup, steps, TICK0, type Setup } from './helpers';

describe('a body with a shape and without a surface (the staged library)', () => {
  let s: Setup;
  let giant: string;
  beforeAll(async () => {
    s = setup(await loadLibraryOver());
    // The first body that has both a spheroid and a floor instead of a surface.
    giant = s.system.ids.find((id) => s.defs.bodies[id]!.shape && floorAltitude(s.defs.bodies[id]!) !== null)!;
  });

  it('the staged library has such a body', () => {
    expect(giant).toBeTruthy();
  });

  it('the air is sampled at the altitude above the spheroid: denser over the pole than over the equator at one distance from the centre', () => {
    const def = s.defs.bodies[giant]!;
    const info = s.system.body(giant);
    const frames = new BodyFrames(s.system, s.deps.terrain);
    const ut = utOfTick(TICK0);
    const q = frames.orientAt(giant, ut);
    const pole = quat.rotate(q, { x: 0, y: 0, z: 1 });
    const equator = quat.rotate(q, { x: 1, y: 0, z: 0 });
    const island = islandAt(s, giant);
    // Both at the mean radius plus 100 km from the centre; the spheroid stands above the mean sphere at the equator and below it at the pole.
    const distance = info.radius + 100_000;
    const a = orbiter(s.defs, 'alpha', 7, info.mu, distance);
    const b = orbiter(s.defs, 'bravo', 7, info.mu, distance);
    a.r = v3.scale(equator, distance);
    b.r = v3.scale(pole, distance);
    island.add(a);
    island.add(b);
    const overEquator = distance - surfaceRadius(def, { x: 1, y: 0, z: 0 });
    const overPole = distance - surfaceRadius(def, { x: 0, y: 0, z: 1 });
    expect(overPole - overEquator).toBeGreaterThan(1000);
    expect(frames.altitudeAt(giant, a.r, ut)).toBeCloseTo(overEquator, 3);
    expect(frames.altitudeAt(giant, b.r, ut)).toBeCloseTo(overPole, 3);
    // The environment's air at the vessel (the vessel package asks with its altitude above the mean sphere).
    const envA = island.environmentOf('alpha')!;
    const envB = island.environmentOf('bravo')!;
    const atA = envA.atmosphereAt(distance - envA.radius);
    const atB = envB.atmosphereAt(distance - envB.radius);
    expect(atA.density).toBeGreaterThan(atB.density);
    // The same air as the body's own model gives at the altitude above the spheroid: at the equator the
    // mean-sphere altitude would be off by the whole equatorial bulge.
    const bulge = surfaceRadius(def, { x: 1, y: 0, z: 0 }) - info.radius;
    expect(bulge).toBeGreaterThan(1000);
    expect(envA.atmosphereAt(bulge + 5000).density).toBeCloseTo(envB.atmosphereAt(surfaceRadius(def, { x: 0, y: 0, z: 1 }) - info.radius + 5000).density, 12);
  });

  it('a member below the floor is destroyed with cause overstress at the next control tick; the predict mode holds it', () => {
    const def = s.defs.bodies[giant]!;
    const info = s.system.body(giant);
    const floor = floorAltitude(def)!;
    const run = (mode: 'authoritative' | 'predict'): { gone: boolean; causes: string[] } => {
      const island = islandAt(s, giant, mode);
      const frames = new BodyFrames(s.system, s.deps.terrain);
      const q = frames.orientAt(giant, utOfTick(TICK0));
      // 2 km below the floor over the equator, falling.
      const distance = surfaceRadius(def, { x: 1, y: 0, z: 0 }) + floor - 2000;
      const v = orbiter(s.defs, 'alpha', 7, info.mu, distance);
      v.r = v3.scale(quat.rotate(q, { x: 1, y: 0, z: 0 }), distance);
      v.v = v3.scale(v3.normalize(v.r), -50);
      island.add(v);
      const events = steps(island, 8);
      return { gone: island.member('alpha') === null, causes: events.flatMap((e) => (e.type === 'partDestroyed' ? [e.cause] : [])) };
    };
    const authoritative = run('authoritative');
    expect(authoritative.gone).toBe(true);
    expect(authoritative.causes.length).toBeGreaterThan(0);
    expect(new Set(authoritative.causes)).toEqual(new Set(['overstress']));
    const predict = run('predict');
    expect(predict.gone).toBe(false);
    expect(predict.causes).toEqual([]);
  });
});
