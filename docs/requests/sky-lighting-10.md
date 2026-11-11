Status: open
From: sky-lighting
Owner path: src/render/core/post/exposure.ts (the automatic exposure's target with the sun in view behind the limb's air)
Blocking: no   (the evidence view of the sun rising over the real limb, round 2 of the sky's visual close-out)

## Problem
With the sun 0.3 deg above the Earth's limb seen from low orbit, its light reaches the camera through ~10 km of
air (transmittance 0.10 / 0.03 / 0.002 in R / G / B: still 4,000 lux in green). The automatic exposure settles
at EV100 5.7, seven stops over the same view with the sun 6 deg up (EV100 12.7): it exposes for the night side
that fills most of the frame. At that exposure the lit limb arc is a burned white band and the lens flare of a
4,000-lux source (its wide halo, 0.25 % of the source) floods the whole frame orange. A camera exposes that scene
for the bright arc and the sun: the frame is black, the arc thin and blue-to-orange, the sun a compact clipped
point with little glare (reference below).

## Evidence
- `out/screens/sky/integration-sun-at-limb.png` (EV100 5.66, orange frame, white limb band) against
  `out/screens/sky/integration-sun-above-limb.png` (sun 6 deg up: EV100 12.65, black sky, thin blue arc).
  Written by `npx playwright test tests/browser/sky/integration.spec.ts --project=functional -g "real limb"`
  (integration lab, `scene=lowOrbit`, sun pinned 0.3 deg above the limb, automatic exposure).
- Reference: `out/qa/ref/sun-stars-space/sun-first-rays-limb.jpg` (INDEX: "At first light the sun is a compact
  clipped point ... A thin bright blue arc of limb atmosphere spreads from it into blackness. Before full sunrise
  there is little glare").
- The sky's flare state at the sun: `readFlareState().transmittance` 0.103 / 0.029 / 0.002, visible 1.0.

## Requested change
While the sun's disc (or the sunlit limb arc it makes) is in the frame, the target keeps the brightest extended
part of the frame under the highlight cap even when it is a small fraction of the frame, as the bound on the
99th percentile does in daylight: for example let `underTheSun` apply with the sun's illuminance AT THE CAMERA
after the air it crosses (sunny 16 of E x transmittance, 4,000 lux here: about EV100 10), instead of releasing
the bound when the unattenuated or visibility-only weighting says the sun does not light the scene. A unit test:
the meter's inputs of this view (mostly black frame, 2 % of it at a few thousand cd/m^2, the sun in view and
attenuated to 3 %) give a target within 1 EV of sunny 16 of the attenuated illuminance.
Must not change: the dark floor and dark adaptation when the sun is not in view (the night sky views of this
package assert at EV -6), the interior metering, the crescent-Earth and vehicle-in-space cases of
`tests/browser/integration/exposure.spec.ts`. Nothing in `src/render/sky` needs to change; the sky re-shoots
`integration-sun-at-limb` when this lands.
