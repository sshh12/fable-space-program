/**
 * The hexagon pattern that hides the repetition of the detail layers (shaders/surface.ts, detailPlane):
 * its twin must give the same picture wherever a tile's origin lies.
 */
import { describe, expect, it } from 'vitest';
import { hash4, hashToUnit } from '@/core/math';
import { HEX_PERIOD } from '@/render/terrain/shaders/surface';
import { hexHash, hexTaps } from './hexTwin';

/** Distance between two texture coordinates on the unit torus. */
const wrapDist = (a: number, b: number): number => {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
};

describe('hexagon pattern of the detail layers', () => {
  it('the weights of the three copies are barycentric: they sum to 1 and are continuous across lattice edges', () => {
    for (let n = 0; n < 2000; n++) {
      const sx = hashToUnit(hash4(n, 1, 0, 7)) * 40 - 20;
      const sy = hashToUnit(hash4(n, 2, 0, 7)) * 40 - 20;
      const taps = hexTaps(sx, sy);
      expect(taps.reduce((a, t) => a + t.weight, 0)).toBeCloseTo(1, 9);
      // A step of a ten-thousandth of a tiling length changes no copy's share by more than a percent.
      const near = hexTaps(sx + 1e-4, sy + 0.7e-4);
      for (const t of taps) {
        const other = near.find((x) => x.vx === t.vx && x.vy === t.vy);
        expect(Math.abs(t.weight - (other ? other.weight : 0))).toBeLessThan(0.01);
      }
    }
  });

  it('a lattice vertex has the same random numbers one period away along either plane axis', () => {
    for (let n = 0; n < 500; n++) {
      const vx = Math.floor(hashToUnit(hash4(n, 3, 0, 7)) * 600) - 300;
      const vy = Math.floor(hashToUnit(hash4(n, 4, 0, 7)) * 600) - 300;
      const h = hexHash(vx, vy);
      // One period along the plane's x: 2 HEX_PERIOD in the skewed x. Along its y: (-HEX_PERIOD, 2 HEX_PERIOD).
      expect(hexHash(vx + 2 * HEX_PERIOD, vy)).toEqual(h);
      expect(hexHash(vx - HEX_PERIOD, vy + 2 * HEX_PERIOD)).toEqual(h);
    }
  });

  it('two tiles whose origins differ by whole periods draw the same texels at a common point', () => {
    let worst = 0;
    let worstAboutOrigin = 0;
    for (let n = 0; n < 2000; n++) {
      const sx = hashToUnit(hash4(n, 5, 0, 7)) * HEX_PERIOD;
      const sy = hashToUnit(hash4(n, 6, 0, 7)) * HEX_PERIOD;
      const kx = Math.floor(hashToUnit(hash4(n, 7, 0, 7)) * 5) - 2;
      const ky = Math.floor(hashToUnit(hash4(n, 8, 0, 7)) * 5) - 2;
      if (kx === 0 && ky === 0) continue;
      for (const aboutVertex of [true, false]) {
        const a = hexTaps(sx, sy, aboutVertex);
        const b = hexTaps(sx + kx * HEX_PERIOD, sy + ky * HEX_PERIOD, aboutVertex);
        for (let i = 0; i < 3; i++) {
          expect(b[i]!.turns).toBe(a[i]!.turns);
          expect(b[i]!.weight).toBeCloseTo(a[i]!.weight, 6);
          const d = Math.max(wrapDist(a[i]!.u, b[i]!.u), wrapDist(a[i]!.v, b[i]!.v));
          if (aboutVertex) worst = Math.max(worst, d);
          else worstAboutOrigin = Math.max(worstAboutOrigin, d);
        }
      }
    }
    // A thousandth of a texel of the 1024-texel near layer.
    expect(worst).toBeLessThan(1e-6);
    // The control: rotating about the plane's origin moves the texels by up to half the texture.
    expect(worstAboutOrigin).toBeGreaterThan(0.3);
  });
});
