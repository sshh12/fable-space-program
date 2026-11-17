/**
 * The server half of the session layer: what the gateway runs per socket (ARCHITECTURE 13.2, 13.6, 16.1,
 * 26, U16). A pure state machine with no I/O, like the client half: the driver feeds it decoded client
 * messages, transport events, the time and the host's answers (the account and resume checks, seat results,
 * the shard's input applications, everything to send downstream), and carries out what it asks (send encoded
 * records, close, verify a signature or a resume, forward a client message to the universe, declare the
 * socket lost).
 *
 * What it does:
 *  - the handshake: version, build and definition hash checked (`refused` 'protocol' / 'build' /
 *    'defsHash'), a nonce, the device key's signature checked by the host, the welcome. A RESUME is challenged
 *    like a new session: the host gets the session token AND the signature over the fresh nonce, so a token
 *    alone takes no flight. The host is given the client's own build (the one it signed) and its cpuScore.
 *    A role in standby refuses at once; a handshake not done in `handshakeTimeoutMs` is refused ('timeout');
 *    at most `handshakeMessages` messages are accepted before the welcome;
 *  - malformed frames and messages out of order are refused with a typed reason, and the socket is closed;
 *  - a limit for every kind of client message (`wireLimits(rules)`): inputs, commands, time messages,
 *    subscriptions, plans, quick-comms, targets, seat requests, pings, time-sync probes, input samples per
 *    frame. The windows can be the ACCOUNT's (`AccountLimits`, given by the host with the auth or resume
 *    answer), so a reconnect does not reset them. What a limit drops is answered by ONE `rateLimited` message
 *    per kind per window; the rate is checked before a repeated request is answered from memory;
 *  - stamps: an input, a command or a time request stamped outside [clock(up) - inputBufferMs,
 *    clock(up) + roundTripAllowance] is dropped (inputs) or refused (requests); without a pilot clock every
 *    stamped message is refused (fail closed);
 *  - the gateway's input buffer with acknowledged ticks and the `inputAck` sent with keys and deltas (the
 *    margin reported at most once per second);
 *  - the per-client downstream budget (DownstreamBudget) with session-local handles;
 *  - declared loss: a ping every `disconnect.pingInterval` when idle, the socket lost after
 *    `disconnect.lossTimeout` without a frame.
 */
import type { ClientMessage, ClockState, RateLimitedMessage, ResumedSeat, ServerMessage, SessionRefusal, SpawnQueuedMessage, UniverseRules, WireLimits } from '@/core/contracts/net';
import { TICKS_PER_SECOND, WIRE_CONSTANTS, WIRE_PROTOCOL_VERSION, wireLimits } from '@/core/contracts/net';
import { CONTROL_TICK_STEPS } from '@/core/contracts/sim';
import type { SeatResult, Subscriptions } from '@/core/contracts/session';
import type { DecodeError } from '../codec/bytes';
import { encodeMessage } from '../codec/framing';
import { HandleTableOut } from '../codec/handles';
import { obsoletedKeys, specOf, supersedeKey } from '../codec/messages';
import { clockTickAt } from '../time/sync';
import type { CloseInfo } from '../transport/types';
import { CLOSE } from '../transport/types';
import { budgetClassOf, DownstreamBudget, type BudgetOptions } from './budget';
import { InputBuffer } from './inputs';
import { RateWindow } from './limits';

export type ServerPhase = 'awaitHello' | 'challenged' | 'verifying' | 'resuming' | 'online' | 'closed';

/** Longest an input acknowledgement waits for a key or a delta to ride with: one control tick, ms. */
const ACK_MAX_DELAY_MS = (CONTROL_TICK_STEPS * 1000) / TICKS_PER_SECOND;

type LimitedKind = RateLimitedMessage['what'] | 'ping' | 'timeSync';

/**
 * The rate windows of one account (ARCHITECTURE 26: limits are per account). The host keeps one per account
 * and hands it to each new session of it with the auth or resume answer, so a reconnect does not reset them.
 */
export class AccountLimits {
  readonly windows: Record<LimitedKind, RateWindow>;
  /** Up-time (ms) of the last resume catch-up granted beyond the input rate (one per input-buffer span). */
  lastCatchUpMs = -Infinity;

