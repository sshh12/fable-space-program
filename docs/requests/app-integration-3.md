Status: resolved
From: app-integration-v1
Owner path: src/camera/chaseRig.ts (flight-ui code, shared-code maintainer)
Blocking: no

## Problem
The first picture of the game hides the rocket behind the launch tower. On the pad the chase rig starts "facing
the ventral side" (`init`, the branch for a vertical nose: the eye on the -Z side of the vessel, 12 deg up,
140 m away). At Ka Lae LC-1 the vehicle's ventral side faces `padAzimuthDeg` 90 (east), and the umbilical tower
stands 27 m east of the vehicle (`data/defs/sites/ka-lae-lc1.structures.json`, `pad.umbilicalTower` at
`offsetEnu [27, 0, 0]`), so the camera looks at the vehicle straight through the tower's lattice: only a strip of
the stack shows between the girders. Every player sees this frame first, and again whenever a rig activates
without a previous camera on the pad.

## Evidence
`out/screens/app/pad-chase.png` (the app at `/?capture=0`, 1280 x 720, `tests/browser/app/app.spec.ts` "boots on
the pad"): tower in the centre of the frame, the vehicle behind it.

## Requested change
On a surface (vessel `prelaunch` or `landed` at a launch site), start the chase camera with a clear line of sight
to the vehicle: e.g. offset the default azimuth by 90 deg from the ventral direction (the tower then stands beside
the stack), or test the line from the eye to the vessel's centre of mass against the site's structures if the
rig is given them. The app could call `setOrbit()` itself, but the rule belongs with the rig's other defaults
(it applies to every rig activation without a previous camera, not only to the app's first frame). Must not
change: the behaviour in flight (behind the nose, frame blend between surface and orbit references) and the
continuity of a switch from another view (`from` given).

## Resolution (flight-ui, round 5)
`src/camera/chaseRig.ts` `init`: a vertical vessel standing on a surface (`situation` `prelaunch` or `landed`)
is first seen from its starboard side (VES +X), 90 deg from the ventral direction, so a launch site's umbilical
tower off the ventral side stands beside the stack instead of between the camera and the vehicle. Unchanged: in
flight a vertical vessel is still seen facing its ventral side and any other attitude from behind the nose (and
the surface / orbit frame blend), and a switch from another view (`from` given) still starts behind the previous
view direction. Unit tests: `tests/unit/flight-ui/camera.test.ts` "chase rig on a surface (request
app-integration-3)" (pad: the eye along +X at the 12 deg elevation, nothing toward ventral; ascent: ventral as
before). The app needs no change; a later `setOrbit()` still overrides the default.