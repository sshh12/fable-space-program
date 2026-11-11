Status: open
From: ocean
Owner path: src/render/core (post/postProcess.ts: TAA resolve), src/core/contracts/render.ts, docs/RENDER_API.md
Blocking: no

## Problem
The wind-wave pattern of the near-field sea evolves (dispersive waves travelling in many directions at
0.5-10 m/s); it has no single motion vector. The ocean writes exact motion vectors of the surface itself
(particle motion, swell, body rotation, camera), but the TAA history of the PATTERN is wrong every frame, and
the resolve then averages successive patterns: the moving sea near the camera loses detail. Moving sun glints
are additionally rejected as fireflies by design (render-core hand-off section 4), which is fine. There is no
way for a feature to tell the resolve "trust the current frame more here" (FSR2's reactive mask).

## Evidence
`npx playwright test tests/browser/ocean/stability.spec.ts --project=functional` (log line "TAA output / single
frame gradient energy"): with the sun behind the camera (no glints), the gradient energy of the TAA output
relative to the single jittered frame it was resolved from is 0.352 for a frozen sea, 0.171 for the animated
sea (0.48 of the frozen value). A pattern-velocity term added to the motion vectors (mean phase velocity of
the resolved components) did not help (0.142 / 0.158 with and without), as expected for a multi-directional
dispersive field.

## Requested change
A per-pixel reactive value that features drawing into the velocity target (`drawWater`, later vfx for
plumes / smoke edges) can write, and that the resolve uses to lower the history weight (for example
`historyWeight *= 1 - reactive`, with the existing neighbourhood clip unchanged), e.g.:
- a third colour target in the `water` pass (`r8unorm`, cleared to 0 each frame, published or internal), or
- a documented sign/flag convention in RT3 if you prefer not to add a target.
I would write about 0.3-0.5 for near-field water pixels with resolved waves (scaled by the resolved slope
variance) and 0 elsewhere. Must NOT change: anything for pixels that write 0, the attachments of other passes.
