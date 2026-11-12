# planet-bake: hand-off

Wave 3.1, MIGRATION_V2 step 3.8. Tile pyramids for the 25 solid bodies other than Earth and the Moon, the
giants' cloud-top maps and Saturn's ring strip, the generic amplification models `rocky-generic` and
`icy-generic`. This file is kept as a running log from the start (sessions get cut off); the sections after
the log are the hand-off proper.

## Running log

- 2026-11-12 00:35 start. Read STATUS, the brief, PROMPT, ARCHITECTURE 8.5/10.1/10.2, MIGRATION_V2,
  PACKAGE_RULES, user-decisions, solar-system.md 2-5, the bake hand-offs (earth, moon), lead-baseline-v2
  (terrain guard), terrain.ts, the amplification registry and the lunar model.
- 00:41 terrain guard BEFORE any change: `node tools/dev/heavy.mjs --class=cpu -- npx vitest run
  tests/unit/terrain-core/terrain-guard.test.ts`: 4 of 4 pass (10.2 s).
- 00:45 USGS bucket listed (`asc-pds-services.s3.us-west-2.amazonaws.com/?list-type=2&prefix=mosaic/<Body>`):
  every source of solar-system.md 5.3 exists, with `.md5` sidecars that the fetch verifies.
- 00:50 Solar System Scope textures cannot be fetched by our tooling (the server drops non-browser clients;
  imitating a browser was refused by the session's permission system and was not worked around). The brief
  prefers mission maps anyway ("Solar System Scope CC BY 4.0 where no mission map exists"): a research pass
  found mission maps for every giant (NASA PIA07782 Jupiter; Cassini ISS Saturn map in PDS; Hubble OPAL
  Uranus and Neptune, CC BY 4.0) and the Cassini UVIS ring occultation profile (PDS) for the ring strip.
  No openly licensed global map of the Venus cloud tops exists (not in this brief's scope; noted for
  planet-render).
- 01:20 tool written (`tools/bake/planet`: config, fetch, source, heights, albedo, procedural(.ts), giants,
  bake, verify, sheets), 29 configs (25 solid, 4 giants), credits, the generic models
  (`src/terrain/amplification/{generic,rockyGeneric,icyGeneric}.ts`, registry entries, parameter files),
  unit tests. Landmark coordinates from the IAU Gazetteer (research pass, URLs in each config's `ref`).
  Commit 991c734. Request bodies-ephemeris-2 (against my paths) resolved: 0144348.
- 01:35 the bake slot is held by site-bake's staging job (since 00:59); the first bake (Ceres) waits in the
  gate. Downloads of 16 bodies' sources run meanwhile under `--class=cpu` (single process, network bound).

- 01:40 giants staged under `--class=cpu` (single process): Jupiter (PIA07782), Saturn (Cassini ISS PDS map;
  its ring-shadow and polar gaps are value 0 and are filled zonally), the ring strip (UVIS), Uranus and Neptune
  (OPAL; their limb-smeared latitudes are cut at -25 / +32 deg and filled zonally). Looked at
  `out/bake/planet/giants*.png`: Great Red Spot in the south, bands continuous, the ring strip shows the C ring
  plateaus, the opaque B ring, the Cassini Division and the Encke gap.
- 01:45 THE LONGITUDE TRAP, caught before any bake: the USGS GeoTIFFs whose ISIS label says
  `LongitudeDirection = PositiveWest` (Io, Europa, Ganymede, Callisto, Rhea, Titan, Iapetus) are laid out with
  east to the right like every other file; the label only numbers the longitudes westward. Proof
  (a scratch preview of both readings with Gazetteer landmarks, since lost; the check it made is now
  permanent: verify.py runs every body's landmarks on the map mirrored and shifted by 180 deg and requires
  them to fail, and `tools/bake/planet/views.py` renders the close views): in the east-increasing reading Pele's
  red plume ring and Loki's dark horseshoe sit on their Gazetteer positions, Ganymede's Tros rays and Galileo
  Regio, Callisto's Valhalla and Asgard, Titan's Xanadu, Belet and Shangri-La, Europa's dark trailing
  hemisphere around Pwyll, Iapetus' bright trailing hemisphere (brightest 60-degree band centred at 81 E); the
  mirrored reading puts every one of them in the wrong place. All seven configs now say `lonPositive: east`
  (the config key describes the pixel layout); the landmark tests lock it in.
- 01:50 (09:36 UTC) disk at 32 GB free while site-bake stages its region: the Mercury and Mars downloads
  (11.2 GB, checksums recorded) were deleted again; they are re-fetched (about 4 minutes) right before their
  bakes, one body at a time, and deleted after each is verified. 8-bit sources now keep their mips in
  float16 (half the intermediate disk).

- 02:57 (10:57 UTC) the bake slot came free (site-bake's staging job held it 2 h). Batch 1 (23 bodies):
  17 baked in 12 minutes, Callisto failed (odd grid without mips: regridded now), five refused by the disk
  floor (24.2 GB free: other packages' data/packs 14 GB and caches). Looked at every sheet: orientation right
  everywhere (Occator, Pele and Loki, Tros, Galileo Regio, Valhalla, Xanadu, Herschel, Europa's trailing
  hemisphere); found (a) bright icy bodies clipping at white (Rhea, Ganymede, Tethys): the gain is now
  capped so at most 0.5 % of a body reaches the 8-bit ceiling; (b) Iapetus' mosaic equalised region by
  region (Cassini Regio mid-grey): restored from its own low-frequency pattern by percentile rank
  (`albedo.lowFrequency`), now 6.4 x darker than the bright side, as the real body.
- 03:10 batch 2 (albedo re-runs, Callisto, Dione): the clean-after could not delete memory-mapped files on
  Windows (fixed: `release`); stopped by me at the disk floor (24 GB), cleaned in a fresh process (31 GB
  free). Step fingerprints no longer include the landmark tests.
- 03:20 batch 3: Triton, Charon, Venus, Pluto, Mercury, Mars with `--split-passes` (height pass, clean,
  albedo pass, clean; one source at a time; Mercury's 166 m and Mars' 232 m mono maps decimated by 2 into an
  8-bit copy so their 4.25 GB downloads are deleted at once). Unit tests: 55 of 55 (19 tile sets through the
  real TerrainProvider, one body at a time).

- 04:20 (12:20 UTC) Mars' first albedo looked wrong (the dark maria blue, not dark: MDIM 2.1 is
  brightness-normalised, so its luminance had lost the albedo pattern while the colour map's chroma was
  kept); `albedo.colourMode: detail` makes the colour map set albedo and colour and the mono map add only
  detail. Re-baked (albedo pass only): Syrtis Major 1.27 x darker than its ring, Hellas bright, polar caps
  white. Final: verify.py --all 666 checks, 0 failed; vitest 77 of 77 (with PLANET_BAKE_REQUIRE=1); terrain
  guard 6 of 6; check-stubs, boundaries (93), typecheck of my paths clean. All downloads and intermediates
  deleted (`data/cache/planets` 89 kB of resume state). Disk 32.4 GB free.

- 04:50 (12:50 UTC) request bodies-ephemeris-5 (coordinator): (1) `data/staged/render/albedo-means.json`,
  written by verify.py, has every body's level-0 mean linear colour (solid-angle weighted) and where it comes
  from; the tints of the monochrome Europa, Callisto, Iapetus and the colours of the procedural Uranian moons
  are now published disc-integrated colour indices (Harris 1961; Karkoschka 2001), Mimas stays neutral (no
  measured index); (2) procedural craters above the gravity-scaled simple-to-complex transition follow
  Schenk's complex depth law (300 km basins were 47-64 km deep, now a few km). Nine bodies re-baked through
  the gate; verify 666 of 666; sheets looked at. The terrain guard's directory summary now differs ONLY in
  site-bake's Madrakah additions to the earth set (earth manifest, earth/albedo/2/10/175-185), which that
  package states and the lead re-records; heights bit-exact; this tool never writes earth or moon.

- 13:00-15:00 UTC: the independent review's findings (coordinator), each fixed and re-baked through the
  gate (decisions 12-21; details in sections 4-6):
  (1) dark +-180 seams in Mars' and Venus' albedo: a nodata value declared by the file but not by the config
  is now an error (Mars albedo/colour/DEM and Mercury albedo/DEM corrected), Venus' 1-px dark fringe around
  dropouts is dropped before the fill, verify.py measures every body's +-180 and 0 meridians (old Mars 0.49,
  every body now 0.985-1.012; Mars and Venus at +-180 looked at, `out/bake/planet/views/`); (2) every body's landmarks must fail on the map mirrored and shifted by 180 deg
  (verify.py and a new vitest file); new asymmetric landmarks: Venus Maat Mons, Pluto Burney, Charon Dorothy
  and Argo Chasma, Phobos Stickney's depth, Enceladus Dunyazad, Zumurrud, the long axis and a basin;
  (3) Phobos and Enceladus have their global DEMs (Phobos -2,928..+2,939 m, Enceladus -4,470..+4,726 m:
  request planet-bake-1 to bodies-ephemeris); (4) Mercury's albedo is the low-incidence basemap (streamed,
  valid 0.952: its polar gaps filled along rows and, for the 24 empty rows at the south pole, zonally); (5) the clip cap is measured at the
  finest sampling, the lowFrequency path capped, every body now at most 0.5 % clipped (Iapetus was 3.7 %);
  (6) polar pinwheels and fills smoothed (Io, Rhea, Ceres, Europa, Callisto), valid fractions listed;
  (7) giant seams: point-registered edge columns averaged, Uranus' and Neptune's hemisphere seams and
  Saturn's 0-deg seam feathered, a step-and-line seam check; (8) OPAL credits say "modified"; (9) step
  fingerprints chain (and fold in the prepared sources); (10) the weights test now checks run time +
  bake = the whole population through CraterField.add; albedo landmarks and the mirror self-test run in
  vitest; (11) inherited mosaic boundaries listed, Triton white-balanced to B-V 0.70, Enceladus' unfiltered
  mosaic evaluated and not used. The lost scratch preview of 01:45 is replaced by `views.py` and the
  mirror self-test. Mars and Mercury heights were accepted, not re-baked (decision 21: their DEMs, streamed
  and hashed, hold no pixel of the nodata value now stated); Mars' MDIM valid 0.9976, colour 1.0000.
  Verify 814 checks, 2 failed (only the staged-section cross-check of request planet-bake-1); vitest 119 of
  119 with the terrain guard. The strict clip cap made the bright moons darker than their albedo (fixed in
  the next entry).

- 17:00-20:00 UTC: the lead's decisions on the review report. (1) Mean = albedo with a soft highlight knee
  (decision 20): every body's level-0 mean is now its configured albedo within 0.4 % (Tethys -1.4 %: it
  holds 0.789 of 0.80), at most 0.011 % of any body at 254 DN or above; Enceladus' target is 0.77, the most
  its high-pass mosaic holds under the ceiling (Bond albedo 0.81). Two shapes were tried and dropped: an
  exponential shoulder (could not hold Enceladus or Tethys) and a local variant (kept more bright-ground
  detail but held a third of the bright moons' albedo). The first knee bake let lossy WebP lift near-white
  texels over 254 DN (Dione 3.9 %), so the calibration now keeps 4 DN of margin. verify.py checks the mean
  against the target (2 %) and the share at the ceiling; four landmark thresholds lowered and Rhea's Inktomi
  test turned into a texture test (bright-on-bright contrast is compressed by the knee), Dione's
  hemispheric test removed. All 25 albedo layers re-baked through the gate; looked at Enceladus, Europa,
  Tethys, Dione, Iapetus (two tones kept) and Pluto at true albedo (`tools/bake/planet/looks.py`). (2) The
  Phobos DEM's licence class (no access or use constraints, credited) is accepted and stated in
  credits.json. Verify 838 checks, 2 failed (the staged-section cross-check of request planet-bake-1);
  vitest 120 passed, 1 skipped (Dione's self-test is left to verify.py: its one landmark is too small for
  the low-res map), the terrain guard's 7 included. Disk 37.2 GB free.

## 1. What consumers get

### Tile sets `data/tiles/<id>/` (served at `/tiles/<id>/`), one per solid body

Standard layout and `TileManifest` (`src/core/contracts/terrain.ts`), written through
`tools/bake/common/layout.write_manifest` (validated, `contentHash`):

| | |
|---|---|
| Frame | the body-fixed frame of the IAU rotation model (pck00011): +Z north pole, +X prime meridian, east longitude, planetocentric latitude. Every source is re-registered to it (west-positive maps mirrored, planetographic latitudes converted, point/cell registration honoured) and the landmark tests prove it |
| `radius` | the body's MEAN radius (= `BodyDef.radius`, the datum sphere) |
| `height` | `frt1-height`, global levels `0..maxLevel` (no sparse levels), `heightScales` 0.5 m. Height = reference surface - mean radius + DEM: the reference is the triaxial ellipsoid of the config's radii, or for a DEM given against a sphere that sphere (Mercury 2,439.4 km, Venus 6,051.0, Ceres 470.0, Pluto 1,188.3, Charon 606.0, Phobos 11.1, Enceladus 251.5); Mars' MOLA heights are on the areoid and are added to the IAU ellipsoid (the brief's rule; the areoid's +-2 km undulation is not modelled). So physics and rendering see the body's shape (Phobos' 8.2-14.0 km radii, Iapetus' 20 km flattening, Mars' 20 km) as an ordinary heightfield. Additive field `elevation: {min, max}` (finest level, m above `radius`) and `build` (content hash) |
| `albedo` | `webp` 256 x 256 opaque RGB, global levels `0..maxLevel`; sRGB base colour, calibrated so the area-weighted mean luminance (linear) equals the configured albedo (NSSDC geometric albedo, solar-system.md 2.5, where the map can hold it; Iapetus on its bright hemisphere), highlights through a soft knee toward 1.0 (decision 20). Additive `calibration` (gain, knee start and form, sampled mean and ceiling share, highest reachable mean) and `build` |
| `globals.albedoLowRes` | `globals/albedo-lowres.png`, 1024 x 512 equirect (row 0 north, column 0 at 180 W), as the Moon's |
| `residentHeightLevel` | min(3, height maxLevel) |
| `body` (additive) | `name`, `radii {mean, a, b, c}`, `reference`, the resolved `amplification` definition (model, seed, params) the run-time model must use, `bakeConfig` |

