# bodies-ephemeris: hand-off

Wave 3.1, MIGRATION_V2 step 3.7. The package stages 32 body definitions under `data/staged/`. They are
generated from source tables, their orbits are fitted to JPL Horizons, and they are validated against a
tolerance table and a committed held-out truth sample. This package wrote nothing under `data/defs`.

## Status

- All 32 staged files exist, load through the loader laid over `data/defs`, and compile against the v2
  contract in a typed fixture.
- **Validation passes:** `validate.mjs` reports 27 bodies inside their class tolerance and 2 lead-approved
  exceptions (Mimas, Miranda; both resonances). Earth and the Moon are pinned and reported.
- The **held-out Horizons sample** (40 off-grid instants for each of 31 bodies) agrees through
  `heldout.test.ts`.
- **Earth** reproduces the v1 Sun direction exactly. **The Moon's file** is byte-identical to `data/defs`.
- An independent review rebuilt the orbits and confirmed the residuals, frames, exceptions, GMs, radii, poles
  and atmospheres. Its majors and minors are all addressed in section 8.
- **Open:**
  - request -1 (sim-core-v2): the loader must skip `radii.json`;
  - request -5 (planet-bake): mean colours, Iapetus' disc mean, crater depths.

## 1. What there is

| Path | What |
|---|---|
| `data/staged/bodies/<id>.json` | One `BodyDef` per body of ARCHITECTURE 8.1 (32 files) |
| `data/staged/terrain/<id>.terrain.json` | The terrain sections of the 25 new solid bodies, as `{ "$ref": "../terrain/<id>.terrain.json" }`. The reference is relative to its root, so the same path works under `data/staged` and `data/defs` |
| `data/staged/bodies/radii.json` | `{ bodies: [{ id, meanRadius, equatorialRadius, polarRadius, radiiAbc }] }` in metres |
| `tools/bodies/tolerances.json` | Tolerance classes, one row per body, the approved exceptions, the sub-parent-longitude bound |
| `tools/bodies/sources/orbit-fits.json` | Fitted orbits, starting values, residuals, synchronous rotations, Horizons queries |
| `tools/bodies/provenance.json` | Source (URL, time of retrieval) and derivation of every value; `paths` per orbit |
| `tools/bodies/validation-report.json` | Residual over the window per body; sub-parent longitude; approvals; degradation outside the window |
| `tests/unit/bodies/horizons-heldout.json` | Held-out Horizons truth, about 130 KB |
| `tests/unit/bodies/stagedBodies.generated.ts` | The staged files as typed literals |
| `tools/bodies/sources/*.json` | The other extracted source tables, each with URL, time of retrieval and sha256 |

Commands. Node, no dependencies. The Python helpers need `pypdf`, `PIL` and `numpy`, all present on this
machine.

```
node tools/bodies/fetch-sources.mjs [--refresh]  source documents -> tools/bodies/sources/*.json (cache data/cache/bodies/<id>/)
node tools/bodies/fit-orbits.mjs [id ...]        fits to Horizons over the window (states fetched once, cached) -> sources/orbit-fits.json
node tools/bodies/generate.mjs [--check]         writes / checks byte for byte all 60 generated files; no network
node tools/bodies/validate.mjs [--quiet]         window residuals, sub-parent longitudes, approvals, outside-window table; exit 1 on a failure
node tools/bodies/fetch-heldout.mjs              re-fetches the held-out truth sample (tests/unit/bodies/horizons-heldout.json)
npx vitest run tests/unit/bodies                 140 tests
```

## 2. Conventions solar-system-sim must implement (the reference is `tools/bodies/lib/kepler.mjs`)

