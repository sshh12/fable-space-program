# Simulation + Gameplay Design (implementation-ready)

Scope: everything in `src/sim/**` (pure TypeScript, float64, deterministic, no DOM/WebGPU imports), the data schemas it loads, the fictional vehicle and launch site, and the scripted test pilot. The renderer, audio and UI are consumers of `SimSnapshot` (section 18) and producers of `ControlInputs` only.

Numbers marked **(verified)** were checked with a throwaway 2-D ascent/re-entry integrator (USSA-76 atmosphere, rotating Earth, the masses in section 13) while writing this document; they are sanity figures, not a substitute for the real vitest mission run.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Units | SI everywhere (m, s, kg, N, K, rad). Angles in data files in degrees, converted at load. |
| Time | `ut` = seconds since J2000.0 (2000-01-01T12:00:00, treated as UTC). float64. |
| Root frame | Earth-centred inertial, J2000 mean equator/equinox. Earth is the root body and is fixed at the origin. |
| Gravity | Patched conics: point-mass gravity of the current SOI body only, both on rails and when integrating (so switching modes never causes a jump). |
| Body shape | Spheres for physics datum (Earth 6 371 000 m, Moon 1 737 400 m); terrain height from DEM tiles added radially. |
| Physics step | Fixed `DT = 1/120 s`. Contact sub-steps 4x (1/480 s). Physics warp = more steps per frame, never a bigger step. |
| Translation | Rails = universal-variable Kepler from an epoch state. Integrated = RK4. |
| Attitude | Rigid body, Euler equations, always integrated at warp <= 4x; frozen (or SAS-tracked) at rails warp > 4x. |
| Mission architecture | **Direct ascent, no rendezvous/docking** (section 12). Capsule rides the lander to the surface and back. |
| Re-entry | Lifting capsule (L/D 0.30 from CoM offset), roll controls the lift vector; vacuum perigee target 45 km. |
| Test pilot | Reads `SimSnapshot`, writes `ControlInputs` + UI-level commands only; same code runs headless and in the browser. |

---

## 1. Module layout

```
src/sim/
  math/        vec3.ts quat.ts mat3.ts roots.ts (brent, bisect, golden) interp.ts prng.ts (xoshiro128**, seeded)
  frames/      time.ts bodyFrames.ts (rotation, lat/lon, local horizon)
  orbit/       kepler.ts (universal variable) elements.ts soi.ts patches.ts maneuver.ts closestApproach.ts
  bodies/      body.ts ephemeris.ts (kepler-elements, sun-lowprec) atmosphere.ts (ussa76 + table models)
  vessel/      vessel.ts part.ts massProps.ts resources.ts staging.ts modules/*.ts (engine, rcs, gimbal,
               reactionWheel, decoupler, fairing, parachute, legs, heatShield, command, les)
  dynamics/    integrator.ts forces.ts aero.ts thermal.ts contact.ts buoyancy.ts gforce.ts
  control/     inputs.ts sas.ts actuatorAllocation.ts
  world/       sim.ts (top-level step), railsController.ts warp.ts events.ts debris.ts terrainProvider.ts
  nav/         navball.ts readouts.ts launchWindow.ts
  pilot/       testPilot.ts phases/*.ts missionPlan.ts
  data/        schema.ts loaders.ts validate.ts
data/
  bodies/*.json  vehicles/*.json  parts/*.json  sites/*.json  scenarios/*.json
```

Rules: no `Math.random`, no `Date.now`, no `performance.now` inside `src/sim`. All iteration over vessels/parts in array order. This gives bit-identical runs for the same inputs on the same JS engine (needed for replayable tests).

---

## 2. Reference frames and time

### 2.1 Frames

| Frame | Origin | Axes | Used for |
|---|---|---|---|
| `ECI` (root) | Earth centre | +Z = Earth north pole, +X = J2000 vernal equinox, right-handed | all Earth-SOI vessel states, Moon ephemeris, Sun direction |
| `BCI(b)` body-centred inertial | centre of body `b` | parallel to ECI (never rotates) | vessel states inside b's SOI |
| `BCBF(b)` body-fixed | centre of `b` | +Z = spin axis, +X = prime meridian on equator | terrain, lat/lon, atmosphere co-rotation, landed vessels |
| `ENU(p)` local horizon | surface point | East, North, Up (geocentric) | navball, launch azimuth, surface velocity |
| `VES` vessel body frame | vessel reference point (root part origin) | **+Y = nose** (stack axis, thrust direction), **+X = starboard**, **+Z = dorsal/"head-up"** | parts, inertia, torques |

A vessel state is `{ bodyId, r: Vec3, v: Vec3 }` in `BCI(bodyId)`, plus `q` (VES -> BCI rotation, unit quaternion) and `w` (angular velocity, rad/s, in VES).

Control sign conventions (VES): pitch-up = +X rotation (nose towards +Z), yaw-right = -Z rotation (nose towards +X), roll-right = +Y rotation. On the pad the vessel's **-Z (ventral) faces the site's `padAzimuthDeg`**, so "pitch down" (W key) tips the nose down-range, as in KSP.

### 2.2 Body rotation

Generic model (data-driven, `rotation` block in body JSON):

```
R_bcbf_to_bci(t) = Rz(alpha0 + 90deg) * Rx(90deg - delta0) * Rz(W0 + Wdot * (t - t0))
```

(IAU convention: pole right ascension `alpha0`, declination `delta0`, prime-meridian angle `W`.)

* **Earth**: `alpha0 = 0`, `delta0 = 90 deg` (pole = +Z_ECI, precession/nutation ignored), `W0 = 280.46061837 deg` at J2000 (GMST), `Wdot = 360.98564736629 deg/day` (= 7.292115855e-5 rad/s, sidereal day 86 164.0905 s). The 23.439 deg axial tilt appears because the Sun and Moon ephemerides are expressed in this equatorial frame.
* **Moon**: `rotation.mode = "tidalLock"`. Pole `alpha0 = 269.9949 deg`, `delta0 = 66.5392 deg` (IAU mean pole: 1.54 deg from ecliptic north, 6.7 deg from the orbit normal). `Wdot = n` (orbital mean motion from 2.3, so it never drifts). `W0` is solved at load so that at `t0` the +X axis points at the projection onto the lunar equator of the direction from the Moon to Earth evaluated with **mean** anomaly used as true anomaly (the mean sub-Earth point). Result: true synchronous rotation with natural optical libration (+/-6.3 deg longitude from eccentricity, +/-6.7 deg latitude from the pole tilt), and LRO/LOLA longitude 0 faces the Earth on average.

Derived helpers (all in `frames/bodyFrames.ts`):

```ts
bciToBcbf(body, t, r): Vec3            // position
surfaceVelocity(body, r_bci, v_bci)    // v - omega x r   (omega = spin axis * Wdot, in BCI)
latLonAlt(body, r_bcbf)                // lat = asin(z/|r|), lon = atan2(y, x), alt = |r| - body.radius
enuBasis(body, t, r_bci): {e, n, u}    // u = r/|r|, e = normalize(spinAxis x u), n = u x e
```

### 2.3 Ephemerides

`Ephemeris` interface: `stateAt(t): {r, v}` relative to the parent in the parent's BCI frame; must be a pure function of `t` (so the predictor can evaluate it at future times).

**Moon (`kind: "kepler"`)** - fixed mean elements, referred to the J2000 ecliptic and rotated into the equatorial frame at load with `Rx(obliquity = 23.4392911 deg)`:

| Element | Value |
|---|---|
| a | 384 399 000 m |
| e | 0.0549 |
| i (to ecliptic) | 5.145 deg |
| Omega (ascending node) | 125.045 deg |
| omega (arg. of perigee) | 318.308 deg |
| M0 at J2000 | 134.963 deg |
| mu used for mean motion | mu_Earth + mu_Moon = 4.035 053 1e14 m^3/s^2 |

Mean motion n = sqrt(mu/a^3) = 2.6653e-6 rad/s, period 27.285 d. Resulting inclination to Earth's equator: 20.9 deg (fixed; no nodal regression - keeping the conic exact is what makes KSP-style prediction truthful). Perigee 363 300 km, apogee 405 500 km. Position/velocity from the standard elliptic Kepler solve (Newton on E, 1e-14 tolerance) - cached per `t` within a step.

**Sun (`kind: "sunLowPrecision"`)** - direction and distance only (no gravity). Astronomical Almanac low-precision formula, `d = ut / 86400`:

```
L = 280.460 + 0.9856474 d        (deg, mean longitude)
g = 357.528 + 0.9856003 d        (deg, mean anomaly)
lambda = L + 1.915 sin g + 0.020 sin 2g
eps = 23.439 - 0.0000004 d
R = (1.00014 - 0.01671 cos g - 0.00014 cos 2g) * 149 597 870 700 m
sun_ECI = R * (cos lambda, cos eps sin lambda, sin eps sin lambda)
```

Accuracy ~0.01 deg: seasons, day/night terminator, eclipses of the Sun by Earth/Moon (shadow test is a renderer/thermal consumer: `sunVisibility(r_bci)` = cylinder/penumbra test against each body) all follow.

### 2.4 Body constants

| | Earth | Moon |
|---|---|---|
| mu (m^3/s^2) | 3.986 004 418e14 | 4.904 869 5e12 |
| radius (m) | 6 371 000 | 1 737 400 |
| SOI radius (m) | infinite (root) | 66 100 000 (a (m/M)^(2/5)) |
| atmosphere top for sim (m) | 140 000 | none |
| max terrain elevation (m) | 8 850 | 10 790 |
| min terrain elevation (m) | -10 930 (bathymetry; sea surface at 0) | -9 130 |
| surface g (m/s^2) | 9.820 | 1.625 |
| navball surface/orbit auto-switch altitude | 60 km | 20 km |

---

## 3. Orbit mechanics

### 3.1 Universal-variable Kepler propagation (`orbit/kepler.ts`)

An `Orbit` is `{ bodyId, mu, r0, v0, t0 }` plus cached derived elements. Rails propagation **always** evaluates from the epoch state (never incrementally), so warp introduces zero drift.

```
propagate(orbit, t):  dt = t - t0
  r0m = |r0|, vr0 = dot(r0, v0)/r0m, alpha = 2/r0m - |v0|^2/mu        // 1/a ; >0 ellipse, <0 hyperbola
  // initial guess
  elliptic  (alpha > 1e-12):  dtm = dt mod period (period = 2pi/sqrt(mu) * alpha^-1.5);  chi = sqrt(mu) * dtm * alpha
  hyperbolic(alpha < -1e-12): a = 1/alpha;
       chi = sign(dt) * sqrt(-a) * ln( (-2 mu alpha dt) / (dot(r0,v0) + sign(dt) sqrt(-mu a) (1 - r0m alpha)) )
  parabolic: chi = sqrt(mu) * dt / r0m      // then iterate
  // Laguerre-Conway iteration (n = 5), converges from any start, typ. 3-5 iterations
  repeat up to 50:
     psi = chi^2 alpha;  (c2, c3) = stumpff(psi)
     r   = chi^2 c2 + (dot(r0,v0)/sqrt(mu)) chi (1 - psi c3) + r0m (1 - psi c2)
     F   = (dot(r0,v0)/sqrt(mu)) chi^2 c2 + (1 - alpha r0m) chi^3 c3 + r0m chi - sqrt(mu) dt
     dF  = r
     ddF = (dot(r0,v0)/sqrt(mu)) (1 - psi c2) + (1 - alpha r0m) chi (1 - psi c3)
     delta = 5 F / (dF + sign(dF) sqrt(|16 dF^2 - 20 F ddF|))
     chi -= delta;  stop when |delta| < 1e-10 * max(1, |chi|)
  f = 1 - chi^2 c2 / r0m;         g = dt - chi^3 c3 / sqrt(mu)
  r = f r0 + g v0
  fdot = sqrt(mu) chi (psi c3 - 1) / (|r| r0m);   gdot = 1 - chi^2 c2 / |r|
  v = fdot r0 + gdot v0
```

If the Laguerre iteration has not converged in 50 iterations (never observed, but guard it), fall back to bisection on `F(chi)` (monotonic in chi since `dF = r > 0`).

Stumpff functions: for `|psi| < 1e-3` use the series `c2 = 1/2 - psi/24 + psi^2/720 - psi^3/40320`, `c3 = 1/6 - psi/120 + psi^2/5040 - psi^3/362880`; else `psi > 0`: `c2 = (1 - cos sqrt(psi))/psi`, `c3 = (sqrt(psi) - sin sqrt(psi))/psi^1.5`; `psi < 0`: `c2 = (1 - cosh sqrt(-psi))/psi`, `c3 = (sinh sqrt(-psi) - sqrt(-psi))/(-psi)^1.5`.

Required unit tests: f*gdot - fdot*g = 1 to 1e-12; energy and angular momentum conserved to 1e-10 relative across e in {0, 0.01, 0.5, 0.97, 1.0 +/- 1e-9, 1.3, 5}; round trip `propagate(propagate(o, t), -t)`; agreement with RK4 at 1e-6 relative over one period; 1e6 periods ahead (100 000x warp for days) still exact because of the `mod period`.

### 3.2 Elements (`orbit/elements.ts`)

