import { describe, expect, it } from 'vitest';
import { v3 } from '@/core/math';
import {
  chapman,
  cloudOverGroundAlbedo,
  cloudReflectance,
  cubeFaceUv,
  cubeTexelDirection,
  cubeTexelSolidAngle,
  discMeanLuminance,
  discMu,
  erfcx,
  farBodyDiscIntegral,
  farBodyLuneSum,
  farBodyRadiance,
  albedoGridFromSrgb,
  visibleFaceAlbedo,
  gaussianLatticeSum,
  hapkeBrdfMu0,
  hapkeSingleScattering,
  impostorKernelPx,
  impostorLune,
  impostorWeight,
  impostorWingShare,
  IMPOSTOR_DIAMETER_NONE_PX,
  IMPOSTOR_LIT_FULL_PX,
  IMPOSTOR_LIT_NONE_PX,
  lambertPhase,
  lambertSphereIlluminance,
  limbCentreFactor,
  limbDarkening,
  litWidthPx,
  pixelSolidAngle,
  planetshineWeight,
  raDecToDir,
  scintillationVariance,
  shBasis,
  shIrradiance,
  starImageRadius,
  starPeakLuminance,
  starPsf,
  starWing,
  STAR_PSF_SIGMA_PX,
  STAR_QUAD_SIGMAS,
  STAR_WING_FLOOR,
  STAR_WING_MAX_PX,
  STAR_WING_SHARE,
  type FarBodyShading,
} from '@/render/sky/photometry';
import { bruteForceIrradiance, projectSh } from '@/render/sky/probeScene';

/** Sum of the point-spread function over the pixel lattice around a sub-pixel centre. */
function psfLatticeSum(cx: number, cy: number, radius: number): number {
  let s = 0;
  const n = Math.ceil(radius) + 2;
  for (let y = -n; y <= n; y++) for (let x = -n; x <= n; x++) s += starPsf(Math.hypot(x - cx, y - cy), radius);
  return s;
}
/** exposure = 1 / (1.2 x 2^EV100). */
const exposureAt = (ev: number): number => 1 / (1.2 * 2 ** ev);

