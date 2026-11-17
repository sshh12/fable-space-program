Status: open
From: presentation-sweep
Owner path: src/render/terrain (sitePlan.ts, materials.ts, feature.ts, shaders/surface.ts): the terrain-render package
Blocking: no (one pad per body exists today; no pixel moves)

## Problem
The terrain draws the ground plan of a pad (hardstand, roads, the aprons under the structures) from the
`TerrainMaterial` uniform, which holds `MAX_SITES = 4` plans per body with `MAX_SITE_SHAPES = 24` shapes in
all (`src/render/terrain/sitePlan.ts:18`). Since the presentation sweep the terrain builds one plan PER PAD
(`feature.ts`, `createBody`: site by site, first pad first) and stops at the fourth: the fifth pad of a body
onwards is flattened by the height function and has its structures, its cover clearing and its flat disc, but
no ground plan under them: the structures of that pad stand on bare lava. The sites of the shared universe
have 16 pads (Earth) and 9 (Moon) (ARCHITECTURE 9; the fleet and pad packages of wave 4).

## Evidence
`src/render/terrain/feature.ts` (the loop over `padsOf(site)` with `if (pads.length >= MAX_SITES) break`);
`src/render/terrain/materials.ts:352` throws for more than `MAX_SITES` plans, so the loop must stop there.
Today's library has one pad on Earth (`data/defs/sites/ka-lae.json`), so nothing is missing in any picture,
and the reference images do not move. The limit is recorded in docs/handoff/presentation-sweep.md (D10).

## Requested change
Ground plans for every pad of a body: at least 16 on one body. The layout of the material uniform is the
terrain's to choose (a storage buffer of plans with a per-body count, or plans selected per frame by
distance to the camera: a plan matters only within about a kilometre of its pad, so the nearest four of 16
would do with the uniform as it is, at the price of a re-pack when the nearest set changes). What must NOT
change: the plan of the first pad of a site and every picture of today's single pad (the pad checkpoints of
tests/browser/baselines.manifest.json are exact), the pad's own frame (`padLocationOf`), `buildSitePlan(pad,
tunables)` as the one place a plan is derived from a pad's structures.
