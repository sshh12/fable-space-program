/**
 * Time sync and the input-margin loop end to end (review findings 4 and 5): a ClientDriver and a ServerDriver
 * over the injector with ASYMMETRIC delay and jitter, the server's wall clock and up-time on their own
 * offsets, the client stamping inputs at its lead and correcting the lead from the margin reports.
 */
import { describe, expect, it } from 'vitest';
import type { ClockState, ServerMessage } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES } from '@/core/contracts/net';
import { decodeFrame } from '@/net/codec/framing';
import { injectTransport } from '@/net/injector/injected';
import type { InjectorProfile } from '@/net/injector/model';
import { ClientSession } from '@/net/session/client';
import { ClientDriver, ServerDriver } from '@/net/session/driver';
import { clockTickAt, initialLead, leadParams, nextLead, stampTick } from '@/net/time/sync';
import { ManualScheduler } from '@/net/time/scheduler';
import { createLoopbackPair } from '@/net/transport/loopback';

const rules = DEFAULT_UNIVERSE_RULES;
const live: ClockState = { id: 'live', kind: 'live', tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] };
const WALL0 = 1_763_000_000_000;
const UP0 = 3_600_000;
const NEUTRAL = { throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0 } as never;

function run(profile: InjectorProfile, seconds: number) {
  const sch = new ManualScheduler();
  const up = () => UP0 + sch.now();
  let server: ServerDriver | null = null;
  let applied = 0;
  let late = 0;
  let syncProbes = 0;
  const margins: number[] = [];
  const leads: { at: number; lead: number }[] = [];
  const p = leadParams(rules);
  let lead: number | null = null;
  const session = new ClientSession({ build: 'b', defsHash: 'd', cpuScore: null, accountId: 'a', rules, random: () => 0.5 });
  const client = new ClientDriver({
    session,
    scheduler: sch,
    connect: () => {
      const [c, s] = createLoopbackPair(sch);
      server = new ServerDriver({
        transport: s,
        scheduler: sch,
        upMs: up,
        wallMs: () => WALL0 + sch.now(),
        config: { build: 'b', defsHash: 'd', serverId: 'gw', rules, nonce: () => new Uint8Array(8) },
        onFrameIn: (bytes) => {
          const f = decodeFrame(bytes, { source: 'client' });
          if (f.ok) syncProbes += f.messages.filter((m) => m.type === 'timeSync').length;
        },
        host: {
          verifyAuth: (_r, d) => {
            d.authResult({ ok: true, accountId: 'a', callsign: 'A', session: 't', liveClock: live, serverMs: WALL0 + sch.now(), upMs: up() });
            d.enter((x) => x.setClock(live));
          },
          resume: (_r, d) => d.resumeResult({ ok: false, text: 'no' }),
          forward: (m, d) => {
            if (m.type !== 'input') return;
            // The shard applies each input at its stamp, or at the tick it arrived when that is later.
            const now = clockTickAt(live, up());
            for (const smp of m.samples) {
              applied++;
              if (smp.applyTick < now) late++;
              d.enter((x) => x.inputApplied(smp.seq, Math.max(smp.applyTick, now)));
            }
          },
        },
      });
      return injectTransport(c, profile, sch);
    },
    sign: () => new Uint8Array(4),
    onMessage: (m: ServerMessage) => {
      if (m.type === 'inputAck' && m.marginMs !== null && lead !== null) {
        margins.push(m.marginMs);
        lead = nextLead(lead, m.marginMs, p);
        leads.push({ at: sch.now(), lead });
      }
    },
  });
  client.start();
  // The pilot steers at 60 Hz from 2 s on.
  let stampsBack = 0;
  let lastStamp = -Infinity;
  for (let t = 0; t < seconds * 1000; t += 1000 / 60) {
    sch.advanceTo(t);
    if (t < 2000 || !session.clock) continue;
    if (lead === null) lead = initialLead(session.clock.rttMs, p);
    const serverUpNow = sch.now() + session.clock.upOffsetMs;
    const stamp = stampTick(clockTickAt(live, serverUpNow), lead);
    if (stamp < lastStamp) stampsBack++;
    lastStamp = stamp;
    client.enter((s) => s.input(NEUTRAL, stamp));
  }
  return { session, server: server as ServerDriver | null, applied, late, margins, leads, stampsBack, syncProbes };
}

const asym = (upMs: number, downMs: number, jitterMs: number): InjectorProfile => ({
  up: { delayMs: upMs, jitterMs, stallChance: 0, stallMs: 0, bytesPerSecond: null },
  down: { delayMs: downMs, jitterMs, stallChance: 0, stallMs: 0, bytesPerSecond: null },
  seed: 11,
});

describe('time sync over the injector with asymmetric delay', () => {
  it('estimates the server clocks to within half the asymmetry, from probes on their own timer (the welcome is no sample)', () => {
    const r = run(asym(150, 30, 4), 60);
    const c = r.session.clock!;
    // The NTP-style estimate is biased by half the asymmetry: (150 - 30) / 2 = 60 ms ahead (an offset that large is the bound of any two-way sync).
    const wallErr = c.offsetMs - WALL0;
    const upErr = c.upOffsetMs - UP0;
    console.log(`sync: rtt ${c.rttMs.toFixed(1)} ms, wall error ${wallErr.toFixed(1)} ms, up error ${upErr.toFixed(1)} ms, ${c.samples} samples, ${r.syncProbes} probes`);
    expect(c.rttMs).toBeGreaterThanOrEqual(180 - 8);
    expect(c.rttMs).toBeLessThanOrEqual(180 + 16);
    expect(Math.abs(wallErr - 60)).toBeLessThanOrEqual(12);
    expect(Math.abs(upErr - 60)).toBeLessThanOrEqual(12);
    // Probes kept going while the pilot sent inputs at 60 Hz: the burst, then one every 10 ping intervals.
    expect(r.syncProbes).toBeGreaterThanOrEqual(4 + Math.floor(55 / (10 * rules.disconnect.pingInterval)));
  });
});

describe('the input-margin loop closed over the injector', () => {
  it('with delay and jitter: one report per second, the lead settles, inputs are on time, stamps never go back', () => {
    const r = run(asym(80, 40, 15), 120);
    const settled = r.leads.filter((l) => l.at > 40_000).map((l) => l.lead);
    const spread = Math.max(...settled) - Math.min(...settled);
    const lateShare = r.late / r.applied;
    console.log(`margin loop: ${r.margins.length} reports in 118 s, settled lead ${Math.min(...settled).toFixed(1)}-${Math.max(...settled).toFixed(1)} ms, ${(100 * lateShare).toFixed(2)} % late of ${r.applied}`);
    // At most one report per second.
    expect(r.margins.length).toBeLessThanOrEqual(119);
    expect(r.margins.length).toBeGreaterThan(90);
    expect(spread).toBeLessThan(25);
    expect(lateShare).toBeLessThan(0.01);
    expect(r.stampsBack).toBe(0);
    expect(r.server!.session.inputs.stats.dropped.future).toBe(0);
  });
});
