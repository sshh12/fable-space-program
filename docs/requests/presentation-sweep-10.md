Status: resolved (lead, 2026-11-24, the tighten step after sub-wave 3.2: `PartSnapshot.stageOrder`)
From: presentation-sweep
Owner path: src/core/contracts/sim.ts (`PartSnapshot`, the lead) and its producer src/sim/vessel/facade.ts (`vesselPartSnapshots`, the simulation's package)
Blocking: no (the HUD of every vehicle of the library lists its groups as before the sweep; tests/unit/flight-ui/resources.test.ts holds each of them to it)

## Problem
(Review minor 15a of the sweep's fix round. Minor 10, the map's at-intercept anchors, needed nothing from
the simulation and has no request: commit 619e23c.)

The HUD's resource panel and the MFD's systems page list the propellant-flow groups of a craft. Before the
sweep they came in the order of `VehicleDef.stageGroups`. Since the sweep nothing in the presentation looks
a vehicle up by an id of a snapshot (tests/unit/fakes/deprecated.test.ts, rule `vehicles`), and a snapshot
states a part's group and the group's label (`PartSnapshot.stageGroup`, `stageLabel`) but not the order of
the groups. `describeResources` (src/ui/model.ts) therefore lists them in the order in which the part list
first shows a part of each that holds a resource. A vehicle whose file lists its groups in another order
than its parts carry them has its bars in another order than before the sweep.

## Evidence
- `data/defs/vehicles/meridian-lunar.json`: `stageGroups` reads capsule, les, les-jettison, ascent, descent,
  fairing, m3, m2, m1, pad; the parts first show them as capsule, les, les-jettison, ascent, descent, m3,
  fairing, m2, m1, pad. The lists differ (fairing and m3), and the HUD is the same only because the fairing
  holds no resource.
- `npx vitest run tests/unit/flight-ui/resources.test.ts`, three tests on the real session (`createSession`):
  1. every vehicle of the library with 0 to all of its stages fired: today's groups equal the computation of
     before the sweep (commit 1a93c40^), field for field, in the same order;
  2. the same for every scenario of the library as its session starts it;
  3. a copy of the vehicle whose `stageGroups` has two fuelled groups the other way round: the computation of
     before follows the file, today's follows the parts. That is the difference this request closes; test 1
     fails for a library vehicle that has it.

## Requested change
`PartSnapshot.stageOrder?: number`, beside `stageGroup` and `stageLabel`, optional until the tighten step:
the index of the part's group in the `stageGroups` list of the vehicle its craft was built from (0 = the
first). Absent = not stated.

- Producer: src/sim/vessel/facade.ts:38-39, where the list is already searched for the label:
  `stageOrder: craft.vehicle.stageGroups.findIndex((g) => g.id === p.stageGroup)`. The fake states it where
  it states `stageGroup` (labs/flight-ui/labVehicle.ts tags the lab vehicle's parts).
- Consumer (the presentation's own path, no further contract change): `describeResources` sorts the groups
  of each craft by it, stably, when every part of the vessel states it, the craft in the order of
  `VesselSnapshot.crafts`; test 3 above then asserts equality.

What must NOT change: `stageGroup` and `stageLabel`; the state hash and the vessel codec (the value is
derived at snapshot time from the craft's vehicle, as the label is); what the HUD shows for the library's
vehicles (the two orders agree for them, so no reference image moves).

## Resolution (lead, 2026-11-24)

`PartSnapshot.stageOrder: number` (required, made with the tighten step): the index of the part's group in
`VehicleDef.stageGroups` of the vehicle its craft was built from, 0 = the first; -1 for a part whose group
the vehicle does not list. Producer: `vesselPartSnapshots` in `src/sim/vessel/facade.ts`, beside the
label. Derived when the snapshot is built: not in the saved state and not in the state hash. The fakes and
the hand-built snapshots state it where they state `stageGroup`, and `describeResources` orders the groups
of each craft by it; for the library's vehicles the order on screen is what it was.
