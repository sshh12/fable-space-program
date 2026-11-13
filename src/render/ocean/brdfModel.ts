/**
 * The energy terms of brdf_water on the CPU (float64): what the WGSL of shaders/waterBrdf.ts computes for the share
 * of light a water surface mirrors, the share it lets in and out again, what the water column and the bed send
 * back, and the sky the surface mirrors under cloud. The reference of tests/unit/ocean/brdf.test.ts, which also
 * holds the chunk to these formulas (it looks the expressions up in the chunk's source).
 */
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export const WATER_IOR = 1.34;

/** Fresnel reflectance of the water surface at incidence cosine mu (Schlick, F0 0.02): waterFresnel. */
export const waterFresnel = (mu: number): number => 0.02 + 0.98 * (1 - clamp01(mu)) ** 5;

/** Cosine of the refracted (in-water) zenith angle for an above-water cosine mu: waterRefractedCos. */
export const waterRefractedCos = (mu: number): number => Math.sqrt(Math.max(1 - (1 - mu * mu) / (WATER_IOR * WATER_IOR), 0));

/**
 * Mean Fresnel reflectance of the facets a viewer sees (waterMirror().w): at grazing angles their mean incidence
 * cosine does not fall below about 1.12 sigma of the unresolved slopes (sigma = their root mean square).
 */
export function waterMirrorReflectance(noV: number, sigma: number): number {
  const mu = (Math.max(noV, 1e-4) ** 4 + (1.12 * sigma) ** 4) ** 0.25;
  return 0.02 + 0.98 * (1 - clamp01(mu)) ** 5;
}

/** Share of a light along cosine noL that the body term works with for a view along noV (waterBodyDirect's t). */
export const waterBodyTransmission = (noL: number, noV: number): number => ((1 - waterFresnel(noL)) * (1 - waterFresnel(noV))) / 0.9604;

/** The same for the diffuse light of the sky (waterBodyAmbient's t). */
export const waterBodyTransmissionAmbient = (noV: number): number => ((1 - 0.066) * (1 - waterFresnel(noV))) / 0.9604;

/**
 * Above-surface remote-sensing reflectance (1/sr) of one channel (waterRrsOf().total): u = bb / (a + bb), kappa =
 * a + bb (1/m), depth (m), the bed's albedo, the in-water cosines of the light and the view; deepScale = the
 * imagery tint on the deep term (0.25 to 4).
 */
export function waterRrs(u: number, kappa: number, depth: number, bottomAlbedo: number, muW: number, muV: number, deepScale = 1): number {
  const du = 1.03 * Math.sqrt(1 + 2.4 * u);
  const db = 1.04 * Math.sqrt(1 + 5.4 * u);
  const mw = Math.max(muW, 0.05);
  const mv = Math.max(muV, 0.05);
  const tc = Math.exp(-(1 / mw + du / mv) * kappa * depth);
  const tb = Math.exp(-(1 / mw + db / mv) * kappa * depth);
  const rrs = (0.084 + 0.17 * u) * u * deepScale * (1 - tc) + bottomAlbedo * (tb / Math.PI);
  return (0.5 * rrs) / (1 - 1.5 * rrs);
}

/**
 * Illuminance of a horizontal face by the cloud base (waterCloud().rgb, the deferred pass's cloudBase): what the
 * cloud passes on diffusely of a sun of illuminance sunE (after the air) standing at zenith cosine muS, for the
 * shares of cloudLight (beam, and beam plus diffuse).
 */
export const cloudBaseIlluminance = (sunE: number, muS: number, beamShare: number, totalShare: number): number => (muS > 0 && totalShare > beamShare ? sunE * muS * (totalShare - beamShare) : 0);

const luminance = (c: readonly [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The cloud base's light on a horizontal face as the water mirrors it (waterCloudTerms().rgb), linear RGB: as much
 * light as cloudBaseIlluminance (of the sun's rgb illuminance sunE), in the colour of what falls on the cloud, the
 * beam and the clear sky's irradiance skyE together.
 */
export function cloudBaseLight(sunE: readonly [number, number, number], muS: number, beamShare: number, totalShare: number, skyE: readonly [number, number, number]): [number, number, number] {
  const share = totalShare - beamShare;
  if (share <= 0 || muS <= 0) return [0, 0, 0];
  const beam: [number, number, number] = [sunE[0] * muS, sunE[1] * muS, sunE[2] * muS];
  const all: [number, number, number] = [beam[0] + skyE[0], beam[1] + skyE[1], beam[2] + skyE[2]];
  const k = (luminance(beam) * share) / Math.max(luminance(all), 1e-9);
  return [all[0] * k, all[1] * k, all[2] * k];
}

/**
 * The sky a water surface mirrors along a direction of up-component dirUp (waterSkyRadiance): of the published sky
 * the beam share, and the cloud base's own luminance (its illuminance / pi overhead, half of that at the horizon).
 */
export const waterSkyUnderCloud = (publishedSky: number, cloudBase: number, beamShare: number, dirUp: number): number => publishedSky * beamShare + cloudBase * ((0.5 + 0.5 * clamp01(dirUp)) / Math.PI);

/** Radiance a water surface sends to the eye under the sky's diffuse light (brdfWaterAmbient), one channel. */
export function waterAmbientRadiance(o: { mirroredSky: number; skyIrradiance: number; noV: number; sigma: number; rrs: number; foamCoverage: number; foamAlbedo: number }): number {
  const spec = o.mirroredSky * waterMirrorReflectance(o.noV, o.sigma);
  const body = o.rrs * o.skyIrradiance * waterBodyTransmissionAmbient(o.noV);
  const foam = o.skyIrradiance * (o.foamAlbedo / Math.PI);
  return (spec + body) * (1 - o.foamCoverage) + foam * o.foamCoverage;
}