From (r, v, mu): `h = r x v`, `evec = (v x h)/mu - r/|r|`, `e = |evec|`, `a = 1/alpha` (negative for hyperbola), `p = |h|^2/mu`, `rp = p/(1+e)`, `ra = e<1 ? p/(1-e) : inf`, `i = acos(h.z/|h|)`, node vector `nvec = z x h`, `Omega`, `omega`, true anomaly `nu = atan2(dot(r, h_hat x e_hat), dot(r, e_hat))` (when e < 1e-8 use `nvec` or +X as reference direction), perifocal basis `P = e_hat`, `Q = h_hat x e_hat`.

Time from true anomaly (needed for analytic events): elliptic `E = 2 atan2(sqrt(1-e) sin(nu/2), sqrt(1+e) cos(nu/2))`, `M = E - e sin E`; hyperbolic `H = 2 atanh(sqrt((e-1)/(e+1)) tan(nu/2))`, `M = e sinh H - H`; `t = tp + M/n` with `n = sqrt(mu/|a|^3)`.

Radius crossing (analytic): `cos nu = (p/R - 1)/e`; two solutions +/-nu; valid iff `rp <= R <= ra`. Used for SOI exit, atmosphere entry/exit, "below max terrain shell" entry.

### 3.3 Events on a conic (`orbit/soi.ts`, `world/events.ts`)

For a patch starting at `tS` around body B, the predictor asks for the earliest of:

1. **Atmosphere entry**: B has an atmosphere and `rp < R_B + h_atm` -> analytic inbound crossing of `R_B + h_atm`.
2. **Surface/terrain impact**: `rp < R_B + maxElev_B` -> analytic time `tShell` of inbound crossing of the max-elevation shell, then march along the orbit from `tShell` with ground-track step <= 2 km (`dt = 2000 / v`), converting to BCBF at each sample time and comparing `|r|` to `R_B + terrainHeight(lat, lon)` (ocean counts as height 0 for Earth). First sign change bisected to 0.01 s. Uses the coarse always-in-memory height pyramid (section 9.1) so it never blocks on streaming.
3. **SOI exit**: B is not root and (`e >= 1` or `ra > R_soi`) -> analytic outbound crossing of `R_soi`.
4. **SOI entry into a child C of B** (numeric):
   * Quick reject: `rp_vessel > ra_C + Rsoi_C` or `ra_vessel < rp_C - Rsoi_C`.
   * Search window `[tS, tEnd]`, `tEnd = min(other events, tS + (e<1 ? period : time to SOI exit), tS + horizon)`; horizon = 60 days.
   * `d(t) = |r_v(t) - r_C(t)| - Rsoi_C`. Sample with step `h = clamp(Rsoi_C / (4 * (v_v,max + v_C,max)), 30 s, window/64)` (for the Moon: ~66 100 km / (4 * ~3.5 km/s) ~ 4 700 s, so ~500 samples for a 27-day window; ~2 us each).
   * On a sign change (+ to -): Brent to 1e-3 s -> entry time.
   * On a sampled local minimum with d > 0 (grazing risk): golden-section minimise on the bracket; if the minimum is < 0, bisect the left half for the root.
5. **Maneuver node** at `t_node` within the patch.
6. **Elliptic, nothing else**: patch ends after one period (closed orbit, drawn as a full ellipse).

On an SOI transition at time `tx`:
* enter child C: `r' = r - r_C(tx)`, `v' = v - v_C(tx)`, `bodyId = C`.
* exit to parent P: `r' = r + r_B(tx)`, `v' = v + v_B(tx)`, `bodyId = P`.
State is continuous in the root frame by construction; hysteresis: after a transition, ignore the same boundary for the first 1 s of the new patch.

### 3.4 Patch list / trajectory prediction (`orbit/patches.ts`)

```ts
interface Patch {
  bodyId: string; orbit: Orbit; tStart: number; tEnd: number;
  endReason: 'closed'|'soiExit'|'soiEnter'|'atmosphere'|'impact'|'maneuver'|'horizon';
  nextBodyId?: string; afterNodeId?: string;      // set on patches downstream of a node (drawn dashed/orange)
  markers: Marker[];                              // Ap, Pe, AN/DN vs target, impact, atmosphere entry, encounter in/out
}
predict(state0, t0, nodes: ManeuverNode[], opts: {maxPatches = 8}): Patch[]
```

Algorithm: start with (state0, t0). Loop: build the orbit, find the earliest event (3.3), close the patch, transform the state (SOI change) or add the node's dv (below), continue until `closed`, `impact`, `atmosphere` with predicted capture, `horizon`, or `maxPatches`. For `atmosphere` the patch list ends with an "atmospheric entry" marker carrying entry speed, flight-path angle and vacuum periapsis (the HUD shows these; no drag prediction is drawn - the UI says so, like stock KSP).

Two lists are maintained: `current` (no nodes) and `planned` (with nodes); the map view draws both (planned only from the first node onward).

Refresh policy: on rails recompute only on events (SOI change, node edit, warp end); when integrating (thrust/atmosphere), recompute at 10 Hz from the instantaneous state (osculating orbit). Cost budget < 1 ms per recompute.

Map-view sampling for drawing: each patch is sampled uniformly in **eccentric/hyperbolic anomaly** (not time): 256 points for a closed ellipse, 128 for an arc, positions relative to the patch's body. Patches around a moving body are drawn relative to that body's **current** position (KSP "local" mode); the encounter patch additionally carries `bodyPosAtEntry` so the UI can offer "relative to position at intercept".

### 3.5 Maneuver nodes (`orbit/maneuver.ts`)

```ts
interface ManeuverNode { id: string; ut: number; dv: { prograde: number; normal: number; radial: number } }  // m/s
```

Node frame, evaluated on the pre-node patch at `ut`: `p = v/|v|`, `n = (r x v)/|r x v|`, `ro = p x n` (radial-out; for a circular orbit this points away from the body). `dv_inertial = dv.prograde p + dv.normal n + dv.radial ro`. The predictor applies it impulsively.

Editing API (UI and pilot use the same calls): `addNode(ut)`, `setNode(id, {ut?, dv?})`, `removeNode(id)`. UI handles: 6 drag handles (pro/retro, normal/anti, radial out/in) with drag-rate scaling (1 m/s per 10 px, x0.1 with Shift, x10 with Ctrl), a time slider/drag along the orbit, +/- one-orbit buttons, and numeric fields.

