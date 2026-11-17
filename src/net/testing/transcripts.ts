/**
 * Session transcripts (the brief: "each [state machine] has a client half and a server half driven by the
 * same recorded transcripts (tests/unit/net/transcripts), which netcode-client and server-persistence replay
 * in their own suites").
 *
 * A transcript is JSON: a scripted host (accounts, delays, the late-input and launch-queue policies), the
 * clients, a script of timed steps (app actions of a client, network events of its link, raw frames out of
 * order or malformed, host pushes), the OUTCOME every link must reach, and the frames of the loopback run
 * (recorded on virtual time, so a loopback run reproduces them byte for byte).
 *
 * `runTranscript` plays the script over a link (the plain loopback, or the injector over it with any
 * profile) with pluggable halves: by default this package's client driver and server driver with the
 * scripted host; `netcode-client` plugs its NetSession in as the client half (`TranscriptClientHalf`),
 * `server-persistence` its gateway as the server side (`TranscriptServerSide`), and both check the same
 * outcome. Everything runs on a `ManualScheduler`: deterministic, and a minute of protocol in milliseconds.
 */
import type { ClientMessage, ClockState, ServerMessage, TimeRequest, UniverseRules, WireCommand } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, TICKS_PER_SECOND } from '@/core/contracts/net';
import type { SpawnRequest, Subscriptions } from '@/core/contracts/session';
import { hashU32, Prng } from '@/core/math/hash';
import type { IdentityProof } from '../session/server';

/**
 * The transcripts' stand-in for the device key: a keyed hash of nonce || serverId || build under a secret of
 * the account (the scripted host knows every account's secret). A real signature check in shape: a wrong
 * nonce, server, build or account fails it.
 */
export function transcriptSignature(accountId: string, nonce: Uint8Array, serverId: string, build: string): Uint8Array {
  const text = `${accountId}\u0000${serverId}\u0000${build}\u0000`;
  let h = hashU32(0x5157);
  for (let i = 0; i < text.length; i++) h = hashU32(h ^ text.charCodeAt(i));
  for (const b of nonce) h = hashU32(h ^ b);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    h = hashU32(h + i);
    out[4 * i] = h & 0xff;
    out[4 * i + 1] = (h >>> 8) & 0xff;
    out[4 * i + 2] = (h >>> 16) & 0xff;
    out[4 * i + 3] = h >>> 24;
  }
  return out;
}

function signatureValid(p: IdentityProof): boolean {
  const want = transcriptSignature(p.accountId, p.nonce, p.serverId, p.build);
  return p.signature.length === want.length && want.every((b, i) => p.signature[i] === b);
}
import { encodeFrame } from '../codec/framing';
import { injectTransport, type InjectedTransport } from '../injector/injected';
import type { InjectorProfile } from '../injector/model';
import { fromHex, toHex, type RecordedFrame } from '../record/recorder';
import { ClientSession } from '../session/client';
import { ClientDriver, ServerDriver, type ServerHost } from '../session/driver';
import type { AuthResult, ResumeResult } from '../session/server';
import { ManualScheduler } from '../time/scheduler';
import { createLoopbackPair, type LoopbackTransport } from '../transport/loopback';
import type { Transport } from '../transport/types';

// ------------------------------------------------------------------------------------------------ format

export interface TranscriptHostConfig {
  build: string;
  defsHash: string;
  serverId: string;
  /** Accounts that can sign in: account id -> callsign. */
  accounts: Record<string, string>;
  /** How long the account check, a seat and a command result take, ms. */
  authDelayMs: number;
  seatDelayMs: number;
  /** Every n-th input (by seq) is applied 2 ticks after its stamp; 0 = every input as stamped. */
  lateEvery: number;
  /** A spawn waits in the launch queue through these places, one every `seatDelayMs`, before it is seated. */
  queuePlaces: number[];
  /** The gateway is in standby: every Hello is refused with 'standby'. */
  standby?: boolean;
}

