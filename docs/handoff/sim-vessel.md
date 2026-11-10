# Hand-off: sim-vessel

Vessel dynamics for the Meridian / Heron / Kestrel stack: runtime vessel model, staging, propulsion,
aerodynamics, heating, contact, water, parachutes, SAS, plus the part and vehicle data.

- Code: `src/sim/vessel/**`, `src/sim/dynamics/**`, `src/sim/control/**`
- Data: `data/defs/resources.json`, `data/defs/parts/*.json` (25 parts), `data/defs/vehicles/meridian-lunar.json`
- Tests: `tests/unit/sim-vessel/*.test.ts` (11 files, 127 tests, about 17 s)
- Request filed: `docs/requests/sim-vessel-1.md` (doc comments in the contracts; not blocking)

Verify:

```
npm run typecheck:paths -- src/sim/vessel src/sim/dynamics src/sim/control tests/unit/sim-vessel
npx vitest run src/sim/vessel src/sim/dynamics src/sim/control tests/unit/sim-vessel src/core/defs
npx vitest run tools/dev/boundaries.test.ts
npx vitest run tests/unit/sim-vessel --disable-console-intercept      # prints the measured numbers quoted below
```

---

## 1. The frozen facade: `src/sim/vessel/public.ts`

The only module of `src/sim` that the vehicle, cockpit and vfx labs and tests may import. None of it needs a
`VesselEnvironment`. Signatures are frozen.

```ts
export type { Vessel } from './types';

assembleVessel(defs: DefLibrary, vehicleId: string, options?: { stagesAlreadyFired?: number }): Vessel
vesselPartSnapshots(vessel: Vessel): PartSnapshot[]
setModuleStateForLab(parts: PartSnapshot[], instanceId: string, moduleIndex: number, patch: Record<string, unknown>): void
splitForStage(defs: DefLibrary, vessel: Vessel, stageIndex: number): { vessel: Vessel; spawned: Vessel[] }
```

- `assembleVessel` resolves attach nodes into part poses (VES of the root part), fills tanks, creates neutral
  module states. `stagesAlreadyFired = n` applies stages `0..n-1` structurally: dropped parts are discarded,
  engines ignited by those stages are armed (`active`, zero thrust), spent solids are empty, deployed legs and
  parachutes are in their end state. The vessel sits at the origin with identity attitude.
  Part counts after n stages: 42, 38, 26, 23, 14, 9, 9, 5, 2, 1, 1.
- `vesselPartSnapshots` returns deep copies: `localPos` / `localRot` (part frame -> VES), `tempSkin` / `maxTemp`
  (the surface closest to its limit), `resources` by id, `modules` (index = `PartDef.modules` index),
  `shielded`. It fits `FakeSimOptions.parts` directly (tested with `createFakeSim`).
- `setModuleStateForLab` merges `patch` into one module state in place (the `type` cannot be changed; throws
  for an unknown part or module). Module indices of the capsule: 0 command, 1 heatShield, 2 rcs, 3
  reactionWheel, 4 parachute (drogue), 5 parachute (main), 6 light, 7 antenna.
- `splitForStage` returns a NEW continuing vessel plus the separated vessels; the input is not modified. All
  actions of the stage are applied at once (no delays, no dynamics; separation impulses ARE applied to the
  velocities). Each spawned vessel's `r`, `q` place its own root part where it was in the stack, so drawing
  every returned vessel reproduces the stack at the instant of separation (tested to 1e-6 m for all ten
  stages). Feed the returned `vessel` back in to walk the stack: stage 0, 1, 2, ...

### Conventions the renderer relies on

- **Frames.** VES origin = origin of the root part. The vehicle tree is rooted at the capsule (`capsule`), so the
  crewed vessel's VES never changes through the mission: capsule part frame = VES, y = 0 at the heat shield's
  maximum diameter, the stack hangs below (negative y), the tower stands above.
- **Fairing panels.** Jettisoning fairing part `<id>` (def with a `fairing` module of N panels) yields N debris
  vessels, each with ONE part: `def` = the fairing def, `instanceId` = `<id>#panel<k>` (k = 0..N-1), identity
  pose, in a vessel whose frame is the fairing's part frame at separation. Panel k covers the azimuth sector
  `[k, k+1) * 360/N` degrees, azimuth measured about +Y from +Z toward +X (same as the mould-line convention), so
  its centre is at `(k + 0.5) * 360/N`. Module state `fairing.jettisoned = true`. Mass, CoM, inertia and drag of
  a panel are those of its sector. Each panel leaves with `impulse / panelMass` (6 m/s) radially and an outward
  hinge spin (kick applied 4 % of the height above the panel centroid).
