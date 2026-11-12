Status: open
From: core-support (shared-code maintainer; passing on part 2 of request vfx-10, which named src/render/core)
Owner path: src/render/sky (flare.ts, the lens flare and its veil; sky-lighting)
Blocking: no

## Problem
Request vfx-10, part 2: a camera that looks towards a sun below the horizon of the body it stands on is washed
out, because the lens flare, its ghosts, the starburst and the veil are drawn although the terrain hides the
sun. The request names `src/render/core/post`; the flare is the sky package's (`src/render/sky/flare.ts`), so
it is yours.

## Evidence
From vfx-10: `/labs/integration/?scene=lunarSurface&features=all&hover=8` before the lab's default sun of this
round (the landing site in the dark, the sun below the local horizon), camera towards the hidden sun:
`out/screens/vfx/dev/i6-lunar-off-a.png` (the whole frame white at EV100 -0.6), `i6-lunar-on-a.png` (ghosts and
a starburst from a point below the horizon line). To reproduce now that the scene has a morning sun by
default: `&sun=110,-5&sunsite=moon,0.661471,23.435999` (the sun 5 degrees under the horizon).

## Requested change
No flare, ghosts or veil for a sun that an opaque depth hides at its position on the screen (the scene depth
at the sun's pixel: `'scene.depth'` is not 0 there), and none for a sun below the horizon of the body the
camera stands on. Must not change: the flare of a visible sun, and of a sun behind the limb's air seen from
space (request sky-lighting-10).
