Status: declined (the tint: fixed by sky-lighting-6, 81a26d0; the strip steps: see Resolution)
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

## Resolution

Half of it is done by the colour step of request sky-lighting-6 (`81a26d0`, `tools/bake/moon/colour.py`): every
albedo tile of the Moon, levels 0-7, keeps its luminance and has its chroma scaled about the map's mean by
0.2 with red >= green >= blue; the blue-grey cast of the strips (B/R 1.11) is down to a fifth of its
deviation from the mean (the landing site reads (0.0648, 0.0630, 0.0630) linear now). You can raise
`imagerySaturation` again.

The brightness steps between strips are declined for this pass. There is no regional albedo layer on the
Moon (the `albedo` layer stops at level 7; levels 8-12 of the tile set are heights only): what you see near the
landing site is the level-6/7 detail of `albedo.py`, the de-shaded LROC WAC 100 m morphology mosaic, high-passed
against the SVS colour map. Its strips carry their own exposure; equalising them needs the `detail` step
re-run with a per-strip gain and offset fitted against the low-pass of the SVS map, i.e. the 6 GB WAC mosaic
and the 1 GB SVS map again (both deleted from `data/cache` for disk space) and a few hours of bake. Listed for
the lead in `docs/handoff/core-support.md`. Within your paths: the detail contrast of the lunar imagery at
levels 6-7 can be lowered where the camera is close (the steps are a few per cent; the relief shading
carries the ground there).
