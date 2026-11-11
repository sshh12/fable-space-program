Status: resolved (commit ad38ab3)
From: vehicle-pad
Owner path: src/render/core/mesh/meshSystem.ts (G-buffer fragment shader of the mesh system)
Blocking: yes (visual close-out items 4 "frost" and 12 "soot" of out/qa/wave2/vehicle-pad.md are a blocker and a major; both end in this shader)

## Problem
Soot and frost are applied per instance times the vertex mask (`I.params.y * masks.b`, `I.params.z * masks.a`), but
the clear coat written to RT4 (`material.emissive.a`) stays at full weight. A sooted or frosted painted tank is
therefore a dark or white layer under a mirror-like coat: soot reads as polished grey metal, frost on white paint
changes the picture by a level or two. Both weights are also bare vertex interpolation (0.2 m x 0.5 m skin grid), so
their edges are polygon ramps; real frost and soot break up at centimetre scale and streak along the tank.

## Evidence
`out/screens/vehicle/aft-sooted.png` (glossy grey gradient bounded by panel lines), `frost-prelaunch.png` against
`frost-shed.png` (hand-off vehicle-pad.md, deviation 5: "the mesh shader's own frost term cannot take the clear coat
off the paint under it"). `src/render/core/mesh/meshSystem.ts:160-167` (soot, frost) and `:188` (`gbufferExtra(...,
material.emissive.a, ...)`).

## Requested change
In the `MATERIAL_STANDARD` branch of the mesh G-buffer shader (nothing changes for an instance with soot = frost = 0):

1. Clear coat scaled by the layers on top of it: `clearcoat = material.emissive.a * (1 - soot) * (1 - frost)` in
   the `gbufferExtra` call (anisotropy likewise times `(1 - soot) * (1 - frost)`: a sooted brushed panel has no
   stretched highlight).
2. Break both weights up in texture space instead of using them as plain blends. With `w` the product of the
   instance value and the vertex mask (0..1) and `g` a cheap 2-octave value noise of the mesh UV BEFORE
   `material.misc.zw` (the vehicle's UVs are metres: u round the part, v along it), stretched along v
   (cells about 0.03 m in u, 0.25 m in v, plus one octave at 4 x that), 0..1:
   `layer = smoothstep(g - 0.18, g + 0.18, 1.35 * w - 0.17)`: w = 0 gives 0, w = 1 gives 1, between them the layer
   arrives as vertical streaks and patches with a soft edge. The same formula for soot (its own noise seed) and
   frost. The vertex shader has to pass the unscaled uv (one more `vec2f` varying), or divide `v.uv` by
   `material.misc.zw`.
3. Frost look: albedo towards `vec3f(0.93, 0.95, 0.97)` (now 0.86, 0.89, 0.93: darker than the white paint it
   lies on at grazing light), roughness towards 0.85 (now 0.62).
4. Soot look: albedo towards `vec3f(0.030, 0.024, 0.019)` (brown-black; now a neutral 0.017), roughness 0.92.

Must NOT change: the meaning of `MeshInstance.soot / frost` and of mask channels b / a, the terrain branch
(`MATERIAL_TERRAIN` keeps today's plain blend: the site uses soot there as grime), instances with both at 0.

Workaround in my paths until then: frost as vertex weights on the tank skin itself (no dithered shell), soot
weights continuous across panels; both keep the glossy coat, which is the visible defect.

## Resolution
Implemented in the `MATERIAL_STANDARD` branch of the mesh G-buffer shader (commit ad38ab3,
`src/render/core/mesh/meshSystem.ts`). An instance with soot = frost = 0 is bit-identical to before (the
test reads the clean panel, applies the layers, takes them off again and compares value for value).

1. **Coat.** `gbufferExtra(n, Ta, anisotropy x coat, clearcoat x coat, clearcoatRoughness)` with
   `coat = (1 - soot) x (1 - frost)`, soot and frost being the layers after the break-up below.
2. **Break-up.** `layerCoverage(w, uvm, seed)`: `w` = instance value x vertex mask, `uvm` = the mesh UV
   divided by `material.misc.zw` (no new varying), `g` = 0.6 x value noise with cells 0.03 m in u and
   0.25 m in v + 0.4 x the same at four times the cell size, `layer = smoothstep(g - 0.18, g + 0.18,
   1.35 w - 0.17)`, exactly 0 at `w` = 0 and 1 at `w` = 1; soot and frost have their own seeds. One addition
   you did not ask for: each octave gives way to its mean (0.5) where its cell is smaller than a pixel
   (`fwidth`), so from far away the layer is the plain blend again instead of shimmering.
3. **Frost**: albedo towards (0.93, 0.95, 0.97), roughness towards 0.85.
4. **Soot**: albedo towards (0.030, 0.024, 0.019) with the weight 0.92 x layer as before, roughness 0.92.

`MATERIAL_TERRAIN` keeps its plain blends with the old colours and roughness; the meaning of
`MeshInstance.soot / frost` and of mask channels b / a is unchanged. UVs are expected in metres, u round the
part and v along it, as you say yours are; a model with 0..1 UVs gets one streak per 3 % of its width.

Measured (`tests/browser/render-core/mesh.spec.ts`, "soot and frost lie on the paint", lab
`/labs/render-core/?probe=inputs,layers&sun=180,40&ev=13`, a clear-coated grey panel of 4 m x 6 m with
both masks at 1, `window.__rc.probes.setLayers(soot, frost)`): full soot 0.21 of the clean level, full
frost 3.2 times it; at half weight soot covers 45 % of the face (mean 0.59 of clean) and neighbouring
pixels differ 8 times more across the streaks than along them; half frost: mean 2.06 times clean. A uniform
environment of 4,000 cd/m^2 mirrored at 80 degrees from the normal: 2,280 cd/m^2 on the clean coat, 73
under soot, 91 under frost. Pictures: `out/screens/render-core/mesh-soot-half.png`, `mesh-frost-half.png`.

Re-run `tests/browser/vehicle` on your side (your tools did not type-check while this was verified:
`tools/vehicle/bake-textures.ts`); the render core's mesh, lighting, stand and extras specs pass.
