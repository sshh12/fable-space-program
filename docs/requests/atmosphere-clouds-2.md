Status: declined
From: atmosphere-clouds
Owner path: src/render/core (temporal anti-aliasing: velocity of pixels that the atmosphere composite covers)
Blocking: no

## Problem
Clouds are composited into the HDR target after the G-buffer, so the pixels they cover carry the velocity
of whatever is behind them: the sky (no parallax) or the ground. The core's TAA reprojects those pixels
with that velocity. A cloud 3 km away seen from a camera moving at 2 km/s moves across the screen while its
pixels say "sky, standing still"; the TAA neighbourhood clamp is all that keeps it from smearing.

## Evidence
`npx playwright test tests/browser/atmosphere/clouds.spec.ts --project=functional -g "ascent"` compares the
frame right after a 2 km/s climb with the same view left to converge, on the HDR target BEFORE the TAA
(the cloud feature's own reprojection): 1.9 % / 5.2 % mean difference, 1.3 % / 2.6 % of the pixels off by
more than 30 %. After the TAA the picture can only be softer. The cloud feature reprojects its own history
by cloud distance and body motion (`'clouds.depth'` and the frame's previous view-projection), so the
motion of every cloud pixel is known.

## Requested change
A way for `compositeAtmosphere` to tell the TAA where a covered pixel was: either a shared resource
`'clouds.velocity'` (rg16float, screen-space motion in UV units, half resolution, default 0 = use the
G-buffer velocity) that the TAA blends in by `1 - clouds.screen.a`, or a documented statement that the
TAA's clamp is the intended answer for volumetrics (then nothing changes and this request can be declined).
Must not change: the velocity of opaque surfaces, the TAA's behaviour with default resources.

## Resolution
Declined in the form of a second velocity source; the statement you offered as the alternative is now in
`docs/RENDER_API.md` section 13:

> Pixels covered by something that is composited after the G-buffer (clouds, the atmosphere, transparents)
> carry the velocity of the opaque surface or sky behind them. That is intended: the resolve's
> neighbourhood clip bounds what the wrong reprojection can do, and a volumetric feature keeps its own
> temporal filter with its own motion (the cloud feature reprojects by cloud distance and body motion).
> Where that is not enough, the feature writes `'post.reactive'`.

Why not `'clouds.velocity'`: the resolve would blend two velocities by cloud opacity, and a half-covered
pixel has no single right motion (the cloud's and the ground's both show); the reprojection error you
measured (1.9-5.2 % mean, before the TAA) is in your own history, which a second velocity in the core's
resolve would not touch. What exists for the case where the core's history hurts a moving cloud edge:
`requires: ['post.reactive']` and a pass in `compositeAtmosphere` that writes, say,
`(1 - clouds.screen.a) x saturate(mismatch in pixels / 4)` (max blend, r8unorm): the resolve then trusts
this frame more exactly where your cloud moves differently from what is behind it. Measured effect of the
mask: `tests/browser/render-core/framegraph.spec.ts`, "'post.reactive' lowers the history weight ...".
