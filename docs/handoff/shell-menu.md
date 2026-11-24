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
| dbe8e8f, 0a81093 | Practice specs (other origins blocked; the unreachable server's banner), the re-target spec; a unit test of `VehicleFit` |
| 6815c77 | The lead's two points: no read of `defs.vehicles` by a runtime id in this package's scanned files (`tests/unit/fakes/deprecated.test.ts` rule `vehicles`: `ShellDeps.capabilities` takes the `VehicleDef` the menu lists; the lab's display vessel is `presentableVehicles(defs)[0]`; the fixture test lists ids). The rule `html` finding on the ROOT `index.html:106` (the capability gate's inline script, 4eeb9e0) is capability-settings', not this package's. The offer's order: presentable first-offer vehicles, then the other presentable ones (all of them when none is a first offer: never empty), then the rest, disabled. List rows no longer shrink in a scrolling list |
| a0e8860, 3045ea9 | A letter that is also a menu key (W, S) or Space types into a text field (only Enter, Esc, up/down act there); the lab's flight camera holds the transit's last pose; the status line and the Launch card in full ink |
| b7467a3 | Pad limits compared with fleet-data's tolerances (`ShellDeps.padLimitTolerance` = `LIMIT_TOLERANCE`, `DIAMETER_TOLERANCE` of src/sim/vessel/validate.ts; `padTakes`): the 9.50 m lunar stack was refused LC-1's stated 9.5 m by a rounding hair |
| c7478e1, 5649c6b | The lab's flight camera held body-fixed at the transit's last point; the tab bar on a plate; the display vessel stands on the pad's mount (it was drawn below the ground), the turntable aims at the stack's middle |
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
  capabilities(vehicle: VehicleDef, rules: UniverseRules): VehicleCapabilities,    // analyzeVehicle(defs, vehicle, { rules, reachCost }) of the host
  padLimitTolerance: { massShare: number; diameter: number },                      // LIMIT_TOLERANCE, DIAMETER_TOLERANCE of src/sim/vessel/validate.ts
  settings: SettingsHost | null, identity: IdentityHost | null, padCycleSeconds(rules): number | null,
  capacityReport(): string | null, wallNow(): number, captured(): boolean, intent(i: ShellIntent): void, reportError(m), reducedMotion?, uiScale? }
IdentityHost { callsign(): string | null; check(name): Promise<CallsignCheck>; generate(): string; rule(): string; create(name): Promise<{ recoveryCode: string }> }
CallsignCheck = { status: 'available' } | { status: 'taken'; suggestions: string[] } | { status: 'invalid'; reason: string }
ShellIntent = context | frame (subject earth|turntable|site|flight, vehicleId: a PRESENTABLE vehicle for 'turntable', free area)
            | transit (request, practice) | spawnAcknowledged | riseBack | resume | leave | capture (opt-in)
            | turntable { turn, zoom } | watchPad | trackShip
classOutlook(sites, padStates, vehicleClass, liveTick, rules, fit?: VehicleFit); padRows(sites, states, cls, liveTick, fit?)
VehicleFit { massWet: number; diameter: number; rules: UniverseRules; tolerance: { massShare: number; diameter: number } }
padTakes(limits: { maxLiftoffMass; maxDiameter }, fit: VehicleFit): boolean     // as validateVehicle compares
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

## 4. Acceptance, as measured

