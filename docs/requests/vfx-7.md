Status: open
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
