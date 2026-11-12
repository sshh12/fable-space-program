# bodies-ephemeris: hand-off

Wave 3.1, MIGRATION_V2 step 3.7. Thirty-two body definitions generated from source tables and validated
against JPL Horizons, staged under `data/staged/` (nothing under `data/defs` changes).

## 1. What there is

| Path | What |
|---|---|
| `data/staged/bodies/<id>.json` | One `BodyDef` per body of ARCHITECTURE 8.1 (32 files) |
| `data/staged/terrain/<id>.terrain.json` | The terrain section (`BodyTerrainDef`) of each of the 25 new solid bodies, referenced from the body as `{ "$ref": "../terrain/<id>.terrain.json" }` |
| `data/staged/bodies/radii.json` | `{ description, bodies: [{ id, meanRadius, equatorialRadius, polarRadius, radiiAbc }] }`, metres; mean = `BodyDef.radius`, the others from pck00011 |
| `tools/bodies/provenance.json` | Every generated value with its source (URL, time of retrieval) and derivation; the path and reading of every orbit |
| `tools/bodies/validation-report.json` | The Horizons validation: worst deviation per body, every epoch, the Horizons URL |
| `tools/bodies/sources/*.json` | The source tables, extracted from the downloaded documents (URL, time of retrieval, sha256 of the document with each) |
| `tests/unit/bodies/stagedBodies.generated.ts` | The staged files as typed literals (`satisfies` the v2 contract) |

Tools (`tools/bodies/`, Node, no dependencies):

```
node tools/bodies/fetch-sources.mjs [--refresh]   download into data/cache/bodies/<id>/ and extract tools/bodies/sources/*.json
node tools/bodies/generate.mjs [--check]          write (or check) every generated file; no network
node tools/bodies/validate.mjs [--quiet]          Horizons validation (cached under data/cache/bodies/horizons/); exit 1 on a gated failure
npx vitest run tests/unit/bodies                  typed fixture, refs, radii, Earth / Moon pins, generator = disk, runtime parity, atmospheres
```

Modules a later owner (solar-system-sim in wave 4) works with: `lib/catalogue.mjs` (the 32 bodies, ids,
Horizons commands, surface class), `lib/build.mjs` (one `buildLibrary(sources, live, bake)`), `lib/orbits.mjs`
(the orbit paths and the reading of the satellite table), `lib/kepler.mjs` (the contract's orbit semantics,
with `.d.mts` types), `lib/pck.mjs` (IAU rotation models), `lib/atmospheres.mjs`, `lib/colour.mjs`,
`lib/fit.mjs` (least squares), `lib/horizons.mjs`, `lib/http.mjs` (cached downloads).

## Running log

- 2026-11-12 start. Read STATUS, the brief, ARCHITECTURE 8 and 10, MIGRATION_V2, PACKAGE_RULES,
  user-decisions, solar-system.md, defs.ts, the lead-baseline-v2 hand-off, `src/sim/bodies`, the loader.
  Nothing of the other 3.1 packages is committed yet (no overlay `DefSource`, no `tools/bake/planet`).
- 00:50 sources downloaded (`data/cache/bodies/<id>/`, each with URL, time, sha256) and extracted to
  `tools/bodies/sources/*.json` by `tools/bodies/fetch-sources.mjs`: JPL approx_pos Table 1 + accuracy, JPL
  satellite mean elements, JPL satellite and planet physical parameters, JPL astro_par (DE440), pck00011,
  SBDB Ceres and Pluto, Horizons object-data headers (albedo), NSSDC fact sheets.
- 01:10 first measurements against Horizons over 2030-2060 (ten epochs) show the brief's tolerances are not
  met by the design's sources for many bodies (Table 1 nominal errors exceeded by most planets; satellite
  table periods too coarse for Phobos and Deimos; Mimas' resonance libration; Earth's v1 formula is of date).
- 01:40 requests filed: bodies-ephemeris-1 (radii.json vs the loader's definition rule, to sim-core-v2), -2
  (terrain-section amplification, to planet-bake), -3 (no resident level in BodyTerrainDef, to the lead).
  planet-bake's configs (tools/bake/planet/bodies) give every body a seed and parameter overrides: the
  generated terrain sections take them (the bake and the run-time crater populations must agree).
- 02:00 request bodies-ephemeris-4 (blocking, to the lead): the measured deviations and the options.
  Request -2 resolved by planet-bake (ring strip `saturn-rings` spans exactly the staged ring radii).
