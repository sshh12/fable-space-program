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

- 03:40 step 5 complete: the world speaks the v2 snapshot; `createSession` in `src/session`. Guard
  bit-identical, golden unchanged (`7da3ffe86c85228d`).

- 04:10-05:30 step 6: the overlay source and request `bodies-ephemeris-1` (885026b), the rules documents
  (f0ac644), flatten discs from pads (0a27c8a), the pad list and `ScenarioDef.pad` (50d0cba), and LAST the
  rename to `ka-lae` / `lc-1` (a2c6318 in this package's paths, 10057fe the one mechanical commit outside
  them, by the lead's decision including the `git mv` of the ground survey section). Guard bit-identical,
  golden unchanged, terrain guard green, whole-tree typecheck clean.
- Requests filed at the end: `sim-core-v2-2` (a missing ground survey must fail loudly; vehicle-pad),
  `sim-core-v2-3` (four contract decisions for the tighten step; the lead), notice `NOTICE-sim-core-v2-1`
  (the rename). The lift-off rehearsal promised in `app-integration-13` did NOT land (see "Not done").

- 06:00 closing: whole-tree typecheck clean; the brief's unit set 60 files, 652 tests; mission 36 of 36 with
  `7da3ffe86c85228d`. The GPU run of the vehicle game spec's site test could not be had (18 minutes in the
  queue for the one slot; withdrawn); the survey lookup was checked headless instead. Request
  `sim-core-v2-2` was resolved by vehicle-pad meanwhile (37d3ad2).

- Review of the six steps (accepted; four majors, eight minors) and lead decisions D1-D3: fixed in commits
  972c8f8 (craft ids, crew, capture, codec 3, corpus), ac2fb78 (the tick-pure rule and the one authorised
  re-record), 6a08c06 (rules as overrides, pad class limits, ids in the loader), 38cdfce (the pins),
  a643a8f (request flight-ui-9). **READ "After the review" AT THE END FIRST: it replaces what the step
  sections say about the clock base, the golden hash, the guard's recording, piece ids and the corpus path.**

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

### The corpus (`tests/unit/sim-vessel/corpus/`; it was `codec-corpus` until the review)

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

## Step 5: the world speaks v2 (MIGRATION_V2 3.5)

### API

```ts
// src/session/index.ts
createSession(defs: DefLibrary, scenarioId: string, options: { terrain: TerrainProvider; ids?: CraftIdSource }): LocalSession
diagnosticsOf(session: LocalSession): SessionDiagnostics        // debrisLog(), stats(), clearance(a, b)
// src/sim/index.ts
createWorld(defs, scenarioId, { terrain, ids?, renderRoot? }): SimWorld      // what createSession calls
/** @deprecated */ createSim(defs, scenarioId, { terrain }): SimWorld         // the same with renderRoot: 'rootBody'
// tools/sim/realWorld.ts (tools and tests)
openSession(defs, scenarioId, options): DiagnosedSession       // = LocalSession & SessionDiagnostics, one object
```

`tests/mission`, `tools/sim` and the unit tests of the world use `createSession` (through `openSession`).
`src/app`, `labs/integration` and `tools/audio/entryProfile.ts` still call `createSim`.

### What the snapshot carries now

| Field | Content |
|---|---|
| `frame` | `{ epoch, origin: { kind: 'body', bodyId }, rebase, previous }`. Origin = the centre of the ACTIVE VESSEL'S SOI BODY. Every `...Root` position and velocity (bodies, vessels, the wreck, `Patch.bodyPosAtEnd`, `explosion.posRoot`) is relative to it: the origin body is at exactly (0, 0, 0) and the active vessel's `rRoot` equals its body-centred `r`. The epoch starts at 0 with the start vessel's body and increases when the active vessel's SOI body changes (an SOI change, a change of the active vessel, `debug.setVesselState`). `rebase` = the origin of the previous `snapshot()` in this frame at this snapshot's time (position and velocity), pending until `snapshot()` drains it (`peek()` shows it). `previous` = the origins of the last eight earlier epochs in this frame, newest first, in every snapshot |
| `time` | the trivial `TimeView`: `myTick = liveTick` = the clock tick, `rate` = the warp factor, `maxRate`, `limitedBy` (kind `physics`, `altitude` or `event` with the warp limit's sentence), `relation: 'live'`, `clockKind: 'private'`, no members, proposals or offers |
| `revision` | the count of steps and rails advances (`tick`, deprecated, holds the same) |
| `vessels[].crafts` | per craft: id, vehicle id, name, owner (callsign null: a vessel knows the account id only), command part instance id (null for debris), `staging { nextStage, stages, lockout }`, chase distances from the craft's vehicle, lend policy. Stage figures: the active vessel's helm craft has the staging panel's; another craft with a command part aboard has its own (cached like the panel's, thrust-to-weight restated at the local gravity); a craft nobody can fire lists none |
| `vessels[].links`, `.helm` | part keys `craftId/instanceId`; `helm { accountId, callsign: null, craftId, controlPart }` |
| `vessels[].presence`, `.timeOffset`, `.revision` | `'solid'`, 0, and a counter that moves when the vessel goes on rails, changes its SOI body or is moved by the debug API |
| `vessels[].parts[]` | `craftId`, `stageGroup`, `stageLabel` (the label of the group in the craft's vehicle) beside `instanceId` |
| deprecated, still filled | `tick`, `Readouts.targetBodyId`, `Readouts.targetClosestApproach`, `staging` and the other singleton blocks |

`Patch.bodyPosAtEnd` is the position of the patch's body at the end of the patch relative to where the
origin body is THEN (zero for a patch about the origin body). An `explosion` of a vessel in another SOI
than the origin's is moved into the frame (the vessel package produces it in the BCI frame of its body).

### The one deliberate difference between `createSession` and the deprecated `createSim`

`createSim` keeps the v1 render root: origin = the library's root body, epoch 0 for ever, `rebase` null,
`previous` empty (`renderRoot: 'rootBody'`). Reason: no presentation code applies `frame.rebase` yet (the
sweep does that), the v1 fixers fly the browser mission on this tree, and an origin that jumps 384,000 km
at the Moon's sphere of influence would throw every held ROOT position (camera rigs, previous-frame state,
world-anchored effects). Everything else the alias returns is the v2 snapshot. **For `presentation-sweep`:
moving a consumer to `createSession` is what turns the moving origin on for it; `FrameEpochTracker` of
`src/core/math/frame.ts` is tested against the session's frames (also for a consumer that skipped the
snapshot of the change). The option goes with the alias.**

The render root is presentation only: the same coast into the Moon's SOI through `createSim` and through
`createSession` ends in the same state hash (tested), and the pilot reads no ROOT position, so the
mission is bit-identical under both.

