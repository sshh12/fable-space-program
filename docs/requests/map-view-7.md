Status: resolved (commit ecc9238)
From: map-view
Owner path: src/core/fakes/fakeSim.ts (core-support), labs/integration/** (core-support)
Blocking: no   (round-4 photo critic of the map view, `out/qa/wave2/map-view.r4.photo.json` finding 10, minor)

## Problem
The FakeSim names the active vessel "Fake vessel" (`src/core/fakes/fakeSim.ts`, the `VesselSnapshot` built in
`snapshot()`, `name: 'Fake vessel'`). Every acceptance picture of the map view over the real renderer shows that
name as the most prominent label of the frame, next to the finished flight HUD, where it reads as placeholder
text. The synthetic scene already calls its craft "Kestrel".

## Evidence
- `out/screens/map-view/real-hud-lowOrbit-node-720p.png` ("Fake vessel" at about (766,552)),
  `real-hud-translunar.png` (about (375,355)), `real-hud-lunarOrbit.png` (about (866,307)), and every
  `real-lowOrbit*` / `real-lunarOrbit` / `real-translunar` picture (written by
  `tests/browser/map-view/real-planet.spec.ts`, which mounts the map into the integration lab's own FakeSim).
- Workaround inside map-view's paths: `labs/map-view/main.ts` shows the FakeSim's active vessel as "Kestrel"
  (it wraps the snapshot it hands to the map). The integration lab's snapshot cannot be renamed from map-view's
  spec without touching `labs/integration`.

## Requested change
1. `FakeSimOptions.vesselName?: string`: the name of the active vessel in the snapshot (default: unchanged, so no
   other package's picture or test moves unless it asks).
2. In `labs/integration`, pass a mission-like name (for example the scenario's craft name, or "Kestrel" as the
   synthetic map scene uses) when the integration lab builds its FakeSim, so pictures of the composed frame do not
   show "Fake vessel".
Not to change: the vessel id (`fake-vessel`), which tests look up.

## Resolution

Done (`ecc9238`): `FakeSimOptions.vesselName?: string` (default 'Fake vessel', so nothing else moves; the id stays
`fake-vessel`), and the integration lab names the vessel after its vehicle definition, as the real
simulation does (`src/sim/vessel/assemble.ts` gives a vessel its vehicle's `name`): "Meridian / Heron / Kestrel
lunar stack" for the mission vehicle. `src/core/fakes/fakeSim.test.ts` holds the option. Re-shoot your
`real-*` pictures.
