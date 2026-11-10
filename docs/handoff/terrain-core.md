# Hand-off: terrain-core

The single height authority of the engine (`src/terrain`): tile sources, a deterministic decoded-tile cache,
the coverage-blended data height, procedural amplification (Earth land cover, lunar regolith with craters and
rocks), launch-pad flattening, the lazy collision surface, rocks, and the tile baker for the renderer's
workers. Headless, deterministic, worker-safe; `npx vitest run tools/dev/boundaries.test.ts` is green.

Status at hand-off: all 59 terrain-core tests plus the boundary test pass, including the real-data suite
on the baked Moon and Earth tile sets. **Not met: the tile-bake budget of 12 ms**: bakeTile measures
34-67 ms per tile (section 5). The texture-at-margin issue on the real Moon (section 6) needs a contract
change (request terrain-core-1).

## 1. Public API

Import from `src/terrain` (index.ts). The Node-only tile source is imported by path:
`import { createFsTileSource } from '<repo>/src/terrain/fsTileSource'` (never from browser code).

```ts
createTerrainProvider(defs: DefLibrary, tileSource: TileSource, opts?: TerrainProviderOptions): Promise<TerrainAuthority>

interface TerrainProviderOptions {
  cacheBytes?: number;            // decoded-tile cache budget (resident pyramid + pins + LRU), default 384 MiB
  collisionCacheTiles?: number;   // collision memo capacity in max-level tiles (21 KB each, one slab on first use), default 1024
  bodies?: readonly string[];     // default: every body with a terrain definition
  residentLevel?: number;         // pyramid levels 0..n loaded at creation and pinned forever; default manifest.residentHeightLevel
}

type TerrainAuthority = TerrainProvider & RockField & TerrainBaker & {
  diagnostics(): TerrainDiagnostics;     // { vertexEvaluations: Record<body, n>, collisionTiles: Record<body, n>, cache: { tiles, resident, pending, bytes, budget } }
  cachedTiles(): string[];                // sorted "tileset/layer/face/level/x/y" ('*' = in flight): determinism checks
  heightParts(bodyId: string, dir: Vec3, lambdaMin: number): HeightParts;  // { data, amplification, height, complete }
  readonly bodyIds: readonly string[];
};

interface TerrainBaker {
  prepareTile(bodyId: string, key: TileKey, slot?: string): Promise<void>;   // pins under `slot` (default "bake"), replacing that slot's pin
  bakeGeometry(bodyId: string, key: TileKey): GeometryBake;                  // { heights: Float32Array(65*65), hMin, hMax, complete }
  bakeNormalMaterial(bodyId: string, key: TileKey): NormalMaterialBake;      // { rgba: Uint8Array(256*256*4), slopeScale, complete }
  bakeTile(bodyId: string, key: TileKey): { geometry: GeometryBake; normalMaterial: NormalMaterialBake };  // both, sharing work; bit-identical to the two calls
  tileBounds(bodyId: string, key: TileKey): { hMin: number; hMax: number };  // conservative, from resident data, without baking
}

createFetchTileSource(baseUrl: string): TileSource      // "/tiles": {baseUrl}/{tileset}/manifest.json, .../{layer}/{face}/{level}/{x}/{y}.{ext}?v={contentHash}
createFsTileSource(rootDir: string): TileSource         // node only (src/terrain/fsTileSource.ts), rootDir = <repo>/data/tiles
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
  vertexFaceCoord(y, j, L))`. A query evaluates at most the 4 vertices of its quad.
- `heightAt(body, dir, lambdaMin)` is analytic. **Band limiting applies to the data term too** (my reading of
  "cost falls as lambdaMin grows"): data level L contributes with weight beta_L = smootherstep(L_lambda - L + 1),
  L_lambda = log2(lambda0 / lambdaMin), lambda0 = pi R / 256 (two texels of level 0), multiplied by the coverage
  weight w_L. Without a band limit every beta is 1 and the recursion is exactly COVERAGE_BLEND_TILES; with one,
  coarse queries and coarse render tiles never need fine tiles, the function is C2 in lambdaMin, and between
  consecutive render levels the data changes by one level's detail band. lambdaMin <= 0 = finest; NaN throws.
