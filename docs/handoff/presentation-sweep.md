# presentation-sweep: hand-off (sub-wave 3.2; IN PROGRESS)

The one sweep over every presentation consumer (brief: `docs/WORK_PACKAGES_V2.json`, id `presentation-sweep`,
with its LEAD NOTES; the last one is the work order). This file is kept current while the sweep runs: a
successor continues from "State of the sweep" and `git log --grep presentation-sweep`.

## State of the sweep

Start: commit b076166 (the lead's contract step is 31e67fa; the tree before it is tagged
`pre-sweep-2026-11-16`). One commit per subsystem; the whole tree compiles between commits except for
`src/net` and `tests/unit/net`, which are `wire-protocol`'s and were in motion while the sweep ran (filter
them: `npx tsc --noEmit -p tsconfig.json | grep -v "src/net\|tests/unit/net"`).

### Done and committed

| # | Commit | Subsystem | Image gate after it |
|---|---|---|---|
| 1 | 105b8f8 | The lead's work order: the 21 compile errors. Binding table (the six v2 actions, `sas:target`, `sas:antiTarget`, `sas:portAlign`, their key labels and reference-card lines), the HUD's SAS row and names, the MFD's two pages, the chase rig's reference mode, the map's `targetApproach` tables, `setTarget(TargetRef)` at every call, the default of `'ui.scrimRects'`, the `pause` key as `flightMenu`, the selected target read through ONE helper | `sweep-hud-leo`, `sweep-map-translunar`, `sweep-cockpit-leo`, `sweep-app-pad`, `sweep-app-cockpit`: 0 pixels each, first load |
| 2 | 32203ca | The vessel feature: per-part state filed under the LINEAGE key (`CraftSnapshot.parent`, never the vessel id), the engines a part carries from the part list (`src/render/vehicle/mounts.ts`), no vehicle definition read; `CraftLineage` and the part keys in the access module | `pad-noon`, `ascent-10km`, `leo-day`, `lunar-orbit-low-sun`, `parachute-descent`, `sweep-hud-leo`, `sweep-separation-debris`, `sweep-app-pad`: 0 pixels each, first load |
| 3 | 1a93c40 | The HUD model: resource groups and labels from the parts (`stageGroup`, `stageLabel`, per craft), a stage's label from the staging panel, the words about a stage through one label source | (HUD checkpoints run with the next gate run) |

No OTHER STATE line was printed in any gate run so far.

### In progress / left, in the order to do it

