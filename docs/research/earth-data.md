# Earth data research and tile-bake plan

Probed 2026-11-09 from the dev machine with HEAD/Range requests (`curl -r 0-511`). Everything marked VERIFIED returned HTTP 200/206 with the stated size/headers. Nothing here depends on an API key.

## 1. Verified sources

### 1a. Color imagery (cloud-free)

| Source | Exact URL (verified) | Format / resolution / size | License | CORS |
|---|---|---|---|---|
| **NASA Blue Marble Next Generation (BMNG) base map, monthly 2004** (no topo/bathy shading, best base albedo) | `https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/{month}/world.2004{MM}.3x21600x21600.{A1,B1,C1,D1,A2,B2,C2,D2}.jpg`  e.g. `.../bmng-base/august/world.200408.3x21600x21600.A1.jpg` | JPEG, 8 tiles of 21600x21600 = 86400x43200 (15 arcsec, ~463 m/px at equator). A1 = 45.3 MB, so ~360 MB/month. Also `..._geo.tif` variants, and 21600x10800 single files (`.../bmng-base/april/world.200404.3x21600x10800.jpg` = 22.2 MB) and 5400x2700. Download speed measured ~4.7 MB/s. | NASA, public domain (credit "NASA Earth Observatory / Reto Stockli") | not needed (bake-time only; assets host did send `Access-Control-Allow-Origin: *`) |
| BMNG with topography+bathymetry shading (do NOT use as albedo, shading is baked in) | `.../bmng/bmng-topography-bathymetry/{month}/world.topo.bathy.2004{MM}.3x21600x21600.A1.jpg`, single-file `3x21600x10800.jpg` = 28.5 MB (april) | same grid | public domain | - |
| Old host `eoimages.gsfc.nasa.gov/images/imagerecords/...` | returns 301 -> `science.nasa.gov`; the CDN URLs above are the live ones. Old URLs from memory/tutorials are dead, use the assets.science.nasa.gov paths. | | | |
| **NASA GIBS WMTS, BlueMarble_NextGeneration** (same data as a runtime tile service) | `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/2004-08-01/500m/{L}/{row}/{col}.jpeg` L=0..7 | 512 px tiles, EPSG:4326, matrix at L: (2,1),(3,2),(5,3),(10,5),(20,10),(40,20),(80,40),(160,80); tile span = 288/2^L degrees, origin -180,90. Florida L7 r27 c44 -> 200, 16.9 KB. Level 8 -> HTTP 400. | public domain | `Access-Control-Allow-Origin: *` |
| **Sentinel-2 cloudless (EOX)** WMTS Web-Mercator | `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-{2016..2025}_3857/default/g/{z}/{row}/{col}.jpg` (VERIFIED 2020, 2021, 2024, caps list 2017-2025). Capabilities: `https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml` (68 KB) | 256 px JPEG, nominal 10 m (z14). At the Florida site: z12 20 KB, z14 6 KB, z15 4.4 KB, z16 3.3 KB -> sizes collapse past z13, so treat real detail as ending near z13-z14 (~9-19 m/px); z15/16 exist but are upsampled. Also `blackmarble_3857`, `bluemarble_3857` (119 KB at z5), `terrain-light_3857`. | **CC BY-NC-SA 4.0** for the free tiles ("Contains modified Copernicus Sentinel data <year>"; attribution text is in the capabilities AccessConstraints). Commercial use needs an EOX license. Flagged: fine for a non-commercial project, but shipping commercially means swapping it out. | `access-control-allow-origin: *` |
| s2maps-tiles.eu mirror | 403 | do not use | | |
| Esri World_Imagery `services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | works (200/206) | higher res locally than S2, but ToS forbids bulk caching/redistribution. **Rejected.** | | |
| NASA GIBS MODIS/VIIRS daily true color | `.../MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/250m/{L}/{r}/{c}.jpg` L0..8; `VIIRS_NOAA20_CorrectedReflectance_TrueColor` 250m | 250 m, daily, **with clouds and swath gaps**, so not an albedo base. Useful for seasonal snow/ice or for deriving a cloud map. Florida L8 -> 200, 51.8 KB. | public domain | `*` |
| GIBS Landsat WELD true color (annual/monthly, 31.25 m, L0..11) | layer exists in caps; my test tile coordinates returned 404 (CONUS/Alaska-only coverage? **not verified**) | | public domain | `*` |
| GIBS HLS S30/L30 (31.25 m, daily, 2026 data) | layer exists in caps | has clouds, not a mosaic | public domain | `*` |

GIBS rate limits: none published in the docs I fetched; they ask clients to be reasonable. Treat as ~10-20 req/s, cache everything, never hit it from the shipped client at runtime.

### 1b. Elevation + bathymetry

| Source | URL (verified) | Format / res / size | License | CORS |
|---|---|---|---|---|
| **AWS Terrain Tiles (Terrarium)** z0-15 | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (Florida z8 58 KB, z12 81 KB, z14 61 KB, z15 63 KB) | 256 px RGB PNG, Web Mercator. `h_m = R*256 + G + B/256 - 32768`. z15 = 4.8 m/px at the equator (x0.88 at 28N). Underlying data: ~10 m 3DEP in the US, SRTM 30 m / other elsewhere, ETOPO1/GEBCO bathymetry (only good to ~z9). Bonus: `skadi/N28/N28W081.hgt.gz` SRTM 1-degree HGT (1.1 MB) and `normal`, `geotiff` variants at the same bucket. | Mapzen/Tilezen mix, free, attribution list at `github.com/tilezen/joerd/blob/master/docs/attribution.md` | `Access-Control-Allow-Origin: *`, range OK |
| **Copernicus DEM GLO-30** COG | `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N28_00_W081_00_DEM/Copernicus_DSM_COG_10_N28_00_W081_00_DEM.tif` (16.5 MB per 1 deg tile); GLO-90: `copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_N28_00_W081_00_DEM/...tif` (2.0 MB) | float32 COG, 1 arcsec (30 m). It is a **DSM** (trees/buildings in), no bathymetry. Full globe at 30 m is ~hundreds of GB: regional only. | Free incl. commercial, attribution "Contains modified Copernicus data" | S3 range works; browser CORS headers not returned for no-origin test, irrelevant (bake-time) |
| **GEBCO_2025** global grid (topo+bathy) | `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2025/ice_surface_elevation/geotiff/gebco_2025_geotiff.zip` (4.24 GB, range OK) | 15 arcsec (86400x43200, same grid as BMNG), int16, GeoTIFF tiles inside the zip (~7.5 GB unzipped) | GEBCO terms: free, attribute "GEBCO Compilation Group (2025) GEBCO 2025 Grid" | bake-time |
| **ETOPO 2022** | 60 s global GeoTIFF `https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif` (466 MB, 21600x10800); 15 s tiles of 15x15 deg e.g. `.../15s/15s_surface_elev_gtif/ETOPO_2022_v1_15s_N30W090_surface.tif` (19.4 MB); 30 s NetCDF single file 1.64 GB via THREDDS. Directory listings are browsable. (The thredds `.tif` path for 60s 404s, use the `/mgg/global/relief/` HTTPS path.) | 1 km-ish (60 s) to 463 m (15 s) | NOAA, public domain | `*` |

Recommendation: **global height base = GEBCO 2025 (or ETOPO 2022 15 s, public domain NOAA; equivalent)**, because Terrarium at z<=9 is itself derived from coarser bathymetry. Regional = Terrarium z10-z15 around the pad (US 3DEP 10 m, edge-matched) and Copernicus GLO-30 for the Moon-return/non-US areas if wanted. Use GLO-30 for the rest of the world only if you want DSM data; for the Moon see the lunar report.

### 1c. Night lights

| Source | URL (verified) | Details | License |
|---|---|---|---|
| NASA Black Marble 2016 composite (static) | `https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg` (8.1 MB, 13500x6750 = 3 km) and `..._01deg.jpg` (780 KB) | grayscale-ish color composite, public domain (NASA Earth Observatory / Roman Sejkora Suomi NPP) | |
| **GIBS VIIRS_Black_Marble** (annual 2012..2016 and daily, 2024-03-25..2026-11-09) | `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_Black_Marble/default/2016-01-01/500m/{L}/{r}/{c}.png` L0..7 (Florida L7 r27 c44: 205 KB, L6 148 KB) | PNG 512 px, 500 m (level 7 = 81920x40960 ~ 488 m/px), `*` CORS. Best: pull annual 2016 at L7 (160x80 = 12,800 tiles x ~130-200 KB, roughly 2 GB, one-time) or L6 (3,200 tiles, ~0.5 GB, enough for a 305 m pyramid) and bake. | public domain |
| `VIIRS_CityLights_2012` (jpeg) | in caps | older, avoid | |
| EOX `blackmarble_3857` | in caps | fallback | CC BY-NC-SA |

### 1d. Clouds

| Source | URL (verified) | Details |
|---|---|---|
| **Real-time global cloud map** (IR-derived geostationary+polar composite, alpha PNG) | `https://clouds.matteason.co.uk/images/8192x4096/clouds-alpha.png` (23.1 MB, 8192x4096 ~ 4.9 km/px), `.../4096x2048/clouds-alpha.png` (6.7 MB) | CORS `*`; third-party hobby service, license unstated and uptime not guaranteed, so use as a **bake-time snapshot only**, stored in the repo data dir. Pick a calm frame. |
| SolarSystemScope textures | `https://www.solarsystemscope.com/textures/download/8k_earth_clouds.jpg` (11.6 MB), `8k_earth_daymap.jpg`, `8k_earth_nightmap.jpg` (all 200) | **CC BY 4.0** stated on the page ("Attribution 4.0 International license"). 8k stylised from NASA data, good fallback/cross-check only. |
| GIBS MODIS_Terra_Cloud_Fraction_Day | `.../MODIS_Terra_Cloud_Fraction_Day/default/2026-11-05/2km/{L}/{r}/{c}.png` L0..5 (2 km tiles, 40x20 at L5 = 20480x10240 px) | public domain, daily swath with gaps -> composite several days, gives physical cloud fraction. |
| GIBS geostationary: `GOES-East_ABI_GeoColor` (1 km, 10-min, 490 KB tile verified), `GOES-West_ABI_GeoColor`, `Himawari_AHI_Band3_Red_Visible_1km`, `*_Band13_Clean_Infrared` | epsg4326 `.../GOES-East_ABI_GeoColor/default/2026-11-08T12:00:00Z/1km/{L}/{r}/{c}.png` | public domain. Covers Americas + Pacific/Asia (GOES-E/W + Himawari); **no Meteosat** -> Africa/Europe/Indian Ocean gap. Mosaic GOES-E + GOES-W + Himawari at a single UTC hour for ~near-global 16k clouds, with the IR band 13 for thickness/height. |
| NOAA GFS 0.25 deg on AWS (volumetric inputs: low/mid/high cloud cover `LCDC/MCDC/HCDC`, `TCDC`, cloud water `CLWMR`, cloud ice `ICMR`, humidity per pressure level) | `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261108/00/atmos/gfs.t00z.pgrb2.0p25.f000` (503 MB) with `.idx` (31.8 KB) for byte-range per-field download | GRIB2, public domain. Decode with `cfgrib+eccodes` (pip wheels incl. eccodes on Windows) or `pygrib`. Use to drive a **cloud type/coverage/height 3D texture** (low/mid/high layer coverage x cloud-water) for volumetric clouds near the camera, in sync with the 2D map shell seen from orbit. |

