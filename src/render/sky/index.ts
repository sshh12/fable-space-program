/**
 * Public API of the sky package (src/render/sky): `createSkyFeature` and the photometric helpers its tests
 * and labs use. docs/handoff/sky-lighting.md documents behaviour and numbers.
 */
export { clipOfDirection, createSkyFeature, type FlareStateInfo, type ImpostorInfo, type SkyFeature, type SkyFeatureOptions, type SkyParts, type SkyStatus } from './feature';
export { FLARE_TOTAL_ENERGY, GHOSTS, STARBURST } from './flare';
export * from './photometry';
export { PROBE_CYCLE, PROBE_MAX_CAMERA_OFFSET, PROBE_MIPS, PROBE_SIZE, type ProbeState } from './probe';
export { bruteForceIrradiance, planetshineWeights, probeSceneOf, projectSh, referenceRadiance, type ProbeBody, type ProbeScene, type ReferenceBody, type ReferenceScene } from './probeScene';
export { decodeRgb9e5, faceFileBytes, faceMipLayout, parseStarCatalogue, validateSkyManifest, type StarCatalogue } from './skyData';
