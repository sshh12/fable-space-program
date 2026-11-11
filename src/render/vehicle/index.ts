/**
 * Public API of the vehicle and launch-complex package.
 *
 *   import { createVesselVisualFeature, createSiteFeature } from '@/render/vehicle';
 *
 * docs/handoff/vehicle-pad.md is the manual.
 */
export { createVesselVisualFeature, nozzleEquilibrium, stepNozzleTemp, type VesselVisualFeature, type VesselVisualOptions, type VesselVisualStats } from './vesselFeature';
export { createSiteFeature, type SiteFeature, type SiteFeatureOptions, type SiteStats } from './siteFeature';
export { generateStructure, registerSiteGenerator, siteGeneratorIds, type SiteGenerator, type SiteState, type SiteVisual } from './site';
export { generatePart, generatorIds, hasGenerator, registerGenerator, NEUTRAL_ANIM } from './parts';
export type { GenContext, PartAnim, PartGenerator, PartLight, PartModel, PartVisual, PoseInput, PoseOpts, PoseSink } from './parts';
export { legPose, type LegPose } from './parts/lander';
export { shieldGlowLuminance } from './parts/capsule';
export { MATERIAL_IDS, materialDef, materialTextureFiles, type MatId } from './materials';
export { DECAL_SECTION, createDecalSheet, decalSheetOf, layoutDecals, type DecalSheet, type DecalSheetDef, type DecalSpec } from './decals';
