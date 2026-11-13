Status: open
From: ocean
Owner path: src/render/atmosphere/** (atmosphere-clouds)
Blocking: no        (request lead-7: the near sea of a frame-exact capture after a stepped simulation; what still differs there is not the sea)

## Problem
After the simulation has been stepped and frozen again, a frame-exact capture of the integration lab is not the
same picture on every load, and the first capture of a load is not the later ones. The lead's probe put that on the
near sea, where most of the differing pixels lie (request lead-7). Taken apart by package, it is the atmosphere
package's state: without it every capture and every load is identical to the bit, with or without the ocean's
`resetTemporal`; without the ocean the differences are still there, over the whole frame, the sky's rows included.
(They gather in the bottom rows because that is where the sun's glitter on the sea makes a small change of the
light large.)

## Evidence
`tests/browser/ocean/exact.spec.ts`, view `near-sea-stepped` (the framing of lead-7: `/labs/integration/?scene=ascent
&start=450&throttle=1&sun=140,50&sunsite=earth,18.987556,-155.603239&hud=0&governor=off&deterministic=1&paused=1`,
`__integration.watchVesselFrom` 3 km east of the pad at 60 m, 180 steps of 1/60 s with the loop stopped, frozen),
three loads, three captures of 64 frames each, 1280 x 720, 2026-11-12:

| Page | capture 1 against 2 (each load) | capture 2 against 3 | load 1 against 2 | load 1 against 3 |
|---|---|---|---|---|
| every package | 128,984 to 134,459 px, up to 9 levels | 0 | 121 px, up to 1 | 43,863 px, up to 9 |
| `&without=ocean` | 24 to 31 px (the plume's column) | 0 | 52,684 px, up to 9 | 36,782 px, up to 6 |
| `&without=vfx` | 0 | 0 | 66,376 px, up to 9 | 67,102 px, up to 9 |
| `&without=atmosphere` | 0 | 0 | 0 | 0 |
| `&without=atmosphere`, the ocean's reset switched off | 0 | 0 | 0 | 0 |

(A later run of the page with every package: capture 1 against 2 141,875 to 147,455 px by up to 9; load against
load 8,312 px by up to 30 and 56,000 px by up to 8.)
The differing pixels of the pages with the atmosphere start in row 0 (sky: (18,0) 204,204,206 -> 205,204,206).
The same view frozen from its first frame (no stepping) is identical on every load (lead-7), so it is something
the atmosphere carries through a stepped simulation and through `resetTemporal`. A candidate from the hand-off:
the cloud clock ("simulation time, at most `maxTimeRate` x real time, never backwards"): 3 s of simulation stepped
in a fraction of a second of real time leaves it behind by an amount that depends on real time, and it then
catches up between the captures. Not looked into further: not the ocean's code.
`splashdown-stepped` (the capsule under its chutes, 240 steps): 1 to 19 px of the first capture against the second
with every package, 0 without the atmosphere.

## Requested change
After `resetTemporal()` the atmosphere's and the clouds' state is a function of the snapshot and of the count of
frames alone, also when the snapshot's time has moved since the page loaded (the cloud clock at the snapshot's
time, if that is it). Acceptance: `tests/browser/ocean/exact.spec.ts` prints `0 px` in every pair of its two
"with every package" lines (they are reported there, not asserted, until this is resolved; then the ocean asserts
them).

The 24 to 31 px in the plume's column between the first and the second capture (page without the ocean) are
vfx's or the vehicle's and are not part of this request; they are named in lead-7's resolution.
