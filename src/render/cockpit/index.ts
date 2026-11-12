/**
 * Public API of src/render/cockpit (cockpit package): the capsule interior feature, its controls, the
 * layout registry and the pure model builder. See docs/handoff/cockpit.md.
 */
export { ABLATE, createCockpitFeature, type CockpitFeature, type CockpitFeatureOptions, type CockpitFrameStats } from './feature';
export { DisplayPacer, type PacingRule } from './pacing';
export { createCockpitControls, type CockpitControlsImpl } from './controls';
export { buildCockpitModel, buildCockpitModelFrom, displayVertices, meshBvh, meshPositions, LOD_RANGES, type CockpitModel, type LodName } from './build';
export { cockpitDefaultSeat, cockpitLayouts, cockpitSeatIds, loadCockpitLayout, validateLayout, type CockpitLayoutDef, type InstrumentBinding, type ReadoutBinding } from './layout';
export { bindingState, controlStates, digitMask, instrumentSource, readoutText, updateMemory, type ControlState, type InstrumentMemory, type InstrumentSource } from './instruments';
export { cabinSources, castCabinRay, glassTransmittance, windowQuad, MAX_CABIN_POLYS, type CabinPoly, type CabinSources } from './lighting';
export { insideDistance, innerOutline, mouldOf, openingsOf, conePointAt, type Mould, type Opening } from './mould';
export { seatFrames, type ControlMeta, type DisplayMeta, type WindowMeta, type SeatFrame } from './cabin/context';
export { DISPLAY_CPU_BUDGET, MfdDisplays, MFD_FORMAT, type DisplayStats } from './displays';
export { buildBvh, bvhRay, type Bvh, type BvhHit } from './bvh';
export { bakeVertex, occlusionAt, occlusionSources, unpackOcclusion, OCC_STRIDE, type VertexOcclusion } from './occlusion';
export { sunEnters, sunMapLayout, sunTileUniform, type SunMapLayout, type SunTile } from './sunmap';
export { probeDirection, probeFaceMatrix, PROBE_FACES } from './probe';
