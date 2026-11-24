Status: open
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
1. **The three-period encounter search (ARCHITECTURE 8.4)** is `PredictOptions.encounterRevolutions`
   (src/sim/orbit/patches.ts; `THREE_PERIOD_ENCOUNTER_SEARCH = 3`). Its DEFAULT is 1 (v1's window) so that your
   snapshot reference holds. When you re-record the reference (or at the session switch), pass
   `encounterRevolutions: THREE_PERIOD_ENCOUNTER_SEARCH` where the view predicts patches, or tell me to change
   the default and I will; it moves the `patches` block of qa-translunar and not the flight.
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

Must NOT change: anything on the shipped library (each item above is identical there or not reached).
