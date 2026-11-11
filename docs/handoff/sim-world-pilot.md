# sim-world-pilot hand-off

The `Sim` world orchestrator (`createSim`), the scenarios, the scripted mission pilot with its headless
runner, and the headless proof of the mission: `lunar-direct` flown from the pad to splashdown through the
real Sim and the real TerrainProvider on the real baked tiles, by a pilot that only reads snapshots and
only acts through `ControlInputs` and `PlayerCommands`.

Owned paths: `src/sim/**` (new: `src/sim/world`, `src/sim/index.ts`), `src/pilot/**`,
`data/defs/scenarios/**`, part / vehicle data, `tests/mission/**`, `tests/unit/sim-world/**`,
`tests/unit/sim-orbits/**`, `tests/unit/sim-vessel/**`, `tools/sim/**`, this file.
Boundaries: `src/sim/world` imports `src/core` and `src/sim` only and reaches terrain only through the
`TerrainProvider` contract; `src/pilot` imports `src/core` only (the Sim contract).

## Run and verify

```
npm run typecheck:paths -- src/sim src/pilot tests/mission tests/unit/sim-world tools/sim
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim src/pilot tests/unit/sim-world tests/unit/sim-orbits tests/unit/sim-vessel src/core/defs
node tools/dev/heavy.mjs --class=cpu -- npm run test:mission
npx vitest run tools/dev/boundaries.test.ts

node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/flyMission.ts [--scenario id] [--launch-delay 60] [--thrust-scale 0.97] [--sloppy] [--until-milestone ID] [--quiet] [--json out/x.json]
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/flyFrames.ts [--scenario id] [--no-await]     # the browser loop, real time per phase
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/entryCorridor.ts [--from 10 --to 90 --step 10]
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/captureScenarios.ts [--check]                 # QA scenario files from the nominal flight
npx tsx tools/sim/findStartTime.ts --launch-kind either                                                  # reproduces tools/sim/start-time.json
MISSION_UPDATE_GOLDEN=1 npm run test:mission -- tests/mission/full-mission.test.ts                       # record tests/mission/golden.json anew
```

State at hand-off (all through the load gate, machine shared with other agents):

| Command | Result |
|---|---|
| typecheck:paths (five paths) | OK |
| unit suites (32 files) | 344 tests pass, 37-49 s; `tests/unit/sim-world` is 9 files / 60 tests |
| `npm run test:mission` (5 files, 30 tests) | passes, 70-105 s wall depending on what else the machine is doing; run twice in a row on two occasions, state hash `d15d99aeaa315436` every time (= `tests/mission/golden.json`) |
| boundaries | 7 tests pass |

The mission tests need the baked tile sets under `data/tiles/{earth,moon}`; `tools/sim/realWorld.ts` throws
when a manifest is missing (the tests fail, they do not skip). There is no synthetic-terrain switch in the
mission tests. The flat stand-in provider in `tests/unit/sim-world/helpers.ts` (`flatTerrain`) is used only by
unit tests of world logic that is not about terrain (rails, warp, interpolation, commands, milestones).
Each mission test writes its numbers to `out/mission/*.json` (not committed).

## createSim

```ts
import { createSim, type SimWorld } from '@/sim';

const sim: SimWorld = createSim(defs, 'lunar-direct', { terrain });   // terrain: TerrainProvider (src/terrain)
await sim.ready;                         // start terrain resident, pad elevation resolved, collision warmed

// Browser loop (never waits for terrain):
sim.advance(realDt, onControlTick);      // whole 1/120 s steps, the remainder carries over
const frame = sim.snapshot();            // ONCE per presented frame: interpolated poses, drains the event queue

// Reproducible loop (headless runner, replays, tests):
for (let p = sim.terrainPending(); p !== null; p = sim.terrainPending()) await p;   // before every step
sim.needsIntegration || warpIndex <= 3 ? sim.step() : sim.advanceRails(Math.min(sim.nextEventUt, ut + factor / 60));
const truth = sim.peek();                // never interpolated, leaves the event queue alone
```