### Giants `data/staged/render/`

`<id>.maps.json` per giant (descriptor: path, size, channels, format, conventions, credit, licence) and
the maps under `<id>/`: `cloudTop` (equirect, row 0 north, column 0 at -180, east-positive body-fixed
longitude, planetocentric latitude) for Jupiter, Saturn, Uranus and Neptune; `saturn-rings` (radial RGBA
strip, 74,658-136,780 km, alpha = normal opacity 1 - exp(-tau)).

### Mean colours `data/staged/render/albedo-means.json`

Regenerated by every verify.py run: per body the mean linear RGB and luminance of the level-0 albedo (six tiles
decoded from sRGB, solid-angle weighted: the disc mean over the whole sphere) and `colourBasis` (colour map,
or a MONOCHROME map times a tint, or a procedural colour, each with its source). For `render.meanColor` take
the chromaticity (request bodies-ephemeris-5).

### Credits `data/staged/credits.json`

`{ formatVersion: 1, generatedBy, note, entries: [{ id, title, author, url, licence, licenceUrl,
attribution, bodies: [names] }] }`, one entry per source of every config (the source list is
`tools/bake/planet/credits.json`). `attribution` is the line for the Credits screen. Every licence is public
domain (NASA/USGS/PDS) or CC BY 4.0 (Hubble OPAL, credited as modified), or the third licence class the
lead accepted: a provider statement of no access or use constraints, credited (the Phobos DEM, a DLR/ESA
Mars Express product distributed by USGS: "Access_Constraints None, Use_Constraints None"; credited to
ESA/DLR/FU Berlin, Willner et al. 2010). No map whose author forbids redistribution is used.

