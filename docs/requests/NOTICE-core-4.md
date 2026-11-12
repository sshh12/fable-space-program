Status: resolved (notice, nothing to answer)
From: core-support
Owner path: src/app (app-integration), src/ui (flight-ui), src/render/cockpit (cockpit), src/render/vfx (vfx), src/render/ocean (ocean), tests/browser/mission (app-integration)
Blocking: no

## Problem
Changes of the shared code in the visual close-out of 2026-11-11 (third maintainer, after NOTICE-core-3) that
change behaviour or pictures in your packages, or give you something to use. Each has a migration line.

## Evidence
`docs/handoff/core-support.md` section 9; RENDER_API sections 13 and 18; the resolutions of the requests named.

## Requested change
- **Chase camera** (`src/camera/chaseRig.ts`, request app-integration-10). Behaviour changed:
  - the reference frame's up is the local vertical in BOTH navball modes (orbit mode: azimuth from the horizontal
    part of the velocity; it was the orbit plane with up perpendicular to the velocity);
  - the elevation is `chaseReferenceElevation(angular radius of the body, fovY)` + the player's pitch: 12 degrees
    near a body as before, rising with the altitude so that the body stays in the frame;
  - in orbit mode the default azimuth is on the sunward side of the vessel and follows the sun until the player
    turns the camera (`rig.autoAzimuth`);
  - the default distance follows the size of what is left of the vehicle (`chaseAutoDistance`), the player's
    zoom is a factor on it;
  - `activate()` keeps the placement the player left (it used to start behind the previous view's direction);
  - a change of body (sphere of influence) swings the camera to the same angles in the new body's frame over 3 s.
  Migration: nothing to change for the default behaviour. To pin the old one:
  `createChaseRig({ defs, terrain, frameBody: false, distanceRadii: Infinity, startBehindPreviousView: true })`.
  New on the rig: `resetView()` (bind it to a key if you like: back to the default framing), `offsets`,
  `autoAzimuth`. `setOrbit(azimuth, elevation, distance)` is unchanged (absolute values; it counts as player
  input). `CHASE_FRAME_BLEND_SECONDS` is deprecated (a navball-mode change no longer moves anything).
  Code that copies the rig's frame (tools/footage/director.js did) must use the local vertical as up.
- **Vessel LOD observers** (`src/camera/listener.ts` `vesselGroundObserver`, request app-integration-7): a vessel
  near a surface is observed at its foot with its footprint radius as `radiusBias` (it was the centre of mass
  with the bounding sphere: 101 m for the stack on the pad). Migration: none for consumers of
  `ViewFrame.observers`; a consumer that used `radiusBias` as "the vessel's size" should use
  `VesselSnapshot.boundingRadius`.
- **Exposure** (RENDER_API 13): a change of `CameraState.kind` is a cut and the exposure follows the target
  within a third of a second (cockpit-14); under the sun the exterior target is held at sunny 16 - 0.5 EV or
  above while sunlit surfaces are in the frame and the sun stands above 10-25 degrees (vfx-7), and what is
  brighter than sunlit white moves it by 0.25 EV at most (vfx-8). `exposureInfo()` gained `sunlitFloor`.
  Migration: none in code; daylight frames of dark ground with a sunlit hull are up to 2.5 EV darker than
  before, daylight frames with flame-lit ground up to 0.25 EV brighter. tests/browser/mission
  (`setViewAndWait`): 45 frames after a view change the cabin is exposed.
- **Audio** (`data/defs/audio/environment.json`, required new fields `aero.bodyGainDb` and `reentry.load`): an
  outside camera that rides with the vessel hears the boundary-layer wind through the structure, and the entry
  roar and rumble follow the hypersonic load as well as the glow. Migration: none (the data is the audio
  package's); a chase view in a fast climb is a few dB louder in the aero bus than before.
- **Terrain** (`TerrainDebug`): `residency(bodyId)`, `setUploadBudget(tiles, ms)`, `stats().lodScale / demand`;
  `StreamStats.stalled / droppedTotal / demandTiles / demandImages / lodScale`. The streamer comes to rest at
  1440p: the app's own recognition of a full pool (`queued === 0 && loading === 0 && uploading > 0`) can go.
  Render core: `CoreShaderLibrary.compilations()`, `MeshSystem.loads()` (app-integration-11).
- **Scenario data**: `data/defs/scenarios/lunar-direct.json` milestones carry `title` (flight-ui-5); the contract
  field is request core-1.

## Resolution
Notice only.
