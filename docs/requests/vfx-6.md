Status: resolved (commit f52f358)
From: vfx
Owner path: src/render/core/renderer.ts (`noiseOffset` in the frame uniforms)
Blocking: no

## Problem
In deterministic mode the blue-noise offset is frozen (`renderer.ts` line 618: `noiseOffset: animate ?
[...] : [0, 0]`), so a ray-marched volume gets the same per-pixel jitter in every frame and the temporal
resolve has nothing to average: every deterministic screenshot of a half-resolution volume carries a 2 px
lattice that a player never sees (item 24 of `out/qa/wave2/vfx.md`; the same holds for any other feature
that jitters a march with `frame.misc.zw`). The review matrices are shot in deterministic mode, so they
cannot show what the game looks like.

## Evidence
`out/screens/vfx/plumes-close/booster-45m.png` (deterministic) against
`out/screens/vfx/dev/f8-booster-45m-live.png` (same view, `"live": true`): the lattice is gone in the live
frame. 4 x crops of `out/screens/vfx/engine-atlas-9m/10km-full.png` and
`out/screens/vfx/reentry-views/side-close-1.0.png` show the diamond pattern.

## Requested change
Let the offset cycle in deterministic mode too, from a counter that is itself deterministic (the frame
count since `setDeterministic(true)`, as `jitterIndex` already is):

```ts
noiseOffset: [(n * 37) % BLUE_NOISE_SIZE, (n * 23) % BLUE_NOISE_SIZE]   // n = animate ? frameIndex : jitterIndex
```

Two runs that render the same number of frames after `setDeterministic(true)` still produce identical
pictures (the determinism specs render a fixed number of frames). `frame.animate` stays false (features
still freeze their animated noise). If a spec elsewhere relies on the offset being exactly [0, 0], an
opt-in is enough for me: `renderer.setDeterministic(true, { cycleNoise: true })` or a lab option.

Workaround meanwhile: a vfx-owned 3 x 3 depth-aware filter on the half-resolution volume image, and live
frames in the matrix where structure matters.

## Resolution
Added as an opt-in (commit f52f358), because frame comparisons elsewhere rely on the fixed offset (the
integration checks compare consecutive deterministic frames for shadow crawl and water pops).

```ts
renderer.setDeterministic(true, { cycleNoise: true });      // CoreRenderer
window.__lab.setDeterministic(true, { cycleNoise: true });  // LabApp (also sets the fixed time step)
// or in a lab's query string:  ?deterministic=1&noise=cycle
```

With `cycleNoise` the frame uniform's noise offset is `[(n x 37) % 64, (n x 23) % 64]` with `n` = the count
of frames rendered since the call (`jitterIndex`, which the call resets to 0), exactly your formula;
without it the offset stays [0, 0]. `frame.animate` is false either way. Calling it again with a different
option restarts the count and the TAA history. `window.__test.setDeterministic(on)` (the TestApi contract)
is unchanged and means "fixed": use the lab handle or the query for the cycling mode.

Test (`tests/browser/render-core/stability.spec.ts`, "deterministic mode: the blue-noise offset is fixed, or
cycles reproducibly"): with the fixed offset frames 60 and 61 after the call differ in 0.04 % of the 8-bit
values; with the cycling offset in 33 % (the dither alone); frame 60 of a second run is identical to frame
60 of the first in both modes, value for value. So a matrix shot after a fixed number of frames stays
reproducible. RENDER_API sections 11 and 18.
