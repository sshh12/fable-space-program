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
