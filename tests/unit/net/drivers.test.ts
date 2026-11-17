/**
 * The drivers against a hostile peer (review findings 1, 2 and 11): the frame that took a gateway down, an
 * error inside a host's callback, the upstream bucket, pings before the welcome, the send-queue caps, and a
 * structure-aware fuzz that drives a ServerDriver and a ClientDriver with decoded messages (valid ones, ones
 * with extreme field values, and bit-flipped frames) while time advances. Nothing a peer sends may throw out
 * of a driver; an error inside a machine would close one socket and is counted as a failure here.
 */
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ClockState, ServerMessage, WireMessage, WireMessageType } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, wireLimits } from '@/core/contracts/net';
import { assembleFrame, decodeFrame, encodeFrame, encodeMessage } from '@/net/codec/framing';
import { HandleTableOut } from '@/net/codec/handles';
import { MESSAGE_SPECS, randomMessage } from '@/net/codec/messages';
import { Gen } from '@/net/codec/schema';
import { ClientSession } from '@/net/session/client';
import { ClientDriver, ServerDriver, type ServerHost } from '@/net/session/driver';
import { ManualScheduler } from '@/net/time/scheduler';
import { createLoopbackPair, type LoopbackTransport } from '@/net/transport/loopback';
import { CLOSE } from '@/net/transport/types';

const rules = DEFAULT_UNIVERSE_RULES;
const live: ClockState = { id: 'live', kind: 'live', tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] };
const HELLO: ClientMessage = { type: 'hello', protocol: 1, build: 'b', defsHash: 'd', cpuScore: null, resume: null };
const AUTH: ClientMessage = { type: 'auth', accountId: 'a', signature: new Uint8Array(4) };

interface Gateway {
  sch: ManualScheduler;
  client: LoopbackTransport;
  driver: ServerDriver;
  errors: unknown[];
  closes: number[];
  received: ServerMessage[];
  forwarded: ClientMessage[];
}

/** A gateway driver on a loopback; `withClock`: the host sets the pilot's clock after the welcome. */
function gateway(sch: ManualScheduler, withClock: boolean, host: Partial<ServerHost> = {}): Gateway {
  const [client, server] = createLoopbackPair(sch);
  const g: Gateway = { sch, client, driver: null as unknown as ServerDriver, errors: [], closes: [], received: [], forwarded: [] };
  g.driver = new ServerDriver({
    transport: server,
    scheduler: sch,
    upMs: () => sch.now(),
    config: { build: 'b', defsHash: 'd', serverId: 'gw', rules, nonce: () => new Uint8Array(8) },
    host: {
      verifyAuth: (_r, d) => {
        d.authResult({ ok: true, accountId: 'a', callsign: 'A', session: 't', liveClock: live, serverMs: sch.now(), upMs: sch.now() });
        if (withClock) d.enter((s) => s.setClock(live));
      },
      resume: (_r, d) => d.resumeResult({ ok: false, text: 'no' }),
      forward: (m) => g.forwarded.push(m),
      error: (e) => g.errors.push(e),
      ...host,
    },
  });
  client.setHandler({
    frame: (bytes) => {
      const r = decodeFrame(bytes, { source: 'server' });
      if (r.ok) g.received.push(...(r.messages as ServerMessage[]));
    },
    close: (info) => g.closes.push(info.code),
  });
  return g;
}

function online(g: Gateway): void {
  g.client.send(encodeFrame([HELLO]));
  g.sch.advanceBy(5);
  g.client.send(encodeFrame([AUTH]));
  g.sch.advanceBy(5);
  expect(g.driver.session.phase).toBe('online');
}

describe('blocker 1: one frame from an authenticated client', () => {
  const FRAME = Uint8Array.from(Buffer.from('0107120101ffffffffffff3fc30000000000000000', 'hex'));

  it('decodes as an input stamped at -(2^53 - 1)', () => {
    const r = decodeFrame(FRAME, { source: 'client' });
    expect(r.ok).toBe(true);
    if (r.ok && r.messages[0]!.type === 'input') expect(r.messages[0]!.samples[0]!.applyTick).toBe(-(2 ** 53 - 1));
  });

  it('is dropped without a pilot clock (fail closed); the gateway goes on', () => {
    const g = gateway(new ManualScheduler(), false);
    online(g);
    g.client.send(FRAME);
    expect(() => g.sch.advanceBy(2000)).not.toThrow();
    expect(g.driver.session.inputs.stats.dropped.noClock).toBe(1);
    expect(g.forwarded.filter((m) => m.type === 'input')).toHaveLength(0);
    expect(g.errors).toEqual([]);
    expect(g.driver.session.phase).toBe('online');
  });

  it('is dropped as stamped before the window with a clock; the margin reported stays in range', () => {
    const g = gateway(new ManualScheduler(), true);
    online(g);
    g.client.send(FRAME);
    expect(() => g.sch.advanceBy(2000)).not.toThrow();
    expect(g.driver.session.inputs.stats.dropped.past).toBe(1);
    expect(g.errors).toEqual([]);
    for (const m of g.received) if (m.type === 'inputAck' && m.marginMs !== null) expect(Math.abs(m.marginMs)).toBeLessThanOrEqual(60_000);
  });

  it('an error inside the machine or the host closes THAT socket (1011) and no other', () => {
    const sch = new ManualScheduler();
    const bad = gateway(sch, true, {
      forward: () => {
        throw new Error('host bug');
      },
    });
    const good = gateway(sch, true);
    online(bad);
    online(good);
    const cmd: ClientMessage = { type: 'command', cmdId: 1, tick: 10, command: { kind: 'lights' } } as ClientMessage;
    bad.client.send(encodeFrame([cmd]));
    good.client.send(encodeFrame([cmd]));
    expect(() => sch.advanceBy(100)).not.toThrow();
    expect(bad.errors).toHaveLength(1);
    expect(bad.closes).toEqual([CLOSE.internalError]);
    expect(good.closes).toEqual([]);
    expect(good.driver.session.phase).toBe('online');
  });
});