- **Launch clamps.** The four `clamp-*` parts are children of `m1`. While they hold, the vessel has
  `hold = 'clamps'` and the clamps carry no flight mass. On release they stay behind as ONE vessel
  (`meridian-lunar~clamp-1`, parts `clamp-1..4`, `launchClamp.released = true`, `hold = 'ground'`) that rides
  the rotating body forever.
- **Boost cover.** The LES part (`kestrel-les`) carries a `fairing` module with `panels: 1` whose only purpose
  is its `shields` list (capsule and apex cover are shielded while the tower is on). It is never jettisoned as
  a fairing and never produces `#panel` vessels.
- **Spawned vessel ids** are `<original id>~<root part instance id>` (`meridian-lunar~interstage-1` is the spent
  M-1). Names: label of the heaviest stage group (`Meridian M-1`, `Heron descent stage`), or the part name for
  one- and two-part vessels.
- **Nozzles.** `NozzleDef.pos` is the centre of the exit plane, `dir` the exhaust direction. Engine parts have
  their origin at the mount (top), the bell hangs toward -y. `rcs.thrusters[].dir` is the EXHAUST direction as
  well (thrust acts opposite) - see the request file.
- **Legs.** `legs[i].hinge / footDeployed / footStowed` are in the part frame; the foot swings along the
  straight line from stowed to deployed with a smooth-step of `deploy` (`legFootLocal(def, i, deploy)` is
  exported from `@/sim/vessel` for the orchestrator; the model team can reproduce it: `t = d*d*(3-2d)`).
  `compression[i]` shortens the strut along hinge-foot. `PartDef.contactPoints[i]` of the legs part describes
  pad i (radius 0.4 m).
- **Antennas** report `deployed = true` once their part is neither shielded by a fairing nor on the pad.

### Stack layout (VES y of each part's extent; x, z = 0 unless noted)

| Instance | Def | y range (m) | Radius (m) |
|---|---|---|---|
| `les` (+ `les-jettison-motor` at y 7.02) | kestrel-les | 0.00 .. 10.65 (cover skirt down to 0, tower top 10.65) | 2.05 |
| `apex-cover` | kestrel-apex-cover | 2.85 .. 3.15 | 0.55 |
| `capsule` (root) | kestrel-capsule | -0.45 .. 2.85 | 2.0 |
| `capsule-adapter` | heron-capsule-adapter | -0.6 .. 0.0 | 2.0 |
| `ascent-stage` (`lyra-a` inside, exit flush at -4.2) | heron-ascent-stage | -4.2 .. -0.6 | 2.0 |
| `stage-separator` | heron-stage-separator | -4.5 .. -4.2 | 2.0 |
| `descent-stage` (`lyra-d` inside, exit flush at -7.9) | heron-descent-stage | -7.9 .. -4.5 | 3.0 |
| `landing-legs` | heron-landing-legs | hinges r 2.9 at -6.1; pads r 6.8 at -8.6 (deployed) / r 2.6 at -1.48 (stowed) | |
| `payload-adapter` | meridian-payload-adapter | -9.5 .. -7.9 | 3.2 |
| `fairing` | meridian-lander-fairing | -9.5 .. 0.0 | 3.35 |
| `m3` (`vela-2v` exit at -20.9, pods at x = +-3.45, y -19.5) | meridian-m3 | -20.5 .. -9.5 | 3.3 |
| `interstage-2` | meridian-interstage-2 | -23.5 .. -20.5 | 4.5 (9 -> 6.6 m cone) |
| `m2` (6 x `vela-2` on r 2.9, exits at -56.1; `m2-ullage` ring) | meridian-m2 | -55.5 .. -23.5 | 4.5 |
| `interstage-1` (`m1-retro` ring) | meridian-interstage-1 | -57.5 .. -55.5 | 4.5 |
| `m1` (9 x `atlas-9m`: centre + 8 on r 3.3, exits at -99.9) | meridian-m1 | -97.5 .. -57.5 | 4.5 |
| `clamp-1..4` (r 5.6, azimuth 45/135/225/315) | meridian-launch-clamp | -101.0 .. -97.5 | 1.0 |

Bell exits to tower tip: 110.5 m; stage base to tower tip 108.2 m (sim-design: "about 106 m").
The stowed leg feet stand beside the ascent stage (pad edge out to r 3.0 at fairing-frame y 8.4): the fairing
shell must stay at least 3.05 m in radius up to there before it tapers to the capsule.

---

## 2. Orchestrator API (`import ... from '@/sim/vessel'`)

Everything below is exported from `src/sim/vessel/index.ts`.

### Types

