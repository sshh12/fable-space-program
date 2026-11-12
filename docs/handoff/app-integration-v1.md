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
See "Browser mission". Eight requests filed; four resolved.

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

## Browser mission (ARCHITECTURE 18.2)

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

`tests/browser/mission/lunar-direct.spec.ts` opens `/?scenario=lunar-direct&pilot=1&view=chase&capture=0&scale=1&governor=off`
at 2560 x 1440 (1440p internal, qualityScale 1: the conditions of the budget table) under the machine-wide GPU lock.
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
2. **Main-thread p99 (24 rows): renderer hooks.** Terrain near the ground (`app-integration-7`, open). Burn-time
   spikes are not attributed yet; the spec now records per-feature CPU for the next run. The budget line is not
   loosened.
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
| `app-integration-4` | flight-ui HUD | open | ENTRY panel replaces the ORBIT panel during the ascent (1 kW/m^2 heating threshold) |
| `app-integration-5` | cockpit / core | resolved (cockpit round) | plume local lights lit the cabin interior through the hull |
| `app-integration-6` | terrain-render | open | land around the pad drawn as sea for about a second after a map round trip |
| `app-integration-7` | terrain-render | open | terrain never idle at 1440p (tile pool full, ~300-430 uploads stalled for ever) |
| `app-integration-8` | lead harness | open (blocking for the rAF lines) | headless rAF clock at ~57.5 Hz (p50 17.4 ms in every mission phase, whatever the load): rAF budgets cannot be judged |

Also answered: `map-view-5` (the app shell part; its labs/integration part was then resolved by core-support).

## Known limits

- The browser mission flies and passes every gate. Its frame-time budgets are missed: rAF (harness clock,
  `app-integration-8`) and main thread (renderer hooks, `app-integration-7` and the burn-time spikes). See "Browser mission".
- From TLI to the entry the chase pictures show neither the Earth nor the Moon; both cockpit pictures are nearly
  black (for the visual close-out).
- The main-thread CPU line is missed (above); the renderer's per-feature CPU is the place to look first.
- `isIdle()` never becomes true at 1440p on the pad (app-integration-7): deterministic screenshots at the budget
  resolution must wait for that request.
- Not exercised in a browser spec: abort, RCS / gear / lights / fine-control keys, vessel cycling, a node drag in
  the map, the 144 / 240 Hz paths.
