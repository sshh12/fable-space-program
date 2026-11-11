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
/**
 * The same for a lit area that is BRIGHTER than the prior asks for (a plume and the cloud it lights at
 * night, a floodlit patch in a dark frame): the histogram alone from this fraction. Highlight protection
 * must not wait for a tenth of the frame; a few sparse pixels dimmer than the prior still may not open
 * the exposure (they keep the slow ramp to LIT_FULL). Request vfx-3.
 */
export const LIT_FULL_BRIGHT = 0.02;
/** Any lit geometry at all (fraction of the frame) counts as "something lit is in view" for the prior. */
export const LIT_PRESENT = 0.0002;
/** The 99th percentile of lit pixels is kept below this multiple of mid-grey (highlight protection). */
export const HIGHLIGHT_CAP = 4;
/**
 * Interior metering (request cockpit-5). A dim cabin is displayed dim: the target is this many EV darker
 * than the log-average alone asks for when the near log-mean is at or below INTERIOR_NIGHT_LOW cd/m^2,
 * not at all from INTERIOR_NIGHT_HIGH up (floods and displays against daylight through the windows).
 */
export const INTERIOR_NIGHT_KEY_EV = 1.5;
export const INTERIOR_NIGHT_LOW = 4;
export const INTERIOR_NIGHT_HIGH = 64;
/**
 * The 99th percentile of the cabin is kept below this multiple of mid-grey (exterior: HIGHLIGHT_CAP), but
 * the highlights may stop the camera down by at most INTERIOR_HIGHLIGHT_MAX_EV: the cabin stays readable,
 * two to three stops under mid-grey, when the sun falls into it.
 */
export const INTERIOR_HIGHLIGHT_CAP = 48;
export const INTERIOR_HIGHLIGHT_MAX_EV = 1.75;
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
  /** Log-average (geometric mean) luminance of the lit range, cd/m^2: a few very bright pixels barely move it. */
  logMean: number;
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

/**
 * Statistics of the lit range of a histogram of `sampleCount` sampled pixels (sky and dark pixels are not in
 * the bins). The lit range is everything within `litRangeEv` of the brightest pixels (Infinity: every bin).
 */
export function histogramStats(h: ArrayLike<number>, sampleCount: number, litRangeEv = LIT_RANGE_EV): HistogramStats {
  let total = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) total += h[i]!;
  if (total <= 0 || sampleCount <= 0) return { litFraction: 0, mean: 0, p99: 0, logMean: 0 };
  const binsPerEv = HISTOGRAM_BINS / HISTOGRAM_RANGE_LOG2;
  const top = percentileBin(h, 0, total, 0.995);
  const lo = Number.isFinite(litRangeEv) ? Math.max(0, Math.floor(top - litRangeEv * binsPerEv)) : 0;
  let lit = 0;
  let sum = 0;
  let sumLog = 0;
  for (let i = lo; i < HISTOGRAM_BINS; i++) {
    lit += h[i]!;
    sum += h[i]! * binLuminance(i);
    sumLog += h[i]! * (HISTOGRAM_MIN_LOG2 + ((i + 0.5) / HISTOGRAM_BINS) * HISTOGRAM_RANGE_LOG2);
  }
  if (lit <= 0) return { litFraction: 0, mean: 0, p99: 0, logMean: 0 };
  return { litFraction: lit / sampleCount, mean: sum / lit, p99: binLuminance(percentileBin(h, lo, lit, 0.99)), logMean: 2 ** (sumLog / lit) };
}

/** "Keeps night dark and day bright": bright scenes are rendered above mid-grey, dim ones below. */
export const exposureCompensationCurve = (evMean: number): number => Math.max(-1, Math.min(0.8, (evMean - 4) * 0.08));

/**
 * A bright emitter drawn over SKY pixels (depth 0), which the histogram never sees: an engine plume, a reentry
 * trail or a fireball against space or the night sky. Features report it per frame through
 * `coreOf(ctx).addEmissiveHint` (docs/requests/vfx-1.md).
 */
export interface EmissiveHint {
  /** Representative luminance of its visible part, cd/m^2. */
  luminance: number;
  /** Fraction of the frame it covers over pixels with no geometry behind it, 0..1. */
  coverage: number;
}
/** Emitter coverage from which the prior exposes fully for the emitter (below it: in proportion). */
export const EMISSIVE_FULL = 0.01;

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
  /** Emitters over sky pixels this frame (exterior and map views; an interior view meters its cabin). */
  emissive?: readonly EmissiveHint[];
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

