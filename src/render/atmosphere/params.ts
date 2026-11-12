/**
 * Tunables of the cloud renderer: the free-form `params` record of CloudRenderDef
 * (data/defs/render/<body>.clouds.json) resolved against defaults, with validation. Pure data.
 */
import type { CloudRenderDef } from '@/core/contracts/defs';

export interface CloudParams {
  /** Shell above the reference radius, m. */
  bottomAltitude: number;
  topAltitude: number;
  /** Name of the coverage map under the tile set's `globals`. */
  coverageMap: string;

  // --- noise scales (tile sizes in metres)
  baseNoiseScaleM: number;
  detailNoiseScaleM: number;
  mesoscaleScaleM: number;
  weatherScaleM: number;

  // --- low layer (cumulus / stratocumulus)
  /** Depth of the low layer at full coverage, m (the map's cloud top can make it up to half as deep again, or shallower). */
  lowThicknessM: number;
  /** Extinction inside low cloud, 1 / m. */
  lowExtinction: number;
  /** Width of the density ramp at a cloud edge, in units of the shape noise (the upper body's is two and a half times wider). */
  lowEdgeSoftness: number;
  /** Low-layer coverage per unit of map coverage. */
  lowCoverageGain: number;
  /** Coverage of fair-weather cumulus fields where the map is clear (weather-scale noise decides where). */
  fairWeatherCoverage: number;
  /** How strongly the mesoscale noise breaks the map's texels into cells (0..1). */
  mesoscaleAmplitude: number;
  /**
   * Strength of the detail erosion (how far it lowers the shape noise's excess over the threshold: deep
   * enough to open holes) and the pixel footprint (m) beyond which it is skipped.
   */
  detailErosion: number;
  detailFadeFootprintM: number;
  /** Extinction of the thinnest cloud the map shows, as a share of `lowExtinction` (the map's coverage is an opacity too). */
  lowThinDensity: number;
  /** Mesoscale variation of the low layer's extinction, in octaves either way (0 = uniform decks). */
  lowDensityVariation: number;

  // --- upper body (altostratus, anvils) and where it reaches down to the low layer (nimbostratus, cumulonimbus)
  highThicknessMinM: number;
  highThicknessMaxM: number;
  highExtinctionMin: number;
  highExtinctionMax: number;
  /** Map coverage at which the upper body appears / is complete (only where the map's cloud top leaves room above the low layer). */
  highCoverageStart: number;
  highCoverageFull: number;
  /** Map coverage at which the upper body starts to reach down to the low layer / does. */
  deepCoverageStart: number;
  deepCoverageFull: number;
  deepExtinction: number;
  /** Depth of the relief of the upper body's top, m (0.6 to 1.6 times this, growing with depth). */
  topReliefM: number;

  // --- lighting
  phaseG1: number;
  phaseG2: number;
  phaseMix: number;
  /** Reach of the cone samples towards the sun, m. */
  sunReachM: number;
  /** Gain of each further multi-scattering octave (Wrenninge a = b = c). */
  multiScatterGain: number;
  /** Strength of the diffuse field inside thick cloud (the high scattering orders), and the asymmetry g of real cloud droplets that sets how fast it decays with optical depth (two-stream). */
  diffuseScatter: number;
  diffusionG: number;
  /** Scale of the sky / ground ambient term. */
  ambientScale: number;
  /** Albedo of the ground for the light bounced into cloud bases. */
  groundAlbedo: number;

  // --- march
  /** Primary step = distance x stepFactor, clamped to [stepMinM, stepMaxM] (and never shorter than the shell path / budget). */
  stepFactor: number;
  stepMinM: number;
  stepMaxM: number;
  // --- shadows
  /** Half width of the near shadow map at ground level, m; from above the layer it grows by `shadowAltitudeGain` per metre of distance to the point of the cloud base the camera looks at (the map's centre). */
  shadowHalfExtentM: number;
  shadowAltitudeGain: number;
  shadowMapSize: number;
  /** Density steps along a line of the shadow map with the sun overhead (up to three times as many as it gets low). */
  shadowSteps: number;
  /** Optical depth at coverage 1 of the far (coverage-map) shadow term AS THE GROUND SEES IT (beam and diffuse light together). */
  farShadowOpticalDepth: number;

  // --- motion (sim time)
  /** Eastward drift of the coverage map and of the noise relative to it, m/s at the equator. */
  coverageDriftMps: number;
  noiseDriftMps: number;
  /** Shear of the noise with altitude (m of drift per m of altitude) and vertical evolution speed of the detail, m/s. */
  windShear: number;
  detailRiseMps: number;
  /** Clouds advance at most this many times faster than real time (time warp). */
  maxTimeRate: number;
}

