# sim-core-v2: hand-off

Work package `sim-core-v2` of `docs/WORK_PACKAGES_V2.json` (wave 3.1; MIGRATION_V2 steps 3.1-3.6).
This file is a running log first; the sections below it are filled as each step lands.

## Running log

- 2026-11-12 00:40 start. Tree at 6f012fe plus other agents' uncommitted work (cockpit, atmosphere,
  hand-offs). No earlier work of this package in the tree. Reading the brief's documents.
- 00:50-01:15 step 1 (tick grid): the clock, the tools, the scenarios re-captured. First comparison with
  `baseline-v1.json`: the brief's 1e-6 / 1 s tolerance is missed from the first staging on. Control flights
  of the unmodified v1 `sim.ts` (from `git show`) with only the start shifted show the same misses: the
  scripted pilot's 30 Hz decisions make the flight a chaotic function of its start. Reported to the lead;
  request `sim-core-v2-1`. Lead decision: judge the step by same-start equality, rails equivalence, the
  mission's gates and an envelope of v1 control flights (the baseline's checker got those modes in 431930f).
- 01:15 step 1 complete: reference and controls recorded from the v1 clock, three mission assertions and two
  unit test files added, golden hash re-baselined (1 of 2 in this package): `b850b94ea2dcc1a5`.
- The coordinator also assigned: requests `flight-ui-6` (Mach in vacuum), `flight-ui-8` (stale stage
  thrust-to-weight after an SOI change on rails) and the sim share of `app-integration-13`; each after the
  tick-grid step, as its own small commit.

- 01:20 requests `flight-ui-6` (2fbbae6) and `flight-ui-8` (af1f292) resolved, each with a test, the mission
  hash unchanged; the sim share of `app-integration-13` measured and answered in the request (d1312c6): the
  5.5 ms of the lift-off step are 85 % first execution of that code path (0.6-0.7 ms warm); a rehearsal at
  load is planned after the vessel-model step.
- 01:35 step 2 complete: the trajectory guard recorded (mission: 400 samples; six unit fixtures) and asserted.

- 02:10 step 3 complete: the craft model. The mission state hash did not change (`b850b94ea2dcc1a5`), the
  trajectory guard and the six fixtures are bit-identical.

- 03:00 step 4 complete: the state is whole and versioned; golden re-baseline 2 of this package:
  `7da3ffe86c85228d` (reproduced on a second run; guard and fixtures bit-identical before and after).

## Step 1: the tick grid (MIGRATION_V2 3.1)

### What changed

- `src/sim/clock.ts` (new): `TICKS_PER_SECOND`, `TICK_EPSILON` (1e-3 tick), `utOfTick`, `isTickInstant`,
  `tickOfInstant(ut, what)` (throws for an off-grid instant), `nearestTick`, `ceilTick`, `floorTick`,
  `snapToTick`, `secondsOfTicks`.
- `src/sim/world/sim.ts`: the clock is `clockTick` (an integer); `ut = clockTick / 120` everywhere.
  - A scenario whose `startUt` is not a whole tick is refused by name (`scenarios/<id>.json: startUt ...`).
  - A physics step is one tick. A rails advance lands on **the first whole tick at or after** the instant
    v1 would have landed on: the requested time, or the next event (warp event or the atmosphere / impact
    event of a vessel in the bubble). An event inside the tick is processed at its own float instant: a
    sphere-of-influence change is handed over at the crossing and the new conic is then evaluated at the
    landing tick.
  - A vessel leaves rails for the atmosphere or an impact **at a grid tick by an exact Kepler evaluation
    there** (ARCHITECTURE 7.3). v1 used the state at the event instant, which was exact only because v1
    landed on that instant; a physics step that crossed the event carried a sub-step time slip, which is
    gone.
  - The reduced tier keeps its state time as a tick (`reducedTick`, 60 ticks per step); a vessel's birth is
    a tick (`bornTick`; `Vessel.age` is whole ticks / 120).
  - `debug.setUt` lands on the nearest tick.
  - The real-time loop (`advance`) on rails: presentation time moves on by exactly the warped frame time,
    the state lands on the first tick at or after it, and the rest of that tick is the presentation lag
    (the same rule as after physics steps). v1 landed on the float instant with no lag. Without the carry a
    144 Hz display at 5x would alternate 4 and 5 ticks per frame in what it shows; with it `SimSnapshot.ut`
    is continuous (tested at 60, 144, 240 and 37.3 Hz).
  - The clock base (`baseTick`: the scenario start, the last rails landing, or `debug.setUt`) is unchanged
    in kind from v1: body orientations and the rails time of flight of a step are "at the base plus whole
    steps". **It is state**: the orientation at a tick depends on it in the last bits. `island-core` must
    carry it (and re-base at the same ticks) to stay bit-exact with the trajectory guard.
  - `SimSnapshot.tick` is still the count of steps and rails advances (private field renamed `revision`).
