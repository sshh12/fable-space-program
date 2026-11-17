/**
 * The server half of the session layer: what the gateway runs per socket (ARCHITECTURE 13.2, 13.6, 16.1,
 * 26, U16). A pure state machine with no I/O, like the client half: the driver feeds it decoded client
 * messages, transport events, the time and the host's answers (the account check, the resume check, seat
 * results, the shard's input applications, everything to send downstream), and carries out what it asks
 * (send encoded records, close, verify a signature, check a resume, forward a client message to the universe,
 * declare the socket lost).
 *
 * What it does:
 *  - the handshake: version, build and definition hash checked (`refused` 'protocol' / 'build' / 'defsHash'),
 *    a nonce, the signature check by the host, the welcome; a role in standby refuses at once ('standby');
 *    a handshake that does not finish in `handshakeTimeoutMs` is refused ('timeout');
 *  - resume: `Hello.resume` is checked by the host; welcomed at once with the seat, or refused ('resume');
 *  - takenOver on the host's word; drain and maintenance as a `bye`;
 *  - malformed frames and messages out of order are refused with a typed reason, and the socket is closed;
 *  - the rate limits of ARCHITECTURE 26, every one a `UniverseRules.limits` field: inputs, commands, `time`
 *    messages per account in their window, subscription churn; a request seen before (a resent request after
 *    a resume) is answered once;
 *  - the gateway's input buffer with acknowledged ticks (InputBuffer) and the `inputAck` sent before every key
 *    and delta;
 *  - the per-client downstream budget (DownstreamBudget) with session-local handles;
 *  - declared loss: a ping every `disconnect.pingInterval` when idle, the socket lost after
 *    `disconnect.lossTimeout` without a frame.
 */
import type {
  ClientMessage,
  ClockState,
  ResumedSeat,
  ServerMessage,
  SessionRefusal,
  SpawnQueuedMessage,
  UniverseRules,
} from '@/core/contracts/net';
import { TICKS_PER_SECOND, WIRE_CONSTANTS, WIRE_PROTOCOL_VERSION } from '@/core/contracts/net';
import { CONTROL_TICK_STEPS } from '@/core/contracts/sim';
import type { SeatResult, Subscriptions } from '@/core/contracts/session';
import type { DecodeError } from '../codec/bytes';
import { HandleTableOut } from '../codec/handles';
import { specOf, supersedeKey } from '../codec/messages';
import { encodeMessage } from '../codec/framing';
import { clockTickAt } from '../time/sync';
import type { CloseInfo } from '../transport/types';
import { CLOSE } from '../transport/types';
import { budgetClassOf, DownstreamBudget, type BudgetOptions } from './budget';
import { InputBuffer } from './inputs';
import { RateWindow } from './limits';

export type ServerPhase = 'awaitHello' | 'challenged' | 'verifying' | 'resuming' | 'online' | 'closed';

/** Longest an input acknowledgement waits for a key or a delta to ride with: one control tick, ms. */
const ACK_MAX_DELAY_MS = (CONTROL_TICK_STEPS * 1000) / TICKS_PER_SECOND;

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

/** The host's answer to `verifyAuth`. */
export type AuthResult =
  | { ok: true; accountId: string; callsign: string; session: string; liveClock: ClockState; serverMs: number; upMs: number }
  | { ok: false; reason: SessionRefusal; text: string; retryAfterMs?: number | null; queue?: { position: number; etaSeconds: number } | null };

/** The host's answer to `resume`. */
export type ResumeResult =
  | { ok: true; accountId: string; callsign: string; session: string; liveClock: ClockState; serverMs: number; upMs: number; seat: ResumedSeat }
  | { ok: false; text: string };

export type ServerAction =
  /** Encoded message records to send, in order (the driver frames them; see `Sender`). */
  | { kind: 'send'; records: Uint8Array[]; keys: (string | null)[] }
  | { kind: 'close'; code: number; reason: string }
  | { kind: 'verifyAuth'; accountId: string; signature: Uint8Array; nonce: Uint8Array; serverId: string; build: string }
  | { kind: 'resume'; session: string; relevantSeq: number | null }
  /** A client message for the universe (inputs: the accepted samples only). */
  | { kind: 'forward'; message: ClientMessage }
  /** No frame for `lossTimeout` (or the socket closed): the host applies U16 for this pilot. */
  | { kind: 'lost'; info: CloseInfo }
  /** The phase changed. */
  | { kind: 'phase'; phase: ServerPhase };

/** Why the server refused a client's message (kept for tests and logs). */
export interface ServerRefusalRecord {
  reason: SessionRefusal;
  detail: string;
}

