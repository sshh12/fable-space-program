/**
 * Auto-exposure metering rules (ARCHITECTURE 10.4), CPU side. Pure functions: unit-tested in vitest.
 *
 * The GPU builds two 256-bin log-luminance histograms of ABSOLUTE luminance (cd/m^2) over geometry pixels
 * only (depth != 0) above an absolute floor: every such pixel, and those within INTERIOR_RANGE of the eye
 * (interior metering). This module turns a histogram into a target EV100.
 */
import type { ViewKind } from '@/core/contracts/render';

export const HISTOGRAM_BINS = 256;
/** log2(cd/m^2) of the lower edge of bin 0 and the span covered by the histogram (8 bins per EV). */
export const HISTOGRAM_MIN_LOG2 = -12;
export const HISTOGRAM_RANGE_LOG2 = 32;
/** Pixels darker than this (cd/m^2) are never metered: unlit sides, deep shadow in vacuum. */
export const LUMINANCE_FLOOR = 0.008;
/** Pixels more than this many EV below the brightest lit pixels are not part of the lit range either. */
export const LIT_RANGE_EV = 10;
/** Geometry nearer than this (m) is "interior" for CameraState.kind === 'interior'. */
export const INTERIOR_RANGE = 8;
export const MID_GREY = 0.18;
/** exposure = 1 / (EXPOSURE_K * 2^EV100). */
export const EXPOSURE_K = 1.2;
export const EV_MIN = -3;
export const EV_MAX = 16.5;
/** Dark-adapted floor: the exposure of a frame with nothing lit in it (stars and the Milky Way visible). */
export const EV_DARK_FLOOR = -3;
/** Below this lit fraction of the frame the photometric prior is used alone; above LIT_FULL the histogram alone. */
export const LIT_PRIOR_ONLY = 0.005;
export const LIT_FULL = 0.1;
/** Any lit geometry at all (fraction of the frame) counts as "something lit is in view" for the prior. */
export const LIT_PRESENT = 0.0002;
/** The 99th percentile of lit pixels is kept below this multiple of mid-grey (highlight protection). */
export const HIGHLIGHT_CAP = 4;
/** Adaptation speed, EV per second: fast when the scene gets brighter, slower when it gets darker. */
export const ADAPT_UP = 2.5;
export const ADAPT_DOWN = 0.8;

export const exposureFromEv100 = (ev100: number): number => 1 / (EXPOSURE_K * 2 ** ev100);
/** EV100 that renders luminance L (cd/m^2) at mid-grey. */
export const ev100ForMidGrey = (luminance: number): number => Math.log2(Math.max(luminance, 1e-9) / (MID_GREY * EXPOSURE_K));
/**
 * Sunny-16 for an illuminance E (lux): the EV100 at which a sunlit 18 % Lambert surface renders at 0.18.
 * 128,000 lux -> EV 15.05; 100,000 lux at the ground -> EV 14.7.
 */
export const sunny16Ev = (illuminance: number): number => Math.log2(Math.max(illuminance, 1e-9) / (Math.PI * EXPOSURE_K));

export const binLuminance = (bin: number): number => 2 ** (HISTOGRAM_MIN_LOG2 + ((bin + 0.5) / HISTOGRAM_BINS) * HISTOGRAM_RANGE_LOG2);
export const luminanceBin = (l: number): number =>
  Math.max(0, Math.min(HISTOGRAM_BINS - 1, Math.floor(((Math.log2(Math.max(l, 1e-12)) - HISTOGRAM_MIN_LOG2) / HISTOGRAM_RANGE_LOG2) * HISTOGRAM_BINS)));

export interface HistogramStats {
  /** Lit pixels (inside the lit range) / all sampled pixels. */
  litFraction: number;
  /** Arithmetic mean and 99th percentile luminance of the lit range, cd/m^2 (0 when nothing is lit). */
  mean: number;
  p99: number;
}

function percentileBin(h: ArrayLike<number>, lo: number, total: number, p: number): number {
  let acc = 0;
  const want = total * p;
  for (let i = lo; i < HISTOGRAM_BINS; i++) {
    acc += h[i]!;
    if (acc >= want) return i;
  }
  return HISTOGRAM_BINS - 1;
}

