# Hand-off: terrain-render

The planet surfaces: a float64 cube-sphere quadtree per body with CDLOD geomorphing, tile streaming from
worker bakes into fixed GPU pools, G-buffer shading (imagery, detail materials in four scales, orbital
detail, night lights, shore), the far water sheet with the hand-over to the ocean's near field, shadows into
every cascade, and the rock field around the camera. Everything below was measured on the real baked tile
sets (`earth`, content hash `ab20fdfc579d4015`; `moon`).

This note is the state after the review fixes (section 10) and after round 1 of the visual close-out
(section 12: every item of the two critics' lists, what was done, what was not, measured performance).
Sections 1 to 7 describe the code as it is now; sections 8, 9 and 11 are the review-stage record and are
superseded by section 12 where they differ (performance of the final code: section 12, "Performance").

## 1. Where things are

| Path | What |
|---|---|
| `src/render/terrain/index.ts` | public API (section 2) |
| `feature.ts` | the `RenderFeature`: per-frame selection, prefetch, tile records, draw lists (nearest tile first), body uniform, G-buffer / shadow hooks, the optional rocks feature, debug API |
| `lod.ts` | `lodK`, `levelRange`, `morphWindow`, `morphFactor`, `fadeMorph`, `warpLevelCap`, `capMaxLevel`, `capMorph` (pure) |
| `tileMath.ts` | float64 tile frames, the vertex formula's twin, exact shell-patch distance, bounding spheres, `snapDirection` (pure) |
| `quadtree.ts` | `BodyQuadtree`: nodes, selection (`select`), shadow casters (`selectCasters`), bounds, horizon and frustum culling |
| `records.ts` | the tile record (image owners, uv transforms, tiling origins, imagery level at the corners, apron) |
| `gridMesh.ts` | the shared 65 x 65 grid with skirt ring, full tile and quadrant index ranges |
| `gpuPools.ts` | `LayerPool` (fixed texture arrays, free lists) and `BatchMipGenerator` (8 layers per pass) |
| `streamer.ts` | request queue, workers, upload budget, LRU eviction, pinning, statistics |
| `tileWorker.ts`, `workerProtocol.ts` | module worker: terrain-core bake + image decode + aux channels + night image |
| `nightImage.ts` | night-light textures with a border from the neighbouring tiles (pure) |
| `materials.ts` | surface tunables (`SURFACE_PARAM_KEYS`), material sets (`set.json` format 2), the noise volume, the material uniform |
| `lowResAlbedo.ts` | CPU lookup of `globals/albedoLowRes` (rock tint) |
| `rockMesh.ts`, `rocks.ts` | 12 rock shapes in 4 classes x 3 LODs (welded, broken-rock meshes), chunked instance lists, G-buffer and shadow draws |
| `sitePlan.ts` | the ground plan of a launch site from its structures: slabs, lane beds, gravel shoulder (pure; the twin of `siteGround` in the surface shader) |
| `cover.ts`, `coverMesh.ts` | ground cover: tussocks, scrub, trees, stands of trees, loose stones, placed by land-cover class around the camera and drawn instanced with shadows |
| `shaders/common.ts` | body uniform, `TileRecord` / `TileFrame`, the CDLOD vertex (`terrainVertex`), shadow pass |
| `shaders/surface.ts` | sampling, water logic, night lights, detail materials, orbital detail, `TERRAIN_GBUFFER_WGSL`, `TERRAIN_WATER_WGSL` |
| `shaders/lighting.ts` | this package's `brdf_terrain` and `brdf_regolith` chunks (section 3, "Relief shadows", "Regolith") |
| `data/defs/render/earth.surface.json`, `moon.surface.json` | every tunable (section 6) |
| `public/assets/terrain/<set>/` | material sets: per material and scale `<id>-<near|mid|far|aerial>.ah.webp` (albedo + height) and `.nra.webp` (normal xy, roughness, AO), `set.json`; 26.4 MiB on disk, 187 MiB on the GPU |
| `tools/terrain/photo_source.py` | source photographs of the Earth set from an image model (OpenAI key from `.env`, section 4) |
| `tools/terrain/gen_materials.py` | builds both sets: Earth from the photographs, Moon synthesised |
| `tools/terrain/bench-select.ts`, `probe-bake.ts`, `scan-spikes.ts` | selection benchmark in Node; evidence tools of requests 1 and 2 |
| `tools/terrain/probe-site.ts`, `bench-height.ts` | land-cover classes and water mask around a point as numbers; cost of height queries (the ground cover's placements) |
| `labs/terrain/` | the lab (section 7) |
| `tests/unit/terrain-render/` | 44 unit tests (the site ground plan and the cover meshes in `cover.test.ts`): LOD maths, crack-freedom by a float64 twin of the vertex shader (`cdlodTwin.ts`), selection, relief floor, sea-surface bounds, coverage, meshes, night images, tile records, the hexagon pattern by a twin of its shader code (`hexTwin.ts`) |
| `tests/browser/terrain/` | `smoke`, `views` (the reviewed screenshots), `integrated` (the pad surroundings in core-support's integration lab, with sky, atmosphere and ocean), `integrity`, `pops`, `terrain.perf` |

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
  cover?: boolean;                      // default true: the ground cover
  rocksSeparate?: boolean;              // default false: see below
}
interface TerrainFeature extends RenderFeature {
  readonly debug: TerrainDebug;
  readonly rocks: RenderFeature | null; // with rocksSeparate: the feature that draws the rock field
  readonly cover: RenderFeature | null; // with rocksSeparate: the feature that draws the ground cover
}
```

Use: `const terrain = createTerrainFeature(renderer.context, () => theAuthorityTheSimUses); await renderer.addFeature(terrain);`
The factory must return the SAME height authority the simulation collides with: the mesh at the deepest level
is its surface (verified to 0.000 mm, section 8). `init` loads the manifests, material sets and the six root
tiles of every body with `BodyDef.terrain`; `isIdle()` is true when nothing is queued, loading, uploading or
fading.

`rocksSeparate: true` leaves the rock draws to a companion feature (`terrain.rocks`, id `<id>-rocks`, add it
after the terrain): with the renderer's performance attribution every feature's hooks are passes of their
own, so the rocks' cost is measured directly (`terrain-rocks.gbuffer`, `terrain-rocks.shadow`). The app
does not need it; the lab sets it with `perf=features`. The ground cover is separated the same way
(`terrain.cover`, id `<id>-cover`, passes `terrain-cover.gbuffer` / `.shadow`).

`TerrainDebug` (tests and labs only): `stats()` (`stream: StreamStats`, per-body `TerrainBodyStats`, `records`,
`instances`, `selectMs`, `prefetchMs`, `cpu` = main-thread ms of the last frame: `hooks` (everything), and its
parts `stream`, `upload`, `build`, `rocks`, `cover`, `shadow`, `gbuffer`; `materialBytes`, `rocks`, `cover`), `setStreamDelay(ms)`,
`setMorphEnabled(on)`, `setRocksEnabled(on)`, `setCoverEnabled(on)`, `provider()`, `readyTiles(body, level, lat, lon, limit)`,
`readyTileAt(body, lat, lon, maxLevel?)`, `readTile(body, key) -> { heights, albedo, aux, normal }`, `bodies()`.

Also exported: `DEFAULT_STREAMER_OPTIONS`, `SURFACE_PARAM_KEYS`, types `StreamerOptions`, `StreamStats`,
`TerrainBodyStats`, `TerrainProviderFactory`, `MaterialSetManifest`, `SurfaceParamKey`, `SurfaceParams`.

Reads from the frame: `frame.bodies` (poses, sun), `frame.observers` (LOD observers: the active vessel
refines the ground under it), `frame.snapshot.patches.current[].markers` (kind `impact`: prefetch),
`ctx.quality.terrainPxPerQuad`, the shared resource `'ocean.nearField'`. Publishes nothing. Perf labels:
GPU `terrain.gbuffer`, `terrain.shadow`, `terrain.mipgen`; CPU `terrain.select`, `terrain.stream`; counters
`terrain.tiles`, `terrain.queue`.

Five things the feature does to shared state, within what RENDER_API allows (RENDER_API section 6 describes
the G-buffer channels since request `terrain-render-4`):
- It registers the shader chunk `brdf_regolith` (an override of the render core's default) when a body with
  `brdf: 'hapke'` has terrain, and `brdf_terrain` when a body with another BRDF has (`shaders/lighting.ts`).
- For `MATERIAL_TERRAIN` and `MATERIAL_REGOLITH` it writes into G-buffer RT4.b (clear-coat weight, unused by
  these materials; the lighting pass hands it to every BRDF as `s.clearcoat`) the share of the sun that
  relief below the mesh keeps off the pixel; its two BRDF chunks multiply the direct light by one minus it.
  Any other writer of these materials leaves 0 there and gets the default behaviour exactly.
- For `MATERIAL_REGOLITH` it writes into the G-buffer's metallic channel 2 x the RMS slope of the facets
  within the pixel (regolith has no metal). Any other writer of that material leaves 0 there and gets the
  default behaviour exactly.
- For both materials it writes into RT4.a the smallest filter radius of the sun-shadow lookup
  (`encodeShadowSoftness`, render core, request `terrain-render-4`): one render quad of the tile's level, from
  160 m of the eye outwards (0 within 40 m). The terrain casts from its own tiles, so a crater rim's shadow on
  its floor is drawn by quads of that size; filtered over one quad its edge is the rim's curve, not the
  polygon.

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

**Relief floor.** Within 16 body radii (`RELIEF_RADII`, the distance at which level 3 is loaded ahead) the
level ranges have a floor: `range(3) = 16 R`, `range(2) = 32 R`, `range(1) = 64 R` (`ReliefFloor` in
`lod.ts`). The whole near side is then level 3 however small the body is on screen (Moon: 5.3 km quads,
Earth: 19.5 km), morphing in like any other level. The reason is the shadows: every cascade casts from the
tiles the camera selection draws (casters and receivers must have the same geometry), and a level-0 mesh has
no craters. Beyond 16 radii and closer than the ordinary range of level 3 nothing changes.

**Morph.** `k = clamp((d / range(l) - m0) / (m1 - m0))`, `m0 = clamp(0.5 + 0.5/K, 0.7, 0.9)`,
`m1 = max(0.95, m0 + 0.08)`: the coarser side of every LOD border is unmorphed, the finer side is fully the
parent's geometry. Odd vertices slide to an even neighbour in a direction fixed per cube face
(`snapDirection`), so half-morphed edges agree across cube edges. A tile that enters the selection starts
fully morphed and relaxes over 0.35 s on the feature's own clock (0.12 s for 3 s after a camera cut, 0 on the
cut frame). The sheet morphs by the distance to the TERRAIN vertex, like the terrain. Warp: with ground
speed v per wall-clock second, `c = log2(faceSize / (2 v))`; levels deeper than `floor(c)` are not drawn and
level `floor(c)` morphs out as `c` falls.

**Records and draw order.** A resident tile has one slot in two storage buffers, its layer in the height
pool. `TileRecord` (272 bytes: frame, layers, uv transforms, tiling origins, apron, flags) is written once,
when the tile is first drawn; `TileFrame` (32 bytes: origin relative to the camera now and a frame ago, the
forced morph, 1 / range) is written every frame for the tiles in use, as one contiguous range. Nothing is
allocated per tile per frame. A tile's record is built with its parent's image owners resolved, also when
the parent has never been drawn itself (a camera cut onto resident tiles draws children first). The visible
tiles are drawn nearest first (one numeric sort of at most a few hundred keys): on broken ground seen from
eye height a pixel is covered by several hills, and the depth test spares the fragment shader all but the
first (terrain G-buffer at the stony site: 2.1 ms unsorted, 0.9 ms sorted, measured before the triplanar
planes followed the terrain normal, which costs about 0.4 ms there).

**Streaming.** One job per worker at a time: `prepareTile` + `bakeTile` of terrain-core (65 x 65 heights,
256 x 256 normal/material), the albedo `ImageBitmap` (decode options of ARCHITECTURE section 1), the aux
image (water mask, land cover) and the night image. Priorities = range / distance (x 4 near a vessel
observer, x 0.25 in the guard band, x 0.3 / 0.2 for prefetch passes); a request not wanted for 12 frames is
dropped; a job in flight is discarded on arrival if nobody wants it. Uploads stop at 8 tiles or when the
running estimate (with a margin of a quarter) says the next tile would pass 2 ms. Pools (allocated once
under OOM scopes): heights r32float 65^2 x 1280, normals rgba8 256^2 + mips x 1280, albedo rgba8-srgb + mips
x 1024, aux rg8 + mips x 1024, night r8 258^2 + mips x 1024: 1.02 GiB. Eviction is LRU among tiles untouched
for 90 frames; ancestors of drawn tiles and levels 0..2 are never evicted. Night images belong to tiles of
levels 0..5, which almost always have resident children and cannot be evicted: 472 of the 1024 layers are in
use in low Earth orbit. A tile that finds the night pool full goes up without its lights
(`StreamStats.nightDropped`, asserted 0 by `views.spec.ts`).

**Water.** The sheet is drawn first (same tiles, vertices on the sea sphere, depth = the seabed's). It
discards where the mask says land (while the mask is finer than the geometry: `influence =
saturate(imageLevel + 3 - (level - k))`), where no water is near (mask mip 5 < 0.004) and inside
`'ocean.nearField'.fadeStart` of the camera's body. The terrain fragment writes water itself for lakes and
rivers above sea level and for coastal pixels the mask calls water; inside the near field (tested where the
pixel's ray meets the sea surface, not at the fragment) it never does: the G-buffer there holds the seabed.
Water albedo is the imagery colour, going to the imagery's open-ocean colour with depth
(`deepWaterSrgb*`, `deepWaterDepthM`). The mask is reconstructed with a cubic B-spline once it is magnified
(lake and island outlines are smooth curves, not texel steps). Where the mask says land but the body-wide
imagery holds its open-ocean fill colour (islets, a rim of every coast: the imagery's coastline is coarser),
the fragment is water if the texels around it are fill too, and otherwise takes the brightest neighbouring
texel: no dark rings and specks along coasts.

**Detail materials.** A material has four texture layers with different content, tiled at 2 m (near,
1024 px), 14 m (mid), 110 m (far) and 900 m (aerial, 512 px each): grains and pebbles; stones, tufts,
cracks; patches, bushes, small craters; thickets, gullies, flow fronts, craters. Each is shown while one
repeat spans more than 8 to 24 pixels and until one of its texels spans 16 to 64 pixels; every fade is by
size on screen, never by tile level. Colour = imagery x product of (layer albedo / layer mean); for the far
and aerial layers the mean is the layer's own average over one imagery texel, so only what is finer than the
imagery is added. Repetition is hidden by a hexagon pattern (`detailPlane`): the plane is covered by a
triangle lattice of half a tiling length, every lattice vertex shows the layer at its own random offset and
rotation ABOUT THAT VERTEX, and a pixel blends the three copies of its triangle with sharpened weights and
a height term from `set.json` `hexBlend` (Earth: the higher surface wins, stones stay whole; Moon: whatever
stands out from the mean wins, pits and stones stay whole). The pattern has a period of 64 tiling lengths and
tile origins are kept modulo that, so 32-bit plane coordinates stay small; rotating about the vertex is what
makes two tiles with origins a whole period apart agree along their common edge (`hex.test.ts`). The planes
are triplanar in body-fixed axes with weights from the terrain's own normal (nothing is stretched down a
slope); a plane or copy with a small share is not sampled and its share goes to zero continuously. Material
weights come from land cover, the bake's material channel, slope, macro noise and the colour of the imagery
(`albedoGain`: grey ground is rock or sand, saturated brown is soil, green is grass). The second material is
sampled only where it has more than a quarter of the two weights, and shows first where its summed height
(in units of each layer's range) stands higher. At shallow angles the long axis of the footprint is
shortened by up to a half, so the layers are sampled one mip level finer than the sampler's 16 taps would
give. The relief of the far and aerial layers gives way where the tile's own normal map resolves their sizes
by the share `terrainRelief` (Moon 1: craters are in the height function too; Earth 0.25: bushes are not).

**Ground colour.** Imagery is a picture, not an albedo map: the regional mosaic of the launch region is
graded dark and saturated (median luminance 0.03, median saturation 0.8, lava fields included). Where the
imagery is finer than the body-wide mosaic (`imageryCalibrationLevel`; -1 = everywhere) it keeps
`imagerySaturation` of its saturation, and the ground takes the albedo of the material it is made of
(`set.json` `anchorAlbedo`, default the material's mean) times the imagery's luminance relative to
`imageryRefLuminance`, to the power `imageryContrast`, bounded to 0.6 .. 1.3: by the share `anchorNear` where
a pixel is finer than the imagery, `anchorFar` where it is coarser. The share the imagery keeps is bounded
in luminance to 1.6 times the material's (on a body with `anchorNear` > 0): the mosaic paints a strip along
this coast cream (sRGB 211, 180, 125), which was three times as bright as the sea beside it. So lava is charcoal, dry grass olive and
the concrete 3 to 4 times brighter than either, at every distance, and the imagery still decides where the
ground is lighter or darker. Material weights: land-cover class, the bake's channel, slope (steep ground is
clinker), macro noise, darkness and greenness of the imagery (`albedoGain`; its saturation is no longer
used), and `shoreGain` on low, level ground at the water's edge (black sand). The class lookup is displaced
by the same band-limited noise as the imagery and by octaves of 45, 14 and 5 m (each only where the pixel
resolves it), and its weights are sharpened where a class texel spans more than a few pixels (bilinear
where it spans fewer: sharpened there the raster drew a staircase): a class boundary is a ragged line.
Built-up cells of the land cover are dirt and cinder (`scrub-soil`, `black-sand`), never concrete: on this
coast they are tracks and yards, and as concrete they were stray white cells. A material keeps `chroma` of its texture's colour variation (rock is grey), and what stands above a
layer's mean can be glossier (`gloss`: the crests of ropy lava; near and mid layers only, the far layer's
swells as gloss were sky-mirroring patches tens of metres wide). The terrain BRDF uses a reflectance of 0.04
(rock and glass), not water's 0.02.

**Launch site.** `sitePlan.ts` derives a ground plan from `LaunchSiteDef.structures` by the names of their
footprint parameters (never by model id): `halfX`/`halfZ` and `sizeX`/`sizeZ` are concrete slabs (plus
`apronMarginM`, rounded corners), `length` with `trackWidth` a gravel lane bed; a site without slabs gets
one square of `apronRadiusM`. The material uniform holds up to 4 sites with 24 shapes; the fragment shader
evaluates signed distances (`siteGround`, the twin of the TypeScript function the ground cover uses).
Concrete has its own absolute albedo, a kerb one pixel wide at any distance, bays of `apronJointM` with
box-filtered joints, a tone per bay, dirt along joints, stains, scorch towards the pad centre; around it a
shoulder of compacted gravel (`gravelMaterial` layers with `gravelAlbedo*`, `apronShoulderM` wide, ragged
outer edge, worn pale towards the kerb). Nothing of the ground cover stands on the plan.

**Ground cover.** `cover.ts`: kinds of cover from `set.json` `cover` (Earth: `tussock`, `scrub`, `kiawe`,
`stand`, `clinker`; the Moon has none). A kind lives in chunks (cube-sphere tiles of about its `chunkM`);
a chunk scatters candidates by hash over its own tile for the densest class under it, keeps each with the
density of its own class times a clumping noise fixed to the ground, never on a site's plan (and thinning
out over the 12 m beside it), never below sea level + 0.6 m, and stands it on `heightAt(dir, lambdaMin =
max(0.4, radius))` (0.003 ms per query, `bench-height.ts`). Land-cover classes come from the body's deepest
`landcover` tiles, fetched and decoded on the main thread as chunks need them. Instances are stored by
variant, largest first; the lists per (shape, variant, level of detail) are prefixes by size, split
instance by instance in the chunks around the camera. An instance is drawn within radius x range-per-radius
(`minPixels`), at most `rangeM`, grows from nothing over the outer 30 % and, for a kind with `nearM`, from
0.7 `nearM` to `nearM` (stands of trees take over where single trees have shrunk away, 1.3 to 1.8 km).
Chunks are built within 0.5 ms per frame, in view first; a chunk built in view fades in over 0.5 s;
`isIdle()` waits for both. The G-buffer instance lists (indices sorted into buckets by shape, variant and
level of detail, some hundred thousand in thick cover) are kept between frames while the eye stands within
2 cm, the pixel scale is the same and a signature of the listed chunks (slot, record base, visibility, list
ends) is unchanged; only the chunk rows (relative to the camera) are written every frame. A moving camera
rebuilds them every frame (0.5-0.9 ms of main thread in the thickets, under load). Records are appended to one GPU buffer (524,288 instances; holes are closed when
its end is reached). Shadows: every cascade whose texel is at most the instance's diameter, from the
coarsest mesh (the middle one from 24 texels across, the finest from 96: a crown near the eye cast a few
large polygons with the coarser ones). Meshes (`coverMesh.ts`): tussocks of 46 / 18 / 8 blades
(nested levels); crowns of leaf clusters ("puffs": flattened octahedra, 230 / 60 / 14 per unit crown) whose
normals lean away from the crown's middle, with fine gaps cut by noise when large on screen; four crowns on
stems for a tree, eight without stems for a stand; loose stones are rock meshes without the banked foot.
Grass bends with `windToDeg` / `windLean`; scrub and trees are turned downwind. Nothing of it collides.

**Relief shadows.** The detail layers' height maps cast shadows: on the triplanar plane that carries most
of a pixel, the copy of the hexagon pattern that dominates it is marched towards the sun (4 taps, 1.5 to 33
texels, each from a mip level coarser: a cone), for every detail scale that shows, while the sun stands lower
than about 40 degrees over the terrain's own normal. What stands above the ray shadows the pixel
(`reliefShadow` = strength). The result goes to RT4.b (section 2). The shade inside a tussock or a crown
uses the same channel.

**Regolith.** `shaders/lighting.ts` replaces the core's `brdf_regolith`: the same Hapke function, but a
pixel is not switched off when its normal turns from the sun. With facet slopes normally distributed about
the pixel's normal with RMS sigma (the G-buffer's metallic channel / 2, written by the terrain and rock
shaders from the screen derivatives of the final normal), the lit fraction is Phi(mu0 / sigma) and the lit
facets' mean cosine of incidence is mu0 + sigma phi / Phi. Under a low sun a detail normal map that flips
between lit and black from pixel to pixel is then a grey of the right mean; resolved slopes (sigma near 0)
keep their hard shadows. In addition the terrain shader lets the detail normals give way as the terrain's own
normal reaches the terminator (cosine -0.02 to 0.1): without a sky nothing lights a slope the sun has set
on, and normal-map relief would still light single pixels of it. The slopes it takes out go into sigma
(their squared magnitude is added to the variance), so a hillside at the terminator is a grey of lit and
shaded grains that darkens smoothly, not black specks. Regolith is rough at every size a pixel
holds: sigma has a floor of 3 degrees. Its ambient term adds the light bounced off the sunlit ground (an
airless body has no sky): the sun's illuminance on level ground times `bounceFlat` (0.28) for level ground in
a shadow, rising with (1 - n . up) / 2 to `bounceDown` (0.36) for a face that looks straight down; constants
of the chunk (`DEFAULT_REGOLITH_LIGHT`).

**Night lights.** Read `nightMinMip` levels above the night layer's deepest level (Earth: level 5, 1.2 km
texels: the source's cells are coarser than the layer's texels), from textures that carry one border texel
of the neighbouring tiles (same face or across a cube edge), reconstructed with a cubic B-spline when
magnified, with a shoulder for saturated city centres and ground-fixed grain below the layer's resolution
(`nightClusterM`, `nightClusterStrength`). One channel (the red of the night image) times `nightTint*`.

**Rocks.** Chunks of about 40 m (cube-sphere tiles) hold `rocksNear` of terrain-core sorted by shape and
radius (never below `rockMinRadiusM`); a rock is drawn within `radius x rangePerRadius` (at most
`rockRangeM`), grows in over the outer 30 % of its range, LOD by size on screen, tint from the
low-resolution albedo map (where the ground colour is anchored to its materials: from the rock material's
own albedo), the set's `rockMaterial` triplanar in the rock's own axes, tiled at nine times the rock's
radius. Meshes: a welded sphere of directions (1280 / 320 / 80 triangles) pushed out to one of 12 convex
polyhedra in 4 classes (blocks, slabs, wedges, boulders), worn, then broken: scoops where pieces spalled off
(the solid is not convex), a crack, ridged lumps, a foot that flares 8 % where soil is banked against it
(vertex soil share; the shader colours it as soil, higher in the hollows of the face). The unit ball stays
inside (the collision cap). Wear: 10 % of the stand-off on blocks, slabs and wedges, 30 % on boulders (edges
stay sharp). Shading is the smooth vertex normal with 30 % of the triangle's own normal (with 70 %, as
before, the tessellation showed as a net of facets near the eye), the material's grain at full contrast and
its normal map at 1.5 times its slopes; level faces on the Moon carry a 30 % dust film. Instance lists are prefixes of each
chunk's rocks: only rocks large enough for a finer LOD, and the chunks within 80 m, are looked at one by one;
the vertex shader applies range and scale exactly. The G-buffer lists are kept between frames until an
observer has moved 2 cm, a chunk has changed or the pixel scale has; shadow lists are prefixes of the same
prefixes.

## 4. Deviations from the brief (and why)

1. **Levels 0-2 are always resident; level 3 is loaded ahead and drawn** for a body within 16 radii (brief:
   levels 0-3 always resident). With both bodies pinned to level 3 (768 tiles) the image pool ran out at
   10 km / 1440p. A cut to anywhere still starts from level 2 or 3.
1a. **Shadow casters are the camera selection** (plus resident tiles outside the view, down to the level
   matching the cascade's texels), not tiles chosen per cascade: a caster finer than its receiver shadows
   the receiver. The whole-body cascade (1.9 km texels on the Moon) therefore casts from level 3 (5.3 km
   quads) between 16 radii and the ordinary range of level 3: craters under about 20 km cast nothing at the
   terminator from afar. Finer shadows there would need level-4 tiles loaded and drawn for the terminator
   band only (768 more tiles than the pools hold for the whole disc); not done.
2. **`createTerrainFeature` has a third, optional `options` parameter** (pool sizes, pin levels, rocks).
3. **Night lights are one channel with a per-body tint, sampled at level 5 with a border**, not the RGB
   image at its deepest level: the RGB pool was exhausted by pinned tiles, the source's cells are 2-4 texels
   wide at level 7 (request 3, declined: they are in the source), and per-tile filtering cut every light at
   a tile edge.
4. **Deep water takes one colour** (the imagery's own open-ocean fill, sRGB 2/5/20) from 5 m to 60 m of
   depth: the body-wide imagery keeps measured colour only in a band of a few km around land, which drew a
   halo around every island from orbit. Shelves and reefs shallower than that keep their imagery colour.
5. **Detail materials have four scales**, not three (near, mid, far, aerial), and their own content per
   scale: the reviewer's blocker was the same texture magnified.
6. **Lab defaults**: 6 tile workers (load rules of this machine), a sky stand-in instead of the atmosphere
   (the lab loads the terrain feature alone), so the Earth views of `views.spec.ts` are harder-edged than the
   game's; `integrated.spec.ts` renders the pad surroundings with sky, atmosphere and ocean.
7. **The Earth material set is photographic and generated**: 24 square top-down photographs (6 materials x 4
   ground sizes) from OpenAI's image model `gpt-image-2` (1024 px, quality high, about 7,200 tokens each,
   173,000 in all; the spend was not metered by this package, a few US dollars of the 100 allowed).
   `gen_materials.py` removes their large-scale shading, makes them tile (minimum-error seams, two
   frequency bands), sets physically plausible mean albedos and derives height, normal, roughness and AO
   from luminance bands. The photographs live in `data/cache/terrain/photo/` and are not committed: a
   rebuild of the Earth textures without them generates new ones (same prompts, different pictures). The
   lunar set is synthesised (photographs of the lunar surface carry the hard shadows of one sun direction).
8. **CPU budget**: the perf spec asserts the feature's whole main-thread time without tile uploads (p99 of
   200 frames) under 1 ms, not only the selection. Under other agents' load single runs exceed it
   (section 8.1).
9. **Rocks at the pad**: until request `terrain-render-6` the flattened pad disc held no rocks; with the site's
   shape (1581cf9) rocks lie outside the flat core and areas (145 in the pad view, 0.004 ms against 0.15). The cost of rocks on Earth is measured on the densest rock field near the site
   and held to the 0.3 ms of the lunar line. Earth draws rocks to 200 m and from 5 pixels (Moon: 250 m,
   3 pixels).

## 5. Requests

| Request | Outcome |
|---|---|
| `terrain-render-1` (bake reads land cover beyond its data: "incomplete" bakes at level >= 14) | resolved 37f6f54 |
| `terrain-render-2` (1.1 km needle in the Earth heights near the pad) | resolved b8ea6a7, data repaired; pad views re-rendered |
| `terrain-render-3` (blocky night-light cells) | declined: in the source; handled in the shader (section 3) |
| `terrain-render-cs-1` (from core-support: sea sheet missing near a low camera over deep ocean, water material at the seabed inside the near field, lines along sheet tile edges) | resolved d43e8fd, see the request's resolution |
| `terrain-render-4` (sun-shadow filter at least a caster quad wide for terrain pixels: gear-tooth crater shadows from orbit) | resolved c417fb0 (RT4.a, `encodeShadowSoftness`); used by the terrain shader since round 1 (section 2) |
| `terrain-render-5` (strips of different exposure and a blue cast in the regional lunar imagery) | declined in part: the cast is gone with the colour step of sky-lighting-6 (81a26d0); the strip steps stay (a re-bake of the WAC mosaic, listed for the lead). The shader keeps 40 % of the lunar imagery's saturation |
| `terrain-render-6` (the site flattens a 450 m disc: a perfect plane with a circular edge) | resolved 1581cf9 (`pad.shape`: exactly flat core of 115 m and areas under the structures, a quarter of the natural relief elsewhere inside 450 m, ragged blends); `pad-off-apron` and `integrated-off-apron-eye` re-shot on it. `sitePlan.ts` does not read `pad.shape.areas` (its slabs come from the structures' footprints, which the areas follow) |
| `terrain-render-7` (dark tile-shaped region by the shore with ocean and atmosphere) | withdrawn: the cloud shadow map's staircase, removed by atmosphere-clouds in 6587a0d |
| `terrain-render-cs-2` (from core-support: no crater shadows at the lunar terminator from 20,000 and 5,000 km, a shadow step at 1,500 km on approach) | resolved d3bac0a and closed by the filer (25b92c5, its bound lowered from 0.4 % to 0.2 % of the lit pixels): the relief floor gives the terminator its shadows. `tests/browser/integration/shadows.spec.ts -g "terminator|approach"` on the final code of this package: 3 of 3, 0.53 % of the lit pixels in a terrain shadow at 5,000 km and 0.36 % at 20,000 km (0.45 % and 0.31 % in the reviewer's run, before the regolith BRDF of section 3), no shadow pop on the approach through 1,500 km |

Against this package's paths: `vehicle-pad-3` (the apron disc) resolved by the site ground plan (item 1 in
part declined, see its resolution); `map-view-6` names the Moon's far field among three owners: the terrain's
part is answered in its resolution section (the request stays open for the clouds and the stars).

## 6. Tunables (`data/defs/render/<body>.surface.json`, all required)

`detailFadeDistanceM`, `detailScale0M/1M/2M/3M` (2 / 14 / 110 / 900 m on both bodies: the ground sizes the
layers were made for), `detailAlbedoStrength`, `detailNormalStrength`, `detailHeightContrast` (per layer
height range), `detailAoStrength`, `detailChroma`, `macroNoiseWavelengthM`, `baseRoughness`, `toksvigGain`,
`orbitalWavelengthM`, `orbitalOctaves`, `orbitalAlbedoStrength`, `orbitalReliefStrength`, `slopeLo`,
`slopeHi`, `freshAlbedoBoost`, `nightLuminance`, `nightOnCos`, `nightOffCos`, `nightTintR/G/B`, `nightMinMip`,
`nightClusterM`, `nightClusterStrength`, `deepWaterSrgbR/G/B`, `deepWaterDepthM`, `apronRadiusM`,
`apronMarginM`, `apronJointM`, `apronShoulderM`, `gravelAlbedoR/G/B`, `imageryCalibrationLevel`,
`imagerySaturation`, `imageryRefLuminance`, `imageryContrast`, `anchorNear`, `anchorFar`, `reliefShadow`,
`shoreReachM`, `lakeDepthM`, `shoreWetnessHeightM`, `rockRangeM`, `rockMinPixels`, `rockMinRadiusM`,
`rockAlbedoScale`, `rockRoughness`. A missing key is an error at init. The lab overrides any of them with
`p.<body>.<key>=<n>`.

Material sets (`set.json`, `formatVersion: 2`): `nearSize`, `wideSize`, `scalesM`, `materials[{ id,
layers[4]{ albedoHeight, normalRoughAo, meanAlbedo, meanRoughness, reliefM, meanHeight } }]`, `classWeights`
(land-cover class -> material weights), `classOrbital`, `channelGain`, `slopeGain`, `noiseGain`,
`albedoGain` (per material: weight per unit of the imagery's darkness, saturation, greenness), `shoreGain`,
`gloss`, `anchorAlbedo`, `chroma`, `hexBlend`, `terrainRelief`, `cover` (kinds and densities per land-cover
class, or null), `apronMaterial`, `gravelMaterial`, `rockMaterial`. At most 8 materials, 6 kinds of cover. Rebuild:
`python -I tools/terrain/photo_source.py [--only <id>,...]` (only when a photograph is missing), then
`node tools/dev/heavy.mjs --class=bake -- python -I tools/terrain/gen_materials.py [--set <name>] [--preview]`
(4 min per set; `--manifest-only` rewrites the weights and gains of `set.json` and keeps the textures).

## 7. Lab

`/labs/terrain/?...` (dev server). Besides the lab app's own parameters (`scene=`, `body=`/`lat=`/`lon=`/
`alt=`/`heading=`/`pitch=`, `orbit=`/`target=`, `fov=`, `ev=`, `perf=features`, `deterministic=1`):
`agl=<m>`, `sun=<az>,<el>`, `subsolar=<lat>,<lon>`, `sky=<lux>`, `magenta=1`, `silhouette=<m>`,
`nearfield=<start>,<end>`, `workers=<n>`, `delay=<ms>`, `rocks=0`, `cover=0`, `morph=0`, `ballast=<iterations>`,
`hud=0`, `p.<body>.<key>=<n>`. With `perf=features` the rocks are a feature of their own (section 2).
`window.__terrain` (type `TerrainLab` in `labs/terrain/main.ts`) is the handle of the specs: `placeCamera`,
`setSun`, `setNearField`, `grab`, `referenceTile`, `surfaceMatch`, `probeAltitude`, `flyPath`, `setBallast`,
`cameraSubPoint`, `vesselSubPoint`. Every reviewed view is a lab URL: `viewUrl()` in
`tests/browser/terrain/views.ts`.

## 8. How to run and verify, and what was measured

```
npm run typecheck:paths -- src/render/terrain labs/terrain tests/browser/terrain tests/unit/terrain-render tools/terrain
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/terrain tests/unit/terrain-render      # 38 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain --project=functional   # 20 tests, 10 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain/terrain.perf.spec.ts --project=perf   # 10 tests, 13 min
TERRAIN_VIEWS=moon-standing,pad-* TERRAIN_QUERY="p.moon.rockAlbedoScale=1.2" ... views.spec.ts           # some views, A/B of a tunable
npx tsx tools/terrain/bench-select.ts                                                                     # selection alone, Node
```

| Acceptance criterion | Test | Result |
|---|---|---|
| Reviewed screenshots (33 views, 1920 x 1080, `out/screens/terrain/`) | `views.spec.ts`, `integrated.spec.ts` | all rendered and looked at, section 9 |
| No cracks or holes (magenta behind the silhouette, descents on both bodies) | `integrity`: "no cracks or holes" + marker control | 0 magenta pixels over 12 heights x 4 captures on each body, deepest levels 20 / 18 |
| LOD pops, 400 km -> 2 m on both bodies, Moon approach 20,000 -> 400 km, also with 500 ms delay | `pops.spec.ts` | 0 block spikes in all six runs; worst (block - floor) / local median 1.00 (Earth), 1.93 (Moon), 1.11 (approach); control without morphing: 6 to 10 spikes in 5 to 8 frames, worst 3.9 to 4.8 |
| Warp at 200 km: 5x, 10x (20 s each), 50x for 60 s | `terrain.perf`: warp | 5x: cap 7.09, queue at most 4, 119 tiles uploaded; 10x: cap 6.09, queue at most 6, 169 uploaded; 50x: ground speed 367 km/s, cap 3.77, level 3 drawn, at least 5 tiles in view, queue at most 3; 0 frames over 33 ms in all three (largest 17-20 ms); day-side screenshots |
| Image decode within 2/255, water mask exact | `integrity`: image tiles | 4 coastal level-12 tiles: largest difference 0 on land and water, 0 mask and land-cover differences |
| Near-field hand-over | `integrity`: ocean near field | near pixel: sea at 1.6 m -> seabed at -2197 m with the near field; far pixel (34.6 km) unchanged; the picture without the near field is the one from before |
| Surface match within 3 cm at 1,000 points | `integrity`: collision surface | 1,000 vertices of 22 (Earth) / 18 (Moon) deepest-level tiles: max 0.000 mm |
| No jitter at millimetre steps | `integrity`: millimetres | frame difference per 1 mm step: Earth median 0.75, max 0.85; Moon 1.37 / 1.53 (8-bit levels; a jittering vertex would show as steps that stand out: the largest step is within 1.5 x the median) |
| expectNoErrors | every spec | yes |

The pop detector works on the presented canvas at half resolution in 16 x 9 blocks. A block's
frame-to-frame difference is compared with the median of the same block over the surrounding frames: a
spike is a block whose difference, less a noise floor of 1.5 levels, is more than 2.5 times that median;
a block difference above 16 levels fails outright. A frame is judged where it has ten frames on each side
(a fade-in that begins in the last frames of a path is twenty frames of small steps, of which the path
shows the first two: with the approach ending at 450 km those two were counted as pops; flown on to 400 km
the same frames have both sides and nothing stands out). The whole-frame mean differences stay at 3.4
(Earth), 3.5 (Moon), 1.8 (approach) levels per frame with maxima 4.8 / 7.3 / 8.8: the camera moves 0.5 % of
its height per frame, so the image itself changes that much (more than with the first, smoother material
sets: the ground has grain now). The control run with geomorphing and fade-ins switched off shows what the
detector sees when tiles do pop. The approach path crosses the hand-over from the whole-body shadow cascade
to the camera-fitted cascades (about 1,500 km) and the first level change below the relief floor (level 3
to 4 at about 650 km at the spec's render height); the spec asserts that the deepest level changes along
every path.

The jitter bound on the median was 1 level and is 2 now: with the near detail layer (2 mm texels) under the
11 degree sun of the lunar site a third of a pixel of camera motion changes the image by 1.4 levels on
average. The criterion that detects vertex jitter (no step stands out) is unchanged.

The hole test draws magenta behind everything on rays that hit the sphere 150 m below sea level (Earth) or
at the lowest elevation (Moon); on a failure it writes the capture to `out/screens/terrain/holes-*.png` and
names the box of the magenta pixels.

### 8.1 Performance (1440p internal, `withGpuLock`, GPU held at its working clock by a 7 ms ballast pass)

Each view is measured in three interleaved rounds (up to three more while a line is over its budget) and
the smallest p99 / mean is taken: other agents' browsers share the GPU and the cores while this runs, and
contention only adds time. The numbers below are provisional in the sense of PACKAGE_RULES 16: they were
taken with three to five other agents' GPU jobs running.

| View | Terrain G-buffer incl. far water, p99 (budget) | Terrain shadows, amortised (budget) | Rocks, G-buffer p99 + shadows (budget) | Main thread without uploads, p99 / median (budget 1) | Selection p99 |
|---|---|---|---|---|---|
| pad, 1.7 m | 0.59 ms (1.5) | 0.18 ms (0.5) | 0 (0.15): no rocks on the pad disc | 1.02 / 0.55 ms in the full run (over); 0.65 / 0.34 ms alone | 0.66 ms; 0.44 alone |
| stony ground 1 km from the pad, 1.7 m | 1.33 ms (1.5) | 0.27 ms (0.5) | 0.11 ms (0.3): 400 k triangles | 0.94 / 0.52 ms | 0.57 ms |
| 10 km | 1.09 ms (1.5) | 0.08 ms (0.5) | - | 0.47 / 0.22 ms | 0.35 ms |
| LEO, 250 km | 0.22 ms (1.5) | 0.07 ms (0.4) | - | 0.34 / 0.18 ms | 0.24 ms |
| lunar orbit, 100 km | 0.61 ms (1.8) | 0.05 ms (0.6) | - | 0.33 / 0.16 ms | 0.23 ms |
| lunar surface, 1.7 m | 0.85 ms (1.8) | 0.26 ms (0.6) | 0.04 ms (0.3): 239 k triangles | 0.82 / 0.43 ms | 0.47 ms |
| Moon from 5,000 km (relief floor) | 0.46 ms (1.8) | 0.05 ms (0.6) | - | 0.28 / 0.14 ms | 0.19 ms |
| Earth from 20,000 km (relief floor) | 0.22 ms (1.5) | 0.04 ms (0.4) | - | 0.29 / 0.14 ms | 0.19 ms |

These are the numbers of the last full run on the final code: 9 of 10 passed. Every GPU line is within its
budget. The one failure is the main-thread line at the pad (the view with the most tiles: 672 selected):
p99 1.02 ms against 1; the same test run alone right afterwards gave 0.65 ms (median 0.34). Over the
session that line read 0.65 to 0.85 ms in five runs of the pad test alone or in small groups and 0.76, 1.11
and 1.02 ms in three full runs, the higher ones while other agents' jobs were running; the lunar surface
read 0.76 to 1.00 ms. The assertion is left at the budget. The same selection takes 0.13 ms in Node
(`bench-select.ts`): the main thread of an unfocused headless Chrome on a shared machine is the larger part
of these figures, and the margin on this machine is small.

Across runs the terrain G-buffer at the pad read 0.58 to 0.83 ms and on the stony ground 1.33 to 1.44 ms
(budget 1.5: the tightest GPU line; two thirds of it is the detail layers on ground where two planes and
two materials meet).

60 s descent 60 km -> 30 m on the Moon: 3,600 frames, 0 over 33 ms (largest 17.4 ms; 29.7 ms in a run under
load); selection p99 0.59 ms (largest 1.03), with the prefetch passes 0.66 ms; 522 tiles uploaded, at most
6 in a frame, upload time p99 1.53 ms (largest 2.20 ms; the spec asserts p99 <= 2 ms and no frame over
6 ms: the loop stops before the tile that would pass 2 ms by its running estimate with a margin, and always
uploads at least one); largest queue 30; deepest level 18; terrain pools 1,046 MiB (plus 187 MiB of detail
material arrays, which the brief's 1.1 GB does not count).

## 9. Screenshots (looked at)

`out/screens/terrain/`: `earth-400000km`, `earth-leo-pacific`, `earth-leo-hawaii`, `earth-leo-nadir-day`,
`earth-leo-nadir-day-2`, `earth-leo-lowland-coast`, `earth-leo-nadir-night`, `earth-night-side`,
`earth-40km`, `earth-10km`, `pad-inland`, `pad-coast`, `pad-apron-down`, `pad-off-apron`,
`pad-ground-close`, `pad-30m`, `grass-eye`, `kiawe-eye`, `kiawe-120m`, `earth-1km`, `earth-stony-ground`,
`shoreline-200m`, `earth-edge-5km`,
`earth-edge-50km`, `moon-60000km`, `moon-terminator-20000km`, `moon-terminator-5000km`, `moon-orbit-100km`,
`moon-2km`, `moon-300m`, `moon-50m`, `moon-standing`, `moon-standing-upsun`, `moon-standing-down`,
`moon-edge-5km`, `moon-edge-50km`; `integrated-apron-eye`, `-off-apron-eye`, `-ground-close`, `-30m`,
`-200m`, `-1km`, `-grass-eye`, `-kiawe-eye`, `-kiawe-120m`, `-stony-ground`, `-10km`, `-40km`,
`-leo-hawaii` (with sky, clouds, atmosphere and ocean); `perf-*.png` and `warp-*.png` at 1440p. The
judgement of round 1 is in section 12; the paragraph below is the review stage's.

What holds up as a photograph: the Moon from 100 km at a 10 degree sun (wrinkle ridges, long crater
shadows), the lunar terminator views, the full disc; the lunar surface from 2 km, 300 m and 50 m (craters of
every size down to the pixel, no blur) and standing (grain, craterlets with shadowed walls, worn blocks with
long shadows; down-sun the scene is washed out as it is in Apollo frames taken down-sun); the Earth from
10 km and 40 km, the LEO nadir close-ups by day (Sierra Nevada, Himalaya, south Florida with its shelf and
keys) and by night (northern Italy), the Hawaiian islands from LEO; the apron at eye height and from 30 m
(weathered concrete without a repeat, a clean slab edge); the ground at one's feet off the apron
(`pad-ground-close`: soil, pebbles, dry grass litter); the coast from 200 m with atmosphere and ocean
(`integrated-200m`).

## 10. Review findings and what was done

| # | Finding | Done |
|---|---|---|
| 1 blocker | Earth at ground level not photoreal, apron tiles | Earth set replaced by photographic layers in four scales with their own content; hexagon pattern against repetition; imagery is the low-frequency colour, the layers carry the texture; apron is a slab with weathering and a clean, irregular edge; triplanar planes follow the terrain normal; views at eye height, 30 m, 200 m, 1 km in the terrain lab and in the integration lab. Not solved: the middle distance at eye height (section 11) |
| 2 major | lunar surface soft at landing distances, pebble-like rocks | lunar set regenerated with real relief at every scale (grain, clods, craterlets 2.5 cm to 250 m in the equilibrium numbers of the height function); far and aerial layers cover the magnification gap of the tile maps between 300 m and 2 km; 12 rock shapes in 4 classes, worn and chipped, partly buried; regolith BRDF and terminator handling so that the relief reads as shadowed slopes, not black dots |
| 3 minor | dark specks and rings on lowland coasts, stair-stepped lakes | mask / imagery disagreement handled per fragment, cubic mask reconstruction, `earth-leo-lowland-coast` view added |
| 4 minor | total main-thread cost neither reported nor asserted | tile constants written once, two rows per tile per frame, no per-tile allocation; `debug.stats().cpu`; the perf spec asserts the whole hook time without uploads under 1 ms (p99); rock lists by prefixes and kept between frames |
| 5 minor | approach pop test crossed neither a level change nor the hand-over | path extended to 400 km under an 8 degree sun (hand-over at about 1,500 km, level 3 to 4 at about 650 km); the spec asserts a level change on every path |
| 6 minor | wrong parent-image flags when child and parent are first drawn in one frame | `buildRecordConstants` resolves the parent's owners; `records.test.ts` reproduces the cut case |
| 7 minor | rocks line a difference of two measurements, upload budget only as p99, warp test blind | rocks are passes of their own (`rocksSeparate`) and measured on a site with rocks; upload p99 <= 2 ms and maximum < 6 ms asserted, estimate with a margin; warp test with a nadir camera over the ground track, sun over it, visible tiles and a day-side screenshot asserted, plus 5x and 10x where tiles stream |
| 8 minor | whole-body cascade casts from level 3; stale request status | hand-off corrected (sections 4.1a, 5); far views inside the relief floor measured (section 8.1) |

Found while fixing, not in the review: the hexagon pattern rotated its copies about the plane origin, so
tiles whose origins lay in different periods disagreed along their edge (fixed, tested); the height blend
between two materials compared metres across scales and showed the second material on half the ground at
any weight (now by share); the terrain drew its tiles in traversal order (now nearest first); on the stony
ground 1 km from the pad the rock buffer overflowed (48k rocks) and the terrain G-buffer cost 2.1 ms.

## 11. Known weaknesses (plainly)

- **Earth, middle distance at eye height** (`pad-off-apron`, `integrated-off-apron-eye`, the ground beyond
  the apron in `out/screens/integration/budget-pad-lift-off.png`): from about 20 m to a few hundred metres
  the ground is a flat-shaded plane with foreshortened blotches. A photograph taken there is dominated by
  what stands up (grass, bushes, stones seen from the side); this package draws no vegetation and no
  geometry below the height function except rocks, and the flattened pad disc (450 m) has neither relief
  nor rocks. This is the part of finding 1 that is not solved; it needs scattered vegetation geometry, which
  is not in the brief's scope.
- **Earth colours near the pad**: the regional imagery (Sentinel-2 cloudless) is dark and saturated there
  (sRGB 72/50/26); with the photographic detail on top the ground reads rust-orange, and the concrete
  (albedo 0.30) is seven times brighter than it.
- **Broken ground near the pad** (`earth-stony-ground`): the height function's hummocks are smooth forms
  under a soil-and-grass texture (the imagery colour says soil where the land cover says rock); the rocks
  on it are convincing, the ground between them is not.
- **Shoreline at 200 m without the ocean package** (`shoreline-200m`): flat water and a soft waterline; with
  ocean and atmosphere (`integrated-200m`) it is close to an aerial photograph, the land still slightly
  painterly (9.5 m imagery under detail).
- **Lunar rocks**: silhouettes are straight between worn corners at LOD 1 and 2; some rock shadows detach
  from small rocks (shadow-map resolution); slabs lie very flat.
- **Lunar ground under a low sun**: dark patches on slopes near the sun's elevation come from the detail
  normal maps (no relief casts a shadow on its neighbour): softer than before, still not the long shadows of
  real clods.
- **Sub-pixel grain**: the near detail has more contrast at the pixel scale than the first sets; a moving
  camera relies on the temporal anti-aliasing to keep it still (jitter test, section 8).
- **Night lights** are bounded by the 1.2 km cells of the source: below about 100 km altitude a town is a
  soft glow with grain, not streets.
- **Water colour**: deep water is one colour by construction (deviation 4).
- **Enclosed basins below sea level** that the mask calls water get the sheet at sea level; not looked at.
- **Whole-body shadows** resolve craters wider than about 20 km (deviation 1a).
- **CPU**: the whole hook time is under 1 ms at p99 when the machine is quiet (0.65 ms at the pad, 0.8-0.9 ms
  at the lunar surface and on stony ground; medians 0.35-0.5 ms) and over it in some runs under other
  agents' load (section 8.1). The rock lists cost up to 0.4 ms more on frames in which the camera moves
  through a dense field (they are kept only while it stands within 2 cm).
- **Earth material photographs are not in the repository** (deviation 7).
- **VRAM**: the detail material arrays add 187 MiB to the 1,046 MiB of tile pools.

## 12. Visual close-out, round 1 (2026-11-11)

Work list: `out/qa/wave2/terrain-render.r0.photo.json` (photo 5/10, 18 items) and
`terrain-render.r0.artifact.json` (artifact 4.5/10, 21 items). Round 1 was done by two agents in turn: the
first (commits 4d55e12, 34548f5: ground cover, ground colour from materials, site ground plan, relief
shadows, lunar bounce light, broken-rock meshes, new lunar layers, ponds, night-light footprint) ran out of
budget mid-work; the second finished it (d2725ec and the commit of this section). Every screenshot named
below was re-rendered on the final code and looked at; integration-lab views (`integrated-*`) are the ones to
judge colour by (sky, atmosphere, clouds and ocean present), the terrain lab's views have a black sky
stand-in.

### Photo critic

| # | Item | Done | Look at |
|---|---|---|---|
| 1 blocker | Ground at eye height a flat printed plane, nothing stands up | Ground cover (section 3): tussocks, wind-shaped scrub, kiawe trees, stands of kiawe to 7 km, loose clinker, by land-cover class, instanced with shadows in every cascade fine enough for them; shadows of the detail relief along the sun (section 3, "Relief shadows"); lava where the land cover says rock. The horizon is broken by trees and scrub. The plane itself: request `terrain-render-6`, resolved at the end of the round (a quarter of the natural relief and rocks back on the disc, ragged edge). Not done: parallax displacement of the detail layers | `integrated-off-apron-eye`, `integrated-grass-eye`, `integrated-kiawe-eye`, `integrated-kiawe-120m`, `grass-eye`, `kiawe-eye`, `kiawe-120m` |
| 2 major | Wrong colours: rust ground, cream strip brighter than concrete, salmon slopes | Ground takes its material's albedo where the imagery is a graded mosaic (section 3, "Ground colour"; `anchorAlbedo`: lava neutral to cool, soil grey-brown), imagery keeps 70 % of its saturation there and its luminance is bounded to 1.6 x the material's; built-up cells are dirt, not concrete. Measured in `integrated-30m`: concrete Y 0.41, lava around it 0.11 (3.7 x), ground R/B 1.17 (was 2.9) | `integrated-30m`, `integrated-200m`, `integrated-1km`, `integrated-40km` |
| 3 major | Apron a perfect 280 m disc, no joints | Site ground plan from the structures (`sitePlan.ts`): concrete slabs under every structure with a footprint, bays with joints, a tone per bay, dirt along joints, stains, scorch towards the pad, kerb; gravel lane bed under the crawlerway; compacted shoulder with a ragged edge. In the game the vehicle-pad package's groundworks cover it (request `vehicle-pad-3`, resolved) | `pad-30m`, `integrated-30m`, `integrated-apron-eye`, `pad-apron-down` |
| 4 major | Flat grey "ponds" on a slope near the pad | Mask water above sea level only on level ground (slope below 0.03-0.07), dark with wet margins and the deep colour towards the middle; the fill rule tests hue (blue), not darkness | `integrated-1km`, `earth-1km` |
| 5 major | Broken ground: soil print on hummocks, no lava | Rock classes resolve to pahoehoe / a'a with their own albedos; ropy-lava photographs regenerated (34548f5); crests glossier (near and mid layers); relief shadows; rocks with a banked foot. Not done: ridged amplification of the height function (terrain core) | `earth-stony-ground`, `integrated-stony-ground` |
| 6 major | 200 m - 6 km a watercolour, no shrub or tree | Scrub to 700 m, kiawe to 1.8 km, stands of kiawe to 7 km, each with its shadow; class boundaries ragged (warped lookup) | `integrated-kiawe-120m`, `integrated-1km`, `integrated-200m` |
| 7 major | Parallelogram on the shore (raster cell) | It was a built-up cell of the land cover drawn as concrete (weight 0.6) and cut along its texel edges: built-up is dirt and cinder now; class lookup displaced at 45, 14 and 5 m in addition to the imagery warp | `integrated-200m`, `shoreline-200m` |
| 8 major | Cliffs and shore olive and cream, no basalt or black sand | Steep ground is clinker (`slopeGain`), low level shore black sand (`shoreGain`), wet band to 2.5 m above the sea, patchy; the bright imagery strip bounded (item 2) | `integrated-200m`, `shoreline-200m` |
| 9 major | Lunar rocks: flat-faced polyhedra, no fillet, detached shadows | Broken-rock meshes (welded sphere of directions pushed to a polyhedron, scoops, crack, lumps, soil banked at the foot), smooth vertex normals with 30 % of the facet normal (no tessellation net), grain at full contrast, a thin crack, sharper wear (10 % / 30 %); loose rocks stand 0.55-1.1 of their radius high (were 0.4-0.8: half-buried domes). Sunlit faces 1.5 x the regolith in `moon-standing` (reference 1.3-1.7 x). Not fully: from a few metres on, the coarser meshes read as smooth pale lumps rather than fractured blocks, and collidable rocks are as low as the height function's caps | `moon-standing`, `moon-standing-down`, `moon-standing-upsun` |
| 10 major | Lunar slopes under a low sun: ink blots and black specks | Relief shadows of the detail layers; slopes taken out at the terminator go into the facet spread of the regolith BRDF. Better, not gone: the dark slope in `moon-300m` (a crater wall turned from the 11 degree sun) is still a mottled patch | `moon-300m`, `moon-standing-down`, `moon-2km` |
| 11 major | Lunar surface 50 m - 20 km looks generated: one crater size, soft dimples, ripples | Lunar layers regenerated: craters of overlapping size ranges per layer (a decade of overlap), worn and fresh profiles (bowls, rims only on fresh ones), clustered, no fBm swell under them | `moon-2km`, `moon-300m`, `moon-50m`, `moon-edge-5km` |
| 12 major | Lunar shadows zero signal | Bounce light off the sunlit ground in the regolith BRDF (`bounceFlat` 0.28, `bounceDown` 0.36). Measured in `moon-standing-down`: a rock's shadow on the regolith 0.13 x the lit ground (target 5-15 %) | `moon-standing-down`, `moon-standing-upsun` |
| 13 major | Scalloped crater shadows from orbit | Request `terrain-render-4` (resolved c417fb0): the terrain writes a shadow filter of one render quad into RT4.a (section 2). The gear teeth and polygons are gone; the price is a soft edge where a photograph has a crisp crescent | `moon-orbit-100km`, `moon-edge-50km` |
| 14 minor | Combed regolith at eye height; ruler-straight horizon | Footprint shortening limited to a quarter (was a half); the horizon at the lunar site is the height function's mare (not changed) | `moon-standing` |
| 15 minor | Night lights streaked near the limb | Lights sampled with the footprint's own shape (`textureSampleGrad` with the night uv derivatives), grain fades by the long axis | `earth-night-side`, `earth-leo-nadir-night` |
| 16 minor | Lunar strips of different tint near the coverage edge | Request `terrain-render-5` (bake-moon, open); lunar imagery keeps 40 % of its saturation | (integration lab, coverage-edge views) |
| 17 minor | Far Earth views only in the terrain lab | `integrated.spec.ts` renders 10 km, 40 km and LEO over Hawai'i in the integration lab | `integrated-10km`, `integrated-40km`, `integrated-leo-hawaii` |
| 18 minor | Stale `perf-shore-rocks.png` | Deleted; the perf spec writes `perf-stony-ground`, `perf-kiawe`, `perf-thickets-120-m` | - |

### Artifact critic

| # | Item | Done | Look at |
|---|---|---|---|
| 1 blocker | Ground off the apron a flat textured plane | Photo 1 | as photo 1 |
| 2 major | Ground colours (rust, neon green) | Photo 2 | as photo 2 |
| 3 major | Apron a featureless pale disc | Photo 3 | as photo 3 |
| 4 major | Water where there is land (cobalt on lava, grey blobs) | Photo 4: fill colour by hue (b > 1.6-2.6 r and > g), lakes only on level ground | `earth-edge-50km`, `earth-leo-lowland-coast`, `integrated-1km` |
| 5 major | Coasts outlined dark, islands two-toned, saw-tooth rim | Shallow water modelled where the imagery holds the fill colour (lighter towards the shore), continuous repair weight instead of a boolean | `earth-10km`, `integrated-10km`, `earth-leo-hawaii` |
| 6 major | Straight-edged facet on the bluff | Photo 7 (a built-up cell drawn as concrete) | `integrated-200m` |
| 7 major | Stony ground: wax hummocks, black blotches, perched rocks | Photo 5; the view is in the integration lab as well (`integrated-stony-ground`) | `integrated-stony-ground` |
| 8 major | Lunar rocks pale, flat-shaded, seams, blurred shadows | Photo 9; meshes are welded (no seams) | `moon-standing` |
| 9 major | Lunar weave, dashes, black specks | Photo 10, 11, 14 | `moon-50m`, `moon-standing` |
| 10 major | Crater "pills" of one profile | Photo 11 | `moon-2km`, `moon-300m` |
| 11 major | Mare like rippled water | Photo 11 (no swell in the far and aerial lunar layers) | `moon-edge-5km` |
| 12 major | Crater shadows not crater-shaped from orbit | Photo 13 | `moon-orbit-100km` |
| 13 major | 30 m: one grain size, no patches | Clinker and tussocks stand on it with shadows, the ropy-lava photographs carry lobes of 0.3-3 m, the shoulder and the concrete break it up. Not done: a second material in patches of 2-10 m (macro noise is 160 m) | `integrated-30m`, `pad-30m` |
| 14 minor | Ghosting at one's feet | Not changed (the hexagon pattern's height blend) | `integrated-ground-close` |
| 15 minor | LEO nadir close-ups soft | Not changed: the global imagery is the limit at 250 km; orbital detail as before | `earth-leo-nadir-day` |
| 16 minor | Everglades blocks and moire | Photo 4 (fill by hue, continuous repair): no pale blocks left | `earth-leo-lowland-coast` |
| 17 minor | Night lights streaked near the limb | Photo 15 | `earth-night-side` |
| 18 minor | Stipple near the lunar terminator | Not changed | `moon-terminator-5000km` |
| 19 minor | Lunar colour cast, halos round small craters | Lunar imagery 40 % saturation; fresh-material boost 0.22 -> 0.14 | `moon-orbit-100km`, `moon-edge-50km` |
| 20 minor | Notches where the seabed meets the sheet | Not changed (low priority, as the critic says) | `handover-with-nearfield` |
| 21 minor | Evidence gaps (stale file, warp shots over sea) | Stale file deleted; the warp shots still show whatever the ground track is over (sea, mostly) | - |

### Not fixed, and why

- **The plain around the pad** (photo 1, artifact 1): request `terrain-render-6` was answered at the end of
  the round (1581cf9): a quarter of the natural hummocks is back inside 450 m and the blend is ragged, and
  the rock field now has rocks there (the pad view of the perf spec draws 145). Ka Lae's natural ground is
  low relief, so the plain stays gentle.
- **Parallax displacement of the detail layers** within 30 m (both critics): not done. The relief shadows
  march the same height maps towards the sun; displacement would be a second march per pixel on the most
  expensive views (stony ground is the tightest G-buffer line).
- **Lunar ground under a low sun** (photo 10): the mottled dark slope in `moon-300m` remains (a crater wall
  turned from an 11 degree sun, between the cascade's soft shadow and the facet terminator); softer than
  in round 0, not the crisp black of an Apollo frame.
- **Lunar rock silhouettes**: the finest mesh is broken and pitted; the coarser two are rounded, and
  collidable rocks are as low as the height function's caps.
- **Ridged amplification on rock classes** (photo 5): terrain core's height function; not requested this
  round.
- **Minor, not changed**: ghosting where hexagon copies cross-fade at one's feet (artifact 14), LEO nadir
  softness (artifact 15: the body-wide imagery at 250 km), stipple at the lunar terminator from 5,000 km
  (artifact 18), seabed notches at the near-field radius (artifact 20), warp screenshots over land
  (artifact 21).
- Seen in the integration lab and not this package's: horizontal scan-line stripes over the far hills and the
  sea horizon in `integrated-30m` (atmosphere / clouds, work in progress of atmosphere-clouds at the time of
  the run; the terrain alone draws no such lines).

### Performance (final run on the final code, 1440p, `withGpuLock`; three to four other agents' GPU jobs running)

`terrain.perf.spec.ts`: 7 of 12 passed. Numbers are the smallest p99 / mean of up to six interleaved rounds
(section 8.1). G-buffer and shadows include the ground cover (`terrain-cover.*` passes), as the spec asserts.

| View | Terrain G-buffer + cover, ms (budget) | Shadows + cover, amortised (budget) | Rocks | Main thread p99 / median, ms (budget 1) | Selection p99 |
|---|---|---|---|---|---|
| pad, 1.7 m | 0.92 + 0.18 = 1.09 (1.5) | 0.29 + 0.31 = **0.60** (0.5) | 0.00 | **1.90** / 1.41 (cover 0.61 mean) | 0.72 |
| stony ground, 1.7 m | **2.27** + 0.08 = **2.35** (1.5) | 0.35 + 0.49 = **0.84** (0.5) | **0.69** (0.3) | **2.37** / 1.45 (cover 0.66) | 0.83 |
| kiawe, 1.7 m | 1.12 + 0.41 = **1.53** (1.5) | 0.35 + 1.13 = **1.48** (0.5) | 0.27 | **2.41** / 1.71 (cover 0.89) | 0.74 |
| thickets, 120 m | **2.12** + 0.81 = **2.93** (1.5) | 0.20 + 0.76 = **0.96** (0.5) | 0.00 | **2.18** / 1.45 (cover 0.70) | 0.82 |
| 10 km | 1.14 (1.5) | 0.07 (0.5) | - | 0.85 / 0.42 | 0.64 |
| LEO | 0.24 (1.5) | 0.07 (0.4) | - | 0.54 / 0.38 | 0.39 |
| lunar orbit | 0.51 (1.8) | 0.05 (0.6) | - | 0.49 / 0.35 | 0.35 |
| lunar surface, 1.7 m | 0.84 (1.8) | 0.31 (0.6) | 0.13 (0.3) | 0.95 / 0.69 | 0.62 |
| Moon from 5,000 km | 0.77 (1.8) | 0.05 (0.6) | - | 0.38 / 0.20 | 0.28 |
| Earth from 20,000 km | 0.24 (1.5) | 0.04 (0.4) | - | 0.38 / 0.27 | 0.25 |

- 60 s lunar descent: 3,600 frames, 0 over 33 ms (largest 20.0 ms), upload p99 1.70 ms (largest 4.50), queue at
  most 29, deepest level 18, pools 1,046 MiB: passed. (In an earlier run of the session, with four other GPU
  jobs, 9 frames were over 33 ms, the largest 211 ms; the run right after it had none.)
- Warp: failed in this run at 5x (17 frames over 33 ms, largest 310 ms, while map-view's perf project and
  three functional suites ran); in the run before it 5x, 10x and 50x passed with no frame over 33 ms
  (largest 19.7 / 21.9 / 21.5 ms, queue at most 4 / 5 / 3).
- **Over budget, not load alone**: everything on the ground at the Earth site. The far views and the Moon
  are within their lines with a wide margin (they were 1.2 to 3.4 times higher in a run under heavier
  load an hour earlier). The four ground views were over in every run of the session:
  - The ground cover's main-thread cost: 0.6 to 0.9 ms mean. Its G-buffer lists are kept while the camera
    stands still and index runs are block copies now; what remains is per chunk per frame (some 1,600 chunks
    of five kinds, out to 7 km: camera-relative rows, frustum test, prefix searches) and per cascade (the
    shadow lists). Fix not done: chunk origins relative to a body-fixed anchor that moves rarely (rows written
    only when it does), shadow lists kept per cascade like the G-buffer lists.
  - Cover shadows (0.3 to 1.1 ms): every cascade whose texel is at most an instance's diameter draws it.
    Not done: casting only from instances of two texels and more, or a coarser shadow mesh for crowns.
  - Terrain G-buffer on broken ground and over thickets (2.1 to 2.3 ms): two materials, up to three
    triplanar planes, three hexagon copies, four detail scales and their relief-shadow marches (four taps each
    now, were six). A/B with `p.earth.reliefShadow=0` under load: 2.85 -> 2.14 ms at the stony site.
  - Rocks at the stony site 0.69 ms (0.3): 43,000 instances; the lunar surface's are within budget.
  The assertions are unchanged. These lines need either the reductions above or a re-measure on the quiet
  machine before they can be judged; the lead's re-measure (PACKAGE_RULES 16) is the reference.
- Functional suite on the final code: 20 of 20 (`integrity`: no holes in 12 heights x 4 captures on both
  bodies, image decode exact, collision surface 0.000 mm, near-field hand-over, jitter; `pops`: 0 block
  spikes on all six paths, worst ratio 1.18 Earth / 1.71 Moon / 1.02 approach; `views`; `integrated`;
  `smoke`). Unit tests 44 of 44; typecheck of the package's paths clean; `boundaries.test.ts` 7 of 7.

### Honest scores (own judgement of the final screenshots)

- Photo lens: about 6.5. The pad surroundings read as a lava coast with grass, scrub and kiawe that stand
  up and cast shadows (`integrated-off-apron-eye`, `integrated-kiawe-120m`, `integrated-200m`); the Moon
  from orbit, the terminator and the standing views hold up. Against it: the plain around the pad is gentle (a
  quarter of Ka Lae's low relief), lava a little bright against the sky, crowns that look faceted up close
  (`integrated-stony-ground`, the scrub at the left), smooth pale lumps for the coarser lunar rocks, a
  mottled slope in `moon-300m`, soft crater-shadow edges from orbit.
- Artifact lens: about 6. No tiling, no texel staircases on land cover, no stray concrete, no ponds on
  slopes, no gear teeth; left: rounded shapes of the coarser rock meshes, the ghosting of hexagon copies at
  one's feet, notches at the near-field radius, stipple at the terminator from 5,000 km.
