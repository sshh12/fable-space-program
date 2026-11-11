Status: open
From: sim-world-pilot
Owner path: src/core/contracts/defs.ts (ScenarioDef), src/core/defs/loader.ts (validateLibrary)
Blocking: no        (the mission acceptance run starts from the pad with full tanks; this is about the QA / lab starts)

## Problem
`ScenarioDef` cannot say how much of each resource the start vessel holds. A scenario that starts
mid-mission (`stagesAlreadyFired > 0`, start kinds 'state' / 'orbit' / 'landed') therefore gets every
remaining stage with FULL tanks, a full ablator and full RCS propellant, which is not the vehicle of that
point of the mission. The eight `qa-*` scenarios are captured from the nominal flight and are meant to show
the real mission state to the visual-QA and lab packages.

## Evidence
`qa-lunar-surface` loads at 56,800 kg (descent stage 36,000 kg of propellant, ascent stage 10,800 kg); the
nominal flight lands at 25,716 kg with 5,040 kg of descent propellant. At the QA mass three of four legs
break at a 2.50 m/s contact (the mission gate is < 2.5 m/s with the legs intact; at mission mass they hold up
to 3.5 m/s). `qa-trans-earth` carries 10,768 kg in the ascent stage against 1,128 kg in the mission;
`qa-entry` and `qa-drogues` start with a full ablator (the mission's entry has used 42 % of it by the
drogues). `VehiclePartPlacement.resources` exists but belongs to the vehicle, and a second vehicle id per
QA start would break everything keyed on `vehicleId`.

## Requested change
One optional field on `ScenarioDef`, mirroring `VehiclePartPlacement.resources`:

```ts
  /**
   * Resource amounts at the start, kg: part instance id (VehicleDef.parts[].id) -> resource id -> kg.
   * Overrides the vehicle's own amounts (VehiclePartPlacement.resources, default full) for the parts and
   * resources listed; everything not listed keeps the vehicle's amount. Entries for parts that
   * `stagesAlreadyFired` has already dropped are ignored.
   */
  resources?: Record<string, Record<ResourceId, number>>;
```

and in `validateLibrary` (scenario loop), when the field is present: it is an object; every key is a part
instance id of the scenario's vehicle; every resource id is one that part's definition holds
(`PartDef.resources`); every amount is a finite number with `0 <= kg <= capacity` (a small tolerance on
the upper bound, 1e-6 x capacity, for amounts captured from a flight). A `DefError` naming the scenario file
otherwise.

Must NOT change: scenario files without the field load and behave exactly as before; `lunar-direct` does not
get the field (pad start, full tanks). Nothing else in the contracts is touched. FakeSim may ignore the
field.

What sim-world-pilot does with it (own paths, as soon as the field exists): `createSim` applies the
amounts to the start vessel before it is placed (mass properties, the heat shield's `ablatorFraction`),
`tools/sim/captureScenarios.ts` records them from the nominal flight into the eight `qa-*` files, and
`tests/unit/sim-world/scenario.test.ts` asserts the start masses against the mission's milestone records.
Until then the QA scenarios keep full tanks (stated in docs/handoff/sim-world-pilot.md).
