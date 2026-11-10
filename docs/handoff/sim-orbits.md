# sim-orbits hand-off

Orbital mechanics, body system, frames, patched-conic prediction, warp maths, navball and navigation
readouts, launch-window and start-time maths. Pure, deterministic float64 functions of state and `ut`
(no DOM, timers, `Math.random`, `Date`, `performance` under `src/sim`). SI units, radians, frames and
quaternions per ARCHITECTURE section 3. Imports: `src/core` and the four owned directories only.

Owned paths: `src/sim/orbit`, `src/sim/frames`, `src/sim/bodies`, `src/sim/nav`, `tests/unit/sim-orbits`,
`tools/sim`, this file. Every module has an `index.ts` barrel (`import { ... } from '@/sim/orbit'` etc.).

## Run and verify

```
npm run typecheck:paths -- src/sim/orbit src/sim/frames src/sim/bodies src/sim/nav tests/unit/sim-orbits tools/sim
npx vitest run src/sim/orbit src/sim/frames src/sim/bodies src/sim/nav tests/unit/sim-orbits tools/dev/boundaries.test.ts
npx tsx tools/sim/findStartTime.ts            # rewrites tools/sim/start-time.json
SIM_ORBITS_VERBOSE=1 npx vitest run tests/unit/sim-orbits/soi.test.ts --silent=false   # per-trajectory SOI table
```

116 tests, about 2.5 s in total. Files: `src/sim/orbit/kepler.test.ts` (propagator acceptance),
`tests/unit/sim-orbits/{bodies,patches,soi,nav,warp,timing,startTime}.test.ts`.

## Acceptance criteria - measured

| Criterion | Result |
|---|---|
| Kepler: f gdot - fdot g = 1 to 1e-12 | met for e in {0, 0.01, 0.5, 0.97, 1 - 1e-9, 1 + 1e-9, 1.3, 5} at 5-6 times each |
| Energy and angular momentum to 1e-10 | met, same set |
| Forward/backward round trip | met (< 1e-10 relative) |
| RK4 reference to 1e-6 over one period | met (open orbits: over 20,000 s) |
| Exact after 1e6 periods | met (< 1e-6 relative; float time resolution is the limit) |
| SOI entry/exit vs patched-gravity RK4 within 0.5 s, >= 20 randomised translunar + return, grazing, no missed encounter | 38 trajectories (20 random arrivals, 6 constructed grazes at -1 m / -20 m / -500 m / -5 km / +2 m / +300 m true minimum depth, 4 TLI departures from 185 km, 8 lunar departures); 50 transitions, worst 0.78 ms (the 1 m-deep graze, 21 s inside the SOI); event lists identical, no missed or spurious encounter |
| Moon period 27.285 d +/- 0.01 | 27.2844 d |
| Perigee / apogee 363,300 / 405,500 km +/- 500 | 363,295.5 / 405,502.5 km |
| Inclination to Earth's equator 20.9 +/- 0.1 deg | 20.890 deg |
| Sub-Earth libration within +/- 8 deg | max |lat| 5.16 deg, max |lon| 6.42 deg (mean longitude < 1 deg) |
| Pad inertial speed 465.1 cos(lat) +/- 0.5 m/s | 439.005 m/s vs 439.496: passes by 0.009 m/s. 465.1 m/s is omega x the WGS-84 equatorial radius; the physics datum is the 6,371 km sphere, which gives omega R cos(lat) = 464.58 cos(lat) exactly (also tested). At the equator the difference would be 0.52 m/s |
| Sidereal day 86,164.09 s | 86,164.0905 s |
| Sun declination at solstices/equinoxes within 0.05 deg | worst 0.0032 deg (2024-2025, 8 events) |
| USSA-76 at 0/11/20/32/47/51/71/86/100/150 km within 0.1 %; zero density at simTop | worst 4.7e-5 relative (T, p, rho); density exactly 0 at and above simTop, smooth fade from simTop - 10 km |
| TLI: 185 km coplanar parking orbit, ~3,150 m/s prograde node -> Earth -> Moon (soiEnter) with perilune marker; retrograde node at perilune -> closed lunar patch | met (example: SOI entry 3.09 d after the node, perilune 320 km, capture 782 m/s gives e < 1e-6) |
| Return Moon -> Earth with atmosphereEntry marker lat/lon = independent propagation + Earth rotation within 0.01 deg | met: 2e-12 deg latitude, 2e-10 deg longitude (entry speed asserted 10.5-11.2 km/s, FPA < 0) |
| Multi-revolution: node 3.4 periods ahead, nuEnd - nuStart = 3.4 x 2 pi within 1e-6, planned after it, nodeBurn timing, nextWarpEvent reports it; same with tStart far in the past | met: circular and e = 0.2 orbits, orbit epoch 1e7 s in the past, and a node 1000.4 periods ahead |
| Landing-target readout (analytic distance/bearing, ahead/behind/left/right signs, miss = marker-to-target arc, null without target) | met |
| Navball: known attitudes, markers, no NaN at zero velocity / on the pad / vertical / at a pole | met |
| Warp look-ahead never steps past an event (property test) | met: 200,000 random cases + a simulated fall from 40,000 km over the Moon through every admissible level |
| Launch opportunity: pad in the Moon's orbit plane at the returned time within 0.01 deg | met (~1e-12 deg; analytic solution) |
| Timings: propagate < 2 us; predictPatches with a node through an SOI change < 1 ms | 0.26-0.31 us/call; 0.20-0.24 ms (0.25 ms with target markers and a terrain callback). Measured with CPU load at 77 % from concurrent agents: provisional |

