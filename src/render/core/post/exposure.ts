/**
 * Auto-exposure metering rules (ARCHITECTURE 10.4), CPU side. Pure functions: unit-tested in vitest.
 *
 * The GPU builds two 256-bin log-luminance histograms of ABSOLUTE luminance (cd/m^2) over geometry pixels
 * only (depth != 0) above an absolute floor: every such pixel, and those within INTERIOR_RANGE of the eye
 * (interior metering); and a third over the sky pixels between the floor and SKY_METER_MAX (what an interior
 * view sees of the daylight sky through its windows; never metered as lit geometry). This module turns the
 * histograms into a target EV100.
 */
import type { ViewKind } from '@/core/contracts/render';

export const HISTOGRAM_BINS = 256;
/** log2(cd/m^2) of the lower edge of bin 0 and the span covered by the histogram (8 bins per EV). */
export const HISTOGRAM_MIN_LOG2 = -12;
export const HISTOGRAM_RANGE_LOG2 = 32;
/** Pixels darker than this (cd/m^2) are never metered: unlit sides, deep shadow in vacuum. */
export const LUMINANCE_FLOOR = 0.008;
/**
 * Sky pixels brighter than this (cd/m^2) are not in the sky histogram: the solar disc and its glare, which no
 * exposure holds (sunlit cloud tops and the brightest daylight sky are a fifth of it).
 */
export const SKY_METER_MAX = 200000;
/** Pixels more than this many EV below the brightest lit pixels are not part of the lit range either. */
export const LIT_RANGE_EV = 10;
/** Geometry nearer than this (m) is "interior" for CameraState.kind === 'interior'. */
export const INTERIOR_RANGE = 8;
export const MID_GREY = 0.18;
/** exposure = 1 / (EXPOSURE_K * 2^EV100). */
export const EXPOSURE_K = 1.2;
/** Lower bound of EV100 after exposure compensation: one stop of room under the dark floor. */
export const EV_MIN = -7;
export const EV_MAX = 16.5;
/**
 * Dark-adapted floor: the exposure of a frame with nothing lit in it and no emitter metered. At EV -6 the
 * Milky Way (5e-4 to 1e-3 cd/m^2) lies 1.7 to 2.7 stops under mid-grey, as in night photographs from orbit
 * (request sky-lighting-3; it was -3, which left the night sky a black frame with a few dozen dots).
 */
export const EV_DARK_FLOOR = -6;
/**
 * Below this EV100 the eye's (and the camera operator's) dark adaptation is slow: the exposure falls at
 * ADAPT_DARK EV per second, 25 s for the three stops down to the floor. Everything above it, and the way
 * back up, keeps the ordinary rates: one lit pixel brings the exposure back at once.
 */
export const DARK_ADAPT_EV = -3;
export const ADAPT_DARK = 0.12;
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
 * While the sun lights the scene, the metered pixels and the emitters may raise the target to at most this
 * many EV above sunny 16: sunlit white (albedo 0.9) sits at 0.9 of white there, and half a stop covers snow,
 * cloud tops and a white hull. Whatever is brighter than that by day (a flame, the ground it lights)
 * clips and blooms, as in every daylight launch photograph, instead of turning noon into dusk (request
 * vfx-4). A frame full of sunlit cloud or snow is therefore shown at half to two thirds of white, not at
 * the mid-grey a mean alone would give it. The bound comes in between SUNLIT_VISIBILITY_MIN and
 * SUNLIT_VISIBILITY_FULL of the solar disc: under a sliver of sun, in an eclipse and at night the
 * protection is whole.
 */
