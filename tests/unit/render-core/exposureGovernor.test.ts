import { describe, expect, it } from 'vitest';
import { buildHapkeLut, DEFAULT_HAPKE, hapkeAlbedoAtNorm, hapkeBrdfMu0, HAPKE_NORM } from '@/render/core/lighting/deferred';
import { blackbodyRadiance } from '@/render/core/mesh/meshSystem';
import {
  adaptEv100,
  binLuminance,
  EV_DARK_FLOOR,
  ev100ForMidGrey,
  exposureCompensationCurve,
  exposureFromEv100,
  HISTOGRAM_BINS,
  histogramStats,
  LUMINANCE_FLOOR,
  luminanceBin,
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
    // Add 3 % of very bright pixels (a white lander): the 99th percentile must stay below 4 x mid-grey.
    fill(h, 60000, 70000, 0.03 * N);
    const prot = meter(h);
    const p99 = histogramStats(h, N).p99;
    expect(p99 * exposureFromEv100(prot.targetEv100)).toBeLessThanOrEqual(4 * 0.18 * 1.001);
    expect(prot.targetEv100).toBeGreaterThan(base.targetEv100);
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

  it('interior metering keeps the cabin readable when a sun patch falls into it (request cockpit-3)', () => {
    // 95 % of the near pixels are cabin at 20-45 cd/m^2, 5 % are a sun patch on a panel at 14,000-20,000.
    const near = new Uint32Array(HISTOGRAM_BINS);
    fill(near, 20, 45, 0.95 * 0.6 * N);
    fill(near, 14000, 20000, 0.05 * 0.6 * N);
    const cabin = new Uint32Array(HISTOGRAM_BINS);
    fill(cabin, 20, 45, 0.6 * N);
    const withPatch = meter(near, { histogramNear: near, kind: 'interior' });
    const without = meter(cabin, { histogramNear: cabin, kind: 'interior' });
    // The patch moves the exposure by less than a stop, and the cabin stays near mid-grey ...
    expect(withPatch.targetEv100 - without.targetEv100).toBeLessThan(1);
    expect(withPatch.targetEv100 - without.targetEv100).toBeGreaterThan(0);
    const cabinAt = 30 * exposureFromEv100(withPatch.targetEv100);
    expect(cabinAt).toBeGreaterThan(0.08);
    expect(cabinAt).toBeLessThan(0.3);
    // ... while the patch blows out (far above white).
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
