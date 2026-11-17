/**
 * The two ends of the pilot's inputs (ARCHITECTURE 6.2, 13.3, 16.1).
 *
 * Client: `InputWindow` numbers samples, keeps those not yet acknowledged, and builds each `input` message
 * from the newest sample plus the unacknowledged changes of the last `inputRepeatMs`; an acknowledgement
 * (applied as stamped or late) retires samples. After a resume the window is sent again (inputs in flight).
 *
 * Gateway: `InputBuffer` drops repeats, enforces the per-socket rate (`limits.inputsPerSecond`) and the stamp
 * bound (no stamp beyond clock(up) + `time.roundTripAllowance`), measures the input margin, keeps every input
 * with the tick it was applied at for `inputBufferMs` (so a gateway can reproduce what a dead shard did), and
 * builds the `inputAck` sent with the next key or delta: seq ranges applied as stamped, one entry per late
 * input.
 */
import type { InputAckMessage, InputMessage, InputSample, WireControls } from '@/core/contracts/net';
import { TICKS_PER_SECOND, WIRE_CONSTANTS } from '@/core/contracts/net';
import type { Vec3 } from '@/core/math/vec3';
import { RateWindow } from './limits';

/** The repeat window in ticks. */
const REPEAT_TICKS = Math.round((WIRE_CONSTANTS.inputRepeatMs * TICKS_PER_SECOND) / 1000);

export class InputWindow {
  private nextSeq: number;
  private unacked: InputSample[] = [];
  /** Late applications the server reported: seq -> applied tick. */
  readonly lateApplied = new Map<number, number>();

  constructor(firstSeq = 1) {
    this.nextSeq = firstSeq;
  }

  /** Record the controls set at `applyTick`; returns the sample. */
  add(controls: WireControls, applyTick: number, sasHold: Vec3 | null): InputSample {
    const s: InputSample = { seq: this.nextSeq++, applyTick, ...pickControls(controls), sasHold: sasHold ? { ...sasHold } : null };
    this.unacked.push(s);
    return s;
  }

  /** The `input` message to send now: unacknowledged samples within the repeat window of the newest, oldest first. */
  message(): InputMessage | null {
    if (this.unacked.length === 0) return null;
    const newest = this.unacked[this.unacked.length - 1]!.applyTick;
    const samples = this.unacked.filter((s) => s.applyTick >= newest - REPEAT_TICKS).slice(-64);
    return { type: 'input', samples };
  }

  /** Every unacknowledged sample (sent again after a resume, within the 64 a message holds). */
  resendMessage(): InputMessage | null {
    if (this.unacked.length === 0) return null;
    return { type: 'input', samples: this.unacked.slice(-64) };
  }

  /** Apply an acknowledgement. */
  acknowledge(ack: InputAckMessage): void {
    const done = new Set<number>();
    for (const r of ack.stamped) for (let s = r.from; s <= r.to; s++) done.add(s);
    for (const l of ack.late) {
      done.add(l.seq);
      this.lateApplied.set(l.seq, l.appliedTick);
    }
    if (done.size) this.unacked = this.unacked.filter((s) => !done.has(s.seq));
  }

  get pending(): readonly InputSample[] {
    return this.unacked;
  }

  /** The sequence number the next sample gets. */
  get next(): number {
    return this.nextSeq;
  }
}

function pickControls(c: WireControls): WireControls {
  return { throttle: c.throttle, pitch: c.pitch, yaw: c.yaw, roll: c.roll, tx: c.tx, ty: c.ty, tz: c.tz };
}

/** Why the gateway dropped an input sample. */
export type InputDrop = 'repeat' | 'rate' | 'future';

interface Buffered {
  sample: InputSample;
  receivedMs: number;
  /** The tick the shard applied it at; null until it says. */
  appliedTick: number | null;
  /** Reported in an acknowledgement already. */
  acked: boolean;
}

export interface InputBufferStats {
  accepted: number;
  dropped: Record<InputDrop, number>;
}

