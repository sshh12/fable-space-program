Status: resolved (commit 6e0c7a2)
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

## Resolution

Part 1 done (`6e0c7a2`), for `CameraState.kind === 'interior'` only; part 2 declined (below).

`meterExposure`, interior branch: lit pixels more than `INTERIOR_BRIGHT_RATIO` = 16 x the cabin's log-mean
are counted, near AND far (your Earth in the side window is beyond `INTERIOR_RANGE`, so the near histogram
alone would never see it). As their share of the frame grows from 1 % to 8 % (`INTERIOR_BRIGHT_FROM` /
`_FULL`, smoothstep):
- the highlight cap tightens log-linearly from 48 to `INTERIOR_BRIGHT_CAP` = 12 x mid-grey (your formula
  alone would change nothing for a patch 40-64 x the cabin: such a patch is already under the 48 x cap, so
  the bound never binds; the cap has to move),
- the 99th percentile of every lit pixel (not only the near ones) takes part,
- the bound grows from 1.25 to `INTERIOR_BRIGHT_MAX_EV` = 3 EV (your `1.25 + 1.75 x smooth(0.01, 0.08, share)`).
- Not for highlights that blow out whatever the stop-down: when the bright area's median would still stand
  more than `INTERIOR_BRIGHT_HOPELESS_EV` = 3 EV over the cap at the full rule (direct sun on white paint, a
  window 1,000 times the cabin), the extra stop-down fades out, since it would cost the cabin and save
  nothing. Under 1 % of the frame nothing changes; exterior and map views are untouched.

What the frame you asked about shows (unit test `tests/unit/render-core/exposureGovernor.test.ts`, "a 5 %
sun patch 6 EV over the cabin"): cabin 30 cd/m^2 over 95 %, patch 64 x that over 5 %: stopped down 1.88 EV
against the cabin alone; the patch at 235 / 255 (252 at the cabin's own exposure), the cabin at 64 / 255
(125 alone). The seat's view with 8 % day-side Earth (40-180 x the cabin) in the windows: 3.0 EV, cloud tops
+4.8 EV over mid-grey (+7.8 before), land and ocean +2.7, the cabin in the dark tones. The window rule of
cockpit-7 (from 10 % of the frame) works on top as before. RENDER_API section 13 and section 18.

Part 2 (a longer shoulder for interior frames) is declined: the tone curve is one display transform for the
whole frame and every camera (the TAA history, the bloom and every package's calibrated views assume it);
a camera-dependent curve would make the cabin's paints and the Earth through the glass display differently
from the same luminances seen from outside, and AgX already compresses the top stops (the patch above sits
at 235, with hue and texture, once part 1 has brought it there). A local-exposure pass is a bigger design
(halo control, temporal stability) than this close-out can carry; it is noted for the lead.

Re-run: `world-leo-sun-patch-console`, `world-leo-earth-side-window` and your other interior views; the
cabin is darker in frames with a few per cent of bright area, as asked.
