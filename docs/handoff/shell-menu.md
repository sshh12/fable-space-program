# Hand-off: shell-menu (wave 4.1) - RUNNING STATE, stopped at two thirds of the builder's context

The package is NOT finished. This note is the running state the brief asks for: what is done (with commits),
what is measured, what is left in order, and the decisions. The next builder continues from here and
`git log --oneline -- src/shell labs/shell tests/browser/menu`.

## 1. Done (commits)

| Commit | What |
|---|---|
| 9c9ceef | Input contexts (`src/input/contexts.ts`: `MENU_BINDINGS`, `TRANSIT_BINDINGS`, `validateContextTable`, `contextActionOf`, `keysOfAction`); `InputSystem.context` / `setContext` (only 'flight' feeds the flight table; a switch releases every held key; the wheel over a menu panel is left to the page); the shell's pure models (`machine.ts`, `pads.ts`, `solar.ts`, `rulesView.ts`, `leaveOutcome.ts`, `spawnFlow.ts`); the menu store fixture `src/core/fakes/menuStores.ts`; `data/defs/visuals/credits.json` (18 sources); the Barlow family (OFL) in `public/assets/ui/fonts/` |
| f9ecee8 | The DOM kit (`src/shell/dom/kit.ts`), every screen (`src/shell/screens.ts`), the shell (`src/shell/shell.ts`, `types.ts`, `index.ts`), the camera paths (`src/camera/menuRigs.ts`: `menuEye`, `transitSample`, `transitPose`, `holdProgress`, `lookAt`), the lab `labs/shell/`, the spec `tests/browser/menu/menu.spec.ts` |
| e03342b | Requests shell-menu-1..4; tests of the leave line and the leave guard |

## 2. Public API (exact signatures)

```ts
// src/shell (imports only src/core; the host hands in everything else)
createShell(deps: ShellDeps): Shell
interface Shell {
  readonly machine: ShellMachine; readonly spawn: SpawnFlow;
  action(action: string): boolean;               // run a menu/transit action as its key would
  update(realDt: number): void;                  // every frame; text at most 10 Hz; scrim while panels move
  booted(): void; gatePassed(): void;
  transitStatus(text: string | null, holding: boolean): void;
  handOver(): void;                              // transit -> flight (control enabled)
  left(): void;                                  // reverse transit done -> hub
  openFlightMenu(): void;                        // the host calls it on the flight table's `flightMenu`
  focused(): string | null;
  hooks(): { state: string; main: string; side: readonly string[]; focus: string | null; scrimRects: number; spawn: string; practice: boolean };
  dispose(): void;
}
ShellDeps { root, canvas, defs, format: NumberFormat, keys: ShellKeys, lobby: ShellSession, practice: ShellSession | null,
  publishScrim(rects), boot(): BootProgress, snapshot(): SimSnapshot | null, capabilities(vehicleId): VehicleCapabilities | null,
  settings: SettingsHost | null, identity: IdentityHost | null, padCycleSeconds(rules): number | null,
  capacityReport(): string | null, wallNow(): number, captured(): boolean, intent(i: ShellIntent): void,
  reportError(m): void, reducedMotion?, uiScale? }            // src/shell/types.ts has every member documented
ShellIntent = context | frame (subject + free area) | transit (request, practice) | spawnAcknowledged | riseBack
            | resume | leave | capture (opt-in) | watchPad | trackShip

transition(state: ShellState, event: ShellEvent): ShellState | null      // states of ARCHITECTURE 23 + side states
createSpawnFlow(universe: UniverseCommands, stores: Pick<ClientStores, 'launchQueue' | 'link'>): SpawnFlow
  // phases idle | requesting | queued(entry, stale) | seated | refused(cause: left | lost | refused, alternative)
classOutlook(sites, padStates, vehicleClass, liveTick, rules): ClassOutlook   // pads per class, wait, cohort, horizonFull
launchesPerHour(padCount, cycleSeconds | null): number | null
rulesView(rules, fmt, formatWallDate): RulesView                              // every number a rules field
leaveOutcome(snapshot, rules, fmt): LeaveOutcome | null                        // "If you leave now" (U16)
shouldGuardUnload(snapshot): boolean                                           // the leave-guard rule (request shell-menu-2)
solarViewAt(body, latDeg, lonDeg): { localSolarHours, sunElevationDeg, phase }
loadShellFonts(baseUrl, onError): Promise<void>; scrimRectsOf(root, canvasRect, dpr, opacity): ScrimRect[]

// src/input
MENU_BINDINGS, TRANSIT_BINDINGS, MENU_ACTIONS, TRANSIT_ACTIONS, validateContextTable(table, actions): string[]
InputSystem.context; InputSystem.setContext(c: 'menu' | 'transit' | 'flight'): void

// src/camera (pure, body-fixed float64 path)
menuEye(body, radius, { altitude, sunBehindLimbDeg, t, drift }): EyePose
transitSample(plan: TransitPlan, u: number, holdAngle?): TransitSample   // position, look, altitude, exposureHint
holdProgress(plan): number; transitPose(body, sample): EyePose

// src/core/fakes
createMenuFixture(defs, opts?: MenuStoresOptions): MenuFixture   // ClientStores + UniverseCommands for every menu state
menuShipsFixture(defs, nowWallMs, rules?): ShipRecord[]
```

