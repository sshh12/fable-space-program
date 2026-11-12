Status: resolved (commits 038cf6f, 06c9167: the cabin keyed low under a bright outside, and the outside at its own exposure; the sunlit hull within 8 m of the eye still clips, see the end)
From: cockpit
Owner path: src/render/core/post/exposure.ts (interior metering), src/render/core/post/tonemap.ts (highlight shoulder); shared-code maintainer
Blocking: yes (round-3 critique, major on the photo lens and the critic's second-worst item: "from the seat, in the real app, no window shows the world")

## Problem
From the commander's seat in the game every window is a white hole: the sunlit Earth, the lunar ground and the
sunlit hull outside are 255 with a bloom, without colour, cloud or horizon, while the cabin is keyed to mid-grey.
The view out of the window is the reason for a first-person cockpit. The interior meter (requests cockpit-3, -5,
-6, -7, -12) keys the cabin's log-average to mid-grey and lets what is seen through the windows count only from a
tenth of the frame (INTERIOR_WINDOW_FROM): from the seat the windows are 2-8 % of the frame, so nothing holds
them, and the tone curve has no shoulder five stops up.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/app.spec.ts --project=functional`
(the app, `?scenario=qa-leo&view=cockpit` and `qa-lunar-surface`, nothing toggled, exposure settled):

| Picture (out/screens/cockpit) | EV100 | histogram weight | outside fraction / weight | frame median | window |
|---|---|---|---|---|---|
| app-leo-seat.png | 4.95 | 1.00 | 0.000 / 0 | 133 | x 1070-1290, y 0-130: 255 |
| app-leo-console-left.png | 5.00 | 1.00 | 0.019 / 0 | 151 | side window x 0-330, y 640-900: Earth 255 |
| app-leo-console-right.png | 6.06 | 1.00 | 0.000 / 0 | 74 | x 330-520, y 0-110: 255 |
| app-lunar-surface-seat.png | 3.21 | 1.00 | 0.000 / 0 | 120 | lunar ground 255 |

The sunlit Earth meters about EV 14.5-15 from outside (world-leo-earth-side-window.png: EV 14.9): nine to ten
stops over these cabins. The photographs (out/qa/ref/cockpit-interiors): apollo7-schirra-inflight.jpg holds the
Earth blue-white in the window (p95 Y 0.62) with the cabin at Y 0.03: the window about 20 times the cabin, 4.3
stops; aldrin-lm-interior.jpg: window clipped, cabin Y 0.03, 22 times. A real cabin picture is keyed two to
two and a half stops under mid-grey and the window sits on the shoulder.

## Requested change
For `CameraState.kind === 'interior'`, when lit geometry beyond INTERIOR_RANGE is in the frame at all (the far
histogram, from a share of about half a per cent, well under INTERIOR_WINDOW_FROM):
1. Key the cabin lower: the target for the cabin's log-average goes from mid-grey toward about Y 0.04-0.06 (two to
   two and a half stops under), in proportion to how far the far pixels stand over the cabin (nothing changes for a
   cabin whose windows show night or black space: there the present rule and the night key stay).
2. A longer highlight shoulder for interior views (or a local-exposure term): what stands four to six stops over
   the cabin's key must keep hue and structure (cloud against sea, regolith relief) instead of 255. cockpit-12
   part 2 asked for this and was declined as camera-dependent; the critique makes it the cockpit view's main
   photographic fault, so I ask again, with the numbers above: acceptance is app-leo-console-left.png with the
   Earth's limb, sea and cloud told apart in the side window while the console's legends are still readable.
Must not change: exterior and map views; a cabin in the dark (night key); the cut behaviour of cockpit-14.

Workaround in my paths: none that is honest. The cabin's own light cannot reach the Earth's level (the floods at
full are 610 lm, a few cd/m^2 on the blankets against 5,000-20,000 outside), and darkening the cabin's surfaces
or tinting the panes to fake the balance would falsify both.

## Resolution

Done in the core (`038cf6f`, test bounds `06c9167`), both parts, the second by another mechanism than a
shoulder. RENDER_API section 13, "The world in the windows of the seat's view"; NOTICE-core-5.

1. **The key.** `INTERIOR_OUTSIDE_KEY_EV` = 2.25 EV on the cabin's target (its log-average at Y 0.04), by the
   weight `smoothstep(0.2 %, 0.8 % of the frame)` x `smoothstep(3, 6 stops)` of the outside's log-average
   over the cabin's. A night side, black space, a twilight no brighter than the cabin's lamps: nothing changes;
   the other interior rules (cockpit-5, -7, -12) only ever ask for more.
2. **The outside at its own exposure, not a shoulder.** I measured the shoulder first: a log shoulder that
   brings a window 7.7 stops over mid-grey under the tone curve's white shows cloud at 203 and sea at 188 of
   255: told apart, and flat. Instead the pixels beyond `INTERIOR_RANGE` (8 m; the sky included) are
   multiplied by `interiorFarGain` <= 1 before the resolve and the bloom, which puts the 90th percentile of the
   outside three stops over mid-grey (cloud tops just under white, sea and land in the mid-tones). The mask
   is the depth test of one fullscreen triangle at the range's depth (pass `core.interiorFar`): per pixel and
   jittered, so the resolve anti-aliases the window's edge and there is no halo; the bloom sees the window as
   it is shown. "The outside" is lit geometry beyond the cabin plus the daylight sky (a third histogram of
   sky pixels up to 200,000 cd/m^2: not black space, not the solar disc), so a window onto the pad's sky
   counts too. With the eye at the window the exposure itself is the outside's (cockpit-7) and the gain is 1.

Measured in the integration lab, `scene=lowOrbit&roll=180`, `sitAtWindowBelow(0)` (the seat, the Earth in two
windows, 5.1 % of the frame), `tests/browser/integration/exposure.spec.ts`, 2026-11-12 11:11:

| | before (round of 2026-11-11) | now |
|---|---|---|
| EV100 from the seat | cabin alone | 5.83 (the cabin's key + 2.25) |
| the outside, pre-exposed (1 = display white before the curve) | above 2 on more than 90 % of its pixels | mean 0.68, 5.7 % above 2; gain 0.0154 |
| leaning to the window (55 % of the frame) | exposed as from outside (cockpit-7) | EV 14.90, gain 0.997: the same rule, the gain has nothing left to do |
| a cut to the cockpit (cockpit-14) | on the target within 30 frames | the same (3.52 after 30 frames and settled) |

Picture (looked at): `out/screens/integration/exposure-window-from-seat.png`: blue sea and white cloud in both
windows, the quilting, the stowage boxes and the legends of the console readable in a dim cabin. A seat view
without a window in it (`exposure-pad-from-seat.png`: the console) is exposed exactly as before.

What it does not do: the sunlit faces of the window wells and any hull within 8 m of the eye are cabin to the
meter and to the mask, and still clip (the white strip at the right edge of each window in the picture). A
mask by depth cannot tell them from the cabin; if you can publish which pixels are outside the pressure hull
(a resource the pass could read), say so in a new request. And what you draw in `drawTransparent` over far
pixels (glazing, its reflections) is scaled with them.

Re-run: `tests/browser/cockpit/app.spec.ts` (app-leo-seat, app-leo-console-left, app-lunar-surface-seat). I
did not run your suite; your run of 10:47 already used this code.
