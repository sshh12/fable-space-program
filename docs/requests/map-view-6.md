Status: open
From: map-view
Owner path: src/render/atmosphere/** (clouds, atmosphere-clouds), src/render/terrain/** (the Moon's far field and night side, terrain-render), src/render/sky/** (stars in the map camera, sky-lighting), src/render/ocean/** (sea colour at map distance, ocean)
Blocking: no   (round-1 photo critic of the map view, `out/qa/wave2/map-view.r1.photo.json`, major finding 5: "NOT this package's code; listed for routing")

## Problem
In map view the player looks at whole bodies from 7,000 to 1,000,000 km for minutes at a time, and next to a
photograph what gives the composite away is the planet under the overlay, not the overlay. From 14,000-24,000 km
the clouds are a blurred low-resolution mask with stair-stepped texel blocks, mid-grey (about 200,200,200)
instead of white, with no relief or shadows; there are rows of blue dotted speckle on the sea and a small teal
squiggle; the Moon's texture is smeared radially near the limb and its terminator is a soft gradient with no
crater shadows; no map-camera frame shows a single star.

## Evidence
`npx playwright test tests/browser/map-view/real-planet.spec.ts --project=functional` (through the gate) writes
the pictures; the critic's coordinates:
- `out/screens/map-view/real-lowOrbit-dayside.png`: cloud texel blocks x 780-830, y 60-200; teal squiggle x 743-750, y 113-140.
- `out/screens/map-view/real-lowOrbit.png`: blue dotted speckle x 560-590, y 470-500.
- `out/screens/map-view/real-lunarOrbit.png`: radial smear along the limb x 440-470, y 290-400.
- `out/screens/map-view/real-translunar.png`: no stars anywhere (map camera, 1.25e9 m).
References: `out/qa/ref/earth-orbit-clouds/cloudscape-philippine-sea.jpg` (crisp white cloud tops with shadows),
`out/qa/ref/sun-stars-space/moonset-limb.jpg` (sharp lunar limb, crater relief along the terminator),
`out/qa/ref/moon-surface/earthrise-a17.jpg` (white cloud bands readable at a few hundred pixels).

## Requested change
Each owner, for the camera kind `map` at the distances above: cloud coverage at a resolution that holds at
14,000 km (no texel blocks at 1 px per 30 km), cloud tops white at the map exposure; no speckle on the sea; the
Moon's far-field texture sampled without the radial smear at the limb and with terminator relief; stars in the
map camera at its exposure. The map overlay draws over whatever is rendered and needs no API change; map-view's
`real-planet.spec.ts` stays the acceptance view (it fails when a render package breaks the lab).

## Resolution (terrain-render's part: the Moon's far field)
The request stays open for the clouds and the stars. On the terrain side (commit of terrain-render's visual
close-out, round 1):
- **Radial smear at the limb.** The orbital-scale noise and the grain of the night lights are read
  unfiltered, and their octaves were faded by the pixel's size from its distance alone; towards the limb the
  footprint on the ground is many times longer than that, so octaves the pixel cannot resolve along the line
  of sight aliased into streaks there. Both now fade by the footprint's long axis (`footLong` in
  `src/render/terrain/shaders/surface.ts`), and the class lookup's warp octaves likewise.
- **Terminator relief.** Within 16 body radii (map distances included) the whole near side is drawn at
  level 3 and casts into the whole-body shadow cascade (hand-off section 3, "Relief floor"): craters wider
  than about 20 km cast shadows at the terminator. Since request `terrain-render-4` (c417fb0) the terrain
  asks the lookup to filter its own shadows over one render quad, so those shadows are smooth crescents,
  not polygons of the 5.3 km quads. Craters smaller than that cannot cast from level 3 (hand-off deviation
  1a: level 4 for the whole disc does not fit the pools); their relief shows through the normal maps.
- Looked at in the terrain lab at map distances: `out/screens/terrain/moon-60000km.png` (limb: foreshortened
  maria and craters, no streaks across them), `moon-terminator-20000km.png` and `moon-terminator-5000km.png`
  (crater shadows along the terminator). `real-planet.spec.ts` was not re-run by terrain-render (its
  screenshots belong to map-view); the map view draws the same feature, so the next run of it shows this.
- The "blue dotted speckle" and the "teal squiggle" of the low-orbit views: the squiggle at x 743-750,
  y 113-140 of `real-lowOrbit-dayside.png` is a small island group with its shelf, which the imagery holds;
  the speckle near the limb is not identified on the terrain side (water there is the far sheet's single
  deep colour, which has no speckle of its own).

## Update from map-view, round 5 (2026-11-11): the round-4 critics' measurements
Both round-4 critics of the map view (`out/qa/wave2/map-view.r4.photo.json` finding 1, `map-view.r4.artifact.json`
finding 2) still name the planet under the overlay as the first thing that gives the composed frame away. Their
numbers, for the owners:
- **Clouds (atmosphere-clouds).** In `real-lowOrbit-dayside.png` the cloud deck is mid-grey, median sRGB (182,180,178)
  against the ocean (77,85,106): about 5x in linear light, where `out/qa/ref/earth-orbit-clouds/cloud-gazing-pacific.jpg`
  measures cloud tops 13-16x the ocean (ocean (25,60,95), cloud median Y 0.39). In the 4K composed frame
  (`real-hud-lowOrbit-node-4k.png`, device px x 1340-1900, y 700-1230) the cloud mask shows square texel stair-steps and
  blurred edges next to the overlay's 3-device-px-per-interface-px lines; the reference has ragged, fractal edges.
- **Ocean colour (ocean / atmosphere at map distance).** Dull grey-blue (77,85,106) against the reference's saturated
  navy (25,60,95).
- **Earthshine on the Moon (terrain-render lighting).** In `real-hud-lunarOrbit.png` the night side x 480-640,
  y 300-420 is (18,17,16) against an unclipped crescent of (112,109,107): about 1/57 of the sunlit surface, with
  maria readable. With the crescent exposed correctly the earthshine side should be under about 1/1000 of it
  (`out/qa/ref/sun-stars-space/venus-moon-atlantis.jpg`: earthshine shows only because the crescent is clipped).
The map view needs no API change; `tests/browser/map-view/real-planet.spec.ts` stays the acceptance view and was
re-run on the current tree in round 5.
