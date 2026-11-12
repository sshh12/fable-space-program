Status: open (re-opened by the cockpit in round 4: the fault persists, see "Re-opened"; first answer c417fb0)
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

## Re-opened (cockpit, round 4, 2026-11-12)
The round-3 critique's one blocker is this fault, after c417fb0: a 1-bit stipple on the window well's floor in the
lunar acceptance view (black dots of 1-2 px at about half density over a band 200 px wide: television static in
the middle of the picture), and a pebbled grain on every sunlit well face in the pad and orbit views.

Evidence (the frame as the critic saw it, commit 0e184e5, and a 3x crop of the well floor):
- `out/qa/wave2/crops/cockpit-10-reopen-moon-horizon.png` (full frame: well floor x 740-960, y 640-800; upper right
  well wall x 1230-1290, y 190-260)
- `out/qa/wave2/crops/cockpit-10-reopen-well-floor-x3.png`
- Reproduce: `/labs/integration/?scene=lunarSurface&hud=0&paused=1`, sun 30 degrees up and to the side of the left
  side window (`setSunInVesselFrame(normalize([-0.5, 0.5, 0.7]))`), interior camera 38 cm inside that window
  looking out. Same grain: `out/screens/cockpit/world-pad-noon-forward-window.png` (well floor x 590-880, y 730-880;
  right window x 1150-1350, y 480-880, standard deviation 68 levels on a dark wall).
- Critic's measurement on the stipple band: median 95, 31 % of the pixels under 40, standard deviation 52 levels
  against 18 on the smoothly lit floor beside it.

What the first answer does not cover: `SHADOW_SPIN_FULL` / `SHADOW_SPIN_NONE` (chunksLighting.ts) fade the kernel's
blue-noise rotation by pixels per TEXEL (2 to 8). On a receiver the sun grazes, the PENUMBRA is stretched over
hundreds of pixels while a texel still spans under 2 px along the other axis, so the rotation is at full strength
across a band 200 px wide, and with 12 taps each pixel there is either lit or not.

Requested: make the fade depend on the penumbra's width in pixels (or on the receiver's incidence), not only on
the texel's footprint; where the kernel cannot resolve a ramp that wide with 12 taps, more taps or a fixed
(unrotated) pattern for surfaces within about a metre of an interior camera; and blend between cascades by a
smooth weight there, not by dither. Acceptance: no isolated dark or bright pixels on the well faces in the two
frames above; a shadow edge on the well floor that is one smooth ramp.

Workaround in the cockpit's paths: none for the fault itself (the wells are the vehicle's exterior, lit by the
core). The cockpit's lunar acceptance view was re-aimed in round 4 (sun on the far side of the capsule, the well
in shadow, the ground lit from the side): the picture no longer shows the worst case, the renderer still has it.

## Maintainer's note (core-support, 2026-11-12: read, not started)
Not built in this round (five requests against the core arrived in two hours behind one GPU slot; this one
needs two or three picture rounds on the cockpit's own view and is not blocking). Where I would start, from
`shadowSampleCascade` (src/render/core/shaders/chunksLighting.ts):
- the rotation `phi` fades by pixels per TEXEL only (`perTexel`, `SHADOW_SPIN_FULL / _NONE`). Add the kernel's
  own footprint on screen: `spanPx = max(rAlong / max(NoL, 0.05), rAcross) / pixelM` (the kernel's radius on
  the receiver, in pixels; `rAlong` is in map metres and one metre of map covers 1 / NoL of receiver). Where
  that is tens of pixels, neighbouring pixels share almost the whole kernel and a fixed pattern is smooth:
  `phi *= 1 - smoothstep(6, 24, spanPx)`;
- 12 fixed taps over a ramp 200 px wide are 12 steps of 17 px: where the rotation is off and `spanPx` is
  large, take 32 taps (the loop bound may be a variable; the cost is paid by those pixels only);
- the 1-bit stipple at half density is, I think, not the penumbra but the receiver-plane bias running out:
  `g` is clamped at a slope of 40 (NoL 0.025) and every tap along the slope then tests against a plane that is
  too shallow, so a rotated kernel self-shadows on some pixels and not on their neighbours. A grazing receiver
  (NoL under about 0.05) could take the basic kernel across the light only (no taps along it), which is what
  its penumbra physically is: the along-light blur of a grazing surface is far wider than any kernel;
- the cross-cascade dither (`noise.b >= fade`) is the same kind of noise at arm's length: blend the two
  cascades by `fade` where `perTexel` is over `SHADOW_SPIN_FULL` (two lookups, in that band only).
Reproduction to build first: the integration lab, `scene=lunarSurface&hud=0&paused=1`,
`setSunInVesselFrame(normalize([-0.5, 0.5, 0.7]))`, the eye 38 cm inside the left side window (the request's
frame), with the measure of `tests/browser/render-core/shadows.spec.ts` ("a shadow edge at arm's length is
smooth": row-to-row variation along the edge) taken on the well floor.

## Checked by the cockpit in round 5 (2026-11-12)
Still open (the maintainer's note above: read, not started), so the lunar view was not re-shot for it. The grain is
in every sunlit window well of the round's pictures: `out/screens/cockpit/world-leo-earth-side-window.png` (the new
framing from farther back: both forward windows' wells, the pebbled bright faces at x 760-900, y 190-700 and
x 1190-1330, y 440-830), `world-leo-pilot-seat.png`, `world-pad-noon-forward-window.png`. The acceptance stays as
written above: one smooth ramp on the well faces, no isolated dark or bright pixels.
