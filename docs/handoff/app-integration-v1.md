# Hand-off: app integration v1

`src/app` wires the ORIGINAL game: one page (`index.html` -> `src/app/main.ts`) with the real simulation
(`createSim(defs, scenarioId, { terrain })`), every render feature, the HUD with the navball, the map view, the
three camera rigs and the view manager, the flight controller, the cockpit display keys, audio, pause, time warp
through the controls, the beforeunload guard, the scripted test pilot inside the page and `window.__test`.
Every subsystem is attached through its contract or its documented public factory; nothing reaches into a
package's internals and nothing writes simulation state.

**State (2026-11-11 evening):** done and verified in real Chrome: a player can open `/`, see the vehicle on the
real pad under the real sky, fly it with the keyboard (throttle, staging, SAS, views, map, warp, pause), and the
test pilot flies through the same controls inside the page (`/?pilot=1`). Not yet done: the Playwright `mission`
project (the 45-minute end-to-end flight through `window.__test.pilot`; the API it needs is in place and proven
for the first two kilometres of the ascent); the CPU line of ARCHITECTURE 17 is missed (see "Measured"). Seven
requests filed; four resolved during this run.

## API of src/app

| File | What |
|---|---|
| `main.ts` | Entry: `installTestApi` first, `acquireGpu`, `loadDefs`, scenario choice, `createGame`, `installGameTestHooks`; `window.__test.ready` after three presented frames (false, with the error in `errors` and the `#fatal` box shown, when boot fails) |
| `settings.ts` | `readSettings(query): AppSettings`; `isMissionScenario(s)`; `defaultScenario(defs)` (first scenario in id order that is a mission proof: pad start, nothing fired, milestone rules, i.e. `lunar-direct` today, chosen by the data: no id in code); `resolveScenario(defs, requested)` (unknown id: error naming the defined ones) |
| `game.ts` | `createGame(deps: GameDeps): Promise<Game>`: builds and owns every subsystem and runs the frame loop. `Game` exposes the subsystems plus `snapshot()`, `camera()`, `paused` / `setPaused`, `setDeterministic`, `setTestControls`, `setView`, `setCameraOrbit`, `frames`, `inFlight()`, `stop()` |
| `features.ts` | `createGameFeatures(deps: FeatureDeps): GameFeatures`: every RenderFeature through its factory, in registration order, with the cockpit's `CockpitControls`, the map's `MapViewApi` and `packageOf`; `MILKY_WAY_FACE_SIZE = 2048` |
| `pilot.ts` | `createPilotDriver(defs, sim): PilotDriver` (`engaged`, `pilot`, `start()`, `stop()`, `onControlTick`, `afterFrame()`): the mission pilot of `src/pilot` in `Sim.advance`'s control ticks |
| `statusLine.ts` | the shell's own line, centred under the HUD's top column: PAUSED (amber), and "TEST PILOT · <phase>" while the pilot flies; hidden with the HUD |
| `timing.ts` | main-thread time of the frame function and of its stages input, map, controls, sim, views, hud, audio, render (rolling 300 frames) |
| `testHooks.ts` | `installGameTestHooks(testApi, game)`: `window.__test` (TestApi) and `window.__app` (`AppDebug`, `AppBrief`) |

Query parameters (all optional): `scenario=<id>`, `pilot=1` (the test pilot starts when the page is ready),
`view=chase|cockpit|map`, `capture=0` (no fullscreen / keyboard-lock request on the first gesture; the specs use
it to keep the viewport), `perf=features` (render-core attribution mode), `scale=<0.25..1>` (pinned render
scale), `governor=off`, `hud=0`, `mute=1`. None of them touches physics; the scenario is recorded in
`SimSnapshot.scenario` (only a pad start with nothing fired and `cheatCounter` 0 is a mission proof).

### Boot

