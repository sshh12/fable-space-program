/**
 * The meter's rules of look 2 (the switch RendererOptions.look; requests ocean-13, ocean-10) on what the meter
 * was actually given in the scenes they are for: ten inputs recorded with CoreRenderer.meterInput() on
 * 2026-11-17 (the curve A/B spec; fixtures/meterRecords.json, histograms as [bin, count] pairs) from the pad
 * at noon, the lift-off, the dawn splashdown of the real app (before the contact, with both canopies
 * standing in the frame, after they had gone under) and the night entry (a thruster pulse, the dark between
 * pulses, the peak of heating, the peak of g).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EV_MAX,
  HISTOGRAM_BINS,
  METER2_EMITTER_SMALL_EV,
  METER2_SKY_MAX,
  EXPOSURE_K,
  meterExposure,
  type MeterInput,
} from '@/render/core/post/exposure';

interface Packed {
  label: string;
  recordedEv100: number;
  input: Omit<MeterInput, 'histogram' | 'histogramNear' | 'histogramSky'> & { histogram: [number, number][]; histogramNear: [number, number][]; histogramSky?: [number, number][] | null };
}
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'meterRecords.json');
const packed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Packed>;
const dense = (pairs: [number, number][] | null | undefined): number[] => {
  const h = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const [bin, count] of pairs ?? []) h[bin] = count;
  return h;
};
const input = (name: string, look: 1 | 2, extra: Partial<MeterInput> = {}): MeterInput => {
  const p = packed[name]!.input;
  return { ...p, histogram: dense(p.histogram), histogramNear: dense(p.histogramNear), ...(p.histogramSky ? { histogramSky: dense(p.histogramSky) } : {}), look, ...extra } as MeterInput;
};
const target = (name: string, look: 1 | 2, extra: Partial<MeterInput> = {}): number => meterExposure(input(name, look, extra)).targetEv100;

describe('the meter with the switch off (look 1) is the meter as it was', () => {
  it('gives every recorded frame the target it had when it was recorded, with look 1 and with no look at all', () => {
    const recorded: Record<string, number> = { padNoon: 14.576, liftoff: 14.648, dawnBefore: 9.023, dawnCanopies5s: 12.49, dawnCanopies8s: 12.522, dawnAfter15s: 8.581, entryThrusterPulse: 11.808, entryDark: 1.416, entryPeakHeating: 16.5, entryPeakG: 12.301 };
    for (const [name, ev] of Object.entries(recorded)) {
      expect(target(name, 1), name).toBeCloseTo(ev, 2);
      const { look: _look, ...without } = input(name, 1);
      expect(meterExposure(without as MeterInput), name).toEqual(meterExposure(input(name, 1)));
    }
  });
});

describe('look 2, by day: nothing moves', () => {
  it('the pad at noon and the lift-off are metered as with look 1', () => {
    for (const name of ['padNoon', 'liftoff']) expect(target(name, 2), name).toBeCloseTo(target(name, 1), 9);
  });
});

describe('look 2 under a low sun: the dawn splashdown (request ocean-13)', () => {
  it('with look 1 the two sunlit canopies take the target up by three and a half stops, and back when they have gone under', () => {
    expect(target('dawnCanopies5s', 1) - target('dawnBefore', 1)).toBeGreaterThan(3.4);
    expect(target('dawnCanopies8s', 1) - target('dawnAfter15s', 1)).toBeGreaterThan(3.8);
  });

  it('with look 2 the target is the same within a quarter stop before the contact, with the canopies in the frame and after', () => {
    const evs = ['dawnBefore', 'dawnCanopies5s', 'dawnCanopies8s', 'dawnAfter15s'].map((n) => target(n, 2));
    expect(Math.max(...evs) - Math.min(...evs)).toBeLessThan(0.25);
    // What holds it is the sky: its 90th percentile at METER2_SKY_MAX pre-exposed.
    for (const name of ['dawnBefore', 'dawnCanopies5s', 'dawnAfter15s']) {
      const m = input(name, 2);
      const sky = m.histogramSky as number[];
      const total = sky.reduce((a, b) => a + b, 0);
      let acc = 0;
      let bin = 0;
      for (; bin < HISTOGRAM_BINS; bin++) {
        acc += sky[bin]!;
        if (acc >= 0.9 * total) break;
      }
      const level = 2 ** (-12 + ((bin + 0.5) / HISTOGRAM_BINS) * 32);
      const ev = target(name, 2);
      // (Within a bin of the histogram: an eighth of a stop.)
      expect(Math.log2(level / (EXPOSURE_K * 2 ** ev) / METER2_SKY_MAX), name).toBeGreaterThan(-0.2);
      expect(Math.log2(level / (EXPOSURE_K * 2 ** ev) / METER2_SKY_MAX), name).toBeLessThan(0.2);
    }
  });

  it('without a sky in the frame (the camera looking down at the sea) the canopies raise the target by a stop and a half at most, where they raised it by three and a half', () => {
    const noSky = { histogramSky: new Array<number>(HISTOGRAM_BINS).fill(0) };
    const before = target('dawnBefore', 2, noSky);
    expect(target('dawnCanopies5s', 2, noSky) - before).toBeLessThan(1.5);
    expect(target('dawnCanopies8s', 2, noSky) - before).toBeLessThan(1.5);
    expect(target('dawnCanopies5s', 1, noSky) - target('dawnBefore', 1, noSky)).toBeGreaterThan(3.4);
  });
});

describe('look 2 and emitters: the night entry', () => {
  it('a sheath a quarter of the frame wide is the scene: the peak of heating is metered as with look 1', () => {
    expect(target('entryPeakHeating', 2)).toBe(EV_MAX);
    expect(target('entryPeakHeating', 1)).toBe(EV_MAX);
  });

  it("a thruster's pulse raises the target by two stops over the frame without it, where it raised it by five and a half (6.27 -> 11.81)", () => {
    const withoutPulse = target('entryThrusterPulse', 2, { emissive: [] });
    expect(target('entryThrusterPulse', 1) - target('entryThrusterPulse', 1, { emissive: [] })).toBeGreaterThan(5.4);
    expect(target('entryThrusterPulse', 2) - withoutPulse).toBeCloseTo(METER2_EMITTER_SMALL_EV, 6);
    // The frame without emitters is metered alike by both looks.
    expect(withoutPulse).toBeCloseTo(target('entryThrusterPulse', 1, { emissive: [] }), 9);
    expect(target('entryDark', 2)).toBeCloseTo(target('entryDark', 1), 9);
  });

  it('a frame that is dark but for the emitter follows the emitter, as before', () => {
    const dark = { histogram: new Array<number>(HISTOGRAM_BINS).fill(0), histogramNear: new Array<number>(HISTOGRAM_BINS).fill(0), litObjectInView: false };
    expect(target('entryThrusterPulse', 2, dark)).toBeCloseTo(target('entryThrusterPulse', 1, dark), 9);
  });

  it('at the peak of g the meter is told of no emitter (the vfx withholds its hints once a sun is up), so both looks expose for the hull; with the hint, look 2 exposes for the sheath and look 1 is held at that weak sun', () => {
    expect(packed['entryPeakG']!.input.emissive ?? []).toEqual([]);
    expect(target('entryPeakG', 2)).toBeCloseTo(target('entryPeakG', 1), 9);
    const sheath = { emissive: [{ luminance: 5e4, coverage: 0.235 }] };
    expect(target('entryPeakG', 1, sheath)).toBeLessThan(13.5);
    expect(target('entryPeakG', 2, sheath)).toBe(EV_MAX);
  });
});