export interface TranscriptClientConfig {
  id: string;
  accountId: string;
  build?: string;
  defsHash?: string;
  /** The wire protocol version the client speaks (default: this build's). */
  protocol?: number;
  seed: number;
}

export type TranscriptStep = { atMs: number } & (
  | { do: 'connect'; client: string }
  | { do: 'leave'; client: string }
  | { do: 'spawn'; client: string; request: SpawnRequest }
  | { do: 'attach'; client: string; vesselId: string }
  | { do: 'detach'; client: string }
  | { do: 'subscribe'; client: string; change: Subscriptions }
  /** `count` samples, one every `everyMs`, stamped from `firstTick` on (the server clock ticks with the up-time). */
  | { do: 'inputs'; client: string; count: number; everyMs: number }
  | { do: 'command'; client: string; command: WireCommand }
  | { do: 'time'; client: string; request: TimeRequest }
  /** The client's link fails (no close handshake). */
  | { do: 'drop'; client: string }
  /** A TCP-style stall of both directions of the client's link (injector links only; nothing on the plain loopback). */
  | { do: 'stall'; client: string; ms: number }
  /** The client's link fails and no connection succeeds for `ms` (each attempt fails at once). */
  | { do: 'outage'; client: string; ms: number }
  /** Raw bytes from the client to the server (a malformed frame). */
  | { do: 'garbage'; client: string; hex: string }
  /** A message from the client that its session would not send now (out of order), as its own frame. */
  | { do: 'outOfOrder'; client: string; message: ClientMessage }
  /** Raw bytes from the server to the client. */
  | { do: 'serverGarbage'; client: string; hex: string }
  /** The host sends a message to the client's current server session. */
  | { do: 'push'; client: string; message: ServerMessage }
);

export interface ClientOutcome {
  phase: string;
  accountId: string | null;
  vesselId: string | null;
  pendingRequests: number[];
  unackedInputs: number;
  subscriptions: Subscriptions;
  /** Reason of the last refusal received, and of the last refusal this client made of the server. */
  refusal: string | null;
  ownRefusal: string | null;
  /** Answers delivered to the app, as "id:ok" / "id:refused", sorted. */
  answers: string[];
  /** Launch-queue places delivered, in order, repeats removed. */
  queuePlaces: number[];
  /** Frames this client sent after it was told takenOver. */
  sentAfterTakenOver: number;
}

export interface HostAccountOutcome {
  /** Distinct inputs applied, and inputs that arrived a second time at the universe. */
  appliedInputs: number;
  duplicateInputs: number;
  lastInputSeq: number;
  subscriptions: Subscriptions;
  /** Requests the universe handled, as "type#id", sorted. */
  handled: string[];
  seat: string | null;
}

export interface HostOutcome {
  accounts: Record<string, HostAccountOutcome>;
  /** Refusal reasons the server sessions gave, sorted, repeats removed. */
  refusals: string[];
}

export interface TranscriptOutcome {
  clients: Record<string, ClientOutcome>;
  host: HostOutcome;
}

export interface RecordedEntry {
  atMs: number;
  dir: 'c2s' | 's2c';
  conn: number;
  hex: string;
}

export interface Transcript {
  name: string;
  description: string;
  host: TranscriptHostConfig;
  clients: TranscriptClientConfig[];
  steps: TranscriptStep[];
  /** Virtual time the run lasts, ms. */
  endMs: number;
  expect: TranscriptOutcome;
  /** Frames of the loopback run, per client. */
  recorded?: Record<string, RecordedEntry[]>;
}

// ---------------------------------------------------------------------------------------------- the halves

/** A client half: what `runTranscript` needs of a client implementation. */
export interface TranscriptClientHalf {
  /** Carry out an app step (connect, leave, spawn, attach, detach, subscribe, inputs, command, time). */
  apply(step: TranscriptStep, nowMs: number): void;
  outcome(): ClientOutcome;
}