Cloud strategy: (1) **far/orbit**: bake a 16384x8192 (or 2 x 8192) equirect->cube-face cloud albedo+alpha pyramid (L0-L6, 8-bit single-channel density plus 1 channel height/type) from a GOES/Himawari+Matt Eason composite, with GFS filling gaps; (2) **near**: a procedural volumetric raymarched cloud layer in the shader whose coverage/type come from low-res (0.25 deg) GFS-derived textures, with the high-res 2D map modulating detail; blend as the camera descends so there is no scene swap.

### 1e. Land/water mask, specular, other

| Source | URL (verified) | Use |
|---|---|---|
| GIBS `OSM_Land_Water_Map` (250 m, 2000-2015 annual) | `.../OSM_Land_Water_Map/default/...` layer in caps (250m TMS, png) | land/water mask for ocean shader, shoreline foam; resample from L8 |
| Natural Earth 10m raster `NE1_HR_LC_SR_W` | `https://naciscdn.org/naturalearth/10m/raster/NE1_HR_LC_SR_W.zip` and `https://naturalearth.s3.amazonaws.com/10m_raster/NE1_HR_LC_SR_W.zip` (323 MB, 206 OK) | public domain 21600x10800 raster, alternative base albedo |
| **Derived mask**: ocean = GEBCO/ETOPO height < 0 plus lakes from OSM water; shallow-water depth also from bathymetry | no extra download | use heights < 0 for ocean mask and depth-driven water color; specular = ocean mask (1) vs land (0), ice from albedo threshold, roughness from land cover |
| **ESA WorldCover 2021 v200** 10 m land cover (11 classes) | `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27W081_Map.tif` (16.1 MB per 3x3 deg tile) | CC BY 4.0; for procedural detail material selection (sand, grass, tree, water, built-up, wetland, mangrove) **regionally** around the pad only. Global: GIBS MODIS land cover or Natural Earth. Store as 8-bit class pyramid. |
| GIBS `SRTM_Color_Index`, `ASTER_GDEM_*` (31.25 m) | in caps | do not need |

