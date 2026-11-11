/**
 * Float64 reference implementation of the atmosphere model (Hillaire 2020 with the body's
 * AtmosphereRenderDef): medium, transmittance, the closed-form multi-scattering term and the sky radiance
 * along a ray. Brute-force quadrature, no tables. The GPU tables and the per-pixel march are checked
 * against it in the unit tests and in the browser specs; nothing in the frame uses it.
 */
import type { AtmosphereRenderDef } from '@/core/contracts/defs';
import type { Vec3Tuple } from '@/core/math';
import { altitudeExact, expm1OverX, phaseCornetteShanks, phaseRayleigh, raySphere } from './math';

export interface ReferenceAtmosphere {
  /** Bottom (reference) radius and top radius of the shell, m. */
  rb: number;
  rt: number;
  def: AtmosphereRenderDef;
}

export function referenceAtmosphere(radius: number, def: AtmosphereRenderDef): ReferenceAtmosphere {
  return { rb: radius, rt: radius + def.topAltitude, def };
}

export interface Medium {
  /** Rayleigh scattering (rgb), Mie scattering (grey) and total extinction (rgb), per metre. */
  scatR: Vec3Tuple;
  scatM: number;
  ext: Vec3Tuple;
}

/** Scattering and extinction coefficients at altitude h (m above the bottom radius). */
export function mediumAt(a: ReferenceAtmosphere, h: number): Medium {
  const d = a.def;
  const hc = Math.max(h, -1000);
  const dR = Math.exp(-hc / d.rayleighScaleHeight);
  const dM = Math.exp(-hc / d.mieScaleHeight);
  const dO = Math.max(0, 1 - Math.abs(hc - d.ozoneCenterAltitude) / d.ozoneHalfWidth);
  const scatR: Vec3Tuple = [d.rayleighScattering[0] * dR, d.rayleighScattering[1] * dR, d.rayleighScattering[2] * dR];
  const scatM = d.mieScattering * dM;
  const mieExt = (d.mieScattering + d.mieAbsorption) * dM;
  return {
    scatR,
    scatM,
    ext: [scatR[0] + mieExt + d.ozoneAbsorption[0] * dO, scatR[1] + mieExt + d.ozoneAbsorption[1] * dO, scatR[2] + mieExt + d.ozoneAbsorption[2] * dO],
  };
}

/** True when a ray from altitude h with direction cosine mu to the vertical reaches the bottom sphere. */
export function hitsGround(a: ReferenceAtmosphere, h: number, mu: number): boolean {
  if (mu >= 0) return false;
  const r = a.rb + h;
  return r * r * (1 - mu * mu) < a.rb * a.rb;
}

/** Distance along the ray to the top of the shell (from inside it), m. */
export function distanceToTop(a: ReferenceAtmosphere, h: number, mu: number): number {
  const hit = raySphere(a.rb + h, h - a.def.topAltitude, mu, a.rt);
  return hit ? Math.max(hit[1], 0) : 0;
}

/** Distance along the ray to the bottom sphere, or Infinity when it is missed. */
export function distanceToGround(a: ReferenceAtmosphere, h: number, mu: number): number {
  if (!hitsGround(a, h, mu)) return Infinity;
  const hit = raySphere(a.rb + h, h, mu, a.rb);
  return hit ? Math.max(hit[0], 0) : Infinity;
}

/** Optical depth (rgb) over [0, length] along a ray from altitude h, Simpson quadrature with `steps` intervals. */
export function opticalDepth(a: ReferenceAtmosphere, h: number, mu: number, length: number, steps = 400): Vec3Tuple {
  const n = steps + (steps & 1);
  const dt = length / n;
  const r0 = a.rb + h;
  const sum: Vec3Tuple = [0, 0, 0];
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i & 1 ? 4 : 2;
    const e = mediumAt(a, altitudeExact(i * dt, r0, h, mu)).ext;
    sum[0] += w * e[0];
    sum[1] += w * e[1];
    sum[2] += w * e[2];
  }
  return [(sum[0] * dt) / 3, (sum[1] * dt) / 3, (sum[2] * dt) / 3];
}

/**
 * Transmittance (rgb) from altitude h along direction cosine mu to the top of the shell; 0 when the ray
 * meets the ground (the planet's shadow).
 */
export function transmittanceToTop(a: ReferenceAtmosphere, h: number, mu: number, steps = 400): Vec3Tuple {
  if (hitsGround(a, h, mu)) return [0, 0, 0];
  const tau = opticalDepth(a, h, mu, distanceToTop(a, h, mu), steps);
  return [Math.exp(-tau[0]), Math.exp(-tau[1]), Math.exp(-tau[2])];
}

/** Radius and sun-zenith cosine at distance t along a ray (r, mu, muS, nu = cos(view, sun)). */
function advance(r: number, mu: number, muS: number, nu: number, t: number): { r: number; muS: number } {
  const rt = Math.sqrt(Math.max(r * r + 2 * r * mu * t + t * t, 1e-6));
  return { r: rt, muS: Math.min(Math.max((r * muS + t * nu) / rt, -1), 1) };
}

/**
 * Multi-scattering transfer Psi (rgb): luminance scattered towards any direction per unit of scattering
 * coefficient and unit of sun illuminance, from orders two to infinity (Hillaire's closed form
 * L_2nd / (1 - f_ms)), at altitude h and sun-zenith cosine muS.
 */
