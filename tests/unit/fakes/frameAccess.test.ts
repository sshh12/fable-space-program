/**
 * Holders of ROOT positions across a replacement of the render root (src/core/access/frameAccess.ts): the
 * answer of the tracker as a value, a rebase as of an earlier time, a whole snapshot in the new frame, and
 * the lab's exact translation of a frame. The session is the fake one, whose `setRenderRoot` replaces the
 * origin as a change of the sphere of influence does (epoch, rebase, history).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { observeFrame, rebaseHeldAt, rebaseSnapshot } from '@/core/access/frameAccess';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSession } from '@/core/fakes/fakeSession';
import { FrameEpochTracker, rebasePoint } from '@/core/math/frame';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { translateFrame } from '@/render/core/lab/origin';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const bodyOf = (s: SimSnapshot, id: string): SimSnapshot['bodies'][number] => s.bodies.find((b) => b.id === id)!;

describe('observeFrame', () => {
  it('says same, rebase or drop, and never throws', () => {
    const tracker = new FrameEpochTracker();
    const rb = { offset: { x: 1, y: 2, z: 3 }, velocity: { x: 0.1, y: 0, z: 0 } };
    expect(observeFrame(tracker, undefined)).toEqual({ kind: 'same' });
    expect(observeFrame(tracker, { epoch: 4, rebase: null, previous: [] })).toEqual({ kind: 'same' });
    expect(observeFrame(tracker, { epoch: 4, rebase: null, previous: [] })).toEqual({ kind: 'same' });
    // The next epoch, described by the history: the rebase from the epoch this holder saw.
    expect(observeFrame(tracker, { epoch: 6, rebase: null, previous: [{ epoch: 5, offset: v3.zero(), velocity: v3.zero() }, { epoch: 4, ...rb }] })).toEqual({ kind: 'rebase', rebase: rb });
    expect(tracker.current).toBe(6);
    // An epoch the snapshot no longer describes, and an epoch that went backwards (another session): drop.
    expect(observeFrame(tracker, { epoch: 20, rebase: rb, previous: [{ epoch: 19, ...rb }] })).toEqual({ kind: 'drop' });
    expect(tracker.current).toBe(20);
    expect(observeFrame(tracker, { epoch: 0, rebase: null, previous: [] })).toEqual({ kind: 'drop' });
    expect(tracker.current).toBe(0);
    // A hand-built frame without a history is trusted for its one step; without a rebase it cannot be reached.
    expect(observeFrame(tracker, { epoch: 1, rebase: rb })).toEqual({ kind: 'rebase', rebase: rb });
    expect(observeFrame(tracker, { epoch: 2, rebase: null })).toEqual({ kind: 'drop' });
  });
});

describe('a held position across a replacement of the origin', () => {
  it('reads in the new frame where it was, also when it was taken some time before the replacement', () => {
    const session = createFakeSession(defs, { scene: 'lunarOrbit', renderRoot: 'rootBody' });
    const tracker = new FrameEpochTracker();
    const before = session.snapshot();
    expect(observeFrame(tracker, before.frame).kind).toBe('same');
    const vessel0 = before.vessels[0]!;
    const moon0 = bodyOf(before, vessel0.bodyId);
    // What a holder keeps: the vessel's place and its place relative to the Moon, as of `before`.
    const held = v3.clone(vessel0.rRoot);
    const relMoon = v3.sub(vessel0.rRoot, moon0.rRoot);
    // Two seconds later the origin is replaced by the Moon (the root body is 384,000 km away).
    for (let i = 0; i < 120; i++) session.advance(1 / 60);
    session.setRenderRoot(vessel0.bodyId);
    const after = session.snapshot();
    const change = observeFrame(tracker, after.frame);
    if (change.kind !== 'rebase') throw new Error(`expected a rebase, got ${change.kind}`);
    expect(v3.len(change.rebase.offset)).toBeGreaterThan(3e8);
    expect(v3.len(change.rebase.velocity)).toBeGreaterThan(500);
    // With the offset of NOW the held place is off by what the two origins moved against each other in 2 s ...
    const naive = rebasePoint(held, change.rebase);
    expect(v3.dist(naive, relMoon)).toBeGreaterThan(1000);
    // ... as of the time it was taken it is where it was: the vessel's place about the Moon then (the Moon is the origin now).
    const age = after.ut - before.ut;
    expect(age).toBeCloseTo(2, 4);
    const moved = rebasePoint(held, rebaseHeldAt(change.rebase, age));
    expect(v3.dist(moved, relMoon)).toBeLessThan(1e-2);
    // A whole snapshot: every body and vessel, and the pairs the renderer forms from two frames, are unchanged.
    const old = rebaseSnapshot(before, rebaseHeldAt(change.rebase, age));
    expect(v3.len(bodyOf(old, vessel0.bodyId).rRoot)).toBeLessThan(1e-2);
    for (const b of before.bodies) {
      const twin = bodyOf(old, b.id);
      expect(v3.dist(v3.sub(twin.rRoot, old.vessels[0]!.rRoot), v3.sub(b.rRoot, vessel0.rRoot)), b.id).toBeLessThan(1e-4 * Math.max(1, v3.dist(b.rRoot, vessel0.rRoot) / 1e9));
      expect(twin.qFixedToRoot).toEqual(b.qFixedToRoot);
    }
    // The velocity is the vessel's about the Moon then; orbital motion over the two seconds joins the two frames.
    const v0 = v3.sub(vessel0.vRoot, moon0.vRoot);
    expect(v3.dist(old.vessels[0]!.vRoot, v0)).toBeLessThan(1e-2);
    const travelled = v3.dist(after.vessels[0]!.rRoot, old.vessels[0]!.rRoot);
    expect(travelled).toBeGreaterThan(0.9 * v3.len(v0) * age);
    expect(travelled).toBeLessThan(1.1 * v3.len(v0) * age);
    expect(rebaseHeldAt(change.rebase, 0)).toBe(change.rebase);
  });

  it('the lab states a frame about another origin by an exact translation: what the renderer forms is the same to the last bit', () => {
    const snapshot = createFakeSession(defs, { scene: 'lunarSurface', renderRoot: 'rootBody' }).snapshot();
    const vessel = snapshot.vessels[0]!;
    const camera: CameraState = {
      mode: 'chase',
      kind: 'external',
      positionRoot: v3.add(vessel.rRoot, { x: 12.3, y: -4.56, z: 7.89 }),
      qViewToRoot: quat.identity(),
      fovY: 1,
      insideVesselId: null,
      focusVesselId: vessel.id,
      focusBodyId: vessel.bodyId,
      exposureCompensation: 0,
      minEv100: null,
      fillLight: 0,
    };
    const moved = translateFrame(snapshot, camera, vessel.bodyId);
    expect(moved.snapshot.frame).toEqual({ epoch: 0, origin: { kind: 'body', bodyId: vessel.bodyId }, rebase: null, previous: [] });
    expect(v3.len(bodyOf(moved.snapshot, vessel.bodyId).rRoot)).toBe(0);
    // The differences the renderer draws from: the vessel and the Moon about the camera, exactly as before.
    expect(v3.dist(v3.sub(moved.snapshot.vessels[0]!.rRoot, moved.camera.positionRoot), v3.sub(vessel.rRoot, camera.positionRoot))).toBe(0);
    expect(v3.dist(v3.sub(bodyOf(moved.snapshot, vessel.bodyId).rRoot, moved.camera.positionRoot), v3.sub(bodyOf(snapshot, vessel.bodyId).rRoot, camera.positionRoot))).toBe(0);
    expect(v3.dist(v3.sub(bodyOf(moved.snapshot, defs.rootBodyId).rRoot, moved.camera.positionRoot), v3.sub(bodyOf(snapshot, defs.rootBodyId).rRoot, camera.positionRoot))).toBe(0);
    expect(() => translateFrame(snapshot, camera, 'no-such-body')).toThrow(/no body/);
  });
});
