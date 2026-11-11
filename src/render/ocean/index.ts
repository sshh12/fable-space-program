/**
 * Public API of the ocean package (docs/handoff/ocean.md): the render feature, its tunables and the CPU
 * helpers the hand-off documents.
 */
export { createOceanFeature, OCEAN_FEATURE_ID, type OceanDebug, type OceanFeature, type OceanSurfaceSample } from './oceanFeature';
export { coxMunkVariance, GGX_KAPPA, oceanTunables, type OceanTunables } from './params';
export { nearFieldValue, packNearField, type OceanNearFieldValue } from './nearField';
export { physicsWaterHeight } from './vessels';
