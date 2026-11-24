Status: resolved (island-core, the commit that adds this resolution)
From: solar-system-sim
Owner path: src/sim/view/host.ts, src/sim/view/presenter.ts, src/sim/view/snapshot.ts, src/sim/world/warpLadder.ts, src/sim/island/island.ts (island-core)
Blocking: YES for every flight that leaves a planet's sphere on the Sun-rooted (staged) library: the transfer-pilot
acceptance flights of solar-system-sim (Mars x3, Venus, Callisto, Phobos) and, after them, session-switch's gate.

## Problem
On the staged library the root body is the star. When a craft leaves the Earth's sphere, `IslandImpl.handOver`
(src/sim/island/island.ts:562-569) moves the island into reference-orbit mode ("every state becomes an offset";
`usesReference(sun)` is true), so `rec.vessel.r` / `.v` are OFFSETS from the reference orbit and
`posOf` / `velOf` / `stateOf` add the reference back. The view and the World read the raw offset as the
Sun-centred state:
- `planSubject` (src/sim/view/host.ts:27) takes `comStateOf(a.vessel)`: the plan's `com` is the offset, so
  `predictPatches` (src/sim/view/planning.ts:130) is handed a state 10 m from the Sun's centre at rest;
- the snapshot's `VesselSnapshot.r` / `.v` of the active vessel are the offset;
- `frames.aim(..., e.vessel.r, ...)` in src/sim/view/presenter.ts:98 and :101 aims the environment at it;
- the warp ladder (src/sim/world/warpLadder.ts:132, :141) takes its altitude and next event from `s.com`.
Consequences, measured: the current patch about the Sun is a radial conic (e = 1, p = 0); the warp is held at
index 3 ("Altitude too low for a higher warp level"), i.e. 4x physics steps for a 200-to-900-day cruise; the
map's impact marker lands on the Sun, `Seat.hintImpact` -> `IslandImpl.hintImpact` (island.ts:1189) ->
`TerrainPolicy.request` asks `ensureLoaded('sun', ...)`, and the terrain provider throws "body "sun" is not served
by this provider" (the Sun has no terrain section).

## Evidence
On a clean worktree of 8c41d1a (no uncommitted file of anyone's; data/tiles linked), the transfer pilot on
`transfer-leo-200` from 977493600 (i 19 deg, node 176.70 deg: tests/unit/solar-system/flightPlane.ts): the
departure burn (3,669 m/s) flies and the predicted patches before the exit are right ("earth soiExit 0.97-3.99 d",
then "sun closed 3.99-474.20 d e 0.1782 a 177.0 Gm", with its Mars encounter planned). At 3.987 d, the first
snapshot about the Sun: active vessel r = (-10.26, 2.30, -0.36) m, |v| = 0.0 m/s, altitude -6.957e8 m,
patches.current[0] = { sun, closed, e 1.0000, a 0, p 0 }, warp { index 3, maxIndex 3, limitedBy "Altitude too low
for a higher warp level" }. The same numbers on the shared tree. The flight test then crawls at 4x physics
(574 s of wall time for two days) until the terrain throw.
Reproduce: `SOLAR_SYSTEM_FLIGHTS=mars SOLAR_SYSTEM_VERBOSE=1 node tools/dev/heavy.mjs --class=cpu -- npx vitest run
tests/unit/solar-system/transferFlight.test.ts --silent=false -t 977493600` (about 10 s of wall time to the exit).

## Requested change
1. Wherever the view or the World takes a member's state as BCI of the island's body (the plan subject, the
   snapshot's vessel state, the presenter's environment aim, the warp ladder), take `island.stateOf(id)` (or the
   centre of mass of it) when the island uses a reference orbit, not `vessel.r` / `vessel.v`.
2. Guard `IslandImpl.hintImpact` (and `TerrainPolicy.track`) by `frames.base(point.bodyId).hasTerrain`, as
   src/sim/world/start.ts and record.ts are: a body without terrain (the Sun, the giants) has no disc to load.
3. A test of yours that flies a craft out of the Earth's sphere on the staged library and checks the snapshot's
   state about the Sun against `system.stateRelative` of the craft's Earth state at the exit (and that the warp
   reaches the top rails level in the cruise).

Must NOT change: the shipped library (its root is the Earth; no reference orbit is used there), the golden.
When this is in, the six flights of tests/unit/solar-system/transferFlight.test.ts are the check (hand-off
solar-system-sim section 6 has the commands and the numbers measured up to the exit).

## Resolution
1. The view never reads a member's own `r`, `v`: `ViewVessel` carries the state about the body (`r`, `v`:
   `Island.stateOf`) and, in an island with a reference orbit, `frame { reference, r, v }` (the reference
   point); `comOf(e)` is the centre of mass about the body. The plan subject (`PlanSubject.r`, `.com`), the
   snapshot's vessel state, the stage figures' gravity, the read-outs, the navball, the target geometry, the
   presenter's environment aim, the warp ladder's subject, the navball's altitude switch and the objective
   observer take those. The render root is the reference-orbit point where the focus island has one
   (`frame.origin = { kind: 'orbit', bodyId, r0, v0, t0 }`, ARCHITECTURE section 3): a member's offset is
   its ROOT position, a new epoch with its rebase starts at every hand-over and at every new reference orbit.
2. `IslandImpl.hintImpact` drops a hint on a body without terrain.
3. `tests/unit/sim-world/heliocentric.test.ts`: a capsule leaves the Earth's sphere on the staged library;
   the snapshot's state about the star equals the Earth's state plus the craft's Earth-centred conic to
   under 1 m and 1 mm/s, the read-outs and the first patch are those of an ellipse about the star, the
   render root is the reference point (the craft under 100 m from it, the rebase names the Earth's centre),
   the warp reaches the top level and a ten-day rails cruise and a presentation snapshot stay sane. It failed
   before the change at "expected 1.74 to be greater than 1e11".
Unchanged on the shipped library: mission 35 of 37 at the golden, the 200 recorded view states.
To re-run on your side: the six flights of tests/unit/solar-system/transferFlight.test.ts.