`SimWorld` is the `Sim` contract plus three read-only diagnostics that are not part of the contract:
`debrisLog()` (what became of every removed vessel: reason, body, latitude/longitude, distance from the
site), `stats()` (steps, rails advances, patch refreshes, terrain requests, terrain warp clamps) and
`clearance(idA, idB)` (the vessel facade's envelope clearance between two vessels).

How the world works (constants are exported from `src/sim/world/sim.ts` and `terrainPolicy.ts`):

- **Vessels and tiers.** Every vessel has a mode (`landed` / `rails` / `integrated`) and a tier: `full`
  inside the 25 km bubble about the active vessel (leaves at 27 km, or later while it still has a stage
  action pending or an engine burning), `reduced` (3-DoF, 0.5 s steps) inside an atmosphere outside the
  bubble, `rails` otherwise (a conic that meets the ground ends in an impact). 24 debris vessels at most;
  uncontrollable fragments under 50 kg expire after 60 s. Rails orbits are orbits of the centre of mass,
  with the same point-mass gravity as the integrator, so both hand-overs are exact (tested: no jump above
  a millimetre in either direction, 0.1 mm against the conic after the switch).
- **mustIntegrate**: the vessel facade's `needsIntegration`, another free vessel within 200 m (bounding
  spheres), throttle above zero with an armed engine, or RCS translation. An integrated vessel goes on
  rails after 0.5 s without force. A vessel on rails inside the bubble still has its attitude stepped
  (SAS, RCS couples) and is put back on its conic every step.
- **Terrain policy** (deterministic, only at step boundaries on the control-tick cadence): slot `pad` at
  start; slot `impact` = 3 km disc at the predicted impact point of the current patch, refreshed when it
  moves more than 500 m; slot `vessel:<id>` = 1.5 km disc under a controllable vessel below 2 km radar
  altitude, or below 50 km with a ground speed under 200 m/s; `prewarmCollision` (48 vertices per control
  tick) around the short-range touchdown prediction below 1,500 m. `terrainPending()` is non-null while any
  request is outstanding. Below 300 m radar altitude without final data warp is clamped to 1x (reason
  `'Terrain data loading'`, counted in `stats().terrainWarpClamps`).
- **Warp**: altitude limits, event look-ahead with automatic step-down and the reason in `warp.limitedBy`,
  refused while rotating faster than 0.5 deg/s or while anything in the bubble must integrate, drop to 1x
  on control input (rails levels), attitude frozen or tracking the SAS hold direction on rails. Nodes any
  number of revolutions ahead are events (tested 3.4 revolutions ahead).
- **Nodes**: the remaining delta-v vector is locked in inertial axes 60 s before the burn (or at throttle-up
  within 300 s of the node), reduced by the thrust actually delivered (RCS included), and the node completes
  below 0.1 m/s or when overshot with the throttle closed (`nodeCompleted` event, SAS falls back from
  `maneuver` to `stability`).
- **Milestones**: one generic evaluator (`src/sim/world/milestones.ts`) for every `MilestoneTrigger` kind,
  honouring `after`, each rule once. No milestone id and no mission rule in `src/sim` (asserted by a test
  that greps the source). Every record carries the standard data set: `ut, met, altitude, radarAltitude,
  latitudeDeg, longitudeDeg, speedOrbital, speedSurface, verticalSpeed, horizontalSpeed, mass, gLoad,
  peakG, gDose, peakGDose, ablatorFraction, rcsFraction, maxTempFraction, deltaVRemaining, stagesFired,
  incompleteQueries, terrainWarpClamps, vesselCount, surfaceGravity, propellantKg:<stageGroup>,
  propellantFraction:<stageGroup>` plus per kind: `peakDynamicPressure(+Altitude, +Ut)`; `stageIndex,
  vesselsSeparated`; `periapsisAltitude, apoapsisAltitude, eccentricity, inclinationDeg, period`;
  `predictedSoiUt, predictedPeriapsisAltitude`; `soiUt, predictedSoiUt, soiTimeError`;
  `touchdownVerticalSpeed, touchdownHorizontalSpeed, touchdownTiltDeg, tiltDeg, legs, legsBroken,
  legsIntact, distanceToLandingTarget, residentLevel, availableLevel, effectiveLevel, terrainComplete,
  surfaceWater, recoveryZoneDistance, recoveryZoneRadius, insideRecoveryZone, crewAlive, settledFor`;
  `surfaceStay, vesselsLeftOnSurface`; `entryUt, entrySpeed, entryFlightPathAngleDeg, entryLatitudeDeg,
  entryLongitudeDeg`; `crossingAltitude`; `chuteEnvelope (0 safe, 1 risky, 2 unsafe), deployAltitude,
  deployMach, deploySpeed, deployDynamicPressure`. Altitudes and speeds in the records and read-outs are
  those of the centre of mass.
