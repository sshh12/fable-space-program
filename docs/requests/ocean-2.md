Status: resolved (commit 9debd1f)
From: ocean
Owner path: src/render/core/lab/labPlanet.ts (LabPlanet backdrop)
Blocking: yes (hand-over acceptance is judged "against the LabPlanet, which implements the terrain side of the rule")

## Problem
Inside `'ocean.nearField'.fadeStart` the LabPlanet replaces its water sheet by a seabed sphere at a FIXED 30 m
below sea level with a FIXED sand albedo (0.26, 0.23, 0.18), while the sheet it replaces describes water of
`mix(4, 400, ...)` m depth (encoded in RT2.a) and the map's ocean colour (RT0). The near field reads water
depth from `'scene.depthOpaque'` (the seabed) and, with request ocean-1, the imagery colour from the G-buffer
(the seabed fragment). With the current backdrop the water just inside `fadeStart` is 30 m deep and sand
coloured, just outside it is up to 200 m deep and ocean coloured: the forward and deferred images differ by
about 15 % in blue (computed with the default `brdf_water`), so the 2 % criterion at `fadeStart` cannot be
met against the backdrop, although it can against a terrain whose seabed IS the bathymetry the sheet encodes
and carries the albedo layer's colour.

## Evidence
`src/render/core/lab/labPlanet.ts` lines 103-120 (seabed: `hitSphere(..., h + seabedDepth, R - seabedDepth)`,
`albedo = vec3f(0.26, 0.23, 0.18)`; sheet: `param = encodeWaterDepth(mix(4.0, 400.0, ...))`, albedo = map).

## Requested change
Inside `fadeStart` (where the sheet is discarded), draw the seabed so that it describes the same water as the
sheet it replaces:
- depth below sea level = the depth the sheet would have encoded at that pixel, i.e.
  `decodeWaterDepth(encodeWaterDepth(mix(4.0, 400.0, saturate((0.12 - lum) / 0.09))))` (so at most 200 m),
  instead of the constant `seabedDepth` (keep the option as an override for labs that want a fixed depth,
  e.g. `seabedDepth: number | 'sheet'`, default `'sheet'`);
- RT0 albedo = the map colour the sheet would have written (the imagery colour of the water at that point);
  material `MATERIAL_TERRAIN`, wetness 1 as now.

Must NOT change: anything outside `fadeStart`, the sheet itself, the behaviour with the default near field
(bodyIndex -1: nothing discarded), the option names that exist.

## Resolution
Implemented as requested (core-support, commit 9debd1f), in `src/render/core/lab/labPlanet.ts`.

- `LabPlanetOptions.seabedDepth?: number | 'sheet'`, default `'sheet'`. In `'sheet'` mode the seabed drawn
  inside `'ocean.nearField'.fadeStart` lies `decodeWaterDepth(encodeWaterDepth(mix(4, 400, saturate((0.12 - lum) / 0.09))))`
  below sea level (the depth the sheet encodes at that pixel, so 4 m .. 200 m) and writes the map colour the
  sheet would have written to RT0; material `MATERIAL_TERRAIN`, wetness 1, as before.
- A number keeps the old behaviour: a sphere that many metres below sea level with the fixed sand albedo
  (0.26, 0.23, 0.18). The render-core lab takes it as `?seabed=<m>`.
- Unchanged: everything outside `fadeStart`, the sheet itself, and the default near field (nothing discarded).

**Migration**: a lab or spec that relied on the 30 m sand floor passes `seabedDepth: 30` to
`createLabPlanetFeature`. With the default you now get, just inside `fadeStart`, the same water column depth
(from `'scene.depthOpaque'`, measured along the local vertical: the seabed is a concentric sphere) and the
same imagery colour (from `'gbuffer.albedo'`, request ocean-1) as the sheet just outside it.

One thing to keep in mind when you compare the two sides: the sheet's depth saturates at
`WATER_DEPTH_ENCODE_MAX` (200 m), and so does the seabed, but the forward pass sees the path along the view
ray; use the vertical depth (or the same clamp) where you want equality with the deferred pixel.

Tested: `tests/browser/render-core/mesh.spec.ts` "LabPlanet: ... inside 'ocean.nearField' the seabed is drawn
instead" in both modes (sheet: 200 m below the surface over the open-ocean map, blue albedo; fixed: 30 m,
sand). `docs/RENDER_API.md` section 15 describes the option.
