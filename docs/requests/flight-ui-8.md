Status: resolved (sim-core-v2; the commit that adds this section)
From: flight-ui
Owner path: src/sim/world/sim.ts (`stageInfos()`, the StageInfo cache) - shared-code maintainer / sim owner
Blocking: no (flight-ui derives the coasting acceleration without the TWR: `stageAcceleration`, src/ui/model.ts)

## Problem
`SimSnapshot.staging.stages[i].twr` ("thrust-to-weight at current local gravity") goes stale on rails: the cache
in `stageInfos()` is refreshed when `stageInfoDirty` is set or when `stepCount` crosses a PATCH_REFRESH_STEPS
boundary, and a rails coast does not advance `stepCount` nor does an SOI change set the flag. In the browser mission
at the Moon's SOI entry the descent stage's tile read "Δv 3 547 m/s · 0.00 m/s²": its TWR still held a gravity of
about 1.5 m/s^2 from where it was last computed near the Earth, while the vessel was 64 Mm from the Moon
(0.001 m/s^2). The same staleness shows as a wrong TWR after any long coast that changes altitude a lot (an
apoapsis climb, a translunar coast, an arrival in lunar orbit on rails).

## Evidence
`out/screens/mission/08-moon-soi-enter-chase.png` (right column, active tile). `src/sim/world/sim.ts` lines
~1765-1773 (`stageInfos()`), `src/sim/vessel/facade.ts` `stagingInfo` (`g = env.mu / r^2` at the time of the call).

## Requested change
Refresh the stage info when the active vessel changes its SOI body and at least every few seconds of simulated time
on rails (the TWR is the only g-dependent field; delta-v, burn time and propellant do not change while coasting),
e.g. key the cache on `(stepCount bucket, bodyId, floor(ut / 10 s))`. Must not change: the StageInfo fields and
their meaning, the per-frame cost (the stagingInfo call stays cached between refreshes).

## Resolution (sim-core-v2, 2026-11-12)

`SimSnapshot.staging.stages[i].twr` is now restated at the local gravity of the instant on EVERY read, not
only when the stage-info cache is refreshed. `World.stageInfos()` (`src/sim/world/sim.ts`) keeps, beside the
cached `StageInfo[]`, the full-throttle acceleration of every stage (thrust over mass, which is what the
ratio is at any gravity) and divides it by `mu / r^2` of the active vessel's SOI body at its current
position each time the info is read. So the ratio follows a translunar coast continuously and is right in
the first snapshot after a sphere-of-influence change on rails.

Chosen over the cache key the request suggests (`stepCount` bucket, body, 10 s of simulated time) because it
is exact at every snapshot and costs one division per stage: no extra `stagingInfo` call, at any warp level
(a key of 10 s of simulated time would rebuild the info on every frame of high rails warp).

Not changed: the `StageInfo` fields and their meaning; delta-v, burn time and propellant fraction (they do
not change on a coast and still come from the cache, which physics steps and vehicle changes refresh as
before); the trajectory (the stage info is not state, and the scripted pilot reads only
`propellantFraction` from it): `npm run test:mission` passes with the golden hash unchanged
(b850b94ea2dcc1a5).

Test: `tests/unit/sim-world/readouts.test.ts` ("thrust-to-weight ratio of the stages"): from `qa-translunar`
six hours of rails coast (gravity less than half), then on rails into the Moon's sphere of influence
(gravity below 0.01 m/s^2): for every stage with engines, ratio x local gravity equals the stage's
acceleration at the start, and delta-v is untouched.