/** The server side: accepts each new connection's transport; pushes and outcome. */
export interface TranscriptServerSide {
  accept(transport: Transport, clientId: string): void;
  push(clientId: string, message: ServerMessage): void;
  outcome(): HostOutcome;
}

export interface TranscriptLinkOptions {
  /** 'loopback': the plain loopback; 'injector': the injector over the loopback with `profile`. */
  kind: 'loopback' | 'injector';
  profile?: InjectorProfile;
}

export interface RunOptions {
  link: TranscriptLinkOptions;
  rules?: UniverseRules;
  /** Build the client half (default: this package's ClientSession on a ClientDriver). */
  client?: (cfg: TranscriptClientConfig, ctx: ClientContext) => TranscriptClientHalf;
  /** Build the server side (default: this package's ServerSession on a ServerDriver, with the scripted host). */
  server?: (t: Transcript, ctx: ServerContext) => TranscriptServerSide;
}

export interface ClientContext {
  scheduler: ManualScheduler;
  rules: UniverseRules;
  /** Open a new connection to the server side (returns the client's end). */
  connect(): Transport;
}

export interface ServerContext {
  scheduler: ManualScheduler;
  rules: UniverseRules;
  /** Directory up-time now (the run starts at up-time 0). */
  upMs(): number;
}

export interface RunResult {
  outcome: TranscriptOutcome;
  recorded: Record<string, RecordedEntry[]>;
}

/** The live clock of the scripted host: tick 0 at up-time 0, rate 1. */
function liveClock(): ClockState {
  return { id: 'live', kind: 'live', tick0: 0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] };
}

// ------------------------------------------------------------------------------------- default client half

class DefaultClientHalf implements TranscriptClientHalf {
  readonly session: ClientSession;
  readonly driver: ClientDriver;
  private readonly answers = new Map<number, boolean>();
  private readonly places: number[] = [];
  private takenOverAt: number | null = null;
  sentAfterTakenOver = 0;

  constructor(cfg: TranscriptClientConfig, host: TranscriptHostConfig, ctx: ClientContext) {
    const prng = new Prng(cfg.seed);
    this.session = new ClientSession({ protocol: cfg.protocol, build: cfg.build ?? host.build, defsHash: cfg.defsHash ?? host.defsHash, cpuScore: null, accountId: cfg.accountId, rules: ctx.rules, random: () => prng.next() });
    this.driver = new ClientDriver({
      session: this.session,
      scheduler: ctx.scheduler,
      connect: () => ctx.connect(),
      // The device key of the account (the scripted host checks it like a real signature).
      sign: (nonce, serverId, build) => transcriptSignature(cfg.accountId, nonce, serverId, build),
      onMessage: (m) => {
        if (m.type === 'seatResult') this.answers.set(m.reqId, m.result.ok);
        else if (m.type === 'commandResult') this.answers.set(m.cmdId, m.ok);
        else if (m.type === 'spawnQueued' && this.places[this.places.length - 1] !== m.position) this.places.push(m.position);
        else if (m.type === 'takenOver') this.takenOverAt = ctx.scheduler.now();
      },
      onFrameOut: () => {
        if (this.takenOverAt !== null) this.sentAfterTakenOver++;
      },
    });
  }

  apply(step: TranscriptStep, nowMs: number): void {
    const d = this.driver;
    switch (step.do) {
      case 'connect':
        d.start();
        break;
      case 'leave':
        d.enter((s) => s.leave());
        break;
      case 'spawn':
        d.enter((s) => s.spawn(step.request));
        break;
      case 'attach':
        d.enter((s) => s.attach(step.vesselId));
        break;
      case 'detach':
        d.enter((s) => s.detach());
        break;
      case 'subscribe':
        d.enter((s) => s.subscribe(step.change));
        break;
      case 'command':
        d.enter((s) => s.command(tickAt(nowMs), step.command));
        break;
      case 'time':
        d.enter((s) => s.time(tickAt(nowMs), step.request));
        break;
      case 'inputs':
        // Each sample is entered at its own time by the runner (see runTranscript).
        break;
      default:
        break;
    }
  }

