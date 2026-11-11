/**
 * Photometry and geometry of the sky feature, in float64 (no GPU): the star point-spread function, the solar
 * disc with limb darkening, the phase-integrated flux of a distant body, the impostor cross-fade, air mass
 * and scintillation, real spherical harmonics and cube-map texel geometry. The WGSL in shaders.ts mirrors
 * these formulas; unit tests check both against each other and against brute-force integrals.
 *
 * Units: illuminance in lux, luminance in cd/m^2, angles in radians, pixels of the internal render target.
 */
import type { Vec3, Vec3Tuple } from '@/core/math';

/**
 * Point-spread function of every point source (stars, bodies smaller than a few pixels): a Gaussian core plus
 * power-law wings, as a lens (and an eye) images a point. Core: sigma 1.0 px (rendering-design 9 asked for
 * 0.7 px; at 1.0 px the temporal resolve's jitter ripple is half as large, docs/requests/sky-lighting-1.md).
 * Wings: a Moffat profile (1 + r^2 / alpha^2)^-1.5, the r^-3 envelope of a diffraction pattern, holding
 * STAR_WING_SHARE of the energy; that share is taken out of the core, so the image still integrates to the
 * source's illuminance / pixel solid angle. The wings are what makes a bright star a larger image than a faint
 * one: a pure Gaussian grows only as sqrt(ln(flux)).
 */
export const STAR_PSF_SIGMA_PX = 1.0;
/** Half size of the core's quad in units of sigma: the Gaussian beyond 4.3 sigma holds 1e-4 of the energy. */
export const STAR_QUAD_SIGMAS = 4.3;
export const STAR_WING_SHARE = 0.3;
export const STAR_WING_ALPHA_PX = 2;
/** The wings are drawn out to where they fall under this pre-exposed level (far below the display's black) ... */
export const STAR_WING_FLOOR = 1 / 1024;
/** ... and never further than this (px). */
export const STAR_WING_MAX_PX = 48;

/**
 * Hand-over of a distant body from its analytic far image to its geometry, in DISPLAY pixels (so dynamic
 * resolution does not switch the representation). The far image has full weight while the body's sunlit part
 * is narrower than IMPOSTOR_LIT_FULL_PX (thin bright geometry loses energy in the temporal resolve:
 * docs/requests/sky-lighting-1.md), fades out to IMPOSTOR_LIT_NONE_PX, and is never used above
 * IMPOSTOR_DIAMETER_NONE_PX (fading from IMPOSTOR_DIAMETER_FULL_PX), where the body's own detail matters.
 */
export const IMPOSTOR_LIT_FULL_PX = 4;
export const IMPOSTOR_LIT_NONE_PX = 7;
export const IMPOSTOR_DIAMETER_FULL_PX = 20;
export const IMPOSTOR_DIAMETER_NONE_PX = 32;
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
 * Radius (px) out to which the image of a point source is drawn: where its wings fall under STAR_WING_FLOOR, for
 * a source whose pixels sum to `p` (pre-exposed: illuminance / pixel solid angle x exposure); at least the
 * core's 4.3 sigma, at most STAR_WING_MAX_PX.
 */
export function starImageRadius(p: number, share = STAR_WING_SHARE): number {
  const a = STAR_WING_ALPHA_PX;
  const q = ((p * share) / (2 * Math.PI * a * a * STAR_WING_FLOOR)) ** (2 / 3);
  return Math.min(STAR_WING_MAX_PX, Math.max(STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX, a * Math.sqrt(Math.max(q - 1, 0))));
}

/**
 * Wings of an image drawn out to `radius` px: amplitude and floor of amp x ((1 + r^2 / alpha^2)^-1.5 - floor),
 * which is zero at the radius (no step) and integrates to `share` over the disc of that radius.
 */
export function starWing(radius: number, share = STAR_WING_SHARE): { amp: number; floor: number } {
  const a2 = STAR_WING_ALPHA_PX * STAR_WING_ALPHA_PX;
  const q = 1 + (radius * radius) / a2;
  const floor = q ** -1.5;
  return { amp: share / (2 * Math.PI * a2 * (1 - q ** -0.5) - Math.PI * radius * radius * floor), floor };
}

