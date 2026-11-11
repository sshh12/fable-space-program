# Hand-off: terrain-render

The planet surfaces: a float64 cube-sphere quadtree per body with CDLOD geomorphing, tile streaming from
worker bakes into fixed GPU pools, G-buffer shading (imagery, detail materials, orbital detail, night lights,
shore), the far water sheet with the hand-over to the ocean's near field, shadows into every cascade, and the
rock field around the camera. Everything below was measured on the real baked tile sets (`earth`, content
hash `ab20fdfc579d4015`; `moon`).

## 1. Where things are

| Path | What |
|---|---|
| `src/render/terrain/index.ts` | public API (section 2) |
| `feature.ts` | the `RenderFeature`: per-frame selection, prefetch, records, draw lists, body uniform, G-buffer / shadow hooks, debug API |
| `lod.ts` | `lodK`, `levelRange`, `morphWindow`, `morphFactor`, `fadeMorph`, `warpLevelCap`, `capMaxLevel`, `capMorph` (pure) |
| `tileMath.ts` | float64 tile frames, the vertex formula's twin, exact shell-patch distance, bounding spheres, `snapDirection` (pure) |
| `quadtree.ts` | `BodyQuadtree`: nodes, selection (`select`), shadow casters (`selectCasters`), bounds, horizon and frustum culling |
| `records.ts` | the 320-byte tile record (image owners, uv transforms, tiling origins, imagery level at the corners, apron) |
| `gridMesh.ts` | the shared 65 x 65 grid with skirt ring, full tile and quadrant index ranges |
| `gpuPools.ts` | `LayerPool` (fixed texture arrays, free lists) and `BatchMipGenerator` (8 layers per pass) |
| `streamer.ts` | request queue, workers, upload budget, LRU eviction, pinning, statistics |
| `tileWorker.ts`, `workerProtocol.ts` | module worker: terrain-core bake + image decode + aux channels + night image |
| `nightImage.ts` | night-light textures with a border from the neighbouring tiles (pure) |
| `materials.ts` | surface tunables (`SURFACE_PARAM_KEYS`), material sets, the noise volume, the material uniform |
| `lowResAlbedo.ts` | CPU lookup of `globals/albedoLowRes` (rock tint) |
| `rockMesh.ts`, `rocks.ts` | 6 rock shapes x 3 LODs, chunked instance lists, G-buffer and shadow draws |
| `shaders/common.ts` | body uniform, tile record, the CDLOD vertex (`terrainVertex`), shadow pass |
| `shaders/surface.ts` | sampling, water logic, night lights, detail materials, orbital detail, `TERRAIN_GBUFFER_WGSL`, `TERRAIN_WATER_WGSL` |
| `data/defs/render/earth.surface.json`, `moon.surface.json` | every tunable (section 6) |
| `public/assets/terrain/<set>/` | material sets: `<id>.ah.webp` (albedo + height), `<id>.nra.webp` (normal xy, roughness, AO), `set.json` (7.3 MB in all) |
| `tools/terrain/gen_materials.py` | generator of the material sets (procedural, tileable; no API keys used) |
| `tools/terrain/bench-select.ts`, `probe-bake.ts`, `scan-spikes.ts` | selection benchmark in Node; evidence tools of requests 1 and 2 |
| `labs/terrain/` | the lab (section 7) |
| `tests/unit/terrain-render/` | 38 unit tests (LOD maths, crack-freedom by a float64 twin of the vertex shader, selection, coverage, meshes, night images) |
| `tests/browser/terrain/` | `smoke`, `views` (the reviewed screenshots), `integrity`, `pops`, `terrain.perf` |

## 2. Public API (exact signatures)

```ts
import { createTerrainFeature } from '@/render/terrain';

createTerrainFeature(
  ctx: RenderContext,
  terrainProviderFactory: (ctx: RenderContext) => TerrainAuthority | Promise<TerrainAuthority>,
  options?: TerrainFeatureOptions,
): TerrainFeature                       // RenderFeature, id 'terrain', order -50

interface TerrainFeatureOptions {
  id?: string; order?: number;
  streamer?: Partial<StreamerOptions>;  // workers, tileLayers, imageLayers, nightLayers, uploadTiles, uploadMs, workerCacheBytes
  pinLevel?: number;                    // levels 0..pinLevel always resident (default 2)
  preloadLevel?: number;                // loaded ahead for a body within 16 radii (default 3)
  rocks?: boolean;                      // default true
}
interface TerrainFeature extends RenderFeature { readonly debug: TerrainDebug }
```

