Status: open
From: cockpit
Owner path: src/render/core/post/exposure.ts (`meterExposure`, interior branch) and src/render/core/post/tonemap.ts (highlight shoulder for interior cameras)
Blocking: no (visual QA wave 2 round 1, cockpit: "sun patch one flat white" and "no frame shows the Earth through a window of a cabin one can see", major in both critics' lists; the cockpit's own light is physical, the range is the core's)

## Problem
An interior camera shows either the cabin or what is outside, never both: a sunlit patch on the console and an
Earth-filled window sit 5 to 7 stops above the cabin, and the interior meter stops down by at most
`INTERIOR_HIGHLIGHT_MAX_EV` (1.25 EV) unless what is seen through the windows fills a tenth of the frame or
more (cockpit-7). Between those two cases everything bright clips to a flat 255 with no texture, hue or
difference between dark and light paint: the sun patch on the console is a white hole that erases MFD 1's page
and its black bezel (`world-leo-sun-patch-console.png`, 5-8 % of the frame clipped), and the Earth through the
side window is a white rectangle while the cabin reads (`world-leo-earth-side-window.png`). Photographs taken
inside (out/qa/ref/cockpit-interiors/aldrin-lm-interior.jpg, apollo7-schirra-inflight.jpg) are overexposed in
the patch and the window too, but keep the texture there and the colour at its edges: the film's shoulder
compresses the top 3-4 stops instead of cutting them.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g "leo-sun-patch|leo-earth"`
(integration lab, `scene=lowOrbit&roll=180`): the spec prints the metered ev100 (about 3) and the critics
measured the patch at a median of 252 / 255 in round 1 (`out/qa/wave2/cockpit.r1.photo.json`, item 8 and the
Earth-window item). The cabin is metered correctly (blankets at mid-grey); the patch is about 40 times the
cabin's luminance, the Earth in the window about 100 times.

## Requested change
For `CameraState.kind === 'interior'` only (exterior and map views must not change):
1. In `meterExposure`, let the highlight bound grow with how much of the near histogram is far above the
   cabin's log-mean: e.g. with `share` = fraction of near samples above 16 x the log-mean,
   `maxEv = INTERIOR_HIGHLIGHT_MAX_EV + 1.75 * smooth(0.01, 0.08, share)` (so a patch of 2-8 % of the frame
   stops the cabin down by up to 3 EV, as a photographer bracketing for it would). Below 1 % nothing changes.
2. A longer shoulder in the tone curve for interior frames (or a local-exposure pass that compresses only
   what is several stops over the frame's key): luminance 4-6 EV over mid-grey should still separate albedo
   0.03 from 0.2 and keep a hue, instead of mapping both to white.
Either part helps on its own; the first is a small change in one function. Please state in the resolution
what an interior frame with a 5 % patch at +6 EV now shows (the patch's and the cabin's display values).
