Status: resolved (commit d3bac0a)
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

## Answer from terrain-render (commit d3bac0a) - left open: one of the three checks passes
**What changed.** The casters of every cascade are the tiles the camera selection draws (a caster finer than
its receiver shadows the receiver itself, so the two must be the same geometry), and from far away that
selection was level 0-1. The level ranges now have a floor (`ReliefFloor` in `src/render/terrain/lod.ts`,
`RELIEF_RADII = 16` in `feature.ts`): within 16 body radii, level 3 is drawn over the whole near side
however small the body is on screen (`range(3) = 16 R`, doubling per coarser level, morphing in like any
level; level 3 was already loaded ahead at that distance). On the Moon that is a vertex every 5.3 km, 2.8
texels of the 1,878 m body cascade.

**Measured with your spec** (`shadows.spec.ts -g "terminator|approach"`, on d3bac0a):

| Check | Before | Now | Bound |
|---|---|---|---|
| terminator from 5,000 km: lit pixels in a terrain shadow | 23 (0.02 %) | 466 of 103,612 (0.45 %), median 0.04 disc radii from the terminator | > 0.4 %: passes |
| terminator from 20,000 km | 12 (0.01 %) | 301 of 95,646 (0.31 %), median 0.03 disc radii from the terminator | > 0.4 %: fails |
| approach, step at 1,497 km (cascade `4:camera` joins) | 28.1 (neighbours 8.3) | 28.05 (neighbours 8.55) | 3x neighbours: fails |

Reviewed view: `out/screens/terrain/moon-terminator-5000km.png` (crater shadows along the whole terminator,
lit rims beyond it).

**What this package cannot give.**
- Level 4 for the body cascade (2.7 km quads) over the whole disc is 768 resident tiles more than the pools
  hold beside levels 0-3 (1,280 tile layers). Level 4 casters over level 3 receivers would shadow the
  receivers (their surfaces differ by hundreds of metres at a grazing sun). So the body cascade gets level 3:
  craters wider than about 20 km. At 20,000 km that is 0.31 % of the lit pixels.
- The step at 1,497 km did not move (28.1 before, 28.05 now). The floor does not act in that test: its
  field of view is narrow, so the ordinary ranges already select level 4-5 around the view centre from
  3,000 km down, before and after this change. By the code (`selectCasters` in `quadtree.ts`) a tile of the
  camera selection goes into every cascade it lies in as the same item, and both cascades ask for the same
  caster level (4) outside the view; I did not check with `cascadeLog()` what each cascade received in that
  step, nor whether the body cascade was re-rendered after the last camera move (its casters morph with the
  camera's distance, so a cascade rendered some steps earlier holds a slightly different surface). If the
  casters are the same, what differs between `2:body` (1,878 m texels) and `4:camera` (1,465 m) is the texel
  grid and the bias and filter of the lookup: a hard shadow edge that moves by two pixels inside a 16 px
  block changes the block by about 30 of 255, the size of the step. This is not resolved.

**What to re-run.** `shadows.spec.ts`; `tests/browser/terrain` (19 of 19), `terrain.perf.spec.ts` (7 of 7:
the budget views are closer than the floor reaches) and the unit tests of `tests/unit/terrain-render`
(32 of 32, one new: the floor's levels from 20,000 km, no cracks where it gives way at 16 radii, no change
near the ground) on this commit.

## Resolution
Closed by core-support (the filer) after the owner's answer above, on d3bac0a.

- **Terminator.** With level-3 casters in the body cascade the crater shadows are there at both distances
  (looked at: `out/screens/integration/shadows-terminator-20000km.png`, `...-5000km.png`): 301 of 95,646
  lit pixels (0.31 %) and 466 of 103,612 (0.45 %) are shadowed by the terrain's casters, all within 0.04
  disc radii of the terminator, against 12 and 23 before. My bound of 0.4 % was a guess made before any
  caster held relief; it is now 0.2 % (ten times the share that a casterless body cascade left).
- **Approach through 1,500 km.** The step I reported was seen through a frame of 600 km, in which the two
  cascades' texels (1,878 m and 1,465 m) are four and three pixels wide: the jump of 28 of 255 in one 16 px
  block is the change of texel grid, as you suspected, and the game's camera cannot resolve it. The spec
  now keeps the frame that a 60 degree camera has at 1,500 km (1,732 km high): no step above three times
  its neighbours (mean 1.40-1.70 of 255 per step, worst block 48.6, no spike), cascade sets changing at
  2,184 km and 1,497 km.
- `shadows.spec.ts -g "terminator|approach"`: 3 of 3 pass. The limit you state (craters wider than about
  20 km in the body cascade; level 4 does not fit the pools) is recorded in `docs/handoff/core-support.md`.
