# Hand-off: terrain-core

The single height authority of the engine (`src/terrain`): tile sources, a deterministic decoded-tile cache,
the coverage-blended data height, procedural amplification (Earth land cover, lunar regolith with craters and
rocks), launch-pad flattening, the lazy collision surface, rocks, and the tile baker for the renderer's
workers. Headless, deterministic, worker-safe; `npx vitest run tools/dev/boundaries.test.ts` is green.

Status at hand-off (after the review round and the 2026-11-10 crash recovery): all 85 tests pass (12 files), including the
real-data suites on the baked Moon and Earth tile sets (with the bakes' new `sourceCoverage` and Earth
`landcover` layers). **Not met: the tile-bake budget of 12 ms at render levels 13 and deeper** (section 5:
on a quiet machine 6.4-9.0 ms at levels 6-10, 13.3-19.3 ms at 13-20; the reviewed version took 31-76 ms under
load). The texture change at coverage margins is fixed: the effective level now keys on the manifest's
`sourceCoverage` (section 1, request terrain-core-1), measured texture in every margin 0.99-1.05 of the parent
level's. Where a level's source is coarser than its posting (Moon level 9 SLDEM, Earth's regional sea floor)
the surface inside the source area is smoother than outside: a data-description issue, request terrain-core-4.

## 1. Public API

Import from `src/terrain` (index.ts). The Node-only tile source is imported by path:
`import { createFsTileSource } from '<repo>/src/terrain/fsTileSource'` (never from browser code).

```ts
createTerrainProvider(defs: DefLibrary, tileSource: TileSource, opts?: TerrainProviderOptions): Promise<TerrainAuthority>

interface TerrainProviderOptions {
  cacheBytes?: number;            // decoded-tile cache budget (resident pyramid + pins + LRU), default 384 MiB
  collisionCacheTiles?: number;   // collision memo capacity in max-level tiles (21 KB each), default 1024
  bodies?: readonly string[];     // default: every body with a terrain definition
  residentLevel?: number;         // pyramid levels 0..n loaded at creation and pinned forever; default manifest.residentHeightLevel
}

type TerrainAuthority = TerrainProvider & RockField & TerrainBaker & {
  diagnostics(): TerrainDiagnostics;
  cachedTiles(): string[];                // sorted "tileset/layer/face/level/x/y" ('*' = in flight): determinism checks
  heightParts(bodyId: string, dir: Vec3, lambdaMin: number): HeightParts;  // { data, amplification, height, complete }
  readonly bodyIds: readonly string[];
};

interface TerrainDiagnostics {
  vertexEvaluations: Record<string, number>;   // collision vertices evaluated so far
  collisionTiles: Record<string, number>;      // collision memo tiles held
  collisionMemoBytes: Record<string, number>;  // memo slab bytes (0 until ensureLoaded / prewarmCollision / a query)
  prewarmWork: Record<string, number>;         // prewarm bookkeeping units (vertex slots scanned or sorted, tiles visited)
  prewarm: Record<string, { radius: number; clamped: boolean } | null>;  // current prewarm job
  seamWrites: Record<string, number>;          // shared height samples rewritten by seam reconciliation
  cache: { tiles; resident; pending; bytes; budget };
}

interface TerrainBaker {
  prepareTile(bodyId: string, key: TileKey, slot?: string): Promise<void>;   // pins under `slot` (default "bake"), replacing that slot's pin
  bakeGeometry(bodyId: string, key: TileKey): GeometryBake;                  // { heights: Float32Array(65*65), hMin, hMax, complete }
  bakeNormalMaterial(bodyId: string, key: TileKey): NormalMaterialBake;      // { rgba: Uint8Array(256*256*4), slopeScale, complete }
  bakeTile(bodyId: string, key: TileKey): { geometry: GeometryBake; normalMaterial: NormalMaterialBake };  // both; bit-identical to the two calls
  tileBounds(bodyId: string, key: TileKey): { hMin: number; hMax: number };  // conservative, from resident data, without baking
}

createFetchTileSource(baseUrl: string): TileSource      // "/tiles": {baseUrl}/{tileset}/manifest.json, .../{layer}/{face}/{level}/{x}/{y}.{ext}?v={contentHash}
createFsTileSource(rootDir: string): TileSource         // node only (src/terrain/fsTileSource.ts), rootDir = <repo>/data/tiles;
                                                        // at most MAX_OPEN_READS (64) files open at once (FIFO queue; no EMFILE)
```

Also exported: `GEOMETRY_GRID` (65), `GEOMETRY_QUADS` (64), `GEOMETRY_BAND_DIVISOR` (32), `NORMAL_BAND_DIVISOR`
(128), `NORMAL_MAP_SIZE` (256), `AO_GAIN`, `vertexFaceCoord(x, i, level)` (face coordinate of vertex i of tile
column x: the exact vertex positions the collision surface uses), `rockBump(rho2, r2, hR)`,
`golombekArea/golombekDensity/golombekQ`, `registerAmplificationModel(name, factory)`, `amplificationModelNames()`,
and the model plug-in types (`AmplificationModel`, `ModelContext`, `BodyServices`, `PointInfo`, `BandRasterJob`).

### Semantics the consumers rely on

- **TerrainProvider** exactly as `src/core/contracts/terrain.ts`. `heightAt(body, dir)` without lambdaMin is
  the collision surface: bilinear interpolation (in tile u, v) of the 65 x 65 vertices of the body's
  maxRenderLevel tile containing dir, vertices = H at band limit tileSize/32 (tileSize = mean tile size of the
  level, `(pi R / 2) / 2^level`, identical for every tile of a level so shared edges coincide). Vertices are
  memoised as Float32 (the baked mesh format); vertex positions are `faceStDir(face, vertexFaceCoord(x, i, L),
  vertexFaceCoord(y, j, L))`. A query evaluates at most the 4 vertices of its quad. The memo slab is allocated
  by `ensureLoaded` / `prewarmCollision` for the body (async context), so the first contact query does not pay
  for it (first query on a fresh provider after ensureLoaded: 205 us in the test suite with 6 vitest workers
  running in parallel; review probe: 0.09 ms for the first Earth query, was 5.9 ms).
- `heightAt(body, dir, lambdaMin)` is analytic. **Band limiting applies to the data term too** (my reading of
  "cost falls as lambdaMin grows"): data level L contributes with weight beta_L = smootherstep(L_lambda - L + 1),
  L_lambda = log2(lambda0 / lambdaMin), lambda0 = pi R / 256 (two texels of level 0), multiplied by the coverage
  weight w_L. Without a band limit every beta is 1 and the recursion is exactly COVERAGE_BLEND_TILES; with one,
  coarse queries and coarse render tiles never need fine tiles, the function is C2 in lambdaMin, and between
  consecutive render levels the data changes by one level's detail band. lambdaMin <= 0 = finest; NaN throws.
- **Modulators' data scale is capped at the query's band level**: the amplitude modulators (data slope,
  data height, land cover at the data scale) are read at level E_m = min(E, log2(lambda0 / lambdaMin)), and in a
  bake at min(E, render level). Every data-modulated component (noise octave, ripple, dune) is non-zero only
  where E < that level, where E_m = E, so H is unchanged; E itself (craters, octave placement) stays uncapped and
  manifest-only. Effect: a render tile reads data only up to its own level.
- **Collision = render**: at maxRenderLevel `bakeGeometry` returns exactly the collision vertices; measured max
  |heightAt - bake| 8.6e-11 m at vertices, 5.7e-11 m between them.
- `normalAt` = central differences of the collision surface over `baseline` along an orthonormal tangent pair.
  `surfaceKind` = 'water' where the body has an ocean and the collision height < sea level.
- `ensureLoaded(body, dir, radius, slot?)` loads every tile of every level 0..max of the height layer (and land
  cover when the model uses it) that the height function can read for ANY band limit within `radius` plus the
  layer's reach at that level (`BodyTerrain.heightReach / landcoverReach`): the data-scale slope probes
  (lambda0 2^-max(g, L-1) / 8: 41.6 m on the Moon and 76 m on Earth at the global levels), the seam neighbours
  (6 samples of the level), 4 m for the collision quad and normalAt baselines; land cover adds the rock-abundance
  lattice reach and a texel. Pins under `slot` (default "default"; a new call for the same slot replaces its
  pin) and resolves when resident. Rejects when the pinned sets plus the resident pyramid cannot fit `cacheBytes`.
  After it resolves, `residency().complete` is true and H does not change when more data is loaded (tested at
  every edge of a level-g tile with radius 0).
- `prepareTile(body, key, slot?)` loads levels 0..min(render level, max) of each layer over the tile widened by
  the bake's own extent (2 vertices) plus the layer's reach, converted with the tile's shortest edge and a 1.5
  safety factor (all land-cover levels when rocks reach the normal band). After it resolves, every bake of the
  tile is `complete` and does not change when more data is loaded (tested next to level-g borders and for render
  tiles coarser than their data).
- `prewarmCollision(body, dir, radius, maxVertices)`: a job is a disc (centre, radius); vertices are evaluated
  nearest first (distance buckets of a quarter quad, then index; tiles opened lazily in order of their nearest
  bucket) and the call returns the count of vertices of the job's disc not yet evaluated on final data (exact,
  maintained incrementally; recounted only for memo tiles changed by queries, eviction or new data). A caller
  that keeps its centre gets exactly its disc. A moving centre (the predicted touchdown point) gets a job with
  slack max(4 quads, 0.1 radius), reused while the requested disc stays inside it, so the returned count refers
  to a disc that contains the requested one. Opening a tile is charged against the budget (1 unit per 256
  vertices), so the work per call follows maxVertices (measured with the centre moving 5 cm per call: 453 work
  units per call at maxVertices 1, 1741 at 50, 5727 at 200). A radius whose tiles exceed half the memo is
  clamped to the largest disc that fits (`diagnostics().prewarm[body].clamped`), never throws.
