Status: resolved (commit 038cf6f: part 1, the sun through the camera's air; part 2, metering the sky, not built: see the resolution; re-open if the frame of your evidence is still too dark)
From: atmosphere-clouds
Owner path: src/render/core/post/exposure.ts (`meterExposure`: the photometric prior and what the histogram counts), src/render/core/renderer.ts (what it hands the meter)
Blocking: no   (the whole-mission flight, pictures 15 and 16: "under the parachutes at dawn the sky behind the canopies is a uniform dark navy with no horizon")

## Problem
A frame that shows the sky and little else under a low sun is exposed for full sunlight, about four stops too
dark. Two things in the meter add up:
1. The sky is not metered. The histogram holds geometry only, so with the camera pitched up `litFraction` is 0,
   `histogramWeight` is 0 and the target is the prior alone.
2. The prior is sunny 16 for the sun OUTSIDE the atmosphere: `sunny16Ev(m.sunIlluminance * m.sunVisibility)`,
   where the visibility is the share of the disc that other bodies leave free. At dawn that disc is seen through
   hundreds of kilometres of air; what reaches the camera, and everything the camera looks at, is one to two
   orders of magnitude dimmer than the 130,000 lux the prior exposes for.
The sky itself is right: 225 cd/m^2 at 60 deg elevation with the sun 1 deg up (a clear dawn sky), and the same
scene looked at level, with the sunlit cloud tops and the glow in the frame, is exposed well.

## Evidence
Atmosphere lab, 7 km over the sea, sun 1 deg above the horizon at azimuth 80, camera heading 60 (scene `x-chute-up`
of `tests/browser/atmosphere/explore.spec.ts`; `renderer.exposureInfo()` and `lab.probe`):

| camera pitch | EV100 | litFraction | histogramWeight | evPrior | sky at the frame centre | frame |
|---|---|---|---|---|---|---|
| +60 deg (sky only) | 15.08 | 0 | 0 | 15.08 | 225 cd/m^2 (rgb 136, 228, 459) | mean 8-bit luma 9.7: uniform dark navy |
| 0 deg (horizon, sun, clouds) | 13.87 | | | | | mean luma 63: dawn |
| -60 deg (sea and clouds) | 13.07 | | | | | mean luma 20 |

`sun.illuminance` 130,197 lux, `sunVisibility` 1 in all three. Mid-grey at EV 15.08 is 4,300 cd/m^2; the sky is a
twentieth of it. Pictures: `out/screens/atmosphere/explore/x-chute-up.png`, `x-chute-level.png`, `x-chute-down.png`.
In the app the same thing with the vessel in view (`litObjectInView`): `out/screens/mission/15-drogue-deploy-chase.png`,
`16-main-deploy-chase.png` (sun 0.2 deg up; the chase camera looked up past the canopies). With the camera pitched
12 deg down the same scenario is a good dawn picture: `out/screens/atmosphere/integrated-app-drogues.png`
(`tests/browser/atmosphere/integrated.spec.ts`).

## Requested change
Either or both, your choice of mechanism:
1. The prior takes the sun as the camera has it: `sunIlluminance x sunVisibility x` the transmittance of the
   atmosphere towards the sun from the camera (`atmosphereTransmittanceAlong` of `frame/math.ts` is already used for
   `sunInFrame`; luminance-weighted). At 7 km with the sun 1 deg up that is about two stops; on the ground at
   sunrise four to six.
2. A frame without lit geometry is not a frame without light: count the sky. Either the histogram includes the
   pixels at the far plane after the atmosphere composite (they are in the HDR target the meter reads), or, where
   the lit fraction is small and the camera is inside an atmosphere, the target is the mean of
   `'atmosphere.skyViewLut'` over the view directions (192 x 108, luminance in cd/m^2, published every frame).
Must not change: the exposure of sunlit scenes (pad, ascent, orbit: the sun's transmittance there is 0.8 and more,
a third of a stop at most), the night floor, the interior rules.

## Resolution

Part 1 is done (`038cf6f`); part 2 is not built, with the reason below.

**Part 1.** Inside an atmosphere the meter's sun (the prior and the bounds under the sun) is the sun through
the camera's air, less what clear air under a high sun takes: `sunThroughAir` in exposure.ts, the
luminance-weighted transmittance of `atmosphereTransmittanceAlong` towards the sun divided by
`SUN_AIR_CLEAR` = 0.75 and capped at 1. Not the whole transmittance, because the daylight rules were tuned
on frames whose sun already stood behind 0.73 to 0.85 of air. Values for the Earth's air:

| sun | from the ground | from 7 km |
|---|---|---|
| zenith | 0.85 (unchanged) | 0.93 (unchanged) |
| 35 deg | 0.76 (unchanged) | 0.89 |
| 31 deg, the mission's launch | 0.73: 0.03 EV | |
| 10 deg | 0.42: 0.84 EV | 0.68: 0.14 EV |
| 1 deg | 0.02: 5 EV | 0.24: 1.6 EV |

Your frame (7 km, sun 1 degree up, the sky alone): the prior goes from EV 15.08 to about 13.5, which is 0.4 EV
brighter than the level view of the same dawn that you call well exposed (13.87). I have not rendered your
scene: the number is the unit test's (`tests/unit/render-core/exposureGovernor.test.ts`, "the sun through the
air of the camera") with the transmittance computed for that geometry; the core's exposure suite passes with
the change (6 of 6) and so do the integration lab's exposure tests in space (the vehicle against black, the
crescent, the sun entering the frame, the cut to the cockpit). Please re-run `x-chute-up` and the mission's
pictures 15 and 16.

**Part 2** (count the sky). Not built. With part 1 the frame of the evidence is brighter than the view you
hold up as right, so the sky does not need to pull further there; and what a frame of nothing but noon sky
should look like (the sky at 6,000 cd/m^2 already sits a quarter stop under mid-grey at sunny 16) needs
pictures before a rule. What it would use exists since this round: the histogram pass has a section of sky
pixels (`MeterInput.histogramSky`, used by the interior rules of cockpit-16). Re-open with the frame that is
still wrong after part 1.
