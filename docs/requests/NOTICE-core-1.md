Status: resolved (notice, nothing to answer)
From: core-support
Owner path: src/render/vfx, src/render/ocean, src/render/cockpit (copies of core lighting loops; one resource to publish)
Blocking: no

## Problem
Changes in the render core during the visual close-out that packages with their OWN copies of core lighting
code, or with something to publish, should pick up. None breaks anything; without the change those copies
keep the old behaviour while the deferred pass has the new one.

## Evidence
RENDER_API section 18 (rows for `sky-lighting-8`, `vfx-5`, `vehicle-pad-2`, `cockpit-10`, `terrain-render-4`,
`cockpit-13`).

## Requested change
1. vfx: publish `'vfx.plasmaWindow'` (request cockpit-13): create a 16-byte uniform buffer
   (`PLASMA_WINDOW_BYTES`), `ctx.resources.publish('vfx.plasmaWindow', buffer)` once, and in `prepare` write
   `[r, g, b, plasmaIntensity]` = what `plasmaWindowRadiance(data, heatFlux, intensity, speed)` gives a
   lee-side window of the vessel the camera is in (else the active vessel), cd/m^2, linear sRGB; zeros when
   there is no sheath. The cockpit binds it (set `plasmaWindow`).
2. vfx (`src/render/vfx/common.ts`, `vfxLocalLights`) and ocean (`src/render/ocean/shaders/surfaceWgsl.ts`, the
   local-light loop): `LocalLight` gained `radius` and the kind `'spot'` (requests vfx-5, vehicle-pad-2).
   A copy of the old loop sees a spot as a point light of its axial intensity and ignores the radius. To
   match the deferred pass: `#include "local_lights"` and
   `let l = localLightSample(i, posRelCam, n); lit += brdf(l.xyz) * frame.lights[i].intensity.rgb * l.w;`
   (n = vec3f(0.0) for a volume).
3. ocean (`surfaceWgsl.ts`, the planetshine loop) and any other forward copy: planetshine is occluded per
   pixel now (request sky-lighting-8). Multiply each light by `shineVisibility(posRelCam, sh)` (chunk
   `eclipse`), or the Moon below the horizon still lights the sea's normals that face it.
4. Everyone who calls `sampleSunShadow` (ocean, vfx particles and dust): no change needed. The kernel no
   longer turns per pixel where a shadow texel covers more than 2-8 pixels (request cockpit-10), and
   `sampleSunShadowSoft(pos, n, pixel, radiusM)` exists for a wider filter.

## Resolution
Notice only.
