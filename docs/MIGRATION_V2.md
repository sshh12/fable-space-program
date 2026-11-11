# Migration to architecture v2

The refactor map from the code as it stands at the end of wave 2 to `docs/ARCHITECTURE_V2.md`: per contract
file and per module, what is kept, what is changed in place and how, what is restructured, in which order
so the tree stays green, and which wave-2 output is at risk. Package ids refer to
`docs/WORK_PACKAGES_V2.json`.

Sources: `docs/research/v2/codebase-audit.md` (the assumption inventory, measured on the tree of
2026-11-10; line numbers below are from it), the three proposals' refactor sections, and the contracts and
tree as read on 2026-11-10. Nothing in this file has been executed.

---

## 1. Principles

1. **Refactor in place, never wrap.** There is one execution path: the island and the universe. The
   single-player mission, every lab, the calibration flight, the client replica and the servers run it.
   `World` is split along its real seams, not kept beside a multiplayer copy.
2. **`SimSnapshot` survives.** About 190 read sites of the singleton blocks in 28 files and 543 uses of the
   `...Root` fields in 106 files keep compiling. What changes is the producer and a small number of fields.
3. **Numerics do not change.** `stepVessel`'s forces, the Kepler code and the body maths keep their results.
   Every step that touches them is guarded by a test that the single-craft trajectory is bit-identical
   before and after.
4. **The golden mission hash is re-baselined exactly three times**, each time behind the trajectory guard:
   after the id and codec change (wave 3), after `LocalSession` replaces `World` (wave 4), after the
   Sun-rooted body set is activated (lead, after wave 4).
5. **The tree is green at every commit**: `npm run typecheck`, the unit suites, `tools/dev/boundaries.test.ts`
   and `npm run test:mission` pass; the definition library loads.
6. **One owner per path per wave.** A sweep across presentation code happens once, in wave 3, by one
   package, while nobody else works in `src/`.

## 2. Starting point

- Wave 2 is finished, committed and reviewed; the lead has wired `src/app` against `createSim` and run the
  browser mission. Uncommitted wave-2 work (the tree showed about 30 modified and 10 untracked files while
  this was written) is either committed or discarded before wave 3 starts.
- `docs/ARCHITECTURE.md` is v1. The lead swaps `docs/ARCHITECTURE_V2.md` in (renaming it to
  `docs/ARCHITECTURE.md`, keeping v1 as `docs/research/ARCHITECTURE_V1.md`), replaces the scope note in
  `docs/PACKAGE_RULES.md`, and moves `docs/WORK_PACKAGES.json` aside for `docs/WORK_PACKAGES_V2.json`.
- Baseline recorded by the lead before wave 3: mission state hash, unit and browser suite results, the
  summed GPU budget table.

## 3. Order

Each step leaves the tree green. "Guard" names the test that proves the step changed nothing it should not.

### Wave 3