- `tools/sim/findStartTime.ts` snaps every candidate start to the nearest tick and writes `startTick`;
  `tools/sim/start-time.json` regenerated with the recorded arguments (`--launch-kind either`): the same
  window, start 938240818.8416667 (tick 112588898261), 2.004 ms after the v1 start; launch delay 599.998 s.
- `tools/sim/qaScenarios.ts`: the `qa-entry` start (five minutes before the interface) is the last whole
  tick not after that instant; the other captures are control-tick times, which are ticks.
- `data/defs/scenarios/lunar-direct.json` (start) and the eight `qa-*.json` (re-captured from the tick-grid
  flight with `tools/sim/captureScenarios.ts`).
- Tests adjusted to the rule, none loosened in substance: `rails.test.ts` (a revolution ends on the tick at
  or after the period; closure measured back along the velocity), `warp.test.ts` (an advance stops on the
  tick that holds the event), `scenario.test.ts` and `startTime.test.ts` (the launch is 600 s after the start
  to half a tick).

### How the step is judged (lead decision, `docs/requests/sim-core-v2-1.md`)

The brief's tolerance against `tests/mission/baseline-v1.json` (elements 1e-6, event times 1 s) is **not
met and cannot be met** by any flight on a moved clock. Measured: the unmodified v1 code reproduces the
baseline bit for bit from the unshifted start, and with only its start moved by 2 ms it differs by 4.8e-5
in da/a at EARTH_ORBIT and by 47 s at the lunar touchdown. The lead replaced the tolerance by four checks.

**1. Same-start equality.** `tests/mission/reference-v1-aligned.json` is the ascent of the v1 clock
(`src/sim/world/sim.ts` of 6f012fe, run from `git show`) from the tick-aligned start: the six milestones up
to EARTH_ORBIT and the first control tick at or after every 30 s of mission time (25 states). It was
recorded twice and reproduced byte for byte; it cannot be recorded again. The tick-grid flight against it
(`node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/referenceFlight.ts`; asserted by
`tests/mission/full-mission.test.ts`, "same-start equality"):

| State | dt event, s | da/a | de | di, rad | dLAN, rad | dE/E | dh/h | dm/m | d altitude, m | d position, m |
|---|---|---|---|---|---|---|---|---|---|---|
| LIFTOFF | 1.9e-5 | 4.4e-16 | 0 | 6.7e-16 | 1.4e-9 | 3.6e-16 | 5.1e-16 | 0 | -1.9e-9 | 8.2e-3 |
| MAX_Q | 1.9e-5 | 8.5e-14 | 1.8e-13 | 1.2e-12 | 1.3e-9 | 8.5e-14 | 1.3e-11 | 0 | 2.0e-8 | 8.3e-3 |
| STAGE_SEP_1 | 1.9e-5 | 1.4e-12 | 8.2e-12 | 2.6e-11 | 1.6e-9 | 1.4e-12 | 4.8e-11 | 0 | 6.0e-8 | 8.3e-3 |
| FAIRING_JETTISON | 1.9e-5 | 8.1e-13 | 2.1e-13 | 2.7e-11 | 1.6e-9 | 8.1e-13 | 1.5e-12 | 0 | 1.6e-6 | 8.4e-3 |
| T+300 (worst sample) | 1.9e-5 | 6.0e-11 | 1.1e-10 | 2.0e-9 | 7.7e-9 | 6.0e-11 | 2.9e-10 | 0 | 9.0e-7 | 8.3e-3 |
| STAGE_SEP_2 | 1.9e-5 | 5.0e-10 | 4.6e-10 | 8.1e-12 | 2.4e-11 | 5.0e-10 | 2.5e-10 | 3.8e-16 | -7.5e-9 | 7.8e-3 |
| EARTH_ORBIT | 1.9e-5 | 5.0e-10 | 4.6e-10 | 8.1e-12 | 2.4e-11 | 5.0e-10 | 2.5e-10 | 3.8e-16 | -7.5e-9 | 7.8e-3 |

Every one of the 25 states is at the same control tick and about the same body in both flights. Worst over
all 25: a, e, energy, h within 5.0e-10; mass 3.8e-16; altitude 1.9e-6 m. **Outside the 1e-9 the decision
names**: the plane angles (i 2.0e-9 rad, LAN 7.7e-9 rad) and a constant 18.6 microseconds in every event
time. Cause, measured from the reference's capture times: the v1 clock summed float instants while it
warped on the pad and lifted off 18.6 microseconds before the whole tick; the Earth turns 1.4e-9 rad in
that time (the LAN difference at lift-off, and 8 mm of inertial position at equal mission time), and
closed-loop steering carries it into the plane angles for a while. The test holds a, e, energy, h to 1e-9,
i and LAN to 1e-8 rad, event times to 1e-4 s, mass to 1e-12, altitude to 0.1 mm, position to 5 cm.

After EARTH_ORBIT the two clocks part: v1 landed its rails advances on float instants, the tick grid lands
on ticks, so the pilot's control ticks have another phase from the parking-orbit warp on.

