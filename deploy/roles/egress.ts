/**
 * The egress meter (ARCHITECTURE 16.2, 27): bytes sent to the internet, counted in process per route, with a
 * daily budget per route reset at 00:00 UTC, and per-client-address windows. One instance per process,
 * created by the program entry and handed to every role (the static roles here, the server roles of
 * server/ from wave 5), so the budgets of one process are counted in one place.
 *
 * Every number is a setting. The meter answers "may this route still send", records what was sent, and
 * reports a snapshot for /ops and the capacity report. Time is injected (tests move the clock).
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

/** The stage-0 budgets of `shell` (ARCHITECTURE 16.2), each overridable by a variable. */
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
    },
    perAddress: { mirror: { bytes: num('MIRROR_PER_ADDRESS_BYTES', 300e6), windowS: num('MIRROR_PER_ADDRESS_WINDOW_S', 600) } },
  };
}
