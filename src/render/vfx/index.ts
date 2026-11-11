/**
 * Public API of the vfx package: `createVfxFeature` plus the pure models that labs, tests and the app's
 * diagnostics may use. Everything is driven by the snapshot and by data/defs/visuals/plumes.json.
 */
export { createVfxFeature, VFX_FEATURE_ID, type VfxClusterInfo, type VfxDebug, type VfxFeature, type VfxOptions } from './feature';
export { loadVfxData, validateVfxData, VFX_SECTION, type CanopyStyleDef, type PlumeLookDef, type VfxData } from './data';
export {
  CELL_ETA_MAX,
  CELL_ETA_MIN,
  MIXING_SPREAD,
  SEA_LEVEL_PRESSURE,
  THETA_MAX,
  THETA_MIN,
  engineEmissionState,
  jetBoundaryRadius,
  jetShape,
  machFromPressureRatio,
  plumeLightIntensity,
  prandtlMeyer,
  shockCellSpacing,
  type JetShape,
  type NozzleGeometry,
} from './plumeModel';
export { MAX_CLUSTER_NOZZLES, MAX_RCS_PER_VESSEL, gatherPlumeClusters, type NozzleInstance, type PlumeCluster } from './clusters';
export type { PlumeSlice } from './plumes';
export { plasmaColor, plasmaLuminance, plasmaWindowRadiance } from './plasma';
