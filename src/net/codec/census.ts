/**
 * The census entry codec (ARCHITECTURE 13.3, 14): one encoding of a `CensusEntry` for the relevant set on
 * the socket (strings as session handles) and for the public census documents (strings in the document's
 * own table). About 84 bytes for a coasting ship with one patch.
 *
 * A message or document that carries entries starts with a FRAME TABLE: the (body id, mu) pairs its conics
 * use, each patch naming its frame by index. Ticks inside an entry are signed varints relative to the
 * message's base tick (the head) and to the head (the other ticks of the entry), so a tick costs 3-5 bytes
 * instead of 8; the base tick itself is a float64.
 *
 * Conics travel in a canonical form (`writeConic` / `readConic`): six float64 elements (p, e, inc, lan,
 * argPe, tPeriapsis), `a` only when it is not p / (1 - e^2) computed as `conicFromState` computes it (the
 * (near-)radial orbits of src/sim/orbit, whose `a` is 1/alpha), and a closed flag. P, Q, W and the period are
 * recomputed from them with IEEE operations and the runtime's sin/cos: equal to the sender's to a few ulps,
 * and a decoded conic re-encodes to the same bytes.
 */
import type { CensusEntry, CensusKind, CensusPatch, OsculatingElements, WorldlineSegment } from '@/core/contracts/net';
import type { ConicElements } from '@/core/math/conic';
import type { Vec3 } from '@/core/math/vec3';
import { MAX_VARINT_SIGNED, WireEncodeError, type ByteReader, type ByteWriter } from './bytes';
import { exhaustive, handle, handleOrNull, vec3 } from './common';
import { array, id, type Codec, type Gen } from './schema';

const PARABOLIC_EPS = 1e-9;

/** The (body, mu) pairs the conics of one message use. */
export class FrameTable {
  readonly bodies: string[] = [];
  readonly mus: number[] = [];

  /** Index of (bodyId, mu), added when new. */
  indexOf(bodyId: string, mu: number): number {
    for (let i = 0; i < this.bodies.length; i++) if (this.bodies[i] === bodyId && Object.is(this.mus[i], mu)) return i;
    if (!(mu > 0) || !Number.isFinite(mu)) throw new WireEncodeError(`conic: mu ${mu} is not a positive finite number`);
    this.bodies.push(bodyId);
    this.mus.push(mu);
    return this.bodies.length - 1;
  }

  /** Write the table (count, then body id and mu per frame); body ids as handles unless `inline`. */
  write(w: ByteWriter, inline = false): void {
    w.varUint(this.bodies.length);
    for (let i = 0; i < this.bodies.length; i++) {
      (inline ? id : handle).write(w, this.bodies[i]!);
      w.f64(this.mus[i]!);
    }
  }

  /** Read a table into this (empty) one. */
  read(r: ByteReader, inline = false): void {
    const n = r.count(9, 4096);
    for (let i = 0; i < n; i++) {
      const b = (inline ? id : handle).read(r);
      const mu = r.finiteF64();
      if (r.failed) return;
      if (!(mu > 0)) {
        r.fail('badValue');
        return;
      }
      this.bodies.push(b);
      this.mus.push(mu);
    }
  }
}

/** `a` as conicFromState derives it from p and e. */
function derivedA(p: number, e: number): number {
  const oneMinusE2 = 1 - e * e;
  return Math.abs(oneMinusE2) < PARABOLIC_EPS ? Infinity : p / oneMinusE2;
}

/** Rebuild the canonical conic from its elements (P, Q, W from the three angles; the period from a and mu). */
export function expandConic(mu: number, p: number, e: number, inc: number, lan: number, argPe: number, tPeriapsis: number, a: number, closed: boolean): ConicElements {
  const cO = Math.cos(lan);
  const sO = Math.sin(lan);
  const cI = Math.cos(inc);
  const sI = Math.sin(inc);
  const cw = Math.cos(argPe);
  const sw = Math.sin(argPe);
  const P: Vec3 = { x: cO * cw - sO * sw * cI, y: sO * cw + cO * sw * cI, z: sw * sI };
  const Q: Vec3 = { x: -cO * sw - sO * cw * cI, y: -sO * sw + cO * cw * cI, z: cw * sI };
  const W: Vec3 = { x: sO * sI, y: -cO * sI, z: cI };
  const period = closed ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : null;
  return { mu, p, e, a, P, Q, W, tPeriapsis, period, inc, lan, argPe };
}