describe('star PSF', () => {
  it('the pixel lattice sum of the Gaussian core equals its integral at any sub-pixel position (stable under TAA jitter)', () => {
    const integral = 2 * Math.PI * STAR_PSF_SIGMA_PX ** 2;
    for (const [cx, cy] of [[0, 0], [0.5, 0], [0.5, 0.5], [0.25, -0.37], [0.11, 0.49]] as const) {
      expect(gaussianLatticeSum(cx, cy, STAR_PSF_SIGMA_PX) / integral).toBeCloseTo(1, 6);
    }
  });

  it('core + wings: the pixels of an image add up to the source at every image radius and sub-pixel position', () => {
    for (const radius of [STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX, 6.3, 11, 23.7, STAR_WING_MAX_PX]) {
      for (const [cx, cy] of [[0, 0], [0.5, 0], [0.5, 0.5], [0.25, -0.37], [0.11, 0.49]] as const) {
        expect(Math.abs(psfLatticeSum(cx, cy, radius) - 1)).toBeLessThan(2e-3);
      }
      // The wings hold their share, end without a step and never go negative.
      const w = starWing(radius);
      expect(w.amp * ((1 + (radius * radius) / 4) ** -1.5 - w.floor)).toBeCloseTo(0, 12);
      expect(starPsf(radius * 0.999, radius)).toBeGreaterThanOrEqual(0);
      let wings = 0;
      for (let i = 0; i < 20000; i++) {
        const r = ((i + 0.5) * radius) / 20000;
        wings += (starPsf(r, radius) - starPsf(r, radius, 0) * (1 - STAR_WING_SHARE)) * 2 * Math.PI * r * (radius / 20000);
      }
      expect(wings).toBeCloseTo(STAR_WING_SHARE, 4);
    }
  });

  it('pixel luminances integrate to illuminance / pixel solid angle', () => {
    const omega = pixelSolidAngle(Math.tan((45 * Math.PI) / 180), Math.tan((30 * Math.PI) / 180), 2560, 1440);
    const e = 2.54e-6;
    const radius = starImageRadius(e / omega);
    const sum = (e / omega) * psfLatticeSum(0.3, -0.2, radius);
    expect(sum / (e / omega)).toBeCloseTo(1, 2);
    // RENDER_API section 12: a magnitude-0 star is about 5 cd/m^2 over one 1440p pixel at 60 deg.
    expect(e / omega).toBeGreaterThan(3.5);
    expect(e / omega).toBeLessThan(6);
    expect(starPeakLuminance(e, omega)).toBeCloseTo((e / omega) * starPsf(0, radius), 12);
  });

  it('the image grows with the flux: a V 0 star is more than three times as wide as a V 5 star at EV100 -5', () => {
    // 1280 x 720 at 60 deg; "visible" = above 16/255, which the core's tonemap reaches 3.8 stops under mid-grey.
    const omega = pixelSolidAngle(Math.tan(Math.PI / 6) * (16 / 9), Math.tan(Math.PI / 6), 1280, 720);
    const threshold = 0.18 * 2 ** -3.8;
    const diameter = (v: number, ev: number): number => {
      const p = ((2.54e-6 * 10 ** (-0.4 * v)) / omega) * exposureAt(ev);
      const radius = starImageRadius(p);
      let r = 0;
      while (p * starPsf(r, radius) > threshold && r < 100) r += 0.01;
      return 2 * r;
    };
    let prev = diameter(6.5, -5);
    for (let v = 6.4; v >= -1.5; v -= 0.1) {
      const d = diameter(v, -5);
      expect(d).toBeGreaterThanOrEqual(prev - 0.021);
      prev = d;
    }
    expect(diameter(5, -5)).toBeGreaterThan(1);
    expect(diameter(0, -5) / diameter(5, -5)).toBeGreaterThan(3);
    // Quads: the faint majority keeps the core's quad; only bright stars at a long exposure get large ones.
    const radiusOf = (v: number, ev: number): number => starImageRadius(((2.54e-6 * 10 ** (-0.4 * v)) / omega) * exposureAt(ev));
    expect(radiusOf(6, -3)).toBe(STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX);
    expect(radiusOf(-1.46, 14)).toBe(STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX);
    expect(radiusOf(-1.46, -6)).toBeGreaterThan(20);
    expect(radiusOf(-1.46, -6)).toBeLessThanOrEqual(STAR_WING_MAX_PX);
    // At the cut the wings are below the floor (no visible edge).
    const p = ((2.54e-6 * 10 ** 0.584) / omega) * exposureAt(-5);
    expect(p * (starPsf(radiusOf(-1.46, -5) - 0.01, radiusOf(-1.46, -5)) - starPsf(radiusOf(-1.46, -5) - 0.01, radiusOf(-1.46, -5), 0) * (1 - STAR_WING_SHARE))).toBeLessThan(STAR_WING_FLOOR);
  });

  it('pixel solid angle follows cos^3 off axis', () => {
    const a = pixelSolidAngle(1, 1, 1000, 1000, 1);
    expect(pixelSolidAngle(1, 1, 1000, 1000, 0.5) / a).toBeCloseTo(0.125, 9);
  });
});