Use: `const terrain = createTerrainFeature(renderer.context, () => theAuthorityTheSimUses); await renderer.addFeature(terrain);`
The factory must return the SAME height authority the simulation collides with: the mesh at the deepest level
is its surface (verified to 0.000 mm, section 8). `init` loads the manifests, material sets and the six root
tiles of every body with `BodyDef.terrain`; `isIdle()` is true when nothing is queued, loading, uploading or
fading.

`TerrainDebug` (tests and labs only): `stats()` (`stream: StreamStats`, per-body `TerrainBodyStats`, `records`,
`instances`, `selectMs`, `prefetchMs`, `rocks`), `setStreamDelay(ms)`, `setMorphEnabled(on)`,
`setRocksEnabled(on)`, `provider()`, `readyTiles(body, level, lat, lon, limit)`, `readyTileAt(body, lat, lon,
maxLevel?)`, `readTile(body, key) -> { heights, albedo, aux, normal }`, `bodies()`.

Also exported: `DEFAULT_STREAMER_OPTIONS`, `SURFACE_PARAM_KEYS`, types `StreamerOptions`, `StreamStats`,
`TerrainBodyStats`, `TerrainProviderFactory`, `MaterialSetManifest`, `SurfaceParamKey`, `SurfaceParams`.

Reads from the frame: `frame.bodies` (poses, sun), `frame.observers` (LOD observers: the active vessel
refines the ground under it), `frame.snapshot.patches.current[].markers` (kind `impact`: prefetch),
`ctx.quality.terrainPxPerQuad`, the shared resource `'ocean.nearField'`. Publishes nothing. Perf labels:
GPU `terrain.gbuffer`, `terrain.shadow`, `terrain.mipgen`; CPU `terrain.select`, `terrain.stream`; counters
`terrain.tiles`, `terrain.queue`.

## 3. How it works (what a maintainer needs)

**Selection.** `K = renderHeight / (2 tan(fovY/2) * 64 * pxPerQuad)` clamped to [1.25, 64];
`range(l) = 2 K faceSize / 2^l`; a tile splits when an observer is nearer than the children's range
(distance to the tile's shell patch between its lowest and highest vertex, exact). Children are tested
one by one; a child that is out of range, not READY, or whose parent is still fading in is drawn by the
parent as a quadrant (instance word = record index | (quadrant + 1) << 20). Frustum culling uses bounding
spheres with a guard band of one tile; horizon culling compares angles against an occluder sphere (sea
level - 100 m on ocean bodies, else R + minElevation). On a body with a sea the visibility bound of a tile
that lies under water reaches up to the sea surface (`TileNode.cull`, `cullTop`): the far water sheet is
drawn from the same tile; the level-of-detail distance stays the distance to the terrain.

**Morph.** `k = clamp((d / range(l) - m0) / (m1 - m0))`, `m0 = clamp(0.5 + 0.5/K, 0.7, 0.9)`,
`m1 = max(0.95, m0 + 0.08)`: the coarser side of every LOD border is unmorphed, the finer side is fully the
parent's geometry. Odd vertices slide to an even neighbour in a direction fixed per cube face
(`snapDirection`), so half-morphed edges agree across cube edges. A tile that enters the selection starts
fully morphed and relaxes over 0.35 s on the feature's own clock (0.12 s for 3 s after a camera cut, 0 on the
cut frame). The sheet morphs by the distance to the TERRAIN vertex, like the terrain. Warp: with ground
speed v per wall-clock second, `c = log2(faceSize / (2 v))`; levels deeper than `floor(c)` are not drawn and
level `floor(c)` morphs out as `c` falls.

