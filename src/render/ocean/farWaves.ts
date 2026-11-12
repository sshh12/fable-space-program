/**
 * The far-wave bank: the long waves of a body's sea (the physics swell plus the wind sea above the cascades'
 * high-pass wavelength) as a handful of directional plane waves in the wind chart (fieldModel.ts), for the water the
 * FFT does not reach. `brdf_water` tilts the shading normal of the far sheet with them wherever a pixel can resolve
 * a component (shaders/waterBrdf.ts), so the sea beyond the near field keeps wave lines and the glint its grain; the
 * near field cross-fades from its own resolved waves to the same bank over the detail fade, so both sides of
 * fadeStart shade one function.
 *
 * It is a picture of the sea state, not the physics surface: wavelengths around the JONSWAP peak with a swell
 * system crossing the wind sea, slope shares following the slope spectrum, directions spread about the wind. Its
 * total slope variance is what the near field resolves in long waves (swell + long-wave layer), so the lobe keeps
 * the remainder of Cox-Munk on both sides.
 */
import { TWO_PI } from '@/core/math';
import type { OceanTunables } from './params';
import { jonswapPeak } from './spectrum';

export const FAR_WAVE_COUNT = 14;

export interface FarWave {
  /** Wave vector in the wind chart (rad per chart metre): along the wind, across it (to the right). */
  kAlong: number;
  kAcross: number;
  /** Slope amplitude a k (dimensionless) and angular frequency (rad/s). */
  slope: number;
  omega: number;
  /** Phase at t = 0 at the chart origin, rad. */
  phase: number;
}

/** Longest and shortest component, in peak wavelengths: the others are spaced evenly in the logarithm between them. */
const LONGEST = 3.2;
const SHORTEST = 0.44;
/**
 * Share of the slope variance and direction off the wind (deg) of each component, longest first. The shares follow
 * the slope spectrum (most around the peak); the spread widens with frequency, as a wind sea's does (narrow about
 * the peak, cos^2s with falling s above it), and the angles are uneven, so the sum is the irregular, short-crested
 * pattern of a wind sea, with groups of its own, and never the plaid of two or three trains.
 */
const SHAPE: readonly [number, number][] = [
  [0.02, -6],
  [0.03, 9],
  [0.04, -13],
  [0.055, 4],
  [0.07, 17],
  [0.085, -21],
  [0.1, 11],
  [0.115, -8],
  [0.115, 24],
  [0.1, -29],
  [0.09, 33],
  [0.075, -17],
  [0.06, 40],
  [0.045, -37],
];

/** Peak wavelength of the body's wind sea (JONSWAP, deep water), m. */
export function peakWavelength(t: OceanTunables): number {
  const { omegaP } = jonswapPeak(t.windSpeed, t.fetch, t.gravity);
  return (TWO_PI * t.gravity) / (omegaP * omegaP);
}

/** The bank for a body whose long waves carry `slopeVariance` (both axes summed) when fully resolved. */
export function buildFarWaves(t: OceanTunables, slopeVariance: number): FarWave[] {
  const lambdaP = peakWavelength(t);
  return SHAPE.map(([share, deg], i) => {
    const rel = LONGEST * (SHORTEST / LONGEST) ** (i / (SHAPE.length - 1));
    const k = TWO_PI / (rel * lambdaP);
    const a = (deg * Math.PI) / 180;
    return {
      kAlong: k * Math.cos(a),
      kAcross: k * Math.sin(a),
      slope: Math.sqrt(2 * share * slopeVariance),
      omega: Math.sqrt(t.gravity * k),
      // Golden-ratio phases: no two components start in step.
      phase: TWO_PI * ((i * 0.6180339887) % 1),
    };
  });
}

/** Slope variance the bank carries when every component is resolved (equals what it was built with). */
export const farWaveVariance = (waves: readonly FarWave[]): number => waves.reduce((s, w) => s + 0.5 * w.slope * w.slope, 0);
