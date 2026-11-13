/**
 * Main-thread time of the app's frame function, of its stages and of every render feature's hooks, as rolling
 * windows (ARCHITECTURE 17: CPU main thread per frame p99 <= 6 ms; sim <= 1.5 ms at 4x physics warp; UI <= 0.5 ms).
 *
 * The render core's `PerfSnapshot.features[*].cpuMs` is a p99 per feature over its own window: it says which
 * feature is expensive, not what a slow frame was made of. For the attribution of the budget misses the app
 * measures every hook call itself (featureTiming.ts wraps the features at the contract) and keeps
 *  - a window per feature (`stats().features`),
 *  - the slowest frames since the last reset with their whole breakdown (`slowest()`): stages, features, hooks,
 *    the frame's number and a note of the app (throttle, thrust, warp), and
 *  - on request a trace of consecutive frames (`startTrace` / `takeTrace`) for a time series across an event
 *    such as an engine start.
 * `core` in the per-feature numbers is the render stage minus the features' hooks: the render core's own work.
 */

export const FRAME_STAGES = ['input', 'map', 'controls', 'sim', 'views', 'hud', 'audio', 'render'] as const;
export type FrameStage = (typeof FRAME_STAGES)[number];

const WINDOW = 300;
/** Slowest frames kept with their breakdown. */
const SLOWEST = 12;
const TRACE_MAX = 4000;

export interface WindowStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

/** One frame's main-thread time, ms. */
export interface FrameBreakdown {
  /** Frames presented before this one. */
  frame: number;
  total: number;
  stages: Record<FrameStage, number>;
  /** Per render feature (all hooks), plus `core` = the render stage minus the features. */
  features: Record<string, number>;
  /** Per `<feature>.<hook>`, hooks of 0.05 ms or more. */
  hooks: Record<string, number>;
  /** What the app noted about the frame (throttle, thrust, warp, view). */
  note: string;
}

export interface FrameTrace {
  /** First frame of the trace. */
  firstFrame: number;
  /** Per frame: the whole frame function and the stages render, sim, hud and audio, ms. */
  total: number[];
  render: number[];
  sim: number[];
  hud: number[];
  audio: number[];
  /** Per feature id (and `core`): ms per frame. */
  features: Record<string, number[]>;
  notes: string[];
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
  /** A render feature's hook (`key` = `<featureId>.<hook>`) ran for `ms` in this frame (featureTiming.ts). */
  hook(featureId: string, key: string, ms: number): void;
  /** End of the frame function; `note` is called only for a frame that is kept (a slow one, or a traced one). */
  end(frame: number, note: () => string): void;
  reset(): void;
  /** p50 / p95 / p99 / max over the last 300 frames, ms: the whole frame function, every stage, every feature. */
  stats(): { frame: WindowStats; stages: Record<FrameStage, WindowStats>; features: Record<string, WindowStats> };
  /** The slowest frames since the last reset, slowest first. */
  slowest(): FrameBreakdown[];
  /**
   * The display's frame intervals: `ms` between this frame's requestAnimationFrame time and the one before
   * (the callback's own time stamp, which steps by whole display periods: an interval of two periods IS a
   * frame the display showed twice). Kept since the last reset, the last 8192 at most.
   */
  interval(ms: number): void;
  intervals(): number[];
  /** Record every frame from now on (at most `frames`, 4000 at most) until `takeTrace`. */
  startTrace(frames: number): void;
  takeTrace(): FrameTrace | null;
}

/** Frame intervals kept since the last reset (at 60 Hz: the last 2.3 minutes). */
const INTERVALS = 8192;

