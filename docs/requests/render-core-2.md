Status: open
From: render-core
Owner path: tools/server/dataPlugin.ts
Blocking: no

## Problem
A page cannot find out whether a tile set has been baked without requesting `/tiles/{tileset}/manifest.json`
and getting a 404, which Chrome logs as a console error; `expectNoErrors` then fails the spec. The
LabPlanet (`createLabPlanetFeature`, default `maps: 'tileset'`) reads `globals.albedoLowRes` from the
manifest and therefore logs a 404 for every body whose tile set does not exist yet (today: `earth`).

## Evidence
`/labs/render-core/?maps=tileset&sun=120,40` while `data/tiles/earth/` is absent:
`console error: Failed to load resource: the server responded with a status of 404 (Not Found)`.
The render-core lab works around it by passing synthetic albedo maps to the LabPlanet by default
(`labs/render-core/main.ts`); other labs can do the same with
`createLabPlanetFeature({ defaultMap: 'none' })` or `maps: { earth: 'none' }` until the bakes are in.

## Requested change
Serve a generated listing `GET /tiles/index.json` -> `{ "tilesets": string[] }` (the directories under
`data/tiles` that contain a `manifest.json`), like `/defs/index.json`, and copy it into the production
build. The LabPlanet (and the terrain package) can then skip tile sets that are not there without a
failed request. Nothing else changes.
