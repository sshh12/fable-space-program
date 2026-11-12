# lead-baseline-v2: hand-off (running log until the step is finished)

The lead's step before wave 3 of `docs/WORK_PACKAGES_V2.json` (MIGRATION_V2 step 3.0), with the lead's
amendments of 2026-11-11: other agents were working in the tree, the reference images are deferred to the
visually signed-off tree, the document swap comes last.

## Running log

- 2026-11-11 22:10 start. Tree at 6961d22 plus other agents' uncommitted work (vfx, atmosphere, flight-ui,
  app tests). Baseline suites run through the gate on that tree (section "Baselines").
- 22:16 machine crash (third; GPU driver, two WebGPU browser runs). Resumed at 22:24: nothing of this step
  was lost (no repo file had been written yet); the gate's GPU class is now one slot (commit 23fdeb7).
- 22:30 frame-clock probe written (`tests/browser/shell/frame-clock.perf.spec.ts`) for request
  app-integration-8 and queued on the GPU slot.

## Baselines (unmodified tree, 2026-11-11 22:10-22:20, through the gate)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `node tools/dev/heavy.mjs --class=cpu -- npm run typecheck` | passes (exit 0) |
| Unit | `node tools/dev/heavy.mjs --class=cpu -- npx vitest run` | 104 files, 1109 tests: 1107 pass, **2 fail** (below); 61.9 s |
| Headless mission | `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission` | 5 files, 31 tests: 30 pass, **1 fail** (below); 65.3 s |

The three failures existed before this step and are not caused by it:

1. `tests/unit/flight-ui/displays.test.ts > formats apsides ...` expected `0.4 km`, got `360 m`: the
   flight-ui fixer's work in progress at that moment (committed since as 2bd0a88, "apsis in metres below
   1 km").
2. `tests/unit/terrain-core/realData.test.ts > launch-site pads are flat within 5 cm over flatRadius`:
   worst deviation 2.67 m. The site has had a pad shape since request terrain-render-6
   (`SitePadShapeDef`: exactly flat only inside the core and the slab areas, natural relief kept elsewhere
   inside `flatRadius`), and this test still asserts the whole disc. It is the shared-code maintainer's
   (terrain) to bring in line; it is listed here so wave 3 does not take it for a regression.
3. `tests/mission/full-mission.test.ts > determinism ...`: the flight itself passes every gate; the test
   stops at its tile-set check because `data/tiles/moon/manifest.json` has `contentHash 597c5d666b132450`
   and `tests/mission/golden.json` was recorded on `d250015b4e1a23f8`. Cause: the Moon's **albedo** layer
   was re-baked on 2026-11-11 15:14 (request sky-lighting-6, NOTICE-core-3); 131,072 albedo tiles and
   `globals/albedo-lowres.png` are newer than the golden, no height tile is. See "Mission baseline" for
   how the state hash was established.
