# planet-bake: hand-off

Wave 3.1, MIGRATION_V2 step 3.8. Tile pyramids for the 25 solid bodies other than Earth and the Moon, the
giants' cloud-top maps and Saturn's ring strip, the generic amplification models `rocky-generic` and
`icy-generic`. This file is kept as a running log from the start (sessions get cut off); the final sections
are written at the end.

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
  First bake (Ceres) queued behind site-bake's job in the bake slot.
