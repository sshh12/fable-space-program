Status: resolved (commit 113438e)
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

## Resolution
Fixed as requested (core-support, commit 113438e), in the lighting pass rather than in the cascade sampler:
`src/render/core/lighting/deferred.ts` looks the sun shadow up with the normal turned towards the sun when
the pixel is `MATERIAL_CLOTH` and faces away from it (`nShadow = -s.n`). `shadowSampleCascade` keeps its
early-out for `NoL <= 0`, so the terminator behaviour of standard, terrain, regolith and water surfaces is
untouched, and `sampleSunShadow` itself did not change for anyone who calls it from a forward shader.

Effect: wrapped diffuse and translucency of cloth are both occluded by whatever stands between the fabric
and the sun; a canopy stays back-lit where the sun reaches it (the fabric itself is the nearest caster at
its own texel, and the normal-offset bias is applied on the sunward side).

Tested: `tests/browser/render-core/lighting.spec.ts`, "cloth is shadowed on both sides ...": the lab's cloth
panel with the tower between it and the sun. Front face 0.0745 lit / 0.0000 in the shadow; back face (lit
through the fabric) 0.1281 / 0.0000. Before the change the back face read the same in and out of the shadow.
Screenshot `out/screens/render-core/lighting-cloth-backlit-shadow.png`. RENDER_API section 7 has the rule.

You can set the blankets back to `"shading": "cloth"`. Seams whose bumped normal turns away from the sun
now take the cabin's shadow like the rest of the blanket.
