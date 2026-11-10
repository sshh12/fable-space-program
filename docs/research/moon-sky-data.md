# Moon + Sky data: verified sources, bake pipeline, procedural amplification

Probed 2026-11-09/10 with HEAD, Range and small-window reads. Every URL, size and header below was actually fetched unless tagged **[unverified]**. Machine: Win11, Python 3.10, pip.

## 0. Key findings (read this first)

0. **Georeferencing of the raw LOLA `.img` was verified by reading single pixels over HTTP Range**: `ldem_64.img` gives Tranquility (0.67N, 23.47E) = -1925 m, Tycho floor -1295 m (rim-side -3407 m), Apollo 17 -2624 m, Aitken basin -6948 m, all relative to 1737.4 km. Layout is row 0 = 90N, col 0 = 0 deg E, east-positive, pixel-registered, int16 little-endian, `radius_m = DN*0.5 + 1737400`.
2. **PDS (`pds-geosciences.wustl.edu`) and USGS/S3 support HTTP Range**, so regional windows of huge rasters can be pulled without a full download. USGS S3 sends `Access-Control-Allow-Origin: *`; the PDS GEO node does not (build-time only, never runtime).
3. **JPEG2000 from PDS did NOT decode** (SLDEM2015 256ppd tile, 192 MB, downloaded fully: GDAL 3.10.3 JP2OpenJPEG opens the header fine, then `opj_decode or opj_end_decompress failed` on every read; `imagecodecs.jpeg2k_decode` fails the same way). **Use the raw `.img` / float `.img` / USGS GeoTIFF files instead of `.jp2`.**
4. **NASA Moon Trek elevation WMTS is unusable for real heights**: DEM tiles are 8-bit `LA` PNG (not metric), and the tile pyramid stops at level 5 (~45 ppd). Trek WAC imagery WMTS is fine (CORS `*`, JPEG, levels 0-8) but is only a fallback/preview source.
5. **The USGS 100 m WAC mosaic is the "morphology" mosaic: lighting is baked in** (incidence 55-75 deg). It is not an albedo map. For physically based shading the albedo must come from the **Hapke-normalized** mosaic, which is what the NASA SVS CGI Moon Kit is derived from (but SVS is only ~400 m/px; see 1.1).
6. The SVS Deep Star Maps 2020 ship the Milky Way background and the bright (Hipparcos+Tycho) stars as **separate** layers, which is exactly what a renderer wants.

## 1. The Moon

Reference sphere everywhere: **R = 1737.4 km** (IAU/LOLA). Moon-fixed lon positive east, maps centered on 0 deg lon unless noted. Mean-Earth/polar-axis frame (the "Moon_2000" CRS in the labels).

### 1.1 Global color / albedo

| Source | URL | Format / size | Res. | License | CORS |
|---|---|---|---|---|---|
| **NASA SVS CGI Moon Kit (2025 color)** | `https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb.tif` | 16-bit sRGB TIFF, 2,618,490,100 B (2.6 GB); also `_16k.tif` 953,573,340 B, `_8k.tif` 243,289,792 B, `_4k.tif`; linear float16 EXR `lroc_color.exr` 988,589,585 B | full ~27360x13680 (~400 m/px, ~76 ppd) | NASA media: public domain, credit "NASA/Goddard/Arizona State University/SVS" | no (origin-whitelisted) -> build time only |
| SVS CGI Moon Kit (2019 color) | `.../a004720/lroc_color_poles.tif` (518,090,428 B, 27360x13680, 4 bands RGBA uint8 LZW), `lroc_color_poles_16k.tif` 187,004,094 B, `_8k` 50,641,970 B, `_4k` 13,095,388 B, `_2k` 3,339,438 B | 8-bit | same | same | no |
| USGS WAC global mosaic 100 m (morphology, shaded) | `https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif` -> 302 -> `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/...` | uint8 mono GeoTIFF, **5,959,263,751 B**, 109164x54582, strip-based uncompressed (1 row/strip), no overviews, Range OK | 100 m/px (303 ppd), 643 nm | USGS Astrogeology: public domain, credit LROC/ASU/NASA | `*` |
| NASA Moon Trek WMTS (WAC) | `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{row}/{col}.jpg`, capabilities at `.../1.0.0/WMTSCapabilities.xml` | JPEG 256 px, TileMatrixSet `default028mm`, plate carree, level 0 = 2x1 tiles, **max level 8** (512x256 tiles; 9 returns 404), top-left -180/90 | up to ~100 m | NASA, public | `*` |
| PDS LROC WAC polar BDR | `https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/BDR/WAC_GLOBAL/WAC_GLOBAL_P900N0000_100M.IMG` (302 -> pds.mcp.nasa.gov), 1,387,190,024 B | PDS3 IMG polar stereographic | 100 m | public | n/a |

