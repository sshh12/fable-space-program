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
npx tsx tools/sim/findStartTime.ts            # rewrites tools/sim/start-time.json (about 3 s)
SIM_ORBITS_VERBOSE=1 npx vitest run tests/unit/sim-orbits/soi.test.ts --silent=false   # per-trajectory SOI table
```

141 tests in 10 files (boundaries test included), about 3.8 s in total. Files:
`src/sim/orbit/kepler.test.ts` (propagator acceptance),
`tests/unit/sim-orbits/{anomaly,bodies,patches,soi,nav,warp,timing,startTime}.test.ts`. The package is
headless: there are no browser specs or screenshots for it.

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
| Pad inertial speed 465.1 cos(lat) +/- 0.5 m/s | resolved Ka Lae pad (18.987556 N): 439.303 m/s vs 439.794: passes by 0.009 m/s. 465.1 m/s is omega x the WGS-84 equatorial radius; the physics datum is the 6,371 km sphere, which gives omega R cos(lat) = 464.58 cos(lat) exactly (also tested). At the equator the difference would be 0.52 m/s |
| Sidereal day 86,164.09 s | 86,164.0905 s |
| Sun declination at solstices/equinoxes within 0.05 deg | worst 0.0032 deg (2024-2025, 8 events) |
| USSA-76 at 0/11/20/32/47/51/71/86/100/150 km within 0.1 %; zero density at simTop | worst 4.7e-5 relative (T, p, rho); density exactly 0 at and above simTop, smooth fade from simTop - 10 km |
| TLI: 185 km coplanar parking orbit, ~3,150 m/s prograde node -> Earth -> Moon (soiEnter) with perilune marker; retrograde node at perilune -> closed lunar patch | met (example: SOI entry 3.09 d after the node, perilune 320 km, capture 782 m/s gives e < 1e-6) |
| Return Moon -> Earth with atmosphereEntry marker lat/lon = independent propagation + Earth rotation within 0.01 deg | met: 2e-12 deg latitude, 2e-10 deg longitude (entry speed asserted 10.5-11.2 km/s, FPA < 0) |
| Multi-revolution: node 3.4 periods ahead, nuEnd - nuStart = 3.4 x 2 pi within 1e-6, planned after it, nodeBurn timing, nextWarpEvent reports it; same with tStart far in the past | met: circular and e = 0.2 orbits, orbit epoch 1e7 s in the past, and a node 1000.4 periods ahead |
| Landing-target readout (analytic distance/bearing, ahead/behind/left/right signs, miss = marker-to-target arc, null without target) | met |
| Navball: known attitudes, markers, no NaN at zero velocity / on the pad / vertical / at a pole | met; pitch exact at the vertical (worst 90 deg error < 1e-12 deg over 400 pad states at any latitude, time and azimuth; a 1e-8 rad tilt reads 90 - 5.7e-7 deg to 1e-10) |
| Warp look-ahead never steps past an event (property test) | met: 200,000 random cases + a simulated fall from 40,000 km over the Moon through every admissible level |
| Launch opportunity: pad in the Moon's orbit plane at the returned time within 0.01 deg | met (~1e-12 deg; analytic solution) |
| Timings: propagate < 2 us; predictPatches with a node through an SOI change < 1 ms | 0.33-0.34 us/call; 0.26-0.29 ms (0.26-0.27 ms with target markers and a terrain callback). Measured with CPU load at 94-97 % from concurrent agents (earlier run at 77 %: 0.26-0.31 us, 0.20-0.24 ms): provisional |

## Scenario start time (tools/sim/start-time.json)

Computed for the RESOLVED pad (bake-earth commit 46b8647: 18.987556 N, 155.603239 W, 21.62 m) and the
nominal target. **With constraint (a) as the brief defines it (coplanar ASCENDING azimuth), the three
constraints cannot be met in 2027-2030**, for the nominal target (0.674 N, 23.473 E) or the bake-recommended
one (0.661471 N, 23.435999 E). The lunar Sun climbs ~24.4 deg between start + 3 d and start + 5 d, leaving a
5.6 deg band of admissible start elevations; consecutive ascending opportunities step 12.2 deg, and pad
mornings occur ~25 days a year. Closest misses: 2028-08-07T18:10:13Z (landing Sun 4.35 -> 28.83 deg, 0.65 deg
short), 2029-08-26 (1.75 deg over), 2027-08-19 (2.62 deg short). The tool therefore extended the search
(recorded as `search.searchExtended: true` with the near misses) and chose the first exact solution:

| | |
|---|---|
| startUt | **1187932081.163427** = 2037-08-23T17:08:01.163Z |
| launch opportunity | start + 600.000 s (2037-08-23T17:18:01Z), coplanar, ascending; surface azimuth 80.598 deg (inertial 81.125) |
| pad Sun | 13.67 deg at start, rising (16.02 deg at launch) |
| landing Sun (+3 d .. +5 d) | 9.51 -> 33.96 deg, rising throughout, disc fully visible |
| site / target used | ka-lae-lc1 18.987556, -155.603239, pad elevation 21.62 m (data/defs/sites/ka-lae-lc1.location.json); landing 0.674 N, 23.473 E on moon (built-in default: no scenario exists yet) |

The same date is the first solution for the bake-recommended target (9.47 -> 33.93 deg). The DESCENDING
crossing (~99 deg, equally coplanar: no plane change at TLI) has solutions inside 2027-2030, recorded in
`otherLaunchKinds`: 2028-10-05T17:42:46.7Z (pad Sun 19.85 deg, landing Sun 5.23 -> 29.65 deg) and
2029-09-24T18:26:58.8Z (ut 938240818.839663; pad Sun 30.87 deg, landing Sun 7.47 -> 31.90 deg, >= 1 deg margin
everywhere; what `--launch-kind either` or `descending` chooses). `--landing-sun-min 4` gives
2028-08-07T18:10:13Z (ut 902556613.3253119). The policy decision is asked of the lead in
`docs/requests/sim-orbits-1.md`. Whatever is chosen, the scenario test must call `checkStartConstraints` with
the values of `start-time.json` `constraints` (launchKind included); the sim-orbits test does, and also
re-checks every `otherLaunchKinds` solution with its kind.

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
  `sqrtMu, r0m, sigma0, alpha (1/a), period (closed orbits; also bound near-radial ones), conic, radial
  (|r0 x v0| <= 1e-12 |r0| max(|v0|, v_circ)), nearRadial (p < 1e-6 |r0|)`. Throws on non-finite input or
  |r0| = 0. Every state propagates exactly from the epoch, radial ones included.
  `conic` (the Patch.conic wire format): tPeriapsis = the periapsis passage nearest t0 from the
  cancellation-free relations (for near-radial orbits from the universal anomaly of the state, not from the
  ill-conditioned true anomaly); `period` = Orbit.period when e < 1, else null. Near-radial: `a = 1/alpha`
  (finite) and e strictly on the side of 1 its energy says (a rounded-over e is moved to 1 -/+ 1 ulp).
  **Radial conic** (documented degenerate case, test `conic.p === 0`): `{ e: 1, p: 0, a: 1/alpha, P: -r_hat
  (the limit periapsis direction), W: an arbitrary unit normal, period: null }`; the vessel stays at true
  anomaly pi (patch nuStart = nuEnd = pi), so anomaly-based helpers do not apply; positions follow from
  (a, tPeriapsis, P) by `conicStateAtTime`.
- `conicStateAtTime(conic, t): StateVector` - state from the periapsis passage (universal variables
  anchored at the periapsis; nothing divides by p or 1 - e): valid for every conic, exact for radial and
  near-radial ones to |v| x ~1e-7 s (the resolution of t - tPeriapsis at ut ~ 1e9 s).
  `timeSincePeriapsisOfState(sqrtMu, alpha, r, sigma, rp)` - the matching time-since-periapsis of a state.
- `propagate(o, t): StateVector`, `propagateInto(o, t, outR, outV)` (allocation-free), `positionAt(o, t)`:
  universal variables from the epoch state every time; elliptic time of flight reduced modulo the period
  (to (-P/2, P/2]); Stumpff by series for |psi| <= 1, closed forms beyond; Laguerre-Conway (n = 5) to
  1e-14 relative, bisection on the monotonic Kepler function as fallback.
- `reanchor(o, t)` (same trajectory, new epoch), `solveUniversalAnomaly(o, dt, maxIter?)`,
  `lagrangeCoefficients(o, t)`, `stumpff(psi)`, `specificEnergy(mu, r, v)`.
- Anomalies: `timeFromPeriapsis(e, p, mu, nu)` (well conditioned for every e incl. e ~ 1: Barker at e = 1;
  elliptic results in (-P/2, P/2]; +/-Infinity beyond a hyperbola's asymptote) - the same relation as core
  `timeSincePeriapsis`, which UI consumers evaluate on Patch.conic; tests/unit/sim-orbits/anomaly.test.ts
  pins the agreement (<= 1e-13 + 4e-16/|1 - e| relative; inside core's |e - 1| < 1e-9 Barker band the core
  drops (1 - e) terms and differs by up to 1e-4 far from periapsis). Request sim-orbits-3 asks core to adopt
  the sim form so the sim can call it. `meanAnomalyFromTrue(e, nu)`, `eccentricFromMean(e, M)`,
  `trueFromEccentric(e, E)`, `atanOverX`, `atanhOverX`; `trueAnomalyAt(o, t)`;
  `timeOfTrueAnomaly(o, nu, tAfter)` (first time strictly after tAfter; any number of revolutions ahead).
  (The former `maxTrueAnomaly(e)` is gone: use core `conicMaxTrueAnomaly(conic)`.)
- Radius crossings and apsides: `radiusCrossingAnomaly(o, R)` (= core `conicRadiusCrossing(o.conic, R)`),
  `nextRadiusCrossing(o, R, +1 outbound | -1
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
  - `predictPatchesWithOrbits(...)` - same, each patch as `PatchWithOrbit = { patch, orbit }` (the Orbit the
    patch was propagated on).
  - `stateOnPatches(patches: readonly (Patch | PatchWithOrbit)[], t): { bodyId, r, v, patchIndex } | null` -
    first patch with tStart <= t <= tEnd. With PatchWithOrbit items the state is the exact propagation of
    the stored Orbit (use this for the node pre-burn state); plain Patch items go through `patchOrbit`.
  - `patchOrbit(patch): Orbit` - re-built from the contract data alone: ordinary conics from the state at
    nuStart (exact to rounding); radial (p = 0) and near-radial conics (1 + e cos nuStart < 1e-6) by
    `conicStateAtTime(conic, tStart)` (sub-mm: measured <= 1e-5 m over lunar drops/ascents and <= 6e-4 m
    for an 11 km/s radial Earth arrival). Never throws for a patch produced by predictPatches.
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
  Below 1e-3 m/s prograde = up; vertical prograde takes north (projected) as normal. pitch =
  atan2(nose . up, |nose - (nose . up) up|) (asin(nose . up) without its ~1e-6 deg loss at the vertical);
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
  StartConstraintReport` - (a) the next coplanar crossing of `options.launchKind` (`StartLaunchKind =
  'ascending'` (default, the brief's definition) | `'descending'` | `'either'`) at start + 600 +/- 30 s,
  (b) pad Sun 10-35 deg and rising, (c) landing Sun within 5-35 deg, rising and with the disc fully visible
  (>= 0.999) at 10-minute samples over start + 3 d .. + 5 d. `options` overrides any number
  (`START_CONSTRAINT_DEFAULTS`; an option given as undefined keeps the default). `report.launch` carries
  `{ ok, crossingUt, delay, launchAzimuthDeg, inertialAzimuthDeg, ascending }`.
  Also `launchWindowKind(kind)` (-> computeLaunchWindow kind; 'either' = 'next'), `sunAtSurfacePoint(system,
  point, ut)` -> `{ elevation, rate, visibility }`, `padSunOk(...)`, `surfacePointFromDeg(bodyId, latDeg,
  lonDeg, elevation?)`.

### tools/sim/findStartTime.ts

`npx tsx tools/sim/findStartTime.ts [--site id] [--pad-elevation m] [--target body] [--landing-body body]
[--landing-lat deg] [--landing-lon deg] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--extend-years n]
[--pad-sun-min/max deg] [--landing-sun-min/max deg] [--stay-from-days d] [--stay-to-days d]
[--launch-kind ascending|descending|either] [--out path]`.
Defaults from data/defs (site of the first scenario with a suggested landing, else the only site; numeric
padElevation, else 0 m with a note; scenario target, else the first attractor of the site's body; scenario
landing, else 0.674 N 23.473 E; launch kind ascending). Every opportunity of the launch kind in [from, to)
is a candidate (start = crossing - 600 s); the first solution with 1 deg margin on each elevation bound wins
(else the first solution). If none exists in the range it prints the near misses and continues year by year
(default 20 years, 0 = fail with exit code 1); constraints are never relaxed implicitly. Output records the
site/target coordinates and constraint numbers used (launchKind included), the angles, near misses,
alternatives, and `otherLaunchKinds` (what the requested range holds under each other launch kind).

## Integration notes for sim-world-pilot

- Build one `BodySystem` per library and share it. Vessel states stay in BCI of the SOI body; SOI
  transitions: entering child C at tx: r - stateRelParent(C, tx), v - ...; leaving body B to its parent:
  r + stateRelParent(B, tx). Patches give the exact tx (`endReason` soiEnter/soiExit at `tEnd`).
- Rails: `makeOrbit` once at the hand-over, `propagate(orbit, ut)` every frame (no drift at any warp).
- Patch refresh: call `predictPatches` with `terrainHeight` = a band-limited `TerrainProvider.heightAt`
  closure (e.g. lambdaMin 200 m) on the resident level; impact markers then carry lat/lon for the impact-disc
  terrain request.
- NodeBurnInfo: dvRemaining = `nodeDeltaVInertial(node.dv, pre.r, pre.v)` with `pre = stateOnPatches(items,
  node.ut)`, `items` = the `current` list of `predictPatchesWithOrbits` (exact pre-node state), until the burn
  starts, then the world's bookkeeping vector. Publish `items.map((x) => x.patch)` in the snapshot.
- Radial patches (`conic.p === 0`, e.g. a vessel at rest or moving vertically at the lunar pole) have
  nuStart = nuEnd = pi: their line cannot be drawn from (conic, nu). Map-view's sampler returns an empty
  curve for such a span (no NaN); the start position and the end marker's `r` give the segment. The
  convention is proposed for the ConicElements doc in request sim-orbits-3.
- Warp per frame: `cap = min(requested, maxWarpIndexForAltitude(def, alt), lookAheadWarpIndex(ut,
  nextWarpEvent({... warpIndex: current})))`, then `railsAdvanceTarget`. Re-evaluate after every clamp.
- Navball mode: keep the previous altitude and apply `navballModeAfter` each snapshot; PlayerCommands
  setNavballMode overrides until the next crossing.
- Pad: `padState(system, site, ut, resolvePadElevation(site, terrain.heightAt(...)), rootPartHeight)`.

## Requests filed

- `docs/requests/sim-orbits-1.md` (non-blocking, lead): start-time constraints with an ASCENDING launch are
  infeasible in 2027-2030 at the resolved pad; options: accept 2037-08-23 (current file), accept either
  coplanar azimuth (descending 2029-09-24, or 2028-10-05 with 0.23 deg margin), relax the landing-Sun minimum
  to 4 deg (2028-08-07), or change the stay window.
- `docs/requests/sim-orbits-2.md` (non-blocking, lead): document the sign of `NavballState.rollDeg` in
  sim.ts and flip FakeSim's roll to the control sign (flight-ui's ADI already assumes it).
- `docs/requests/sim-orbits-3.md` (non-blocking, src/core/math/conic.ts): adopt the cancellation-free
  time-since-periapsis relation in core `timeSincePeriapsis` (then the sim drops its copy), and document the
  radial-conic convention (p = 0, e = 1) and the period/e band in the ConicElements comment.

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
- Radial trajectories: the patch `conic` is the documented degenerate radial conic (p = 0, e = 1); times
  and markers are exact (universal-anomaly closed forms); AN/DN are not produced for near-radial patches.
  Consumers that only have the conic cannot draw a radial patch (see the integration note) and lose
  ~1e-16 r^2/p in true-anomaly reconstructions of near-radial ones; `conicStateAtTime` is exact for both.
- Duplication with src/core/math: `timeFromPeriapsis` remains the sim's own (better conditioned) form of
  core `timeSincePeriapsis` until request sim-orbits-3 is answered; the agreement is pinned by a test. The
  former copies of `conicRadiusCrossing` and `conicMaxTrueAnomaly` were replaced by the core functions.
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
- Ka Lae LC-1 was resolved by bake-earth (commit 46b8647) to 18.987556 N, 155.603239 W, padElevation 21.62 m;
  tools/sim/start-time.json was regenerated for it (the startTime test fails when the site moves again
  without a re-run).
- The Moon's fixed Kepler elements match the real mean longitude only AT THEIR EPOCH (J2000: lan + argPe +
  M0 = 218.316 deg, as Meeus). The model mean motion sqrt((mu_E + mu_M)/a^3) = 13.19434 deg/day (period
  27.2844 d, required by the 27.285 d acceptance) exceeds the real 13.17640 deg/day by 0.01794 deg/day = 6.55
  deg/year, so the model Moon leads the real one by ~187 deg in mid-2028, ~195 deg in late 2029 and ~247 deg
  in August 2037. Lunar phases are self-consistent (the Sun is the real Almanac Sun) but do NOT match real
  calendar dates; sky/render must take phases from the body system, never from a real ephemeris. No nodal
  regression or apsidal precession, by design.

## Changes by the lead between the waves (2026-11-10)

- `sim-orbits-1` decided: constraint (a) accepts EITHER coplanar azimuth. `tools/sim/start-time.json` was
  regenerated with `npx tsx tools/sim/findStartTime.ts --launch-kind either --landing-lat 0.661471
  --landing-lon 23.435999` (final pad, bake-recommended target): **startUt 938240818.839663 =
  2029-09-24T18:26:58.8Z**, launch at +600 s on the descending crossing, surface azimuth 99.40 deg, pad Sun
  30.87 deg, landing Sun 7.44 -> 31.86 deg. The section "Scenario start time" above describes the superseded
  2037 file. `START_CONSTRAINT_DEFAULTS.launchKind` is still 'ascending' (the function default); the scenario
  test passes `launchKind: 'either'` from the file's `constraints`.
- `sim-orbits-2` resolved: `NavballState` documents pitch, heading and roll (roll positive = rotation about
  +Y, the sign of the roll control); FakeSim now computes the same angles as `attitudeAngles`.
- `sim-orbits-3` resolved: `timeFromPeriapsis(e, p, mu, nu)`, `atanOverX` and `atanhOverX` moved to
  `src/core/math/conic.ts`; core `timeSincePeriapsis(c, nu)` calls it; `src/sim/orbit/anomaly.ts` re-exports
  the three (no copy left, same import paths for sim code). The ConicElements comment documents the radial
  convention (`p === 0`) and the period band. "Known limits: duplication with src/core/math" above is gone.

Full list: `docs/handoff/lead-baseline.md`.
