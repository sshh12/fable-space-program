# Hand-off: app integration v1

`src/app` wires the ORIGINAL game: one page (`index.html` -> `src/app/main.ts`) with the real simulation
(`createSim(defs, scenarioId, { terrain })`), every render feature, the HUD with the navball, the map view, the
three camera rigs and the view manager, the flight controller, the cockpit display keys, audio, pause, time warp
through the controls, the beforeunload guard, the scripted test pilot inside the page and `window.__test`.
Every subsystem is attached through its contract or its documented public factory; nothing reaches into a
package's internals and nothing writes simulation state.

**State (2026-11-11 evening):** done and verified in real Chrome: a player can open `/`, see the vehicle on the
real pad under the real sky, fly it with the keyboard (throttle, staging, SAS, views, map, warp, pause), and the
test pilot flies through the same controls inside the page (`/?pilot=1`). The Playwright `mission` project flew
lunar-direct from the pad to splashdown in real Chrome in 44.9 minutes. Every milestone gate was met: touchdown
1.94 m from the target on level 12, splashdown inside the Central Pacific zone at 7.82 m/s, `cheatCounter` 0, no
error. The frame-time budgets are missed: GPU p99 is met everywhere (worst 8.4 ms); rAF is missed in every phase
because of the headless clock (`app-integration-8`); the main thread is missed in 24 of 80 phases (renderer hooks).
See "Browser mission". Fourteen requests filed; open: -11 in part, -13.

**Phase 1 of the re-flight (2026-11-12 afternoon): code, unit tests and specs, NOT yet run in a browser** (the
GPU was with the visual fix rounds): `await renderer.warm()` before the loop, `window.__test.renderExact`, the
atmosphere's loading row, the Home and V keys, picture stops and the mission's new pictures, the feature
wrapper built from the contract (request core-5). What a browser has to confirm is listed under "Known limits".

**Added 2026-11-11 night (after the user's feedback):** an honest loading screen (the scene opens when the view
at the start position is final: 32 s on the pad, land where land is in the first frame); keyboard capture and
fullscreen are opt-in; the main-thread misses are attributed per feature and per hook with the app's own
per-frame timers (during burns: the cockpit's ORB display painted in the chase view; near the ground: the
terrain's prepare; at lift-off: one frame of cockpit + sim); requests 9-13. The browser mission was not re-flown
in this round. See "Loading", "Measured" and "Requests filed".

## API of src/app

| File | What |
|---|---|
| `main.ts` | Entry: `installTestApi` and the loading screen first (`window.__boot()` = its report), `acquireGpu`, `loadDefs` (through a counting `DefSource`), scenario choice, `createGame`, `installGameTestHooks`; `window.__test.ready` three presented frames after the loading screen has gone (false, with the error in `errors` and the `#fatal` box shown, when boot fails) |
| `loading.ts` | `createLoadingScreen(container): LoadingScreen`: the ten steps (`LOAD_STEPS`) with `begin` / `update` / `finish` / `watch(id, read)`, `reveal(record)` + `frame(now)` (the 450 ms fade, driven by the frame loop), `abort()`, `report(): LoadingReport` (steps with counts and times, the `RevealRecord`), `revealed: Promise<void>`. See "Loading" |
| `featureTiming.ts` | `timedFeature(feature, sink): RenderFeature`: stands in for a feature at the contract and books the main-thread time of each frame hook (the per-feature attribution; the wrapped feature is untouched). Built from `MEMBERS`, a table typed by the keys of `RenderFeature & TemporalFeature`: values (`id`, `order`, `quality`, `requires`) are read through, `init` / `isIdle` / `dispose` / `resetTemporal` forwarded, the ten frame hooks forwarded and timed; a member the feature lacks is absent; a member added to the contract does not compile until it is listed (request core-5) |
| `pictureStops.ts` | `createPictureStops(): PictureStops` (`set(stops)`, `check(snapshot)`, `fired()`, `pending()`); `PictureStop = { id, trigger, seconds?, after? }` with triggers `{ milestone }`, `{ event, active?, match?, occurrence? }`, `{ radarBelow, bodyId? }`, `{ peak, floor, drop }`. See "Picture stops" |
| `framing.ts` | `projectToFrame(viewSpacePoint, tanX, tanY)`, `discInFrame(viewSpaceDirection, angularRadius, tanX, tanY)`: where a point or a body's disc falls in the frame (the specs' "the Earth is in the picture" and "land where land is") |
| `seat.ts` | `seatName(defs, vessel, seatId)`: the cockpit layout's label of a seat (`visuals/cockpits/<id>.couches.seats[seat].label`, none in the data today), else the crew member `VehicleDef.crew` puts there, else the id |
| `settings.ts` | `readSettings(query): AppSettings`; `isMissionScenario(s)`; `defaultScenario(defs)` (first scenario in id order that is a mission proof: pad start, nothing fired, milestone rules, i.e. `lunar-direct` today, chosen by the data: no id in code); `resolveScenario(defs, requested)` (unknown id: error naming the defined ones) |
| `game.ts` | `createGame(deps: GameDeps): Promise<Game>`: builds and owns every subsystem and runs the frame loop. `Game` exposes the subsystems plus `snapshot()`, `camera()`, `paused` / `setPaused`, `setDeterministic`, `setTestControls`, `setView`, `setCameraOrbit`, `chase` (the chase rig: `resetView()`, `offsets`, `autoAzimuth`), `frames`, `loading`, `revealed`, `loadingReport()`, `toggleKeyboardCapture()`, `inFlight()`, `stop()`; `SETTLE_FRAMES = 12` |
| `features.ts` | `createGameFeatures(deps: FeatureDeps): GameFeatures`: every RenderFeature through its factory, in registration order, with the cockpit's `CockpitControls`, the map's `MapViewApi` and `packageOf`; `MILKY_WAY_FACE_SIZE = 2048` |
| `pilot.ts` | `createPilotDriver(defs, sim): PilotDriver` (`engaged`, `pilot`, `start()`, `stop()`, `onControlTick`, `afterFrame()`): the mission pilot of `src/pilot` in `Sim.advance`'s control ticks |
| `statusLine.ts` | the shell's own line, centred under the HUD's top column: PAUSED (amber), and "TEST PILOT · <phase>" while the pilot flies (not with `?pilotlabel=0`); hidden with the HUD |
| `timing.ts` | main-thread time of the frame function, of its stages (input, map, controls, sim, views, hud, audio, render) and of every render feature's hooks (rolling 300 frames; `core` = the render stage minus the hooks); the 12 slowest frames since the last reset with their whole breakdown (`slowest()`); a trace of consecutive frames (`startTrace` / `takeTrace`) |
| `testHooks.ts` | `installGameTestHooks(testApi, game)`: `window.__test` (TestApi) and `window.__app` (`AppDebug`, `AppBrief`) |

Query parameters (all optional): `scenario=<id>`, `pilot=1` (the test pilot starts when the loading screen has
gone), `view=chase|cockpit|map`, `capture=1` (ask for fullscreen + keyboard lock on the first key press or click;
the default is windowed and uncaptured), `pilotlabel=0` (no "TEST PILOT" line) and `capturepill=0` (no capture
control in the HUD) for clean footage, `perf=features` (render-core attribution mode), `scale=<0.25..1>` (pinned
render scale), `governor=off`, `hud=0`, `mute=1`. None of them touches physics; the scenario is recorded in
`SimSnapshot.scenario` (only a pad start with nothing fired and `cheatCounter` 0 is a mission proof).

### Boot

`acquireGpu` -> `loadDefs('/defs')` -> scenario -> `createTerrainProvider(defs, createFetchTileSource('/tiles'))`
-> `createSim` -> `createRenderer(canvas, gpu, defs, { onError, perfFeatures, quality, governor })`, resized to
the canvas's CSS size times the device pixel ratio on every ResizeObserver change -> navball renderer published as
`'ui.navball'` -> input system, HUD (mounted in `#ui-root`), flight controller, status line -> view manager ->
features -> audio engine; then the features' start-up (one after the other, each behind its hook timer),
`audio.init(defs, '/assets/audio')` and `sim.ready` are awaited together; then the loop starts under the loading
screen. `ready` resolves when the screen has gone. The app builds the simulation with `createSim` (not
`createSession` of `src/session`: that move is the presentation sweep's). Between the features' start-up and
the first frame the app awaits `renderer.warm()` (NOTICE-core-5, request app-integration-11 part 1): every
pipeline the core and the features started ahead with `shaders.warm` exists before the first frame, so the wait
for them is counted on the loading screen's "Render pipelines" row instead of standing in frames that cannot be
presented; `window.__app.warmMs()` is how long it took. A pipeline that fails to build rejects there and the
boot fails with its error.

### Loading (user feedback 2026-11-11: "would be nice to show clear progress")

`index.html` paints "MERIDIAN / Loading the program" at once (static, the loading screen's look), so the page is
never black while the program's modules load. `createLoadingScreen` replaces it as soon as `main.ts` runs and stays
up, opaque, over the canvas and the HUD until the view at the start position is final. Ten rows; a row has a count
and a bar only where its subsystem exposes a real count, and nothing runs on a timer (the footer clock is the wall
clock since the page opened):

| Row | What it shows | Read from | Done when |
|---|---|---|---|
| Graphics device | the adapter's name | `acquireGpu` | the device exists |
| Definitions | files read / files listed | a counting `DefSource` around `fetchDefSource` | `loadDefs` returns |
| Simulation | phase only | `createTerrainProvider`, `createSim` | `sim.ready` (the ground under the vehicle for the physics) |
| Render pipelines | shader modules and pipelines compiled / created so far, and in words what is going on: the feature that is starting ("starting terrain (1 of 9)"), then "pipelines created ahead of the first frame" while `renderer.warm()` is awaited, then "first frames" | `renderer.addFeature` one by one; `renderer.warm()`; `coreOf(ctx).shaders.compilations()` (it counts pipelines being created ahead) | every feature added, `warm()` resolved and nothing compiling |
| Sky and stars | 3 parts: star catalogue, Milky Way cube (face size), light probe | `SkyFeature.status()`, `.probe().completed` | `sky.isIdle()` |
| Atmosphere and clouds | parts done / in all: the scattering tables (one flag), the cloud noise (one flag), each cloud coverage map; in words the part being worked on. What the feature does not expose: progress inside the tables or the noise. The ocean, the row's other feature, exposes nothing of its own (its one-off work is its pipelines, counted in the row above) | `AtmosphereFeature.status()`; `atmosphere.isIdle()`, `ocean.isIdle()` | both idle |
| Vehicle and site models | textures loaded / texture loads started | `coreOf(ctx).meshes.loads()`, `.isIdle()`, the vessel / site / cockpit features | all idle |
| Sound | assets decoded / total | `audio.probe()` | `audio.init` resolves |
| Terrain at the start | tiles of the view resident / tiles the view wants, "level R of W" (the deepest level complete / wanted), and what is queued, baking, uploading | `TerrainFeature.debug.residency(body of the active vessel)`, `.stats().stream` | `terrain.isIdle()` |
| First frames | consecutive frames with nothing pending / 12, or "waiting for <what>" | everything above + `renderer.exposureInfo()` | 12 in a row |

The frame loop runs under the screen from the moment every subsystem exists: streaming, the first use of every
pipeline, the probe and the exposure meter need real frames. Meanwhile the simulation is NOT advanced (it stays at
the scenario's first instant, so the launch window and the UT of a flight do not depend on the machine's loading
time), key presses are dropped (a Space pressed while waiting fires nothing), and the test pilot (`?pilot=1`) starts
with the first frame after the screen has gone.

**The view is final** (`viewPending()` in `game.ts` returns nothing) when: no shader module is compiling; the sky,
atmosphere, ocean, vessel, site, cockpit, effects and map features are idle and the mesh system has no texture
loading; the terrain feature is idle (nothing queued, baking, uploading or fading; rocks and ground cover built);
the simulation has no terrain load outstanding (`sim.terrainPending() === null`); and the exposure is within
0.25 EV of the meter's target, or no longer moving towards it faster than 0.3 EV/s (the renderer's slow dark
adaptation below EV -3 is the camera's behaviour, not loading; an exposure that stands still never holds the
screen). `SETTLE_FRAMES = 12` consecutive such frames start the fade (450 ms, driven by the
frame loop); the game begins with the first frame after it. While the screen is up the terrain's
upload budget is lifted to 64 tiles and 12 ms per frame (`TerrainDebug.setUploadBudget`; nobody sees those
frames) and put back to the streamer's own 8 tiles and 2 ms at the reveal. The first version of this screen also
recognised a full tile pool from the stream counters and let go with the parents drawn (the terrain never came to
rest at 1440p: request app-integration-7); since 189d1e2 the streamer gives such tiles up itself and that branch
is gone.

`window.__boot()` (from the first moment of the page) and `window.__app.loading()` return the `LoadingReport`:
every step with state, words, count, total and its start / end time, and the `RevealRecord` (frame, busy
features, the terrain's tiles wanted / resident, levels wanted / complete, stream counters and the level under
the vehicle, EV100 and its target, settled frames, start and end of the fade).
`window.__app.featureInitMs()` gives the start-up time of every feature.

### Frame (ARCHITECTURE 5)

```
realDt = clamp(now - last, 0, 0.1 s)                (1/60 s in deterministic mode); ctx.perf.cpuBegin('frame')
held = loading screen up (then: no key press counts, no controls, no sim.advance)
f = input.sample();  F2 -> hud.setVisible, ` -> key help, P -> pause
mapView.setActive(lastCamera.kind == 'map'); map = mapView.update(lastSnapshot, lastCamera, sim.commands, f.pointer, cssSize)
    every 10th frame in map view: mapView.setObstacles(HUD panel boxes)           (request map-view-5)
unless paused or the test pilot flies:
    sim.setControls(controller.update(f, lastSnapshot, sim.commands, realDt, { view: lastCamera.kind, pointerCaptured: map.consumed })
                    with the axes held through window.__test.setControls)
mfdCycle:i -> cockpitControls.cyclePage(i)
ui:resetCamera (Home, chase view) -> chase.resetView();  ui:nextSeat (V, cockpit view) -> cockpitRig.cycleSeat(), hud.notify('Seat: <name>', 'info')
unless paused or held at a picture stop: sim.advance(realDt, pilot engaged ? onControlTick : undefined)
    then pictureStops.check(snapshot): a stop that is due holds the simulation from the next frame on
snapshot = sim.snapshot()                            (pilot done / gave up: back to the keyboard, lever = applied throttle)
view = viewManager.update(snapshot, mapper.map(f, realDt, { pointerConsumed: map.consumed, focus: map.focus }), realDt, f.pressed)
hud.update(snapshot, view.camera, realDt)            (renders the navball texture)
audio.update({ snapshot, listener: view.listener, realDt, warpFactor: snapshot.warp.factor, paused })
renderer.render(snapshot, view.camera, view.observers, realDt)
ctx.perf.cpuEnd('frame')
while held: update the loading steps, count settled frames, start / advance the fade
window.__test frameDone
```

Rigs: chase (`createChaseRig({ defs, terrain })`), cockpit (`createCockpitRig({ defs })`), map
(`createMapRig({ defs })`), in that order (C cycles chase and cockpit, M toggles the map); the view manager gets
the terrain for the LOD observers. Exposure: the rigs' own settings (compensation 0; the map rig's 0.005 fill
light and EV100 floor 9); nothing was changed in the app after looking at the pictures (see "Pictures"). A
frame that throws stops the loop, is reported to `window.__test.errors` and shows the `#fatal` box (the loading
screen is taken away). Audio is resumed on every keydown and pointerdown (capture phase). Keyboard capture is
opt-in: the page starts windowed and uncaptured and every binding works so; the HUD's switch
("Keyboard capture OFF / ON / NO LOCK") asks for fullscreen + keyboard lock on a click and leaves on the second
(`input.requestKeyboardCapture()` / `releaseKeyboardCapture()`, request flight-ui-7); `?capture=1` asks on the
first key press or click instead. The beforeunload guard (`installUnloadGuard`) asks
while `inFlight()`: the mission has not failed and (a stage has fired or the scenario did not start on a pad).
A failed mission offers "Revert to launch" (pad scenarios; "Restart scenario" otherwise) on the HUD banner: a page
reload, i.e. a fresh simulation.

