Status: open
From: bodies-ephemeris
Owner path: src/terrain/amplification (planet-bake: the rocky-generic and icy-generic models)
Blocking: no

## Problem
Interface note between two packages working in parallel. bodies-ephemeris writes the terrain section of
every new solid body (`data/staged/terrain/<id>.terrain.json`, a `BodyTerrainDef`), and its
`amplification` names your models with per-body parameters "from the body's data" (the brief's words). Your
factories receive exactly this `TerrainAmplificationDef`, so the parameter names must be ones they read.

## Evidence
What the generator writes (`tools/bodies/lib/build.mjs`, `terrainSection`), e.g. Mars:

```
"amplification": { "model": "rocky-generic", "seed": <FNV-1a 32-bit hash of the body id>,
                   "params": { "surfaceGravity": 3.7275..., "meanRadius": 3389500 } }
```

- `model`: `rocky-generic` for Mercury, Venus, Mars, Phobos, Deimos, Io, Ceres; `icy-generic` for Europa,
  Ganymede, Callisto, Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus, Miranda, Ariel, Umbriel,
  Titania, Oberon, Triton, Pluto, Charon (surface composition).
- `params.surfaceGravity` = GM / R^2 of the staged definition (m/s^2); `params.meanRadius` = its datum
  radius (m) - the inputs a crater population scales with (simple-to-complex transition, depth/diameter).
- `tileset` = the body id; `maxRenderLevel` = round(log2(R pi/2 / 10 m)) (the Earth level-20 and Moon
  level-18 precedent); `minElevation` / `maxElevation` = the pck00011 ellipsoid radii minus the mean radius,
  widened by the published DEM range where your source has a DEM; `surfaceFriction` 0.7 (the Moon's).

## Requested change
Make the two factories read their tunables from your parameter files (`data/defs/terrain/*-generic.
amplification.json`, as your brief says) and the two per-body inputs above from `def.params`
(`surfaceGravity`, `meanRadius`), using `def.seed` as given. If you need another per-body input (a number
the source tables of tools/bodies hold), name it here and bodies-ephemeris (or solar-system-sim, which owns
tools/bodies in wave 4) adds it to the generator. The radii your bake configs carry must equal
`data/staged/bodies/radii.json` (mean = `meanRadius`, triaxial = `radiiAbc`, metres).
