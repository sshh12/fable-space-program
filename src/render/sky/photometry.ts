/**
 * Photometry and geometry of the sky feature, in float64 (no GPU): the star point-spread function, the solar
 * disc with limb darkening, the phase-integrated flux of a distant body, the impostor cross-fade, air mass
 * and scintillation, real spherical harmonics and cube-map texel geometry. The WGSL in shaders.ts mirrors
 * these formulas; unit tests check both against each other and against brute-force integrals.
 *
 * Units: illuminance in lux, luminance in cd/m^2, angles in radians, pixels of the internal render target.
 */
import type { Vec3, Vec3Tuple } from '@/core/math';

/** Standard deviation of the Gaussian point-spread function of a star, render pixels (rendering-design 9). */
export const STAR_PSF_SIGMA_PX = 0.7;
/** Half size of a star quad in units of sigma: 4.3 sigma = 3.0 px; the Gaussian beyond it holds 1e-4 of the energy. */
export const STAR_QUAD_SIGMAS = 4.3;
/** A distant body is an impostor below this projected diameter (px) and its geometry above the next one. */
export const IMPOSTOR_FULL_PX = 3;
export const IMPOSTOR_NONE_PX = 6;
/** Planetshine far-field formula of the render core fades in between these multiples of a body's radius. */
export const PLANETSHINE_FADE_START_R = 2;
export const PLANETSHINE_FADE_END_R = 4;

const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Solid angle (sr) of one render pixel seen along a direction whose cosine with the view axis is `cosOffAxis`:
 * the pixel's area on the image plane at unit focal distance, (2 tan(fovX/2) / W)(2 tan(fovY/2) / H), times cos^3.
 */
export function pixelSolidAngle(tanHalfFovX: number, tanHalfFovY: number, width: number, height: number, cosOffAxis = 1): number {
  return ((2 * tanHalfFovX) / width) * ((2 * tanHalfFovY) / height) * cosOffAxis ** 3;
}

/**
 * Peak luminance (cd/m^2) of a star of illuminance `e` (lux) drawn as a Gaussian of `sigma` px: the pixel
 * values L_peak exp(-d^2 / 2 sigma^2) sum to e / omegaPx over the pixel lattice (the lattice sum of a
 * sigma = 0.7 px Gaussian equals its integral 2 pi sigma^2 to 1e-4 at any sub-pixel position).
 */
export function starPeakLuminance(e: number, omegaPx: number, sigma = STAR_PSF_SIGMA_PX): number {
  return e / (omegaPx * 2 * Math.PI * sigma * sigma);
}

/** Lattice sum of exp(-|p - c|^2 / 2 sigma^2) over integer pixel centres around a sub-pixel centre c (for tests). */
export function gaussianLatticeSum(cx: number, cy: number, sigma: number, radius = 8): number {
  let s = 0;
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) s += Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
  return s;
}

/** Mean luminance of a stellar disc: the illuminance it produces divided by its solid angle, E / (pi sin^2 theta). */
export function discMeanLuminance(illuminance: number, angularRadius: number): number {
  return illuminance / (Math.PI * Math.sin(angularRadius) ** 2);
}

/**
 * Linear limb darkening I(mu) = I0 (1 - u (1 - mu)), mu = cos of the angle between the line of sight and the
 * stellar surface normal. Its disc average is I0 (1 - u / 3), so the centre luminance that keeps the disc's
 * illuminance is mean / (1 - u / 3).
 */
export const limbDarkening = (mu: number, u: number): number => 1 - u * (1 - mu);
export const limbCentreFactor = (u: number): number => 1 / (1 - u / 3);

/** mu at a point of the disc `t` = (angle from the disc centre) / (angular radius), 0..1 (small-angle exact). */
export const discMu = (t: number): number => Math.sqrt(Math.max(0, 1 - t * t));

