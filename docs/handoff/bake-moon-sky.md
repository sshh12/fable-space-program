# Hand-off: bake-moon-sky

Moon tile set (`data/tiles/moon`), sky data (`data/sky`), the tools that bake and verify them
(`tools/bake/moon`, `tools/bake/sky`), and the Tranquility landing region with the recommended touchdown
target (`data/defs/regions/moon-tranquility.json`). Baked data is git-ignored; everything is reproducible with
the commands below. Section 10 records the recovery after the 2026-11-10 crash and the review fixes.

## 1. What consumers get

### Moon tile set `/tiles/moon/` (TileManifest, `src/core/contracts/terrain.ts`)

| | |
|---|---|
| Frame | lunar body-fixed, mean-Earth/polar-axis (the LOLA/LROC "Moon_2000" frame): +Z north pole, +X at 0 N 0 E, longitude east-positive, planetocentric latitude. Heights in metres above the 1,737,400 m sphere (`manifest.radius`). Mapping exactly `tools/bake/common/cube.py` / `src/core/geo/cubeSphere.ts`. |
| `height` | `frt1-height` (`.hgt`), `globalMaxLevel` 6 (all 32,766 tiles), regional levels 7-12 around Tranquility (1,038 tiles, coverage rectangles below). `heightScales` = 0.5 m (levels 0-6), 0.125 m (7-9), 0.03125 m (10-12); every tile uses its level's preferred scale. Additive fields: `sourceCoverage` (below; requested in `docs/requests/terrain-core-1.md`) and `build` (hash of the regional tiles' content, see below). |
| `albedo` | `webp` 256 x 256, opaque RGB (lossy `VP8 `, no alpha anywhere), `globalMaxLevel` 7 (131,070 tiles), no regional albedo. sRGB-encoded **normal albedo** (decode sRGB to get linear albedo; red = 643 nm). No baked shading (section 4.2). Additive field `build` (hash of the tiles' content). |
| `globals.albedoLowRes` | `globals/albedo-lowres.png`, 1024 x 512, RGB, equirect, row 0 = north, column 0 = 180 W (same encoding as the tiles, SVS base only). |
| `residentHeightLevel` | 3 |
| `regions.json` | registry the region tool keeps (which region baked which rectangles, and a content hash of its tiles); not part of the contract. |

`build` exists because `layout.write_manifest` hashes only the manifest body: a re-bake that changes tiles but
no rectangle would otherwise keep the `contentHash` the tile URLs are cache-busted with (the contract says it
changes whenever tiles are re-baked). bake-earth does the same for the Earth layers.

Regional rectangles (all on face 0; inclusive tile rectangles):

| Level | `coverage` (x0..x1, y0..y1) | Tiles | `sourceCoverage` | Tiles | Data inside | Sample spacing at the site |
|---|---|---|---|---|---|---|
| 7 | 89..93, 63..66 | 20 | 90..92, 64..65 | 6 | SLDEM2015 in the 20 km disc (feathered into LOLA over its outer 2 km), upsampled LOLA elsewhere | ~93 m |
| 8 | 180..186, 127..132 | 42 | 181..185, 128..131 | 20 | same | ~46 m |
| 9 | 362..371, 255..263 | 90 | none (`[]`) | 0 | same | ~23 m |
| 10 | 731..736, 513..525 | 78 | 733..734, 515..524 | 20 | LROC NAC DTM in its strip (feathered into SLDEM over 300 m), SLDEM/LOLA around it | ~11.6 m |
| 11 | 1464..1471, 1027..1050 | 192 | 1466..1469, 1030..1048 | 76 | same | ~5.8 m |
| 12 | 2929..2942, 2056..2099 | 616 | 2933..2938, 2060..2096 | 222 | same | ~2.9 m |

- `coverage`: the data areas (20 km disc; NAC footprint + 2 km) plus one tile on every side, closed under
  parents, so every region of interest is at least a full tile inside its level's coverage and the quarter-tile
  run-time blend ring lies on data that converge on the parent: equal to the parent on the parent's grid nodes,
  and within 0.008-0.08 m RMS of the blended parent surface between them (section 3).
- `sourceCoverage`: where a level holds data finer than its parent (terrain-core-1, -4): the tiles that touch
  the area where the level's source actually lies (levels 7-8: the 20 km SLDEM disc including its 2 km feather;
  levels 10-12: the NAC DTM's valid footprint), without the margin - but only for levels whose source pixel is
  finer than the parent level's sample spacing (`region.source_detail_levels`). SLDEM2015's 59 m pixel is
  coarser than level 8's 47 m spacing, so level 9 resamples the same data and lists an empty rectangle set;
  terrain-core keys the effective level on these rectangles (it stays at 8 inside the disc and the procedural
  detail of the 41-83 m band stays on there).

### Landing target (`recommendedTarget` in `data/defs/regions/moon-tranquility.json`)

**0.661471 N, 23.435999 E, data height -1907.80 m** (level-12 data, i.e. radius 1,735,492.20 m), 1.18 km
west-south-west of the Apollo 11 LM. Unchanged in position since the first bake; `target.py --keep`
re-evaluated every criterion on the re-baked tiles (the NAC seam correction changed the height by 0.1 m):

| Criterion | Requirement | Target |
|---|---|---|
| Slope over 100 m | < 3 deg | plane fit 1.11 deg; steepest 100 m baseline (8 directions) 1.35 deg |
| Craters >= 20 m | none within 150 m | nearest at 190.9 m (20 m, 2.9 m deep); detector finds the Apollo 11 neighbourhood craters (a 60 m crater 54 m from the LM = Little West's depression, West crater 198-256 m at 320-340 m) |
| Lit for Apollo-like sun | terrain horizon below the sun | horizon toward azimuths 75/90/105 deg (east, morning sun) at most -0.36 deg at the target and 50 m around it; lit for any sun elevation >= 0 deg there (checked with >= 5 deg and a 1 deg margin) |
| Coverage | 2 km disc >= 500 m inside level-12 coverage | the whole 2.5 km disc is inside; run-time coverage weight w_12 = 1 over the 2 km disc |
| Real high-resolution data | (preference) | 100 % of the 1.5 km mission disc is NAC data (NAC band weight 1); the disc comes within 357 m of the NAC strip edge, see section 4.1 for what the edge-local bias does there |

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

The sky data were not re-baked in the fix round (section 10); only its verifier changed.

## 2. How to run

Environment (once): `C:/Users/.../Python310/python.exe -m venv data/cache/moon/venv`, then
`data/cache/moon/venv/Scripts/python.exe -m pip install numpy scipy pillow OpenEXR tifffile rasterio psutil scikit-image`
(numpy 2.2.6, scipy 1.15.3, Pillow 12.3, OpenEXR 3.5.2, rasterio 1.4.4 / GDAL 3.10.3, scikit-image 0.25.2).

Every bake and both verifiers go through the machine's heavy-job gate (`docs/PACKAGE_RULES.md` 13a), from the
repository root; the gate runs the command through `cmd.exe`, so the interpreter path needs backslashes:

    node tools/dev/heavy.mjs --class=bake --label=moon-region -- data\cache\moon\venv\Scripts\python.exe -I tools/bake/moon/region.py moon-tranquility

Each script lowers itself to BELOW_NORMAL priority and uses at most 6 single-threaded worker processes
(`rt.MAX_WORKERS`; `BAKE_MOON_SKY_WORKERS` can only lower it). `target.py` and `sheets.py` are single
processes.

| Step | Command (`python -I` = the venv interpreter) | Wall time | Network / disk |
|---|---|---|---|
| Global heights | `tools/bake/moon/heights_global.py` | 865 s at 8 workers (+15 s mips; first bake) | needs the 8.5 GB LOLA GeoTIFF in `data/cache/moon/dl/lola118/` (`python -I tools/bake/moon/fetch.py <url> <dest>`, 130 s); deleted afterwards with `lola.delete_download()` (strip offsets are kept for streaming) |
| Region | `tools/bake/moon/region.py moon-tranquility` | 43-55 s | SLDEM window by HTTP range (~1,100 rows), NAC DTM 118 MB download (both cached as `.npz` in `data/cache/moon/work/region-moon-tranquility`) |
| Target | `tools/bake/moon/target.py moon-tranquility [--keep]` | 39 s | writes `recommendedTarget` into the region file; `--keep` re-evaluates the existing target after a re-bake and fails if it no longer qualifies |
| Albedo | `tools/bake/moon/albedo.py` (steps `svs,resolution,fit,detail,svsdeshade,tiles,lowres,build`) | svs 49 s, resolution 12 s, fit 148 s (first bake, 8 workers); detail 859 s, svsdeshade 172 s, tiles 2,473 s, lowres 2 s, build 8 s (warm file cache) (fix round, 6 workers) | SVS colour EXR 989 MB (deleted after conversion); WAC 100 m mosaic and LOLA are **streamed** by HTTP range reads (never stored); keeps `svs_mip*.f16` (3.0 GB) and `wac_detail.u8` (4.6 GB) in `data/cache/moon/work` until deleted |
| Sky | `tools/bake/sky/bake.py` | 300-340 s | HYG 34 MB, SVS EXRs 0.6 GB in `data/cache/sky/dl/` |
| Verify | `tools/bake/moon/verify.py`, `tools/bake/sky/verify.py` | 55 s, 3 s | the Moon verifier reads four PDS ldem_256 pixels over HTTP and runs `npx tsx` |
| Sheets | `tools/bake/moon/sheets.py`, `tools/bake/sky/sheets.py` | ~2 min each | PNGs in `out/bake/moon`, `out/bake/sky` |

Disk: peak of this package ~13 GB during the first global height bake (LOLA 8.5 GB on disk) and ~12 GB during
an albedo bake (SVS mips 3.0 GB + WAC detail 4.6 GB + tiles + caches). Final: `data/tiles/moon` 3.46 GB of tile
data (3.7 GB on disk; height 2.27, albedo 1.19), `data/sky` 0.135 GB, `data/cache/moon` 0.64 GB (venv
0.35 GB, region source caches, crater crops and fit tables used by the verifiers), `data/cache/sky` 0.15 GB (the
before-removal cube used by the cube-alignment checker). All raw downloads and the albedo intermediates are
deleted (`sheets.py`'s `deshade` sheets need the SVS mips, so they only render right after an albedo bake).

Self-checks also run: `python -I tools/bake/common/test_common.py` (9 tests OK), `npx vitest run
tools/dev/boundaries.test.ts` (7 passed), `npm run typecheck:paths -- tools/bake/moon` (OK; the only TS file is
`tools/bake/moon/decode-check.node.ts`).

## 3. Verification output

`out/bake/moon/verify.txt` / `verify.json` and `out/bake/sky/verify.txt` / `verify.json` hold the full output
(final run 2026-11-10 16:22). **Moon: 2 acceptance checks fail** (Tycho benchmark, per-crater wall ratios; both
explained in section 7 and filed as requests). **Sky: all checks pass.**

### Moon (`python -I tools/bake/moon/verify.py`, 55 s)

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
PASS Tranquility at level 12: point -1927.44 m, mean over the ldem_64 pixel -1924.86 m vs -1925.0 (limit 5 m)
PASS coverage edge level 7: level-7 data vs the blended level-6 surface at 6406 random ring points: RMS 0.077 m, p99 0.315 m, max 1.271 m (limit 3.0 m RMS)
PASS coverage edge level 8: level-8 data vs the blended level-7 surface at 9364 random ring points: RMS 0.070 m, p99 0.276 m, max 1.536 m (limit 1.0 m RMS)
PASS coverage edge level 9: level-9 data vs the blended level-8 surface at 14154 random ring points: RMS 0.034 m, p99 0.086 m, max 0.233 m (limit 1.0 m RMS)
PASS coverage edge level 10: level-10 data vs the blended level-9 surface at 13810 random ring points: RMS 0.035 m, p99 0.085 m, max 0.292 m (limit 1.0 m RMS)
PASS coverage edge level 11: level-11 data vs the blended level-10 surface at 23387 random ring points: RMS 0.009 m, p99 0.023 m, max 0.044 m (limit 1.0 m RMS)
PASS coverage edge level 12: level-12 data vs the blended level-11 surface at 43150 random ring points: RMS 0.008 m, p99 0.021 m, max 0.031 m (limit 1.0 m RMS)
PASS height layer has sourceCoverage for every regional level
PASS sourceCoverage inside coverage and covering all source data where the source is finer than the parent level (tiles per level {'7': 6, '8': 20, '9': 0, '10': 20, '11': 76, '12': 222}; source tiles outside it: 0; levels without finer source detail, listed empty: {9: '59 m source vs 47 m parent posting'})
INFO NAC stereo seam: tracked as one path, columns 940-976, step sign -1; 108 of 173 blocks of 80 rows corrected (79 fully); step at the path in those blocks RMS 0.737 -> 0.153 m, max 1.530 -> 0.717 m (block noise 0.100 m); largest change 0.987 m
PASS no altimeter-track stripes in level 9 (sldem2015, 413 x 413 source pixel centres inside the 20 km disc): worst column roughness 1.48 x its neighbours, 3 columns > 1.3 (raw source 2.32, 58 columns; E-W control: worst row 1.29) (limit 1.6)
PASS NAC/SLDEM blend: largest 500 m-segment mean offset in the 300 m feather 0.622 m (RMS of local relief difference 1.34 m) (limit 1 m step)
INFO edge-local NAC bias inside the 1500 m mission disc (the disc comes within 357 m of the NAC strip edge): height change max 3.15 m, p95 0.59 m, 5.7 % of the disc > 0.5 m; below 1 cm within 910 m of the target
INFO RMS slope of level-12 data inside the NAC DTM (40,000 random pairs, random azimuths): 2m: 3.20 deg (source NAC 3.28 deg), 4m: 3.18 deg (source NAC 3.25 deg), 8m: 3.10 deg (source NAC 3.15 deg)
PASS recommendedTarget present in the region file
PASS target height re-evaluated -1907.80 m = recorded -1907.8 m
PASS target slope over 100.0 m: plane fit 1.113 deg, steepest 1.35 deg (< 3.0)
PASS target: nearest crater >= 20.0 m is 190.9 m away (> 150.0 m)
PASS target lit: horizon toward azimuths [75.0, 90.0, 105.0] at most -0.355 deg (sun >= 5.0 deg)
PASS target: disc of 2500.0 m inside level-12 coverage, coverage weight over the 2000.0 m disc min 1.0
INFO crater wall brightness west-facing / east-facing (level 7 final | level 5 SVS only | raw WAC mosaic):
     Kepler 1.066 | 1.052 | 3.359      Aristarchus 0.929 | 0.929 | 2.254   Timocharis 1.004 | 1.011 | 3.519
     Euler 1.006 | 1.011 | 3.124       Lambert 1.030 | 1.041 | 3.310       Bessel 1.007 | 0.991 | 6.356
     Dawes 1.058 | 1.042 | 8.663       Plinius 0.996 | 0.998 | 4.224       Manilius 0.952 | 0.959 | 3.069
     Menelaus 1.138 | 1.145 | 5.083    Arago 1.011 | 1.004 | 3.204         Delisle 1.051 | 1.044 | 3.999
     Diophantus 1.012 | 1.018 | 8.412  Pytheas 0.895 | 0.923 | 3.792       Mosting 0.942 | 0.948 | 3.107
     Lalande 1.019 | 1.004 | 2.620     Godin 0.940 | 0.946 | 3.524         Dionysius 0.728 | 0.751 | 8.139
     Maskelyne 1.044 | 1.051 | 3.887   Proclus 0.918 | 0.930 | 8.399       Picard 0.790 | 0.797 | 3.591
     Taruntius 1.012 | 1.021 | 2.849   Bullialdus 0.936 | 0.933 | 2.417    Agrippa 1.002 | 1.000 | 3.611
     Herschel 0.947 | 0.962 | 3.142    Theon Senior 1.026 | 1.027 | 8.638
INFO residual wall asymmetry vs the mosaic's baked shading: correlation of log ratios -0.051 (residual shading would correlate); geometric-mean ratio over all craters 0.975 (not an acceptance criterion: the brief asks for each of 20 craters within 5 %, see docs/requests/bake-moon-sky-2.md)
FAIL albedo de-shading: 13 of 26 craters have a west-/east-facing wall brightness ratio within 5 % at level 7 (median |1 - ratio| 0.050; raw WAC 2.558)
PASS TypeScript tileCodec decode of height/0/0/0/0 is bit-identical to the Python decode
PASS TypeScript tileCodec decode of height/4/6/17/40 is bit-identical to the Python decode
PASS TypeScript tileCodec decode of height/0/12/2935/2077 is bit-identical to the Python decode
INFO sizes (GB): height 2.267, albedo 1.189, globals 0.000, total 3.457
2 CHECK(S) FAILED (55 s)
```

How the checks are defined:
- Benchmarks: the level-6 surface (Catmull-Rom of the tiles, as the run-time authority) at the ldem_64 pixel
  centre and averaged over that 474 m pixel, against the ldem_64 value; the PDS ldem_256 pixel is printed as
  an independent 256 ppd reference. Tycho: section 7 and the request.
- Coverage edges: 1,500 random (u, v) points per boundary tile, kept where the run-time coverage weight is
  strictly between 0 and 1 (the quarter-tile ring); level-L Catmull-Rom of the tiles against the blended parent
  surface D_(L-1) that the run time fades it into. (The first bake's version sampled only vertices of the
  boundary tiles, which sit on parent grid nodes where a margin tile is a quantised copy of the parent, so it
  printed 0.000 m by construction.)
- `sourceCoverage`: every source rectangle inside the coverage; for each level whose source is finer than the
  parent's posting, every source pixel (every 8th) with band weight > 0 lies in a listed tile; the others empty.
- Track stripes: the shipped level-9 surface sampled at SLDEM's pixel centres over the square inside the
  disc's full-weight area; per column, the mean |second difference across it| over the whole square divided by
  the 15-column running median; rows the same way as the control.
- NAC/SLDEM step: inside the 300 m feather (sampled every 8 m along the whole strip outline), the mean of
  bias-corrected NAC minus the SLDEM-based surface over each 500 m segment of the outline; the worst segment
  is the step the feather bridges.
- Edge-local NAC bias: inside the 1.5 km mission disc (10 m grid), |w_NAC x (edge-local bias - 1 km bias)|.
- Crater walls: wall pixels = inside the refined rim and steeper than 8 deg on the level-6 DEM; west-facing /
  east-facing by downhill aspect +-45 deg; red channel, linear. The raw WAC column shows the test is
  sensitive (baked shading gives 2.2-8.7). The geometric mean is printed as INFO only.
- RMS slope for the terrain team: level-12 data inside the NAC strip (>= 500 m from its edge), 40,000 random
  point pairs at random azimuths. RMS of tan(slope) is in `verify.json`.

### Sky (`python -I tools/bake/sky/verify.py`, 3 s): ALL CHECKS PASSED

```
PASS manifest fields (formatVersion 1, j2000-equatorial, rgb9e5ufloat); full mip chain: 12 levels
PASS rgb9e5 pack/unpack error 1.95e-03 <= 2^-9 of the largest channel (normal range); below 2^-15 absolute error 2.98e-08 <= 2^-25; exact for (1, 0.5, 0.25)
PASS star count 8920 = manifest; sorted brightest first; all V <= 6.5; unit directions; lux = 2.54e-6 * 10^(-0.4 V); colours luminance 1; Sol excluded
INFO brightest ten: Sirius -1.44, Canopus -0.62, Arcturus -0.05, Rigil Kentaurus -0.01, Vega 0.03, Capella 0.08, Rigel 0.18, Procyon 0.4, Achernar 0.45, Betelgeuse 0.45
PASS Sirius at RA 101.287 Dec -16.716 (J2000 101.287, -16.716)
PASS milkyway-*.rgb9e5: 5592405 texels each = full mip chain of 2048^2; texels finite; mip 1 = 2x2 box of mip 0 within rgb9e5 precision (all 6 faces)
PASS cube texel solid angles sum to 4 pi (12.566370614)
PASS cube alignment Sirius: catalogue texel 2/710,819, peak at offset (0,0) before removal; removal 3x3 max 8.14e+03 -> 17.9 (local median 9.24)
PASS cube alignment Polaris: catalogue texel 4/1015,1034, offset (0,0); 5.05e+03 -> 3.94 (median 2.54)
PASS cube alignment Orion's belt: Alnitak 2/989,1110 (0,0) 4.32e+03 -> 10.1 (median 2.75); Alnilam 2/1002,1130 (0,0) 5.64e+03 -> 4.6 (median 5.62); Mintaka 2/1018,1149 (0,0) 4.98e+03 -> 7.13 (median 4.82)
PASS cube alignment Southern Cross: Acrux 5/1084,1540 (0,0) 6.53e+03 -> 43.3 (median 35); Mimosa 5/1147,1609 (0,0) 6.79e+03 -> 56.6 (median 42.6); Gacrux 5/1113,1680 (0,0) 6.08e+03 -> 22.5 (median 19.5); Imai 5/1065,1644 (0,0) 3.06e+03 -> 45.1 (median 28.6)
PASS brightest 300 stars: 297/299 cube peaks within one texel of the catalogue direction; 299/299 reduced by > 95 % after removal
PASS manifest luminanceScale 2.0258e-05 cd/m^2 per stored unit = the bake's fit (493 isolated unsaturated stars V [8.5, 11.0], MAD 0.305 mag)
PASS luminanceScale fit uses >= 23 stars (493)
PASS galactic-centre region mean luminance from the shipped faces 1.35e-03 cd/m^2 (10x10 deg; median 9.58e-04, p90 2.95e-03) within 1e-3..1e-2; all-sky median 7.08e-05
INFO catalogue stars as carried by the cube before removal (median cube/catalogue illuminance per V bin): V -1.5..-1.0 0.10 (n 1), ..., V +0.0..+0.5 0.42 (n 4), ..., V +4.5..+5.0 2.02 (n 506), V +5.0..+5.5 1.89 (n 864), V +5.5..+6.0 1.63 (n 1584), V +6.0..+6.5 1.43 (n 2867)
PASS photometric chain: isolated V 6.0-6.5 catalogue stars (2867) carry 1.43 x their catalogue illuminance in the cube (-0.39 mag, limit 0.5 mag: the SVS layer's non-linearity; a gross error of the chain - storage scale, solid angles, units - would show as magnitudes)
PASS sky data size 0.135 GB (expected about 0.15 GB): six faces 22.37 MB each, stars.f32 0.29 MB, named-stars.json 0.01 MB
```

The checker (`tools/bake/sky/verify.py`) looks each catalogue direction up with the CPU implementation of the
WebGPU face-selection table (`sky/cubemap.dir_to_face_uv`) in the cube built before star removal (kept in
`data/cache/sky/work/cube_before_f16.npy`), requires the brightest texel of the 7 x 7 neighbourhood within one
texel, and after removal requires the excess over the local median to be < 1 % of the star's. The photometry
lines are recomputed from the shipped faces with the manifest's `luminanceScale` (the galactic-centre box looked
up through the same CPU cube lookup; the catalogue-star line sums before - after over 13 x 13 texels x texel
solid angle), not read from the bake report.

### Contact sheets (inspected)

- `out/bake/moon/faces-albedo.png`, `faces-height.png`: unfolded cube; continuous across all face edges.
- `out/bake/moon/nearside.png` / `farside.png`: orthographic albedo and slope shading; the near side is
  recognisable and correctly oriented (Imbrium upper left, Crisium right, Tycho's rays bottom).
- `out/bake/moon/region-L7..L12.png`: regional pyramid hillshades; L12 shows crisp 2 m NAC craters and no seam
  line at the landing site; the SLDEM disc (L7-L9) and the SLDEM margins of L10-L12 no longer carry the dense
  straight N-S track lines of the first bake (a few faint ones remain, section 7).
- `out/bake/moon/edge-L7..L12.png`: run-time-blended surface across each coverage edge; no wall, difference
  map empty. `sldem-disc-edge-L9.png`, `nac-strip-edge-L12.png`: the source feathers, no step.
- `out/bake/moon/deshade-*.png`: raw WAC | SVS x raw detail | SVS x de-shaded detail | final level 7 | the slope
  mask. Plinius and Bullialdus no longer show a smooth painted band with a doubled rim outline; the terraces
  keep their texture.
- `out/bake/moon/target.png`: the target with the 50 / 150 / 750 m circles and detected craters.
- `out/bake/sky/cube-cross.png` (final), `cube-before.png` (before removal): log-tone-mapped faces with
  constellation figures and bright-star circles; the Milky Way runs continuously across +Y, +Z, -Y and into
  -Z, the Magellanic Clouds sit next to Achernar, removed stars leave empty circles (sky data unchanged in the
  fix round; sheets from the first bake).

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
  convention error would give r ~ 0).
  - **Altimeter-track stripes** (`trackStripeCorrection`, `region.correct_track_stripes`): SLDEM2015 pulls the
    Kaguya TC DTM to LOLA shots, and LRO's polar ground tracks run along the columns of the equirectangular
    grid, so track columns carry the shot-to-shot LOLA/TC differences (up to several metres, changing from
    pixel to pixel along the column; the mosaic is quantised to 0.5 m). Evidence: over the 64 km window the
    per-column across-track roughness (mean |second difference|) reaches 2.13 x that of the neighbouring columns
    at fixed columns (62 columns > 1.3 x), while no row exceeds 1.21 x (E-W control); across-track RMS second
    difference 3.25 m against 2.84 m along track. A hillshade under a low sun draws these as straight N-S
    lines (terrain-core-2). Correction: a pixel is a track pixel where its across-track roughness (Gaussian over
    25 rows) exceeds both the 31-column running median of the neighbouring columns and its own along-track
    roughness relative to its neighbours (score = min of the two; smoothstep 1.25..1.55; widened by one column
    each side); it loses its narrow across-track residual (height minus the 5-column median), clamped to 3 m.
    Craters raise both directions and do not stay in one column, wrinkle ridges curve, so neither is touched.
    Result: worst column 1.33 x (1 column > 1.3 x); across/along-track RMS second difference 2.74 / 2.75 m
    (isotropic); 35 % of the pixels weighted, change RMS 0.68 m, at most 3 m.
  - Then SLDEM - LOLA: mean -0.49 m, std 6.95 m; the bias field (Gaussian 3 km of the difference)
    spans -6.75..+4.42 m and is removed so the two agree at long wavelengths; then SLDEM is feathered into the
    upsampled level-6 surface over the outer 2 km of the 20 km disc (smootherstep).
- **Levels 10-12 (LROC NAC DTM Apollo 11)**: 2 m posts, equirectangular (centre 180 E, standard parallel
  1 deg) taken from the GeoTIFF via GDAL/PROJ. Registration against the SLDEM-based surface (checked, not
  applied): high-passed correlation on an 8 m grid 0.296 at zero shift and 0.298 at the best shift of one 8 m
  pixel, i.e. co-registered within a pixel. NAC - SLDEM: mean
  -0.59 m, std 3.13 m.
  - **Stereo seam** (`seamCorrection`, `region.correct_column_seam`): the DTM has a seam along the NAC
    left/right image boundary, a step down to the east of up to 1.5 m (80-row block medians) running from DTM
    column ~970 (row 3000) to ~940 (row 13900), with a jog to columns 974-977 between rows ~7900 and ~8900;
    weak or absent north of row ~3000. It is tracked as one path: per 80-row block, step(c) = sum over 7
    columns of the block-median column-to-column offset minus its 41-column running median, scored as
    sign x step / noise; dynamic programming over the blocks with a cost of 0.5 per column of jump (at most 30)
    picks the path and its sign. A block is corrected where the step at the path is significant (its own z over
    3.5..5, or the mean z over 5 blocks along the path over 2.5..4): the step is replaced by a 240 m
    smootherstep ramp (long wavelengths kept), and an across-track notch (Gaussian 1.5 columns, full within 4
    columns of the path) removes the thin ridge/groove pairs a block profile cannot follow. Result: 108 of 173
    blocks corrected (79 fully), path columns 940-976, step at the path RMS 0.74 -> 0.15 m, max 1.53 -> 0.72 m
    (block noise 0.10 m); the largest height change anywhere is 0.99 m, and nothing changes away from the path
    or in blocks without a significant step. (The first bake picked the strongest excess of every 250-row block
    independently, which jumped between unrelated columns in the north and missed the seam next to the target.)
  - **Bias**: Gaussian 1 km of the NAC - SLDEM difference in the interior; within 400 m of the strip edge a
    Gaussian of 60 m (blended to the 1 km field over the next 600 m), so the 300 m feather never bridges a
    local offset (2.17 m with the 1 km field alone, 0.62 m now); field range -14.2..+8.9 m. Consequence: within
    ~1 km of the strip edge, NAC relief wider than ~150 m follows SLDEM. That zone reaches into the 1.5 km
    mission disc, which comes within 357 m of the strip edge: there the edge-local field changes heights by up
    to 3.15 m (p95 0.59 m, 5.7 % of the disc by more than 0.5 m); within 910 m of the target nothing changes
    (below 1 cm). The feather starts where the filtered NAC stencil no longer touches missing pixels.
  - Along-track stripes other than the seam: column-coherent signal in the NAC DTM is 2-10 cm RMS (block-to-block
    correlation of the column profile 0.11-0.13 against 0.01 for rows); not filtered.
- Run-time blending (COVERAGE_BLEND_TILES) is not implemented here: the bake makes every coverage edge sit
  on data that converge on the parent (measured in section 3), so the run-time ring has nothing to bridge.

### 4.2 Albedo

- **Base colour**: SVS CGI Moon Kit `lroc_color.exr` (linear float, 27360 x 13680), resampled to
  27648 x 13824 (Catmull-Rom) for an exact mip chain. Calibration: one gain **0.29589** so the median
  643 nm (red) of six maria = 0.07: Tranquillitatis 0.054, Serenitatis 0.076, Imbrium 0.076, Crisium 0.072,
  Procellarum 0.058, Fecunditatis 0.068; resulting highlands: 0.184 (10N 160E), 0.150 (20S 140E), 0.171
  (30N 170W), 0.160 (30S 10E), 0.136 (12S 5E, a mixed area), 0.222 (0N 120E): median 0.166, inside the
  0.15-0.25 target. Registration against the WAC mosaic (4 maria windows): the SVS map sits 2.2 WAC pixels
  west and 0.7 pixels south; sampled with that offset (lon +0.00722 deg, lat -0.00233 deg). Effective
  resolution of the SVS map: Gaussian sigma 500 m (best correlation with the filtered WAC). The fix round's
  re-bake reproduced every one of these numbers.
- **SVS residual shading**: Hapke normalisation only corrects the reference sphere, so crater walls kept
  part of the source images' shading. Regressing the high-passed log red on LOLA slopes (filtered to 500 m)
  in 1 deg cells gives a median gradient of 0.11 per unit slope; that factor (0.72..1.44) is divided out of
  all three channels within +-70 deg (fade 66-70 deg). Region medians are unchanged (the shading averages out).
- **Detail (levels 6-7)**: LROC WAC 100 m morphology mosaic (illumination baked in), streamed by HTTP range
  reads together with LOLA. Fitted illumination of the mosaic (1 deg cells, 37,739 good cells): median
  incidence 67 deg (10-90 %: 57-74 deg, matching the mosaic's documented 55-75 deg), r^2 median 0.49, sun
  from the east in 25 % of the cells. Each pixel is divided by the modelled lunar-Lambert shading
  (McEwen 1996 L(phase)) at that geometry; shadows (S < 0.25 or < 0.35 x the 1 km mean) are dropped and the
  detail fades toward them over a 2-pixel (~200 m) Gaussian; the result is high-passed against the SVS
  resolution (sigma 500 m) and clamped 0.7-1.3. Detail fades out between 65 and 69 deg latitude (polar SVS
  is inpainted).
- **Detail on steep slopes** (`albedo.steep_attenuation_at`): the 118 m LOLA cannot model the mosaic's shading
  of terraces and slumps on steep walls, so the detail amplitude falls from 1 below 10 deg to **0.5** at 26 deg
  and above (smoothstep). The slope is taken from the level-4 surface (666 m samples, Catmull-Rom) by one-sided
  400 m differences toward east, west, north and south (sqrt of the summed squares / 2b^2, so a rim crest or a
  bowl floor still counts as wall), evaluated on a 129 x 129 vertex lattice per tile (neighbouring tiles share
  their edge nodes, also across cube edges) and interpolated bilinearly to the texels. The first bake removed
  the detail outright above 20 deg with a mask from the level-6 surface over 166-333 m, which outlined every
  large crater wall with a sharp change of texture (doubled rims, smooth painted bands; review finding 7).
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
  inside the 1e-3..1e-2 target; all-sky median 7.1e-5 cd/m^2. The verifier recomputes these from the shipped
  faces (section 3).
- The same non-linearity seen through the cube: isolated catalogue stars as the cube carried them before
  removal (window sum of before - after) have 1.43 x their catalogue illuminance at V 6.0-6.5, 2.02 x at
  V 4.5-5.0 and 0.42 x at V 0-0.5 (saturation). The catalogue stars themselves are removed from the cube; the
  fainter stars left in it are therefore up to ~0.4 mag too bright just below the cutoff.
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
   regions). Example for Taurus-Littrow: centre 20.19 N 30.77 E, SLDEM band unchanged (keep its
   `trackStripeCorrection`: the LOLA tracks run along the grid columns at every latitude of the 60 N - 60 S
   product), NAC band source
   `https://pds.lroc.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO17/NAC_DTM_APOLLO17.TIF`
   (463,397,471 B). Leave out `seamCorrection` unless a seam is seen in a hillshade of that DTM; its
   parameters (search columns, block size, significance) are specific to a DTM.
2. `python -I tools/bake/moon/region.py moon-<site>` (bakes its tiles, merges its rectangles, source
   rectangles and tile hash into the manifest; refuses regions whose tiles overlap another region's).
3. `python -I tools/bake/moon/target.py moon-<site>` if the region needs a touchdown target (`targetSearch`).
4. `python -I tools/bake/moon/verify.py --region moon-<site>` and `sheets.py --region moon-<site>`.

## 7. Known limits

- **Tycho benchmark** fails the 60 m tolerance (request `docs/requests/bake-moon-sky-1.md`): the benchmark
  comes from PDS ldem_64, which is shifted 1-2 pixels of 118 m in longitude against the 256 ppd products, and
  it sits on the steep central peak. The other three benchmarks agree within 6 m.
- **Crater-wall test** not met as written (request `docs/requests/bake-moon-sky-2.md`): 13 of 26 craters have a
  west-/east-facing wall ratio within 5 % (15 in the first bake; keeping half-strength detail on steep walls moved
  Delisle and Herschel just past 5 %). The deviations are real albedo asymmetries of the SVS base, which alone
  already fails 5 % on 11 of the 26 (Dionysius' dark-halo ejecta, Picard and Menelaus on mare/highland contacts,
  Proclus' rays); they do not correlate with the mosaic's baked shading (r = -0.05; raw mosaic ratios 2.2-8.7),
  and their geometric mean is 0.975.
- SLDEM track stripes: the correction leaves faint traces where a track's error exceeds the 3 m clamp, mostly
  inside craters and where several tracks lie within a few columns (e.g. beside the NAC strip's west edge,
  `out/bake/moon/nac-strip-edge-L12.png`). SLDEM's own 59 m posts make levels 8-12 outside the NAC strip
  smooth at their sample spacing; the global LOLA levels carry their own faint N-S track streaks (visible in
  the LOLA surround of `region-L9.png`), which this package did not filter.
- The edge-local NAC bias mutes NAC relief wider than ~150 m within ~1 km of the strip edge, including the
  outer part of the mission disc (section 4.1); the target itself and the inner 900 m are unaffected.
- The `seamCorrection` (NAC stereo seam) and the edge-local NAC bias are data-driven but tuned on this DTM;
  a new region should check its own hillshade (`sheets.py`) before reusing those parameters. A faint trace of
  the seam can remain where it moves by a column or two inside an 80-row block.
- Between the SLDEM disc and its coverage edge, and between the NAC strip and its coverage edge, the regional
  levels carry upsampled coarser data (as the brief asks for one tile of margin); `sourceCoverage` marks where
  the real data are.
- Albedo detail fades to half strength between 10 and 26 deg of slope (measured at ~1 km) and is absent
  poleward of 69 deg, where levels 6-7 show the 500 m SVS colour upsampled. The de-shaded detail on steep walls
  keeps some of the mosaic's terrace shading the 118 m DEM cannot model (it moved two craters of the wall test
  past 5 %, section 7). Mosaic seams where the WAC sun azimuth flips between orbits are
  smoothed over ~1 deg by the fitted illumination field; a faint residual can remain there.
- The SVS hiptyc layer is clipped and only approximately linear (section 4.3); stars fainter than the
  catalogue cutoff left in the cube inherit that, up to ~0.4 mag.
- Moon tile set size is 3.46 GB, below the brief's 4-7 GB estimate: lunar albedo compresses well
  (level-7 WebP at quality 95 averages ~9 KB per tile; albedo 1.19 GB in total) and heights take 2.27 GB.
- Raw downloads were deleted after verification (LOLA, SVS colour EXR, NAC TIF, sky EXRs and HYG); the
  region sources stay cached as `.npz` in `data/cache/moon/work/region-moon-tranquility` (needed by the
  verifier and the target search). SVS mips and WAC detail (7.6 GB) are deleted after each albedo bake, so
  re-baking the albedo tiles re-runs the `svs`..`svsdeshade` steps (~25 min plus the 989 MB download).

## 8. Requests

Filed by this package:
- `docs/requests/bake-moon-sky-1.md` (lead; not blocking; open): re-base or widen the Tycho benchmark.
- `docs/requests/bake-moon-sky-2.md` (lead; not blocking; open): re-base or accept the per-crater wall-ratio
  criterion.

Against this package's paths:
- `docs/requests/terrain-core-2.md` (NAC seam, stripes in levels 10-12): resolved (seam tracked and notched,
  SLDEM altimeter-track stripes removed, levels 7-12 re-baked).
- `docs/requests/terrain-core-1.md` (`sourceCoverage`): the Moon part is done (the manifest writes
  `layers.height.sourceCoverage`, section 1, and terrain-core keys the effective level on it); the contract text
  in `src/core/contracts/terrain.ts` is the lead's, so the request stays open for that part.
- `docs/requests/terrain-core-4.md` (levels whose source is coarser than their posting): resolved for the Moon
  (level 9 lists no source tiles); the Earth part is bake-earth's.

No change to `tools/bake/common` or any contract was needed.

## 9. Notes for the consumers

- **terrain-core / terrain-render**: the regional rectangles are on face 0 only; level-12 sample spacing at the
  site is ~2.9 m. RMS slope at 2/4/8 m is 3.20 / 3.18 / 3.10 deg on the level-12 data (section 3) for amplification
  calibration. `sourceCoverage` now lists no level-9 tiles (terrain-core-4). Re-run
  `tools/terrain-core/render-hillshade.ts` and the realData suite to pick up the re-baked regional levels.
- **sim-world-pilot**: `recommendedTarget` (0.661471 N, 23.435999 E, -1907.80 m) is in the region file;
  the region tool keeps the target when re-run, `target.py --keep` re-evaluates it, `target.py` alone searches
  anew.
- **sky-lighting**: luminance of a texel in cd/m^2 = `luminanceScale` x stored RGB (the brightest texel after
  star removal stores ~1.4e3, the all-sky median ~3.5, i.e. 2.8e-2 and 7.1e-5 cd/m^2); catalogue stars are
  not in the cube. Faces are rows top to bottom, level 0 first; WebGPU `writeTexture` per face and mip with
  bytesPerRow = 4 x size.

## 10. Crash recovery and review fixes (2026-11-10)

The first fix round was interrupted at about 01:33 by the machine's bugcheck while it re-baked the albedo
(detail step at band 190 of 280). On resumption:
- No zero-length files anywhere under `data/tiles/moon`; the 1,040 files written in the hour before the crash
  were the regional height tiles and the manifest (01:24-01:27), and all JSON files (manifest, registry,
  region file, calibration, reports) parsed. The regional levels were re-baked anyway with the final code.
- The SVS mips written 17 minutes before the crash were checked (each mip equals the 2 x 2 box of the one
  above within one float16 step; no zero or non-finite row band) and reused; `wac_detail.u8` (half-written) was
  rebuilt by the `detail` step, then `svsdeshade`, `tiles`, `lowres`, `build`. The albedo tiles of the first
  bake had not been touched by the interrupted run.

Review findings (independent review of the first bake) and what was done:
1. Open requests against this package (major): all answered (section 8); terrain-core-2 fixed in the data, the
   Moon part of terrain-core-1 delivered, and terrain-core-4 (filed after the review) resolved.
2. NAC seam not tracked as one line (minor): rewritten as a tracked path with significance gating and a notch
   (section 4.1); levels 10-12 re-baked; the seam descriptions in the region file and here agree.
3. Crater-wall criterion (minor): request bake-moon-sky-2 filed with the per-crater table and correlation
   evidence; the geometric-mean line is printed as INFO, not as a passing acceptance check.
4. Wrong claim that the edge-local bias leaves the mission disc untouched (minor): corrected (section 4.1); the
   verifier measures it (`nacEdgeBias`).
5. Tautological coverage-edge check (minor): now random points of the quarter-tile ring against the blended
   parent surface D_(L-1) (section 3).
6. Sky photometry restated from the bake report (minor): the verifier recomputes the galactic-centre luminance
   from the shipped faces with the manifest's luminanceScale and checks the photometric chain on catalogue stars.
7. Albedo ring artefacts on crater walls (minor): smooth slope mask with a floor of 0.5 (section 4.2); the
   `deshade-*.png` sheets now show the mask as a fifth panel.

## Changes by the lead between the waves (2026-11-10)

- `bake-moon-sky-1` resolved: the Tycho benchmark is judged against the PDS `ldem_256` pixel at its
  coordinates (-1357.0 m; level 6 mean -1383.5 m, 26.5 m off); the other three stay on `ldem_64`
  (`BENCHMARKS` in `tools/bake/moon/verify.py`). No tile changed.
- `bake-moon-sky-2` resolved: the de-shading acceptance is "geometric-mean west/east wall ratio within 5 % of
  1 over at least 20 craters and |r| < 0.3 between the per-crater log ratios and the raw mosaic's" (0.975,
  r = -0.051 on 26 craters); the per-crater count (13 of 26 within 5 %) is printed as information.
- `python -I tools/bake/moon/verify.py` now ends with **ALL CHECKS PASSED** (56 s, run by the lead through
  the gate); section 3's "2 acceptance checks fail" and the first two items of section 7 describe the
  criteria as they were. The brief's acceptance sentence was changed accordingly.

Full list: `docs/handoff/lead-baseline.md`.
