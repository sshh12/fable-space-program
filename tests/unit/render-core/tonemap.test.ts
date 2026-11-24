import { describe, expect, it } from 'vitest';
import { agxDisplayLinear, CAMERA_BLEND_FROM, DEFAULT_LOOK, CAMERA_GAIN, CAMERA_SHOULDER_FROM, CAMERA_WHITE, displayLinear, srgbEncode, TOE_FULL_STOPS, TOE_GAIN, TOE_START_STOPS, TONEMAP_BASE_WGSL, TONEMAP_WGSL, tonemapBaseWgsl, tonemapWgsl } from '@/render/core/post/tonemap';

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
      // In the encoded image no twentieth of a stop is a jump: under 2 levels up to mid-grey (the toe and the
      // blend, the same in both looks), and no step more than twice its neighbour there. Above mid-grey the
      // camera curve is the scene's own line, which in encoded levels is steep near white: 3.40 levels per
      // twentieth of a stop at its steepest (2.1 stops over mid-grey; the present curve: 1.70 at 0.35 stops).
      // (Was: under 2 everywhere.)
      const step = 255 * (srgbEncode(v) - srgbEncode(last));
      expect(step).toBeLessThan(s <= 0 ? 2 : 3.5);
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

  it('desaturates bright colours towards white without changing their order (the shoulder of the present curve, look 1; the camera curve: below)', () => {
    // A saturated orange from one to six stops over mid-grey: red >= green >= blue throughout, all rising.
    let last = [0, 0, 0];
    for (let s = 1; s <= 6; s++) {
      const y = MID * 2 ** s;
      const d = displayLinear([1.6 * y, 0.8 * y, 0.2 * y], 1).map(srgbEncode);
      expect(d[0]!).toBeGreaterThanOrEqual(d[1]!);
      expect(d[1]!).toBeGreaterThanOrEqual(d[2]!);
      for (let c = 0; c < 3; c++) expect(d[c]!).toBeGreaterThanOrEqual(last[c]!);
      last = d;
    }
    expect(last[2]!).toBeGreaterThan(0.85); // at six stops over the blue channel has nearly caught up: white
  });
});

