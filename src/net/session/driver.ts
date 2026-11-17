/**
 * Drivers: the glue between a session machine (client.ts, server.ts), a transport and a scheduler. A driver
 * decodes frames into the machine's events, carries out its actions (open a transport, send through a
 * back-pressure-aware `Sender`, close, ask the host or the app) and wakes the machine at its next deadline.
 * They are the one place where the session layer touches time and I/O, and both run unchanged in a browser,
 * in Node and in a worker: everything they touch is injected.
 */
import type { ClientMessage, LinkState, ServerMessage } from '@/core/contracts/net';
import { decodeFrame } from '../codec/framing';
import { HandleTableIn } from '../codec/handles';
import type { Scheduler, TimerHandle } from '../time/scheduler';
import { Sender, type SenderOptions } from '../transport/sender';
import type { CloseInfo, Transport } from '../transport/types';
import type { ClientSession } from './client';
import type { AuthResult, ResumeResult, ServerConfig, ServerPhase } from './server';
import { ServerSession } from './server';

/**
 * Hand an answer to `then` after the current run: when the promise resolves, or for a plain value through
 * the scheduler at once (never inside the run that asked, so the actions of that run keep their order; on
 * virtual time this stays deterministic).
 */
function later<T>(scheduler: Scheduler, value: T | Promise<T>, then: (v: T) => void): void {
  if (value instanceof Promise) void value.then(then);
  else scheduler.setTimer(0, () => then(value));
}

export interface ClientDriverOptions {
  session: ClientSession;
  scheduler: Scheduler;
  /** Open a transport for a connection attempt (`nextCandidate`: move to the next endpoint of the list). */
  connect(attempt: number, nextCandidate: boolean): Transport;
  /** Sign nonce || serverId || build with the device key. */
  sign(nonce: Uint8Array, serverId: string, build: string): Uint8Array | Promise<Uint8Array>;
  onMessage?(m: ServerMessage): void;
  onLink?(link: LinkState): void;
  /** Every frame sent, for recorders (the bytes are a copy). */
  onFrameOut?(bytes: Uint8Array): void;
  sender?: SenderOptions;
}

export class ClientDriver {
  readonly session: ClientSession;
  transport: Transport | null = null;
  private sender: Sender | null = null;
  private handles = new HandleTableIn();
  private timer: TimerHandle | null = null;
  private stopped = false;

  constructor(private readonly opts: ClientDriverOptions) {
    this.session = opts.session;
  }

  /** Connect (the session's `connect`). */
  start(): void {
    this.enter(() => this.session.connect());
  }

