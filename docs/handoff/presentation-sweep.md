# presentation-sweep: hand-off (sub-wave 3.2; NOT FINISHED: two subsystems are left, see 1.2)

The one sweep over every presentation consumer (brief: `docs/WORK_PACKAGES_V2.json`, id `presentation-sweep`,
with its LEAD NOTES). The package was larger than two working contexts. This file is the state at the end of
the second: what is done and committed, what is left with its design, every decision taken and why, both
gates as they were run. A successor continues from 1.2 and `git log --oneline --grep presentation-sweep`.

## 1. State of the sweep

Start: commit b076166 (the lead's contract step is 31e67fa; the tree before it is tagged
`pre-sweep-2026-11-16`). One commit per subsystem. `npm run typecheck` (both configurations) is clean on the
whole tree at 94a3e01.

### 1.1 Done and committed

| # | Commit | Subsystem | Image gate after it |
|---|---|---|---|
| 1 | 105b8f8 | The lead's work order: the 21 compile errors (binding table, HUD SAS row, MFD pages, chase rig, map marker tables, `setTarget(TargetRef)`, the default of `'ui.scrimRects'`, `pause` -> `flightMenu`, the selected target through one helper) | five `sweep-*` checkpoints, 0 pixels |
| 2 | 32203ca | The vessel feature: per-part state under the lineage key (`CraftSnapshot.parent`), engine mounts from the part list, no vehicle definition | eight checkpoints, 0 pixels |
| 3 | 1a93c40 | The HUD model: resource groups and labels from the parts, per craft | with row 4 |
| 4 | adbddff | `FakeSession` with the scenes of the shared universe, client stores, a conformance test per scene | (the fake Moon-centred: D7) |
| 5 | 311feed | Camera rigs, cockpit feature, seat names on the craft blocks; no active vessel in the view manager, map rig, listener | full set, 33 of 33 |
| 6 | 1c72140 | (second context from here) The access module moves to `src/core/access/snapshotAccess.ts` (the lead's answer to request 1). No boundary entry was needed: `src/core` is one area of `tools/dev/boundaries.test.ts` | not a pixel change |
| 7 | 3b80cfc | Pads: every reader through `padsOf` / `padOf` / `padLocationOf`; one runtime per pad in the site feature; a structure generator is given its pad; a ground survey per pad; the terrain's ground plans, the pad smoke, the effects' flat disc and the chase rig's trench per pad | FULL SET 33 of 33, the 30 exact at 0 pixels, first load, no OTHER STATE |
| 8 | 08efeb3 | `tick` -> `revisionOf`; no active vessel in the audio model, the effects and the labs; effects and audio key per-part state by the part key; `findEventPart`; unit tests on the keys | with row 9 |
| 9 | 22622c4 | Stage words, crew and fairing petal from the snapshot (`StageInfo.burnLabel`, `actionChutes`, `chuteEnvelopes`, `thrustVac`, `weightFlowVac`; `CraftCockpit.crew`; `PartSnapshot.panel`): `labelVehicleOf` is gone, no petal id is read or composed; the fake states the members through `describeStages` (its conformance test is green again) | FULL SET 33 of 33, the 30 exact at 0 pixels, no OTHER STATE (the HUD's stage tiles of `sweep-hud-leo`, `sweep-map-translunar`, `sweep-rails-warp`, `sweep-app-pad` to the pixel) |
| 10 | b46bf4d | Frame rebase: the render core, the vessel feature's ghosts and the view manager follow a replacement of the origin (`src/core/access/frameAccess.ts`); the origin test (`tests/browser/integration/origin.spec.ts`); request presentation-sweep-5 | with row 11 |
| 11 | 94a3e01 | `createSession` in `src/app` and the integration lab; `Sim` / `SimDebug` -> `LocalSession` / `SessionDebug` in every lab and test; the audio data's target path through the access module; the grep test `tests/unit/fakes/deprecated.test.ts` | FULL SET 33 of 33: section 3 |

Unit suites at 94a3e01 (`src/render src/ui src/input src/camera src/map src/audio src/core/fakes
src/core/access src/app`, `tests/unit/{atmosphere,audio,cockpit,flight-ui,map-view,ocean,render-core,sky,terrain-render,vehicle,vfx,camera,fakes}`,
`tools/dev/boundaries.test.ts`): 80 files, 971 tests, all pass.

### 1.2 Left to do (NOT STARTED; each is one subsystem with its own commit and gate run)

**A. The tile-source seam** (scope 5; acceptance line 5). Not started. What is there and what to change:
- `src/render/terrain/workerProtocol.ts`: `WorkerInit.tilesUrl: string` becomes `source: TileSourceSpec`
  (`src/core/contracts/terrain.ts`); `tileWorker.ts:25` calls `createTileSource(msg.source)` of
  `src/terrain/tileSource.ts` (it returns the existing fetch source for `{ kind: 'fetch' }`);
  `streamer.ts:224` builds the init (`{ kind: 'fetch', baseUrl: new URL(ctx.tilesUrl, location.href).href }`
  by default; a `pack` spec's `packListUrl` made absolute the same way).
- The feature's own reads on the main thread go through the same source: `feature.ts:859`
  (`createFetchTileSource(ctx.tilesUrl)`), `lowResAlbedo.ts:19` (a `fetch` of `<tiles>/<set>/<globals.albedoLowRes.path>`:
  use `source.file(tileset, path)`), and `feature.ts:857`, which reads `<tiles>/index.json` (the dev server's
  list of baked sets) so that a missing manifest logs no 404: with a pack source the sets are the keys of
  `PackList.sets` (fetch `packListUrl`).
- `RenderContext.tilesUrl` is the contract's (the lead's): give the terrain feature an option
  `tileSource?: TileSourceSpec` (default from `ctx.tilesUrl`) and the terrain lab a query (`&source=pack&packs=<url>`).
- The pack source batches what is asked in the same turn (docs/handoff/platform-delivery.md section 9): a
  worker should issue a tile's reads together.
- The test asked: the terrain lab through kind `fetch` and kind `pack` with identical frames, the pack inside
  `STACK_NAME=fsp-presentation-sweep npm run stack -- ... -- <suite>` (the pack list is served with CORS `*`
  at `/packs.json`; `tests/browser/platform` has the working pattern of a page that reads packs from the stack).

**B. The render-core additions** (scope 6; acceptance line 6, first half). Not started beyond the default
buffer of `'ui.scrimRects'` (commit 1). Design, from reading the code:
- Scrim step: `src/render/core/post/tonemap.ts` binds the uniform buffer `resources.get('ui.scrimRects')`
  (re-create the bind group when the key's version changes) and a few levels of the bloom DOWN chain
  (`PostProcess.downViews`, exposed through `PostOutputs`; `bloomLevelCount` is 3 to 9, so bind a fixed four,
  e.g. levels 0, 2, 4 and the last, and mix the two nearest for `blur`). In `fs`: `let n =
  u32(scrim.header.x); if (n > 0u) { ... }` over the rectangles (rounded-rect distance, `dim`, `opacity`);
  with a zero header the pass does the arithmetic it does today (the image gate must stay at 0 pixels and
  the budget table's `core.tonemap` row unchanged: that is "no rectangle, no cost"). The 0.1 ms line needs
  a perf spec that publishes four rectangles (a handle in `labs/render-core`) and reads `core.tonemap`.
- `CameraState.exposureHint { targetEv100, rateEvPerS }`: in `renderer.ts` where `ev100` is set (after
  `evOverride` / `evHeld`): with a hint, `ev100` moves toward `targetEv100` by at most `rateEvPerS * stepDt`
  and the meter's target is ignored; a frame-exact capture holds as it does today.
- `CameraState.lensShift [x, y]` (fraction of the half viewport): `buildProjection` (`frame/math.ts`) adds
  it to the clip-space offset of the z column as the jitter is (`proj[8]`, `proj[9]`, also in
  `projUnjittered`); `viewRay` (`shaders/chunksFrame.ts:140`) forms rays from `cameraForward/Right/Up` with
  the tangents, so the shift must go into the ray too (a `lensShift` pair in the frame uniforms, or
  `cameraForward` minus the shifted right / up). SIXTEEN files read `frame.cameraRight`, `cameraForward` or
  the tangents (`grep -rln "frame.cameraRight\|frame.cameraForward\|tanHalfFov" src/render`): the features
  that cull or march with a symmetric frustum (terrain selection, clouds, sky, ocean, particles) have to be
  looked at one by one; state in `docs/RENDER_API.md` which honour the shift.
- `docs/RENDER_API.md`: the three additions, `CoreRenderer.readVelocity()`, the rebase of the previous-frame
  state (section 1.1 row 10) and the `?frameorigin=` option of the lab app are NOT documented there yet.

**C. Runs that are still owed** (section 3 has what was run):
- the first minutes of the browser mission (pad to max-q) in the integrated app: the app is on
  `createSession` and both app checkpoints (`sweep-app-pad`, `sweep-app-cockpit`) are exact on it, but
  `tests/browser/mission` was not flown in this context;
- the budget gate and every lab spec WERE run on 94a3e01 (section 3): the budget within 3 % in every row,
  489 lab specs pass, and the eight that fail are not the sweep's (six fail on the pre-sweep tree with the
  same numbers, one has two states on both trees, one was a page load that timed out once).

## 2. Decisions taken, and why

- **D1. One access module for what several presentation packages read of a snapshot**, now
  `src/core/access/snapshotAccess.ts` (the lead's decision on request 1). It is the one file outside the
  simulation that reads `Readouts.targetBodyId`, `.targetClosestApproach` and `SimSnapshot.tick`. Beside it,
  `src/core/access/frameAccess.ts` has what a holder of ROOT positions needs (D8).
- **D2. `targetOf(readouts)` returns a `TargetView`**, the part of `TargetReadout` the deprecated pair can
  state; a `TargetReadout` is assignable to it. At the tighten a call site changes `targetOf(r)` to `r.target`.
- **D3. Keys of the v2 actions**: `flightMenu` Esc and P, `cycleTarget` B, `toggleRoster` O, `acceptPrompt` Y,
  `openQuickComms` Enter, `dockingView` on `Equal` (accepted by the lead; V is the next couch), the three SAS
  holds against a target on `Semicolon`, `Quote`, `Backslash`. The retired `pause` is named once, as a type
  (`RetiredButtonAction` in `src/input/bindings.ts`).
- **D4. The HUD's SAS row** has the three target holds as buttons hidden unless the session lists them;
  the MFD paints `target` and `docking` as pages outside the page cycle (`MFD_TARGET_PAGES`). Not seen in a
  browser yet: no session offers them before wave 4.
- **D5. Engine mounts from the part list** (`engineMounts`, `tests/unit/vehicle/mounts.test.ts`).
- **D6. No vehicle definition is looked up by a runtime id any more.** The words about a stage, the crew by
  seat and the fairing petal are snapshot fields (the lead's commit 7df28d3): `stageBurnLabel(s, i)`,
  `stageActionWords(s, i)`, `stageAcceleration(s, i)` and `describeChuteEnvelope(s, defs)` of
  `src/ui/model.ts` read `StageInfo`; `seatName` reads `CraftCockpit.crew`; `fairingPanelOf` is
  `part.panel?.index`; the effects find the first petal of a `fairingJettisoned` event among the event's new
  vessels (`panel.index === 0`). A session that does not state the words says less (the stage's label, the
  bare action kinds, the thrust-to-weight figure), as before for an unknown design. The fake states them
  with `describeStages` of the vehicle it is published as, and WITH THEM THAT VEHICLE'S ACTION KINDS (the two
  lists are parallel); a fake of no vehicle states the neutral values and `actionKinds: ['engine']` as before.
  The flight-ui lab vehicle does the same in `tagLabVehicle` (`vehicleStaging`: the whole stack of the lab
  vehicle over the figures of the stages the fake reports).
- **D7 / D8. The origin of ROOT positions.** The renderer is origin-agnostic TO THE BIT: the same frame
  handed to it about the root body and, translated exactly, about the Moon gives 0 differing pixels in all
  four lunar checkpoints (`origin.spec.ts`, section 3). What the first context measured (12,279 pixels in
  `lunar-surface-cockpit`) is not the renderer: a frame COMPUTED about the other origin has other numbers. A
  position 384,000 km from the origin lies on a float64 grid of 6e-8 m, so `vessel.rRoot + offset` puts the
  camera up to 3e-8 m elsewhere relative to the vessel (measured 1.1e-8 to 2.9e-8 m); that carries float32
  values on the GPU over a rounding step and with them isolated samples (edge coverage in one frame of the
  jitter sequence, a stochastic shadow tap). Nothing was there to fix in the renderer; v1's far origin is
  the coarser input and the session's origin the better one. `createFakeSim` (the labs' fake) therefore
  still states ROOT about the root body, because one exact lab picture would move with the origin: request
  `presentation-sweep-5` puts the choice to the lead with the pictures and the difference maps.
- **D9. A rebase is applied as of the time a position was taken** (`rebaseHeldAt`): `FrameRebase` is the old
  origin in the new frame at the time of the snapshot that carries it, and the two origins move against each
  other (1 km/s for the Earth and the Moon), so a position of one frame ago moved with the offset of now is
  16 m off. The core reads `prevSnapshot` and `prevCamera` in the new frame that way; `prevEyeOffset` and
  `frame.prevSnapshot` are then what they would be had the origin always been the new one. (Per-object motion
  vectors never needed it: they are differences inside one frame each.) A frame that cannot be reached from
  the one a holder last saw (the epoch went backwards: another session; or the history no longer describes
  the held epoch) is `'drop'` in `observeFrame`: a new history, never an exception in a frame.
  Holders found and done: the render core (`prevSnapshot`, `prevCamera`), the vessel feature (ghosts: ROOT
  position and velocity of a vessel that left the snapshot), the view manager (`last` and its snapshot, from
  which a rig is activated and a blend starts). Looked at and holding nothing in ROOT across frames: the
  chase rig (directions and angles), the cockpit rig, the map rig (its focus is an id), the map scene (built
  from the snapshot and the camera of one frame), the effects (the effect domain is body-relative), the
  shadows (anchor coordinates of a body or a vessel), terrain, ocean, atmosphere, sky.
- **D10. Pads.** One runtime per pad in the site feature (its frame at the pad's resolved coordinates, its
  arm state from the vessel on THAT pad). `SiteFeature.state(siteId, padId?)`: absent = the first pad;
  `override(siteId, patch, padId?)`: absent = every pad of the site. A ground survey per pad: the first pad's
  is `survey` of the section `visuals/sites/<siteId>` (as today), another pad's is `pads[<pad id>].survey` of
  the same section; a pad with structures and no survey throws, as a site did. KNOWN LIMIT: the terrain's
  material uniform holds `MAX_SITES = 4` ground plans per body; the fifth pad of a body onwards gets no
  hardstand plan (a site of 9 or 16 pads needs the uniform's layout changed: not done, it moves no pixel
  today). No file under `data/defs/sites` changed.
- **D11. No active vessel.** The audio model is silent but for the UI bus (the listener is "the camera, in no
  air": every source is placed about the active vessel); the effects ride with the vessel the camera
  follows, else the nearest; labs take the fake's one vessel. A spectator's mix is a later package's.
- **D12. Keys of per-part state in effects and audio**: `<vessel id>|<part key>|...` (RCS jet clusters,
  canopies, engine histories of the audio model). The vessel id stays in the key, so nothing carries over a
  separation that did not before; two craft of one vehicle in a vessel no longer share a key. Engine plume
  clusters are keyed by vessel, plume look and part DEFINITION by design (a cluster is the drawn group of
  like engines of a vessel), which is not per-part state.
- **D13. `findEventPart(snapshot, id)`**: an event names a part by instance id or by part key; a part that
  left with a piece in the same tick answers to the key of every craft up its line of descent
  (`CraftSnapshot.parent`): keys are composed and compared, never taken apart.
- **D14. The audio data names `readouts.targetBodyId` as a click watch** (`data/defs/audio/ui.json`, not
  this package's): `readSnapshotPath` answers that path through `targetBodyOf` and the new path
  `readouts.target` with a comparable string, so the data can switch at the tighten without code.
- **A finding while the gate ran** (first context): the gate's page server serves the WORKING TREE. Do not
  edit `src` or `labs` while a gate or a lab spec runs.

## 3. The gates, as run

**Reference images** (`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional`),
the full set each time:

| On commit | Result |
|---|---|
| 3b80cfc (pads) | PASSED 33 of 33; the 30 exact at 0 pixels on the first load; no OTHER STATE line; `lunar-touchdown` mean 0.0000 max 1; `shoreline` mean 0.0010 max 3; `sweep-lunar-orbit` mean 0.0000 max 1 |
| 22622c4 (keys; snapshot words) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0007, p99.9 1, max 6; `shoreline` mean 0.0010 max 3; `sweep-lunar-orbit` mean 0.0000 max 1 |
| 94a3e01 (rebase; createSession) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0009, p99.9 1, max 6; `shoreline` mean 0.0010, p99.9 1, max 3; `sweep-lunar-orbit` (now drawn about the Moon by the real session) mean 0.0000, p99.9 0, max 4, 0.001 % of the pixels (tolerance 0.02 / 1) |

No OTHER STATE line occurred in any of the three runs of this context. (The one of the first context:
`pad-noon`, load 1 of 3, 1440 pixels by up to 3 levels, the far sea's known second state, request lead-9.)

**The origin test** (`tests/browser/integration/origin.spec.ts`, on b46bf4d; 7 tests, all pass):

| Frame | Translated exactly to the Moon | Computed about the Moon | Camera relative to the vessel |
|---|---|---|---|
| `lunar-terminator-5000km` | 0 pixels | 0 pixels | 1.09e-8 m |
| `lunar-orbit-low-sun` | 0 pixels | 0 pixels | 2.73e-8 m |
| `lunar-surface-cockpit` | 0 pixels | 12,279 pixels, up to 17 levels, mean 0.0074, p99.9 1 | 1.60e-8 m |
| `lunar-touchdown` (not exact: its loads differ) | 0 pixels (1,706 pixels up to 5 levels in another run) | 8,379 pixels, up to 10 levels, mean 0.0070, p99.9 2 | 2.88e-8 m |

A replacement of the origin between two frames (`__integration.setRenderRoot`, the frame that carries the new
epoch against the same frame of a run without it; frames stepped by hand from a frame index that is a
multiple of 64, exposure fixed):

| Scene | Two control runs | Replaced against control | Velocity target, max (control) | The eye over the frame (control) |
|---|---|---|---|---|
| `sea` (2 m above the water, origin to the Moon) | 28,127 px, up to 4, mean 0.0123 | 28,133 px, up to 4, mean 0.0123 | 4.609e-3 (4.609e-3) | 15.79 m (7.67 m) |
| `leo` (origin to the Moon) | 99,823 px, up to 12, mean 0.0582 | 107,646 px, up to 13, mean 0.0626 | 4.008e-4 (4.008e-4) | 142.30 m (129.81 m) |
| `lunar-orbit` (root body to the Moon) | 29 px, up to 2 | 34 px, up to 2 (0 pixels in an earlier run) | 1.146e-4 (1.146e-4) | 27.23 m (20.02 m) |

No step: the replaced frame differs from the control as two controls differ from each other. No
motion-vector spike: the velocity target is the control's. The eye's and the vessel's displacement over the
frame differ from the control's by what the two origins move against each other in 1/60 s, as they must.
SENSITIVITY: with the core's rebase switched off for one run, the same test failed with "the eye moved
384,399,018.52 m (control 20.02 m)"; pictures and velocity did not change, because nothing drawn today
reads `prevEyeOffset` without a better source (the ocean has its own previous reference).

**Budget gate** (`BUDGET_COMPARE=1 ... budget.perf.spec.ts --project=perf`, on 94a3e01, nothing else of this
package running): every row within 3 % of the recorded sum.

| Row | Summed GPU time against the recorded | |
|---|---|---|
| pad lift-off | 6.02 ms against 6.17 (-2.5 %) | |
| ascent 10-40 km | 3.38 against 3.40 (-0.7 %) | |
| LEO | 3.01 against 3.04 (-0.7 %) | |
| LEO cockpit | 3.59 against 3.57 (+0.3 %) | |
| lunar descent | 3.54 against 3.42 (+3.5 %) in the first run; run again twice as the rule says: 3.40 (-0.7 %) and 3.39 (-1.1 %) | over by load once |
| reentry | 3.02 against 3.02 (+0.1 %) | |
| splashdown | 5.41 against 5.66 (-4.5 %) | the effects cost 0.041 ms where 0.259 was recorded |
| stony ground (whole frame) | 6.07 against 6.26 (-3.0 %) | |
| among kiawe (whole frame) | 5.36 against 5.60 (-4.3 %) | |
| thickets from 120 m (whole frame) | 6.50 against 6.65 (-2.2 %) | |

FOR THE LEAD: the effects' 0.259 -> 0.041 ms in `splashdown` is NOT this sweep's. The same row on the export
of `pre-sweep-2026-11-16` gives 0.041 ms too (5.45 ms against 5.66, -3.7 %; lunar descent there 3.41, -0.3 %):
the baseline was recorded on 9a873e0 (2026-11-13), and something between that commit and the tag stopped the
effects from drawing what they drew in that scene (or made it free). Worth a look by the effects' owner.

**Lab specs** (`npx playwright test tests/browser/<dir> --project=functional`, one directory at a time through
the GPU gate, on 94a3e01; 2 h 10 min in all): 489 passed, 8 failed, 2 skipped. NONE OF THE EIGHT IS THE
SWEEP'S: the eight tests were run on an export of the tag `pre-sweep-2026-11-16` (`git archive` into the
scratch directory, the tiles linked in) and once more on this tree.

| Directory | Passed | Failed |
|---|---|---|
| flight-ui | 94 | 1 |
| cockpit | 41 | 0 |
| map-view | 28 | 0 |
| vehicle | 15 (1 skipped) | 0 |
| vfx | 39 | 1 |
| audio | 18 | 0 |
| app (the integrated app on `createSession`) | 10 | 0 |
| integration (with `origin.spec.ts`) | 45 | 5 |
| render-core | 42 | 0 |
| terrain | 22 | 0 |
| sky | 33 | 0 |
| ocean | 41 | 1 |
| atmosphere | 61 (1 skipped) | 0 |

| Failed test | This tree | The pre-sweep tree |
|---|---|---|
| `flight-ui/screens.spec.ts` "flight-ui screenshots 4k › cockpit view" | `cockpit-lowOrbit-4k: mostly black (0.050)` | the same, 0.050 |
| `vfx/matrix.spec.ts` "lift-off from a chase camera at 150 m" | `inside-cloud-t6-day: a real image`: 5, expected > 6 | the same, 5 |
| `integration/clouds.spec.ts` "(b) a plume and trail 50 km away take aerial perspective" | 0.1279, expected < 0.06 | the same, 0.1279 |
| `integration/terrain.spec.ts` "(d) no line along the regional coverage boundary of earth" | 30 views with a line | the same, 30 |
| `integration/terrain.spec.ts` "(e) image decode: the land of a coastal albedo tile" | correlation 0.652, expected > 0.7 | the same, 0.652 |
| `integration/water.spec.ts` "(a) at fadeStart the forward water equals the deferred sheet" (6000 m up, heading 120) | 0.0518, expected < 0.02 | the same, 0.0518 |
| `integration/shadows.spec.ts` "(c) the lunar terminator from 5000 km shows crater shadows" | "shadows only darken" 0.0830, expected < 0.002; PASSED on the second run | the same failure, 0.0830 (a test with two states on both trees) |
| `ocean/screens.spec.ts` "ocean screenshot: midday" | the page did not initialise within 60 s (the first test of its file); PASSED on the second run (15.7 s) | passed (15.8 s) |

Six of them fail on the tree as it stood before the sweep with the same numbers to the last digit, one has
two states on both trees, one was a page load that timed out once. They are findings for the visual
close-out, not for this package.

## 4. Public API added or changed (exact signatures)

```ts
// src/core/access/snapshotAccess.ts (was src/core/fakes/snapshotAccess.ts)
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
findEventPart(snapshot: SimSnapshot, eventPartId: string): { vessel: VesselSnapshot; part: PartSnapshot } | null   // NEW
interface CabinRef { craft: CraftSnapshot; part: PartSnapshot; cockpitId: string; cameraSeat: string | null }
cabinOf(vessel: VesselSnapshot): CabinRef | null
class CraftLineage { rootOf(snapshot, craftId): string; knownRootOf(craftId): string; keyOf(snapshot, vessel, part): string; knownKeyOf(craftId, instanceId): string; clear(): void }
// labelVehicleOf is GONE.

// src/core/access/frameAccess.ts (NEW)
type FrameChange = { kind: 'same' } | { kind: 'rebase'; rebase: FrameRebase } | { kind: 'drop' }
observeFrame(tracker: FrameEpochTracker, frame: FrameEpoch | undefined): FrameChange   // never throws
rebaseHeldAt(rebase: FrameRebase, age: number): FrameRebase                             // offset - velocity * age
rebaseSnapshot(snapshot: SimSnapshot, rebase: FrameRebase): SimSnapshot                 // bodies, vessels, explosion events

// src/core/fakes
createFakeSession(defs, opts: FakeSessionOptions): FakeSession   // render root: the focus body; states StageInfo words, cockpit.crew, panel: null
createFakeSim(defs, opts: FakeSimOptions): LocalSession           // render root: the library's root body unless opts.renderRoot says otherwise (request 5)

// src/render/core
CoreRenderer.readVelocity(): Promise<{ width: number; height: number; data: Float32Array }>   // RT3, two floats per pixel
// render(): prevSnapshot / prevCamera are rebased at a new frame epoch (see D9); frame.prevEyeOffset follows.
// src/render/core/lab
translateFrame(snapshot: SimSnapshot, camera: CameraState, bodyId: string): { snapshot: SimSnapshot; camera: CameraState }
// createLabApp: ?frameorigin=<body id> hands the renderer the translated frame.

// src/render/vehicle
interface SiteFeature { siteIds(): string[]; padIds(siteId: string): string[]; state(siteId: string, padId?: string): SiteState | undefined; override(siteId: string, patch: Partial<SiteState> | null, padId?: string): void }
interface SiteStats { sites: number; pads: number; ... }
SiteFeatureOptions.padElevation?: (site: LaunchSiteDef, pad: PadDef) => number
SiteFeatureOptions.groundHeight?: (site: LaunchSiteDef, east: number, north: number, pad: PadDef) => number
generateStructure(defs, site, model, params, placement?, ground?: GroundField, pad?: PadDef): SiteVisual   // pad absent = the first
interface SiteGenContext { params; site; pad: PadDef; defs; ground }
siteSurvey(defs: DefLibrary, site: LaunchSiteDef, pad?: PadDef): SiteSurveyDef | null
siteGround(defs: DefLibrary, site: LaunchSiteDef, pad?: PadDef): GroundField
fairingPanelOf(part: PartSnapshot): number | null            // part.panel?.index
VesselVisualFeature.anim(craftId: string, instanceId: string): PartAnim
engineMounts(defs, parts, craftOf): Map<number, number[]>

// src/render/terrain
buildSitePlan(pad: Pick<PadDef, 'structures' | 'flatRadius'>, t: SitePlanTunables): SitePlan   // was (site)
// src/render/vfx
canopyKey(vesselId: string, ownerPartKey: string, module: number, canopy: number): string
// src/render/cockpit/displays.ts: painted[i] = { page, revision, at }   (was { page, tick, at })

// src/ui/model.ts
stageBurnLabel(s: SimSnapshot, index: number): string | null        // was (s, defs, index)
stageActionWords(s: SimSnapshot, index: number): string             // was (s, defs, index)
stageAcceleration(s: SimSnapshot, index: number): number | null     // was (s, defs, index)
describeChuteEnvelope(s: SimSnapshot, defs: DefLibrary): ChuteEnvelopeView | null   // reads StageInfo
// src/app/seat.ts
seatName(defs: DefLibrary, vessel: VesselSnapshot, seatId: string): string          // reads CraftCockpit.crew
// src/audio/config.ts
readSnapshotPath(snapshot, path): unknown   // 'readouts.targetBodyId' and 'readouts.target' through the access module
// src/camera
chaseDistanceLimits(defs, v): { def; min; max }; cockpitHost(defs, vessel): CockpitHost | null; fallbackBodyId(defs, s): string

// labs
// labs/integration: &origin=root|focus (the fake's render root); window.__integration.setRenderRoot(bodyId): boolean;
//   features.ts: importRealSession(), realSessionAvailable(), type CreateSession   (were importRealSim, realSimAvailable, CreateSim)
// labs/flight-ui/labVehicle.ts: vehicleStaging(vehicle: VehicleDef, words: readonly StageWords[], stated: SimSnapshot['staging']): SimSnapshot['staging']
// labs/audio/scenes.ts: labVesselId(base: SimSnapshot): string; compose(base, s, t, revision)
```

FakeSession for the next packages is as the first context left it: `stores.launchQueue` in the scene
`launchQueue`, `Readouts.target` and `.docking`, `portStates()`, `dockCapture` / `docked` events, echoes with
offers and the three time strips.

## 5. Acceptance lines of the brief, as they stand

| Line | State |
|---|---|
| typecheck clean; the grep test | MET. `npm run typecheck` exit 0 at 94a3e01. `tests/unit/fakes/deprecated.test.ts` (9 tests): eight rules over 500+ files of the presentation, the labs, the browser tests and the presentation's unit tests; every exception listed with its reason (the access module, the fake as a producer, the retired member's type, the audio data's path, `scenario.vehicle` in `src/app/main.ts`, the lab vehicle sim, four tests of producers and of the origin); a stale exception fails. Outside its scan: section 6 |
| every wave-2 unit and lab spec; every reference image; budget within 3 % | unit: 971 of 971 in the presentation suites. Reference images: 33 of 33 on 94a3e01, the 30 exact at 0 pixels. Budget: every row within 3 % (lunar descent on its second and third run). Lab specs: 489 pass; NOT MET for eight tests, none of them moved by the sweep (section 3 has each with its number on the pre-sweep tree) |
| the same frame at two origins under 1/255 per channel; a rebase without a step or a motion-vector spike | MET for the renderer: 0 pixels in four lunar frames under an exact translation of the origin. A frame COMPUTED about the other origin has a mean difference of 0.007 level and a 99.9th percentile of 1 (2 in `lunar-touchdown`); single pixels differ by up to 17 levels: the last bits of float64 at 384,000 km, not the renderer (D7 / D8, request 5). Rebase: three scenes, no step, velocity target equal to the control's, and the test fails without the core's rebase (section 3) |
| two craft of one vehicle never mix; an assembly framed from its radius | MET: resource bars (`displays.test.ts`), wear and mounts (`mounts.test.ts`), RCS jets, canopies and event parts (`tests/unit/vfx/model.test.ts`), engine histories of the audio model (`tests/unit/audio/model.test.ts`); the chase rig on a three-craft assembly (`camera.test.ts`). Staging: the stage stack is per craft in the snapshot (`CraftSnapshot.staging`), the HUD reads the helm craft's |
| the terrain lab through `fetch` and `pack` | NOT DONE (1.2 A) |
| scrim step; the mission's first minutes on createSession | scrim, exposureHint, lensShift: NOT DONE (1.2 B). The app runs on `createSession` (both app checkpoints exact); the mission spec was not flown (1.2 C) |

## 6. For the lead and the tighten step

- `createFakeSim`'s origin: request `presentation-sweep-5`.
- `data/defs/audio/ui.json` names the click watch `readouts.targetBodyId`: when the field goes, the line
  becomes `readouts.target` (D14); `READOUT_FIELDS` in `src/audio/config.ts` loses the two keys by the compiler.
- `src/pilot/missionPilot.ts:212` reads `readouts.targetBodyId` (not presentation; outside the grep test).
- `tests/unit/camera/chase.test.ts:278` reads `site.structures` in a fallback; `tests/unit/camera` has no
  owner in `WORK_PACKAGES_V2.json`.
- At the tighten: `revisionOf` -> `snapshot.revision`; `targetOf(r)` -> `r.target`; `craftsOf`, `craftIdOf`,
  `parentOf` lose their fallbacks; `activeVesselId: string | null` compiles in `src` as far as this sweep
  could see without the type (every use was read; the labs' and specs' `find(...)!` state that their scene
  has a vessel); `RetiredButtonAction` goes with the member.
- The petal's instance id is no longer read anywhere in the presentation (`grep -rn "#panel" src/render src/ui labs` is empty of code).
- `MAX_SITES = 4` ground plans in the terrain's material uniform (D10).
- Open requests against the presentation's paths (app-integration-11 to -13, cockpit-18 to -22, core-3, core-7,
  lead-8, lead-9, ocean-10 to -13, sky-lighting-11, vehicle-pad-8 and -12) are the visual close-out's: each asks
  for a picture to change, and this sweep may not move a pixel. None was taken up.

## 7. Requests filed

- `presentation-sweep-1` (a home for the access module): answered, done (row 6).
- `presentation-sweep-2` (the fairing petal as a field): answered by the lead (7df28d3), read sites switched (row 9).
- `presentation-sweep-3` (stage words, crew): answered by the lead (7df28d3), read sites switched (row 9).
- `presentation-sweep-4` (the fake's render root): superseded by `presentation-sweep-5`, which has the cause.
- `presentation-sweep-5` (lead, not blocking): the origin of the labs' fake against one exact lunar picture.

## 8. How to run

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render src/ui src/input src/camera src/map src/audio src/core/fakes src/core/access src/app tests/unit/atmosphere tests/unit/audio tests/unit/cockpit tests/unit/flight-ui tests/unit/map-view tests/unit/ocean tests/unit/render-core tests/unit/sky tests/unit/terrain-render tests/unit/vehicle tests/unit/vfx tests/unit/camera tests/unit/fakes tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional       (BASELINE_ONLY=a,b narrows it)
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/origin.spec.ts --project=functional           (ORIGIN_ONLY=a,b; ORIGIN_EXTRA=<query>)
BUDGET_COMPARE=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf
```

Scratch of the two contexts (edit lists, gate logs, the lab-spec logs): `C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep\`
and `C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep-2\`
(`repm.mjs <edits.json>` applies exact replacements to several files, all or none; write the JSON with the
Write tool: a shell heredoc corrupts backslashes on this machine).
