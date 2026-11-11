Status: open
From: core-support (cross-feature check (a), `tests/browser/integration/water.spec.ts`)
Owner path: src/render/terrain (the sea-level sheet: `TERRAIN_WATER_WGSL`, the water draw lists)
Blocking: yes        (check (a) "removing the ocean feature leaves the terrain's water intact" cannot pass)

## Problem
Over deep open ocean the terrain's sea-level sheet is not there near a low camera. Without the ocean
feature the frame then shows the seabed kilometres below instead of the sea (and, towards the horizon,
nothing at all where the horizon cull has removed the seabed too). With the ocean feature the forward
water hides most of it, but the G-buffer under the near field still holds water-material fragments far
below sea level where the contract says the seabed (or nothing) should be. Separately, the bare sheet shows
thin black dashed lines and pinholes along tile edges from 10-20 km up.

Violated: ARCHITECTURE 10.2, last line ("With no ocean feature present the default near field is empty and
the terrain's water is complete on its own"), and its first line (the sheet is drawn "from its quadtree
into the G-buffer with `MATERIAL_ID.water`" at sea level). The default `'ocean.nearField'` is
`bodyIndex = -1` (checked: `src/render/core/resources.ts`), so nothing asks the sheet to stand back.

## Evidence
Measured by the spec (G-buffer material id and the altitude of what the depth buffer holds on every pixel
at least 0.25 degrees below the sea horizon; frozen time, no jitter):

```
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/water.spec.ts --project=functional -g "without the ocean"
```

At 12 N 33 W (mid-Atlantic, clear in the cloud map), features terrain + sky + atmosphere, no ocean:

| Camera | Sheet at sea level | Water material below sea level | Terrain material (seabed) | No geometry |
|---|---|---|---|---|
| 200 m up, pitch -15 | **6.27 %** | 29.85 % | 63.38 % | 0.51 % |
| 3 km up, pitch -30 | 99.96 % | 0 | 0.04 % | 0 |
| 10 km up, pitch -20 | 99.83 % | 0.17 % | 0 | 0 |
| 14.2 km up | 99.99 % | 0.01 % | 0 | 0 |
| 20 km up | 100 % | 0 | 0 | 0 |

The same at two other places (earlier runs): 8 N 140 W, 200 m up: within 500 m of the eye 100 % terrain
material; 1-2 km: 100 % water material at the SEABED's altitude (-5.1 to -5.3 km, reconstructed from depth);
2-4 km: 27.6 % sheet, 61 % water material at depth, 11.4 % no geometry; from 4 km outwards the sheet is
complete. 3 km up: 4 % (2-4 km) and 10 % (4-8 km) terrain material. 8 km up and above: complete. The
terrain's own statistics at 200 m: deepest level 12, 52 visible tiles, 52 water tiles; at 3 km: level 11;
at 8 km: level 10 (where it is complete). 12 N 56.8 E, 200 m up: 18.7 % sheet, 6.8 % water material below
sea level, 74.5 % seabed.

With the ocean present (same views, 12 N 33 W, 200 m up) the G-buffer inside fadeStart holds 63.4 % terrain
material (right: the seabed) and 29.8 % WATER material (wrong: the same misplaced fragments as without the
ocean, nearly all of them closer than `fadeStart`; the near-field discard does not remove them).

Thin lines in the bare sheet (features terrain + sky): pixels at least 20 % darker than both neighbours
along a row or a column: 59 at 10 km up, 6 at 14.2 km, 65 at 200 m (12 N 33 W); 130 at 14.2 km at 8 N 140 W,
where they form two dashed lines meeting in a tile corner: water-material pixels 150-200 m BEHIND the sea
surface along the ray, luminance 0.0002-0.002 against 0.04 around them; at 10 km up there, 356 pixels of
terrain material at 21.3 km range where the sea surface is at 14.0 km (holes).

Lab URLs (1280 x 720):
- seabed instead of sea: `/labs/integration/?features=terrain,sky&scene=lowOrbit&paused=1&hud=0&ev=14&governor=off&sun=120,40&sunsite=earth,8,-140&body=earth&lat=8&lon=-140&alt=200&heading=300&pitch=-15`
  (`window.__integration.showGBuffer('material')` puts the material id into the green channel of the HDR target)
- dashed lines: the same with `&alt=14232&heading=120&pitch=-20`, bottom centre of the frame (x 755-767, y 672-676).

Screenshots: `out/screens/integration/water-without-ocean-200m.png` (the dark dome in the lower half is
the seabed; the flat blue band beyond it is the sheet), `water-without-ocean-sheet-14km.png`,
`water-climb-water-only-14km.png` (the lines show through the forward water's fade band as well).
Numbers of every run: `out/core-support/integration-results.json`, key `a.withoutOcean`.

## Requested change
Without an active near field every pixel of an ocean body's sea is the deferred sheet at sea level, at every
camera height from 2 m up, over open ocean as much as inside the regional coverage (the shoreline at the pad
is fine: `water.spec.ts`, "a shoreline from 200 m"). With an active near field, no water-material fragment
remains inside `fadeStart`. No black lines or holes along sheet tile edges. The spec asserts: sheet share
above 99.9 % and no pixel without geometry at 200 m, 3, 10, 14.2 and 20 km; fewer than 4 thin dark pixels
in the bare sheet. Must not change: the hand-over inside `fadeStart` when the ocean is present (the forward
pass finds the real seabed there: errors below 0.7 m at 46 points, same spec) and the coastline per pixel
from the mask.