  /**
   * Run any session entry point with the clock set and the actions carried out. A call made while the driver
   * is carrying out actions (an app that reacts inside `onMessage`) runs right after.
   */
  enter(fn: (s: ClientSession) => void): void {
    if (this.stopped) return;
    if (this.running) {
      this.deferred.push(fn);
      return;
    }
    this.running = true;
    try {
      let next: ((s: ClientSession) => void) | undefined = fn;
      while (next) {
        this.session.tick(this.opts.scheduler.now());
        next(this.session);
        this.run();
        next = this.deferred.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private running = false;
  private readonly deferred: ((s: ClientSession) => void)[] = [];

  /** Stop the driver: close the transport, cancel the timer. */
  stop(): void {
    this.stopped = true;
    this.opts.scheduler.clearTimer(this.timer);
    this.timer = null;
    this.transport?.close();
  }

  private run(): void {
    for (const a of this.session.drain()) {
      switch (a.kind) {
        case 'open':
          this.openTransport(a.attempt, a.nextCandidate);
          break;
        case 'send':
          this.sender?.push(a.message);
          break;
        case 'close':
          this.sender?.flush();
          this.transport?.close(a.code, a.reason);
          break;
        case 'sign':
          later(this.opts.scheduler, this.opts.sign(a.nonce, a.serverId, a.build), (sig) => this.enter((s) => s.signed(sig)));
          break;
        case 'deliver':
          this.opts.onMessage?.(a.message);
          break;
        case 'status':
          this.opts.onLink?.(a.link);
          break;
      }
    }
    this.sender?.flush();
    this.arm();
  }

  private openTransport(attempt: number, nextCandidate: boolean): void {
    const old = this.transport;
    if (old && old.state !== 'closed') old.close();
    const t = this.opts.connect(attempt, nextCandidate);
    this.transport = t;
    this.handles = new HandleTableIn();
    const out = this.opts.onFrameOut;
    const sendVia: Transport = out
      ? {
          kind: t.kind,
          get state() {
            return t.state;
          },
          get bufferedAmount() {
            return t.bufferedAmount;
          },
          setHandler: (h) => t.setHandler(h),
          send: (f) => {
            out(f.slice());
            t.send(f);
          },
          close: (c, r) => t.close(c, r),
        }
      : t;
    this.sender = new Sender(sendVia, this.opts.sender);
    t.setHandler({
      open: () => {
        if (this.transport === t) this.enter((s) => s.transportOpen());
      },
      frame: (bytes) => {
        if (this.transport !== t) return;
        const res = decodeFrame(bytes, { source: 'server', handles: this.handles });
        this.enter((s) => (res.ok ? s.messages(res.messages as ServerMessage[]) : s.malformed(res.error)));
      },
      close: (info: CloseInfo) => {
        if (this.transport !== t) return;
        this.enter((s) => s.transportClosed(info));
      },
    });
    if (t.state === 'open') {
      // Created open (the loopback): the open event will not come.
      this.opts.scheduler.setTimer(0, () => {
        if (this.transport === t) this.enter((s) => s.transportOpen());
      });
    }
  }

  private arm(): void {
    this.opts.scheduler.clearTimer(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const at = this.session.nextDeadline();
    if (at === null) return;
    this.timer = this.opts.scheduler.setTimer(Math.max(0, at - this.opts.scheduler.now()), () => {
      this.timer = null;
      this.enter(() => undefined);
    });
  }
}

/**
 * What a gateway's driver asks of its host (the directory, the shard, the account store). The two checks are
 * answered by calling `driver.authResult` / `driver.resumeResult` when the answer is known (at once, after a
 * database round trip, or never for a socket that closes first).
 */
export interface ServerHost {
  verifyAuth(req: { accountId: string; signature: Uint8Array; nonce: Uint8Array; serverId: string; build: string }, driver: ServerDriver): void;
  resume(req: { session: string; relevantSeq: number | null }, driver: ServerDriver): void;
  /** A client message for the universe (inputs: the accepted samples). */
  forward(message: ClientMessage, driver: ServerDriver): void;
  /** The socket was lost (declared loss or closed): U16 applies to the pilot. */
  lost?(info: CloseInfo, driver: ServerDriver): void;
  phase?(phase: ServerPhase, driver: ServerDriver): void;
}

export interface ServerDriverOptions {
  transport: Transport;
  scheduler: Scheduler;
  config: ServerConfig;
  /** The directory up-time now, ms. */
  upMs(): number;
  host: ServerHost;
  /** Every frame received, for recorders. */
  onFrameIn?(bytes: Uint8Array): void;
  sender?: SenderOptions;
}

export class ServerDriver {
  readonly session: ServerSession;
  private readonly sender: Sender;
  private timer: TimerHandle | null = null;

  constructor(private readonly opts: ServerDriverOptions) {
    this.session = new ServerSession(opts.config, opts.scheduler.now(), opts.upMs());
    this.sender = new Sender(opts.transport, opts.sender);
    opts.transport.setHandler({
      frame: (bytes) => {
        opts.onFrameIn?.(bytes.slice());
        const res = decodeFrame(bytes, { source: 'client' });
        this.enter((s) => (res.ok ? s.messages(res.messages as ClientMessage[]) : s.malformed(res.error)));
      },
      close: (info) => this.enter((s) => s.transportClosed(info)),
    });
    this.enter(() => undefined);
  }

  get transport(): Transport {
    return this.opts.transport;
  }

  /**
   * Run any session entry point (host answers, pushes) with the clock set and the actions carried out. A call
   * made while the driver is carrying out actions (a host that answers inside `forward`) runs right after.
   */
  enter(fn: (s: ServerSession) => void): void {
    if (this.running) {
      this.deferred.push(fn);
      return;
    }
    this.running = true;
    try {
      let next: ((s: ServerSession) => void) | undefined = fn;
      while (next) {
        this.session.tick(this.opts.scheduler.now(), this.opts.upMs());
        next(this.session);
        this.run();
        next = this.deferred.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private running = false;
  private readonly deferred: ((s: ServerSession) => void)[] = [];

  /** Send a message downstream. */
  push(m: ServerMessage): void {
    this.enter((s) => s.push(m));
  }

  /** The host's answer to `verifyAuth`. */
  authResult(r: AuthResult): void {
    this.enter((s) => s.authResult(r));
  }

  /** The host's answer to `resume`. */
  resumeResult(r: ResumeResult): void {
    this.enter((s) => s.resumeResult(r));
  }

  private run(): void {
    for (const a of this.session.drain()) {
      switch (a.kind) {
        case 'send':
          for (let i = 0; i < a.records.length; i++) this.sender.pushRecord(a.records[i]!, a.keys[i] ?? null);
          break;
        case 'close':
          this.sender.flush();
          this.opts.transport.close(a.code, a.reason);
          break;
        case 'verifyAuth':
          this.opts.host.verifyAuth(a, this);
          break;
        case 'resume':
          this.opts.host.resume(a, this);
          break;
        case 'forward':
          this.opts.host.forward(a.message, this);
          break;
        case 'lost':
          this.opts.host.lost?.(a.info, this);
          break;
        case 'phase':
          this.opts.host.phase?.(a.phase, this);
          break;
      }
    }
    this.sender.flush();
    this.arm();
  }

  private arm(): void {
    this.opts.scheduler.clearTimer(this.timer);
    this.timer = null;
    const at = this.session.nextDeadline();
    if (at === null) return;
    this.timer = this.opts.scheduler.setTimer(Math.max(0, at - this.opts.scheduler.now()), () => {
      this.timer = null;
      this.enter(() => undefined);
    });
  }
}