- **Snapshots**: `snapshot()` places integrated vessels between their last two step states by the
  presentation fraction (position linearly, attitude by slerp) and bodies, rails and landed vessels exactly
  at the presentation time; `simUt - ut` is in [0, 1/120). Time is kept as a base instant plus whole steps,
  and body orientation and conic propagation take the two apart, so presented motion is uniform although
  a float64 `ut` at this epoch resolves only 1.2e-7 s. `peek()` is cached per state change; treat snapshots
  as read-only. At most 1,024 undrained events are kept.
- **Failure states**: crew lost (g-dose, impact) and every command part lost; the simulation carries on.
- **Debug mutators** (`setVesselState`, `setResource`, `setUt`) increment `cheatCounter`.

## Scenarios (`data/defs/scenarios`)

| Id | Start | Configuration |
|---|---|---|
| `lunar-direct` | pad, `startUt` 938240818.839663 = 2029-09-24T18:26:58.8Z (launch opportunity at +600 s, azimuth 99.40 deg), target `moon`, suggested landing 0.661471 N 23.435999 E | full stack, the 17 mission milestones as generic rules |
| `qa-leo` | state, 938242599.056 | third stage + lander + capsule in the parking orbit (4 stages fired) |
| `qa-translunar` | state, 938274718.073 | lander stack after the third stage is gone, on the way to a perilune near 100 km (5) |
| `qa-lunar-orbit` | state, 938524761.844 | lander stack in the 100 km lunar orbit (5) |
| `qa-powered-descent` | state, 938533590.327 | on the descent orbit, perilune 15 km up-range of the target, gear down (6) |
| `qa-lunar-surface` | landed at the target, 938534815.360 | lander on the surface (6) |
| `qa-trans-earth` | state, 938729608.507 | ascent stage + capsule outside the lunar SOI, 45 km vacuum perigee (7) |
| `qa-entry` | state, 938919949.236 | capsule 300 s before the 122 km interface, 45 km vacuum perigee, aimed at the Central Pacific zone (8) |
| `qa-drogues` | state, 938920858.606 | capsule under drogues at 7 km over the zone (9) |

The QA files are written by `tools/sim/captureScenarios.ts` from the nominal flight (`--check` verifies them;
they were up to date at hand-off) and have empty milestone lists. `ScenarioDef` has no field for resources,
so the stages that remain start with FULL tanks: the vehicle is heavier than at that point of the real
mission (for example 10.8 t instead of 1.1 t in the ascent stage of `qa-trans-earth`). The pilot takes over
from every one of them and flies the rest of the mission to splashdown (checked with `flyMission --scenario`).
After any change that moves the nominal trajectory, run the capture tool again.

`tools/sim/start-time.json` was re-computed with `--launch-kind either` for the final pad and target and is
reproduced exactly; the only difference to the lead's file is `landing.source`, which now names the scenario
file instead of `"argument"`. `tests/unit/sim-world/scenario.test.ts` asserts the three constraints with
`checkStartConstraints` and the values of `constraints`, and that the site and target coordinates match the
definitions.