export const SUNLIT_HIGHLIGHT_MAX_EV = 0.5;
export const SUNLIT_VISIBILITY_MIN = 0.05;
export const SUNLIT_VISIBILITY_FULL = 0.3;
/**
 * The same bound from BELOW (request vfx-7): while the sun lights the scene, a daylight exterior frame is
 * exposed at no less than sunny 16 minus this many EV, whatever the opaque scene holds. When the lit pad
 * leaves the frame of a lift-off and the camera looks at the vehicle over dark ground, a meter alone opens up
 * by more than a stop and the sky pumps; a photographer's daylight exposure stays where it is. Dark things
 * stay dark by day (a sea of albedo 0.06 beside a white hull, a basalt plain, a shaded flank).
 *
 * "The sun lights the scene" needs more here than the solar disc at the camera, because opening up is what
 * a camera rightly does when it does not:
 *  - sunlit surfaces must be in the frame: pixels at or above SUNLIT_SURFACE times the luminance of a white
 *    Lambert surface square to the sun, on SUNLIT_EVIDENCE_FROM to SUNLIT_EVIDENCE_FULL of the frame. Under
 *    an overcast, on the shadow side of a hull, over the night side seen from a sunlit orbit nothing is that
 *    bright, and the meter exposes for what it sees, as before;
 *  - the sun must stand well above the horizon of the ground under the camera (MeterInput.sunElevationSin
 *    from SUNLIT_ELEVATION_MIN to SUNLIT_ELEVATION_FULL, 10 to 25 degrees): at a low sun the ground takes a
 *    fraction of the light a hull facing the sun takes (a lunar landing under an 8 degree sun, dawn at the
 *    splashdown), and every exposure guide opens up for it.
 * Exterior and map views only; never without the elevation (a caller that cannot tell gives none).
 */
export const SUNLIT_SHADOW_MIN_EV = 0.5;
/**
 * What is brighter than anything the sun can light (request vfx-8): ground under a flame, a glint, a flame's
 * own hint. A daylight exposure is set for what the sun lights, and those clip as the flame does. Pixels and
 * emitters above SUNLIT_OVER_WHITE times the luminance of a white Lambert surface square to the sun (sunlit
 * white with its share of sky light stays under it) may raise the exterior target by at most
 * SUNLIT_SPOT_MAX_EV over what the frame without them asks for, under the same visibility gate as the other
 * sunlit bounds. The same bound holds for the highlight term as such: the brightest per cent of a sunlit
 * frame (a white mount, the apron in the outer light of a flame, a hull: at or under sunlit white, so not
 * told from it by their luminance) raises the target by SUNLIT_SPOT_MAX_EV at most over what the frame's mean
 * and the prior ask for. A frame that is bright as a whole (sunlit cloud tops, snow) keeps its half stop
 * (SUNLIT_HIGHLIGHT_MAX_EV) through its mean; the pad under the flame of a daylight lift-off no longer holds
 * the meter on that bound until it leaves the frame.
 */
export const SUNLIT_OVER_WHITE = 1.5;
export const SUNLIT_SPOT_MAX_EV = 0.25;
export const SUNLIT_SURFACE = 0.25;
export const SUNLIT_EVIDENCE_FROM = 0.0002;
export const SUNLIT_EVIDENCE_FULL = 0.002;
export const SUNLIT_ELEVATION_MIN = 0.1736;
export const SUNLIT_ELEVATION_FULL = 0.4226;
/**
 * Interior metering (requests cockpit-5 and -6). A dim cabin IN THE DARK is displayed dim: the target is
 * this many EV darker than the log-average alone asks for when the near log-mean is at or below
 * INTERIOR_NIGHT_LOW cd/m^2, not at all from INTERIOR_NIGHT_HIGH up, and in proportion to the part of the
 * solar disc that is hidden at the camera (the Earth's shadow, the pad at night). A cabin that is as dim
 * by day, behind small windows, keeps the plain log-average: the level alone cannot tell the two apart.
 */
export const INTERIOR_NIGHT_KEY_EV = 1.5;
export const INTERIOR_NIGHT_LOW = 4;
export const INTERIOR_NIGHT_HIGH = 64;
/**
 * The 99th percentile of the cabin is kept below this multiple of mid-grey (exterior: HIGHLIGHT_CAP), but
 * the highlights may stop the camera down by at most INTERIOR_HIGHLIGHT_MAX_EV: the cabin stays readable,
 * a stop to two under mid-grey, when the sun falls into it.
 */
export const INTERIOR_HIGHLIGHT_CAP = 48;
export const INTERIOR_HIGHLIGHT_MAX_EV = 1.25;
/**
 * Bright areas in an interior view (request cockpit-12). Lit pixels more than INTERIOR_BRIGHT_RATIO times
 * the cabin's log-mean, near (a sun patch on the console) or beyond INTERIOR_RANGE (the Earth in a window),
 * are counted; as their share of the frame grows from INTERIOR_BRIGHT_FROM to INTERIOR_BRIGHT_FULL the
 * highlight cap tightens from INTERIOR_HIGHLIGHT_CAP to INTERIOR_BRIGHT_CAP times mid-grey (log-linearly),
 * the brightest of them all take part in it, and the bound on the stop-down grows from
 * INTERIOR_HIGHLIGHT_MAX_EV to INTERIOR_BRIGHT_MAX_EV: a patch or a window of a few per cent of the frame
 * is brought into the tone curve's shoulder, as a photographer bracketing for it would, and the cabin goes a
 * stop or two darker. Under a per cent nothing changes.
 */
