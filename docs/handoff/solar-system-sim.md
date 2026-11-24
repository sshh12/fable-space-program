# solar-system-sim: hand-off

Wave 4.1, MIGRATION_V2 step 4.1c. The Sun-rooted body system, prediction and navigation at solar-system scale,
lazy terrain residency, reach, the transfer pilot and the activation tool. Built 2026-11-24 by one agent in one
context; this file is the running state and the hand-off (PACKAGE_RULES 17). A successor continues from section 0
and `git log -- <owned paths>`.

## 0. State

**Done and committed** (in order): 9346808 body system and prediction; 0b6f6c4 Lambert, transfer planning,
reach, launch windows per pad; f94556a rails at any lead and the prediction acceptance; 7c1403c lazy terrain
residency and the shared tile store interface; c1bb1b2 tools/bodies/activate.mjs; d0980eb requests -1 item 6 and
-2. Then the transfer pilot and its scenario (section 6).

**Not done** (in the order a successor should take them):
0. **The transfer flights do not yet succeed** (section 6): the pilot, its scenario and the gated flight test are
   committed; the Mars flight fails at its departure plan (the compass search from the Hohmann first guess finds
   no encounter). Next step: a Lambert first guess in the pilot (section 6).
1. The transfer flights to Titan or Callisto, and to Phobos (section 6): the pilot plans a moon encounter after
   the planet's SOI entry (approach A of solar-system.md 6.2), which suits Titan and Callisto; Phobos needs a
   rendezvous after a Mars capture (its 16.6 km sphere is crossed in seconds at the flyby speed, and the capture
   burn of about 2 km/s takes the stack's engines many minutes), which the pilot does not have.
2. The planning service (`PlanningService` of session.ts) is not wired by this package: `LocalSession` is
   universe-directory's (4.2). Its five calls map to functions here (section 2, "For the planning service").

**Decisions taken, and why**
- `PredictOptions.encounterRevolutions` defaults to 1 (v1's window), not ARCHITECTURE 8.4's three periods: as the
  default the three-period search changes the World's `patches` block at a recorded state of island-core's
  snapshot reference (qa-translunar's start) and not the flight (mission 36 of 36 at the golden with it on).
  `THREE_PERIOD_ENCOUNTER_SEARCH` is exported for the planners; request solar-system-sim-1 item 1 asks island-core
  to take the default at a re-record.
- The 'auto' SOI rule test of tests/unit/sim-orbits/bodies.test.ts now asserts the v2 rule: the ONE sim-orbits
  assertion changed. For the Moon the Hill radius binds (61.5e6 m against v1's 66.1e6 m); the shipped Moon states
  its SOI as a number and is unchanged.
- The terrain provider's default stays `preload: 'all'` (v1's behaviour for every existing caller: the terrain
  guard, the mission, the tile workers and the planet-bake tests create providers and query at once).
  `preload: 'launchSystems'` is what a Sun-rooted library needs (request -1 item 6; the activation package).
- Synchronous terrain queries never start a load: a load no step awaits would make the simulation depend on I/O
  timing. Loads start at `ensureLoaded`, `prepareTile` and `loadBody`.
- Warp limits: a stated list shorter than the rails levels is completed from the default (request -2): Earth and
  the Moon load unchanged when the table grows to nine levels.

**The golden during this package.** At 12:53 the shared tree's `npm run test:mission` failed its golden
(2cc620fabf5771ee, 596,933 steps). Flown from a clean worktree of HEAD (b6d80ab, every commit of this package in
it) with the site files before and after fleet-data's pads: 72c0893583aa427d both times. The change came from
uncommitted work in src/sim/world at that moment (island-core's), not from this package.

## 1. How to run and verify

```
npm run typecheck:paths -- src/sim/orbit src/sim/bodies src/sim/frames src/sim/nav src/terrain src/pilot/generic tools/bodies tests/unit/solar-system tests/unit/sim-orbits tests/unit/terrain-core
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/sim/orbit src/sim/bodies src/sim/frames src/sim/nav src/terrain tests/unit/sim-orbits tests/unit/solar-system tests/unit/terrain-core
node tools/dev/heavy.mjs --class=cpu -- node tools/bodies/activate.mjs --dry-run
SOLAR_SYSTEM_VERBOSE=1 npx vitest run tests/unit/solar-system --silent=false     # prints the measured numbers and the reach table
node tools/dev/heavy.mjs --class=cpu -- npm run test:mission                     # the golden
```

The terrain guard (`tests/unit/terrain-core/terrain-guard.test.ts`, the lead's) changes in exactly the 884 points
the migration names when fleet-data's new pads are in the site files (289 of pads:ka-lae, 594 of pads:madrakah,
1 of site:madrakah); with the site files before them it is 0 points changed on this package's code (measured
against HEAD's provider). Re-recording it is the lead's.

## 2. Public API (exact signatures)

### src/sim/bodies
- `createBodySystem(defs: DefLibrary): BodySystem` (unchanged signature). New on `BodySystem`:
  `orbitNormal(id, ut): Vec3 | null`; `sunDirectionAt(bodyId, rBci, ut): { dir; distance }`;
  `sunVisibilityAt(bodyId, rBci, ut): number`; `sunVisibility(posRoot, ut, bodyId?)` (restricted to the planet
  system); `surfaceRadius(id, dirFixed): number`; `boundaryOf(bodyId, r, v, lostDistance): 'lost' | 'photosphere' | null`.
  `stateRelative` goes through the lowest common ancestor. `BodyInfo` gains `ephemeris: OrbitEphemeris | null`,
  `warpAltitudeLimits`, `surface`, `systemId`.
- `ephemeris.ts`: `interface OrbitEphemeris { stateAt(ut); bounds(t0, t1): { rMin; rMax; vMax }; normalAt(ut); meanPeriod }`;
  `class SecularKeplerEphemeris(def: KeplerOrbitDef, mu, qPlaneToBci)` (rates, fitted mean motion, exact derivative;
  `elementsAt(ut)`); `KeplerEphemeris` unchanged in arithmetic; `SunLowPrecisionEphemeris(inverted = false)`.
- `shape.ts`: `surfaceRadius(body, dirFixed)`, `altitudeAboveSurface(body, rFixed)`, `surfaceRadiusRange(body)`,
  `hasNoSurface`, `floorAltitude(body): number | null`, `belowFloor(body, rFixed)`, `DEFAULT_WARP_LIMIT_RADII`,
  `defaultWarpAltitudeLimit(body, k)`, `warpAltitudeLimitsOf(body): readonly number[]`, `RAILS_LEVELS`.

### src/sim/orbit
- `patches.ts`: `DEFAULT_MAX_PATCHES = 16`, `MAX_PATCH_SPAN` (40 y), `DEFAULT_ENCOUNTER_REVOLUTIONS = 1`,
  `THREE_PERIOD_ENCOUNTER_SEARCH = 3`, `PredictOptions.encounterRevolutions?`. An open patch inside an SOI runs to
  its exit; about a body without one the horizon restarts at every SOI change.
- `events.ts`: `soiStepFloor(o, rsoi, childBounds)` (min(30 s, SOI / 4V)); `findSoiEntry` on any child ephemeris;
  `closestApproaches(system, o, targetId, tFrom, tTo, samples = 64, maxCount = 2)` adaptive over the window
  (`CLOSEST_APPROACH_MAX_SAMPLES`); `findImpact` ends a trajectory at a giant's floor and on a spheroid.
- `chainApproach.ts`: `chainClosestApproaches(system, own, target, opts?: ChainApproachOptions): ChainApproach[]`,
  `ownChain(current, planned)`, `chainOf(patches): ChainEval`, `targetApproachMarkers(approaches, otherVesselId): Marker[]`.
  `ChainApproach = { ut, distance, relSpeed, self: { bodyId, r }, target: { bodyId, r }, onForecast }` (the
  contract's `ClosestApproach`).
- `lambert.ts`: `solveLambert(mu, r1, r2, tof, prograde = true, refNormal = +Z): { v1, v2, dnu } | null`.
- `longLead.ts`: `propagateAtTick(o, epochTick, tick): StateVector`, `reducedTimeOfFlight(o, epochTick, tick)`,
  `periodDD(o)`.

### src/sim/nav
- `target.ts`: `relativeState(system, own: BodyState, target: BodyState, ut): RelativeState` (target minus own;
  `range`, `rangeRate`); `lvlhFrame(r, v)`, `lvlhOffset(own, target)`, `LVLH_MAX_RANGE_SHARE = 0.1`,
  `vesselRelativeInclination(own, target)`, `vesselTargetReadout(input: VesselTargetInput): TargetReadout`,
  `navballTargetVectors(system, own, target, ut): { targetDir; relativeVelocity }`.
- `navball.ts`: `NavballInput.relativeVelocity?` (relative markers; mode 'target' shows it as prograde).
- `transfer.ts`: `hohmannTransferTime`, `hohmannPhaseAngle`, `synodicPeriod`, `departureDeltaV`, `captureDeltaV`,
  `phaseAngle(system, fromId, toId, ut)`, `transferArc(system, fromId, toId, departUt, tof, cost?)`,
  `bestTransfer(system, fromId, toId, fromUt, toUt, opts?)`, `transferWindows(...)`; `TransferArc`.
- `reach.ts`: `deltaVToOrbit(defs: DefLibrary, bodyId: string, options?: ReachOptions): ReachResult`;
  `ReachOptions = { originId?, parkingAltitude? (200 km), refuel?: 'none' | 'highOrbit' | 'moonOrbit',
  aerobrake? (true), method?: 'lambert' | 'hohmann', fromUt?, searchSpan? }`; `ReachResult = { bodyId, originId,
  total, beforeRefuel, afterRefuel, refuel, legs, allowances: { burnLosses, corrections }, aerobraked, capture:
  { kind, periapsisAltitude, apoapsisAltitude }, transferTime, departUt }`; `launchBodyOf(defs)`,
  `lowOrbitRadius(system, id)`, the stated allowances `BURN_LOSS_SHARE` (2 %), `CORRECTION_PER_INTERPLANETARY_LEG`
  (30 m/s), `CORRECTION_PER_MOON_LEG` (10 m/s), `CAPTURE_APOAPSIS_SOI_SHARE` (0.1), `REFUEL_HIGH_ORBIT_SOI_SHARE` (0.4).
- `launchWindow.ts`: `launchWindowsForPad(system, pad: { bodyId; latitude; longitude; elevation }, targetBodyId,
  fromUt, toUt, opts?): PadLaunchWindow[]` (the contract's `LaunchWindow`).

For the planning service (universe-directory): `predictPatches` = `predictPatches(system, state, ut, nodes,
{ encounterRevolutions: THREE_PERIOD_ENCOUNTER_SEARCH, ... })`; `closestApproaches` = `chainClosestApproaches(system,
ownChain(current, planned), targetChain, { count, horizon, targetHeadUt })`; `launchWindows` =
`launchWindowsForPad`; `describeConic` = the markers of a patch (`predictPatches` of the conic's state);
`proximityPlot` = `lvlhOffset` sampled along the two chains.

### src/terrain
- `TerrainProviderOptions.preload?: 'all' | 'launchSystems' | readonly string[]` (default 'all'),
  `.sharedStore?: SharedTileStore`. `TerrainAuthority` gains `preloadedIds`, `loadedBodies()`,
  `loadBody(bodyId, slot?)`, `release(slot)`; `TerrainDiagnostics` gains `residency` and `unloadedQueries`.
- `sharedStore.ts`: `SharedTileStore { peek(key); acquire(key): Promise<SharedTile | null>; release(key); capBytes }`,
  `SharedTileKey`, `SharedHeightTile`, `SharedU8Tile` (implemented by server-persistence).
- `BodyTerrainDef.residentLevel` is honoured (min with the manifest's level).

### src/pilot/generic
- `transfer.ts`: `createTransferPilot(defs, scenario, opts: TransferPilotOptions): TransferPilot`;
  `TransferPilotOptions = { targetId, periapsisAltitude?, captureApoapsisShare? (0.3), correctionDelay? (5 d), onLog? }`.
- `transferMath.ts`: the pilot's own patched-conic formulas (src/pilot imports src/core only).

### tools/bodies
- `node tools/bodies/activate.mjs [--dry-run] [--keep] [--skip-start-time]`; `npx tsx tools/bodies/activate-check.ts --defs <root> [--reference <root>]`.

## 3. Acceptance, measured

(Machine shared with five other packages; timings provisional.)

| Criterion | Result |
|---|---|
| Every existing sim-orbits test passes unchanged on the 3-body library; trajectory guard green | Met with ONE assertion changed (the synthetic 'auto' SOI rule, section 0); 141+ sim-orbits tests pass; the trajectory guard and the golden pass (mission 36 of 36, three runs; section 0 for the shared-tree episode) |
| Staged library: Sun declination at Earth within 0.0035 deg of v1 over 2029-2031 | Met: 0 deg (the same expression; angle < 1e-12 rad) |
| checkStartConstraints passes for lunar-direct's start on the staged library | Met (tests/unit/solar-system/startTime.test.ts); findStartTime on the activated library REPRODUCES start-time.json (activate.mjs --dry-run) |
| Bodies within their Horizons tolerance through the runtime ephemeris | Met: all 29 judged bodies at the held-out instants (worst against tolerance: Mimas 9.14 of 10.9 deg, Miranda 1.69 of 1.85, the planets at most 0.088 of 0.1 deg); runtime = reference evaluator to 1e-11 relative |
| LEO departure with 3,600 m/s: earth soiExit and a heliocentric patch | Met: earth soiExit after 3.2 d, then a closed heliocentric patch of 442 d |
| Mars at 4,000 km 120 days later: a Mars patch WITH periapsis marker | Met: sun soiEnter at 117.8 d, Mars patch 4.3 d long, periapsis at 4,000 km (within 1 km) |
| Phobos' SOI (16.6 km) entered at 2 km/s | Met: the Phobos patch lasts about 16 s |
| A Neptune approach finds Triton | Met |
| Chain closest approaches against brute force at 1 s: 1 m, 0.1 s; cost at most 1 ms for three LEO orbits | Met (two LEO orbits, a 14 km/s head-on pass, a lunar arrival across an SOI change); 0.08 ms for three LEO orbits |
| Rails of every body and a craft at 1e7x for 250 years: phase error under 1 mm of arc; no NaN | Met with `propagateAtTick` (double-double reduction): 1.2e-5 mm of arc for a low orbit over 47,337 frames; every body finite at every frame. The plain float64 `propagate(o, tick / 120)` is 6 mm: the island should take `propagateAtTick` for rails (not requested yet; a numerics change of island-core's) |
| Transfer pilot: Mars from 200 km with 6.5 km/s, three dates; Venus, Titan or Callisto, Phobos | NOT MET: the pilot, scenario and gated test exist; the Mars flight fails at the departure plan (no encounter from the Hohmann first guess). Section 6 |
| deltaVToOrbit: Mars, Jupiter, Mercury against hand values to 2 %; the table for 32 bodies with and without refuel | Met (Hohmann legs against a hand computation: within 2 %); the table: section 4 |
| Terrain guard green; 27-body provider within 10 % of today's two-body provider; a body released after its last slot | Met: 27 bodies ('launchSystems') 625 ms and 162.8 MiB against the two-body provider's 737 ms and 162.8 MiB; release tested (every tile dropped). Guard: section 1 |
| Measured: heliocentric predictPatches (budget 20 ms); body snapshot for 32 bodies | 0.14 ms (LEO departure through the Sun's sphere), 0.24 ms (heliocentric Mars flyby); buildBodySnapshots 38.5 us |

## 4. Reach (deltaVToOrbit, 200 km parking orbit, Lambert windows departing in the first synodic period from 2029-09-24; km/s)

See `SOLAR_SYSTEM_VERBOSE=1 npx vitest run tests/unit/solar-system/reach.test.ts --silent=false` for the full
table with the high-orbit and moon-orbit refuel columns (before + after the refuel point). Next to 10.9 km/s (the
Albatross): beyond it without a refuel: Mercury (about 12), the inner Saturnian and the Uranian moons (11.4-13.3),
Ceres (12.7), Pluto and Charon (18.9, 19.1: Pluto 15-17 deg off the ecliptic in the 2030s, and the profile has no
broken-plane manoeuvre); with the high-orbit refuel (3.19 km/s before it) everything but Pluto and Charon
(15.7, 16.0 after) is within 10.9 km/s. Mars 3.70 and Venus 3.65 aerobrake; Jupiter 7.26, Neptune 9.26 (the
research's 7.0 and 9.4); the Moon 4.05; Titan 7.66 with aerobraking.

## 5. Requests

| Request | To | What |
|---|---|---|
| solar-system-sim-1 | island-core | the encounter-revolutions default; sunlight in the planet frame; altitude above the spheroid; the floor of the giants; the vessel-target navigation; the terrain preload for the staged library |
| solar-system-sim-2 | lead | the two warp levels and the optional warp limits (the body-system side is in) |

No open request was against this package's paths (terrain-render-9 is about src/terrain/amplification, not
this package's).

## 6. The transfer pilot and its flights

`data/defs/scenarios/transfer-leo-200.json`: meridian-lunar's upper stack (stages fired 4) in a 200 km circular
Earth orbit at 19 deg, propagation cut to 6.5 km/s (M-3 4.61 km/s, the descent stage 1.91 km/s, no ascent
propellant; measured `deltaVTotal` 6,517 m/s). The flights run on `createSession` with the staged library and a
terrain provider with `preload: 'launchSystems'`:

```
SOLAR_SYSTEM_FLIGHTS=1 SOLAR_SYSTEM_VERBOSE=1 node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/solar-system/transferFlight.test.ts --silent=false
```

The three start dates are two days before the pilot's own Hohmann-phase windows of 2031-02-06, 2033-03-16 and
2035-05-10 (found by scanning the phase; a start in LEO months before a window is impractical: at 200 km the
Earth's limits allow 50x rails warp, so the wait would be millions of rails advances).

**Status: NOT MET.** First flight (start 981244800): the window is found (2.1 d, phase 45.5 deg), the departure
node is placed at the ejection point (3,643 m/s, excess 3,057 m/s), and the plan is rejected: "no encounter
with the planet". With the Hohmann first guess the heliocentric arc misses Mars by 24.3 Gm (closest approach
marker; the 2031 opportunity is a poor one, Mars near aphelion, and the best Lambert arc leaves in late December
2030 on a 285-day arc with Mars 69 deg ahead: src/sim/nav/transfer.ts finds it), and the compass search over the
node's time and its prograde and normal delta-v (steps 40 m/s, 240 s, 80 m/s down) cannot close a miss that is a
matter of the departure DATE and the arc's time of flight.

What to do next (the successor): (1) give the pilot a Lambert first guess: the pilot may import src/core only, so
either a copy of the universal-variable Lambert in src/pilot/generic/transferMath.ts (the arc between the origin's
position and the planet's position propagated on its osculating conic from the snapshot, `BodySnapshot.orbit`),
or a request to the lead to place `solveLambert` in src/core/math so both share it; choose the window by a small
porkchop on that (as `bestTransfer` does) instead of the circular phase angle; (2) seed the node's prograde and
normal delta-v from the arc's excess velocity (the normal part from its declination against the parking plane);
(3) then the existing compass search, the correction after the SOI exit, and the capture are as written. The
capture (retrograde at periapsis into an ellipse of 0.3 SOI apoapsis) and the moon correction are written and
untested in flight. Phobos needs a rendezvous after a Mars capture (section 0).

## 7. For the next packages

- **universe-directory**: `boundaryOf(bodyId, r, v, rules.expiry.lostDistance)` is the 'lost' and
  'photosphere' query; the planning service calls are listed in section 2; forecast chains for passive vessels
  can use `propagateAtTick` (exact phase at any lead).
- **session-switch**: re-run tests/unit/solar-system on `LocalSession` (they are session-free except the transfer
  flight tests, whose commands are in section 6).
- **bodies-activation**: `node tools/bodies/activate.mjs --dry-run`, then without `--dry-run`; it prints what to
  re-baseline. Switch the terrain consumers to `preload: 'launchSystems'` (app, tools/sim/realWorld, labs).
- **contact-docking**: relative state and LVLH are in src/sim/nav/target.ts (port alignment is yours).
- **map-multiplayer**: targetApproach markers from `targetApproachMarkers`; `Patch.bodyPosAtEnd` stays the body
  at the patch end (the at-intercept anchor is computed on the map side, RENDER_API 19.1).
