/**
 * Lens flare terms and their normalisation. The angular profiles here are the ones evaluated by FLARE_WGSL;
 * each is integrated numerically over the sphere (the part the shader draws) so that a term of energy
 * fraction k delivers exactly k x the illuminance at the lens. The sum of all terms is FLARE_TOTAL_ENERGY,
 * under the 1 % of the brief.
 */
import type { Vec3Tuple } from '@/core/math';

/** Share of the starburst term that goes into the glare halo (the rest into the six spikes). */
export const FLARE_HALO_SHARE = 0.55;
/** Halo profile (1 + (theta / c)^2)^-HALO_POWER: veiling glare of the lens, falls as theta^-3. */
export const HALO_POWER = 1.5;
/** Angular extent of the starburst quad (rad). */
export const STARBURST_MAX_ANGLE = 0.35;

export interface StarburstDef {
  energy: number;
  /** Halo core angle (rad). */
  haloCore: number;
  /** Spike half width across (rad) and length scale (rad; 1/theta^2 beyond it). */
  spikeWidth: number;
  spikeLength: number;
  tint: Vec3Tuple;
}
export interface GhostDef {
  /** Position on the line from the image centre (0) to the sun (1), in NDC multiples of the sun's position. */
  k: number;
  /** Angular radius (rad). */
  radius: number;
  /** Width of the soft edge in units of the radius, and radial chromatic shift per channel (fraction). */
  softness: number;
  chroma: number;
  energy: number;
  tint: Vec3Tuple;
}

const normaliseTint = (c: Vec3Tuple): Vec3Tuple => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
};

export const STARBURST: StarburstDef = { energy: 0.006, haloCore: 0.02, spikeWidth: 0.0012, spikeLength: 0.03, tint: [1, 1, 1] };
export const GHOSTS: GhostDef[] = [
  { k: -0.35, radius: 0.035, softness: 0.12, chroma: 0.04, energy: 0.0008, tint: normaliseTint([1.0, 0.78, 0.48]) },
  { k: -0.7, radius: 0.02, softness: 0.2, chroma: 0.06, energy: 0.0005, tint: normaliseTint([0.5, 0.88, 1.0]) },
  { k: 0.45, radius: 0.05, softness: 0.1, chroma: 0.05, energy: 0.0006, tint: normaliseTint([0.82, 0.6, 1.0]) },
  { k: -1.25, radius: 0.09, softness: 0.08, chroma: 0.08, energy: 0.0004, tint: normaliseTint([0.62, 1.0, 0.72]) },
];
export const FLARE_TOTAL_ENERGY = STARBURST.energy + GHOSTS.reduce((s, g) => s + g.energy, 0);

/** Relative wavelength per channel (R, G, B) of the spikes' chromatic length. */
export const SPIKE_LAMBDA: Vec3Tuple = [1.12, 1.0, 0.84];

export const haloProfile = (theta: number, core: number): number => (1 + (theta / core) ** 2) ** -HALO_POWER;
/** Spike profile at angle theta from the sun, dphi from the nearest spike, channel wavelength scale lambda. */
export function spikeProfile(theta: number, dphi: number, width: number, length: number, lambda: number): number {
  const across = theta * Math.sin(dphi);
  return (Math.exp((-0.5 * across * across) / (width * width)) / (1 + (theta * theta) / (length * length * lambda * lambda))) / lambda;
}
/** Ghost profile at r = angle / radius for one channel's shift s (+-chroma, 0 for green). */
export function ghostProfile(r: number, softness: number, s: number): number {
  const disc = Math.min(1, Math.max(0, (1 - r * (1 + s)) / softness));
  const t = Math.min(1, Math.max(0, (r - 0.6) / 0.4));
  return disc * (0.55 + 0.45 * t * t * (3 - 2 * t));
}

/** Integral over the sphere of the halo between the solar disc and STARBURST_MAX_ANGLE (sr). */
export function haloIntegral(core: number, sunRadius: number): number {
  let s = 0;
  const n = 4000;
  const a = sunRadius;
  const b = STARBURST_MAX_ANGLE;
  for (let i = 0; i < n; i++) {
    const th = a + ((i + 0.5) * (b - a)) / n;
    s += haloProfile(th, core) * 2 * Math.PI * Math.sin(th);
  }
  return (s * (b - a)) / n;
}

/** Integral of the spike profile of one channel over the sphere (sr), same domain. */
export function spikeIntegral(width: number, length: number, lambda: number, sunRadius: number): number {
  let s = 0;
  const nt = 1500;
  const np = 720;
  const a = sunRadius;
  const b = STARBURST_MAX_ANGLE;
  const seg = Math.PI / 3;
  for (let i = 0; i < nt; i++) {
    // Logarithmic steps in theta: the spike is concentrated at small angles.
    const u0 = Math.log(a) + ((i + 0.5) * (Math.log(b) - Math.log(a))) / nt;
    const th = Math.exp(u0);
    const dth = (th * (Math.log(b) - Math.log(a))) / nt;
    let ring = 0;
    for (let j = 0; j < np; j++) {
      const phi = ((j + 0.5) * 2 * Math.PI) / np;
      const dphi = Math.abs(phi - seg * Math.round(phi / seg));
      ring += spikeProfile(th, dphi, width, length, lambda);
    }
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * dth;
  }
  return s;
}

/** Integral of a ghost's (green channel) profile over the sphere (sr). */
export function ghostIntegral(g: GhostDef): number {
  let s = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n;
    const th = r * g.radius;
    s += ghostProfile(r, g.softness, 0) * 2 * Math.PI * Math.sin(th) * (g.radius / n);
  }
  return s;
}
