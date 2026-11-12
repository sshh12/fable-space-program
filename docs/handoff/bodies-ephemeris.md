# bodies-ephemeris: hand-off

Wave 3.1, MIGRATION_V2 step 3.7. Thirty-two body definitions generated from source tables and validated
against JPL Horizons, staged under `data/staged/` (nothing under `data/defs` changes).

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
  Details in section "Validation" below; working on the paths and the report.
