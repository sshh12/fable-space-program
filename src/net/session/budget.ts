/**
 * The per-client downstream budget (ARCHITECTURE 13.6, 29.2), with the lead's decisions of 2026-11-16:
 *  (a) `bytesPerSecond` (6 kB/s) is the SUSTAINED average per client, not an instantaneous cap: while records
 *      wait, the bucket refills at `burstBytesPerSecond` (24 kB/s), for at most `burstSeconds` (60 s) in any
 *      `burstWindowSeconds` (600 s) - meant for contact, docking and landing;
 *  (b) the island DELTA RATE adapts per client to what the budget leaves: between `deltaRateTarget` (30 Hz)
 *      and `deltaRateFloor` (10 Hz), from the delta sizes actually produced; deltas in the exact contact form
 *      go at up to 60 Hz while the burst allowance lasts;
 *  (c) list-like view models are latest-wins per type (their supersede keys, messages.ts);
 *  (d) an `islandEnter` is outside the bucket up to `islandEnterFreeBytes` (256 kB); the excess is charged;
 *  (e) class 3 has a guaranteed floor (`relevantFloorShare` of the sustained rate): the near tier and the
 *      relevant set are never starved by the island.
 * Classes: 0 control (session, results, events, clocks, handles), 1 the pilot's island, 2 the near tier, 3 the
 * relevant set and the view models. `take(now)` releases in class order while tokens last; a lower class never
 * spends what a waiting higher class needs, except class 3's floor. Control records go first and may take the
 * bucket into debt down to minus one burst second; beyond that they wait too, and a socket whose waiting bytes
 * pass the rules' `sendQueueBytes` is closed by its driver. A record with a supersede key replaces a waiting
 * record with the same key IN PLACE; a key also removes the waiting records it obsoletes (the deltas against
 * an older key). Records without a key are never dropped and keep their order.
 */
import type { WireMessage } from '@/core/contracts/net';
import { WIRE_LIMIT_DEFAULTS } from '@/core/contracts/net';

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
  /** Bytes charged to the bucket (less than the record for an island enter). */
  cost: number;
  /** Not released before this time (the adaptive delta rate). */
  notBefore: number;
}

export interface BudgetStats {
  /** Bytes released per class. */
  sentBytes: [number, number, number, number];
  /** Records dropped because a newer one with the same key replaced them (or a key obsoleted them), per class. */
  superseded: [number, number, number, number];
  /** Longest time a keyless (reliable) record waited, ms. */
  maxReliableWaitMs: number;
  /** Island deltas released, and the current adaptive delta rate, Hz. */
  deltas: number;
  deltaRateHz: number;
  /** Burst time used, s (all time). */
  burstSeconds: number;
}

export interface BudgetOptions {
  bytesPerSecond?: number;
  burstBytesPerSecond?: number;
  burstSeconds?: number;
  burstWindowSeconds?: number;
  islandEnterFreeBytes?: number;
  relevantFloorShare?: number;
  deltaRateTarget?: number;
  deltaRateFloor?: number;
}

/** What a record is, for the budget's rules. */
export interface OfferInfo {
  /** Waiting records with this key become useless (removed). */
  obsoletes?: string | null;
  islandEnter?: boolean;
  /** An island delta with a vessel in the exact contact form. */
  contact?: boolean;
}

const CONTACT_RATE_HZ = 60;

export class DownstreamBudget {
  readonly bytesPerSecond: number;
  readonly burstBytesPerSecond: number;
  private readonly burstSecondsMax: number;
  private readonly burstWindowMs: number;
  private readonly enterFree: number;
  private readonly floorShare: number;
  private readonly rateTarget: number;
  private readonly rateFloor: number;
  /** One second of the sustained rate: the bucket's size, and the control debt limit. */
  private readonly bucket: number;
  private tokens: number;
  private floorTokens: number;
  private last: number | null = null;
  private readonly classes: Waiting[][] = [[], [], [], []];
  /** Burst intervals [start, end] in the window, ms. */
  private bursts: [number, number][] = [];
  private bursting = false;
  /** Delta sizes seen (moving average) and the release time of the last delta per island. */
  private avgDelta = 0;
  private readonly lastDelta = new Map<string, number>();
  readonly stats: BudgetStats;

