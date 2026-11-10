/**
 * Kepler propagation for building synthetic map fixtures (time -> state on a conic). Test data only: the
 * map view itself never propagates anything; the simulation's predictor (src/sim/orbit) owns that.
 */
import { conicPosition, conicVelocity, type ConicElements } from '@/core/math/conic';
import { quat, type Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';

/** True anomaly at time t on conic c (elliptic: wrapped to (-pi, pi]). */
export function trueAnomalyAt(c: ConicElements, t: number): number {
  const e = c.e;
  if (e < 1) {
    const n = Math.sqrt(c.mu / (c.a * c.a * c.a));
    let M = n * (t - c.tPeriapsis);
    M = M - 2 * Math.PI * Math.round(M / (2 * Math.PI));
    let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
    for (let i = 0; i < 60; i++) {
      const f = E - e * Math.sin(E) - M;
      const d = f / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-15) break;
    }
    return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  }
  const aAbs = -c.a;
  const n = Math.sqrt(c.mu / (aAbs * aAbs * aAbs));
  const M = n * (t - c.tPeriapsis);
  let H = Math.asinh(M / e);
  for (let i = 0; i < 80; i++) {
    const f = e * Math.sinh(H) - H - M;
    const d = f / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-15 * Math.max(1, Math.abs(H))) break;
  }
  return 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(H / 2));
}

export function stateAt(c: ConicElements, t: number): { r: Vec3; v: Vec3; nu: number } {
  const nu = trueAnomalyAt(c, t);
  return { r: conicPosition(c, nu), v: conicVelocity(c, nu), nu };
}

/** State from classical elements (angles in rad) in the frame the elements refer to. */
export function stateFromElements(mu: number, a: number, e: number, inc: number, lan: number, argPe: number, nu: number): { r: Vec3; v: Vec3 } {
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const k = Math.sqrt(mu / p);
  const rp: Vec3 = { x: r * Math.cos(nu), y: r * Math.sin(nu), z: 0 };
  const vp: Vec3 = { x: -k * Math.sin(nu), y: k * (e + Math.cos(nu)), z: 0 };
  const q: Quat = quat.mul(quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, lan), quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, inc)), quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, argPe));
  return { r: quat.rotate(q, rp), v: quat.rotate(q, vp) };
}

/** Mean anomaly -> true anomaly (elliptic). */
export function meanToTrue(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 60; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-15) break;
  }
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}