const DEFAULTS: Omit<CloudParams, 'bottomAltitude' | 'topAltitude' | 'coverageMap'> = {
  baseNoiseScaleM: 5200,
  detailNoiseScaleM: 760,
  mesoscaleScaleM: 46000,
  weatherScaleM: 350000,
  lowThicknessM: 1900,
  lowExtinction: 0.07,
  lowEdgeSoftness: 0.05,
  lowCoverageGain: 1,
  fairWeatherCoverage: 0.2,
  mesoscaleAmplitude: 0.3,
  detailErosion: 0.3,
  detailFadeFootprintM: 400,
  lowThinDensity: 0.2,
  lowDensityVariation: 1,
  highThicknessMinM: 600,
  highThicknessMaxM: 2600,
  highExtinctionMin: 0.0015,
  highExtinctionMax: 0.012,
  highCoverageStart: 0.45,
  highCoverageFull: 0.9,
  deepCoverageStart: 0.72,
  deepCoverageFull: 0.95,
  deepExtinction: 0.02,
  topReliefM: 600,
  phaseG1: 0.8,
  phaseG2: -0.3,
  phaseMix: 0.5,
  sunReachM: 2000,
  multiScatterGain: 0.5,
  diffuseScatter: 0.9,
  diffusionG: 0.85,
  ambientScale: 1,
  groundAlbedo: 0.1,
  stepFactor: 0.012,
  stepMinM: 40,
  stepMaxM: 600,
  shadowHalfExtentM: 30000,
  shadowAltitudeGain: 0.75,
  shadowMapSize: 1024,
  shadowSteps: 16,
  farShadowOpticalDepth: 2,
  coverageDriftMps: 6,
  noiseDriftMps: 8,
  windShear: 0.12,
  detailRiseMps: 1.5,
  maxTimeRate: 4,
};

export const CLOUD_PARAM_KEYS = Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[];

/** Resolve a CloudRenderDef; unknown keys and non-finite or negative values are reported in `problems`. */
export function resolveCloudParams(def: CloudRenderDef): { params: CloudParams; problems: string[] } {
  const problems: string[] = [];
  const out: CloudParams = { ...DEFAULTS, bottomAltitude: def.bottomAltitude, topAltitude: def.topAltitude, coverageMap: def.coverageMap };
  const signed = new Set<string>(['phaseG2', 'coverageDriftMps', 'noiseDriftMps', 'windShear', 'detailRiseMps']);
  for (const [key, value] of Object.entries(def.params ?? {})) {
    if (!(key in DEFAULTS)) {
      problems.push(`unknown cloud parameter "${key}"`);
      continue;
    }
    if (!Number.isFinite(value) || (value < 0 && !signed.has(key))) {
      problems.push(`cloud parameter "${key}" = ${value} is not a valid number`);
      continue;
    }
    (out as unknown as Record<string, number>)[key] = value;
  }
  if (!(out.topAltitude > out.bottomAltitude) || out.bottomAltitude < 0) problems.push(`cloud shell ${out.bottomAltitude}..${out.topAltitude} m is empty`);
  // Ranges outside which the model stops meaning anything (a threshold that never lets go, a sheet thicker
  // than the shell, steps that cannot fit their budget): reported, and the default is used.
  const range = (key: keyof typeof DEFAULTS, lo: number, hi: number): void => {
    const v = out[key];
    if (v < lo || v > hi) {
      problems.push(`cloud parameter "${key}" = ${v} is outside ${lo}..${hi}`);
      (out as unknown as Record<string, number>)[key] = DEFAULTS[key];
    }
  };
  range('lowEdgeSoftness', 0.01, 1);
  range('detailErosion', 0, 0.6);
  range('lowCoverageGain', 0, 2);
  range('fairWeatherCoverage', 0, 1);
  range('mesoscaleAmplitude', 0, 1);
  range('lowThinDensity', 0.01, 1);
  range('lowDensityVariation', 0, 3);
  range('lowExtinction', 1e-5, 1);
  range('deepExtinction', 1e-5, 1);
  range('highExtinctionMin', 1e-6, 1);
  range('highExtinctionMax', out.highExtinctionMin, 1);
  range('phaseG1', 0, 0.98);
  range('phaseG2', -0.98, 0);
  range('phaseMix', 0, 1);
  range('multiScatterGain', 0, 1);
  range('diffusionG', 0, 0.99);
  range('stepFactor', 0.001, 0.2);
  range('stepMinM', 5, 2000);
  range('stepMaxM', out.stepMinM, 20000);
  range('shadowSteps', 4, 64);
  range('maxTimeRate', 0, 1000);
  const depth = out.topAltitude - out.bottomAltitude;
  range('lowThicknessM', 100, depth);
  range('highThicknessMinM', 50, depth);
  range('highThicknessMaxM', out.highThicknessMinM, depth);
  range('topReliefM', 0, out.highThicknessMaxM);
  for (const scale of ['baseNoiseScaleM', 'detailNoiseScaleM', 'mesoscaleScaleM', 'weatherScaleM', 'sunReachM', 'shadowHalfExtentM', 'detailFadeFootprintM'] as const) range(scale, 1, 1e8);
  if (out.shadowMapSize < 64 || out.shadowMapSize > 4096 || (out.shadowMapSize & (out.shadowMapSize - 1)) !== 0) {
    problems.push(`shadowMapSize ${out.shadowMapSize} must be a power of two in 64..4096`);
    out.shadowMapSize = DEFAULTS.shadowMapSize;
  }
  return { params: out, problems };
}
