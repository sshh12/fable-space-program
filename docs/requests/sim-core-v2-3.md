Status: open
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