export class ServerSession {
  phase: ServerPhase = 'awaitHello';
  private readonly cfg: ServerConfig;
  private now = 0;
  private up = 0;
  private readonly actions: ServerAction[] = [];
  readonly handles = new HandleTableOut();
  readonly budget: DownstreamBudget;
  readonly inputs: InputBuffer;
  private nonce: Uint8Array | null = null;
  /** Inputs up to this seq were applied by the session this one resumes (the host says so). */
  private resumeAfterSeq = 0;
  private openedAt = 0;
  private lastAckAt = 0;
  private lastFrameAt = 0;
  private lastSentAt = 0;
  private pingSeq = 0;

  accountId: string | null = null;
  callsign: string | null = null;
  session: string | null = null;
  /** The pilot's clock (for the stamp bound and the margin), set by the host. */
  clock: ClockState | null = null;
  subscriptions: Subscriptions = {};
  /** Refusals this side made, newest last. */
  readonly refusals: ServerRefusalRecord[] = [];
  /** Requests handled, by id (bounded: the last `requestMemory`), with their answer once known. */
  private readonly seen = new Map<number, ServerMessage | null>();
  private readonly commandRate: RateWindow;
  private readonly timeRate: RateWindow;
  private readonly subscribeRate: RateWindow;
  readonly dropped = { commands: 0, time: 0, subscriptions: 0, repeats: 0 };

  constructor(cfg: ServerConfig, nowMs: number, upMs: number) {
    this.cfg = cfg;
    this.now = nowMs;
    this.up = upMs;
    this.openedAt = nowMs;
    this.lastFrameAt = nowMs;
    this.lastSentAt = nowMs;
    const l = cfg.rules.limits;
    this.budget = new DownstreamBudget(cfg.budget);
    this.inputs = new InputBuffer(l.inputsPerSecond);
    this.commandRate = new RateWindow(l.commandsPerSecond, 1000);
    this.timeRate = new RateWindow(l.timeMessages, l.timeMessageWindow * 1000);
    this.subscribeRate = new RateWindow(l.subscriptionsPerSecond, 1000);
  }

  drain(): ServerAction[] {
    return this.actions.splice(0, this.actions.length);
  }

  nextDeadline(): number | null {
    if (this.phase === 'closed') return null;
    const d = [this.lastFrameAt + this.cfg.rules.disconnect.lossTimeout * 1000, this.lastSentAt + this.cfg.rules.disconnect.pingInterval * 1000];
    if (this.phase !== 'online') d.push(this.openedAt + WIRE_CONSTANTS.handshakeTimeoutMs);
    if (this.budget.waitingCount > 0) d.push(this.now + ACK_MAX_DELAY_MS);
    if (this.phase === 'online' && this.inputs.hasAck()) d.push(Math.max(this.now, this.lastAckAt + ACK_MAX_DELAY_MS));
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
    if (this.phase === 'online' && this.inputs.hasAck() && nowMs >= this.lastAckAt + ACK_MAX_DELAY_MS) this.queueAck();
    this.inputs.prune(nowMs);
    this.flush();
  }

  private queueAck(): void {
    const ack = this.inputs.takeAck(this.now);
    if (!ack) return;
    this.lastAckAt = this.now;
    this.queue(ack);
  }

  // ------------------------------------------------------------------------------------- client side