Burn execution bookkeeping (information only, no autopilot):
* `dvRemaining` (vector, inertial): initialised to `dv_inertial` when `ut_now >= node.ut - burnTime/2 - 60 s` or when the player first throttles up within 5 minutes of the node; thereafter `dvRemaining -= a_thrust * dt` every physics step. Navball maneuver marker = `dvRemaining` direction; HUD shows `|dvRemaining|`. Node auto-completes (removed) when `|dvRemaining| < 0.1 m/s` or when the remaining dot original direction < 0 and throttle = 0.
* Burn-time estimate with the currently active engines (or the next stage's engines if none are active): `m1 = m0 exp(-dv/(Isp g0))`, `t_burn = (m0 - m1)/mdot_max`. If available dv in the stage < dv: show "insufficient dv" and the stage dv. HUD shows "start burn in T-" = `node.ut - t_burn/2 - ut_now`.

### 3.6 Closest approach and markers (`orbit/closestApproach.ts`)

For a selected target body T sharing the patch's central body: sample `D(t) = |r_patch(t) - r_T(t)|` at 256 points over the patch (max one period), refine each local minimum by golden section to 1 s; report the first two minima as `{t, distance, relSpeed, rVessel, rTarget}` (drawn as paired markers). If a minimum is below `Rsoi_T` the SOI-entry search already produced an encounter and the markers become "encounter in/out" plus the next patch's `Pe` altitude at T.

Relative inclination and AN/DN versus the target's orbit plane: `cos i_rel = dot(h_hat, hT_hat)`; node line `hT x h`; AN/DN true anomalies -> markers with the angle label. Same function is used on the pad for the launch-window readout (section 16.2).

---

## 4. Rails versus integration

### 4.1 Per-vessel state machine

```
translationMode: 'landed' | 'rails' | 'integrated'
attitudeMode:    'dynamic' | 'frozen'
```

* `landed`: state stored in BCBF (`lat, lon, r_bcbf, q_bcbf`); the vessel rides the rotating body. Entered by the sleep rule (section 9.5) or the launch clamps. Left when any engine/RCS produces force, a stage event fires, or a contact wake-up occurs. Time warp up to 100 000x allowed.
* `rails`: translation from `propagate(orbit, ut)`.
* `integrated`: RK4 at 120 Hz with all forces.

`mustIntegrate(v)` is true if any of:
1. any engine or SRM thrust > 0, or RCS **translation** command active (rotation-only RCS is modelled as pure couples and does not force integration);
2. inside an atmosphere: `alt < body.atmosphere.simTop` (Earth 140 km);
3. terrain proximity: `alt < body.maxElev + 1000 m` **and** radar altitude < 2 500 m;
4. any contact point touching, parachute deployed, or buoyancy active;
5. within 1.0 s after a staging event (separation impulses);
6. another non-landed vessel within 200 m (separation dynamics, future docking).

Transition to rails: when `mustIntegrate` has been false for 0.5 s, build `Orbit{r, v, t0 = ut}` from the integrated state. Transition to integrated: take `propagate(orbit, ut)`. Both directions are exact (same gravity model), so the player never sees a jump.

Attitude is `dynamic` whenever warp <= 4x. At rails warp > 4x it is `frozen` in the inertial frame; if SAS is in a direction-hold mode and the pointing error was < 2 deg when warp started, the attitude tracks the hold direction kinematically instead (so a prograde-holding ship is still prograde after the coast). Angular velocity is zeroed on entering frozen mode only if `|w| < 0.5 deg/s`; otherwise warp > 4x is refused with the message "Cannot warp while rotating" (KSP behaviour).

### 4.2 Integrator (`dynamics/integrator.ts`)

State per integrated vessel: `r, v, q, w, partTemps[], resources[]`. One fixed step:

```
1. controls -> actuator commands (SAS + player), engine spool, gimbal servo, RCS allocation   (section 7)
2. mass properties (mass, CoM, inertia) from parts + resource amounts                          (section 6)
3. RK4 on (r, v) with a(r, v) = -mu r/|r|^3 + (F_thrust + F_aero(r, v) + F_chute(r, v))/m
      thrust and attitude are held constant across the sub-stages; aero is re-evaluated (depends on v and altitude)
4. attitude: torque tau (VES) = gimbal + RCS + wheels + aero + contact;
      w += I^-1 (tau - w x (I w)) dt       (semi-implicit: evaluate w x Iw with the mid-point w, 2 fixed-point iterations)
      q = normalize(q * quatFromRotVec(w dt))
5. contact / buoyancy sub-steps (only if any probe is within 5 m of terrain/water): 4 sub-steps of dt/4,
      semi-implicit Euler on (v, w) then (r, q) with penalty forces                             (section 9)
6. resources: consume propellant, clamp at zero -> flame-out events
7. thermal step, g-force accumulation, failure checks                                         (sections 8, 10)
```

Precision: |r| <= 4.5e8 m in float64 gives 6e-8 m resolution; no physics origin shifting needed. (Rendering uses camera-relative float32, which is the renderer's concern: `SimSnapshot` exposes float64 positions and the renderer subtracts the camera position in float64 before narrowing.)

### 4.3 Stepping the world (`world/sim.ts`)

```ts
sim.advance(realDt: number): void     // browser: realDt = clamped frame time (max 0.1 s)
  if any vessel in the active bubble mustIntegrate or warp <= 4:
       steps = accumulate(realDt * warpFactor) / DT   (cap 16 steps/frame at 1x, 64 at 4x; drop surplus = slow-motion, never bigger DT)
       for each step: sim.step()        // exactly DT of sim time
  else (rails warp):
       target = ut + realDt * warpFactor, clamped to nextEventTime (section 5)
       advanceRails(target)             // sets ut, re-propagates all rails vessels, processes SOI events exactly at their times
sim.step(): void                      // one DT; the ONLY thing the headless harness calls besides advanceRails
```

Headless fast-forward uses the identical functions: `while (!done) { pilot.update(snapshot); integratedNeeded ? sim.step() : sim.advanceRails(min(nextEventTime, ut + warpFactor * (1/60))) }`. The pilot's warp choice maps to the same warp table, so the same event sequence occurs; only wall-clock pacing is removed. (The `1/60` rails quantum mirrors the browser frame so the pilot's reaction timing is equivalent.)

---

## 5. Time warp

Levels: physics warp `1, 2, 3, 4`; rails warp `5, 10, 50, 100, 1 000, 10 000, 100 000`. Keys `.`/`,` step up/down, `/` cancels to 1x.

Rules:
1. Rails levels are only selectable when no vessel in the active bubble `mustIntegrate` and the active vessel is not rotating (4.1). Otherwise the request clamps to 4x and the HUD shows why.
2. Altitude caps (per body, data-driven `warpAltitudeLimits`), same idea as KSP - keeps the visuals sane and gives reaction time:

| Max warp | Earth: altitude above | Moon: altitude above |
|---|---|---|
| 5x | 140 km (atmosphere top) | 0 (clear of terrain rule 4.1.3) |
| 10x | 140 km | 5 km |
| 50x | 160 km | 10 km |
| 100x | 250 km | 25 km |
| 1 000x | 600 km | 60 km |
| 10 000x | 6 000 km | 500 km |
| 100 000x | 30 000 km | 3 000 km |

3. **Event look-ahead** (the important rule): compute `tEvent` = earliest of {SOI change, atmosphere entry, terrain-proximity/impact, `node.ut - burnTime/2 - 30 s`, scenario alarms}. The allowed warp is the largest level `w` with `(tEvent - ut)/w >= 4 s` of real time. As the event approaches, warp steps down through the levels automatically and reaches 1x about 4 s (real) before the event. The rails advance is additionally clamped so `ut` never passes `tEvent`.
4. SOI transitions do not stop warp by themselves (they are processed exactly at `tx`), but the look-ahead drops warp to <= 50x across them so the player sees the change; the previous level is not restored automatically.
5. Throttle > 0, staging, RCS translation, or any pitch/yaw/roll input while in rails warp -> warp drops to 1x that frame, then the action applies.
6. Physics warp (2-4x) is allowed in every situation, including burns and atmosphere, by running more 1/120 s steps per frame.

Altitude-limit crossings are also folded into `tEvent` analytically (radius crossing of the limit shell), so a ship falling from the Moon at 100 000x steps down smoothly instead of overshooting.

---

## 6. Vessel model, mass properties, resources

### 6.1 Structure

A vessel is a tree of **parts** (stack along +Y with radial attachments). Each part instance: `{ defId, position (VES), rotation, parentIndex, attachNode, resources: {id -> amount kg}, temp: {skin, core}, state per module }`. Staging and decoupling split the tree into multiple vessels (connected components after removing the decoupler joint); each component gets its own rigid-body state with velocity `v + w x (r_com,new - r_com,old)` and the separation impulse.

### 6.2 Mass properties (`vessel/massProps.ts`)

Per part: dry mass + resource masses; CoM = part CoM offset (resources shift it along the tank axis as they drain: liquid assumed settled at the engine end, `y_res = y_bottom + fill * height / 2`). Inertia of each part about its own CoM from its `inertiaShape`:

* `solidCylinder(r, h)`: `I_axial = m r^2 / 2`, `I_trans = m (3 r^2 + h^2)/12`
* `shellCylinder(r, h)`: `I_axial = m r^2`, `I_trans = m (6 r^2 + h^2)/12`
* `cone(r, h)`: `I_axial = 3 m r^2/10`, `I_trans = m (3 r^2/20 + 3 h^2/80)` (about its CoM, h/4 from base)
* `sphere(r)`: `2 m r^2/5`; `box(x, y, z)`: standard.

Vessel inertia tensor = sum of rotated part tensors + parallel-axis terms about the vessel CoM. Recomputed every physics step (<= 40 parts, trivial). Thrust, aero, contact forces are applied at their points; torque = sum (r_i - r_com) x F_i.

### 6.3 Resources

`resources.json`: `{ id, density kg/m^3, displayName }` for `LOX`, `CH4`, `LH2`, `RCSProp` (gaseous methane/oxygen thrusters fed from small dedicated tanks, modelled as one resource; no hypergolics on this vehicle), `SolidProp`, `Ablator`. Engines declare `propellants: [{resource, ratio (mass fraction)}]`. Flow rule: an engine draws from tanks in **its own stage group** (parts between the same decoupler boundaries) - no cross-feed. RCS thrusters draw `RCSProp` from tanks in the same stage group.

---

## 7. Propulsion, actuators, attitude control

### 7.1 Engines

```
mdot      = throttleActual * mdotMax,   mdotMax = thrustVac / (ispVac g0)
isp(p)    = ispVac - (ispVac - ispSL) * (p_amb / 101325)          // linear in ambient pressure (== F = mdot ve - p_amb Ae)
thrust    = max(0, mdot g0 isp(p))
```

* Throttle command `thr in [0, 1]` is shared by all **active** engines (KSP). Engine effective throttle = `thr <= 0 ? 0 : minThrottle + (1 - minThrottle) * thr` for throttleable engines; fixed-thrust engines (LES, separation motors) ignore it.
* Spool: first-order lag `throttleActual += (target - throttleActual) * dt / tau`, `tau_up`/`tau_down` per engine (booster 1.2 s / 0.4 s; vacuum engines 0.8 s / 0.3 s; lander 0.25 s / 0.15 s). Ignition event when `throttleActual` first exceeds 0.02 after being 0; shutdown event below 0.01 (drives audio/plume).
* Restart: every liquid engine is restartable (ignition count tracked and exposed; `maxIgnitions` in data: M-1/M-2 engines 3, M-3 and lander engines `null` = unlimited). An engine with ignitions exhausted will not relight (HUD warning).
* Flame-out when its stage group runs out of any propellant.
* Vacuum-optimised engines have a low `ispSL` (flow separation) rather than a hard cutoff.
* Exposed to renderer/audio per engine: `throttleActual`, `thrust`, `p_amb`, `pe_ratio = p_exit / p_amb` (`p_exit` in data), gimbal angles, `ignitionAge`.

### 7.2 Gimbal

Each gimballed engine: `gimbalRange` (deg), `gimbalRate` (deg/s, 20). Commands from the allocator are pitch/yaw deflections plus, for multi-engine stages with off-axis engines, differential deflection for roll. Thrust vector = nozzle axis rotated by the two servo angles; torque comes out of the generic `r x F` sum.

### 7.3 RCS

Thrusters defined individually: `{ position, direction (thrust force direction, VES), thrust, isp }`. Standard block = quad with 4 nozzles. Allocation for a commanded torque `tauCmd` (VES, normalised per axis in [-1, 1]) and translation command `fCmd`:

```
for each thruster i:  a_i = r_i x d_i (torque per unit force, about current CoM),  b_i = d_i
   level_i = clamp( dot(a_i_hat_axisScaled, tauCmd) + dot(b_i, fCmd), 0, 1 )   // only thrusters that help fire
   suppress if level_i < 0.05 (deadband) -> avoids chatter and propellant waste
```

(`a_i_hat_axisScaled` = a_i divided component-wise by the max achievable torque on each axis, computed once per staging change.) Net force from rotation commands is kept (it is small) only when the vessel is integrated; when on rails, rotation-only firing applies torque but its residual force is ignored - documented simplification, stated in the UI tooltip "RCS rotation does not perturb orbits".
Translation keys: `I/K` (fwd/back along +Y/-Y), `J/L` (left/right), `H/N` (up/down). RCS toggle `R`.

### 7.4 Reaction wheels / CMGs

Module `reactionWheel { torque: [x, y, z] N m }`: applies commanded torque directly, no propellant, no saturation (momentum management abstracted). Used on the ascent/service stage (1 500 N m per axis) and capsule (300 N m per axis) for fine pointing.

### 7.5 Authority and allocation (`control/actuatorAllocation.ts`)

Each step compute per-axis available torque `tauMax[axis]` = gimbal (thrust * lever arm * sin(range), only while thrust > 5 % nominal) + wheels + RCS (if enabled). Commands `u in [-1, 1]^3` map to: gimbal deflection `= u * range` (pitch/yaw; roll via differential or not available), wheels `= u * torque`, RCS `= u` but only for the part of the command the gimbal + wheels cannot deliver (`u_rcs = |u| > 0.6 or tauGimbal+tauWheel < 0.2 tauNeeded ? u : 0`), which keeps RCS quiet during main-engine burns.

### 7.6 SAS (`control/sas.ts`) - attitude hold only

Modes: `off`, `stability`, `prograde`, `retrograde`, `normal`, `antinormal`, `radialOut`, `radialIn`, plus `maneuver` (point at `dvRemaining`; it is an attitude hold like the others - the player still controls throttle and timing). Velocity reference follows the navball mode (surface / orbit).

Target:
* `stability`: target quaternion `qT` captured on engage and re-captured on an axis when the player releases input on that axis (after the body rate on that axis falls below 0.5 deg/s, or 1 s, whichever first).
* direction modes: target direction `dT` (inertial). Error rotation vector in VES: `theta = axisAngle(nose -> dT)` = `normalize(yhat x d) * acos(clamp(dot(yhat, d)))` with `d = q^-1 dT`; roll axis component: rate damping only (`theta_y = 0`).
* `stability`: `theta = 2 * vec(qErr)` sign-corrected, `qErr = q^-1 * qT`.

Control law per body axis i (gain-scheduled by current authority, so one law works from the 2 750 t stack to the 5 t capsule):

```
alphaMax_i = tauMax_i / I_ii
wLim       = min(maxRate (deg/s, per vessel command part; default 10), sqrt(2 * 0.6 * alphaMax_i * pi))
wDes_i     = clamp( theta_i / tauS,  -+ min(wLim, sqrt(2 * 0.6 * alphaMax_i * |theta_i|)) )      tauS = 1.5 s
u_i        = clamp( (wDes_i - w_i) / (alphaMax_i * tauR), -1, 1 )                                 tauR = 0.3 s
if |theta_i| < 0.05 deg and |w_i| < 0.01 deg/s: u_i = 0   (deadband, lets RCS go quiet)
```

Player input on an axis replaces `u_i` on that axis while non-zero (`u_i = input_i`), exactly like KSP. Fine-control toggle (CapsLock) scales player input by 0.3.

SAS availability: requires a command part with `sas: true` and electrical power abstracted as always available. Mode switches are instantaneous commands (`setSasMode`), available to the pilot script as a player control.

Why this is not an autopilot: SAS never touches throttle, staging, or node planning; it only holds one of the navball markers.

---

## 8. Atmosphere and aerodynamics

### 8.1 Atmosphere model (`bodies/atmosphere.ts`)

`atmosphere.model = "ussa76"` (Earth) implemented exactly:

Below 86 km geometric: geopotential altitude `H = r0 h / (r0 + h)`, `r0 = 6 356 766 m`; layers (base H m, base T K, lapse K/m, base p Pa):

| H base | T base | Lapse | p base |
|---|---|---|---|
| 0 | 288.15 | -0.0065 | 101 325 |
| 11 000 | 216.65 | 0 | 22 632.06 |
| 20 000 | 216.65 | +0.0010 | 5 474.889 |
| 32 000 | 228.65 | +0.0028 | 868.0187 |
| 47 000 | 270.65 | 0 | 110.9063 |
| 51 000 | 270.65 | -0.0028 | 66.938 87 |
| 71 000 | 214.65 | -0.0020 | 3.956 420 |
| 84 852 | 186.946 | 0 | 0.373 383 6 |

`T = Tb + L (H - Hb)`; `p = pb (Tb/T)^(g0 M/(R L))` or `pb exp(-g0 M (H - Hb)/(R Tb))` for L = 0; `rho = p M/(R T)`; `M = 0.028 964 4`, `R = 8.314 462`, `g0 = 9.806 65`; speed of sound `a = sqrt(1.4 * 287.053 * T)`.

86 km and above: log-linear interpolation of rho and p, linear T, from the USSA-76 table:

| h km | rho kg/m^3 | p Pa | T K |
|---|---|---|---|
| 86 | 6.958e-6 | 3.734e-1 | 186.87 |
| 90 | 3.416e-6 | 1.836e-1 | 186.87 |
| 100 | 5.604e-7 | 3.201e-2 | 195.08 |
| 110 | 9.708e-8 | 7.104e-3 | 240.00 |
| 120 | 2.222e-8 | 2.538e-3 | 360.00 |
| 130 | 8.152e-9 | 1.251e-3 | 469.27 |
| 140 | 3.831e-9 | 7.203e-4 | 559.63 |
| 150 | 2.076e-9 | 4.542e-4 | 634.39 |
| 160 | 1.233e-9 | 3.040e-4 | 696.29 |
| 180 | 5.194e-10 | 1.527e-4 | 790.07 |
| 200 | 2.541e-10 | 8.474e-5 | 854.56 |

Density is multiplied by a smooth fade `1 - smoothstep(130 km, 140 km, h)` so drag is exactly zero at the rails boundary (`simTop = 140 km`); residual drag there would be < 1e-4 m/s^2 anyway. Above 86 km use `a = 275 m/s` for Mach (free-molecular regime; Mach only selects the Cd plateau there). Other bodies can use `model: "table"` (arbitrary h/rho/p/T rows) or `"exponential"` (rho0, scale height) - all three are implemented and unit-tested.

The atmosphere co-rotates with the body: air-relative velocity `vAir = v - omega x r`. No winds.

### 8.2 Aerodynamic forces (`dynamics/aero.ts`)

Each part contributes **aero elements**; exposure depends on configuration (a part with a stack neighbour covering its end face contributes no axial drag from that face; parts inside a closed fairing contribute nothing). Element kinds:

1. `axisymBody { refArea A, length L, diameter D, cdAxialFwd(M), cdAxialAft(M), cdCross = 1.1 }`
   In the element frame with unit air-velocity `u` (direction the air comes **from** is `-u`), axial component `ua = dot(u, axis)`, lateral vector `ul = u - ua axis`:
   ```
   F_axial = -q * A * Cd_ax(M, sign(ua)) * ua |ua| * axis
   F_cross = -q * (L * D) * cdCross * |ul| * ul
   ```
   applied at the element's centre of pressure (`cpFraction` along the axis, default 0.5 L for cross-flow, at the exposed face for axial). Stack-level stability (fins are not needed: gimbal authority handles it) and lift at angle of attack emerge from the cross-flow term.
2. `bluntCapsule { refArea, cdTable(M), cn = 0.10, cmAlpha = 0.16, cmq = 0.4 }` - used for the crew capsule when flying free:
   ```
   alpha  = angle between the heat-shield outward normal (-Y) and the direction of travel through the air
   CA(M, alpha) = cd(M) * cos^2(alpha)  (heat shield forward, alpha < 90 deg);  apex-forward: CA = 0.6 cd(M) cos^2(alpha)
   CN(alpha)    = cn * sin(2 alpha)                       (small normal force)
   F = q A (-CA * axis_flowward - CN * lateral_hat)       (axis_flowward = body axis pointing into the flow, lateral_hat = lateral flow direction)
   moment about the geometric reference point (on the axis at the heat-shield max diameter):
       M_static = -q A D * Cm_alpha * sin(alpha),  Cm_alpha = 0.16      (restoring toward shield-first)
       M_damp   = -q A D^2 / (2 V) * Cmq * w_perp,   Cmq = 0.4
   ```
   The capsule CoM is offset `0.165 m` towards -Z (data: `comOffset`), so the trim angle of attack is ~ 17 deg and, because the force on a blunt body is nearly axial, **L/D = tan(alpha_trim) ~ 0.30** The lift direction is fixed in the body (towards +Z, opposite the CoM offset), so the player **rolls** the capsule to point it up or down; the navball shows a lift-vector marker and the HUD a "LIFT UP / LIFT DOWN" label. A unit test asserts trim alpha in [15, 20] deg and L/D in [0.26, 0.34] at Mach 10 - tune `comOffset` if the test fails.
3. `parachute` - see 10.4.
4. `flatPlate {area, normal}` - fairing halves, legs, debris panels: `F = -q * A * 1.28 * |dot(u, n)| * dot(u, n) * n`.

Mach tables (linear interpolation, clamp ends):

| Mach | 0 | 0.6 | 0.9 | 1.1 | 1.3 | 2 | 3 | 5 | 10+ |
|---|---|---|---|---|---|---|---|---|---|
| Launch stack / stage nose-first (ref = max cross-section, ogive/tower nose) | 0.30 | 0.30 | 0.42 | 0.55 | 0.52 | 0.40 | 0.32 | 0.27 | 0.25 |
| Blunt stage end / tumbling cylinder end-on | 0.85 | 0.85 | 1.00 | 1.25 | 1.35 | 1.45 | 1.50 | 1.55 | 1.60 |
| Capsule, shield-first (ref = pi D^2/4) | 0.90 | 0.92 | 1.05 | 1.25 | 1.40 | 1.45 | 1.38 | 1.32 | 1.30 |

Dynamic pressure `q = 0.5 rho |vAir|^2`. Structural limit: each vessel configuration has `maxQAlpha` (Pa rad); the launch stack fails (breaks at the weakest joint - section 10.3) if `q * alpha > 60 000 Pa rad` (e.g. 6 deg at 33 kPa - a careless hard pitch at max-Q destroys the rocket, a gentle gravity turn does not). **(verified)** max-Q on a nominal ascent is 28-31 kPa at ~12 km.

---

## 9. Terrain, contact, landing, water

### 9.1 Terrain interface (`world/terrainProvider.ts`)

```ts
interface TerrainProvider {
  // Authoritative collision height above datum radius, metres. Deterministic. Must include the same
  // procedural detail the renderer displaces with (shared function / baked tiles).
  heightAt(bodyId: string, lat: number, lon: number, maxLevel?: number): number;
  normalAt(bodyId: string, lat: number, lon: number, baseline: number): Vec3;   // finite difference over `baseline` m
  surfaceKind(bodyId: string, lat: number, lon: number): 'land' | 'water';        // Earth: DEM <= 0 and ocean mask
  ensureLoaded(bodyId: string, lat: number, lon: number, radius: number): Promise<void>;  // pre-fetch high-res around a point
  isLoaded(bodyId, lat, lon, level): boolean;
}
```

* A coarse global pyramid level (about 2 km/px on Earth, 500 m/px on the Moon) is loaded synchronously at start and is always available (impact prediction, far debris).
* The sim calls `ensureLoaded` for a 5 km radius around the active vessel whenever radar altitude < 50 km and descending, and **pauses the sim clock** (not a loading screen: rendering continues, HUD shows nothing unless it lasts > 0.5 s) only if a vessel is below 300 m radar altitude and the finest collision tile is still missing. With local tiles this is not expected to trigger.
* Collision height = bicubic sample of the finest available DEM tile + procedural amplification `detail(lat, lon)` implemented once in TS (float64) and used to **bake the finest geometry tiles** on the CPU for the renderer, so what the legs touch is exactly what is drawn (requirement: |render - collision| < 3 cm at the contact point). The renderer team must consume `heightAt` (or baked patches from it) for the innermost LOD ring; this is the one hard coupling between sim and renderer.
* Headless tests use the same provider reading tiles from disk via `fs` (same decoding code path).
* Site flattening: launch sites (and any `terrainModifiers` in a body file) define a graded disc: inside `flatRadius` the height is `padElevation`; between `flatRadius` and `blendRadius` smoothstep to natural terrain. Applied inside `heightAt`, so render and physics agree.

Radar altitude = `|r| - (R + heightAt(lat, lon))` using the vessel's lowest contact probe; over water the surface is `max(height, 0)`.

### 9.2 Contact probes

Each part definition lists `contactPoints: [{ pos, radius, k, c, mu, crashTolerance }]` (auto-generated defaults at load: 8 points on each end ring + centre points for cylinders; explicit ones for foot pads, engine bells, capsule heat-shield rim (12) and apex). Penalty model per probe, in the BCBF frame (terrain moves with the body):

```
depth  = (R + heightAt(lat, lon)) - |r_probe| + probe.radius       (> 0 = penetrating)
n      = terrain normal (baseline 1 m)
vRel   = v_probe - omega_body x r_probe
Fn     = max(0, k * depth - c * dot(vRel, n))
vt     = vRel - dot(vRel, n) n
Ft     = -min(mu * Fn, ct * |vt|) * vt/|vt|      ct = mu * Fn / 0.05 m/s  (stick regularisation)
```

Defaults: structural probes `k = 4e6 N/m` scaled by `m_vessel / 20 t`, damping ratio 0.6, `mu = 0.8` (regolith/soil 0.7, concrete pad 0.9, steel on steel 0.6); integrated at 480 Hz.

**Landing legs** (`legs` module): each leg is a telescoping strut with a foot-pad probe: stroke 0.6 m, `k = 180 kN/m`, `c = 45 kN s/m`, preload 2 kN, bottoming-out stiffness 4e6 N/m; friction at the pad `mu = 0.9`. Deploy/retract toggle (`G`), 4 s deployment animation driven by sim state; legs retracted = pads are not probes and the engine bell will hit first. Leg compression exposed for rendering/audio.

**Impact damage**: at first contact of a probe (depth crosses 0), compare the normal closing speed to `crashTolerance`:

| Probe | crashTolerance (m/s) |
|---|---|
| lander foot pad (legs deployed) | 4.0 normal, 2.5 lateral before leg collapse |
| lander structure / engine bell | 2.0 |
| capsule heat-shield on land | 9.0 |
| capsule heat-shield on water | 12.0 (lateral 20) |
| capsule side wall / apex | 4.0 |
| launch-stack structure, tanks | 3.0 |
| debris parts | 6.0 (then they break up) |

Exceeding it destroys that part (`PartDestroyed` event -> explosion FX if it holds propellant, debris otherwise). Destroying a command part with crew = mission failure. A collapsed leg removes its probe so the lander settles on the remaining geometry and usually tips.

### 9.3 Tip-over and landed state

Tip-over is not scripted; it results from rigid-body dynamics (pads on a 4.6 m radius circle, CoM ~ 3.9 m above the pads at touchdown; with 4 legs the tipping axis is `4.6 * cos(45 deg) = 3.25 m` from the centre, so the static limit is `atan(3.25/3.9) = 40 deg`; with 1 m/s of lateral speed at touchdown the practical limit is ~ 25 deg). Landing "success" criteria for the HUD/test: all legs intact, tilt from local vertical < 15 deg, at rest.

Sleep rule: if all contacts are active, `|vRel_com| < 0.05 m/s` and `|w| < 0.2 deg/s` for 2 s and no thrust -> `landed` (state frozen in BCBF). Wake on thrust > 0, staging, or external impulse.

Launch clamps: the `launchClamp` module holds the vessel in `landed` regardless of thrust until its stage fires (hold-down release); S1 ignition and clamp release are separate entries in the first stage group with a 3.0 s scripted delay inside one key press (engines spool to 100 %, then release) - see section 11.

### 9.4 Water and buoyancy (`dynamics/buoyancy.ts`)

Earth `ocean: { density: 1025, seaLevel: 0, waves: {...} }`. Water surface height `eta(lat, lon, t)` = sum of the 4 longest Gerstner components of the renderer's ocean spectrum (parameters shared in `data/bodies/earth.json` -> `ocean.waves`, amplitude total <= 1.2 m for the default sea state), so the capsule bobs on the same swell that is drawn.

Per-part buoyancy volumes `buoyancy: [{ pos, radius }]` (spheres; capsule: 7 spheres totalling 9.5 m^3 -> floats with ~55 % reserve; empty tanks float, engines sink):

```
submerged volume of sphere of radius a at depth d below surface of its centre: h = clamp(d + a, 0, 2a); V = pi h^2 (3a - h)/3
F_buoy = rho_w * g * V * up
F_drag = -0.5 rho_w * Cd_w (0.8) * (pi a^2 * V/Vfull) * |vRel| vRel       (also gives slam deceleration)
torque from each sphere about CoM (gives self-righting: capsule CoM is below the centre of buoyancy)
```

Splashdown crash check uses the water `crashTolerance` values (9.2) at first water entry. `splashedDown` state = floating, |v| < 1 m/s for 3 s -> parachutes auto-cut, mission-complete check.

---

## 10. Heating, g-loads, parachutes, failures

### 10.1 Aerothermal model (`dynamics/thermal.ts`)

Stagnation-point reference flux for a vessel moving at air-relative speed V (m/s) in density rho, for a nose radius Rn (m):

```
q_conv = 1.7415e-4 * sqrt(rho / Rn) * V^3                                    [W/m^2]  (Sutton-Graves, Earth air)
q_rad  = kRad * 4.736e4 * Rn^a * rho^1.22 * f(V) * 1e4                       [W/m^2]  (Tauber-Sutton, V > 9 000 m/s else 0)
         a = min(1, 1.072e6 * V^-1.88 * rho^-0.325);  kRad = 0.5 (large-Rn / radiative-cooling correction)
f(V): 9000:1.5  9250:4.3  9500:9.7  9750:19.5  10000:35  10250:55  10500:81  10750:115  11000:151  11500:238  12000:359
      12500:495  13000:660  14000:1065  15000:1550  16000:2040   (linear interpolation)
```

Per body the constants come from data (`atmosphere.heating: { kConv: 1.7415e-4, radiative: {...} | null }`), so Mars/Venus can be added.

**(verified)** for the 5 t capsule (Rn = 4.8 m) on lunar return at 10.97 km/s with a 45 km vacuum perigee: peak q_conv ~ 1.4-1.5 MW/m^2, peak q_rad ~ 1.3-1.5 MW/m^2 (with kRad 0.5), total heat load ~ 250 MJ/m^2 with `kRad = 1` (less with 0.5) over ~ 4 minutes of significant heating.

Per-part exposure: each part has thermal surfaces `{ areaM2, normal | 'axisym', noseRadius, emissivity, arealHeatCapacity J/(m^2 K), maxTemp K }`.

```
exposure e = max(0, dot(n, -u))^1  for flat/normal surfaces;  axisym bodies: e = 0.15 + 0.85 * max(0, dot(axis_fwd, -u))
shielding: a part whose centre lies inside the 30-degree half-angle wake cone behind an upstream part of equal or
           larger radius gets e *= 0.03 (stack shadowing; the capsule behind its heat shield, the lander behind a stage...)
q_in  = e * (q_conv(Rn_part) + q_rad(Rn_part))           // each part uses its own nose radius (small radius = hotter)
q_out = emissivity * sigma * (T^4 - T_env^4),  T_env = 4 K space-facing, blended to atmospheric T below 80 km
dT/dt = (q_in - q_out + q_sun (ignored: constant 0)) / arealHeatCapacity
```

Explicit Euler at 120 Hz is stable for the heat capacities used (>= 4 kJ/m^2 K). When `T > maxTemp`: part destroyed (`PartOverheated`). Typical data: aluminium-lithium tank skin 6 kJ/m^2K, maxTemp 800 K; stainless/Inconel engine section 12 kJ/m^2K, 1 300 K; fairing with cork TPS 9 kJ/m^2K, 1 100 K; LES boost cover 9 kJ/m^2K, 1 100 K; capsule back-shell tiles 14 kJ/m^2K, 1 900 K; lander (MLI, thin skin) 4 kJ/m^2K, 700 K.

Consequences that fall out: ascent heating (peak ~ 40-60 kW/m^2 around 60 km, Mach 7-8) is survivable for the fairing but would cook the lander if the fairing were jettisoned below ~ 80 km at speed; spent stages re-entering break up; entering with the ascent stage still attached, or apex-first, destroys the ship.

**Ablative heat shield** (`heatShield` module): `ablatorMass = 200 kg` over 12.57 m^2 (15.9 kg/m^2), `qThreshold = 0.15 MW/m^2`, effective heat of ablation `Heff = 28 MJ/kg`:

```
if q_in > qThreshold and ablator > 0:  dm/dt = area * e * (q_in - qThreshold) / Heff;  surface held at T_abl = min(radiative equilibrium, 3 100 K)
   heat conducted to the capsule structure = 2 % of q_in
if ablator == 0: the shield's substrate takes q_in directly (arealHeatCapacity 20 kJ/m^2K, maxTemp 1 400 K) -> burn-through in ~ 15-25 s at peak
```

**(verified)** ablator consumption: 6-7.5 kg/m^2 (38-47 % of the budget) for vacuum perigees between 10 and 65 km; a skip-out followed by a second entry uses ~ 13 kg/m^2 total (82 %): survivable once. Caveat: the heat-load and ablation figures were computed with `kRad = 1.0` (un-derated radiative term), so with the specified `kRad = 0.5` consumption will be roughly a quarter to a third lower; re-run the corridor sweep test and, if nominal use falls below ~ 30 %, lower `ablatorMass` (not `Heff`) so the gauge stays meaningful. HUD shows ablator %, shield temperature and a heat bar per overheating part (KSP style).

Plasma/ionisation FX input for the renderer: `plasmaIntensity = smoothstep(0.05, 1.0 MW/m^2, q_conv + q_rad)` and `machConeAngle`, per vessel; audio uses `q` (dynamic pressure) and `plasmaIntensity`. Comms blackout is not simulated.

### 10.2 G-forces (`dynamics/gforce.ts`)

`gLoad = |F_nonGravitational| / (m g0)` (thrust + aero + contact + chute), low-pass filtered with tau = 0.1 s for display. 

* Crew: `gDose += max(0, gLoad - 10) * dt`; decays at 0.5 /s when `gLoad < 6`. `gDose > 15 g s` -> crew lost (mission failure "G-LOC / fatal deceleration"). Vision-dimming post-effect input `= smoothstep(6, 10, gLoad_filtered)` (cockpit view).
* Structure: each joint (decoupler or part attach) has `maxAccelG`: launch stack 6 g axial / 2 g lateral, lander stack 8 g, capsule 20 g. Exceeding it for > 0.2 s breaks the joint (vessel splits; usually fatal during ascent because of what follows aerodynamically).

**(verified)** nominal profile: ascent peak 3.85 g at S1 burnout (S1/S2 do not need throttling for g), TLI 1.4 g, lunar landing < 1 g, entry 5.4-8.3 g with the simple bank rule (16.2 phase 12) for perigees 30-65 km; ballistic (no lift management) 10 g at 50 km perigee, 14.5 g at 40 km (fatal dose), 1.6 g then skip-out at 70 km.

### 10.3 Structural failure propagation

When a part is destroyed: remove it; its children become separate vessels (debris or still-controllable if they contain a command part); tanks with > 5 % propellant produce an explosion impulse (2 kN s per tonne of remaining propellant, radial) on neighbours and heat (explosion FX event). The mission-failure state is declared when no command part with crew survives; the sim keeps running (the player watches the wreck; UI offers "revert to launch" - a scenario restart, not a physics cheat).

### 10.4 Parachutes (`modules/parachute.ts`)

States: `stowed -> (drogue) reefed -> full -> cut`, `failed`.

| | Drogues (2) | Mains (3) |
|---|---|---|
| Cd*A each, full | 20 m^2 | 420 m^2 |
| Reefing | 40 % for 4 s, then full over 1.5 s | 8 % for 6 s, 30 % for 6 s, then full over 3 s |
| Safe deployment envelope | alt < 12 000 m ASL, Mach < 0.85, q < 9 kPa | alt < 4 500 m, V < 95 m/s, q < 2.8 kPa |
| Destroyed if deployed/riding at | q > 14 kPa or Mach > 1.2 | q > 4.5 kPa or V > 130 m/s |
| Minimum useful altitude | - | fully open needs ~ 15 s (~ 700 m at 45 m/s) |

Force: `F = -0.5 rho |vAir| vAir * CdA(t)`, applied at the apex attach point (so the capsule hangs heat-shield down; mains have a 2-point harness giving a 27.5 deg hang angle - purely visual plus a small torque). Deploying outside the "safe" envelope but inside the "destroyed" limit is allowed and works (with a high opening shock, which the g model captures); beyond the destroyed limit the chute rips away (`ParachuteFailed` event, state `failed`). Staging the mains cuts the drogues. Stage "arming" is not automatic: the player presses space; the HUD shows a chute icon coloured red/amber/green from the envelope (KSP style).

**(verified by terminal-velocity arithmetic)**: capsule alone, terminal speed ~ 101 m/s at 7 km, 111 m/s at 8 km (Mach 0.36); under 2 drogues ~ 44 m/s at 3 km; under 3 mains 7.9 m/s at sea level, 9.7 m/s with one main failed (still within the 12 m/s water limit); no mains (drogues only) ~ 37 m/s -> fatal.

---

## 11. Staging model

`stages: StageGroup[]` in the vehicle file, fired in order by Space (`activateNextStage()`); each group is a list of actions executed with optional delays:

```ts
type StageAction =
  | { kind: 'igniteEngines'; parts: string[] }            // activates; thrust follows the shared throttle
  | { kind: 'releaseClamps'; parts: string[]; delay?: number }
  | { kind: 'decouple'; part: string; impulse: number }   // N s, applied equal/opposite along the joint axis
  | { kind: 'fireSeparationMotors'; parts: string[] }     // short solid retro/ullage motors (fixed burn)
  | { kind: 'jettisonFairing'; part: string }             // splits into N panels with lateral impulse + hinge spin
  | { kind: 'jettisonLES'; part: string }                 // fires the tower jettison motor, decouples tower + boost cover
  | { kind: 'shutdownEngines'; parts: string[] }
  | { kind: 'deployParachute'; parts: string[]; mode: 'drogue' | 'main' }
  | { kind: 'deployLegs'; parts: string[] }
```

The staging stack UI shows each group with its icons and the dv of the stage it activates (Tsiolkovsky with current masses, vacuum and current-pressure values). A 0.5 s lockout between presses prevents double-staging. Separated lower parts keep whatever state they had (an engine still at 3 % tail-off keeps thrusting until spooled down) and become debris vessels (section 14).

Action groups besides the stack: `G` legs, `Backspace` abort (below), `R` RCS, `T` SAS, `U` lights (cosmetic state exported).

**Abort (LES)**: available while the tower is attached: shuts down all engines, fires the LES motor (solid, 800 kN for 3.5 s, canted nozzles), decouples the capsule + tower from the stack, after burnout the tower jettisons automatically (scripted 1.5 s after LES burnout, part of the abort sequence the same way real LES sequencers work), then the normal drogue/main stages remain for the player to fire. After tower jettison, `Backspace` does a plain "shutdown + separate capsule" (useful only for a manual bail-out in the atmosphere).

---

## 12. Mission architecture: direct ascent, no rendezvous

**Decision: no rendezvous or docking is required.** The crew capsule rides on top of a two-stage lander all the way to the lunar surface and back (the 1961 "direct ascent" / Soviet LK-700 profile, which is also how most players fly a first KSP Mun mission).

Justification:
1. The acceptance test is a complete hand-flown mission by a script using only player controls; lunar-orbit rendezvous adds target-relative navigation, phasing, a docking-port alignment UI and a second controllable vessel left unattended in orbit. Each is a large feature whose failure blocks "done", and none is requested by the brief ("crew capsule and a lunar lander", "stage separation", "land on the Moon, return").
2. Playability in one session: direct ascent needs only burns the player already knows from the map view (TLI node, LOI at periapsis, deorbit, landing, ascent, TEI node).
3. Physical plausibility is preserved by paying the real price: ~ 57 t through TLI, hence a Saturn V / SLS Block 2 class launcher (2 756 t at lift-off). No magic Isp, no shrunken world.
4. No transposition-and-docking is needed either: the launch stack is already in flight configuration (capsule on top of the ascent stage on top of the descent stage, legs folded inside the adapter fairing).
5. Extensibility is not lost: decouplers, multiple vessels, vessel switching (`[`/`]`) and debris-on-rails are all there because staging already needs multi-vessel simulation; a future LOR mission is a data + UI addition (target selection, relative navball mode), not an engine rewrite.

Mission profile (nominal durations, real time at 1x in brackets when hand-flown):

| # | Phase | Vehicle element | Key numbers |
|---|---|---|---|
| 1 | Pad, launch window wait | full stack | launch when pad crosses the Moon's orbital plane (twice per sidereal day); azimuth ~ 81 or 99 deg |
| 2 | Ascent S1 (161 s) | S1 | max-Q ~ 30 kPa at ~ 75 s, burnout at ~ 65-75 km, 2.1-2.2 km/s (surface-relative) |
| 3 | Ascent S2 (to 419 s burn) | S2 | fairing + LES jettison above 95 km; SECO in 185 x 185-260 km orbit with 9-21 t residual |
| 4 | Parking orbit coast | S3 + lander | period 88 min; plane check vs Moon (< 0.5 deg expected) |
| 5 | TLI (~ 330 s burn) | S3 | 3 140-3 180 m/s; node planned in map view for a lunar periapsis of ~ 100 km |
| 6 | M-3 separation, coast 3-4.5 d (depends on TLI energy) | lander stack | M-3 becomes debris (it flies by or impacts the Moon); 1 small correction |
| 7 | LOI at perilune (~ 190 s) | descent stage | ~ 830-900 m/s retrograde -> ~ 100 km circular |
| 8 | Deorbit + powered descent + landing | descent stage | DOI 20 m/s to 15 km perilune; braking from 1 693 m/s; total ~ 2 050-2 250 m/s |
| 9 | Surface stay | - | time warp allowed (landed state) |
| 10 | Lunar ascent (direct to ~ 20 x 100 km then circularise) | ascent stage | ~ 1 850-1 950 m/s |
| 11 | TEI | ascent stage | ~ 850-1 000 m/s -> Earth vacuum perigee 45 km |
| 12 | Trans-Earth coast 3-4.5 d, perigee trim | ascent stage | corrections < 20 m/s; target perigee 45 +/- 15 km |
| 13 | Ascent-stage separation, entry at 10.97 km/s | capsule | entry interface 122 km, flight-path angle ~ -6.9 deg at 140 km |
| 14 | Drogues ~ 7 km, mains ~ 3 km, splashdown | capsule | touchdown ~ 8 m/s |

---

## 13. The vehicle: "Meridian" launch vehicle, "Kestrel" capsule, "Heron" lander (all fictional)

Propellants: methane/oxygen first stage (full-flow staged combustion), hydrogen/oxygen upper stages (expander/gas-generator cycle), methane/oxygen pressure-fed-with-electric-pump lander engines. All plausible mid-2020s to 2030s technology.

### 13.1 Stage table (final, verified numbers)

| Element | Dry mass kg | Propellant kg | Engines | Thrust (total) | Isp SL / vac (s) | Burn time (full throttle) | Diameter x length |
|---|---|---|---|---|---|---|---|
| **M-1 first stage** | 150 000 | 1 760 000 (LOX/CH4, O/F 3.6) | 9 x "Atlas-9M" (8 ring + 1 centre; all gimbal +/- 6 deg) | 35.10 MN SL / 37.57 MN vac | 327 / 350 | 161 s | 9.0 m x 42 m |
| **M-2 second stage** | 48 000 | 634 000 (LOX/LH2, O/F 6.0) | 6 x "Vela-2" (gimbal +/- 5 deg) | 6.60 MN vac | 300 / 445 | 419 s | 9.0 m x 32 m |
| **M-3 third stage (TLI)** | 11 800 | 85 000 (LOX/LH2) | 1 x "Vela-2V" (gimbal +/- 5 deg, restartable) + 2 aft RCS pods (8 x 600 N) | 1.00 MN vac | 290 / 452 | 377 s | 6.6 m x 11 m (9 -> 6.6 m conical interstage below) |
| Lander adapter fairing (4 petals) | 6 000 | - | - | - | - | jettisoned with LES | 6.6 m x 9.5 m |
| Payload adapter ring (stays on M-3) | 500 | - | - | - | - | - | - |
| **Heron descent stage** | 3 500 (incl. 4 legs, 420 kg) | 36 000 (LOX/CH4) | 1 x "Lyra-D" (throttle 10-100 %, gimbal +/- 6 deg) + 4 RCS quads (16 x 440 N) | 200 kN vac | - / 360 | 635 s | 6.0 m across tanks x 3.4 m; pad circle radius 4.6 m deployed |
| **Heron ascent / service stage** | 1 500 | 10 800 (LOX/CH4) + 250 RCSProp (counted in dry) | 1 x "Lyra-A" (throttle 20-100 %, gimbal +/- 4 deg) + 4 RCS quads (16 x 220 N) + CMGs 1.5 kN m | 60 kN vac | - / 355 | 627 s | 4.0 m x 3.6 m |
| **Kestrel crew capsule** | 5 000 total: structure 3 300, ablator 200, crew + suits 300 (3), parachutes 350, RCSProp 150, misc 700 | - | 12 x 220 N RCS (Isp 290), wheels 300 N m | - | - | - | 4.0 m base x 3.3 m, 32.5 deg sidewall, shield radius of curvature 4.8 m |
| Launch escape system + boost cover | 4 000 | (2 300 solid, included) | 1 x LES motor | 800 kN for 3.5 s | 250 | - | 0.9 m x 7.5 m tower |

Engine detail for plume/audio data: Atlas-9M: 3.90 MN SL / 4.174 MN vac each, chamber 30 MPa, exit pressure 70 kPa, exit diameter 1.9 m, min throttle 50 %. Vela-2: 1.10 MN vac, exit pressure 12 kPa (vacuum nozzle, 2.6 m exit), min throttle 60 %. Vela-2V: 1.00 MN, exit pressure 6 kPa, 2.9 m exit, min throttle 60 %. Lyra-D: exit pressure 8 kPa, 1.7 m exit. Lyra-A: exit pressure 10 kPa, 0.9 m exit.

Stack masses (kg): capsule 5 000; ascent stack 17 300; lander stack (TLI payload) 56 800; M-3 stack 154 100; at M-2 ignition 846 100 (incl. LES 4 000 + fairing 6 000); **lift-off 2 756 100**. Overall height ~ 106 m.

Thrust-to-weight: lift-off 1.30; M-2 ignition 0.80; M-3 0.66 (Earth g); descent stage after LOI 2.78 lunar (4.5 m/s^2), at touchdown hover throttle 19 %; ascent stage lift-off 2.13 lunar.

### 13.2 Delta-v budget

| Stage | Ideal dv available (m/s) | Used for | Required (hand-flown, incl. losses) | Margin |
|---|---|---|---|---|
| M-1 | 3 264 (SL Isp) - 3 493 (vac Isp); ~ 3 400 effective | boost | \ | |
| M-2 | 6 197 (after fairing/LES jettison) | to 185 km LEO | } ~ 9 250-9 450 total to orbit (gravity ~ 1 500, drag ~ 30-40, steering) | **(verified)** orbit reached on M-2 with 9-21 t left = 190-430 m/s; M-3 untouched |
| M-3 | 3 555 | TLI 3 140-3 180 (+ plane trim <= 50) | 3 230 | 325+ (plus M-2 residual) |
| Heron descent | 3 547 | mid-course 30, LOI 830-900, DOI 20, powered descent + landing 2 050-2 250 | 3 200 worst case | 350 (10 %) = ~ 2 600 kg at touchdown = ~ 70 s of hover |
| Heron ascent | 3 408 | ascent to LLO 1 850-1 950, TEI 850-1 000, corrections 20 | 2 970 worst case | 440 (13 %) |
| Capsule RCS | ~ 85 (150 kg at Isp 290) | attitude + bank reversals in entry | attitude only | - |

