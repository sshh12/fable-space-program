/**
 * The high-rate messages (ARCHITECTURE 13.3, 13.4): `input`, `islandKey`, `islandDelta`, `inputAck` and
 * `near`, written by hand for size and speed, plus `islandSlow`. Each is a `Codec` like the schema-built
 * ones, and the high-rate ones add `readInto(reader, frame)`, which decodes into a reusable frame object:
 * once the frame's pools have grown to the message sizes seen, decoding allocates nothing, and neither does
 * encoding into a reused `ByteWriter`.
 *
 * Layouts (all integers varints unless named; "s" = signed varint):
 *   input        n, then per sample: seq (first absolute, then s-delta), applyTick (first f64, then s-delta),
 *                flags u8 (1 = hold), throttle u8, six axes i8, [hold 3 x f32]
 *   islandKey    island, tick f64, n, per vessel: slot, pos 3 x f64, vel 3 x f64, att 4 x f32, rate 3 x f32,
 *                control state
 *   islandDelta  island, tick f64, age (tick - keyTick), n, per vessel: slot*4 + attLargest, mask u8
 *                (1 pose, 2 controls, 4 part-fast, 8 contact, 16 coarse position, 32 coarse velocity,
 *                64 absolute attitude), [pose: 12 s-residuals], [control state], [part-fast], [contact]
 *   inputAck     flags u8 (1 = margin), [margin s (0.1 ms)], ranges: n, from (first absolute, then s-delta
 *                from the previous `to`), to - from; late: n, seq, appliedTick f64
 *   near         tick f64, n, per vessel: vessel handle, island, flags u8 (1 coarse, 2 thrust, 4 burning,
 *                8 flameout, 16 controls, attLargest << 5), 6 s-ints, 3 x i16, throttle u8, [thrust 3 x i8],
 *                stage, [control state]
 */
import type {
  ContactState,
  DeltaPose,
  DeltaVessel,
  DockingPortStateName,
  InputAckMessage,
  InputMessage,
  InputSample,
  IslandDeltaMessage,
  IslandKeyMessage,
  IslandSlowMessage,
  KeyVessel,
  NearMessage,
  NearVessel,
  PartFastEntry,
  WireControlState,
} from '@/core/contracts/net';
import { WIRE_RANGES } from '@/core/contracts/net';
import type { ChuteState } from '@/core/contracts/sim';
import { FrameQuat, FrameVec3, MAX_VARINT_SIGNED, WireEncodeError, type ByteReader, type ByteWriter } from './bytes';
import { controlState, exhaustive, handle, isUnit, randomControls, randomUnitF32, readControlStateInto, readControls, writeControls } from './common';
import { Gen, type Codec } from './schema';

/** A codec that can also decode into a reusable frame. */
export interface HotCodec<T> extends Codec<T> {
  readInto(r: ByteReader, out: T): void;
  /** A fresh frame to decode into. */
  frame(): T;
}

const MAX_SAMPLES = 64;
const MAX_VESSELS = 4096;
const MAX_SLOT = 1_000_000;
const MAX_ISLAND = 0xffffffff;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new WireEncodeError(msg);
}
const isTick = Number.isSafeInteger;
const isUint = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
const isSint = (v: number): boolean => Number.isSafeInteger(v) && Math.abs(v) <= MAX_VARINT_SIGNED;

function writeVecF64(w: ByteWriter, x: number, y: number, z: number, what: string): void {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new WireEncodeError(`${what}: not finite`);
  w.f64(x);
  w.f64(y);
  w.f64(z);
}

function writeF32(w: ByteWriter, v: number, what: string): void {
  if (!Number.isFinite(Math.fround(v))) throw new WireEncodeError(`${what}: not a finite float32`);
  w.f32(v);
}

/** Grows a list of reusable objects. */
class Pool<T> {
  private readonly items: T[] = [];
  constructor(private readonly make: () => T) {}
  at(i: number): T {
    while (this.items.length <= i) this.items.push(this.make());
    return this.items[i]!;
  }
}

function emptyControlState(): WireControlState {
  return { throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, velocityReference: 'orbit', sasEnabled: false, rcsEnabled: false, fineControl: false, sasMode: 'stability', sasHold: null };
}

function randomControlState(g: Gen): WireControlState {
  return controlState.random(g);
}

const f32v = (g: Gen): number => g.f32();

// ---------------------------------------------------------------------------------------------- input

export class InputFrame implements InputMessage {
  readonly type = 'input' as const;
  samples: InputSample[] = [];
  readonly pool = new Pool<InputSample>(() => ({ seq: 0, applyTick: 0, throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, sasHold: null }));
  readonly holds = new Pool(() => new FrameVec3());
}

