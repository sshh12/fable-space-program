/**
 * The state of a docking port as data (docs/ARCHITECTURE.md 7.5; docs/research/v2/fleet-docking.md 3.1-3.3):
 * a part with a `dockingPort` module (DockingPortModuleDef) carries a module state (DockingPortState) that
 * says whether the port is armed and whether it can take a capture now. A part may carry more than one port
 * (the H-C adapter has a face of each type); each module has its own face node and its own state.
 *
 *   'hard'      a docked joint: the vessel holds a dock link on this face (a pair mated in the vehicle file,
 *               or a hard dock later); `peer` names the port part at the other end;
 *   'occupied'  a part of the vessel stands on the port's mating face (the escape tower on the crew ferry's
 *               port, a cover): nothing can dock to it until that part is gone;
 *   'disabled'  not armed by its owner, or shielded by a closed fairing;
 *   'ready'     armed, free and exposed: a capture is possible;
 *   'soft', 'cooldown'  set by the capture and undock logic (contact-docking, next wave) and kept here.
 *
 * What makes a port 'occupied', 'hard' or 'disabled' is read from the vessel itself (its tree, its dock
 * links, the fairing shielding of `PartRuntime.shielded`), so `refreshPortStates` brings the stored state
 * back into agreement after any structural change: at assembly, after a stage fires, after a split or a
 * merge. Arming is the owner's command (`armPort`) and persists. Pure functions of the vessel.
 */
import type { DockingPortModuleDef } from '@/core/contracts/defs';
import type { DockingPortState, ModuleState } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { DockLink, PartRuntime, Vessel } from '../types';

/** Two faces closer than this (m) are one joint: nodes the assembler mated coincide to rounding. */
const SAME_POINT = 1e-3;

/** The docking-port modules of a part with their module indices (empty for a part without a port). */
export function portModulesOf(part: PartRuntime): { module: DockingPortModuleDef; index: number }[] {
  const out: { module: DockingPortModuleDef; index: number }[] = [];
  const modules = part.def.modules as readonly { type: string }[];
  for (let m = 0; m < modules.length; m++) if (modules[m]!.type === 'dockingPort') out.push({ module: modules[m] as DockingPortModuleDef, index: m });
  return out;
}

/** The stored state of module `index` of a part, which must be a docking port. */
export function portStateAt(part: PartRuntime, index: number): DockingPortState {
  const s = part.modules[index] as unknown as DockingPortState | undefined;
  if (!s || s.type !== 'dockingPort') throw new Error(`part "${part.instanceId}": module ${index} is not a docking port`);
  return s;
}

/** The state a port module starts with: disarmed and free (refreshPortStates fills in what the vessel says). */
export function initialPortState(): DockingPortState {
  return { type: 'dockingPort', state: 'disabled', armed: false, peer: null, progress: 0 };
}

/** The same port state as a member of the part's module-state list (the list's element type does not name the port yet: request fleet-data-1). */
export function asModuleState(state: DockingPortState): ModuleState {
  return state as unknown as ModuleState;
}

/** A point of a part's frame in the vessel frame. */
function pointOf(p: PartRuntime, local: readonly [number, number, number]): Vec3 {
  return v3.add(p.pos, quat.rotate(p.rot, v3.fromTuple(local)));
}

/** The face point of port module `module` of part `part` in the vessel frame. */
function facePoint(part: PartRuntime, module: DockingPortModuleDef): Vec3 {
  const node = part.def.attachNodes.find((n) => n.id === module.node);
  if (!node) throw new Error(`part "${part.instanceId}" (${part.def.id}): its docking port names the attach node "${module.node}", which the part does not have`);
  return pointOf(part, node.pos);
}

/** Whether one of part `other`'s attach nodes sits on the point (the joint between the two is made there). */
function nodeAt(other: PartRuntime, point: Vec3): boolean {
  for (const n of other.def.attachNodes) if (v3.dist(pointOf(other, n.pos), point) < SAME_POINT) return true;
  return false;
}

/** What the vessel says about the port of module `index` of part `partIndex`. */
export interface PortConditions {
  armed: boolean;
  shielded: boolean;
  /** Instance id of the part of the same tree that stands on the mating face (a stacked part), else null. */
  occupiedBy: string | null;
  /** The dock link made on this face, else null. */
  link: DockLink | null;
}

export function portConditions(vessel: Vessel, partIndex: number, index: number): PortConditions {
  const part = vessel.parts[partIndex]!;
  const module = part.def.modules[index] as unknown as DockingPortModuleDef;
  const state = portStateAt(part, index);
  const face = facePoint(part, module);
  let link: DockLink | null = null;
  for (const l of vessel.links) {
    if (l.a !== partIndex && l.b !== partIndex) continue;
    if (nodeAt(vessel.parts[l.a === partIndex ? l.b : l.a]!, face)) link = l;
  }
  let occupiedBy: string | null = null;
  if (link === null) {
    // A tree neighbour (a child, or the parent) whose joint is made on the face.
    for (let i = 0; i < vessel.parts.length && occupiedBy === null; i++) {
      const p = vessel.parts[i]!;
      if ((p.parent === partIndex || part.parent === i) && nodeAt(p, face)) occupiedBy = p.instanceId;
    }
  }
  return { armed: state.armed, shielded: part.shielded, occupiedBy, link };
}

/** The state the vessel's structure gives a port, keeping a capture's 'soft' and an undock's 'cooldown'. */
export function derivedPortState(vessel: Vessel, partIndex: number, index: number): DockingPortState['state'] {
  const c = portConditions(vessel, partIndex, index);
  const stored = portStateAt(vessel.parts[partIndex]!, index).state;
  if (c.link) return 'hard';
  if (stored === 'soft' || stored === 'cooldown') return stored;
  if (c.occupiedBy !== null) return 'occupied';
  if (!c.armed || c.shielded) return 'disabled';
  return 'ready';
}

/**
 * Bring the stored state of every port of the vessel into agreement with its structure: the state, and the
 * peer of a docked joint (vessel id and part key of the port at the other end; both ends are in this vessel).
 */
export function refreshPortStates(vessel: Vessel): void {
  for (let i = 0; i < vessel.parts.length; i++) {
    const part = vessel.parts[i]!;
    for (const { index } of portModulesOf(part)) {
      const state = portStateAt(part, index);
      const c = portConditions(vessel, i, index);
      state.state = derivedPortState(vessel, i, index);
      if (c.link) {
        const other = vessel.parts[c.link.a === i ? c.link.b : c.link.a]!;
        state.peer = { vesselId: vessel.id, partKey: `${vessel.crafts[other.craft]!.craftId}/${other.instanceId}` };
      } else if (state.state !== 'soft') state.peer = null;
      if (state.state !== 'soft') state.progress = 0;
    }
  }
}

/** Arm or disarm every port of part `partIndex` (its owner's command; it persists). Returns false for a part without a port. */
export function armPort(vessel: Vessel, partIndex: number, armed: boolean): boolean {
  const part = vessel.parts[partIndex]!;
  const ports = portModulesOf(part);
  for (const { index } of ports) {
    portStateAt(part, index).armed = armed;
    portStateAt(part, index).state = derivedPortState(vessel, partIndex, index);
  }
  return ports.length > 0;
}
