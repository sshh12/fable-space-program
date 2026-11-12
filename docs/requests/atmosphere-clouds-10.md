Status: open
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
