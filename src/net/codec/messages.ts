/**
 * The message table of the wire: for every message type of src/core/contracts/net.ts its one-byte code, who
 * may send it, how it is delivered, and its codec.
 *
 * Delivery: 'reliable' messages are never dropped; 'latest' messages carry a tick and are superseded by a
 * newer message with the same supersede key (ARCHITECTURE 13.1: a gateway drops a queued delta when a newer
 * one is ready; the same messages would survive an unreliable transport).
 *
 * Codes are part of the protocol: never renumber one; a new message takes a free code and bumps
 * WIRE_PROTOCOL_VERSION.
 */
import type {
  CensusDeltaDocument,
  CensusSnapshotDocument,
  RelevantDeltaMessage,
  RelevantFullMessage,
  WireMessage,
  WireMessageType,
  WorldlineMessage,
} from '@/core/contracts/net';
import { ByteWriter, WireEncodeError, type ByteReader } from './bytes';
import { documentEntry, readElements, readEntryList, readFrames, readSegments, randomElements, randomEntry, randomSegment, writeElements, writeEntryList, writeSegments, writeWithFrames } from './census';
import {
  assemblyView,
  clockState,
  conjunction,
  feedEvent,
  handle,
  lendPolicyPatch,
  padClass,
  padState,
  prompt,
  rosterEntry,
  sasMode,
  seatResult,
  shipRecord,
  spawnRequest,
  subscriptions,
  targetRef,
  timeOffer,
  universeRules,
  vec3,
  wireBlob,
} from './common';
import { simEvent } from './events';
import { DocumentStrings } from './handles';
import { inputAckCodec, inputCodec, islandDeltaCodec, islandKeyCodec, islandSlowCodec, nearCodec, type HotCodec } from './island';
import { array, blob, bool, enumOf, f64, id, name as clientName, nullable, ranged, str, struct, text, tick, uint, union, varUint, type Codec, type Fields, type Gen } from './schema';
import { WARP_LEVELS } from '@/core/contracts/defs';
import { WIRE_RANGES } from '@/core/contracts/net';

/** Who sends a message. */
export type Sender = 'client' | 'server' | 'both' | 'role' | 'document';
export type Delivery = 'reliable' | 'latest';

type MsgOf<K extends WireMessageType> = Extract<WireMessage, { type: K }>;

export interface MessageSpec<K extends WireMessageType = WireMessageType> {
  type: K;
  code: number;
  sender: Sender;
  delivery: Delivery;
  codec: Codec<MsgOf<K>>;
  /** The decode-into-frame path of a high-rate message. */
  hot?: HotCodec<MsgOf<K>>;
}

/** A codec of a message from the codec of its fields. */
function fieldsOf<K extends WireMessageType>(type: K, fields: Fields<Omit<MsgOf<K>, 'type'>>): Codec<MsgOf<K>> {
  const inner = struct<Omit<MsgOf<K>, 'type'>>(fields);
  return {
    min: inner.min,
    write: (w, v) => inner.write(w, v),
    read: (r) => ({ type, ...inner.read(r) }) as MsgOf<K>,
    random: (g) => ({ type, ...inner.random(g) }) as MsgOf<K>,
  };
}

/** A codec of a message written by hand (the `type` tag is added on read and on random). */
function handWritten<K extends WireMessageType>(type: K, c: Codec<Omit<MsgOf<K>, 'type'>>): Codec<MsgOf<K>> {
  return {
    min: c.min,
    write: (w, v) => c.write(w, v),
    read: (r) => ({ type, ...c.read(r) }) as MsgOf<K>,
    random: (g) => ({ type, ...c.random(g) }) as MsgOf<K>,
  };
}

const scratch = new ByteWriter(4096);
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_NONCE_BYTES = 256;
const MAX_SIGNATURE_BYTES = 512;
const MAX_ROUTE_BYTES = 8 * 1024 * 1024;

// --------------------------------------------------------------------------------- relevant set, census

const relevantFull: Codec<Omit<RelevantFullMessage, 'type'>> = {
  min: 11,
  write(w, v) {
    if (!Number.isSafeInteger(v.seq) || v.seq < 0 || !Number.isSafeInteger(v.tick)) throw new WireEncodeError('relevantFull: seq or tick');
    w.varUint(v.seq);
    w.f64(v.tick);
    writeWithFrames(w, scratch, false, (sw, frames) => writeEntryList(sw, v.entries, { baseTick: v.tick, frames, names: true }));
  },
  read(r) {
    const seq = r.varUint();
    const t = r.tick();
    const frames = readFrames(r, false);
    return { seq, tick: t, entries: readEntryList(r, { baseTick: t, frames, names: true }) };
  },
  random(g) {
    const t = tick.random(g) % 2 ** 51;
    return { seq: g.safeInt(1e9), tick: t, entries: Array.from({ length: g.int(0, 3) }, () => randomEntry(g, t)) };
  },
};