export const inputCodec: HotCodec<InputMessage> = {
  min: 1,
  write(w, m) {
    const n = m.samples.length;
    check(n <= MAX_SAMPLES, 'input: more than 64 samples');
    w.varUint(n);
    let prevSeq = 0;
    let prevTick = 0;
    for (let i = 0; i < n; i++) {
      const s = m.samples[i]!;
      check(isUint(s.seq) && isTick(s.applyTick), 'input: seq or applyTick is not an integer');
      if (i === 0) {
        w.varUint(s.seq);
        w.f64(s.applyTick);
      } else {
        check(isSint(s.seq - prevSeq) && isSint(s.applyTick - prevTick), 'input: samples too far apart');
        w.varInt(s.seq - prevSeq);
        w.varInt(s.applyTick - prevTick);
      }
      prevSeq = s.seq;
      prevTick = s.applyTick;
      w.u8(s.sasHold ? 1 : 0);
      writeControls(w, s);
      if (s.sasHold) {
        check(isUnit(s.sasHold), 'input.sasHold: not a unit vector');
        writeF32(w, s.sasHold.x, 'input.sasHold');
        writeF32(w, s.sasHold.y, 'input.sasHold');
        writeF32(w, s.sasHold.z, 'input.sasHold');
      }
    }
  },
  read(r) {
    const f = new InputFrame();
    inputCodec.readInto(r, f);
    return { type: 'input', samples: f.samples.map((s) => ({ ...s, sasHold: s.sasHold ? { ...s.sasHold } : null })) };
  },
  readInto(r, out) {
    const f = out as InputFrame;
    const n = r.count(9, MAX_SAMPLES);
    f.samples.length = n;
    let seq = 0;
    let tick = 0;
    for (let i = 0; i < n; i++) {
      const s = f.pool.at(i);
      if (i === 0) {
        seq = r.varUint();
        tick = r.tick();
      } else {
        seq += r.varInt();
        tick += r.varInt();
        if (!isUint(seq) || !isTick(tick)) r.fail('badValue');
      }
      s.seq = seq;
      s.applyTick = tick;
      const flags = r.u8();
      if (flags > 1) r.fail('badEnum');
      readControls(r, s);
      if (flags === 1) {
        const h = f.holds.at(i);
        r.vec3f32Into(h);
        // A unit vector (the squared norm, on locals: no allocation on the hot path).
        const hx = h.x;
        const hy = h.y;
        const hz = h.z;
        if (!r.failed && !(Math.abs(hx * hx + hy * hy + hz * hz - 1) <= 2 * WIRE_RANGES.unitTolerance)) r.fail('badValue');
        s.sasHold = h;
      } else s.sasHold = null;
      f.samples[i] = s;
      if (r.failed) {
        f.samples.length = 0;
        return;
      }
    }
  },
  frame: () => new InputFrame(),
  random(g) {
    const n = g.int(0, 8);
    const samples: InputSample[] = [];
    let seq = g.safeInt(1e9);
    let tick = g.safeInt(2 ** 50);
    for (let i = 0; i < n; i++) {
      samples.push({ seq, applyTick: tick, ...randomControls(g), sasHold: g.chance(0.4) ? randomUnitF32(g) : null });
      seq += g.int(1, 3);
      tick += g.int(-4, 40);
    }
    return { type: 'input', samples };
  },
};

// ------------------------------------------------------------------------------------------ islandKey

function makeKeyVessel(): KeyVessel {
  return { slot: 0, pos: new FrameVec3(), vel: new FrameVec3(), att: new FrameQuat(), rate: new FrameVec3(), acc: null, controls: emptyControlState() };
}

export class IslandKeyFrame implements IslandKeyMessage {
  readonly type = 'islandKey' as const;
  island = 0;
  tick = 0;
  vessels: KeyVessel[] = [];
  readonly pool = new Pool<KeyVessel>(makeKeyVessel);
  /** The acceleration vectors of the pooled vessels (a vessel holds one while its key has the term). */
  readonly accs = new Pool<FrameVec3>(() => new FrameVec3());
}

const KEY_VESSEL_MIN = 1 + 48 + 16 + 12 + 2;

export const islandKeyCodec: HotCodec<IslandKeyMessage> = {
  min: 10,
  write(w, m) {
    check(isUint(m.island) && m.island <= MAX_ISLAND && isTick(m.tick), 'islandKey: island or tick');
    check(m.vessels.length <= MAX_VESSELS, 'islandKey: too many vessels');
    w.varUint(m.island);
    w.f64(m.tick);
    w.varUint(m.vessels.length);
    for (const v of m.vessels) {
      check(isUint(v.slot) && v.slot <= MAX_SLOT, 'islandKey: slot');
      // The slot's low bit says whether the acceleration term follows the rate (a coasting vessel: no byte).
      w.varUint(v.slot * 2 + (v.acc ? 1 : 0));
      writeVecF64(w, v.pos.x, v.pos.y, v.pos.z, 'islandKey.pos');
      writeVecF64(w, v.vel.x, v.vel.y, v.vel.z, 'islandKey.vel');
      writeF32(w, v.att.x, 'islandKey.att');
      writeF32(w, v.att.y, 'islandKey.att');
      writeF32(w, v.att.z, 'islandKey.att');
      writeF32(w, v.att.w, 'islandKey.att');
      writeF32(w, v.rate.x, 'islandKey.rate');
      writeF32(w, v.rate.y, 'islandKey.rate');
      writeF32(w, v.rate.z, 'islandKey.rate');
      if (v.acc) {
        writeF32(w, v.acc.x, 'islandKey.acc');
        writeF32(w, v.acc.y, 'islandKey.acc');
        writeF32(w, v.acc.z, 'islandKey.acc');
      }
      controlState.write(w, v.controls);
    }
  },
  read(r) {
    const f = new IslandKeyFrame();
    islandKeyCodec.readInto(r, f);
    return { type: 'islandKey', island: f.island, tick: f.tick, vessels: f.vessels.map(cloneKeyVessel) };
  },
  readInto(r, out) {
    const f = out as IslandKeyFrame;
    f.island = r.varUintMax(MAX_ISLAND);
    f.tick = r.tick();
    const n = r.count(KEY_VESSEL_MIN, MAX_VESSELS);
    f.vessels.length = n;
    for (let i = 0; i < n; i++) {
      const v = f.pool.at(i);
      const head = r.varUintMax(MAX_SLOT * 2 + 1);
      v.slot = Math.floor(head / 2);
      r.vec3f64Into(v.pos);
      r.vec3f64Into(v.vel);
      r.quatInto(v.att, true);
      r.vec3f32Into(v.rate);
      if (head % 2 === 1) {
        const a = f.accs.at(i);
        r.vec3f32Into(a);
        v.acc = a;
      } else v.acc = null;
      readControlStateInto(r, v.controls);
      f.vessels[i] = v;
      if (r.failed) {
        f.vessels.length = 0;
        return;
      }
    }
  },
  frame: () => new IslandKeyFrame(),
  random(g) {
    const vessels: KeyVessel[] = [];
    const n = g.int(0, 4);
    for (let i = 0; i < n; i++) {
      vessels.push({
        slot: g.int(0, 70),
        pos: { x: g.f64(), y: g.f64(), z: g.f64() },
        vel: { x: g.f64(), y: g.f64(), z: g.f64() },
        att: { x: f32v(g), y: f32v(g), z: f32v(g), w: f32v(g) },
        rate: { x: f32v(g), y: f32v(g), z: f32v(g) },
        acc: g.chance(0.5) ? { x: f32v(g), y: f32v(g), z: f32v(g) } : null,
        controls: randomControlState(g),
      });
    }
    return { type: 'islandKey', island: g.safeInt(MAX_ISLAND), tick: g.safeInt(2 ** 50), vessels };
  },
};

