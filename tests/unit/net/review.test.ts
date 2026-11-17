/**
 * Regression tests for the review's findings on the codec and the client's handling of a bad server
 * (findings 7, 8, 11, 15, 16 and 17). Each would have failed before its fix.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, WIRE_CONSTANTS, wireLimits } from '@/core/contracts/net';
import { ByteReader } from '@/net/codec/bytes';
import { assembleFrame, decodeFrame, encodeFrame, encodeMessage } from '@/net/codec/framing';
import { deltaMatchesKey, obsoletedKeys, supersedeKey } from '@/net/codec/messages';
import { ClientSession } from '@/net/session/client';
import { InputWindow } from '@/net/session/inputs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

describe('finding 15: version skew', () => {
  it('the Hello and refused layouts are frozen (an older or newer peer can always read why it was refused)', () => {
    const hello = encodeFrame([{ type: 'hello', protocol: 1, build: 'b-2026-11', defsHash: 'defs-1', cpuScore: 1.5, resume: { session: 'tok', relevantSeq: 7 } }]);
    const refused = encodeFrame([{ type: 'refused', reason: 'protocol', text: 'A new version is ready.', retryAfterMs: null, queue: null }]);
    expect(hex(hello)).toBe('0101220109622d323032362d313106646566732d3101000000000000f83f0103746f6b0107');
    expect(hex(refused)).toBe('01221b001741206e65772076657273696f6e2069732072656164792e0000');
  });

  it('a client skips a record of a type it does not know by its length; a server refuses one', () => {
    const pong = encodeMessage({ type: 'pong', seq: 9 });
    const unknown = Uint8Array.from([0x7f, 3, 1, 2, 3]);
    const frame = assembleFrame([unknown, pong]);
    const atClient = decodeFrame(frame, { source: 'server' });
    expect(atClient.ok && atClient.messages).toEqual([{ type: 'pong', seq: 9 }]);
    const atServer = decodeFrame(assembleFrame([unknown]), { source: 'client' });
    expect(!atServer.ok && atServer.error.code).toBe('badType');
    // A length beyond the frame is still an error.
    expect(decodeFrame(Uint8Array.from([1, 0x7f, 9, 1]), { source: 'server' }).ok).toBe(false);
  });
});

describe('finding 17: canonical varints only', () => {
  it('rejects a varint padded with a zero last byte (the same number has a shorter form)', () => {
    expect(new ByteReader(unhex('05')).varUint()).toBe(5);
    const r = new ByteReader(unhex('8500'));
    r.varUint();
    expect(r.failed).toBe(true);
    // A padded record length in a frame: refused.
    const ping = encodeMessage({ type: 'ping', seq: 1 });
    const padded = Uint8Array.from([1, ping[0]!, 0x80 | ping[1]!, 0x00, ...ping.subarray(2)]);
    expect(decodeFrame(padded, { source: 'client' }).ok).toBe(false);
  });
});

describe('finding 7: what supersedes what', () => {
  it('near has a key per band; a key obsoletes its island deltas; a delta is used only against the held key', () => {
    const near = (band: 'near' | 'far') => ({ type: 'near', band, tick: 1, vessels: [] }) as ServerMessage;
    expect(supersedeKey(near('near'))).toBe('near:near');
    expect(supersedeKey(near('far'))).toBe('near:far');
    expect(obsoletedKeys({ type: 'islandKey', island: 4 } as ServerMessage)).toBe('islandDelta:4');
    expect(deltaMatchesKey({ island: 4, keyTick: 100 }, 4, 100)).toBe(true);
    expect(deltaMatchesKey({ island: 4, keyTick: 100 }, 4, 160)).toBe(false);
    expect(deltaMatchesKey({ island: 4, keyTick: 100 }, 5, 100)).toBe(false);
    expect(deltaMatchesKey({ island: 4, keyTick: 100 }, null, null)).toBe(false);
  });
});

describe('finding 8: numbers are checked in the codec', () => {
  const decode1 = (m: ClientMessage) => decodeFrame(encodeFrame([m]), { source: 'client' });
  it('-0 becomes 0, a rate or a time limit out of range is refused, a non-unit hold is refused', () => {
    const r = decode1({ type: 'command', cmdId: 1, tick: -0, command: { kind: 'lights' } } as ClientMessage);
    expect(r.ok && Object.is((r.messages[0] as { tick: number }).tick, 0)).toBe(true);
    expect(() => encodeFrame([{ type: 'command', cmdId: 1, tick: 1, command: { kind: 'transfer', from: 'a', to: 'b', resource: 'lox', rate: 1e9 } } as ClientMessage])).toThrow();
    expect(() => encodeFrame([{ type: 'command', cmdId: 1, tick: 1, command: { kind: 'advanceLimit', craftId: 'a', seconds: -1 } } as ClientMessage])).toThrow();
    expect(() => encodeFrame([{ type: 'input', samples: [{ seq: 1, applyTick: 1, throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, sasHold: { x: 3, y: 0, z: 0 } }] }])).toThrow();
    expect(() => encodeFrame([{ type: 'attach', reqId: 1, vesselId: 'has space', clockId: null }])).toThrow();
  });
});

describe('finding 11: allocation on the adversarial maximum', () => {
  it('the largest client frame the gateway decodes allocates a bounded amount, and the sample cap stops a bigger one early', () => {
    const l = wireLimits(DEFAULT_UNIVERSE_RULES);
    // The worst case per byte the cap allows: input messages of single samples (an object per sample), to the cap.
    const one = (seq: number) => encodeMessage({ type: 'input', samples: [{ seq, applyTick: 5000 + seq, throttle: 1, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, sasHold: { x: 0, y: 0, z: 1 } }] });
    const atCap = assembleFrame(Array.from({ length: l.inputSamplesPerFrame }, (_, i) => one(i + 1)));
    const overCap = assembleFrame(Array.from({ length: 256 }, (_, i) => one(i + 1)));
    expect(atCap.length).toBeLessThanOrEqual(WIRE_CONSTANTS.maxClientFrameBytes);
    const measure = (frame: Uint8Array) => {
      for (let i = 0; i < 200; i++) decodeFrame(frame, { source: 'client', maxInputSamples: l.inputSamplesPerFrame });
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) decodeFrame(frame, { source: 'client', maxInputSamples: l.inputSamplesPerFrame });
      return (process.memoryUsage().heapUsed - before) / 100;
    };
    const perFrame = measure(atCap);
    const perOver = measure(overCap);
    console.log(`adversarial: ${atCap.length} B frame at the sample cap allocates ${(perFrame / 1024).toFixed(1)} kB per decode; over the cap ${(perOver / 1024).toFixed(1)} kB before it stops`);
    expect(decodeFrame(overCap, { source: 'client', maxInputSamples: l.inputSamplesPerFrame }).ok).toBe(false);
    // At most ~1 kB per sample (the message, the sample, its hold vector) and so bounded by the cap.
    expect(perFrame).toBeLessThan(l.inputSamplesPerFrame * 1024);
    expect(perOver).toBeLessThan(l.inputSamplesPerFrame * 1024 * 1.2);
  });
});

describe('finding 16: the client against a bad server frame', () => {
  const online = () => {
    const s = new ClientSession({ build: 'b', defsHash: 'd', cpuScore: null, accountId: 'a', random: () => 0.5 });
    s.connect();
    s.transportOpen();
    s.messages([{ type: 'challenge', nonce: new Uint8Array(8), serverId: 'gw' }]);
    s.signed(new Uint8Array(4));
    s.messages([{ type: 'welcome', session: 't', accountId: 'a', callsign: 'A', rulesId: 'r', rulesVersion: 1, liveClock: { id: 'live', kind: 'live', tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] }, serverMs: 0, upMs: 0, resumed: null }]);
    s.drain();
    return s;
  };

  it('an acknowledged range of 6,000,000 inputs costs nothing; late applications are pruned', () => {
    const w = new InputWindow();
    for (let i = 0; i < 100; i++) w.add({ throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0 } as never, i, null);
    gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    w.acknowledge({ type: 'inputAck', marginMs: null, stamped: [{ from: 1, to: 6_000_000 }], late: [] });
    expect(performance.now() - t0).toBeLessThan(20);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1024 * 1024);
    expect(w.message()).toBeNull();
    const v = new InputWindow();
    for (let i = 0; i < 1000; i++) v.add({ throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0 } as never, i, null);
    v.acknowledge({ type: 'inputAck', marginMs: null, stamped: [], late: Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, appliedTick: i + 5 })) });
    expect(v.lateApplied.size).toBeLessThanOrEqual(256);
  });

  it('a retry-after beyond ten minutes is clamped; close code 4002 without its message ends the session as taken over', () => {
    const s = online();
    s.messages([{ type: 'refused', reason: 'full', text: 'full', retryAfterMs: 1e12, queue: { position: 3, etaSeconds: 60 } }]);
    expect(s.nextDeadline()!).toBeLessThanOrEqual(10 * 60_000 + 1);
    const t = online();
    t.transportClosed({ code: 4002, reason: '', clean: true });
    expect(t.phase).toBe('takenOver');
  });
});
