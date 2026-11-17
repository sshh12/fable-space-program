/**
 * The transports and the gateway against a REAL `ws` server (ws 8.23, installed by the lead): `WS_SERVER_OPTIONS`
 * in force (maxPayload refuses an oversize message before it is buffered; no per-message deflate), fragmented
 * messages, `bufferedAmount` and the send caps under a peer that stops reading, close codes and reasons both
 * ways, terminate() after a declared loss, the upstream bucket and the pre-auth rules over a real socket.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage, UniverseRules } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, WIRE_CONSTANTS, WIRE_PROTOCOL_VERSION } from '@/core/contracts/net';
import { decodeFrame, encodeFrame } from '@/net/codec/framing';
import { ServerDriver } from '@/net/session/driver';
import { RealScheduler } from '@/net/time/scheduler';
import { Sender } from '@/net/transport/sender';
import type { Transport } from '@/net/transport/types';
import { CLOSE } from '@/net/transport/types';
import { nodeWsTransport, WS_SERVER_OPTIONS, type WsSocketLike } from '@/net/transport/websocket';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const HELLO: ClientMessage = { type: 'hello', protocol: WIRE_PROTOCOL_VERSION, build: 'b', defsHash: 'd', cpuScore: null, resume: null };
const live = { id: 'live', kind: 'live' as const, tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] };

interface Gateway {
  url: string;
  drivers: ServerDriver[];
  transports: Transport[];
  framesIn: number;
}

/** A `ws` server with the gateway's options; each connection gets a ServerDriver (or `onSocket` when given). */
async function gateway(rules: UniverseRules = DEFAULT_UNIVERSE_RULES, onSocket?: (t: Transport, raw: WebSocket) => void): Promise<Gateway> {
  const wss = new WebSocketServer({ ...WS_SERVER_OPTIONS, port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const g: Gateway = { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, drivers: [], transports: [], framesIn: 0 };
  const sch = new RealScheduler();
  wss.on('connection', (raw) => {
    const t = nodeWsTransport(raw as unknown as WsSocketLike);
    g.transports.push(t);
    if (onSocket) return onSocket(t, raw);
    g.drivers.push(
      new ServerDriver({
        transport: t,
        scheduler: sch,
        upMs: () => sch.now(),
        config: { build: 'b', defsHash: 'd', serverId: 'gw', rules, nonce: () => new Uint8Array(8) },
        onFrameIn: () => g.framesIn++,
        host: {
          verifyAuth: (_r, d) => {
            d.authResult({ ok: true, accountId: 'a', callsign: 'A', session: 't', liveClock: live, serverMs: sch.now(), upMs: sch.now() });
            d.enter((s) => s.setClock(live));
          },
          resume: (_r, d) => d.resumeResult({ ok: false, text: 'no' }),
          forward: () => undefined,
        },
      }),
    );
  });
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  );
  return g;
}

/** A raw `ws` client: what it received, and how it closed. */
async function client(url: string) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const got: ServerMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('error', () => undefined);
  ws.on('message', (data) => {
    const f = decodeFrame(new Uint8Array(data as Buffer), { source: 'server' });
    if (f.ok) got.push(...(f.messages as ServerMessage[]));
  });
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  cleanups.push(() => ws.terminate());
  return { ws, got, closed, send: (m: ClientMessage[]) => ws.send(encodeFrame(m)) };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('a real ws server with WS_SERVER_OPTIONS', () => {
  it('negotiates no per-message deflate, and refuses an oversize message (1009) before the gateway sees it', async () => {
    const g = await gateway();
    const c = await client(g.url);
    expect(c.ws.extensions).toBe('');
    c.send([HELLO]);
    await until(() => c.got.some((m) => m.type === 'challenge'));
    const before = g.framesIn;
    c.ws.send(new Uint8Array(WIRE_CONSTANTS.maxClientFrameBytes + 1));
    const how = await c.closed;
    expect(how.code).toBe(1009);
    expect(g.framesIn).toBe(before);
  });

  it('reassembles a fragmented message into one frame', async () => {
    const g = await gateway();
    const c = await client(g.url);
    const frame = encodeFrame([HELLO]);
    const a = frame.subarray(0, 5);
    const b = frame.subarray(5);
    c.ws.send(a, { fin: false, binary: true });
    c.ws.send(b, { fin: true, binary: true });
    await until(() => c.got.some((m) => m.type === 'challenge'));
    expect(g.framesIn).toBe(1);
  });

  it('carries close codes and reasons both ways', async () => {
    // Server -> client: a refusal (4000, the reason) after the `refused` message itself.
    const g = await gateway();
    const c = await client(g.url);
    c.send([{ ...HELLO, build: 'old' } as ClientMessage]);
    const how = await c.closed;
    expect(how).toEqual({ code: CLOSE.refused, reason: 'build' });
    expect(c.got.map((m) => m.type)).toEqual(['refused']);
    // Client -> server: the gateway's transport reports the client's code and reason.
    let seen: { code: number; reason: string } | null = null;
    const h = await gateway(DEFAULT_UNIVERSE_RULES, (t) => t.setHandler({ frame: () => undefined, close: (info) => (seen = info) }));
    const d = await client(h.url);
    d.ws.close(4100, 'bye from the client');
    await until(() => seen !== null);
    expect(seen).toMatchObject({ code: 4100, reason: 'bye from the client' });
  });

  it('terminates (no close handshake) a socket declared lost', async () => {
    const rules: UniverseRules = { ...DEFAULT_UNIVERSE_RULES, disconnect: { ...DEFAULT_UNIVERSE_RULES.disconnect, pingInterval: 0.1, lossTimeout: 0.4 } };
    const g = await gateway(rules);
    const c = await client(g.url);
    c.send([HELLO]);
    // The client sends nothing more and does not answer pings: lost after 0.4 s, terminated, so the client
    // sees an abnormal close (1006), not 4001.
    const t0 = Date.now();
    const how = await c.closed;
    expect(how.code).toBe(1006);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('closes a pre-auth flood on the upstream bucket, answering no ping before the welcome', async () => {
    const g = await gateway();
    const c = await client(g.url);
    for (let i = 0; i < 400; i++) c.send([{ type: 'ping', seq: i }]);
    const how = await c.closed;
    expect(how.code).toBe(CLOSE.refused);
    expect(c.got.filter((m) => m.type === 'pong')).toHaveLength(0);
    expect(g.framesIn).toBeLessThanOrEqual(120 + 2);
  });
});

describe('back-pressure on a real socket whose peer stops reading', () => {
  it('bufferedAmount grows past the high-water mark, the sender holds back, and its caps trip', async () => {
    let server: Transport | null = null;
    const g = await gateway(DEFAULT_UNIVERSE_RULES, (t) => {
      server = t;
      t.setHandler({ frame: () => undefined, close: () => undefined });
    });
    const c = await client(g.url);
    await until(() => server !== null);
    // The peer stops reading: its socket is paused, the TCP window fills, then ws buffers on the server side.
    c.ws.pause();
    const t = server as unknown as Transport;
    const s = new Sender(t, { highWaterBytes: 256 * 1024, maxQueuedBytes: 2 * 1024 * 1024, maxQueueAgeMs: 2000 });
    const chunk = encodeFrame([{ type: 'commandResult', cmdId: 1, ok: false, appliedTick: null, reason: 'x'.repeat(4000), alternative: null }]).subarray(1);
    let held = 0;
    let at = 0;
    for (let i = 0; i < 4000 && !s.overflowed(at); i++) {
      s.pushRecord(chunk, null, at);
      if (s.flush() === 0 && s.queuedCount > 0) held++;
      at += 1;
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    console.log(`ws back-pressure: bufferedAmount ${t.bufferedAmount} B, ${held} flushes held back, queue ${s.queuedBytes} B, overflowed ${s.overflowed(at)}`);
    expect(t.bufferedAmount).toBeGreaterThan(256 * 1024);
    expect(held).toBeGreaterThan(0);
    expect(s.overflowed(at)).toBe(true);
    c.ws.resume();
  });
});
