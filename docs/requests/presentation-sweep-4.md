Status: superseded by presentation-sweep-5 (2026-11-17: the cause is found and it is not in the renderer; that request has the measurement and the decision that is left)
From: presentation-sweep
Owner path: tests/browser/baselines.manifest.json, data/baselines (the lead); src/render/** for the cause
Blocking: no (a decision for the lead; the sweep keeps the recorded pictures as they are)

## Problem
The fake session can state ROOT positions as a session does, about the centre of the active vessel's SOI
body (`createFakeSession`, `renderRoot: 'focusBody'`). The 25 lab checkpoints were recorded on v1's FakeSim,
whose origin is the library's root body, so the Moon's scenes were drawn from positions 384,000 km from the
origin. Drawn from Moon-centred positions, the same scenes are not the same pictures to the bit:

| Checkpoint | Moon-centred fake against the reference (every load the same) |
|---|---|
| `lunar-terminator-20000km` | 0 pixels |
| `lunar-terminator-5000km` | 0 pixels |
| `translunar-moon` (Earth's sphere of influence: the origin does not move) | 0 pixels |
| `lunar-orbit-low-sun` (exact) | 58 pixels, up to 4 levels |
| `lunar-surface-cockpit` (exact) | 12,279 pixels, up to 17 levels (mean 0.0074), along the window frames |
| `lunar-touchdown` (tolerance mean 0.02, p99.9 3) | 5.98 % of the pixels, mean 0.0368, p99.9 3, max 136: faint, all over the ground, the horizon, the lander's lamps |

So the renderer is origin-agnostic in the mean (well under one level per channel, which is what the
sweep's origin test will assert) and not to the bit: near geometry (edges, ground detail under a low sun)
moves by a fraction of a pixel when the origin moves. A difference of that size from numbers that are
exact to 6e-8 m in float64 points at a float32 quantity of some hundred metres in the path (a position or
a matrix built in ROOT before the camera-relative subtraction, or a snapped cascade); not found yet.

To keep the gate as recorded, `createFakeSim` (the v1 name every lab uses) keeps the v1 origin
(`renderRoot: 'rootBody'`), and only `createFakeSession` defaults to the session's. The real session in
the integration lab and the app has the Moon at the origin in lunar orbit (`sweep-lunar-orbit`, a
tolerance checkpoint, is the one recorded picture it touches, once the lab moves to `createSession`).

## Evidence
Gate run of 2026-11-17 with the fake Moon-centred in every lab (commit adbddff, before 311feed gave the v1
name its v1 origin): `[baseline]` lines above. Pictures (git-ignored): `out/screens/presentation-sweep/origin/`
`<checkpoint>.reference.png`, `.moon-origin.png`, `.diff.png` for the three that moved.

## Requested change
A decision, one of:
1. keep the recorded pictures and the v1 origin in the labs' fake (as the tree stands); or
2. make the session's origin the fake's default everywhere and re-record `lunar-orbit-low-sun`,
   `lunar-surface-cockpit` and `lunar-touchdown` with a note (the Moon-centred pictures are the ones a
   player's session produces).
And, for whoever owns the render core next: find the float32 quantity (the frame-rebase work of the sweep
is where it will show again: a sphere-of-influence change moves the origin by the same 384,000 km).
