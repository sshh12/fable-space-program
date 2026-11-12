# lead-baseline-v2: hand-off

The lead's step before wave 3 of `docs/WORK_PACKAGES_V2.json` (MIGRATION_V2 step 3.0), with the lead's
amendments of 2026-11-11: five other agents were working in the tree, the reference images are deferred to
the visually signed-off tree, the document swap comes last.

It changed no behaviour: the suites give the results they gave before it (section 9).

## Running log

- 2026-11-11 22:10 start. Tree at 6961d22 plus other agents' uncommitted work. Baseline suites run.
- 22:16 machine crash (third; GPU driver, two WebGPU browser runs). Resumed 22:24; nothing of this step was
  lost. The gate's GPU class is one slot since then (commit 23fdeb7).
- 22:35 mission baseline recorded (02cdfa8); `golden.json` tile hash refreshed (c079c0a).
- 22:50 contracts committed (85a8df4). While they were being written, another agent compiled against the
  uncommitted working tree and listed the v2 events in its table (35eeb0b): see section 2, "How the
  contracts were kept additive".
- 23:00 root configuration, tools, dependencies (37c5329). 23:10 terrain guard (1e69604). 23:20 harness:
  reference-image tooling and the frame clock (870d19e). 23:25 `MilestoneRuleDef.title` (95dac27).
- 23:25 the gate serves waiters in order of arrival (050b2b3): the two GPU specs of this step had been
  overtaken three times by later arrivals. 23:35 the documents swapped, PACKAGE_RULES with the v2 rules
  (1fa34fa, b2b219a). The renames of the swap (`git mv`) were staged for a minute and were carried by another
  agent's commit (7d9c765): the index is shared; rule 10 of PACKAGE_RULES now says how to commit.
- 23:54 the two GPU specs ran (frame clock; reference-image proof on two checkpoints): both green. The
  frame clock was 60 Hz in every case this time, so the cause was still only inferred.
- 2026-11-12 00:31 the display experiment (monitor switched off, then woken): 57.5 Hz off, 60.00 Hz on.
  Request app-integration-8 resolved.

## 1. What wave 3.1 can rely on (short form)

- `npm run typecheck` runs BOTH configurations (`tsconfig.json`, and `tsconfig.node.json` without the DOM
  library for `server/`, `bots/`, `deploy/`, `src/sim`, `src/universe`, `src/session`, `src/terrain`,
  `src/pilot`, `src/net`). `npm run typecheck:paths -- <paths>` does the same for your paths.
- `npx vitest run` collects `src/**`, `tests/unit/**`, `tests/universe/**`, `tests/load/**`, `tools/**`,
  `server/**`, `bots/**` (`*.test.ts`). `npm run test:net` (NET=1) collects `tests/net/**` and refuses to run
  outside a stack. `npx playwright test --project=acceptance` collects `tests/acceptance/**/*.spec.ts`.
- The v2 contracts exist (section 2). Everything new on an existing interface is OPTIONAL until its
  producers exist; section 2 lists what becomes required and when.
- `tests/mission/baseline-v1.json` is the tolerance reference for step 3.1 (section 4).
- The terrain guard is in the unit suite (section 5).
- `tools/dev/boundaries.test.ts` already has the rules for the directories you will create (section 7).
- `npm run stack`, `npm run stack:client`, `/endpoints.json`, `STACK_URL` in globalSetup, the `stack` class
  of the gate, the dependencies (section 6).
- Reference images: the tooling is complete, the set is NOT recorded yet (section 3).

## 2. Contracts (`src/core/contracts`, all additive)

### New files