**Streaming.** One job per worker at a time: `prepareTile` + `bakeTile` of terrain-core (65 x 65 heights,
256 x 256 normal/material), the albedo `ImageBitmap` (decode options of ARCHITECTURE section 1), the aux
image (water mask, land cover) and the night image. Priorities = range / distance (x 4 near a vessel
observer, x 0.25 in the guard band, x 0.3 / 0.2 for prefetch passes); a request not wanted for 12 frames is
dropped; a job in flight is discarded on arrival if nobody wants it. Uploads stop at 8 tiles or when the
running estimate says the next tile would pass 2 ms. Pools (allocated once under OOM scopes): heights
r32float 65^2 x 1280, normals rgba8 256^2 + mips x 1280, albedo rgba8-srgb + mips x 1024, aux rg8 + mips x
1024, night r8 258^2 + mips x 384: 0.97 GiB. Eviction is LRU among tiles untouched for 90 frames; ancestors
of drawn tiles and levels 0..2 are never evicted.

**Water.** The sheet is drawn first (same tiles, vertices on the sea sphere, depth = the seabed's). It
discards where the mask says land (while the mask is finer than the geometry: `influence =
saturate(imageLevel + 3 - (level - k))`), where no water is near (mask mip 5 < 0.004) and inside
`'ocean.nearField'.fadeStart` of the camera's body. The terrain fragment writes water itself for lakes and
rivers above sea level and for coastal pixels the mask calls water; inside the near field (tested where the
pixel's ray meets the sea surface, not at the fragment) it never does: the G-buffer there holds the seabed.
Water albedo is the imagery colour, going to the imagery's open-ocean colour with depth
(`deepWaterSrgb*`, `deepWaterDepthM`). The sheet keeps the terrain's tall skirts (0.015 x tile size): where
the mask calls a coast land while the coarse mesh there is still below sea level, the sea horizon would show
a notch of sky, and the skirt of the sheet tile behind closes it (seen in the hole test when the skirts were
shortened: a few pixels at the tip of an island on the horizon, two frames after a camera cut).

**Night lights.** Read `nightMinMip` levels above the night layer's deepest level (Earth: level 5, 1.2 km
texels: the source's cells are coarser than the layer's texels), from textures that carry one border texel
of the neighbouring tiles (same face or across a cube edge), reconstructed with a cubic B-spline when
magnified, with a shoulder for saturated city centres and ground-fixed grain below the layer's resolution
(`nightClusterM`, `nightClusterStrength`). One channel (the red of the night image) times `nightTint*`.

**Rocks.** Chunks of about 40 m (cube-sphere tiles) hold `rocksNear` of terrain-core sorted by shape and
radius; a rock is drawn within `radius x rangePerRadius` (at most `rockRangeM`), grows in over the outer
30 % of its range, LOD by size on screen, flat-shaded faces, tint from the low-resolution albedo map.

## 4. Deviations from the brief (and why)

1. **Levels 0-2 are always resident; level 3 is loaded ahead** for a body within 16 radii and can be evicted
   again (brief: levels 0-3 always resident). With both bodies pinned to level 3 (768 tiles) the image pool
   ran out at 10 km / 1440p. A cut to anywhere still starts from level 2 or 3.
2. **`createTerrainFeature` has a third, optional `options` parameter** (pool sizes, pin levels, rocks off).
3. **Night lights are one channel with a per-body tint, sampled at level 5 with a border**, not the RGB
   image at its deepest level: the RGB pool was exhausted by pinned tiles, the source's cells are 2-4 texels
   wide at level 7 (request 3, declined: they are in the source), and per-tile filtering cut every light at
   a tile edge.
4. **Deep water takes one colour** (the imagery's own open-ocean fill, sRGB 2/5/20) from 5 m to 60 m of
   depth: the body-wide imagery keeps measured colour only in a band of a few km around land, which drew a
   halo around every island from orbit. Shelves and reefs shallower than that keep their imagery colour.
5. **CPU selection budget**: the per-frame selection is under 1 ms everywhere measured (p99 0.22-0.82 ms).
   Two frames in eight also run a request-only traversal for the streamer (2 s ahead, predicted impact),
   timed separately (`prefetchMs`). In the 60 s descent selection + prefetch had a p99 of 0.64 ms in the
   final run and of 0.77 and 1.04 ms in two earlier runs under heavier load from other agents' jobs (when
   both were still counted as selection). The perf spec asserts selection < 1 ms and selection + prefetch
   < 1.5 ms.
6. **Lab defaults**: 6 tile workers (load rules of this machine), a sky stand-in instead of the atmosphere
   (the lab loads the terrain feature alone), so the Earth views are more saturated and harder-edged than
   the game's.
7. **Material sets are procedural** (`tools/terrain/gen_materials.py`), not generated with the API keys: no
   key was used by this package and nothing was spent.

## 5. Requests

| Request | Outcome |
|---|---|
| `terrain-render-1` (bake reads land cover beyond its data: "incomplete" bakes at level >= 14) | resolved 37f6f54 |
| `terrain-render-2` (1.1 km needle in the Earth heights near the pad) | resolved b8ea6a7, data repaired; pad views re-rendered |
| `terrain-render-3` (blocky night-light cells) | declined: in the source; handled in the shader (section 3) |
| `terrain-render-cs-1` (from core-support: sea sheet missing near a low camera over deep ocean, water material at the seabed inside the near field, lines along sheet tile edges) | fixed in this package, see the request's resolution |

## 6. Tunables (`data/defs/render/<body>.surface.json`, all required)

`detailFadeDistanceM`, `detailScale0M/1M/2M` (Earth 0.73 / 5.3 / 37 m, Moon 0.67 / 4.7 / 33 m),
`detailBias1/2`, `detailAlbedoStrength`, `detailNormalStrength`, `detailHeightContrast`, `detailAoStrength`,
`detailChroma`, `macroNoiseWavelengthM`, `baseRoughness`, `toksvigGain`, `orbitalWavelengthM`,
`orbitalOctaves`, `orbitalAlbedoStrength`, `orbitalReliefStrength`, `slopeLo`, `slopeHi`, `freshAlbedoBoost`,
`nightLuminance`, `nightOnCos`, `nightOffCos`, `nightTintR/G/B`, `nightMinMip`, `nightClusterM`,
`nightClusterStrength`, `deepWaterSrgbR/G/B`, `deepWaterDepthM`, `apronRadiusM`, `apronEdgeM`, `lakeDepthM`,
`shoreWetnessHeightM`, `rockRangeM`, `rockMinPixels`, `rockAlbedoScale`, `rockRoughness`. A missing key is an
error at init. The lab overrides any of them with `p.<body>.<key>=<n>`.

Material sets (`set.json`): `materials[{ id, albedoHeight, normalRoughAo, meanAlbedo, meanRoughness,
heightGain }]`, `classWeights` (land-cover class -> material weights), `classOrbital`, `channelGain`,
`slopeGain`, `noiseGain`, `apronMaterial`, `rockMaterial`. Regenerate with
`python -I tools/terrain/gen_materials.py [--set <name>] [--size 512] [--preview]`.

## 7. Lab

`/labs/terrain/?...` (dev server). Besides the lab app's own parameters (`scene=`, `body=`/`lat=`/`lon=`/
`alt=`/`heading=`/`pitch=`, `orbit=`/`target=`, `fov=`, `ev=`, `perf=features`, `deterministic=1`):
`agl=<m>`, `sun=<az>,<el>`, `subsolar=<lat>,<lon>`, `sky=<lux>`, `magenta=1`, `silhouette=<m>`,
`nearfield=<start>,<end>`, `workers=<n>`, `delay=<ms>`, `rocks=0`, `morph=0`, `ballast=<iterations>`,
`hud=0`, `p.<body>.<key>=<n>`. `window.__terrain` (type `TerrainLab` in `labs/terrain/main.ts`) is the
handle of the specs: `placeCamera`, `setSun`, `setNearField`, `grab`, `referenceTile`, `surfaceMatch`,
`probeAltitude`, `flyPath`, `setBallast`. Every reviewed view is a lab URL: `viewUrl()` in
`tests/browser/terrain/views.ts`.

