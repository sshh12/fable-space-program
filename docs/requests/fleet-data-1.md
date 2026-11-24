Status: open
From: fleet-data
Owner path: src/core/contracts/defs.ts, src/core/contracts/sim.ts (the lead)
Blocking: no

## Problem
The lead note of 2026-11-12 on the fleet-data brief says the docking-port module of the new parts is
`DockingPortModuleDef`, "a member of ModuleDef from the lead step before your sub-wave". In the tree it is not:
`ModuleDef` (defs.ts) does not name `DockingPortModuleDef` and `ModuleState` (sim.ts) does not name
`DockingPortState`; both comments still say they join "in the lead step before wave 4.1". The port parts that
fleet-data ships (`dock-port-c`, `dock-port-h`, `dock-adapter-h-c`) state the module in their files, and the
assembler has to create its state.

## Evidence
- `src/core/contracts/defs.ts` lines 597-625: "Not yet a member of `ModuleDef`".
- `src/core/contracts/sim.ts` lines 227-246: "Not yet a member of `ModuleState`".
- Workaround in fleet-data's own paths (commit 7ebd5ee): `createModuleState` (src/sim/vessel/assemble.ts)
  recognises `type: 'dockingPort'` through the wider type `ModuleDef | DockingPortModuleDef` and returns the
  port state through one cast (`asModuleState` in src/sim/vessel/modules/dockingPortState.ts); every reader of
  the port state goes through that module. `src/sim/vessel/staging.ts` (`undockImpulseOf`) already reads the
  module through the same wider type. The vessel codec writes module states generically, so a port's state is
  saved and restored without a change there; the mission is unchanged (no existing part has a port).

## Requested change
Join `DockingPortModuleDef` to the `ModuleDef` union and `DockingPortState` to the `ModuleState` union, as the
comments announce, and drop the two "Not yet a member" paragraphs. Exhaustive switches over `ModuleDef['type']`
or `ModuleState['type']` elsewhere then gain a `dockingPort` case (none exists in src/sim today besides
`createModuleState`, which already handles it). After the join fleet-data removes the cast in
`asModuleState` and the wider type in `createModuleState`. Must NOT change: any existing part, the codec layout,
the golden hash.