### Amplification models

| Key | File | Parameters | Bodies |
|---|---|---|---|
| `rocky-generic` | `src/terrain/amplification/rockyGeneric.ts` | `data/defs/terrain/rocky-generic.amplification.json` | Mercury, Venus, Mars, Phobos, Deimos, Io, Ceres |
| `icy-generic` | `src/terrain/amplification/icyGeneric.ts` | `data/defs/terrain/icy-generic.amplification.json` | the other 18 |

Both are the lunar-regolith algorithm (`createGenericModel` in `generic.ts` wraps the frozen
`createLunarRegolith`, proven output-identical by `generic.test.ts`) under their own keys and parameter sets;
they require every parameter (`GENERIC_PARAMS`) and reject unknown ones. A body's definition is its model's
parameter file + the config's `amplification.params` overrides + the config's seed (`resolved_amplification`
in `tools/bake/planet/procedural.py`; bodies-ephemeris' generator uses the same rule, request
bodies-ephemeris-2). Exported for tools: `genericCraterParams(def, R, g, lambda0, maxDiameter)`,
`runtimeCraterLog2MaxD(def, lambda0, E)`, `GENERIC_MODELS`, `GENERIC_PARAMS`.

## 2. How to run

Interpreter: `data/cache/earth/venv` (Python 3.10, numpy, numba, rasterio, Pillow, scipy, tifffile). Every
bake through the gate, from the repository root (the gate runs `cmd.exe`, so backslashes in the interpreter
path):

```
node tools/dev/heavy.mjs --class=bake --label=planet -- data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/bake.py <id> [<id> ...]
node tools/dev/heavy.mjs --class=bake --label=planet -- data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/bake.py --kind giant
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/bake.py --credits          # data/staged/credits.json
node tools/dev/heavy.mjs --class=cpu -- data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/verify.py --all
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/sheets.py --all            # out/bake/planet/<id>.png
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/views.py --all             # out/bake/planet/views/<id>.png: +-180, 0, poles
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/looks.py <id>:<lat>:<lon>:<capDeg> ...   # true-albedo global + close view
node tools/dev/heavy.mjs --class=bake --label=planet -- data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/reach.py <id> --clean   # highest reachable mean albedo
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/bake.py <id> --clean       # delete downloads + intermediates
node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/planet-bake src/terrain/amplification tests/unit/terrain-core/terrain-guard.test.ts
```

`--accept-height` (decision 21) marks a height step done without re-baking, only after streaming the DEM
and proving it holds no pixel of the (newly stated) nodata value.

Steps of a solid body: `fetch` (resumable range download into `data/cache/planets/<id>/dl/<source>/`,
provider MD5 and the config's sha256 checked; `--record-checksums` fills them on a first download),
`prepare` (windowed reads into a memory-mapped mip chain: the TIFF itself when it is an uncompressed strip
file without nodata, else a float32/float16 copy, regridded onto an exact 2:1 global grid when the file is
not one, nodata filled by pull-push, optional polar smoothing; a decimated source is streamed instead and
never stored; the download is deleted once a copy is prepared), `procedural` (map-less bodies: `procedural.ts` through `npx tsx`, up to 6 parts),
`height`, `albedo`, `manifest`. Each step records a fingerprint (the config it reads, the prepared
sources' fingerprints, its code version and its upstream steps' fingerprints) in
`data/cache/planets/<id>/work/state.json` and is skipped when unchanged, so an interrupted bake resumes.
At most 6 worker processes, below-normal priority (`moon/rt.pool`). Adding a body or deepening one is a
config change only (levels, sources, landmarks).

## 3. Decisions, interpretations and deviations (each within the design; say so if you disagree)

1. **Giants from mission maps, not Solar System Scope.** The brief: "Solar System Scope CC BY 4.0 where no
   mission map exists". Mission maps exist for all four giants and the rings, and SSS cannot be fetched by
   our tooling (its server drops non-browser clients; imitating a browser was refused by the permission
   system and not worked around). Jupiter: Cassini PIA07782 (NASA/JPL/SSI). Saturn: Cassini ISS global
   colour map (PDS, doi:10.17189/rkkb-6y30). Uranus, Neptune: Hubble OPAL (CC BY 4.0; no openly licensed
   Voyager global map exists). Rings: Cassini UVIS occultation optical depth (PDS) + NSSDC region albedos.
2. **Venus cloud tops: not staged.** Not in this brief's list, and no openly licensed global cloud-top map
   exists (ESA VMC mosaics are under the ESA standard licence; Akatsuki UVI level-3 frames are CC BY
   compatible but are single-epoch half-globes that would need compositing). planet-render decides.
3. **Height reference.** "Height = ellipsoid radius - mean radius + DEM" is implemented as reference
   surface + DEM, the reference being the surface the DEM is given against: the IAU ellipsoid for bodies
   without a DEM and for Mars (MOLA's areoid is replaced by the ellipsoid, the brief's rule), and the DEM's
   own sphere where the product says so in its label (Mercury 2,439.4 km, Venus 6,051.0 km, Ceres 470.0 km,
   Pluto 1,188.3 km, Charon 606.0 km, Phobos 11.1 km, Enceladus 251.5 km: decision 16). Adding the ellipsoid to a sphere-referenced DEM would count the
   body's flattening twice (Ceres: 41 km).
4. **Procedural bodies** (Deimos, Mimas, Miranda, Ariel, Umbriel, Titania, Oberon): the crater population of
   their amplification model, at the diameters the run-time model does not draw (above 4 postings of the
   global max level, up to 0.4 R), is baked into BOTH the height (as the bodies' DEM) and the albedo (fresh
   craters brighter); the run-time model draws the rest with complementary weights, so each crater exists
   once (`generic.test.ts`). Mimas also gets Herschel (139 km) at its Gazetteer position (solar-system.md
   5.3 asks for it). Without baked relief these bodies would be smooth ellipsoids with painted craters.
5. **Mars albedo** = Viking colour 925 m (albedo and colour) x the detail of MDIM 2.1 mono 232 m (the
   design's own "finer" source, read at 464 m) as a ratio to itself at 925 m (`colourMode: detail`), so level
   6 (325 m texels) carries real detail; the 925 m colour alone would be a 3x upsample there. (MDIM 2.1 is
   brightness-normalised: used as luminance it erased the dark maria.) Ganymede uses the other mode
   (`chroma`: its 1 km mono map keeps the albedo pattern, the 1,435 m colour map gives the chroma).
6. **Resampling.** Finest height level: the DEM area-filtered over each vertex's local spacing (mips +
   Catmull-Rom + longitude taps), as the Moon's global levels; coarser levels: the existing full-weighting
   pyramid. Albedo: the finest level area-filtered from the source, coarser levels 2 x 2 means in linear
   light (no re-sampling of the source, no re-decoding of lossy tiles).
7. **Albedo calibration.** Every 8-bit mosaic is read as a display (sRGB) image; one gain and a soft
   highlight knee per body set the area-weighted mean luminance to the configured albedo, the NSSDC
   geometric albedo (as the Moon: mean 0.13 against 0.12) unless the map cannot hold it within the ceiling
   rule (decision 20); Iapetus calibrated on its bright hemisphere (0.5). Mono maps take a tint per body
   (in the config).
8. **No de-shading.** Most mosaics carry their imaging geometry's shading (Viking, MDIS, Galileo, Cassini;
   the Enceladus map is high-pass filtered, i.e. mostly shading). The Moon's albedo was de-shaded; here the
   placeholder-quality allowance of the expansion applies. On DEM bodies the renderer's normal-map shading
   adds to the baked shading at low sun.
