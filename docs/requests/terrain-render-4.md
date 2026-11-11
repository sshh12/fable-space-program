Status: resolved (commit c417fb0)
From: terrain-render
Owner path: src/render/core (sun shadow lookup of the deferred lighting: `sampleSunShadow`)
Blocking: no

## Problem
Seen from lunar orbit under a low sun, the shadow inside a crater a few quads wide is a black polygon
(arrowheads, pentagons, a saw-tooth edge): it is the true shadow of the low-polygon terrain mesh on itself,
compared hard, and the smooth shading of the tile's normal map makes the polygon stand out. Both critics of
round 0 list it as a major finding (terrain-render.r0.photo.json "Crater shadows seen from orbit have a
scalloped, gear-tooth outline", terrain-render.r0.artifact.json "Crater shadows are not crater-shaped").
The terrain cannot fix it in its own paths: caster and receiver are the same mesh (they must be: hand-off
4.1a), finer casters are not resident, and the lighting pass applies the cascade shadow whatever the terrain
writes.

## Evidence
`out/screens/terrain/moon-orbit-100km.png` (crop x 880-1300, y 420-700), `out/screens/integration/shadows-lunar-orbit-pass.png`
(x 360-620, y 520-720), `out/screens/terrain/moon-edge-50km.png` (x 600-790, y 930-1070). Lab URL of the
first: `tests/browser/terrain/views.ts`, view `moon-orbit-100km`.

## Requested change
A filter of the cascade lookup that is at least as wide as a caster quad where the caster is terrain: either
(a) a per-cascade minimum penumbra in metres that the caster features can raise (terrain would ask for one
render quad of the level it casts from: `ShadowCascadeView` gets a writable `minPenumbraM`, default 0), or
(b) a G-buffer-driven softness: for `MATERIAL_TERRAIN` / `MATERIAL_REGOLITH` pixels the lookup takes its
filter radius (in metres on the ground, 0 = today's behaviour) from a channel the terrain writes, e.g. RT4.a
(unused by these materials; RT4.b already carries the terrain's relief shadow, RENDER_API should say so).
Must not change: the lookup for every other material, the shadow of vessels and structures on the ground,
and the budget lines of ARCHITECTURE 17.1.

Workaround in the terrain's own paths: none that is honest (blurring the terrain's own G-buffer normal does
not move a shadow edge). The finding stays open in the hand-off until this is answered.

## Resolution

Done as your option (b) (`c417fb0`), additive:

- G-buffer RT4.a of `MATERIAL_TERRAIN` and `MATERIAL_REGOLITH` pixels is the smallest sun-shadow filter radius,
  in metres on the receiver: write `encodeShadowSoftness(radiusM)` (WGSL, chunk `gbuffer`; 0 = none, today's
  lookup; 1.6 cm to 16 km in 254 logarithmic steps of 5.6 %; radii under 1.6 cm encode as 0).
  `decodeShadowSoftness`, `SHADOW_SOFTNESS_MIN_M` / `SHADOW_SOFTNESS_MAX_M` and TS twins are exported from
  `@/render/core`. Your `gbufferPack` leaves RT4 at (0, 0.5, 0, 0), so nothing changes until you write it:
  `packed.extra.a = encodeShadowSoftness(quadSizeOfTheCasterLevel);` next to your `packed.extra.b`.
- The deferred pass calls `sampleSunShadowSoft(pos, n, pixel, softRadius)` for those materials: the kernel is
  at least `softRadius` wide across the light and `softRadius x NoL` along it (a metre of map covers 1 / NoL
  metres of ground there), the blocker search at least as wide, up to the existing maximum of 12 texels of
  the cascade (so a radius larger than 12 texels is clipped: in the whole-body cascade of a lunar orbit that is
  several hundred metres). The outer taps keep the rule that a blocker must stand clear of the receiver plane
  by a slope of 0.3, so relief beside the receiver does not darken it.
- It softens every shadow on that pixel, a vessel's included: write 0 where those fall (near the camera); the
  lookup for every other material is unchanged, and so is the cost (same taps).
- RENDER_API section 6 now states RT4.b / RT4.a of the terrain materials (RT4.b: free for your BRDF chunk).
- `PbrMaterialDef.shadowSoftness` lets mesh-system terrain/regolith materials set it too (site ground,
  rocks drawn through the core mesh system).

Test: `tests/browser/render-core/shadows.spec.ts`, "a terrain surface can ask for a wider shadow filter in
RT4.a": the tower's shadow edge on the stand's terrain slab, at x -6.6 / -6.55 / -6.5 / -6.45 / -6.4:
default 0.00 0.00 0.70 1.00 1.00, with 0.1 m 0.02 0.24 0.56 0.82 1.00 (`shadows-soft-terrain-0.1m.png`);
unit test of the encoding in `tests/unit/render-core/frameMath.test.ts`. Lab: `/labs/render-core/?soft=<m>`.
Re-run: `moon-orbit-100km`, `moon-edge-50km`, the integration lab's `shadows-lunar-orbit-pass` once your
shader writes RT4.a.