Notes:
- SVS color = LROC WAC 643/566/415 nm as R/G/B, from the Hapke-normalized WAC mosaic, data to +-70 deg lat, poles inpainted, exposure/white balance tuned to human vision. Albedo-like, **no baked shadows**. 2025 version is better (more dynamic range, better poles); credit in SVS page https://svs.gsfc.nasa.gov/4720/.
- The raw Hapke-normalized WAC 100 m mosaic (the SVS source) lives in the LROC PDS archive; **I could not resolve its exact file path** (PDS archive directory pages are JS-rendered) **[unverified]**. Worth a follow-up; it would give a 100 m albedo luminance with no baked shadows. Until then, use SVS color as the low-frequency albedo and the 100 m morphology mosaic only as *detail* (see 3.6).
- Moon is gray with subtle color; keep the SVS chroma but treat it as multiplicative albedo in linear space (typical lunar normal albedo ~0.07-0.12, highlands ~0.15-0.25, fresh ejecta/rays higher). Calibrate global scale so mare reflectance ~0.07 at 643 nm.

### 1.2 Global elevation

| Source | URL | Format / size | Res. | Notes |
|---|---|---|---|---|
| **LOLA LDEM 64 ppd raw** | `https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img` (+ `.lbl`) | int16 LE, 23040x11520, **530,841,600 B**, Range OK | 474 m | verified pixels (see 0.1); `r = DN*0.5+1737400`. Also `jp2/ldem_64.jp2` 211,190,204 B (decode unreliable) |
| LOLA LDEM 128 ppd | `.../cylindrical/float_img/ldem_128_float.img` 4,246,732,800 B (float32 km); `jp2/ldem_128.jp2` 647,268,591 B; SVS: `ldem_16.tif` 66,378,634 B, `ldem_16_uint.tif` 33,201,026 B, `ldem_64.tif` 1,061,775,722 B (float32 TIFF 23040x11520), `ldem_64_uint.tif` 530,934,146 B | | 237 m | 128 ppd grid = 46080x23040; label `jp2/ldem_128_jp2.lbl` gives SCALING_FACTOR 0.5, OFFSET 1737400, UNIT METER |
| **LOLA LDEM 256 ppd** (4 quadrants) | `.../cylindrical/img/ldem_256_00n_90n_000_180.img` etc. (and `_90s_00s_`, `_180_360`), each **2,123,366,400 B** int16; float variants `float_img/ldem_256_*_float.img`; `jp2/ldem_256.jp2` 1,645,246,858 B | | 118 m | 4 files = 8.5 GB |
| **USGS LOLA 118 m global (single file)** | `https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif` -> `asc-pds-services.s3...` | int16 GeoTIFF **8,494,203,833 B**, 92160x46080, nodata -32768, strip-based, Range OK (window read 6.7 s) | 118 m | CORS `*`; **best single global height file**; remote windowed read works |
| LOLA 512/1024 ppd tiles | `.../img/ldem_1024_00n_15n_000_030.img`, `jp2/ldem_1024_00n_15n_000_030.jp2` 86,925,468 B; `float_img/ldem_512_00n_45n_000_090_float.img` 4,246,732,800 B each (16 of them = 68 GB) | | 30 m / 59 m (polar regions only have this resolution from LOLA alone) | regional/polar only |
| **SLDEM2015 (LOLA+Kaguya TC), global +-60 deg** | USGS: `https://planetarymaps.usgs.gov/mosaic/LolaKaguya_Topo/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif` -> S3 | int16 GeoTIFF **22,650,225,603 B**, 184320x61440, nodata -32768, strip-based, Range OK (window read 11.5 s) | **59 m**, vertical ~3-4 m (Barker et al. 2016, Icarus 273, doi:10.1016/j.icarus.2015.07.039) | **never download whole; window-read per landing region** |
| SLDEM2015 on PDS | `https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/global/float_img/sldem2015_128_60s_60n_000_360_float.img` 2,831,155,200 B (15360x46080 float32 km); `global/jp2/sldem2015_128_60s_60n_000_360.jp2` 495,358,026 B; `tiles/float_img/sldem2015_256_0n_60n_000_120_float.img` 1,887,436,800 B (30720x15360, float32 km, Range OK); `tiles/jp2/sldem2015_256_{0n_60n|60s_0n}_{000_120|120_240|240_360}.jp2` | | 118 m (256 ppd) | `.lbl` gives LINE_PROJECTION_OFFSET 15359.5 / SAMPLE_PROJECTION_OFFSET 46079.5; the 000_120 tile label prints W/E longitudes of -180/-60 which contradicts its file name. **Verify lon convention of tile files against LOLA ldem_64 before use [unverified]**; the USGS single-file TIF avoids this problem |
| NASA Moon Trek elevation WMTS | `https://trek.nasa.gov/tiles/Moon/EQ/LRO_LOLA_DEM_Global_128ppd_v04/1.0.0/...` | 8-bit LA PNG, max level 5 | -- | **not usable for metric heights** |

