Status: resolved (commit c417fb0)
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

## Resolution

Done (`c417fb0`), in the core's cascade lookup (chunk `shadows`), for every camera, without an interior-only
switch: the cause is not the interior camera but the magnification. The 12-tap kernel is turned per pixel by
blue noise so that its banding becomes noise the TAA averages; where one shadow texel covers many pixels that
noise is coarser than the TAA can hide (your stipple). The turning now fades out between 2 and 8 pixels per
texel (`SHADOW_SPIN_FULL` / `SHADOW_SPIN_NONE`, the finer texel axis against the pixel footprint at the
receiver's distance): beyond that the fixed pattern of bilinear comparisons is smooth and the edge clean.
Receivers seen at fewer than 2 pixels per texel (every exterior view of anything farther than a few metres)
are unchanged, and so is the cost (the same 8 + 12 taps).

Test: `tests/browser/render-core/shadows.spec.ts`, "a shadow edge at arm's length is smooth": 0.35 m from a
shadow edge of the finest cascade (17.8 px per cm, a texel covers about 20 px), deterministic noise and no
jitter, the row-to-row variation along the edge is 0.008 at most per column (0.082 with the old per-pixel
turning: the test fails without the change). Screenshot `out/screens/render-core/shadows-edge-arms-length.png`.
RENDER_API section 8 and section 18.

Re-run: `hatch-mechanism`, `moon-horizon`, `leo-earth-side-window` and the integration lab's
`world-pad-noon-forward-window`.
