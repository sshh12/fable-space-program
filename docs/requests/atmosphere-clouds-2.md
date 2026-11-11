Status: open
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
