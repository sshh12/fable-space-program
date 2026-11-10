/**
 * Offline DSP helpers for the audio asset pipeline (Node, build time only): loudness (ITU-R BS.1770-4
 * K-weighting with gating), trimming, equal-power loop crossfades, silence splitting, spectral centroid
 * and 16-bit quantisation with TPDF dither. Pure functions on Float32Array/Float64Array, 48 kHz mono.
 */

export const SAMPLE_RATE = 48000;

/** Biquad direct form I applied in place to a copy. */
function biquad(x, b, a) {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** K-weighting filter coefficients of BS.1770-4 at 48 kHz. */
export function kWeight(x) {
  const s1 = biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
  return biquad(s1, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
}

/** Mean squares of 400 ms blocks with 75 % overlap of the K-weighted signal. */
function blockPowers(x, blockSeconds = 0.4) {
  const k = kWeight(x);
  const n = Math.round(blockSeconds * SAMPLE_RATE);
  const hop = Math.round(n / 4);
  const out = [];
  if (k.length < n) {
    let s = 0;
    for (let i = 0; i < k.length; i++) s += k[i] * k[i];
    out.push(s / Math.max(1, n));
    return out;
  }
  for (let start = 0; start + n <= k.length; start += hop) {
    let s = 0;
    for (let i = start; i < start + n; i++) s += k[i] * k[i];
    out.push(s / n);
  }
  return out;
}

const lufsOf = (power) => -0.691 + 10 * Math.log10(Math.max(power, 1e-20));

/** Integrated loudness with the absolute (-70 LUFS) and relative (-10 LU) gates. */
export function integratedLufs(x) {
  const blocks = blockPowers(x);
  const abs = blocks.filter((p) => lufsOf(p) > -70);
  if (abs.length === 0) return -Infinity;
  const mean = abs.reduce((s, p) => s + p, 0) / abs.length;
  const rel = abs.filter((p) => lufsOf(p) > lufsOf(mean) - 10);
  return lufsOf(rel.reduce((s, p) => s + p, 0) / rel.length);
}

/** Maximum momentary (400 ms) loudness: the level of a one-shot at its loudest moment. */
export function maxMomentaryLufs(x) {
  return Math.max(...blockPowers(x).map(lufsOf));
}

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

export function scale(x, g) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

/** First-order DC blocker (high-pass at about `hz`). */
export function removeDc(x, hz = 12) {
  const r = Math.exp((-2 * Math.PI * hz) / SAMPLE_RATE);
  const y = new Float64Array(x.length);
  let xp = 0;
  let yp = 0;
  for (let i = 0; i < x.length; i++) {
    yp = x[i] - xp + r * yp;
    xp = x[i];
    y[i] = yp;
  }
  return y;
}

/**
 * Second-order Butterworth high-pass at `hz`, run forward and backward (zero phase, 24 dB/octave) so
 * one-shot attacks keep their shape. Removes the infrasonic energy that generators put under thumps,
 * which no speaker reproduces but which would otherwise set the peak normalisation.
 */
export function highpassZeroPhase(x, hz) {
  const w = Math.tan((Math.PI * hz) / SAMPLE_RATE);
  const k = 1 / (1 + Math.SQRT2 * w + w * w);
  const b = [k, -2 * k, k];
  const a = [1, 2 * (w * w - 1) * k, (1 - Math.SQRT2 * w + w * w) * k];
  const fwd = biquad(x, b, a);
  fwd.reverse();
  const back = biquad(fwd, b, a);
  back.reverse();
  return back;
}

/** RMS envelope in windows of `win` seconds. */
export function envelope(x, win = 0.01) {
  const n = Math.max(1, Math.round(win * SAMPLE_RATE));
  const out = new Float64Array(Math.ceil(x.length / n));
  for (let w = 0; w < out.length; w++) {
    let s = 0;
    const end = Math.min(x.length, (w + 1) * n);
    for (let i = w * n; i < end; i++) s += x[i] * x[i];
    out[w] = Math.sqrt(s / Math.max(1, end - w * n));
  }
  return out;
}

/**
 * One-shot trim: start a few ms before the first sample above peak-50 dB, end 20 ms after the last
 * sample above peak-60 dB, raised-cosine fades of `fadeIn`/`fadeOut` seconds.
 */
export function trimOneShot(x, { preRoll = 0.004, fadeIn = 0.002, fadeOut = 0.04 } = {}) {
  const p = peak(x);
  if (p === 0) throw new Error('silent recording');
  const startThr = p * 10 ** (-50 / 20);
  const endThr = p * 10 ** (-60 / 20);
  let s = 0;
  while (s < x.length && Math.abs(x[s]) < startThr) s++;
  let e = x.length - 1;
  while (e > s && Math.abs(x[e]) < endThr) e--;
  s = Math.max(0, s - Math.round(preRoll * SAMPLE_RATE));
  e = Math.min(x.length, e + Math.round(0.02 * SAMPLE_RATE));
  const y = x.slice(s, e);
  const fi = Math.min(y.length >> 1, Math.round(fadeIn * SAMPLE_RATE));
  const fo = Math.min(y.length >> 1, Math.round(fadeOut * SAMPLE_RATE));
  for (let i = 0; i < fi; i++) y[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
  for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  return y;
}

/**
 * Seamless loop by equal-power crossfade: the last `xf` seconds are faded into the first `xf` seconds
 * (sin/cos law, right for uncorrelated noise-like material) and the result is `xf` shorter. Sample
 * N-1 of the output is followed in the source by sample 0 of the output, so the wrap is continuous.
 * `edgeTrim` seconds are first cut from both ends (generators often fade their edges).
 */
export function makeLoop(x, xf, edgeTrim = 0.1) {
  const t = Math.round(edgeTrim * SAMPLE_RATE);
  const src = x.slice(t, x.length - t);
  const X = Math.round(xf * SAMPLE_RATE);
  if (src.length < 3 * X) throw new Error(`recording too short (${(src.length / SAMPLE_RATE).toFixed(2)} s) for a ${xf} s crossfade`);
  const L = src.length - X;
  const y = new Float64Array(L);
  for (let i = 0; i < L; i++) y[i] = src[i];
  for (let i = 0; i < X; i++) {
    const a = (Math.PI / 2) * (i / X);
    y[i] = src[i] * Math.sin(a) + src[L + i] * Math.cos(a);
  }
  return y;
}

/**
 * Loop seam quality: RMS of the 30 ms across the wrap point compared with the median of 30 ms windows
 * elsewhere (1.0 = indistinguishable), and the first-difference jump at the wrap relative to the RMS
 * of first differences.
 */
export function loopSeam(y) {
  const w = Math.round(0.03 * SAMPLE_RATE);
  const across = new Float64Array(2 * w);
  for (let i = 0; i < w; i++) {
    across[i] = y[y.length - w + i];
    across[w + i] = y[i];
  }
  const windows = [];
  for (let s = 0; s + 2 * w < y.length; s += 2 * w) windows.push(rms(y.subarray(s, s + 2 * w)));
  windows.sort((a, b) => a - b);
  const median = windows[windows.length >> 1] ?? 1;
  let d2 = 0;
  for (let i = 1; i < y.length; i++) d2 += (y[i] - y[i - 1]) ** 2;
  const dRms = Math.sqrt(d2 / (y.length - 1));
  return { rmsRatio: rms(across) / median, jumpRatio: Math.abs(y[0] - y[y.length - 1]) / dRms };
}

/** Segments above `thresholdDb` (re: envelope peak) separated by gaps of at least `minGap` seconds. */
export function splitAtSilence(x, { count, minGap, minLength, thresholdDb = -38 }) {
  const win = 0.005;
  const env = envelope(x, win);
  const thr = peak(env) * 10 ** (thresholdDb / 20);
  const segs = [];
  let cur = null;
  let gap = 0;
  for (let w = 0; w < env.length; w++) {
    if (env[w] >= thr) {
      if (cur === null) cur = { start: w, end: w };
      else cur.end = w;
      gap = 0;
    } else if (cur !== null) {
      gap++;
      if (gap * win >= minGap) {
        segs.push(cur);
        cur = null;
        gap = 0;
      }
    }
  }
  if (cur !== null) segs.push(cur);
  const pad = Math.round(0.03 / win);
  const parts = segs
    .map((s) => ({ start: Math.max(0, s.start - pad), end: Math.min(env.length, s.end + 2 * pad) }))
    .filter((s) => (s.end - s.start) * win >= minLength)
    .map((s) => ({ ...s, energy: rms(x.subarray(Math.round(s.start * win * SAMPLE_RATE), Math.round(s.end * win * SAMPLE_RATE))) }));
  if (parts.length < count) throw new Error(`found ${parts.length} separate sounds, need ${count}`);
  const keep = parts
    .slice()
    .sort((a, b) => b.energy - a.energy)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
  return keep.map((s) => x.slice(Math.round(s.start * win * SAMPLE_RATE), Math.round(s.end * win * SAMPLE_RATE)));
}

/** Power spectrum (Hann window, 4096-point frames, 50 % overlap), averaged. Returns { freqs, power }. */
export function averageSpectrum(x, n = 4096) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const acc = new Float64Array(n / 2);
  let frames = 0;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  for (let s = 0; s + n <= x.length || (frames === 0 && s === 0); s += n / 2) {
    for (let i = 0; i < n; i++) {
      re[i] = (x[s + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
    if (s + n > x.length) break;
  }
  const freqs = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    freqs[k] = (k * SAMPLE_RATE) / n;
    acc[k] /= frames;
  }
  return { freqs, power: acc };
}

export function spectralCentroid(x) {
  const { freqs, power } = averageSpectrum(x);
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    num += freqs[k] * power[k];
    den += power[k];
  }
  return den > 0 ? num / den : 0;
}

/** In-place radix-2 FFT. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar;
        im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar;
        im[i + j] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Float -> int16 little-endian with TPDF dither from a seeded xorshift generator (deterministic output). */
export function toInt16(x, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const buf = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * 32767 + (rnd() - rnd()));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return buf;
}
