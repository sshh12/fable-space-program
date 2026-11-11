/**
 * Ocean tunables: BodyDef.ocean (physics: sea level, swell) + BodyDef.render.ocean (look: wind, absorption,
 * params). Validated here; every number the ocean package uses comes from these two sections.
 */
import type { BodyDef, OceanDef, OceanRenderDef } from '@/core/contracts/defs';
import type { SwellComponent } from '@/core/geo/oceanSwell';
import { DEG, type Vec3Tuple } from '@/core/math';
import { fieldAt, fieldMean } from './fieldModel';

export interface OceanTunables {
  bodyId: string;
  /** Reference radius and sea-level radius (radius + seaLevel), m. */
  radius: number;
  seaRadius: number;
  /** Surface gravity used by the swell dispersion: mu / radius^2 (what the physics passes to oceanSwellHeight). */
  gravity: number;
  swell: readonly SwellComponent[];
  /** U10 wind speed (m/s) and the compass direction the wind blows TOWARD (rad, clockwise from north). */
  windSpeed: number;
  windDir: number;
  /** Absorption and backscatter per metre, linear RGB. */
  absorption: Vec3Tuple;
  backscatter: Vec3Tuple;
  /** FFT: planet-fixed period (m) and the divisors that give the four cascade patch lengths. */
  cascadePeriod: number;
  cascadeDivisors: [number, number, number, number];
  fetch: number;
  jonswapGamma: number;
  /** Wavelengths at or above this carry no FFT energy (they belong to the shared swell), m. */
  highPassWavelength: number;
  /**
   * Long-wave normals layer: patch length cascadePeriod / longWaveDivisor, drawn as two copies rotated by
   * +-longWaveSpread (rad) about the wind, whose sum does not repeat.
   */
  longWaveDivisor: number;
  longWaveSpread: number;
  choppiness: number;
  /** Dispersion is quantised to multiples of 2 pi / repeatPeriod so phases are exact in float32. */
  repeatPeriod: number;
  seed: number;
  fadeStart: number;
  fadeEnd: number;
  /** Wave detail is complete inside detailFadeFraction x fadeStart and zero at fadeStart. */
  detailFadeFraction: number;
  /** 0..1: how strongly the imagery colour tints the deep-water colour. */
  imageryTint: number;
  /** Decay rates (1/s) of the breaker's own foam and of the foam it leaves behind (foamMap.ts). */
  foamDecay: number;
  foamResidualDecay: number;
  /** A wave breaks where the breaking criterion exceeds foamSigma of its standard deviations, fully over foamRampSigma more. */
  foamSigma: number;
  foamRampSigma: number;
  /**
   * Foam of a texel without history (scrolled in, or a level starting): old foam of density foamOldDensity where
   * the criterion is within foamOldDrop sigmas below the threshold.
   */
  foamOldDrop: number;
  foamOldDensity: number;
  /** Albedo of fresh foam, and of the thinnest lace relative to it. */
  foamAlbedo: number;
  foamLaceAlbedo: number;
  /** Share of the residual foam's density that shows (the lace it thins out into). */
  foamResidualDensity: number;
  shoreFoamDepth: number;
  /**
   * Surf: the swell breaks where the water is shallower than surfBreakDepth (m); bores follow each other every
   * surfPeriod (s; rounded so that a whole number fits the repeat period) and travel at sqrt(g h) over a bed of
   * slope surfBedSlope (which sets how many are between the break line and the shore).
   */
  surfBreakDepth: number;
  surfPeriod: number;
  surfBedSlope: number;
  refractionDistortion: number;
  chromaticOffset: number;
  vesselDampingHullRadii: number;
  wakeExtent: number;
  wakeFoamPerSplash: number;
  rippleWavelength: number;
  rippleAmplitude: number;
  rippleLifetime: number;
  wetLineDryingRate: number;
  /** Compression of the first capillary detail layer (the second uses its square). */
  capillaryScale: number;
  /** Slope variance left to the GGX lobe even where a pixel is a few millimetres (shortest capillaries). */
  unresolvedFloor: number;
  /** Mesoscale variability of the slope variance (log amplitude) and the depth of slicks (0..1). */
  windVariability: number;
  slickStrength: number;
  /** Gusts ("cat's paws", 0.3-1.5 km): log amplitude of the slope variance; calm filaments (~150 m wide): depth 0..1. */
  gustVariability: number;
  filamentStrength: number;
  /**
   * Side of a glitter facet (m): a pixel whose footprint holds N = area / size^2 facets shows a Poisson number of
   * them mirroring the sun (brdf_water). About the size of the wavelets that carry a sun image.
   */
  glintFacetSize: number;
  /** Reactive-mask value inside the sun's glitter path (sparkles are new every few frames). */
  glintReactive: number;
  /**
   * Largest reactive-mask value for the temporal resolve ('post.reactive', RENDER_API section 18), reached where
   * the shortest wave the pixel resolves changes its phase by much more than 0.1 rad per frame.
   */
  taaReactive: number;
}