- **Collision = render**: at maxRenderLevel `bakeGeometry` returns exactly the collision vertices (same code
  path, bit-identical); measured max |heightAt - bake| 8.6e-11 m at vertices, 5.7e-11 m between them.
- `normalAt` = central differences of the collision surface over `baseline` along an orthonormal tangent pair.
  `surfaceKind` = 'water' where the body has an ocean and the collision height < sea level.
- `ensureLoaded(body, dir, radius, slot?)` loads every tile of every level 0..max of the height layer (and
  land cover when the model uses it) that the height function can read for ANY band limit within
  `radius + margin` (margin = largest rock diameter + 4 m, land cover + half a texel), pins it under `slot`
  (default slot "default"; a new call for the same slot replaces its pin) and resolves when resident. It
  rejects when the pinned sets plus the resident pyramid cannot fit `cacheBytes` (message names the numbers).
- `prewarmCollision(body, dir, radius, maxVertices)`: a job per exact (dir, radius); vertices sorted by distance
  (bilinear-of-corners positions, ties by index) are evaluated nearest first through a k-way merge; returns
  the count of vertices within radius not yet evaluated on final data. **Call it with a fixed centre** (e.g. the
  predicted touchdown point snapped by the caller): a different centre or radius starts a new job (O(tiles in the
  disc) setup). Throws if the disc needs more than half the collision memo (raise `collisionCacheTiles`).
  30 m radius at maxRenderLevel 18 = 147k vertices; 2,000 vertices per call ~ 5-10 ms.
- `residency()`: `residentLevel` = deepest resident height level at the point, `availableLevel` = deepest
  level the manifest has there, `effectiveLevel` = E (manifest only), `complete` = every height (and land-cover)
  tile the full-detail function reads at the point is resident.
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
  Rocks with **D >= rockCollisionMinDiameterM (0.3 m)** are bumps in H: ellipsoidal cap
  `bump(rho) = hR sqrt(1 - (rho / (D/2))^2)` with hR = heightRatio * D/2, heightRatio in [0.35, 0.8] (Moon) /
  [0.35, 0.75] (Earth) hashed from the rock (not exposed: renderer meshes should cover the cap, i.e. sit their
  top at baseHeight + up to 0.8 radius). Smaller rocks are visual only (not in H, not in normal maps).
- **Normal/material map** (`bakeNormalMaterial`): 256 x 256 cell-registered (texel centre u = (i + 0.5)/256,
  row = v). r, g = `0.5 + 0.5 tanh(s / slopeScale)` of the directional derivatives of H (m/m) along the unit
  tangents tU = normalize(dP/du), tV = normalize(dP/dv). They are not orthogonal on the gnomonic face
  (tU . tV = -s t / sqrt((1 + s^2)(1 + t^2))); the exact gradient is
  g = ((sU - c sV) tU + (sV - c sU) tV) / (1 - c^2), c = tU . tV. b = AO = 1 - min(1, AO_GAIN * concavity)
  (two scales: 1 texel and 4 texels). a = material weight: Moon = crater freshness (fresh interiors and
  ejecta; also 1 on collidable rocks), Earth = rockiness (land-cover blend + slope above `steepRockSlope`).
  `slopeScale` = clamp(2 x RMS slope of the tile, 0.01, 8). Band limit tileSize/128.
- **Worker use**: one provider per worker with `residentLevel: 2` (17 MB of pyramid per body instead of 68 MB)
  and a smaller `cacheBytes`; per job `await prepareTile(body, key)` then `bakeTile(body, key)`; `complete`
  false means data was missing (prepare first). Everything is synchronous after `prepareTile`.

## 2. How it works (where to look)

