Status: resolved (commit 9997263)
From: cockpit
Owner path: src/render/core/post/exposure.ts (`meterExposure`, interior branch, the change of request cockpit-5)
Blocking: yes (it corrects cockpit-5, which I specified wrongly in one point; same QA items)

## Problem
Request cockpit-5 (a) asked for a night key from the cabin's absolute level alone. Tried with the change as it
stands in the working tree (thank you): a cabin in DAYLIGHT with small windows is as dim as a cabin at night
(10-20 cd/m^2 against a sky of several thousand), so it gets most of the night key too, and the highlight
term (b) then adds its 1.75 EV on top: about 3 EV under the log-average, and the pad-at-noon view and the
sunlit orbital view lose the whole cabin ("the cabin stays readable when the windows blow out" is the
brief). The level alone cannot tell night from a dim cabin by day; whether the vessel is in sunlight can.

## Evidence
`/labs/cockpit/?scene=pad` and `/labs/cockpit/?scene=leo` with the cockpit-5 change in the tree and the
cockpit's new light transport (probe-based bounce instead of the uniform term, uncommitted in
src/render/cockpit at the time of writing): `out/screens/cockpit/pad-noon-forward-window.png` (2026-11-11,
frame nearly black around two white windows), `leo-sun-patch-console.png` (left two thirds of the frame
below 10/255). `window.__cockpit.debug().exposure` shows the target about 3 EV above `ev100ForMidGrey` of
the near log-mean in both.

## Requested change
In the interior branch of `meterExposure` only:

1. The night key applies in the dark only: scale it by the sun's absence at the camera, which the meter
   already has (`m.sunIlluminance`, `m.sunVisibility`, the inputs of the photometric prior):
   `keyEv = INTERIOR_NIGHT_KEY_EV * (1 - smooth(log2(LOW), log2(HIGH), log2(stats.logMean))) * (1 - clamp(m.sunVisibility, 0, 1))`
   (with `m.sunIlluminance > 0`; no sun at all counts as dark). In the Earth's shadow, or on the pad at
   night, the cabin under its floods is displayed dim; by day it is not.
2. `INTERIOR_HIGHLIGHT_MAX_EV` 1.75 -> 1.25: with (1) gone by day this leaves the sunlit-cabin views about
   1.25 EV under the log-average when a sun patch or a sunlit frame is in view, which is where the cabin
   still reads (an estimate from the two frames named above, where the cabin sits about 3 EV under: half a
   stop more light than 1.75 would leave is what the couches and the far wall need; I will re-shoot and
   report if it is still too dark).

Nothing else changes; the constants stay exported.

## Resolution
Done as asked (commit 9997263), in the interior branch only.

1. `keyEv = INTERIOR_NIGHT_KEY_EV x (1 - smoothstep(log2 4, log2 64, log2 logMean)) x dark`, with
   `dark = 1 - clamp(sunVisibility, 0, 1)` when `sunIlluminance > 0`, and 1 when there is no star at all.
   A cabin at 1.5-6 cd/m^2: the whole 1.5 EV in the Earth's shadow, half of it with half the solar disc
   hidden, none in full sun (displayed at mid-grey level again).
2. `INTERIOR_HIGHLIGHT_MAX_EV` = 1.25.

The constants are exported as before; unit tests in `tests/unit/render-core/exposureGovernor.test.ts`
("a cabin lit by its floods and displays alone, out of the sun, is displayed dim; a daylit one at
mid-grey", "highlights of the cabin weigh in, by a bounded amount"); RENDER_API section 13 and the row of
section 18 say what is in the code. `sunVisibility` is the geometric fraction of the disc that the bodies
leave visible at the camera: it does not know the cabin's own walls or the time of day at a window, so a
cabin on the day side with every window turned away from the sun counts as "by day" (no key), which is
what your request asks for.

Not re-run by me: `tests/browser/cockpit` (your tree).