- **Time (lead decision).** The game's `ut` is seconds since J2000.0 treated as UTC. The ephemerides (the
  fitted orbits and pck00011) are evaluated at
  **JD(TDB) = 2451545 + (ut + 69.184) / 86400**. The constant 69.184 s is TT - UTC with the 37 leap seconds in
  force since 2017-01-01. TDB - TT (under 2 ms) is ignored, and **leap seconds announced after 2017 are not
  followed** (the game's clock has none). Without the offset every body would sit 69.184 s behind Horizons at
  a displayed instant: Phobos by 1.14 deg, which is over its class tolerance.
  - In `kepler.mjs`: `TT_MINUS_UTC_S`, `utToJd`, `jdToUt`. `pck.mjs` evaluates rotations at that instant too.
  - `epochUt` values in the staged files are game `ut`: the fit epoch and the rotation epoch are the lobby
    epoch 938240818.
- **Velocity (lead decision).** A body's velocity is the **exact time derivative of its position**, the
  node-rate and apsis-rate terms included, and so are the a, e, i drifts when present
  (`stateFromElements(el, n, plane, drift)`, closed form, as v1 already does for the Almanac Sun). It is NOT
  the ellipse's own velocity from n. The difference is up to 101 m/s (Europa), 63 (Io), 38 (Mimas)
  and 16 (Enceladus): a vessel crossing those spheres of influence would otherwise get a kick that size.
  `ephemeris.test.ts` compares a central difference of the position with the stated velocity (relative
  error < 1e-6) for 14 bodies.
- **Orbit elements.** Rates are per Julian century, linear from `epochUt`. `meanMotionDegPerDay` is the
  mean-anomaly rate.
- **Frames.**
  - `'ecliptic'` = Rx(+23.4392911 deg).
  - `{ pole }` = Rz(ra + 90) Rx(90 - dec), as `poleQuat`; +X is the plane's ascending node on the ICRF
    equator.
  - Every satellite now has an explicit `{ pole }`:
    - Mars', Jupiter's and Saturn's moons: their Laplace poles.
    - Uranus' moons: the POSITIVE pole.
    - Triton and Charon: the parent's pck00011 pole at the epoch, written out. Their orbit planes no longer
      depend on the parent's `rotation`.
  - No staged body uses `'parentEquator'` any more.
- **Rotation.** `fixedRate` from pck00011 at the epoch (full model).
  - **Synchronous satellites** (20 of them, Phobos to Charon) keep their pck pole. Their prime meridian comes
    from whichever of these two candidates keeps the sub-parent longitude closer to the real one (Horizons
    position, full pck model with its libration terms):
    - **A:** rate = the fitted mean-longitude rate (n + node rate + apsis rate, with the sign of the IAU
      rate) and W0 = the full pck W at the epoch;
    - **B:** a least-squares line through the full pck W over the window.
  - Earth (GMST) and the Moon (`tidalLock`) keep v1.
- **The rest is unchanged from the first hand-off.**
  - `soiRadius`:
    - `'auto'`, under the v2 rule;
    - Sun `null`;
    - the Moon keeps v1's 66,100 km;
    - Earth has the number 924,776 km.
  - `warpAltitudeLimits`: absent on the new bodies. Earth and the Moon keep 7.
  - `shape`: on Mercury, Mars, the giants, Iapetus and Ceres. It is the altitude reference; heights are
    relative to the mean radius.
  - `surface: 'none'` with `floorAltitude` = -H ln 10: on the giants.
  - The Sun is the root attractor.

## 3. Orbits: method and residuals

**Fit.** Every body but the Sun, Earth and the Moon has a precessing Kepler ellipse fitted to Horizons states
(ICRF, geometric, parent body centre) by `fit-orbits.mjs` (the lead's decision on request -4).
- **Window and sampling.** 2029-09-01 to 2060-01-01. About 2,000 states per body, at a whole-minute step whose
  fraction of the period is near the golden ratio, so they cover every orbital phase. Satellites also get a
  dense ±3-period span about the epoch.
- **Starting values.** The tables carried to the epoch. Phobos, Deimos and Triton use the Horizons osculating
  mean motion.
- **Stages.** Doubling spans, so the phase is never ambiguous.
- **Fitted elements.** a, e, i, node, argument of periapsis and mean anomaly at the epoch, and the mean motion.
  Satellites also fit their node and apsis rates.
- **Heliocentric bodies keep their starting rates:** Table 1's secular rates, or zero for Ceres and Pluto.
  Over a fraction of an orbit (a fifth of Neptune's), a fitted apsis rate takes up part of the mean-longitude
  rate: Neptune's came out at 45 % of its mean motion. Such an orbit reproduces the window but turns wrongly
  beyond it.
- **Refusal rule.** The fit tool refuses any orbit whose precession exceeds 1 % of its mean motion. This is
  kept as a guard against that degenerate split and the bad extrapolation it causes, and so that the
  osculating conic the runtime derives from the state still describes the mean orbit. It is no longer a
  velocity argument, since the velocity is now exact.

**Residuals.** Largest over the window, and the same at the held-out instants. Angle is between model and
Horizons positions seen from the parent.

| Body | Max angle (deg) | Max radial | Tolerance | Verdict | Sub-parent longitude (deg) |
|---|---|---|---|---|---|
| Mercury | 0.0067 | 0.003 % | 0.1 deg / 0.2 % | pass | |
| Venus | 0.0075 | 0.005 % | 0.1 / 0.2 % | pass | |
| Earth | 0.837 | 0.009 % | - | reported (pinned; of date 45") | |
| Mars | 0.0274 | 0.017 % | 0.1 / 0.2 % | pass | |
| Jupiter | 0.0911 | 0.068 % | 0.1 / 0.2 % | pass | |
| Saturn | 0.0328 | 0.153 % | 0.1 / 0.2 % | pass | |
| Uranus | 0.0259 | 0.035 % | 0.1 / 0.2 % | pass | |
| Neptune | 0.0129 | 0.018 % | 0.1 / 0.2 % | pass | |
| Moon | 168.9 | 13.4 % | - | reported (pinned) | |
| Phobos | 0.2356 | 0.016 % | 1 deg / 2 % | pass | 1.95 (A) |
| Deimos | 0.2358 | 0.012 % | 1 / 2 % | pass | 0.26 (A) |
| Io | 0.0351 | 0.010 % | 1 / 2 % | pass | 0.07 (A) |
| Europa | 0.1410 | 0.065 % | 1 / 2 % | pass | 0.15 (A) |
| Ganymede | 0.1260 | 0.095 % | 1 / 2 % | pass | 0.13 (A) |
| Callisto | 0.0467 | 0.022 % | 1 / 2 % | pass | 0.04 (B) |
| Mimas | 10.17 | 0.51 % | **10.9 deg** (approved) | reasoned exception | 4.04 (A) |
| Enceladus | 0.4746 | 0.017 % | 1 / 2 % | pass | 0.47 (B) |
| Tethys | 0.4793 | 0.012 % | 1 / 2 % | pass | 0.26 (A) |
| Dione | 0.0678 | 0.023 % | 1 / 2 % | pass | 0.07 (B) |
| Rhea | 0.0907 | 0.030 % | 1 / 2 % | pass | 0.05 (A) |
| Titan | 0.0317 | 0.010 % | 1 / 2 % | pass | 0.03 (A) |
| Iapetus | 0.1291 | 0.064 % | 1 / 2 % | pass | 1.10 (A) |
| Miranda | 1.739 | 0.044 % | **1.85 deg** (approved) | reasoned exception | 1.72 (A) |
| Ariel | 0.1752 | 0.082 % | 1 / 2 % | pass | 0.13 (B) |
| Umbriel | 0.1188 | 0.074 % | 1 / 2 % | pass | 0.14 (B) |
| Titania | 0.1880 | 0.148 % | 1 / 2 % | pass | 0.17 (B) |
| Oberon | 0.1488 | 0.113 % | 1 / 2 % | pass | 0.19 (B) |
| Triton | 0.0130 | 0.000 % | 1 / 2 % | pass | 2.51 (B) |
| Ceres | 0.4514 | 0.287 % | 1 / 2 % | pass | |
| Pluto | 0.0114 | 0.016 % | 1 / 2 % | pass | |
| Charon | 0.0010 | 0.000 % | 1 / 2 % | pass | 0.00 (B) |

**Exceptions.** Rows in `tolerances.json` with `approvedBy: "lead"` and `request: "bodies-ephemeris-4"`. The
approved set is exactly Mimas and Miranda.

The validator fails an exception without an approval or a physical reason, and a bound more than 10 % above
its measured value. Mimas is 10.9 against 10.17 measured; Miranda 1.85 against 1.739.
- **Mimas:** held in the 4:2 resonance with Tethys. The argument 4 lambda(T) - 2 lambda(M) - node(M) -
  node(T) librates over about 70 years, and Mimas' longitude swings with it.
- **Miranda:** its longitude carries a 12.5-year sinusoid of about 1.5 deg. That is the period of the
  near-commensurability lambda(M) - 3 lambda(A) + 2 lambda(U) with Ariel and Umbriel, which turns at
  0.0786 deg/day from the fitted mean motions.

No body is off for an unexplained reason.

**Sub-parent longitude.** The bound is 5 deg for every synchronous moon (`tolerances.json`
`subParentLongitudeDeg`). The staged rotation has no libration, physical or optical; Mimas' resonance gives
the largest error. Before the review, Mimas' frozen-libration W drifted 5.4 deg (2028), 34.5 deg (2040) and
89 deg (2060) off its tidal lock. Now it is within 4.0 deg over the window.

### Outside the window (reported, not judged; `validation-report.json` `outsideWindowMaxAngleDeg`)

The fit is a window fit; before 2029-09 and after 2060 it degrades. Angles in degrees, staged orbit against
Horizons:

| Body | 2025 | 2027 | 2028 | 2061 | 2063 | 2065 | 2070 |
|---|---|---|---|---|---|---|---|
| Mimas | 15.2 | 8.3 | 6.2 | 13.7 | 19.3 | 29.2 | 52.7 |
| Tethys | 0.71 | 0.42 | 0.30 | 0.63 | 0.96 | **1.37** | 2.60 |
| Miranda | 1.56 | 0.05 | 0.79 | 1.41 | 0.91 | 0.76 | 0.38 |
| Phobos | 0.34 | 0.25 | 0.21 | 0.27 | 0.36 | 0.44 | 0.76 |
| Saturn (planet) | 0.07 | 0.05 | 0.03 | 0.05 | 0.08 | 0.09 | **0.15** |
| Jupiter | 0.03 | 0.06 | 0.09 | 0.05 | 0.03 | 0.03 | **0.11** |

All other bodies stay within their class tolerances through 2070.

These agree with the reviewer's: Mimas 14.4 deg in 2061, 28-30 deg in 2065 and 8.2 deg in 2027; Tethys
crossing 1 deg around 2063; Phobos 0.47 deg in 2065. **The rules screen and bodies-activation should state
it:** the solar system is fitted to reality from 2029-09 to 2060. Beyond that it is an internally exact clock
that drifts from reality, Mimas within a decade and Tethys after about 2063.

### Limits of the contract (no change possible without a contract change)

- **Fixed spin poles.**
  - **The problem.** `RotationDef` has a fixed pole, while the orbits precess. A synchronous moon's spin pole
    therefore separates from its orbit normal over the window. The real poles follow the orbits (pck00011
    models that).
  - **Separation from the orbit normal by 2060:**

    | Body | Separation |
    |---|---|
    | Miranda | 6.9 deg |
    | Triton | 6.2 deg |
    | Deimos | 3.5 deg |
    | Mimas | 2.3 deg |
    | Phobos | 2.0 deg |
    | Tethys | 1.1 deg |
    | every other moon | at most 0.5 deg |

  - **Separation from the staged pole by 2060, same order:** Miranda 6.85, Triton 6.17, Deimos 3.53,
    Mimas 2.17 and Phobos 2.04 deg.
  - **Effect.** A tilt of the body-fixed frame: the sub-parent latitude oscillates by that amount over each
    orbit.
  - **Fix.** A pole rate on `RotationDef` (pole RA/Dec rates, as pck00011 has) would remove it.
- **No periodic terms.** The orbit model has none, hence the two resonance exceptions.

### Earth and the Moon (for bodies-activation, wave 4.4; pinned now, decided there)

- **Earth.**
  - **The offset.** The v1 formula is referred to the mean equinox of date, so in the J2000 frame of every
    other body Earth's heliocentric longitude is off by the precession: 0.41 deg at the lobby epoch, 0.84 deg
    in 2060. Of date it is within 45", including the formula's 20.5" aberration.
  - **Effect on launch windows.** It shifts every interplanetary window by
    delta-lambda / |n(Earth) - n(target)|:

    | Target | Shift at the lobby epoch | Shift in 2060 |
    |---|---|---|
    | Mercury | 0.13 d | 0.27 d |
    | Venus | 0.67 d | 1.36 d |
    | Mars | 0.9 d | 1.8 d |
    | Jupiter | 0.46 d | 0.93 d |
    | Saturn to Neptune | about 0.44 d | about 0.88 d |

    It passes a day for Mars from about 2033 and for Venus from about 2044.
  - **The fix if wanted.** A precession-only rotation of the formula's output. Activation must then
    re-prove the start time and the lunar mission.
- **Moon.**
  - **The drift.** The frozen v1 ellipse has no nodal regression (18.6 y) and no apsidal precession
    (8.85 y). Over the window it is up to 169 deg from the real Moon (rms 87 deg, distance up to 13 %).
  - **The fix if wanted.** A fitted Moon would be the same fit as every other moon (expected 0.1-0.3 deg).
    It moves the lunar mission's windows and the sim-orbits tests that pin the frozen ellipse.

## 4. Acceptance, measured

| Criterion | Result |
|---|---|
| A staged file for EVERY name of the list (the test iterates the list) | **Met** |
| Compiles against BodyDef in a typed fixture | **Met**, with two widenings: `warpAltitudeLimits` optional (ARCHITECTURE 8.3), and the section positions may be `{ $ref }`. `typecheck:paths` passes |
| Passes the Horizons validation | **Met** under the lead's tolerances: 27 pass, 2 approved exceptions, 0 failed, both in `validate.mjs` and on the committed held-out sample (`heldout.test.ts`) |
| Worst deviation per body; the path of each Saturnian moon | Section 3. Every moon is fitted |
| Earth reproduces the v1 Sun direction at 1,000 instants over 2029-2031 | **Met** (< 1e-15 rad). This compares the staged formula with v1's, the same formula by design, so its value is as a regression pin. The physical check is the held-out test: Earth lies 0.41-0.84 deg from Horizons, as section 3 explains |
| The Moon's orbit block byte-identical to today's | **Met** (the whole file) |
| No file under `data/defs` changed | **Met for this package** |
| Self-verify | All pass: `generate --check` (60 files), `validate.mjs` (exit 0), vitest 140/140, boundaries 93/93. `check-stubs` reports 8 findings, none in my paths (`src/render/vehicle/site/ground.ts`, another package's) |

## 5. Data notes

### GM

- **Planets and Pluto:** DE440 system GM minus the satellites with a GM in JPL's table. The difference from
  the planet-only GM of the satellite ephemerides is in the provenance. Measured (correcting the first
  hand-off's "2e-8" claim):

  | Body | Difference | Reference |
  |---|---|---|
  | Mars | 3.3e-8 | MAR097 |
  | Jupiter | 1.7e-8 | JUP365 |
  | Saturn | 2.3e-8 | SAT441 |
  | Uranus | 0 | URA111 |
  | **Neptune** | **-6.6e-7** | NEP097 |
  | **Pluto** | **1.1e-4** | PLU060 |

  The last two reflect the satellite GMs listed (Nereid 0; Kerberos and Styx without GM) against those
  ephemerides' own values.
- Mercury, Venus and the Sun: DE440. Moons: JPL satellite GMs. Ceres: SBDB. Earth and the Moon: v1.

### Size and albedo

- **Radius:** JPL mean radius. **Shape and radii:** pck00011.
- **Geometric albedo:** JPL (planet table; Horizons for the satellites).
  - Charon: NSSDC 0.42.
  - **Pluto: NSSDC 0.52**, not JPL's dwarf-planet table value of 0.3, which predates New Horizons and drew
    Pluto darker than Charon.
  - **Iapetus' 0.6 is its bright hemisphere** (NSSDC: 0.05 / 0.5). Its disc mean is asked of planet-bake in
    request -5.

### Mean colour

- From B-V (V-Rc for the planets) against the Sun's (Ramirez 2012).
- **Io and Ganymede** from their global colour maps: the area-weighted mean linear RGB of planet-bake's
  source maps.
- **Europa, Callisto, Iapetus, Mimas, Miranda, Ariel and Umbriel have no colour map** (monochrome or none):
  neutral until planet-bake reports its baked level-0 mean (request -5).

### Atmospheres

- **Models:**
  - Mars and the giants: exponential (NSSDC);
  - Venus: table (Venus-GRAM/VIRA);
  - Titan: table (Huygens HASI). Each row is now a local least-squares line through the samples, evaluated
    at the row's altitude. The surface row is 146,710 Pa, 93.45 K, 5.346 kg/m^3; HASI at 3 m gives
    146,645 / 93.50 / 5.345. Before, a one-sided average gave 144,960 / 93.17 / 5.296.
- **Gamma:** Justus & Braun or NIST.
- **simTop:** where the density falls to Earth's at its simTop.
- **Convective heating:** Sutton-Graves (TR R-376).
- **Drag and convective heating work for all seven new atmospheres in the runtime** (tested).
- **Radiative heating of non-air gases is not modelled.** It is a seam for the landing update: the
  `AtmosphereHeatingDef.radiative` schema takes a set with no code change. Until then fast Venus entries and
  giant entries are under-heated.

### Terrain sections

- **Amplification:** planet-bake's resolved definition.
- **`maxRenderLevel`** = round(log2(R pi/2 / 10 m)).
- **`residentLevel`** = min(3, the pyramid's depth): 3, Deimos 2. This is the contract's rule for generated
  bodies (request -3, resolved by the lead).
- **`surfaceFriction`** 0.7.

**Elevation bounds, basis per body.** Once planet-bake bakes a body, the bounds come from its manifest's
`layers.height.elevation` plus the run-time craters (the code path is in place). Until then they enclose what
the bake can produce:

| Bodies | Basis |
|---|---|
| Mars, Venus | Reference surface + the published DEM range |
| Mercury, Ceres, Pluto, Charon | Reference surface + the DEM's int16 storage range (no published range; loose) |
| Deimos, Mimas, Miranda, Ariel, Umbriel, Titania, Oberon | Ellipsoid + planet-bake's procedural craters to 0.4 R |
| Phobos, Io, Europa, Ganymede, Callisto, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus, Triton | The ellipsoid and the **run-time craters only** (no DEM, no baked craters) |

The crater bound uses the depth-to-diameter ratio the generic models apply at every size. Titania
-63.6 km, Oberon -61.4, Ariel -47.9 and Umbriel -47.1 are what the bake would produce: correct as bounds of
the bake, unphysical as relief. Request -5 asks planet-bake about complex-crater depths.

## 6. Deviations and limits

1. **The orbits are fitted.** The tables are the starting values (lead decision). Heliocentric rates are held
   (section 3).
2. **Clock and velocity** follow the lead's decisions (section 2). Leap seconds after 2017 are not followed.
3. **Earth's `soiRadius` is a number.** `warpAltitudeLimits` is absent on the new bodies.
4. **The contract's fixed poles and the absence of periodic terms** (section 3, limits).
5. **Seven neutral colours, Iapetus' albedo, the crater depths:** request -5.
6. **Radiative heating:** a seam.
7. **Staleness.** The generator reads the live Earth, Moon and Sun files, planet-bake's configs, parameter
   files and manifests, and (in `fetch-sources.mjs`) its cached colour maps. A change there shows up in
   `generate --check`.

## 7. Requests

| Request | To | Status |
|---|---|---|
| -1 | sim-core-v2 (`src/core/defs`) | open: the loader must skip `radii.json` |
| -2 | planet-bake | resolved |
| -3 | lead | resolved (`BodyTerrainDef.residentLevel`, commit 00e908b); implemented here |
| -4 | lead | resolved by decision and implemented (fitted orbits, tolerance table) |
| -5 | planet-bake | open: level-0 mean colours of seven bodies; Iapetus' disc mean; depth of the large procedural craters |

## 8. Review (independent rebuild): findings and what was done

| # | Finding | Done |
|---|---|---|
| 1 | Mimas' rotation drifted about 90 deg off tidal lock (frozen libration phase, mean rate); Tethys smaller | Synchronous moons rotate with their fitted orbit (A or B, section 2); validator line: sub-parent longitude within 5 deg; Mimas 4.0 deg |
| 2 | Time scale: ut fitted as TDB, 69.184 s off | JD(TDB) = 2451545 + (ut + 69.184)/86400 in `kepler.mjs`, `pck.mjs`, the fit, the validator, the held-out sample; refit and regenerated |
| 3 | Velocity from n only (Europa 101 m/s) | Exact derivative in `stateFromElements`; finite-difference test; the 1 % precession refusal kept as a guard against degenerate fits and bad extrapolation, not velocity |
| 4 | `residentLevel` missing | min(3, pyramid depth) on all 25 sections |
| 5 | Frozen poles; Triton and Charon coupled to the parent's rotation | Recorded with numbers (section 3); Triton and Charon now have explicit `{ pole }` frames |
| 6 | No committed truth | `tests/unit/bodies/horizons-heldout.json` (40 off-grid instants x 31 bodies, game clock) + `heldout.test.ts` judging the STAGED files with `tolerances.json` |
| 7 | Any 40-character reason passed | Exceptions need `approvedBy: "lead"` + request id and at most 10 % slack; approved set Mimas, Miranda |
| 8 | Degradation outside the window undocumented | Outside-window table (section 3), agrees with the reviewer's figures |
| 9 | Planet-GM claim | Corrected with the measured differences (section 5) |
| 10 | Pluto darker than Charon; Iapetus' bright side | Pluto 0.52 (NSSDC); Iapetus' disc mean added to request -5 |
| 11 | Titan surface row biased low | Local least-squares rows evaluated at the row's altitude |
| 12 | Elevation bounds from simple-crater depth on 316 km craters | Basis stated per body; manifest-based bounds once baked; the bake's crater depth raised with planet-bake (request -5) |

## Running log

- 2026-11-12 00:30-02:40: first build (sources, generator, tests, validation against the brief's tolerances,
  request -4).
- Lead decision on -4. Fitted orbits and the tolerance table (fad4aec).
- Independent review, 12 findings. Clock offset, exact velocity, synchronous rotations, explicit planes for
  Triton and Charon, `residentLevel`, Pluto albedo, Titan rows, approvals and slack, held-out truth,
  outside-window table (bb78061). Request -5 extended (5bb239c). This hand-off.
