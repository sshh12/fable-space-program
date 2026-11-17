/**
 * The client half of the session layer (ARCHITECTURE 13.2, 13.6, U16): a pure state machine with no I/O.
 * The driver (driver.ts) feeds it what happened (a transport opened or closed, decoded messages, a signature,
 * the time) and carries out what it asks (open a transport, send, close, sign, deliver a message to the app,
 * report the link state). `netcode-client` builds `NetSession` on it; the same transcripts that drive it
 * against the server half (tests/unit/net/transcripts) can be replayed against any client built on it.
 *
 * What it does:
 *  - the handshake Hello / Challenge / Auth / Welcome, with the protocol version, the build and the
 *    definition hash; a refusal by version is final ('refused', the HUD's "a new version is ready");
 *  - resume: after a session was welcomed, a lost socket is reconnected with `Hello.resume` (the session token
 *    and the last relevant-set sequence number); the subscriptions, the unacknowledged inputs and the requests
 *    without an answer are sent again; a refused resume starts a new session;
 *  - takenOver: another session of the account attached; this one stops sending and does not reconnect;
 *  - subscriptions, merged, sent at most `limits.subscriptionsPerSecond` times a second;
 *  - inputs: numbered, repeated until acknowledged within `inputRepeatMs` (InputWindow);
 *  - declared loss: a ping every `disconnect.pingInterval` when idle; no frame for `disconnect.lossTimeout`
 *    closes the socket; then the backoff 0.5, 1, 2, 4, 8 s, then every 15 s, with jitter;
 *  - time sync (minimum-round-trip filter), the input margin, and the link state for the HUD.
 * A malformed or out-of-order server message is refused with a typed reason: the socket is closed and the
 * client reconnects.
 */
import type {
  ClientMessage,
  InputAckMessage,
  LinkState,
  ServerMessage,
  SessionRefusal,
  TargetRef,
  TimeRequest,
  UniverseRules,
  WireCommand,
  WireControls,
} from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, WIRE_PROTOCOL_VERSION } from '@/core/contracts/net';
import type { SpawnRequest, Subscriptions } from '@/core/contracts/session';
import type { Vec3 } from '@/core/math/vec3';
import type { DecodeError } from '../codec/bytes';
import { addSample, estimateClock, type SyncEstimate, type SyncSample } from '../time/sync';
import type { CloseInfo } from '../transport/types';
import { CLOSE } from '../transport/types';
import { InputWindow } from './inputs';
import { backoffMs, RateWindow } from './limits';

export type ClientPhase = 'idle' | 'connecting' | 'hello' | 'signing' | 'auth' | 'online' | 'backoff' | 'refused' | 'takenOver' | 'closed';

/** Why the client refused something the server sent. */
export type ClientRefusal = 'malformed' | 'outOfOrder';

export interface ClientConfig {
  protocol?: number;
  build: string;
  defsHash: string;
  cpuScore: number | null;
  accountId: string;
  /** The rules the client starts with (replaced by `rules` messages). */
  rules?: UniverseRules;
  /** Random numbers in [0, 1) for the backoff jitter. */
  random: () => number;
}

export type ClientAction =
  /** Open a transport to the gateway; `nextCandidate`: the last one is in standby, try the next of the endpoint list. */
  | { kind: 'open'; attempt: number; nextCandidate: boolean }
  | { kind: 'send'; message: ClientMessage }
  | { kind: 'close'; code: number; reason: string }
  /** Sign nonce || serverId || build with the device key (ARCHITECTURE 25); answer with `signed`. */
  | { kind: 'sign'; nonce: Uint8Array; serverId: string; build: string }
  /** A server message for the app (everything but the session's own: challenge, ping, pong, time-sync replies). */
  | { kind: 'deliver'; message: ServerMessage }
  | { kind: 'status'; link: LinkState };

/** A request that waits for an answer, kept for a resume. */
interface PendingRequest {
  id: number;
  message: ClientMessage;
  /** Sent on a session (false: made before the first welcome, sent after it). */
  sent: boolean;
}

