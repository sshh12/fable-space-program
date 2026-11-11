Status: open
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