/** The canonical form of a conic (what the receiver of `c` will hold). */
export function canonicalConic(c: ConicElements): ConicElements {
  return expandConic(c.mu, c.p, c.e, c.inc, c.lan, c.argPe, c.tPeriapsis, c.a, c.period !== null);
}

const CF_A = 1;
const CF_CLOSED = 2;

/** Write a conic's elements and flags; the frame (body, mu) is written by the caller. */
export function writeConic(w: ByteWriter, c: ConicElements): void {
  for (const [k, v] of [
    ['p', c.p],
    ['e', c.e],
    ['inc', c.inc],
    ['lan', c.lan],
    ['argPe', c.argPe],
    ['tPeriapsis', c.tPeriapsis],
  ] as const) {
    if (!Number.isFinite(v)) throw new WireEncodeError(`conic.${k}: ${v} is not finite`);
  }
  if (!(c.p >= 0) || !(c.e >= 0)) throw new WireEncodeError('conic: p and e must be non-negative');
  const dA = derivedA(c.p, c.e);
  const sendA = !Object.is(dA, c.a);
  if (sendA && !Number.isFinite(c.a)) throw new WireEncodeError(`conic.a: ${c.a} is neither finite nor what p and e give`);
  if (c.period !== null && !Number.isFinite(c.a)) throw new WireEncodeError('conic: a closed conic needs a finite a');
  w.u8((sendA ? CF_A : 0) | (c.period !== null ? CF_CLOSED : 0));
  w.f64(c.p);
  w.f64(c.e);
  w.f64(c.inc);
  w.f64(c.lan);
  w.f64(c.argPe);
  w.f64(c.tPeriapsis);
  if (sendA) w.f64(c.a);
}

export function readConic(r: ByteReader, mu: number): ConicElements {
  const flags = r.u8();
  if (flags > 3) r.fail('badEnum');
  const p = r.finiteF64();
  const e = r.finiteF64();
  const inc = r.finiteF64();
  const lan = r.finiteF64();
  const argPe = r.finiteF64();
  const tPeriapsis = r.finiteF64();
  const a = flags & CF_A ? r.finiteF64() : derivedA(p, e);
  if (!(p >= 0) || !(e >= 0)) r.fail('badValue');
  if (flags & CF_CLOSED && !Number.isFinite(a)) r.fail('badValue');
  return expandConic(mu, p, e, inc, lan, argPe, tPeriapsis, a, (flags & CF_CLOSED) !== 0);
}

/** A random conic in canonical form (round trips exactly). */
export function randomConic(g: Gen, mu: number): ConicElements {
  const e = g.pick([0, g.next() * 0.99, 1 + g.next() * 3, 1 - 2 ** -53]);
  const p = g.pick([0, 6.7e6 + g.next() * 1e6, g.next() * 1e12]);
  const closed = e < 1 && g.chance(0.9);
  const a = g.chance(0.2) ? (g.next() + 0.5) * 7e6 : derivedA(p, e);
  const safeA = closed && !Number.isFinite(a) ? 7e6 : a;
  return expandConic(mu, p, e, g.next() * Math.PI, (g.next() - 0.5) * 2 * Math.PI, (g.next() - 0.5) * 2 * Math.PI, (g.next() - 0.5) * 1e10, safeA, closed);
}

// ---------------------------------------------------------------------------------------------- entries

const KINDS = exhaustive<CensusKind>()(['ship', 'assembly', 'debris', 'wreck'] as const);

// Flag bits of an entry.
const E_THRUST = 4;
const E_LANDED = 8;
const E_HORIZON = 16;
const E_LIMIT = 32;
const E_EXPIRES = 64;
const E_TRIVIAL_CRAFT = 128;
const E2_CLOCK = 1;
const E2_RESERVED = 2;
// Flag bits of a patch.
const P_FORECAST = 1;
const P_FROM_CHAIN = 2;
const P_TO_END = 4;

/** The context of one message's entries: its base tick, and its frame table. */
export interface EntryContext {
  baseTick: number;
  frames: FrameTable;
}