/**
 * Target EV100 for one frame (before temporal adaptation).
 *
 * Exterior and map views meter the arithmetic mean of the lit range (a lit object on black must not be
 * rendered grey) and protect highlights. An interior view meters the geometry within INTERIOR_RANGE by its
 * LOG-AVERAGE over everything above the luminance floor: a sun patch that comes through a window is several
 * hundred times brighter than the cabin it falls into, and an arithmetic mean would expose for the patch
 * and leave the cabin black (docs/requests/cockpit-3.md). On top of the log-average (docs/requests/
 * cockpit-5.md): a dim cabin gets a darker key (night is displayed as night), and the cabin's highlights
 * count with a cap twelve times looser than outside and a bound on how far they may stop the camera down,
 * so that the cabin is exposed between its shade and its sun patch, as a photograph taken inside is. The
 * windows are farther than the range and blow out.
 *
 * Emitters over the sky (`emissive`) are not in the histogram, which holds geometry only. In an exterior or
 * map view they are added to it as if they were lit pixels of their luminance and coverage (so a plume is
 * metered alike in front of the ground and in front of space), and they raise the prior: an emitter that
 * covers EMISSIVE_FULL of the frame is exposed so that it stays below the highlight cap, a smaller one in
 * proportion. Without that a trail or a fireball against a night sky is rendered at the dark-adapted
 * exposure, saturates and blooms over the whole frame.
 */
export function meterExposure(m: MeterInput): MeterResult {
  const interior = m.kind === 'interior';
  let histogram = m.histogram;
  let emitterCoverage = 0;
  let emitterLuminance = 0;
  if (!interior && m.emissive && m.emissive.length > 0) {
    const h = Float64Array.from(m.histogram);
    for (const e of m.emissive) {
      if (!(e.luminance >= LUMINANCE_FLOOR) || !(e.coverage > 0)) continue;
      const coverage = Math.min(1, e.coverage);
      h[luminanceBin(e.luminance)] = h[luminanceBin(e.luminance)]! + coverage * m.sampleCount;
      emitterCoverage += coverage;
      emitterLuminance = Math.max(emitterLuminance, e.luminance);
    }
    histogram = h;
  }
  const stats = interior ? histogramStats(m.histogramNear, m.sampleCount, Infinity) : histogramStats(histogram, m.sampleCount);
  const all = interior ? histogramStats(m.histogram, m.sampleCount) : stats;

  // Photometric prior: sunny-16 scaled by the sun's visibility when something lit is in view, else the dark
  // floor; raised towards the exposure that keeps an emitter under the highlight cap, by its coverage.
  const somethingLit = m.litObjectInView || all.litFraction > LIT_PRESENT;
  const evSun = sunny16Ev(m.sunIlluminance * m.sunVisibility);
  let evPrior = somethingLit ? Math.max(EV_DARK_FLOOR, evSun) : EV_DARK_FLOOR;
  if (emitterCoverage > 0) {
    const evEmitter = Math.log2(emitterLuminance / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K));
    if (evEmitter > evPrior) evPrior += (evEmitter - evPrior) * smooth(LIT_PRESENT, EMISSIVE_FULL, emitterCoverage);
  }

  let evHistogram = evPrior;
  let w = 0;
  if (stats.mean > 0) {
    const evMean = ev100ForMidGrey(interior ? stats.logMean : stats.mean);
    evHistogram = evMean - exposureCompensationCurve(evMean);
    if (interior) {
      const keyEv = INTERIOR_NIGHT_KEY_EV * (1 - smooth(Math.log2(INTERIOR_NIGHT_LOW), Math.log2(INTERIOR_NIGHT_HIGH), Math.log2(stats.logMean)));
      const evBase = evHistogram + keyEv;
      const evHigh = Math.log2(stats.p99 / (INTERIOR_HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K));
      evHistogram = Math.min(Math.max(evBase, evHigh), evBase + INTERIOR_HIGHLIGHT_MAX_EV);
    } else {
      evHistogram = Math.max(evHistogram, Math.log2(stats.p99 / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K)));
    }
    w = smooth(LIT_PRIOR_ONLY, evHistogram > evPrior ? LIT_FULL_BRIGHT : LIT_FULL, stats.litFraction);
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