## Scenario start time (tools/sim/start-time.json)

**The three constraints cannot be met in 2027-2030** for Ka Lae (19.1 N, 155.5 W, nominal) with either the
nominal target (0.674 N, 23.473 E) or the bake-recommended one (0.661471 N, 23.435999 E). The lunar Sun
climbs ~24.4 deg between start + 3 d and start + 5 d, leaving a 5.6 deg band of admissible start elevations;
consecutive ascending opportunities step 12.2 deg, and pad mornings occur ~25 days a year. Closest misses:
2028-08-07T18:12:53Z (landing Sun 4.38 -> 28.85 deg, 0.62 deg short), 2027-08-19 (2.40 deg), 2030-08-14
(2.13 deg). The tool therefore extended the search (recorded as `search.searchExtended: true` with the
near misses) and chose the first exact solution:

| | |
|---|---|
| startUt | **1187932241.4598682** = 2037-08-23T17:10:41.460Z |
| launch opportunity | start + 600.000 s (2037-08-23T17:20:41Z), coplanar, ascending; surface azimuth 80.865 deg (inertial 81.377) |
| pad Sun | 14.41 deg at start, rising (16.75 deg at launch) |
| landing Sun (+3 d .. +5 d) | 9.53 -> 33.99 deg, rising throughout, disc fully visible |
| site / target used | ka-lae-lc1 19.1, -155.5, pad elevation 0 m (definition says 'terrain'; geocentric angles do not depend on it); landing 0.674 N, 23.473 E on moon (built-in default: no scenario exists yet) |

The same date is the first solution for the bake-recommended target (9.5 -> 33.9 deg). If a 2028 date is
preferred, `npx tsx tools/sim/findStartTime.ts --landing-sun-min 4` gives 2028-08-07T18:12:53Z (ut
902556773.6217529); this is the decision asked of the lead in `docs/requests/sim-orbits-1.md`. Whatever is
chosen, the scenario test must call `checkStartConstraints` with the same numbers as `start-time.json`
`constraints` (the sim-orbits test does).

## Public API

All functions are pure unless noted; `ut` is seconds since J2000; vectors are float64 `Vec3`.

### src/sim/bodies

- `createBodySystem(defs: DefLibrary): BodySystem` - validates and builds every body (throws `DefError`
  naming the file: one root, one star with `emission`, non-root attractors need an orbit and `soiRadius`,
  `warpAltitudeLimits` must have `RAILS_WARP_LEVEL_COUNT` (= 7) entries, `tidalLock` needs a kepler orbit).
