/**
 * Vessel dynamics package: everything the world orchestrator (src/sim/world) integrates.
 * Call order and semantics are documented in docs/handoff/sim-vessel.md.
 */
export type { HoldKind, MassProps, PartRuntime, PendingAction, SasState, StepContext, StepResult, SurfaceState, Vessel, AeroRuntime, CraftRuntime, DockLink, CommandRuntime, CarriedState, ProbeState } from './types';
export { G_DOSE_LIMIT, STAGE_LOCKOUT } from './types';
export { assembleVessel, vesselPartSnapshots, setModuleStateForLab, splitForStage } from './public';
export { cloneVessel, cloneCraft, createCraft, defaultControlPart, linkRoll, VesselAssemblyError, type CraftIdentity } from './assemble';
export { assemblyId, craftRootInstanceId, eventPartId, findCraftPart, findPartByKey, isAssemblyId, partKey, partKeyOf, seededCraftIds, type CraftIdSource } from './ids';
export { addLink, applyImpulseAt, combinedMomentum, dockBase, dockFace, dockMerge, momentumOf, snapPose, undock, type Momentum } from './dock';
export { mergeVessels, separateVessel } from './split';
export {
  canonicalJson,
  CODEC_VERSION,
  CODEC_VERSIONS_READ,
  contentHash,
  decodeVessel,
  encodeVessel,
  hashBytes,
  libraryResolver,
  partFingerprint,
  readHeader,
  REFS_BY_CONTENT,
  stateHash,
  vehicleHash,
  VesselDecodeError,
  type DecodeOptions,
  type DecodeReport,
  type DefResolver,
  type EncodeOptions,
  type VehicleRef,
  type VehicleRefSource,
} from './codec';
export { dropModule, fitResources, fitSurfaces, insertModule, MigrationRegistry, MIGRATIONS, type PartMigration, type SavedModule, type SavedPart } from './migrations';
export { captureVessel, restoreVessel, type VesselCapture } from './capture';
export { computeMassProps, vesselMass, partMass } from './massProps';
export { structureOf, rebuildStructure, invalidateStructure, vesselBaseY, panelAzimuth, legFootLocal } from './structure';
export type { Structure } from './structure';
export {
  fireNextStage,
  abort,
  anyPending,
  helmCraft,
  nextLiveStage,
  toggleLegs,
  setLegsDeployed,
  legsDeployed,
  setLights,
  setRcsEnabled,
  setFineControl,
  type StagingResult,
} from './staging';
export {
  stagingInfo,
  toVesselSnapshot,
  vesselReadouts,
  nextChuteEnvelope,
  reportedMach,
  radarAltitude,
  needsIntegration,
  vesselStateHash,
  surfaceSituation,
  isControllable,
  type VesselReadouts,
  type WorldSideSnapshotFields,
} from './facade';
export { vesselClearance, vesselClearanceDetail, type ClearanceResult } from './clearance';
export { ispAt, thrustAt, throttleTarget } from './modules/engine';
export { chuteEnvelope, inflationAt } from './modules/parachute';
export { stepVessel, rideBody, holdOnGround } from '../dynamics/integrator';
export { stepVesselReduced, type ReducedStepResult } from '../dynamics/reduced';
export { convectiveFlux, radiativeFlux, stagnationFlux } from '../dynamics/thermal';
export { setSasEnabled, setSasMode, setSasHoldDirection } from '../control/sas';