const relevantDelta: Codec<Omit<RelevantDeltaMessage, 'type'>> = {
  min: 15,
  write(w, v) {
    if (!Number.isSafeInteger(v.seq) || v.seq < 0 || !Number.isSafeInteger(v.baseSeq) || v.baseSeq < 0 || !Number.isSafeInteger(v.tick)) throw new WireEncodeError('relevantDelta: seq, baseSeq or tick');
    w.varUint(v.seq);
    w.varUint(v.baseSeq);
    w.f64(v.tick);
    writeWithFrames(w, scratch, false, (sw, frames) => {
      writeEntryList(sw, v.changed, { baseTick: v.tick, frames, names: true });
      array(handle, 1_000_000).write(sw, v.removed);
      writeElements(sw, v.elements, frames);
    });
  },
  read(r) {
    const seq = r.varUint();
    const baseSeq = r.varUint();
    const t = r.tick();
    const frames = readFrames(r, false);
    const changed = readEntryList(r, { baseTick: t, frames, names: true });
    const removed = array(handle, 1_000_000).read(r);
    return { seq, baseSeq, tick: t, changed, removed, elements: readElements(r, frames) };
  },
  random(g) {
    const t = tick.random(g) % 2 ** 51;
    return {
      seq: g.safeInt(1e9),
      baseSeq: g.safeInt(1e9),
      tick: t,
      changed: Array.from({ length: g.int(0, 2) }, () => randomEntry(g, t)),
      removed: Array.from({ length: g.int(0, 2) }, () => g.id(8)),
      elements: Array.from({ length: g.int(0, 2) }, () => randomElements(g)),
    };
  },
};

const worldline: Codec<Omit<WorldlineMessage, 'type'>> = {
  min: 20,
  write(w, v) {
    id.write(w, v.vesselId);
    tick.write(w, v.fromTick);
    tick.write(w, v.toTick);
    writeWithFrames(w, scratch, true, (sw, frames) => writeSegments(sw, v.segments, frames));
  },
  read(r) {
    const vesselId = id.read(r);
    const fromTick = r.tick();
    const toTick = r.tick();
    const frames = readFrames(r, true);
    return { vesselId, fromTick, toTick, segments: readSegments(r, frames) };
  },
  random: (g) => ({ vesselId: g.id(10), fromTick: g.safeInt(2 ** 50), toTick: g.safeInt(2 ** 50), segments: Array.from({ length: g.int(0, 3) }, () => randomSegment(g)) }),
};

/** Most ids one `names` or `nameInfo` message carries (the rules' `namesPerRequest` is at most this). */
export const MAX_NAMES_PER_MESSAGE = 256;

/** The strings of a census document's table: ids and craft names (UTF-8 of at most `WIRE_RANGES.maxIdBytes`). */
const tableString = str(WIRE_RANGES.maxIdBytes);

/** A census document: header, its own string table, then the frames and entries. */
function writeDocBody(w: ByteWriter, body: (sw: ByteWriter, strings: DocumentStrings) => void): void {
  const strings = new DocumentStrings();
  const inner = new ByteWriter(1024);
  inner.table = strings;
  body(inner, strings);
  if (strings.list.length > 4_000_000) throw new WireEncodeError('census document: too many strings');
  w.varUint(strings.list.length);
  for (const s of strings.list) tableString.write(w, s);
  w.raw(inner.bytes());
}

function readDocStrings(r: ByteReader): DocumentStrings {
  const strings = new DocumentStrings();
  const n = r.count(1, 4_000_000);
  const list: string[] = [];
  for (let i = 0; i < n && !r.failed; i++) list.push(tableString.read(r));
  strings.load(list);
  return strings;
}