  constructor(rules: Pick<UniverseRules, 'limits'>) {
    const l = wireLimits(rules);
    this.windows = {
      input: new RateWindow(l.inputsPerSecond, 1000),
      command: new RateWindow(l.commandsPerSecond, 1000),
      time: new RateWindow(l.timeMessages, l.timeMessageWindow * 1000),
      seat: new RateWindow(l.seatRequestsPerSecond, 1000),
      names: new RateWindow(l.nameRequestsPerSecond, 1000),
      subscribe: new RateWindow(l.subscriptionsPerSecond, 1000),
      plan: new RateWindow(l.plansPerSecond, 1000),
      quick: new RateWindow(l.quicksPerSecond, 1000),
      target: new RateWindow(l.targetsPerSecond, 1000),
      ping: new RateWindow(l.pingsPerSecond, 1000),
      timeSync: new RateWindow(l.timeSyncsPerSecond, 1000),
    };
  }
}

export interface ServerConfig {
  protocol?: number;
  /** The build this gateway serves, and older builds still accepted while they drain. */
  build: string;
  acceptBuilds?: readonly string[];
  defsHash: string;
  serverId: string;
  rules: UniverseRules;
  /** Random bytes for a nonce (the host's secure random source). */
  nonce: () => Uint8Array;
  budget?: BudgetOptions;
  /** True while the role is in standby (a stage move): every Hello is refused with 'standby'. */
  standby?: boolean;
}

/** The host's answer to `verifyAuth`. `limits`: the account's rate windows (else the session keeps its own). */
export type AuthResult =
  | { ok: true; accountId: string; callsign: string; session: string; liveClock: ClockState; serverMs: number; upMs: number; limits?: AccountLimits }
  | { ok: false; reason: SessionRefusal; text: string; retryAfterMs?: number | null; queue?: { position: number; etaSeconds: number } | null };

/** The host's answer to `resume` (which carries the signature as well as the token). */
export type ResumeResult =
  | { ok: true; accountId: string; callsign: string; session: string; liveClock: ClockState; serverMs: number; upMs: number; seat: ResumedSeat; limits?: AccountLimits }
  | { ok: false; reason?: 'resume' | 'auth'; text: string };

/** What the host must check before it answers: the signature of nonce || serverId || build by the account's device key. */
export interface IdentityProof {
  accountId: string;
  signature: Uint8Array;
  nonce: Uint8Array;
  serverId: string;
  /** The CLIENT's build (from its Hello: the one it signed). */
  build: string;
  cpuScore: number | null;
}

export type ServerAction =
  /** Encoded message records to send, in order, with their supersede keys (the driver frames them). */
  | { kind: 'send'; records: Uint8Array[]; keys: (string | null)[] }
  | { kind: 'close'; code: number; reason: string }
  | ({ kind: 'verifyAuth' } & IdentityProof)
  | ({ kind: 'resume'; session: string; relevantSeq: number | null } & IdentityProof)
  /** A client message for the universe (inputs: the accepted samples only). */
  | { kind: 'forward'; message: ClientMessage }
  /** The pilot lost the socket (U16): declared loss, a close, a refusal, an abort. */
  | { kind: 'lost'; info: CloseInfo }
  | { kind: 'phase'; phase: ServerPhase };

/** Why the server refused a client's message (kept for tests and logs). */
export interface ServerRefusalRecord {
  reason: SessionRefusal;
  detail: string;
}

export class ServerSession {
  phase: ServerPhase = 'awaitHello';
  private readonly cfg: ServerConfig;
  private readonly limits: WireLimits;
  private now = 0;
  private up = 0;
  private readonly actions: ServerAction[] = [];
  readonly handles = new HandleTableOut();
  readonly budget: DownstreamBudget;
  readonly inputs: InputBuffer;
  private account: AccountLimits;
  private nonce: Uint8Array | null = null;
  private hello: Extract<ClientMessage, { type: 'hello' }> | null = null;
  private handshakeCount = 0;
  /** Inputs up to this seq were applied by the session this one resumes (the host says so). */
  private resumeAfterSeq = 0;
  private openedAt = 0;
  private lastAckAt = 0;
  private lastFrameAt = 0;
  private lastSentAt = 0;
  private pingSeq = 0;
  /** Drops per kind waiting for their one `rateLimited` answer, and when the window ends. */
  private readonly drops = new Map<RateLimitedMessage['what'], { count: number; ids: number[]; until: number }>();