const SYNC_BURST = 3;
const SYNC_EVERY_PINGS = 10;

export class ClientSession {
  phase: ClientPhase = 'idle';
  private readonly cfg: Required<Omit<ClientConfig, 'rules'>> & { rules: UniverseRules };
  private now = 0;
  private readonly actions: ClientAction[] = [];

  /** The session token of the last welcome (null before the first). */
  session: string | null = null;
  accountId: string | null = null;
  callsign: string | null = null;
  /** The seat (from a seat result or a resume). */
  vesselId: string | null = null;
  clockId: string | null = null;
  /** The last relevant-set sequence number delivered. */
  relevantSeq: number | null = null;
  /** The last refusal received, and the last one this client made of the server. */
  refusal: { reason: SessionRefusal; text: string; retryAfterMs: number | null } | null = null;
  ownRefusal: { reason: ClientRefusal; detail: string } | null = null;
  queuePosition: number | null = null;
  durableTick: number | null = null;
  inputMarginMs: number | null = null;

  readonly inputs = new InputWindow();
  private subscriptions: Subscriptions = {};
  private subscriptionsDirty = false;
  private subscriptionRate: RateWindow;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;

  private attempt = 0;
  private wakeAt: number | null = null;
  private lastFrameAt = 0;
  private lastSentAt = 0;
  private pingSeq = 0;
  private pingsSinceSync = 0;
  private syncSeq = 0;
  private syncSent = new Map<number, number>();
  private samples: SyncSample[] = [];
  clock: SyncEstimate | null = null;
  private lostAt: number | null = null;
  private nextCandidate = false;
  private everWelcomed = false;
  private lastReason: string | null = null;
  private standbyStreak = 0;

  constructor(cfg: ClientConfig) {
    this.cfg = { protocol: cfg.protocol ?? WIRE_PROTOCOL_VERSION, build: cfg.build, defsHash: cfg.defsHash, cpuScore: cfg.cpuScore, accountId: cfg.accountId, random: cfg.random, rules: cfg.rules ?? DEFAULT_UNIVERSE_RULES };
    this.subscriptionRate = new RateWindow(this.cfg.rules.limits.subscriptionsPerSecond, 1000);
  }

  // ------------------------------------------------------------------------------------- the driver

  /** Take the actions produced since the last call. */
  drain(): ClientAction[] {
    return this.actions.splice(0, this.actions.length);
  }

  /** The earliest time `tick` has something to do (null: nothing until an event). */
  nextDeadline(): number | null {
    const d: number[] = [];
    if (this.wakeAt !== null) d.push(this.wakeAt);
    if (this.transportUp()) {
      d.push(this.lastFrameAt + this.lossMs());
      d.push(this.lastSentAt + this.pingMs());
    }
    if (this.phase === 'online' && this.subscriptionsDirty) d.push(this.subscriptionRate.nextFreeAt(this.now));
    return d.length ? Math.min(...d) : null;
  }

  /** Time passes (call before every other entry point with the current time). */
  tick(nowMs: number): void {
    this.now = nowMs;
    if (this.phase === 'backoff' && this.wakeAt !== null && nowMs >= this.wakeAt) {
      this.wakeAt = null;
      this.open();
      return;
    }
    if (!this.transportUp()) return;
    // Deadlines are compared as `now >= base + interval`, exactly as nextDeadline() computes them (a
    // difference can round below the interval and leave a timer that fires at once for ever).
    if (nowMs >= this.lastFrameAt + this.lossMs()) {
      // Declared loss (U16): nothing for lossTimeout.
      this.dropTransport(CLOSE.lost, 'no frame for the loss timeout');
      return;
    }
    if (nowMs >= this.lastSentAt + this.pingMs()) {
      if (this.phase === 'online' && ++this.pingsSinceSync >= SYNC_EVERY_PINGS) {
        this.pingsSinceSync = 0;
        this.sendTimeSync();
      } else this.send({ type: 'ping', seq: ++this.pingSeq });
    }
    if (this.phase === 'online') this.flushSubscriptions();
  }

