Status: resolved (atmosphere-clouds: f02a304, 0679ac6, ebaf601 and the commit of this note; with the maintainer's d637112 and 3290eab the low-orbit page with every package is the same picture to the bit in four captures: `leo-day` can be set to `exact: true`. The app still restarts no feature at a capture: request core-5, the lead's)
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

## Resolution (atmosphere-clouds, 2026-11-12; commits f02a304, 0679ac6, ebaf601)

Both parts are done, the pipelines are created ahead, and the low-orbit page with every package is the same
picture to the bit in four captures. **`'leo-day'` can be set to `exact: true`** in
`tests/browser/integration/exact.spec.ts`. I did not flip it: the file is yours and my instructions are to
change nothing outside my paths; it is one word.

1. **`AtmosphereFeature.resetTemporal()`** (`TemporalFeature`). It drops the clouds' radiance and geometry
   history, has the whole shadow map re-marched in the next frame, clears `lightChange` and `lastSunFixed`,
   and starts what has hysteresis from nothing, as on a fresh page: the shadow map's anchor, its extent, its
   ratio along v and its coarse step count. It sets the cloud clock to 0: that is where the clock stands when
   the clouds of a freshly loaded page first draw (the coverage map loads after the first frames; from then
   on the clock counts simulation time, rate-limited, so on a page that has run it holds how long, which is
   not the scene's). A capture therefore shows the weather a fresh page shows. It starts no work: `isIdle()`
   is what it was.
2. **Sequences on `coreOf(ctx).sequenceIndex()`**: the march index (the sub-pixel ray position from
   `taaJitter`, the golden-ratio step phase, the raw index in `cloudJitter.w`) and the shadow map's refresh
   phase (`% (16 * rounds)`). `frameIndex & 3` (checkerboard phase, light-change slot) and `& 1` (history
   parity) stay.
3. **`shaders.warm`**: `init` is async and ends in `await core.shaders.warm([...])` over every tracked
   pipeline of the package (march, tile march, the composites, the five table passes, the eight cloud
   passes); no forcing `get()` is left.
4. `AtmosphereFeature.status()` (request app-integration-11, part 7) is there for the loading screen.

Animated frames are unchanged until a page's first capture (the sequence index is the frame index until
then). After a capture the cloud clock continues from 0.

### What your evidence was, and what else had to change

Your reading (the march sequence and the shadow rounds on the absolute frame index, no `resetTemporal` on
the feature) was right and is what items 1 and 2 remove. It was not all of it. With those in, this
package's own lab was exact and your page was not (0.7 to 1.7 % of the pixels, up to 13 levels, between two
captures of one page, sometimes between fresh loads). Reading back what the cloud passes work with showed
the cloud buffers of a second capture differing after ONE frame with the terrain on the page, the scene
depth the same, and the atmosphere alone the same to the bit: the clouds' history ran on through the
restart, because the call never arrived. Two things outside the package, both yours and both done by you
within the hour of each request:

- `atmosphere-clouds-12`: the integration lab's `guardFeature` (and the app's `timedFeature`) wrap the
  features in objects without a `resetTemporal`. The lab's forwards it now (d637112); the app's is request
  `core-5` to the lead: **until that is taken the app restarts no feature at a capture**, and a capture in
  the app is what your page was this morning.
- `atmosphere-clouds-13`: with the call forwarded the terrain is busy right after its own reset and no
  capture of a page with the terrain was idle; `renderExact` asks before the last restart now (3290eab).

### Proof

All with `window.__test.renderExact(64)`, 1280 x 720, the tree at 3290eab, 2026-11-12 22:15 UTC
(`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere/exact.spec.ts --project=functional`: 4 passed).

| page | captures compared with the first | cloud buffers | picture | EV100 |
|---|---|---|---|---|
| atmosphere lab, low orbit by day | same page after 91 animated frames with the camera and the sun elsewhere; two fresh loads | | max 0 in all three | 15.148396782498619 in all |
| atmosphere lab, low orbit, sun 4 deg up (shadow rounds of 48 frames) | the same three | | max 0 in all three | 15.023396782498619 |
| atmosphere lab, cumulus from the pad | the same three | | max 0 in all three | 13.148396782498619 |
| **integration lab, your `leo-day` page, every package** (`exactIntegrated.ts`) | same page after 91 animated frames; two fresh loads | identical bits in all three (hash 860a7dc5:00404f91) | mean 0, 99.9th percentile 0, max 0, 0 % of the pixels in all three | 15.023396782498619 in all |
| the same page, a second run of five captures (two more on one page, two fresh loads) | | identical in all five, and so is the scene depth | | the same |
| `&features=terrain,atmosphere`, five captures | | identical in all five, and the scene depth | | the same |

Every capture: `idle: true`, one lead-in round, nobody busy before or after.

Your run of the same minute (batch12: 0.028 % of the pixels, at most 7 levels, the same 261 pixels in both
comparisons) is not on the clouds: `out/screens/integration/exact-leo-day-same-page.diff.png` and
`-fresh-load.diff.png` have every differing pixel inside the box 615,261 - 801,400, which is the vessel,
and the two files are the same, so it is the first capture of the page that stands apart from the two
after it. In my run of that page a minute later all four captures were the same to the bit, so it does not
happen every time. It is inside the floor either way (mean 0.00017, 99.9th percentile 0).

The test of your page in this package asserts the bits of the cloud buffers and the floor of the picture; it
skips itself, naming request 13, when another feature is busy right after a restart and the core refuses
the capture for it (it did while 13 was open; it ran and passed after 3290eab).
