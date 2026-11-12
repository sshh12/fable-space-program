import { describe, expect, it } from 'vitest';
import { buildHapkeLut, DEFAULT_HAPKE, hapkeAlbedoAtNorm, hapkeBrdfMu0, HAPKE_NORM } from '@/render/core/lighting/deferred';
import { blackbodyRadiance } from '@/render/core/mesh/meshSystem';
import {
  ADAPT_DARK,
  adaptEv100,
  adaptEv100Cut,
  CUT_ADAPT_SECONDS,
  binLuminance,
  DARK_ADAPT_EV,
  EV_DARK_FLOOR,
  EV_MIN,
  ev100ForMidGrey,
  exposureCompensationCurve,
  exposureFromEv100,
  HISTOGRAM_BINS,
  histogramStats,
  INTERIOR_HIGHLIGHT_CAP,
  INTERIOR_HIGHLIGHT_MAX_EV,
  INTERIOR_BRIGHT_MAX_EV,
  INTERIOR_FAR_STOPS,
  INTERIOR_NIGHT_KEY_EV,
  INTERIOR_OUTSIDE_FROM,
  INTERIOR_OUTSIDE_FULL,
  INTERIOR_OUTSIDE_KEY_EV,
  INTERIOR_WINDOW_FROM,
  INTERIOR_WINDOW_FULL,
  interiorFarGain,
  LUMINANCE_FLOOR,
  luminanceBin,
  SUNLIT_ELEVATION_FULL,
  SUNLIT_ELEVATION_MIN,
  SUNLIT_HIGHLIGHT_MAX_EV,
  SUNLIT_SHADOW_MIN_EV,
  SUNLIT_SPOT_MAX_EV,
  SUN_AIR_CLEAR,
  SUN_IN_FRAME_MARGIN_EV,
  sunThroughAir,
  meterExposure,
  sunny16Ev,
  type MeterInput,
} from '@/render/core/post/exposure';
import { displayLinear, srgbEncode } from '@/render/core/post/tonemap';
import { DEFAULT_GOVERNOR, governorStep, initialGovernorState, type GovernorState } from '@/render/core/post/governor';

const SUN = 128000;
const N = 100000;

/** Histogram of `count` pixels spread log-uniformly between two luminances. */
function fill(h: Uint32Array, lo: number, hi: number, count: number): void {
  const a = luminanceBin(lo);
  const b = luminanceBin(hi);
  for (let i = 0; i < count; i++) h[a + Math.floor(((b - a + 1) * i) / count)]!++;
}
const meter = (h: Uint32Array, over: Partial<MeterInput> = {}): ReturnType<typeof meterExposure> =>
  meterExposure({ histogram: h, histogramNear: new Uint32Array(HISTOGRAM_BINS), sampleCount: N, sunIlluminance: SUN, sunVisibility: 1, litObjectInView: true, kind: 'external', exposureCompensation: 0, minEv100: null, ...over });

describe('exposure curve', () => {
  it('follows the photometric conventions of RENDER_API.md', () => {
    expect(exposureFromEv100(0)).toBeCloseTo(1 / 1.2, 12);
    expect(exposureFromEv100(15)).toBeCloseTo(1 / (1.2 * 32768), 15);
    // Sunny 16 at 128,000 lux: a sunlit 18 % Lambert surface (7,334 cd/m^2) renders at 0.18.
    expect(sunny16Ev(SUN)).toBeCloseTo(15.05, 2);
    expect(((0.18 * SUN) / Math.PI) * exposureFromEv100(sunny16Ev(SUN))).toBeCloseTo(0.18, 9);
    expect(ev100ForMidGrey(1000)).toBeCloseTo(Math.log2(1000 / 0.216), 12);
    // Histogram bins cover 2^-12 .. 2^20 cd/m^2 with 8 bins per EV.
    expect(luminanceBin(binLuminance(100))).toBe(100);
    expect(luminanceBin(1e-9)).toBe(0);
    expect(luminanceBin(1e12)).toBe(HISTOGRAM_BINS - 1);
    expect(exposureCompensationCurve(15)).toBeCloseTo(0.8, 12);
    expect(exposureCompensationCurve(-10)).toBe(-1);
  });
  it('adapts fast towards brighter scenes, slower towards darker ones, and settles exactly', () => {
    const up = adaptEv100(5, 15, 1 / 60) - 5;
    const down = 15 - adaptEv100(15, 5, 1 / 60);
    expect(up).toBeGreaterThan(down);
    let ev = -3;
    let frames = 0;
    while (ev !== 15 && frames < 2000) {
      ev = adaptEv100(ev, 15, 1 / 60);
      frames++;
    }
    expect(ev).toBe(15);
    expect(frames).toBeLessThan(600); // under 10 s from the dark floor to full sun
    expect(frames).toBeGreaterThan(30); // but not instantaneous
  });

  it('dark adaptation is slow below EV -3 and the way back is not (request sky-lighting-3)', () => {
    expect(EV_DARK_FLOOR).toBe(-6);
    expect(EV_MIN).toBeLessThan(EV_DARK_FLOOR);
    expect(DARK_ADAPT_EV).toBe(-3);
    const seconds = (from: number, to: number): number => {
      let ev = from;
      let frames = 0;
      while (ev !== to && frames < 100000) {
        ev = adaptEv100(ev, to, 1 / 60);
        frames++;
      }
      expect(ev).toBe(to);
      return frames / 60;
    };
    // From daylight to EV -3 as before (a few seconds), the last three stops in 20 to 30 seconds.
    const toMinus3 = seconds(15, DARK_ADAPT_EV);
    expect(toMinus3).toBeLessThan(12);
    const last = seconds(DARK_ADAPT_EV, EV_DARK_FLOOR);
    expect(last).toBeGreaterThan(20);
    expect(last).toBeLessThan(30);
    expect(seconds(15, EV_DARK_FLOOR)).toBeCloseTo(toMinus3 + last, 0);
    // The rate below -3 is ADAPT_DARK, whatever the gap (no exponential head start).
    expect(-4 - adaptEv100(-4, EV_DARK_FLOOR, 1)).toBeCloseTo(ADAPT_DARK, 9);
    expect(-3.5 - adaptEv100(-3.5, -3.6, 1)).toBeCloseTo(0.1, 9);
    // Above -3 nothing changed, and a step that crosses -3 stops there for this frame.
    expect(adaptEv100(5, -6, 1 / 60)).toBe(adaptEv100(5, -3, 1 / 60));
    expect(adaptEv100(-2.99, -6, 1)).toBe(DARK_ADAPT_EV);
    // Back up from the floor: under 10 s to full sun, the first stops within a fraction of a second.
    expect(seconds(EV_DARK_FLOOR, 15)).toBeLessThan(10);
    expect(adaptEv100(EV_DARK_FLOOR, 15, 0.25)).toBeGreaterThan(EV_DARK_FLOOR + 5);
  });
});