### Acceptance

- `npm run test:mission`: 36 of 36 on `createSession`; state hash `7da3ffe86c85228d` unchanged; cheatCounter 0;
  no incomplete terrain query. Trajectory guard: 400 of 400 samples bit-identical, debris 0 s and 0 m.
- `tests/unit/sim-world/snapshotV2.test.ts` (7): the origin body at (0, 0, 0) and the vessel at its
  body-centred state; the rebase at the Moon's SOI entry (peek shows it, snapshot drains it, a held
  position carried over to 1e-6 m and a held velocity to 1e-9 m/s, the history in every later snapshot,
  the tracker for a consumer that slept through the change); `createSim` with one epoch through the same
  change and the same state hash; the time block and its limit kinds; `revision`; the craft block of the
  active vessel against the staging panel; debris with its craft and no command part; the vessel
  revision; `createSession` and `diagnosticsOf`.
- Unit suites: `src/sim src/session src/core/defs src/terrain tests/unit/sim-vessel tests/unit/sim-world
  tests/unit/sim-orbits tests/unit/terrain-core tools/dev` plus the presentation unit tests that read part
  snapshots (`tests/unit/vehicle`, `cockpit`, `vfx`, `fakes`): 69 files, 735 tests, all pass.

## Step 6: sites and the loader (MIGRATION_V2 3.6)

### API

```ts
// src/core/defs/sites.ts (new): everything that needs a pad goes through these
interface PadLocation { latDeg: number; lonDeg: number; padElevation: number | 'terrain' }
const SINGLE_PAD_ID = 'pad'
padsOf(site: LaunchSiteDef): PadDef[]                         // the pad list, or the deprecated single pad as the one pad
padOf(site: LaunchSiteDef, padId?: string): PadDef            // absent = the first pad; unknown = Error naming site, id and pads
padLocationOf(site: LaunchSiteDef, padId?: string): PadLocation   // first pad = the reference point; others = location.pads[id]
padTitle(site: LaunchSiteDef, padId?: string): string         // "<site name>, <pad name>"
singlePadOf(site: LaunchSiteDef): PadDef

// src/core/defs/loader.ts
overlayDefSource(base: DefSource, overlay: DefSource, dirs: readonly string[] = OVERLAY_DIRS /* ['bodies'] */): DefSource
const TABLE_FILES: readonly string[]                          // ['bodies/radii.json']: data tables, never definitions
normaliseSite(site: LaunchSiteDef, file: string): void        // what loadDefs does to every site
validateRules(doc: UniverseRules, file: string): void
loadDefs(source): Promise<DefLibrary>                         // now also fills DefLibrary.rules

// src/sim/frames/padState.ts, src/sim/world/scenarioStart.ts: a trailing optional pad id (absent = the first pad)
resolvePadElevation(site, terrainElevation?, padId?): number
padState(system, site, ut, padElevation, heightAbovePad = 0, padId?): PadState
padPose(system, site, vessel, ut, padElevation, padId?): StartPose

// tools
tools/sim/realWorld.ts   loadLibraryOver(overlayRoot = <repo>/data/staged): Promise<DefLibrary>
tools/sim/writeRules.ts  rulesDocuments(): Record<string, UniverseRules>;  npx tsx tools/sim/writeRules.ts [--check]
tools/sim/findStartTime.ts  new option --pad <id> (default: the scenario's pad, else the first pad)
```

### The site model

- **The site file states its pads in `pads` only** (`data/defs/sites/ka-lae.json`: one pad, `lc-1`, "Launch
  Complex 1", heavy, azimuth 90, flat 450 m / blend 900 m with the v1 shape, mount height 18 m, the v1
  structures by `$ref`). The loader then writes the deprecated `pad`, `padAzimuthDeg` and `structures` FROM
  THE FIRST PAD, so they are still filled and are `pads[0]` by construction; a file that states both is
  refused (two statements of one pad can disagree). A file with the deprecated single pad and no list still
  loads: the single pad becomes its one pad (id `pad`, heavy, no limits).
- **Locations.** The first pad stands at the site's reference point (`location.latDeg/lonDeg/padElevation`);
  every other pad needs `location.pads[<id>]` (the site-resolve tool writes them; an elevation cannot be
  derived from an offset) or the load fails by pad. After load `location.pads` has an entry for every pad.
