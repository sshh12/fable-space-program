Status: open
From: render-core
Owner path: src/core/contracts/render.ts
Blocking: no

## Problem
`ShadowCascadeView.texelSize` is documented as "World-space size of one shadow texel, m", and
`farDistance` as the far distance of the cascade from the camera. Since the second review the footprint
of a staggered camera cascade is no longer always a square around the camera: at low sun it is a band
(as wide as before along u, up to 16 times narrower along v, centred on the ground it shadows), so one
texel is `texelSize` along u and less along v, and ground inside `farDistance` is inside the map but
other points at that distance (above the terrain) are not.

## Evidence
`src/render/core/shadows/cascadeMath.ts` (`fitReceivers`, `CascadeCapture.radiusV` / `texelSizeV`);
`docs/RENDER_API.md` section 8, "Low sun" and rule 4 for casters. `tests/browser/render-core/shadows.spec.ts`
("low sun: ...") logs the 200 km cascade as 2.83 and the 1500 km cascade as 5.66 times finer along v.
The contract comment still reads as if every cascade were a square of `2 x farDistance`.

## Requested change
Comment only, plus one optional field:

- `texelSize`: "World-space size of one shadow texel along u, m: the coarser of the two axes (a cascade
  fitted to its receivers has finer texels along v). Use it for caster LOD and small-caster culling."
- `farDistance`: add "Cull casters against `viewProj` (|clip.x|, |clip.y| <= 1 + margin), never by distance
  from the camera: the footprint is not always a square around it."
- Optional: `texelSizeV?: number` (m) for features that want the finer axis; the core would fill it from
  `CascadeCapture.texelSizeV`. Nothing in the core or the mesh system needs it.

Nothing else must change; the core already documents both rules in `docs/RENDER_API.md` section 8.