```ts
interface Vessel {                       // src/sim/vessel/types.ts (all fields are plain data)
  id; name; vehicleId; vehicle: VehicleDef;
  parts: PartRuntime[];                  // parents precede children; parts[0] is the root
  r: Vec3; v: Vec3;                      // VES origin in BCI of the current body, m and m/s  (WRITE to place / on SOI change)
  q: Quat; w: Vec3;                      // VES -> BCI (= ROOT axes); body rate in VES, rad/s
  age; stepCount;
  nextStage; stageLockout; pending; sinceStaging;
  sas: SasState; rcsEnabled; fineControl; lightsOn; throttle; appliedControls: ControlInputs;
  hold: 'clamps' | 'ground' | 'asleep' | null;   anchor;   surface: 'none' | 'prelaunch' | 'landed' | 'splashed';
  mp: { mass; com: Vec3 (VES); i; inv };          // refreshed by every step
  aero: { q; mach; aoa; density; pressure; temperature; airVelocity (BCI); heatFlux; plasmaIntensity;
          liftDirVes: Vec3 | null; force; torque };
  thrust; authority: [x, y, z] N m; gLoad; properAccel (VES); gDose; crewAlive;
  contact: { anyContact; maxForce; waterSubmersion }; groundClearance; destroyed;
}
interface PartRuntime { instanceId; def: PartDef; parent: number; stageGroup; pos; rot; resources: number[] (kg, parallel to def.resources);
                        modules: ModuleState[]; temps: number[]; shielded; panel: { index; count } | null; ... }
interface StepResult { events: SimEvent[]; spawned: Vessel[] }
```

### Functions

```ts
// --- build
assembleVessel(defs, vehicleId, { stagesAlreadyFired? }): Vessel
cloneVessel(v: Vessel): Vessel
vesselBaseY(v: Vessel): number                    // lowest point along VES y: clamp base (-101.0) or lowest probe / deployed pad

// --- step
stepVessel(vessel, env: VesselEnvironment, controls: ControlInputs, dt: number): StepResult
stepVesselReduced(vessel, env, dt): { removed: 'burnedUp' | 'impact' | null; impactDirFixed: Vec3 | null }
rideBody(vessel, env, dt): void                   // held vessels: pose at env.ut + dt on the rotating body
holdOnGround(vessel, env, kind?: 'asleep' | 'ground'): void   // fix a placed vessel to the ground where it stands
needsIntegration(vessel, env): boolean

// --- commands
fireNextStage(vessel, env): { ok; reason?; events; spawned }
abort(vessel, env): { ok; reason?; events; spawned }
nextLiveStage(vessel): number
toggleLegs(vessel, ut): SimEvent[];  setLegsDeployed(vessel, deployed, ut): SimEvent[];  legsDeployed(vessel): boolean | null
setLights(vessel, on);  setRcsEnabled(vessel, on);  setFineControl(vessel, on)
setSasEnabled(vessel, on);  setSasMode(vessel, mode: SasMode);  setSasHoldDirection(vessel, dirRoot: Vec3 | null)

// --- read
toVesselSnapshot(vessel, { bodyId, tier, situation, translationMode, rRoot, vRoot, sunVisibility }): VesselSnapshot
vesselPartSnapshots(vessel): PartSnapshot[]
stagingInfo(vessel, env): StageInfo[]
vesselReadouts(vessel, env): Pick<Readouts, 'throttle' | 'thrust' | 'twr' | 'mass' | 'gLoad' | 'gDose' | 'gDoseLimit' | 'dynamicPressure' | 'mach'
   | 'angleOfAttack' | 'heatFlux' | 'ablatorFraction' | 'maxTempFraction' | 'sasEnabled' | 'sasMode' | 'rcsEnabled' | 'fineControl' | 'legsDeployed'
   | 'lightsOn' | 'chuteEnvelope' | 'rcsFraction' | 'deltaVTotal' | 'liftVectorUp' | 'tiltFromVertical'>
nextChuteEnvelope(vessel, env): ChuteEnvelope | null
radarAltitude(vessel, env): number
surfaceSituation(vessel): 'prelaunch' | 'landed' | 'splashed' | null      // null = decide from the orbit
isControllable(vessel): boolean                                         // has a command part
vesselStateHash(vessel): string                                         // 16 hex digits
vesselClearance(a, b): number;  vesselClearanceDetail(a, b): { distance; partA; partB }
computeMassProps(vessel);  vesselMass(vessel);  structureOf(vessel);  ispAt / thrustAt / throttleTarget;  chuteEnvelope / inflationAt;
convectiveFlux / radiativeFlux / stagnationFlux(heating, rho, speed, noseRadius)
```

### Call order