- **Flatten discs are derived from the pads** (`src/terrain/modifiers.ts`): one per pad at its location, with
  the pad's radii and shape; sites in id order, pads in their order; source text `sites/<site>.json pad
  "<pad>"`. For `lc-1` the disc is the v1 disc: the terrain guard is unchanged.
- **`ScenarioDef.pad`**: validated by the loader (unknown pad = `DefError` with the site's pads). The world
  starts on it: place, elevation, heading (`azimuthDeg`), mount height, the `pad` terrain request
  (`blendRadius + 600`), the `site:<id>` surface target (the pad's place and flat radius, name
  `padTitle`) and the launch-site distance of the debris log. Absent = the first pad; naming the first pad
  gives the same state hash as not naming it (tested).
- **The rename.** Site `ka-lae`, pad `lc-1`; files `ka-lae.json`, `ka-lae.location.json`,
  `ka-lae.structures.json`; nine scenarios (`"site": "ka-lae", "pad": "lc-1"`); the region file;
  `tools/sim/start-time.json` regenerated (`npx tsx tools/sim/findStartTime.ts --launch-kind either`): the
  same start, 938240818.8416667 s = tick 112588898261; `tools/sim/qaScenarios.ts` carries the pad into
  re-captured scenarios. Outside the package's paths, in the one mechanical commit: the ground survey section
  `data/defs/visuals/sites/ka-lae.json` (`git mv`, byte-identical) and three integration specs that read the
  location file by path. No file was left changed and uncommitted (`docs/requests/NOTICE-sim-core-v2-1.md`).
- **Data that is a choice, not a derivation:** `lc-1` has `maxLiftoffMass` 3,000,000 kg and `maxDiameter`
  9.5 m, written from the only vehicle that exists (about 2,760 t at lift-off; a 9.0 m stack in a mount
  that opens 9.56 m). ARCHITECTURE 9.3 has no limits per class (request `sim-core-v2-3`). The site's name
  is now "Ka Lae Pacific Spaceport" and the pad's "Launch Complex 1"; the session's surface target keeps
  the v1 string through `padTitle`.

### The overlay source and data tables (request `bodies-ephemeris-1`, resolved)

`overlayDefSource(base, overlay)`: under `bodies/` the second root REPLACES OR ADDS (its files are listed
with the first's; a path both have is read from the second); every other file of the second root is a
`$ref` target only (read when the first root has no file at that path; never listed, so never a
definition or a section). A staged body refers to `../terrain/<id>.terrain.json` of its own root and to
`../render/<id>.surface.json` of the first: no `$ref` leaves a defs root. Measured: the staged library
of this tree (`data/staged`, 32 body files) loads over `data/defs` with every staged body in it and the
sites, vehicles and sections of the first root unchanged. **For `solar-system-sim`:
`loadLibraryOver()` of `tools/sim/realWorld.ts` is that library in Node.**

`TABLE_FILES` (`['bodies/radii.json']`) declares the data tables that live beside definitions: a listed
path is never read as a definition, in either root; an unlisted id-less file still fails by name. **For
`bodies-activation`: the table may live at `bodies/radii.json` of any defs root.**

### The data server

`tools/server/dataPlugin.ts` (in this package's paths) is unchanged: it serves `data/defs` whole with a
generated listing, so `rules/` reaches the browser like every other directory. The overlay is not offered
to the browser: staged bodies are for Node tools and tests until the activation step moves them into
`data/defs`.

### The rules documents

`data/defs/rules/default.json` = `DEFAULT_UNIVERSE_RULES` exactly (the lead's
`src/core/contracts/net.test.ts` holds them equal: it passes). `local.json` = the default under the id
`local`. `staging.json` = the default with every timer on the wall clock (`UNIVERSE_RULE_TIMERS`, base
`wall`: the eleven of the expiry block) at a day per minute and none under one minute: craft 840 s,
unowned assembly and craft 120 s, debris, wreck and arcs 60 s, accounts 5,400 s, pressure floors 60 s and
180 s, sweep and outage threshold 60 s. The rule and the numbers are this package's choice (the contract
says "lifetimes of minutes" and no more; request `sim-core-v2-3`); `universe-directory` owns the files from
wave 4. The loader fills `DefLibrary.rules` and holds every document to exactly the fields of
`UniverseRules` (a missing or unknown field and a non-number where the default has a number fail by the
field's path). **When the contract gains a field, the three files fail to load until
`npx tsx tools/sim/writeRules.ts` (which overwrites tuning) or their owner adds it.**

### Acceptance of the step

| Check | Result |
|---|---|
| Trajectory guard after step 6 | 400 of 400 mission samples bit-identical (attended craft 228 about the Earth and 172 about the Moon, the first shed vessel, the launch clamps over 395 samples); the six unit fixtures bit-identical; debris fates 0 s and 0 m |
| `npm run test:mission` | 36 of 36; state hash `7da3ffe86c85228d` (unchanged since step 4); cheatCounter 0; no incomplete terrain query |
| Start-time constraints | `tests/unit/sim-world/scenario.test.ts` and `tests/unit/sim-orbits/startTime.test.ts` pass on the regenerated record (same start) |
| Terrain unit suites and the terrain guard | `src/terrain` + `tests/unit/terrain-core`: 15 files, 193 tests pass before the rename; in the final run below after it; the guard's heights bit-identical (it samples stored directions; its group is still called `site:ka-lae-lc1`, the name it was recorded under) |
| The brief's unit set | `src/sim src/session src/core/defs src/terrain tests/unit/sim-vessel tests/unit/sim-world tests/unit/sim-orbits tests/unit/terrain-core tools/dev`: 60 files, 652 tests, all pass |
| Other packages' unit tests that read sites or part snapshots | `src/core src/map src/render/vehicle tests/unit/vehicle tests/unit/cockpit tests/unit/vfx tests/unit/fakes`: pass. `tests/unit/site-bake/pads.test.ts` fails in 5 tests on `madrakah` (not resolved yet: site-bake's work in progress); its Ka Lae tests pass |
| `npm run typecheck` | clean for the whole tree |

New tests of the step: `src/core/defs/loader.test.ts` (20: the overlay (4), rules (2), sites and pads
(5) among them), `tests/unit/terrain-core/pad.test.ts` (11: discs per pad (3) among them),
`tests/unit/sim-world/pads.test.ts` (5).

## Closing summary

### The six scope items

| # | Item | State | Where |
|---|---|---|---|
| 1 | The tick grid, alone | done; judged by the lead's four checks, all met. The brief's own tolerance against `baseline-v1.json` (1e-6, 1 s) is NOT met and cannot be (see "Deviations") | "Step 1" |
| 2 | The trajectory guard | done; recorded once on the tick-grid tree, never re-recorded | "Step 2" |
| 3 | The vessel model | done | "Step 3", with its limits |
| 4 | State whole and versioned | done | "Step 4" |
| 5 | The world speaks v2; `createSession` | done; the deprecated `createSim` keeps the v1 render root (see "Deviations") | "Step 5" |
| 6 | Sites and the loader | done | "Step 6" |

**Golden hash: `b8221b0fd316207e`, 596,933 steps (`tests/mission/golden.json`).** Re-baselined three
times in this package, each time reproduced by a second run without the update flag:
1. step 1, `3f3a131cdd88eba7` -> `b850b94ea2dcc1a5`: the clock moved onto the tick grid (the start by
   2.004 ms, every rails landing onto a tick), which is another flight;
2. step 4, `b850b94ea2dcc1a5` -> `7da3ffe86c85228d`: the state hash became the hash of the codec's
   output; the flight is the same (trajectory guard bit-identical before and after).
3. the review fixes, `7da3ffe86c85228d` -> `b8221b0fd316207e`: the tick-pure rule (lead decision D1) is
   another flight, and codec version 3 another hash; done once, for both ("After the review").
Steps 2, 3, 5 and 6 did not change it.

### The brief's acceptance criteria, one by one

| Criterion | Met | Measured |
|---|---|---|
| Step 1: the tolerance table against baseline-v1, every milestone | table given; **the tolerance itself is not met** | "Step 1": same-start equality a, e, E, h within 5.0e-10 at 25 states (plane angles to 2.0e-9 and 7.7e-9 rad, stated there with their cause); rails 36 of 36 landings bit-identical to v1; envelope of four v1 control flights: 17 of 17 milestones inside |
| `checkStartConstraints` and the solstice test on the tick-aligned start | yes | `tests/unit/sim-world/scenario.test.ts`, `tests/unit/sim-orbits/startTime.test.ts`; again after step 6 on the regenerated record |
| A unit test proves every scenario start and every rails landing is an integer tick | yes | `tests/unit/sim-world/tickGrid.test.ts` (9); in the mission all 214,720 control ticks, 65,696 of them rails landings |
| Trajectory guard bit-identical after steps 3, 4, 5 and 6 (attended craft, six fixtures, clamp vessel) | yes, after each | 400 of 400 samples; six fixtures bit for bit; clamps over 395 samples |
| Debris within its fate tolerance | yes | 0 s and 0 m (tolerance 2 s, 500 m) |
| `npm run test:mission` with cheatCounter 0 and zero incomplete terrain queries | yes | 36 of 36 (34 before this package; two tests added) |
| Each re-baselined golden reproduces on a second run | yes | both |
| Codec: the five scenes, sizes, N-1, changed PartDef, unknown block, embedded design | yes | "Step 4": the 38-part stack 8,197 bytes (target under 9,000); equal state hash at load and bit-identical for 6,000 steps in all scenes |
| Merge then split: poses to 1e-9 m, linear momentum 1e-6, angular 1e-9; ring of three; own stages; ids | yes | "Step 3": 3.6e-15 m; 2.7e-16; 1.2e-11 |
| The terrain guard is green | yes | after every step and after the rename |
| `npm run typecheck` clean for the whole tree | yes | at the end of step 6 |

### How to run and verify

```
npm run typecheck
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim src/session src/core/defs src/terrain tests/unit/sim-vessel tests/unit/sim-world tests/unit/sim-orbits tests/unit/terrain-core tools/dev
node tools/dev/heavy.mjs --class=cpu -- npm run test:mission
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/trajectoryGuard.ts          # the guard alone, with its table
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/referenceFlight.ts          # same-start equality table
npx tsx tools/sim/writeRules.ts --check                                               # rules files against their derivation
npx tsx tools/sim/findStartTime.ts --launch-kind either                               # regenerates tools/sim/start-time.json
```

Last full run (after the review fixes): see "After the review". Recorded files are pinned by
`tools/dev/guard-pins.test.ts` and re-recorded by the lead only: `tests/mission/trajectory-guard.json`,
`tests/mission/reference-v1-aligned.json`, `tests/mission/controls-v1.json`,
`tests/unit/sim-vessel/trajectory-fixtures/*.json`, `tests/unit/sim-vessel/corpus/*.bin` (blobs are only
ever added).

### Deviations from the brief (each stated where it is made)

1. **The tolerance against `baseline-v1.json`** was replaced by the lead's decision
   (`docs/requests/sim-core-v2-1.md`): the scripted pilot decides at 30 Hz, so the mission is a chaotic
   function of its start instant, and the unmodified v1 code misses the tolerance when only its start is
   shifted by 2 ms. The four checks of the decision are all met.
2. **`createSim` keeps the v1 render root** (origin = the library's root body, one epoch, no rebase);
   `createSession` has the origin at the active vessel's SOI body. The brief asked for one world that
   speaks v2; a moving origin under presentation code that does not apply rebases yet would have broken
   the v1 close-out flights on this tree. `src/app/game.ts`, `labs/integration` and
   `tools/audio/entryProfile.ts` still call `createSim`, so they do not see the moving origin until the
   sweep moves them. The option (`renderRoot`) goes with the alias.
3. **The mechanical rename commit** also moved one data file that is neither under `labs/` nor `tests/`
   (`data/defs/visuals/sites/ka-lae.json`), on the lead's decision, because the section is found by the
   site id.
4. **Data chosen by this package where the design gives no number:** the pad limits of `lc-1`, the numbers
   of `rules/staging.json`, `rules/local.json` equal to the default, the name split of the site
   (request `sim-core-v2-3`).
5. **Event part ids** have two forms (instance id in a vessel of one craft, part key in an assembly) until
   the sweep is through ("Step 3", limits).

### Not done

- **The lift-off rehearsal at load** announced in `docs/requests/app-integration-13.md` (to remove the
  5.5 ms first execution of the release path) is not implemented. It needs a second world on the session's
  terrain authority, whose request slots the two would share, and it runs inside the load path of every
  session: proving it neutral for the golden hash, the terrain accounting and the mission's zero incomplete
  queries is a piece of work of its own, and it was not started at the end of this package rather than
  landed unproven. The measurement and the proposal are in the request, which stays open for whoever owns
  the session next (`session-switch` or `island-core`).
- **Control-from-here, lend policies in the allocation, port states and soft capture**: the data is there
  (helm, policies, links); the behaviour is `contact-docking`'s and the island's ("Step 3", limits).
- **The vehicle game spec's site test on the GPU** after the rename: **not run by this package.** The one run through the gate
  (`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle/game.spec.ts -g "the
  terrain under every structure of a site" --project=functional`) waited 18 minutes for the single GPU slot
  behind other agents' jobs and was withdrawn before it started, so that no browser of this package runs
  after the hand-off. What was checked instead, headless, on the renamed tree: the library's site `ka-lae`
  finds its survey (`visuals/sites/ka-lae`, 144 x 116 nodes at 5 m, `siteGround(...).surveyed` true, 34
  structures), and `tests/unit/vehicle` passes (4 files, 38 tests, with vehicle-pad's new test that a site
  with structures and no survey does not load, commit 37d3ad2). A job labelled `vehicle-game-site` held
  the GPU slot from 10:57 to 11:06 UTC, after the rename; it was not this package's and its result is its
  owner's to report.

### Requests

| File | State | To |
|---|---|---|
| `docs/requests/sim-core-v2-1.md` | resolved (lead decision) | how the tick-grid step is judged |
| `docs/requests/sim-core-v2-2.md` | resolved by vehicle-pad (37d3ad2) | a missing ground survey section is an error at load, not level ground |
| `docs/requests/sim-core-v2-3.md` | resolved (lead decision D3, recorded in the request) | event part ids, the cockpit of a command part, pad class limits, the staging and local rules |
| `docs/requests/flight-ui-9.md` | resolved by this package (a643a8f) | chute light without air, radar altitude and g load of a held vessel: read-outs only |
| `docs/requests/NOTICE-sim-core-v2-1.md` | notice | everyone: the site is `ka-lae`, the pad `lc-1` |
| `docs/requests/flight-ui-6.md`, `flight-ui-8.md`, `bodies-ephemeris-1.md` | resolved by this package | Mach in vacuum; stage thrust-to-weight after an SOI change; data tables beside body definitions |
| `docs/requests/app-integration-13.md` | sim share answered, open | the rehearsal above |

### What the next packages must know

**presentation-sweep**
- Moving a consumer from `createSim` to `createSession` (src/session) turns the moving render root on for
  it: every `...Root` field is relative to the active vessel's SOI body, the origin body sits at exactly
  (0, 0, 0), and at an SOI change (or a change of the active vessel to another body) `frame.epoch`
  increases and `frame.rebase` carries held positions and velocities over. Use `FrameEpochTracker` of
  `src/core/math/frame.ts`; `frame.previous` serves a consumer that skipped the snapshot of the change.
  `peek()` shows a pending rebase without draining it; `snapshot()` drains it like the events.
- `snapshot.tick` is deprecated and equals `revision`; the clock is `time.myTick`. Part lookups in an
  assembly need the part key (`craftId/instanceId`); `PartSnapshot.craftId`, `stageGroup`, `stageLabel`
  and `VesselSnapshot.crafts` (stage figures per craft, chase distances) are filled. An event's `partId`
  is an instance id in a vessel of one craft and a part key in an assembly.
- The first craft's id of a local session equals its vehicle id (the seeded id source), which is why v1
  code that confuses the two still works; do not rely on it. A piece of debris is a craft of its own:
  `CraftSnapshot.id` is `<the craft it left>.<its root part>` and unique in the snapshot, while its VESSEL
  id keeps the form `<launched craft>~<root part>` that `src/render/vehicle/vesselFeature.ts` parses.
- `CraftSnapshot.cockpit` is filled (the interior id, the camera seat and the sensor mount of the command
  part); null for a craft without a command part.
- The list of callers of the deprecated `createSim` to move: `src/app/game.ts`, `labs/integration`
  (`features.ts`, `main.ts`) and `tools/audio/entryProfile.ts`.
- Sites: `padsOf(site)`, `padOf`, `padLocationOf`, `padTitle` of `src/core/defs/sites.ts`; the deprecated
  single-pad fields are the first pad. `site.name` no longer includes the pad's name. The survey section
  is `visuals/sites/ka-lae`.

**island-core**
- **The state at a tick is a function of the tick and the vessels** (`src/sim/clock.ts`). There is no
  clock base, control phase or sun phase to carry: the base of a tick is `baseTickOf(tick)` (the last whole
  day), body orientation is `W(baseUtOfTick(tick)) + rate x offsetOfTick(tick)`, a vessel on rails is
  `propagate(orbit, baseUtOfTick(tick), offsetOfTick(tick))` for a step and a landing alike, a control
  tick is due when `tick % 4 === 0`, the sun sample is taken when `tick % 12 === 0` and is vessel state
  (`Vessel.sun`, in the codec). An island that evaluates these expressions reproduces the world bit for
  bit; one that evaluates orientation or a conic at `tick / 120` directly does not (the absolute time
  resolves 1.2e-7 s there), and the trajectory guard will say so.
- The six unit fixtures are defined by `tests/unit/sim-vessel/helpers.ts` (`makeEnv`) and `scenarios.ts`
  as they stand; they are the bit-exact reference for the per-vessel step.
- A vessel's whole state is `Vessel` including `carried` (probe contact flags and friction anchors, buoy
  wet flags, thermal wake factors); the structure cache is rebuilt from it (`invalidateStructure`).
  `captureVessel` / `restoreVessel` are the cheap copy for rollback rings; `encodeVessel` /
  `decodeVessel` the wire and storage form; `stateHash(vessel)` is the hash of the codec body and does not
  depend on the library hash.
- Ids of launched craft come from an injected source (`CreateSimOptions.ids`, `CraftIdSource`); a piece
  that leaves a craft is a new craft whose id is DERIVED (`pieceCraftId`: `<parent>.<root part>`, no
  counter, so a rollback and a replay issue the same one); the rules are in `src/sim/vessel/ids.ts`. `src/sim/vessel` may import only `src/core` and itself
  (`TICKS_PER_SECOND` from `@/core/contracts/net` there, not `../clock`).
- `dockMerge` and `undock` conserve momentum and restore poses; envelopes, port states and joints are
  yours and `contact-docking`'s.

**solar-system-sim**
- `loadLibraryOver()` of `tools/sim/realWorld.ts` loads the staged bodies over `data/defs`; the table
  `bodies/radii.json` is declared in `TABLE_FILES` and is not a body. The staged library loads; nothing
  in the simulation has been run on it by this package.
- The render root uses `BodySystem.stateRelative(bodyId, originId, ut)` for every body, the rebase, the
  history and `Patch.bodyPosAtEnd`; with a root attractor above the Earth the frame code is unchanged, but
  the snapshot tests of the frame (`tests/unit/sim-world/snapshotV2.test.ts`) name `earth` and `moon`.
- A change of the body model moves the trajectory guard (it is bit-exact) and the golden hash: that is a
  lead decision, not a re-record by the package that causes it.
- Every instant the simulation evaluates a body at is a tick instant or an event instant inside a tick.

**fleet-data**
- A vessel blob carries a fingerprint of every part definition it was written under. Changing a
  `PartDef` that flown vessels use needs a `PartMigration` in `src/sim/vessel/migrations/index.ts`
  (helpers `fitResources`, `insertModule`, `dropModule`, `fitSurfaces`), or old blobs are refused by
  part and fingerprints; a blob added to `tests/unit/sim-vessel/corpus` is pinned by the lead (`tools/dev/guard-pins.test.ts`). A design the
  reader's library does not have travels inside the blob.
- `meridian-lunar` and its parts define the golden hash, the trajectory guard and the fixtures.
- Stage labels shown per part come from `VehicleDef.stageGroups[].label`; chase distances from
  `cameras.chase`; the command part's data from its `command` module (`command.cockpit` is in no part
  file yet: request `sim-core-v2-3`).
- Pads take `class`, `maxLiftoffMass` and `maxDiameter`; nothing checks a vehicle against a pad yet
  (`VehicleDef.padInterface` is absent on the one vehicle).

## After the review (lead decisions D1, D2, D3; findings 1-12; request flight-ui-9)

An independent review accepted the six steps and found four majors and eight minors. This section says
what changed; where it contradicts a step section above, this section holds.

### D1: the state at a tick is a function of the tick and the vessels (finding 1)

Before, three things depended on how the clock got to a tick: the base that body orientations were
evaluated from (the last rails landing), the phase of the control ticks (counted from the start and from
every landing) and the phase of the sun sample (counted in steps). Reaching one tick by three routes gave
three Earth quaternions (5e-12 apart) and pad positions up to 63 um apart. Now (`src/sim/clock.ts`):

| What | Rule | Where |
|---|---|---|
| Clock base | `baseTickOf(tick)` = the last whole multiple of `BASE_TICKS` = one day (10,368,000 ticks) | orientation: `W(base) + rate x offset`; a vessel on rails: `propagate(orbit, base, offset)` for a step AND for a rails landing |
| Control tick | due when `tick % 4 === 0`; the pilot is also asked before every rails advance, at whatever tick the clock stands (the contract's words; a rails advance is the driver's request, an input) | `World.step`, `World.advance`, `src/pilot/runner.ts` |
| Sun sample | taken when `tick % 12 === 0` (the reduced tier: every tenth of those), at a rails landing and at the start; it is vessel state, `Vessel.sun { dir, visibility }`, carried by the codec | `World.refreshSun` |

Why a day for the base: the offset from the base stays under 86,400 s, where a whole number of ticks
times 1/120 s is exact to 1.5e-11 s (1e-15 rad of the Earth's turn, 7 nm at its surface, 1e-7 m of a low
orbit); a base is a whole number of seconds, exact; and it changes once per day of universe time. At that
one tick the evaluation error of the body angle at an absolute time shows as one step of the ground:
measured under the stack on the pad, 23 um (`tickPure.test.ts`). A shorter period shows it more often, a
longer one lets the offset lose bits.

One consequence that is a change of numbers, not only of phase: **a rails landing is now the conic at the
tick evaluated from the base** (the same expression as a step). v1, and this world before, evaluated a
landing at the absolute time in seconds, which resolves 1.2e-7 s at mission epochs. The two differ by up
to 0.38 mm (5.6e-8 s of flight; measured over 30 landings). Without this a vessel on rails was in one
state at a tick after a landing and in another after a step.

Test: `tests/unit/sim-world/tickPure.test.ts` (5). One tick is reached by a rails advance of 100 s and
240 steps, by one of 98 s and 480 steps, and by 12,240 steps, for a stack held on the pad and for a vessel
coasting on rails: every body's orientation, the vessel's position, velocity and attitude, its sun sample
(also twelve steps later) and the ticks at which the real-time loop asks the pilot are the same bits on
all three routes. (The start tick of the scenario is 1 mod 4 and 5 mod 12: the phases are the clock's.)
What is NOT equal between a rails route and a stepped one, and is not meant to be: temperatures (a rails
advance does not integrate the thermal state) and the attitude of a vessel that tumbles on rails.

### The one authorised re-record, and what was not re-recorded

| File | State |
|---|---|
| `tests/mission/golden.json` | re-baselined once: `b8221b0fd316207e`, 596,933 steps (before: `7da3ffe86c85228d`, 596,092); reproduced on a second run and on a third after request flight-ui-9 |
| `tests/mission/trajectory-guard.json` | re-recorded once on the tick-pure flight (the recorder refuses to overwrite: the old file was removed first); 400 of 400 bit-identical on the second and third run |
| `data/defs/scenarios/qa-*.json` | re-captured from the new nominal flight (they are captures of it; the mission test compares) |
| the six fixtures `tests/unit/sim-vessel/trajectory-fixtures/*.json` | NOT re-recorded: bit-identical through every change of this round (the per-vessel step did not change) |
| `tests/mission/reference-v1-aligned.json` | NOT re-recorded: v1 values, see check 1 |
| `tests/mission/controls-v1.json` | NOT re-recorded: four v1 flights, see check 4 |
| `tests/unit/sim-vessel/corpus` | 6 version-3 blobs added; the 12 earlier blobs untouched; the index re-derived (the hash is of the version-3 body) after decoding every blob to the hash of its scene |

All of them are pinned by SHA-256 in `tools/dev/guard-pins.test.ts` (finding 7): only the lead re-records.

### The four checks of sim-core-v2-1 on the tick-pure flight

| Check | Result |
|---|---|
| 1. Same start, against the v1 clock (`reference-v1-aligned.json`, unchanged) | The equality of step 1 (5e-10) cannot hold any more and is restated. The first control tick after the start is at the next multiple of four, 3 ticks after the start (start tick 112588898261 = 1 mod 4), where v1's pilot acted at the start. **The ascent is v1's ascent flown 3 ticks later**: at all 25 states (six milestones to EARTH_ORBIT and every 30 s) the event and capture times differ by exactly 0.025 s; da/a 4.8e-7, de 5.8e-7, dE/E 4.8e-7, dh/h 5.3e-7, dm/m 3.5e-8, altitude 1.8 mm; the plane and the inertial place differ by what the Earth turns in 25 ms (di 2.6e-6 rad, dLAN 1.0e-5 rad, 11.3 m). Asserted with: the lead to 1e-4 s; 1e-6 in a, e, E, h; 1e-7 in mass; 1 cm; 1e-5 and 2e-5 rad; 15 m |
| 2. Rails equivalence | 30 landings from the six coast states: 0 m and 0 m/s against the conic at the tick. Against v1's evaluation at the absolute time: up to 3.8e-4 m (5.6e-8 s of flight). The 36-of-36 bit-identity with v1 measured at step 1 is given up by the rule above, by that amount |
| 3. The mission's gates | 36 of 36; cheatCounter 0; no incomplete terrain query. One assertion changed its tolerance: see 4 |
| 4. Envelope against `baseline-v1.json` with the four v1 controls | 16 of 17 milestones inside by the lead's checker unchanged. STAGE_SEP_1 is outside BY ITS EVENT TIME ALONE: 0.042 s against 0.033 s (the checker's floor of one control tick); its elements are inside (da/a 5.3e-5 of 1.05e-4 allowed). The controls are v1 flights with shifted starts, whose pilots act at their starts; none samples a pilot who acts 3 ticks after the start. **The test therefore allows a milestone that is outside by event time alone the checker's allowance plus that lead (0.025 s)**, and holds every element to the checker's own allowance. This is a tolerance I changed in a test of a check the lead defined: it is the lead's to confirm or to replace by control flights that sample the lead (they need the v1 tree, which no longer builds against the craft model here). Touchdown 4.02 m from the baseline's point; splashdown in the baseline's zone |

Envelope rows (dTime s, da/a; allowed in brackets): LIFTOFF 0.008 (0.033), 1.5e-16; MAX_Q 0.008,
7.7e-15; STAGE_SEP_1 0.042 (0.033), 5.3e-5 (1.05e-4); FAIRING_JETTISON 0.008, 4.5e-5; STAGE_SEP_2 -0.025
(0.100), -4.8e-5; EARTH_ORBIT -0.025, -4.8e-5; TLI_COMPLETE -0.592 (1.333), -1.7e-3; MOON_SOI_ENTER -16.3
(223.2), 3.1e-4; LUNAR_ORBIT -16.9 (269.1), 4.7e-3; LUNAR_TOUCHDOWN 42.1 (150.5), -3.9e-8 (4.5e-8);
LUNAR_LIFTOFF 42.1, 2.5e-6; MOON_SOI_EXIT 68.1 (206.4), -2.9e-4; EARTH_PERIGEE_TARGETED 68.0 (1293.6),
8.9e-5; ENTRY_INTERFACE 16.6 (157.3), 2.1e-4; DROGUE_DEPLOY 24.9, 2.4e-5; MAIN_DEPLOY 24.9, 4.7e-6;
SPLASHDOWN 24.8, 4.6e-6.

### D2: craft ids are unique (finding 4)

Wording for the architecture's owner (section 3 "Ids" and 7.2):

- **A craft has one part tree with one root part** (`CraftRuntime.root`, the instance id of that part) and
  a lineage (`CraftRuntime.parent`: the craft it separated from; null for a craft that was launched).
- **At assembly** a vehicle whose file mates trees by docking ports is an assembly from the start: every
  tree is a craft of its own. The tree of the vehicle's root part takes the identity given to the
  assembler; each further tree takes an id from the id source (`CraftIdentity.ids`; without one,
  `<craftId>-2`, `-3`, ...). The vessel has the assembly id of its first two craft. Each craft has the
  vehicle's stage list and its own stage pointer, and fires of a stage the actions whose parts it has.
- **At a separation**, for each craft of the vessel: the piece that holds the craft's root part keeps the
  craft (its id and its live stage stack; when no piece holds it, the identity-keeping piece, as before).
  Every other piece that takes parts of it away is a NEW craft: id `<parent craft id>.<instance id of its
  root part>` (`pieceCraftId`), `parent` = the craft it left, a copy of the stage state. The id is a
  function of ids, with no counter, so a replay, a rollback and a re-run of a split issue the same one.
- **Vessel ids are unchanged.** A vessel of one piece craft is `<launched craft at the top of its
  lineage>~<instance id of its root part>`, the form a piece always had (so presentation state keyed by
  vessel id, and `rootOf` in `src/render/vehicle/vesselFeature.ts`, are unaffected; a fairing panel is
  `<craft>~<fairing>#panel<k>`). A launched craft alone is its craft id; assemblies as before.
- **Alphabet.** An id issued by a source, a vehicle id and a part's instance id contain none of `/` (part
  key), `~` (derived vessel ids), `.` (lineage of a piece craft): checked in the loader, in the seeded
  source and where a vehicle is assembled. The contract names `/` and `~`; `.` is this package's, needed
  so that a derived craft id cannot collide with an issued one. A craft id may therefore contain `.`.
- The launch clamps (four pieces of one craft) are welded into one held structure: `mergeVessels` welds
  pieces that left the SAME craft; the result is the first piece's craft, the other three ids end there.
- Two former pieces of one craft are two craft: docking them again is ordinary docking (tested with the
  released tandem and with a capsule whose service module left).

**A consequence the lead should know (not bent, reported):** a flat vehicle file with mated trees has ONE
stage list. Each tree's craft fires only the actions on its own parts, so in `test-tandem` the tug's
engine and the tug's port are fired by the TUG craft's stack (`fireNextStage(v, env, 1)`), and the helm
craft (the capsule) has no live stage of its own. `PlayerCommands.stage()` fires the helm craft only, so a
single pilot cannot fly such a vehicle through the session until a command reaches the stacks of their
other craft (or the vehicle is authored as assemblies with their own stages, as fleet-data's `uses`).
No real vehicle is affected: `meridian-lunar` is one tree.

### Findings 2, 3, 5, 8, 9, 10, 11, 12

| # | Fixed how | Test |
|---|---|---|
| 2 | `restoreVessel` keeps the structure cache only when it is the very object the capture was taken under (`VesselCapture.struct`); a cache built since is dropped and rebuilt from the restored state | `codec.test.ts`, "a capture and the structure cache": capsule entries at 9, 15 and 25 degrees, captured at a dose of 12 g s, crew lost 47, 30 and 20 steps later; after the restore the crew is alive, the structure has 3 crew, the dose goes on, and the end hash equals an independent copy's |
| 3 | The crew flag is derived from the command parts (`crewAliveOf`: a live crewed command part, or none crewed) in `dockMerge`, for every piece of `separateVessel` (the identity-keeping piece of a vessel that had lost its crew stays so unless a live crew is aboard) and at a crew loss. The g dose is the command part's (`CommandRuntime.gDose`); `Vessel.gDose` shows the largest among live crews (the fatal one when none lives) | `crafts.test.ts`, "crew at a dock and an undock": a live ferry and a ferry whose crew was lost at 21 g s, either as the base: the assembly is alive, the doses stay 4 and 21, after the undock each is itself |
| 5 | A crewed ferry and a tug docked by the tug's flank port: axes 113 degrees apart, unequal masses, both spinning, products of inertia up to 98 % of the smallest moment. The merged body against an independent parallel-axis composition (Cramer's rule, nothing of `dock.ts`): turn rate to 6.2e-15 relative, inertia to 1e-11, momentum to 1e-11. An undock at that port: each piece gains (port - its centre) x impulse to 1e-9; they turn by 0.18 and 6.11 deg/s | `crafts.test.ts`, "docking without symmetry" (2) |
| 8 | `tests/unit/sim-vessel/codec-corpus` -> `tests/unit/sim-vessel/corpus` (`git mv`) | - |
| 9 | Codec version 3. An enumeration byte this build has no member for is refused (hold, surface state, SAS mode); a parent index that is outside the vessel, the part itself, in another craft or closing a loop is refused; an embedded design is held to what the simulation reads of a vehicle; the keys of every plain object are written sorted. **Versions 1 and 2 were written by earlier states of this same package, not by a released build: reading them proves the version dispatch and the conversions (a piece that carried its parent's craft id becomes a craft of its own; the vessel's dose goes to its live crews), not compatibility with a blob in the field.** Sizes of version 3: lander 2,988 and 2,990, capsule 1,728, stack mid-staging 8,331, coasting 2,245, the 38-part stack 8,240 bytes (target under 9,000) | `codec.test.ts`, "what a blob may not say" (5) |
| 10 | `findPartByKey` takes part keys only (a string without `/` names nothing; `findCraftPart` inside a craft). Event part ids keep both forms until the tighten step after sub-wave 3.2 (D3) | `crafts.test.ts` |
| 11 | `TimeView.limitedBy.kind` is set where the sentence is chosen (`warpLimitKind`), not read out of it. `advanceRails`: the contract's comment now says what the code does (the first tick at or after the target; commit 537da5f by its owner) | `snapshotV2.test.ts` |
| 12 | `normaliseSite` compares a pad's `offsetEnu` with its resolved coordinates: within 20 m or 0.2 % of the distance (the staged Ka Lae pads, rounded to 10 m, are within 5.1 m at 13 km) | `loader.test.ts` |

### D3 (request sim-core-v2-3)

- **Event part ids**: both forms stay until the tighten step, as the contract now says.
- **Cockpit**: `CraftSnapshot.cockpit { id, cameraSeat, sensorMount }` is filled from the command part.
- **Pad limits**: `padLimitsOf(pad, rules?)` of `src/core/defs/sites.ts`: the class's limits
  (`rules.pads.classLimits`, else the contract's `DEFAULT_PAD_CLASS_LIMITS`) with the pad's own values over
  them. No `Infinity` anywhere: a site that states the single pad only is of the heavy class. LC-1's
  3,000 t and 9.5 m stay on the pad, marked PROVISIONAL in the file. Nothing checks a vehicle against
  them yet.
- **Rules files are overrides of the default** (`completeRules`): `default.json` states its id and version;
  `staging.json` every wall-clock timer, THE SWEEP INCLUDED, at a day per minute with lifetimes of at least
  two sweeps (sweep 1/24 s; outage threshold 2.5 s; debris and wrecks 5 s; arcs 60 s; pressure floors 60
  and 180 s; unowned 120 s; craft 840 s; accounts 5,400 s: a staging identity does not outlive a session,
  and the file says so); `local.json` the nine retentions at `Number.MAX_SAFE_INTEGER` s (the largest value
  a number carries exactly: the contract states no smaller bound) and everything else the default. A key
  that starts with `$` annotates a file and is dropped by the loader (JSON has no comments). The lead can
  now move the class limits into the default document without touching a file.

### Request flight-ui-9 (a643a8f)

Read-outs only; the golden hash and the trajectory guard are unchanged by it. `Readouts.chuteEnvelope` is
null where there is no air at the vessel; `Readouts.altitudeRadar` is the clearance of the vehicle's own
lowest probe held or flying (continuous through the clamp release); `Readouts.gLoad` and
`VesselSnapshot.gLoad` of a held vessel are the local gravity over g0. The simulation's own
`radarAltitude` (milestones, warp clamp) and `Vessel.gLoad` are untouched. Not done: the per-chute module
state `envelope` is a non-nullable contract type and still carries a judgement in vacuum.

### Verification after the review

- `npm run typecheck`: clean for the whole tree.
- The brief's unit set plus `src/pilot`, `src/core/contracts` and `tests/unit/vehicle`: see the last line
  of this section.
- `npm run test:mission`: 36 of 36, `b8221b0fd316207e`, guard 400 of 400 (the last run, after every change of this section but comments and this file: unit suites `src/sim src/session src/pilot src/core/defs src/core/contracts src/terrain tests/unit/sim-vessel tests/unit/sim-world tests/unit/sim-orbits tests/unit/terrain-core tools/dev tests/unit/vehicle tests/unit/cockpit tests/unit/vfx tests/unit/fakes`: 73 files, 790 tests, all pass).

### Rulings of the lead on what was reported (2026-11-12, relayed by the coordinator)

1. **The vessel id of a departing piece keeps its derived form** `<launched craft>~<root part>`. The craft
   id is what is universe-unique (`<parent craft id>.<root part instance id>`, a pure function of ids,
   the lineage in `parent`). The sentence of ARCHITECTURE section 3 that made the vessel id the craft id
   was the recorder's wording and is being corrected by its owner. No second re-baseline.
2. **The lineage is the parent craft id.** No separation tick is kept beyond `joinedTick`; no codec
   change. The architecture sentence is being corrected.
3. **The envelope rule stands**: a milestone that is outside by its event time ALONE is allowed the
   checker's allowance plus the pilot's lead of 3 ticks (0.025 s); every element is held to the checker's
   own allowance. The one case: STAGE_SEP_1, 0.042 s against 0.033 s (allowed with the lead: 0.058 s). The
   rule and the number are stated where `tests/mission/full-mission.test.ts` asserts them ("envelope").
4. **The same-start check is "the v1 ascent flown exactly 3 ticks later"**, with the v1 reference
   unchanged and pinned (below: why the bound is the size it is).

Still open, for the lead:
- The stage stack of a vehicle whose file mates several trees (D2, above).
- The per-chute `envelope` state in vacuum (flight-ui-9): a contract change if it should be nullable.
- `CraftSnapshot` has no lineage field: request `docs/requests/sim-core-v2-4.md` (below, for the sweep).

### Why 1e-6 is the right size for the same-start bound (and not a loosened 1e-9)

The 5e-10 equality with the v1 clock was demonstrated at step 1 (commit 2efb4bb, "Step 1" above: a, e, E,
h within 5.0e-10 at all 25 states, i 2.0e-9 rad, LAN 7.7e-9 rad, event times within 1.9e-5 s), while both
pilots acted on the same ticks. The tick-pure rule moved the pilot's control ticks onto the multiples of
four: 3 ticks after this start. Every state of the ascent is then v1's state 0.025 s later, to the tick.
A lift-off 0.025 s later is the same ascent in the rotating frame of the Earth, turned in inertial space by
what the Earth turns in that time:

    Earth's rate x lead = 7.292e-5 rad/s x 0.025 s = 1.8e-6 rad   (11 m at the pad, which moves at 440 m/s)

A pure turn about the pole would change the node by 1.8e-6 rad (measured at LIFTOFF to T+240: 1.8e-6)
and nothing else. The guidance flies to an inertially fixed target (the plane and the parking orbit it
aims for do not turn with the Earth), so it steers that 1.8e-6 rad out, and the in-plane elements move by
a fraction of it: measured da/a 4.8e-7, de 5.8e-7, dE/E 4.8e-7, dh/h 5.3e-7, a quarter to a third of
1.8e-6. The bound 1e-6 is that angle's order, not a tolerance that was opened: a flight that differed from
v1 by a control tick at a cut-off shows 5e-5 (the envelope rows), fifty times more, and fails it. The
plane angles are held to 1e-5 rad (i, measured 2.6e-6) and 2e-5 rad (LAN, measured 1.0e-5 once the yaw
steering has acted), the mass to 1e-7 (3.5e-8), the altitude to 1 cm (1.8 mm), the times to the lead
within 1e-4 s.

### For presentation-sweep, from the rulings

- **Do not parse a vessel id.** `src/render/vehicle/vesselFeature.ts` takes the launched craft of a debris
  vessel from the text before `~` in its vessel id (`rootOf`) to carry per-part presentation state across
  a separation. That is the consumer's fault to remove at the sweep: the lineage belongs to the CRAFT. A
  piece is a craft whose id is `<parent craft id>.<instance id of its root part>` and whose `parent` is
  the craft it left. The snapshot's craft block does not carry `parent` yet (it is not a field of
  `CraftSnapshot`; request `sim-core-v2-4` asks for it, and the world fills it in one line when it is
  there). Until then the parent is the craft id up to its last `.`, and the launched craft the id up to
  its first `.`: source-issued craft ids and instance ids contain no `.`.
- Callers of the deprecated `createSim`: `src/app/game.ts`, `labs/integration/features.ts` and `main.ts`,
  `tools/audio/entryProfile.ts`.
