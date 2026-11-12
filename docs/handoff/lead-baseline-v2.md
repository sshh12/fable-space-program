# lead-baseline-v2: hand-off

The lead's step before wave 3 of `docs/WORK_PACKAGES_V2.json` (MIGRATION_V2 step 3.0), with the lead's
amendments of 2026-11-11: five other agents were working in the tree, the reference images are deferred to
the visually signed-off tree, the document swap comes last.

It changed no behaviour: the suites give the results they gave before it (section 9). An independent review
followed (six majors, five minors); what it changed is in section 12, and sections 3, 4 and 5 below are
written for the state after it.

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
- Capture is FRAME-EXACT (review fix E): the page is opened with frozen presentation time
  (`deterministic=1&paused=1` on the labs); when `isIdle()` the harness calls
  `window.__test.renderExact(frames)`, a new optional hook of the contract: the page restarts every temporal
  sequence, renders exactly `frames` frames and holds the last one on screen, and the screenshot is of
  that held frame. `captureDeterministic` refuses a page without the hook. **The render core does not have it
  yet: request `docs/requests/lead-3.md` (open, for the shared-code maintainer and the app) states the exact
  semantics. Until it is in, no reference image can be recorded.** `captureSettled` is the old
  wait-and-shoot, for pictures that are not references.
- Recording: THREE or more fresh loads; the first capture is the reference; tolerance = max(floor, 3 x the
  largest difference between any two loads), floor `{ meanAbs: 0.02, p999: 1 }`. The manifest entry stores
  file, sha256, size, tolerance, that difference, the number of loads, commit, Chrome, adapter, the tile
  sets' content hashes and the lead's note.
- A comparison refuses a reference file whose sha256 is not the manifest's, names tile sets whose content
  hash differs from the recording's and a changed Chrome version or adapter, and on failure writes `out/screens/baselines/<name>.actual.png` and
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

Proof on two checkpoints WITH THE OLD CAPTURE (wait about 64 frames, then a screenshot; two loads), which
is what showed that capture to be inadequate (2026-11-11 23:55, RTX 5090, Chrome 157, on a PROOF manifest under
`out/qa/baseline-proof/`, not the tracked one; the captures were looked at):

| Checkpoint | Two recordings differ by | Tolerance (3 x, at least the floor) | Third capture | One pixel row changed by 48 levels |
|---|---|---|---|---|
| leo-day | mean 0.12825, p99.9 7, max 95, 18.3 % of pixels | mean 0.38475, p99.9 21 | mean 0.1140, p99.9 6: clean | p99.9 48: caught |
| translunar-earth | mean 0.00247, p99.9 0, max 112, 0.05 % of pixels | mean 0.02 and p99.9 1 (the floor) | mean 0.0024, p99.9 0: clean | p99.9 48, mean 0.0246: caught |

A reference file that is not the recorded one (sha256) is refused. `leo-day` differed in 18 % of its pixels
between two loads (the specular highlights of the vehicle, fine cloud and surface detail: whatever integrates
over frames was at another phase), and a tolerance of 21 levels at the 99.9th percentile would let a
130 x 130 pixel patch change by 21 levels and pass. That is why the capture is now frame-exact and the
tolerance comes from three loads. The proof has to be repeated with the lead once `renderExact` exists
(the command below); the acceptance is that the three loads of each checkpoint differ by no more than the
floor.

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

- `tests/mission/baseline-v1.json` (format 2), the record of the v1 code on the v1 clock: state hash
  **3f3a131cdd88eba7**, 593,636 steps, 65,725 rails advances, 214,135 control ticks, 680,497.16 s of
  simulation, start 938240818.839663, tiles earth `ab20fdfc579d4015` / moon `597c5d666b132450`, Node v24.16.0;
  splashdown in "Central Pacific" at 15.337 deg N, -141.53 deg E.
- Per milestone (17: LIFTOFF ... SPLASHDOWN): `ut`, `captureUt`, `captureOffset` (how long after the event
  the state was taken: 0 for twelve, 1/60 to 1/40 s for MAX_Q, FAIRING_JETTISON, LUNAR_LIFTOFF,
  ENTRY_INTERFACE and SPLASHDOWN), MET, vessel, SOI body, situation, BCI position and velocity, classical
  elements, apoapsis and periapsis altitude, sub-point, altitude, speeds, mass, and the milestone's `data`.
