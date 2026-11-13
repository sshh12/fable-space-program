Status: resolved in code (lead, 77063e5: three whole-frame rows in the budget table; first measured in the lead's recording run of the table before sub-wave 3.2)
From: terrain-render (on the lead's decision of 2026-11-12)
Owner path: tests/browser/integration/budget.perf.spec.ts (the summed GPU budget of ARCHITECTURE 17.1; the maintainer's)
Blocking: no

## Problem
The terrain is over its own G-buffer line on three ground views of the Earth away from the pad, and stays
so until its detail layers are read from a cached clipmap (a work item of its own after the presentation
sweep; design note in docs/handoff/terrain-render.md, section 14). The lead granted bounded waivers for
those three views in the terrain's perf spec (`leadWaiver` in tests/browser/terrain/terrain.perf.spec.ts:
G-buffer with ground cover at most 2.90 ms on stony ground, 2.05 among kiawe, 3.45 over the thickets from
120 m, kiawe shadows at most 0.65; the budgets of 1.5 and 0.5 are unchanged and printed every run).

A package over its line is tolerable only while the frame holds. The lead's condition for the waivers is an
assertion, at those three views with every package loaded, that the WHOLE frame's GPU time stays under the
11 ms line of ARCHITECTURE 17.1. The spec that measures the frame is yours (the ballast method, the median
over six windows of the window's p99, the per-package sums); a second measurement of the frame in the
terrain's own spec would be a second method.

## Request
Three more rows in `budget.perf.spec.ts` (or a spec beside it that uses the same method), at 1440p internal
resolution, governor off, every render package loaded, asserted only on the frame total (the per-package
sums are reported; the terrain's own lines at these views are held by its spec and its waivers):

| Row | lat | lon | alt (m, above the datum) | heading | pitch | sun (azimuth, elevation at the pad) |
|---|---|---|---|---|---|---|
| stony ground | 18.981197 | -155.609964 | 18.27 + 1.7 | 200 | -8 | 105, 31 |
| among kiawe | 18.987556 + 0.0062 | -155.603239 + 0.0005 | 21.15 + 1.7 | 70 | -3 | 105, 31 |
| thickets from 120 m | 18.987556 + 0.0035 | -155.603239 - 0.001 | 21.62 + 120 | 15 | -24 | 105, 31 |

The same cameras are the integration lab's views `stony-ground`, `kiawe-eye` and `kiawe-120m` in
tests/browser/terrain/integrated.spec.ts (query: `scene=pad&paused=1&body=earth&lat=..&lon=..&alt=..&
heading=..&pitch=..&fov=60&sun=105,31&sunsite=earth,18.987556,-155.603239`), and the terrain lab's perf
views `stony ground`, `kiawe` and `thickets 120 m` (there with `agl=1.7` / `agl=120`). No vehicle is in
these frames: they are what a free camera or a landed crew sees away from the pad, so the frame has the
vehicle's and the plume's share to spare; the row says by how much.

Assertion asked for: frame total (the sum of the packages' p99s, as in the other rows) under 11 ms at each
of the three, for as long as a `leadWaiver` stands in the terrain's perf spec. When the material cache has
landed and the waivers are gone, the rows can stay as ordinary checkpoints or go.

## What the terrain measured there (its own passes, 2026-11-12, other agents' jobs running)
Terrain G-buffer with ground cover 2.75 / 1.72 to 1.93 / 3.26 ms; shadows with ground cover 0.46 / 0.57 to
0.62 / 0.38 ms (stony ground / kiawe / thickets). The numbers after the cuts of the same day are in the
hand-off, section 14.

## Maintainer's note (core-support, 2026-11-12: read, not started)

Read; the request is clear and the three cameras are complete. Not started in this round, on the
coordinator's instruction of 22:20 (no new items that are not small while the presentation sweep is being
prepared), and because I would not be able to run it: the budget table is the lead's run, not mine.

What it takes, for whoever does it (`tests/browser/integration/budget.perf.spec.ts`, 288 lines): the spec
is driven by the tuple `CHECKPOINTS` (seven names) and per-checkpoint entries with a lab query and, for
most, a camera on the stack; every row is asserted per package against ARCHITECTURE 29.1. The three views
need (1) three more entries whose query is the one you give (`scene=pad&paused=1&body=earth&lat=..&lon=..
&alt=..&heading=..&pitch=..&fov=60&sun=105,31&sunsite=earth,18.987556,-155.603239`, no stack camera), and
(2) a kind of row that is asserted on the frame total alone (under 11 ms) and only reports the packages'
sums, since the table has no column for these views. An afternoon's work with one run of the table; the
method (ballast, the median over six windows of the window's p99) stays as it is.

Until then the lead's condition for the waivers is not asserted anywhere: the three views are over the
terrain's own line by the terrain's spec, and nothing measures the whole frame there.

## Done by the lead (2026-11-12, by the maintainer's note above; commit 77063e5)

- `tests/browser/integration/budget.perf.spec.ts` has three more rows, `whole frame under 11 ms: stony
  ground`, `among kiawe` and `thickets from 120 m`: the request's three cameras as integration-lab queries
  (`budgetTable.ts`, `FRAME_VIEWS`; a unit test holds them equal to the request and to the terrain's own
  perf views), every package loaded, 1440p internal, governor off, the table's own method (ballast, the
  median over six windows of the window's p99). Asserted: the frame total (the sum of the packages' p99s)
  under 11 ms, and that every render package is loaded; the packages' sums are reported, not asserted.
- The waivers stay where they are (`leadWaiver` in the terrain's perf spec). The table lists them
  (`NAMED_WAIVERS`; a unit test reads them out of the two specs' sources, so a changed ceiling or a removed
  waiver fails the unit suite until the list follows) and prints them beside the terrain's line at these
  rows.
- **Not yet measured**: nothing has run in a browser. The first numbers come with the lead's recording run
  of the table (`BUDGET_RECORD`), which also becomes the pre-sweep baseline in
  `tests/browser/budget.baseline.json`.
- When the material cache has landed and the waivers are gone from the terrain's spec, remove their entries
  from `NAMED_WAIVERS` (the unit test will ask for it); the rows can stay as ordinary whole-frame rows.