Abort options that fall out of the margins (not required for the nominal test, but real): M-3 can finish orbit insertion if M-2 underperforms (costs TLI margin); the ascent stage can abort the landing to orbit at any time (stage 7 fired in flight = "abort stage").

### 13.3 Stage stack (Space bar sequence)

| Press | Stage group | Actions |
|---|---|---|
| 1 | Launch | ignite 9 x Atlas-9M (throttle must be > 0; pilot sets 100 %); `releaseClamps` after 3.0 s if total thrust > 1.1 x weight, else engines shut down (pad abort) |
| 2 | M-1 separation | shutdown M-1, decouple (impulse 150 kN s), 8 M-1 retro solids (0.7 s), 4 M-2 ullage solids (4 s), ignite 6 x Vela-2 after 1.5 s |
| 3 | Tower + fairing jettison | LES tower jettison motor + boost cover; 4 fairing petals hinge out and release |
| 4 | M-2 separation | shutdown M-2, decouple (60 kN s), ignite Vela-2V after 2.0 s (ullage from M-3 RCS pods) |
| 5 | M-3 separation (after TLI) | shutdown, decouple lander stack (8 kN s, spring) ; M-3 RCS does a 3 s retro-evasion burn; activate Lyra-D (ignited, thrust follows throttle) |
| 6 | Landing gear | deploy legs (also on `G`) |
| 7 | Lunar lift-off | shutdown Lyra-D, decouple ascent stage from descent stage (explosive bolts), ignite Lyra-A (fire-in-the-hole; also the landing-abort stage) |
| 8 | Capsule separation | shutdown Lyra-A, decouple capsule from ascent stage (6 kN s), enable capsule RCS |
| 9 | Drogues | jettison apex cover, deploy 2 drogues |
| 10 | Mains | cut drogues, deploy 3 mains via pilot chutes |