  // ------------------------------------------------------------------------------------- app entry points

  /** Start (or restart after a refusal) the session. */
  connect(): void {
    if (this.phase !== 'idle' && this.phase !== 'refused' && this.phase !== 'closed') return;
    this.attempt = 0;
    this.refusal = null;
    this.open();
  }

  /** Leave on purpose: `bye`, then close; no reconnect. */
  leave(text = 'left'): void {
    if (this.transportUp()) {
      this.send({ type: 'bye', reason: 'leave', text });
      this.out({ kind: 'close', code: CLOSE.normal, reason: 'leave' });
    }
    this.phase = 'closed';
    this.wakeAt = null;
    this.failPending(this.finalReason());
    this.status();
  }

  spawn(request: SpawnRequest): number {
    return this.request((reqId) => ({ type: 'spawn', reqId, request }));
  }

  attach(vesselId: string, clockId: string | null = null): number {
    return this.request((reqId) => ({ type: 'attach', reqId, vesselId, clockId }));
  }

  detach(): number {
    return this.request((reqId) => ({ type: 'detach', reqId }));
  }

  /** Leave the launch queue of a spawn request. */
  cancelSpawn(reqId: number): void {
    this.pending.delete(reqId);
    if (this.phase === 'online') this.send({ type: 'spawnCancel', reqId });
  }

  command(tick: number, command: WireCommand): number {
    return this.request((cmdId) => ({ type: 'command', cmdId, tick, command }));
  }

  time(tick: number, request: TimeRequest): number {
    return this.request((cmdId) => ({ type: 'time', cmdId, tick, request }));
  }

  target(ref: TargetRef | null): void {
    if (this.phase === 'online') this.send({ type: 'target', ref });
  }

  plan(craftId: string, data: Uint8Array): void {
    if (this.phase === 'online') this.send({ type: 'plan', craftId, data });
  }

  quick(phrase: string, toAccountId: string | null): void {
    if (this.phase === 'online') this.send({ type: 'quick', phrase, toAccountId });
  }

  /** Change the subscriptions (absent keys keep their value); sent when the rate limit allows. */
  subscribe(change: Subscriptions): void {
    this.subscriptions = { ...this.subscriptions, ...change };
    this.subscriptionsDirty = true;
    if (this.phase === 'online') this.flushSubscriptions();
  }

  get currentSubscriptions(): Subscriptions {
    return { ...this.subscriptions };
  }

  /** The pilot's controls at `applyTick` (wire units). */
  input(controls: WireControls, applyTick: number, sasHold: Vec3 | null = null): void {
    if (this.phase === 'takenOver' || this.phase === 'closed') return;
    this.inputs.add(controls, applyTick, sasHold);
    if (this.phase === 'online') {
      const m = this.inputs.message();
      if (m) this.send(m);
    }
  }

  /** Requests without an answer yet, by id. */
  get pendingRequests(): number[] {
    return [...this.pending.keys()].sort((a, b) => a - b);
  }

  // ------------------------------------------------------------------------------------- transport events

  transportOpen(): void {
    if (this.phase !== 'connecting') return;
    this.lastFrameAt = this.now;
    this.phase = 'hello';
    const resume = this.session ? { session: this.session, relevantSeq: this.relevantSeq } : null;
    this.send({ type: 'hello', protocol: this.cfg.protocol, build: this.cfg.build, defsHash: this.cfg.defsHash, cpuScore: this.cfg.cpuScore, resume });
    this.status();
  }

  transportClosed(info: CloseInfo): void {
    if (this.phase === 'idle' || this.phase === 'backoff' || this.phase === 'closed' || this.phase === 'takenOver' || this.phase === 'refused') return;
    this.afterLoss(info.reason || `closed (${info.code})`);
  }

  /** A frame that did not decode. */
  malformed(error: DecodeError): void {
    this.refuseServer('malformed', `${error.code} at ${error.offset} in ${error.where}`);
  }