export const INTERIOR_BRIGHT_RATIO = 16;
export const INTERIOR_BRIGHT_FROM = 0.01;
export const INTERIOR_BRIGHT_FULL = 0.08;
export const INTERIOR_BRIGHT_CAP = 12;
export const INTERIOR_BRIGHT_MAX_EV = 3;
/** Highlights still this far (EV) over the cap after the largest stop-down get none of it (smoothly from 0). */
export const INTERIOR_BRIGHT_HOPELESS_EV = 3;
/**
 * What fills the frame through the windows (request cockpit-7). The lit geometry BEYOND INTERIOR_RANGE (the
 * Earth, the Moon, the pad: `histogram` minus `histogramNear`) is metered as an exterior camera would meter
 * it, and stops the interior exposure down towards that value by a weight that goes from 0 at
 * INTERIOR_WINDOW_FROM to 1 at INTERIOR_WINDOW_FULL of the frame. It never opens the exposure (a night
 * side in the window leaves a lit cabin alone), and the seat's normal view (windows 5-8 % of the frame)
 * is metered on the cabin alone: there the windows blow out.
 */
export const INTERIOR_WINDOW_FROM = 0.1;
export const INTERIOR_WINDOW_FULL = 0.4;
/**
 * The world in the windows of the seat's view (request cockpit-16). From the seat the windows are 2-8 % of
 * the frame and the sunlit Earth, the lunar ground or the pad in them stand nine to ten stops over a cabin
 * keyed to mid-grey: no single exposure and no tone curve shows both, and a photograph taken in a cabin does
 * two things about it. It keys the cabin low (Apollo 7 and LM interiors: the cabin two to two and a half
 * stops under mid-grey), and its film holds the window on the shoulder. Here:
 * "The outside" here is what the view shows beyond the cabin: lit geometry beyond INTERIOR_RANGE and the sky
 * (the third histogram: a daylight sky, not black space, not the solar disc).
 *  - the key: the cabin's target is raised by up to INTERIOR_OUTSIDE_KEY_EV as the outside takes
 *    INTERIOR_OUTSIDE_FROM to INTERIOR_OUTSIDE_FULL of the frame and its log-average stands
 *    INTERIOR_OUTSIDE_OVER_FROM to INTERIOR_OUTSIDE_OVER_FULL stops over the cabin's. A window onto the
 *    night side or onto black space changes nothing; the other interior rules only ever ask for more (the
 *    larger stop-down counts).
 *  - the outside's own exposure: it is shown with its brightest tenth (the 90th percentile) at
 *    INTERIOR_FAR_STOPS over mid-grey, just under the tone curve's white: cloud tops and a noon sky bright,
 *    sea and land in the mid-tones, the limb against black. By a gain under 1 on the pixels beyond
 *    INTERIOR_RANGE, before the resolve and the bloom (`interiorFarGain`; the render core's pass
 *    'core.interiorFar'). It is the exposure a second frame for the window would have, with the depth buffer
 *    as its mask: local, without the halo of a blurred mask. Once the windows fill the frame the exposure
 *    itself is the outside's (INTERIOR_WINDOW_FROM / _FULL) and the gain is back at 1.
 */
export const INTERIOR_OUTSIDE_FROM = 0.002;
export const INTERIOR_OUTSIDE_FULL = 0.008;
export const INTERIOR_OUTSIDE_OVER_FROM = 3;
export const INTERIOR_OUTSIDE_OVER_FULL = 6;
export const INTERIOR_OUTSIDE_KEY_EV = 2.25;
export const INTERIOR_FAR_STOPS = 3;
/**
 * The sun in the frame, seen from space (request sky-lighting-10). The histogram holds lit geometry only, so a
 * frame that is mostly night side with the sun and its lit limb arc over the sky pixels was exposed for the
 * night side, the arc burned white and the sun's glare flooded the frame. A camera exposes such a frame for
 * the light it looks into: the target is at least sunny 16 of the sun's illuminance at the camera after the
 * air on the way (the limb's air at sunrise: a few per cent), less this margin. Exterior views only.
 */
