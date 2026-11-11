Status: open
From: vfx
Owner path: src/render/core/post/exposure.ts, src/render/core/post/exposureMeter.ts, src/render/core/renderer.ts (where the meter runs)
Blocking: yes

## Problem
The exposure follows the effects. The histogram is built from the final HDR target, after `drawTransparent`,
at every pixel with geometry depth, so an engine plume, plume-lit steam, a splash crown, a fireball or an
ignition flash drawn OVER geometry is metered as if it were a lit surface; the 99th-percentile rule
(`HIGHLIGHT_CAP`, full weight from 2 % of the frame, `LIT_FULL_BRIGHT`) then stops the camera down until
the emitter is under white. A noon lift-off is rendered 2.5 to 3 stops under (navy sky, a pastel jet that
never clips or blooms), and the frame pumps by more than a stop when a splash, a fireball or a flash
enters it. This is item 1 (blocker) of `out/qa/wave2/vfx.md`; items 2, 8 and 9 cannot be judged until it
holds. The vfx package cannot work around it: a feature can only raise the exposure (hints), and dimming
the emitters would break their photometric values.

## Evidence
`out/qa/wave2/vfx.md` item 1 has the measurements. In short (8-bit sRGB medians of the matrix pictures in
`out/screens/vfx/`):
- same lab scene, day: sky (90,105,128) / ground (126,116,102) with a small engine at minimum throttle
  (`engine-lyra-d/sl-min.png`), sky (33,44,62) / ground (61,53,42) with the nine-engine booster
  (`engine-atlas-9m/sl-full.png`, `/labs/vfx/?scene=engine&engine=atlas-9m&altkm=0`). All seven pad
  pictures by day have the navy sky. Pixels at 250 or more in all channels: 0.
- splash (`/labs/vfx/?scene=splash`): the sky's red channel goes 208, 135, 104, 89, 117, 144, 161 at
  before, +0.1, +0.4, +1, +1.8, +2.5, +5 s, with white water on about 1 % of the frame.
- explosion by day: sky 71 at 0.03 s, 113 at 3.5 s. Vacuum ignition: lab ground 90, 60, 111.
- `renderer.exposureInfo()` in the integration lab during reentry over a sunlit Earth: EV100 16.50 = `EV_MAX`.

Real footage: a daylight launch keeps sky, pad and terrain at the daylight exposure and the flame clips
(`out/qa/ref/liftoff-ascent/artemis2-launch-2.jpg`, `apollo4-liftoff.jpg`); recovery footage does not react
to the splash.

## Requested change
1. Meter what is LIT, not what EMITS: build the histogram from the HDR target BEFORE the transparent pass
   (after `compositeAtmosphere` / `preTransparent`, before `drawTransparent`), or give features a way to
   mark emissive transparents as not metered. Water (`drawWater`) and clouds stay in. What a plume lights
   (ground, hull, through the local lights) is geometry and stays metered, which is what a night launch
   needs: the camera exposes for the plume-lit pad and the jet clips.
2. Bound highlight protection while the sun lights the scene: with `sunVisibility > 0` and something lit in
   view, the 99th-percentile term may raise the target to at most `evSun + 0.5` EV (sunlit white, albedo
   0.9, sits at 0.9 of white at sunny-16: half a stop covers snow, cloud tops and a white hull). A flame
   then clips by two to three stops and blooms, as in every daylight launch photograph. In a dark scene
   (sun down or eclipsed: `evSun` at the floor) the rule stays as it is.
3. If (1) is not possible: make the highlight term a statement about area, so that small highlights clip
   instead of driving the meter (for example the 99th percentile only counts when the pixels above the
   cap cover more than 5 % of the lit pixels), together with (2).

Must not change: `addEmissiveHint` (emitters over the sky still need it; with (1) vfx will send the hint
for emitters in front of geometry as well, with a cap that depends on the sun's illuminance at the
camera), interior metering, the adaptation rates, the request vfx-3 behaviour at night (a lit area brighter
than the prior takes over from 2 %: with (1) that area is the plume-lit ground, not the flame).

Acceptance I will add on my side (`tests/browser/vfx/exposure.spec.ts`): the sky luminance of the pad scene
changes by less than 0.5 EV between engines off and engines on by day; the sky's pixel value stays within
+-5 % through the splash sequence.
