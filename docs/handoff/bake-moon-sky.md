# Hand-off: bake-moon-sky

Moon tile set (`data/tiles/moon`), sky data (`data/sky`), the tools that bake and verify them
(`tools/bake/moon`, `tools/bake/sky`), and the Tranquility landing region with the recommended touchdown
target (`data/defs/regions/moon-tranquility.json`). Baked data is git-ignored; everything is reproducible with
the commands below.

## 1. What consumers get

### Moon tile set `/tiles/moon/` (TileManifest, `src/core/contracts/terrain.ts`)

| | |
|---|---|
| Frame | lunar body-fixed, mean-Earth/polar-axis (the LOLA/LROC "Moon_2000" frame): +Z north pole, +X at 0 N 0 E, longitude east-positive, planetocentric latitude. Heights in metres above the 1,737,400 m sphere (`manifest.radius`). Mapping exactly `tools/bake/common/cube.py` / `src/core/geo/cubeSphere.ts`. |
| `height` | `frt1-height` (`.hgt`), `globalMaxLevel` 6 (all 32,766 tiles), regional levels 7-12 around Tranquility (1,038 tiles, coverage rectangles below). `heightScales` = 0.5 m (levels 0-6), 0.125 m (7-9), 0.03125 m (10-12); every tile uses its level's preferred scale. |
| `albedo` | `webp` 256 x 256, opaque RGB (lossy `VP8 `, no alpha anywhere), `globalMaxLevel` 7 (131,070 tiles), no regional albedo. sRGB-encoded **normal albedo** (decode sRGB to get linear albedo; red = 643 nm). No baked shading (section 4.2). |
| `globals.albedoLowRes` | `globals/albedo-lowres.png`, 1024 x 512, RGB, equirect, row 0 = north, column 0 = 180 W (same encoding as the tiles, SVS base only). |
| `residentHeightLevel` | 3 |
| `regions.json` | registry the region tool keeps (which region baked which rectangles); not part of the contract. |

Regional coverage (all on face 0; inclusive tile rectangles):

| Level | Rect (x0..x1, y0..y1) | Tiles | Data inside | Sample spacing at the site |
|---|---|---|---|---|
| 7 | 89..93, 63..66 | 20 | SLDEM2015 in the 20 km disc (feathered into LOLA over its outer 2 km), upsampled LOLA elsewhere | ~93 m |
| 8 | 180..186, 127..132 | 42 | same | ~46 m |
| 9 | 362..371, 255..263 | 90 | same | ~23 m |
| 10 | 731..736, 513..525 | 78 | LROC NAC DTM in its strip (feathered into SLDEM over 300 m), SLDEM/LOLA around it | ~11.6 m |
| 11 | 1464..1471, 1027..1050 | 192 | same | ~5.8 m |
| 12 | 2929..2942, 2056..2099 | 616 | same | ~2.9 m |

The coverage rectangles are the data areas (20 km disc; NAC footprint + 2 km) plus one tile on every side, closed
under parents, so every region of interest is at least a full tile inside its level's coverage and the
quarter-tile run-time blend ring always lies on parent-identical data.

### Landing target (`recommendedTarget` in `data/defs/regions/moon-tranquility.json`)

**0.661471 N, 23.435999 E, data height -1907.70 m** (level-12 data, i.e. radius 1,735,492.30 m), 1.18 km
west-south-west of the Apollo 11 LM. Criteria as measured on the baked level-12 data:

