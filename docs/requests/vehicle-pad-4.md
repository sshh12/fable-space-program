Status: open
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
