Status: open
From: vehicle-pad
Owner path: src/render/terrain (sitePlan.ts and its twin in shaders/surface.ts, the ground cover's site mask); data/defs/sites/ka-lae.json (the areas of the pad shape, lead-owned) if the owners prefer to level under the roads
Blocking: no (the blocker of `docs/qa/wave2/vehicle-pad.r1.combined.json`, finding 1, is fixed on my side; this is the other half of "give the ground one owner")

## Problem
Since `pad.shape` (request terrain-render-6) the terrain inside the site is level only on the hardstand core
(115 m) and five areas; elsewhere a quarter of the natural relief is kept (measured: -2.1 .. +2.8 m about the
pad plane inside the fence, hummocks of 0.1 to 0.3 m at metre scale). The site feature's roads, stone pads
and berms assumed the pad plane and were buried (`game-site-tank-farm-low.png`, `game-site-aerial.png` of
2026-11-12 01:24). My side is done: every earthwork is now built on a survey of the height authority
(section `visuals/sites/<siteId>`, written by `tools/vehicle/site-ground.ts survey`; roads on fill over the
highest ground under them, shoulders and feet under the lowest; `site-ground.ts verify` checks the survey
against the tiles; unit test in `tests/unit/vehicle/site.test.ts`). What is left is yours:

1. The terrain's ground cover and loose rocks do not know the roads, the fence line or the stone pads, so a
   shrub or a boulder can stand in the asphalt (the site plan keeps cover off its own shapes only).
2. The terrain paints its own compacted shoulder and gravel under parts of the complex but natural lava right
   up to the road shoulders; a strip of disturbed soil along the earthworks would join the two.
3. The survey has to be re-run whenever the height function changes inside the site (tiles, pad shape,
   amplification): the roads are fill over the surface as it was surveyed.

## Evidence
`data/defs/sites/ka-lae.structures.json`: the structure `pad.groundworks` carries `roads`
("x,z>x,z>...@width~fillet;...", site frame: x east, z SOUTH, metres from the pad centre), `pads`
("x,z,radius" or "x,z,halfX,halfZ,headingDeg"), `radius` (the stone field, a ring to about 110 m), `tracks`;
the structure `pad.fence` carries `path`. `npx tsx tools/vehicle/site-ground.ts radial` prints the relief.
Views after the fix: `out/screens/vehicle/game-site-aerial.png`, `game-site-tank-farm-low.png`,
`game-site-perimeter-road.png`.

## Requested change
- Site plan: read the road polylines and pads of a structure that has a `roads` / `pads` parameter (by
  parameter name, as you do for slabs): keep ground cover, trees and loose rocks off a corridor of the road's
  width + 8 m (the embankment's feet are 6.2 m either side of the centre line plus half the width) and off the
  pads + 6 m; and off 1.5 m either side of a `path` of a structure that has one (the fence line).
- Optional: paint that corridor as disturbed, compacted soil (your shoulder material) with a ragged edge.
- Tell me (a line in this file or a NOTICE) when the height function changes inside a site, so that I re-run
  the survey; or call `npx tsx tools/vehicle/site-ground.ts verify` (exit code 1 when the survey no longer
  bounds the terrain) from your own checks.

Must NOT change: the height function under the complex for the sake of the roads (they follow it now; a
change makes the survey stale), the level core and areas, collision = render.

Workaround in my paths: none needed for the geometry. Cover on the roads stays until the plan knows them
(none stands on the asphalt in today's pictures; the plan's own shapes already clear the pad and the farms).
