/**
 * Splitting the part tree into separate vessels (decoupling, fairing panels, structural failure).
 * Each piece keeps exactly the rigid-body motion it had as part of the parent vessel (velocity of its own
 * origin, same angular velocity), so linear and angular momentum are conserved by construction; separation
 * impulses are added by the caller as equal and opposite velocity changes.
 */
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { cloneVessel, createPart, emptyVessel } from './assemble';
import { computeMassProps, partMass } from './massProps';
import { panelCentroid, panelRadial } from './structure';
import type { PartRuntime, PendingAction, StepContext, Vessel } from './types';

/** The panel kick acts this fraction of the panel height above its centroid (gives the outward hinge spin). */
export const PANEL_HINGE_ARM_FRACTION = 0.04;

/** Instance ids referenced by a stage action. */
export function actionParts(a: PendingAction['action']): string[] {
  return 'parts' in a ? a.parts : [a.part];
}

function baseId(id: string): string {
  const k = id.indexOf('~');
  return k < 0 ? id : id.slice(0, k);
}

/** Move the VES origin of `vessel` to the frame of part `rootIndex` (which must become index 0 afterwards). */
function reRoot(vessel: Vessel, root: PartRuntime): void {
  const rootPos = v3.clone(root.pos);
  const rootRot = quat.clone(root.rot);
  const identity = rootRot.x === 0 && rootRot.y === 0 && rootRot.z === 0;
  // Velocity of the new origin, then pose.
  const vRel = quat.rotate(vessel.q, v3.cross(vessel.w, rootPos));
  vessel.v = v3.add(vessel.v, vRel);
  vessel.r = v3.add(vessel.r, quat.rotate(vessel.q, rootPos));
  if (!identity) {
    vessel.q = quat.normalize(quat.mul(vessel.q, rootRot));
    vessel.w = quat.rotateInv(rootRot, vessel.w);
  }
  const inv = quat.conj(rootRot);
  for (const p of vessel.parts) {
    const d = v3.sub(p.pos, rootPos);
    if (identity) {
      p.pos = d;
    } else {
      p.pos = quat.rotate(inv, d);
      p.rot = quat.normalize(quat.mul(inv, p.rot));
    }
  }
  root.pos = v3.zero();
  if (!identity) root.rot = quat.identity();
  if (vessel.sas.hasTarget && !identity) vessel.sas.target = quat.normalize(quat.mul(vessel.sas.target, rootRot));
}

function hasCrew(parts: PartRuntime[]): boolean {
  return parts.some((p) => p.modules.some((m) => m.type === 'command' && m.crew > 0 && m.crewAlive));
}

function resetTransient(v: Vessel): void {
  v.struct = null;
  v.contact = { anyContact: false, maxForce: 0, waterSubmersion: 0 };
  v.groundClearance = Infinity;
  v.restTimer = 0;
  v.splashTimer = 0;
}

/**
 * Remove the joints between each part in `cut` and its parent, delete the parts in `removed`, and turn the
 * resulting connected components into vessels. `vessel` is mutated into the component that keeps the
 * identity (the one containing the old root; if the root is gone, the crewed one, else the heaviest).
 * Returns the newly created vessels (already appended to ctx.spawned).
 */
export function separateVessel(vessel: Vessel, cut: readonly number[], removed: readonly number[], ctx: StepContext): Vessel[] {
  const parts = vessel.parts;
  const n = parts.length;
  const comp = new Array<number>(n).fill(-1);
  const compParts: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (removed.includes(i)) continue;
    const par = parts[i]!.parent;
    if (par < 0 || cut.includes(i) || comp[par] === -1) {
      comp[i] = compParts.length;
      compParts.push([i]);
    } else {
      comp[i] = comp[par]!;
      compParts[comp[i]!]!.push(i);
    }
  }
  if (compParts.length === 0) {
    vessel.parts = [];
    vessel.destroyed = true;
    vessel.pending = [];
    resetTransient(vessel);
    return [];
  }
  let keeper = comp[0] !== undefined && comp[0] >= 0 ? comp[0] : -1;
  if (keeper < 0) {
    let bestMass = -1;
    for (let c = 0; c < compParts.length; c++) {
      const ps = compParts[c]!.map((i) => parts[i]!);
      if (hasCrew(ps)) {
        keeper = c;
        break;
      }
      const m = ps.reduce((s, p) => s + partMass(p), 0);
      if (m > bestMass) {
        bestMass = m;
        keeper = c;
      }
    }
  }
  if (compParts.length === 1 && removed.length === 0) return [];

  const template = cloneVessel(vessel);
  const created: Vessel[] = [];
  const base = baseId(vessel.id);
  const all: { vessel: Vessel; ids: Set<string> }[] = [];
  for (let c = 0; c < compParts.length; c++) {
    const idx = compParts[c]!;
    const remap = new Map<number, number>();
    idx.forEach((oldIndex, k) => remap.set(oldIndex, k));
    const target = c === keeper ? vessel : cloneVessel(template);
    const source = c === keeper ? parts : target.parts;
    const newParts = idx.map((oldIndex) => source[oldIndex]!);
    for (let k = 0; k < newParts.length; k++) {
      const p = newParts[k]!;
      const oldParent = parts[idx[k]!]!.parent;
      p.parent = k === 0 ? -1 : (remap.get(oldParent) ?? -1);
      if (k === 0) p.stress = 0;
    }
    target.parts = newParts;
    const root = newParts[0]!;
    if (root.pos.x !== 0 || root.pos.y !== 0 || root.pos.z !== 0 || root.rot.w !== 1) reRoot(target, root);
    resetTransient(target);
    if (c !== keeper) {
      target.id = `${base}~${root.instanceId}`;
      target.name = root.def.name;
      target.age = 0;
      target.stepCount = 0;
      target.hold = null;
      target.anchor = null;
      target.surface = 'none';
      target.sas.hasTarget = false;
      target.pending = [];
      target.gDose = 0;
      target.crewAlive = hasCrew(newParts) || !newParts.some((p) => p.modules.some((m) => m.type === 'command'));
      created.push(target);
    }
    all.push({ vessel: target, ids: new Set(newParts.map((p) => p.instanceId)) });
  }
  // Hand delayed actions to whichever piece now holds their parts.
  const pending = vessel.pending;
  vessel.pending = [];
  for (const pa of pending) {
    const ids = actionParts(pa.action);
    const owner = all.find((a) => ids.some((id) => a.ids.has(id)));
    if (owner) owner.vessel.pending.push(pa);
  }
  for (const a of all) computeMassProps(a.vessel);
  for (const v of created) ctx.spawned.push(v);
  return created;
}

