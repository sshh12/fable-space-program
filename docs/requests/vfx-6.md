Status: open
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