describe("the camera curve (look 2; request ocean-10): the scene's own line above mid-grey, a shoulder to white", () => {
  /** Sunlit white paper (albedo 0.9) at the meter's daylight exposure, pre-exposed. */
  const SUNLIT_WHITE = 0.93;
  const g = (x: number, look: 1 | 2): number => displayLinear([x, x, x], look)[1];

  it('is the present curve to the bit from one stop under mid-grey down, and with the switch off everywhere', () => {
    for (let s = -14; s <= CAMERA_BLEND_FROM; s += 0.25) {
      for (const tint of [[1, 1, 1], [1.25, 1, 0.75], [0.3, 0.8, 1.6]] as const) {
        // (The tint's brightest channel stays under the blend: the mix is by each channel's own value.)
        const y = (MID * 2 ** s) / 1.6;
        const c: [number, number, number] = [y * tint[0], y * tint[1], y * tint[2]];
        expect(displayLinear(c, 2)).toEqual(displayLinear(c, 1));
      }
    }
    // The default is the camera curve since 2026-11-24 (DEFAULT_LOOK); look 1 is the text the pass always compiled.
    expect(DEFAULT_LOOK).toBe(2);
    for (let s = -8; s <= 8; s += 0.5) expect(displayLinear(grey(s), 2)).toEqual(displayLinear(grey(s)));
    expect(tonemapWgsl(1)).toBe(TONEMAP_WGSL);
  });

  it('keeps mid-grey where it is, puts sunlit white near 0.9 of display white and reaches white between two and three times sunlit white', () => {
    // (To a millionth: AgX's inset and outset rows sum to 1 within 2e-4, which the line does not copy.)
    expect(g(MID, 2)).toBeCloseTo(g(MID, 1), 5);
    expect(255 * srgbEncode(g(MID, 2))).toBeCloseTo(117.3, 0);
    // Sunlit white: 0.54 of display-linear white today (193 of 255); 0.88 (241) with the camera curve.
    expect(g(SUNLIT_WHITE, 1)).toBeCloseTo(0.536, 2);
    expect(g(SUNLIT_WHITE, 2)).toBeGreaterThan(0.85);
    expect(g(SUNLIT_WHITE, 2)).toBeLessThan(0.92);
    expect(Math.round(255 * srgbEncode(g(SUNLIT_WHITE, 2)))).toBe(241);
    // The scene's own line up to the shoulder.
    for (const x of [0.2, 0.3, 0.5, 0.7]) expect(g(x, 2)).toBeCloseTo(CAMERA_GAIN * x, 3);
    expect(CAMERA_GAIN * 0.7).toBeLessThan(CAMERA_SHOULDER_FROM);
    // The shoulder: not yet white at 1.4 times sunlit white, white (255 of 255) from twice, exactly 1 from CAMERA_WHITE.
    expect(g(1.4 * SUNLIT_WHITE, 2)).toBeLessThan(0.99);
    expect(Math.round(255 * srgbEncode(g(2 * SUNLIT_WHITE, 2)))).toBe(255);
    expect(CAMERA_WHITE / SUNLIT_WHITE).toBeGreaterThan(2);
    expect(CAMERA_WHITE / SUNLIT_WHITE).toBeLessThan(3);
    // (AgX's own white: its outset rows sum to 0.9998, so display white is 0.9996, 255 of 255, on both curves.)
    expect(g(CAMERA_WHITE, 2)).toBeGreaterThan(0.9995);
    expect(g(50, 2)).toBe(g(CAMERA_WHITE, 2));
    expect(g(50, 1)).toBeCloseTo(0.9966, 3);
    // The present curve for comparison: 250 of 255 needs ten times sunlit white.
    expect(255 * srgbEncode(g(8, 1))).toBeLessThan(248);
  });

  it('is monotone and has no kink from the toe to white: the log-log slope of a grey changes by under 0.15 per quarter stop below the shoulder', () => {
    let prev = 0;
    for (let s = -8; s <= 5; s += 0.01) {
      const y = g(MID * 2 ** s, 2);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    const slope = (s: number): number => Math.log2(g(MID * 2 ** (s + 0.01), 2) / g(MID * 2 ** (s - 0.01), 2)) / 0.02;
    const shoulder = Math.log2(CAMERA_SHOULDER_FROM / CAMERA_GAIN / MID);
    for (let s = -7; s + 0.25 <= shoulder; s += 0.05) expect(Math.abs(slope(s + 0.25) - slope(s)), `at ${s.toFixed(2)} stops`).toBeLessThan(0.15);
    // In the shoulder the slope falls to nothing without a step: by under 0.5 per tenth of a stop.
    for (let s = shoulder - 0.1; s < Math.log2(CAMERA_WHITE / MID); s += 0.02) expect(Math.abs(slope(s + 0.1) - slope(s)), `at ${s.toFixed(2)} stops`).toBeLessThan(0.5);
  });

  it("takes a bright saturated colour to white through AgX's primaries, channel by channel, and never reorders its channels", () => {
    for (const tint of [[1, 0.45, 0.08], [0.1, 0.4, 1], [1, 0.9, 0.2]] as const) {
      let last = displayLinear([0.05 * tint[0], 0.05 * tint[1], 0.05 * tint[2]], 2);
      for (let s = -1; s <= 9; s += 0.25) {
        const c = displayLinear([MID * 2 ** s * tint[0], MID * 2 ** s * tint[1], MID * 2 ** s * tint[2]], 2);
        // (A channel at the clip settles from 1 to AgX's white, 0.9996, once all three are there.)
        for (let i = 0; i < 3; i++) expect(c[i]!).toBeGreaterThanOrEqual(last[i]! - 5e-4);
        const order = [0, 1, 2].sort((a, b) => tint[b]! - tint[a]!);
        expect(c[order[0]!]!).toBeGreaterThanOrEqual(c[order[1]!]! - 5e-4);
        expect(c[order[1]!]!).toBeGreaterThanOrEqual(c[order[2]!]! - 5e-4);
        last = c;
      }
      // Nine stops over mid-grey: white.
      expect(Math.min(...last)).toBeGreaterThan(0.97);
    }
  });

  it('the shader of look 2 is the present text with the three lines of the curve replaced', () => {
    const wgsl = tonemapWgsl(2);
    expect(wgsl).not.toBe(TONEMAP_WGSL);
    expect(wgsl).toContain('camGrey');
    expect(wgsl.length).toBeGreaterThan(TONEMAP_WGSL.length);
    // Everything but the curve is the present pass.
    expect(wgsl.split('fn displayTransform')[1]).toBe(TONEMAP_WGSL.split('fn displayTransform')[1]);
  });

  it('both shaders of the pass (with the scrim step and without it) carry the same curve under each look', () => {
    // The pass draws a pixel with one or the other (post/tonemap.ts Tonemap.draw): the display transform must be one.
    expect(tonemapBaseWgsl(1)).toBe(TONEMAP_BASE_WGSL);
    const base = tonemapBaseWgsl(2);
    expect(base).not.toBe(TONEMAP_BASE_WGSL);
    expect(base).toContain('camGrey');
    expect(base).not.toMatch(/scrim/i);
    expect(base.split('fn displayTransform')[1]).toBe(TONEMAP_BASE_WGSL.split('fn displayTransform')[1]);
    const curve = (t: string): string => t.slice(t.indexOf('fn agxContrast'), t.indexOf('fn compress'));
    for (const look of [1, 2] as const) {
      expect(curve(tonemapBaseWgsl(look)).length).toBeGreaterThan(1500);
      expect(curve(tonemapBaseWgsl(look))).toBe(curve(tonemapWgsl(look)));
    }
    expect(curve(tonemapWgsl(2))).not.toBe(curve(tonemapWgsl(1)));
  });
});