const need = (file: string, params: Record<string, number>, name: string, check: (v: number) => boolean = Number.isFinite): number => {
  const v = params[name];
  if (typeof v !== 'number' || !check(v)) throw new Error(`${file}: params.${name} is missing or invalid (${String(v)})`);
  return v;
};
const positive = (v: number): boolean => Number.isFinite(v) && v > 0;
const fraction = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

/** Tunables of a body with an ocean, or null when it has none (bodies without an ocean cost nothing). */
export function oceanTunables(body: BodyDef): OceanTunables | null {
  const phys: OceanDef | null = body.ocean;
  const look: OceanRenderDef | null = body.render.ocean;
  if (!phys || !look) return null;
  const file = `data/defs/render/${body.id}.ocean.json`;
  const p = look.params;
  if (!positive(look.windSpeed)) throw new Error(`${file}: windSpeed must be > 0`);
  if (!Number.isFinite(look.windDirDeg)) throw new Error(`${file}: windDirDeg is missing`);
  if (!look.absorption || look.absorption.length !== 3 || look.absorption.some((a) => !positive(a))) throw new Error(`${file}: absorption must be three positive numbers`);
  const divisors: [number, number, number, number] = [
    need(file, p, 'cascadeDivisor0', positive),
    need(file, p, 'cascadeDivisor1', positive),
    need(file, p, 'cascadeDivisor2', positive),
    need(file, p, 'cascadeDivisor3', positive),
  ];
  for (let i = 0; i < 4; i++) {
    if (!Number.isInteger(divisors[i]) || (i > 0 && divisors[i]! <= divisors[i - 1]!)) throw new Error(`${file}: cascade divisors must be increasing integers`);
  }
  const fadeStart = need(file, p, 'nearFieldFadeStartM', positive);
  const fadeEnd = need(file, p, 'nearFieldFadeEndM', positive);
  if (fadeEnd <= fadeStart) throw new Error(`${file}: nearFieldFadeEndM must exceed nearFieldFadeStartM`);
  for (const c of phys.swell) {
    if (!positive(c.wavelength) || !(c.amplitude >= 0)) throw new Error(`data/defs/bodies/${body.id}.json: swell component with wavelength ${c.wavelength} / amplitude ${c.amplitude}`);
  }
  return {
    bodyId: body.id,
    radius: body.radius,
    seaRadius: body.radius + phys.seaLevel,
    gravity: body.mu / (body.radius * body.radius),
    swell: phys.swell,
    windSpeed: look.windSpeed,
    windDir: look.windDirDeg * DEG,
    absorption: [look.absorption[0], look.absorption[1], look.absorption[2]],
    backscatter: [need(file, p, 'backscatterR', positive), need(file, p, 'backscatterG', positive), need(file, p, 'backscatterB', positive)],
    cascadePeriod: need(file, p, 'cascadePeriodM', positive),
    cascadeDivisors: divisors,
    fetch: need(file, p, 'fetchM', positive),
    jonswapGamma: need(file, p, 'jonswapGamma', positive),
    highPassWavelength: need(file, p, 'highPassWavelengthM', positive),
    longWaveDivisor: need(file, p, 'longWaveDivisor', (v) => Number.isInteger(v) && v > 0 && v < divisors[0]!),
    longWaveSpread: need(file, p, 'longWaveSpreadDeg', (v) => v > 0 && v < 45) * DEG,
    choppiness: need(file, p, 'choppiness', (v) => v >= 0 && v <= 2),
    repeatPeriod: need(file, p, 'repeatPeriodS', positive),
    seed: need(file, p, 'seed', Number.isInteger),
    fadeStart,
    fadeEnd,
    detailFadeFraction: need(file, p, 'detailFadeFraction', (v) => v > 0 && v < 1),
    imageryTint: need(file, p, 'imageryTint', fraction),
    foamDecay: need(file, p, 'foamDecayPerS', positive),
    foamResidualDecay: need(file, p, 'foamResidualDecayPerS', positive),
    foamSigma: need(file, p, 'foamSigma', positive),
    foamRampSigma: need(file, p, 'foamRampSigma', positive),
    foamOldDrop: need(file, p, 'foamOldDropSigma', (v) => v >= 0),
    foamOldDensity: need(file, p, 'foamOldDensity', fraction),
    foamAlbedo: need(file, p, 'foamAlbedo', fraction),
    foamLaceAlbedo: need(file, p, 'foamLaceAlbedo', fraction),
    foamResidualDensity: need(file, p, 'foamResidualDensity', fraction),
    shoreFoamDepth: need(file, p, 'shoreFoamDepthM', positive),
    surfBreakDepth: need(file, p, 'surfBreakDepthM', positive),
    surfPeriod: need(file, p, 'surfPeriodS', positive),
    surfBedSlope: need(file, p, 'surfBedSlope', positive),
    refractionDistortion: need(file, p, 'refractionDistortion', (v) => v >= 0),
    chromaticOffset: need(file, p, 'chromaticOffset', (v) => v >= 0),
    vesselDampingHullRadii: need(file, p, 'vesselDampingHullRadii', positive),
    wakeExtent: need(file, p, 'wakeExtentM', positive),
    wakeFoamPerSplash: need(file, p, 'wakeFoamPerSplash', (v) => v >= 0),
    rippleWavelength: need(file, p, 'rippleWavelengthM', positive),
    rippleAmplitude: need(file, p, 'rippleAmplitudeM', (v) => v >= 0),
    rippleLifetime: need(file, p, 'rippleLifetimeS', positive),
    wetLineDryingRate: need(file, p, 'wetLineDryingRateMps', positive),
    capillaryScale: need(file, p, 'capillaryScale', (v) => v > 1),
    unresolvedFloor: need(file, p, 'unresolvedSlopeVariance', (v) => v >= 0),
    windVariability: need(file, p, 'windVariability', (v) => v >= 0 && v < 1),
    slickStrength: need(file, p, 'slickStrength', fraction),
    gustVariability: need(file, p, 'gustVariability', (v) => v >= 0 && v < 1),
    filamentStrength: need(file, p, 'filamentStrength', fraction),
    glintFacetSize: need(file, p, 'glintFacetSizeM', positive),
    glintReactive: need(file, p, 'glintReactive', fraction),
    taaReactive: need(file, p, 'taaReactive', fraction),
  };
}