| File | Exports |
|---|---|
| `session.ts` | `FlightSession` (`defs`, `advance`, `setControls`, `commands`, `snapshot`, `peek`, optional `universe`, `stores`, `planning`), `LocalSession` (adds `scenario`, `ready`, `terrainPending`, `step`, `advanceRails`, `needsIntegration`, `nextEventUt`, `cheatCounter`, `stateHash`, `debug`), `SessionDebug`, `UniverseCommands` (`spawn`, `attach`, `detach`, `subscribe`, `rename`, `abandon`) with `SpawnRequest`, `SpawnSlot`, `SeatResult`, `Subscriptions`, `ClientStores` (`census`, `pads`, `ships`, `assembly`, `roster`, `rules`, `presence`, `feed`, `prompts`, `link`) over `Store<T>`, `PlanningService` (`predictPatches`, `closestApproaches`, `proximityPlot`, `launchWindows`, `describeConic`) with `PlanningKey`, `ClosestApproach`, `ProximityPlot`, `LaunchWindow` |
| `net.ts` | `UniverseRules` + `DEFAULT_UNIVERSE_RULES` + `UNIVERSE_RULE_TIMERS` (below), `TICKS_PER_SECOND`, `TimerBase`, `PadClass`, `LendPolicy`, `TargetRef`, `ClockKind`, `ClockState`, `ClockMember`, `TimeProposal`, `TimeLimit`, `TimeLimitKind`, `TimeOffer`, `TimeView`, `Presence`, `CensusEntry`, `CensusPatch`, `CensusKind`, `Conjunction`, and the view models `LobbySummary`, `PadState`, `ShipRecord`, `ExpiryView`, `AssemblyView`, `AssemblyCraftView`, `RosterEntry`, `FeedEvent`, `Prompt`, `PresenceSummary`, `LinkState`, `CapabilityReport`. NO wire messages: the file ends with a marker line below which `wire-protocol` writes that section in wave 4. No chat flag |
| `vehicle.ts` | `VehicleCapabilities`, `StageCapability`, `PortCapability`, `ReachEntry`, `Issue` |
| `src/core/math/frame.ts` | `FrameRebase`, `FrameEpoch`, `IDENTITY_REBASE`, `rebasePoint`, `rebasePointInPlace`, `rebaseVelocity`, `rebaseVelocityInPlace`, `composeRebase`, `invertRebase`, `rebaseBetween`, `FrameEpochTracker` (`observe(frame)`, `current`, `reset()`); tests in `frame.test.ts` |

`UniverseRules` groups (durations in seconds; the base of every timer is in `UNIVERSE_RULE_TIMERS`, keyed
`group.field`, as `'ticks' | 'upTime' | 'wall'`): `time` (lead cap 250 y, guard band 20 y, advance limits
30 d / 6 y, `physicsWarpMax` 4, launch range 150 km / 100 km, encounter lead 10 s and margin 10 m, target
approach steps 50x at 60 s and 1x at 10 s, ready-check 15 s, one open proposal per clock, 30 s between
proposals, idle 120 s, stop window 0.5 s, round trip 0.25 s, jump arrival 50 m / 30 s, alternative 10 s,
advance retry 300 s, departure look-ahead 30 s and notice 10 s, 16 forecast patches, join cooldowns 60 s /
30 min, resume windows 30 s / 90 s, cohort bucket 5 min, horizon 14 d, offer after 60 s, `lagCap` 0);
`claim` (join distance 1 km + 2 s x closing speed, part factor 2, armed margin 200 m + 2 s, release 10 s,
materialise reach 30 s and clearance 5 m, clearing 15 s / 0.5 m/s^2 / 30 s); `disconnect` (ping 1 s, loss
3 s, solo latch 10 s, shared 0.25 s / 2 s, grace 120 s); `contact` (4 sub-steps, 8 iterations, restitution
0.2 above 0.3 m/s, friction 0.5, speculative fraction 0.25, nascent clearance 5 cm, hypervelocity 250 m/s
and 40 kJ/kg, explosion 150 N s/kg, 12 fragments, 50 kg / 60 s); `docking` (hard dock 3 mm / 0.1 deg /
3 mm/s for 0.5 s, soft clamp 0.5 s, link break 0.2 s, port cooldown 10 s or 1 m, helm request 30 s,
default lend policy, 32 craft and 600 parts per assembly, 64 vessels per island); `terrain` (2 km radar,
50 km / 200 m/s); `pads` (hold 90 s, stay 300 s + 120 s, up-time cap 600 s, disconnect grace 60 s, cleared
above 1,500 m and 1,000 m away, safing 20 s, keep-out 300 / 450 / 600 m, rest recovery 60 s, range safety
below 5 km); `expiry` (14 d, 10 slots, 48 h, 48 h, debris 2 h with 24 per account and 5,000 per SOI, wreck
2 h, lost beyond 100 AU, arcs 24 h, account 90 d, 50,000 objects, pressure from 70 % with floors 24 h and
72 h, sweep 60 s, outage extension above 1 h); `limits` (60 inputs/s, 20 commands/s, 6 Time messages per
10 s); `planning` (worker under 50 ms, `weakClientCpuScore` null until the calibration data of wave 4).
Port geometry and capture envelopes are part data (`DockingPortModuleDef`), not rules.
`sim-core-v2` writes `data/defs/rules/default.json` from `DEFAULT_UNIVERSE_RULES`.

### New fields on existing files (all optional; "tighten" = the lead makes it required)