export function createFrameTimings(): FrameTimings {
  const frame = new RollingWindow();
  const stages = Object.fromEntries(FRAME_STAGES.map((s) => [s, new RollingWindow()])) as Record<FrameStage, RollingWindow>;
  const features = new Map<string, RollingWindow>();
  const current = new Map<FrameStage, number>();
  const hooks = new Map<string, number>();
  const perFeature = new Map<string, number>();
  let slow: FrameBreakdown[] = [];
  // The display's frame intervals since the last reset: a ring of the last INTERVALS.
  const intervalRing = new Float64Array(INTERVALS);
  let intervalCount = 0;
  let intervalNext = 0;
  let trace: (FrameTrace & { limit: number }) | null = null;
  let t0 = 0;
  let tLast = 0;

  const windowOf = (id: string): RollingWindow => {
    let w = features.get(id);
    if (!w) {
      w = new RollingWindow();
      features.set(id, w);
    }
    return w;
  };

  return {
    begin() {
      t0 = performance.now();
      tLast = t0;
      current.clear();
      hooks.clear();
      perFeature.clear();
    },
    mark(stage) {
      const t = performance.now();
      current.set(stage, (current.get(stage) ?? 0) + t - tLast);
      tLast = t;
    },
    hook(featureId, key, ms) {
      hooks.set(key, (hooks.get(key) ?? 0) + ms);
      perFeature.set(featureId, (perFeature.get(featureId) ?? 0) + ms);
    },
    end(frameNumber, note) {
      const total = performance.now() - t0;
      frame.push(total);
      for (const s of FRAME_STAGES) stages[s].push(current.get(s) ?? 0);
      let hooked = 0;
      for (const ms of perFeature.values()) hooked += ms;
      const core = Math.max(0, (current.get('render') ?? 0) - hooked);
      for (const id of features.keys()) if (id !== 'core' && !perFeature.has(id)) features.get(id)!.push(0);
      for (const [id, ms] of perFeature) windowOf(id).push(ms);
      windowOf('core').push(core);

      const keep = slow.length < SLOWEST || total > slow[slow.length - 1]!.total;
      if (keep || trace) {
        const text = note();
        if (keep) {
          const b: FrameBreakdown = {
            frame: frameNumber,
            total,
            stages: Object.fromEntries(FRAME_STAGES.map((s) => [s, current.get(s) ?? 0])) as Record<FrameStage, number>,
            features: { ...Object.fromEntries(perFeature), core },
            hooks: Object.fromEntries([...hooks].filter(([, ms]) => ms >= 0.05)),
            note: text,
          };
          slow.push(b);
          slow.sort((a, c) => c.total - a.total);
          if (slow.length > SLOWEST) slow.length = SLOWEST;
        }
        if (trace && trace.total.length < trace.limit) {
          if (trace.total.length === 0) trace.firstFrame = frameNumber;
          const i = trace.total.length;
          trace.total.push(total);
          trace.render.push(current.get('render') ?? 0);
          trace.sim.push(current.get('sim') ?? 0);
          trace.hud.push(current.get('hud') ?? 0);
          trace.audio.push(current.get('audio') ?? 0);
          trace.notes.push(text);
          for (const [id, ms] of [...perFeature, ['core', core] as [string, number]]) {
            const column = (trace.features[id] ??= []);
            while (column.length < i) column.push(0);
            column.push(ms);
          }
        }
      }
    },
    reset() {
      frame.clear();
      for (const s of FRAME_STAGES) stages[s].clear();
      for (const w of features.values()) w.clear();
      slow = [];
      intervalCount = 0;
      intervalNext = 0;
    },
    interval(ms) {
      intervalRing[intervalNext] = ms;
      intervalNext = (intervalNext + 1) % INTERVALS;
      if (intervalCount < INTERVALS) intervalCount++;
    },
    intervals() {
      const out: number[] = [];
      const first = (intervalNext - intervalCount + INTERVALS) % INTERVALS;
      for (let i = 0; i < intervalCount; i++) out.push(intervalRing[(first + i) % INTERVALS]!);
      return out;
    },
    stats() {
      return {
        frame: frame.stats(),
        stages: Object.fromEntries(FRAME_STAGES.map((s) => [s, stages[s].stats()])) as Record<FrameStage, WindowStats>,
        features: Object.fromEntries([...features].map(([id, w]) => [id, w.stats()])),
      };
    },
    slowest: () => slow.map((b) => ({ ...b, stages: { ...b.stages }, features: { ...b.features }, hooks: { ...b.hooks } })),
    startTrace(frames) {
      trace = { firstFrame: 0, total: [], render: [], sim: [], hud: [], audio: [], features: {}, notes: [], limit: Math.max(1, Math.min(TRACE_MAX, Math.floor(frames))) };
    },
    takeTrace() {
      if (!trace) return null;
      const { limit: _limit, ...out } = trace;
      const n = out.total.length;
      for (const column of Object.values(out.features)) while (column.length < n) column.push(0);
      trace = null;
      return out;
    },
  };
}
