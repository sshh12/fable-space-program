Status: resolved (commit 2cc2aea)
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

## Resolution
Added as a shared target instead of a third attachment of the water pass, so no pass changes its
attachments and vfx can use the same mask later (core-support, commit 2cc2aea).

**API**
- `SharedResourceMap['post.reactive']: GPUTextureView`: r8unorm at render resolution, cleared to 0 by the core
  at the start of every frame. The resolve multiplies the history weight of a pixel by `1 - value`
  (sampled bilinearly at the output pixel); the neighbourhood clip is unchanged.
- Ask for it with `requires: ['scene.colorCopy', 'post.reactive']` on your feature. The core creates, clears
  and binds the target only while some feature requires it; otherwise the key is a 1 x 1 zero default and
  the resolve behaves exactly as before.
- Write it in a pass of your own in `compositeAtmosphere` or `preTransparent` (not in `drawWater`: that pass
  has fixed attachments): `colorAttachments: [{ view: ctx.resources.get('post.reactive'), loadOp: 'load',
  storeOp: 'store' }]`, no depth attachment, pipeline target `{ format: 'r8unorm', blend: { color: { operation:
  'max', srcFactor: 'one', dstFactor: 'one' }, alpha: the same } }`. The view is re-published when the
  internal resolution changes: fetch it every frame or watch `ctx.resources.version('post.reactive')`.

**How to mark the near-field water.** A fullscreen pass (`coreOf(ctx).fullscreenPipeline`) that compares
`'scene.depth'` with `'scene.depthOpaque'` at the pixel: where they differ the forward water drew, so write
your value there (0.3-0.5 scaled by the resolved slope variance and faded out towards `fadeStart`, as you
proposed) and discard elsewhere. At 1440p that is a few hundredths of a millisecond; name the pass
`ocean.<something>` with `ctx.perf.gpuPass` so it is counted on your line.

**Measured** (`tests/browser/render-core/framegraph.spec.ts`, "'post.reactive' lowers the history weight ..."):
per-pixel noise that is new every frame, zero velocity: mean frame-to-frame change of the resolved image
0.061 with mask 0, 0.336 with 0.5, 0.721 with 1; pixels beside the mask are unchanged.

**Also changed, for everyone:** the history is rescaled by the ratio of this frame's exposure to the last
one's before use (it is pre-exposed), so an adapting exposure no longer drags a darker or brighter history
through textured regions. Documented in RENDER_API sections 13 and 18. Re-run your stability spec with the
mask in place; pixels that write 0 are bit-identical to before at constant exposure.