function cloneControls(c: WireControlState): WireControlState {
  return { ...c, sasHold: c.sasHold ? { ...c.sasHold } : null };
}

function cloneKeyVessel(v: KeyVessel): KeyVessel {
  return { slot: v.slot, pos: { ...v.pos }, vel: { ...v.vel }, att: { ...v.att }, rate: { ...v.rate }, acc: v.acc ? { ...v.acc } : null, controls: cloneControls(v.controls) };
}

// ---------------------------------------------------------------------------------------- islandDelta

const M_POSE = 1;
const M_CONTROLS = 2;
const M_PARTFAST = 4;
const M_CONTACT = 8;
const M_COARSE_POS = 16;
const M_COARSE_VEL = 32;
const M_ATT_ABS = 64;

const CHUTE_STATES = exhaustive<ChuteState>()(['stowed', 'reefed', 'full', 'cut', 'failed'] as const);
const PORT_STATES = exhaustive<DockingPortStateName>()(['disabled', 'ready', 'occupied', 'soft', 'hard', 'cooldown'] as const);

/** Gimbal grid: 1e-4 rad. */
export const GIMBAL_SCALE = 10_000;

function makeDeltaPose(): DeltaPose {
  return { coarsePos: false, coarseVel: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, attLargest: 0, attAbsolute: false, qa: 0, qb: 0, qc: 0, wx: 0, wy: 0, wz: 0 };
}

type Probe = ContactState['probes'][number];
type Port = ContactState['ports'][number];

class ContactSlot {
  readonly state: ContactState = { pos: new FrameVec3(), vel: new FrameVec3(), att: new FrameQuat(), rate: new FrameVec3(), probes: [], ports: [] };
  readonly probes = new Pool<Probe>(() => ({ probe: 0, touching: false, wet: false, anchor: new FrameVec3() }));
  readonly ports = new Pool<Port>(() => new FramePort());
}

/** Reused port and engine entries: one shape each, doubles from the start (see `FrameVec3`). */
class FramePort implements Port {
  part = 0;
  state: DockingPortStateName = 'disabled';
  armed = false;
  progress = -0;
}

class FrameEngine {
  readonly kind = 'engine' as const;
  part = 0;
  ignited = false;
  flameout = false;
  gimbalX = -0;
  gimbalZ = -0;
}

class DeltaSlot {
  readonly vessel: DeltaVessel = { slot: 0, pose: null, controls: null, partFast: null, contact: null };
  readonly pose = makeDeltaPose();
  readonly controls = emptyControlState();
  readonly partFast: PartFastEntry[] = [];
  readonly engines = new Pool<Extract<PartFastEntry, { kind: 'engine' }>>(() => new FrameEngine());
  readonly legs = new Pool<Extract<PartFastEntry, { kind: 'legs' }>>(() => ({ kind: 'legs', part: 0, deploy: 0, broken: false }));
  readonly chutes = new Pool<Extract<PartFastEntry, { kind: 'chute' }>>(() => ({ kind: 'chute', part: 0, state: 'stowed', inflation: 0 }));
  readonly contact = new ContactSlot();
}

export class IslandDeltaFrame implements IslandDeltaMessage {
  readonly type = 'islandDelta' as const;
  island = 0;
  tick = 0;
  keyTick = 0;
  vessels: DeltaVessel[] = [];
  readonly pool = new Pool<DeltaSlot>(() => new DeltaSlot());
}

function writePartFast(w: ByteWriter, list: readonly PartFastEntry[]): void {
  check(list.length <= 4096, 'partFast: too many entries');
  w.varUint(list.length);
  for (const p of list) {
    check(isUint(p.part), 'partFast.part');
    if (p.kind === 'engine') {
      w.u8(0 | (p.ignited ? 4 : 0) | (p.flameout ? 8 : 0));
      w.varUint(p.part);
      const gx = Math.round(p.gimbalX * GIMBAL_SCALE);
      const gz = Math.round(p.gimbalZ * GIMBAL_SCALE);
      check(Math.abs(gx) <= 32767 && Math.abs(gz) <= 32767, 'partFast: gimbal beyond 3.2767 rad');
      w.i16(gx);
      w.i16(gz);
    } else if (p.kind === 'legs') {
      check(Number.isInteger(p.deploy) && p.deploy >= 0 && p.deploy <= 255, 'partFast.deploy');
      w.u8(1 | (p.broken ? 4 : 0));
      w.varUint(p.part);
      w.u8(p.deploy);
    } else {
      const s = CHUTE_STATES.indexOf(p.state);
      check(s >= 0, 'partFast.state');
      check(Number.isInteger(p.inflation) && p.inflation >= 0 && p.inflation <= 255, 'partFast.inflation');
      w.u8(2 | (s << 2));
      w.varUint(p.part);
      w.u8(p.inflation);
    }
  }
}