1. **FakeSession** (`src/core/fakes`): `fakeSim.ts` must stay importable with `createFakeSim`, `FakeScene`,
   `FakeSimOptions`, `FAKE_SIM_DEFAULT_UT` (the tests of `tests/unit/camera` import it and are NOT in this
   package's paths, so they cannot be edited: keep them green as they are). v2 fields to fill: `revision`,
   `frame` with `previous`, `time`, `crafts` (with `cockpit`, `parent`, `chase`), `helm`, part `craftId` /
   `stageGroup` / `stageLabel`, `Readouts.target`. New scenes: rendezvous, docking approach, assembly,
   echoes, one time-strip scene per `TimeView.relation`, a queued launch request (`stores.launchQueue`).
   Conformance tests in `tests/unit/fakes` against `createSession` for the scenes a session has today.
   ORIGIN: a session's render root is the centre of the active vessel's SOI body. The 25 lab checkpoints were
   recorded on the FakeSim with the origin at the library's root body, and four exact ones are lunar
   (`lunar-terminator-20000km`, `lunar-terminator-5000km`, `lunar-orbit-low-sun`, `lunar-surface-cockpit`):
   measure whether a Moon-centred fake moves a pixel there before making it the integration lab's default
   (see "Decisions", D7).
2. Camera rigs: `chaseDistanceLimits` from `CraftSnapshot.chase` and the bounding radius (keep the signature
   `(defs, vessel)`: `tests/unit/camera/chase.test.ts` calls it), the cockpit rig without the
   `defs.vehicles` fallback (`cockpitHost`), `src/app/seat.ts`, `src/render/cockpit/feature.ts:302`.
3. Pads: every reader of `LaunchSiteDef.pad`, `.padAzimuthDeg`, `.structures` through `padsOf` / `padOf` /
   `padLocationOf` (`src/core/defs/sites.ts`): the site feature (one runtime per pad), `site/pad.ts`,
   `site/survey.ts`, terrain `feature.ts` and `sitePlan.ts`, vfx `director.ts` and `smoke.ts`, the chase rig's
   trench heading (already reads `pads`), labs, tests.
4. `snapshot.tick` -> `revisionOf(snapshot)` (cockpit `displays.ts`, audio `model.ts`, labs); every reader of
   `activeVesselId` through `activeVesselOf` or a null-safe find, with the neutral blocks.
5. Frame rebase: `FrameEpochTracker` in the render core's previous-frame state, the camera rigs, the map
   focus, vfx world-anchored effects; the origin test (Earth and Moon, under 1/255) and the SOI screenshot pair.
6. The tile-source seam: `WorkerInit` carries a `TileSourceSpec`; the worker and the streamer call
   `createTileSource(spec)`.
7. The scrim step in the tonemap pass, `CameraState.exposureHint` and `lensShift`; `docs/RENDER_API.md`.
8. `src/app`, `index.html`, `labs/integration`, every spec: `createSim` -> `createSession`, `Sim` /
   `SimDebug` -> `LocalSession` / `SessionDebug`.
9. `tests/unit/fakes/deprecated.test.ts` (the grep test), the whole unit suite, every lab spec, the full
   image gate, the budget gate, requests, this file as PACKAGE_RULES rule 17 asks.

## Decisions taken, and why

- **D1. One access module for what several presentation packages read of a snapshot:
  `src/core/fakes/snapshotAccess.ts`.** `revisionOf`, `targetOf` / `targetBodyOf` / `targetNameOf` /
  `bodyTarget`, `activeVesselOf`, `craftsOf` / `craftOf` / `craftIdOf` / `parentOf`, `partKeyOf` / `partKey`,
  `eventPartOf`, `CraftLineage`. It is the ONE file outside the simulation that reads `Readouts.targetBodyId`,
  `.targetClosestApproach` and `SimSnapshot.tick`. Why there: every presentation package may import
  `src/core` only (boundary rules), and `src/core/fakes` is the only part of `src/core` this package owns.
  Request `presentation-sweep-1` asks the lead for a home of its own at the tighten.
- **D2. `targetOf(readouts)` returns a `TargetView`, not a made-up `TargetReadout`.** `TargetView` is the
  part of `TargetReadout` that the deprecated pair can state (`ref`, `relativeInclination`,
  `closestApproaches[]` with `relSpeed` only where a session states it), with the same field names, and a
  `TargetReadout` is assignable to it. A derived `TargetReadout` would have needed a range, a range rate and
  a relative speed at the approach that nothing states. At the tighten a call site changes `targetOf(r)` to
  `r.target`.
- **D3. Keys of the v2 actions.** `flightMenu` Esc and P, `cycleTarget` B, `toggleRoster` O,
  `acceptPrompt` Y, `openQuickComms` Enter (ARCHITECTURE 19). `dockingView` is NOT on V: the next couch
  (`ui:nextSeat`, request core-6) has V and every letter is bound, so it is on `Equal` (right of the three
  display keys 9 0 -). The three SAS holds against a target are on `Semicolon`, `Quote`, `Backslash` (the
  digit row is full). The retired `pause` is named once, as a type (`RetiredButtonAction` in
  `src/input/bindings.ts`), so that the exhaustiveness check still compiles until the lead removes the member.
  In the app and the flight-ui lab `flightMenu` toggles the local pause (no menu is built here).
- **D4. The HUD's SAS row** has the three target holds as buttons that are hidden unless the session lists
  them in `sasModesAvailable` (a third row; nothing shows today). Port alignment has an icon of its own
  (`PORT_ALIGN_ICON`), which is not in the navball's marker atlas. **The MFD** paints `target` and `docking`
  as pages of rows; they are not in `MFD_PAGES` (the page cycle and the lab's page list stay six), a display
  shows one when its page is set to it (`MFD_TARGET_PAGES`).
- **D5. Engine mounts from the part list** (`engineMounts`): an engine with attach nodes is mounted on every
  part of its craft that shares a node position with it; an engine without nodes (motor packs, RCS pods) on
  the part whose `PartDef.bounds` cylinder is nearest to its origin (the nearer origin breaks a tie). For the
  one vehicle of the library this is exactly the parent of the vehicle tree, before and after every stage
  (`tests/unit/vehicle/mounts.test.ts`).
- **D6. Words about a stage still come from the vehicle's file, in ONE place** (`stageWordsSource` in
  `src/ui/model.ts`, keyed by the helm craft's `vehicleId`): what a stage burns, which chutes it deploys or
  releases, the engines behind the weak-gravity acceleration figure. `StageInfo` states none of them, the
  contract gives `vehicleId` "for labels and icons only", and dropping them would have changed the HUD's stage
  tiles (exact reference images). Request `presentation-sweep-3` asks for the fields that would remove it.
  THIS IS THE ONE REMAINING `defs.vehicles[<runtime id>]` OF THE PRESENTATION and the grep test lists it.
- **D7. (open) The fake's render root.** See item 1 above.
- **The fairing petal index** is still read from the instance id (`fairingPanelOf` in
  `src/render/vehicle/vesselFeature.ts`, the one place): the snapshot states it nowhere else. Request
  `presentation-sweep-2`.

## Requests to file (not written yet)

- `presentation-sweep-1` (lead, not blocking): a home in `src/core` for the snapshot access module.
- `presentation-sweep-2` (lead + sim, not blocking): the petal index of a fairing panel as a field
  (`ModuleState` of type `fairing`, or `PartSnapshot`), so that `fairingPanelOf` and
  `src/render/vfx/director.ts:357` stop composing `#panel<k>`.
- `presentation-sweep-3` (lead + sim, not blocking): per stage in `StageInfo`, the stage groups its engines
  are in (or the burn label), the chute mode its actions deploy or cut, and what the weak-gravity acceleration
  needs (thrust and mass flow of the engines it lights).
- `tests/unit/camera` has no owner in `WORK_PACKAGES_V2.json`; the sweep keeps its two files green without
  editing them.

## How to run the gates

```
BASELINE_ONLY=a,b node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional
BUDGET_COMPARE=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render src/ui src/input src/camera src/map src/audio src/core/fakes tests/unit
```
