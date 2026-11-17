Status: open
From: the lead (the reference images, 2026-11-16; docs/handoff/lead-baseline-v2.md section 24)
Owner path: src/render/ocean/** (ocean), with src/render/terrain/** (terrain-render, the far water sheet) if it turns out to be the tiles
Blocking: no for the sweep's start (the gate gives an exact checkpoint up to three loads); it is why the gate needs that rule at all

## Problem
A view with the far sea under the horizon is not the same picture on every load. Each load is steady in
itself (every frame-exact capture of it is identical), but about one load in eight ends with a thin line
across the far sea drawn differently: in full, in part, or not at all. This is the second state that the
resolution of request lead-7 reports for `shoreline` ("something that is there or not when the page goes
idle", not attributed). It has now shown in `pad-noon` and in `ocean-climb-200m`, two checkpoints that
are exact: with some nine pictures of the sea to the horizon in the set, a gate run that asks every first
load to match fails two times in three with nothing changed.

## Evidence
`pad-noon` (`/labs/integration/?scene=pad&sun=180,65&sunsite=earth,18.987556,-155.603239&hud=0&governor=off&deterministic=1&paused=1`,
no setup; the integration lab on the FakeSim, frozen from its first frame), tree at 94be43c, 2026-11-16:

- Recorded on 2026-11-12 from three loads that were one picture; a fresh load matched it to the bit in
  four self-checks (2026-11-12, and twice on 2026-11-16).
- The full self-check of 2026-11-16 23:00: 1,440 of 921,600 pixels differ by up to 3 levels (mean 0.0007,
  99.9th percentile 1), all of them in x 0-623, y 206-238: a thin, slightly sloped line across the far sea
  just under the horizon, left of the lightning masts (`out/screens/baselines/pad-noon.actual.png` against
  `data/baselines/pad-noon.png`).
- The probe with sixteen loads, two captures each
  (`BASELINE_EXACT_PROBE=pad-noon BASELINE_EXACT_LOADS=16 BASELINE_EXACT_CAPTURES=2`): the two captures of
  every load are identical; fourteen loads are the recorded picture; load 4 differs from it in the same
  1,440 pixels (x 0-623, y 206-238, up to 3 levels); load 15 in 276 pixels, x 452-623, y 206-217: the right
  part of the same line.
- `shoreline` (the same sea from 350 m, request lead-7): 0.183 % and 0.076 % of its pixels differed from
  its recording by up to 3 levels in two self-checks of 2026-11-16, none in a third.
- `ocean-climb-200m` (the open Pacific at 8 N 140 W from 200 m, no land in sight; frozen from its first
  frame), in the next full self-check, 23:30: 652 pixels by up to 2 levels, two segments of a thin line just
  under the horizon (x 456-620 and x 1000-1217, y 147-182); it had matched to the bit in every load before
  (three recorded, four self-checks). So it is the sea itself, not the land's tiles near the site.
- In four full runs no other checkpoint differed: `pad-sunset`, `splashdown`, `parachute-descent`, the
  other ocean stations and the app on the pad matched their recordings to the bit in every load, about ten
  loads each. That is not proof that they cannot.
- No presentation file changed between the loads; only `wire-protocol` was working, in `src/net`.

A line that is there in whole or in part reads like something that arrives per cell or per tile (a field
that is baked or streamed, a level of detail that a selection takes or not) and is not waited for, or that
depends on the order in which things arrived, when the page reports idle.

## Requested change
Find what the line is and make it the same on every load: either the page is not idle until it has
arrived (the capture then waits for it), or what is drawn does not depend on the order of arrival.
`&without=<package>` on the lab page and the probe's `BASELINE_EXACT_LOADS` take it apart; at one load in
eight an arm needs some twenty loads (about ten minutes).

## Acceptance
`BASELINE_EXACT_PROBE=pad-noon,shoreline BASELINE_EXACT_LOADS=32 BASELINE_EXACT_CAPTURES=2 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional`
prints "identical" for load 1 against every other load of both checkpoints. The lead then removes
`notExact` from `shoreline`, records it (it becomes exact), and sets the gate's loads for an exact
checkpoint back to one.

## What the lead did meanwhile
- The gate (the self-check of `tests/browser/shell/baselines.record.spec.ts`) gives an EXACT checkpoint up
  to three fresh loads and passes it when one of them is its reference to the bit; a load that was another
  state is printed as OTHER STATE and listed at the end of the run for the lead. A change in the code moves
  every load and still fails. `BASELINE_EXACT_TRIES=1` is the gate as it was.
- `pad-noon` and `ocean-climb-200m` stay exact (their recording is the common state: 14 loads of 16).
  `shoreline`, whose other states are frequent, is `notExact` with this request and compared within its
  tolerance (mean 0.02, 99.9th percentile 3).
