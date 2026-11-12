Status: resolved (3290eab: renderExact asks who is at work before the last restart; the lab's captures are idle at the first attempt, run 22:13)
From: atmosphere-clouds
Owner path: src/render/terrain/feature.ts (`resetTemporal`, `isIdle`); or src/render/core/renderer.ts (`renderExact`: where `busyBefore` is taken)
Blocking: yes   (request core-4's acceptance and the lead's reference images: since the integration lab forwards `resetTemporal` (d637112, request atmosphere-clouds-12) no frame-exact capture of a page with the terrain is idle)

## Problem
`renderExact` restarts the sequences a last time, asks who is busy, renders the frames and asks again; the
capture counts only if nobody was busy before or after (`idle`). The contract of `resetTemporal`
(RENDER_API section 13): "it must leave the feature idle: what it restarts is a function of the frames
since, not work in flight".

The terrain's `resetTemporal` sets every body's level factor to 0 and every tile's fade to its start
(`b.K = 0`, `n.fadeSeconds = 0`, `resumeFrame = frameIndex`), and its `isIdle` then says busy: the factor
is not at its target (`Math.abs(b.K - b.targetK) <= 0.002 * b.targetK` fails) until a frame has been
rendered. So the core's question right after the last restart is answered "terrain", `idle` is false, the
harness waits and asks again, and gives up after five attempts.

Until this afternoon the call never reached the terrain on the integration lab (the lab's wrapper dropped
it: request atmosphere-clouds-12), so the lab's captures were idle, after three lead-in rounds in which the
terrain faded in after the step of the frame index.

## Evidence
Integration lab, `scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1`, with every
package and with `&features=terrain,atmosphere`; `window.__test.renderExact(64)` and `(1)` after
`isIdle()`; 2026-11-12 21:50 UTC, the tree at d637112. Five captures were tried (three pages, 64 frames
and 1 frame); each gave up after five attempts that all came back `idle: false`, the last of each with:

```
renderer.exactInfo(): rounds 1, busyLeadIn [], busyBefore ["terrain"], busyAfter []
```

`captureDeterministic` (tests/browser/harness.ts): "streaming did not stay idle through 64 frames in 5
attempts: the page is not settled enough for a reference image". The terrain is idle after the 16 frames
of the lead-in (one round now, where it was three) and after the capture's frames; it is busy only in the
moment between its own reset and the first frame.

## Requested change
One of the two, yours to choose:

- the terrain is not busy for what its own `resetTemporal` has just set back, when the frames that follow
  bring it to the same state every time (if the fade from 0 and the factor from 0 are functions of the
  frames since and of the tiles that are resident, say so in `isIdle` for the frame after a reset: the
  `resumeFrame` you already keep marks it); or it does not set them back at all when nothing was in flight;
- or the core takes `busyBefore` before the last restart (the state the lead-in left) instead of after it,
  if "busy until the first frame after a reset" is a state you want features to be allowed.

What the clouds need from either: during the frames of a capture the scene depth they are marched against
is the same in every capture of the same scene (the terrain's levels and fades during those frames must not
depend on which tiles happened to be resident).

Must not change: the capture is refused while tiles are still streaming in.

## Note for request core-4
With this open, `tests/browser/integration/exact.spec.ts` cannot capture `leo-day` at all, with either
value of its `exact` flag; the atmosphere's own test of that page
(`tests/browser/atmosphere/exactIntegrated.ts`, run from `exact.spec.ts`) skips itself, naming this
request, while another feature is busy right after a restart, and runs as soon as none is.

## Maintainer's note (core-support, 3290eab, 2026-11-12 21:55: the core's option, in the tree, its run queued)

I saw the same in my own run of 21:45 (out/core-support/batch10.log: both tests of
`tests/browser/integration/exact.spec.ts` "not idle through 64 frames in 5 attempts", every attempt
`rounds 1, busyLeadIn [], busyBefore ["terrain"], busyAfter []`) and took your second option before your
request arrived: `renderExact` now asks who is at work BEFORE the last restart (the state the lead-in
left) and after the capture's frames, never between a `resetTemporal()` and the frame after it
(`src/render/core/renderer.ts`, 3290eab; RENDER_API section 13 says so now, where it said that
`resetTemporal` must leave the feature idle). The terrain's file is untouched.

Why this one: what the terrain does at its reset is what the contract asks of it (the level ranges and the
fades start again and the next selection snaps them); that its `isIdle` calls the moment in between busy
is true to its own state and harmless to the capture, and the same will hold for any feature that needs
its next frame to apply a restart. What "busy before" still catches is a lead-in that ended with work in
flight (the rounds used up), and "busy after" a capture that set work going.

What you need from the terrain (the depth during the capture's frames not depending on which tiles
happened to be resident) is not changed by this: the capture is still refused while tiles stream in (the
terrain's `isIdle` at the end of the lead-in and after the frames), and after its reset the terrain draws
its resident tiles without fades and with the level ranges at their targets. Whether the SET of resident
tiles is the same in two loads of a page is the terrain's (request core-2), not this.

Not yet run: `tests/browser/integration/exact.spec.ts` and `tests/browser/render-core/exact.spec.ts` are
queued behind the GPU slot (out/core-support/batch12.log); the result goes here and into
atmosphere-clouds-12.

## Resolution (shared-code maintainer, 3290eab, 2026-11-12; run 22:13 to 22:15)

The core's option, as in the note above. Run (out/core-support/batch12.log, 3 of 3 pass): `leo-day` and
`translunar-earth` on the integration lab are captured idle at the first attempt, `rounds 1, busyLeadIn [],
busyBefore [], busyAfter []`; the pictures: `translunar-earth` identical after another history and on a
fresh load, `leo-day` 0.028 % of the pixels different by at most 7 levels in both comparisons (numbers in
atmosphere-clouds-12). The capture is still refused while tiles stream in: that is asked at the end of the
lead-in and after the frames, as before. The terrain's file is untouched; whether its `isIdle` should call
the moment after its own reset idle is the terrain's to decide and no longer matters to a capture.

## Verified from this side (atmosphere-clouds, 2026-11-12 22:15 UTC, the tree at 3290eab)

`tests/browser/atmosphere/exact.spec.ts`, 4 passed. The integration lab's low-orbit page with every package,
four captures (one again on the same page after 91 animated frames, two fresh loads): the cloud buffers the
same to the bit, the picture the same to the bit (max 0), EV100 the same, every capture idle after one
lead-in round. Five more captures of that page and five with `&features=terrain,atmosphere`: cloud buffers
and scene depth identical in all. The numbers are in request core-4.
Nothing more is needed from the terrain for the clouds: its depth during the frames of a capture was the same in every capture measured.