/** Phase function of a Lambert sphere: 1 at full phase (alpha = 0), 0 at new (alpha = pi). */
export const lambertPhase = (alpha: number): number => (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;

/**
 * Illuminance (lux) at the observer from a sunlit sphere: E_sun(at the body) x geometric albedo x (R / d)^2 x
 * Phi(phase angle), Lambert-sphere phase function (the formula of the render core's planetshine).
 */
export function lambertSphereIlluminance(eSunAtBody: number, geometricAlbedo: number, radius: number, distance: number, phaseAngle: number): number {
  return eSunAtBody * geometricAlbedo * (radius / distance) ** 2 * lambertPhase(phaseAngle);
}

/**
 * Weight of the point impostor against the body's real geometry, by projected diameter in px: 1 up to
 * IMPOSTOR_FULL_PX, 0 from IMPOSTOR_NONE_PX, smoothstep between.
 */
export const impostorWeight = (diameterPx: number): number => 1 - smooth01((diameterPx - IMPOSTOR_FULL_PX) / (IMPOSTOR_NONE_PX - IMPOSTOR_FULL_PX));

/**
 * Standard deviation (px) of the impostor's Gaussian: the star PSF widened by the second moment of a uniform disc
 * of `diameterPx` (variance r^2 / 4 per axis), so the blob has the size of the body at the hand-over.
 */
export const impostorSigmaPx = (diameterPx: number): number => Math.sqrt(STAR_PSF_SIGMA_PX ** 2 + (diameterPx / 4) ** 2);

/** Weight of the render core's planetshine light for a body `distance` from its centre (smoothstep 2 R .. 4 R). */
export const planetshineWeight = (distance: number, radius: number): number =>
  smooth01((distance / radius - PLANETSHINE_FADE_START_R) / (PLANETSHINE_FADE_END_R - PLANETSHINE_FADE_START_R));

/**
 * e^(y^2) erfc(y) for y >= 0: Abramowitz & Stegun 7.1.26 below y = 3 (relative error under 1 %), the asymptotic
 * series 1 / (sqrt(pi) y) (1 - 1/(2y^2) + 3/(4y^4) - 15/(8y^6)) above (truncation error under 1e-3 at y = 3).
 */
export function erfcx(y: number): number {
  if (y >= 3) {
    const r = 1 / (y * y);
    return (1 - 0.5 * r + 0.75 * r * r - 1.875 * r * r * r) / (Math.sqrt(Math.PI) * y);
  }
  const t = 1 / (1 + 0.3275911 * y);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
}

/**
 * Chapman function for an exponential atmosphere: the slant column along a ray with cos(zenith angle) `mu >= 0`
 * from radius r, relative to the vertical column from the same point, for x = r / H >> 1:
 * Ch = sqrt(pi x / 2) e^(y^2) erfc(y), y = mu sqrt(x / 2). 1 at the zenith, sqrt(pi x / 2) at the horizon.
 */
export function chapman(x: number, mu: number): number {
  return Math.sqrt((Math.PI * x) / 2) * erfcx(Math.max(0, mu) * Math.sqrt(x / 2));
}

/**
 * Intensity scintillation variance of a star seen with the naked eye: sigma_I^2 = s / (1 + s), s = S0 X^(11/6)
 * e^(-h / H). X^(11/6) is the small-aperture (Rytov) air-mass dependence, s / (1 + s) the saturation of strong
 * scintillation near the horizon, e^(-h / H) the thinning of the turbulent air above the observer. S0 = 0.03 is
 * the zenith variance of a small aperture at a good site (Dravins et al. 1997, PASP 109, 173: sigma_I 0.1-0.2).
 */
export const SCINTILLATION_ZENITH_VARIANCE = 0.03;
export function scintillationVariance(airMass: number, altitude: number, scaleHeight: number): number {
  const s = SCINTILLATION_ZENITH_VARIANCE * airMass ** (11 / 6) * Math.exp(-Math.max(0, altitude) / scaleHeight);
  return s / (1 + s);
}

/**
 * Reflectance of a conservatively scattering cloud layer of optical depth tau and asymmetry g under diffuse
 * illumination (two-stream; Bohren 1987): R = (1 - g) tau / (2 + (1 - g) tau). Its diffuse transmittance is 1 - R.
 */
export const CLOUD_ASYMMETRY = 0.85;
export const cloudReflectance = (tau: number, g = CLOUD_ASYMMETRY): number => ((1 - g) * tau) / (2 + (1 - g) * tau);

/**
 * Albedo of a cloud layer of reflectance R over ground of albedo A (adding method, both Lambertian):
 * R + (1 - R)^2 A / (1 - R A).
 */
export const cloudOverGroundAlbedo = (r: number, a: number): number => r + ((1 - r) * (1 - r) * a) / (1 - r * a);

// ------------------------------------------------------------------------------------------- spherical harmonics

/** Real SH basis, order 2, in the order of 'env.sh9': Y00, Y1-1 (y), Y10 (z), Y11 (x), Y2-2 (xy), Y2-1 (yz), Y20, Y21 (xz), Y22. */
export function shBasis(n: Vec3, out: number[] = new Array<number>(9)): number[] {
  const { x, y, z } = n;
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

/** Cosine-lobe convolution per band (Ramamoorthi & Hanrahan 2001): radiance SH -> irradiance SH. */
export const SH_COSINE_LOBE = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4] as const;

/** Irradiance (lux) along a unit normal from irradiance coefficients (9 x rgb), clamped at 0 like the render core. */
export function shIrradiance(coeffs: readonly Vec3Tuple[], n: Vec3): Vec3Tuple {
  const b = shBasis(n);
  const e: Vec3Tuple = [0, 0, 0];
  for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) e[c] = e[c]! + coeffs[i]![c]! * b[i]!;
  return [Math.max(0, e[0]), Math.max(0, e[1]), Math.max(0, e[2])];
}