function readPartFast(r: ByteReader, slot: DeltaSlot): void {
  const n = r.count(3, 4096);
  const list = slot.partFast;
  // Entries are assigned by index (truncating the array to 0 and pushing would give up and re-allocate its storage).
  if (list.length !== n) list.length = n;
  let ne = 0;
  let nl = 0;
  let nc = 0;
  for (let i = 0; i < n && !r.failed; i++) {
    const head = r.u8();
    const kind = head & 3;
    const part = r.varUint();
    if (kind === 0) {
      if (head > 15) r.fail('badEnum');
      const e = slot.engines.at(ne++);
      e.part = part;
      e.ignited = (head & 4) !== 0;
      e.flameout = (head & 8) !== 0;
      e.gimbalX = r.i16() / GIMBAL_SCALE;
      e.gimbalZ = r.i16() / GIMBAL_SCALE;
      list[i] = e;
    } else if (kind === 1) {
      if (head > 7) r.fail('badEnum');
      const l = slot.legs.at(nl++);
      l.part = part;
      l.broken = (head & 4) !== 0;
      l.deploy = r.u8();
      list[i] = l;
    } else if (kind === 2) {
      const s = head >> 2;
      if (s >= CHUTE_STATES.length) r.fail('badEnum');
      const c = slot.chutes.at(nc++);
      c.part = part;
      c.state = CHUTE_STATES[s] ?? 'stowed';
      c.inflation = r.u8();
      list[i] = c;
    } else r.fail('badEnum');
  }
  if (r.failed) list.length = 0;
}

function writeContact(w: ByteWriter, c: ContactState): void {
  writeVecF64(w, c.pos.x, c.pos.y, c.pos.z, 'contact.pos');
  writeVecF64(w, c.vel.x, c.vel.y, c.vel.z, 'contact.vel');
  check(Number.isFinite(c.att.w), 'contact.att');
  writeVecF64(w, c.att.x, c.att.y, c.att.z, 'contact.att');
  w.f64(c.att.w);
  writeVecF64(w, c.rate.x, c.rate.y, c.rate.z, 'contact.rate');
  check(c.probes.length <= 4096 && c.ports.length <= 4096, 'contact: too many probes or ports');
  w.varUint(c.probes.length);
  for (const p of c.probes) {
    check(isUint(p.probe), 'contact.probe');
    w.varUint(p.probe);
    w.u8((p.touching ? 1 : 0) | (p.wet ? 2 : 0));
    writeVecF64(w, p.anchor.x, p.anchor.y, p.anchor.z, 'contact.anchor');
  }
  w.varUint(c.ports.length);
  for (const p of c.ports) {
    const s = PORT_STATES.indexOf(p.state);
    check(isUint(p.part) && s >= 0 && Number.isFinite(p.progress), 'contact.port');
    w.varUint(p.part);
    w.u8(s | (p.armed ? 8 : 0));
    w.f64(p.progress);
  }
}

function readContact(r: ByteReader, slot: ContactSlot): void {
  const c = slot.state;
  r.vec3f64Into(c.pos);
  r.vec3f64Into(c.vel);
  r.quatInto(c.att, false);
  r.vec3f64Into(c.rate);
  const np = r.count(26, 4096);
  c.probes.length = np;
  for (let i = 0; i < np && !r.failed; i++) {
    const p = slot.probes.at(i);
    p.probe = r.varUint();
    const fl = r.u8();
    if (fl > 3) r.fail('badEnum');
    p.touching = (fl & 1) !== 0;
    p.wet = (fl & 2) !== 0;
    r.vec3f64Into(p.anchor);
    c.probes[i] = p;
  }
  const nq = r.count(10, 4096);
  c.ports.length = nq;
  for (let i = 0; i < nq && !r.failed; i++) {
    const p = slot.ports.at(i);
    p.part = r.varUint();
    const fl = r.u8();
    const s = fl & 7;
    if (fl > 15 || s >= PORT_STATES.length) r.fail('badEnum');
    p.state = PORT_STATES[s] ?? 'disabled';
    p.armed = (fl & 8) !== 0;
    p.progress = r.finiteF64();
    c.ports[i] = p;
  }
  if (r.failed) {
    c.probes.length = 0;
    c.ports.length = 0;
  }
}

function writeResiduals(w: ByteWriter, p: DeltaPose): void {
  check(
    isSint(p.px) && isSint(p.py) && isSint(p.pz) && isSint(p.vx) && isSint(p.vy) && isSint(p.vz) && isSint(p.qa) && isSint(p.qb) && isSint(p.qc) && isSint(p.wx) && isSint(p.wy) && isSint(p.wz),
    'delta pose: a residual is not an integer with |v| <= 2^52',
  );
  w.varInt(p.px);
  w.varInt(p.py);
  w.varInt(p.pz);
  w.varInt(p.vx);
  w.varInt(p.vy);
  w.varInt(p.vz);
  w.varInt(p.qa);
  w.varInt(p.qb);
  w.varInt(p.qc);
  w.varInt(p.wx);
  w.varInt(p.wy);
  w.varInt(p.wz);
}

