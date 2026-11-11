Status: open
From: map-view
Owner path: labs/integration/** (core-support) and the app shell's map mode (src/app/main.ts, whoever wires the views)
Blocking: no   (round-1 photo critic of the map view, `out/qa/wave2/map-view.r1.photo.json`, major finding 3; a workaround inside map-view's own spec exists)

## Problem
The map view has never been shown by the app or the integration lab: `createMapView` is mounted only by
`labs/map-view` and by map-view's own `tests/browser/map-view/real-planet.spec.ts`, and the flight HUD's own
"map" picture (`out/screens/flight-ui/map-lowOrbit-720p.png`) shows the HUD over a planet with no trajectory
overlay. Map labels, the gizmo, the node panel and tooltips keep clear of other UI only when that UI's
rectangles are passed to `MapViewApi.setObstacles`, which nothing outside map-view's paths does.

## Evidence
- `out/screens/map-view/real-hud-lowOrbit-node-720p.png`, `real-hud-translunar.png`, `real-hud-lunarOrbit.png`,
  `real-hud-lowOrbit-node-4k.png`: map-view's spec composes the frame itself (integration lab + `createMapView`
  + `createHud` from `src/ui`, HUD panel rectangles handed to `setObstacles` every 10 frames, node panel
  asserted clear of every HUD panel). That is the workaround; the app does none of it.
- `grep -rn createMapView src labs` finds only `src/map` and `labs/map-view`.

## Requested change
In the integration lab (and the app shell when its map mode is wired), while the camera kind is `map`:
1. `const { view, feature } = createMapView(gpu, defs, { uiRoot: <the HUD container> })`, `renderer.addFeature(feature)`
   once; `view.setActive(cameraKind === 'map')` on every view switch; `view.update(lastSnapshot, lastCamera,
   sim.commands, input.pointer, cssSize)` BEFORE the flight controller and camera rig (frame order: hand-off
   `docs/handoff/map-view.md`, "Integration"); a `focus` result moves the map camera; `consumed` keeps the
   pointer from the camera.
2. `view.setObstacles(rects)` whenever the HUD layout changes (CSS px of the canvas, `{x, y, width, height}`):
   the boxes of `.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more,
   .hud .nbchips > div, .hud .toast` and the navball `.hud .ball` (the selectors of flight-ui's own coverage
   check). `mountHud` in `tests/browser/map-view/real-planet.spec.ts` is a working reference.
3. Not to change: the HUD's MANEUVER panel shows the burn EXECUTION figures and the map's node panel EDITS the
   node (hand-off, "Integration"); no duplication needs removing.
4. For flight-ui to decide (src/ui/format.ts `formatLength`): now that HUD and map share a frame, the HUD
   writes "180.0 Mm" where the map writes "180 000 km" (`out/screens/map-view/real-hud-translunar.png`). The
   map uses grouped km (asked for by its round-0 visual list); the same unit in both would read better.
