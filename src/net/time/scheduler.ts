/**
 * Time for the wire layer, injected: every part of src/net that waits (the loopback's delivery, the injector,
 * the session drivers' timers) takes a `Scheduler`, so the same code runs on real time in a browser, a bot or
 * a gateway and on virtual time in the tests, where a transcript replays deterministically and in
 * milliseconds.
 */

export interface TimerHandle {
  readonly id: number;
}

export interface Scheduler {
  /** Current time, ms (any epoch; differences only). */
  now(): number;
  /** Run `fn` after `delayMs` (0 = as soon as possible, never synchronously). */
  setTimer(delayMs: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle | null): void;
}

interface Pending {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/**
 * Virtual time: timers run in time order (ties in order of creation) when the test advances the clock. Time
 * jumps from timer to timer; nothing runs on its own.
 */
export class ManualScheduler implements Scheduler {
  private t: number;
  private seq = 0;
  private nextId = 1;
  private readonly queue: Pending[] = [];

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const p: Pending = { id: this.nextId++, at: this.t + Math.max(0, delayMs), seq: this.seq++, fn };
    // Insert keeping (at, seq) order.
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1]!.at > p.at || (this.queue[i - 1]!.at === p.at && this.queue[i - 1]!.seq > p.seq))) i--;
    this.queue.splice(i, 0, p);
    return { id: p.id };
  }

  clearTimer(handle: TimerHandle | null): void {
    if (!handle) return;
    const i = this.queue.findIndex((p) => p.id === handle.id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Number of timers waiting. */
  get pending(): number {
    return this.queue.length;
  }

  /** Time of the next timer, or null. */
  nextAt(): number | null {
    return this.queue.length ? this.queue[0]!.at : null;
  }

  /**
   * Run every timer due at or before `t` (including timers they create inside the window), then set the clock
   * to `t`. A livelock (more than `maxSameInstant` timers at one instant, each scheduling the next) throws
   * instead of hanging the test.
   */
  advanceTo(t: number, maxSameInstant = 100_000): void {
    let instant = -Infinity;
    let runs = 0;
    for (;;) {
      const p = this.queue[0];
      if (!p || p.at > t) break;
      this.queue.shift();
      this.t = Math.max(this.t, p.at);
      if (this.t === instant) {
        if (++runs > maxSameInstant) throw new Error(`ManualScheduler: more than ${maxSameInstant} timers at t = ${this.t} ms (a livelock)`);
      } else {
        instant = this.t;
        runs = 0;
      }
      p.fn();
    }
    this.t = Math.max(this.t, t);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.t + ms);
  }

  /** Run timers until none is left or `limitMs` of virtual time has passed; returns false on the limit. */
  runUntilIdle(limitMs = 3_600_000): boolean {
    const end = this.t + limitMs;
    while (this.queue.length) {
      const at = this.queue[0]!.at;
      if (at > end) return false;
      this.advanceTo(at);
    }
    return true;
  }
}

/** Real time: `performance.now()` and `setTimeout`. */
export class RealScheduler implements Scheduler {
  private nextId = 1;
  private readonly live = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return performance.now();
  }

  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const id = this.nextId++;
    const h = setTimeout(() => {
      this.live.delete(id);
      fn();
    }, Math.max(0, delayMs));
    this.live.set(id, h);
    return { id };
  }

  clearTimer(handle: TimerHandle | null): void {
    if (!handle) return;
    const h = this.live.get(handle.id);
    if (h !== undefined) {
      clearTimeout(h);
      this.live.delete(handle.id);
    }
  }

  /** Cancel every timer (closing a test or a process). */
  clearAll(): void {
    for (const h of this.live.values()) clearTimeout(h);
    this.live.clear();
  }
}