```
start       v = assembleVessel(defs, scenario.vehicle, { stagesAlreadyFired })
            v.id = ...                                   (ids of later debris derive from it)
            place it: v.r, v.v, v.q, v.w in BCI of its body
              pad:    stand the stack so that the point (0, vesselBaseY(v), 0) of VES is on the launch mount
                      (pad elevation + site.pad.clampHeight), v = spin x r, w = q^-1 spin. The first stepVessel
                      captures the clamp anchor; call holdOnGround(v, env) if you move it afterwards.
              landed: put the pads on the ground and call holdOnGround(v, env)   -> hold 'asleep'
each step   for the active vessel: setSasHoldDirection(v, dirRoot) for every mode but 'stability'
            for (k = 0; k < vessels.length; k++)             // NOTE: the list grows inside the loop
              res = stepVessel(vessels[k], envOf(vessels[k]), k is active ? controls : NEUTRAL_CONTROLS, PHYSICS_DT)
              queue res.events;  vessels.push(...res.spawned)
              if (vessels[k].destroyed) remove it afterwards
commands    fireNextStage / abort return events and spawned vessels as well (push them; they are in the
            current state and take part from the next step on)
rails       needsIntegration(v, env) === false -> the vessel may go on rails / stay landed.
            While a held vessel is not stepped, call rideBody(v, env, 0) whenever you need its pose at env.ut.
debris      beyond the bubble: stepVesselReduced(v, env, dt) (any dt, e.g. 0.5 s); remove on `removed`.
snapshot    toVesselSnapshot(v, {...}); stagingInfo(active, env); vesselReadouts(active, env)
```

Semantics the orchestrator must respect:

- **`env` is the world at the START of the step** (`env.ut`, `qFixedToInertial`, swell, sun). `stepVessel`
  advances the vessel to `env.ut + dt`.
- **Vessels in `StepResult.spawned` are in the start-of-step state** (the split happens before the integration)
  and must be stepped once in the same tick with the same environment - hence the growing loop above. Skipping
  that leaves debris one step (4 m at pad rotation speed) behind.
- **Debris is stepped with `NEUTRAL_CONTROLS`**: its engines spool down, its solid motors and delayed stage
  actions (M-1 retro motors, M-3 evasion burn) still run - they are queued on whichever vessel holds the parts.
- **Held vessels** (`hold !== null`): `stepVessel` moves them rigidly with the body (position from the anchor,
  `v = spin x r`), runs engines / timers, and reports 1 g. `'clamps'` ends when the clamps release, `'asleep'`
  (resting after a landing) ends on thrust, an RCS translation command or any stage action, `'ground'` never
  ends. Sleep is entered after 2 s in contact below 0.05 m/s and 0.2 deg/s with no thrust.
- **SAS.** `setSasMode` takes the contract's `SasMode`; for every mode but `'stability'` the orchestrator supplies
  the unit hold direction in ROOT axes each step (`setSasHoldDirection`); with `null` the mode behaves as
  stability. The SAS lets go while the vessel rests on the ground or floats with no engine lit.
- **Lift vector.** `vessel.aero.liftDirVes` (VES unit vector, null when there is no lifting capsule or q < 10 Pa)
  is the measured direction of the aerodynamic lift; use it for `NavballMarkers.liftVector`;
  `vesselReadouts().liftVectorUp` compares it with the radial direction. The lift points to the side the CoM is
  offset to: body **-Z** for the Kestrel (crew heads-down for lift-up), not +Z as sim-design 8.2 says.
- **SOI change:** re-express `r`, `v` in the new body's BCI; `q`, `w` are unaffected (axes are ROOT-parallel).
- **`Sim.debug.setResource`:** write `part.resources[k]` (kg) directly; mass properties follow on the next step.
- `vessel.groundClearance` is the lowest probe's height above terrain / sea while a step is within contact
  range (exact, collision surface), a coarser bound above that, `Infinity` above 25 km. `radarAltitude()` makes
  one band-limited query (`lambdaMin = max(0.3, 0.02 * altitude)`) and can be called any time.
- `stagingInfo`: delta-v is Tsiolkovsky with current masses. For an unfired stage, earlier stages are assumed
  to burn dry, and inert stages that directly follow it (tower + fairing jettison, gear) are assumed fired right
  after its ignition - so the M-2 entry shows 6 197 m/s. The stage whose engines run now uses the mass really
  attached. The delta-v belongs to the stage entry that ignites the engines; `deltaVTotal` is the sum.
- `vesselClearance(a, b)`: minimum distance between part envelopes, negative = overlap depth along the best
  separating axis. Parts are their `bounds` cylinders; a `legs` part is the cylinder around hinges and feet at the
  current deployment; a fairing panel is the solid sector between 0.6 and 1.0 of the bounds radius, sampled on
  a 3 x 7 x 11 grid (about 0.9 m). Cost: well under 1 ms except with fairing panels in play (about 1 ms).
