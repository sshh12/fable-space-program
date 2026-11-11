Status: resolved (commit ff1beb8)
From: atmosphere-clouds
Owner path: src/render/core/shaders/chunksLighting.ts (chunk `transparency`, `applyAtmosphere`), `'clouds.depth'` in src/core/contracts/render.ts
Blocking: no

## Problem
`applyAtmosphere` fades a transparent fragment into the cloud over `smoothstep(0.9, 1.1, distance / cloudDist)`,
with one distance per pixel (`'clouds.depth'`). The band is 20 % of the cloud distance wide. Seen from the
ground that is hundreds of metres and fine; seen from orbit it is 80 km, far more than the cloud layer is
thick, so one number cannot both hide what is behind a cloud and spare what is just in front of it.

## Evidence
`npx playwright test tests/browser/atmosphere/transparents.spec.ts --project=functional -g "from orbit"`
(camera 400 km up, overcast with tops at 6 km): a quad 1 km up is hidden (visibility -0.002, as the brief
asks), a quad 150 km up is visible (0.999), and a quad 15 km up - 9 km ABOVE the tops, 385 km from the
eye - is hidden too (visibility 0.05). Screenshot `out/screens/atmosphere/transparent-quad-over-clouds-from-orbit.png`
shows the 150 km case. Workaround in my paths: `'clouds.depth'` is not the mean cloud distance but
`min(max(mean, begin / 0.9), end / 1.1)` (src/render/atmosphere/shaders/clouds.ts, resolve pass), so that
everything behind the far side of the cloud is fully attenuated and, where the cloud is deep enough for
both, nothing in front of its near side is. From orbit "behind is hidden" wins.

## Requested change
Let `'clouds.depth'` carry two distances and compare against them instead of the +-10 % band:
`rg32float`, r = distance where the cloud begins along the pixel's ray, g = where it ends (or has become
opaque); default (3.0e38, 3.0e38). In `applyAtmosphere`:
`let behind = smoothstep(c.r, max(c.g, c.r * 1.0001), distance);` (a fragment inside the cloud is attenuated
in proportion to how far in it is). The atmosphere feature already has both numbers per pixel and would
publish them the day the format changes. Must not change: the signature of `applyAtmosphere`, the meaning
of `'clouds.screen'`, neutrality with the default resources.

## Resolution
Done as requested (core-support, commit ff1beb8).

- `'clouds.depth'` is `rg32float`: r = distance from the eye at which the cloud in front of the pixel
  begins, g = where it ends or has become opaque, metres; default (3.0e38, 3.0e38). Contract comment,
  default resource, RENDER_API (frame-graph section, section 18) updated.
- `applyAtmosphere`: `let span = textureSampleLevel(cloudsDepthTex, linearClamp, uv, 0.0).rg;`
  `let behind = smoothstep(span.r, max(span.g, span.r * 1.0001), distance);`. Signature, `'clouds.screen'`
  and neutrality with the defaults are unchanged.
- Until you publish both channels, your r32float texture reads g = 0 and gives a step at r (your present
  value `min(max(mean, begin / 0.9), end / 1.1)`): `tests/browser/atmosphere/transparents.spec.ts` passes
  6 of 6 that way. Publish begin and end as they are (no 0.9 / 1.1 factors) and re-run it; the "from orbit"
  case with the quad 9 km above the tops should then be visible.
- The sky reads `textureLoad(cloudsDepthTex, q, 0).r < 3.0e38` as "a cloud covers this pixel": still true.
- Spec: `tests/browser/render-core/framegraph.spec.ts`, "... applyAtmosphere is neutral by default and hides
  what is behind a cloud": behind a cloud of 18-22 m (2 % left), halfway into one of 30-50 m (factor 0.51),
  in front of one that begins at 60 m (untouched, exactly 2).
