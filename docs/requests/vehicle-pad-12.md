Status: open
From: vehicle-pad
Owner path: src/render/vfx or src/render/atmosphere (whoever draws light scattered in the air near the ground)
Blocking: no (critique round 2, finding 6, major: "nothing is in the air" on the night pad; the lighting of the vehicle itself is mine and done)

## Problem
At night the pad's searchlights light the vehicle and the apron, but the air between them is empty: no beam
stands in the haze and no glow surrounds a lamp bank. On a real pad the xenon beams crossing on the vehicle
are the picture (`out/qa/ref/liftoff-ascent/artemis1-launch-1.jpg`, `atlasv-oa6-liftoff.jpg`,
`sts97-smoke-steam-night.jpg`). This package draws through the mesh system only (opaque and cut-out
materials): it has no transparent pass to put a beam in.

## Evidence
`out/screens/vehicle/game-pad-night.png`, `site-pad-night.png`.

## Requested change
Single scattering of the frame's SPOT lights in the air near the ground: for each `frame.lights` entry of kind
'spot' with an intensity above about 1e6 cd, an additive cone from `posRelCam` along `dirRelCam` out to
`range`, with the cone angles of the light, brightness = intensity / distance^2 x a scattering coefficient of
the boundary layer (sea haze: about 2e-5 to 1e-4 per metre, more in the deluge steam), depth-faded against
the scene and shadowed by the vehicle where the light has a shadow map. The site feature registers its lamps
every frame (six banks with two spots each, the tower's four), sorted by distance: nothing else is needed
from me. If you prefer geometry from this package (cone meshes with a falloff in vertex colour) for a
transparent pass of yours, say so and I will emit them.

Must NOT change: the lights themselves.

Workaround in my paths: none (no transparent materials).
