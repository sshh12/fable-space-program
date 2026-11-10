/**
 * Integer-hash 3-D gradient noise on planet-fixed coordinates (seamless across cube faces). Lattice values
 * come from the shared hash (src/core/math/hash.ts): the corner hash is exactly
 * hash4(iz, iy, ix, seed), so a WGSL port with HASH_WGSL reproduces the lattice bit for bit.
 *
 * Each instance memoises the gradients of the last lattice cell it touched. That is a pure cache (a cell's
 * gradients are a function of the cell), so results are identical whether or not it hits; it makes scanline
 * evaluation along a tile cheap because consecutive samples share cells.
 */
import { hashU32 } from '../core/math/hash';

/** 16 gradient directions (the 12 cube edges plus 4 repeats), as in improved Perlin noise. */
const GRAD = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 1, 1, 0, 0, -1,
  1, -1, 1, 0, 0, -1, -1,
]);

/**
 * Statistics of the noise for unit lattice spacing, measured over 2^22 random samples by
 * tools/terrain-core/measure-noise.ts (re-checked by tests/unit/terrain-core/noise.test.ts): RMS value, and
 * RMS of the directional derivative along a random axis per lattice unit. Amplitudes are specified as RMS
 * slope, so octave height amplitude = rmsSlope * wavelength / NOISE_GRAD_RMS.
 */
export const NOISE_RMS = 0.27;
export const NOISE_GRAD_RMS = 0.7045;
/** Bound on |noise| (measured maximum 0.999 over 2^22 samples) used for conservative tile height ranges. */
export const NOISE_MAX = 1.05;
/** Mean |noise| (measured): the ridged variant 1 - 2|n| has mean 1 - 2 * NOISE_MEAN_ABS and RMS gradient 2 * NOISE_GRAD_RMS. */
export const NOISE_MEAN_ABS = 0.2202;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const NO_CELL = 0x7fffffff;

export class GradientNoise3 {
  private readonly hs: number;
  private cx = NO_CELL;
  private cy = NO_CELL;
  private cz = NO_CELL;
  private readonly g = new Float64Array(24);

  constructor(readonly seed: number) {
    this.hs = hashU32(seed);
  }

  /** Noise at lattice coordinates (x, y, z); |x|, |y|, |z| < 2^31. */
  value(x: number, y: number, z: number): number {
    const fx0 = Math.floor(x);
    const fy0 = Math.floor(y);
    const fz0 = Math.floor(z);
    const ix = fx0 | 0;
    const iy = fy0 | 0;
    const iz = fz0 | 0;
    const g = this.g;
    if (ix !== this.cx || iy !== this.cy || iz !== this.cz) {
      this.cx = ix;
      this.cy = iy;
      this.cz = iz;
      let k = 0;
      for (let dx = 0; dx < 2; dx++) {
        const hx = hashU32((ix + dx) ^ this.hs);
        for (let dy = 0; dy < 2; dy++) {
          const hy = hashU32((iy + dy) ^ hx);
          for (let dz = 0; dz < 2; dz++) {
            const h = (hashU32((iz + dz) ^ hy) & 15) * 3;
            g[k] = GRAD[h]!;
            g[k + 1] = GRAD[h + 1]!;
            g[k + 2] = GRAD[h + 2]!;
            k += 3;
          }
        }
      }
    }
    const tx = x - fx0;
    const ty = y - fy0;
    const tz = z - fz0;
    const ux = tx - 1;
    const uy = ty - 1;
    const uz = tz - 1;
    const n000 = g[0]! * tx + g[1]! * ty + g[2]! * tz;
    const n001 = g[3]! * tx + g[4]! * ty + g[5]! * uz;
    const n010 = g[6]! * tx + g[7]! * uy + g[8]! * tz;
    const n011 = g[9]! * tx + g[10]! * uy + g[11]! * uz;
    const n100 = g[12]! * ux + g[13]! * ty + g[14]! * tz;
    const n101 = g[15]! * ux + g[16]! * ty + g[17]! * uz;
    const n110 = g[18]! * ux + g[19]! * uy + g[20]! * tz;
    const n111 = g[21]! * ux + g[22]! * uy + g[23]! * uz;
    const fz = fade(tz);
    const a = n000 + fz * (n001 - n000);
    const b = n010 + fz * (n011 - n010);
    const c = n100 + fz * (n101 - n100);
    const d = n110 + fz * (n111 - n110);
    const fy = fade(ty);
    const e = a + fy * (b - a);
    const f = c + fy * (d - c);
    return e + fade(tx) * (f - e);
  }
}

/** Seed of octave/feature `index` of a field with base seed `seed` (decorrelates octaves). */
export function subSeed(seed: number, index: number): number {
  return hashU32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}
