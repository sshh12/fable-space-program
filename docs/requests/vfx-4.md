Status: resolved (commit 5d3e0ee)
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

## Resolution
Items 1 and 2 are in (commit 5d3e0ee); item 3 was not needed.

**1. The meter sees what is lit.** `renderer.ts` builds the histogram right before `drawTransparent`
(frame graph step 8b in RENDER_API section 2): opaque geometry, `drawWater`, the atmosphere and cloud
composite are in it, nothing a feature draws in `drawTransparent` is. What a plume lights through the local
lights is geometry and stays metered. Measured with a new lab probe (`?probe=flame`: an additive
transparent of 2e7 cd/m^2 over 9 % of a frame of sunlit ground,
`tests/browser/render-core/exposure.spec.ts`, "the meter sees what is lit"): exposure target 13.02 before
and 13.02 with the flame, the flame at 254-255 of 255. With the histogram where it was, the same test moves
the target by 2.55 EV even with item 2 in place.

**2. Bounded under the sun.** `SUNLIT_HIGHLIGHT_MAX_EV` = 0.5: while the sun lights the scene the exterior
histogram target (the mean term as well as the 99th percentile: a few per cent of the frame at a hundred
times sunlit white move the mean by stops) and the emitter term of the prior may not exceed
`sunny16Ev(illuminance x visibility) + 0.5`. "While the sun lights the scene" is a weight, not a switch:
`smoothstep(0.05, 0.3, sunVisibility)` when something lit is in view, so the bound is whole from 30 % of the
disc, absent under 5 % (a sliver over the limb, an eclipse, night), and comes in between. Interior metering
does not know it.

`addEmissiveHint` is unchanged in signature and rule; its comment and RENDER_API section 13 now say that a
hint is the only way an emitter reaches the meter, in front of geometry or of the sky, and that by day a
hint cannot raise the target beyond sunny 16 + 0.5 EV. So a hint for a flame in front of the pad by day is
harmless (it clips, as you want), and at night it does what vfx-1 and vfx-3 specified: those tests pass
unchanged (`exposureGovernor.test.ts`: "at night, in an eclipse and under a sliver of sun the protection is
whole").

Side effect you may meet in other packages' pictures: a daylight frame whose metered mean was brighter than
sunlit white allows (a cloud deck, snow, a white hull filling the frame) used to be pulled down to about a
third of white and is now shown at half to two thirds (up to 0.65 EV brighter). Dark-ground daylight scenes
are metered as before (their target is below the bound), so a plume-lit patch that covers more than 1 % of
such a frame can still stop the camera down from there to sunny 16 + 0.5 EV, and no further.

Unit tests: "highlight protection is bounded while the sun lights the scene (request vfx-4)". Not re-run
by me: `tests/browser/vfx` (your shaders were mid-edit while this was verified: `vfx.foam` did not
compile). The render core's browser suite passes.
