Status: resolved (6587a0d, by atmosphere-clouds; withdrawn by the filer)
From: terrain-render
Owner path: src/render/ocean/** or src/render/atmosphere/** (bisected to the pair: the picture is right with either one alone)
Blocking: no

## Problem
Seen from 30 m over the launch site (the first seconds of the lift-off), the ground 100-300 m south-east of
the pad carries a stair-stepped region 0.6 times darker than the ground around it (same hue: R/B 1.16 against
1.15), with straight edges in the shapes of quadtree tiles. The terrain draws the same ground evenly: the
region is absent with the terrain alone, with the terrain and the ocean, and with the terrain, sky and
atmosphere; it appears only when ocean AND atmosphere are loaded. The ground there is 21.6 m above sea level
and 600 m from the shore, inside the ocean's near field (`fadeStart`). A darkening of the same hue that
leaves the texture unchanged looks like a shadow term (cloud shadow?) evaluated at a wrong position or with
a wrong mask on some tiles of the near field.

## Evidence
`npx playwright test tests/browser/terrain/integrated.spec.ts --project=functional` with
`INTEGRATED_VIEWS=30m` writes `out/screens/terrain/integrated-30m.png` (the region: x 1350-1920, y 260-530).
Integration lab URL of that view: `/labs/integration/?features=terrain,sky,atmosphere,ocean&scene=pad&paused=1&body=earth&lat=18.985956&lon=-155.604439&alt=51.62&heading=40&pitch=-22&sun=105,31&sunsite=earth,18.987556,-155.603239`.
The bisection (same URL, `features=` changed, screenshots saved by a probe of this package and looked at):
- `terrain`: no dark region
- `terrain,ocean`: no dark region
- `terrain,sky,atmosphere`: no dark region
- `terrain,sky,atmosphere,ocean`: dark region, the same shape in two runs
Stats of the screenshot: inside the region sRGB 94,87,81 (Y 0.104), beside it 122,114,106 (Y 0.177).

## Requested change
Find which pass darkens those pixels when both features are loaded (the terrain writes the same G-buffer in
all four runs) and make the ground beside the shore evenly lit: no tile-shaped steps in the lighting of
land that is above sea level. Must not change: the near-field hand-over (the terrain discards its sea sheet
and writes no water inside `fadeStart`), the cloud shadows themselves where they are right.

## Resolution
Withdrawn by terrain-render. The region was the staircase of the cloud shadow map under a low sun, which
atmosphere-clouds removed in 6587a0d ("the map the render core reads is the marched one filtered as mean
transmittance over a tent ... no texel staircase from orbit, no combs or saw teeth at low sun"), committed
while this request was being written. The bisection above was misleading: the clouds' shadow over that
ground differed between runs. Re-rendered on 6587a0d with all four features (`INTEGRATED_VIEWS=30m`): the
ground south-east of the pad is evenly lit, no tile-shaped step (`out/screens/terrain/integrated-30m.png`).
Nothing to do for the owners.
