Status: open
From: app-integration-v1
Owner path: src/render/terrain (feature.ts, streamer.ts; terrain-render), src/render/core (shader library, mesh system; shared-code maintainer), src/render/atmosphere (feature.ts; atmosphere-clouds)
Blocking: no   (the loading screen shows what each subsystem exposes today; this asks for the numbers it lacks)

## Problem
The app's loading screen (`src/app/loading.ts`, docs/handoff/app-integration-v1.md "Loading") shows what is loading
and how far along it is from real counts only. Three subsystems expose less than a player needs to see:
- terrain: the stream counters (`TerrainDebug.stats().stream`: ready, queued, loading, uploading) and the deepest
  READY tile under a point (`readyTileAt`) are exposed, but not what the view WANTS: the screen can say "level 14
  under the vehicle, 1,180 tiles resident, 212 pending" but not "level 14 of 19", and its bar's total (resident +
  pending) grows while the selection refines, so the bar can move backwards.
- render core: `CoreShaderLibrary.pendingCompilations()` is a count without a total, and `MeshSystem.isIdle()` a
  boolean: the "Render pipelines" row counts features initialised (10 of 10) and then only "N shader modules
  compiling"; the "Vehicle and site models" row shows its phase with no count at all.
- atmosphere: `isIdle()` only (tables ready, cloud noise ready, coverage maps loaded): phase with no count.

## Evidence
`tests/browser/app/app.spec.ts`, "the loading screen shows real progress ...": the pictures
`out/screens/app/loading-2-pipelines.png`, `loading-3-terrain.png`, `loading-4-view.png` (rows "Vehicle and site
models" and "Atmosphere and clouds" without a count; the terrain row's total changing between samples in the
spec's log).

## Requested change (all additive, read-only, cheap enough to call every frame)
terrain-render:
1. `TerrainDebug.residency(bodyId: string): { wantedLevel: number; residentLevel: number; wanted: number[]; resident: number[] } | null`
   for the latest camera selection of that body: per level 0..maxRenderLevel, how many tiles the selection wants
   drawn (`wanted[l]`) and how many of those are READY (`resident[l]`); `wantedLevel` / `residentLevel` = the
   deepest level wanted / fully resident. With it the row reads "level 14 of 19" with one cell per level, and the
   reveal condition can be stated as `resident[l] === wanted[l]` for every level instead of `isIdle()`.
2. A tile that cannot get a pool layer is dropped from the wanted set instead of waiting in `uploading` for ever
   (the third option of request app-integration-7): today the app has to recognise the full pool itself
   (`queued === 0 && loading === 0 && uploading > 0`, nothing uploaded and every waiting tile refused in the
   frame) to let the loading screen go at 1440p.
render core (shared-code maintainer):
3. `CoreShaderLibrary.compilations(): { pending: number; total: number }` (modules created so far and still
   compiling), and `MeshSystem.loads(): { pending: number; total: number }` (texture loads started / outstanding).
atmosphere-clouds:
4. `AtmosphereFeature.status(): { tablesReady: boolean; noiseReady: boolean; coverage: { loaded: number; total: number } }`.

Must not change: `isIdle()` of any of them (the harness's `waitIdle` and the app's reveal condition use it).
