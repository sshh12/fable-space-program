/**
 * The delay model of the latency injector (ARCHITECTURE 28.4, 28.7): per direction a fixed one-way delay,
 * uniform jitter, TCP-style stalls (nothing lost, everything late: a stall holds every byte sent during it
 * until it ends, then they arrive in order), a bandwidth cap, and nothing ever reordered. Seeded, so a
 * profile run twice gives the same arrival times.
 *
 * `DelayLine.schedule(bytes, sendMs)` returns the arrival time of one unit (a frame, or a chunk of a byte
 * stream) and remembers what it needs for the next: the end of the current stall, the end of the previous
 * transmission and the previous arrival.
 */
import { Prng } from '@/core/math/hash';

export interface DirectionProfile {
  /** Fixed one-way delay, ms. */
  delayMs: number;
  /** Jitter: uniform in [-jitterMs, +jitterMs] added to the delay of each unit, ms. */
  jitterMs: number;
  /** Chance per unit sent that a stall starts with it, 0..1, and the stall's length, ms. */
  stallChance: number;
  stallMs: number;
  /** Bandwidth cap, bytes per second; null = none. */
  bytesPerSecond: number | null;
}

/** A profile for both directions: `up` client to server, `down` server to client. */
export interface InjectorProfile {
  up: DirectionProfile;
  down: DirectionProfile;
  seed: number;
}

export const NO_DELAY: DirectionProfile = { delayMs: 0, jitterMs: 0, stallChance: 0, stallMs: 0, bytesPerSecond: null };

/** A symmetric profile from a round trip: half of it each way, the same jitter and stalls both ways. */
export function roundTripProfile(rttMs: number, opts: { jitterMs?: number; stallChance?: number; stallMs?: number; bytesPerSecond?: number | null; seed?: number } = {}): InjectorProfile {
  const d: DirectionProfile = {
    delayMs: rttMs / 2,
    jitterMs: opts.jitterMs ?? 0,
    stallChance: opts.stallChance ?? 0,
    stallMs: opts.stallMs ?? 0,
    bytesPerSecond: opts.bytesPerSecond ?? null,
  };
  return { up: { ...d }, down: { ...d }, seed: opts.seed ?? 1 };
}

export interface ScheduledUnit {
  /** When it was sent and when it arrives, ms. */
  sendMs: number;
  arriveMs: number;
  /** Delay before stalls, bandwidth and ordering: the fixed delay plus this unit's jitter, ms. */
  baseDelayMs: number;
  /** True when a stall started with this unit or held it. */
  stalled: boolean;
}

export class DelayLine {
  private stallEnd = -Infinity;
  private txEnd = -Infinity;
  private lastArrive = -Infinity;
  private readonly prng: Prng;

  constructor(
    public profile: DirectionProfile,
    seed: number,
  ) {
    this.prng = new Prng(seed);
  }

  /** Start a stall now (scripted), on top of any running one. */
  stall(nowMs: number, ms: number): void {
    this.stallEnd = Math.max(this.stallEnd, nowMs + ms);
  }

  schedule(bytes: number, sendMs: number): ScheduledUnit {
    const p = this.profile;
    const jitter = p.jitterMs > 0 ? (this.prng.next() * 2 - 1) * p.jitterMs : 0;
    const baseDelayMs = p.delayMs + jitter;
    let arrive = sendMs + baseDelayMs;
    let stalled = false;
    if (p.stallChance > 0 && this.prng.next() < p.stallChance) {
      this.stallEnd = Math.max(this.stallEnd, sendMs + p.stallMs);
      stalled = true;
    }
    if (sendMs < this.stallEnd) {
      // Held by the stall: released when it ends, then delayed like everything else.
      arrive = Math.max(arrive, this.stallEnd + p.delayMs);
      stalled = true;
    }
    if (p.bytesPerSecond !== null && p.bytesPerSecond > 0) {
      const start = Math.max(sendMs, this.txEnd);
      this.txEnd = start + (bytes * 1000) / p.bytesPerSecond;
      arrive = Math.max(arrive, this.txEnd + p.delayMs);
    }
    // TCP: nothing overtakes.
    arrive = Math.max(arrive, this.lastArrive);
    this.lastArrive = arrive;
    return { sendMs, arriveMs: arrive, baseDelayMs, stalled };
  }
}