/** Point-spread function: the fraction of a point source's flux in a pixel at `r` px from it, for an image of `radius` px. */
export function starPsf(r: number, radius: number, share = STAR_WING_SHARE): number {
  const s2 = STAR_PSF_SIGMA_PX * STAR_PSF_SIGMA_PX;
  const core = ((1 - share) * Math.exp((-0.5 * r * r) / s2)) / (2 * Math.PI * s2);
  if (r >= radius || share <= 0) return core;
  const w = starWing(radius, share);
  return core + w.amp * ((1 + (r * r) / (STAR_WING_ALPHA_PX * STAR_WING_ALPHA_PX)) ** -1.5 - w.floor);
}

/**
 * Peak luminance (cd/m^2) of a star of illuminance `e` (lux) at exposure `exposure`: the pixel values
 * e / omegaPx x starPsf sum to e / omegaPx over the pixel lattice (to 1e-3 at any sub-pixel position).
 */
export function starPeakLuminance(e: number, omegaPx: number, exposure = 1): number {
  return (e / omegaPx) * starPsf(0, starImageRadius((e / omegaPx) * exposure));
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

/** Width (px) of the sunlit part of a sphere of `diameterPx` seen at phase angle `phase` (rad), along the sun line. */
export const litWidthPx = (diameterPx: number, phase: number): number => 0.5 * diameterPx * (1 + Math.cos(phase));

/**
 * Weight of a body's analytic far image against its real geometry, from its projected diameter in display px and
 * the phase angle: 1 while the lit width is under IMPOSTOR_LIT_FULL_PX, 0 from IMPOSTOR_LIT_NONE_PX or from a
 * diameter of IMPOSTOR_DIAMETER_NONE_PX, smoothsteps between.
 */
export const impostorWeight = (diameterPx: number, phase: number): number =>
  (1 - smooth01((litWidthPx(diameterPx, phase) - IMPOSTOR_LIT_FULL_PX) / (IMPOSTOR_LIT_NONE_PX - IMPOSTOR_LIT_FULL_PX))) *
  (1 - smooth01((diameterPx - IMPOSTOR_DIAMETER_FULL_PX) / (IMPOSTOR_DIAMETER_NONE_PX - IMPOSTOR_DIAMETER_FULL_PX)));

/**
 * The far image of a body is its sunlit sphere sampled on a grid fixed to the body and convolved with the
 * point-spread function. The grid is in latitude / longitude about the axis perpendicular to the sun-observer
 * plane and covers the sunlit lune only (longitude from the bright limb to the terminator), so every sample
 * is lit however thin the crescent, and the integrand is smooth. Rows and samples per row are chosen for a
 * spacing of IMPOSTOR_SAMPLE_SPACING_PX on the disc (the narrowest kernel's sigma; at least 8 rows of at least
 * 2); kernel sigma: the star PSF
 * for a point, narrowing to IMPOSTOR_KERNEL_RESOLVED_PX for a resolved disc (the sharpness of antialiased
 * geometry); wing share: the star's for a point, none once the disc is resolved.
 */
export const IMPOSTOR_KERNEL_RESOLVED_PX = 0.6;
export const IMPOSTOR_SAMPLE_SPACING_PX = 0.6;
export const IMPOSTOR_MAX_ROWS = 128;
/** The kernel is cut at this many sigma (and scaled back to unit integral): a pixel visits a few dozen samples. */
export const IMPOSTOR_KERNEL_CUT = 2.8;
/**
 * Grids of up to this many samples are normalised to the reference integral (their midpoint sum is up to 4 %
 * off); finer grids are within 2 % by themselves and are not summed a second time on the CPU.
 */
export const IMPOSTOR_NORMALISE_MAX_SAMPLES = 600;
/** Rows (latitude) of the far image's grid and samples of its equatorial row (rows nearer the poles have rowSamples() of them). */
export function impostorLune(diameterPx: number, g: number): { rows: number; cols: number } {
  const r = 0.5 * diameterPx;
  return {
    rows: Math.min(IMPOSTOR_MAX_ROWS, Math.max(8, Math.ceil((Math.PI * r) / IMPOSTOR_SAMPLE_SPACING_PX))),
    cols: Math.min(IMPOSTOR_MAX_ROWS, Math.max(4, Math.ceil(((Math.PI - g) * r) / IMPOSTOR_SAMPLE_SPACING_PX))),
  };
}
/** Samples of the row whose latitude has cosine `a`. */
export const rowSamples = (cols: number, a: number): number => Math.max(2, Math.ceil(cols * a));
/** Number of samples of the far image's grid. */
export function luneSampleCount(diameterPx: number, g: number): number {
  const { rows, cols } = impostorLune(diameterPx, g);
  let n = 0;
  for (let j = 0; j < rows; j++) n += rowSamples(cols, Math.cos(-0.5 * Math.PI + ((j + 0.5) * Math.PI) / rows));
  return n;
}
export const impostorKernelPx = (diameterPx: number): number => STAR_PSF_SIGMA_PX + (IMPOSTOR_KERNEL_RESOLVED_PX - STAR_PSF_SIGMA_PX) * smooth01((diameterPx - 3) / 7);
export const impostorWingShare = (diameterPx: number): number => STAR_WING_SHARE * (1 - smooth01((diameterPx - 2) / 4));

/** Parameters of the Hapke function of a regolith surface (BodyDef.render.surface.hapke). */
export interface HapkeParams {
  b0: number;
  hS: number;
  bP: number;
  cP: number;
}

/**
 * Hapke bidirectional reflectance x mu0 (rendering-design 8.2: shadow-hiding opposition surge, two-term phase
 * function, Lommel-Seeliger limb, no macroscopic roughness): w = single-scattering albedo, mu0 / mu = cosines of
 * incidence / emission, g = phase angle (rad). The radiance of the surface is this times the sun's illuminance.
 */
export function hapkeBrdfMu0(w: number, mu0: number, mu: number, g: number, p: HapkeParams): number {
  if (mu0 <= 0 || mu <= 0) return 0;
  const B = p.b0 / (1 + Math.tan(g / 2) / p.hS);
  const cg = Math.cos(g);
  const P = 1 + p.bP * cg + p.cP * (1.5 * cg * cg - 0.5);
  const gam = Math.sqrt(1 - w);
  const H0 = (1 + 2 * mu0) / (1 + 2 * mu0 * gam);
  const H = (1 + 2 * mu) / (1 + 2 * mu * gam);
  return (w / (4 * Math.PI)) * (mu0 / (mu0 + mu)) * ((1 + B) * P + H0 * H - 1);
}

/**
 * Single-scattering albedo of a Hapke surface whose albedo map value is `albedo`: the maps are normalised to
 * incidence 30 deg, emission 0, phase 30 deg (rendering-design 8.2), so w solves
 * pi x hapke(w, cos 30, 1, 30 deg) / cos 30 = albedo (bisection; saturates at w = 1).
 */
export function hapkeSingleScattering(albedo: number, p: HapkeParams): number {
  const mu0 = Math.cos(Math.PI / 6);
  const at = (w: number): number => (Math.PI * hapkeBrdfMu0(w, mu0, 1, Math.PI / 6, p)) / mu0;
  let lo = 0;
  let hi = 0.999999;
  if (at(hi) <= albedo) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (at(mid) < albedo) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Shading of a far body: Lambert with the albedo that gives the sphere its geometric albedo, or the Hapke function. */
export interface FarBodyShading {
  /** Lambert: radiance per lux = albedo x mu0 / pi per channel. */
  lambertAlbedo: Vec3Tuple;
  /** Hapke: single-scattering albedo per channel and the parameters (null = Lambert). */
  hapke: { w: Vec3Tuple; params: HapkeParams } | null;
}

/**
 * Radiance per lux (rgb) of a point of a far body's disc at (u, v) in units of its radius (v up, the camera along
 * +z), lit from unit direction `sun` in the same frame at phase angle g. Zero outside the disc and on the night side.
 */
export function farBodyRadiance(s: FarBodyShading, u: number, v: number, sun: Vec3, g: number): Vec3Tuple {
  const r2 = u * u + v * v;
  if (r2 >= 1) return [0, 0, 0];
  const mu = Math.sqrt(1 - r2);
  const mu0 = u * sun.x + v * sun.y + mu * sun.z;
  if (mu0 <= 0) return [0, 0, 0];
  if (s.hapke) {
    const h = s.hapke;
    return [hapkeBrdfMu0(h.w[0], mu0, mu, g, h.params), hapkeBrdfMu0(h.w[1], mu0, mu, g, h.params), hapkeBrdfMu0(h.w[2], mu0, mu, g, h.params)];
  }
  return [(s.lambertAlbedo[0] * mu0) / Math.PI, (s.lambertAlbedo[1] * mu0) / Math.PI, (s.lambertAlbedo[2] * mu0) / Math.PI];
}

/**
 * Sum over the far image's sample grid (impostorLune) of radiance per lux x the sample's area on the disc of unit
 * radius, per channel, with the photocentre of its luminance along the sun's direction in the image plane (in
 * radii) and the number of samples. The shader does the same sum and normalises it to farBodyDiscIntegral.
 */
export function farBodyLuneSum(s: FarBodyShading, diameterPx: number, g: number): { sum: Vec3Tuple; centre: number; samples: number } {
  const { rows, cols } = impostorLune(diameterPx, g);
  const sun = { x: Math.sin(g), y: 0, z: Math.cos(g) };
  const span = Math.PI - g;
  const dBeta = Math.PI / rows;
  const sum: Vec3Tuple = [0, 0, 0];
  let cx = 0;
  let cl = 0;
  let samples = 0;
  for (let j = 0; j < rows; j++) {
    const beta = -0.5 * Math.PI + (j + 0.5) * dBeta;
    const a = Math.cos(beta);
    const nj = rowSamples(cols, a);
    const dPsi = span / nj;
    for (let i = 0; i < nj; i++) {
      // x = a cos(psi) runs from the bright limb (psi = 0) to the terminator (psi = pi - g).
      const psi = (i + 0.5) * dPsi;
      const x = a * Math.cos(psi);
      const L = farBodyRadiance(s, x, Math.sin(beta), sun, g);
      const dA = a * a * Math.sin(psi) * dPsi * dBeta;
      const l = (0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2]) * dA;
      sum[0] += L[0] * dA;
      sum[1] += L[1] * dA;
      sum[2] += L[2] * dA;
      cx += x * l;
      cl += l;
      samples++;
    }
  }
  return { sum, centre: cl > 0 ? cx / cl : 0, samples };
}

/**
 * Phase-integrated radiance per lux of a far body's disc of unit radius (rgb): the integral of farBodyRadiance
 * over the sunlit part of the disc at phase angle g, in longitude / latitude about the axis perpendicular to
 * the sun-observer plane (the integrand is smooth there; midpoint rule, 48 x 32 by default; 24 x 16 is within
 * 0.5 % of it). A Lambert sphere gives (2 / 3) x albedo x lambertPhase(g).
 */
export function farBodyDiscIntegral(s: FarBodyShading, g: number, nLat = 48, nLon = 32): Vec3Tuple {
  const sun = { x: Math.sin(g), y: 0, z: Math.cos(g) };
  const out: Vec3Tuple = [0, 0, 0];
  const span = Math.PI - g;
  if (span <= 0) return out;
  for (let j = 0; j < nLat; j++) {
    const beta = -0.5 * Math.PI + ((j + 0.5) * Math.PI) / nLat;
    const a = Math.cos(beta);
    for (let i = 0; i < nLon; i++) {
      // x = a cos(psi) runs from the limb (psi = 0) to the terminator (psi = pi - g); dx dy = a^2 sin(psi) dpsi dbeta.
      const psi = ((i + 0.5) * span) / nLon;
      const L = farBodyRadiance(s, a * Math.cos(psi), Math.sin(beta), sun, g);
      const dA = a * a * Math.sin(psi) * (span / nLon) * (Math.PI / nLat);
      out[0] += L[0] * dA;
      out[1] += L[1] * dA;
      out[2] += L[2] * dA;
    }
  }
  return out;
}

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

// ------------------------------------------------------------------------------------- albedo of the visible face

/** A body's albedo map reduced to a coarse equirectangular grid of linear albedo (row 0 = north, column 0 = longitude -180 deg). */
export interface AlbedoGrid {
  width: number;
  height: number;
  /** rgb per cell, linear. */
  data: Float32Array;
}

/** Box-reduce sRGB pixels (rgba8, equirectangular) to a grid of `width` x `height` cells of linear albedo. */
export function albedoGridFromSrgb(pixels: Uint8ClampedArray | Uint8Array, srcWidth: number, srcHeight: number, width = 64, height = 32): AlbedoGrid {
  const lin = new Float32Array(256);
  for (let v = 0; v < 256; v++) lin[v] = v <= 0.04045 * 255 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
  const data = new Float32Array(width * height * 3);
  const count = new Float32Array(width * height);
  for (let y = 0; y < srcHeight; y++) {
    const cy = Math.min(height - 1, Math.floor((y * height) / srcHeight));
    for (let x = 0; x < srcWidth; x++) {
      const c = cy * width + Math.min(width - 1, Math.floor((x * width) / srcWidth));
      const i = (y * srcWidth + x) * 4;
      data[c * 3] = data[c * 3]! + lin[pixels[i]!]!;
      data[c * 3 + 1] = data[c * 3 + 1]! + lin[pixels[i + 1]!]!;
      data[c * 3 + 2] = data[c * 3 + 2]! + lin[pixels[i + 2]!]!;
      count[c] = count[c]! + 1;
    }
  }
  for (let c = 0; c < width * height; c++) for (let k = 0; k < 3; k++) data[c * 3 + k] = data[c * 3 + k]! / Math.max(count[c]!, 1);
  return { width, height, data };
}

/**
 * Mean albedo of the part of a body that is both sunlit and turned to the observer: every grid cell weighted by
 * its area, its projection towards the observer and the Lommel-Seeliger brightness mu0 / (mu0 + mu) of a
 * regolith surface. `toObserver` and `toSun` are unit vectors in the BODY-FIXED frame. Null when nothing lit
 * is in view.
 */
export function visibleFaceAlbedo(grid: AlbedoGrid, toObserver: Vec3, toSun: Vec3): Vec3Tuple | null {
  const sum: Vec3Tuple = [0, 0, 0];
  let total = 0;
  for (let j = 0; j < grid.height; j++) {
    const lat = (0.5 - (j + 0.5) / grid.height) * Math.PI;
    const cl = Math.cos(lat);
    const z = Math.sin(lat);
    for (let i = 0; i < grid.width; i++) {
      const lon = ((i + 0.5) / grid.width - 0.5) * 2 * Math.PI;
      const x = cl * Math.cos(lon);
      const y = cl * Math.sin(lon);
      const mu = x * toObserver.x + y * toObserver.y + z * toObserver.z;
      const mu0 = x * toSun.x + y * toSun.y + z * toSun.z;
      if (mu <= 0 || mu0 <= 0) continue;
      const w = (cl * mu * mu0) / (mu0 + mu);
      const c = (j * grid.width + i) * 3;
      sum[0] += grid.data[c]! * w;
      sum[1] += grid.data[c + 1]! * w;
      sum[2] += grid.data[c + 2]! * w;
      total += w;
    }
  }
  return total > 0 ? [sum[0] / total, sum[1] / total, sum[2] / total] : null;
}