## 8. How to run and verify, and what was measured

```
npm run typecheck:paths -- src/render/terrain labs/terrain tests/browser/terrain tests/unit/terrain-render tools/terrain
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/terrain tests/unit/terrain-render      # 38 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain --project=functional   # 19 tests, 8 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain/terrain.perf.spec.ts --project=perf   # 7 tests, 8-13 min
TERRAIN_VIEWS=moon-standing,pad-* TERRAIN_QUERY="p.moon.rockAlbedoScale=1.2" ... views.spec.ts           # some views, A/B of a tunable
npx tsx tools/terrain/bench-select.ts                                                                     # selection alone, Node
```

| Acceptance criterion | Test | Result |
|---|---|---|
| Reviewed screenshots (24 views, 1920 x 1080, `out/screens/terrain/`) | `views.spec.ts` | all rendered and looked at, section 9 |
| No cracks or holes (magenta behind the silhouette, descents on both bodies) | `integrity`: "no cracks or holes" + marker control | 0 magenta pixels over 12 heights x 4 captures on each body, deepest levels 20 / 18 |
| LOD pops, 400 km -> 2 m on both bodies, Moon approach 20,000 -> 1,500 km, also with 500 ms delay | `pops.spec.ts` | 0 block spikes in all six runs; worst (block - floor) / local median 1.02 (Earth), 1.91 (Moon), 1.46 (approach); control without morphing: 12 spikes, worst 9.1 |
| Warp 50x at 200 km, 60 s | `terrain.perf`: warp | ground speed 367 km/s, cap 3.77, level 3 drawn; queue at most 2; 0 frames over 33 ms (largest 17.7 ms) |
| Image decode within 2/255, water mask exact | `integrity`: image tiles | 4 coastal level-12 tiles: largest difference 0 on land and water, 0 mask and land-cover differences |
| Near-field hand-over | `integrity`: ocean near field | near pixel: sea at 1.2 m -> seabed at -2201 m with the near field; sheet kept at 34.5 km; unchanged without it. Also core-support's `tests/browser/integration/water.spec.ts`, "without the ocean": 100.00 % sheet at 200 m, 3, 10, 14.2, 20 km over the open Atlantic, 0 thin dark pixels in the bare sheet |
| Surface match within 3 cm at 1,000 points | `integrity`: collision surface | 1,000 vertices of 22 (Earth) / 18 (Moon) deepest-level tiles: max 0.000 mm |
| No jitter at millimetre steps | `integrity`: millimetres | frame difference per 1 mm step: Earth median 0.382, max 0.393; Moon 0.199 / 0.234 (8-bit levels; a jittering vertex would show as spikes) |
| expectNoErrors | every spec | yes |

