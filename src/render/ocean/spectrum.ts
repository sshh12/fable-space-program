/**
 * Wind-wave spectrum for the FFT cascades (CPU, float64): JONSWAP in frequency with the Hasselmann /
 * Mitsuyasu cos^2s directional spreading, converted to a wavevector spectrum through the capillary-gravity
 * dispersion relation, HIGH-PASSED so wavelengths at or above the swell cut-off carry no energy (the long
 * waves are the shared analytic swell, src/core/geo/oceanSwell.ts), and split into four disjoint k-bands, one
 * per cascade. Amplitudes are a deterministic Gaussian realisation (seeded integer hash); angular frequencies
 * are quantised to integer multiples of 2 pi / repeatPeriod so the shader evaluates every phase exactly in
 * float32 as 2 pi frac(m tau) with tau = frac(t / repeatPeriod) prepared in float64.
 */
import { hash4, hashToUnit, TWO_PI } from '@/core/math';

export const FFT_SIZE = 256;
export const CASCADE_COUNT = 4;
/** Mip levels of a cascade texture (256 -> 1). */
export const CASCADE_MIPS = 9;
/** Capillary wavenumber of the capillary-gravity dispersion, rad/m (surface tension of sea water). */
export const K_CAPILLARY = 370;
/** Fraction of each cascade's Nyquist wavenumber that it carries; above that the next finer cascade takes over. */
export const BAND_FRACTION = 0.7;

export interface SpectrumParams {
  windSpeed: number;
  /** Direction the wind blows toward, as an angle in the cascade plane (rad, counter-clockwise from +x). */
  windAngle: number;
  fetch: number;
  gamma: number;
  gravity: number;
  highPassWavelength: number;
}

export interface CascadeBand {
  /** Patch length, m. */
  length: number;
  /** k-band [kLow, kHigh) carried by this cascade, rad/m. */
  kLow: number;
  kHigh: number;
}

/** Deep-water capillary-gravity dispersion omega(k), rad/s. */
export const dispersion = (k: number, g: number): number => Math.sqrt(g * k * (1 + (k / K_CAPILLARY) ** 2));
/** d omega / dk of `dispersion`. */
export function dispersionSlope(k: number, g: number): number {
  const w = dispersion(k, g);
  return (g * (1 + 3 * (k / K_CAPILLARY) ** 2)) / (2 * Math.max(w, 1e-9));
}

/** JONSWAP peak frequency (rad/s) and Phillips constant for a fetch-limited sea. */
export function jonswapPeak(windSpeed: number, fetch: number, g: number): { omegaP: number; alpha: number } {
  const omegaP = 22 * ((g * g) / (windSpeed * fetch)) ** (1 / 3);
  const alpha = 0.076 * ((windSpeed * windSpeed) / (fetch * g)) ** 0.22;
  return { omegaP, alpha };
}

/** JONSWAP frequency spectrum S(omega), m^2 s. */
export function jonswapOmega(omega: number, p: SpectrumParams): number {
  if (omega <= 0) return 0;
  const { omegaP, alpha } = jonswapPeak(p.windSpeed, p.fetch, p.gravity);
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  return ((alpha * p.gravity * p.gravity) / omega ** 5) * Math.exp(-1.25 * (omegaP / omega) ** 4) * p.gamma ** r;
}

