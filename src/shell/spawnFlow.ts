/**
 * The spawn request of the deploy flow and the VISIBLE LAUNCH QUEUE (user decision of 2026-11-13; ARCHITECTURE
 * 5.9, 23; session.ts `LaunchQueueEntry`).
 *
 * `UniverseCommands.spawn` is one promise that resolves once. While the request waits for a pad of its class,
 * the promise is pending and `ClientStores.launchQueue` holds the entry: the player's place (1 = next) and an
 * estimate of the wait that can grow as well as shrink. The flow shows that inside the spawn flow (pad screen,
 * briefing), never as a blocking page, with the way out (`cancelSpawn`, after which the waiting spawn resolves
 * refused with a reason that says the player left) and the other offers beside it: choosing one is leaving the
 * queue and spawning again (`choose`).
 *
 * The link decides how much the entry is worth: while it is 'reconnecting' the store keeps the last entry and
 * the flow marks it STALE (the place may have moved); a resumed session keeps its place. A session lost past the
 * grace, or taken over by another tab ('takenOver'), has lost it: the spawn resolves refused, and the flow says
 * why and goes back to the selection. A LocalSession (Practice) never queues: its store stays null.
 */
import type { LinkState } from '@/core/contracts/net';
import type { ClientStores, LaunchQueueEntry, SeatResult, SpawnRequest, UniverseCommands } from '@/core/contracts/session';

export type SpawnPhase =
  | { kind: 'idle' }
  /** The request is out and no answer or queue entry has come back yet. */
  | { kind: 'requesting'; request: SpawnRequest }
  /** The request waits in the launch queue of its class. `stale` while the link is reconnecting. */
  | { kind: 'queued'; request: SpawnRequest; entry: LaunchQueueEntry; stale: boolean }
  /** Seated: the transit begins. */
  | { kind: 'seated'; request: SpawnRequest; vesselId: string; clockId: string | null }
  /**
   * Refused, left or lost. `cause`: 'left' (the player left the queue), 'lost' (the session lost its place:
   * taken over by another tab or lost past the reconnect grace), 'refused' (the directory refused the request).
   */
  | { kind: 'refused'; request: SpawnRequest; reason: string; cause: 'left' | 'lost' | 'refused'; alternative: Extract<SeatResult, { ok: false }>['alternative'] };

export interface SpawnFlow {
  phase(): SpawnPhase;
  /** Ask for a launch. Ignored (returns the current phase's promise) while a request is out: a session has at most one spawn in flight. */
  spawn(request: SpawnRequest): Promise<SeatResult>;
  /** Leave the launch queue. Resolves with the command's result; the waiting spawn resolves refused (left). */
  leaveQueue(): Promise<void>;
  /** Take another offer while waiting: leave the queue, then spawn the new request. */
  choose(request: SpawnRequest): Promise<SeatResult>;
  /** Back to idle after a refusal has been read (the selection is shown again). */
  acknowledge(): void;
  subscribe(listener: (phase: SpawnPhase) => void): () => void;
  dispose(): void;
}

export function createSpawnFlow(universe: UniverseCommands, stores: Pick<ClientStores, 'launchQueue' | 'link'>): SpawnFlow {
  let phase: SpawnPhase = { kind: 'idle' };
  let pending: Promise<SeatResult> | null = null;
  let leaving = false;
  /** The link states seen while the request was out: what explains a refusal that the player did not ask for. */
  let lostBy: LinkState['state'] | null = null;
  const listeners = new Set<(p: SpawnPhase) => void>();
  const set = (p: SpawnPhase): void => {
    phase = p;
    for (const l of [...listeners]) l(p);
  };

  const fromStores = (): void => {
    if (phase.kind !== 'requesting' && phase.kind !== 'queued') return;
    const entry = stores.launchQueue.get();
    const link = stores.link.get();
    if (link.state === 'takenOver') lostBy = 'takenOver';
    const stale = link.state === 'reconnecting';
    if (entry) set({ kind: 'queued', request: phase.request, entry, stale });
    else if (phase.kind === 'queued' && !stale) set({ kind: 'requesting', request: phase.request });
    else if (phase.kind === 'queued' && stale) set({ ...phase, stale });
  };
  const offQueue = stores.launchQueue.subscribe(fromStores);
  const offLink = stores.link.subscribe(fromStores);

  const spawn = (request: SpawnRequest): Promise<SeatResult> => {
    if (pending) return pending;
    leaving = false;
    lostBy = null;
    set({ kind: 'requesting', request });
    fromStores();
    const p = universe.spawn(request).then((result) => {
      pending = null;
      if (result.ok) set({ kind: 'seated', request, vesselId: result.vesselId, clockId: result.clockId });
      else {
        const cause = leaving ? 'left' : lostBy === 'takenOver' || stores.link.get().state === 'takenOver' ? 'lost' : 'refused';
        const reason = cause === 'lost' ? `${result.reason} This tab no longer holds the session, so its place in the launch queue is gone.` : result.reason;
        set({ kind: 'refused', request, reason, cause, alternative: result.alternative });
      }
      return result;
    });
    pending = p;
    return p;
  };

  return {
    phase: () => phase,
    spawn,
    async leaveQueue() {
      if (!pending) return;
      leaving = true;
      const result = await universe.cancelSpawn();
      if (!result.ok) leaving = false;
    },
    async choose(request) {
      if (pending) {
        leaving = true;
        await universe.cancelSpawn();
        await pending;
      }
      return spawn(request);
    },
    acknowledge() {
      if (phase.kind === 'refused' || phase.kind === 'seated') set({ kind: 'idle' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      offQueue();
      offLink();
      listeners.clear();
    },
  };
}

/**
 * The wait as an estimate in words (it can grow as well as shrink: never a countdown that promises):
 * "under a minute", "about 4 min", "about 1 h 20 min".
 */
export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

/** "1st", "2nd", "3rd", "214th": the player's place. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