export const islandDeltaCodec: HotCodec<IslandDeltaMessage> = {
  min: 4,
  write(w, m) {
    check(isUint(m.island) && m.island <= MAX_ISLAND && isTick(m.tick) && isTick(m.keyTick) && m.tick >= m.keyTick, 'islandDelta: island, tick or keyTick');
    check(m.vessels.length <= MAX_VESSELS, 'islandDelta: too many vessels');
    // The tick as a signed varint (3 to 6 bytes for the ticks of a universe's life) unless it is beyond 2^52,
    // then as float64; the island's low bit says which.
    const narrow = m.tick <= MAX_VARINT_SIGNED && m.tick >= -MAX_VARINT_SIGNED;
    w.varUint(m.island * 2 + (narrow ? 0 : 1));
    if (narrow) w.varInt(m.tick);
    else w.f64(m.tick);
    w.varUint(m.tick - m.keyTick);
    w.varUint(m.vessels.length);
    for (const v of m.vessels) {
      check(isUint(v.slot) && v.slot <= MAX_SLOT, 'islandDelta: slot');
      const p = v.pose;
      check(!(p && v.contact), 'islandDelta: a vessel has either a pose or the contact form');
      w.varUint(v.slot * 4 + (p ? p.attLargest : 0));
      w.u8(
        (p ? M_POSE : 0) |
          (v.controls ? M_CONTROLS : 0) |
          (v.partFast ? M_PARTFAST : 0) |
          (v.contact ? M_CONTACT : 0) |
          (p && p.coarsePos ? M_COARSE_POS : 0) |
          (p && p.coarseVel ? M_COARSE_VEL : 0) |
          (p && p.attAbsolute ? M_ATT_ABS : 0),
      );
      if (p) writeResiduals(w, p);
      if (v.controls) controlState.write(w, v.controls);
      if (v.partFast) writePartFast(w, v.partFast);
      if (v.contact) writeContact(w, v.contact);
    }
  },
  read(r) {
    const f = new IslandDeltaFrame();
    islandDeltaCodec.readInto(r, f);
    return { type: 'islandDelta', island: f.island, tick: f.tick, keyTick: f.keyTick, vessels: f.vessels.map(cloneDeltaVessel) };
  },
  readInto(r, out) {
    const f = out as IslandDeltaFrame;
    const head = r.varUintMax(MAX_ISLAND * 2 + 1);
    f.island = Math.floor(head / 2);
    if (head % 2 === 0) f.tick = r.varInt();
    else {
      f.tick = r.tick();
      // Canonical: a tick that fits the varint never travels as float64.
      if (!r.failed && f.tick <= MAX_VARINT_SIGNED && f.tick >= -MAX_VARINT_SIGNED) r.fail('badValue');
    }
    f.keyTick = f.tick - r.varUint();
    if (!isTick(f.keyTick)) r.fail('badTick');
    const n = r.count(2, MAX_VESSELS);
    f.vessels.length = n;
    for (let i = 0; i < n; i++) {
      const s = f.pool.at(i);
      const v = s.vessel;
      const sq = r.varUintMax(MAX_SLOT * 4 + 3);
      v.slot = Math.floor(sq / 4);
      const mask = r.u8();
      if (mask > 127 || (mask & M_POSE && mask & M_CONTACT) || (!(mask & M_POSE) && (mask & (M_COARSE_POS | M_COARSE_VEL | M_ATT_ABS) || sq % 4 !== 0))) r.fail('badEnum');
      if (mask & M_POSE) {
        const p = s.pose;
        p.coarsePos = (mask & M_COARSE_POS) !== 0;
        p.coarseVel = (mask & M_COARSE_VEL) !== 0;
        p.attAbsolute = (mask & M_ATT_ABS) !== 0;
        p.attLargest = (sq % 4) as 0 | 1 | 2 | 3;
        p.px = r.varInt();
        p.py = r.varInt();
        p.pz = r.varInt();
        p.vx = r.varInt();
        p.vy = r.varInt();
        p.vz = r.varInt();
        p.qa = r.varInt();
        p.qb = r.varInt();
        p.qc = r.varInt();
        p.wx = r.varInt();
        p.wy = r.varInt();
        p.wz = r.varInt();
        v.pose = p;
      } else v.pose = null;
      if (mask & M_CONTROLS) {
        readControlStateInto(r, s.controls);
        v.controls = s.controls;
      } else v.controls = null;
      if (mask & M_PARTFAST) {
        readPartFast(r, s);
        v.partFast = s.partFast;
      } else v.partFast = null;
      if (mask & M_CONTACT) {
        readContact(r, s.contact);
        v.contact = s.contact.state;
      } else v.contact = null;
      f.vessels[i] = v;
      if (r.failed) {
        f.vessels.length = 0;
        return;
      }
    }
  },
  frame: () => new IslandDeltaFrame(),
  random(g) {
    const tick = g.safeInt(2 ** 50);
    const vessels: DeltaVessel[] = [];
    const n = g.int(0, 4);
    for (let i = 0; i < n; i++) vessels.push(randomDeltaVessel(g));
    return { type: 'islandDelta', island: g.safeInt(MAX_ISLAND), tick, keyTick: tick - g.int(0, 240), vessels };
  },
};

function randomResidual(g: Gen): number {
  const k = g.int(0, 3);
  const m = k === 0 ? g.int(0, 63) : k === 1 ? g.int(0, 1e6) : k === 2 ? g.safeInt(4294967295) : g.safeInt(MAX_VARINT_SIGNED);
  return g.chance(0.5) && m !== 0 ? -m : m;
}

export function randomDeltaPose(g: Gen): DeltaPose {
  return {
    coarsePos: g.chance(0.2),
    coarseVel: g.chance(0.2),
    px: randomResidual(g),
    py: randomResidual(g),
    pz: randomResidual(g),
    vx: randomResidual(g),
    vy: randomResidual(g),
    vz: randomResidual(g),
    attLargest: g.int(0, 3) as 0 | 1 | 2 | 3,
    attAbsolute: g.chance(0.3),
    qa: randomResidual(g),
    qb: randomResidual(g),
    qc: randomResidual(g),
    wx: randomResidual(g),
    wy: randomResidual(g),
    wz: randomResidual(g),
  };
}

