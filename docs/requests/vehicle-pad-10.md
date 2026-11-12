Status: open
From: vehicle-pad
Owner path: src/render/core/lighting/ao.ts (screen-space contact shadow march), deferred.ts (its upsample)
Blocking: no (critique item 11 of `docs/qa/wave2/vehicle-pad.r1.combined.json`, major; worked round on my side for the one fitting in the hero view)

## Problem
A thin fitting that stands a few centimetres off a surface (a grab rail, a handle, a cable on stand-offs) gets
its shadow from the screen-space contact march, because the gap is under a texel of the vessel's finest shadow
cascade. The march resolves such a caster as noise: beside the rail lies a ragged black band with a furry,
speckled edge, wider than the rail itself. In orbital sunlight the real shadow is a razor-edged line of even
width.

## Evidence
`out/screens/vehicle/capsule-hatch.png` of 2026-11-12 01:00 (x 400-480, y 270-535 and x 525-565, y 335-415;
live capture, 72 frames of temporal accumulation). `src/render/core/lighting/ao.ts`: 10 jittered steps at half
resolution. Reference: `out/qa/ref/spacecraft-hardware/orion-a2-inflight.jpg` (every fitting has a hard, clean
shadow).

## Requested change
In the contact march, for pixels within a few metres of the camera: (1) full-resolution depth for the march
(or a depth-aware upsample that does not smear a one-pixel occluder over its neighbours), (2) the per-pixel
offset from a blue-noise sequence that the temporal filter integrates (so that 72 frames converge to a clean
edge), (3) a thickness test: a caster thinner than the march step shadows only the samples behind it, so a
thin caster gives a thin shadow.

Must NOT change: the reach of the march, its cost at distance (the 0.3 ms line of the lighting budget).

Workaround in my paths: the capsule's hatch handle is now a solid pull bar on a base plate (no gap under it).
Other stand-off fittings (the lander's ladder, cable stays) are far enough from their surfaces to be resolved
by the cascades.

## Maintainer's note (core-support, 2026-11-12: read, not started)
Not built in this round (it arrived behind three blocking requests and one GPU slot for eight agents; it is
not blocking and has its workaround). What the march does today (`src/render/core/lighting/ao.ts`, fragment at
half resolution): 10 steps over `marchLen = max(0.3 m, 1.5 % of the distance)` towards the sun, the step
offset from `blueNoise().z` (so part 2 of the request is in place: the resolve integrates it), and a sample
counts as blocked when the depth buffer's surface is in front of the ray by less than
`thickness = 0.6 x marchLen` (18 cm and more). The result is 0 or 1 per half-resolution pixel. Where I would
start: (3) the thickness: a rail 2 cm thick shadows everything within 18 cm behind it, which is the band
"wider than the rail"; a thickness of a few centimetres within some metres of the camera (growing with the
depth's footprint beyond) gives a thin caster a thin shadow, with steps no longer than the caster is thick
for those pixels (10 steps over 0.3 m are 3 cm each: a 2 cm rail is missed by some jitters, which is the
speckle); (1) is half in place: the march itself reads the full-resolution depth (`scene.depthOpaque`, one
pixel of each 2 x 2 block picked by blue noise), it is the RESULT that is half resolution, one bit per
pixel, and the lighting pass upsamples it with four depth-weighted taps (`deferred.ts`): a line one pixel
wide is carried by whichever pixel of the block was picked in that frame. For pixels within a few metres
the contact term would have to be marched at full resolution (in the lighting pass, or a full-resolution
contact target for the near field). (Corrected 2026-11-12: this note first said the march read a
half-resolution depth; it does not.)
Cost to watch: the `core.ao` line at 1440p (`tests/browser/render-core/core.perf.spec.ts`); an interior
view has the whole frame within those few metres.
