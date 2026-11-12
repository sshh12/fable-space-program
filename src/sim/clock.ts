/**
 * The tick grid (docs/ARCHITECTURE.md section 3, "Time").
 *
 * The canonical time of the simulation is the TICK: an integer count of 1/120 s since J2000.0, carried in a
 * float64. `ut = tick / TICKS_PER_SECOND` (seconds) is derived and is what the orbit, body and force code
 * take as arguments. Every state time (the clock, a rails landing, the time a reduced-tier state refers to,
 * a scenario start) is a whole tick; only an EVENT instant (a sphere-of-influence crossing, an atmosphere
 * entry, a node) is a float64 second inside its tick.
 *
 * A float64 `ut` near 1e9 s resolves 1.2e-7 s, that is 1.4e-5 ticks, so the conversions below allow for
 * that rounding: an instant within TICK_EPSILON ticks of a whole tick is that tick.
 */
import { PHYSICS_DT } from '../core/contracts/defs';
import { TICKS_PER_SECOND } from '../core/contracts/net';

export { TICKS_PER_SECOND };

/** Fraction of a tick within which a float64 instant counts as the whole tick beside it (8.3 microseconds). */
export const TICK_EPSILON = 1e-3;

/** Seconds since J2000.0 of a tick. */
export const utOfTick = (tick: number): number => tick / TICKS_PER_SECOND;

/** True when `ut` is exactly the float64 instant of a whole tick. */
export function isTickInstant(ut: number): boolean {
  return Number.isFinite(ut) && Math.round(ut * TICKS_PER_SECOND) / TICKS_PER_SECOND === ut;
}

/** The tick of a tick-aligned instant; throws for any other (naming `what` in the message). */
export function tickOfInstant(ut: number, what: string): number {
  if (!isTickInstant(ut)) throw new Error(`${what}: ${ut} s is not a whole tick of 1/${TICKS_PER_SECOND} s`);
  return Math.round(ut * TICKS_PER_SECOND) + 0;
}

/** The whole tick nearest to an instant. */
export const nearestTick = (ut: number): number => Math.round(ut * TICKS_PER_SECOND) + 0;

/** The first whole tick at or after an instant (an instant within TICK_EPSILON after a tick is that tick). */
export const ceilTick = (ut: number): number => Math.ceil(ut * TICKS_PER_SECOND - TICK_EPSILON) + 0;

/** The last whole tick at or before an instant (an instant within TICK_EPSILON before a tick is that tick). */
export const floorTick = (ut: number): number => Math.floor(ut * TICKS_PER_SECOND + TICK_EPSILON) + 0;

/** The instant of the whole tick nearest to `ut`: what tools write for a start time. */
export const snapToTick = (ut: number): number => nearestTick(ut) / TICKS_PER_SECOND;

/** Seconds spanned by a whole number of ticks (exact to rounding of one product: no accumulated error). */
export const secondsOfTicks = (ticks: number): number => ticks * PHYSICS_DT;