export const SUN_IN_FRAME_MARGIN_EV = 1;
/**
 * The sun as a camera INSIDE an atmosphere has it (request atmosphere-clouds-10). The photometric prior and
 * the bounds under the sun are sunny 16 of the sun's illuminance at the camera. Above every atmosphere that
 * is the illuminance after the air on the way (request sky-lighting-10). Inside one it was the illuminance
 * outside the air, which is right for a high sun and four to six stops too much at sunrise: a frame of dawn
 * sky, with no lit geometry to correct it, was exposed for full sunlight. Now the air counts there too, but
 * only what it takes beyond a clear air mass under a high sun: the transmittance towards the sun from the
 * camera (luminance-weighted) divided by SUN_AIR_CLEAR and capped at 1. With the sun 35 degrees up and more
 * over clear air nothing changes (pad, ascent: the daylight rules were tuned on those frames); at 10 degrees
 * the prior is 0.8 EV lower, at 1 degree from 7 km 1.6, on the ground at sunrise five (the luminance-weighted
 * transmittance of the Earth's air towards the sun: 0.85 at the zenith, 0.76 at 35 degrees, 0.73 at the 31
 * degrees of the mission's launch, 0.42 at 10 degrees and 0.02 at 1 degree from the ground; 0.24 at 1 degree
 * from 7 km).
 */
export const SUN_AIR_CLEAR = 0.75;
export function sunThroughAir(illuminance: number, transmittance: number, aboveTheAir: boolean): number {
  const t = Math.max(0, Math.min(1, transmittance));
  return illuminance * (aboveTheAir ? t : Math.min(1, t / SUN_AIR_CLEAR));
}
/** Adaptation speed, EV per second: fast when the scene gets brighter, slower when it gets darker. */
export const ADAPT_UP = 2.5;
export const ADAPT_DOWN = 0.8;
/**
 * A cut between views (request cockpit-14). When `CameraState.kind` changes (chase to cockpit, flight to map)
 * the exposure is the new shot's, not an eye's that adapts: for CUT_ADAPT_SECONDS after the change it follows
 * the metered target with the time constant CUT_ADAPT_TAU, in both directions and through the dark range (the
 * histogram of the new view arrives a few frames after the cut, and the view manager's blend carries the eye
 * through the hull for a third of a second more: the target is still moving, and the exposure stays on it).
 * Eleven stops from a sunlit exterior to the cabin took three to four seconds of black picture before.
 */
export const CUT_ADAPT_SECONDS = 0.75;
export const CUT_ADAPT_TAU = 0.06;

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
  /**
   * The hint is for an INTERIOR view (request cockpit-19): an emitter seen through the cabin's windows (an
   * entry sheath, a plume passing the panes). `luminance` is what the panes show of it, `coverage` the share
   * of the frame those panes cover. It counts as part of the outside seen through the windows (the far
   * level, the cabin's key, the far gain), and exterior and map views ignore it. Without the flag a hint is
   * for exterior and map views, and an interior view ignores it: its provider does not know the windows.
   */
  inside?: boolean;
}
/** Emitter coverage from which the prior exposes fully for the emitter (below it: in proportion). */
export const EMISSIVE_FULL = 0.01;

export interface MeterInput {
  /** Histogram of all lit geometry and of geometry within INTERIOR_RANGE. */
  histogram: ArrayLike<number>;
  histogramNear: ArrayLike<number>;
  /** Histogram of the sky pixels between LUMINANCE_FLOOR and SKY_METER_MAX (interior views; absent: none). */
  histogramSky?: ArrayLike<number>;
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
  /** Emitters this frame: over sky pixels for exterior and map views; those marked `inside` for an interior view. */
  emissive?: readonly EmissiveHint[];
  /**
   * Illuminance (lux) of the sun at the camera AFTER the air it crosses, when its disc is in the frame and the
   * camera is above every atmosphere (request sky-lighting-10); absent otherwise. See SUN_IN_FRAME_MARGIN_EV.
   */
  sunInFrame?: number;
  /**
   * Sine of the sun's elevation above the horizon of the point under the camera on the nearest body (the dot
   * product of the local vertical there and the direction to the sun). Gates the bound from below under the
   * sun (SUNLIT_SHADOW_MIN_EV, request vfx-7); absent: no such bound.
   */
  sunElevationSin?: number;
}