| File | Added | Required from |
|---|---|---|
| `sim.ts` `SimSnapshot` | `revision?`, `frame?: SnapshotFrame` (`FrameOrigin`, `rebase`), `time?: TimeView` | tighten after 3.2 (World fills them at step 3.5, FakeSession in the sweep) |
| `sim.ts` `VesselSnapshot` | `crafts?: CraftSnapshot[]`, `links?: DockLinkSnapshot[]`, `helm?`, `presence?`, `timeOffset?`, `presentation?`, `revision?` | tighten after 3.2 (`presentation` stays optional) |
| `sim.ts` `PartSnapshot` | `craftId?`, `stageGroup?`, `stageLabel?` | tighten after 3.2 |
| `sim.ts` `Readouts` | `target?: TargetReadout \| null`, `docking?: DockingReadout \| null` | tighten after 3.2 |
| `sim.ts` `NavballMarkers` | `relativePrograde?`, `relativeRetrograde?` | tighten after 3.2 |
| `sim.ts` `Marker` | `otherVesselId?`, `otherBodyId?`, `otherR?`, `relSpeed?`, `onForecast?` | stay optional |
| `sim.ts` events | `SimEventV2` (12 events: `dockCapture`, `docked`, `captureLost`, `undocked`, `collision`, `helmChanged`, `commandResult`, `claimLost`, `proximityWarning`, `padReleased`, `clockChanged`, `rangeClearing`) ARE members of `SimEvent`; `provisional?` on every event; `partDestroyed.cause 'collision'`; `vesselRemoved.reason 'rolledBack' \| 'recovered' \| 'lost' \| 'pressure'`; `CaptureLimit` | - |
| `sim.ts` | `Sim = LocalSession` and `SimDebug = SessionDebug` are now aliases (deprecated) | removed at the tighten after 3.2 |
| `controls.ts` | `CommandResult.pending?`, `.cmdId?`; `InputFrame.context?: InputContext`; 19 optional v2 commands on `PlayerCommands` (`warpTo`, `jump`, `hold`, `link`, `unlink`, `follow`, `meet`, `replyProposal`, `askAdvance`, `armPort`, `undock`, `setControlPoint`, `requestHelm`, `grantHelm`, `releaseHelm`, `setLendPolicy`, `setAdvanceLimit`, `transfer`, `setCrossfeed`); `SAS_TARGET_MODES` | the commands: tighten after step 4.3 |
| `defs.ts` bodies | `KeplerOrbitDef.frame` pole variant, `.rates`, `.meanMotionDegPerDay`; `SunLowPrecisionOrbitDef.inverted`; `AtmosphereDef.floorAltitude`; `BodyDef.shape`, `.surface`, `.rings` (`RingDef`) | stay optional |
| `defs.ts` sites | `PadDef`, `SiteStructureDef`, `LaunchSiteDef.pads?`, `SiteLocationDef.pads?` | `pads`: tighten after 3.2 (written at step 3.6) |
| `defs.ts` parts, vehicles | attach-node `kind`, `rollStepDeg`; `surfaceAttach`, `symmetry`, `collision` (`CollisionShapeDef`), `crossfeed`, `crashTolerance`, `resources[].transferable`; categories `dock`, `habitat`; `command.remote`, `.cockpit`, `.sensorCamera`; `StageAction 'undock'`; `VehicleDef.uses` (`VehicleUseDef`), `.padInterface`; `VehiclePartPlacement.symmetry`; `AssemblyDef` | stay optional |
| `defs.ts` scenarios, library | `ScenarioDef.pad?`; `MilestoneRuleDef.title?` (request flight-ui-5); `DefLibrary.assemblies?`, `.rules?`; `RAILS_WARP_LEVEL_COUNT` | `assemblies`, `rules`: when the loader fills them |
| `simInternal.ts` | `VesselEnvironment.origin?` | stays optional |
| `render.ts` | `QualityProfile`, `QualityLevelName`, `FeatureQualityDecl`, `RenderFeature.quality?`, `Renderer.setQuality?`, `CameraState.exposureHint?`, `.lensShift?`, `VesselPose.presentation?`, `UI_SCRIM_SLOTS`, `UI_SCRIM_BYTES`, `UI_SCRIM_RECTS_KEY` | `setQuality`: wave 4.1 |
| `ui.ts` | `Hud.update(..., stores?)`, `MapView.update(..., census?: MapCensus)`, `MapFilter`, `MapUpdateResult.focus.siteId / .accountId`, `.filter`, `.previewTick`, `SettingsModel`, `MapElementInfo.kind 'census' \| 'site'` | - |
| `testApi.ts` | `sessionKind?`, `net?()`, `stores?()`, `NetProbe`, `StoresDump`; `setPaused` documented as local-only | waves 4.5 / 5.3 |
| `terrain.ts` | `TileSourceSpec` (`fs`, `fetch`, `pack`) | - |