9. **West-labelled USGS mosaics are east-increasing in layout** (running log 01:45): the config key
   `lonPositive` describes the pixel layout, and every USGS file used is east-increasing.
10. **Colours of monochrome and procedural bodies** come from published disc-integrated colour indices where one
    exists: Europa B-V 0.87, Callisto 0.86, Iapetus whole disc 0.71 (Harris 1961 via Pace 1971); Miranda,
    Ariel, Umbriel, Titania, Oberon B-V and V-R from Karkoschka 2001 (HST). Rule: relative reflectance B/V =
    10^(-0.4 Delta(B-V)) and R/V = 10^(0.4 Delta(V-R)) against the Sun (0.65, 0.53), or without V-R the slope
    continued linearly in wavelength; (R, V, B) taken as linear sRGB (R, G, B). Mimas has no measured index: grey.
    Mercury, Venus, Phobos, Tethys, Dione, Rhea, Enceladus, Titan, Pluto, Charon keep approximate tints (config).
11. **Complex craters on the procedural icy moons**: above D_t = 39.7 g^-0.4 km (Aponte-Hernandez et al. 2021)
    the baked crater depth is scaled to Schenk's (1989) complex fit d = 0.366 D^0.559 km, blended over
    D_t..2 D_t (request bodies-ephemeris-5); the run-time model's craters (below 4 postings) are unaffected.
12. **Landmark kinds**: `demHeight`, `albedoContrast`, `albedoCompare`, `craterDepth` and `albedoTexture`
    (luminance standard deviation, for craters in shaded mosaics where the mean says nothing). Every body's
    set must also FAIL on its map mirrored east-west and shifted by 180 deg (verify.py and
    `tests/unit/planet-bake/landmarks.test.ts`): a set that passes either way proves nothing (review 2).
13. **Nodata is the file's.** A source's `nodata` must equal the value its file declares, null only when the
    file declares none; anything else stops the prepare (review 1: Mars' and Mercury's configs said null
    against a declared 0 / -32768, so Mars' Viking colour map's empty first column was drawn as black).
    `nodataDilatePx` also drops the dark resampling fringe around dropouts (Venus' radar map: the pixels next
    to nodata have a median of 60 DN against 140 two pixels away; 1 px).
14. **Polar smoothing** (`polarSmooth`, Io, Ceres, Rhea, Europa, Callisto): toward the poles past a
    configured latitude, the prepared mip 0 is replaced by its row's circular longitude mean, the window
    growing from nothing at that latitude to the whole row at the pole (as the square of the distance: a
    linear ramp left a hard rim a degree inside a high limit), then by the mean over a latitude window growing
    likewise to +-2-4 deg (without it, row-to-row differences of the zonal means left a bull's-eye of rings
    at Rhea's south pole), for all pixels (Io's and Rhea's
    pinwheels, which are source data) or only the filled ones (Ceres' fill disc, Europa's and Callisto's
    flat fill polygons). A smooth zonal cap instead of an artefact; nothing is invented.
15. **Big mono maps are streamed** (Mercury, Mars): the 4.25 GB file is read once over HTTP in order, every
    byte hashed against the config's md5 and sha256, and decimated on the fly; it never touches the disk.
