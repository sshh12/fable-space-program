Status: resolved (island-core, commits 4c9a569 and a7d53a5)
From: solar-system-sim
Owner path: src/sim/world/sim.ts, src/sim/world/environment.ts, src/sim/island/**, src/sim/view/**, tests/unit/sim-world/viewReference.json (island-core)
Blocking: no

## Problem
The body system, the predictor and the navigation of wave 4.1c (src/sim/bodies, orbit, nav: solar-system-sim)
add what the island and the view call on the Sun-rooted library. Nothing below changes a number of the shipped
three-body library (the mission flew 36 of 36 at the golden 72c0893583aa427d with every change of mine in, the
view reference passes 3 of 3); each item is what the island needs to be right on the staged 32-body library.

## Evidence
- `npm run test:mission` (gated): 36 of 36, golden unchanged (twice: with the three-revolution encounter search on
  and off).
- `npx vitest run tests/unit/sim-world/viewReference.test.ts`: passes with the predictor's default as committed;
  with `encounterRevolutions: 3` as the default it fails at "sample 46 (qa-translunar, start, peek): block
  "patches" differs" (an encounter on a later revolution is now shown), and only there in the patches block.

## Requested change
1. **The three-period encounter search (ARCHITECTURE 8.4).** WHAT FLIPS: one of two lines, whichever you
   prefer: (a) `DEFAULT_ENCOUNTER_REVOLUTIONS` in src/sim/orbit/patches.ts from 1 to 3 (my file: say so here and I
   commit it), or (b) `encounterRevolutions: THREE_PERIOD_ENCOUNTER_SEARCH` (exported by patches.ts) passed at the
   two call sites that are yours, src/sim/view/planning.ts:130 (the map's current and planned patches) and
   src/sim/island/rails.ts:27 (the rails event of a coasting vessel). WHAT IT CHANGES: a closed orbit whose
   first revolution misses a moon's sphere and whose second or third meets it ends in that sphere
   ('soiEnter') instead of 'closed'; nothing else (the search runs only on a patch that is 'closed' after its
   first revolution, about a body with children). On the shipped library that is exactly ONE recorded number
   of yours: the `patches` block of tests/unit/sim-world/viewReference.json at sample 46 (qa-translunar,
   start, peek); the flight does not change (mission 36 of 36 at golden 72c0893583aa427d with it on and off,
   measured by the first builder). HOW TO VERIFY: `npx vitest run tests/unit/solar-system/defaults.test.ts`
   (both settings on an Earth orbit that meets the Moon on its second revolution: 'closed' under 1, a Moon
   encounter under 3); `npx vitest run tests/unit/sim-world/viewReference.test.ts` (fails only at sample 46 until
   you re-record it); `npm run test:mission` (the golden unchanged).
2. **Sunlight in the planet frame.** `BodySystem.sunDirectionAt(bodyId, rBci, ut)` and
   `sunVisibilityAt(bodyId, rBci, ut)` take the vessel's BCI state and compute in its planet system's frame;
   on the shipped library they are the same expressions as `sunDirection(stateRoot + rBci)` and
   `sunVisibility(...)` to the bit (tested through `orbitalEnvironment`). On the staged library the ROOT form
   loses digits to the heliocentric position (sun visibility 9e-8 at a lunar sunrise). Please use the BCI form
   where the World takes the sun sample (sim.ts:471) and in the island.
3. **Altitude on an oblate body.** `surfaceRadius(def, dirFixed)` and `altitudeAboveSurface(def, rFixed)`
   (src/sim/bodies/shape.ts): the atmosphere is sampled at the altitude above the reference SURFACE (the
   spheroid of `BodyDef.shape`; the radius when there is none, so no change today). Please pass
   `|r| - surfaceRadius(def, dirFixed)` to `atmosphereAt` and use it for `altitudeAsl` and the navball switch
   on bodies with a shape (Jupiter's 1-bar level is 1,580 km above its mean sphere at the equator). The radar
   altitude is unchanged: baked heights already carry the shape.
4. **Bodies without a surface.** `belowFloor(def, rFixed)` is true below `atmosphere.floorAltitude` above the
   reference surface of a body with `surface: 'none'`: the vessel is destroyed with cause 'overstress'
   (ARCHITECTURE 8.3). The predictor already ends a trajectory there (an 'impact' at the floor).
5. **Vessel and port targets** (the signatures the view calls; you wire `Readouts.target` and the navball):
   `relativeState(system, own, target, ut)`, `lvlhOffset(own, target)`, `vesselTargetReadout(input)`,
   `navballTargetVectors(system, own, target, ut)` in src/sim/nav/target.ts; `computeNavball` takes
   `relativeVelocity` (the relative prograde and retrograde markers, and prograde/retrograde in mode
   'target'); `chainClosestApproaches(system, ownChain, targetChain, opts)`, `ownChain(current, planned)`,
   `targetApproachMarkers(approaches, otherVesselId)` in src/sim/orbit/chainApproach.ts. Exact signatures in
   docs/handoff/solar-system-sim.md section 2.

6. **Terrain on the Sun-rooted library.** WHAT FLIPS: `preload: 'launchSystems'` passed by the creators of a
   SIMULATION provider: tools/sim/realWorld.ts:73 (`createRealTerrain`, the World's provider in the mission and
   every tool) and src/app/game.ts:182 (the app's; shell-menu's file, so the same line is for them). Not the
   tile worker (src/render/terrain/tileWorker.ts:31 names its bodies) and not the provider's own default,
   which stays 'all' (v1's behaviour for every test that creates a provider and queries at once). WHAT IT
   CHANGES: on the shipped library nothing (Earth and the Moon are the launch site's system, so both settings
   preload the same two bodies and answer the same heights: tests/unit/solar-system/defaults.test.ts); on the
   staged 32-body library only the Earth and the Moon are preloaded and the other 25 terrain bodies load at
   their first `ensureLoaded` / `prepareTile` / `loadBody` and are released after their last slot ('all' there
   would pin 27 pyramids and overrun the 384 MiB cache budget); a band-limited query on a body that is not
   loaded answers the datum and `residency()` says it is not resident. The World's terrain policy already
   requests discs with `ensureLoaded` before contact. HOW TO VERIFY: `npx vitest run
   tests/unit/solar-system/defaults.test.ts tests/unit/terrain-core/lazyResidency.test.ts`; `npm run
   test:mission` (the golden unchanged: the same two bodies preloaded in the same order).

7. **A vessel about a body without terrain (found in the transfer flights, 2026-11-24).** On the staged library the
   map's impact marker on the Sun reaches `Seat.hintImpact` -> `IslandImpl.hintImpact` (island.ts:1189) ->
   `TerrainPolicy.request` -> `ensureLoaded('sun', ...)`, and the provider throws "body "sun" is not served by this
   provider" (the Sun has no terrain section). Guard `hintImpact` / `TerrainPolicy.track` by
   `frames.base(bodyId).hasTerrain`, as src/sim/world/start.ts and record.ts are. The impact marker itself came from
   the defect of request solar-system-sim-4 (blocking); this guard is needed independently of it (a real impact on
   a giant's floor is a marker on a body without terrain too).

Must NOT change: anything on the shipped library (each item above is identical there or not reached).

## Resolution
1. The view predicts with `encounterRevolutions: THREE_PERIOD_ENCOUNTER_SEARCH` (`Planning.ensurePatches`,
   src/sim/view/planning.ts). The recording of the wave-3 World is not re-recorded: the `patches` block of
   twelve states of `qa-translunar` (samples 46 to 55, 66, 67) differs by design and
   `tests/unit/sim-world/viewReference.test.ts` states each with its old and new value; every other block of
   every state is still equal. The mission is unchanged.
2. `BodyFrames.sunSample` (src/sim/island/frames.ts; the one place the island, the far set and the start
   state take the sun sample) uses `sunDirectionAt` / `sunVisibilityAt` with the BCI position.
3. `BodyFrames.aim` gives the environment the offset of the spheroid under the vessel, and the environment
   samples the air at the altitude above it (`IslandEnv.aim(..., surfaceOffset)`); `BodyFrames.altitudeAt`
   is that altitude for the far set's tier decisions, the navball's switch, the `flying` situation and
   `Readouts.altitudeAsl` on a body with a shape. A body without a shape takes the expressions it took.
4. `Island` (control-tick cadence, authoritative mode only: it is a threshold outcome): a member below the
   floor of a body without a surface is destroyed by a `destroy` operation with cause 'overstress'.
   Tested on the staged library (`tests/unit/sim-island/shape.test.ts`: the air over the pole and the
   equator of the first shaped body without a surface, the floor in both step modes).
5. Wired (a7d53a5): `vesselTargetReadout` for `Readouts.target` of a vessel or port target (centre to centre,
   or port to port when the control part is a port), `chainClosestApproaches` / `ownChain` /
   `targetApproachMarkers` for its closest approaches and the pair markers on the patches,
   `navballTargetVectors` and `computeNavball({ relativeVelocity })` for the target direction, the relative
   markers and the navball's target mode (src/sim/view/target.ts, planning.ts, snapshot.ts;
   tests/unit/sim-world/vesselTarget.test.ts). `lvlhOffset` and `relativeState` are reached through the
   read-out. The docking instrument (`Readouts.docking`) is not built: docs/handoff/island-core.md, 5.1.
6. `createRealTerrain` (tools/sim/realWorld.ts) passes `preload: 'launchSystems'`.
Verified: mission 35 of 37 at the unchanged golden `f0c0855ea40d8c59` (the two red tests are the pinned
guard's, request island-core-1); `npx vitest run tests/unit/sim-world tests/unit/sim-island`.
