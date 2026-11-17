Status: open
From: presentation-sweep
Owner path: src/core (the lead's; a new module, or src/core/contracts/sim.ts)
Blocking: no

## Problem
Every presentation package may import `src/core` only (boundary rules), and several of them need the same
few readers of a snapshot: the selected target while no session fills `Readouts.target`, the snapshot's
revision, the active vessel when there may be none, part keys, the lineage of a craft, the cabin of a
vessel. The sweep owns only `src/core/fakes` and `src/core/gpu` inside `src/core`, so those readers live in
`src/core/fakes/snapshotAccess.ts`, beside the fake session. Nothing in the file is fake, and production
code (the HUD, the map, the camera rigs, the vessel and cockpit features, `src/app`) now imports from a
directory called `fakes`.

## Evidence
`grep -rn "core/fakes/snapshotAccess" src labs tests --include=*.ts -l` (the importers). The file's header
says why it stands where it stands and what goes at the tighten.

## Requested change
At the contract tighten after sub-wave 3.2, give the module a home of the lead's choosing in `src/core`
(for example `src/core/snapshot/access.ts`) and move the file there; the importers change by their import
path only. In the same step:
- `revisionOf(snapshot)` becomes `snapshot.revision` (the one reader of `SimSnapshot.tick` goes);
- `targetOf(readouts)` becomes `readouts.target` (`TargetView` is the derivable part of `TargetReadout`,
  with the same field names; the one reader of `Readouts.targetBodyId` / `.targetClosestApproach` goes);
- `craftsOf`, `craftIdOf` and `parentOf` lose their fallbacks for a snapshot without craft blocks.
What must NOT change: `CraftLineage` (the vessel feature files a part's wear under its lineage key),
`cabinOf`, `eventPartOf` until event part ids have one form, and `labelVehicleOf` until request
presentation-sweep-3 is answered.