The pop detector works on the presented canvas at half resolution in 16 x 9 blocks. A block's
frame-to-frame difference is compared with the median of the same block over the surrounding frames: a
spike is a block whose difference, less a noise floor of 1.5 levels, is more than 2.5 times that median;
a block difference above 16 levels fails outright. The whole-frame mean differences stay at 2.1 (Earth),
1.8 (Moon), 0.4 (approach) levels per frame with maxima 3.4 / 7.6 / 3.6: the camera moves 0.5 % of its
height per frame, so the image itself changes that much. The control run with geomorphing and fade-ins
switched off shows what the detector sees when tiles do pop.

The hole test draws magenta behind everything on rays that hit the sphere 150 m below sea level (Earth) or
at the lowest elevation (Moon); on a failure it writes the capture to `out/screens/terrain/holes-*.png` and
names the box of the magenta pixels.

### 8.1 Performance (1440p internal, `withGpuLock`, GPU held at its working clock by a 7 ms ballast pass)

Each configuration is measured in three interleaved rounds and the smallest p99 / mean is taken (other
agents' browsers share the GPU; contention only adds time).

| View | G-buffer incl. far water (budget) | Shadows, amortised (budget) | Rocks (budget) | Selection CPU p99 |
|---|---|---|---|---|
| pad, 1.7 m | 0.51 ms (1.5) | 0.18 ms (0.5) | 0.00 (0.15), no rocks on the apron | 0.82 ms |
| 10 km | 0.59 ms (1.5) | 0.07 ms (0.5) | - | 0.51 ms |
| LEO, 400 km | 0.22 ms (1.5) | 0.07 ms (0.4) | - | 0.27 ms |
| lunar orbit, 100 km | 0.22 ms (1.8) | 0.05 ms (0.6) | - | 0.22 ms |
| lunar surface, 1.7 m | 0.49 ms (1.8) | 0.20 ms (0.6) | 0.20 ms (0.3), 15,534 instances, 459 k triangles | 0.51 ms |

(Final run, 7 of 7. The run before it, without two other perf specs on the GPU, gave 0.29 and 0.35 ms for
the G-buffer at the pad and at 10 km.)

60 s descent 60 km -> 30 m on the Moon: 3,600 frames, 0 over 33 ms (largest 21.6 ms); selection p99
0.56 ms (largest 0.83), with the prefetch passes 0.64 ms; 518 tiles uploaded, at most 7 in a frame, upload
time p99 1.78 ms (largest 2.40 ms; the loop stops before the tile that would pass 2 ms by its running
estimate); largest queue 29; deepest level 18; terrain pools 992 MiB.

CPU times come from an unfocused headless Chrome on a machine shared with other agents' jobs: the same
traversal (666 tiles, lunar surface) takes 0.13 ms in Node (`bench-select.ts`).

## 9. Screenshots (looked at)

`out/screens/terrain/`: `earth-400000km`, `earth-leo-pacific`, `earth-leo-hawaii`, `earth-leo-nadir-day`,
`earth-leo-nadir-day-2`, `earth-leo-nadir-night`, `earth-night-side`, `earth-40km`, `earth-10km`,
`pad-inland`, `pad-coast`, `shoreline-200m`, `earth-edge-5km`, `earth-edge-50km`, `moon-60000km`,
`moon-terminator-20000km`, `moon-terminator-5000km`, `moon-orbit-100km`, `moon-2km`, `moon-50m`,
`moon-standing`, `moon-standing-upsun`, `moon-edge-5km`, `moon-edge-50km`; `perf-*.png` at 1440p.

What holds up as a photograph: the Moon from 100 km at a 10 degree sun (wrinkle ridges, long crater
shadows), the lunar terminator views, the Earth from 10 km and 40 km (regional imagery over real relief),
the LEO nadir close-up by day (Sierra Nevada, Owens Valley) and by night (northern Italy: separate towns,
solid city centres, no tile seams), the Hawaiian islands from LEO.

## 10. Known weaknesses (plainly)

- **Pad apron** (`pad-inland`, `pad-coast`): the concrete is believable but plain; its largest stains read
  as painted-on when they fill the frame, and the far apron shows a faint repeat. The horizon behind it is
  the bare terrain without atmosphere in the lab.
- **Shoreline at 200 m**: the regional imagery is 9.5 m per texel; from 200 m the ground is that imagery
  magnified, with detail materials on top. It reads as terrain, not as a photograph of a lava coast; there is
  no surf (the ocean package's forward water takes over inside its near field in the game).
- **Lunar surface close-up**: the regolith and craters hold up; some rocks are still too rounded, and the
  rock population is the same six shapes at every site.
- **Mid-range softness**: at `terrainPxPerQuad` 8 the 256 x 256 imagery and normal maps of a tile are
  magnified up to 2x, visible as softness at 1-3 km above the Moon (`moon-2km`) and in LEO views below 1440p.
  The orbital detail hides it in albedo and relief but is noise, not data.
- **Night lights** are bounded by the 1.2 km cells of the source: below about 100 km altitude a town is a
  soft glow with grain, not streets.
- **Water colour**: deep water is one colour by construction (deviation 4); sediment plumes and plankton
  blooms over water deeper than 60 m are gone with the halo.
- **Enclosed basins below sea level** that the mask calls water (Dead Sea, Caspian depressions) get the sheet
  at sea level, above their real surface; not looked at.
- **Selection + prefetch** can pass 1 ms on prefetch frames during fast descents (deviation 5).
- `tests/browser/integration/water.spec.ts` (core-support's, still being written while this was run): "without
  the ocean" passes; "at fadeStart ... within 2 %" fails at 1,000 m altitude by 4.6 % (4.7 % with this
  package's previous near-field test, so not caused by the change of request cs-1; 6 km and 14 km agree
  within 0.5 %); "a shoreline from 200 m" finds the seabed within 0.7 m at its 46 points and fails on its foam
  ratio (0.081 on the waterline against 0.046 offshore, bound 2x). Whether the foam ratio depends on anything
  this package writes was not investigated.