describe('solar disc', () => {
  it('mean luminance of the sun is E / (pi sin^2 theta) = 1.9e9 cd/m^2 at 1 AU', () => {
    const theta = Math.asin(695_700_000 / 149_597_870_700);
    expect((2 * theta * 180) / Math.PI).toBeCloseTo(0.533, 3);
    expect(discMeanLuminance(128_000, theta) / 1.9e9).toBeCloseTo(1, 1);
  });

  it('limb darkening keeps the disc illuminance: centre factor 1 / (1 - u/3) times the disc average of I(mu) is 1', () => {
    for (const u of [0.45, 0.6, 0.78]) {
      // Average of I(mu) over the disc area: integral over t in [0,1] of I(mu(t)) 2 t dt.
      let s = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        s += limbDarkening(discMu(t), u) * 2 * t;
      }
      expect((s / n) * limbCentreFactor(u)).toBeCloseTo(1, 4);
      expect(limbDarkening(0, u)).toBeCloseTo(1 - u, 12);
    }
  });
});

describe('distant bodies', () => {
  it('Lambert phase function: 1 at full, 1/pi at quadrature, 0 at new', () => {
    expect(lambertPhase(0)).toBeCloseTo(1, 12);
    expect(lambertPhase(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 12);
    expect(lambertPhase(Math.PI)).toBeCloseTo(0, 12);
  });

  it('the full Moon from Earth gives about 0.25 lux', () => {
    const e = lambertSphereIlluminance(128_000, 0.12, 1_737_400, 384_400_000, 0);
    expect(e).toBeGreaterThan(0.2);
    expect(e).toBeLessThan(0.4);
  });

  it('Lambert-sphere geometric albedo is 2/3 of the Lambert albedo (the lab check body)', () => {
    // Integrate a Lambert sphere of albedo A at full phase: flux = E A R^2 / d^2 x 2/3.
    const A = 0.6;
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const mu = (i + 0.5) / n; // cos of the angle from the sub-observer point = cos of incidence
      // Radiance (A / pi) E mu times the projected disc area element 2 pi R^2 mu dmu (E = R = d = 1).
      s += (A / Math.PI) * mu * mu * 2 * Math.PI * (1 / n);
    }
    expect(s).toBeCloseTo((2 / 3) * A, 4);
  });

  it('the far image hands over on the width of the sunlit part, not on the diameter, continuously', () => {
    expect(impostorWeight(0.5, 0)).toBe(1);
    // Full phase: the lit width is the diameter.
    expect(impostorWeight(IMPOSTOR_LIT_FULL_PX, 0)).toBe(1);
    expect(impostorWeight(IMPOSTOR_LIT_NONE_PX, 0)).toBe(0);
    expect(impostorWeight(0.5 * (IMPOSTOR_LIT_FULL_PX + IMPOSTOR_LIT_NONE_PX), 0)).toBeCloseTo(0.5, 12);
    // A crescent at phase 125 deg: 13 px across it is 2.8 px wide (where the resolve keeps 76 % of geometry): still the far image.
    const phase = (125 * Math.PI) / 180;
    expect(litWidthPx(13.2, phase)).toBeCloseTo(2.81, 2);
    expect(impostorWeight(13.2, phase)).toBe(1);
    expect(impostorWeight(6.6, phase)).toBe(1);
    // Above the diameter limit the geometry is used whatever the phase.
    expect(impostorWeight(IMPOSTOR_DIAMETER_NONE_PX, (170 * Math.PI) / 180)).toBe(0);
    for (const ph of [0, 1, 2.18, 2.9]) {
      let prev = impostorWeight(0.1, ph);
      for (let d = 0.1; d < 40; d += 0.01) {
        const w = impostorWeight(d, ph);
        expect(w).toBeLessThanOrEqual(prev);
        expect(prev - w).toBeLessThan(0.02);
        prev = w;
      }
      expect(prev).toBe(0);
    }
    // Lattice, kernel and wings change continuously with the size.
    expect(impostorLune(0.5, 0)).toEqual({ rows: 8, cols: 4 });
    expect(impostorLune(20, 0).rows).toBe(Math.ceil((Math.PI * 10) / 0.5));
    expect(impostorLune(20, 2.5).cols).toBe(Math.ceil(((Math.PI - 2.5) * 10) / 0.5));
    expect(impostorKernelPx(0.5)).toBe(STAR_PSF_SIGMA_PX);
    expect(impostorKernelPx(20)).toBeCloseTo(0.6, 12);
    expect(impostorWingShare(1)).toBe(STAR_WING_SHARE);
    expect(impostorWingShare(6)).toBe(0);
  });

  it('a Lambert far image integrates to the Lambert-sphere law at every phase and size, and its light sits on the sunlit side', () => {
    const p = 0.434;
    const shading: FarBodyShading = { lambertAlbedo: [1.5 * p, 1.5 * p, 1.5 * p], hapke: null };
    for (const deg of [0, 50, 90, 125, 150]) {
      const g = (deg * Math.PI) / 180;
      const sun = { x: Math.sin(g), y: 0, z: Math.cos(g) };
      // Reference quadrature against the closed form: p x Phi(g) for unit radius.
      expect(Math.abs(farBodyDiscIntegral(shading, g)[1] / (p * lambertPhase(g)) - 1)).toBeLessThan(2e-3);
      for (const d of [0.5, 2.5, 6.6, 13.2, 20.7]) {
        // The image's own grid (every sample lit, however thin the crescent) is within 5 % of the law; the shader normalises the rest away.
        const s = farBodyLuneSum(shading, d, g);
        expect(s.samples).toBeGreaterThanOrEqual(16);
        expect(Math.abs(s.sum[1] / (p * lambertPhase(g)) - 1)).toBeLessThan(0.05);
        // The light sits on the sunlit side of the centre, more so the thinner the crescent.
        if (deg > 0) expect(s.centre).toBeGreaterThan(0);
        if (deg >= 125) expect(s.centre).toBeGreaterThan(0.5);
      }
    }
    // A crescent is a sliver: at phase 125 deg nothing is lit left of the terminator ellipse.
    const g = (125 * Math.PI) / 180;
    const sun = { x: Math.sin(g), y: 0, z: Math.cos(g) };
    expect(farBodyRadiance(shading, -0.2, 0, sun, g)[1]).toBe(0);
    expect(farBodyRadiance(shading, 0.9, 0, sun, g)[1]).toBeGreaterThan(0);
    expect(farBodyRadiance(shading, 0.9, 0.5, sun, g)[1]).toBe(0);
  });

  it('Hapke: the albedo inversion reproduces the map value at its normalisation geometry; a regolith sphere is far from Lambert', () => {
    const params = { b0: 1.8, hS: 0.065, bP: 0.25, cP: 0.3 };
    const mu0 = Math.cos(Math.PI / 6);
    for (const a of [0.05, 0.12, 0.2, 0.3]) {
      const w = hapkeSingleScattering(a, params);
      expect((Math.PI * hapkeBrdfMu0(w, mu0, 1, Math.PI / 6, params)) / mu0).toBeCloseTo(a, 6);
    }
    // rendering-design 8.2: maria w about 0.17, highlands about 0.33.
    expect(hapkeSingleScattering(0.07, params)).toBeGreaterThan(0.1);
    expect(hapkeSingleScattering(0.07, params)).toBeLessThan(0.25);
    const w = hapkeSingleScattering(0.12, params);
    const shading: FarBodyShading = { lambertAlbedo: [0.18, 0.18, 0.18], hapke: { w: [w, w, w], params } };
    const disc = (deg: number): number => {
      const g = (deg * Math.PI) / 180;
      return farBodyDiscIntegral(shading, g)[1];
    };
    // The quarter Moon is about a tenth of the full Moon (a Lambert sphere: 1 / pi), and the full disc has no dark limb.
    expect(disc(90) / disc(0)).toBeLessThan(0.2);
    expect(disc(90) / disc(0)).toBeGreaterThan(0.05);
    const centre = farBodyRadiance(shading, 0, 0, { x: 0.02, y: 0, z: Math.sqrt(1 - 0.0004) }, 0.02)[1];
    const limb = farBodyRadiance(shading, 0.95, 0, { x: 0.02, y: 0, z: Math.sqrt(1 - 0.0004) }, 0.02)[1];
    expect(limb / centre).toBeGreaterThan(0.8);
  });

  it('the coarse reference quadrature of the Hapke disc is within 0.5 % of the fine one at every phase', () => {
    const params = { b0: 1.8, hS: 0.065, bP: 0.25, cP: 0.3 };
    const w = hapkeSingleScattering(0.13, params);
    const shading: FarBodyShading = { lambertAlbedo: [0.18, 0.18, 0.18], hapke: { w: [w, w, w], params } };
    for (const deg of [1, 10, 30, 60, 90, 125, 150, 170]) {
      const g = (deg * Math.PI) / 180;
      expect(Math.abs(farBodyDiscIntegral(shading, g, 24, 16)[1] / farBodyDiscIntegral(shading, g)[1] - 1)).toBeLessThan(5e-3);
    }
  });

  it('the mean albedo of the visible sunlit face follows the map: a body dark on one side is dark from that side', () => {
    // sRGB map 8 x 4: western half (longitudes -180..0) 64, eastern half 160.
    const px = new Uint8Array(8 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) px.set([x < 4 ? 64 : 160, x < 4 ? 64 : 160, x < 4 ? 64 : 160, 255], (y * 8 + x) * 4);
    const grid = albedoGridFromSrgb(px, 8, 4, 8, 4);
    const dark = ((64 / 255 + 0.055) / 1.055) ** 2.4;
    const bright = ((160 / 255 + 0.055) / 1.055) ** 2.4;
    expect(grid.data[0]).toBeCloseTo(dark, 6);
    expect(grid.data[7 * 3]).toBeCloseTo(bright, 6);
    // Seen and lit from longitude -90 deg (the dark side), from +90 deg (the bright side), and from 0 deg (half and half).
    const west = visibleFaceAlbedo(grid, { x: 0, y: -1, z: 0 }, { x: 0, y: -1, z: 0 })!;
    const east = visibleFaceAlbedo(grid, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })!;
    const mid = visibleFaceAlbedo(grid, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })!;
    expect(west[1]).toBeCloseTo(dark, 6);
    expect(east[1]).toBeCloseTo(bright, 6);
    expect(mid[1]).toBeCloseTo(0.5 * (dark + bright), 6);
    // The observer on the dark side, the sun over the terminator at longitude 0: only the lit quarter counts, still dark.
    expect(visibleFaceAlbedo(grid, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 })![1]).toBeCloseTo(dark, 6);
    // Nothing lit in view: no value.
    expect(visibleFaceAlbedo(grid, { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('planetshine weight matches the render core fade (smoothstep 2 R .. 4 R)', () => {
    expect(planetshineWeight(1.5, 1)).toBe(0);
    expect(planetshineWeight(3, 1)).toBeCloseTo(0.5, 12);
    expect(planetshineWeight(10, 1)).toBe(1);
  });
});

describe('atmosphere helpers', () => {
  it('erfcx matches e^(y^2) erfc(y) (series and asymptote)', () => {
    expect(erfcx(0)).toBeCloseTo(1, 6);
    // Asymptote 1 / (y sqrt(pi)) (1 - 1/(2 y^2) + 3/(4 y^4)).
    const y = 20;
    expect(erfcx(y) / ((1 / (y * Math.sqrt(Math.PI))) * (1 - 1 / (2 * y * y) + 3 / (4 * y ** 4)))).toBeCloseTo(1, 5);
  });

  it('Chapman air mass: 1 at the zenith, about 2 at 60 deg, about 38 at the horizon (Earth, H = 8 km)', () => {
    const x = 6_371_000 / 8000;
    expect(chapman(x, 1)).toBeCloseTo(1, 2);
    expect(chapman(x, 0.5)).toBeCloseTo(2, 1);
    expect(chapman(x, 0)).toBeGreaterThan(34);
    expect(chapman(x, 0)).toBeLessThan(40);
  });

  it('scintillation grows with air mass, saturates below 1 and vanishes high above the turbulent air', () => {
    const z = scintillationVariance(1, 0, 8000);
    const h = scintillationVariance(38, 0, 8000);
    expect(z).toBeGreaterThan(0.01);
    expect(z).toBeLessThan(0.05);
    expect(h).toBeGreaterThan(0.9);
    expect(h).toBeLessThan(1);
    expect(scintillationVariance(1, 80_000, 8000)).toBeLessThan(1e-5);
  });

  it('cloud reflectance is two-stream conservative and the adding method reduces to the ground without cloud', () => {
    expect(cloudReflectance(0)).toBe(0);
    expect(cloudReflectance(20)).toBeGreaterThan(0.55);
    expect(cloudReflectance(20)).toBeLessThan(0.65);
    expect(cloudOverGroundAlbedo(0, 0.3)).toBeCloseTo(0.3, 12);
    expect(cloudOverGroundAlbedo(0.6, 0)).toBeCloseTo(0.6, 12);
  });
});

describe('cube maps and spherical harmonics', () => {
  it('texel directions and face lookup are inverse (WebGPU face table)', () => {
    for (let face = 0; face < 6; face++) {
      for (const [x, y] of [[0, 0], [5, 60], [31, 31], [63, 12]] as const) {
        const d = cubeTexelDirection(face, x, y, 64);
        const f = cubeFaceUv(d);
        expect(f.face).toBe(face);
        expect(f.s * 64 - 0.5).toBeCloseTo(x, 9);
        expect(f.t * 64 - 0.5).toBeCloseTo(y, 9);
      }
    }
    expect(cubeTexelDirection(0, 31.5, 31.5, 64).x).toBeCloseTo(1, 12);
    expect(cubeTexelDirection(4, 31.5, 31.5, 64).z).toBeCloseTo(1, 12);
  });

  it('texel solid angles sum to 4 pi', () => {
    let s = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) s += cubeTexelSolidAngle(x, y, 32);
    expect(s * 6).toBeCloseTo(4 * Math.PI, 10);
  });

  it('SH9 irradiance of a uniform sky is pi L; of a clamped-cosine source it matches brute force within 10 %', () => {
    const uniform = projectSh(() => [1, 2, 3], 16);
    const e = shIrradiance(uniform, { x: 0.3, y: -0.5, z: 0.81 });
    expect(e[0] / Math.PI).toBeCloseTo(1, 3);
    expect(e[2] / (3 * Math.PI)).toBeCloseTo(1, 3);
    // A bright lower hemisphere (an Earth below a low orbit, roughly): irradiance facing down vs brute force.
    const ground = (d: { x: number; y: number; z: number }): [number, number, number] => (d.z < -0.25 ? [1000, 1000, 1000] : [0, 0, 0]);
    const sh = projectSh(ground, 32);
    const down = { x: 0, y: 0, z: -1 };
    const side = v3.normalize({ x: 1, y: 0, z: -0.3 });
    expect(shIrradiance(sh, down)[0] / bruteForceIrradiance(ground, down, 300)[0]).toBeCloseTo(1, 1);
    expect(Math.abs(shIrradiance(sh, side)[0] / bruteForceIrradiance(ground, side, 300)[0] - 1)).toBeLessThan(0.1);
  });

  it('RA / Dec follow the contract (Polaris near +Z, RA 6 h on +Y)', () => {
    const p = raDecToDir((37.95 * Math.PI) / 180, (89.26 * Math.PI) / 180);
    expect(p.z).toBeGreaterThan(0.9999);
    const q = raDecToDir(Math.PI / 2, 0);
    expect(q.y).toBeCloseTo(1, 12);
    expect(shBasis({ x: 0, y: 0, z: 1 })[2]).toBeCloseTo(0.488603, 6);
  });
});
