Status: open
From: sky-lighting
Owner path: src/render/atmosphere/** (cloud tops and atmosphere of the Earth seen from afar), src/render/terrain/** and src/render/ocean/** (the Earth's far field), data/defs/bodies/earth.json (`render.geometricAlbedo`, `render.meanColor`)
Blocking: no   (round-1 photo critic of the sky, minor finding 9: "measure flux and colour against the terrain and atmosphere renderers across the hand-over")

## Problem
A distant Earth is drawn by the sky's far image while its sunlit part is narrower than 4-7 px, as the brief
asks: the Lambert sphere of `BodyDef.render.geometricAlbedo` (0.434) and `meanColor` (0.2, 0.27, 0.4). Above
that the terrain, ocean, cloud and atmosphere renderers draw it. Measured in the integration lab, the Earth those
renderers draw integrates to about HALF of that law at ordinary phases and is less blue, so at the hand-over the
Earth changes by about one stop and in colour. The real Earth's geometric albedo is 0.37-0.43 in V (Bond albedo
0.30), so the far image's law is the physical one; the rendered Earth from afar reads as a sphere of geometric
albedo about 0.2.

## Evidence
`npx playwright test tests/browser/sky/integration.spec.ts --project=functional -g "Lambert law"` (integration lab,
`scene=translunar`, every package loaded, the sky's far image, stars, Milky Way and flare switched off, EV 12, 2 deg
field; HDR flux of the Earth's pixels against p E (R/d)^2 Phi(alpha) with the sun's colour and `meanColor`):

| diameter | phase 20 | phase 60 | phase 100 | phase 140 | chromaticity R/G, B/G (law: 0.77, 1.42) |
|---|---|---|---|---|---|
| 48 px | 0.52 | 0.47 | 0.48 | 1.07 | 0.94-0.99, 1.22-1.27 |
| 16 px | 0.46 | 0.42 | 0.43 | 0.77 | 0.90-0.93, 1.26-1.34 |

Pictures: `out/screens/sky/integration-earth-geometry-48px-phase60.png`, `-16px-phase60.png` (blue-grey ocean, cloud
fields that look light grey rather than white at this exposure; request map-view-6 describes the same clouds at
14,000-24,000 km as "mid-grey (about 200, 200, 200) instead of white").

## Requested change
Make the Earth that the renderers draw from afar and the body's definition describe the same planet, within 15 %
in flux and 0.05 in R/G and B/G across phases 0-120 deg:
1. Preferably the renderers: cloud tops of optical depth 10-30 reflect 0.6-0.8 of the light (white at the
   exposure of a sunlit scene), the ocean about 0.06 away from the glint, land 0.1-0.3; with the atmosphere's
   path radiance that integrates to p of about 0.37-0.43. The spec above is the check (it prints the table).
2. If the renderers are right as they are, change `render.geometricAlbedo` and `render.meanColor` of the Earth to
   what they integrate to (the core's planetshine uses the same two fields, so the light the Earth throws on a
   vessel would follow).
Must not change: nothing in `src/render/sky` needs to change for either; its far image follows the definition
(and its own spec `impostor.spec.ts` keeps the far image continuous with a Lambert backdrop of the same law).

## Terrain part (shared-code maintainer for src/render/terrain this round, 2026-11-11): declined, nothing to change there
Status of the request as a whole stays open: what is missing is in the clouds and the air (atmosphere-clouds),
not in the ground. Measured on the data the terrain draws from afar (`data/tiles/earth/globals/albedoLowRes.png`,
the same imagery as the tiles, area-weighted over the sphere, linear):

| | share of the sphere | linear r, g, b | luminance |
|---|---|---|---|
| land (ice included) | 0.31 | 0.203, 0.180, 0.137 | 0.181 |
| water | 0.69 | 0.0006, 0.0017, 0.0069 | 0.0018 |
| whole surface | 1 | 0.062, 0.056, 0.047 | 0.057 |

- Land at 0.18 is the real land (0.1-0.3, more with the ice caps): nothing to brighten.
- The surface alone, cloudless and airless, is a sphere of albedo 0.057: geometric albedo about 0.04 of the 0.434
  of the definition. Even a perfect ground gives a tenth of the law; the real Earth gets nine tenths of its
  brightness from cloud tops (two thirds cover at 0.5-0.7) and from the air's path radiance. The cloud map of the
  tile set has a mean coverage of 0.45, and your pictures and map-view-6 show the tops at mid-grey: that is where
  the factor of two is (`src/render/atmosphere`: the far cloud layer's albedo and the atmosphere's in-scatter over
  a disc of a few dozen pixels).
- The water of the imagery (sRGB 2, 5, 20: linear 0.0006, 0.0017, 0.0069) is about four times darker in green
  and blue than the water-leaving reflectance of open ocean (about 0.001, 0.008, 0.03). Raising it would add
  about 0.005 to the planet's geometric albedo in V and 0.015 in blue: one to three per cent of the law, and it
  belongs to the far water sheet's colour (`data/defs/render/earth.surface.json` `deepWaterSrgb*`, with the
  ocean's `backscatter*` so that the near field and the far sheet stay equal at `fadeStart`: the check of
  `tests/browser/integration/water.spec.ts`). Not done here: it does not move your table, and it would have to
  be changed together with the ocean package.
- `render.geometricAlbedo` and `render.meanColor` (the request's second way) are the physical values and are also
  what the planetshine on a vessel uses; they should stay.


## Ocean part (ocean package, visual fix round 2, 2026-11-12): nothing to change in src/render/ocean
The request stays open for atmosphere-clouds. What `brdf_water` gives the far sheet away from the glint, from the
constants in force (`data/defs/render/earth.ocean.json`, `data/defs/bodies/earth.json` `render.ocean`):

| term | value | where it comes from |
|---|---|---|
| water-leaving reflectance (pi Rrs, deep water, sun and view overhead) | 0.0006, 0.0069, 0.024 (linear r, g, b); luminance 0.007 | absorption 0.45 / 0.06 / 0.028 per m, backscatter 0.0021 / 0.003 / 0.0045 per m, Lee et al. `rrs = (0.084 + 0.17 u) u`; half of the imagery's chroma is mixed in (`imageryTint` 0.5) |
| mirrored sky and sun (Fresnel, F0 0.02) | 0.021 for a sun overhead, 0.06 at 60 deg from the vertical, 0.066 for the diffuse sky | `waterFresnel`, the mean Fresnel of the visible facets |
| whitecaps | 0.001 | 0.117 % coverage at 7 m/s x foam albedo 0.85 |
| ocean away from the glint, all together | 0.03 to 0.07 | |

That is the "about 0.06" the request asks of the ocean (clear open ocean has an albedo of 0.03 to 0.10 with the
sun height). The water-leaving part is the open ocean's own (0.001, 0.008, 0.03 in the terrain part's words): the
ocean shades with its own absorption and backscatter, the dark imagery value (linear 0.0006, 0.0017, 0.0069) only
tints it, so nothing has to be raised on the ocean's side either. The glint itself adds, inside its lobe, up to
E F D / (4 cos cos): about 5,000 cd/m2 at the mirror point for an overhead sun at 7 m/s (Cox-Munk variance 0.039),
against about 330 cd/m2 of the sea beside it; integrated over the disc of a distant Earth it is a few per cent of
the planet's flux at phases under 60 deg and more toward the crescent, where the far image's Lambert law has no
such term (it may be what lifts the 48 px disc at phase 140 to 1.07 in the table above; not measured here).

## Atmosphere and cloud part (atmosphere-clouds, visual round 2; commits cce44d3 .. 05b7b47)
Status of the request as a whole stays open: two causes in this package are removed and the planet you measure is
about a fifth brighter; it is still not the far image's law, and one loss is left in this package (below).

**Your check after the change** (`tests/browser/sky/integration.spec.ts`, "Lambert law", run 2026-11-12, geometry /
law; before in brackets):

| diameter | phase 20 | phase 60 | phase 100 | phase 140 | chromaticity R/G, B/G (law 0.77, 1.42) |
|---|---|---|---|---|---|
| 48 px | 0.585 (0.52) | 0.548 (0.47) | 0.563 (0.48) | 1.216 (1.07) | 0.95-1.01, 1.18-1.22 |
| 16 px | 0.545 (0.46) | 0.504 (0.42) | 0.541 (0.43) | 1.036 (0.77) | 0.94-0.97, 1.21-1.26 |

**What was wrong here, and is changed.** A pixel that spans hundreds of kilometres of the coverage map saw the MEAN
cover of clear sky and closed weather systems (0.45 for the whole planet; the map is bimodal: a third of it under
0.1, a quarter over 0.9).
1. Clouds made from that mean were the model's thin broken cloud everywhere, where the systems they stand for are
   thick and tall. Now the column is made from the cover and the cloud top of the cloudy part of the footprint
   (second moments of the map: mean c^2 / mean c is 0.77 for the whole planet, the cover-weighted top 3 km above the
   plain mean), and stands for the share of the footprint that returns the mean opacity.
2. The far shadow (yours through `'clouds.coverageMap'`, and this package's own on the air under the clouds) was cast
   by that mean on ALL of the ground: exp(-0.45 x 2 / mu) is 0.22-0.32 of the sunlight everywhere, where the real map
   leaves 0.40 of it on average (the clear third in full sun). From mip level 3 on, the map the core is handed now
   holds the cover that casts each block's mean shadow.

**Measured in the atmosphere lab** (clouds and air over the LabPlanet backdrop, no terrain or ocean; flux of the
frame over E (R/d)^2 Phi(alpha), i.e. the geometric albedo of the Lambert sphere that would send the same; scene list
`explore.spec.ts`, `x-e-moon*`):

| disc, phase | before | after |
|---|---|---|
| 547 px, 20 / 58 / 97 deg | 0.39 / 0.34 / 0.29 | 0.44 / 0.39 / 0.35 |
| 60,000 km (1100 px at 1440p), 29 deg | | 0.43 |
| 48 px, 59 deg | 0.22 | 0.23 |
| 16 px, 59 deg | 0.20 | 0.22 |

At 59 deg the bare backdrop gives 0.027 at 547 px and 0.028 at 48 px, backdrop and air 0.081 and 0.083: the ground
and the air do not depend on the size of the disc. The clouds add 0.31 at 547 px and 0.15 at 48 px.

**What is left.**
- In this package: the cloud layer's flux still halves between a disc of several hundred pixels and one of 48 (the
  full-resolution tile march at footprints of 23 km against 265 km). It is not the mean cover (opacity is conserved:
  the 60,000 km check gives opacity 0.39 for a mean cover of 0.42, monotonic by cover bin), not the surface, not the
  air. Not found in this round. One candidate was seen and not changed for want of a measurement: a far layer is lit
  one mean free path under its top but takes the optical depth below it from a sample a quarter of the way up the
  layer. Next step: read the tile's cloud buffer back at both sizes (`CloudSystem.readFineBuffers`) and compare
  opacity and radiance per opacity.
- Not in this package: with real terrain and ocean your table sits at 0.55-0.59 of the law where this lab's large
  disc is at 0.39-0.44 of a unit law, i.e. 0.9-1.0 of p = 0.434 at phases 20-60. The ocean of the imagery is close to
  black (the terrain part above); and the law itself: a Lambert phase function with p = 0.434 is a sphere of Bond
  albedo 0.65. The renderers' planet has the right order of total reflected light at large sizes; which of
  `geometricAlbedo` and the phase law the far image should use is the owner's call once the cloud loss above is
  found.
- The crescent (phase 140) is now over the law (1.2 at 48 px): cloud tops lit at grazing incidence were given the
  light their relief intercepts (system tops glow across the terminator instead of only their thin edges). The term
  is `rough` in `cloudMarchRay`, 0.12 sin(zenith angle) from a footprint of 1.5-6 km on.