`acquireGpu` -> `loadDefs('/defs')` -> scenario -> `createTerrainProvider(defs, createFetchTileSource('/tiles'))`
-> `createSim` -> `createRenderer(canvas, gpu, defs, { onError, perfFeatures, quality, governor })`, resized to
the canvas's CSS size times the device pixel ratio on every ResizeObserver change -> navball renderer published as
`'ui.navball'` -> input system, HUD (mounted in `#ui-root`), flight controller, status line -> view manager ->
features -> audio engine; then the features' start-up, `audio.init(defs, '/assets/audio')` and `sim.ready` are
awaited together; then the loop starts. Boot to `ready` at the pad: 25-40 s in the specs with the machine shared
(shader compiles, sky data, the pad's terrain, 38 sound assets).

### Frame (ARCHITECTURE 5)

```
realDt = clamp(now - last, 0, 0.1 s)                (1/60 s in deterministic mode); ctx.perf.cpuBegin('frame')
f = input.sample();  F2 -> hud.setVisible, ` -> key help, P -> pause
mapView.setActive(lastCamera.kind == 'map'); map = mapView.update(lastSnapshot, lastCamera, sim.commands, f.pointer, cssSize)
    every 10th frame in map view: mapView.setObstacles(HUD panel boxes)           (request map-view-5)
unless paused or the test pilot flies:
    sim.setControls(controller.update(f, lastSnapshot, sim.commands, realDt, { view: lastCamera.kind, pointerCaptured: map.consumed })
                    with the axes held through window.__test.setControls)
mfdCycle:i -> cockpitControls.cyclePage(i)
unless paused: sim.advance(realDt, pilot engaged ? onControlTick : undefined)
snapshot = sim.snapshot()                            (pilot done / gave up: back to the keyboard, lever = applied throttle)
view = viewManager.update(snapshot, mapper.map(f, realDt, { pointerConsumed: map.consumed, focus: map.focus }), realDt, f.pressed)
hud.update(snapshot, view.camera, realDt)            (renders the navball texture)
audio.update({ snapshot, listener: view.listener, realDt, warpFactor: snapshot.warp.factor, paused })
renderer.render(snapshot, view.camera, view.observers, realDt)
ctx.perf.cpuEnd('frame'); window.__test frameDone
```

Rigs: chase (`createChaseRig({ defs, terrain })`), cockpit (`createCockpitRig({ defs })`), map
(`createMapRig({ defs })`), in that order (C cycles chase and cockpit, M toggles the map); the view manager gets
the terrain for the LOD observers. Exposure: the rigs' own settings (compensation 0; the map rig's 0.005 fill
light and EV100 floor 9); nothing was changed in the app after looking at the pictures (see "Pictures"). A
frame that throws stops the loop, is reported to `window.__test.errors` and shows the `#fatal` box. Audio is
resumed on every keydown and pointerdown (capture phase). The beforeunload guard (`installUnloadGuard`) asks
while `inFlight()`: the mission has not failed and (a stage has fired or the scenario did not start on a pad).
A failed mission offers "Revert to launch" (pad scenarios; "Restart scenario" otherwise) on the HUD banner: a page
reload, i.e. a fresh simulation.

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

What the Playwright mission (ARCHITECTURE 18.2) uses: open `/?pilot=1&capture=0` (or call `pilot.start()`), poll
`window.__app.brief().milestones` / `window.__test.milestones()`, `pilot.done()` / `failure()`, `state()` for the
gates (`cheatCounter`, `scenario`, `mission`, `terrain.incompleteQueries`), `setView` + screenshots at milestones,
`perf()` under the GPU lock, `audio()`; real key presses for the binding segments (they act whenever the pilot is
stopped).

### window.__app (AppDebug, for the app's specs)

`features()`, `featureOrder()`, `cpu()` / `resetCpu()`, `exposure()`, `viewMode()`, `viewBlending()`,
`hudVisible()`, `keyboardLocked()`, `heldCodes()`, `paused()`, `frames()`, `lever()`, `simStats()`, `inFlight()`,
`notifications()`, `pilotReport()`, `mfdPages()`, `brief()` (a few numbers of the latest snapshot, cheap to
poll), `frameLights()` (local lights of the last frame), `busyFeatures()` (what `isIdle()` waits for),
`terrainStats()` (the terrain's stream counters, selection and per-frame CPU).

## How to run

```
npm run dev                         # then open http://127.0.0.1:<port>/ (baked tiles under data/tiles, sky under data/sky)
/?pilot=1                           # watch the test pilot fly the mission (about 45 minutes)
npm run typecheck:paths -- src/app tests/browser/app
npx vitest run tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.spec.ts --project=functional   # about 5 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.perf.spec.ts --project=perf     # about 4 min
```

Specs (`tests/browser/app/app.spec.ts`): boots on the pad with every feature, the real sim and no error; keyboard
(throttle Z / X / Shift, SAS T and 1, Tab, 9, C, M, `.` and `/`, P, F2); a short real flight (Z, T, Space,
lift-off, climb to 4 km with pictures in every view, engines heard); the scripted test pilot inside the page (from
the pad through the launch window to 2 km, then stopped); the game's default capture (first key press: fullscreen
and keyboard lock both granted in headless Chrome). `app.perf.spec.ts`: pad and climb at 1440p internal (budget
assertions, soft) and at 720p (recorded).

## What a human sees when pressing each key

| Key | What happens (verified in the specs unless marked) |
|---|---|
| (first key or click) | fullscreen and the keyboard lock are requested; the HUD's "Capture keyboard" pill turns to captured; sound starts |
| Z / X | throttle lever to 100 % / 0 % (the HUD's throttle tape follows) |
| Shift / F | lever up / down at 0.5 per second (Left Ctrl too while the keyboard is locked) |
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
| arrows, PgUp/PgDn, mouse drag, wheel | orbit / look and zoom the camera |
| [ / ] | switch between controllable vessels in the bubble (not exercised: none at the pad) |
| ` | key-help sheet generated from the binding table |

## Measured

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
  (app-integration-6, open).

## Requests filed

| Request | Owner | State | One line |
|---|---|---|---|
| `app-integration-1` | render-core | resolved (`fdf3cde`) | `PerfSnapshot.cpu` never held the app's `'frame'` zone |
| `app-integration-2` | lead harness | resolved (`37932b8`) | `tests/browser/shell/shell.spec.ts` asserted the old boot shell |
| `app-integration-3` | camera (flight-ui) | resolved (flight-ui round 5) | chase camera started behind the launch tower on the pad |
| `app-integration-4` | flight-ui HUD | open | ENTRY panel replaces the ORBIT panel during the ascent (1 kW/m^2 heating threshold) |
| `app-integration-5` | cockpit / core | resolved (cockpit round) | plume local lights lit the cabin interior through the hull |
| `app-integration-6` | terrain-render | open | land around the pad drawn as sea for about a second after a map round trip |
| `app-integration-7` | terrain-render | open | terrain never idle at 1440p (tile pool full, ~300-430 uploads stalled for ever) |

Also answered: `map-view-5` (the app shell part; its labs/integration part was then resolved by core-support).

## Known limits

- The browser mission (Playwright `mission` project, about 45 minutes) is not written yet; next step.
- The main-thread CPU line is missed (above); the renderer's per-feature CPU is the place to look first.
- `isIdle()` never becomes true at 1440p on the pad (app-integration-7): deterministic screenshots at the budget
  resolution must wait for that request.
- Not exercised in a browser spec: abort, RCS / gear / lights / fine-control keys, vessel cycling, a node drag in
  the map, the 144 / 240 Hz paths.