### Deprecated, still filled (the sweep's list)

`SimSnapshot.tick` (use `revision`), `Readouts.targetBodyId` and `Readouts.targetClosestApproach` (use
`Readouts.target`), `LaunchSiteDef.pad`, `.padAzimuthDeg`, `.structures` (use `pads[]`), the `'pause'` button
action (becomes `'flightMenu'`), `Sim`, `SimDebug`, and `createSim` of `src/sim` (use `createSession` of
`src/session` from step 3.5), `QualitySettings` (becomes `QualityProfile` in wave 4.1). The lead removes
them at the tighten step after sub-wave 3.2, once a grep is clean.

### How the contracts were kept additive, and what is therefore still to do

The brief expected "new required snapshot fields with neutral producers in World and FakeSim". That is not
possible additively: snapshots are also built as typed literals by `src/map/testing/syntheticSnapshots.ts`,
`src/sim/vessel/facade.ts`, `src/sim/nav/navball.ts`, `labs/audio/scenes.ts`, `labs/vehicle/labSim.ts`,
`labs/vfx/labSim.ts` and several tests, none of which the lead may edit while their owners work. So every new
field is optional and documented with the value its absence means, and NOTHING was changed in
`src/sim/world` or `src/core/fakes`. Likewise:

| Brief item | State | Who finishes it, when |
|---|---|---|
| Union members with an exhaustive consumer | Declared beside the union, not joined: `SasTargetMode` (tables in `src/input/bindings.ts`, `src/ui/hud/hud.ts`), `NavballModeV2` (`src/camera/chaseRig.ts`), `ButtonActionV2` (`src/input/bindings.ts`), `MarkerKindV2` (`src/map/scene.ts`), `MfdPageV2` (`src/ui/mfd/mfdPainter.ts`), `AudioBusNameV2` (`AudioProbe.buses`, `src/audio`) | The lead joins each at the start of sub-wave 3.2 (the sweep owns those files then and adds the entries); `AudioBusNameV2` before wave 4.1 |
| `ModuleDef 'dockingPort'`, `ModuleState 'dockingPort'` | Declared as `DockingPortModuleDef` (defs.ts) and `DockingPortState` (sim.ts), not joined: `src/sim/vessel/assemble.ts` and `labs/audio/labVehicle.ts` switch over every module type | The lead joins both in the lead step before wave 4.1, with the two switch cases |
| `'ui.scrimRects'` in `SharedResourceMap` | Layout and key name are constants (`UI_SCRIM_*`); the key is not in the map, because `src/render/core/resources.ts` keeps one default per key | The lead adds the key at the start of 3.2 with the core's default |
| `PlayerCommands.setTarget(ref: TargetRef \| null)` | Unchanged (`bodyId`): implementations forward the argument as a body id (`src/core/fakes/fakeSim.ts`, `labs/map-view/main.ts`) | The lead changes the signature at the start of 3.2 with the call sites |
| `SimSnapshot.activeVesselId: string \| null`, `scenario` nullable | Documented on the fields; not changed (about 190 read sites) | Tighten after 3.2, once the sweep's consumers handle a missing vessel |
| `WARP_LEVELS` + 1,000,000x and 10,000,000x, `warpAltitudeLimits` optional | Not changed: `src/sim/bodies/bodySystem.ts` requires one limit per rails level and `earth.json` / `moon.json` list seven, so two more levels alone fail the library load. `RAILS_WARP_LEVEL_COUNT` is exported so no code states a count | The lead, together with `solar-system-sim`'s body-system change (wave 4.1c) |
| `VehicleDef.cameras.cockpit` optional | Documented; not changed (consumers read `.part`) | Tighten after 3.2 |

One event of working in a shared tree: while the contracts were uncommitted, the audio agent compiled against
them and committed the 12 v2 event types into `EVENT_TYPES` of `src/audio/config.ts` (35eeb0b). The v2
events were therefore made members of `SimEvent` at once (the only exhaustive consumer already has them).

### To be signed off by the lead before wave 4 (not written in this step)

- The island API: `src/sim/island/api.ts` (create, step in the two modes, structural operations as data,
  admit / reserve / commit inputs, the island codec), written by `island-core` against ARCHITECTURE 7.
- The navigation signatures the view calls (`src/sim/nav`): relative state of two vessels, LVLH components,
  port alignment (control port against target port), vessel-against-vessel closest approaches; they produce
  `TargetReadout` and `DockingReadout` exactly as typed in `sim.ts`.
