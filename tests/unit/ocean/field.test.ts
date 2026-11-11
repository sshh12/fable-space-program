/**
 * The CPU models behind the water's look: the roughness field (mean 1, filtered by the footprint), the far-wave
 * bank (the long waves' slope variance, around the spectral peak), the foam lace (uniform, so density = coverage
 * at every level of its mip chain).
 */
import { describe, expect, it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { TWO_PI } from '@/core/math';
import { buildCascades } from '@/render/ocean/cascades';
import { buildFarWaves, FAR_WAVE_COUNT, farWaveVariance, peakWavelength } from '@/render/ocean/farWaves';
import { fieldMean, fieldNoise2, fieldRaw, lineCover } from '@/render/ocean/fieldModel';
import { buildFoamLace, laceCoverage } from '@/render/ocean/foamLace';
import { oceanTunables } from '@/render/ocean/params';
import { swellSlopeVariance } from '@/render/ocean/swell';

const defs = await loadDefs(fsDefSource());
const earth = Object.values(defs.bodies).find((b) => b.ocean !== null)!;
const t = oceanTunables(earth)!;

describe('roughness field', () => {
  it('noise: zero mean, standard deviation about 0.41, bounded', () => {
    let s1 = 0;
    let s2 = 0;
    let max = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const v = fieldNoise2(i * 0.37 + 0.123, i * 0.113 + 9.7, 5);
      s1 += v;
      s2 += v * v;
      max = Math.max(max, Math.abs(v));
    }
    expect(Math.abs(s1 / n)).toBeLessThan(0.02);
    expect(Math.sqrt(s2 / n)).toBeGreaterThan(0.36);
    expect(Math.sqrt(s2 / n)).toBeLessThan(0.46);
    expect(max).toBeLessThan(1.5);
  });

  it('normalised by fieldMean the field has mean 1 elsewhere on the planet too, and stays positive', () => {
    const mean = fieldMean(t);
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(1.25);
    let s = 0;
    let min = Infinity;
    let max = 0;
    let n = 0;
    for (let j = 0; j < 150; j++) {
      for (let i = 0; i < 150; i++) {
        const m = fieldRaw(-7.3e6 + i * 7919.3, 3.1e6 + j * 8111.7, t, 0) / mean;
        s += m;
        min = Math.min(min, m);
        max = Math.max(max, m);
        n++;
      }
    }
    expect(s / n).toBeGreaterThan(0.93);
    expect(s / n).toBeLessThan(1.07);
    expect(min).toBeGreaterThan(0.05);
    // A decade between slicks and gusty water.
    expect(max / min).toBeGreaterThan(6);
  });

  it('a footprint that covers a feature averages it: lines contribute their covered fraction, octaves fade', () => {
    // A line of half-width 1 seen with a footprint of 10 centred on it covers a fifth of it.
    expect(lineCover(0, 1, 10)).toBeCloseTo(0.2, 6);
    expect(lineCover(0, 1, 0.1)).toBe(1);
    expect(lineCover(3, 1, 0.1)).toBe(0);
    // Seen with a 3 km footprint the field keeps its mean and loses most of its spread.
    const mean = fieldMean(t);
    const stats = (fp: number): { mean: number; sd: number } => {
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (let j = 0; j < 120; j++) {
        for (let i = 0; i < 120; i++) {
          const m = fieldRaw(2.2e6 + i * 4003.1, 1.4e6 + j * 3989.9, t, fp) / mean;
          s1 += m;
          s2 += m * m;
          n++;
        }
      }
      return { mean: s1 / n, sd: Math.sqrt(s2 / n - (s1 / n) ** 2) };
    };
    const sharp = stats(0);
    const coarse = stats(3000);
    expect(Math.abs(coarse.mean - sharp.mean)).toBeLessThan(0.06);
    expect(coarse.sd).toBeLessThan(0.75 * sharp.sd);
  });
});

describe('far-wave bank', () => {
  it('carries the long waves the near field resolves (swell + long-wave layer), around the spectral peak', () => {
    const set = buildCascades(t);
    const variance = swellSlopeVariance(t.swell) + set.long.slopeVariance;
    const waves = buildFarWaves(t, variance);
    expect(waves.length).toBe(FAR_WAVE_COUNT);
    expect(farWaveVariance(waves)).toBeCloseTo(variance, 9);
    const lambdaP = peakWavelength(t);
    // 7 m/s over a 200 km fetch: a peak of some tens of metres.
    expect(lambdaP).toBeGreaterThan(40);
    expect(lambdaP).toBeLessThan(120);
    const lengths = waves.map((w) => TWO_PI / Math.hypot(w.kAlong, w.kAcross));
    expect(Math.min(...lengths)).toBeGreaterThan(0.3 * lambdaP);
    expect(Math.max(...lengths)).toBeLessThan(4 * lambdaP);
    // No two components in step: distinct wavelengths (at least 15 % apart) and directions within 45 deg of the wind.
    const sorted = [...lengths].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! / sorted[i - 1]!).toBeGreaterThan(1.15);
    for (const w of waves) {
      expect(Math.abs(Math.atan2(w.kAcross, w.kAlong))).toBeLessThan(Math.PI / 4);
      // Deep-water dispersion.
      expect(w.omega).toBeCloseTo(Math.sqrt(t.gravity * Math.hypot(w.kAlong, w.kAcross)), 9);
    }
  });
});

describe('foam lace', () => {
  const lace = buildFoamLace(7, 128);

  it('is uniform: E[T] = 1/2 and E[T^2] = 1/3 at every level', () => {
    for (const lv of lace.levels) {
      let m1 = 0;
      let m2 = 0;
      const n = lv.length / 2;
      for (let k = 0; k < n; k++) {
        m1 += lv[k * 2]!;
        m2 += lv[k * 2 + 1]!;
      }
      expect(m1 / n).toBeCloseTo(0.5, 4);
      expect(m2 / n).toBeCloseTo(1 / 3, 4);
    }
  });

  it('covers the density it is given, sharp and filtered alike', () => {
    for (const rho of [0.05, 0.2, 0.5, 0.9]) {
      lace.levels.forEach((lv, level) => {
        let c = 0;
        const n = lv.length / 2;
        for (let k = 0; k < n; k++) c += laceCoverage(lv[k * 2]!, lv[k * 2 + 1]!, rho);
        // Exact at the base level and where everything is averaged; within a few percent of the area in between
        // (T inside a footprint is not exactly uniform).
        const tolerance = level === 0 || level === lace.levels.length - 1 ? 0.005 : 0.06;
        expect(Math.abs(c / n - rho)).toBeLessThan(tolerance);
      });
    }
  });

  it('thin foam is a net of walls: its covered texels touch each other', () => {
    const size = lace.size;
    const on = (i: number, j: number): boolean => lace.levels[0]![((((j % size) + size) % size) * size + (((i % size) + size) % size)) * 2]! > 0.85;
    let covered = 0;
    let withNeighbour = 0;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        if (!on(i, j)) continue;
        covered++;
        if (on(i + 1, j) || on(i - 1, j) || on(i, j + 1) || on(i, j - 1)) withNeighbour++;
      }
    }
    expect(covered / (size * size)).toBeCloseTo(0.15, 2);
    expect(withNeighbour / covered).toBeGreaterThan(0.9);
  });
});