## Pilot (`src/pilot`)

```ts
import { createMissionPilot, runHeadless, replayHeadless } from '@/pilot';

const pilot = createMissionPilot(defs, sim.scenario, { launchDelay?, pitchProgramme?, surfaceStay?, returnPlaneTiltDeg?, physicsWarp?, onLog? });
const run = await runHeadless(sim, pilot, { maxSimTime?, maxTicks?, until?, onTick?, clock?, awaitTerrain?, record? });
// run.reason: 'done' | 'pilotFailure' | 'missionFailed' | 'cheat' | 'nan' | 'simTimeLimit' | 'tickLimit' | 'until'
// run.inputLog -> replayHeadless(freshSim, run.inputLog, { ticks: run.stats.ticks }) reproduces the state hash

// In the browser (ARCHITECTURE 18.2):
let prevUt = sim.peek().simUt;
sim.advance(realDt, () => { const s = sim.peek(); sim.setControls(pilot.update(s, sim.commands, s.simUt - prevUt)); prevUt = s.simUt; });
```

`pilot.phase`, `pilot.done`, `pilot.failure` (reason text; every phase has a timeout), `pilot.log` (phase
transitions and notes), `pilot.report` (delta-v per maneuver, landing miss, margins). The pilot starts in
the phase that fits the state it finds, so it can be put on any QA scenario.

Phases: prelaunch (waits for the plane crossing by `readouts.launchWindow`) - ignition - vertical - pitch
programme - first-stage separation - closed-loop second stage (tower and fairing at 96 km) - cut-off -
parking coast (one revolution on rails) - TLI - trim on the third stage if the perilune is far off - MCC-1
(perilune and the plane over the landing target) - coast - MCC-2 - LOI - plane trim - deorbit (perilune
15 km, 350 km up-range) - PDI coast - braking (range-proportional law, cross-range nulled) - approach
(position nulled at 110 m) - terminal (vertical, 1 m/s) - 900 s on the surface - lift-off into a plane that
contains the departure direction - circularisation - TEI (node time, revolution and prograde delta-v chosen
for a 45 km perigee and the splash point) - TEC-1 (perigee and splash point) - later corrections (perigee
only) - capsule separation at 2,500 km - entry (SAS retrograde, roll only: lift up, lift down while a
skip-out threatens) - drogues at 7.5 km - mains at 3.2 km - splashdown.

Node planning uses only `addNode` / `setNode` and the predicted patches, one candidate per control tick,
400 evaluations at most per plan (`planner.ts`: compass search, bracketed root solve, regularised
least-squares Newton). The generic maneuver routine aligns on the maneuver marker, warps to the burn,
throttles down, stops short and trims with RCS.

## Mission log: the nominal flight (state hash d15d99aeaa315436)

Tiles: earth `ab20fdfc579d4015`, moon `d250015b4e1a23f8`. 7.876 days of simulation time; 617,944 physics
steps, 84,209 rails advances, 238,696 control ticks; `terrain.incompleteQueries` 0; `cheatCounter` 0;
start kind `pad`; no NaN; no phase timeout; no part destroyed and no joint broken on the flown vessel.

