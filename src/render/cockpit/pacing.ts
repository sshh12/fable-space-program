/**
 * When each display is painted (the lead's rule of visual round 5, request app-integration-12):
 *
 *  1. A display showing a FAST page (flight data a pilot flies by: attitude, rates, speeds, altitude; the
 *     layout's `displays.fastPages`) is painted `rateHz` times a second or better whenever a camera can read
 *     the screens, whatever the page costs to paint.
 *  2. A display showing any other page is painted `rateHz` times a second when that fits, and less often when
 *     its page is dear: the slow displays share what the fast ones leave of `cpuBudget` (main-thread
 *     milliseconds per second of wall time for all displays together), by their typical paint cost, but never
 *     fall under `slowMinHz`.
 *  3. One paint per frame: a paint is half a millisecond and more of main thread. The one exception: a fast
 *     page whose slot came a whole frame ago (two slots fell into one frame, or the frame rate is too low to
 *     give every display a frame of its own) is painted in the same frame as another display. A fast page's
 *     slots keep their cadence however late a paint was, so its rate does not drift down.
 *  4. Nothing is painted while no camera can read the screens; every display is then repainted within
 *     `count` frames of the cabin coming back into view.
 *
 * Pure (no GPU, no clock): MfdDisplays feeds it the time and the measured cost of each paint.
 */

export interface PacingRule {
  /** Paints per second of a display at the plain rate. */
  rateHz: number;
  /** Pages painted at `rateHz` or better whatever they cost. */
  fastPages: readonly string[];
  /** Main-thread time all displays together may take, ms per second of wall time. */
  cpuBudget: number;
  /** A slow page is never painted less often than this, Hz. */
  slowMinHz: number;
}

/** Paints whose cost is remembered per display; their median is the page's typical cost once there are three. */
const COST_WINDOW = 5;

export class DisplayPacer {
  private readonly next: number[] = [];
  private readonly costs: number[][] = [];
  private readonly pages: (string | null)[] = [];
  private readonly dirty = new Set<number>();
  private readonly period: number;
  /** Time of the previous frame in which the screens could be read (the frame time comes from it). */
  private lastTime = -Infinity;

  constructor(
    readonly count: number,
    readonly rule: PacingRule,
  ) {
    this.period = 1 / rule.rateHz;
    for (let i = 0; i < count; i++) {
      // Staggered: display i first paints i / count of a period after start.
      this.next.push((i / count) * this.period);
      this.costs.push([]);
      this.pages.push(null);
      this.dirty.add(i);
    }
  }

  isFast(page: string): boolean {
    return this.rule.fastPages.includes(page);
  }

  /** A display must be repainted on the next frame (a page change). */
  markDirty(display: number): void {
    this.dirty.add(display);
  }

  /** Whether a display still waits for its first paint of what it shows now. */
  hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * Back to "nothing painted" (the frame-exact capture's restart, RENDER_API section 13): every display is
   * dirty, the slots are staggered from time 0 as at construction, and the measured costs are forgotten (they
   * are wall-clock knowledge: a slow page's interval follows them). What is painted in which frame after this
   * is a function of the times and pages given from here on.
   */
  reset(): void {
    this.lastTime = -Infinity;
    for (let i = 0; i < this.count; i++) {
      this.next[i] = (i / this.count) * this.period;
      this.costs[i]!.length = 0;
      this.dirty.add(i);
    }
  }

  /** No camera can read the screens this frame: every display is repainted when one can again. */
  hidden(): void {
    for (let i = 0; i < this.count; i++) this.dirty.add(i);
  }

  /** Typical main-thread cost of a paint of display i's current page (ms; 0 = not known yet). */
  typicalCost(i: number): number {
    const recent = this.costs[i]!;
    return recent.length >= 3 ? [...recent].sort((a, b) => a - b)[recent.length >> 1]! : 0;
  }

  /** Seconds between two paints of display i showing `page` (rules 1 and 2). */
  interval(i: number, page: string, pageOf: (display: number) => string): number {
    if (this.isFast(page)) return this.period;
    const typical = this.typicalCost(i);
    if (typical <= 0) return this.period;
    let fastLoad = 0;
    let slow = 0;
    for (let k = 0; k < this.count; k++) {
      if (this.isFast(pageOf(k))) fastLoad += this.typicalCost(k) * this.rule.rateHz;
      else slow++;
    }
    const share = Math.max(0, this.rule.cpuBudget - fastLoad) / Math.max(1, slow);
    const paced = share > 0 ? typical / share : Infinity;
    return Math.min(1 / this.rule.slowMinHz, Math.max(this.period, paced));
  }

  /** The displays to paint in the frame at `time` (seconds), in order (rules 3 and 4). */
  due(time: number, pageOf: (display: number) => string): number[] {
    const out: number[] = [];
    for (const i of this.dirty) {
      out.push(i);
      break;
    }
    if (out.length === 0) {
      let best = -1;
      for (let i = 0; i < this.count; i++) if (time >= this.next[i]! && (best < 0 || this.next[i]! < this.next[best]!)) best = i;
      if (best >= 0) out.push(best);
    }
    // A fast page that has already waited a frame for its slot does not wait for a frame of its own.
    const dt = time - this.lastTime;
    this.lastTime = time;
    for (let i = 0; i < this.count; i++) {
      if (!out.includes(i) && this.isFast(pageOf(i)) && time - this.next[i]! >= dt * 0.999) out.push(i);
    }
    return out;
  }

  /** Display i was painted at `time` showing `page`, at a main-thread cost of `costMs`. */
  painted(i: number, time: number, page: string, costMs: number, pageOf: (display: number) => string): void {
    this.dirty.delete(i);
    const recent = this.costs[i]!;
    // A page other than the one painted last starts from the plain rate (its cost is not known yet).
    if (this.pages[i] !== page) recent.length = 0;
    this.pages[i] = page;
    recent.push(costMs);
    if (recent.length > COST_WINDOW) recent.shift();
    const interval = this.interval(i, page, pageOf);
    // A fast page keeps its cadence (the next slot is one period after this one, however late the paint was)
    // unless it fell more than two periods behind (the screens were out of view); a slow page's next paint is
    // at least half its interval away.
    if (this.isFast(page)) this.next[i] = time - this.next[i]! > 2 * interval ? time + interval : this.next[i]! + interval;
    else this.next[i] = Math.max(this.next[i]! + interval, time + interval * 0.5);
  }
}
