Status: resolved (notice, nothing to answer)
From: sim-core-v2
Owner path: data/defs/visuals/sites and src/render/vehicle (vehicle-pad), tests/browser/integration (app-integration), labs and tests of every presentation package
Blocking: no

## Problem
The launch site was renamed (MIGRATION_V2 step 3.6): site id `ka-lae-lc1` is now **`ka-lae`**, and its one
pad is **`lc-1`** (`LaunchSiteDef.pads[0]`, `ScenarioDef.pad`). Commits a2c6318 (the package's own paths)
and 10057fe (the one mechanical commit outside them).

## Evidence
- Site files: `data/defs/sites/ka-lae.json`, `ka-lae.location.json`, `ka-lae.structures.json` (moved with
  `git mv`; location and structures byte-identical).
- Every scenario: `"site": "ka-lae", "pad": "lc-1"`. `data/defs/regions/earth-ka-lae.json`: `"site": "ka-lae"`.
- `tools/sim/start-time.json`: regenerated, the same start (938240818.8416667 s), `site.id` `ka-lae`,
  `site.pad` `lc-1`.

## Requested change
Nothing to do for a consumer that takes the site from the scenario (`defs.sites[scenario.site]`). What was
keyed by the old id and was changed for you:

| File (not this package's) | Change | Committed |
|---|---|---|
| `data/defs/visuals/sites/ka-lae-lc1.json` -> `data/defs/visuals/sites/ka-lae.json` | `git mv`, content byte-identical (the section is found by `visuals/sites/<site id>`) | yes, 10057fe |
| `tests/browser/integration/shadows.spec.ts` | reads `data/defs/sites/ka-lae.location.json` | yes, 10057fe |
| `tests/browser/integration/terrain.spec.ts` | the same | yes, 10057fe |
| `tests/browser/integration/water.spec.ts` | the same | yes, 10057fe |

**Files changed in the working copy and left uncommitted for their owners: none.** At the time of the
rename `git status --short` showed no uncommitted change on any file the two commits touch, so all of them
are committed. `tests/browser/vehicle/screens.spec.ts` and `staging.spec.ts` no longer name a site id
(their owner had already made them take it from the scenario).

What still names the old id on purpose: `tests/unit/terrain-core/terrain-guard.heights.json` (the guard's
group `site:ka-lae-lc1` is the name under which those directions were recorded; the guard samples stored
directions, and it is green), the `source` text inside the survey file, and the records under `docs/`.

Three things a reader of a site should know from now on:
- The deprecated `site.pad`, `site.padAzimuthDeg` and `site.structures` are still filled: the loader writes
  them from the first pad. The site file itself states `pads` only.
- `site.name` is now the site's ("Ka Lae Pacific Spaceport"); the pad's is `pads[0].name` ("Launch Complex
  1"). The surface target of the real session keeps the full name ("Ka Lae Pacific Spaceport, Launch Complex
  1": `padTitle` of `src/core/defs/sites.ts`), so `shortSiteName` still gives "Ka Lae LC-1". Code that
  builds its own target from `site.name` (`src/core/fakes/fakeSim.ts`, `src/map/testing/syntheticSnapshots.ts`)
  shows the shorter name.
- The ground survey of a site that has no section falls back to level ground without a word
  (`src/render/vehicle/site/survey.ts`): request sim-core-v2-2 asks for that to fail loudly.

Verified on the working tree after the rename: the unit suites of the simulation, the definitions, the
terrain (with the terrain guard), the vehicle, cockpit, vfx and map packages; the mission suite (36 of 36,
state hash unchanged, trajectory guard bit-identical). The vehicle game spec's site test ("the terrain
under every structure of a site is at the height the structure stands at") was NOT run by this package: its
one run waited 18 minutes for the single GPU slot and was withdrawn. Checked headless instead: site `ka-lae`
finds its survey section (`visuals/sites/ka-lae`, surveyed, 34 structures) and `tests/unit/vehicle` passes;
request sim-core-v2-2 has since been resolved by vehicle-pad (37d3ad2: a missing survey fails at load).
