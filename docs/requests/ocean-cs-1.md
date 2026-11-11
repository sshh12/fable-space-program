Status: resolved (commit 3923a99)
From: core-support (cross-feature check (a), `tests/browser/integration/water.spec.ts`)
Owner path: src/render/ocean (the forward surface just inside `fadeStart`)
Blocking: yes        (check (a) "at fadeStart the forward and deferred water agree within 2 %" fails for a low camera)

## Problem
From a low camera, where `fadeStart` lies a few degrees below the horizon, the forward water in the last
metres inside `fadeStart` is 3-4.6 % off the deferred sheet, while from `fadeStart` outwards the two agree
to 0.1 %: a step at `fadeStart`. From 6 km and 14 km up (the geometry of your own acceptance measurement)
the same band agrees within 0.5 %, so the hand-over itself is right; the difference appears with the
grazing angle.

Violated: ARCHITECTURE 10.2 ("Displacement, refraction and depth-based foam are fully faded out by
`fadeStart` ... the forward surface is the same flat sea-level surface as the sheet, shaded by the same
`brdf_water` ... Both representations coincide before the forward one disappears: no ring") and the 2 % line
of your acceptance table, at this camera height.

## Evidence
```
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/water.spec.ts --project=functional -g "fadeStart"
```
The frame as it is against the same frame with `debug.forceNearFieldOff(true)`, HDR scene target, frozen
time, no jitter, real terrain, open ocean at 12 N 33 W (clear in the cloud map), sun 40 degrees up at
azimuth 120. Pixels are binned by their distance to the sea-level sphere along the pixel ray; relative
difference of luminance, worst pixel / 99th percentile / mean:

| Camera | Features | Last 50 m inside fadeStart | Last 300 m inside | fadeStart + 30 m .. fadeEnd |
|---|---|---|---|---|
| 1 km up, pitch -8, towards the sun (heading 120) | terrain, ocean, sky | **4.41 %** / 4.37 % / 0.91 % | **4.61 %** / 4.51 % / 0.58 % | 0.11 % / 0.09 % / 0.02 % |
| 1 km up, pitch -8, away from the sun (heading 300) | terrain, ocean, sky | **4.41 %** / 4.36 % / 1.85 % | **4.57 %** / 4.50 % / 1.57 % | below 0.2 % |
| 1 km up, towards the sun | + atmosphere and clouds | **2.90 %** / 2.88 % / 0.39 % | **3.14 %** / 3.04 % / 0.23 % | 0.12 % / 0.07 % / 0.01 % |
| 1 km up, away from the sun | + atmosphere and clouds | 0.18 % / 0.18 % / 0.04 % | 0.19 % / 0.14 % / 0.04 % | below 0.2 % |
| 6 km up, pitch -22, towards the sun | terrain, ocean, sky | 0.41 % / 0.38 % / 0.14 % | 0.44 % / 0.37 % / 0.14 % | 0.17 % |
| 6 km up, towards the sun | + atmosphere and clouds | 0.23 % | 0.26 % | 0.13 % |
| 14 km up, pitch -55 | either | 0.15-0.38 % | 0.25-0.51 % | 0.18-0.56 % |

(184 pixels in the 50 m band and 1,224 in the 300 m band at 1 km up: one pixel row there spans about 360 m
of range. The control band, 2.25-9.75 km from the eye, differs by 1.3-30 % in the mean and by 3.6-99 % at
the 99th percentile in every view that has it, so the comparison sees the sea and the switch works.) Numbers of every run:
`out/core-support/integration-results.json`, keys `a.fadeStartAgreement.water-only` and `.all`.

Lab URL of the worst view: `/labs/integration/?features=terrain,ocean,sky&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off&sun=120,40&sunsite=earth,12,-33&body=earth&lat=12&lon=-33&alt=1000&heading=120&pitch=-8`,
then `window.__integration.handles['ocean.createOceanFeature'].debug.forceNearFieldOff(true)` and back.

Not caused by the terrain's sheet (request `terrain-render-cs-1` is about the sheet near the camera; at
15 km the sheet is whole in both frames).

## Requested change
The forward pixel equals the deferred pixel within 2 % in the last 300 m inside `fadeStart` from every
camera height at which `fadeStart` is in view, the grazing case included (the spec measures 1 km, 6 km and
14 km up, towards and away from the sun, with and without the atmosphere). Must not change: the agreement
from `fadeStart` to `fadeEnd` (0.1 % now) and the look of the near field inside `detailFadeFraction`.

## Resolution
Closed by core-support (the filer): the step is gone with the ocean package's later commits (3923a99
"review fixes, part 2" and the two after it; the owner finished without answering here). Re-measured on
2026-11-10 at 22:40 with the same spec, 1 km up, pitch -8:

| View | Last 50 m inside fadeStart | Last 300 m inside | Before |
|---|---|---|---|
| terrain, ocean, sky; towards the sun | 0.73 % | 0.79 % | 4.41 % / 4.61 % |
| terrain, ocean, sky; away from the sun | 0.74 % | 0.84 % | 4.41 % / 4.57 % |
| with atmosphere and clouds; towards the sun | 0.32 % | 0.32 % | 2.90 % / 3.14 % |
| with atmosphere and clouds; away from the sun | 0.07 % | 0.10 % | 0.18 % / 0.19 % |

`water.spec.ts -g "fadeStart"` passes in both variants. What remains, and is not this request: with the
real clouds BETWEEN the camera and the sea (6 km and 14 km up), 1-7 % of the pixels from fadeStart outwards
(beyond fadeEnd too, where no forward water exists) differ by more than 2 % between the frame with and
without the near field, the mean staying under 0.25 %: cloud-edge pixels whose resolve reacts to the sea's
depth. Recorded in `docs/handoff/core-support.md` for the atmosphere's owner and the lead.
