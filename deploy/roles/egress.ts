/**
 * The egress meter (ARCHITECTURE 16.2, 27): bytes sent to the internet, counted in process per route, with a
 * daily budget per route reset at 00:00 UTC, and per-client-address windows. One instance per process,
 * created by the program entry and handed to every role (the static roles here, the server roles of
 * server/ from wave 5), so the budgets of one process are counted in one place.
 *
 * Every number is a setting. The meter admits a response before its first byte (`admit`: its length is
 * reserved against the route's daily budget and the address's window, and a stream slot is taken), so the
 * budgets are a hard stop however many responses run at once; `settle` gives back what an aborted response did
 * not send. It reports a snapshot for /ops and the capacity report. Time is injected (tests move the clock).
 * Counted: body bytes. Not counted: response headers (a few hundred bytes a response).
 */

export interface AddressLimit {
  bytes: number;
  windowS: number;
}

export interface EgressOptions {
  /** Route -> daily byte budget. A route without one is metered but never refused. */
  budgets: Record<string, number>;
  /** Route -> per-address limit (origin bytes per client address in a sliding window). */
  perAddress?: Record<string, AddressLimit>;
  now?: () => number;
  /** Most addresses tracked per route (the oldest are dropped first). */
  maxAddresses?: number;
  /** Route -> concurrent responses allowed in the process and per client address. */
  streams?: Record<string, { total: number; perAddress: number }>;
}

export type AdmissionRefusal = 'budget' | 'address' | 'streams';

/** An admitted response: its bytes are counted already; `settle` gives back the unsent part and the slot. */
export interface Admission {
  bytes: number;
  settle(sent: number): void;
}

export interface RouteSnapshot {
  used: number;
  budget: number | null;
  refused: number;
  requests: number;
}

export interface EgressSnapshot {
  day: string;
  routes: Record<string, RouteSnapshot>;
  /** Seconds until the counters reset. */
  resetInS: number;
}

const MINUTE = 60_000;

export class EgressMeter {
  private day = '';
  private readonly used = new Map<string, number>();
  private readonly refused = new Map<string, number>();
  private readonly requests = new Map<string, number>();
  /** route -> address -> per-minute buckets (minute index -> bytes). */
  private readonly addresses = new Map<string, Map<string, Map<number, number>>>();
  private readonly now: () => number;

  constructor(private readonly o: EgressOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  private roll(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used.clear();
      this.refused.clear();
      this.requests.clear();
    }
  }

  /** Seconds until the next 00:00 UTC (the Retry-After of a spent budget). */
  secondsToReset(): number {
    const t = this.now();
    const next = Math.floor(t / 86_400_000) * 86_400_000 + 86_400_000;
    return Math.max(1, Math.ceil((next - t) / 1000));
  }

  /** Is the route's daily budget still open? (Bytes already sent today below the budget.) */
  open(route: string): boolean {
    this.roll();
    const b = this.o.budgets[route];
    return b === undefined || (this.used.get(route) ?? 0) < b;
  }

  /** Bytes the address has drawn on the route inside its window. */
  addressUse(route: string, address: string): number {
    const lim = this.o.perAddress?.[route];
    const m = this.addresses.get(route)?.get(address);
    if (!lim || !m) return 0;
    const nowMin = Math.floor(this.now() / MINUTE);
    const first = nowMin - Math.ceil(lim.windowS / 60) + 1;
    let n = 0;
    for (const [minute, bytes] of m) {
      if (minute >= first) n += bytes;
      else m.delete(minute);
    }
    return n;
  }

  /** Is the address still under its limit on this route? */
  addressOpen(route: string, address: string): boolean {
    const lim = this.o.perAddress?.[route];
    return !lim || this.addressUse(route, address) < lim.bytes;
  }

  /** A request was refused (budget or address limit). */
  refuse(route: string): void {
    this.roll();
    this.refused.set(route, (this.refused.get(route) ?? 0) + 1);
    this.requests.set(route, (this.requests.get(route) ?? 0) + 1);
  }

  /** Bytes were sent on the route (to `address`, when known). */
  record(route: string, bytes: number, address?: string): void {
    this.roll();
    this.used.set(route, (this.used.get(route) ?? 0) + bytes);
    if (address !== undefined && this.o.perAddress?.[route]) {
      let byAddr = this.addresses.get(route);
      if (!byAddr) this.addresses.set(route, (byAddr = new Map()));
      let m = byAddr.get(address);
      if (!m) {
        if (byAddr.size >= (this.o.maxAddresses ?? 10_000)) byAddr.delete(byAddr.keys().next().value!);
        byAddr.set(address, (m = new Map()));
      }
      const minute = Math.floor(this.now() / MINUTE);
      m.set(minute, (m.get(minute) ?? 0) + bytes);
    }
  }