function signedDelta(name: string, v: number, base: number): number {
  if (!Number.isSafeInteger(v)) throw new WireEncodeError(`${name}: ${v} is not a tick`);
  const d = v - base;
  if (!Number.isSafeInteger(d) || Math.abs(d) > MAX_VARINT_SIGNED) throw new WireEncodeError(`${name}: ${v} is too far from ${base}`);
  return d;
}

/** Centimetres of a radius, rounded up (a decoded radius cm / 100 gives back cm). */
function radiusCm(r: number): number {
  if (!(r >= 0) || !Number.isFinite(r)) throw new WireEncodeError(`radius: ${r} is not a non-negative finite number`);
  const c = Math.round(r * 100);
  return c / 100 >= r ? c : c + 1;
}

/** Round a radius up to the wire's 1 cm grid. */
export function canonicalRadius(r: number): number {
  return radiusCm(r) / 100;
}

export function writeEntry(w: ByteWriter, e: CensusEntry, ctx: EntryContext): void {
  const n = e.craftIds.length;
  if (e.ownerIds.length !== n || e.ownerCallsigns.length !== n) throw new WireEncodeError(`census entry ${e.vesselId}: ownerIds and ownerCallsigns must be parallel to craftIds`);
  const kind = KINDS.indexOf(e.kind);
  if (kind < 0) throw new WireEncodeError(`census entry: unknown kind ${String(e.kind)}`);
  const trivial = n === 1 && e.craftIds[0] === e.vesselId;
  const head = e.headTick;
  w.u8(
    kind |
      (e.thrusting ? E_THRUST : 0) |
      (e.landed ? E_LANDED : 0) |
      (e.horizonTick !== null ? E_HORIZON : 0) |
      (e.limitTick !== null ? E_LIMIT : 0) |
      (e.expiresWallMs !== null ? E_EXPIRES : 0) |
      (trivial ? E_TRIVIAL_CRAFT : 0),
  );
  w.u8((e.clockId !== null ? E2_CLOCK : 0) | (e.reservedBy !== null ? E2_RESERVED : 0));
  handle.write(w, e.vesselId);
  handle.write(w, e.name);
  handle.write(w, e.vehicleId);
  if (!trivial) {
    if (n > 4096) throw new WireEncodeError('census entry: more than 4096 craft');
    w.varUint(n);
    for (const c of e.craftIds) handle.write(w, c);
  }
  for (let i = 0; i < n; i++) {
    handleOrNull.write(w, e.ownerIds[i]!);
    handleOrNull.write(w, e.ownerCallsigns[i]!);
  }
  handle.write(w, e.bodyId);
  w.varInt(signedDelta('headTick', head, ctx.baseTick));
  if (e.horizonTick !== null) w.varInt(signedDelta('horizonTick', e.horizonTick, head));
  w.varInt(signedDelta('chainEndTick', e.chainEndTick, head));
  if (e.clockId !== null) handle.write(w, e.clockId);
  if (e.reservedBy !== null) handle.write(w, e.reservedBy);
  if (e.limitTick !== null) w.varInt(signedDelta('limitTick', e.limitTick, head));
  w.varUint(radiusCm(e.radius));
  if (e.expiresWallMs !== null) {
    if (!Number.isSafeInteger(e.expiresWallMs) || e.expiresWallMs < 0) throw new WireEncodeError(`expiresWallMs: ${e.expiresWallMs} is not whole ms`);
    w.varUint(e.expiresWallMs);
  }
  if (!Number.isSafeInteger(e.revision) || e.revision < 0) throw new WireEncodeError(`revision: ${e.revision}`);
  w.varUint(e.revision);
  if (e.landed) {
    handle.write(w, e.landed.bodyId);
    for (const v of [e.landed.latitude, e.landed.longitude, e.landed.altitude]) {
      if (!Number.isFinite(v)) throw new WireEncodeError('landed: not finite');
      w.f64(v);
    }
  }
  if (e.patches.length > 1024) throw new WireEncodeError('census entry: more than 1024 patches');
  w.varUint(e.patches.length);
  let prevTo = head;
  for (const p of e.patches) {
    const fromChain = p.fromTick === prevTo;
    const toEnd = p.toTick === e.chainEndTick;
    w.u8((p.forecast ? P_FORECAST : 0) | (fromChain ? P_FROM_CHAIN : 0) | (toEnd ? P_TO_END : 0));
    w.varUint(ctx.frames.indexOf(p.bodyId, p.conic.mu));
    writeConic(w, p.conic);
    if (!fromChain) w.varInt(signedDelta('patch.fromTick', p.fromTick, head));
    if (!toEnd) w.varInt(signedDelta('patch.toTick', p.toTick, p.fromTick));
    prevTo = p.toTick;
  }
}

