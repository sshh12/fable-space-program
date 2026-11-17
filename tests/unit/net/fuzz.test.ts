/**
 * Fuzz (the brief's acceptance): 1,000,000 random and mutated byte strings through the frame decoders never
 * throw, never read out of bounds (a DataView read outside its window would throw a RangeError, and the
 * reader checks every length first) and never allocate above 1 MB for one input.
 *
 * Inputs: 40 % random bytes (lengths up to 64 KiB, most short), 60 % valid frames of every message type with
 * one to four mutations (bit flips, overwrites with 0x00 / 0x7f / 0x80 / 0xff, insertions, deletions,
 * truncations, duplicated slices). Each input is decoded as coming from a client, a server, a role link or
 * the publisher, alternately through `decodeFrame` (all or nothing) and `FrameReader` (zero-allocation).
 * Allocation is measured on a sample of inputs after a forced collection (heap growth while decoding one
 * input), and on the inputs built to allocate the most a client frame can make a server allocate.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Prng } from '@/core/math/hash';
import { assembleFrame, decodeFrame, encodeFrame, encodeMessage, FrameReader, MAX_CLIENT_FRAME_MESSAGES, type FrameSource } from '@/net/codec/framing';
import { HandleTableIn, HandleTableOut } from '@/net/codec/handles';
import { MESSAGE_SPECS, randomMessage } from '@/net/codec/messages';
import { Gen } from '@/net/codec/schema';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const TOTAL = 1_000_000;
const SOURCES: FrameSource[] = ['client', 'server', 'role', 'document'];
const LIMIT = 1024 * 1024;

interface Seed {
  frame: Uint8Array;
  /** The side that sends this message type (mutations of it are decoded as from that side, mostly). */
  source: FrameSource;
}

function pool(): Seed[] {
  const g = new Gen(0xf022);
  const out: Seed[] = [];
  for (const spec of MESSAGE_SPECS) {
    const source: FrameSource = spec.sender === 'both' ? 'server' : spec.sender;
    for (let i = 0; i < 40; i++) {
      const table = new HandleTableOut();
      const rec = encodeMessage(randomMessage(spec.type, g), table);
      const h = table.takePending();
      // The handles first, as a server sends them.
      out.push({ frame: assembleFrame(h ? [encodeMessage(h), rec] : [rec]), source });
    }
  }
  return out;
}

function mutate(p: Prng, src: Uint8Array): Uint8Array {
  let b = src.slice();
  const n = 1 + Math.floor(p.next() * 4);
  for (let k = 0; k < n; k++) {
    const op = Math.floor(p.next() * 7);
    const at = b.length === 0 ? 0 : Math.floor(p.next() * b.length);
    if (op === 0 && b.length) b[at] = b[at]! ^ (1 << Math.floor(p.next() * 8));
    else if (op === 1 && b.length) b[at] = [0x00, 0x7f, 0x80, 0xff][Math.floor(p.next() * 4)]!;
    else if (op === 2) {
      const ins = new Uint8Array(1 + Math.floor(p.next() * 8)).map(() => Math.floor(p.next() * 256));
      const c = new Uint8Array(b.length + ins.length);
      c.set(b.subarray(0, at));
      c.set(ins, at);
      c.set(b.subarray(at), at + ins.length);
      b = c;
    } else if (op === 3 && b.length) {
      const len = 1 + Math.floor(p.next() * Math.min(16, b.length - at));
      const c = new Uint8Array(b.length - len);
      c.set(b.subarray(0, at));
      c.set(b.subarray(at + len), at);
      b = c;
    } else if (op === 4) b = b.subarray(0, at);
    else if (op === 5 && b.length) {
      const len = Math.min(32, b.length - at);
      const c = new Uint8Array(b.length + len);
      c.set(b.subarray(0, at + len));
      c.set(b.subarray(at, at + len), at + len);
      c.set(b.subarray(at + len), at + 2 * len);
      b = c;
    } else if (b.length) b[at] = Math.floor(p.next() * 256);
  }
  return b;
}

function randomBytes(p: Prng): Uint8Array {
  const r = p.next();
  const len = r < 0.6 ? Math.floor(p.next() * 64) : r < 0.95 ? Math.floor(p.next() * 2048) : Math.floor(p.next() * 65536);
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = p.nextU32() & 0xff;
  // Half of them start like a frame: a small count and a known message code.
  if (len > 2 && p.next() < 0.5) {
    b[0] = 1 + Math.floor(p.next() * 3);
    b[1] = MESSAGE_SPECS[Math.floor(p.next() * MESSAGE_SPECS.length)]!.code;
  }
  return b;
}

