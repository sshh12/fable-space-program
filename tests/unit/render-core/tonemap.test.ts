import { describe, expect, it } from 'vitest';
import { agxDisplayLinear, displayLinear, srgbEncode, TOE_FULL_STOPS, TOE_GAIN, TOE_START_STOPS } from '@/render/core/post/tonemap';

const MID = 0.18;
const grey = (stops: number): [number, number, number] => [MID * 2 ** stops, MID * 2 ** stops, MID * 2 ** stops];
const level = (c: readonly [number, number, number]): number => 255 * srgbEncode(c[1]);

describe('display transform (tonemap pass): AgX with a linear, hue-preserving toe (request sky-lighting-3)', () => {
  it('is AgX alone from one stop under mid-grey upwards', () => {
    expect(TOE_START_STOPS).toBe(-1);
    expect(TOE_FULL_STOPS).toBe(-6);
    for (let s = TOE_START_STOPS; s <= 6; s += 0.25) {
      for (const tint of [[1, 1, 1], [1.25, 1, 0.75], [0.3, 0.8, 1.6], [2, 0.2, 0.2]] as const) {
        const y = MID * 2 ** s;
        // The tint is scaled to the luminance of the grey, so the blend weight is the one of that stop.
        const l = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
        const c: [number, number, number] = [(tint[0] * y) / l, (tint[1] * y) / l, (tint[2] * y) / l];
        expect(displayLinear(c)).toEqual(agxDisplayLinear(c));
      }
    }
    // The curve itself: mid-grey at 117 of 255, one stop under it at 84 (what every daylight view rests on).
    expect(level(displayLinear(grey(0)))).toBeCloseTo(117.1, 0);
    expect(level(displayLinear(grey(-1)))).toBeCloseTo(84.3, 0);
    expect(level(displayLinear(grey(4)))).toBeGreaterThan(225);
    // Inside the join the image leaves AgX by under two levels of 255 (request sky-lighting-7).
    for (let s = -1; s >= -6; s -= 0.25) expect(Math.abs(level(displayLinear(grey(s))) - level(s > -3.5 ? agxDisplayLinear(grey(s)) : [0, TOE_GAIN * MID * 2 ** s, 0]))).toBeLessThan(2.3);
    expect(level(displayLinear(grey(-2)))).toBeCloseTo(53.7, 0);
    expect(level(displayLinear(grey(-3)))).toBeCloseTo(29.5, 0);
  });

  it('follows the scene below six stops under mid-grey: one gain, no foot', () => {
    for (const s of [-6, -6.5, -7, -8, -9, -12]) {
      const y = MID * 2 ** s;
      expect(displayLinear(grey(s))[1]).toBeCloseTo(TOE_GAIN * y, 12);
    }
    // 8-bit levels of a grey: the sigmoid's foot gave 13, 3.4, 0.8, 0.2, 0.1 at -4, -5, -6, -7, -8 stops.
    expect(level(displayLinear(grey(-4)))).toBeCloseTo(15.4, 0);
    expect(level(displayLinear(grey(-5)))).toBeCloseTo(8.3, 0);
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
      if (s > -6.6 && s < -0.4 && lastStep > 0.02) expect(step / lastStep).toBeLessThan(2);
      lastStep = step;
      last = v;
    }
  });

  it('has no kink: the log-log slope of a grey changes by under 0.15 per quarter stop (request sky-lighting-7)', () => {
    // Display-linear against scene-linear from +1 to -8 stops. Joined over one stop the slope fell from 1.76
    // to 1.12 within a quarter of a stop at 21 of 255, and every smooth gradient showed a contour there.
    const g = (s: number): number => displayLinear(grey(s))[1];
    let last = NaN;
    let worst = 0;
    for (let s = 1; s >= -8; s -= 0.25) {
      const slope = Math.log2(g(s + 0.125) / g(s - 0.125)) / 0.25;
      expect(slope).toBeGreaterThan(0.6);
      expect(slope).toBeLessThan(1.6);
      if (!Number.isNaN(last)) worst = Math.max(worst, Math.abs(slope - last));
      last = slope;
    }
    expect(worst).toBeLessThan(0.15);
    // The toe's own slope is 1 from six stops under mid-grey downwards.
    expect(Math.log2(g(-6.5) / g(-7.5))).toBeCloseTo(1, 9);
  });

  it('keeps the hue of a dim colour (the per-channel foot turned a warm grey rust-brown)', () => {
    const warm = (s: number): [number, number, number] => [1.25 * MID * 2 ** s, MID * 2 ** s, 0.75 * MID * 2 ** s];
    // (-6.25: this grey's luminance is 1.035 x its green, so at -6 it sits just inside the join.)
    for (const s of [-6.25, -6.5, -7, -8]) {
      const d = displayLinear(warm(s));
      expect(d[0] / d[1]).toBeCloseTo(1.25, 9);
      expect(d[0] / d[2]).toBeCloseTo(1.25 / 0.75, 9);
    }
    // Inside the join the hue comes back as the colour dims: red over blue 2.2 at -2 stops (AgX's own), 2.0
    // at -4, 1.72 at -5, against 1.67 in the scene.
    expect(displayLinear(warm(-4))[0] / displayLinear(warm(-4))[2]).toBeLessThan(2.05);
    expect(displayLinear(warm(-5))[0] / displayLinear(warm(-5))[2]).toBeLessThan(1.75);
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
