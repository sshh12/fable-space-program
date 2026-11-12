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
