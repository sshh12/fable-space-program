/**
 * Docking as a structural operation (docs/ARCHITECTURE.md 7.2, docs/research/v2/fleet-docking.md 3.4, 3.5):
 * the momentum-conserving merge of two vessels through a pair of port parts, and the undock that removes a
 * link and lets the component pass of split.ts divide the forest.
 *
 * This is NOT the weld of split.ts (`mergeVessels`, the released launch clamps): a dock joins two craft that
 * each keep their own tree and root, records the joint as a link, and conserves the linear and the angular
 * momentum of the pair.
 *
 * What decides THAT two ports dock (capture envelopes, soft capture, the hard-dock dwell, the port states)
 * is the island's contact and capture pass; it calls `dockMerge` with the two port parts once they are mated.
 */
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { linkRoll } from './assemble';
import { assemblyId, findPartByKey, partKeyOf } from './ids';
import { computeMassProps } from './massProps';
import { separateVessel } from './split';
import { partDir, partPoint } from './structure';
import type { PartRuntime, StepContext, Vessel } from './types';

/** Linear momentum (BCI axes, kg m/s) and angular momentum about the centre of mass (BCI axes, kg m^2/s) of a vessel, with the position and velocity of its centre of mass. */
export interface Momentum {
  mass: number;
  com: Vec3;
  comVelocity: Vec3;
  linear: Vec3;
  angular: Vec3;
}

/** I w for the symmetric tensor [xx, yy, zz, xy, xz, yz]. */
const applyTensor = (i: readonly number[], w: Vec3): Vec3 => ({
  x: i[0]! * w.x + i[3]! * w.y + i[4]! * w.z,
  y: i[3]! * w.x + i[1]! * w.y + i[5]! * w.z,
  z: i[4]! * w.x + i[5]! * w.y + i[2]! * w.z,
});

/** Momentum of a vessel from its mass properties (which must be current). */
export function momentumOf(vessel: Vessel): Momentum {
  const mp = vessel.mp;
  const com = v3.add(vessel.r, quat.rotate(vessel.q, mp.com));
  const comVelocity = v3.add(vessel.v, quat.rotate(vessel.q, v3.cross(vessel.w, mp.com)));
  return {
    mass: mp.mass,
    com,
    comVelocity,
    linear: v3.scale(comVelocity, mp.mass),
    angular: quat.rotate(vessel.q, applyTensor(mp.i, vessel.w)),
  };
}

/**
 * Total momentum of several bodies about their common centre of mass: the sum of the linear momenta, and
 * the sum of the spin angular momenta plus the orbital terms m (c_i - c) x (v_i - v).
 */
export function combinedMomentum(bodies: readonly Momentum[]): Momentum {
  let mass = 0;
  let com = v3.zero();
  let linear = v3.zero();
  for (const b of bodies) {
    mass += b.mass;
    com = v3.addScaled(com, b.com, b.mass);
    linear = v3.add(linear, b.linear);
  }
  com = v3.scale(com, 1 / mass);
  const comVelocity = v3.scale(linear, 1 / mass);
  let angular = v3.zero();
  for (const b of bodies) {
    angular = v3.add(angular, b.angular);
    angular = v3.addScaled(angular, v3.cross(v3.sub(b.com, com), v3.sub(b.comVelocity, comVelocity)), b.mass);
  }
  return { mass, com, comVelocity, linear, angular };
}

/** The mating face of a port part: the position and outward direction of its first attach node of kind 'dock', in VES. */
export function dockFace(part: PartRuntime): { pos: Vec3; dir: Vec3 } | null {
  const node = part.def.attachNodes.find((n) => n.kind === 'dock');
  if (!node) return null;
  return { pos: partPoint(part, node.pos), dir: v3.normalize(partDir(part, node.dir)) };
}