describe('metering rules (ARCHITECTURE 10.4)', () => {
  it('ignores pixels far below the lit range and reports the lit fraction', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 8000, 30000, 5000); // sunlit
    fill(h, 0.05, 0.5, 40000); // earthshine-lit night side: 14+ EV below
    const s = histogramStats(h, N);
    expect(s.litFraction).toBeCloseTo(0.05, 2);
    expect(s.mean).toBeGreaterThan(8000);
    expect(s.p99).toBeLessThan(35000);
    expect(LUMINANCE_FLOOR).toBeLessThan(0.05);
  });

  it('a sunlit object covering 3 % of a black frame exposes within 0.5 EV of sunny 16', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    // White object: Lambert falloff from 36,000 cd/m^2 down to the terminator.
    fill(h, 500, 36000, 0.03 * N);
    const m = meter(h);
    expect(m.litFraction).toBeCloseTo(0.03, 2);
    expect(Math.abs(m.targetEv100 - sunny16Ev(SUN))).toBeLessThan(0.5);
  });

  it('a thin crescent exposes within 0.5 EV of sunny 16', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 100, 6000, 0.008 * N); // grazing-lit sliver, 0.8 % of the frame
    const m = meter(h);
    expect(Math.abs(m.targetEv100 - sunny16Ev(SUN))).toBeLessThan(0.5);
    // Even with no lit pixel resolved at all the prior holds as long as a lit body is in view.
    expect(meter(new Uint32Array(HISTOGRAM_BINS)).targetEv100).toBeCloseTo(sunny16Ev(SUN), 6);
  });

  it('the sun just over the limb from orbit: exposed for the light it sends through the air, not for the night side (request sky-lighting-10)', () => {
    // 60 % of the frame is night side (airglow, city lights: 0.02-0.3 cd/m^2), 2 % the lit limb arc at a
    // few thousand cd/m^2; the sun's disc is in the frame, its light at the camera 3 % of the full sun.
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 0.02, 0.3, 0.6 * N);
    fill(h, 1500, 4000, 0.02 * N);
    // (The renderer meters a camera in space with the sun's illuminance after the air on the way.)
    const attenuated = 0.03 * SUN;
    const now = meter(h, { sunIlluminance: attenuated, sunInFrame: attenuated });
    expect(Math.abs(now.targetEv100 - sunny16Ev(attenuated))).toBeLessThan(1);
    expect(now.targetEv100).toBeGreaterThanOrEqual(sunny16Ev(attenuated) - SUN_IN_FRAME_MARGIN_EV - 1e-9);
    // When the lit arc is light over sky pixels (not in the histogram) the night side alone is metered: the
    // floor holds the exposure where the sun's light puts it; without it the frame is exposed for the night.
    const night = new Uint32Array(HISTOGRAM_BINS);
    fill(night, 0.02, 0.3, 0.6 * N);
    const nightOnly = meter(night, { sunIlluminance: attenuated, sunInFrame: attenuated });
    const without = meter(night, { sunIlluminance: attenuated });
    expect(Math.abs(nightOnly.targetEv100 - sunny16Ev(attenuated))).toBeLessThanOrEqual(1 + 1e-9);
    expect(without.targetEv100).toBeLessThan(nightOnly.targetEv100 - 3);
    // Only for exterior views, and never darker than the rule asks for when the frame itself is brighter.
    expect(meter(h, { sunInFrame: attenuated, kind: 'map' }).targetEv100).toBe(meter(h, { kind: 'map' }).targetEv100);
    const day = new Uint32Array(HISTOGRAM_BINS);
    fill(day, 2000, 6000, 0.6 * N);
    expect(meter(day, { sunInFrame: SUN }).targetEv100).toBeCloseTo(Math.max(meter(day).targetEv100, sunny16Ev(SUN) - SUN_IN_FRAME_MARGIN_EV), 9);
  });

  it('a fully dark frame reaches the dark-adapted floor', () => {
    const m = meter(new Uint32Array(HISTOGRAM_BINS), { litObjectInView: false });
    expect(m.targetEv100).toBe(EV_DARK_FLOOR);
    // In full eclipse the prior follows the sun's visibility down to the floor.
    expect(meter(new Uint32Array(HISTOGRAM_BINS), { sunVisibility: 0 }).targetEv100).toBe(EV_DARK_FLOOR);
    const partial = meter(new Uint32Array(HISTOGRAM_BINS), { sunVisibility: 0.25 }).targetEv100;
    expect(partial).toBeCloseTo(sunny16Ev(SUN) - 2, 6);
  });

  it('a frame full of lit ground is metered from the histogram with highlight protection', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 2000, 6000, 0.9 * N); // regolith
    const base = meter(h);
    expect(base.histogramWeight).toBe(1);
    const mean = histogramStats(h, N).mean;
    expect(base.targetEv100).toBeCloseTo(ev100ForMidGrey(mean) - exposureCompensationCurve(ev100ForMidGrey(mean)), 6);
    // Add 3 % of very bright pixels (a white lander in the sun: albedo 0.8 to 0.9 under 128,000 lux): the
    // 99th percentile must stay below 4 x mid-grey.
    fill(h, 30000, 36000, 0.03 * N);
    const prot = meter(h);
    const p99 = histogramStats(h, N).p99;
    expect(p99 * exposureFromEv100(prot.targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    expect(prot.targetEv100).toBeGreaterThan(base.targetEv100);
  });

  it('a bright area in a dark frame is exposed for as soon as it covers 2 % (request vfx-3)', () => {
    // A night launch seen from the pad: nothing lit by the sun, the cloud the plume lights (2,000 to
    // 20,000 cd/m^2) on 2.5 % of the frame, the rest unlit ground.
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 2e3, 2e4, 2500);
    const night = { sunVisibility: 0, litObjectInView: false };
    const r = meter(h, night);
    expect(r.evPrior).toBe(EV_DARK_FLOOR);
    expect(r.histogramWeight).toBe(1);
    expect(r.targetEv100).toBeCloseTo(r.evHistogram, 9);
    expect(r.targetEv100).toBeGreaterThan(12);
    // (It used to be weighted 0.09 against the dark floor: EV100 -1.4, the plume a white area for seconds.)
    // Half of that area is half-way there; under 0.5 % it is still the prior alone.
    const small = new Uint32Array(HISTOGRAM_BINS);
    fill(small, 2e3, 2e4, 400);
    expect(meter(small, night).histogramWeight).toBe(0);
    const mid = new Uint32Array(HISTOGRAM_BINS);
    fill(mid, 2e3, 2e4, 1250);
    expect(meter(mid, night).histogramWeight).toBeGreaterThan(0.3);
    expect(meter(mid, night).histogramWeight).toBeLessThan(0.7);
    // A lit area DIMMER than the prior keeps the slow ramp: 2.5 % of a sunlit frame in deep shade
    // (20 to 200 cd/m^2 against sunny 16) opens the exposure by less than a stop, as before.
    const shade = new Uint32Array(HISTOGRAM_BINS);
    fill(shade, 20, 200, 2500);
    const day = meter(shade);
    expect(day.evHistogram).toBeLessThan(day.evPrior);
    expect(day.histogramWeight).toBeLessThan(0.15);
    expect(day.evPrior - day.targetEv100).toBeLessThan(1);
  });

  it('honours exposure compensation, minEv100 and interior metering', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 2000, 6000, 0.9 * N);
    const base = meter(h).targetEv100;
    expect(meter(h, { exposureCompensation: 1 }).targetEv100).toBeCloseTo(base - 1, 9);
    expect(meter(new Uint32Array(HISTOGRAM_BINS), { litObjectInView: false, minEv100: 4 }).targetEv100).toBe(4);
    // Cabin: a dim interior (near histogram) with blown-out windows in the full histogram (the seat's
    // view: under a tenth of the frame; from there up what is seen through them counts, request cockpit-7).
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 5, 40, 0.7 * N);
    const all = new Uint32Array(near);
    fill(all, 20000, 40000, 0.08 * N);
    const interior = meter(all, { histogramNear: near, kind: 'interior' });
    const exterior = meter(all, { histogramNear: near, kind: 'external' });
    expect(interior.targetEv100).toBeLessThan(exterior.targetEv100 - 5);
    // The cabin is keyed low under windows that bright (request cockpit-16): about two stops under mid-grey.
    const cabinMean = histogramStats(near, N).mean;
    expect(cabinMean * exposureFromEv100(interior.targetEv100)).toBeGreaterThan(0.03);
    expect(cabinMean * exposureFromEv100(interior.targetEv100)).toBeLessThan(0.1);
    // Without windows it sits around mid-grey.
    const closed = meter(near, { histogramNear: near, kind: 'interior' });
    expect(cabinMean * exposureFromEv100(closed.targetEv100)).toBeGreaterThan(0.08);
    expect(cabinMean * exposureFromEv100(closed.targetEv100)).toBeLessThan(0.4);
  });

  it('an emitter over the sky sets the exposure by its coverage (request vfx-1)', () => {
    // Night, nothing lit in view: the dark-adapted floor.
    const empty = new Uint32Array(HISTOGRAM_BINS);
    const night = { sunVisibility: 0, litObjectInView: false };
    expect(meter(empty, night).targetEv100).toBe(EV_DARK_FLOOR);
    // A reentry trail of 26,000 cd/m^2 over 2 % of the frame: exposed so that it stays under 4 x mid-grey.
    const trail = meter(empty, { ...night, emissive: [{ luminance: 26000, coverage: 0.02 }] });
    const shown = 26000 * exposureFromEv100(trail.targetEv100);
    expect(shown).toBeGreaterThan(0.3);
    expect(shown).toBeLessThanOrEqual(4 * 0.18 * 1.05);
    // RCS jets over 0.1 % of the frame move it part of the way; a speck (0.01 %) leaves the floor alone.
    const jets = meter(empty, { ...night, emissive: [{ luminance: 22000, coverage: 0.001 }] }).targetEv100;
    expect(jets).toBeGreaterThan(EV_DARK_FLOOR + 0.3);
    expect(jets).toBeLessThan(trail.targetEv100 - 3);
    expect(meter(empty, { ...night, emissive: [{ luminance: 22000, coverage: 0.0001 }] }).targetEv100).toBe(EV_DARK_FLOOR);
    // More coverage never exposes brighter, and several hints add up.
    let last = -Infinity;
    for (const c of [0.0005, 0.002, 0.005, 0.01, 0.05]) {
      const ev = meter(empty, { ...night, emissive: [{ luminance: 22000, coverage: c }] }).targetEv100;
      expect(ev).toBeGreaterThanOrEqual(last);
      last = ev;
    }
    expect(meter(empty, { ...night, emissive: [{ luminance: 22000, coverage: 0.005 }, { luminance: 22000, coverage: 0.005 }] }).targetEv100).toBeCloseTo(
      meter(empty, { ...night, emissive: [{ luminance: 22000, coverage: 0.01 }] }).targetEv100,
      9,
    );
    // Daylight: an emitter dimmer than the sunlit scene changes nothing; it counts like lit geometry of
    // its luminance, so a plume over the sky is metered as the same plume over the ground is.
    const day = new Uint32Array(HISTOGRAM_BINS);
    fill(day, 2000, 6000, 0.6 * N);
    const base = meter(day).targetEv100;
    expect(meter(day, { emissive: [{ luminance: 3000, coverage: 0.03 }] }).targetEv100).toBeCloseTo(base, 1);
    const overGround = new Uint32Array(day);
    overGround[luminanceBin(200000)] = overGround[luminanceBin(200000)]! + 0.03 * N;
    expect(meter(day, { emissive: [{ luminance: 200000, coverage: 0.03 }] }).targetEv100).toBeCloseTo(meter(overGround).targetEv100, 6);
    // An interior view meters its cabin and ignores emitters outside.
    const cabin = new Uint32Array(HISTOGRAM_BINS);
    fill(cabin, 20, 45, 0.6 * N);
    expect(meter(cabin, { histogramNear: cabin, kind: 'interior', emissive: [{ luminance: 1e6, coverage: 0.1 }] }).targetEv100).toBe(meter(cabin, { histogramNear: cabin, kind: 'interior' }).targetEv100);
  });

  it('interior metering keeps the cabin readable when a sun patch falls into it (request cockpit-3)', () => {
    // 95 % of the near pixels are cabin at 20-45 cd/m^2, 5 % are a sun patch on a panel at 14,000-20,000.
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 20, 45, 0.95 * 0.6 * N);
    fill(near, 14000, 20000, 0.05 * 0.6 * N);
    const cabin = new Uint32Array(HISTOGRAM_BINS);
    fill(cabin, 20, 45, 0.6 * N);
    const withPatch = meter(near, { histogramNear: near, kind: 'interior' });
    const without = meter(cabin, { histogramNear: cabin, kind: 'interior' });
    // The patch stops the camera down, but by a bounded amount (requests cockpit-5 and -6: at most
    // INTERIOR_HIGHLIGHT_MAX_EV above the cabin's own target), so the cabin stays readable, a stop to two
    // under mid-grey as in a photograph taken inside with sun in the frame ...
    expect(withPatch.targetEv100 - without.targetEv100).toBeGreaterThan(1);
    expect(withPatch.targetEv100 - without.targetEv100).toBeLessThanOrEqual(INTERIOR_HIGHLIGHT_MAX_EV + 0.8);
    const cabinAt = 30 * exposureFromEv100(withPatch.targetEv100);
    expect(cabinAt).toBeGreaterThan(0.05);
    expect(cabinAt).toBeLessThan(0.12);
    // ... while a patch 600 times brighter than the cabin still blows out (far above white).
    expect(17000 * exposureFromEv100(withPatch.targetEv100)).toBeGreaterThan(20);
    // The statistic is the log-average of the whole near histogram: dark corners count too.
    const stats = histogramStats(near, N, Infinity);
    expect(stats.logMean).toBeGreaterThan(30);
    expect(stats.logMean).toBeLessThan(50);
    expect(stats.mean).toBeGreaterThan(700);
    // An exterior view of the same pixels still exposes for the bright part (a lit object on black).
    expect(meter(near, { kind: 'external' }).targetEv100).toBeGreaterThan(withPatch.targetEv100 + 3);
    // A uniform cabin meters the same either way (log-average = mean).
    const flat = new Uint32Array(HISTOGRAM_BINS);
    flat[luminanceBin(30)] = 0.6 * N;
    expect(histogramStats(flat, N, Infinity).logMean).toBeCloseTo(histogramStats(flat, N).mean, 6);
  });
});

