import { describe, expect, it } from 'vitest';
import { composeRebase, FrameEpochTracker, IDENTITY_REBASE, invertRebase, rebaseBetween, rebasePoint, rebasePointInPlace, rebaseVelocity, rebaseVelocityInPlace, type FrameRebase } from './frame';
import type { Vec3 } from './vec3';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('render-root rebase', () => {
  // Earth-centred frame -> Moon-centred frame at lunar distance: the old origin (Earth) seen from the Moon.
  const moon = { r: v(3.6e8, 1.2e8, 4.0e7), v: v(-320, 960, 80) };
  const earth = { r: v(0, 0, 0), v: v(0, 0, 0) };
  const toMoon = rebaseBetween(earth, moon);

  it('re-expresses a held position and velocity: a point is where it was, measured from the new origin', () => {
    expect(toMoon.offset).toEqual(v(-3.6e8, -1.2e8, -4.0e7));
    // A craft 100 km from the Moon, held in the Earth frame.
    const craft = v(moon.r.x + 60_000, moon.r.y - 80_000, moon.r.z);
    const craftVel = v(moon.v.x + 1500, moon.v.y, moon.v.z - 20);
    const p = rebasePoint(craft, toMoon);
    expect(p).toEqual(v(60_000, -80_000, 0));
    expect(rebaseVelocity(craftVel, toMoon)).toEqual(v(1500, 0, -20));
    // The inputs were not modified.
    expect(craft.x).toBe(moon.r.x + 60_000);
  });

  it('keeps differences of two positions bit-identical when both are small in the new frame', () => {
    const a = v(12.5, -3.25, 0.5);
    const b = v(13.75, -3.0, 0.125);
    const before = v(b.x - a.x, b.y - a.y, b.z - a.z);
    const shift: FrameRebase = { offset: v(1024, -2048, 4096), velocity: v(0, 0, 0) };
    const a2 = rebasePoint(a, shift);
    const b2 = rebasePoint(b, shift);
    expect(v(b2.x - a2.x, b2.y - a2.y, b2.z - a2.z)).toEqual(before);
  });

  it('in-place forms write into their argument and return it', () => {
    const p = v(1, 2, 3);
    const out = rebasePointInPlace(p, { offset: v(10, 20, 30), velocity: v(1, 1, 1) });
    expect(out).toBe(p);
    expect(p).toEqual(v(11, 22, 33));
    const w = v(1, 2, 3);
    expect(rebaseVelocityInPlace(w, { offset: v(10, 20, 30), velocity: v(-1, -2, -3) })).toBe(w);
    expect(w).toEqual(v(0, 0, 0));
  });

  it('composes and inverts', () => {
    const lander = { r: v(moon.r.x + 1_800_000, moon.r.y, moon.r.z), v: v(moon.v.x, moon.v.y + 1600, moon.v.z) };
    const toLander = rebaseBetween(moon, lander);
    const direct = rebaseBetween(earth, lander);
    const composed = composeRebase(toMoon, toLander);
    expect(composed.offset).toEqual(direct.offset);
    expect(composed.velocity).toEqual(direct.velocity);
    const p = v(5, 6, 7);
    expect(rebasePoint(rebasePoint(p, toMoon), invertRebase(toMoon))).toEqual(p);
    expect(rebasePoint(p, IDENTITY_REBASE)).toEqual(p);
    expect(rebaseVelocity(p, IDENTITY_REBASE)).toEqual(p);
    expect(Object.isFrozen(IDENTITY_REBASE)).toBe(true);
  });

  it('precision: a rebase from a heliocentric origin at 30 AU to a local one loses nothing below the heliocentric grid, and the local frame resolves micrometres', () => {
    const origin = { r: v(4.4e12, 1.1e12, -2.0e11), v: v(-1200, 5300, 40) };
    const craft = v(origin.r.x + 12.5, origin.r.y - 7.25, origin.r.z + 3.5);
    const local = rebasePoint(craft, rebaseBetween({ r: v(0, 0, 0), v: v(0, 0, 0) }, origin));
    // The heliocentric float64 grid at 4.4e12 m is about 1 mm; the offsets above were chosen on it.
    expect(Math.abs(local.x - 12.5)).toBeLessThan(1e-3);
    expect(Math.abs(local.y + 7.25)).toBeLessThan(1e-3);
    expect(Math.abs(local.z - 3.5)).toBeLessThan(1e-3);
    // Once local, two points 1 um apart stay distinct.
    const q = v(local.x + 1e-6, local.y, local.z);
    expect(q.x - local.x).toBeGreaterThan(0.5e-6);
  });
});

describe('FrameEpochTracker', () => {
  const rebase: FrameRebase = { offset: v(1, 2, 3), velocity: v(4, 5, 6) };

  it('returns null until the epoch changes, then the rebase exactly once', () => {
    const t = new FrameEpochTracker();
    expect(t.current).toBeNull();
    expect(t.observe({ epoch: 7, rebase: null })).toBeNull();
    expect(t.current).toBe(7);
    expect(t.observe({ epoch: 7, rebase: null })).toBeNull();
    expect(t.observe({ epoch: 8, rebase })).toBe(rebase);
    expect(t.observe({ epoch: 8, rebase })).toBeNull();
    // A composed rebase over two replacements arrives as one epoch jump of two.
    expect(t.observe({ epoch: 10, rebase })).toBe(rebase);
    expect(t.current).toBe(10);
  });

  it('the first frame never rebases, even when it carries one', () => {
    const t = new FrameEpochTracker();
    expect(t.observe({ epoch: 3, rebase })).toBeNull();
    expect(t.current).toBe(3);
  });

  it('an absent frame (a producer without the v2 field) never changes anything', () => {
    const t = new FrameEpochTracker();
    expect(t.observe(undefined)).toBeNull();
    expect(t.current).toBeNull();
    t.observe({ epoch: 1, rebase: null });
    expect(t.observe(undefined)).toBeNull();
    expect(t.current).toBe(1);
  });

  it('refuses a new epoch without a rebase and an epoch that goes backwards', () => {
    const t = new FrameEpochTracker();
    t.observe({ epoch: 4, rebase: null });
    expect(() => t.observe({ epoch: 5, rebase: null })).toThrow(/without a rebase/);
    expect(() => t.observe({ epoch: 3, rebase })).toThrow(/backwards/);
    t.reset();
    expect(t.observe({ epoch: 3, rebase })).toBeNull();
  });
});
