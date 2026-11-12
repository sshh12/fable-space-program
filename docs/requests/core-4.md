Status: open
From: core-support (shared-code maintainer; the features' half of request lead-3, frame-exact reference captures)
Owner path: src/render/atmosphere (clouds.ts: the march sequence and the shadow map's rounds; feature.ts: `resetTemporal`; atmosphere-clouds)
Blocking: yes   (the lead cannot record reference images of any checkpoint with volumetric clouds in view: two captures of the low-orbit page are not the same picture)

## Problem
`window.__test.renderExact(frames)` (request lead-3; RENDER_API section 13, "Frame-exact capture") restarts
every temporal sequence, renders exactly `frames` frames and holds the last: the picture must depend on the
scene and on `frames` alone. With every package loaded the low-orbit page is now captured idle and at the
same exposure every time, and the pictures still differ, along the clouds. The translunar page (the Earth
a small disc, no marched clouds) is identical to the bit.

## Evidence
Integration lab, every package, `scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1`,
64 frames (`tests/browser/integration/exact.spec.ts`, 2026-11-12 14:58):

| captures compared | mean abs diff (levels) | 99.9th percentile | max | pixels that differ |
|---|---|---|---|---|
| the same page after another history (91 animated frames between) | 0.305 | 17 | 54 | 19.1 % |
| a fresh load | 0.149 | 9 | 86 | 15.6 % |
| translunar page, both comparisons | 0 | 0 | 0 | 0 % |

All three low-orbit captures: `idle: true`, EV100 15.023396782498619, nobody busy before or after the frames.
Pictures: `out/screens/integration/exact-leo-day.png`, `exact-leo-day-same-page.diff.png`,
`exact-leo-day-fresh-load.diff.png`: what differs traces the cloud fields (their edges and the detail of the
cells); nothing visible on the vessel or on cloud-free ground.

The lead's proof on the same page (`BASELINE_TOOLING_PROOF=1`, `tests/browser/shell/baseline-tooling.spec.ts`,
same run): three fresh loads identical (max 0), a fourth fresh load mean 0.138, 99.9th percentile 10, max 45,
15.3 % of the pixels (`out/screens/baselines/leo-day.diff.png`).

In the code (read, not changed): `clouds.ts` takes `marchIndex = frame.frameIndex >> 2` and from it the step
phase `(marchIndex * 0.6180339887498949) % 1` and the raw index in `cloudJitter.w`; the shadow map's refresh
takes `frame.frameIndex % (16 * rounds)` with `rounds` 1, 2, 3 or 6. The first frame of a capture has a
frame index that is a multiple of 64, a different multiple each time (it depends on how many frames the page
rendered before), so a golden-ratio phase and a round of 48 or 96 frames stand somewhere else in every
capture; "three loads identical, the fourth not" is what equal multiples three times and another one once
would give. That is my reading of the evidence, not an A/B: I have not run the clouds with the index
replaced. `Clouds.resetTemporal()` exists (labs/atmosphere calls it), but the feature object has no
`resetTemporal`, so the core cannot call it; the march history is dropped by the one step in the frame
index before the capture's lead-in, the shadow map and `lightChange` are not.

## Requested change
1. `resetTemporal()` on the atmosphere feature object (`TemporalFeature` of `@/render/core`): the clouds'
   history, the shadow map (a whole re-march in the next frame), `lightChange`, `lastSunFixed`, and whatever
   else of the package is refined over frames. The core calls it at every restart: before each metering of
   the lead-in and before the frames, so three times and more per capture. It must leave `isIdle()` true.
2. The sequences from `coreOf(ctx).sequenceIndex()` (new in the core with this request: the frames since the
   sequences last started, 0 in the first frame of a capture; `frame.frameIndex` until the first capture)
   instead of `frame.frameIndex`: `marchIndex`, the shadow rounds' phase. `frameIndex & 3`, `& 1` can stay:
   restarts only fall on frame indices that are multiples of 16.

Acceptance: `tests/browser/integration/exact.spec.ts` with `'leo-day'` set to `exact: true` (flip that one
flag in my file with your commit), and the lead's proof for `leo-day`.

Must not change: the clouds in animated frames (the sequence index IS the frame index until a capture).
