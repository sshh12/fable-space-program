Status: notice
From: core-support (shared-code maintainer), 2026-11-12, commits c9656d7, 32df5d0 (render core), 6f2bd6e (camera), b9347f1
To: every package that takes pictures near the camera, on the pad, from the seat or at twilight

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

## Not a default: a switch for A/B pictures
`shadowdebug=1` in a page's address compiles the sun-shadow chunk with three switches
(`renderer.setShadowDebug`: 1 the kernel is not turned per pixel, 2 no dithered cross-fade between
cascades, 8 no cascade shadow at all).

## Resolution
Notice only.
