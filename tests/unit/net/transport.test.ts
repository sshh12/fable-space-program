/**
 * Transports on real sockets and real time (Node): the length-prefixed stream over TCP, the WHATWG WebSocket
 * transport (Node's own WebSocket client) against an RFC 6455 server, the `ws` adapter against the `ws`
 * socket interface, and the injector: the wrapper reproduces a scripted profile (150 ms +/- 20 ms, 5 % stalls
 * of 200 ms) within 5 ms on real timers, and the stand-alone proxy process injects the profile into a TCP
 * link (measured end to end).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { WireMessage } from '@/core/contracts/net';
import { decodeFrame, encodeFrame } from '@/net/codec/framing';
import { injectTransport } from '@/net/injector/injected';
import { ManualScheduler, RealScheduler } from '@/net/time/scheduler';
import { createLoopbackPair } from '@/net/transport/loopback';
import { FrameAssembler, lengthPrefixed, streamTransport } from '@/net/transport/stream';
import type { CloseInfo, Transport } from '@/net/transport/types';
import { connectWebSocket, nodeWsTransport, type WsSocketLike } from '@/net/transport/websocket';
import { startMiniWsServer } from './helpers/miniWsServer';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

function nextFrames(t: Transport, n: number): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const got: Uint8Array[] = [];
    t.setHandler({
      frame: (b) => {
        got.push(b);
        if (got.length === n) resolve(got);
      },
      close: () => resolve(got),
    });
  });
}

function closed(t: Transport): Promise<CloseInfo> {
  return new Promise((resolve) => t.setHandler({ frame: () => undefined, close: resolve }));
}

const ping = (seq: number): WireMessage => ({ type: 'ping', seq });

describe('the length-prefixed stream', () => {
  it('reassembles frames from any chunking and refuses a declared length above the limit', () => {
    const frames = [encodeFrame([ping(1)]), encodeFrame([{ type: 'plan', craftId: 'c', data: new Uint8Array(3000).fill(9) }]), encodeFrame([ping(2)])];
    const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length + 4, 0));
    let o = 0;
    for (const f of frames) {
      bytes.set(lengthPrefixed(f), o);
      o += f.length + 4;
    }
    for (const step of [1, 3, 7, 4096]) {
      const a = new FrameAssembler(1 << 20);
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += step) expect(a.push(bytes.subarray(i, i + step), (f) => out.push(f))).toBe(true);
      expect(out).toEqual(frames);
    }
    expect(new FrameAssembler(100).push(lengthPrefixed(new Uint8Array(101)), () => undefined)).toBe(false);
  });

  it('carries frames both ways over a real TCP connection', async () => {
    let serverSide: Socket | null = null;
    const server: Server = createServer((s) => (serverSide = s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    const sock = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((r) => sock.on('connect', () => r()));
    while (!serverSide) await new Promise((r) => setTimeout(r, 5));
    const a = streamTransport(sock);
    const b = streamTransport(serverSide);
    const got = nextFrames(b, 50);
    for (let i = 0; i < 50; i++) a.send(encodeFrame([ping(i)]));
    const frames = await got;
    expect(frames.map((f) => (decodeFrame(f, { source: 'server' }) as { messages: { seq: number }[] }).messages[0]!.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    const back = nextFrames(a, 1);
    b.send(encodeFrame([ping(99)]));
    expect((await back).length).toBe(1);
    const c = closed(b);
    a.close();
    expect((await c).clean).toBe(true);
  });
});

describe('the WebSocket transports', () => {
  it('the WHATWG transport (Node WebSocket) exchanges binary frames with an RFC 6455 server, and refuses text', async () => {
    const srv = await startMiniWsServer();
    cleanups.push(() => srv.stop());
    const t = connectWebSocket(`ws://127.0.0.1:${srv.port}/`);
    await new Promise<void>((r) => t.setHandler({ open: () => r(), frame: () => undefined, close: () => undefined }));
    expect(t.state).toBe('open');
    const conn = srv.connections[0]!;
    const echoed = new Promise<Uint8Array>((r) => (conn.onBinary = r));
    const frame = encodeFrame([ping(7), { type: 'timeSync', seq: 1, clientMs: 12.5 }]);
    t.send(frame);
    expect(await echoed).toEqual(frame);
    const got = nextFrames(t, 1);
    conn.sendBinary(encodeFrame([{ type: 'durable', tick: 42 }]));
    const res = decodeFrame((await got)[0]!, { source: 'server' });
    expect(res.ok && res.messages[0]).toEqual({ type: 'durable', tick: 42 });
    const c = closed(t);
    conn.sendText('not binary');
    const info = await c;
    expect([1003, 1006, 1005]).toContain(info.code);
  });

  it('the ws adapter reads binary messages, refuses text, copies on send and reports the close', () => {
    class FakeWs extends EventEmitter implements WsSocketLike {
      readyState = 1;
      bufferedAmount = 0;
      binaryType = 'arraybuffer';
      sent: Uint8Array[] = [];
      closedWith: number | null = null;
      send(data: Uint8Array): void {
        this.sent.push(data);
      }
      close(code?: number): void {
        this.closedWith = code ?? 1000;
        this.readyState = 3;
        this.emit('close', code ?? 1000, new TextEncoder().encode('bye'));
      }
      terminate(): void {
        this.readyState = 3;
      }
    }
    const ws = new FakeWs();
    const t = nodeWsTransport(ws);
    expect(ws.binaryType).toBe('nodebuffer');
    const frames: Uint8Array[] = [];
    let info: CloseInfo | null = null;
    t.setHandler({ frame: (f) => frames.push(f), close: (i) => (info = i) });
    const buf = encodeFrame([ping(1)]);
    ws.emit('message', Buffer.from(buf), true);
    ws.emit('message', [Buffer.from(buf.subarray(0, 2)), Buffer.from(buf.subarray(2))], true);
    expect(frames).toEqual([buf, buf]);
    const mine = new Uint8Array([1, 2, 3]);
    t.send(mine);
    mine[0] = 9;
    expect(ws.sent[0]![0]).toBe(1);
    ws.emit('message', Buffer.from('text'), false);
    expect(ws.closedWith).toBe(1003);
    expect(info).toEqual({ code: 1003, reason: 'bye', clean: true });
  });
});

/**
 * How late this runner's timers fire through `sch` (precise mode), measured the way the injector uses them: a
 * timer every 33 ms with 130-170 ms delays. A real-time bound is then this lateness plus a fixed margin, never
 * less than the acceptance line: on a machine that holds the line it is the line; on a shared CI runner it is
 * what the runner allows, and an injector that is wrong by more than the runner's own jitter still fails.
 */