LOLA/SLDEM data are NASA PDS products (public domain; cite LOLA Team, Smith et al. 2010; SLDEM2015: Barker et al. 2016). Kaguya (SELENE) TC data redistributed in SLDEM2015 are JAXA, cite Haruyama et al. 2008.

### 1.3 Regional high-res for the landing region

Recommended default site: **Mare Tranquillitatis, Apollo 11 area (0.67N, 23.47E)** because the LROC team ships a verified NAC stereo DTM + ortho there, and the surroundings are flat enough for a hand-flown first landing. Second site for variety/hazard: **Apollo 17, Taurus-Littrow (20.19N, 30.77E)**. Both sit inside SLDEM2015 coverage.

| Product | URL | Facts |
|---|---|---|
| Apollo 11 NAC DTM | `https://pds.lroc.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO11/NAC_DTM_APOLLO11.TIF` (302 -> `pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/...`) | float32 GeoTIFF **118,142,727 B**, 2111x13978, **2 m post**, nodata -3.4e38, window read OK (1.3 s). Extents lat 0.3146..1.2365, lon 23.3723..23.5115. Vertical: precision 0.77 m, tied to LOLA with RMS 1.81 m. README: `.../APOLLO11/NAC_DTM_APOLLO11_README.TXT`. Browse images at `http://lroc.sese.asu.edu/data/.../EXTRAS/BROWSE/NAC_DTM/APOLLO11/` (`..._M150361817_50CM.BROWSE.PNG`, `..._M150368601_50CM.BROWSE.PNG` are the 0.5 m orthophoto browses) |
| Apollo 17 NAC DTM | `.../NAC_DTM/APOLLO17/NAC_DTM_APOLLO17.TIF` | 463,397,471 B |
| NAC DTM catalog | `https://wms.lroc.asu.edu/lroc/view_rdr/NAC_DTM_APOLLO11` (and `..._APOLLO17`; same pattern for every site) | HTML 200 |
| NAC ortho (0.5 m / 2 m) | exact `.TIF` file names for the orthophotos **not resolved [unverified]**: guessed names `NAC_DTM_APOLLO11_M150361817_{2M,50CM}.TIF` returned 404; the archive directory index is JS-rendered. Follow-up: read the PDS4 collection inventory CSV under `pds.mcp.nasa.gov/.../lro-l-lroc-5-rdr/LROLRC_2001/` or the LROC "Download" button on the view_rdr page | |
| Kaguya TC (10 m) | only redistributed inside SLDEM2015 for height; TC ortho tiles from JAXA SELENE archive (DARTS, https://darts.isas.jaxa.jp/planet/pdap/selene/) **[unverified]** | |
| Polar LOLA DEMs 5/10/20 m (Shackleton etc.) | PDS `LRO-L-LOLA-3-RDR-V1` polar GDR **[unverified]**; keep as future-site data | |

Resolution reality at touchdown: SLDEM2015 gives 59 m posts (hills, large craters ~>300 m). The NAC DTM gives 2 m posts but only a 4 km x 28 km strip. **Everywhere else below ~60 m, all the "ground detail" a landing sees must be procedural** (section 3). NAC orthophotos (0.5 m) cover only the strips, so albedo detail should also be procedural with the NAC ortho blended in where present.

### 1.4 Runtime vs build-time

- **Everything the core mission needs is baked locally** (design requirement: no dependency on upstream once prepared). No upstream service sends CORS for PDS/SVS except USGS S3 and Trek (both `Access-Control-Allow-Origin: *`).
- Optional lazy fallback: Trek WAC JPEG tiles (CORS `*`) can fill extra imagery detail at random sites; cache to disk via the local tile server. Not needed for the Apollo 11 mission.

## 2. Sky: stars, Milky Way, Sun

### 2.1 Star catalogs

| Catalog | URL | Size | Contents | License |
|---|---|---|---|---|
| **HYG v4.1** | `https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv` (CSV, 33,932,548 B; `hygdata_v40.csv.gz` 13,636,420 B) | ~120k stars | columns: `id,hip,hd,hr,gl,bf,proper,ra(h),dec(deg),dist(pc),pmra,pmdec,rv,mag,absmag,spect,ci(B-V),x,y,z,vx,vy,vz,rarad,decrad,...,con,lum,var...`; row 0 = Sol. **ra is in hours** (also `rarad`), epoch J2000 | **CC BY-SA 4.0** (attribute; share-alike applies to the derived star table, so ship it as an explicitly attributed data file) |
| Yale BSC5 / Hipparcos / Tycho-2 (CDS, VizieR I/239, I/259, V/50) | `https://cdsarc.cds.unistra.fr/ftp/I/239/`, `I/259/`, `V/50/` | | | CDS FTP **timed out repeatedly**, directory listings empty from this machine **[unverified]**; use SVS layers below instead of re-deriving from CDS |
| Gaia EDR3 sky map (ESA) | guessed `sci.esa.int` / `cosmos.esa.int` image URLs returned 404 **[unverified]** | | | ESA CC BY-SA 3.0 IGO |

Use HYG for: named stars, constellation labels/lines, map-view markers, navigation-star UX, and ~170 brightest stars (mag < ~3.5) drawn as individually PSF-rendered sprites with bloom. B-V `ci` -> color via blackbody mapping (Ballesteros formula `T = 4600*(1/(0.92*BV+1.7) + 1/(0.92*BV+0.62))`, then Planckian chromaticity -> linear sRGB). Flux from mag: `F = 10^(-0.4*mag)` relative to mag 0; Vega ~ 3.6e-8 W/m^2 (V band), Sirius -1.46.

### 2.2 Milky Way and deep star maps

**NASA SVS "Deep Star Maps 2020"** (https://svs.gsfc.nasa.gov/4851/; Ernie Wright; 1.7 billion stars from Hipparcos-2, Tycho-2, Gaia DR2 + Yale BSC/UCAC3/XHIP; plate carree, OpenEXR half-float, **linear**, celestial ICRF/J2000 RA/Dec or `_gal` galactic coordinates; public domain, credit NASA/Goddard SVS). Base URL `https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/` (no useful CORS -> build time only):

| File | Bytes |
|---|---|
| `milkyway_2020_4k.exr` | 36,436,668 |
| `milkyway_2020_8k.exr` | 137,307,727 |
| **`milkyway_2020_16k.exr`** (background, no Hip/Tycho stars) | 434,041,232 |
| `milkyway_2020_32k.exr` | 1,509,917,679 |
| `hiptyc_2020_4k.exr` / 8k / 16k | 21,251,204 / 50,588,860 / 71,265,298 |
| **`hiptyc_2020_32k.exr`** (bright Hipparcos+Tycho star layer, to mag ~11.5) | 138,525,184 |
| `hiptyc_2020_64k.exr` | 247,972,180 |
| combined `starmap_2020_4k.exr` 35,997,085; `_8k` 130,530,278; `_16k` 443,485,587; `_4k_gal` 40,550,793; `_8k_gal` 160,735,772; `_16k_gal` 384,152,397 | |
| `constellation_figures_4k.tif` | 369,986 (grayscale) |
| (`_gal` variants also exist for milkyway/hiptyc at all sizes) | |

**ESO Milky Way panorama** (eso0932a, Serge Brunier): `https://cdn.eso.org/images/original/eso0932a.tif` (29,082,084 B), `.../publicationjpg/eso0932a.jpg` 4,857,484 B, 6000x3000 galactic-coordinate plate carree; ESO license is CC BY 4.0 (verify on the ESO page: https://www.eso.org/public/images/eso0932a/). Only 6000x3000, a photograph (not linear), useful only as a visual reference/cross-check. **Not recommended as the shipped background**: low-res and un-calibrated relative to catalog stars.

Recommendation: **Use SVS only**. Milky Way background = `milkyway_2020_16k.exr` (celestial coords, matches the J2000 inertial frame the sim already needs); stars = `hiptyc_2020_32k.exr` plus HYG-derived sprites for the brightest ~170. Because SVS split the layers, there is no double counting of faint stars (milkyway has them removed). At bake time, inpaint (median fill) out of the hiptyc layer every star with mag < 3.5 and draw those from HYG as sprites with diffraction/bloom so they can have correct magnitude-dependent glare.

Exposure calibration: SVS EXR pixel scale is arbitrary; calibrate by summing hiptyc flux around a handful of known stars (Sirius, Vega, Canopus) vs `10^(-0.4*mag)` and fit one scalar. Do the star-density check with a brightness count histogram against HYG.

Frame conversion: EXR plate carree has RA increasing to the **left**? (SVS maps put RA 0 at image center and increase leftward as seen from inside the sphere.) **Verify orientation with Sirius (RA 6h45m, Dec -16.7) and Polaris** when baking **[unverified]**.

### 2.3 Sun

- Solar constant (TSI) 1361 W/m^2 at 1 AU; mean luminous efficacy gives ~128,000 lux at 1 AU; Sun angular radius 0.2666 deg at 1 AU (959.63 arcsec). Radius 695,700 km (IAU 2015 nominal).
- Spectrum: use **ASTM E-490 / NREL G-173 reference** (https://www.nrel.gov/grid/solar-resource/spectra-am1.5.html) or simply a 5772 K blackbody scaled to TSI (effective temperature, IAU 2015) for the exo-atmospheric sun, reduced to RGB in linear Rec.709 -> near neutral white; atmosphere scattering will provide the sunset reddening. No file download needed; **[not probed]**.
- Limb darkening: use the Claret (2000) / Neckel & Labs (1994) form `I(mu)/I(1) = 1 - u(1-mu)` (linear approx) per channel, approximately u ~ 0.45 (650 nm), 0.60 (550 nm), 0.78 (450 nm) **[approximate, from memory, not probed]**; fit a quadratic `1 - a(1-mu) - b(1-mu)^2` against Neckel-Labs table in the bake script for the visible solar disk and sunset. Matters for sun disk appearance in-orbit and at terminator grazing.

## 3. Recommended bake pipeline (shared Earth + Moon)

### 3.1 Environment (verified on this machine)

`python -m venv v; v\Scripts\pip install rasterio numpy pillow OpenEXR imagecodecs scipy` installs cleanly (Windows, CPython 3.10): **rasterio 1.4.4 bundling GDAL 3.10.3** with drivers `COG, ISIS3, ISIS2, PDS, PDS4, JP2OpenJPEG, ENVI` present; numpy 2.2.6, scipy 1.15.3, Pillow 12.2 already available; `OpenEXR` and `imagecodecs` import fine. Caveat: JP2OpenJPEG decode of PDS jp2 files fails (see finding 3 in section 0); avoid jp2.
Run scripts with `python -I` and put downloads in their own directory (untrusted data).

### 3.2 Source handling

- Raw PDS `.img` + `.lbl`: read with `numpy.memmap` (little-endian int16/float32; shape from label) or `rasterio` (PDS driver or an ENVI-style VRT). Streaming windows via HTTP Range (`urllib` or GDAL `/vsicurl/`) works for `pds-geosciences` and S3 (GDAL `/vsicurl/` on the strip-based TIFFs works: ~5-12 s per 512x512 window because whole rows are fetched, so fetch large row blocks and cache).
- Download-and-delete for big rasters (WAC 5.96 GB, LDEM 118 m 8.5 GB, SVS color 2.6 GB). Never store SLDEM 22.6 GB: window-read the landing region only (e.g. 8x8 deg = 4096x4096 px of 16-bit = 32 MB).
- Plate carree -> pyramid: build an area-averaged mip pyramid of each source (GDAL overviews or numpy 2x2 mean; heights averaged in float32).

### 3.3 Equirect -> cube-face quadtree tiles

- Cube sphere with **equiangular (tan-warped) face mapping**, `u = tan(pi/4 * s)`, s in [-1,1]; texel area ratio ~1.4 vs 5.2 for gnomonic. Same layout for Earth and Moon: 6 faces, quadtree level L, tile T = 256 px (+1 px shared border for heights, i.e. 257x257, so geomorphing and normals are seamless).
- For each tile pixel: direction -> (lon, lat) in the body frame -> sample source. Pick the source mip whose px size is closest to the tile px size (trilinear), bicubic within a mip; wrap lon, clamp lat. Do per tile with `scipy.ndimage.map_coordinates` over a source window slice (tile footprint + margin) so each tile only touches a small piece of memory. Parallelize with `multiprocessing` per face-row.
- Output layout (uniform URL scheme, same for every body): `/tiles/{body}/{layer}/{L}/{face}/{x}/{y}.{ext}`; plus `manifest.json` per body/layer with `{levelMin, levelMax, tileSize, border, encoding, scale, offset, radiusM, regions[]}`.
- Encodings: **albedo = JPEG/WebP (decoded with `createImageBitmap`, 8-bit sRGB)**. **Heights must NOT be PNG/WebP via image decode** (browser canvas paths quantize to 8 bits and premultiply alpha). Ship heights as raw uint16 (`(h - base)/step`, per-manifest step ~0.5 m, per-tile min/max header) with a delta/predictor filter then Brotli (served `Content-Encoding: br`) or decoded with `DecompressionStream` in a worker -> upload to an `r16uint`/`r32float` texture. Hillshade-free: normals computed on GPU from height + border.
- Poles: WAC color valid to 70 deg only (SVS is inpainted); for |lat| > 70, albedo is from SVS inpaint only; heights are fine (LOLA covers poles, SLDEM does not: merge SLDEM 59 m inside +-60 deg over LOLA 118 m, blend over a 2-degree band).
- Quick sanity check script: compare `ldem_64` sampled heights of the baked L5 tiles with the 4 verified benchmarks in 0.1 (they must agree within ~50 m).

### 3.4 Levels and sizes

Cube face = 90 deg = 2.73e3 km at center. m/px at equatorial center for T=256: L5 333, L6 166, L7 83, L8 41.6, L9 20.8, L10 10.4, L11 5.2, L12 2.6, L13 1.3, L14 0.65 m.

| Layer | Global levels | Source | Tiles | Est. size |
|---|---|---|---|---|
| Albedo color (RGB JPEG q85, ~30 KB/tile) | L0-L5 (8,190 tiles) | SVS 2025 color (~400 m/px) | 8,190 | ~0.25 GB |
| Albedo detail (mono WebP/JPEG ~18 KB) | L6-L7 | WAC 100 m morphology, high-passed (3.6) | 122,880+? (only L6: 24,576; L7: 98,304) | ~0.45 GB + ~1.8 GB (skip L7 if disk is tight) |
| Heights (u16, ~60 KB/tile after br) | **L0-L6** (32,766 tiles) | LOLA 118 m (USGS TIF) | 32,766 | ~2 GB |
| Heights L7 | optional | SLDEM 59 m, +-60 deg only | ~65k within band | ~4 GB (skip; do regional) |
| Regional heights (landing site), 30 km x 30 km box | L7-L12 | SLDEM2015 59 m -> L7-L9, NAC DTM 2 m -> L10-L12 | ~2,300 | ~140 MB |
| Regional albedo, same box | L8-L12 | upsampled SVS+WAC detail blended with NAC ortho 0.5 m where present | ~2,300 | ~70 MB |
| Stars | n/a | milkyway_2020_16k + hiptyc_2020_32k -> 6 cube faces | | BC6H 4096^2 faces ~100 MB, or rgb9e5 2048^2 faces 100 MB (4096^2 rgb9e5 = 403 MB) |

Peak raw/work disk if we keep every download until the bake finishes: ~16 GB (WAC 6.0 + LDEM 118 m 8.5 + SVS 2.6 + EXR 0.57 GB + misc); delete after bake. **Final baked Moon + sky: ~5-7 GB** (global ~4.5 GB if L7 mono detail included, regions < 0.3 GB each). This fits with Earth in the ~20 GB budget if Earth stays under ~12 GB.

Landing region resolution check: L12 = 2.6 m/px matches the 2 m NAC DTM; beyond L12 nothing real exists, procedural takes over (3.5).

### 3.5 Build order and incremental region pipeline

`tools/bake/` (shared with Earth): `fetch.py` (resumable Range downloader, size/checksum manifest), `pyramid.py` (equirect -> mips), `cubetiles.py` (mip -> face tiles + manifest), `regions/<site>.json` (center lat/lon, extent km, source list, level range), `stars.py` (EXR -> cubemaps, star inpaint, HYG -> binary table: `float32[ra,dec,mag,r,g,b]`). A region bake only reads a window of SLDEM/NAC and writes levels > global max, so adding a new landing site is data-only.

### 3.6 Albedo composition

`albedo(x) = SVS_RGB(x) * (detail_L(x))` with `detail = mono_100m / lowpass(mono_100m)` clamped to [0.7, 1.3], where lowpass is the 400 m footprint, and the high-pass energy is **attenuated where morphology-mosaic shadows are strong** (use LOLA-slope-based mask: the morphology mosaic's shading correlates with slope facing the sun; subtract a modeled Lambert/Lommel-Seeliger hillshade at the WAC incidence angle using the local DEM before high-passing). This keeps crater-ray and small albedo structure but removes baked shadows. Verify visually by checking that crater walls facing east and west have equal albedo after the correction.

## 4. Procedural terrain amplification below data resolution

Goal: from 59 m (global) and 2 m (Apollo strip) native data down to centimeter scale while remaining deterministic (same function on GPU for rendering and in TS for collision/landing physics).

### 4.1 Architecture

Final height at point p (body-fixed unit vector, level-L tile) = `H_data(p)` (bicubic of the baked tiles) + `Sum over octaves k > k_data of dH_k(p)`, where each octave is generated in cells of size `s_k = 2^k m` using an **integer hash of (face, cell x, cell y, k, bodySeed)** so there is no storage, no tile boundary artifacts, and bit-identical output on CPU (TS, with `Math.imul` PCG) and GPU (WGSL u32). Octaves fade in with the LOD morph weight so geomorphing never pops. Collision uses octaves down to ~0.5 m (landing leg scale); finer octaves are normal/displacement-only.

### 4.2 Craters: size-frequency distribution

- Number per octave from the **Neukum (2001) lunar production function** (cumulative, per km^2, D in km, a_n polynomial in log10 D): `log10 N(>D) = -3.0768 - 3.557528 x + 0.781027 x^2 + 1.021521 x^3 - 0.156012 x^4 - 0.444058 x^5 + 0.019977 x^6 + 0.086850 x^7 - 0.005874 x^8 - 0.006809 x^9 + 8.25e-4 x^10 + 5.54e-5 x^11`, x = log10 D, for a 1 Gyr surface; scale by surface age (mare Tranquillitatis ~3.6 Gyr; highlands ~4.2+). **Coefficients recalled from memory; verify against Neukum et al. 2001 (Space Sci. Rev. 96, 55) before shipping [unverified]**. For D below ~100 m the observed population is in **equilibrium saturation** (cumulative slope -2): cap density at `N_eq(>D) = 0.03 * 1.54 * D_km^-2` per km^2 (about 1-5% of geometric saturation 1.54 D^-2 per km^2; Gault 1970 / Hartmann 1984 / Trask 1966; tune 1-5%).
- Depth/diameter by degradation class: fresh simple craters `d/D ~ 0.196` (Pike 1977), mature `0.10-0.14`, old/degraded `0.03-0.07`; transition to complex craters (central peak, flatter floor, terraces) at `D ~ 15-20 km` (irrelevant for amplification, since those are in the data).
- Profile: parabolic bowl + raised rim: `h(r) = -d (1 - (r/R)^2)` inside, rim height `~0.036 D^1.014` (Pike), exterior ejecta blanket thickness `~ 0.14 R (r/R)^-3`, diffusion-smoothed by age (Gaussian blur radius grows with degradation class). Superposed small craters on rims/walls come naturally from independent octave placement.
- Obvious problem: placement must not double-count real craters already in the DEM. Handle by applying procedural craters only with `D < 4 * data_posting` (< ~240 m at the global posting, < ~8 m over the NAC strip), and statistically thin by the existing-crater density estimated from the DEM roughness (optional; the visual penalty of a slight excess is low).
- Optional: seed known large craters exactly with the **Robbins (2019) Moon crater database** (>1 km, ~1.3 M; https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins) **[URL not probed]**; not needed for rendering since the DEM already contains them.

### 4.3 Regolith / microrelief

- Add fBm / ridge-free noise over scales 0.3 m - 50 m with Hurst exponent **H ~ 0.8-0.95** (smooth, self-affine; measured lunar mare topographic roughness gives RMS slope ~ 3-8 deg at 1-10 m baselines, higher in highlands, per LOLA/LROC statistics); amplitude per octave tuned so RMS slope at the 2 m scale matches the NAC DTM over the strip (calibrate once: compute RMS slope of the real NAC DTM at 2, 4, 8 m baselines; extrapolate the power law down to 5 cm). Verify at the Apollo 11 NAC strip that the added noise does not exceed the DTM's own roughness.
- Add an **anisotropic downslope-creep smoothing** (slope-dependent amplitude: lower on > 15 deg slopes where the regolith has slumped).
- Fine detail < 5 cm: tileable normal map (triplanar, two scales) with footprint/bootprint-friendly dust, and a Lommel-Seeliger/Hapke shading term.

### 4.4 Rocks

- Cumulative rock size-frequency by Golombek & Rapp (1997): fractional area covered by rocks larger than D: `F(D) = k * exp(-q(k) * D)`, with `q(k) = 1.79 + 0.152 / k` (D in meters), total rock-covered area k ~ 0.01-0.03 typical mare, ~0.10-0.30 on fresh crater ejecta, falling with ejecta age; densest around fresh craters >100 m. **Constants from memory [unverified]**.
- Place by the same cell-hash with Poisson thinning. Instance a small library (~12 rock meshes: angular blocks, vesicular basalt, breccia) with random scale/orientation/burial, drawn out to ~300 m with GPU instancing; beyond that they feed the shading as microrelief only. Rock count inside the final descent cone (say 200 m radius, D > 0.3 m) is only a few thousand: fine.
- Collision: rocks > 0.3 m are collidable in the physics (TS, same hash) so legs can hit them.

### 4.5 Shading (what makes it look lunar, not just rough)

- **Hapke** or Lommel-Seeliger BRDF: no limb darkening on the Moon; brightness stays flat toward the limb and spikes at zero phase (opposition surge, `B0 ~ 1.0-1.6`, `h ~ 0.05-0.1` in Hapke's formulation; mare single-scattering albedo `w ~ 0.2-0.3`, highlands higher; SVS color maps give the base). Use plain Lambert only as an emergency fallback.
- Black shadows: no atmosphere; only earthshine (Earth ~ 40-50x the brightness of full moon seen from Earth side) and local multiple scattering. Use the real Earth phase and Sun-Earth-Moon geometry for earthshine on the night side; a sun-direction shadow map (cascaded) plus horizon-aware contact shadow from the height pyramid.
- Dust: kicked-up regolith during descent (ballistic particles, no atmosphere so no billowing; long straight trajectories) and blast crater scouring beneath the engine for the last 50 m; the same procedural hash lets the plume modify a displacement decal.

### 4.6 LOD / popping

Procedural octaves are blended by `smoothstep` weights on the tile's screen-space texel size, never switched, and evaluated at the vertex (geomorph) and fragment (normal) separately. Octaves above the data resolution are enabled only when the projected texel size is below ~2 px.

## 5. Practical details and gotchas

- **Do not hard-code Apollo 11**: the region manifest schema (`regions/*.json`) lists `{id, body, centerLatLon, extentKm, sources[], levels}` so Taurus-Littrow, polar sites etc. are data.
- Rate-limit and be polite to `svs.gsfc.nasa.gov` (every file returned `access-control-allow-origin: https://tempo.multiverse.music`, i.e. no CORS for us; irrelevant at build time).
- `planetarymaps.usgs.gov` URLs 302-redirect to `asc-pds-services.s3.us-west-2.amazonaws.com`; point scripts at the S3 URL directly. Several guessed USGS names 404 (`Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif` without the `LolaKaguya_Topo/` folder, `_59m.tif`, `Lunar_Kaguya_*`): use the exact paths in the tables above.
- Other verified USGS items (not needed but available): `Lunar_LRO_LOLA_ClrShade_Global_128ppd_v04.tif` 3,185,603,207 B (color-coded hillshade), `Lunar_LRO_LOLA_Shade_Global_128ppd_v04.tif` 1,061,868,155 B.
- Attribution strings to ship in an in-game credits file: LROC/ASU/NASA; LOLA Team/NASA GSFC; SELENE/Kaguya (JAXA); NASA SVS CGI Moon Kit and Deep Star Maps 2020 (Ernie Wright); HYG database by David Nash (CC BY-SA 4.0).
- Disk accounting against the 20 GB cap: Moon+sky ~6 GB final; keep raw downloads only during bake.

## 6. Decision summary

1. Moon albedo: SVS 2025 color (Hapke-normalized, 2.6 GB TIFF, 400 m/px) to L5, plus WAC 100 m (S3, 5.96 GB) as shadow-corrected detail luminance for L6-L7.
2. Moon heights: USGS LOLA 118 m global TIFF (8.5 GB, Range) for L0-L6; SLDEM2015 59 m USGS TIFF (windowed, never fully downloaded) for the regional L7-L9; LROC NAC DTM (2 m) at L10-L12 for Apollo 11/17; procedural beyond.
3. Stars: SVS milkyway_2020_16k + hiptyc_2020_32k (EXR -> cube faces) + HYG v4.1 for sprites, labels, constellations.
4. Sun: TSI 1361 W/m^2, 5772 K blackbody (or G-173), angular radius 0.2666 deg at 1 AU, limb darkening law per channel.
5. Avoid: `.jp2` from PDS (decode failure), Trek DEM tiles (8-bit), canvas decode of 16-bit PNG heights, USGS 100 m WAC as albedo.
6. Unverified follow-ups: exact Hapke-normalized WAC path in PDS, NAC ortho TIF names, SLDEM tile longitude labelling, Neukum coefficients and Golombek-Rapp constants (recalled from memory), SVS EXR RA orientation, CDS star catalogs, polar LOLA DEM URLs.
