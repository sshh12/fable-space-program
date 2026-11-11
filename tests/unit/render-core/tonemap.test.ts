import { describe, expect, it } from 'vitest';
import { agxDisplayLinear, displayLinear, srgbEncode, TOE_FULL_STOPS, TOE_GAIN, TOE_START_STOPS } from '@/render/core/post/tonemap';

const MID = 0.18;
const grey = (stops: number): [number, number, number] => [MID * 2 ** stops, MID * 2 ** stops, MID * 2 ** stops];
const level = (c: readonly [number, number, number]): number => 255 * srgbEncode(c[1]);

describe('display transform (tonemap pass): AgX with a linear, hue-preserving toe (request sky-lighting-3)', () => {
  it('is AgX alone from three stops under mid-grey upwards', () => {
    for (let s = TOE_START_STOPS; s <= 6; s += 0.25) {
      for (const tint of [[1, 1, 1], [1.25, 1, 0.75], [0.3, 0.8, 1.6], [2, 0.2, 0.2]] as const) {
        const y = MID * 2 ** s;
        // The tint is scaled to the luminance of the grey, so the blend weight is the one of that stop.
        const l = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
        const c: [number, number, number] = [(tint[0] * y) / l, (tint[1] * y) / l, (tint[2] * y) / l];
        expect(displayLinear(c)).toEqual(agxDisplayLinear(c));
      }
    }
    // The curve itself: mid-grey at 117 of 255, three stops under it at 31 (what every daylight view rests on).
    expect(level(displayLinear(grey(0)))).toBeCloseTo(117.1, 0);
    expect(level(displayLinear(grey(-3)))).toBeCloseTo(31.0, 0);
    expect(level(displayLinear(grey(4)))).toBeGreaterThan(225);
  });

  it('follows the scene below four stops under mid-grey: one gain, no foot', () => {
    for (const s of [-4, -4.5, -5, -6, -7, -8, -9, -12]) {
      const y = MID * 2 ** s;
      expect(displayLinear(grey(s))[1]).toBeCloseTo(TOE_GAIN * y, 12);
    }
    // 8-bit levels of a grey: the sigmoid's foot gave 13, 3.4, 0.8, 0.2, 0.1 at -4, -5, -6, -7, -8 stops.
    expect(level(displayLinear(grey(-4)))).toBeCloseTo(16.5, 0);
    expect(level(displayLinear(grey(-5)))).toBeCloseTo(8.9, 0);
    expect(level(displayLinear(grey(-6)))).toBeCloseTo(4.4, 0);
    expect(level(displayLinear(grey(-7)))).toBeCloseTo(2.2, 0);
    expect(level(displayLinear(grey(-8)))).toBeCloseTo(1.1, 0);
    expect(level(agxDisplayLinear(grey(-5)))).toBeCloseTo(3.4, 0);
    expect(level(agxDisplayLinear(grey(-7)))).toBeLessThan(0.3);
    // The gain is what AgX gives a grey in the middle of the blend (the two branches cross there).
    const join = MID * 2 ** (0.5 * (TOE_START_STOPS + TOE_FULL_STOPS));
    expect(agxDisplayLinear([join, join, join])[1]).toBeCloseTo(TOE_GAIN * join, 12);
    expect(TOE_GAIN).toBeGreaterThan(0.45);
    expect(TOE_GAIN).toBeLessThan(0.51);
  });

  it('is monotonic and smooth through the blend', () => {
    let last = displayLinear(grey(-12))[1];
    let lastStep = 0;
    for (let s = -11.95; s <= 6; s += 0.05) {
      const v = displayLinear(grey(s))[1];
      expect(v).toBeGreaterThanOrEqual(last);
      // In the encoded image no twentieth of a stop is a jump: under 2 levels, and no step more than twice its neighbour.
      const step = 255 * (srgbEncode(v) - srgbEncode(last));
      expect(step).toBeLessThan(2);
      if (s > -4.6 && s < -2.4 && lastStep > 0.02) expect(step / lastStep).toBeLessThan(2);
      lastStep = step;
      last = v;
    }
  });

  it('keeps the hue of a dim colour (the per-channel foot turned a warm grey rust-brown)', () => {
    const warm = (s: number): [number, number, number] => [1.25 * MID * 2 ** s, MID * 2 ** s, 0.75 * MID * 2 ** s];
    for (const s of [-4.2, -5, -6, -8]) {
      const d = displayLinear(warm(s));
      expect(d[0] / d[1]).toBeCloseTo(1.25, 9);
      expect(d[0] / d[2]).toBeCloseTo(1.25 / 0.75, 9);
    }
    // AgX alone at five stops under mid-grey: red over blue 3.4 instead of 1.67.
    const a = agxDisplayLinear(warm(-5));
    expect(a[0] / a[2]).toBeGreaterThan(3);
  });

  it('desaturates bright colours towards white without changing their order (the shoulder, unchanged)', () => {
    // A saturated orange from one to six stops over mid-grey: red >= green >= blue throughout, all rising.
    let last = [0, 0, 0];
    for (let s = 1; s <= 6; s++) {
      const y = MID * 2 ** s;
      const d = displayLinear([1.6 * y, 0.8 * y, 0.2 * y]).map(srgbEncode);
      expect(d[0]!).toBeGreaterThanOrEqual(d[1]!);
      expect(d[1]!).toBeGreaterThanOrEqual(d[2]!);
      for (let c = 0; c < 3; c++) expect(d[c]!).toBeGreaterThanOrEqual(last[c]!);
      last = d;
    }
    expect(last[2]!).toBeGreaterThan(0.85); // at six stops over the blue channel has nearly caught up: white
  });
});
