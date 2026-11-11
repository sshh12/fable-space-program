Status: declined
From: render-core
Owner path: src/core/contracts/render.ts
Blocking: no

## Problem
`SharedResourceMap` has the cloud shadow textures (`'clouds.shadowMap'`, `'clouds.coverageMap'`) but no key
for where they are: the near map is an orthographic optical-depth map that follows the camera, the far map
needs the layer radius, an optical-depth scale and the longitude advection. The deferred sun term cannot
sample them without that placement, and it changes every frame.

## Evidence
`src/core/contracts/render.ts`, `SharedResourceMap['clouds.shadowMap']`: "Orthographic cloud optical-depth
map around the camera" - no matrix or extent anywhere in the contract. The render core currently takes the
placement through a core-side function, `coreOf(ctx).setCloudShadowParams({ near, far })`
(`src/render/core/frame/uniforms.ts`, types `CloudShadowNear` / `CloudShadowFar`), and puts it into the
frame uniforms (`cloudNear0..2`, `cloudFar`).

## Requested change
Add a key `'clouds.shadowParams': GPUBuffer` (uniform, 64 bytes, default = both terms off) with the layout
of the frame uniform members `cloudNear0`, `cloudNear1`, `cloudNear2`, `cloudFar` documented in
`docs/RENDER_API.md` section 4 / 7, published by the cloud feature. Until then (and afterwards, as a
convenience) `setCloudShadowParams` keeps working; nothing else needs to change.

## Resolution
Lead decision. No `'clouds.shadowParams'` key. The placement of the two cloud shadow maps is per-frame CPU
data (the near map's origin is relative to the camera, in float64), so a GPU buffer published through
SharedResources would have to be filled on the CPU by the cloud feature and copied into the frame uniforms by
the core every frame: a second path for the same numbers, with the question of which one wins.
`coreOf(ctx).setCloudShadowParams({ near, far })` is part of the render core's public API, which render
packages may import, so the import rules are not bent.

What to do instead (nothing changes in code): call `setCloudShadowParams` from `prepare` every frame; `null`
switches a term off (the default). The contract now says so in the comments of `'clouds.shadowMap'` and
`'clouds.coverageMap'` (`src/core/contracts/render.ts`), RENDER_API section 7 states the decision, and the
atmosphere-clouds brief names the call.