**2. Rails equivalence.** `src/sim/orbit` is untouched by the step (`git diff 6f012fe -- src/sim/orbit` is
empty); only the landing instants moved. From the state of each of the six coast milestones of the baseline
(EARTH_ORBIT, TLI_COMPLETE, MOON_SOI_ENTER, LUNAR_ORBIT, MOON_SOI_EXIT, EARTH_PERIGEE_TARGETED), rails
advances to five later instants each land on ticks and give the conic evaluated at that tick with 0 m and
0 m/s difference (30 landings; `tests/unit/sim-world/railsEquivalence.test.ts`). One-off measurement against
the v1 clock itself, asked for the same tick instants from the same six states (+1/120 s, 10 s, 100 s,
1,000 s, 1 h, 3 h): **36 of 36 landings bit-identical in position and velocity**.

**3. The mission's own gates** on the tick grid: `npm run test:mission` passes, 5 files, 34 tests (the 31 of
before plus the three of this step), no gate or tolerance loosened; run twice. From the mission log of the
second run: touchdown 1.18 m from the target on level 12 of 12, 1.00 m/s down, tilt 0.36 deg; Moon SOI entry
0.000 s from the time predicted an hour before; parking-orbit revolution on rails 0.870 mm from Kepler;
entry interface 122.0 km at 11.010 km/s, peak 5.97 g; splashdown 15.53 N, -141.68 E in "Central Pacific"
at 7.82 m/s; 7.88 days; cheatCounter 0; zero incomplete terrain queries; perturbed starts (launch 60 s
late, 3 % engine under-performance, sloppy pitch programme), the entry corridor, the ascent and the browser
loop all pass.

**4. Envelope.** `tests/mission/controls-v1.json` holds four flights of the unmodified v1 code with only
the start shifted (+2.004 ms, +8.333 ms, -5 ms, +16.667 ms), as mission records in the baseline's format.
Differences from `baseline-v1.json` in event mission time and da/a; allowed = twice the largest among the
controls, with floors of one control tick and 1e-12 (`tools/dev/mission-baseline.ts`,
`npx tsx tools/dev/record-mission-baseline.ts --envelope <record> --controls tests/mission/controls-v1.json`;
asserted by `tests/mission/full-mission.test.ts`, "envelope"):

| Milestone | Flight: dt, s | Flight: da/a | Controls dt, s (+2.004 ms, +8.333 ms, -5 ms, +16.667 ms) | Controls: largest da/a | Allowed dt, s | Allowed da/a | Inside |
|---|---|---|---|---|---|---|---|
| LIFTOFF | -0.017 | 4.4e-16 | -0.017, -0.017, 0.000, -0.017 | 4.4e-16 | 0.033 | 1.0e-12 | yes |
| MAX_Q | -0.017 | 9.3e-14 | -0.017, -0.017, 0.000, -0.017 | 1.6e-14 | 0.033 | 1.0e-12 | yes |
| STAGE_SEP_1 | 0.017 | 5.3e-5 | 0.017, 0.017, 0.000, 0.017 | 5.3e-5 | 0.033 | 1.1e-4 | yes |
| FAIRING_JETTISON | -0.017 | 4.5e-5 | -0.017, -0.017, 0.000, -0.017 | 4.5e-5 | 0.033 | 9.1e-5 | yes |
| STAGE_SEP_2 | -0.050 | 4.8e-5 | -0.050, -0.050, 0.000, -0.050 | 4.9e-5 | 0.100 | 9.7e-5 | yes |
| EARTH_ORBIT | -0.050 | 4.8e-5 | -0.050, -0.050, 0.000, -0.050 | 4.9e-5 | 0.100 | 9.7e-5 | yes |
| TLI_COMPLETE | -0.600 | 1.8e-3 | -0.600, -0.617, -0.050, -0.667 | 2.7e-3 | 1.333 | 5.4e-3 | yes |
| MOON_SOI_ENTER | -8.177 | 2.2e-4 | -12.809, -12.905, -111.583, -24.181 | 1.4e-3 | 223.166 | 2.8e-3 | yes |
| LUNAR_ORBIT | -6.889 | 4.7e-3 | -12.659, -12.771, -134.550, -26.631 | 4.8e-3 | 269.100 | 9.6e-3 | yes |
| LUNAR_TOUCHDOWN | 52.028 | 1.2e-8 | 46.807, 47.112, -75.225, 32.644 | 2.3e-8 | 150.450 | 4.5e-8 | yes |
| LUNAR_LIFTOFF | 52.011 | 2.7e-7 | 46.816, 47.120, -75.208, 32.677 | 2.5e-6 | 150.416 | 5.0e-6 | yes |
| MOON_SOI_EXIT | 24.731 | 1.3e-3 | 83.637, 59.709, -103.209, 53.087 | 1.4e-3 | 206.418 | 2.9e-3 | yes |
| EARTH_PERIGEE_TARGETED | -518.863 | 1.2e-3 | -459.963, 59.642, -646.809, -490.513 | 1.6e-3 | 1293.618 | 3.2e-3 | yes |
| ENTRY_INTERFACE | 9.512 | 9.8e-4 | 14.820, 12.984, 0.608, 78.645 | 8.1e-3 | 157.290 | 1.6e-2 | yes |
| DROGUE_DEPLOY | 7.470 | 5.3e-7 | 14.587, 16.209, -0.976, 77.820 | 1.8e-5 | 155.640 | 3.6e-5 | yes |
| MAIN_DEPLOY | 7.437 | 2.8e-6 | 14.620, 16.209, -0.942, 77.853 | 4.6e-6 | 155.707 | 9.2e-6 | yes |
| SPLASHDOWN | 8.145 | 2.8e-6 | 15.278, 16.801, -1.051, 78.337 | 4.7e-6 | 156.673 | 9.4e-6 | yes |

