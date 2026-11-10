/**
 * Body orientation (docs/ARCHITECTURE.md section 3, sim-design 2.2):
 *
 *   R(BCBF -> BCI) = Rz(alpha0 + 90 deg) Rx(90 deg - delta0) Rz(W),   W = W0 + rate (ut - epoch)
 *
 *  - 'fixedRate': W0 = w0Deg at epochUt, rate = rateDegPerDay.
 *  - 'tidalLock': rate = the body's orbital mean motion n, epoch = the orbit epoch, and W0 is solved so
 *    that at the epoch the body-fixed +X axis points at the projection onto the body's equator of the
 *    direction to the parent at the MEAN position (mean anomaly used as true anomaly). Result: true
 *    synchronous rotation with the natural optical libration of an eccentric, inclined orbit.
 *  - 'none': BCBF axes = BCI axes, no spin.
 */
import type { RotationDef } from '../../core/contracts/defs';
import { quat, type Quat } from '../../core/math/quat';
import { DEG, TWO_PI } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { KeplerEphemeris } from './ephemeris';

/** Uniform rotation model W(t) = w0 + rate (t - epoch) about a fixed pole (rad, rad/s). */
export interface UniformRotation {
  kind: 'uniform';
  /** Rz(alpha0 + 90) Rx(90 - delta0): pole frame -> BCI. */
  qPole: Quat;
  /** Unit spin axis (BCBF +Z) in BCI axes. */
  pole: Vec3;
  /** Prime-meridian angle at `epoch`, rad. */
  w0: number;
  /** rad/s */
  rate: number;
  epoch: number;
}
export type RotationModel = UniformRotation | { kind: 'none' };

export function poleQuat(poleRaDeg: number, poleDecDeg: number): Quat {
  const qa = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, (poleRaDeg + 90) * DEG);
  const qd = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, (90 - poleDecDeg) * DEG);
  return quat.mul(qa, qd);
}

/**
 * Build the rotation model. `orbit` (the body's own Kepler ephemeris about its parent) is required for
 * 'tidalLock'.
 */
export function rotationModel(def: RotationDef, orbit: KeplerEphemeris | null, bodyId: string): RotationModel {
  if (def.mode === 'none') return { kind: 'none' };
  const qPole = poleQuat(def.poleRaDeg, def.poleDecDeg);
  const pole = quat.rotate(qPole, { x: 0, y: 0, z: 1 });
  if (def.mode === 'fixedRate') {
    const rate = (def.rateDegPerDay * DEG) / 86400;
    return { kind: 'uniform', qPole, pole, w0: (def.w0Deg % 360) * DEG, rate, epoch: def.epochUt };
  }
  if (!orbit) throw new Error(`bodies/${bodyId}.json: rotation 'tidalLock' needs a 'kepler' orbit`);
  // Mean direction to the parent at the orbit epoch: true anomaly := mean anomaly.
  const M0 = orbit.M0;
  const toParent = v3.neg(v3.add(v3.scale(orbit.P, Math.cos(M0)), v3.scale(orbit.Q, Math.sin(M0))));
  const xPole = quat.rotate(qPole, { x: 1, y: 0, z: 0 });
  const yPole = quat.rotate(qPole, { x: 0, y: 1, z: 0 });
  const w0 = Math.atan2(v3.dot(toParent, yPole), v3.dot(toParent, xPole));
  return { kind: 'uniform', qPole, pole, w0, rate: orbit.n, epoch: orbit.epochUt };
}

/** Prime-meridian angle W(ut) reduced to [0, 2 pi). */
export function primeMeridianAngle(m: UniformRotation, ut: number): number {
  const W = m.w0 + m.rate * (ut - m.epoch);
  return W - TWO_PI * Math.floor(W / TWO_PI);
}

/** BCBF -> BCI orientation at ut. */
export function orientationAt(m: RotationModel, ut: number): Quat {
  if (m.kind === 'none') return quat.identity();
  const W = primeMeridianAngle(m, ut);
  const h = 0.5 * W;
  const qw: Quat = { x: 0, y: 0, z: Math.sin(h), w: Math.cos(h) };
  return quat.mul(m.qPole, qw);
}

/** Spin vector in BCI axes, rad/s. */
export function spinVector(m: RotationModel): Vec3 {
  return m.kind === 'none' ? v3.zero() : v3.scale(m.pole, m.rate);
}