Throttle is under player control at every ignition (ignition = "activate"; thrust = shared throttle), so "the player flies every burn by hand".

### 13.4 Cockpit-relevant data exported by the sim

Altitude (ASL + radar), speeds (surface, orbital, vertical, horizontal), Ap/Pe + times, inclination, throttle, per-stage propellant, dv per stage, g meter, heat-shield %, dynamic pressure, Mach, attitude (pitch/heading/roll), angular rates, mission elapsed time, UT, SAS mode, RCS state, gear state, chute state/envelope light, warp, lift-vector direction, node burn info. The cockpit MFDs and the HUD render from the same `Readouts` struct.

---

## 14. Debris and multiple vessels (`world/debris.ts`)

Every separated component is a normal `Vessel` (same class, `controllable = false` if it has no command part). Fidelity tiers by distance from the **active** vessel (the "bubble" centre):

| Tier | Condition | Simulation |
|---|---|---|
| Full | within 25 km | identical 6-DoF physics, contacts, heating, FX (this is what makes staging look right: stages tumble, vent, fall away, fairing petals flutter) |
| Reduced | beyond 25 km and `mustIntegrate` (in atmosphere / suborbital) | 3-DoF point mass: RK4 at 2 Hz sim time with tumbling-average `CdA`, Sutton-Graves heating on one lumped node; break-up -> removed with a `DebrisBurnedUp` event; ground/sea impact -> removed with `DebrisImpact {lat, lon}` (so M-1 really comes down ~ 600-700 km down-range in the sea) |
| Rails | beyond 25 km and coasting in vacuum | Kepler patched conics like any vessel, including SOI changes (M-3 after TLI flies past or hits the Moon; lunar impact detected by the terrain-impact event -> removed) |