export interface MeterResult {
  targetEv100: number;
  litFraction: number;
  /** Weight of the histogram against the photometric prior, 0..1. */
  histogramWeight: number;
  evHistogram: number;
  evPrior: number;
  /**
   * Interior views: the part of the frame that is lit geometry beyond INTERIOR_RANGE, the EV100 an exterior
   * camera would choose for it, and the weight with which it stops the cabin's exposure down (0 elsewhere).
   */
  outsideFraction: number;
  evOutside: number;
  outsideWeight: number;
  /** Weight of the bound from below under the sun (SUNLIT_SHADOW_MIN_EV), 0..1; 0 in interior views. */
  sunlitFloor: number;
  /**
   * Interior views (request cockpit-16): the 90th percentile luminance of what the view shows beyond the
   * cabin (lit geometry beyond INTERIOR_RANGE and the sky), cd/m^2 (0 = none), and the weight, 0..1, with
   * which that counts as a bright outside seen through the windows (its share of the frame and how far it
   * stands over the cabin): the cabin's key and `interiorFarGain` follow it. Both 0 in exterior and map views.
   */
  farLevel: number;
  farWeight: number;
}

/** Scratch: the far histogram of an interior view, the same with the sky, and an exterior frame without what is brighter than sunlit white. */
const FAR = new Float64Array(HISTOGRAM_BINS);
const SEEN = new Float64Array(HISTOGRAM_BINS);
const SUNLIT = new Float64Array(HISTOGRAM_BINS);

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
 * cockpit-5.md, cockpit-6.md): a dim cabin out of the sun gets a darker key (night is displayed as night), and the cabin's highlights
 * count with a cap twelve times looser than outside and a bound on how far they may stop the camera down,
 * so that the cabin is exposed between its shade and its sun patch, as a photograph taken inside is. The
 * windows are farther than the range and blow out, until what is seen through them fills a tenth of the
 * frame and more: then the exposure is stopped down towards what an exterior camera would choose for it
 * (INTERIOR_WINDOW_FROM / _FULL, docs/requests/cockpit-7.md), and the window frame goes to a silhouette.
 *
 * The histogram is taken BEFORE the transparent pass (request vfx-4): it holds what is lit (terrain, water,
 * clouds, hulls, and whatever a plume lights), not what emits in front of it. A flame, a splash crown or a
 * fireball drawn over geometry reaches the meter the same way as one over the sky: through a hint.
 *
 * Emitters (`emissive`) are not in the histogram, which holds geometry only. In an exterior or
 * map view they are added to it as if they were lit pixels of their luminance and coverage (so a plume is
 * metered alike in front of the ground and in front of space), and they raise the prior: an emitter that
 * covers EMISSIVE_FULL of the frame is exposed so that it stays below the highlight cap, a smaller one in
 * proportion. Without that a trail or a fireball against a night sky is rendered at the dark-adapted
 * exposure, saturates and blooms over the whole frame.
 *
 * Under the sun the exterior target is bounded on both sides of sunny 16: from above by
 * SUNLIT_HIGHLIGHT_MAX_EV (request vfx-4), from below by SUNLIT_SHADOW_MIN_EV while sunlit surfaces are in
 * the frame and the sun stands well above the horizon (request vfx-7); and what is brighter than the sun can
 * light anything (flame-lit ground, glints, emitters) moves it by SUNLIT_SPOT_MAX_EV at most (request vfx-8).
 */