- `universe.ts` (`UniverseHost`, record types, `UniverseStorage`, `WallClock`, up-time) is written by
  `universe-directory`; the wire-message section of `net.ts` by `wire-protocol`.

## 3. Reference images (ARCHITECTURE 31.3): tooling complete, recording DEFERRED

By the lead's amendment the set is NOT recorded now: the visual close-out still changes pixels in every
rendering package. **The lead records the full set immediately before sub-wave 3.2 (presentation-sweep), on
the visually signed-off tree.**

What exists (`tests/browser/harness.ts`):

```ts
compareToBaseline(page: Page, name: string, opts?: { manifestFile?: string; capture?: Buffer }): Promise<BaselineComparison>
expectBaseline(page, name, opts?): Promise<BaselineComparison>            // throws with the numbers and the files to look at
recordBaseline(page, name, open: (page) => Promise<void>, opts: { manifestFile?: string; note: string })   // the lead's act
captureDeterministic(page: Page, frames = 64, timeoutMs = 180_000): Promise<Buffer>
imageDifference(a: Buffer, b: Buffer): ImageDifference & { diff: Buffer }
readBaselineManifest(store?), tileSnapshot(), describeComparison(c)
```

- Difference measure on 8-bit sRGB, alpha ignored: `meanAbs` = mean over pixels and channels of |a - b|;
  `p999` = 99.9th percentile over pixels of the largest channel difference. One changed row of 720 (0.139 %
  of the pixels) moves `p999`; a faint change everywhere moves `meanAbs`.
- Deterministic capture: the page is opened with frozen presentation time (`deterministic=1&paused=1` on the
  labs), then `isIdle()`, 64 presented frames, `isIdle()` again, 4 frames, screenshot.
- Recording: two fresh loads; the first capture is the reference; tolerance = max(floor, 3 x the difference
  of the two), floor `{ meanAbs: 0.02, p999: 1 }`. The manifest entry stores file, sha256, size, tolerance,
  the two-recording difference, commit, Chrome, adapter, the tile sets' content hashes and the lead's note.
- A comparison refuses a reference file whose sha256 is not the manifest's, names tile sets whose content
  hash differs from the recording's, and on failure writes `out/screens/baselines/<name>.actual.png` and
  `.diff.png` (differences x 8).
- Manifest: `tests/browser/baselines.manifest.json` (tracked): `dir` (`data/baselines`, git-ignored),
  `viewport` 1280 x 720, `floor`, and 25 checkpoints, ALL `pending`: pad-noon, pad-sunset,
  ascent-cloud-deck, ascent-10km, ascent-40km, leo-day, leo-terminator, leo-night, leo-nadir-day,
  leo-nadir-night, translunar-earth, translunar-moon, lunar-terminator-20000km, lunar-terminator-5000km,
  lunar-orbit-low-sun, lunar-touchdown, lunar-surface-cockpit, reentry-peak-heating, parachute-descent,
  splashdown, shoreline, ocean-climb-2m / -200m / -20km / -400km. Eleven have a page (an integration-lab
  query taken from `tests/browser/integration/budget.perf.spec.ts`); fourteen have `page: null`: the lead
  frames them when recording (camera parameters of `labs/integration/main.ts`).
- Specs: `tests/browser/shell/baselines.record.spec.ts` (record with `BASELINE_RECORD="<signed note>"`,
  optional `BASELINE_ONLY=a,b`; without it: every recorded checkpoint is captured again and must compare
  clean); `tests/browser/shell/baseline-tooling.spec.ts` (the difference measure on synthetic images, always;
  the browser proof with `BASELINE_TOOLING_PROOF=1`).

Proof on two checkpoints (2026-11-11 23:55, RTX 5090, Chrome 157, on a PROOF manifest under
`out/qa/baseline-proof/`, not the tracked one; the captures were looked at):

| Checkpoint | Two recordings differ by | Tolerance (3 x, at least the floor) | Third capture | One pixel row changed by 48 levels |
|---|---|---|---|---|
| leo-day | mean 0.12825, p99.9 7, max 95, 18.3 % of pixels | mean 0.38475, p99.9 21 | mean 0.1140, p99.9 6: clean | p99.9 48: caught |
| translunar-earth | mean 0.00247, p99.9 0, max 112, 0.05 % of pixels | mean 0.02 and p99.9 1 (the floor) | mean 0.0024, p99.9 0: clean | p99.9 48, mean 0.0246: caught |

