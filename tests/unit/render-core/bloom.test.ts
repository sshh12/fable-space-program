import { describe, expect, it } from 'vitest';
import { BLOOM_FALLOFF, BLOOM_LEVELS, bloomLevelCount, bloomWeights } from '@/render/core/post/postProcess';

/** The weights a chain of up passes with these blend factors gives its levels. */
function weightsOf(blend: number[]): number[] {
  const n = blend.length + 1;
  const w = new Array<number>(n).fill(0);
  let share = 1;
  for (let l = 0; l < n - 1; l++) {
    w[l] = share * (1 - blend[l]!);
    share *= blend[l]!;
  }
  w[n - 1] = share;
  return w;
}

describe('bloom as a glare spread function (request atmosphere-clouds-7)', () => {
  it('at the reference height every wider level carries half of the one before, the widest included', () => {
    const { weights, blend } = bloomWeights(720);
    expect(weights).toHaveLength(BLOOM_LEVELS);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    for (let l = 1; l < weights.length; l++) expect(weights[l]! / weights[l - 1]!).toBeCloseTo(BLOOM_FALLOFF, 12);
    // No plateau: the widest level holds under 2 % of the spread energy (it held 9 % with a constant mix of 0.62).
    expect(weights[weights.length - 1]!).toBeLessThan(0.02);
    expect(weights[0]!).toBeGreaterThan(0.5);
    // The blend factors of the up passes reproduce the weights.
    const back = weightsOf(blend);
    for (let l = 0; l < weights.length; l++) expect(back[l]!).toBeCloseTo(weights[l]!, 12);
    for (const k of blend) {
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(0.5);
    }
  });

  it('is sized relative to the frame: twice the height adds a level and shifts the weights by one', () => {
    expect(bloomLevelCount(720)).toBe(6);
    expect(bloomLevelCount(1080)).toBe(7);
    expect(bloomLevelCount(1440)).toBe(7);
    expect(bloomLevelCount(2160)).toBe(8);
    expect(bloomLevelCount(360)).toBe(5);
    const ref = bloomWeights(720).weights;
    const double = bloomWeights(1440).weights;
    // Level l + 1 of the higher frame is as wide, relative to the frame, as level l of the reference.
    for (let l = 0; l < ref.length; l++) expect(double[l + 1]!).toBeCloseTo(ref[l]!, 12);
    expect(double[0]!).toBeCloseTo(0, 12);
    const four = bloomWeights(2880).weights;
    for (let l = 0; l < ref.length; l++) expect(four[l + 2]!).toBeCloseTo(ref[l]!, 12);
  });

  it('gives a convex chain at every height', () => {
    for (const h of [240, 360, 540, 720, 900, 1080, 1200, 1440, 1600, 2160, 4320]) {
      const { weights, blend } = bloomWeights(h);
      expect(weights).toHaveLength(bloomLevelCount(h));
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (const w of weights) expect(w).toBeGreaterThanOrEqual(0);
      for (const k of blend) {
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(1);
      }
      // Wider is fainter, by the falloff, beyond the finest level in use (which takes what is left).
      const finest = weights.findIndex((w) => w > 1e-12);
      for (let l = finest + 2; l < weights.length; l++) expect(weights[l]! / weights[l - 1]!).toBeCloseTo(BLOOM_FALLOFF, 9);
    }
  });
});
