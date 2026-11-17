# presentation-sweep: hand-off (sub-wave 3.2; FINISHED in the third working context, with the limits of 1.3)

The one sweep over every presentation consumer (brief: `docs/WORK_PACKAGES_V2.json`, id `presentation-sweep`,
with its LEAD NOTES). Three working contexts: the first two did the snapshot consumers, the frame rebase, the
fake session and `createSession` (rows 1-11 below); the third did what was left: the tile-source seam, the
render core's additions for the menu (scrim, exposure hint, lens shift), the browser mission's first minutes,
and both gates on the final tree (`0685bd0`). Section 5 answers every acceptance line with what was
measured; section 1.3 says what is not done.

## 1. State of the sweep

Start: commit b076166 (the lead's contract step is 31e67fa; the tree before it is tagged
`pre-sweep-2026-11-16`). One commit per subsystem. `npm run typecheck` (both configurations) is clean on the
whole tree at 0685bd0.

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
| 12 | 4f882d7 | (third context from here) The tile-source seam: `WorkerInit.source: TileSourceSpec`, the worker and the feature call `createTileSource(spec)`, `TerrainFeatureOptions.tileSource`, the terrain lab's `&source=pack&packs=`; `tests/browser/terrain/source.spec.ts` | FULL SET 33 of 33, the 30 exact at 0 pixels, no OTHER STATE |
| 13 | 9c6d674 | The render core's additions: the UI scrim step, `CameraState.exposureHint`, `CameraState.lensShift`; RENDER_API section 19 (those three, the frame rebase, `readVelocity`, the tile source); `menu-core.spec.ts`, `scrim.perf.spec.ts` | with the final tree |
| 14 | e481a23 | The browser mission flies a part of the flight (`MISSION_UNTIL=<milestone>`) and reads a window's frame intervals before the reset that clears them | (a spec) |
| 15 | 0685bd0 | Requests 6 (terrain-render: ground plans for every pad) and 7 (the lead: `RenderContext` states the tile source) | (documents) |

Unit suites at 0685bd0: 83 files, 999 tests, all pass (the suites of section 8; 971 at the end of the second context). At 94a3e01 (`src/render src/ui src/input src/camera src/map src/audio src/core/fakes
src/core/access src/app`, `tests/unit/{atmosphere,audio,cockpit,flight-ui,map-view,ocean,render-core,sky,terrain-render,vehicle,vfx,camera,fakes}`,
`tools/dev/boundaries.test.ts`): 80 files, 971 tests, all pass.

### 1.2 The three items of the third context

**A. The tile-source seam: DONE** (scope 5; acceptance line 5; row 12). `WorkerInit` carries a
`TileSourceSpec`; the tile worker calls `createTileSource(msg.source)`; the terrain feature takes the spec as
an option (`tileSource`, default the plain files of `ctx.tilesUrl`: a normal page load asks for the same
URLs), builds its own main-thread source from it (manifests, the low-resolution colour map through
`TileSource.file`, the cover's land cover) and lists the sets the source serves (`listTileSets`: the dev
server's `index.json`, or the sets of the pack list). A tile job asks for all its reads in one turn (heights,
albedo, water mask, land cover and the tile's own night image), as the pack source batches. Evidence: section 3.

**B. The render core's additions: DONE** (scope 6; acceptance line 6, first half; row 13). RENDER_API section
19 is the reference. The scrim: 0.077 ms with four rectangles at 1440p, the same pass as before with none.
The exposure hint and the lens shift are honoured by the core and by every feature that culls or forms rays
by hand (the list is in RENDER_API 19.5). Evidence and pictures: section 3.

**C. The browser mission's first minutes on `createSession`: FLOWN** (acceptance line 6, second half; row
14): pad to max-q through the mission spec's own machinery, milestones in order, cheatCounter 0, the pictures
looked at. The spec as a whole exits red on three lines of app-integration's that are not this sweep's: the
main-thread frame p99 at lift-off (the same miss as in the full flight of 2026-11-13, before the sweep) and
one frame of 167 ms on the pad, which the frame-interval line reports for the first time because it was never
measured before (section 3).

