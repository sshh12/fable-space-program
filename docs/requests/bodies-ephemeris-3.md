Status: resolved (lead: `BodyTerrainDef.residentLevel?: number` in src/core/contracts/defs.ts)
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

## Resolution (2026-11-12, lead)
Added, additively: `BodyTerrainDef.residentLevel?: number` (`src/core/contracts/defs.ts`).

- Meaning: a per-body CAP on the coarse levels of the height pyramid that stay resident while the body is
  resident. The provider keeps levels 0 .. min(`TileManifest.residentHeightLevel`, `residentLevel`).
- Default: absent = no cap, the manifest's level as today. Every existing terrain section stays valid and
  Earth and the Moon are unchanged (their sections do not carry it).
- The rule for the generator: write `"residentLevel": 3` in the terrain section of every new solid body
  (levels 0-3 are at most 510 tiles per layer, the size of Earth's resident pyramid; a body whose pyramid is
  shallower is resident whole, since the manifest's level is then the smaller number).
- The manifest stays the promise of what exists: `planet-bake` still writes `residentHeightLevel` per body.
- Who honours it: the provider, from the lazy-residency change of `solar-system-sim` (wave 4.1c,
  `src/terrain/body.ts`: `min(manifest.residentHeightLevel, terrain.residentLevel ?? Infinity)` beside the
  existing provider option). Until then only the manifest's level applies, which is the same or deeper, so
  nothing depends on the order.

