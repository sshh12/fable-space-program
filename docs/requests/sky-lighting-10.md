Status: resolved (commit 7e953e8)
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

## Resolution

Done (`7e953e8`), for a camera above every atmosphere (in space), exterior views:

- Cause: the histogram holds lit geometry only. Your frame is 60 % night side (geometry, a few hundredths of a
  cd/m^2) and the lit arc and the sun are light over sky pixels: the histogram saw the night side alone, took
  full weight, and the prior (sunny 16) never had a say: EV100 5.7.
- The meter's sun illuminance for a camera in space is now the sun's illuminance after the air between the
  camera and the sun: `atmosphereTransmittanceAlong(point, dir, snapshot, defs)` (new, `@/render/core`: the
  CPU twin of the transmittance tables, Rayleigh + Mie + ozone of each body's atmosphere definition,
  integrated with samples crowded at the ray's closest approach), luminance-weighted. A ray grazing 10 km up
  from 200 km gives 0.126 / 0.046 / 0.005 (your flare state reads 0.103 / 0.029 / 0.002 at 0.3 deg).
- With the disc in the frame that illuminance is a floor: target >= sunny 16 of it minus
  `SUN_IN_FRAME_MARGIN_EV` = 1 (`MeterInput.sunInFrame`). Your view: about EV100 9-10 instead of 5.7.
- Unit tests (`tests/unit/render-core/exposureGovernor.test.ts`, "the sun just over the limb from orbit"):
  night side 60 % + lit arc 2 % at 1,500-4,000 cd/m^2 + the sun at 3 %: within 1 EV of sunny 16 of the
  attenuated light; the night side alone with the sun in the frame: at the floor (3+ EV darker than without
  the rule); map views untouched. `frameMath.test.ts`: zenith transmittance against the closed form, grazing,
  the ground in the way.
- Unchanged, re-run: `tests/browser/integration/exposure.spec.ts` (vehicle in space EV100 15.09, crescent
  Earth 15.07 against sunny 16 15.07-15.08, the sun into a dark-adapted frame, NaN 0) and the render-core
  exposure specs: 9 of 9. Views with the sun clear of the air (transmittance 1), cameras inside an atmosphere
  (the ground, a climb) and the dark floor without the sun in view are unchanged. Your 6 deg view: the
  transmittance is 1 there, so the floor is sunny 16 - 1 = EV100 14.05; it read 12.65, so it comes about
  1.4 EV darker (the sun in the frame from space is exposed for the sun's light).
- I could not shoot your view: in the run at 14:42 your `integration.spec.ts` "real limb" test was skipped
  because the sky feature was quarantined (`sky.flare` failed to compile: "Error while parsing WGSL: :381:7",
  your work in progress). Re-shoot `integration-sun-at-limb` and `integration-sun-above-limb` when it builds.
RENDER_API section 13 and section 18.
