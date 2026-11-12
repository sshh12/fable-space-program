Status: resolved (the band: 182d54b, terrain-render round 1; this round: 51a7d52 and the commit of terrain-render hand-off section 14)
From: ocean
Owner path: src/render/terrain/** (ground shading at the shoreline; terrain-render / the shared-code maintainer for src/render/terrain)
Blocking: no        (round-1 critiques of the ocean, both lenses: "no wet sand behind the swash"; the ocean can only draw water)

## Problem
Where the sea runs up a beach the sand behind the swash stays dry and bright up to the waterline, so the surf
reads as foam lying on dry ground. A real beach has a dark, glossy wet band as wide as the run-up of the swell
(photographs of any sandy shore with 1-2 m swell). The ocean package draws the water, the swash and the surf;
the ground under and beside them is the terrain's material, which the ocean must not and cannot change.

## Evidence
- `out/screens/ocean/coast60.png`, `out/screens/ocean/shoreAlong.png`, `out/screens/ocean/shore.png` (ocean lab on
  the LabPlanet beach: the same would show on the real coast at the pad).
- `docs/qa/wave2/ocean.r1.photo.json`, finding "The surf is a constant-width double outline ... No wet sand behind
  the swash"; `docs/qa/wave2/ocean.r1.artifact.json`, previous item 11 ("there is no wet sand").
- What the sea does there: the drawn waterline moves with the physics swell (`BodyDef.ocean.swell`, Earth: eight
  components, amplitude bound 1.56 m, Hs 1.7 m), so on a beach of slope 0.04-0.1 it sweeps a band 10-40 m wide
  every few seconds.

## Requested change
In the terrain's ground shading, for ground of a body with an ocean whose height above the body's sea level
(`BodyDef.ocean.seaLevel`) lies between about -0.3 m and +0.6 x the swell's amplitude bound (Earth: about +0.9 m):
- albedo x 0.55 (wet sand is about half as bright as dry), and a smooth, glossy surface (roughness about 0.3) so
  that it mirrors the sky at grazing angles;
- fading out over the upper third of that range with a ragged upper edge (the existing class-edge noise would do);
- only for unconsolidated ground (sand, gravel, mud), not rock or the pad's slabs.
A static band by height is enough: the ocean's swash and surf foam move over it. If a moving wet line is wanted
later, the ocean can publish the current run-up height per body as a shared uniform (say so in the resolution and
this package adds it).
Must not change: the ground BELOW the waterline as the deferred pass lights it (the ocean reads the lit seabed from
'scene.colorCopy' through the water column; `tests/browser/integration/water.spec.ts`, "a shoreline from 200 m"),
and the terrain's far sheet.

## Resolution (terrain-render, 2026-11-12)
The band exists in the terrain's ground shading since round 1 of its visual close-out, and it is what the
request describes except for two numbers:
- `shaders/surface.ts`, G-buffer `param` of `MATERIAL_TERRAIN` (wetness 0..1): 1 up to a quarter of
  `shoreWetnessHeightM` above the body's sea level, falling to 0 at `shoreWetnessHeightM` (Earth: 2.5 m, so
  full to 0.6 m and gone at 2.5 m: wider than the +0.9 m asked for, because spray wets the rock of this coast
  well above the swash), only where water is near (the wide mip of the water mask), and patchy: band-limited
  noise of 9 m fixed to the ground gives the ragged upper edge.
- `shaders/lighting.ts`, `brdf_terrain`: wet ground has 0.55 of its albedo and a roughness of at most 0.45
  (asked: about 0.3; 0.45 is kept because the band also lies on rough lava, which a film of water does not
  make a mirror). New in this round: wet ground keeps its true view angle in the reflection of the sky (dry
  ground is bounded to about 45 degrees), so the band mirrors the sky at grazing angles by its wet share.
- It is not limited to unconsolidated ground: wet basalt is as dark and as glossy as wet sand, and the coast
  at the pad is rock. A site's slabs stand above the band.
- Nothing changed below the waterline as the deferred pass lights it: the wetness there is what it was
  before the request (the same `param`; the ocean reads the same seabed from 'scene.colorCopy'), and the far
  sheet is untouched. `tests/browser/terrain` (21 of 21) and the integrated shore view
  (`out/screens/terrain/integrated-200m.png`) were re-run on this code.
A moving wet line is not built; if the ocean publishes the run-up height per body, `shoreWetnessHeightM`'s
lower edge can follow it (one uniform in `brdf_terrain`'s inputs: say so in a new request).
