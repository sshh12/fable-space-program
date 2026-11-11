Status: open
From: atmosphere-clouds
Owner path: `'atmosphere.aerialPerspective'` in src/core/contracts/render.ts; chunk `transparency` (`applyAtmosphere`) in src/render/core/shaders/chunksLighting.ts
Blocking: no

## Problem
`'atmosphere.aerialPerspective'` has one transmittance for three colour channels (`a` = mean
transmittance). The opaque scene behind 50 km of air is reddened (blue is scattered out of the path, red
is not); a transparent at the same distance is dimmed by the same factor in all three channels. Its
brightness can be made to match (this package publishes the luminance-weighted transmittance), its colour
cannot: smoke, plumes and canopies stay neutral where the terrain behind them turns warm.

## Evidence
`npx playwright test tests/browser/atmosphere/transparents.spec.ts --project=functional -g "50 km"`:
a white quad 50 km away, `transparent rgb 10162, 12171, 14668 / opaque rgb 11611, 11626, 11378`: luminance
ratio 1.03 (inside the brief's 5 %), red -12 %, blue +29 %. Screenshot
`out/screens/atmosphere/transparent-vs-opaque-50km.png`.

## Requested change
A second volume with the per-channel transmittance, so that existing readers of `.a` keep working:

- new shared resource `'atmosphere.aerialTransmittance'`: 32 x 32 x 32 `rgba16float`, rgb = transmittance
  of the path from the eye to the froxel per channel, a unused (1); same slice mapping; default rgb 1;
- in `applyAtmosphere`: `let trans = vec3f(1.0) + (textureSampleLevel(aerialTransmittanceTex, ...).rgb - 1.0) * nearFade;`
  in place of the scalar, bound by `sceneBindings('transparency')`.

This package computes the per-channel value already (it reduces it to one number when it writes the
volume) and will publish the second volume in the same compute pass the day the key exists; the spec above
then asserts each channel within 5 %. Must not change: the signature of `applyAtmosphere`, the meaning of
`'atmosphere.aerialPerspective'`, neutrality with the default resources.