/** Which of two vessels is the base of a dock: the heavier one; at equal mass the one with the lower id. */
export function dockBase(a: Vessel, b: Vessel): Vessel {
  if (a.mp.mass !== b.mp.mass) return a.mp.mass > b.mp.mass ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * The pose of `other`'s VES frame in `base`'s VES frame that puts the mating faces of the two port parts
 * exactly on each other (faces coincident, directions opposed) with the least rotation from the pose the
 * vessels have now. This is the snap that removes the residual offset of a capture.
 */
export function snapPose(base: Vessel, other: Vessel, basePort: number, otherPort: number): { pos: Vec3; rot: Quat } {
  const fa = dockFace(base.parts[basePort]!);
  const fb = dockFace(other.parts[otherPort]!);
  if (!fa || !fb) throw new Error('snapPose: both parts must have an attach node of kind "dock"');
  const measured = quat.normalize(quat.mul(quat.conj(base.q), other.q));
  // Turn other's face direction (as it is now, in base axes) onto the opposite of the base's face direction.
  const now = quat.rotate(measured, fb.dir);
  const rot = quat.normalize(quat.mul(quat.fromTo(now, v3.neg(fa.dir)), measured));
  return { pos: v3.sub(fa.pos, quat.rotate(rot, fb.pos)), rot };
}

/**
 * Dock `other` to `base` through the port parts `basePort` (index into `base.parts`) and `otherPort` (index
 * into `other.parts`) at tick `tick`. `base` becomes the merged vessel; `other` is emptied and must be
 * discarded by the caller (its row becomes a tombstone).
 *
 *  - The parts of `other` are re-expressed in the base's VES frame, each craft keeping its own tree and
 *    root: no tree is re-rooted. By default the two vessels are joined in the relative pose they have at
 *    this instant; `pose` (the pose of other's VES frame in the base's, e.g. `snapPose`) replaces it.
 *  - A dock link joins the two port parts.
 *  - Linear momentum of both fixes the velocity of the new centre of mass; angular momentum about the new
 *    centre of mass, spin and orbital terms, fixes the angular velocity through the merged inertia tensor:
 *    w = I^-1 L.
 *  - The craft of `other` are appended with `joinedTick = tick`; each keeps its stage stack, pending
 *    actions, owner and policy. Nothing pools: a flow group stays (craft, stage group).
 *  - The helm, the SAS and the name of the base stay. The id follows ARCHITECTURE section 3: an assembly
 *    keeps its id when craft join it; two vessels that were not assemblies become `a~<lower id>~<tick>`.
 */
export function dockMerge(base: Vessel, other: Vessel, basePort: number, otherPort: number, tick: number, pose?: { pos: Vec3; rot: Quat }): void {
  if (base === other) throw new Error('dockMerge: a vessel cannot dock to itself (a second link between two of its own ports is addLink)');
  const pa = base.parts[basePort];
  const pb = other.parts[otherPort];
  if (!pa || !pb) throw new Error('dockMerge: no such port part');
  if (!dockFace(pa) || !dockFace(pb)) throw new Error(`dockMerge: parts "${pa.instanceId}" and "${pb.instanceId}" must both have an attach node of kind "dock"`);
  for (const c of other.crafts) {
    if (base.crafts.some((x) => x.craftId === c.craftId)) throw new Error(`dockMerge: craft "${c.craftId}" is in both vessels`);
  }
  computeMassProps(base);
  computeMassProps(other);
  const total = combinedMomentum([momentumOf(base), momentumOf(other)]);

  // Geometry: other's frame in the base's frame.
  const rel = pose ? pose.pos : quat.rotateInv(base.q, v3.sub(other.r, base.r));
  const qRel = pose ? pose.rot : quat.normalize(quat.mul(quat.conj(base.q), other.q));
  const partOffset = base.parts.length;
  const craftOffset = base.crafts.length;
  const baseWasAssembly = base.crafts.length > 1;
  const otherWasAssembly = other.crafts.length > 1;
  const identity = qRel.x === 0 && qRel.y === 0 && qRel.z === 0 && qRel.w === 1;
  for (const p of other.parts) {
    p.pos = v3.add(rel, quat.rotate(qRel, p.pos));
    if (!identity) p.rot = quat.normalize(quat.mul(qRel, p.rot));
    if (p.parent >= 0) p.parent += partOffset;
    p.craft += craftOffset;
    base.parts.push(p);
  }
  for (const c of other.crafts) {
    c.joinedTick = tick;
    base.crafts.push(c);
  }
  for (const l of other.links) base.links.push({ a: l.a + partOffset, b: l.b + partOffset, roll: l.roll });
  const face = dockFace(pa)!;
  base.links.push({ a: basePort, b: otherPort + partOffset, roll: linkRoll(pa, pb, face.dir) });

  // Identity.
  if (!baseWasAssembly) base.id = otherWasAssembly ? other.id : assemblyId(base.id, other.id, tick);
  base.crewAlive = base.crewAlive && other.crewAlive;
  base.gDose = Math.max(base.gDose, other.gDose);
  if (base.hold === 'asleep') {
    base.hold = null;
    base.anchor = null;
  }

  // Momentum: the merged body moves with the common centre of mass and turns with w = I^-1 L.
  base.struct = null;
  computeMassProps(base);
  const mp = base.mp;
  const w = applyTensor(mp.inv, quat.rotateInv(base.q, total.angular));
  base.w = w;
  base.v = v3.sub(total.comVelocity, quat.rotate(base.q, v3.cross(w, mp.com)));

  other.parts = [];
  other.crafts = [];
  other.links = [];
  other.struct = null;
}

/** Join two port parts of ONE vessel by a second link (a ring closes: A to B to C to A). Nothing moves. */
export function addLink(vessel: Vessel, a: number, b: number): void {
  const pa = vessel.parts[a];
  const pb = vessel.parts[b];
  if (!pa || !pb || a === b) throw new Error('addLink: no such pair of port parts');
  const face = dockFace(pa);
  if (!face || !dockFace(pb)) throw new Error(`addLink: parts "${pa.instanceId}" and "${pb.instanceId}" must both have an attach node of kind "dock"`);
  if (vessel.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return;
  vessel.links.push({ a, b, roll: linkRoll(pa, pb, face.dir) });
}

/**
 * Release dock link `link` of `vessel` and divide the forest into its connected components (separateVessel:
 * each piece keeps the rigid-body motion it had, so momentum is conserved by construction). `impulse` (N s)
 * is the spring of the port: it acts equal and opposite along the port axis AT THE PORT, so a side port
 * gives both a push and a turn (dv = J / m, dw = I^-1 (r x J)). When the link was one of several that hold
 * the two sides together (a ring), nothing separates and no impulse is applied: only the link is gone.
 * Returns the newly created vessels (already appended to ctx.spawned) and emits `undocked`.
 */
export function undock(vessel: Vessel, link: number, impulse: number, ctx: StepContext): Vessel[] {
  const l = vessel.links[link];
  if (!l) throw new Error(`undock: vessel "${vessel.id}" has no link ${link}`);
  const partA = vessel.parts[l.a]!;
  const face = dockFace(partA);
  if (!face) throw new Error(`undock: port part "${partA.instanceId}" has no attach node of kind "dock"`);
  const vesselId = vessel.id;
  const keyA = partKeyOf(vessel, l.a);
  const keyB = partKeyOf(vessel, l.b);
  // The port axis and the point the spring acts at, in BCI, before anything is re-rooted.
  const axis = quat.rotate(vessel.q, face.dir);
  const point = v3.add(vessel.r, quat.rotate(vessel.q, face.pos));
  vessel.links.splice(link, 1);
  const held = vessel.hold;
  const created = separateVessel(vessel, [], [], ctx);
  if (created.length > 0) {
    const all = [vessel, ...created];
    if (held === 'asleep') {
      for (const v of all) {
        v.hold = null;
        v.anchor = null;
        v.restTimer = 0;
      }
    }
    if (impulse !== 0) {
      for (const v of all) {
        if (v.hold !== null) continue;
        // The side that holds port A is pushed against A's outward direction, the other side along it.
        const sign = findPartByKey(v, keyA) >= 0 ? -1 : 1;
        applyImpulseAt(v, v3.scale(axis, sign * impulse), point);
      }
    }
  }
  ctx.events.push({ type: 'undocked', ut: ctx.ut, vesselId, partId: keyA, otherPartId: keyB, newVesselIds: created.map((v) => v.id) });
  return created;
}

/** Apply an impulse J (BCI axes, N s) to a vessel at the point `at` (BCI): dv = J / m at the centre of mass, dw = I^-1 (r x J). */
export function applyImpulseAt(vessel: Vessel, J: Vec3, at: Vec3): void {
  const mp = vessel.mp;
  if (!(mp.mass > 0)) return;
  const com = v3.add(vessel.r, quat.rotate(vessel.q, mp.com));
  const comVelocity = v3.add(vessel.v, quat.rotate(vessel.q, v3.cross(vessel.w, mp.com)));
  const torque = quat.rotateInv(vessel.q, v3.cross(v3.sub(at, com), J));
  const w = v3.add(vessel.w, applyTensor(mp.inv, torque));
  const vCom = v3.addScaled(comVelocity, J, 1 / mp.mass);
  vessel.w = w;
  vessel.v = v3.sub(vCom, quat.rotate(vessel.q, v3.cross(w, mp.com)));
}

