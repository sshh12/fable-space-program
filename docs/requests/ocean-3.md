Status: resolved (commit 9debd1f)
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

## Resolution
Added (core-support, commit 9debd1f), additive, with two deliberate differences from the text above. Read
them before you fill the buffer.

**What exists now**

- `SharedResourceMap['ocean.wetness']: GPUBuffer` in `src/core/contracts/render.ts`, with
  `OCEAN_WETNESS_SLOTS = 8` and `OCEAN_WETNESS_BYTES = 400` exported next to it. Default: 400 zero bytes
  (count 0).
- Binding set `'oceanWetness'` in `coreOf(ctx).createSceneBindings`: prelude = the two structs, declaration
  `var<uniform> oceanWetness: OceanWetness;` (fragment + compute + vertex visibility).
- Layout, exactly as you proposed in bytes:
  `struct OceanVesselWater { plane: vec4f, normal: vec4f, params: vec4f }`,
  `struct OceanWetness { count: vec4u, vessels: array<OceanVesselWater, 8> }`.

**Difference 1: `plane.w` is a radius, not a flag.** `plane.w` = radius in metres of the sphere about the
plane point inside which the slot applies (use the vessel's `boundingRadius` plus a margin for the wet line,
e.g. `boundingRadius + 2`); 0 = unused slot. A hull shader has no vessel index, so it finds its slot by
position: a point p belongs to slot i when `length(p - plane.xyz) < plane.w`. Your flag semantics survive
(non-zero = in use).

**Difference 2: slots are not tied to `snapshot.vessels[i]`.** Fill slots `0 .. count.x - 1` with the vessels
that are at the water, the active vessel first, at most 8. After staging the capsule can sit anywhere in the
vessel list (the list holds up to 24 vessels), so "slot i = vessel i" could leave the one vessel that
matters out.

Everything else is as you wrote it: `plane.xyz` = point of the physics swell surface under the vessel origin
(camera-relative, ROOT axes), `normal.xyz` = unit normal of the swell there, `normal.w` = wet line (highest
level the water has reached on the hull above the plane, m), `params` = waterSubmersion, seconds since the
last splash (-1 = none), chop amplitude bound, drying rate. The full comment is on the key in the contract.

**Who consumes it.** Vehicles are drawn by the core's mesh system, so the wet line is applied there: a
`standard` / `terrain` fragment inside a slot's sphere whose height above the plane
(`dot(p - plane.xyz, normal.xyz)`) is below `normal.w` gets wetness 1 (2 cm soft edge), combined by max with
`MeshInstance.wetness`; deferred lighting darkens and smooths it as it does any wet surface. You only have to
publish the buffer; vehicle-pad needs no change. If you want a wider or softer transition (a meniscus, a
drying gradient), say so in a new request: the 2 cm edge is a first value.

**How to publish**

```ts
import { OCEAN_WETNESS_BYTES } from '@/core/contracts/render';
// init: buffer = device.createBuffer({ size: OCEAN_WETNESS_BYTES, usage: UNIFORM | COPY_DST }); ctx.resources.publish('ocean.wetness', buffer)
// prepare, every frame (positions are camera-relative): Uint32 count at byte 0, 12 floats per slot from byte 16
```

Publish once (the same buffer object) and rewrite its contents each frame in `prepare`: the mesh system
rebuilds its bind groups only when the published object changes.

Tested: `tests/browser/render-core/mesh.spec.ts` "'ocean.wetness' wets a hull below its wet line ...": a slot
through the lab tower (radius 6 m, wet line 3 m) darkens the tower to 0.58 of its dry luminance below the
line; above the line, outside the radius and elsewhere the image is bit-identical; resetting the key restores
the dry image exactly. Screenshot `out/screens/render-core/mesh-wet-line.png`. Documented in
`docs/RENDER_API.md` sections 10, 11 and 18. Nothing to migrate for anyone else.