/** Memory used by the heap and by array buffers (typed-array storage lives outside the heap). */
function used(): number {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/** Growth while decoding one input, after a forced collection. */
function allocationOf(bytes: Uint8Array, source: FrameSource): number {
  gc();
  gc();
  const before = used();
  const res = decodeFrame(bytes, { source, handles: new HandleTableIn() });
  const after = used();
  void res;
  return after - before;
}

describe('fuzz: the decoders never throw, never read out of bounds, never allocate above 1 MB', () => {
  it(`${TOTAL.toLocaleString('en-US')} random and mutated byte strings`, () => {
    const p = new Prng(0xdec0de);
    const frames = pool();
    const readers = SOURCES.map((s) => new FrameReader(s, new HandleTableIn()));
    const codes = new Map<string, number>();
    let accepted = 0;
    let maxAlloc = 0;
    let maxAllocInput = 0;
    const visit = () => undefined;
    for (let i = 0; i < TOTAL; i++) {
      let bytes: Uint8Array;
      let si = i % SOURCES.length;
      if (p.next() < 0.4) bytes = randomBytes(p);
      else {
        const seed = frames[Math.floor(p.next() * frames.length)]!;
        bytes = mutate(p, seed.frame);
        // Mostly from the side that sends it, so the mutations reach the payload decoders.
        if (p.next() < 0.8) si = SOURCES.indexOf(seed.source);
      }
      const source = SOURCES[si]!;
      let code: string;
      try {
        if ((i >> 2) % 2 === 0) {
          const res = decodeFrame(bytes, { source, handles: new HandleTableIn() });
          code = res.ok ? 'ok' : res.error.code;
        } else {
          const err = readers[si]!.read(bytes, visit);
          code = err ? err.code : 'ok';
        }
      } catch (e) {
        throw new Error(`input ${i} (${source}) threw ${String(e)}: ${Buffer.from(bytes.subarray(0, 64)).toString('hex')}`);
      }
      if (code === 'ok') accepted++;
      codes.set(code, (codes.get(code) ?? 0) + 1);
      if (i % 5000 === 0) {
        const a = allocationOf(bytes, source);
        if (a > maxAlloc) {
          maxAlloc = a;
          maxAllocInput = bytes.length;
        }
      }
    }
    console.log(`fuzz: ${TOTAL} inputs, ${accepted} decoded, outcomes ${JSON.stringify(Object.fromEntries([...codes].sort((a, b) => b[1] - a[1])))}; largest sampled allocation ${maxAlloc} B (input of ${maxAllocInput} B)`);
    expect(maxAlloc).toBeLessThan(LIMIT);
    expect(codes.get('ok') ?? 0).toBeGreaterThan(0);
  }, 600_000);

  it('the inputs that make a server allocate the most stay under 1 MB', () => {
    const results: [string, number][] = [];
    // A full client frame of the most messages a client frame may hold.
    const pings = encodeFrame(Array.from({ length: MAX_CLIENT_FRAME_MESSAGES }, (_, i) => ({ type: 'ping' as const, seq: i })));
    results.push(['client frame of 256 pings', allocationOf(pings, 'client')]);
    // The largest plan blob (64 KiB) and an input message of 64 samples with hold vectors.
    const plan = encodeFrame([{ type: 'plan', craftId: 'c', data: new Uint8Array(60_000) }]);
    results.push(['client plan of 60 kB', allocationOf(plan, 'client')]);
    const input = encodeFrame([
      { type: 'input', samples: Array.from({ length: 64 }, (_, i) => ({ seq: i, applyTick: 1000 + i, throttle: 1, pitch: 1, yaw: 1, roll: 1, tx: 1, ty: 1, tz: 1, sasHold: { x: 1, y: 0, z: 0 } })) },
    ]);
    results.push(['client input of 64 samples', allocationOf(input, 'client')]);
    // A 64 KiB string of 3-byte characters in a quick message is refused by its length limit before decoding.
    const big = new Uint8Array(65_000).fill(0x41);
    big[0] = 1;
    big[1] = 13;
    results.push(['client frame of 65 kB claiming a quick message', allocationOf(big, 'client')]);
    // A count that claims more elements than the bytes hold is refused before any allocation.
    const claim = new Uint8Array([1, 11, 8, 1, 0xff, 0xff, 0xff, 0x0f, 1, 2]);
    results.push(['subscribe claiming 33 million body ids', allocationOf(claim, 'client')]);
    console.log(`worst-case allocations: ${results.map(([n, a]) => `${n}: ${a} B`).join('; ')}`);
    for (const [, a] of results) expect(a).toBeLessThan(LIMIT);
  });
});
