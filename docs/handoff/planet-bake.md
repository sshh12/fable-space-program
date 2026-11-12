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
  (`scratchpad preview_both.py`, both readings with Gazetteer landmarks): in the east-increasing reading Pele's
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

## 1. What consumers get

### Tile sets `data/tiles/<id>/` (served at `/tiles/<id>/`), one per solid body

Standard layout and `TileManifest` (`src/core/contracts/terrain.ts`), written through
`tools/bake/common/layout.write_manifest` (validated, `contentHash`):

| | |
|---|---|
| Frame | the body-fixed frame of the IAU rotation model (pck00011): +Z north pole, +X prime meridian, east longitude, planetocentric latitude. Every source is re-registered to it (west-positive maps mirrored, planetographic latitudes converted, point/cell registration honoured) and the landmark tests prove it |
| `radius` | the body's MEAN radius (= `BodyDef.radius`, the datum sphere) |
| `height` | `frt1-height`, global levels `0..maxLevel` (no sparse levels), `heightScales` 0.5 m. Height = reference surface - mean radius + DEM: the reference is the triaxial ellipsoid of the config's radii, or for a DEM given against a sphere that sphere (Mercury 2,439.4 km, Venus 6,051.0, Ceres 470.0, Pluto 1,188.3, Charon 606.0); Mars' MOLA heights are on the areoid and are added to the IAU ellipsoid (the brief's rule; the areoid's +-2 km undulation is not modelled). So physics and rendering see the body's shape (Phobos' 13 x 11.4 x 9.1 km, Iapetus' 20 km flattening, Mars' 20 km) as an ordinary heightfield. Additive field `elevation: {min, max}` (finest level, m above `radius`) and `build` (content hash) |
| `albedo` | `webp` 256 x 256 opaque RGB, global levels `0..maxLevel`; sRGB base colour, calibrated so the area-weighted mean luminance (linear) equals the configured albedo (NSSDC geometric albedo, solar-system.md 2.5; Iapetus on its bright hemisphere). Additive `calibration` and `build` |
| `globals.albedoLowRes` | `globals/albedo-lowres.png`, 1024 x 512 equirect (row 0 north, column 0 at 180 W), as the Moon's |
| `residentHeightLevel` | min(3, height maxLevel) |
| `body` (additive) | `name`, `radii {mean, a, b, c}`, `reference`, the resolved `amplification` definition (model, seed, params) the run-time model must use, `bakeConfig` |

### Giants `data/staged/render/`

`<id>.maps.json` per giant (descriptor: path, size, channels, format, conventions, credit, licence) and
the maps under `<id>/`: `cloudTop` (equirect, row 0 north, column 0 at -180, east-positive body-fixed
longitude, planetocentric latitude) for Jupiter, Saturn, Uranus and Neptune; `saturn-rings` (radial RGBA
strip, 74,658-136,780 km, alpha = normal opacity 1 - exp(-tau)).

### Credits `data/staged/credits.json`

`{ formatVersion: 1, generatedBy, note, entries: [{ id, title, author, url, licence, licenceUrl,
attribution, bodies: [names] }] }`, one entry per source of every config (the source list is
`tools/bake/planet/credits.json`). `attribution` is the line for the Credits screen. Every licence is public
domain (NASA/USGS/PDS) or CC BY 4.0 (Hubble OPAL); no map whose author forbids redistribution is used.

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
data\cache\earth\venv\Scripts\python.exe -I tools/bake/planet/bake.py <id> --clean       # delete downloads + intermediates
npx vitest run tests/unit/planet-bake src/terrain/amplification tests/unit/terrain-core/terrain-guard.test.ts
```

Steps of a solid body: `fetch` (resumable range download into `data/cache/planets/<id>/dl/<source>/`,
provider MD5 and the config's sha256 checked; `--record-checksums` fills them on a first download),
`prepare` (windowed reads into a memory-mapped mip chain: the TIFF itself when it is an uncompressed strip
file, else a float32 copy, regridded onto an exact 2:1 global grid when the file is not one, nodata filled by
pull-push), `procedural` (map-less bodies: `procedural.ts` through `npx tsx`, up to 6 parts),
`height`, `albedo`, `manifest`. Each step records a fingerprint (config + code version) in
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
   Pluto 1,188.3 km, Charon 606.0 km). Adding the ellipsoid to a sphere-referenced DEM would count the
   body's flattening twice (Ceres: 41 km).
4. **Procedural bodies** (Deimos, Mimas, Miranda, Ariel, Umbriel, Titania, Oberon): the crater population of
   their amplification model, at the diameters the run-time model does not draw (above 4 postings of the
   global max level, up to 0.4 R), is baked into BOTH the height (as the bodies' DEM) and the albedo (fresh
   craters brighter); the run-time model draws the rest with complementary weights, so each crater exists
   once (`generic.test.ts`). Mimas also gets Herschel (139 km) at its Gazetteer position (solar-system.md
   5.3 asks for it). Without baked relief these bodies would be smooth ellipsoids with painted craters.
5. **Mars albedo** = MDIM 2.1 mono 232 m (luminance) x Viking colour 925 m (chroma), the design's own
   "finer" source, so level 6 (325 m texels) carries real detail; the 925 m colour alone would be a 3x
   upsample there.
6. **Resampling.** Finest height level: the DEM area-filtered over each vertex's local spacing (mips +
   Catmull-Rom + longitude taps), as the Moon's global levels; coarser levels: the existing full-weighting
   pyramid. Albedo: the finest level area-filtered from the source, coarser levels 2 x 2 means in linear
   light (no re-sampling of the source, no re-decoding of lossy tiles).
7. **Albedo calibration.** Every 8-bit mosaic is read as a display (sRGB) image; one gain per body sets the
   area-weighted mean luminance to the NSSDC geometric albedo (as the Moon: mean 0.13 against 0.12);
   Enceladus capped at 0.9 (geometric albedo 1.0) so its detail survives 8-bit sRGB; Iapetus calibrated on
   its bright hemisphere (0.5). Mono maps take an approximate tint per body (in the config).
8. **No de-shading.** Most mosaics carry their imaging geometry's shading (Viking, MDIS, Galileo, Cassini;
   the Enceladus map is high-pass filtered, i.e. mostly shading). The Moon's albedo was de-shaded; here the
   placeholder-quality allowance of the expansion applies. On DEM bodies the renderer's normal-map shading
   adds to the baked shading at low sun.
9. **West-labelled USGS mosaics are east-increasing in layout** (running log 01:45): the config key
   `lonPositive` describes the pixel layout, and every USGS file used is east-increasing.
10. **Landmark kinds**: `demHeight`, `albedoContrast`, `albedoCompare`, `craterDepth` and `albedoTexture`
    (luminance standard deviation, for craters in shaded mosaics where the mean says nothing).