  messages(list: readonly ClientMessage[]): void {
    for (const m of list) {
      if (this.phase === 'closed') return;
      this.lastFrameAt = this.now;
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

  // ------------------------------------------------------------------------------------- host side

  authResult(r: AuthResult): void {
    if (this.phase !== 'verifying') return;
    if (!r.ok) {
      this.refuse(r.reason, r.text, r.retryAfterMs ?? null, r.queue ?? null);
      return;
    }
    this.welcome(r.accountId, r.callsign, r.session, r.liveClock, r.serverMs, r.upMs, null);
  }

  resumeResult(r: ResumeResult): void {
    if (this.phase !== 'resuming') return;
    if (!r.ok) {
      this.refuse('resume', r.text);
      return;
    }
    this.resumeAfterSeq = r.seat.lastInputSeq;
    // The resumed client sends the inputs the outage swallowed once: admit them beyond the rate limit.
    this.inputs.grantBurst(Math.ceil((this.cfg.rules.limits.inputsPerSecond * WIRE_CONSTANTS.inputBufferMs) / 1000));
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

  /** The pilot's clock changed (the stamp bound and the margin are measured on it). */
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
    this.flush();
    this.close(CLOSE.takenOver, 'taken over');
  }

  /** End the session in order (a drain, maintenance). */
  end(reason: 'drain' | 'maintenance', text: string): void {
    if (this.phase === 'closed') return;
    this.queue({ type: 'bye', reason, text });
    this.flush();
    this.close(CLOSE.goingAway, reason);
  }

  /** The inputs of the last `inputBufferMs` with their applied ticks (for a recovering shard). */
  retainedInputs() {
    return this.inputs.retained();
  }

  // ------------------------------------------------------------------------------------- internals

  private onMessage(m: ClientMessage): void {
    if (m.type === 'ping') {
      this.queue({ type: 'pong', seq: m.seq });
      return;
    }
    if (m.type === 'pong') return;
    if (m.type === 'timeSync') {
      this.queue({ type: 'timeSyncReply', seq: m.seq, clientMs: m.clientMs, serverRecvMs: this.now, serverSendMs: this.now, upMs: this.up });
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
      case 'challenged':
        if (m.type !== 'auth') return this.refuse('outOfOrder', `${m.type} during the handshake`);
        this.setPhase('verifying');
        this.out({ kind: 'verifyAuth', accountId: m.accountId, signature: m.signature, nonce: this.nonce!, serverId: this.cfg.serverId, build: this.cfg.build });
        return;
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
    if (m.resume) {
      this.setPhase('resuming');
      this.out({ kind: 'resume', session: m.resume.session, relevantSeq: m.resume.relevantSeq });
      return;
    }
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

  private onSessionMessage(m: ClientMessage): void {
    switch (m.type) {
      case 'hello':
      case 'auth':
        return this.refuse('outOfOrder', `${m.type} after the welcome`);
      case 'input': {
        const fresh = m.samples.filter((s) => s.seq > this.resumeAfterSeq);
        if (fresh.length !== m.samples.length) this.dropped.repeats += m.samples.length - fresh.length;
        const clockTick = this.clock ? clockTickAt(this.clock, this.up) : 0;
        const rate = this.clock ? this.clock.rate : 1;
        const limit = this.clock ? clockTickAt({ ...this.clock, untilTick: null }, this.up + this.cfg.rules.time.roundTripAllowance * 1000) : Number.MAX_SAFE_INTEGER;
        const accepted = this.inputs.accept({ type: 'input', samples: fresh }, this.now, clockTick, rate, limit);
        if (accepted.length) this.out({ kind: 'forward', message: { type: 'input', samples: accepted } });
        return;
      }
      case 'command':
      case 'time': {
        if (this.repeat(m.cmdId)) return;
        const rate = m.type === 'command' ? this.commandRate : this.timeRate;
        if (!rate.admit(this.now)) {
          if (m.type === 'command') this.dropped.commands++;
          else this.dropped.time++;
          this.commandResult(m.cmdId, false, null, m.type === 'command' ? 'Too many commands: wait a moment.' : 'Too many time requests: wait a moment.');
          return;
        }
        this.out({ kind: 'forward', message: m });
        return;
      }
      case 'spawn':
      case 'attach':
      case 'detach':
        if (this.repeat(m.reqId)) return;
        this.out({ kind: 'forward', message: m });
        return;
      case 'subscribe':
        if (!this.subscribeRate.admit(this.now)) {
          this.dropped.subscriptions++;
          return;
        }
        this.subscriptions = { ...this.subscriptions, ...m.change };
        this.out({ kind: 'forward', message: m });
        return;
      case 'spawnCancel':
      case 'target':
      case 'plan':
      case 'quick':
        this.out({ kind: 'forward', message: m });
        return;
      default:
        return;
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

  private refuse(reason: SessionRefusal, text: string, retryAfterMs: number | null = null, queue: { position: number; etaSeconds: number } | null = null): void {
    if (this.phase === 'closed') return;
    this.refusals.push({ reason, detail: text });
    this.queue({ type: 'refused', reason, text, retryAfterMs, queue });
    this.flush();
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
    this.budget.offer(record, budgetClassOf(m), key, this.now);
  }

  /** Release what the budget allows now. */
  private flush(): void {
    const released = this.budget.take(this.now);
    if (released.length === 0) return;
    this.lastSentAt = this.now;
    this.out({ kind: 'send', records: released.map((r) => r.record), keys: released.map((r) => r.key) });
  }

  private out(a: ServerAction): void {
    this.actions.push(a);
  }

  /** The tick of the pilot's clock now (0 without a clock). */
  clockTick(): number {
    return this.clock ? clockTickAt(this.clock, this.up) : 0;
  }
}
