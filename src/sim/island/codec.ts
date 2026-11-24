/**
 * The island codec (docs/ARCHITECTURE.md 7.2, "The island has state of its own, and it is whole too").
 *
 * Besides its vessels (blobs of the vessel codec, version 4, written WITHOUT their LABELS block) an island
 * blob carries: the tick and the frame body; the reference orbit; the member list in slot order with each
 * member's mode (the tier flag is the mode 'armed'), its conic and next event, its seat and attendance, its
 * tick of birth, the threshold-watch and terrain-regime flags, the coast timer; the anchor; nascent pairs;
 * U5 pairs with their clearing timers; capture constraints with their timers; admitted copies with their
 * old heads and reservation state; the pending merge tick; per pilot the latched controls, the hold
 * direction, the velocity reference and the tick the latch and dead-man timers opened; and the inputs
 * queued for ticks the island has not reached. It carries NO clock base and no phase of the control tick
 * or of the sun sample: those are fixed functions of the tick (src/sim/clock.ts).
 *
 * Layout: `FSPI`, u16 version, the defsHash it was written under, the island's id, the BODY as one length-prefixed block,
 * then the NAMES block (the names of every vessel and of its craft, in slot order; absent when written
 * without names). `islandHash` is the hash of the body: it does not cover the header or the names, so two
 * replicas that call a craft differently, or run another build of the same definitions, are the same state.
 *
 * Not carried, because it is not state: the step mode (a replica reads a server checkpoint in predict
 * mode), the previous pose of presentation interpolation (the first frame after a restore is not
 * interpolated), terrain requests (they are issued again at the next control tick) and counters.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { Vec3 } from '@/core/math/vec3';
import { hashLibrary } from '@/core/defs/hash';
import { decodeVessel, encodeVessel, hashBytes, libraryResolver, VesselDecodeError } from '../vessel';
import { Reader, Writer } from '../vessel/codec';
import type { IslandCommand, IslandDeps, IslandInit, IslandInput, IslandTimer, MemberMode, ReservationState, StepMode } from './api';
import { inputOrder, type IslandImpl } from './island';
import { IslandOpError } from './ops';
import type { RailsEvent, RailsEventKind } from './rails';
import { orbitOf } from './rails';

export const ISLAND_CODEC_VERSION = 1;
const MAGIC = [0x46, 0x53, 0x50, 0x49]; // "FSPI"

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const MODES: readonly MemberMode[] = ['landed', 'rails', 'armed', 'integrated'];
const EVENT_KINDS: readonly RailsEventKind[] = ['soiEnter', 'soiExit', 'atmosphere', 'impact', 'recheck'];
const RESERVATIONS: readonly ReservationState[] = ['none', 'requested', 'granted', 'denied'];
const TIMERS: readonly IslandTimer[] = ['socketLost', 'socketBack', 'latchEnd', 'deadManRotation', 'deadManThrottle', 'graceEnd'];
const INPUT_KINDS: readonly IslandInput['kind'][] = ['controls', 'reference', 'command', 'seat', 'helm', 'add', 'remove', 'reservation', 'destruct', 'timer', 'rate', 'mergeAt'];
const COMMAND_KINDS: readonly IslandCommand['kind'][] = ['stage', 'abort', 'sas', 'sasMode', 'rcs', 'legs', 'lights', 'fineControl'];
const SAS_MODES: readonly string[] = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver', 'target', 'antiTarget', 'portAlign'];

const indexIn = <T>(list: readonly T[], x: T, what: string): number => {
  const i = list.indexOf(x);
  if (i < 0) throw new Error(`island codec: unknown ${what} "${String(x)}"`);
  return i;
};
const fromIndex = <T>(list: readonly T[], i: number, what: string): T => {
  const x = list[i];
  if (x === undefined) throw new IslandOpError('format', `unknown ${what} ${i}`);
  return x;
};

function wStr(w: Writer, s: string): void {
  const b = utf8.encode(s);
  w.uint(b.length);
  w.bytes(b);
}
function rStr(r: Reader): string {
  return utf8Decoder.decode(r.bytes(r.uint()));
}
function wOptStr(w: Writer, s: string | null): void {
  w.bool(s !== null);
  if (s !== null) wStr(w, s);
}
const rOptStr = (r: Reader): string | null => (r.bool() ? rStr(r) : null);
function wVec(w: Writer, v: Vec3): void {
  w.f64(v.x);
  w.f64(v.y);
  w.f64(v.z);
}
const rVec = (r: Reader): Vec3 => ({ x: r.f64(), y: r.f64(), z: r.f64() });
function wOptTick(w: Writer, t: number | null): void {
  w.bool(t !== null);
  if (t !== null) w.f64(t);
}
const rOptTick = (r: Reader): number | null => (r.bool() ? r.f64() : null);
function wControls(w: Writer, c: ControlInputs): void {
  w.f64(c.pitch);
  w.f64(c.yaw);
  w.f64(c.roll);
  wVec(w, c.translate);
  w.f64(c.throttle);
}
const rControls = (r: Reader): ControlInputs => ({ pitch: r.f64(), yaw: r.f64(), roll: r.f64(), translate: rVec(r), throttle: r.f64() });
function wBytes(w: Writer, b: Uint8Array): void {
  w.uint(b.length);
  w.bytes(b);
}
const rBytes = (r: Reader): Uint8Array => r.bytes(r.uint()).slice();

function wInput(w: Writer, i: IslandInput): void {
  w.u8(indexIn(INPUT_KINDS, i.kind, 'input kind'));
  w.f64(i.tick);
  wStr(w, i.accountId);
  w.f64(i.seq);
  switch (i.kind) {
    case 'controls':
      wStr(w, i.vesselId);
      wControls(w, i.controls);
      w.bool(i.sasHold !== null);
      if (i.sasHold !== null) wVec(w, i.sasHold);
      break;
    case 'reference':
      wStr(w, i.vesselId);
      w.bool(i.reference === 'orbit');
      break;
    case 'command':
      wStr(w, i.vesselId);
      w.u8(indexIn(COMMAND_KINDS, i.command.kind, 'command'));
      if (i.command.kind === 'sas' || i.command.kind === 'rcs' || i.command.kind === 'fineControl') w.bool(i.command.on);
      if (i.command.kind === 'sasMode') w.u8(indexIn(SAS_MODES, i.command.mode, 'SAS mode'));
      break;
    case 'seat':
      wStr(w, i.vesselId);
      w.bool(i.aboard);
      break;
    case 'helm':
      wStr(w, i.vesselId);
      wOptStr(w, i.pilot);
      wOptStr(w, i.craftId);
      wOptStr(w, i.controlPartKey);
      break;
    case 'add':
      wBytes(w, i.vessel);
      w.f64(i.bornTick);
      wOptTick(w, i.admittedFromHead);
      break;
    case 'remove':
      wStr(w, i.vesselId);
      w.bool(i.reason === 'removed');
      break;
    case 'reservation':
      wStr(w, i.vesselId);
      w.u8(indexIn(RESERVATIONS, i.state, 'reservation state'));
      break;
    case 'destruct':
      wStr(w, i.vesselId);
      break;
    case 'timer':
      wStr(w, i.vesselId);
      w.u8(indexIn(TIMERS, i.timer, 'timer'));
      break;
    case 'rate':
      w.f64(i.rate);
      break;
    case 'mergeAt':
      wOptTick(w, i.mergeTick);
      break;
  }
}

function rInput(r: Reader): IslandInput {
  const kind = fromIndex(INPUT_KINDS, r.u8(), 'input kind');
  const base = { tick: r.f64(), accountId: rStr(r), seq: r.f64() };
  switch (kind) {
    case 'controls':
      return { ...base, kind, vesselId: rStr(r), controls: rControls(r), sasHold: r.bool() ? rVec(r) : null };
    case 'reference':
      return { ...base, kind, vesselId: rStr(r), reference: r.bool() ? 'orbit' : 'surface' };
    case 'command': {
      const vesselId = rStr(r);
      const c = fromIndex(COMMAND_KINDS, r.u8(), 'command');
      let command: IslandCommand;
      if (c === 'sas' || c === 'rcs' || c === 'fineControl') command = { kind: c, on: r.bool() };
      else if (c === 'sasMode') command = { kind: c, mode: fromIndex(SAS_MODES, r.u8(), 'SAS mode') as Extract<IslandCommand, { kind: 'sasMode' }>['mode'] };
      else command = { kind: c };
      return { ...base, kind, vesselId, command };
    }
    case 'seat':
      return { ...base, kind, vesselId: rStr(r), aboard: r.bool() };
    case 'helm':
      return { ...base, kind, vesselId: rStr(r), pilot: rOptStr(r), craftId: rOptStr(r), controlPartKey: rOptStr(r) };
    case 'add':
      return { ...base, kind, vessel: rBytes(r), bornTick: r.f64(), admittedFromHead: rOptTick(r) };
    case 'remove':
      return { ...base, kind, vesselId: rStr(r), reason: r.bool() ? 'removed' : 'left' };
    case 'reservation':
      return { ...base, kind, vesselId: rStr(r), state: fromIndex(RESERVATIONS, r.u8(), 'reservation state') };
    case 'destruct':
      return { ...base, kind, vesselId: rStr(r) };
    case 'timer':
      return { ...base, kind, vesselId: rStr(r), timer: fromIndex(TIMERS, r.u8(), 'timer') };
    case 'rate':
      return { ...base, kind, rate: r.f64() };
    case 'mergeAt':
      return { ...base, kind, mergeTick: rOptTick(r) };
  }
}

const defsHashCache = new WeakMap<object, string>();
function defsHashOf(deps: IslandDeps): string {
  let h = defsHashCache.get(deps.defs);
  if (h === undefined) {
    h = hashLibrary(deps.defs);
    defsHashCache.set(deps.defs, h);
  }
  return h;
}

/** The whole island as bytes. `names` false leaves the NAMES block out (the body, and so the hash, is the same). */
export function encodeIsland(island: IslandImpl, names: boolean): Uint8Array {
  const defsHash = defsHashOf(island.deps);
  const b = new Writer();
  b.f64(island.tick);
  wStr(b, island.bodyId);
  b.f64(island.rate);
  wOptTick(b, island.mergeTick);
  b.bool(island.railsWarp);
  const ref = island.reference;
  b.bool(ref !== null);
  if (ref !== null) {
    wVec(b, ref.r0);
    wVec(b, ref.v0);
    b.f64(ref.tick);
  }
  b.uint(island.recs.length);
  for (const rec of island.recs) {
    wBytes(b, encodeVessel(rec.vessel, { defsHash, labels: false }));
    b.u8(indexIn(MODES, rec.mode, 'mode'));
    b.bool(rec.attended);
    wOptStr(b, rec.pilot);
    b.f64(rec.bornTick);
    b.f64(rec.revision);
    b.bool(rec.thresholdWatch);
    b.bool(rec.terrainRegime);
    b.bool(rec.trackHold);
    b.f64(rec.coastTime);
    b.bool(rec.forceIntegrate);
    b.bool(rec.nearOther);
    wOptTick(b, rec.admittedFromHead);
    b.u8(indexIn(RESERVATIONS, rec.reservation, 'reservation state'));
    b.bool(rec.orbit !== null);
    if (rec.orbit !== null) {
      wVec(b, rec.orbit.r0);
      wVec(b, rec.orbit.v0);
      b.f64(rec.orbit.t0);
    }
    const ev = rec.railsEvent;
    b.bool(ev !== null);
    if (ev !== null) {
      b.f64(ev.ut);
      b.u8(indexIn(EVENT_KINDS, ev.kind, 'event kind'));
      wOptStr(b, ev.nextBodyId);
    }
  }
  const anchor = island.anchorId;
  b.uint(anchor === null ? 0 : island.recs.findIndex((r) => r.vessel.id === anchor) + 1);
  b.uint(island.nascentPairs.length);
  for (const p of island.nascentPairs) {
    wStr(b, p.a);
    wStr(b, p.b);
  }
  b.uint(island.clearingPairs.length);
  for (const p of island.clearingPairs) {
    wStr(b, p.a);
    wStr(b, p.b);
    b.f64(p.sinceTick);
  }
  b.uint(island.captures.length);
  for (const c of island.captures) {
    wStr(b, c.a);
    wStr(b, c.b);
    b.uint(c.aPort);
    b.uint(c.bPort);
    wBytes(b, c.state);
    b.f64(c.clampTicks);
    b.f64(c.ageTicks);
    b.f64(c.dwellTicks);
  }
  const seats = [...island.seats.values()].sort((x, y) => (x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0));
  b.uint(seats.length);
  for (const s of seats) {
    wStr(b, s.accountId);
    wStr(b, s.vesselId);
    wControls(b, s.controls);
    b.bool(s.sasHold !== null);
    if (s.sasHold !== null) wVec(b, s.sasHold);
    b.bool(s.reference === 'orbit');
    wOptTick(b, s.latchOpenTick);
  }
  // The queue in the canonical order of inputs: the order they arrived in is no state.
  const queue = island.queue.slice().sort(inputOrder);
  b.uint(queue.length);
  for (const i of queue) wInput(b, i);

  const out = new Writer();
  for (const m of MAGIC) out.u8(m);
  out.u16(ISLAND_CODEC_VERSION);
  wStr(out, defsHash);
  wStr(out, island.id);
  out.block(b);
  if (names) {
    const n = new Writer();
    for (const rec of island.recs) {
      wStr(n, rec.vessel.name);
      n.uint(rec.vessel.crafts.length);
      for (const c of rec.vessel.crafts) wStr(n, c.name);
    }
    out.bool(true);
    out.block(n);
  } else out.bool(false);
  return out.done();
}