| Line | State (runs 6 and 7: section 7) |
|---|---|
| Binding tables (no Ctrl/Alt/Meta, no conflicts, every action reachable) | MET (unit, 7 tests) |
| Rules screen: default and staging, different numbers, no code change | MET (unit) |
| Credits: every source and licence line on the screen | MET (browser, menu.spec test 2) |
| Deploy flow by keyboard, focus per step, Back from every screen | MET (menu.spec tests 1, 2; runs 6, 7) |
| The same by mouse | MET (mouse.spec, run 6: hover moves the focus, tabs and deploy by click, Back by the prompt bar, Leave by click) |
| Four resolutions | MET: 1280x720, 2560x1440, 3840x2160, 3440x1440 (runs 6, 7); pictures looked at |
| Transition: camera on its path every frame | MET: 599 frames, largest step 18.9 km, 0 steps above `transitPathLength` + 1 cm (runs 6, 7, day; night too) |
| No frame >= 33 ms in the transit | MET: worst 27.0 ms, p99 17.1, p50 16.7 (run 6, perf, GPU lock) |
| HUD only after the spawn gate | PARTLY: the shell hides itself and publishes no scrim until `handOver()` (asserted in flight); the lab has no HUD, so the HUD's own gate is app-integration-1's |
| Holding drift on a slow acknowledgement | MET (menu.spec test 4, runs 6, 7: progress stands at the hold while every step > 0, "Securing range") |
| A refused spawn re-targets | MET (retarget.spec, run 6: rises back to deploy/pad with the reason, the alternative pad launches to control) |
| Night pad exposure within 1 EV at hand-over | MET: 11.38 EV at the hand-over, settled 11.40 (0.02 EV), Ka Lae LC-1 at 01:00 local, floodlit (run 7). The test still FAILS on one WebGPU warning of the spot shadow pass ("shadow.spot0" draw with 0 indices): request shell-menu-5 |
| Contrast >= 4.5:1 over the brightest backdrop, every text box | MET by day (run 7: every screen, worst 5.00:1 on Credits' "Moon · Public domain", 5.66 Hangar, 6.17 Universe) and at night (run 7: pad screen 7.71, flight menu over the night pad 10.24). Text of disabled controls (the fleet's not-yet-available rows) is reported and not held (WCAG 1.4.3). Tables: out/screens/shell-menu/contrast-day.json, contrast-night.json |
| Menu DOM main thread <= 0.5 ms/frame; text <= 10 Hz | MET: hub -0.04 ms (noise), pad screen 0.140 ms (open 1.806 / hidden 1.666 ms); text 9.5 Hz (run 6, perf, CDP thread ticks, five A/B rounds of 240 frames) |
| Practice: keyboard flow with requests blocked; from an unreachable server | MET on the fixture (practice.spec, run 6): every other origin blocked, keyboard from the hub's Practice card to control on the pad, the spawn to the Practice session (lobby 0, practice 1); `&link=offline` shows the banner, its Practice offer reaches the pad. A real `LocalSession` is session-switch's (the session type has no universe commands or stores until then): the fixture is this package's ground |
| Cold start | MET (coldstart.spec, run 6): `&planet=1&holdboot=1`, the title reports each boot step, a key does not begin while the hangar step is open, only the boot set's tile index, manifests and low-resolution globals are fetched; releasing the hangar opens Play |
| Wave-2 flight-ui, map, audio specs; FakeSession conformance | NOT re-run this round (nothing of theirs changed; the GPU slot was shared all day) |
| Turntable, display vessel, exploded stage view | PARTLY: the Hangar and Choose-a-craft orbit the display vessel on its pad (J / L turn, I / K zoom; picture hub-hangar-turntable-1280); the stage view (`splitForStage`) is NOT built (X is bound, no screen uses it) |
| Identity (callsign, recovery code) | MET on the fixture (menu.spec test 5, runs 6, 7): taken with suggestions, invalid in the service's words, available, created, the code once, Back cannot leave it |
| Audio (buses, UI sounds, menu score) | NOT DONE (section 5) |
| Type on the HUD and map labels | request shell-menu-4, not this package's files |

## 5. Left, in order