export class InputBuffer {
  private lastSeq = 0;
  private readonly buffer: Buffered[] = [];
  private readonly rate: RateWindow;
  private margins: { atMs: number; ms: number }[] = [];
  private marginChanged = false;
  readonly stats: InputBufferStats = { accepted: 0, dropped: { repeat: 0, rate: 0, future: 0 } };

  constructor(inputsPerSecond: number) {
    this.rate = new RateWindow(inputsPerSecond, 1000);
  }

  setRate(inputsPerSecond: number): void {
    this.rate.max = inputsPerSecond;
  }

  /**
   * Take the samples of an `input` message that arrived at `nowMs`, when the pilot's clock stood at
   * `clockTick` (running at `rate`) and stamps up to `stampLimitTick` are admitted. Returns the accepted
   * samples, in order, for the shard.
   */
  accept(msg: InputMessage, nowMs: number, clockTick: number, rate: number, stampLimitTick: number): InputSample[] {
    const out: InputSample[] = [];
    for (const s of msg.samples) {
      if (s.seq <= this.lastSeq) {
        this.stats.dropped.repeat++;
        continue;
      }
      if (s.applyTick > stampLimitTick) {
        this.stats.dropped.future++;
        this.lastSeq = s.seq;
        continue;
      }
      if (!this.rate.admit(nowMs)) {
        this.stats.dropped.rate++;
        this.lastSeq = s.seq;
        continue;
      }
      this.lastSeq = s.seq;
      this.stats.accepted++;
      this.buffer.push({ sample: s, receivedMs: nowMs, appliedTick: null, acked: false });
      const perTick = rate > 0 ? 1000 / (TICKS_PER_SECOND * rate) : 0;
      this.margins.push({ atMs: nowMs, ms: Math.round((s.applyTick - clockTick) * perTick * 10) / 10 });
      this.marginChanged = true;
      out.push(s);
    }
    return out;
  }

  /** The shard applied input `seq` at `tick`. */
  applied(seq: number, tick: number): void {
    const b = this.buffer.find((x) => x.sample.seq === seq);
    if (b && b.appliedTick === null) b.appliedTick = tick;
  }

  /** The smallest margin of the last second, ms (null without inputs in it). */
  marginMs(nowMs: number): number | null {
    this.margins = this.margins.filter((m) => m.atMs > nowMs - 1000);
    if (this.margins.length === 0) return null;
    let min = Infinity;
    for (const m of this.margins) min = Math.min(min, m.ms);
    return min;
  }

  /** True when something is to be acknowledged (an application or a new margin). */
  hasAck(): boolean {
    return this.marginChanged || this.buffer.some((b) => b.appliedTick !== null && !b.acked);
  }

  /** The acknowledgement of every application not yet reported, with the margin; null when there is none. */
  takeAck(nowMs: number): InputAckMessage | null {
    if (!this.hasAck()) return null;
    this.marginChanged = false;
    const stamped: { from: number; to: number }[] = [];
    const late: { seq: number; appliedTick: number }[] = [];
    for (const b of this.buffer) {
      if (b.appliedTick === null || b.acked) continue;
      b.acked = true;
      const seq = b.sample.seq;
      if (b.appliedTick === b.sample.applyTick) {
        const last = stamped[stamped.length - 1];
        if (last && last.to === seq - 1) last.to = seq;
        else stamped.push({ from: seq, to: seq });
      } else late.push({ seq, appliedTick: b.appliedTick });
    }
    return { type: 'inputAck', marginMs: this.marginMs(nowMs), stamped, late };
  }

  /** Forget inputs older than the buffer's span. */
  prune(nowMs: number): void {
    const from = nowMs - WIRE_CONSTANTS.inputBufferMs;
    let drop = 0;
    while (drop < this.buffer.length && this.buffer[drop]!.receivedMs < from) drop++;
    if (drop) this.buffer.splice(0, drop);
  }

  /** The inputs of the last `inputBufferMs` with the ticks they were applied at (what a recovering shard replays). */
  retained(): readonly { sample: InputSample; appliedTick: number | null }[] {
    return this.buffer.map((b) => ({ sample: b.sample, appliedTick: b.appliedTick }));
  }

  /** The last sequence number seen (a resumed session continues after it). */
  get lastSeen(): number {
    return this.lastSeq;
  }
}
