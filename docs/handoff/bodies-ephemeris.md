# bodies-ephemeris: hand-off

Wave 3.1, MIGRATION_V2 step 3.7. Thirty-two body definitions generated from source tables, with orbits
fitted to JPL Horizons and validated against a tolerance table, staged under `data/staged/`. This package
wrote nothing under `data/defs`.

**Status.**
- All 32 staged files exist. They load through the loader laid over `data/defs` and compile against the v2
  contract in a typed fixture.
- **The Horizons validation passes** under the lead's decision on request -4: 27 bodies within their class
  tolerance and 2 reasoned exceptions, Mimas and Miranda (resonances). Earth and the Moon are pinned and
  reported.
- Earth reproduces the v1 Sun direction exactly, and the Moon's file is byte-identical.
- Open:
  - request -1 (sim-core-v2): `radii.json` and the loader.
  - request -3 (lead): no resident-level field.
  - request -5 (planet-bake): colours of seven bodies without a colour map.

## 1. What there is

| Path | What |
|---|---|
| `data/staged/bodies/<id>.json` | One `BodyDef` per body of ARCHITECTURE 8.1 (32 files) |
| `data/staged/terrain/<id>.terrain.json` | The terrain section (`BodyTerrainDef`) of each of the 25 new solid bodies, referenced as `{ "$ref": "../terrain/<id>.terrain.json" }`. The path is relative to the root the file lives in, so it works under `data/staged` and, after activation, under `data/defs` |
| `data/staged/bodies/radii.json` | `{ description, bodies: [{ id, meanRadius, equatorialRadius, polarRadius, radiiAbc }] }`, metres. Mean = `BodyDef.radius`; the others are pck00011 a, c and (a, b, c) |
| `tools/bodies/tolerances.json` | The tracked tolerance table: class tolerances, one row per body, and the reasoned exceptions |
| `tools/bodies/sources/orbit-fits.json` | The fitted orbits, their starting values, the fit residuals and the Horizons queries |
| `tools/bodies/provenance.json` | Every generated value with its source (URL, time of retrieval) and derivation; `paths` per orbit |
| `tools/bodies/validation-report.json` | The residual of every staged orbit over the window, judged with the tolerance table |
| `tools/bodies/sources/*.json` | The source tables, extracted from the downloads (URL, time of retrieval, sha256 of the document) |
| `tests/unit/bodies/stagedBodies.generated.ts` | The staged files as typed literals (`satisfies` the contract) |

Commands (Node, no dependencies; `pdftext.py` and `mapcolour.py` need `pypdf`, `PIL` and `numpy`, present
on this machine):

```
node tools/bodies/fetch-sources.mjs [--refresh]  downloads into data/cache/bodies/<id>/ and extracts tools/bodies/sources/*.json
node tools/bodies/fit-orbits.mjs [id ...]        fits the orbits to Horizons over the window (states cached once); writes sources/orbit-fits.json
node tools/bodies/generate.mjs [--check]         writes (or checks byte for byte) all 60 generated files; no network
node tools/bodies/validate.mjs [--quiet]         residual over the window against tolerances.json (cached states); exit 1 on a failure
npx vitest run tests/unit/bodies                 94 tests
```

Modules (`tools/bodies/lib/`), for the next owner of `tools/bodies` (solar-system-sim, wave 4):

| Module | Contents |
|---|---|
| `catalogue.mjs` | The 32 bodies |
| `build.mjs` | `buildLibrary(sources, live, bake)` |
| `ellipseFit.mjs` | The precessing-ellipse fit, in non-singular elements |
| `window.mjs` | The validity window and its Horizons sampling |
| `orbits.mjs` | Starting values from the tables, the readings of the satellite table, `LOBBY_EPOCH_UT = 938240818` |
| `kepler.mjs` | The contract's orbit semantics, typed by `kepler.d.mts` |
| `pck.mjs` | The IAU rotation models |
| `atmospheres.mjs`, `profiles.mjs`, `nist.mjs` | The atmospheres |
| `derivedSources.mjs` | Readers for the PDFs, profiles, colours and DEM ranges |
| `colour.mjs` | Mean colour |
| `fit.mjs` | Least squares |
| `horizons.mjs`, `http.mjs` | The Horizons client and the cached downloads |

