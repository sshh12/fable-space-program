/**
 * Rebasing what a presentation consumer holds across a replacement of the render root (docs/ARCHITECTURE.md
 * section 3; the arithmetic is src/core/math/frame.ts). Three things every holder needs beside the tracker:
 *
 *  - `observeFrame`: the tracker's answer as a value. A holder must never fail a frame, so the two cases in
 *    which `FrameEpochTracker.observe` throws (the snapshot no longer describes the epoch the holder last
 *    saw; the epoch went backwards, which is another session) are the answer 'drop': the holder forgets what
 *    it holds, as it does on a new session, and the tracker stands at the new epoch.
 *  - `rebaseHeldAt`: a rebase is the old origin's position and velocity in the new frame AT THE TIME OF THE
 *    SNAPSHOT THAT CARRIES IT. A position that was taken at an earlier time (the previous frame's camera, a
 *    vessel that left the snapshot some frames ago) is moved with the offset as it was at that earlier time,
 *    `offset - velocity * age`: the two origins move against each other (the Moon about the Earth at 1 km/s),
 *    so the offset of now would displace a position of one frame ago by metres. With it a held position reads
 *    in the new frame as if the origin had been the new one all along.
 *  - `rebaseSnapshot`: a snapshot of the old frame with its ROOT positions and velocities in the new one.
 *
 * Pure float64; nothing here keeps state.
 */
import type { SimSnapshot } from '../contracts/sim';
import { rebasePoint, rebaseVelocity, type FrameEpoch, type FrameEpochTracker, type FrameRebase } from '../math/frame';

/** What a holder of ROOT quantities does with them when it sees a snapshot's frame. */
export type FrameChange = { kind: 'same' } | { kind: 'rebase'; rebase: FrameRebase } | { kind: 'drop' };

const SAME: FrameChange = Object.freeze({ kind: 'same' });
const DROP: FrameChange = Object.freeze({ kind: 'drop' });

/**
 * Observe a snapshot's frame with a holder's tracker. 'same': nothing to do. 'rebase': move every held
 * position and velocity with it (`rebasePoint`, `rebaseVelocity`; `rebaseHeldAt` for what was taken earlier
 * than this snapshot). 'drop': the held epoch cannot be reached from this frame; forget what is held.
 */
export function observeFrame(tracker: FrameEpochTracker, frame: FrameEpoch | undefined): FrameChange {
  const held = tracker.current;
  if (frame !== undefined && held !== null && frame.epoch !== held) {
    const reachable = frame.epoch > held && (frame.previous !== undefined ? frame.previous.some((p) => p.epoch === held) : frame.rebase !== null);
    if (!reachable) {
      tracker.reset();
      tracker.observe(frame);
      return DROP;
    }
  }
  const rebase = tracker.observe(frame);
  return rebase === null ? SAME : { kind: 'rebase', rebase };
}

/**
 * The rebase for something that was held `age` seconds of simulation time before the snapshot that carries
 * `rebase`: the old origin's position in the new frame at that earlier time (to first order in `age`: the
 * relative acceleration of two origins is millimetres per second squared) and the same velocity.
 */
export function rebaseHeldAt(rebase: FrameRebase, age: number): FrameRebase {
  if (age === 0) return rebase;
  const { offset, velocity } = rebase;
  return { offset: { x: offset.x - velocity.x * age, y: offset.y - velocity.y * age, z: offset.z - velocity.z * age }, velocity };
}

/**
 * A snapshot of the old frame expressed in the new one: the ROOT positions and velocities of its bodies and
 * vessels and the ROOT positions its events state, moved with `rebase` (pass `rebaseHeldAt(rebase, age)` for
 * a snapshot that is `age` seconds older than the one that carries the rebase). Orientations, directions and
 * everything relative to a body are what they were. The orbit patches are not touched: nobody draws the
 * patches of an earlier snapshot.
 */
export function rebaseSnapshot(snapshot: SimSnapshot, rebase: FrameRebase): SimSnapshot {
  return {
    ...snapshot,
    bodies: snapshot.bodies.map((b) => ({ ...b, rRoot: rebasePoint(b.rRoot, rebase), vRoot: rebaseVelocity(b.vRoot, rebase) })),
    vessels: snapshot.vessels.map((v) => ({ ...v, rRoot: rebasePoint(v.rRoot, rebase), vRoot: rebaseVelocity(v.vRoot, rebase) })),
    events: snapshot.events.map((e) => (e.type === 'explosion' ? { ...e, posRoot: rebasePoint(e.posRoot, rebase) } : e)),
  };
}
