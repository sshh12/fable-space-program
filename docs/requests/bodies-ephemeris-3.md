Status: open
From: bodies-ephemeris
Owner path: src/core/contracts/defs.ts (BodyTerrainDef; the lead)
Blocking: no

## Problem
The brief of bodies-ephemeris asks the generated terrain section of every new solid body to carry "tile set
id = body id, resident level, amplification model key ... with parameters from the body's data". The
contract's `BodyTerrainDef` has `tileset`, `maxElevation`, `minElevation`, `maxRenderLevel`, `modifiers`,
`surfaceFriction`, `amplification` and no resident level; the resident level today is
`TileManifest.residentHeightLevel`, written by the bake into `data/tiles/<id>/manifest.json` (ARCHITECTURE
10.2: "A coarse level (manifest.residentHeightLevel) is always resident"), and `createTerrainProvider`
takes it from there (optionally lowered by `residentLevel` in the provider options).

## Evidence
`src/core/contracts/defs.ts` `BodyTerrainDef` (no such field); `src/terrain/body.ts:94`
`this.residentLevel = Math.min(this.g, residentLevelOverride ?? manifest.residentHeightLevel)`. A terrain
section with an extra `residentLevel` member would not satisfy the typed fixture
(`tests/unit/bodies/stagedBodies.generated.ts`, `satisfies Record<string, BodyTerrainDef>`).

## Requested change
Either confirm that the resident level stays a property of the baked manifest (then the generated sections
are complete as they are, and planet-bake writes `residentHeightLevel` per body), or add an optional
`residentLevel?: number` to `BodyTerrainDef` with its meaning (a per-body cap on the manifest's level, for
the lazy residency of solar-system-sim) and the generator will write it (rule to be stated by you, e.g. the
manifest's level, or the level whose tile edge is closest to N km). Until then the sections carry no
resident level; the hand-off says so.
