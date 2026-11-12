import { describe, expect, it } from 'vitest';
import type { AtmosphereRenderDef } from '@/core/contracts/defs';
import { AIRGLOW_MAX_LAYERS, airglowPeakLuminance, airglowShows, resolveAirglow } from '@/render/atmosphere/airglow';

const base: AtmosphereRenderDef = {
  topAltitude: 100000,
  rayleighScattering: [5.8e-6, 13.5e-6, 33.1e-6],
  rayleighScaleHeight: 8000,
  mieScattering: 2e-5,
  mieAbsorption: 2e-6,
  mieScaleHeight: 1200,
  miePhaseG: 0.8,
  ozoneAbsorption: [0.65e-6, 1.88e-6, 0.085e-6],
  ozoneCenterAltitude: 25000,
  ozoneHalfWidth: 15000,
  groundAlbedo: 0.3,
};

const luminance = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe('airglow layers', () => {
  it('a body without airglow has none', () => {
    expect(resolveAirglow(base)).toEqual({ layers: [], problems: [] });
  });

  it('the emission integrated straight through a layer is its zenith luminance, in its colour', () => {
    const { layers, problems } = resolveAirglow({ ...base, airglow: [{ altitude: 95000, thickness: 9000, zenithLuminance: 8e-5, color: [0.55, 1, 0.25] }] });
    expect(problems).toEqual([]);
    expect(layers).toHaveLength(1);
    const l = layers[0]!;
    expect(l.altitude).toBe(95000);
    // Full width at half maximum -> sigma.
    expect(l.sigma * 2 * Math.sqrt(2 * Math.LN2)).toBeCloseTo(9000, 6);
    // Numerical integral of the Gaussian profile along a vertical path through the layer.
    let sum = 0;
    const dz = 10;
    for (let z = -60000; z <= 60000; z += dz) sum += Math.exp(-0.5 * (z / l.sigma) ** 2) * dz;
    expect(luminance(l.emission) * sum).toBeCloseTo(8e-5, 9);
    expect(l.emission[1] / l.emission[0]).toBeCloseTo(1 / 0.55, 9);
    expect(l.emission[2] / l.emission[0]).toBeCloseTo(0.25 / 0.55, 9);
  });

  it('edge-on a layer is tens of times its zenith luminance; it shows at a night exposure and is left out of a daylight frame', () => {
    const { layers } = resolveAirglow({ ...base, airglow: [{ altitude: 95000, thickness: 9000, zenithLuminance: 8e-5, color: [0.55, 1, 0.25] }] });
    const radius = 6371000;
    const peak = airglowPeakLuminance(layers, radius);
    // Numerical integral along the ray that touches the shell of the peak.
    const l = layers[0]!;
    const r = radius + l.altitude;
    let sum = 0;
    const ds = 500;
    for (let x = -1.5e6; x <= 1.5e6; x += ds) sum += Math.exp(-0.5 * ((Math.hypot(r, x) - r) / l.sigma) ** 2) * ds;
    expect(peak / (luminance(l.emission) * sum)).toBeCloseTo(1, 2);
    expect(peak / 8e-5).toBeGreaterThan(30);
    expect(peak / 8e-5).toBeLessThan(70);
    // Exposure = 1 / (1.2 x 2^EV100) per cd/m^2.
    const exposure = (ev: number): number => 1 / (1.2 * 2 ** ev);
    expect(airglowShows(layers, radius, exposure(-5))).toBe(true);
    expect(airglowShows(layers, radius, exposure(2))).toBe(true);
    expect(airglowShows(layers, radius, exposure(10))).toBe(false);
    expect(airglowShows(layers, radius, exposure(14.6))).toBe(false);
    expect(airglowShows([], radius, exposure(-5))).toBe(false);
  });

  it('malformed layers are reported and left out; at most the first two are drawn', () => {
    const good = { altitude: 95000, thickness: 9000, zenithLuminance: 8e-5, color: [0.5, 1, 0.2] as [number, number, number] };
    const bad = [
      { ...good, thickness: 0 },
      { ...good, zenithLuminance: -1 },
      { ...good, color: [0, 0, 0] as [number, number, number] },
      { ...good, altitude: Number.NaN },
    ];
    const r = resolveAirglow({ ...base, airglow: [...bad, good, good, good] });
    expect(r.problems).toHaveLength(bad.length + 1);
    expect(r.layers).toHaveLength(AIRGLOW_MAX_LAYERS);
  });
});