/** Apply an instantaneous velocity change (BCI axes) to a whole vessel. */
export function applyImpulse(vessel: Vessel, jx: number, jy: number, jz: number): void {
  const m = vessel.mp.mass;
  if (!(m > 0)) return;
  vessel.v.x += jx / m;
  vessel.v.y += jy / m;
  vessel.v.z += jz / m;
}

/** Rigidly join `other` into `base` (used for launch clamps, which stay behind as one ground structure). */
export function mergeVessels(base: Vessel, other: Vessel): void {
  const rel = quat.rotateInv(base.q, v3.sub(other.r, base.r));
  const qRel = quat.normalize(quat.mul(quat.conj(base.q), other.q));
  const offset = base.parts.length;
  for (const p of other.parts) {
    p.pos = v3.add(rel, quat.rotate(qRel, p.pos));
    p.rot = quat.normalize(quat.mul(qRel, p.rot));
    p.parent = p.parent < 0 ? 0 : p.parent + offset;
    base.parts.push(p);
  }
  base.struct = null;
  computeMassProps(base);
}

/**
 * Turn the fairing part `index` of `vessel` into `panels` single-part debris vessels (instance id
 * `<id>#panel<k>`, def = the fairing def, posed at the fairing's part frame) and remove it from the vessel.
 * Each panel gets a radial velocity `impulse / panelMass` and an outward hinge spin.
 */
export function jettisonPanels(vessel: Vessel, index: number, panels: number, impulse: number, ctx: StepContext): Vessel[] {
  const part = vessel.parts[index]!;
  const out: Vessel[] = [];
  const base = baseId(vessel.id);
  // Motion of the fairing's part frame.
  const framePos = v3.add(vessel.r, quat.rotate(vessel.q, part.pos));
  const frameVel = v3.add(vessel.v, quat.rotate(vessel.q, v3.cross(vessel.w, part.pos)));
  const frameQ = quat.normalize(quat.mul(vessel.q, part.rot));
  const frameW = quat.rotateInv(part.rot, vessel.w);
  for (let k = 0; k < panels; k++) {
    const v = emptyVessel(`${base}~${part.instanceId}#panel${k}`, `${part.def.name} panel ${k + 1}`, vessel.vehicle);
    const p = createPart(`${part.instanceId}#panel${k}`, part.def, part.stageGroup);
    p.panel = { index: k, count: panels };
    p.temps = part.temps.slice();
    p.resources = part.resources.map((x) => x / panels);
    for (const m of p.modules) if (m.type === 'fairing') m.jettisoned = true;
    v.parts.push(p);
    v.r = v3.clone(framePos);
    v.q = quat.clone(frameQ);
    v.w = v3.clone(frameW);
    v.v = v3.clone(frameVel);
    v.nextStage = vessel.nextStage;
    computeMassProps(v);
    // Radial kick through a point above the panel centroid: the panel translates outward and its top leads.
    const radial = panelRadial(k, panels);
    const m = v.mp.mass;
    if (m > 0 && impulse !== 0) {
      const dv = quat.rotate(v.q, v3.scale(radial, impulse / m));
      const h = p.def.bounds.yMax - p.def.bounds.yMin;
      const arm = PANEL_HINGE_ARM_FRACTION * h;
      // Angular impulse about the CoM: (arm * Y) x (impulse * radial), in the panel (= vessel) frame.
      const L = v3.scale(v3.cross({ x: 0, y: arm, z: 0 }, radial), impulse);
      const I = v.mp.inv;
      const dw = {
        x: I[0] * L.x + I[3] * L.y + I[4] * L.z,
        y: I[3] * L.x + I[1] * L.y + I[5] * L.z,
        z: I[4] * L.x + I[5] * L.y + I[2] * L.z,
      };
      v.w = v3.add(v.w, dw);
      // Keep the CoM velocity change equal to dv: the origin moves with the CoM plus w x r.
      const c = panelCentroid(p.def, k, panels);
      v.v = v3.sub(v3.add(v.v, dv), quat.rotate(v.q, v3.cross(dw, c)));
    }
    out.push(v);
  }
  separateVessel(vessel, [], [index], ctx);
  for (const v of out) ctx.spawned.push(v);
  return out;
}