### Picture stops (the mission's pictures)

A spec hands the game a list of moments as data (`window.__app.setPictureStops(stops)`); the frame loop checks
it against every new snapshot, and in the frame a moment is reached it holds the simulation (no `advance`; the
picture, the HUD and the sound go on; no PAUSED line) until the spec has taken its pictures and calls
`resumeFromPictureStop()`. `pictureStop()` is the stop held now, with the time of the frame and of its trigger.
Triggers: a milestone record; an event of `SimSnapshot.events` (optionally of the active vessel only, with
fields that must match, the n-th occurrence); the active vessel below a radar altitude and coming down
(optionally at a named body); a read-out (`heatFlux`, `gLoad`, `dynamicPressure`) just past its peak, once it
has reached a floor. `seconds` = simulation time after the trigger; `after` = a milestone that must be on record
first. A stop is exact to the frame (at 4x physics warp a frame is 67 ms of flight). Nothing is written to the
simulation, and the pilot acts in the simulation's control ticks, which stand still with it: a flight with
stops is the same flight.

The mission spec sets 36 stops (17 milestones and 19 added moments; all 36 fired in the flight of 2026-11-12): every milestone (the cockpit as well at EARTH_ORBIT and LUNAR_TOUCHDOWN), and
- staging: 0.5 s and 2 s after STAGE_SEP_1, FAIRING_JETTISON and STAGE_SEP_2;
- lunar descent: 30 m, 10 m and 3 m of radar altitude at the Moon, the first `'touchdown'` on land of the active
  vessel and one second after it;
- reentry: just past the peak of the heat flux (3 % below it, above 1 MW/m^2), chase and cockpit, and just past
  the peak of the load (5 % below it, above 3 g);
- chutes: 3 s after DROGUE_DEPLOY, 8 s after MAIN_DEPLOY;
- the splash: 0.2, 1, 3 and 10 s after the `'splash'` event of the capsule itself.
Files: `out/screens/mission/<nn>-<milestone>[-<what>]-<view>.png`, e.g. `17-splashdown-splash-plus-0.2s-chase.png`,
`14-entry-interface-peak-heating-cockpit.png`, `10-lunar-touchdown-descent-10m-chase.png`.

### Frame-exact capture (`window.__test.renderExact`, request lead-3)

`renderExact(frames)` calls `renderer.renderExact(frames, () => frame(now))`: the render core restarts its
temporal sequences (and every feature's `resetTemporal`, which the feature wrapper forwards), renders exactly
`frames` of the game's own frames at the fixed 1/60 s step in one task and holds the last. While the core holds
(`renderer.holding`) the game's loop renders nothing and only counts the display's frames. Precondition, as the
contract says: `setDeterministic(true)` and `setPaused(true)` (the core refuses without deterministic mode; the
app refuses while the loading screen is up). `setDeterministic(false)` ends the hold.
`window.__app.exactInfo()` passes on the core's record of the last capture (who was busy before and after its
frames, how many meterings the lead-in took).

In the browser (2026-11-12 14:57, the pad, 1280 x 720, no HUD): `renderExact(8)` renders 8 frames and holds (no
game frame and no simulation time in 40 display frames); two captures of 64 frames through the harness's
`captureDeterministic`, the hold and 40 display frames between them, are the same picture to the bit (largest
difference 0 of 255; one metering, nobody busy before, after or in the lead-in). The spec asserts it; if it ever
fails it prints the difference per cell of a 4 x 4 grid and saves it as `out/screens/app/exact-pad-difference.png`.

### Render features (registration order)

| Package | Factory call | Notes |
|---|---|---|
| terrain-render | `createTerrainFeature(ctx, () => terrain)` | the same `TerrainAuthority` the sim uses |
| vehicle-pad | `createVesselVisualFeature({ exteriorGlass: false })` | the cockpit's glazing shows the interior from outside (cockpit-8) |
| vehicle-pad | `createSiteFeature()` | pad plane at `location.padElevation` (the site is flattened) |
| ocean | `createOceanFeature()` | |
| sky-lighting | `createSkyFeature({ milkyWayFaceSize: 2048 })` | lead decision: the full Milky Way cube (sky-lighting-2) |
| atmosphere-clouds | `createAtmosphereFeature()` | |
| vfx | `createVfxFeature(ctx)` | registered before the cockpit (plumes before cockpit glass) |
| cockpit | `createCockpitFeature(ctx, { navball, mfdPainter })` | returns the `CockpitControls` the `mfdCycle:*` keys drive |
| map-view | `createMapView(gpu, defs, { uiRoot: #ui-root })` | overlay feature `map` (order 100); node panel in the HUD container |

Hook order reported by the core: terrain vehicle site ocean sky atmosphere vfx cockpit map. The navball renderer
is created by the app (`createNavballRenderer(gpu, { perf: ctx.perf })`), published as `'ui.navball'` before the
features start, and rendered by the HUD every update.

### window.__test (src/core/contracts/testApi.ts)