function frameAt(r: ByteReader, frames: FrameTable): number {
  const i = r.varUint();
  if (i >= frames.bodies.length) {
    r.fail('badValue');
    return 0;
  }
  return i;
}

const MIN_ENTRY_BYTES = 12;

export function readEntry(r: ByteReader, ctx: EntryContext): CensusEntry {
  const f1 = r.u8();
  const f2 = r.u8();
  if (f2 > 3) r.fail('badEnum');
  const vesselId = handle.read(r);
  const name = handle.read(r);
  const vehicleId = handle.read(r);
  let craftIds: string[];
  if (f1 & E_TRIVIAL_CRAFT) craftIds = [vesselId];
  else {
    const n = r.count(1, 4096);
    craftIds = new Array<string>(n);
    for (let i = 0; i < n; i++) craftIds[i] = handle.read(r);
  }
  const ownerIds: (string | null)[] = [];
  const ownerCallsigns: (string | null)[] = [];
  for (let i = 0; i < craftIds.length && !r.failed; i++) {
    ownerIds.push(handleOrNull.read(r));
    ownerCallsigns.push(handleOrNull.read(r));
  }
  const bodyId = handle.read(r);
  const headTick = ctx.baseTick + r.varInt();
  const horizonTick = f1 & E_HORIZON ? headTick + r.varInt() : null;
  const chainEndTick = headTick + r.varInt();
  const clockId = f2 & E2_CLOCK ? handle.read(r) : null;
  const reservedBy = f2 & E2_RESERVED ? handle.read(r) : null;
  const limitTick = f1 & E_LIMIT ? headTick + r.varInt() : null;
  const radius = r.varUint() / 100;
  const expiresWallMs = f1 & E_EXPIRES ? r.varUint() : null;
  const revision = r.varUint();
  let landed: CensusEntry['landed'] = null;
  if (f1 & E_LANDED) landed = { bodyId: handle.read(r), latitude: r.finiteF64(), longitude: r.finiteF64(), altitude: r.finiteF64() };
  const np = r.count(50, 1024);
  const patches: CensusPatch[] = [];
  let prevTo = headTick;
  for (let i = 0; i < np && !r.failed; i++) {
    const pf = r.u8();
    if (pf > 7) r.fail('badEnum');
    const fi = frameAt(r, ctx.frames);
    const conic = readConic(r, ctx.frames.mus[fi] ?? 1);
    const fromTick = pf & P_FROM_CHAIN ? prevTo : headTick + r.varInt();
    const toTick = pf & P_TO_END ? chainEndTick : fromTick + r.varInt();
    if (!Number.isSafeInteger(fromTick) || !Number.isSafeInteger(toTick)) r.fail('badTick');
    patches.push({ bodyId: ctx.frames.bodies[fi] ?? '', conic, fromTick, toTick, forecast: (pf & P_FORECAST) !== 0 });
    prevTo = toTick;
  }
  for (const t of [headTick, chainEndTick, horizonTick ?? 0, limitTick ?? 0]) if (!Number.isSafeInteger(t)) r.fail('badTick');
  return {
    vesselId,
    craftIds,
    kind: KINDS[f1 & 3]!,
    name,
    vehicleId,
    ownerIds,
    ownerCallsigns,
    bodyId,
    patches,
    landed,
    headTick,
    horizonTick,
    chainEndTick,
    clockId,
    reservedBy,
    limitTick,
    radius,
    expiresWallMs,
    thrusting: (f1 & E_THRUST) !== 0,
    revision,
  };
}

