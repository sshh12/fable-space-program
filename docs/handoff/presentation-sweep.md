# presentation-sweep: hand-off (sub-wave 3.2; NOT FINISHED: first working context ends here)

The one sweep over every presentation consumer (brief: `docs/WORK_PACKAGES_V2.json`, id `presentation-sweep`,
with its LEAD NOTES; the last one is the work order). The package is larger than one working context. This
file is the state at the end of the first: what is done and committed, what is left in the order to do it,
every decision taken and why. A successor continues from "Left to do" and
`git log --oneline --grep presentation-sweep`.

## 1. State of the sweep

Start: commit b076166 (the lead's contract step is 31e67fa; the tree before it is tagged
`pre-sweep-2026-11-16`). One commit per subsystem. The whole tree compiles at every commit except for
`src/net` and `tests/unit/net`, which are `wire-protocol`'s and were in motion while the sweep ran; filter
them: `npx tsc --noEmit -p tsconfig.json | grep -v "src/net\|tests/unit/net"` (empty at 311feed).

### 1.1 Done and committed

| # | Commit | Subsystem | Image gate after it (BASELINE_ONLY) |
|---|---|---|---|
| 1 | 105b8f8 | The lead's work order: the 21 compile errors. Binding table (the six v2 actions, `sas:target`, `sas:antiTarget`, `sas:portAlign`, their key labels and reference-card lines), the HUD's SAS row and names, the MFD's two pages, the chase rig's reference mode, the map's `targetApproach` tables, `setTarget(TargetRef)` at every call, the default of `'ui.scrimRects'`, the `pause` key as `flightMenu`, the selected target through ONE helper | `sweep-hud-leo`, `sweep-map-translunar`, `sweep-cockpit-leo`, `sweep-app-pad`, `sweep-app-cockpit`: 0 pixels each, first load |
| 2 | 32203ca | The vessel feature: per-part state under the LINEAGE key (`CraftSnapshot.parent`, never the vessel id), the engines a part carries from the part list (`src/render/vehicle/mounts.ts`), no vehicle definition; `CraftLineage` and the part keys in the access module | `pad-noon`, `ascent-10km`, `leo-day`, `lunar-orbit-low-sun`, `parachute-descent`, `sweep-hud-leo`, `sweep-separation-debris`, `sweep-app-pad`: 0 pixels each, first load |
| 3 | 1a93c40 | The HUD model: resource groups and labels from the parts (`stageGroup`, `stageLabel`, per craft), a stage's label from the staging panel, the words about a stage through one label source | with the gate of row 4 |
| 4 | adbddff | `FakeSession` (`src/core/fakes/fakeSession.ts`) with the scenes of the shared universe, client stores and a conformance test per scene; `createFakeSim` kept as its v1 name | run with the fake Moon-centred in every lab: see D7 and request presentation-sweep-4 |
| 5 | 311feed | Camera rigs, cockpit feature, seat names on the craft blocks (`chaseDistanceLimits`, `cabinOf`, `labelVehicleOf`); the view manager, map rig and audio listener cope with no active vessel; `createFakeSim` keeps the v1 render root | THE FULL SET OF 33: section 3 |

