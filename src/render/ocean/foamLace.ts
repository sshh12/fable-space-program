/**
 * The foam lace: what turns a foam DENSITY (how much of the surface is covered around a point: the wave model's
 * low-resolution foam fields, the wake, the surf) into the picture of foam, sharp at the pixel from any distance.
 *
 * A tileable scalar field T in [0, 1) with a UNIFORM distribution, built from HOLES at three scales (round, of
 * uneven size, torn by a displacement): T is highest where the foam is farthest from every large hole, lowered
 * around the middle-sized holes that pierce it and the small ones that pit it, and it varies slowly over the tile
 * so that thin foam gathers into rafts. Foam of density rho is where T > 1 - rho: thin foam is the curved strands
 * and knots left between the large holes (lace, with water showing through), denser foam closes the holes from
 * their rims, full density is solid. Because T is uniform, the area covered equals rho exactly.
 *
 * The texture holds E[T] and E[T^2] per texel with a box-filtered mip chain, so a pixel that covers many texels
 * gets the mean and the spread of T inside its footprint and from them the covered FRACTION (surfaceWgsl.ts),
 * which again averages to rho: the coverage is the same seen from 3 m and from 3 km.
 */
import { hash4, hashToUnit } from '@/core/math';

export const LACE_SIZE = 512;
/** Holes per tile side at the three scales (the tile is 16.9 m, surfaceWgsl.ts LACE_TILES: 2.1 m, 0.70 m, 0.28 m apart). */
export const LACE_CELLS = [8, 24, 60] as const;

export interface FoamLace {
  size: number;
  /** Per mip level: E[T], E[T^2] interleaved (size >> level squared texels). */
  levels: Float32Array[];
}

/** Periodic value noise in [0, 1) with `period` lattice cells per tile, at tile coordinate (u, v) in [0, 1). */
function periodicNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number): number => hashToUnit(hash4(((i % period) + period) % period, ((j % period) + period) % period, period, seed));
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx;
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

/**
 * Distance to the nearest HOLE of a periodic pattern with `cells` cells per tile at tile coordinate (u, v), in units
 * of that hole's radius (holes differ in size, so the foam between them has curved, uneven edges): 0 at a hole's
 * centre, about 1 where three holes meet.
 */
function holeDistance(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + 0.1 + 0.8 * hashToUnit(hash4(wx, wy, cells, seed));
      const py = cy + 0.1 + 0.8 * hashToUnit(hash4(wx, wy, cells + 7919, seed));
      const radius = 0.5 + 0.75 * hashToUnit(hash4(wx, wy, cells + 104729, seed));
      best = Math.min(best, Math.hypot(x - px, y - py) / radius);
    }
  }
  return best;
}

const saturate = (x: number): number => Math.min(1, Math.max(0, x));

/** The lace field before equalisation at tile coordinate (u, v). */
function laceRaw(u: number, v: number, seed: number): number {
  // Torn, not a honeycomb: the lookup is displaced by two octaves of periodic noise.
  const wu = (periodicNoise(u, v, 5, seed + 1) - 0.5) * 0.11 + (periodicNoise(u, v, 17, seed + 2) - 0.5) * 0.028;
  const wv = (periodicNoise(u, v, 5, seed + 3) - 0.5) * 0.11 + (periodicNoise(u, v, 17, seed + 4) - 0.5) * 0.028;
  // Foam is what is left between holes: far from the large holes, pierced by the middle ones, pitted by the small.
  const large = holeDistance(u + wu, v + wv, LACE_CELLS[0], seed);
  const middle = holeDistance(u + wu, v + wv, LACE_CELLS[1], seed + 10);
  const small = holeDistance(u + wu, v + wv, LACE_CELLS[2], seed + 20);
  // Thin foam gathers into rafts instead of an even net: a slow variation over the tile.
  const raft = 0.6 * periodicNoise(u, v, 3, seed + 50) + 0.4 * periodicNoise(u, v, 9, seed + 51);
  const t = large * (0.3 + 0.7 * saturate((middle - 0.3) / 0.5)) * (0.6 + 0.4 * saturate((small - 0.25) / 0.5)) * (0.7 + 0.6 * raft);
  // A little grain, so that equal ranks are broken irregularly and solid foam closes without a pattern.
  return t + 0.03 * periodicNoise(u, v, 128, seed + 40);
}

/** Build the lace texture data (deterministic). */
export function buildFoamLace(seed: number, size = LACE_SIZE): FoamLace {
  const n = size * size;
  const raw = new Float32Array(n);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) raw[j * size + i] = laceRaw((i + 0.5) / size, (j + 0.5) / size, seed);
  }
  // Equalise to a uniform distribution: rank / n.
  const order = new Uint32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  order.sort((a, b) => raw[a]! - raw[b]!);
  const base = new Float32Array(n * 2);
  for (let r = 0; r < n; r++) {
    const t = (r + 0.5) / n;
    const k = order[r]!;
    base[k * 2] = t;
    base[k * 2 + 1] = t * t;
  }
  const levels = [base];
  for (let s = size >> 1; s >= 1; s >>= 1) {
    const src = levels[levels.length - 1]!;
    const dst = new Float32Array(s * s * 2);
    const w = s * 2;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        for (let c = 0; c < 2; c++) {
          dst[(j * s + i) * 2 + c] = 0.25 * (src[(2 * j * w + 2 * i) * 2 + c]! + src[(2 * j * w + 2 * i + 1) * 2 + c]! + src[((2 * j + 1) * w + 2 * i) * 2 + c]! + src[((2 * j + 1) * w + 2 * i + 1) * 2 + c]!);
        }
      }
    }
    levels.push(dst);
  }
  return { size, levels };
}

/**
 * Fraction of a footprint covered by foam of density `rho`, from the mean and the second moment of T over it
 * (the WGSL of the surface pass does the same): T inside the footprint is taken as uniform about its mean with its
 * measured spread; `edge` is the half-width of the transition at a sharp sample (antialiasing).
 */
export function laceCoverage(mean: number, second: number, rho: number, edge = 0): number {
  const sd = Math.sqrt(Math.max(second - mean * mean, 0));
  const h = Math.max(1.7320508 * sd, edge, 1e-6);
  // T lies in [0, 1]: the interval it is taken to fill is cut there.
  const lo = Math.max(mean - h, 0);
  const hi = Math.min(mean + h, 1);
  return Math.min(1, Math.max(0, (hi - (1 - rho)) / Math.max(hi - lo, 1e-6)));
}