| File | Role |
|---|---|
| `tileSource.ts`, `fsTileSource.ts` | fetch / fs TileSource, manifest cache, never requests unpromised tiles (null), rejects on a promised-but-missing tile |
| `tileStore.ts` | byte-budgeted LRU (resident + in-flight), permanent pins, slot pins, call-order eviction |
| `coverage.ts` | `LayerCoverage`: layerHasTile, memoised 8-neighbour missing masks (cube-edge neighbours via dirToTile), w_L exactly as COVERAGE_BLEND_TILES |
| `bicubic.ts` | Catmull-Rom on the bordered 259 x 259 tile |
| `evaluator.ts` | point evaluation: level indices from face (s, t), coverage, E, band-limited data chain (starts at the highest level of weight 1), land-cover chain, data-scale height and slope, model, modifiers |
| `body.ts` | per-body state, services for models, tile enumeration for ensureLoaded / prepareTile |
| `collision.ts` | collision memo (slab, O(1) LRU, provisional vertices), prewarm jobs |
| `baker.ts` | geometry, two-grid normal/material maps, tileBounds |
| `noise.ts` | integer-hash gradient noise (corner hash = `hash4(iz, iy, ix, seed)`, WGSL-reproducible), measured statistics |
| `craters.ts`, `rocks.ts`, `shellCells.ts`, `smoothField.ts` | shell-in-cell hash grids (a point query visits 2 x 2 x 2 cells per class), crater profile, Golombek-Rapp rocks, lattice-interpolated rock abundance |
| `amplification/` | interface, registry (`none`, `lunar-regolith`, `earth-landcover`), shared helpers |
| `modifiers.ts` | flatten discs: body modifiers + one per LaunchSiteDef pad |

Key definitions:
- Effective level E (manifest only) and the data-scale band limit lambda_s = lambda0 2^-E. Models get the data
  height and **data slope at lambda_s**; the slope is a forward difference of D over lambda_s/8 along a
  face-independent tangent pair (per-face bicubic derivatives are only approximately C1 across cube edges and
  made the multifractal amplitude jump by metres there - found by the continuity test and fixed).
- Every component (octave 2^j m, crater class D, rock 2D, ripple/dune wavelength) has weight
  smootherstep(log2(len / lambdaMin)) (C2, at most one octave changes between consecutive render levels) and an
  E weight (octaves below the data wavelength, craters below `craterMaxDiameterInPostings` postings, fading over
  one octave).
- Pads: H = mix(H_natural, elevation, w), w = 1 inside flatRadius, smoothstep to 0 at blendRadius (great-circle
  distance). 'terrain'/'sample' elevation = natural DATA height at the centre from final data, resolved in
  createTerrainProvider. Rocks are thinned by (1 - w).

### Amplification parameters (`data/defs/terrain/*.amplification.json`, every key required)

**lunar-regolith** (calibrated against the real NAC DTM, section 4): regolith fBm `regolithSlope1m` 0.0186
(RMS slope of an octave at 1 m), `hurstMaria` 0.95 / `hurstHighlands` 0.65 blended by data roughness
(`hurstRoughnessRange`), `regolithInnerScaleM` 1 (fBm rolls off below 1 m: dust; craters and rocks carry the
sub-metre relief), multifractal factor `1 + (max-1)(1 - e^(-gain ramp(ratio-1)))` with `multifractalGain` 0.8,
`multifractalMax` 3; craters: `craterEquilibriumFraction` 0.0125 (of geometric saturation 1.54 D^-2 per m^2, D in
m), half-octave classes from `craterMinDiameterM` 0.6 to `craterMaxDiameterInPostings` 4 postings of E,
`freshDepthToDiameter` 0.196, `degradedDepthToDiameter` 0.02, `rimHeightToDiameter` 0.036,
`degradedRimFraction` 0.15, freshness = u^`craterFreshnessExponent` (5), ejecta to `craterEjectaExtentRadii`
2.5 radii (r^-3), rim rounding 0.08 (fresh) .. 0.9 (degraded) of (depth + rim); rocks: Golombek-Rapp k from
`rockAreaFractionMare` 0.02 to `rockAreaFractionFreshEjecta` 0.25 on fresh ejecta of craters >=
`rockSourceMinCraterDiameterM` 20 m (lattice `rockAbundanceGridM` 10 m), diameters 0.1-4 m, collidable >= 0.3 m.
Also the calibration record `calibrationTargetRmsSlope{2,4,8}m`, `calibrationLambdaM`.

