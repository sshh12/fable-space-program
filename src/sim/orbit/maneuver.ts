/**
 * Maneuver nodes (docs/research/sim-design.md 3.5): node frame, inertial delta-v, burn-time estimate and
 * the NodeBurnInfo readout.
 *
 * Node frame at the pre-node state (r, v) in BCI of the patch body:
 *   prograde = v/|v|,  normal = (r x v)/|r x v|,  radial = prograde x normal (outward for a circular orbit).
 * Unit vectors are formed before crossing so a nearly radial velocity keeps full precision.
 */
import type { ManeuverNode, NodeBurnInfo } from '../../core/contracts/sim';
import { G0 } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';

export interface NodeFrame {
  prograde: Vec3;
  normal: Vec3;
  radial: Vec3;
}

/** Node frame of a state. Degenerate inputs (v = 0 or v parallel to r) get a deterministic orthonormal frame. */
export function nodeFrame(r: Vec3, v: Vec3): NodeFrame {
  const rHat = v3.normalize(r);
  const prograde = v3.len(v) > 0 ? v3.normalize(v) : rHat;
  let normal = v3.cross(rHat, prograde);
  normal = v3.len(normal) > 1e-12 ? v3.normalize(normal) : v3.anyOrthogonal(prograde);
  return { prograde, normal, radial: v3.cross(prograde, normal) };
}

/** Delta-v of a node in BCI axes, evaluated on the pre-node state (r, v) at node.ut. */
export function nodeDeltaVInertial(dv: ManeuverNode['dv'], r: Vec3, v: Vec3): Vec3 {
  const f = nodeFrame(r, v);
  return {
    x: f.prograde.x * dv.prograde + f.normal.x * dv.normal + f.radial.x * dv.radial,
    y: f.prograde.y * dv.prograde + f.normal.y * dv.normal + f.radial.y * dv.radial,
    z: f.prograde.z * dv.prograde + f.normal.z * dv.normal + f.radial.z * dv.radial,
  };
}

/** Components of an inertial delta-v vector in the node frame of (r, v). */
export function deltaVInNodeFrame(dvInertial: Vec3, r: Vec3, v: Vec3): ManeuverNode['dv'] {
  const f = nodeFrame(r, v);
  return { prograde: v3.dot(dvInertial, f.prograde), normal: v3.dot(dvInertial, f.normal), radial: v3.dot(dvInertial, f.radial) };
}

/**
 * Burn duration (s) for `dv` with engines of total vacuum thrust `thrust` (N) and specific impulse `isp`
 * (s) on a vessel of mass `mass` (kg): m1 = m0 exp(-dv/(Isp g0)), t = (m0 - m1)/mdot, mdot = F/(Isp g0).
 */
export function estimateBurnTime(dv: number, mass: number, thrust: number, isp: number): number {
  if (!(thrust > 0) || !(isp > 0) || !(mass > 0)) throw new Error('estimateBurnTime: thrust, isp and mass must be positive');
  const ve = isp * G0;
  const m1 = mass * Math.exp(-Math.abs(dv) / ve);
  return (mass - m1) / (thrust / ve);
}

/** Engine data for the burn estimate (the current, or else the next stage's, engines). */
export interface BurnEngine {
  /** Current vessel mass, kg. */
  mass: number;
  /** Total vacuum thrust of the engines that would fly the burn, N. */
  thrust: number;
  /** Their combined vacuum specific impulse, s. */
  isp: number;
  /** Delta-v the stage(s) can still provide, m/s (Infinity when not tracked). */
  availableDeltaV: number;
}

/**
 * NodeBurnInfo for the next node. `dvRemaining` is the world's bookkeeping vector (BCI = ROOT axes); before
 * the burn starts it is the node's inertial delta-v (nodeDeltaVInertial on the pre-node state).
 * `engine` null = no engine available (burnTime and timeToBurnStart null).
 */
export function nodeBurnInfo(node: ManeuverNode, dvRemaining: Vec3, ut: number, engine: BurnEngine | null): NodeBurnInfo {
  const mag = v3.len(dvRemaining);
  const burnTime = engine ? estimateBurnTime(mag, engine.mass, engine.thrust, engine.isp) : null;
  return {
    nodeId: node.id,
    dvRemaining: v3.clone(dvRemaining),
    dvRemainingMag: mag,
    burnTime,
    timeToBurnStart: burnTime === null ? null : node.ut - burnTime / 2 - ut,
    timeToNode: node.ut - ut,
    insufficientDeltaV: engine ? engine.availableDeltaV < mag : mag > 0,
  };
}
