Status: resolved
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

## Resolution (sim-core-v2)

The rule is a declaration in the loader, not a guess from the content: `TABLE_FILES` in
`src/core/defs/loader.ts` lists the data tables that live beside the definitions of a directory, by path
under a defs root. It holds one entry, `bodies/radii.json`. A listed file is never read as a definition,
in the first root or in an overlay, whatever it contains; a file of a definition directory that is neither
a definition nor listed still fails by name ("definition must be an object with a string id"), so a second
table under another name is not swallowed silently: it is added to the list.

- Where the table may live: `bodies/radii.json` of any defs root, so `data/staged/bodies/radii.json` now and
  `data/defs/bodies/radii.json` after the activation moves it. Nothing of the staged layout changes.
- The overlay is `overlayDefSource(base, overlay, dirs = ['bodies'])` (same file): under `bodies/` the
  second root replaces or adds; every other file of it is a `$ref` target only (read when the first root
  has no file at that path, never listed), so `../terrain/<id>.terrain.json` resolves in the staged root
  and `../render/<id>.surface.json` in the first. `tools/sim/realWorld.ts` has `loadLibraryOver()` for
  Node (default second root: `data/staged`).
- Tests (`src/core/defs/loader.test.ts`, "a second root laid over the first"): replace and add; other
  files not listed; a `$ref` that leaves the roots or dangles fails by file; the declared table is not a
  body in either root; the same table under an undeclared name fails by name; and the staged library of
  this repository loads over `data/defs` with every staged body file in it and the sites, vehicles and
  sections of the first root unchanged (measured on this tree: it loads).