- `residency()`: `residentLevel` = deepest resident height level at the point, `availableLevel` = deepest
  level the manifest has there, `effectiveLevel` = E (manifest only, see the next point), `complete` = every
  tile the full-detail function reads at the point is resident and final: each contributing level with its
  seam bands, the data-scale chain at the point and at its two slope probes, and land cover.
- **Effective level and `sourceCoverage`** (request terrain-core-1; the bakes write the field, the contract
  type does not have it yet, so it is read as an additive manifest field): when the height layer carries
  `sourceCoverage` (per sparse level, the rectangles where the data is genuinely finer than its parent; must lie
  inside `coverage`, else createTerrainProvider rejects), E keys on it:
  `E_L = E_(L-1) + s_L (L - E_(L-1))`, s_L = smootherstep(min(1, d / SOURCE_BLEND_TILES)), d = distance (tiles)
  to the nearest level-L tile NOT in the source rectangles, `SOURCE_BLEND_TILES` = 1 (`coverage.ts`; source
  rectangles are tile-granular, the real detail begins anywhere in the outermost tile: measured on the Moon,
  section 6). The data blend D keeps the contract's `coverage` weights exactly, so the parent identity on
  coverage boundaries and everything about D are unchanged. Consequences: in the margin the bakes add around
  their source data (parent-identical data) E stays at the parent level, so the parent's procedural detail
  continues there (it used to be switched off); `effectiveLevel` there is below `availableLevel` by design;
  regions of interest must lie at least one tile inside their source rectangles for E to reach the level (the
  landing target and the pad do). Without the field E is the contract's recursion on `coverage`.
