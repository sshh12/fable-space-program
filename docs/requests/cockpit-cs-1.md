Status: open
From: core-support (cross-feature check (b), `tests/browser/integration/clouds.spec.ts`, "above an overcast deck neither the hull nor the cabin is in the shade of the deck below")
Owner path: src/render/cockpit/shaders.ts (`cabinCloudTransmittance`)
Blocking: no

## Problem
A cabin that is ABOVE a cloud deck is shaded by it. The cabin's ambient pass multiplies the sun that
enters through the windows by `cabinCloudTransmittance()`, a copy of the core's old near cloud-shadow
lookup: it reads the whole layer's optical depth (`cloudShadowMapTex.r`) at the cabin's place in the map
and never asks whether the cabin is under the layer or over it. The near map is centred under the camera
and reaches 30 km plus 2.5 times the camera's height above the cloud tops (500 km in a 200 km orbit), so
the capsule is inside it on the whole ascent and in low orbit: whenever the sun line through the cabin
meets cloud BELOW it, the sun patch in the cabin goes out.

The core's lookup was made depth-resolved for exactly this case (request `atmosphere-clouds-3`, commit
b5dceb7: chunk `cloud_shadow`, `cloudShadow(pos, bodyIndex, up, r, sunDir)`); the hull of the same capsule,
lit by the deferred pass, is right.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/clouds.spec.ts --project=functional -g "neither the hull nor the cabin"`
(fails on the cabin; lab: `/labs/integration/?scene=ascent&at=-42,19&throttle=0&stage=4&ev=11&sun=140,50&sunsite=earth,-42,19`,
then `window.__integration.sunThroughWindowOnto(...)`, `sitInCockpitAimedAt(...)`, `setNearCloudShadow(false | true)`).

The orbital stack 14.1 km up over an overcast part of the real cloud map (coverage 1.00, tops 12.3 km), the
sun 21 degrees above the horizon through window `fwd-right` onto the middle couch, seen from the commander's
seat. The lab's switch takes the near cloud-shadow placement away from every reader (`setCloudShadowParams({
near: null })` after the atmosphere's `prepare`); a receiver above the deck must not notice.

| Luminance with / without the near cloud shadow | with | without | ratio |
|---|---|---|---|
| Hull from outside (deferred lighting of the core), mean of the frame's middle | 22,697 cd/m^2 | 22,686 | 1.000 |
| Hull, brightest 2 % | 31,830 | 31,815 | 1.000 |
| Cabin from the seat, mean of the frame's middle | 49.9 cd/m^2 | 113.8 | **0.438** |
| Cabin, brightest 2 % (the sun patch) | 2,015 | 2,634 | **0.765** |

Pictures (looked at): `out/screens/integration/clouds-cabin-above-the-deck.png` (as delivered: the cabin is
nearly black, no sun patch on the couch) and `clouds-cabin-above-the-deck-no-near-shadow.png` (the sun patch
on the head rest and the couch, the quilted wall lit by its bounce); `clouds-hull-above-the-deck.png`.

The code: `src/render/cockpit/shaders.ts`, `cabinCloudTransmittance()`:
`let tau = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0).r * frame.cloudNear2.w;`
(`.r` is the optical depth of the whole layer on that sun line; the map's `g` and `b`, where the cloud begins
along the projection direction and its mean extinction, are not read). The rule it breaks: RENDER_API
section 7, row `clouds.shadowMap`: "`tau = clamp((g - s) * b, 0, r) * scale` ...: none above the cloud, all of
it deep below, the part above the receiver inside. Read it through the chunk `cloud_shadow` only."


## Requested change
In `src/render/cockpit/shaders.ts`, replace the body of `cabinCloudTransmittance()` by the shared lookup:
`#include "cloud_shadow"` in the module that declares the `cloudShadow` binding set (it already declares
`cloudShadowMapTex` and `cloudCoverageMapTex` through `createSceneBindings(..., ['env', 'atmosphereLuts',
'cloudShadow'])`) and call `cloudShadow(pos, bi, up, r, sunDir)` with the cabin centre. The far term and the
blend at the map's edge are the same as in the copy. Nothing else needs to change; the acceptance is the
spec named above (cabin luminance with / without the near cloud shadow within 3 %).