| 6 | 1c72140 | (second working context from here) The access module moves to `src/core/access/snapshotAccess.ts` (the lead's answer to request 1); no boundary entry was needed (`src/core` is one area) | not a pixel change |
| 7 | 3b80cfc | Pads: every reader through `padsOf` / `padOf` / `padLocationOf`; the site feature keeps one runtime per pad; a structure generator is given its pad; a ground survey per pad; the terrain's ground plans, the pad smoke, the effects' flat disc and the chase rig's trench per pad | THE FULL SET: 33 of 33, the 30 exact at 0 pixels on the first load, no OTHER STATE line |
| 8 | 08efeb3 | `tick` -> `revisionOf` everywhere; no active vessel in the audio model, the effects and the labs; effects and audio key per-part state by the part key; `findEventPart`; unit tests on the keys | with the gate of row 9 |
| 9 | 22622c4 | The stage words, the crew and the fairing petal from the snapshot (`StageInfo.burnLabel`, `actionChutes`, `chuteEnvelopes`, `thrustVac`, `weightFlowVac`; `CraftCockpit.crew`; `PartSnapshot.panel`): `labelVehicleOf` is gone, no petal id is read or composed; the fake states the members through `describeStages` | THE FULL SET: section 3 |

Unit suites at 311feed (`src/render src/ui src/input src/camera src/map src/audio src/core/fakes src/app`
and `tests/unit/{atmosphere,audio,cockpit,flight-ui,map-view,ocean,render-core,sky,terrain-render,vehicle,vfx,camera,fakes}`,
`tools/dev/boundaries.test.ts`): 78 files, 950 tests, all pass. `tests/unit/camera` (two files that no
package of `WORK_PACKAGES_V2.json` owns; this package may not edit them) passes unchanged.

### 1.2 Left to do, in this order

1. (done in the commit of this file: the chase limits of a three-craft assembly and the rigs without an
   active vessel are held by two tests in `tests/unit/flight-ui/camera.test.ts`.)
2. **Pads**: every reader of `LaunchSiteDef.pad`, `.padAzimuthDeg`, `.structures` through `padsOf` / `padOf`
   / `padLocationOf` (`src/core/defs/sites.ts`). Readers (grep `\.structures\b|padAzimuthDeg|site\.pad\b`):
   `src/render/vehicle/siteFeature.ts` (ONE RUNTIME PER PAD: frame at the pad's own location, arm state and
   `padActivity` per pad, `state(siteId, padId?)` / `override(siteId, patch, padId?)`, the option callbacks
   given the pad), `site/pad.ts:395`, `site/survey.ts:76` (a pad other than the first that has structures
   needs a survey of its own: throw as a site without one does, never level ground), `src/render/terrain/
   feature.ts:398` and `sitePlan.ts:61-62`, `src/render/vfx/director.ts:144-150` and `smoke.ts:830,921,926`,
   labs (`labs/vehicle/labSim.ts:285-286`, `labs/vfx/scenes.ts:46-50`, `labs/integration/main.ts:235`,
   `labs/flight-ui/main.ts:336`), tests (`tests/unit/vehicle/site.test.ts`, `looks.test.ts`,
   `tests/browser/vehicle/game.spec.ts`). The chase rig's trench heading reads `pads` already; the fake reads
   `padOf(site)`. No file under `data/defs/sites` may change (rule 7a): with today's data `padsOf(site)` is
   the single pad, so every pad checkpoint must stay exact.
3. **`snapshot.tick` -> `revisionOf(snapshot)`**: `src/render/cockpit/displays.ts:231`, `src/audio/model.ts:767`,
   `labs/cockpit/main.ts:275`, `src/map/testing/syntheticSnapshots.ts:663` (a producer: add `revision`).
   **`activeVesselId`**: 123 reads in 62 files at the start; done so far: `src/ui/model.ts`, the camera
   package, `src/render/cockpit/feature.ts` (`pick`), `src/map/controller.ts` (target click). In `src` about
   thirty reads are left and most are a `find` that copes with null as written. THE ONES THAT DO NOT:
   `src/audio/model.ts:294-296` (falls back to `vessels[0]`, dereferences it, and reports a missing active
   vessel as a problem every frame), `src/render/vfx/feature.ts:391` (the same fallback) and `:519`
   (`frame.vesselPose(snap.activeVesselId)`), `src/render/core/lab/camera.ts:179`. The ocean's wetness slots
   (`src/render/ocean/vessels.ts:174`) already sort the active vessel first and the rest by height, which is
   "nearest first" without one. Then `src/app` (game.ts 362 and 506, testHooks, pictureStops: `find`s) and
   the labs (68 reads at the start).
   The neutral singleton blocks are the session's to produce (`neutralFlightBlocks()` of src/sim/view does
   not exist yet): a consumer reads them as they are.