function openIsland(bytes: Uint8Array): { version: number; defsHash: string; id: string; body: Reader; names: Reader | null } {
  try {
    const r = new Reader(bytes);
    for (const m of MAGIC) if (r.left < 1 || r.u8() !== m) throw new IslandOpError('format', 'not an island blob (the magic bytes are missing)');
    const version = r.u16();
    if (version !== ISLAND_CODEC_VERSION) throw new IslandOpError('version', `island codec version ${version} is not one this build reads (${ISLAND_CODEC_VERSION})`);
    const defsHash = rStr(r);
    const id = rStr(r);
    const body = r.block();
    const names = r.bool() ? r.block() : null;
    return { version, defsHash, id, body, names };
  } catch (e) {
    if (e instanceof VesselDecodeError) throw new IslandOpError('format', e.message);
    throw e;
  }
}

/** Hash of island codec bytes (16 hex digits): the body, which is every byte but the header and the names. */
export function islandHash(bytes: Uint8Array): string {
  const o = openIsland(bytes);
  return hashBytes(o.body.bytes(o.body.left));
}

/** Restore an island from its bytes. `make` builds the empty island of the same kind the encoder had. */
export function decodeIslandInto(make: (init: IslandInit) => IslandImpl, deps: IslandDeps, bytes: Uint8Array, mode: StepMode | undefined): IslandImpl {
  const o = openIsland(bytes);
  const id = o.id;
  const resolver = deps.resolver ?? libraryResolver(deps.defs);
  try {
    const r = o.body;
    const tick = r.f64();
    const bodyId = rStr(r);
    if (!deps.defs.bodies[bodyId]) throw new IslandOpError('frame', `the island is about body "${bodyId}", which the library does not have`);
    const island = make({ id, tick, bodyId, mode, rate: r.f64() });
    island.mergeTick = rOptTick(r);
    island.railsWarp = r.bool();
    if (r.bool()) island.setReference({ r0: rVec(r), v0: rVec(r), tick: r.f64() });
    const count = r.uint();
    for (let k = 0; k < count; k++) {
      const vessel = decodeVessel(rBytes(r), { resolver }).vessel;
      const m = fromIndex(MODES, r.u8(), 'mode');
      const attended = r.bool();
      const pilot = rOptStr(r);
      const bornTick = r.f64();
      const revision = r.f64();
      const rec = island.restoreMember(vessel, { bornTick, revision, pilot, attended });
      rec.mode = m;
      rec.tier = m === 'armed' ? 'armed' : 'full';
      rec.thresholdWatch = r.bool();
      rec.terrainRegime = r.bool();
      rec.trackHold = r.bool();
      rec.coastTime = r.f64();
      rec.forceIntegrate = r.bool();
      rec.nearOther = r.bool();
      rec.admittedFromHead = rOptTick(r);
      rec.reservation = fromIndex(RESERVATIONS, r.u8(), 'reservation state');
      if (r.bool()) {
        const r0 = rVec(r);
        const v0 = rVec(r);
        rec.orbit = orbitOf(island.frames, bodyId, { r: r0, v: v0 }, r.f64());
      }
      if (r.bool()) {
        const ev: RailsEvent = { ut: r.f64(), kind: fromIndex(EVENT_KINDS, r.u8(), 'event kind'), nextBodyId: null };
        ev.nextBodyId = rOptStr(r);
        rec.railsEvent = ev;
      }
    }
    const anchorSlot = r.uint();
    const anchor = island.anchorId;
    if ((anchorSlot === 0 ? null : (island.recs[anchorSlot - 1]?.vessel.id ?? '?')) !== anchor) throw new IslandOpError('format', 'the anchor the blob states is not the anchor of its members');
    for (let n = r.uint(); n > 0; n--) island.nascentPairs.push({ a: rStr(r), b: rStr(r) });
    for (let n = r.uint(); n > 0; n--) island.clearingPairs.push({ a: rStr(r), b: rStr(r), sinceTick: r.f64() });
    for (let n = r.uint(); n > 0; n--) island.captures.push({ a: rStr(r), b: rStr(r), aPort: r.uint(), bPort: r.uint(), state: rBytes(r), clampTicks: r.f64(), ageTicks: r.f64(), dwellTicks: r.f64() });
    for (let n = r.uint(); n > 0; n--) {
      const accountId = rStr(r);
      island.seats.set(accountId, { accountId, vesselId: rStr(r), controls: rControls(r), sasHold: r.bool() ? rVec(r) : null, reference: r.bool() ? 'orbit' : 'surface', latchOpenTick: rOptTick(r) });
    }
    for (let n = r.uint(); n > 0; n--) island.queue.push(rInput(r));
    if (r.left !== 0) throw new IslandOpError('format', `the body has ${r.left} bytes this version does not read`);
    if (o.names) {
      const nr = o.names;
      for (const rec of island.recs) {
        rec.vessel.name = rStr(nr);
        const crafts = nr.uint();
        if (crafts !== rec.vessel.crafts.length) throw new IslandOpError('format', `the names block names ${crafts} craft of "${rec.vessel.id}", which has ${rec.vessel.crafts.length}`);
        for (const c of rec.vessel.crafts) c.name = rStr(nr);
      }
    }
    return island;
  } catch (e) {
    if (e instanceof VesselDecodeError) throw new IslandOpError(e.problem === 'format' ? 'format' : 'vessel', e.message);
    throw e;
  }
}