## 3. How to run and verify

- Unit: `npx vitest run tests/unit/shell tests/unit/fakes/menuStores.test.ts src/input tools/dev/boundaries.test.ts`
  (145 + the leave tests: all pass at e03342b).
- Lab: `/labs/shell/?governor=off&queue=free|busy|full&rules=default|staging|local&ack=<s>&refuse=1&link=<state>&admission=queued&scale=<x>&reduced=1&planet=1`.
- Browser: `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/menu --project=functional`.

## 4. Acceptance, as measured so far

(see section 7 for the browser run's result; filled when it finished)

| Line | State |
|---|---|
| Binding tables: no Ctrl/Alt/Meta, no conflicts, every action reachable in every context | MET: `tests/unit/shell/bindingTables.test.ts` (7 tests) |
| Rules screen renders default and staging with different numbers, no code change | MET (unit): `tests/unit/shell/model.test.ts` "the rules screen"; the browser screen renders the same model |
| Credits: every source and licence line on the screen | spec written (`menu.spec.ts`, test 2); see section 7 |
| Deploy flow by keyboard with a focus assertion per step; Back from every screen | spec written (tests 1 and 2); see section 7 |
| The same by mouse | NOT DONE (no mouse spec yet; hover moves the focus and every control is clickable) |
| Four resolutions | spec written (tests 5-7); see section 7 |
| Transition: motion bound, no frame >= 33 ms, HUD after the gate, holding drift, refused re-targets, night pad within 1 EV | PARTLY: the holding drift is specified (test 4); the per-frame steps are recorded (`__shell.transit().steps`) but not yet asserted against the path's own bound; no frame-time, HUD or night-exposure assertion yet; the lab has no HUD |
| Contrast >= 4.5:1 over the brightest backdrop frame | NOT DONE (no sampler yet) |
| Menu DOM main-thread <= 0.5 ms/frame; text <= 10 Hz | text refresh is held to 10 Hz in `Shell.update`; the CDP measurement is NOT DONE |
| Practice keyboard flow with requests blocked; from a simulated unreachable server | PARTLY: Practice runs through the same deploy flow on the local rules (lab); the reconnecting/offline banner offers it; no spec with blocked requests yet |
| Cold start: title with only the boot pack, progress reported, Play enabled when the hangar's data is resident | PARTLY: the title shows the host's boot steps with real counts and enables "press any key" only when `playReady`; the fixture-driven test is NOT written |
| Wave-2 flight-ui, map and audio specs; FakeSession conformance | not re-run (nothing of theirs changed except `InputSystem`, whose default context is 'flight') |

## 5. Left, in order

1. Look at every screenshot of `out/screens/shell-menu/` and iterate the look (contrast, the scrim's dim, sizes at 4K).
2. The contrast sampler (sample the brightest backdrop behind each text box; the lab can freeze the drift phase)
   and the CDP main-thread measurement (the HUD's method, `tests/browser/flight-ui/hud.perf.spec.ts`).
3. Transit assertions: per-frame camera step <= the path's own bound (|d sample/du| x du), frame times, the
   night pad's exposure within 1 EV at hand-over (the lab's `sunEvAtPad` is a first prior: replace it with the
   render core's photometric prior), a refused spawn re-targeting to the alternative (the fixture's `refuseNext`).
4. The turntable rig and the presentation-only display vessel (`assembleVessel` + `vesselPartSnapshots`), the
   exploded stage view (`splitForStage`); the spectate rig.
5. The mouse spec; the Practice spec with requests blocked; the cold-start fixture test.
6. Identity screen (`IdentityHost` exists in the deps; no screen yet) and the recovery code card.
7. Audio: buses music and comms in `AudioProbe` (LEAD NOTE 1), the UI sound set and the menu score via
   tools/audio (ElevenLabs, budget 60 USD), nothing before the first gesture.
8. The HUD and map label atlas on the shipped type (request shell-menu-4).

## 6. Decisions and why

- The shell imports only src/core (boundaries): the key tables, the number formatters, the camera and the
  render core reach it through `ShellDeps`, and what it needs done outside the DOM is a `ShellIntent`.
- The launch queue is not a state of the machine: it lives in the spawn flow and shows on the pad screen and the
  briefing. A commit starts the transit at once (frontend-ux 5.10); if the request is queued during the transit the
  camera rises back and the briefing shows the queue (`waitForPad`); when the queue seats it, `depart` starts the
  transit from any deploy screen.
- The HUD's visual language (src/core/ui/theme.ts colours, the unit `min(1vh, 0.5625vw)`), not the research's
  amber: the brief says match the HUD.
- A vehicle whose pad class nothing states (no `VehicleCapabilities`, no `padInterface`: the case of
  meridian-lunar today) is treated as the LARGEST class, and the screen says "assumed".
- Launches per hour need a rules field (request shell-menu-1); until it exists the pad screen states the pad count
  and the wait per class and omits the rate.
- Practice in the lab is the menu fixture on the local rules (its own pads, never queuing); the real switch to a
  `LocalSession` is session-switch's (the World session has no `universe`/`stores` yet).

## 7. Browser run

(filled below when the run finishes)
