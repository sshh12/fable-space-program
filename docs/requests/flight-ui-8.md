Status: open
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
