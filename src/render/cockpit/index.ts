/**
 * Public API of src/render/cockpit (cockpit package): the capsule interior feature, its controls, the
 * layout registry and the pure model builder. See docs/handoff/cockpit.md.
 */
export { createCockpitFeature, type CockpitFeature, type CockpitFeatureOptions, type CockpitFrameStats } from './feature';
export { createCockpitControls, type CockpitControlsImpl } from './controls';
export { buildCockpitModel, buildCockpitModelFrom, LOD_RANGES, type CockpitModel, type LodName } from './build';
export { cockpitLayouts, loadCockpitLayout, validateLayout, type CockpitLayoutDef, type InstrumentBinding, type ReadoutBinding } from './layout';
export { bindingState, controlStates, digitMask, readoutText, updateMemory, type ControlState, type InstrumentMemory } from './instruments';
export { cabinSources, castCabinRay, glassTransmittance, windowQuad, MAX_CABIN_POLYS, type CabinPoly, type CabinSources } from './lighting';
export { insideDistance, innerOutline, mouldOf, openingsOf, conePointAt, type Mould, type Opening } from './mould';
export { seatFrames, type ControlMeta, type DisplayMeta, type WindowMeta, type SeatFrame } from './cabin/context';
export { MfdDisplays, MFD_FORMAT, type DisplayStats } from './displays';