function randomPartFast(g: Gen): PartFastEntry {
  const k = g.int(0, 2);
  if (k === 0) return { kind: 'engine', part: g.int(0, 600), ignited: g.chance(0.5), flameout: g.chance(0.2), gimbalX: g.int(-32767, 32767) / GIMBAL_SCALE, gimbalZ: g.int(-32767, 32767) / GIMBAL_SCALE };
  if (k === 1) return { kind: 'legs', part: g.int(0, 600), deploy: g.int(0, 255), broken: g.chance(0.1) };
  return { kind: 'chute', part: g.int(0, 600), state: g.pick(CHUTE_STATES), inflation: g.int(0, 255) };
}

function randomContact(g: Gen): ContactState {
  const v = () => ({ x: g.f64(), y: g.f64(), z: g.f64() });
  return {
    pos: v(),
    vel: v(),
    att: { x: g.f64(), y: g.f64(), z: g.f64(), w: g.f64() },
    rate: v(),
    probes: Array.from({ length: g.int(0, 3) }, () => ({ probe: g.int(0, 40), touching: g.chance(0.5), wet: g.chance(0.2), anchor: v() })),
    ports: Array.from({ length: g.int(0, 2) }, () => ({ part: g.int(0, 600), state: g.pick(PORT_STATES), armed: g.chance(0.5), progress: g.f64() })),
  };
}

function randomDeltaVessel(g: Gen): DeltaVessel {
  const contact = g.chance(0.2);
  return {
    slot: g.int(0, 70),
    pose: contact ? null : g.chance(0.85) ? randomDeltaPose(g) : null,
    controls: g.chance(0.4) ? randomControlState(g) : null,
    partFast: g.chance(0.3) ? Array.from({ length: g.int(0, 3) }, () => randomPartFast(g)) : null,
    contact: contact ? randomContact(g) : null,
  };
}

function cloneDeltaVessel(v: DeltaVessel): DeltaVessel {
  return {
    slot: v.slot,
    pose: v.pose ? { ...v.pose } : null,
    controls: v.controls ? cloneControls(v.controls) : null,
    partFast: v.partFast ? v.partFast.map((p) => ({ ...p })) : null,
    contact: v.contact
      ? {
          pos: { ...v.contact.pos },
          vel: { ...v.contact.vel },
          att: { ...v.contact.att },
          rate: { ...v.contact.rate },
          probes: v.contact.probes.map((p) => ({ ...p, anchor: { ...p.anchor } })),
          ports: v.contact.ports.map((p) => ({ ...p })),
        }
      : null,
  };
}

// ------------------------------------------------------------------------------------------- inputAck

/** Margin grid: 0.1 ms. */
const MARGIN_SCALE = 10;
/** Margins are reported within +-this, ms (`WIRE_RANGES.marginMaxMs`). */
const MARGIN_MAX_MS = WIRE_RANGES.marginMaxMs;

export class InputAckFrame implements InputAckMessage {
  readonly type = 'inputAck' as const;
  /** The margin in 0.1 ms units, kept as an integer so decoding stores no fractional double. */
  marginTenths = 0;
  hasMargin = false;
  get marginMs(): number | null {
    return this.hasMargin ? this.marginTenths / MARGIN_SCALE : null;
  }
  stamped: { from: number; to: number }[] = [];
  late: { seq: number; appliedTick: number }[] = [];
  readonly ranges = new Pool(() => ({ from: 0, to: 0 }));
  readonly lates = new Pool(() => ({ seq: 0, appliedTick: 0 }));
}

export const inputAckCodec: HotCodec<InputAckMessage> = {
  min: 3,
  write(w, m) {
    // Clamped to the reportable range: no producer value can make the encoder fail here.
    // (A flag and a plain number, never a null-or-number value: that would box the number on the hot path.)
    const ms = m.marginMs;
    const has = ms !== null && ms - ms === 0;
    let margin = 0;
    if (has) margin = Math.round((ms > MARGIN_MAX_MS ? MARGIN_MAX_MS : ms < -MARGIN_MAX_MS ? -MARGIN_MAX_MS : ms) * MARGIN_SCALE);
    check(m.stamped.length <= 4096 && m.late.length <= 4096, 'inputAck: too many entries');
    w.u8(has ? 1 : 0);
    if (has) w.varInt(margin);
    w.varUint(m.stamped.length);
    let prevTo = 0;
    for (let i = 0; i < m.stamped.length; i++) {
      const s = m.stamped[i]!;
      check(isUint(s.from) && isUint(s.to) && s.to >= s.from, 'inputAck: a range is not from <= to');
      if (i === 0) w.varUint(s.from);
      else w.varInt(s.from - prevTo);
      w.varUint(s.to - s.from);
      prevTo = s.to;
    }
    w.varUint(m.late.length);
    for (let i = 0; i < m.late.length; i++) {
      const l = m.late[i]!;
      check(isUint(l.seq) && isTick(l.appliedTick), 'inputAck: late entry');
      w.varUint(l.seq);
      w.f64(l.appliedTick);
    }
  },
  read(r) {
    const f = new InputAckFrame();
    inputAckCodec.readInto(r, f);
    return { type: 'inputAck', marginMs: f.marginMs, stamped: f.stamped.map((s) => ({ ...s })), late: f.late.map((l) => ({ ...l })) };
  },
  readInto(r, out) {
    const f = out as InputAckFrame;
    const flags = r.u8();
    if (flags > 1) r.fail('badEnum');
    f.hasMargin = flags === 1;
    f.marginTenths = flags === 1 ? r.varInt() : 0;
    const n = r.count(2, 4096);
    f.stamped.length = n;
    let prevTo = 0;
    for (let i = 0; i < n && !r.failed; i++) {
      const s = f.ranges.at(i);
      s.from = i === 0 ? r.varUint() : prevTo + r.varInt();
      s.to = s.from + r.varUint();
      if (!isUint(s.from) || !isUint(s.to)) r.fail('badValue');
      prevTo = s.to;
      f.stamped[i] = s;
    }
    const m = r.count(9, 4096);
    f.late.length = m;
    for (let i = 0; i < m && !r.failed; i++) {
      const l = f.lates.at(i);
      l.seq = r.varUint();
      l.appliedTick = r.tick();
      f.late[i] = l;
    }
    if (r.failed) {
      f.stamped.length = 0;
      f.late.length = 0;
    }
  },
  frame: () => new InputAckFrame(),
  random(g) {
    const stamped: { from: number; to: number }[] = [];
    let s = g.safeInt(1e9);
    for (let i = g.int(0, 3); i > 0; i--) {
      const to = s + g.int(0, 30);
      stamped.push({ from: s, to });
      s = to + g.int(1, 10);
    }
    return {
      type: 'inputAck',
      marginMs: g.chance(0.2) ? null : g.int(-5000, 5000) / MARGIN_SCALE,
      stamped,
      late: Array.from({ length: g.int(0, 2) }, () => ({ seq: g.safeInt(1e9), appliedTick: g.safeInt(2 ** 50) })),
    };
  },
};

