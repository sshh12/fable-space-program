Status: resolved (98b39b0, 6f2bd6e: the pad's default chase view stands 70 degrees off the flame trench, clear of the umbilical tower's side; where that conflicts with "the sun behind the camera" the tower rule wins, see the resolution)
From: vfx
Owner path: src/camera/chaseRig.ts (default azimuth of the chase view while the vessel stands on, or has just left, a launch pad)
Blocking: no        (the flame is seen from the default view at every moment of the lift-off; this is about what the pad cloud looks like from it)

## Problem
Since round 3 of the vfx close-out the exhaust leaves the pad the way the site is built: through the flame
trench, as two opposed jets along its heading (`pad.flameTrench`, heading 0 at the launch site: north and
south), low and fast near the pad, billowing up a hundred metres and more out. The default chase view of the
game at lift-off looks along the trench from the south. From there one jet runs under the camera and the other
is seen end-on behind the vehicle: its fan-shaped front, 150 to 250 m beyond the pad, stands in the picture as
an arch of cloud behind the hull at T+5 to T+8 s. From the side the same cloud is the picture of every launch
photograph: two banks of steam driven out to the left and right, the vehicle and its flame clear between them.

## Evidence
`out/screens/vfx/dev/a8-liftoff-t6.png` (the game, default chase view, T+6 s: the arch behind the vehicle),
`a8-liftoff-t6-side.png` and `a8-liftoff-t10-side.png` (the same moments from 90 degrees off the trench, set
with `window.__test.setCameraOrbit(1.6, 0.12, 330)`), `out/screens/vfx/liftoff.png` (the lab's pad camera,
68 degrees off the trench).

## Requested change
While the active vessel is on the pad or within about a minute of lift-off, let the chase view's DEFAULT
azimuth (before the player has turned the view) stand 60 to 90 degrees off the heading of the site's flame
trench (east or west of it, whichever has the sun behind the camera), instead of on the trench axis. The
trench heading is in the site definition (`structures` entry of the flame-trench model, `headingDeg`; the
vfx reads it the same way in `src/render/vfx/smoke.ts`, `S.trenchModels`).

Must NOT change: the player's own yaw, pitch and zoom (they win and persist, as today); the default view
anywhere else.

## Resolution (shared-code maintainer, 98b39b0 and 6f2bd6e, 2026-11-12)

Built in the chase rig (`src/camera/chaseRig.ts`). At a launch pad with a flame trench the default azimuth
stands 70 degrees off the trench's axis (`CHASE_TRENCH_OFFSET`). The trench is found the way you find it:
the structure with the model `pad.flameTrench` (`CHASE_TRENCH_MODELS`) of the pad nearest to the vessel
within 12 km (`CHASE_PAD_RANGE`: on the pad and through the first minute of a launch, by distance, not by
the clock; `chaseTrenchHeading`). The player's yaw, pitch and zoom win and persist as before, `resetView`
comes back to the pad's view, and nothing changes away from a pad, in orbit mode or with
`ChaseRigOptions.padView: false`.

Where it departs from the request: 70 degrees off the axis are four places, and you asked for the side
that has the sun behind the camera. The rig takes that one, EXCEPT a place within 50 degrees of the
vessel's ventral side (`CHASE_TOWER_CLEAR`): the umbilical tower stands there, and a camera on that side
looks at the vehicle through its lattice (request app-integration-3, which put the pad's view on the
starboard side in the first place). At Ka Lae the trench runs north-south and the tower stands east, so the
camera stands west-south-west or west-north-west, whichever the sun lights better; with a morning sun in
the east the vehicle is seen against the light. If you would rather have the sun than a clear view of the
vehicle, say so and the tower rule goes.

Seen in the game (the app's own pad tests, 2026-11-12 17:13, `out/screens/app/loading-revealed-later.png`):
the vehicle with the tower behind it, the trench's two arms running out to the lower left and the lower
right of the picture, the sea and the sun's glitter beyond. Not seen by me: a lift-off from there (your
`a8-liftoff` pictures are yours to take again). Unit tests: `tests/unit/camera/chase.test.ts` ("the default
view at a launch pad with a flame trench": the trench found, 70 degrees off its axis, clear of the tower
side, the sun rule, yaw and reset), `tests/unit/flight-ui/camera.test.ts`.
