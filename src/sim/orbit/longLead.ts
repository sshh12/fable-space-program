/**
 * Rails propagation at any lead on the tick grid (ARCHITECTURE 4: "orbit phase uses the tick difference to the
 * orbit's own epoch"; the rules allow 250 years of lead, UniverseRules.time.leadCap).
 *
 * `propagate(orbit, t)` forms t - t0 in seconds as one float64 and reduces it modulo the period: at 250 years
 * the time of flight resolves 0.95 us, and the period's own rounding accumulates over the revolutions (a low
 * orbit turns 1.4 million times), so the along-track phase of a low orbit is wrong by millimetres. Here the
 * time of flight is the tick difference (an exact integer) divided by 120 and reduced modulo the period in
 * double-double arithmetic (Dekker's exact products, Knuth's exact sums), and only the reduced time of flight,
 * which is shorter than half a period, is handed to the universal-variable solver. The phase error is then
 * that of a propagation within one period (1e-13 of it): far under a millimetre of arc at any lead.
 *
 * The orbit is the one of `makeOrbit`; its epoch instant is `epochTick` (its `t0` is that tick / 120 as a
 * float64). Pure, allocation-light, no state.
 */
import type { StateVector } from '../../core/contracts/simInternal';
import { propagate, type Orbit } from './kepler';

/** Ticks per second of the universe clock (ARCHITECTURE 3: one tick = 1/120 s). */
const TICKS_PER_SECOND = 120;
/** 2 pi as a double-double. */
const TWO_PI_HI = 6.283185307179586;
const TWO_PI_LO = 2.4492935982947064e-16;
const SPLITTER = 134217729; // 2^27 + 1

/** A double-double number hi + lo, |lo| <= ulp(hi) / 2. */
type DD = [number, number];

function twoSum(a: number, b: number): DD {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}

function quickTwoSum(a: number, b: number): DD {
  const s = a + b;
  return [s, b - (s - a)];
}

function split(a: number): DD {
  const t = SPLITTER * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}

function twoProd(a: number, b: number): DD {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

function ddAdd(a: DD, b: DD): DD {
  const [s, e] = twoSum(a[0], b[0]);
  return quickTwoSum(s, e + a[1] + b[1]);
}

function ddMul(a: DD, b: DD): DD {
  const [p, e] = twoProd(a[0], b[0]);
  return quickTwoSum(p, e + a[0] * b[1] + a[1] * b[0]);
}

function ddDiv(a: DD, b: DD): DD {
  const q1 = a[0] / b[0];
  const r = ddAdd(a, ddMul(b, [-q1, 0]));
  const q2 = r[0] / b[0];
  const r2 = ddAdd(r, ddMul(b, [-q2, 0]));
  const q3 = r2[0] / b[0];
  return ddAdd(quickTwoSum(q1, q2), [q3, 0]);
}

function ddSqrt(a: number): DD {
  // one Newton step on the double root: x + (a - x^2) / (2 x)
  const x = Math.sqrt(a);
  const [p, e] = twoProd(x, x);
  const corr = (a - p - e) / (2 * x);
  return quickTwoSum(x, corr);
}

/** The orbit's period as a double-double (closed orbits only): 2 pi / (sqrt(mu) alpha^1.5). */
export function periodDD(o: Orbit): DD | null {
  if (o.period === null || !(o.alpha > 0)) return null;
  const sa = ddSqrt(o.alpha);
  const a15 = ddMul([o.alpha, 0], sa);
  const den = ddMul(ddSqrt(o.mu), a15);
  return ddDiv([TWO_PI_HI, TWO_PI_LO], den);
}

/**
 * Time of flight from the orbit's epoch tick to `tick`, reduced to (-P/2, P/2] for a closed orbit, s, computed
 * in double-double before it is rounded to a float64 (an open orbit: the plain tick difference / 120).
 */
export function reducedTimeOfFlight(o: Orbit, epochTick: number, tick: number): number {
  const D = tick - epochTick;
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(epochTick) || !Number.isSafeInteger(D)) throw new Error(`reducedTimeOfFlight: ticks must be safe integers (${epochTick}, ${tick})`);
  // D / 120 as a double-double: hi = D / 120 rounded, lo = (D - 120 hi) / 120 with 120 hi formed exactly
  const hi = D / TICKS_PER_SECOND;
  const [p, e] = twoProd(hi, TICKS_PER_SECOND);
  const lo = (D - p - e) / TICKS_PER_SECOND;
  const dt: DD = quickTwoSum(hi, lo);
  const P = periodDD(o);
  if (!P) return dt[0] + dt[1];
  const k = Math.round(dt[0] / P[0]);
  const kP = ddMul(P, [k, 0]);
  const red = ddAdd(dt, [-kP[0], -kP[1]]);
  let r = red[0] + red[1];
  const half = 0.5 * (P[0] + P[1]);
  if (r > half) r -= P[0] + P[1];
  else if (r <= -half) r += P[0] + P[1];
  return r;
}

/** Rails state at `tick` of an orbit whose epoch instant is `epochTick` (see the module comment). */
export function propagateAtTick(o: Orbit, epochTick: number, tick: number): StateVector {
  // propagate(o, t0, offset) evaluates the state at t0 + offset; the offset is already reduced
  return propagate(o, o.t0, reducedTimeOfFlight(o, epochTick, tick));
}