16. **Enceladus and Phobos DEMs** (review 3): Phobos the HRSC global DEM (Willner et al. 2010; heights about
    its own 11.1 km sphere, label `A_AXIS_RADIUS`; the ellipsoid fitted to DEM + 11.1 km is 12.94 x 11.32 x
    9.09 km against the IAU 13.0 x 11.4 x 9.1; its last three and first two columns, a stitch with duplicated
    columns and a 300-500 m trench along 179.4-179.9 E, count as nodata (`edgeColumnsInvalid`) and are
    filled; verify's height-seam check found it); Enceladus the Bland et al. (2020) shape model, its RADIUS
    product (radius minus 251.5 km, per its label) on that 251.5 km sphere, not its topography product,
    whose best-fit ellipsoid (fitted here: 256.3 x 251.2 x 248.3 km) differs from the IAU radii by up to 0.3 km.
17. **Mercury's albedo** is the MDIS low-incidence basemap (LOI, review 4): the morphology basemap (BDR) is
    taken at high incidence for shading and double-shaded under the DEM's normals.
18. **Enceladus' albedo stays the high-pass-filtered mosaic** (review 11 asked to evaluate the unfiltered
    `Enceladus_Cassini_mosaic_global_110m.tif`): looked at both at 0.5 deg (`out/bake/planet/eval-enceladus.png`);
    the unfiltered one's large-scale pattern is image-to-image brightness and illumination steps with hard
    edges, not albedo (Enceladus' albedo is nearly uniform), so it would paint mosaic tiles across the body.
19. **Triton's colour map is white-balanced** to its disc-integrated B-V 0.70 (HST, Pascu et al.) with the
    rule of decision 10 (`albedo.tint` on a 3-band map is a per-channel white balance): factors 1.115, 1,
    1.353 on the Voyager composite, whose violet/green/orange filters made it green.
20. **Mean = albedo, highlights through a soft knee** (the lead's decision on the review: the tiles are what
    the near-field renderer shades with). Per body one gain g and a knee start k: the finest level is
    y = knee(g x) on the brightest channel of the map's linear colour x (the other channels scaled with it,
    hue kept), with knee(x) = x for x <= k and k + (1 - k) t / (1 + t), t = (x - k) / (1 - k), above: a
    rational shoulder, continuous with slope 1 at k, approaching 1.0 and never reaching it (a surface cannot
    reflect more than it receives; an exponential shoulder could not hold Enceladus' or Tethys' mean without
    a tenth of the surface at the ceiling). g makes the area mean luminance (200,000 equal-area directions at
    the finest footprint; Iapetus over its calibration disc) equal the configured albedo; k is the highest
    of 0.85, 0.80, ... 0.15 at which at most 0.4 % of the surface comes within 4 DN of the 8-bit ceiling
    (lossy WebP lifts near-white texels by a few DN; verify allows 0.5 % at 254 DN). A procedural body's
    albedo is divided by its mean fresh-crater brightening so its mean is its albedo. Where no knee can hold
    the configured albedo within the ceiling rule (Enceladus, Tethys: maps whose shading spans a factor of 4
    and more), the config states the highest reachable mean instead (`tools/bake/planet/reach.py`). The
    manifest's `layers.albedo.calibration` records gain, knee (start and form), the sampled mean and ceiling
    share and the highest reachable mean. verify.py checks the level-0 mean against the target (2 %) and the
    share at the ceiling (0.5 %, finest level).
21. **Step fingerprints chain**: a step's fingerprint folds in the fingerprints of the steps it reads
    (procedural -> height, albedo -> manifest), so a re-bake of the height or albedo always re-writes the
    manifest (review 9); states written before the change are accepted only where the step's code is
    unchanged and its old fingerprint matches. `--accept-height` marks a height done WITHOUT re-baking only
    after proving the change cannot alter it (used for Mars and Mercury: the DEM, streamed and hashed,
    contains no pixel of the nodata value the config now states).

## 4. Measured against the acceptance criteria