describe('blocker 2: floods', () => {
  const l = wireLimits(rules);

  it('the upstream bucket closes a socket that sends more frames than the rules allow, before decoding', () => {
    const g = gateway(new ManualScheduler(), true);
    online(g);
    for (let i = 0; i < l.upstreamBurstFrames + 5; i++) g.client.send(encodeFrame([{ type: 'ping', seq: i }]));
    g.sch.advanceBy(10);
    expect(g.closes).toEqual([CLOSE.refused]);
  });

  it('pings are answered at the rules rate and never before the welcome; the handshake takes a handful of messages', () => {
    const g = gateway(new ManualScheduler(), true);
    for (let i = 0; i < 30; i++) g.client.send(encodeFrame([{ type: 'ping', seq: i }]));
    g.sch.advanceBy(5);
    expect(g.received.filter((m) => m.type === 'pong')).toHaveLength(0);
    online(g);
    g.received.length = 0;
    for (let t = 0; t < 10; t++) {
      g.client.send(encodeFrame(Array.from({ length: 10 }, (_, i) => ({ type: 'ping' as const, seq: i }))));
      g.client.send(encodeFrame(Array.from({ length: 10 }, (_, i) => ({ type: 'timeSync' as const, seq: i, clientMs: 0 }))));
      g.sch.advanceBy(1000);
    }
    expect(g.received.filter((m) => m.type === 'pong').length).toBeLessThanOrEqual(10 * l.pingsPerSecond + 1);
    expect(g.received.filter((m) => m.type === 'timeSyncReply').length).toBeLessThanOrEqual(10 * l.timeSyncsPerSecond + 1);
    const h = gateway(new ManualScheduler(), true);
    h.client.send(encodeFrame([HELLO]));
    h.sch.advanceBy(5);
    h.client.send(encodeFrame(Array.from({ length: l.handshakeMessages }, () => HELLO)));
    h.sch.advanceBy(5);
    expect(h.closes).toEqual([CLOSE.refused]);
  });

  const big = (i: number): ServerMessage => ({ type: 'commandResult', cmdId: i, ok: false, appliedTick: null, reason: 'x'.repeat(3000), alternative: null });

  it('what waits for a socket is capped in bytes and in age (control records included): over a cap the socket closes', () => {
    // Bytes: 1.2 MB of control records at once.
    const a = gateway(new ManualScheduler(), true);
    online(a);
    for (let i = 0; i < 400; i++) a.driver.push(big(i));
    a.sch.advanceBy(10);
    expect(a.closes).toEqual([CLOSE.slowConsumer]);
    // Age: 150 kB of control records drain at 6 kB/s in 25 s, longer than the age cap.
    const b = gateway(new ManualScheduler(), true);
    online(b);
    for (let i = 0; i < 50; i++) b.driver.push(big(i));
    // The client stays alive (pings), it just cannot take what is sent fast enough.
    for (let t = 0; t < l.sendQueueAge + 1; t++) {
      b.client.send(encodeFrame([{ type: 'ping', seq: t }]));
      b.sch.advanceBy(1000);
    }
    expect(b.closes).toEqual([CLOSE.slowConsumer]);
  });
});

// ------------------------------------------------------------------------------------- the fuzz

const EXTREMES = [0, -0, 1, -1, 0.5, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 53 - 1, -(2 ** 53 - 1), 1e15, 1e300, -1e300, 5e-324];

/** A copy of `v` with some numeric fields replaced by extreme values (the codec decides what may be encoded). */
function mutate(v: unknown, g: Gen, p: number): unknown {
  if (typeof v === 'number') return g.chance(p) ? g.pick(EXTREMES) : v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map((x) => mutate(x, g, p));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'type' ? x : mutate(x, g, p)]));
  return v;
}

const typesFrom = (senders: string[]) => MESSAGE_SPECS.filter((s) => senders.includes(s.sender)).map((s) => s.type);

