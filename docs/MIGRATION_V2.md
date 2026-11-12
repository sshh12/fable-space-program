# Migration to architecture v2

The refactor map from the code as it stands at the end of wave 2 to `docs/ARCHITECTURE.md` (v2): per contract
file and per module, what is kept, what is changed in place and how, what is restructured, in which order
so the tree stays green, who owns every step, and which wave-2 output is at risk. Package ids refer to
`docs/WORK_PACKAGES_V2.json`.

Sources: `docs/research/v2/codebase-audit.md` (the assumption inventory, measured on the tree of
2026-11-10; line numbers below are from it), the three proposals' refactor sections, and the contracts and
tree as read on 2026-11-10. Nothing in this file has been executed.

---

## 1. Principles

1. **Refactor in place, never wrap.** There is one execution path: the island and the universe. The
   single-player mission, every lab, the calibration flight, the client replica and the servers run it.
   `World` is split along its real seams and shrinks until it is deleted; it is never kept beside a
   multiplayer copy.
2. **`SimSnapshot` survives.** About 190 read sites of the singleton blocks in 28 files and 543 uses of the
   `...Root` fields in 106 files keep compiling. What changes is the producer and a small number of fields.
3. **The clock moves to the tick grid first, alone.** v1's clock is not on the v2 grid: the `lunar-direct`
   start is 938240818.839663 s (times 120 is not an integer; every QA scenario is off-grid too), and every
   `advanceRails` re-bases the step grid at an arbitrary float instant (`sim.ts:1389`). A bit-exact guard
   recorded on that clock could never stay green once time is an integer tick. So step 3.1 changes only
   the clock, on `World`: scenario and QA start instants are snapped to a tick (`findStartTime` emits
   tick-aligned values), rails advances land on ticks. That one step is compared against the unchanged
   flight **by envelope**, and the golden hash is re-baselined for it. (Revised 2026-11-12 on
   measurements: a fixed tolerance cannot work. The scripted pilot decides at 30 Hz, so a flight is a
   chaotic function of its start instant: moving only the start of the unmodified v1 code by 2 ms changes
   EARTH_ORBIT by 4.8e-5 in da/a, TLI by 1.6e-3, the lunar touchdown by 47 s and the splashdown by 15 s,
   while the unshifted code reproduces the baseline bit for bit. The mission record
   `tests/mission/baseline-v1.json` is therefore compared in one of two modes,
   `tools/dev/mission-baseline.ts`. **EXACT**, for a step that must not change behaviour and starts at
   the bit-identical instant: every milestone's event time and state equal; the golden hash asserts the
   same for the end state, the record says at which milestone a difference starts. **ENVELOPE**, for a
   step that legitimately moves time, the tick grid and later the session switch: per milestone, the
   flight is about the same body in the same situation as the baseline, and its difference from the
   baseline in event mission time, in da/a, in e and in i lies within twice the largest such difference
   among a recorded set of control flights, which are the reference code with shifted starts and nothing
   else, recorded by the step's owner in a controls file; and the mission's own gates pass. In both, angles are compared as wrapped absolute differences, the true anomaly is never
   compared, and each milestone states how long after its event its state was captured. `sim-core-v2`
   additionally keeps a same-start reference, `tests/mission/reference-v1-aligned.json`: the v1 clock
   started at the tick-aligned instant, which the tick-grid code must equal to 1e-9 through EARTH_ORBIT,
   that is until the first rails advance lands on a tick. **What each check can and cannot catch**
   (independent review of `sim-core-v2`, 2026-11-12; the header of `tools/dev/mission-baseline.ts`):
   same-start equality catches a relative change of about 1e-8 in the integrated ascent and nothing after
   EARTH_ORBIT; the envelope catches about 5e-5 in da/a from the first staging to orbit and is only a
   sanity bound after TLI (0.3-1.6 % in a, 150-1,300 s in event time); rails equivalence in the unit suite
   is self-consistency (the comparison of the rails against v1 was made once and is not a test); the
   mission's gates say that a flight is good, not that it is the same. A change to the coast or to
   anything after TLI is therefore guarded by the gates and by the unit suites of the code concerned, not
   by a mission record.)
4. **After that, numerics do not change.** `stepVessel`'s forces and its RK4 free-flight path, the Kepler
   code and the body maths keep their results. The **trajectory guard** is recorded on the tick-grid
   `World` (step 3.2) and is bit-exact for the attended craft of the lunar mission at 400 sample ticks and
   for six unit fixtures (ascent, staging, entry, touchdown, splashdown, lunar ascent). It was re-recorded
   **once**, by lead authorisation on 2026-11-12, when body orientation, the control tick and the
   sun-visibility sample became fixed functions of the tick (tick-pure state, ARCHITECTURE section 3): a
   recording that depends on the history of rails landings cannot be met by an island, which has no such
   history. The recorded files are pinned by `tools/dev/guard-pins.test.ts`. Debris is compared
   by fate (impact or decay within 2 s and 500 m, or the same orbit), because its stepping tier changes by
   design when the 25 km bubble becomes islands and the Reduced tier.
