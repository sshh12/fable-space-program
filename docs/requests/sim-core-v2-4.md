Status: open
From: sim-core-v2
Owner path: src/core/contracts/sim.ts (the lead); consumer: src/render/vehicle/vesselFeature.ts (vehicle-pad, at the presentation sweep)
Blocking: no

## Problem
A piece that leaves a craft is a craft of its own (lead decision D2 of the sim-core-v2 review): its id is
`<parent craft id>.<instance id of its root part>` and the simulation records the craft it left
(`CraftRuntime.parent`). The snapshot does not say so: `CraftSnapshot` has no lineage field. A consumer
that carries per-part presentation state across a separation (the temperature of a nozzle, the pose of an
arm) therefore has nothing to read but an id to take apart.

Today `src/render/vehicle/vesselFeature.ts` takes the launched craft of a debris vessel from the text
before `~` in its VESSEL id (`rootOf`). The lead ruled that a consumer must not parse a vessel id and
should read the craft's parent from the snapshot.

## Evidence
`src/core/contracts/sim.ts`, `CraftSnapshot`: `id`, `vehicleId`, `name`, owner, `commandPart`, `cockpit`,
`staging`, `chase`, `policy`. `src/sim/vessel/types.ts`, `CraftRuntime.parent`. `src/render/vehicle/
vesselFeature.ts`, `rootOf` and its two uses.

## Requested change
Add to `CraftSnapshot`:

```ts
/** v2: the craft this one separated from; null for a craft that was launched. A piece of debris is a craft of its own. */
parent?: string | null;
```

The world fills it in `craftSnapshots` (`src/sim/vessel/facade.ts`: `parent: c.parent`), one line, when
the field exists. Until then the parent of a craft is its id up to the last `.` (the launched craft: up to
the first), which holds because issued craft ids and instance ids contain no `.`.