A reference file that is not the recorded one (sha256) is refused. For the lead when recording: `leo-day` is
not stable between two loads in deterministic mode (18 % of the pixels differ slightly: the specular
highlights of the vehicle and fine cloud and surface detail), so its tolerance comes out at 21 levels at the
99.9th percentile; a checkpoint that loose is worth a look at what still varies before it is accepted as a
gate (`translunar-earth` is stable to 0.05 % of its pixels).

Commands:

```
BASELINE_RECORD="lead, <date>, signed-off tree" node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional     # self-check of what is recorded
BASELINE_TOOLING_PROOF=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-tooling.spec.ts --project=functional
```

The summed GPU budget table was not re-measured (amendment 2). The baseline is the latest measured table in
`docs/handoff/core-support.md` ("summed GPU budget", `tests/browser/integration/budget.perf.spec.ts`, written
to `out/core-support/budget.md`) and the browser mission's per-phase table in
`docs/handoff/app-integration-v1.md` ("Browser mission": GPU within 11 ms in every phase, worst window 8.4 ms
at lift-off, 2560 x 1440).

## 4. Mission baseline

- `tests/mission/baseline-v1.json` (36 kB), written by `tools/dev/record-mission-baseline.ts` from the flight
  `npm run test:mission` flies: state hash **3f3a131cdd88eba7**, 593,636 steps, 65,725 rails advances, 214,135
  control ticks, 680,497.16 s of simulation, start 938240818.839663, tiles earth `ab20fdfc579d4015` / moon
  `597c5d666b132450`, Node v24.16.0; splashdown in "Central Pacific" at 15.337 deg N, -141.53 deg E.
- Per milestone (17: LIFTOFF ... SPLASHDOWN): `ut`, `captureUt`, MET, vessel, SOI body, situation, BCI
  position and velocity, classical elements (`a`, `e`, `i`, `lan`, `argPe`, `nu`, energy, `h`), apoapsis and
  periapsis altitude, sub-point, altitude, speeds, mass, and the milestone's own `data`.
- `tolerances` in the file state how step 3.1 compares (MIGRATION_V2 principle 3): elements 1e-6 relative,
  touchdown within 50 m, splashdown in the same recovery zone, event times within 1 s. For a milestone under
  thrust the elements are those at `captureUt` (at most one control tick after `ut`): compare those through
  `ut`, altitude and `data`.
- `node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --check` re-flies and
  compares byte for byte (about 50 s). Step 3.1 reads the file; only the lead re-records it.
- `tests/mission/golden.json`: its `tiles.moon` was stale (`d250015b4e1a23f8`): the Moon's albedo layer was
  re-baked on 2026-11-11 15:14 (request sky-lighting-6; 131,072 albedo tiles, no height tile), which changed
  the manifest's content hash and made the determinism test stop before comparing the state hash. The
  re-flown hash and step count are identical, so only that field was updated (c079c0a).

## 5. Terrain guard (`tests/unit/terrain-core/terrain-guard.*`)

- `terrain-guard.heights.json`: the real `TerrainProvider` at 2,000 fixed directions per body on Earth and on
  the Moon (1,200 uniform, 800 in discs of 200 km, 20 km, 2 km and 200 m about the launch site and the
  landing target, from data), asked three ways: collision surface, band limit 25 m, band limit 1,000 m;
  float64 bit patterns, compared bit for bit.
- `terrain-guard.tiles.json`: every tile directory (earth 8,380 directories, 697,349 files, 10.30 GB; moon
  2,344, 164,877, 3.39 GB): file count and name hash, plus bytes and content hash.
- Commands:

```
node tools/dev/heavy.mjs --class=cpu  -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts                        # 9 s: heights, file counts and names
TERRAIN_GUARD_FULL=1 node tools/dev/heavy.mjs --class=bake -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts   # 45 s: also bytes and content of every file
node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts [--heights|--tiles]         # the lead only
```

- A bake that ADDS tiles to an existing tile set (`site-bake`: the Madrakah region into `earth`) makes the
  directories it adds to differ; the package states which, and the lead re-records after checking that no
  other directory changed. New pads add flatten discs: heights inside a new disc change, and the lead
  re-records the heights then (wave 4.1d). A new site or a new scenario landing target changes the fixed
  directions themselves (they are derived from the definitions): re-record with it.

## 6. Root configuration

