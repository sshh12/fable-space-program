import { describe, expect, it } from 'vitest';
import { rmsOf } from '@/audio/analysis';
import { CRACKLE_LEVELS, crackleWeights, generateNoise, type NoiseKind } from '@/audio/noise';

const SR = 48000;
const gen = (kind: NoiseKind, seconds: number, seed = 3): Float32Array => {
  const x = new Float32Array(Math.round(seconds * SR));
  generateNoise(kind, x, SR, seed);
  return x;
};

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
  it('slow modulation is bounded to [-1, 1]', () => {
    const x = gen('slow', 60);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of x) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(rmsOf(x)).toBeGreaterThan(0.35);
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
