/** The four FFT cascades of a body (CPU, deterministic from its tunables). No GPU dependency. */
import type { OceanTunables } from './params';
import { buildCascadeSpectrum, cascadeBands, type CascadeSpectrum, type SpectrumParams } from './spectrum';

export interface OceanCascadeSet {
  spectra: CascadeSpectrum[];
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
  return { spectra: bands.map((b, c) => buildCascadeSpectrum(c, b, params, t.seed, t.repeatPeriod)), params };
}
