/**
 * A vessel or docking-port target as the view shows it (ARCHITECTURE 21; `Readouts.target`, the navball's
 * target direction and relative markers, the directions the SAS target modes hold). The numbers are the
 * navigation functions' (src/sim/nav/target.ts); this says which two states they are given: centre of mass
 * to centre of mass, or port to port when the helm's control part is a docking port and a port is targeted.
 * Pure over the two vessels as the view reads them.
 */
import type { SasMode } from '@/core/contracts/controls';
import type { TargetRef } from '@/core/contracts/net';
import type { TargetReadout } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { comStateOf } from '../island/frames';
import { navballTargetVectors, vesselTargetReadout, type BodyState } from '../nav/target';
import type { ChainApproach } from '../orbit/chainApproach';
import { dockFace, findPartByKey, type Vessel } from '../vessel';
import type { ViewVessel } from './snapshot';

/** A selected vessel or port (a body target is the planner's `targetBodyId`). */
export interface TargetCraft {
  /** The target vessel's id as the snapshot states it. */
  vesselId: string;
  /** Part key (`craftId/instanceId`) of the targeted docking port; null = the vessel itself. */
  portId: string | null;
}

export const targetRefOf = (t: TargetCraft): TargetRef => (t.portId === null ? { kind: 'vessel', id: t.vesselId } : { kind: 'port', vesselId: t.vesselId, portId: t.portId });

/** The mating face of the docking port at part `index` of a vessel as a state in BCI of the vessel's body, with its outward axis (ROOT axes); null when the part is no port. */
function portState(v: Vessel, bodyId: string, index: number): { state: BodyState; axis: Vec3 } | null {
  const part = v.parts[index];
  const face = part ? dockFace(part) : null;
  if (!face) return null;
  return {
    state: { bodyId, r: v3.add(v.r, quat.rotate(v.q, face.pos)), v: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, face.pos))) },
    axis: quat.rotate(v.q, face.dir),
  };
}

/** The two states a target is measured between, and the port axes when there are ports. */
export interface TargetGeometry {
  own: BodyState;
  target: BodyState;
  /** Both a control port and a target port: the range is port to port. */
  portToPort: boolean;
  /** Outward axes (ROOT axes, unit) of the own control port and of the targeted port; null without one. */
  ownAxis: Vec3 | null;
  targetAxis: Vec3 | null;
}

export function targetGeometry(a: ViewVessel, t: ViewVessel, craft: TargetCraft): TargetGeometry {
  const ownPort = portState(a.vessel, a.bodyId, a.vessel.helm.controlPart);
  const targetPort = craft.portId === null ? null : portState(t.vessel, t.bodyId, findPartByKey(t.vessel, craft.portId));
  const portToPort = ownPort !== null && targetPort !== null;
  return {
    own: portToPort ? ownPort.state : { bodyId: a.bodyId, ...comStateOf(a.vessel) },
    target: portToPort ? targetPort.state : { bodyId: t.bodyId, ...comStateOf(t.vessel) },
    portToPort,
    ownAxis: ownPort ? ownPort.axis : null,
    targetAxis: targetPort ? targetPort.axis : null,
  };
}

/** `Readouts.target` for a vessel or port target (a single clock: the target is solid, at no time offset, with nothing to offer). */
export function craftTargetReadout(system: BodySystem, a: ViewVessel, t: ViewVessel, craft: TargetCraft, approaches: readonly ChainApproach[], ut: number): TargetReadout {
  const g = targetGeometry(a, t, craft);
  const v = a.vessel;
  const control = v.parts[v.helm.controlPart];
  return vesselTargetReadout({
    system,
    ut,
    own: g.own,
    qCtlToRoot: control ? quat.normalize(quat.mul(v.q, control.rot)) : v.q,
    ref: targetRefOf(craft),
    name: t.vessel.name,
    presence: 'solid',
    timeOffset: 0,
    target: g.target,
    closestApproaches: approaches,
    offer: null,
    portToPort: g.portToPort,
  });
}

/** The navball's direction to the target and the velocity relative to it (ROOT axes). */
export function craftTargetVectors(system: BodySystem, a: ViewVessel, t: ViewVessel, craft: TargetCraft, ut: number): { targetDir: Vec3 | null; relativeVelocity: Vec3 } {
  const g = targetGeometry(a, t, craft);
  return navballTargetVectors(system, g.own, g.target, ut);
}

/**
 * The direction (ROOT axes, unit) the vessel's nose is to hold in a SAS target mode: toward the target, away
 * from it, or, for 'portAlign', the nose direction at which the own control port's axis is anti-parallel to
 * the targeted port's (the smallest turn that brings it there, applied to the nose as it points now). Null
 * when the mode has nothing to hold (no port on one side, the target at the same point).
 */
export function craftTargetHold(system: BodySystem, mode: SasMode, a: ViewVessel, t: ViewVessel, craft: TargetCraft, ut: number): Vec3 | null {
  const g = targetGeometry(a, t, craft);
  if (mode === 'portAlign') {
    if (!g.ownAxis || !g.targetAxis) return null;
    const nose = quat.rotate(a.vessel.q, { x: 0, y: 1, z: 0 });
    return v3.normalize(quat.rotate(quat.fromTo(g.ownAxis, v3.neg(g.targetAxis)), nose));
  }
  const dir = navballTargetVectors(system, g.own, g.target, ut).targetDir;
  if (!dir) return null;
  return mode === 'target' ? dir : mode === 'antiTarget' ? v3.neg(dir) : null;
}
