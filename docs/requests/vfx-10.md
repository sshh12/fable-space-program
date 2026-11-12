Status: open
From: vfx
Owner path: labs/integration (scene `lunarSurface`: the sun at the landing site) and src/render/core/post (lens flare of a sun the terrain hides)
Blocking: no        (vfx pins the sun in its own spec and shots: `&sun=110,12&sunsite=moon,0.661471,23.435999`)

## Problem
The hover over the Moon in the integration lab (`?scene=lunarSurface&features=all&hover=8`) was judged a "full
grey-out" by the round-2 critics and put down to the dust (finding 2 of `docs/qa/wave2/vfx.r2.combined.json`).
Measured in round 3, the grey-out is there with the engine OFF, and it is not the dust's:

1. At the lab's epoch the landing site (Mare Tranquillitatis, 0.66 N 23.44 E) lies in the dark. `frame.sun.illuminance`
   is 130,263 lx, but nothing of it reaches the ground: the terrain reads under 0.5 cd/m^2 and the meter settles
   at EV100 -0.58 (`evPrior` -6): a night exposure, at which the picture looks like a blue-grey day. At that
   exposure anything that shines decides the picture: with the engine at half throttle the lander's own plume
   light (12,600 cd) pulled the meter to EV100 +2.5 and the "sunlit" terrain went black.
2. A camera that looks towards the sun below that horizon is washed out: the lens flare and its veil are drawn
   although the terrain hides the sun (ghosts and a starburst from a point below the horizon line), and at
   EV100 -0.6 the veil is a white-out.

## Evidence
`out/screens/vfx/dev/i6-lunar-off-a.png` (engine off, camera towards the hidden sun: the whole frame white),
`i6-lunar-on-a.png` (engine on, same view: grey veil, ghosts, a starburst from below the horizon),
`i6-lunar-off-b.png` / `i6-lunar-on-b.png` (sun behind the camera: a normal picture with the engine off, a
night picture with it on). Read-outs of the frames `i7-lunar-off-b` / `i7-lunar-on-b` in `out/vfx-r3/run2.log`:

    off: ev100 -0.58, evPrior -6,    litFraction 0.67, sunLux 130263, terrain 0 cd/m^2, lights: none lit
    on:  ev100  2.52, evPrior -5.23, litFraction 0.76, sunLux 130263, terrain 0 cd/m^2, dust under the lander 16 cd/m^2,
         lights: three capsules of 12,599 / 4,950 / 450 cd

## Requested change
1. `labs/integration`, scene `lunarSurface`: place the sun over the site by default (for instance 12 degrees up
   in the east, an Apollo morning; today only `&sun=az,el&sunsite=moon,lat,lon` does it), so that critics and
   packages that open the scene without that parameter judge a sunlit surface.
2. `src/render/core` (lens flare): no flare, ghosts or veil for a sun that the terrain (or any opaque depth)
   hides at its position on the screen, and none for a sun below the horizon of the body the camera stands on.

Must NOT change: the scene's vessel, hover height and camera API (`window.__integration.orbitVesselPoint`);
the flare of a visible sun.
