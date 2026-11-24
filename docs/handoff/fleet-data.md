# Hand-off: fleet-data (wave 4.1)

## FIX ROUND (2026-11-24, after the independent review; this section replaces the sections below where they differ)

Commits 7f9cafb, 16cc5f1 and the one that adds this section ("fleet-data fix round, part 2"). Requests fleet-data-1
to -4 were resolved meanwhile (the lead; presentation-sweep), -5 and -7 by island-core (4c9a569); -6 is open.

| # | Finding | State | Evidence |
|---|---|---|---|
| 1 | Reach table: one synodic period, no broken plane | fixed | `tests/unit/fleet/reachTable.ts`: `deltaVToOrbit(..., { brokenPlane: true, searchSpan: 6 years, aerobrake: false })` |
| 1 | Mimas (lead decision: more depot flights) | fixed | Mimas closes with 6 depot flights, 2 of them kept docked as drop tanks at the cruiser's two H ports: +384 m/s, MARGINAL. Titan gravity assist is named as the skilled alternative (not modelled). **Q17's answer, for the lead to record: every one of the 31 bodies besides Earth is reachable into orbit by the Albatross with at most 6 Pelican Heavy depot flights (table below); six of them (Dione, Enceladus, Io, Mercury, Mimas, Miranda) close by under 5 % of their cost and are unproven in flight** |
| 2 | Aerocapture credited to a ship without a shield | fixed | `aerobrake: false` for the cruiser (`entrySpeedLimit` null) |
| 3 | Flat 2 % burn loss | fixed | finite-burn loss per leg (Robbins, (omega t)^2 / 24, t from the cruiser's thrust and mass at the leg, omega at the burn point); margins under 5 % of cost marked MARGINAL in the table and listed in reach.test.ts. Enceladus, Io and the other MARGINAL bodies are NOT flown: stated unproven |
| 3 | Depot delivery spare | stated | as flown, the Pelican Heavy reaches 185.6 x 208.6 km with the depot still on its M-3 and 3,426 m/s left (148.2 t; `npx tsx tests/unit/fleet/flyOne.ts meridian-pelican-heavy`). The raise to the refuel orbit costs 3,192 m/s (3,130 impulsive plus allowances, solar-system-sim's function; this leg is NOT flown): 234 m/s to spare on that basis. (The analysis's 38 m/s "in orbit" of this vehicle is the depot's RCS after the M-3 is gone, not the delivery spare.) |
| 4 | Ladder refuels what cannot reach the refuel orbit; two answers | fixed | `reachLadder` requires `available >= beforeRefuel`, states `min(available - before, refilled - after)`, offers a refuel only where the vehicle's main propellants are ones a depot carries (`AnalysisOptions.depotPropellants`); the patched-conic default (analyzeReach.ts) is removed: without the caller's `reachCost` the ladder is empty; reach.test.ts holds the ladder equal to the table |
| 5 | validateVehicle accepts cheats | fixed | errors `resourceLoad`, `crewSeats`, `unknownField`, `badId` (lower-kebab), `engineBlocked` (the nozzle axis against every part's bounds for 40 m when the stage lights it; `analyzeVehicle` states 0 m/s for that stage), `clampsNeverReleased`, `separationAtLiftoff`, `emptyStageList`, `fairingContainment`, `fairingOverhang` (the 6.6 m fairing on a 2.2 m stage: base wider than 1.5 x what carries it); warnings `engineNeverIgnited`, `actionRepeated`, `upperStageLitAtLiftoff`, `decouplerAlone`, `craftWithoutCommand` (the stray pre-docked port). One fixture each in `tests/unit/fleet/validate-gate.test.ts`. The checks that need only the definitions (loads, crew, fields, ids, the stage sequence) live in `structuralIssues` (src/core/defs/vehicleStructure.ts); the loader refuses its errors only |
| 6 | Loader accepts nonsense | fixed | dryMass > 0, thrustVac > 0, ispVac > 0, 0 <= ispSL <= ispVac, propellant ratios positive and summing to 1, capacity >= 0; unknown placement keys and non-kebab instance ids refused; fixtures in validate-gate.test.ts and loader.test.ts (whose fixture parts gained a dry mass and its fixture vehicle a stage). The original stack loads unchanged (codec, pins and mission below) |
| 7 | Albatross on optimistic masses (lead decision) | fixed | Canopus-N 6.4 t (T/W 4.0 at 250 kN), habitat 22 t, thrust structure 2.4 t, `tank-lh2-9m` 7.5 t dry holding 45 t of LH2 (ellipsoidal domes, 660 m^3 with 3 % ullage; the model has no boil-off: the cryocoolers are in the dry mass), four tanks launched two full, two H ports: cruiser dry 82.3 t, 180 t LH2, 10,234 m/s full. What the masses took is given back as depot flights (table below) |
| 7 | Blobs | re-recorded, more than once | only my nine `tests/unit/sim-vessel/corpus/fleet-*.v4.bin` and their nine pin lines in tools/dev/guard-pins.test.ts changed, but in three recordings, not one: with the corrected masses, the Albatross again for its second H port (both in 16cc5f1), and all nine again in part 2 for the fairing shield lists, the Egret's quads and the truss fitted to its nose cap. No other blob or pin moved |
| 8 | Payloads outside their fairings | fixed | `fairing-6m6-ogive` 18 m, `nose-cap-9m` 17 m with its own drag table; the shield lists name only what is inside (the payload adapters, the 4 m to 6.6 m adapter and the Kestrel's Lyra-A stand at or below the base plane); the Egret's quads 0.1 m further in; the truss's frustum 0.1 m narrower at its base, inside the nose cap; `fairingContainment` holds every shielded part inside the fairing's authored shell (32 points on each rim of the part's own shapes, legs at hinge and foot) |
| 9 | Debris "gentle drop" red | partly | green, but under the owner's new limit (island-core, 4c9a569, resolving fleet-data-7: under 10 % of the drops), not the old count: 12 of 232 drops break by toppling, mine among them azimuth-s1, solstice-s1 and (since its 18 m length) fairing-6m6-ogive, all from the skew attitude, as the Meridian's M-1 to M-3 do |
| 10 | Cruiser separation 6.4 s; heavy flights without separation in orbit | fixed | adapter-9m 80 kN s, the NTRs light 6 s after: the pieces part in 2.87 s; the heavy flights run with `separateInOrbit` (flights-heavy.test.ts) |
| 11 | Splashdown speed after impact | fixed | taken at first contact: 7.85 m/s, asserted under 10, and a `chuteFailed` damage event fails the test |
| 12 | Flat terrain only | fixed | Ka Lae lc-3 (Solstice / Kestrel LF) and Madrakah lc-11 (Azimuth 1 / Pathfinder) on the real terrain (flights-range.test.ts; `it.skipIf` without baked tiles) |
| 13 | Pilot tail-off, 264 km apoapsis, one TWR | fixed | the pilot coasts to the apoapsis and circularises (stages with RCS), throttling the tail-off; every ascent asserted in 185-250 km (periapsis >= 185, apoapsis <= 250; the Azimuth 190.2 x 205.7, the Albatross 185.4 x 206.5); lift-off TWR range shown by off-loaded variants at 1.64 and 1.99 (flights-range.test.ts) |
| 14 | Engines and tanks inconsistent | fixed | Lyra-K 315 s with a 0.34 m exit; Wren-1V 190 kN / 355 s vac, 250 s at sea level (a vacuum nozzle on the Wren-1's chamber: 176 kN / 330 s); the generator checks every tank's volume against its propellant (the Azimuth tanks lengthened) |
| 15 | Numbers beyond flown hardware | fixed | wheels: Pathfinder 4 N m, avionics ring 600, Egret cabin 400, Albatross habitat 4,000 (CMGs); port transfer C 10 kg/s, H 40 kg/s; no boil-off is a stated rule of the model |
| 16 | Pad limits by exact equality | fixed | mass compared with 1e-6 of the limit, diameter with 1 cm; the diameter envelope sampled at 64 angles (was 8); the sites' limits unchanged |
| 17 | First offer | fixed | solstice-atoll no longer `firstOffer` |
| 20 | Egret starts full in lunar orbit | fixed | starts as delivered (12.2 t burnt in the 900 m/s insertion); lands at 0.79 m/s and returns to orbit with 1,080 m/s left |
| 18 | Authority and port refresh in the simulation | not mine | fleet-data-5, resolved by island-core (4c9a569) |

**Mission.** On a clean copy at HEAD, once alone and once with this round's files: both 35 of 37, with the same two
failures of `tests/mission/full-mission.test.ts` ("sample 7 (control tick 2806, grid)" and an empty-list
assertion) that HEAD has without fleet-data's files (island-core's a7d53a5 states 35 of 37 too): fleet-data's
changes move nothing of the mission.

**Reach, depot flights per body** (`npx tsx tests/unit/fleet/reachTable.ts`; margin in m/s; M = MARGINAL, under 5 %
of cost). Cruiser 82.3 t dry, 180 t LH2 full, 88.4 t of it after its own ascent; a depot brings 45 t (9.0 t dry).
- 0 flights (direct): Deimos 862, Mars 1,716, Moon 2,340, Phobos 647, Sun 3,071, Venus 1,690.
- 1: Jupiter 3,244, Saturn 3,244.
- 2: Callisto 2,977, Ceres 2,895, Ganymede 2,303, Iapetus 2,081, Neptune 3,244, Titan 2,022, Uranus 3,244.
- 3: Ariel 900, Europa 955, Mercury 513 M, Miranda 423 M, Oberon 1,423, Rhea 730, Titania 1,246, Triton 1,349,
  Umbriel 1,045.
- 4: Dione 173 M.
- 5 (one depot kept as a drop tank): Charon 759, Enceladus 97 M, Io 679 M, Pluto 988, Tethys 729.
- 6 (two kept as drop tanks): Mimas 384 M.
(3,244 is the cap set by the raise to the refuel orbit from what the cruiser has after its ascent.)

**Corrected fleet table** (`analyzeVehicle`; lift-off mass, total vacuum delta-v, delta-v in orbit):
Azimuth 1 / Pathfinder 60.65 t, 14,983, 5,443 m/s; Solstice / Kestrel LF 600.95 t, 12,887, 3,381; Solstice / Atoll
611.5 t, 10,553, 1,052; Solstice / Pelican 612.3 t, 15,874, 6,373; Meridian / Egret 2,748.5 t, 19,671, 10,207;
Meridian / Albatross 2,771.65 t, 15,902, 6,439 (flown: 6,180 in 185.4 x 206.5 km); Meridian / Pelican Heavy
2,752.4 t, 13,300 (in orbit only the depot's RCS, 38: see finding 3); Meridian / lunar (original) 2,756.1 t,
unchanged.

The fleet as data: 33 new parts, 13 assemblies, 7 new vehicles (meridian-lunar untouched), menu text, the pads of
both sites (Ka Lae 9, Madrakah 16), the loader's assemblies and structural checks, `hashLibrary`,
`analyzeVehicle`, `validateVehicle`, the module behaviour of ports and remote command, a generic ascent pilot,
ten fleet scenarios, the acceptance flights, a codec blob of every new vehicle, and the reach-by-refuelling table.
Commits d77b5c1 .. 3b3feb7 (all "fleet-data: ..."). Tree state at the end: library loads, my suites green, the
mission 36 of 36 at the golden `72c0893583aa427d` (see 3.3 on how it was flown).

**Read first (blocking for others):** the vessel feature builds the models of every vehicle of the library at
`init` and reports every new part without a visual as an error: every browser page with the vessel feature, the
reference images included, starts with about 30 errors since 7ebd5ee. Requests fleet-data-2 and
capability-settings-2 (the same change, routed to the lead): warm only vehicles whose parts all have visuals.
fleet-data invented no stand-in visuals (the brief forbids it); the parts reference their visual sections the
way the existing parts do (`{"$ref": "../visuals/parts/<id>.json", "optional": true}`), so they load as null
until fleet-models-pads writes those files, and the part files need not change then.

## 1. Public API (exact signatures)

src/core/defs (imports nothing outside src/core):
- `assemblies.ts`: `flattenVehicle(vehicle: VehicleDef, assemblies: Readonly<Record<string, AssemblyDef>>, file?: string): VehicleDef`
  (a vehicle without `uses` is returned as the same object); `checkAssemblyShape(a: unknown, file: string): asserts a is AssemblyDef`; `class AssemblyError`.
  Rules: ids and stage groups of a use become `<prefix>-<id>`; the assembly root takes the use's `parent`,
  `parentNode`, `node` (its own `position` stays); `use.resources` overrides loads by prefixed id; stage stacks and
  abort lists concatenate in the order of `uses`, then the vehicle's own; action groups of one name join; the
  flattened vehicle has no `uses`.
- `vehicleStructure.ts`: `structuralIssues(parts: Readonly<Record<string, PartDef>>, vehicle: VehicleDef): Issue[]`
  (codes `badId`, `duplicatePart`, `unknownPart`, `noRoot`, `multipleRoots`, `unknownParent`, `unreachablePart`,
  `noPlacement`, `unknownNode`, `nodeKind`, `nodeOccupied`, `unknownStageGroup`, `stageActionTarget`, `noCommand`);
  helpers `separatorOf`, `modulesOf`, `nodeOf`, `nodeKind`, `actionParts`, type `AnyModuleDef`.
- `hash.ts`: `hashLibrary(defs: DefLibrary): string` (16 hex; canonical JSON of the LOADED library: bodies, sites,
  resources, parts, assemblies, flattened vehicles, rules, scenarios, sections); `canonicalText`, `hashText`.
- `loader.ts`: reads `assemblies/*.json` into `DefLibrary.assemblies`, flattens `uses`, holds every vehicle to
  `structuralIssues` (first finding is the DefError, by vehicle file); lists flat vehicle files first, then
  composed ones (request fleet-data-3).

src/sim/vessel (fleet-data's files):
- `analyze.ts`: `analyzeVehicle(defs: DefLibrary, vehicle: VehicleDef, options?: AnalysisOptions): VehicleCapabilities`;
  `AnalysisOptions { rules?; launchBodyId?; reach?: ReachAssumptions; reachCost?: (bodyId: string, refuelled: boolean) => { flyby: number; orbit: number } | null }`;
  `stageBurns(defs, vehicle)`, `idealDeltaV(stages)`, `deltaVToLowOrbit(defs, body, a?)`, `launchBodyOf(defs, id?)`,
  `ASCENT_LOSS` (2,000 m/s), `ENTRY_FLIGHT_PATH_DEG` (6). Method in the file header: stages fired by the
  simulation's `applyStageInstant`, burns to depletion, pure jettisons applied early in the burn they follow.
  src/sim/vessel may not import src/sim/nav, so the ladder's default is the estimate of `analyzeReach.ts`;
  a caller outside (the activation's reachability table) passes solar-system-sim's `deltaVToOrbit` as `reachCost`.
- `analyzeReach.ts`: `transferCost`, `captureDeltaV`, `refuelOrbitPerigeeSpeed`, `soiRadiusOf`, `semiMajorAxis`, `REACH_ASSUMPTIONS`.
- `validate.ts`: `validateVehicle(defs: DefLibrary, vehicle: VehicleDef, context?: ValidationContext): Issue[]`;
  `ValidationContext { start?: 'pad'|'orbit'|'landed'|'state' (default 'pad'); pad?: PadDef; rules?: UniverseRules }`;
  adds `assembly`, `nodeSizeMismatch` (a child node wider than its parent's beyond 10 % or 0.1 m), `overlap`
  (clearance.ts envelopes, > 5 cm; not compared: joined pairs, two parts on nodes of one parent, hollow parts:
  fairings, decouplers, motor rings; legs), `launchSequence` (a stage acting on two craft), `noClamps`,
  `padClassExceeded` (padLimitsOf with the rules in force).
- `modules/dockingPortState.ts`: `portModulesOf`, `portStateAt`, `initialPortState`, `asModuleState`,
  `portConditions(vessel, partIndex, moduleIndex)`, `derivedPortState`, `refreshPortStates(vessel)`, `armPort(vessel, partIndex, armed)`.
- `modules/remoteCommand.ts`: `givesCommandAuthority(part)`, `commandAuthorityParts(vessel, craft?)`, `hasCommandAuthority(vessel, craft?)`, `isRemoteCapable(part)`.
- `assemble.ts`: `createModuleState` creates the port state; `buildVehicle` refreshes port states.
- `modules/engine.ts`: unchanged. The Canopus-N's slow spool is data (first-order lag 6.7 s up, 10 s down: 95 %
  at 20 s, 5 % at 30 s; tests/unit/fleet/modules.test.ts). A ramp model would need a new engine field (contract).

src/pilot/generic (snapshot and `VehicleCapabilities` only; imports src/core and src/pilot):
- `common.ts`: `abstract class GenericPilot implements Pilot` (phases, `pointAt`, `fireStage`, `canStage`,
  `limitedLever`, horizon helpers), `horizon`, `above`, `horizontalOf`, `G0`.
- `ascent.ts`: `createAscentPilot(caps: VehicleCapabilities, options?: AscentOptions): AscentPilot`;
  `AscentOptions { targetAltitude? (205 km); cutoffPeriapsis? (185 km); maxG? (4); separateInOrbit?; watchAfterSeparation?; fromSurface? }`.

## 2. Data
- Parts (33): wren-1, wren-1v, lyra-k, canopus-n; azimuth-s1, azimuth-s2, azimuth-interstage,
  azimuth-payload-adapter, azimuth-fairing, launch-clamp-s; pathfinder-bus; solstice-s1, solstice-interstage,
  adapter-4m-6m6, fairing-6m6-ogive; plover-sm, kestrel-sm-fairing; rcs-quad-220, rcs-quad-440; dock-port-c,
  dock-port-h, dock-adapter-h-c (one port of each type); avionics-ring-4, atoll-core, pelican-tank; egret-tank,
  egret-cabin (Kestrel mould-line seats, cockpit `kestrel`, remote); albatross-hab, truss-9m, tank-lh2-9m,
  thrust-structure-9m, adapter-9m, nose-cap-9m. Ports carry the module, envelope, soft, hard, impulse and
  transfer values of fleet-docking 3.1-3.3 (H transfers LH2 at 300 kg/s). `visual` optional refs (null now).
  Plume and sound ids are existing ones (canopus-n: `plume.hydrolox-vacuum`, `engine.hydrolox-vacuum`; the
  research's `plume.ntr-hydrogen` is fleet-models-pads' to add; both fields are presentation, free).
- Assemblies (13): azimuth-1, pathfinder, solstice, kestrel-lf, atoll, pelican, meridian-core (M-1+M-2),
  meridian-m3-stage, payload-fairing-6m6, payload-nose-cap-9m, egret, albatross, pelican-heavy-depot. A payload
  carries its own separation and jettisons, so the concatenation of stacks is the order of flight (a Meridian
  payload's fairing is an assembly listed before the M-3 stage).
- Vehicles (7 new): azimuth-pathfinder, solstice-kestrel, solstice-atoll, solstice-pelican, meridian-egret,
  meridian-albatross, meridian-pelican-heavy (depot tank loaded 50 t LH2 by `uses.resources`). Each has stages,
  abort, padInterface, chase camera. **No vehicle launches pre-docked** (every one is one tree); `validateVehicle`
  checks the launch-sequence rule and a test tandem proves it.
- Menu text `data/defs/visuals/vehicles/<id>.json` (all 8): `{ vehicle, title, tagline, description, role, tags[], difficulty, firstOffer }`.
- Scenarios: `fleet-<vehicle>` (pad starts: light lc-4, medium lc-3, heavy lc-2 of Ka Lae), `fleet-kestrel-entry`,
  `fleet-egret-lunar`, `fleet-albatross-departure`.
- Sites: ka-lae.json (LC-1's lines byte-identical; 8 pads added), ka-lae.location.json (`pads`), madrakah.json
  and .location.json (new; recovery zones Arabian Sea, Central and South Indian Ocean). Every new pad:
  `structures: []` (no survey: request fleet-data-6), mount height heavy 18 / medium 10 / light 4 m, keep-out from
  the rules' class value, azimuth 90.

## 3. How to run and verify
- `node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/core/defs src/sim/vessel src/sim/control tests/unit/fleet tests/unit/sim-vessel`
  (28 files; all green except `tests/unit/sim-vessel/debris.test.ts` "gentle drop": request fleet-data-7).
- `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission`: 36 of 36 at 72c0893583aa427d with fleet-data's
  changes, flown three times in an isolated worktree of 8edcf83 plus fleet-data's files (after the sites, the
  depot load and the part probes), because the shared tree's World was in flight with island-core's uncommitted
  changes (the shared tree gave 2cc620fabf5771ee once, at 12:55, before any of those fleet-data changes was
  in the worktree runs; the worktree runs prove fleet-data's files leave the golden as it is).
- Flights for session-switch to re-run on LocalSession (each `fly(defs, scenario, pilot)` of tests/unit/fleet/flights.ts):
  `npx vitest run tests/unit/fleet/flights-light-medium.test.ts tests/unit/fleet/flights-heavy.test.ts tests/unit/fleet/flights-beyond.test.ts`;
  one at a time: `npx tsx tests/unit/fleet/flyOne.ts <vehicle id> [--separate]` or `... entry | lunar | departure`.
- Terrain guard audit: `node tools/dev/heavy.mjs --class=cpu -- npx tsx tests/unit/fleet/guardAudit.ts` (writes tests/unit/fleet/terrain-guard-pad-changes.json).
- Reach table: `npx tsx tests/unit/fleet/reachTable.ts`.
- Corpus: `npx tsx tests/unit/sim-vessel/corpus/record.ts` (adds missing blobs only).

## 4. Acceptance, measured
| Line | Result |
|---|---|
| Library loads at every commit | Yes (every commit loaded through `loadDefs` before it) |
| validateVehicle: nothing for the 8 vehicles | **Met under the proposed class limits** (fleet-data-4). Under today's provisional defaults the 3 Solstice stacks are `padClassExceeded`: 8.00 m (M-3 RCS pods) against 7 m. Others: nothing |
| ... the right issue for 12 broken fixtures | 13 fixtures, each its code (tests/unit/fleet/validate.test.ts) |
| Each new vehicle to orbit from a Ka Lae pad of its class, pe >= 160 km | All 7: see 4.1 |
| Separations: positive clearance for 30 s | All pieces part within 0 to 3.4 s (born nested: engine bells in interstages and adapters) and stay apart; 12-3,560 m at 30 s |
| Max-q under each stack's structural limits | q alpha 401-731 Pa rad against the weakest joint's 3,000-3,500 |
| Propellant margins reported | 4.1 (delta-v left in orbit) |
| Solstice with 23 t payload about 9.9 km/s ideal | 9,899 m/s (S1 mean 4,464 + S2 5,435) |
| Kestrel LF re-enters and splashes down under chutes | Yes: drogues, mains, splashdown at 0.5 m/s, crew alive, 2,882 s from 200 km orbit |
| Egret from lunar orbit lands and returns to orbit | Touchdown 0.89 m/s; back in 18.0 x 208.1 km lunar orbit, 1,967 m/s left |
| Albatross 10.9 km/s (+/-2 %) from LEO; 20-min burn at 4x | 10,908 m/s analysed and flown; burn 1,231 s at warp index 3 (4x) |
| analyzeVehicle vs rocket equation by hand, 0.5 % | Meridian (5 stages), Azimuth/Pathfinder (3), Solstice/Pelican (3): all within 0.5 % (tests/unit/fleet/analyze.test.ts) |
| Trajectory guard green; test:mission unchanged | 36 of 36 at the golden (see 3) |
| Boundary run | `tools/dev/boundaries.test.ts` 93 of 93: src/core/defs imports only src/core; src/pilot imports src/core only (capabilities arrive as data) |
| Codec fixture of each new vehicle in the corpus | 9 blobs (7 on the pad, Kestrel LF and Pelican in orbit), pinned; codec 29 of 29 |
| Fleet table against the sheets | Section 5 |

### 4.1 The ascents (generic pilot, flat terrain stand-in, from Ka Lae)
| Vehicle (pad) | Orbit, km | T+ | max q kPa | q alpha / weakest | delta-v left in orbit |
|---|---|---|---|---|---|
| azimuth-pathfinder (lc-4) | 190.8 x 264.2 | 478 s | 29.7 | 731 / 3,000 | 4,999 m/s (probe, after its separation) |
| solstice-kestrel (lc-3) | 193.0 x 236.9 | 505 s | 26.1 | 525 / 3,500 | 1,312 m/s (ferry) |
| solstice-atoll (lc-3) | 194.7 x 225.8 | 540 s | 27.1 | 434 / 3,500 | 434 m/s (core) |
| solstice-pelican (lc-3) | 195.1 x 224.7 | 543 s | 27.1 | 482 / 3,500 | 5,839 m/s (tug) |
| meridian-egret (lc-2) | 186.7 x 224.6 | 581 s | 28.2 | 422 / 3,500 | 10,058 m/s (M-3 3,650 + Egret 6,261, less use) |
| meridian-albatross (lc-2) | 186.3 x 225.1 | 578 s | 28.2 | 414 / 3,000 | 11,149 m/s (cruiser full + M-2 rest) |
| meridian-pelican-heavy (lc-2) | 185.3 x 220.7 | 592 s | 28.0 | 401 / 3,000 | 3,398 m/s (M-3 with the 50 t depot; 3,192 needed to the refuel orbit) |

## 5. The fleet against fleet-docking's sheets
| Vehicle | Parts | Lift-off (sheet) | TWR SL (sheet) | Delta-v (sheet) | Deviation and why |
|---|---|---|---|---|---|
| azimuth-pathfinder | 17 | 60,540 kg (60,500) | 1.35 (1.35) | S1 4,199 vac (4,205), S2 6,116 (6,170), probe 4,999 (4,999) | +40 kg: a 40 kg payload adapter the sheet leaves out (separation ring; S2 counts it) |
| solstice-kestrel | 26 | 600,950 (600,950) | 1.32 (1.32) | ferry 1,312 (1,312), RCS 212 (about 210) | none |
| solstice-atoll | 27 | 610,500 (609,700) | 1.30 (1.31) | 434 (434), RCS 88 | +800 kg: the closed fairing is 4,000 kg (one part for Atoll, Pelican and Egret) against the sheet's 3,200 |
| solstice-pelican | 23 | 611,300 (610,500) | 1.30 (1.30) | 5,839 (5,839); ideal ascent 9,899 (9,910) | +800 kg: the fairing, as above |
| meridian-egret | 40 | 2,747,500 (2,750,500) | 1.30 (1.30) | M-3 3,650 (3,650), Egret 6,261 (6,261) | -3 t: fairing 4 t against 7 t; cabin seats 3, not 4 (the Kestrel mould line's seats, which the sheet says the cabin reuses unchanged) |
| meridian-albatross | 40 | 2,745,000 (2,744,200) | 1.30 (1.30) | M-2 6,327 (6,280), cruiser 10,908 (10,908) | +0.8 t: 6.6 m engine interstage (3 t) to house the 6.6 m NTRs, nose cap 6 t; H port on the truss inside the nose cap and the 9.5 m envelope |
| meridian-pelican-heavy | 38 | 2,756,400 (about 2,750,000) | 1.30 | M-3 3,410 with the depot | depot = LH2 tank (50 t) + avionics ring + H port + quads on the flipped M-2/M-3 interstage, under a nose cap; "no new parts" holds (all are fleet parts) |
| meridian-lunar | 42 | 2,756,100 | 1.30 | as flown | untouched |
Atoll: aft H port on the side of the aft section (the engine holds the aft axis), "one H at each end" otherwise.
Solstice uses meridian-launch-clamp x4, M-3 + Vela-2V + 2 RCS pods as the sheet says.

## 6. Pad classes and launches per hour (request fleet-data-4)
Proposed `classLimits`: light 70 t / 2.5 m; medium 700 t / **8.5 m**; heavy 3,000 t / **9.56 m** (LC-1's mount
opening; the heavy stacks are 9.50 m with the M-1 retro-motor ring). Heaviest / widest per class: light 60.5 t,
2.2 m; medium 611.3 t, 8.0 m; heavy 2,756.4 t, 9.5 m. Launches per hour (150 s cycle): heavy vehicles 6 pads = 144;
medium 14 pads = 336; light 25 pads = 600. Mix: 1 light, 3 medium, 4 heavy; offered first: the light and the
three medium (`firstOffer`); cost: the original mission stack and every heavy vehicle share the 6 heavy pads.

## 7. Pads and the terrain guard (for the lead's re-record)
| Site | Pad | Class | Centre (lat, lon) | Elevation m | Flat / blend m | Mount m |
|---|---|---|---|---|---|---|
| ka-lae | lc-1 (unchanged) | heavy | 18.987556, -155.603239 | 21.62 | 450 / 900 | 18 |
| ka-lae | lc-2 | heavy | 18.964261, -155.634430 | 77.65 | 450 / 900 | 18 |
| ka-lae | lc-3 | medium | 18.993334, -155.762263 | 45.14 | 300 / 600 | 10 |
| ka-lae | lc-4 | light | 19.030902, -155.581073 | 157.98 | 150 / 300 | 4 |
| ka-lae | lc-5 | light | 18.930802, -155.654960 | 45.31 | 150 / 300 | 4 |
| ka-lae | lc-6 | light | 19.023833, -155.747167 | 195.09 | 150 / 300 | 4 |
| ka-lae | lc-7 | light | 19.164688, -155.490512 | 72.11 | 150 / 300 | 4 |
| ka-lae | lc-8 | light | 18.942946, -155.640416 | 34.62 | 150 / 300 | 4 |
| ka-lae | lc-9 | medium | 19.004928, -155.769694 | 48.56 | 300 / 600 | 10 |
| madrakah | lc-1 .. lc-4 | heavy | 19.078241, 57.786868; 19.100904, 57.788294; 19.121947, 57.779726; 19.224994, 57.723139 | 144.51; 114.06; 108.50; 89.86 | 450 / 900 | 18 |
| madrakah | lc-5 .. lc-10 | medium | 19.247390, 57.730272; 19.260073, 57.735411; 19.271671, 57.727976; 19.283545, 57.734830; 19.295143, 57.727394; 19.306208, 57.735679 | 97.54; 96.74; 88.45; 91.45; 93.24; 93.15 | 300 / 600 | 10 |
| madrakah | lc-11 .. lc-16 | light | 19.317540, 57.737676; 19.326444, 57.739102; 19.335078, 57.742244; 19.343713, 57.745672; 19.352347, 57.748815; 19.365568, 57.751956 | 92.72; 91.71; 85.64; 83.51; 84.37; 88.52 | 150 / 300 | 4 |

Guard (`tests/unit/terrain-core/terrain-guard.test.ts` height test FAILS as it must): **884 changed points:
pads:ka-lae 289, pads:madrakah 594, site:madrakah 1; uniform, site:ka-lae-lc1 and the Moon 0; none in LC-1's
disc; every changed point inside a new pad's disc** (flat or blend, by `padZoneOf` with the radii above). The
exact list, point by point with group, place, the pad whose disc holds it and the three queries' old and new
heights: `tests/unit/fleet/terrain-guard-pad-changes.json` (by pad: 36-39 per pad; a few points of one pad's
group lie in a neighbour's disc). Ground plans: the terrain renderer's first four pads of Earth are now Ka Lae's
lc-1, lc-2, lc-3, lc-4 (MAX_SITES); views that see those pads may move pixels: the lead's check.

## 8. Reach by refuelling (scope E; tests/unit/fleet/reach.test.ts, staged 32-body library, deltaVToOrbit)
The Albatross raises itself to the depot's high Earth orbit (3,192 m/s, burning 44.5 t LH2), takes it from the
Pelican Heavy (50 t delivered by the M-3 with 384 m/s to spare) and departs with 10,908 m/s. Margins (m/s, best of
direct and refuelled): Mars 7,715, Venus 7,715, Phobos 7,715, Deimos 7,715, Sun (escape) 7,715, Moon 6,862,
Jupiter 6,843, Titan 6,440, Saturn 5,723, Uranus 4,929, Neptune 4,841, Callisto 3,801, Iapetus 3,252, Ganymede
3,172, Triton 2,677, Oberon 2,655, Titania 2,448, Umbriel 2,248, Ariel 2,105, Europa 2,005, Rhea 1,824, Miranda
1,626, Ceres 1,362, Dione 1,304, Io 955, Tethys 811, Enceladus 279. **Not closed (for OPEN_QUESTIONS Q17):
Mercury -1,162, Mimas -382, Pluto -4,808, Charon -5,042.** A kick stage from the fleet's parts does not close them
with one depot: the depot docked as a cross-fed drop tank adds about 0.4 km/s; a third LH2 tank as a drop tank
adds 2.6 km/s but needs about 63 t more at the refuel orbit than one depot carries. Options for the user: a second
depot flight with a drop tank (Mercury, Mimas), or a second cruiser stage or gravity assists (Pluto, Charon).

## 9. Requests filed
fleet-data-1 (lead: join the docking port to ModuleDef / ModuleState; the cast in `asModuleState` goes then);
fleet-data-2 (capability-settings / lead: vessel feature init and two tests of tests/unit/vehicle; BLOCKING for
browser pages); fleet-data-3 (labs and tests taking the library's first vehicle; worked around by the order);
fleet-data-4 (lead: class limits); fleet-data-5 (island-core: refresh port states after structural operations;
`isControllable` by command authority); fleet-data-6 (vehicle-pad: ground surveys for every pad); fleet-data-7
(island-core: the debris test's absolute count). No open request against fleet-data's paths besides
capability-settings-2 (the same as fleet-data-2).

## 10. Known limits and notes
- Entry speed limit is a ballistic-entry estimate (6 deg, the body's convective and radiative flux, the shield's
  ablation law): Kestrel 12.7 km/s. The ladder's default is a patched-conic estimate; deltaVToOrbit is the authority.
- The generic ascent pilot flies the nominal pitch programme of the mission pilot on the lift-off stage; on an
  airless body (`fromSurface`) it overshoots the apoapsis (208 km for a 30 km target) but reaches orbit.
- Payload separations in orbit part in up to 3.4 s (a 2.2 m Lyra-D bell drawn out of its adapter by 6 kN s springs).
- Two flights' pilots for the entry and the lunar landing live in tests/unit/fleet/pilots.ts (test drivers; only
  ascent*.ts and common*.ts of src/pilot/generic are fleet-data's).
- Mistake corrected: commit 6d3c221 carried solar-system-sim's untracked src/pilot/generic/transfer.ts and
  transferMath.ts; 419e94d untracked them again (their working copies untouched).

## 11. For the next packages
- universe-directory: pad counts from the site files (25); class limits from fleet-data-4; `validateVehicle(defs, v, { pad, rules })` on every spawn.
- session-switch: re-run the three flight files of section 3 on LocalSession; `fly()` takes any session.
- bodies-activation: pass `deltaVToOrbit` as `analyzeVehicle(..., { reachCost })`; the refuelled profile is tests/unit/fleet/reachTable.ts.
- contact-docking: ports' state as data (section 1), `refreshPortStates` (fleet-data-5); no vehicle launches pre-docked; the test tandem of validate.test.ts / modules.test.ts is a pre-mated two-craft vehicle.
- fleet-models-pads: 33 parts need visual sections `visuals/parts/<id>.json` (referenced already), plumes/sounds
  (`plume.ntr-hydrogen` for canopus-n), launch complexes for 24 pads (surveys first, fleet-data-6), mounts at
  18 / 10 / 4 m.
- shell-menu: menu text in `visuals/vehicles/<id>.json` (`firstOffer` marks the first offer); capabilities from `analyzeVehicle`.
