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

This note is the state after the review fixes (section "What the review changed" at the end lists them).

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

After a change that moves the nominal trajectory, two files follow it, in this order: the QA scenarios
(`captureScenarios.ts`; the mission test compares the files with its own flight and fails until they are
captured again) and the golden hash (`MISSION_UPDATE_GOLDEN=1`).

State at hand-off (all through the load gate, machine shared with other agents):

| Command | Result |
|---|---|
| typecheck:paths (five paths) | OK |
| unit suites (34 files) | 356 tests pass, 33-35 s; `tests/unit/sim-world` is 11 files / 71 tests (37 s) |
| `npm run test:mission` (5 files, 31 tests) | passes, 66-77 s wall; run twice in a row on two occasions after the last change of the flight, state hash `df7f7684eabc0028` every time (= `tests/mission/golden.json`) |
| boundaries | 7 tests pass |

The mission tests need the baked tile sets under `data/tiles/{earth,moon}`; `tools/sim/realWorld.ts` throws
when a manifest is missing (the tests fail, they do not skip). There is no synthetic-terrain switch in the
mission tests. The flat stand-in provider in `tests/unit/sim-world/helpers.ts` (`flatTerrain`) is used only by
unit tests of world logic that is not about terrain (rails, warp, interpolation, commands, milestones, debris,
the pilot's trans-Earth corrections). Each mission test writes its numbers to `out/mission/*.json` (not
committed).

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
  bubble, `rails` otherwise (a conic that meets the ground ends in an impact). Rails orbits are orbits of
  the centre of mass, with the same point-mass gravity as the integrator, so both hand-overs are exact
  (tested: no jump above a millimetre in either direction, 0.1 mm against the conic after the switch).
- **Vessel age, expiry, cap, cycling.** `VesselSnapshot.age` is the world time minus the time the vessel
  came into being (scenario start, or the step whose separation made it), in every tier, during rails warp
  and at the presentation time of `snapshot()`. Uncontrollable pieces under 50 kg are removed 60 s after
  they came off (`vesselRemoved`, reason `expired`); more than 24 uncontrollable vessels: the oldest
  outside the bubble goes (`limit`; pieces inside the bubble are never removed for the cap).
  `cycleActiveVessel` switches between controllable vessels of the bubble; nodes do not follow the switch.
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
  number of revolutions ahead are events (tested 3.4 revolutions ahead). The crossing of a level's own
  altitude-limit shell is an event for that level alone: falling through the limits costs one level at a
  time, four seconds of real time ahead of each shell (10 000x -> 1 000x -> 100x -> 50x -> 10x -> 5x on the
  way home), and a level a player holds is not taken away by the shell of a higher one.
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
- **Scenario starts**: `pad`, `orbit`, `landed`, `state` with `stagesAlreadyFired`; `ScenarioDef.resources`
  (part instance id -> resource id -> kg; request sim-world-pilot-1) sets the tank, thruster-propellant
  and ablator amounts of the start vessel before it is placed (mass properties and the heat shield's
  `ablatorFraction` follow; parts already dropped are passed over).
- **Failure states**: crew lost (g-dose, impact) and every command part lost; the simulation carries on.
- **Debug mutators** (`setVesselState`, `setResource`, `setUt`) increment `cheatCounter`.

## Scenarios (`data/defs/scenarios`)

| Id | Start | Configuration and what is on board |
|---|---|---|
| `lunar-direct` | pad, `startUt` 938240818.839663 = 2029-09-24T18:26:58.8Z (launch opportunity at +600 s, azimuth 99.40 deg), target `moon`, suggested landing 0.661471 N 23.435999 E | full stack, full tanks, the 17 mission milestones as generic rules |
| `qa-leo` | state, 938242599.056 | third stage + lander + capsule in the parking orbit (4 stages fired); 154.1 t, third stage full |
| `qa-translunar` | state, 938274720.740 | lander stack after the third stage is gone, on the way to a perilune near 100 km (5); 56.7 t |
| `qa-lunar-orbit` | state, 938524763.062 | lander stack in the 100 km lunar orbit (5); 44.2 t, 23.4 t of descent propellant (2,667 m/s in that stage) |
| `qa-powered-descent` | state, 938533590.779 | on the descent orbit, perilune 15 km up-range of the target, gear down (6); 43.8 t |
| `qa-lunar-surface` | landed at the target, 938534815.479 | lander on the surface (6); 25.7 t, 5,045 kg of descent propellant, ascent stage full |
| `qa-trans-earth` | state, 938729649.036 | ascent stage + capsule outside the lunar SOI, 45 km vacuum perigee (7); 7.6 t, 1,127 kg of propellant in the ascent stage |
| `qa-entry` | state, 938919950.146 | capsule 300 s before the 122 km interface, 45 km vacuum perigee, aimed at the Central Pacific zone (8); 5.0 t, ablator 150 kg |
| `qa-drogues` | state, 938920859.236 | capsule under drogues at 7 km over the zone (9); 4.87 t, ablator 87.1 kg, thruster propellant 139.9 kg |