/** A random entry in canonical form. */
export function randomEntry(g: Gen, baseTick: number): CensusEntry {
  const nCraft = g.chance(0.6) ? 1 : g.int(1, 4);
  const vesselId = g.id(10) || 'v';
  const craftIds = nCraft === 1 && g.chance(0.6) ? [vesselId] : Array.from({ length: nCraft }, () => g.id(10));
  const head = baseTick + g.int(-5e8, 5e8);
  const chainEnd = head + g.int(0, 2e7);
  const patches: CensusPatch[] = [];
  let t = g.chance(0.7) ? head : head + g.int(-100, 100);
  const np = g.chance(0.2) ? 0 : g.int(1, 3);
  for (let i = 0; i < np; i++) {
    const mu = g.pick([3.986004418e14, 4.9048695e12, 1.32712440018e20]);
    const to = i === np - 1 && g.chance(0.7) ? chainEnd : t + g.int(0, 1e7);
    patches.push({ bodyId: g.pick(['earth', 'moon', 'sun']), conic: randomConic(g, mu), fromTick: t, toTick: to, forecast: g.chance(0.5) });
    t = g.chance(0.8) ? to : to + g.int(1, 50);
  }
  return {
    vesselId,
    craftIds,
    kind: g.pick(KINDS),
    name: g.str(14),
    vehicleId: g.id(12),
    ownerIds: craftIds.map(() => (g.chance(0.2) ? null : g.id(12))),
    ownerCallsigns: craftIds.map(() => (g.chance(0.2) ? null : g.id(8))),
    bodyId: g.pick(['earth', 'moon', 'mars']),
    patches,
    landed: g.chance(0.15) ? { bodyId: 'moon', latitude: g.f64(), longitude: g.f64(), altitude: g.f64() } : null,
    headTick: head,
    horizonTick: g.chance(0.5) ? null : head + g.int(0, 1e8),
    chainEndTick: chainEnd,
    clockId: g.chance(0.6) ? null : g.id(8),
    reservedBy: g.chance(0.8) ? null : g.id(8),
    limitTick: g.chance(0.3) ? null : head + g.int(-1e9, 1e9),
    radius: g.int(0, 200000) / 100,
    expiresWallMs: g.chance(0.3) ? null : g.safeInt(4e12),
    thrusting: g.chance(0.2),
    revision: g.safeInt(1e9),
  };
}

/**
 * Write what `body` writes, preceded by the frame table its conics used: `body` writes into `scratch` (which
 * shares `w`'s string table) while the table is collected, then the table and the scratch bytes go to `w`.
 */
export function writeWithFrames(w: ByteWriter, scratch: ByteWriter, inline: boolean, body: (sw: ByteWriter, frames: FrameTable) => void): void {
  const frames = new FrameTable();
  scratch.reset();
  scratch.table = w.table;
  body(scratch, frames);
  frames.write(w, inline);
  w.raw(scratch.bytes());
}

export function readFrames(r: ByteReader, inline: boolean): FrameTable {
  const frames = new FrameTable();
  frames.read(r, inline);
  return frames;
}

export function writeEntryList(w: ByteWriter, entries: readonly CensusEntry[], ctx: EntryContext): void {
  if (entries.length > 1_000_000) throw new WireEncodeError('more than 1,000,000 entries');
  w.varUint(entries.length);
  for (const e of entries) writeEntry(w, e, ctx);
}

export function readEntryList(r: ByteReader, ctx: EntryContext): CensusEntry[] {
  const n = r.count(MIN_ENTRY_BYTES, 1_000_000);
  const entries: CensusEntry[] = [];
  for (let i = 0; i < n && !r.failed; i++) entries.push(readEntry(r, ctx));
  return r.failed ? [] : entries;
}

// --------------------------------------------------------------------------- elements and worldlines

export function writeElements(w: ByteWriter, list: readonly OsculatingElements[], frames: FrameTable): void {
  w.varUint(list.length);
  for (const el of list) {
    handle.write(w, el.vesselId);
    if (!Number.isSafeInteger(el.tick)) throw new WireEncodeError(`elements.tick: ${el.tick}`);
    w.f64(el.tick);
    w.varUint(frames.indexOf(el.bodyId, el.conic.mu));
    writeConic(w, el.conic);
  }
}

export function readElements(r: ByteReader, frames: FrameTable): OsculatingElements[] {
  const n = r.count(59, 100_000);
  const out: OsculatingElements[] = [];
  for (let i = 0; i < n && !r.failed; i++) {
    const vesselId = handle.read(r);
    const tick = r.tick();
    const fi = frameAt(r, frames);
    out.push({ vesselId, tick, bodyId: frames.bodies[fi] ?? '', conic: readConic(r, frames.mus[fi] ?? 1) });
  }
  return out;
}