  messages(list: readonly ServerMessage[]): void {
    for (const m of list) {
      if (!this.transportUp()) return;
      this.lastFrameAt = this.now;
      this.onMessage(m);
    }
  }

  /** The device key's signature of the challenge. */
  signed(signature: Uint8Array): void {
    if (this.phase !== 'signing') return;
    this.phase = 'auth';
    this.send({ type: 'auth', accountId: this.cfg.accountId, signature });
    this.status();
  }

  // ------------------------------------------------------------------------------------- internals

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'ping':
        this.send({ type: 'pong', seq: m.seq });
        return;
      case 'pong':
        return;
      case 'timeSyncReply': {
        const sent = this.syncSent.get(m.seq);
        if (sent === undefined) return;
        this.syncSent.delete(m.seq);
        this.samples = addSample(this.samples, { clientSendMs: sent, serverRecvMs: m.serverRecvMs, serverSendMs: m.serverSendMs, clientRecvMs: this.now, upMs: m.upMs });
        this.clock = estimateClock(this.samples);
        this.status();
        return;
      }
      case 'refused':
        this.onRefused(m.reason, m.text, m.retryAfterMs, m.queue);
        return;
      case 'takenOver':
        this.phase = 'takenOver';
        this.wakeAt = null;
        this.out({ kind: 'close', code: CLOSE.takenOver, reason: 'taken over' });
        this.out({ kind: 'deliver', message: m });
        this.failPending(this.finalReason());
        this.status();
        return;
      case 'bye':
        this.out({ kind: 'deliver', message: m });
        this.dropTransport(CLOSE.normal, m.text);
        return;
      case 'challenge':
        if (this.phase !== 'hello') return this.refuseServer('outOfOrder', 'challenge outside the handshake');
        this.phase = 'signing';
        this.out({ kind: 'sign', nonce: m.nonce, serverId: m.serverId, build: this.cfg.build });
        this.status();
        return;
      case 'welcome':
        if (this.phase !== 'auth' && !(this.phase === 'hello' && this.session !== null && m.resumed !== null)) return this.refuseServer('outOfOrder', 'welcome outside the handshake');
        this.onWelcome(m);
        return;
      default:
        if (this.phase !== 'online') return this.refuseServer('outOfOrder', `${m.type} before the welcome`);
        this.onSessionMessage(m);
    }
  }

  private onWelcome(m: Extract<ServerMessage, { type: 'welcome' }>): void {
    const resumed = m.resumed !== null && this.session !== null;
    const hadSession = this.session !== null;
    this.phase = 'online';
    this.session = m.session;
    this.accountId = m.accountId;
    this.callsign = m.callsign;
    this.attempt = 0;
    this.lostAt = null;
    this.queuePosition = null;
    this.refusal = null;
    this.nextCandidate = false;
    this.standbyStreak = 0;
    this.everWelcomed = true;
    if (m.resumed) {
      this.vesselId = m.resumed.vesselId;
      this.clockId = m.resumed.clockId;
      this.relevantSeq = m.resumed.relevantSeq;
      this.inputs.retireThrough(m.resumed.lastInputSeq);
    } else {
      // A new session: what an old session waited for is gone with it.
      this.vesselId = null;
      this.clockId = null;
      this.relevantSeq = null;
      this.failPending('the session was not resumed', true);
      // Inputs of an ended session steer nothing in the new one.
      if (hadSession) this.inputs.retireThrough(this.inputs.next - 1);
    }
    this.samples = addSample(this.samples, { clientSendMs: this.now, serverRecvMs: m.serverMs, serverSendMs: m.serverMs, clientRecvMs: this.now, upMs: m.upMs });
    this.clock = estimateClock(this.samples);
    this.out({ kind: 'deliver', message: m });
    for (let i = 0; i < SYNC_BURST; i++) this.sendTimeSync();
    if (Object.keys(this.subscriptions).length) this.subscriptionsDirty = true;
    this.flushSubscriptions();
    // Requests made before this welcome, and on a resume every request still waiting, go now.
    for (const p of [...this.pending.values()].sort((a, b) => a.id - b.id)) {
      if (p.sent && !resumed) continue;
      p.sent = true;
      this.send(p.message);
    }
    if (resumed) for (const im of this.inputs.resendMessages()) this.send(im);
    else {
      const im = this.inputs.message();
      if (im) this.send(im);
    }
    this.status();
  }

  private onSessionMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'seatResult':
        this.pending.delete(m.reqId);
        if (m.result.ok) {
          this.vesselId = m.result.vesselId;
          this.clockId = m.result.clockId;
        }
        break;
      case 'spawnQueued':
        this.queuePosition = m.position;
        break;
      case 'commandResult':
        this.pending.delete(m.cmdId);
        break;
      case 'inputAck':
        this.onAck(m);
        break;
      case 'relevantFull':
        this.relevantSeq = m.seq;
        break;
      case 'relevantDelta':
        this.relevantSeq = m.seq;
        break;
      case 'durable':
        this.durableTick = m.tick;
        break;
      case 'rules':
        this.cfg.rules = m.rules;
        this.subscriptionRate.max = m.rules.limits.subscriptionsPerSecond;
        break;
      case 'clock':
        if (m.role === 'own') this.clockId = m.clock.id;
        break;
      default:
        break;
    }
    this.out({ kind: 'deliver', message: m });
  }

  private onAck(m: InputAckMessage): void {
    this.inputs.acknowledge(m);
    if (m.marginMs !== null) this.inputMarginMs = m.marginMs;
  }

  private onRefused(reason: SessionRefusal, text: string, retryAfterMs: number | null, queue: { position: number; etaSeconds: number } | null): void {
    this.refusal = { reason, text, retryAfterMs };
    this.queuePosition = queue ? queue.position : null;
    this.out({ kind: 'close', code: CLOSE.refused, reason });
    switch (reason) {
      case 'protocol':
      case 'build':
      case 'defsHash':
      case 'auth':
        // Final: a new version is ready, or the account cannot sign in (the app may connect again later).
        this.phase = 'refused';
        this.wakeAt = null;
        this.failPending(text);
        break;
      case 'resume':
        // The session is gone: start a new one at once.
        this.session = null;
        this.failPending('the session ended', true);
        this.inputs.retireThrough(this.inputs.next - 1);
        this.beginBackoff(0);
        break;
      case 'standby':
        // The next candidate at once (a stage move, ARCHITECTURE 13.1); when that one is in standby too,
        // the ordinary backoff, so a list of candidates all in standby is not hammered.
        this.nextCandidate = true;
        this.beginBackoff(this.standbyStreak++ === 0 ? 0 : backoffMs(this.attempt++, this.cfg.random));
        break;
      default:
        this.beginBackoff(retryAfterMs ?? backoffMs(this.attempt++, this.cfg.random));
    }
    this.status();
  }

  private refuseServer(reason: ClientRefusal, detail: string): void {
    this.ownRefusal = { reason, detail };
    this.dropTransport(CLOSE.protocolError, `${reason}: ${detail}`);
  }

  private dropTransport(code: number, reason: string): void {
    this.out({ kind: 'close', code, reason });
    this.afterLoss(reason);
  }

  private afterLoss(reason: string): void {
    if (this.phase === 'takenOver' || this.phase === 'closed' || this.phase === 'refused') return;
    if (this.lostAt === null) this.lostAt = this.now;
    this.beginBackoff(backoffMs(this.attempt++, this.cfg.random));
    this.lastReason = reason;
    this.status();
  }

  private beginBackoff(waitMs: number): void {
    this.phase = 'backoff';
    this.wakeAt = this.now + waitMs;
  }

  private open(): void {
    this.phase = 'connecting';
    this.out({ kind: 'open', attempt: this.attempt, nextCandidate: this.nextCandidate });
    this.nextCandidate = false;
    this.status();
  }

  private request(build: (id: number) => ClientMessage): number {
    const id = this.nextId++;
    const message = build(id);
    const online = this.phase === 'online';
    this.pending.set(id, { id, message, sent: online });
    if (online) this.send(message);
    // A session that cannot go on answers at once (taken over, left, refused for good).
    else if (this.phase === 'takenOver' || this.phase === 'closed' || this.phase === 'refused') this.failPending(this.finalReason());
    return id;
  }

  private finalReason(): string {
    if (this.phase === 'takenOver') return 'the flight was taken over by another session';
    if (this.phase === 'closed') return 'the session was left';
    return this.refusal?.text ?? 'the session was refused';
  }

  /**
   * Requests that cannot be answered any more (their session ended) are answered here, as refused; with
   * `sentOnly`, only those that were sent (a request made while connecting waits for the new session).
   */
  private failPending(reason: string, sentOnly = false): void {
    for (const p of [...this.pending.values()]) {
      if (sentOnly && !p.sent) continue;
      const m = p.message;
      if (m.type === 'spawn' || m.type === 'attach') this.out({ kind: 'deliver', message: { type: 'seatResult', reqId: p.id, result: { ok: false, reason, alternative: null } } });
      else this.out({ kind: 'deliver', message: { type: 'commandResult', cmdId: p.id, ok: false, appliedTick: null, reason, alternative: null } });
      this.pending.delete(p.id);
    }
  }

  private flushSubscriptions(): void {
    if (!this.subscriptionsDirty || this.phase !== 'online') return;
    if (!this.subscriptionRate.admit(this.now)) return;
    this.subscriptionsDirty = false;
    this.send({ type: 'subscribe', change: { ...this.subscriptions } });
  }

  private sendTimeSync(): void {
    const seq = ++this.syncSeq;
    this.syncSent.set(seq, this.now);
    if (this.syncSent.size > 32) this.syncSent.delete(this.syncSent.keys().next().value!);
    this.send({ type: 'timeSync', seq, clientMs: this.now });
  }

  private send(message: ClientMessage): void {
    this.lastSentAt = this.now;
    this.out({ kind: 'send', message });
  }

  private out(a: ClientAction): void {
    this.actions.push(a);
  }

  private transportUp(): boolean {
    return this.phase === 'hello' || this.phase === 'signing' || this.phase === 'auth' || this.phase === 'online';
  }

  private lossMs(): number {
    return this.cfg.rules.disconnect.lossTimeout * 1000;
  }

  private pingMs(): number {
    return this.cfg.rules.disconnect.pingInterval * 1000;
  }

  /** The link state for the HUD and the stores (`LinkState`). */
  linkState(): LinkState {
    const state: LinkState['state'] =
      this.phase === 'online'
        ? 'online'
        : this.phase === 'takenOver'
          ? 'takenOver'
          : this.phase === 'refused'
            ? this.refusal?.reason === 'maintenance'
              ? 'maintenance'
              : 'incompatible'
            : this.phase === 'idle' || this.phase === 'closed'
              ? 'offline'
              : this.refusal?.reason === 'full'
                ? 'queued'
                : this.refusal?.reason === 'maintenance'
                  ? 'maintenance'
                  : this.everWelcomed
                    ? 'reconnecting'
                    : 'connecting';
    const grace = state === 'reconnecting' && this.lostAt !== null ? Math.max(0, this.cfg.rules.disconnect.reconnectGrace - (this.now - this.lostAt) / 1000) : null;
    const reason = state === 'online' || state === 'offline' ? null : (this.refusal?.text ?? this.lastReason);
    return {
      state,
      rttMs: this.clock ? this.clock.rttMs : null,
      inputMarginMs: this.inputMarginMs,
      graceRemaining: grace,
      queuePosition: state === 'queued' ? this.queuePosition : null,
      durableTick: this.durableTick,
      reason,
    };
  }

  private status(): void {
    this.out({ kind: 'status', link: this.linkState() });
  }
}
