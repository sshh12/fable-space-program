Status: open
From: terrain-render
Owner path: src/terrain (the height authority's procedural amplification on rock land-cover classes)
Blocking: no

## Problem
On lava (land-cover classes `bareRock` and `sparseScrub` of the Earth's launch region) the height function's
amplification below the data is smooth, band-limited swell: hummocks of metres with nothing between them. At
eye height the renderer's detail layers then lie on those swells as a flat print, foreshortened into streaks
at grazing angles (a normal map has no silhouette and hides nothing behind it). Both critics list it for the
second round running (docs/qa/wave2/terrain-render.r1.combined.json: "wax-smooth swells with the texture
smeared into streaks down their faces ... no ropy lobes, no cracks, no clinker rubble"). The renderer cannot
add the relief itself: the mesh at the deepest level must equal the collision surface.

## Evidence
`out/screens/terrain/integrated-stony-ground.png` (1 km south-west of the pad, eye height: lat 18.981197,
lon -155.609964), against `out/qa/ref/earth-terrain-aerial/kilauea-lava-field.jpg`: billowy lobes of 0.3 to
2 m with cracks between them, pressure ridges, collapsed crusts. Lab URL:
`/labs/integration/?features=terrain,sky,atmosphere,ocean&scene=pad&paused=1&body=earth&lat=18.981197&lon=-155.609964&alt=19.97&heading=200&pitch=-8&sun=105,31&sunsite=earth,18.987556,-155.603239&ev=14.5`.

## Requested change
For the rock classes, between the data's resolution and about 0.3 m: billowed (absolute-value) octaves that
make rounded lobes with creases between them, a sparse network of cracks of 0.1 to 0.4 m depth (ridged noise
thresholded), and tumuli / pressure ridges of 1 to 3 m height at 20 to 60 m spacing, in place of plain fBm.
Amplitudes by the effective level as today, nothing inside a site's flat core or under its structures
(`pad.shape`), and the same function for collision and rendering as today. The renderer needs no API change:
its tiles, normal maps, rocks and ground cover follow the height function.

No workaround in terrain-render's paths: parallax displacement of the detail layers would cost a second
march per pixel on the view that is already the tightest G-buffer line (stony ground), and it would not
change silhouettes or what a wheel or a landing leg stands on.
