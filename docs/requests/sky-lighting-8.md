Status: open
From: sky-lighting
Owner path: src/render/core/frame/math.ts (`planetshineAt`), src/render/core/frame/uniforms.ts (`ShineLight` packing), src/render/core/lighting/deferred.ts (the planetshine loop)
Blocking: yes   (major finding 2 of both round-1 critics of the sky: `out/qa/wave2/sky-lighting.r1.photo.json`, `.r1.artifact.json`)

## Problem
Planetshine has no occlusion test. A vessel in low orbit on the night side is lit by the Moon as a hard
directional light although the Moon is behind the Earth: `planetshineAt` is evaluated at the centre of the
vessel's body for every receiver below 0.5 R (`renderer.ts` line 618) and the deferred pass adds it with the
baked AO only (`deferred.ts`, "---- planetshine"). The sun gets `sunVisibility(pos, sunDir)`; planetshine gets
nothing. At the dark floor (EV -6) this light is several stops over the starlight the frame is exposed for and
becomes the key light of the scene, coming from below the horizon, through the planet.

## Evidence
- `out/screens/sky/pbr-spheres-leo-night.png` (lab `labs/sky/?scene=lowOrbit&night=1&spheres=1`, sun at the
  vessel's nadir, automatic exposure): the white sphere has a straight terminator with its lower-right half at
  80-150/255, the black, chrome and gold spheres a compact highlight in their lower right, inside the part of
  the chrome ball that mirrors the black Earth. From the highlight the light comes from 44-47 deg below the
  local horizontal; the Earth's limb is 14 deg below it. No lab light exists; the source is the Moon.

## Requested change
Per shaded point, multiply each planetshine light by the fraction of the shining body's disc that every
OTHER non-star body leaves visible from that point: the disc-overlap function `discVisibleFraction` already
used by `sunVisibility`, with the shining body's angular radius as the source radius. `ShineLight` has two
free floats in its 8-float slot (`dir.w`, `illuminance.a`): the shining body's frame index and its angular
radius at the receiver fit there, so the shader can skip the shining body itself and test the others
(the body the receiver is near above all). CPU twin for callers of `planetshineAt` that light something
themselves: an optional `visibleFrom?: Vec3` (ROOT) that applies the same factor.
Unit test: Moon behind the Earth seen from a 200 km orbit gives a factor of 0; Moon 10 deg above the limb
gives 1; half hidden by the limb about 0.5. Browser: a white sphere in low orbit at night with the Moon set
has no lit half (its two halves within a factor of 2 of each other).
Must not change: `frame.shine`'s layout and receivers, the value of an unoccluded light, `planetshineAt`'s
existing signature (new parameter optional). The sky's probe reads `frame.shine[body]` to light a body's
GROUND facing the shining body (`max(dot(n, dir), 0)`), which needs no occlusion.
The sky package re-shoots `pbr-spheres-leo-night` (once with the Moon above the vessel's horizon, once set)
and asserts the picture in `tests/browser/sky/views.spec.ts` when this lands.
