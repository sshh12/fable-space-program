Status: open
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