| # | Milestone | MET | Measured | Gate (ARCHITECTURE 18.1) |
|---|---|---|---|---|
| 1 | LIFTOFF | 0 | surface speed 0.017 m/s; inertial 439.3 m/s | < 0.1 m/s; 439 +/- 2 m/s |
| 2 | MAX_Q | 0:01:20 | 28.35 kPa at 11.0 km | 20-40 kPa, no structural failure |
| 3 | STAGE_SEP_1 | 0:02:42 | 77.0 km, 2,064 m/s, peak 3.81 g; 1 debris vessel | leaves debris |
| 3 | FAIRING_JETTISON | 0:03:02 | 96.0 km; 5 debris vessels (tower, 4 panels) | above 80 km, leaves debris |
| 3 | STAGE_SEP_2 | 0:09:40 | 183.8 km, 7,819 m/s; 1 debris vessel | leaves debris |
| 4 | EARTH_ORBIT | 0:09:40 | 181.0 x 257.8 km, incl. 20.89 deg (0.004 deg off the Moon's plane); one revolution (5,324 s) on rails within 0.44 mm of Kepler at 9,595 samples | Pe >= 160 km, Ap <= 400 km; 1 m |
| 5 | TLI_COMPLETE | 2:57:20 | Moon encounter predicted 67.4 h ahead; TLI 3,149.6 m/s | patches contain a Moon encounter |
| 6 | MOON_SOI_ENTER | 2 d 15:09:49 | 0.000 s from the time predicted an hour and more before | +/- 2 s |
| 7 | LUNAR_ORBIT | 3 d 06:42:12 | 94.4 x 105.9 km, e 0.0031 (retrograde, incl. 157.0 deg) | e < 0.05, Pe > 60 km |
| 8 | LUNAR_TOUCHDOWN | 3 d 09:29:53 | **1.21 m from the target**; data level 12 of 12 (deepest regional level), resident on all 4,015 control ticks below 2,000 m; 1.00 m/s down, 0.017 m/s across, tilt 0.36 deg, 4 of 4 legs; still landed after 600 s, moved 0.0004 mm | <= 1,500 m; deepest level resident throughout; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; landed after 600 s |
| 9 | LUNAR_LIFTOFF | 3 d 09:45:04 | after 916 s on the surface; the descent stage is still a landed vessel at the end of the mission | descent stage stays behind |
| 10 | MOON_SOI_EXIT | 5 d 03:25:03 | TEI 898.5 m/s after 12 revolutions of waiting | reached |
| 10 | EARTH_PERIGEE_TARGETED | 5 d 03:34:08 | 58.2 km when the rule first held (during the TEC-1 trim), 44.9 km at the entry interface | 30-60 km |
| 11 | ENTRY_INTERFACE | 7 d 20:33:50 | 122.0 km, 11.010 km/s; peak 5.86 g; g-dose 0; ablator left 58.1 %; capsule RCS left at drogues 93.4 % | 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 % |
| 12 | DROGUE_DEPLOY | 7 d 20:43:55 | 7,445 m, Mach 0.43, 4.9 kPa: envelope safe | inside the envelope, no chute failure |
| 12 | MAIN_DEPLOY | 7 d 20:45:13 | 3,174 m, 49.6 m/s, 1.1 kPa: envelope safe | inside the envelope, no chute failure |
| 13 | SPLASHDOWN | 7 d 20:51:37 | **15.30 N 141.51 W, on water, 1,157 km from the centre of "Central Pacific" (radius 2,000 km)**; 7.82 m/s; crew alive; floating at 10.0 deg after 30 s (12.3 deg at most) | water, inside a recovery zone; <= 9.5 m/s; crew alive; upright after 30 s |
| 14 | Budgets | | 7.88 days; no negative resource; slowest step in the last 60 s before lunar contact 0.75-1.22 ms, before splashdown 0.31-0.55 ms (see "Step cost") | < 14 days; no step above 2 ms |

Delta-v flown: TLI 3,149.6 (+ 19.0 trim on the third stage), MCC-1 2.63, MCC-2 0.17, LOI 883.6, plane trim
1.42 (target 65 m off the ground track before the deorbit burn), deorbit 20.6, powered descent 1,880.6
(braking from 353.6 km at 15.2 km and 1,696 m/s; the approach and terminal phases are 58 s of that, about
95 m/s), lunar ascent and circularisation 1,950.3, TEI 898.5, TEC-1 6.97; later corrections not needed.

Propellant and delta-v margin of every stage (what it still held when it was dropped):

| Stage | Propellant left | Delta-v left |
|---|---|---|
| Meridian M-1 | 0.46 % (burnt to depletion) | 28 m/s |
| Meridian M-2 | 2.27 % | 301 m/s |
| Meridian M-3 (after TLI and trim) | 7.44 % | 388 m/s |
| Heron descent stage (after landing) | 14.0 % (5,040 kg) | 770 m/s |
| Heron ascent stage (at capsule separation) | 10.4 % (1,128 kg) | 561 m/s |
| Capsule RCS | 93.4 % at drogue deployment | |
| Capsule ablator (150 kg) | 58.1 % | |

Clearance after every separation (sampled at every control tick for 30 s; positive from / closest after
0.5 s): clamps 0 s / 0.29 m; M-1 0.23 s / 1.14 m; escape tower 0.37 s / 2.12 m; fairing panels vs stack
0.33 s / 0.69 m, panel vs panel 3.25 m, tower vs panels 6.3 m; M-2 0.27 s / 0.29 m; M-3 0 s / 0.29 m;
descent stage at lunar lift-off 0 s / 0.13 m; ascent stage vs capsule 0.10 s / 1.34 m; apex cover 0 s /
7.55 m. They agree with the sim-vessel table.

Debris: M-1 hits the sea 565 km down-range; tower and panels 612-669 km; M-3 hits the Moon (far side);
the ascent stage and its engine burn up over the Pacific; the apex cover falls beside the capsule.

### Perturbed starts (`tests/mission/perturbed.test.ts`, all complete, all gates of the test met)

| Variant | Parking orbit | Landing miss | Touchdown | TEI wait | Splash point | From zone centre (radius 2,000 km) | M-2 / M-3 / descent / ascent delta-v left | Days |
|---|---|---|---|---|---|---|---|---|
| launch 60 s late | 181.0 x 257.8 km | 1.62 m | 1.00 m/s | 12 rev | 15.67 N 141.05 W | 1,193 km | 295 / 389 / 768 / 563 m/s | 7.88 |
| every liquid engine at 97 % thrust | 181.3 x 243.9 km | 1.36 m | 1.00 m/s | 1 rev | 15.68 N 142.38 W | 1,215 km | 229 / 386 / 778 / 545 m/s | 6.86 |
| sloppy pitch programme | 177.5 x 320.9 km | 1.93 m | 1.00 m/s | 4 rev | 14.81 N 141.94 W | 1,111 km | 293 / 387 / 692 / 567 m/s | 6.85 |

Peak entry load 5.7-6.0 g, ablator left 58-61 %, capsule RCS left 93 % in all three.

### Re-entry corridor (`tests/mission/entry-corridor.test.ts`, capsule alone, eastbound over the equator)

| Vacuum perigee | Outcome | Down-range entry point to splash | Peak g | Ablator left | RCS left at drogues |
|---|---|---|---|---|---|
| 10 km | crew lost (fatal deceleration) | - | 11.5 | - | - |
| 20 km | landed | 2,283 km | 9.69 | 69.2 % | 94.6 % |
| 30 km | landed | 2,572 km | 7.95 | 68.1 % | 94.3 % |
| 40 km | landed | 3,367 km | 6.34 | 65.9 % | 94.1 % |
| 45 km (nominal) | landed | 3,412 km | 5.66 | 64.9 % | 92.9 % |
| 50 km | landed | 3,259 km | 4.99 | 64.0 % | 92.8 % |
| 60 km | landed | 3,678 km | 4.28 | 60.7 % | 92.4 % |
| 70 / 80 / 90 km | skips out | - | 1.1 / 0.3 / 0.1 | - | - |

Finer probes: 62 and 64 km land (4,007 / 4,736 km), 66 km skips. The whole gate band of 30-60 km is
survivable. Ablator: with the 200 kg of the wave-1 data the nominal entry used 26-31 %, so the capacity was
retuned to 150 kg as sim-design 10.1 instructs (dry mass + 50 kg, same capsule mass); now 35 % in the sweep
and 42 % in the mission's entry.

## Timings, step cost, determinism

- Nominal flight alone: 20.7-23 s of wall clock (target 90 s, limit 5 min); 12-16 microseconds per step
  on average (limit 100). Inside the mission suite, with four other test files flying at the same time,
  24-37 s. The whole suite: 70-105 s.
- **Step cost before the landings.** Somewhere in every flight single steps take 4-8 ms (not at the same
  step from run to run: garbage collection or the machine). To keep the 2 ms gate about the simulation
  and not about the scheduler, the test times every step of the last 60 s before first contact in both
  of its flights (pilot and replay pass through the same steps) and asserts the element-wise minimum:
  0.75-1.22 ms before lunar contact, 0.31-0.55 ms before the water, in seven runs of the test. The
  single-flight maxima in those windows were 0.75-1.7 ms and 0.4-0.78 ms over the same runs (logged),
  i.e. below 2 ms as well, with less margin. The steps of about 1 ms are the ones that refresh the patch
  prediction or issue a terrain request.
- **Determinism.** The pilot flight, the replay of its input log on a Sim whose tile I/O answers late and
  out of order (3,610 delayed reads), a flight in another process (`flyMission`) and every suite run end
  in `d15d99aeaa315436`. The golden file stores the hash with the content hashes of the tile sets and
  the Node version; the test checks the tile hashes first and says to record anew after a re-bake.
  Physics warp is pacing only: changing where the pilot uses it left the hash unchanged.
- **Through `Sim.advance`** (`tests/mission/browser-loop.test.ts`, `tools/sim/flyFrames.ts`): the pilot
  completes the mission frame by frame at 60 Hz (landing miss 1.3 m, splash inside the zone). On a leg
  without rails warp the state is bit-identical to the headless loop after the same control ticks; with
  rails warp the two loops cut time differently and the flights agree to a few kilometres at splashdown.
  **Real time: 189,717 frames = 52.7 minutes at 60 Hz** (ARCHITECTURE 18.2 estimated 20-25). Largest
  items, minutes: trans-Earth coast 4.7, entry 3.6, lunar braking 3.2, parking orbit 3.0, coast to LOI 2.9,
  wait for TEI 2.5, PDI coast 2.5, coast to TLI 2.0, lunar ascent 1.7, second stage 1.7, coast to the Moon
  1.7, TLI burn 1.6, under the mains 1.6. Burns run at 4x physics warp; the coasts are held back by the
  altitude limits and the 4 s look-ahead of the warp rules, about half a minute per decade of step-down.

## Tests

`tests/unit/sim-world` (60): `rails` (revolution vs Kepler, coasting stays on the conic, hand-over
exactness both ways, SOI entry at the predicted time, SOI exit), `warp` (top level toward the Moon and back,
node 3.4 revolutions ahead, 100,000x, altitude limits, drop on input, refusal while rotating, frozen and
tracking attitude, pad), `interpolation` (60 / 144 / 240 Hz: powered flight on the interpolated step states
to 1e-6, landed vessel uniform to 1e-6, rails, `simUt - ut` in [0, 1/120), same state as step(), dropped
surplus time, control-tick cadence), `scenario` (start constraints, start-time.json, every QA scenario
self-consistent), `milestones` (four scenarios with their own rule names through the evaluator, no
mission id in the source), `commands` (nodes and burn bookkeeping, auto-completion, target, navball,
staging lock-out, debug counts as cheating, state hash, event queue, crew loss, debris tiers and fates),
`protocol` (prompt vs late tile I/O gives the same hash for the powered descent and for the entry; a run
that does not await is detected by `incompleteQueries` and the warp clamp, and recovers; replay of an
input log), `surface` (lander on real level-12 lunar terrain: pushed with RCS it flexes 6 mm and rests;
600 s without creep; capsule under the mains into the real ocean and three minutes on the swell),
`browserLoop` (pilot through `advance`).

`tests/mission` (30): `full-mission` (every gate above, replay, golden hash), `ascent`, `perturbed`,
`entry-corridor`, `browser-loop`; `harness.ts` holds the observer.

## Deviations from the brief, and what wave-1 reality decided

- **`incompleteQueries`** counts a step when a full-tier vessel is within contact range of the ground or
  in the "terrain regime" that also triggers the vessel disc (below 2 km radar altitude, or below 50 km with
  a ground speed under 200 m/s) and the data at its sub-point is not final. The brief's wording (any radar
  query below 50 km) cannot be met together with its rule that no disc is swept under an orbital pass: the
  15 km perilune pass of the descent orbit reads the radar over data that is deliberately not loaded.
