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
  gaussianLatticeSum,
  impostorSigmaPx,
  impostorWeight,
  lambertPhase,
  lambertSphereIlluminance,
  limbCentreFactor,
  limbDarkening,
  pixelSolidAngle,
  planetshineWeight,
  raDecToDir,
  scintillationVariance,
  shBasis,
  shIrradiance,
  starPeakLuminance,
  STAR_PSF_SIGMA_PX,
} from '@/render/sky/photometry';
import { bruteForceIrradiance, projectSh } from '@/render/sky/probeScene';

describe('star PSF', () => {
  it('the pixel lattice sum of the sigma 0.7 px Gaussian equals its integral at any sub-pixel position (stable under TAA jitter)', () => {
    const integral = 2 * Math.PI * STAR_PSF_SIGMA_PX ** 2;
    for (const [cx, cy] of [[0, 0], [0.5, 0], [0.5, 0.5], [0.25, -0.37], [0.11, 0.49]] as const) {
      expect(gaussianLatticeSum(cx, cy, STAR_PSF_SIGMA_PX) / integral).toBeCloseTo(1, 3);
    }
  });

  it('pixel luminances integrate to illuminance / pixel solid angle', () => {
    const omega = pixelSolidAngle(Math.tan((45 * Math.PI) / 180), Math.tan((30 * Math.PI) / 180), 2560, 1440);
    const e = 2.54e-6;
    const peak = starPeakLuminance(e, omega);
    const sum = peak * gaussianLatticeSum(0.3, -0.2, STAR_PSF_SIGMA_PX);
    expect(sum / (e / omega)).toBeCloseTo(1, 3);
    // RENDER_API section 12: a magnitude-0 star is about 5 cd/m^2 over one 1440p pixel at 60 deg.
    expect(e / omega).toBeGreaterThan(3.5);
    expect(e / omega).toBeLessThan(6);
    expect(peak).toBeCloseTo(e / omega / (2 * Math.PI * 0.49), 9);
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

  it('impostor weight and size are continuous through the cross-fade', () => {
    expect(impostorWeight(0.5)).toBe(1);
    expect(impostorWeight(3)).toBe(1);
    expect(impostorWeight(6)).toBe(0);
    expect(impostorWeight(4.5)).toBeCloseTo(0.5, 12);
    let prev = impostorWeight(2.9);
    for (let d = 2.9; d < 6.1; d += 0.01) {
      const w = impostorWeight(d);
      expect(Math.abs(w - prev)).toBeLessThan(0.006);
      prev = w;
    }
    expect(impostorSigmaPx(0)).toBeCloseTo(STAR_PSF_SIGMA_PX, 12);
    expect(impostorSigmaPx(4)).toBeCloseTo(Math.hypot(0.7, 1), 12);
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
