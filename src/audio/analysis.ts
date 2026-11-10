/**
 * Level measurements shared by the live probe (AnalyserNode data) and offline renders (whole buffers).
 * Bands: low < 250 Hz, mid 250-2000 Hz, high > 2000 Hz. Band levels are reported as the RMS amplitude of
 * that band (low^2 + mid^2 + high^2 = rms^2), so they compare directly with `rms`.
 */
export const BAND_EDGES_HZ = [250, 2000] as const;

export interface Levels {
  rms: number;
  peak: number;
  low: number;
  mid: number;
  high: number;
}

export const SILENT_LEVELS: Levels = { rms: 0, peak: 0, low: 0, mid: 0, high: 0 };

export function rmsOf(x: ArrayLike<number>, start = 0, end = x.length): number {
  let s = 0;
  const a = Math.max(0, start);
  const b = Math.min(x.length, end);
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}

export function peakOf(x: ArrayLike<number>, start = 0, end = x.length): number {
  let p = 0;
  for (let i = Math.max(0, start); i < Math.min(x.length, end); i++) {
    const v = Math.abs(x[i]!);
    if (v > p) p = v;
  }
  return p;
}

export const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/** In-place radix-2 FFT (n a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Average power spectrum (Hann window, 50 % overlap). Bin k is at k * sampleRate / n. */
export function powerSpectrum(x: ArrayLike<number>, start = 0, end = x.length, n = 4096): Float64Array {
  const acc = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  let frames = 0;
  for (let s = Math.max(0, start); s + n <= Math.min(x.length, end); s += n >> 1) {
    for (let i = 0; i < n; i++) {
      re[i] = x[s + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) acc[k] = acc[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  if (frames > 0) for (let k = 0; k < n / 2; k++) acc[k] = acc[k]! / frames;
  return acc;
}

/** Split an RMS level into bands by the shares of a power spectrum (bins of width sampleRate / (2 * bins)). */
export function splitBands(rms: number, power: ArrayLike<number>, sampleRate: number): { low: number; mid: number; high: number } {
  const binHz = sampleRate / (2 * power.length);
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    const p = power[k]!;
    if (f < BAND_EDGES_HZ[0]) low += p;
    else if (f < BAND_EDGES_HZ[1]) mid += p;
    else high += p;
  }
  const total = low + mid + high;
  if (!(total > 0) || !(rms > 0)) return { low: 0, mid: 0, high: 0 };
  return { low: rms * Math.sqrt(low / total), mid: rms * Math.sqrt(mid / total), high: rms * Math.sqrt(high / total) };
}

/** Levels of a stretch of samples. */
export function levelsOf(x: ArrayLike<number>, sampleRate: number, start = 0, end = x.length): Levels {
  const rms = rmsOf(x, start, end);
  const span = Math.min(x.length, end) - Math.max(0, start);
  const n = span >= 4096 ? 4096 : span >= 1024 ? 1024 : 0;
  const bands = n > 0 ? splitBands(rms, powerSpectrum(x, start, end, n), sampleRate) : { low: 0, mid: 0, high: 0 };
  return { rms, peak: peakOf(x, start, end), ...bands };
}

/** Power-weighted mean frequency, Hz (0 for silence). */
export function spectralCentroid(x: ArrayLike<number>, sampleRate: number, start = 0, end = x.length): number {
  const p = powerSpectrum(x, start, end);
  const binHz = sampleRate / (2 * p.length);
  let num = 0;
  let den = 0;
  for (let k = 1; k < p.length; k++) {
    num += k * binHz * p[k]!;
    den += p[k]!;
  }
  return den > 0 ? num / den : 0;
}

/** Short-time RMS envelope with windows of `win` seconds. */
export function envelope(x: ArrayLike<number>, sampleRate: number, win = 0.005): Float64Array {
  const n = Math.max(1, Math.round(win * sampleRate));
  const out = new Float64Array(Math.ceil(x.length / n));
  for (let w = 0; w < out.length; w++) out[w] = rmsOf(x, w * n, (w + 1) * n);
  return out;
}

/**
 * Time (s) at which the short-time envelope first exceeds `fraction` of its maximum after `from` seconds;
 * null when the signal stays silent. Relative to each signal's own maximum, so a quiet distant copy and a
 * loud near copy of the same sound have comparable onsets.
 */
export function onsetTime(x: ArrayLike<number>, sampleRate: number, opts: { from?: number; fraction?: number; win?: number } = {}): number | null {
  const win = opts.win ?? 0.005;
  const env = envelope(x, sampleRate, win);
  const first = Math.floor((opts.from ?? 0) / win);
  let max = 0;
  for (let i = first; i < env.length; i++) if (env[i]! > max) max = env[i]!;
  if (!(max > 0)) return null;
  const thr = max * (opts.fraction ?? 0.1);
  for (let i = first; i < env.length; i++) if (env[i]! >= thr) return i * win;
  return null;
}

/** Levels from AnalyserNode data: time-domain samples and the dB spectrum (getFloatFrequencyData). */
export function levelsFromAnalyser(time: Float32Array, spectrumDb: Float32Array, sampleRate: number): Levels {
  const rms = rmsOf(time);
  const power = new Float64Array(spectrumDb.length);
  for (let k = 0; k < spectrumDb.length; k++) {
    const db = spectrumDb[k]!;
    power[k] = Number.isFinite(db) ? 10 ** (db / 10) : 0;
  }
  return { rms, peak: peakOf(time), ...splitBands(rms, power, sampleRate) };
}