  /** One input sample now, stamped one control tick ahead of the live clock. */
  input(nowMs: number, k: number): void {
    this.driver.enter((s) => s.input({ throttle: (k * 37) % 256, pitch: (k % 9) - 4, yaw: 0, roll: (k % 5) - 2, tx: 0, ty: 0, tz: 0 }, tickAt(nowMs) + 4));
  }

  outcome(): ClientOutcome {
    const s = this.session;
    return {
      phase: s.phase,
      accountId: s.accountId,
      vesselId: s.vesselId,
      pendingRequests: s.pendingRequests,
      unackedInputs: s.inputs.pending.length,
      subscriptions: s.currentSubscriptions,
      refusal: s.refusal?.reason ?? null,
      ownRefusal: s.ownRefusal?.reason ?? null,
      answers: [...this.answers].sort((a, b) => a[0] - b[0]).map(([id, ok]) => `${id}:${ok ? 'ok' : 'refused'}`),
      queuePlaces: this.places.slice(),
      sentAfterTakenOver: this.sentAfterTakenOver,
    };
  }
}

/** The live tick at virtual time `nowMs` (the run starts at up-time 0). */
const tickAt = (nowMs: number): number => Math.floor((nowMs * TICKS_PER_SECOND) / 1000);

// ------------------------------------------------------------------------------------ default server side

interface UniverseAccount {
  callsign: string;
  applied: Set<number>;
  duplicates: number;
  lastInputSeq: number;
  subscriptions: Subscriptions;
  handled: string[];
  handledKeys: Set<string>;
  answers: Map<string, ServerMessage>;
  seat: string | null;
  session: string | null;
  driver: ServerDriver | null;
  lostAtMs: number | null;
}

/** The scripted host: the universe's side of the transcripts, deterministic. */
class ScriptedServerSide implements TranscriptServerSide, ServerHost {
  private readonly accounts = new Map<string, UniverseAccount>();
  private readonly refusals = new Set<string>();
  private readonly drivers = new Map<string, ServerDriver>();
  private sessionCount = 0;

  constructor(
    private readonly t: Transcript,
    private readonly ctx: ServerContext,
  ) {
    for (const [id, callsign] of Object.entries(t.host.accounts)) {
      this.accounts.set(id, { callsign, applied: new Set(), duplicates: 0, lastInputSeq: 0, subscriptions: {}, handled: [], handledKeys: new Set(), answers: new Map(), seat: null, session: null, driver: null, lostAtMs: null });
    }
  }