`page` `{ kind: 'app', name: 'main', scenarioId }`; `state()` (structured clone of the presented snapshot: costly,
poll `window.__app.brief()` instead); `milestones()`; `isIdle()` (renderer); `perf()` / `resetPerf()` (renderer
PerfSnapshot, `cpu` = the whole frame function; also resets the app's stage windows); `setControls(partial)`
(throttle moves the lever; pitch / yaw / roll / translate are held like keys until changed); `commands`
(= `sim.commands`, what the keys call); `pilot` `{ start, stop, phase, done, failure }` (always present; `start()`
makes a fresh mission pilot that begins in the phase that fits the state it finds; `stop()` hands the controls back
with the lever at the applied throttle); `setView(mode)`; `camera()`; `setCameraOrbit(yaw, pitch, distance)` (chase /
map rig); `setDeterministic(on)`; `setPaused(p)`; `hdrStats()`; `audio()` (AudioProbe); `map()` (MapElementInfo
of the map view). Nothing reaches `Sim.debug`.

What the Playwright mission (ARCHITECTURE 18.2) uses: open `/?pilot=1` (or call `pilot.start()`), poll
`window.__app.brief().milestones` / `window.__test.milestones()`, `pilot.done()` / `failure()`, `state()` for the
gates (`cheatCounter`, `scenario`, `mission`, `terrain.incompleteQueries`), `setView` + screenshots at milestones,
`perf()` under the GPU lock, `audio()`; real key presses for the binding segments (they act whenever the pilot is
stopped).

### window.__app (AppDebug, for the app's specs)

`features()`, `featureOrder()`, `cpu()` / `resetCpu()` (frame, stages and now `features`: every render feature's
hooks per frame, `core` = the render stage minus the hooks), `cpuSlowest()` (the 12 slowest frames since the last
reset with stages, features, hooks and a note of throttle / thrust / warp / altitude), `startCpuTrace(n)` /
`takeCpuTrace()` (consecutive frames: total, render, sim, hud, audio and every feature), `loading()`,
`featureInitMs()`, `terrainResidency()`, `renderLoads()` (shader modules and texture loads: pending / total),
`chaseFraming()` (the chase rig's default-or-not, pitch offset, zoom factor, roll, distance),
`bodiesInFrame()` (bodies whose disc reaches into the presented frame, with their place in it), `seat()` (the
cockpit rig's seat), `groundSamples(distances, bearings)` (points of the ground on rings around the vessel: land
or water by the height authority, height above the sea, and where each falls in the frame), `warmMs()`,
`exactInfo()` (the core's record of the last frame-exact capture),
`setPictureStops(stops)` / `pictureStop()` / `resumeFromPictureStop()` / `pictureStopsFired()`,
`exposure()`, `viewMode()`, `viewBlending()`, `hudVisible()`, `keyboardLocked()`,
`toggleKeyboardCapture()`, `heldCodes()`, `paused()`, `frames()`, `lever()`, `simStats()`, `inFlight()`,
`notifications()`, `pilotReport()`, `mfdPages()`, `mfdPaintStats(reset?)` (the cockpit displays' paints and their
Canvas 2D / upload / mip time), `cockpitFrame()`, `brief()` (a few numbers of the latest snapshot, cheap to
poll; with the navball's `pitchDeg` and `rollDeg`), `frameLights()` (local lights of the last frame), `busyFeatures()` (what `isIdle()` waits for),
`terrainStats()` (the terrain's stream counters, selection and per-frame CPU).

## How to run

```
npm run dev                         # then open http://127.0.0.1:<port>/ (baked tiles under data/tiles, sky under data/sky)
/?pilot=1                           # watch the test pilot fly the mission (about 45 minutes)
npm run typecheck:paths -- src/app tests/browser/app
npx vitest run tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app --project=functional --project=perf   # both in one slot, about 11 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.spec.ts --project=functional   # about 7 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.perf.spec.ts --project=perf     # about 4 min
```

Footage: `tools/footage/record.mjs` opens `/?scenario=lunar-direct&view=chase&scale=1&governor=off&pilotlabel=0&capturepill=0`
(no "TEST PILOT" line, no capture switch; `capture=0` is gone: nothing is captured unless `capture=1`).

Specs (`tests/browser/app/app.spec.ts`, nine tests):
- the loading screen: polled from the first moment of the page (`window.__boot()`); it covers the page, opaque,
  in every sample; the simulation's UT does not move under it; its terrain row equals the terrain's residency of the view and
  its sound row the audio engine's count in the same instant (likewise the shader-module and texture counts); no
  count runs past its total; every step finishes; the frame loop's reveal record has no busy feature, nothing
  queued, baking or uploading, every tile the view wants resident down to the deepest level it wants, 12 settled
  frames, the exposure at its target, the ground under the vehicle at level 12 or deeper; the first revealed frame has under
  10 % sea-coloured pixels in the band between the horizon and the site (0.7 % measured; the same band was open
  sea for 40 s after boot before) and differs from the frame ten seconds later by less than 6 of 255 on average
  (1.6 measured); pictures of the screen at four stages;
- the loading screen lets go in a dark cabin start on the Moon and in a deep-space coast;
- boots on the pad with every feature, the real sim and no error;
- keyboard (throttle Z / X / Shift, SAS T and 1, Tab, 9, C, M, `.` and `/`, P, F2);
- a short real flight (Z, T, Space, lift-off, climb to 4 km with pictures in every view, engines heard);
- the scripted test pilot inside the page (from the pad through the launch window to 2 km, then stopped; the
  status line names it);
- frame-exact capture at the pad: `renderExact(8)` holds frame 8; the harness's `captureDeterministic` takes a
  64-frame capture; while the core holds, the game renders no frame of its own and the picture on screen does not
  change; a second capture's distance from the first is logged (not asserted: request core-4); leaving
  deterministic mode lets the game run again;
- in low orbit (`qa-leo`): the Earth is in the default chase frame; the arrows turn the camera and Home brings
  the default back; in the cockpit V steps through the couches with a toast naming each and wraps round, and does
  nothing in the chase view; then the map takes the pointer, a click on the apoapsis marker adds a node, a 100 px
  Shift-drag on the prograde handle changes it by 1.0 m/s and the throttle lever stays at 0 (ARCHITECTURE 11 and
  18.2; the interrupted agent's test, finished: the map camera is turned until the marker is on the near side of
  the Earth);
- keyboard capture is opt-in: keys and clicks on the scene capture nothing; a click on the HUD switch gives
  fullscreen and the lock, a second click leaves both; `?capture=1` asks on the first key; `capturepill=0` and
  `pilotlabel=0` hide the switch and the pilot's label (PAUSED still shows).

`app.perf.spec.ts`: pad and climb at 1440p internal (budget assertions, soft) and at 720p (recorded), each with
the slowest frames' breakdown, a trace across ignition and lift-off and the terrain feature's own split; an
engine burn in lunar orbit (coast, start, burn, the same burn with no display on the orbit page, cut-off) with the
cockpit displays' paint split.

## What a human sees when pressing each key

| Key | What happens (verified in the specs unless marked) |
|---|---|
| (first key or click) | sound starts (the AudioContext resumes); nothing is captured: the page stays windowed and every key below works |
| click on "Keyboard capture" (HUD, top right) | OFF -> ON: fullscreen and the keyboard lock (browser shortcuts such as Ctrl+W then reach the game; "NO LOCK" if the browser refuses the lock); a second click or Esc leaves both |
| Z / X | throttle lever to 100 % / 0 % (the HUD's throttle tape follows) |
| Shift / F | lever up / down at 0.5 per second (Left Ctrl too while the keyboard is captured: the only binding that needs it) |
| Space | fires the next stage: on the pad the engines light, the clamps let go, lift-off (plume, smoke, rumble); the stage leaves the HUD's stack |
| Backspace | abort sequence (not exercised by the specs) |
| T | SAS on / off (HUD SAS button lit, "HOLD · STABILITY") |
| 1-8 | SAS hold mode stability, prograde, retrograde, normal, anti-normal, radial out, radial in, maneuver (switches SAS on; a mode not available is refused with a toast) |
| R, G, U, Caps Lock | RCS, landing gear, lights, fine control (not exercised by the specs; controller unit-tested by flight-ui) |
| W/S, A/D, Q/E | pitch, yaw, roll; I/K, J/L, H/N translation with RCS |
| Tab | navball surface / orbit mode (the speed readout's label and the chase camera's reference follow) |
| C | chase <-> cockpit, blended over 0.6 s (the eye flies into the seat) |
| M | map view (blended out to the whole Earth with trajectories, markers, the site, recovery zones); M again returns to the last flight view |
| `.` `,` `/` | time warp up, down, back to real time (refusals as a toast, e.g. "Cannot warp on rails while under acceleration") |
| P | pause: simulation time stops, the picture keeps rendering, camera keys and views still work, PAUSED shown |
| F2 | HUD hidden / shown |
| 9, 0, - | page of the left, centre, right cockpit display (FLT, ORB, SYS, STG, ENT, LND) |
| arrows, PgUp/PgDn, mouse drag, wheel | orbit / look and zoom the camera. The chase view's default framing (the nearest body in the frame, the distance by the vessel's size) is kept until the player turns the camera |
| Home | in the chase view: back to the default framing in a 1.5 s swing (`ui:resetCamera`, request app-integration-14) |
| V | in the cockpit view: the next couch of the cabin, wrapping round; a HUD toast names the seat (`ui:nextSeat`, request core-6). The view starts in the cockpit layout's default seat (the pilot's centre couch) |
| [ / ] | switch between controllable vessels in the bubble (not exercised: none at the pad) |
| ` | key-help sheet generated from the binding table |

## Measured

### 2026-11-12 14:49: phase 2, first half: the phase-1 boot path and test facilities in a browser (quiet machine)

One run of `tests/browser/app` (functional + perf, 12 tests, 12.7 min in the slot, 14:49-15:02), alone on the GPU
and with no bake or CPU job in the gate's slots: functional 8 of 9, perf 3 of 3. The one failure was the loading
test's land statistic, not the boot (below); the test was changed and re-run alone (15:57, 40 s in the slot: passes; and once more at 16:07 after the sea points' projection was corrected: passes).

What only a browser could settle:

| Item | Result |
|---|---|
| Boot with `await renderer.warm()` | works: `warm()` resolves after 2.0 s (`warmMs()`); 33.1 s to the revealed view in the functional test, 34.0 s at 1440p in the perf test (28.4 s on the quiet night of 2026-11-11, before the terrain's and the site's content of 2026-11-12). The first frames do NOT come at once: frame 1 is drawn right after `warm()` (12.9-14.7 s after the page opened) with 144-147 of 155 shader modules and pipelines done and the atmosphere at 2 of 3, and frame 16-19 only 6.4-8.0 s later (three runs: 6.4, 7.3, 8.0 s); from there on frames come at 60 Hz. The main thread is not what waits: the app's frame function ran for less than 1 s in those frames (the slowest: frame 0 with 190-409 ms and one of 130 ms, all `terrain.prepare`), and a screenshot asked for at frame 1 comes back with frame 16-19. That is the GPU process working off the packages' pipelines (8-11 modules are begun in frame 1, none of them through `shaders.warm`) and the atmosphere's last part: request -11, part 1, the packages' halves. Before `warm()` the same span was 14 s (2026-11-11). After it the terrain streams for 9-11 s (440 tiles wanted, level 20), which is the larger half of what is left |
| Atmosphere row | "Atmosphere and clouds: scattering tables, cloud noise, coverage maps, 3 / 3", from 14.7 to 21.1 s; equal to `AtmosphereFeature.status()` in every sample (asserted) |
| Land where land is | the picture `loading-revealed-first.png` shows land at every land point and the real sea beyond the coast. The statistic did not agree: 4 of 25 land points read as water (limit 15 %), all on dark ground in shadow, where a luminance step of 2 of 255 is no measure of smoothness. It now takes the step relative to the pixel's luminance (4 %): on the same picture land 0.00-0.06, the open sea 0.37-0.54; 0 of 25 land points in both re-runs. `groundSamples` against the picture (`loading-revealed-first-land-points.png`, every point drawn on the frame): the 25 land points lie on the lava plain and scrub in five rings around the stack, the coast runs between the 800 m and the 1200 m ring at bearings 60-105 degrees as the height authority says. One error found by looking: sea points were projected at the sea BED (2-242 m down within 1.8 km), so three of them fell on the land in front; they are now projected at the water's surface and lie in the sea. Limit of the statistic: today's near-shore sea, with its waves resolved, reads 0.08-0.16 at those sea points (0 of 8 as water): the check tells land from a flat sea, the look of the failure of 2026-11-11, not from every sea. A firm check needs what was drawn at a pixel (terrain or water) from the renderer; not asked for |
| `renderExact` in the app | 8 frames rendered and held; two captures of 64 frames identical to the bit (see "Frame-exact capture"); now asserted |
| Picture stops in a flight | the short flight holds at the stage event (T+0, throttle 100 %, thrust not yet on the plume: the frame of the event's own tick), at the lift-off milestone and one second after it (the launch cloud around the pad); the simulation time stands at each (asserted), a stop that never fires stays pending; pictures `stop-stage-fired.png`, `stop-liftoff.png`, `stop-liftoff-plus-1s.png` |
| Home key | after ArrowUp / ArrowLeft the chase rig reports a framing of its own; Home puts it back to the default (asserted; `leo-chase.png` and `leo-chase-reset.png` are the same framing) |
| V key | in the cockpit: plt -> ms -> cdr -> plt, a toast per seat ("Seat: Noor Valkonen"); nothing in the chase view (asserted) |
| Heads-down for the cockpit picture | the low-orbit test switches SAS on (T), holds E until the navball's roll reads beyond 168 degrees, lets go and waits until SAS has taken the rate out: roll 0.0 -> 174.6 degrees, pitch 2.2 degrees, in about 27 s of flight with the scenario's RCS on. `leo-cockpit.png` then has the Earth's clouds in both forward windows (EV100 5.53 against a target of 5.54). `data/defs/scenarios/qa-leo.json` is untouched |

Frame time, 2560 x 1440, render scale 1, governor off (median of three windows of 240 frames; harness clock
60.00 Hz, so the rAF lines are judged):

| Situation | GPU p50 / p99 ms | rAF p99 / max ms | main thread p50 / p99 ms | largest features on the main thread, p99 ms |
|---|---|---|---|---|
| pad | 5.52 / 6.06 | 17.03 / 21.1 | 2.77 / 4.63 | terrain 1.72, vehicle 0.60, site 0.50, core 0.48 |
| climb (to 1 km) | 5.77 / 6.26 | 17.17 / 19.3 | 3.28 / 5.41 | terrain 2.01, vehicle 0.57, core 0.47, vfx 0.41 |
| lunar orbit, coast | 0.96 / 1.18 | 17.11 / 17.7 | 1.17 / 2.38 | terrain 0.68, core 0.50 |
| lunar orbit, burn | 1.13 / 1.34 | 17.09 / 20.0 | 1.29 / 2.22 | terrain 0.53, core 0.44, vehicle 0.30 |
| pad, 1280 x 720 | 2.67 / 3.15 | 17.09 / 17.4 | 2.27 / 3.73 | terrain 0.96, vehicle 0.54 |
| climb, 1280 x 720 | 2.87 / 3.41 | 17.37 / 19.7 | 2.98 / 4.57 | terrain 1.43, vehicle 0.57 |

Ignition and lift-off at 1440p, 934 consecutive frames: main thread p50 4.05 / p99 10.13 / max 20.33 ms; the
slowest frame is the lift-off frame (render 10.84 with terrain 5.92, simulation 7.87, the snapshot going from
one vessel to two: request -13); 161 of the 934 frames take 6 ms or more, the slowest of them 10-14 ms at 0.2 km
with 4-7 ms in the terrain's hooks. No display is painted outside the cockpit view (0.00 paints per frame in the
burn test). No frame of 33 ms or more in any window of the perf spec.

Seen in the pictures and not the app's: in the frame-exact capture of the pad (`exact-pad.png`) the row of
stones along the edge of the access road is a chain of separate dark dots; in the running display
(`loading-revealed-later.png`, same camera) the same row is a soft band. The capture is 64 frames from a restart
of the temporal sequences with the camera at rest; the display's frame has hundreds of frames of history. Which
of the two is what the ground cover means to show is the terrain's to say.

### 2026-11-12 06:00: the whole app suite after the follow-up round (machine under bake load)

One run of `tests/browser/app` (functional + perf, 13 tests, 14.7 min in the slot, 05:49-06:04), alone on the GPU
but beside an Earth data bake with ten Python workers and two site-bake jobs on the CPU (`out/sysmon/`): every
main-thread and pacing number below is provisional (PACKAGE_RULES 16) and well above the quiet run of the night
before; no line was loosened. The run's console output was lost (another agent's script re-created the log file
of the same name in the shared scratchpad), so the figures come from `out/app/perf-*.json`, Playwright's
`.last-run.json` and the pictures.

**Result: 9 of 13 passed.** The four:
- the loading test failed on its pixel statistic, not on the picture: the first revealed frame has land to the
  horizon (`loading-revealed-first.png`), but the site bake's fresh lava is blue-grey and 12.7 % of the band
  was "blue-dominant" (limit 10 %). That statistic never separated the two cases (the frame that showed sea
  read 15 %). It is replaced by the share of pixels that are smooth AND bluish: 0.49 on the frame with sea, 0.068
  and 0.057 on this run's first and later frames (limit 0.25; their mean difference 2.2 of 255, limit 6);
- the low-orbit test failed in the new framing check: `window.__app.bodiesInFrame()` missed a planet whose centre
  is 76 degrees off the view axis (the Earth fills the lower half of `leo-chase.png`). The geometry is now
  `src/app/framing.ts` (`discInFrame`), checked against ten cases;
- the two 1440p perf tests fail on soft budget lines (table below). The harness clock was nominal after each of
  the three perf runs (p50 16.70 ms, 60.00 Hz), so the requestAnimationFrame lines were judged.
**The two functional fixes have not run in the browser:** the gate's queue was seven deep after this run and the
re-run was withdrawn after ten minutes. What stands for them: the new statistic computed on this run's two
pictures, and the geometry checked by script. Not covered by either: the part of the low-orbit test behind the
line that failed (turning the chase camera with the arrows, the reset (then a test hook, now the Home key), `leo-chase-reset.png`, then the
map node as before). Run
`npx playwright test tests/browser/app/app.spec.ts --project=functional -g "shows real progress|in low orbit"`
through the gate (about two minutes in the slot) to close it.

| 2560 x 1440 unless noted | GPU p50 / p99 (11 ms) | rAF p99 (17.5) / >= 33 ms | main thread p50 / p99 (6 ms) |
|---|---|---|---|
| pad | 7.6 / 8.5 | **18.2** / 0 | 5.55 / **12.66** |
| climb (0.3-1.0 km) | 8.4 / 9.4 | **18.4** / 0 | 7.11 / **14.75** |
| 720p pad | 4.0 / 4.5 | 17.9 / 0 | 4.20 / 8.50 |
| 720p climb | 4.5 / 5.0 | 18.4 / 0 | 4.32 / 10.01 |
| lunar orbit, coast | 1.0 / 2.9 | **17.7** / **1** (37.6 ms) | 2.03 / 4.82 |
| lunar orbit, burning | 1.1 / 1.4 | 17.6 / 0 | 1.41 / 3.88 |
| lunar orbit, burning, no display on the ORB page | 1.2 / 1.4 | 17.7 / 0 | 1.18 / 4.18 |
| lunar orbit, after the cut-off | 1.0 / 2.9 | 17.4 / 0 | 1.05 / 2.98 |

What changed against the night before, beyond the load:
- **The burn-time miss is gone.** The cockpit no longer paints its displays in the chase view (0.00 paints per
  frame at `lod1`; cockpit hooks 0.14 / 0.34 ms p50 / p99 during the burn, they were 0.60 / 5.56), and the burn is
  3.88 ms p99 even under the bake (it was 7.05 on a quiet machine). Request app-integration-12, items 1-3, done
  by the cockpit (round 4) and flight-ui (round 7).
- **The lift-off frame is the simulation's now:** 32.0 ms at 1440p (sim 22.8, terrain 4.0, cockpit 0.4) four
  frames after a 24.1 ms frame (sim 10.4); 34.1 ms at 720p (sim 14.3, terrain 7.0). The step in which the stack
  leaves the pad took 5.9-6.4 ms the night before; how much of the rise is the bake's CPU load and how much the
  simulation's v2 work is not separated here (request app-integration-13, open).
- Per feature at the pad, p50 / p99: terrain 2.20 / 5.86, core 0.64 / 1.21, site 0.61 / 1.24, vehicle
  0.57 / 1.32, cockpit 0.30 / 0.66 (it was 0.66 / 0.96), ocean 0.19 / 0.37, atmosphere 0.18 / 0.35; stages sim
  0.98, HUD 0.43, audio 0.30 ms p99. Everything but the cockpit is 1.5 to 2.5 times the quiet run: load.
- **Loading under the bake:** 54.9 s to the revealed view at 1440p (943 of 943 tiles of the view, level 20 of
  20), 47.1 s at 720p (443 tiles), 27.3 s in lunar orbit. The first frame came at 21.4 s (9-12 s the night
  before), the last shader module at 36-39 s (20 s), the terrain at 46-54 s (28-31 s). To be re-measured on a
  quiet machine before anything is concluded from it.


### 2026-11-11 night: loading timeline and main-thread attribution

Two runs of `tests/browser/app` (functional + perf, 22:38 and 23:08), each alone on the GPU (one slot in the gate);
other agents' CPU work ran beside them. The second run had the terrain pool work for app-integration-7 in the
working tree (uncommitted, another agent's); where the two runs differ both are given. Budget lines are not
loosened. Result of the second run: functional 7 of 7; perf 1 of 3 (the two 1440p tests fail on the soft
main-thread line, as the table says). A third, short run at 00:04 on the committed tree (the loading test, the
other-starts test added after the second run, the low-orbit test and the lead's `shell.spec.ts`): 4 of 4. A
fourth at 00:32, after the terrain's residency and upload budget and the core's shader and texture counts were
wired into the screen (the two loading tests, the boot test, `shell.spec.ts`): 4 of 4.

**Loading** (`performance.now()` of the page; the pad, 1280 x 720, second run; 2560 x 1440 is the same within two seconds):

| Step | start -> end, s | What happened |
|---|---|---|
| Graphics device, definitions | 0.4 -> 0.7 | adapter, 84 of 86 definition files |
| Simulation, sound | 0.7 -> 2.6 | `sim.ready` at 2.5 s; 38 of 38 assets at 2.6 s |
| Render pipelines | 2.1 -> 20.1 | `createRenderer` and the features' start-up one by one, done by about 5.7 s (terrain 1.6 s, cockpit 1.0, ocean 0.5, vehicle 0.3, site 0.1, the rest under 0.05); the first frame is presented at 9.3 s; the next 18 frames take 10.8 s while 70 shader modules compile |
| Sky and stars, atmosphere | 9.3 -> 20.3 | Milky Way cube, light probe, scattering tables: done with the compiles |
| Terrain at the start | 9.3 -> 31.3 | 32 tiles resident at 20.4 s, 636 (the always-resident levels) at 24.5 s, 1,079 with level 20 under the vehicle at 31.3 s |
| First frames, fade | 31.3 -> 31.9 | 12 settled frames, then 450 ms |

To the revealed view: **31.9 s** (first run 32.7 s, third run 30.4 s; perf spec at 1440p 31.9 s, at 720p 29.9 s;
lunar orbit at 1440p 21.0 s; landed on the Moon in the cockpit view 22.2 s with level 18 under the lander;
trans-Earth coast 17.6 s). Fourth run, with the terrain asked for from `init` on (the shared-code maintainer's
work for request -11) and the upload budget lifted under the screen: **28.4 s** on the pad (112 of 112 shader
modules at 19.8 s, 61 of 61 textures, 450 of 450 tiles of the view at level 20 of 20 at 27.8 s; 601 baked tiles
were waiting at 20.1 s and resident 2 s later), 21.6 s landed on the Moon, 16.9 s on the trans-Earth coast. Two thirds of it is not loading data: the 14 s in which the first 19 frames wait for synchronous
pipeline compiles, and the terrain that starts streaming only after that and refines one level per round trip (request
app-integration-11 asks for both). Before this round the game showed its first frame after 25-40 s and the pad's
surroundings were drawn as sea for another 40 s at 1440p; now the first frame shown is the final one.

**Frame time** (`app.perf.spec.ts`, governor off, render scale 1, median of three 240-frame windows; second run,
first run in brackets where it differs):

| | GPU p50 / p99 (11 ms) | rAF p99 (17.5) / >= 33 ms | main thread p50 / p99 (6 ms) |
|---|---|---|---|
| 1440p pad | 6.2 / 6.9 | 17.0 / 0 | 4.25 / **6.69** (4.63 / 6.31) |
| 1440p climb (0.3-1.0 km) | 6.4 / 7.0 | 17.3 / 0 | 3.98 / **6.48** (4.60 / 6.48) |
| 720p pad | 3.2 / 3.8 | 17.1 / 0 | 2.90 / 4.17 |
| 720p climb | 3.3 / 3.8 | 17.2 / 0 | 3.16 / 4.43 |
| 1440p lunar orbit, coast | 1.1 / 3.1 | 17.0 / 0 | 1.53 / 2.40 |
| 1440p lunar orbit, burning | 1.2 / 3.5 | 17.0 / 0 | 1.75 / **7.05** (1.70 / 6.94) |
| 1440p lunar orbit, burning, no display on the ORB page | 1.3 / 3.3 | 17.0 / 0 | 1.58 / 2.47 |
| 1440p lunar orbit, after the cut-off | 1.1 / 3.2 | 17.0 / 0 | 1.49 / 2.35 |

GPU and rAF are inside their lines everywhere with the GPU to itself. The frame clock ran at 60 Hz in the perf
tests of both runs (rAF p99 16.9-17.3 ms); the short-flight functional test read p50 16.67 ms in the first run and
17.46 ms in the second, so the 57.5 Hz clock of request app-integration-8 comes and goes between page loads. The
main thread misses its line in three rows.

**Main-thread attribution** (the app's hook timers: every feature hook in every frame; `core` = the render stage
minus the hooks; p50 / p99 over the windows, ms; 1440p):

| Feature | pad | climb | orbit coast | orbit burning | what it is |
|---|---|---|---|---|---|
| terrain | 1.85 / 3.35 (2.76 / 3.65) | 1.59 / 2.79 | 0.23 / 0.46 | 0.26 / 0.58 | `prepare` 2.0-2.9 ms and `drawShadow` 0.7-1.3 on the slowest pad frames; its own split at the pad, p50: selection 0.57, ground cover 0.52, build 0.11, shadow 0.08, rocks 0.07, stream 0.02 |
| cockpit | 0.66 / 0.96 | 0.71 / 1.18 | 0.55 / 0.80 | 0.60 / **5.56** | `compute` in the CHASE view: the three displays painted at 15 Hz, the sun map, the ambient pass and the cabin probe, at 140 m where the displays are under a pixel |
| vehicle | 0.37 / 0.59 | 0.33 / 0.59 | 0.14 / 0.23 | 0.15 / 0.25 | `prepare`, `drawGBuffer` |
| core | 0.32 / 0.51 | 0.28 / 0.55 | 0.24 / 0.34 | 0.25 / 0.37 | the render core's own work |
| site | 0.25 / 0.38 | 0.15 / 0.25 | - | - | |
| vfx | 0.05 / 0.08 | 0.26 / 0.39 | 0.04 / 0.06 | 0.09 / 0.14 | `prepare`; 1.5-2.8 ms in the first frame of a plume |
| ocean, atmosphere, sky | 0.13 / 0.21, 0.11 / 0.16, 0.03 / 0.05 | 0.11 / 0.16, 0.08 / 0.13, - | -, -, 0.07 / 0.11 | - | |
| app stages (p99) | sim 0.37, HUD 0.24, audio 0.16, input + map + controls + views 0.15 | sim 0.71, HUD 0.32, audio 0.17 | sim 0.24, HUD 0.22, audio 0.09 | sim 0.27, HUD 0.26, audio 0.13 | nothing to fix in `src/app` |

What the slow frames are made of:

- **Engine burns away from terrain (the unattributed rows of the mission: loi:burn, lunarCircularise, deorbit:burn,
  tei, entry): the cockpit feature's `compute`, and in it the Canvas 2D painting of the MFD's ORB page.** In the
  trace across a burn (910 frames, thrust for 407) 63 frames are 6 ms or more: every one during the burn, every
  one with `cockpit.compute` 5.2-5.7 ms of a 7.0-7.6 ms frame; none before the start, none after the cut-off. The
  displays' own statistics: 0.75 paints per frame always; mean per paint Canvas 2D 0.44 ms on the coast, 1.28 ms
  burning, 0.22 ms burning with the centre display cycled off the orbit page (upload 0.20 and mips 0.02 ms
  throughout). With no display on the ORB page the same burn is 1.58 / 2.47 ms. Request app-integration-12
  (cockpit: do not paint what cannot be seen from outside; flight-ui: bound the ORB page's paint), blocking.
- **Near the ground: the terrain's `prepare`** (selection, ground cover) at 2-3 ms on the slow frames, with the
  cockpit's 0.7-1.2 ms, the vehicle's 0.4-0.7 ms and the site's 0.3-0.5 ms on top. First run (tile pool full: 316
  tiles waiting for a layer for ever): terrain 10-14 ms per frame for a few seconds after lift-off (trace p99
  10.0, max 14.4 ms); second run with the pool work: p99 4.9, max 6.8 ms. Request app-integration-7 (addendum
  with these numbers).
- **Ignition and lift-off are single frames:** ignition 12.7 ms (vfx 2.72, terrain 2.08, audio 1.85, sim 1.00,
  HUD 0.83); the frame in which the stack leaves the pad 28-34 ms in all four traces (1440p: 29.96 = cockpit
  16.03 + sim 5.85 + terrain 4.26; 720p: cockpit 25.55 two frames after a sim step of 6.38). It is the likely
  frame behind the mission's one delta of 33 ms or more at ignition. Requests app-integration-12 (cockpit) and
  -13 (sim, vfx, audio).
- **Not the cause:** the render core's attribution frame (one frame in 64 with every hook in a pass of its own):
  0 to 6 of the frames of 6 ms or more fall on it in any trace; `core` stays at 0.3-0.5 ms.

### Earlier (2026-11-11 afternoon, machine shared)

Machine shared with up to four other agents' Chrome jobs on the GPU and about twelve agents on the CPU during
every run: the numbers are provisional (PACKAGE_RULES 16); the budget lines are not loosened.

**Functional** (`app.spec.ts`, all pass, 1280 x 720): no console error and nothing in `window.__test.errors` in any
test; `page` = `{ app, main, lunar-direct }`; nine features in the order above; pad: `prelaunch`, terrain
complete, 38 / 38 sound assets; keyboard as in the table; flight: LIFTOFF on the first Space, 4.09 km at MET 45 s,
202 m/s up, AudioContext `running` and the engines bus above 0 after the key press, `cheatCounter` 0; test pilot:
waited out the launch window on the pad (warped 10 minutes), lit the engines, phase `pitchProgramme` at 2.01 km
(MET 32.8 s, physics warp 4x), no failure, `cheatCounter` 0, `startKind` pad.

**Frame time** (`app.perf.spec.ts`, governor off, render scale 1, median of three 240-frame windows' p99; budget
in brackets):

| | GPU p50 / p99 (11 ms) | rAF p99 (17.5 ms) / >= 33 ms | main-thread p50 / p99 (6 ms) | largest stages p99 |
|---|---|---|---|---|
| 1440p pad | 6.7 / **8.0** | **17.8** / 0 | 7.8 / **13.1** | render 12.5, sim 0.6, HUD 0.4, audio 0.3 |
| 1440p climb (0.3-1.0 km) | 6.6 / **11.2** | **18.4** / 0 | 8.0 / **13.7** | render 12.1, sim 1.2, HUD 0.6, audio 0.4 |
| 720p pad | 3.4 / 4.2 | 17.6 / 0 | 6.5 / 11.0 | render 9.9, sim 0.6, HUD 0.4 |
| 720p climb | 3.4 / 4.4 | 18.1 / 0 | 5.7 / 9.7 | render 8.2, sim 1.3, HUD 0.7 |

Per-feature p99 (window.__perf.features, normal mode: one frame in 64 attributed), 1440p pad / climb: GPU terrain
5.5 / 7.1, atmosphere 2.0 / 5.0, core 1.0 / 1.2, ocean 0.2 / 0.6, vfx 0.0 / 0.4, cockpit 0.3 / 0.3; CPU terrain
14.9 / 11.4 (720p: 7.8 / 5.6), cockpit 1.7 / 2.3 (outside the cabin), vehicle 1.7, site 0.8, vfx 0.2 / 0.8.
A quieter moment, 720p, pad idle (probe, 240 frames): whole frame p50 4.1 / p99 6.2 ms, of it `renderer.render`
p50 3.6 / p99 5.5 ms; terrain hooks p50 1.7 / p95 2.5 ms (selection 0.7, ground cover 0.6).
Verdict: GPU met at the pad, 0.2 ms over in the climb; rAF p99 a few tenths over (no long frame); **main-thread
CPU missed**: about 6 ms p99 at 720p on a quiet moment, 10-14 ms in the perf runs at 1440p under load, the
renderer's hooks being most of it and the terrain the largest of those (request app-integration-7: its streaming
stall at 1440p and its CPU numbers). The app's own stages (input, map, controls, views) are below 0.15 ms; the
simulation 0.6-1.3 ms (its line 1.5 ms at 4x); HUD 0.4-0.7 ms (line 0.5 ms). Re-measure on a quiet machine.

## Pictures (out/screens/app/, all looked at)

- `pad-chase.png`: the vehicle beside the umbilical tower on the real pad (after app-integration-3), clouds,
  lava plain, tank farms, water tower; HUD launch panel (Moon, plane crossing T- 9:45, azimuth 099).
- `pad-cockpit.png`: the commander's seat: couches, the panel with the navball instrument and the MFD on ORB,
  the window lit.
- `pad-map.png`, `climb-map-3km.png`: the whole Earth from the map camera, launch site and vessel labels,
  recovery-zone circles, the Moon's orbit line, the impact marker in the climb.
- `climb-chase-150m.png`, `climb-chase-2km.png` (after a switch from the cockpit the chase eye starts behind
  the cockpit's view, i.e. below the stack looking up the zenith: deep blue sky), `climb-chase-4km.png` (cloud
  deck and coast below), `pilot-climb-chase.png` (the pilot's pitch programme with TEST PILOT line).
- `climb-cockpit-1km.png`: beige, evenly lit cabin: the plume lights reached the interior (app-integration-5,
  resolved by the cockpit in its round; to be re-shot).
- `pad-paused.png`: taken right after a map round trip: the land around the pad drawn as sea
  (app-integration-6, open; in the runs of the night the land is there).

Added 2026-11-11 night (all looked at):
- `loading-0-first.png`: the screen in its first instant: MERIDIAN, "Starting", ten rows with hollow marks,
  "Graphics device: WebGPU adapter and device" lit, 0:00. `loading-1-defs.png`: the adapter's name in green,
  "Definitions: files read, 44 / 86" with its bar half way.
- `loading-2-pipelines.png`: "Render pipelines: terrain, 1 / 10" with its bar, "Sound 0 / 38", the rest waiting
  (hollow marks), 0:02 in the footer.
- `loading-3-terrain.png` (fourth run): at 0:19: "Render pipelines: render core and 9 features · shader modules
  compiled, 112 / 112", "Sky and stars: light probe, 2 / 3", "Vehicle and site models: textures loaded, 61 / 61",
  "Terrain at the start: level 0 of 1 · 617 uploading, 11 / 26" (the levels and the total grow while the selection
  refines: they are the terrain's own numbers of the moment).
- `loading-4-view.png`: everything done in green, "First frames: consecutive frames with nothing pending, 7 / 12",
  0:32.
- `loading-revealed-first.png` (no HUD): the first frame shown: the stack at the tower, lava plain and scrub to
  the horizon, clouds; `loading-revealed-later.png`: ten seconds later, the same picture.
- `capture-on.png`: the HUD's switch reading "Keyboard capture ON" (green); `footage-switches.png`:
  `?capturepill=0&pilotlabel=0` with the pilot flying and the game paused: no switch, no pilot label, PAUSED.
- `leo-chase.png`, `leo-cockpit.png`, `leo-map-node.png`: the parking orbit; the map with a maneuver node at the
  apoapsis, its handles and the node panel (prograde 1.0 m/s after the Shift-drag).
- `start-lunar-surface-cockpit.png`: the first frame of a start landed on the Moon in the cockpit view: the cabin
  lit, the navball instrument and the flight display legible. `start-trans-earth.png`: the first frame of the
  trans-Earth coast: the ascent stage and capsule seen from behind at 322.6 Mm, the Earth and the Moon as two small
  discs near the left edge (the framing of request app-integration-10).

Added 2026-11-12 14:49 (phase 2, first half; all looked at):
- `loading-2-pipelines.png`: "Render pipelines: starting terrain (1 of 9) · shader modules compiled, 0 / 29",
  sound already done (38 / 38), 0:02. `loading-revealed-first.png` / `-later.png`: the default pad view of today:
  the stack at the tower from above, the pad's apron and flame trench, lava plain with scrub and salt-white
  patches, the coast and the sea with the sun's glitter, clouds; the two are the same picture.
  `loading-revealed-first-land-points.png`: the first frame with the height authority's points drawn on it: green rings on the plain in five arcs around the stack (300 to 1800 m), blue rings in the water along and beyond the shore line; no red ring (a land point reading as water).
- `stop-stage-fired.png`: T+00:00:00, throttle 100 %, 19.1 m on the pad, no flame yet (the tick of the event);
  `stop-liftoff.png`; `stop-liftoff-plus-1s.png`: T+00:00:01, 2.4 m/s, the "Lift-off" toast, the launch cloud
  rolling out on both sides of the pad.
- `leo-chase.png`, `leo-chase-reset.png` (after turning the camera and pressing Home: the same framing, the stack
  from behind, the Earth's limb and clouds below); `leo-chase-heads-down.png`: the navball brown side up, roll
  173.8 degrees, SAS and RCS lit.
- `leo-cockpit.png`: the pilot's couch, heads-down: sunlit cloud fields and blue sea in both forward windows, the
  caution panel with SAS ACTIVE and RCS ARMED lit, the three displays legible (flight, orbit, systems).
  `leo-cockpit-next-seat.png`: the next couch (toast "Seat: Noor Valkonen"): the right-hand display, the side
  window with the Earth in it, the quilted wall.
- `exact-pad.png`: the held frame of a frame-exact capture (no HUD): the pad view; see the remark on the stones
  along the road above.
- `start-lunar-surface-cockpit.png` (cabin lit, black sky in the windows, EV100 2.71), `start-trans-earth.png`
  (the stack from behind in its own shadow, the Earth a small half disc at the lower left, 2 % of the frame's
  height).

## Browser mission (ARCHITECTURE 18.2)

### Flight of 2026-11-12 (16:13-16:59): the re-flight with picture stops

**Result: the flight passes every gate; the spec fails softly on frame-time lines and on seven "no body in the
frame" checks that were the spec's own error.** One flight, commit `2a9bb7d` (the tree with the ocean's third
round, the vfx foam decal off, the terrain's pad work and the cockpit's default seat), alone in the GPU slot with
the gate's CPU and bake slots free at the start. 45.6 minutes from `ready` to splashdown (44.9 on 2026-11-11; the
simulation stood at picture stops for 32 s in all). All seventeen milestones in order, `cheatCounter` 0 at every
milestone and at the end, pad start, crew alive, `terrain.incompleteQueries` 0, `window.__test.errors` empty, the
console with the known `powerPreference` warning only. 36 of 36 picture stops reached (17 milestones and 19
added moments), 40 pictures. Record: `docs/qa/mission/browser-mission-2026-11-12.json` (gates, the 80 phase rows,
the pictures with their numbers and readings, the windows over the lines, the comparison with 2026-11-11); the
full record with all 711 windows is `out/mission/browser-mission.json`.

Gates:

| Milestone | Measured | Gate |
|---|---|---|
| LIFTOFF | surface speed 0.017 m/s, inertial 439.3 m/s | < 0.1 m/s; 439 +/- 2 m/s |
| MAX_Q | 28.35 kPa at 11.0 km | 20-40 kPa |
| STAGE_SEP_1 | 77.1 km, 2067 m/s, 1 debris vessel(s) | leaves debris |
| FAIRING_JETTISON | 96.0 km, 5 debris vessels | above 80 km, leaves debris |
| STAGE_SEP_2 | 183.8 km, 7819 m/s, 1 debris vessel(s) | leaves debris |
| EARTH_ORBIT | 181.0 km x 257.2 km, incl. 20.89 deg | Pe >= 160 km, Ap <= 400 km |
| TLI_COMPLETE | Moon encounter predicted 67.6 h ahead | patches contain a Moon encounter |
| MOON_SOI_ENTER | 0.000 s from the predicted time | +/- 2 s |
| LUNAR_ORBIT | 102.4 km x 113.7 km, e 0.0031 | e < 0.05, Pe > 60 km |
| LUNAR_TOUCHDOWN | 0.82 m from the target; data level 12 resident of 12 available (deepest 12); 1.00 m/s down, 0.016 m/s across, tilt 0.36 deg (1.43 at the record), 4 of 4 legs intact; 911 s on the surface | <= 1,500 m; deepest level; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; > 600 s landed |
| LUNAR_LIFTOFF | after 916 s on the surface; "Heron descent stage" still landed at the end | descent stage stays behind as landed debris |
| MOON_SOI_EXIT | 0.000 s from the predicted time | reached, +/- 2 s |
| EARTH_PERIGEE_TARGETED | vacuum perigee 38.1 km | 30-60 km |
| ENTRY_INTERFACE | 122.0 km, 11.010 km/s; peak 5.87 g, g-dose 0.00, ablator left 58.0 %, capsule RCS left at drogues 93.0 % | 122 km, 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 % |
| DROGUE_DEPLOY | 7445 m, Mach 0.43, 4.91 kPa | inside the envelope |
| MAIN_DEPLOY | 3175 m, 49.6 m/s, 1.10 kPa | inside the envelope |
| SPLASHDOWN | 15.33 deg, -141.59 deg on water, 1161.4 km from the centre of "Central Pacific" (radius 2000.0 km); 7.82 m/s; upright at 10.3 deg after 30 s | water, inside a recovery zone; <= 9.5 m/s; crew alive; upright after 30 s |
| budgets | 7.87 days from lift-off to splashdown; 45.6 minutes of real time from ready to splashdown | < 14 days |

Against 2026-11-11: the same flight within the pilot's scatter (lunar orbit 102.4 x 113.7 km against 103.0 x
114.7; touchdown 0.82 m from the target against 1.94 m; vacuum perigee 38.1 km against 48.5, inside 30-60;
splashdown about 13 km from the earlier point, 7.82 m/s both times; peak 5.87 g against 5.93).

Frame time (2560 x 1440, render scale 1, governor off; a phase's number is the median over its windows of the
window's p99; harness clock 59.99 Hz before and 60.00 Hz after, so the rAF lines are judged). By segment of the
flight, with the worst phase of each; "then" is 2026-11-11 (GPU p99 / main-thread p99 of the worst phase / frames
of 33 ms or more):

| Segment | min | frames | GPU p99, worst phase (line 11 ms) | worst single window | main thread p99, worst phase (line 6 ms) | phases over 6 ms | rAF p99, worst phase | frames >= 33 ms | then |
|---|---|---|---|---|---|---|---|---|---|
| pad | 0.6 | 2071 | 6.45 (prelaunch) | 39.50 | 4.83 (prelaunch) | none | 17.13 | 1 | 6.92 / 6.39 / 0 |
| ignition and lift-off | 0.2 | 515 | 7.00 (ignition) | 7.00 | 12.49 (vertical) | ignition 7.36; vertical 12.49 | 21.62 | 0 | 8.37 / 17.69 / 1 |
| ascent | 2.6 | 8673 | 3.94 (pitchProgramme) | 6.32 | 8.07 (pitchProgramme) | pitchProgramme 8.07; m1Separation 6.79 | 19.57 | 0 | 4.42 / 10.05 / 0 |
| parking orbit | 2.8 | 9541 | 2.79 (parkingCoast) | 3.03 | 3.62 (parkingCoast) | none | 17.12 | 0 | 3.67 / 6.58 / 0 |
| parking orbit, cockpit | 0.0 | 240 | 2.50 (parkingCoast (cockpit)) | 2.50 | 4.10 (parkingCoast (cockpit)) | none | 17.10 | 0 | 2.53 / 4.16 / 0 |
| translunar injection | 4.8 | 17070 | 3.05 (tli:tail) | 3.14 | 4.83 (tli:plan) | none | 18.14 | 0 | 4.52 / 6.69 / 0 |
| coast to the Moon | 5.2 | 18510 | 3.37 (mcc2:align) | 3.99 | 3.70 (mcc1:tail) | none | 21.47 | 1 | 3.21 / 4.56 / 0 |
| lunar orbit | 7.9 | 28472 | 2.96 (loi:coast) | 4.10 | 5.69 (loi:trim) | none | 19.04 | 0 | 2.96 / 18.85 / 1 |
| powered descent | 4.0 | 13592 | 2.94 (terminal) | 3.52 | 12.27 (terminal) | terminal 12.27 | 17.44 | 0 | 4.31 / 13.56 / 0 |
| lunar surface | 0.5 | 1620 | 3.17 (surface) | 3.26 | 3.85 (surface) | none | 16.95 | 0 | 4.72 / 4.35 / 0 |
| lunar surface, cockpit | 0.0 | 241 | 2.12 (touchdown (cockpit)) | 2.12 | 9.82 (touchdown (cockpit)) | touchdown (cockpit) 9.82 | 17.17 | 0 | 4.41 / 4.81 / 0 |
| lunar ascent | 3.5 | 12601 | 3.61 (lunarLiftoff) | 3.95 | 4.95 (lunarAscent) | none | 17.60 | 0 | 3.27 / 10.31 / 0 |
| return to the Earth | 8.0 | 28806 | 4.35 (tec1:tail) | 11.42 | 5.26 (entryPrep) | none | 17.45 | 0 | 2.80 / 6.80 / 0 |
| entry | 3.2 | 11372 | 2.74 (entry) | 3.44 | 4.90 (entry) | none | 17.37 | 0 | 1.74 / 8.24 / 0 |
| chutes | 0.6 | 1950 | 4.16 (chutes) | 4.60 | 4.75 (chutes) | none | 17.20 | 0 | 1.96 / 7.75 / 0 |
| splashdown | 1.7 | 5730 | 5.25 (splashdown) | 6.18 | 5.02 (splashdown) | none | 17.23 | 0 | 2.26 / 3.95 / 0 |

- GPU: no phase over 11 ms (worst 7.00, ignition). Three of 711 windows over it: two on the pad 12 s apart at
  warp 1 (p99 37.7 and 39.5 ms with a median of 5.6: every feature's GPU time 4.7 times its usual in a few
  frames, so the GPU as a whole was slow for those frames; the app perf spec's pad windows of the same
  afternoon have none; cause not found) and one in `tei:burn` (11.4).
- Main thread: 6 of 80 phases over 6 ms (24 on 2026-11-11): ignition 7.36, vertical 12.49, pitchProgramme 8.07, m1Separation 6.79, terminal 12.27, touchdown (cockpit) 9.82. What they are made of (p99 per stage and
  feature): `vertical` render 10.9 with the terrain's hooks 5.4 and the core 2.5, simulation 2.1; `terminal`
  (the last 600 m over the Moon) the terrain's hooks 10.8; `touchdown (cockpit)` terrain 5.0, core 3.4, cockpit
  1.6; `pitchProgramme` terrain 2.8, simulation 1.9. Nothing of the app's own. 95 of 711 windows are over the
  line (the record lists them by phase).
- rAF: p99 over 17.5 ms in 17 phases (worst 21.6, ignition; the median phase 17.18); p95 at or over 16.7 ms in
  all 80 (16.84 to 17.70, median 16.98, with a median p50 of 16.66): on a 60 Hz clock the frame deltas scatter
  about 16.67 ms, so the 18.2 line "p95 < 16.7 ms" is missed by a tenth to three tenths of a millisecond in
  every phase, whatever the load. Not loosened; it wants the lead's reading.
- Frames of 33 ms or more: 2 in 161,004 frames (2 on 2026-11-11): one on the pad in the second of the two slow
  GPU windows (33.7 ms), one of 452 ms on the main thread in `moonArrival` at warp x10. The second has no
  breakdown: the spec read the window's slowest frames after resetting them (corrected).

The spec's own errors, found in this flight and corrected afterwards (not re-flown):
- "The Earth or the Moon in the frame" failed for the seven chase pictures on and just above the lunar surface:
  the landing site lies 1.9 km below the Moon's reference radius, the camera was inside the reference sphere and
  `bodiesInFrame()` skipped the body. It now takes the body as filling the half space below
  (`bodyAngularRadius` in `src/app/framing.ts`, unit-tested).
- The slowest frames of each window were read after the reset (above).

Pictures (`out/screens/mission/`, 2560 x 1440, all 40 looked at: each as a 1280 x 720 reduction, and in crops at
full resolution where something looked wrong):

- `00-pad-chase.png`: The stack at the umbilical tower from above, the pad's apron, lava plain, the coast and the sea with the sun's glitter, cumulus; launch panel (plane crossing T- 2:21), warp x50 while the pilot waits for the window.
- `01-liftoff-chase.png`: The frame of lift-off (T+0, 19.1 m): the launch cloud rolling out left and right of the pad, the stack still beside the tower, toast "Lift-off". **Wrong or to judge:** No flame is visible in this frame: the base of the vehicle is behind the pad's structure and the HUD's navball.
- `02-max-q-chase.png`: 14.9 km, Mach 1.67: the stack from behind and below, the plume at the lower edge behind the navball, cloud field and sea far below. **Wrong or to judge:** In the sun's glint on the sea (lower right) a pair of pale meandering ribbons and several fans of dark parallel arcs: drawn-looking lines, not water (checked in a crop at full resolution).
- `03-stage-sep-1-chase.png`: 77.1 km: the first stage just free, a white flash at the gap, the second stage and spacecraft ahead; the Earth's limb with a thin blue line of air, cloud field.
- `03-stage-sep-1-plus-0.5s-chase.png`: Half a second later: the first stage a few metres behind, the second stage's engine glowing.
- `03-stage-sep-1-plus-2s-chase.png`: Two seconds later: the first stage a length and a half behind and below, the second stage's plume a pale cone.
- `04-fairing-jettison-chase.png`: 96.0 km: a small glow at the nose (the tower's motors), the second stage burning, the spent first stage a speck at the lower left.
- `04-fairing-jettison-plus-0.5s-chase.png`: The four fairing petals opening around the spacecraft, the tower leaving ahead on its motor's flame.
- `04-fairing-jettison-plus-2s-chase.png`: The four petals tumbling away on all sides, lander and capsule exposed on top of the second stage.
- `05-stage-sep-2-chase.png`: 183.8 km, in orbit: the second stage's tank just apart from the third stage and spacecraft, no plume, cloud field below, stars above the limb.
- `05-stage-sep-2-plus-0.5s-chase.png`: The second stage half a metre apart.
- `05-stage-sep-2-plus-2s-chase.png`: The second stage two metres apart, the third stage's engine visible in the open ring.
- `06-earth-orbit-chase.png`: The same instant as the stage separation (0.1 s later), toasts "M-2 separation" and "Earth orbit".
- `06-earth-orbit-cockpit.png`: The pilot's couch: panel, caution lights and the three displays legible (flight, orbit, systems), the cabin evenly lit. **Wrong or to judge:** Both forward windows are a flat light grey with faint scratches. The Sun stands in the windows (frame position -0.08, 0.27): no sun disc, no bloom, no Earth or sky can be made out. (The stack flies heads-up here; the heads-down picture with the Earth in the windows is the app spec's leo-cockpit.png.)
- `07-tli-complete-chase.png`: 299.9 km at cut-off: the third stage and spacecraft, two RCS jets at the tail, cloud field and limb below, toast "TLI complete", burn panel with 0.6 m/s remaining.
- `08-moon-soi-enter-chase.png`: 64.4 Mm from the Moon: the lander stack sunlit from the side against black; a small gibbous Earth (blue and white at full resolution) at the lower left. **Wrong or to judge:** The Moon, 64 Mm ahead, is not in the frame.
- `09-lunar-orbit-chase.png`: 104.7 km over the Moon: the stack from behind (the descent engine's bell and truss), RCS puffs, the grey surface below with a sharp limb, toast "Lunar orbit". **Wrong or to judge:** To judge: from this height the surface is smooth, with few craters to be seen.
- `10-lunar-touchdown-descent-30m-chase.png`: 30 m, 4.4 m/s down: the lander with its gear down over the mare, its shadow far to the left, black sky, sharp horizon. **Wrong or to judge:** No engine plume and no dust (throttle 21 %). The small craters farther off read as flat dark ovals.
- `10-lunar-touchdown-descent-10m-chase.png`: 10 m, 1.5 m/s down: the shadow nearer. **Wrong or to judge:** No dust at 10 m (throttle 15 %), no plume.
- `10-lunar-touchdown-descent-3m-chase.png`: 3 m, 1.0 m/s down: the shadow reaches the lander's feet. **Wrong or to judge:** No dust, no plume (throttle 12 %).
- `10-lunar-touchdown-contact-chase.png`: The first footpad on the ground (panel "LANDED"), throttle still 12 %. **Wrong or to judge:** No dust at the contact.
- `10-lunar-touchdown-contact-plus-1s-chase.png`: One second later: engine off, the lander at rest on its four legs.
- `10-lunar-touchdown-chase.png`: At rest 0.8 m from the target in Mare Tranquillitatis: long shadow to the left, a small crater with rocks in the foreground, toast "Lunar touchdown".
- `10-lunar-touchdown-cockpit.png`: The cabin on the Moon, lit; displays legible (the orbit page reads "Moon - landed - no orbit"). **Wrong or to judge:** The forward windows are plain black: they look at the sky; the Earth is in the frame's lower part, behind the panel.
- `11-lunar-liftoff-chase.png`: 50 m up at 13 m/s: the ascent stage and capsule, framed closer (the vessel is smaller now), the mare below, darker than in the landing pictures (EV100 14.2 against 12.8). **Wrong or to judge:** No plume under the ascent engine at 100 % throttle, no dust; the descent stage left behind is not in the frame.
- `12-moon-soi-exit-chase.png`: 359.7 Mm from the Earth: the ascent stage and capsule sunlit, the Moon a small full disc at the lower left.
- `13-earth-perigee-targeted-chase.png`: The stage from its shadowed side, RCS jets with a wide grey haze around them, a small gibbous Earth at the lower left, the capsule's nose catching the light at the lower right; toast "Entry corridor targeted". **Wrong or to judge:** To judge: the haze of the RCS jets is as wide as the vehicle.
- `14-entry-interface-chase.png`: 122.0 km, 10.8 km/s, at night: the capsule alone, dark, faintly lit from one side, heat shield forward; entry panel (14 kW/m^2). **Wrong or to judge:** The Earth below is black (night side): nothing but the capsule in the frame.
- `14-entry-interface-peak-heating-chase.png`: 60.0 km, 2.47 MW/m^2, 4.8 g: a white to pale pink sheath wrapped round the heat shield with a long pale wake, the capsule dark inside it. **Wrong or to judge:** To judge: the glow is nearly white (little colour), and the capsule's flank carries a pattern of light streaks. The recovery panel reads "Central Atlantic, 13.92 Mm" in this frame and "Central Pacific" before and after.
- `14-entry-interface-peak-heating-cockpit.png`: The couch during the peak: the cabin dim, displays legible (4.78 g, 60.0 km), caution lights SAS, RCS, COMM BLK and LIFT UP lit. **Wrong or to judge:** Both windows are a flat light grey: no structure, no flicker, no colour of the plasma, and the cabin walls are not tinted by it.
- `14-entry-interface-peak-g-chase.png`: 54.6 km, 5.58 g, 901 kW/m^2: a white-pink glow as wide as the frame. **Wrong or to judge:** The capsule is burnt out to white inside the glow, its detail gone: the exposure stands at EV100 7.7 here (16.5 at the peak of the heating 44 s earlier).
- `15-drogue-deploy-chase.png`: 7.4 km, 132 m/s, low sun: the capsule tan in the warm light, one riser running up out of the frame, pink cumulus and a grey sea in haze below. **Wrong or to judge:** The drogues are above the frame: only the riser shows. A pale vertical streak hangs below the capsule.
- `15-drogue-deploy-plus-3s-chase.png`: Three seconds later, 99 m/s: two risers running up. **Wrong or to judge:** The canopies are above the frame.
- `16-main-deploy-chase.png`: 3.2 km, 50 m/s: the capsule under one riser, cumulus in sunset colours, the sea a flat purple-grey. **Wrong or to judge:** The mains are above the frame.
- `16-main-deploy-plus-8s-chase.png`: Eight seconds later, 18 m/s: three risers. **Wrong or to judge:** The canopies are above the frame: no picture of this flight shows an open chute.
- `17-splashdown-splash-plus-0.2s-chase.png`: The capsule in the water, a crown of white spray with flying drops around it, a ring of foam, dark blue swell, warm clouds at the horizon. **Wrong or to judge:** A box-shaped darker patch on the water in front of the capsule, with straight vertical edges.
- `17-splashdown-splash-plus-1s-chase.png`: The crown at its largest, a sheet of spray, the foam patch spreading; the capsule hidden in the spray. **Wrong or to judge:** Patches of turquoise speckles on the water at the lower left; some spray drops are drawn as long straight lines.
- `17-splashdown-splash-plus-3s-chase.png`: The capsule afloat, dark brown, upright; a wide patch of foam with dark holes over the swell, tinted pink by the low sun; a main canopy (orange and white gores) coming down at the left with its risers taut. **Wrong or to judge:** To judge: the foam patch fills the lower half of the frame. The canopy stands on the water like a flat fan.
- `17-splashdown-splash-plus-10s-chase.png`: The foam thinner and broken up (the patch has aged), the capsule upright, panel "SPLASHED", the sea very dark under the low sun. **Wrong or to judge:** The box-shaped darker patch in front of the capsule again; the canopy still stands as a fan at the left edge.
- `17-splashdown-chase.png`: 34 s after the splash: the capsule riding upright in what is left of the foam, toast "Splashdown". **Wrong or to judge:** The box-shaped darker patch in front of the capsule (edges about a capsule's width apart, from the waterline down); the fan-shaped canopy.

What the pictures cannot show, for whoever judges them: no picture of the flight has an open chute in it (the
chase view's default framing keeps the capsule in the middle and the canopies above the frame: the spec would
have to zoom out through the camera's own controls at those stops, and it asserts the default framing today);
the Earth-orbit cockpit picture is heads-up with the Sun in the windows (the mission spec does not roll the
stack; the app spec's `leo-cockpit.png` is the heads-down one).

### Flight of 2026-11-11

**Result (2026-11-11): the flight passes, the spec fails on frame-time budgets and two image-statistics checks.**
The test pilot flew lunar-direct inside the page in real Chrome on the RTX 5090, from the pad to splashdown in
real time. It took 44.9 minutes from `ready` to splashdown (`browser-loop.test.ts` predicts 44.9). All seventeen
milestones came in order and every milestone gate was met. `cheatCounter` was 0 at every milestone and at the end,
the start was a pad start, the crew lived and `terrain.incompleteQueries` was 0. `window.__test.errors` stayed
empty for the whole flight, and the console had nothing besides the known `powerPreference` warning. GPU p99 stayed
inside 11 ms in every phase (worst 8.4 ms, at lift-off). Missed: rAF p95 < 16.7 ms and p99 <= 17.5 ms in every
phase (the headless frame clock runs at about 57.5 Hz: request `app-integration-8`); main-thread p99 <= 6 ms in 24
of 80 phase rows (the renderer's hooks); 2 rAF deltas of 33 ms or more in 153,167 frames; and two pictures under the
spec's image-statistics thresholds. The run used the tree as it stood, including the uncommitted work in progress of
atmosphere-clouds, vfx and flight-ui (backed up on `wip/2026-11-11-crash`). That work built and ran without error,
and the pictures and the HUD notes below reflect it.

### How to run

```
node tools/dev/heavy.mjs --class=gpu -- npx playwright test --project=mission     # about 47 minutes; nothing else on the GPU
```

`tests/browser/mission/lunar-direct.spec.ts` opens `/?scenario=lunar-direct&pilot=1&view=chase&scale=1&governor=off`
at 2560 x 1440 (1440p internal, qualityScale 1: the conditions of the budget table) under the machine-wide GPU lock.
Since 2026-11-12 (not yet flown with these changes): it measures the harness clock before and after the flight
(`measureHarnessClock`) and judges the requestAnimationFrame lines only when both are the nominal 60 Hz
(`expectNominalClock`; otherwise it fails saying they were not judged); a picture in a view just switched to waits
for the exposure to reach its target (request cockpit-15: `|ev100 - targetEv100| < 0.1`, read from
`__app.exposure()`); every chase picture asserts the rig's default framing and a body other than the star in the
frame (`__app.chaseFraming()`, `bodiesInFrame()`), and records both with the exposure.
It asserts the discrete NVIDIA adapter (`assertDiscreteGpu`), the page and the pad start, and presses F9 once. F9 is
unbound: the press is only the first gesture, so the AudioContext runs. From then on the spec only watches. Every
30 frames it polls `window.__app.brief()`, `window.__test.pilot` and `errors`. It reads `perf()` and
`__app.cpu()` in windows of up to 240 frames, reset at every phase change and around every picture, so pictures
and view switches never fall inside a window. It takes the pictures at each new milestone and, at the end, reads
`milestones()` and `state()` for the gates. Nothing writes state. The pilot acts through `sim.setControls` and
`sim.commands` in the simulation's control ticks (`src/app/pilot.ts`), the same two doors the keyboard uses. The
`Sim.debug` API is never reached and there is no teleport.

Watchdogs: the pilot gives up, the mission fails, the frame loop stalls for 60 s, or 120 minutes pass. On any of
them the record so far is written and the test fails. Gates and budgets are soft assertions (`expect.soft`), so a
miss is reported without stopping the flight. Output: `out/screens/mission/*.png`, `out/mission/browser-mission.json`
(gates, milestone records, every perf window, the phase log, the audio bus levels at each picture), and the gate list
and per-phase table in the log. Per-feature CPU (`featuresCpu`) was added to the windows after this run, so the next
run attributes the main-thread misses.

Run 1 stopped at the parking orbit on a spec fault: it waited for camera kind `cockpit`, but the cockpit rig's
camera kind is `interior`. The spec now waits for `__app.viewMode()`. Run 2 is the one reported here.

### Gates (window.__test.milestones() and state(), run 2)

| Milestone | Measured | Gate |
|---|---|---|
| LIFTOFF | surface speed 0.017 m/s, inertial 439.3 m/s | < 0.1 m/s; 439 +/- 2 m/s |
| MAX_Q | 28.35 kPa at 11.0 km | 20-40 kPa |
| STAGE_SEP_1 | 77.0 km, 2,064 m/s, 1 debris vessel | leaves debris |
| FAIRING_JETTISON | 96.0 km, 5 debris vessels | above 80 km, leaves debris |
| STAGE_SEP_2 | 183.8 km, 7,819 m/s, 1 debris vessel | leaves debris |
| EARTH_ORBIT | 181.0 x 257.8 km, incl. 20.89 deg | Pe >= 160 km, Ap <= 400 km |
| TLI_COMPLETE | Moon encounter predicted 67.5 h ahead | patches contain a Moon encounter |
| MOON_SOI_ENTER | 0.000 s from the predicted time | +/- 2 s |
| LUNAR_ORBIT | 103.0 x 114.7 km, e 0.0032 | e < 0.05, Pe > 60 km |
| LUNAR_TOUCHDOWN | **1.94 m** from the target; level 12 resident of 12 available (deepest 12), terrain complete; 1.00 m/s down, 0.018 m/s across, tilt 0.35 deg at contact (0.86 at the record); 4 of 4 legs intact; 911 s on the surface | <= 1,500 m; deepest level; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; > 600 s |
| LUNAR_LIFTOFF | after 916 s; "Heron descent stage" still landed on the Moon at the end | descent stage stays as landed debris |
| MOON_SOI_EXIT | 0.000 s from the predicted time | reached, +/- 2 s |
| EARTH_PERIGEE_TARGETED | vacuum perigee 48.5 km | 30-60 km |
| ENTRY_INTERFACE | 122.0 km, 11.010 km/s; peak 5.93 g, g-dose 0.00, ablator left 58.1 %, capsule RCS left at drogues 93.0 % | 122 km, 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 % |
| DROGUE_DEPLOY | 7,447 m, Mach 0.43, 4.91 kPa, inside the envelope | inside the envelope |
| MAIN_DEPLOY | 3,175 m, 49.6 m/s, 1.10 kPa, inside the envelope | inside the envelope |
| SPLASHDOWN | 15.44 deg N, 141.63 deg W on water, 1,174.9 km from the centre of "Central Pacific" (radius 2,000 km); 7.82 m/s; crew alive; 11.8 deg tilt after 30 s | water inside a zone; <= 9.5 m/s; crew alive; upright after 30 s |
| Budgets | 7.87 days from lift-off to splashdown | < 14 days |

The browser does not reproduce the observers of the headless harness, because `window.__test` has nothing to read
them from. These stay with `npm run test:mission`:

- the Kepler revolution to 1 m;
- structural events and the clearance after separations;
- step cost before the two landings;
- residency on every tick of the final descent (the touchdown record's resident and available level and
  `terrainComplete` are asserted here);
- determinism and the golden hash;
- debris fates and the QA captures.

Not exercised here:

- the key-press segments of 18.2 (`app.spec.ts` covers the bindings);
- map-view pictures;
- audio assertions. The bus levels are recorded at each picture: engines rms 0.062 at lift-off, 0.028 at M-1
  separation, 0 on the coasts. The reentry bus reads 0 at the entry-interface picture, which comes before the
  heating. No picture is taken at peak heating.

### Frame time per phase (2560 x 1440, render scale 1, governor off, under the GPU lock)

Each number is the median over the phase's windows of each window's percentile. A window is up to 240 frames, the
same method as `app.perf.spec.ts`. Worst = the largest window p99 in the segment. Main thread = the app's whole frame
function (`__app.cpu()`). Budgets: GPU p99 <= 11 ms, rAF p99 <= 17.5 ms with no delta >= 33 ms, main thread
p99 <= 6 ms (17), rAF p95 < 16.7 ms (18.2). Segments group the pilot's phases. The per-pilot-phase table follows.

| Segment (pilot phases) | real min | frames | rAF p50 / p95 / p99 (worst window p99) | >= 33 ms | GPU p50 / p99 (worst) | main thread p50 / p99 (worst) | largest stage p99 |
|---|---|---|---|---|---|---|---|
| Pad (launch window wait) | 0.7 | 2251 | 17.4 / 18.0 / 18.3 (21.1) | 0 | 6.4 / 6.9 (7.8) | 4.9 / 6.4 (12.9) | render 5.6 |
| Lift-off (ignition, vertical) | 0.1 | 421 | 17.4 / 18.5 / 25.8 (25.8) | 1 | 7.0 / 8.4 (8.4) | 8.4 / 17.7 (17.7) | render 14.7 |
| Ascent (pitch programme to M-2 drop) | 2.4 | 8223 | 17.4 / 18.2 / 18.5 (19.2) | 0 | 2.8 / 3.1 (6.3) | 2.8 / 8.1 (10.5) | render 7.4 |
| LEO parking orbit | 2.7 | 8700 | 17.4 / 18.1 / 18.4 (18.8) | 0 | 1.1 / 3.7 (4.5) | 2.0 / 6.6 (8.1) | render 6.3 |
| LEO cockpit (240 frames) | 0.0 | 241 | 17.4 / 18.0 / 18.6 (18.6) | 0 | 2.0 / 2.5 (2.5) | 2.6 / 4.2 (4.2) | render 3.1 |
| TLI and trims | 4.7 | 16171 | 17.4 / 18.2 / 18.5 (22.3) | 0 | 1.1 / 3.3 (4.5) | 2.2 / 4.1 (12.0) | render 3.3 |
| Translunar coast and corrections | 5.2 | 17761 | 17.4 / 18.1 / 18.4 (19.1) | 0 | 1.5 / 2.5 (3.2) | 1.9 / 2.6 (4.6) | render 2.1 |
| LOI and lunar orbit | 6.2 | 21421 | 17.4 / 18.0 / 18.3 (22.2) | 1 | 1.6 / 2.6 (4.0) | 1.9 / 3.1 (18.8) | render 2.6 |
| Lunar descent (PDI coast to touchdown) | 5.5 | 18661 | 17.4 / 18.0 / 18.4 (20.7) | 0 | 1.2 / 3.3 (5.9) | 2.5 / 6.2 (16.8) | render 5.8 |
| Lunar surface | 0.4 | 1651 | 17.4 / 18.0 / 18.2 (18.4) | 0 | 2.0 / 4.7 (5.2) | 2.8 / 4.4 (8.6) | render 3.8 |
| Lunar ascent and circularisation | 3.5 | 12031 | 17.4 / 18.1 / 18.4 (20.2) | 0 | 1.6 / 2.6 (5.1) | 2.5 / 7.3 (12.4) | render 6.8 |
| TEI and coast home | 8.0 | 27392 | 17.4 / 18.0 / 18.2 (20.5) | 0 | 1.5 / 2.5 (3.6) | 1.9 / 2.8 (8.1) | render 2.2 |
| Entry | 3.2 | 11011 | 17.4 / 18.0 / 18.3 (21.9) | 0 | 1.3 / 1.7 (5.4) | 2.5 / 8.2 (12.9) | render 7.8 |
| Chutes and splashdown | 2.1 | 7232 | 17.4 / 18.0 / 18.3 (19.6) | 0 | 1.9 / 2.2 (5.4) | 2.7 / 3.9 (8.3) | render 3.3 |

What the numbers say:

- **GPU: met everywhere, with a wide margin.** The worst segment p99 is 8.4 ms at lift-off and the pad is 6.9 ms;
  everything after the ascent is 1.7-4.7 ms. The heaviest moments are the ones the 17.1 table expected: terrain
  4.1-4.6 ms and atmosphere 1.5-1.6 ms at the pad, ocean 2.6 ms in the vertical climb.
- **rAF: missed in every phase, but not by the game.** rAF p50 is 17.29-17.45 ms in all 80 rows while GPU p50
  runs from 0.75 to 7.0 ms and main-thread p50 from 1.6 to 8.4 ms. The headless frame clock delivers about
  57.5 Hz whatever the load, and there are only 2 deltas of 33 ms or more in the flight (ignition, LOI coast).
  The research page measured 16.667 ms in the same harness. Request `app-integration-8` (lead harness) asks for
  the bare-canvas measurement and for how the rAF lines are to be judged. Until then they cannot be met headless.
- **Main thread: missed in 24 of 80 rows; the renderer's hooks are almost all of it** (stage `render`).
  - The misses come in two groups:
    - near terrain: pad 6.4, lift-off 13.5-17.7, the pitch programme 10.1, the lunar approach / terminal /
      touchdown 10.1 / 13.6 / 9.1, lunar lift-off 10.3. This is the terrain CPU of request `app-integration-7`.
    - every engine burn and the windows right after it: loi:tail 18.8, loi:burn 6.7, deorbit:burn 6.9,
      lunarCircularise 7.3-7.5, entry 8.2, chutes 7.8.
  - The coasts are 2.3-3.9 ms p99.
  - The simulation stage is inside its line except at ignition (3.4 ms p99) and in the vertical climb (2.2 ms),
    against 1.5 ms at 4x.
  - HUD: at most 0.47 ms; the app's own stages: below 0.2 ms.
  - The burn-time spikes are not attributed yet. The windows now record per-feature CPU, so the next run says
    which feature (vfx plume start and stop is the first suspect).
- **Real time** per segment matches the headless table of `sim-world-pilot.md`: entry 3.2 min, lunar braking
  2.7, parking orbit 2.7, wait for TEI (tei:coast) 2.5.

<details><summary>Per pilot phase (80 rows; bold = main-thread p99 over 6 ms)</summary>


| Pilot phase | real min | frames | warp | rAF p50 / p95 / p99 | >= 33 | GPU p50 / p99 | CPU p50 / p99 | stages p99 | GPU features p99 |
|---|---|---|---|---|---|---|---|---|---|
| prelaunch | 0.7 | 2251 | 1-10 | 17.36 / 17.98 / 18.28 | 0 | 6.38 / 6.92 | 4.88 / **6.39** | render 5.6, sim 0.4, hud 0.2 | terrain 4.4, atmosphere 1.5, core 0.8 |
| ignition | 0.1 | 180 | 4 | 17.38 / 18.46 / 25.77 | 1 | 7.02 / 7.79 | 5.37 / **17.69** | render 14.7, sim 3.4, hud 0.5 | terrain 4.6, atmosphere 1.6, core 0.9 |
| vertical | 0.1 | 241 | 4 | 17.39 / 18.52 / 19.62 | 0 | 6.34 / 8.37 | 8.37 / **13.52** | render 11.1, sim 2.2, hud 0.4 | terrain 4.1, ocean 2.6, atmosphere 1.6 |
| pitchProgramme | 0.6 | 1921 | 1 4 | 17.41 / 18.35 / 18.80 | 0 | 3.66 / 4.16 | 4.30 / **10.05** | render 8.8, sim 1.4, hud 0.3 | atmosphere 1.8, terrain 1.1, core 0.8 |
| m1Separation | 0.0 | 150 | 4 | 17.42 / 18.55 / 19.17 | 0 | 3.76 / 4.42 | 3.50 / 5.77 | render 4.7, audio 1.1, sim 1.1 | atmosphere 2.4, vfx 1.1, core 1.0 |
| m2Ascent | 1.7 | 5762 | 4 | 17.38 / 18.13 / 18.54 | 0 | 2.64 / 2.96 | 2.76 / **8.03** | render 7.3, sim 0.7, hud 0.3 | atmosphere 1.8, core 0.8, terrain 0.5 |
| seco | 0.1 | 180 | 1 | 17.35 / 18.00 / 18.50 | 0 | 2.58 / 2.86 | 2.44 / **7.83** | render 7.2, sim 0.7, hud 0.2 | atmosphere 1.6, core 0.5, terrain 0.5 |
| dropM2 | 0.1 | 210 | 4 | 17.40 / 18.00 / 18.43 | 0 | 2.54 / 2.83 | 2.33 / 5.00 | render 4.3, sim 0.6, hud 0.2 | atmosphere 1.7, core 0.5, terrain 0.3 |
| parkingCoast (cockpit) | 0.0 | 241 | 4 | 17.39 / 18.01 / 18.57 | 0 | 2.01 / 2.53 | 2.55 / 4.16 | render 3.1, sim 0.7, audio 0.2 | core 0.9, cockpit 0.8, atmosphere 0.7 |
| parkingCoast | 2.7 | 8700 | 1-100 | 17.40 / 18.11 / 18.42 | 0 | 1.07 / 3.67 | 1.96 / **6.58** | render 6.3, sim 0.3, hud 0.2 | atmosphere 1.5, core 0.8, cockpit 0.4 |
| tli:plan | 0.0 | 120 | 4 | 17.36 / 18.14 / 18.65 | 0 | 1.09 / 1.22 | 2.26 / 4.57 | render 3.7, sim 0.8, hud 0.2 | atmosphere 0.5, core 0.3, sky 0.1 |
| tli:align | 0.4 | 1440 | 1-50 | 17.38 / 18.14 / 18.47 | 0 | 0.90 / 3.78 | 2.19 / 3.70 | render 3.0, sim 0.5, hud 0.2 | atmosphere 1.3, core 0.8, terrain 0.4 |
| tli:coast | 1.6 | 5520 | 1-100 | 17.39 / 18.12 / 18.39 | 0 | 0.87 / 3.36 | 1.81 / **6.69** | render 6.4, hud 0.2, sim 0.2 | atmosphere 1.0, core 0.8, sky 0.3 |
| tli:burn | 1.6 | 5520 | 1 4 | 17.39 / 18.20 / 18.51 | 0 | 1.34 / 3.65 | 2.55 / 4.82 | render 4.0, sim 0.6, hud 0.3 | atmosphere 1.4, core 0.8, vfx 0.5 |
| tli:tail | 0.0 | 121 | 1 | 17.42 / 18.07 / 18.55 | 0 | 1.45 / 4.52 | 2.47 / 3.47 | render 2.5, sim 0.5, hud 0.2 | atmosphere 2.4, core 0.8, vfx 0.6 |
| postTli | 0.1 | 360 | 1 4 | 17.40 / 17.97 / 18.35 | 0 | 1.26 / 2.56 | 2.26 / 3.49 | render 2.9, sim 0.6, hud 0.2 | atmosphere 0.8, core 0.8, sky 0.3 |
| tliTrim:align | 0.3 | 1020 | 1-10 | 17.39 / 18.21 / 18.50 | 0 | 1.61 / 2.68 | 2.09 / 2.77 | render 2.1, sim 0.4, hud 0.2 | core 1.3, sky 0.9, cockpit 0.4 |
| tliTrim:coast | 0.2 | 840 | 1-10 | 17.41 / 18.28 / 18.68 | 0 | 1.73 / 2.76 | 2.17 / 3.55 | render 2.7, sim 0.4, hud 0.2 | core 1.4, sky 0.9, cockpit 0.5 |
| tliTrim:burn | 0.1 | 180 | 1 | 17.42 / 18.41 / 19.71 | 0 | 0.84 / 2.79 | 2.30 / 3.53 | render 2.6, sim 1.2, hud 0.2 | sky 1.0, core 0.8, vfx 0.4 |
| tliTrim:tail | 0.0 | 150 | 4 | 17.40 / 18.44 / 18.96 | 0 | 0.93 / 2.78 | 2.22 / 3.20 | render 2.4, sim 1.0, hud 0.2 | core 1.3, sky 1.0, vfx 0.7 |
| tliTrim:trim | 0.3 | 900 | 4 | 17.43 / 18.20 / 18.76 | 0 | 1.77 / 2.82 | 2.28 / 3.56 | render 2.3, sim 1.2, hud 0.2 | core 1.5, sky 0.9, terrain 0.7 |
| translunar | 1.6 | 5430 | 1-10 | 17.38 / 18.15 / 18.49 | 0 | 1.53 / 2.67 | 2.12 / 2.89 | render 2.3, sim 0.6, hud 0.2 | core 1.4, sky 0.9, terrain 0.6 |
| mcc1:align | 0.3 | 1200 | 1-10 | 17.40 / 18.19 / 18.50 | 0 | 1.67 / 2.83 | 2.07 / 2.69 | render 2.1, sim 0.5, hud 0.2 | core 1.4, sky 1.0, terrain 0.6 |
| mcc1:coast | 0.3 | 930 | 4-10 | 17.40 / 18.17 / 18.46 | 0 | 1.70 / 2.71 | 1.94 / 2.61 | render 2.1, sim 0.3, hud 0.2 | core 1.3, sky 1.1, terrain 0.6 |
| mcc1:burn | 0.1 | 240 | 1 | 17.39 / 18.06 / 18.47 | 0 | 1.85 / 2.99 | 2.17 / 2.76 | render 2.2, sim 0.5, hud 0.2 | core 1.3, sky 1.0, terrain 0.7 |
| mcc1:tail | 0.1 | 180 | 4 | 17.39 / 18.17 / 18.47 | 0 | 1.79 / 3.21 | 2.13 / 2.69 | render 2.2, sim 0.4, hud 0.2 | sky 1.4, vfx 0.8, core 0.8 |
| mcc1:trim | 0.0 | 120 | 10000 | 17.36 / 18.10 / 18.29 | 0 | 1.56 / 2.72 | 2.19 / 2.82 | render 2.2, sim 0.6, hud 0.2 | sky 0.9, core 0.8, terrain 0.5 |
| coastToMoon | 1.6 | 5670 | 50-10000 | 17.39 / 18.08 / 18.39 | 0 | 1.27 / 2.14 | 1.59 / 2.29 | render 1.8, sim 0.2, hud 0.2 | core 1.3, cockpit 0.5, sky 0.4 |
| moonArrival | 0.4 | 1411 | 1-10 | 17.39 / 18.20 / 18.46 | 0 | 1.61 / 2.55 | 1.75 / 2.37 | render 1.9, sim 0.3, hud 0.2 | core 1.3, sky 0.7, cockpit 0.6 |
| mcc2:align | 0.3 | 1170 | 1-10 | 17.41 / 18.21 / 18.47 | 0 | 1.42 / 2.52 | 1.89 / 2.72 | render 2.0, sim 0.4, hud 0.2 | core 1.4, sky 0.6, cockpit 0.4 |
| mcc2:coast | 0.4 | 1290 | 1-10 | 17.40 / 18.22 / 18.42 | 0 | 1.63 / 2.41 | 1.73 / 2.31 | render 1.8, sim 0.3, hud 0.2 | core 1.4, cockpit 0.9, terrain 0.6 |
| mcc2:trim | 0.0 | 120 | 1 | 17.40 / 18.10 / 18.54 | 0 | 1.68 / 2.74 | 1.92 / 4.56 | render 4.0, sim 0.7, hud 0.2 | core 1.5, sky 0.9, terrain 0.5 |
| loi:align | 0.3 | 1200 | 1-10000 | 17.38 / 18.02 / 18.33 | 0 | 1.39 / 2.48 | 1.97 / 3.00 | render 2.4, sim 0.4, hud 0.2 | core 1.4, sky 0.8, vehicle 0.4 |
| loi:coast | 1.7 | 5850 | 1-1000 | 17.38 / 18.09 / 18.38 | 1 | 1.59 / 2.65 | 1.74 / 3.18 | render 2.7, sim 0.2, hud 0.2 | core 1.4, sky 0.8, vfx 0.5 |
| loi:burn | 1.4 | 4920 | 1 4 | 17.35 / 17.97 / 18.28 | 0 | 1.70 / 2.69 | 2.06 / **6.73** | render 6.2, sim 0.4, hud 0.2 | core 1.4, sky 0.7, vfx 0.6 |
| loi:tail | 0.0 | 121 | 4 | 17.37 / 17.85 / 19.34 | 0 | 1.63 / 2.74 | 2.42 / **18.85** | render 18.3, sim 0.4, hud 0.2 | core 1.4, sky 0.9, terrain 0.7 |
| loi:trim | 0.0 | 90 | 4 | 17.36 / 18.17 / 18.58 | 0 | 1.61 / 2.96 | 2.14 / **7.56** | render 6.9, sim 0.4, hud 0.2 | sky 1.0, vfx 0.9, core 0.8 |
| lunarOrbit | 0.0 | 120 | 1 | 17.35 / 18.19 / 18.51 | 0 | 1.47 / 2.58 | 1.95 / 2.61 | render 2.0, sim 0.4, audio 0.2 | core 1.7, sky 1.0, terrain 0.4 |
| planeTrim:align | 0.3 | 1170 | 1-1000 | 17.35 / 18.04 / 18.21 | 0 | 1.52 / 2.79 | 1.88 / 2.85 | render 2.4, sim 0.4, hud 0.2 | core 1.5, sky 0.9, terrain 0.7 |
| planeTrim:coast | 1.1 | 3690 | 1-100 | 17.35 / 17.98 / 18.27 | 0 | 1.55 / 2.62 | 1.77 / 2.48 | render 2.0, sim 0.2, hud 0.2 | core 1.3, sky 0.8, terrain 0.5 |
| planeTrim:trim | 0.0 | 90 | 4 | 17.29 / 17.88 / 18.24 | 0 | 1.51 / 2.63 | 2.03 / 2.70 | render 2.0, sim 0.4, hud 0.2 | core 1.3, sky 0.8, vfx 0.7 |
| deorbit:plan | 0.0 | 60 | 4 | 17.35 / 18.06 / 22.20 | 0 | 1.60 / 2.89 | 1.99 / 3.22 | render 2.6, sim 0.3, hud 0.2 | core 1.5, cockpit 1.0, sky 0.9 |
| deorbit:align | 0.3 | 1140 | 1-100 | 17.36 / 17.96 / 18.28 | 0 | 1.53 / 2.64 | 1.83 / 3.00 | render 2.4, sim 0.4, hud 0.2 | core 1.5, sky 0.8, terrain 0.5 |
| deorbit:coast | 0.6 | 2220 | 1-100 | 17.35 / 17.95 / 18.23 | 0 | 1.54 / 2.43 | 1.77 / 2.88 | render 2.4, sim 0.2, hud 0.2 | core 1.4, terrain 0.7, cockpit 0.3 |
| deorbit:burn | 0.2 | 570 | 1 | 17.35 / 18.07 / 18.92 | 0 | 0.75 / 2.52 | 1.94 / **6.86** | render 6.6, sim 0.3, hud 0.2 | core 1.3, vfx 0.5, sky 0.3 |
| deorbit:tail | 0.0 | 60 | 4 | 17.45 / 18.03 / 18.10 | 0 | 1.67 / 2.73 | 2.09 / 3.05 | render 2.4, sim 0.3, hud 0.2 | core 1.0, sky 0.9, terrain 0.9 |
| deorbit:trim | 0.0 | 120 | 100 | 17.33 / 18.00 / 18.20 | 0 | 1.54 / 2.46 | 2.13 / 3.47 | render 2.8, sim 0.4, hud 0.3 | core 1.3, cockpit 0.9, vfx 0.4 |
| pdiCoast | 1.7 | 5851 | 1-100 | 17.36 / 18.00 / 18.25 | 0 | 1.52 / 2.87 | 2.09 / 3.77 | render 3.1, sim 0.3, hud 0.2 | core 1.2, sky 0.6, terrain 0.6 |
| braking | 2.7 | 9180 | 1 4 | 17.37 / 18.10 / 18.42 | 0 | 1.04 / 3.29 | 2.52 / **7.26** | render 6.7, sim 0.8, hud 0.2 | terrain 1.1, core 0.9, vfx 0.4 |
| approach | 0.4 | 1410 | 1 | 17.36 / 18.07 / 18.54 | 0 | 1.46 / 3.55 | 3.44 / **10.12** | render 9.6, sim 0.6, hud 0.2 | terrain 1.7, core 0.9, vfx 0.4 |
| terminal | 0.6 | 1920 | 1 | 17.37 / 18.02 / 18.36 | 0 | 2.49 / 4.29 | 3.66 / **13.56** | render 13.2, sim 0.4, hud 0.2 | terrain 2.0, core 0.9, vfx 0.8 |
| touchdown | 0.2 | 300 | 1 | 17.45 / 18.04 / 20.30 | 0 | 2.23 / 4.31 | 4.90 / **9.08** | render 8.5, sim 0.7, hud 0.2 | terrain 2.7, core 1.1, vfx 0.5 |
| touchdown (cockpit) | 0.0 | 241 | 100 | 17.40 / 17.96 / 18.24 | 0 | 1.69 / 4.41 | 2.38 / 4.81 | render 4.3, sim 0.3, hud 0.1 | terrain 2.0, core 1.4, cockpit 1.0 |
| surface | 0.4 | 1410 | 1-10 | 17.38 / 18.02 / 18.25 | 0 | 2.05 / 4.72 | 2.79 / 4.35 | render 3.8, sim 0.2, hud 0.2 | terrain 2.9, core 1.2, cockpit 0.3 |
| lunarLiftoff | 0.2 | 751 | 1 4 | 17.36 / 18.10 / 18.41 | 0 | 1.68 / 3.27 | 4.66 / **10.31** | render 9.8, sim 0.8, hud 0.2 | terrain 1.2, core 1.0, vfx 0.6 |
| lunarAscent | 1.7 | 5940 | 4 | 17.38 / 18.18 / 18.70 | 0 | 1.67 / 2.60 | 2.72 / **7.92** | render 7.0, sim 1.0, hud 0.2 | core 1.2, vfx 0.4, sky 0.4 |
| lunarCircularise:align | 0.3 | 1050 | 1-50 | 17.38 / 18.01 / 18.35 | 0 | 1.45 / 2.58 | 2.10 / 3.13 | render 2.5, sim 0.4, hud 0.2 | core 1.4, cockpit 0.8, sky 0.5 |
| lunarCircularise:coast | 1.1 | 3660 | 1-100 | 17.37 / 17.98 / 18.30 | 0 | 1.46 / 2.60 | 1.99 / 2.86 | render 2.4, sim 0.2, hud 0.2 | core 1.4, cockpit 0.8, terrain 0.4 |
| lunarCircularise:burn | 0.1 | 390 | 1 | 17.35 / 17.98 / 18.15 | 0 | 1.74 / 2.65 | 2.25 / **7.54** | render 7.2, sim 0.3, hud 0.2 | core 1.5, cockpit 0.6, vfx 0.4 |
| lunarCircularise:tail | 0.0 | 60 | 1 | 17.35 / 18.04 / 18.30 | 0 | 1.72 / 2.72 | 2.27 / **7.27** | render 6.9, sim 0.2, hud 0.2 | core 1.4, vfx 0.7, cockpit 0.6 |
| lunarCircularise:trim | 0.0 | 90 | 4 | 17.30 / 17.83 / 18.00 | 0 | 1.43 / 2.92 | 2.27 / **7.52** | render 6.9, sim 0.4, hud 0.2 | core 1.8, sky 0.9, cockpit 0.5 |
| lunarOrbitReturn | 0.0 | 90 | 1 | 17.39 / 18.31 / 18.53 | 0 | 1.55 / 2.94 | 2.09 / 2.85 | render 2.0, sim 0.7, hud 0.2 | core 1.6, cockpit 0.9, vfx 0.9 |
| tei:plan | 0.1 | 390 | 1 4 | 17.40 / 18.01 / 18.44 | 0 | 1.43 / 2.45 | 2.17 / 2.88 | render 2.3, sim 0.5, hud 0.2 | core 1.4, sky 1.0, cockpit 0.9 |
| tei:align | 0.3 | 930 | 1-1000 | 17.37 / 18.06 / 18.25 | 0 | 1.49 / 2.59 | 2.09 / 2.77 | render 2.2, sim 0.3, hud 0.2 | core 1.4, cockpit 0.9, sky 0.3 |
| tei:coast | 2.5 | 8730 | 1-1000 | 17.35 / 17.94 / 18.21 | 0 | 1.47 / 2.80 | 1.81 / **6.80** | render 6.5, sim 0.2, hud 0.2 | core 1.4, sky 0.7, cockpit 0.6 |
| tei:burn | 0.8 | 2880 | 1 4 | 17.37 / 17.98 / 18.29 | 0 | 1.74 / 2.62 | 2.21 / 3.15 | render 2.7, sim 0.4, hud 0.2 | core 1.4, cockpit 0.7, sky 0.6 |
| tei:tail | 0.0 | 90 | 4 | 17.39 / 18.14 / 18.31 | 0 | 1.74 / 2.54 | 2.19 / 3.30 | render 2.6, sim 0.4, hud 0.2 | core 1.5, vfx 0.7, terrain 0.7 |
| tei:trim | 0.0 | 60 | 4 | 17.29 / 18.02 / 18.23 | 0 | 1.64 / 2.77 | 2.19 / 2.73 | render 2.1, sim 0.4, hud 0.2 | core 1.3, terrain 0.7, vfx 0.6 |
| coastFromMoon | 1.4 | 4801 | 10-1000 | 17.35 / 17.94 / 18.18 | 0 | 1.56 / 2.46 | 1.86 / 2.78 | render 2.3, sim 0.2, hud 0.2 | core 1.3, cockpit 0.8, vfx 0.5 |
| transEarth | 1.9 | 6691 | 1-10000 | 17.35 / 17.97 / 18.26 | 0 | 1.47 / 2.40 | 1.86 / 2.47 | render 2.1, sim 0.2, hud 0.2 | core 1.4, sky 0.5, cockpit 0.4 |
| tec1:plan | 0.0 | 120 | 1 | 17.44 / 18.05 / 18.35 | 0 | 1.44 / 2.20 | 2.16 / 2.81 | render 2.1, sim 0.5, hud 0.2 | core 1.3, sky 1.0, cockpit 0.5 |
| tec1:align | 0.3 | 990 | 1-10 | 17.34 / 18.00 / 18.26 | 0 | 1.32 / 2.12 | 2.03 / 2.68 | render 2.2, sim 0.3, hud 0.2 | core 1.3, cockpit 0.8, sky 0.4 |
| tec1:coast | 0.4 | 1350 | 4-10 | 17.35 / 17.98 / 18.26 | 0 | 1.32 / 2.30 | 2.00 / 2.71 | render 2.3, sim 0.2, hud 0.2 | core 1.3, cockpit 0.7, sky 0.5 |
| tec1:burn | 0.1 | 210 | 1 | 17.36 / 18.11 / 18.38 | 0 | 1.73 / 2.66 | 2.19 / 2.75 | render 2.2, sim 0.3, hud 0.2 | core 1.3, vfx 0.8, cockpit 0.7 |
| tec1:tail | 0.0 | 90 | 4 | 17.33 / 17.88 / 18.01 | 0 | 1.62 / 2.50 | 2.25 / 2.56 | render 2.2, sim 0.3, hud 0.2 | core 1.5, vfx 1.0, cockpit 0.8 |
| tec1:trim | 0.0 | 60 | 4 | 17.33 / 18.00 / 18.31 | 0 | 1.56 / 2.27 | 2.23 / 2.63 | render 2.1, sim 0.5, hud 0.2 | core 1.3, vfx 0.9, cockpit 0.3 |
| entryPrep | 0.0 | 150 | 1 | 17.35 / 17.83 / 18.08 | 0 | 1.57 / 2.62 | 2.12 / 3.27 | render 2.5, sim 0.3, hud 0.3 | core 1.3, cockpit 0.4, sky 0.3 |
| entry | 3.2 | 10861 | 4-50 | 17.37 / 18.02 / 18.35 | 0 | 1.31 / 1.74 | 2.52 / **8.24** | render 7.8, sim 0.7, hud 0.2 | atmosphere 1.0, core 0.5, cockpit 0.2 |
| chutes | 0.5 | 1771 | 4 | 17.37 / 18.01 / 18.32 | 0 | 1.70 / 1.96 | 2.59 / **7.75** | render 7.2, sim 0.5, hud 0.2 | atmosphere 1.3, core 0.4, cockpit 0.1 |
| splashdown | 1.6 | 5461 | 4 | 17.36 / 18.02 / 18.31 | 0 | 1.89 / 2.26 | 2.77 / 3.95 | render 3.3, sim 0.7, hud 0.2 | atmosphere 1.5, core 0.5, terrain 0.1 |

</details>

### Milestone pictures (out/screens/mission/, all looked at)

Chase view at every milestone, plus the cockpit at the parking orbit (17.1 "LEO cockpit") and on the lunar surface
(18.3). The pictures are taken live (not deterministic) at 2560 x 1440 with the HUD on. No NaN pixel in the HDR
target in any of them. What looks wrong is noted for the visual close-out and was not fixed here.

| Picture | What it shows | What looks wrong |
|---|---|---|
| `00-pad-chase` | the stack at the tower on the pad, water tower, light masts, clouds, HUD launch panel, "TEST PILOT · prelaunch", rails x100 (waiting out the launch window) | beyond the pad apron the land is drawn as open sea right after boot at 1440p (terrain not resident yet: `app-integration-6` / `-7`); 40 s later, in the lift-off picture, the lava plain is there |
| `01-liftoff-chase` | lift-off at 21.6 m, white exhaust cloud around the base, lava plain with scrub, "Liftoff" banner | no flame visible at the nozzles, only smoke |
| `02-max-q-chase` | the stack pitched over at 15 km above broken cloud and the island, Mach 1.69, 23.8 kPa | plume short and faint for full thrust at 15 km |
| `03-stage-sep-1-chase` | M-1 falling away behind the burning M-2 at 77 km, Earth limb with atmosphere | white horizontal streaks across the left third of the frame (stretched particles?); the M-2 plume does not widen at 77 km |
| `04-fairing-jettison-chase` | fairing halves falling away, the escape tower leaving with its motors burning, M-2 burning at 97 km | HUD resources show "Meridian M-2 0 %" while the record has M-2 at 95 % and the stage panel 6,041 m/s (flight-ui) |
| `05-stage-sep-2-chase`, `06-earth-orbit-chase` | spent M-2 behind M-3 and the spacecraft at 184 km over the cloud deck, Earth limb, "Earth Orbit" banner | a cloud of small white rectangles around the stack (separation particles drawn as hard-edged sprites) |
| `06-earth-orbit-cockpit` | the commander's view of the panel: navball instrument, MFD on FLT, switch rows | the cabin is nearly black in daylight LEO; the displays are barely legible; nothing bright through the window |
| `07-tli-complete-chase` | the stack seen tail-on into the Sun at 300 km, "Tli Complete" | a large starburst under the vehicle and a ghost ring top left fill the frame; vehicle small; no Earth in frame; the banner title-cases the id ("Tli", should read TLI) |
| `08-moon-soi-enter-chase` | the spacecraft at 64,360 km from the Moon, "Entering Moon sphere of influence" | the vehicle is a few dark pixels in a black frame: no stars, no Moon, no Earth; "Moon Soi Enter" (SOI) |
| `09-lunar-orbit-chase` | lunar orbit at 105 km, LOI tail | the Sun's starburst fills the frame and the vehicle is barely visible beside it; the Moon is not in frame at all, at 105 km |
| `10-lunar-touchdown-chase` | the lander on grey regolith with small craters and boulders, black sky, 1.9 m from the target, "Lunar Touchdown" | believable. The lander casts no visible shadow and the camera is far off (the lander is about 130 px of 1,440) |
| `10-lunar-touchdown-cockpit` | the cabin on the Moon | nearly black (9.6 % non-black, below the spec's threshold): only the MFD and a sliver of the window show |
| `11-lunar-liftoff-chase` | the ascent stage at 54 m going up | the chase eye is below the stage looking up into a black sky: neither the ground nor the descent stage left behind is in frame; the stage is dark |
| `12-moon-soi-exit-chase`, `13-earth-perigee-targeted-chase` | the ascent stage and capsule at 360,000 km, "Moon Soi Exit", "Earth Perigee Targeted" | vehicle tiny on black; no stars, no Earth, no Moon; HUD shows Mach 91.4 in vacuum |
| `14-entry-interface-chase` | the capsule at 121 km against the starfield, entry panel (14 kW/m^2, chute envelope UNSAFE) | Earth not in frame at the entry interface (the eye looks away from the planet); no plasma yet, which is correct this early |
| `15-drogue-deploy-chase` | two drogues above the capsule at 7.3 km | uniform dark navy around them, no horizon (dawn, about 05:56 local solar time, eye looking up at the zenith). 21.5 % non-black, below the spec's 30 % for low-altitude pictures. HUD "Chute envelope RISKY" while the record says inside the envelope |
| `16-main-deploy-chase` | three striped mains above the capsule at 3.1 km | same dark navy background, no horizon; canopies soft and blotchy |
| `17-splashdown-chase` | the capsule upright in the swell with a foam ring, dawn cumulus, "Test pilot finished", "Splashdown" | good. The frame is far brighter than the chute pictures six minutes earlier (framing or exposure) |

Overall: from TLI to the entry the chase pictures show neither the Earth nor the Moon, and the vehicle is a few dozen
pixels in the middle of a black frame or next to the Sun. The chase rig's framing in deep space is the largest
visual gap of the flight. Both cockpit pictures are nearly black.

### Failures and diagnosis

1. **rAF budgets (all phases): harness, not game.** See above. Request `app-integration-8` (lead harness,
   blocking for the rAF lines). Nothing in `src/app` paces frames: the loop is one rAF callback per frame.
2. **Main-thread p99 (24 rows): renderer hooks.** Terrain near the ground (`app-integration-7`, open). The
   burn-time rows are attributed since (see "Measured", 2026-11-11 night): the cockpit's ORB display painted in
   the chase view while the orbit changes (`app-integration-12`). The mission spec's windows now carry the app's
   per-frame feature times and each window's two slowest frames with their breakdown, so the next flight shows
   it per phase. The budget line is not loosened.
3. **Two deltas of 33 ms or more** (ignition, LOI coast) out of 153,167 frames.
4. **Image statistics.**
   - `10-lunar-touchdown-cockpit` (9.6 % non-black): a real finding. The cabin is nearly black on the sunlit
     Moon (cockpit visual close-out).
   - `15-drogue-deploy-chase` (21.5 % against the spec's 30 %): a dark dawn sky seen at the zenith. Whether
     that is right or too dark is for the atmosphere / sky close-out. The spec's threshold for low-altitude chase
     pictures stays as it is until they decide.
5. No gate of the flight failed and no error was raised. The flight needs no fix in `src/app` and no package
   request.

## Requests filed

| Request | Owner | State | One line |
|---|---|---|---|
| `app-integration-1` | render-core | resolved (`fdf3cde`) | `PerfSnapshot.cpu` never held the app's `'frame'` zone |
| `app-integration-2` | lead harness | resolved (`37932b8`) | `tests/browser/shell/shell.spec.ts` asserted the old boot shell |
| `app-integration-3` | camera (flight-ui) | resolved (flight-ui round 5) | chase camera started behind the launch tower on the pad |
| `app-integration-4` | flight-ui HUD | resolved (`d9f9413`, `2bd0a88`) | ENTRY panel replaces the ORBIT panel during the ascent (1 kW/m^2 heating threshold) |
| `app-integration-5` | cockpit / core | resolved (cockpit round) | plume local lights lit the cabin interior through the hull |
| `app-integration-6` | terrain-render | resolved (`189d1e2`) | land around the pad drawn as sea for about a second after a map round trip |
| `app-integration-7` | terrain-render | resolved (`189d1e2`; addendum with per-frame numbers) | terrain never idle at 1440p (tile pool full, ~300-430 uploads stalled for ever); terrain `prepare` on the main thread |
| `app-integration-8` | lead harness | resolved (lead-baseline-v2: `870d19e`, `050b2b3`, `37c6668`) | headless rAF clock at ~57.5 Hz (p50 17.4 ms in every mission phase, whatever the load): rAF budgets cannot be judged |
| `app-integration-9` | flight-ui HUD, src/input | resolved (`cc8e8cb`, `e4d5188`; wired in `1b9f665`) | the capture pill as an explicit switch that also releases, a switch to hide it, `InputSystem.releaseKeyboardCapture` |
| `app-integration-10` | src/camera (shared code), vehicle data | resolved (`1e5bceb`, NOTICE-core-4) | chase default framing in deep space: distance by the vessel's size after separations, the nearest body in frame, the Sun out of it (pictures 07-14 of the mission). The new default needs no wiring (`createChaseRig({ defs, terrain })` as before); `rig.resetView()` exists and is not bound to a key |
| `app-integration-11` | render core, terrain-render, atmosphere | open; parts 2-7 done (`189d1e2`, `aea5efa`, `1e5bceb`, `cce44d3`) and wired here (`TerrainDebug.residency`, `setUploadBudget`, `CoreShaderLibrary.compilations`, `MeshSystem.loads`, `AtmosphereFeature.status`); part 1: the core's `shaders.warm` exists (`038cf6f`) and the app awaits `renderer.warm()` (`732962c`; 2.0 s in the browser on 2026-11-12); what is left is in "Measured", 2026-11-12 14:49 | load time: synchronous pipeline compiles hold the first 19 frames for 14 s, terrain streams only afterwards and one level per round trip; counts the loading screen lacks (terrain residency by level, shader and texture totals, atmosphere status) |
| `app-integration-12` | cockpit, flight-ui MFD painter | answered: items 1-2 by the cockpit (round 4), item 3 by flight-ui (round 7); confirmed by the run of 2026-11-12 (no display paint in the chase view, burn 3.88 ms p99) | the cockpit's displays are painted in the chase view; the ORB page costs 5.2-5.7 ms per paint while the orbit changes; 16-26 ms in the lift-off frame |
| `app-integration-13` | sim-world-pilot, vfx, audio | open | one-off costs in the ignition and lift-off frames: sim 5.9-6.4 ms (10-23 ms under load on 2026-11-12), first plume frame 1.5-2.8 ms, audio 1.5-1.9 ms |
| `app-integration-14` | flight-ui (src/input/bindings.ts) | resolved (`b90ade9`; wired in `732962c`) | a key for the chase rig's `resetView()`: a presentation action `ui:resetCamera` on `Home` |

Also answered in `732962c`: `core-5` (the feature wrapper carries every member of the contract), the app's line
of `core-6` (the V key and the seat's name), the app's half of `lead-3` (`window.__test.renderExact`) and of
`app-integration-11` part 1 (`await renderer.warm()`).
Earlier: `map-view-5` (the app shell part; its labs/integration part was then resolved by core-support),
`flight-ui-7` (the capture switch's release and hide option wired, fullscreen state passed on) and the app part of
`flight-ui-3` (map obstacle selectors of the round-6 HUD), both in `1b9f665`; `flight-ui-10` (the HUD's obstacle
list imported from `@/ui`) and `cockpit-15` (the mission spec waits on the exposure read-out after a view
switch), both in `83c80f1`.

## Known limits

- The browser mission flies and passes every gate (2026-11-11 and 2026-11-12). Missed in the flight of
  2026-11-12: main-thread p99 in 6 of 80 phases (lift-off, the first kilometres, the last 600 m over the Moon:
  the terrain's hooks), rAF p99 in 17 phases and the 18.2 line "p95 < 16.7 ms" in all of them (a 60 Hz clock
  cannot meet it). See "Browser mission".
- What the flight's pictures show wrong is listed picture by picture under "Browser mission": no dust or plume
  at the lunar landing and lift-off, drawn-looking ribbons in the sea's glint at max Q, a box-shaped dark patch
  on the water at the capsule after the splash, the plasma burning the picture out at peak g, flat grey cockpit
  windows with the Sun or the plasma in them, and no open chute in any frame.
- The main-thread CPU line is missed in three measured situations at 1440p (pad 6.7, first kilometre 6.5, engine
  burns 7.1 ms p99) and in the lift-off frame (30 ms); every part of it is attributed and requested (-7, -12,
  -13). Nothing in `src/app` contributes more than 0.15 ms.
- Loading takes 33-34 s on the pad on this machine (2026-11-12, quiet); the screen is honest about it but it is
  long. Where the time goes is in "Measured", 2026-11-12 14:49.
- The chase view's default framing changed in `src/camera` while this round ran (request -10, NOTICE-core-4): the
  app needs no wiring for it and none was done; the mission's deep-space pictures have not been re-shot with it
  (`start-trans-earth.png` of the night's third run predates it).
- The mission spec's picture flow ran in the flight of 2026-11-12: all 36 stops fired (the `'splash'` and
  `'touchdown'` events, the heating peak past 1 MW/m^2, the load peak past 3 g). It does not roll heads-down for
  its Earth-orbit cockpit picture and does not zoom out for the chutes.
- The `qa-leo` scenario starts heads-up (`data/defs/scenarios/qa-leo.json`, not the app's): left as it is; the
  low-orbit test rolls the stack heads-down through the keys before its cockpit pictures.
- Corrected after the flight of 2026-11-12 and not run in a browser since: `bodiesInFrame()` below a body's
  reference radius, and the mission spec's read-out of a window's slowest frames.
- `isIdle()` at 1440p on the pad: true since the pool work for app-integration-7 (`189d1e2`; idle in the second
  run of the night, never idle in the first).
- Not exercised in a browser spec: abort, RCS / gear / lights / fine-control keys, vessel cycling, a node drag in
  the map, the 144 / 240 Hz paths.
