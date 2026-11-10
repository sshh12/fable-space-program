Status: open
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
