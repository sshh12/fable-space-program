import { describe, expect, it } from 'vitest';
import { composeRebase, FRAME_HISTORY_EPOCHS, FrameEpochTracker, IDENTITY_REBASE, invertRebase, rebaseBetween, rebasePoint, rebasePointInPlace, rebaseVelocity, rebaseVelocityInPlace, type FrameRebase } from './frame';
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

describe('FrameEpochTracker with the per-epoch history: a holder may skip snapshots', () => {
  // Three origins moving at constant velocity in one common frame; the session's origin is A, then B, then C.
  const origin = (r0: Vec3, vel: Vec3) => (t: number): { r: Vec3; v: Vec3 } => ({ r: v(r0.x + vel.x * t, r0.y + vel.y * t, r0.z + vel.z * t), v: vel });
  const A = origin(v(0, 0, 0), v(0, 0, 0));
  const B = origin(v(3.8e8, 0, 0), v(0, 1000, 0));
  const C = origin(v(3.8e8, 2.0e6, 5.0e5), v(-300, 1600, 20));
  const epochs = [A, B, C];
  /** What a session publishes at time t while its origin is that of epoch `e`, when the previous snapshot was at epoch `prev`. */
  const frame = (e: number, t: number, prev: number): { epoch: number; rebase: FrameRebase | null; previous: (FrameRebase & { epoch: number })[] } => ({
    epoch: e,
    rebase: prev === e ? null : rebaseBetween(epochs[prev]!(t), epochs[e]!(t)),
    previous: Array.from({ length: e }, (_, k) => ({ epoch: e - 1 - k, ...rebaseBetween(epochs[e - 1 - k]!(t), epochs[e]!(t)) })).slice(0, FRAME_HISTORY_EPOCHS),
  });

  it('a holder that observes every snapshot gets the one-step rebase, which is the history entry', () => {
    const t = new FrameEpochTracker();
    expect(t.observe(frame(0, 0, 0))).toBeNull();
    const f = frame(1, 10, 0);
    expect(t.observe(f)).toEqual(f.rebase);
    expect(t.observe(frame(1, 11, 1))).toBeNull();
  });

  it('a holder that skipped the snapshot of the change still lands where the point is', () => {
    // A point at rest 100 m from origin A, held by a consumer that last observed at t = 0 (epoch 0).
    const held = v(100, -50, 25);
    const consumer = new FrameEpochTracker();
    consumer.observe(frame(0, 0, 0));
    // The session went A -> B at t = 10 and B -> C at t = 20; the consumer sees neither snapshot, only t = 30.
    const now = frame(2, 30, 2);
    expect(now.rebase).toBeNull();
    const r = consumer.observe(now);
    expect(r).not.toBeNull();
    const moved = rebasePoint(held, r!);
    // Truth: the point is still 100 m from A; A's position relative to C at t = 30.
    const a = A(30);
    const c = C(30);
    expect(moved).toEqual(v(a.r.x - c.r.x + 100, a.r.y - c.r.y - 50, a.r.z - c.r.z + 25));
    expect(rebaseVelocity(v(0, 0, 0), r!)).toEqual(v(300, -1600, -20));
    expect(consumer.current).toBe(2);
    // The one-step rebase of the snapshot at t = 20 (B -> C) would have been wrong for this holder by B's offset from A.
    const oneStep = frame(2, 20, 1).rebase!;
    expect(Math.abs(rebasePoint(held, oneStep).x - moved.x)).toBeGreaterThan(1e8);
  });

  it('a holder that skipped snapshots within one epoch change needs the entry of ITS epoch, at the present time', () => {
    const consumer = new FrameEpochTracker();
    consumer.observe(frame(1, 12, 1));
    // Still epoch 2 several snapshots after the change: `rebase` is null, the history is not.
    const r = consumer.observe(frame(2, 45, 2))!;
    const b = B(45);
    const c = C(45);
    expect(r.offset).toEqual(v(b.r.x - c.r.x, b.r.y - c.r.y, b.r.z - c.r.z));
  });

  it('a holder older than the history is told to drop what it holds', () => {
    const consumer = new FrameEpochTracker();
    consumer.observe({ epoch: 2, rebase: null, previous: [] });
    const far = { epoch: 2 + FRAME_HISTORY_EPOCHS + 1, rebase: null, previous: Array.from({ length: FRAME_HISTORY_EPOCHS }, (_, k) => ({ epoch: 2 + FRAME_HISTORY_EPOCHS - k, ...IDENTITY_REBASE })) };
    expect(() => consumer.observe(far)).toThrow(/skipped too many replacements/);
    consumer.reset();
    expect(consumer.observe(far)).toBeNull();
  });

  it('without a history only the one-step rebase exists (hand-built snapshots)', () => {
    const consumer = new FrameEpochTracker();
    consumer.observe({ epoch: 0, rebase: null });
    const step: FrameRebase = { offset: v(1, 2, 3), velocity: v(0, 0, 0) };
    expect(consumer.observe({ epoch: 1, rebase: step })).toBe(step);
  });
});
