Status: resolved (commit b5dceb7)
From: atmosphere-clouds
Owner path: src/render/core/lighting/deferred.ts (`cloudShadow()`), and every other reader of `'clouds.shadowMap'`; comment of `'clouds.shadowMap'` in src/core/contracts/render.ts; docs/RENDER_API.md section 7
Blocking: yes   (review finding "sunlit surfaces above the cloud layer are darkened by the clouds beneath them" cannot be fixed inside src/render/atmosphere)

## Problem
`cloudShadow()` in the deferred lighting multiplies the sun by `exp(-map.r x scale / mu_s)` for every lit
pixel of the cloud body that falls inside the near map, with no check that the receiver is UNDER the cloud.
`map.r` is the optical depth of the whole layer along the sun line, so a mountain top that pokes through a
deck, a vehicle that has climbed above a deck, and a vessel in low orbit (near-map half extent 960 km
there) are all drawn in the shade of the clouds below them. The far term already has the gate
(`r < frame.cloudFar.y`); the near term has none.

## Evidence
`ATMO_EXPLORE` scene of the review: query `cover=1,2&sky=0`, camera 80 km above the site, heading 15,
pitch -27.1, fov 20, sun az 195 el 50. The 4,992 m massif stands above the deck (tops at most 3.4 km) and
is drawn dark: 2,884 / 3,677 / 2,915 cd/m^2 at (0.55, 0.5) / (0.45, 0.5) / (0.5, 0.6) against
6,446 / 6,455 / 6,043 with `clouds=0` (`out/screens/atmosphere/explore/rv6-peak-overcast.png` against
`rv6-peak-clear.png`). Spec that will hold the fix:
`npx playwright test tests/browser/atmosphere/shadows.spec.ts --project=functional` (skips its two
assertions while this request is open, measures and logs them either way).

## Requested change
The map has carried the depth-resolved answer since the first commit (this package's own
`atmoCloudShadowAt` in src/render/atmosphere/shaders/march.ts uses it):

- `r` = optical depth of the whole layer along the line through the texel (unchanged),
- `g` = distance along the projection direction `L = cross(axisU, axisV)` (unit, towards the sun), measured
  from the map plane through `originRelCam`, at which the cloud BEGINS on the sun side (the highest cloud
  point of the line); `-3.0e30` where the line misses the layer,
- `b` = mean extinction along the line behind that point, 1/m (0 where there is no cloud).

For a receiver at camera-relative `pos`:

```wgsl
let rel = pos - frame.cloudNear0.xyz;
let s = dot(rel, cross(frame.cloudNear1.xyz, frame.cloudNear2.xyz));
let m = textureSampleLevel(cloudShadowMapTex, linearClamp, q * 0.5 + 0.5, 0.0);
let tau = clamp((m.g - s) * m.b, 0.0, m.r) * frame.cloudNear2.w;
```

A receiver above the cloud has `s > g`, so `tau = 0`; one deep under it gets `r` as today; one inside the
cloud gets the part above it. No new uniform is needed (`L` follows from the two axes; `axisV` is built as
`cross(L, axisU)` in src/render/atmosphere/clouds.ts `placeShadow`). If a cross product per lit pixel is
unwanted, `CloudShadowNear` could instead gain `dir: Vec3` written to a new `cloudNear3` - either is fine
for this package, which already has `dir` in its placement.

Please apply the same to every other reader of the near map (forward-lit transparents, ocean, terrain
forward paths, if any sample `'clouds.shadowMap'`), and state the three channels in the contract comment of
`'clouds.shadowMap'` (it still says "optical depth along the local vertical").

Must not change: the meaning of `r` and of `opticalDepthScale`, the far term, neutrality with the default
resource (r = g = b = 0 gives tau = 0).

## Resolution
Done as requested, with the cross product (no new uniform), core-support commit b5dceb7.

- New core chunk `cloud_shadow` (`src/render/core/shaders/chunksLighting.ts`, registered by the renderer):
  `cloudShadow(pos, bodyIndex, up, r, sunDir) -> f32`. The near term is
  `s = dot(pos - cloudNear0.xyz, cross(cloudNear1.xyz, cloudNear2.xyz))`,
  `tau = clamp((map.g - s) * map.b, 0, map.r) * cloudNear2.w`, `exp(-tau / max(mu_s, 0.05))`; the far term
  and the fade over the outer eighth of the map are unchanged. The deferred lighting includes the chunk
  instead of its own copy.
- Contract: the comment of `'clouds.shadowMap'` states the three channels and the projection direction
  `L = cross(axisU, axisV)`; `CloudShadowNear.axisU / axisV` say "build axisV as cross(L, axisU)" (as your
  `placeShadow` does). RENDER_API: section 7 (the row of the key), the chunk table, section 18.
- Neutral with the default (r = g = b = 0 gives tau = 0). A publisher of a single-channel map would cast
  no near shadow any more; yours carries g and b already, so nothing changes on your side.
- Spec: `tests/browser/render-core/lighting.spec.ts`, "lighting inputs ...": the ground under a layer far
  above it (exp(-0.5 / mu_s), as before), the ground a quarter of the way into a layer (exp(-0.125 / mu_s)),
  the ground above a layer whose top is 5 m below it (ratio 1.000). Render-core suite 28 of 28;
  `tests/browser/atmosphere/clouds.spec.ts -g shadow` passes. `tests/browser/atmosphere/shadows.spec.ts`
  was not in the tree when I ran this: un-skip its two assertions and run it.

Other readers of the near map: the render core has none besides the deferred lighting. Two packages carry
their own copy of the old r-only lookup: `src/render/ocean/shaders/surfaceWgsl.ts` (the sea is always
under the clouds, where the old lookup and the new one agree) and `src/render/cockpit/shaders.ts` (a cabin
above a deck is still shaded by it until that copy is replaced by `#include "cloud_shadow"`; recorded for
the lead in `docs/handoff/core-support.md`, the cockpit package has finished). The sky's probe binds the
set but samples the coverage map only.