5. **The golden mission hash is re-baselined exactly five times**, each behind its guard: after the tick
   grid (3.1, envelope), after the id and codec change (3.4, bit-exact guard), once more inside wave 3 by
   lead authorisation for tick-pure state (2026-11-12, together with the one re-record of the trajectory
   guard; it moves the control tick, so the flight moves as it does under a shifted start, and what can be
   asked of it is the envelope of principle 3 and the mission's gates), after `LocalSession` replaces `World` (4.3, bit-exact guard),
   after the Sun-rooted body set is activated (4.4, tolerance 1e-9 relative on positions, since the Sun
   direction changes by rounding).
6. **The tree is green at every commit**: `npm run typecheck`, the unit suites, `tools/dev/boundaries.test.ts`
   and `npm run test:mission` pass; the definition library loads. Contract changes that would break a
   consumer are made as expand, sweep, contract: the lead adds the new fields (step 3.0), the producer
   fills both, the sweep moves the consumers, and the lead removes the old fields when a grep is clean.
7. **One owner per path per sub-wave.** `WORK_PACKAGES_V2.json` lists the owner of every shared path; what
   it does not list is the lead's (ARCHITECTURE section 2).
8. **Risky switches are packages, not chores.** The tick grid, the `World` to `LocalSession` switch, the
   activation of the body set and the app integration each have an owner who can fix the fallout, a gate,
   and a place in the order.
9. **Pixels have a guard too.** Reference images are recorded before wave 3 and compared by every package
   that touches the renderer (ARCHITECTURE 31.3).

## 2. Starting point

- Wave 2 is finished, committed and reviewed; the lead has wired `src/app` against `createSim` and run the
  browser mission. Uncommitted wave-2 work (the tree showed about 30 modified and 10 untracked files while
  this was written) is either committed or discarded before wave 3 starts.
- DONE on 2026-11-11 (`docs/handoff/lead-baseline-v2.md`): `docs/ARCHITECTURE.md` is v2 and v1 is
  `docs/research/ARCHITECTURE_V1.md`; `docs/WORK_PACKAGES.json` is `docs/research/WORK_PACKAGES_V1.json`.
  What the step was: the lead swaps the v2 architecture in (renaming it to
  `docs/ARCHITECTURE.md`, keeping v1 as `docs/research/ARCHITECTURE_V1.md`), replaces the scope note in
  `docs/PACKAGE_RULES.md`, updates its rule 13d to the v2 data cap (22 GB baked, 20 GB of packs in their own
  directory, 25 GB of the disk kept free) and its rule 8 to the new test projects, replaces its
  shared-tree rule with rule (5) of the v2 briefs (the local stack never runs in the background: a
  suite runs as `npm run stack -- [options] -- <command>`, which holds the one `stack` slot until the
  stack has stopped; `npm run stack:client` is the only client build a package may run), and moves
  `docs/WORK_PACKAGES.json` aside for `docs/WORK_PACKAGES_V2.json`.

## 3. Order

Each step leaves the tree green. "Guard" names the test that proves the step changed nothing it should not.

### Lead steps (before each sub-wave; nobody else edits the root configuration)

| When | What the lead does |
|---|---|
| 3.0 `lead-baseline-v2` | Records the baseline on the unmodified tree: mission state hash and the milestone states used by step 3.1's comparison (the mission record, principle 3), unit and browser suite results, the summed GPU budget table, and the **reference images** of every ARCHITECTURE 31.3 checkpoint into `data/baselines/` with a tracked hash manifest and the compare helper in `tests/browser/harness.ts`. Writes the **v2 contracts** (section 4) additively: new files, new fields, deprecated markers on the fields the sweep will retire; nothing is removed yet, so the tree compiles. Adds boundary rules for `src/universe`, `src/session`, `src/net`, `src/client`, `src/shell`, `src/bench`, `src/gate`, `server/`, `bots/` (headless list, the edges of ARCHITECTURE section 2, "no server code in the client bundle"). Adds the class `stack` to `tools/dev/heavy.mjs` (one slot, shared by the local stack and the compose suites of ARCHITECTURE 16.4, and held for the stack's whole life because the launcher is the wrapped command: there is no background mode). Root configuration for wave 3: the `stack` script in `package.json` (`npm run stack` runs `node tools/dev/heavy.mjs --class=stack -- node deploy/local/stack.mjs`, which `platform-delivery` writes; `npm run stack -- [options] -- <command>` runs a suite inside the slot) and a `.gitignore` entry for `data/stack`; **the page a browser loads on the stack** (ARCHITECTURE 16.4): the script `stack:client` (a production client build with CI's Vite configuration, written to `data/stack/client/<source hash>/`, never to `dist/`, under `--class=cpu`, a no-op when the source hash is unchanged), the dev server serving `/endpoints.json` from the file named by `STACK_ENDPOINTS` (absent without a stack), and `tests/browser/globalSetup.ts` starting no server of its own when `STACK_URL` is set and pointing the `functional` and `acceptance` projects at it; `vitest.config.ts` includes `tests/universe`, `tests/load`, `server`, `bots` (and `tests/net` behind `NET=1`, as the mission is behind `MISSION=1`); a Playwright project `acceptance` with `testDir: tests/acceptance`; `tsconfig.node.json` (no DOM) for `server`, `bots`, `deploy` and the headless `src` directories, run by `npm run typecheck`; a CI-only build script that writes outside the shared `dist/`. Installs the dependencies of wave 3 (an S3 client and presigner for the pack tools; `embedded-postgres` and `pg` with its types for the local stack). At a moment when no WSL workload runs, writes the Docker VM cap of ARCHITECTURE 16.4 into `%UserProfile%\.wslconfig` and tells the user (OPEN_QUESTIONS, "Small things") |
| during sub-wave 3.1 (2026-11-12, after the independent review of `sim-core-v2`) | **Two decisions and their contract side.** (i) *Tick-pure state* (ARCHITECTURE 3, 5.2, 7.2): body orientation, the control tick and the sun-visibility sample are fixed functions of the tick, not of the session's history of rails landings, so the state of an island at a tick is a function of the tick and its vessels alone and no clock base is carried. For it the lead authorised **one more re-record** of the trajectory guard and of the golden hash (principles 4 and 5). The recorded files (the trajectory guard, its unit fixtures, the same-start reference and the control flights, which `sim-core-v2`'s hand-off lists as never to be re-recorded) are **pinned by `tools/dev/guard-pins.test.ts`**: `sim-core-v2` adds that one file in the lead's path by the lead's authorisation, the lead reviews it when it lands, and from then on a re-record is a visible change to the pins that only the lead makes. (ii) *Craft identity* (ARCHITECTURE 3, 7.2, 7.5): craft ids are universe-unique; at assembly every tree joined by a dock link is its own craft; at a separation the piece keeping the command root keeps the id and each departing piece gets a new id with lineage; re-docking former pieces is ordinary docking. **Contracts** (additive, 537da5f): `CraftSnapshot.cockpit` (cockpit id, camera seat, sensor mount of the craft's command part; optional until the tighten step); pad limits as rules data (`UniverseRules.pads.classLimits`, defaults `DEFAULT_PAD_CLASS_LIMITS`, provisional; `PadDef.maxLiftoffMass` / `maxDiameter` optional overrides; no `Infinity`); craft ids and instance ids contain neither `/` nor `~`; `advanceRails` lands on the first tick at or after the target. **Rules files are stored as overrides of the default document** (`sim-core-v2` changes the loader and `tools/sim/writeRules.ts`; the library still holds complete documents). Until the loader reads them that way it holds every file to exactly the fields of `DEFAULT_UNIVERSE_RULES`, so a field added to that document fails the library load; that is why the class limits are a constant beside it today. **As soon as the override loader has landed, the lead moves `DEFAULT_PAD_CLASS_LIMITS` into `DEFAULT_UNIVERSE_RULES.pads.classLimits` and makes the field required** (one commit in the contracts, `net.test.ts` already holds the two equal). The mission record's ENVELOPE now also fails on a body or situation mismatch and judges e and i (7bfbcd5) |
| before 3.2 | Reviews 3.1; hands the presentation sweep the list of deprecated fields. **Records the reference images** on the visually signed-off tree, frame-exactly (`window.__test.renderExact`, request lead-3; three loads per checkpoint; `tests/browser/shell/baselines.record.spec.ts`), after framing the checkpoints whose page is null. **Joins what step 3.0 could only declare** (each has an exhaustive consumer the sweep now owns, which gains its entries in the same sub-wave): `SasTargetMode` into `SasMode` (`src/input/bindings.ts`, `src/ui/hud/hud.ts`), `NavballModeV2` into `NavballMode` (`src/camera/chaseRig.ts`), `ButtonActionV2` into `ButtonAction` (`src/input/bindings.ts`), `MarkerKindV2` into `MarkerKind` (`src/map/scene.ts`), `MfdPageV2` into `MfdPage` (`src/ui/mfd/mfdPainter.ts`); changes `PlayerCommands.setTarget` to `(ref: TargetRef \| null)` with its call sites and implementations; adds the key `'ui.scrimRects'` to `SharedResourceMap` with the core's default |
| after 3.2 | **Contract tighten**, also: makes the v2 fields that step 3.0 added as optional required once every producer fills them (`SimSnapshot.revision`, `.frame` with `previous`, `.time`; `VesselSnapshot.crafts`, `.links`, `.helm`, `.presence`, `.timeOffset`, `.revision`; `PartSnapshot.craftId`, `.stageGroup`, `.stageLabel`; `Readouts.target`, `.docking`; `NavballMarkers.relativePrograde`, `.relativeRetrograde`; `LaunchSiteDef.pads`; `CraftSnapshot.cockpit`, after which no consumer reads `defs.vehicles` for a cockpit); **event part ids become the part key in one form** (`partId`, `otherPartId`, `partsDestroyed` carry `craftId/instanceId` always: `eventPartId` in `src/sim/vessel/ids.ts` returns the key for a vessel of one craft too, the paragraph on the two forms leaves `SimEvent`, and the sweep's consumers compare keys); makes `SimSnapshot.activeVesselId` `string \| null` and `scenario` nullable; makes `VehicleDef.cameras.cockpit` optional; removes the aliases `Sim` and `SimDebug`. And: removes the deprecated fields (`SimSnapshot.tick`, `Readouts.targetBodyId`, `.targetClosestApproach`, `LaunchSiteDef.pad`, the `pause` action, the `createSim` export) and their producers once the sweep's grep is clean; lifts `TilePackIndex` from `platform-delivery`'s file into `terrain.ts` |
| with `fleet-data` (wave 4) | **Sets the pad class limits** from `fleet-data`'s table of the fleet's lift-off masses and stack diameters (`DEFAULT_UNIVERSE_RULES.pads.classLimits`, ARCHITECTURE 9.3). Today's defaults are provisional: heavy is what LC-1 states (3,000 t, 8.7 % over the 2,760 t lunar stack; 9.5 m, which is under the 9.56 m opening of LC-1's own mount: settle whether the class or the mount is the limit), medium and light are the research's sheets rounded up. A pad states its own `maxLiftoffMass` / `maxDiameter` only where it differs from its class |
| before 4.1 | Joins `DockingPortModuleDef` into `ModuleDef` and `DockingPortState` into `ModuleState` (with the cases in `src/sim/vessel/assemble.ts` and `labs/audio/labVehicle.ts`, which switch over every module type), and `AudioBusNameV2` into `AudioBusName` (with the buses in `src/audio`). Appends the new sites and pads to the terrain guard (`terrain-guard.record.ts --add-place`, then `--resample` once the flatten discs have landed and only points inside them changed). Installs wave 4's dependencies (`ws` and its types, `fflate`); registers the gate plugin and the definition-bundle plugin (`defsHash`) in `vite.config.ts`; signs off the island API (`src/sim/island/api.ts` signatures) and the navigation signatures the view calls; hands `net.ts`'s wire-message section to `wire-protocol` and `universe.ts` to `universe-directory` |
| with 4.1c (`solar-system-sim`) | Adds 1,000,000x and 10,000,000x to `WARP_LEVELS` (nine rails levels) and makes `BodyDef.warpAltitudeLimits` optional, in the same commit as the body-system change that defaults absent limits from the radius: the two levels alone fail the library load, because every attractor must list one limit per rails level and the shipped bodies list seven. The same change makes the provider honour `BodyTerrainDef.residentLevel` (the per-body cap on the resident coarse levels, request bodies-ephemeris-3: `min(manifest.residentHeightLevel, residentLevel)`) |
| after 4.3 | **Second tighten**: the 19 v2 commands of `PlayerCommands` and `FlightSession.universe`, `.stores`, `.planning` become required (`World`, which had none of them, is gone); `Renderer.setQuality` once `capability-settings` has it |
| at 4.4 (`bodies-activation`) | **Decides the two pinned-body discrepancies** that `bodies-ephemeris` measured, before the staged set goes live. (a) Earth keeps the Almanac Sun formula (inverted), which is in the equinox of date: its frame is 0.84 degrees from the J2000 frame the other planets' elements are in. (b) The Moon keeps its frozen ellipse, which drifts up to 162 degrees from the real Moon. Both were pinned so that the lunar mission's windows do not change (decision 36); the price is that Earth sits 0.84 degrees off against the other planets and the Moon is not where the real Moon is. The lead decides at activation whether to keep both pinned or to re-reference one or both (precess the Almanac vector into J2000; give the Moon its rates), with **the lunar mission as the gate** either way: `findStartTime` reproduces `start-time.json` and the mission passes within the activation tolerance, or the start is re-derived and the mission is re-proven on it and the golden re-baselined with a note. The choice and its numbers go into the activation hand-off and, if it changes what a player sees, into OPEN_QUESTIONS |
| before 5.1 | Adds the Playwright `net` and `app` directories to the functional project (`pg` is already installed); turns the wave-3 platform measurements on the stage-0 skeleton (billed memory idle at 12 and 72 hours, the deploy overlap and drain, the build time, the first-session bytes, what the CDN does with `Range`, the workspace's usage) into the sizing settings of wave 5: the replica limits, the stage-0 admission cap, the tile-store cap, the mirror's mode and slice size, the daily egress budgets. If the user has answered OPEN_QUESTIONS Q2 with "Pro from the start", records it and has the skeleton moved before wave 5 builds on it |
| between 5 and 6 | Play-tests the time rules (U6, U8, U9 defaults) with two browsers on the local stack and writes the result into OPEN_QUESTIONS Q7; moves the release tag and the `release` branch |
| during 6 | Moves the release tag and the `release` branch between load-test ramps; merges fixes only between ramps. **The Q19 checkpoint**: when `deploy-loadtest` has written `docs/capacity/<date>-stage0.md` and filed its request, puts OPEN_QUESTIONS Q19 to the user with the measured stage-0 numbers and the prices of ARCHITECTURE 30, and records the answer and its time under Q19 (a yes also needs the workspace on Pro); the package continues with programmes 2 and 3 on a yes, and after 48 hours without one finishes with the estimates wording. Before any move up the ladder of ARCHITECTURE 16.2 on production, tells the user what it will cost and records the answer in OPEN_QUESTIONS. Runs `deploy/stage.mjs status --push` at every release so the workspace's usage is on `/ops` |

Packages never run `npm install` and never edit a root file; a brief lists what the lead provides.

### Wave 3

| Step | Package | Change | Guard |
|---|---|---|---|
| 3.1 | `sim-core-v2` | **Tick grid on `World`**, nothing else: start instants on ticks (`findStartTime`, `start-time.json`, the QA scenarios), rails advances land on ticks | The mission record against the lead's baseline in ENVELOPE mode with the owner's control flights (principle 3), and the same-start reference to 1e-9 through EARTH_ORBIT; mission passes; golden re-baseline 1 |
| 3.2 | `sim-core-v2` | Record the **trajectory guard** on the tick-grid tree (principle 4) | The file itself |
| 3.3 | `sim-core-v2` | Vessel model: `crafts[]`, `links[]`, `helm`, `PartRuntime.craft`; per-craft stage state; flow groups `(craft, stageGroup)`; crew, cockpit and seats on the command part; craft ids from a seeded source; the id rules of ARCHITECTURE 3; `separateVessel` over tree edges and links; a momentum-conserving **dock merge added beside** `mergeVessels`, which stays as the weld of released clamp pieces into one held ground structure (it is not a dock: those pieces have no ports) | Trajectory guard, clamp vessel included; momentum tests to 1e-9 |
| 3.4 | `sim-core-v2` | The non-derived members of `Vessel.struct` become vessel state; the **versioned** binary codec (version, `defsHash`, vehicle reference kinds through a resolver, part fingerprints, length-prefixed blocks, the migration registry); `stateHash` over codec output | Codec round trip exact mid-touchdown and mid-entry; a fixture written by the previous version decodes; golden re-baseline 2 |
| 3.5 | `sim-core-v2` | `World` speaks v2: fills the new snapshot fields (`frame` with rebase at SOI changes, a trivial `time` block, craft blocks, per-part stage group and label, `revision`) while still filling the deprecated ones; `src/session/index.ts` exports `createSession`, returning `World` typed as `LocalSession`; `createSim` stays as a deprecated alias until the tighten step | Mission passes; trajectory guard |
| 3.6 | `sim-core-v2` | Site model: `pads[]`; site id `ka-lae`; flatten discs derived from pads; the loader's overlay `DefSource` (a second root for staged bodies) | Start-time constraints test; terrain unit suites; terrain guard |
| 3.7 | `bodies-ephemeris` | 32 body definitions generated and validated against Horizons into `data/staged/bodies/` | The files compile against the lead's v2 `BodyDef` and pass the tool's validation; loading through the loader's overlay source is `solar-system-sim`'s first check in wave 4; `data/defs` untouched |
| 3.8 | `planet-bake` | Pyramids for the 25 new solid bodies and the giants' global maps into `data/tiles/<body>/`; new amplification models as **new files** (`common.ts`, `lunarRegolith.ts`, `earthLandcover.ts` are frozen) | **Terrain guard** (height at fixed points on Earth and Moon, bit-exact, plus the tile hash list), recorded first |
| 3.9 | `site-bake` | The Madrakah region into the `earth` tile set (tiles written to a staging directory, the manifest swapped in atomically at the end); 16 pads resolved per site into `data/staged/sites/` (the tool takes the site id and location as arguments, so the rename of 3.6 does not matter) | Terrain guard; existing tiles byte-identical |
| 3.10 | `platform-delivery` | Tile packer, `createTileSource(spec)` with the `pack` kind, the boot pack (uploaded to the `packs` bucket, with a tracked `deploy/boot-manifest.json`; `shell` loads it at start), OPFS cache, the two buckets and the mirror tooling, the program entry with its role manifest, the static roles `shell`, `packs` and `dump` with their egress budgets and the endpoint document (**not the publisher: `pub` has one implementation, in `server/`, written by `server-persistence` in wave 5 and started as `ROLES=pub` when it becomes a service**), CI and the image, the local stack (`npm run stack` on host processes with an embedded Postgres created as UTF8 with the built-in locale; the launcher holds the `stack` slot; the compose form for the pinned-image suites), the stage-0 skeleton on Railway's Hobby plan, first cloud measurements | Byte-identity sweep on earth and moon; a main-thread and a worker browser page; terrain hash at fixed points |
| 3.11 | `presentation-sweep` (sub-wave 3.2) | Every presentation consumer once (`revision`, nullable active vessel, part keys, command-part lookups, `Readouts.target`, `flightMenu`, no `defs.vehicles[...]` by a runtime id); frame rebase; `FakeSession` with conformance tests; `TileSourceSpec` in the tile workers' init; the scrim step, `exposureHint` and `lensShift` in the render core; `src/app`, `labs/integration` and the tests moved to `createSession` | Typecheck of the whole tree; every wave-2 lab spec; **reference images**; the budget table |

### Wave 4

| Step | Package | Change | Guard |
|---|---|---|---|
| 4.1a | `island-core` | `src/sim/island` built from `World`'s per-vessel state machine, rails advance, SOI hand-over and reduced tier; the step loop keeps v1's RK4 path and enters the sub-stepped path only as ARCHITECTURE 6.2 says (pair pass empty this wave); the two step modes; structural operations as data; the island codec. `src/sim/view` built from `World`'s snapshot, readout, navball, patch, node and burn code. **`World` shrinks in place to a thin single-clock host over islands and the view builders** | An island of one equals `stepVessel` bit for bit (trajectory guard); snapshot equality against the wave-3 `World` on recorded states; mission passes on the shrunk `World` |
| 4.1b | `wire-protocol` | `src/net`: codec for every message, framing, transports, injector, and the **session layer** (handshake, resume, subscription and budget state machines for both ends, with recorded transcripts) | Round trip of recorded fixtures in Node and in Chrome |
| 4.1c | `solar-system-sim` | Generic body-system changes, prediction and navigation at solar-system scale, the transfer pilot, `deltaVToOrbit` (reach), `tools/bodies/activate.mjs`; `src/terrain` for `surfaceRadius`, no-surface bodies, small pyramids and lazy per-body residency | Every existing sim-orbits test on the 3-body library; terrain guard; `data/defs/bodies` untouched |
| 4.1d | `fleet-data` | Parts, assemblies, vehicles, sites with 16 pads each; loader support for `uses`; `validateVehicle` and `analyzeVehicle` in `src/sim/vessel`; generic ascent pilot; flight scenarios for its vehicles | Library loads at every commit; `meridian-lunar.json` byte-identical |
| 4.1e | `shell-menu` | `src/shell`, menu rigs, input contexts, audio buses, Credits and Practice screens; owns `src/core/fakes` | Wave-2 flight-ui and map specs |
| 4.1f | `capability-settings` | `src/gate`, `src/bench`, `QualityProfile` in the core and every feature, `acquireGpu` change; owns `labs/integration` | Ultra reproduces every wave-2 perf line and the reference images |
| 4.2 | `universe-directory` | `src/universe` (directory, clocks, rules U1-U19 and U8b, reservations, forecast chains, screening, pads, expiry, objectives, the scheduler interface, `UniverseHost`) and `LocalSession` in `src/session`, **beside** `World` | `tests/universe`; the mission flown on `LocalSession` equals the mission on `World` (trajectory guard) |
| 4.3 | `session-switch` | **Gated switch**: `createSession` returns `LocalSession`; the mission, the labs, `tests/browser/integration` and the tools run on it; `src/sim/world` is deleted | Gate: the trajectory guard, the mission, and the flight suites of `solar-system-sim`, `fleet-data` and `capability-settings` (their hand-offs list the commands) all pass on `LocalSession`; golden re-baseline 3 |
| 4.4 | `bodies-activation` | The Sun-rooted body set goes live (`tools/bodies/activate.mjs`): staged definitions and `credits.json` move into `data/defs`, `findStartTime` must reproduce `start-time.json`, QA scenarios re-captured | Start time reproduces; mission and guard within 1e-9 relative; reference images of Earth and Moon and the budget table unchanged; provider creation time and memory with all 27 terrain bodies bounded; the reachability table has a positive margin for every body or the gap is reported (Q17); golden re-baseline 4 |
| 4.5 | `app-integration-1` | `src/app`: gate, shell state machine, calibration applied, `LocalSession`, the planning service in process, settings | Browser mission through the shell; menu to pad; the v2 budget columns that exist at this point |

Until step 4.3 every wave-4 package that flies (the Mars transfer, the seven ascents, the calibration
shots) flies on `createSession` as it is, that is on `World`. Only `meridian-lunar` has visuals in wave 4
(new parts get theirs in wave 5), so the menu's vehicle selection and the calibration are verified in the
browser with `meridian-lunar`; the other vehicles are verified headless.

### Wave 5

| Step | Package | Change | Guard |
|---|---|---|---|
| 5.1a | `contact-docking` | Colliders, the island pair pass, swept tests, damage regimes, docking merge and undock, assembly ids, helm and lend rules, transfer, reservation and first-touch commit, screening wired into the directory; owns `src/core/defs` for link and port validation | Trajectory guard (pair pass on, born-overlapping rule); mission passes |
| 5.1b | `server-persistence` | `server/`: roles that run combined in one `game` process (stage 0) or split across services (stage 2) by configuration, the publisher as the one implementation of that role (with its request and byte budgets), the idle state with its warm and light levels, the lease, Postgres writer and schema, journal and recovery, the trailing-lane executor with the lane-equivalence and migration suites, identity API, rules, admission, the operator fault commands, metrics including the cost numbers and `usage_hour` | Restart, recovery and replay suites in the pinned image (compose), in the combined and the split shape, with the stage move in both directions; everything else on the host stack |
| 5.1c | `netcode-client` | `NetSession` (replica, prediction, stores, identity key, reconnect) on the session layer of `src/net`; the endpoint-document reader (candidates in order, re-read before every reconnect attempt); the planning providers and the chooser | `tests/net/client` |
| 5.1d | `planet-render` | Simple bodies, giants, rings, other atmospheres, exposure range, the pack source in the app's tile workers; ground checkpoints at the new pads | Reference images of Earth and Moon; budget table |
| 5.1e | `fleet-models-pads` | Visuals for the new parts, pad structures per class at both sites, many-vessel presentation, the sensor-camera surface, new plumes and sounds | Wave-2 vehicle, cockpit and vfx specs; the pad-row budget column |
| 5.2a | `net-joint-gate` | One headless `NetSession` against the real server on the local stack, found through the stack's endpoint document: handshake, spawn, ascent, disconnect, resume; then two clients, a collision and a docking; the stage move with clients in flight. It owns `deploy/local` this sub-wave, so the first defects real clients find in the launcher are its to fix | The joint suite; no second implementation of the session protocol exists |
| 5.2b | `map-multiplayer` | Census layer, targets, intercepts across spheres of influence, proximity plot, solar-system navigation | Wave-1 map specs |
| 5.2c | `flight-hud-multiplayer` | Time strip, target and docking instruments, nameplates, roster, prompts, port and sensor rigs; owns `src/core/fakes` | Wave-1 HUD specs |
| 5.3 | `app-integration-2` | `src/app`: `NetSession` against the local stack, connection states, stores, the pack source and OPFS cache, the planning worker | Two browsers launch, meet and dock on the local stack; v2 budget columns |

### Waves 6 and 7

`deploy-loadtest` (production at stage 0 on the Hobby plan, the rollout, stage and scale scripts,
rehearsal environments, the bot fleet, the cost readings and the capacity report) and
`acceptance-multiclient` (`tests/net` scenario matrix, `tests/acceptance`, on the local stack) run in
parallel on disjoint paths. Only one local stack runs at a time: each suite takes the `stack` slot for
its own duration (`npm run stack -- ... -- <suite>`), with the package's own stack name for its data
directory, so the two packages take turns on the machine instead of loading it together. Nothing deploys
from `main`, the lead moves the release tag, and every report row names its build. `deploy-loadtest` has
one fixed checkpoint: after programme 1 it hands its stage-0 numbers to the lead, who asks the user about
the larger rehearsals (OPEN_QUESTIONS Q19) before programmes 2 and 3 can run. The deployed game is the smallest stage
of ARCHITECTURE 16.2: the same code, schema and data move up the ladder by configuration and deploys, and
the larger stages are measured only in rehearsals the lead has announced to the user. `final-gate` (wave
7) re-proves everything on the final tree and on production, including the monthly cost projected from
measured usage (ARCHITECTURE 31.5). The lead enables `lagCap > 0` only on the evidence ARCHITECTURE 6.2
names.

---

## 4. Contracts, file by file (`src/core/contracts`)

Written by the lead in step 3.0 (additive), tightened after 3.2. Presentation compiles against them from
the first day of wave 3.

| File | Verdict | Change |
|---|---|---|
| `sim.ts`: header, frames | changed in place | "ROOT" is documented as the render root (ARCHITECTURE 3). The field names `rRoot`, `vRoot`, `positionRoot`, `posRoot`, `qFixedToRoot`, `spinRoot`, `bodyPosAtEnd` stay. Added `SimSnapshot.frame { epoch, origin, rebase }` |
| `sim.ts`: `SimSnapshot` | kept, extended | `revision` added (`tick` deprecated, removed at the tighten step; 10 files). `activeVesselId: string \| null`; the singleton blocks always present with neutral values (`neutralFlightBlocks()` in `src/sim/view`). Added `time: TimeView`; `warp` stays, derived from it. `scenario` becomes nullable; `milestones`, `mission` and `cheatCounter` describe the active craft's objectives and are empty / not failed / 0 without them |
| `sim.ts`: `VesselSnapshot`, `PartSnapshot` | extended | `crafts: CraftSnapshot[]` (id, vehicleId, owner callsign, name, stage info, chase-camera hints, and `cockpit`: the cockpit id, camera seat and sensor mount of the craft's command part, resolved), `links`, `helm`, `presence`, `timeOffset`, `boundingRadius`, `presentation?`. `vehicleId` stays (the base craft's) for labels only. `PartSnapshot.craftId`, `.stageGroup`, `.stageLabel`; `instanceId` is unique within the craft. Craft ids are universe-unique; craft ids and instance ids contain neither `/` nor `~` |
| `sim.ts`: `ModuleState`, `Readouts`, `NavballMarkers`, `MarkerKind` | extended | `dockingPort` state; `Readouts.target: TargetReadout \| null` (`targetBodyId` and `targetClosestApproach` deprecated); `Readouts.docking`; `relativePrograde` / `relativeRetrograde`; `MarkerKind 'targetApproach'` with `otherVesselId` and the pair positions |
| `sim.ts`: `SimEvent` | extended | `dockCapture`, `docked`, `captureLost` (reasons include `occupied`), `undocked`, `collision`, `helmChanged`, `commandResult`, `claimLost` (with the offer by relation), `proximityWarning`, `padReleased`, `clockChanged`, `rangeClearing`; `partDestroyed.cause 'collision'`; `vesselRemoved.reason` gains `rolledBack`, `recovered`, `lost`, `pressure`; every event carries `provisional` until durable. Event part ids have two forms until the tighten step after 3.2 (instance id in a vessel of one craft, part key in a vessel of several; the v2 events carry keys always) and are part keys in one form from then on. `activeVesselChanged`, `warpChanged`, `milestone`, `missionFailed` are per session |
| `sim.ts`: `Sim`, `SimDebug` | restructured | Moved to `session.ts` as `FlightSession` and `LocalSession`. A `Sim = LocalSession` alias exists only during wave 3 |
| `controls.ts` | extended in place | `CommandResult.pending`, `.cmdId`. `NavballMode 'target'`. `SasMode 'target' \| 'antiTarget' \| 'portAlign'`. `PlayerCommands`: `setTarget(ref: TargetRef \| null)`; `setWarpLevel` documented as a time request; `cycleActiveVessel` re-documented; added `warpTo`, `jump`, `hold`, `link`, `unlink`, `follow`, `meet`, `replyProposal`, `askAdvance`, `armPort`, `undock`, `setControlPoint`, `requestHelm`, `grantHelm`, `releaseHelm`, `setLendPolicy`, `setAdvanceLimit`, `transfer`, `setCrossfeed`. `ButtonAction`: `flightMenu` added (`pause` deprecated); added `cycleTarget`, `toggleRoster`, `dockingView`, `openQuickComms`, `acceptPrompt`. `InputFrame.context`. `Pilot` unchanged |
| `defs.ts`: bodies | extended in place | `KeplerOrbitDef.rates`, `.meanMotionDegPerDay`, `.frame` pole variant; `SunLowPrecisionOrbitDef.inverted`; `soiRadius 'auto'` rule; `shape`; `surface`; `rings`; `atmosphere.floorAltitude`; `warpAltitudeLimits` optional. `gravityRole 'lightOnly'` stays valid and unused |
| `defs.ts`: sites | restructured | `LaunchSiteDef.pads: PadDef[]` (`pad`, `padAzimuthDeg`, `structures` deprecated until the tighten step); `SiteLocationDef` per pad. `PadDef.maxLiftoffMass` / `maxDiameter` are optional overrides of the class limits in the rules (`UniverseRules.pads.classLimits`); no pad is without a limit |
| `defs.ts`: parts, vehicles | extended in place | Attach-node `kind`, `rollStepDeg`; `surfaceAttach`; `symmetry`; `collision`; `crossfeed`; `crashTolerance`; `resources[].transferable`; categories `dock`, `habitat`; `ModuleDef 'dockingPort'`; `command.remote`, `.cockpit`, `.sensorCamera`; `StageAction 'undock'`; `VehicleDef.uses`, `.padInterface`, `cameras.cockpit` optional; `AssemblyDef` |
| `defs.ts`: scenarios, library, constants | changed in place | `ScenarioDef` keeps its fields, gains `pad`, and is documented as a spawn recipe plus optional objectives. `DefLibrary.assemblies`, `.rules`. `WARP_LEVELS` gains two levels (`RAILS_WARP_LEVEL_COUNT` 9) |
| `vehicle.ts` (new) | - | `VehicleCapabilities`, `Issue`: the data the shell's stores and the generic pilots receive from `analyzeVehicle` and `validateVehicle` |
| `simInternal.ts` | extended in place | `VesselEnvironment.origin?` (reference-orbit state at the start of the step). The "describes the start of the step" rule stays. Contact with other vessels does not go through the environment |
| `render.ts` | kept, small edits | `QualitySettings` becomes `QualityProfile`; `FeatureQualityDecl`; `Renderer.setQuality`; `CameraState.exposureHint`, `.lensShift`; `'ui.scrimRects'`; a `presentation` flag on vessel poses. "Active vessel" wording stays true per client. `OCEAN_WETNESS_SLOTS` stays 8 (nearest first) |
| `ui.ts` | extended | `MfdPage 'target' \| 'docking'`; `MapView.update(..., census)` with filter state and preview time; focus refs include sites and players; `Hud` takes the client stores; `SettingsModel` |
| `audio.ts` | extended | `AudioBusName 'music' \| 'comms'` |
| `testApi.ts` | extended | `net()`, `stores()`, `sessionKind`; `setPaused` is local-only |
| `terrain.ts` | kept, extended | `TileSourceSpec` (`fs`, `fetch`, `pack`). `TilePackIndex` is defined by `platform-delivery` in `src/terrain/packIndex.ts` and lifted here by the lead afterwards. `TileSource`, `TileManifest`, the coverage rules and `TerrainProvider` are unchanged; residency becomes lazy per body |
| `sky.ts` | kept | - |
| `session.ts` (new) | - | `FlightSession`, `LocalSession`, `UniverseCommands`, `ClientStores`, `PlanningService`. `LocalSession.advanceRails(targetUt)` lands on the first tick at or after the target (or after the next event when that comes earlier) |
| `net.ts` (new) | - | Lead: `UniverseRules` (every number of ARCHITECTURE 5, 7.4-7.6, 9.4, 15.5 and 26 with its default; no chat flag; the pad class limits `pads.classLimits`; a rules file is stored as overrides of the default document), `ClockState`, `TimeView`, `CensusEntry`, `TargetRef`, the view models (`LobbySummary`, `PadState`, `ShipRecord`, `AssemblyView`, `RosterEntry`, `FeedEvent`, `CapabilityReport`). The wire-message section (every message of ARCHITECTURE 13.3, `InputAck` included) is written and owned by `wire-protocol` from wave 4 |
| `universe.ts` (new) | - | Written and owned by `universe-directory` from wave 4: `UniverseHost`, record types, `UniverseStorage`, `WallClock` and up-time (the injected interfaces of `src/universe`) |

## 5. Modules

| Module | Verdict | What happens | Package |
|---|---|---|---|
| `src/core/math`, `src/core/geo` | keep | Added `math/frame.ts` (rebase helper), by the lead in step 3.0. A deterministic maths module is not built | lead |
| `src/core/defs` | extend in place | Pads, rules documents, the overlay `DefSource`; assemblies and `uses`; structural checks only (`validateVehicle` is in `src/sim/vessel`); link and port validation | `sim-core-v2` (3.1), `fleet-data` (4.1), `contact-docking` (5.1) |
| `src/core/fakes/fakeSim.ts` | extend in place | Becomes `FakeSession` with multi-vessel, target, docking, echo and time scenes, each with a conformance test against `LocalSession` | `presentation-sweep` (3.2), `shell-menu` (4.1), `flight-hud-multiplayer` (5.2) |
| `src/core/gpu/device.ts` | change in place | Reports the adapter class, no longer throws on `looksIntegrated` | `capability-settings` |
| `src/sim/orbit` | keep, fix, extend | Per-patch horizon; SOI step floor; adaptive closest approach; vessel-against-vessel closest approach; Lambert and phase helpers; warp levels. Conic-against-conic screening, forecast chains and jump planning are new files under `src/sim/orbit/conjunction/` | `solar-system-sim`; `universe-directory` for `conjunction/` |
| `src/sim/bodies` | extend in place | Sun as root attractor; inverted Almanac orbit; rates and pole frames; SOI rule; spheroid altitude; no-surface bodies; `sunVisibility` restricted to the current planet system | `solar-system-sim`; `bodies-activation` |
| `src/sim/frames`, `src/sim/nav` | keep, extend | Target-relative navigation (relative state, port alignment, LVLH) behind signatures the lead fixes before wave 4; `buildSurfaceTargets` takes every site. The view calls them; `island-core` wires `Readouts.target` for vessel targets | `solar-system-sim`; port alignment in `contact-docking` |
| `src/sim/vessel` (`types`, `assemble`, `split`, `staging`, `structure`, `facade`, `massProps`, `codec`, `migrations`) | restructure the data model, keep the algorithms | Steps 3.3 and 3.4. `public.ts` keeps its signatures; `splitForStage` and the snapshot helpers gain craft ids; `mergeVessels` stays as the ground-structure weld | `sim-core-v2` (3.1), `island-core` (4.1), `contact-docking` (5.1) |
| `src/sim/vessel/analyze.ts`, `validate.ts`, new files under `modules/` | new | `analyzeVehicle`, `validateVehicle` (shares the assembler and collider code), module behaviour of new parts | `fleet-data` |
| `src/sim/vessel/clearance.ts` | extend in place | Becomes the collider library: authored shapes, GJK distance with closest features, conservative advancement | `contact-docking` |
| `src/sim/dynamics` | keep force models and the RK4 path; restructure the loop | `stepVessel`'s force evaluation and write-back are called by the island loop; free flight stays RK4 at 120 Hz with the semi-implicit attitude update, the sub-stepped path is entered only by a ground probe within 5 m or by a pair inside the speculative-contact margin (both vessels, same tick); optional origin (Encke); `failure.ts` reaches other vessels; a `predict` mode that suppresses threshold transitions (in `modules/parachute.ts` too) | `island-core` (loop, origin, predict mode), `contact-docking` (pair forces, damage) |
| `src/sim/control` | keep | Target hold directions arrive as vectors, as the maneuver direction does today | - |
| `src/sim/world/sim.ts` (`World`, 2,531 lines) | **tick grid, shrink in place, then delete** | 3.1: the clock moves to the grid. 4.1: per-vessel state machine, `advanceOnRails` with exact events, SOI hand-over, reduced tier, terrain policy move to `src/sim/island`; snapshot building, `present()` interpolation, readouts, navball, patches, nodes, burn bookkeeping, surface targets move to `src/sim/view`; `World` keeps only the single active vessel, the warp ladder and island formation about the active vessel. 4.2: the clock schedule, pads, objectives and expiry exist in `src/universe`. 4.3: deleted with the single `active`, `controls`, `warpIndex`, the 25 km bubble, `MAX_DEBRIS`, `failMission`, the O(n) loop and the O(n^2) proximity rule | `sim-core-v2`, `island-core`, `session-switch` |
| `src/sim/world/milestones.ts` | keep, move | The objective observer of `src/universe`, attached to one craft | `universe-directory` |
| `src/sim/world/terrainPolicy.ts`, `environment.ts`, `scenarioStart.ts`, `stateHash.ts` | keep, generalise | Terrain slots per vessel in the island; start poses become spawn poses on a pad; the hash is over codec output | `island-core`, `universe-directory` |
| `src/sim/index.ts` | change in place | Exports no session after the tighten step; `createSession` lives in `src/session` | `sim-core-v2`, lead |
| `src/session` | new, headless | `createSession`; in wave 3 it returns `World`; `LocalSession` over `src/universe` from 4.2; the switch in 4.3. Importers (`tests/mission/harness.ts`, `tools/sim/realWorld.ts`, `labs/integration/features.ts`, `src/app`) move to it in wave 3 | `sim-core-v2`, `universe-directory`, `session-switch` |
| `src/universe`, `src/net`, `src/client`, `server/`, `bots/`, `deploy/` | new | ARCHITECTURE sections 5-7, 13-17. The session protocol exists once, in `src/net` | `universe-directory`, `wire-protocol`, `netcode-client`, `server-persistence`, `platform-delivery`, `deploy-loadtest` |
| `src/pilot` | keep, extend | `runner.ts`, `core.ts`, `attitude.ts`, `guidance.ts` drive a `FlightSession`. `missionPilot.ts` stays the Earth-Moon proof; its "root body" reasoning is re-validated at activation. New generic pilots: ascent to orbit for any vehicle, rendezvous, docking, interplanetary transfer; shared helpers in `generic/common*` | `sim-core-v2` (interface), `fleet-data` (ascent, `common*`), `solar-system-sim` (transfer), `contact-docking` (rendezvous, docking) |
| `src/terrain` | keep, extend | `createTileSource(spec)`, pack source and OPFS cache; generic amplification models as new files; flatten discs from pads; body shape; lazy per-body residency; the server-side shared tile store's interface | `platform-delivery`, `planet-bake`, `sim-core-v2`, `solar-system-sim`, `bodies-activation`, `planet-render` |
| `src/render/core` | keep, extend | Frame rebase, scrim step, exposure hints and lens shift (3.2); `setQuality` and rebuild classes; governor budget from the target frame rate (4.1); exposure range (5.1) | `presentation-sweep`, `capability-settings`, `planet-render` |
| `src/render/terrain`, `atmosphere`, `sky`, `ocean` | keep, extend | `TileSourceSpec` in the worker protocol (3.2); a generic path for bodies with small pyramids; pool budgets per body by distance; several atmospheres with per-body uniforms; cloud-top bodies; rings; sun-distance scaling | `presentation-sweep`, `planet-render` |
| `src/render/vehicle`, `cockpit`, `vfx` | extend in place | Keys by `craftId/instanceId`; interior, seats and engine clusters from the command part and the part list; visuals for about 30 new parts; pad structures per class; other-craft detail cap; echo outline; the sensor-camera surface; new plume and sound profiles | `presentation-sweep` (keys), `fleet-models-pads` |
| `src/ui`, `src/input`, `src/camera` | extend in place | No `defs.vehicles[...]` by runtime id (resource bars from per-part stage group, chase limits from the bounding radius); input contexts; menu rigs; time strip, target and docking painters, nameplates, roster, prompts; port and sensor rigs; the cockpit eye from the viewer's own command part; one shipped font family | `presentation-sweep`, `shell-menu`, `flight-hud-multiplayer` |
| `src/map` | extend in place | Census layer, filters, vessel targets, intercepts across spheres of influence, proximity plot, preview time, zoom to 1e13 m; planning through `PlanningService` | `map-multiplayer` |
| `src/audio` | keep, extend | Buses, UI sounds and music, relevance cut, new engine profiles | `shell-menu`, `fleet-models-pads` |
| `src/shell`, `src/gate`, `src/bench` | new | ARCHITECTURE 23, 24 | `shell-menu`, `capability-settings` |
| `src/app`, `index.html` | integrate | Moved to `createSession` in the sweep; the inlined gate (4.1); the shell, calibration and `LocalSession` (4.5); `NetSession`, stores, pack source (5.3) | `presentation-sweep`, `capability-settings` (index.html), `app-integration-1`, `app-integration-2` |
| `labs/integration`, `tests/browser/integration` | keep | The scene behind the integrated budget spec and the only lab that loads the real session | `presentation-sweep` (3.2), `capability-settings` (4.1), `session-switch` (4.3), `planet-render` (5.1) |

## 6. Data, tools and tests

| Path | Change |
|---|---|
| `data/defs/bodies` | Three files until activation (step 4.4); then 32 generated files. `earth` and `moon` keep their render and terrain sections (the generator emits the `terrain` and `render` refs of every body; staged files are loaded through the overlay source, so no `$ref` escapes a defs root); `sun.json` becomes the root attractor |
| `data/defs/sites` | `ka-lae-lc1.json`, `.location.json`, `.structures.json` renamed to `ka-lae.*` with a pad list (step 3.6); references in scenarios, `regions/earth-*.json`, `tools/sim/start-time.json` and tests updated in the same commit. Sixteen pads per site and `madrakah.*` in wave 4 |
| `data/defs/parts`, `vehicles`, `assemblies`, `visuals/vehicles` | About 30 new parts, the assemblies, seven new vehicles. `meridian-lunar.json` and the 25 existing parts' geometric data stay frozen. Part and module ids are never removed or renumbered from here on |
| `data/defs/scenarios` | `lunar-direct` unchanged in content apart from its tick-aligned start; `site: "ka-lae"`, `pad: "lc-1"`. QA scenarios re-captured at 3.1 and at activation. Benchmark shots (`bench-*.json`) and fleet flight scenarios (`fleet-*.json`) added |
| `data/defs/rules` | New: `default`, `staging`, `local` (written by `sim-core-v2` from the contract defaults, owned by `universe-directory` from wave 4); `tests/load/rules` for the load test |
| `data/defs/visuals/credits.json` | Staged by the bakes, moved in at activation, rendered by the Credits screen |
| `data/baselines/` | Reference images (git-ignored) with a tracked manifest |
| `tools/dev/boundaries.test.ts`, `tools/dev/heavy.mjs` | Lead, step 3.0 |
| `tools/sim/findStartTime.ts`, `start-time.json` | Tick-aligned in 3.1; re-run at activation, must reproduce the same instant |
| `tools/sim/reachability` | The reachability table of ARCHITECTURE 8.1, generated and gated at activation (`bodies-activation`) from `analyzeVehicle` (`fleet-data`) and `deltaVToOrbit` (`solar-system-sim`) |
| `data/staged/` | Bodies, their generated terrain sections, sites, render maps and credits, loaded through the overlay `DefSource` until activation moves them into `data/defs` with the same relative layout |
| `tools/server/dataPlugin.ts` | Serves `/defs/` with assemblies and rules; unchanged otherwise |
| `tests/mission` | Runs on `createSession`; `golden.json` re-baselined four times; the trajectory guard is recorded once, in step 3.2, and re-recorded only at activation with the stated tolerance |
| `tests/unit/sim-world` | Moved to `tests/universe` and `tests/unit/sim-island` as the code moves |
| `tests/browser/*`, `labs/*` | Keep working through `createSession` and `FakeSession`; specs that assert an Earth-centred `rRoot` are rewritten to differences |

## 7. Wave-2 output at risk

| Wave-2 package | At risk | Why | What protects it |
|---|---|---|---|
| sim-world-pilot | The clock, `src/sim/world/sim.ts`, `tests/unit/sim-world`, `golden.json` (four re-baselines), the mission pilot's phases | It is the single-player, single-clock, off-grid binding | The tick grid moves alone with a tolerance comparison; the algorithms then move unchanged behind a bit-exact guard; snapshot-equality test between `World` and the view builders; the switch is a gated step |
| sim-world-pilot | `tools/sim/start-time.json`, the QA scenarios | Tick alignment; then the Sun direction comes from Earth's inverted orbit after the re-root | `checkStartConstraints` and the solstice test are the gates of 3.1 and of activation |
| vehicle-pad | `vesselFeature.ts` keys state by `rootOf(vessel.id) + '\|' + instanceId` and takes engine clusters from `defs.vehicles[vehicleId]`; `siteFeature.ts` assumes one pad and tower arm heights tuned to the Meridian; perf lines sized for one stack; a part without a visual is an error | Two craft of one type collide on every id; pads are a list; several launches are in view; new parts have no visuals until wave 5 | The sweep; `padInterface`; the pad-row budget column; wave-4 browser checks use `meridian-lunar` only |
| cockpit | Interior chosen by `defs.vehicles[vehicleId].cockpit`; seat from `VehicleDef.cameras.cockpit`; reads the singleton blocks | The interior belongs to the command part, and to the viewer's own | The assembler copies both onto the command part; the singleton blocks stay |
| vfx | World-anchored effects held in ROOT across frames; emitter budgets for one craft and its debris; `explosion.posRoot` | The render root can be replaced; many vessels | `frame.rebase`; nearest-eight relevance cut |
| terrain-render | "Levels 0-3 pinned and preloaded" and pools of 1280/1024/512 layers assume two large bodies; the tile worker hard-codes `createFetchTileSource(msg.tilesUrl)` | Small bodies have 2-6 levels; 27 tile sets; production serves packs | A per-body budget by distance; `TileSourceSpec` in the worker init (3.2) |
| terrain-core | `createTerrainProvider` pins the resident pyramid of every body in every provider instance | 27 terrain bodies; one provider per tile worker, test and shard isolate | Lazy per-body residency (4.1c), bounded and measured at activation |
| atmosphere-clouds | One atmosphere and one LUT set in practice; clouds only where a cloud map exists | Venus, Mars, Titan and four giants | Per-body uniforms exist; only the nearest shell gets the full march |
| sky-lighting | Impostors and planetshine tuned for Earth and Moon; the probe is "at the active vessel"; sun disc at 1 AU | 32 bodies, four decades of illumination, no active vessel in the menu | Generic over bodies already; the probe moves to the focus |
| ocean | Wetness slots "active first" | Nullable active vessel | Nearest first when there is none |
| flight-ui, camera | `describeResources` maps `instanceId` to a stage group through the vehicle definition; the chase rig takes distance limits from the base craft's vehicle | Two docked craft of one type merge their bars; an assembly is framed wrongly; a builder design is not in the library | Stage group and label per part and chase hints per craft in the snapshot; the grep over every `defs.vehicles[` outside `src/sim` and the loader |
| core-support (render core, UI, input, camera, map, audio, terrain) | `QualitySettings` (six fields), the fixed 11 ms governor budget, `looksIntegrated`, the `pause` action, `MAP_MAX_DISTANCE = 2e9`, the system font, rigs holding ROOT positions | Settings are declared by features; nothing pauses; the map spans the solar system | Ultra equals today's look by reference image; rebase helper |
| every render package | Pixels | The frame origin, the quality plumbing and the generic terrain path each rework the renderer | **Reference images** recorded in step 3.0 and compared by `presentation-sweep`, `capability-settings`, `bodies-activation` and `planet-render`; re-recording needs a lead-signed note |
| all | Specs and labs that name the site `ka-lae-lc1`, a vessel id equal to the vehicle id, or `snapshot.tick` | Renames | Compiler and library validation catch them in the sweep and in 3.6 |

What is **not** at risk: the bakes and tile sets (terrain guard), the tile codec and cube mapping, the
height authority's numerics, the Kepler, event and force code, the part and vehicle data of the existing
stack, the frame graph and shader library, the audio graph, the HUD painters and the map's projector and
sampler.

## 8. Guards that stay green through every step

- Mission record (step 3.0, `tests/mission/baseline-v1.json`): EXACT for a step that must not change
  behaviour, ENVELOPE against the owner's control flights for a step that moves time (principle 3; per
  milestone the same body and situation, and event time, da/a, e and i within twice the controls' spread):
  `npx tsx tools/dev/record-mission-baseline.ts --exact <record>` or
  `--envelope <record> --controls <controls.json>`. What it catches and what it does not: principle 3.
- Trajectory guard (step 3.2; re-recorded once for tick-pure state): attended craft and the six fixtures
  bit-exact; debris by fate. The recorded files of the guards are pinned by
  `tools/dev/guard-pins.test.ts`; a changed pin is the lead's act.
- Terrain guard (wave 3): height at fixed points on Earth and Moon bit-exact, the tile hash list.
- Reference images (step 3.0) within each checkpoint's tolerance.
- `npm run test:mission` with zero incomplete terrain queries and `cheatCounter = 0`.
- `tools/dev/boundaries.test.ts`, `node tools/dev/check-secrets.mjs`, the repository scan for stubs.
- Momentum conservation of every split and merge to 1e-6 linear and 1e-9 angular.
- Every stage separation of the existing stack leaves the pieces undamaged; the clamp weld is unchanged.
- The start-time constraints of `lunar-direct`.
- The summed GPU budget table at Ultra on the reference GPU.
