/**
 * True anomaly <-> time on a patch, via timeSincePeriapsis (src/core/math/conic.ts). The map never
 * propagates a trajectory: it only converts a point the player picked on a drawn conic into the time the
 * vessel passes it, on the right revolution.
 */
import type { Patch } from '@/core/contracts/sim';
import { timeSincePeriapsis, type ConicElements } from '@/core/math/conic';
import { wrapPi } from '@/core/math/scalar';

const TWO_PI = 2 * Math.PI;

/** True when the patch is drawn as a full ellipse (one revolution or more). */
export const isFullRevolution = (p: Patch): boolean => p.conic.period !== null && p.nuEnd - p.nuStart >= TWO_PI - 1e-9;

/**
 * Time to go forward from true anomaly `nuFrom` to `nuTo` on conic `c`. Closed orbits: in [0, period).
 * Open conics: the signed time difference (negative when `nuTo` lies before `nuFrom`).
 */
export function forwardTime(c: ConicElements, nuFrom: number, nuTo: number): number {
  const dt = timeSincePeriapsis(c, wrapPi(nuTo)) - timeSincePeriapsis(c, wrapPi(nuFrom));
  if (c.period === null) return dt;
  const P = c.period;
  let r = dt - P * Math.floor(dt / P);
  if (r >= P) r -= P;
  return r;
}

/**
 * UT at which the vessel passes true anomaly `nu` on `patch`.
 * - Without `nearUt`: the first pass at or after the patch start (the revolution the player clicked on;
 *   a multi-revolution patch drawn as one ellipse resolves to its first lap).
 * - With `nearUt` (dragging a node along the orbit): the pass closest to `nearUt` on a closed orbit, so
 *   the node moves continuously across the start of the patch and across revolutions.
 */
export function utAtTrueAnomaly(patch: Patch, nu: number, nearUt?: number): number {
  const c = patch.conic;
  const base = patch.tStart + forwardTime(c, patch.nuStart, nu);
  if (c.period === null || nearUt === undefined) return base;
  const k = Math.round((nearUt - base) / c.period);
  return base + k * c.period;
}

/** Is `nu` (any wrapping) inside the drawn range of the patch? Full revolutions contain every anomaly. */
export function patchContainsAnomaly(patch: Patch, nu: number): boolean {
  if (isFullRevolution(patch)) return true;
  const span = patch.nuEnd - patch.nuStart;
  let d = nu - patch.nuStart;
  if (patch.conic.period !== null) d -= TWO_PI * Math.floor(d / TWO_PI);
  return d >= -1e-9 && d <= span + 1e-9;
}
