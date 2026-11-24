Status: resolved (island-core, commit 4c9a569)
From: fleet-data
Owner path: src/sim/vessel/staging.ts, src/sim/vessel/split.ts, src/sim/vessel/dock.ts, src/sim/vessel/facade.ts (island-core this wave)
Blocking: no

## Problem
Two pieces of module behaviour that fleet-data built in its own files need a call from the vessel code that
island-core owns:
1. A docking port's state is data (src/sim/vessel/modules/dockingPortState.ts): 'occupied' while a stacked part
   stands on its face (the escape tower on the Kestrel LF's port), 'disabled' while unarmed or shielded by a closed
   fairing, 'hard' on a dock link, else 'ready'. `refreshPortStates(vessel)` brings the stored state into agreement
   with the structure; the assembler calls it, but after a stage fires, a split or a merge the stored state stays
   what it was (the Kestrel's port reads 'occupied' after the tower has gone until something refreshes it).
2. Command authority (src/sim/vessel/modules/remoteCommand.ts): `hasCommandAuthority(vessel, craft?)` is true when
   a command part has living crew aboard or is flagged `remote`. `isControllable` (facade.ts line 74) counts any
   command module, so an empty cabin launched without remote avionics, or a capsule whose crew are lost, still
   flies.

## Evidence
tests/unit/fleet/modules.test.ts calls `refreshPortStates` itself after `splitForStage` to see the port go from
'occupied' to 'disabled'; without it the state stays 'occupied'. No existing vehicle has a port or an uncrewed
command part, so the mission is not concerned either way.

## Requested change
1. Call `refreshPortStates(vessel)` on every vessel a structural operation leaves (after `runSequence` /
   `applyStageInstant` in staging.ts, on every piece `separateVessel` returns, after a merge in dock.ts), and in
   `structureOf`'s rebuild if that is the one place every change passes through.
2. Make `isControllable` (and whatever gives the helm its authority) `hasCommandAuthority(vessel)` instead of
   "has a command module". For the lunar stack nothing changes (its capsule has living crew until a mission
   failure).
Must NOT change: the golden mission hash (port states and authority do not enter a flight without ports and with
crew aboard).

## Resolution
1. `rebuildStructure` (src/sim/vessel/structure.ts) calls `refreshPortStates(vessel)` right after it has
   recomputed the fairing shielding of every part. Every structural change (a stage, `separateVessel`, a
   jettisoned fairing, `dockMerge`, the clamp weld, a destroyed part) invalidates the structure, so each one
   passes there before anything reads the vessel again; a call inside `separateVessel` itself would have read
   the shielding of before the change. A port's 'soft' and 'cooldown' are kept, as `derivedPortState` says.
2. `isControllable(vessel)` (src/sim/vessel/facade.ts) is `hasCommandAuthority(vessel)`. In the island the
   member's `controllable` flag follows the command parts AND their crew (it is looked at again when the part
   count or `Vessel.crewAlive` changes in a step), and a seat on a vessel without command authority commands
   nothing: its `controls` and `command` inputs are refused with the reason 'No command authority' (the
   latched controls stay where they were). `VesselSnapshot.controllable`, the debris rules, the vessel disc
   of the terrain policy and "every command part was lost" all read the same flag.
What to re-run: `npx vitest run tests/unit/fleet/modules.test.ts`. The mission is unchanged (golden
`f0c0855ea40d8c59`, 35 of 37 with the two guard tests that wait for the lead's re-record): the lunar stack
has no port, and its one command part has living crew throughout.
