Status: resolved (lead: 537da5f, f134f8d; sim-core-v2: its review fixes; the tighten step after sub-wave 3.2 makes event part ids one form)
From: sim-core-v2
Owner path: src/core/contracts (the lead), docs/ARCHITECTURE.md 9.3
Blocking: no

## Problem
Four places where the contracts and the simulation meet and the contract does not yet say which way it
goes. The simulation behaves as described under "Evidence" today; each item is a decision for the tighten
step, not a defect of a flight.

## Evidence

1. **`partId` of events in a vessel of several craft.** `SimEvent.partId` (`engineIgnition`, `decoupled`,
   `partDestroyed`, `touchdown`, ...) is documented as an instance id. Instance ids are unique per craft
   only, so in an assembly two craft of one vehicle have the same ones. The simulation therefore sends the
   instance id for a vessel of one craft (what v1 consumers match against) and the part key
   `craftId/instanceId` for a vessel of several (`eventPartId` in `src/sim/vessel/ids.ts`). The `undocked`
   event always carries part keys. A consumer has to accept both forms until the contract picks one.
2. **The cockpit of a command part.** `CraftSnapshot.commandPart` names the part; the interior layout id
   and the seat are on `PartDef` (`command.cockpit`) and on `VehicleDef.cockpit` / `cameras.cockpit`. The
   data has only the vehicle-level form today (`kestrel-capsule.json` has no `command.cockpit`), so a
   consumer that follows the contract's "what consumers read is the command part" finds nothing and has to
   fall back to the vehicle. The simulation copies nothing between the two.
3. **Pad classes have no limits.** `PadDef.maxLiftoffMass` and `maxDiameter` are required; ARCHITECTURE 9.3
   names the three classes and says "mass and diameter limits" without numbers. `data/defs/sites/ka-lae.json`
   states for LC-1 what the only vehicle that exists needs: 3,000,000 kg (the lunar stack lifts off at about
   2,760 t) and 9.5 m (the stack is 9.0 m; its launch mount opens 9.56 m). A site that states the
   deprecated single pad only has no limits (`Infinity`, in memory only).
4. **The staging and local rules.** The contract says `staging` = lifetimes of minutes and `local` =
   offline play and tests, without numbers. `tools/sim/writeRules.ts` derives `staging` from the default by
   one rule (every timer on the wall clock in `UNIVERSE_RULE_TIMERS` at a day per minute, none under one
   minute: craft 14 min, unowned 2 min, debris and wrecks 1 min, arcs 1 min, accounts 90 min, pressure
   floors 1 and 3 min) and writes `local` as the default under its own id.

## Requested change
1. At the tighten step make event part ids part keys always (or add `craftId` beside `partId`), and say so
   in `SimEvent`; the simulation changes one function.
2. Either fleet-data writes `command.cockpit` onto the command parts (then the vehicle-level fields can go),
   or the contract says that the vehicle-level fields stay the source. If the snapshot should carry the
   resolved cockpit id per craft, add it to `CraftSnapshot` and the world fills it.
3. State the limits of the three pad classes in ARCHITECTURE 9.3 (fleet-data knows the fleet's masses and
   diameters); site-bake and this package's site file take them from there.