All 17 inside. The flights for the record:

| Flight | State hash | Steps | Rails advances | Control ticks | Simulated, s |
|---|---|---|---|---|---|
| v1 code, unshifted (reproduces the baseline; every field equal) | 3f3a131cdd88eba7 | 593,636 | 65,725 | 214,135 | 680,497.163 |
| v1 code, start +2.004 ms | 92644e46ed60d0df | 596,252 | 65,687 | 214,751 | 680,512.449 |
| v1 code, start +8.333 ms | 978dd696ca17f6c7 | 597,220 | 65,661 | 214,967 | 680,513.972 |
| v1 code, start -5 ms | 891d6311dc1b2037 | 595,136 | 65,644 | 214,429 | 680,496.121 |
| v1 code, start +16.667 ms | 8dce8b2af6987bdf | 604,932 | 66,867 | 218,101 | 680,575.483 |
| **tick grid** | **b850b94ea2dcc1a5** | 596,092 | 65,696 | 214,720 | 680,505.300 |

The touchdown is 1.90 m from the baseline's touchdown point (the decision's 50 m), the splashdown in the
baseline's recovery zone.

### Golden hash

Re-baseline 1 of this package: **`b850b94ea2dcc1a5`**, 596,092 steps (`tests/mission/golden.json`; before:
`3f3a131cdd88eba7`, 593,636 steps). Recorded with `MISSION_UPDATE_GOLDEN=1`, reproduced by a second run
without it (pilot = replay on late tile I/O = golden).

### Tests of the step

- `tests/unit/sim-world/tickGrid.test.ts` (9): the helpers at mission epochs; every scenario of the library
  starts on a tick and the mission at the tick of `start-time.json`; an off-grid start is refused by name; a
  step is a tick; float requests land on the first tick at or after them, on the conic; a
  sphere-of-influence change keeps its float instant inside the landing tick and is continuous through the
  hand-over (0.05 m against the old conic seen from the new body); a vessel leaves rails for the atmosphere
  at a tick, less than one tick below the top, exactly on its conic; `debug.setUt`; the real-time loop at
  60, 144, 240 and 37.3 Hz.
- `tests/unit/sim-world/railsEquivalence.test.ts` (1): above.
- `tests/mission/full-mission.test.ts`: "the clock is on the tick grid" (all 214,720 control ticks, 65,696
  of them rails landings), "same-start equality", "envelope".
