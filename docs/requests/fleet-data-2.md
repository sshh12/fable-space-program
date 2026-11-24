Status: resolved (presentation-sweep; the commit that adds this section)
From: fleet-data
Owner path: src/render/vehicle/vesselFeature.ts, tests/unit/vehicle/parts.test.ts, tests/unit/vehicle/mounts.test.ts (capability-settings this wave; fleet-models-pads from wave 5.1)
Blocking: yes (for every browser page that starts the vessel feature: it reports errors)

## Problem
fleet-data's brief ships the fleet's new parts WITHOUT visuals ("New parts have NO visuals until wave 5 (the
vessel feature reports an error for a part without one) ... the menu and the bench use meridian-lunar in wave 4").
Since commit 7ebd5ee the library holds 33 such parts in 7 new vehicles. The vessel feature's `init` builds the
models of EVERY part of EVERY vehicle of the library (vesselFeature.ts line 480,
`for (const vehicle of Object.values(defs.vehicles)) for (const p of vehicle.parts) visualOf(p.def)`), so every
page that starts the feature reports one error per part without a visual through `reportError`
(`window.__test.errors` and `console.error`), whether or not one of those vehicles is ever drawn. Browser specs
that end in `expectNoErrors`, and the reference-image runs, see them.

Two unit tests of tests/unit/vehicle hold every part or vehicle of the library to what only the lunar stack has:
- parts.test.ts "every part definition has a visual file and a registered generator" and the ten tests after it
  (11 fail: they build every part's model);
- mounts.test.ts "are the parents of the vehicle tree, for every vehicle of the library": its last two lines
  require every vehicle to carry engines both on attach nodes and without nodes (motor packs); the Azimuth,
  Solstice and Albatross stacks have no motor pack.

## Evidence
`npx vitest run tests/unit/vehicle` (11 + 1 failures since 7ebd5ee); the line of vesselFeature.ts above;
`grep -n "visual" data/defs/parts/wren-1.json` -> `"visual": null` (the contract's "null until authored").

## Requested change
1. Vessel feature: pre-build at `init` only the vehicles whose parts all have a visual, and keep the report for a
   part without a visual where a vessel of it is actually drawn (line 284 already reports it there, once per part).
   Nothing changes for the lunar stack: its parts all have visuals.
2. parts.test.ts: hold the parts THAT HAVE a visual (`def.visual !== null`) to the model checks, and list the parts
   without one as the fleet's known gap until fleet-models-pads (or assert exactly that list).
3. mounts.test.ts: keep "both kinds of engine" for the vehicles that have both; the comparison of mounts with the
   tree for every vehicle stays as it is (it passes for the new vehicles).
Must NOT change: anything of the lunar stack's look.

fleet-data has not invented stand-in visuals for the new parts (the brief forbids it).

## Resolution (presentation-sweep, 2026-11-24; lead decision)
A vehicle is PRESENTABLE when every one of its parts has a visual definition. This is derived from the
definitions in one place, `src/core/access/presentable.ts` (docs/RENDER_API.md section 21):

- `isPresentableVehicle(defs, vehicleId)`: the rule;
- `presentableVehicleIds(defs)`: **the member the menu uses** (shell-menu offers these vehicles only);
- `firstPresentableVehicleId(defs)`: for a lab or a test that took "the first vehicle of the library";
- `presentableVehicles(defs)`, `presentableLibrary(defs)` (the library with the presentable vehicles and their
  scenarios: what a bench or a lab hands its renderer instead of filtering by hand), `isPresentableVessel(defs,
  vessel)`, `partHasVisual`, `partsWithoutVisual`.

What changed:

1. The vessel feature builds at `init` the models of the presentable vehicles only. Nothing is built, logged or
   thrown for the others.
2. A vessel of a snapshot one of whose parts has no visual is not drawn at all, and the feature names its
   vehicle ONCE in `VesselVisualFeature.status()` (`{ notPresentable: { vehicleId, parts }[] }`;
   `stats.notShown` counts the vessels passed over). This is DIFFERENT from what the request asked for (an
   error report once per part where a vessel is drawn): the lead decided that a data-only scenario in a lab
   must not fill the page with errors, so there is no `reportError` and no console line at all.
3. The effects draw nothing of such a vessel (plume, plasma, trail, canopy, effects at its events), and the
   cockpit feature does not draw its cabin.
4. The app's default scenario (`defaultScenario` of src/app/settings.ts: a page opened without `?scenario=`)
   is the first mission scenario in id order whose vehicle is presentable. Since fleet-data's scenarios it had
   become `fleet-azimuth-pathfinder`; it is `lunar-direct` again, by the rule and not by name.
5. Checked and left as they are: `loadVfxData` and `checkPartSounds` hold every engine definition to a plume
   look and a sound profile (all 58 parts of the library have theirs); the engine voices follow the simulation;
   the site feature builds an empty runtime for a pad without structures (the 24 new pads); the cockpit feature
   builds one model per cabin layout, not per vehicle; the HUD reads the craft of the snapshot, not the table
   of vehicles.

The unit tests of this request:

- `tests/unit/vehicle/parts.test.ts` holds the parts that have a visual and the presentable vehicles to the
  model checks (`partHasVisual`, `presentableVehicles`); its first test requires `meridian-lunar` to be
  presentable and prints the parts without a visual (the known gap is not pinned by name: it shrinks as
  fleet-models-pads delivers).
- `tests/unit/vehicle/mounts.test.ts` compares the mounts with the tree for every vehicle as before, and
  requires "both kinds of engine" of the lunar stack only.

Proof: `tests/unit/fakes/presentable.test.ts`, `tests/unit/vfx/director.test.ts`,
`tests/browser/integration/presentable.spec.ts`; the lunar stack's picture is unchanged (reference checkpoints
at 0 pixels under look 1).