- **It is not compared by a fixed tolerance** (review fix A; the 1e-6 / 50 m / 1 s of the first version is
  gone). The scripted pilot decides at 30 Hz, so a flight is a chaotic function of its start instant:
  sim-core-v2 measured that a 2 ms start shift of the unmodified v1 code moves EARTH_ORBIT by 4.8e-5 in da/a,
  TLI by 1.6e-3, the lunar touchdown by 47 s and the splashdown by 15 s, while the unshifted code reproduces
  the record bit for bit. Two comparisons (`tools/dev/mission-baseline.ts`, tested in
  `mission-baseline.test.ts`):
  - **EXACT**, for a step that must not change behaviour and starts at the bit-identical instant: every
    milestone's event time, capture time and state equal. It says at which milestone a difference starts.
  - **ENVELOPE**, for a step that legitimately moves time (the tick grid, later the session switch): per
    milestone, the difference from the baseline in event mission time and in da/a must be within twice the
    largest such difference among the control flights (the reference code with shifted starts only, recorded
    by the step's owner in a controls file), with floors of one control tick (1/30 s) and 1e-12; and the
    mission gates must pass.
  - In both: angles as wrapped absolute differences, `nu` never compared, the capture offset stated.
- Commands (the first two fly nothing):

```
npx tsx tools/dev/record-mission-baseline.ts --exact <record.json>
npx tsx tools/dev/record-mission-baseline.ts --envelope <record.json> --controls <controls.json>
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --check                    # fly, EXACT against the baseline
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/dev/record-mission-baseline.ts --out <file> [--label x]   # fly, write a record
```

  `captureMilestones(label)` of that tool gives an owner the same record from its own `fly()` set-up (control
  flights with shifted starts); a controls file is `{ "controls": [ <record>, ... ] }`. Only the lead rewrites
  the baseline (`--record-baseline`). The format-2 file was derived from the first recording; nothing was
  re-flown for it.
- `tests/mission/golden.json`: its `tiles.moon` was stale (`d250015b4e1a23f8`): the Moon's albedo layer was
  re-baked on 2026-11-11 15:14 (request sky-lighting-6; 131,072 albedo tiles, no height tile), which changed
  the manifest's content hash and made the determinism test stop before comparing the state hash. The
  re-flown hash and step count were identical, so only that field was updated (c079c0a).

## 5. Terrain guard (`tests/unit/terrain-core/terrain-guard.*`)

- `terrain-guard.heights.json` holds THE DIRECTIONS THEMSELVES (bit patterns) and the heights there, per
  body, in groups: `uniform` (1,200 points over the sphere) and one group per named place (800 points in
  discs of 200 km, 20 km, 2 km and 200 m): today `site:ka-lae-lc1` on Earth and the landing target on the
  Moon, 2,000 points per body. A group is seeded from a hash of `<bodyId>:<group key>`, never from an index
  into the library. The test samples the stored directions, three ways (collision surface, band limits 25 m
  and 1,000 m), bit for bit. So thirty more bodies, a second site, the site's rename or a new scenario move
  no point (review fix B: the first version re-derived the directions from the library and would have been
  re-dealt by the Madrakah site).
- A new place is APPENDED as a group (`--add-place`); every existing point keeps its index, direction and
  height. A changed height is reported with its point, group, latitude and longitude, so a step that adds
  flatten discs can assert that only points inside the new discs changed (`heightDifferences`, `distanceTo`).
- `terrain-guard.tiles.json`: every tile directory (earth 8,380 directories, 697,349 files, 10.30 GB; moon
  2,344, 164,877, 3.39 GB): file count, name hash and bytes; and the content hash.
- Commands:

```
node tools/dev/heavy.mjs --class=cpu  -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts                        # 29 s: heights; every directory's count, names and bytes (by stat)
TERRAIN_GUARD_FULL=1 node tools/dev/heavy.mjs --class=bake -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts   # about a minute: also the content of every file
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --add-place <bodyId> <key> <latDeg> <lonDeg>   # the lead only
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --resample                  # the lead only: keep the directions, sample again
node tools/dev/heavy.mjs --class=bake -- npx tsx tests/unit/terrain-core/terrain-guard.record.ts --tiles                     # the lead only
```

- A bake that ADDS tiles to an existing tile set (`site-bake`: the Madrakah region into `earth`) makes the
  directories it adds to differ; the package states which, and the lead re-records the summaries after
  checking that no other directory changed, and appends the new site's group. New pads change the heights
  inside their flatten discs: the lead resamples after checking that only those points changed.

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
  The user writes it (the agents do not). It is needed in sub-wave 3.1 already: `platform-delivery` has a
  docker compose suite (the pinned-image form of the local stack) and has been told not to start Docker
  until the user has written the file; everything else of waves 3 and 4 runs on the host stack without
  Docker. File content:

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

## 12. Review fixes (2026-11-12)

An independent reviewer found behaviour unchanged and the contracts and configuration complete, with six
majors and five minors. All were addressed; nothing was re-flown and nothing was recorded in a browser.

| # | Finding | What was done | Commit |
|---|---|---|---|
| A | One blanket tolerance in `baseline-v1.json` could not fit the milestones; then, from sim-core-v2's measurements, no tolerance can (a 2 ms start shift moves the flight) | The record is compared EXACT or by ENVELOPE (section 4); the file is format 2 with per-milestone `captureOffset` and no tolerance; `tools/dev/mission-baseline.ts` with 14 tests; MIGRATION_V2 principle 3, step 3.1 and section 8 describe the modes and sim-core-v2's same-start reference `tests/mission/reference-v1-aligned.json` | 431930f |
| B | The terrain guard's directions depended on the library (body index, the list of places) | Directions stored in the heights file, grouped, seeded by name; new places append; the present guard was confirmed green on the working tree first, then re-recorded; the every-commit form also compares bytes by stat (section 5) | cde7b30 |
| C | A gate slot read free while the wrapped command lived after its wrapper was killed | The slot file records the command's pid; a `node ...` command is started without a shell; when both pids are dead a waiter looks once at the process table for live processes they started (orphans) and the slot stays held until those are gone (`--status`: HELD BY ORPHANS); on a signal the wrapper kills the command's tree (`taskkill /T /F`). Measured: a killed wrapper takes its direct child with it, but `npx tsx script` behind it ran to its end, and so did a detached process; both now hold the slot. **For platform-delivery:** a process orphaned twice is not seen, so `deploy/local/stack.mjs` takes its own exclusive lock under `data/stack` as well | d01a8cc |
| D | Holes in `boundaries.test.ts` | No Node builtin in the headless directories or `src/net` except `src/terrain/fs*.ts` (a `*.node.ts` name is no excuse there); Node networking and threads nowhere outside `server/` and `bots/`; the headless ban gains `crypto.*`, `process.*`, `setImmediate`, `queueMicrotask`, `new Worker`, bare `Date(`; template-literal dynamic imports are imports and template interpolations are scanned; each proven on a planted violation (93 tests) | 2da43e5 |
| E | The reference capture was not frame-exact (18 % of leo-day's pixels differed between loads) | `TestApi.renderExact?(frames)` in the contract; `captureDeterministic` uses it and refuses a page without it; three or more loads; a comparison reports a changed Chrome or adapter. The render-core side is request `lead-3` (open). Nothing recorded; to be proven with the lead | 04a8231 |
| F | `.wslconfig` | Not written and not to be written by an agent; hand-off, STATUS and OPEN_QUESTIONS now say that `platform-delivery` (3.1) needs the Docker VM cap for its compose suite and does not start Docker until the user has written the file | a928b4c |
| 7 | Stub scan missed identifiers, lower-case comments, vitest's name, render sections | Identifier words (camelCase, snake_case); TODO / FIXME in any case inside comments; standing allow-list entries for `stubGlobal` / `stubEnv` and `data/defs/render` (Earth and Moon excepted) | 340ebbe |
| 8 | `build-client.mjs` could expose a half-written build, race, or prune a served build | Builds into `<hash>.tmp-<pid>` and renames; a lock per output (two callers at once: one build); a build with a live `data/stack/client/<hash>.use-<pid>` file beside it is never pruned (**the launcher writes that file before serving a build**) | 340ebbe |
| 9 | `FrameEpochTracker` mis-rebased a holder that skipped a snapshot | `SnapshotFrame.previous`: the origins of the last `FRAME_HISTORY_EPOCHS` (8) epochs in the current frame, in every snapshot; the tracker rebases from the epoch its consumer last observed and tells a holder older than the history to reset. **The producer of `frame` (sim-core-v2, step 3.5; later the view builders) fills `previous`** | a44b849 |
| 10 | Contract nits | `launchWindows` / `describeConic` take the target revision; `ClockState.untilTick`, `CensusEntry.horizonTick` / `.limitTick` are `number \| null` (no Infinity in JSON types; tested); `limits.subscriptionsPerSecond` 5 and `limits.accountsPerAddressPerHour` 10 (**the lead's choice**: section 26 gives no number), `contact.defaultCrashTolerance` 6 m/s; a test holds `data/defs/rules/default.json` equal to the defaults once it exists; `MarkerKindV2` comment; `SettingsModel.audio.buses` covers the v2 buses | 423a106 |
| 11 | The deferred joins lived only in this hand-off | Rows in MIGRATION_V2's lead-steps table (before 3.2, after 3.2, before 4.1, with 4.1c, after 4.3) and a LEAD NOTE in twelve briefs of WORK_PACKAGES_V2.json | 6f75c04 |

Rejected: nothing. Two findings were answered differently from the letter of the review, on evidence:
A (the coordinator's correction replaced tolerance classes by the two modes), and C (the command's pid alone
does not cover the reproduced case: through the shell that pid is `cmd.exe`, which dies with the wrapper
while the command lives, so the orphan search was added).

Suites after the fixes (2026-11-12 01:50, sub-wave 3.1 running in the tree with uncommitted work):

| Suite | Result |
|---|---|
| `npm run typecheck` (both configurations) | No error in the lead's paths or caused by a contract change. 9 errors, all in `tests/unit/bodies/*.test.ts` (untracked work in progress of `bodies-ephemeris`) |
| Unit (`npx vitest run`) | 131 files, 1424 tests: 1404 pass, 10 skipped, 10 fail in 6 files, all other packages' work in progress (`tests/unit/bodies` 2 files that do not compile + 3 tests, `tests/unit/planet-bake` 1, `tests/unit/site-bake` 5, `tests/unit/terrain-render/selection.test.ts` 1). The lead's suites pass: boundaries 93, root configuration 12, mission record 14, frame 14, rules 6, terrain guard 6 |
| Headless mission | NOT flown again: the tree holds sim-core-v2's uncommitted tick-grid work and the instruction was to derive from the existing records. `npx tsx tools/dev/record-mission-baseline.ts --exact tests/mission/baseline-v1.json` (no flight): all 17 milestones equal, state hash 3f3a131cdd88eba7 |
| Browser | None run (one GPU slot; nothing of the fixes needed one). The frame-exact proof waits for request lead-3 |
| `node tools/dev/check-stubs.mjs`, `check-secrets.mjs` | OK (20 allowed uses); OK |

## 13. Contract-owner work after the independent review of sim-core-v2 (2026-11-12, 03:45-04:00)

The lead's decisions on that review, as far as they are in the lead's paths. sim-core-v2 implements its side
and fills the new fields; nothing here touched its paths.

| # | Item | What was done | Commit |
|---|---|---|---|
| 1a | The cockpit of a craft | `CraftSnapshot.cockpit?: CraftCockpit \| null` with `CraftCockpit { id: string \| null; cameraSeat: string \| null; sensorMount: { pos; lookDir; upDir } \| null }` (part frame, the def's tuples): the three fields of sim-core-v2's `CommandRuntime`. null = no command part; absent = not produced yet. Required at the tighten step | 537da5f |
| 1b | Pad limits as rules data | `PadClassLimits { maxLiftoffMass; maxDiameter }`, `UniverseRules.pads.classLimits?: Record<PadClass, PadClassLimits>`, `DEFAULT_PAD_CLASS_LIMITS` (PROVISIONAL: heavy 3,000,000 kg / 9.5 m = LC-1's numbers, medium 700,000 / 7, light 70,000 / 2.5 from the research's sheets rounded up); `PadDef.maxLiftoffMass?` / `maxDiameter?` are optional overrides; "no Infinity" stated on both | 537da5f |
| 1c | `advanceRails` | The comment says where it lands: the first tick at or after the target, or at or after the next event when that comes earlier; never between two ticks | 537da5f |
| 1d | Id rules | Header of `sim.ts` ("Ids"), `CraftSnapshot.id`, `PartSnapshot.instanceId`, `VehiclePartPlacement.id`: craft ids are universe-unique; craft ids and instance ids contain neither '/' nor '~'. `SimEvent`: event part ids have two forms until the tighten step after 3.2, then the part key in one form | 537da5f |
| 2 | ENVELOPE | Fails on a body or situation mismatch at a milestone; e and i judged like the event time and da/a (floors 1e-12; twice the controls' spread); every reason named; a control that is about another body there leaves the milestone without an envelope ("controls file unusable"). The header states what each check can and cannot catch with the reviewer's numbers. 16 tests | 7bfbcd5 |
| 3 | ARCHITECTURE, MIGRATION_V2 | Tick-pure state (3, 5.2, 7.2's codec list: no clock base); craft identity (3 with the id table, 7.2, 7.5); pad class limits (9.3); rules files as overrides (12). MIGRATION: principle 3 (the envelope and what each check catches), principles 4 and 5 (one more re-record by lead authorisation: the golden is re-baselined five times in all), lead-steps rows "during sub-wave 3.1" and "with fleet-data", "after 3.2" (event part ids in one form, `CraftSnapshot.cockpit` required), section 4, section 8 (the pins). Request sim-core-v2-3 answered | b1a5f42 |
| 4 | Briefs | LEAD NOTE (after the independent review of sim-core-v2) in `island-core` (tick-pure state, no clock base, the pinned files), `contact-docking` (craft identity, the crew flag), `fleet-data` (the corpus path, the pad class limits, the id characters) | 5f18684 |

**Decisions taken here, and why.**

- **`classLimits` is optional and its defaults are a constant beside `DEFAULT_UNIVERSE_RULES`, not yet a
  field of it.** `validateRules` (src/core/defs/loader.ts, sim-core-v2's) holds every rules file to exactly
  the fields of the default document, so adding a field to that document fails the load of the whole
  library, for every agent and for the dev server, until the three files state it; those files are not the
  lead's. A reader takes `rules.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS`. **Open lead step** (MIGRATION_V2,
  "during sub-wave 3.1"): once sim-core-v2's loader reads rules files as overrides of the default, move the
  constant into `DEFAULT_UNIVERSE_RULES.pads.classLimits` and make the field required; one commit,
  `net.test.ts` already holds the two equal. At 04:00 the loader was still the strict one.
- `net.test.ts`: the comparison of `data/defs/rules/default.json` with the default document is now "whatever
  the file states equals the default and is a field of `UniverseRules`", which holds for the full file of
  step 3.6 and for the override form.
- The envelope's floors for e and i are 1e-12, as for da/a. Checked on data, not assumed: no control flight
  has a body or situation mismatch at any milestone, and the present code (flown ONCE through the gate with
  `--out` into the scratchpad, about a minute; state hash 7da3ffe86c85228d = the golden) is inside at all 17
  milestones under the stricter comparison, so `tests/mission/full-mission.test.ts` ("envelope") still passes.
  Nothing was recorded or re-recorded.
- `tests/mission/baseline-v1.json` was NOT touched: its embedded `compare.envelope` text predates the e and
  i check (the field is documentation; the code is the authority). The file may be among the pinned ones.
- ARCHITECTURE and MIGRATION record the two decisions **as decided**: docs/handoff/sim-core-v2.md still
  carried the superseded note ("the clock base is state") when this was written. The form of a departing
  piece's new craft id and of its lineage record are not stated anywhere yet; the architecture names the
  hand-off as their source and its 7.2 sketch has a comment line, not a field.

**Open after this round.**

- `tools/dev/guard-pins.test.ts` had not landed at 04:00: **not reviewed.** When it lands: it is in the
  lead's path by the lead's authorisation; check that it pins by content hash, that a missing file fails,
  that it lists what MIGRATION_V2 names, and that `tools/dev/boundaries.test.ts` and the stub scan accept it.
- The wording of ARCHITECTURE 3 / 7.2 (craft identity: id form, lineage record, "command root") and of the
  tick-pure rule is to be aligned with sim-core-v2's hand-off once it is updated.
- **The corpus path.** The instruction and fleet-data's brief say `tests/unit/sim-vessel/corpus`; the tree
  has `tests/unit/sim-vessel/codec-corpus` (sim-core-v2, step 3.4). The note in fleet-data's brief names the
  former as the one path and tells the package what to do if it still finds the latter. If the decision
  was the other way round (the brief's path is wrong), that note needs one sentence changed.
- `CraftSnapshot` has no lineage field: not asked for; the presentation does not need it today.
- `src/core/fakes/fakeSim.ts`: its `advanceRails` lands on the float instant, not on a tick (not the lead's
  path; for whoever writes `FakeSession`'s conformance tests in sub-wave 3.2).
- sim-core-v2's side of 1b: `checkPad` still requires both pad limits and `singlePadOf` still writes
  `Infinity` in memory.

Suites (03:50, sim-core-v2 not yet at work in the tree): `npm run typecheck` (both configurations) clean on
the whole tree after each contract change; `src/core/contracts`, `src/core/defs/loader.test.ts`,
`tools/dev/boundaries.test.ts` 120 tests pass; mission record 16, root configuration 12 pass;
`check-secrets` OK. No browser run.