- `interface BodySystem`
  - `defs`, `rootId`, `starId`, `ids` (parents before children, siblings by id).
  - `body(id): BodyInfo` - `{ id, def, mu, radius, parentId, childIds (attractor children, sorted), soiRadius
    (resolved; 'auto' = a (m/M)^0.4; null for root / light-only), attractor, star, kepler (KeplerEphemeris |
    null), rotation (RotationModel), spin (ROOT axes, rad/s) }`.
  - `stateRelParent(id, ut): StateVector` - state relative to the parent, parent BCI axes (zero for root).
    Kepler: fixed mean elements, mean motion from mu_parent + mu_body, 'ecliptic' elements rotated by
    Rx(23.4392911 deg), 'parentEquator' by the parent's pole; Kepler's equation solved to machine precision.
    'sunLowPrecision': the Astronomical Almanac formula exactly as sim-design 2.3, with its analytic derivative.
  - `stateRoot(id, ut)`, `stateRelative(id, originId, ut)` - ROOT-axes states.
  - `orientation(id, ut): Quat` - BCBF -> BCI (= BCBF -> ROOT): Rz(alpha0 + 90) Rx(90 - delta0) Rz(W). Earth:
    W = w0Deg + rate (ut - epoch). Moon ('tidalLock'): rate = orbital mean motion, W0 so that +X points at
    the mean sub-parent point at the orbit epoch. 'none': identity.
  - `spin(id): Vec3` - pole x rate, ROOT axes (zero for 'none').
  - `orbitConic(id, ut): ConicElements | null` - orbit about the parent (parent BCI), tPeriapsis = passage
    nearest ut; null for root and star.
  - `sunDirection(posRoot, ut): { dir, distance }` - from a ROOT position to the star centre.
  - `sunVisibility(posRoot, ut): number` - visible fraction 0..1 of the star's disc behind every other body:
    exact limb geometry in the tangent plane at the Sun (osculating circle tan(rb), circular-segment areas
    without cancellation; error O(r^2) ~ 1e-5 of the disc); several occulters at once by exact chord-union
    integration; a point on or below a body's datum sphere sees that body as its horizon plane.
  - `buildBodySnapshots(ut): BodySnapshot[]` - one per body in `ids` order. The star's own snapshot has
    `sunDir` = root -> star and `sunDistance` 0.
- `orbitalEnvironment(system, bodyId, ut, rBci): OrbitalEnvironment` - the body-system members of
  `VesselEnvironment` (ut, bodyId, mu, radius, qFixedToInertial, spin, atmosphereAt, heating, sunDir,
  sunVisibility). The world adds terrainHeight/terrainNormal/surfaceKind/surfaceFriction/ocean.
- `atmosphereAt(body: BodyDef, altitude): AtmosphereSample` - VACUUM without atmosphere or at/above simTop;
  density AND pressure multiplied by 1 - smoothstep(simTop - 10 km, simTop, h); temperature and speed of
  sound not faded. 'ussa76': sim-design 8.1 exactly (geopotential layers below 86 km with the tabulated base
  pressures, R = 8.314462, M = 0.0289644; log-linear table from 86 km, a = 275 m/s there). 'table':
  log-linear rho/p, linear T, end segments extrapolated. 'exponential': rho0 e^(-h/H), p0 e^(-h/H) or
  rho R T, T = temperature or p0/(rho0 R). Models are validated and cached per definition object.
- `atmosphereModelRaw(body, altitude)` - the model without the fade/simTop cut (diagnostics, tests).
- `atmosphereFunction(body): (altitude) => AtmosphereSample` - bound form for VesselEnvironment.
- Lower level: `KeplerEphemeris` (`a, e, n, M0, epochUt, mu, P, Q, period, normal, meanAnomaly(ut),
  stateAt(ut)`), `sunLowPrecisionState(ut)`, `OBLIQUITY_J2000`, `AU`, `Q_ECLIPTIC_TO_EQUATORIAL`,
  `rotationModel(def, orbit, bodyId)`, `orientationAt(model, ut)`, `primeMeridianAngle(model, ut)` (rad,
  [0, 2 pi)), `poleQuat(raDeg, decDeg)`, `spinVector(model)`, `occultedFraction(rs, rb, sep)`,
  `sunVisibleFraction(point, starPos, starRadius, spheres)`.

### src/sim/frames