const censusSnapshot: Codec<Omit<CensusSnapshotDocument, 'type'>> = {
  min: 30,
  write(w, v) {
    id.write(w, v.soi);
    uint.write(w, v.seq);
    f64.write(w, v.wallMs);
    tick.write(w, v.tick);
    f64.write(w, v.pollAfterS);
    writeDocBody(w, (sw) => writeWithFrames(sw, scratch, false, (s2, frames) => writeEntryList(s2, v.entries, { baseTick: v.tick, frames, names: false })));
  },
  read(r) {
    const soi = id.read(r);
    const seq = r.varUint();
    const wallMs = r.finiteF64();
    const t = r.tick();
    const pollAfterS = r.finiteF64();
    const outer = r.table;
    r.table = readDocStrings(r);
    const frames = readFrames(r, false);
    const entries = readEntryList(r, { baseTick: t, frames, names: false });
    r.table = outer;
    return { soi, seq, wallMs, tick: t, pollAfterS, entries };
  },
  random(g) {
    const t = tick.random(g) % 2 ** 51;
    return { soi: g.id(6), seq: g.safeInt(1e9), wallMs: g.f64(), tick: t, pollAfterS: g.f64(), entries: Array.from({ length: g.int(0, 3) }, () => documentEntry(randomEntry(g, t))) };
  },
};

const censusDelta: Codec<Omit<CensusDeltaDocument, 'type'>> = {
  min: 32,
  write(w, v) {
    id.write(w, v.soi);
    uint.write(w, v.seq);
    uint.write(w, v.baseSeq);
    f64.write(w, v.wallMs);
    tick.write(w, v.tick);
    f64.write(w, v.pollAfterS);
    writeDocBody(w, (sw) =>
      writeWithFrames(sw, scratch, false, (s2, frames) => {
        writeEntryList(s2, v.changed, { baseTick: v.tick, frames, names: false });
        array(handle, 1_000_000).write(s2, v.removed);
      }),
    );
  },
  read(r) {
    const soi = id.read(r);
    const seq = r.varUint();
    const baseSeq = r.varUint();
    const wallMs = r.finiteF64();
    const t = r.tick();
    const pollAfterS = r.finiteF64();
    const outer = r.table;
    r.table = readDocStrings(r);
    const frames = readFrames(r, false);
    const changed = readEntryList(r, { baseTick: t, frames, names: false });
    const removed = array(handle, 1_000_000).read(r);
    r.table = outer;
    return { soi, seq, baseSeq, wallMs, tick: t, pollAfterS, changed, removed };
  },
  random(g) {
    const t = tick.random(g) % 2 ** 51;
    return {
      soi: g.id(6),
      seq: g.safeInt(1e9),
      baseSeq: g.safeInt(1e9),
      wallMs: g.f64(),
      tick: t,
      pollAfterS: g.f64(),
      changed: Array.from({ length: g.int(0, 2) }, () => documentEntry(randomEntry(g, t))),
      removed: Array.from({ length: g.int(0, 2) }, () => g.id(8)),
    };
  },
};

// ------------------------------------------------------------------------------------------ the table

const resumeCodec = nullable(struct<{ session: string; relevantSeq: number | null }>({ session: text, relevantSeq: nullable(uint) }));

const wireCommand = union<import('@/core/contracts/net').WireCommand, 'kind'>('kind', {
  stage: {},
  abort: {},
  sas: { on: bool },
  sasMode: { mode: sasMode },
  rcs: { on: bool },
  legs: {},
  lights: {},
  fineControl: { on: bool },
  armPort: { portId: id, armed: bool },
  undock: { portId: id },
  controlPoint: { partKey: nullable(id) },
  requestHelm: {},
  grantHelm: { accountId: id },
  releaseHelm: {},
  lendPolicy: { craftId: id, policy: lendPolicyPatch },
  advanceLimit: { craftId: id, seconds: ranged(0, WIRE_RANGES.advanceLimitMaxSeconds) },
  transfer: { from: id, to: id, resource: id, rate: ranged(0, WIRE_RANGES.transferRateMax) },
  crossfeed: { portId: id, on: bool },
  rename: { craftId: id, name: clientName },
  abandon: { craftId: id },
  cycleVessel: { direction: enumOf([1, -1] as const) },
});

const timeRequest = union<import('@/core/contracts/net').TimeRequest, 'kind'>('kind', {
  setRate: { warpIndex: varUint(WARP_LEVELS.length - 1) },
  warpTo: { tick },
  jumpToTick: { tick },
  jumpToClock: { clockId: id },
  hold: { on: bool },
  link: { accountId: id },
  unlink: { accountId: id },
  follow: { accountId: nullable(id) },
  meet: { accountId: id, atTick: tick },
  reply: { proposalId: id, accept: bool },
  askAdvance: { vesselId: id },
});