**earth-landcover**: per LANDCOVER_CLASS `slope1m.*`, `ridged.*` (ridged 1 - 2|n| share: lava), `ripple.*`,
`dune.*`, `rockiness.*`, `rockK.*`; `hurstLand` 0.8, `hurstSeabed` 0.9, `seabedSlope1m`, `seabedDepthRampM`,
multifractal as on the Moon, `steepRockSlope` 0.6, aeolian ripples 0.12 m / 1 cm and dunes 30 m / 1.2 m aligned per
20 km wind cell, rocks 0.15-3 m. These are reasoned values, not calibrated (no regional reference DTM was in
scope). Without a `landcover` layer (the current Earth tile set has none yet) every point uses the 'unknown'
class row; it switches automatically when the bake adds the layer.

## 3. How to run and verify

```
npm run typecheck:paths -- src/terrain tests/unit/terrain-core tools/terrain-core
npx vitest run src/terrain tests/unit/terrain-core tools/dev/boundaries.test.ts      (~3 min with real tiles)
TERRAIN_PERF=1 npx vitest run tests/unit/terrain-core/collision.test.ts               (asserts the 0.2 ms query budget: quiet machine only)
npx tsx tools/terrain-core/bench.ts [--real]           timings vs budgets (fixture / data/tiles)
npx tsx tools/terrain-core/render-hillshade.ts         hillshades into out/terrain-core/*.png
npx tsx tools/terrain-core/calibrate-regolith.ts [--write]   NAC calibration (needs data/tiles/moon)
npx tsx tools/terrain-core/measure-noise.ts            noise normalisation constants
```

Synthetic fixtures (`tools/terrain-core/fixtures.ts`): analytic heights encoded with tileCodec into
`%TEMP%/fable-terrain-core-fixtures-v3` (generated once, ~6 s). `fixture-moon`: global levels 0-2, sparse 3-5 in
region A (face 0) and 3-4 in region B straddling the face 0 / face 2 edge; regional levels add their own detail
and +10 m per level (max disagreement with the global level 40-60 m). `fixture-earth`: heights + land cover,
sparse 3-5 around the fixture pad. `realData.test.ts` runs automatically when `data/tiles/{moon,earth}/manifest.json`
exists.

## 4. Measured against the acceptance criteria