  accountId: string | null = null;
  callsign: string | null = null;
  session: string | null = null;
  /** The pilot's clock (for the stamp windows and the margin), set by the host. */
  clock: ClockState | null = null;
  subscriptions: Subscriptions = {};
  /** Refusals this side made, newest last. */
  readonly refusals: ServerRefusalRecord[] = [];
  /** Requests handled, by id (bounded: the last `requestMemory`), with their answer once known. */
  private readonly seen = new Map<number, ServerMessage | null>();
  readonly dropped: Record<LimitedKind | 'repeats' | 'stamp', number> = { input: 0, command: 0, time: 0, seat: 0, subscribe: 0, plan: 0, quick: 0, target: 0, names: 0, ping: 0, timeSync: 0, repeats: 0, stamp: 0 };

  constructor(cfg: ServerConfig, nowMs: number, upMs: number) {
    this.cfg = cfg;
    this.limits = wireLimits(cfg.rules);
    this.now = nowMs;
    this.up = upMs;
    this.openedAt = nowMs;
    this.lastFrameAt = nowMs;
    this.lastSentAt = nowMs;
    this.budget = new DownstreamBudget({ ...budgetOptionsOf(this.limits), ...cfg.budget });
    this.inputs = new InputBuffer(this.limits.inputsPerSecond);
    this.account = new AccountLimits(cfg.rules);
  }

  drain(): ServerAction[] {
    return this.actions.splice(0, this.actions.length);
  }

  nextDeadline(): number | null {
    if (this.phase === 'closed') return null;
    const d = [this.lastFrameAt + this.cfg.rules.disconnect.lossTimeout * 1000, this.lastSentAt + this.cfg.rules.disconnect.pingInterval * 1000];
    if (this.phase !== 'online') d.push(this.openedAt + WIRE_CONSTANTS.handshakeTimeoutMs);
    if (this.budget.waitingCount > 0) d.push(this.now + ACK_MAX_DELAY_MS);
    if (this.phase === 'online' && this.inputs.hasAck(this.now)) d.push(Math.max(this.now, this.lastAckAt + ACK_MAX_DELAY_MS));
    for (const v of this.drops.values()) d.push(v.until);
    return Math.min(...d);
  }

  /** Time passes: `nowMs` the gateway's wall clock, `upMs` the directory up-time. */
  tick(nowMs: number, upMs: number): void {
    this.now = nowMs;
    this.up = upMs;
    if (this.phase === 'closed') return;
    // Deadlines are compared as `now >= base + interval`, exactly as nextDeadline() computes them.
    if (this.phase !== 'online' && nowMs >= this.openedAt + WIRE_CONSTANTS.handshakeTimeoutMs) {
      this.refuse('timeout', 'the handshake did not finish in time');
      return;
    }
    if (nowMs >= this.lastFrameAt + this.cfg.rules.disconnect.lossTimeout * 1000) {
      this.close(CLOSE.lost, 'declared loss: no frame for the loss timeout');
      return;
    }
    if (nowMs >= this.lastSentAt + this.cfg.rules.disconnect.pingInterval * 1000) this.queue({ type: 'ping', seq: ++this.pingSeq });
    // Acknowledgements ride with the next key or delta; with none within a control tick they go alone.
    if (this.phase === 'online' && this.inputs.hasAck(nowMs) && nowMs >= this.lastAckAt + ACK_MAX_DELAY_MS) this.queueAck();
    this.reportDrops(false);
    this.inputs.prune(nowMs);
    this.flush();
  }

  // ------------------------------------------------------------------------------------- client side

