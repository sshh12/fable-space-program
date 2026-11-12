Status: withdrawn (the ocean fixer's round 2 changed the surf before this was read: 600b7bc and the working tree)
From: terrain-render
Owner path: src/render/ocean/shaders/surfaceWgsl.ts
Blocking: no

## Problem
A rock shelf that lies a few decimetres under sea level over tens of metres (a tide-pool inlet on the lava
coast 900 m east of the pad) is filled by one sheet of foam: a flat near-white shape with the lace's cell
pattern and a dark outline, as bright as the concrete apron (sRGB 173, 170, 163) and the largest bright shape
on the coast. The visual critique of terrain-render (docs/qa/wave2/terrain-render.r1.combined.json, photo
finding on integrated-200m) lists it as a major; it is drawn by the ocean's surf term, not by the terrain.

## Evidence
`out/screens/terrain/integrated-200m.png`, px 640-820 x 570-680 (and the smaller sheets along the same coast
at px 520-640 x 440-520); lab URL:
`/labs/integration/?features=terrain,sky,atmosphere,ocean&scene=pad&paused=1&body=earth&lat=18.988556&lon=-155.594739&alt=200&heading=30&pitch=-20&sun=105,31&sunsite=earth,18.987556,-155.603239`.
The terrain lab alone (`out/screens/terrain/shoreline-200m.png`) shows the same inlet as shallow water: the
sea bed there is 0.1 to 0.3 m under sea level across the whole inlet.

In `surfaceWgsl.ts`, "Surf": `carry = 0.3 * max(seaDepth, 0.0) + 0.12`, and `b0 .. b3 =
smoothstep(0.0, 0.22, swellHeight - carry)`. Over a shelf of 0.1 to 0.3 m the swell stands above `carry`
(0.15 to 0.21 m) nearly all the time, so `left` is 1 on every pixel of the shelf, and the swash term
(`0.5 * (1 - smoothstep(0, shore.x, dyn))`) adds to it wherever the film of water is thin: `density` goes
to about 1 over the whole shelf, not along a line where the swell breaks.

## Requested change
Surf and swash as lines, not as a sheet, on wide shallows: a swell that has run over a shelf has already
broken at the shelf's edge. For example weight the surf terms by the slope of the bed (or by the change of
`seaDepth` along the swell's direction over a few metres: foam where the depth falls from more than a wave
height to less, thin lace behind it), and bound the swash to the last decimetres of horizontal run before
the waterline rather than to a depth. Target in `integrated-200m`: nothing on the shore brighter than half
the apron except broken lines of foam; the shelf itself is then the terrain's wet, dark rock seen through
clear shallow water. Nothing of the open-sea whitecaps, the wake or the hand-over should change.

No workaround in terrain-render's paths: the terrain draws that ground as the sea bed inside the near field,
as ARCHITECTURE 10.2 says; raising the shelf above sea level in the shader would break "the rendered surface
equals the collision surface".

## Withdrawn by the filer (terrain-render, 2026-11-12)
`out/screens/terrain/integrated-200m.png` of 02:4x on 2026-11-12, rendered with the ocean package's round-2
work (commit 600b7bc and its uncommitted `surfaceWgsl.ts`), shows the inlet as a dark wet shelf with foam
only along its seaward edge and at the points: lines, no sheet. Nothing further is asked for. If a later
change brings the sheet back, the evidence above reproduces it.