| Criterion | Result |
|---|---|
| Tile sources, manifest caching, layerHasTile | met: tileSource.test.ts (manifest fetched once, unpromised tiles never requested, 404 on a promised tile rejects, failed manifest retried) |
| Cache: budget, slot pins, sync lookup, deterministic eviction | met: determinism.test.ts (identical cache contents after every call of a 12-call sequence under two different I/O jitter seeds; bytes <= budget always; oversize request refused; slot re-pin frees the old set) |
| Real benchmarks | Moon: Tranquility pixel mean -1923.9 m (ldem_64 -1925), Apollo 17 -2628.7 (-2624.5), Aitken -6953.5 (-6948), Tycho floor -1383.5 (-1295.5, see section 6), Tranquility point at full resolution -1927.6 m (<5 m); landing target data height = region file value (0.5 m), complete after ensureLoaded at level 12. Earth: pad flat within **8.4e-7 m** over flatRadius (450 m), elevation 21.62 m as in the location file |
| Continuity across tile and cube-face borders, every level | met: worst jump over 2 um across tile / cube edges 3.0e-6 m (levels 0-5, band limits 0.32 m - 5 km, with and without amplification); shared edge vertices of neighbouring max-level tiles identical (same face) and identical across the cube edge |
| C1 in lambdaMin | met: second differences of H(log2 lambda) shrink to < 0.35 x when the step halves (C2 -> 0.25) |
| Coverage edges (1,000 points per level) | met on the synthetic set (L3-5) and on every regional level of the real Moon (L7-12) and Earth (L8-12): on the boundary H equals the parent-level function to 0 m (exactly); E continuous (jump 0 - 1.8e-15); data only: raw \|H(+1 mm) - H(-1 mm)\| <= 0.21 mm synthetic, <= 0.93 mm Moon, <= 1.06 mm Earth (the Earth maximum is the honest 2 mm change on slopes > 0.5: discontinuity detector 1e-9 m), slope change <= 2.2e-5; with amplification the edge's own contribution (H - H_parent) jumps 0 m and its slope changes <= 6e-10. The **raw** amplified numbers include features that are sharp everywhere (fresh crater rims, rock flanks): raw jumps up to 3.6 mm at 2-21 of 1,000 points, raw 10 cm-slope changes up to 0.09 - same statistics on both sides; asserted through the edge contribution and the discontinuity detector (excess <= 3.3e-6 m) |
| Collision = render | met: < 1e-10 m at vertices and anywhere (bilinear of the bake); collision vs analytic H at the collision band: max 3.8 cm (fixture Moon, bilinear error of 16 cm quads over rocks/crater rims) |
| Lazy collision | met: first query in a fresh area <= 4 vertex evaluations (instrumented counter); single-query time: see section 5 |
| prewarmCollision deterministic, reaches 0 | met (two providers give identical remaining sequences; strictly decreasing to 0; queries afterwards evaluate nothing; nearest first) |
| Determinism (instances, load order, I/O timing) | met: bit-identical heights/normals/rocks/bakes across instances; identical results whether coarse tiles of another area were loaded first and provisional vertices memoised meanwhile |
| Bounded morph | met: max \|A(level) - A(level+1)\| / one-octave amplitude = 0.06 (Moon), 0.26 (Earth) over 400 points x levels 8-19 |
| Crater statistics (1 km^2) | met: N(>1/2/4/8/16 m) = 19209/4713/1143/282/73 vs law 19250/4813/1203/301/75 |
| RMS slope (NAC) | met: model 0.0572/0.0577/0.0561 vs NAC target 0.0582/0.0563/0.0565 at 2/4/8 m (section 4.1) |
| Rocks | met: same instances for overlapping queries; collidable rocks raise H by 0.35-0.8 of their radius (also the collision surface for r >= 0.3 m); smaller rocks do not; none on the pad |
| Memory bounded | met: tile cache <= cacheBytes (tested); collision memo = capacity x 21 KB, allocated once; per-level coverage memo and lattice caches are small fixed tables |
| Timings | analytic and cached collision met; single fresh query p99 at the budget, max over; **bake budget not met** (section 5) |
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
than 0.15.

## 5. Timings (provisional: wave-1 machine, ~86-90 % CPU load from concurrent bakes and tests)

AMD Ryzen 9 9950X3D, Node 24.16, single thread, `tools/terrain-core/bench.ts --real`, medians:

| Measure | Budget | Real Moon (Tranquility) | Real Earth (Ka Lae) |
|---|---|---|---|
| analytic heightAt, lambdaMin 100 m | 3 us | **1.13 us** | **1.05 us** |
| cached collision query | 0.5 us | **0.19 us** | **0.11 us** |
| first collision query, fresh area (random km-apart points) | 0.2 ms each | median 38 us, p99 205 us, max 3.0 ms | median 29 us, p99 123 us, max 1.3 ms |
| bakeGeometry + bakeNormalMaterial, levels 6/10/13/16/max | 12 ms | 31 / 38 / 76 / 74 / 62 ms | 35 / 37 / 39 / 65 / 70 ms |
| bakeTile (shared work), same levels | | 36 / 37 / 67 / 60 / 45 ms | 34 / 35 / 39 / 51 / 52 ms |

- The fresh-query maxima coincide 1:1 with GC scavenges and preemption on the loaded machine (22 slow queries =
  22 scavenges in a 5,000-query trace); steady-state collision queries allocate nothing (memo slab, typed block
  caches). The vitest assertion of the 0.2 ms budget runs only with `TERRAIN_PERF=1`.
- **Bake budget missed by 3-6x.** Profile of a level-6 tile (trivial content): ~12 ms for the 69 x 69 coarse
  grid (full point evaluations at two band limits plus the data-scale slope), ~10 ms of per-texel finishing over
  258^2 samples (positions, metric, slopes, AO, tanh encoding), the rest crater splatting and data continuation;
  levels 13-18 add 20-40 ms of high-band noise, crater and rock splatting. Already done: scanline data
  continuation, cell-cached noise, typed crater/rock block caches, exact cap cell enumeration, rock thinning
  bounds, chain start at the highest full-weight level, skipping the model where E rules it out. The remaining
  options are structural: WASM/SIMD for the per-sample loops, or generating normal maps on the GPU (the noise
  and crater/rock hashes are `HASH_WGSL`-compatible by construction), or a 128 x 128 high band upsampled. With 8
  workers the measured cost is ~120-230 tiles/s.

