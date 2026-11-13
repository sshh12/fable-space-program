Status: open
From: core-support (shared-code maintainer; the lead's question of 2026-11-12: whose are the pixels on the vessel that differ between two frame-exact captures)
Owner path: src/render/sky (the environment probe, `probe.ts`, and the feature's `isIdle`); conditions: src/render/atmosphere, src/render/cockpit
Blocking: yes   (the lead's reference images of every checkpoint with the vehicle in view: the FIRST frame-exact capture of a page can differ from every later one on the vessel)

## Problem
With every feature restarted at a capture (requests core-4, atmosphere-clouds-12 and -13, all done) two
frame-exact captures of the low-orbit page are the same picture, except that the first capture of a freshly
loaded page can differ from every later one in a few hundred single pixels on the vessel's bright metal and
in its glare, by 5 to 17 levels. Later captures agree with each other and with the first capture of
another load when that one comes late enough. So it is not a sequence that is not restarted: something
that lights the vessel is still changing when every feature reports idle.

## Evidence
Integration lab, `scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1`, 64 frames,
`tests/browser/integration/exact.spec.ts` (each test a new browser context), 2026-11-12:

| run (log under out/core-support/) | page | first capture against a later one |
|---|---|---|
| 22:13 (batch12.log) | every package | 261 pixels, max 7 levels; the later capture and a fresh load's agree |
| 22:44 (batch13.log) | every package | identical, three captures |
| 22:44 | without sky / vfx / cockpit / ocean / atmosphere (one each) | identical |
| 22:44 | without terrain | 550 pixels, max 15 (124 of them the pixels of 22:13) |
| 23:35 (batch15.log) | every package | identical, three captures; the probe had completed 18, 33 and 17 cycles at them |
| 23:35 | without terrain | 681 pixels, max 17; probe cycles completed 13 at the first capture, 27 at the later |
| 23:35 | without terrain, sky | identical |
| 23:35 | without terrain, cockpit | identical (probe 12, 26) |
| 23:35 | without terrain, atmosphere | identical (probe 8, 22) |
| 23:35 | without terrain, vfx | 637 pixels, max 9 (probe 12, 27) |
| 23:35 | without terrain, ocean | 496 pixels, max 5 (probe 12, 27) |

Where the pixels are: `out/screens/integration/exact-leo-day-same-page.diff.png` (22:13) and
`exact-leo-day-without-terrain.diff.png`: single pixels over the stack's metal, the capsule and the
adapter, a few in the glare beside them; 541 of 550 inside the vessel's box.

What this shows and what it does not. It needs the sky, the atmosphere and the cockpit together; the
terrain only delays the first capture (its tiles stream in first), which is why the full page usually
passes; the vfx and the ocean have no part. The vessel takes its ambient light and its reflections from
the sky's probe, and the probe reads the atmosphere's tables and cloud maps, so the probe is the likely
carrier: at the first capture it had completed 12 or 13 cycles, at the later ones twice as many, and the
feature's `isIdle` is true from the first completed cycle with the current data. I did not read the probe's
faces at the two captures, and I cannot say what the cockpit's part is (the probe had completed as many
cycles without it, and the captures agreed).

## Requested change
The sky's to find and choose; what the capture needs is that the vessel's light does not change after the
features report idle. For instance: the sky reports busy until two consecutive completed probes agree (or
until what the probe reads from the atmosphere is itself at rest), so that `renderExact`'s lead-in waits
for it as it waits for the terrain's fades; and a look at what the cockpit adds to an exterior view that
the probe or the vessel's shading reads.

Must not change: the probe's ramp between completed probes in a running game.

## How to see it
`npx playwright test tests/browser/integration/exact.spec.ts` logs the probe's completed cycles at each
capture and asks (softly) for three bit-identical captures; the page with `&without=terrain` shows the
difference in most runs (the diagnosis tests were taken out of the spec again; they are in its history,
commit 82e1bb8).

## Lead note (2026-11-12): the harness discards the first capture until this is fixed

The request stays open and stays the sky package's, after the presentation sweep. Until then the reference
images do not depend on it: a reference capture, for a recording and for every comparison, is a LEAD-IN
frame-exact capture that is thrown away, then two more that must be identical to the bit; the second is the
capture (`captureReference` in `tests/browser/harness.ts`, the rule in `tests/browser/baselineLogic.ts`,
unit-tested in `tools/dev/baseline-logic.test.ts`). The number of pixels in which each load's lead-in
differed is logged and stored with the recording (`recorded.leadInDifferingPixels` in the manifest), so the
size of this effect per checkpoint is on record. If the two captures after the lead-in still differ, the
checkpoint fails as NOT FRAME-EXACT with the count: that would mean one more cycle of the probe is not
enough, and comes back to this request.

When the sky reports busy until its probe has converged, the lead-in can go; the requirement of two
identical captures stays.
