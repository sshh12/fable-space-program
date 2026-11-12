Status: open
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