## 6. Visual review (out/terrain-core, `render-hillshade.ts`; sun azimuth 100 deg, elevation 12 deg)

- Landing region (real NAC data) at 20 km / 2 km / 200 m / 20 m and a global-only mare area at 2 km / 200 m:
  read as lunar terrain after calibration - craters of all sizes in a continuum of degradation (mostly soft
  ghost craters, few crisp ones), smooth undulating regolith at metre scale, scattered rocks. Earlier versions
  were reviewed and rejected: f = 0.03 gave pock-marked fields of crisp bowls; without the 1 m inner scale the
  fBm made an "orange peel" texture at 20-200 m.
- Pad (real Ka Lae, fixture): flat disc, smooth blend into the surroundings.
- Coverage edges, synthetic set (L3-5, incl. the cube-edge region): no line, no wall, no texture change.
- **Coverage edges, real Moon L7-12: no line and no wall, but a change of texture across the quarter-tile ring.**
  The bakes extend each coverage rectangle one tile beyond the data with parent-identical data; inside it E is
  already the finer level, so the procedural classes the parent leaves to amplification (e.g. 10-21 m craters at
  the level-12 edge) stop although the data there has only parent detail. Fix requires knowing where real
  detail starts: request terrain-core-1 (optional `sourceCoverage` in the manifest; ~20 lines in the evaluator).
- Data artefacts seen in the renders (not terrain-core): N-S stripes in the NAC levels 10-12 (request
  terrain-core-2), terraced sea floor with constant -157 m / -98 m plateaus and a stair-stepped coastal cliff
  near Ka Lae (request terrain-core-3).

## 7. Known limits

- Bake budget (section 5) and the tail of single fresh collision queries on a loaded machine.
- Texture change at real coverage margins (section 6, terrain-core-1).
- Tycho floor benchmark: level-6 data -1383.5 m vs ldem_64 -1295.5 m. The Moon bake's own reader gives the same
  -1383.5 m; ldem_64 is offset 1-2 pixels against the 256 ppd product and the pixel sits on the central peak
  (relief 342 m inside it): request bake-moon-sky-1. The test accepts max(60 m, 0.3 x relief inside the pixel).
- Earth amplification is reasoned, not calibrated; the Earth tile set has no `landcover` layer yet, so the whole
  planet uses the 'unknown' class until it does (no code change needed).
- The normal map's coarse part is interpolated from a 4-texel grid: components between 16 and 32 texels carry
  up to a few % interpolation error (measured encoded-slope error vs finite differences of H: 0.6-17 %, 3.5 % at
  the Moon's max level).
- Rocks are ellipsoidal caps in H; renderer meshes must cover the cap (section 1). Rocks below 0.3 m exist only
  in rocksNear (meshes), not in H or normal maps.
- `prewarmCollision` restarts its job when the centre changes; callers should keep the centre fixed per target.
- Tile edges that two neighbouring bake tiles quantise with different power-of-two scales would step by up to
  half a count; the bakes use one scale per level (the continuity tests pass on real data).

## 8. Requests and contract notes

- `docs/requests/terrain-core-1.md` (contract, terrain.ts + bakes): optional `TileLayerManifest.sourceCoverage`
  so E follows real detail, not coverage margins. Blocking: no (visual).
- `docs/requests/terrain-core-2.md` (bake-moon-sky data): NAC stripes in levels 10-12.
- `docs/requests/terrain-core-3.md` (bake-earth data): terraced bathymetry / stair-stepped coast near Ka Lae.
- No open requests against terrain-core paths existed at hand-off.
- Contract notes for the lead: `TerrainBaker` and `TerrainAuthority` live in `src/terrain/provider.ts`
  (terrain-render may import src/terrain); `TileLayerManifest.coverage` is treated as present-or-empty; the data
  term is band-limited by lambdaMin (section 1) - if the lead prefers the literal reading (data never band
  limited), coarse render tiles would need every fine tile under them.