## 2. Orbits: method (the lead's decision on request -4)

**Scope.** Every body except the Sun (root), Earth and the Moon (pinned; section 6) has a precessing Kepler
ellipse fitted to Horizons state vectors (ICRF, geometric, TDB, parent body centre).

**Window and sampling.** 2029-09-01 to 2060-01-01, sampled in about 2,000 steps. Each step is a whole number
of minutes chosen so that its fraction of the orbital period is near the golden ratio, so the samples cover
every phase of the orbit. For the satellites a dense span of +-3 periods at P/24 about the epoch is added.
The epoch is the lobby epoch 938240818.

**Fitted elements.** a, e, i, node, argument of periapsis and mean anomaly at the epoch, and the mean
motion. The node and apsis rates are fitted for the satellites.

**Heliocentric bodies keep their starting rates:** Table 1's secular rates, or zero for Ceres and Pluto. The
window covers a fifth of Neptune's orbit, so a fitted apsis rate there absorbs part of the mean-longitude
rate. Neptune's came out at 45 % of its mean motion, which would have put its velocity (which follows the
mean motion) off by 30 %. The fit tool refuses any orbit whose precession exceeds 1 % of its mean motion.

**Starting values.** The published tables are the starting values and the provenance:
- **Planets:** Table 1 carried to the epoch.
- **Ceres and Pluto:** the SBDB osculating elements carried to the epoch.
- **Satellites:** a, e, the mean motion and the precession rates come from the JPL mean elements, under the
  reading chosen over the 2010-2029 calibration window. Plane and phase come from the osculating orbit at the
  epoch.
- **Phobos, Deimos and Triton:** their table periods do not give their mean motion, so the starting rate is
  the osculating mean motion from Horizons.

**Stages.** The fit is first made over the dense span, then over windows doubling from 30 days to the whole
window, so the mean longitude is never ambiguous.

**Plane frames.**
- Planets, Ceres and Pluto: `'ecliptic'`.
- Moons: their JPL table frame, with a Laplace `{ pole }` for Mars', Jupiter's and Saturn's moons.
- Uranus' moons: `{ pole }` at the POSITIVE pole (77.311, 15.175).
- Triton and Charon: `'parentEquator'`.

The staged orbit is exactly the fitted one: the validator re-evaluates every staged file with the contract
semantics and gets the fit's residuals to the last digit.

### Semantics the runtime must implement (solar-system-sim)

- **Rates** are per Julian century, linear from `epochUt`.
- **`meanMotionDegPerDay`** is the mean-anomaly rate: `M(ut) = M0 + n (ut - epochUt)`.
- **Velocity** is the ellipse's own, from n. The precession contribution is ignored: under 1 % by
  construction, at most 0.76 % (Europa).
- **Frames.**
  - `'ecliptic'` = Rx(+23.4392911 deg).
  - `'parentEquator'` = the parent's `rotation` pole.
  - `{ pole }` = Rz(ra + 90) Rx(90 - dec), the same as `poleQuat`. +X is the plane's ascending node on the
    ICRF equator.
- **Time scale.** `ut` is TDB seconds since J2000 for every ephemeris; 69 s of TT-UTC is 0.9 deg of Phobos.
- **Epochs.** Every fitted orbit and every rotation uses 938240818.
- **Rotation** is `fixedRate` from pck00011, evaluated at that epoch with all its terms. Earth (GMST) and the
  Moon (`tidalLock`) keep v1.
- **`soiRadius`.**
  - `'auto'` everywhere else, under the v2 rule: Phobos 16.6 km, Deimos 15.5 km, Mimas 495 km.
  - The Sun has `null`.
  - The Moon keeps v1's 66,100 km.
  - Earth has a number, 924,776 km: the rule applied with a = 1.00014 au, because its orbit is `sunLowPrecision`.
- **`warpAltitudeLimits`** is absent on the 30 new bodies. Earth and the Moon keep v1's seven; give them nine,
  or none, when the warp table grows.
