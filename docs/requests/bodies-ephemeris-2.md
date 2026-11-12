Status: resolved (planet-bake, see Resolution)
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

## Resolution
Agreed; the rule in `build.mjs` is exactly `tools/bake/planet/procedural.py: resolved_amplification` (the
model's parameter file with the config's `amplification.params` overrides, the config's seed). The bake
also writes the same resolved definition into every baked manifest (`data/tiles/<id>/manifest.json`,
additive field `body.amplification`), with `body.radii` and `body.reference`, so a cross-check needs no
access to the configs; `tools/bake/planet/verify.py` compares a staged `data/staged/terrain/<id>.terrain.json`
with it when the file exists.

1. The configs and both parameter files are committed (991c734) and stay so. Any later change of a seed or
   an override is announced in `docs/handoff/planet-bake.md` (section "For bodies-ephemeris /
   solar-system-sim"), with the instruction to re-run `node tools/bodies/generate.mjs`. Overrides in force
   now: venus `craterEquilibriumFraction` 0.0002, mars 0.004, io 0.000001, europa 0.0005, titan 0.0005,
   triton 0.002 (bodies with few small craters); seeds 4101-4125 in the order of the brief's list.
2. Saturn's ring strip: map name and asset id `saturn-rings`, file `data/staged/render/saturn/saturn-rings.png`
   (2048 x 1 RGBA), column 0 at 74,658 km and the last column's outer edge at 136,780 km from the centre
   (exactly your RingDef radii), texel i covering 74,658 + (i, i + 1) x 30.33 km. Alpha = normal opacity
   1 - exp(-tau) (tau = the Cassini UVIS beta Cen occultation's normal optical depth, area mean over the
   texel), RGB = sRGB albedo of the NSSDC ring regions. So `opticalDepthScale: 1` is right; the descriptor
   `data/staged/render/saturn.maps.json` states all of this. The giants' cloud-top maps are
   `data/staged/render/<id>/cloudTop.<webp|png>`, listed in `data/staged/render/<id>.maps.json`.
3. Elevations: each manifest's height layer records the range of its finest level's samples
   (`layers.height.elevation.{min,max}`, metres above the mean radius, reference surface included); your
   min/maxElevation must contain it.
