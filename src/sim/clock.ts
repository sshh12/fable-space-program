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

/**
 * THE STATE AT A TICK IS A FUNCTION OF THE TICK AND THE VESSELS. Three things used to depend on how the
 * clock got to a tick (where the last rails landing was): the base that body orientations are evaluated
 * from, the phase of the control ticks and the phase of the sun sample. All three are fixed functions of
 * the tick, so a session that reaches a tick by rails, by steps or after a restore is in the same state.
 *
 * Clock base. A body's orientation is W(base) + rate x (seconds since the base), and a vessel on rails is
 * propagated to "base plus seconds since": the absolute time in seconds resolves only 1.2e-7 s at mission
 * epochs (1e-11 rad of the Earth's turn, a millimetre of an orbit), which would show as noise from step to
 * step; the offset from a base is exact. The base of a tick is the last whole multiple of BASE_TICKS: one
 * day. Why a day: the offset then stays below 86,400 s, where a whole number of ticks times 1/120 s is
 * exact to 1.5e-11 s (1e-15 rad of the Earth's turn, 7 nm at its surface, 1e-7 m of a low orbit), a base
 * is itself a whole number of seconds (exact), and the base changes once per day of universe time; at that
 * one tick the evaluation error of W at an absolute time (about 1e-11 rad, some tens of micrometres of
 * ground) appears as a single step of the ground, where a shorter period would show it more often and a
 * longer one would let the offset lose bits.
 */
export const BASE_TICKS = 86400 * TICKS_PER_SECOND;

/** The clock base of a tick: the last whole multiple of BASE_TICKS at or before it. */
export const baseTickOf = (tick: number): number => tick - (((tick % BASE_TICKS) + BASE_TICKS) % BASE_TICKS);

/** The clock base of a tick as an instant, s (a whole number of seconds: exact). */
export const baseUtOfTick = (tick: number): number => baseTickOf(tick) / TICKS_PER_SECOND;

/** Seconds from the clock base of a tick to the tick: whole ticks times the length of one. */
export const offsetOfTick = (tick: number): number => (tick - baseTickOf(tick)) * (1 / TICKS_PER_SECOND);

/** A control tick is due at the ticks that are whole multiples of this (30 Hz of universe time; CONTROL_TICK_STEPS of the contract). */
export const CONTROL_TICKS = 4;

/** The sun sample (direction and visible fraction of the star at a vessel) is taken at the ticks that are whole multiples of this. */
export const SUN_SAMPLE_TICKS = 12;
