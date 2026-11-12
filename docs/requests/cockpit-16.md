Status: open
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
