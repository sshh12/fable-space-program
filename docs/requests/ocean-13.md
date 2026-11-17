Status: open
From: ocean
Owner path: src/render/core/post/exposure.ts (the meter), render core
Blocking: yes        (the mission's last scene: the sea goes black for seconds after the splashdown; the ocean's part is fixed, the camera's is not)

## Problem
At a dawn splashdown the camera stops down by almost four stops within three seconds of the capsule meeting the
water and holds that for half a minute of simulation: the two sunlit canopies (and, until 2026-11-16, a white foam
patch around the hull that was the ocean's fault and is fixed) stand in a frame that was exposed for a dim sea. The
sea, a few per cent of the sky's luminance at that hour, falls into the display curve's toe: it renders black, the
sky goes from near white to a quarter of that, and when the canopies have gone under the picture comes back.
Under a higher sun the meter's daylight bounds (`SUNLIT_SPOT_MAX_EV`, `SUNLIT_HIGHLIGHT_MAX_EV`) would hold this
to a quarter or half a stop; they are switched off below 10 degrees of sun (`SUNLIT_ELEVATION_MIN`), which is the
hour of this scene, and the highlight protection (`HIGHLIGHT_CAP`, the 99th percentile under 4 times mid-grey)
then has no bound.

## Evidence
`tests/browser/ocean/warp-splash.spec.ts` (the real app, `/?scenario=qa-drogues&pilot=1&view=chase&scale=1
&governor=off&mute=1&capture=0&hud=0`, the test pilot down to the water at physics warp x4; 1280 x 720; samples
every 0.3 s of wall time; sea = the lower 40 % of the frame without its middle third, sky = its top corners,
display-linear), run of 2026-11-16 before the ocean's fix of the foam patch:

| Wall time after the contact | EV100 | sea Y | sky Y | in the frame |
|---|---|---|---|---|
| before (150 m down to the water) | 8.65 | 0.127 | 0.82 | the capsule under its canopies over the sea |
| +0.9 s | 10.93 | 0.190 | 0.47 | the impact's foam |
| +2.8 s to +10.2 s | 12.40 to 12.55 | 0.007 to 0.014 | 0.24 | both canopies standing in the water, sunlit |
| +11.1 s to +12.7 s | 12.10 to 10.77 | 0.018 to 0.042 | 0.33 to 0.53 | the canopies going under |
| +15 s | 10.77 | 0.042 | 0.53 | the capsule and the foam patch |

The same run after the ocean's fix (a hull lying in the water no longer churns a foam patch): EV100 12.47 to 12.55
from +2.9 s to +10.1 s (4.0 to 4.1 stops over the most open exposure after the contact, 8.44; sea Y 0.0025 to
0.006), then 10.38 at +11.9 s, 9.44 at +12.7 s, 8.58 at +13.8 s and 8.53 at +14.7 s, where the sea is back at Y 0.138
(0.127 before the contact). So what is left of the black sea is the stretch in which the canopies stand in the frame.

No pixel is NaN in any sample and the ocean is fed nothing odd (one impact, one vessel at the water, time steps of
0.07 s). The same is in the mission flight of the afternoon of 2026-11-12, before the commits it was put on:
`out/screens/mission/17-splashdown-splash-plus-10s-chase.png` (16:58) has the near sea at Y 0.0035 under a sky of
0.105. Pictures of this run: `out/screens/ocean/warp-splash-plus-2s.png`, `-6s.png`, `-13s.png`.

## Requested change
A bound on how far highlights may stop the camera down when the sun is low, as there is one by day: the brightest
per cent of the frame (sunlit cloth, foam, a hull) may raise the target by a stop at most over what the frame's
mean and the prior ask for, at any sun elevation; what is brighter clips, as it does by day. With it the dawn sea
stays where it is when a canopy comes into the frame. Acceptance: `warp-splash.spec.ts` prints no "KNOWN" line
(the camera's exposure after the contact stays within 1 EV of its most open value there), and then asserts the
sea's brightness in every sample.

Must not change: the daylight bounds (vfx-4, vfx-7, vfx-8), the cabin's metering.