/** Statistics of the lit range of a histogram of `sampleCount` sampled pixels (sky and dark pixels are not in the bins). */
export function histogramStats(h: ArrayLike<number>, sampleCount: number): HistogramStats {
  let total = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) total += h[i]!;
  if (total <= 0 || sampleCount <= 0) return { litFraction: 0, mean: 0, p99: 0 };
  const binsPerEv = HISTOGRAM_BINS / HISTOGRAM_RANGE_LOG2;
  const top = percentileBin(h, 0, total, 0.995);
  const lo = Math.max(0, Math.floor(top - LIT_RANGE_EV * binsPerEv));
  let lit = 0;
  let sum = 0;
  for (let i = lo; i < HISTOGRAM_BINS; i++) {
    lit += h[i]!;
    sum += h[i]! * binLuminance(i);
  }
  if (lit <= 0) return { litFraction: 0, mean: 0, p99: 0 };
  return { litFraction: lit / sampleCount, mean: sum / lit, p99: binLuminance(percentileBin(h, lo, lit, 0.99)) };
}

/** "Keeps night dark and day bright": bright scenes are rendered above mid-grey, dim ones below. */
export const exposureCompensationCurve = (evMean: number): number => Math.max(-1, Math.min(0.8, (evMean - 4) * 0.08));

export interface MeterInput {
  /** Histogram of all lit geometry and of geometry within INTERIOR_RANGE. */
  histogram: ArrayLike<number>;
  histogramNear: ArrayLike<number>;
  /** Number of pixels the GPU sampled (lit or not). */
  sampleCount: number;
  /** Unoccluded illuminance of the star at the camera (lux) and the fraction of its disc visible there. */
  sunIlluminance: number;
  sunVisibility: number;
  /** True when a sunlit body or vessel is inside the view frustum (from the snapshot, CPU). */
  litObjectInView: boolean;
  kind: ViewKind;
  /** CameraState.exposureCompensation (EV, positive = brighter image) and CameraState.minEv100. */
  exposureCompensation: number;
  minEv100: number | null;
}

export interface MeterResult {
  targetEv100: number;
  litFraction: number;
  /** Weight of the histogram against the photometric prior, 0..1. */
  histogramWeight: number;
  evHistogram: number;
  evPrior: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Target EV100 for one frame (before temporal adaptation). */
export function meterExposure(m: MeterInput): MeterResult {
  const interior = m.kind === 'interior';
  const stats = histogramStats(interior ? m.histogramNear : m.histogram, m.sampleCount);
  const all = interior ? histogramStats(m.histogram, m.sampleCount) : stats;

  // Photometric prior: sunny-16 scaled by the sun's visibility when something lit is in view, else the dark floor.
  const somethingLit = m.litObjectInView || all.litFraction > LIT_PRESENT;
  const evSun = sunny16Ev(m.sunIlluminance * m.sunVisibility);
  const evPrior = somethingLit ? Math.max(EV_DARK_FLOOR, evSun) : EV_DARK_FLOOR;

  let evHistogram = evPrior;
  let w = 0;
  if (stats.mean > 0) {
    const evMean = ev100ForMidGrey(stats.mean);
    evHistogram = evMean - exposureCompensationCurve(evMean);
    // Highlight protection applies to exterior metering; in a cabin the windows are allowed to blow out.
    if (!interior) evHistogram = Math.max(evHistogram, Math.log2(stats.p99 / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K)));
    w = smooth(LIT_PRIOR_ONLY, LIT_FULL, stats.litFraction);
  }
  let ev = evPrior + (evHistogram - evPrior) * w - m.exposureCompensation;
  ev = Math.max(EV_MIN, Math.min(EV_MAX, ev));
  if (m.minEv100 !== null) ev = Math.max(ev, m.minEv100);
  return { targetEv100: ev, litFraction: stats.litFraction, histogramWeight: w, evHistogram, evPrior };
}

/** Eye-like temporal adaptation: EV rises quickly when the scene gets brighter and falls more slowly. */
export function adaptEv100(current: number, target: number, dt: number): number {
  const d = target - current;
  const rate = d > 0 ? ADAPT_UP : ADAPT_DOWN;
  // Exponential approach far from the target, constant-rate cap so large jumps take visible time.
  const step = Math.min(Math.abs(d), Math.max(rate * dt, Math.abs(d) * (1 - Math.exp(-dt * rate))));
  return current + Math.sign(d) * step;
}