Limits: at most 24 debris vessels; when exceeded, remove the oldest non-Full one. Fragments smaller than 50 kg (bolts, covers) live 60 s then fade (renderer notified). Debris in rails tier costs one Kepler solve per frame only if visible in the map view, else only at event times.

Vessel switching: `[`/`]` cycles controllable vessels within 25 km. In this mission only the main ship is ever controllable (spent stages and the descent stage left on the Moon have no command part), so the keys have nothing to cycle to; the capability exists because the multi-vessel world requires an "active vessel" concept anyway.

---

## 15. Launch site (fictional) and scenario

### 15.1 Site suggestion: "Ka Lae Pacific Spaceport, Launch Complex 1" (fictional facility at a real place)

* Location: south-east coast of the Island of Hawai'i (Ka'u district), nominal **19.10 deg N, 155.50 deg W**, on the gently sloping coastal lava plain ~ 1 km inland. (A commercial spaceport was seriously studied for this coast in the 1980s-90s and never built - fictional but plausible.)
* Why: open Pacific down-range for every azimuth from 60 to 130 deg (no overflight); latitude 19.1 deg is below the Moon's 20.9 deg orbital inclination in our ephemeris, so the pad crosses the lunar orbit plane twice a day and can launch **directly into the Moon's plane** (azimuth 81 deg ascending or 99 deg descending) - TLI then works from any parking-orbit revolution with no plane change, which is what keeps the hand-flown mission simple; spectacular real terrain in view at lift-off (Mauna Loa 4 169 m, 40 km away; sea cliffs; black lava against deep ocean); excellent public elevation (USGS 10 m / 1 m lidar) and imagery coverage; Earth-rotation bonus 439 m/s.
* Data-prep rule (so the pad cannot end up in the sea or on a cliff): the site JSON stores the nominal lat/lon; `tools/resolve-site.ts` snaps it to the nearest DEM cell that is >= 600 m from the shoreline with slope < 4 deg over a 1 km disc, writes back `lat, lon, padElevation`, and the site's terrain modifier grades a 450 m radius pad apron (blend to 900 m). The engine never hard-codes this site.
* Recovery: splashdown anywhere in ocean counts; nominal return aims at the Pacific.

Alternates with the same properties if art direction prefers: Duqm-like Arabian-Sea coast (19.6 deg N, 57.7 deg E) or a Yucatan/Quintana Roo Caribbean coast site (19.8 deg N, 87.5 deg W). Any site with |lat| < 20.9 deg and an eastern ocean works with the same mission logic; higher latitudes work too (launch due east when the pad's inclination plane contains the Moon's arrival point - `launchWindow.ts` handles both cases).

### 15.2 Launch window maths (`nav/launchWindow.ts`) - information for the HUD, not automation

Target plane normal `nT` = Moon orbit normal (ECI). Pad inertial position `rP(t)`.
* Coplanar window (|lat| <= i_target): times when `dot(rP(t), nT) = 0` (root-find on the sidereal-day periodic function; two per day). Required inertial launch direction `dL = normalize(nT x rP_hat)`, choosing the sign with an eastward component. Inertial azimuth `azI = atan2(dot(dL, e), dot(dL, n))`. Surface-relative azimuth corrected for Earth rotation: `tan(azR) = (v_orb sin azI - v_rot) / (v_orb cos azI)` with `v_orb = 7 797 m/s`, `v_rot = 465.1 cos(lat)`. The window is shifted earlier by a configurable `ascentLeadTime` (default 0 s; the plane error from Earth rotating during ascent is absorbed by flying the azimuth; residual relative inclination < 0.5 deg costs < 70 m/s to trim, usually left untrimmed).
* Non-coplanar (|lat| > i_target): launch due east at the time when the resulting orbit plane contains the Moon's position at `t + tTransfer` (`tTransfer` = 4 d default); solved by root-finding on `dot(nOrbit(t), rMoon_hat(t + tTransfer))`.
* HUD on the pad: "Target plane crossing in T-hh:mm:ss, launch azimuth 081 deg". Map view shows relative inclination and AN/DN once in orbit.

### 15.3 Scenario file

`data/scenarios/lunar-direct.json`: `{ vehicle: "meridian-lunar", site: "ka-lae-lc1", startUt, target: "moon", suggestedLanding: {lat: 0.8, lon: 23.5, name: "Mare Tranquillitatis"} }`.

`startUt` is produced offline by `tools/find-start-time.ts` (deterministic search over 2026-2030) with constraints: (a) a coplanar ascending-azimuth window occurs 10 minutes after `startUt`; (b) Sun elevation at the pad between 10 and 35 deg (morning light, long shadows); (c) between start + 3 d and start + 5 d the Sun elevation at the suggested landing site stays within 5-35 deg and is rising (Apollo-style lighting, lit for the whole stay); (d) Moon above the pad horizon is not required. The chosen value is written into the scenario file with the computed Sun/Moon angles as comments in an adjacent `README`.

The suggested landing site is flat mare within 6.7 deg of the lunar equator, reachable from the near-equatorial lunar orbit that a coplanar transfer produces; the player may land anywhere.

---

## 16. Scripted test pilot and acceptance test

### 16.1 Interface: only player controls

```ts
interface ControlInputs {           // what the keyboard/gamepad layer produces each frame
  pitch: number; yaw: number; roll: number;           // -1..1
  translate: Vec3;                                    // -1..1 RCS translation
  throttle: number;                                   // 0..1 (the player's throttle lever position)
}
interface PlayerCommands {          // discrete actions, all available from keys/UI
  stage(): void; abort(): void;
  setSasEnabled(on: boolean): void; setSasMode(mode: SasMode): void;
  setRcsEnabled(on: boolean): void; toggleLegs(): void;
  setNavballMode(m: 'surface' | 'orbit'): void;
  setWarpLevel(index: number): void;                  // same table/limits as the keys; may be refused
  addNode(ut: number): string; setNode(id, patch): void; removeNode(id): void;   // map-view node editing
  setTarget(bodyId: string | null): void;
}
interface Pilot { update(snap: SimSnapshot, dt: number): ControlInputs }   // called at 30 Hz sim time (every 4th step)
```

The pilot may **read** anything the UI displays (`SimSnapshot.readouts`, predicted patches and markers, navball vectors). It may not write sim state. Enforcement: `Sim` exposes mutation only through `ControlInputs`/`PlayerCommands`; the test asserts `sim.cheatCounter === 0` (incremented by any debug/teleport API, which lives in a separate `sim.debug` namespace excluded from mission tests) and records an input log `{ut, inputs, commands}` that can be replayed in the browser for the Playwright run and screenshots.

In the browser the same pilot runs behind `?pilot=1` (inputs injected at the same layer as the keyboard). Playwright can alternatively press real keys for short segments (e.g. staging via `page.keyboard.press('Space')`) to prove the key bindings.

### 16.2 Guidance per phase (pilot = a competent KSP player, written as a state machine)

