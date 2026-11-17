/**
 * Unit tests of the session layer's parts: the gateway's rate limits and stamp bound (ARCHITECTURE 26), the
 * handshake timeout, standby, refusals of messages out of order, the input buffer's acknowledgements, the
 * backoff, the downstream budget, the back-pressure sender, time sync and the input-margin loop.
 */
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ClockState, ServerMessage } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, WIRE_CONSTANTS } from '@/core/contracts/net';
import { decodeFrame, encodeMessage } from '@/net/codec/framing';
import { DownstreamBudget } from '@/net/session/budget';
import { ClientSession } from '@/net/session/client';
import { InputBuffer, InputWindow } from '@/net/session/inputs';
import { backoffMs } from '@/net/session/limits';
import { ServerSession, type ServerConfig } from '@/net/session/server';
import { estimateClock, initialLead, leadParams, nextLead, offsetOf, rttOf, clockTickAt } from '@/net/time/sync';
import { ManualScheduler } from '@/net/time/scheduler';
import { createLoopbackPair } from '@/net/transport/loopback';
import { Sender } from '@/net/transport/sender';

const rules = DEFAULT_UNIVERSE_RULES;
const live: ClockState = { id: 'live', kind: 'live', tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] };
const cfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({ build: 'b', defsHash: 'd', serverId: 'gw', rules, nonce: () => new Uint8Array(8), ...over });

/** The server messages in a session's 'send' actions. */
function sent(s: ServerSession): ServerMessage[] {
  const out: ServerMessage[] = [];
  for (const a of s.drain()) {
    if (a.kind !== 'send') continue;
    for (const r of a.records) {
      const f = decodeFrame(new Uint8Array([1, ...r]), { source: 'server' });
      if (!f.ok) throw new Error(JSON.stringify(f.error));
      out.push(f.messages[0] as ServerMessage);
    }
  }
  return out;
}

