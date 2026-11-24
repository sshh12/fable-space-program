/**
 * The real-time loop of a session: how much of a frame's wall time becomes ticks (`FlightSession.advance`).
 * At physics warp the frame's time is spent in whole steps, at most a fixed number per frame (the surplus is
 * dropped: slow motion, never a bigger step); at rails warp the state lands on the first whole tick at or
 * after the presentation time. The rest of a tick is the presentation LAG the view interpolates over. It is
 * a session's pacing, not a host's stepping: `LocalSession` takes it over (MIGRATION_V2 step 4.3).
 */
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT } from '@/core/contracts/defs';
import { CONTROL_TICK_STEPS } from '@/core/contracts/sim';
import { TICK_EPSILON, TICKS_PER_SECOND } from '../clock';
import { warpFactor } from '../orbit/warp';

/** Physics steps per frame allowed at 1x (multiplied by the warp factor). */
export const MAX_STEPS_PER_FRAME_1X = 16;

/** The clock a pacer drives. */
export interface PacedClock {
  readonly tick: number;
  /** The warp level in force, after `refresh`. */
  readonly warpIndex: number;
  /** Bring the plan and the warp limits up to date (the level may step down). */
  refresh(): void;
  step(): void;
  /** Rails advance to a tick; the state may land earlier (on an event's tick) or not move at all (an event is due). */
  advanceRailsToTick(tick: number): void;
}

export class FramePacer {
  /** Presentation lag behind the state, s in [0, PHYSICS_DT). */
  lag = 0;

  constructor(private readonly c: PacedClock) {}

  /**
   * One frame of rails warp: presentation time moves on by `seconds` and the state lands on the first whole
   * tick at or after it (the rest of that tick is the presentation lag, exactly as after physics steps), or
   * on the tick of the next event. False when no time could pass on rails.
   */
  private railsFrame(seconds: number): boolean {
    const c = this.c;
    // Ticks from the state to the new presentation time (the state is ahead of the presentation by the lag).
    const ahead = (seconds - this.lag) * TICKS_PER_SECOND;
    if (ahead <= TICK_EPSILON) {
      this.lag = Math.max(0, this.lag - seconds);
      return true;
    }
    const n = Math.ceil(ahead - TICK_EPSILON);
    const before = c.tick;
    c.advanceRailsToTick(before + n);
    if (c.tick === before) return false;
    // Landed on the requested tick: the state leads the presentation by the rest of that tick. Stopped
    // earlier, on an event's tick: the presentation is at the state.
    this.lag = c.tick === before + n ? Math.max(0, (n - ahead) / TICKS_PER_SECOND) : 0;
    return true;
  }

  /** Advance by `realDt` seconds of wall time at the warp level in force. `onControlTick` is called when a control tick is due. */
  advance(realDt: number, onControlTick?: () => void): void {
    const c = this.c;
    const dtReal = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    c.refresh();
    // A control tick is due before every CONTROL_TICK_STEPS-th physics step and before each rails advance.
    let tickGiven = false;
    if (c.warpIndex > MAX_PHYSICS_WARP_INDEX) {
      onControlTick?.();
      tickGiven = true;
      c.refresh();
    }
    if (c.warpIndex > MAX_PHYSICS_WARP_INDEX) {
      if (dtReal === 0 || this.railsFrame(dtReal * warpFactor(c.warpIndex))) return;
      // No progress on rails (an event is due): the frame is spent in physics steps at the clamped level.
    }
    const factor = warpFactor(c.warpIndex);
    this.lag -= dtReal * factor;
    const maxSteps = MAX_STEPS_PER_FRAME_1X * factor;
    let n = 0;
    // (A remainder within rounding of a whole step is no step: 8 x 1/120 s must cover 4 x 1/60 s.)
    while (this.lag < -1e-12) {
      if (n >= maxSteps) {
        // Surplus is dropped (slow motion), never a bigger step.
        this.lag = 0;
        break;
      }
      if (c.tick % CONTROL_TICK_STEPS === 0) {
        if (!tickGiven) onControlTick?.();
        if (c.warpIndex > MAX_PHYSICS_WARP_INDEX) {
          // Rails warp was engaged in the control tick: the rest of this frame's time is spent on rails.
          c.refresh();
          if (c.warpIndex > MAX_PHYSICS_WARP_INDEX) {
            const owed = this.lag;
            this.lag = 0;
            if (this.railsFrame((-owed / factor) * warpFactor(c.warpIndex))) return;
            this.lag = owed;
          }
        }
      }
      tickGiven = false;
      c.step();
      this.lag += PHYSICS_DT;
      n++;
    }
    if (this.lag < 0) this.lag = 0;
  }
}
