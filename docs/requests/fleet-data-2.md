Status: open
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
