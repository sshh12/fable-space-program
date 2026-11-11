Status: resolved (commit 95d2c70)
From: vehicle-pad
Owner path: src/core/contracts/render.ts (PbrMaterialDef), src/render/core/mesh/meshSystem.ts (G-buffer and shadow pipelines)
Blocking: no (visual close-out item 17 "open steel grating is an opaque slab", major; a geometric fix exists in my paths for the walkways near the camera)

## Problem
The mesh system has no alpha-tested materials. Bar grating (walkways, tower platforms, stair treads) is 70-80 %
open: from below the sky shows through it and its shadow is dappled. Drawn as an opaque textured plane it is a
black plank from below and casts a solid shadow.

## Evidence
`out/screens/vehicle/pad-stack-tower-15m-up.png` (walkway undersides), item 17 of `out/qa/wave2/vehicle-pad.md`.

## Requested change
`PbrMaterialDef.alphaCutoff?: number` (0..1; absent = opaque as today). When set, the G-buffer fragment shader
discards fragments whose base-colour texture alpha is below the cutoff (alpha-to-coverage is welcome where MSAA
exists; with TAA only, a cutoff dithered by half a texel's alpha gradient is enough), and the shadow pipeline does
the same for models that have such a material (a second shadow pipeline variant with uv + the base-colour texture;
models without a cutout material keep today's position-only pipeline). Texture loading keeps the alpha channel for
these materials.

Must NOT change: cost and behaviour of opaque materials, the shadow pass of models without cutout materials.

Workaround in my paths: LOD 0 gratings are built from real bearing bars; coarser LODs and the shadow casters
are a frame with cross members (open between them).

## Resolution

Done (`95d2c70`), additive: `PbrMaterialDef.alphaCutoff?: number` (0..1; absent = opaque as before).

- G-buffer: fragments whose base-colour texture alpha (times nothing: the factor has no alpha) is under the
  cutoff are dropped. Near, the cut is dithered by half the alpha's screen-space gradient (the TAA
  anti-aliases the edge); far, where a pixel covers 4 texels or more and the mips have averaged the alpha, the
  test turns stochastic (kept with the averaged alpha's probability), so the grating keeps its solid share at
  any distance instead of vanishing (a 70-80 % open grating's averaged alpha falls under a 0.5 cutoff) or
  closing up. Use a texture with alpha 1 on the bars and 0 between, any cutoff between (0.5).
- Shadows: a model that has a cut-out material is drawn into the shadow maps per material group; the cut-out
  groups go through a second shadow pipeline with uv and the base-colour texture (same test), the other
  groups and every model without a cut-out material through the position-only pipeline as before.
- Textures keep their alpha (rgba8, not premultiplied). `doubleSided: true` is what a grating wants.
- Cost of opaque materials: one uniform branch in the G-buffer shader (it already had the dithered-fade
  discard); the shadow pass of models without cut-out materials is unchanged.

Test: `tests/browser/render-core/mesh.spec.ts`, "alpha-tested materials": the lab's 3 x 3 m grating 2 m up
(`/labs/render-core/?grating=cutout|opaque`, bars 4.7 cm every 37.5 cm, 77 % open): bars are 0.26 of the
panel's pixels from 6 m and 0.23 from 60 m (opaque: 1.00 both), the ground in its shadow gets 0.73 of the sun
(opaque: 0.00). Screenshots `out/screens/render-core/mesh-grating-cutout-{top,shadow}.png`. RENDER_API
section 10 and section 18.
