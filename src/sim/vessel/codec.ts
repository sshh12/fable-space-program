/**
 * The vessel codec (docs/ARCHITECTURE.md 7.2): the complete dynamic state of a vessel as bytes, exact in
 * every regime, versioned because ships outlive deploys. Used by persistence, hand-over between workers,
 * keyframes, and (through `stateHash`) the determinism checks.
 *
 * Exact: every float64 is written so that it reads back bit for bit: NaN and the infinities by a tag of
 * their own, the sign of zero kept.
 *
 * Layout:
 *
 *   magic 'FSPV' | u16 codec version | string defsHash       the header: what wrote the blob, under which library
 *   blocks: [u8 tag | varuint byte length | payload] ...      the body; a tag of 0 ends it
 *
 * Blocks of this version: STRINGS (every string of the body, referenced by index), DEFS (the id and the
 * FINGERPRINT of every part definition in use), CRAFTS (each with its vehicle reference: a library id plus
 * the content hash of that VehicleDef, or an embedded design), VESSEL (the vessel-level state), PARTS
 * (each part a length-prefixed record whose resource block and module blocks are length-prefixed in turn),
 * CARRIED (contact, wetness and wake state). A block this build does not know is reported and skipped,
 * never mis-read. A module or resource block whose content does not fit the part's definition is an error
 * unless the migration registry (./migrations) holds the way from the fingerprint the blob was written
 * under to the current one.
 *
 * Definitions never travel by index into a library: vehicles and parts are resolved through an injected
 * `DefResolver`.
 *
 * The STATE HASH is the hash of the body: it does not depend on `defsHash` (a change of an unrelated
 * definition does not move it), only on what the vessel is and which definitions its parts and craft use.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import { hashU32 } from '@/core/math/hash';
import { cloneModuleState, createCraft, createModuleRt, createModuleState, createPart, emptyVessel } from './assemble';
import { computeMassProps } from './massProps';
import { MIGRATIONS, type MigrationRegistry, type SavedModule, type SavedPart } from './migrations';
import type { CarriedState, CraftRuntime, HoldKind, ModuleRt, PartRuntime, PendingAction, SurfaceState, Vessel } from './types';

/** Version this build writes. Version 1 wrote the carried probe states as one flag byte per probe; version 2 writes three bit sets. */
export const CODEC_VERSION = 2;
/** Versions this build reads. */
export const CODEC_VERSIONS_READ: readonly number[] = [1, 2];

const MAGIC = [0x46, 0x53, 0x50, 0x56];

const BLOCK_END = 0;
const BLOCK_STRINGS = 1;
const BLOCK_DEFS = 2;
const BLOCK_CRAFTS = 3;
const BLOCK_VESSEL = 4;
const BLOCK_PARTS = 5;
const BLOCK_CARRIED = 6;

// ------------------------------------------------------------------------------------------------ errors

export type DecodeProblem = 'format' | 'version' | 'vehicle' | 'part' | 'fingerprint' | 'block';

/** Why a blob cannot be decoded. `problem` says which rule failed; the message names the craft, part or block. */
export class VesselDecodeError extends Error {
  constructor(
    readonly problem: DecodeProblem,
    message: string,
  ) {
    super(`vessel codec: ${message}`);
    this.name = 'VesselDecodeError';
  }
}

// ------------------------------------------------------------------------------------------- definitions

/** How a craft names its vehicle: a library id with the content hash of that VehicleDef, or the design itself. */
export type VehicleRef = { kind: 'library'; id: string; hash: string } | { kind: 'embedded'; design: VehicleDef };

/** Resolves the definitions a blob names. Injected: the codec never indexes a library itself. */
export interface DefResolver {
  /** The vehicle a library reference names (the library's current one for that id), or null when it has none. */
  vehicle(ref: Extract<VehicleRef, { kind: 'library' }>): VehicleDef | null;
  /** The part definition of that id, or null when there is none. */
  part(defId: string): PartDef | null;
}

/** Says how a craft's vehicle is written: by reference when the reader will have it, embedded otherwise. */
export interface VehicleRefSource {
  refOf(vehicle: VehicleDef): VehicleRef;
}

const f64 = new Float64Array(1);
const f64Bytes = new Uint8Array(f64.buffer);
const f32 = new Float32Array(1);