- Events emitted here: `stageFired, engineIgnition, engineShutdown, clampsReleased, decoupled,
  fairingJettisoned, lesFired, legsToggled, chuteDeployed, chuteInflated, chuteCut, chuteFailed, rcsPulse,
  touchdown, splash, partDestroyed, explosion, jointBroken, crewLost`. `vesselId` is the id of the vessel the
  event happened on at that moment. `jointBroken` is also used for a collapsed landing leg (`partId` = the
  legs part). `vesselRemoved`, `missionFailed`, milestones are the orchestrator's.

### Step order inside `stepVessel` (sim-design 4.2)

1. lockout / delayed stage actions (may split the vessel);  2. mass properties;  3. ambient air, legs,
parachute state machines, authority, SAS, actuator allocation (gimbal targets, wheels, RCS), engines (spool,
propellant, flame-out, gimbal servo);  4. free flight: RK4 on the CoM with gravity + thrust + aero + chutes
(aero re-evaluated at each stage), then the semi-implicit attitude update (mid-point, two fixed-point
iterations);  4'. when any probe or buoyancy sphere is within 5 m (+ two steps of travel) of ground or
water: four sub-steps of semi-implicit Euler with all forces plus penalty contact and buoyancy;  5. g-load
filter, surface state;  6. thermal step;  7. crash / overheat destruction, crew dose, joint over-stress and
q-alpha, sleep detection.

---

## 3. Model notes (where the implementation adds to or departs from sim-design)

| Area | What is implemented |
|---|---|
| Staging | A `decouple` / `jettisonLES` action cuts the joint between the named part and its PARENT (tree rooted at the capsule, so interstages and adapter rings stay on the lower stage). Linear impulse along the part's Y axis, equal and opposite, applied to the CoM velocities. Stages whose parts are all gone are skipped (after an abort the next press is "Capsule separation", then the chutes). A failed clamp thrust check shuts the engines down and re-arms the stage. |
| Engines | Each engine is its own part (9 + 6 + 1 + 1 + 1); retro, ullage, LES and jettison motors are single parts with multi-nozzle fixed-burn modules. Thrust is cut to zero when the spool lag falls below 1 % after shutdown. Flame-out ends thrust at once (the throttle display tails off). |
| Allocation | Every actuator degree of freedom gets a weight per axis `a_i / max|a_i|`. RCS joins an axis only when gimbal + wheel torque is less than 3x the RCS torque on it (replaces the two-threshold rule of 7.5); thruster deadband 0.05. Nine gimballed engines give roll by differential deflection. |
| SAS | sim-design 7.6 plus: (a) slow integral action (4 s) inside 3 deg and below 0.3 deg/s, which removes the offset left by a thrust line off the CoM; (b) authority-aware anti-windup: the aerodynamic + parachute torque AT THE TARGET ATTITUDE is evaluated every step from the force model; hold weight per axis falls to 0 between 0.6 and 1.0 of the authority and returns between 0.7 and 0.35 (hysteresis), rate-limited; (c) coordinated roll: while a hold is released, the pitch/yaw rate reference is the rotation about the airflow that matches the measured roll rate, with a 0.5 deg/s deadband, so banking does not fire the pitch/yaw jets. |
| Aero | Axisymmetric bodies with face exposure = 1 - (largest radius ahead / own radius)^2 (stack shadowing), cross-flow at the centre of pressure, local velocity includes rotation (tumbling damps). Blunt capsule per 8.2 with the normal force along the lateral airflow; active while the shield face is uncovered, otherwise the capsule's `axisymBody` element is used. Flat plates (legs, fairing panels). |
| q-alpha | A joint with `maxQAlpha` breaks after 0.2 s above it. Limits 3 500 - 5 000 Pa rad (see request: the 60 000 of sim-design cannot be reached; its own example is 3 456). |
| Thermal | Per surface. Axisymmetric skin exposure 0.15 + 0.85 max(0, axis . travel); wake factor 0.03 behind an upstream part of at least the same radius (refreshed every 8 steps) and for the skin of a part whose own flat face leads (capsule back shell). Environment temperature 4 K + 250 K x sun visibility, blended to air temperature by density. Ablation rate `area (q - qThreshold) / Heff`; with ablator left the substrate sees `conductFraction` of the net flux. |
| Contact | Penalty probes in the rotating frame with a stick-slip (bristle) friction anchor per probe instead of viscous regularisation, so a resting vessel does not creep. Structural stiffness 4e6 N/m x m/20 t, damping ratio 0.6. Legs: axial strut force `preload + k s + c s'` with 4x damping in extension (no kick-back), bottoming stiffness 4e6 N/m, collapse at first contact above 4.0 m/s normal or 2.5 m/s lateral or 8 cm past the stroke. |
| Water | Buoyancy spheres on `env.ocean.waterHeight` (sampled per sphere per step), quadratic slam drag (Cd 0.8) plus a linear term (0.5 rho V sqrt(g/a) v) standing for wave-radiation damping. Parachutes are cut after 3 s afloat below 1 m/s (`surface = 'splashed'`). |
| Failure | Destroyed parts are removed; what they held together separates; tanks with more than 5 % of burnable propellant explode (2 N s per kg, radial, on every surviving piece; `explosion` event with 4 MJ/kg). Crew: dose above 10 g, recovery below 6 g, lost above 15 g s. One `maxAccelG` per joint (no separate lateral limit). |
| Reduced tier | 3-DoF RK4 with a tumbling-average drag area, one lumped thermal node (half the stagnation flux of a body of half the bounding radius, weakest skin of the vessel), impact against band-limited terrain or the sea. |