async function timerLateness(sch: RealScheduler, n = 60): Promise<{ max: number; p99: number }> {
  const late: number[] = [];
  await new Promise<void>((done) => {
    let fired = 0;
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const d = 130 + ((i * 7919) % 41);
        const due = sch.now() + d;
        sch.setTimer(d, () => {
          late.push(sch.now() - due);
          if (++fired === n) done();
        });
      }, 33 * i);
    }
  });
  const sorted = late.sort((a, b) => a - b);
  return { max: sorted[sorted.length - 1]!, p99: sorted[Math.floor(0.99 * (sorted.length - 1))]! };
}

/** The real-time bound: the acceptance line, or the runner's measured lateness plus `margin` when that is larger. */
function realTimeBound(line: number, lateness: number, margin: number): number {
  return Math.max(line, lateness + margin);
}

describe('the injector', () => {
  it('reproduces a scripted profile EXACTLY on the virtual clock: delays, jitter, stalls, order (everywhere, CI included)', () => {
    const sch = new ManualScheduler();
    const [a, b] = createLoopbackPair(sch);
    const profile = { up: { delayMs: 150, jitterMs: 20, stallChance: 0.05, stallMs: 200, bytesPerSecond: null }, down: { delayMs: 0, jitterMs: 0, stallChance: 0, stallMs: 0, bytesPerSecond: null }, seed: 7 };
    const t = injectTransport(a, profile, sch, [], { logUnits: true });
    const got: number[] = [];
    b.setHandler({
      frame: (bytes) => {
        const r = decodeFrame(bytes, { source: 'role' });
        if (r.ok && r.messages[0]!.type === 'ping') got.push(r.messages[0]!.seq);
      },
      close: () => undefined,
    });
    const N = 300;
    for (let i = 0; i < N; i++) {
      t.send(encodeFrame([ping(i)]));
      sch.advanceBy(33);
    }
    sch.advanceBy(2000);
    const ups = t.log.filter((u) => u.dir === 'up');
    expect(ups).toHaveLength(N);
    // Every frame delivered exactly when the script says, in order, none lost.
    for (const u of ups) expect(u.deliveredMs).toBe(u.arriveMs);
    expect(got).toEqual(Array.from({ length: N }, (_, i) => i));
    for (let i = 1; i < N; i++) expect(ups[i]!.arriveMs).toBeGreaterThanOrEqual(ups[i - 1]!.arriveMs);
    const base = ups.filter((u) => !u.stalled).map((u) => u.baseDelayMs);
    expect(Math.min(...base)).toBeGreaterThanOrEqual(130);
    expect(Math.max(...base)).toBeLessThanOrEqual(170);
    const stalled = ups.filter((u) => u.stalled).length;
    expect(stalled).toBeGreaterThan(0);
    expect(Math.max(...ups.map((u) => u.arriveMs - u.sendMs))).toBeGreaterThanOrEqual(150 + 200 - 33);
  });

  it('reproduces a scripted profile (150 ms +/- 20 ms, 5 % stalls of 200 ms) within 5 ms on real timers (or the runner jitter, measured)', async () => {
    const sch = new RealScheduler({ precise: true });
    cleanups.push(() => sch.clearAll());
    const [a, b] = createLoopbackPair(sch);
    const profile = { up: { delayMs: 150, jitterMs: 20, stallChance: 0.05, stallMs: 200, bytesPerSecond: null }, down: { delayMs: 0, jitterMs: 0, stallChance: 0, stallMs: 0, bytesPerSecond: null }, seed: 7 };
    const t = injectTransport(a, profile, sch, [], { logUnits: true });
    const N = 300;
    const done = nextFrames(b, N);
    for (let i = 0; i < N; i++) {
      t.send(encodeFrame([ping(i)]));
      await new Promise((r) => setTimeout(r, 33));
    }
    await done;
    await new Promise((r) => setTimeout(r, 50));
    const ups = t.log.filter((u) => u.dir === 'up');
    expect(ups).toHaveLength(N);
    const errs = ups.map((u) => u.deliveredMs! - u.arriveMs);
    const delays = ups.map((u) => u.arriveMs - u.sendMs);
    const base = ups.filter((u) => !u.stalled).map((u) => u.baseDelayMs);
    const stalls = ups.filter((u) => u.stalled).length;
    const episodes = ups.filter((u, i) => u.stalled && (i === 0 || !ups[i - 1]!.stalled)).length;
    const maxErr = Math.max(...errs);
    const minErr = Math.min(...errs);
    const sorted = errs.slice().sort((x, y) => x - y);
    const p99 = sorted[Math.floor(0.99 * sorted.length)]!;
    console.log(
      `injector: ${N} frames; delivery minus script: min ${minErr.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${maxErr.toFixed(2)} ms; ` +
        `scripted delay mean ${(delays.reduce((s, d) => s + d, 0) / N).toFixed(1)} ms, base delay ${Math.min(...base).toFixed(1)}..${Math.max(...base).toFixed(1)} ms; ` +
        `stall episodes ${episodes}, frames held by them ${stalls} (${((100 * stalls) / N).toFixed(1)} %), longest delay ${Math.max(...delays).toFixed(1)} ms`,
    );
    const cal = await timerLateness(sch);
    const bound = realTimeBound(5, cal.max, 3);
    console.log(`injector: runner timer lateness max ${cal.max.toFixed(2)} ms, p99 ${cal.p99.toFixed(2)} ms; bound on the injector's error ${bound.toFixed(2)} ms (the 5 ms line ${bound === 5 ? 'holds here' : 'is beyond this runner'})`);
    expect(minErr).toBeGreaterThanOrEqual(-0.5);
    expect(maxErr).toBeLessThanOrEqual(bound);
    expect(Math.min(...base)).toBeGreaterThanOrEqual(130);
    expect(Math.max(...base)).toBeLessThanOrEqual(170);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(150 + 200 - 33);
  }, 60_000);

  it('the stand-alone proxy process injects its profile into a TCP link', async () => {
    // An echo server behind the proxy.
    // (The echo's sockets see a reset when the proxy process is killed at the end: that is expected, not an error.)
    const echo = createServer((s) => s.on('error', () => undefined).on('data', (d) => s.write(d)));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => echo.close(() => r())));
    const echoPort = (echo.address() as { port: number }).port;
    const proc: ChildProcess = spawn(process.execPath, [path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repo, 'tests/unit/net/proxy/latencyProxy.ts'), '--listen', '0', '--target', `127.0.0.1:${echoPort}`, '--profile', 'rtt=300,jitter=10,seed=3', '--precise'], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    cleanups.push(() => {
      proc.stdin?.end();
      proc.kill();
    });
    const port = await new Promise<number>((resolve, reject) => {
      proc.stdout!.on('data', (d: Buffer) => {
        const m = /listening (\d+)/.exec(d.toString());
        if (m) resolve(Number(m[1]));
      });
      proc.on('exit', (code) => reject(new Error(`proxy exited ${code}`)));
    });
    const sock = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((r) => sock.on('connect', () => r()));
    sock.setNoDelay(true);
    const t = streamTransport(sock);
    const rtts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const got = nextFrames(t, 1);
      const t0 = performance.now();
      t.send(encodeFrame([ping(i)]));
      await got;
      rtts.push(performance.now() - t0);
    }
    t.close();
    // The runner's own costs: a direct round trip to the echo server (no proxy), and its timer lateness (the
    // proxy process fires two timers per round trip on the same machine).
    const direct = createConnection({ host: '127.0.0.1', port: echoPort });
    await new Promise<void>((r) => direct.on('connect', () => r()));
    direct.setNoDelay(true);
    const dt = streamTransport(direct);
    let directMax = 0;
    for (let i = 0; i < 10; i++) {
      const got = nextFrames(dt, 1);
      const t0 = performance.now();
      dt.send(encodeFrame([ping(i)]));
      await got;
      directMax = Math.max(directMax, performance.now() - t0);
    }
    dt.close();
    const cal = await timerLateness(new RealScheduler({ precise: true }), 30);
    const upper = 320 + realTimeBound(10, directMax + 2 * cal.max, 5);
    const mean = rtts.reduce((s, x) => s + x, 0) / rtts.length;
    console.log(`proxy: round trips ${rtts.map((x) => x.toFixed(0)).join(', ')} ms (mean ${mean.toFixed(1)}; scripted 300 +/- 2 x 10); runner: direct round trip max ${directMax.toFixed(2)} ms, timer lateness max ${cal.max.toFixed(2)} ms; upper bound ${upper.toFixed(1)} ms`);
    // 300 ms with 10 ms of jitter each way; above it, the loop of two sockets and two event loops (10 ms where the
    // machine allows, the runner's measured costs plus 5 ms where it does not). Timers never fire early, so the
    // lower bound needs no calibration.
    expect(Math.min(...rtts)).toBeGreaterThanOrEqual(280);
    expect(Math.max(...rtts)).toBeLessThanOrEqual(upper);
  }, 60_000);
});
