/**
 * Menu stores: the client stores and universe commands a lobby session publishes before and around a flight
 * (ARCHITECTURE 17.1, 23, 25; frontend-ux 11), as a recorded fixture for developing and testing the menu with no
 * network. Nothing online exists yet (universe-directory, netcode-client and server-persistence fill the same
 * stores later); every menu screen reads only `ClientStores` and calls only `UniverseCommands`, so the screens
 * built against this fixture run unchanged against the real session.
 *
 * What it states. The lobby list (one public universe), presence and the feed; the pads of every site of the
 * library with their states (`padLoad`: 'free' all free, 'busy' the first pad of each site taken and freeing in
 * turn, 'full' every pad taken so a spawn queues); the rules document of the library (`rulesId`); the account's
 * ships (`ships`, given by the caller: they name vehicles of the library); the link (`setLink`).
 *
 * The launch queue as the contract has it (session.ts, `LaunchQueueEntry`): with every pad of the class taken a
 * spawn's promise stays pending while `launchQueue` holds the entry, whose place moves up one every
 * `queueStepSeconds` of `advance` and whose estimate is `position x queueStepSeconds`; at place 1 the next
 * step seats it. `cancelSpawn` leaves the queue (the store is null and the spawn resolves refused, the reason
 * saying the player left); a link set to 'takenOver' or to 'offline' (lost past the grace) loses the place (the
 * spawn resolves refused); while 'reconnecting' the store keeps the last entry. `ackDelaySeconds` holds the
 * answer of a spawn that does not queue that long (a slow acknowledgement: the transit's holding drift);
 * `refuseNext` refuses the next spawn with an alternative (the transit re-targets). Deterministic: time moves
 * only through `advance`.
 */
import type { CommandResult } from '../contracts/controls';
import type { DefLibrary, SiteId } from '../contracts/defs';
import { DEFAULT_UNIVERSE_RULES, TICKS_PER_SECOND, type AssemblyView, type CensusEntry, type FeedEvent, type LinkState, type LobbySummary, type PadClass, type PadState, type PresenceSummary, type Prompt, type RosterEntry, type ShipRecord, type UniverseRules } from '../contracts/net';
import type { ClientStores, LaunchQueueEntry, SeatResult, SpawnRequest, Store, UniverseCommands } from '../contracts/session';
import { padOf, padsOf } from '../defs/sites';