- Suites after the step: the brief's unit set (`src/sim src/core/defs src/terrain tests/unit/sim-vessel
  tests/unit/sim-world tests/unit/sim-orbits tests/unit/terrain-core tools/dev`): 53 files, 551 tests, all
  pass (terrain guard and boundaries included); `npm run test:mission`: 34 of 34, twice.

## Step 2: the trajectory guard (MIGRATION_V2 3.2)

Recorded once on the tick-grid tree (commit of this step; the state hash of the flight was
`b850b94ea2dcc1a5`). **Never re-record it**: both recorders refuse to overwrite a recording. What may be
adapted when ids, the snapshot or the vessel API change is how a vessel is found or driven, never a number.

### The mission: `tests/mission/trajectory-guard.json` (`tools/sim/trajectoryGuard.ts`)

- **Attended craft**, bit for bit: at 400 control ticks of `lunar-direct` (the control tick that first sees
  each milestone, 15 ticks for the 17 milestones because two pairs share a tick, and 385 spread evenly
  over the 214,720 control ticks; 228 about the Earth, 172 about the Moon) the universe tick, the SOI body
  and the body-centred position, velocity, attitude and mass as float64 bit patterns.
- **The clamp vessel**, bit for bit: at the same ticks the first vessel the craft shed (found by role: the
  vessel beside the active one when the snapshot first holds two), in 395 of the 400 samples. It is the weld
  of the four released clamp pieces (`mergeVessels`), held on the ground and riding the rotating Earth.
- **Debris by fate**, within 2 s and 500 m: 10 removed vessels (M-1, the escape tower, four fairing panels
  into the sea; M-3 into the Moon; the ascent stage and its engine burnt up; the apex cover into the sea)
  with reason, time, body and sub-point, and 3 survivors (the clamps landed on Earth, M-2 in orbit, the
  descent stage landed on the Moon) with body, situation and state; a survivor in flight is compared by
  orbit (semi-major axis and periapsis within 500 m, plane within 1e-4 rad). Vessels are paired by name.
- The recorder flew three times (one to count the ticks, two that had to give the identical file).
- Asserted by `tests/mission/full-mission.test.ts` ("trajectory guard: ...", two tests) on the flight the
  suite flies anyway; `node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/trajectoryGuard.ts` compares
  alone (one flight, exit 1 on a difference, the first difference in words).

### The vessel dynamics: `tests/unit/sim-vessel/trajectory-fixtures/`

Six scripted flights of `stepVessel` on the analytic environments of `tests/unit/sim-vessel/helpers.ts`
(no world, no pilot), every vessel of each flight at fixed steps (position, velocity, attitude, body rate
and mass as bit patterns, part count, hold, destroyed) and every event type with its step:

| Fixture | What it flies | Steps | Samples | Vessels |
|---|---|---|---|---|
| `ascent` | the stack from the pad of a rotating Earth: ignition, clamp release (the weld), 130 s of the pitch programme through max-q | 15,600 | 66 | 2 |
| `staging` | first-stage separation with retro and ullage motors, tower and fairing jettison, second-stage separation; 12 s each | 4,320 | 75 | 2 + 6 + 2 |
| `entry` | the capsule from 122 km at 11 km/s and -6.5 deg, shield first on SAS with thrusters, lift banked 60 deg, 300 s: heating, ablation, peak load | 36,000 | 76 | 1 |
| `touchdown` | the lander at touchdown mass on its legs onto an 8 deg slope of a rotating Moon at about 1.5 m/s, to sleep | 2,400 | 81 | 1 |
| `splashdown` | the capsule from 7 km: drogues, mains, a sea with a running swell, afloat | 72,000 | 102 | 2 |
| `lunar-ascent` | the landed stack on a rotating Moon: rest, the ascent stage leaves the descent stage, 45 s of climb | 6,360 | 107 | 2 |

`trajectory-fixtures.test.ts` (7 tests) flies them again and compares bit for bit, naming the first
difference; one test proves that a single flipped bit is found. `record.ts` flew each fixture twice before
writing it. **The fixtures are defined by `fixtures.ts`, `../helpers.ts` (`makeEnv`) and `../scenarios.ts`
together with `data/defs` (parts, `meridian-lunar`)**: a change to the analytic environment or to those
definitions moves the numbers as surely as a change of the physics (MIGRATION_V2 already keeps
`meridian-lunar.json` byte-identical through wave 4).

## Step 3: the vessel model (MIGRATION_V2 3.3)

### What a vessel is now (`src/sim/vessel/types.ts`)

```ts
interface CraftRuntime {
  craftId: string; vehicleId: string; vehicle: VehicleDef;
  ownerId: string | null; name: string; joinedTick: number;
  nextStage: number; stageLockout: number; pending: PendingAction[]; sinceStaging: number;
  policy: LendPolicy;                       // src/core/contracts/net.ts
}
interface DockLink { a: number; b: number; roll: number }   // part indices of the two port parts
interface CommandRuntime {                  // on every part with a command module
  module: number; crew: { seat: string; name: string }[]; cockpit: string | null; cameraSeat: string | null;
  sensorCamera: { pos; lookDir; upDir } | null; remote: boolean;
}
interface PartRuntime { craft: number; command: CommandRuntime | null; ... }
interface Vessel {
  id: string; name: string;
  crafts: CraftRuntime[];                   // base craft first; length 1 for anything that never docked
  links: DockLink[];
  helm: { accountId: string | null; craft: number; controlPart: number };
  parts: PartRuntime[];                     // a forest: each craft its own tree and root
  ...                                       // vehicleId, vehicle, nextStage, stageLockout, pending, sinceStaging are gone
}
```

- **Per craft**: stage stack, lockout, pending queue, seconds since staging, the abort sequence (the craft's
  vehicle). `fireNextStage(vessel, env, craft = vessel.helm.craft)`, `abort(vessel, env, craft?)`,
  `nextLiveStage(vessel, craft?)`, `stagingInfo(vessel, env, craft?)`, `applyStageInstant(vessel, stage, craft?)`,
  `executeAction(vessel, craft: CraftRuntime, action, stageIndex, ctx)`: a press acts on one craft's stack and
  only on that craft's parts. `helmCraft(vessel)`, `anyPending(vessel)`.
- **Flow group = (craft, stage group)**: `tanksFor` in `structure.ts`, the staging-info model in `facade.ts`.
  Docking pools nothing. A fairing shields parts of its own craft only.
- **The command part** carries crew, cockpit id, camera seat, sensor camera and the remote flag
  (`PartRuntime.command`), copied by the assembler from `VehicleDef.crew`, `.cockpit` and `.cameras.cockpit`
  (a `command.cockpit` of the part definition wins). Seats and hatch are read from the definition.
- **Ids** (`src/sim/vessel/ids.ts`): `CraftIdSource { next(vehicleId): string }`, injected
  (`createSim(defs, scenario, { terrain, ids? })`, `assembleVessel(defs, vehicleId, { stagesAlreadyFired?, craft? })`
  with `craft: { craftId?, ownerId?, name?, joinedTick?, policy? }`). `seededCraftIds(seed = '')` is the local
  universe's counter: the first craft of a vehicle is `<seed><vehicleId>`, the n-th `<seed><vehicleId>-<n>`.
  Vessel ids follow ARCHITECTURE section 3: the craft id for a whole single craft, `<craftId>~<instance id of
  the piece's first part>` for a piece without the craft's root, `a~<lower vessel id>~<tick>` for two or more
  craft (kept while craft join; of the multi-craft pieces of a split the one with the most craft, tie the
  lowest craft id, keeps it; the others are `a~<their lowest craft id>~<tick>`). `partKey(craftId, instanceId)`
  = `craftId/instanceId`; `partKeyOf(vessel, index)`, `findPartByKey(vessel, key)` (a bare instance id is
  accepted only when unambiguous), `findCraftPart(vessel, craft, instanceId)`, `assemblyId`, `isAssemblyId`.