4. Confirm or replace the two derived documents; `universe-directory` owns the files from wave 4. The
   loader holds every rules document to the fields of `UniverseRules` (a field the contract gains makes
   the three files fail by the field's name until `npx tsx tools/sim/writeRules.ts` or their owner adds it).

## Answer (2026-11-12, lead; after the independent review of sim-core-v2)

1. **Event part ids.** Decided: part keys in ONE form, at the tighten step after sub-wave 3.2 (MIGRATION_V2,
   lead steps, "after 3.2"): `eventPartId` then returns `craftId/instanceId` for a vessel of one craft too.
   Until then the two forms stand and the contract says so (`SimEvent` in `src/core/contracts/sim.ts`): a
   string with a `/` is a key, because craft ids and instance ids may contain neither `/` nor `~` (stated in
   the header of `sim.ts`, on `CraftSnapshot.id`, `PartSnapshot.instanceId` and `VehiclePartPlacement.id`).
   No `craftId` beside `partId`.
2. **The cockpit of a command part.** The snapshot carries it per craft, resolved, and the world fills it:

   ```ts
   interface CraftCockpit {
     id: string | null;          // cockpit interior layout id; null = no cabin (sensor camera)
     cameraSeat: string | null;  // seat id of the command part the cockpit camera sits in
     sensorMount: { pos: Vec3Tuple; lookDir: Vec3Tuple; upDir: Vec3Tuple } | null;  // part frame; null = from the nose
   }
   interface CraftSnapshot { ...; cockpit?: CraftCockpit | null }   // null = no command part; absent = not produced yet
   ```

   These are the three fields of `CommandRuntime` (`cockpit`, `cameraSeat`, `sensorCamera`). The vehicle-level
   fields stay as the authoring conveniences the contract already describes (the assembler copies them
   onto the command part); nothing more is decided here about `command.cockpit` in the part files. A
   consumer reads the snapshot and never `defs.vehicles`. Required from the tighten step.
3. **Pad class limits** are rules data: `UniverseRules.pads.classLimits: Record<PadClass, { maxLiftoffMass,
   maxDiameter }>`, with `PadDef.maxLiftoffMass` / `maxDiameter` as OPTIONAL overrides of the class. Your
   side: the loader accepts a pad without them, a stated value is a positive finite number, and the
   deprecated single pad gets no `Infinity` (it has the limits of its class). Defaults `DEFAULT_PAD_CLASS_LIMITS` (net.ts),
   PROVISIONAL and the lead's to set from `fleet-data`'s table: heavy 3,000,000 kg and 9.5 m (LC-1's numbers:
   8.7 % over the 2,760 t stack; 9.5 m is under the mount's own 9.56 m opening), medium 700,000 kg and 7 m,
   light 70,000 kg and 2.5 m. ARCHITECTURE 9.3 states them. **The field is optional and the defaults are a
   constant beside `DEFAULT_UNIVERSE_RULES` for now**, because `validateRules` holds every file to exactly
   the fields of that document: a field added there would fail the library load until the three files state
   it. A reader takes `rules.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS`. When the loader reads rules
   files as overrides (item 4) the lead moves the constant into the default document and makes the field
   required.
4. **The rules files** are stored as OVERRIDES of the default document: a file states its id, its version
   and the fields in which it differs; the loader holds the complete document (the default with the file's
   values over it) and still refuses a field that is not one of `UniverseRules`. A field the contract gains
   then needs no change to a file. `default.json` may state everything, a part or only its id;
   `src/core/contracts/net.test.ts` holds whatever it states equal to the contract's default. The NUMBERS of
   `staging` (a day per minute, nothing under a minute) and `local` (the default) stand as derived and are
   not confirmed beyond that: `universe-directory` owns the files from wave 4.

Also decided with this review and recorded in ARCHITECTURE (3, 5.2, 7.2, 7.5) and MIGRATION_V2 (lead
steps, "during sub-wave 3.1"): tick-pure state (no clock base) and craft identity (universe-unique craft
ids; a departing piece is a new craft with lineage).

## Carried out (sim-core-v2, after the answer above)

1. Event part ids: both forms stay until the tighten step. `findPartByKey` accepts part keys only; vehicle
   ids, part instance ids and issued craft ids may contain none of `/`, `~` and `.` (the loader, the seeded
   source, the assembler). `.` is this package's addition: it separates the lineage in the id of a craft
   that left another as a piece (`<parent craft id>.<root part instance id>`).
2. Cockpit: `CraftSnapshot.cockpit` is filled from the command part's `CommandRuntime`; null for a craft
   without a command part.
3. Pad limits: `padLimitsOf(pad, rules?)` of `src/core/defs/sites.ts` (class limits of the rules document,
   else `DEFAULT_PAD_CLASS_LIMITS`, with the pad's own values over them); the loader accepts a pad without
   limits and a rules file that states `pads.classLimits`; no `Infinity`; LC-1's numbers are marked
   provisional in `data/defs/sites/ka-lae.json`.
4. Rules files are overrides, completed by `completeRules` in the loader, so the lead can move the class
   limits into the default document without touching a file. The numbers of `staging` and `local` are the
   ones the review's decision D3 (iv) asked for, relayed with the review: staging scales the sweep interval
   as well and holds every lifetime to at least two sweeps; local keeps the time and physics rules and
   sets every wall-clock retention to `Number.MAX_SAFE_INTEGER` seconds. They are still data for
   `universe-directory` to own. `tools/sim/writeRules.ts` derives the three files.

Details and measurements: docs/handoff/sim-core-v2.md, "After the review".

## Closed (2026-11-12, lead)

With the override loader in (6a08c06) the class limits moved into the default document:
`UniverseRules.pads.classLimits` is required and `DEFAULT_UNIVERSE_RULES` states it (f134f8d).
`DEFAULT_PAD_CLASS_LIMITS` stays as the name of the same values for `padLimitsOf(pad)` without a rules
document. A file that states `pads.classLimits` is read as before: whole, every class, positive (the
loader asks its table of fields with a check of their own before the default's shape; its tests pass
unchanged). The numbers of `staging` and `local` are as this package derived them; `universe-directory`
owns the files from wave 4. What is left is the tighten step's (event part ids in one form).
