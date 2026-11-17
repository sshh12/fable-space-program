/**
 * Time synchronisation and the input-margin loop, as pure functions (ARCHITECTURE 13.2, 13.5).
 *
 * Time sync: `timeSync` round trips give samples (client send, server receive, server send, client receive,
 * and the directory up-time at the server's send). The round trip is what the network took
 * ((clientRecv - clientSend) - (serverSend - serverRecv)); the offset of the server's clock is
 * ((serverRecv - clientSend) + (serverSend - clientRecv)) / 2. The MINIMUM-ROUND-TRIP FILTER keeps the
 * sample with the smallest round trip among the recent ones: its offset is the least disturbed by queueing,
 * and is right to within half that round trip.
 *
 * Input margin: the server reports how early the pilot's inputs arrive for their stamped tick. The replica
 * runs ahead of the server's clock by `lead`: half the round trip plus the jitter buffer to start with, then
 * moved so the reported margin approaches its target, never above the cap (the rules' round-trip allowance:
 * the server refuses stamps beyond clock(up) + roundTripAllowance) and never beyond the furthest the replica
 * predicts (`WIRE_CONSTANTS.maxPredictionMs`).
 */
import { CONTROL_TICK_STEPS } from '@/core/contracts/sim';
import { TICKS_PER_SECOND, WIRE_CONSTANTS, type UniverseRules } from '@/core/contracts/net';

export interface SyncSample {
  clientSendMs: number;
  serverRecvMs: number;
  serverSendMs: number;
  clientRecvMs: number;
  /** Directory up-time when the server sent the reply, ms. */
  upMs: number;
}

export const rttOf = (s: SyncSample): number => s.clientRecvMs - s.clientSendMs - (s.serverSendMs - s.serverRecvMs);

/** Server clock minus client clock, ms. */
export const offsetOf = (s: SyncSample): number => (s.serverRecvMs - s.clientSendMs + (s.serverSendMs - s.clientRecvMs)) / 2;

export interface SyncEstimate {
  /** Server wall clock minus client clock, ms. */
  offsetMs: number;
  /** Directory up-time minus client clock, ms. */
  upOffsetMs: number;
  /** Round trip of the sample the estimate comes from, ms (the estimate is good to half of it). */
  rttMs: number;
  /** Samples considered. */
  samples: number;
}

/** The minimum-round-trip filter over `samples` (null when there is none; samples with a negative round trip are discarded). */
export function estimateClock(samples: readonly SyncSample[]): SyncEstimate | null {
  let best: SyncSample | null = null;
  let n = 0;
  for (const s of samples) {
    const r = rttOf(s);
    if (!(r >= 0)) continue;
    n++;
    if (!best || r < rttOf(best)) best = s;
  }
  if (!best) return null;
  const offsetMs = offsetOf(best);
  // Up-time advances with the server's wall clock; at the reply's send it was upMs.
  const upOffsetMs = best.upMs - best.serverSendMs + offsetMs;
  return { offsetMs, upOffsetMs, rttMs: rttOf(best), samples: n };
}

/** Keep the newest `keep` samples (the filter's window). */
export function addSample(samples: readonly SyncSample[], s: SyncSample, keep = 16): SyncSample[] {
  const out = samples.length >= keep ? samples.slice(samples.length - keep + 1) : samples.slice();
  out.push(s);
  return out;
}

// ------------------------------------------------------------------------------------- input margin

export interface LeadParams {
  /** The jitter buffer: two control ticks (ARCHITECTURE 6.2), ms. */
  jitterBufferMs: number;
  /** The margin the loop aims for, ms (one control tick early by default). */
  targetMarginMs: number;
  /** Largest lead, ms: the rules' round-trip allowance. */
  capMs: number;
  /** Furthest the replica predicts ahead of the server's clock, ms. */
  maxPredictionMs: number;
  /** Fraction of the margin error corrected per report (0 < gain <= 1). */
  gain: number;
}

const CONTROL_TICK_MS = (CONTROL_TICK_STEPS * 1000) / TICKS_PER_SECOND;

/** The loop's parameters from the rules in force. */
export function leadParams(rules: Pick<UniverseRules, 'time'>, gain = 0.25): LeadParams {
  return {
    jitterBufferMs: 2 * CONTROL_TICK_MS,
    targetMarginMs: CONTROL_TICK_MS,
    capMs: rules.time.roundTripAllowance * 1000,
    maxPredictionMs: WIRE_CONSTANTS.maxPredictionMs,
    gain,
  };
}

const clampLead = (v: number, p: LeadParams): number => Math.max(0, Math.min(v, p.capMs, p.maxPredictionMs));

/** The lead to start with: half the round trip plus the jitter buffer. */
export function initialLead(rttMs: number, p: LeadParams): number {
  return clampLead(rttMs / 2 + p.jitterBufferMs, p);
}

/** The next lead after the server reported `marginMs` (inputs arriving that early; negative = late). */
export function nextLead(leadMs: number, marginMs: number, p: LeadParams): number {
  return clampLead(leadMs - p.gain * (marginMs - p.targetMarginMs), p);
}

/** The tick a replica running `leadMs` ahead stamps an input with, from the server clock's tick now. */
export function stampTick(serverTickNow: number, leadMs: number, rate = 1): number {
  return serverTickNow + Math.ceil((leadMs * rate * TICKS_PER_SECOND) / 1000);
}

/**
 * The tick of a clock at up-time `upMs` (the closed form of ARCHITECTURE 5.2, as `ClockState` documents it):
 * min(untilTick, tick0 + floor(rate x 120 x (up - anchorUpMs) / 1000)).
 */
export function clockTickAt(clock: { tick0: number; anchorUpMs: number; rate: number; untilTick: number | null }, upMs: number): number {
  const t = clock.tick0 + Math.floor((clock.rate * TICKS_PER_SECOND * (upMs - clock.anchorUpMs)) / 1000);
  return clock.untilTick === null ? t : Math.min(clock.untilTick, t);
}