  messages(list: readonly ClientMessage[]): void {
    if (this.phase === 'closed') return;
    this.lastFrameAt = this.now;
    let samples = 0;
    for (const m of list) if (m.type === 'input') samples += m.samples.length;
    if (samples > this.limits.inputSamplesPerFrame) {
      this.refuse('rateLimited', `${samples} input samples in one frame`);
      return;
    }
    for (const m of list) {
      if ((this.phase as ServerPhase) === 'closed') return;
      this.onMessage(m);
    }
    this.flush();
  }

  malformed(error: DecodeError): void {
    this.refuse('malformed', `${error.code} at ${error.offset} in ${error.where}`);
  }

  transportClosed(info: CloseInfo): void {
    if (this.phase === 'closed') return;
    const wasOnline = this.phase === 'online';
    this.setPhase('closed');
    if (wasOnline) this.out({ kind: 'lost', info });
  }

  /** Close the socket at once, for a reason of the server's own (the driver after an internal error, a slow consumer). */
  abort(code: number, reason: string): void {
    this.close(code, reason);
  }

  // ------------------------------------------------------------------------------------- host side

  authResult(r: AuthResult): void {
    if (this.phase !== 'verifying') return;
    if (!r.ok) {
      this.refuse(r.reason, r.text, r.retryAfterMs ?? null, r.queue ?? null);
      return;
    }
    if (r.limits) this.account = r.limits;
    this.welcome(r.accountId, r.callsign, r.session, r.liveClock, r.serverMs, r.upMs, null);
  }

  resumeResult(r: ResumeResult): void {
    if (this.phase !== 'resuming') return;
    if (!r.ok) {
      this.refuse(r.reason ?? 'resume', r.text);
      return;
    }
    if (r.limits) this.account = r.limits;
    this.resumeAfterSeq = r.seat.lastInputSeq;
    // The resumed client sends the inputs the outage swallowed once: admitted beyond the input rate, once per
    // input-buffer span per account (a reconnect loop gets no second catch-up).
    if (this.up - this.account.lastCatchUpMs >= WIRE_CONSTANTS.inputBufferMs) {
      this.account.lastCatchUpMs = this.up;
      this.inputs.grantBurst(Math.ceil((this.limits.inputsPerSecond * WIRE_CONSTANTS.inputBufferMs) / 1000));
    }
    this.welcome(r.accountId, r.callsign, r.session, r.liveClock, r.serverMs, r.upMs, r.seat);
  }

  /** The answer to a spawn or an attach. */
  seatResult(reqId: number, result: SeatResult): void {
    this.answer(reqId, { type: 'seatResult', reqId, result });
  }

  /** A spawn request waits in the launch queue (user decision of 2026-11-13). */
  spawnQueued(m: Omit<SpawnQueuedMessage, 'type'>): void {
    this.push({ type: 'spawnQueued', ...m });
  }

  /** The answer to a command, a time request or a detach. */
  commandResult(cmdId: number, ok: boolean, appliedTick: number | null, reason: string | null, alternative: Extract<ServerMessage, { type: 'commandResult' }>['alternative'] = null): void {
    this.answer(cmdId, { type: 'commandResult', cmdId, ok, appliedTick, reason, alternative });
  }

  /** The pilot's clock changed (the stamp windows and the margin are measured on it). */
  setClock(clock: ClockState): void {
    this.clock = clock;
  }

  /** The shard applied input `seq` at `tick`. */
  inputApplied(seq: number, tick: number): void {
    this.inputs.applied(seq, tick);
  }

  /** Send a message downstream (through the budget; keys and deltas take the input acknowledgement first). */
  push(m: ServerMessage): void {
    if (this.phase !== 'online') return;
    if (m.type === 'islandKey' || m.type === 'islandDelta') this.queueAck();
    this.queue(m);
    this.flush();
  }

  /** Another session of the account attached: this one is told and closed. */
  takeOver(text = 'This account is flying in another session.'): void {
    if (this.phase === 'closed') return;
    this.queue({ type: 'takenOver', text });
    this.flush(true);
    this.close(CLOSE.takenOver, 'taken over');
  }

  /** End the session in order (a drain, maintenance). */
  end(reason: 'drain' | 'maintenance', text: string): void {
    if (this.phase === 'closed') return;
    this.queue({ type: 'bye', reason, text });
    this.flush(true);
    this.close(CLOSE.goingAway, reason);
  }

