# bodies-ephemeris: hand-off

Wave 3.1, MIGRATION_V2 step 3.7. Thirty-two body definitions generated from source tables and validated
against JPL Horizons, staged under `data/staged/`. This package wrote nothing under `data/defs`.

**Status in one paragraph.** All 32 staged files exist, load through the loader laid over `data/defs`, and
compile against the v2 contract in a typed fixture. Earth reproduces the v1 Sun direction exactly, and the Moon
file is byte-identical. The Horizons validation does NOT pass: 16 of the 29 gated bodies are outside the
brief's tolerances. The reasons are the design's sources, not the code:
- Table 1's stated errors are typical values, not bounds.
- The satellite table's periods have too few digits for Phobos and Deimos.
- Mimas and Tethys are in a resonance whose libration no uniformly precessing ellipse follows.
- Triton's table period does not give its mean motion.
- Ceres' osculating elements drift under Jupiter's pull.

Per the instructions I did not improvise. The files follow the brief exactly, and the decision is with the lead
in the blocking request `docs/requests/bodies-ephemeris-4.md` (measured table and options).

## 1. What there is

| Path | What |
|---|---|
| `data/staged/bodies/<id>.json` | One `BodyDef` per body of ARCHITECTURE 8.1 (32 files) |
| `data/staged/terrain/<id>.terrain.json` | The terrain section (`BodyTerrainDef`) of each of the 25 new solid bodies, referenced from the body as `{ "$ref": "../terrain/<id>.terrain.json" }` (relative to the root the file lives in: the same path works under `data/staged` and, after activation, `data/defs`) |
| `data/staged/bodies/radii.json` | `{ description, bodies: [{ id, meanRadius, equatorialRadius, polarRadius, radiiAbc }] }`, metres; mean = `BodyDef.radius`, the others pck00011 a, c and (a, b, c) |
| `tools/bodies/provenance.json` | Every generated value with its source (URL, time of retrieval) and derivation; `paths` = the path and table reading of every orbit |
| `tools/bodies/validation-report.json` | The Horizons validation: worst deviation per body, every epoch, the Horizons URL and time |
| `tools/bodies/sources/*.json` | The source tables as extracted from the downloads, each with URL, time of retrieval and sha256 of the document |
| `tests/unit/bodies/stagedBodies.generated.ts` | The staged files as typed literals (`satisfies` the contract) |

Commands (Node, no dependencies; `pdftext.py` needs `pypdf`, present on this machine):

```
node tools/bodies/fetch-sources.mjs [--refresh]  downloads into data/cache/bodies/<id>/ (one directory per source) and extracts tools/bodies/sources/*.json
node tools/bodies/generate.mjs [--check]         writes (or checks byte for byte) all 60 generated files; never goes to the network
node tools/bodies/validate.mjs [--quiet]         Horizons at ten epochs 2030-2060 (cached); writes the report; exit 1 on a gated failure
npx vitest run tests/unit/bodies                 86 tests
```

Modules (`tools/bodies/lib/`), for the next owner of `tools/bodies` (solar-system-sim, wave 4):

| Module | Contents |
|---|---|
| `catalogue.mjs` | The 32 bodies: ids, NAIF / Horizons ids, parents, kind, surface class |
| `build.mjs` | `buildLibrary(sources, live, bake)` → `{ bodies, terrain, radii, provenance, paths }` |
| `orbits.mjs` | The orbit paths, the satellite-table readings, `LOBBY_EPOCH_UT = 938240818` |
| `kepler.mjs` | The contract's orbit semantics (`keplerState`, `orbitState`, `sunLowPrecisionState`), typed by `kepler.d.mts` |
| `pck.mjs` | The IAU rotation models |
| `atmospheres.mjs`, `profiles.mjs`, `nist.mjs` | The atmospheres |
| `derivedSources.mjs` | Readers for the PDF, profile, colour and DEM sources |
| `colour.mjs` | Mean colour from colour indices |
| `fit.mjs` | Least squares |
| `horizons.mjs`, `http.mjs` | The Horizons client and the cached downloads |

## 2. Semantics the runtime must implement (solar-system-sim)

The validation evaluates the staged files with `lib/kepler.mjs`. `tests/unit/bodies/ephemeris.test.ts`
proves it equals the v1 runtime (`KeplerEphemeris`, `poleQuat`, `sunLowPrecisionState`) where v1 has the
feature. The v2 additions mean:

- **Rates.** `KeplerOrbitDef.rates` are per Julian century, applied linearly from `epochUt`:
  `element(ut) = element0 + rate (ut - epochUt) / 3,155,760,000 s`.
- **Mean motion.** `meanMotionDegPerDay` is the mean-anomaly rate: `M(ut) = M0 + n (ut - epochUt)`.
  It is present on every new body and absent only on the Moon.
- **Velocity.** It is the ellipse's own (from n). The precession terms are left out, an error of at most
  (|rate of argPe| + |rate of node|) / n, which is under 1 % by construction (`MAX_PRECESSION_FRACTION`).
- **Frames.** `'ecliptic'` = Rx(+23.4392911 deg). `'parentEquator'` = the parent's `rotation` pole.
  `{ pole: { raDeg, decDeg } }` = Rz(ra + 90) Rx(90 - dec), the same as `poleQuat`: +X is the ascending node
  of the plane on the ICRF equator, which is where the JPL satellite tables measure their nodes from.
  Uranus' moons use `{ pole }` with the POSITIVE pole (77.311, 15.175), not the parent's IAU pole.
  Triton and Charon use `'parentEquator'`.
- **Time scale.** `ut` is taken as TDB seconds since J2000 for every ephemeris (the sources' scale). This
  matters only for Phobos: 69 s of TT-UTC is 0.9 deg of its orbit.
- **Epochs.** Planets 0. Satellites on the table path 0 (the table's 2000-01-01.5). The Saturnian fit path
  and every rotation use the lobby epoch 938240818 (2029-09-24T18:26:58, ARCHITECTURE 5.2). Ceres and Pluto
  use their SBDB epochs (JD 2461200.5 and 2457588.5).
- **Rotation.** `fixedRate` on every body but Earth and the Moon, which keep v1: Earth `fixedRate` (GMST),
  the Moon `tidalLock`. It is pck00011 evaluated at the lobby epoch, with its linear, quadratic and
  nutation-precession terms. Retrograde rotators have negative rates (Venus, Uranus, the Uranian moons,
  Triton).
- **`soiRadius`.**
  - `'auto'` on every body but three, under the v2 rule min(Hill, max(a (m/M)^0.4, 2.5 R)): Phobos 16.6 km,
    Deimos 15.5 km, Mimas 495 km.
  - The Sun has `null`.
  - The Moon keeps v1's 66,100 km.
  - Earth has a number, 924,776 km: the same rule with a = 1.00014 au, the mean distance of the Almanac
    formula. `'auto'` needs a Kepler orbit and Earth's is `sunLowPrecision`.
- **`warpAltitudeLimits`.**
  - Absent on the 30 new bodies (ARCHITECTURE 8.3: defaults from the radius and the atmosphere top).
  - Earth and the Moon keep v1's seven entries, copied from the live files.
  - When the warp table grows to nine levels, the live and staged Earth and Moon need two more entries, or
    none. Regenerate after changing the live files.
- **`shape`.** Present on the oblate bodies, where pck00011 has a = b > c: Mercury, Mars, Jupiter, Saturn,
  Uranus, Neptune, Iapetus, Ceres. It is the reference spheroid for altitude. planet-bake's heights are
  relative to the mean-radius datum and already contain the ellipsoid, so terrain is `radius + height`.
  Do not add the spheroid again. The triaxial moons have no `shape`: their ellipsoid is baked into the
  heights.
- **Giants.** `surface: 'none'`, with `atmosphere.floorAltitude` at the 10-bar level of the exponential
  model, -H ln 10: Jupiter -62.2 km, Saturn -137.0 km, Uranus -63.8 km, Neptune -45.4 km.
- **The Sun.** Root attractor, `parent: null`, v1's emission block, no `surface` field (the photosphere is
  the datum radius 695,700 km), mu from DE440.

## 3. Acceptance, measured

| Criterion | Result |
|---|---|
| A staged file for EVERY name of the list (the test iterates the list) | **Met.** `staged.test.ts` iterates the brief's 32 names; every file exists and its id and name match |
| Compiles against BodyDef in a typed fixture | **Met, with two widenings** (below). `npm run typecheck:paths -- tests/unit/bodies tools/bodies` passes; each JSON file equals its fixture entry |
| Passes the Horizons validation | **NOT met: 13 of 29 gated bodies pass**; Earth and the Moon are reported, not gated (table below; request bodies-ephemeris-4) |
| Report lists the worst deviation per body and the path of each Saturnian moon | Met: `tools/bodies/validation-report.json`, `tools/bodies/provenance.json` `paths`, and below |
| Earth reproduces the v1 Sun direction at 1,000 instants over 2029-2031 | **Met**: largest angle < 1e-15 rad, distances identical (`ephemeris.test.ts`) |
| The Moon's orbit block byte-identical to today's | **Met**: the whole staged `moon.json` is byte-identical to `data/defs/bodies/moon.json` |
| No file under `data/defs` changed | **Met for this package.** The tools write only `data/staged/{bodies,terrain}`, `tools/bodies`, `tests/unit/bodies`. `git status data/defs` shows only other packages' edits (render, scenarios, audio) |
| The staged library loads through the loader | **Met** in `staged.test.ts` with the overlay semantics laid over data/defs (`radii.json` held out: request bodies-ephemeris-1) |
| Self-verify | `generate.mjs --check`: 60 files up to date. `validate.mjs`: exit 1 (the 16 bodies). vitest `tests/unit/bodies`: 86/86. Boundaries 93/93. `check-stubs`: OK |

The two widenings of the typed fixture (`StagedBodyFile` in the generated file):

- `warpAltitudeLimits` is optional, as ARCHITECTURE 8.3 and the contract's own comment specify; the lead makes
  it optional together with the nine warp levels.
- The positions that are `$ref`s in the files (terrain, an amplification, the render sections) may be
  `{ $ref }`.

The terrain section files are checked as plain `BodyTerrainDef`.

### Validation (ten epochs 2030-01-01 to 2060-01-01 TDB, ICRF, body centres, signed model minus Horizons)

Tolerances:
- Planets: Table 1's stated accuracy for 1800-2050 (Mercury 15" / 1" / 1,000 km ... Neptune 10" / 1" /
  200,000 km).