// ---------------------------------------------------------------------------------------- islandSlow

/** Resource fraction grid (1/65535) and temperature grid (0.1 K). */
export const FRACTION_SCALE = 65_535;
export const KELVIN_SCALE = 10;

type SlowVessel = IslandSlowMessage['vessels'][number];

export const islandSlowCodec: Codec<IslandSlowMessage> = {
  min: 10,
  write(w, m) {
    check(isUint(m.island) && m.island <= MAX_ISLAND && isTick(m.tick), 'islandSlow: island or tick');
    check(m.vessels.length <= MAX_VESSELS, 'islandSlow: too many vessels');
    w.varUint(m.island);
    w.f64(m.tick);
    w.varUint(m.vessels.length);
    for (const v of m.vessels) {
      check(isUint(v.slot) && v.resources.length <= 65536 && v.temps.length <= 65536, 'islandSlow: vessel');
      w.varUint(v.slot);
      w.varUint(v.resources.length);
      for (const x of v.resources) {
        const q = Math.round(x.fraction * FRACTION_SCALE);
        check(isUint(x.part) && isUint(x.index) && q >= 0 && q <= FRACTION_SCALE, 'islandSlow: resource');
        w.varUint(x.part);
        w.varUint(x.index);
        w.u16(q);
      }
      w.varUint(v.temps.length);
      for (const t of v.temps) {
        const q = Math.round(t.kelvin * KELVIN_SCALE);
        check(isUint(t.part) && q >= 0 && q <= 65535, 'islandSlow: temperature beyond 0 .. 6553.5 K');
        w.varUint(t.part);
        w.u16(q);
      }
    }
  },
  read(r) {
    const island = r.varUintMax(MAX_ISLAND);
    const tick = r.tick();
    const n = r.count(3, MAX_VESSELS);
    const vessels: SlowVessel[] = [];
    for (let i = 0; i < n && !r.failed; i++) {
      const slot = r.varUintMax(MAX_SLOT);
      const nr = r.count(4, 65536);
      const resources: SlowVessel['resources'] = [];
      for (let j = 0; j < nr && !r.failed; j++) resources.push({ part: r.varUint(), index: r.varUint(), fraction: r.u16() / FRACTION_SCALE });
      const nt = r.count(3, 65536);
      const temps: SlowVessel['temps'] = [];
      for (let j = 0; j < nt && !r.failed; j++) temps.push({ part: r.varUint(), kelvin: r.u16() / KELVIN_SCALE });
      vessels.push({ slot, resources, temps });
    }
    return { type: 'islandSlow', island, tick, vessels };
  },
  random(g) {
    return {
      type: 'islandSlow',
      island: g.safeInt(MAX_ISLAND),
      tick: g.safeInt(2 ** 50),
      vessels: Array.from({ length: g.int(0, 3) }, () => ({
        slot: g.int(0, 70),
        resources: Array.from({ length: g.int(0, 3) }, () => ({ part: g.int(0, 600), index: g.int(0, 3), fraction: g.int(0, FRACTION_SCALE) / FRACTION_SCALE })),
        temps: Array.from({ length: g.int(0, 3) }, () => ({ part: g.int(0, 600), kelvin: g.int(0, 65535) / KELVIN_SCALE })),
      })),
    };
  },
};

// ---------------------------------------------------------------------------------------------- near

const N_COARSE = 1;
const N_THRUST = 2;
const N_BURNING = 4;
const N_FLAMEOUT = 8;
const N_CONTROLS = 16;
const NEAR_ATT_MAX = 23171;
const nearComponent = (x: number): boolean => Number.isInteger(x) && Math.abs(x) <= NEAR_ATT_MAX;
const axisOk = (x: number): boolean => Number.isInteger(x) && Math.abs(x) <= 127;

function makeNearVessel(): NearVessel {
  return { vesselId: '', island: 0, coarse: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, attLargest: 0, qa: 0, qb: 0, qc: 0, throttle: 0, thrust: null, stage: 0, burning: false, flameout: false, controls: null };
}

class NearSlot {
  readonly vessel = makeNearVessel();
  readonly thrust = { x: 0, y: 0, z: 0 };
  readonly controls = emptyControlState();
}

export class NearFrame implements NearMessage {
  readonly type = 'near' as const;
  band: 'near' | 'far' = 'near';
  tick = 0;
  vessels: NearVessel[] = [];
  readonly pool = new Pool<NearSlot>(() => new NearSlot());
}

