Status: resolved (commit 1523877)
From: atmosphere-clouds
Owner path: src/render/core/post (bloom / sun glare)
Blocking: no        (not this package's picture, but it is in this package's acceptance screenshots and was held against them)

## Problem
Seen from orbit above the limb, the sun is a flat grey gaussian disc about 200 px in radius around a
white core. Its radius in pixels is the same at 1280 x 720 and at 2560 x 1440, which points at a kernel
sized in pixels. It reads as a halo sprite, which PROMPT.txt rules out. There is no air between the eye and
the sun in that view: the atmosphere feature adds nothing there.

## Evidence
- out/screens/atmosphere/leo-low-sun.png: brightness along the row through the sun falls from 255 at the
  core to 183 at 50 px, 115 at 100 px, 66 at 150 px, 19 at 200 px.
- out/screens/atmosphere/perf-low-orbit-terminator-1440p.png: 53 at 200 px, 0 at 300 px.
- Visual review, out/qa/wave2/atmosphere-clouds.md, item 20 ("Outside this package").
- Lab: `/labs/atmosphere/?hud=0&ev=13`, then
  `__atmo.setSun(270, 4); __atmo.view({ latDeg: 18.987556, lonDeg: -155.603239, alt: 400000, headingDeg: 270, pitchDeg: -25, fovDeg: 60 })`.

## Requested change
A glare that falls off steeply: a small clipped disc with a tight veil (an energy-conserving bloom with a
steep kernel, or a lens model with a physically shaped glare), sized in angle, not in pixels. Real
reference: out/qa/ref/sun-stars-space (the sun photographed from orbit at daylight exposure). Must not
change: the energy that a saturated source hands to the bloom (ARCHITECTURE 10.4).

## Resolution
Changed (commit 1523877): the bloom chain of the core is now a glare spread function, sized relative to the
frame.

- **Shape.** The up passes used one mix factor (0.62) at every level, which left the widest level with
  what remained: 9 % of the spread energy in a blur of about a fifth of the frame, the flat grey disc. Now
  every level twice as wide carries half of the one before, the widest included (`BLOOM_FALLOFF` = 0.5:
  weights 0.508, 0.254, 0.127, 0.063, 0.032, 0.016 at 720). That is a point spread falling with about the
  third power of the distance, the form of a lens's veiling glare: a clipped core and a veil that falls
  steeply, no plateau.
- **Size.** The level count follows the frame height (`bloomLevelCount`: 6 at 720, 7 at 1080 and 1440, 8 at
  2160) and the weights are attached to widths relative to the frame (`bloomWeights`), so the glare has the
  same angular size at every resolution.
- **Energy.** `BLOOM_MIX` (4 %) and the linear, convex chain are unchanged: a saturated source hands the
  bloom what it did before.

Measured, the sun alone on black at EV 13 in a 60 degree view (`tests/browser/render-core/exposure.spec.ts`,
"the glare of the sun is a clipped core with a steep veil ..."), luminance of 255 in rings at 0.7, 1.4, 2.8,
5.6, 11, 21, 28 and 42 % of the frame height:

| frame | 0.7 % | 1.4 % | 2.8 % | 5.6 % | 11 % | 21 % | 28 % | 42 % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 720 | 254.7 | 254.4 | 230.8 | 153.0 | 54.7 | 7.3 | 1.6 | 0.1 |
| 1440 | 254.6 | 254.6 | 230.4 | 151.5 | 53.6 | 7.1 | 1.5 | 0.1 |

Your numbers for the old chain in the same kind of view were 115 at 14 %, 66 at 21 % and 19 at 28 %.
Pictures: `out/screens/render-core/glare-720.png`, `glare-1440.png`. Your own view
(`/labs/atmosphere/?hud=0&ev=13`, sun 270 / 4, 400 km, pitch -25) shows a white core with a veil that is
gone about 90 px from the sun at 720; re-shoot `leo-low-sun.png` on your side.

Why 0.5 and not steeper: with 0.4 the rings read 124, 28 and 2.8 at 5.6, 11 and 21 %. In the reference
(`out/qa/ref/sun-stars-space/full-sunburst-over-earth.jpg`) the veil around the clipped core is wider than
either (about 40 % of white at 11 % of the frame height, 12 % at 21 %), so the steeper one moves away from
the photograph; the third-power law is also the one with a physical reading. The spikes and the ghosts of
that photograph are the sky package's flare, not the bloom.

Everything else that blooms changes the same way (plumes, the fireball, emissive panels): a tighter,
brighter glow close to the source, almost nothing a fifth of the frame away. RENDER_API section 13 and a
row in section 18.
