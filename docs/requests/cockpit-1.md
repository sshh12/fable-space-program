Status: open
From: cockpit
Owner path: src/render/core/shaders/chunksLighting.ts
Blocking: no

## Problem
`MATERIAL_CLOTH` surfaces receive direct sunlight through solid occluders. `shadowSampleCascade` returns 1
for `NoL <= 0` ("back faces are dark through the BRDF"), but `brdfClothDirect` is not dark there: its
wrapped diffuse reaches out to `NoL = -0.3` and its translucency term lights the back side. Every cloth
pixel whose normal points even slightly away from the sun is therefore lit at full sun strength whatever
stands between it and the sun. Inside the closed cockpit (a pressure shell with window openings, lab
exterior shell around it) the quilted insulation blankets showed white stripes of full sunlight along every
seam where the bumped normal turned away from the sun.

## Evidence
`/labs/cockpit/?scene=leo` with the blanket material set to `"shading": "cloth"` in
`data/defs/visuals/cockpits/kestrel.json` (screenshot `out/screens/cockpit/leo-sun-patch-console.png` of
the first run): bright diamond seams on blankets that the sun cannot reach. Line 456 of
`src/render/core/shaders/chunksLighting.ts`: `if (NoL <= 0.0) { return 1.0; }`.

## Requested change
Shadow the cloth's direct term like any other: for `MATERIAL_CLOTH` (or for any material whose direct BRDF
is non-zero at `NoL <= 0`) look the cascade up with the normal flipped toward the light (or with `|NoL|`)
instead of returning 1, so wrap lighting and translucency are both occluded by casters between the surface
and the sun. Parachute canopies keep their back-lighting where the sun really reaches them.
Must not change: the terminator behaviour of standard, terrain and regolith surfaces (the early-out exists
for them).

Workaround in my paths meanwhile: the Kestrel layout uses `"shading": "standard"` for its fabrics.