/** Encode `m` (mutated with probability, falling back to the valid instance when the encoder refuses). */
function fuzzRecord(type: WireMessageType, g: Gen, table: HandleTableOut | null): Uint8Array[] {
  const valid = randomMessage(type, g) as WireMessage;
  const candidates = g.chance(0.4) ? [mutate(valid, g, 0.2) as WireMessage, valid] : [valid];
  for (const m of candidates) {
    try {
      const rec = encodeMessage(m, table);
      const h = table?.takePending();
      return h ? [encodeMessage(h), rec] : [rec];
    } catch {
      table?.takePending();
    }
  }
  return [];
}

function flip(frame: Uint8Array, g: Gen): Uint8Array {
  const out = frame.slice();
  for (let i = 0; i < g.int(1, 3); i++) out[g.int(0, out.length - 1)]! ^= 1 << g.int(0, 7);
  return out;
}

describe('structure-aware fuzz of the drivers (decoded messages, extreme fields, bit flips, advancing time)', () => {
  it('a ServerDriver never throws and never errors inside its machine over 20,000 client frames', () => {
    const sch = new ManualScheduler();
    const g = new Gen(0xf0221);
    const types = typesFrom(['client', 'both']).filter((t) => t !== 'hello' && t !== 'auth' && t !== 'bye');
    let gw = gateway(sch, true);
    online(gw);
    let errors = 0;
    let reopened = 0;
    let delivered = 0;
    for (let i = 0; i < 20_000; i++) {
      if (gw.driver.session.phase === 'closed') {
        errors += gw.errors.length;
        gw = gateway(sch, g.chance(0.8));
        online(gw);
        reopened++;
      }
      const records = Array.from({ length: g.int(1, 4) }, () => fuzzRecord(g.pick(types), g, null)).flat();
      if (records.length === 0) continue;
      let frame = assembleFrame(records);
      if (g.chance(0.1)) frame = flip(frame, g);
      gw.client.send(frame);
      delivered++;
      expect(() => sch.advanceBy(g.int(0, 60))).not.toThrow();
    }
    errors += gw.errors.length;
    console.log(`server fuzz: ${delivered} frames, ${reopened} sockets closed by the gateway (malformed or limited), ${errors} internal errors`);
    expect(errors).toBe(0);
  });

  it('a ClientDriver never throws and never errors inside its machine over 20,000 server frames', () => {
    const sch = new ManualScheduler();
    const g = new Gen(0xc11e);
    const types = typesFrom(['server', 'both']).filter((t) => t !== 'handles');
    let server: LoopbackTransport | null = null;
    let table = new HandleTableOut();
    const firstErrors: string[] = [];
    let errors = 0;
    const session = new ClientSession({ build: 'b', defsHash: 'd', cpuScore: null, accountId: 'a', rules, random: () => 0.5 });
    const driver = new ClientDriver({
      session,
      scheduler: sch,
      connect: () => {
        const [c, s] = createLoopbackPair(sch);
        server = s;
        table = new HandleTableOut();
        s.setHandler({
          frame: (bytes) => {
            const r = decodeFrame(bytes, { source: 'client' });
            if (!r.ok) return;
            for (const m of r.messages) {
              if (m.type === 'hello') s.send(encodeFrame([{ type: 'challenge', nonce: new Uint8Array(8), serverId: 'gw' }]));
              if (m.type === 'auth') s.send(encodeFrame([{ type: 'welcome', session: 't', accountId: 'a', callsign: 'A', rulesId: rules.id, rulesVersion: rules.version, liveClock: live, serverMs: sch.now(), upMs: sch.now(), resumed: null }]));
            }
          },
          close: () => undefined,
        });
        return c;
      },
      sign: () => new Uint8Array(4),
      onError: (e) => {
        errors++;
        if (firstErrors.length < 3) firstErrors.push(String((e as Error).stack ?? e).split('\n').slice(0, 4).join(' | '));
      },
    });
    driver.start();
    sch.advanceBy(50);
    let sent = 0;
    for (let i = 0; i < 20_000; i++) {
      const s = server as LoopbackTransport | null;
      if (s && s.state === 'open') {
        const records = Array.from({ length: g.int(1, 3) }, () => fuzzRecord(g.pick(types), g, table)).flat();
        if (records.length) {
          let frame = assembleFrame(records);
          if (g.chance(0.05)) frame = flip(frame, g);
          s.send(frame);
          sent++;
        }
      }
      // The app keeps using the session meanwhile.
      if (i % 7 === 0) driver.enter((c) => c.command(Math.floor(sch.now() * 0.12), { kind: 'lights' } as never));
      // And once in a while a request the encoder refuses (an app bug): answered as refused, never queued.
      if (i % 997 === 0) driver.enter((c) => c.command(0.5, { kind: 'lights' } as never));
      expect(() => sch.advanceBy(g.int(0, 80))).not.toThrow();
    }
    console.log(`client fuzz: ${sent} frames, ${errors} internal errors`, firstErrors);
    expect(errors).toBe(0);
  });
});