---

## 4. Data notes

- Masses reproduce sim-design 13.1 to the gram: lift-off 2 756 100 kg, 846 100 at M-2 ignition, 836 100 after
  tower and fairing, 154 100, 56 800, 17 300, 5 000. Stage "dry" masses are split over the stage's parts
  (M-1 150 000 = tank 114 700 + 9 engines x 3 200 + interstage 5 500 + retro pack 1 000; M-2 48 000 = 33 000 +
  6 x 1 900 + ullage pack 1 000 + interstage 2 600; M-3 11 800 = 9 500 + 1 800 + 2 pods x 250; descent 3 500 =
  2 430 + 350 + legs 420 + separator 100 + RCS propellant 200; ascent 1 500 = 1 050 + 120 + adapter 80 + RCS
  propellant 250; capsule 5 000 = 4 590 + apex cover 60 + RCS propellant 150 + ablator 200; LES 4 000 = 3 700 +
  jettison motor 300).
- Tank capacities follow the mixture ratio exactly (LOX/CH4 3.6, LOX/LH2 6.0), so both propellants of a stage
  run out together. Solid propellant masses are thrust x time / (Isp g0).
- Launch clamps (4 x 6 t) are ground structure: excluded from the flight mass while they hold.
- Stage delays (`TimedStageAction.delay`, seconds after the press): M-1 separation - ullage 1.7, retro +
  decouple 2.0, Vela-2 ignition 3.5; M-2 separation - decouple 1.5, Vela-2V ignition 3.5; M-3 separation -
  decouple 1.5, evasion burn + Lyra-D armed 2.0; lunar lift-off - bolts + Lyra-A 0.7; capsule separation 0.8;
  drogues 0.4 after the apex cover; mains 0.5 after the drogue cut. The waits let the shut-down engines tail off
  before the joint opens.
- The M-3 evasion burn is a 3 s fixed-burn `engine` module on each RCS pod (600 N, fed from the pod's
  RCSProp, plume `plume.rcs`, sound `rcs.thruster`). M-3 ullage is not simulated as thrust; stage 4 arms the
  pods' RCS instead (the stack needs them to hold attitude in the parking orbit).
- RCS modules are armed (`rcs.enabled`) by `enableRcs` stage actions - M-3 pods at stage 4, lander quads at
  stage 5, capsule at stage 8 - and fire only while the vessel-level RCS switch is on (`enableRcs` also turns it on).
- The generator script used to author the JSON is not in the repository; the JSON files are the source of truth.

---

## 5. Acceptance: measured

Machine was under load from the data bakes; timings are provisional (rule 16).