- **Seams** (`seams.ts`): neighbouring height tiles share samples (edge row/column, 1-sample borders); the
  contract lets tiles use coarser power-of-two scales, and then the copies differ by up to half a coarse count.
  Every shared lattice position gets the value of its coarsest-scale storing tile (ties: lowest tile number),
  written into all storing tiles once they are resident together (same face, across cube edges and corners).
  The value is a pure function of the files, so results never depend on load order. A point whose bicubic
  stencil touches a band not yet reconciled is incomplete (like a missing tile) until the neighbours are resident.
- **Incomplete data**: a missing level is skipped (missing base -> deepest resident ancestor) and the query is
  flagged; collision vertices evaluated on incomplete data are provisional and recomputed after the body's
  resident data changes. After `ensureLoaded` resolves, results are bit-identical whatever loaded first.
- **Cache determinism**: use order is a call counter (each public call advances it; queries mark the tiles they
  read, also while in flight; fallback probes do not mark). Eviction decisions are taken synchronously in the
  call that needs room, counting in-flight tiles, so they depend only on the call sequence (tested with
  jittered I/O). The same holds in a worker.
- **RockField.rocksNear(body, dir, radius, minRadius)**: accepted rocks with radius >= minRadius whose centre is
  within `radius` m, deterministic and stable for overlapping queries. `radius` = horizontal radius D/2;
  `baseHeight` = H at the collision band limit without rock bumps; `variant` in [0, 6); `seed` = u32.
  Rocks with **D >= rockCollisionMinDiameterM (0.5 m, Moon and Earth)** are bumps in H: ellipsoidal cap
  `bump(rho) = hR sqrt(1 - (rho / (D/2))^2)`, hR = heightRatio * D/2, heightRatio in [0.35, 0.8] (Moon) /
  [0.35, 0.75] (Earth). The 16 cm (Moon) / 15 cm (Earth) collision grid carries those caps within 1.7 cm
  (measured over 344 isolated rocks; 0.3-0.5 m rocks would miss by up to 6.3 cm, hence the threshold). For the
  renderer: a collidable rock's cap height is `heightAt(body, rock.dir, tileSize(maxRenderLevel) / 32) -
  rock.baseHeight` (isolated rocks); rocks below 0.5 m are visual only (not in H, not in normal maps).
- **Normal/material map** (`bakeNormalMaterial`): 256 x 256 cell-registered (texel centre u = (i + 0.5)/256,
  row = v). r, g = `0.5 + 0.5 tanh(s / slopeScale)` of the directional derivatives of H (m/m) along the unit
  tangents tU = normalize(dP/du), tV = normalize(dP/dv). They are not orthogonal on the gnomonic face
  (tU . tV = -s t / sqrt((1 + s^2)(1 + t^2))); the exact gradient is
  g = ((sU - c sV) tU + (sV - c sU) tV) / (1 - c^2), c = tU . tV. b = AO = 1 - min(1, AO_GAIN * concavity)
  (two scales: 1 texel and 4 texels). a = material weight: Moon = crater freshness (fresh interiors and
  ejecta; also 1 on collidable rocks), Earth = rockiness (land-cover blend + slope above `steepRockSlope`).
  `slopeScale` = clamp(2 x RMS slope of the tile, 0.01, 8). Band limit tileSize/128. Encoded slopes match finite
  differences of H within 0.6-7.1 % RMS (tested < 8 %), also on both sides of a shared tile edge.
- **Worker use**: one provider per worker with `residentLevel: 2` (17 MB of pyramid per body instead of 68 MB)
  and a smaller `cacheBytes`; per job `await prepareTile(body, key)` then `bakeTile(body, key)` (or
  `bakeGeometry` then `bakeNormalMaterial` of the same tile: the second reuses the first's coarse grid while the
  body's resident data is unchanged). `complete` false means data was missing (prepare first). Everything is
  synchronous after `prepareTile`. Workers never touch the collision memo (no slab allocated).

## 2. How it works (where to look)

| File | Role |
|---|---|
| `tileSource.ts`, `fsTileSource.ts` | fetch / fs TileSource, manifest cache, never requests unpromised tiles (null), rejects on a promised-but-missing tile |
| `tileStore.ts` | byte-budgeted LRU (resident + in-flight), permanent pins, slot pins, call-order eviction, on-resident hook |
| `seams.ts` | canonical values of shared samples of neighbouring height tiles (8 bands per tile, reconciliation on load) |
| `coverage.ts` | `LayerCoverage`: layerHasTile, memoised 8-neighbour missing masks (cube-edge neighbours via dirToTile), w_L exactly as COVERAGE_BLEND_TILES; the same for `sourceCoverage` with SOURCE_BLEND_TILES |
| `bicubic.ts` | Catmull-Rom on the bordered 259 x 259 tile |
| `evaluator.ts` | point evaluation: level indices, coverage (memoised per tile), E, band-limited data chain, data scale (capped), land-cover chain, modulators, model, modifiers, seam checks |
| `body.ts` | per-body state, services for models, load sets for ensureLoaded / prepareTile with per-level reach |
| `collision.ts` | collision memo (slab, O(1) LRU, provisional vertices), prewarm jobs |
| `baker.ts` | coarse grid (shared by geometry and normal maps), normal/material maps, tileBounds |
| `noise.ts` | integer-hash gradient noise (corner hash = `hash4(iz, iy, ix, seed)`, WGSL-reproducible), measured statistics |
| `craters.ts`, `rocks.ts`, `shellCells.ts`, `smoothField.ts` | shell-in-cell hash grids (a point query visits 2 x 2 x 2 cells per class; typed record decoding for splats), crater profile, Golombek-Rapp rocks, lattice-interpolated rock abundance |
| `amplification/` | interface, registry (`none`, `lunar-regolith`, `earth-landcover`), shared helpers |
| `modifiers.ts` | flatten discs: body modifiers + one per LaunchSiteDef pad |

Key definitions:
- Effective level E (manifest only: `sourceCoverage` when present, else `coverage`; section 1) and the
  data-scale band limit lambda_s = lambda0 2^-E_m. Models get the data
  height and **data slope at lambda_s**; the slope is a forward difference of D over lambda_s/8 along a
  face-independent tangent pair (per-face bicubic derivatives are only approximately C1 across cube edges and
  made the multifractal amplitude jump by metres there).
- Every component (octave 2^j m, crater class D, rock 2D, ripple/dune wavelength) has weight
  smootherstep(log2(len / lambdaMin)) (C2, at most one octave changes between consecutive render levels) and an
  E weight (octaves below the data wavelength, craters below `craterMaxDiameterInPostings` postings, fading over
  one octave).
- Pads: H = mix(H_natural, elevation, w), w = 1 inside flatRadius, smoothstep to 0 at blendRadius (great-circle
  distance). 'terrain'/'sample' elevation = natural DATA height at the centre from final data, resolved in
  createTerrainProvider. Rocks are thinned by (1 - w).
- Bakes: a 69 x 69 coarse grid (4-texel spacing, full point evaluations at the geometry band and at tileSize/8)
  carries components of 32 texels and more (>= 8 samples per wavelength) and the data chain through level L-4;
  data levels L-3..L continue per texel (scanline Catmull-Rom); amplification components between 2 and 64 texels
  per texel (noise) or splatted per tile (craters, collidable rocks). Slope bytes come from an exact threshold
  table (no tanh per texel). The lunar rock splat bounds the rock abundance per tile from the source craters
  near it (same survivors as the per-cell lattice bound, checked bit for bit over 28 real tiles).

### Amplification parameters (`data/defs/terrain/*.amplification.json`, every key required)

**lunar-regolith** (calibrated against the real NAC DTM, section 4.1): regolith fBm `regolithSlope1m` 0.0186
(RMS slope of an octave at 1 m), `hurstMaria` 0.95 / `hurstHighlands` 0.65 blended by data roughness
(`hurstRoughnessRange`), `regolithInnerScaleM` 1 (fBm rolls off below 1 m: dust; craters and rocks carry the
sub-metre relief), multifractal factor `1 + (max-1)(1 - e^(-gain ramp(ratio-1)))` with `multifractalGain` 0.8,
`multifractalMax` 3; craters: `craterEquilibriumFraction` 0.0125 (of geometric saturation 1.54 D^-2 per m^2, D in
m), half-octave classes from `craterMinDiameterM` 0.6 to `craterMaxDiameterInPostings` 4 postings of E,
`freshDepthToDiameter` 0.196, `degradedDepthToDiameter` 0.02, `rimHeightToDiameter` 0.036,
`degradedRimFraction` 0.15, freshness = u^`craterFreshnessExponent` (5), ejecta to `craterEjectaExtentRadii`
2.5 radii (r^-3), rim rounding 0.08 (fresh) .. 0.9 (degraded) of (depth + rim); rocks: Golombek-Rapp k from
`rockAreaFractionMare` 0.02 to `rockAreaFractionFreshEjecta` 0.25 on fresh ejecta of craters >=
`rockSourceMinCraterDiameterM` 20 m (lattice `rockAbundanceGridM` 10 m), diameters 0.1-4 m, collidable >= 0.5 m.
Also the calibration record `calibrationTargetRmsSlope{2,4,8}m`, `calibrationLambdaM`.

**earth-landcover**: per LANDCOVER_CLASS `slope1m.*`, `ridged.*` (ridged 1 - 2|n| share: lava), `ripple.*`,
`dune.*`, `rockiness.*`, `rockK.*`; `hurstLand` 0.8, `hurstSeabed` 0.9, `seabedSlope1m`, `seabedDepthRampM`,
multifractal as on the Moon, `steepRockSlope` 0.6, aeolian ripples 0.12 m / 1 cm and dunes 30 m / 1.2 m aligned per
20 km wind cell, rocks 0.15-3 m, collidable >= 0.5 m. These are reasoned values, not calibrated (section 7).
The Earth tile set now has its `landcover` layer (levels 0-7 classifier, 8-12 WorldCover) and the model reads
it (without the layer every point would use the 'unknown' row). Measured on the real tiles within 25 km of the
pad (1,135 land points, class of the level-12 texel; RMS slope over 1 m of the amplification, band 0.25 m,
with land cover vs the same points as 'unknown'): bare rock (lava) 0.259 vs 0.166, sand 0.037 vs 0.075, built-up
0.148 vs 0.308, grass 0.167 vs 0.177, trees 0.199 vs 0.200 (on grass and trees the multifractal factor and
rock flanks dominate the 1 m slope).

## 3. How to run and verify

Everything except the typecheck is a heavy command: run it through the load gate (PACKAGE_RULES 13a),
`node tools/dev/heavy.mjs --class=cpu -- <command>`.

```
npm run typecheck:paths -- src/terrain tests/unit/terrain-core tools/terrain-core
npx vitest run src/terrain tests/unit/terrain-core tools/dev/boundaries.test.ts      (~50 s with real tiles, quiet machine)
TERRAIN_PERF=1 npx vitest run tests/unit/terrain-core/collision.test.ts               (asserts the 0.2 ms query budgets: quiet machine only)
npx tsx tools/terrain-core/bench.ts [--real]           timings vs budgets (fixture / data/tiles), prints the machine's CPU busy share
npx tsx tools/terrain-core/render-hillshade.ts         hillshades into out/terrain-core/*.png (rendered in 64-pixel blocks)
npx tsx tools/terrain-core/calibrate-regolith.ts [--write]   NAC calibration (needs data/tiles/moon)
npx tsx tools/terrain-core/measure-noise.ts            noise normalisation constants
```

Synthetic fixtures (`tools/terrain-core/fixtures.ts`, version 4): analytic heights encoded with tileCodec into
`%TEMP%/fable-terrain-core-fixtures-v4` (generated once). `fixture-moon`: global levels 0-2, sparse 3-5 in
region A (face 0) and 3-4 in region B straddling the face 0 / face 2 edge; regional levels add their own detail
and +10 m per level (max disagreement with the global level 40-60 m). `fixture-earth`: heights + land cover,
sparse 3-5 around the fixture pad. In both, a third of the height tiles use twice their level's preferred scale
(`fixtureScaleFactor`), so seams with mismatched quantisation exist at every level, across cube edges and at
corners. `sourceCoverage.test.ts` adds source rectangles to `fixture-moon` through a wrapping TileSource
(region A: source = coverage; region B, across the cube edge: a one-tile margin of parent-level data at levels
3-4). `realData.test.ts` runs automatically when `data/tiles/{moon,earth}/manifest.json` exists.

## 4. Measured against the acceptance criteria

| Criterion | Result |
|---|---|
| Tile sources, manifest caching, layerHasTile | met: tileSource.test.ts (incl. 4,000 concurrent reads with at most 64 files open; the unbounded fan-out failed with EMFILE once the Earth set gained land cover) |
| Cache: budget, slot pins, sync lookup, deterministic eviction | met: determinism.test.ts (identical cache contents after every call of a 12-call sequence under two different I/O jitter seeds; bytes <= budget always; oversize request refused; slot re-pin frees the old set) |
| ensureLoaded / prepareTile load what H and the bakers read | met: loading.test.ts (complete after `ensureLoaded(P, 0)` next to every edge of a level-g tile, H, collision and normals unchanged after loading 20 km more; bakes complete after prepareTile next to level-g borders and for render tiles coarser than their data, unchanged after loading more). Real data: the reviewer's probes now give complete = true and unchanged heights |
| Real benchmarks | Moon: Tranquility pixel mean -1923.9 m (ldem_64 -1925), Apollo 17 -2628.7 (-2624.5), Aitken -6953.5 (-6948), Tycho floor -1383.5 (-1295.5, see section 7), Tranquility point at full resolution -1927.4 m (<5 m); landing target data height = region file value (0.5 m), complete after ensureLoaded at level 12. Earth: pad flat within **8.4e-7 m** over flatRadius (450 m), elevation 21.62 m |
| Continuity across tile and cube-face borders, every level | met: synthetic levels 0-5 incl. 116 tile edges whose tiles use different scales (10 across cube edges, corners included): worst jump over 2 um 2.2e-6 m; real data, every regional level of both bodies (all mixed-scale pairs from the tile headers + 12 random pairs per level): worst 1.6e-6 m data only, 2.6e-6 m amplified. The current bakes have no mixed-scale neighbour pairs left (the reviewed Earth bake had 52 at L12 and 32 at L11, where the raw data stepped by up to 0.148 m; the reviewer's point now steps 2.8e-7 m); seam reconciliation stays covered by the synthetic set |
| C1 in lambdaMin | met: second differences of H(log2 lambda) shrink to < 0.35 x when the step halves (C2 -> 0.25) |
| Coverage edges (1,000 points per level) | met on the synthetic set (L3-5, also with `sourceCoverage`) and on every regional level of the real Moon (L7-12) and Earth (L8-12): on the boundary H equals the parent-level function exactly (0 m); E continuous: step detector (|E(+1 mm) - E(-1 mm)| minus the neighbouring one-sided 2 mm change) <= 4e-13 (the raw 2 mm change reaches 1.9e-6 where a coverage boundary lies inside another level's one-tile source ring, a slope, not a step); data only: discontinuity detector (jump minus the local 2 mm change) <= 3.3e-9 m, slope change <= 2.2e-5. The raw `|H(+1 mm) - H(-1 mm)| < 1 mm` reads 0.16-0.21 mm synthetic, <= 0.93 mm Moon, but 1.06 mm on Earth L9/L11 data only: that is the honest 2 mm change on slopes > 0.5 (no continuous surface can meet the literal number there), so the detector is asserted. With amplification the edge's own contribution (H - H_parent) jumps 0 m and its slope changes <= 6e-10; raw amplified jumps up to 3.8 mm at 2-21 of 1,000 points come from features sharp everywhere (fresh crater rims, rock flanks) |
| Texture across coverage edges (self-verify) | **met at every coverage edge** (realData.test.ts, "texture of every coverage margin equals the parent level's"): band-pass RMS slope of H over that of the parent-level surface at the same points, 0.12 / 0.4 / 0.8 tile inside the coverage boundary, 1 and 4 postings: Moon 0.99-1.02, Earth 0.99-1.05 (with E keyed on `coverage`: 0.35-0.77). Where real detail begins (the `sourceCoverage` boundary) the texture does not step (0.83-1.03 at 0.1 tile); further in it is the real data's texture, smoother than the model where a level's source is coarser than its posting (section 6, request terrain-core-4) |
| Collision = render | met: < 1e-10 m at vertices and anywhere (bilinear of the bake) |
| Lazy collision | met: first query in a fresh area <= 4 vertex evaluations (instrumented counter); first query on a fresh provider after ensureLoaded does not allocate (memo allocated by ensureLoaded); single-query time: section 5 |
| prewarmCollision deterministic, reaches 0, cost by budget | met (identical remaining sequences across instances; strictly decreasing to 0 with a fixed centre; queries afterwards evaluate nothing; nearest first; work per call follows maxVertices with a moving centre; oversize radius clamped) |
| Determinism (instances, load order, I/O timing) | met: bit-identical heights/normals/rocks/bakes across instances; identical results whether coarse tiles of another area were loaded first; seam values independent of load order |
| Bounded morph | met: max \|A(level) - A(level+1)\| / one-octave amplitude = 0.06 (Moon), 0.26 (Earth) over 400 points x levels 8-19 |
| Crater statistics (1 km^2) | met: N(>1/2/4/8/16 m) within 4-6 % of the law |
| RMS slope (NAC) | met: model 0.0572/0.0577/0.0561 vs NAC target 0.0582/0.0563/0.0565 at 2/4/8 m (section 4.1) |
| Rocks | met: same instances for overlapping queries; collidable rocks (D >= 0.5 m) raise H by 0.35-0.8 of their radius and the collision surface carries their caps within 1.7 cm (tested < 3 cm for every isolated collidable rock); smaller rocks do not change H; none on the pad |
| Normal maps match H | met: encoded-slope RMS error 0.6-7.1 % (tested < 8 %), both tiles at a shared edge within 1.5-6.9 % of H and 1.4-5.5 % of each other |
| Memory bounded | met: tile cache <= cacheBytes (tested); collision memo = capacity x 21 KB, allocated once on first need |
| Timings | analytic and cached collision met; single fresh query met on a quiet machine (max 203 us Moon / 119 us Earth over random km-apart points, p99 36 / 26 us); **bake budget met at levels 6-10, not at 13 and deeper** (section 5) |
| Self-verify hillshades | rendered and reviewed (section 6) |

### 4.1 Regolith calibration (tools/terrain-core/calibrate-regolith.ts, real NAC data)

Target = what the regional data adds above the global level: R = D(full) - D(band limit = data wavelength of
level 6), sampled at 3,000 random points in the 1.4 km disc around the recommended target (100 % NAC DTM, level
12, 2.6 m posting), RMS directional slope at 2/4/8 m: **0.0582 / 0.0563 / 0.0565** (full data: 0.0597 / 0.0579 /
0.0582, i.e. ~3.4 deg). Model = amplification alone at E = 6, unit multifractal factor, band limit 5.2 m (two NAC
postings). Grid over crater equilibrium fraction f and Hurst, bisection on the fBm amplitude, with the prior that
the fBm keeps >= 15 % of the slope variance. Result: f = 0.0125, H = 0.95, S1 = 0.0186 (craters + rocks alone
0.047/0.048/0.047). The literature f = 0.03 of the research doc gives 0.092 with craters alone (too rough for
Tranquility); 0.0125 lies inside the 1-5 % equilibrium range. Crater freshness: the 36 NAC craters >= 20 m the
Moon bake lists around the target have mean d/D 0.07 and 2/36 deeper than 0.15; the model (exponent 5,
degraded d/D 0.02) gives mean 0.086 for craters with d/D >= 0.03 (the detector's sensitivity) and 6 % deeper
than 0.15. Raising the collidable rock size from 0.3 to 0.5 m left these RMS slopes unchanged to 4 digits.

## 5. Timings

AMD Ryzen 9 9950X3D, Node 24.16, single thread, `node tools/dev/heavy.mjs --class=cpu -- npx tsx
tools/terrain-core/bench.ts --real`, medians of 9, **machine CPU busy 10 % during the run** (all cores; only the
Earth albedo bake held the bake slot), 2026-11-10 after the crash recovery:

| Measure | Budget | Real Moon (Tranquility) | Real Earth (Ka Lae) |
|---|---|---|---|
| analytic heightAt, lambdaMin 100 m | 3 us | **0.42 us** | **0.30 us** |
| cached collision query | 0.5 us | **0.055 us** | **0.050 us** |
| first collision query, fresh area (random km-apart points) | 0.2 ms each | median 13 us, p99 36 us, max 203 us | median 10 us, p99 26 us, max 119 us |
| bakeGeometry + bakeNormalMaterial, levels 6/10/13/16/max (18 / 20) | 12 ms | **6.4 / 9.0** / 14.9 / 17.2 / 14.0 ms | **8.8** / 10.4 / 13.3 / 19.3 / 18.4 ms |
| bakeTile, same levels | 12 ms | **6.4 / 8.9** / 14.9 / 17.1 / 13.9 ms | **8.9 / 10.3** / 13.1 / 19.3 / 18.3 ms |

- Earth bakes now include the land-cover layer (modulators and rock abundance read it).
- The fresh-query maximum of the Moon (203 us) is at the 0.2 ms budget; the vitest assertion of the budget runs
  only with `TERRAIN_PERF=1` (vitest runs 6 workers in parallel: the same test measured max 451 us there).
- **Bake budget: met at levels 6-10, missed by 1.1-1.6x at 13 and deeper.** History: reviewed version 31-76 ms
  under 77-90 % load; the first fix round 1.6-2.9x faster in an interleaved A/B run (modulators capped at the render
  level, coarse grid shared by geometry and normal map, per-level coverage memo and power table, exact table
  encoding instead of tanh, fused per-texel passes, no pow per texel, typed crater/rock splats, a per-tile rock
  abundance bound on the Moon).
- Profile of a Moon L16 bake (60 repetitions, ~19 ms each): per-texel band raster ~8.3 ms (gradient noise of 4
  octaves at 66,564 texels ~3.2 ms, the octave loop ~3 ms, crater and rock splats ~2 ms), the coarse grid's 4,761
  full point evaluations ~7.7 ms (amplification 3.5, data chains 2, modulators 1.7), interpolation and encoding
  passes ~2.6 ms. No single hot spot is left; micro-optimisation (e.g. a cell cache in the noise: hashing is ~8
  integer ops per hash) would gain ~5 %.
- What would close the gap (not done in this round): (1) assemble the geometry band from the per-texel raster
  (a second accumulator for components between 8 and 32 texels) so the coarse grid evaluates only the low band:
  estimated -2.5 to -3 ms; (2) WASM/SIMD for the per-texel octave loop and splats; (3) the high band on the GPU in
  terrain-render (noise and crater/rock hashes are `HASH_WGSL`-compatible by construction). With 8 workers the
  measured cost is ~400-1,200 tiles/s.

## 6. Visual review (out/terrain-core, `render-hillshade.ts`; sun azimuth 100 deg, elevation 12 deg)

Looked at after this round's changes:
- Landing region (real NAC data) at 20 km / 2 km / 200 m / 20 m and a global-only mare area at 2 km / 200 m:
  read as lunar terrain - craters of all sizes in a continuum of degradation (mostly soft ghost craters, few
  crisp ones), smooth undulating regolith at metre scale, scattered rocks. Earlier versions were reviewed and
  rejected: f = 0.03 gave pock-marked fields of crisp bowls; without the 1 m inner scale the fBm made an "orange
  peel" texture at 20-200 m.
- **Coverage edges, real Moon L7-12 and Earth L8-12** (`{moon,earth}-edge-L*.png`, 1.5 tiles wide, boundary =
  vertical centre line with red ticks): no line, no wall and no change of texture any more (moon-edge-L12.png:
  small craters and micro-relief continue at the same density on both sides; before this round the right half
  was visibly smoother). Measured: section 4, texture row.
- **Source edges** (`{moon,earth}-source-L*.png`, 3 tiles wide, E rises over the tile right of the line): no line
  or wall. On the Moon the texture continues; streaks crossing the line unchanged are data (NAC/SLDEM stripes,
  terrain-core-2). On Earth the deep sea floor right of the line (earth-source-L11.png, 4.5 km deep) turns smooth:
  the regional sea floor is ETOPO 15" posted at 9.5-150 m, so E rises without real detail to replace the
  procedural relief (request terrain-core-4). The same smoothness existed before this round, starting at the
  coverage edge instead.
- How E's source ring was chosen, measured on the real Moon: level-L data detail (D at band lambda_L minus D at
  band 2 lambda_L) against the distance from the source boundary, as a fraction of its value 1.5 tiles in, at
  L7 / L8 / L10: 0.03-0.08 outside, 0.13-0.35 at 0.2 tile, 0.25-0.76 at 0.5 tile, 0.58-0.81 at 1 tile. Texture
  of H over the parent-level surface 0.25 tile in: 0.85-1.01 at every level with the one-tile ring; relative to
  the texture outside, the quarter-tile ring dipped to 0.38 (L10, 0.12 tile in), the one-tile ring to 0.74.
- Pad (real Ka Lae): flat disc, smooth blend into the surroundings; the coast ~800 m east carries 5-6 m data drops
  within 10 m (data, not amplification).
- Coverage edges and the cube-edge region of the synthetic set (mixed-scale tiles): no line, no wall, no seam.

## 7. Known limits

- Bake budget at render levels 13 and deeper (section 5).
- Where a level's source is coarser than its posting, the inside of the source area is smoother than the
  procedural terrain outside it (Moon L9 from SLDEM, texture 0.63-0.91 of the parent level's 0.5-1 tile in; Earth
  boundary points, mostly regional sea floor: down to 0.31): the manifest does not say so (request
  terrain-core-4). Real data deeper inside also differs from the model statistically (NAC at L10: up to 1.76x
  the parent level's texture one tile in).
- Tycho floor benchmark: level-6 data -1383.5 m vs ldem_64 -1295.5 m. The Moon bake's own reader gives the same
  -1383.5 m; ldem_64 is offset 1-2 pixels against the 256 ppd product and the pixel sits on the central peak
  (relief 342 m inside it): request bake-moon-sky-1. The test accepts max(60 m, 0.3 x relief inside the pixel).
- Earth amplification is reasoned, not calibrated: the brief asks for an NAC-style calibration only on the Moon,
  no regional reference DTM finer than the 9.5 m regional data is in the data tree, and terrain-core has no
  download budget; calibrating `slope1m.*` against a 1 m lidar DTM (e.g. USGS 3DEP on Hawaii) is a follow-up for
  whoever owns the Earth data. The land cover itself is now read (section 2).
- Normal maps: encoded slopes within 7.1 % RMS of H on Earth (interpolated modulators: land cover and data slope
  at 4-texel spacing), within 4.3 % on the Moon.
- Rocks below 0.5 m exist only in rocksNear (meshes), not in H or normal maps: a leg passes through them.
- `prewarmCollision` with a moving centre warms a disc up to 10 % larger than requested and reports its count; a
  call's time follows maxVertices at up to ~5 us per unit (opening a tile is charged 1 unit per 256 vertices but
  sorts and scans them: measured 2.3 us per unit while evaluating, 4.7 us on the call that opens the tiles).
- Seam reconciliation makes a point within ~3 samples of a data-tile edge depend on the neighbour tile(s); load
  sets include them (6 samples of each level), so this only matters for callers that query outside what they loaded.

## 8. Requests and contract notes

- `docs/requests/terrain-core-1.md` (contract + bakes): `TileLayerManifest.sourceCoverage`. Both bakes write it
  and terrain-core uses it (section 1); open only for the contract text (the field, the E recursion with
  SOURCE_BLEND_TILES = 1, the `TerrainResidency.effectiveLevel` comment). Blocking: no.
- `docs/requests/terrain-core-2.md` (bake-moon-sky data): NAC stripes in levels 10-12. Open.
- `docs/requests/terrain-core-3.md` (bake-earth data): terraced bathymetry / stair-stepped coast near Ka Lae.
  Resolved by bake-earth (a6dc2b7); the renders confirm the smooth sea floor.
- `docs/requests/terrain-core-4.md` (bake-moon-sky, bake-earth): list in `sourceCoverage` only tiles whose source
  is finer than the parent level (Moon L9 SLDEM, Earth sea-only tiles), and use the non-zero-weight area on
  Earth as on the Moon. Blocking: no.
- No open requests against terrain-core paths existed at hand-off.
- Contract notes for the lead: `TerrainBaker` and `TerrainAuthority` live in `src/terrain/provider.ts`
  (terrain-render may import src/terrain); `TileLayerManifest.coverage` is treated as present-or-empty; the data
  term is band-limited by lambdaMin (section 1) - if the lead prefers the literal reading (data never band
  limited), coarse render tiles would need every fine tile under them. `prewarmCollision`'s returned count refers
  to the job's disc (equal to the requested disc for a fixed centre, up to 10 % larger for a moving one). E keys on
  `sourceCoverage` when the manifest has it (request terrain-core-1), which the contract text does not say yet.
- Crash recovery (2026-11-10): the interrupted fix round had committed c5f5c34 and d455940; its uncommitted
  work (bench CPU-busy report, the measured-defect tests, the request evidence, this note) was checked and
  carried over. Nothing under `src/terrain`, `tests/unit/terrain-core` or `tools/terrain-core` was truncated;
  the review probes and the full suite were re-run on the re-baked tile sets.