## 2. License summary

- Public domain / free incl. commercial: NASA BMNG, Black Marble, GIBS layers (credit NASA), ETOPO 2022, GEBCO 2025 (attribution), Copernicus DEM (attribution), Terrarium (attribution list), ESA WorldCover (CC BY 4.0).
- Non-commercial: **EOX Sentinel-2 cloudless (CC BY-NC-SA 4.0)**. If the game is ever sold, replace with Landsat/HLS-derived imagery or procedural detail. Plan the data layer so the high-res color source is swappable (`sources.json` entry per layer).
- Rejected: Esri World Imagery (ToS), Mapbox/Google/Bing.
- Keep an in-game credits screen listing: NASA Earth Observatory / GIBS, Sentinel-2 cloudless by EOX (Copernicus Sentinel data), GEBCO Compilation Group, Mapzen/Tilezen terrain tiles, Copernicus DEM, ESA WorldCover, NOAA ETOPO/GFS.

## 3. Cube-face pyramid geometry (for size planning)

Face edge at the face center = pi/2 * 6371 km ~ 10007 km (equal-angle mapping means ~0.7x at the face corners).

| level L | tiles/face | ground per px, 512px tile | per sample, 256px height tile |
|---|---|---|---|
| 5 | 1,024 | 611 m | 1,222 m |
| 6 | 4,096 | 305 m | 611 m |
| 7 | 16,384 | 153 m | 305 m |
| 8 | 65,536 | 76 m | 153 m |
| 9 | 262,144 | 38 m | 76 m |
| 10 | 1.05 M | 19 m | 38 m |
| 11 | 4.2 M | 9.5 m | 19 m |
| 12 | 16.8 M | 4.8 m | 9.5 m |
| 13 | 67 M | 2.4 m | 4.8 m |
| 14 | 268 M | 1.2 m | 2.4 m |