- Satellites: 1 deg and 2 % of the radius.
- Ceres and Pluto: the satellites' tolerance. The brief states none for osculating elements; this is my choice.

| Body | Path (reading) | Worst | Verdict |
|---|---|---|---|
| Mercury | Table 1 | lat -1.6", lon -13.9", dist 1,185 km | FAIL x1.60 |
| Venus | Table 1 | dist 4,492 km, lon -19.4" | FAIL x1.12 |
| Earth | v1 formula inverted | 0.84 deg in ICRF (lon 3,013"); of date -27.6" | reported (pinned) |
| Mars | Table 1 | lon 58.7" | FAIL x1.47 |
| Jupiter | Table 1 | lon 466.7", dist 549,467 km | FAIL x1.17 |
| Saturn | Table 1 | lon -890", lat -25.2", dist 1.71e6 km | FAIL x1.48 |
| Uranus | Table 1 | lon -197", lat 3.1" | FAIL x3.95 |
| Neptune | Table 1 | dist 1.37e6 km, lon -49.8" | FAIL x6.86 |
| Moon | frozen v1 ellipse | 162 deg | reported (pinned) |
| Phobos | table (anomalistic P, apsis +, node -) | 166 deg | FAIL |
| Deimos | table (anomalistic, +, +) | 91 deg | FAIL |
| Io | table (anomalistic, apsis -, node -) | 1.68 deg | FAIL x1.68 |
| Europa | table (anomalistic, -, -) | 3.57 deg | FAIL x3.57 |
| Ganymede | table (anomalistic, +, -) | 0.245 deg, radial 0.19 % | pass |
| Callisto | table (anomalistic, +, -) | 0.155 deg | pass |
| Mimas | **fit** (sidereal, -, -) | 80 deg | FAIL |
| Enceladus | **fit** (sidereal, +, -) | 0.459 deg | pass |
| Tethys | **fit** (sidereal, +, -; apsis held, see 5) | 4.70 deg | FAIL x4.70 |
| Dione | **fit** (sidereal, +, -) | 0.213 deg | pass |
| Rhea | **fit** (sidereal, +, -) | 0.100 deg | pass |
| Titan | **fit** (sidereal, +, -) | 0.052 deg | pass |
| Iapetus | **fit** (sidereal, +, -) | 0.251 deg | pass |
| Miranda | table (sidereal, +, -) | 2.72 deg | FAIL x2.72 |
| Ariel | table (sidereal, +, -) | 0.184 deg | pass |
| Umbriel | table (sidereal, +, -) | 0.110 deg | pass |
| Titania | table (sidereal, +, +) | 0.299 deg | pass |
| Oberon | table (sidereal, +, -) | 0.219 deg | pass |
| Triton | table (sidereal, -, -) | 161 deg | FAIL |
| Ceres | SBDB osculating | 3.94 deg | FAIL x3.94 |
| Pluto | SBDB osculating | 0.199 deg, radial 0.25 % | pass |
| Charon | table (anomalistic) | 0.085 deg | pass |

**Saturnian moons: all seven took the fit path.** On the table path the mean-element convention misses by
6 deg (Enceladus) to 152 deg (Rhea) over the calibration window. The fit path fits inclination, node,
periapsis and mean anomaly at the lobby epoch to 143-145 Horizons states over +-3 periods. It keeps the
table's a, e, P and precession periods. Fit rms ranges from 164 km (Rhea) to 3,285 km (Iapetus).

Causes of the failures:
- **Planets:** Table 1's errors are "nominal" (typical) and exceeded inside 2030-2050 already. Neptune is
  0.8e6 km off in 2040.
- **Phobos and Deimos:** the table's P has 4 and 5 digits.
- **Io, Europa, Miranda:** a drift against the table's P.
- **Mimas:** the Mimas-Tethys resonance makes its longitude librate by about 44 deg over 71 years.
- **Tethys:** the same resonance, smaller.
- **Triton:** the table's P (5.8792 d) is not Triton's mean motion (5.8769 d sidereal), and it is 4.6 deg off
  at J2000 already.
- **Ceres:** two-body propagation of 2026 osculating elements.
- **Earth:** pinned. The Almanac formula is referred to the mean equinox OF DATE, so in ICRF it differs from
  Horizons by the precession since J2000. Of date it is within 28", inside the formula's own 0.01 deg.

**Exploration, outside the tool.** I applied the fit path to the failing moons, with the mean motion also
fitted over 2029.7-2060. That gives Io 0.05 deg, Europa 0.12, Tethys 0.47, Miranda 1.5, Deimos 1.9 and
Triton 7.9. Mimas gets 12 (the libration). Phobos needs a better starting mean motion than the table's.
These numbers are in request -4 as options.

## 4. Data notes (sources and derivations; every value with URL and date in `provenance.json`)

### Mass and size

- **GM.**
  - Planets and Pluto: DE440 system GM (JPL astro_par) minus every satellite with a GM in the JPL satellite
    table, as the brief prescribes. This agrees with the satellite ephemerides' planet-only GMs to 2e-8
    (Jupiter 126,686,534 against 126,686,531.9 km^3/s^2).
  - Mercury and Venus: DE440. Sun: DE440, 1.32712440041279e20 (v1's lightOnly Sun had 1.32712440018e20).
  - Moons: the JPL satellite GMs. Ceres: SBDB (Park et al. 2016).
  - Earth and the Moon: v1 unchanged.
- **Radius.** The JPL mean radius (planet and satellite physical parameters). Sun: IAU 2015 nominal.
- **Shape and `radiiAbc`.** pck00011.

### Albedo and colour

- **Geometric albedo.** JPL planet physical parameters for planets and dwarf planets (Mercury 0.106,
  Pluto 0.3). Horizons object data for the satellites. NASA NSSDC where JPL lists none (Charon 0.42).
  planet-bake calibrates its maps to NSSDC albedos (e.g. Io 0.62 against JPL's 0.63): a small difference,
  noted.
- **Mean colour.**
  - Method: from B-V (and V-Rc where published) relative to the Sun's (Ramirez et al. 2012: 0.653,
    0.352). The luminance is scaled to the geometric albedo (`lib/colour.mjs`).
  - Sources:
    - Planets: Mallama et al. 2017, Table 3.
    - Enceladus, Tethys, Dione, Rhea, Titania, Oberon: PDS SBN satellite colours.
    - Phobos, Deimos, Triton, Titan: Burns 1977, *Planetary Satellites*.
    - Pluto and Charon: Buie et al. 2006.
    - Ceres: SBDB.
  - Where only B-V is known, the red channel continues the B-V slope (stated assumption).
  - **Io, Europa, Ganymede, Callisto, Mimas, Iapetus, Miranda, Ariel and Umbriel are neutral (grey at their
    albedo)**: no fetchable Johnson B-V was found. planet-render refines colours from the maps in wave 5.

### Atmospheres

- **Mars and the giants: exponential models**, from the NSSDC fact sheets.
  - Mars uses surface values: 0.016 kg/m^3, 636 Pa, H 11 km, 214 K.
  - The giants use 1-bar values. Neptune takes the midpoint of the ranges given for its scale height
    (19.1-20.3 km) and mean molecular weight.
- **Venus: table**, 0-200 km. Values are the Venus-GRAM / VIRA average distributed with AMAT
  (Girija et al. 2021). Cross-checked against the VIRA densities of Justus & Braun 2007 (NASA NTRS
  20070032693, Table 3.1.1): within 0.5 % from 0 to 100 km. Above 100 km VIRA depends on local time and the
  two differ by up to 64 %.
- **Titan: table**, 0-1,300 km. Values are the Huygens HASI level-4 descent and entry profiles (PDS
  hphasi_0001). The entry file has no density, so it is p M / (R T) with M = 28.557 g/mol from the descent
  file's own top 10 km.
- **Gamma.** Justus & Braun where they state one: Venus 1.286, Mars 1.33, Titan 1.40, Saturn 1.45. Elsewhere
  the NIST WebBook ideal mixture of normal hydrogen, helium and methane at the 1-bar temperature: Jupiter
  1.484, Uranus 1.633, Neptune 1.644. In this mixture the cold normal hydrogen's rotation is partly frozen,
  hence the high values.
- **Gas constant** = 8.314462618 / mean molecular weight.
- **simTop** = the altitude where the model density falls to Earth's density at its v1 simTop (USSA-76 at
  140 km, 3.831e-9 kg/m^3, pinned to the runtime model by a test): Mars 168 km, Venus 134 km, Titan 909 km,
  Jupiter 474 km, Saturn 1,054 km.
- **Heating.**
  - `kConv` = Earth's v1 1.7415e-4 x K(mixture) / K(air). K comes from Sutton & Graves 1971 (TR R-376)
    Table II, mixed by their eq. 44 using mass fractions. Mars gives 1.8962e-4, against the published
    1.9027e-4.
  - **`radiative: null` on every non-air gas.** No public CO2, N2-CH4 or H2-He radiative correlation with its
    velocity table was found. The Tauber-Sutton Mars constants are public but its f(V) table is not.
    Hypervelocity giant entries are therefore under-heated (the convective term still scales with V^3).
- **No atmosphere on the other bodies.** Triton and Pluto (microbar) have none, per the research.

### Rings and controls

- **Saturn's ring.**
  - Radii: one ring from the C-ring inner edge (74,658 km) to the A-ring outer edge (136,780 km), NSSDC.
  - Texture: `saturn-rings`, `opticalDepthScale` 1. planet-bake confirmed (request -2) that its strip spans
    exactly these radii, with alpha = 1 - exp(-tau).
- **navballSwitchAltitude**, scaled from the v1 precedents:
  - with an atmosphere: simTop x 60/140 (Earth);
  - airless: radius x 20/1737.4 (the Moon).

### Terrain sections

- **Amplification:** planet-bake's, resolved exactly as its bake does. That is its model, seed (4101-4125)
  and overrides (`tools/bake/planet/bodies/<id>.json`) over `data/defs/terrain/<model>.amplification.json`.
  The generator reads both and never writes them. Models: `rocky-generic` for Mercury, Venus, Mars, Phobos,
  Deimos, Io and Ceres; `icy-generic` for the other eighteen.
- **`maxRenderLevel`** = round(log2(R pi/2 / 10 m)), which reproduces the Earth (20) and Moon (18)
  precedents.
- **`surfaceFriction`** 0.7, the Moon's value.
- **`min/maxElevation`** enclose the following, added together:
  - the bake's reference surface relative to the mean radius;
  - the DEM range:
    - Mars: -8,201 to 21,241 m, from the GDAL statistics of the USGS product.
    - Venus: -2,951 to 11,687 m, from the USGS product page.
    - Mercury, Ceres, Pluto, Charon: no published range, so the int16 storage range (+-32,767 DN). The
      TIFF headers were read and these bounds are loose;
  - the bake's procedural craters;
  - the run-time crater classes.

  Tighten the loose bounds from the baked manifests (`layers.height.elevation`, which planet-bake records)
  once they exist.

## 5. Deviations from the brief, and limits

1. **The Horizons validation fails for 16 bodies.** See 3; request -4 (blocking) holds the options.
2. **The satellite table does not state** whether P is the period of the mean anomaly or of the mean
   longitude, nor the sense of the two precessions. The generator chooses, per moon, the reading that best
   reproduces Horizons over a calibration window (ten epochs 2010-2029, before and independent of the
   validation window). Jovian, Martian and Plutonian rows read as anomalistic periods; Saturnian, Uranian
   and Neptunian rows as sidereal. Recorded per moon in `provenance.json`.
3. **Tethys' listed apsidal period is 0.005 yr** (for e = 0.001), too fast for a slowly precessing ellipse. The
   periapsis is held fixed, which moves the position by at most e a = 295 km. Recorded as `apsisDropped`.
4. **Earth's `soiRadius` is a number**, not `'auto'` (see 2).
5. **`warpAltitudeLimits` is absent** on new bodies (see 2).
6. **No resident level in the terrain sections.** `BodyTerrainDef` has no such field; it stays the
   manifest's `residentHeightLevel` (planet-bake writes 3, Deimos 2). Request -3 to the lead.
7. **`radii.json` lies under `data/staged/bodies/`** as the brief says, but the loader takes every undotted
   file there for a definition. Request -1 to sim-core-v2.
8. **The Sun now has a `fixedRate` rotation** (pck00011) and the DE440 GM. v1 had `'none'` and an older GM,
   both unused by v1 dynamics.
9. **Nine bodies have neutral mean colours. Radiative heating is not modelled** for non-air gases (see 4).
10. **Staleness.** The generator also reads `data/defs/bodies/{earth,moon,sun}.json`, planet-bake's configs
    and parameter files. A change there makes `generate --check` report stale files: re-run
    `node tools/bodies/generate.mjs`.

## 6. For the next packages

- **solar-system-sim (4.1c):**
  - Implement section 2 exactly. The generator's evaluator (`lib/kepler.mjs`) is the reference;
    `tests/unit/bodies/ephemeris.test.ts` shows how to compare.
  - Your check "bodies stay within their Horizons tolerance through the runtime ephemeris" will reproduce
    `validation-report.json`, not a pass, until the lead decides request -4.
  - You own `tools/bodies` from wave 4: a decision on -4 is a few lines in `lib/orbits.mjs` and `build.mjs`.
    A planet fit would add a path beside `approx-pos`. For the moons, extend the `sat-fit` path and let it
    also fit `meanMotionDegPerDay` (see `fitPlanePhase`).
  - Phobos, Deimos and Mimas need the v2 SOI rule. Under v1's they throw.
- **planet-bake:**
  - Radii equal `radii.json`.
  - The terrain sections carry your resolved amplification. Announce seed or override changes; your
    `verify.py` already compares them.
  - Tighten the loose elevation bounds through your manifests' `elevation`.
- **bodies-activation (4.4):**
  - Move `data/staged/bodies/*.json` (not `radii.json`, unless request -1 says otherwise) and
    `data/staged/terrain/*.terrain.json` with the same relative layout. The `$ref`s then resolve inside
    `data/defs`.
  - Earth and the Moon reference `../terrain/{earth,moon}.amplification.json` and `../render/*`, which
    already exist in `data/defs`.
  - Re-run `generate.mjs --check` first.

## 7. Requests

| Request | To | Status |
|---|---|---|
| bodies-ephemeris-1 | sim-core-v2 (`src/core/defs`) | open, non-blocking: `radii.json` vs the loader's definition rule |
| bodies-ephemeris-2 | planet-bake | resolved: amplification resolved as in its bake; ring strip `saturn-rings` matches the staged radii |
| bodies-ephemeris-3 | lead (`BodyTerrainDef`) | open, non-blocking: resident level in the terrain section |
| bodies-ephemeris-4 | lead (ARCHITECTURE 8.2 / brief) | **open, BLOCKING**: tolerances not met with the design's sources; options per group |

No request against this package's paths was found in `docs/requests/`.

## Running log

- 2026-11-12 00:30 start. Read STATUS, the brief, ARCHITECTURE 8 and 10, MIGRATION_V2, PACKAGE_RULES,
  user-decisions, solar-system.md, defs.ts, the lead-baseline-v2 hand-off, `src/sim/bodies`, the loader.
- 00:50 sources downloaded and extracted (`tools/bodies/fetch-sources.mjs`).
- 01:10 first Horizons measurements: the brief's tolerances are not met by the design's sources for many
  bodies.
- 01:40 requests -1, -2, -3. planet-bake's configs give every body a seed and overrides; the terrain sections
  take them.
- 02:00 request -4 (blocking). planet-bake resolved -2.
- 02:00-02:40 atmosphere, heating, gamma, colour and DEM sources (with a research sub-agent's leads, every
  value fetched and parsed by the tool); generator, tests and validation complete; commits bc75765, d026d18,
  21b5bfd, bbe0a99, d5db17f, ad48b5c, 00fd133.