export function meterExposure(m: MeterInput): MeterResult {
  const interior = m.kind === 'interior';
  // Interior: what lies beyond the cabin (the far histogram), for the key, the far exposure and the window rule.
  let far: HistogramStats | null = null;
  let seen: HistogramStats | null = null;
  let farLevel = 0;
  let farWeight = 0;
  if (interior) {
    let total = 0;
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      FAR[i] = Math.max(0, m.histogram[i]! - m.histogramNear[i]!);
      SEEN[i] = FAR[i]! + (m.histogramSky ? m.histogramSky[i]! : 0);
      total += SEEN[i]!;
    }
    // Emitters the panes show (request cockpit-19) are part of what is seen beyond the cabin: the histogram
    // is taken before the transparent pass and does not hold them.
    for (const e of m.emissive ?? []) {
      if (!e.inside || !(e.luminance >= LUMINANCE_FLOOR) || !(e.coverage > 0)) continue;
      const pixels = Math.min(1, e.coverage) * m.sampleCount;
      const bin = luminanceBin(e.luminance);
      SEEN[bin] = SEEN[bin]! + pixels;
      total += pixels;
    }
    far = histogramStats(FAR, m.sampleCount);
    seen = histogramStats(SEEN, m.sampleCount);
    if (total > 0) farLevel = binLuminance(percentileBin(SEEN, 0, total, 0.9));
  }
  let histogram = m.histogram;
  let emitterCoverage = 0;
  let emitterLuminance = 0;
  if (!interior && m.emissive && m.emissive.length > 0) {
    const h = Float64Array.from(m.histogram);
    for (const e of m.emissive) {
      if (e.inside || !(e.luminance >= LUMINANCE_FLOOR) || !(e.coverage > 0)) continue;
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
  // Highlight protection under the sun ends half a stop above sunny 16 (not in a cabin, not without the sun).
  const sunlitOutside = somethingLit ? smooth(SUNLIT_VISIBILITY_MIN, SUNLIT_VISIBILITY_FULL, m.sunVisibility) : 0;
  const sunlit = interior ? 0 : sunlitOutside;
  const evSunlitMax = evSun + SUNLIT_HIGHLIGHT_MAX_EV;
  const underTheSun = (evHighlight: number, weight = sunlit): number => (weight > 0 && evHighlight > evSunlitMax ? evHighlight + (evSunlitMax - evHighlight) * weight : evHighlight);
  let evPrior = somethingLit ? Math.max(EV_DARK_FLOOR, evSun) : EV_DARK_FLOOR;
  // Under the sun, what is brighter than anything it lights raises the target by a quarter stop at most (request vfx-8).
  const overWhite = (SUNLIT_OVER_WHITE * m.sunIlluminance * m.sunVisibility) / Math.PI;
  const spot = (evWith: number, evWithout: number): number => (sunlit > 0 && evWith > evWithout + SUNLIT_SPOT_MAX_EV ? evWith + (evWithout + SUNLIT_SPOT_MAX_EV - evWith) * sunlit : evWith);
  if (emitterCoverage > 0) {
    let evEmitter = underTheSun(Math.log2(emitterLuminance / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K)));
    if (emitterLuminance > overWhite) evEmitter = spot(evEmitter, evPrior);
    if (evEmitter > evPrior) evPrior += (evEmitter - evPrior) * smooth(LIT_PRESENT, EMISSIVE_FULL, emitterCoverage);
  }

  let evHistogram = evPrior;
  let w = 0;
  if (stats.mean > 0) {
    const evMean = ev100ForMidGrey(interior ? stats.logMean : stats.mean);
    evHistogram = evMean - exposureCompensationCurve(evMean);
    if (interior) {
      const dark = m.sunIlluminance > 0 ? 1 - Math.max(0, Math.min(1, m.sunVisibility)) : 1;
      const keyEv = INTERIOR_NIGHT_KEY_EV * (1 - smooth(Math.log2(INTERIOR_NIGHT_LOW), Math.log2(INTERIOR_NIGHT_HIGH), Math.log2(stats.logMean))) * dark;
      const evBase = evHistogram + keyEv;
      const evHigh = Math.log2(stats.p99 / (INTERIOR_HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K));
      evHistogram = Math.min(Math.max(evBase, evHigh), evBase + INTERIOR_HIGHLIGHT_MAX_EV);
      // A bright world in the windows keys the cabin low, as a photograph taken in it is (request cockpit-16).
      if (seen && seen.logMean > 0) {
        farWeight = smooth(INTERIOR_OUTSIDE_FROM, INTERIOR_OUTSIDE_FULL, seen.litFraction) * smooth(INTERIOR_OUTSIDE_OVER_FROM, INTERIOR_OUTSIDE_OVER_FULL, Math.log2(seen.logMean / stats.logMean));
        evHistogram = Math.max(evHistogram, evBase + INTERIOR_OUTSIDE_KEY_EV * farWeight);
      }
      // Bright areas, near and far (request cockpit-12): their share of the frame tightens the cap and
      // loosens the bound, and the 99th percentile of every lit pixel takes part. Only where that brings them
      // into the shoulder: highlights that would still stand more than INTERIOR_BRIGHT_HOPELESS_EV over the
      // cap blow out either way (direct sun on white paint, a window 1,000 times the cabin), and stopping down
      // for them would only cost the cabin.
      const brightFrom = luminanceBin(INTERIOR_BRIGHT_RATIO * stats.logMean) + 1;
      let bright = 0;
      for (let i = brightFrom; i < HISTOGRAM_BINS; i++) bright += m.histogram[i]!;
      const s = smooth(INTERIOR_BRIGHT_FROM, INTERIOR_BRIGHT_FULL, bright / m.sampleCount);
      if (s > 0) {
        const cap = INTERIOR_HIGHLIGHT_CAP * (INTERIOR_BRIGHT_CAP / INTERIOR_HIGHLIGHT_CAP) ** s;
        const p99 = Math.max(stats.p99, histogramStats(m.histogram, m.sampleCount, Infinity).p99);
        const evBright = Math.log2(p99 / (cap * MID_GREY * EXPOSURE_K));
        const bound = evBase + INTERIOR_HIGHLIGHT_MAX_EV + (INTERIOR_BRIGHT_MAX_EV - INTERIOR_HIGHLIGHT_MAX_EV) * s;
        // Hopeless or not by the bright area's median against the strongest rule (cap INTERIOR_BRIGHT_CAP,
        // bound INTERIOR_BRIGHT_MAX_EV): it does not depend on the share, so the target grows with the share.
        const median = binLuminance(percentileBin(m.histogram, brightFrom, bright, 0.5));
        const excess = Math.log2(median / (INTERIOR_BRIGHT_CAP * MID_GREY * EXPOSURE_K)) - (evBase + INTERIOR_BRIGHT_MAX_EV);
        const useful = 1 - smooth(0, INTERIOR_BRIGHT_HOPELESS_EV, excess);
        const evNew = Math.min(Math.max(evBase, evBright), bound);
        if (evNew > evHistogram) evHistogram += (evNew - evHistogram) * useful;
      }
    } else {
      // The bound holds for the mean as well as for the 99th percentile: a few per cent of the frame at a
      // hundred times sunlit white move the arithmetic mean by stops. And under the sun the highlight term
      // alone (a few per cent of the frame near white: a white launch mount, the apron round a flame, a hull)
      // may raise the target by SUNLIT_SPOT_MAX_EV over what the frame's mean and the prior ask for; only a
      // frame that is bright as a whole (cloud tops, snow) takes the whole half stop (request vfx-8).
      const evMeanTerm = evHistogram;
      evHistogram = underTheSun(Math.max(evMeanTerm, spot(Math.log2(stats.p99 / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K)), Math.max(evMeanTerm, evPrior))));
      // The same frame without what is brighter than the sun can make it: it sets the level, the rest clips.
      const first = luminanceBin(overWhite) + 1;
      let over = 0;
      if (sunlit > 0) for (let i = first; i < HISTOGRAM_BINS; i++) over += histogram[i]!;
      if (over > 0) {
        for (let i = 0; i < HISTOGRAM_BINS; i++) SUNLIT[i] = i < first ? histogram[i]! : 0;
        const lit = histogramStats(SUNLIT, m.sampleCount);
        let evLit = evSun;
        if (lit.mean > 0) {
          const evMean = ev100ForMidGrey(lit.mean);
          const evLitMean = evMean - exposureCompensationCurve(evMean);
          evLit = underTheSun(Math.max(evLitMean, spot(Math.log2(lit.p99 / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K)), Math.max(evLitMean, evSun))));
        }
        evHistogram = spot(evHistogram, evLit);
      }
    }
    w = smooth(LIT_PRIOR_ONLY, evHistogram > evPrior ? LIT_FULL_BRIGHT : LIT_FULL, stats.litFraction);
  }
  let ev = evPrior + (evHistogram - evPrior) * w;

  // Bounded from below as well while the sun lights what is in the frame (request vfx-7).
  let sunlitFloor = 0;
  if (sunlit > 0 && m.sunElevationSin !== undefined) {
    const high = smooth(SUNLIT_ELEVATION_MIN, SUNLIT_ELEVATION_FULL, m.sunElevationSin);
    if (high > 0) {
      // Geometry only (m.histogram, not the emitters): a flame is not a sunlit surface.
      let bright = 0;
      for (let i = luminanceBin((SUNLIT_SURFACE * m.sunIlluminance * m.sunVisibility) / Math.PI); i < HISTOGRAM_BINS; i++) bright += m.histogram[i]!;
      sunlitFloor = sunlit * high * smooth(SUNLIT_EVIDENCE_FROM, SUNLIT_EVIDENCE_FULL, bright / m.sampleCount);
      const evMin = evSun - SUNLIT_SHADOW_MIN_EV;
      if (ev < evMin) ev += (evMin - ev) * sunlitFloor;
    }
  }

  // What fills the frame through the windows stops the cabin's exposure down (request cockpit-7).
  let outsideFraction = 0;
  let evOutside = ev;
  let outsideWeight = 0;
  if (far) {
    outsideFraction = far.litFraction;
    outsideWeight = far.mean > 0 ? smooth(INTERIOR_WINDOW_FROM, INTERIOR_WINDOW_FULL, far.litFraction) : 0;
    if (outsideWeight > 0) {
      // The exterior rule on the far pixels alone (from a tenth of the frame up the histogram decides by
      // itself there): arithmetic mean to mid-grey with the compensation curve, the highlight cap, the
      // bound under the sun.
      const evMean = ev100ForMidGrey(far.mean);
      evOutside = underTheSun(Math.max(evMean - exposureCompensationCurve(evMean), Math.log2(far.p99 / (HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K))), sunlitOutside);
      if (evOutside > ev) ev += (evOutside - ev) * outsideWeight;
    }
  }

  // The sun in the frame from space (request sky-lighting-10).
  if (m.kind === 'external' && m.sunInFrame !== undefined && m.sunInFrame > 0) ev = Math.max(ev, sunny16Ev(m.sunInFrame) - SUN_IN_FRAME_MARGIN_EV);

  ev -= m.exposureCompensation;
  ev = Math.max(EV_MIN, Math.min(EV_MAX, ev));
  if (m.minEv100 !== null) ev = Math.max(ev, m.minEv100);
  return { targetEv100: ev, litFraction: stats.litFraction, histogramWeight: w, evHistogram, evPrior, outsideFraction, evOutside, outsideWeight, sunlitFloor, farLevel, farWeight };
}

