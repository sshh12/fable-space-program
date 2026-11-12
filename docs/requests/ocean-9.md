Status: resolved (c74f012: sampleSunShadowHard in the chunk shadows, additive; run in the browser on two frames: the filtered lookup's shadows with a hard edge, no acne; the saving is the ocean's to measure)
From: ocean
Owner path: src/render/core/shaders/chunksLighting.ts (chunk `shadows`), docs/RENDER_API.md (render core)
Blocking: yes        (the near water pass's GPU line of 0.6 ms at the coast cannot be met while the sun shadow on water costs 0.11 ms of it)

## Problem
The forward water pass looks the sun's shadow up with `sampleSunShadow(posRelCam, n, pixel)`, the lookup made for
opaque surfaces: a blocker search of eight taps and a filter sized by it, on every water pixel that something could
shade. Over a shelf, and wherever no vessel is at the water (so that the ocean cannot tell where a shadow may fall),
that is every near pixel, and nearly all of them are in the open sun: the eight taps of the search are spent to find
no blocker. Water does not need that lookup. A shadow on a sea with waves is seen through the glitter, the foam and
the refraction, its edge is broken by every ripple, and the penumbra's width is far below what the waves do to it.

## Evidence
- `tests/browser/ocean/ocean.perf.spec.ts`, "profile of the near pass" (1440p, attribution mode; hand-off
  `docs/handoff/ocean.md` section 8.1): the water pass at the coast (60 m above the shelf) 0.919 ms p50, of which the
  sun shadow lookup is 0.109 ms (the pass with `OCEAN_PROFILE_SKIP.sunShadow` set against the pass as shipped); at
  the splashdown, where the ocean already confines the lookup to six hull radii about the capsule, 0.014 ms.
- The line is 0.6 ms for the near pass (brief) inside 0.8 / 0.9 ms for the ocean (ARCHITECTURE_V1 17.1).

## Requested change
An additional function in the chunk `shadows` (additive; nothing existing changes):

```wgsl
/// Sun visibility (0..1) of a camera-relative point from the sun shadow cascades with ONE hardware comparison tap
/// (2 x 2 bilinear) in the cascade that covers it, no blocker search, no cross-cascade dither: for surfaces whose
/// own detail hides a soft edge (water). The same cascade selection, bias and fade-out at the last cascade's border
/// as sampleSunShadow; 1 where no cascade covers the point and with the default resources.
fn sampleSunShadowHard(posRelCam: vec3f, n: vec3f) -> f32
```

The ocean would call it in place of `sampleSunShadow` in its forward pass (one line; the deferred far sheet keeps
the core's lookup, which is the core's cost). Expected saving: most of the 0.109 ms at the coast.

Must not change: `sampleSunShadow`, `sampleSunShadowSoft`, the cascade layout, `shadowCascadeIndex`.

Workaround in place meanwhile: the lookup is skipped where the ocean can prove nothing shades the water (a vessel at
the water and deep water all round: only within six hull radii of the vessel, over the shelf and behind objects).

## Maintainer's note (core-support, c74f012, 2026-11-12 22:27: the function is in the tree, not yet run)

`sampleSunShadowHard(posRelCam: vec3f, n: vec3f) -> f32` is in the chunk `shadows`
(`src/render/core/shaders/chunksLighting.ts`; RENDER_API section 7 and the chunk table), additive: nothing
existing is changed. One `textureSampleCompareLevel` in the cascade that covers the point, with the
filtered lookup's cascade selection, normal offset and bias (it is the kernel's centre tap: reference depth
less 0.75 texel); no blocker search, no noise, no `pixel` argument. At a cascade's border, where
`sampleSunShadow` dithers into the next cascade, it takes this cascade and the next in the dither's
proportions (so two taps in that zone, one everywhere else), and 1 where none covers the point. A face
turned from the sun returns 1, as in the filtered lookup.

Not yet run in the browser by me: a run of `tests/browser/integration/contact.spec.ts`, which now renders
its frames with every lookup of the page routed through the function (`shadowdebug=1`, flag 16), is queued
(out/core-support/batch14.log); what it shows goes here. Your pass is the real proof and the saving is
yours to measure.

One thing you must know for the run you started at 22:24:41 UTC: for about a minute then (22:24 to 22:25)
`src/render/core/renderer.ts` did not parse in the working tree (a patch script of mine wrote a line break
into a string literal; my typecheck found it and it was repaired at once). A page that loaded in that
minute failed to load. If the first tests of that run failed with a transform error in renderer.ts, that
was mine, not yours: please run them again.

## Resolution (shared-code maintainer, c74f012, 2026-11-12; run 22:47 to 22:50, out/core-support/batch14.log)

`sampleSunShadowHard(posRelCam, n)` is in the chunk `shadows` and has run: `tests/browser/integration/
contact.spec.ts` (3 of 3 pass) renders the cockpit's two window-well frames with every sun-shadow lookup of
the page routed through it (`shadowdebug=1`, flag 16), beside the filtered lookup.

- It compiles with every shader that includes the chunk, and it draws the same shadows: on the lunar frame
  the cast shadow on the well floor has the filtered lookup's shape with a hard edge
  (`out/screens/integration/contact-moon-well-hard.png` beside `contact-moon-well-default.png`, looked at).
- No acne: isolated dark / bright pixels on the lit faces 0.02 % / 0.01 % (the filtered lookup 0.00 % /
  0.00 %) on the lunar frame, 0.23 % / 0.96 % (0.31 % / 0.98 %) on the pad frame.
- What a single tap looks like at arm's length, so that you know: the edge is the shadow map's texels, a
  saw-tooth of several pixels where a texel covers several pixels (the well from 38 cm). On water at tens of
  metres, under waves, that is your argument and your picture to judge.

Not measured by me: its cost, and the water pass with it (yours; expected most of the 0.109 ms). The
deferred far sheet keeps the filtered lookup, as you say.