### 1.3 Not done, and known limits

- **Eight lab specs fail on the final tree; none was fixed** (section 3). Six are the known failures of the
  tree before the sweep. Two fail in some runs only: a cloud test on a noise maximum, and THE SWEEP'S OWN
  origin test for the `leo` scene, whose precondition (two control runs agree) does not hold in some loads.
  The origin test should take another control pair instead of failing; that was not done.
- **The lens shift in `src/app/framing.ts`** (the app's test hooks `bodiesInFrame` / `groundSamples`): they
  project without a shift. No rig of the app states one today; the menu package that adds one adds it there.
- **The lens flare under a shift** places its ghosts about the centre of the FRAME, not about the shifted
  view axis (D17): a choice, stated in RENDER_API 19.5.
- **Thin geometry under a lens shift is not lit to the bit as without one** (same depth, another stochastic
  sample pattern; section 3 has the numbers). The cause was inferred, not isolated.
- **The scrim costs its 0.077 ms whenever ANY rectangle is published**, whatever the area (the shader compiler
  flattens the conditions inside the loop; measured with a rectangle of no area: 0.072 ms). Within the line;
  drawing the scrim as quads over the covered pixels only would make it proportional to the area. Not done.
- **Three readers of tile-set FILES are not through the seam** (the clouds' coverage map, the sky probe's
  albedo, the labs' stand-in planet read `ctx.tilesUrl`): request `presentation-sweep-7`. The integrated app
  therefore still needs the plain files beside the packs; the terrain itself does not.
- **The app and the integration lab still create their height authority and the terrain feature on the fetch
  default** (`src/app/game.ts:182`, `labs/integration/main.ts:397`): choosing a pack spec from the endpoint
  document and the boot pack is the shell's (app-integration-2 / shell-menu). `WorkerInit` has no boot pack:
  a worker's pack source reads the boot pack's tiles from the network or the shared OPFS cache.
- **`MAX_SITES = 4` ground plans per body** (D10): request `presentation-sweep-6`.
- **An uncommitted `tests/unit/fakes/originProbe.scratch.test.ts`** named in the third context's brief was
  not in the tree when that context began (`ls tests/unit/fakes`: `deprecated.test.ts`, `fakeSession.test.ts`,
  `frameAccess.test.ts`; `git status` clean of it): nothing to commit or remove.

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
- **D15. The tile source is an option of the terrain feature, not a field of the context.** `RenderContext`
  is the lead's; the feature's default is built from `ctx.tilesUrl`. The spec is handed to a worker with
  absolute URLs (a worker resolves a relative URL against its own script). `listTileSets` reads the pack list
  a second time (7 kB) rather than reaching into the pack source for its sets.
- **D16. The scrim reads the bloom's DOWN chain, the widest six levels, and `blur` is relative to the frame.**
  The chain's level count follows the frame height, so indexing from its wide end makes a blur as wide in the
  frame at every resolution. Each level is read through a four-tap tent (a 12-row level sampled bilinearly
  shows its texel grid). The scrim is applied before the display transform, so a backdrop is toned and
  dithered like the scene. `packScrimRects` refuses a ninth rectangle instead of dropping it.
- **D17. A lens shift is a shift lens:** the projection's z column carries it as it carries the jitter, in
  both matrices; `cameraForward` stays the view axis and the tangents stay the field of view. One new chunk
  function, `ndcRay(ndc)`, is the only place a ray is formed from a frame position (`viewRay`, the TAA's sky
  reprojection and the two cloud rays go through it); one helper, `frustumTangents`, gives every culling
  test its four sides. `FrameUniforms` grew by one vec4 (`lensShift`, after `jitter`). The flare's ghosts
  mirror about the frame centre: with a shifted axis they would leave the frame on the side the menu panel is.
  Without a shift every one of these paths computes what it computed before, to the bit (the image gate).
- **D18. An exposure hint replaces the meter's target, linearly in EV at the rig's rate;** the meter keeps
  reading so that the exposure has somewhere to go when the hint ends. `exposureCompensation` and `minEv100`
  do not apply under a hint. A frame-exact capture with a hint holds the hint's target. The view manager hands
  on the hint of the view a blend goes to, and blends the lens shift.
- **D19. A part of the mission is the mission spec with `MISSION_UNTIL`,** not a second spec: one machinery.
  Its record and pictures have their own names, so the whole flight's files are not overwritten.

## 3. The gates, as run

**Reference images** (`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional`),
the full set each time:

| On commit | Result |
|---|---|
| 3b80cfc (pads) | PASSED 33 of 33; the 30 exact at 0 pixels on the first load; no OTHER STATE line; `lunar-touchdown` mean 0.0000 max 1; `shoreline` mean 0.0010 max 3; `sweep-lunar-orbit` mean 0.0000 max 1 |
| 22622c4 (keys; snapshot words) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0007, p99.9 1, max 6; `shoreline` mean 0.0010 max 3; `sweep-lunar-orbit` mean 0.0000 max 1 |
| 94a3e01 (rebase; createSession) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0009, p99.9 1, max 6; `shoreline` mean 0.0010, p99.9 1, max 3; `sweep-lunar-orbit` (now drawn about the Moon by the real session) mean 0.0000, p99.9 0, max 4, 0.001 % of the pixels (tolerance 0.02 / 1) |
| 4f882d7 (the tile-source seam) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0011, p99.9 1, max 11; `shoreline` mean 0.0010, p99.9 1, max 3; `sweep-lunar-orbit` mean 0.0000, max 4, 0.001 % of the pixels |
| 0685bd0 (THE FINAL TREE: scrim, exposure hint, lens shift) | PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0009, p99.9 1, max 6; `shoreline` mean 0.0010, p99.9 1, max 3; `sweep-lunar-orbit` mean 0.0000, max 4, 0.001 % of the pixels |

No OTHER STATE line occurred in either full run of the third context (on 4f882d7 and on 0685bd0): there is none to hand to the lead.

No OTHER STATE line occurred in any of the three runs of the second context. (The one of the first context:
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

**The tile-source seam** (`tests/browser/terrain/source.spec.ts` inside the local stack, on 4f882d7 and again on the final tree 0685bd0 with the same result):
each view captured frame-exactly through a `fetch` spec and, on a fresh page, through a `pack` spec.

| View | fetch against pack |
|---|---|
| `earth-leo-hawaii`, `earth-leo-nadir-night` (the night lights), `earth-10km`, `pad-30m` (cover, rocks, the ground plan) | 0 pixels differ in each |
| `moon-terminator-5000km`, `moon-2km`, `moon-standing` | 0 pixels differ in each |

Earth: 19,765 plain tile files through fetch; through pack 7,722 pack requests, 9 reads of the pack list and
NO plain tile file. Moon: 8,718 files; 3,526 pack requests. No error on either page; no incomplete bake, no
tile given up. The pictures were looked at (`out/screens/presentation-sweep/source-*.png`).

**The render core's additions** (`tests/browser/integration/menu-core.spec.ts`, the integration lab's pad at
noon, 1280 x 720, 3 tests, all pass; pictures `out/screens/presentation-sweep/menu-core/`, looked at):

| What | Measured |
|---|---|
| Scrim, four rectangles | 519,396 pixels changed inside them, 0 outside; a rectangle of opacity 0: 0 pixels; rectangles taken away: the first picture to the bit |
| blur 0.6, dim 0.5 | mean luma 93.6 -> 63.5; detail (mean step between neighbours) 3.72 -> 0.52 |
| blur 0.3, dim 1 | 138.1 -> 137.9; detail 0.94 -> 0.52 |
| blur 1, dim 0.7 | 85.6 -> 73.9; detail 5.66 -> 0.51 |
| blur 0.6, dim 0.5, opacity 0.5 | 93.6 -> 82.9; detail 11.96 -> 7.39 |
| Exposure hint, +2 EV at 1 EV/s | metered 14.576; 15.576 after 60 frames, 16.576 after 120, held; the meter's own target meanwhile 14.576; mean luma 42.7 at the hint's target, 98.2 back on the meter; rate 0 holds; a frame-exact capture with the hint is at the hint's target |
| Lens shift 128 x 64 px, depth | of the 755,056 pixels both frames show, 4 (0.001 %) differ by more than a thousandth from the unshifted frame moved by 128 x 64 px (against the pixel beside the right one: 9.4 %) |
| Lens shift, picture | 51.4 % of those pixels the same to the bit; mean difference 1.10 levels (one pixel off: 6.01); 2.41 % by more than 8 levels, all on thin things (lattice towers, the fence, bushes, cloud edges); the lit scene before the resolve differs by more than a twentieth in 5.31 % |
| Lens shift, the strips brought in | 0 black pixels; mean luma 112.0 (left) and 105.7 (bottom) against 114.5 |

**The scrim's cost** (`tests/browser/render-core/scrim.perf.spec.ts`, perf project, 2560 x 1440, the GPU under a
7 ms ballast, 8 alternating windows of 180 frames per series; every window of a series gave the same median
to a microsecond):

| `core.tonemap` | GPU ms |
|---|---|
| no rectangle | 0.0322 |
| four rectangles (57 % of the frame) | 0.1093: the scrim costs 0.0770 (line: 0.1) |
| one rectangle of no area | 0.1040 |
| no rectangle again | 0.0322 |

**The browser mission's first minutes** (`MISSION_UNTIL=MAX_Q ... --project=mission`, the integrated app on
`createSession`, 2560 x 1440, 1.1 minutes of flight; flown twice, the second time with the frame intervals
read): LIFTOFF and MAX_Q in order; both picture stops reached; cheatCounter 0 at each milestone and at the
end; pad start, crew alive, no incomplete terrain query, `window.__test.errors` empty; lift-off surface speed
0.017 m/s, inertial 439.3 m/s (gate < 0.1; 439 +/- 2); max-q 28.35 kPa at 11.0 km (gate 20-40 kPa). The three
pictures (`out/screens/mission/until-max-q-0[0-2]-*.png`: the pad, the lift-off in its smoke, the stack over
the cloud deck at 14.9 km with the HUD's stage tiles) were looked at.

| Phase | GPU p50 / p99 (line 11) | main thread p50 / p99 (line 6) | frame intervals |
|---|---|---|---|
| prelaunch | 5.64 / 6.15 | 3.56 / 4.37 | median 16.700 ms; ONE frame of 166.7 ms in 2,101 |
| ignition | 6.36 / 6.88 | 4.09 / 6.44 | median 16.700; none dropped |
| vertical | 6.10 / 6.96 | 6.31 / 11.64 | median 16.700; none dropped |
| pitchProgramme | 4.64 / 5.33 | 4.26 / 7.88 | median 16.700; none dropped |

THE SPEC EXITS RED on its soft lines: the main-thread p99 of ignition, vertical and pitchProgramme, and the
one long frame on the pad. Not the sweep's as far as it can be told: the full flight of 2026-11-13, before
the sweep (`out/mission/browser-mission.json`), had 7.36, 12.49 and 8.07 ms in the same three phases. The
frame of 167 ms has no earlier measurement to compare with: until this context the spec read the intervals
after the reset that clears them, so every window was empty (fixed in row 14). FOR THE LEAD: the whole
flight will now judge the frame-interval line for the first time.

**Budget gate** (`BUDGET_COMPARE=1 ... budget.perf.spec.ts --project=perf`) on 0685bd0, the final tree:

| Row | Summed GPU time against the recorded | Packages the gate names as moved |
|---|---|---|
| pad lift-off | 6.10 ms against 6.17 (-1.2 %) | vfx 0.829 -> 0.800 |
| ascent 10-40 km | 3.36 against 3.40 (-1.3 %) | |
| LEO | 3.11 against 3.04 (+2.5 %) | core 0.683 -> 0.785 |
| LEO cockpit | 3.44 against 3.57 (-3.9 %) | terrain 1.056 -> 0.927 |
| lunar descent | 3.40 against 3.42 (-0.7 %) | |
| reentry | 2.93 against 3.02 (-3.1 %) | core 0.863 -> 0.763 |
| splashdown | 5.42 against 5.66 (-4.3 %) | vfx 0.259 -> 0.041 (the finding of the second context: not the sweep's) |
| stony ground (whole frame) | 6.04 against 6.26 (-3.5 %) | atmosphere 1.515 -> 1.345 |
| among kiawe (whole frame) | 5.47 against 5.60 (-2.3 %) | core 0.729 -> 0.705, ocean 0.262 -> 0.164 |
| thickets from 120 m (whole frame) | 6.35 against 6.65 (-4.5 %) | core 0.967 -> 0.731 |

All ten rows pass (10 passed, 10.1 min; nothing else of this package running; the user's two servers were up). No row rose by more than 3 %. The core's time moves by a tenth of a millisecond between runs of one tree in both directions (LEO +0.10, reentry -0.10, thickets -0.24 here; lunar descent 0.846 and 0.757 in two runs of 94a3e01), and the scrim cannot be in it: with no rectangle the whole tonemap pass is 0.032 ms at 1440p. The two LEO rows run once more straight after: LEO 3.03 ms against 3.04 (-0.0 %), no package named as moved; LEO cockpit 3.48 against 3.57 (-2.8 %).

On 94a3e01 (the second context; nothing else of this package running): every row within 3 % of the recorded sum.

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

**Lab specs on the final tree** (0685bd0; one directory at a time through the GPU gate): 492 passed, 8 failed, 4 skipped, in 2 h 28 min.

| Directory | Passed | Failed |
|---|---|---|
| flight-ui | 94 | 1 |
| cockpit | 41 | 0 |
| map-view | 28 | 0 |
| vehicle | 15 (1 skipped) | 0 |
| vfx | 39 | 1 |
| audio | 18 | 0 |
| app (the integrated app on `createSession`) | 10 | 0 |
| integration (with `origin.spec.ts` and `menu-core.spec.ts`) | 47 | 6 |
| render-core | 42 | 0 |
| terrain | 22 (2 skipped: `source.spec.ts` runs inside the stack, where it passed) | 0 |
| sky | 33 | 0 |
| ocean | 42 | 0 |
| atmosphere | 61 (1 skipped) | 0 |

SIX of the eight are six of the eight of 94a3e01 with their numbers (`cockpit-lowOrbit-4k` mostly black 0.050;
`inside-cloud-t6-day` 5; aerial perspective 0.1279; 30 views with a line; correlation 0.652; forward against
deferred water 0.0523, which is 0.0518 or 0.0522 from run to run on this tree and in the second context's logs
alike). The other two of 94a3e01 passed this time (`shadows.spec.ts` (c) 5000 km, the test with two states;
`ocean/screens.spec.ts` midday, the page load that had timed out). TWO TESTS FAILED THAT HAD NOT, both in
`integration`, both run three more times each afterwards:

| Failed test | In the full run | Three more runs | What it is |
|---|---|---|---|
| `clouds.spec.ts` "(b) above an overcast deck of the real cloud map, plume and trail are hidden from the pad camera" | the largest change of any pixel from the pad 1.222 % of the mean luminance; the line is 1 % + 4 x the repeat noise = 1.122 % | passed 3 of 3: 0.911, 0.866, 0.838 % | The maximum over a frame of a noisy difference (the scene is a launch in flight, not a frozen frame: 32 to 35 trail segments from run to run); 0.907 % in the second context's run. One run in four over its line here. Not traced to a change; the cloud shaders compute what they computed (30 exact reference images at 0 pixels) |
| `origin.spec.ts` "leo: a replacement of the origin between two frames leaves no step and no motion-vector spike" (THE SWEEP'S OWN TEST) | failed on its PRECONDITION: two control runs, without any replacement, differ by 154,151 pixels, up to 49 levels, 99.9th percentile 10 (the line for a meaningful comparison is 4) | passed 2 of 3 (controls 89,448 px / p99.9 3 and 96,578 px / 3; replaced against control 19,252 px, velocity target equal to the control's); failed once more the same way (158,739 px, p99.9 10) | The `leo` scene has a second state between two loads of one page, in which the test cannot compare anything. Not new: of the five runs in the second context's logs (on b46bf4d) one had it (202,054 px, up to 68 levels, p99.9 9). 2 of 4 runs here, 1 of 5 there: too few to say the rate changed. When the controls agree the test passes. The `sea` and `lunar-orbit` scenes and the four frames of part 1 passed in the full run. A finding for the visual close-out (what in the LEO view has two states), and a weakness of the test: it should take another control pair instead of failing |

**Lab specs on 94a3e01** (the second context; `npx playwright test tests/browser/<dir> --project=functional`, one directory at a time through
the GPU gate; 2 h 10 min in all): 489 passed, 8 failed, 2 skipped. NONE OF THE EIGHT IS THE
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

Added in the third context (RENDER_API section 19 has the semantics):

```ts
// src/render/terrain
interface TerrainFeatureOptions { tileSource?: TileSourceSpec; ... }       // default { kind: 'fetch', baseUrl: ctx.tilesUrl }
interface WorkerInit { type: 'init'; defs; source: TileSourceSpec; bodies; cacheBytes }   // was tilesUrl: string
new TileStreamer(ctx, defs, bodyIds, options?, source?: TileSourceSpec)
loadLowResAlbedo(source: TileSource, manifest: TileManifest, meanColor: Vec3Tuple)      // was (tilesUrl, ...)
// src/render/terrain/tileSourceSpec.ts (NEW)
fetchTileSourceSpec(tilesUrl: string): TileSourceSpec
absoluteTileSourceSpec(spec: TileSourceSpec, base: string): TileSourceSpec
listTileSets(spec: TileSourceSpec): Promise<string[] | null>              // fetch: <baseUrl>/index.json or null; pack: the pack list's sets; fs: throws
// labs/terrain: &source=pack&packs=<pack list URL>[&opfs=<bytes>]

// src/render/core (exported from '@/render/core')
interface UiScrimRect { x0; y0; x1; y1; cornerRadius; blur; dim; opacity }   // device px, origin top-left; 0..1
packScrimRects(rects: readonly UiScrimRect[], out?: Float32Array): Float32Array   // UI_SCRIM_BYTES / 4 floats; throws over UI_SCRIM_SLOTS
SCRIM_LEVELS = 6; scrimLevelIndices(chainLevels: number): number[]; scrimLevelOf(blur: number): number
scrimCoverage(rect, px: number, py: number): number
exposureHintOf(camera): { targetEv100: number; rateEvPerS: number } | null
followExposureHint(current: number, targetEv100: number, rateEvPerS: number, dt: number): number
lensShiftOf(camera): [number, number]                                        // finite, within -1..1; else [0, 0]
frustumTangents(tanX: number, tanY: number, lensShift: readonly [number, number]): { left; right; bottom; top }
buildProjection(fovY, width, height, jitterPx, lensShift?: readonly [number, number]): Projection   // Projection.lensShift
interface ExposureInfo { ...; hint: { targetEv100: number; rateEvPerS: number } | null }
// FrameUniforms: lensShift: vec4f after jitter (FRAME_UNIFORM_OFFSET.lensShift = 124; bodies 164 -> 168; 3040 bytes)
// WGSL chunk "frame": fn ndcRay(ndc: vec2f) -> vec3f; viewRay(uv) = ndcRay(ndc(uv) - jitter)
// Tonemap.draw(pass, scene, bloom, params, scrim: { rects: GPUBuffer; levels: readonly GPUTextureView[] }); PostOutputs.scrimLevels
// src/render/core/lab
LabApp.setScrim(rects: readonly UiScrimRect[] | null): void
interface LabCameraSettings { ...; lensShift: [number, number] | null; exposureHint: { targetEv100; rateEvPerS } | null }
// lab query: &lensshift=<x>,<y>  &evhint=<EV100>,<EV per second>
// src/render/atmosphere/select.ts: ViewFrustum.lensShift?: readonly [number, number]
// src/map/projection.ts: Projector.shiftX / shiftY (the camera's lens shift); cx, cy and projectionMatrix() carry it
// src/camera/viewManager.ts: a blend interpolates lensShift and hands on the exposureHint of the view blended to
// tests/browser/mission/lunar-direct.spec.ts: MISSION_UNTIL=<milestone id>
```

FakeSession for the next packages is as the first context left it: `stores.launchQueue` in the scene
`launchQueue`, `Readouts.target` and `.docking`, `portStates()`, `dockCapture` / `docked` events, echoes with
offers and the three time strips.

## 5. Acceptance lines of the brief, as they stand

| Line | State |
|---|---|
| typecheck clean; the grep test | MET. `npm run typecheck` exit 0 at 0685bd0 (and at 94a3e01). `tests/unit/fakes/deprecated.test.ts` (9 tests): eight rules over 500+ files of the presentation, the labs, the browser tests and the presentation's unit tests; every exception listed with its reason (the access module, the fake as a producer, the retired member's type, the audio data's path, `scenario.vehicle` in `src/app/main.ts`, the lab vehicle sim, four tests of producers and of the origin); a stale exception fails. Outside its scan: section 6 |
| every wave-2 unit and lab spec; every reference image; budget within 3 % | On the final tree 0685bd0. Unit: 83 files, 999 tests, all pass (the suites of section 8; 971 at the end of the second context). Reference images: PASSED 33 of 33; the 30 exact at 0 pixels; no OTHER STATE line; `lunar-touchdown` mean 0.0009, p99.9 1, max 6; `shoreline` mean 0.0010, p99.9 1, max 3; `sweep-lunar-orbit` mean 0.0000, max 4, 0.001 % of the pixels. Budget: all ten rows pass, none rose by more than 3 % (the largest rise: LEO +2.5 %, and -0.0 % when that row was run again; the others between -4.5 % and -0.7 %). Lab specs: 492 pass; NOT MET for eight tests: six are known failures of the tree before the sweep with unchanged numbers, two are tests that fail in some runs and pass in others (an effect-noise maximum over its line once in four runs; the origin test's `leo` scene, whose two control runs disagree in some loads, as they did in the second context) (section 3) |
| the same frame at two origins under 1/255 per channel; a rebase without a step or a motion-vector spike | MET for the renderer: 0 pixels in four lunar frames under an exact translation of the origin. A frame COMPUTED about the other origin has a mean difference of 0.007 level and a 99.9th percentile of 1 (2 in `lunar-touchdown`); single pixels differ by up to 17 levels: the last bits of float64 at 384,000 km, not the renderer (D7 / D8, request 5). Rebase: three scenes, no step, velocity target equal to the control's, and the test fails without the core's rebase (section 3). ON THE FINAL TREE the origin test passed for the four frames of part 1 and for the `sea` and `lunar-orbit` replacements; the `leo` replacement passed in 2 of 4 runs and in the other two could not be judged, because two control runs of that scene disagreed (a second state of the scene between loads, also in the second context's logs: section 3) |
| two craft of one vehicle never mix; an assembly framed from its radius | MET: resource bars (`displays.test.ts`), wear and mounts (`mounts.test.ts`), RCS jets, canopies and event parts (`tests/unit/vfx/model.test.ts`), engine histories of the audio model (`tests/unit/audio/model.test.ts`); the chase rig on a three-craft assembly (`camera.test.ts`). Staging: the stage stack is per craft in the snapshot (`CraftSnapshot.staging`), the HUD reads the helm craft's |
| the terrain lab through `fetch` and `pack` | MET. Seven views of Earth and the Moon, each captured frame-exactly through a `fetch` spec and through a `pack` spec against the local stack: 0 differing pixels in every one; the pack page asked for no plain tile file (section 3) |
| scrim step at most 0.1 ms with four rectangles, unmeasurable with none | MET. 0.077 ms with four rectangles at 2560 x 1440 (`core.tonemap` 0.0322 -> 0.1093 ms); with none the pass is 0.0322 ms in two alternating series (identical to a microsecond), the image gate is at 0 pixels on the 30 exact checkpoints and the budget table is as below. Stated plainly: the 0.077 ms is paid for ANY rectangle, also one of no area (1.3) |
| the mission's first minutes (pad to max-q) in the integrated app on createSession | MET for what the line asks: flown through the mission spec's machinery, LIFTOFF and MAX_Q in order, cheatCounter 0, gates of both milestones met, pictures looked at. The spec's own frame-time lines are NOT MET in three phases (main thread p99 at lift-off, as before the sweep; one 167 ms frame on the pad): section 3 |

## 6. For the lead and the tighten step

- **shell-menu, capability-settings** (the menu over the live scene): RENDER_API 19.3-19.5 is your interface.
  Publish panel rectangles in DEVICE pixels with `packScrimRects` (at most eight); reset the key or publish an
  empty list when no panel is up (any rectangle, also an invisible one, costs the scrim's 0.08 ms). A rig
  frames its subject beside a panel with `lensShift` and drives the exposure of a transit with
  `exposureHint`; both pass through the view manager's blends. `src/app/framing.ts` does not know the shift.
- **island-core, solar-system-sim** (who replace origins more often): RENDER_API 19.1 is what a holder of
  ROOT positions does; the three holders of today are listed there. A new holder is tested with
  `&frameorigin=` and `origin.spec.ts`.
- **terrain-render**: request `presentation-sweep-6` (ground plans for 16 and 9 pads). The terrain reads
  everything through one `TileSourceSpec`; a tile job issues its reads in one turn.
- **The shell / app-integration-2** (packs in the app): pass `tileSource` to `createTerrainFeature` and build
  the height authority with `createTileSource` of the same spec; the clouds and the sky probe wait for
  request `presentation-sweep-7`.
- **The lead**: the browser mission's frame-interval line is judged for the first time (row 14); on the pad
  it found one frame of 167 ms. `MISSION_UNTIL=MAX_Q` is a three-minute check of the app after a change.
- `createFakeSim`'s origin: request `presentation-sweep-5` (lead decision of 2026-11-17: KEEP; `createFakeSim`
  stays on the root body and no reference image is re-recorded).
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
- `presentation-sweep-5` (lead, not blocking): the origin of the labs' fake against one exact lunar picture. Decided: keep.
- `presentation-sweep-6` (terrain-render, not blocking): ground plans for every pad of a body (`MAX_SITES` = 4).
- `presentation-sweep-7` (the lead, not blocking): `RenderContext` states the tile source, so that the
  clouds' and the sky probe's files of a tile set can come from packs.

## 8. How to run

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render src/ui src/input src/camera src/map src/audio src/core/fakes src/core/access src/app tests/unit/atmosphere tests/unit/audio tests/unit/cockpit tests/unit/flight-ui tests/unit/map-view tests/unit/ocean tests/unit/render-core tests/unit/sky tests/unit/terrain-render tests/unit/vehicle tests/unit/vfx tests/unit/camera tests/unit/fakes tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional       (BASELINE_ONLY=a,b narrows it)
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/origin.spec.ts --project=functional           (ORIGIN_ONLY=a,b; ORIGIN_EXTRA=<query>)
BUDGET_COMPARE=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf
STACK_NAME=fsp-presentation-sweep npm run stack -- -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/terrain/source.spec.ts --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/menu-core.spec.ts --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/render-core/scrim.perf.spec.ts --project=perf
MISSION_UNTIL=MAX_Q node tools/dev/heavy.mjs --class=gpu -- npx playwright test --project=mission
```

Scratch of the third context (gate, budget, lab-spec, mission and stack logs; `rep.mjs <edits.mjs>`):
`C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep-3\`.
Scratch of the first two contexts (edit lists, gate logs, the lab-spec logs): `C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep\`
and `C:\Users\Shriv\AppData\Local\Temp\claude\27587f90db9339a2\ba338de1-7e7d-4ce7-bfa7-dd716f0b858a\scratchpad\presentation-sweep-2\`
(`repm.mjs <edits.json>` applies exact replacements to several files, all or none; write the JSON with the
Write tool: a shell heredoc corrupts backslashes on this machine).
