# Codebase audit against the expanded scope (v2 research)

Audit of the code and contracts as they stand in the working tree on 2026-11-10 (wave 1 finished, wave 2
running; `src/sim/world/sim.ts` at commit 89723cf, `src/app/main.ts` still a 78-line shell that only clears the
canvas). Scope audited: `src/core/contracts/*.ts`, `src/core/defs`, `src/sim/**`, `src/pilot`, `data/defs/**`,
the hand-offs of sim-orbits, sim-vessel, flight-ui, map-view, terrain-core, render-core, audio, and the
presentation packages where they read the simulation. Every number marked *measured* comes from scratch
benchmarks written for this audit (not in the repository; method in section 1).

Depth of an assumption is graded: **comment** (text only), **data** (a definition file), **type** (a contract
shape that consumers compile against), **algorithm** (logic that must be rewritten).

---

## 0. Verdict

**What survives unchanged.** The two lower simulation layers are clock-agnostic, player-agnostic pure code:
`src/sim/orbit`, `src/sim/frames`, `src/sim/bodies`, `src/sim/nav` (functions of state and `ut`) and
`src/sim/vessel`, `src/sim/dynamics`, `src/sim/control` (`stepVessel(vessel, env, controls, dt)`, one call per
vessel, the clock passed in). Neither knows an active vessel, a warp level, a scenario or a player. They run in
Node today (the mission tests do it) and cost 3-9 microseconds per vessel-step.

**What does not survive.** Everything that binds those layers into "one player flying one prescribed mission in
a local world" lives in three places: the `World` class (`src/sim/world/sim.ts`, 2,531 lines), the `Sim` /
`SimSnapshot` / `PlayerCommands` contracts, and `ScenarioDef`. That is where one active vessel, one clock, one
warp index, one site, one vehicle, one milestone list and synchronous in-process commands are welded together.
It is an orchestrator, not physics; it is the part to rebuild.

**Decisions this audit supports**

1. **Keep `stepVessel` and the orbit/body libraries as the authoritative physics on the server, unchanged in
   numerics.** One core carries roughly 1,000 full launch stacks or 2,600-3,200 coasting/manoeuvring craft
   at 120 Hz on this machine; vessels on rails cost nothing between events (section 3.3).
2. **Do not design netcode that needs bit-identical client and server.** Measured: Node 24 and the installed
   Chrome 157 return different last bits for 15 of the 17 transcendental `Math` functions the sim calls
   (section 3.1). Server-authoritative state with tolerant client prediction is the only option that works
   with the code as it is; exact cross-runtime determinism would need a deterministic math module first.
3. **Replace the `World` orchestrator by a universe of vessel groups, each with its own clock, and make
   "active vessel" a per-connection notion.** The per-vessel layers already take `ut` and `dt` as arguments, so
   per-group time is possible without touching them (section 2.2).
4. **Keep `SimSnapshot` as the presentation contract and produce it on the client** from replicated vessel
   state plus locally computed derivations. Patches, readouts, navball, staging delta-v, body ephemerides and
   rails propagation are pure functions that already run in the browser; the server never needs to compute or
   send them (section 6). Patch prediction alone costs more per player than stepping the player's vessel.
5. **Change the vessel model from "parent-indexed tree owned by one VehicleDef" to "part graph with explicit
   joints and vessel-owned staging"** before docking is attempted. Docking, the stage stack of an assembly,
   propellant flow and universe-unique ids all fail on the current shape (section 4). The same change is
   what a KSP-style builder needs, so it is not extra scope.
6. **Re-root the body system at the Sun, but do not make ROOT heliocentric for rendering or for proximity
   physics.** The existing body system, predictor and world ran a 30-body, three-level, Sun-rooted library
   unmodified in this audit (section 5). What breaks is precision: a heliocentric float64 position resolves
   0.03 mm at Earth and 1 mm at Neptune.

**Facts a designer must not miss**

- `Vessel.struct` is called a cache but holds state (per-probe friction anchors, thermal wake factors).
  Dropping it, which `cloneVessel` and any save/load do, changes the future: *measured* a resting place
  7-19 mm away for a lander copied while it settles, and part temperatures that do not re-converge.
- JSON loses `Infinity` (three `Vessel` fields use it as a sentinel) and the sign of zero.
- A vessel's id is its vehicle's id (`emptyVessel(vehicle.id, ...)`), and part instance ids are unique only
  within one `VehicleDef`. Two players choosing the same rocket collide on every id in the system.
- A full-tier vessel "on rails" still runs `stepVessel` every step; only vessels outside the physics bubble
  are free. A landed, sleeping vessel in the bubble costs as much as a coasting one.
- The predictor has a 60-day horizon measured from the start of the chain: an interplanetary encounter
  later than that gets a zero-length patch with no periapsis (*measured*, section 5.4).
- The server needs the height tiles (7.2 GB Earth + 2.2 GB Moon) if it is to adjudicate landings.
- Presentation packages read `activeVesselId`, `readouts`, `navball`, `staging`, `patches` as singletons in
  about 190 places across 28 files; keeping the snapshot shape keeps all of that code.

---

## 1. Method

- Reading: every file listed in the header, plus greps across `src/` for the assumptions in question.
- Machine: AMD Ryzen 9 9950X3D (16 cores / 32 threads), Windows 11, Node v24.16.0 (V8 13.6.233.17), Chrome
  157.0.8103.50. Wave-2 GPU test jobs were running; CPU slots of the heavy-job gate were free. Benchmarks ran
  through `node tools/dev/heavy.mjs --class=cpu`, single thread. Run-to-run spread was 10-30 %.
- Benchmark 1 (cost): the real `stepVessel` on vessels of the existing fleet (`meridian-lunar` at different
  `stagesAlreadyFired`), with the real body system's environment (`orbitalEnvironment`: USSA-76 atmosphere,
  rotation, heating) and a flat stand-in for the terrain; then the real `createSim` world with the
  `flatTerrain` fixture of `tests/unit/sim-world/helpers.ts`. Warm-up steps discarded; every case checked
  for a live vessel, the expected thrust and the expected events. The terrain authority's own cost is not in
  these numbers (terrain-core measured it: cached collision query 0.05 us, first query in a fresh area
  median 11-13 us, max about 0.2 ms).
- Benchmark 2 (state): JSON round trips of stepped vessels compared by `vesselStateHash` and by trajectory;
  two runs of a 200 s ascent through the world compared by `stateHash()`; float64 spacing at solar-system
  distances; an in-memory Sun-rooted library of 30 bodies (8 planets, Pluto, Ceres, 19 moons) run through the
  unmodified `createBodySystem`, `predictPatches` and `createSim`.
- Benchmark 3 (determinism across runtimes): 40,000-300,000 evaluations per `Math` function in Node and in
  Chrome (Playwright, `channel: 'chrome'`), results compared bit for bit.

---

## 2. Assumption inventory

### 2.1 One player, one active vessel

| Where | What | Depth |
|---|---|---|
| `src/core/contracts/sim.ts` `SimSnapshot` (l. 513-564) | `activeVesselId`, `appliedControls`, `navball`, `readouts`, `staging`, `patches`, `nodes`, `terrain`, `mission`, `milestones`, `warp`, `cheatCounter` are singletons of "the" player | type |
| same, `Readouts` (l. 322) | "Active vessel only" | type |
| same, `Sim` (l. 592-637) | `setControls(inputs)` and `commands` take no vessel or player; `snapshot()` "called exactly once per presented frame" and drains the one event queue | type |
| `src/core/contracts/controls.ts` `PlayerCommands` (l. 71-93) | no subject; `cycleActiveVessel` moves the single focus; results are synchronous `CommandResult`s and `addNode` returns the new id synchronously | type |
| `src/sim/world/sim.ts` `World.active` (l. 259), `controls` (l. 279), `nodes`, `burn`, `targetBodyId`, `navballMode` (l. 280-285) | one set of player state on the world | algorithm |
| `World.stepFull` (l. 869) | `stepVessel(v, env, isActive ? this.controls : NEUTRAL_CONTROLS, dt)`: every vessel but one flies with neutral controls | algorithm |
| `World.mustIntegrate` (l. 773) | throttle and RCS translation keep only the active vessel integrated | algorithm |
| `World.upkeep` (l. 1155-1205) | fidelity tiers are a function of distance from the active vessel: one physics bubble (`BUBBLE_RADIUS` 25 km) | algorithm |
| `World.boundaryWork` (l. 1011), `terrainPolicy.ts` slot `'impact'` | impact-point terrain request and collision pre-warming for the active vessel only | algorithm |
| `World.compact` (l. 1246) | when the active vessel dies the focus is handed to a surviving piece (controllable first, else heaviest); `wreck` snapshot | algorithm |
| `World.crewAlive`, `failMission` (l. 950, 980) | any crew loss on any vessel fails "the mission" | algorithm |
| `src/sim/world/milestones.ts` | one evaluator fed from the active vessel | algorithm |
| `Vessel.crewAlive`, `Vessel.gDose` (`src/sim/vessel/types.ts` l. 172-173) | crew health is one flag per vessel, not per seat or per command part | type (internal) |
| `src/core/contracts/render.ts` `'env.probeCube'` ("at the active vessel"), `OCEAN_WETNESS_SLOTS = 8`, `src/core/contracts/audio.ts` `AudioListener.positionVes` ("in the active vessel's VES frame") | presentation keyed on one focus vessel | type |