  accept(transport: Transport, clientId: string): void {
    const h = this.t.host;
    const d = new ServerDriver({
      transport,
      scheduler: this.ctx.scheduler,
      upMs: this.ctx.upMs,
      host: this,
      config: { build: h.build, defsHash: h.defsHash, serverId: h.serverId, rules: this.ctx.rules, nonce: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), standby: h.standby ?? false },
    });
    this.drivers.set(clientId, d);
  }

  push(clientId: string, message: ServerMessage): void {
    this.drivers.get(clientId)?.push(message);
  }

  private accountOf(d: ServerDriver): UniverseAccount | null {
    const id = d.session.accountId;
    return id ? (this.accounts.get(id) ?? null) : null;
  }

  private later(ms: number, fn: () => void): void {
    this.ctx.scheduler.setTimer(ms, fn);
  }

  verifyAuth(req: IdentityProof, d: ServerDriver): void {
    this.later(this.t.host.authDelayMs, () => {
      const a = this.accounts.get(req.accountId);
      if (!a || !signatureValid(req)) {
        d.authResult({ ok: false, reason: 'auth', text: 'This device key is not known.' });
        return;
      }
      // One session per account flies at a time: a new session takes the flight over.
      if (a.driver && a.driver !== d && a.driver.session.phase !== 'closed') a.driver.enter((s) => s.takeOver());
      const result: AuthResult = { ok: true, accountId: req.accountId, callsign: a.callsign, session: `tok-${req.accountId}-${++this.sessionCount}`, liveClock: liveClock(), serverMs: this.ctx.scheduler.now(), upMs: this.ctx.upMs() };
      a.driver = d;
      a.session = result.session;
      a.lostAtMs = null;
      // A new session starts its input sequence afresh.
      a.lastInputSeq = 0;
      a.applied.clear();
      d.authResult(result);
      d.enter((s) => s.setClock(liveClock()));
    });
  }

  resume(req: IdentityProof & { session: string }, d: ServerDriver): void {
    // The token alone takes no flight: the device key must sign the fresh nonce, and be the token's account's.
    if (!signatureValid(req) || this.accounts.get(req.accountId)?.session !== req.session) {
      this.later(this.t.host.authDelayMs, () => d.resumeResult({ ok: false, reason: 'resume', text: 'The session ended.' }));
      return;
    }
    this.later(this.t.host.authDelayMs, () => {
      const entry = [...this.accounts.entries()].find(([, a]) => a.session === req.session);
      const now = this.ctx.scheduler.now();
      const graceMs = this.ctx.rules.disconnect.reconnectGrace * 1000;
      if (!entry || (entry[1].lostAtMs !== null && now - entry[1].lostAtMs > graceMs)) {
        d.resumeResult({ ok: false, text: 'The session ended.' });
        return;
      }
      const [accountId, a] = entry;
      a.driver = d;
      a.lostAtMs = null;
      const result: ResumeResult = {
        ok: true,
        accountId,
        callsign: a.callsign,
        session: req.session,
        liveClock: liveClock(),
        serverMs: now,
        upMs: this.ctx.upMs(),
        seat: { vesselId: a.seat, queued: null, clockId: a.seat ? 'live' : null, relevantSeq: null, lastInputSeq: a.lastInputSeq },
      };
      d.resumeResult(result);
      d.enter((s) => s.setClock(liveClock()));
    });
  }

  forward(m: ClientMessage, d: ServerDriver): void {
    const a = this.accountOf(d);
    if (!a) return;
    const h = this.t.host;
    switch (m.type) {
      case 'input':
        for (const s of m.samples) {
          if (a.applied.has(s.seq)) {
            a.duplicates++;
            continue;
          }
          a.applied.add(s.seq);
          a.lastInputSeq = Math.max(a.lastInputSeq, s.seq);
          const late = h.lateEvery > 0 && s.seq % h.lateEvery === 0;
          const applied = late ? s.applyTick + 2 : s.applyTick;
          this.later(0, () => d.enter((x) => x.inputApplied(s.seq, applied)));
        }
        return;
      case 'subscribe':
        a.subscriptions = { ...a.subscriptions, ...m.change };
        return;
      case 'spawn':
      case 'attach':
      case 'detach':
      case 'command':
      case 'time': {
        const id = m.type === 'command' || m.type === 'time' ? m.cmdId : m.reqId;
        // Request ids are unique within a session (a resumed session keeps its token).
        const key = `${a.session}:${m.type}#${id}`;
        const cached = a.answers.get(key);
        if (cached) {
          this.later(0, () => a.driver?.push(cached));
          return;
        }
        if (a.handledKeys.has(key)) return;
        a.handledKeys.add(key);
        a.handled.push(`${m.type}#${id}`);
        this.answer(a, m, key, d);
        return;
      }
      default:
        return;
    }
  }

  private answer(a: UniverseAccount, m: ClientMessage, key: string, d: ServerDriver): void {
    const h = this.t.host;
    const send = (msg: ServerMessage): void => {
      a.answers.set(key, msg);
      // To the account's current session (the one that asked may have been replaced by a resume).
      (a.driver ?? d).push(msg);
    };
    if (m.type === 'spawn') {
      h.queuePlaces.forEach((position, i) => this.later(h.seatDelayMs * (i + 1), () => (a.driver ?? d).push({ type: 'spawnQueued', reqId: m.reqId, position, etaSeconds: position * 150, serverMs: this.ctx.scheduler.now(), padClass: 'heavy' })));
      this.later(h.seatDelayMs * (h.queuePlaces.length + 1), () => {
        a.seat = `${d.session.accountId}-${m.request.vehicleId}`;
        send({ type: 'seatResult', reqId: m.reqId, result: { ok: true, vesselId: a.seat, clockId: 'live' } });
      });
    } else if (m.type === 'attach') {
      this.later(h.seatDelayMs, () => {
        a.seat = m.vesselId;
        send({ type: 'seatResult', reqId: m.reqId, result: { ok: true, vesselId: m.vesselId, clockId: 'live' } });
      });
    } else if (m.type === 'detach') {
      this.later(h.seatDelayMs, () => {
        a.seat = null;
        send({ type: 'commandResult', cmdId: m.reqId, ok: true, appliedTick: tickAt(this.ctx.scheduler.now()), reason: null, alternative: null });
      });
    } else if (m.type === 'command' || m.type === 'time') {
      this.later(h.seatDelayMs, () => send({ type: 'commandResult', cmdId: m.cmdId, ok: true, appliedTick: m.tick, reason: null, alternative: null }));
    }
  }

  lost(_info: unknown, d: ServerDriver): void {
    const a = this.accountOf(d);
    if (a && a.driver === d) a.lostAtMs = this.ctx.scheduler.now();
  }

  phase(phase: string, d: ServerDriver): void {
    if (phase === 'closed') for (const r of d.session.refusals) this.refusals.add(r.reason);
  }

  outcome(): HostOutcome {
    const accounts: Record<string, HostAccountOutcome> = {};
    for (const [id, a] of this.accounts) {
      accounts[id] = { appliedInputs: a.applied.size, duplicateInputs: a.duplicates, lastInputSeq: a.lastInputSeq, subscriptions: { ...a.subscriptions }, handled: [...a.handled].sort(), seat: a.seat };
    }
    for (const d of this.drivers.values()) for (const r of d.session.refusals) this.refusals.add(r.reason);
    return { accounts, refusals: [...this.refusals].sort() };
  }
}