| Step | Package | Change | Guard |
|---|---|---|---|
| 3.1 | `core-v2` | Record the **trajectory guard** on the unmodified tree: body-centred position, velocity, attitude and mass of every vessel of the lunar mission at 400 sample ticks and of six unit fixtures (ascent, staging, entry, touchdown, splashdown, lunar ascent), stored bit-exact | The file itself |
| 3.2 | `core-v2` | Vessel model: `crafts[]`, `links[]`, `helm`, `PartRuntime.craft`; per-craft stage state; flow groups `(craft, stageGroup)`; crew, cockpit and seats on the command part; `craftId` issued by a seeded counter; part keys `craftId/instanceId`; `separateVessel` over tree edges and links; momentum-conserving merge replaces the clamp-only `mergeVessels` | Trajectory guard; momentum tests to 1e-9 |
| 3.3 | `core-v2` | The non-derived members of `Vessel.struct` become vessel state; the binary codec; `stateHash` over codec output | Codec round trip exact mid-touchdown and mid-entry (the audit's 7-19 mm divergence is gone) |
| 3.4 | `core-v2` | Contract migration (section 4) and the compiler-driven sweep over every consumer; `FakeSim` becomes `FakeSession` | Typecheck of the whole tree; every lab spec of wave 2 |
| 3.5 | `core-v2` | `World` adapted to the new contracts: produces `frame` (origin = the active vessel's SOI body, with `rebase` at SOI changes), a trivial `time` block, nullable `activeVesselId`; `createSim` returns it typed as `LocalSession` | Mission passes; golden re-baseline 1 |
| 3.6 | `core-v2` | Site model: `pads[]`; site id `ka-lae`; flatten discs derived from pads | Start-time constraints test; terrain unit suites |
| 3.7 | `world-data-bake` | Body definitions generated and validated against Horizons into `data/staged/bodies/`; planet pyramids into `data/tiles/<body>/`; the Madrakah region into the `earth` tile set; resolved pad coordinates into `data/staged/sites/` | Does not touch `data/defs`; the Earth and Moon manifests' existing coverage is unchanged (checked) |
| 3.8 | `platform-delivery` | Tile packer, pack `TileSource`, OPFS cache, bucket tooling, CI, the Railway and Modal skeleton, first cloud measurements | The fs and fetch sources are untouched; pack source returns byte-identical tiles |

Lead, between waves 3 and 4: review, baseline, answer contract requests from the three hand-offs.

### Wave 4

| Step | Package | Change | Guard |
|---|---|---|---|
| 4.1 | `universe-core` | `src/sim/island` built from `World`'s per-vessel state machine, rails advance, SOI hand-over and reduced tier, with the sub-stepped island loop (contact pass empty) and the two step modes | An island of one equals `stepVessel` bit for bit |
| 4.2 | `universe-core` | `src/sim/view` built from `World`'s snapshot, readout, navball, patch, node and burn code | Snapshot equality against `World` on recorded states |
| 4.3 | `universe-core` | `src/universe` (directory, clocks, rules, lanes, pads, expiry, objectives) and `LocalSession` | `tests/universe` |
| 4.4 | `universe-core` | `createSim` switches to `LocalSession`; the mission, the labs and `tests/browser/integration` run on it; **`src/sim/world` is deleted** | Trajectory guard; mission passes; golden re-baseline 2 |
| 4.5 | `wire-protocol` | `src/net`: codec for every message of `net.ts`, framing, transports, injector | Round trip of recorded message fixtures |
| 4.6 | `solar-system-sim` | Generic body-system changes (Sun as root attractor, inverted Almanac orbit, rates, pole frames, SOI rule, spheroid altitude, no-surface bodies, nine rails levels, per-patch horizon, SOI step floor, adaptive closest approach, vessel-against-vessel closest approach, Lambert and phase helpers), verified on the staged 30-body library loaded from `data/staged`; `tools/bodies/activate.mjs` | Every existing sim-orbits test on the 3-body library; `data/defs/bodies` untouched |
| 4.7 | `fleet-data` | Parts, assemblies, vehicles; loader support for `uses`; `validateVehicle`; `analyzeVehicle`; generic ascent pilot; site files with all pads from the staged coordinates | Library loads at every commit; `meridian-lunar.json` byte-identical |
| 4.8 | `shell-menu` | `src/shell`, menu rigs, input contexts, audio buses; built against `FakeSession`, `LocalSession` and store fixtures | Wave-2 flight-ui and map specs |
| 4.9 | `capability-settings` | `src/gate`, `src/bench`, `QualityProfile` in the core and every feature, scrim step, `acquireGpu` change | Ultra reproduces every wave-2 perf line and screenshot |

Lead, between waves 4 and 5: **activate the Sun-rooted body set** with `tools/bodies/activate.mjs` (moves the
staged definitions into `data/defs/bodies`, re-runs `findStartTime` which must reproduce
`tools/sim/start-time.json`, re-captures the QA scenarios, runs the mission, re-baselines the golden hash
for the third time behind the trajectory guard with a tolerance of 1e-9 relative on positions, since the
Sun direction changes by rounding); integrate the shell into `src/app`; visual QA of the wave-2 checkpoints.

### Wave 5

| Step | Package | Change | Guard |
|---|---|---|---|
| 5.1 | `contact-docking` | Colliders, the island contact and capture pass, swept tests, damage regimes, docking merge and undock, helm and lend rules, transfer, claim commit, screening wired into the directory | Trajectory guard (contact pass on, born-overlapping rule); mission passes with contact on |
| 5.2 | `netcode-client` | `NetSession` (replica, prediction, stores, identity key, reconnect) against an in-process `UniverseHost` behind the injector | `tests/net` client suites |
| 5.3 | `server-persistence` | `server/`: roles, Postgres writer and schema, journal and recovery, identity API, rules, admission, metrics | Restart and replay suites with a local Postgres |
| 5.4 | `fleet-models-pads` | Visuals for the new parts, pad structures per class, Madrakah structures, many-vessel presentation, new engine plumes and sounds | Wave-2 vehicle, cockpit and vfx specs |
| 5.5 | `planet-render` | Simple bodies, giants, rings, other atmospheres, exposure range | Earth and Moon screenshots and perf lines unchanged |
| 5.6 | `map-multiplayer` | Census layer, targets, intercepts, proximity plot, solar-system navigation | Wave-1 map specs |
| 5.7 | `flight-hud-multiplayer` | Time strip, target and docking instruments, nameplates, roster, prompts, port rig | Wave-1 HUD specs |

Lead, between waves 5 and 6: wire `NetSession` and the shell's stores in `src/app`; first two-client flight;
visual QA.

### Wave 6

`deploy-loadtest` (staged deployment, scale script, bot fleet, capacity report) and
`acceptance-multiclient` (`tests/net` scenario matrix, `tests/acceptance`). The lead then enables
`lagCap > 0` only if the lane-equivalence suite is green and the report asks for it.

---

## 4. Contracts, file by file (`src/core/contracts`)

| File | Verdict | Change |
|---|---|---|
| `sim.ts`: header, frames | changed in place | "ROOT" is documented as the render root (ARCHITECTURE 3). The field names `rRoot`, `vRoot`, `positionRoot`, `posRoot`, `qFixedToRoot`, `spinRoot`, `bodyPosAtEnd` stay. Added `SimSnapshot.frame { epoch, origin, rebase }` |
| `sim.ts`: `SimSnapshot` | kept, extended | `tick` renamed `revision` (10 files). `activeVesselId: string \| null`; the singleton blocks always present with neutral values (`neutralFlightBlocks()` in `src/sim/view`). Added `time: TimeView`; `warp` stays, derived from it. `scenario` becomes nullable; `milestones`, `mission` and `cheatCounter` describe the active craft's objectives and are empty / not failed / 0 without them |
| `sim.ts`: `VesselSnapshot`, `PartSnapshot` | extended | `crafts: CraftSnapshot[]` (id, vehicleId, owner callsign, name, stage info), `links`, `helm`, `presence`, `timeOffset`, `presentation?`. `vehicleId` stays (the base craft's). `PartSnapshot.craftId`; `instanceId` is unique within the craft |
| `sim.ts`: `ModuleState`, `Readouts`, `NavballMarkers`, `MarkerKind` | extended | `dockingPort` state; `Readouts.target: TargetReadout \| null` replaces `targetBodyId` and `targetClosestApproach`; `Readouts.docking`; `relativePrograde` / `relativeRetrograde`; `MarkerKind 'targetApproach'` with `otherVesselId` and the pair positions |
| `sim.ts`: `SimEvent` | extended | `dockCapture`, `docked`, `captureLost`, `undocked`, `collision`, `helmChanged`, `commandResult`, `claimLost`, `proximityWarning`, `padReleased`, `clockChanged`; `partDestroyed.cause 'collision'`; `vesselRemoved.reason` gains `rolledBack`, `recovered`, `lost`. `activeVesselChanged`, `warpChanged`, `milestone`, `missionFailed` are per session |
| `sim.ts`: `Sim`, `SimDebug` | restructured | Moved to `session.ts` as `FlightSession` and `LocalSession`. A `Sim = LocalSession` alias exists only during wave 3 and is removed in step 4.4 |
| `controls.ts` | extended in place | `CommandResult.pending`, `.cmdId`. `NavballMode 'target'`. `SasMode 'target' \| 'antiTarget' \| 'portAlign'`. `PlayerCommands`: `setTarget(ref: TargetRef \| null)`; `setWarpLevel` documented as a time request; `cycleActiveVessel` re-documented; added `warpTo`, `jump`, `hold`, `link`, `unlink`, `follow`, `meet`, `replyProposal`, `askAdvance`, `armPort`, `undock`, `setControlPoint`, `requestHelm`, `grantHelm`, `releaseHelm`, `setLendPolicy`, `transfer`, `setCrossfeed`. `ButtonAction`: `pause` becomes `flightMenu`; added `cycleTarget`, `toggleRoster`, `dockingView`, `openQuickComms`, `acceptPrompt`. `InputFrame.context`. `Pilot` unchanged |
| `defs.ts`: bodies | extended in place | `KeplerOrbitDef.rates`, `.meanMotionDegPerDay`, `.frame` pole variant; `SunLowPrecisionOrbitDef.inverted`; `soiRadius 'auto'` rule; `shape`; `surface`; `rings`; `atmosphere.floorAltitude`; `warpAltitudeLimits` optional. `gravityRole 'lightOnly'` stays valid and unused |
| `defs.ts`: sites | restructured | `LaunchSiteDef.pads: PadDef[]` replaces `pad`, `padAzimuthDeg`, `structures`; `SiteLocationDef` per pad |
| `defs.ts`: parts, vehicles | extended in place | Attach-node `kind`, `rollStepDeg`; `surfaceAttach`; `symmetry`; `collision`; `crossfeed`; `crashTolerance`; `resources[].transferable`; categories `dock`, `habitat`; `ModuleDef 'dockingPort'`; `command.remote`, `.cockpit`; `StageAction 'undock'`; `VehicleDef.uses`, `.padInterface`, `cameras.cockpit` optional; `AssemblyDef` |
| `defs.ts`: scenarios, library, constants | changed in place | `ScenarioDef` keeps its fields, gains `pad`, and is documented as a spawn recipe plus optional objectives. `DefLibrary.assemblies`, `.rules`. `WARP_LEVELS` gains two levels (`RAILS_WARP_LEVEL_COUNT` 9) |
| `simInternal.ts` | extended in place | `VesselEnvironment.origin?` (reference-orbit state at the start of the step). The "describes the start of the step" rule stays. Contact with other vessels does not go through the environment |
| `render.ts` | kept, small edits | `QualitySettings` becomes `QualityProfile`; `FeatureQualityDecl`; `Renderer.setQuality`; `CameraState.exposureHint`, `.lensShift`; `'ui.scrimRects'`; a `presentation` flag on vessel poses. "Active vessel" wording stays true per client. `OCEAN_WETNESS_SLOTS` stays 8 (nearest first) |
| `ui.ts` | extended | `MfdPage 'target' \| 'docking'`; `MapView.update(..., census)` with filter state and preview time; focus refs include sites and players; `Hud` takes the client stores |
| `audio.ts` | extended | `AudioBusName 'music' \| 'comms'` |
| `testApi.ts` | extended | `net()`, `stores()`, `sessionKind`; `setPaused` is local-only |
| `terrain.ts` | kept | Added `TilePackIndex`. `TileSource`, `TileManifest`, the coverage rules and `TerrainProvider` are unchanged |
| `sky.ts` | kept | - |
| `session.ts` (new) | - | `FlightSession`, `LocalSession`, `UniverseCommands`, `ClientStores` |
| `net.ts` (new) | - | Message schema, `UniverseRules`, `ClockState`, `TimeView`, `CensusEntry`, `TargetRef`, the view models (`LobbySummary`, `PadState`, `ShipRecord`, `AssemblyView`, `RosterEntry`, `FeedEvent`, `CapabilityReport`) |
| `universe.ts` (new) | - | `UniverseHost`, record types, `UniverseStorage`, `WallClock` (the injected interfaces of `src/universe`) |

## 5. Modules

| Module | Verdict | What happens | Package |
|---|---|---|---|
| `src/core/math`, `src/core/geo` | keep | Added `math/frame.ts` (rebase helper). A deterministic maths module is not built | `core-v2` |
| `src/core/defs` | extend in place | Assemblies and `uses`, pads, rules documents, `validateVehicle`, bundled hashed library and `defsHash` | `core-v2`, `fleet-data` |
| `src/core/fakes/fakeSim.ts` | extend in place | Becomes `FakeSession` with multi-vessel, target, docking, echo and time scenes | `core-v2` |
| `src/core/gpu/device.ts` | change in place | Reports the adapter class, no longer throws on `looksIntegrated` | `capability-settings` |
| `src/sim/orbit` | keep, fix, extend | Per-patch horizon; SOI step floor; adaptive closest approach; vessel-against-vessel closest approach; Lambert and phase helpers; warp levels. Conic-against-conic screening and jump planning are new files under `src/sim/orbit/conjunction/` | `solar-system-sim`; `universe-core` for `conjunction/` |
| `src/sim/bodies` | extend in place | Sun as root attractor; inverted Almanac orbit; rates and pole frames; SOI rule; spheroid altitude; no-surface bodies; `sunVisibility` restricted to the current planet system | `solar-system-sim` |
| `src/sim/frames`, `src/sim/nav` | keep, extend | Target-relative navigation (relative state, port alignment, LVLH); `buildSurfaceTargets` takes every site | `solar-system-sim`; port alignment in `contact-docking` |
| `src/sim/vessel` (`types`, `assemble`, `split`, `staging`, `structure`, `facade`, `massProps`) | restructure the data model, keep the algorithms | Step 3.2 and 3.3. `public.ts` keeps its signatures; `splitForStage` and the snapshot helpers gain craft ids | `core-v2` |
| `src/sim/vessel/clearance.ts` | extend in place | Becomes the collider library: authored shapes, GJK distance with closest features, conservative advancement | `contact-docking` |
| `src/sim/dynamics` | keep force models; restructure stepping | `stepVessel`'s force evaluation and write-back are called by the island's sub-stepped loop; optional origin (Encke); `failure.ts` reaches other vessels; a `predict` mode that suppresses threshold transitions | `universe-core` (loop, origin, predict mode), `contact-docking` (pair forces, damage) |
| `src/sim/control` | keep | Target hold directions arrive as vectors, as the maneuver direction does today | - |
| `src/sim/world/sim.ts` (`World`, 2,531 lines) | **restructure, then delete** | Per-vessel state machine, `advanceOnRails` with exact events, SOI hand-over, reduced tier, terrain policy: to `src/sim/island`. Snapshot building, `present()` interpolation, readouts, navball, patches, nodes, burn bookkeeping, surface targets: to `src/sim/view`. Warp ladder and look-ahead: to the clock schedule in `src/universe`. Deleted: the single `active`, `controls`, `warpIndex`, the 25 km bubble about the active vessel, `MAX_DEBRIS`, `failMission`, the O(n) loop over all entries, the O(n^2) proximity rule | `universe-core` |
| `src/sim/world/milestones.ts` | keep, move | The objective observer of `src/universe`, attached to one craft | `universe-core` |
| `src/sim/world/terrainPolicy.ts`, `environment.ts`, `scenarioStart.ts`, `stateHash.ts` | keep, generalise | Terrain slots per vessel in the island; start poses become spawn poses on a pad; the hash is over codec output | `universe-core` |
| `src/sim/index.ts` | change in place | `createSim` returns a `LocalSession` | `core-v2`, then `universe-core` |
| `src/universe`, `src/net`, `src/client`, `server/`, `bots/`, `deploy/` | new | ARCHITECTURE sections 5-7, 13-17 | `universe-core`, `wire-protocol`, `netcode-client`, `server-persistence`, `deploy-loadtest` |
| `src/pilot` | keep, extend | `runner.ts`, `core.ts`, `attitude.ts`, `guidance.ts` drive a `FlightSession`. `missionPilot.ts` stays the Earth-Moon proof; its "root body" reasoning is re-validated at activation. New generic pilots: ascent to orbit for any vehicle, rendezvous, docking, interplanetary transfer | `core-v2` (interface), `fleet-data` (ascent), `contact-docking` (rendezvous, docking), `solar-system-sim` (transfer) |
| `src/terrain` | keep, extend | Pack `TileSource` and OPFS cache; generic amplification models; flatten discs from pads; body shape | `platform-delivery`, `world-data-bake`, `core-v2` |
| `src/render/core` | keep, extend | Frame rebase; `setQuality` and rebuild classes; governor budget from the target frame rate; scrim step; exposure hints and range; lens shift | `core-v2` (rebase), `capability-settings`, `planet-render` |
| `src/render/terrain`, `atmosphere`, `sky`, `ocean` | keep, extend | A generic path for bodies with small pyramids; pool budgets per body by distance; several atmospheres with per-body uniforms; cloud-top bodies; rings; sun-distance scaling; the pack source in tile workers | `planet-render` |
| `src/render/vehicle`, `cockpit`, `vfx` | extend in place | Keys by `craftId/instanceId`; interior, seats and engine clusters from the command part and the part list; visuals for about 30 new parts; pad structures per class; other-craft detail cap; echo outline; new plume and sound profiles | `core-v2` (keys), `fleet-models-pads` |
| `src/ui`, `src/input`, `src/camera` | extend in place | Input contexts; menu rigs; time strip, target and docking painters, nameplates, roster, prompts; port rig; cockpit eye from the command part; one shipped font family | `shell-menu`, `flight-hud-multiplayer` |
| `src/map` | extend in place | Census layer, filters, vessel targets, intercepts, proximity plot, preview time, zoom to 1e13 m; planning stays client-local | `map-multiplayer` |
| `src/audio` | keep, extend | Buses, UI sounds and music, relevance cut, new engine profiles | `shell-menu`, `fleet-models-pads` |
| `src/shell`, `src/gate`, `src/bench` | new | ARCHITECTURE 23, 24 | `shell-menu`, `capability-settings` |
| `src/app` | lead | Written against `FlightSession`; switches between `LocalSession` and `NetSession` | lead |

## 6. Data, tools and tests

| Path | Change |
|---|---|
| `data/defs/bodies` | Three files until activation; then 30 generated files. `earth` and `moon` keep their render and terrain sections; `sun.json` becomes the root attractor |
| `data/defs/sites` | `ka-lae-lc1.json`, `.location.json`, `.structures.json` renamed to `ka-lae.*` with a pad list (step 3.6); references in scenarios, `regions/earth-*.json`, `tools/sim/start-time.json` and tests updated in the same commit. `madrakah.*` added in wave 4 |
| `data/defs/parts`, `vehicles`, `assemblies`, `visuals/vehicles` | About 30 new parts, the assemblies, seven new vehicles. `meridian-lunar.json` and the 25 existing parts' geometric data stay frozen |
| `data/defs/scenarios` | `lunar-direct` unchanged in content; `site: "ka-lae"`, `pad: "lc-1"`. QA scenarios re-captured at activation. Benchmark shots added (`bench-*.json`) |
| `data/defs/rules` | New: `default`, `staging`, `local` |
| `tools/dev/boundaries.test.ts` | New rules of ARCHITECTURE section 2 (`src/universe` headless; `src/net`, `src/client`, `server/` edges) |
| `tools/sim/findStartTime.ts`, `start-time.json` | Re-run at activation; must reproduce the same instant |
| `tools/server/dataPlugin.ts` | Serves `/defs/` with assemblies and rules; unchanged otherwise |
| `tests/mission` | Runs on `LocalSession`; `golden.json` re-baselined three times; the trajectory guard file is added and never re-recorded except at activation with the stated tolerance |
| `tests/unit/sim-world` | Moved to `tests/universe` and `tests/unit/sim-island` as the code moves |
| `tests/browser/*`, `labs/*` | Keep working through `createSim` and `FakeSession`; specs that assert an Earth-centred `rRoot` are rewritten to differences |

## 7. Wave-2 output at risk

| Wave-2 package | At risk | Why | What protects it |
|---|---|---|---|
| sim-world-pilot | `src/sim/world/sim.ts` is taken apart; `tests/unit/sim-world` moves; `golden.json` changes three times; the mission pilot's phases depend on readouts whose producer changes | It is the single-player, single-clock binding | The algorithms move unchanged; trajectory guard; snapshot-equality test between `World` and the view builders before `World` is deleted |
| sim-world-pilot | `tools/sim/start-time.json`, the QA scenarios | The Sun direction comes from Earth's inverted orbit after the re-root | `checkStartConstraints` and the solstice test are the activation gate |
| vehicle-pad | `vesselFeature.ts` keys state by `rootOf(vessel.id) + '\|' + instanceId` and takes engine clusters from `defs.vehicles[vehicleId]`; `siteFeature.ts` assumes one pad and tower arm heights tuned to the Meridian; perf lines sized for one stack | Two craft of one type collide on every id; pads are a list; several launches are in view | The sweep in `core-v2`; `padInterface`; the other-craft detail cap |
| cockpit | Interior chosen by `defs.vehicles[vehicleId].cockpit`; seat from `VehicleDef.cameras.cockpit`; reads the singleton blocks | The interior belongs to the command part | The assembler copies both onto the command part; the singleton blocks stay |
| vfx | World-anchored effects held in ROOT across frames; emitter budgets for one craft and its debris; `explosion.posRoot` | The render root can be replaced; many vessels | `frame.rebase`; nearest-eight relevance cut |
| terrain-render | "Levels 0-3 pinned and preloaded" and pools of 1280/1024/512 layers assume two large bodies; tile workers fetch plain files | Small bodies have 2-6 levels; 30 tile sets; production serves packs | A per-body budget by distance; `TileSource` is already the seam |
| atmosphere-clouds | One atmosphere and one LUT set in practice; clouds only where a cloud map exists | Venus, Mars, Titan and four giants | Per-body uniforms exist; only the nearest shell gets the full march |
| sky-lighting | Impostors and planetshine tuned for Earth and Moon; the probe is "at the active vessel"; sun disc at 1 AU | 30 bodies, four decades of illumination, no active vessel in the menu | Generic over bodies already; the probe moves to the focus |
| ocean | Wetness slots "active first" | Nullable active vessel | Nearest first when there is none |
| core-support (render core, UI, input, camera, map, audio, terrain) | `QualitySettings` (six fields), the fixed 11 ms governor budget, `looksIntegrated`, the `pause` action, `MAP_MAX_DISTANCE = 2e9`, the system font, rigs holding ROOT positions | Settings are declared by features; nothing pauses; the map spans the solar system | Ultra equals today's look by test; rebase helper |
| every render package | Screenshot baselines | Any change of the frame origin, exposure range or quality plumbing can move pixels | Ultra must reproduce the wave-2 checkpoints (step 4.9); Earth and Moon screenshots are the gate of `planet-render` |
| all | Specs and labs that name the site `ka-lae-lc1`, a vessel id equal to the vehicle id, or `snapshot.tick` | Renames | Compiler and library validation catch them in step 3.4 and 3.6 |

What is **not** at risk: the bakes and tile sets, the tile codec and cube mapping, the height authority, the
Kepler, event and force code, the part and vehicle data of the existing stack, the frame graph and shader
library, the audio graph, the HUD painters and the map's projector and sampler.

## 8. Guards that stay green through every step

- Trajectory guard (step 3.1).
- `npm run test:mission` with zero incomplete terrain queries and `cheatCounter = 0`.
- `tools/dev/boundaries.test.ts`, `node tools/dev/check-secrets.mjs`.
- Momentum conservation of every split and merge to 1e-6 linear and 1e-9 angular.
- Every stage separation of the existing stack leaves the pieces undamaged.
- The start-time constraints of `lunar-direct`.
- The summed GPU budget table at Ultra on the reference GPU.
