Status: open
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