export function randomElements(g: Gen): OsculatingElements {
  const mu = g.pick([3.986004418e14, 4.9048695e12]);
  return { vesselId: g.id(10), tick: g.safeInt(2 ** 50), bodyId: g.pick(['earth', 'moon']), conic: randomConic(g, mu) };
}

const SEG_CONIC = 0;
const SEG_ARC = 1;
const SEG_REST = 2;

export function writeSegments(w: ByteWriter, segs: readonly WorldlineSegment[], frames: FrameTable): void {
  if (segs.length > 100_000) throw new WireEncodeError('worldline: more than 100,000 segments');
  w.varUint(segs.length);
  for (const s of segs) {
    if (s.kind !== 'arc' && (!Number.isSafeInteger(s.fromTick) || !Number.isSafeInteger(s.toTick))) throw new WireEncodeError('worldline: a tick is not an integer');
    if (s.kind === 'conic') {
      w.u8(SEG_CONIC);
      w.varUint(frames.indexOf(s.bodyId, s.conic.mu));
      writeConic(w, s.conic);
      w.f64(s.fromTick);
      w.f64(s.toTick);
    } else if (s.kind === 'arc') {
      w.u8(SEG_ARC);
      id.write(w, s.bodyId);
      array(arcSample, 1_000_000).write(w, s.samples);
    } else {
      w.u8(SEG_REST);
      id.write(w, s.bodyId);
      for (const v of [s.latitude, s.longitude, s.altitude]) {
        if (!Number.isFinite(v)) throw new WireEncodeError('worldline rest: not finite');
        w.f64(v);
      }
      w.f64(s.fromTick);
      w.f64(s.toTick);
    }
  }
}

type ArcSample = Extract<WorldlineSegment, { kind: 'arc' }>['samples'][number];
const arcSample: Codec<ArcSample> = {
  min: 56,
  write(w, v) {
    if (!Number.isSafeInteger(v.tick)) throw new WireEncodeError(`arc sample tick: ${v.tick}`);
    w.f64(v.tick);
    vec3.write(w, v.r);
    vec3.write(w, v.v);
  },
  read: (r) => ({ tick: r.tick(), r: vec3.read(r), v: vec3.read(r) }),
  random: (g) => ({ tick: g.safeInt(2 ** 50), r: vec3.random(g), v: vec3.random(g) }),
};

export function readSegments(r: ByteReader, frames: FrameTable): WorldlineSegment[] {
  const n = r.count(2, 100_000);
  const out: WorldlineSegment[] = [];
  for (let i = 0; i < n && !r.failed; i++) {
    const k = r.u8();
    if (k === SEG_CONIC) {
      const fi = frameAt(r, frames);
      const conic = readConic(r, frames.mus[fi] ?? 1);
      out.push({ kind: 'conic', bodyId: frames.bodies[fi] ?? '', conic, fromTick: r.tick(), toTick: r.tick() });
    } else if (k === SEG_ARC) {
      out.push({ kind: 'arc', bodyId: id.read(r), samples: array(arcSample, 1_000_000).read(r) });
    } else if (k === SEG_REST) {
      out.push({ kind: 'rest', bodyId: id.read(r), latitude: r.finiteF64(), longitude: r.finiteF64(), altitude: r.finiteF64(), fromTick: r.tick(), toTick: r.tick() });
    } else r.fail('badEnum');
  }
  return out;
}

export function randomSegment(g: Gen): WorldlineSegment {
  const k = g.int(0, 2);
  if (k === 0) return { kind: 'conic', bodyId: g.pick(['earth', 'moon']), conic: randomConic(g, 3.986004418e14), fromTick: g.safeInt(2 ** 50), toTick: g.safeInt(2 ** 50) };
  if (k === 1) return { kind: 'arc', bodyId: g.id(6), samples: array(arcSample, 4).random(g) };
  return { kind: 'rest', bodyId: g.id(6), latitude: g.f64(), longitude: g.f64(), altitude: g.f64(), fromTick: g.safeInt(2 ** 50), toTick: g.safeInt(2 ** 50) };
}
