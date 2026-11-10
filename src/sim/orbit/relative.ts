/**
 * Relative geometry between an orbit and a target plane (docs/research/sim-design.md 3.6): relative
 * inclination, and the true anomalies of the ascending / descending nodes on the target's orbit plane.
 */
import type { ConicElements } from '../../core/math/conic';
import { v3, type Vec3 } from '../../core/math/vec3';

/** Angle between two orbit normals, rad in [0, pi]. */
export const relativeInclination = (normalA: Vec3, normalB: Vec3): number => v3.angle(normalA, normalB);

export interface PlaneNodes {
  relativeInclination: number;
  /** True anomalies on `conic` where it crosses the target plane going toward +targetNormal (AN) / away (DN). */
  nuAscending: number;
  nuDescending: number;
  /** Unit direction of the ascending node (targetNormal x orbitNormal). */
  ascendingDir: Vec3;
}

/**
 * AN/DN of `conic` relative to the plane with unit normal `targetNormal`. Null when the planes coincide
 * (relative inclination below 1e-9 rad: nodes undefined).
 */
export function nodesVersusPlane(conic: ConicElements, targetNormal: Vec3): PlaneNodes | null {
  const inc = relativeInclination(conic.W, targetNormal);
  const line = v3.cross(v3.normalize(targetNormal), conic.W);
  if (!(v3.len(line) > 1e-9)) return null;
  const an = v3.normalize(line);
  const nuA = Math.atan2(v3.dot(an, conic.Q), v3.dot(an, conic.P));
  const nuD = nuA > 0 ? nuA - Math.PI : nuA + Math.PI;
  return { relativeInclination: inc, nuAscending: nuA, nuDescending: nuD, ascendingDir: an };
}
