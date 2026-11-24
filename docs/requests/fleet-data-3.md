Status: open
From: fleet-data
Owner path: labs/vfx/scenes.ts, labs/vehicle/main.ts, labs/integration/main.ts, tests/unit/vfx/**, tests/unit/vehicle/**, tests/unit/cockpit/** (capability-settings); labs/audio/scripts.ts, tests/unit/audio/model.test.ts, tests/unit/fakes/menuStores.test.ts (shell-menu); src/core/fakes/fakeSim.test.ts (the lead)
Blocking: no (worked around in fleet-data's paths)

## Problem
The library now holds eight vehicles (ARCHITECTURE 9.1). Several labs and tests take the FIRST vehicle of the
library for the lunar stack (`Object.keys(defs.vehicles)[0]`, `Object.values(defs.vehicles)[0]`), or the first
vehicle with a cockpit (`find((v) => v.cockpit)`): with the vehicles in file order that is `azimuth-pathfinder`
(no visuals yet, request fleet-data-2) or `meridian-egret`.

## Evidence
`grep -rn "vehicles)\[0\]" labs tests src` lists: labs/vfx/scenes.ts:62, labs/vehicle/main.ts:173,
labs/integration/main.ts:461, labs/audio/scripts.ts:365, tests/unit/vfx/model.test.ts:44,
tests/unit/vfx/effects.test.ts:149,175, tests/unit/vfx/director.test.ts:51, tests/unit/vehicle/parts.test.ts:600,
partHistory.test.ts:55, mounts.test.ts:74,96,115,131, ghosts.test.ts:27, tests/unit/audio/model.test.ts:112,122,
tests/unit/fakes/menuStores.test.ts:19, src/core/fakes/fakeSim.test.ts:139; the cockpit tests and labs use
`find((v) => v.cockpit)`. Before the workaround 13 vfx tests failed.

## Workaround (fleet-data, commit c441308)
The loader lists the vehicles stated flat in their files first (meridian-lunar is the only one) and the
vehicles composed of assemblies after them, so the first vehicle is the lunar stack again and the first with a
cockpit too. This is an ordering of the library, not a contract.

## Requested change
Name the vehicle meant (`'meridian-lunar'`, or the scenario's `vehicle`) instead of taking the first of the
library, so the order of the library carries no meaning. Must NOT change: what the labs and tests show today.
