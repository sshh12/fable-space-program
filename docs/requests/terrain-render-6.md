Status: resolved (commit 1581cf9)
From: terrain-render
Owner path: data/defs/sites/ka-lae-lc1.json (pad.flatRadius / blendRadius), src/terrain/modifiers.ts
Blocking: no

## Problem
The site flattens the height function over a disc of 450 m radius (blend to 900 m), while the hardstand is
124 m square and the outermost structure stands 390 m out. From eye height anywhere near the pad the ground
is therefore a geometrically perfect plane out to a ruler-straight edge, which both critics of round 0 name
as a cause of their blocker ("a geometrically perfect plane", "ends in a ruler-straight line"). The terrain
now draws lava, a site ground plan, ground cover and relief shadows on that plane, which carries the picture
at a glance, but the plane itself and its circular edge are in the height authority.

## Evidence
`out/screens/terrain/pad-off-apron.png`, `out/screens/terrain/integrated-off-apron-eye.png` (horizon of the
plain); `data/defs/sites/ka-lae-lc1.json` `pad: { flatRadius: 450, blendRadius: 900 }`;
`data/defs/sites/ka-lae-lc1.structures.json` (largest offsets: crawlerway to 393 m west, tank farms at 322 m
and 340 m).

## Requested change
One of, at the owners' choice:
(a) flatten per structure instead of one disc: `flatRadius` about 110 m around the pad centre plus a
    flattened footprint (its slab plus 10 m) under each structure that needs level ground, the natural
    relief returning between them; or
(b) keep the disc but let the natural relief return to a stated share outside the slabs: a second weight
    `H = mix(H_natural, elevation, w(d))` whose floor outside `flatRadius0` (about 110 m) is 0.75 instead of
    1, so that 25 % of the hummocks (0.3 to 1 m here) survive on the disc; and
(c) in either case blend with a ragged edge (the weight displaced by band-limited noise of about 60 m), so
    the transition is not a circle.
Must not change: the pad surface within the hardstand (exactly flat at `padElevation`), the collision
surface being the rendered surface, `LaunchSiteDef` for sites that do not opt in.
The terrain's site ground plan (`src/render/terrain/sitePlan.ts`) already knows the footprint of every
structure with `halfX`/`halfZ`, `sizeX`/`sizeZ` or `length` + `trackWidth` parameters and would follow.

## Resolution

Done (`1581cf9`) as (a) + (b) + (c) together, opt-in per site; **lead-owned data changed** (recorded in
`docs/handoff/core-support.md` and `docs/handoff/terrain-core.md`):
- `LaunchSiteDef.pad.shape?: SitePadShapeDef` (`src/core/contracts/defs.ts`): `coreRadius` + `coreBlend`
  (exactly flat hardstand), `areas` (turned rectangles in the pad's east/north frame, each with its blend:
  exactly flat), `reliefShare` (share of the natural relief kept inside `flatRadius` elsewhere),
  `edgeNoise { amplitude, wavelength }` (every blend's far end pulled in by up to that fraction with
  band-limited noise: no circle, no straight line). Natural from `blendRadius` on; nothing reaches beyond it.
  Sites without `shape` are levelled exactly as before (bit-identical).
- `src/terrain/modifiers.ts`: the one weight function (`discWeight` / `flattenWeight` / `applyDiscs`) the
  bakers, the collision queries and the amplification suppression all use, so collision = render still.
- `data/defs/sites/ka-lae-lc1.json`: core 115 m (the hardstand's corners are at 88 m, the masts at 100 m) +
  40 m, a quarter of the relief kept (your option b), five areas (slab + 10 m): the water tower, both tank
  farms (turned 30 and -20 deg), the crawlerway (330 m along east), the building at (-150, -62); edges ragged
  by 60 % over 60 m. `flatRadius` / `blendRadius` keep 450 / 900, so `sitePlan.ts`, the sim's landing target
  and the vfx director (which read `flatRadius` as the site's extent) are unchanged. Pipe runs stand on the
  quarter relief (their supports differ by a few decimetres at most).
- Tests: `tests/unit/terrain-core/pad.test.ts` (core and a turned area exactly flat on the collision surface,
  the relief share 0.25 to 6 decimals elsewhere inside 450 m, natural beyond 900 m, the disc's edge ragged,
  the repository's shape valid with every area centre at weight 1); terrain-core unit suite 89 of 89, the
  sim's unit suites 212 of 212.
- Looked at from 1.8 m (integration lab, 300 m west and 220 m south of the pad): the ground round the site
  has its hummocks and stones again, the pad and the structures stand level. The far plain is the natural
  terrain of Ka Lae (low relief) and stays near-flat by nature.
Re-shoot `pad-off-apron` and `integrated-off-apron-eye`; your ground plan (`sitePlan.ts`) may want to follow
the areas (`site.pad.shape.areas`).
