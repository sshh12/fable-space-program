/**
 * Energy of the water's shading (brdf_water, CPU reference brdfModel.ts): what a water surface mirrors and what it
 * lets in never add up to more than what arrives, per point and per direction; under a sky of one luminance the
 * water is never brighter than that sky; and under cloud it mirrors the sky that lights it (visual round 3: a sea
 * under an overcast stood at 1.3 to 1.7 times the deck above it). The chunk's source is held to the formulas.
 */
import { describe, expect, it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import {
  cloudBaseIlluminance,
  cloudBaseLight,
  waterAmbientRadiance,
  waterBodyTransmission,
  waterBodyTransmissionAmbient,
  waterFresnel,
  waterMirrorReflectance,
  waterRefractedCos,
  waterRrs,
  waterSkyUnderCloud,
} from '@/render/ocean/brdfModel';
import { coxMunkVariance, oceanTunables } from '@/render/ocean/params';
import { buildWaterBrdfWgsl } from '@/render/ocean/shaders/waterBrdf';

const defs = await loadDefs(fsDefSource());
const earth = Object.values(defs.bodies).find((b) => b.ocean !== null)!;
const t = oceanTunables(earth)!;
/** Per channel: u = bb / (a + bb) and kappa = a + bb of the body's water. */
const optics = [0, 1, 2].map((c) => ({ u: t.backscatter[c]! / (t.absorption[c]! + t.backscatter[c]!), kappa: t.absorption[c]! + t.backscatter[c]! }));
const cosines = Array.from({ length: 41 }, (_, i) => Math.max(i / 40, 1e-3));
const depths = [0, 0.05, 0.3, 1, 3, 10, 30, 100, 1e4];
const albedos = [0, 0.1, 0.3, 0.6, 1];
/** Largest diffuse reflectance (pi Rrs) of the water with its bed, over depths, bed albedos, the tint's range and the three channels. */
function largestBodyReflectance(muW: number, muV: number): number {
  let max = 0;
  for (const o of optics) for (const d of depths) for (const a of albedos) for (const tint of [0.25, 1, 4]) max = Math.max(max, Math.PI * waterRrs(o.u, o.kappa, d, a, muW, muV, tint));
  return max;
}

describe('brdf_water, energy', () => {
  it('a light: the mirrored share and the share let in add up to at most the light', () => {
    for (const noL of cosines) {
      const reflected = waterFresnel(noL);
      expect(reflected).toBeGreaterThanOrEqual(0.02);
      expect(reflected).toBeLessThanOrEqual(1);
      for (const noV of cosines) {
        const transmission = waterBodyTransmission(noL, noV);
        expect(transmission).toBeGreaterThanOrEqual(0);
        // What enters is at most what is not mirrored (the 0.9604 is the two crossings at normal incidence, which Rrs holds).
        expect(transmission * 0.9604).toBeLessThanOrEqual(1 - reflected + 1e-12);
        // And of what enters, the column and the bed send back less than all of it.
        const back = transmission * largestBodyReflectance(waterRefractedCos(noL), waterRefractedCos(noV));
        expect(reflected + back).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the water with its bed returns less than it is given, whatever the depth and the bed', () => {
    for (const muW of [0.67, 0.86, 1]) for (const muV of [0.67, 0.8, 1]) expect(largestBodyReflectance(muW, muV)).toBeLessThan(0.96);
    // Deep water of this body: a few per cent, blue-green.
    const deep = optics.map((o) => Math.PI * waterRrs(o.u, o.kappa, 1e4, 0, 0.86, 1));
    expect(deep[2]!).toBeGreaterThan(deep[0]!);
    expect(Math.max(...deep)).toBeLessThan(0.08);
  });

  it('under a sky of one luminance the water is never brighter than the sky, foam or no foam', () => {
    const L = 1000;
    let worst = 0;
    for (const noV of cosines) {
      for (const sigma of [0, 0.05, Math.sqrt(coxMunkVariance(t.windSpeed)), 0.4]) {
        const mirrored = waterMirrorReflectance(noV, sigma);
        // The facets a viewer sees stand steeper to him than the mean plane: never more mirror than the flat sea.
        expect(mirrored).toBeLessThanOrEqual(waterFresnel(noV) + 1e-12);
        for (const o of optics) {
          for (const d of depths) {
            for (const a of albedos) {
              for (const foam of [0, 0.3, 1]) {
                const out = waterAmbientRadiance({ mirroredSky: L, skyIrradiance: Math.PI * L, noV, sigma, rrs: waterRrs(o.u, o.kappa, d, a, 0.86, waterRefractedCos(noV), 4), foamCoverage: foam, foamAlbedo: t.foamAlbedo });
                worst = Math.max(worst, out / L);
              }
            }
          }
        }
        expect(mirrored + waterBodyTransmissionAmbient(noV) * largestBodyReflectance(0.86, waterRefractedCos(noV))).toBeLessThanOrEqual(1);
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('brdf_water, the sky it mirrors under cloud', () => {
  const sunE = 80000;
  it('clear sky: the published sky, to the bit', () => {
    for (const sky of [0, 3.7, 4212.5, 1e5]) for (const up of [0, 0.3, 1]) expect(waterSkyUnderCloud(sky, cloudBaseIlluminance(sunE, 0.5, 1, 1), 1, up)).toBe(sky);
  });

  it('closed deck: the deck, whatever the published sky holds', () => {
    const base = cloudBaseIlluminance(sunE, 0.5, 0, 0.2);
    expect(base).toBeCloseTo(8000, 6);
    for (const sky of [0, 5000, 1e6]) {
      expect(waterSkyUnderCloud(sky, base, 0, 1)).toBeCloseTo(base / Math.PI, 9);
      expect(waterSkyUnderCloud(sky, base, 0, 0)).toBeCloseTo(0.5 * (base / Math.PI), 9);
    }
    // No sun over the horizon, no cloud base.
    expect(cloudBaseIlluminance(sunE, -0.1, 0, 0.2)).toBe(0);
  });

  it('the cloud base: as much light as the scene is lit with from it, in the colour of what falls on the cloud', () => {
    const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    // A beam reddened by the air on its way to the sea, and the blue sky's irradiance.
    const sun: [number, number, number] = [96000, 80000, 56000];
    const sky: [number, number, number] = [5000, 9000, 19000];
    for (const muS of [0.2, 0.57, 1]) {
      const light = cloudBaseLight(sun, muS, 0.05, 0.3, sky);
      expect(lum(light)).toBeCloseTo(cloudBaseIlluminance(lum(sun), muS, 0.05, 0.3), 6);
      // Nearer to white than the beam alone.
      expect(light[0] / light[2]).toBeLessThan(sun[0] / sun[2]);
      expect(light[0] / light[2]).toBeGreaterThan(sky[0] / sky[2]);
    }
    expect(cloudBaseLight(sun, 0.5, 1, 1, sky)).toEqual([0, 0, 0]);
    expect(cloudBaseLight(sun, -0.1, 0, 0.3, sky)).toEqual([0, 0, 0]);
    // The forward pass's variant takes the terms from the pass and holds no lookup of its own.
    const forward = buildWaterBrdfWgsl([], { fieldFromPass: true });
    expect(forward).toContain('fn waterCloud(s: Surface) -> vec4f { return waterCloudIn; }');
    expect(forward).not.toContain('cloudLight(');
    expect(buildWaterBrdfWgsl([])).toContain('let cl = cloudLight(s.pos, s.bodyIndex, s.up, r, sunDir);');
  });

  it('never more than the clear sky or the brightest deck alone', () => {
    for (const sky of [100, 3000, 20000]) {
      for (const muS of [0.05, 0.3, 1]) {
        for (const total of [0, 0.1, 0.5, 1]) {
          for (const beam of [0, 0.05, 0.5, 1].filter((x) => x <= total)) {
            for (const up of [0, 0.5, 1]) {
              const mirrored = waterSkyUnderCloud(sky, cloudBaseIlluminance(sunE, muS, beam, total), beam, up);
              // (A deck that passed all of the sun on diffusely would have the luminance sunE muS / pi.)
              expect(mirrored).toBeLessThanOrEqual(Math.max(sky, (sunE * muS) / Math.PI) * (1 + 1e-12));
            }
          }
        }
      }
    }
  });

  it('a sea under an overcast is darker than the deck, overhead and at the horizon (the blocker of round 3)', () => {
    const sigma = Math.sqrt(coxMunkVariance(t.windSpeed));
    const base = cloudBaseIlluminance(sunE, 0.5, 0, 0.2);
    const deckOverhead = base / Math.PI;
    const deckAtHorizon = 0.5 * deckOverhead;
    // The deferred pass lights the sea with a third of the clear sky's irradiance and the cloud base: a clear sky of up to three times the cloud base's light.
    for (const clearIrradiance of [0, base, 3 * base]) {
      const irradiance = 0.35 * clearIrradiance + base;
      for (const noV of cosines) {
        // A flat sea mirrors the eye's ray to the same elevation; the published sky may hold anything (not seen under the deck).
        const mirroredSky = waterSkyUnderCloud(1e6, base, 0, noV);
        let out = 0;
        for (const o of optics) out = Math.max(out, waterAmbientRadiance({ mirroredSky, skyIrradiance: irradiance, noV, sigma, rrs: waterRrs(o.u, o.kappa, 1e4, 0, 0.86, waterRefractedCos(noV)), foamCoverage: 0, foamAlbedo: t.foamAlbedo }));
        expect(out).toBeLessThan(0.45 * deckOverhead);
        // Towards the horizon (the eye's ray within 12 degrees of the sea) against the sky just above the horizon.
        if (noV < 0.2) expect(out).toBeLessThan(0.7 * deckAtHorizon);
      }
    }
  });
});

describe('brdf_water, the chunk says the same', () => {
  const wgsl = buildWaterBrdfWgsl([]);
  it.each([
    'fn waterFresnel(mu: f32) -> f32 { return 0.02 + 0.98 * pow5(1.0 - saturate(mu)); }',
    'let mu = sqrt(sqrt(sq(sq(NoV)) + sq(sq(1.12 * sigma))));',
    'let t = (1.0 - waterFresnel(NoL)) * (1.0 - waterFresnel(NoV)) / 0.9604;',
    'let t = (1.0 - 0.066) * (1.0 - waterFresnel(NoV)) / 0.9604;',
    'let rrs = column + bottomAlbedo * (tb / PI);',
    'r.total = 0.5 * rrs / (1.0 - 1.5 * rrs);',
    'let beam = sunE * muS;',
    'return vec4f(whole * (luminance(beam) * share / max(luminance(whole), 1e-9)), cl.x);',
    'return waterCloudTerms(cl, sunE, muS, skyE);',
    'return sky * cl.a + cl.rgb * ((0.5 + 0.5 * saturate(dot(dir, s.up))) / PI);',
    'let spec = waterSkyRadiance(s, m.xyz, alpha) * m.w;',
    'return (spec + body) * (1.0 - c) + foam * c;',
  ])('%s', (line) => {
    expect(wgsl).toContain(line);
  });

  it('the mirror as it was is a debug switch, off in the shipped chunk', () => {
    expect(wgsl).toContain('const WATER_CLOUD_MIRROR = 1.0;');
    expect(buildWaterBrdfWgsl([], { cloudMirror: false })).toContain('const WATER_CLOUD_MIRROR = 0.0;');
  });
});
