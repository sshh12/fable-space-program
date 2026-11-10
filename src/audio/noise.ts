/**
 * Procedural noise sources as long seeded AudioBuffers (no AudioWorklet: buffer sources render
 * identically live and offline, sample for sample). Each voice plays them from its own seeded offset,
 * so voices are decorrelated; the buffers are tens of seconds long and filtered/modulated downstream,
 * so nothing audibly loops.
 *
 *   brown     leaky-integrated white noise (6 dB/octave above ~150 Hz)                RMS 0.1
 *   pink      Kellet's 7-pole approximation (3 dB/octave)                              RMS 0.1
 *   crackle-N Poisson train of steep positive pressure spikes (heavy-tailed amplitudes,
 *             slower negative recovery: the skewed N-wave of supersonic jet crackle) at
 *             N events/s; RMS 0.1 * sqrt(N / 100). Densities in between are equal-power
 *             crossfades of neighbouring levels (crackleWeights).
 *   slow      smooth bounded random modulation in [-1, 1] at 1 Hz (cosine-interpolated value
 *             noise), RMS about 0.5; played at playbackRate = desired Hz.
 */
export type NoiseKind = 'brown' | 'pink' | 'slow' | `crackle-${number}`;

/** Crackle density levels, events per second. */
export const CRACKLE_LEVELS = [20, 80, 320] as const;

const SECONDS: Record<string, number> = { brown: 21.37, pink: 17.93, slow: 47.3, 'crackle-20': 23.11, 'crackle-80': 19.87, 'crackle-320': 16.43 };
const SLOW_RATE = 3000;

class Xorshift {
  private s: number;
  constructor(seed: number) {
    this.s = (seed ^ 0x9e3779b9) >>> 0 || 1;
    for (let i = 0; i < 8; i++) this.next();
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
}

/** Fill `out` with one kind of noise at `sampleRate` (pure; exported for unit tests). */
export function generateNoise(kind: NoiseKind, out: Float32Array, sampleRate: number, seed: number): void {
  const rng = new Xorshift(seed);
  const n = out.length;
  if (kind === 'brown') {
    const a = 0.98;
    const gain = 0.1 / ((0.02 * Math.sqrt(1 / 3)) / Math.sqrt(1 - a * a));
    let b = 0;
    for (let i = 0; i < 2000; i++) b = a * b + 0.02 * (rng.next() * 2 - 1);
    for (let i = 0; i < n; i++) {
      b = a * b + 0.02 * (rng.next() * 2 - 1);
      out[i] = b * gain;
    }
  } else if (kind === 'pink') {
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    let p4 = 0;
    let p5 = 0;
    let p6 = 0;
    for (let i = -4000; i < n; i++) {
      const w = rng.next() * 2 - 1;
      p0 = 0.99886 * p0 + w * 0.0555179;
      p1 = 0.99332 * p1 + w * 0.0750759;
      p2 = 0.969 * p2 + w * 0.153852;
      p3 = 0.8665 * p3 + w * 0.3104856;
      p4 = 0.55 * p4 + w * 0.5329522;
      p5 = -0.7616 * p5 - w * 0.016898;
      const v = p0 + p1 + p2 + p3 + p4 + p5 + p6 + w * 0.5362;
      p6 = w * 0.115926;
      if (i >= 0) out[i] = v * 0.0572;
    }
  } else if (kind === 'slow') {
    let a = rng.next() * 2 - 1;
    let b = rng.next() * 2 - 1;
    let t = 0;
    const step = 1 / sampleRate;
    for (let i = 0; i < n; i++) {
      t += step;
      if (t >= 1) {
        t -= 1;
        a = b;
        b = rng.next() * 2 - 1;
      }
      out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  } else {
    const rate = Number(kind.slice('crackle-'.length));
    const p = rate / sampleRate;
    const lpC = Math.exp((-2 * Math.PI * 7000) / sampleRate);
    const hpR = Math.exp((-2 * Math.PI * 180) / sampleRate);
    let lp = 0;
    let hpX = 0;
    let hpY = 0;
    // 2.04 normalises a 100/s train to RMS 0.1 (measured over minutes of output in the unit test).
    const gain = 2.04;
    for (let i = 0; i < n; i++) {
      let x = 0;
      if (rng.next() < p) {
        const u = Math.max(1e-6, rng.next());
        const amp = Math.min(5, u ** (-1 / 2.6));
        x = rng.next() < 0.85 ? amp : -0.5 * amp;
      }
      lp = lpC * lp + (1 - lpC) * x;
      hpY = lp - hpX + hpR * hpY;
      hpX = lp;
      out[i] = hpY * gain;
    }
  }
}

/** Crossfade weights over CRACKLE_LEVELS for a target rate (events/s); all 0 for rate <= 0. */
export function crackleWeights(rate: number): number[] {
  const w = CRACKLE_LEVELS.map(() => 0);
  if (!(rate > 0)) return w;
  const lo = CRACKLE_LEVELS[0];
  const hi = CRACKLE_LEVELS[CRACKLE_LEVELS.length - 1]!;
  if (rate <= lo) {
    w[0] = Math.sqrt(rate / lo);
    return w;
  }
  if (rate >= hi) {
    w[w.length - 1] = Math.sqrt(rate / hi);
    return w;
  }
  const x = Math.log(rate / lo) / Math.log(CRACKLE_LEVELS[1] / lo);
  const i = Math.min(CRACKLE_LEVELS.length - 2, Math.floor(x));
  const t = x - i;
  w[i] = Math.cos((Math.PI / 2) * t);
  w[i + 1] = Math.sin((Math.PI / 2) * t);
  return w;
}

export type NoiseBank = Map<NoiseKind, AudioBuffer>;

const banks = new Map<number, NoiseBank>();

/** The shared noise buffers for a sample rate (AudioBuffers are not tied to a context). */
export function noiseBank(ctx: BaseAudioContext): NoiseBank {
  const sr = ctx.sampleRate;
  let bank = banks.get(sr);
  if (bank) return bank;
  bank = new Map();
  const kinds: NoiseKind[] = ['brown', 'pink', 'slow', ...CRACKLE_LEVELS.map((r) => `crackle-${r}` as const)];
  kinds.forEach((kind, i) => {
    const rate = kind === 'slow' ? SLOW_RATE : sr;
    const buf = ctx.createBuffer(1, Math.round(SECONDS[kind]! * rate), rate);
    generateNoise(kind, buf.getChannelData(0), rate, 0x51ed + 7919 * i);
    bank.set(kind, buf);
  });
  banks.set(sr, bank);
  return bank;
}

/** A looping noise source starting at a seeded offset. */
export function noiseSource(ctx: BaseAudioContext, bank: NoiseBank, kind: NoiseKind, seed: number, time: number, playbackRate = 1): AudioBufferSourceNode {
  const buffer = bank.get(kind)!;
  const src = new AudioBufferSourceNode(ctx, { buffer, loop: true, playbackRate });
  src.start(time, (((seed >>> 0) % 100003) / 100003) * buffer.duration);
  return src;
}
