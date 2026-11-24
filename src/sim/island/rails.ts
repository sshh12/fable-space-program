/**
 * A vessel on rails (ARCHITECTURE 7.1 "rails propagation always from the epoch state"; 5.1 "quiescent").
 *
 * The orbit is that of the CENTRE OF MASS (the vessel's origin is re-derived from its attitude), so a vessel
 * that rotates about its centre of mass stays exactly on its conic. The same point-mass gravity is used on
 * rails and when integrating, so both hand-overs are exact. A state at a tick is evaluated from the clock
 * base of the tick (src/sim/clock.ts): the same expression for a step and for a rails landing.
 */
import { v3, type Vec3 } from '@/core/math/vec3';
import { baseUtOfTick, nearestTick, offsetOfTick, utOfTick } from '../clock';
import { makeOrbit, propagate, type Orbit } from '../orbit/kepler';
import { predictPatchesWithOrbits } from '../orbit/patches';
import type { BodyFrames } from './frames';

export type RailsEventKind = 'soiEnter' | 'soiExit' | 'atmosphere' | 'impact' | 'recheck';

/** The next instant at which a vessel on rails cannot simply go on along its conic. */
export interface RailsEvent {
  ut: number;
  kind: RailsEventKind;
  nextBodyId: string | null;
}

/** The first event of the conic `orbit` about `bodyId` after `t`: the end of its first predicted patch. */
export function computeRailsEvent(frames: BodyFrames, bodyId: string, orbit: Orbit, t: number): RailsEvent | null {
  const s = propagate(orbit, t);
  const p = predictPatchesWithOrbits(frames.system, { bodyId, r: s.r, v: s.v }, t, [], { maxPatches: 1, terrainHeight: frames.coarseHeight }).current[0];
  if (!p) return null;
  const patch = p.patch;
  switch (patch.endReason) {
    case 'soiEnter':
    case 'soiExit':
      return { ut: patch.tEnd, kind: patch.endReason, nextBodyId: patch.nextBodyId ?? null };
    case 'atmosphere':
      return { ut: patch.tEnd, kind: 'atmosphere', nextBodyId: null };
    case 'impact':
      return { ut: patch.tEnd, kind: 'impact', nextBodyId: null };
    default:
      return { ut: patch.tEnd, kind: 'recheck', nextBodyId: null };
  }
}

/**
 * Centre-of-mass state on `orbit` at `utNew`. An instant on the grid is the clock base of its tick plus whole
 * ticks: propagate with the two apart (exact time of flight), for a step and for a rails landing alike, so
 * that a vessel on rails is in the same state at a tick however the clock got there. An event instant inside
 * a tick is propagated to as it is.
 */
export function railsStateAt(orbit: Orbit, utNew: number): { r: Vec3; v: Vec3 } {
  const tick = nearestTick(utNew);
  if (utOfTick(tick) !== utNew) return propagate(orbit, utNew);
  return propagate(orbit, baseUtOfTick(tick), offsetOfTick(tick));
}

/**
 * Express a state about `from` in the frame of the body the event leads to, at the event's instant: the
 * child's state is taken off on entering its sphere of influence, the body's own state about its parent is
 * added on leaving. The one transformation of a hand-over: every member of an island takes it with the
 * same body state.
 */
export function crossSoi(frames: BodyFrames, from: string, ev: { ut: number; kind: 'soiEnter' | 'soiExit'; nextBodyId: string | null }): { to: string; shift: { r: Vec3; v: Vec3 }; sign: 1 | -1 } {
  const to = ev.nextBodyId!;
  if (ev.kind === 'soiEnter') return { to, shift: frames.system.stateRelParent(to, ev.ut), sign: -1 };
  return { to, shift: frames.system.stateRelParent(from, ev.ut), sign: 1 };
}

/** Apply a hand-over shift to a state (new arrays; the inputs stand). */
export function shifted(s: { r: Vec3; v: Vec3 }, x: { shift: { r: Vec3; v: Vec3 }; sign: 1 | -1 }): { r: Vec3; v: Vec3 } {
  return x.sign < 0 ? { r: v3.sub(s.r, x.shift.r), v: v3.sub(s.v, x.shift.v) } : { r: v3.add(s.r, x.shift.r), v: v3.add(s.v, x.shift.v) };
}

/**
 * The events of a vessel after it crossed into `to` at `ut`: the boundary just crossed is not an event again
 * for the first second (hysteresis).
 */
export function eventAfterCrossing(frames: BodyFrames, to: string, orbit: Orbit, ut: number): RailsEvent | null {
  let next = computeRailsEvent(frames, to, orbit, ut + 1e-3);
  if (next && next.ut <= ut + 1 && (next.kind === 'soiEnter' || next.kind === 'soiExit')) next = computeRailsEvent(frames, to, orbit, ut + 1.001);
  return next;
}

/** The orbit of a centre-of-mass state about a body at `ut`. */
export function orbitOf(frames: BodyFrames, bodyId: string, s: { r: Vec3; v: Vec3 }, ut: number): Orbit {
  return makeOrbit(bodyId, frames.info(bodyId).mu, s.r, s.v, ut);
}