- `inertialToFixed(qFixedToInertial, v)`, `fixedToInertial(q, v)`; `bciToBcbf(system, bodyId, ut, r)`,
  `bcbfToBci(...)`, `latLonAltAt(system, bodyId, ut, rBci): { latitude, longitude, altitude }`.
- `latLonAlt(rFixed, radius)`, `dirFromLatLon(lat, lon)`, `fixedPosition(lat, lon, radius)`.
- `enuBasis(qFixedToInertial, rBci): { east, north, up }` (BCI axes; up geocentric; east = pole x up; at a
  pole east = the body-fixed +Y direction projected), `enuBasisFixed(rFixed)`, `enuFromPole(r, pole, fallback)`,
  `qEnuToInertial(basis): Quat` (ENU -> BCI), `azimuthOf(dir, basis)` (rad, [0, 2 pi) from north),
  `directionOfAzimuth(az, basis)`.
- `surfaceVelocity(r, v, spin) = v - spin x r` (co-rotating air too), `corotationVelocity(r, spin)`.
- `resolvePadElevation(site, terrainElevation?): number` - the definition's number, or the supplied terrain
  height when the definition says 'terrain' (throws if missing).
- `padState(system, site, ut, padElevation, heightAbovePad = 0): PadState` - `{ bodyId, latitude, longitude,
  elevation, rFixed, r, v (= spin x r), q (VES -> BCI: nose up, ventral -Z toward padAzimuthDeg, X = Y x Z),
  qFixed (VES -> BCBF), enu, azimuth }`.

### src/sim/orbit

- `makeOrbit(bodyId, mu, r0, v0, t0): Orbit` - `Orbit = { bodyId, mu, r0, v0, t0 }` plus derived
  `sqrtMu, r0m, sigma0, alpha (1/a), period (closed orbits; also bound radial ones), conic (ConicElements with
  a cancellation-free tPeriapsis and period = Orbit.period), radial, nearRadial (p < 1e-6 |r0|)`. Throws on
  non-finite input or |r0| = 0. A radial state (r x v = 0) propagates exactly; its `conic` is the e -> 1 limit.
- `propagate(o, t): StateVector`, `propagateInto(o, t, outR, outV)` (allocation-free), `positionAt(o, t)`:
  universal variables from the epoch state every time; elliptic time of flight reduced modulo the period
  (to (-P/2, P/2]); Stumpff by series for |psi| <= 1, closed forms beyond; Laguerre-Conway (n = 5) to
  1e-14 relative, bisection on the monotonic Kepler function as fallback.
- `reanchor(o, t)` (same trajectory, new epoch), `solveUniversalAnomaly(o, dt, maxIter?)`,
  `lagrangeCoefficients(o, t)`, `stumpff(psi)`, `specificEnergy(mu, r, v)`.
