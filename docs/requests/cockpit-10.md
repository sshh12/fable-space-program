Status: open
From: cockpit
Owner path: src/render/core (sun shadow filter of the vessel-anchored cascade for receivers close to an interior camera); the receiver is the vehicle package's window well
Blocking: no (visual QA wave 2, cockpit item 15, major: the cockpit cannot fix it inside its own paths)

## Problem
The walls of a window's well (the cut through the hull between the outer mould line and the cabin's inner
wall) are the exterior's geometry, lit by the deferred pass with the core's sun cascades. Seen through the
cockpit's glass from 0.2-0.5 m, where the sun grazes them, the rotated-noise PCF of the cascade shows as a
coarse stipple (worm-like salt and pepper of 2-3 px), framing every window view. The cockpit took its own
surfaces off the cascades for the same reason (request cockpit-4: its own sun map and an analytic window
aperture); it cannot take over the well: a cockpit-drawn liner through the wall would put interior vertices
outside "the mould line minus the wall thickness", which the cockpit's brief forbids and its geometry test
asserts (tried in this round and removed).

## Evidence
`out/screens/cockpit/hatch-mechanism.png` (the hatch window's well, sunlit part, about x 830-940, y 530-600 in
the round-0 frame; the same in the current one), `moon-horizon.png` and `leo-earth-side-window.png` of the
cockpit lab (`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/views.spec.ts --project=functional -g "hatch-mechanism|moon"`),
whose stand-in hull uses the plain standard material through the core mesh system; QA list
`out/qa/wave2/cockpit.md` item 15 (both critics). In the integration lab the vehicle's real well shows it
wherever the sun reaches it (`out/screens/cockpit/world-pad-noon-forward-window.png`, the panes' left edge).

## Requested change
A noise-free filter for sun-shadow receivers within about 1 m of an INTERIOR camera (the vessel-anchored
6 m cascade): for example a fixed (unrotated) tap pattern or a larger bilinear PCF kernel when
`CameraState.kind === 'interior'` and the receiver's view distance is under a metre, so that a grazing-lit
wall at arm's length is smooth with a clean shadow edge. Must not change: the look or the cost of the
cascades for exterior cameras and for receivers beyond that distance.
