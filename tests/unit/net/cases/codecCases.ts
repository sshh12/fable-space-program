/**
 * Codec cases shared by Node (vitest) and Chrome (tests/browser/net): every message type round-trips 1,000
 * seeded random instances, keys are bit-exact, deltas reconstruct within the quantisation bounds of
 * ARCHITECTURE 13.4, conics travel in their canonical form, framing and its errors.
 */
import type { DeltaPose, KeyVessel, WireMessage } from '@/core/contracts/net';
import { conicFromState } from '@/core/math/conic';
import { ByteReader, ByteWriter } from '@/net/codec/bytes';
import { canonicalConic, expandConic, readConic, writeConic } from '@/net/codec/census';
import { assembleFrame, decodeDocument, decodeFrame, encodeDocument, encodeFrame, encodeMessage, FrameReader, type FrameSource } from '@/net/codec/framing';
import { HandleTableIn, HandleTableOut } from '@/net/codec/handles';
import { MESSAGE_SPECS, randomMessage, type MessageSpec } from '@/net/codec/messages';
import { dequantizePose, makePose, quantizePose, quatAngle, type IslandPose } from '@/net/codec/quant';
import { Gen } from '@/net/codec/schema';
import { diff, equal, ok, type NetCase } from './assert';

const sourceOf = (spec: MessageSpec): FrameSource => (spec.sender === 'client' ? 'client' : spec.sender === 'role' ? 'role' : spec.sender === 'document' ? 'document' : 'server');

/** Encode one message (with the handles it needs) as a frame, decode it, and return the message and the frame. */
export function roundTrip(m: WireMessage, source: FrameSource): { back: WireMessage; frame: Uint8Array } {
  const out = new HandleTableOut();
  const rec = encodeMessage(m, out);
  const handles = out.takePending();
  const frame = assembleFrame(handles ? [encodeMessage(handles), rec] : [rec]);
  // A random `handles` message is not a continuation of an empty table: decode it without applying it.
  const res = decodeFrame(frame, { source, handles: m.type === 'handles' ? null : new HandleTableIn(), maxBytes: 64 * 1024 * 1024 });
  if (!res.ok) throw new Error(`${m.type}: decode failed: ${JSON.stringify(res.error)}`);
  const back = res.messages[res.messages.length - 1]!;
  return { back, frame };
}

const RANDOM_INSTANCES = 1000;

function makeKey(g: Gen): KeyVessel {
  const q = { x: g.next() - 0.5, y: g.next() - 0.5, z: g.next() - 0.5, w: g.next() - 0.5 };
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return {
    slot: 0,
    pos: { x: (g.next() - 0.5) * 6e4, y: (g.next() - 0.5) * 6e4, z: (g.next() - 0.5) * 6e4 },
    vel: { x: (g.next() - 0.5) * 200, y: (g.next() - 0.5) * 200, z: (g.next() - 0.5) * 200 },
    att: { x: Math.fround(q.x / n), y: Math.fround(q.y / n), z: Math.fround(q.z / n), w: Math.fround(q.w / n) },
    rate: { x: Math.fround((g.next() - 0.5) * 0.2), y: Math.fround((g.next() - 0.5) * 0.2), z: Math.fround((g.next() - 0.5) * 0.2) },
    // Half the keys are under thrust (up to 3 g per axis).
    acc: g.chance(0.5) ? { x: Math.fround((g.next() - 0.5) * 60), y: Math.fround((g.next() - 0.5) * 60), z: Math.fround((g.next() - 0.5) * 60) } : null,
    controls: { throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, velocityReference: 'orbit', sasEnabled: false, rcsEnabled: false, fineControl: false, sasMode: 'stability', sasHold: null },
  };
}

/** The state `dtTicks` after the key: drifted, accelerated and turned, as a vessel would be. */
function moved(key: KeyVessel, g: Gen, dtTicks: number): IslandPose {
  const dt = dtTicks / 120;
  const acc = g.chance(0.3) ? 30 : 0.05;
  const a = { x: (g.next() - 0.5) * acc, y: (g.next() - 0.5) * acc, z: (g.next() - 0.5) * acc };
  const p = makePose();
  p.pos = { x: key.pos.x + key.vel.x * dt + 0.5 * a.x * dt * dt, y: key.pos.y + key.vel.y * dt + 0.5 * a.y * dt * dt, z: key.pos.z + key.vel.z * dt + 0.5 * a.z * dt * dt };
  p.vel = { x: key.vel.x + a.x * dt, y: key.vel.y + a.y * dt, z: key.vel.z + a.z * dt };
  const turn = (g.next() - 0.5) * 0.4 * dt;
  const ax = { x: g.next() - 0.5, y: g.next() - 0.5, z: g.next() - 0.5 };
  const an = Math.hypot(ax.x, ax.y, ax.z);
  const s = Math.sin(turn / 2) / an;
  const r = { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(turn / 2) };
  const q = key.att;
  // r (x) q
  p.att = {
    x: r.w * q.x + r.x * q.w + r.y * q.z - r.z * q.y,
    y: r.w * q.y - r.x * q.z + r.y * q.w + r.z * q.x,
    z: r.w * q.z + r.x * q.y - r.y * q.x + r.z * q.w,
    w: r.w * q.w - r.x * q.x - r.y * q.y - r.z * q.z,
  };
  const n = Math.hypot(p.att.x, p.att.y, p.att.z, p.att.w);
  p.att.x /= n;
  p.att.y /= n;
  p.att.z /= n;
  p.att.w /= n;
  p.rate = { x: key.rate.x + (g.next() - 0.5) * 0.01, y: key.rate.y + (g.next() - 0.5) * 0.01, z: key.rate.z + (g.next() - 0.5) * 0.01 };
  return p;
}

