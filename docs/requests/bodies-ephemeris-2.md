Status: open
From: bodies-ephemeris
Owner path: tools/bake/planet/bodies, data/defs/terrain/*-generic.amplification.json (planet-bake)
Blocking: no

## Problem
Interface note between two packages working in parallel. bodies-ephemeris writes the terrain section of
every new solid body (`data/staged/terrain/<id>.terrain.json`, a `BodyTerrainDef`). Your generic models
require the complete parameter set in `def.params` and reject unknown keys, and your bake draws the large
craters of the same population as the run-time model, so the section's `seed` and `params` must be exactly
the ones your bake resolves (`procedural.resolved_amplification`).

## Evidence
`tools/bodies/lib/build.mjs` (`terrainSection`) therefore READS (never writes) your configs and parameter
files and writes the resolved amplification:

```
amplification = { model: cfg.amplification.model, seed: cfg.amplification.seed,
                  params: { ...data/defs/terrain/<model>.amplification.json params, ...cfg.amplification.params } }
```

It fails loudly when a config is missing, when the config's model is not the catalogue's surface class
(rocky: Mercury, Venus, Mars, Phobos, Deimos, Io, Ceres; icy: the other eighteen), when an override is not a
parameter of the model, or when the config's mean radius differs from the definition's. The other fields:
`tileset` = body id; `maxRenderLevel` = round(log2(R pi/2 / 10 m)) (the Earth level-20 / Moon level-18
precedent); `min/maxElevation` = your reference surface (ellipsoid radii, or the DEM sphere) relative to the
mean radius + the DEM's published range (`tools/bodies/sources/dem-relief.json`) + your procedural craters
(depth `freshDepthToDiameter` D and rim `rimHeightToDiameter` D at D = `maxDiameterRadii` R) + the run-time
crater classes below the data level; `surfaceFriction` = the Moon's 0.7.

## Requested change
Nothing to change if you agree; please:
1. keep the configs' `amplification` and the two parameter files committed, and tell the owner of
   `tools/bodies` (solar-system-sim in wave 4) when you change a seed or an override, so the staged sections
   are regenerated (`node tools/bodies/generate.mjs --check` reports them stale);
2. name the asset id of Saturn's ring strip you stage under `data/staged/render/`; the staged Saturn has
   `rings: [{ innerRadius: 74,658 km, outerRadius: 136,780 km, texture: "saturn-rings", opticalDepthScale: 1 }]`
   (C ring inner edge to A ring outer edge, NSSDC) and the texture's radial extent must map to those radii
   (or tell me the extent of your strip and the generator takes it).
