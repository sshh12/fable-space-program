import { describe, expect, it } from 'vitest';
import { buildHapkeLut, DEFAULT_HAPKE, hapkeAlbedoAtNorm, hapkeBrdfMu0, HAPKE_NORM } from '@/render/core/lighting/deferred';
import { blackbodyRadiance } from '@/render/core/mesh/meshSystem';
import {
  ADAPT_DARK,
  adaptEv100,
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
  INTERIOR_NIGHT_KEY_EV,
  LUMINANCE_FLOOR,
  luminanceBin,
  SUNLIT_HIGHLIGHT_MAX_EV,
  meterExposure,
  sunny16Ev,
  type MeterInput,
} from '@/render/core/post/exposure';
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
    // Cabin: a dim interior (near histogram) with a blown-out window in the full histogram.
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 5, 40, 0.7 * N);
    const all = new Uint32Array(near);
    fill(all, 20000, 40000, 0.2 * N);
    const interior = meter(all, { histogramNear: near, kind: 'interior' });
    const exterior = meter(all, { histogramNear: near, kind: 'external' });
    expect(interior.targetEv100).toBeLessThan(exterior.targetEv100 - 5);
    const cabinMean = histogramStats(near, N).mean;
    expect(cabinMean * exposureFromEv100(interior.targetEv100)).toBeGreaterThan(0.08);
    expect(cabinMean * exposureFromEv100(interior.targetEv100)).toBeLessThan(0.4);
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
    // Sunlit white itself (0.9 x 128,000 / pi cd/m^2) is still protected: the bound is half a stop above
    // what holds it under 4 x mid-grey.
    const white = day();
    fill(white, 33000, 36700, 0.05 * N);
    expect(histogramStats(white, N).p99 * exposureFromEv100(meter(white).targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
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
    expect(withLit - base).toBeLessThan(INTERIOR_HIGHLIGHT_MAX_EV + 0.5);
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