export function multiScatter(a: ReferenceAtmosphere, h: number, muS: number, sqrtDirs = 8, steps = 20): Vec3Tuple {
  const r0 = a.rb + h;
  const l2: Vec3Tuple = [0, 0, 0];
  const fms: Vec3Tuple = [0, 0, 0];
  const iso = 1 / (4 * Math.PI);
  const n = sqrtDirs * sqrtDirs;
  for (let i = 0; i < sqrtDirs; i++) {
    for (let j = 0; j < sqrtDirs; j++) {
      const mu = 1 - (2 * (i + 0.5)) / sqrtDirs;
      const phi = (2 * Math.PI * (j + 0.5)) / sqrtDirs;
      const sinV = Math.sqrt(Math.max(1 - mu * mu, 0));
      const sinS = Math.sqrt(Math.max(1 - muS * muS, 0));
      const nu = mu * muS + sinV * sinS * Math.cos(phi);
      const ground = hitsGround(a, h, mu);
      const length = ground ? distanceToGround(a, h, mu) : distanceToTop(a, h, mu);
      const dt = length / steps;
      const T: Vec3Tuple = [1, 1, 1];
      const L: Vec3Tuple = [0, 0, 0];
      const F: Vec3Tuple = [0, 0, 0];
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) * dt;
        const p = advance(r0, mu, muS, nu, t);
        const hs = altitudeExact(t, r0, h, mu);
        const m = mediumAt(a, hs);
        const ts = transmittanceToTop(a, hs, p.muS, 40);
        for (let c = 0; c < 3; c++) {
          const scat = m.scatR[c]! + m.scatM;
          const k = expm1OverX(m.ext[c]! * dt) * dt;
          L[c]! += T[c]! * ts[c]! * scat * iso * k;
          F[c]! += T[c]! * scat * k;
          T[c]! *= Math.exp(-m.ext[c]! * dt);
        }
      }
      if (ground) {
        const p = advance(r0, mu, muS, nu, length);
        const ts = transmittanceToTop(a, 0, p.muS, 40);
        const nl = Math.max(p.muS, 0);
        for (let c = 0; c < 3; c++) L[c]! += (T[c]! * ts[c]! * nl * a.def.groundAlbedo) / Math.PI;
      }
      for (let c = 0; c < 3; c++) {
        l2[c]! += L[c]! / n;
        fms[c]! += F[c]! / n;
      }
    }
  }
  // Means over the sphere (solid angle 4 pi times the isotropic phase 1 / 4 pi): l2 = second-order
  // luminance per unit illuminance, fms = fraction of isotropic unit luminance scattered back to the point.
  return [l2[0] / (1 - fms[0]), l2[1] / (1 - fms[1]), l2[2] / (1 - fms[2])];
}

export interface SkyRadianceOptions {
  /** Number of segments of the view ray (uniform in distance). */
  steps?: number;
  /** Multi-scattering term; default: evaluated by brute force at every 8th sample and interpolated. */
  multiScatter?: (h: number, muS: number) => Vec3Tuple;
  /** Stop after this distance (aerial perspective up to a surface), m. */
  maxDistance?: number;
}

/**
 * Luminance (rgb, cd/m^2) arriving at a point at altitude h from direction (mu to the vertical, nu to the
 * sun), with the sun at zenith cosine muS and illuminance `sunIlluminance` (lux, rgb) outside the
 * atmosphere; plus the transmittance of the path. The ray ends at the ground, at the top of the shell or
 * at `maxDistance`.
 */
export function skyRadiance(
  a: ReferenceAtmosphere,
  h: number,
  mu: number,
  muS: number,
  nu: number,
  sunIlluminance: Vec3Tuple,
  opts: SkyRadianceOptions = {},
): { luminance: Vec3Tuple; transmittance: Vec3Tuple } {
  const steps = opts.steps ?? 200;
  const r0 = a.rb + h;
  const ground = hitsGround(a, h, mu);
  const length = Math.min(ground ? distanceToGround(a, h, mu) : distanceToTop(a, h, mu), opts.maxDistance ?? Infinity);
  const dt = length / steps;
  const g = a.def.miePhaseG;
  const pR = phaseRayleigh(nu);
  const pM = phaseCornetteShanks(nu, g);
  const T: Vec3Tuple = [1, 1, 1];
  const L: Vec3Tuple = [0, 0, 0];
  const msCache = new Map<number, Vec3Tuple>();
  const ms = (hs: number, muSs: number): Vec3Tuple => {
    if (opts.multiScatter) return opts.multiScatter(hs, muSs);
    const key = Math.round(hs / 2000) * 4096 + Math.round((muSs + 1) * 100);
    let v = msCache.get(key);
    if (!v) {
      v = multiScatter(a, Math.max(Math.round(hs / 2000) * 2000, 0), Math.round((muSs + 1) * 100) / 100 - 1, 6, 12);
      msCache.set(key, v);
    }
    return v;
  };
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) * dt;
    const p = advance(r0, mu, muS, nu, t);
    const hs = altitudeExact(t, r0, h, mu);
    const m = mediumAt(a, hs);
    const ts = transmittanceToTop(a, hs, p.muS, 60);
    const psi = ms(hs, p.muS);
    for (let c = 0; c < 3; c++) {
      const src = sunIlluminance[c]! * (ts[c]! * (m.scatR[c]! * pR + m.scatM * pM) + psi[c]! * (m.scatR[c]! + m.scatM));
      L[c]! += T[c]! * src * expm1OverX(m.ext[c]! * dt) * dt;
      T[c]! *= Math.exp(-m.ext[c]! * dt);
    }
  }
  return { luminance: L, transmittance: T };
}

/** Relative luminance of a linear-sRGB triple. */
export const luminanceOf = (c: Readonly<Vec3Tuple>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
