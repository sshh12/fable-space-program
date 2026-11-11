/**
 * Anomaly <-> time relations on a conic.
 *
 * The time-since-periapsis relation that stays well conditioned for every eccentricity (including the
 * near-parabolic band) is `timeFromPeriapsis` in src/core/math/conic.ts: one implementation for the sim
 * (tPeriapsis, event times) and for UI consumers of Patch.conic, which call it as `timeSincePeriapsis`
 * (request sim-orbits-3). It is re-exported here so sim code keeps importing it from the orbit package.
 */
export { atanhOverX, atanOverX, timeFromPeriapsis } from '../../core/math/conic';

/** Mean anomaly (rad, (-pi, pi]) of an ellipse (e < 1) at true anomaly `nu` in (-pi, pi]. */
export function meanAnomalyFromTrue(e: number, nu: number): number {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(0.5 * nu), Math.sqrt(1 + e) * Math.cos(0.5 * nu));
  return E - e * Math.sin(E);
}

/** True anomaly of an ellipse from its eccentric anomaly. */
export function trueFromEccentric(e: number, E: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(0.5 * E), Math.sqrt(1 - e) * Math.cos(0.5 * E));
}

/**
 * Eccentric anomaly of an ellipse for mean anomaly `M` (any value; result in the same revolution as M
 * reduced to (-pi, pi]). Newton iteration from a third-order starter, converged to machine precision.
 */
export function eccentricFromMean(e: number, M: number): number {
  const Mr = M - 2 * Math.PI * Math.floor((M + Math.PI) / (2 * Math.PI));
  let E = e < 0.8 ? Mr + e * Math.sin(Mr) : Mr >= 0 ? Math.PI : -Math.PI;
  for (let i = 0; i < 60; i++) {
    const f = E - e * Math.sin(E) - Mr;
    const fp = 1 - e * Math.cos(E);
    const fpp = e * Math.sin(E);
    // Halley step
    const d = f / (fp - (0.5 * f * fpp) / fp);
    E -= d;
    if (Math.abs(d) <= 1e-15 * Math.max(1, Math.abs(E))) break;
  }
  return E;
}
