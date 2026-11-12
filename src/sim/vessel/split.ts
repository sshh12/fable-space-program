/**
 * Splitting a vessel into separate vessels (decoupling, undocking, fairing panels, structural failure).
 * The parts form a forest (each craft its own tree) plus dock links; the pieces are the connected
 * components over tree edges AND links. Each piece keeps exactly the rigid-body motion it had as part of
 * the parent vessel (velocity of its own origin, same angular velocity), so linear and angular momentum are
 * conserved by construction; separation impulses are added by the caller as equal and opposite velocity
 * changes.
 */
import { TICKS_PER_SECOND } from '@/core/contracts/net';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { cloneVessel, createPart, defaultControlPart, emptyVessel } from './assemble';
import { ASSEMBLY_ID_PREFIX, craftRootInstanceId, pieceCraft, singleCraftVesselId } from './ids';
import { computeMassProps, partMass } from './massProps';
import { invalidateStructure, panelCentroid, panelRadial } from './structure';
import type { CraftRuntime, DockLink, PartRuntime, PendingAction, StepContext, Vessel } from './types';

/** The panel kick acts this fraction of the panel height above its centroid (gives the outward hinge spin). */
export const PANEL_HINGE_ARM_FRACTION = 0.04;

/** Instance ids referenced by a stage action. */
export function actionParts(a: PendingAction['action']): string[] {
  return 'parts' in a ? a.parts : [a.part];
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

/**
 * Display name of a separated piece: the label of its heaviest flow group, or the part's own name for one or
 * two parts. `parts` are the piece's parts (their `craft` indexes `pieceCrafts`, which lists indices into `crafts`).
 */
function pieceName(crafts: readonly CraftRuntime[], parts: PartRuntime[], pieceCrafts: readonly number[]): string {
  const root = parts[0]!;
  if (parts.length <= 2) return root.def.name;
  // A flow group is (craft, stage group): a group of one craft never adds to the same label of another.
  const byGroup = new Map<string, { craft: number; group: string; mass: number }>();
  for (const p of parts) {
    const key = pieceCrafts.length === 1 ? p.stageGroup : `${p.craft}/${p.stageGroup}`;
    const g = byGroup.get(key);
    if (g) g.mass += partMass(p);
    else byGroup.set(key, { craft: p.craft, group: p.stageGroup, mass: partMass(p) });
  }
  let best = { craft: root.craft, group: root.stageGroup };
  let bestMass = -1;
  for (const g of byGroup.values()) {
    if (g.mass > bestMass) {
      best = g;
      bestMass = g.mass;
    }
  }
  return crafts[pieceCrafts[best.craft]!]!.vehicle.stageGroups.find((g) => g.id === best.group)?.label ?? root.def.name;
}

function hasCrew(parts: readonly PartRuntime[]): boolean {
  return parts.some((p) => p.modules.some((m) => m.type === 'command' && m.crew > 0 && m.crewAlive));
}

/**
 * The crew flag of a vessel made of `parts`: true while a crewed command part aboard has its crew alive,
 * and true when no command part aboard is crewed (nobody to lose). It is derived from the command parts
 * wherever the part set changes (a separation, a dock, an undock), never carried over from the vessel the
 * parts came from: a live crew does not die by docking to a wreck, and is itself again after undocking.
 */
export function crewAliveOf(parts: readonly PartRuntime[]): boolean {
  return hasCrew(parts) || !parts.some((p) => p.modules.some((m) => m.type === 'command' && m.crew > 0));
}

/**
 * The g dose a vessel made of `parts` shows: the largest among its crewed command parts whose crew is
 * alive; when no crew aboard is alive, the largest among its crewed command parts (the dose that was
 * fatal stays readable); 0 without a crewed command part.
 */
export function gDoseOf(parts: readonly PartRuntime[]): number {
  let live = -1;
  let any = 0;
  for (const p of parts) {
    const c = p.command;
    if (!c) continue;
    const m = p.modules[c.module];
    if (!m || m.type !== 'command' || m.crew <= 0) continue;
    if (c.gDose > any) any = c.gDose;
    if (m.crewAlive && c.gDose > live) live = c.gDose;
  }
  return live >= 0 ? live : any;
}

function resetTransient(v: Vessel): void {
  invalidateStructure(v);
  v.contact = { anyContact: false, maxForce: 0, waterSubmersion: 0 };
  v.groundClearance = Infinity;
  v.restTimer = 0;
  v.splashTimer = 0;
}

/**
 * Connected components of the parts that remain, over tree edges (minus the cut ones) and dock links. The
 * components are listed in the order of their first part, each with its parts in index order.
 */
function components(parts: readonly PartRuntime[], links: readonly DockLink[], cut: readonly number[], removed: readonly number[]): number[][] {
  const n = parts.length;
  const leader = new Array<number>(n);
  for (let i = 0; i < n; i++) leader[i] = i;
  const find = (i: number): number => {
    while (leader[i] !== i) {
      leader[i] = leader[leader[i]!]!;
      i = leader[i]!;
    }
    return i;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    // The lower index leads, so a component is known by its first part.
    if (ra < rb) leader[rb] = ra;
    else if (rb < ra) leader[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    if (removed.includes(i)) continue;
    const par = parts[i]!.parent;
    if (par >= 0 && !cut.includes(i) && !removed.includes(par)) join(i, par);
  }
  for (const l of links) if (!removed.includes(l.a) && !removed.includes(l.b)) join(l.a, l.b);
  const index = new Map<number, number>();
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (removed.includes(i)) continue;
    const lead = find(i);
    let c = index.get(lead);
    if (c === undefined) {
      c = out.length;
      index.set(lead, c);
      out.push([]);
    }
    out[c]!.push(i);
  }
  return out;
}

/** The helm of a piece that did not keep the old one: vacant, on the first craft that has a command part. */
function vacantHelm(v: Vessel): Vessel['helm'] {
  let craft = 0;
  for (let c = 0; c < v.crafts.length; c++) {
    if (v.parts.some((p) => p.craft === c && p.command !== null)) {
      craft = c;
      break;
    }
  }
  return { accountId: null, craft, controlPart: defaultControlPart(v, craft) };
}

/**
 * Remove the joints between each part in `cut` and its parent, delete the parts in `removed`, and turn the
 * resulting connected components (over tree edges and dock links) into vessels. `vessel` is mutated into
 * the component that keeps the identity (the one containing the old root; if the root is gone, the crewed
 * one, else the heaviest). Returns the newly created vessels (already appended to ctx.spawned).
 *
 * Craft: a craft stays with the piece that holds its root part (with the identity-keeping piece when no
 * piece holds it): that piece keeps the craft's id and its live stage stack. Every other piece that takes
 * parts of the craft away is a NEW craft (ids.ts, pieceCraft: a copy of the stage state, an id derived from
 * the parent's, the lineage recorded), so a craft id never appears in two vessels. Vessel ids: a piece of
 * one craft has the craft's own vessel id (the craft id of a launched craft; for a piece craft
 * `<launched craft>~<instance id of its root part>`, the form a piece always had); of the pieces with two
 * or more craft the one with the most craft (tie: the lowest craft id) keeps the assembly id, the others
 * are `a~<their lowest craft id>~<tick>`. The helm stays with the piece that holds its control part. The
 * crew flag and the shown g dose of every piece are derived from the command parts it has.
 */
export function separateVessel(vessel: Vessel, cut: readonly number[], removed: readonly number[], ctx: StepContext): Vessel[] {
  const parts = vessel.parts;
  const compParts = components(parts, vessel.links, cut, removed);
  if (compParts.length === 0) {
    vessel.parts = [];
    vessel.links = [];
    vessel.destroyed = true;
    for (const c of vessel.crafts) c.pending = [];
    resetTransient(vessel);
    return [];
  }
  let keeper = compParts.findIndex((idx) => idx[0] === 0);
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
  if (compParts.length === 1 && removed.length === 0) {
    // Nothing separates. A joint cut inside a loop of links is cut all the same: its part becomes a root.
    for (const i of cut) {
      if (parts[i]!.parent < 0) continue;
      parts[i]!.parent = -1;
      parts[i]!.stress = 0;
      invalidateStructure(vessel);
    }
    return [];
  }

  const oldCrafts = vessel.crafts;
  const oldLinks = vessel.links;
  const oldHelm = vessel.helm;
  const oldId = vessel.id;
  const wasAssembly = oldCrafts.length > 1;
  const wasCrewAlive = vessel.crewAlive;
  const keptDose = vessel.gDose;
  const tick = Math.round(ctx.ut * TICKS_PER_SECOND);
  // Craft and parent of every part as they are now (the parts of the identity-keeping piece are edited in place below).
  const craftOf = parts.map((p) => p.craft);
  const parentOf = parts.map((p) => p.parent);

  // Which piece holds each craft's root part (and so its live record).
  const rootIds = oldCrafts.map(craftRootInstanceId);
  const rootHolder = oldCrafts.map((_, ci) => compParts.findIndex((idx) => idx.some((i) => craftOf[i] === ci && parts[i]!.instanceId === rootIds[ci])));
  const craftsOf = compParts.map((idx) => [...new Set(idx.map((i) => craftOf[i]!))].sort((a, b) => a - b));
  const recordHolder = oldCrafts.map((_, ci) => {
    if (rootHolder[ci]! >= 0) return rootHolder[ci]!;
    if (craftsOf[keeper]!.includes(ci)) return keeper;
    return craftsOf.findIndex((cs) => cs.includes(ci));
  });

  // Of the pieces with two or more craft, the one that keeps the assembly id.
  let assemblyKeeper = -1;
  if (wasAssembly) {
    for (let c = 0; c < compParts.length; c++) {
      const cs = craftsOf[c]!;
      if (cs.length < 2) continue;
      if (assemblyKeeper < 0) {
        assemblyKeeper = c;
        continue;
      }
      const best = craftsOf[assemblyKeeper]!;
      const lowest = (list: number[]): string => list.map((ci) => oldCrafts[ci]!.craftId).sort()[0]!;
      if (cs.length > best.length || (cs.length === best.length && lowest(cs) < lowest(best))) assemblyKeeper = c;
    }
  }

  const template = cloneVessel(vessel);
  const created: Vessel[] = [];
  const all: { vessel: Vessel; comp: number; crafts: number[] }[] = [];
  for (let c = 0; c < compParts.length; c++) {
    const idx = compParts[c]!;
    const remap = new Map<number, number>();
    idx.forEach((oldIndex, k) => remap.set(oldIndex, k));
    const target = c === keeper ? vessel : cloneVessel(template);
    const source = c === keeper ? parts : target.parts;
    const newParts = idx.map((oldIndex) => source[oldIndex]!);
    const crafts = craftsOf[c]!;
    for (let k = 0; k < newParts.length; k++) {
      const p = newParts[k]!;
      const oldIndex = idx[k]!;
      const oldParent = parentOf[oldIndex]!;
      p.parent = k === 0 || cut.includes(oldIndex) ? -1 : (remap.get(oldParent) ?? -1);
      if (k === 0 || (p.parent === -1 && oldParent >= 0)) p.stress = 0;
      p.craft = crafts.indexOf(craftOf[oldIndex]!);
    }
    target.parts = newParts;
    target.links = oldLinks.filter((l) => remap.has(l.a) && remap.has(l.b)).map((l) => ({ a: remap.get(l.a)!, b: remap.get(l.b)!, roll: l.roll }));
    // The craft goes with the piece that holds its root; what another piece takes away is a new craft.
    target.crafts = crafts.map((ci, k) => {
      if (recordHolder[ci] === c) return oldCrafts[ci]!;
      const first = newParts.find((p) => p.craft === k)!;
      return pieceCraft(oldCrafts[ci]!, first.instanceId, tick);
    });
    const root = newParts[0]!;
    if (root.pos.x !== 0 || root.pos.y !== 0 || root.pos.z !== 0 || root.rot.w !== 1) reRoot(target, root);
    resetTransient(target);
    // Identity.
    if (crafts.length >= 2) target.id = c === assemblyKeeper ? oldId : `${ASSEMBLY_ID_PREFIX}${target.crafts.map((x) => x.craftId).sort()[0]!}~${tick}`;
    else if (c !== keeper || wasAssembly) target.id = singleCraftVesselId(target.crafts[0]!);
    // The helm stays with the piece that holds its control part.
    const control = remap.get(oldHelm.controlPart);
    if (control !== undefined) target.helm = { accountId: oldHelm.accountId, craft: Math.max(0, crafts.indexOf(oldHelm.craft)), controlPart: control };
    else {
      target.helm = vacantHelm(target);
      // A piece of an assembly that the helm did not go with has its throttle closed. (A piece of a single
      // craft keeps the lever it inherits for the one step until it is stepped with its own controls, as before.)
      if (wasAssembly) target.throttle = 0;
    }
    if (c !== keeper) {
      target.name = pieceName(oldCrafts, newParts, crafts);
      target.age = 0;
      target.stepCount = 0;
      target.hold = null;
      target.anchor = null;
      target.surface = 'none';
      target.sas.hasTarget = false;
      created.push(target);
    } else if (wasAssembly && crafts.length === 1) target.name = target.crafts[0]!.name;
    // Crew: what the command parts of this piece say. The identity-keeping piece of a vessel that had
    // lost its crew stays so unless a live crew is aboard it (a crewed part that was destroyed leaves no
    // command part behind to say it).
    target.crewAlive = c === keeper && !wasCrewAlive ? hasCrew(newParts) : crewAliveOf(newParts);
    target.gDose = c === keeper && newParts.every((p) => p.command === null) ? keptDose : gDoseOf(newParts);
    all.push({ vessel: target, comp: c, crafts });
  }
  // Hand delayed actions to whichever piece now holds their parts.
  for (let ci = 0; ci < oldCrafts.length; ci++) {
    const record = oldCrafts[ci]!;
    const pending = record.pending;
    record.pending = [];
    for (const pa of pending) {
      const ids = actionParts(pa.action);
      const owner = all.find((a) => a.crafts.includes(ci) && compParts[a.comp]!.some((i) => craftOf[i] === ci && ids.includes(parts[i]!.instanceId)));
      if (owner) owner.vessel.crafts[owner.crafts.indexOf(ci)]!.pending.push(pa);
    }
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

/**
 * Weld `other` into `base`: the released launch clamps, which stay behind as ONE held ground structure.
 * This is not a dock: the pieces have no ports (the component pass would split them again) and the weld
 * carries no momentum, because the result is held on the ground. Both vessels must be pieces that left the
 * SAME craft (siblings of one lineage parent); each part of `other` hangs on the base's root and becomes a
 * part of the base's craft, and the craft of `other` ends there (its id is not used again).
 */
export function mergeVessels(base: Vessel, other: Vessel): void {
  const a = base.crafts[0];
  const b = other.crafts[0];
  if (base.crafts.length !== 1 || other.crafts.length !== 1 || !a || !b || a.parent === null || a.parent !== b.parent || a.craftId === b.craftId) {
    throw new Error(`mergeVessels welds pieces that left one craft (got ${base.crafts.map((c) => c.craftId).join('+')} and ${other.crafts.map((c) => c.craftId).join('+')}); two craft are joined by dockMerge`);
  }
  const rel = quat.rotateInv(base.q, v3.sub(other.r, base.r));
  const qRel = quat.normalize(quat.mul(quat.conj(base.q), other.q));
  const offset = base.parts.length;
  for (const p of other.parts) {
    p.pos = v3.add(rel, quat.rotate(qRel, p.pos));
    p.rot = quat.normalize(quat.mul(qRel, p.rot));
    p.parent = p.parent < 0 ? 0 : p.parent + offset;
    p.craft = 0;
    base.parts.push(p);
  }
  invalidateStructure(base);
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
  const craft = vessel.crafts[part.craft]!;
  // Motion of the fairing's part frame.
  const framePos = v3.add(vessel.r, quat.rotate(vessel.q, part.pos));
  const frameVel = v3.add(vessel.v, quat.rotate(vessel.q, v3.cross(vessel.w, part.pos)));
  const frameQ = quat.normalize(quat.mul(vessel.q, part.rot));
  const frameW = quat.rotateInv(part.rot, vessel.w);
  for (let k = 0; k < panels; k++) {
    // A panel leaves the fairing's craft: it is a craft of its own (no queue of its own).
    const panelId = `${part.instanceId}#panel${k}`;
    const record = pieceCraft(craft, panelId, Math.round(ctx.ut * TICKS_PER_SECOND));
    record.stageLockout = 0;
    record.sinceStaging = Infinity;
    const v = emptyVessel(singleCraftVesselId(record), `${part.def.name} panel ${k + 1}`, record);
    const p = createPart(panelId, part.def, part.stageGroup);
    p.panel = { index: k, count: panels };
    p.temps = part.temps.slice();
    p.resources = part.resources.map((x) => x / panels);
    for (const m of p.modules) if (m.type === 'fairing') m.jettisoned = true;
    v.parts.push(p);
    v.r = v3.clone(framePos);
    v.q = quat.clone(frameQ);
    v.w = v3.clone(frameW);
    v.v = v3.clone(frameVel);
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
