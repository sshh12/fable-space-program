# Hand-off: shell-menu (wave 4.1) - RUNNING STATE of the second builder

The package is NOT finished (section 5 lists what is left, in order). This note is the running state: what is
done (with commits), what is measured, the decisions. Continue from here and
`git log --oneline -- src/shell src/camera src/input labs/shell tests/browser/menu`.

## 1. Done (commits)

| Commit | What |
|---|---|
| 9c9ceef | Input contexts (`src/input/contexts.ts`), `InputSystem.context` / `setContext` (release-all on switch); the shell's pure models (`machine.ts`, `pads.ts`, `solar.ts`, `rulesView.ts`, `leaveOutcome.ts`, `spawnFlow.ts`); `src/core/fakes/menuStores.ts`; `data/defs/visuals/credits.json`; the Barlow family (OFL) |
| f9ecee8 | The DOM kit, every screen, the shell, the camera paths (`src/camera/menuRigs.ts`), `labs/shell`, `tests/browser/menu/menu.spec.ts` |
| e03342b, b9b6eb1, 3849855, 31201be, be4199b, 3e66c40 | Requests shell-menu-1..4; leave-line tests; legibility pass 1; rig tests; history trap on a user gesture (first builder) |
| 822c443 | A change of screen is drawn AT ONCE and a key acts on the screen as it stands (run 3's tests 3-7 failed because the second Enter reached the hub before the 10 Hz text clock drew it: a real bug, not a reload). The pad class is the ANALYSIS' (`ShellDeps.capabilities(vehicleId, rules)` = `analyzeVehicle` under the rules in force; the "assumed heavy" fallback is gone); a pad is usable when its class hosts the vehicle and `padLimitsOf(pad, rules)` takes its mass and diameter (`VehicleFit`) |
| 14723e1 | The specs of the remaining acceptance lines (mouse, legibility, perf, cold start) and the lab hooks for them (`&padhour`, `&holdboot`, `setMenuHidden`, `lastTransit`); `transitPathLength` (the path's own motion bound) |
| 1fb6167 | Presentable vehicles only (see 6); the identity screen (`src/shell/identity.ts`, `createIdentityFixture`); the Hangar turntable (`ShellIntent` `turntable`; the lab's display vessel); layout (scrolling column and lists, detail and Launch in the right column, banner at the right, plates behind the top-right status and "Press any key", stronger fills); the click-through-a-rebuilt-control fix; the transit status read live; pad focus on a free pad of the vehicle's own class; the transit's exposure follows the meter below the hold |

## 2. Public API (exact signatures)

```ts
// src/shell (imports src/core only; the host hands in everything else)
createShell(deps: ShellDeps): Shell
interface Shell {
  readonly machine: ShellMachine; readonly spawn: SpawnFlow;
  action(action: string): boolean; update(realDt: number): void; booted(): void; gatePassed(): void;
  transitStatus(text: string | null, holding: boolean): void; handOver(): void; left(): void; openFlightMenu(): void;
  focused(): string | null;
  hooks(): { state; main; side; focus; scrimRects: number; spawn: string; practice: boolean; textRefreshes: number; screenChanges: number };
  dispose(): void;
}
ShellDeps { root, canvas, defs, format: NumberFormat, keys: ShellKeys, lobby: ShellSession, practice: ShellSession | null,
  publishScrim(rects), boot(): BootProgress, snapshot(): SimSnapshot | null,
  capabilities(vehicleId: string, rules: UniverseRules): VehicleCapabilities,      // analyzeVehicle(defs, v, { rules, reachCost }) of the host
  settings: SettingsHost | null, identity: IdentityHost | null, padCycleSeconds(rules): number | null,
  capacityReport(): string | null, wallNow(): number, captured(): boolean, intent(i: ShellIntent): void, reportError(m), reducedMotion?, uiScale? }
IdentityHost { callsign(): string | null; check(name): Promise<CallsignCheck>; generate(): string; rule(): string; create(name): Promise<{ recoveryCode: string }> }
CallsignCheck = { status: 'available' } | { status: 'taken'; suggestions: string[] } | { status: 'invalid'; reason: string }
ShellIntent = context | frame (subject earth|turntable|site|flight, vehicleId: a PRESENTABLE vehicle for 'turntable', free area)
            | transit (request, practice) | spawnAcknowledged | riseBack | resume | leave | capture (opt-in)
            | turntable { turn, zoom } | watchPad | trackShip
classOutlook(sites, padStates, vehicleClass, liveTick, rules, fit?: VehicleFit); padRows(sites, states, cls, liveTick, fit?)
VehicleFit { massWet: number; diameter: number; rules: UniverseRules }
// src/camera: menuEye, transitSample, transitPose, holdProgress, transitPathLength(plan, u0, a0, u1, a1, steps = 8): number
// src/core/fakes: createMenuFixture, menuShipsFixture, createIdentityFixture(opts?: IdentityFixtureOptions): IdentityFixture
```

## 3. How to run and verify

- Unit: `npx vitest run tests/unit/shell src/input tests/unit/fakes/menuStores.test.ts tests/unit/fakes/identityFixture.test.ts tools/dev/boundaries.test.ts` (155 pass at 1fb6167).
- Lab: `/labs/shell/?governor=off&queue=free|busy|full&rules=default|staging|local&ack=<s>&refuse=1&link=<state>&admission=queued&scale=<x>&reduced=1&planet=1&padhour=<local solar hour at the pad>&holdboot=1&identity=new`.
- Browser (GPU slot, one at a time): `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu --project=functional --project=perf`.
  Specs: `menu.spec.ts` (keyboard flow, Back everywhere, launch queue, holding drift, first Play + turntable, four resolutions),
  `mouse.spec.ts`, `legibility.spec.ts` (contrast by day and at a night pad, transit on its path, night exposure at the hand-over),
  `coldstart.spec.ts`, `menu.perf.spec.ts` (CDP A/B, text rate, transit frame times). Helpers in `menuPage.ts`.

## 4. Acceptance, as measured (run 4 at 14723e1; run 5 at 1fb6167: section 7)

| Line | State |
|---|---|
| Binding tables (no Ctrl/Alt/Meta, no conflicts, every action reachable) | MET (unit, 7 tests) |
| Rules screen: default and staging, different numbers, no code change | MET (unit) |
| Credits: every source and licence line on the screen | MET (browser, run 4 test 5) |
| Deploy flow by keyboard, focus per step, Back from every screen | MET (run 4 tests 4, 5) |
| The same by mouse | spec `mouse.spec.ts`; run 4 failed on a real bug (a click whose control rebuilt the screen fell through to "begin" on the title), fixed in 1fb6167 |
| Four resolutions | MET at 1280x720 (test 4), 2560x1440, 3840x2160, 3440x1440 (run 4 tests 8-10); pictures looked at |
| Transition: camera on its path every frame | MET: 599 frames, largest step 18.8 km, 0 steps above `transitPathLength` + 1 cm (run 4, day) |
| No frame >= 33 ms in the transit | MET: worst 27.4 ms, p99 18.1, p50 16.7 (run 4, perf, GPU lock) |
| HUD only after the spawn gate | the shell hides itself and publishes no scrim until `handOver()` (asserted); the lab has no HUD: the HUD's own gate is app-integration-1's |
| Holding drift on a slow acknowledgement | run 4 failed on a real bug (the transit text was a stale copy), fixed in 1fb6167 |
| A refused spawn re-targets | the spawn flow and the fixture's `refuseNext` exist and the refusal panel offers the alternative; no browser assertion yet |
| Night pad exposure within 1 EV at hand-over | run 4: 1.93 EV (hand-over 9.55, settled 11.48): NOT MET; fixed in 1fb6167 (the pad's exposure is the meter's reading from the hold down, rate >= 2 EV/s): see run 5 |
| Contrast >= 4.5:1 over the brightest backdrop, every text box | run 4 by day: 16 texts below (top-right status 1.0 over cloud, "Press any key" 1.08 over the limb, a label under a tab underline 1.12, a few dim captions 3.8-4.3): layout fixed in 1fb6167; see run 5 |
| Menu DOM main thread <= 0.5 ms/frame; text <= 10 Hz | MET: 0.145 ms (hub, open 1.281 / hidden 1.136) and 0.070 ms (pad screen); 9.7 Hz (run 4, perf, thread ticks) |
| Practice: keyboard flow with requests blocked; from an unreachable server | PARTLY: Practice runs the same deploy flow on the local rules (fixture, never queues); the reconnecting / offline banner offers it; no spec with blocked requests yet. A real `LocalSession` is session-switch's (the session type has no universe commands or stores until then): the fixture is this package's ground |
| Cold start: title on the boot set, progress, Play only when the hangar data is resident | spec `coldstart.spec.ts` (`&planet=1&holdboot=1`); run 4 failed on the spec's own text match (innerText is upper-cased), fixed |
| Wave-2 flight-ui, map, audio specs; FakeSession conformance | not re-run (nothing of theirs changed) |

## 5. Left, in order

1. Run 5's result (section 7), then the perf spec again on the final tree (the scrim now clips to scrolled
   ancestors: re-measure the 0.5 ms line).
2. Practice spec with requests blocked (`page.route('**', abort)` for anything outside the page's own files) and
   from `&link=offline`.
3. A refused spawn re-targeting in the browser (`&refuse=1`).
4. The exploded stage view (`splitForStage`) and the spectate rig; the turntable shows the display vessel the
   lab assembled (one presentable vehicle today); the app's host must build its own per chosen vehicle.
5. Settings' graphics rows from capability-settings' `GraphicsSettings` (src/bench/settings.ts) through
   `SettingsHost` (app-integration-1 or the next round: the lab passes `settings: null`).
6. Audio (NOT STARTED): buses music and comms wait for the lead's join of `AudioBusNameV2` into `AudioBusName`
   (still separate in src/core/contracts/audio.ts); the UI sound set and the menu score via tools/audio
   (ElevenLabs, budget 60 USD); nothing before the first gesture. (labs/audio and tests/unit/audio have another
   agent's uncommitted edits today: leave them.)
7. The HUD and map label atlas on the shipped type (request shell-menu-4).

## 6. Decisions and why

- The shell imports only src/core (boundaries): keys, formatters, the camera and the render core reach it
  through `ShellDeps`; what it needs done outside the DOM is a `ShellIntent`.
- PRESENTABLE ONLY (lead decision of 2026-11-24): the Hangar and the deploy flow offer `presentableVehicleIds(defs)`
  (src/core/access/presentable.ts) first and list the others disabled as "Not yet available" (the brief shows the
  full fleet in the Hangar); My Ships does not resume a ship of a vehicle that cannot be shown; the turntable intent
  names only a presentable vehicle; the lab builds its display vessel from `firstPresentableVehicleId`. NOTE:
  presentable.ts and the vessel feature's use of it were in the working tree, NOT committed, when 1fb6167 was
  made; 1fb6167 needs that commit to compile on its own.
- The pad class is the analysis' (`VehicleCapabilities.padClass`, derived by fleet-data from the class limits of
  the rules in force and the vehicle's lift-off mass and diameter, or its pad interface). No "assumed" class.
- A change of screen is drawn at once; store changes and live text wait for the 10 Hz text clock; a store
  change does not rebuild a screen under a text field being typed in.
- The launch queue lives in the spawn flow and shows on the pad screen and the briefing (never a blocking page).
- Launches per hour need a rules field (request shell-menu-1, still open: `UniverseRules.pads` has no cycle); the
  pad screen states the pad count and the wait per class and omits the rate.
- Identity: everything about what a callsign may be is the service's (`check` answers, `rule()` words); the
  recovery code is shown once and Back does not leave its card.
- The transit's exposure: the eye's EV to 100 km, a prior below, and from the hold down the meter's own reading
  of the pad (it keeps metering under a hint), so the hand-over lands where the flight view settles.
- Contrast is measured on the page itself: the text made transparent, the backdrop (scene, scrim, panel fill,
  vignette) captured four times over 1.5 s of the drift, each text's colour against every pixel in its tight
  glyph rectangles; the 2nd percentile is held to 4.5:1; text of disabled controls is reported, not held (WCAG
  1.4.3 exempts inactive components).

## 7. Browser runs (real Chrome, real GPU, through the gate)

- Runs 1-3: first builder (run 3's failures of tests 3-7 were the render-latency bug of 822c443, not reloads: the
  harness's page server has `watch: null`).
- Run 4 (14723e1, 12 tests, 12.3 min): 7 passed (keyboard flow, Back everywhere, launch queue, three large
  resolutions, perf), 5 failed: cold start (spec text match), contrast by day (16 texts), night exposure (1.93 EV),
  slow acknowledgement (stale transit text), mouse (click through a rebuilt control). All five fixed in 1fb6167.
- Pictures looked at from run 4 (out/screens/shell-menu/): title (wordmark top left, limb, ticker, "Press any
  key" over the bright limb: plate added), hub-play (cards, lobby row, tabs; panels touched: gap added),
  deploy-vehicle and hub-hangar (detail overflowed the screen over the status line: moved to the right column;
  empty space where the vehicle should be: turntable added), deploy-pad 1280 and 4K (list ran off the screen:
  scrolls now; "free in 0:00" for an occupied pad: the lobby's tick is used now), deploy-briefing (Launch card
  under the panel: right column now), launch-queue-reconnecting (banner over the tabs: moved right),
  flight-menu (subtitle weak over the sky: full ink + top vignette), hub-universe and hub-credits (ran off the
  screen: the column scrolls, up/down scroll it), hub-settings (clean), flight-night-handover (flood-lit pad).
- Run 5 (1fb6167): RUNNING when this was written.
