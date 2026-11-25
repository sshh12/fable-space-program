# solar-system-sim: hand-off

Wave 4.1, MIGRATION_V2 step 4.1c. The Sun-rooted body system, prediction and navigation at solar-system scale,
lazy terrain residency, reach, the transfer pilot and the activation tool. Built 2026-11-24 by one agent in one
context; this file is the running state and the hand-off (PACKAGE_RULES 17). A successor continues from section 0
and `git log -- <owned paths>`.

## 0. State

**Done and committed** (in order): 9346808 body system and prediction; 0b6f6c4 Lambert, transfer planning,
reach, launch windows per pad; f94556a rails at any lead and the prediction acceptance; 7c1403c lazy terrain
residency and the shared tile store interface; c1bb1b2 tools/bodies/activate.mjs; d0980eb requests -1 item 6 and
-2; 2d194e2 the transfer pilot's first form. Second builder (successor, 2026-11-24): 8c41d1a the pilot's Lambert
window, the 3-D departure aimed through the origin's sphere, reach with broken-plane arcs, both settings of the
two defaults tested; fba410b the pilot's takeover in a planet's sphere, Newton corrections, the arrival legs.

**Where the flights stand (final, 2026-11-24; read section 6).** On the World of island-core's 26d272a (request -4
resolved: the view reads body-centred state in a reference-orbit island) the whole transfers fly under real
physics through the player's commands, departure through the cruise in the Sun's sphere to the capture: Mars from
three dates, Venus, and Phobos to a closed orbit between its highest ground and its sphere. Callisto does NOT: on
fleet-data's reworked Albatross (committed: four tanks, 10,234 m/s) my departure burn ends about 370 s in with the
World's "Every command part was lost" - no part destroyed, no crew event, the vessel still whole; fleet-data's own
departure test of the same ship passes on the same tree (SAS prograde, throttle 1, no wait), so the cause lies
between PilotCore's maneuver hold on that ship and the World's controllable flag and was not found. Callisto's
arrival leg (from Jupiter's sphere) flies on the reworked ship. The marginal bodies are not flown (section 6).

**Not done** (in the order a successor should take them):
0. Callisto whole: find why the World stops counting the Albatross controllable during my 35-minute departure burn
   (reproduce: `SOLAR_SYSTEM_FLIGHTS=callisto ... transferFlight.test.ts`; fleet-data's DeparturePilot flies the
   burn on SAS prograde and passes). A split departure (two perigee burns) would also shorten each burn.
1. The marginal bodies (section 6): the pilot departs from a CIRCULAR parking orbit only; flying the refuelled
   cruiser from the high refuel orbit needs `ejectionBurn` on an elliptical orbit (the burn at its periapsis, the
   apse line set by the scenario to the window's ejection point) and the Albatross issue of item 0.
2. The planning service (`PlanningService` of session.ts) is not wired by this package: `LocalSession` is
   universe-directory's (4.2). Its five calls map to functions here (section 2, "For the planning service").

**Decisions taken, and why**
- `PredictOptions.encounterRevolutions` defaults to 1 (v1's window), not ARCHITECTURE 8.4's three periods: as the
  default the three-period search changes the World's `patches` block at a recorded state of island-core's
  snapshot reference (qa-translunar's start) and not the flight (mission 36 of 36 at the golden with it on).
  `THREE_PERIOD_ENCOUNTER_SEARCH` is exported for the planners; request solar-system-sim-1 item 1 asks island-core
  to take the default at a re-record.
- The 'auto' SOI rule test of tests/unit/sim-orbits/bodies.test.ts now asserts the v2 rule: the ONE sim-orbits
  assertion changed, and it is the brief's rule, not a regression. `soiRadius: 'auto'` is min(Hill, max(a (m/M)^0.4,
  2.5 R)) (ARCHITECTURE 8.1 table; the brief's SCOPE); v1's rule was the Laplace radius a (m/M)^0.4 alone. For the
  Moon the Hill radius binds: 61.5e6 m against 66.1e6 m. WHERE EACH APPLIES: 61.5e6 m only to a Moon declared
  'auto', which no library does (the synthetic test builds one); the Moon of data/defs/bodies/moon.json and of
  data/staged/bodies/moon.json states 66,100,000 m, so the original mission, the golden and every flight use the
  pinned 66.1e6 m (tests/unit/solar-system/bodySystem.test.ts holds both: the pinned value in both libraries and
  what the rule would give). The Earth of the staged library also states its sphere (924,776,246 m).
- The transfer pilot carries its own Lambert (transferMath.ts) because src/pilot may import only src/core
  (tools/dev/boundaries.test.ts); tests/unit/solar-system/transferMath.test.ts holds it to src/sim/orbit/lambert.ts.
  Moving `solveLambert` to src/core/math (the lead's) would let both share one; not requested (nothing depends on it).
- The flights start in the departure plane: the scenario's parking orbit holds the window's asymptote (a player
  launches at the window). From a fixed plane the pilot costs the true 3-D ejection and refuses a window it
  cannot reach; the 2033 Mars window needs 56 deg.
- `ReachOptions.brokenPlane` and long `searchSpan`s stay OFF by default: fleet-data's reach table holds its numbers
  (request -3 asks it to take them).
- The terrain provider's default stays `preload: 'all'` (v1's behaviour for every existing caller: the terrain
  guard, the mission, the tile workers and the planet-bake tests create providers and query at once).
  `preload: 'launchSystems'` is what a Sun-rooted library needs (request -1 item 6; the activation package).
- Synchronous terrain queries never start a load: a load no step awaits would make the simulation depend on I/O
  timing. Loads start at `ensureLoaded`, `prepareTile` and `loadBody`.
- Warp limits: a stated list shorter than the rails levels is completed from the default (request -2): Earth and
  the Moon load unchanged when the table grows to nine levels.

**The golden and the second builder.** None of the files changed after 2d194e2 is on the mission's import graph
(src/pilot/generic/transfer*.ts, src/sim/nav/transfer.ts and reach.ts are imported by tests and tools only;
`grep` of src for them finds no importer outside src/sim/nav and src/pilot/generic) and the one data file added,
data/defs/scenarios/transfer-albatross-leo-200.json, starts at the library's earliest start (938240818.84, so the
reach default `fromUt` is unchanged) and is not flown by the mission: the golden 72c0893583aa427d is unaffected by
reasoning from the import graph; the mission was not re-run (the flights and the blocker were checked on a clean
worktree of 8c41d1a outside the repository, data/tiles and node_modules linked).

The last round's one change on the mission's graph, src/terrain/provider.ts, only adds two authority members
(`pinnedBand`, `stableHeightAt`); no existing query changes, so the golden of that day (27dd19a26303c181,
island-core's) is unaffected by reasoning; the mission was not re-run by this package.

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
SOLAR_SYSTEM_FLIGHTS=arrival node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/solar-system/transferFlight.test.ts   # the arrival legs (section 6)
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
  `brokenPlaneArc(system, fromId, toId, departUt, tof, breakShare, cost?)`, `BROKEN_PLANE_SHARES`,
  `bestTransfer(system, fromId, toId, fromUt, toUt, opts?)` (`opts.brokenPlane`), `transferWindows(...)`;
  `TransferArc` (`breakUt?`, `breakDeltaV?` on a broken-plane arc).
- `reach.ts`: `deltaVToOrbit(defs: DefLibrary, bodyId: string, options?: ReachOptions): ReachResult`;
  `ReachOptions = { originId?, parkingAltitude? (200 km), refuel?: 'none' | 'highOrbit' | 'moonOrbit',
  aerobrake? (true), method?: 'lambert' | 'hohmann', fromUt?, searchSpan? (one synodic period; longer: one period
  at a time), brokenPlane? (false) }`; `ReachResult = { bodyId, originId,
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
- `TerrainAuthority.pinnedBand(bodyId): number` (the resident level's data wavelength, lambda0 2^-R) and
  `.stableHeightAt(bodyId, dir, lambdaMin)` (heightAt at max(lambdaMin, pinnedBand): a read-out's height, independent
  of the cache; request island-core-3).
- `TerrainProviderOptions.preload?: 'all' | 'launchSystems' | readonly string[]` (default 'all'),
  `.sharedStore?: SharedTileStore`. `TerrainAuthority` gains `preloadedIds`, `loadedBodies()`,
  `loadBody(bodyId, slot?)`, `release(slot)`; `TerrainDiagnostics` gains `residency` and `unloadedQueries`.
- `sharedStore.ts`: `SharedTileStore { peek(key); acquire(key): Promise<SharedTile | null>; release(key); capBytes }`,
  `SharedTileKey`, `SharedHeightTile`, `SharedU8Tile` (implemented by server-persistence).
- `BodyTerrainDef.residentLevel` is honoured (min with the manifest's level).

### src/pilot/generic
- `transfer.ts`: `createTransferPilot(defs, scenario, opts: TransferPilotOptions): TransferPilot`;
  `TransferPilotOptions = { targetId, periapsisAltitude?, captureApoapsisShare? (0.3), correctionDelay? (5 d),
  windowSpan? (0.8 synodic period), onLog? }`; `TransferPilot.flown` (delta-v per burn label), `.chosenWindow`,
  `TransferPilot.defaultPeriapsisAltitude(defs, bodyId)`; constants `WINDOW_SPAN_SYNODIC_SHARE`, `LATE_CORRECTION_LEAD`,
  `LATE_CORRECTION_CRUISE_SHARE`, `APPROACH_TOLERANCE_SHARE`, `MOON_FLYBY_SHARE` (1), `MOON_AIM_SOI_SHARE` (0.3),
  `MOON_LATE_CORRECTION_RADII` (3), `MOON_LATE_CORRECTIONS` (3), `MOON_LATE_CORRECTION_MIN_LEAD` (2 h).
- `transferMath.ts`: `lambert(mu, r1, r2, tof, refNormal)`, `stateOnConic(c, t)`, `positionOnConic(c, t)`,
  `bodyStateAt(body, parent, t)`, `closestToMoon(c, t0, t1, moon, planet)`, `ejectionBurn(mu, r, v, vinf, nearDt):
  EjectionBurn | null`, `stateAfterBurn`, `aimDeparture(mu, r, v, nowUt, soi, origin, parent, muParent, target,
  arriveUt, vInf0, nearDt): DepartureAim | null`, `windowArc(w, departUt, tof)`, `bestWindow(w: WindowSearch):
  WindowArc | null`, `synodic`, `captureDeltaVFromExcess`, and v1's `hohmann`, `ejectionDeltaV`, `ejectionPoint`,
  `timeToDirection`, `captureDeltaV`, `meanOrbit`, `phaseAngle`, `relativeTo`.

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
| Transfer pilot: Mars from 200 km with 6.5 km/s, three dates; Venus, Titan or Callisto, Phobos | MET for Mars x3 (4,872 / 4,709 / 4,467 m/s of 6,517; bound e 0.959 / 0.959 / 0.960; 15 / 16 / 14 s wall), Venus (4,309 m/s, e 0.934, 15 s) and Phobos (6,086 m/s, a closed orbit 15.1-16.4 km from its centre inside its 16.6 km sphere, e 0.019, 45 s): whole flights, gated. NOT MET for Callisto as a whole flight (the reworked Albatross's departure burn ends in the World's "Every command part was lost"); its arrival leg flies (3,481 m/s, e 0.779). Section 6 |
| deltaVToOrbit: Mars, Jupiter, Mercury against hand values to 2 %; the table for 32 bodies with and without refuel | Met (Hohmann legs against a hand computation: within 2 %); the table with the broken-plane and seven-year columns: section 4 |
| Read-out heights independent of the cache (request island-core-3, added) | Met: `stableHeightAt` equal to the bit at the request's point before and after an unrelated 30 km disc is made resident, where `heightAt` moves 0.098 m (tests/unit/terrain-core/readoutHeight.test.ts); the Moon's pinned band 2,665.1 m |
| Terrain guard green; 27-body provider within 10 % of today's two-body provider; a body released after its last slot | Met: 27 bodies ('launchSystems') 625 ms and 162.8 MiB against the two-body provider's 737 ms and 162.8 MiB; release tested (every tile dropped). Guard: section 1 |
| Measured: heliocentric predictPatches (budget 20 ms); body snapshot for 32 bodies | 0.14 ms (LEO departure through the Sun's sphere), 0.24 ms (heliocentric Mars flyby); buildBodySnapshots 38.5 us |

## 4. Reach (deltaVToOrbit from a 200 km parking orbit; km/s; against the Albatross's 10.9 with full tanks)

The default profile (a direct Lambert arc, windows departing in the first synodic period from 2029-09-24) and
the profile with `{ brokenPlane: true, searchSpan: 7 years }`; the refuelled columns are before + after the
high-orbit refuel:

| Body | Default | Default, refuelled | Broken-plane + 7 y | Same, refuelled | Transfer (d) |
|---|---|---|---|---|---|
| mercury | 15.26 | 3.19 + 12.07 | 12.22 | 3.19 + 9.03 | 95 |
| venus | 3.65 | 3.19 + 0.46 | 3.61 | 3.19 + 0.41 | 161 |
| mars | 3.70 | 3.19 + 0.51 | 3.68 | 3.19 + 0.49 | 275 |
| jupiter | 7.26 | 3.19 + 4.06 | 7.27 | 3.19 + 4.08 | 944 |
| saturn | 8.38 | 3.19 + 5.18 | 8.37 | 3.19 + 5.18 | 1837 |
| uranus | 9.17 | 3.19 + 5.98 | 8.94 | 3.19 + 5.74 | 5793 |
| neptune | 9.26 | 3.19 + 6.07 | 9.08 | 3.19 + 5.89 | 13799 |
| moon | 4.05 | - | 4.05 | - | 5 |
| phobos / deimos | 4.27 / 4.38 | 3.19 + 1.08 / 1.19 | 4.25 / 4.36 | 3.19 + 1.06 / 1.17 | 275 |
| io / europa / ganymede / callisto | 13.14 / 12.10 / 10.93 / 10.30 | 3.19 + 9.95 / 8.90 / 7.74 / 7.11 | 13.12 / 12.06 / 10.88 / 10.23 | 3.19 + 9.93 / 8.87 / 7.69 / 7.04 | 966-980 |
| mimas / enceladus / tethys / dione / rhea | 14.48 / 13.82 / 13.29 / 12.80 / 12.28 | 3.19 + 11.29 / 10.63 / 10.10 / 9.60 / 9.08 | 14.44 / 13.77 / 13.22 / 12.72 / 12.18 | 3.19 + 11.25 / 10.57 / 10.03 / 9.52 / 8.99 | 1894-1939 |
| titan / iapetus | 7.66 (aerobraked) / 10.85 | 3.19 + 4.47 / 7.66 | 7.66 / 10.84 | 3.19 + 4.47 / 7.65 | 1577 / 1837 |
| miranda / ariel / umbriel / titania / oberon | 12.47 / 11.99 / 11.85 / 11.65 / 11.44 | 3.19 + 9.28 / 8.80 / 8.66 / 8.46 / 8.25 | 12.21 / 11.72 / 11.58 / 11.38 / 11.21 | 3.19 + 9.02 / 8.53 / 8.39 / 8.18 / 8.02 | 5603-5793 |
| triton | 11.42 | 3.19 + 8.23 | 11.09 | 3.19 + 7.90 | 12018 |
| ceres | 12.74 | 3.19 + 9.55 | 10.34 | 3.19 + 7.15 | 549 |
| pluto / charon | 18.91 / 19.14 | 3.19 + 15.72 / 15.95 | 12.63 / 12.86 | 3.19 + 9.43 / 9.67 | 24995 (68 y) |

**Whether "reachable and orbitable" holds for EVERY body, as built.** Not with the defaults: after the high-orbit
refuel Mercury (12.07), Mimas (11.29), Pluto (15.72) and Charon (15.95) exceed 10.9. (The first builder's text
named only Pluto and Charon; Mercury and Mimas were missed there; fleet-data's held table has all four.) With
broken-plane arcs and a seven-year window search, both built here (`ReachOptions.brokenPlane`; a long `searchSpan`
is searched one synodic period at a time): Pluto 9.43 and Charon 9.67 (a plane change of 1.69 km/s on the way, a
68-year arc, the cheapest in the 0.6-1.5 Hohmann-time range: long, but within the time model), Mercury 9.03 (its
eccentric orbit makes the first synodic period's windows poor): every body but MIMAS, which is short by 0.35 km/s
with full tanks after the refuel by any profile of this function (direct or broken-plane, the flyby or the
planet-capture way into a moon's orbit, a high-orbit or lunar-orbit refuel). What would close Mimas: about 0.4 km/s
more in the cruiser after the refuel, a second refuel point beyond the Earth, or an aerobraking pass in Saturn's
atmosphere (the profile aerobrakes only at bodies with a solid surface). Pluto and Charon need no second refuel.
Request -3 asks fleet-data to take the two options and the lead to put Mimas to Q17.
`SOLAR_SYSTEM_VERBOSE=1 npx vitest run tests/unit/solar-system/reach.test.ts --silent=false` prints the default
table and the four bodies with the options.

## 5. Requests

| Request | To | What | State |
|---|---|---|---|
| solar-system-sim-1 | island-core | the two defaults (items 1, 6), sunlight in the planet frame, altitude above the spheroid, the giants' floor, vessel targets, the terrain guard on bodies without terrain (item 7) | resolved (4c9a569, a7d53a5; item 7 in 26d272a); both library defaults stay as tested in defaults.test.ts |
| solar-system-sim-2 | lead | the two warp levels and the optional warp limits | held by the lead |
| solar-system-sim-3 | fleet-data, lead | the reach table with `brokenPlane` and a seven-year `searchSpan`; Mimas to Q17 | resolved by fleet-data (every body closes with a stated number of depot flights; six marginal and unflown) |
| solar-system-sim-4 | island-core | a craft in the Sun's sphere handed to the view as its reference-orbit offset (BLOCKING) | resolved (26d272a) |
| island-core-3 (to this package) | solar-system-sim | read-out heights independent of the cache | resolved here: `pinnedBand`, `stableHeightAt`; island-core takes them in src/sim |

## 6. The transfer pilot and its flights

**The pilot** (src/pilot/generic/transfer.ts; its arithmetic in transferMath.ts, src/core imports only):
1. window: a porkchop of Lambert arcs between the origin's and the planet's osculating orbits from the snapshot
   (61 x 31 cells over 0.8 of a synodic period, times of flight 0.6-1.5 Hohmann times, refined by halving), costed
   as the 3-D periapsis burn from THIS parking orbit plus the capture at the planet (a moon: the speed relative to it
   where a flyby tangent to its orbit crosses it); rails warp until one orbit and 30 minutes before it;
2. departure: `aimDeparture` iterates the excess velocity so that the arc continues from where the patched conics
   hand the craft over at the origin's sphere (it leaves about 130 m/s faster than the asymptotic speed; aimed
   from the centres the 283-day 2030-12 arc missed Mars by 2.6 Gm, aimed through the sphere it enters Mars's sphere
   on the first guess); the node at the periapsis of that hyperbola on the parking orbit (`ejectionBurn`: the point
   of the smaller burn where the cone about the asymptote meets the orbit plane); a compass search on the predicted
   patches sets the periapsis at the planet;
3. corrections (heliocentric: 5 days after the burn and 10 days or a tenth of the cruise before the planet's
   sphere): the smallest burn that removes the error, Newton with the minimum-norm step (planner.ts) on the signed
   periapsis error (a moon: first the closest approach into 0.3 of its sphere, then its periapsis);
4. in the planet's sphere: for a moon an early correction (the moon on its osculating orbit) and up to three late
   ones inside three moon-orbit radii (the predictor's closest approach is then the pass itself: over a whole
   flyby it reports the first two minima in time, which against a fast moon are not the pass); in the target's
   sphere an approach correction when the periapsis is off by more than 10 % (best effort);
5. capture: retrograde at the periapsis into an ellipse of apoapsis 0.3 of the target's sphere.
The pilot also takes over in the planet's or the target's sphere (a start on the arrival hyperbola, or a resumed
flight). It reads the snapshot and the definitions only and acts through PlayerCommands and ControlInputs.

**The flights** (tests/unit/solar-system/transferFlight.test.ts, gated: minutes of CPU when whole; the starts from
tests/unit/solar-system/flightPlane.ts):

```
SOLAR_SYSTEM_FLIGHTS=1 SOLAR_SYSTEM_VERBOSE=1 node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/solar-system/transferFlight.test.ts --silent=false
SOLAR_SYSTEM_FLIGHTS=arrival ...        # the four arrival legs only (seconds)
SOLAR_SYSTEM_FLIGHTS=mars,venus ...     # the whole flights of those targets
```

| Flight | Start | Status, measured |
|---|---|---|
| Flight (whole, gated) | Start | Measured, end to end |
|---|---|---|
| Mars 1 (transfer-leo-200) | 977493600, plane 19 deg; window 2030-12-24, 283 d | departure 3,669, correction 54.9, late 1.1, capture 1,148: 4,872 m/s of 6,517; bound e 0.959, periapsis 213 km; 284 d; 15 s wall |
| Mars 2 | 1050422400, plane 56.4 deg; 2033-04-16 | 3,595 + 48.3 + 2.6 + 0.9 + 1,062 = 4,709 m/s; e 0.959, periapsis 200 km; 201 d; 16 s |
| Mars 3 | 1119636000, plane 19 deg; 2035-06-26 | 3,643 + 122.4 + 0.3 + 2.4 + 700 = 4,467 m/s; e 0.960, periapsis 219 km; 208 d; 14 s |
| Venus | 991573200; 2031-06-05, 128 d | 3,749 + 28.5 + 6.4 + 0.6 + 525 = 4,309 m/s; e 0.934, periapsis 284 km; 130 d; 15 s |
| Phobos | 1119636000 (the 2035 Mars window) | departure, cruise, then the rendezvous at Mars (approach 23 m/s, capture at Phobos's orbit radius 1,041, the orbit reversed at apoapsis 320, phasing 425, trims, match, closing, capture about Phobos, circular trims): 6,086 m/s of 6,517; a closed orbit 15.1 km x 16.4 km from Phobos's centre (its highest ground 14.0 km, its sphere 16.6 km), e 0.019; 222 d; 45 s |
| Callisto (transfer-albatross-leo-200, 10,234 m/s) | 948790800; 2030-01-25, 910 d | NOT MET: the departure burn (6,328 m/s planned, 35 min at 0.33 g) ends about 370 s in with the World's "Every command part was lost" (above) |
| Arrival legs (`SOLAR_SYSTEM_FLIGHTS=arrival`) | the planet's sphere on each window's hyperbola | Mars 1,174 m/s, e 0.960, 3 s; Venus 601, e 0.934, 3 s; Callisto 3,481, e 0.779, 14 s; Phobos 1,986, e 0.041 inside its sphere, 27 s |

Against the reach table (section 4; deltaVToOrbit aerobrakes where it can, the pilot captures by burning):
Mars 4.47-4.87 km/s flown against 3.70 (aerobraked) and about 4.6 propulsive; Venus 4.31 against 3.65 aerobraked;
Phobos 6.09 against 4.25 (the table's moon-orbit model is the coplanar sum; the flight pays a 320 m/s reversal and
the phasing). Venus 3,743 + 603 = 4,346 of 6,517
(deltaVToOrbit 3.65 with aerobraking). Wall time: the departure half about 10 s, the arrival legs 2-11 s; a whole
flight is expected near a minute once the cruise runs on rails at the top level. Departure halves: scratch tool
of the second builder (the test's starts, stopped at the end of the burn); the arrival legs: the gated test.

**The rendezvous with a tiny moon** (`rendezvousTick`, for a moon whose sphere a tangent flyby crosses in less than
TINY_MOON_CROSSING): the periapsis on the moon's orbit; the capture at the planet; at its apoapsis the moon's plane
(an orbit that runs against the moon is reversed there first); the phasing at periapsis from an analytic period
(whole moon periods to a standoff of two spheres) refined by Newton on the moon's osculating orbit; a trim at the
phasing orbit's apoapsis; a last trim a quarter revolution before the meeting on the predictor's closest approach
(the osculating orbit drifts about 250 km from the ephemeris in half a day); the velocity match within ten
standoffs (else the phasing again); capped closing burns into the sphere; the capture at the periapsis; trims to
the circle TINY_ORBIT_BAND_SHARE of the way from the highest ground to the sphere (the thrusters' 0.1 m/s floor
leaves about a kilometre of apoapsis above it).

**The marginal bodies (fleet-data's six: Dione, Enceladus, Io, Mercury, Mimas, Miranda): NOT flown.** What stops
it, exactly: (1) the refuelled cruiser starts its departure in the HIGH refuel orbit (perigee 200 km, apogee 0.4
of the Earth's sphere); the pilot's `ejectionBurn` assumes a circular parking orbit (circular speed at the burn
point), so a departure from that ellipse needs its generalisation (the burn at the ellipse's periapsis, the apse
line set by the scenario to the window's ejection point; about 40 lines in transferMath.ts) - the multi-flight
assembly itself (depot flights, docking, transfer) is outside this package's pilot; (2) every flight of the
reworked Albatross currently ends in the departure burn (Callisto, above), and Mercury, Enceladus and Mimas all
need it; (3) Mercury's capture (5.3 km/s at 0.33 g, about 27 minutes at a small body) has not been tried. Enceladus
and Mimas (spheres of 483 and 495 km) would take the tiny-moon rendezvous at Saturn, which flies for Phobos.

**Measured on the way** (the defects fixed here): the old Stumpff form lost the long arcs (1 - cos z cancels near
the upper bracket); a departure aimed by the arc between the centres misses by gigametres; a compass search moves
prograde first and spent 1,106 m/s on a correction that Newton does with 12; the Albatross's slow-spool engines
leave up to 83 m/s of a burn unflown by PilotCore's cut-off (src/pilot/core.ts, not this package's: a burn ends
untrimmed above 6 m/s left; the corrections absorb it); a cost that let an encounter with a large periapsis error
cost more than a near miss made the search leave Jupiter (fixed: MOON_MISS, NO_ENCOUNTER, NOTHING_FOUND).

## 7. For the next packages

- **universe-directory**: `boundaryOf(bodyId, r, v, rules.expiry.lostDistance)` is the 'lost' and
  'photosphere' query; the planning service calls are listed in section 2; forecast chains for passive vessels
  can use `propagateAtTick` (exact phase at any lead).
- **session-switch**: re-run tests/unit/solar-system on `LocalSession` (they are session-free except the transfer
  flight tests, whose commands are in section 6). The whole flights need request -4 first; the arrival legs
  (`SOLAR_SYSTEM_FLIGHTS=arrival`) run today and are the cheap part of the gate.
- **bodies-activation**: `node tools/bodies/activate.mjs --dry-run`, then without `--dry-run`; it prints what to
  re-baseline. Switch the terrain consumers to `preload: 'launchSystems'` (request -1 item 6: realWorld.ts:73,
  game.ts:182). After the activation the shipped root is the Sun: request -4 must be in first, or every craft that
  leaves the Earth's sphere is broken in the shipped game too. The reach table's four open bodies: request -3.
- **contact-docking**: relative state and LVLH are in src/sim/nav/target.ts (port alignment is yours).
- **map-multiplayer**: targetApproach markers from `targetApproachMarkers`; `Patch.bodyPosAtEnd` stays the body
  at the patch end (the at-intercept anchor is computed on the map side, RENDER_API 19.1).