Native data: BMNG/GEBCO 463 m -> color L6 (305 m, 1.5x oversampled for clean sampling) and height L7 (305 m/sample). Sentinel-2 10 m -> color L11. 3DEP/Terrarium ~10 m -> height L11-L12. GLO-30 -> L10-L11 (with 38 m ~ 1 arcsec). Below native resolution the renderer adds procedural detail (fractal displacement + albedo/normal detail textures chosen by WorldCover class), as already planned.

## 4. Bake pipeline

Everything is pure Python + numpy, runs locally on the 32-thread machine; the job is download- and IO-bound, so **Modal is not worthwhile** for this (only consider Modal if you decide on ML super-resolution of the regional imagery or want a bulk fetch from a faster network; the egress savings are not worth the complexity).

Packages (verified resolvable with `pip install --dry-run --only-binary=:all:` on Python 3.10/Windows): `rasterio 1.4.4` (bundled GDAL, warp/overviews/windowed reads), `pyproj 3.7.1`, `imagecodecs 2025.3.30` (JPEG/WebP/JPEG-XL/zstd/deflate), `rio-cogeo 6.0.0`, `morecantile 6.2.0`, `pyvips 2.1.0` (needs `pyvips[binary]` for the libvips DLL; optional). Already installed: numpy 2.2.6, scipy, opencv-python 4.13 (`cv2.remap`), pillow 12.2, tifffile, numba 0.68, aiohttp, requests. `gdalinfo` is not on PATH; rasterio supplies GDAL. For GFS GRIB add `cfgrib eccodes xarray` (or `pygrib`).

