Status: open
From: platform-delivery
Owner path: tests/unit/sim-world, tests/unit/sim-vessel/trajectory-fixtures, tests/unit/terrain-render/selection.test.ts, tests/unit/sky/skyData.test.ts, tests/unit/site-bake/pads.test.ts (their owners; the lead for the assignment)
Blocking: no (CI excludes the ten files meanwhile; the exclusion is visible in .github/workflows/ci.yml)

## Problem

CI (GitHub Actions, `.github/workflows/ci.yml`, ARCHITECTURE 16.2) has no baked data: `data/tiles` and
`data/sky` are not in the repository. Ten unit test files read that data and fail instead of skipping when it
is absent, so the unit suite cannot be green on CI. `tests/unit/terrain-core/realData.test.ts` shows the
pattern that works (`describe.skipIf(!HAS_EARTH)`).

## Evidence

Run 43194854038 on branch `platform-delivery-ci` (commit f1d671e), step "Unit suites (synthetic terrain)":
10 failed, 118 passed, 4 skipped files. Errors: `baked tiles are missing: .../data/tiles/earth/manifest.json
(run the earth bake; ...)` and `ENOENT ... data/sky/manifest.json`. The files:

- tests/unit/site-bake/pads.test.ts
- tests/unit/sim-world/commands.test.ts, protocol.test.ts, surface.test.ts, milestones.test.ts,
  browserLoop.test.ts, scenario.test.ts
- tests/unit/sim-vessel/trajectory-fixtures/trajectory-fixtures.test.ts
- tests/unit/terrain-render/selection.test.ts
- tests/unit/sky/skyData.test.ts

## Requested change

Each of these files (or the describe blocks that need baked data) skips with a note when the data it needs is
absent (`describe.skipIf(!fs.existsSync(<manifest>))`), exactly as realData.test.ts does; nothing changes on a
machine that has the data. When a file is fixed, its `--exclude` line in `.github/workflows/ci.yml` is removed
(platform-delivery owns that file; the lead may remove the line in the same commit).

## Status per file

- tests/unit/site-bake/pads.test.ts (site-bake, 2026-11-12): fixed. What needs only tracked files (the pads files'
  own consistency: classes, spacing, the gates as recorded, land cover, corridors from the recorded numbers, LC-1
  pinned when Ka Lae is resolved) runs everywhere; the block that reads the baked tiles (the live tile-set hash and
  the TerrainProvider re-measurement of heights and slopes) is `describe.skipIf(!HAS_EARTH)` with
  `HAS_EARTH = existsSync(data/tiles/earth/manifest.json)`, as realData.test.ts does. Its `--exclude` line in
  `.github/workflows/ci.yml` can be removed.
