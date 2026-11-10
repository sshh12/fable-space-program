import { describe, expect, it } from 'vitest';
import { rmsOf } from '@/audio/analysis';
import { CRACKLE_LEVELS, crackleWeights, generateNoise, NOISE_KINDS, noiseBufferShape, type NoiseKind } from '@/audio/noise';

const SR = 48000;
const gen = (kind: NoiseKind, seconds: number, seed = 3, rate = SR): Float32Array => {
  const x = new Float32Array(Math.round(seconds * rate));
  generateNoise(kind, x, rate, seed);
  return x;
};

/** Sample-to-sample steps inside the buffer, and the step across the loop point. */
function steps(x: Float32Array): { wrap: number; max: number; rms: number } {
  let max = 0;
  let sq = 0;
  for (let i = 1; i < x.length; i++) {
    const d = Math.abs(x[i]! - x[i - 1]!);
    max = Math.max(max, d);
    sq += d * d;
  }
  return { wrap: Math.abs(x[0]! - x[x.length - 1]!), max, rms: Math.sqrt(sq / (x.length - 1)) };
}

describe('procedural noise buffers', () => {
  it('are normalised: brown and pink RMS 0.1, crackle 0.1 * sqrt(rate / 100)', () => {
    expect(rmsOf(gen('brown', 20))).toBeCloseTo(0.1, 2);
    expect(rmsOf(gen('pink', 20))).toBeCloseTo(0.1, 2);
    for (const r of CRACKLE_LEVELS) {
      const rms = rmsOf(gen(`crackle-${r}`, 120, 11));
      expect(rms / (0.1 * Math.sqrt(r / 100)), `crackle-${r}`).toBeGreaterThan(0.85);
      expect(rms / (0.1 * Math.sqrt(r / 100)), `crackle-${r}`).toBeLessThan(1.15);
    }
  });
  it('crackle is a positively skewed impulse train (N-wave signature), noise is not', () => {
    const skew = (x: Float32Array): number => {
      let m2 = 0;
      let m3 = 0;
      for (const v of x) {
        m2 += v * v;
        m3 += v * v * v;
      }
      return m3 / x.length / (m2 / x.length) ** 1.5;
    };
    expect(skew(gen('crackle-80', 30))).toBeGreaterThan(5);
    expect(Math.abs(skew(gen('pink', 10)))).toBeLessThan(0.2);
  });
  it('slow modulation is bounded to [-1, 1] and smooth', () => {
    for (const kind of ['slow-a', 'slow-b'] as const) {
      const shape = noiseBufferShape(kind, SR);
      const x = new Float32Array(shape.length);
      generateNoise(kind, x, shape.sampleRate, 9);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of x) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeGreaterThanOrEqual(-1);
      expect(rmsOf(x)).toBeGreaterThan(0.35);
      // One knot per second: no step anywhere is larger than a cosine ramp between two extremes allows.
      expect(steps(x).max).toBeLessThan((2 * Math.PI) / 2 / shape.sampleRate + 1e-6);
    }
  });
  it('every buffer loops seamlessly: the step across the loop point is an ordinary step', () => {
    for (const kind of NOISE_KINDS) {
      const shape = noiseBufferShape(kind, SR);
      const x = new Float32Array(shape.length);
      generateNoise(kind, x, shape.sampleRate, 0x51ed);
      const s = steps(x);
      expect(s.wrap, `${kind}: wrap step vs largest in-buffer step`).toBeLessThanOrEqual(s.max);
      if (!kind.startsWith('crackle')) expect(s.wrap, `${kind}: wrap step vs RMS step`).toBeLessThan(5 * s.rms);
    }
  });
  it('the slow modulator never repeats within 30 s, even at the fastest allowed turbulence rate', () => {
    const knots = (kind: 'slow-a' | 'slow-b'): number => {
      const s = noiseBufferShape(kind, SR);
      return s.length / s.sampleRate;
    };
    const a = knots('slow-a');
    const b = knots('slow-b');
    const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
    expect(Number.isInteger(a) && Number.isInteger(b)).toBe(true);
    expect(gcd(a, b)).toBe(1);
    const maxHz = 50; // audio/engines.json and environment.json validate turbulenceHz <= 50
    expect((a * b) / maxHz).toBeGreaterThan(30);
    // At the fastest rate the data uses (9 Hz) each component alone runs longer than 14 s before it repeats.
    expect(Math.min(a, b) / 9).toBeGreaterThan(14);
  });
  it('is deterministic per seed and decorrelated across seeds', () => {
    expect(gen('pink', 1, 5)).toEqual(gen('pink', 1, 5));
    const a = gen('pink', 1, 5);
    const b = gen('pink', 1, 6);
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    expect(Math.abs(dot / (rmsOf(a) * rmsOf(b) * a.length))).toBeLessThan(0.05);
  });
  it('crackle density crossfades with constant power between levels', () => {
    expect(crackleWeights(0)).toEqual([0, 0, 0]);
    for (const r of [25, 40, 80, 150, 300]) {
      const w = crackleWeights(r);
      expect(w.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 9);
    }
    expect(crackleWeights(5)[0]).toBeCloseTo(0.5, 9);
    expect(crackleWeights(1280)[2]).toBeCloseTo(2, 9);
  });
});
