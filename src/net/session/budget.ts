/**
 * The per-client downstream budget (ARCHITECTURE 13.6, 29.2: a hard 6 kB/s by default, spent in priority
 * order: own island, nearest near-tier vessels, the relevant set; superseded samples are dropped; the
 * complete census never rides the socket).
 *
 * A token bucket refilled at `bytesPerSecond` up to `burstBytes`. Records wait in four classes:
 *   0 control   session, results, events, clocks, handles: always sent (the bucket may go into debt)
 *   1 island    the pilot's own island (enter, operations, keys, deltas, the input acknowledgement)
 *   2 near      the near tier (nearest first: the caller offers them in that order)
 *   3 relevant  the relevant set, worldlines, conjunctions and the view models
 * `take(now)` releases records in class order while tokens last, and stops at the first record that does not
 * fit, so a lower class never spends what a waiting higher class needs. A record larger than the whole burst
 * goes when the bucket is full (and leaves it in debt), so nothing is starved. A record with a supersede key
 * replaces a waiting record of its class with the same key (a dropped superseded sample); records without a
 * key are never dropped and keep their order within their class.
 */
import type { WireMessage } from '@/core/contracts/net';
import { WIRE_CONSTANTS } from '@/core/contracts/net';

export type BudgetClass = 0 | 1 | 2 | 3;

/** The class a server message is sent in. */
export function budgetClassOf(m: WireMessage): BudgetClass {
  switch (m.type) {
    case 'islandEnter':
    case 'islandOp':
    case 'islandKey':
    case 'islandDelta':
    case 'islandSlow':
    case 'inputAck':
    case 'durable':
      return 1;
    case 'near':
    case 'nearOrigin':
      return 2;
    case 'relevantFull':
    case 'relevantDelta':
    case 'worldline':
    case 'conjunctions':
    case 'pads':
    case 'ships':
    case 'assembly':
    case 'roster':
    case 'prompts':
    case 'feed':
    case 'rules':
      return 3;
    default:
      return 0;
  }
}

interface Waiting {
  record: Uint8Array;
  key: string | null;
  since: number;
}

export interface BudgetStats {
  /** Bytes released per class. */
  sentBytes: [number, number, number, number];
  /** Records dropped because a newer one with the same key replaced them, per class. */
  superseded: [number, number, number, number];
  /** Longest time a keyless (reliable) record waited, ms. */
  maxReliableWaitMs: number;
}

export interface BudgetOptions {
  bytesPerSecond?: number;
  /** Bucket size, bytes (default: one second of budget). */
  burstBytes?: number;
}

export class DownstreamBudget {
  readonly bytesPerSecond: number;
  readonly burstBytes: number;
  private tokens: number;
  private last: number | null = null;
  private readonly classes: Waiting[][] = [[], [], [], []];
  readonly stats: BudgetStats = { sentBytes: [0, 0, 0, 0], superseded: [0, 0, 0, 0], maxReliableWaitMs: 0 };

  constructor(opts: BudgetOptions = {}) {
    this.bytesPerSecond = opts.bytesPerSecond ?? WIRE_CONSTANTS.downstreamBytesPerSecond;
    this.burstBytes = opts.burstBytes ?? this.bytesPerSecond;
    this.tokens = this.burstBytes;
  }

  /** Offer a record in a class; `key` non-null makes it supersede a waiting record with that key. */
  offer(record: Uint8Array, cls: BudgetClass, key: string | null, nowMs: number): void {
    const q = this.classes[cls]!;
    if (key !== null) {
      const i = q.findIndex((w) => w.key === key);
      if (i >= 0) {
        q.splice(i, 1);
        this.stats.superseded[cls]++;
      }
    }
    q.push({ record, key, since: nowMs });
  }

  /** Bytes waiting per class. */
  waitingBytes(cls: BudgetClass): number {
    let n = 0;
    for (const w of this.classes[cls]!) n += w.record.length;
    return n;
  }

  get waitingCount(): number {
    return this.classes.reduce((n, q) => n + q.length, 0);
  }

  /** Records to send now, in order (control first), with their supersede keys. */
  take(nowMs: number): { record: Uint8Array; key: string | null }[] {
    if (this.last !== null && nowMs > this.last) this.tokens = Math.min(this.burstBytes, this.tokens + ((nowMs - this.last) * this.bytesPerSecond) / 1000);
    this.last = nowMs;
    const out: { record: Uint8Array; key: string | null }[] = [];
    // Control: always.
    for (const w of this.classes[0]!) this.release(w, 0, nowMs, out);
    this.classes[0]!.length = 0;
    for (let c = 1; c <= 3; c++) {
      const q = this.classes[c]!;
      let n = 0;
      while (n < q.length) {
        const w = q[n]!;
        const size = w.record.length;
        const fits = size <= this.tokens || (size > this.burstBytes && this.tokens >= this.burstBytes);
        if (!fits) break;
        this.release(w, c as BudgetClass, nowMs, out);
        n++;
      }
      q.splice(0, n);
      if (q.length > 0) break;
    }
    return out;
  }

  private release(w: Waiting, cls: BudgetClass, nowMs: number, out: { record: Uint8Array; key: string | null }[]): void {
    this.tokens -= w.record.length;
    this.stats.sentBytes[cls] += w.record.length;
    if (w.key === null) this.stats.maxReliableWaitMs = Math.max(this.stats.maxReliableWaitMs, nowMs - w.since);
    out.push({ record: w.record, key: w.key });
  }
}
