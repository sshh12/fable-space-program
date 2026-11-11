Status: open
From: core-support (cross-feature check (c), `tests/browser/integration/shadows.spec.ts`)
Owner path: src/render/terrain (`drawShadow`: caster selection for `fit: 'body'` cascades)
Blocking: yes        (check (c) "lunar terminator from 20,000 km and 5,000 km shows crater shadows" and "approach through 1,500 km without a pop" fail)

## Problem
The terrain's casters in the whole-body cascade are the coarsest tiles (level 0-1: one mesh vertex every
21-43 km on the Moon), so that cascade holds no crater or mountain relief although its texels are 1.9 km.
Two consequences:

1. The lunar terminator from 20,000 km and 5,000 km has no cast shadows: the frame is the same with and
   without the terrain drawing into the cascades. What relief shows is the normal map's shading.
2. On approach, when the first camera-fitted far cascade (1,465 m texels, with finer casters) appears at
   1,500 km, shadows that were not in the body cascade appear within one step.

Violated: ARCHITECTURE 10.1 "Distant bodies" ("the far cascade is refitted to that body's sunlit disc ... so
crater and mountain shadows define the terminator from any distance. The hand-over to camera-fitted cascades
on approach is continuous ... no pop through 1500 km") and your brief ("draws into every cascade handed to
drawShadow, including `fit: 'body'` cascades covering a whole distant body (select casters at a level
matched to that cascade's texel size ...)"; acceptance view "the lunar TERMINATOR from 20,000 km and
5,000 km (crater and mountain shadows present)").

The render core's side is in place and tested with a lab ridge (`tests/browser/render-core/shadows.spec.ts`,
"a body-fixed ridge on a Moon-sized LabPlanet casts a visible shadow at the terminator from 20,000 km, and
an approach through 1,500 km shows no pop"): the body cascade is handed to `drawShadow`
(`cascade.fit === 'body'`, anchor `body:moon`, texel 1,878 m) and sampled by the lighting.

## Evidence
```
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/shadows.spec.ts --project=functional -g "terminator|approach"
```
Features terrain + sky, frozen time, no jitter, half phase (`viewBodyAtPhase('moon', 90, ...)`), the Moon
510 px across. Same frame with `&noshadow=terrain` (the lab then registers the terrain without its
`drawShadow` hook); a lit pixel counts as shadowed when its luminance falls below half:

| View | Lit pixels | Shadowed by the terrain's casters | Terrain statistics (`debug.stats().bodies.moon`) |
|---|---|---|---|
| 20,000 km, field of view 13 degrees | 96,606 | **12 (0.01 %)** | 6 tiles selected, deepest level 0 |
| 5,000 km, field of view 40 degrees | 105,010 | **23 (0.02 %)** | 12 tiles selected, deepest level 1 |

(At 5,000 km with the default 60 degree field: 6 tiles, level 0, `casters: 6`.) Screenshots:
`out/screens/integration/shadows-terminator-5000km.png` and `...-no-terrain-shadows.png` (the same picture
but for one lit peak beyond the terminator), `shadows-terminator-20000km*.png`.

Approach straight down over 32 S 12 E with the sun 8 degrees up, 3,000 km to 800 km in 88 steps of 1.5 %,
the field of view widened so that the same 600 km of ground stay in the frame: the largest change of a
16 px block is 8-10 of 255 per step everywhere except in the step in which cascade `4:camera` (1,465 m
texels) joins `2:body` (1,878 m): **28.1** (block at 432, 304 of 1280 x 720). With `&noshadow=terrain` that
step is 8.3 like its neighbours. Numbers: `out/core-support/integration-results.json`, keys
`c.terminator.*` and `c.approach`; screenshots `shadows-approach-1497km.png` and its neighbours.

Lab URL: `/labs/integration/?features=terrain,sky&scene=lunarOrbit&paused=1&hud=0&ev=13.5&governor=off&fov=40&probe=casters`,
then `window.__integration.viewBodyAtPhase('moon', 90, 1737400 + 5e6)`; `window.__integration.cascadeLog()`
lists the cascades handed to `drawShadow`.

## Requested change
Casters of a `fit: 'body'` cascade at the level that matches its texel size (about level 4-5 for the
Moon's 1.9 km texels), at least in the band of low sun elevation where shadows are long; where such tiles
are not resident, load them for the cascade or say in your hand-off what resolution the body cascade gets.
The same casters, or casters of the same level, in the body cascade and in the camera-fitted far cascade
where the two overlap, so that the hand-over shows nothing. The spec asserts: more than 0.4 % of the lit
pixels shadowed at both distances, lying along the terminator, and no step of the approach above three
times its neighbours. Must not change: staggered cascades hold body-fixed casters only; the budget line
"Terrain shadow casting (amortised)" of ARCHITECTURE 17.1.
