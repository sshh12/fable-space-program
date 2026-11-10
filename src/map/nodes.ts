/**
 * Locating maneuver nodes on the predicted trajectory and evaluating the node frame.
 *
 * A node is found, in this order, from (1) a 'maneuverNode' marker carrying its id (the sim places it on
 * the pre-node patch), (2) a patch ending at the node (endReason 'maneuver', tEnd = node.ut; for nodes
 * several revolutions ahead nuEnd is unwrapped and the node sits at nuEnd modulo 2 pi), (3) the patch that
 * starts at the node (afterNodeId). The frame is the one of the Patch contract: prograde = v/|v|,
 * normal = (r x v)/|r x v|, radial = prograde x normal (outward), on the pre-node conic at the node.
 */
import type { ManeuverNode, Patch, SimSnapshot } from '@/core/contracts/sim';
import { conicPosition, conicTrueAnomaly, conicVelocity } from '@/core/math/conic';
import { v3, type Vec3 } from '@/core/math/vec3';

export type PatchList = 'current' | 'planned';

export interface PatchKey {
  list: PatchList;
  index: number;
}

export interface NodeLocation {
  node: ManeuverNode;
  /** Patch the node lies on before its burn (the conic it slides along when dragged in time). */
  key: PatchKey;
  patch: Patch;
  /** True anomaly of the node on that patch's conic, in (-pi, pi]. */
  nu: number;
  /** Position relative to the patch body (BCI axes). */
  rBody: Vec3;
  /** Node frame (unit vectors, ROOT axes). */
  prograde: Vec3;
  normal: Vec3;
  radial: Vec3;
  /** True when the frame was taken from the post-node conic (no pre-node patch in the snapshot). */
  approximateFrame: boolean;
}

const UT_EPS = 1e-3;

export function nodeFrame(r: Vec3, v: Vec3): { prograde: Vec3; normal: Vec3; radial: Vec3 } {
  const prograde = v3.normalize(v);
  // Unit vectors first: crossing a large position with a near-parallel velocity loses precision.
  let normal = v3.cross(v3.normalize(r), prograde);
  normal = v3.len(normal) < 1e-9 ? v3.anyOrthogonal(prograde) : v3.normalize(normal);
  return { prograde, normal, radial: v3.cross(prograde, normal) };
}

/** Inertial delta-v (ROOT axes) of a node's components in its frame. */
export function nodeDvInertial(loc: Pick<NodeLocation, 'prograde' | 'normal' | 'radial'>, dv: ManeuverNode['dv']): Vec3 {
  return v3.add(v3.add(v3.scale(loc.prograde, dv.prograde), v3.scale(loc.normal, dv.normal)), v3.scale(loc.radial, dv.radial));
}

function lists(s: SimSnapshot): [PatchList, Patch[]][] {
  return [
    ['current', s.patches.current],
    ['planned', s.patches.planned],
  ];
}

export function locateNode(s: SimSnapshot, node: ManeuverNode): NodeLocation | null {
  // (1) marker with the node id on the pre-node patch
  for (const [list, patches] of lists(s)) {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      if (!(p.conic.p > 0)) continue; // radial (degenerate) conic: no node frame
      for (const m of p.markers) {
        if (m.kind !== 'maneuverNode' || m.nodeId !== node.id || m.bodyId !== p.bodyId) continue;
        const nu = conicTrueAnomaly(p.conic, m.r);
        const v = conicVelocity(p.conic, nu);
        return { node, key: { list, index: i }, patch: p, nu, rBody: m.r, ...nodeFrame(m.r, v), approximateFrame: false };
      }
    }
  }
  // (2) a patch ending at the node
  for (const [list, patches] of lists(s)) {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      if (p.endReason !== 'maneuver' || Math.abs(p.tEnd - node.ut) > UT_EPS || !(p.conic.p > 0)) continue;
      const nu = p.nuEnd;
      const r = conicPosition(p.conic, nu);
      const v = conicVelocity(p.conic, nu);
      return { node, key: { list, index: i }, patch: p, nu: wrap(nu), rBody: r, ...nodeFrame(r, v), approximateFrame: false };
    }
  }
  // (3) the patch starting at the node: position is continuous, the frame comes from the post-burn conic
  for (const [list, patches] of lists(s)) {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      if (p.afterNodeId !== node.id || Math.abs(p.tStart - node.ut) > UT_EPS || !(p.conic.p > 0)) continue;
      const nu = p.nuStart;
      const r = conicPosition(p.conic, nu);
      const vPost = conicVelocity(p.conic, nu);
      // Undo the burn approximately: frame of the post-burn velocity, then subtract the burn and re-derive.
      const f0 = nodeFrame(r, vPost);
      const vPre = v3.sub(vPost, nodeDvInertial(f0, node.dv));
      return { node, key: { list, index: i }, patch: p, nu: wrap(nu), rBody: r, ...nodeFrame(r, vPre), approximateFrame: true };
    }
  }
  return null;
}

const wrap = (a: number): number => {
  const r = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return r === -Math.PI ? Math.PI : r;
};
