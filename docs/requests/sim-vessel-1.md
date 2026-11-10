Status: open
From: sim-vessel
Owner path: src/core/contracts/defs.ts, src/core/contracts/simInternal.ts (doc comments only)
Blocking: no

## Problem
Four points of the part/vehicle contract are silent or ambiguous, and one number in `sim-design.md` contradicts
its own example. sim-vessel had to pick a meaning for each to implement the package; the choices are in force in
`src/sim/vessel`, the part data and the hand-off note, but the contract comments should say so, because the
vehicle, vfx and world teams read `defs.ts`, not my code.

## Evidence
1. `ModuleDef` `rcs.thrusters[].dir` has no comment. `NozzleDef.dir` is documented as the EXHAUST direction, while
   `sim-design.md` 7.3 describes RCS thrusters by their force direction. Implemented and authored as: **`dir` =
   unit exhaust direction in the part frame, thrust acts opposite** (same as `NozzleDef.dir`, so plumes are drawn
   along `dir` for engines and thrusters alike).
2. `ModuleDef` `legs` has no pad radius, friction or crash tolerance. Implemented as: **for a part with a `legs`
   module, `PartDef.contactPoints[i]` describes the foot pad of leg `i`** (`radius`, `mu`, `crashTolerance`; `pos`
   repeats `footDeployed`) and is not a structural probe. The lateral touchdown limit is 0.625 x `crashTolerance`
   (2.5 of 4.0 m/s, sim-design 9.2).
3. `ModuleDef` `decoupler` / `StageAction` `decouple`, `jettisonLES`: which joint breaks is not stated. Implemented
   as: **the joint between the named part and its PARENT is cut**; `separationPlaneY` is the height of that plane
   in the part frame; the impulse acts along the part's Y axis, equal and opposite on the two sides.
   `fairing.shields` entries match a part's instance id OR its def id (the data uses def ids). `PartDef.joint
   .maxQAlpha` is in Pa rad.
4. `VesselEnvironment` does not say which instant it describes. `stepVessel(vessel, env, controls, dt)` assumes
   **`env.ut`, `qFixedToInertial` and the swell are those of the START of the step**; vessels returned in
   `StepResult.spawned` are in the start-of-step state and must be stepped once in the same tick.
5. `sim-design.md` 8.2: "the launch stack fails if q * alpha > 60 000 Pa rad (e.g. 6 deg at 33 kPa)". 6 degrees at
   33 kPa is 3 456 Pa rad (198 000 Pa deg); 60 000 Pa rad could never be reached. The data uses the example:
   `maxQAlpha` 3 500 Pa rad on the weakest joint (M-2/M-3 interstage), 4 000-5 000 on the others. A nominal ascent
   with the pitch programme of 16.2 peaks at about 510 Pa rad; the 4 degree limit of phase 2 at 31 kPa is 2 160.

## Requested change
Doc comments in `defs.ts` stating points 1-3 (no type change), one sentence in `simInternal.ts` for point 4, and a
note next to ARCHITECTURE/sim-design for point 5 if the lead prefers a different limit (it is one number per part
in `data/defs/parts/meridian-*.json`). Nothing must change in the types.
