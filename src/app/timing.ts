/**
 * Main-thread time of the app's frame function and of its stages, as rolling windows (ARCHITECTURE 17: CPU
 * main thread per frame p99 <= 6 ms; sim <= 1.5 ms at 4x physics warp; UI <= 0.5 ms).
 *
 * The render core's `PerfSnapshot.cpu` reports its own `core.render` zone only: it reads the frame's CPU zones
 * while `render()` is still running inside the app's frame, so a `'frame'` zone bracketing the whole app frame
 * is never complete when it is read (request app-integration-1). These windows are the app's own measurement of
 * the whole frame until that is resolved, and keep the per-stage split afterwards.
 */

export const FRAME_STAGES = ['input', 'map', 'controls', 'sim', 'views', 'hud', 'audio', 'render'] as const;
export type FrameStage = (typeof FRAME_STAGES)[number];

const WINDOW = 300;

export interface WindowStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

class RollingWindow {
  private readonly v = new Float64Array(WINDOW);
  private n = 0;
  private i = 0;
  push(x: number): void {
    this.v[this.i] = x;
    this.i = (this.i + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;
  }
  clear(): void {
    this.n = 0;
    this.i = 0;
  }
  stats(): WindowStats {
    if (this.n === 0) return { p50: 0, p95: 0, p99: 0, max: 0, count: 0 };
    const s = Array.from(this.v.subarray(0, this.n)).sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1]!, count: s.length };
  }
}

export interface FrameTimings {
  /** Start of the frame function. */
  begin(): void;
  /** End of a stage: the time since the previous mark (or the beginning) is booked to it. */
  mark(stage: FrameStage): void;
  /** End of the frame function. */
  end(): void;
  reset(): void;
  /** p50 / p95 / p99 / max over the last 300 frames, ms: the whole frame function and every stage. */
  stats(): { frame: WindowStats; stages: Record<FrameStage, WindowStats> };
}

export function createFrameTimings(): FrameTimings {
  const frame = new RollingWindow();
  const stages = Object.fromEntries(FRAME_STAGES.map((s) => [s, new RollingWindow()])) as Record<FrameStage, RollingWindow>;
  const current = new Map<FrameStage, number>();
  let t0 = 0;
  let tLast = 0;
  return {
    begin() {
      t0 = performance.now();
      tLast = t0;
      current.clear();
    },
    mark(stage) {
      const t = performance.now();
      current.set(stage, (current.get(stage) ?? 0) + t - tLast);
      tLast = t;
    },
    end() {
      const t = performance.now();
      frame.push(t - t0);
      for (const s of FRAME_STAGES) stages[s].push(current.get(s) ?? 0);
    },
    reset() {
      frame.clear();
      for (const s of FRAME_STAGES) stages[s].clear();
    },
    stats() {
      return { frame: frame.stats(), stages: Object.fromEntries(FRAME_STAGES.map((s) => [s, stages[s].stats()])) as Record<FrameStage, WindowStats> };
    },
  };
}