/** Hash of bytes as 16 hex digits (two 32-bit lanes). */
export function hashBytes(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  a = hashU32((a ^ (to - from)) >>> 0);
  for (let i = from; i < to; i += 4) {
    const at = (k: number): number => (i + k < to ? bytes[i + k]! : 0);
    const w = (at(0) | (at(1) << 8) | (at(2) << 16) | (at(3) << 24)) >>> 0;
    a = hashU32((a ^ w) >>> 0);
    b = hashU32((Math.imul(b, 31) + w) >>> 0);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** JSON with the keys of every object sorted: equal content gives equal text. */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Content hash of a definition (its canonical JSON). */
export function contentHash(def: unknown): string {
  return hashBytes(utf8.encode(canonicalJson(def)));
}

const fingerprints = new WeakMap<PartDef, string>();
/**
 * Fingerprint of a part definition: what its saved state depends on. A change of its modules, its
 * resources or its mass is a new fingerprint (and needs an entry in the migration registry); a change of
 * its looks, bounds or aerodynamics is not.
 */
export function partFingerprint(def: PartDef): string {
  let f = fingerprints.get(def);
  if (f === undefined) {
    f = contentHash({ dryMass: def.dryMass, resources: def.resources ?? [], modules: def.modules, thermalSurfaces: def.thermal.surfaces.length });
    fingerprints.set(def, f);
  }
  return f;
}

const vehicleHashes = new WeakMap<VehicleDef, string>();
export function vehicleHash(vehicle: VehicleDef): string {
  let h = vehicleHashes.get(vehicle);
  if (h === undefined) {
    h = contentHash(vehicle);
    vehicleHashes.set(vehicle, h);
  }
  return h;
}

/** A vehicle named by its id and content, whoever holds it: the reference a state hash is computed with. */
export const REFS_BY_CONTENT: VehicleRefSource = { refOf: (vehicle) => ({ kind: 'library', id: vehicle.id, hash: vehicleHash(vehicle) }) };

/**
 * Resolver and reference source over a definition library: a craft whose vehicle is the library's own is
 * written by reference, any other design is embedded.
 */
export function libraryResolver(defs: DefLibrary): DefResolver & VehicleRefSource {
  return {
    vehicle: (ref) => defs.vehicles[ref.id] ?? null,
    part: (defId) => defs.parts[defId] ?? null,
    refOf: (vehicle) => (defs.vehicles[vehicle.id] === vehicle ? { kind: 'library', id: vehicle.id, hash: vehicleHash(vehicle) } : { kind: 'embedded', design: vehicle }),
  };
}

// ------------------------------------------------------------------------------------------------- bytes

class Writer {
  private buf = new Uint8Array(1024);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  u8(x: number): void {
    this.room(1);
    this.buf[this.length++] = x & 0xff;
  }
  bool(x: boolean): void {
    this.u8(x ? 1 : 0);
  }
  u16(x: number): void {
    this.u8(x);
    this.u8(x >>> 8);
  }
  /** Unsigned integer below 2^53, seven bits per byte. */
  uint(x: number): void {
    if (!Number.isInteger(x) || x < 0) throw new Error(`vessel codec: ${x} is not an unsigned integer`);
    while (x >= 0x80) {
      this.u8((x % 0x80) | 0x80);
      x = Math.floor(x / 0x80);
    }
    this.u8(x);
  }
  /** Signed integer (zigzag). */
  int(x: number): void {
    this.uint(x < 0 ? -2 * x - 1 : 2 * x);
  }
  /** A float64, eight raw bytes: exact for every value. */
  f64(x: number): void {
    f64[0] = x;
    this.room(8);
    this.buf.set(f64Bytes, this.length);
    this.length += 8;
  }
  /**
   * A float64 in its shortest exact form, by tag: +0, -0, NaN, +Infinity, -Infinity, a small integer, a
   * value a float32 holds exactly, or the eight raw bytes.
   */
  num(x: number): void {
    if (x === 0) this.u8(Object.is(x, -0) ? 1 : 0);
    else if (Number.isNaN(x)) this.u8(2);
    else if (x === Infinity) this.u8(3);
    else if (x === -Infinity) this.u8(4);
    else if (Number.isInteger(x) && x >= -0x8000 && x < 0x8000) {
      if (x >= 0 && x < 200) this.u8(16 + x);
      else {
        this.u8(5);
        this.u16(x & 0xffff);
      }
    } else if (Math.fround(x) === x) {
      this.u8(6);
      f32[0] = x;
      const b = new Uint8Array(f32.buffer);
      this.room(4);
      this.buf.set(b, this.length);
      this.length += 4;
    } else {
      this.u8(7);
      this.f64(x);
    }
  }
  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  /** A length-prefixed run of bytes. */
  block(b: Writer): void {
    this.uint(b.length);
    this.bytes(b.done());
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

class Reader {
  at: number;
  constructor(
    private readonly buf: Uint8Array,
    from = 0,
    private readonly end = buf.length,
  ) {
    this.at = from;
  }
  get left(): number {
    return this.end - this.at;
  }
  private need(n: number): void {
    if (this.at + n > this.end) throw new VesselDecodeError('format', 'the data ends inside a value');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.at++]!;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    const lo = this.u8();
    return lo | (this.u8() << 8);
  }
  uint(): number {
    let x = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      x += (b & 0x7f) * scale;
      if (b < 0x80) return x;
      scale *= 0x80;
    }
    throw new VesselDecodeError('format', 'an integer is longer than 53 bits');
  }
  int(): number {
    const z = this.uint();
    return z % 2 === 1 ? -(z + 1) / 2 : z / 2;
  }
  f64(): number {
    this.need(8);
    f64Bytes.set(this.buf.subarray(this.at, this.at + 8));
    this.at += 8;
    return f64[0]!;
  }
  num(): number {
    const tag = this.u8();
    switch (tag) {
      case 0:
        return 0;
      case 1:
        return -0;
      case 2:
        return NaN;
      case 3:
        return Infinity;
      case 4:
        return -Infinity;
      case 5: {
        const u = this.u16();
        return u >= 0x8000 ? u - 0x10000 : u;
      }
      case 6: {
        this.need(4);
        new Uint8Array(f32.buffer).set(this.buf.subarray(this.at, this.at + 4));
        this.at += 4;
        return f32[0]!;
      }
      case 7:
        return this.f64();
      default:
        if (tag >= 16 && tag < 216) return tag - 16;
        throw new VesselDecodeError('format', `unknown number tag ${tag}`);
    }
  }
  /** A reader over the next length-prefixed run of bytes. */
  block(): Reader {
    const n = this.uint();
    this.need(n);
    const r = new Reader(this.buf, this.at, this.at + n);
    this.at += n;
    return r;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

/** Interns the strings of a body. */
class Strings {
  private readonly index = new Map<string, number>();
  readonly list: string[] = [];
  ref(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.index.set(s, i);
      this.list.push(s);
    }
    return i;
  }
}

// --------------------------------------------------------------------------------------- plain data form

const PLAIN_NULL = 0;
const PLAIN_FALSE = 1;
const PLAIN_TRUE = 2;
const PLAIN_NUMBER = 3;
const PLAIN_STRING = 4;
const PLAIN_ARRAY = 5;
const PLAIN_OBJECT = 6;

/** Plain data (numbers, booleans, strings, null, arrays, objects) in a self-describing form: keys by string reference, in the order of the object. */
function writePlain(w: Writer, st: Strings, x: unknown): void {
  if (x === null || x === undefined) w.u8(PLAIN_NULL);
  else if (x === false) w.u8(PLAIN_FALSE);
  else if (x === true) w.u8(PLAIN_TRUE);
  else if (typeof x === 'number') {
    w.u8(PLAIN_NUMBER);
    w.num(x);
  } else if (typeof x === 'string') {
    w.u8(PLAIN_STRING);
    w.uint(st.ref(x));
  } else if (Array.isArray(x)) {
    w.u8(PLAIN_ARRAY);
    w.uint(x.length);
    for (const e of x) writePlain(w, st, e);
  } else {
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    w.u8(PLAIN_OBJECT);
    w.uint(keys.length);
    for (const k of keys) {
      w.uint(st.ref(k));
      writePlain(w, st, o[k]);
    }
  }
}

function readPlain(r: Reader, strings: readonly string[]): unknown {
  const tag = r.u8();
  switch (tag) {
    case PLAIN_NULL:
      return null;
    case PLAIN_FALSE:
      return false;
    case PLAIN_TRUE:
      return true;
    case PLAIN_NUMBER:
      return r.num();
    case PLAIN_STRING:
      return str(strings, r.uint());
    case PLAIN_ARRAY: {
      const n = r.uint();
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(readPlain(r, strings));
      return out;
    }
    case PLAIN_OBJECT: {
      const n = r.uint();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const k = str(strings, r.uint());
        out[k] = readPlain(r, strings);
      }
      return out;
    }
    default:
      throw new VesselDecodeError('format', `unknown value tag ${tag}`);
  }
}

function str(strings: readonly string[], i: number): string {
  const s = strings[i];
  if (s === undefined) throw new VesselDecodeError('format', `string ${i} is not in the table`);
  return s;
}

/** True when `x` has the shape of `model`: the same keys with values of the same kind, arrays of the same length. */
function sameShape(model: unknown, x: unknown): boolean {
  if (model === null || x === null) return model === x || typeof model === 'number' || typeof x === 'number';
  if (Array.isArray(model)) return Array.isArray(x) && x.length === model.length && model.every((m, i) => sameShape(m, x[i]));
  if (typeof model === 'object') {
    if (typeof x !== 'object' || Array.isArray(x)) return false;
    const a = Object.keys(model as object);
    const b = Object.keys(x as object);
    return a.length === b.length && a.every((k) => k in (x as object) && sameShape((model as Record<string, unknown>)[k], (x as Record<string, unknown>)[k]));
  }
  return typeof model === typeof x;
}

// ------------------------------------------------------------------------------------------------ encode

const HOLDS: readonly (HoldKind | null)[] = [null, 'clamps', 'ground', 'asleep'];
const SURFACES: readonly SurfaceState[] = ['none', 'prelaunch', 'landed', 'splashed'];

const vec = (w: Writer, v: { x: number; y: number; z: number }): void => {
  w.f64(v.x);
  w.f64(v.y);
  w.f64(v.z);
};
const quatOut = (w: Writer, q: { x: number; y: number; z: number; w: number }): void => {
  w.f64(q.x);
  w.f64(q.y);
  w.f64(q.z);
  w.f64(q.w);
};
const optStr = (w: Writer, st: Strings, s: string | null): void => {
  w.uint(s === null ? 0 : st.ref(s) + 1);
};
const controlsOut = (w: Writer, c: ControlInputs): void => {
  w.num(c.pitch);
  w.num(c.yaw);
  w.num(c.roll);
  w.num(c.translate.x);
  w.num(c.translate.y);
  w.num(c.translate.z);
  w.num(c.throttle);
};

function writeCrafts(st: Strings, crafts: readonly CraftRuntime[], refs: VehicleRefSource): Writer {
  const w = new Writer();
  w.uint(crafts.length);
  for (const c of crafts) {
    w.uint(st.ref(c.craftId));
    const ref = refs.refOf(c.vehicle);
    if (ref.kind === 'library') {
      w.u8(0);
      w.uint(st.ref(ref.id));
      w.uint(st.ref(ref.hash));
    } else {
      w.u8(1);
      const json = utf8.encode(canonicalJson(ref.design));
      w.uint(json.length);
      w.bytes(json);
    }
    optStr(w, st, c.ownerId);
    w.uint(st.ref(c.name));
    w.num(c.joinedTick);
    w.uint(c.nextStage);
    w.num(c.stageLockout);
    w.num(c.sinceStaging);
    w.bool(c.policy.lendAttitude);
    w.bool(c.policy.lendEngines);
    w.bool(c.policy.lendPropellant);
    writePlain(w, st, c.policy.helm);
    w.uint(c.pending.length);
    for (const pa of c.pending) {
      w.num(pa.timeLeft);
      w.int(pa.stageIndex);
      writePlain(w, st, pa.action);
    }
  }
  return w;
}

function writeVesselCore(st: Strings, v: Vessel): Writer {
  const w = new Writer();
  w.uint(st.ref(v.id));
  w.uint(st.ref(v.name));
  optStr(w, st, v.helm.accountId);
  w.uint(v.helm.craft);
  w.uint(v.helm.controlPart);
  w.uint(v.links.length);
  for (const l of v.links) {
    w.uint(l.a);
    w.uint(l.b);
    w.num(l.roll);
  }
  vec(w, v.r);
  vec(w, v.v);
  quatOut(w, v.q);
  vec(w, v.w);
  w.num(v.age);
  w.num(v.stepCount);
  const s = v.sas;
  w.bool(s.enabled);
  w.uint(st.ref(s.mode));
  w.bool(s.holdDir !== null);
  if (s.holdDir) vec(w, s.holdDir);
  quatOut(w, s.target);
  w.bool(s.hasTarget);
  for (let i = 0; i < 3; i++) {
    w.bool(s.inputActive[i]!);
    w.num(s.releaseTimer[i]!);
    w.num(s.hold[i]!);
    w.num(s.integral[i]!);
    w.num(s.externalTorque[i]!);
  }
  w.bool(v.rcsEnabled);
  w.bool(v.fineControl);
  w.bool(v.lightsOn);
  w.num(v.throttle);
  controlsOut(w, v.appliedControls);
  w.u8(HOLDS.indexOf(v.hold));
  w.bool(v.anchor !== null);
  if (v.anchor) {
    vec(w, v.anchor.rFixed);
    quatOut(w, v.anchor.qFixed);
  }
  w.u8(SURFACES.indexOf(v.surface));
  w.f64(v.mp.mass);
  vec(w, v.mp.com);
  for (let i = 0; i < 6; i++) w.f64(v.mp.i[i]!);
  for (let i = 0; i < 6; i++) w.f64(v.mp.inv[i]!);
  const a = v.aero;
  w.num(a.q);
  w.num(a.mach);
  w.num(a.aoa);
  w.num(a.density);
  w.num(a.pressure);
  w.num(a.temperature);
  vec(w, a.airVelocity);
  w.num(a.heatFlux);
  w.num(a.plasmaIntensity);
  w.bool(a.liftDirVes !== null);
  if (a.liftDirVes) vec(w, a.liftDirVes);
  vec(w, a.force);
  vec(w, a.torque);
  w.num(v.thrust);
  for (let i = 0; i < 3; i++) w.num(v.authority[i]!);
  w.num(v.gLoad);
  vec(w, v.properAccel);
  w.num(v.gDose);
  w.bool(v.crewAlive);
  w.bool(v.contact.anyContact);
  w.num(v.contact.maxForce);
  w.num(v.contact.waterSubmersion);
  w.num(v.groundClearance);
  w.num(v.restTimer);
  w.num(v.splashTimer);
  w.num(v.airborneTime);
  w.bool(v.inWater);
  w.bool(v.destroyed);
  return w;
}

function writeParts(st: Strings, v: Vessel, defIndex: Map<PartDef, number>): Writer {
  const w = new Writer();
  w.uint(v.parts.length);
  for (const p of v.parts) {
    const rec = new Writer();
    rec.uint(st.ref(p.instanceId));
    rec.uint(defIndex.get(p.def)!);
    rec.uint(p.craft);
    rec.uint(p.parent + 1);
    rec.uint(st.ref(p.stageGroup));
    vec(rec, p.pos);
    // The identity attitude of a stack part is one flag.
    const identity = p.rot.x === 0 && p.rot.y === 0 && p.rot.z === 0 && p.rot.w === 1 && !Object.is(p.rot.x, -0) && !Object.is(p.rot.y, -0) && !Object.is(p.rot.z, -0);
    rec.bool(identity);
    if (!identity) quatOut(rec, p.rot);
    const res = new Writer();
    const defs = p.def.resources ?? [];
    res.uint(p.resources.length);
    for (let k = 0; k < p.resources.length; k++) {
      res.uint(st.ref(defs[k]?.resource ?? ''));
      res.num(p.resources[k]!);
    }
    rec.block(res);
    rec.uint(p.temps.length);
    for (const t of p.temps) rec.num(t);
    rec.bool(p.shielded);
    rec.bool(p.panel !== null);
    if (p.panel) {
      rec.uint(p.panel.index);
      rec.uint(p.panel.count);
    }
    rec.num(p.stress);
    rec.bool(p.command !== null);
    if (p.command) writePlain(rec, st, p.command);
    rec.uint(p.modules.length);
    for (let m = 0; m < p.modules.length; m++) {
      const block = new Writer();
      writePlain(block, st, p.modules[m]);
      writePlain(block, st, p.rt[m]);
      rec.uint(st.ref(p.modules[m]!.type));
      rec.block(block);
    }
    w.block(rec);
  }
  return w;
}

function writeCarried(c: CarriedState | null, version: number): Writer {
  const w = new Writer();
  w.bool(c !== null);
  if (!c) return w;
  w.uint(c.probes.length);
  if (version === 1) {
    for (const p of c.probes) {
      w.u8((p.inContact ? 1 : 0) | (p.wet ? 2 : 0) | (p.hasAnchor ? 4 : 0));
      if (p.hasAnchor) {
        w.f64(p.ax);
        w.f64(p.ay);
        w.f64(p.az);
      }
    }
  } else {
    // Three bit sets (touching, wet, anchored), then the anchors of the anchored probes.
    for (const pick of [(p: CarriedState['probes'][number]) => p.inContact, (p: CarriedState['probes'][number]) => p.wet, (p: CarriedState['probes'][number]) => p.hasAnchor]) {
      for (let i = 0; i < c.probes.length; i += 8) {
        let b = 0;
        for (let k = 0; k < 8 && i + k < c.probes.length; k++) if (pick(c.probes[i + k]!)) b |= 1 << k;
        w.u8(b);
      }
    }
    for (const p of c.probes) {
      if (!p.hasAnchor) continue;
      w.f64(p.ax);
      w.f64(p.ay);
      w.f64(p.az);
    }
  }
  w.uint(c.buoyWet.length);
  for (const b of c.buoyWet) w.bool(b);
  w.uint(c.wake.length);
  for (const x of c.wake) w.num(x);
  return w;
}

/** The body of a blob (everything after the header) in a given layout version. */
function writeBody(vessel: Vessel, refs: VehicleRefSource, version: number): Uint8Array {
  const st = new Strings();
  const defIndex = new Map<PartDef, number>();
  const defs = new Writer();
  const defList: PartDef[] = [];
  for (const p of vessel.parts) {
    if (!defIndex.has(p.def)) {
      defIndex.set(p.def, defList.length);
      defList.push(p.def);
    }
  }
  defs.uint(defList.length);
  for (const d of defList) {
    defs.uint(st.ref(d.id));
    defs.uint(st.ref(partFingerprint(d)));
  }
  const crafts = writeCrafts(st, vessel.crafts, refs);
  const core = writeVesselCore(st, vessel);
  const parts = writeParts(st, vessel, defIndex);
  const carried = writeCarried(vessel.carried, version);
  const strings = new Writer();
  strings.uint(st.list.length);
  for (const s of st.list) {
    const b = utf8.encode(s);
    strings.uint(b.length);
    strings.bytes(b);
  }
  const out = new Writer();
  for (const [tag, block] of [
    [BLOCK_STRINGS, strings],
    [BLOCK_DEFS, defs],
    [BLOCK_CRAFTS, crafts],
    [BLOCK_VESSEL, core],
    [BLOCK_PARTS, parts],
    [BLOCK_CARRIED, carried],
  ] as const) {
    out.u8(tag);
    out.block(block);
  }
  out.u8(BLOCK_END);
  return out.done();
}

export interface EncodeOptions {
  /** Hash of the definition library the blob is written under (the header says so; it is not part of the state hash). */
  defsHash: string;
  /** How each craft's vehicle is written. Default: by id and content hash. */
  refs?: VehicleRefSource;
  /** Layout version to write (for the corpus of earlier versions). Default: CODEC_VERSION. */
  version?: number;
}

/** The complete dynamic state of a vessel as bytes. */
export function encodeVessel(vessel: Vessel, options: EncodeOptions): Uint8Array {
  const version = options.version ?? CODEC_VERSION;
  if (!CODEC_VERSIONS_READ.includes(version)) throw new Error(`vessel codec: cannot write version ${version}`);
  const body = writeBody(vessel, options.refs ?? REFS_BY_CONTENT, version);
  const head = new Writer();
  for (const b of MAGIC) head.u8(b);
  head.u16(version);
  const hash = utf8.encode(options.defsHash);
  head.uint(hash.length);
  head.bytes(hash);
  head.bytes(body);
  return head.done();
}

/**
 * Hash of the complete dynamic state of a vessel: the hash of its codec body. Two vessels with the same
 * hash are the same state under the same definitions.
 */
export function stateHash(vessel: Vessel, refs: VehicleRefSource = REFS_BY_CONTENT): string {
  return hashBytes(writeBody(vessel, refs, CODEC_VERSION));
}

// ------------------------------------------------------------------------------------------------ decode

export interface DecodeReport {
  /** Codec version and library hash the blob was written with. */
  version: number;
  defsHash: string;
  /** Block tags this build does not know (skipped, not read). */
  unknownBlocks: number[];
  /** Parts whose definition changed since the blob was written and that were brought forward by the registry. */
  migrated: { part: string; defId: string; from: string; to: string; steps: string[] }[];
  /** Craft whose library vehicle has another content hash now than when the blob was written. */
  vehicleChanged: { craftId: string; vehicleId: string; written: string; current: string }[];
}

export interface DecodeOptions {
  resolver: DefResolver;
  /** Default: the registry of released migrations. */
  migrations?: MigrationRegistry;
}

const vecIn = (r: Reader): { x: number; y: number; z: number } => ({ x: r.f64(), y: r.f64(), z: r.f64() });
const quatIn = (r: Reader): { x: number; y: number; z: number; w: number } => ({ x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() });
const optStrIn = (r: Reader, strings: readonly string[]): string | null => {
  const i = r.uint();
  return i === 0 ? null : str(strings, i - 1);
};

/** Read the header of a blob without decoding it: its version, the library hash it was written under, and where the body starts. */
export function readHeader(bytes: Uint8Array): { version: number; defsHash: string; bodyAt: number } {
  const r = new Reader(bytes);
  for (const b of MAGIC) if (r.left < 1 || r.u8() !== b) throw new VesselDecodeError('format', 'not a vessel blob (the magic bytes are missing)');
  const version = r.u16();
  const n = r.uint();
  const defsHash = utf8Decoder.decode(r.bytes(n));
  return { version, defsHash, bodyAt: r.at };
}

/**
 * Rebuild a vessel from bytes. Vehicles and parts are resolved through `options.resolver`; a part whose
 * definition has another fingerprint than the one the blob was written under goes through the migration
 * registry (resource amounts clamped to the new capacities, mass properties recomputed) or the decode
 * fails naming it. Throws `VesselDecodeError`; never returns a vessel it could not read whole.
 */
export function decodeVessel(bytes: Uint8Array, options: DecodeOptions): { vessel: Vessel; report: DecodeReport } {
  const head = readHeader(bytes);
  if (!CODEC_VERSIONS_READ.includes(head.version)) throw new VesselDecodeError('version', `codec version ${head.version} is not one this build reads (${CODEC_VERSIONS_READ.join(', ')})`);
  const report: DecodeReport = { version: head.version, defsHash: head.defsHash, unknownBlocks: [], migrated: [], vehicleChanged: [] };
  const blocks = new Map<number, Reader>();
  const r = new Reader(bytes, head.bodyAt);
  for (;;) {
    const tag = r.u8();
    if (tag === BLOCK_END) break;
    const block = r.block();
    if (tag >= BLOCK_STRINGS && tag <= BLOCK_CARRIED) blocks.set(tag, block);
    else report.unknownBlocks.push(tag);
  }
  const need = (tag: number, name: string): Reader => {
    const b = blocks.get(tag);
    if (!b) throw new VesselDecodeError('format', `the ${name} block is missing`);
    return b;
  };

  // Strings.
  const sr = need(BLOCK_STRINGS, 'strings');
  const strings: string[] = [];
  for (let n = sr.uint(), i = 0; i < n; i++) strings.push(utf8Decoder.decode(sr.bytes(sr.uint())));

  // Part definitions in use, with the fingerprint each was written under.
  const dr = need(BLOCK_DEFS, 'definitions');
  const written: { id: string; fingerprint: string; def: PartDef }[] = [];
  for (let n = dr.uint(), i = 0; i < n; i++) {
    const id = str(strings, dr.uint());
    const fingerprint = str(strings, dr.uint());
    const def = options.resolver.part(id);
    if (!def) throw new VesselDecodeError('part', `part definition "${id}" is not known`);
    written.push({ id, fingerprint, def });
  }

  // Craft.
  const cr = need(BLOCK_CRAFTS, 'craft');
  const crafts: CraftRuntime[] = [];
  for (let n = cr.uint(), i = 0; i < n; i++) {
    const craftId = str(strings, cr.uint());
    const kind = cr.u8();
    let vehicle: VehicleDef;
    if (kind === 0) {
      const id = str(strings, cr.uint());
      const hash = str(strings, cr.uint());
      const found = options.resolver.vehicle({ kind: 'library', id, hash });
      if (!found) throw new VesselDecodeError('vehicle', `craft "${craftId}": vehicle "${id}" (content ${hash}) is not known`);
      vehicle = found;
      const current = vehicleHash(found);
      if (current !== hash) report.vehicleChanged.push({ craftId, vehicleId: id, written: hash, current });
    } else if (kind === 1) {
      vehicle = JSON.parse(utf8Decoder.decode(cr.bytes(cr.uint()))) as VehicleDef;
    } else throw new VesselDecodeError('format', `craft "${craftId}": unknown vehicle reference kind ${kind}`);
    const c = createCraft(vehicle, { craftId });
    c.ownerId = optStrIn(cr, strings);
    c.name = str(strings, cr.uint());
    c.joinedTick = cr.num();
    c.nextStage = cr.uint();
    c.stageLockout = cr.num();
    c.sinceStaging = cr.num();
    c.policy = { lendAttitude: cr.bool(), lendEngines: cr.bool(), lendPropellant: cr.bool(), helm: readPlain(cr, strings) as CraftRuntime['policy']['helm'] };
    for (let k = cr.uint(), j = 0; j < k; j++) {
      const timeLeft = cr.num();
      const stageIndex = cr.int();
      c.pending.push({ timeLeft, stageIndex, action: readPlain(cr, strings) as PendingAction['action'] });
    }
    crafts.push(c);
  }
  if (crafts.length === 0) throw new VesselDecodeError('format', 'a vessel has at least one craft');

  // Vessel-level state.
  const vr = need(BLOCK_VESSEL, 'vessel');
  const v = emptyVessel(str(strings, vr.uint()), str(strings, vr.uint()), crafts[0]!);
  v.crafts = crafts;
  v.helm = { accountId: optStrIn(vr, strings), craft: vr.uint(), controlPart: vr.uint() };
  for (let n = vr.uint(), i = 0; i < n; i++) v.links.push({ a: vr.uint(), b: vr.uint(), roll: vr.num() });
  v.r = vecIn(vr);
  v.v = vecIn(vr);
  v.q = quatIn(vr);
  v.w = vecIn(vr);
  v.age = vr.num();
  v.stepCount = vr.num();
  const s = v.sas;
  s.enabled = vr.bool();
  s.mode = str(strings, vr.uint()) as typeof s.mode;
  s.holdDir = vr.bool() ? vecIn(vr) : null;
  s.target = quatIn(vr);
  s.hasTarget = vr.bool();
  for (let i = 0; i < 3; i++) {
    s.inputActive[i] = vr.bool();
    s.releaseTimer[i] = vr.num();
    s.hold[i] = vr.num();
    s.integral[i] = vr.num();
    s.externalTorque[i] = vr.num();
  }
  v.rcsEnabled = vr.bool();
  v.fineControl = vr.bool();
  v.lightsOn = vr.bool();
  v.throttle = vr.num();
  v.appliedControls = { pitch: vr.num(), yaw: vr.num(), roll: vr.num(), translate: { x: vr.num(), y: vr.num(), z: vr.num() }, throttle: vr.num() };
  v.hold = HOLDS[vr.u8()] ?? null;
  v.anchor = vr.bool() ? { rFixed: vecIn(vr), qFixed: quatIn(vr) } : null;
  v.surface = SURFACES[vr.u8()] ?? 'none';
  v.mp.mass = vr.f64();
  v.mp.com = vecIn(vr);
  for (let i = 0; i < 6; i++) v.mp.i[i] = vr.f64();
  for (let i = 0; i < 6; i++) v.mp.inv[i] = vr.f64();
  const a = v.aero;
  a.q = vr.num();
  a.mach = vr.num();
  a.aoa = vr.num();
  a.density = vr.num();
  a.pressure = vr.num();
  a.temperature = vr.num();
  a.airVelocity = vecIn(vr);
  a.heatFlux = vr.num();
  a.plasmaIntensity = vr.num();
  a.liftDirVes = vr.bool() ? vecIn(vr) : null;
  a.force = vecIn(vr);
  a.torque = vecIn(vr);
  v.thrust = vr.num();
  for (let i = 0; i < 3; i++) v.authority[i] = vr.num();
  v.gLoad = vr.num();
  v.properAccel = vecIn(vr);
  v.gDose = vr.num();
  v.crewAlive = vr.bool();
  v.contact = { anyContact: vr.bool(), maxForce: vr.num(), waterSubmersion: vr.num() };
  v.groundClearance = vr.num();
  v.restTimer = vr.num();
  v.splashTimer = vr.num();
  v.airborneTime = vr.num();
  v.inWater = vr.bool();
  v.destroyed = vr.bool();
  if (vr.left !== 0) throw new VesselDecodeError('block', `the vessel block has ${vr.left} bytes this version does not read`);

  // Parts.
  const pr = need(BLOCK_PARTS, 'parts');
  const migrations = options.migrations ?? MIGRATIONS;
  let anyMigrated = false;
  for (let n = pr.uint(), i = 0; i < n; i++) {
    const rec = pr.block();
    const instanceId = str(strings, rec.uint());
    const w = written[rec.uint()];
    if (!w) throw new VesselDecodeError('format', `part "${instanceId}": its definition is not in the table`);
    const craft = rec.uint();
    const parent = rec.uint() - 1;
    const stageGroup = str(strings, rec.uint());
    const pos = vecIn(rec);
    const rot = rec.bool() ? { x: 0, y: 0, z: 0, w: 1 } : quatIn(rec);
    const resBlock = rec.block();
    const resources: SavedPart['resources'] = [];
    for (let k = resBlock.uint(), j = 0; j < k; j++) resources.push({ resource: str(strings, resBlock.uint()), amount: resBlock.num() });
    if (resBlock.left !== 0) throw new VesselDecodeError('block', `part "${instanceId}": the resource block has ${resBlock.left} bytes this version does not read`);
    const temps: number[] = [];
    for (let k = rec.uint(), j = 0; j < k; j++) temps.push(rec.num());
    const shielded = rec.bool();
    const panel = rec.bool() ? { index: rec.uint(), count: rec.uint() } : null;
    const stress = rec.num();
    const command = rec.bool() ? (readPlain(rec, strings) as PartRuntime['command']) : null;
    const modules: SavedModule[] = [];
    for (let k = rec.uint(), j = 0; j < k; j++) {
      const type = str(strings, rec.uint());
      const block = rec.block();
      const state = readPlain(block, strings) as Record<string, unknown>;
      const rt = readPlain(block, strings) as Record<string, unknown>;
      if (block.left !== 0) throw new VesselDecodeError('block', `part "${instanceId}": the block of module ${j} ("${type}") has ${block.left} bytes this version does not read`);
      modules.push({ type, state, rt });
    }
    if (rec.left !== 0) throw new VesselDecodeError('block', `part "${instanceId}": the part record has ${rec.left} bytes this version does not read`);
    if (!crafts[craft]) throw new VesselDecodeError('format', `part "${instanceId}": craft ${craft} does not exist`);

    // The saved state belongs to the fingerprint it was written under: bring it to the current definition.
    let saved: SavedPart = { instanceId, defId: w.id, fingerprint: w.fingerprint, resources, modules, temps };
    const current = partFingerprint(w.def);
    if (saved.fingerprint !== current) {
      const path = migrations.path(w.id, saved.fingerprint, current);
      if (!path) throw new VesselDecodeError('fingerprint', `part "${instanceId}": definition "${w.id}" was ${saved.fingerprint} when this was written and is ${current} now, and the migration registry holds no way from one to the other`);
      for (const step of path) saved = step.migrate(saved, w.def);
      saved = { ...saved, fingerprint: current };
      report.migrated.push({ part: instanceId, defId: w.id, from: w.fingerprint, to: current, steps: path.map((m) => m.describe) });
      anyMigrated = true;
    }
    v.parts.push(partFromSaved(saved, w.def, { craft, parent, stageGroup, pos, rot, shielded, panel, stress, command }));
  }
  if (pr.left !== 0) throw new VesselDecodeError('block', `the parts block has ${pr.left} bytes this version does not read`);
  if (v.helm.craft >= crafts.length || (v.parts.length > 0 && v.helm.controlPart >= v.parts.length)) throw new VesselDecodeError('format', 'the helm names a craft or a part the vessel does not have');
  for (const l of v.links) if (l.a >= v.parts.length || l.b >= v.parts.length) throw new VesselDecodeError('format', 'a dock link names a part the vessel does not have');

  // Carried state.
  const kr = need(BLOCK_CARRIED, 'carried');
  v.carried = readCarried(kr, head.version);
  // A changed definition changes the mass: the saved mass properties no longer describe the vessel.
  if (anyMigrated) {
    computeMassProps(v);
    // The lists of the carried state follow the structure of the part set; a changed definition may have another.
    v.carried = null;
  }
  v.struct = null;
  return { vessel: v, report };
}

function readCarried(r: Reader, version: number): CarriedState | null {
  if (!r.bool()) return null;
  const c: CarriedState = { probes: [], buoyWet: [], wake: [] };
  const n = r.uint();
  if (version === 1) {
    for (let i = 0; i < n; i++) {
      const f = r.u8();
      const hasAnchor = (f & 4) !== 0;
      c.probes.push({ inContact: (f & 1) !== 0, wet: (f & 2) !== 0, hasAnchor, ax: hasAnchor ? r.f64() : 0, ay: hasAnchor ? r.f64() : 0, az: hasAnchor ? r.f64() : 0 });
    }
  } else {
    for (let i = 0; i < n; i++) c.probes.push({ inContact: false, wet: false, hasAnchor: false, ax: 0, ay: 0, az: 0 });
    const sets: ((p: CarriedState['probes'][number], on: boolean) => void)[] = [(p, on) => (p.inContact = on), (p, on) => (p.wet = on), (p, on) => (p.hasAnchor = on)];
    for (const set of sets) {
      for (let i = 0; i < n; i += 8) {
        const b = r.u8();
        for (let k = 0; k < 8 && i + k < n; k++) set(c.probes[i + k]!, (b & (1 << k)) !== 0);
      }
    }
    for (const p of c.probes) {
      if (!p.hasAnchor) continue;
      p.ax = r.f64();
      p.ay = r.f64();
      p.az = r.f64();
    }
  }
  for (let k = r.uint(), i = 0; i < k; i++) c.buoyWet.push(r.bool());
  for (let k = r.uint(), i = 0; i < k; i++) c.wake.push(r.num());
  if (r.left !== 0) throw new VesselDecodeError('block', `the carried block has ${r.left} bytes this version does not read`);
  return c;
}

/** Build the runtime part from saved state that is at the current fingerprint of its definition; any misfit is a changed block. */
function partFromSaved(
  saved: SavedPart,
  def: PartDef,
  rest: { craft: number; parent: number; stageGroup: string; pos: PartRuntime['pos']; rot: PartRuntime['rot']; shielded: boolean; panel: PartRuntime['panel']; stress: number; command: PartRuntime['command'] },
): PartRuntime {
  const p = createPart(saved.instanceId, def, rest.stageGroup);
  const where = `part "${saved.instanceId}" (${def.id})`;
  const tanks = def.resources ?? [];
  if (saved.resources.length !== tanks.length || saved.resources.some((x, k) => x.resource !== tanks[k]!.resource)) {
    throw new VesselDecodeError('block', `${where}: the resource block holds [${saved.resources.map((x) => x.resource).join(', ')}], the definition has [${tanks.map((x) => x.resource).join(', ')}]`);
  }
  p.resources = saved.resources.map((x) => x.amount);
  if (saved.temps.length !== def.thermal.surfaces.length) throw new VesselDecodeError('block', `${where}: ${saved.temps.length} surface temperatures, the definition has ${def.thermal.surfaces.length} surfaces`);
  p.temps = saved.temps.slice();
  if (saved.modules.length !== def.modules.length) throw new VesselDecodeError('block', `${where}: ${saved.modules.length} module blocks, the definition has ${def.modules.length} modules`);
  for (let m = 0; m < def.modules.length; m++) {
    const md = def.modules[m]!;
    const sm = saved.modules[m]!;
    const state = createModuleState(md);
    const rt = createModuleRt(md);
    if (sm.type !== md.type || !sameShape(state, sm.state) || !sameShape(rt, sm.rt)) {
      throw new VesselDecodeError('block', `${where}: the block of module ${m} is a "${sm.type}" state that does not fit the definition's "${md.type}" module`);
    }
    p.modules[m] = cloneModuleState(Object.assign(state, sm.state));
    p.rt[m] = Object.assign(rt, sm.rt) as ModuleRt;
  }
  p.craft = rest.craft;
  p.parent = rest.parent;
  p.pos = rest.pos;
  p.rot = rest.rot;
  p.shielded = rest.shielded;
  p.panel = rest.panel;
  p.stress = rest.stress;
  p.command = rest.command;
  return p;
}
