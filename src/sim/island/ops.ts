/**
 * Structural operations as data (ARCHITECTURE 6.1, 13.3; `IslandOpBody` of src/core/contracts/net.ts): what
 * anyone who holds the island state applies to get the same result, with the checksum both sides compute
 * after it. They wrap the vessel package's own functions (`separateVessel`, `destroyParts`), so an operation
 * applied here is the change the authoritative step made, part for part and id for id.
 */
import type { IslandOpChecksum } from '@/core/contracts/net';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { destroyParts } from '../dynamics/failure';
import { decodeVessel, isControllable, libraryResolver, separateVessel, type Vessel } from '../vessel';
import type { StepContext, StructuralRecord } from '../vessel/types';
import type { IslandErrorInfo, IslandOp } from './api';
import { POSE_CORRECTION_MAX_ANGLE, POSE_CORRECTION_MAX_DISTANCE, POSE_CORRECTION_MAX_RATE, POSE_CORRECTION_MAX_SPEED } from './api';
import { restoreMemberBytes } from './codec';
import type { IslandImpl, Rec } from './island';

/** Thrown by `applyOp` and `decodeIsland`: the data does not fit the state or the codec. */
export class IslandOpError extends Error {
  readonly info: IslandErrorInfo;
  constructor(problem: IslandErrorInfo['problem'], detail: string) {
    super(`island: ${detail}`);
    this.name = 'IslandOpError';
    this.info = { problem, detail };
  }
}

/** FNV-1a, 32 bit, over the code units of the vessel's craft ids joined by '\n' (`IslandOpChecksum.craftHash`). */
export function craftListHash(vessel: Vessel): number {
  let h = 0x811c9dc5;
  for (let c = 0; c < vessel.crafts.length; c++) {
    const id = c === 0 ? vessel.crafts[c]!.craftId : `\n${vessel.crafts[c]!.craftId}`;
    for (let i = 0; i < id.length; i++) {
      const u = id.charCodeAt(i);
      h = Math.imul(h ^ (u & 0xff), 0x01000193);
      h = Math.imul(h ^ (u >>> 8), 0x01000193);
    }
  }
  return h >>> 0;
}

/** The check of a vessel after an operation: parts, the craft list and the summed mass. */
export function checksumOfVessel(vessel: Vessel): IslandOpChecksum {
  return { partCount: vessel.parts.length, craftHash: craftListHash(vessel), massKg: vessel.mp.mass };
}

/** True when two checksums agree (the mass to 1e-9 relative, as the contract says). */
export function checksumsAgree(a: IslandOpChecksum | null, b: IslandOpChecksum | null): boolean {
  if (a === null || b === null) return a === b;
  return a.partCount === b.partCount && a.craftHash === b.craftHash && Math.abs(a.massKg - b.massKg) <= 1e-9 * Math.max(Math.abs(a.massKg), Math.abs(b.massKg));
}

/** The operation a structural record of the vessel code is, for the member at `slot`. */
export function opFromRecord(r: StructuralRecord, slot: number): IslandOp {
  if (r.op === 'split') return { op: 'split', slot, cutJoints: r.cut.slice(), newVesselIds: r.newVesselIds.slice() };
  return { op: 'destroy', slot, parts: r.parts.slice(), cause: r.cause };
}

function memberAt(island: IslandImpl, slot: number): Rec {
  const rec = island.recs[slot];
  if (!rec) throw new IslandOpError('slot', `no member at slot ${slot} (the island has ${island.recs.length})`);
  return rec;
}

function sameIds(got: readonly Vessel[], stated: readonly string[]): boolean {
  if (got.length !== stated.length) return false;
  for (let i = 0; i < got.length; i++) if (got[i]!.id !== stated[i]) return false;
  return true;
}

/** Execute `op` on the island at its tick. Returns the checksum of the vessel the operation leaves at its first slot. */
export function applyIslandOp(island: IslandImpl, op: IslandOp): IslandOpChecksum | null {
  const checksum = executeOp(island, op);
  // An operation applied on a control tick changes what the island's upkeep derived there from its members (the
  // armed margins, the pairs still overlapping, the watch flags): they are derived again from what it left.
  island.opAccess.settled();
  return checksum;
}