/**
 * The gain on what an interior view sees beyond INTERIOR_RANGE (request cockpit-16; `MeterResult.farLevel`
 * and `farWeight`, the exposure the frame is rendered with): at full weight the brightest tenth of the
 * outside is displayed INTERIOR_FAR_STOPS over mid-grey. Never above 1: a dim outside is left as the cabin's
 * exposure shows it.
 */
export function interiorFarGain(farLevel: number, ev100: number, weight: number): number {
  if (!(farLevel > 0) || !(weight > 0)) return 1;
  const over = Math.log2((farLevel * exposureFromEv100(ev100)) / MID_GREY) - INTERIOR_FAR_STOPS;
  return over > 0 ? 2 ** (-over * Math.min(1, weight)) : 1;
}

/**
 * Eye-like temporal adaptation: EV rises quickly when the scene gets brighter and falls more slowly, and
 * below DARK_ADAPT_EV it falls at the slow, constant rate of dark adaptation.
 */
export function adaptEv100(current: number, target: number, dt: number): number {
  if (target < current && current <= DARK_ADAPT_EV) return current - Math.min(current - target, ADAPT_DARK * dt);
  // A fall that would cross DARK_ADAPT_EV ends there for this step; the slow rate takes over from the next.
  const goal = target < current ? Math.max(target, DARK_ADAPT_EV) : target;
  const d = goal - current;
  const rate = d > 0 ? ADAPT_UP : ADAPT_DOWN;
  // Exponential approach far from the target, constant-rate cap so large jumps take visible time.
  const step = Math.min(Math.abs(d), Math.max(rate * dt, Math.abs(d) * (1 - Math.exp(-dt * rate))));
  return current + Math.sign(d) * step;
}

/** Exposure during the CUT_ADAPT_SECONDS after a cut between views: on the target with the time constant CUT_ADAPT_TAU. */
export function adaptEv100Cut(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / CUT_ADAPT_TAU));
}