4. **Ids**: `src/render/vfx/director.ts:357` composes `#panel0` (request presentation-sweep-2);
   event part ids: use `eventPartOf` (access module) wherever an event's `partId` is matched against parts
   (grep `ev.partId`, `e.partId` in `src/render/vfx`, `src/audio`, `src/ui/hud/hud.ts:861`); vfx and audio
   keep per-part state (emitters, voices): key it with `CraftLineage.keyOf` as the vessel feature does, and
   add the unit tests on keys for plume state (acceptance line 4).
5. **Frame rebase**: `FrameEpochTracker` (src/core/math/frame.ts) in: the view manager (`last.positionRoot`
   is handed to `rig.activate`), the chase rig (`lastDir` and the swing are directions: check), the map rig
   (focus is an id: nothing held; check `glide`), the render core's previous-frame state (`frame.prevCamera`,
   `prevSnapshot`, the vessel poses' `prevOriginRelCam`: motion vectors must not spike at an epoch change),
   vfx world-anchored effects (`explosion.posRoot`, trails, dust), the vessel feature's ghosts
   (`g.vessel.rRoot` held for the fade: rebase or drop at an epoch change). The fake gives the test:
   `FakeSession.setRenderRoot(bodyId)` replaces the origin as an SOI change does (epoch, rebase, history).
   Tests asked by the brief: the same frame with the origin at Earth and at the Moon (mean difference under
   one level per channel: `createFakeSession` with `renderRoot` 'rootBody' and 'focusBody'; D7 has the
   numbers as they are today) and a screenshot pair across `setRenderRoot` with no step and no motion-vector
   spike.
6. **The tile-source seam**: `WorkerInit` (`src/render/terrain/workerProtocol.ts`) carries a
   `TileSourceSpec`; `tileWorker.ts` and the streamer call `createTileSource(spec)`
   (docs/handoff/platform-delivery.md); the dev default stays fetch; the terrain lab through kind `fetch` and
   kind `pack` (the pack against the local stack: `npm run stack -- ... -- <suite>` with
   `STACK_NAME=fsp-presentation-sweep`) with identical frames.
7. **Render core**: the scrim step in the tonemap pass (bloom pyramid inside `'ui.scrimRects'`; no
   rectangle, no cost; at most 0.1 ms with four), `CameraState.exposureHint { targetEv100, rateEvPerS }`
   and `lensShift`; `docs/RENDER_API.md`. The default buffer exists (commit 1).
8. **`createSim` -> `createSession`**: `src/app/game.ts`, `labs/integration/features.ts` and `main.ts`, every
   spec; `Sim` / `SimDebug` -> `LocalSession` / `SessionDebug` (many labs type their sim as `Sim`); specs
   that assert an Earth-centred `rRoot` rewritten to differences. `sweep-lunar-orbit` (tolerance) is the one
   recorded picture the moving origin touches. Labs may move from `createFakeSim` to `createFakeSession`
   only with `renderRoot: 'rootBody'` until request presentation-sweep-4 is decided.