1. Request shell-menu-5 (the spot shadow pass's empty draw): the night test passes once it is fixed.
2. The exploded stage view (`splitForStage`) and the spectate rig. The turntable's framing: the stack's base sits
   behind the detail panel at 1280x720 (lens shift to the free area's centre; a closer or higher eye).
3. The transit's end pose and the app's chase rig: the lab's flight camera holds the transit's last pose (no chase
   rig in the lab); in the app the chase rig must START at `TransitPlan.endOffsetEnu` (and look where the transit
   looks) or the hand-over cuts and the exposure lands on another view. The lab's end looks at the pad + 9 m: the
   stack's top is cut; look at the stack's middle.
4. Settings' graphics rows from capability-settings' `GraphicsSettings` (src/bench/settings.ts) through
   `SettingsHost` (the lab passes `settings: null`; rows are read-outs today).
5. Audio (NOT STARTED): buses music and comms wait for the lead's join of `AudioBusNameV2` into `AudioBusName`
   (still separate in src/core/contracts/audio.ts); the UI sound set and the menu score via tools/audio
   (ElevenLabs, budget 60 USD); nothing before the first gesture. (labs/audio and tests/unit/audio had another
   agent's uncommitted edits today: left alone.)
6. Re-run the wave-2 flight-ui, map and audio specs.
7. The HUD and map label atlas on the shipped type (request shell-menu-4).

## 6. Decisions and why

- The shell imports only src/core (boundaries): keys, formatters, the camera and the render core reach it
  through `ShellDeps`; what it needs done outside the DOM is a `ShellIntent`.
- PRESENTABLE ONLY (lead decision of 2026-11-24): the Hangar and the deploy flow offer `presentableVehicleIds(defs)`
  (src/core/access/presentable.ts) first and list the others disabled as "Not yet available" (the brief shows the
  full fleet in the Hangar); My Ships does not resume a ship of a vehicle that cannot be shown; the turntable intent
  names only a presentable vehicle; the lab builds its display vessel from `presentableVehicles(defs)[0]`. NOTE:
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
- Run 5 (1fb6167, functional, 15 tests, 11.0 min): 10 passed (keyboard flow, Back, queue, holding drift, three
  resolutions, mouse, Practice blocked, Practice from the offline banner), 5 failed: cold start (the boot set's
  tile index and low-resolution globals: spec fixed), contrast by day (rows squeezed in a scrolling list: fixed),
  night exposure (1.93 EV: the lab's flight view differed from the transit's end view: the lab's flight camera now
  holds the transit's last pose), first Play (the S of a callsign was taken as menu-down: fixed), re-target (an
  immediate refusal passes through 'transit' between two frames: spec fixed). Also seen: LC-1 refused the lunar
  stack by a rounding hair (9.50 m stack, LC-1 states 9.5 m): fleet-data's tolerances now (b7467a3).
- Run 6 (b7467a3, functional + perf, 16 tests, 10.3 min): 14 PASSED, 2 failed - contrast by day (one unselected
  tab at 4.19:1 over the turntable's sky: tab bar on a plate since c7478e1) and the night exposure (the lab's flight
  camera was held in ROOT and drifted off the pad with the Earth: held body-fixed since c7478e1). Perf (GPU lock,
  thread ticks): menu DOM -0.04 ms/frame on the hub and 0.140 ms on the pad screen (open 1.806 / hidden 1.666),
  text 9.5 Hz; transit 599 frames, p50 16.66 ms, p99 17.1 ms, worst 27.0 ms, none >= 33 ms. Day transit: 0 of 599
  steps off the path. Contrast by day: every text of every screen >= 4.5:1 at the 2nd percentile except that tab.
  The vessel feature drew the display vessel (1 vessel, 125 instances) but below the ground (origin height 0): the
  lab stands it on the mount since 5649c6b.
- Run 7 (5649c6b, legibility + menu specs, 10 tests, 6.0 min): 9 PASSED, 1 failed: the night test, after all of its assertions passed (hand-over 11.38 EV, settled 11.40; night contrast >= 7.7:1), on one WebGPU warning of the spot shadow pass (request shell-menu-5). Contrast by day: no text below 4.5:1. Pictures looked at: hub-hangar-turntable (the lunar stack on LC-1 beside its tower, the fleet list with seven rows not yet available, the detail panel), flight-1280 (the stack on LC-1 at the hand-over pose; its top is cut), identity-recovery (the code, copy and download, the card), flight-night-handover (the floodlit pad).