  /** The inputs of the last `inputBufferMs` with their applied ticks (for a recovering shard). */
  retainedInputs() {
    return this.inputs.retained();
  }

  /** The tick of the pilot's clock now (0 without a clock). */
  clockTick(): number {
    return this.clock ? clockTickAt(this.clock, this.up) : 0;
  }

  // ------------------------------------------------------------------------------------- internals

  private onMessage(m: ClientMessage): void {
    // Before the welcome a ping only proves the socket alive (it costs no answer: the server's own idle pings
    // keep the client's side alive); after it, pings are answered at the rules' rate.
    if (m.type === 'ping') {
      if (this.phase !== 'online') return;
      if (this.account.windows.ping.admit(this.now)) this.queue({ type: 'pong', seq: m.seq });
      else this.dropped.ping++;
      return;
    }
    if (m.type === 'pong') return;
    if (this.phase !== 'online' && ++this.handshakeCount > this.limits.handshakeMessages) {
      this.refuse('rateLimited', 'too many messages before the welcome');
      return;
    }
    if (m.type === 'timeSync') {
      if (this.phase !== 'online') return this.refuse('outOfOrder', 'timeSync before the welcome');
      if (this.account.windows.timeSync.admit(this.now)) this.queue({ type: 'timeSyncReply', seq: m.seq, clientMs: m.clientMs, serverRecvMs: this.now, serverSendMs: this.now, upMs: this.up });
      else this.dropped.timeSync++;
      return;
    }
    if (m.type === 'bye') {
      this.out({ kind: 'forward', message: m });
      this.close(CLOSE.normal, 'client left');
      return;
    }
    switch (this.phase) {
      case 'awaitHello':
        if (m.type !== 'hello') return this.refuse('outOfOrder', `${m.type} before hello`);
        return this.onHello(m);
      case 'challenged': {
        if (m.type !== 'auth') return this.refuse('outOfOrder', `${m.type} during the handshake`);
        const hello = this.hello!;
        const proof: IdentityProof = { accountId: m.accountId, signature: m.signature, nonce: this.nonce!, serverId: this.cfg.serverId, build: hello.build, cpuScore: hello.cpuScore };
        if (hello.resume) {
          this.setPhase('resuming');
          this.out({ kind: 'resume', session: hello.resume.session, relevantSeq: hello.resume.relevantSeq, ...proof });
        } else {
          this.setPhase('verifying');
          this.out({ kind: 'verifyAuth', ...proof });
        }
        return;
      }
      case 'verifying':
      case 'resuming':
        return this.refuse('outOfOrder', `${m.type} while the handshake is checked`);
      case 'online':
        return this.onSessionMessage(m);
      default:
        return;
    }
  }

  private onHello(m: Extract<ClientMessage, { type: 'hello' }>): void {
    if (this.cfg.standby) return this.refuse('standby', 'This server is in standby; try the next.');
    if (m.protocol !== (this.cfg.protocol ?? WIRE_PROTOCOL_VERSION)) return this.refuse('protocol', 'A new version is ready.');
    if (m.build !== this.cfg.build && !(this.cfg.acceptBuilds ?? []).includes(m.build)) return this.refuse('build', 'A new version is ready.');
    if (m.defsHash !== this.cfg.defsHash) return this.refuse('defsHash', 'A new version is ready.');
    // A new session and a resume alike prove the device key over a fresh nonce.
    this.hello = m;
    this.nonce = this.cfg.nonce();
    this.setPhase('challenged');
    this.queue({ type: 'challenge', nonce: this.nonce, serverId: this.cfg.serverId });
  }

  private welcome(accountId: string, callsign: string, session: string, liveClock: ClockState, serverMs: number, upMs: number, seat: ResumedSeat | null): void {
    this.accountId = accountId;
    this.callsign = callsign;
    this.session = session;
    this.setPhase('online');
    this.queue({ type: 'welcome', session, accountId, callsign, rulesId: this.cfg.rules.id, rulesVersion: this.cfg.rules.version, liveClock, serverMs, upMs, resumed: seat });
    this.flush();
  }