- **`separateVessel`** computes the connected components over tree edges AND links (union-find; same order
  of pieces and parts as before for a tree). Each piece lists the craft whose parts it has; the live craft
  record stays with the piece that holds the craft's root part, the others carry a copy with an empty
  queue; delayed actions go to the piece that holds their parts; the helm stays with the piece that holds
  its control part, every other piece gets a vacant helm on its first craft with a command part.
- **Pre-mated dock nodes are links**: a placement whose `node` and `parentNode` are both attach nodes of
  kind `dock` becomes a `DockLink` and the child a root of its own tree. The stage action `undock` releases
  every link of the named port part (spring impulse from `DockingPortModuleDef.undockImpulse`, read
  structurally until the lead joins that module type to `ModuleDef`).
- **Dock merge, added** (`src/sim/vessel/dock.ts`): `dockMerge(base, other, basePort, otherPort, tick, pose?)`.
  Linear momentum of both fixes the velocity of the new centre of mass; angular momentum about it (spin and
  orbital terms m (c_i - c) x (v_i - v)) fixes `w = I^-1 L` through the merged inertia tensor; no tree is
  re-rooted; the craft of `other` are appended with `joinedTick = tick`; base helm, SAS and name stay.
  By default the two are joined in the pose they have; `pose` (for example `snapPose(base, other, a, b)`,
  which puts the two port faces exactly on each other) replaces it. `dockBase(a, b)` (the heavier, tie the
  lower id), `addLink(vessel, a, b)` (a ring closes), `undock(vessel, link, impulse, ctx)` (the spring acts
  at the port: `dv = J/m`, `dw = I^-1 (r x J)`; emits `undocked` with part keys), `momentumOf`,
  `combinedMomentum`, `applyImpulseAt`, `dockFace`.
- **`mergeVessels` is kept** as the weld of the released clamp pieces into one held ground structure. It
  refuses two different craft. The clamp vessel of the mission is in the trajectory guard (395 samples).
- `src/sim/vessel/public.ts` keeps its signatures (`assembleVessel` gained the optional `craft` option).

### Acceptance (measured; `tests/unit/sim-vessel/crafts.test.ts`, 15 tests, with `dockingFixtures.ts`: a
synthetic port part and the test vehicles ferry, hub and tandem built from library parts)

