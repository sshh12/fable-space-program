Status: resolved (commit b812ec4)
From: ocean
Owner path: src/core/contracts/render.ts, src/render/core (renderer.ts, sceneBindings.ts), docs/RENDER_API.md
Blocking: yes (hand-over acceptance: "at fadeStart the forward pixel equals the deferred pixel within 2 %" and "across the band the image is the cross-fade of two equal images")

## Problem
The forward water pass (`drawWater`) must shade the flat sea-level surface between `fadeStart` and `fadeEnd`
with exactly the inputs the deferred sheet has (ARCHITECTURE 10.2: "shaded by the same `brdf_water`"), and
at `fadeStart` reproduce the deferred pixel within 2 %. `brdf_water` takes `s.albedo` (the imagery colour in
RT0) and `s.param` (the encoded depth in RT2.a, 8-bit), but `drawWater` can sample only `'scene.depthOpaque'`
and `'scene.colorCopy'`: neither the albedo nor the encoded depth (nor the sheet's normal / roughness) of the
sheet under the band reaches the forward pass, so the two images cannot be made equal (the imagery tint of
turquoise shelves is exactly the difference a camera at 10-15 km altitude would see as a ring).

## Evidence
`docs/RENDER_API.md` sections 2 and 5 (row 5 of the hook table; "A forward shader ... fills a `Surface` ...
itself"), `src/render/core/renderer.ts` lines 668-684: the `water` pass has HDR and RT3 as attachments; RT0,
RT1 and RT2 are NOT attachments of that pass, so sampling them there is legal WebGPU, but no shared resource
or binding set exposes them.

## Requested change
Expose the G-buffer targets that are not attachments of `drawWater` to features, read-only:

- `SharedResourceMap` keys (additive): `'gbuffer.albedo'` (RT0, `rgba8unorm-srgb`, sampled as linear
  `texture_2d<f32>`), `'gbuffer.normal'` (RT1, `rg16float`), `'gbuffer.material'` (RT2, `rgba8unorm`), all at
  render resolution, valid from deferred lighting to the end of the frame (written by `drawGBuffer` of THIS
  frame), read with `textureLoad`. Published as the live views (no copy needed: they are not attachments of
  any later pass); re-published when the internal resolution changes. Default: 1 x 1 (0, 0, 0, 0).
- A binding set `'gbuffer'` in `createSceneBindings` declaring `gbufferAlbedoTex`, `gbufferNormalTex`,
  `gbufferMaterialTex` (`texture_2d<f32>`, sample type `float` for albedo / material, `unfilterable-float`
  is fine for the normal if `rg16float` requires it), fragment + compute visibility.
- One line in RENDER_API section 2 (row 5): `drawWater` may also read `'gbuffer.*'`.

Must NOT change: the attachments of any pass, the G-buffer formats, the existing keys and sets.

Workaround inside my paths until then: none that meets the 2 % criterion. I build the rest of the package
against the existing contract and switch the band to the G-buffer inputs when this lands.

## Resolution
Implemented as requested, additive (core-support, commit b812ec4).

- **Keys** in `SharedResourceMap` (`src/core/contracts/render.ts`): `'gbuffer.albedo'` (RT0; the target is
  `rgba8unorm-srgb`, so a read returns LINEAR colour; a = baked AO), `'gbuffer.normal'` (RT1, octahedral),
  `'gbuffer.material'` (RT2: roughness, metallic, material id / 255, material parameter). They are the live
  views of this frame's targets at render resolution, published by the core and re-published (version bump)
  when the internal resolution changes. Default before the first frame: 1 x 1, all zero.
- **Binding set** `'gbuffer'` in `coreOf(ctx).createSceneBindings`: declares `gbufferAlbedoTex`,
  `gbufferNormalTex`, `gbufferMaterialTex` (`texture_2d<f32>`, sample type `float`; read with `textureLoad`).
- **Validity**: from deferred lighting to the end of the frame, so in `drawWater`, `drawBackground`,
  `compositeAtmosphere`, `preTransparent`, `drawTransparent`. In `prepare` / `compute` / `drawShadow` they hold
  the previous frame.
- **One rule you must follow**: never set a bind group that contains these textures inside `drawGBuffer`
  (they are that pass's attachments; WebGPU rejects the pass even when no draw uses the group). Put the set
  into a bind group of its own, e.g. `createSceneBindings(2, 0, ['gbuffer'])`, and bind it in `drawWater` only.
- RT3 (velocity) is an attachment of the water pass and RT4 / RT5 are not published; nothing else changed
  (no pass attachments, no formats, no existing key or set).

How to use it for the band: `docs/RENDER_API.md` section 6 ("Reading the G-buffer back") and recipe 17.2:
where `u32(material.b * 255.0 + 0.5) == MATERIAL_WATER` the far sheet is underneath, so fill `Surface` with
`albedo = gbufferAlbedoTex.rgb`, `param = material.a`, the decoded normal and `material.r` as roughness and
call `brdfWaterDirect` / `brdfWaterAmbient`: the same inputs as the deferred pixel. Inside `fadeStart` the
sheet is discarded, so the same three textures hold the seabed (terrain / regolith id) there.

Tested: `tests/browser/render-core/framegraph.spec.ts` ("every hook has the attachments ..."): the hooks probe
writes a water surface with known inputs in `drawGBuffer` and reads albedo, roughness, material id, decoded
depth and decoded normal back in `drawWater` through the set, also after a change of the render resolution.
Render-core functional suite 23 of 23, unit tests green. Nothing to migrate; re-run your hand-over specs
once the band uses the new inputs.