/**
 * The roughness field of a body's sea as brdf_water shades it (fieldModel.ts): a function of the body-fixed unit
 * direction of a sea point and the footprint (m) it is seen with, mean 1. The local Cox-Munk slope variance is
 * coxMunkVariance(windSpeed) x this.
 */
export function oceanRoughnessField(t: OceanTunables): (dirFixed: { x: number; y: number; z: number }, footprint: number) => number {
  const mean = fieldMean(t);
  return (dirFixed, footprint) => fieldAt(dirFixed, t.seaRadius, t.windDir, t, mean, footprint);
}

/** Cox-Munk mean square slope (both axes summed) for a U10 wind speed: 0.003 + 0.00512 U. */
export const coxMunkVariance = (windSpeed: number): number => 0.003 + 0.00512 * windSpeed;

/**
 * GGX alpha per unit Gaussian slope standard deviation. A GGX lobe with alpha = KAPPA x sigma has the same
 * half-maximum width in slope space as the Gaussian (Cox-Munk) slope distribution of mean square slope
 * sigma^2: GGX halves at tan = 0.6436 alpha, the Gaussian at tan = sqrt(ln 2) sigma = 0.8326 sigma.
 */
export const GGX_KAPPA = Math.sqrt(Math.LN2) / Math.sqrt(Math.SQRT2 - 1);