All pointing is done by setting the SAS mode or by feeding pitch/yaw/roll with a PD on the navball error to a desired direction ("fly the navball"), exactly what a human does with the keys. Helper: `pointAt(dir)` -> `ControlInputs` using a PD on the angle between nose and `dir` in VES (kp 2.0 /rad, kd 1.5 s, clamped), with SAS in `stability` to damp.

| # | Phase | Logic | Exit / checks |
|---|---|---|---|
| 0 | Pre-launch | set target Moon; read launch-window readout; warp (pad is `landed`) until T-20 s; SAS stability; throttle 100 % | at T-3 s: `stage()` (ignition; clamps release at T0) |
| 1 | Vertical rise | hold vertical; after tower clear (h > 150 m) roll so ventral (-Z) faces the launch azimuth | radar alt > 800 m |
| 2 | Pitch programme (M-1) | target pitch above horizon `theta(h) = max(22 deg, 90 - 68 * ((h - 800)/65 000)^0.6)`, heading = launch azimuth (surface navball). Limit commanded attitude so angle of attack < 4 deg while q > 15 kPa (blend toward surface-prograde). **(verified)**: exponents 0.6, end altitudes 50-80 km and floor 15-25 deg all reach orbit, so the scheme is tolerant of sloppy hand flying | M-1 propellant < 0.5 % or thrust drop -> `stage()` (M-2) |
| 3 | M-2 closed-loop pitch | navball orbit mode. Desired vertical speed `vrDes = clamp((185 km - h)/120 s, -50, 900)`; needed vertical accel `aV = (vrDes - vr)/20 s + (mu/r^2 - vh^2/r)`; pitch = `asin(clamp(aV / (T/m), -0.35, 0.75))`; heading: along orbit-prograde projected on the horizon, biased by `-3 * relInc(deg)` degrees toward the target plane (cap +/- 8 deg). `stage()` for tower + fairing when h > 95 km. | cut throttle when periapsis > 180 km (throttle to 0; engine stays "active") |
| 4 | LEO check | if Pe < 160 km or Ap > 400 km: plan a node at Ap/Pe and burn it (same routine as phase 6). If M-2 ran dry before orbit: `stage()` and finish with M-3. Then `stage()` to drop M-2 if still attached and M-3 is needed next (M-2 residual is abandoned). | orbit 160-400 km, ecc < 0.02, rel. inclination to Moon plane < 1.5 deg (else a normal-burn node at AN/DN) |
| 5 | TLI planning (map) | create node on the next orbit; initial guess: prograde 3 150 m/s, time = when the phase angle vessel-Earth-Moon is 114 deg ahead (Moon leads). Optimise 2 variables (node time, prograde dv) by coordinate search on the predictor output (exactly what a player does by dragging): minimise |perilune altitude - 100 km| subject to an encounter existing (either sense of lunar orbit is accepted). Steps: time +/- 60 s, 10 s, 1 s; dv +/- 10, 1, 0.1 m/s. | node with predicted perilune 80-150 km; requires dv <= M-3 dv |
| 6 | Generic node burn | SAS `maneuver`; warp to `node.ut - tBurn/2 - 30 s` (auto-drop handles it); wait for pointing error < 1 deg; at `node.ut - tBurn/2` throttle 100 %; when `|dvRemaining| < 25 m/s` reduce throttle proportionally (min 5 % / engine min) ; cut at `|dvRemaining| < 0.3 m/s` or when it starts increasing; trim with RCS translation if > 0.5 m/s remains | node completed |
| 7 | Post-TLI | `stage()` (drop M-3, activates Lyra-D); 10 minutes later plan a correction node (prograde/radial/normal, coordinate search, <= 40 m/s) to bring perilune to 100 +/- 10 km and lunar-orbit inclination to the lunar equator < 8 deg; burn; warp to SOI entry; re-check and trim once inside the SOI | in Moon SOI, perilune 90-110 km |
| 8 | LOI | node at perilune: retrograde dv = `v_peri - sqrt(mu/r_peri)`; burn (phase 6 routine, SAS maneuver) | lunar orbit 85-125 km, ecc < 0.03 |
| 9 | Deorbit | node retrograde ~ 20 m/s placed 180 deg of true anomaly before the target longitude (suggested site) so perilune = 15 km lies ~ 12 deg (360 km) up-range of the site; burn; warp to perilune - 60 s; deploy legs | at perilune, 15 +/- 3 km |
| 10 | Powered descent | (a) Braking: SAS `retrograde` (orbit mode until h-speed < 300 m/s, then surface mode); ignite at perilune, throttle 100 %; (b) pitch-over/approach when surface speed < 150 m/s: SAS surface-retrograde, throttle from a "suicide-burn" rule: `aReq = v^2 / (2 * max(hRadar - 30 m, 1)) + gMoon`; throttle = `aReq / (Tmax/m)` when aReq exceeds 60 % of available, else 0-10 % (coast), i.e. hover-slam with margin; (c) Terminal: below 100 m radar switch SAS to `stability`, hold the nose up-ish by flying the navball: desired tilt = `clamp(-0.08 * vHoriz, 12 deg)` to null horizontal speed; vertical-speed target `vDes = -max(1.0, min(hRadar/8, 20))` m/s; throttle = `(g + (vDes - vz) * 0.8) * m / Tmax`; cut throttle at leg contact (leg compression > 0 on 2+ legs). | landed state within 30 s; touchdown: vertical < 2.5 m/s, horizontal < 1.0 m/s, tilt < 12 deg; all legs intact; descent-stage propellant > 0 |
| 11 | Surface | wait 10 minutes of sim time via warp (also proves landed-state warp); then warp until the ascent/TEI geometry is acceptable (any time works; TEI is planned from orbit) | - |
| 12a | Lunar ascent | throttle 100 %, `stage()` (Lyra-A, leaves the descent stage); vertical until 150 m; then the phase-3 closed loop with heading 90 deg (east), target altitude 20 km and `vrDes = clamp((20 km - h)/60 s, -20, 150)`; cut throttle when apoapsis >= 100 km (periapsis is then ~ 15-20 km); coast to apoapsis and circularise with a node there (phase 6 routine) | lunar orbit ~ 100 km circular, Pe > 60 km |
| 12b | TEI | plan node: prograde ~ 850-1 000 m/s on the lunar far side (the point where vessel velocity is anti-parallel to the Moon's orbital velocity => exit SOI retrograde w.r.t. the Moon). Coordinate search on (node time, prograde dv) minimising |Earth vacuum perigee - 45 km| on the predicted Earth patch after SOI exit; burn | predicted Earth perigee 20-70 km |
| 13 | Trans-Earth coast | after SOI exit, correction node (<= 20 m/s, mostly radial/prograde at high altitude where it is cheap) for perigee 45 +/- 5 km; warp; re-trim at 150 000 km and at 50 000 km with RCS/low throttle if outside 45 +/- 10 km | at 5 000 km altitude: predicted perigee 35-55 km |
| 14 | Entry prep | at 2 500 km altitude: `stage()` (capsule separation), SAS `retrograde` (surface) so the heat shield leads; RCS on; roll to lift-up | attitude error < 5 deg at 140 km |
| 15 | Entry | SAS stays surface-retrograde for pitch/yaw (aero trim does most of the work); pilot commands **roll only**: lift-vector **down** (roll 180 deg) if `(vr > 0 and v > 7 600 m/s)` or `(vr > -150 m/s and v > 7 900 m/s)`; otherwise lift **up**. (This prevents skip-out and limits g.) **(verified)**: lands for perigees 10-65 km; peak 5.4-8.3 g for 30-65 km. | Mach < 0.8 |
| 16 | Chutes | `stage()` (drogues) at h < 7 500 m and chute light green; `stage()` (mains) at h < 3 200 m and V < 90 m/s | vertical speed < 9.5 m/s by 300 m |
| 17 | Splashdown | hands off | `splashedDown` on water |

The coordinate-search "planner" uses only `setNode` and reads the resulting predicted patches - the automated equivalent of dragging node handles while watching the Pe marker. Cap: 400 predictor evaluations per plan.

### 16.3 Pass/fail criteria (`tests/mission/full-mission.test.ts`, vitest, headless; and the Playwright replay)

The run fails immediately on: crew lost, command part destroyed, `cheatCounter > 0`, any NaN in state, a phase exceeding its timeout, or the sim leaving determinism (hash of the final state must equal the stored golden hash on re-run).

Milestones that must all be recorded, in order, with their numeric gates:

1. `LIFTOFF` from the site pad (landed -> integrated with clamps released; surface velocity at release < 0.1 m/s; inertial speed = Earth rotation 439 +/- 2 m/s).
2. `MAX_Q` between 20 and 40 kPa; no structural failure.
3. `STAGE_SEP_1`, `FAIRING_JETTISON` (h > 80 km), `STAGE_SEP_2` events, each producing debris vessels.
4. `EARTH_ORBIT`: Pe >= 160 km, Ap <= 400 km, after one full rails revolution the state matches Kepler to 1 m.
5. `TLI_COMPLETE`: predicted patch list contains a Moon encounter.
6. `MOON_SOI_ENTER` occurs at the predicted time +/- 2 s.
7. `LUNAR_ORBIT`: ecc < 0.05, Pe > 60 km.
8. `LUNAR_TOUCHDOWN`: on real terrain (terrain provider at full local resolution loaded), gates of phase 10; vessel remains landed (no slide/tip) for 600 s.
9. `LUNAR_LIFTOFF`; descent stage remains as a landed debris vessel.
10. `MOON_SOI_EXIT`; `EARTH_PERIGEE_TARGETED` 30-60 km.
11. `ENTRY_INTERFACE` at 122 km with speed 10.9-11.1 km/s; peak g < 10; `gDose < 5`; ablator remaining > 25 %; capsule max structure temperature below limit.
12. `DROGUE_DEPLOY`, `MAIN_DEPLOY` inside envelopes; no chute failure.
13. `SPLASHDOWN`: on water, vertical speed <= 9.5 m/s, crew alive, capsule floating upright after 30 s.
14. Budget assertions: total mission sim time < 14 days; each stage's propellant never negative; remaining dv margins logged.

Runtime target for the headless run: < 90 s wall-clock (about 3 500 s of integrated flight = 420 000 steps at ~ 100 us/step, plus planning).

Supporting unit/integration tests (each fast): Kepler suite (3.1); SOI entry/exit times vs brute-force RK4 three-body-free patched reference; Moon ephemeris period and distance range; Earth rotation (pad inertial speed); USSA-76 values at 0/11/20/32/47/51/71/86/100/150 km vs the table to 0.1 %; Tsiolkovsky dv per stage equals 13.2 table to 1 m/s; ascent-to-orbit pilot only; reentry corridor sweep (perigee 10..90 km -> outcome class: too steep / ok / skip) ; parachute envelope; leg-contact drop tests (1, 3, 5 m/s on 0/10/20 deg slopes -> ok/ok/collapse, tip thresholds); buoyancy equilibrium; SAS convergence for each vessel configuration (settle < 20 s from 90 deg error, overshoot < 5 deg); warp auto-drop (never steps past an event); determinism (two runs, identical hash).

### 16.4 Browser acceptance

Playwright launches Chrome with `--enable-unsafe-webgpu --force_high_performance_gpu` (and Windows GPU preference), opens `/?scenario=lunar-direct&pilot=1&warpPolicy=test`, and lets the same pilot fly in real time with the allowed warp levels (physics warp 4x during burns/atmosphere, rails warp during coasts); expected wall-clock ~ 20-25 minutes. It captures screenshots at each milestone, frame-time percentiles per phase (p95 < 16.7 ms gate), and asserts the same milestone list via `window.__sim.milestones`. Because the browser frame cadence differs from headless, the browser run is judged on the gates above, not on the golden hash.

---

## 17. Data schemas (`src/sim/data/schema.ts`)

All data is JSON validated at load (hand-written validators with precise error paths; no network schema dependency). IDs are strings; cross-references are resolved after all files load. Adding a planet, moon, vehicle or site = adding files, no engine change.

```ts
// ---------- bodies ----------
interface BodyDef {
  id: string; name: string;
  parent: string | null;                       // null = root
  mu: number;                                  // m^3/s^2
  radius: number;                              // m, physics datum sphere
  soiRadius: number | null;                    // null = root (infinite); else explicit metres (or "auto" computed a(m/M)^0.4)
  orbit: null
       | { kind: 'kepler'; frame: 'ecliptic' | 'parentEquator'; a: number; e: number; iDeg: number;
           lanDeg: number; argPeDeg: number; meanAnomalyDeg: number; epochUt: number }
       | { kind: 'sunLowPrecision' };          // direction/distance only
  rotation: { mode: 'fixedRate'; poleRaDeg: number; poleDecDeg: number; w0Deg: number; rateDegPerDay: number; epochUt: number }
          | { mode: 'tidalLock'; poleRaDeg: number; poleDecDeg: number };
  gravityRole: 'attractor' | 'lightOnly';      // Sun = lightOnly in this build
  atmosphere: null | {
    model: 'ussa76' | 'table' | 'exponential';
    table?: { hKm: number; rho: number; p: number; T: number }[];
    rho0?: number; scaleHeight?: number;
    simTop: number;                            // m, rails boundary
    gamma: number; gasConstant: number;
    heating: { kConv: number; radiative: null | { c: number; rhoExp: number; kRad: number; fTable: [number, number][] } };
  };
  ocean: null | { density: number; seaLevel: number; waves: { dirDeg: number; wavelength: number; amplitude: number }[] };
  terrain: { tileset: string; maxElevation: number; minElevation: number;
             modifiers: TerrainModifier[];     // e.g. site pads, authored flats
             surfaceFriction: number; regolith?: boolean };
  warpAltitudeLimits: number[];                // metres, one per rails warp level
  navballSwitchAltitude: number;
  render: Record<string, unknown>;             // opaque to the sim (textures, scattering coefficients ...)
}
type TerrainModifier = { kind: 'flattenDisc'; latDeg: number; lonDeg: number; flatRadius: number; blendRadius: number; elevation: number | 'sample' };

// ---------- launch sites ----------
interface LaunchSiteDef {
  id: string; name: string; bodyId: string;
  latDeg: number; lonDeg: number; padElevation: number | 'terrain';
  padAzimuthDeg: number;                       // direction the vessel's ventral side faces
  pad: { flatRadius: number; blendRadius: number; clampHeight: number };   // becomes a terrain modifier
  structures: { model: string; offsetEnu: [number, number, number]; headingDeg: number }[];   // tower, tanks, lightning masts (render + static colliders)
  recoveryZones?: { name: string; latDeg: number; lonDeg: number; radiusKm: number }[];
}

// ---------- resources ----------
interface ResourceDef { id: string; name: string; density: number }

// ---------- parts ----------
interface PartDef {
  id: string; name: string; category: 'command' | 'tank' | 'engine' | 'structural' | 'decoupler' | 'aero' | 'utility' | 'legs' | 'chute';
  dryMass: number;
  comOffset: [number, number, number];
  inertiaShape: { kind: 'solidCylinder' | 'shellCylinder' | 'cone' | 'sphere' | 'box'; r?: number; h?: number; size?: [number, number, number] };
  geometry: { generator: string; params: Record<string, number | string> };       // procedural mesh id + params (renderer); also gives bounding dims
  attachNodes: { id: string; pos: [number, number, number]; dir: [number, number, number]; size: number }[];
  resources?: { resource: string; capacity: number; tankBottomY: number; tankHeight: number }[];
  aero?: AeroElementDef[];
  thermal: { surfaces: { area: number; normal: [number, number, number] | 'axisym'; noseRadius: number;
                         emissivity: number; arealHeatCapacity: number; maxTemp: number }[] };
  contactPoints?: { pos: [number, number, number]; radius: number; k?: number; c?: number; mu?: number; crashTolerance: number }[];
  buoyancy?: { pos: [number, number, number]; radius: number }[];
  joint: { maxAccelG: number; maxQAlpha?: number };
  modules: ModuleDef[];
}
type ModuleDef =
  | { type: 'command'; crewCapacity: number; sas: boolean; maxRateDegPerS: number; seats: { pos: Vec3Tuple; lookDir: Vec3Tuple }[]; hatch?: { pos: Vec3Tuple; dir: Vec3Tuple } }
  | { type: 'engine'; thrustVac: number; ispVac: number; ispSL: number; minThrottle: number; throttleable: boolean;
      spoolUp: number; spoolDown: number; maxIgnitions: number | null; propellants: { resource: string; ratio: number }[];
      nozzles: { pos: Vec3Tuple; dir: Vec3Tuple; exitDiameter: number; exitPressure: number }[];
      gimbal?: { rangeDeg: number; rateDegPerS: number }; fixedBurn?: { duration: number }; plume: string; sound: string }
  | { type: 'rcs'; thrusters: { pos: Vec3Tuple; dir: Vec3Tuple; thrust: number }[]; isp: number; resource: string }
  | { type: 'reactionWheel'; torque: Vec3Tuple }
  | { type: 'decoupler'; impulse: number; separationPlaneY: number }
  | { type: 'fairing'; panels: number; impulse: number; shields: string[] }          // part ids shielded while closed
  | { type: 'launchClamp' }
  | { type: 'les'; }                                                                   // abort sequencing role
  | { type: 'legs'; legs: { hinge: Vec3Tuple; footDeployed: Vec3Tuple; footStowed: Vec3Tuple; stroke: number; k: number; c: number }[]; deployTime: number }
  | { type: 'parachute'; mode: 'drogue' | 'main'; count: number; cdAFull: number; reefStages: { fraction: number; duration: number }[];
      fullInflateTime: number; safe: { maxAlt: number; maxMach?: number; maxSpeed?: number; maxQ: number }; destroy: { maxQ: number; maxMach?: number; maxSpeed?: number };
      attach: Vec3Tuple }
  | { type: 'heatShield'; ablatorResource: string; area: number; qThreshold: number; heff: number; conductFraction: number }
  | { type: 'light' | 'antenna'; params: Record<string, number> };                    // cosmetic state

// ---------- vehicles ----------
interface VehicleDef {
  id: string; name: string;
  parts: { id: string; def: string; parent: string | null; parentNode?: string; node?: string;
           position?: Vec3Tuple; rotationDeg?: Vec3Tuple; resources?: Record<string, number>; stageGroup: string }[];
  stageGroups: { id: string; label: string }[];                 // propellant-flow groups (between decouplers)
  stages: { label: string; icon: string; actions: (StageAction & { delay?: number })[] }[];   // fired in order
  abort: (StageAction & { delay?: number })[];
  actionGroups: Record<string, StageAction[]>;
  crew: { seat: string; name: string }[];
  cameras: { cockpit: { part: string; seat: number }; chase: { defaultDistance: number } };
}

// ---------- scenarios ----------
interface ScenarioDef { id: string; vehicle: string; site: string; startUt: number; target?: string;
                        suggestedLanding?: { bodyId: string; latDeg: number; lonDeg: number; name: string } }
```

Future module types (for example a `dockingPort` for a lunar-orbit-rendezvous mission) are added as new members of the `ModuleDef` union with their own file in `vessel/modules/`; none is shipped unimplemented, because the brief forbids stubs.

---

## 18. Sim <-> presentation contract

```ts
interface SimSnapshot {
  ut: number; warp: { level: number; factor: number; limitedBy: string | null };
  bodies: { id: string; rBci: Vec3 /* relative to root */; vBci: Vec3; qBodyFixedToInertial: Quat; sunDir: Vec3 }[];
  vessels: {
    id: string; name: string; active: boolean; controllable: boolean; tier: 'full' | 'reduced' | 'rails';
    bodyId: string; r: Vec3; v: Vec3; q: Quat; w: Vec3;          // float64, relative to bodyId centre (BCI)
    situation: 'prelaunch' | 'landed' | 'splashed' | 'flying' | 'suborbital' | 'orbiting' | 'escaping';
    parts: { instanceId: string; def: string; localPos: Vec3; localRot: Quat; destroyed: boolean;
             tempSkin: number; maxTemp: number; moduleStates: Record<string, unknown> /* engines: throttleActual, gimbal; legs: compression; chutes: state, inflation; fairing ... */ }[];
    aero: { q: number; mach: number; aoa: number; plasmaIntensity: number; airDensity: number; pressure: number };
    gLoad: number; contact: { anyContact: boolean; maxImpulse: number; waterSubmersion: number };
  }[];
  activeVesselId: string;
  navball: NavballState; readouts: Readouts;
  patches: { current: Patch[]; planned: Patch[] }; nodes: ManeuverNode[]; markers: Marker[];
  events: SimEvent[];                  // drained each frame: ignition, shutdown, staging, decouple, fairing, explosion, partDestroyed,
                                       // touchdown{speed}, splash{speed}, chuteDeploy/Inflate/Fail, soiChange, warpChanged, milestone ...
}
```

Audio derives everything it needs from this: per-engine thrust and ambient pressure (rumble level, vacuum muffling = `pressure / 101325` driven low-pass with a structure-borne path that remains in vacuum), `aero.q`/`mach` (wind, transonic buffet), `plasmaIntensity` (re-entry roar), events (staging bangs, touchdown), camera position relative to nozzles (the view layer knows the camera).

### 18.1 Navball (`nav/navball.ts`)

`NavballState { qVesselToHorizon: Quat; mode: 'surface' | 'orbit'; markers: { prograde, retrograde, normal, antinormal, radialOut, radialIn, maneuver?, target?, antiTarget?, liftVector? : Vec3 /* unit, vessel frame */ }; pitchDeg; headingDeg; rollDeg }`.

* Horizon frame = ENU at the vessel's sub-point of the current SOI body. The ball texture is a full sphere (blue = above horizon/sky, brown = ground, heading meridians every 30 deg, pitch parallels every 10 deg); the renderer draws it as a real 3-D sphere with rotation `inverse(qVesselToHorizon)` and projects markers that lie on the visible hemisphere.
* Orbit mode: prograde = `v_bci`; surface mode: prograde = `v - omega x r`. Normal = `r x v` direction; radial-out = `prograde x normal` (consistent with the node frame, 3.5).
* `pitch = asin(dot(nose, up))`, `heading = atan2(dot(nose, east), dot(nose, north))`, roll from the dorsal axis.
* Auto mode switch at `navballSwitchAltitude` (crossing with 5 % hysteresis); manual toggle by clicking the speed readout.

---

## 19. EVA extensibility hooks (not built now, room left deliberately)

Nothing below is a stub in the shipped code; these are the seams that make EVA an additive feature:

1. **Vessel-agnostic world**: `Sim` simulates a list of `Vessel`s; an astronaut is a vessel with one part `kerbal`-style `evaSuit` (mass 120 kg, RCS jetpack = an `rcs` module with its own propellant, `command` module with `crewCapacity 1`). Free-fall EVA therefore needs **no new physics**: rails/integration switching, SOI, warp, SAS-like attitude hold and RCS translation already exist.
2. **Controller interface**: input routing goes through `ActiveController` (`FlightController` today). A future `EvaController` maps WASD to RCS translation in free fall, and on a surface switches the vessel's dynamics to a `SurfaceWalker` character controller: capsule collider against `TerrainProvider.heightAt/normalAt` (already authoritative for collisions and already in the body-fixed frame), gravity from `body.mu/r^2`, friction from `terrain.surfaceFriction`, jump impulse, low-g hop gait on the Moon; `landed`-frame state storage already exists.
3. **Crew as data**: crew members are entries in `VehicleDef.crew` bound to seats; a seat has `pos/lookDir`, and the `command` module already carries an optional `hatch` position/direction. "Go EVA" = remove crew from a seat, spawn an `evaSuit` vessel at the hatch with the parent's velocity; "board" = the inverse when within 1.5 m of a hatch.
4. **Physics bubble with multiple full-fidelity vessels** (section 14) is what lets the lander stay simulated/loaded while the astronaut walks 200 m away; `mustIntegrate` rule 6 (nearby vessel) and vessel switching keys are in place.
5. **Camera contract**: the view layer asks the active controller for a camera rig (`cockpit`, `chase`, later `firstPersonEva`, `thirdPersonEva`); the sim only provides poses.
6. **Terrain detail guarantee**: collision = rendered surface to < 3 cm near the active vessel (9.1), which is the precondition for believable footsteps and for placing flags/experiments later.

---

## 20. Controls summary (keyboard; data-driven binding table in `src/input/bindings.ts`)

| Action | Key |
|---|---|
| Pitch down/up, yaw left/right, roll left/right | W/S, A/D, Q/E |
| Throttle up/down, full, cut | Shift / Ctrl (0.5 per second), Z, X |
| Stage, abort | Space, Backspace |
| SAS toggle, RCS toggle, gear, lights | T, R, G, U |
| SAS modes | navball-side buttons; hotkeys Alt+1..9 (stability, prograde, retrograde, normal, antinormal, radial out, radial in, maneuver) |
| RCS translate | I/K fwd/back, J/L left/right, H/N up/down |
| Fine control | CapsLock |
| Warp up/down/stop | `.` `,` `/` |
| Map view, camera cycle (cockpit/chase) | M, C |
| Navball surface/orbit | click speed readout or Tab |

---

## 21. Risks and the mitigations built into this design

| Risk | Mitigation |
|---|---|
| Hand-flown/perigee targeting too twitchy at lunar distance | lifting capsule + roll rule widens the survivable corridor to perigee 10-65 km **(verified)**; skip-out is recoverable once (ablator budget) |
| Player runs out of propellant | 10-13 % margin on every stage; M-2 residual and M-3 spare cover a sloppy ascent **(verified with deliberately poor pitch programmes)** |
| Landing on a slope/boulder | wide stance (static tip limit ~ 40 deg), mare suggested site, 70 s hover reserve, radar altimeter + horizontal-velocity readout; abort-to-orbit stage |
| Terrain tile not loaded at touchdown | coarse pyramid always resident; `ensureLoaded` from 50 km; sim-clock hold below 300 m as last resort |
| Penalty contacts unstable on a 23 t lander | 480 Hz contact sub-steps, stiffness scaled with mass, sleep rule; drop tests in CI |
| SOI event missed at 100 000x | analytic/Brent event times + warp clamped to `tEvent`; unit test sweeps |
| Launch window confusion | pad HUD countdown to plane crossing + azimuth; scenario starts 10 minutes before a window; coplanar parking orbit makes every revolution a TLI opportunity |
| Determinism drift between headless and browser | identical `step()`; browser judged by gates, headless by golden hash |
