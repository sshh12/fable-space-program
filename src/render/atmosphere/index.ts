/**
 * Public API of the atmosphere / cloud package. The app shell and labs import from '@/render/atmosphere';
 * other render packages never import it: they consume its output through SharedResources
 * ('atmosphere.*', 'clouds.*') and the render core's chunks.
 */
export { createAtmosphereFeature, type AtmosphereDebug, type AtmosphereFeature, type AtmosphereFeatureOptions, type AtmosphereStatus, type AtmosphereTableName } from './feature';
export { CloudSystem, cloudShadowAxes, type CloudShadowPlacement, type CoverageImage } from './clouds';
export { CLOUD_PARAM_KEYS, resolveCloudParams, type CloudParams } from './params';
export {
  AERIAL_SIZE,
  MULTISCATTER_LUT_SIZE,
  SKY_IRRADIANCE_LUT_SIZE,
  SKY_VIEW_LUT_SIZE,
  TRANSMITTANCE_LUT_SIZE,
  aerialDistanceToSlice,
  aerialSliceToDistance,
  altitudeAt,
  anglesFromSkyViewUv,
  hMuSFromMultiScatterUv,
  multiScatterUvFromHMuS,
  rMuFromTransmittanceUv,
  rMuSFromSkyIrradianceUv,
  skyIrradianceUvFromRMuS,
  skyViewUvFromAngles,
  transmittanceUvFromRMu,
} from './math';
export { luminanceOf, mediumAt, multiScatter, referenceAtmosphere, skyRadiance, transmittanceToTop, type ReferenceAtmosphere } from './reference';
