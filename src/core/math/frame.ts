/**
 * Render-root rebase helpers (docs/ARCHITECTURE.md section 3).
 *
 * Positions handed to presentation are relative to the render root: axes parallel to ICRF, origin near the
 * viewer (`SimSnapshot.frame`). The origin is replaced now and then (a focus change, a sphere-of-influence
 * change of the focus, a new island reference orbit). The snapshot that first carries the new frame epoch
 * also carries a `FrameRebase`: the OLD origin's position and velocity in the NEW frame at the snapshot time.
 * Because the axes never change, moving a held quantity from the old frame to the new one is one addition:
 *
 *   positionNew = positionOld + rebase.offset
 *   velocityNew = velocityOld + rebase.velocity
 *
 * Who needs this: anything that keeps a ROOT position (or a ROOT velocity) from one frame to the next: camera
 * rigs, the renderer's previous-frame state, world-anchored effects, the map focus. Differences of two ROOT
 * positions of the same snapshot, directions and orientations need nothing.
 *
 * Use: keep one `FrameEpochTracker` per consumer, call `observe(snapshot.frame)` once per snapshot, and when
 * it returns a rebase apply it to every held position (`rebasePoint` / `rebasePointInPlace`) and velocity
 * (`rebaseVelocity` / `rebaseVelocityInPlace`) before using them with the new snapshot.
 *
 * Pure float64 arithmetic; no allocation in the `InPlace` forms.
 */
import type { Vec3 } from './vec3';

/** The old origin's position (m) and velocity (m/s) in the new frame, at the time of the snapshot that carries it. */
export interface FrameRebase {
  offset: Vec3;
  velocity: Vec3;
}

/** The part of `SimSnapshot.frame` the tracker reads (structural, so this module does not import the contracts). */
export interface FrameEpoch {
  epoch: number;
  rebase: FrameRebase | null;
}

/** A rebase that changes nothing. */
export const IDENTITY_REBASE: Readonly<FrameRebase> = Object.freeze({
  offset: Object.freeze({ x: 0, y: 0, z: 0 }),
  velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
});

/** A position held in the old frame, expressed in the new frame (a new object). */
export function rebasePoint(p: Vec3, rebase: FrameRebase): Vec3 {
  return { x: p.x + rebase.offset.x, y: p.y + rebase.offset.y, z: p.z + rebase.offset.z };
}

/** As `rebasePoint`, writing into `p`; returns `p`. */
export function rebasePointInPlace(p: Vec3, rebase: FrameRebase): Vec3 {
  p.x += rebase.offset.x;
  p.y += rebase.offset.y;
  p.z += rebase.offset.z;
  return p;
}

/** A velocity held in the old frame, expressed in the new frame (a new object). */
export function rebaseVelocity(v: Vec3, rebase: FrameRebase): Vec3 {
  return { x: v.x + rebase.velocity.x, y: v.y + rebase.velocity.y, z: v.z + rebase.velocity.z };
}

/** As `rebaseVelocity`, writing into `v`; returns `v`. */
export function rebaseVelocityInPlace(v: Vec3, rebase: FrameRebase): Vec3 {
  v.x += rebase.velocity.x;
  v.y += rebase.velocity.y;
  v.z += rebase.velocity.z;
  return v;
}

/**
 * The single rebase equal to applying `first` and then `second` (frame A -> B -> C), both taken at the same
 * instant. A producer that replaced the origin more than once between two snapshots publishes the composition.
 */
export function composeRebase(first: FrameRebase, second: FrameRebase): FrameRebase {
  return {
    offset: { x: first.offset.x + second.offset.x, y: first.offset.y + second.offset.y, z: first.offset.z + second.offset.z },
    velocity: { x: first.velocity.x + second.velocity.x, y: first.velocity.y + second.velocity.y, z: first.velocity.z + second.velocity.z },
  };
}

/** The rebase back from the new frame to the old one, at the same instant. */
export function invertRebase(rebase: FrameRebase): FrameRebase {
  return {
    offset: { x: -rebase.offset.x, y: -rebase.offset.y, z: -rebase.offset.z },
    velocity: { x: -rebase.velocity.x, y: -rebase.velocity.y, z: -rebase.velocity.z },
  };
}

/**
 * The rebase between two origins whose states are known in one common frame with parallel axes: `oldOrigin`
 * and `newOrigin` are the position and velocity of each origin in that frame at the snapshot time. This is
 * what a producer computes when it replaces the origin.
 */
export function rebaseBetween(oldOrigin: { r: Vec3; v: Vec3 }, newOrigin: { r: Vec3; v: Vec3 }): FrameRebase {
  return {
    offset: { x: oldOrigin.r.x - newOrigin.r.x, y: oldOrigin.r.y - newOrigin.r.y, z: oldOrigin.r.z - newOrigin.r.z },
    velocity: { x: oldOrigin.v.x - newOrigin.v.x, y: oldOrigin.v.y - newOrigin.v.y, z: oldOrigin.v.z - newOrigin.v.z },
  };
}

/**
 * Tells one consumer when to rebase what it holds. Call `observe` exactly once per snapshot the consumer
 * uses, in order. It returns the rebase to apply now, or null when the frame did not change.
 *
 * A frame that is absent (a producer older than MIGRATION_V2 step 3.5, a hand-built snapshot) never changes:
 * `observe(undefined)` returns null and keeps the tracker where it was.
 */
export class FrameEpochTracker {
  private epoch: number | null = null;

  /** The epoch last observed; null before the first frame. */
  get current(): number | null {
    return this.epoch;
  }

  observe(frame: FrameEpoch | undefined): FrameRebase | null {
    if (frame === undefined) return null;
    if (this.epoch === null) {
      // Nothing is held from before the first frame, so there is nothing to move.
      this.epoch = frame.epoch;
      return null;
    }
    if (frame.epoch === this.epoch) return null;
    if (frame.epoch < this.epoch) throw new Error(`frame epoch went backwards (${this.epoch} -> ${frame.epoch})`);
    if (frame.rebase === null) throw new Error(`frame epoch changed (${this.epoch} -> ${frame.epoch}) without a rebase`);
    this.epoch = frame.epoch;
    return frame.rebase;
  }

  /** Forget the observed epoch (the consumer dropped everything it held, e.g. on a new session). */
  reset(): void {
    this.epoch = null;
  }
}
