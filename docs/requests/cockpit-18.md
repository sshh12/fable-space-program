Status: open (the rig's half is built in 799354c, 6f2bd6e: the seat's view starts pitched 20 degrees up; the seat itself, option 1, is the lead's vehicle data)
From: cockpit
Owner path: data/defs/vehicles/meridian-lunar.json (`cameras.cockpit.seat`; the lead's vehicle data), or src/camera/cockpitRig.ts (the rig's rest orientation; flight-ui)
Blocking: no (round-3 critique of the cockpit, photo lens, minor: "the player's default seat view is aimed at the console's left end"; the round-5 list: "choose seat and window so the pilot sees out")

## Problem
The player's cockpit view starts in the commander's couch (`cameras.cockpit.seat: "cdr"`), which is the PORT
couch (x = -0.72 m), looking straight along the couch's axis. The console is centred on the capsule's axis, so
that view is centred on the console's left end: 45 % of the frame is blanket and a cue card, one display is cut
by the frame's edge, and the one window in view is a sliver at the top. The cockpit package can re-aim its own
pictures, not the game's camera: the seat is vehicle data and the rest orientation is the camera rig's.

## Evidence
- The game, nothing touched: `out/screens/cockpit/app-leo-seat.png` (spec `tests/browser/cockpit/app.spec.ts`).
- The same cabin from the PILOT'S couch (the centre one), the head tipped back 24 degrees, in the integration
  lab: `out/screens/cockpit/world-leo-pilot-seat.png` (`tests/browser/cockpit/world.ts`, view
  `world-leo-pilot-seat`: a free camera at the commander's eye point moved 0.72 m to the right, looking 2.4 m up
  at 5 m): both forward windows with the Earth in them, the three displays and the caution panel under them.
  The pilot's couch has both hand controllers, like the commander's.

## Requested change
Either of the two, or both:
1. `data/defs/vehicles/meridian-lunar.json`: `"cameras": { "cockpit": { "part": "capsule", "seat": "plt" } }`
   (the centre couch of `visuals/shared/kestrel-mouldline`). Nothing in the cockpit package depends on which
   seat it is: the feature takes the eye from the camera, the lab and the tests read the seat from the vehicle.
2. A rest pitch for the cockpit rig (the couches lie on their backs: the windows are above the line of sight):
   start the seat view about 15 to 24 degrees up from the couch's look direction, so the forward windows stand
   in the upper third of the frame and the displays in the lower half.
What must not change: the seat eye points and look directions of the shared mould line (the cockpit's geometry
tests and the vehicle's openings are built on them).

## Answer on the rig's half (shared-code maintainer, 799354c and 6f2bd6e, 2026-11-12): a rest pitch

Option 2 is built in the cockpit rig (`src/camera/cockpitRig.ts`): the seat's view starts, and comes back
when the view is taken again, pitched 20 degrees up from the couch's look direction
(`COCKPIT_REST_PITCH`, `CockpitRigOptions.restPitch`; 0 gives the view of before). The seat's eye point,
its look direction and the look limits (75 degrees up, 60 down from the couch's axis) are untouched, and so
is the mould line.

Seen in the game, nothing touched (`tests/browser/cockpit/app.spec.ts`, `app-leo-seat`, 2026-11-12 17:14,
`out/screens/cockpit/app-leo-seat.png`; your test passes): the forward window stands in the upper right of
the frame with its well and the flood light instead of a sliver at the top, the FDAI and the first display
are whole in the lower right. What the pitch does not cure is the couch being the port one: the left half
of the frame is still blanket and the checklist card, and the second display is cut by the right edge.
That is option 1 (`cameras.cockpit.seat: "plt"` in `data/defs/vehicles/meridian-lunar.json`), which is the
lead's data; with the centre couch and this pitch the view is your `world-leo-pilot-seat` picture less four
degrees. The request stays open for it.

Unit test: `tests/unit/flight-ui/camera.test.ts`, "starts the seat view at the rest pitch".