function lnGamma(x: number): number {
  // Lanczos (g = 7, n = 9), accurate to ~1e-15 for x > 0.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(TWO_PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Spreading exponent s(omega) of the cos^2s(theta / 2) model (Mitsuyasu, as used by Hasselmann et al.). */
export function spreadingExponent(omega: number, omegaP: number, windSpeed: number, g: number): number {
  const sp = 11.5 * ((g / (omegaP * windSpeed)) ** 2.5);
  const x = omega / omegaP;
  return Math.max(0.5, x <= 1 ? sp * x ** 5 : sp * x ** -2.5);
}

/** Normalised directional spreading D(theta; s): integrates to 1 over (-pi, pi]. theta is relative to the wind. */
export function spreading(theta: number, s: number): number {
  const q = Math.exp((2 * s - 1) * Math.LN2 + 2 * lnGamma(s + 1) - lnGamma(2 * s + 1)) / Math.PI;
  return q * Math.abs(Math.cos(theta / 2)) ** (2 * s);
}

/** Smooth high-pass: 0 at and below kHp (= 2 pi / highPassWavelength), 1 from 1.6 kHp. */
export function highPass(k: number, highPassWavelength: number): number {
  const kHp = TWO_PI / highPassWavelength;
  const t = Math.min(1, Math.max(0, (k - kHp) / (0.6 * kHp)));
  return t * t * (3 - 2 * t);
}

/** Wavevector spectrum S(kx, ky), m^4 (variance per unit k-area), high-passed. */
export function spectrumK(kx: number, ky: number, p: SpectrumParams): number {
  const k = Math.hypot(kx, ky);
  if (k < 1e-9) return 0;
  const hp = highPass(k, p.highPassWavelength);
  if (hp === 0) return 0;
  const omega = dispersion(k, p.gravity);
  const { omegaP } = jonswapPeak(p.windSpeed, p.fetch, p.gravity);
  const theta = Math.atan2(ky, kx) - p.windAngle;
  const s = spreadingExponent(omega, omegaP, p.windSpeed, p.gravity);
  return (jonswapOmega(omega, p) * spreading(theta, s) * dispersionSlope(k, p.gravity) * hp) / k;
}

/** Patch lengths and k-bands of the four cascades. */
export function cascadeBands(period: number, divisors: readonly number[]): CascadeBand[] {
  const out: CascadeBand[] = [];
  let kLow = 0;
  for (const d of divisors) {
    const length = period / d;
    const kHigh = (BAND_FRACTION * Math.PI * FFT_SIZE) / length;
    out.push({ length, kLow, kHigh });
    kLow = kHigh;
  }
  return out;
}

/** Signed FFT frequency index of grid index i (standard FFT ordering, Nyquist at -N/2). */
export const freqIndex = (i: number, n = FFT_SIZE): number => (i < n / 2 ? i : i - n);

export interface CascadeSpectrum {
  band: CascadeBand;
  /** Per texel (j * N + i): h0(k).re, h0(k).im, conj(h0(-k)).re, conj(h0(-k)).im (m). */
  h0: Float32Array;
  /** Per texel: integer m with omega(k) ~ m * 2 pi / repeatPeriod (exactly representable in float32). */
  omegaIndex: Float32Array;
  /** Realised (time-averaged) variance of the height, m^2, and of the slope magnitude (both axes summed). */
  heightVariance: number;
  slopeVariance: number;
  /** Fraction of slopeVariance that survives the texture filter at mip level l (l = 0 .. CASCADE_MIPS - 1). */
  filteredSlopeFraction: number[];
  /** Representative angular frequency of the band (energy-weighted mean), rad/s, for the TMA depth factor. */
  meanOmega: number;
}

function gaussianPair(i: number, j: number, cascade: number, seed: number): [number, number] {
  const u1 = (hashToUnit(hash4(i, j, cascade, seed)) * 16777216 + 0.5) / 16777216;
  const u2 = hashToUnit(hash4(i, j, cascade + 101, seed ^ 0x5bd1e995));
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(TWO_PI * u2), r * Math.sin(TWO_PI * u2)];
}

const sinc = (x: number): number => (Math.abs(x) < 1e-6 ? 1 : Math.sin(x) / x);

/**
 * Initial spectrum of one cascade. Each grid wavevector belongs to exactly one cascade (|k| in its band), so
 * the four cascades together carry the high-passed spectrum once. Gaussian amplitudes satisfy
 * E[sum |h0(k)|^2 + |h0(-k)|^2] = sum S(k) dk^2, i.e. the realised height variance estimates the integral.
 */