The QA files are written by `tools/sim/captureScenarios.ts` from the nominal flight and have empty milestone
lists. Each one records, besides the state and the time, the resources every remaining part held at that
point (kg, to the gram), so the vehicle has the mass of the mission: the landed start is the 25.7 t lander
of the nominal touchdown, not a 56.8 t one with full tanks (a reviewer's drop tests: at mission mass the
legs hold up to 3.5 m/s, at the full-tank mass three of four broke at 2.5 m/s).
`tests/mission/full-mission.test.ts` compares the eight files with the captures of the flight it has just
flown, so they cannot go stale unnoticed; `tests/unit/sim-world/scenario.test.ts` checks that every start
vessel holds exactly the listed amounts and that the masses are those of the mission. The pilot takes over
from every one of them and flies the rest of the mission to splashdown (re-checked for all eight with
`flyMission --scenario`: landing miss 0.5-3.2 m where a landing is still ahead, splash 15.1-15.8 N 140.8-141.8 W).
Not captured: part temperatures (a start under the drogues has a cold heat shield) and the attitude (the
start attitude is prograde, retrograde or vertical).

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
for a 45 km perigee and the splash point) - TEC-1 (perigee and splash point) - TEC-2 / TEC-3 at 150 000 km
and 50 000 km (flown only when the perigee has left its band of 2.5 km or the predicted splash point has
drifted 50 km; then perigee and splash point again) - capsule separation at 2,500 km - entry (SAS
retrograde, roll only: lift up, lift down while a skip-out threatens) - drogues at 7.5 km - mains at 3.2 km -
splashdown.

What the pilot steers by (all of it is in the snapshot):

