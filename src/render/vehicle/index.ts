/**
 * Public API of the vehicle and launch-complex package.
 *
 *   import { createVesselVisualFeature, createSiteFeature } from '@/render/vehicle';
 *
 * docs/handoff/vehicle-pad.md is the manual.
 */
export { createVesselVisualFeature, nozzleEquilibrium, stepNozzleTemp, type VesselVisualFeature, type VesselVisualOptions, type VesselVisualStats } from './vesselFeature';
export { generatePart, generatorIds, hasGenerator, registerGenerator, NEUTRAL_ANIM } from './parts';
export type { GenContext, PartAnim, PartGenerator, PartLight, PartModel, PartVisual, PoseInput, PoseOpts, PoseSink } from './parts';
export { MATERIAL_IDS, materialDef, materialTextureFiles, type MatId } from './materials';
export { DECALS, DECAL_ATLAS_SIZE, decalLayout, decalUv } from './decals';