| Criterion | Result |
|---|---|
| Terrain guard green before and after; no earth/moon file changed | Before: 4 of 4 (00:41, as recorded then). After the last bake of this package (12:58 UTC): heights bit-exact; the directory summary lists only site-bake's Madrakah additions to the earth set (the earth manifest and earth/albedo/2/10/175-185), which that package declares and the lead re-records, no moon change and nothing of this tool's. After the first full set of bakes: 6 of 6 (`tests/unit/terrain-core/terrain-guard.test.ts`, re-recorded by the coordinator on stored directions in between, cde7b30): heights at the fixed points bit-exact, file counts and names of every earth/moon directory unchanged. The tool cannot write them (`rt.FORBIDDEN_TILESETS`; configs named earth/moon are rejected). |
| Landmark tests per baked body catch a flipped or shifted map | 43 landmark tests over the 18 map bodies + Mimas' Herschel, all pass, and every body's set FAILS on its map mirrored east-west and on its map shifted by 180 deg (38 self-test checks; verify.py, and in vitest `landmarks.test.ts`: heights through the TerrainProvider, albedo on the low-res global map). New after the review: Maat Mons 9.0 km (mirrored 0.5, shifted -0.1), Burney 2.1 km deep, Dorothy 3.5 km, Argo Chasma -4.6 km, Stickney 1.1 km, Enceladus' Dunyazad and Zumurrud, its long axis +4.9 km and a 0.86 km basin. Examples: Olympus Mons DEM part 20,014 m at the Gazetteer centre (brief: about 21 km; the summit is 1.3 deg south), Arsia Mons 17,711 m (MEGDR 17,755), Badwater/Hellas -8,189 m (MOLA -8,206), Rachmaninoff -5,287 m (lowest point of Mercury -5.38 km), Maxwell Montes 10,676 m, Occator's Cerealia Facula 2.0 x its ring, Pele/Loki (Loki 1.8 x darker), Tros, Galileo Regio, Valhalla, Xanadu 17 x Belet, Iapetus 6.4 x, Sputnik Planitia 17 x Belton Regio and 1.7 km deep, Herschel 9.3 km deep. Procedural bodies (Deimos, Miranda, Ariel, Umbriel, Titania, Oberon) have no map to flip and no landmark. Also per body: no seam along the +-180 and 0 meridians in the albedo (66 checks; Mars was 0.49 there, Venus about 0.35, now 0.99 and 1.00) and in every DEM (Phobos' stitch found and removed), at most 0.5 % at the 8-bit ceiling (25 checks; Iapetus was 3.7 %). |
| Manifests promise only tiles that exist; no zero-length tile | verify.py: for every body and layer, promised = on disk exactly (no missing, no extra, no empty, no stray or `.partial` file); every height tile decodes to finite heights and shares its in-face edges with its neighbours to one quantisation step; every albedo tile is a 256 x 256 opaque RGB WebP |
| Every tile set loads through the TerrainProvider, lazily, one body at a time | `tests/unit/planet-bake/tilesets.test.ts`: for each of the 25 bodies a provider for that body alone, collision and band-limited heights at 24 points finite and inside the recorded range, residency complete after `ensureLoaded`, only that body's tiles cached; with `PLANET_BAKE_REQUIRE=1` a configured body that is not baked fails. all pass (counts in the self-verify row) |
| data/ under 22 GB with raw downloads deleted; >= 25 GB free; sizes per body | Baked data (rule 13d: tiles, sky, staged, defs) 17.05 GB after the review re-bakes (16.65 before), of which the 25 new tile sets 2.76 GB (147,612 tiles); the review's lowest disk point was 26.2 GB free (decimal GB, while Mars' colour map was prepared; other packages' data moved it between 24 and 34 GB), 30.7 GB at the end; every raw download and intermediate deleted (`data/cache/planets` holds only the resume state files). Disk 32.4 GB free at the end. The floor was breached twice for minutes during the bakes (24.2 GB in batch 1 when other packages' data/packs (14 GB) and caches grew under it; 24 GB in batch 3 while Mars' MOLA copy was written): each time the batch stopped or the step finished and its clean-up restored it; since then a bake fetches and prepares one source at a time and big bodies bake in two passes |
| Bakes through the gate, at most 6 worker processes | Every bake ran as `node tools/dev/heavy.mjs --class=bake -- ...` (three batches plus the Mars albedo re-run), pools of 6 below-normal workers (`moon/rt.pool`); downloads, verification, sheets and the giants' maps (single processes) under `--class=cpu` |
| Self-verify | After the lead's knee decision: `python -I tools/bake/planet/verify.py --all`: 838 checks, 2 failed, both the cross-check of bodies-ephemeris' staged terrain sections against the new Phobos and Enceladus DEM ranges (request planet-bake-1; nothing to fix on this side); every body's level-0 mean within 2 % of its albedo and at most 0.5 % at the ceiling (`out/bake/planet/verify.txt`). `npx vitest run tests/unit/planet-bake src/terrain/amplification tests/unit/terrain-core/terrain-guard.test.ts` (with `PLANET_BAKE_REQUIRE=1`): 120 passed, 1 skipped, the terrain guard's 7 included. Before the review: 666 of 666, 77 of 77 |

Also checked (verify.py): radii of every config = `data/staged/bodies/radii.json` (mean, a, b, c, to 0.5 m);
every staged terrain section of bodies-ephemeris names the tile set and carries exactly the resolved
amplification (model, seed, every parameter) and an elevation range containing the baked one; credits list
every source with a public-domain or CC BY licence.

Albedo calibration per body (verify.py; Iapetus' mean is over its calibration disc, the others over the whole
body; the share at the ceiling is solid-angle weighted at the finest level):

| Body | Level-0 mean | Target | Off by | At 254 DN or above | Knee from | Gain |
|---|---|---|---|---|---|---|
| Ariel | 0.3905 | 0.39 | +0.1% | 0.000% | (procedural) | 0.953 |
| Callisto | 0.1902 | 0.19 | +0.1% | 0.002% | 0.75 | 3.922 |
| Ceres | 0.0899 | 0.09 | -0.2% | 0.000% | 0.85 | 0.365 |
| Charon | 0.3503 | 0.35 | +0.1% | 0.000% | 0.75 | 1.511 |
| Deimos | 0.0702 | 0.07 | +0.3% | 0.000% | (procedural) | 0.977 |
| Dione | 0.7008 | 0.7 | +0.1% | 0.000% | 0.5 | 5.419 |
| Enceladus | 0.7709 | 0.77 | +0.1% | 0.003% | 0.25 | 11.696 |
| Europa | 0.6815 | 0.68 | +0.2% | 0.001% | 0.7 | 2.758 |
| Ganymede | 0.4405 | 0.44 | +0.1% | 0.011% | 0.7 | 6.377 |
| Iapetus | 0.5022 | 0.5 | +0.4% | 0.000% | 0.7 | 1.129 |
| Io | 0.6210 | 0.62 | +0.2% | 0.001% | 0.6 | 4.086 |
| Mars | 0.1702 | 0.17 | +0.1% | 0.000% | 0.8 | 1.684 |
| Mercury | 0.1423 | 0.142 | +0.2% | 0.000% | 0.85 | 0.941 |
| Mimas | 0.6005 | 0.6 | +0.1% | 0.000% | (procedural) | 0.954 |
| Miranda | 0.3208 | 0.32 | +0.2% | 0.000% | (procedural) | 0.952 |
| Oberon | 0.2304 | 0.23 | +0.2% | 0.000% | (procedural) | 0.954 |
| Phobos | 0.0701 | 0.07 | +0.1% | 0.000% | 0.85 | 0.252 |
| Pluto | 0.5203 | 0.52 | +0.1% | 0.002% | 0.4 | 5.927 |
| Rhea | 0.7008 | 0.7 | +0.1% | 0.000% | 0.65 | 5.158 |
| Tethys | 0.7889 | 0.8 | -1.4% | 0.000% | 0.15 | 18.858 |
| Titan | 0.2004 | 0.2 | +0.2% | 0.000% | 0.85 | 0.824 |
| Titania | 0.2712 | 0.27 | +0.4% | 0.000% | (procedural) | 0.956 |
| Triton | 0.7612 | 0.76 | +0.2% | 0.001% | 0.65 | 3.537 |
| Umbriel | 0.2103 | 0.21 | +0.2% | 0.000% | (procedural) | 0.950 |
| Venus | 0.1503 | 0.15 | +0.2% | 0.000% | 0.85 | 0.635 |

## 5. Bodies, sources, sizes

Levels per solar-system.md 5.2 (at most 6 albedo, 5 height). Sizes are the tile files (`du`) of the first bake; Mercury, Phobos and Enceladus updated after the review (`out/bake/planet/verify.json` has the current ones).

| Body | Height levels | Albedo levels | Height tiles / MB | Albedo tiles / MB | Albedo source (USGS unless noted) | Height source | Model |
|---|---|---|---|---|---|---|---|
| Mercury | 0-5 | 0-5 | 8,190 / 491.8 | 8,190 / 151.1 | MDIS low-incidence basemap (LOI) 166 m mono (read at 332 m, streamed), tint | MESSENGER DEM 665 m (sphere 2,439.4 km) | rocky |
| Venus | 0-4 | 0-4 | 2,046 / 158.2 | 2,046 / 15.3 | Magellan C3-MDIR 2,025 m radar, tint | Magellan topography 4,641 m (sphere 6,051.0 km) | rocky |
| Mars | 0-5 | 0-6 | 8,190 / 564.8 | 32,766 / 331.5 | Viking colour 925 m x MDIM 2.1 232 m detail (read at 464 m) | MGS MOLA 463 m on the IAU ellipsoid | rocky |
| Phobos | 0-3 | 0-3 | 510 / 10.8 | 510 / 4.5 | Viking 40 ppd (DLR), tint | HRSC global DEM 100 m (DLR, sphere 11.1 km) | rocky |
| Deimos | 0-2 | 0-2 | 126 / 1.6 | 126 / 0.1 | procedural | ellipsoid + procedural craters | rocky |
| Io | 0-3 | 0-5 | 510 / 3.7 | 8,190 / 21.0 | Galileo SSI / Voyager colour 1 km | ellipsoid | rocky |
| Europa | 0-3 | 0-5 | 510 / 2.4 | 8,190 / 50.1 | Voyager / Galileo 500 m mono, tint | ellipsoid | icy |
| Ganymede | 0-3 | 0-5 | 510 / 0.1 | 8,190 / 59.5 | Voyager / Galileo 1 km mono x colour 1,435 m | sphere | icy |
| Callisto | 0-3 | 0-5 | 510 / 0.1 | 8,190 / 49.6 | Voyager / Galileo 1 km mono, tint | sphere | icy |
| Mimas | 0-3 | 0-3 | 510 / 22.3 | 510 / 1.2 | procedural | ellipsoid + procedural craters + Herschel | icy |
| Enceladus | 0-3 | 0-4 | 510 / 25.8 | 2,046 / 33.4 | Cassini ISS 100 m (high-pass), tint | Bland et al. 2020 shape model, 2 ppd (sphere 251.5 km) | icy |
| Tethys | 0-3 | 0-4 | 510 / 3.7 | 2,046 / 20.1 | Cassini 293 m, tint | ellipsoid | icy |
| Dione | 0-3 | 0-4 | 510 / 2.4 | 2,046 / 24.7 | Cassini / Voyager 154 m, tint | ellipsoid | icy |
| Rhea | 0-3 | 0-4 | 510 / 2.3 | 2,046 / 13.9 | Cassini / Voyager 417 m, tint | ellipsoid | icy |
| Titan | 0-4 | 0-4 | 2,046 / 4.1 | 2,046 / 8.4 | Cassini ISS 938 nm 4 km, tint | ellipsoid | icy |
| Iapetus | 0-3 | 0-4 | 510 / 4.2 | 2,046 / 13.7 | Cassini / Voyager 783 m, tint, two-tone restored | ellipsoid 745.7 x 745.7 x 712.1 km | icy |
| Miranda | 0-3 | 0-3 | 510 / 23.0 | 510 / 1.0 | procedural | ellipsoid + procedural craters | icy |
| Ariel | 0-3 | 0-3 | 510 / 28.2 | 510 / 1.2 | procedural | ellipsoid + procedural craters | icy |
| Umbriel | 0-3 | 0-3 | 510 / 28.0 | 510 / 0.8 | procedural | sphere + procedural craters | icy |
| Titania | 0-3 | 0-3 | 510 / 29.9 | 510 / 0.9 | procedural | sphere + procedural craters | icy |
| Oberon | 0-3 | 0-3 | 510 / 29.5 | 510 / 0.9 | procedural | sphere + procedural craters | icy |
| Triton | 0-3 | 0-4 | 510 / 0.1 | 2,046 / 7.4 | Voyager 2 colour 600 m (filled), white-balanced | sphere | icy |
| Pluto | 0-5 | 0-5 | 8,190 / 285.9 | 8,190 / 40.6 | New Horizons 300 m mono, tint | New Horizons DEM 300 m (sphere 1,188.3 km) | icy |
| Charon | 0-4 | 0-4 | 2,046 / 56.1 | 2,046 / 8.7 | New Horizons 300 m mono, tint | New Horizons DEM 300 m (sphere 606.0 km) | icy |
| Ceres | 0-4 | 0-4 | 2,046 / 145.0 | 2,046 / 13.7 | Dawn FC 20 ppd (DLR) | Dawn HAMO DTM 60 ppd (sphere 470.0 km) | rocky |
| **25 bodies** | | | **41,550 / 1,915** | **106,062 / 834** | | | |

Plus `globals/albedo-lowres.png` per body (15.7 MB in all). Giants (`data/staged/render`, 8.3 MB, tracked):
Jupiter 4096 x 2048 WebP (NASA PIA07782), Saturn 4096 x 2048 WebP (Cassini ISS, PDS), Uranus and Neptune
1024 x 512 PNG (Hubble OPAL, CC BY 4.0), `saturn-rings` 2048 x 1 RGBA PNG (Cassini UVIS, PDS + NSSDC).
Licences: every USGS / NASA / PDS product public domain; OPAL CC BY 4.0 with its required acknowledgement in
the credit line. Nothing from Bjorn Jonsson (no-copy request) or Solar System Scope is used.

Timings (6 workers, other agents' jobs running): small bodies 3-60 s each, Ganymede 3.7 min, Mercury 1.2 +
3.6 min, Mars 4.3 min (height) + 17.6 min (albedo, level 6), Pluto 1.3 + 1.5 min; downloads at about 60 MB/s from the USGS bucket.
Disk peak of a pass about 5.3 GB in the first bake (Mercury's 4.25 GB download plus its 8-bit half-resolution copy); the 4.25 GB maps are now streamed, never stored, so a pass peaks at the decimated copy and its mips (about 1.8 GB for Mars' MDIM) plus the other sources of that pass.

## 6. Known limits (say plainly)

- **Placeholder-quality surfaces, by the expansion's allowance**: global levels only (albedo 2-6, height
  2-5); no regional pyramids, no de-shading (decision 8), shaded mosaics double-shade under the renderer's
  normals on DEM bodies.
- **Unobserved terrain is filled, not invented**: nodata pixels are filled by pull-push from the mip chain
  (smooth, uniform colour). Valid fraction of each source (pixels of the prepared grid, from the prepare
  logs of the review re-bakes): Pluto map 0.681 (DEM 0.46), Charon map 0.660 (DEM 0.46), Triton 0.614,
  Venus radar map 0.917 (with the 1-px fringe dropped) and DEM 0.917, Enceladus DEM 0.927, Europa 0.957,
  Callisto 0.962, Ceres map 0.964 (DEM 0.9999), Ganymede 0.965 (colour 0.964), Dione 0.998, Tethys 0.9996,
  Phobos map 0.9997 (DEM 1.0 before its 5 stitch columns are dropped), Io 0.9999, Titan 0.9998, Rhea, Iapetus
  and Enceladus' map 1.0; Mercury and Mars in the running log. Giants: Uranus south of -25 deg and Neptune
  north of +32 deg are zonal fills of the nearest clean latitude.
- **Colour**: mono maps carry a tint: from a published colour index for Europa, Callisto and Iapetus, an
  approximate one (config) for the others; Triton's Voyager colour is
  greenish as composited; Neptune's OPAL map is strongly cyan as composited (planet-render may regrade);
  Venus' surface is the Magellan RADAR backscatter as luminance (the visible surface is under the clouds).
- **Bright terrain is compressed, by design** (decision 20): every body's level-0 mean is its albedo, so on
  the bright moons most of the surface sits in the knee's shoulder, where brightness contrast is squeezed
  (detail reads, but weaker than in the source: Sputnik Planitia's cells are faint; bright rays on bright
  ground lose most of their contrast, so four landmark thresholds were lowered and Rhea's Inktomi test reads
  texture instead; Dione's leading/trailing brightness difference did not survive and its test was
  removed). Enceladus is calibrated to 0.77 and Tethys holds 0.788 of its 0.80: the highest means their
  shading-dominated mosaics can hold with at most 0.5 % at the 8-bit ceiling (`reach.py`); the far disc
  takes the geometric albedo, so a small brightness step remains at the hand-over for Enceladus. A local
  variant (shoulder on the large-scale tone, detail as a ratio on top) kept more bright-ground detail but
  held only about a third of the bright moons' albedo under the ceiling (Enceladus 0.27, Pluto 0.15), so
  the global knee was kept.
- **Mercury and Mars albedo** are read at 332 m and 464 m (decimated by 2, disk floor), so their finest
  level's texels near cube corners (206 m and 143 m) are upsampled; at face centres (468 m, 325 m) they are not.
- **Jupiter's** map longitude origin is as NASA published PIA07782 (System III not confirmed by the source);
  giant features drift relative to any rotation model anyway.
- **Mars' areoid** is replaced by the IAU ellipsoid (the brief's rule): heights relative to the true geoid
  are off by up to about 2 km at long wavelengths; Olympus Mons still reads its 21 km DEM part.