class MenuStore<T> implements Store<T> {
  version = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(value: T): void {
    if (value === this.value) return;
    this.value = value;
    this.version++;
    for (const l of [...this.listeners]) l();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export type MenuPadLoad = 'free' | 'busy' | 'full';

export interface MenuStoresOptions {
  /** Rules document of the library the lobby states (default 'default'; the library's document, else the contract's default). */
  rulesId?: string;
  /** Live tick at the start (default 0). */
  liveTick?: number;
  padLoad?: MenuPadLoad;
  /** The account's ships (My Ships). Default none. */
  ships?: ShipRecord[];
  /** Admission state of the lobby (default 'open'); `queued` with a place and an estimate is the admission queue. */
  admission?: { status: LobbySummary['status']; position: number | null; etaSeconds: number | null };
  /** Seconds of `advance` per step of the launch queue (default 30). */
  queueStepSeconds?: number;
  /** Place a queued spawn starts at (default 3). */
  queueStart?: number;
  /** Seconds a spawn that does not queue waits for its answer (default 0: at the next `advance`). */
  ackDelaySeconds?: number;
  /** The link state at the start (default 'online'). */
  link?: LinkState['state'];
}

export interface MenuFixture {
  readonly stores: ClientStores;
  readonly universe: UniverseCommands;
  /** Move the fixture's time on by `seconds` (the queue, the acknowledgement delay, the live tick). */
  advance(seconds: number): void;
  setLink(state: LinkState['state'], reason?: string | null): void;
  setPadLoad(load: MenuPadLoad): void;
  setAdmission(admission: { status: LobbySummary['status']; position: number | null; etaSeconds: number | null }): void;
  /** Refuse the next spawn that is not queued, offering `alternative` (or none). */
  refuseNext(reason: string, alternative: { site: SiteId; pad: string } | null): void;
  /** Seconds the next spawn's answer is held. */
  setAckDelay(seconds: number): void;
  /** The spawn requests received, in order (test hook). */
  readonly requests: readonly SpawnRequest[];
  readonly liveTick: number;
}

const OTHER_ACCOUNT = 'menu-account-other';
const OTHER_CALLSIGN = 'VEGA';

const link = (state: LinkState['state'], reason: string | null, extra: Partial<LinkState> = {}): LinkState => ({
  state,
  rttMs: state === 'online' || state === 'reconnecting' ? 42 : null,
  inputMarginMs: null,
  graceRemaining: null,
  queuePosition: null,
  queueEtaSeconds: null,
  durableTick: null,
  reason,
  ...extra,
});

export function createMenuFixture(defs: DefLibrary, opts: MenuStoresOptions = {}): MenuFixture {
  const rules: UniverseRules = defs.rules?.[opts.rulesId ?? 'default'] ?? DEFAULT_UNIVERSE_RULES;
  const stepSeconds = opts.queueStepSeconds ?? 30;
  let liveTick = opts.liveTick ?? 0;
  let padLoad: MenuPadLoad = opts.padLoad ?? 'free';
  let admission = opts.admission ?? { status: 'open' as const, position: null, etaSeconds: null };
  let ackDelay = opts.ackDelaySeconds ?? 0;
  let refusal: { reason: string; alternative: { site: SiteId; pad: string } | null } | null = null;
  const requests: SpawnRequest[] = [];
  const sites = Object.values(defs.sites).sort((a, b) => a.id.localeCompare(b.id));

  const padStates = (): PadState[] =>
    sites.flatMap((site) =>
      padsOf(site).map((pad, i): PadState => {
        const taken = padLoad === 'full' || (padLoad === 'busy' && i === 0);
        const freeIn = (i + 1) * stepSeconds * 4 * TICKS_PER_SECOND;
        return {
          siteId: site.id,
          padId: pad.id,
          class: pad.class,
          state: taken ? 'occupied' : 'free',
          accountId: taken ? OTHER_ACCOUNT : null,
          callsign: taken ? OTHER_CALLSIGN : null,
          vesselId: taken ? `menu-vessel-${site.id}-${pad.id}` : null,
          freeAtTick: taken ? liveTick + freeIn : null,
          nextLiveTick: padLoad === 'full' ? null : taken ? liveTick + freeIn : liveTick,
          nextCohortTick: padLoad === 'full' ? null : liveTick + Math.round(rules.time.cohortBucket * TICKS_PER_SECOND),
        };
      }),
    );

  const lobby = (): LobbySummary => ({
    id: 'sol-1',
    name: 'Sol · Public universe 1',
    kind: 'public',
    region: 'us-west',
    rttMs: 42,
    online: 1284,
    softCap: 5000,
    flying: 312,
    shipsSaved: 9412,
    stations: 17,
    liveTick,
    rulesId: rules.id,
    rulesVersion: rules.version,
    timeModelSummary: 'Shared clock at 1x; warp by agreement, alone or on a private clock',
    status: admission.status,
    position: admission.position,
    etaSeconds: admission.etaSeconds,
    buildCompatible: admission.status !== 'incompatible',
  });
  const summary = (): PresenceSummary => ({ online: 1284, flying: 312, byBody: Object.fromEntries(Object.keys(defs.bodies).slice(0, 2).map((id, i) => [id, i === 0 ? 288 : 24])), queued: admission.status === 'queued' ? (admission.position ?? 0) : 0 });
  const feed: FeedEvent[] = [
    { id: 'f1', wallMs: 0, tick: 0, kind: 'launch', text: `${OTHER_CALLSIGN} lifted off`, vesselIds: [], callsigns: [OTHER_CALLSIGN], provisional: false },
    { id: 'f2', wallMs: 0, tick: 0, kind: 'orbit', text: 'ORION reached orbit · 412 × 398 km', vesselIds: [], callsigns: ['ORION'], provisional: false },
    { id: 'f3', wallMs: 0, tick: 0, kind: 'docked', text: 'ATLAS-1 and KESTREL docked', vesselIds: [], callsigns: ['ATLAS', 'KESTREL'], provisional: false },
  ];

  const stores: ClientStores & { [K in keyof ClientStores]: MenuStore<ReturnType<ClientStores[K]['get']>> } = {
    census: new MenuStore<ReadonlyMap<string, CensusEntry>>(new Map<string, CensusEntry>()),
    pads: new MenuStore<readonly PadState[]>(padStates()),
    ships: new MenuStore<readonly ShipRecord[]>(opts.ships ?? []),
    assembly: new MenuStore<AssemblyView | null>(null),
    roster: new MenuStore<readonly RosterEntry[]>([]),
    rules: new MenuStore<UniverseRules>(rules),
    presence: new MenuStore<{ lobbies: readonly LobbySummary[]; summary: PresenceSummary }>({ lobbies: [lobby()], summary: summary() }),
    feed: new MenuStore<readonly FeedEvent[]>(feed),
    prompts: new MenuStore<readonly Prompt[]>([]),
    link: new MenuStore<LinkState>(link(opts.link ?? 'online', null)),
    launchQueue: new MenuStore<LaunchQueueEntry | null>(null),
  };

  /** The request that waits for its answer (queued or held by the acknowledgement delay). */
  let waiting: { request: SpawnRequest; resolve: (r: SeatResult) => void; queued: boolean; position: number; clock: number; ackAt: number } | null = null;
  let time = 0;
  let seq = 0;

  const classOfRequest = (request: SpawnRequest): PadClass => padOf(defs.sites[request.site]!, request.pad).class;
  const finish = (result: SeatResult): void => {
    const w = waiting;
    waiting = null;
    stores.launchQueue.set(null);
    w?.resolve(result);
  };
  const seat = (request: SpawnRequest): void => {
    seq++;
    finish({ ok: true, vesselId: `menu-launch-${seq}`, clockId: request.slot.kind === 'clock' ? request.slot.clockId : null });
  };
  const publishQueue = (): void => {
    if (!waiting?.queued) return;
    stores.launchQueue.set({ request: waiting.request, padClass: classOfRequest(waiting.request), position: waiting.position, etaSeconds: waiting.position * stepSeconds - waiting.clock });
  };

  const universe: UniverseCommands = {
    spawn(request) {
      requests.push(request);
      if (waiting) return Promise.resolve({ ok: false, reason: 'A launch request of this session is already waiting.', alternative: null });
      return new Promise<SeatResult>((resolve) => {
        if (refusal) {
          const r = refusal;
          refusal = null;
          resolve({ ok: false, reason: r.reason, alternative: r.alternative ? { site: r.alternative.site, pad: r.alternative.pad, slot: { kind: 'live' } } : null });
          return;
        }
        const queued = padLoad === 'full' && request.slot.kind === 'live';
        waiting = { request, resolve, queued, position: opts.queueStart ?? 3, clock: 0, ackAt: time + ackDelay };
        publishQueue();
      });
    },
    cancelSpawn(): Promise<CommandResult> {
      if (!waiting?.queued) return Promise.resolve({ ok: false, reason: 'No launch request is waiting.' });
      finish({ ok: false, reason: 'You left the launch queue.', alternative: null });
      return Promise.resolve({ ok: true });
    },
    attach: (vesselId) => Promise.resolve({ ok: true, vesselId, clockId: null }),
    detach: () => Promise.resolve({ ok: true }),
    subscribe: () => undefined,
    rename: () => Promise.resolve({ ok: true }),
    abandon: () => Promise.resolve({ ok: true }),
  };

  return {
    stores,
    universe,
    requests,
    get liveTick() {
      return liveTick;
    },
    advance(seconds) {
      time += seconds;
      liveTick += Math.round(seconds * TICKS_PER_SECOND);
      if (!waiting) return;
      const linkState = stores.link.get().state;
      if (linkState === 'reconnecting') return;
      if (waiting.queued) {
        waiting.clock += seconds;
        while (waiting && waiting.clock >= stepSeconds) {
          waiting.clock -= stepSeconds;
          if (waiting.position <= 1) seat(waiting.request);
          else waiting.position -= 1;
        }
        publishQueue();
      } else if (time >= waiting.ackAt) seat(waiting.request);
    },
    setLink(state, reason = null) {
      stores.link.set(link(state, reason, state === 'queued' ? { queuePosition: admission.position, queueEtaSeconds: admission.etaSeconds } : {}));
      if (waiting && (state === 'takenOver' || state === 'offline')) {
        finish({ ok: false, reason: state === 'takenOver' ? 'This flight is now flown from another session.' : 'The connection was lost past the reconnect grace.', alternative: null });
      }
    },
    setPadLoad(load) {
      padLoad = load;
      stores.pads.set(padStates());
    },
    setAdmission(a) {
      admission = a;
      stores.presence.set({ lobbies: [lobby()], summary: summary() });
    },
    refuseNext(reason, alternative) {
      refusal = { reason, alternative };
    },
    setAckDelay(seconds) {
      ackDelay = seconds;
    },
  };
}

/** Ships for My Ships, naming the first vehicle of the library: one in orbit, one landed, one flown elsewhere. */
export function menuShipsFixture(defs: DefLibrary, nowWallMs: number, rules: UniverseRules = defs.rules?.['default'] ?? DEFAULT_UNIVERSE_RULES): ShipRecord[] {
  const vehicleId = Object.keys(defs.vehicles).sort()[0] ?? '';
  const bodies = Object.keys(defs.bodies);
  const home = bodies.includes('earth') ? 'earth' : bodies[0]!;
  const moon = bodies.find((b) => b !== home && defs.bodies[b]!.parent === home) ?? home;
  const day = 86400_000;
  const keep = rules.expiry.craftRetention * 1000;
  const base = { vehicleId, isAssembly: false, members: [], crew: 3, nodesSaved: 0, flownBy: null, headTick: 0, presence: 'solid' as const };
  return [
    { ...base, craftId: 'ship-1', vesselId: 'ship-1', name: 'Meridian 3', situation: 'orbiting', bodyId: home, orbit: { apoapsisAltitude: 412_000, periapsisAltitude: 398_000, inclination: 0.33 }, surface: null, deltaVRemaining: 4210, lastFlownWallMs: nowWallMs - 2 * 3600_000, expiry: { atWallMs: nowWallMs - 2 * 3600_000 + keep, rule: 'craftRetention', reasonText: 'Kept after you last flew it', protectedBy: null }, nodesSaved: 2, sessionState: 'idle' },
    { ...base, craftId: 'ship-2', vesselId: 'ship-2', name: 'Lander A', situation: 'landed', bodyId: moon, orbit: null, surface: { latitude: 0.0118, longitude: 0.4096 }, deltaVRemaining: 1840, lastFlownWallMs: nowWallMs - 13 * day, expiry: { atWallMs: nowWallMs - 13 * day + keep, rule: 'craftRetention', reasonText: 'Kept after you last flew it', protectedBy: null }, sessionState: 'idle' },
    { ...base, craftId: 'ship-3', vesselId: 'ship-3', name: 'Kite 2', situation: 'suborbital', bodyId: home, orbit: { apoapsisAltitude: 160_000, periapsisAltitude: -2_100_000, inclination: 0.2 }, surface: null, deltaVRemaining: 120, lastFlownWallMs: nowWallMs - 60_000, expiry: { atWallMs: null, rule: 'craftRetention', reasonText: 'Kept while it is flown', protectedBy: null }, sessionState: 'flownElsewhere' },
  ];
}