// --------------------------------------------------------------------------------------------- cube-map geometry

/**
 * Unit direction (ROOT axes) through the centre of texel (x, y) of cube face `face` (WebGPU order +X, -X, +Y,
 * -Y, +Z, -Z; x to the right, y down), the face-selection table of WebGPU / Vulkan / D3D.
 */
export function cubeTexelDirection(face: number, x: number, y: number, size: number): Vec3 {
  const u = (2 * (x + 0.5)) / size - 1;
  const v = (2 * (y + 0.5)) / size - 1;
  let d: Vec3;
  switch (face) {
    case 0:
      d = { x: 1, y: -v, z: -u };
      break;
    case 1:
      d = { x: -1, y: -v, z: u };
      break;
    case 2:
      d = { x: u, y: 1, z: v };
      break;
    case 3:
      d = { x: u, y: -1, z: -v };
      break;
    case 4:
      d = { x: u, y: -v, z: 1 };
      break;
    default:
      d = { x: -u, y: -v, z: -1 };
  }
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

/** Exact solid angle (sr) of texel (x, y) of a cube face of `size` texels (the same for every face). */
export function cubeTexelSolidAngle(x: number, y: number, size: number): number {
  const a = (s: number, t: number): number => Math.atan2(s * t, Math.sqrt(s * s + t * t + 1));
  const x0 = (2 * x) / size - 1;
  const x1 = (2 * (x + 1)) / size - 1;
  const y0 = (2 * y) / size - 1;
  const y1 = (2 * (y + 1)) / size - 1;
  return a(x0, y0) - a(x0, y1) - a(x1, y0) + a(x1, y1);
}

/** Face, texel coordinates (continuous, 0..size) of a direction: inverse of cubeTexelDirection. */
export function cubeFaceUv(d: Vec3): { face: number; s: number; t: number } {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  let face: number;
  let sc: number;
  let tc: number;
  let ma: number;
  if (ax >= ay && ax >= az) {
    face = d.x >= 0 ? 0 : 1;
    ma = ax;
    sc = d.x >= 0 ? -d.z : d.z;
    tc = -d.y;
  } else if (ay >= az) {
    face = d.y >= 0 ? 2 : 3;
    ma = ay;
    sc = d.x;
    tc = d.y >= 0 ? d.z : -d.z;
  } else {
    face = d.z >= 0 ? 4 : 5;
    ma = az;
    sc = d.z >= 0 ? d.x : -d.x;
    tc = -d.y;
  }
  return { face, s: 0.5 * (sc / ma + 1), t: 0.5 * (tc / ma + 1) };
}

/** Unit direction of right ascension / declination (radians), J2000 equatorial = ROOT axes (src/core/contracts/sky.ts). */
export const raDecToDir = (ra: number, dec: number): Vec3 => ({ x: Math.cos(dec) * Math.cos(ra), y: Math.cos(dec) * Math.sin(ra), z: Math.sin(dec) });

/** Galactic north pole and galactic centre (J2000, IAU 1958 / Reid & Brunthaler 2004), radians. */
export const GALACTIC_NORTH_POLE = { ra: (192.85948 * Math.PI) / 180, dec: (27.12825 * Math.PI) / 180 };
export const GALACTIC_CENTRE = { ra: (266.40499 * Math.PI) / 180, dec: (-28.93617 * Math.PI) / 180 };
