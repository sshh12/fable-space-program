Status: open
From: sky-lighting
Owner path: src/render/core/post/exposure.ts (`EV_DARK_FLOOR`, `EV_MIN`), src/render/core/post/tonemap.ts (the toe of `agx`)
Blocking: yes   (items 2, 3 and 7 of `out/qa/wave2/sky-lighting.md`: two visual critics scored the package 4.5 / 5 of 10, and these three items cannot be closed inside `src/render/sky`: the brief forbids a brightness knob in the sky)

## Problem
Two properties of the display transform decide what the night sky and the sun's glare look like, and both
sit in the core.

(1) **The dark floor is 3 stops too bright for the night sky.** `EV_DARK_FLOOR = EV_MIN = -3` puts the Milky
Way (5e-4 to 1e-3 cd/m^2, which is right) 4.7 to 5.6 stops under mid-grey, where the tonemap gives 1-5/255:
at the darkest exposure the game can reach, the night sky from orbit is a black frame with a few dozen dots
(`out/screens/sky/leo-night-dark-adapted.png`: 99.2 % of the pixels at 2/255 or below). ISS night
photographs are taken at about EV100 -4 to -7 and show the Milky Way as the main feature of the sky
(`out/qa/ref/sun-stars-space/milkyway-airglow.jpg`, `milkyway-dragon.jpg`). `EV_MIN` also clamps the
player's exposure compensation, so play cannot reach the exposure of the package's own good views
(`starfield-deep-space-ev-5.png` is hand-set).

(2) **The toe crushes and tints.** Measured with a CPU port of `agx()` + the look + the sRGB OETF (grey
input, stops relative to 0.18): -3 -> 31/255, -3.5 -> 21, -4 -> 13, -4.5 -> 6.8, -5 -> 3.4, -5.5 -> 1.6,
-6 -> 0.8, -7 -> 0.2. Between -3.5 and -6 stops the display falls 26 times while the scene falls 5.7 times
(display-linear ~ scene^3 there), then it is zero. Consequences: (a) every smooth falloff ends at a traceable
edge: the sun's glare, a pure power law in HDR, loses its last 44 levels in 55 px and reads as a grey ball
with a rim (`out/screens/sky/sun-at-earth-limb-leo-flare.png`, `out/screens/integration/exposure-sun-settled.png`);
(b) the toe is per channel, so the weaker channels reach black first: a warm grey (1.25, 1, 0.75) has
R/G 1.11 and R/B 1.28 on the display at mid-grey, 1.45 and 2.72 at -4 stops, 1.69 and 3.44 at -5: the Milky
Way turns rust-brown as it dims and the Large Magellanic Cloud purple (`out/screens/sky/milky-way-band-ev-3.png`:
bulge (48, 29, 23) against (113, 85, 74) at EV -5).

## Evidence
- `out/qa/wave2/sky-lighting.md` items 2, 3, 7 (figures re-measured by the QA lead).
- The numbers above: `agx()` of `src/render/core/post/tonemap.ts` evaluated on the CPU for grey and for
  (1.25, 1, 0.75) x 0.18 x 2^s; the same shows in any screenshot of a dim gradient.
- Lab: `/labs/sky/?scene=leo&night=1&hud=0` (settles at EV -2.9), `/labs/sky/?scene=translunar&planet=0&ev=-5`
  (what the sky looks like 2 stops lower).

## Requested change
(1) Exposure floor. `EV_DARK_FLOOR` and `EV_MIN` at **-6** (or `EV_MIN` at -7 so that compensation still has a
stop of room at the floor). The floor is only ever the target when nothing lit is in view and no emitter is
metered (that is already the rule in `meterExposure`); the fall from the old floor to the new one should be
slow, as dark adaptation is: about 0.1 to 0.15 EV/s below EV -3 (20 to 30 s for the last three stops) instead of
`ADAPT_DOWN` = 0.8, and `ADAPT_UP` unchanged, so one lit pixel brings the exposure back at once. At EV -6 the
band lands 1.7 to 2.7 stops under mid-grey (35 to 60/255), which is what the reference photographs show.
Must not change: anything above EV -3, `minEv100`, the interior and emitter rules.

(2) Toe. Below about 3.5 stops under mid-grey the display should follow the scene instead of a sigmoid's
foot: display-linear = k x scene-linear (k chosen so the curve is continuous where it joins the existing
one; with the present curve k is about 0.48 at -3.5 stops), applied to the colour as a whole (or to its
luminance with the scene's chromaticity kept), blended into the present curve over about one stop. That
gives, for grey: -4 -> 15/255, -5 -> 9, -6 -> 4.4, -7 -> 2.2, -8 -> 1.1, -9 -> 0.5: a falloff never meets a
floor at a visible slope, and a dim colour keeps its hue. If you prefer to keep the curve and only fix the
hue: evaluate the curve on luminance below that level and scale the colour by display / scene luminance.
Must not change: the rendering from about 3 stops under mid-grey upwards (every package's daylight views),
display white, the dither.

What I will re-run when it lands: the whole of `tests/browser/sky` (the dark-adapted criterion, then asserted
at the settled exposure: Milky Way mean at least 12/255 in Sagittarius and Crux; channel ratios of the band
at the floor within 20 % of the EV -5 image; the glare profile monotonic with no step where it meets black).

Workaround inside the package meanwhile: none for (1) (no knob); for (2) the glare gets a wide theta^-2 skirt
and a veiling term so that its tail is long even through the present toe, and the views are shot at the
exposures the game reaches.