const islandOpBody = union<import('@/core/contracts/net').IslandOpBody, 'op'>('op', {
  split: { slot: uint, cutJoints: array(uint, 4096), newVesselIds: array(id, 4096) },
  merge: { base: uint, other: uint, basePort: uint, otherPort: uint, rollStep: f64 },
  destroy: { slot: uint, parts: array(uint, 4096), cause: enumOf(['impact', 'overheat', 'overstress', 'explosion', 'collision'] as const) },
  capture: { a: uint, aPort: uint, b: uint, bPort: uint, state: blob(64 * 1024) },
  release: { a: uint, aPort: uint, b: uint, bPort: uint },
  add: { vesselId: id, vessel: wireBlob },
  remove: { slot: uint, reason: enumOf(['left', 'destroyed', 'removed'] as const) },
  rebase: { anchor: uint, bodyId: id, r: vec3, v: vec3 },
  replace: { slot: uint, vessel: wireBlob },
});

const checksum = struct<import('@/core/contracts/net').IslandOpChecksum>({ partCount: uint, craftHash: uint, massKg: f64 });

const SPECS: MessageSpec[] = [];
function add<K extends WireMessageType>(type: K, code: number, sender: Sender, delivery: Delivery, codec: Codec<MsgOf<K>>, hot?: HotCodec<MsgOf<K>>): void {
  SPECS.push({ type, code, sender, delivery, codec, ...(hot ? { hot } : {}) } as unknown as MessageSpec);
}


