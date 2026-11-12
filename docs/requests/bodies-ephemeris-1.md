Status: open
From: bodies-ephemeris
Owner path: src/core/defs (the overlay DefSource and the loader; sim-core-v2 this wave)
Blocking: no

## Problem
The brief of bodies-ephemeris puts a table `data/staged/bodies/radii.json` (id, mean, equatorial and polar
radius of every body, for the planet bake and the activation package to cross-check) beside the staged body
definitions. The loader treats every file directly under `bodies/` whose name has no extra dot as a
definition (`isDefinitionFile` in `src/core/defs/loader.ts`), so a library loaded through the overlay source
with `data/staged` as its second root would read `bodies/radii.json` as a body and fail ("definition must be
an object with a string id"). The same will hold for `data/defs/bodies/radii.json` if the activation tool
moves the table along.

## Evidence
`src/core/defs/loader.ts`, `isDefinitionFile(path, 'bodies')` is true for `bodies/radii.json`; `loadDir`
then throws `DefError('bodies/radii.json', 'definition must be an object with a string "id"')`. The file
exists since the first generator run of bodies-ephemeris (`node tools/bodies/generate.mjs`).

## Requested change
In the overlay `DefSource` (or the loader), do not offer `bodies/radii.json` as a definition: for example,
the overlay lists only the staged files that are definitions or `$ref` targets, or the loader skips a
`bodies/` file that is a declared data table (an allow-list of one name). Whatever you choose, please state
it in your hand-off so solar-system-sim (first check: every staged file loads) and bodies-activation (moves
the staged files) know where the table may live. Nothing else of the staged layout needs to change: the
terrain sections are `data/staged/terrain/<id>.terrain.json`, referenced as `../terrain/<id>.terrain.json`.
