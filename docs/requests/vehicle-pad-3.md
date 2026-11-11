Status: open
From: vehicle-pad
Owner path: src/render/terrain (apron disc of a launch site: feature.ts:312-319, shaders/surface.ts:817-846), data/defs/render/earth.surface.json (apronRadiusM, apronEdgeM, apronShoulderM)
Blocking: no (visual close-out item 1 "the launch complex does not sit on the ground", blocker; the fix on my side does not depend on it, but the disc is the first thing the critics named)

## Problem
The terrain paints a launch site as an exactly circular disc of slab concrete, 140 m in radius, with a clean
one-pixel rim. The site feature's own apron is a 124 m square of cast concrete with joints, markings and a
flame trench; the tank farms, buildings, masts and the crawlerway stand outside the disc on unmodified imagery.
In the integrated game the complex therefore reads as a model on a grey plate: `out/screens/integration/
budget-pad-lift-off.png`, `shadows-pad-with-the-site-low-sun.png`. (The height field is fine: the baked terrain is
flat to 2 cm out to `pad.flatRadius` = 450 m, measured with `npx tsx tools/vehicle/site-ground.ts radial`.)

## Evidence
The two screenshots above; `src/render/terrain/feature.ts:318` (`radius: Math.min(params.apronRadiusM,
site.pad.flatRadius)`); item 1 of `out/qa/wave2/vehicle-pad.md`.

## Requested change
The graded area of a site is earthwork, not a slab. The site feature now draws every hard surface itself
(concrete hardstand, crushed-stone surround out to about 150 m, roads, pads under the tank farms; see
`docs/handoff/vehicle-pad.md`, "Visual close-out, round 1"), so what the terrain should paint under a site is
the cleared, compacted ground those stand on:

1. Paint the area inside `site.pad.flatRadius` (450 m here: the whole flattened disc, which today shows raw
   imagery on a perfectly flat plane) as graded ground: a compacted soil / crushed lava material of the body's
   own material set (no slab joints), albedo near the surrounding imagery's mean so that it reads as cleared land.
2. Its edge is not a circle: threshold the radius against low-frequency noise (lobes of 15-40 m, amplitude
   about 12 % of the radius) and feather it over 15-25 m into the natural cover, so vegetation and soil lap in
   irregularly.
3. If a slab disc is kept at all, make it optional per site in data (`apronRadiusM: 0` must stay supported, and
   is what this site wants once 1 and 2 exist).

Must NOT change: the flattening of the height field, `PadDisc` as the mechanism (centre + radius is enough).

Workaround in my paths: the crushed-stone surround of the site feature reaches beyond the 140 m disc and hides
its rim; the imagery between the surround and the tank farms stays as it is.