- Anomalies: `timeFromPeriapsis(e, p, mu, nu)` (well conditioned for every e incl. e ~ 1: Barker at e = 1;
  elliptic results in (-P/2, P/2]; +/-Infinity beyond a hyperbola's asymptote), `meanAnomalyFromTrue(e, nu)`,
  `eccentricFromMean(e, M)`, `trueFromEccentric(e, E)`, `maxTrueAnomaly(e)`; `trueAnomalyAt(o, t)`;
  `timeOfTrueAnomaly(o, nu, tAfter)` (first time strictly after tAfter; any number of revolutions ahead).
- Radius crossings and apsides: `radiusCrossingAnomaly(o, R)`, `nextRadiusCrossing(o, R, +1 outbound | -1
  inbound, tAfter)`, `nextApsisTime(o, 'periapsis' | 'apoapsis', tAfter)` - analytic; near-radial orbits use
  closed forms in the universal anomaly from the epoch (the conic's anomalies degenerate there).
- Events (`events.ts`): `soiExitTime(o, soiRadius, tFrom)` (tFrom itself if already outside and moving out),
  `atmosphereEntryTime(system, o, tFrom)` (inbound crossing of R + simTop; none while already inside and
  descending), `findImpact(system, o, tFrom, tTo, heightFn | null): ImpactEvent | null` (shell R + max
  elevation, then a march with ground step <= 2 km against `heightFn(bodyId, dirFixed)` with the body's
  rotation at each sample, heights clamped to [minElevation, maxElevation] and raised to sea level, root
  bisected to 0.01 s, every shell pass in the window; without heightFn/terrain: analytic crossing of the
  datum or sea surface), `findSoiEntry(system, o, childId, tFrom, tTo)` (see Prediction),
  `closestApproaches(system, o, targetId, tFrom, tTo, samples = 64, maxCount = 2)` (local minima of the
  distance to a body orbiting o's body, golden-refined to 1 s, over at most one period).
  `type CoarseHeightFn = (bodyId, dirFixed) => metres`.
- Maneuvers: `nodeFrame(r, v): { prograde, normal, radial }` (unit vectors normalised before crossing;
  radial = prograde x normal), `nodeDeltaVInertial(dv, r, v): Vec3`, `deltaVInNodeFrame(dvInertial, r, v)`,
  `estimateBurnTime(dv, mass, thrust, isp)` (m1 = m0 e^(-dv/(Isp g0)), t = (m0 - m1)/mdot),
  `nodeBurnInfo(node, dvRemaining, ut, engine: { mass, thrust, isp, availableDeltaV } | null): NodeBurnInfo`
  (burnTime/timeToBurnStart null without engine; timeToBurnStart = node.ut - burnTime/2 - ut).
- Relative geometry: `relativeInclination(nA, nB)`, `nodesVersusPlane(conic, targetNormal)` -> `{
  relativeInclination, nuAscending, nuDescending, ascendingDir }` or null when coplanar (< 1e-9 rad).
- Prediction (`patches.ts`):
  - `predictPatches(system, { bodyId, r, v }, ut, nodes, opts?): { current: Patch[]; planned: Patch[] }`
    with `opts = { maxPatches = 8 (per list), horizon = 60 d (open orbits; from the list start and from every
    applied node), targetBodyId, terrainHeight: CoarseHeightFn, closestApproachSamples = 64 }`.
  - `current` = node-free trajectory. A closed patch with no event ends after one period ('closed', nuEnd =
    nuStart + 2 pi). The first future node is marked ('maneuverNode') on the patch containing it; if it lies
    beyond the natural end (one period, or the horizon for an open patch) and no event comes first, the patch
    is followed to the node (tEnd = node.ut, 'maneuver', nuEnd unwrapped by whole revolutions from the time
    of flight) and the list ends there.
  - `planned` = from the first node: state on `current` at node.ut + the node's inertial delta-v, then later
    nodes in time order, each ending its patch ('maneuver', marker at the patch end); every planned patch has
    `afterNodeId` = latest node applied. Past nodes (ut < start) are ignored; if `current` ends (impact,
    atmosphere) before the first node, `planned` is empty.
  - Per patch the earliest of: SOI exit (analytic; ignored for 1 s after entering), atmosphere entry (ends
    the list), child-SOI entry (ignored for 1 s after leaving that child), terrain impact (ends the list),
    node (planned), natural end. Child SOI entry: d(t) = |r - r_child| - R_soi with |d'| <= V = sum of the two
    periapsis speeds, so steps of d/V cannot jump a root; minimum step 30 s, inside which sampled local minima
    (grazing dips) are refined by golden section and their first root found; roots by Brent to 1 ms. A state
    already inside a child SOI and moving in enters at once; moving out is followed until outside.
  - Patch fields: conic, tStart/tEnd, nuStart (from the start position)/nuEnd, endReason, nextBodyId
    (soiEnter: child; soiExit: parent), afterNodeId, bodyPosAtEnd (ROOT position of the patch body at tEnd).
  - Markers (sorted by ut; `r` in BCI of the patch body): periapsis / apoapsis (first passage in the patch;
    altitude, latitude/longitude), ascendingNode / descendingNode vs the target's orbit plane (value =
    relative inclination; only on patches about the target's parent, not near-radial), closestApproach (value
    = distance; target orbiting the patch body; not when the patch enters the target's SOI - the next patch's
    periapsis is the encounter), soiEnter / soiExit (patch end), impact (altitude = surface height, value =
    inertial speed, body-fixed latitude/longitude at ut with the body's rotation), atmosphereEntry (altitude =
    simTop, value = inertial speed, flightPathAngle (negative descending), vacuumPeriapsisAltitude,
    latitude/longitude), maneuverNode (nodeId).
  - `predictPatchesWithOrbits(...)` - same, each patch with its `Orbit`; `patchOrbit(patch): Orbit`;
    `stateOnPatches(patches, t): { bodyId, r, v, patchIndex } | null` (e.g. the pre-node state for
    nodeDeltaVInertial / NodeBurnInfo).
- Warp (`warp.ts`): `warpFactor(index)`, `maxWarpIndexForAltitude(bodyDef, altitude)` (physics levels always;
  rails level i needs altitude >= warpAltitudeLimits[i - 4]), `warpAltitudeLimit(bodyDef, index)`,
  `lookAheadWarpIndex(ut, event | null)` (largest level with (event.ut - ut)/factor >= 4 s; never below 50x
  for 'soiChange'), `railsAdvanceTarget(ut, realDt, index, eventUt)` (= min(ut + realDt x factor, eventUt)),
  `nextWarpEvent({ system, ut, bodyId, r, v, patches, nodes?: { node, burnTime }[], warpIndex, nodeLeadTime =
  30, alarms? }): WarpEvent | null` - earliest of SOI change / impact from `patches`, atmosphere entry,
  terrain proximity (inbound crossing of max elevation + 1 km), node lead (node.ut - burnTime/2 - 30 s, any
  number of revolutions ahead), the inbound crossing of the CURRENT level's altitude-limit shell, alarms;
  events already due are reported at `ut`. `WarpEvent = { ut, kind, nodeId? }`.
- Roots: `brentRoot(f, a, b, tol, fa?, fb?)`, `bisectToNonPositive(f, a, b, tol)`, `goldenMin(f, a, b, tol)`.

### src/sim/nav

- `computeNavball({ mode, q (VES -> BCI), r, v, qFixedToInertial, spin, maneuverDv?, targetDir?,
  liftVectorVes? }): NavballState` - horizon = ENU at the sub-point; orbit mode prograde = v, surface mode =
  v - spin x r; normal = normalize(r_hat x prograde), radialOut = prograde x normal; markers are unit VES
  vectors (maneuver/target from ROOT-axes vectors, lift vector passed through normalised, null when absent).
  Below 1e-3 m/s prograde = up; vertical prograde takes north (projected) as normal. pitch = asin(nose . up);
  heading = compass direction of the nose in [0, 360), of the ventral side (nose up) / dorsal side (nose
  down) when the nose is vertical (then roll = 0); **roll positive = rotation about +Y (dorsal toward
  starboard), the sign of ControlInputs.roll** (FakeSim has the opposite sign: request sim-orbits-2).
- `navballModeAfter(mode, prevAltitude, altitude, switchAltitude)` - edge-triggered auto switch: to 'orbit'
  when rising through 1.05 x, to 'surface' when falling through 0.95 x; otherwise keeps `mode` (manual
  choices stick). `defaultNavballMode(altitude, switchAltitude)`. `tiltFromVertical(q, r)` (rad),
  `attitudeAngles(q, enu)`, `flightDirections(r, vel, enu)`.
- `computeOrbitalReadouts({ system, bodyId, r, v, ut, targetBodyId?, patches? }): OrbitalReadouts` - the
  Readouts fields altitudeAsl (above sea level, or the datum without ocean), latitude, longitude,
  speedOrbital, speedSurface, verticalSpeed (radial), horizontalSpeed (surface-relative), apoapsisAltitude
  (Infinity when open), periapsisAltitude, timeToApoapsis / timeToPeriapsis (next passage; null when none),
  inclination (to the SOI body's EQUATOR, i.e. its spin axis), eccentricity, period, targetBodyId,
  targetRelativeInclination (target orbiting the SOI body; else null), targetClosestApproach (minimum over
  closestApproach markers and target-SOI periapsis markers of `planned`, else `current`).
  `closestApproachOnPatches(patches, targetId)`.
- `computeLaunchWindow({ system, bodyId, latitude, longitude, elevation?, ut, targetBodyId, kind = 'next' |
  'ascending' | 'descending', parkingAltitude = 185 km, ascentLeadTime = 0, transferTime = 4 d }):
  LaunchWindow | null` -> `{ coplanar, crossingUt, launchUt, timeToPlaneCrossing, inertialAzimuthDeg,
  launchAzimuthDeg (surface-relative: tan azR = (v_orb sin azI - v_rot)/(v_orb cos azI)), ascending }`.
  Coplanar crossings are solved analytically for the uniform rotation (two per rotation; ascending =
  northbound); non-coplanar: due-east launch when the local-north orbit normal is perpendicular to the
  target's direction at t + transferTime (scan + Brent). Null if the target does not orbit the body or it
  does not rotate. `launchWindowReadout(input)` -> `Readouts['launchWindow']`.
  `angleFromTargetPlane(system, bodyId, rFixed, targetId, t)`.
- `computeLandingTargetReadout(targets, bodyId, subPointDirFixed, groundTrackDirFixed | null, bodyRadius,
  currentPatches): LandingTargetReadout | null` - exactly the contract: candidates = 'landing'/'recovery'
  targets on `bodyId` (null if none); the arrival point is the first impact/atmosphereEntry marker on
  `bodyId` in `currentPatches`; the target nearest to it (else to the sub-point) is used. distance = R x
  central angle; bearing = initial great-circle course; downRange = R atan2(sin d cos D, cos d), crossRange =
  R asin(sin d sin D) with D = bearing - track bearing (spherical along/cross-track; = d cos D, d sin D for
  small d); both 0 without a ground track. predicted = { kind 'impact' | 'entry', ut, latitude, longitude,
  missDistance, missBearingDeg (from the target to the point) }.
  Helpers: `groundTrackDirection(system, bodyId, r, v, ut)` (body-fixed horizontal unit vector or null below
  0.1 m/s surface speed), `greatCircle(from, to)`, `arrivalMarker(patches, bodyId)`, `targetDirection(t)`.
- `buildSurfaceTargets(defs, scenario): SurfaceTarget[]` - `landing` (suggestedLanding, radius 0),
  `site:<siteId>` (radius = pad.flatRadius), `recovery:<index>` (radius = radiusKm x 1000); radians.
- `checkStartConstraints(system, site: SurfacePoint, targetBodyId, landing, startUt, options?):
  StartConstraintReport` - (a) next ascending coplanar crossing at start + 600 +/- 30 s, (b) pad Sun 10-35
  deg and rising, (c) landing Sun within 5-35 deg, rising and with the disc fully visible (>= 0.999) at
  10-minute samples over start + 3 d .. + 5 d. `options` overrides any number (`START_CONSTRAINT_DEFAULTS`).
  Also `sunAtSurfacePoint(system, point, ut)` -> `{ elevation, rate, visibility }`, `padSunOk(...)`,
  `surfacePointFromDeg(bodyId, latDeg, lonDeg, elevation?)`.

### tools/sim/findStartTime.ts

`npx tsx tools/sim/findStartTime.ts [--site id] [--pad-elevation m] [--target body] [--landing-body body]
[--landing-lat deg] [--landing-lon deg] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--extend-years n]
[--pad-sun-min/max deg] [--landing-sun-min/max deg] [--stay-from-days d] [--stay-to-days d] [--out path]`.
Defaults from data/defs (site of the first scenario with a suggested landing, else the only site; numeric
padElevation, else 0 m with a note; scenario target, else the first attractor of the site's body; scenario
landing, else 0.674 N 23.473 E). Every ascending opportunity in [from, to) is a candidate (start = crossing -
600 s); the first solution with 1 deg margin on each elevation bound wins (else the first solution). If
none exists in the range it prints the near misses and continues year by year (default 20 years, 0 = fail
with exit code 1); constraints are never relaxed implicitly. Output records the site/target coordinates and
constraint numbers used, the angles, near misses and alternatives.

## Integration notes for sim-world-pilot

- Build one `BodySystem` per library and share it. Vessel states stay in BCI of the SOI body; SOI
  transitions: entering child C at tx: r - stateRelParent(C, tx), v - ...; leaving body B to its parent:
  r + stateRelParent(B, tx). Patches give the exact tx (`endReason` soiEnter/soiExit at `tEnd`).
- Rails: `makeOrbit` once at the hand-over, `propagate(orbit, ut)` every frame (no drift at any warp).
- Patch refresh: call `predictPatches` with `terrainHeight` = a band-limited `TerrainProvider.heightAt`
  closure (e.g. lambdaMin 200 m) on the resident level; impact markers then carry lat/lon for the impact-disc
  terrain request.
- NodeBurnInfo: dvRemaining = `nodeDeltaVInertial(node.dv, pre.r, pre.v)` with `pre = stateOnPatches(current,
  node.ut)` until the burn starts, then the world's bookkeeping vector.
- Warp per frame: `cap = min(requested, maxWarpIndexForAltitude(def, alt), lookAheadWarpIndex(ut,
  nextWarpEvent({... warpIndex: current})))`, then `railsAdvanceTarget`. Re-evaluate after every clamp.
- Navball mode: keep the previous altitude and apply `navballModeAfter` each snapshot; PlayerCommands
  setNavballMode overrides until the next crossing.
- Pad: `padState(system, site, ut, resolvePadElevation(site, terrain.heightAt(...)), rootPartHeight)`.

## Requests filed

- `docs/requests/sim-orbits-1.md` (non-blocking, lead): start-time constraints infeasible in 2027-2030;
  options: accept 2037-08-23 (current file), relax the landing-Sun minimum to 4 deg (2028-08-07), or change
  the stay window.
- `docs/requests/sim-orbits-2.md` (non-blocking, lead): document the sign of `NavballState.rollDeg` in
  sim.ts and flip FakeSim's roll to the control sign (flight-ui's ADI already assumes it).

No requests against the sim-orbits paths were open.

## Known limits and weaknesses

- Child-SOI encounters are searched over the patch window only: a closed orbit with no event ends after one
  revolution, so an encounter on a LATER revolution is not shown (KSP behaviour) - unless a node lies beyond,
  in which case the whole multi-revolution window is searched (cost grows with the number of revolutions for
  orbits that reach the child's distance; a node 1000 revolutions ahead on such an orbit would cost tens of
  ms; LEO and other orbits that cannot reach the Moon are rejected in O(1)).
- The terrain march takes 2 km ground steps through the whole time inside the max-elevation shell: a stable
  orbit inside the lunar shell (perilune and apolune between ~1 and 10.8 km) marches a full revolution,
  1.2 ms. Descent trajectories (impact within the pass) cost ~0.4 ms. A pass that skims terrain features
  narrower than ~2 km between samples can be missed by the coarse march (by design of sim-design 3.3).
- sunVisibility treats bodies as spheres of their datum radius (no terrain horizon, no atmosphere
  refraction); accuracy ~1e-5 of the disc.
- `predictPatches` stops at `maxPatches` (8); a first node beyond 8 transitions of the current trajectory
  would leave `planned` empty.
- A node exactly at an SOI boundary time yields a zero-length planned patch before the transition (harmless).
- Radial trajectories: the patch `conic` is the e -> 1 limit (P along the trajectory); times and markers are
  exact (universal-anomaly closed forms), AN/DN are not produced for near-radial patches.
- The USSA-76 gas constant is sim-design's CODATA value 8.314462 (the 1976 standard used 8.31432): sea-level
  density 1.224978 instead of 1.225 kg/m^3 (1.8e-5), within the 0.1 % acceptance; base pressures are the
  tabulated ones, so pressure is continuous across layers to ~2.5e-5 relative.
- Timings were taken on a shared, loaded machine (77 % CPU); re-measure on a quiet one.

## Data notes

- Moon pole (bodies/moon.json): only the constant IAU terms (269.9949, 66.5392) are used, which put the pole
  0.02 deg from the ecliptic pole; the latitude libration is therefore ~5.2 deg (the angle to the orbit
  normal), not the 6.7 deg sim-design quotes (that needs the E1 = 125.045 deg periodic terms: pole about
  266.82, 65.65 at J2000). Within the +/-8 deg acceptance; lead-owned data.
- Earth w0Deg = 190.46061837 is used as given (GMST at J2000 = 280.46 deg at the prime meridian: tested).
- Ka Lae pad elevation is 'terrain' in data: the start-time tool assumes 0 m (no effect on its angles).
- The Moon's fixed Kepler elements reproduce the real mean longitude closely (lunar phases realistic), but
  without nodal regression or apsidal precession by design.