  /** The stamp window of ARCHITECTURE 26 on the pilot's clock: [clock(up) - inputBufferMs, clock(up) + roundTripAllowance]; null without a clock. */
  private stampWindow(): { min: number; max: number; tick: number; rate: number } | null {
    const c = this.clock;
    if (!c) return null;
    const tick = clockTickAt(c, this.up);
    const max = clockTickAt({ ...c, untilTick: null }, this.up + this.cfg.rules.time.roundTripAllowance * 1000);
    const min = tick - Math.ceil((Math.max(c.rate, 0) * TICKS_PER_SECOND * WIRE_CONSTANTS.inputBufferMs) / 1000);
    return { min, max, tick, rate: c.rate };
  }

  private onSessionMessage(m: ClientMessage): void {
    switch (m.type) {
      case 'hello':
      case 'auth':
        return this.refuse('outOfOrder', `${m.type} after the welcome`);
      case 'input': {
        const win = this.stampWindow();
        if (!win) {
          this.inputs.stats.dropped.noClock += m.samples.length;
          return;
        }
        const fresh = m.samples.filter((s) => s.seq > this.resumeAfterSeq);
        if (fresh.length !== m.samples.length) this.dropped.repeats += m.samples.length - fresh.length;
        this.inputs.useWindow(this.account.windows.input);
        const before = this.inputs.stats.dropped.rate;
        const accepted = this.inputs.accept({ type: 'input', samples: fresh }, this.now, win.tick, win.rate, win.max, win.min);
        const rated = this.inputs.stats.dropped.rate - before;
        if (rated > 0) this.noteDrop('input', rated, []);
        if (accepted.length) this.out({ kind: 'forward', message: { type: 'input', samples: accepted } });
        return;
      }
      case 'command':
      case 'time': {
        // The rate first: a request repeated past the limit is not answered from memory either.
        if (!this.account.windows[m.type].admit(this.now)) return this.noteDrop(m.type, 1, [m.cmdId]);
        if (this.repeat(m.cmdId)) return;
        // ARCHITECTURE 26: a stamp beyond clock(up) + roundTripAllowance is refused. A late request is re-timed
        // by the universe, never refused for being late (6.2), so there is no lower bound here.
        const win = this.stampWindow();
        if (!win || m.tick > win.max) {
          this.dropped.stamp++;
          this.commandResult(m.cmdId, false, null, win ? 'The request is stamped outside the time window.' : 'No clock: the request cannot be applied.');
          return;
        }
        this.out({ kind: 'forward', message: m });
        return;
      }
      case 'spawn':
      case 'attach':
      case 'detach':
        if (!this.account.windows.seat.admit(this.now)) return this.noteDrop('seat', 1, [m.reqId]);
        if (this.repeat(m.reqId)) return;
        this.out({ kind: 'forward', message: m });
        return;
      case 'spawnCancel':
        if (!this.account.windows.seat.admit(this.now)) return this.noteDrop('seat', 1, [m.reqId]);
        this.out({ kind: 'forward', message: m });
        return;
      case 'subscribe':
        if (!this.account.windows.subscribe.admit(this.now)) return this.noteDrop('subscribe', 1, []);
        this.subscriptions = { ...this.subscriptions, ...m.change };
        this.out({ kind: 'forward', message: m });
        return;
      case 'names':
        if (!this.account.windows.names.admit(this.now) || m.vessels.length + m.accounts.length > this.limits.namesPerRequest) return this.noteDrop('names', 1, []);
        this.out({ kind: 'forward', message: m });
        return;
      case 'plan':
      case 'quick':
      case 'target':
        if (!this.account.windows[m.type].admit(this.now)) return this.noteDrop(m.type, 1, []);
        this.out({ kind: 'forward', message: m });
        return;
      default:
        return;
    }
  }

  /** Count a drop; its one `rateLimited` answer goes when the window that caused it ends. */
  private noteDrop(what: RateLimitedMessage['what'], n: number, ids: number[]): void {
    this.dropped[what] += n;
    let d = this.drops.get(what);
    if (!d) {
      const w = what === 'seat' ? this.account.windows.seat : what === 'input' ? this.account.windows.input : this.account.windows[what];
      d = { count: 0, ids: [], until: w.nextFreeAt(this.now) };
      this.drops.set(what, d);
    }
    d.count += n;
    for (const id of ids) if (d.ids.length < 64) d.ids.push(id);
  }

