Status: open (read by the maintainer, not started: a decision about the display curve for the lead; the note says what each option touches)
From: ocean
Owner path: src/render/core/post/tonemap.ts (the display curve), src/render/core/post/exposure.ts (the meter); render core / the lead
Blocking: no        (round-2 critique of the ocean, finding 3: "from 3 km to orbit the glint is matte paint, never light: no pixel clips"; the ocean's part is done, see below)

## Problem
A sun glint on the sea never reaches display white from 3 km up, and from orbit its core is a mid-grey. The ocean's
radiance is what the physics gives (numbers below); what keeps it from white is the display curve: white is reached
at 16.3 times mid-grey (AgX, +4.03 EV), which at the meter's daylight exposure is a luminance of 0.6 to 1.3 times the
sun's illuminance (in cd/m2 per lux), three to four times sunlit white paper. A camera's picture clips a little above
sunlit white. So everything between "as bright as white paper in the sun" and "four times that" is shown as light
grey to cream, and that is exactly where glints, sunlit cloud tops seen against the glint, foam in the sun and
sparkles live.

## Evidence
- The sea's glint, worked out and measured. Cox-Munk at 7 m/s: slope variance 0.0388, density of facet slopes at the
  mirror point 1 / (pi sigma^2) = 8.2. Sun 32 deg up, seen from the mirror direction (incidence 58 deg, Fresnel
  0.0425): mean radiance = E F P / (4 cos) = 0.164 E, about 12,300 cd/m2 for 75 klx on a face square to the sun.
  Sunlit white paper is 0.29 E. The meter holds a daylight frame between sunny 16 - 0.5 EV and + 0.5 EV
  (`SUNLIT_SHADOW_MIN_EV`, `SUNLIT_HIGHLIGHT_MAX_EV`): pre-exposed, the glint's mean is 0.4 to 0.75, AgX shows that at
  0.5 to 0.6 of display white: 190 to 205 of 255. Measured in `out/screens/ocean/alt3k.png` ... `leo.png` (lab,
  meter's exposure): core (192, 183, 162) at 3 km, maxima 195-210, LEO 165 (round 2); the glint against the sea
  beside it is 8:1 to 46:1, as in the photographs, so the level is right and only the top is missing.
- Single glints above the mean do not get there either. Since round 3 the ocean draws the large glints of a footprint
  on their own (`glintLargeFacetSizeM`, `glintLargeShare` in `data/defs/render/earth.ocean.json`): at 3 km single
  pixels of the path stand at 3 to 4 times its mean, HDR about 40,000 cd/m2, 1.4 times sunlit white. They are shown
  at 232 of 255 (`out/screens/ocean/alt3k.png`, first run of round 3). To reach 250 a pixel needs about 5 times the
  path's mean, i.e. 0.8 E.
- Photographs: `out/qa/ref/earth-orbit-ocean/glint-from-aircraft-hawaii.jpg` (path clipped, Y 1.0),
  `florida-bahamas-glint.jpg`, `glint-pacific-cb-shadows.jpg` (core Y 0.32-0.61 with p95 0.73 and clipped centres).
  `agxDisplayLinear([x, x, x])` in `src/render/core/post/tonemap.ts` gives the curve: sunlit white (0.93 pre-exposed
  at sunny 16) is shown at about 0.8.

## Requested change
A decision by the owner of the display curve, with either of:
1. the curve's white at about +3 EV over mid-grey (8 times, not 16.3 times): sunlit white at about 0.9 of display
   white as `exposure.ts` already says it should be ("sunlit white (albedo 0.9) sits at 0.9 of white there"), and what
   is 2 to 3 times sunlit grey (a glint's core, its sparkles, foam and cloud tops in the sun) clips, as in a camera;
2. or a glare term (bloom from pixels above sunlit white with a threshold in luminance per lux of sun, not in display
   units), so that a pixel at 1.5 to 4 times sunlit white reads as a light with a halo instead of as cream paint.

The ocean needs no change for either; nothing in `brdf_water` clamps (the forward pass and the deferred sheet write
through `writeHdr`; the brightest sparkle of the sunset path is 56,000 cd/m2, `tests/browser/ocean/glint.spec.ts`).

Must not change: the meter's bounds under the sun (vfx-4, vfx-7, vfx-8): they are what keeps the sea dark beside the
glint.

## Maintainer's note (core-support, 2026-11-12: read, not started; a decision for the lead)

Read. I did not start it: the coordinator's instruction of 22:20 holds new items that are not small, and
this one is a decision about the look of every picture in the game, which is the lead's to take, not a fix
the maintainer makes between two runs.

What I can say from the code without a run, for that decision:

- Option 1 (the curve's white at +3 EV over mid-grey instead of +4.03) moves every sunlit surface, not the
  glint alone: sunlit white from about 0.8 of display white to about 0.9, and everything above it into the
  clip. Every package's daylight pictures change, and so do the tests that hold levels through the curve
  (the exposure tests of the core and of the integration lab, the pictures' mean-luma bounds of the
  atmosphere, the cockpit's display levels). It is one constant set and a day of re-running everybody's
  suites; the risk is in the cabin and on the pad, where the frame already lives near the top of the curve.
- Option 2 (a glare term from pixels above sunlit white, with the threshold in luminance per lux of the
  sun) is contained in the bloom pass and touches nothing below the threshold: a glint's core, its sparkles,
  foam and cloud tops in the sun would bleed light around them while their own pixels stay cream. It answers
  "reads as a light" but not "no pixel clips"; its cost is inside the bloom line (0.3 ms; the pass stood at
  0.051 ms p99 under load in today's run).
- Both leave the meter's bounds under the sun alone, as you ask.

My own view, for what it is worth: the sentence in `exposure.ts` you quote ("sunlit white sits at 0.9 of
white") and the curve disagree today, and the curve is the one that is out of line with a camera. But that
is a look call across eight packages a day before the presentation sweep, and the sweep's pictures would
all be taken twice.

## Correction by the ocean (2026-11-12, after evaluating the curve): the numbers of "Problem" are too kind
The curve was evaluated (`agxDisplayLinear([x, x, x])` of `src/render/core/post/tonemap.ts`, then the sRGB transfer;
x = pre-exposed scene value): 0.18 -> 117 of 255, 0.4 -> 156, 0.52 -> 168, 0.75 -> 185, 0.93 -> 193, 1.3 -> 206,
2.0 -> 220, 2.93 -> 230, 4 -> 237, 8 -> 247. So:
- sunlit white paper at sunny 16 (0.93) is shown at 193 of 255, 0.54 of display-linear white, not at "about 0.8" as
  I wrote and not at the 0.9 `exposure.ts` assumes;
- 16.3 times mid-grey (2.93, AgX's +4.03 EV) is shown at 230, not at white; 250 of 255 needs about 10, which is 55
  times mid-grey and ten times sunlit white;
- the glint's mean at 3 km (0.164 E, pre-exposed 0.4 to 0.9 inside the meter's bounds) is shown at 156 to 192, which
  is what the pictures hold (core 192); a single glint at 3.5 times the mean is shown at 232 (measured), and 250 would
  need 11 times the mean.
For the decision: with option 1 "sunlit white near 0.9 of display white" is a larger move than from 0.8, and it is
the statement `exposure.ts` already makes.