export function buildCascadeSpectrum(cascade: number, band: CascadeBand, p: SpectrumParams, seed: number, repeatPeriod: number): CascadeSpectrum {
  const n = FFT_SIZE;
  const dk = TWO_PI / band.length;
  const omega0 = TWO_PI / repeatPeriod;
  const amp = new Float64Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const fi = freqIndex(i);
      const fj = freqIndex(j);
      const kx = fi * dk;
      const ky = fj * dk;
      const k = Math.hypot(kx, ky);
      const o = (j * n + i) * 2;
      if (fi === -n / 2 || fj === -n / 2 || k < band.kLow || k >= band.kHigh || k === 0) continue;
      const s = spectrumK(kx, ky, p);
      if (s <= 0) continue;
      const [gr, gi] = gaussianPair(i, j, cascade, seed);
      const a = (Math.sqrt(s) * dk) / 2;
      amp[o] = gr * a;
      amp[o + 1] = gi * a;
    }
  }
  const h0 = new Float32Array(n * n * 4);
  const omegaIndex = new Float32Array(n * n);
  let hVar = 0;
  let sVar = 0;
  let wSum = 0;
  let wE = 0;

  const filt = new Array<number>(CASCADE_MIPS).fill(0);
  const texel = band.length / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = j * n + i;
      const im = (n - i) % n;
      const jm = (n - j) % n;
      const om = jm * n + im;
      const re0 = amp[o * 2]!;
      const im0 = amp[o * 2 + 1]!;
      const reM = amp[om * 2]!;
      const imM = -amp[om * 2 + 1]!;
      h0[o * 4] = re0;
      h0[o * 4 + 1] = im0;
      h0[o * 4 + 2] = reM;
      h0[o * 4 + 3] = imM;
      const kx = freqIndex(i) * dk;
      const ky = freqIndex(j) * dk;
      const k = Math.hypot(kx, ky);
      const omega = dispersion(k, p.gravity);
      omegaIndex[o] = k > 0 ? Math.round(omega / omega0) : 0;
      // |H(k, t)|^2 averaged over time = |h0(k)|^2 + |h0(-k)|^2.
      const e = re0 * re0 + im0 * im0 + reM * reM + imM * imM;
      if (e === 0) continue;
      hVar += e;
      sVar += k * k * e;
      wSum += e;
      wE += e * omega;

      for (let l = 0; l < CASCADE_MIPS; l++) {
        const w = texel * 2 ** l;
        filt[l]! += k * k * e * (sinc((kx * w) / 2) * sinc((ky * w) / 2)) ** 2;
      }
    }
  }
  return {
    band,
    h0,
    omegaIndex,
    heightVariance: hVar,
    slopeVariance: sVar,
    filteredSlopeFraction: filt.map((f) => (sVar > 0 ? f / sVar : 0)),
    meanOmega: wSum > 0 ? wE / wSum : 0,
  };
}

/** Integral of S(k) over the plane between two wavenumbers (numerical, polar), m^2; with `slope` the slope variance. */
export function integrateSpectrum(p: SpectrumParams, kMin: number, kMax: number, slope = false, steps = 2000): number {
  let sum = 0;
  const lMin = Math.log(Math.max(kMin, 1e-6));
  const lMax = Math.log(kMax);
  const dl = (lMax - lMin) / steps;
  const nTheta = 180;
  for (let a = 0; a < steps; a++) {
    const k = Math.exp(lMin + (a + 0.5) * dl);
    let ring = 0;
    for (let b = 0; b < nTheta; b++) {
      const th = ((b + 0.5) / nTheta) * TWO_PI;
      ring += spectrumK(k * Math.cos(th), k * Math.sin(th), p);
    }
    ring *= TWO_PI / nTheta;
    sum += ring * k * k * dl * (slope ? k * k : 1);
  }
  return sum;
}