| Criterion | Result |
|---|---|
| Stack mass 2 756 100 +- 100 | 2 756 100.00 kg; every intermediate stack mass of 13.1 to 0.01 kg |
| Tsiolkovsky delta-v = 13.2 table within 1 m/s | M-1 3 493.2 vac / 3 263.6 at 1 atm, M-2 6 196.9, M-3 3 555.2, descent 3 546.6, ascent 3 407.9 (each within 0.01 m/s of independent arithmetic); burn times 160.8 / 419.2 / 376.8 / 635.5 / 626.6 s |
| Lift-off TWR 1.30 | 1.297 at local g (1.2986 with g0); flown: clamps release 3.00 s after ignition, 1.30 g |
| Thrust / Isp vs pressure | Atlas-9M 3.90 MN / 327 s at 1 atm, 4.174 MN / 350 s vacuum, linear between |
| Clamp release only above the threshold | 50 % lever (26 MN < 1.1 W): clamps stay, engines shut down, stage re-armed; 100 %: released at T+3.0 s |
| 10 stages fire in order with events, vessels, debris | `staging.test.ts`, one test per stage (spawned part sets listed there) |
| Momentum conserved to 1e-6 | each separating action on a tumbling, moving vessel: linear momentum to < 1e-6 relative, mass to 1e-12; angular momentum to 1e-9 for a split without impulse |
| Separation clearance, positive within 0.5 s and for 30 s | all pairs of all stages; positive from / minimum after 0.5 s: clamps 0.01 s / 0.30 m; M-1 vs Vela-2 bells 0.28 s / 0.99 m; tower 0.39 s / 2.17 m; petals vs stack 0.34 s / 0.68 m; petals vs tower 6.3 m; petal vs petal 3.25 m; M-2 0.30 s / 0.28 m; M-3 0.01 s / 0.28 m; descent stage 0.01 s / 0.13 m; ascent stage vs capsule 0.13 s / 1.31 m; apex cover 0.01 s / 6.5 m. Every minimum is at 0.5 s (the gaps only grow). |
| Capsule trim 15-20 deg, L/D 0.26-0.34 at Mach 10, stable shield-first | alpha 18.73 deg, L/D 0.279; one stable equilibrium over the full circle; released 30 deg off apex-first it turns shield-first |
| Terminal velocity 7.9 +- 0.3 on three mains, 9.7 on two | within 0.05 m/s of sqrt(2 m g / (rho (n 420 + 11.3))) = 7.89 / 9.65 m/s at 4 940 kg |
| Chute destruction outside the envelope | drogue at Mach 1.5 and mains at 150 m/s fail (`chuteFailed`); in-envelope deployment inflates through the reefing stages |
| Sutton-Graves and radiative flux | 472.2 kW/m^2 (rho 3e-4, 7 km/s, Rn 4.8 m); 3.25 MW/m^2 radiative at 11 km/s; zero below 9 km/s |
| Leg drop tests 1 / 3 / 5 m/s on 0 / 10 / 20 deg | 1 and 3 m/s land on all three slopes (asleep after 2.5-13.5 s, max tilt 35 deg on the 20 deg slope), 5 m/s collapses the gear on all three |
| Static tip-over near 40 deg | **37.7-37.9 deg** (rigid geometry 38.8 deg; strut compliance takes a degree) - see deviations |
| Lander rests without jitter, asleep within 5 s | asleep 2.5-3.7 s after a flat touchdown; < 2 mm of motion before sleep; fixed to 1e-6 m in the body frame over 600 s on a rotating body |
| Capsule floats upright, about 55 % reserve, self-rights from 120 deg | reserve 55.5 %, list 9.6 deg (CoM offset), self-rights from 120 and 175 deg within 40 s, rides the shared swell |
| SAS 90 deg, < 20 s, < 5 deg overshoot | settle (< 1 deg) / overshoot: full stack on M-1 8.6 s / 0; M-3 stack burning 7.9-8.1 s / 0; lander stack burning 8.1-8.2 s / 0; ascent stage coasting 12.2 s / 0; capsule 7.9-8.0 s / 0. For the record: M-2 stack 12.1 s; lander stack coasting on RCS + CMGs 22.0 s; **M-3 stack coasting on its two RCS pods 73.8 s** |
| SAS under aero torque (entry from 122 km, 11.0 km/s, -6.5 deg) | RCS propellant used by drogue deployment 7.1 % (limit 60 %); longest pitch/yaw thruster saturation 0.68 s (limit 2 s); peak 6.87 g; g-dose 0; alpha 19.0 deg at peak q (22.8 kPa) with the pitch hold fully released; 180 deg bank reversal at peak q 6.1 s; ablator left 66.6 %; peak flux 3.22 MW/m^2; then drogues, mains, splashdown at < 9.5 m/s, floating upright |
| q-alpha overload breaks the stack | 9 deg at 30 kPa: `jointBroken` at `interstage-2`; 3 deg: intact |
| Overheating destroys an unshielded part | lander without fairing at 5 km/s in 3e-4 kg/m^3: descent stage destroyed by `overheat`; same flight inside the fairing: no temperature rise; bare shield burns through in 5-25 s at 10 km/s |
| Capsule equals the mould-line file | bounds, shield diameter / apex / curvature, aero reference, seats, hatch, attach nodes (`data.test.ts`) |
| public.ts without an environment | `facade.test.ts`, including all ten `splitForStage` steps and the FakeSim |
| Determinism | two runs of a 40 s scripted chaos flight (staging, aborts, toggles, 10+ vessels): identical hash |
| Fuzz | three seeds x 60 s of random controls, stage presses, aborts and toggles from the pad over bumpy terrain: no NaN |
| One step of the full stack < 80 us | 16-24 us (38 parts, nine engines burning, SAS on, in atmosphere at max-q); best batch of seven is asserted |