| Criterion | Requirement | Target |
|---|---|---|
| Slope over 100 m | < 3 deg | plane fit 1.14 deg; steepest 100 m baseline (8 directions) 1.38 deg |
| Craters >= 20 m | none within 150 m | nearest at 190.9 m (20 m, 2.85 m deep); detector finds the Apollo 11 neighbourhood craters (a 58 m crater 55 m from the LM = Little West's depression, West crater 198-256 m at 320-340 m) |
| Lit for Apollo-like sun | terrain horizon below the sun | horizon toward azimuths 75/90/105 deg (east, morning sun) at most -0.36 deg at the target and 50 m around it; lit for any sun elevation >= 0 deg there (checked with >= 5 deg and a 1 deg margin) |
| Coverage | 2 km disc >= 500 m inside level-12 coverage | the whole 2.5 km disc is inside; run-time coverage weight w_12 = 1 over the 2 km disc |
| Real high-resolution data | (preference) | 100 % of the 1.5 km mission disc is NAC data (NAC band weight 1) |

Selection used tightened criteria (slope < 2.25 deg, no crater within 190 m) and then the candidate nearest
the Apollo 11 site. `out/bake/moon/target.png` shows it.

### Sky `/sky/` (SkyManifest, `src/core/contracts/sky.ts`)

| | |
|---|---|
| `stars.f32` | 8,920 stars with V <= 6.5 (cutoff in the manifest), brightest first, Sol excluded; records exactly as the contract (unit direction J2000/ROOT, lux = 2.54e-6 * 10^(-0.4 V), linear-sRGB colour with luminance 1, V). Colour: blackbody at T(B-V) (Ballesteros 2012) through CIE 1931 (Wyman-Sloan-Shirley fit) to linear sRGB D65; B-V from HYG `ci`, or from the spectral class when missing (count in the bake report). |
| `named-stars.json` | `[{name, index}]` for every catalogue star with a HYG proper name. |
| `milkyway-{px,nx,py,ny,pz,nz}.rgb9e5` | 2048^2 faces, WebGPU cube order, each file = full mip chain (12 levels, level 0 first, rows top to bottom), raw little-endian `rgb9e5ufloat` (R bits 0-8, G 9-17, B 18-26, exponent 27-31). `textureSample(cube, dir)` with `dir` in ROOT axes returns the sky in that direction (Vulkan face table; checked on the CPU, section 3). |
| `luminanceScale` | 2.0258e-05 cd/m^2 per stored unit (stored = SVS starmap units x 2^13, a power of two chosen so the darkest sky stays in rgb9e5's normal range). |
| Content | SVS `milkyway_2020_16k` x 0.5 + SVS `hiptyc_2020_16k` with all 8,920 catalogue stars removed (the SVS combined map is exactly 0.5 x milkyway + 1.0 x hiptyc, fitted on the 4k triple to 0.2 %). |

## 2. How to run

Environment (once): `C:/Users/.../Python310/python.exe -m venv data/cache/moon/venv`, then
`data/cache/moon/venv/Scripts/python.exe -m pip install numpy scipy pillow OpenEXR tifffile rasterio psutil scikit-image`
(numpy 2.2.6, scipy 1.15.3, Pillow 12.3, OpenEXR 3.5.2, rasterio 1.4.4 / GDAL 3.10.3, scikit-image 0.25.2).
Every command runs from the repository root as `data/cache/moon/venv/Scripts/python.exe -I <script>`; each script
lowers itself to BELOW_NORMAL priority and uses at most 8 single-threaded worker processes.

| Step | Command | Wall time here | Network / disk |
|---|---|---|---|
| Global heights | `tools/bake/moon/heights_global.py` | 865 s (+15 s mips) | needs the 8.5 GB LOLA GeoTIFF in `data/cache/moon/dl/lola118/` (`python -I tools/bake/moon/fetch.py <url> <dest>`, 130 s); deleted afterwards with `lola.delete_download()` (strip offsets are kept for streaming) |
| Region | `tools/bake/moon/region.py moon-tranquility` | 50-80 s | SLDEM window by HTTP range (~1,100 rows), NAC DTM 118 MB download |
| Target | `tools/bake/moon/target.py moon-tranquility` | 45-75 s | writes `recommendedTarget` into the region file |
| Albedo | `tools/bake/moon/albedo.py` (steps `svs,resolution,fit,detail,svsdeshade,tiles,lowres`) | svs 49 s, resolution 12 s, fit 148 s, detail 1,266 s, svsdeshade 186 s, tiles 3,602 s, lowres 4 s | SVS colour EXR 989 MB (deleted after conversion); WAC 100 m mosaic and LOLA are **streamed** by HTTP range reads (never stored); keeps `svs_mip*.f16` (3.0 GB) and `wac_detail.u8` (4.6 GB) in `data/cache/moon/work` until deleted |
| Sky | `tools/bake/sky/bake.py` | 300-340 s | HYG 34 MB, SVS EXRs 0.6 GB in `data/cache/sky/dl/` |
| Verify | `tools/bake/moon/verify.py`, `tools/bake/sky/verify.py` | 72 s, 5 s | the Moon verifier reads four PDS ldem_256 pixels over HTTP and runs `npx tsx` |
| Sheets | `tools/bake/moon/sheets.py`, `tools/bake/sky/sheets.py` | ~2 min each | PNGs in `out/bake/moon`, `out/bake/sky` |

Peak disk of this package (tiles + caches incl. the venv) stayed below 14 GB: ~13 GB during the global
height bake (LOLA 8.5 GB on disk), ~12.5 GB during the albedo tiles (SVS mips + WAC detail + tiles). Final:
`data/tiles/moon` 3.40 GB (height 2.27, albedo 1.13), `data/sky` 0.135 GB, `data/cache/moon` 0.63 GB
(venv 0.35 GB, region source caches, crater crops and fit tables used by the verifiers), `data/cache/sky`
0.15 GB (the before-removal cube used by the cube-alignment checker). All raw downloads are deleted.

Self-checks also run: `python -I tools/bake/common/test_common.py` (9 tests OK), `npx vitest run
tools/dev/boundaries.test.ts` (7 passed), `npm run typecheck:paths -- tools/bake/moon` (OK; the only TS file
is `tools/bake/moon/decode-check.node.ts`).

## 3. Verification output

`out/bake/moon/verify.txt` / `verify.json` and `out/bake/sky/verify.json` hold the full output. **Moon: 2 of
the acceptance checks fail** (Tycho benchmark, per-crater wall ratios; both explained below). **Sky: all
checks pass.**

### Moon (`python -I tools/bake/moon/verify.py`, 72 s)

```
PASS height: all 33804 promised tiles exist and decode (259x259, finite, power-of-two scale, header min/max)
PASS height level 0..12: tile scales = preferred (0.5 / 0.125 / 0.03125)
PASS height pyramid complete (tiles without parent: 0)
PASS albedo: all 131070 promised tiles exist and decode as 256x256 RGB WebP
PASS albedo: no tile has an alpha channel (chunk types {'VP8 ': 131070})
PASS albedoLowRes (1024, 512) RGB
PASS shared edges: 67458/67458 equal-scale neighbour pairs bit-identical (incl. cube edges); 0 pairs of different scale
PASS benchmark Tranquility: level 6 -1924.8 m (mean over the ldem_64 pixel; point -1924.8) vs ldem_64 -1925.0 m, ldem_256 pixel -1924.5 m (limit 60 m)
FAIL benchmark Tycho floor: level 6 -1383.5 m (mean over the ldem_64 pixel; point -1377.6) vs ldem_64 -1295.5 m, ldem_256 pixel -1357.0 m (limit 60 m)
PASS benchmark Apollo 17: level 6 -2628.7 m (mean over the ldem_64 pixel; point -2628.9) vs ldem_64 -2624.5 m, ldem_256 pixel -2630.0 m (limit 60 m)
PASS benchmark Aitken (SPA): level 6 -6953.5 m (mean over the ldem_64 pixel; point -6953.1) vs ldem_64 -6948.0 m, ldem_256 pixel -6968.0 m (limit 60 m)
PASS Tranquility at level 12: point -1927.41 m, mean over the ldem_64 pixel -1924.84 m vs -1925.0 (limit 5 m)
PASS coverage edge level 7: data vs bicubic upsample of level 6: RMS 0.000 m, max 0.000 m over 16530 ring samples (limit 3.0 m RMS)
PASS coverage edge level 8: data vs bicubic upsample of level 7: RMS 0.000 m, max 0.000 m over 24330 ring samples (limit 1.0 m RMS)
PASS coverage edge level 9: data vs bicubic upsample of level 8: RMS 0.000 m, max 0.000 m over 36030 ring samples (limit 1.0 m RMS)
PASS coverage edge level 10: data vs bicubic upsample of level 9: RMS 0.038 m, max 0.062 m over 36030 ring samples (limit 1.0 m RMS)
PASS coverage edge level 11: data vs bicubic upsample of level 10: RMS 0.000 m, max 0.000 m over 61380 ring samples (limit 1.0 m RMS)
PASS coverage edge level 12: data vs bicubic upsample of level 11: RMS 0.000 m, max 0.000 m over 112080 ring samples (limit 1.0 m RMS)
PASS NAC/SLDEM blend: largest 500 m-segment mean offset in the 300 m feather 0.603 m (RMS of local relief difference 1.42 m) (limit 1 m step)
INFO RMS slope of level-12 data inside the NAC DTM (40,000 random pairs, random azimuths): 2m: 3.20 deg (source NAC 3.28 deg), 4m: 3.19 deg (source NAC 3.25 deg), 8m: 3.11 deg (source NAC 3.15 deg)
PASS recommendedTarget present in the region file
PASS target height re-evaluated -1907.70 m = recorded -1907.7 m
PASS target slope over 100.0 m: plane fit 1.143 deg, steepest 1.382 deg (< 3.0)
PASS target: nearest crater >= 20.0 m is 190.9 m away (> 150.0 m)
PASS target lit: horizon toward azimuths [75.0, 90.0, 105.0] at most -0.357 deg (sun >= 5.0 deg)
PASS target: disc of 2500.0 m inside level-12 coverage, coverage weight over the 2000.0 m disc min 1.0
INFO crater wall brightness west-facing / east-facing (level 7 final | level 5 SVS only | raw WAC mosaic):
     Kepler 1.057 | 1.052 | 3.359      Aristarchus 0.927 | 0.929 | 2.254   Timocharis 1.007 | 1.011 | 3.519
     Euler 1.003 | 1.011 | 3.124       Lambert 1.031 | 1.041 | 3.310       Bessel 1.010 | 0.991 | 6.356
     Dawes 1.058 | 1.042 | 8.663       Plinius 0.997 | 0.998 | 4.224       Manilius 0.958 | 0.959 | 3.069
     Menelaus 1.140 | 1.145 | 5.083    Arago 1.005 | 1.004 | 3.204         Delisle 1.045 | 1.044 | 3.999
     Diophantus 1.011 | 1.018 | 8.412  Pytheas 0.908 | 0.923 | 3.792       Mosting 0.945 | 0.948 | 3.107
     Lalande 1.015 | 1.004 | 2.620     Godin 0.945 | 0.946 | 3.524         Dionysius 0.736 | 0.751 | 8.139
     Maskelyne 1.045 | 1.051 | 3.887   Proclus 0.924 | 0.930 | 8.399       Picard 0.790 | 0.797 | 3.591
     Taruntius 1.024 | 1.021 | 2.849   Bullialdus 0.932 | 0.933 | 2.417    Agrippa 1.002 | 1.000 | 3.611
     Herschel 0.953 | 0.962 | 3.142    Theon Senior 1.031 | 1.027 | 8.638
INFO residual wall asymmetry vs the mosaic's baked shading: correlation of log ratios -0.036 (residual shading would correlate); geometric-mean ratio over all craters 0.977
PASS albedo de-shading: geometric mean west-/east-facing wall ratio over 26 craters 0.977 (within 5 %)
FAIL albedo de-shading: 15 of 26 craters have a west-/east-facing wall brightness ratio within 5 % at level 7 (median |1 - ratio| 0.045; raw WAC 2.558)
PASS TypeScript tileCodec decode of height/0/0/0/0 is bit-identical to the Python decode
PASS TypeScript tileCodec decode of height/4/6/17/40 is bit-identical to the Python decode
PASS TypeScript tileCodec decode of height/0/12/2935/2077 is bit-identical to the Python decode
INFO sizes (GB): height 2.269, albedo 1.132, globals 0.000, total 3.402
2 CHECK(S) FAILED
```

How the checks are defined:
- Benchmarks: the level-6 surface (Catmull-Rom of the tiles, as the run-time authority) at the ldem_64 pixel
  centre and averaged over that 474 m pixel, against the ldem_64 value; the PDS ldem_256 pixel is printed as
  an independent 256 ppd reference. Tycho: see section 7 and the request.
- Coverage edges: every vertex of the boundary tiles of each level whose run-time coverage weight is strictly
  between 0 and 1 (the quarter-tile ring), level-L Catmull-Rom vs level-(L-1) Catmull-Rom. The data are
  parent-identical there by construction, hence ~0.
- NAC/SLDEM step: inside the 300 m feather (sampled every 8 m along the whole strip outline), the mean of
  bias-corrected NAC minus the SLDEM-based surface over each 500 m segment of the outline; the worst segment
  is the step the feather bridges.
- Crater walls: wall pixels = inside the refined rim and steeper than 8 deg on the level-6 DEM; west-facing /
  east-facing by downhill aspect +-45 deg; red channel, linear. The raw WAC column shows the test is
  sensitive (baked shading gives 2.2-8.7). The final ratios do not correlate with the baked shading
  (r = -0.04) and average 0.977; 11 craters deviate by more than 5 %, the largest ones are real albedo
  asymmetries (Dionysius' dark-halo ejecta, Picard and Menelaus on mare/highland contacts, Pytheas, Proclus'
  rays) that are present unchanged in the SVS-only level 5 column. The criterion "within 5 % on 20 craters"
  is therefore not met per crater; it is met for the set (geometric mean).
- RMS slope for the terrain team: level-12 data inside the NAC strip (>= 500 m from its edge), 40,000 random
  point pairs at random azimuths: 3.20 / 3.19 / 3.11 deg at 2 / 4 / 8 m (the NAC DTM itself: 3.28 / 3.25 /
  3.15 deg). RMS of tan(slope) is in `verify.json`.

### Sky (`python -I tools/bake/sky/verify.py`, 5 s): ALL CHECKS PASSED

```
PASS manifest fields (formatVersion 1, j2000-equatorial, rgb9e5ufloat); full mip chain: 12 levels
PASS rgb9e5 pack/unpack error <= 2^-9 of the largest channel (normal range); below 2^-15 absolute error <= 2^-25; exact for (1, 0.5, 0.25)
PASS star count 8920 = manifest; sorted brightest first; all V <= 6.5; unit directions; lux = 2.54e-6 * 10^(-0.4 V); colours luminance 1; Sol excluded
INFO brightest ten: Sirius -1.44, Canopus -0.62, Arcturus -0.05, Rigil Kentaurus -0.01, Vega 0.03, Capella 0.08, Rigel 0.18, Procyon 0.4, Achernar 0.45, Betelgeuse 0.45
PASS Sirius at RA 101.287 Dec -16.716 (J2000 101.287, -16.716)
PASS milkyway-*.rgb9e5: 5592405 texels each = full mip chain of 2048^2; texels finite; mip 1 = 2x2 box of mip 0 within rgb9e5 precision (all 6 faces)
PASS cube texel solid angles sum to 4 pi (12.566370614)
PASS cube alignment Sirius: catalogue texel 2/710,819, peak at offset (0,0) before removal; removal 3x3 max 8.14e+03 -> 17.9 (local median 9.24)
PASS cube alignment Polaris: catalogue texel 4/1015,1034, offset (0,0); 5.05e+03 -> 3.94 (median 2.54)
PASS cube alignment Orion's belt: Alnitak 2/989,1110 (0,0) 4.32e+03 -> 10.1 (median 2.75, Flame Nebula); Alnilam 2/1002,1130 (0,0) 5.64e+03 -> 4.6; Mintaka 2/1018,1149 (0,0) 4.98e+03 -> 7.13
PASS cube alignment Southern Cross: Acrux 5/1084,1540 (0,0) 6.53e+03 -> 43.3; Mimosa 5/1147,1609 (0,0) 6.79e+03 -> 56.6; Gacrux 5/1113,1680 (0,0) 6.08e+03 -> 22.5; Imai 5/1065,1644 (0,0) 3.06e+03 -> 45.1
PASS brightest 300 stars: 297/299 cube peaks within one texel of the catalogue direction; 299/299 reduced by > 95 % after removal
PASS luminanceScale 2.0258e-05 cd/m^2 per stored unit (fitted on 493 isolated unsaturated stars V [8.5, 11.0], MAD 0.305 mag)
PASS galactic-centre region mean luminance 1.35e-03 cd/m^2 (10x10 deg; p90 2.95e-03) within 1e-3..1e-2
PASS sky data size 0.135 GB (expected about 0.15 GB): six faces 22.37 MB each, stars.f32 0.29 MB, named-stars.json 0.01 MB
```

The checker (`tools/bake/sky/verify.py`) looks each catalogue direction up with the CPU implementation of the
WebGPU face-selection table (`sky/cubemap.dir_to_face_uv`) in the cube built before star removal (kept in
`data/cache/sky/work/cube_before_f16.npy`), requires the brightest texel of the 7 x 7 neighbourhood within one
texel, and after removal requires the excess over the local median to be < 1 % of the star's.

### Contact sheets (inspected)

- `out/bake/moon/faces-albedo.png`, `faces-height.png`: unfolded cube; continuous across all face edges.
- `out/bake/moon/nearside.png` / `farside.png`: orthographic albedo and slope shading; the near side is
  recognisable and correctly oriented (Imbrium upper left, Crisium right, Tycho's rays bottom), heights and
  albedo coincide.
- `out/bake/moon/region-L7..L12.png`: regional pyramid hillshades; L12 shows crisp 2 m NAC craters at the
  landing site; the SLDEM disc shows as finer (and N-S streaky) texture inside the LOLA surround.
- `out/bake/moon/edge-L7..L12.png`: run-time-blended surface across each coverage edge; no wall, difference
  map empty. `sldem-disc-edge-L9.png`, `nac-strip-edge-L12.png`: the source feathers, no step.
- `out/bake/moon/deshade-*.png`: raw WAC | SVS x raw detail | SVS x de-shaded detail | final level 7.
- `out/bake/moon/target.png`: the target with the 50 / 150 / 750 m circles and detected craters.
- `out/bake/sky/cube-cross.png` (final), `cube-before.png` (before removal): log-tone-mapped faces with
  constellation figures and bright-star circles; the Milky Way runs continuously across +Y, +Z, -Y and into
  -Z, the Magellanic Clouds sit next to Achernar, removed stars leave empty circles.
  `out/bake/sky/equirect.png`: the cube re-projected to RA/Dec looks like the SVS reference map.

## 4. How the data were made (calibration numbers)

### 4.1 Heights

- **Global levels 0-6**: USGS LOLA 118 m GeoTIFF (int16, 92160 x 46080, scale 0.5, column 0 = 180 W, pixel-
  registered; no nodata; DN range -18257..21563). Each sample is the LOLA pyramid filtered over the local
  sample spacing of its level (`footprint_m`, a function of the direction only): trilinear between
  area-averaged mips, Catmull-Rom inside a mip, extra longitude taps where the grid is compressed toward the
  poles (up to 8, then a coarser mip), wrap in longitude and across the poles. Result range -9127..+10781 m.
- **Levels 7-9 (SLDEM2015)**: USGS `Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif` window (+-32 km) read
  by HTTP range (the file was never downloaded whole). Longitude convention checked against the baked LOLA
  levels: best correlation of the high-passed fields at zero shift (r = 0.897 at 474 m pixels; a 180 deg
  convention error would give r ~ 0). SLDEM - LOLA: mean -0.49 m, std 6.9 m; the bias field (Gaussian 3 km
  of the difference) spans -6.7..+4.4 m and is removed so the two agree at long wavelengths; then SLDEM is
  feathered into the upsampled level-6 surface over the outer 2 km of the 20 km disc (smootherstep).
- **Levels 10-12 (LROC NAC DTM Apollo 11)**: 2 m posts, equirectangular (centre 180 E, standard parallel
  1 deg) taken from the GeoTIFF via GDAL/PROJ. Registered to SLDEM at zero shift (r = 0.876 at 128 m, 0.47
  at 8 m). NAC - SLDEM: mean -0.59 m, std 3.2 m. Bias field: Gaussian 1 km of the difference in the interior;
  within 400 m of the strip edge a Gaussian of 60 m (blended to the 1 km field over the next 600 m), so the
  300 m feather never bridges a local offset (it measured 2.17 m with the 1 km field alone, 0.60 m now); range
  -10.2..+7.0 m. Consequence: within ~400 m of the strip edge, NAC relief wider than ~150 m follows SLDEM
  (craters of 150-300 m that SLDEM does not resolve are muted there); the interior, the target and the
  mission disc are untouched. The feather starts where the filtered NAC stencil no longer touches missing
  pixels. The DTM has a stereo seam (NAC left/right image
  boundary) running N-S near columns 886-1115 with steps up to 1.27 m; it is replaced by a 120 m wide ramp
  (`seamCorrection` in the region file; residual largest column step found afterwards 0.62 m, which is
  the natural terrain in the search band).
- Run-time blending (COVERAGE_BLEND_TILES) is not implemented here: the bake makes every coverage edge sit
  on parent-identical data (measured below), so the run-time ring never has anything to bridge.

### 4.2 Albedo

- **Base colour**: SVS CGI Moon Kit `lroc_color.exr` (linear float, 27360 x 13680), resampled to
  27648 x 13824 (Catmull-Rom) for an exact mip chain. Calibration: one gain **0.29589** so the median
  643 nm (red) of six maria = 0.07: Tranquillitatis 0.054, Serenitatis 0.076, Imbrium 0.076, Crisium 0.072,
  Procellarum 0.058, Fecunditatis 0.068; resulting highlands: 0.184 (10N 160E), 0.150 (20S 140E), 0.171
  (30N 170W), 0.160 (30S 10E), 0.136 (12S 5E, a mixed area), 0.222 (0N 120E): median 0.166, inside the
  0.15-0.25 target. Registration against the WAC mosaic (4 maria windows): the SVS map sits 2.2 WAC pixels
  west and 0.7 pixels south; sampled with that offset (lon +0.00722 deg, lat -0.00233 deg). Effective
  resolution of the SVS map: Gaussian sigma 500 m (best correlation with the filtered WAC).
- **SVS residual shading**: Hapke normalisation only corrects the reference sphere, so crater walls kept
  part of the source images' shading. Regressing the high-passed log red on LOLA slopes (filtered to 500 m)
  in 1 deg cells gives a median gradient of 0.11 per unit slope; that factor (0.72..1.44) is divided out of
  all three channels within +-70 deg (fade 66-70 deg). Region medians are unchanged (the shading averages out).
- **Detail (levels 6-7)**: LROC WAC 100 m morphology mosaic (illumination baked in), streamed by HTTP range
  reads together with LOLA. Fitted illumination of the mosaic (1 deg cells, 37,739 good cells): median
  incidence 67 deg (10-90 %: 57-74 deg, matching the mosaic's documented 55-75 deg), r^2 median 0.49, sun
  from the east in 25 % of the cells. Each pixel is divided by the modelled lunar-Lambert shading
  (McEwen 1996 L(phase)) at that geometry; shadows (S < 0.25 or < 0.35 x the 1 km mean) are dropped; the
  result is high-passed against the SVS resolution (sigma 500 m), clamped 0.7-1.3, and at tile time
  attenuated to nothing on slopes steeper than 20 deg (full below 10 deg), where the 118 m DEM cannot model
  the mosaic's shading. Detail fades out between 65 and 69 deg latitude (polar SVS is inpainted).
- WebP quality 95 (RMS error ~1.4 8-bit levels on detailed tiles).

### 4.3 Sky

- Orientation of the SVS maps established from the data: of 16 hypotheses, only "RA = 180 deg - 360 deg x
  (column + 0.5) / W, row 0 = +90" puts the 300 brightest catalogue stars on bright pixels (100 % vs <= 0.3 %).
- The hiptyc layer **clips at 1.0**: stars brighter than V ~ 5.5 saturate (Sirius, Canopus and Vega carry
  2.5, 1.6 and 1.1 mag less flux than their magnitude). luminanceScale is therefore fitted on 493 isolated
  (no other HYG star brighter than V + 3 within 10 px, no Tycho neighbour flux within 10 px), unsaturated
  Tycho-range stars, V 8.5-11: median of E_cat / (integrated map flux x solid angle) = 0.16596 cd/m^2 per
  starmap unit, scatter 0.31 mag (MAD). The per-bin medians drift from 0.157 (V 8.5-9) to 0.285 (V 10.5-11), so
  the map is not perfectly linear; the fit is dominated by V 8.5-9.5. Sanity check: the 10 x 10 deg
  galactic-centre region has mean luminance 1.35e-3 cd/m^2 (median 0.96e-3, 90th percentile 2.95e-3),
  inside the 1e-3..1e-2 target; all-sky median 7.1e-5 cd/m^2.
- Star removal: disc inpainting of all 8,920 catalogue stars in the hiptyc layer, radius per star from its
  measured profile (ring mean < 1e-4 above the outer background; median 4 px, Sirius 13 px, max 19 px), filled
  with the per-channel median of the 2-px ring outside; brightest first.
- Cube resampling: radiance-weighted bilinear splat of every equirect pixel (value x solid angle) into
  the faces; flux of the cube / flux of the source = 1.0000024. Mips are 2 x 2 box averages per face.

## 5. Sources and credits (also in the manifests' `attribution` / `sources`)

- LOLA: NASA/GSFC LRO LOLA Team (Smith et al. 2010); USGS Astrogeology mosaic `Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif`.
- SLDEM2015: Barker et al. 2016, Icarus 273 (LOLA + SELENE/Kaguya TC, NASA GSFC, JAXA); USGS mosaic.
- LROC NAC DTM Apollo 11 and LROC WAC global morphology mosaic 100 m (June 2013): NASA/GSFC/Arizona State University; USGS Astrogeology.
- NASA's Scientific Visualization Studio: CGI Moon Kit colour map; Deep Star Maps 2020 (Ernie Wright; Hipparcos-2, Tycho-2, Gaia DR2).
- HYG Database v4.1, David Nash / astronexus, CC BY-SA 4.0 (the shipped `stars.f32` / `named-stars.json` are a derived table and carry that licence).

## 6. Adding a landing region (data only)

1. Copy `data/defs/regions/moon-tranquility.json` to `data/defs/regions/moon-<site>.json` and change `id`,
   `title`, `centre`, the `sources` (any GeoTIFF that GDAL can read: kind `geotiff-window` for a big remote
   file read by HTTP range, `geotiff-download` for a small file; give the exact `bytes`) and, if wanted, the
   `bands` (levels must continue from level 7; the same level must keep the same `heightScale` across
   regions). Example for Taurus-Littrow: centre 20.19 N 30.77 E, SLDEM band unchanged, NAC band source
   `https://pds.lroc.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO17/NAC_DTM_APOLLO17.TIF`
   (463,397,471 B). Leave out `seamCorrection` unless a seam is seen in a hillshade of that DTM.
2. `python -I tools/bake/moon/region.py moon-<site>` (bakes its tiles, merges its rectangles into the
   manifest; refuses regions whose tiles overlap another region's).
3. `python -I tools/bake/moon/target.py moon-<site>` if the region needs a touchdown target (`targetSearch`).
4. `python -I tools/bake/moon/verify.py --region moon-<site>` and `sheets.py --region moon-<site>`.

## 7. Known limits

- **Tycho benchmark** fails the 60 m tolerance (see request `docs/requests/bake-moon-sky-1.md`): the
  benchmark comes from PDS ldem_64, which is shifted 1-2 pixels of 118 m in longitude against the 256 ppd
  products, and it sits on the steep central peak. The other three benchmarks agree within 6 m.
- **Crater-wall test** (not met as written: 15 of 26 craters within 5 %, geometric mean 0.977, no
  correlation with the baked shading): individual craters keep real albedo asymmetries (Dionysius, Picard,
  Menelaus straddling the Serenitatis shore), present unchanged in the SVS base. The baked shading itself is
  gone (raw mosaic ratios 2.2-8.7). Steep walls (> 20 deg) carry only the 500 m SVS colour, so they look
  smoother than flat ground at levels 6-7.
- The `seamCorrection` (NAC stereo seam) and the edge-local NAC bias are data-driven but tuned on this DTM;
  a new region should check its own hillshade (`sheets.py`) before reusing those parameters.
- Between the SLDEM disc and its coverage edge, and between the NAC strip and its coverage edge, the regional
  levels carry upsampled coarser data (as the brief asks for one tile of margin): the manifest's effective
  level is higher there than the real resolution, so procedural amplification keyed on the effective level
  will be weaker there than over real data. SLDEM2015 also shows N-S Kaguya TC streaks at 59 m.
- Albedo detail exists only where the WAC mosaic can be de-shaded: |lat| <= 69 deg and slopes < 20 deg;
  elsewhere levels 6-7 show the 500 m SVS colour upsampled. Mosaic seams where the WAC sun azimuth flips
  between orbits are smoothed over ~1 deg by the fitted illumination field; a faint residual can remain there.
- The SVS hiptyc layer is clipped and only approximately linear (section 4.3); stars fainter than the
  catalogue cutoff left in the cube inherit that, up to ~0.3 mag.
- Moon tile set size is 3.40 GB, below the brief's 4-7 GB estimate: lunar albedo compresses well
  (level-7 WebP at quality 95 averages ~9 KB per tile; albedo 1.13 GB in total) and heights take 2.27 GB.
- Raw downloads were deleted after verification (LOLA, SVS colour EXR, NAC TIF, sky EXRs and HYG); the
  region sources stay cached as `.npz` in `data/cache/moon/work/region-moon-tranquility` (needed by the
  verifier and the target search), and SVS mips / WAC detail were deleted to free 7.6 GB, so re-baking the
  albedo tiles re-runs the `svs`..`svsdeshade` steps.

## 8. Requests filed

- `docs/requests/bake-moon-sky-1.md` (lead; not blocking): re-base or widen the Tycho benchmark.
No change to `tools/bake/common` or any contract was needed. There are no open requests against this
package's paths.

## 9. Notes for the consumers

- **terrain-core / terrain-render**: the regional rectangles are on face 0 only; level-12 sample spacing at the
  site is ~2.9 m. RMS slope at 2/4/8 m is 3.2 deg on the level-12 data (section 3) for amplification
  calibration. The coverage edges are parent-identical, so the run-time blend ring changes nothing there.
- **sim-world-pilot**: `recommendedTarget` (0.661471 N, 23.435999 E, -1907.70 m) is in the region file;
  the region tool keeps the target when re-run, `target.py` recomputes it.
- **sky-lighting**: luminance of a texel in cd/m^2 = `luminanceScale` x stored RGB (the brightest texel after
  star removal stores ~1.4e3, the all-sky median ~3.5, i.e. 2.8e-2 and 7.1e-5 cd/m^2); catalogue stars are
  not in the cube. Faces are
  rows top to bottom, level 0 first; WebGPU `writeTexture` per face and mip with bytesPerRow = 4 x size.