Steps:
1. **Fetch** (`tools/earthdata/fetch.py`, resumable, `.partial` + `Range`, sha256 manifest): BMNG base 8 tiles for the chosen month(s) (~360 MB each month; bake 1 month for v1, optionally 4 seasons), GEBCO 2025 zip (4.2 GB) or ETOPO 15 s tiles, Black Marble 3 km jpg (8 MB) + GIBS 2016 L6/7, cloud snapshots (23 MB + GOES/Himawari composite), regional Terrarium z10-z15 tiles and EOX z8-z13 tiles for the region polygon, Copernicus GLO-30 for 3x3 deg around the pad, WorldCover tile(s) N27W081 + neighbours.
2. **Stitch** the 8 BMNG JPEGs into a single uint8 memmap (86400x43200x3 = 11.2 GB in `data/cache/`, temporary). Keep decompress windowed so peak RAM stays small (check RAM; the machine has 32 logical cores).
3. **Resample per cube tile**: for each node (face, L, x, y) compute the (lon, lat) of every output texel (equal-angle cube mapping, `u,v -> tan` warp if gnomonic: pick one and make it match the renderer, document it in `docs/`), then sample the equirect source with `cv2.remap(..., INTER_CUBIC, borderMode=BORDER_WRAP)` on a windowed crop with a margin; for downsampled levels, build mips from the finest baked level (area average) instead of resampling the source again to avoid aliasing. 1 texel border (or 2) duplicated for seamless filtering and across face edges.
4. **Heights**: sample GEBCO (bilinear/bicubic) for global tiles, then for the regional nodes blend in Terrarium/GLO-30 (resample to the cube tile, feather at region borders, adopt higher-res only where nodata is false; convert Terrarium to meters first). Store 16-bit tile: `(h + 11000) * 6 ` -> uint16 gives 1/6 m... better: store int16 in half-metre steps for land and fine steps near sea level, or use float16-in-RG8 PNG; recommended storage = raw int16 (257x257 with border) zstd/deflate compressed, decoded in a worker with `DecompressionStream('deflate')` (zstd is not a browser stream format). Also precompute **normal maps** (RG8) per tile on the CPU so the GPU does not need to derive normals across tile borders.
5. **Color**: JPEG q~88 or WebP, 512 px, sRGB; alpha-less. Night lights (R8/BC4-like; store as JPEG gray), cloud pyramid (R8 density + G8 height, PNG or WebP lossless), land/water+specular mask (R8 PNG, ocean=255), land-class (R8 PNG) regional only.
6. **Pack**: for >10k files on Windows use one pack file per (layer, face) or PMTiles v3 (`pmtiles` pip package; one archive per face since tile ids are z/x/y only) with HTTP range requests from the local tile server; for the regional detail ~ a few thousand files, a plain directory is fine. Uniform URL scheme: `/tiles/earth/{layer}/{face}/{L}/{x}/{y}.{ext}` backed by pack lookups. Include `index.json` with the layer list, level ranges, encoding, source attribution, and a content hash for cache busting.
7. **Verification tests**: round-trip sample lon/lat lookups through the cube mapping and compare to the source rasters (RMS under half a texel), confirm seamless edges across all 12 cube edges, check known heights (Mt Everest 8848 m, Challenger Deep ~ -10935 m, Florida 0-30 m).

## 5. What to bake where, with disk estimates

- **Global**: color L0-L6 (24,576 tiles at L6; total 32,766 tiles) ~ 50-70 KB each -> **~2 GB**. Heights L0-L7 at 256 samples (131,070 tiles; ocean tiles compress to a few KB) -> **~3-5 GB**, or stop at L6 for ~1.3 GB. Night lights L0-L5 (gray JPEG, 8,190 tiles ~15 KB) -> 0.1 GB. Cloud pyramid L0-L5 (8-bit, 2 channels) -> 0.3 GB. Land/water+spec masks -> 0.15 GB.
- **Raw downloads kept in cache** (deletable after bake): BMNG 1 month 360 MB, GEBCO zip 4.2 GB (+7.5 GB unpacked, temporary), Black Marble 8-200 MB, clouds ~40 MB. Total transient ~13 GB, permanent global tiles ~6-8 GB.
- **Regional around the launch site** (radius 100 km: ~4e-4 of a face): color L7-L11 from S2 (~2,300 tiles x 100 KB) -> **~0.25 GB** (add L12 for a 25 km radius ~ 340 tiles ~ 0.04 GB; deeper than that is procedural); heights L8-L12 (L11 ~ 1,700 tiles, L12 ~ 7k tiles) -> **~0.3 GB**; WorldCover/ land class -> 0.05 GB. Region total < 1 GB.
- **Other regional zones**: ocean splashdown does not need dedicated baking: open ocean has smooth bathymetry and is rendered by the ocean shader (FFT waves + color from depth/foam), so global L6/L7 is enough. Optionally bake a small "recovery island" detail if a zone is within ~300 km of land.
- Overall budget well under 12 GB on disk; leaves room under the 20 GB cap for a Moon pyramid and a second month of Blue Marble.