- **Entry down-range.** The brief expected 2,000-2,500 km; flown on the lift-vector rule it is about
  3,300 km eastbound and 2,900 km on a southbound track for a 45 km perigee (table above). The pilot aims
  with `entryDownRange(heading) = 2,900 km + 400 km x sin(heading)`. The entry is flown without a range
  bias in the roll: open loop.
- **`orbit` start kind**: inclination, node and argument of periapsis refer to the BCI axes (parallel to
  ROOT), not to the equator of the body.
- **EARTH_ORBIT** has `after: STAGE_SEP_2`, so it is recorded for the coasting stack and not for an
  instant of the second-stage burn.
- **100,000x** is reached only when the next event is more than about 4.6 days away (the 4 s look-ahead of
  the warp rules); on the 2.6-day legs of this mission the top level is 10,000x.
- **Runner**: it awaits `terrainPending()` before every step, not only before control ticks (the same
  thing, since requests are issued at control-tick boundaries).
- **The 2 ms step gate** is asserted on the minimum over two flights of the same steps (see "Step cost").
- **Lift side**: the capsule's lift vector is on its -Z side (`navball.markers.liftVector`), as sim-vessel
  built it.
- Changes in wave-1 code and data, all additive or retuning: `propagate` / `propagateInto` in
  `src/sim/orbit/kepler.ts` take an optional time offset (split time for precision); `vesselReadouts` in
  `src/sim/vessel/facade.ts` takes optional precomputed staging info; `kestrel-capsule.json` ablator 200 ->
  150 kg and dry mass 4,590 -> 4,640 kg with the three sim-vessel tests that quote them. `public.ts`,
  geometric part data and `data/defs/visuals/shared` are untouched.