| Criterion | Result |
|---|---|
| Merge then split of two craft restores every part pose to 1e-9 m | 3.6e-15 m near the origin, 0 m at an orbital radius of 6,560 km (float64 resolves 9.3e-10 m there); axes within 5.1e-16. Second craft rolled 0.6435 rad about the port axis, both with their own velocity and spin |
| Linear momentum to 1e-6 relative | 1.4e-16 and 2.7e-16 through merge and split; the merge alone below 1e-12 |
| Angular momentum to 1e-9 relative | 2.4e-12 and 1.2e-11 through merge and split |
| A ring of three links splits correctly | the first release separates nothing (links 3 to 2, id, parts and momentum unchanged, `undocked` with no new vessel); the second splits one craft off and the two that are still linked keep the assembly id |
| Two craft of the same vehicle fire only their own stages | craft 1 fires: its engine (same instance id `engine` as craft 0's) lights, craft 0's does not; under throttle only craft 1's tank drains; its second stage drops its own service module as `ferry-b~sep` carrying a copy of the craft record with its owner |
| Ids unique and deterministic through dock, base-craft undock and re-dock | `a~test-hub~100` at the first dock, kept when a third craft joins; the base craft undocks as `test-hub`, the rest keeps the assembly id; re-dock keeps it; full separation gives the three craft ids; identical in a second run |
| Trajectory guard bit-identical (attended craft, six fixtures, clamp vessel) | yes: 400 of 400 samples, debris 0 s and 0 m; the six fixtures bit for bit |
| Mission | 36 of 36; state hash `b850b94ea2dcc1a5` UNCHANGED by this step (the hash reads the base craft's stage state where it read the vessel's; an assembly's hash also covers every craft, the links and the helm) |

Also tested: a chain of four cut in the middle (tie of two craft each: `a~hub-a~100` stays with the lower
craft id, the other piece is `a~hub-c~900`), `snapPose` (faces coincide to 1e-12 m from a 5 mm, 0.08 deg
residual), the undock spring (600 N s: 3-20 cm/s along the port axis, both momenta conserved to 1e-9), a
pre-mated pair released by the stage action, the command part's crew and cockpit, part keys, the hash of
an assembly.

### Limits of this step (stated, not hidden)

- **Events name parts by instance id in a vessel of one craft and by part key in a vessel of several**
  (`eventPartId` in `ids.ts`, the one place that decides). Every v1 consumer matches `partId` against
  `PartSnapshot.instanceId`, so a key there now would break the presentation before its sweep. After the
  sweep the function can return the key always (see "Contract changes requested").
- **The control frame is still VES.** `helm.controlPart` is state (set to the craft's first command part,
  moved by splits and merges), but control inputs and the SAS still refer to the VES axes of `parts[0]`.
  Control-from-here is `contact-docking`'s; for every vessel that exists today the two frames coincide.
- **Lend policies are data only**: the allocation does not yet exclude a docked craft's actuators (docked
  free drift is `contact-docking`'s). `dockMerge` takes any two port parts the caller names; envelopes,
  port states, soft capture and the strength of a docked joint are the island's and `contact-docking`'s.
- A split of a vessel of ONE craft leaves the inherited throttle lever on the pieces for the one step until
  they are stepped with their own (neutral) controls, exactly as before; pieces of an ASSEMBLY that the helm
  did not go with have it closed at once.
- The id of the identity-keeping piece of a single craft is kept even when its root part was destroyed
  (v1 behaviour; no other piece can claim that id).

## Step 4: state is whole and versioned (MIGRATION_V2 3.4)

### State that left the structure cache

`Vessel.carried: { probes: ProbeState[]; buoyWet: boolean[]; wake: number[] } | null` (`types.ts`): per contact
probe the touching flag, the wet flag and the friction anchor in the body-fixed frame; per buoyancy sphere
whether it is under water; per thermal entry the wake factor. The lists are in the order of the structure
(`probes`: the structural probes, then the feet of each leg set). `Structure` holds no state of its own any
more: each `Probe` points at its `ProbeState` (`pr.s`), `st.carried` is the vessel's object.
`invalidateStructure(vessel)` (every change of the part set: split, weld, dock, crew loss) marks the cache
stale and starts the carried state afresh, exactly where v1 lost it with the cache; a copy (`cloneVessel`)
and the codec carry it, and a rebuilt structure ties itself to a carried state of its own lengths.

### The codec (`src/sim/vessel/codec.ts`)

```ts
encodeVessel(vessel, { defsHash: string; refs?: VehicleRefSource; version?: number }): Uint8Array
decodeVessel(bytes, { resolver: DefResolver; migrations?: MigrationRegistry }): { vessel: Vessel; report: DecodeReport }
stateHash(vessel, refs?: VehicleRefSource): string            // hash of the codec BODY; vesselStateHash(vessel) is this
readHeader(bytes): { version: number; defsHash: string; bodyAt: number }
libraryResolver(defs): DefResolver & VehicleRefSource           // library vehicles by reference, any other design embedded
partFingerprint(def): string;  vehicleHash(vehicle): string;  contentHash(x): string;  hashBytes(bytes): string
interface DefResolver { vehicle(ref: { kind: 'library'; id; hash }): VehicleDef | null; part(defId): PartDef | null }
type VehicleRef = { kind: 'library'; id: string; hash: string } | { kind: 'embedded'; design: VehicleDef }
interface DecodeReport { version; defsHash; unknownBlocks: number[]; migrated: {...}[]; vehicleChanged: {...}[] }
class VesselDecodeError extends Error { problem: 'format' | 'version' | 'vehicle' | 'part' | 'fingerprint' | 'block' }
CODEC_VERSION = 2;  CODEC_VERSIONS_READ = [1, 2]
```

- **Layout**: magic `FSPV`, u16 version, the `defsHash` string; then tagged, length-prefixed blocks
  (STRINGS, DEFS, CRAFTS, VESSEL, PARTS, CARRIED) and an end tag. Every part is a length-prefixed record
  whose resource block and module blocks are length-prefixed in turn; a module block is the module's state
  and run-time record in a self-describing plain-data form (keys by string reference).
- **Exact**: vectors and attitudes as raw float64; scalars in a tagged shortest-exact form (+0, -0, NaN,
  +Infinity, -Infinity, small integers, float32-exact values, raw float64). Tested with 22 awkward values in
  every encoding.
- **Definitions through the resolver, never by indexing a library**: a craft's vehicle is a library id plus
  the content hash of that `VehicleDef`, or the embedded design; a part's definition is its id plus its
  FINGERPRINT (dry mass, resources, modules, number of thermal surfaces).
- **Version 1** wrote the carried probe states as one flag byte per probe, **version 2** writes three bit
  sets; both are read.
- **The state hash is the hash of the body**: it does not depend on `defsHash`, so a change of an unrelated
  definition does not move the golden hash; it does depend on the fingerprints of the parts in use and on
  the content hash of each craft's vehicle. **For `fleet-data`: a change of `meridian-lunar.json` or of the
  modules, resources or mass of one of its parts moves the mission's golden hash** (MIGRATION_V2 keeps that
  vehicle byte-identical through wave 4).

### The migration registry (`src/sim/vessel/migrations/index.ts`)

`MigrationRegistry(list)` with `path(defId, from, to)`; `PartMigration { defId, from, to, describe,
migrate(saved: SavedPart, def: PartDef): SavedPart }` (pure; `SavedPart` is the part's resources, module
states and surface temperatures as plain data, independent of the current definition); the helpers
`fitResources` (amounts clamped to the new capacities, a new tank empty, a retired one dropped),
`insertModule`, `dropModule`, `fitSurfaces`. Decode runs the chain from the written fingerprint to the
current one, then checks every block against the definition, recomputes the mass properties and starts
the carried state afresh. A fingerprint with no way to the current one is refused naming the part.
`MIGRATIONS` (the released ones) is empty: no definition has changed since the first blob.
**Rule for every later package that edits a part definition's modules, resources or mass: add the entry;
the corpus test fails until it exists.**

### The corpus (`tests/unit/sim-vessel/codec-corpus/`)

Twelve blobs: the six scenes of `tests/unit/sim-vessel/codecScenes.ts`, each written by codec version 1 and
by version 2, with `corpus.json` (file, scene, version, library hash, bytes, parts, the state hash of the
vessel that was written). `codec.test.ts` decodes every one and compares the hash. `record.ts` adds
missing entries and never rewrites one.

### The cheap copy (`src/sim/vessel/capture.ts`)

`captureVessel(vessel): VesselCapture`, `restoreVessel(vessel, capture)`: while the vessel has the part set
of the capture the state is written back into its own objects and the structure cache is kept; after a
structural change since the capture the vessel takes the captured part set. The capture is not consumed.

### Acceptance (measured; `tests/unit/sim-vessel/codec.test.ts`, 16 tests)

| Scene | Parts | Bytes (v2) | Bytes (v1) | State hash equal at load | Re-encoding identical | Bit-identical after 6,000 steps |
|---|---|---|---|---|---|---|
| lander 60 steps into a touchdown on an 8 deg slope | 9 | 2,948 | 3,018 | yes | yes | yes |
| lander 150 steps into the touchdown | 9 | 2,950 | 3,020 | yes | yes | yes |
| capsule at peak heating (SAS, thrusters, ablating) | 2 | 1,688 | 1,699 | yes | yes | yes |
| stack mid-staging (decoupling and ignition queued, separation motors burning) | 38 | 8,219 | 8,548 | yes | yes | yes (through the separation) |
| coasting ascent stage and capsule, tumbling | 5 | 2,205 | 2,242 | yes | yes | yes |
| the 38-part stack in ascent, nine engines burning | 38 | **8,197** (target under 9,000) | 8,526 | yes | yes | yes |

(Bytes with a 12-character library hash in the header; decode takes 0.2-0.6 ms.)

| Criterion | Result |
|---|---|
| A fixture written by codec version N-1 decodes | the six version-1 blobs of the corpus decode to the recorded state hashes; the version-1 lander mid-touchdown flies on for 6,000 steps exactly as the vessel it was written from, friction anchors included |
| A fixture written under a changed PartDef decodes through the registry | a tank resized (amount clamped from above 1,000 kg to 1,000) and a module added (a second light, neutral): both migrations reported, mass recomputed (more than 100 kg lighter), the vessel flies on; without the entries the decode is refused naming the part and both fingerprints; a chain of two migrations runs in order; a gap is a refusal |
| An unknown block is reported, not mis-read | a block of tag 99 appended: `report.unknownBlocks = [99]`, the state hash equal; a module block that does not fit its definition is an error naming the part and the module |
| A design that is not in the library round-trips through the embedded kind | a ferry whose vehicle the reader's library does not have: decoded from the design inside the blob, state hash equal; the same vessel under a library that has the design is more than 500 bytes smaller |
| Golden re-baseline 2 | `7da3ffe86c85228d`, 596,092 steps (before: `b850b94ea2dcc1a5`); reproduced on a second run; the trajectory guard and the six fixtures bit-identical before and after |

Also tested: an assembly (two craft, owners, a policy with a list, links, the helm on the second craft)
round-trips; a version this build does not read, missing magic bytes and truncated data are refused by
name; an unknown part or vehicle is refused by name; a vehicle whose content changed is reported; the
capture put back gives the following flight again bit for bit with the structure cache kept, and brings
dropped parts back when taken before a staging.