- **`shape`** is on Mercury, Mars, Jupiter, Saturn, Uranus, Neptune, Iapetus and Ceres. It is the reference
  spheroid for altitude; terrain heights are relative to the mean-radius datum and already contain the
  ellipsoid. The triaxial moons have no `shape`.
- **Giants** have `surface: 'none'` and `floorAltitude` = -H ln 10: Jupiter -62.2 km, Saturn -137.0, Uranus
  -63.8, Neptune -45.4.
- **The Sun** is the root attractor with v1's emission block and no `surface` field (the photosphere is the
  datum radius).

## 3. Acceptance, measured

| Criterion | Result |
|---|---|
| A staged file for EVERY name of the list (the test iterates the list) | **Met** (`staged.test.ts`) |
| Compiles against BodyDef in a typed fixture | **Met**, with two widenings: `warpAltitudeLimits` is optional (ARCHITECTURE 8.3 and the contract comment), and the section positions may be `{ $ref }`. `npm run typecheck:paths -- tests/unit/bodies tools/bodies` passes |
| Passes the Horizons validation | **Met under the lead's decision**: 27 pass, 2 reasoned exceptions, 0 failed; Earth and the Moon reported (`validate.mjs` exits 0) |
| Worst deviation per body; the path of each Saturnian moon | Table below. Every moon, Saturn's included, is on the fit path; the table and earlier fit-path results are in the git history (commit d5db17f) |
| Earth reproduces the v1 Sun direction at 1,000 instants over 2029-2031 | **Met**: angle < 1e-15 rad, distances identical |
| The Moon's orbit block byte-identical to today's | **Met**: the whole file is byte-identical |
| No file under `data/defs` changed | **Met for this package**: the tools write only `data/staged/{bodies,terrain}`, `tools/bodies`, `tests/unit/bodies` |
| The staged library loads through the loader | **Met** (`staged.test.ts`; `radii.json` held out until request -1 is answered) |
| Self-verify | `generate.mjs --check`: 60 files up to date. `validate.mjs`: exit 0. vitest `tests/unit/bodies`: 94/94. Boundaries 93/93. `check-stubs`: OK |

### Residual table

Each figure is the largest over the window: about 1,820-2,000 states per body. Angle = the angle between
model and Horizons positions seen from the parent: heliocentric direction for the planets, orbital longitude
and latitude for the moons.

