/**
 * Public API of src/camera (flight-ui package): cockpit / chase / map rigs, the view manager with blended
 * switching, LOD observers, the audio listener and the InputFrame -> CameraInput mapper.
 * See docs/handoff/flight-ui.md.
 */
export { activeVessel, lookRotation, smoothBlend, vesselComRoot, viewForward, viewUp, type FlightCameraRig } from './cameraMath';
export { createCockpitRig, findCockpitSeat, resolveSeatPose, type CockpitRigOptions, type SeatPose } from './cockpitRig';
export {
  CHASE_AUTO_SECONDS,
  CHASE_BODY_BLEND_SECONDS,
  CHASE_DISTANCE_PER_RADIUS,
  CHASE_FRAME_BLEND_SECONDS,
  CHASE_SUN_OFFSET,
  chaseAutoDistance,
  chaseDistanceLimits,
  chaseReferenceElevation,
  chaseReferenceFrame,
  createChaseRig,
  vesselRadiusAboutCom,
  type ChaseRig,
  type ChaseRigOptions,
} from './chaseRig';
export { createMapRig, MAP_FILL_LIGHT, MAP_FOCUS_SECONDS, MAP_MAX_DISTANCE, MAP_MIN_DISTANCE, MAP_MIN_EV100, type MapFocus, type MapRigOptions } from './mapRig';
export { createViewManager, VIEW_BLEND_SECONDS, type ViewFrame, type ViewManager, type ViewManagerOptions } from './viewManager';
export { buildAudioListener, buildLodObservers, OBSERVER_FOOTPRINT_MARGIN, OBSERVER_SURFACE_DISTANCE, pressureAtCamera, vesselGroundObserver } from './listener';
export { createCameraInputMapper, type CameraInputContext, type CameraInputMapper, type CameraInputMapperOptions } from './cameraInput';