9. **`tests/unit/fakes/deprecated.test.ts`** (the grep test): no file outside `src/sim`, the loader and
   the listed exceptions reads `.tick` of a snapshot, `.targetBodyId`, `.targetClosestApproach`,
   `LaunchSiteDef.pad` / `.padAzimuthDeg` / `.structures`, `'pause'`, `createSim`, `Sim` / `SimDebug`, or
   `vehicles[<expression with .vehicleId or .vehicle>]`, and no presentation file compares a ROOT position
   with zero or names the root body as the origin. Exceptions to list, each with its reason:
   `src/core/fakes/snapshotAccess.ts` (D1, D6), `src/core/fakes/fakeSession.ts` (a producer, as the session
   is: it fills the deprecated fields and reads the vehicle it is published as), `src/input/bindings.ts`
   (the retired member's type), producers of hand-built snapshots that must still fill a required deprecated
   field (`src/map/testing/syntheticSnapshots.ts`, `labs/map-view/main.ts`).
10. The whole unit suite, every lab spec (`npx playwright test tests/browser/<dir> --project=functional`,
    one directory at a time through the gate), the full image gate, the budget gate on a quiet machine, the
    first minutes of the browser mission on `createSession`, this file as PACKAGE_RULES rule 17 asks.

## 2. Decisions taken, and why

- **D1. One access module for what several presentation packages read of a snapshot:
  `src/core/fakes/snapshotAccess.ts`.** `revisionOf`, `targetOf` / `targetBodyOf` / `targetNameOf` /
  `bodyTarget`, `activeVesselOf`, `craftsOf` / `craftOf` / `craftIdOf` / `parentOf`, `partKeyOf` / `partKey`,
  `eventPartOf`, `CraftLineage`, `cabinOf`, `labelVehicleOf`. It is the ONE file outside the simulation
  that reads `Readouts.targetBodyId`, `.targetClosestApproach` and `SimSnapshot.tick`, and the one that
  looks a vehicle up by a runtime id. Why there: every presentation package may import `src/core` only
  (boundary rules), and `src/core/fakes` is the only part of `src/core` this package owns. Request
  `presentation-sweep-1` asks the lead for a home of its own at the tighten.
- **D2. `targetOf(readouts)` returns a `TargetView`, not a made-up `TargetReadout`.** `TargetView` is the
  part of `TargetReadout` that the deprecated pair can state (`ref`, `relativeInclination`,
  `closestApproaches[]` with `relSpeed` only where a session states it), with the same field names; a
  `TargetReadout` is assignable to it. A derived `TargetReadout` would have needed a range, a range rate
  and a relative speed at the approach that nothing states. At the tighten a call site changes
  `targetOf(r)` to `r.target`.
- **D3. Keys of the v2 actions.** `flightMenu` Esc and P, `cycleTarget` B, `toggleRoster` O,
  `acceptPrompt` Y, `openQuickComms` Enter (ARCHITECTURE 19). `dockingView` is NOT on V: the next couch
  (`ui:nextSeat`, request core-6) has V and every letter is bound, so it is on `Equal` (right of the three
  display keys 9 0 -). The three SAS holds against a target are on `Semicolon`, `Quote`, `Backslash` (the
  digit row is full). FOR THE LEAD: ARCHITECTURE 19 still says V for `dockingView`. The retired `pause` is
  named once, as a type (`RetiredButtonAction` in `src/input/bindings.ts`), so that the exhaustiveness
  check compiles until the lead removes the member. In the app and the flight-ui lab `flightMenu` toggles
  the local pause (no menu is built here); `tests/browser/app/app.spec.ts` ("P freezes simulation time") is
  unchanged by it.
- **D4. The HUD's SAS row** has the three target holds as buttons that are hidden unless the session lists
  them in `sasModesAvailable` (a third row; nothing shows today). Port alignment has an icon of its own
  (`PORT_ALIGN_ICON`), not in the navball's marker atlas. **The MFD** paints `target` and `docking` as
  pages of rows; they are not in `MFD_PAGES` (the page cycle and the lab's page list stay six), a display
  shows one when its page is set to it (`MFD_TARGET_PAGES`). NOT SEEN IN A BROWSER YET: the three buttons
  and the two pages (the fake's `rendezvous` and `dockingApproach` scenes produce what they show; the
  flight-ui lab takes `FakeScene` only).
- **D5. Engine mounts from the part list** (`engineMounts`): an engine with attach nodes is mounted on
  every part of its craft that shares a node position with it; an engine without nodes (motor packs, RCS
  pods) on the part whose `PartDef.bounds` cylinder is nearest to its origin (the nearer origin breaks a
  tie). For the one vehicle of the library this is exactly the parent of the vehicle tree, before and after
  every stage (`tests/unit/vehicle/mounts.test.ts`, 6 tests).
- **D6. Words about a stage and the crew's names still come from the vehicle's file, through ONE lookup**
  (`labelVehicleOf`; callers `stageWordsSource` in `src/ui/model.ts`, keyed by the helm craft's vehicle, and
  `src/app/seat.ts`, keyed by the craft with the cabin): what a stage burns, which chutes it deploys or
  releases, the engines behind the weak-gravity acceleration figure, the crew member in a seat. The
  snapshot states none of them, the contract gives `vehicleId` "for labels and icons only", and dropping
  them would have changed the HUD's stage tiles (exact reference images). Request `presentation-sweep-3`
  asks for the fields that would remove it. THE ACCEPTANCE LINE "no file ... indexes defs.vehicles[ by a
  runtime id" IS NOT MET BY THIS ONE LOOKUP, and will not be until the lead answers the request.
- **D7. The fake's render root.** `createFakeSession` states ROOT positions about the active vessel's SOI
  body, as a session does (conformance); `createFakeSim`, the v1 name that all labs use, keeps the origin
  at the library's root body, where v1's FakeSim had it. Reason, measured (gate run on adbddff with the fake
  Moon-centred in every lab): `lunar-terminator-20000km`, `lunar-terminator-5000km`, `translunar-moon` 0
  pixels; `lunar-orbit-low-sun` 58 pixels up to 4 levels; `lunar-surface-cockpit` 12,279 pixels up to 17
  levels (mean 0.0074, along the window frames); `lunar-touchdown` 5.98 % of the pixels, mean 0.0368
  against a tolerance of 0.02, max 136 (faint, all over the ground and the horizon). Each the same on every
  load, so they are the origin's and not a second state. The renderer is origin-agnostic in the mean and
  not to the bit; the cause (a float32 quantity of some hundred metres somewhere before the camera-relative
  subtraction, or a snapped cascade) is NOT FOUND. Pictures: `out/screens/presentation-sweep/origin/`.
  Request `presentation-sweep-4` puts the choice to the lead (keep, or re-record three lunar pictures).
- **The fairing petal index** is still read from the instance id (`fairingPanelOf` in
  `src/render/vehicle/vesselFeature.ts`, the one place): the snapshot states it nowhere else. Request
  `presentation-sweep-2`.
- **`VesselVisualFeature.anim(craftId, instanceId)`** (was `(vesselId, instanceId)`): the two vehicle specs
  pass `p.craftId ?? id`; `labs/vehicle/labSim.ts` gives its vessels craft blocks with `parent`.
- **`chaseDistanceLimits(defs, vessel)` keeps its signature** (`defs` unused): `tests/unit/camera` calls it.
  One craft: its `chase` hints with the nearest never inside 1.05 radii (as before). Several craft: the
  bounding radius (2.4 radii by default, 1.15 to 60), widened to the farthest any craft allows.
- **A finding while the gate ran**: the gate's page server serves the WORKING TREE. A lab file edited while
  a gate run is in progress is loaded by the next checkpoint (one load of `lunar-surface-cockpit` failed on
  a half-made edit of `labs/integration/main.ts`). Do not edit `src` or `labs` while a gate runs.

## 3. The image gate on the committed state (311feed)

`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional`,
2026-11-17, 12.4 minutes, on commit 311feed with nothing else changed in `src` or `labs`: **PASSED, 33 of 33.**

- The 30 exact checkpoints: "0 pixels differ" each, every one on its FIRST load. No OTHER STATE line in this run.
- `lunar-touchdown`: mean 0.0011 (tolerance 0.02), 99.9th percentile 1 (3), max 11, 0.178 % of the pixels.
- `shoreline`: mean 0.0010 (0.02), 99.9th percentile 1 (3), max 3, 0.183 % of the pixels.
- `sweep-lunar-orbit`: mean 0.0000 (0.02), 99.9th percentile 0 (1), max 1.

**OTHER STATE lines of the earlier, narrowed runs, for the lead (request lead-9):** one, in the run after
commit adbddff: `pad-noon`, load 1 of 3: 1440 pixels differ, by up to 3 levels (mean 0.0007, 99.9th
percentile 1); load 2 was the reference to the bit. It is the far sea's known second state (the same 1,440
pixels as in the lead's hand-off section 24). The lines of that run for `lunar-orbit-low-sun`,
`lunar-surface-cockpit` and `lunar-touchdown` were NOT a second state: they were the Moon-centred fake (D7),
the same on every load, and are gone since 311feed.

The budget gate (`BUDGET_COMPARE=1`) has NOT been run in this context.

## 4. Public API added or changed so far (exact signatures)

```ts
// src/core/fakes/snapshotAccess.ts
revisionOf(snapshot: SimSnapshot): number
interface TargetView { ref: TargetRef; relativeInclination: number | null; closestApproaches: readonly { ut: number; distance: number; relSpeed?: number }[] }
targetOf(readouts: Readouts): TargetView | null
targetBodyOf(readouts: Readouts): string | null
targetNameOf(snapshot: SimSnapshot, defs: DefLibrary): string | null
bodyTarget(bodyId: string): TargetRef
activeVesselOf(snapshot: SimSnapshot): VesselSnapshot | null
craftsOf(vessel: VesselSnapshot): readonly CraftSnapshot[]
craftOf(vessel: VesselSnapshot, craftId: string): CraftSnapshot | null
craftIdOf(vessel: VesselSnapshot, part: PartSnapshot): string
parentOf(craft: CraftSnapshot): string | null
partKeyOf(vessel: VesselSnapshot, part: PartSnapshot): string          // `craftId/instanceId`
partKey(craftId: string, instanceId: string): string
eventPartOf(vessel: VesselSnapshot, eventPartId: string): PartSnapshot | null
labelVehicleOf(defs: DefLibrary, vessel: VesselSnapshot, craft?: CraftSnapshot | null): VehicleDef | null   // labels only
interface CabinRef { craft: CraftSnapshot; part: PartSnapshot; cockpitId: string; cameraSeat: string | null }
cabinOf(vessel: VesselSnapshot): CabinRef | null
class CraftLineage { rootOf(snapshot, craftId): string; knownRootOf(craftId): string; keyOf(snapshot, vessel, part): string; knownKeyOf(craftId, instanceId): string; clear(): void }

// src/core/fakes/fakeSession.ts
type FakeScene = 'pad' | 'ascent' | 'lowOrbit' | 'translunar' | 'lunarOrbit' | 'lunarSurface' | 'reentry' | 'chutes'
type FakeV2Scene = 'rendezvous' | 'dockingApproach' | 'assembly' | 'echoes' | 'timeLive' | 'timeAhead' | 'timeBehind' | 'launchQueue'
type FakeSessionScene = FakeScene | FakeV2Scene
interface FakeSessionOptions { scene; ut?; parts?; vehicleId?; siteId?; location?; altitude?; ground?; stageLabels?; legsDeployed?; vesselName?; renderRoot?: 'focusBody' | 'rootBody' }
class FakeSession implements LocalSession { readonly scene; readonly stores: ClientStores; readonly universe: UniverseCommands; setRenderRoot(bodyId: string): void; portStates(): { partKey: string; state: DockingPortState }[] }
createFakeSession(defs: DefLibrary, opts: FakeSessionOptions): FakeSession          // render root: the focus body
FAKE_SCENES, FAKE_V2_SCENES, FAKE_VESSEL_ID, FAKE_TARGET_ID, FAKE_STATION_ID, FAKE_ASSEMBLY_ID, FAKE_ECHO_RECORDED_ID, FAKE_ECHO_PROJECTED_ID, FAKE_PORT_INSTANCE, FAKE_SESSION_DEFAULT_UT
// src/core/fakes/fakeSim.ts (the v1 names)
createFakeSim(defs: DefLibrary, opts: FakeSimOptions): LocalSession                  // render root: the library's root body unless opts says otherwise

// src/render/vehicle
engineMounts(defs: DefLibrary, parts: readonly PartSnapshot[], craftOf: (part: PartSnapshot) => string): Map<number, number[]>   // mounts.ts
fairingPanelOf(part: PartSnapshot): number | null                                    // vesselFeature.ts
VesselVisualFeature.anim(craftId: string, instanceId: string): PartAnim              // was (vesselId, instanceId)

// src/camera
chaseDistanceLimits(defs: DefLibrary, v: VesselSnapshot): { def: number; min: number; max: number }   // from CraftSnapshot.chase and boundingRadius
cockpitHost(defs: DefLibrary, vessel: VesselSnapshot): CockpitHost | null            // through cabinOf; no vehicle definition
fallbackBodyId(defs: DefLibrary, s: SimSnapshot): string                              // cameraMath.ts

// src/ui
targetName(s: SimSnapshot, defs: DefLibrary): string | null                           // model.ts
MFD_TARGET_PAGES: readonly MfdPage[]                                                  // mfd/mfdPainter.ts; MFD_PAGES stays the six
PORT_ALIGN_ICON: IconDef                                                              // icons.ts
// src/input/bindings.ts: ALL_BUTTON_ACTIONS lists the v2 actions and not 'pause'; DEFAULT_BINDINGS as D3.
```

FakeSession for the next packages: the menu (`shell-menu`) has `stores.launchQueue` non-null in the scene
`launchQueue` (position 3, then one place nearer every simulated minute; `universe.cancelSpawn()` leaves the
queue) and every other store filled for the scene; the HUD of wave 5 has `Readouts.target` and
`Readouts.docking`, the port states (`portStates()`, because `DockingPortState` is not yet a member of
`ModuleState`), `dockCapture` / `docked` events, echoes with offers and the three time strips. A scene's
other vessels are drawn with the part list the fake was given.

## 5. Acceptance lines of the brief, as they stand

| Line | State |
|---|---|
| typecheck clean; grep test | typecheck clean for the presentation at 311feed; the grep test is NOT WRITTEN; deprecated reads remain (items 2, 3, 8 of 1.2); one `defs.vehicles[<runtime id>]` stays by design (D6) |
| every wave-2 unit and lab spec; every reference image; budget within 3 % | unit: 950 of 950 in the presentation suites; LAB SPECS NOT RUN in this context; reference images: section 3; BUDGET GATE NOT RUN |
| the same frame at two origins; a rebase without a step | NOT DONE (item 5); measured today: D7 |
| two craft of one vehicle never mix; an assembly framed from its radius | keys: resource bars (`displays.test.ts`), wear and mounts (`mounts.test.ts`) DONE; plume and staging keys NOT DONE (item 4); the chase rig on a three-craft assembly DONE (`camera.test.ts`: 1.15 / 2.4 / 60 bounding radii, the camera outside the assembly) |
| the terrain lab through `fetch` and `pack` | NOT DONE (item 6) |
| scrim step; the mission's first minutes on createSession | NOT DONE (items 7, 8) |

## 6. Requests filed

- `docs/requests/presentation-sweep-1.md` (lead, not blocking): a home in `src/core` for the access module.
- `docs/requests/presentation-sweep-2.md` (lead and the simulation, not blocking): the fairing petal as a field.
- `docs/requests/presentation-sweep-3.md` (lead and the simulation, blocking for the grep line): stage words
  and crew names in the snapshot.
- `docs/requests/presentation-sweep-4.md` (lead, not blocking): the render root of the fake's lunar scenes
  against three recorded pictures.
- For the lead, no file: `tests/unit/camera` has no owner in `WORK_PACKAGES_V2.json`; ARCHITECTURE 19 names
  V for `dockingView` (D3).

## 7. How to run

```
npx tsc --noEmit -p tsconfig.json | grep -v "src/net\|tests/unit/net"          (through heavy.mjs --class=cpu)
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render src/ui src/input src/camera src/map src/audio src/core/fakes src/app tests/unit/atmosphere tests/unit/audio tests/unit/cockpit tests/unit/flight-ui tests/unit/map-view tests/unit/ocean tests/unit/render-core tests/unit/sky tests/unit/terrain-render tests/unit/vehicle tests/unit/vfx tests/unit/camera tests/unit/fakes tools/dev/boundaries.test.ts
BASELINE_ONLY=a,b node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional
BUDGET_COMPARE=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf
```

Scratch of this context (edit lists, gate logs): `C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep\`
(`rep.mjs <file> <edits.json>` applies exact replacements; write the JSON with the Write tool: a shell
heredoc corrupts backslashes on this machine).
