/**
 * Unit tests of the session layer's parts: the gateway's rate limits and stamp bound (ARCHITECTURE 26), the
 * handshake timeout, standby, refusals of messages out of order, the input buffer's acknowledgements, the
 * backoff, the downstream budget, the back-pressure sender, time sync and the input-margin loop.
 */
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ClockState, ServerMessage } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, WIRE_CONSTANTS, WIRE_PROTOCOL_VERSION } from '@/core/contracts/net';
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
  s.messages([{ type: 'hello', protocol: WIRE_PROTOCOL_VERSION, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
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
    s.messages([{ type: 'hello', protocol: WIRE_PROTOCOL_VERSION, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
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
    s.messages([{ type: 'hello', protocol: WIRE_PROTOCOL_VERSION, build: 'b', defsHash: 'd', cpuScore: null, resume: null }]);
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
    expect(s.dropped.command).toBe(3);
    const t = online();
    t.messages(Array.from({ length: rules.limits.timeMessages + 2 }, (_, i): ClientMessage => ({ type: 'time', cmdId: i + 1, tick: 10, request: { kind: 'hold', on: true } })));
    expect(t.dropped.time).toBe(2);
    t.tick(rules.limits.timeMessageWindow * 1000 + 1, 0);
    t.messages([{ type: 'time', cmdId: 99, tick: 10, request: { kind: 'hold', on: false } }]);
    expect(t.dropped.time).toBe(2);
    const u = online();
    u.messages(Array.from({ length: rules.limits.subscriptionsPerSecond + 4 }, (): ClientMessage => ({ type: 'subscribe', change: { relevantDistance: 1 } })));
    expect(u.dropped.subscribe).toBe(4);
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
    b.accept({ type: 'input', samples: [sample(1, 10), sample(2, 14)] }, 0, 0, 1, 1e9, -1e9);
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
  const rec = (n: number) => new Uint8Array(n);

  it('(a) 6 kB/s sustained; 24 kB/s while the island waits, for at most 60 s in any 600 s', () => {
    const b = new DownstreamBudget();
    // A near tier that wants 24 kB/s for 20 minutes (400 B at 60 Hz, latest-wins).
    const perSecond: number[] = [];
    for (let t = 0; t <= 1_200_000; t += 1000 / 60) {
      b.offer(rec(400), 2, 'near:near', t);
      const s = Math.floor(t / 1000);
      for (const r of b.take(t)) perSecond[s] = (perSecond[s] ?? 0) + r.record.length;
    }
    const sum = (from: number, to: number) => perSecond.slice(from, to).reduce((a, x) => a + (x ?? 0), 0);
    // The first minute bursts, the next nine do not, the eleventh bursts again.
    expect(sum(1, 59) / 58).toBeGreaterThan(20_000);
    expect(sum(61, 600) / 539).toBeLessThan(6100);
    expect(sum(601, 659) / 58).toBeGreaterThan(20_000);
    // Every 600-s window: at most 540 s at 6 kB/s, 60 s at 24 kB/s and one bucket.
    for (let s = 0; s + 600 <= perSecond.length; s += 30) expect(sum(s, s + 600)).toBeLessThanOrEqual(540 * 6000 + 60 * 24_000 + 6000 + 400);
    expect(b.stats.burstSeconds).toBeLessThanOrEqual(120.1);
  });

  it('(b) island deltas adapt between the floor and the target to the sizes produced; contact deltas go at 60 Hz from the burst', () => {
    const b = new DownstreamBudget({ burstSeconds: 0 });
    let deltas = 0;
    for (let t = 0; t < 20_000; t += 1000 / 60) {
      b.offer(rec(300), 1, 'islandDelta:1', t);
      for (const r of b.take(t)) if (r.key === 'islandDelta:1' && t >= 10_000) deltas++;
    }
    // 6000 x 0.9 x 0.8 / 300 = 14.4 Hz.
    expect(b.stats.deltaRateHz).toBeCloseTo(14.4, 1);
    expect(deltas / 10).toBeGreaterThan(13);
    expect(deltas / 10).toBeLessThan(15.5);
    // Small deltas: the target, never more.
    const small = new DownstreamBudget({ burstSeconds: 0 });
    let n = 0;
    for (let t = 0; t < 10_000; t += 1000 / 60) {
      small.offer(rec(60), 1, 'islandDelta:1', t);
      for (const r of small.take(t)) if (r.key === 'islandDelta:1' && t >= 5000) n++;
    }
    expect(n / 5).toBeLessThanOrEqual(30.5);
    expect(n / 5).toBeGreaterThan(28);
    // Huge deltas: the floor, never less.
    const big = new DownstreamBudget({ burstSeconds: 0 });
    n = 0;
    for (let t = 0; t < 20_000; t += 1000 / 60) {
      big.offer(rec(500), 1, 'islandDelta:1', t);
      for (const r of big.take(t)) if (r.key === 'islandDelta:1' && t >= 10_000) n++;
    }
    expect(big.stats.deltaRateHz).toBe(10);
    // Contact: 60 Hz while the burst allowance lasts.
    const contact = new DownstreamBudget();
    n = 0;
    for (let t = 0; t < 10_000; t += 1000 / 60) {
      contact.offer(rec(160), 1, 'islandDelta:1', t, { contact: true });
      for (const r of contact.take(t)) if (r.key === 'islandDelta:1' && t >= 5000) n++;
    }
    expect(n / 5).toBeGreaterThan(55);
  });

  it('(c) a record with a key replaces the waiting one IN PLACE; a key removes the deltas it obsoletes; reliable records keep their order', () => {
    const b = new DownstreamBudget();
    b.take(0);
    // Drain the bucket so everything waits.
    b.offer(rec(6000), 1, null, 0);
    expect(b.take(0)).toHaveLength(1);
    const a1 = rec(10).fill(1);
    const a2 = rec(10).fill(2);
    b.offer(a1, 3, 'pads', 0);
    b.offer(rec(10).fill(9), 3, null, 0);
    b.offer(a2, 3, 'pads', 0);
    b.offer(rec(50), 1, 'islandDelta:4', 0);
    b.offer(rec(80), 1, 'islandKey:4', 0, { obsoletes: 'islandDelta:4' });
    const out = b.take(2000);
    // Class 3 goes first here from its floor credit, in its own order: the newer pads in the older one's place.
    expect(out.map((r) => r.key)).toEqual(['pads', null, 'islandKey:4']);
    expect(out[0]!.record[0]).toBe(2);
    expect(b.stats.superseded[3]).toBe(1);
    expect(b.stats.superseded[1]).toBe(1);
  });

  it('(d) an island enter is free up to 256 kB and charged beyond; (e) class 3 keeps its floor under a saturated island', () => {
    const b = new DownstreamBudget({ burstSeconds: 0 });
    b.take(0);
    b.offer(rec(200 * 1024), 1, null, 0, { islandEnter: true });
    b.offer(rec(500), 3, null, 0);
    expect(b.take(0).map((r) => r.record.length)).toEqual([500, 200 * 1024]);
    b.offer(rec(300 * 1024), 1, null, 0, { islandEnter: true });
    // 44 kB charged: it waits for a full bucket, then takes the bucket into its debt.
    expect(b.take(1)).toHaveLength(0);
    expect(b.take(1000)).toHaveLength(1);
    // A saturated island (30 kB/s of reliable records) and a relevant set that wants 9 kB/s.
    const s = new DownstreamBudget({ burstSeconds: 0 });
    for (let t = 0; t <= 100_000; t += 100) {
      s.offer(rec(3000), 1, null, t);
      s.offer(rec(900), 3, null, t);
      s.take(t);
    }
    const share = s.stats.sentBytes[3] / (s.stats.sentBytes[1] + s.stats.sentBytes[3]);
    expect(share).toBeGreaterThan(0.09);
    expect(s.stats.sentBytes[1] + s.stats.sentBytes[3]).toBeLessThanOrEqual(6000 * 100 + 6000 + 3000);
  });

  it('control records go first but into a bounded debt', () => {
    const b = new DownstreamBudget({ burstSeconds: 0 });
    for (let i = 0; i < 1000; i++) b.offer(rec(100), 0, null, 0);
    // One bucket plus one second of debt: 120 records of 100 B, then they wait.
    expect(b.take(0).length).toBe(120);
    expect(b.waitingCount).toBe(880);
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
