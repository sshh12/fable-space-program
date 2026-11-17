/**
 * Small pure pieces of the session layer: the gateway's rate limits (ARCHITECTURE 26; every bound a
 * `UniverseRules.limits` field) and the client's reconnect backoff (13.6).
 */
import { WIRE_CONSTANTS } from '@/core/contracts/net';

/** Admits at most `max` events in any window of `windowMs` (a sliding window over event times). */
export class RateWindow {
  private times: number[] = [];

  constructor(
    public max: number,
    public windowMs: number,
  ) {}

  /** Admit an event at `nowMs` (true) or refuse it (false, nothing recorded). */
  admit(nowMs: number): boolean {
    const from = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop]! <= from) drop++;
    if (drop) this.times.splice(0, drop);
    if (this.times.length >= this.max) return false;
    this.times.push(nowMs);
    return true;
  }

  /** When the next event would be admitted (now when there is room). */
  nextFreeAt(nowMs: number): number {
    const from = nowMs - this.windowMs;
    const live = this.times.filter((t) => t > from);
    if (live.length < this.max) return nowMs;
    return live[live.length - this.max]! + this.windowMs;
  }
}

/**
 * The wait before reconnect attempt `attempt` (0 = the first retry): 0.5, 1, 2, 4, 8 s, then every 15 s,
 * each spread by +/- `reconnectJitter` with `random()` in [0, 1) so a restart does not bring every client
 * back in the same millisecond.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const list = WIRE_CONSTANTS.reconnectBackoffMs;
  const base = attempt < list.length ? list[attempt]! : WIRE_CONSTANTS.reconnectSteadyMs;
  const j = WIRE_CONSTANTS.reconnectJitter;
  return Math.round(base * (1 - j + 2 * j * random()));
}
