/**
 * The injector as a transport wrapper: frames this side sends travel through the `up` delay line before the
 * inner transport sends them; frames the inner transport receives travel through the `down` line before the
 * handler sees them. Scriptable from tests: change a direction's profile, start a stall, drop the connection,
 * or give a timed script. Every frame's scripted arrival is recorded (`log`), so a test can measure how
 * closely the real timers reproduced the profile.
 *
 * Frames waiting in the `up` line count in `bufferedAmount`, as bytes in a stalled socket's buffer would, so
 * a sender above it backs off during a stall exactly as against a real one.
 */
import type { Scheduler, TimerHandle } from '../time/scheduler';
import type { CloseInfo, Transport, TransportHandler, TransportState } from '../transport/types';
import { CLOSE } from '../transport/types';
import { DelayLine, type DirectionProfile, type InjectorProfile, type ScheduledUnit } from './model';

export type Direction = 'up' | 'down';

/** One step of an injector script, `atMs` after the injector was made. */
export type InjectorStep =
  | { atMs: number; kind: 'set'; dir: Direction | 'both'; profile: Partial<DirectionProfile> }
  | { atMs: number; kind: 'stall'; dir: Direction | 'both'; ms: number }
  /** Drop the connection without a close handshake (code 1006 on this side). */
  | { atMs: number; kind: 'disconnect' };

export interface LoggedUnit extends ScheduledUnit {
  dir: Direction;
  bytes: number;
  /** When it actually reached the other side of the wrapper (the scheduler's clock), ms; null while in flight. */
  deliveredMs: number | null;
}

export class InjectedTransport implements Transport {
  readonly kind: string;
  private handler: TransportHandler | null = null;
  private readonly up: DelayLine;
  private readonly down: DelayLine;
  private upBytes = 0;
  private dropped = false;
  private closedInfo: CloseInfo | null = null;
  private readonly timers = new Set<TimerHandle>();
  private lastDownArrive = -Infinity;
  private lastUpArrive = -Infinity;
  /** Every frame through the wrapper, both ways, with its scripted and its real arrival (only with `logUnits`). */
  readonly log: LoggedUnit[] = [];
  private readonly t0: number;
  private readonly logUnits: boolean;

  constructor(
    private readonly inner: Transport,
    profile: InjectorProfile,
    private readonly scheduler: Scheduler,
    script: readonly InjectorStep[] = [],
    opts: { logUnits?: boolean } = {},
  ) {
    this.logUnits = opts.logUnits ?? false;
    this.kind = `injected(${inner.kind})`;
    this.up = new DelayLine({ ...profile.up }, profile.seed * 2 + 1);
    this.down = new DelayLine({ ...profile.down }, profile.seed * 2 + 2);
    this.t0 = scheduler.now();
    inner.setHandler({
      open: () => this.handler?.open?.(),
      frame: (bytes) => this.receive(bytes),
      close: (info) => this.innerClosed(info),
    });
    for (const step of script) this.at(step.atMs, () => this.apply(step));
  }

  get state(): TransportState {
    if (this.dropped || this.closedInfo) return 'closed';
    return this.inner.state;
  }

  get bufferedAmount(): number {
    return this.inner.bufferedAmount + this.upBytes;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(frame: Uint8Array): void {
    if (this.state !== 'open') return;
    const copy = frame.slice();
    const now = this.scheduler.now();
    const unit = this.up.schedule(copy.length, now);
    const entry: LoggedUnit | null = this.logUnits ? { ...unit, dir: 'up', bytes: copy.length, deliveredMs: null } : null;
    if (entry) this.log.push(entry);
    this.lastUpArrive = unit.arriveMs;
    this.upBytes += copy.length;
    this.after(unit.arriveMs - now, () => {
      this.upBytes -= copy.length;
      if (entry) entry.deliveredMs = this.scheduler.now();
      if (!this.dropped) this.inner.send(copy);
    });
  }

  close(code: number = CLOSE.normal, reason = ''): void {
    if (this.state === 'closed') return;
    // Frames already in the up line leave first, as on a socket that is closed after its last write.
    const wait = Math.max(0, this.lastUpArrive - this.scheduler.now());
    this.after(wait, () => this.inner.close(code, reason));
  }

  /** Change one direction's profile from now on. */
  setProfile(dir: Direction | 'both', p: Partial<DirectionProfile>): void {
    if (dir !== 'down') Object.assign(this.up.profile, p);
    if (dir !== 'up') Object.assign(this.down.profile, p);
  }

  /** Start a stall of `ms` now. */
  stall(dir: Direction | 'both', ms: number): void {
    const now = this.scheduler.now();
    if (dir !== 'down') this.up.stall(now, ms);
    if (dir !== 'up') this.down.stall(now, ms);
  }

  /** Drop the connection as a network failure would: frames in flight are lost, this side sees code 1006. */
  disconnect(): void {
    if (this.dropped) return;
    this.dropped = true;
    for (const t of this.timers) this.scheduler.clearTimer(t);
    this.timers.clear();
    this.upBytes = 0;
    const lossy = this.inner as Transport & { fail?: () => void };
    if (typeof lossy.fail === 'function') lossy.fail();
    else this.inner.close(CLOSE.abnormal, 'injected disconnect');
    this.finish({ code: CLOSE.abnormal, reason: 'injected disconnect', clean: false });
  }

  private receive(bytes: Uint8Array): void {
    if (this.dropped) return;
    const now = this.scheduler.now();
    const unit = this.down.schedule(bytes.length, now);
    const entry: LoggedUnit | null = this.logUnits ? { ...unit, dir: 'down', bytes: bytes.length, deliveredMs: null } : null;
    if (entry) this.log.push(entry);
    this.lastDownArrive = unit.arriveMs;
    this.after(unit.arriveMs - now, () => {
      if (entry) entry.deliveredMs = this.scheduler.now();
      if (!this.dropped) this.handler?.frame(bytes);
    });
  }

  private innerClosed(info: CloseInfo): void {
    if (this.dropped) return;
    // The close follows the frames that arrived before it (TCP: the FIN comes after the data).
    const wait = Math.max(0, this.lastDownArrive - this.scheduler.now());
    this.after(wait, () => this.finish(info));
  }

  private finish(info: CloseInfo): void {
    if (this.closedInfo) return;
    this.closedInfo = info;
    this.handler?.close(info);
  }

  private apply(step: InjectorStep): void {
    if (step.kind === 'set') this.setProfile(step.dir, step.profile);
    else if (step.kind === 'stall') this.stall(step.dir, step.ms);
    else this.disconnect();
  }

  private at(atMs: number, fn: () => void): void {
    this.after(this.t0 + atMs - this.scheduler.now(), fn);
  }

  private after(delayMs: number, fn: () => void): void {
    const h = this.scheduler.setTimer(Math.max(0, delayMs), () => {
      this.timers.delete(h);
      fn();
    });
    this.timers.add(h);
  }
}

/** Wrap a transport in the injector. */
export function injectTransport(inner: Transport, profile: InjectorProfile, scheduler: Scheduler, script: readonly InjectorStep[] = [], opts: { logUnits?: boolean } = {}): InjectedTransport {
  return new InjectedTransport(inner, profile, scheduler, script, opts);
}
