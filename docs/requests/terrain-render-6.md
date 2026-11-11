Status: open
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