  /**
   * Admission with a hard stop: the response's length is reserved against the route's daily budget, the
   * address's window and the concurrent-stream caps BEFORE a byte is sent, so concurrent admissions can never
   * pass the budget (bytes reserved count as used). Returns null and counts a refusal when it does not fit,
   * with the reason. `settle(sent)` gives back what was not sent (an aborted stream) and frees the stream slot;
   * it must be called exactly once.
   */
  admit(route: string, bytes: number, address?: string): Admission | null {
    this.roll();
    const b = this.o.budgets[route];
    const lim = this.o.perAddress?.[route];
    const caps = this.o.streams?.[route];
    let reason: AdmissionRefusal | null = null;
    if (b !== undefined && (this.used.get(route) ?? 0) + bytes > b) reason = 'budget';
    else if (lim && address !== undefined && this.addressUse(route, address) + bytes > lim.bytes) reason = 'address';
    else if (caps && (this.streams.get(route) ?? 0) >= caps.total) reason = 'streams';
    else if (caps && address !== undefined && (this.addressStreams.get(`${route}\n${address}`) ?? 0) >= caps.perAddress) reason = 'streams';
    if (reason) {
      this.refuse(route);
      this.lastRefusal = reason;
      return null;
    }
    this.request(route);
    this.record(route, bytes, address);
    const key = `${route}\n${address ?? ''}`;
    this.streams.set(route, (this.streams.get(route) ?? 0) + 1);
    if (address !== undefined) this.addressStreams.set(key, (this.addressStreams.get(key) ?? 0) + 1);
    const day = this.day;
    const minute = Math.floor(this.now() / MINUTE);
    let settled = false;
    return {
      bytes,
      settle: (sent: number) => {
        if (settled) return;
        settled = true;
        this.streams.set(route, Math.max(0, (this.streams.get(route) ?? 1) - 1));
        if (address !== undefined) {
          const n = (this.addressStreams.get(key) ?? 1) - 1;
          if (n > 0) this.addressStreams.set(key, n);
          else this.addressStreams.delete(key);
        }
        if (sent > bytes) {
          // More than reserved (a document larger than its estimate): charged now, to today's counters.
          this.record(route, sent - bytes, address);
          return;
        }
        const unsent = bytes - sent;
        if (unsent === 0) return;
        this.roll();
        // Give back what was not sent, on the same day and in the same minute bucket it was reserved in.
        if (this.day === day) this.used.set(route, Math.max(0, (this.used.get(route) ?? 0) - unsent));
        const m = address !== undefined ? this.addresses.get(route)?.get(address) : undefined;
        if (m && m.has(minute)) m.set(minute, Math.max(0, m.get(minute)! - unsent));
      },
    };
  }

  /** Why the last `admit` refused. */
  lastRefusal: AdmissionRefusal | null = null;
  private readonly streams = new Map<string, number>();
  private readonly addressStreams = new Map<string, number>();

  /** Streams in flight on a route (for tests and /ops). */
  inFlight(route: string): number {
    return this.streams.get(route) ?? 0;
  }

  /** Count a request (the bytes come with `record`). */
  request(route: string): void {
    this.roll();
    this.requests.set(route, (this.requests.get(route) ?? 0) + 1);
  }

  snapshot(): EgressSnapshot {
    this.roll();
    const routes: Record<string, RouteSnapshot> = {};
    const names = new Set([...Object.keys(this.o.budgets), ...this.used.keys(), ...this.requests.keys()]);
    for (const r of [...names].sort()) {
      routes[r] = { used: this.used.get(r) ?? 0, budget: this.o.budgets[r] ?? null, refused: this.refused.get(r) ?? 0, requests: this.requests.get(r) ?? 0 };
    }
    return { day: this.day, routes, resetInS: this.secondsToReset() };
  }
}

/**
 * The stage-0 budgets of the static roles and of the stand-in server roles (ARCHITECTURE 16.2), each a
 * variable: shell's client build 3 GB, boot pack 1 GB, mirror 8 GB a day (300 MB per address in 10 minutes);
 * `public`, every other public response of any role (the pack list, /hello, /healthz, the endpoint document:
 * metered by the program entry), 2 GB a day; and the concurrent responses of the mirror and the boot pack, per
 * process and per address.
 */
export function shellBudgetsFromEnv(env: Record<string, string | undefined>): EgressOptions {
  const num = (name: string, def: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of bytes, not ${v}`);
    return n;
  };
  return {
    budgets: {
      client: num('EGRESS_CLIENT_BYTES_PER_DAY', 3e9),
      boot: num('EGRESS_BOOT_BYTES_PER_DAY', 1e9),
      mirror: num('EGRESS_MIRROR_BYTES_PER_DAY', 8e9),
      public: num('EGRESS_PUBLIC_BYTES_PER_DAY', 2e9),
    },
    perAddress: { mirror: { bytes: num('MIRROR_PER_ADDRESS_BYTES', 300e6), windowS: num('MIRROR_PER_ADDRESS_WINDOW_S', 600) } },
    // A client keeps at most 24 requests in flight (src/terrain/packSource.ts), so 32 per address never
    // refuses one well-behaved client; the boot pack is fetched once per start.
    streams: {
      mirror: { total: num('MIRROR_MAX_STREAMS', 128), perAddress: num('MIRROR_MAX_STREAMS_PER_ADDRESS', 32) },
      boot: { total: num('BOOT_MAX_STREAMS', 16), perAddress: num('BOOT_MAX_STREAMS_PER_ADDRESS', 2) },
    },
  };
}
