/**
 * The frame-interval line of ARCHITECTURE 29 (restated by the lead on 2026-11-12), judged on the display's frame
 * intervals of one phase of a flight or one checkpoint. Pure; used by the app's perf spec and the browser mission.
 *
 * Against the harness clock measured in the same browser (its period is the nominal period: 16.67 ms on a 60 Hz
 * display; a run whose clock is not nominal is not judged at all, tests/browser/harness.ts):
 *   - the MEDIAN interval lies within 1 % of the nominal period;
 *   - DROPPED FRAMES, intervals longer than 1.5 nominal periods, are at most 0.5 % of the frames;
 *   - no frame of 33 ms or more in steady flight.
 *
 * The intervals are those of the requestAnimationFrame time stamps (`window.__app.rafIntervals()`), which step by
 * whole display periods: an interval of two periods is a frame the display showed twice. The render core's
 * `PerfSnapshot.raf` is taken where the frame is drawn, later in the frame function by however long the stages
 * before it took, so a slow frame after a fast one reads as a long interval there although no frame was dropped.
 */

/** The median may lie this share of the period off it. */
export const MEDIAN_TOLERANCE = 0.01;
/** An interval longer than this many periods is a dropped frame. */
export const DROPPED_PERIODS = 1.5;
/** The share of the frames that may be dropped. */
export const DROPPED_SHARE = 0.005;
/** No frame of this many ms or more. */
export const LONG_FRAME_MS = 33;

export interface IntervalVerdict {
  /** Intervals judged. */
  frames: number;
  /** The nominal period they were judged against, ms. */
  period: number;
  median: number;
  /** |median - period| / period. */
  medianDeviation: number;
  /** Intervals longer than DROPPED_PERIODS periods, and their share of the frames. */
  dropped: number;
  droppedShare: number;
  /** Intervals of LONG_FRAME_MS or more. */
  longFrames: number;
  /** The longest interval, ms. */
  max: number;
  /** The lines that are missed, in words (empty: the frame-interval line holds). */
  failures: string[];
}

export function medianOf(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Judge `intervals` (ms) against the nominal `period` (ms). No intervals: nothing was measured, which is a failure. */
export function judgeIntervals(intervals: readonly number[], period: number): IntervalVerdict {
  const frames = intervals.length;
  const median = medianOf(intervals);
  const medianDeviation = Math.abs(median - period) / period;
  let dropped = 0;
  let longFrames = 0;
  let max = 0;
  for (const d of intervals) {
    if (d > DROPPED_PERIODS * period) dropped++;
    if (d >= LONG_FRAME_MS) longFrames++;
    if (d > max) max = d;
  }
  const droppedShare = frames === 0 ? 0 : dropped / frames;
  const failures: string[] = [];
  if (frames === 0) failures.push('no frame interval was measured');
  else {
    if (!(medianDeviation <= MEDIAN_TOLERANCE)) failures.push(`median interval ${median.toFixed(3)} ms is ${(medianDeviation * 100).toFixed(2)} % off the nominal ${period.toFixed(3)} ms (line: within ${MEDIAN_TOLERANCE * 100} %)`);
    if (droppedShare > DROPPED_SHARE) failures.push(`${dropped} dropped frame(s) in ${frames}, ${(droppedShare * 100).toFixed(2)} % (line: at most ${DROPPED_SHARE * 100} %; the longest interval ${max.toFixed(1)} ms)`);
    if (longFrames > 0) failures.push(`${longFrames} frame(s) of ${LONG_FRAME_MS} ms or more (the longest ${max.toFixed(1)} ms; line: none)`);
  }
  return { frames, period, median, medianDeviation, dropped, droppedShare, longFrames, max, failures };
}