// ---------------------------------------------------------------------------------------------- the runner

/** Play a transcript over a link; returns the outcome and the frames each client's links carried. */
export function runTranscript(t: Transcript, opts: RunOptions): RunResult {
  const scheduler = new ManualScheduler(0);
  const rules = opts.rules ?? DEFAULT_UNIVERSE_RULES;
  const serverCtx: ServerContext = { scheduler, rules, upMs: () => scheduler.now() };
  const server = opts.server ? opts.server(t, serverCtx) : new ScriptedServerSide(t, serverCtx);
  const recorded: Record<string, RecordedEntry[]> = {};
  const links = new Map<string, { client: Transport; loop: LoopbackTransport; serverEnd: LoopbackTransport; injected: InjectedTransport | null; conn: number }>();
  const halves = new Map<string, TranscriptClientHalf>();

  const outageUntil = new Map<string, number>();
  for (const c of t.clients) {
    recorded[c.id] = [];
    let conn = -1;
    const ctx: ClientContext = {
      scheduler,
      rules,
      connect: () => {
        conn++;
        const myConn = conn;
        const [clientEnd, serverEnd] = createLoopbackPair(scheduler);
        // During an outage the connection fails at once.
        if (scheduler.now() < (outageUntil.get(c.id) ?? -Infinity)) scheduler.setTimer(0, () => clientEnd.fail());
        const injected = opts.link.kind === 'injector' ? injectTransport(clientEnd, opts.link.profile!, scheduler) : null;
        const base: Transport = injected ?? clientEnd;
        // Record what the client sends and receives on this connection.
        const log = recorded[c.id]!;
        const recording: Transport = {
          kind: base.kind,
          get state() {
            return base.state;
          },
          get bufferedAmount() {
            return base.bufferedAmount;
          },
          setHandler: (h) =>
            base.setHandler({
              open: () => h.open?.(),
              frame: (bytes) => {
                log.push({ atMs: scheduler.now(), dir: 's2c', conn: myConn, hex: toHex(bytes) });
                h.frame(bytes);
              },
              close: (info) => h.close(info),
            }),
          send: (f) => {
            log.push({ atMs: scheduler.now(), dir: 'c2s', conn: myConn, hex: toHex(f) });
            base.send(f);
          },
          close: (code, reason) => base.close(code, reason),
        };
        links.set(c.id, { client: recording, loop: clientEnd, serverEnd, injected, conn: myConn });
        server.accept(serverEnd, c.id);
        return recording;
      },
    };
    halves.set(c.id, opts.client ? opts.client(c, ctx) : new DefaultClientHalf(c, t.host, ctx));
  }

  // Schedule the script (input runs as one step per sample).
  for (const step of t.steps) {
    if (step.do === 'inputs') {
      for (let k = 0; k < step.count; k++) {
        const at = step.atMs + k * step.everyMs;
        scheduler.setTimer(at, () => {
          const half = halves.get(step.client);
          if (half instanceof DefaultClientHalf) half.input(scheduler.now(), k);
          else half?.apply({ ...step, count: 1, atMs: at }, scheduler.now());
        });
      }
      continue;
    }
    scheduler.setTimer(step.atMs, () => runStep(step));
  }

  function runStep(step: TranscriptStep): void {
    const link = links.get(step.client);
    switch (step.do) {
      case 'drop':
        if (link?.injected) link.injected.disconnect();
        else link?.loop.fail();
        return;
      case 'stall':
        link?.injected?.stall('both', step.ms);
        return;
      case 'outage':
        outageUntil.set(step.client, scheduler.now() + step.ms);
        if (link?.injected) link.injected.disconnect();
        else link?.loop.fail();
        return;
      case 'garbage':
        link?.loop.send(fromHex(step.hex));
        return;
      case 'outOfOrder':
        if (link) link.client.send(encodeSingle(step.message));
        return;
      case 'serverGarbage':
        link?.serverEnd.send(fromHex(step.hex));
        return;
      case 'push':
        server.push(step.client, step.message);
        return;
      default:
        halves.get(step.client)?.apply(step, scheduler.now());
    }
  }

  scheduler.advanceTo(t.endMs);
  const clients: Record<string, ClientOutcome> = {};
  for (const [id, half] of halves) clients[id] = half.outcome();
  return { outcome: { clients, host: server.outcome() }, recorded };
}

function encodeSingle(m: ClientMessage): Uint8Array {
  return encodeFrame([m]);
}

/**
 * A transcript from its JSON (a parsed object): byte fields of pushed messages are written as
 * `{ "$hex": "0a1b..." }` in the files and become Uint8Arrays here.
 */
export function parseTranscript(json: unknown): Transcript {
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === '$hex' && typeof o.$hex === 'string') return fromHex(o.$hex);
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = revive(o[k]);
      return out;
    }
    return v;
  };
  const t = revive(json) as Transcript;
  if (typeof t.name !== 'string' || !Array.isArray(t.steps) || !Array.isArray(t.clients) || typeof t.endMs !== 'number') throw new Error('parseTranscript: not a transcript');
  return t;
}

/** The recorded frames of a transcript as `RecordedFrame`s (for the replayer and the fixtures). */
export function recordedFrames(entries: readonly RecordedEntry[]): RecordedFrame[] {
  return entries.map((e) => ({ atMs: e.atMs, dir: e.dir, conn: e.conn, bytes: fromHex(e.hex) }));
}