| Item | State |
|---|---|
| `vitest.config.ts` | Suites by switch: default (unit: `src`, `tests/unit`, `tests/universe`, `tests/load`, `tools`, `server`, `bots`), `MISSION=1` (`tests/mission`), `NET=1` (`tests/net`, timeout 600 s) |
| `playwright.config.ts` | Project `acceptance` (`testDir: tests/acceptance`, 60 min per test); `functional`, `perf`, `mission` unchanged |
| `tests/browser/globalSetup.ts` | `STACK_URL` set: no server is started, `E2E_BASE_URL = STACK_URL` for every project of the run. Without it: as before |
| `tsconfig.node.json` | No DOM library; `@webgpu/types` stays visible because the contracts name GPU object types |
| `package.json` scripts | `typecheck` (both configurations), `test:net`, `e2e:acceptance`, `stack`, `stack:client`, `build:ci`, `check:stubs`; `check` gains `check:stubs` |
| `npm run stack` | `tools/dev/stack.mjs`: runs `node tools/dev/heavy.mjs --class=stack -- node deploy/local/stack.mjs <args>`; `status` and `down` go to the launcher directly (no slot). Until `deploy/local/stack.mjs` exists (platform-delivery) it prints that and exits 3 |
| `npm run stack:client` | `tools/dev/build-client.mjs --target=stack` under `--class=cpu`: `vite.config.ts` unchanged, output `data/stack/client/<source hash>/` with a completion marker; a second run with unchanged sources is a no-op; the two most recent builds are kept. Measured: 0.6 s, 278 files, 146 MB (139 MB of it `public/assets`); second run `built: false`; `dist/` untouched |
| `npm run build:ci` | Typecheck, then the same build into `out/ci/client/` (CI only) |
| `/endpoints.json` | `tools/dev/stackEndpointsPlugin.ts` in `vite.config.ts` (dev and preview): the file named by `STACK_ENDPOINTS`, re-read per request, `no-store`; 404 with no body without it |
| `.gitignore` | `data/packs/`, `data/baselines/`, `data/stack/` |
| Dependencies | `pg ^8.23.1`, `@aws-sdk/client-s3 ^3.1167.0`, `@aws-sdk/s3-request-presigner ^3.1167.0` (dependencies); `embedded-postgres 18.6.0-beta.19` exact (PostgreSQL 18.6; every release of that package carries a `beta` tag) and `@types/pg ^8.23.1` (devDependencies). 45 packages added; `@embedded-postgres/windows-x64` is 108 MB |
| `tools/dev/typecheck-paths.mjs` | Runs both configurations |
| `tools/dev/rootConfig.test.ts` | Unit tests of the above (plugin, globalSetup, includes, projects, scripts, ignore entries) |

## 7. Guards and how to run them

| Guard | Command |
|---|---|
| Boundaries (import and determinism rules, every new rule proven on a planted violation: 62 tests) | `npx vitest run tools/dev/boundaries.test.ts` |
| Stub scan (TODO, FIXME, stub, placeholder; allow-list `tools/dev/check-stubs.allow.json`) | `node tools/dev/check-stubs.mjs` (`--list` shows what is allowed and why) |
| Secrets | `node tools/dev/check-secrets.mjs` |
| Terrain guard | section 5 |
| Mission baseline | section 4 |
| Reference images | section 3 (after the lead has recorded them) |
| Root configuration | `npx vitest run tools/dev/rootConfig.test.ts` |
| Frame clock of the harness | `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/frame-clock.perf.spec.ts --project=perf` |

Boundary rules added: `src/universe` (imports `src/core`, `src/sim`), `src/session` (`src/core`, `src/sim`,
`src/universe`), `src/net` (`src/core`), `src/client` (`src/core`, `src/sim`, `src/net`; never
`src/universe`, `src/session`, `server/`), `src/shell` (`src/core`, `src/render/core`,
`src/sim/vessel/public`), `src/bench` (`src/core`, `src/render/core`), `src/gate` (nothing outside itself,
no package), `server/` (`src/core`, `src/sim`, `src/terrain`, `src/universe`, `src/net`; never the client,
the presentation, `bots/` or `deploy/`), `bots/` (never `src/render`, `src/ui`, `src/map`, `src/shell`,
`src/audio`, `server/`, `deploy/`), `src/sim` never `src/universe`, `src/session`, `src/client`; the client
bundle walk from `src/app/main.ts` over imports and worker entries (no `server/`, no `bots/`,
`src/universe` only behind `src/session`); headless list extended to `src/universe` and `src/session`, with
sockets, `fetch` and storage banned there (the tile I/O modules of `src/terrain` may `fetch` and use
`navigator.storage`); `pg`, `ws`, `embedded-postgres` and `@aws-sdk/*` only in `server/` and `bots/`.

The gate: `--class=stack`, ONE slot, no override; held by the wrapped launcher for the stack's whole life; a
second launcher waits (measured: first held 7.0 s, second started 7.75 s after it was issued); a dead
holder's slot is reclaimed; `--status` shows the holder. GPU stays at ONE slot.

