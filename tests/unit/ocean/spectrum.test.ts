/**
 * The FFT spectrum: high-passed (no energy at or above the swell cut-off wavelength), split into disjoint
 * cascade bands, amplitudes normalised so the realised variance estimates the spectrum's integral, phases
 * exactly periodic, and the resolved slope variance below the Cox-Munk total it is completed to.
 */
import { describe, expect, it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { TWO_PI } from '@/core/math';
import { buildCascades } from '@/render/ocean/cascades';
import { coxMunkVariance, GGX_KAPPA, oceanTunables } from '@/render/ocean/params';
import { cascadeBands, FFT_SIZE, freqIndex, highPass, integrateSpectrum, spectrumK, spreading } from '@/render/ocean/spectrum';
import { swellSlopeVariance } from '@/render/ocean/swell';

const defs = await loadDefs(fsDefSource());
const earth = Object.values(defs.bodies).find((b) => b.ocean !== null)!;
const t = oceanTunables(earth)!;
const set = buildCascades(t);

describe('ocean spectrum', () => {
  it('is high-passed: zero at and above the cut-off wavelength, full strength from 1.6 x the cut-off wavenumber', () => {
    const kHp = TWO_PI / t.highPassWavelength;
    expect(highPass(kHp, t.highPassWavelength)).toBe(0);
    expect(highPass(kHp * 0.5, t.highPassWavelength)).toBe(0);
    expect(highPass(kHp * 1.6, t.highPassWavelength)).toBe(1);
    for (const lambda of [25, 40, 100, 180, 1000]) {
      for (let a = 0; a < 16; a++) {
        const k = TWO_PI / lambda;
        expect(spectrumK(k * Math.cos(a), k * Math.sin(a), set.params)).toBe(0);
      }
    }
    expect(spectrumK(0.6, 0.2, set.params)).toBeGreaterThan(0);
  });

  it('realised cascades carry no energy at wavelengths of the swell (>= the cut-off)', () => {
    for (const s of set.spectra) {
      const dk = TWO_PI / s.band.length;
      for (let j = 0; j < FFT_SIZE; j++) {
        for (let i = 0; i < FFT_SIZE; i++) {
          const k = Math.hypot(freqIndex(i), freqIndex(j)) * dk;
          if (k > TWO_PI / t.highPassWavelength) continue;
          const o = (j * FFT_SIZE + i) * 4;
          expect(s.h0[o]! ** 2 + s.h0[o + 1]! ** 2).toBe(0);
        }
      }
    }
  });

  it('has disjoint, contiguous bands; each cascade keeps 70 % of its Nyquist wavenumber', () => {
    const bands = cascadeBands(t.cascadePeriod, t.cascadeDivisors);
    expect(bands.map((b) => Math.round(b.length * 1000) / 1000)).toEqual([8192 / 7, 8192 / 29, 8192 / 113, 8192 / 449].map((x) => Math.round(x * 1000) / 1000));
    for (let c = 1; c < bands.length; c++) expect(bands[c]!.kLow).toBe(bands[c - 1]!.kHigh);
    for (const b of bands) expect(b.kHigh).toBeCloseTo((0.7 * Math.PI * FFT_SIZE) / b.length, 9);
    // The cascade periods divide the planet-fixed period: wrapping by 8192 m is invisible.
    for (const b of bands) expect(Math.abs(t.cascadePeriod / b.length - Math.round(t.cascadePeriod / b.length))).toBeLessThan(1e-9);
  });

  it('realises the integral of the spectrum: height and slope variance within 10 % of the numerical integral', () => {
    const kMin = TWO_PI / t.highPassWavelength;
    const kMax = set.spectra[set.spectra.length - 1]!.band.kHigh;
    const hInt = integrateSpectrum(set.params, kMin, kMax);
    const sInt = integrateSpectrum(set.params, kMin, kMax, true);
    const hReal = set.spectra.reduce((s, c) => s + c.heightVariance, 0);
    const sReal = set.spectra.reduce((s, c) => s + c.slopeVariance, 0);
    expect(hReal / hInt).toBeGreaterThan(0.9);
    expect(hReal / hInt).toBeLessThan(1.1);
    expect(sReal / sInt).toBeGreaterThan(0.9);
    expect(sReal / sInt).toBeLessThan(1.1);
  });

  it('leaves room under Cox-Munk: swell + FFT + long-wave slope variance below 0.003 + 0.00512 U10', () => {
    const fft = set.spectra.reduce((s, c) => s + c.slopeVariance, 0);
    const cm = coxMunkVariance(t.windSpeed);
    expect(swellSlopeVariance(t.swell) + fft + set.long.slopeVariance).toBeLessThan(cm);
    expect(fft).toBeGreaterThan(0.2 * cm);
  });

  it('long-wave normals layer: the complement of the high-pass, with swell + layer = the spectrum above it', () => {
    const L = set.long;
    expect(L.band.length).toBeCloseTo(t.cascadePeriod / t.longWaveDivisor, 9);
    // It holds only what the cascades' high-pass leaves out: nothing at or below 15.6 m (full high-pass), and it
    // reaches the high-pass wavelength (its grid resolves the 25 m cut-off).
    const dk = TWO_PI / L.band.length;
    const kFull = 1.6 * (TWO_PI / t.highPassWavelength);
    for (let j = 0; j < FFT_SIZE; j++) {
      for (let i = 0; i < FFT_SIZE; i++) {
        const k = Math.hypot(freqIndex(i), freqIndex(j)) * dk;
        if (k < kFull) continue;
        const o = (j * FFT_SIZE + i) * 4;
        expect(L.h0[o]! ** 2 + L.h0[o + 1]! ** 2).toBe(0);
      }
    }
    expect(L.band.kHigh).toBeGreaterThan(TWO_PI / t.highPassWavelength);
    // Its slope variance completes the swell to the spectrum's long-wave slopes (numerical integral of the
    // complement, which the grid realises within 10 %).
    const kMin = TWO_PI / L.band.length;
    const full = integrateSpectrum({ ...set.params, highPassWavelength: 1e9 }, kMin, L.band.kHigh, true);
    const hp = integrateSpectrum(set.params, kMin, L.band.kHigh, true);
    const longPart = full - hp;
    const swell = swellSlopeVariance(t.swell);
    expect(longPart).toBeGreaterThan(swell);
    expect((L.slopeVariance + swell) / longPart).toBeGreaterThan(0.9);
    expect((L.slopeVariance + swell) / longPart).toBeLessThan(1.1);
    expect(L.gain).toBeGreaterThan(0);
    expect(L.gain).toBeLessThan(1);
  });

  it('spreading is normalised and the dispersion indices are exact integers', () => {
    for (const s of [0.5, 2, 8, 30]) {
      let sum = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) sum += spreading(-Math.PI + ((i + 0.5) / n) * TWO_PI, s) * (TWO_PI / n);
      expect(sum).toBeCloseTo(1, 4);
    }
    for (const sp of set.spectra) for (let i = 0; i < 4096; i++) expect(Number.isInteger(sp.omegaIndex[i * 13]!)).toBe(true);
  });

  it('Hermitian pairs: h0 at -k is the conjugate partner of h0 at k', () => {
    const s = set.spectra[1]!;
    for (const [i, j] of [
      [3, 5],
      [40, 200],
      [250, 17],
    ] as const) {
      const a = (j * FFT_SIZE + i) * 4;
      const im = (FFT_SIZE - i) % FFT_SIZE;
      const jm = (FFT_SIZE - j) % FFT_SIZE;
      const b = (jm * FFT_SIZE + im) * 4;
      expect(s.h0[a + 2]).toBe(s.h0[b]);
      expect(s.h0[a + 3]).toBe(-s.h0[b + 1]!);
    }
  });

  it('a GGX lobe of alpha = KAPPA sigma halves where the Gaussian of mean square slope sigma^2 does', () => {
    const sigma = Math.sqrt(coxMunkVariance(t.windSpeed));
    const alpha = GGX_KAPPA * sigma;
    const ggx = (tan: number): number => (alpha * alpha) / (alpha * alpha + tan * tan) ** 2 / (1 / (alpha * alpha));
    const gaussHalf = sigma * Math.sqrt(Math.LN2);
    expect(ggx(gaussHalf)).toBeCloseTo(0.5, 6);
  });
});