  /** Send the `rateLimited` answers of the windows that ended (all of them when `all`). */
  private reportDrops(all: boolean): void {
    for (const [what, d] of this.drops) {
      if (!all && this.now < d.until) continue;
      this.drops.delete(what);
      this.queue({ type: 'rateLimited', what, dropped: d.count, ids: d.ids, retryAfterMs: Math.max(0, d.until - this.now) });
    }
  }

  /** True (and the cached answer re-sent, if any) when request `id` was seen before. */
  private repeat(id: number): boolean {
    if (!this.seen.has(id)) {
      this.seen.set(id, null);
      if (this.seen.size > WIRE_CONSTANTS.requestMemory) this.seen.delete(this.seen.keys().next().value!);
      return false;
    }
    this.dropped.repeats++;
    const answer = this.seen.get(id);
    if (answer) this.queue(answer);
    return true;
  }

  private answer(id: number, m: ServerMessage): void {
    if (this.seen.has(id)) this.seen.set(id, m);
    this.push(m);
  }

  private queueAck(): void {
    const ack = this.inputs.takeAck(this.now);
    if (!ack) return;
    this.lastAckAt = this.now;
    this.queue(ack);
  }

  private refuse(reason: SessionRefusal, text: string, retryAfterMs: number | null = null, queue: { position: number; etaSeconds: number } | null = null): void {
    if (this.phase === 'closed') return;
    this.refusals.push({ reason, detail: text });
    this.queue({ type: 'refused', reason, text, retryAfterMs, queue });
    this.flush(true);
    this.close(CLOSE.refused, reason);
  }

  /** Close the socket; a pilot who was online has lost it (U16), unless the account moved to another session. */
  private close(code: number, reason: string): void {
    if (this.phase === 'closed') return;
    const wasOnline = this.phase === 'online';
    this.setPhase('closed');
    this.out({ kind: 'close', code, reason });
    if (wasOnline && code !== CLOSE.takenOver) this.out({ kind: 'lost', info: { code, reason, clean: code === CLOSE.normal } });
  }

  private setPhase(p: ServerPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.out({ kind: 'phase', phase: p });
  }

  /** Encode a message (against the session's handles) and offer it to the budget. */
  private queue(m: ServerMessage): void {
    const record = encodeMessage(m, this.handles);
    const handles = this.handles.takePending();
    if (handles) this.budget.offer(encodeMessage(handles), 0, null, this.now);
    const key = specOf(m.type).delivery === 'latest' ? supersedeKey(m) : null;
    this.budget.offer(record, budgetClassOf(m), key, this.now, { obsoletes: obsoletedKeys(m), islandEnter: m.type === 'islandEnter', contact: m.type === 'islandDelta' && m.vessels.some((v) => v.contact !== null) });
  }

  /** Release what the budget allows now (`closing`: everything, the socket is about to close). */
  private flush(closing = false): void {
    const released = closing ? this.budget.takeAll() : this.budget.take(this.now);
    if (released.length === 0) return;
    this.lastSentAt = this.now;
    this.out({ kind: 'send', records: released.map((r) => r.record), keys: released.map((r) => r.key) });
  }

  private out(a: ServerAction): void {
    this.actions.push(a);
  }
}

/** The budget's options from the rules' wire limits. */
export function budgetOptionsOf(l: WireLimits): BudgetOptions {
  return {
    bytesPerSecond: l.downstreamBytesPerSecond,
    burstBytesPerSecond: l.downstreamBurstBytesPerSecond,
    burstSeconds: l.downstreamBurstSeconds,
    burstWindowSeconds: l.downstreamBurstWindow,
    islandEnterFreeBytes: l.islandEnterFreeBytes,
    relevantFloorShare: l.relevantFloorShare,
    deltaRateTarget: l.deltaRateTarget,
    deltaRateFloor: l.deltaRateFloor,
  };
}