| Body | Orbit | Max angle (deg) | Max radial | rms (deg) | Tolerance | Verdict |
|---|---|---|---|---|---|---|
| Mercury | fit (Table 1 rates) | 0.0067 | 0.003 % | 0.0018 | 0.1 deg / 0.2 % | pass |
| Venus | fit (Table 1 rates) | 0.0075 | 0.005 % | 0.0031 | 0.1 / 0.2 % | pass |
| Earth | pinned v1 formula | 0.838 | 0.009 % | 0.635 | - | reported (of date: 42") |
| Mars | fit (Table 1 rates) | 0.0274 | 0.017 % | 0.0089 | 0.1 / 0.2 % | pass |
| Jupiter | fit (Table 1 rates) | 0.0911 | 0.068 % | 0.0377 | 0.1 / 0.2 % | pass |
| Saturn | fit (Table 1 rates) | 0.0328 | 0.153 % | 0.0104 | 0.1 / 0.2 % | pass |
| Uranus | fit (Table 1 rates) | 0.0259 | 0.035 % | 0.0109 | 0.1 / 0.2 % | pass |
| Neptune | fit (Table 1 rates) | 0.0129 | 0.018 % | 0.0069 | 0.1 / 0.2 % | pass |
| Moon | pinned frozen ellipse | 168.9 | 13.4 % | 87.3 | - | reported |
| Phobos | fit | 0.2356 | 0.016 % | 0.0990 | 1 deg / 2 % | pass |
| Deimos | fit | 0.2357 | 0.012 % | 0.1023 | 1 / 2 % | pass |
| Io | fit | 0.0351 | 0.010 % | 0.0189 | 1 / 2 % | pass |
| Europa | fit | 0.1410 | 0.065 % | 0.0678 | 1 / 2 % | pass |
| Ganymede | fit | 0.1260 | 0.095 % | 0.0549 | 1 / 2 % | pass |
| Callisto | fit | 0.0467 | 0.022 % | 0.0231 | 1 / 2 % | pass |
| Mimas | fit | 10.17 | 0.509 % | 3.38 | 10.5 deg / 2 % | **reasoned exception**: Mimas-Tethys 4:2 resonance libration |
| Enceladus | fit | 0.4746 | 0.017 % | 0.2240 | 1 / 2 % | pass |
| Tethys | fit | 0.4793 | 0.012 % | 0.1634 | 1 / 2 % | pass |
| Dione | fit | 0.0678 | 0.023 % | 0.0291 | 1 / 2 % | pass |
| Rhea | fit | 0.0907 | 0.030 % | 0.0393 | 1 / 2 % | pass |
| Titan | fit | 0.0317 | 0.010 % | 0.0159 | 1 / 2 % | pass |
| Iapetus | fit | 0.1291 | 0.064 % | 0.0597 | 1 / 2 % | pass |
| Miranda | fit | 1.740 | 0.043 % | 1.003 | 1.8 deg / 2 % | **reasoned exception**: Miranda-Ariel-Umbriel near-commensurability |
| Ariel | fit | 0.1752 | 0.082 % | 0.0782 | 1 / 2 % | pass |
| Umbriel | fit | 0.1188 | 0.074 % | 0.0473 | 1 / 2 % | pass |
| Titania | fit | 0.1880 | 0.148 % | 0.0756 | 1 / 2 % | pass |
| Oberon | fit | 0.1488 | 0.113 % | 0.0705 | 1 / 2 % | pass |
| Triton | fit | 0.0130 | 0.000 % | 0.0040 | 1 / 2 % | pass |
| Ceres | fit (rates zero) | 0.4514 | 0.287 % | 0.1779 | 1 / 2 % | pass |
| Pluto | fit (rates zero) | 0.0114 | 0.016 % | 0.0057 | 1 / 2 % | pass |
| Charon | fit | 0.0010 | 0.000 % | 0.0004 | 1 / 2 % | pass |

**The two exceptions, with their physical reasons** (rows in `tools/bodies/tolerances.json`):

- **Mimas.** Mimas is held in the 4:2 inclination-type resonance with Tethys. The argument
  4 lambda(T) - 2 lambda(M) - node(M) - node(T) librates over about 70 years, and Mimas' longitude swings by
  tens of degrees about its mean rate. The best uniformly precessing ellipse leaves 10.2 deg.
- **Miranda.** Miranda's longitude carries a sinusoid of about 1.5 deg with a 12.5-year period. That is the
  period of the near-commensurability argument lambda(M) - 3 lambda(A) + 2 lambda(U) with Ariel and Umbriel,
  which turns at 0.0786 deg/day from the fitted mean motions; the fit's residual is that sinusoid, along
  track. Bound 1.8 deg.

**No body is off for an unexplained reason.**

**Velocity residual (reported, not judged).** Under 1 % everywhere except Mimas (17 %) and Miranda (3 %).
Those two are the same direction errors seen on the velocity vector. Earth's is 1.5 % and the Moon's is
reported only.

## 4. Data notes (sources and derivations; every value with URL and date in `provenance.json`)

### Mass and size

- **GM.**
  - Planets and Pluto: the DE440 system GM minus the GMs of their satellites in the JPL table. This agrees
    with the satellite ephemerides' planet-only values to 2e-8.
  - Mercury, Venus and the Sun: DE440.
  - Moons: the JPL satellite GMs. Ceres: SBDB.
  - Earth and the Moon: v1.
- **Radius.** The JPL mean radius; the Sun's is the IAU 2015 value. Shape and `radiiAbc` come from pck00011.

### Albedo and colour

- **Geometric albedo.** JPL planet physical parameters for planets and dwarf planets, Horizons object data for
  satellites, NSSDC where JPL lists none (Charon).
- **Mean colour.** From B-V (with V-Rc for the planets) against the Sun's (Ramirez et al. 2012). Sources:
  - Planets: Mallama et al. 2017.
  - Six Saturnian and Uranian moons: PDS SBN satellite colours.
  - Phobos, Deimos, Triton, Titan: Burns 1977.
  - Pluto and Charon: Buie et al. 2006.
  - Ceres: SBDB.
  - **Io and Ganymede:** the area-weighted mean linear colour of the global colour maps planet-bake bakes
    from. Io (0.359, 0.248, 0.114), Ganymede (0.193, 0.179, 0.147), computed by `mapcolour.py` on
    planet-bake's cached downloads.

  The luminance is always scaled to the geometric albedo.

  **Europa, Callisto, Iapetus, Mimas, Miranda, Ariel and Umbriel have no colour map**: monochrome mosaics or
  none. They stay neutral at their albedo until planet-bake reports the mean colour of its baked level-0
  albedo (request -5). When it does, the generator takes it.

### Atmospheres

- **Models.**
  - Exponential: Mars and the giants, from the NSSDC fact sheets.
  - Table, Venus: the Venus-GRAM/VIRA average. Within 0.5 % of the VIRA densities in Justus & Braun (2007)
    from 0 to 100 km; up to 64 % apart above, where VIRA depends on local time.
  - Table, Titan: the Huygens HASI profiles.
- **Gamma.** From Justus & Braun where they state one (Venus, Mars, Titan, Saturn). Otherwise NIST ideal
  mixtures with normal hydrogen (Jupiter, Uranus, Neptune).
- **simTop** is where the density falls to Earth's at its own simTop, 3.831e-9 kg/m^3.
- **Convective heating.** Sutton-Graves `kConv` = Earth's 1.7415e-4 x K(mix) / K(air), from TR R-376
  Table II and eq. 44.
- **Drag and convective heating work for every new atmosphere in the runtime.** `atmosphere.test.ts` checks
  density, pressure, speed of sound and the positive Sutton-Graves flux through `src/sim/dynamics/thermal.ts`,
  for Venus, Mars, Titan and the giants.
- **Radiative heating is not modelled for non-air gases (`radiative: null`).** This is a seam for the landing
  update. A CO2 set (Tauber-Sutton Mars: the constants are public, the velocity table is not), an N2-CH4 set
  and an H2-He set would slot into the existing `AtmosphereHeatingDef.radiative` schema with no code change.
  Until then:
  - fast Venus entries (about 11 km/s) and giant entries are under-heated;
  - Mars, Titan and aerocapture entries are dominated by convection anyway.

### Rings, controls and terrain

- **Saturn's ring:** C inner edge 74,658 km to A outer edge 136,780 km, texture `saturn-rings`. planet-bake
  confirmed that its strip spans exactly these radii.
- **navballSwitchAltitude** follows the v1 ratios: simTop x 60/140 with an atmosphere, R x 20/1737.4 without.
- **Terrain sections.**
  - **Amplification:** planet-bake's resolved model, seed and overrides, so the baked and the run-time crater
    populations are one.
  - **`maxRenderLevel`** = round(log2(R pi/2 / 10 m)).
  - **`surfaceFriction`** 0.7, the Moon's value.
  - **Elevation bounds** add the reference surface, the DEM range, the procedural craters and the run-time
    craters. Mars and Venus have published DEM ranges; Mercury, Ceres, Pluto and Charon use the int16 storage
    range, which is loose. Tighten those from the baked manifests.

## 5. Deviations and limits

1. **The orbits are fitted**, not the published mean elements: the lead's decision on request -4. The tables
   remain the starting values and the provenance in `orbit-fits.json`.
2. **Heliocentric bodies keep their starting node and apsis rates** (section 2). The lead's list of fitted
   rates applies to the satellites. For the planets the window is too short to separate the rates without
   corrupting the velocity.
3. **Earth's `soiRadius` is a number**, and `warpAltitudeLimits` is absent on the new bodies (section 2).
4. **There is no resident level in the terrain sections**; request -3 is with the lead.
5. **`radii.json` vs the loader's definition rule**: request -1 is with sim-core-v2.
6. **The Sun has a `fixedRate` rotation and the DE440 GM.** In v1 it had `'none'` and an older value, both
   unused by v1 dynamics.
7. **Seven bodies keep neutral mean colours** until request -5 is answered (no colour map exists).
   **Radiative heating of non-air gases is a future seam.**
8. **Staleness.** The generator reads the live Earth, Moon and Sun files, planet-bake's configs and parameter
   files, and planet-bake's cached Io and Ganymede maps (in `fetch-sources.mjs` only). A change there makes
   `generate --check` report stale files: re-run the generator.

## 6. For bodies-activation (wave 4.4): the two pinned bodies, measured

Earth and the Moon stay exactly as the design says (the v1 Sun formula, inverted; the frozen lunar ellipse),
so the lunar mission is untouched. Whether to move them is decided at activation, where the start time and
the mission are gates anyway.

- **Earth.** The v1 Almanac formula is referred to the mean equinox of date. The other planets are J2000
  (Table 1 and Horizons-fitted).
  - **The offset.** In the J2000 frame Earth's heliocentric longitude is off by the precession since J2000:
    0.41 deg at the lobby epoch, 0.84 deg in 2060. Of date it is within 42" over the window (the formula's
    apparent longitude includes the 20.5" aberration); distance within 0.009 %.
  - **Effect on launch windows.** It shifts every interplanetary window by
    delta-lambda / |n(Earth) - n(target)|:

    | Target | Shift at the lobby epoch | Shift in 2060 |
    |---|---|---|
    | Mercury | 0.13 d | 0.27 d |
    | Venus | 0.67 d | 1.36 d |
    | Mars | 0.9 d | 1.8 d |
    | Jupiter | 0.46 d | 0.93 d |
    | Saturn to Neptune | about 0.44 d | about 0.88 d |

    Every shift stays within the lead's "about a day", except Mars (past a day from about 2033) and Venus (from about 2044).
  - **The fix if wanted.** Rotate the formula's output from the equinox of date to J2000 (precession only).
    That also changes Earth's sub-solar geometry, so `start-time.json` and the lunar mission must be
    re-proven.
- **Moon.** The frozen v1 ellipse has no nodal regression (18.6 years) and no apsidal precession
  (8.85 years). Over the window it is up to 169 deg from the real Moon (rms 87 deg, distance up to 13 %). A
  real-Moon orbit would be the same fit as every other moon: about 0.1-0.3 deg expected. It would move the
  lunar mission's windows, the scenario start and the sim-orbits tests that pin the frozen ellipse.

## 7. Requests

| Request | To | Status |
|---|---|---|
| bodies-ephemeris-1 | sim-core-v2 (`src/core/defs`) | open: the loader must skip `radii.json` (being passed to its owner by the lead) |
| bodies-ephemeris-2 | planet-bake | resolved |
| bodies-ephemeris-3 | lead (`BodyTerrainDef`) | open: resident-level field (being passed to its owner) |
| bodies-ephemeris-4 | lead | **resolved by the lead's decision** (recorded in the file) and implemented (commit fad4aec) |
| bodies-ephemeris-5 | planet-bake | open, non-blocking: mean linear colour of the baked level-0 albedo for the seven bodies without a colour map |

## Running log

- 2026-11-12 00:30 start. 00:50 sources extracted. 01:10 first Horizons measurements: the design's sources
  miss the tolerances for many bodies.
- 01:40 requests -1, -2, -3. 02:00 request -4 (blocking). planet-bake resolved -2.
- 02:00-02:40 atmosphere, heating, gamma, colour and DEM sources; generator, tests and validation; first
  hand-off (commits up to edcdc79).
- Lead decision on -4 (recorded, 53c69c5). Orbits fitted to Horizons over 2029-09-01..2060-01-01
  (`fit-orbits.mjs`, about 2,000 states per body, fetched once). Heliocentric rates are held after Neptune's
  apsis rate came out at 45 % of its mean motion. Tolerance table with the two resonance exceptions; validator
  on the window residual: 27 pass, 2 reasoned exceptions. Io and Ganymede colours from their maps; request -5.
  Runtime drag and convective-heating test (fad4aec).
