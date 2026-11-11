Status: open
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