  constructor(opts: BudgetOptions = {}) {
    const d = WIRE_LIMIT_DEFAULTS;
    this.bytesPerSecond = opts.bytesPerSecond ?? d.downstreamBytesPerSecond;
    this.burstBytesPerSecond = opts.burstBytesPerSecond ?? d.downstreamBurstBytesPerSecond;
    this.burstSecondsMax = opts.burstSeconds ?? d.downstreamBurstSeconds;
    this.burstWindowMs = (opts.burstWindowSeconds ?? d.downstreamBurstWindow) * 1000;
    this.enterFree = opts.islandEnterFreeBytes ?? d.islandEnterFreeBytes;
    this.floorShare = opts.relevantFloorShare ?? d.relevantFloorShare;
    this.rateTarget = opts.deltaRateTarget ?? d.deltaRateTarget;
    this.rateFloor = opts.deltaRateFloor ?? d.deltaRateFloor;
    this.bucket = this.bytesPerSecond;
    this.tokens = this.bucket;
    this.floorTokens = this.bucket * this.floorShare;
    this.stats = { sentBytes: [0, 0, 0, 0], superseded: [0, 0, 0, 0], maxReliableWaitMs: 0, deltas: 0, deltaRateHz: this.rateTarget, burstSeconds: 0 };
  }

  /** Offer a record in a class; `key` non-null makes it supersede a waiting record with that key, in place. */
  offer(record: Uint8Array, cls: BudgetClass, key: string | null, nowMs: number, info: OfferInfo = {}): void {
    if (info.obsoletes) {
      for (const q of this.classes) {
        for (let i = q.length - 1; i >= 0; i--) {
          if (q[i]!.key === info.obsoletes) {
            q.splice(i, 1);
            this.stats.superseded[cls]++;
          }
        }
      }
    }
    const isDelta = key !== null && key.startsWith('islandDelta:');
    let notBefore = nowMs;
    if (isDelta) {
      this.avgDelta = this.avgDelta === 0 ? record.length : 0.9 * this.avgDelta + 0.1 * record.length;
      const hz = info.contact && this.burstLeft(nowMs) > 0 ? CONTACT_RATE_HZ : this.deltaRate(nowMs);
      notBefore = (this.lastDelta.get(key) ?? -Infinity) + 1000 / hz;
    }
    const w: Waiting = { record, key, since: nowMs, cost: info.islandEnter ? Math.max(0, record.length - this.enterFree) : record.length, notBefore };
    const q = this.classes[cls]!;
    if (key !== null) {
      const i = q.findIndex((x) => x.key === key);
      if (i >= 0) {
        // In place: a newer key or sample takes the older one's turn (never moves behind what followed it).
        w.since = q[i]!.since;
        q[i] = w;
        this.stats.superseded[cls]++;
        return;
      }
    }
    q.push(w);
  }

  /** The adaptive island delta rate now, Hz: what the budget leaves (without class 3's floor), between the floor and the target. */
  deltaRate(nowMs: number): number {
    const rate = this.burstLeft(nowMs) > 0 && this.bursting ? this.burstBytesPerSecond : this.bytesPerSecond;
    const share = rate * (1 - this.floorShare) * 0.8;
    const hz = this.avgDelta > 0 ? share / this.avgDelta : this.rateTarget;
    this.stats.deltaRateHz = Math.max(this.rateFloor, Math.min(this.rateTarget, hz));
    return this.stats.deltaRateHz;
  }

  /** Bytes waiting per class, and in all. */
  waitingBytes(cls?: BudgetClass): number {
    let n = 0;
    for (const [c, q] of this.classes.entries()) if (cls === undefined || c === cls) for (const w of q) n += w.record.length;
    return n;
  }

  get waitingCount(): number {
    return this.classes.reduce((n, q) => n + q.length, 0);
  }

  /** Age of the oldest waiting record, ms (0 when nothing waits). */
  oldestWaitMs(nowMs: number): number {
    let oldest = nowMs;
    for (const q of this.classes) for (const w of q) oldest = Math.min(oldest, w.since);
    return nowMs - oldest;
  }