function executeOp(island: IslandImpl, op: IslandOp): IslandOpChecksum | null {
  const access = island.opAccess;
  switch (op.op) {
    case 'split': {
      const rec = memberAt(island, op.slot);
      const v = rec.vessel;
      for (const i of op.cutJoints) {
        if (!Number.isInteger(i) || i < 0 || i >= v.parts.length) throw new IslandOpError('joint', `vessel "${v.id}" has no part ${i}`);
        if (v.parts[i]!.parent < 0) throw new IslandOpError('joint', `part ${i} of vessel "${v.id}" is a root: there is no joint to its parent`);
      }
      const ctx: StepContext = { ut: island.ut, env: access.envOf(rec), instant: false, events: [], spawned: [] };
      const created = separateVessel(v, op.cutJoints, [], ctx);
      if (!sameIds(created, op.newVesselIds)) throw new IslandOpError('ids', `the split of "${v.id}" made [${created.map((x) => x.id).join(', ')}], the operation states [${op.newVesselIds.join(', ')}]`);
      access.pushEvents(ctx.events);
      for (const s of created) access.adopt(s, rec);
      access.afterStructureChange(rec);
      const checksum = checksumOfVessel(v);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
    case 'destroy': {
      const rec = memberAt(island, op.slot);
      const v = rec.vessel;
      for (const i of op.parts) if (!Number.isInteger(i) || i < 0 || i >= v.parts.length) throw new IslandOpError('joint', `vessel "${v.id}" has no part ${i}`);
      if (op.cause === 'collision') throw new IslandOpError('vessel', 'a collision destroys parts through the contact pass, which this island does not have');
      const ctx: StepContext = { ut: island.ut, env: access.envOf(rec), instant: false, events: [], spawned: [] };
      destroyParts(v, op.parts, op.cause, ctx);
      access.pushEvents(ctx.events);
      for (const s of ctx.spawned) access.adopt(s, rec);
      const gone = v.destroyed || v.parts.length === 0;
      const checksum = gone ? null : checksumOfVessel(v);
      access.pushOp({ tick: island.tick, body: op, checksum });
      if (gone) access.depart(rec, 'destroyed');
      else access.afterStructureChange(rec);
      return checksum;
    }
    case 'add': {
      const vessel = decodeBlob(island, op.vessel.bytes, op.vessel.encoding);
      if (vessel.id !== op.vesselId) throw new IslandOpError('ids', `the blob holds vessel "${vessel.id}", the operation states "${op.vesselId}"`);
      island.add(vessel);
      access.arrive(vessel.id);
      const checksum = checksumOfVessel(vessel);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
    case 'remove': {
      const rec = memberAt(island, op.slot);
      access.pushOp({ tick: island.tick, body: op, checksum: null });
      access.depart(rec, op.reason === 'destroyed' ? 'destroyed' : op.reason === 'removed' ? 'removed' : 'left');
      return null;
    }
    case 'rebase': {
      const anchor = memberAt(island, op.anchor);
      if (op.bodyId !== island.bodyId) throw new IslandOpError('frame', `the rebase is about "${op.bodyId}", the island is about "${island.bodyId}"`);
      if (!v3.isFinite(op.r) || !v3.isFinite(op.v)) throw new IslandOpError('frame', 'the reference state is not finite');
      access.rebaseTo({ r: op.r, v: op.v }, anchor);
      const checksum = checksumOfVessel(anchor.vessel);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
    case 'outcome': {
      const rec = memberAt(island, op.slot);
      // The member as the sender has it after the step: its vessel and the island's items about it.
      restoreMemberBytes(island, rec, op.member);
      rec.controllable = isControllable(rec.vessel);
      const checksum = checksumOfVessel(rec.vessel);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
    case 'pose': {
      const rec = memberAt(island, op.slot);
      const v = rec.vessel;
      if (!v3.isFinite(op.r) || !v3.isFinite(op.v) || !v3.isFinite(op.w) || ![op.q.x, op.q.y, op.q.z, op.q.w].every(Number.isFinite)) throw new IslandOpError('bound', 'the pose is not finite');
      const q = quat.normalize(op.q);
      const turned = 2 * Math.acos(Math.min(1, Math.abs(q.x * v.q.x + q.y * v.q.y + q.z * v.q.z + q.w * v.q.w)));
      if (v3.dist(op.r, v.r) > POSE_CORRECTION_MAX_DISTANCE || v3.dist(op.v, v.v) > POSE_CORRECTION_MAX_SPEED || turned > POSE_CORRECTION_MAX_ANGLE || v3.dist(op.w, v.w) > POSE_CORRECTION_MAX_RATE) {
        throw new IslandOpError('bound', `the pose of "${v.id}" is ${v3.dist(op.r, v.r).toFixed(1)} m, ${v3.dist(op.v, v.v).toFixed(2)} m/s, ${turned.toFixed(3)} rad from the member's: beyond a correction (send the vessel)`);
      }
      const moved = v3.dist(op.r, v.r) !== 0 || v3.dist(op.v, v.v) !== 0;
      v.r = v3.clone(op.r);
      v.v = v3.clone(op.v);
      v.q = { x: op.q.x, y: op.q.y, z: op.q.z, w: op.q.w };
      v.w = v3.clone(op.w);
      access.posed(rec, moved);
      const checksum = checksumOfVessel(v);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
    case 'replace': {
      const rec = memberAt(island, op.slot);
      const vessel = decodeBlob(island, op.vessel.bytes, op.vessel.encoding);
      if (vessel.id !== rec.vessel.id) throw new IslandOpError('ids', `the blob holds vessel "${vessel.id}", slot ${op.slot} holds "${rec.vessel.id}"`);
      // The record stays (its seat, its tick of birth, its place in every pair list): the vessel's whole state is the blob's.
      rec.vessel = vessel;
      rec.previous = null;
      rec.orbit = null;
      rec.railsEvent = null;
      rec.mode = rec.vessel.hold !== null ? 'landed' : 'integrated';
      rec.coastTime = 0;
      access.afterStructureChange(rec);
      const checksum = checksumOfVessel(rec.vessel);
      access.pushOp({ tick: island.tick, body: op, checksum });
      return checksum;
    }
  }
}

/** A vessel from a blob of an operation or an input. The wire may deflate a blob; the island is handed the raw bytes. */
export function decodeBlob(island: IslandImpl, bytes: Uint8Array, encoding: 'raw' | 'deflate-raw'): Vessel {
  if (encoding !== 'raw') throw new IslandOpError('format', 'the blob is deflated: the host inflates a blob before it hands it to the island');
  try {
    return decodeVessel(bytes, { resolver: island.deps.resolver ?? libraryResolver(island.deps.defs) }).vessel;
  } catch (e) {
    throw new IslandOpError('vessel', e instanceof Error ? e.message : String(e));
  }
}