- **Procedural bodies** have no landmark (nothing to flip); Mimas has Herschel (a craterDepth landmark).
- **No Venus cloud-top map** (decision 2).
- **Mosaic boundaries inherited from the sources** (the providers' image-to-image brightness steps, not
  bake errors; no de-shading or re-balancing is attempted): Mars a diagonal dark band at about 112-135 E,
  18-38 N (Viking colour mosaic); Ganymede seams near 43 W and 56 E; Callisto near 90 E, and a bright smeared
  low-resolution patch near 60 S 0-20 E (no longer clipped: Callisto 0.47 % at the ceiling); Europa near 74 W;
  Rhea a brightness step along 180 E and a large smooth low-resolution patch at the north pole; Titan's
  938 nm map is a patchwork of observations; Saturn's map has a 13 DN step at 0 deg between 70 and 74 N
  (feathered, still visible).
- **Polar regions** where the sources are thin: Io's and Rhea's poles and the fills of Ceres (south),
  Europa and Callisto (both) are smooth zonal caps (decision 14), not observed detail; Enceladus' DEM is a
  smooth pull-push fill north of about 80 N, where the shape model has few points (valid 92.7 % overall).

## 7. For the next packages

**bodies-ephemeris / solar-system-sim (terrain sections, lazy residency).** Each terrain section must name
`tileset` = body id and carry exactly the resolved amplification of `data/tiles/<id>/manifest.json`
`body.amplification` (= `procedural.resolved_amplification`, request bodies-ephemeris-2, resolved);
`min/maxElevation` must contain `layers.height.elevation` (plus the amplification's amplitude: a few hundred
metres at most). Resident levels are `residentHeightLevel` = min(3, height levels): 510 height tiles per body
at level 3 (Deimos 126 at level 2). The tile sets load through today's `createTerrainProvider(defs, src,
{ bodies: [id] })` one body at a time (`tests/unit/planet-bake/tilesets.test.ts`, with a BodyDef built from
the config and the manifest); the lazy per-body residency of ARCHITECTURE 10.2 is solar-system-sim's.
`BodyDef.radius` must be the config's mean radius (the provider rejects a manifest radius that differs by
more than 1 m), and `BodyDef.shape` (spheroid) is NOT to be added to these heights: the height layer already
carries the reference surface (ellipsoid or the DEM's sphere) relative to the mean radius.

**planet-render.** Small pyramids (albedo 2-6, height 2-5 levels): the renderer's pools and LOD selection
must stop subdividing data at `globalMaxLevel` and let the amplification model carry detail below
(`rocky-generic` / `icy-generic`). `globals.albedoLowRes` (1024 x 512) for far impostors as on the Moon.
Mean colours for the far disc: take them from `albedoLowRes` (area-weighted). Giants: the maps under
`data/staged/render/` with their descriptors (conventions, credit, licence, filled fractions); Saturn's
ring strip `saturn-rings` (alpha = normal opacity, 74,658-136,780 km). Titan's tiles are the 938 nm
surface (the haze shell is yours); Venus' tiles are the radar surface under the clouds; no Venus cloud-top
map exists under an open licence (decision 2). Every source and licence line is in
`data/staged/credits.json` (the planet-render acceptance "every source of every new body appears in
data/defs/visuals/credits.json" holds once bodies-activation merges it).

**bodies-activation.** Merge `data/staged/credits.json` (format in section 1) into
`data/defs/visuals/credits.json`; register `data/staged/render/<id>.maps.json` with the giants' render
sections; cross-check the radii of `tools/bake/planet/bodies/<id>.json` (`radii.mean/a/b/c`, metres)
against the activated body files (`tools/bake/planet/verify.py` does it against
`data/staged/bodies/radii.json` when that exists). The tile sets live under `data/tiles/<id>/` (git-ignored,
reproducible with the commands of section 2); the packer (platform-delivery) picks them up like earth/moon.

## 8. Requests, contract changes, open items

- **No contract change requested.** The manifest gains additive fields only (`layers.height.elevation`,
  `layers.*.build`, `layers.albedo.calibration`, `body`), which `validateTileManifest` and
  `common/layout.validate_manifest` accept (the Moon's manifest already carries `build` and `colour`).
- **Request bodies-ephemeris-2** (against my paths): resolved (0144348), see section 7.
- **Request bodies-ephemeris-5** (against my paths, via the coordinator): resolved: mean colours file,
  literature colour indices, complex-crater depths, new elevation bounds in the manifests (decisions 10-11).
- **bodies-ephemeris-3** (theirs, to the lead): the resident level stays a property of the baked manifest
  here: every manifest has `residentHeightLevel` = min(3, height levels); their staged sections carry a
  `residentLevel` of 3 that agrees with it.
- **For the lead (disk):** the floor of 25 GB was reached during this package's bakes mainly because
  `data/packs` grew to 14 GB and the site-bake caches grew at the same time; a package cannot see another's
  planned peak. The gate's free-space check is for memory; a disk reservation in the gate would make the
  floor enforceable across packages.
- **Request planet-bake-1** (to bodies-ephemeris, open): regenerate the staged body files from the new
  manifests (Phobos and Enceladus elevation ranges; verify's cross-check of the staged sections fails for
  those two until then), mean colours and credits.
- **Licence of the Phobos DEM: accepted by the lead.** A provider statement of no access or use
  constraints, credited, is a third licence class beside public domain and CC BY (DLR/ESA's HRSC product,
  distributed by USGS/PDS; its metadata: "Access_Constraints None, Use_Constraints None"). credits.json and
  the staged credits' note say so; the tool's licence checks accept exactly these three classes.
- **Venus cloud tops** (decision 2) and **Uranian moons' Voyager images** (partial coverage; the design
  chose procedural) are left as they are by design.

## 9. How the tool is built (for the next maintainer)

`tools/bake/planet/`: `config.py` (strict schema; unknown keys are errors), `fetch.py` (resumable range
download from moon/fetch.py, provider MD5 sidecar, sha256 in the config), `source.py` (GeoTIFF georeference
from the file and checked against the config; exact grids memory-mapped, others copied or regridded onto a
canonical 2:1 grid; the config's nodata must equal the file's; nodata pull-push fill; float16 mips for 8-bit
data; streamed decimation; `nodataDilatePx`, `edgeColumnsInvalid`, `wrapFeatherDeg`, `polarSmooth`), `heights.py`
(finest level from the reference surface + area-filtered DEM or procedural relief; full-weighting pyramid
from earth/hpyramid.py), `albedo.py` (finest level area-filtered, calibration gain with the clip cap,
`colourMode` chroma or detail, `lowFrequency` percentile mapping; 2 x 2 linear box pyramid computed
depth-first per level-2 subtree), `procedural.py` + `procedural.ts` (the crater population of the body's
generic model, complementary weights), `giants.py` (equirect re-orientation, point/cell registration,
planetographic latitude, zonal fill; ring strip from an occultation table), `bake.py` (driver, step
fingerprints chained through the steps and the prepared sources, `--split-passes`, `--clean-after`,
`--accept-height`, `--credits`), `verify.py` (also the mirror/shift landmark self-test, meridian seams in
albedo and height, the level-0 mean against the albedo, the ceiling share, giant seams), `sheets.py`,
`views.py` (close views of the +-180 and 0 meridians and the poles), `looks.py` (true-albedo looks),
`reach.py` (the highest mean a map can hold under the ceiling rule). The albedo calibration (gain, knee) is
computed once per bake by the parent process (`albedo.calibration`, written to
`work/albedo-calibration.json` for the tile workers).
Adding a body: a config (sources with url/bytes/md5, conventions, levels, landmarks with Gazetteer refs),
`--record-checksums` on the first run, then `verify.py <id>` and `sheets.py <id>`, and LOOK at the sheet.