// Client -> server.
// FROZEN (version skew, review finding 15): the Hello (code 1) and `refused` (code 34) layouts and the order of
// `refused.reason` never change, so a peer of any version can say and read why it was refused. A new reason is
// appended at the end; tests/unit/net/review.test.ts holds their bytes.
add('hello', 1, 'client', 'reliable', fieldsOf('hello', { protocol: uint, build: id, defsHash: id, cpuScore: nullable(f64), resume: resumeCodec }));
add('auth', 2, 'client', 'reliable', fieldsOf('auth', { accountId: id, signature: blob(MAX_SIGNATURE_BYTES) }));
add('spawn', 3, 'client', 'reliable', fieldsOf('spawn', { reqId: uint, request: spawnRequest }));
add('attach', 4, 'client', 'reliable', fieldsOf('attach', { reqId: uint, vesselId: id, clockId: nullable(id) }));
add('detach', 5, 'client', 'reliable', fieldsOf('detach', { reqId: uint }));
add('spawnCancel', 6, 'client', 'reliable', fieldsOf('spawnCancel', { reqId: uint }));
// Reliable: each input message carries samples the next may not repeat (a resume sends its catch-up in several).
add('input', 7, 'client', 'reliable', inputCodec, inputCodec);
add('command', 8, 'client', 'reliable', fieldsOf('command', { cmdId: uint, tick, command: wireCommand }));
add('time', 9, 'client', 'reliable', fieldsOf('time', { cmdId: uint, tick, request: timeRequest }));
add('target', 10, 'client', 'reliable', fieldsOf('target', { ref: nullable(targetRef) }));
add('subscribe', 11, 'client', 'reliable', fieldsOf('subscribe', { change: subscriptions }));
add('plan', 12, 'client', 'reliable', fieldsOf('plan', { craftId: id, data: blob(MAX_PLAN_BYTES) }));
add('quick', 13, 'client', 'reliable', fieldsOf('quick', { phrase: id, toAccountId: nullable(id) }));
add('timeSync', 14, 'client', 'reliable', fieldsOf('timeSync', { seq: uint, clientMs: f64 }));
// Either side.
add('ping', 15, 'both', 'reliable', fieldsOf('ping', { seq: uint }));
add('pong', 16, 'both', 'reliable', fieldsOf('pong', { seq: uint }));
add('bye', 17, 'both', 'reliable', fieldsOf('bye', { reason: enumOf(['leave', 'drain', 'maintenance', 'lost'] as const), text }));
// Server -> client.
add('challenge', 32, 'server', 'reliable', fieldsOf('challenge', { nonce: blob(MAX_NONCE_BYTES), serverId: id }));
add(
  'welcome',
  33,
  'server',
  'reliable',
  fieldsOf('welcome', {
    session: text,
    accountId: id,
    callsign: id,
    rulesId: id,
    rulesVersion: uint,
    liveClock: clockState,
    serverMs: f64,
    upMs: f64,
    resumed: nullable(
      struct<import('@/core/contracts/net').ResumedSeat>({
        vesselId: nullable(id),
        queued: nullable(struct<Omit<import('@/core/contracts/net').SpawnQueuedMessage, 'type'>>({ reqId: uint, position: uint, etaSeconds: f64, serverMs: f64, padClass })),
        clockId: nullable(id),
        relevantSeq: nullable(uint),
        lastInputSeq: uint,
      }),
    ),
  }),
);
add(
  'refused',
  34,
  'server',
  'reliable',
  fieldsOf('refused', {
    reason: enumOf(['protocol', 'build', 'defsHash', 'auth', 'resume', 'standby', 'maintenance', 'full', 'malformed', 'outOfOrder', 'rateLimited', 'timeout'] as const),
    text,
    retryAfterMs: nullable(f64),
    queue: nullable(struct<{ position: number; etaSeconds: number }>({ position: uint, etaSeconds: f64 })),
  }),
);
add('takenOver', 35, 'server', 'reliable', fieldsOf('takenOver', { text }));
add('seatResult', 36, 'server', 'reliable', fieldsOf('seatResult', { reqId: uint, result: seatResult }));
add('spawnQueued', 37, 'server', 'reliable', fieldsOf('spawnQueued', { reqId: uint, position: uint, etaSeconds: f64, serverMs: f64, padClass }));
add('handles', 38, 'server', 'reliable', fieldsOf('handles', { entries: array(struct<{ handle: number; id: string }>({ handle: uint, id: text }), 1_000_000) }));
add('clock', 39, 'server', 'reliable', fieldsOf('clock', { role: enumOf(['own', 'live'] as const), clock: clockState, maxRate: f64, offers: array(timeOffer, 64) }));
add('islandEnter', 40, 'server', 'reliable', fieldsOf('islandEnter', { island: uint, islandId: id, epoch: uint, tick, members: array(id, 65536), state: wireBlob }));
add('islandOp', 41, 'server', 'reliable', fieldsOf('islandOp', { island: uint, epoch: uint, tick, seq: uint, body: islandOpBody, checksum: nullable(checksum) }));
add('islandKey', 42, 'server', 'latest', islandKeyCodec, islandKeyCodec);
add('islandDelta', 43, 'server', 'latest', islandDeltaCodec, islandDeltaCodec);
add('inputAck', 44, 'server', 'reliable', inputAckCodec, inputAckCodec);
// Reliable: a slow message covers only the parts of its round-robin turn, so a newer one does not replace it.
add('islandSlow', 45, 'server', 'reliable', islandSlowCodec);
add('event', 46, 'server', 'reliable', fieldsOf('event', { tick, epoch: uint, event: simEvent }));
add('commandResult', 47, 'server', 'reliable', fieldsOf('commandResult', { cmdId: uint, ok: bool, appliedTick: nullable(tick), reason: nullable(text), alternative: nullable(timeOffer) }));
add('nearOrigin', 48, 'server', 'reliable', fieldsOf('nearOrigin', { island: uint, bodyId: id, tick, r: vec3, v: vec3 }));
add('near', 49, 'server', 'latest', nearCodec, nearCodec);
add('relevantFull', 50, 'server', 'reliable', handWritten('relevantFull', relevantFull));
add('relevantDelta', 51, 'server', 'reliable', handWritten('relevantDelta', relevantDelta));
add('worldline', 52, 'server', 'reliable', handWritten('worldline', worldline));
// The view models that replace the whole list are latest-wins per type (lead decision of 2026-11-16).
add('conjunctions', 53, 'server', 'latest', fieldsOf('conjunctions', { list: array(conjunction, 4096) }));
add('durable', 54, 'server', 'latest', fieldsOf('durable', { tick }));
add('pads', 55, 'server', 'latest', fieldsOf('pads', { pads: array(padState, 4096) }));
add('ships', 56, 'server', 'latest', fieldsOf('ships', { ships: array(shipRecord, 1024) }));
add('assembly', 57, 'server', 'latest', fieldsOf('assembly', { view: nullable(assemblyView) }));
add(
  'roster',
  58,
  'server',
  'latest',
  fieldsOf('roster', { filter: enumOf(['nearby', 'docked', 'lobby'] as const), cursor: nullable(id), next: nullable(id), entries: array(rosterEntry, 4096) }),
);
add('prompts', 59, 'server', 'latest', fieldsOf('prompts', { prompts: array(prompt, 256) }));
add('feed', 60, 'server', 'reliable', fieldsOf('feed', { events: array(feedEvent, 4096) }));
add('rules', 61, 'server', 'reliable', fieldsOf('rules', { rules: universeRules }));
add('notice', 62, 'server', 'reliable', fieldsOf('notice', { kind: enumOf(['recovering', 'draining', 'maintenance', 'buildChange', 'resync', 'keepOut', 'info'] as const), text, untilUpMs: nullable(f64) }));
add('timeSyncReply', 63, 'server', 'reliable', fieldsOf('timeSyncReply', { seq: uint, clientMs: f64, serverRecvMs: f64, serverSendMs: f64, upMs: f64 }));
add(
  'rateLimited',
  64,
  'server',
  'reliable',
  fieldsOf('rateLimited', { what: enumOf(['command', 'time', 'seat', 'subscribe', 'plan', 'quick', 'target', 'input', 'names'] as const), dropped: uint, ids: array(uint, 64), retryAfterMs: f64 }),
);
// Names as static metadata (net.ts `NamesMessage`): the codec bounds a request to MAX_NAMES_PER_MESSAGE ids,
// the gateway to the rules' `namesPerRequest`.
add('names', 18, 'client', 'reliable', fieldsOf('names', { vessels: array(id, MAX_NAMES_PER_MESSAGE), accounts: array(id, MAX_NAMES_PER_MESSAGE) }));
add(
  'nameInfo',
  65,
  'server',
  'reliable',
  fieldsOf('nameInfo', { vessels: array(struct({ id, name: str(WIRE_RANGES.maxIdBytes) }), MAX_NAMES_PER_MESSAGE), accounts: array(struct({ id, callsign: id }), MAX_NAMES_PER_MESSAGE) }),
);
// Role to role.
add('route', 96, 'role', 'reliable', fieldsOf('route', { route: uint, payload: blob(MAX_ROUTE_BYTES) }));
// Public documents (HTTP).
add('censusSnapshot', 112, 'document', 'reliable', handWritten('censusSnapshot', censusSnapshot));
add('censusDelta', 113, 'document', 'reliable', handWritten('censusDelta', censusDelta));

