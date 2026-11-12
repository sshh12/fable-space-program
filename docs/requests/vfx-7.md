Status: resolved (commit 3e95313)
From: vfx
Owner path: src/render/core/post/exposure.ts (the sunlit bound on the target, `SUNLIT_HIGHLIGHT_MAX_EV`)
Blocking: no

## Problem
By day the exposure still pumps through a lift-off seen from a chase camera. Request vfx-4 bounded the
target from ABOVE while the sun lights the scene (sunny 16 + 0.5 EV), so a bright plume-lit pad can no
longer stop the camera down below the daylight exposure. Nothing bounds it from BELOW: when the lit pad
leaves the frame (the vehicle climbs, the chase camera looks at the vehicle against the sky and the dark
lab ground) the meter opens up by more than a stop within the same sequence, and a photographer's daylight
exposure does not do that. The critics of round 1 measured 1.3 EV between T+6 s and T+10 s and asked for
the frame to stay within about +-0.5 EV of the sunny-16 prior whatever is in it while the sun is up.

## Evidence
`out/qa/wave2/vfx.r1.artifact.json`, finding 3 (major): with the chase camera the sky median is
(56,69,91) at T+0, (55,69,91) at T+3, (55,68,90) at T+6 and (87,102,126) at T+10 s
(`out/screens/vfx/liftoff-chase/t0-day.png` ... `t10-day.png`; lab URL
`/labs/vfx/?scene=pad&dist=150&pitch=4`, lab times 4, 7, 10, 14 s). The pad camera drifts 0.65 EV
(`liftoff/t0-day.png` .. `t10-day.png`, sky 65 to 80). Reference: `out/qa/ref/liftoff-ascent/artemis2-launch-2.jpg`
(daylight lift-off: sky, pad and towers at the daylight exposure, only the steam and the flame clip).

## Requested change
While the sun lights the scene (the same `sunVisibility` gate as `SUNLIT_HIGHLIGHT_MAX_EV`), bound the target
from below as well, at sunny 16 minus about 0.5 EV (a new `SUNLIT_SHADOW_MIN_EV`, or one symmetric band), so
that a daylight exterior frame stays within about +-0.5 EV of the sunny-16 prior whatever the opaque scene
holds. Must NOT change: night, twilight below the gate, eclipse, cabin views (the interior rules), or the
behaviour already given by vfx-4 (histogram before the transparent pass, the upper bound).
Workaround in vfx meanwhile: none needed for correctness; the plume lights now have a source radius
(request vfx-5), which takes the burnt-out spots off the pad near the foot of the jet and with them most of
the bright tail of the histogram, so the swing is smaller, but the far end of the sequence still opens up.

## Resolution
`src/render/core/post/exposure.ts`: the exterior target is now bounded from below as well, at sunny 16 minus
`SUNLIT_SHADOW_MIN_EV` = 0.5 EV, so a daylight frame stays within +-0.5 EV of the prior. It is a little narrower
than "whatever the opaque scene holds", because a camera rightly opens up in three situations that the solar disc
at the camera alone cannot tell from your lift-off, and they would have gone two to three stops too dark:

1. **No sunlit surface in the frame**: an overcast pad (everything at a fifth of the light), the shadow side of a
   hull lit by the planet, the night side under a camera that is itself in the sun. The bound needs pixels at or
   above 0.25 of a white surface square to the sun (`SUNLIT_SURFACE`) on 0.02 % of the frame, and is whole from
   0.2 % (`SUNLIT_EVIDENCE_FROM / _FULL`): about 7,000 pixels at 1440p, the sunlit side of your stack at 150 m.
2. **A low sun**: a lunar landing under an 8 degree sun, dawn at the splashdown. The bound comes in between 10 and
   25 degrees of solar elevation over the ground under the camera (`MeterInput.sunElevationSin`, computed by the
   core for the nearest body; `SUNLIT_ELEVATION_MIN / _FULL`).
3. The same `sunVisibility` gate as the upper bound (0.05 to 0.3 of the disc), and exterior / map views only.

Night, twilight below the gate, eclipse and cabin views are untouched (unit tests hold each of them to the exact
value they had). The upper bound of vfx-4 and the histogram before the transparent pass are unchanged.

What it does to your sequence: the meter alone exposed a frame of dark ground plus a sunlit hull of under 1 % of
the lit pixels for the ground (EV100 12.1 in the unit test's frame, three stops under sunny 16: the highlight cap
only sees a hull above 1 % of the lit pixels, and jumped by 2 EV when it crossed that); with the bound the target
is 14.55 from 0.2 % of the frame on, and rises to it smoothly between 0.02 % and 0.2 %. `exposureInfo()` reports
the bound's weight as `sunlitFloor`. Tests: `tests/unit/render-core/exposureGovernor.test.ts`, "the exposure is
bounded from below as well while the sun lights the scene (request vfx-7)" (5 tests). Docs: RENDER_API section 13
("Daylight does not open up either") and section 18.

To re-run: `/labs/vfx/?scene=pad&dist=150&pitch=4` at lab times 4, 7, 10, 14 s by day; the sky median should stay
within half a stop over the sequence. If the lab's sun stands lower than 25 degrees there, the bound is partial
(nothing under 10 degrees): say so here and the elevation gate can be looked at again with that picture.

