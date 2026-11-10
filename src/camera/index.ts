/**
 * Public API of src/camera (flight-ui package): cockpit / chase / map rigs, the view manager with blended
 * switching, LOD observers, the audio listener and the InputFrame -> CameraInput mapper.
 * See docs/handoff/flight-ui.md.
 */
export { activeVessel, lookRotation, smoothBlend, vesselComRoot, viewForward, viewUp, type FlightCameraRig } from './cameraMath';
export { createCockpitRig, findCockpitSeat, resolveSeatPose, type CockpitRigOptions, type SeatPose } from './cockpitRig';
export { CHASE_FRAME_BLEND_SECONDS, chaseDistanceLimits, chaseReferenceFrame, createChaseRig, type ChaseRigOptions } from './chaseRig';
export { createMapRig, MAP_FILL_LIGHT, MAP_FOCUS_SECONDS, MAP_MAX_DISTANCE, MAP_MIN_DISTANCE, MAP_MIN_EV100, type MapFocus, type MapRigOptions } from './mapRig';
export { createViewManager, VIEW_BLEND_SECONDS, type ViewFrame, type ViewManager, type ViewManagerOptions } from './viewManager';
export { buildAudioListener, buildLodObservers, OBSERVER_SURFACE_DISTANCE, pressureAtCamera } from './listener';
export { createCameraInputMapper, type CameraInputContext, type CameraInputMapper, type CameraInputMapperOptions } from './cameraInput';