export const codecCases: NetCase[] = [
  {
    name: `every message type round-trips ${RANDOM_INSTANCES} seeded random instances to equal values and equal bytes`,
    timeoutMs: 120_000,
    run() {
      for (const spec of MESSAGE_SPECS) {
        const g = new Gen(0x5eed0000 + spec.code);
        for (let i = 0; i < RANDOM_INSTANCES; i++) {
          const m = randomMessage(spec.type, g);
          const { back, frame } = roundTrip(m, sourceOf(spec));
          const d = diff(back, m);
          if (d) throw new Error(`${spec.type} #${i}: ${d}`);
          // Canonical: the decoded message encodes to the same frame.
          const again = roundTrip(back, sourceOf(spec)).frame;
          equal(again, frame, `${spec.type} #${i} re-encodes differently`);
        }
      }
    },
  },
  {
    name: 'the zero-allocation frame reader decodes the high-rate messages to the same values',
    run() {
      for (const spec of MESSAGE_SPECS.filter((s) => s.hot)) {
        const g = new Gen(0xf00d + spec.code);
        const reader = new FrameReader(sourceOf(spec), new HandleTableIn());
        const out = new HandleTableOut();
        for (let i = 0; i < 200; i++) {
          const m = randomMessage(spec.type, g);
          const rec = encodeMessage(m, out);
          const h = out.takePending();
          let seen: Uint8Array | null = null;
          const err = reader.read(assembleFrame(h ? [encodeMessage(h), rec] : [rec]), (x) => {
            // The reused frame holds the message only during the visit: take its bytes.
            if (x.type === spec.type) seen = encodeMessage(x, out);
          });
          ok(err === null, `${spec.type}: ${JSON.stringify(err)}`);
          ok(seen !== null, `${spec.type}: not visited`);
          const res = decodeFrame(assembleFrame([seen]), { source: sourceOf(spec), handles: reader.handles });
          ok(res.ok, `${spec.type}: the visited frame did not re-encode`);
          equal(res.messages[0], m, `${spec.type} #${i}`);
        }
      }
    },
  },
  {
    name: 'island keys are bit-exact: float64 positions and velocities, float32 attitude and rate',
    run() {
      const g = new Gen(42);
      for (let i = 0; i < 2000; i++) {
        const m = randomMessage('islandKey', g);
        const { back } = roundTrip(m, 'server');
        ok(back.type === 'islandKey', 'type');
        for (let j = 0; j < m.vessels.length; j++) {
          const a = m.vessels[j]!;
          const b = back.vessels[j]!;
          for (const k of ['x', 'y', 'z'] as const) {
            ok(Object.is(a.pos[k], b.pos[k]) && Object.is(a.vel[k], b.vel[k]) && Object.is(a.rate[k], b.rate[k]), `key ${i}/${j}.${k} not bit-exact`);
            ok(Object.is(Math.fround(a.rate[k]), b.rate[k]), 'rate is float32');
            ok((a.acc === null) === (b.acc === null) && (a.acc === null || Object.is(a.acc[k], b.acc![k])), `key ${i}/${j} acc.${k} not bit-exact`);
          }
          for (const k of ['x', 'y', 'z', 'w'] as const) ok(Object.is(a.att[k], b.att[k]), `key ${i}/${j} att.${k} not bit-exact`);
        }
      }
    },
  },
  {
    name: 'deltas reconstruct within 16 um, 1 um/s and 5e-10 rad of the true pose (ARCHITECTURE 13.4)',
    run() {
      const g = new Gen(7);
      let maxPos = 0;
      let maxVel = 0;
      let maxAtt = 0;
      const d = {} as DeltaPose;
      const back = makePose();
      for (let i = 0; i < 20_000; i++) {
        const key = makeKey(g);
        const dt = g.int(0, 240);
        const cur = moved(key, g, dt);
        quantizePose(key, dt, cur, d);
        // Through the wire: a delta message with this pose.
        const msg = { type: 'islandDelta' as const, island: 1, tick: 1000 + dt, keyTick: 1000, vessels: [{ slot: 0, pose: { ...d }, controls: null, partFast: null, contact: null }] };
        const got = roundTrip(msg, 'server').back;
        ok(got.type === 'islandDelta' && got.vessels[0]!.pose, 'delta decoded');
        ok(dequantizePose(key, got.tick - got.keyTick, got.vessels[0]!.pose!, back), `pose ${i} rejected`);
        maxPos = Math.max(maxPos, Math.abs(back.pos.x - cur.pos.x), Math.abs(back.pos.y - cur.pos.y), Math.abs(back.pos.z - cur.pos.z));
        maxVel = Math.max(maxVel, Math.abs(back.vel.x - cur.vel.x), Math.abs(back.vel.y - cur.vel.y), Math.abs(back.vel.z - cur.vel.z));
        maxAtt = Math.max(maxAtt, quatAngle(back.att, cur.att));
      }
      console.log(`delta quantisation over 20,000 poses: position ${(maxPos * 1e6).toFixed(2)} um, velocity ${(maxVel * 1e6).toFixed(3)} um/s, attitude ${maxAtt.toExponential(2)} rad`);
      ok(maxPos <= 16e-6, `position error ${maxPos} m above 16 um`);
      ok(maxVel <= 1e-6, `velocity error ${maxVel} m/s above 1 um/s`);
      ok(maxAtt <= 5e-10, `attitude error ${maxAtt} rad above 5e-10`);
    },
  },
  {
    name: 'a conic travels in its canonical form: within a few ulps of the original, and a decoded conic re-encodes to the same bytes',
    run() {
      const g = new Gen(99);
      const mu = 3.986004418e14;
      let worst = 0;
      for (let i = 0; i < 2000; i++) {
        const r = { x: (g.next() - 0.5) * 2e7, y: (g.next() - 0.5) * 2e7, z: (g.next() - 0.5) * 2e7 };
        const v = { x: (g.next() - 0.5) * 2e4, y: (g.next() - 0.5) * 2e4, z: (g.next() - 0.5) * 2e4 };
        const c = conicFromState(mu, r, v, g.next() * 1e9);
        const w = new ByteWriter();
        writeConic(w, c);
        const back = readConic(new ByteReader(w.bytes()), mu);
        // The receiver holds exactly the canonical conic (p, e and the angles at 48 bits), and it is within
        // 2^-37 of the sender's elements.
        const canon = canonicalConic(c);
        for (const k of ['p', 'e', 'a', 'inc', 'lan', 'argPe', 'tPeriapsis', 'mu'] as const) ok(Object.is(back[k], canon[k]), `conic ${i}: ${k} is not the canonical one`);
        for (const k of ['p', 'e', 'inc', 'lan', 'argPe'] as const) ok(Math.abs(back[k] - c[k]) <= Math.abs(c[k]) * 2 ** -37, `conic ${i}: ${k} moved more than 2^-37`);
        ok((back.period === null) === (c.period === null), 'closed flag');
        if (c.period !== null) worst = Math.max(worst, Math.abs(back.period! - canon.period!) / canon.period!);
        for (const vec of ['P', 'Q', 'W'] as const) for (const k of ['x', 'y', 'z'] as const) worst = Math.max(worst, Math.abs(back[vec][k] - canon[vec][k]));
        const w2 = new ByteWriter();
        writeConic(w2, back);
        equal(w2.bytes(), w.bytes(), `conic ${i} re-encodes differently`);
        equal(canonicalConic(back), back, 'canonical form is idempotent');
      }
      ok(worst < 1e-14, `canonical conic differs by ${worst}`);
      // The derived a of a parabola-like conic is Infinity and is not sent.
      const para = expandConic(mu, 1e7, 1, 0.1, 0.2, 0.3, 0, Infinity, false);
      const w = new ByteWriter();
      writeConic(w, para);
      equal(readConic(new ByteReader(w.bytes()), mu), canonicalConic(para), 'parabolic conic');
    },
  },
  {
    name: 'framing: large counts and lengths, typed errors for truncation, trailing bytes, unknown codes, direction and size',
    run() {
      const pings: WireMessage[] = Array.from({ length: 300 }, (_, i) => ({ type: 'ping', seq: i }));
      const big = encodeFrame(pings);
      const back = decodeFrame(big, { source: 'server' });
      ok(back.ok && back.messages.length === 300, 'a frame of 300 messages');
      const plan: WireMessage = { type: 'plan', craftId: 'c', data: new Uint8Array(5000).fill(7) };
      const pf = encodeFrame([plan]);
      const pb = decodeFrame(pf, { source: 'client' });
      ok(pb.ok, 'a message longer than 127 bytes');
      equal(pb.ok && pb.messages[0], plan, 'plan');
      // Truncation at every length.
      for (let n = 0; n < pf.length; n++) {
        const r = decodeFrame(pf.subarray(0, n), { source: 'client' });
        ok(!r.ok, `truncated at ${n} accepted`);
      }
      const trailing = new Uint8Array(pf.length + 1);
      trailing.set(pf);
      const tr = decodeFrame(trailing, { source: 'client' });
      ok(!tr.ok && tr.error.code === 'trailing', `trailing: ${JSON.stringify(!tr.ok && tr.error)}`);
      const unknown = decodeFrame(new Uint8Array([1, 250, 0]), { source: 'client' });
      ok(!unknown.ok && unknown.error.code === 'badType', 'unknown code');
      const wrong = decodeFrame(encodeFrame([{ type: 'durable', tick: 5 }]), { source: 'client' });
      ok(!wrong.ok && wrong.error.code === 'wrongDirection', 'a server message from a client');
      const wrong2 = decodeFrame(encodeFrame([{ type: 'auth', accountId: 'a', signature: new Uint8Array(3) }]), { source: 'server' });
      ok(!wrong2.ok && wrong2.error.code === 'wrongDirection', 'a client message from a server');
      const tooBig = decodeFrame(new Uint8Array(70 * 1024), { source: 'client' });
      ok(!tooBig.ok && tooBig.error.code === 'tooLarge', 'a client frame above 64 KiB');
      // A tick that is not an integer, a NaN, invalid UTF-8.
      const durable = encodeFrame([{ type: 'durable', tick: 5 }]);
      const bad = durable.slice();
      new DataView(bad.buffer).setFloat64(bad.length - 8, 5.5, true);
      const bt = decodeFrame(bad, { source: 'server' });
      ok(!bt.ok && bt.error.code === 'badTick', 'a fractional tick');
      new DataView(bad.buffer).setFloat64(bad.length - 8, NaN, true);
      ok(!decodeFrame(bad, { source: 'server' }).ok, 'a NaN tick');
      const sync = encodeFrame([{ type: 'timeSync', seq: 1, clientMs: 3 }]);
      new DataView(sync.buffer).setFloat64(sync.length - 8, Infinity, true);
      const nf = decodeFrame(sync, { source: 'client' });
      ok(!nf.ok && nf.error.code === 'nonFinite', 'an infinite float');
      const quick = encodeFrame([{ type: 'quick', phrase: 'ab', toAccountId: null }]);
      const bu = quick.slice();
      bu[bu.length - 3] = 0xc3;
      const ub = decodeFrame(bu, { source: 'client' });
      ok(!ub.ok && ub.error.code === 'badUtf8', `invalid UTF-8: ${JSON.stringify(!ub.ok && ub.error)}`);
    },
  },
  {
    name: 'varints and strings: boundaries of every width, astral characters, lone surrogates written as U+FFFD',
    run() {
      const w = new ByteWriter(8);
      const vals = [0, 1, 127, 128, 16383, 16384, 2 ** 21 - 1, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 2 ** 31, 2 ** 32, 2 ** 49 + 3, Number.MAX_SAFE_INTEGER];
      for (const v of vals) w.varUint(v);
      const sv = [0, -1, 1, -(2 ** 52 - 1), 2 ** 52 - 1, -123456789, 987654321012];
      for (const v of sv) w.varInt(v);
      w.str('aé€🚀z');
      w.str('lone \ud800 surrogate');
      const r = new ByteReader(w.bytes());
      for (const v of vals) equal(r.varUint(), v, 'varUint');
      for (const v of sv) equal(r.varInt(), v, 'varInt');
      equal(r.str(100), 'aé€🚀z', 'astral string');
      equal(r.str(100), 'lone � surrogate', 'lone surrogate');
      ok(!r.failed && r.remaining() === 0, 'consumed');
      // A varint longer than 8 bytes and one above 2^53 - 1 are refused.
      const long = new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]));
      long.varUint();
      equal(long.error, 'badVarint', 'nine-byte varint');
      const huge = new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]));
      huge.varUint();
      equal(huge.error, 'badVarint', 'varint above 2^53');
    },
  },
  {
    name: 'census documents carry their own string table and decode on their own',
    run() {
      const g = new Gen(1234);
      for (let i = 0; i < 200; i++) {
        const doc = randomMessage(g.chance(0.5) ? 'censusSnapshot' : 'censusDelta', g);
        const bytes = encodeDocument(doc);
        const back = decodeDocument(bytes);
        ok(back.ok, `document ${i}: ${JSON.stringify(!back.ok && back.error)}`);
        equal(back.ok && back.document, doc, `document ${i}`);
      }
      ok(!decodeDocument(encodeFrame([{ type: 'ping', seq: 1 }])).ok, 'a ping is not a document');
    },
  },
];