  /** Burst seconds left in the window. */
  burstLeft(nowMs: number): number {
    const from = nowMs - this.burstWindowMs;
    this.bursts = this.bursts.filter(([, e]) => e > from);
    let used = 0;
    for (const [s, e] of this.bursts) used += (Math.min(e, nowMs) - Math.max(s, from)) / 1000;
    return this.burstSecondsMax - used;
  }

  /** Everything waiting, at once (the socket is about to close: its last words go out). */
  takeAll(): { record: Uint8Array; key: string | null }[] {
    const out: { record: Uint8Array; key: string | null }[] = [];
    for (const q of this.classes) {
      for (const w of q) out.push({ record: w.record, key: w.key });
      q.length = 0;
    }
    return out;
  }

  /** Records to send now, in order (control first), with their supersede keys. */
  take(nowMs: number): { record: Uint8Array; key: string | null }[] {
    if (this.last !== null && nowMs > this.last) {
      const dt = (nowMs - this.last) / 1000;
      // (a) While records of the island or the near tier wait and the allowance lasts, refill at the burst rate.
      const pressed = this.classes[1]!.length + this.classes[2]!.length > 0 && this.tokens < this.bucket;
      const burst = pressed && this.burstLeft(nowMs) > 0;
      if (burst) {
        const lastB = this.bursts[this.bursts.length - 1];
        if (this.bursting && lastB && lastB[1] === this.last) lastB[1] = nowMs;
        else this.bursts.push([this.last, nowMs]);
        this.stats.burstSeconds += dt;
      }
      this.bursting = burst;
      this.tokens = Math.min(this.bucket, this.tokens + dt * (burst ? this.burstBytesPerSecond : this.bytesPerSecond));
      this.floorTokens = Math.min(this.bucket, this.floorTokens + dt * this.bytesPerSecond * this.floorShare);
    }
    this.last = nowMs;
    const out: { record: Uint8Array; key: string | null }[] = [];
    // Control: first, into a debt of at most one second of budget.
    const ctl = this.classes[0]!;
    let n = 0;
    while (n < ctl.length && this.tokens > -this.bucket) this.release(ctl[n++]!, 0, nowMs, out);
    ctl.splice(0, n);
    const fits = (w: Waiting): boolean => w.cost <= this.tokens || (w.cost > this.bucket && this.tokens >= this.bucket);
    // (e) Class 3 goes first while its floor credit covers its head record (the tokens are kept for it until it
    // fits): the floor is a share of the same bucket, never more bytes.
    const q3 = this.classes[3]!;
    while (q3.length > 0) {
      const w = q3[0]!;
      const credit = Math.min(w.cost, this.bucket);
      if (w.notBefore > nowMs || this.floorTokens < credit) break;
      if (!fits(w)) return out;
      this.floorTokens -= credit;
      this.release(w, 3, nowMs, out);
      q3.shift();
    }
    for (let c = 1 as BudgetClass; c <= 3; c = (c + 1) as BudgetClass) {
      const q = this.classes[c]!;
      let i = 0;
      while (i < q.length) {
        const w = q[i]!;
        if (w.notBefore > nowMs) {
          i++;
          continue;
        }
        // A lower class never spends what a waiting higher class needs.
        if (!fits(w)) return out;
        this.release(w, c, nowMs, out);
        q.splice(i, 1);
      }
    }
    return out;
  }

  private release(w: Waiting, cls: BudgetClass, nowMs: number, out: { record: Uint8Array; key: string | null }[]): void {
    this.tokens -= w.cost;
    this.stats.sentBytes[cls] += w.record.length;
    if (w.key === null) this.stats.maxReliableWaitMs = Math.max(this.stats.maxReliableWaitMs, nowMs - w.since);
    if (w.key !== null && w.key.startsWith('islandDelta:')) {
      // The schedule counts from when the delta was due (a release on the next send tick does not stretch the
      // period), unless it went much later than due.
      this.lastDelta.set(w.key, nowMs - w.notBefore < 1000 / this.rateTarget ? w.notBefore : nowMs);
      this.stats.deltas++;
    }
    out.push({ record: w.record, key: w.key });
  }
}
