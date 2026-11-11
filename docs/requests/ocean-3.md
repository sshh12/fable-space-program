Status: open
From: ocean
Owner path: src/core/contracts/render.ts (SharedResourceMap), docs/RENDER_API.md
Blocking: yes (brief scope item 4: "wetness line data exposed for hull shading via a documented shared uniform or resource")

## Problem
The ocean must expose, for the vehicle's hull shader, where the water surface is around each floating or
entering vessel (the physics swell plane at the hull, the wet line the water has reached, time since the
splash). Render packages exchange GPU data only through `SharedResources`, and `SharedResourceMap` has no key
for it, so I cannot publish it without a contract change.

## Evidence
`src/core/contracts/render.ts` `SharedResourceMap` (ocean keys: `'ocean.displacement'`, `'ocean.derivatives'`,
`'ocean.nearField'` only); `docs/WORK_PACKAGES.json` entry `ocean`, SCOPE item 4.

## Requested change
Add one key (additive):

```ts
/**
 * Water at each vessel for hull shading (wet line, meniscus, submerged darkening). Uniform buffer, 400 bytes
 * (OCEAN_WETNESS_BYTES), published by the ocean feature every frame. WGSL (binding set 'oceanWetness'):
 *   struct OceanVesselWater {
 *     plane: vec4f,   // xyz = camera-relative point of the physics swell surface (oceanSwellHeight) under the
 *                     //       vessel origin, ROOT axes, m; w = 1 when the slot describes a vessel at the water, else 0
 *     normal: vec4f,  // xyz = unit normal of the swell surface there (ROOT axes); w = wet line: highest level the
 *                     //       water has reached on the hull above that plane, m (dries back towards 0)
 *     params: vec4f,  // x = waterSubmersion 0..1 (snapshot), y = seconds since the vessel's last splash/touchdown
 *                     //       on water (-1 = none), z = amplitude bound of the render-only chop at the hull (m),
 *                     //       w = drying rate of the wet line (m/s)
 *   }
 *   struct OceanWetness { count: vec4u, vessels: array<OceanVesselWater, 8> }   // count.x = slots in use
 * Slot i describes snapshot.vessels[i] (i < 8). Default: all slots unused (w = 0).
 */
'ocean.wetness': GPUBuffer;
```

plus a binding set `'oceanWetness'` (prelude = the two structs, declaration `oceanWetness: OceanWetness`,
uniform, fragment + vertex visibility) in `createSceneBindings`, and a default buffer of 400 zero bytes in
the resources registry. I fill and publish it from `src/render/ocean`; the struct text and the constant can
also live in the core if you prefer (`OCEAN_WETNESS_BYTES = 400`).

Must NOT change: the existing ocean keys and their layouts.