/** A server session brought online at t = 0. */
function online(c = cfg()): ServerSession {
  const s = new ServerSession(c, 0, 0);
  s.messages([{ type: 'hello', protocol: 1, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
  s.messages([{ type: 'auth', accountId: 'a', signature: new Uint8Array(2) }]);
  s.authResult({ ok: true, accountId: 'a', callsign: 'A', session: 'tok', liveClock: live, serverMs: 0, upMs: 0 });
  s.setClock(live);
  s.drain();
  return s;
}

const sample = (seq: number, applyTick: number) => ({ seq, applyTick, throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, sasHold: null });

describe('the gateway session', () => {
  it('refuses messages out of order with a typed reason and closes', () => {
    const s = new ServerSession(cfg(), 0, 0);
    s.messages([{ type: 'input', samples: [] }]);
    expect(s.refusals).toEqual([{ reason: 'outOfOrder', detail: 'input before hello' }]);
    expect(s.phase).toBe('closed');
    const t = online();
    t.messages([{ type: 'auth', accountId: 'a', signature: new Uint8Array(1) }]);
    expect(t.refusals[0]!.reason).toBe('outOfOrder');
  });

  it('refuses a handshake that does not finish in time', () => {
    // A client that keeps the socket alive with pings but never answers the challenge.
    const s = new ServerSession(cfg(), 0, 0);
    s.messages([{ type: 'hello', protocol: 1, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
    for (let t = 1000; t < WIRE_CONSTANTS.handshakeTimeoutMs; t += 1000) {
      s.tick(t, 0);
      s.messages([{ type: 'ping', seq: t }]);
    }
    s.tick(WIRE_CONSTANTS.handshakeTimeoutMs - 1, 0);
    expect(s.phase).toBe('challenged');
    s.tick(WIRE_CONSTANTS.handshakeTimeoutMs, 0);
    expect(s.refusals.map((r) => r.reason)).toEqual(['timeout']);
  });

  it('refuses every Hello in standby; the client tries the next candidate at once, then backs off', () => {
    const s = new ServerSession(cfg({ standby: true }), 0, 0);
    s.messages([{ type: 'hello', protocol: 1, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
    expect(sent(s).some((m) => m.type === 'refused' && m.reason === 'standby')).toBe(true);
    const c = new ClientSession({ build: 'b', defsHash: 'd', cpuScore: null, accountId: 'a', random: () => 0.5 });
    c.tick(0);
    c.connect();
    c.transportOpen();
    const refuse: ServerMessage = { type: 'refused', reason: 'standby', text: 'standby', retryAfterMs: null, queue: null };
    c.messages([refuse]);
    expect(c.nextDeadline()).toBe(0);
    c.drain();
    c.tick(0);
    expect(c.drain().find((a) => a.kind === 'open')).toEqual({ kind: 'open', attempt: 0, nextCandidate: true });
    c.transportOpen();
    c.messages([refuse]);
    expect(c.nextDeadline()).toBe(WIRE_CONSTANTS.reconnectBackoffMs[0]);
  });

  it('drops commands, time requests and subscriptions beyond the rules limits (answering the commands)', () => {
    const s = online();
    const n = rules.limits.commandsPerSecond;
    s.messages(Array.from({ length: n + 3 }, (_, i): ClientMessage => ({ type: 'command', cmdId: i + 1, tick: 10, command: { kind: 'stage' } })));
    const actions = s.drain();
    expect(actions.filter((a) => a.kind === 'forward')).toHaveLength(n);
    expect(s.dropped.commands).toBe(3);
    const t = online();
    t.messages(Array.from({ length: rules.limits.timeMessages + 2 }, (_, i): ClientMessage => ({ type: 'time', cmdId: i + 1, tick: 10, request: { kind: 'hold', on: true } })));
    expect(t.dropped.time).toBe(2);
    t.tick(rules.limits.timeMessageWindow * 1000 + 1, 0);
    t.messages([{ type: 'time', cmdId: 99, tick: 10, request: { kind: 'hold', on: false } }]);
    expect(t.dropped.time).toBe(2);
    const u = online();
    u.messages(Array.from({ length: rules.limits.subscriptionsPerSecond + 4 }, (): ClientMessage => ({ type: 'subscribe', change: { relevantDistance: 1 } })));
    expect(u.dropped.subscriptions).toBe(4);
  });

  it('answers a request sent again (after a resume) once, from memory', () => {
    const s = online();
    s.messages([{ type: 'command', cmdId: 7, tick: 1, command: { kind: 'stage' } }]);
    s.commandResult(7, true, 1, null);
    s.drain();
    s.messages([{ type: 'command', cmdId: 7, tick: 1, command: { kind: 'stage' } }]);
    const again = s.drain();
    expect(again.some((a) => a.kind === 'forward')).toBe(false);
    expect(s.dropped.repeats).toBe(1);
  });

  it('drops inputs beyond the rate and stamps beyond clock(up) + roundTripAllowance, and acknowledges the rest', () => {
    const s = online();
    s.tick(1000, 1000);
    const nowTick = 120;
    const limit = nowTick + rules.time.roundTripAllowance * 120;
    s.messages([{ type: 'input', samples: [sample(1, nowTick + 4), sample(2, limit + 1), sample(3, nowTick + 8)] }]);
    expect(s.inputs.stats.dropped.future).toBe(1);
    s.inputApplied(1, nowTick + 4);
    s.inputApplied(3, nowTick + 9);
    const ack = s.inputs.takeAck(1000)!;
    expect(ack.stamped).toEqual([{ from: 1, to: 1 }]);
    expect(ack.late).toEqual([{ seq: 3, appliedTick: nowTick + 9 }]);
    // Margin: the earliest-arriving input was stamped 4 ticks ahead of the clock: 33.3 ms.
    expect(ack.marginMs).toBe(33.3);
    const r = online();
    r.messages([{ type: 'input', samples: Array.from({ length: rules.limits.inputsPerSecond + 5 }, (_, i) => sample(i + 1, 4)) }]);
    expect(r.inputs.stats.dropped.rate).toBe(5);
  });

  it('declares the socket lost after lossTimeout without a frame, pinging every pingInterval meanwhile', () => {
    const s = online();
    s.tick(rules.disconnect.pingInterval * 1000, 0);
    expect(sent(s).some((m) => m.type === 'ping')).toBe(true);
    s.tick(rules.disconnect.lossTimeout * 1000, 0);
    const a = s.drain();
    expect(a.some((x) => x.kind === 'lost')).toBe(true);
    expect(s.phase).toBe('closed');
  });
});

describe('inputs, backoff', () => {
  it('the input window repeats unacknowledged changes of the last 250 ms and retires what is acknowledged', () => {
    const w = new InputWindow();
    for (let k = 0; k < 20; k++) w.add({ throttle: k, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0 }, 1000 + 4 * k, null);
    const m = w.message()!;
    // 250 ms = 30 ticks before the newest (1076): the samples stamped 1048 .. 1076.
    expect(m.samples.map((s) => s.seq)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    w.acknowledge({ type: 'inputAck', marginMs: null, stamped: [{ from: 1, to: 18 }], late: [{ seq: 19, appliedTick: 1080 }] });
    expect(w.pending.map((s) => s.seq)).toEqual([20]);
    expect(w.lateApplied.get(19)).toBe(1080);
  });

  it('the input buffer keeps inputs with their applied ticks for inputBufferMs', () => {
    const b = new InputBuffer(60);
    b.accept({ type: 'input', samples: [sample(1, 10), sample(2, 14)] }, 0, 0, 1, 1e9);
    b.applied(1, 10);
    b.prune(WIRE_CONSTANTS.inputBufferMs - 1);
    expect(b.retained().map((r) => [r.sample.seq, r.appliedTick])).toEqual([
      [1, 10],
      [2, null],
    ]);
    b.prune(WIRE_CONSTANTS.inputBufferMs + 1);
    expect(b.retained()).toEqual([]);
  });

  it('backs off 0.5, 1, 2, 4, 8 s, then every 15 s, each within the jitter', () => {
    const j = WIRE_CONSTANTS.reconnectJitter;
    const bases = [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
    bases.forEach((base, i) => {
      expect(backoffMs(i, () => 0)).toBe(Math.round(base * (1 - j)));
      expect(backoffMs(i, () => 0.999999)).toBeLessThanOrEqual(Math.round(base * (1 + j)));
    });
  });
});

describe('the downstream budget', () => {
  it('spends 6 kB/s in priority order, drops superseded samples, never drops a reliable record, never starves a large one', () => {
    const b = new DownstreamBudget();
    const rec = (n: number) => new Uint8Array(n);
    let sent = 0;
    const perClass = [0, 0, 0, 0];
    for (let t = 0; t <= 10_000; t += 33) {
      // Own island at 30 Hz (300 B deltas, latest-wins), near tier at 10 Hz, relevant set changes, control.
      b.offer(rec(300), 1, 'islandDelta:1', t);
      if (t % 99 === 0) b.offer(rec(250), 2, 'near', t);
      if (t % 990 === 0) b.offer(rec(900), 3, null, t);
      if (t % 3300 === 0) b.offer(rec(20000), 1, null, t);
      b.offer(rec(8), 0, null, t);
      for (const r of b.take(t)) {
        sent += r.record.length;
      }
    }
    for (let c = 0; c < 4; c++) perClass[c] = b.stats.sentBytes[c as 0 | 1 | 2 | 3];
    // Over 10 s: at most 10 s of budget plus the first burst (and the big records' debt, bounded by one of them).
    expect(sent).toBeLessThanOrEqual(6000 * 10 + 6000 + 20000 + 8 * 304);
    expect(b.stats.superseded[1]).toBeGreaterThan(0);
    // The large reliable records went (not starved) and the relevant set got its share after the island.
    expect(perClass[1]!).toBeGreaterThan(perClass[3]!);
    expect(b.stats.maxReliableWaitMs).toBeLessThan(10_000);
  });
});

describe('the back-pressure sender', () => {
  it('holds frames above the high-water mark, superseding latest-wins records, and keeps reliable ones in order', () => {
    const sch = new ManualScheduler();
    const [a] = createLoopbackPair(sch);
    const s = new Sender(a, { highWaterBytes: 10 });
    s.push({ type: 'ping', seq: 1 });
    s.push({ type: 'durable', tick: 1 });
    s.push({ type: 'durable', tick: 2 });
    expect(s.stats.superseded).toBe(1);
    s.flush();
    expect(a.bufferedAmount).toBeGreaterThan(10);
    s.push({ type: 'durable', tick: 3 });
    s.push({ type: 'pong', seq: 2 });
    s.push({ type: 'durable', tick: 4 });
    expect(s.flush()).toBe(0);
    expect(s.stats.heldBack).toBe(1);
    sch.advanceBy(1);
    expect(s.flush()).toBeGreaterThan(0);
    expect(s.stats.messages).toBe(4);
    expect(s.stats.superseded).toBe(2);
    expect(encodeMessage({ type: 'durable', tick: 4 }).length).toBeGreaterThan(0);
  });
});

describe('time sync and the input margin', () => {
  it('the minimum-round-trip filter keeps the least disturbed sample', () => {
    const mk = (send: number, rtt: number, skew: number) => ({ clientSendMs: send, serverRecvMs: send + rtt / 2 + skew, serverSendMs: send + rtt / 2 + skew + 1, clientRecvMs: send + rtt + 1, upMs: 5000 + send + rtt / 2 + skew + 1 });
    const samples = [mk(0, 180, 1000), mk(100, 40, 1000), mk(200, 400, 1000)];
    expect(rttOf(samples[1]!)).toBe(40);
    expect(offsetOf(samples[1]!)).toBe(1000);
    const e = estimateClock(samples)!;
    expect(e.rttMs).toBe(40);
    expect(e.offsetMs).toBe(1000);
    expect(e.upOffsetMs).toBe(6000);
  });

  it('the lead starts at half the round trip plus the jitter buffer and converges to the target margin, capped by the rules', () => {
    const p = leadParams(rules);
    let lead = initialLead(150, p);
    expect(lead).toBeCloseTo(75 + 66.667, 2);
    // Inputs arrive 120 ms early: the lead shrinks toward the 33 ms target.
    for (let i = 0; i < 40; i++) lead = nextLead(lead, lead - 75 + 53, p);
    expect(lead - 75 + 53).toBeCloseTo(p.targetMarginMs, 0);
    expect(nextLead(240, -500, p)).toBe(p.capMs);
    expect(clockTickAt(live, 1000)).toBe(120);
    expect(clockTickAt({ ...live, untilTick: 100 }, 1000)).toBe(100);
  });
});