/** Every message spec, by type and by code. */
export const MESSAGE_SPECS: readonly MessageSpec[] = SPECS;
const BY_TYPE = new Map<string, MessageSpec>(SPECS.map((s) => [s.type, s]));
const BY_CODE: (MessageSpec | undefined)[] = new Array(256);
for (const s of SPECS) {
  if (BY_CODE[s.code]) throw new Error(`duplicate message code ${s.code}`);
  BY_CODE[s.code] = s;
}

export function specOf<K extends WireMessageType>(type: K): MessageSpec<K> {
  const s = BY_TYPE.get(type);
  if (!s) throw new WireEncodeError(`unknown message type ${type}`);
  return s as unknown as MessageSpec<K>;
}

export function specByCode(code: number): MessageSpec | undefined {
  return BY_CODE[code];
}

/** A random valid instance of a message type (the round-trip suites). */
export function randomMessage<K extends WireMessageType>(type: K, g: Gen): MsgOf<K> {
  return specOf(type).codec.random(g);
}

/**
 * The key under which a 'latest' message supersedes an older queued one (null for reliable messages): the
 * type, and the island for island frames.
 */
export function supersedeKey(m: WireMessage): string | null {
  switch (m.type) {
    case 'islandKey':
    case 'islandDelta':
      return `${m.type}:${m.island}`;
    case 'near':
      return `near:${m.band}`;
    case 'durable':
    case 'conjunctions':
    case 'pads':
    case 'ships':
    case 'assembly':
    case 'roster':
    case 'prompts':
      return m.type;
    default:
      return null;
  }
}

/**
 * Keys of queued records a message makes useless: a key of an island makes the queued deltas of that island
 * useless (they are against an older key the client will no longer hold when they arrive).
 */
export function obsoletedKeys(m: WireMessage): string | null {
  return m.type === 'islandKey' ? `islandDelta:${m.island}` : null;
}

/**
 * Whether a delta can be applied by a receiver that holds the key at `heldKeyTick` of island `heldIsland`: a
 * delta is always against the last key, never another (ARCHITECTURE 13.4); anything else is dropped.
 */
export function deltaMatchesKey(delta: { island: number; keyTick: number }, heldIsland: number | null, heldKeyTick: number | null): boolean {
  return heldIsland !== null && heldKeyTick !== null && delta.island === heldIsland && delta.keyTick === heldKeyTick;
}