export const nearCodec: HotCodec<NearMessage> = {
  min: 10,
  write(w, m) {
    check(isTick(m.tick) && m.vessels.length <= MAX_VESSELS && (m.band === 'near' || m.band === 'far'), 'near: band, tick or count');
    w.u8(m.band === 'near' ? 0 : 1);
    w.f64(m.tick);
    w.varUint(m.vessels.length);
    for (const v of m.vessels) {
      check(isUint(v.island) && v.island <= MAX_ISLAND && isUint(v.stage), 'near: island or stage');
      check(isSint(v.px) && isSint(v.py) && isSint(v.pz) && isSint(v.vx) && isSint(v.vy) && isSint(v.vz), 'near: a position or velocity is not an integer');
      check(nearComponent(v.qa) && nearComponent(v.qb) && nearComponent(v.qc), 'near: attitude component off the grid');
      handle.write(w, v.vesselId);
      w.varUint(v.island);
      w.u8((v.coarse ? N_COARSE : 0) | (v.thrust ? N_THRUST : 0) | (v.burning ? N_BURNING : 0) | (v.flameout ? N_FLAMEOUT : 0) | (v.controls ? N_CONTROLS : 0) | (v.attLargest << 5));
      w.varInt(v.px);
      w.varInt(v.py);
      w.varInt(v.pz);
      w.varInt(v.vx);
      w.varInt(v.vy);
      w.varInt(v.vz);
      w.i16(v.qa);
      w.i16(v.qb);
      w.i16(v.qc);
      check(Number.isInteger(v.throttle) && v.throttle >= 0 && v.throttle <= 255, 'near.throttle');
      w.u8(v.throttle);
      if (v.thrust) {
        check(axisOk(v.thrust.x) && axisOk(v.thrust.y) && axisOk(v.thrust.z), 'near.thrust');
        w.i8(v.thrust.x);
        w.i8(v.thrust.y);
        w.i8(v.thrust.z);
      }
      w.varUint(v.stage);
      if (v.controls) controlState.write(w, v.controls);
    }
  },
  read(r) {
    const f = new NearFrame();
    nearCodec.readInto(r, f);
    return { type: 'near', band: f.band, tick: f.tick, vessels: f.vessels.map((v) => ({ ...v, thrust: v.thrust ? { ...v.thrust } : null, controls: v.controls ? cloneControls(v.controls) : null })) };
  },
  readInto(r, out) {
    const f = out as NearFrame;
    const band = r.u8();
    if (band > 1) r.fail('badEnum');
    f.band = band === 0 ? 'near' : 'far';
    f.tick = r.tick();
    const n = r.count(17, MAX_VESSELS);
    f.vessels.length = n;
    for (let i = 0; i < n; i++) {
      const s = f.pool.at(i);
      const v = s.vessel;
      v.vesselId = handle.read(r);
      v.island = r.varUintMax(MAX_ISLAND);
      const fl = r.u8();
      v.coarse = (fl & N_COARSE) !== 0;
      v.burning = (fl & N_BURNING) !== 0;
      v.flameout = (fl & N_FLAMEOUT) !== 0;
      v.attLargest = (fl >> 5) as 0 | 1 | 2 | 3;
      if (fl > 127) r.fail('badEnum');
      v.px = r.varInt();
      v.py = r.varInt();
      v.pz = r.varInt();
      v.vx = r.varInt();
      v.vy = r.varInt();
      v.vz = r.varInt();
      v.qa = r.i16();
      v.qb = r.i16();
      v.qc = r.i16();
      if (Math.abs(v.qa) > NEAR_ATT_MAX || Math.abs(v.qb) > NEAR_ATT_MAX || Math.abs(v.qc) > NEAR_ATT_MAX) r.fail('badValue');
      v.throttle = r.u8();
      if (fl & N_THRUST) {
        s.thrust.x = r.i8();
        s.thrust.y = r.i8();
        s.thrust.z = r.i8();
        if (s.thrust.x === -128 || s.thrust.y === -128 || s.thrust.z === -128) r.fail('badValue');
        v.thrust = s.thrust;
      } else v.thrust = null;
      v.stage = r.varUint();
      if (fl & N_CONTROLS) {
        readControlStateInto(r, s.controls);
        v.controls = s.controls;
      } else v.controls = null;
      f.vessels[i] = v;
      if (r.failed) {
        f.vessels.length = 0;
        return;
      }
    }
  },
  frame: () => new NearFrame(),
  random(g) {
    return {
      type: 'near',
      band: g.chance(0.5) ? 'near' : 'far',
      tick: g.safeInt(2 ** 50),
      vessels: Array.from({ length: g.int(0, 4) }, () => ({
        vesselId: g.id(10),
        island: g.safeInt(MAX_ISLAND),
        coarse: g.chance(0.2),
        px: randomResidual(g),
        py: randomResidual(g),
        pz: randomResidual(g),
        vx: randomResidual(g),
        vy: randomResidual(g),
        vz: randomResidual(g),
        attLargest: g.int(0, 3) as 0 | 1 | 2 | 3,
        qa: g.int(-NEAR_ATT_MAX, NEAR_ATT_MAX),
        qb: g.int(-NEAR_ATT_MAX, NEAR_ATT_MAX),
        qc: g.int(-NEAR_ATT_MAX, NEAR_ATT_MAX),
        throttle: g.int(0, 255),
        thrust: g.chance(0.5) ? { x: g.int(-127, 127), y: g.int(-127, 127), z: g.int(-127, 127) } : null,
        stage: g.int(0, 12),
        burning: g.chance(0.5),
        flameout: g.chance(0.1),
        controls: g.chance(0.3) ? randomControlState(g) : null,
      })),
    };
  },
};
