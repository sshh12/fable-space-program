Status: notice
From: core-support (shared-code maintainer), 2026-11-12, commits c9656d7, 32df5d0, 76d4708, 4930cf9 (render core), 6f2bd6e and the commit of 21:40 (camera), d637112 (integration lab), b9347f1
To: every package that takes pictures near the camera, on the pad, from the seat, at twilight, of the Moon or of soot

## What changed, and what it means for your pictures

- **The screen-space contact shadow has rules for the near field** (requests cockpit-10, vehicle-pad-10;
  `src/render/core/lighting/ao.ts`). Within 8 m of the camera a surface point in the receiver's own plane no
  longer shadows it, the place where the march's ray goes behind a surface is found by bisection, an
  occluder counts as two texels of the finest sun cascade thick (1.2 to 2.3 cm) instead of 18 cm and only
  if it touches the receiver, is thin, or is entered through its visible face (the cascade draws the
  shadows of the rest), and the march takes 20 samples. What you will see: no one-bit stipple beside a cast
  shadow at arm's length (it was the contact shadow, not the cascade filter), no dark grain on faces seen at
  a grazing angle, a line beside a thin fitting that stands off a surface instead of a ragged band.
  Beyond 8 m nothing changes. Migration: none. For
  A/B: `contact=first` in a page's address is the pass as it was; `renderer.setContactShadow({...})` switches
  single rules (`ContactShadowParams`, `CONTACT_SHADOW_LEGACY`).
- **The chase view's default on a launch pad** (request vfx-11; `src/camera/chaseRig.ts`): at a pad with a
  flame trench (the structure `pad.flameTrench`), and within 12 km of it, the default azimuth stands 70
  degrees off the trench's axis, clear of the umbilical tower's side, on the side the sun lights better. It
  was the vessel's starboard side (at Ka Lae: from the south, along the trench). Migration: a picture or a
  test that needs a fixed view on the pad sets it (`setOrbit` / `window.__test.setCameraOrbit`), or creates
  the rig with `padView: false`. The player's own yaw, pitch and zoom win as before.
- **The seat's view starts pitched 20 degrees up** (request cockpit-18; `src/camera/cockpitRig.ts`,
  `COCKPIT_REST_PITCH`, `CockpitRigOptions.restPitch`). Migration: a test that expects the couch's own look
  direction creates the rig with `restPitch: 0`; a picture taken from the seat shows the windows higher in
  the frame than before.
- **At twilight the sky counts in the exposure of an exterior view** (request atmosphere-clouds-11;
  `meterExposure`, `twilightSkyWeight`). Inside an atmosphere, once less than 5 % of the sun's light arrives
  directly (over the Earth's ground: the sun under 1.6 degrees, its disc under the horizon, a mountain or the
  Moon in front of it) and until the sun is 12 degrees under the horizon, the frame is also metered with the
  sky's pixels and the two targets are mixed. Migration: none; frames with the sun 2 degrees up and more,
  the night and views from above the air are metered as before, a dusk or dawn picture gets darker ground
  under a sky that is no longer white.
- **`coreOf(ctx).addEmissiveHint(luminance, coverage, true)`** (request cockpit-19): a hint marked for an
  interior view (an emitter the cabin's panes show). Additive; nothing passes it yet.
- **Frost is a coat with a thickness** (request vehicle-pad-11; the mesh G-buffer shader, `standard`
  shading). The weight (instance `frost` x mask a) is a density: a thin coat is a translucent haze, from
  about 0.6 it is opaque rime, cool white and dead matte, and nothing has an edge unless the weight has one.
  The coverage cells (3 cm x 25 cm dashes at in-between weights) and the veil under them are gone.
  Migration: none; weights that were kept out of the in-between range to avoid the dashes can come back.
- **The Moon's night side is black** (found in the core's own suite; the deferred pass). Regolith on an
  airless body took the environment probe as its ambient light wherever it lay; the probe stands at the
  vessel, so with the vessel over the day side the whole night side was lit by the ground under the vessel
  (display level 37 beside the day side's 144 from 20,000 km at a fixed exposure). The probe's share is now
  multiplied by `smoothstep(-0.02, 0.08, sine of the sun's elevation at the pixel)`. What you will see: a
  black night side from orbit and from afar, darker shadows within 4.6 degrees of the terminator.
  Migration: none; views with the sun higher than that over the ground they show are unchanged.
- **Soot is close to neutral** (request vehicle-pad-13; the mesh G-buffer shader, `standard` shading): the
  veil multiplies towards (0.42, 0.38, 0.33) instead of (0.50, 0.38, 0.26), the thick deposit is
  (0.022, 0.021, 0.020) by `0.96 x smoothstep(0.2, 0.85, density)` instead of (0.030, 0.024, 0.019) by
  `0.94 x smoothstep(0.3, 1, density)`. What you will see: grey to black instead of brown, and darker at
  the same weight (half weight: mean 0.43 -> 0.35 of the clean level on the core's panel). Migration: none.
- **The cockpit view sits in the cockpit layout's default seat** (request cockpit-21;
  `src/camera/cockpitRig.ts`): `camera.defaultSeat` of `visuals/cockpits/<id>` (the Kestrel: the pilot's
  centre couch), else the craft's own camera seat; `rig.cycleSeat()` steps to the next couch. It was the
  seat of `VehicleDef.cameras.cockpit` (the commander's). Signatures: `findCockpitSeat(defs, vessel,
  seatId?)` returns `{ part, partDef, seat, seatId, cockpitId }` (no `vehicle` any more);
  `resolveSeatPose(defs, vessel, seatId?)`; `createCockpitRig` returns a `CockpitRig` (`seatId`,
  `cycleSeat`). Migration: a picture or a test that needs a particular couch passes its id to
  `resolveSeatPose` / `findCockpitSeat`, or steps there with `cycleSeat`; the integration lab's
  `sitInCockpit` sits in the same seat as the rig. Unit-tested; not yet run in the browser.
- **The integration lab restarts features at a frame-exact capture** (request atmosphere-clouds-12;
  `labs/integration/main.ts`): its feature guard forwards `resetTemporal`. Before, no feature of any
  package was restarted on the lab's pages. The app's `timedFeature` has the same gap: request core-5.

## Not a default: a switch for A/B pictures
`shadowdebug=1` in a page's address compiles the sun-shadow chunk with three switches
(`renderer.setShadowDebug`: 1 the kernel is not turned per pixel, 2 no dithered cross-fade between
cascades, 8 no cascade shadow at all).

## Resolution
Notice only.