Additional integration check (`ascent.test.ts`): the stack flown from the pad with the pitch programme of
sim-design 16.2 on SAS direction hold - max-q 28.0 kPa at 9.9 km, max q-alpha 510 Pa rad, 3.84 g at M-1 burnout
159 s after lift-off at 74 km and 2 090 m/s, staging, tower + fairing jettison at 96 km, hottest skin 48 % of
its limit, nothing broken.

---

## 6. Deviations and known weaknesses

Deviations from sim-design section 13 / the brief, with reasons:

1. **Landing gear pad circle 6.8 m radius instead of 4.6 m.** sim-design 9.3 assumes the CoM 3.9 m above the
   pads; with its own stage dimensions (direct ascent: a 3.4 m descent stage under a 3.6 m ascent stage under
   the capsule) the CoM at touchdown is 6.0 m above the pads. With 4.6 m pads that is 28 deg by geometry, and
   in simulation the lander was not stable on a 30 deg slope and failed the 3 m/s drop test already on the
   10 deg slope (measured by regenerating the data with 4.6 m). 6.8 m gives 37.8 deg in simulation - "near 40"
   but below it - and passes every drop test. The ring heights (adapter 0.6 m, separator 0.3 m) were kept
   small for the same reason.
2. **Engine bells are recessed.** The Vela-2 bells stand 0.6 m and the Vela-2V bell 0.4 m below their stage's own
   aft skirt; Lyra-D and Lyra-A exits are flush with their stage's base. Deeper nesting cannot leave a
   solid-cylinder interstage envelope within 0.5 s with the impulses of 13.3.
3. **Lift direction is body -Z**, the side of the CoM offset, by the force model of 8.2 itself (and trim needs
   the offset -0.171 m on the dry capsule, 0.157 m on the loaded one, with the CoM 0.49 m above the shield plane).
4. **q-alpha limit 3 500 Pa rad**, not 60 000 (request file).
5. **LES solid propellant 1 260 kg + 153 kg**, not 2 300 kg: 800 kN for 3.5 s at Isp 250 s burns 1 142 kg (1 260
   with the 25 deg nozzle cant); the rest of the 4 000 kg is inert.
6. **Stage timing**: decouplers fire 0.7-2.0 s after the press (list in section 4) so that the engines being
   shut down have tailed off. Separation impulses beyond 13.3: stage separator 5 kN s, fairing 9 kN s per petal,
   tower spring 0.5 kN s, apex cover 0.3 kN s.
7. **Capsule = one part** carrying command, heat shield, RCS, wheels and both parachute modules (the
   `deployParachute` action selects by mode), plus a separate `apex-cover` part that stage 9 jettisons.
8. Overall height 108 m instead of "about 106".

Known weaknesses:

- **No vessel-vessel contact** (by design). Clearance is proven for the nominal condition of each stage only.
  Firing the lunar lift-off stage in flight with Lyra-D at thrust, or separating at large rates, is not covered;
  the descent-stage margin at 0.5 s is 0.13 m even nominally.
- **M-3 stack coasting slews slowly** (74 s for 90 deg on two pods of 4 x 600 N); the lander stack coasting needs
  22 s. Under thrust both are 8 s. The acceptance list was met with the stacks under thrust.
- **Bank reversal is helped by an aerodynamic rolling moment** from the offset CoM in sideslip (6.1 s, where RCS
  alone would need 8-9 s). It follows from the capsule force model; it has not been compared with flight data.
- **The capsule is monostable**: entering apex-first it turns shield-first within seconds instead of burning
  (sim-design 10.1 expected destruction). An ablator-less or tumbling entry still destroys it.
- **Abort**: the escape motor pulls the capsule clear (9 g, 150 m in 3.4 s, tested at 9 km), but there is no
  pitch-over motor or canards and the tower + capsule aerodynamics are one axisymmetric element; an abort at
  max-q has not been examined for attitude behaviour.
- **Aerodynamics of the stack are cross-flow only** (no linear lift slope), exposure is a radius ratio, and a
  capsule mated to a stack is a plain nose.
- **Clearance query**: cylinders are exact; a fairing panel is a sampled thick sector (0.9 m grid), conservative
  toward the inside, and its distances carry up to about half a grid cell of sampling error.
- **Floating list 9.6 deg** from the CoM offset; the linear water damping is a stand-in, not a hydrodynamic model.
- **Heat-shield use on the nominal entry is 33 %** (design text expected 38-47 % with the un-derated radiative
  term); peak flux 3.2 MW/m^2.
- Explosions push but do not heat neighbours; one acceleration limit per joint (no separate lateral limit).
- `rcsPulse` is emitted at most every 0.25 s per RCS part while firing starts, not per thruster pulse.
- Timings were taken while the bakes were running.