- **Powered descent**: `readouts.landingTarget`. While the vehicle moves over the ground (above 1 m/s) the
  target is taken from `downRange` / `crossRange` on the ground track; once it is nearly stopped, from
  `distance` and `bearingDeg`. The braking law, the approach and the terminal descent work on nothing else
  for the target's position, and the pilot's `landingMiss` is the panel's `distance` at first contact
  (the mission tests assert it is within 1 m of the touchdown record's own distance).
- **Deorbit**: the latitude and longitude of the periapsis marker of the planned descent orbit against the
  target's (perilune 15 km high, one braking distance up-range).
- **Recovery targeting**: the latitude and longitude of the `atmosphereEntry` marker of the planned (or
  current) return, carried along the ground track there by the nominal entry down-range; the same marker
  the landing panel shows as `landingTarget.predicted` for the current trajectory (asserted equal).
- Lunar arrival plane and pass timing: the patches' conics and `bodies[].qFixedToRoot` / `spinRoot`.

Node planning uses only `addNode` / `setNode` and the predicted patches, one candidate per control tick,
400 evaluations at most per plan (`planner.ts`: compass search, bracketed root solve, regularised
least-squares Newton). The generic maneuver routine aligns on the maneuver marker, warps to the burn,
throttles down, stops short and trims with RCS.

## Mission log: the nominal flight (state hash df7f7684eabc0028)

Tiles: earth `ab20fdfc579d4015`, moon `d250015b4e1a23f8`. 7.876 days of simulation time; 593,612 physics
steps, 65,725 rails advances, 214,129 control ticks; `terrain.incompleteQueries` 0; `cheatCounter` 0;
start kind `pad`; no NaN; no phase timeout; no part destroyed and no joint broken on the flown vessel.

| # | Milestone | MET | Measured | Gate (ARCHITECTURE 18.1) |
|---|---|---|---|---|
| 1 | LIFTOFF | 0 | surface speed 0.017 m/s; inertial 439.3 m/s | < 0.1 m/s; 439 +/- 2 m/s |
| 2 | MAX_Q | 0:01:20 | 28.35 kPa at 11.0 km | 20-40 kPa, no structural failure |
| 3 | STAGE_SEP_1 | 0:02:42 | 77.0 km, 2,064 m/s, peak 3.81 g; 1 debris vessel | leaves debris |
| 3 | FAIRING_JETTISON | 0:03:02 | 96.0 km; 5 debris vessels (tower, 4 panels) | above 80 km, leaves debris |
| 3 | STAGE_SEP_2 | 0:09:40 | 183.8 km, 7,819 m/s; 1 debris vessel | leaves debris |
| 4 | EARTH_ORBIT | 0:09:40 | 181.0 x 257.8 km, incl. 20.89 deg (0.004 deg off the Moon's plane); one revolution (5,324 s) on rails within 0.44 mm of Kepler at 8,034 samples | Pe >= 160 km, Ap <= 400 km; 1 m |
| 5 | TLI_COMPLETE | 2:57:20 | Moon encounter predicted 67.4 h ahead; TLI 3,149.6 m/s | patches contain a Moon encounter |
| 6 | MOON_SOI_ENTER | 2 d 15:09:50 | 0.000 s from the time predicted an hour and more before | +/- 2 s |
| 7 | LUNAR_ORBIT | 3 d 06:42:13 | 94.3 x 105.7 km, e 0.0031 (retrograde, incl. 157.0 deg) | e < 0.05, Pe > 60 km |
| 8 | LUNAR_TOUCHDOWN | 3 d 09:29:54 | **1.19 m from the target**, where the data level is 12 of 12 (the deepest regional level); 1.00 m/s down, 0.017 m/s across, tilt 0.36 deg, 4 of 4 legs; still landed after 600 s, moved 0.0004 mm. Final descent (below 2,000 m radar altitude, starting 12.7 km from the target): on all 3,999 control ticks everything the tile set offers under the vehicle was resident and final; that is level 9 out there, where no finer data exists, and level 12 on all 2,452 ticks within 1,500 m of the target | <= 1,500 m; deepest level available, data resident throughout; < 2.5 m/s; < 1.0 m/s; < 12 deg; legs intact; landed after 600 s |
| 9 | LUNAR_LIFTOFF | 3 d 09:45:05 | after 916 s on the surface; the descent stage is still a landed vessel at the end of the mission | descent stage stays behind |
| 10 | MOON_SOI_EXIT | 5 d 03:25:46 | TEI 898.5 m/s after 12 revolutions of waiting | reached |
| 10 | EARTH_PERIGEE_TARGETED | 5 d 03:34:49 | 58.3 km when the rule first held (during the TEC-1 trim), 44.8 km at the entry interface | 30-60 km |
| 11 | ENTRY_INTERFACE | 7 d 20:33:51 | 122.0 km, 11.010 km/s; peak 5.88 g; g-dose 0; ablator left 58.1 %; capsule RCS left at drogues 93.3 % | 10.9-11.1 km/s; < 10 g; dose < 5; ablator > 25 %; RCS > 20 % |
| 12 | DROGUE_DEPLOY | 7 d 20:43:56 | 7,444 m, Mach 0.43, 4.9 kPa: envelope safe | inside the envelope, no chute failure |
| 12 | MAIN_DEPLOY | 7 d 20:45:14 | 3,174 m, 49.6 m/s, 1.1 kPa: envelope safe | inside the envelope, no chute failure |
| 13 | SPLASHDOWN | 7 d 20:51:37 | **15.34 N 141.53 W, on water, 1,162 km from the centre of "Central Pacific" (radius 2,000 km)**; 7.82 m/s; crew alive; floating at 9.0 deg after 30 s (12.9 deg at most) | water, inside a recovery zone; <= 9.5 m/s; crew alive; upright after 30 s |
| 14 | Budgets | | 7.88 days; no negative resource; slowest step in the last 60 s before lunar contact 0.62-0.69 ms, before splashdown 0.28-0.31 ms (see "Step cost") | < 14 days; no step above 2 ms |

Delta-v flown: TLI 3,149.6 (+ 19.0 trim on the third stage), MCC-1 2.61, MCC-2 0.18, LOI 883.6, plane trim
1.20 (target 196 m off the ground track before the deorbit burn), deorbit 20.6, powered descent 1,880.4
(braking from 353.6 km at 15.4 km and 1,696 m/s; the approach and terminal phases are 58 s of that, about
95 m/s), lunar ascent and circularisation 1,950.7, TEI 898.5, TEC-1 6.96; TEC-2 and TEC-3 not needed.

Propellant and delta-v margin of every stage (what it still held when it was dropped):

| Stage | Propellant left | Delta-v left |
|---|---|---|
| Meridian M-1 | 0.46 % (burnt to depletion) | 28 m/s |
| Meridian M-2 | 2.27 % | 301 m/s |
| Meridian M-3 (after TLI and trim) | 7.44 % | 388 m/s |
| Heron descent stage (after landing) | 14.0 % (5,045 kg) | 771 m/s |
| Heron ascent stage (at capsule separation) | 10.4 % (1,128 kg) | 561 m/s |
| Capsule RCS | 93.3 % at drogue deployment | |
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
| launch 60 s late | 181.0 x 257.8 km | 1.30 m | 1.00 m/s | 12 rev | 15.36 N 142.05 W | 1,173 km | 295 / 388 / 768 / 553 m/s | 7.88 |
| every liquid engine at 97 % thrust | 181.3 x 243.9 km | 1.99 m | 1.00 m/s | 1 rev | 15.83 N 142.49 W | 1,235 km | 229 / 386 / 778 / 548 m/s | 6.86 |
| sloppy pitch programme | 177.5 x 320.9 km | 1.19 m | 1.00 m/s | 4 rev | 14.92 N 142.04 W | 1,126 km | 293 / 387 / 692 / 567 m/s | 6.85 |

Peak entry load 5.8-6.0 g, ablator left 58-61 %, capsule RCS left 93 % in all three. In the late launch the
first trans-Earth correction left the perigee 3.8 km off (41.2 km at 150 000 km), so TEC-2 was flown there
(10.1 m/s: perigee back to 45.0 km, predicted splash from 1,008 to 963 km from the zone centre).

Four more variants were flown once with `flyMission` after the review fixes (not in the suite), all to
splashdown with `incompleteQueries` 0: thrust 95 % (landing miss 1.97 m, splash 1,141 km from the zone
centre), thrust 103 % (1.02 m, 1,146 km), launch 120 s late (0.62 m, 1,066 km), sloppy programme and 30 s
late (0.55 m, 992 km).

### Re-entry corridor (`tests/mission/entry-corridor.test.ts`, capsule alone, eastbound over the equator)

| Vacuum perigee | Outcome | Down-range entry point to splash | Peak g | Ablator left | RCS left at drogues |
|---|---|---|---|---|---|
| 10 km | crew lost (fatal deceleration) | - | 11.5 | - | - |
| 20 km | landed | 2,284 km | 9.69 | 69.2 % | 94.5 % |
| 30 km | landed | 2,578 km | 7.95 | 68.1 % | 94.3 % |
| 40 km | landed | 3,367 km | 6.34 | 65.9 % | 94.0 % |
| 45 km (nominal) | landed | 3,413 km | 5.66 | 64.9 % | 92.9 % |
| 50 km | landed | 3,259 km | 4.99 | 64.0 % | 92.8 % |
| 60 km | landed | 3,681 km | 4.28 | 60.7 % | 92.4 % |
| 70 / 80 / 90 km | skips out | - | 1.1 / 0.3 / 0.1 | - | - |

Finer probes: 62 and 64 km land (4,002 / 4,748 km), 66 km skips. The whole gate band of 30-60 km is
survivable. Ablator: with the 200 kg of the wave-1 data the nominal entry used 26-31 %, so the capacity was
retuned to 150 kg as sim-design 10.1 instructs (dry mass + 50 kg, same capsule mass); now 35 % in the sweep
and 42 % in the mission's entry.

## Timings, step cost, determinism

- Nominal flight alone: 16.5 s of wall clock in its own process (target 90 s, limit 5 min); 12.5
  microseconds per step on average (limit 100). Inside the mission suite, with four other test files flying
  at the same time, 23-26 s and 16-18 microseconds. The whole suite: 66-77 s.
- **Step cost before the landings.** Somewhere in every flight single steps take 4-8 ms (not at the same
  step from run to run: garbage collection or the machine; 6.4 and 6.8 ms in the last two flights). To keep
  the 2 ms gate about the simulation and not about the scheduler, the test times every step of the last
  60 s before first contact in both of its flights (pilot and replay pass through the same steps) and
  asserts the element-wise minimum: 0.62-0.69 ms before lunar contact and 0.28-0.31 ms before the water in
  three runs of the test. The single-flight maxima in those windows were 0.74-0.95 ms in five of the six
  flights and 2.14 ms in one (a pause: the same step took at most 0.65 ms in the other flight; other
  agents' GPU tests were running), and 0.50-0.86 ms before the water. The steps of about 1 ms are the
  ones that refresh the patch prediction or issue a terrain request. (The reviewer accepted the two-flight
  reading.)
- **Determinism.** The pilot flight, the replay of its input log on a Sim whose tile I/O answers late and
  out of order (3,628 delayed reads), a flight in another process (`flyMission`) and every suite run end
  in `df7f7684eabc0028`. The golden file stores the hash with the content hashes of the tile sets and
  the Node version; the test checks the tile hashes first and says to record anew after a re-bake.
  Physics warp is pacing only: it changes which steps share a frame, never the steps.
- **Through `Sim.advance`** (`tests/mission/browser-loop.test.ts`, `tools/sim/flyFrames.ts`): the pilot
  completes the mission frame by frame at 60 Hz (landing miss 1.3 m, splash inside the zone), with and
  without awaiting the terrain (`--no-await`: the same 17 milestones, `incompleteQueries` 0). On a leg
  without rails warp the state is bit-identical to the headless loop after the same control ticks; with
  rails warp the two loops cut time differently and the flights agree to a few kilometres at splashdown.
  **Real time: 161,656 frames = 44.9 minutes at 60 Hz** (ARCHITECTURE 18.2 estimated 20-25; request
  sim-world-pilot-2 asks for the text to be corrected). It cannot be 25 minutes with this flight plan:
  95,924 frames (26.6 min) run the 594,192 physics steps, which are 82.5 minutes of flight that must be
  integrated (ascent, burns, alignment turns, proximity after separations, entry, parachutes) and would be
  20.6 minutes even if every one of them ran at 4x; 65,732 frames (18.3 min) advance on rails, where every
  step down a warp level waits out the four seconds of real-time look-ahead of sim-design 5.3 and the
  185 km parking orbit admits 50x at most. Largest items, minutes: entry 3.2 (ten minutes of atmosphere at
  4x), lunar braking 2.7 (4x above 2 km of radar altitude, real time below), parking orbit 2.7, wait for
  TEI 2.5, trans-Earth coast 1.9, lunar ascent 1.7, PDI coast 1.7, second stage 1.7, coast to LOI 1.7,
  coast to the Moon 1.7, coast to TLI 1.6, TLI burn 1.6, on the water 1.6, the ten minutes next to the
  dropped third stage 1.6, LOI burn 1.4. The test asserts under 50 minutes. (Before the review fixes it was 52.7 minutes.)

## Tests

`tests/unit/sim-world` (71): `rails` (revolution vs Kepler, coasting stays on the conic, hand-over
exactness both ways, SOI entry at the predicted time, SOI exit), `warp` (top level toward the Moon and back,
one level per altitude-limit shell and no level lost to a higher one's shell, node 3.4 revolutions ahead,
100,000x, altitude limits, drop on input, refusal while rotating, frozen and tracking attitude, pad),
`interpolation` (60 / 144 / 240 Hz: powered flight on the interpolated step states to 1e-6, landed vessel
uniform to 1e-6, rails, `simUt - ut` in [0, 1/120), same state as step(), dropped surplus time, control-tick
cadence), `scenario` (start constraints, start-time.json, every QA scenario self-consistent, start resources
and masses of the mission, `ScenarioDef.resources` semantics), `milestones` (four scenarios with their own
rule names through the evaluator, no mission id in the source), `commands` (nodes and burn bookkeeping,
auto-completion, target, navball, staging lock-out, debug counts as cheating, state hash, event queue, crew
loss, debris tiers and fates), `debris` (vessel age in every tier, during rails warp, in the presented
frame and across `debug.setUt`; expiry of pieces under 50 kg at 60 s inside and outside the bubble; the
24-vessel cap removing the oldest outside the bubble; cycling between two controllable vessels: controls,
read-outs, prediction, refusal out of range), `corrections` (the pilot's trans-Earth corrections: nothing
flown while both targets hold; after a disturbance the next one restores perigee and splash point; the
entry point the pilot uses is the landing panel's), `protocol` (prompt vs late tile I/O gives the same hash
for the powered descent and for the entry; a run that does not await is detected by `incompleteQueries`
and the warp clamp, and recovers; replay of an input log), `surface` (lander on real level-12 lunar
terrain: pushed with RCS it flexes and rests; 600 s without creep; capsule under the mains into the real
ocean and three minutes on the swell), `browserLoop` (pilot through `advance`).

`tests/mission` (31): `full-mission` (every gate above, QA files equal the captures of the flight, replay,
golden hash), `ascent`, `perturbed`, `entry-corridor`, `browser-loop`; `harness.ts` holds the observer.

The debris and cycling tests fly small test vehicles built in the test from real part definitions (a
capsule with rings of jettisonable covers, two capsules on a separator), because the mission vehicle sheds
no piece under 50 kg, never more than a dozen pieces and has one crewed vessel; the active vessel is moved
out of the bubble with the debug API there.

## Deviations from the brief, and what wave-1 reality decided

- **`incompleteQueries`** counts a step when a full-tier vessel is within contact range of the ground or
  in the "terrain regime" that also triggers the vessel disc (below 2 km radar altitude, or below 50 km with
  a ground speed under 200 m/s) and the data at its sub-point is not final. The brief's wording (any radar
  query below 50 km) cannot be met together with its rule that no disc is swept under an orbital pass: the
  15 km perilune pass of the descent orbit reads the radar over data that is deliberately not loaded.
- **Impact marker and `landingTarget.predicted` are not steered by.** The brief times the deorbit from the
  predicted impact point. The descent orbit it also prescribes (perilune 15 km up-range of the target) does
  not reach the ground, so no impact marker exists until the braking burn is under way; the deorbit is
  timed from the periapsis marker's latitude / longitude instead, and the braking law needs no impact point
  (it works on `downRange` / `crossRange`). On the way home `predicted` (kind `entry`) is the same
  atmosphere-entry marker the pilot reads from the patches; it reads the patches because the read-out
  exists only for the current trajectory and planning needs the planned one.
- **Entry down-range.** The brief expected 2,000-2,500 km; flown on the lift-vector rule it is about
  3,300 km eastbound and 2,900 km on a southbound track for a 45 km perigee (table above). The pilot aims
  with `entryDownRange(heading) = 2,900 km + 400 km x sin(heading)`. The entry is flown without a range
  bias in the roll: open loop.
- **Trans-Earth corrections** weigh the splash point against delta-v (a metre per second like 12.5 km of
  miss) instead of putting it on the zone centre: after the injection the splash point is expensive to
  move (7 m/s move it some tens of kilometres), so "inside a recovery zone" is decided by the TEI search
  (revolution and delta-v) and the corrections keep it there. The later corrections fly only when the
  perigee is more than 2.5 km off or the predicted splash has drifted 50 km.
- **M-3 thrusters (lead-baseline section 3, left to this package): kept as built.** The slew of the 154 t
  M-3 stack to the TLI attitude took 42 s in the mission and 16 s for the trim (the lander stack: 9-24 s
  per maneuver); sim-vessel measured 74 s for a full 90 degrees. Every maneuver of that stack is planned
  minutes ahead (the TLI node 74 minutes), so the slew never set the pace of a burn; larger thrusters
  would only spend more of the 240 kg of M-3 thruster propellant.
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

Requests filed: `sim-world-pilot-1` (`ScenarioDef.resources`; resolved by core-support in c2e2ed3 and used
here) and `sim-world-pilot-2` (the real-time estimate in ARCHITECTURE 18.2; open, not blocking). No request
against `src/sim`, `src/pilot` or part data was open at hand-off.

## Known weaknesses

- **The splash point is not centred.** Eight full flights from the pad came down 992-1,235 km from the
  centre of a zone of 2,000 km radius (and the eight QA take-overs 1,129-1,219 km): inside by about
  765 km at the least, never close to the middle. The miss is along the entry track (the capsule comes down
  about 10 degrees of latitude short of the centre): the return plane can be tilted only about 12 degrees
  out of the Moon's orbit plane, the planner weighs splash miss against delta-v, and the entry range is open
  loop (the model is within about 200-300 km of what is flown). A larger dispersion could leave the zone.
- **Daylight at splashdown is not achieved**: the Sun is about 2 degrees above the horizon there at
  arrival (dawn). It is a stated preference, not a gate; the planner prefers daylight only between
  otherwise equal options.
- **Real time of the browser mission is about 45 minutes**, not the 20-25 of the architecture; the
  remaining levers are rules (the 4 s look-ahead, the 4x cap of physics warp), not the pilot.
- **Slow single steps of 4-8 ms occur in every flight** outside the two measured windows; in the browser
  such a step is half a frame.
- **Each trans-Earth correction spends 4-10 m/s** on the weighted splash objective for a gain of tens of
  kilometres. It is affordable (561 m/s are left in the ascent stage) but not good value.
- **QA scenarios** carry the mission's resources but not its temperatures or attitude, and must be
  captured again whenever the nominal trajectory changes (the mission test says so when they are stale).
- **The golden hash** belongs to the tile content and most likely to the JavaScript engine's math
  functions (recorded on Node v24.16.0); another Node version has not been tried.
- **Landed stability** is a hold: once at rest a vessel rides the body, so "no creep for 600 s" holds by
  construction; contact dynamics on real terrain are exercised only by the touchdown itself and by the
  few seconds of the push test.
- **The revolution-vs-Kepler check in the mission** compares the world's rails propagation with the same
  propagator family; the independent check against RK4 is in the sim-orbits suite.
- **Debris rules are tested on test vehicles**, not in a mission: no flight of the mission vehicle has
  expired or capped a vessel, and cycling was never needed.
- **The pilot** waits up to 26 lunar revolutions for the return geometry (12 in the nominal flight, 25.5 h),
  lands with 58 s of hover-like approach, and flies no abort. The `peakGDose` of every survivable entry is
  0 because sim-vessel's dose only accumulates above its threshold.

## What the review changed

| Finding | What was done |
|---|---|
| Vessel age stopped for vessels outside the bubble | Age is derived from a birth time per vessel for every tier; `tests/unit/sim-world/debris.test.ts` covers age, expiry, the cap and cycling (the age tests fail on the old code) |
| QA scenarios had full tanks | Request 1 (resolved): `ScenarioDef.resources`; the world applies it; the capture tool records it; the scenario test and the mission test assert it |
| Pilot did not use the landing panel or the markers' latitude / longitude; later corrections solved the perigee only; M-3 decision and residency sentence | The pilot steers the descent by `readouts.landingTarget`, times the deorbit and predicts the splash from marker latitude / longitude, and the later corrections keep both targets (test `corrections`); the M-3 decision and the two remaining deviations are recorded above; the residency numbers are measured per disc and reworded |
| Dead code | `prewarmRemaining`, `TerrainPolicy.centre()`, `RunContext.recentMaxStepMs` removed; also the unused `patchAbout` and `angleDiff` of `src/pilot/math.ts` |
| Browser real time and its explanation | Found while tracing it: the world's warp look-ahead took every rails level away at the altitude-limit shell of the TOP level (a full step-down to physics warp at 30 000 km and 6 000 km on the way home, at the lunar shells, twice per parking revolution). Fixed (one level per shell, sim-design 5 "steps down smoothly") with a test. Pilot pacing: exact coast-down times instead of half the constant-speed estimate, physics warp for the RCS trims and the attitude turns before the entry, 4x in the braking burn down to 2 km. 52.7 -> 44.9 minutes; explanation corrected; request 2 for the architecture text |
