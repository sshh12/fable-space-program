/** The four FFT cascades of a body and its long-wave normals layer (CPU, deterministic from its tunables). No GPU dependency. */
import type { OceanTunables } from './params';
import { buildCascadeSpectrum, buildLongWaveSpectrum, cascadeBands, type CascadeSpectrum, type SpectrumParams } from './spectrum';
import { swellSlopeVariance } from './swell';

export interface OceanCascadeSet {
  spectra: CascadeSpectrum[];
  /** The long-wave normals layer: the spectrum above the high-pass wavelength less what the swell carries. */
  long: CascadeSpectrum & { gain: number };
  params: SpectrumParams;
}

export function buildCascades(t: OceanTunables): OceanCascadeSet {
  const params: SpectrumParams = {
    windSpeed: t.windSpeed,
    // Chart axes: x = east, y = north; a compass direction theta (clockwise from north) is the angle pi/2 - theta from +x.
    windAngle: Math.PI / 2 - t.windDir,
    fetch: t.fetch,
    gamma: t.jonswapGamma,
    gravity: t.gravity,
    highPassWavelength: t.highPassWavelength,
  };
  const bands = cascadeBands(t.cascadePeriod, t.cascadeDivisors);
  return {
    spectra: bands.map((b, c) => buildCascadeSpectrum(c, b, params, t.seed, t.repeatPeriod)),
    long: buildLongWaveSpectrum(t.cascadePeriod / t.longWaveDivisor, params, t.seed, t.repeatPeriod, swellSlopeVariance(t.swell)),
    params,
  };
}
