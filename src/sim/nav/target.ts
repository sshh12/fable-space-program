/**
 * Navigation to a VESSEL target (ARCHITECTURE 21; TargetReadout in src/core/contracts/sim.ts): the relative
 * state of two vessels in float64 without cancellation, the target's local-vertical frame (LVLH), the velocity
 * relative to the target in the control frame, and the readout the view states for a vessel or port target.
 *
 * Precision (ARCHITECTURE 4): the two states are never differenced through the system root. Each is a
 * state in BCI of its sphere-of-influence body; when the two bodies differ, the offset between the bodies
 * is taken through their lowest common ancestor (BodySystem.stateRelative), so two craft about one planet
 * keep the planet frame's grid (0.9 nm in low orbit), and two craft in one island are differenced in the
 * island's frame by the caller (pass the same `bodyId` and the island-frame states).
 *
 * Conventions: `r`, `v` of the relative state are TARGET minus OWN (where the target is, how it moves seen
 * from here); `rangeRate` negative = closing; the relative velocity of the readout and of the navball's
 * relative markers is OWN minus TARGET (how I move relative to the target); LVLH components are the OWN
 * position in the target's frame: radial out along the target's radius vector, along-track (the orbit
 * normal crossed with radial, so along the target's motion for a prograde orbit), cross-track along the
 * target's orbit normal.
 */
import type { TargetRef, Presence, TimeOffer } from '../../core/contracts/net';
import type { TargetReadout } from '../../core/contracts/sim';
import { quat, type Quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { relativeInclination } from '../orbit/relative';

/** A vessel's state at one instant: BCI of its sphere-of-influence body. */
export interface BodyState {
  bodyId: string;
  r: Vec3;
  v: Vec3;
}

export interface RelativeState {
  /** Target minus own, ROOT axes: position (m) and velocity (m/s). */
  r: Vec3;
  v: Vec3;
  /** |r|, m, and d|r|/dt, m/s (negative = closing). */
  range: number;
  rangeRate: number;
}

/** Relative state of `target` seen from `own` at `ut` (see the module comment for the frames). */
export function relativeState(system: BodySystem, own: BodyState, target: BodyState, ut: number): RelativeState {
  let r: Vec3;
  let v: Vec3;
  if (own.bodyId === target.bodyId) {
    r = v3.sub(target.r, own.r);
    v = v3.sub(target.v, own.v);
  } else {
    const off = system.stateRelative(target.bodyId, own.bodyId, ut);
    r = v3.add(off.r, v3.sub(target.r, own.r));
    v = v3.add(off.v, v3.sub(target.v, own.v));
  }
  const range = v3.len(r);
  return { r, v, range, rangeRate: range > 0 ? v3.dot(r, v) / range : 0 };
}

export interface LvlhFrame {
  /** Unit axes in ROOT axes: radial out, along track, cross track (the orbit normal). */
  radial: Vec3;
  along: Vec3;
  cross: Vec3;
}

/**
 * The local-vertical, local-horizontal frame of a state about its body: radial = r/|r|, cross = (r x v)/|r x v|,
 * along = cross x radial. Null when the state has no orbit plane (radial or at rest: |r x v| below 1e-9 |r| |v|).
 */
export function lvlhFrame(r: Vec3, v: Vec3): LvlhFrame | null {
  const h = v3.cross(r, v);
  const hl = v3.len(h);
  const rl = v3.len(r);
  if (!(rl > 0) || !(hl > 1e-9 * rl * v3.len(v))) return null;
  const radial = v3.scale(r, 1 / rl);
  const cross = v3.scale(h, 1 / hl);
  return { radial, along: v3.cross(cross, radial), cross };
}

/**
 * Largest range at which a target's LVLH frame is stated, as a share of the target's distance from its body
 * centre: beyond a tenth of the orbit radius the straight-line offsets of a curved frame mislead (the
 * proximity plot's frame; ARCHITECTURE 21).
 */
export const LVLH_MAX_RANGE_SHARE = 0.1;

/**
 * Own position in the target's LVLH frame, m; null when the two are not about the same body, beyond
 * LVLH_MAX_RANGE_SHARE of the target's orbit radius, or when the target has no orbit plane.
 */
export function lvlhOffset(own: BodyState, target: BodyState): { radial: number; along: number; cross: number } | null {
  if (own.bodyId !== target.bodyId) return null;
  const f = lvlhFrame(target.r, target.v);
  if (!f) return null;
  const d = v3.sub(own.r, target.r);
  if (v3.len(d) > LVLH_MAX_RANGE_SHARE * v3.len(target.r)) return null;
  return { radial: v3.dot(d, f.radial), along: v3.dot(d, f.along), cross: v3.dot(d, f.cross) };
}

/** Relative inclination of two orbits about one body, rad; null when they are about different bodies or one has no plane. */
export function vesselRelativeInclination(own: BodyState, target: BodyState): number | null {
  if (own.bodyId !== target.bodyId) return null;
  const a = v3.cross(own.r, own.v);
  const b = v3.cross(target.r, target.v);
  if (!(v3.len(a) > 0) || !(v3.len(b) > 0)) return null;
  return relativeInclination(v3.normalize(a), v3.normalize(b));
}

export interface VesselTargetInput {
  system: BodySystem;
  ut: number;
  own: BodyState;
  /** CTL -> BCI (= ROOT axes) attitude of the helm's control part. */
  qCtlToRoot: Quat;
  ref: TargetRef;
  name: string;
  presence: Presence;
  /** The target's time offset from the viewer, ticks. */
  timeOffset: number;
  target: BodyState;
  /** The next closest approaches (src/sim/orbit/chainApproach.ts), at most three in time order. */
  closestApproaches: readonly { ut: number; distance: number; relSpeed: number }[];
  offer: TimeOffer | null;
  /**
   * Range port to port when both a control port and a target port are selected (the caller passes the two
   * ports' positions as `own` and `target`, so this is only a flag for the comment); centre of mass to centre
   * of mass otherwise.
   */
  portToPort?: boolean;
}

/** `Readouts.target` for a vessel or a port target. */
export function vesselTargetReadout(input: VesselTargetInput): TargetReadout {
  const rel = relativeState(input.system, input.own, input.target, input.ut);
  // own relative to the target, in the control frame
  const vRel = v3.neg(rel.v);
  return {
    ref: input.ref,
    name: input.name,
    presence: input.presence,
    timeOffset: input.timeOffset,
    range: rel.range,
    rangeRate: rel.rangeRate,
    relVelocity: quat.rotateInv(input.qCtlToRoot, vRel),
    relSpeed: v3.len(vRel),
    relativeInclination: vesselRelativeInclination(input.own, input.target),
    closestApproaches: input.closestApproaches.slice(0, 3).map((c) => ({ ut: c.ut, distance: c.distance, relSpeed: c.relSpeed })),
    lvlh: lvlhOffset(input.own, input.target),
    offer: input.offer,
  };
}

/**
 * The navball's target direction and the relative velocity for its relative markers (computeNavball's
 * `targetDir` and `relativeVelocity`), ROOT axes: the unit direction to the target (null when on it) and own
 * minus target velocity.
 */
export function navballTargetVectors(system: BodySystem, own: BodyState, target: BodyState, ut: number): { targetDir: Vec3 | null; relativeVelocity: Vec3 } {
  const rel = relativeState(system, own, target, ut);
  return { targetDir: rel.range > 0 ? v3.scale(rel.r, 1 / rel.range) : null, relativeVelocity: v3.neg(rel.v) };
}