Requests filed: none. No request against `src/sim`, `src/pilot` or part data was open at hand-off.

## Known weaknesses

- **The splash point is not centred.** Four full flights came down 1,111-1,215 km from the centre of a zone
  of 2,000 km radius: inside by about 800 km, never close to the middle. The return plane can be tilted
  only about 12 degrees out of the Moon's orbit plane, the planner weighs splash miss against delta-v, the
  entry range is open loop (model within about 300 km of what is flown), and only three perturbations
  were tried. A larger dispersion could leave the zone.
- **Daylight at splashdown is not achieved**: the Sun is about 2 degrees above the horizon there at
  arrival (dawn). It is a stated preference, not a gate; the planner prefers daylight only between
  otherwise equal options.
- **Real time of the browser mission is 52.7 minutes**, more than twice the architecture's estimate.
- **Slow single steps of 4-8 ms occur in every flight** outside the two measured windows; in the browser
  such a step is half a frame.
- **QA scenarios start with full tanks** (see Scenarios), and have to be captured again whenever the
  nominal trajectory changes.
- **The golden hash** belongs to the tile content and most likely to the JavaScript engine's math
  functions (recorded on Node v24.16.0); another Node version has not been tried.
- **Landed stability** is a hold: once at rest a vessel rides the body, so "no creep for 600 s" holds by
  construction; contact dynamics on real terrain are exercised only by the touchdown itself and by the
  few seconds of the push test.
- **The revolution-vs-Kepler check in the mission** compares the world's rails propagation with the same
  propagator family; the independent check against RK4 is in the sim-orbits suite.
- **Vessel cycling**: only the refusal is tested; no scenario has two controllable vessels.
- **The pilot** waits up to 26 lunar revolutions for the return geometry (12 in the nominal flight, 25.5 h),
  lands with 58 s of hover-like approach, and flies no abort. The `peakGDose` of every survivable entry is
  0 because sim-vessel's dose only accumulates above its threshold.
