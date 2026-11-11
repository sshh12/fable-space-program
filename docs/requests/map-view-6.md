Status: open
From: map-view
Owner path: src/render/atmosphere/** (clouds, atmosphere-clouds), src/render/terrain/** (the Moon's far field, terrain-render), src/render/sky/** (stars in the map camera, sky-lighting)
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