## 8. Request app-integration-8 (the 57.5 Hz clock)

Resolved. Cause, fix and numbers are in `docs/requests/app-integration-8.md` ("Resolution") and
`docs/research/webgpu-harness.md` (section 3a). In short: while the monitor sleeps, Chrome on Windows paces
frames with a 17 ms sleep instead of the vertical blank, so every page runs at about 57.5 Hz, headless or
headed, at any size, whatever it draws. Measured on bare pages: display off 17.3-17.4 ms p50, 18.0 p95
(57.4-57.5 Hz); display on 16.70 p50, 16.80 p95 (60.00 Hz); the experiment switches the monitor off and on
and reads the display state back. `withGpuLock` now keeps the display awake (`keepDisplayAwake`);
`measureHarnessClock(page)` and `expectNominalClock(clock)` let a spec judge pacing only on a 60 Hz clock.
No budget was changed and no Chrome flag is involved. Still to do by app-integration: call the two helpers in
the mission and app perf specs (their rAF columns of 2026-11-11 were taken on the sleep-paced clock).

A side effect to know: a perf run now wakes the monitor and keeps it on while it measures.

## 9. Suites before and after

| Suite | Before (22:10) | After |
|---|---|---|
| `npm run typecheck` | passes (one configuration) | passes (two configurations) |
| Unit (`npx vitest run`) | 104 files, 1109 tests: 1107 pass, 2 fail | 113 files, 1263 tests: 1262 pass, 1 fail (the same `realData` pad test); 58 s |
| Headless mission (`npm run test:mission`) | 31 tests: 30 pass, 1 fail (stale tile hash in `golden.json`); state hash 3f3a131cdd88eba7 | 31 tests, all pass; state hash 3f3a131cdd88eba7, 593,636 steps (unchanged); 68 s |
| Browser, `tests/browser/shell` frame clock (perf: awake against as found, the helper, the display experiment) and reference-image tooling (functional) | - | 3 + 7 tests pass |

The unit suite grew by the tests of this step (boundaries 62, root configuration 11, rules 4, frame 9, terrain
guard 4) and by other agents' new tests. The whole functional browser project was not run (section 10).

The two unit failures before this step: `tests/unit/flight-ui/displays.test.ts` (the flight-ui agent's work
in progress at that minute; fixed by its commit 2bd0a88) and `tests/unit/terrain-core/realData.test.ts >
launch-site pads are flat within 5 cm over flatRadius` (worst 2.67 m: the site has a pad shape since request
terrain-render-6, exactly flat only inside the core and the slab areas, and the test still asserts the whole
disc; the terrain owner's to bring in line).

## 10. Not done, and why

- **Reference images and the GPU budget table re-run**: deferred by the lead's amendment (section 3).
- **`.wslconfig`**: NOT written. The session's permission system refused the action (writing
  `%UserProfile%\.wslconfig` and `wsl --shutdown`), and that refusal was not worked around. State found:
  WSL 2.7.3, distributions `Ubuntu` and `docker-desktop` both stopped, no `.wslconfig`, no Docker process.
  The user or the lead does it by hand before the first compose suite (wave 5); nothing in waves 3 and 4
  needs Docker. File content:

  ```
  [wsl2]
  memory=6GB
  processors=8
  swap=2GB

  [experimental]
  autoMemoryReclaim=dropCache
  ```

  then `wsl --shutdown`. It applies to every WSL 2 distribution of the account. OPEN_QUESTIONS, "Small
  things", says the same.
- **Contract items that could not be additive**: the table in section 2.
- **Functional browser project, whole**: not run (one GPU slot shared by six agents; the amendment limits
  this step's browser work to the frame clock and the two-checkpoint proof).
- **History of the swap**: the three renames are in commit 7d9c765 (another agent's, see the log), the
  content in 1fa34fa. The tree is as intended; nothing was amended.

## 11. Notes for the lead

- Other agents compile against the working tree, not the last commit. A contract edit is visible to them the
  moment it is saved, and they adapt to it at once (35eeb0b). Make contract changes in one save and commit
  them within minutes; never leave `src/core/contracts` in an intermediate state.
- With one GPU slot, a queued browser run waited 40 minutes at one point. The gate now keeps the order of
  arrival; the wait is still the sum of the runs ahead.
- `tests/unit/terrain-core/realData.test.ts > launch-site pads are flat within 5 cm over flatRadius` has been
  red since the pad shape of request terrain-render-6; it needs its owner (the test should assert the core
  and the slab areas, or the shape's relief share).
