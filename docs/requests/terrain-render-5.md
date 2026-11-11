Status: open
From: terrain-render
Owner path: tools/bake/moon (regional albedo of the `moon` tile set), data/tiles/moon
Blocking: no

## Problem
Near the edge of the regional coverage at the lunar landing site the baked regional imagery shows rectangular
blocks of a different tint with straight north-south edges and vertical streaks inside them: the strips of
the source mosaic, each with its own exposure and a residual colour cast (blue-grey B/R 1.11 where regolith
is neutral to 2 %). The terrain shader now keeps only 40 % of the lunar imagery's saturation
(`imagerySaturation` in data/defs/render/moon.surface.json), which hides the cast; the brightness steps
between strips are in the data and stay.

## Evidence
`out/screens/integration/coverage-edge-moon-5km-L11-x0.png` (edges at x about 510 and 820, y about 65),
`out/screens/integration/coverage-edge-moon-5km-L12-x0.png` (x 300-860, y 200-600); critics' findings
terrain-render.r0.photo.json ("rectangular blocks of a different tint") and terrain-render.r0.artifact.json
("Lunar colour and imagery magnification").

## Requested change
In the regional albedo bake of the Moon: equalise each source strip in gain and offset against the low-pass
of the global mosaic over the same ground (so strip borders carry no step), and remove the residual tint
(regional texels neutral to within 2 % in R : G : B, like the global layer). Must not change: tile layout,
coverage rectangles, the feather to the parent level.