describe('highlight protection is bounded while the sun lights the scene (request vfx-4)', () => {
  const day = (): Uint32Array => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 2000, 6000, 0.9 * N); // sunlit ground
    return h;
  };
  const evSun = sunny16Ev(SUN);

  it('lit pixels far brighter than sunlit white clip instead of darkening the day', () => {
    const base = meter(day()).targetEv100;
    // Steam and ground lit by a plume (and anything else that is geometry and brighter than the sun makes
    // it): 3 % of the frame at 300,000 to 1,000,000 cd/m^2.
    const h = day();
    fill(h, 3e5, 1e6, 0.03 * N);
    const lit = meter(h).targetEv100;
    expect(SUNLIT_HIGHLIGHT_MAX_EV).toBe(0.5);
    expect(lit).toBeLessThanOrEqual(evSun + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
    expect(lit).toBeGreaterThanOrEqual(base);
    // The bright patch is two stops and more over white: it clips, and the day stays a day (sunlit ground
    // of albedo 0.1 no darker than two stops under mid-grey).
    expect(3e5 * exposureFromEv100(lit)).toBeGreaterThan(4);
    expect(4000 * exposureFromEv100(lit)).toBeGreaterThan(0.18 / 4);
    // Sunlit white itself (0.9 x 128,000 / pi cd/m^2) on a twentieth of the frame is protected by the highlight
    // term up to SUNLIT_SPOT_MAX_EV over the prior (request vfx-8): it sits within a tenth of 4 x mid-grey.
    const white = day();
    fill(white, 33000, 36700, 0.05 * N);
    expect(meter(white).targetEv100).toBeCloseTo(evSun + SUNLIT_SPOT_MAX_EV, 9);
    expect(histogramStats(white, N).p99 * exposureFromEv100(meter(white).targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.1);
    // A frame that is white as a whole is held under 4 x mid-grey by its mean, up to the half stop.
    const snow = new Uint32Array(HISTOGRAM_BINS);
    fill(snow, 30000, 36700, 0.9 * N);
    expect(meter(snow).targetEv100).toBeCloseTo(evSun + SUNLIT_HIGHLIGHT_MAX_EV, 9);
  });

  it('an emitter over the sky is bounded alike by day', () => {
    const base = meter(day()).targetEv100;
    const flame = meter(day(), { emissive: [{ luminance: 5e6, coverage: 0.05 }] }).targetEv100;
    expect(flame).toBeLessThanOrEqual(evSun + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
    expect(flame).toBeGreaterThanOrEqual(base);
    // Over an empty daylight sky (nothing else lit in the frame) the same: the prior is the sun's.
    const sky = meter(new Uint32Array(HISTOGRAM_BINS), { emissive: [{ luminance: 5e6, coverage: 0.05 }] }).targetEv100;
    expect(sky).toBeLessThanOrEqual(evSun + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
    expect(sky).toBeGreaterThanOrEqual(evSun);
  });

  it('at night, in an eclipse and under a sliver of sun the protection is whole', () => {
    const night = { sunVisibility: 0, litObjectInView: false };
    // The plume-lit pad of a night launch: exposed so that its 99th percentile stays under 4 x mid-grey.
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, 2e3, 2e4, 0.05 * N);
    const pad = meter(h, night);
    expect(histogramStats(h, N).p99 * exposureFromEv100(pad.targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    // An emitter over the night sky, as before (request vfx-1).
    const trail = meter(new Uint32Array(HISTOGRAM_BINS), { ...night, emissive: [{ luminance: 26000, coverage: 0.02 }] });
    expect(26000 * exposureFromEv100(trail.targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.05);
    // 3 % of the solar disc over the limb: the scene is not sunlit in the sense of the bound.
    const sliver = meter(h, { sunVisibility: 0.03 });
    expect(histogramStats(h, N).p99 * exposureFromEv100(sliver.targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    // From a third of the disc on the bound is whole; between 5 % and 30 % it comes in gradually.
    const bright = new Uint32Array(HISTOGRAM_BINS);
    fill(bright, 2e4, 4e4, 0.05 * N);
    const third = meter(bright, { sunVisibility: 0.3 }).targetEv100;
    expect(third).toBeLessThanOrEqual(sunny16Ev(SUN * 0.3) + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
    const tenth = meter(bright, { sunVisibility: 0.1 }).targetEv100;
    expect(tenth).toBeGreaterThan(sunny16Ev(SUN * 0.1) + SUNLIT_HIGHLIGHT_MAX_EV);
    expect(tenth).toBeLessThan(meter(bright, { sunVisibility: 0.03 }).targetEv100);
  });
});

describe('the exposure is bounded from below as well while the sun lights the scene (request vfx-7)', () => {
  const evSun = sunny16Ev(SUN);
  /** Luminance of a Lambert surface of the given albedo square to the sun, cd/m^2. */
  const sunlit = (albedo: number): number => (albedo * SUN) / Math.PI;
  /**
   * A lift-off seen by the chase camera once the lit pad has left the frame: dark ground, the vehicle's shaded
   * side and `hull` pixels (of 100,000) of its sunlit side. Under 1 % of the lit pixels the highlight cap does
   * not see the hull and the meter exposes for the ground.
   */
  const chase = (hull: number): Uint32Array => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, sunlit(0.02), sunlit(0.05), 30000);
    fill(h, sunlit(0.03), sunlit(0.1), 2000);
    if (hull > 0) fill(h, sunlit(0.4), sunlit(0.85), hull);
    return h;
  };
  const HIGH = Math.sin((50 * Math.PI) / 180);

  it('a daylight frame of dark ground and a sunlit hull stays within half a stop of sunny 16', () => {
    const before = meter(chase(250)).targetEv100;
    const held = meter(chase(250), { sunElevationSin: HIGH });
    // The meter alone opens up by more than a stop (what the critics measured as 1.3 EV of pumping).
    expect(before).toBeLessThan(evSun - 1);
    expect(SUNLIT_SHADOW_MIN_EV).toBe(0.5);
    expect(held.sunlitFloor).toBe(1);
    expect(held.targetEv100).toBeCloseTo(evSun - SUNLIT_SHADOW_MIN_EV, 9);
    // The pad in the frame (a tenth of it sunlit concrete) and the pad gone: half a stop apart at most.
    const pad = chase(250);
    fill(pad, sunlit(0.2), sunlit(0.4), 30000);
    const withPad = meter(pad, { sunElevationSin: HIGH }).targetEv100;
    expect(Math.abs(withPad - held.targetEv100)).toBeLessThanOrEqual(1);
    expect(withPad).toBeGreaterThanOrEqual(evSun - SUNLIT_SHADOW_MIN_EV - 1e-9);
    expect(withPad).toBeLessThanOrEqual(evSun + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
  });

  it('a frame at or above sunny 16 is left alone, and the upper bound still holds', () => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, sunlit(0.3), sunlit(0.9), 50000);
    expect(meter(h, { sunElevationSin: HIGH }).targetEv100).toBe(meter(h).targetEv100);
    fill(h, sunlit(40), sunlit(90), 4000);
    expect(meter(h, { sunElevationSin: HIGH }).targetEv100).toBeLessThanOrEqual(evSun + SUNLIT_HIGHLIGHT_MAX_EV + 1e-9);
  });

  it('needs sunlit surfaces in the frame: an overcast, the shadow side of a hull, the night side from a sunlit orbit open up as before', () => {
    // Overcast: everything at a fifth of the light, a white hull included.
    const overcast = new Uint32Array(HISTOGRAM_BINS);
    fill(overcast, sunlit(0.2 * 0.05), sunlit(0.2 * 0.4), 60000);
    fill(overcast, sunlit(0.2 * 0.5), sunlit(0.2 * 0.85), 2000);
    const o = meter(overcast, { sunElevationSin: HIGH });
    expect(o.sunlitFloor).toBe(0);
    expect(o.targetEv100).toBe(meter(overcast).targetEv100);
    expect(o.targetEv100).toBeLessThan(evSun - 1.5);
    // A hull seen from its shadow side, lit by the planet: about three stops under the sun.
    const shade = new Uint32Array(HISTOGRAM_BINS);
    fill(shade, sunlit(0.02), sunlit(0.1), 15000);
    expect(meter(shade, { sunElevationSin: HIGH }).targetEv100).toBe(meter(shade).targetEv100);
    // City lights under a camera that is itself in the sun: the sun is below the ground's horizon.
    const night = new Uint32Array(HISTOGRAM_BINS);
    fill(night, 0.05, 8, 40000);
    expect(meter(night, { sunElevationSin: -0.4, litObjectInView: false }).targetEv100).toBe(meter(night, { litObjectInView: false }).targetEv100);
    // A sliver of sunlit hull comes in gradually: no step.
    let prev = meter(chase(0), { sunElevationSin: HIGH }).targetEv100;
    expect(prev).toBe(meter(chase(0)).targetEv100);
    for (let hull = 10; hull <= 300; hull += 10) {
      const ev = meter(chase(hull), { sunElevationSin: HIGH }).targetEv100;
      expect(ev).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(ev - prev, `${hull} px`).toBeLessThan(0.3);
      prev = ev;
    }
    expect(prev).toBeCloseTo(evSun - SUNLIT_SHADOW_MIN_EV, 9);
  });

  it('needs the sun well above the horizon: a low sun (a lunar landing at 8 degrees, dawn) is metered as before', () => {
    const h = chase(250);
    const sin = (deg: number): number => Math.sin((deg * Math.PI) / 180);
    expect(SUNLIT_ELEVATION_MIN).toBeCloseTo(sin(10), 3);
    expect(SUNLIT_ELEVATION_FULL).toBeCloseTo(sin(25), 3);
    expect(meter(h, { sunElevationSin: sin(8) }).targetEv100).toBe(meter(h).targetEv100);
    expect(meter(h, { sunElevationSin: sin(-5) }).targetEv100).toBe(meter(h).targetEv100);
    const mid = meter(h, { sunElevationSin: sin(17) }).targetEv100;
    expect(mid).toBeGreaterThan(meter(h).targetEv100);
    expect(mid).toBeLessThan(evSun - SUNLIT_SHADOW_MIN_EV);
    expect(meter(h, { sunElevationSin: sin(25) }).targetEv100).toBeCloseTo(evSun - SUNLIT_SHADOW_MIN_EV, 9);
    // Without the elevation (a caller that cannot tell) there is no bound.
    expect(meter(h).sunlitFloor).toBe(0);
  });

  it('does not touch night, twilight below the gate, an eclipse or a cabin', () => {
    const h = chase(250);
    for (const over of [{ sunVisibility: 0 }, { sunVisibility: 0.04 }, { kind: 'interior' as const, histogramNear: h }]) {
      const a = meter(h, { ...over, sunElevationSin: HIGH });
      const b = meter(h, over);
      expect(a.sunlitFloor).toBe(0);
      expect(a.targetEv100).toBe(b.targetEv100);
    }
    // Under a third of the disc the bound is whole and follows the dimmer sun.
    const third = new Uint32Array(HISTOGRAM_BINS);
    fill(third, 0.3 * sunlit(0.02), 0.3 * sunlit(0.05), 30000);
    fill(third, 0.3 * sunlit(0.4), 0.3 * sunlit(0.85), 250);
    expect(meter(third, { sunVisibility: 0.3, sunElevationSin: HIGH }).targetEv100).toBeCloseTo(sunny16Ev(SUN * 0.3) - SUNLIT_SHADOW_MIN_EV, 9);
  });
});

describe('what is brighter than the sun can light anything moves a daylight exposure by a quarter stop at most (request vfx-8)', () => {
  const evSun = sunny16Ev(SUN);
  const sunlit = (albedo: number): number => (albedo * SUN) / Math.PI;
  /** A daylight pad: concrete, grass, a white vehicle. */
  const pad = (): Uint32Array => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, sunlit(0.08), sunlit(0.35), 0.6 * N);
    fill(h, sunlit(0.5), sunlit(0.85), 0.02 * N);
    return h;
  };

  it('the apron under the flame of a daylight lift-off: in the frame or gone, the target moves by 0.25 EV at most', () => {
    const gone = meter(pad()).targetEv100;
    // 4 % of the lit pixels take more light from the flame than from the sun: 5 to 40 times sunlit white.
    const lit = pad();
    fill(lit, sunlit(5), sunlit(40), 0.025 * N);
    const there = meter(lit).targetEv100;
    expect(SUNLIT_SPOT_MAX_EV).toBe(0.25);
    expect(there - gone).toBeLessThanOrEqual(SUNLIT_SPOT_MAX_EV + 1e-9);
    expect(there).toBeGreaterThanOrEqual(gone);
    // The upper bound alone let it ride half a stop up (0.57 EV in the lab's sequence): the sky pumped when the pad left.
    expect(evSun + SUNLIT_HIGHLIGHT_MAX_EV - gone).toBeGreaterThan(0.4);
    // The outer ring of the apron, at or under sunlit white (not told from it by its luminance): the same bound.
    const ring = pad();
    fill(ring, sunlit(0.8), sunlit(1.4), 0.03 * N);
    expect(meter(ring).targetEv100).toBeLessThanOrEqual(evSun + SUNLIT_SPOT_MAX_EV + 1e-9);
    expect(meter(ring).targetEv100 - gone).toBeLessThan(0.3);
    expect(meter(ring).targetEv100).toBeGreaterThan(gone);
    // With the flame's own hint on top: the same.
    const flame = meter(lit, { emissive: [{ luminance: 3e6, coverage: 0.03 }] }).targetEv100;
    expect(flame - gone).toBeLessThanOrEqual(SUNLIT_SPOT_MAX_EV + 1e-9);
    // And over an empty daylight sky the hint raises the prior by no more.
    const sky = meter(new Uint32Array(HISTOGRAM_BINS), { emissive: [{ luminance: 3e6, coverage: 0.05 }] }).targetEv100;
    expect(sky - evSun).toBeLessThanOrEqual(SUNLIT_SPOT_MAX_EV + 1e-9);
    expect(sky).toBeGreaterThanOrEqual(evSun);
  });

  it('a frame full of sunlit cloud or snow keeps its half stop, and sunlit white is protected as before', () => {
    const snow = new Uint32Array(HISTOGRAM_BINS);
    fill(snow, sunlit(0.6), sunlit(0.95), 0.9 * N);
    expect(meter(snow).targetEv100).toBeCloseTo(evSun + SUNLIT_HIGHLIGHT_MAX_EV, 9);
    // A twentieth of the frame at white (with its share of sky light, or in the outer light of a flame: the
    // meter cannot tell): the highlight term raises the target by a quarter stop over the prior, not by a half.
    const bright = pad();
    fill(bright, sunlit(1.0), sunlit(1.2), 0.05 * N);
    const ev = meter(bright).targetEv100;
    expect(ev).toBeCloseTo(evSun + SUNLIT_SPOT_MAX_EV, 9);
  });

  it('does not touch night, twilight below the gate or a cabin: the ground a flame lights is what a night camera exposes for', () => {
    // Ground at the brightness of sunlit white and above, lit by a flame alone.
    const lit = new Uint32Array(HISTOGRAM_BINS);
    fill(lit, 50, 400, 0.3 * N);
    fill(lit, sunlit(0.8), sunlit(1.2), 0.025 * N);
    const night = { sunVisibility: 0, litObjectInView: false };
    const a = meter(lit, night).targetEv100;
    // The 99th percentile of the lit pixels is held under 4 x mid-grey: the flame-lit ground sets the exposure.
    expect(histogramStats(lit, N).p99 * exposureFromEv100(a)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    expect(a).toBeGreaterThan(sunny16Ev(SUN) + SUNLIT_HIGHLIGHT_MAX_EV);
    const sliver = meter(lit, { sunVisibility: 0.04 }).targetEv100;
    expect(histogramStats(lit, N).p99 * exposureFromEv100(sliver)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    // A cabin meters its near geometry by its own rules.
    const cabin = { kind: 'interior' as const, histogramNear: lit };
    expect(meter(lit, cabin).targetEv100).toBeLessThan(a);
  });
});

describe('a cut between views takes the new exposure at once (request cockpit-14)', () => {
  it('eleven stops from a sunlit exterior to the cabin in a third of a second, where the eye-like adaptation takes three', () => {
    let cut = 15;
    let eye = 15;
    let t = 0;
    let cutAt = Infinity;
    let eyeAt = Infinity;
    for (; t < 6; t += 1 / 60) {
      cut = adaptEv100Cut(cut, 4, 1 / 60);
      eye = adaptEv100(eye, 4, 1 / 60);
      if (cut - 4 < 0.3 && cutAt === Infinity) cutAt = t;
      if (eye - 4 < 0.3 && eyeAt === Infinity) eyeAt = t;
    }
    expect(cutAt).toBeLessThan(0.3);
    expect(cutAt).toBeLessThan(CUT_ADAPT_SECONDS / 2);
    expect(eyeAt).toBeGreaterThan(3);
  });

  it('both ways, through the dark range, and exactly on a target that is reached', () => {
    // Cabin to a sunlit exterior.
    let ev = 4;
    for (let i = 0; i < 20; i++) ev = adaptEv100Cut(ev, 15, 1 / 60);
    expect(15 - ev).toBeLessThan(0.1);
    // Into a dark view: the dark adaptation's 0.12 EV/s is an eye's, a cut does not wait for it.
    ev = 2;
    for (let i = 0; i < 30; i++) ev = adaptEv100Cut(ev, -6, 1 / 60);
    expect(ev + 6).toBeLessThan(0.01);
    expect(adaptEv100Cut(7, 7, 1 / 60)).toBe(7);
    expect(adaptEv100Cut(7, 3, 0)).toBe(7);
    // It never overshoots, whatever the frame time.
    expect(adaptEv100Cut(15, 4, 1)).toBeGreaterThanOrEqual(4);
  });
});

describe('interior metering: night key and bounded highlights (request cockpit-5)', () => {
  const cabinAt = (lo: number, hi: number, share = 0.6): Uint32Array => {
    const h = new Uint32Array(HISTOGRAM_BINS);
    fill(h, lo, hi, share * N);
    return h;
  };
  const interior = (near: Uint32Array, over: Partial<MeterInput> = {}): ReturnType<typeof meterExposure> => meter(near, { histogramNear: near, kind: 'interior', ...over });
  const shown = (luminance: number, ev: number): number => luminance * exposureFromEv100(ev);
  const inShadow = { sunVisibility: 0 };

  it('a cabin lit by its floods and displays alone, out of the sun, is displayed dim; a daylit one at mid-grey', () => {
    // Night pass: log-mean about 3 cd/m^2. Noon on the pad: about 200 cd/m^2.
    const night = cabinAt(1.5, 6);
    const noon = cabinAt(120, 330);
    const nightLevel = shown(histogramStats(night, N, Infinity).logMean, interior(night, inShadow).targetEv100);
    const noonLevel = shown(histogramStats(noon, N, Infinity).logMean, interior(noon).targetEv100);
    // The key belongs to the dark (request cockpit-6): a cabin that is as dim by DAY (small windows, a sky
    // of thousands of cd/m^2 outside) keeps the plain log-average; with half the solar disc, half the key.
    const dimByDay = interior(night).targetEv100;
    expect(interior(night, inShadow).targetEv100 - dimByDay).toBeCloseTo(INTERIOR_NIGHT_KEY_EV, 1);
    expect(interior(night, { sunVisibility: 0.5 }).targetEv100 - dimByDay).toBeCloseTo(0.5 * INTERIOR_NIGHT_KEY_EV, 1);
    expect(shown(histogramStats(night, N, Infinity).logMean, dimByDay)).toBeGreaterThan(0.15);
    // No star at all (illuminance 0) counts as dark whatever the visibility says.
    expect(interior(night, { sunIlluminance: 0 }).targetEv100).toBeCloseTo(interior(night, inShadow).targetEv100, 9);
    // The full key at and below 4 cd/m^2: INTERIOR_NIGHT_KEY_EV under what the log-average alone gives.
    expect(INTERIOR_NIGHT_KEY_EV).toBe(1.5);
    expect(nightLevel).toBeLessThan(0.5 * noonLevel);
    expect(nightLevel).toBeGreaterThan(0.04);
    expect(nightLevel).toBeLessThan(0.09);
    expect(noonLevel).toBeGreaterThan(0.15);
    // No key from 64 cd/m^2 up, the whole of it at 4 cd/m^2 and below, monotonic in between.
    let last = Infinity;
    for (const l of [2, 4, 8, 16, 32, 64, 128]) {
      const h = new Uint32Array(HISTOGRAM_BINS);
      h[luminanceBin(l)] = 0.6 * N;
      const level = shown(binLuminance(luminanceBin(l)), interior(h, inShadow).targetEv100);
      const plain = 0.18 * 2 ** exposureCompensationCurve(ev100ForMidGrey(binLuminance(luminanceBin(l))));
      const key = Math.log2(plain / level);
      // (The bins are an eighth of a stop wide: the bin that holds 4 cd/m^2 is centred a little above it.)
      if (l <= 4) expect(key).toBeCloseTo(INTERIOR_NIGHT_KEY_EV, 2);
      if (l >= 64) expect(key).toBeCloseTo(0, 2);
      expect(key).toBeLessThanOrEqual(last + 1e-9);
      last = key;
    }
  });

  it('highlights of the cabin weigh in, by a bounded amount', () => {
    const cabin = cabinAt(20, 45);
    const base = interior(cabin).targetEv100;
    // Sunlit hardware next to a window, 100 times the cabin (5 % of the near pixels): kept under
    // INTERIOR_HIGHLIGHT_CAP x mid-grey, the cabin about a stop under mid-grey.
    const lit = new Uint32Array(cabin);
    fill(lit, 2800, 3200, 0.05 * 0.6 * N);
    const withLit = interior(lit).targetEv100;
    const p99 = histogramStats(lit, N, Infinity).p99;
    expect(shown(p99, withLit)).toBeLessThanOrEqual(INTERIOR_HIGHLIGHT_CAP * 0.18 * 1.001);
    // (Against the cabin alone the target moves by the highlight term plus what the bright pixels add to
    // the log-average itself, about a third of a stop here.)
    expect(INTERIOR_HIGHLIGHT_MAX_EV).toBe(1.25);
    expect(withLit - base).toBeGreaterThan(0.6);
    // (3 % of the frame at 100 times the cabin is a bright area of request cockpit-12: a little more.)
    expect(withLit - base).toBeLessThan(INTERIOR_BRIGHT_MAX_EV);
    expect(shown(30, withLit)).toBeGreaterThan(0.05);
    // A sun patch 600 times the cabin: the bound holds, the cabin stays readable.
    const patch = new Uint32Array(cabin);
    fill(patch, 14000, 20000, 0.05 * 0.6 * N);
    const withPatch = interior(patch).targetEv100;
    expect(withPatch - base).toBeGreaterThan(INTERIOR_HIGHLIGHT_MAX_EV - 0.01);
    expect(withPatch - base).toBeLessThan(INTERIOR_HIGHLIGHT_MAX_EV + 0.8);
    expect(shown(30, withPatch)).toBeGreaterThan(0.05);
    // Highlights up to 48 times mid-grey need no protection: 30 times the cabin moves the target only by
    // what it adds to the log-average.
    const mild = new Uint32Array(cabin);
    fill(mild, 800, 1100, 0.05 * 0.6 * N);
    expect(interior(mild).targetEv100 - base).toBeLessThan(0.3);
    // A handful of bright pixels (0.5 % of the near pixels) is below the 99th percentile: nothing moves.
    const speck = new Uint32Array(cabin);
    fill(speck, 14000, 20000, 0.005 * 0.6 * N);
    expect(interior(speck).targetEv100 - base).toBeLessThan(0.1);
    // Exterior metering does not know these rules.
    expect(meter(lit, { kind: 'external' }).targetEv100).toBe(meter(lit, { kind: 'map' }).targetEv100);
  });
});

describe('quality governor and dynamic resolution', () => {
  const cfg = DEFAULT_GOVERNOR;
  const run = (s: GovernorState, ms: (s: GovernorState) => number, frames: number): GovernorState => {
    let st = s;
    for (let i = 0; i < frames; i++) st = governorStep(st, ms(st), cfg);
    return st;
  };
  // A frame whose cost is 6 ms fixed + a part that scales with quality and with pixel count.
  const cost = (scalable: number) => (s: GovernorState): number => 6 * s.renderScale ** 2 + scalable * s.qualityScale * s.renderScale ** 2;

  it('does nothing while the frame is comfortably inside the budget', () => {
    const s = run(initialGovernorState(cfg), () => 8.5, 300);
    expect(s.qualityScale).toBe(1);
    expect(s.renderScale).toBe(1);
  });

  it('lowers qualityScale before touching the resolution', () => {
    let s = initialGovernorState(cfg);
    const seen: GovernorState[] = [];
    for (let i = 0; i < 400; i++) {
      s = governorStep(s, cost(8)(s), cfg);
      seen.push(s);
    }
    const firstRes = seen.findIndex((x) => x.renderScale < 1);
    const firstQ = seen.findIndex((x) => x.qualityScale < 1);
    expect(firstQ).toBeGreaterThanOrEqual(0);
    // 6 + 8 q <= 10.1 ms has a solution at q = 0.51: the resolution never needs to drop.
    expect(firstRes).toBe(-1);
    expect(s.qualityScale).toBeGreaterThanOrEqual(0.5);
    expect(cost(8)(s)).toBeLessThan(cfg.budgetMs);
  });

  it('drops the resolution only when quality is at its minimum, and holds the budget', () => {
    let s = initialGovernorState(cfg);
    const seen: GovernorState[] = [];
    for (let i = 0; i < 600; i++) {
      s = governorStep(s, cost(16)(s), cfg);
      seen.push(s);
    }
    const firstRes = seen.findIndex((x) => x.renderScale < 1);
    expect(firstRes).toBeGreaterThan(0);
    expect(seen[firstRes - 1]!.qualityScale).toBeCloseTo(0.5, 9);
    expect(s.renderScale).toBeLessThan(1);
    expect(s.renderScale).toBeGreaterThanOrEqual(cfg.renderScaleMin);
    expect(cost(16)(s)).toBeLessThan(cfg.budgetMs);
    // Settled: no oscillation over the last 200 frames.
    const tail = seen.slice(-200);
    expect(new Set(tail.map((x) => `${x.renderScale}|${x.qualityScale.toFixed(3)}`)).size).toBeLessThanOrEqual(2);
  });

  it('recovers with hysteresis: resolution first, then quality, without overshooting back into pressure', () => {
    let s = run(initialGovernorState(cfg), cost(16), 600);
    expect(s.renderScale).toBeLessThan(1);
    // The heavy load goes away.
    const seen: GovernorState[] = [];
    for (let i = 0; i < 1200; i++) {
      s = governorStep(s, cost(1)(s), cfg);
      seen.push(s);
    }
    expect(s.renderScale).toBe(1);
    expect(s.qualityScale).toBe(1);
    const resBack = seen.findIndex((x) => x.renderScale === 1);
    expect(seen[resBack]!.qualityScale).toBeCloseTo(0.5, 9);
    // In the dead band between recovery and pressure nothing moves.
    const mid = governorStep({ qualityScale: 0.7, renderScale: 0.75, cooldown: 0, smoothedMs: 9 }, 9, cfg);
    expect(mid.qualityScale).toBe(0.7);
    expect(mid.renderScale).toBe(0.75);
  });
});

describe('Hapke inversion table and black-body table', () => {
  it('inverts the Hapke function at the normalisation geometry', () => {
    const lut = buildHapkeLut(DEFAULT_HAPKE);
    for (const i of [10, 30, 60, 90]) {
      const albedo = i / 255;
      expect(hapkeAlbedoAtNorm(lut[i]!, DEFAULT_HAPKE)).toBeCloseTo(albedo, 5);
    }
    // Highlands (albedo about 0.16) and maria (about 0.07) land near the published single-scattering albedos.
    expect(lut[Math.round(0.16 * 255)]!).toBeGreaterThan(0.25);
    expect(lut[Math.round(0.16 * 255)]!).toBeLessThan(0.6);
    expect(lut[Math.round(0.07 * 255)]!).toBeGreaterThan(0.1);
    expect(lut[Math.round(0.07 * 255)]!).toBeLessThan(0.35);
    for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
  });
  it('gives the opposition surge and a Lommel-Seeliger limb', () => {
    const w = 0.3;
    const zero = hapkeBrdfMu0(w, 1, 1, 0, DEFAULT_HAPKE);
    const ten = hapkeBrdfMu0(w, Math.cos(0.17), 1, 0.17, DEFAULT_HAPKE);
    expect(zero).toBeGreaterThan(ten * 1.3);
    // Full-moon geometry (phase 0): the limb (mu = mu0 -> 0) is not darker than half of the centre, unlike Lambert.
    const centre = hapkeBrdfMu0(w, 1, 1, 0, DEFAULT_HAPKE);
    const limb = hapkeBrdfMu0(w, 0.1, 0.1, 0, DEFAULT_HAPKE);
    expect(limb).toBeGreaterThan(0.45 * centre);
    expect(HAPKE_NORM.mu).toBe(1);
  });
  it('black-body luminance rises steeply with temperature and reddens when cool', () => {
    const a = blackbodyRadiance(1000);
    const b = blackbodyRadiance(2000);
    const c = blackbodyRadiance(2856);
    expect(b.luminance / a.luminance).toBeGreaterThan(1000);
    // Tungsten at 2856 K is of the order of 1e7 cd/m^2.
    expect(c.luminance).toBeGreaterThan(5e6);
    expect(c.luminance).toBeLessThan(5e7);
    expect(a.color[0]).toBeGreaterThan(a.color[2] * 10);
    expect(c.color[0]).toBeGreaterThan(c.color[2]);
  });
});

describe('interior metering: bright areas of a few per cent of the frame (request cockpit-12)', () => {
  const level = (luminance: number, ev: number): number => 255 * srgbEncode(displayLinear([luminance * exposureFromEv100(ev), luminance * exposureFromEv100(ev), luminance * exposureFromEv100(ev)])[1]);
  it('a 5 % sun patch 6 EV over the cabin is brought into the shoulder; the cabin stays readable', () => {
    // Cabin at 30 cd/m^2 over 95 % of the frame, a patch on the console at 64 x that over 5 %.
    const cabin = new Uint32Array(HISTOGRAM_BINS);
    cabin[luminanceBin(30)] = 0.95 * N;
    const withPatch = Uint32Array.from(cabin);
    withPatch[luminanceBin(30 * 64)] = 0.05 * N;
    const r = meter(withPatch, { histogramNear: withPatch, kind: 'interior' });
    const base = meter(cabin, { histogramNear: cabin, kind: 'interior' });
    const patchLevel = level(30 * 64, r.targetEv100);
    const cabinLevel = level(30, r.targetEv100);
    console.log(
      `[cockpit-12] 5 % patch at +6 EV: stop-down ${(r.targetEv100 - base.targetEv100).toFixed(2)} EV against the cabin alone; patch ${patchLevel.toFixed(0)} / 255, cabin ${cabinLevel.toFixed(0)} / 255 (cabin alone ${level(30, base.targetEv100).toFixed(0)}; the patch at the cabin's own exposure ${level(30 * 64, base.targetEv100).toFixed(0)})`,
    );
    // In the shoulder (texture and hue kept), not at 255 ...
    expect(patchLevel).toBeLessThan(246);
    expect(patchLevel).toBeGreaterThan(200);
    // ... and the cabin readable, a stop or two under its own exposure.
    expect(cabinLevel).toBeGreaterThan(40);
    expect(r.targetEv100 - base.targetEv100).toBeLessThanOrEqual(INTERIOR_BRIGHT_MAX_EV + 0.3);
    // Under a per cent of the frame the rule is off.
    const speck = Uint32Array.from(cabin);
    speck[luminanceBin(30 * 64)] = 0.005 * N;
    const plain = Uint32Array.from(cabin);
    expect(meter(speck, { histogramNear: speck, kind: 'interior' }).targetEv100 - meter(plain, { histogramNear: plain, kind: 'interior' }).targetEv100).toBeLessThan(0.1);
  });
  it('highlights that would blow out whatever the stop-down (1,000 times the cabin) leave the cabin alone', () => {
    const cabin = new Uint32Array(HISTOGRAM_BINS);
    cabin[luminanceBin(30)] = 0.95 * N;
    const sun = Uint32Array.from(cabin);
    sun[luminanceBin(30 * 1000)] = 0.05 * N;
    const r = meter(sun, { histogramNear: sun, kind: 'interior' });
    const base = meter(cabin, { histogramNear: cabin, kind: 'interior' });
    expect(r.targetEv100 - base.targetEv100).toBeLessThanOrEqual(INTERIOR_HIGHLIGHT_MAX_EV + 0.5);
  });
});

describe('the sun through the air of the camera (request atmosphere-clouds-10)', () => {
  it('inside an atmosphere a high sun over clear air is the sun as before; a low one is what the air leaves of it', () => {
    expect(SUN_AIR_CLEAR).toBe(0.75);
    // Noon on the pad, the ascent: transmittance 0.8 and more.
    for (const t of [1, 0.9, 0.82, 0.75]) expect(sunThroughAir(SUN, t, false)).toBe(SUN);
    // 10 degrees up over clear air (0.41): nearly a stop; 1 degree up from 7 km (0.2): two; sunrise on the ground (0.02): five.
    expect(Math.log2(SUN / sunThroughAir(SUN, 0.41, false))).toBeCloseTo(0.87, 1);
    expect(Math.log2(SUN / sunThroughAir(SUN, 0.2, false))).toBeCloseTo(1.9, 1);
    expect(Math.log2(SUN / sunThroughAir(SUN, 0.02, false))).toBeGreaterThan(5);
    // Monotonic and continuous at the join.
    expect(sunThroughAir(SUN, 0.7499, false)).toBeGreaterThan(sunThroughAir(SUN, 0.74, false));
    expect(sunThroughAir(SUN, 0.7499, false) / SUN).toBeGreaterThan(0.999);
    // Behind the planet: none. Above every atmosphere: the air on the way, all of it (request sky-lighting-10).
    expect(sunThroughAir(SUN, 0, false)).toBe(0);
    expect(sunThroughAir(SUN, 0.9, true)).toBeCloseTo(0.9 * SUN, 6);
    expect(sunThroughAir(SUN, 0.03, true)).toBeCloseTo(0.03 * SUN, 6);
  });

  it('a frame of dawn sky with nothing lit in it is exposed for the dawn, not for noon', () => {
    // No lit geometry (the camera looks up past the canopies): the target is the prior alone.
    const empty = new Uint32Array(HISTOGRAM_BINS);
    const noon = meter(empty, { litObjectInView: true }).targetEv100;
    const dawn = meter(empty, { litObjectInView: true, sunIlluminance: sunThroughAir(SUN, 0.2, false) }).targetEv100;
    expect(noon).toBeCloseTo(sunny16Ev(SUN), 6);
    expect(noon - dawn).toBeCloseTo(1.9, 1);
    // A clear dawn sky of 225 cd/m^2: five stops under mid-grey at the noon exposure, three at the dawn's.
    const under = (ev: number): number => Math.log2(0.18 / (225 * exposureFromEv100(ev)));
    expect(under(noon)).toBeGreaterThan(4.8);
    expect(under(dawn)).toBeLessThan(3.3);
  });
});

describe('interior metering: the world in the windows of the seat view (request cockpit-16)', () => {
  /** A cabin (5-40 cd/m^2 over 85 % of the frame, as in the app's seat views at EV 5) and lit geometry beyond it. */
  const seat = (far: number, farLo = 3000, farHi = 16000, cabinLo = 5, cabinHi = 40): { all: Uint32Array; near: Uint32Array } => {
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, cabinLo, cabinHi, 0.85 * N);
    const all = Uint32Array.from(near);
    if (far > 0) fill(all, farLo, farHi, far * N);
    return { all, near };
  };
  const interior = (v: { all: Uint32Array; near: Uint32Array }, over: Partial<MeterInput> = {}): ReturnType<typeof meterExposure> => meter(v.all, { histogramNear: v.near, kind: 'interior', ...over });
  const stopsOverMidGrey = (luminance: number, ev: number, gain = 1): number => Math.log2((luminance * gain * exposureFromEv100(ev)) / 0.18);

  it('a sunlit Earth in 2 % of the frame keys the cabin two stops and a quarter low', () => {
    const closed = interior(seat(0));
    expect(closed.farWeight).toBe(0);
    expect(closed.farLevel).toBe(0);
    const r = interior(seat(0.02));
    expect(r.farWeight).toBe(1);
    expect(r.outsideWeight).toBe(0);
    expect(r.targetEv100 - closed.targetEv100).toBeCloseTo(INTERIOR_OUTSIDE_KEY_EV, 6);
    // The cabin's log-average: at mid-grey without the window, at Y 0.04 with it (the photographs: 0.03).
    const cabin = histogramStats(seat(0).near, N, Infinity).logMean;
    expect(Math.abs(stopsOverMidGrey(cabin, closed.targetEv100))).toBeLessThan(0.6);
    expect(cabin * exposureFromEv100(r.targetEv100)).toBeGreaterThan(0.025);
    expect(cabin * exposureFromEv100(r.targetEv100)).toBeLessThan(0.07);
  });

  it('comes in with the window share (0.2 to 0.8 % of the frame) and with how far the outside stands over the cabin (3 to 6 stops)', () => {
    expect(INTERIOR_OUTSIDE_FROM).toBe(0.002);
    expect(INTERIOR_OUTSIDE_FULL).toBe(0.008);
    const closed = interior(seat(0)).targetEv100;
    let last = closed;
    for (const far of [0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.02]) {
      const r = interior(seat(far));
      expect(r.targetEv100).toBeGreaterThanOrEqual(last);
      last = r.targetEv100;
    }
    expect(interior(seat(0.002)).targetEv100).toBe(closed);
    expect(interior(seat(0.005)).farWeight).toBeCloseTo(0.5, 6);
    expect(last - closed).toBeCloseTo(INTERIOR_OUTSIDE_KEY_EV, 6);
    // An outside two stops over the cabin (a lit hangar wall, an overcast pad): nothing. Five stops: partly.
    const cabin = histogramStats(seat(0).near, N, Infinity).logMean;
    expect(interior(seat(0.02, 3 * cabin, 5 * cabin)).farWeight).toBe(0);
    const five = interior(seat(0.02, 24 * cabin, 40 * cabin)).farWeight;
    expect(five).toBeGreaterThan(0.5);
    expect(five).toBeLessThan(1);
  });

  it('a night side or black space in the windows leaves the cabin and its night key alone', () => {
    const night = { sunVisibility: 0 };
    // City lights and moonlit cloud in 5 % of the frame of a cabin lit by its floods.
    const lit = interior(seat(0, 0, 0, 2, 12), night);
    const withNight = interior(seat(0.05, 0.02, 0.5, 2, 12), night);
    expect(withNight.farWeight).toBe(0);
    expect(withNight.targetEv100).toBe(lit.targetEv100);
    expect(interiorFarGain(withNight.farLevel, withNight.targetEv100, withNight.farWeight)).toBe(1);
  });

  it('the outside is shown at its own exposure: its brightest tenth three stops over mid-grey, cloud under white, sea in the mid-tones', () => {
    expect(INTERIOR_FAR_STOPS).toBe(3);
    const r = interior(seat(0.02));
    // The level is the 90th percentile of what is seen beyond the cabin (3,000-16,000 cd/m^2 here).
    expect(r.farLevel).toBeGreaterThan(11000);
    expect(r.farLevel).toBeLessThan(16000);
    const gain = interiorFarGain(r.farLevel, r.targetEv100, r.farWeight);
    expect(gain).toBeLessThan(1 / 16);
    expect(stopsOverMidGrey(r.farLevel, r.targetEv100, gain)).toBeCloseTo(INTERIOR_FAR_STOPS, 6);
    // Without it the same pixels stand nearly eight stops over mid-grey: four over the tone curve's white.
    expect(stopsOverMidGrey(r.farLevel, r.targetEv100)).toBeGreaterThan(7.5);
    // Cloud tops (16,000 cd/m^2) and sea (3,000) through the display transform: apart, neither clipped.
    const level = (luminance: number): number => {
      const v = luminance * gain * exposureFromEv100(r.targetEv100);
      return 255 * srgbEncode(displayLinear([v, v, v])[1]);
    };
    expect(level(16000)).toBeLessThan(225);
    expect(level(3000)).toBeGreaterThan(100);
    expect(level(16000) - level(3000)).toBeGreaterThan(55);
    // The cabin's own tones are not touched by it (the gain is for what lies beyond the cabin).
    expect(interiorFarGain(0, r.targetEv100, 1)).toBe(1);
  });

  it('the gain follows the weight, never brightens, and is gone once the windows fill the frame', () => {
    const half = interior(seat(0.005));
    const g = interiorFarGain(half.farLevel, half.targetEv100, half.farWeight);
    const full = interiorFarGain(half.farLevel, half.targetEv100, 1);
    expect(g).toBeGreaterThan(full);
    expect(g).toBeLessThan(1);
    expect(Math.log2(g)).toBeCloseTo(0.5 * Math.log2(full), 6);
    // A dim outside is not brightened.
    expect(interiorFarGain(1, 8, 1)).toBe(1);
    // At the window (45 % of the frame) the exposure itself is the outside's: nothing left to do.
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 20, 120, 0.5 * N);
    const all = Uint32Array.from(near);
    fill(all, 2000, 9000, 0.45 * N);
    const at = meter(all, { histogramNear: near, kind: 'interior' });
    expect(at.outsideWeight).toBe(1);
    expect(interiorFarGain(at.farLevel, at.targetEv100, at.farWeight)).toBe(1);
    // Exterior and map views never have one.
    const exterior = meter(all, { histogramNear: near });
    expect(exterior.farLevel).toBe(0);
    expect(exterior.farWeight).toBe(0);
  });

  it('the daylight sky in the windows is the outside too (the sky histogram): the pad seen from the seat', () => {
    // No geometry beyond the cabin, a noon sky (4,000-9,000 cd/m^2) in 3 % of the frame.
    const v = seat(0);
    const sky = new Uint32Array(HISTOGRAM_BINS);
    fill(sky, 4000, 9000, 0.03 * N);
    const closed = interior(v);
    const r = interior(v, { histogramSky: sky });
    expect(r.farWeight).toBe(1);
    expect(r.targetEv100 - closed.targetEv100).toBeCloseTo(INTERIOR_OUTSIDE_KEY_EV, 6);
    expect(r.farLevel).toBeGreaterThan(7000);
    expect(r.farLevel).toBeLessThan(9500);
    const gain = interiorFarGain(r.farLevel, r.targetEv100, r.farWeight);
    expect(stopsOverMidGrey(8000, r.targetEv100, gain)).toBeGreaterThan(2.5);
    expect(stopsOverMidGrey(8000, r.targetEv100, gain)).toBeLessThan(3.2);
    // The sky is not lit geometry: it does not weigh as the outside that fills the frame (request cockpit-7),
    // and an exterior view of the same pixels does not see it at all.
    expect(r.outsideFraction).toBe(0);
    expect(r.outsideWeight).toBe(0);
    expect(meter(v.all, { histogramNear: v.near, histogramSky: sky }).targetEv100).toBe(meter(v.all, { histogramNear: v.near }).targetEv100);
    // A twilight sky no brighter than the cabin's own lights changes nothing.
    const dusk = new Uint32Array(HISTOGRAM_BINS);
    fill(dusk, 10, 60, 0.03 * N);
    expect(interior(v, { histogramSky: dusk }).targetEv100).toBe(closed.targetEv100);
  });
});

describe('interior metering: what fills the frame through the windows (request cockpit-7)', () => {
  /** A cabin by day (20-120 cd/m^2 over `cabin` of the frame) and lit geometry beyond it over `far` of the frame. */
  const view = (cabin: number, far: number, farLo = 2000, farHi = 9000): { all: Uint32Array; near: Uint32Array } => {
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 20, 120, cabin * N);
    const all = Uint32Array.from(near);
    if (far > 0) fill(all, farLo, farHi, far * N);
    return { all, near };
  };
  const interior = (v: { all: Uint32Array; near: Uint32Array }, over: Partial<MeterInput> = {}): ReturnType<typeof meterExposure> => meter(v.all, { histogramNear: v.near, kind: 'interior', ...over });
  const shown = (luminance: number, ev: number): number => luminance * exposureFromEv100(ev);

  it('the seat view: windows under a tenth of the frame do not weigh as the outside, but a bright Earth in them is brought into the shoulder (request cockpit-12)', () => {
    expect(INTERIOR_WINDOW_FROM).toBe(0.1);
    expect(INTERIOR_WINDOW_FULL).toBe(0.4);
    const alone = interior(view(0.9, 0));
    // Under INTERIOR_OUTSIDE_FROM of the frame nothing moves (a sliver of the Earth at a window's edge).
    expect(interior(view(0.9, 0.001)).targetEv100).toBe(alone.targetEv100);
    let last = alone.targetEv100;
    for (const far of [0.02, 0.05, 0.08, 0.1]) {
      const r = interior(view(0.9, far));
      expect(r.outsideWeight).toBe(0);
      expect(r.outsideFraction).toBeCloseTo(far, 3);
      // The bright-area rule stops down, more for more window, by at most INTERIOR_BRIGHT_MAX_EV ...
      expect(r.targetEv100).toBeGreaterThanOrEqual(last);
      expect(r.targetEv100 - alone.targetEv100).toBeLessThanOrEqual(INTERIOR_BRIGHT_MAX_EV + 1e-9);
      last = r.targetEv100;
    }
    // ... so that at 8 % the day side (2,000-9,000 cd/m^2, 40-180 times the cabin) comes 3 EV down into the
    // shoulder (cloud tops at +4.8 EV over mid-grey instead of +7.8, land and ocean at +2.7) and the cabin
    // goes to the dark tones, as in a photograph exposed for the window.
    const eight = interior(view(0.9, 0.08)).targetEv100;
    expect(eight - alone.targetEv100).toBeCloseTo(INTERIOR_BRIGHT_MAX_EV, 1);
    expect(shown(9000, alone.targetEv100)).toBeGreaterThan(30);
    expect(shown(9000, eight)).toBeLessThan(6);
    expect(shown(2000, eight)).toBeLessThan(1.3);
    expect(shown(histogramStats(view(0.9, 0).near, N, Infinity).logMean, eight)).toBeGreaterThan(0.02);
  });

  it('the Earth filling the frame through a window is exposed as an exterior camera exposes it; the cabin goes to a silhouette', () => {
    const v = view(0.5, 0.45);
    const r = interior(v);
    // What an exterior camera makes of the far pixels alone.
    const farOnly = new Uint32Array(HISTOGRAM_BINS);
    for (let i = 0; i < HISTOGRAM_BINS; i++) farOnly[i] = v.all[i]! - v.near[i]!;
    const outside = meter(farOnly).targetEv100;
    expect(r.outsideWeight).toBe(1);
    expect(r.evOutside).toBeCloseTo(outside, 9);
    expect(r.targetEv100).toBeCloseTo(outside, 9);
    // Day side a stop or so under sunny 16 (the exterior key renders day bright): clouds below white, ocean
    // and land in the mid-tones ...
    expect(r.targetEv100).toBeLessThan(sunny16Ev(SUN));
    expect(r.targetEv100).toBeGreaterThan(sunny16Ev(SUN) - 1.6);
    expect(shown(9000, r.targetEv100)).toBeLessThan(1.2);
    expect(shown(3000, r.targetEv100)).toBeGreaterThan(0.1);
    // ... and the cabin around the window is five stops and more under mid-grey.
    expect(shown(60, r.targetEv100)).toBeLessThan(0.18 / 32);
    // Without the rule the same frame is metered on the cabin and the Earth is a white shape.
    const cabinOnly = interior(view(0.5, 0)).targetEv100;
    expect(r.targetEv100 - cabinOnly).toBeGreaterThan(5);
    expect(shown(3000, cabinOnly)).toBeGreaterThan(4);
  });

  it('the weight rises smoothly between a tenth and four tenths of the frame, and the target with it', () => {
    let last = interior(view(0.5, 0.1)).targetEv100;
    for (const far of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
      const r = interior(view(0.5, far));
      expect(r.targetEv100).toBeGreaterThan(last);
      last = r.targetEv100;
    }
    const half = interior(view(0.5, 0.25));
    expect(half.outsideWeight).toBeCloseTo(0.5, 2);
    // The cabin's own target (with the bright-area rule of request cockpit-12) moves half way to the outside's.
    const cabinTarget = half.evPrior + (half.evHistogram - half.evPrior) * half.histogramWeight;
    expect(half.targetEv100).toBeCloseTo(cabinTarget + 0.5 * (half.evOutside - cabinTarget), 6);
    expect(interior(view(0.5, 0.6)).targetEv100).toBeCloseTo(interior(view(0.5, 0.4)).targetEv100, 1);
  });

  it('the outside only ever stops the camera down: a night side in the window leaves a lit cabin alone', () => {
    const lit = interior(view(0.5, 0));
    // City lights and moonlit cloud at 0.02-0.5 cd/m^2 over 45 % of the frame, the sun hidden by the Earth.
    const night = { sunVisibility: 0 };
    const withNight = interior(view(0.5, 0.45, 0.02, 0.5), night);
    expect(withNight.outsideWeight).toBe(1);
    expect(withNight.evOutside).toBeLessThan(lit.targetEv100 - 3);
    expect(withNight.targetEv100).toBe(interior(view(0.5, 0), night).targetEv100);
  });

  it('exposure compensation and the floor apply after it; an exterior view of the same pixels is unchanged', () => {
    const v = view(0.5, 0.45);
    expect(interior(v, { exposureCompensation: 1 }).targetEv100).toBeCloseTo(interior(v).targetEv100 - 1, 9);
    expect(interior(v, { minEv100: 16.5 }).targetEv100).toBe(16.5);
    const exterior = meter(v.all, { histogramNear: v.near });
    expect(exterior.outsideWeight).toBe(0);
    expect(exterior.targetEv100).toBe(meter(v.all).targetEv100);
  });
});

