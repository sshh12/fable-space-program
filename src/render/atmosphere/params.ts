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
  /** Depth of the low layer at full coverage, m. */
  lowThicknessM: number;
  /** Extinction inside low cloud, 1 / m. */
  lowExtinction: number;
  /** Width of the density ramp at a cloud edge, in units of the shape noise. */
  lowEdgeSoftness: number;
  /** Low-layer coverage per unit of map coverage. */
  lowCoverageGain: number;
  /** Coverage of fair-weather cumulus fields where the map is clear (weather-scale noise decides where). */
  fairWeatherCoverage: number;
  /** How strongly the mesoscale noise breaks the map's texels into cells (0..1). */
  mesoscaleAmplitude: number;
  /** Strength of the detail erosion at cloud edges (0..1) and the pixel footprint (m) beyond which it is skipped. */
  detailErosion: number;
  detailFadeFootprintM: number;

  // --- high layer (altostratus / cirrus shield) and the deep column (nimbostratus, cumulonimbus)
  highThicknessMinM: number;
  highThicknessMaxM: number;
  highExtinctionMin: number;
  highExtinctionMax: number;
  /** Map coverage at which the high layer appears / is complete. */
  highCoverageStart: number;
  highCoverageFull: number;
  /** Map coverage at which the column between the layers starts to fill / is solid. */
  deepCoverageStart: number;
  deepCoverageFull: number;
  deepExtinction: number;
  /** Depth of the billows that the shape noise carves into the top of a thick sheet, m. */
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
  /** Pixel footprint (m) at which the resolved cloud shapes have faded into fractional coverage. */

  // --- shadows
  /** Half width of the near shadow map at ground level, m; it grows with the camera altitude by `shadowAltitudeGain`. */
  shadowHalfExtentM: number;
  shadowAltitudeGain: number;
  shadowMapSize: number;
  shadowSteps: number;
  /** Vertical optical depth at coverage 1 for the far (coverage-map) shadow term. */
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
  baseNoiseScaleM: 9000,
  detailNoiseScaleM: 1100,
  mesoscaleScaleM: 40000,
  weatherScaleM: 350000,
  lowThicknessM: 1900,
  lowExtinction: 0.06,
  lowEdgeSoftness: 0.18,
  lowCoverageGain: 0.9,
  fairWeatherCoverage: 0.2,
  mesoscaleAmplitude: 0.8,
  detailErosion: 0.35,
  detailFadeFootprintM: 400,
  highThicknessMinM: 500,
  highThicknessMaxM: 2600,
  highExtinctionMin: 0.0004,
  highExtinctionMax: 0.012,
  highCoverageStart: 0.22,
  highCoverageFull: 0.75,
  deepCoverageStart: 0.72,
  deepCoverageFull: 0.95,
  deepExtinction: 0.045,
  topReliefM: 700,
  phaseG1: 0.8,
  phaseG2: -0.3,
  phaseMix: 0.5,
  sunReachM: 2500,
  multiScatterGain: 0.5,
  diffuseScatter: 0.7,
  diffusionG: 0.85,
  ambientScale: 1,
  groundAlbedo: 0.15,
  stepFactor: 0.012,
  stepMinM: 60,
  stepMaxM: 600,
  shadowHalfExtentM: 30000,
  shadowAltitudeGain: 2.5,
  shadowMapSize: 1024,
  shadowSteps: 16,
  farShadowOpticalDepth: 2,
  coverageDriftMps: 6,
  noiseDriftMps: 8,
  windShear: 0.6,
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
  if (out.shadowMapSize < 64 || out.shadowMapSize > 4096 || (out.shadowMapSize & (out.shadowMapSize - 1)) !== 0) {
    problems.push(`shadowMapSize ${out.shadowMapSize} must be a power of two in 64..4096`);
    out.shadowMapSize = DEFAULTS.shadowMapSize;
  }
  return { params: out, problems };
}