## 6. Launch site and recovery zones (recommendation)

- **Launch site (fictional)**: "Meridian Point Launch Complex" at approx **27.78 N, 80.42 W**, on the open Atlantic barrier-island coast of east-central Florida (south of the real Cape/KSC, near Sebastian Inlet), pad facing east over water. A due-east launch (azimuth 90 degrees) gives a 27.78 degree parking orbit inclination, close to Apollo's 28.5 degree, a good geometry for translunar injection, and ground track stays over open ocean. Earth rotation boost at that latitude ~ 411 m/s. Data check: Terrarium z12 tile x1132 y1718 (81 KB), z15 x9063 y13750 (63 KB), GLO-30 tile `N27_00_W081_00` (site is at 27.78 N, 80.42 W, so that tile plus `N27_00_W080_00` cover it), GIBS BMNG L7 r27 c44, EOX 2024 z12 col1132/row1718 all returned 200. Make the coords a data field (`launchSites/meridian-point.json`).
- Alternate equatorial option (if the design prefers Kourou geometry): coast near 5.2 N, 52.8 W; same pipeline, only region polygons change.
- **Splashdown zones**: primary **central Pacific ~18 N, 168 W** (open ocean, hundreds of km from land, Apollo-style post-lunar return); secondary **Atlantic ~27 N, 60 W** (drifting recovery range for aborts/LEO return). Final choice follows the return trajectory the flight team flies; the sim should accept any landing, not these two points specifically.

## 7. Lazy upstream tiles via a caching proxy

Only suited, verified services (all return 200 with permissive CORS or can be called server-side):
- **Terrarium** (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) for deeper height tiles, fast, no auth, no stated limit; AWS S3 so heavy parallelism (50+ req/s) is fine.
- **EOX s2cloudless-2024/2025** (`tiles.maps.eox.at`) for color down to z13 (non-commercial). Serve, cache, and set `User-Agent` and attribution; stay at a polite 10-20 req/s, retry with backoff.
- **GIBS** (`gibs.earthdata.nasa.gov`) for BMNG, Black Marble, geostationary clouds, MODIS daily; cache by (layer, date, tile). Do not rely on it at runtime in a shipped build.
- **Copernicus/WorldCover/GFS S3 buckets** are range-readable but are bake-time only.

Proxy design (Node, `tools/tile-server`): `GET /tiles/earth/{layer}/{face}/{L}/{x}/{y}` -> on a baked hit serve from the pack; on a miss compute the cube tile footprint, determine the Web-Mercator (or EPSG:4326) upstream tiles that cover it (with margin), fetch them with a concurrency limit and request coalescing, reproject/resample to the cube tile in a worker (`sharp` for decode, custom bilinear math), write to `data/cache/lazy/...` on disk, return it with `Cache-Control: immutable`. Also serve an offline mode flag: when `OFFLINE=1`, misses return 404 and the renderer falls back to the procedural detail and next-coarser level, so **the core mission never depends on an upstream being up once the regional bake is done**.

## 8. Findings that change the plan (flag to lead)

1. Old `eoimages.gsfc.nasa.gov` URLs (and tutorials pointing to them) are dead; use `assets.science.nasa.gov/.../bmng/...`.
2. GIBS EPSG:4326 500 m layers stop at **level 7** (not 8); tile span is **288/2^L degrees**, origin top-left (-180, 90).
3. Best truly cloud-free global albedo is BMNG (463 m, ~2004 imagery); Sentinel-2 cloudless (10 m) has an **NC license** and goes soft past z13.
4. A real "high-res cloud map" is only available as bake-time snapshots (Matt Eason 8192x4096, GOES/Himawari composites), none as a durable official 16k product; plan procedural volumetric clouds seeded by GFS data rather than relying on a texture alone.
5. Terrarium is derived and mixed-source; for global base use GEBCO/ETOPO and use Terrarium regionally, otherwise bathymetry detail at z>9 is fake.