How deep: the two lower sim layers contain no trace of it (`stepVessel` receives its controls; `needsIntegration`
reads the vessel's own `appliedControls`). The whole assumption lives in `World` and in the snapshot shape.
From a client's point of view "the active vessel" remains a correct notion (the craft this client flies), which
is why the snapshot shape can stay while its producer changes.

### 2.2 One global clock, one warp

| Where | What | Depth |
|---|---|---|
| `World.ut`, `utBase`, `stepsSinceBase`, `lag` (l. 264-276) | one clock for every vessel; `step()` advances all entries by `PHYSICS_DT`, `advanceRails(targetUt)` moves all entries to one time | algorithm |
| `World.warpIndex`, `refreshWarp` (l. 1488-1554) | one warp index; limits derived from the active vessel's altitude, events and rotation | algorithm |
| `World.bubbleMustIntegrate` (l. 782) | rails warp is refused for everyone while any full-tier vessel needs integration | algorithm |
| `World.setControls` (l. 1825), `commands.stage` (l. 1839) | a control input or a staging press drops the world out of rails warp | algorithm |
| `World.advance` (l. 1422) | physics warp = more steps per frame for the whole world | algorithm |
| `src/core/contracts/defs.ts` `WARP_LEVELS` (l. 613), `BodyDef.warpAltitudeLimits` | fixed table of 11 levels, 100,000x maximum; every attractor must list exactly seven altitude limits (`RAILS_WARP_LEVEL_COUNT`, checked in `bodySystem.ts` l. 147) | type + data |
| `SimSnapshot.warp`, `SimEvent 'warpChanged'`, `PlayerCommands.setWarpLevel` | one warp state in the contract | type |
| `AudioFrame.warpFactor`, terrain LOD cap under warp (ARCHITECTURE 7.3) | presentation reads one factor | type |

How deep: this is exactly the "global warp control that makes everyone else's flight unplayable" the brief
forbids, and it is algorithmic in `World`. Below `World` nothing assumes a shared clock: `stepVessel` takes
`env.ut` and `dt`; `propagate(orbit, t)` takes `t`; body states are functions of `ut`; `VesselEnvironment`
"describes the START of the step it is passed to". Vessels that interact must share a clock; vessels that do not
need not. The maths of warp (`src/sim/orbit/warp.ts`: altitude caps, look-ahead, `nextWarpEvent`) is pure and
reusable per group. The clock precision device (`utBase` + whole steps, `OrientationCache`) must move with the
clock to whatever owns it.

### 2.3 Two bodies, Earth at the origin

| Where | What | Depth |
|---|---|---|
| `data/defs/bodies/` | three files: `earth` (root, `parent: null`), `moon`, `sun` (`parent: "earth"`, `gravityRole: "lightOnly"`, orbit `sunLowPrecision`) | data |
| `defs.ts` `SunLowPrecisionOrbitDef`, `ephemeris.ts` `SunLowPrecisionEphemeris`, `bodySystem.ts` l. 128 | a geocentric Sun that has no gravity; "defined relative to the root body only" | type + algorithm (small) |
| `bodySystem.ts` l. 107-109 | exactly one body with `emission` | algorithm (small) |
| `sim.ts` contract header, ARCHITECTURE section 3 | "ROOT: inertial frame centred on the root body (Earth)" | comment, but see precision |
| ARCHITECTURE section 4 | "Vessel state is relative to its SOI body (\|r\| < 4.5e8 m gives 6e-8 m resolution), so the physics needs no origin shifting" | comment; false in the Sun's SOI |
| `VesselSnapshot.rRoot/vRoot`, `BodySnapshot.rRoot`, `CameraState.positionRoot`, `LodObserver.positionRoot`, `Patch.bodyPosAtEnd`, `SimEvent 'explosion'.posRoot` | absolute float64 ROOT positions handed to presentation | type |
| `World.buildReadouts` (l. 2271) | the launch-window readout exists only "while landed on the root body" | algorithm (one line) |
| `src/sim/orbit/patches.ts` `DEFAULT_HORIZON` (60 d), `DEFAULT_MAX_PATCHES` (8) | sized for a three-day transfer | algorithm (constants + one rule) |
| `src/camera` `MAP_MAX_DISTANCE = 2e9` m; map azimuth "about ROOT +Z" | the map cannot zoom out past 5 lunar distances | algorithm (constant) |
| `src/pilot/missionPilot.ts` (`rootId`, l. 125-1282) | the scripted pilot reasons about "the root body" as Earth | algorithm (test tool) |
| `MilestoneId` (`sim.ts` l. 433) | Earth/Moon vocabulary, typed "for the mission tests" | type (test vocabulary) |

Engine code is clean of ids: a grep for `'earth'`, `'moon'`, `'sun'`, vehicle, part and site ids outside tests
finds only `src/map/testing` and two decal strings. The hierarchy code is generic in depth (`stateRoot` walks
parents; `childIds`; SOI entry/exit by parent/child). Section 5 shows it running three levels.

### 2.4 One site

| Where | What | Depth |
|---|---|---|
| `ScenarioDef.site` (required), `World` constructor (l. 340), `placeStartVessel` (l. 458), `removeEntry` (l. 992, debris distance "from the scenario's launch site") | the world knows one site | type + algorithm |
| `src/sim/nav/surfaceTargets.ts` | targets = one landing + one site + that site's recovery zones | algorithm |
| `LaunchSiteDef` | one `location`, one `pad` per site | type |
| `data/defs/sites/` | one site; the Earth bake has one high-resolution region (100 km around Ka Lae) | data |
| `terrainPolicy.ts` slot `'pad'` | one pad disc | algorithm (small) |

Not assumed: `src/terrain/provider.ts` (l. 97), `src/render/terrain/feature.ts`, `src/render/vehicle/siteFeature.ts`
and `src/render/vfx` iterate `Object.values(defs.sites)`. More pads are data (more `LaunchSiteDef`s inside the
baked region, or more region bakes). Nothing models pad occupancy, a launch queue or a spawn handshake.

### 2.5 One vehicle; a vessel is an instance of a vehicle

| Where | What | Depth |
|---|---|---|
| `data/defs/vehicles/` | one vehicle, `meridian-lunar` (42 parts, 10 stages, 25 part defs made for it) | data |
| `ScenarioDef.vehicle`; `World.placeStartVessel` (l. 452) | the world is created around one vehicle | type + algorithm |
| `src/sim/vessel/assemble.ts` `buildVehicle` (l. 212) | `emptyVessel(vehicle.id, vehicle.name, vehicle)`: vessel id = vehicle id | algorithm |
| `src/sim/vessel/split.ts` (l. 153) | separated pieces are `<base id>~<root part instance id>`; `src/render/vehicle/vesselFeature.ts` keys presentation state on `rootOf(vessel.id) + '\|' + instanceId` | algorithm on both sides |
| `Vessel.vehicle: VehicleDef` (`types.ts` l. 133) | every vessel, debris included, carries one vehicle definition: its stage stack (`vessel.vehicle.stages` in `staging.ts`, `facade.ts` `stagingInfo`), abort sequence, stage-group labels | type (internal) + algorithm |
| `VesselSnapshot.vehicleId`; `PartSnapshot.instanceId` "unique within the original vehicle" | consumers look up `defs.vehicles[vehicleId]` for the cockpit seat (`src/camera/cockpitRig.ts`), chase distances (`chaseRig.ts`), HUD (`src/ui/model.ts` l. 298), engine clusters (`vesselFeature.ts` l. 196), cockpit interior (`src/render/cockpit/feature.ts` l. 145) | type |
| `VehicleDef.cockpit` (interior layout id), `VehicleDef.cameras.cockpit {part, seat}`, `VehicleDef.crew` | interior, eye point and crew belong to the vehicle, not to the command part | type |
| `VehiclePartPlacement.stageGroup`, `structure.ts` `tanksFor` (l. 316) | propellant flows between parts that carry the same hand-written group string | type + algorithm |
| ARCHITECTURE 17.1 | GPU budget lines for one vehicle (0.8 ms G-buffer; LOD0 of the stack is 1.0-1.6 M triangles) | budget |

How deep: the fleet itself is data (new part and vehicle files). The identity and ownership model is the
problem: ids, the stage stack and the flow groups all hang off a single `VehicleDef`, which a docked assembly
of two craft does not have.

### 2.6 A prescribed mission

| Where | What | Depth |
|---|---|---|
| `ScenarioDef` (`startUt`, `start`, `stagesAlreadyFired`, `target`, `suggestedLanding`, `milestones`) and `createSim(defs, scenarioId, ...)` | a world is one scenario with a fixed start epoch | type |
| `SimSnapshot.scenario`, `.milestones`, `.mission {failed, failureReason, crewAlive}` | the snapshot reports a mission | type |
| `World.failMission`, `'missionFailed'` event | a mission can fail | algorithm |
| `data/defs/scenarios/lunar-direct.json` `startUt = 938240818.84` | the epoch was searched so that one pad is coplanar with the Moon's orbit and both Suns are right (ARCHITECTURE row 28) | data |
| ARCHITECTURE row 9 | "Direct ascent ... no rendezvous/docking" | decision |
| `src/pilot/missionPilot.ts` (1,538 lines), `tests/mission/**`, `MilestoneId` | the acceptance flight | test tooling |

How deep: the milestone evaluator is already generic and data-driven; it is a per-vessel observer that can stay
as an optional layer (the original Earth-Moon-return proof still needs it). What must go is the identity
"world = scenario". In a persistent universe the scenario becomes at most a spawn recipe plus an optional
objective list attached to one vessel.

### 2.7 A local-only world

| Where | What | Depth |
|---|---|---|
| `Sim` contract | synchronous, in-process: `advance(realDt)`, `snapshot()`, commands returning results | type |
| ARCHITECTURE section 5 and row 15 | "The snapshot is the only thing that flows from the simulation to presentation"; simulation on the main thread | decision |
| `Sim.advance` / `snapshot()` interpolation (row 23) | presentation time = local sim time minus a sub-step lag | algorithm |
| `Sim.debug`, `cheatCounter` | in-process cheats counted locally | type |
| `Sim.ready` / `terrainPending()` | determinism protocol for one process and one terrain provider | type |
| `World.entries`, `MAX_DEBRIS = 24`, `FRAGMENT_LIFETIME`, `vesselRemoved` reasons `'expired' \| 'limit'` | a small in-memory vessel list with a debris cap measured from the active vessel | algorithm |
| no persistence anywhere | `stateHash()` exists; no serialiser, no loader | missing |
| `World.upkeep` proximity rule (l. 1206-1220) | O(n^2) over full-tier vessels; `World.step` loops over every entry every step | algorithm |

The app loop that would use all this (`src/app`) is not written yet, so nothing downstream of the contract has
to be undone there.

---

## 3. The sim as an authoritative server in Node

### 3.1 Determinism

**Within one runtime: holds.** Two in-process runs of a 200 s ascent with staging through `createSim` gave the
identical `stateHash()` (*measured*). The mission tests assert the same against a golden hash and a replayed
input log. Structural reasons: fixed step, array-order iteration, insertion-ordered `Map`s, sorted body ids
(`sortIds`), sorted keys in the hashers, no clock or `Math.random` under `src/sim` (enforced by
`tools/dev/boundaries.test.ts`; the one `Math.random` hit in the tree is a comment). Terrain is the only
asynchronous input and has its await protocol.

**Across runtimes: does not hold.** The sim calls 17 transcendental function families (count of call sites in
`src/sim`, `src/core/math`, `src/core/geo`, `src/terrain`: sin 59, cos 51, atan2 41, hypot 39, log2 27, exp 13,
acos 9, pow 8, asin 7, log 4, atanh 4, tan 3, sinh 3, cbrt 3, cosh 2, atan 2, acosh 1). ECMAScript leaves their
results implementation-defined. *Measured*, Node 24.16 (V8 13.6) against Chrome 157 on this machine, same
inputs:

| Function | Results that differ | Largest difference |
|---|---|---|
| sin, cos, tan | 3.3-3.6 % | 1 ulp |
| atan, asin, acos | 6.0-7.7 % | 1 ulp |
| atan2 | 17.6 % | 1 ulp |
| exp, cbrt, atanh | 7.4-9.5 % | 1 ulp |
| sinh, cosh | 8.8-9.6 % | 2 ulp |
| log, acosh | 0.6-0.7 % | 1 ulp |
| log2 | 0.02 % | 1 ulp |
| pow, `**`, hypot, sqrt, plain arithmetic | 0 | identical |

Consequences: a client running the same TypeScript cannot reproduce the server bit for bit, so lockstep, input
replay as the wire format, and hash comparison between client and server are out. Prediction error from this
source starts at 1e-16 relative and is negligible next to latency; snapshots correct it. Server replays and
golden hashes are tied to the V8 build (a Node upgrade can change them); whether x64 and arm64 builds of one
V8 agree was not tested. If exact cross-runtime agreement is ever wanted (client-computed physics verified
by the server, or shipping inputs instead of state), the route is a deterministic math module: plain arithmetic
and `Math.sqrt` are exact everywhere, so own implementations of the 15 differing functions, used through about
230 call sites, would give it. That is a contained change, not a rewrite, and it is optional.

Other determinism notes:

- Module-level scratch state (`integrator.ts` l. 47-58, `massProps.ts` accumulators, `contactOut`, `aeroOut`,
  `sasOut`, `actuatorOut`, Stumpff globals in `kepler.ts`, `R_`/`V_` in `events.ts`) makes the code
  non-re-entrant. Fine for one thread per isolate; a multi-core server needs one isolate (worker thread or
  process) per shard, each with its own `DefLibrary`, and vessels move between shards by value.
- `World.step` order = `entries` order = creation order. A universe that merges and splits groups needs a
  defined order (e.g. by vessel id) or the result depends on arrival order.
- Terrain: the result of a contact step depends on which data level is resident. The await protocol makes
  that reproducible for one process; a server either holds the await (stalling the group) or accepts
  `incompleteQueries`.

### 3.2 Serialisability

`Vessel` (`src/sim/vessel/types.ts`) is plain data with three exceptions, all *measured* by round-tripping
stepped vessels through JSON and continuing original and copy side by side:

| Issue | Evidence | Effect |
|---|---|---|
| Definition objects inside the state: `Vessel.vehicle` (a `VehicleDef`), `PartRuntime.def` (a `PartDef`) | a naive `JSON.stringify` inlines them | must be written as ids and re-linked on load |
| `Infinity` sentinels: `sinceStaging`, `groundClearance`, `airborneTime` | become `null` in JSON | a loaded vessel mis-evaluates `needsIntegration` unless the codec tags non-finite numbers |
| Negative zero (`rt.cmdX`, `mp.inv[k]` seen) | JSON writes `0` | `vesselStateHash` differs after load although the trajectory is bit-identical for 6,000 steps |
| `Vessel.struct` (the `Structure` of `structure.ts`) holds state that is not derived: `Probe.hasAnchor/ax/ay/az` (stick-slip friction anchors), `ThermalRef.wake` (refreshed every 8 steps; 0.03 or 1), `BuoyRef.wet`, probe contact flags | a lander copied 60 or 150 steps into a touchdown (four anchors live; in-memory `cloneVessel`, no JSON involved) diverged from the next step, by up to 26.7 mm and 9.8 mm, and came to rest 18.7 mm and 7.1 mm from the original; copied before any anchor existed it stayed identical. A copied vessel in atmospheric flight has different part temperatures from the next step on (23 values after one step) and had not re-converged after 4,000 steps | save/restore and rollback are not exact; `cloneVessel` (used by `separateVessel` at every staging) silently resets wake factors |
| Asleep or coasting vessels | round trip exact (hash equal at load, no divergence in 1,200-6,000 steps) | the common persistent states are already safe |

Sizes (*measured*, dynamic state as JSON with definitions by id): 22.4 kB for the 38-part stack, 6.9 kB for the
9-part lander stack, 3.9 kB for the capsule. Live heap per assembled vessel: 375 kB (42 parts) and 87 kB
(9 parts), so ten thousand parked craft must not be kept as live `Vessel` objects with their caches.
`assembleVessel` 0.21-0.26 ms, `cloneVessel` 8-9 us, `vesselStateHash` 42-55 us (38 parts).

World state has no serialiser at all. What a universe snapshot must hold beyond the vessels, read off
`World` and `stateHash()`: per vessel `bodyId`, `mode`, `tier`, the rails `Orbit` (`r0, v0, t0`: 7 numbers
plus the body id, from which everything else is rebuilt by `makeOrbit`), `coastTime`, `reducedUt`; the clock
(`utBase`, `stepsSinceBase`); per player: nodes, burn bookkeeping, target, navball mode; milestone state
(`MilestoneEvaluator.stateForHash()` exists for hashing only); and the id serials. `Entry.env`, `railsEvent`,
`prev*`, patches, stage info and readouts are derived and can be rebuilt.

`SimSnapshot` is plain JSON-safe data except for `Infinity` in `Readouts.apoapsisAltitude` on open orbits. It
is far too large to be a wire format: 32.4 kB for a stack and its launch clamps, 17.0 kB of it for the 38-part
vessel (*measured*), 56-88 us to stringify. Pose and rates of a vessel are 13 float64 (104 bytes). The part
list, def ids and local poses change only at staging, docking or break-up; resources and temperatures change
slowly; only pose, throttle, gimbal and RCS levels change every step.

### 3.3 Cost (*measured*)

`stepVessel` alone, real fleet, mean and p99 per vessel-step in microseconds, and how many such vessels fill
one core at the sim's 120 Hz (8,333 us per step, no headroom):

| Regime | Vessel | mean | p99 | Vessels per core |
|---|---|---|---|---|
| Powered atmospheric flight near max-q, nine engines, SAS | full stack, 38 parts | 8.4 | 15.6 | 990 |
| Powered flight in vacuum, six engines | second-stage stack, 23 parts | 4.9 | 8.1 | 1,700 |
| First-stage separation, retro and ullage motors, two vessels | 26 + 12 parts | 4.9 | 10.8 | 1,700 |
| Coasting but integrated (what every craft near another one costs) | lander stack, 9 parts | 2.6 | 4.1 | 3,200 |
| Proximity operations: SAS + RCS translation | lander stack, 9 parts | 2.9 | 4.3 | 2,900 |
| Atmospheric entry with heating and RCS | capsule, 2 parts | 3.2 | 6.3 | 2,600 |
| Touchdown, contact sub-steps, first 3 s (flat stand-in ground) | lander, 9 parts | 45 | 244 | 180 |
| Settling, next 5 s | lander | 13.7 | 138 | 600 |
| Landed and asleep (still stepped while in a bubble) | lander | 3.5 | 6.5 | 2,400 |
| Reduced tier (debris in atmosphere, one 0.5 s step) | any | 0.35 per step | | effectively free |
| On rails: one Kepler evaluation (`propagateInto`) | any | 0.15 (ellipse), 0.26 (hyperbola) | | 32,000-54,000 if evaluated every step; none needed between events |

The existing world on top of that (`Sim.step()`, one player, flat terrain):

| Case | us per world step | Note |
|---|---|---|
| Pad ascent, first-stage burn (stack + clamp structure) | 14.3-14.5 (p99 51) | world overhead 3-5 us over the vessel step |
| After first staging (stack, spent stage on rails tier, clamps) | 12.3-13.9 | |
| Low Earth orbit, active vessel on rails | 4.7-6.4 | `stepFull` still calls `stepVessel` for a full-tier vessel on rails |
| Low Earth orbit, third-stage burn | 6.9-8.9 | |
| Capsule entry | 7.4-11.3 | |
| Landed, asleep | 3.8-5.2 | |
| `advanceRails` (one call at 1000x) | 5.1-6.7 | |
| `snapshot()` build | 35-42 | per call |
| `step()` + `peek()` every step (what the scripted pilot loop does) | 43-47 | snapshot and patch refresh dominate |
| `predictPatches`, low orbit, no node | 27 | per call |
| `predictPatches`, node through an SOI change | 140 | per call; refreshed at 10 Hz while integrating = 11.7 us per step amortised |
| `vesselClearance` between two 9-part vessels (the existing narrow phase) | 14-24 | per pair |

Reading:

- A server that steps vessels and nothing else spends 3-9 us per integrated vessel-step. With half a core as
  the budget that is about 500 launch stacks or 1,300-1,600 coasting or manoeuvring craft per core at 120 Hz
  on this CPU. A cloud vCPU is slower than a 9950X3D core; the factor was not measured (plan for 2-3x and
  measure in the load test).
- Vessels on rails are event-driven: nothing to do until the stored `railsEvent` time. The count of parked or
  coasting craft is bounded by memory and persistence, not by CPU.
- The expensive things are not physics: building a full snapshot (35-42 us) and predicting patches (27-140 us)
  each cost several vessel-steps. Both are per player, both are pure functions of vessel state, and both
  already run in the browser. A server that kept the current `World` per player would spend most of its time
  on work the client can do.
- Terrain contact is the costliest physical regime (45 us mean, 244 us p99 with a trivial ground; the real
  authority adds first-touch evaluations of up to 0.2 ms) and it is the one that needs data on the server:
  the height layers are 7.2 GB (Earth) and 2.2 GB (Moon) on disk.
- Sleeping craft should leave the stepped set; today they cost a coasting craft each while inside a bubble.

### 3.4 What this means for the client/server split

Facts only; the split itself is a design decision.

| Work | Needs authority? | Cost per player | Runs in the browser today? |
|---|---|---|---|
| Integrating a craft under thrust, drag, contact | yes | 3-9 us per step (45+ at touchdown) | yes (same code) |
| Rails propagation between events | no (a conic from 7 numbers is exact for everyone) | 0.15-0.26 us per evaluation | yes |
| SOI transitions, atmosphere entry, impact, expiry times | yes, but event-driven | one `predictPatches(maxPatches: 1)` per rails hand-over | yes |
| Body positions and orientations | no (functions of `ut`) | 0.5 us (3 bodies) to 8.4 us (30 bodies) per frame | yes |
| Predicted patches, nodes, closest approach | no | 27-140 us per refresh | yes |
| Readouts, navball, staging delta-v | no | part of the 35-42 us snapshot | yes |
| Sun visibility per vessel | cosmetic + thermal environment | 0.42 us (3 bodies), 6.9 us (30 bodies) per call, every 12 steps | yes |
| Terrain collision surface | yes for landings | data: 9.4 GB of height tiles server-side | yes (the client streams the same tiles) |

Because client and server cannot agree bit for bit (3.1), anything computed on the client that the server
must trust has to be either re-simulated with a tolerance or made deterministic first.

---

## 4. The vessel model

### 4.1 What is there

- A rigid assembly: `Vessel.parts: PartRuntime[]` with `parent` indices (parents precede children),
  part poses in the frame of the root part (VES), per-part resources, module states, temperatures.
- `computeMassProps` recomputes mass, centre of mass and inertia from the parts and their propellant every
  step; nothing about it depends on how the parts were joined.
- Splitting is complete and momentum-exact: `separateVessel(vessel, cut, removed, ctx)` (`split.ts` l. 90) cuts
  joints, forms connected components, re-roots each piece (`reRoot`: new origin, velocity of the new origin,
  attitude, SAS target), hands queued stage actions to whichever piece holds their parts, and recomputes mass
  properties. Tested to 1e-6 relative in linear and 1e-9 in angular momentum (sim-vessel hand-off).
- Structural failure reuses it (`dynamics/failure.ts`: `destroyParts`, `jointBroken`, explosions).
- Attach nodes: `PartDef.attachNodes {id, pos, dir, size}`; node-to-node mating with a twist is implemented in
  `childPoseInParent` (`assemble.ts` l. 101); radial placement by explicit `position` / `rotationDeg`.
- A data-driven action system for staging (`StageAction`, `executeAction`, `nextLiveStage` skipping stages
  that can no longer do anything) and action groups (`VehicleDef.actionGroups`).
- Collision geometry per part: `PartDef.bounds` (a cylinder: radius, yMin, yMax, mandatory on every part),
  `contactPoints` (spheres with stiffness, friction, crash tolerance), `buoyancy` spheres, leg hinge/foot
  geometry. `clearance.ts` already turns every part into convex pieces (cylinder; six prisms per fairing
  panel; a deployment-dependent cylinder for legs) and computes signed distance between two vessels with a
  bounding-sphere prune (`vesselClearanceDetail`, 14-24 us for 9 x 9 parts, *measured*).
- Crash tolerances and `destroyParts(vessel, parts, 'impact', ctx)`: the damage path for an impact exists.

### 4.2 Docking: merge and split

| Need | State today | Change |
|---|---|---|
| Merge two part sets into one rigid assembly | `mergeVessels(base, other)` (`split.ts` l. 191) exists for the launch clamps: it re-expresses the other vessel's parts in the base frame and parents them all to part 0. It keeps the base's velocity and spin (momentum of the other is discarded), does not touch stage state, ids, crew or SAS | a momentum-conserving merge: combined centre-of-mass velocity, angular momentum about it including the orbital terms of both pieces, then `w = I^-1 L`; about 40 lines on top of `computeMassProps` |
| Split again with consistent momentum | `separateVessel` does exactly this | cut the docking joint; nothing new |
| A joint between two specific parts | joints are implicit: "part i is joined to `parts[parent]`". Decouplers cut "the joint to the PARENT" (`staging.ts` header, `ModuleDef decoupler`), joint strength is `PartDef.joint` "to the parent" | **explicit joints** (part a, node a, part b, node b, kind). Docking joins two trees at two ports; expressing that with parent indices requires re-rooting one tree, which reverses parent/child along a path and silently changes which joint every decoupler on that path cuts. Two ports mated at once make a cycle, which a parent index cannot express. With explicit joints `separateVessel` becomes connected components of a graph (it already computes components) |
| Docking ports | no `docking` module; attach nodes carry position, direction and size only | a `dockingPort` `ModuleDef` on a node: capture distance, angle and speed limits, state (free, soft, hard), and the id of the joint it made |
| Stage stack of an assembly | `vessel.vehicle.stages`, `vessel.nextStage` (an index into one vehicle's list), `vessel.vehicle.abort` | the stage stack becomes vessel state (copied from the blueprint at assembly, merged on dock, divided by part ownership on undock, the way `pending` already is) |
| Part identity across assemblies | `instanceId` unique within one `VehicleDef`; `findPart` is by that string | universe-unique part ids (craft serial + instance id). Two docked craft of the same type otherwise fire each other's stages and `vesselFeature.ts` mixes their presentation state |
| Propellant flow | engines draw from every tank with the same `stageGroup` string in the vessel (`tanksFor`) | groups must be namespaced per craft at least; better derived from the joint graph (parts connected without crossing a decoupler or a closed port), which is also what a builder needs; crossfeed through a port becomes a port flag |
| Control | one `sas`, `rcsEnabled`, `throttle`, `appliedControls` per vessel; `isControllable` = has any command part; every active engine follows the one throttle | the model already gives an assembly exactly one helm. Who holds it is a rule to choose; per-player engine or RCS ownership would need a mask the allocator does not have |
| Crew | `Vessel.crewAlive`, `Vessel.gDose`, `command.crew` count | per command part (or per seat) before two crewed craft can be one vessel |
| Vessel identity | the piece that keeps the old root part keeps the id (`separateVessel` keeper rule) | identity and ownership should follow the command part and its owner, not tree position |
| Frame | VES = frame of the root part; `reRoot` re-expresses everything when the root changes | fine; an assembly needs a rule for which part is the root (e.g. the helm's command part) |
| Resources, mass properties, aerodynamics, heating | computed from the part list each step or at `rebuildStructure` | work unchanged on a merged list (aero shadowing `coverFraction` assumes one axial stack; it degrades gracefully) |
| Events | `'decoupled'` with `newVesselIds` | add docked/undocked with the merged and resulting vessel ids, for clients and persistence |

Undocking, break-up of a docked assembly and persistence of an assembly follow from the same structure once
joints are explicit: an assembly is one `Vessel` whose parts carry their origin craft.

### 4.3 Vessel-to-vessel contact

Not simulated (ARCHITECTURE row 27; `clearance.ts` exists to prove it is not needed). What the code offers:

- **Shapes from data.** Every part has a bounds cylinder; `partShape` builds world-space convex pieces from
  it. For axial docking the cylinders' end faces sit at the attach nodes (`kestrel-capsule` top node at
  y = 2.85 = `bounds.yMax`), so port-to-port contact is representable. The shapes are coarse where it matters:
  the capsule is a 2.0 m radius cylinder although it is a cone (its real lathe profile is in
  `data/defs/visuals/shared/kestrel-mouldline.json`), engines are cylinders around their bells, and legs are
  one cylinder around all four struts. A `PartDef.collider` (a short list of frustums, cylinders, boxes) is the
  data extension; `bounds` stays the fallback, so no existing part file has to change at once.
- **Narrow phase.** `convexDistance` (alternating projections, then separating-axis overlap) gives distance or
  penetration depth along one axis. It gives no contact point or normal as outputs, and it converges slowly
  for near-parallel faces (the hand-off notes millimetres of error there, which is the docking case). Usable as
  the broad and mid phase; a contact manifold (closest points, normal) has to be written.
- **Response.** Terrain contact is a penalty method on point probes inside `stepVessel`'s four sub-steps
  (480 Hz), one vessel at a time, with forces from the ground only. Two vessels in contact need equal and
  opposite forces evaluated at the same sub-step. `stepVessel` advances one vessel through all its sub-steps
  before the next vessel starts, so the integrator has to be restructured to advance an **island** (vessels
  in mutual proximity) sub-step by sub-step. The force evaluation, `integrateRate`, and the write-back are
  reusable as they are.
- **Fast closing speeds.** There is no swept test anywhere. At orbital crossing speeds a craft moves 60-125 m
  per 1/120 s step, more than most craft are long, and vessels on rails are not stepped at all. Needed:
  (a) conjunction screening for rails pairs in the same SOI (the vessel-versus-body `closestApproaches` in
  `events.ts` is the pattern: sampled distance plus golden section; there is no vessel-versus-vessel
  version); (b) a swept bounding-sphere test per step for integrated pairs (relative motion over one step is
  a straight line to about a millimetre, even under thrust); (c) time-of-impact sub-stepping, or, above the parts' crash
  tolerances, direct destruction through `destroyParts`. `Structure.boundingRadius` is already maintained for
  the sphere tests.
- **Proximity rule.** `World.upkeep` keeps two free vessels integrated when their bounding spheres are within
  `PROXIMITY_DISTANCE` (200 m). That is the seed of island formation, but it is O(n^2) and only inside the one
  bubble.

### 4.4 Fitness for a later ship builder

| Builder concept | Present | Missing or wrong-shaped |
|---|---|---|
| Part catalogue | `DefLibrary.parts`, `PartDef.category`, a procedural visual per part def (`PartVisualDef.generator` + params) | the 25 parts are bespoke to one stack (a tank def carries nine engine nodes; "retro-motors" is one multi-nozzle part); a catalogue needs generic sizes and node standards (`attachNodes[].size` exists, nothing reads it) |
| Attach nodes | stack mating by node pair with twist; radial by explicit pose | surface-attach rules, node occupancy, size compatibility checks |
| Symmetry | none (engines and clamps are placed one by one) | a builder-side expansion to N placements; needs nothing in the sim |
| Blueprint versus instance | `VehicleDef` is the blueprint; `Vessel` points back at it for stages, abort, labels | the instance must own what a player can edit: stage stack, action groups, names |
| Staging editor | actions are data and already robust to missing parts | actions reference parts by vehicle-scoped strings; stage groups are hand-written |
| Resource flow | per-part tanks, per-engine propellant ratios | flow by string label; no crossfeed rules, no transfer |
| Fairings and shielding | `fairing.shields` lists instance or def ids by hand; the LES carries a one-panel "fairing" only to shield the capsule | derive shielding from geometry or from what is attached above the fairing base |
| Cockpit, crew, cameras | `VehicleDef.cockpit`, `cameras.cockpit`, `crew` | belong on the command part (`ModuleDef command` already has `seats` and `hatch`) so any craft with that pod gets its interior |
| Aerodynamics | per-part elements with stack shadowing | assumes a mostly axial stack; radial boosters and wings are outside the model |
| Mass, inertia, structure, thermal | generic per part | nothing to change |

The changes of 4.2 (explicit joints, vessel-owned stages, universe-unique part ids, derived flow groups) are
the same ones this table asks for. Doing them once, now, serves docking and leaves the builder as a UI and a
validation layer.

---

## 5. The body system and the whole solar system

### 5.1 It already runs three levels

An in-memory library with the Sun as root (attractor and star), eight planets, Pluto, Ceres and nineteen moons
on Kepler orbits was passed to the unmodified code (*measured*):

- `createBodySystem` accepted it: 30 bodies, `stateRoot` through two parent levels (0.21 us for a moon),
  SOIs from the `'auto'` rule (Earth 924,648 km; Jupiter 48.2 M km; Neptune 87.0 M km; Moon 66,100 km as
  authored).
- `predictPatches` from low Earth orbit with a 3,600 m/s node: `earth: soiExit > sun` after 3.2 days, then a
  closed heliocentric patch of 374.9 days; 0.12 ms per call.
- A heliocentric trajectory built to pass 4,000 km over Mars 120 days later: SOI entry found at 117.43 days.
- `createSim` with a `'state'` start in the Sun's SOI, flown by `advanceRails` at the top warp level: events
  `sun > mars` at 117.430 d and `mars > sun` at 122.408 d, the trajectory deflected by the fly-by, 135 days in
  0.38 s of wall time.
- Neptune-centred approach into Triton's SOI: `neptune: soiEnter > triton`, then `triton: impact`.

So hierarchy depth, SOI nesting, the ephemeris interface and the rails machinery are generic. What needs
work is listed below.

### 5.2 Data model gaps

| Gap | Where | Change |
|---|---|---|
| The Sun is a light, not an attractor, and orbits Earth | `sun.json`, `SunLowPrecisionOrbitDef`, `bodySystem.ts` l. 128 | Sun becomes the root attractor with `emission`; Earth gets a Kepler orbit; the low-precision Sun ephemeris goes. Sun direction at Earth then follows from Earth's fixed-element orbit instead of the Almanac formula (re-check against the solstice/equinox test of sim-orbits). The start-time search (`tools/sim/findStartTime.ts`) and the golden hash must be redone |
| Exactly one star | `bodySystem.ts` l. 107-109 | fine for this system |
| Small moons are rejected as attractors | `bodySystem.ts` l. 145 "soiRadius must exceed the radius": a Phobos-sized body fails (*measured*); Mimas' SOI is 1.3 radii, Enceladus 1.9, Miranda 2.0, Tethys 2.3 | a third `gravityRole` for bodies that are drawn and can be landed on later but never own an SOI, or an authored SOI; decide which moons are "major" |
| Seven warp altitude limits per attractor | `BodyDef.warpAltitudeLimits`, `RAILS_WARP_LEVEL_COUNT` | every new body file must carry them; tie them to radius by default instead |
| Placeholder bodies | the terrain renderer draws bodies that have `terrain` + `render.surface` + a baked tile set (`src/render/terrain/feature.ts` l. 526); the sky draws far impostors from `render.meanColor`; a body with `terrain: null` is a datum sphere for physics (`hasTerrain` false, height 0) | physics is ready for smooth placeholder bodies; rendering needs a near-range placeholder path, and gas giants need a "no surface" rule (crush or burn-up depth) |
| Atmospheres of other planets | `AtmosphereDef` supports `'exponential'` and `'table'` with per-body gas constants and heating | data only |
| Rotation | `fixedRate`, `tidalLock`, `none` with IAU pole angles | data only (retrograde and tilted poles are expressible) |
| Ephemeris fidelity | fixed mean Kepler elements, no perturbations; chosen so that prediction stays an exact conic. The model Moon already runs 6.55 deg per year ahead of the real one (sim-orbits hand-off) | "real orbits" will mean real elements at an epoch, self-consistent afterwards; calendar-accurate planetary positions would need a different ephemeris and would break exact prediction |

### 5.3 Precision (*measured*)

Spacing of float64 positions (one ulp):

| Radius | Where | ulp |
|---|---|---|
| 6.7e6 m | low Earth orbit, body-centred | 0.9 nm |
| 3.84e8 m | Moon distance | 0.06 um |
| 9.2e8 m | edge of Earth's SOI | 0.12 um |
| 4.8e10 m | edge of Jupiter's SOI | 7.6 um |
| 8.7e10 m | edge of Neptune's SOI | 15 um |
| 1.0-1.5 AU | heliocentric, Earth to Mars | 31 um |
| 5.2 AU | heliocentric at Jupiter | 0.12 mm |
| 9.6 AU | heliocentric at Saturn | 0.24 mm |
| 30-49 AU | heliocentric at Neptune and Pluto | 0.98 mm |

- **Body-centred state is fine everywhere inside a planet's SOI**, Neptune included: millimetre docking in low
  orbit of any planet or moon has six orders of magnitude to spare, and even at the SOI edge of Neptune the
  grid is 15 um.
- **Heliocentric state is not fine for docking.** In the Sun's SOI a craft's position grid is 0.03 mm near
  Earth and 1 mm beyond 30 AU. A closing speed of 1 cm/s moves a craft 83 um per step: 2.7 grid cells at
  1 AU, one twelfth of a cell at 30 AU. Relative position formed from two heliocentric states showed errors
  of 16 um at 1 AU and 0.61 mm at 30 AU. Penalty contact with the current structural stiffness (4e6 N/m)
  turns 1 mm of noise into kilonewtons. Proximity physics in solar orbit must be done in a local frame
  co-moving with the group (the group's reference orbit), not in BCI of the Sun.
- **A heliocentric ROOT would break rendering.** `VesselSnapshot.rRoot`, `BodySnapshot.rRoot` and
  `CameraState.positionRoot` are subtracted in float64 to make camera-relative positions (ARCHITECTURE
  section 4). With ROOT at the Sun, a 1 mm offset between two parts of a scene near Neptune arrives as
  0.977 mm or 0.999 mm (*measured*), and the cockpit sits centimetres from the eye. The frame handed to
  presentation has to be centred near the viewer (the SOI body of the focus, or the focus group), with axes
  still parallel to ICRF. The contract comment "ROOT ... centred on the root body (Earth)" is the only thing
  that pins the origin; render code uses ROOT axes and differences of ROOT positions, not the origin itself.
- **SOI hand-overs lose the same digits.** Converting a state from a body's frame to its parent's adds the
  body's position. Two craft flying formation across the Earth/Sun boundary are converted at different times
  with a 31 um grid. A group in proximity must change frame together.
- **Time.** `ut` near 9.4e8 s resolves 1.19e-7 s; the world already works around this with a base instant
  plus whole steps (`utBase`, `OrientationCache`, split propagation). The same grid is 3.6 mm of planetary
  motion at 30 km/s, harmless while everything near a body is expressed relative to that body. Late in the
  century (`ut` > 2^31 s) it is 4.8e-7 s; fast warp over decades gets there.

### 5.4 Prediction and warp

- **Horizon defect.** `runChain` (`patches.ts` l. 133, 151) fixes `horizonEnd = t0 + 60 days` at the start of the
  chain and ends an open patch at `max(horizonEnd, t)`. A fly-by hyperbola that begins later than 60 days
  from now therefore has zero length: the Mars encounter above came back as `mars: horizon 0.00 d` with no
  periapsis marker (*measured*). Every interplanetary arrival hits this. The horizon must be per patch and
  scaled to the SOI (time to cross it), and `DEFAULT_MAX_PATCHES = 8` needs a second look for moon tours.
- **Encounter search cost.** `findSoiEntry` steps by distance over closing speed with a 30 s floor
  (`SOI_MIN_STEP`). In solar orbit that is cheap (0.11 ms for the 120-day case, ten candidate bodies,
  *measured*), but a craft that lingers within about 1,800 km outside an SOI radius for months would walk it
  in 30 s steps. A later revolution's encounter on a closed orbit is not searched at all (known limit).
- **Targets are bodies only.** `PlayerCommands.setTarget(bodyId)`, `Readouts.target*`, the AN/DN and
  closest-approach markers in `buildMarkers` (target must orbit the patch body), `closestApproaches`. Vessel
  targets, relative velocity, intercept markers and a target-relative navball mode (`NavballMode` is
  `'surface' | 'orbit'`; `SasMode` has no target modes) do not exist. The conic machinery they need does.
- **Launch windows.** `computeLaunchWindow` solves coplanar launches to a body orbiting the launch body. There
  is no phase-angle or ejection-angle tool for interplanetary departures.
- **Warp rates.** Top level 100,000x. Hohmann transfer times and the real time they take at that rate: Mars
  259 days = 3.7 min; Jupiter 2.73 years = 14 min; Saturn 6.08 years = 32 min; Neptune 30.6 years = 2.7 h.
  Outer-planet flights need 1e6-1e7x. Rails propagation is exact at any step (always from the epoch state),
  and the event clamp already exists, so higher levels are a table change plus whatever the multiplayer time
  model allows.
- **Body-count scaling.** `buildBodySnapshots` 0.5 us -> 8.4 us and `sunVisibility` 0.42 us -> 6.9 us going from
  3 to 30 bodies (*measured*): both loop over every body. Still small; `sunVisibility` could restrict itself
  to the current planet system.

---

## 6. The client side

### 6.1 What presentation consumes

Everything goes through `SimSnapshot` (plus `DefLibrary`), and control goes back through `ControlInputs` and
`PlayerCommands`. Which parts each package reads (grep over `src/`, tests excluded):

| Package | Reads | Notes |
|---|---|---|
| `src/render/core` | `bodies`, `starId`, `vessels` (poses), `activeVesselId`, previous snapshot for motion vectors | `FrameContext.bodies/vessels` are camera-relative float64 built from ROOT positions |
| `src/render/terrain`, `atmosphere`, `sky`, `ocean` | `bodies`, `ut`, a few `vessels` fields, `events` (splash) | generic over bodies; ocean wetness has 8 vessel slots, active first |
| `src/render/vehicle` | every vessel's `parts` (pose, module states, temperatures), `events` (`vesselRemoved`) | draws every vessel in the snapshot; state keyed by vessel-id root + part instance id; engine clusters from `defs.vehicles[vehicleId]` |
| `src/render/vfx` | `vessels` (engine states, aero, contact), `events`, `activeVesselId` | |
| `src/render/cockpit` | `readouts`, `navball`, `staging`, `warp`, `mission`, `appliedControls`, `events`; interior chosen by `defs.vehicles[vehicleId].cockpit` | |
| `src/ui` (HUD, MFD, navball) | `readouts`, `navball`, `staging`, `warp`, `terrain`, `mission`, `surfaceTargets`, `events` | sends button actions; the launch panel calls `setTarget` |
| `src/map` | `patches`, `nodes`, `readouts`, `vessels` (other craft drawn as full conics from their state), `bodies` (`orbit`, `soiRadius`), `surfaceTargets` | edits nodes and target through `PlayerCommands` (14 call sites); draws nothing it predicted itself |
| `src/camera` | active vessel pose, `navball.mode`, `readouts.altitudeRadar`, `bodies` | cockpit eye from `VehicleDef.cameras.cockpit` |
| `src/audio` | `vessels` (engine and aero state), `events`, `warp`, listener | |
| `src/input` | `warp`, `readouts`, `navball`, `appliedControls`; `PlayerCommands` | |

The singleton fields (`readouts`, `navball`, `staging`, `patches`, `nodes`, `warp`, `mission`, ...) are read in
about 190 places in 28 files; `activeVesselId` in 31 places in 23 files.

### 6.2 What changes when state arrives as server snapshots

| Topic | Today | With server authority |
|---|---|---|
| Who builds `SimSnapshot` | `World.build` on the main thread | a client-side view model: replicated vessel states + local derivation. The shape can stay; `activeVesselId` = the craft this client flies |
| Bodies | `system.buildBodySnapshots(ut)` in the world | computed locally from universe time; never sent |
| Own vessel | integrated locally, exact | predicted locally with the same `stepVessel` and corrected from snapshots; corrections must be smoothed in the frame of the vessel, and prediction is not bit-exact (3.1). `Vessel.struct` state (friction anchors, wake factors) is not in any snapshot, so a correction during contact changes how the craft settles unless that state is replicated or made derived |
| Other vessels | same world, same time | on rails: propagate the conic locally (exact, no bandwidth). Integrated and nearby: replicated poses at some rate, extrapolated ballistically between updates (gravity and drag are predictable; thrust changes are the only surprise) |
| Two time bases at docking | none | own craft is predicted "now", neighbours arrive late. For contact and port alignment both must be shown at one time; the vessel packages can step a neighbour forward with its last known controls, which is the same code path as own-vessel prediction |
| `snapshot()` interpolation (`ut` vs `simUt`, `lag`) | sub-step interpolation between two local states | the same mechanism, fed by the prediction buffer; `SimSnapshot.ut/simUt` semantics remain meaningful |
| `PlayerCommands` | synchronous `CommandResult`; `addNode` returns an id | results arrive later. Commands that only plan (`addNode`, `setNode`, `removeNode`, `setTarget`, `setNavballMode`) need no server at all: nodes and targets affect nothing authoritative except the SAS `'maneuver'` hold direction, which the world already passes to the vessel as a plain vector (`setSasHoldDirection`), so it can travel with the controls (the warp lead before a node is a convenience of the same kind). Commands that change state (`stage`, `abort`, SAS/RCS/legs/lights, undock) need client-issued ids and optimistic application or a pending state in the HUD |
| `setWarpLevel`, `SimSnapshot.warp` | one global index | whatever the time model defines per player or group; the HUD and audio only need a factor and a limit reason |
| `cycleActiveVessel` | cycles controllable vessels in the bubble | "take the helm of another craft I may control nearby" |
| Events | one queue drained once per frame | replicated edge events scoped by relevance; `vesselId` is already on every event. `'activeVesselChanged'`, `'warpChanged'`, `'missionFailed'`, `'milestone'` become per-player |
| Part detail | every vessel carries all `PartSnapshot`s every frame (17 kB for the stack) | structure on change, slow state at low rate, fast state per update; the renderer already rebuilds its per-vessel plan only when the part list changes (`planKey`) |
| `Sim.debug`, `cheatCounter` | local | not exposed to clients; a single-player offline mode can keep it |
| `terrain` status, `Sim.ready`, `terrainPending` | one provider | client keeps its own streaming provider for rendering and prediction; the server has its own for authority |
| Map | bodies as targets, zoom to 2e9 m, focus bodies/vessels | vessel targets, relative-motion readouts, intercept markers, zoom to 1e13 m, and a snapshot frame that is not Earth-centred; other craft are already drawn from state as conics |
| Audio, VFX, ocean wetness | keyed on the active vessel, all vessels considered | need a relevance cut (nearest N); slots and budgets were sized for one craft and its debris |
| Vehicle rendering budget | one stack of 1.0-1.6 M triangles at LOD0 | several launches in view at once multiply it; LOD selection by projected size exists per part |
| `FakeSim` | kinematic `Sim` for labs | stays useful for labs if the presentation-facing interface stays |
| `Pilot` / scripted pilot | reads `peek()`, acts through controls and commands | the same interface drives bot clients for load and docking tests, provided commands become asynchronous-safe |

Because `src/app` is not wired yet, the place where `Sim`, input, camera, HUD, audio and renderer meet can be
written once against the new producer.

---

## 7. Refactor map

| Module | Verdict | Reason |
|---|---|---|
| `src/core/math`, `src/core/geo` | keep | pure, shared by sim, terrain and shaders. Optional addition: deterministic transcendental functions if cross-runtime agreement is wanted (3.1) |
| `src/core/contracts/sim.ts` | extend in place, split in two | keep `SimSnapshot` and its parts as the presentation contract (ids become universe-unique; targets may be vessels; frame origin documented as viewer-centred; `scenario`/`mission`/`cheatCounter` become optional per-player extras). The `Sim` interface is the piece to replace: a client-side view source and command sink, and a separate server-side universe interface |
| `src/core/contracts/controls.ts` | extend in place | commands gain an implicit subject (the caller's craft) and asynchronous results; planning commands become client-local; add docking, target-relative modes, helm requests |
| `src/core/contracts/defs.ts` | extend in place | bodies: Sun-rooted, gravity roles, warp table; parts: `dockingPort` module, optional `collider`; vehicles: blueprint only (stages copied to the instance, cockpit and crew on the command part, flow groups derived); sites: several pads; scenario demoted to a spawn/objective recipe |
| `src/core/contracts/simInternal.ts` | extend in place | `VesselEnvironment` gains what a local proximity frame and contact with other vessels need; the "start of step" rule stays |
| `src/core/contracts/render.ts`, `ui.ts`, `audio.ts` | keep, small edits | wording that says "active vessel" stays true per client; slot counts and budgets revisited |
| `src/core/defs` (loader) | keep | generic; runs in Node and browser |
| `src/core/fakes/fakeSim.ts` | extend in place | follows the presentation-facing interface |
| `src/sim/orbit` | keep, fix and extend | Kepler, events, patches, warp maths are sound and fast. Fix the prediction horizon (5.4); add vessel-versus-vessel closest approach and conjunction screening; add higher warp levels |
| `src/sim/bodies` | extend in place | already depth-generic. Sun as root attractor, a non-SOI body role, drop the geocentric Sun ephemeris, optional culling in `sunVisibility` |
| `src/sim/frames`, `src/sim/nav` | keep, extend | add target-relative navigation (relative state, port alignment), interplanetary window helpers; `buildSurfaceTargets` takes a list of sites |
| `src/sim/vessel` (`types`, `assemble`, `split`, `staging`, `structure`, `facade`, `massProps`) | restructure the data model, keep the algorithms | explicit joint graph; vessel-owned stage stack; universe-unique part and vessel ids; derived flow groups; crew per command part; momentum-conserving merge; move the stateful members out of `struct` or make them derivable; a real serialiser. `computeMassProps`, the modules, `separateVessel`'s component logic, `stagingInfo`, the action executor carry over |
| `src/sim/vessel/clearance.ts` | extend in place | becomes the broad/mid phase of vessel contact; needs contact points and normals |
| `src/sim/dynamics` (`integrator`, `contact`, `aero`, `thermal`, `failure`, `reduced`) | extend in place; restructure the stepping loop | force models stay. `stepVessel` must be able to advance a group of vessels sub-step by sub-step with pair forces, and to work in a local frame in solar orbit; add swept tests |
| `src/sim/control` (SAS, allocation) | keep | per-vessel, input-driven; add target hold directions (supplied as vectors, as today) |
| `src/sim/world/sim.ts` (`World`) | **restructure (rewrite the orchestrator)** | it is the single-player, single-clock, single-scenario binding. Reusable as written: the landed/rails/integrated state machine per entry, `advanceOnRails` with exact event handling, SOI hand-over, the reduced tier, `present()` interpolation, the readout and navball assembly (these move to the client view), burn bookkeeping (client), debris fates. To be replaced: one `active`, one `controls`, one clock and warp, bubble-by-active-vessel, mission failure, synchronous commands, the O(n) per-step loop over all entries and O(n^2) proximity |
| `src/sim/world/milestones.ts` | keep | generic per-vessel observer; attach to a vessel when an objective list is wanted (the original mission proof) |
| `src/sim/world/terrainPolicy.ts`, `environment.ts`, `scenarioStart.ts`, `stateHash.ts` | keep, generalise | per-vessel terrain slots already exist; start poses become spawn poses; hashing gains a codec sibling |
| `src/pilot` | keep as test tooling, extend | `runner.ts`, `core.ts`, `attitude.ts`, `guidance.ts` are the base for bot clients; `missionPilot.ts` stays the Earth-Moon proof and must be re-validated after the body re-root |
| `src/terrain` | keep | headless, already runs in Node on the fs tile source; the server deployment must carry or reach 9.4 GB of height tiles |
| `src/render/core`, `terrain`, `atmosphere`, `sky`, `ocean` | keep | iterate bodies and vessels generically; need a viewer-centred frame origin (nothing depends on Earth being at zero), a placeholder path for bodies without tile sets, and relevance limits for many vessels |
| `src/render/vehicle`, `cockpit`, `vfx` | extend in place | stop looking things up by `vehicleId` (engine clusters, cockpit interior, seat); key presentation state by universe-unique part ids; LOD and counts for several craft in view |
| `src/ui`, `src/input`, `src/camera` | extend in place | render from the same snapshot shape; add menu/spawn flow, asynchronous command feedback, target-relative readouts, docking aids; cockpit seat from the command part; map range |
| `src/map` | extend in place | draws from snapshot data already, including other vessels; add vessel targets, intercepts, relative motion, solar-system range; planning becomes client-local |
| `src/audio` | keep | consumes vessel state and events; needs a relevance cut |
| `src/app` | write new | still a shell; wire it once against the client view source |
| `data/defs/bodies` | restructure (data) | Sun-rooted set with planets and major moons; Earth and Moon keep their sections |
| `data/defs/parts`, `vehicles` | extend (data) | a fleet; docking ports; vehicles reduced to blueprints once the model changes |
| `data/defs/scenarios`, `tests/mission` | keep, re-baseline | the lunar proof must still pass; its golden hash and start time change with the body re-root and any id change |
| `tools/sim/findStartTime.ts` | keep, re-run | depends on the Sun and Moon model |

Order that minimises rework: (1) ids, explicit joints and vessel-owned stages in `src/sim/vessel` (everything
else names parts and vessels); (2) the Sun-rooted body set and the viewer-centred frame; (3) the universe
orchestrator with per-group clocks and the client view model, built against the kept `SimSnapshot`;
(4) islands, contact and docking; (5) map and UI extensions.

---

## 8. Defects and risks found on the way

1. `patches.ts` prediction horizon truncates encounters later than 60 days (5.4). Fails silently.
2. `Vessel.struct` carries non-derived state; `cloneVessel` and every staging split reset thermal wake
   factors (3.2). Harmless today, wrong for persistence, rollback and prediction.
3. Vessel id = vehicle id; part ids vehicle-scoped (2.5). Latent until a second craft exists.
4. A full-tier vessel on rails and a sleeping landed vessel are stepped every step (3.3).
5. `World.crewAlive` fails the mission when any vessel loses crew, including a discarded stage that happens
   to carry a command part.
6. `bodySystem.ts` refuses moons whose SOI lies inside their radius; several real moons are near that
   limit (5.2).
7. `convexDistance` is inexact for near-parallel faces, the geometry of two docking ports about to meet (4.3).
8. Golden state hashes are tied to the Node/V8 build through `Math` (3.1); pin the server runtime version and
   treat a runtime upgrade as a re-baseline.
9. Cloud CPU speed, real-terrain contact cost under load and memory per live vessel on the server were not
   measured here; the capacity figures in 3.3 are an upper bound from one fast desktop core.
