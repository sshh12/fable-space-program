# Architecture (v2)

Definitive architecture for the true-scale, multiplayer solar-system spaceflight simulator. `PROMPT.txt`
(both halves) is the binding requirement; `docs/research/v2/user-decisions.md` records the user's decisions
and overrides any research recommendation. The documents in `docs/research/` and `docs/research/v2/` are the
detailed designs this file builds on. **Where a research document or a proposal disagrees with this file,
this file wins.** Where this file is silent, the research document for that area applies (`sim-design.md`,
`rendering-design.md`, `earth-data.md`, `moon-sky-data.md`, `webgpu-harness.md`, and from v2
`fleet-docking.md`, `solar-system.md`, `frontend-ux.md`, `hosting.md` and, for the small stage, the idle
floor and the local stack, `hosting-small.md`).

This file replaces `docs/ARCHITECTURE.md` (v1) when wave 2 ends. Until the lead swaps it in, v1 stays binding
for wave 2. `docs/MIGRATION_V2.md` says how the code moves from v1 to this design; the remaining work is in
`docs/WORK_PACKAGES_V2.json`; decisions that are the user's are in `docs/OPEN_QUESTIONS_V2.md`.

How numbers are marked: **measured** = taken from `docs/research/v2/codebase-audit.md`, a hand-off or
`frontend-ux.md` (one Ryzen 9950X3D core, Node 24); **derived** = arithmetic on measured numbers and list
prices; **assumed** = a planning value that the load test (section 28.7) must replace. No capacity or cost
figure of the game has been measured on Railway; the memory figures of the small stage were measured on
the development machine (`hosting-small.md` section 4). One account fact is measured: what the workspace's
other project already costs (`railway usage`, read 2026-11-10; section 30). Where sections 16 and 30 of
this file differ from `hosting-small.md` (the idle level, the two buckets, the egress budgets, the
workspace bill), this file is the later one. The cloud derating used is 2.5x (assumed, and a
single-thread figure: a shard runs many workers that all step the same tick at the same wall instant, so
the first cloud measurement is taken with 1, 2, 4 and 8 synchronised workers on the small stage, and with
16 and 22 in the launch rehearsal, and replaces it; sections 16.2 and 28.7). Every large cost line carries
a low and a high value.

---

## 1. Decisions

### 1.1 Decisions of the v2 design

| # | Topic | Decision | Why |
|---|---|---|---|
| 29 | Authority | The server alone advances and commits vessel state. A client sends stamped control inputs, discrete commands and time requests; it never sends state, a trajectory or a result. There is no client authority holder and no hook for one. | "Server-authoritative state, no client-only outcomes." The three proposals' own numbers put the CPU difference at tens of dollars on the busiest day (section 30); soundness decides, not cost. |
| 30 | Compute balance | One step loop, three schedules. The server simulates every vessel that is not on rails, from the pilot's stamped inputs, in **islands**. Islands that another owner can reach run in real time. A single-owner island may run up to a **commit lag** `L` behind its pilot. `L` is capped at 0 in the first release (everything real time) and raised only on evidence: the lane-equivalence tests, a multi-client profile at `L` = 2 s and an A/B run of the load test (6.2). Planning work is placed by a table between a worker, a cache and the API (`PlanningService`, 6.3). Work that is the same for everyone (screening, census, pads, fates) runs once on the server; work that is a pure function of replicated state (snapshot, readouts, patches, planning) runs on the client. Section 6. | Gives single-player feel for a pilot alone, full authority, an invisible hand-over when a second player appears, and overload that degrades invisibly first. |
| 31 | Time model | Per-vessel head time on one universe axis, forward only; server-owned clocks (live, cohort, private, shared); a passive vessel is timeless inside its **solid window**, over a patch chain that only the directory computes; interaction only on one clock; a passive vessel is taken by a two-phase claim (exclusive reservation, then commit); echoes for everything else. Canonical time is an integer tick of 1/120 s, and every clock, start instant and rails landing lies on the tick grid. Section 5. | The only family that gives private warp without a global warp control or merged timelines. |
| 32 | Unit of simulation | An **island**: the vessels of one clock that could touch within seconds, stepped together on one thread in one local frame. A vessel alone is an island of one. Single-player flying is an island of one in an in-process universe. | One execution path for tests, offline play, the client replica and the servers. |
| 33 | Vessel model | A vessel is a forest of craft trees joined by dock links: `Vessel.crafts[]`, `Vessel.links[]`, `Vessel.helm`. Parts are addressed `craftId/instanceId`. Stage stacks, abort sequences and lend policies belong to the craft. Section 7.2. | Docking, universe-unique ids, persistence and a later ship builder all need this one change. |
| 34 | Docked control | One helm with explicit hand-over, plus craft sovereignty: every owner keeps their own stage stack, ports, pumps and lend policy, and either side of a port can always release it. Section 7.5. | Clear, predictable, and no docking takes a station from its builders. |
| 35 | Damage | A part is intact or destroyed; a joint is intact or broken. No health values. | One rule on the ground and between vessels; nothing to desynchronise. |
| 36 | Bodies | The body system is rooted at the Sun: Sun, eight planets, 20 moons, Ceres, Pluto and Charon (**32 bodies**, listed by name in 8.1), three levels. Planet elements are JPL mean elements with secular rates; Earth keeps the Almanac formula (inverted) and the Moon its frozen ellipse so the lunar mission's windows are unchanged. Section 8. | "Entire solar system at true scale, real orbits." |
| 37 | Simple bodies | Every solid body enters the existing tile pipeline as a small pyramid baked by one config-driven tool; giants are a cloud-top map plus an atmosphere shell with no surface. No second terrain code path. | Placeholder visuals are allowed off Earth and Moon; landing later is deeper levels from the same tool. |
| 38 | Presentation frame | Positions handed to presentation are relative to the **render root**: axes J2000 equatorial, origin near the viewer (`SimSnapshot.frame`). The field names `rRoot`, `positionRoot`, `posRoot` are kept; "ROOT" now means the render root, never the Sun. Section 3. | A heliocentric float64 origin gives millimetre jitter in a cockpit at Neptune; 543 read sites keep compiling. |
| 39 | Presentation contract | `SimSnapshot` stays the only thing presentation consumes, and is built on the client from replicated island state. `Sim` becomes `FlightSession` with two implementations: `LocalSession` (in-process universe, `src/session`) and `NetSession` (network replica with prediction, `src/client`). `createSession(defs, scenarioId, { terrain })` in `src/session` replaces `createSim` (same arguments) and returns a `LocalSession`; `src/sim` exports no session. | About 190 singleton read sites and every lab keep working; the app loop is written once; the simulation cannot import its own host. |
| 40 | Warp table | `WARP_LEVELS` gains 1,000,000x and 10,000,000x (nine rails levels). Rails altitude limits default from the body radius. | Neptune is a 2.7 h cruise at 100,000x. |
| 41 | Low thrust | No ion or electric propulsion. The high-Isp stage is nuclear thermal. Thrust on rails is a named seam (section 32). | Patched conics, nodes and rails warp cannot express months of thrust. |
| 42 | Protocol | Binary WebSocket, inputs up, state down. Exact keyframes, deltas against the last keyframe, structural changes as deterministic operations, coasting craft as conic elements on change. Section 13. | Railway has no UDP; latest-wins messages would also survive datagrams. |
| 43 | Persistence | Postgres, written only by the directory (which holds a fenced lease), in 250 ms batches. Islands are durable through checkpoints of the whole island state plus an input journal, replayed exactly on one pinned build. Every stored blob carries a codec version and the definition fingerprints it was written under. Transitions that involve two owners are committed before they are shown. Section 15. | A deploy freezes the universe for a measured number of seconds and loses no committed state; a dock can never be half-stored; parked ships survive definition changes. |
| 44 | Expiry clock | The wall clock. A ship is kept 14 days after its owner's last session; an assembly lives as long as its most recently active owner. All numbers are fields of `UniverseRules` and are shown to players. | Universe times differ by centuries between vessels; the wall clock is the only one all share. |
| 45 | Hosting | Railway hosts everything at run time, on **one codebase and one image definition, deployed as a ladder of stages** (16.2). **Stage 0 (Combined, on the Hobby plan)** is where the game starts and what is always on: `game` (one process holding the gateway, directory, API and publisher roles, with the shard's worker isolates as its threads), `shell` (static, CDN on, carrying the tile mirror), `postgres`, an hourly `dump` job and two buckets (`packs`, `dumps`). It adds about $5-15 a month to the workspace bill with nobody connected and $10-25 at 5 concurrent players (estimates, section 30), against ceilings of $30 and $50. The workspace's other project already uses the plan's included $5 (measured: $7.4-10.2 a month), so the game's usage is billed in full, and the workspace total reaches $20, where Pro costs what Hobby costs, at about 5 players or sooner: the plan question is put to the user with those numbers (OPEN_QUESTIONS Q2). Nothing in production sleeps; an empty universe is **idle** (no tick loop; at stages 0 to 2 one worker isolate and the launch bodies' resident terrain stay warm, so the first Deploy after a quiet spell waits for nothing; 6.2). Every public byte source has a daily egress budget, so the month is bounded by configuration and not by an alert (16.2). **Stage 1** is the same topology on Pro (volume backups, point-in-time recovery, deploys by digest); **stage 2** is the **split** (`gate`, `dir`, `sim-1`); **stage 3** is the **launch** topology (`sim-1..K`, gateway replicas, `pub` and `packs` services, the scale controller). Every move has a measured trigger, is configuration and a deploy with at most one short announced freeze, and loses no committed state; the lead tells the user before the plan or the standing spend rises. The local stack runs the same roles on this machine with no cloud resource (16.4). Modal hosts bots, bakes, audits and the off-site copy in its own environment, with nothing always on. Netlify is an optional host for the shell only. One region, US East. Section 16. | User decision: about $50 a month or less at about 5 players on the Hobby plan, about $30 or less when idle, growth by configuration when measured need arises. Only Railway holds long-lived sockets cheaply. What it costs is stated, not hidden: a front-page day that arrives unannounced is not absorbed from stage 0 by itself; players beyond the admission cap queue and watch until a human moves the deployment up (16.2). |
| 46 | Tile delivery | The bake output and the dev server stay plain files. Production serves content-addressed range-readable **packs** from a Railway bucket through presigned URLs, with the `packs` mirror role (a streaming proxy of the bucket behind a CDN: carried by the `shell` service up to stage 2, its own service with replicas and its own domain at stage 3; it proxies ranges if the CDN caches them and small slices otherwise, decided by a wave-3 measurement) as fallback, and a first-paint **boot pack** of at most 25 MB that `shell` loads from the bucket at start and serves through its CDN. Revises row 4. | 862,000 files cannot be addressed one presigned URL at a time; 15 TB in a day must not be billed egress, and at 5 players tiles must cost nothing; a visitor must see the title in seconds. |
| 47 | Identity | Anonymous by default: an account record that a non-extractable device key points at, a callsign, a recovery code. Other sign-ins are more credential rows later. Nothing else is built. | User decision. |
| 48 | Lobbies | The lobby is the unit of deployment (one directory, one shard set, one Postgres schema). One public lobby exists; the client lists lobbies. | "Build around lobbies, one mega-lobby for now." |
| 49 | Front end | One scene, one renderer, one loop from the menu to flight; the menu is DOM over the live canvas; the app shell is a state machine. Section 23. | "Menu over a live Earth and space view, seamless transition." |
| 50 | Capability gate | An inline script blocks mobile and unsupported devices before the main bundle loads; adapter class is judged by a benchmark on the real renderer, not by name. The title appears on a class-hint preset; the benchmark runs at the first Play, when its data is resident. Settings are declared by features. Section 24. | The adapter name is empty in production Chrome; a visitor who leaves should not have downloaded the benchmark's data. |
| 51 | Chat | Quick-comms (fixed phrases) only. Free-text chat is not built and has no rules flag; it is a forward seam (section 32, OPEN_QUESTIONS Q9). | An anonymous free-text channel at front-page scale is a moderation job nobody has taken on; a flag that switches nothing is a stub. |
| 52 | Rules are data | Every number of sections 5, 7.4-7.6, 9.4 and 15.5 is a field of one versioned `UniverseRules` document served to clients, which render the rules screen and every countdown from it. A staging rule set with lifetimes of minutes demonstrates expiry. | "Configurable, visible to players." |
| 53 | Accepted inconsistencies | (a) An object launched at an earlier time is not collided against histories already committed. (b) Two passive vessels never collide with each other. (c) After a private warp a player is alone in their time until someone jumps, holds or arranges a meeting. (d) A server crash may re-run up to 250 ms of flight; an outcome between two owners that was shown inside that window is marked provisional until it is durable (15.1). All four are stated on the rules screen. | They cannot be designed away in any forward-only model; hiding them would be merging timelines. |
| 54 | Launch capacity | The launch complex is sized from a launches-per-day target, not from a pad count: `pads x (cohort horizon + 24 h) / mean cycle` must cover the sessions of a front-page day. Release defaults: 32 pads (16 per site), a 14-day cohort horizon, a 150 s mean cycle: 276,000 launches in the first day, 18,400 a day sustained. The complex is data and costs nothing while unused, so it is the same at every stage; at stages 0 to 2 the admission cap binds before the pads do, and the per-pad cycle is measured there on a rule set with few pads (28.7). Sections 5.9, 9.3, 16.3. | Pads, not CPU, bind first; a capacity plan that ignores them is wrong by an order of magnitude. |
| 55 | Scheduling | Waves 3-7 with sub-waves; contracts are written by the lead before each wave; every shared file has one owner per sub-wave; the three risky switches (tick grid, `LocalSession` replacing `World`, activation of the Sun-rooted body set) and the app integration are packages with gates, not lead chores. Section 33. | The first plan put five packages into one agent and three switches between waves with no owner. |

### 1.2 Decisions carried over from v1

Rows 1-28 of the v1 table. Rows revised by v2 are marked "(v2)".

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Launch site | **Ka Lae Pacific Spaceport LC-1**, Ka'u coast, Hawai'i, nominal 19.10 N 155.50 W (`data/defs/sites/ka-lae.json`, pad `lc-1`; (v2) the site has sixteen pads and a second site exists, section 9.3; exact pad coordinates are snapped to real terrain by the Earth bake). The Florida site in `earth-data.md` is dropped. | Latitude below the Moon's 20.9 deg orbital inclination gives a coplanar launch twice a day, so TLI needs no plane change. Arid lava coast looks real at ground level without vegetation geometry. USGS 10 m elevation and Sentinel-2 imagery cover it. |
| 2 | Cube-sphere mapping | **Plain gnomonic** cube (`src/core/geo/cubeSphere.ts`, Python mirror `tools/bake/common/cube.py`). The tan-warped mapping in `moon-sky-data.md` is dropped. | Tile offsets stay linear in cube space, which the float32-stable vertex formula and crack-free geomorphing rely on. |
| 3 | Tile URL scheme | `/tiles/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}` + `/tiles/{tileset}/manifest.json` | One scheme for every body and layer. |
| 4 | Height tile encoding (v2) | **FRT1** container, zlib-compressed, 259 x 259 vertex-registered int16 with a delta predictor and per-tile power-of-two scale (`src/core/geo/tileCodec.ts`, `tools/bake/common/frt1.py`). No PNG, no Brotli. Plain files on disk at bake time and in development; production delivery wraps the same tile bytes in range-readable packs (decision 46, section 10.4). | Decodes identically in the browser, in workers and in Node; shared edges are bit-identical; browsers cannot decode 16-bit PNG faithfully. Packs are a delivery container, not a second encoding. |
| 5 | Image tiles | 256 x 256 **opaque** WebP, cell-registered. No image tile carries alpha. The water mask is its own layer `watermask` (`frt1-u8`, 0 land .. 255 water). Browser decode is always `createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`. | Lossy WebP rewrites RGB under transparent texels and browsers premultiply on decode: a mask in alpha would turn land black. A byte layer is lossless and decodes identically everywhere. |
| 6 | Normal maps | Generated by terrain workers from the height function, never baked. | Normals must include procedural amplification and match collision. |
| 7 | Upstream services at runtime | **None.** No lazy proxy. High-resolution regions are baked ahead by a region tool; the dev server only serves local files. | "The core mission must not break if an upstream is down"; a reprojecting proxy is a second pipeline to keep correct. Adding a region is a data-only bake. |
| 8 | Stars | Catalogue stars (HYG, V <= cutoff) drawn as photometric points + a cube map holding the Milky Way and the fainter remainder with catalogue stars removed (`src/core/contracts/sky.ts`). | Physically integrated flux for bright stars, no double counting. |
| 9 | Mission architecture (v2) | The `lunar-direct` scenario stays **direct ascent** (capsule rides the two-stage lander to the surface and back). Rendezvous and docking exist in the game (section 7.5); the Earth-Moon-return proof does not depend on them. | `sim-design.md` section 12; the original definition of done must keep passing unchanged. |
| 10 | SAS modes | The seven modes the brief lists plus `maneuver` (hold the remaining-delta-v direction). Attitude hold only; SAS never touches throttle, staging or planning. | Standard KSP behaviour; the player still flies every burn. |
| 11 | Sea surface for physics | Shared analytic swell `src/core/geo/oceanSwell.ts` (components in `BodyDef.ocean.swell`), evaluated by both buoyancy physics and the ocean renderer. FFT wind waves are render-only detail on top. | The capsule must float on the surface that is drawn; a GPU readback would make physics depend on rendering. |
| 12 | Water for physics | Water = body has an ocean and the solid surface is below sea level. The `watermask` layer is render-only. | Physics never decodes images. |
| 13 | Browser test mode | Installed Chrome via Playwright `channel: 'chrome'`, **new headless**, flags in `tests/browser/chromeArgs.ts`. (`rendering-design.md` suggested headed Chrome with extra flags; the measured harness research supersedes it.) | Pixel-identical to headed, real RTX 5090 WebGPU, immune to focus/occlusion. |
| 14 | Earth prime meridian | `rotation.w0Deg = 190.46061837` for Earth (GMST at J2000, 280.46 deg, minus the 90 deg node offset of the IAU formula). | `sim-design.md` quotes 280.46 next to the IAU formula; the two differ by 90 deg. |
| 15 | Threads (v2) | Client: the session (prediction, about 0.1 ms per step) and the view builders on the main thread; terrain tile generation in a worker pool; long predictions in a planning worker; socket keep-alive in a worker; audio in the audio thread. Server: one isolate per shard worker thread; the gateway shares the main thread of the `game` process at stages 0 and 1 and runs as separate processes from stage 2 (16.1). Section 17.2, 16.1. | Determinism and simplicity on the client; `src/sim` keeps module-level scratch state, so one isolate per thread on the server. |
| 16 | HUD technology | HUD = DOM + Canvas 2D layered over the WebGPU canvas. The navball is a real 3-D sphere rendered with WebGPU into a texture shared with the cockpit. Map lines/markers are a `RenderFeature.drawOverlay` drawn after tonemapping with analytic sphere occlusion. | Crisp text, no font atlas; one navball for HUD and cockpit; no depth-buffer coupling for overlays. |
| 17 | Edges of high-resolution regions | The height authority blends each sparse data level into its parent over a ring of `COVERAGE_BLEND_TILES` (a quarter tile) along the coverage edge, as a pure function of the manifest (`src/core/contracts/terrain.ts`). Procedural amplification keys on the resulting fractional *effective level*. Imagery layers are feathered to their parent by the bake. | Without it the surface steps by metres where regional tiles end and procedural craters stop at a wall; no source feathering can fix that at run time. Section 10.2. |
| 18 | Frame graph and scene copies | Hooks sample published **copies** of depth and colour (`scene.depthOpaque`, `scene.depth`, `scene.depthHalf`, `scene.colorCopy`, `scene.colorCopyTransparent`), never live attachments; a `preTransparent` hook gives features an encoder after the atmosphere composite for half-resolution volumetrics. | WebGPU forbids sampling an attachment of the current pass; water refraction, plumes, smoke and plasma all need this frame's depth. Section 18. |
| 19 | Far and near water | The terrain renderer draws the sea-level sheet into the G-buffer everywhere except within `ocean.nearField.fadeStart` of the eye; the ocean's forward pass covers the near field and cross-fades onto the sheet between `fadeStart` and `fadeEnd`. | One surface is in depth at any pixel, the seabed is visible for refraction near the camera, and no ring shows from any altitude. Section 18.2. |
| 20 | G-buffer | Five targets: albedo, normal, material, velocity and `gbufferExtra` (tangent angle, anisotropy, clearcoat, clearcoat roughness), 28 bytes per sample with the HDR emissive target. `MATERIAL_PARAM` fixes the meaning of the single material parameter per material id. | Anisotropic MLI and brushed metal and clearcoated paint are needed by the vehicle; deferred anisotropic GGX needs a tangent. |
| 21 | Sun shadows | Cascades are anchored and texel-snapped in the body-fixed frame of the body they cover (vessel frame for the cockpit cascade); world-to-shadow matrices are re-derived every frame in float64. Moving casters draw only into cascades re-rendered every frame. A body beyond the last camera cascade gets a cascade fitted to its whole sunlit disc. | The ground moves 0.4-1.7 km/s in ROOT axes, so ROOT-space snapping and staggered updates would crawl and jump; a distant Moon needs terminator shadows. Section 18.1. |
| 22 | HDR range and exposure | Every HDR write is clamped by `writeHdr()` to `HDR_MAX` = 60,000 (pre-exposed) with NaN removed. Auto-exposure meters lit pixels only (sky excluded), protects highlights, and falls back to a photometric prior when almost nothing is lit. | `rgba16float` overflows to Inf when the sun enters a dark-adapted frame; most of the mission is a small lit object on black. Section 18.4. |
| 23 | Presentation timing | `FlightSession.advance` accumulates real time into whole 1/120 s steps; `snapshot()` interpolates integrated vessels between the last two steps (`SimSnapshot.ut` vs `simUt`). `peek()` is never interpolated. | Monitors run at 60 to 240 Hz; an integer number of steps per frame would judder at 144 Hz. |
| 24 | Keyboard | No default binding uses Ctrl, Alt or Meta as a key or modifier (throttle is Shift / F, SAS modes are the digit keys). The game requests fullscreen + `navigator.keyboard.lock()` on the first gesture; Ctrl becomes an alternate throttle-down only while the lock is held. The map editor's Shift/Ctrl drag modifiers never reach the throttle. | Chrome cannot stop Ctrl+W / Ctrl+T / Ctrl+N from closing or leaving the tab; a lunar landing holds throttle-down and pitch together. Section 19. |
| 25 | Missions are data (v2) | `ScenarioDef` is a spawn recipe plus an optional objective list of generic triggers (`MilestoneTrigger`), attached to one craft; the universe has one evaluator and no mission-specific code. No vehicle is tied to a mission. Named surface places (`SurfaceTarget`) come from scenario and site data. Section 7.7. | "Don't hard-code this one mission"; "don't tie vehicles to prescribed missions." |
| 26 | Terrain and determinism (v2) | In a `LocalSession`, `ready` and `terrainPending()` form the await protocol that makes asynchronous tile loading reproducible. On a shard the authoritative island never runs a contact step on non-final data and the journal records the resident data level. Collision vertices are evaluated lazily, never as whole grids. | The headless mission must reproduce a golden hash while terrain streams from disk; a journal replay must reproduce a live run; touchdown must not hitch. Sections 7.6 and 10.2. |
| 27 | Vessel-to-vessel contact (v2) | Simulated inside islands: convex colliders from part data, swept tests, impulses, three damage regimes (section 7.4). The clean-separation assertion stays: after each of the ten stage events the separated vessels come apart without damage, under the born-overlapping rule. | "Relative-velocity contact, collision response ... no tunnelling." The separated envelopes of the existing stack overlap for 0.01-0.39 s, so the rule is mandatory. |
| 28 | Scenario start time | The mission starts 10 minutes before a **coplanar** crossing of the Moon's orbit plane at the pad, on **either** azimuth (ascending, about 81 deg, or descending, about 99 deg), with the pad Sun at 10-35 deg (morning) and the landing-site Sun at 5-35 deg and rising from start + 3 d to start + 5 d. Chosen by `tools/sim/findStartTime.ts --launch-kind either`: 2029-09-24T18:26:58.8Z, launch azimuth 99.4 deg (`tools/sim/start-time.json`). | With the ascending crossing alone the three constraints have no solution in 2027-2030 at the resolved pad (the lunar Sun climbs 24.4 deg in the two days, successive ascending opportunities step 12.2 deg); the descending crossing is just as coplanar, so TLI still needs no plane change, and it heads over open ocean. It gives a daylit pad and a low Sun for relief at lunar touchdown. `docs/requests/sim-orbits-1.md`. |

---

## 2. Repository layout and ownership

Every path has exactly one owner per sub-wave. Owners are the work packages of
`docs/WORK_PACKAGES_V2.json`; `lead` is the architect/integrator. **Nobody edits outside their own paths.** A
needed change to someone else's path is a request in `docs/requests/`.

```
PROMPT.txt                     user requirement (binding)
docs/ARCHITECTURE.md           this file once swapped in (lead)
docs/MIGRATION_V2.md, docs/WORK_PACKAGES_V2.json, docs/OPEN_QUESTIONS_V2.md, docs/PACKAGE_RULES.md   (lead)
docs/research/, docs/research/v2/   research designs and proposals (read-only reference)
docs/RENDER_API.md             render core API for feature authors
docs/handoff/<package>.md      hand-off note of each work package
docs/requests/                 change requests against code you do not own
docs/capacity/                 load-test reports (measured capacity, published on the rules screen)
package.json, package-lock.json, tsconfig*.json, vite.config.ts, vitest.config.ts, playwright.config.ts
                               root configuration (lead; changed only in the lead step before a wave,
                               MIGRATION_V2 section 3; packages never run npm install)
index.html, src/app/           app entry and wiring: `presentation-sweep` (3.2), `capability-settings`
                               (index.html only, 4.1: the inlined gate), `app-integration-1` (4.5),
                               `app-integration-2` (5.3), `final-gate` (7); the lead otherwise
src/gate/                      inline capability gate and block pages (no imports from the rest of src)
src/core/                      contracts, f64 math, cube mapping, tile codec, def loader and structural
                               validators, GPU acquire, test-API base, FakeSession
src/sim/orbit|frames|bodies|nav/     orbital mechanics, ephemerides, atmospheres, navigation maths, screening
src/sim/vessel|dynamics|control/     vessel and craft model, versioned codec, forces, staging, thermal,
                               colliders, SAS, `validateVehicle` and `analyzeVehicle`
src/sim/island/                the island: N vessels on one tick grid; per-vessel state machine, contact and
                               capture pass, structural operations, step modes (authoritative, predict), the
                               island codec
src/sim/view/                  pure builders of the presentation blocks (readouts, navball, staging, patches,
                               markers, burn bookkeeping, target and docking readouts)
src/universe/                  directory (records, worldlines, forecast chains, solid windows, reservations
                               and claims), clocks and the time rules, island lifecycle and the scheduler
                               interface, pad timetable, expiry, UniverseRules. Pure TypeScript like src/sim:
                               time and storage are injected
src/session/                   headless: `LocalSession` and `createSession` (an in-process universe behind
                               the FlightSession contract). Imports src/core, src/sim, src/universe
src/net/                       wire layer: message codec, framing, transports (WebSocket, loopback), the
                               session layer (handshake, resume, subscription and budget state machines for
                               both ends), time sync, latency and stall injector
src/client/                    browser and bot side of the network: `NetSession` with prediction, client
                               stores (census, pads, ships, rules, presence, feed), identity key, the
                               planning service providers and their chooser
src/pilot/                     scripted pilots: the mission pilot, generic ascent/rendezvous/docking/transfer
                               pilots
src/terrain/                   CPU height authority, tile sources (fs, fetch, pack) behind
                               `createTileSource(spec)`, amplification, rocks
src/render/core|terrain|atmosphere|sky|ocean|vehicle|cockpit|vfx/    as in v1
src/input/, src/camera/, src/ui/     bindings and controllers, camera rigs, HUD, instruments, nameplates
src/map/                       map view: trajectories, census layer, targets, intercepts, node editing
src/shell/                     app state machine, menu framework and screens, settings models
src/bench/                     calibration shots, solver, quality profiles
src/audio/                     audio engine
server/                        Node roles: gateway, directory host, shard host, API, publisher (the only
                               implementation of each, 16.1); Postgres writer and schema; bucket access;
                               role wiring; the trailing-lane executor.
                               Imports src/core, src/sim, src/terrain, src/universe, src/net; never deploy/
bots/                          headless bot players (NetSession + pilots) and the Modal fleet app
deploy/                        Railway service definitions per stage, Dockerfile, the program entry and the
                               role manifest, the static roles (deploy/roles: shell, packs, dump, the egress
                               meter), boot-manifest.json, rollout, stage and scale scripts, the scale
                               controller, the local stack (deploy/local: the one-command launcher and the
                               compose file), CI
labs/<package>/                lab pages
tests/unit/<package>/, tests/browser/<package>/, tests/mission/    as in v1
tests/browser/app/, tests/browser/mission/   the integrated app (app-integration packages, final-gate)
tests/universe/                headless rule, fuzz and adversarial suites
tests/net/                     separate-process multi-client suites with latency injection
tests/acceptance/              two-browser stories, restart, expiry, whole flights
tests/load/                    load-test scenarios;  tools/net/  the multi-process test harness
tools/bake/common|earth|moon|sky|planet/   bake pipelines;  tools/bodies/  body-definition generator
tools/pack/                    tile packer and uploader;  tools/audio/, tools/sim/, tools/server/, tools/dev/
data/defs/                     JSON definitions (tracked)
data/tiles/, data/sky/, data/cache/, data/packs/, data/baselines/, data/stack/     baked data, raw
                               downloads, packs, reference screenshots, the local stack's database and
                               state (git-ignored)
public/assets/<area>/          shipped binary assets
```

Paths that stay with the lead in every wave: the root configuration, `docs/` outside hand-offs and capacity
reports, `src/core/contracts` (requests are answered during a wave; `net.ts`'s wire-message section belongs to
`wire-protocol` and `universe.ts` to `universe-directory` from wave 4), `src/core/math`, `src/core/testing`,
`labs/template`, `tests/browser/{harness,globalSetup,chromeArgs}.ts`, `tests/browser/shell`, `tools/dev`
(including `boundaries.test.ts` and `heavy.mjs`, which gains the class `stack` for the local stack and
the compose suites of 16.4). `WORK_PACKAGES_V2.json` lists the owner of every other shared path per sub-wave (`labs/integration`,
`src/core/fakes`, `src/core/defs`, `src/terrain`, `src/pilot/generic`).

Import rules (enforced by `tools/dev/boundaries.test.ts`):

- `src/core` imports nothing outside `src/core`. `src/gate` imports nothing at all.
- `src/sim`, `src/terrain`, `src/universe`, `src/session`, `src/pilot` are headless and deterministic: no
  DOM, no WebGPU, no `performance.now`, no `Date.now`, no timers, no `Math.random`, no sockets, no file or
  database access. `sim -> terrain` only through `TerrainProvider`; `universe -> sim` through the public APIs
  of `src/sim`; `session -> universe, sim`; `src/sim` never imports `src/universe`, `src/session` or
  `src/client`; `pilot` reaches a session only through the `FlightSession` contract and receives
  `VehicleCapabilities` as data.
- `src/net` imports `src/core` only. `src/client` imports `src/core`, `src/sim` (island, view, orbit: the
  replica and the planning providers) and `src/net`; never `src/universe`, `src/session` or `server/`.
- Render packages import `src/core` and the public API of `src/render/core`; never each other, never
  `src/client` or `src/net`. `src/ui`, `src/map`, `src/audio`, `src/input`, `src/camera`, `src/shell`,
  `src/bench` import `src/core` only (plus `src/render/core` public helpers and, for labs and the turntable,
  the frozen vessel facade `src/sim/vessel/public.ts`). They reach planning results through the
  `PlanningService` interface of `session.ts`, never through `src/sim`.
- Presentation code never indexes `defs.vehicles` by a runtime id: stage group, label and camera hints
  arrive per craft and per part in the snapshot, so a design that is not in the library draws correctly.
- Only `src/app` knows every client subsystem. Only `server/` and `bots/` import Node networking, worker
  threads and the database driver. Node builtins elsewhere stay in `fs*.ts`, `*.node.ts` or `node/`.
- `server/` never imports `src/render`, `src/ui`, `src/map`, `src/shell`, `src/audio`, `src/client`; the
  client bundle never contains `server/`, `bots/` or `src/universe` outside `src/session`. The rules for
  `server/`, `bots/`, `src/net`, `src/client` and `src/session` are added to the boundary test by the lead
  before wave 3, so no later package has to edit it.

Repo etiquette is unchanged from v1 (`docs/PACKAGE_RULES.md`): scoped verification, own paths only, the
heavy-job gate, no placeholders, secrets only in build-time tools and in provider secret stores.

---

## 3. Conventions

**Units.** SI everywhere in code. Data files use degrees (`...Deg`). Rendering is photometric.

**Time.**

- The canonical universe time is the **tick**: an integer count of 1/120 s since J2000.0
  (2000-01-01T12:00:00, treated as UTC), carried in a float64 (exact to 2^53 ticks, 2.4 million years).
  Heads, clocks, patches' boundaries on rails, journals, messages and persistence use ticks. Two things are
  at the same time only when their ticks are equal and they are on the same clock.
- `ut = tick / 120` (seconds, float64) is derived, and is what the orbit, body and force code take as
  arguments. An event instant (sphere-of-influence crossing, encounter) keeps a float64 second inside its
  tick for the hand-over, as v1 does. Rails warp and jumps land on whole ticks.
- `PHYSICS_DT = 1/120 s` is one tick. A control tick is `CONTROL_TICK_STEPS = 4` ticks (30 Hz).
- Timers have exactly three bases, and every timer in this file names one. **Universe ticks**: pad
  occupancy and safing, soft-capture, port cooldown and U5 clearing timers; they stop when their clock
  stops. **Directory up-time** (the persisted counter behind the live clock, 5.2; frozen while the universe
  is down): clock schedules, pad reservation holds, ready-checks, helm requests, the reconnect grace and
  the resume window, the latch and dead-man timers of U16, rate limits. **Wall clock**: expiry only (15.5).
  Headless code receives up-time and wall time as arguments; an island receives neither, only tick-stamped
  inputs (7.2).
- v1's clock was not on this grid (scenario starts were arbitrary float instants and every rails advance
  re-based the step grid). The move to the grid is its own guarded step in wave 3, before any other change
  (MIGRATION_V2 step 3.1).
- Warp levels are `WARP_LEVELS = [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000, 1e6, 1e7]`: indices 0-3
  physics warp, 4-12 rails warp.

**Handedness and frames.** Everything is right-handed.

| Frame | Origin | Axes |
|---|---|---|
| ICRF | (direction only) | inertial; +Z = Earth north pole of J2000, +X = J2000 vernal equinox |
| BCI(b) | centre of body b | parallel to ICRF (never rotates) |
| BCBF(b) | centre of body b | body-fixed; +Z spin axis, +X prime meridian on the equator |
| ISL(i) | the reference orbit of island i: a point on an exact Kepler orbit about the island's SOI body | parallel to ICRF |
| ROOT (render root) | `SimSnapshot.frame`: the centre of the SOI body of the focus when that body is a planet or moon; the focus island's reference-orbit point when the focus is in the Sun's SOI | parallel to ICRF |
| ENU(p) | a surface point | +X east, +Y north, +Z up |
| VES | root part origin of the vessel's base craft | +Y nose, +X starboard, +Z dorsal |
| CTL | the helm's control part (`Vessel.helm.controlPart`) | that part's axes; control inputs and the navball refer to it |
| part | part origin | as VES; placed by `PartSnapshot.localPos/localRot` |
| view | camera eye | +X right, +Y up, looks down -Z |
| render world | camera eye | parallel to ICRF ("camera-relative") |

- The system root body is the Sun (`DefLibrary.rootBodyId`). It is **not** the origin of ROOT. Every field
  named `...Root` in the contracts (`rRoot`, `vRoot`, `positionRoot`, `posRoot`, `qFixedToRoot`, `spinRoot`)
  is expressed in the render root. Presentation code only ever uses differences of ROOT positions and ROOT
  axes, so it is origin-agnostic.
- `SimSnapshot.frame = { epoch, origin, rebase }`. `origin` is `{ kind: 'body', bodyId }` or
  `{ kind: 'orbit', bodyId, r0, v0, t0 }`. `epoch` increments whenever the origin is replaced (focus change,
  sphere-of-influence change of the focus, a new island reference orbit); the snapshot that carries a new
  epoch also carries `rebase = { offset, velocity }`, the old origin's position and velocity in the new
  frame at the snapshot time. Anything that holds a ROOT position across frames (camera rigs, the renderer's
  previous-frame state, world-anchored effects, the map focus) applies `rebase` once, through the helper in
  `src/core/math/frame.ts`. Motion vectors need no rebase: they are built from camera-relative positions at
  each time.
- Latitude is planetocentric, longitude east-positive. Bodies are spheres of `BodyDef.radius` for the
  physics datum; terrain height is added radially; oblate bodies add `BodyDef.shape` (section 8.3).
- Body orientation follows the IAU form of v1; tidally locked bodies solve `W` from their orbit.

**Quaternions, matrices, control signs**: unchanged from v1 (Hamilton `{x, y, z, w}`, `qAToB`, `mul(a, b)`
applies `b` first; `Mat3` row-major float64, `Mat4` column-major; reversed-Z infinite projection; pitch + =
nose toward +Z, yaw + = nose toward +X, roll + = about +Y). They apply in the CTL frame.

**Ids.** Lower-kebab strings for definitions. Engine code never mentions a specific body, vehicle, part,
site, scenario, milestone or rule value. Runtime ids are issued by the directory, are universe-unique, and
are deterministic functions of ids and ticks so that a replay issues the same ones. The local universe
issues craft ids from a seeded counter, so tests are reproducible.

| Thing | Id | Rule |
|---|---|---|
| Craft | `craftId` | Never changes; never reused; never names a vessel of several craft |
| Part | `craftId/instanceId` | `instanceId` is unique within the craft |
| Whole single craft (holds its craft's root part) | `vesselId = craftId` | One row per id for ever: the row is a tombstone while the craft is docked and is reopened when it undocks alone |
| Piece of one craft without that craft's root | `<craftId>~<root part instance id of the piece>` | Staging debris, fragments |
| Vessel of two or more craft (assembly, or a fragment spanning craft) | `a~<lowest vessel id of the two that first docked>~<tick>` | Issued at the first dock; kept while craft join (the arriving vessel's row becomes a tombstone); when two assemblies dock the base's id is kept |
| Pieces after an undock or a break | each whole single craft: its `craftId`; the piece with the most craft (tie: the lowest craft id) keeps the assembly id if it still has two or more craft; every other multi-craft piece: `a~<its lowest craft id>~<tick>` | An assembly id whose last multi-craft piece is gone becomes a tombstone |

- A **tombstone** is a vessel row with no state, `merged_into` or `split_into` and the tick of the
  operation. It keeps its worldline up to that tick, so a viewer behind a dock still sees two recorded
  echoes, and a viewer behind an undock sees the assembly.
- Lineage redirects everything that pointed at an id: targets and census handles follow `merged_into` /
  `split_into` to the vessel that now holds the targeted craft (a target is stored with its craft id); a
  plan belongs to its craft and travels with it; a pad slot stays with the piece that holds the pad
  interface.
- Tests (`tests/universe`): dock, undock of the base craft alone, re-dock, a break that splits an assembly
  into three: ids unique at every tick, no primary-key reuse while a row is live, echoes intact for a
  viewer behind each operation, identical ids in a replay.

**Determinism.** `src/sim`, `src/terrain`, `src/universe` and `src/pilot` iterate in defined order (vessels
by id, parts by index, bodies by sorted id) and use only the seeded hash / PRNG of `src/core/math/hash.ts`.
Same build + same runtime image + same inputs at the same ticks = bit-identical state. That holds within
one runtime (measured). It does **not** hold between Node and Chrome (15 of 17 transcendental functions
differ in the last bit, measured), so server and client never compare hashes; they compare state with a
tolerance. Server against server (journal replay, audit) compares hashes, on one pinned Node build and one
CPU architecture. For the same reason a client never **chains** the patches of a vessel it could touch: a
chain through several encounters amplifies a last-bit difference, so the directory computes forecast
chains and clients only evaluate the published conics (U14).

---

## 4. Precision

- All positions are float64 on the CPU. A vessel's state is relative to its SOI body inside a planet's or
  moon's sphere of influence (grid 0.9 nm in low Earth orbit, 15 um at the edge of Neptune's SOI, measured).
- **In the Sun's sphere of influence an island integrates offsets from its reference orbit** (frame ISL):
  gravity enters as the difference between the acceleration at the vessel and at the origin, evaluated
  without cancellation (Encke's method with Battin's `f(q)`), through an optional origin in
  `VesselEnvironment`. With no origin everything is exactly as in v1. Without this, heliocentric float64
  gives 4 mm/s of relative velocity noise at 1 AU and 0.12 m/s at Neptune (computed) against a 3 mm/s
  hard-dock threshold.
- Rules that keep precision everywhere: never subtract two heliocentric positions of craft that are near
  each other, subtract their BCI or ISL states; an island changes frame as a unit at its anchor's tick;
  nothing on the wire at high rate is planet-sized (section 13.4); presentation receives ROOT positions
  centred near the viewer (section 3).
- The GPU never sees a planet-scale coordinate of anything drawn at high detail. Each frame the CPU computes
  `objectOrigin - cameraEye` in float64 and narrows to float32; shaders add small local offsets. The view
  matrix is rotation-only. Terrain vertices use the cancellation-free tile formula and atmosphere shaders
  the stable altitude formula of `rendering-design.md` 2.3.
- Depth: one reversed-Z, infinite-far `depth32float` pass, near 0.05 m, compare `greater`, clear 0. No depth
  partitioning and no scene swaps: cockpit, terrain, planets and stars are one scene.
- Motion vectors are built from the previous frame's float64 camera and body states.
- Hash-critical maths shared by TS and WGSL uses 32-bit integer arithmetic only.
- Time: a tick is exact at any lead. `ut` in seconds resolves 0.24 us in 2037 and 0.95 us at 250 years of
  lead (derived); the error is common to everything evaluated at one tick and changes no relative position.
  Orbit phase uses the tick difference to the orbit's own epoch.
- Illumination spans four decades (1.3 million lux at Mercury to 80 lux at Pluto); exposure, the sun disc
  and shadow penumbrae scale with `BodySnapshot.sunDistance`.

---

## 5. Universe and time model

There is one universe and one time axis. Every vessel has a history up to its own **head**; time only moves
forward; things touch only when they are at the same time. The sentence players learn: *you can only touch
what is at your time, and you can only move forward.*

### 5.1 Vocabulary

| Term | Meaning |
|---|---|
| Tick, UT | Section 3. Bodies are functions of the tick. |
| Head | The latest tick at which a vessel's state is committed. History before it is immutable. It never decreases. |
| Worldline | Per vessel: committed conic segments and sampled integrated arcs up to the head, and after it the **forecast chain**. |
| Forecast chain | The coast of a passive vessel after its head as a list of conic patches across sphere-of-influence changes, each with a valid-from and valid-to tick. Only the directory computes it (U14); clients evaluate the published patches and never chain a solid vessel themselves. |
| Attended | A connected pilot is aboard, or the server is still carrying the vessel for a pilot inside the reconnect grace. |
| Quiescent | On rails or at rest: no thrust, no contact, not in atmosphere. State is a pure function of the tick. |
| Passive | Not attended and quiescent. A passive vessel is on no clock, is never stepped and has no timers: everything about it is computed when somebody asks. |
| Horizon | The tick of a passive vessel's next atmosphere entry or impact, searched over its forecast chain; infinite when the computed chain is a closed orbit clear of every surface and atmosphere, or the vessel is at rest. |
| Clock | A server object (5.2). Every attended vessel is on exactly one. |
| Pacing clock | The clock that paces an object which is neither attended nor passive (debris in atmosphere in the Reduced tier, an unattended run, a fate). It is the clock the object was on when its pilot left or when it was shed, for as long as that clock is live, cohort or shared, or private at 4x or below. When a private pacing clock ends, jumps or exceeds 4x, the object is resolved un-paced at once if a screening finds no solid vessel of another owner within reach of its arc; otherwise it waits as a projected echo and is paced by the live clock from the moment the live clock reaches its head. An object is solid to the islands of its pacing clock. |
| Lead | A clock's tick minus the live clock's tick. |
| Island | Vessels of one clock that could touch within seconds; one step loop, one frame, one thread. Its **anchor** is the lowest vessel id among its attended members, else the lowest id; a change of anchor is a `rebase` operation. |
| Party | Pilots who linked on purpose and share a clock at any distance. |
| Bound, guest | A member of a clock is **bound** to its rate when linked in a party, aboard one assembly with another pilot, or on the live or a cohort clock. Every other member is a **guest**: there by jump, attach or proximity, never able to hold anyone at a rate. |
| Solid | Can be touched: collided with, docked to, targeted for contact. |
| Reservation | The exclusive, epoch-fenced right of one island to touch a passive vessel (U4). It does not move the head. |
| Carry limit | The latest tick to which a clock may take craft whose owners have not explicitly agreed (5.2). |
| Echo | A drawing of a vessel that is not solid for the viewer. A **recorded echo** shows where a vessel that is ahead was at the viewer's time; a **projected echo** shows where a vessel that is behind, reserved by another clock, or beyond its window, would be if it coasted. Echoes never collide and always carry their offset and the one action that makes the vessel reachable. |
| Holder | The one server component that has authority over a vessel: the directory or an island on a shard. |

### 5.2 Clocks

A clock is `{ id, kind, tick0, anchorUpMs, rate, untilTick, limitedBy, members }` with the schedule
`tick(up) = min(untilTick, tick0 + floor(rate x 120 x (up - anchorUpMs) / 1000))`, where `up` is directory
up-time (section 3). Server and clients evaluate the same closed form from the same message; a client never
reports time. `untilTick` is the earliest of: any member's sphere-of-influence crossing, horizon, screened
encounter and target approach; the lead cap; the **carry limit**; and the end of the computed forecast chain
of anything the clock has been screened against. Nobody is drawn past an event the server will stop at.

| Kind | Rate | Members | Who is bound |
|---|---|---|---|
| **Live** | 1, fixed | Everyone who spawned at the default and has not warped. One per lobby. | Everyone (fixed) |
| **Cohort** | 1, fixed, at a fixed lead of `k x 5 min` over the live clock, up to the cohort horizon | Players who took a future pad slot in that bucket (5.9). | Everyone (fixed) |
| **Private** | Set by its host, the one pilot who made it | The host's island or cruising vessel; guests who jumped or attached onto it | Nobody but the host |
| **Shared** | The lowest rate any bound member requests or is limited to | A party; an assembly with two or more pilots aboard | Party members; pilots aboard |

**Membership.**

- Membership is sticky. Pilots who were in one island stay on the same clock after the island splits, are
  still solid to each other and merge again when they meet. Nothing about distance changes a clock.
- A member leaves a clock only by its own act: a rate request the clock does not grant, a jump, a hold or a
  logout. Leaving **forks**: the member gets a private clock at the same tick (U11) and is from then on an
  echo to those who stayed.
- A guest's rate request never binds anyone. If a guest asks for another rate, the guest forks. If the host
  of a private clock changes its rate, the host continues on it at the new rate and every guest who has not
  set **follow** for the host forks onto a private clock at the old rate (clamped to what that guest's own
  situation allows). Both take effect at the stamped tick, at once, unless U11's contact conditions hold.
- Two strangers therefore share a rate only while both choose to: in a party, in one assembly, or at 1x on
  the live or a cohort clock, where the rate is fixed for everybody.
- Joining an attended clock without a link (by jump or attach) has a per-account cooldown of 60 s, and of
  30 minutes for a clock whose host has forked away from that account. A scripted client cannot pin a
  warping player: it never binds them, and it cannot follow them faster than the cooldown.

**Carry limit.** `carryLimit(clock) = min over every craft aboard a vessel on the clock or in one of its
islands whose owner has not explicitly accepted the request in force, of liveTick + advanceLimit(craft)`.
`untilTick`, every jump target, every `warp to` and every advance (U9) is capped by it. A craft's owner
accepts explicitly by making the request or by answering its prompt; idleness, absence and disconnection
count as acceptance only up to the carry limit. Unowned craft impose no limit. Taking a vacant helm of
someone's station, entering the island of a pilot who is away from the keyboard, or advancing an idle group
therefore never carries their craft further than their own `advanceLimit` allows.

**The live clock** is a persisted mapping from directory up-time to ticks. It does not advance while the
universe is down, and after every restart it is held for a **resume window** (30 s for a restart on the same
build, 90 s when the build changed and clients must reload; 15.4), so the pad crowd is still one group and
nobody's burn runs without them. Cohort clocks follow it. Production never suspends the process to save
money (16.2): with nobody connected the directory keeps running in its idle state (6.2), so the live
clock keeps tracking wall time and a fate on the live clock still comes due when it should. The lobby's epoch (the live tick at first start)
is a deployment setting on the tick grid; the default is the start of the `lunar-direct` scenario
(2029-09-24T18:26:58Z).

### 5.3 Rules

Every number below is a field of `UniverseRules`; the values are the defaults.

- **U1. Forward only.** A head never decreases. Nothing committed is recomputed.
- **U2. Solid window.** For a viewer whose clock reads `t`, a vessel is solid when it is on the viewer's
  clock, or when it is passive, not reserved by another clock, and
  `head <= t <= min(horizon, limit, chainEnd)`. `chainEnd` is the end of the forecast chain the directory has
  computed (U14); past it the vessel is a projected echo labelled "not computed this far ahead" until a
  viewer or a screening asks for more. `limit` is infinite for the viewer's own vessels, for party members'
  vessels and for vessels with no owned craft (unowned ships, debris). For any other vessel it is
  `liveTick + advanceLimit(vessel)`, anchored to the live clock (never to the head, so repeated claims cannot
  walk a ship forward). `advanceLimit(vessel)` is the **minimum over its owned craft** of each owner's
  policy for that craft: 30 days by default, 6 years for a craft its owner has marked as a station module;
  an owner may set any value up to the cap. Docking never raises a limit: a 30-day ferry docked to a 6-year
  station makes a 30-day assembly until the ferry's owner raises theirs or undocks. A hard guard refuses any
  claim that would carry another owner's craft past `liveTick + leadCap - 20 years`.
- **U3. Interaction.** Contact, docking, transfer and control exist only between vessels on one clock, or
  between a vessel on a clock and a passive vessel its island has reserved inside its solid window.
- **U4. Claim, in three steps.**
  *Admit*: when a vessel on a clock comes within the join distance (`1 km + 2 s x closing speed`) of a solid
  passive vessel, a copy is loaded into the island in the Armed tier (6.2). Nothing is written; the head
  does not move; islands on other clocks may hold copies of the same vessel at the same wall time.
  *Reserve*: before the copy may leave the Armed tier, that is when a member comes within the armed margin
  (`200 m + 2 s x closing speed`, at least 2 s of closing time before any contact) or addresses a command to
  it, the island asks the directory for the vessel's **reservation**. The directory, the single place where
  competing requests are ordered, grants it when the row is `passive` and unreserved, the island's tick is
  inside the solid window and the carry limit, and no removal, fate or attach of that vessel is in progress.
  The grant is an in-memory decision fenced by the island's epoch (no database write is on its path; it is
  made durable with the next batch and re-asserted by the holder after a directory restart). It does not
  move the head. **An island never steps a tick in which an unreserved copy would be inside the contact
  margin**: if the answer has not arrived it holds at that tick (U18). The margin makes that a matter of
  milliseconds against two seconds.
  *Commit*: the first force, contact, capture, transfer or command that acts on the reserved vessel sets
  its head to the island's tick. For the reservation holder the commit is unconditional, so the island
  steps on without waiting; only the release of the event to clients waits for the durable write (15.1).
  *Release*: when the vessel has been outside the armed margin for 10 s, when the island dissolves, or when
  the island's epoch is fenced, an uncommitted reservation ends and the vessel is exactly as it was: a
  fly-by leaves the head where it found it.
  *Losing*: a denied island removes its copy at the stamped tick, before it could touch it. The vessel is
  then an echo for that pilot with an offer **by relation**: a pilot who is behind the holder's tick is
  offered a jump to the holder's clock; a pilot who is ahead is offered hold or ask-to-advance (U9), since
  nobody can jump back. If the reservation is released uncommitted the copy is admitted again.
  *Order against everything else*: while a vessel is reserved the expiry sweep, pad safing, the fate of
  U13 and removal for any reason do not act on its row; they are applied when it is released, or enter the
  holding island as tick-stamped inputs (a `remove` with its reason) when they must act now. An owner who
  attaches to a reserved vessel is seated on the holder's clock (U8b). Grant, denial and release are
  journaled inputs of the island (7.2), so a replay makes the same claim.
- **U5. Materialise.** When a vessel becomes solid for a clock that is already past its head (a hold, a
  logout, a released claim, a wreck of an earlier cohort reached by the live clock), contact impulses and
  port capture are switched off between it and any vessel whose bounding sphere it overlaps or would reach
  ballistically within 30 s, until the two have first been `Ra + Rb + 5 m` apart. Explosions and plume
  heating still act on such a pair. The exemption is bounded: while the pair overlaps, the vessel that
  arrived later has capture, engines and RCS translation inhibited and receives a server-applied separation
  acceleration along the line of centres, sized to reach clearance in 15 s and capped at 0.5 m/s^2 (a
  journaled input, shown to both pilots as "RANGE: CLEARING"). If clearance is not reached within 30 s the
  later vessel is recovered (removed, reason `recovered`). Nothing stays inside another ship, and nothing
  appears on a collision course seconds from a ship that was there first.
- **U6. Rate.** A private clock may run at any level its host's situation allows: 1-4x while anything on it
  is integrated (the ceiling `physicsWarpMax` is a load-aware rules field), the altitude ladder on rails up
  to 10,000,000x, and 1x inside a launch range (within 150 km of a site and below 100 km altitude). The
  clock is clamped at the next sphere-of-influence crossing, at 1x from 10 s before a screened encounter
  (U10), by the carry limit (5.2), and steps down before the selected target's closest approach (50x at
  60 s, 1x at 10 s). A shared clock runs at the lowest request of its bound members; a change above 1x is a
  proposal with a 15 s ready-check, at most one open proposal per clock and one new proposal per account
  per 30 s. A pilot may set **follow** for a named pilot (their proposals are accepted automatically). A
  bound member who has given no input for 120 s and whose vessel is quiescent or docked, or who is
  disconnected, does not block a proposal, but such acceptance is valid only up to the carry limit.
- **U7. Stopping warp.** On a private clock above 4x the committed head trails the schedule by a stop
  window of 0.5 s of up-time. A rate change or stop stamped by the pilot with tick `T` takes effect at
  `max(T, head)`. The warp therefore stops where the pilot saw it, at any rate, and the server still owns
  the clock: nothing can interact with a private rails clock inside that window. When the request brings
  the rate to 4x or below the vessel is handed to an island before any control input is accepted (6.1);
  the HUD shows the new rate only on the acknowledgement.
- **U8. Jump, hold, meet.** A quiescent vessel (or a clock whose vessels are all quiescent) may **jump** to
  any later tick, or to another clock, which it joins as a guest (5.2). A jump is refused when the interval
  contains its horizon or a screened encounter, when it would pass the lead cap or the carry limit, when a
  ballistic screening of the arrival predicts an approach inside `Ra + Rb + 50 m` in the next 30 s, or when
  it would arrive on another pilot's clock inside the join distance of an attended vessel whose pilot is not
  linked with the jumper. Whatever it overlaps on arrival is handled by U5; there is no separate arrival
  radius, so a jump and a hold reach exactly the same places. A refusal names the reason and carries an
  **alternative**: the latest clean tick, 10 s before the first encounter. The planner chains "jump, pass at
  1x, jump" so an in-phase offer completes in a crowded orbit. An attended vessel near the arrival point is
  notified. **Hold** is rate 0: the pilot stays seated while the vessel is, for every purpose, passive.
  **Meet** fixes a tick not earlier than two pilots' heads; each warps there privately and they link on
  arrival. The planner offers a jump that arrives **in phase** (the first tick at or after the target's
  time at which the chaser's coast puts it at the wanted phase angle).
- **U8b. Where a pilot resumes.** Leaving hold, attaching to a parked ship and returning after a
  disconnect all seat the pilot by one rule, in this order: (i) on the clock of the island that currently
  holds or has reserved the vessel, if any; (ii) else on the clock the pilot asked for
  (`Attach { clock }`), if that clock's tick is at or after the head and the vessel is already solid to it
  (it is already there: no arrival check, U5 applies), as a guest; (iii) else on the live clock, if
  `head <= liveTick` and the interval contains no horizon and no screened encounter; (iv) else at the head
  on a new private clock. Leads therefore shrink by themselves while a player is away.
- **U9. Advance for a visitor.** A pilot who is ahead of an occupied group may ask it to advance to their
  tick. Granted when every vessel in the group is quiescent, the interval is clean for every member (U8
  checks), the target is within the group's carry limit, and every bound pilot accepts or does not block
  (U6). While a request is open the group accepts no further visitors, so the wait is bounded by one
  ready-check. After a refusal the same account may ask the same group again after 5 minutes.
- **U10. Nothing tunnels through warp.** Before any rate above 4x and before any jump, every member's
  trajectory is screened over the whole interval against the solid predicate as a function of time: passive
  vessels from their heads on along their forecast chains, and the other members of the same clock. A
  predicted miss below `Ra + Rb + 10 m` is an **encounter**: the clock is at 1x from 10 s before it, both
  vessels are in one island, and the pass is integrated with swept tests (7.4). Every later conic commit by
  anyone is re-screened against clearances already granted and may shorten `untilTick`, but only to a tick
  the client has not yet displayed: never earlier than the schedule's value at now plus the stop window
  plus one round trip (0.25 s). An encounter that falls before that tick is a case of accepted
  inconsistency (a) and is logged.
- **U11. Leaving a clock.** A vessel may leave alone (rate change, jump or hold; 5.2) unless it is in
  contact, in soft capture or docked, or a ballistic screening predicts contact (miss below
  `Ra + Rb + 10 m`) within 30 s. The departure takes effect at the stamped tick and is not delayed; the
  other pilots in the island see a notice for 10 s and the departed vessel as a recorded echo. Nobody can
  veto, and proximity alone never blocks.
- **U12. Passive against passive is not simulated.** A passive vessel has no "when" in which to collide.
  The one exception is U13.
- **U13. Fate.** Beyond its horizon a passive vessel, **a ship or a piece of debris alike**, is a projected
  echo labelled "fate pending"; up to the horizon it is passive and solid. Its fate is an unattended run
  (6.2) started when its pacing clock (5.1) reaches the horizon, paced by that clock and solid to the
  islands it meets, unless its owner flies it first. A stage dropped on the live clock therefore falls
  through the corridor as a physical object that a later rocket can hit. An immediate un-paced resolution
  is allowed only under the pacing-clock rule of 5.1 (a private clock, nothing of another owner within
  reach of the arc).
- **U14. Spheres of influence and forecast chains.** Crossings are exact per vessel on rails. An island
  crosses as a unit at its anchor's crossing tick, **Armed members included**; a merged island adopts the
  anchor's frame at the merge tick; a shared clock clamps to the earliest event of any member. The
  directory extends a passive vessel's forecast chain lazily, up to the furthest tick that a subscribed
  viewer, a screening or a horizon search needs, at most 16 patches, stores the patches as `forecast`
  worldline segments and publishes them in the census with their validity intervals. A commit that changes
  the vessel's orbit discards its forecast.
- **U15. Burns** run on the vessel's own clock at 1-4x.
- **U16. Disconnect and logout.** A socket is **lost** when it closes or when no frame has arrived for 3 s
  on a 1 s ping; a hidden tab is not a disconnect, and a stall shorter than that changes nothing (controls
  stay latched). What happens at a declared loss, with timers in directory up-time entering the island as
  stamped inputs:

  | Situation | Rotation and translation | Throttle | Helm seat | Clock |
  |---|---|---|---|---|
  | Solo island | latched 10 s, then zero (SAS keeps its mode) | latched 10 s, then closed | - | a private clock above 1x goes to hold at `max(last stamped tick, committed head)` |
  | Island with another owner's vessel | zero after 250 ms | closed after 2 s | - | the member counts as requesting 1x for itself; if the others continue it is forked (U11) |
  | Helm of an assembly with other pilots aboard | zero after 250 ms | closed after 2 s | reserved for the reconnect grace, unless the anchor's owner takes it | as the row above |

  The reconnect grace is 120 s. After it, or on an explicit leave, the throttle is closed at that tick,
  then: a quiescent vessel becomes passive at its head; any other is flown to rest by an **unattended run**
  with no invented input (no stage fired, no chute opened), paced by its pacing clock (5.1). A vessel is
  never removed from an island during contact. The flight menu states these outcomes before the player
  leaves. A returning pilot is seated by U8b. After a shard loss or a restart the latch and dead-man timers
  start when the pilot has resumed or the grace has ended, never while the pilot could not see (15.4).
- **U17. Lead cap.** No clock may run more than 250 years ahead of the live clock. Hold is always available.
- **U18. Overload and holds.** An island that cannot hold 120 Hz, or that is held (waiting for a
  reservation answer, for terrain, or for its pilots after a recovery), leaves onto its own clock running
  below 1x and is shown as `behind`. It rejoins by a jump (U8), offered as one key, when it is next
  quiescent. No other island is affected.
- **U19. Timer bases.** Every timer runs on one of the three bases of section 3. Pad occupancy is a tick
  interval; reservation holds, ready-checks, helm requests and the reconnect grace run on directory
  up-time and so do not expire while the universe is down; expiry runs on the wall clock, and an outage
  longer than one hour extends every expiry deadline by its length.

### 5.4 What players at different times see

Each client evaluates bodies, lighting and site daylight at its own clock. The menu shows the live clock.

| The other vessel is | behind me | on my clock | ahead of me |
|---|---|---|---|
| passive, inside its solid window | Solid at my tick; admitted, reserved and claimed if I reach it (U4) | (a passive vessel is on no clock) | Recorded echo; "JUMP +3 d 4 h" |
| passive, reserved by an island on another clock | Projected echo; "IN USE: HOLD or ASK TO ADVANCE" if I am ahead of the holder | | Echo; "JUMP" to the holder's clock if I am behind it |
| passive, outside its window | Projected echo: "fate pending", "not available this far ahead" or "not computed this far ahead" | | |
| attended | Projected echo of its coast, updated when its pilot manoeuvres; "ASK TO JOIN" or I hold | Live and solid | Recorded echo; I can jump to its clock, or ask it to hold |

`SimSnapshot.time` (`TimeView`) carries, for the HUD's time strip: `myTick`, `liveTick`, `rate`, `maxRate`,
`limitedBy` (kind and text, with the vessels that cause it), `relation` (`live`, `ahead`, `behind`),
`offset`, the clock's `members` and open `proposals`, and `offers` (the actions available now: jump, hold,
ask to advance, meet, link, follow). `SimSnapshot.warp` stays and is derived from it. Every vessel snapshot
carries `presence` (`solid`, `recordedEcho`, `projectedEcho`) and `timeOffset`. The map has a read-only
"view at this vessel's time" control.

### 5.5 Arranging a rendezvous

The planner works on the target's worldline as a function of time: committed segments up to its head, coast
forecast after it, with the boundary marked.

1. **Passive target, not ahead**: plan against its conic, warp privately, U10 brings the clock to 1x before
   the join distance, U4 admits it. Nobody is asked.
2. **Target ahead** (passive with a later head, or attended on a later clock): reach orbit first, then
   jump in phase. A long jump always comes before the approach: a 1 m difference in semi-major axis in low
   orbit is about 160 km after three years.
3. **Another pilot, later**: MEET at a tick; both warp privately; LINK on arrival.
4. **Another pilot, now**: whoever is behind jumps, or whoever is ahead holds; then LINK and fly the phasing
   with warp by ready-check or follow. Inside the join distance the server merges the islands.
5. **Arriving ahead of an occupied station**: the station is a projected echo; ASK TO ADVANCE (U9, within
   the station's carry limit), hold, or park and log out (the pilot is seated by U8b on return).
6. **A jump refused for an encounter on the way**: the refusal carries the latest clean tick; the planner
   offers "jump, pass at 1x, jump" as one action.

### 5.6 Warp in every situation the brief names

| Situation | What happens |
|---|---|
| Alone, quiescent | Any permitted level at once; stop is instant (U7) |
| Alone, burning or in atmosphere | 1-4x physics warp: more steps, never longer ones |
| On the live clock near the pad | 1x inside the launch range; above it, warping forks a private clock |
| Entering warp near a passive vessel | Allowed; U10 has screened the pair; an encounter forces 1x and an island |
| Inside an island with other pilots | A rate change is a proposal (U6). Leaving alone follows U11 |
| In contact, soft capture or docked | No rate change by one craft; a docked assembly is one vessel on one clock, the helm proposes |
| Dropping out of warp, ending a jump, joining a clock | U8 screening and U5: nothing stays inside another ship or arrives on a collision course; the vessel is in an island before controls are live (U7) |
| Socket lost during warp | The private clock goes to hold at the last stamped tick (U16); nothing runs on for years |
| Sphere-of-influence change ahead | The clock clamps to the crossing, then continues if still permitted |
| Logout | U16; the flight menu states the outcome first |
| Cleanup | Section 15.5, on the wall clock |

### 5.7 Paradoxes and how each is excluded

| Paradox | Exclusion |
|---|---|
| Changing something's past | U1; recorded echoes are not solid |
| Touching a future its pilot has not flown | Attended-and-behind vessels are projected echoes |
| A stranger dragging a ship or a station far ahead | U2: the limit is anchored to the live clock and is the minimum over the owned craft; the carry limit (5.2) bounds a clock that already carries the craft, so docking, taking a vacant helm, an idle crew or an advance never pass it; the guard band before the cap |
| A fly-by that exiles a parked ship | U4: admission and reservation do not move the head; only a first interaction does |
| Two players at different times taking one passive vessel | U4: one reservation at a time, ordered by the directory, taken at least 2 s of closing time before contact; an island never steps an unreserved copy into the contact margin, so the loser has resolved nothing against it; the loser's offer depends on who is ahead |
| A parked ship vanishing or changing clock in front of a docking ferry | U4: sweep, safing, fate and attach respect the reservation |
| Leaving a collision course by changing time or by logging out | U10 before any encounter; U11 on predicted contact; U16 paces unattended runs on shared clocks in real time |
| Appearing inside or onto another vessel | U8 screening; U5 with its 30 s bound, inhibited controls and recovery |
| Being held at 1x by a neighbour or by a scripted client | 5.2: only bound members share a rate; a guest forks; U11: only contact or a predicted contact inside 30 s blocks a departure; the join cooldown |
| An absent crew member blocking a visitor | U6 idle rule, follow, and "a disconnected member never blocks" |
| A vessel existing twice or vanishing | One record, one holder, fenced by epoch (6.1); clients never hold state |
| A pad used by two rockets | One timetable of tick intervals per pad across all clocks (5.9) |
| A decaying parked ship seen "already crashed" by someone ahead | U13: beyond the horizon it is a projection, never history |
| Time running backwards after a crash | The live clock is a stored mapping; every island is restored at its own durable tick and never earlier (15.4) |
| A burn running on while its pilot cannot see | 15.4: islands in flight are held until their pilots resume; U16 timers start at the resume |
| A coasting ship that has no defined state after its next sphere-of-influence change | U14: the directory's forecast chain; the window ends where the chain ends |
| Launched earlier, should have hit a committed history; passive against passive | Not excluded (decision 53) |

### 5.8 Why this model

A solo player keeps everything single-player KSP gives, up to 10,000,000x, with no waiting on anyone and
instant stops. The launch site is a shared place by construction (default spawn on the live clock, the range
rule, cohorts). Meeting someone is one action for whoever is behind. Nobody's warp can touch a burn in
progress and nobody can be pinned at 1x (5.2, U11). The alternatives fail the brief: one clock makes Mars eight months
away or lets one player's warp wreck every burn; subspaces with client authority duplicate and rewind
ships; timeline repair teleports them. The price is stated to the player, not hidden: an offset next to
every name, echoes that cannot be touched, and a sky that after the first warp is mostly echoes, each one
keypress away for whoever is behind. That last point is not left to hope: the load test measures how much
of the lobby is mutually solid when bots warp as players do (28.7, target and tuning fields stated there),
an acceptance story has two strangers who warped to different leads end up docked using only offered
actions (28.5), and the lead play-tests the U6, U8 and U9 defaults between waves 5 and 6 and writes the
result into OPEN_QUESTIONS Q7.

### 5.9 Pads and time

- A spawn is a pad and a tick. Each pad has **one timetable** of non-overlapping tick intervals
  `[t, t + dwell + safing]` across all clocks, on the pad's own clock (U19). There are no per-clock copies
  of pad state.
- The default slot is the live tick. When the wait for a live pad of the vehicle's class exceeds 60 s the
  menu offers the earliest free **cohort slot**: buckets of 5 minutes up to the **cohort horizon**
  (`cohortHorizon`, default 14 days). Everyone in a bucket shares one cohort clock and is solid to each
  other; other cohorts are echoes.
- **What cohorts buy.** Every clock runs at 1x, so the complex produces `pads x 3600 / cycle` launch slots
  per wall hour for ever (768 with 32 pads and a 150 s mean cycle) plus a one-time **reservoir** of
  `pads x horizon / cycle` slots (258,000 with a 14-day horizon). The reservoir is what absorbs a front-page
  day: 240,000 sessions of one launch each fit in the first 24 hours, each bucket flying at once in wall
  time. It refills only at the sustained rate. The trade is stated to players: during a spike people start
  up to 14 days ahead of the live clock, 64 to a bucket, and are echoes to the live crowd until someone
  jumps. Sustained demand above the sustained rate needs more pads, a shorter cycle or fewer launches per
  session (16.3); a longer horizon only postpones it.
- The menu also offers a **launch-window slot** ("plane crossing in 46 min", as a cohort) and a friend's
  clock. Waiting for a window is done by choosing the slot; there is no rails warp on a pad.
- Debris and wrecks of an earlier cohort become solid for later clocks under U5; pad safing removes anything
  at rest inside a keep-out radius.

---

## 6. Authority and compute split

### 6.1 Authority

- Every vessel has exactly one **holder**, recorded in the directory with an **epoch** number: the directory
  itself or one island on one shard. Writes, frames and events that carry an old epoch are rejected, so a
  shard that was presumed dead cannot speak for islands that were recovered elsewhere. The directory itself
  is fenced the same way against a second directory process (15.3).
- **Who holds what.** A passive vessel is held by the directory. An attended vessel at 4x or below is
  **always held by an island on a shard**, in its rails state at zero step cost while it coasts, so a
  throttle or RCS input never waits for a hand-over. Only an attended vessel above 4x is held by the
  directory (`cruising`); its island is materialised when the rate request drops to 4x or below, **before
  any control input is accepted** (U7).
- **A hand-over** (directory to island, island to island, island to directory) is: serialise at a tick, the
  receiver acknowledges, the directory flips the pointer and increments the epoch in memory, the receiver
  steps. The flip is written ahead in the next batch; no database commit is on the path of an input. If the
  directory dies before the batch, recovery finds the old holder's last durable state and the island
  re-registers (15.4).
- **No island steps past a pending merge tick.** When the directory decides that two islands merge at tick
  `M` (they will be inside the join distance), both are told `M`; each stops at `M` if the migration of the
  other has not completed, and is `behind` (U18) for that long. A pair at the join distance is at least 2 s
  from contact, so the stop is normally never reached.
- **Lag is drained before a read.** Any arrival screening, admission, reservation or claim that reads an
  island's state first brings a trailing island (6.2) to the reader's tick.
- Two vessels exchange force, propellant, crew or control only inside one island: one clock, one step loop,
  one thread.
- Irreversible facts carry `(vesselId, epoch, tick)` and are idempotent: structural operations (split,
  merge, destroy, capture, release), ids of spawned vessels, pad assignments, reservations and claims, helm
  changes, warp grants. A shard may therefore re-send them after a directory restart.
- Same-tick ordering is canonical: vessels by id, then parts by index, commands by `(tick, pilot account
  id, sequence)`. The journal records the applied order, so a replay reproduces a live run.

### 6.2 Tiers and lanes

Simulation tiers (what the server does for a vessel):

| Tier | Step | Applies to | Cost (measured, desktop core) |
|---|---|---|---|
| Rails | none | Passive vessels (no timers at all: chains and horizons are computed on demand, U14); attended quiescent vessels at any warp (one timer per event of their clock) | 0 between events; 0.15-0.26 us per Kepler evaluation |
| Armed | none; a swept-sphere test at 10 Hz against the island's other members | A quiescent vessel inside an island that is farther than the armed margin `200 m + 2 s x closing speed` from every other member (a parked station while a ferry approaches) | under 0.1 us per second |
| Full | RK4 at 120 Hz for the centre of mass with the semi-implicit attitude update, exactly as v1's `stepVessel`. The **sub-stepped path** (four semi-implicit sub-steps, 480 Hz) is taken only by a vessel with a ground or water probe within 5 m, and by a **pair** inside the speculative-contact margin: both vessels of a pair enter it at the same tick and leave it at the same tick | Thrust, RCS translation, atmosphere, contact, soft capture, anything inside the armed margin | 2.6-14.5 us per step; 45 us mean, 244 us p99 at touchdown |
| Reduced | 2 Hz, paced by the pacing clock (5.1) | Debris in atmosphere outside any island, owned or not | 0.35 us per step |
| Unattended run | Full fidelity, no pilot | A vessel whose pilot left while it was not quiescent; a fate (U13) | as Full; paced by its pacing clock, un-paced only under the rule of 5.1 |

An object in the Reduced tier or in an unattended run is solid to the islands of its pacing clock: when one
comes within the join distance it is admitted to that island and stepped in the Full tier there.

Lanes (when the server runs the steps of a Full-tier island). All lanes run the identical loop on the
identical stamped inputs. `src/universe` defines the scheduler interface (the caller says how much up-time
has passed) and the acceptance window; the executors live in `server/`.

| Lane | Tick `k` is stepped | Used for | Worker utilisation target |
|---|---|---|---|
| Real-time | at `wall(k)`, with a jitter buffer of two control ticks | Islands with vessels of two or more owners; any island in contact; every island while `lagCap = 0` | 50 % |
| Trailing | any time before `wall(k) + L`, in batches | Single-owner islands | 85 % |
| Deferred | whenever a core is free | Un-paced unattended runs, crash-recovery replays, audits | whatever is free |

- **Ticks are scheduled by sleeping, never by spinning.** A worker sleeps to the next tick boundary (the
  two-control-tick jitter buffer absorbs a millisecond of wake-up error), so Railway bills what is used and
  an idle shard costs its memory. The load test reports billed vCPU-seconds per integrated vessel-second
  and idle shard CPU.
- **An empty universe steps nothing: the idle state.** A passive vessel is on no clock and has no timers
  (5.1), so when the last island is gone and the last grace, hold and pad slot has ended (minutes after the
  last pilot left; an unattended run or a piece of debris in atmosphere is first flown to rest), the tick
  loop stops. What then remains on a timer: the renewal of the writer lease (one UPDATE every 5 s over one
  Postgres connection); a metrics sample every 30 s (memory and the cost numbers of section 27); one timer
  for the earliest `horizon_tick` on the live or a cohort clock (a fate, U13: a worker and the terrain it
  needs are ready 60 s before it, the unattended run is flown, and the process goes idle again); and the
  hourly dump job and the nightly audit, which live outside the process (15.3). Everything else runs **when asked for instead of on a timer**. The expiry sweep is due every 60 s
  but is skipped while no session is open and no public document is requested, and it runs first, before
  the answer, when the next request arrives: nobody can observe a removal between two sweeps, and the
  pressure rule cannot trigger while nobody launches. The public documents are built on request and
  cached for a second (13.1). The pad timetable is a table of tick intervals that is evaluated when it is
  read. Journal and checkpoint partitions are created with the first island and dropped by their
  retention rule, after which there is nothing left to drop.
- **How much stays resident while idle is a setting, `idleLevel`.** **Warm** is the default at stages 0
  to 2: one worker isolate stays up and the resident pyramids of the bodies that have launch sites stay
  loaded (Earth's is 102 MB decoded); every other residency, and every tile-store entry beyond those
  pyramids, is released ten minutes after the last island left. Warm costs 0.1-0.25 GB, that is $1-2.50 a
  month, and removes a path: the first Deploy after a quiet spell is the first Deploy of a busy server
  and depends on nothing fetched over the network at that moment. The user accepted an idle floor of
  about $30 so that nothing fragile is bought with it; a teardown and re-creation of isolates on every
  quiet evening, and a first launch of the day that waits on a 48 MB ranged read from the bucket, is
  exactly that. **Light** also terminates the worker isolates and releases every residency. It is the
  setting for the extra shards of stage 3, where an idle shard is worth money and the directory places
  the first island of a quiet spell on a shard that is already warm; a shard coming out of the light
  level starts a worker and loads the body's resident pyramid from the bucket (1,020 tiles and 48 MB for
  Earth: 1-3 s, assumed, measured in the launch rehearsal).
- **Coming back from idle is not a wake-up.** The process, its sockets and the database never stopped, so
  the title, the menu and the public documents answer at once, and at the warm level the worker and the
  terrain a first Deploy needs are already there. Budgets in 29.2.
- **Inter-role traffic is batched.** One frame per gateway process per shard per control tick in each
  direction; one batch (or a SharedArrayBuffer ring) per worker per tick between a shard's main thread and
  its workers. No message crosses a thread or a socket per input or per vessel. Main-thread utilisation of
  every shard and of the directory is a published metric and a line of the capacity report.

Rules for the commit lag `L` of a single-owner island:

- `L <= min(lagCap, tau / 20)` and `L = 0` once `tau <= 4 s`, where `tau` is the smallest reach time to any
  solid vessel of another owner: `(distance - join distance) / closing speed`, with a worst-case mutual
  acceleration of 60 m/s^2 included, computed by the server from its own state.
- `L = 0` during a **threshold watch**: any part within 10 % of its temperature limit, structural load above
  80 % of a joint limit, a contact probe within 2 s of the ground, or a parachute outside its safe envelope.
- An input stamped for tick `k` is applied at `k` when it arrives before the server steps `k`; later, it is
  applied at the arrival tick. **Every input is acknowledged with the tick it was applied at**
  (`InputAck { seq, appliedTick }`, sent with the next delta), so the client replays with the server's
  tick and a gateway's input buffer can reproduce what a dead shard did. The window is the jitter buffer
  in the real-time lane and `L` in the trailing lane, so a TCP stall shorter than `L` costs a solo pilot
  no correction. The server never accepts a stamp beyond `clock(up) + 0.25 s`.
- A late **command** is re-timed, never refused for being late: validity that depends only on the craft's
  own stage state (lockout, next stage) is judged as of the stamped tick, so a command the client could
  legally show is not refused afterwards (6.4).
- **`lagCap` is 0 in the first release.** It is raised to 2 s only on evidence: the lane-equivalence suite
  green (28.2), the multi-client `lagCap = 2 s` profile green (28.4), and the load test's A/B run at one
  ramp level showing what it saves (28.7). A launch day is provisioned as real time in any case:
  neighbours 1 to 2.5 km apart on a pad row hold `L` under 0.35 s for a whole ascent.
- A leased burst job on Modal is never the holder of an attended vessel.

### 6.3 Who computes what

| Situation | Server | Client | Send rate |
|---|---|---|---|
| Parked, coasting or landed, nobody aboard | Nothing between events | Kepler evaluation for drawing | one census entry on change |
| Menu, not playing | One public snapshot a second for everyone | Census replica | HTTP, cached 1 s, no socket |
| Coasting or warping with a pilot | The clock schedule; event timers; screening when the orbit changes (10-20 ms once, derived) | Same schedule, same propagation; all planning | clock on change |
| Ascent, burns, entry, landing, alone | Every step from stamped inputs (real time while `lagCap = 0`) | Predicts the island with the same code; replays on correction | 10 Hz (2-5 Hz with the trailing lane) |
| Near another owner's craft | One island, real time, contact pass | Predicts every vessel in the island | 30 Hz |
| Contact, soft capture, collision | 480 Hz sub-steps; every outcome | Forces only, never outcomes | the pair at 60 Hz, exact; events reliable |
| Pilot left mid-flight | Unattended run | - | 1 Hz to watchers |
| `SimSnapshot`, readouts, navball, staging delta-v, patches, nodes, closest approaches to one target, proximity plot, launch windows, capability read-outs | Stores nodes as an opaque blob with the ship | Everything (35-42 us per snapshot, 27-140 us per prediction, measured; more than stepping the vessel) | - |
| Conjunction screening, census, pad timetable, debris fates, expiry, admission | Directory and its helper threads | Receives its own conjunction list | on change |
| Planning for a weak client (`cpuScore` below `weakClientCpuScore`, a rules field set from the calibration data of wave 4) | The API's planning endpoint runs the same pure functions, cached per (vessel revision, target revision) | Skips the computation; census and near-tier rates are halved | on change |

**Planning is a service with three providers.** `PlanningService` (`session.ts`) offers patch prediction,
closest approaches between two chains, the proximity plot and launch windows; every call is asynchronous
and keyed by vessel and target revision, so the map and the HUD never import the simulation and never block
a frame. Providers, all running the same functions of `src/sim/orbit` and `src/sim/nav`: **in-process**
(`LocalSession`, tests, bots), a **planning worker** in the browser, and the **API endpoint**. The chooser
is a table in `UniverseRules`, not an optimiser: the worker when the estimate is under 50 ms or the link is
down; the cache when the key exists; the endpoint for a weak client or an estimate above the threshold.
`netcode-client` owns the providers and the chooser; the acceptance is that a weak client shows the same
closest approaches as local computation to tolerance, with the endpoint's p95 latency and cache hit rate
reported. Bots, bakes, replay audits and bucket throughput tests are batch work on Modal.

The balance between server and client is therefore set by four dials, each with a measurement behind it:
`lagCap` (how far a solo island may trail), `physicsWarpMax`, the planning chooser's thresholds, and
`weakClientCpuScore`. The load test runs one ramp level twice (`lagCap` 0 and 2 s) and once with a share of
low-score bots, and reports server CPU, egress and correction rate for each (28.7).

### 6.4 What a client may show before the server

- Attitude, throttle, translation, contact forces and the soft-capture spring are predicted.
- In a **single-owner island**, command-triggered structural changes of the pilot's own craft (stage, abort,
  legs, chute deployment, undocking two of their own craft) are applied locally at once, **provided the
  measured input margin is positive for the stamped tick**; otherwise the client waits for the server's
  operation. Client and server run the same inputs at the same ticks, and spawned vessel ids are
  deterministic. If the command nevertheless arrives late (a stall), the server re-times it and the client
  replays the same operation at the acknowledged tick: the pieces stay separated on screen and move by the
  difference. A re-time is a **correction**; a command that was shown and then did not happen is a
  **reversal**, and the tests require zero reversals (28.4).
- **Threshold-triggered outcomes are never predicted**: part destruction by heat, impact or overstress,
  joint breaks, explosions, crew loss, chute failure, and the confirmation of a touchdown. The predict step
  mode holds a part at its limit; the outcome arrives with the server's event, at most one round trip later
  because a threshold watch has already drained the lag.
- Anything that touches another owner's craft (capture, hard dock, undock, collision, another pilot's
  staging), helm changes and clock grants are shown only on the server's event.

### 6.5 Overload: the order in which things give way

1. Trailing islands' lag grows toward `lagCap` (invisible; only once `lagCap > 0`).
2. The hot shard stops receiving islands; single-owner islands migrate to cooler workers and shards.
3. Un-paced deferred work waits.
4. At stage 3 the scale controller adds shard services and gateway replicas (16.2): shards are pulled by
   image digest, not built, and nothing restarts. The measured time from trigger to new shards taking
   islands is in the capacity report. **At stages 0 to 2 this step does not exist**: nothing scales by
   itself, and steps 5 and 6 carry the load until a human moves the deployment up a stage (16.2).
5. Dilation: U18, single-owner islands first; an island above its vessel budget (7.2) dilates and its
   neighbourhood is closed to new arrivals.
6. Admission: new spawns queue in the menu, which holds no socket. A queued player spectates from the
   public documents (the `live.json` markers and the census snapshot of the menu region, 13.1): no socket,
   and no server cost per spectator beyond the publisher's request and byte budgets (13.1) or, once `pub`
   is its own service, CDN misses. When the publisher's daily byte budget is spent the spectating view
   is the first thing to go: a queued player keeps the title, the live Earth, the queue position last
   received and the note that the lobby is busy.

Admission is driven by measurement: the directory admits a pilot only while the fleet's p99 step time is
under 6 ms of the 8.33 ms tick, and never beyond the stage's **admission cap** (16.2: 20 at stage 0 until
its load test replaces the figure). The cap bounds what players can add to the bill of a stage that
nobody is watching; the egress budgets of 16.2 bound what everyone else can. The cap is a setting: a
rehearsal environment lifts it for the compute ramps, so that admission there comes from measured step
time alone (28.7).

---

## 7. Simulation core (shared by server and client)

Design for formulas and numbers: `docs/research/sim-design.md`, `docs/research/v2/fleet-docking.md`. The
same TypeScript runs in the shard workers, in the in-process universe and in the client replica.

### 7.1 Layers

- **Orbits, frames, bodies, navigation** (`src/sim/orbit, frames, bodies, nav`): universal-variable Kepler
  propagation, event finding, patch prediction across SOI changes with maneuver nodes, closest approach to
  a body and to a vessel's conic chain, conic-against-conic conjunction screening, jump and phase planning,
  ephemerides and rotation, atmospheres, navball and readout maths, launch windows, target-relative
  navigation. Pure functions of state and `ut`.
- **Vessel, dynamics, control** (`src/sim/vessel, dynamics, control`): the vessel and craft model (7.2),
  mass properties, resources and flow, engines, staging per craft, aerodynamics, heating, structural
  failure, parachutes, legs, ground contact, buoyancy, colliders, SAS and actuator allocation, the binary
  codec, and the per-vessel force evaluation. It sees the world only through `VesselEnvironment`.
- **Island** (`src/sim/island`): N vessels on one clock's tick grid. Owns the per-vessel state machine
  (landed, rails, armed, integrated), exact rails advance to events, SOI hand-over as a unit, the reference
  orbit and the anchor, the step loop (v1's RK4 path for every vessel that has no ground probe within 5 m
  and is in no pair inside the speculative-contact margin; the sub-stepped path with the vessel-vessel
  contact and capture pass otherwise, 6.2), swept tests, structural operations, the island codec (7.2), and
  the two step modes: **authoritative** and **predict** (threshold transitions suppressed). It knows no
  player, no socket, no storage and no clock other than its tick: everything from outside reaches it as a
  tick-stamped input. An island of one with no origin produces exactly the numbers of v1's `stepVessel`,
  and never takes the sub-stepped path unless v1 would.
- **View** (`src/sim/view`): pure builders of the presentation blocks from island state plus client-side
  planning state: `SimSnapshot` assembly with presentation interpolation, readouts, navball, staging info,
  patches and markers, burn bookkeeping, target and docking readouts (through the navigation functions
  whose signatures the contracts fix). Never runs on a server.
- **Universe** (`src/universe`): the directory (records, worldlines, forecast chains, solid windows,
  reservations and claims, epochs), clocks and the rules of section 5, island lifecycle (materialise, merge,
  split, to rails, migrate) and the scheduler interface, screening, the pad timetable, expiry, the
  milestone observer for optional objectives. Time and storage are injected. Its server-facing interface is
  `UniverseHost` (spawn, attach, detach, input, command, time request, subscriptions) which emits the typed
  messages of section 13.
- **Session** (`src/session`): `LocalSession`, the in-process universe behind `FlightSession`, and
  `createSession`.

Key rules carried from v1: point-mass gravity of the current SOI body both on rails and when integrating
(mode switches are exact); rails propagation always from the epoch state; physics warp is more steps, never
a bigger step; free flight is RK4 at 120 Hz and only contact is sub-stepped at 480 Hz; terrain only through `TerrainProvider`; the atmosphere
co-rotates; Earth's rotation gives the pad its 439 m/s; SAS never fights aerodynamics; SAS only holds
attitude and nothing steers, stages or plans automatically.

### 7.2 Vessel, craft and part model

```ts
interface CraftRuntime {
  craftId: string;                 // issued by the directory; never changes
  vehicleId: string; vehicle: VehicleDef;   // a shipped vehicle today; a stored design later (section 32)
  ownerId: string | null;          // account; null = nobody
  name: string;
  joinedTick: number;              // seniority inside an assembly
  nextStage: number; stageLockout: number; pending: PendingAction[]; sinceStaging: number;
  policy: { lendAttitude: boolean; lendEngines: boolean; lendPropellant: boolean; helm: 'owner' | 'crew' | string[] };
}
interface DockLink { a: number; b: number; roll: number }     // part indices of the two port parts
interface Vessel {
  crafts: CraftRuntime[];          // length 1 for anything that never docked
  links: DockLink[];               // empty for anything that never docked
  helm: { accountId: string | null; craft: number; controlPart: number };
  parts: PartRuntime[];            // each with `craft`: index into crafts
  ...
}
```

- **Forest plus links.** Each craft keeps its own part tree with its own root. Docked joints are links,
  never parent pointers, so decouplers keep cutting the same joint, a tree is never re-rooted by docking,
  and rings are expressible. `separateVessel` computes connected components over tree edges and links.
- **Per craft**: stage stack, abort sequence, action groups, pending timed actions, owner, lend policy.
  **Per command part**: crew, seats, hatch, cockpit interior id, the `remote` flag. `VehicleDef.cockpit`,
  `VehicleDef.crew` and `VehicleDef.cameras.cockpit` remain as authoring conveniences that the assembler
  copies onto the command part; consumers read the command part.
- **Flow.** A flow group is `(craft, stageGroup)`. Docking never pools propellant. Transfer is a commanded
  pump between two flow groups joined by docked ports that carry the resource; an owner may always pump out
  of their own tanks; pumping out of someone else's needs `lendPropellant`. Cross-feed across a port needs
  both owners. A transfer is a pure state process and continues on rails in closed form.
- **State is whole.** What v1 kept in `Vessel.struct` and was not derived (friction anchors, thermal wake
  factors, wet flags, probe contact flags) is vessel state. The binary codec (`src/sim/vessel/codec.ts`)
  carries the complete dynamic state, non-finite numbers tagged and the sign of zero preserved;
  `stateHash` hashes the codec output. Codec round trip is exact in every regime, including a lander
  mid-touchdown and a capsule in entry. It is used by persistence, hand-over, keyframes and the client's
  rollback ring.
- **The codec is versioned, because ships outlive deploys.** Every blob starts with a codec version and
  the `defsHash` it was written under. Per craft it carries a vehicle reference of one of two kinds: a
  library id with the content hash of that `VehicleDef`, or an embedded design (the future builder's
  `craft.design`); vehicles are resolved through an injected resolver, never by indexing the library. Per
  part it carries the fingerprint of its `PartDef`, and module and resource blocks are length-prefixed, so
  an unknown or changed block is detected instead of mis-read. Rules that keep old blobs readable: part,
  module and resource ids are never removed or renumbered, only deprecated; a change of a part's modules,
  resources or mass is a new fingerprint with an entry in the **migration registry**
  (`src/sim/vessel/migrations`: pure, tested functions from an old fingerprint's state to the new one,
  clamping resource amounts to the new capacity and recomputing mass properties). Migrations run lazily on
  load and eagerly in a post-deploy sweep that lists every stored vessel and checkpoint the new library
  cannot decode **before the lobby opens**. CI keeps a corpus of blobs written by every released build and
  proves each still decodes and re-validates.
- **The island has state of its own, and it is whole too.** `src/sim/island/codec.ts` carries, besides its
  vessels: the member list with tier flags (Armed or Full) and the anchor; the reference orbit; nascent
  (born-overlapping) pairs; U5 pairs with their clearing timers; soft-capture constraints with their clamp
  and timeout timers and the hard-dock dwell timer; threshold-watch flags; admitted copies with their old
  heads and reservation state; a pending merge tick; per pilot the latched controls, the open latch and
  dead-man timers and the inputs queued in the jitter buffer. `islandHash` hashes this output. The island
  codec is what `island_ckpt.state`, migration between workers, `IslandEnter` and the lane-equivalence,
  replay and audit comparisons use; a checkpoint taken at a staging tick restores the stage and its booster
  still ignoring each other.
- **Nothing reaches an island except as a tick-stamped, journaled input**: control inputs and commands;
  admissions, reservation grants, denials and releases; adds and removes; range-safety destructs and
  safing removals; helm grants; clock rate changes; and everything derived from a wall clock or up-time
  (declared socket loss, the 10 s latch end, the dead-man steps, the helm timeout, the end of the grace).
  The shard host turns timers into "at tick k" inputs; the island never reads a clock.
- **Limits.** 32 craft and 600 parts per assembly are hard: a capture that would exceed them is refused
  with a message. **64 vessels per island is a performance budget, not a correctness limit**: merges and
  admissions are never refused, because two solid vessels within reach must always be in one island. An
  island above the budget dilates (U18), and the directory closes its neighbourhood to new spawns, attaches
  and jump arrivals (a keep-out notice in the approach HUD and on the map). Fragments that a collision
  would create beyond the budget are merged into the nearest surviving fragment or become effects, chosen
  deterministically by id order.

### 7.3 Islands: formation, frame, hand-overs

- Two vessels on one clock join one island when their separation is below `1 km + 2 s x closing speed`
  and part at twice that. Formation is driven by predicted approach, not only by current distance: a coarse
  spatial hash of attended vessels per clock (1 Hz, in the directory), a neighbour list of passive vessels
  per attended vessel at 1-4x (refreshed every 10 s of clock time), and the encounters of U10 at higher
  warp.
- Every island on one clock steps at that clock's grid ticks. A vessel leaves rails at a grid tick by an
  exact Kepler evaluation, so two islands that merge already share step times. Members are ordered by
  vessel id. From `tau <= 60 s` a neighbour island is streamed warm (10 Hz with its inputs), so a merge
  changes no pose on screen.
- Inside a planet's or moon's SOI an island integrates in BCI. In the Sun's SOI it integrates in ISL
  (section 4). The reference orbit is replaced (new frame epoch) when an offset passes 30 km, when the
  anchor (5.1) finishes a burn, when the anchor changes, or at an SOI change; each is a `rebase` operation
  in the journal, so a merge is independent of arrival order and a replay rebases at the same ticks.
- A single-owner island's lag is drained before a merge, and neither island steps past the merge tick
  (6.1). Islands migrate between workers and shards **of one build** by value at a tick boundary (island
  codec bytes over the private network); the gateway holds the socket, so the client does not reconnect
  for a migration. An island is not migrated while any pair is in contact or soft capture.
- A piece of debris that leaves its island (at twice the join distance) is still simulated and still
  visible: in atmosphere it is in the Reduced tier on its pacing clock and is streamed in the near tier
  (section 14); in vacuum it is passive, in the census, and solid until its horizon (U13). It can hit a
  neighbour's craft either way.

### 7.4 Contact, collisions and damage

- **Colliders** are convex pieces built from part data: by default what `clearance.ts` builds from
  `PartDef.bounds` (cylinder; deployment-dependent leg cylinder; wedge set for fairing panels); authored
  `PartDef.collision` shapes (cylinder, frustum, capsule, box, hull, shell) only where the bounds cylinder
  is badly wrong. Each vessel keeps a bounding-volume tree of its part colliders in VES. Canopies and lines
  do not collide; parts of one vessel never collide with each other.
- **Nothing tunnels.** Pairs are covered by exactly one mechanism: encounters from screening (rails
  against solid passive, U10); the neighbour list and admission (integrated against passive); islands
  (integrated against integrated, and against objects of the Reduced tier and unattended runs on the same
  pacing clock). No merge or admission is ever refused (7.2). Inside an island, per pair per step: a sphere
  sweep; speculative contacts for slow pairs (relative travel per step below a quarter of the thinnest
  collider); conservative advancement to the time of impact for fast pairs. At 15.6 km/s a craft moves
  130 m per step; nothing is skipped by step size.
- **Which integrator.** A pair enters the sub-stepped path when the sweep puts it inside the
  speculative-contact margin and leaves it when it is outside again; both vessels switch at the same tick,
  so their relative state sees one integrator. The switch itself must not disturb a docking: two craft
  20 m apart, in low Earth orbit and at 30 AU, crossing the boundary in both directions gain less than
  0.1 mm/s of relative velocity (tested), against the 3 mm/s hard-dock threshold.
- **Born overlapping.** Vessels created by one split, and a pair that has just undocked, ignore each other
  until their colliders have first been 5 cm apart (the separated envelopes of the existing stack overlap
  for 0.01-0.39 s, measured).
- **Response** runs per island after the per-vessel force evaluation in the 480 Hz sub-steps: sequential
  impulses, 8 iterations, fixed order, restitution 0.2 above 0.3 m/s, friction 0.5. Ground contact stays
  the v1 penalty model.
- **Three regimes** by normal closing speed at first contact: *contact* (impulses only); *crash* (the energy
  lost is shared by the two touching parts; a part is destroyed when its share exceeds
  `1/2 m crashTolerance^2`; joints over their g limit break; pieces separate through `separateVessel`);
  *hypervelocity* above about 250 m/s (no rigid solve; the energy rule of the NASA standard breakup model
  removes mass around the impact point; 40 kJ/kg destroys both).
- **Explosions** reach other vessels in the island (150 N s per kg of propellant, area-weighted, capped).
- **Agreement.** Every outcome is an operation and an event from the one island both players are in, with
  the same numbers for both (`collision { otherVesselId, relSpeed, partsDestroyed }`). Neither client shows
  it earlier. Destructive outcomes between two owners are released at once and flushed at once (15.1); until
  the `Durable` tick passes them the ops log marks them provisional.
- **Growth is bounded.** Destroyed parts vanish into effects; survivors are connected components; at most
  twelve new vessels per collision; fragments under 50 kg live 60 s; the debris budgets of 15.5 apply.
- Crashing into a parked ship is a real collision with real damage, written to its record; its owner sees
  it in the feed and in My Ships.

### 7.5 Docking, assemblies and undocking

- **Ports** are parts with a `dockingPort` module on an attach node of kind `dock`. Two types, androgynous:
  C "crew" (ring 1.55 m, joint 300 kN / 150 kN m, undock impulse 600 N s) and H "heavy" (2.9 m, 2 MN /
  1.5 MN m, 2,000 N s); `dock-adapter-h-c` joins them. A capture needs both ports armed, compatible, not
  shielded, not occupied and not in cooldown. Arming is the owner's command and persists offline.
- **Capture envelope** (type C / H), measured between the two port frames when the faces come within
  0.10 m: lateral 0.20 / 0.30 m; misalignment 6 / 5 deg; roll to the nearest step 6 / 5 deg; closing
  0.03-0.30 / 0.01-0.15 m/s; lateral speed 0.08 / 0.05 m/s; relative rate 0.6 / 0.3 deg/s. Inside it: soft
  capture. Outside it but below crash tolerance: the ports are colliders, the craft bounce, and the event
  names the limit that was missed. Above crash tolerance: 7.4.
- **Soft capture** is a compliant six-axis constraint between the two port frames, solved in the contact
  pass (`k = mu wn^2`, `c = 2 zeta mu wn`, 0.2 Hz, critically damped, force and torque clamped). The vessels
  stay separate bodies. It lets go when clamped for 0.5 s or after 60 s.
- **Hard dock** at a tick boundary once offset, angle and relative speed have stayed under 3 mm, 0.1 deg and
  3 mm/s for 0.5 s. The merge re-expresses the arriving vessel's parts in the base's VES with their own
  tree, adds the link, recomputes mass properties, and conserves linear and angular momentum by
  construction. The heavier vessel is the base (equal mass: the lower id). The merged vessel's id follows
  section 3 (an assembly id issued at the first dock; the absorbed rows become tombstones that keep their
  worldlines). The directory makes that change, with the island checkpoint and the journal up to the dock
  tick, in one transaction before the `docked` event is released.
- **One helm or none.** The helm's inputs steer the vessel through its own craft and through actuators
  other craft have lent. An arriving craft goes to docked free drift: engines, thrusters and wheels
  inhibited until its owner's policy admits them (`lendAttitude` on by default, `lendEngines` and
  `lendPropellant` off). At dock the base vessel's helm stays. The **assembly anchor** is the craft longest
  in the assembly **among craft with an unexpired owner** (never the heaviest); when its owner lapses or it
  leaves, the role and the helm policy pass to the next most senior such craft. The anchor's owner may take
  the helm at any time. A **vacant** helm (nobody seated, as on a parked station) is granted at once to any
  pilot aboard whom the helm policy admits (`crew` by default), so a ferry that docks to an empty station
  can fly it without waiting. An **occupied** helm is requested and granted on acceptance or after 30 s of
  up-time without helm input. A helm whose socket is lost follows the one table of U16: the seat stays
  reserved for the reconnect grace unless the anchor's owner takes it. Inputs from a pilot who is not helm
  are dropped by the island; their HUD says who is flying. The cockpit eye of every pilot is their own
  seated command part (section 20).
- **Unowned craft in an assembly** revert to the default lend policy, and their ports can be released by
  any owner in the assembly (15.5).
- **Craft sovereignty.** Each owner's commands for their own craft are always accepted: fire their own
  stage stack, abort, arm and release their own ports, pump out of their own tanks, change their lend
  policy. Staging while docked separates the pieces physically.
- **Joint strength.** A link breaks when the force or torque needed to accelerate the lighter side exceeds
  the port's `hard` limits for 0.2 s. The rule players learn: do not burn hard through a docking port.
- **Undock.** The owner of either port commands it (or a stage action does). At a tick the island removes
  the link, splits the forest, applies the spring impulse equal and opposite at the port point, puts both
  ports in cooldown and marks the pair nascent. The piece with the helm's craft keeps the helm; every other
  piece gets its own connected owner at zero throttle, or none. Ids, worldlines, plans and other players'
  targets follow section 3 (a craft that leaves alone reopens its own row). The directory makes the change
  in one transaction before the `undocked` event is released.
- **One vessel, one clock.** Every pilot aboard is a bound member of the assembly's clock; warp is the
  helm's proposal (U6) and never passes the carry limit of the craft aboard whose owners have not accepted
  it (5.2). A passenger who does not want to come along undocks, which is always possible.
- Two craft that reach one port in one step are ordered by 6.1; the second receives the event
  `captureLost { reason: 'occupied' }` (a capture is not a command and has no `CommandResult`).
- An assembly with nobody aboard and quiescent is passive, costs nothing, and is solid for every later
  visitor inside its window.

### 7.6 Terrain and the simulation

- The island requests terrain only at tick boundaries from physical triggers (the predicted impact point;
  a disc under a vessel below 2 km radar altitude or slower than 200 m/s below 50 km) and spreads collision
  warming over control ticks. Pads are analytic flattened discs: launches and pad accidents need no tiles.
- **On a shard**, a contact step never runs on non-final data: the island's authoritative simulation waits
  for the tiles (lag grows in the trailing lane; the island dilates under U18 in the real-time lane) while
  the pilot keeps flying on prediction. The journal records which data level was resident, so a replay is
  reproducible.
- **In `LocalSession`**, the v1 await protocol stands (`ready`, `terrainPending()`): the headless mission
  reproduces its golden hash while tiles stream from disk, and `SimSnapshot.terrain.incompleteQueries` must
  be 0 in a mission proof.
- **On a network client**, prediction uses the client's own streamed tiles; a touchdown is confirmed by the
  server's event (6.4), and the island is under a threshold watch for the whole final descent.

### 7.7 Objectives

Milestones are data and optional. `ScenarioDef` is a **spawn recipe** (vehicle, site and pad, start kind,
stages already fired) plus an optional objective list of generic triggers, attached to one craft and
evaluated by the universe's milestone observer. A local scenario also fixes the local universe's epoch. No
vehicle is tied to a mission; the `lunar-direct` scenario remains the Earth-Moon-return proof. Only a `pad`
start with no stage fired and `cheatCounter = 0`, in a `LocalSession` or on a deployed lobby, counts as a
mission proof; debug mutators exist only in `LocalSession`. The same holds for multiplayer proofs: a test
harness that loads vessels into the database marks the run `seeded`, and a seeded run is never counted as
a completion proof of rendezvous or docking (28.4, 28.5).

---

## 8. Bodies: the solar system

Design and source data: `docs/research/v2/solar-system.md`.

### 8.1 The set

Sun (root attractor and star); Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune; Moon; Phobos,
Deimos; Io, Europa, Ganymede, Callisto; Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus; Miranda,
Ariel, Umbriel, Titania, Oberon; Triton; Ceres; Pluto and Charon. **Thirty-two bodies** (the Sun, 8 planets,
20 moons, 3 dwarf-system bodies), three levels, no moon of a moon. Acceptance criteria name this list, never
a count. Every one is an attractor, and that a player can reach and orbit each is **proven, not asserted**:
`tools/sim/reachability` generates from `analyzeVehicle` and the body library a table with, for every body,
the cheapest fleet profile (vehicle, refuels, aerobraking), the delta-v required and available and the
margin, and fails when any body has no profile with a positive margin (9.1).

### 8.2 Ephemerides

- Planets: JPL mean elements ("approximate positions", Table 1) with their six secular rates, mean motion
  taken from the table's mean-longitude rate. Beyond 2050 the universe is an internally exact clock, not a
  copy of reality; the rules screen says so.
- Earth: the existing Almanac low-precision Sun formula, inverted (`orbit: { kind: 'sunLowPrecision',
  inverted: true }`), so the Sun's direction at Earth, the launch windows and `tools/sim/start-time.json`
  reproduce to rounding. The Moon keeps its frozen ellipse (its acceptance tests pin it).
- Moons: JPL satellite mean elements in three plane frames: `ecliptic`, `parentEquator` (with the positive
  pole for Uranus), and an explicit Laplace-plane pole. Precession rates are carried. Ceres and Pluto use
  osculating elements with their own epochs; Charon orbits Pluto.
- **Definitions are generated, never transcribed**: `tools/bodies` writes every `data/defs/bodies/*.json`
  from the source tables and fails when any body deviates from JPL Horizons by more than its tolerance
  (planets: the table's stated accuracy; moons: 1 degree of phase) at ten epochs over 2030-2060. Saturn's
  moons, whose table convention did not reproduce, are fitted from Horizons state vectors.
- Bodies stay perturbation-free, so every rails state is analytic and every body is a pure function of
  `ut`.

### 8.3 Body-model fields (all additive; Earth and Moon files keep their meaning)

| Field | Meaning |
|---|---|
| `KeplerOrbitDef.rates`, `.meanMotionDegPerDay`, `.frame: 'ecliptic' \| 'parentEquator' \| { pole: { raDeg, decDeg } }` | Secular rates, fitted mean motion, Laplace planes |
| `soiRadius: 'auto'` | `min(Hill, max(a (m/M)^0.4, 2.5 R))`: Phobos 16.6 km, Deimos 15.5 km, Mimas 495 km. "Orbiting" the smallest moons is a hover-class orbit at a few m/s; the UI says so |
| `shape: { equatorialRadius, polarRadius }` | Oblate spheroid; one `surfaceRadius(body, dirFixed)` used by altitude, atmosphere sampling, warp limits and the bake. Mandatory for Jupiter and Saturn; Earth stays a sphere |
| `surface: 'solid' \| 'none'`, `atmosphere.floorAltitude` | Giants have no surface: a vessel below the floor (about 10 bar) is destroyed |
| `rings: [{ innerRadius, outerRadius, texture, opticalDepthScale }]` | Render-only; Saturn only |
| `warpAltitudeLimits` (optional) | Nine rails levels; defaults from radius and atmosphere top when absent |
| `atmosphere` (`exponential` or `table`, heating sets per gas) | Venus, Mars, Titan with scattering and physics; giants with a scale height; data only |
| Rotation | `fixedRate` from `pck00011` for every new body, so the prime meridian matches the baked maps |

A vessel on an escape trajectory beyond 100 AU is removed with reason `lost`; the Sun's photosphere is a
kill radius.

### 8.4 Prediction and warp at solar-system scale

- The prediction horizon is per patch and scaled to the patch (three periods at the periapsis of a closed
  orbit, the SOI crossing time of an open one, capped at 40 years); `maxPatches` is 16.
- The SOI entry search steps by `min(30 s, SOI / (4 V))` so encounters with the smallest moons are found.
- Closest approach to a body or a vessel scans adaptively over the horizon with golden-section refinement.
- A heliocentric prediction costs an estimated 5-20 ms; on the client it runs in a worker and only on
  change.
- At rates above 10,000x presentation and proximity logic are event-driven only; rails states are exact at
  any step.

### 8.5 Data pipeline for simple bodies

- One driver, `tools/bake/planet`, reads `tools/bake/planet/bodies/<id>.json` (sources with checksums,
  projection and longitude conventions, levels) and writes an ordinary tile set (`height` + `albedo`,
  `TileManifest`). A triaxial moon is baked as `ellipsoid radius - mean radius (+ DEM)` into the height
  layer, so physics and rendering see a normal heightfield. Each config carries landmark tests (Olympus
  Mons, Caloris, Hellas...) that catch a flipped or shifted map.
- Levels per body are at most 6 (albedo) and 5 (height): about 148,000 tiles and 2.8 GB for 25 bodies
  (estimated). Bodies with no usable global map (Deimos, Mimas, the Uranian moons) are procedural: mean
  albedo plus a crater population from the generic amplification models `rocky-generic` and `icy-generic`.
- Giants: an equirectangular cloud-top map tied to System III, zonal drift by latitude, a Rayleigh shell
  with methane absorption for Uranus and Neptune, limb darkening from the scattering. Venus and Titan are
  drawn as their cloud and haze shells with the surface underneath. Saturn's rings are a flat annulus with
  analytic ring and planet shadows.
- Sources are USGS Astrogeology mosaics (public domain) and Solar System Scope textures (CC BY 4.0). Maps
  that forbid redistribution are not used. Every source and licence line is in `visuals/credits.json`
  (staged by the bake, moved into `data/defs/visuals` at activation) and shown on the **Credits** screen
  (section 23), together with the Sentinel-2 cloudless imagery (CC BY-NC-SA), the audio and the font.
- Landing later is the same tool with deeper levels and regional rectangles.

---

## 9. Vehicles, fleet and launch complex

Design and vehicle sheets: `docs/research/v2/fleet-docking.md` sections 2 and 5.

### 9.1 The fleet

Three launchers (Azimuth light, Solstice medium, Meridian heavy) and six spacecraft from one part library
of about 55 parts (25 exist). Players choose any vehicle and launch from any free pad of its class; no
vehicle is tied to a mission.

| Vehicle id | Stack | For | Cockpit |
|---|---|---|---|
| `azimuth-pathfinder` | Azimuth 1 + Pathfinder probe | Smallest launch; a probe that can orbit the Moon, Venus or Mars | sensor camera |
| `solstice-kestrel` | Solstice + Kestrel LF crew ferry | Low-orbit rendezvous and docking; capsule returns under parachutes | `kestrel` |
| `solstice-atoll` | Solstice + Atoll station core | First module of a station: six ports | sensor camera |
| `solstice-pelican` | Solstice + Pelican tug/tanker | Pushes modules, refuels craft | sensor camera |
| `meridian-lunar` | Meridian + Heron lander + Kestrel (exists, unchanged) | Direct-ascent lunar landing and return | `kestrel` |
| `meridian-egret` | Meridian + Egret lunar ferry | Reusable lander between lunar orbit and surface | `kestrel` (shared cabin mould line) |
| `meridian-albatross` | Meridian M-1 + M-2 + Albatross cruiser | Nuclear-thermal cruiser, 10.9 km/s from low Earth orbit: capture ellipses at every outer planet | sensor camera; crew arrive by ferry |
| `meridian-pelican-heavy` | Meridian + depot | Propellant depot in lunar or high Earth orbit, carrying the cruiser's propellant | sensor camera |

"Orbit" at a giant means a bound capture ellipse (7.0-9.4 km/s from low Earth orbit); low circular orbits
there cost 15-24 km/s and are not on offer. Uncrewed craft have a `command` module flagged `remote`.

**Reach.** 10.9 km/s from low Earth orbit is not enough for every body: the research puts Mercury at
12.1-13.4 km/s, Io 12.8, Europa 11.7, the inner Saturnian moons 11.6-13.8, the Uranian moons 11.1-12.1 and
Triton 11.2; Ceres, Pluto and Charon were not computed. Those are reached by the **refuelled profile**: the
cruiser raises itself to a high elliptical Earth orbit or to lunar orbit, docks with a depot, takes
propellant through the port and departs with full tanks. `fleet-data` sizes the depot (or adds a kick
stage) until the reachability table of 8.1 shows a positive margin for all 32 bodies; a body that still has
none is put to the user in OPEN_QUESTIONS Q17 instead of being claimed. The profile is flown, not only
computed (31.4).

**First-person view without a cabin.** Three vehicles have the Kestrel interior. On every other command
part the first-person view is a **sensor camera**: the eye at the part's camera mount, the instrument pages
(navball, target, docking) composed around the frame by the same painters as the cockpit displays, labelled
as a remote view. It is one of the three views, is built to the standard of the rest (owner of the surface:
`fleet-models-pads`; of the rig: `flight-hud-multiplayer`) and is tested; the hangar card says which kind a
vehicle has. Whether the two crewed modules without an interior (the Albatross habitat, the Atoll core)
get real cabins is the user's decision (OPEN_QUESTIONS Q15).

### 9.2 Vehicle and part data

- `VehicleDef` stays the flat part graph the simulation reads. Additions are optional: sub-assembly
  includes (`uses`, flattened by the loader from `data/defs/assemblies/<id>.json`), attach-node kinds
  (`stack`, `mount`, `dock`), `surfaceAttach`, `symmetry` tags, `padInterface` (class, umbilicals, crew
  arm), pre-mated ports recorded as dock links. `meridian-lunar.json` stays flat and untouched.
- `PartDef` gains `collision`, `crossfeed`, `crashTolerance`, `resources[].transferable`, the `dockingPort`
  module, `command.remote`, `command.cockpit`, and the categories `dock` and `habitat`.
- The loader (`src/core/defs`) keeps the **structural** checks only (references, one root, node kinds,
  stage actions naming existing parts). `validateVehicle(defs, vehicle): Issue[]` lives beside
  `analyzeVehicle` in `src/sim/vessel`, because it needs part poses from the assembler and distances from
  the collider library, and the overlap it reports must be the overlap the simulation would see. It is
  pure, and is called by the definition tests, by the server and `LocalSession` on every spawn, and later
  by a builder. `analyzeVehicle(defs, vehicle): VehicleCapabilities` computes every read-out the menu shows
  (delta-v per stage, TWR, crew, ports, RCS, entry limit, first-person view kind, the "can reach" ladder
  from the bodies' data); capabilities are never authored. `VehicleCapabilities` and `Issue` are contract
  types in `src/core/contracts`, so the shell's stores and the generic pilots receive them as data.
- Menu text and thumbnails live in `visuals/vehicles/<id>.json`, not in `VehicleDef`.

### 9.3 Sites and pads

- `LaunchSiteDef.pads: PadDef[]` replaces the single pad: id, name, east/north offset, azimuth, class
  (`light`, `medium`, `heavy`; a pad hosts its class and anything smaller), mass and diameter limits, flat
  and blend radii, mount height, keep-out radius, structures. Flatten-disc terrain modifiers are derived
  from the pads at load.
- **Ka Lae** (site id `ka-lae`, the v1 site renamed in one sweep): sixteen pads inside the existing 100 km
  region (4 heavy, 6 medium, 6 light), heavy pads at least 2.5 km apart, medium 1.5 km, light 1 km. LC-1
  stays where it is.
- **Madrakah Coast** (site id `madrakah`, a fictional facility on the Arabian Sea coast of Oman near
  19.0 N 57.8 E): sixteen pads. Same latitude as Ka Lae, 14.2 hours of solar time away, so one of the two
  sites is in daylight at almost any hour. One regional Earth bake (about 30 m elevation data; if the
  ground there cannot meet the v1 standard at pad level, the bake's hand-off says so and the pads go to
  the Ka Lae coast instead, OPEN_QUESTIONS Q8).
- **Pads are data plus a resolve run, and the pad count is the capacity dial of the launch complex**
  (decision 54). With a mean cycle of 150 s (dwell, lift-off, clearance, 20 s of safing; 90-240 s
  observed range) one pad gives 24 launches per universe hour; 32 pads give 768. What a player count
  needs is in 16.3.

### 9.4 Pad rules (each timer names its base, section 3; all `UniverseRules` fields)

| Rule | Default | Base |
|---|---|---|
| Reservation hold (briefing and transit) | 90 s | up-time |
| Longest stay on a pad | 300 s of the pad's clock, one 120 s extension while engines run; an up-time cap of 600 s that can only trigger a roll-back, never a launch | ticks, capped in up-time |
| Grace after a disconnect on the pad | 60 s, then roll-back to the hangar (no debris) | up-time |
| Pad cleared when the vehicle is | above 1,500 m and more than 1,000 m away, or destroyed | state |
| Safing after clearance | 20 s; wreckage inside the keep-out radius is removed | ticks |
| Keep-out radius | 600 m heavy, 450 m medium, 300 m light | - |
| At rest inside a keep-out radius | recovered (removed) after 60 s | ticks |
| Range safety | A vehicle below 5 km whose instantaneous impact point enters another pad's keep-out radius is destroyed by the range; a journaled input to its island and a server event shown as such | state |

None of these runs while the universe is down, so a rocket on a pad is not rolled back by a deploy.
A dilated or held island on a pad (U18) keeps its tick interval; the timetable is in ticks, so the next
slot simply starts later in up-time.

A spawn is refused while anything unheld is inside the pad's keep-out radius at that tick. Pad structures
are not damageable. Two vehicles lifting off from neighbouring pads are separate islands until they come
within the join distance.

---

## 10. Terrain and tile data

### 10.1 Tile sets

A tile set lives under `data/tiles/{tileset}/` and is served at `/tiles/{tileset}/`:

```
manifest.json                                   TileManifest (src/core/contracts/terrain.ts)
{layer}/{face}/{level}/{x}/{y}.{ext}            tiles; face 0..5 = +X,-X,+Y,-Y,+Z,-Z; x,y in [0, 2^level)
globals/...                                     whole-body equirect maps listed in manifest.globals
```

The server also answers `/tiles/index.json` with `{ "tilesets": string[] }`, the tile sets that are baked
(directories with a manifest), so a page can skip a missing one without a failed request. In production the same promise is the pack index (10.4).

Mapping: `dir = normalize(N + s U + t V)`; tile-local `(u, v)` to `(s, t)` as in `cubeSphere.ts`. For every
raster layer the column index increases with `u` and the **row index increases with `v`** (row 0 is the
low-`t` edge), so texture coordinates equal tile `(u, v)` for every layer. Equatorial-face tiles therefore
look south-up in an image viewer; that is intended.

| Layer | Encoding | Registration | Content |
|---|---|---|---|
| `height` | `frt1-height` (`.hgt`) | 259 x 259: 257 vertex samples + 1 border sample each side; sample (i, j) at u = (i-1)/256, v = (j-1)/256 | metres above the reference radius; bathymetry is the solid surface |
| `albedo` | `webp` (opaque) | 256 x 256 texel centres | sRGB base colour without baked shading |
| `watermask` | `frt1-u8` (`.u8`) | 256 x 256, same coverage as `albedo` | 0 = land .. 255 = open water (anti-aliased shoreline); render-only |
| `night` | `webp` (opaque) | 256 x 256 | emitted night-light colour (sRGB) |
| `landcover` | `frt1-u8` (`.u8`) | 256 x 256 | `LANDCOVER_CLASS` ids |

Coverage: levels `0..globalMaxLevel` exist everywhere; deeper tiles exist where `coverage[level]` rectangles
say so, and the pyramid is complete (every tile's parent exists). `layerHasTile()` is the single test; the
client never requests a tile the manifest does not promise, and a 404 for a promised tile is a bake bug.

Edges of sparse coverage must be invisible (section 1, row 17):

- **Height**: handled at run time by the height authority (10.2); bakes additionally feather a regional
  SOURCE into the upsampled coarser source where the sources differ (Terrarium into the global grid over
  5 km, NAC into SLDEM over 300 m, SLDEM into LOLA over 2 km), so the run-time blend never has to bridge a
  large disagreement over a short ring. Regions of interest lie at least a quarter tile inside the
  coverage rectangles of every level.
- **Imagery** (`albedo`, `night`): the bake feathers the outer 64 texels of the coverage of each regional
  level to the bilinear upsample of the parent level as stored (decoded from the parent tiles), so the
  renderer can switch levels at a coverage edge without a seam. `watermask` follows the same rule;
  `landcover` classes cannot be blended and simply end (the detail materials they drive fade with the
  effective level).

Planned content (final numbers are recorded in each manifest):

| Tile set | Layer | Global levels | Regional levels | Sources |
|---|---|---|---|---|
| earth | height | 0-7 (305 m/sample), scale 0.5 m | 8-12 within 100 km of the launch site (9.5 m/sample), scale 1/8 to 1/16 m | GEBCO 2025 or ETOPO 2022; Terrarium/3DEP |
| earth | albedo | 0-7 (305 m/px) | 8-12 near the site (9.5 m/px) | Blue Marble NG 500 m; Sentinel-2 cloudless (CC BY-NC-SA, swappable) |
| earth | watermask | 0-7 | 8-12 near the site | elevation sign corrected by an independent land/water source; best coastline regionally |
| earth | night | 0-7 (305 m/px; mostly black tiles of a few hundred bytes) | - | Black Marble 500 m |
| earth | landcover | 0-7 (heuristic classes from colour, height, latitude) | 8-12 near the site | ESA WorldCover |
| earth | globals | `cloudCoverage` 8192 x 4096 (coverage, cloud-top/type), `albedoLowRes` 1024 x 512 | | geostationary/cloud composites |
| moon | height | 0-6 (166 m/sample), scale 0.5 m | 7-9 (SLDEM2015) and 10-12 (NAC DTM, 2.6 m/sample) around the landing region | LOLA 118 m; SLDEM2015; LROC NAC DTM |
| moon | albedo | 0-7 (83 m/px; SVS colour x de-shaded WAC detail) | - | SVS CGI Moon Kit; LROC WAC |
| moon | globals | `albedoLowRes` 1024 x 512 | | |

The simple bodies of section 8.5 and the second site's region (section 9.3) add about 4 GB to the 17 GB on
disk today. Total baked data stays under 22 GB including caches; raw downloads are deleted after a bake;
packs (10.4) are built into a separate directory of at most 20 GB; and the disk keeps at least 25 GB free
at all times, packs included (the lead updates rule 13d of `PACKAGE_RULES.md` to these numbers).

Between about 20 km and 300 km altitude a pixel is smaller than a global imagery texel (LEO nadir: 80-160 m
per pixel against 305 m imagery). The terrain renderer fills that gap with an orbital-scale detail layer:
band-limited albedo and normal modulation at 30-300 m wavelengths driven by land cover and slope,
anchored to the imagery colour, fading in as the pixel footprint drops below the imagery texel. Night
lights are baked to level 7 for the same reason.

### 10.2 The height authority

One implementation in `src/terrain` (`TerrainProvider`) answers every height question:

```
heightAt(body, dir, lambdaMin?) = D(dir)        data height: Catmull-Rom bicubic of the data tiles, blended
                                                across the edges of sparse coverage (below)
                                + terrain modifiers (site pad flattening, BodyDef.terrain.modifiers)
                                + band-limited procedural amplification with wavelengths >= lambdaMin
                                  (BodyDef.terrain.amplification: model + seed + params)
```

- Terrain workers call it per tile with the tile's band limit (2 quads) to bake geometry heights and normal
  maps. Rock and crater placement use the same hash. The renderer has no private copy of any of it.
- **Continuous everywhere.** Across tiles and cube faces (1-sample borders), in `lambdaMin` (octaves fade,
  never switch), and across the edges of sparse coverage. For the latter, each level `L` above the global
  levels has a coverage weight `w_L` that is 0 on the coverage boundary and 1 a quarter tile inside
  (`COVERAGE_BLEND_TILES`, exact definition in `src/core/contracts/terrain.ts`), and
  `D_L = D_(L-1) + w_L (bicubic_L - D_(L-1))`. On a coverage boundary the surface IS the parent-level
  surface, whatever the two data sources disagree by. The same recursion on the level number gives the
  fractional **effective level** `E`; amplification octaves and crater size classes are weighted by a
  smooth function of `E`, so procedural detail also fades across the ring instead of ending at a wall.
  `w_L` and `E` are pure functions of the manifest, never of what happens to be resident.
  Where the height layer lists `sourceCoverage` (the tiles of each sparse level whose data is genuinely
  finer than the parent level; bakes extend `coverage` a tile beyond that and fill the margin with
  parent-identical data), `E` rises on those rectangles instead, over one tile (`SOURCE_BLEND_TILES`),
  while `D` keeps blending on `coverage`: in a margin, and at a level whose source is no finer than its
  parent, the parent's procedural detail simply continues until real detail replaces it. Regions of
  interest lie at least one tile inside the source rectangles of the levels they rely on.
- **Collision surface = rendered surface.** `heightAt` without a band limit returns the bilinear
  interpolation of the height function on the vertex grid of the body's max-render-level tiles - exactly
  the mesh drawn at full detail (difference < 3 cm). Collision vertices are evaluated lazily, one by one,
  and memoised: a query costs at most four analytic evaluations the first time and a table lookup after.
  No query ever builds a whole grid, so the first contact at touchdown cannot hitch;
  `prewarmCollision(body, dir, radius, maxVertices)` lets the sim warm an area ahead with a deterministic
  count budget. Altimetry and prediction far from the ground pass a band limit and get the analytic
  function without fine detail.
- Queries are synchronous and never wait for I/O; `ensureLoaded(body, dir, radius, slot)` preloads (and
  pins, per named slot) and `residency()` reports whether final data is in. The sim clamps warp to 1x if a
  vessel is below 300 m radar altitude without final data (asserted never to happen in scripted missions),
  and follows the deterministic request policy of section 7.6.
- A coarse level (`manifest.residentHeightLevel`) is always resident for impact prediction.
- Tile bytes come from a `TileSource` made by `createTileSource(spec)` (`src/terrain`), where
  `TileSourceSpec = { kind: 'fs' | 'fetch' | 'pack', ... }` is plain data: fs in vitest and tools, fetch
  against the dev server, packs in production. Tile workers receive the spec in their init message, so the
  same worker code streams from any source.
- The provider loads a body's manifest and pins its resident levels **lazily**, when the first query,
  observer or island needs that body, and releases them when nothing does. Creating a provider with 27
  terrain bodies in the library costs what one body costs.
- Launch-site pads become `flattenDisc` modifiers automatically (from `LaunchSiteDef.pad`), so the pad is
  flat for both physics and rendering.

### 10.3 Streaming

`src/render/terrain` owns the quadtree, LOD selection per observer, the worker pool, GPU tile pools,
priorities, prefetch and eviction (`rendering-design.md` section 4). New tiles enter fully morphed and
relax, parents are pinned, levels 0-3 are loaded at boot: there is always something correct to draw and
never a pop or a loading screen.

The LOD cap under time warp is continuous, not a switch at 1000x: the deepest level requested is
`floor(log2(faceSize / (groundSpeedPerWallSecond * 2 s)))`, applied through the morph factor, so at 10x-100x
in low orbit (80-800 km of ground per wall second) the queue stays bounded and the view never degrades
into a stream of fallbacks. Image tiles are decoded with
`createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })` and uploaded with
`premultipliedAlpha: false`.

### 10.4 Delivery: packs

- The bake output and the dev server stay plain files. Production adds the `pack` kind of `TileSource`.
- `tools/pack` writes content-addressed packs of 64-256 MB (hash in the name, never rewritten): all layers
  of one tile coordinate adjacent, groups in Morton order per level, height layers in their own packs, small
  bodies one pack per body and layer. The index (`[pack, offset, length]` per tile group) lives beside the
  manifest, which stays the single promise of what exists.
- **Boot pack.** Everything of baked data that the title needs is one small content-addressed pack:
  levels 0-3 of Earth and the Moon, the low mips of the sky and cloud maps, the menu's assets. With the
  bundle and the definition library, which are built from the repository and are in the image, the
  first paint is **25 MB or less before the title** (section 29.2). Everything else (129 MB of sky data,
  37 MB of assets, regional tiles, the calibration's pad region) streams behind the title screen.
- **How the boot pack reaches `shell`.** Baked data is not in the repository (`data/tiles` is ignored)
  and neither CI nor Railway's build has it, so the boot pack cannot be built into the image.
  `tools/pack` uploads it to the `packs` bucket under its content hash and writes a small tracked
  manifest, `deploy/boot-manifest.json` (hash, bytes, what is deferred). `shell` fetches the pack once
  at start with the bucket credential it already holds for the mirror role (ingress is free), verifies
  the hash, keeps the 25 MB in memory inside its 0.25 GB limit and serves it at an immutable hashed URL
  (`/boot/<hash>.pack`). Its health check passes only once the pack is loaded and verified, so a
  deployment with a missing or wrong pack never takes traffic. The rollout checks the boot manifest
  hash that the running `shell` reports against the release commit, beside the `buildId` (16.2). On the
  local stack the same code reads the same object from the local stand-in for the bucket (16.4). Git LFS
  and an un-ignored upload are not used.
- Clients read packs by HTTP range from an ordered mirror list. A request moves to the next mirror on
  429, 5xx, a timeout, **404 for an object the index promises** (a storage fault has returned
  `NoSuchKey` for existing objects before) and, after one refresh of the pack list, **403** (an expired
  signature). The client checks the status and the length of the body against the offset and length it
  already knows from the index; it never depends on reading `Content-Range`, which is not a
  CORS-safelisted response header.
  1. **The bucket**: presigned URLs on the Railway bucket `packs` (free egress and free operations on
     every plan). A URL is signed with the date quantised to the UTC day and a lifetime of 7 days, the
     longest the presigner allows: every client gets the same URL for a day, and a URL handed out at
     any moment is good for at least six more days, longer than any session. The client refreshes the
     pack list once a day and on a 403.
  2. **The `packs` mirror role**: a streaming proxy of the bucket that serves immutable cache headers
     behind Railway's CDN. How it addresses bytes is decided by a wave-3 measurement, not fixed here.
     Railway announced in July 2026 that its CDN supports `Range` and `Content-Range`. If the
     measurement shows that a ranged response is cached and that a ranged miss pulls only that range
     from the origin, the mirror proxies ranges of `/p/<hash>` and the client sends it the ranges it
     would send the bucket. If not, the mirror exposes each pack as fixed, aligned **slice objects**
     (`/p/<hash>/<n>`) of 2 MB (1 MB if the measurement asks for it) and the client maps a range to
     slices. The pack list states the mode and the slice size, so neither is compiled into the client,
     and the pack format does not change. A slice costs the bytes of the whole slice even when one
     100-300 kB tile group was wanted, so the mirror is judged on **bytes sent per byte needed** over
     a recorded first session: at most 1.5, or the slice size goes down. (At 16 MB slices a scattered
     regional read would have cost many times its bytes, and 2.6 s at 50 Mbit/s before the first tile
     decoded.) **Up to stage 2 the role is carried by the `shell` service**, which already has the CDN
     and holds no socket: a hit costs nothing, a miss is billed egress ($0.014 for a whole new
     visitor's 275 MB, times the bytes-sent factor), and tile traffic never touches the process that
     runs the universe. It streams without a disk cache there, inside the shell's small replica limit.
     Three rules keep it from being an open tap (16.2): a request with a query string on `/p/` or
     `/boot/` is answered 404 with no body (Railway's CDN keys on the full query string, so `?x=1`,
     `?x=2` and so on would make every request a billed miss); origin bytes are limited per client
     address; and mirror misses have a daily byte budget, after which the mirror answers 429 and
     clients stay on the bucket. At stage 3 it becomes its own service on its own domain, with
     replicas and a local disk cache (no volume, so it can have replicas and redeploys without
     downtime), so that tiles and the shell share neither a connection limit nor a purge.
- **Two buckets, split by who may hold the credential.** A Railway bucket credential is all or nothing:
  it cannot be made read-only or scoped to a prefix, and bucket access is not logged. `packs` holds the
  packs and the boot pack (14-20 GB: $0.21-0.30 a month; immutable, content-addressed, verified by hash
  where it matters); its credential is held by `game` (it signs the pack list), by `shell` (the mirror
  and the boot pack) and by the upload tool on the development machine. `dumps` holds the database
  dumps and the journals sampled for the replay audit; its credential is held only by the `dump` job
  and by the Modal jobs that copy and audit them (15.3, 16.2). So no process that faces the public can
  read or delete a dump (accounts and recovery-code hashes are in them), and the dump job's pruning
  cannot touch a pack. Storage is billed on the workspace total, so two buckets cost what one would,
  and the Hobby plan's 1 TB is far away. A bucket belongs to one environment, which is why a rehearsal
  environment is handed the production `packs` credential and nothing else (16.2). No role has a code
  path that deletes or overwrites a pack. `data/packs` on the development machine is kept until a
  copy outside the production bucket exists (a Modal volume filled through the presigned pack list,
  16.2); the packer is deterministic, so the same tiles give the same hashes again.
- Tile bytes are cached by content hash in OPFS, so a changed URL never causes a re-download. Sky data and
  `public/assets` take the same path.
- The page is cross-origin isolated; every pack response carries CORS headers for ranged GET. Whether
  the bucket honours `ExposeHeaders` is recorded in wave 3, and nothing depends on it.
- **What a new visitor costs at stage 0** (derived): at most 25 MB of first paint from the shell (free on
  a CDN hit, $0.00125 on a miss) and about 275 MB from the bucket ($0). At 5 concurrent players with
  30-minute sessions and 15 % new visitors that is about 1,080 new visitors a month (36 a day, about
  10 GB a day), all of whose tile bytes are free on the bucket path. **If the bucket path is unusable
  from a browser** (its CORS setting breaks, or an incident like the day in July 2026 when presigned
  GETs returned `NoSuchKey`), those bytes come through the mirror: $15 a month times the bytes-sent
  factor if every request missed the CDN, and never more than the mirror's daily budget (8 GB a day,
  $12 a month; 16.2). Past the budget a new visitor keeps the boot set and what the cache holds, and
  tiles stop streaming until the bucket path is back or the lead raises the budget: the game degrades
  before the bill does. The case is written down because it is realistic, not because it is expected.
- **Pass or fail, measured in wave 3** (`platform-delivery` scope D). Correctness first, from Chrome
  against the deployed stage 0: ranged GET of a presigned URL with CORS under cross-origin isolation;
  **what the CDN does with `Range`** (is a ranged response cached, what does a ranged miss pull from
  the origin), which chooses the mirror's mode; the mirror path through the shell's CDN in that mode,
  with its bytes sent per byte needed (at most 1.5) and the time to the first decoded tile beside the
  bucket's; failover between the two, including an expired URL and a 404. Then throughput of the **bucket** from a
  Modal fleet at 20, 500 and 2,000 concurrent fetchers replaying real tile requests for 15 minutes (bucket
  egress is free, so the test costs nothing on Railway): it passes with p95 first byte of a cold range at
  or under 400 ms, errors at or under 0.5 %, and 1.5 Gbit/s sustained in aggregate at 2,000 (15 TB in a
  day is 1.4 Gbit/s on average). The **mirror at launch size** is judged in the launch rehearsal (28.7),
  because it needs the stage-3 `packs` service and bills egress: it passes with p95 first byte at or
  under 600 ms, a CDN hit rate of 90 % or more from the origin's logs after warm-up, and billed egress at
  or under 0.15 GB per GB delivered. If the bucket fails at launch size, stage 0 is unaffected (20
  fetchers is its scale) and the escalation to a store outside the three providers is already written
  with these thresholds (OPEN_QUESTIONS, "Outside the three providers") and is put to the user the same
  day, before any launch is announced.

### 10.5 Terrain on the servers

Shards need the height layers only (9.65 GB for Earth and Moon today). A `TerrainProvider` is JavaScript
heap and every worker is its own isolate, so server memory is designed, not left to the client defaults
(which pin the resident pyramid of every body and allow a 384 MiB tile cache per provider: with 27 terrain
bodies and 22 workers that would be 10-40 GB per shard).

- **Lazy per-body residency** (10.2): a body's pyramid is loaded when the first island enters its sphere of
  influence on that shard and released when the last one leaves. With no island at all, what stays
  resident is the idle level's choice (6.2): the pyramids of the bodies with launch sites at the warm
  level, nothing at the light level. Measured on the development machine: Earth's resident pyramid is
  102 MB decoded, the Moon's 68 MB.
- **Worker isolates exist on demand**: one is kept while idle at the warm level (at the light level the
  first island starts it), more are started as the step-time budget requires up to the stage's setting
  (2 at stage 0), and the extra ones are terminated when the last island is gone. An isolate holding the
  simulation code and the definitions is 15-50 MB (measured; about 34 MB was not returned after isolates
  were terminated, which is one more reason not to cycle them every evening).
- **One decoded-tile store per shard**, in SharedArrayBuffers, read by every worker isolate; the data is
  read-only, and the journal already records the resident level. Its cap is a setting: 256 MB at stage 0
  (a cache that is held for a month fills, so the cap is what gets billed), 512 MB at stage 1 once the
  limits are raised, 1 GB on the stage-2 shard, 2.5 GB on a launch shard. Entries outside the resident
  pyramids that no island has touched for ten minutes are released. Each worker keeps only its lazily
  memoised collision vertices (32 MB).
- Height packs are read by range from the bucket (ingress and bucket egress are free) straight into the
  decoded store. **There is no on-disk cache of packs by default**: Railway bills a container's page
  cache as memory until the kernel evicts it, so a disk LRU would be paid for as RAM; the replica memory
  limit makes the kernel reclaim what the reads leave behind. The disk LRU is a setting for a launch
  shard, switched on only if the measured bucket latency asks for it. First touch in a new region stalls
  only the island that needs it (7.6). From stage 3 the directory places landings on shards that already
  hold the region where it can.
- **Budget**: at stage 0 the whole `game` process is 0.3-0.7 GB idle at the warm level (0.15-0.45 GB at
  the light level), 0.4-0.75 GB at 5 players and 0.8-1.6 GB at 50 with the limits raised (derived from
  the measurements of `hosting-small.md` section 4), inside a 2 GB replica limit. The 0.75 GB at 5
  players is the sum of the configured caps, not a hope: about 0.1 GB of runtime and definitions, the
  256 MB store full, two isolates at about 0.1 GB each with their collision vertices, and 0.2 GB of
  heap for sessions, the directory's index and buffers. From stage 2: 200 MB per worker isolate, 0.5 GB
  for the shard's main thread, the store cap; 7.4 GB for a 22-worker shard (derived from the per-isolate
  figure measured on a small shard; measured as a whole only in the launch rehearsal), about 2 GB for
  the stage-2 shard (29.2). Resident memory is a line of every load-test report **as Railway bills it:
  the container's cgroup `memory.current`, page cache included, nothing subtracted**, and the memory
  lines of section 30 are computed from it.

---

## 11. Sky data

`data/sky/manifest.json` (`SkyManifest`): a Milky Way cube map (raw `rgb9e5ufloat` faces with mips, WebGPU
cube order, ROOT = J2000 equatorial axes) and a binary star catalogue (`STAR_RECORD_FLOATS` float32 per
star: direction, illuminance in lux, colour, magnitude). Stars brighter than the catalogue cutoff are
removed from the cube map. The Sun is defined by `BodyDef.emission`; no texture.

---

## 12. Data-driven definitions

Everything about the world is data under `data/defs/` (types in `src/core/contracts/defs.ts`, loader and
validators in `src/core/defs`):

```
bodies/{id}.json        BodyDef (generated by tools/bodies; Earth and Moon keep hand-tuned sections)
sites/{id}.json         LaunchSiteDef: body, location, pads, recovery zones
parts/{id}.json         PartDef
assemblies/{id}.json    AssemblyDef: a launcher or spacecraft sub-assembly (same fields as a vehicle)
vehicles/{id}.json      VehicleDef: flat part graph, or `uses` of assemblies; stages, abort, cameras
scenarios/{id}.json     ScenarioDef: a spawn recipe plus optional objectives (local sessions, labs, tests)
rules/{id}.json         UniverseRules documents: `default` (production), `staging` (lifetimes of minutes),
                        `local` (offline play and tests)
resources.json          ResourceDef[]
render/, terrain/       section files pulled in by "$ref"
visuals/, audio/        section directories, also exposed as DefLibrary.sections
visuals/vehicles/       menu text, tags and thumbnail ids per vehicle
visuals/shared/         geometry shared by several packages (e.g. kestrel-mouldline.json)
regions/{id}.json       bake region manifests; Python only
```

- File name = id; files with an extra dot segment are sections. `{ "$ref": ... }` assembles a definition
  from sections. The dev server lists the directory at `/defs/index.json`; the production build ships one
  bundled, hashed library (built by the lead-owned build configuration). `validateLibrary()` checks cross
  references and structure; `validateVehicle()` (`src/sim/vessel`) checks every vehicle in the definition
  tests and on every spawn; each subsystem validates the sections it consumes. A loader `DefSource` may
  overlay a second root (bodies staged outside `data/defs` are loaded this way before activation).
- `defsHash` (a hash of the bundled library) and the sim build id are part of the session handshake: a
  client whose library or sim differs from the server's is refused before anything else.
- **Definitions change under stored ships.** Part, module and resource ids are never removed or
  renumbered, only deprecated; a changed part gets a migration (7.2). The post-deploy sweep refuses to
  open the lobby while a stored vessel cannot be decoded.
- One file per shared shape (the capsule mould line) as in v1.
- The library stays loadable at every commit: resources before parts, parts before assemblies and
  vehicles, vehicles before scenarios.

Adding content later:

- **A body**: a config in `tools/bodies` and `tools/bake/planet`, a generated `bodies/x.json`, a baked tile
  set. Nothing else.
- **A vehicle**: part files, assemblies, a vehicle file, visuals. New part behaviour is a new `ModuleDef`
  member with its implementation in `src/sim/vessel/modules`.
- **A site or a pad**: data, a region bake where the site is new, structures from the generator library.
- **A rule change**: a new `UniverseRules` version; clients show when it changed.

---

## 13. Protocol

Types: `src/core/contracts/net.ts`. Implementation of the wire layer: `src/net`.

### 13.1 Transport and framing

- One binary WebSocket per playing client to a gateway (`wss`, HTTP/1.1). No `permessage-deflate`; large
  blobs are deflated by the application. One WebSocket message per send tick per client, holding a batch:
  `varint count`, then `{ u8 type, varint length, payload }` each. Little-endian. Ticks are float64
  integers. Ids on the wire are session-local `u32` handles; the mapping to string ids is sent once.
- Every high-rate message is idempotent and latest-wins (it carries a tick). A gateway may drop a queued
  delta when a newer one is ready (it watches the socket's buffered amount). The same messages would
  survive an unreliable transport.
- The menu holds **no socket**. It polls `GET /live.json` (presence, feed, pads summary with the wait per
  class, up to 200 markers of the menu region) every 3 to 5 s with jitter, and stops while the tab is
  hidden. The document is built by the directory at most once a second, and only while somebody asks for
  it, and is served by the **publisher role** (`pub`) with `Cache-Control: public, max-age=1,
  s-maxage=1`, as are `status.json`, the rules document and the public census (13.3). The API routes
  (accounts, pack signing) have their own limits, so menu traffic cannot starve account creation.
- **The publisher is bounded where it has no CDN.** Up to stage 2 it is a role of the process that holds
  the directory, with no CDN in front (Railway's CDN is not put in front of a service that carries sockets
  until that has been tested). Every public document therefore carries `pollAfterS` (4 s by default),
  which the publisher raises up to 30 s when its request rate passes its budget (50 requests a second at
  stage 0, assumed), and beyond four times the budget it answers 429 with `Retry-After`; the menu keeps
  its last picture and says the lobby is busy. The request budget protects the thread. The bill is
  protected by a second one, in bytes: **anonymous requests for public documents have a daily egress
  budget** (2 GB a day at stage 0, about ten times what 5 players and their menus use; a setting). At
  half of it `pollAfterS` goes to its maximum, and when it is spent the publisher answers 429 until the
  next UTC day. Requests are also limited per client address. A request that carries a live session
  token is not anonymous: a player in flight keeps the census for the map, and those requests are
  bounded by the admission cap. Without the byte budget a crawler or a looping client inside the
  request budget could draw 100 GB and more a day from a process that has no CDN in front of it. When
  polling outgrows the budgets, `pub` becomes its own stateless service with the CDN on (a step of 16.2
  that needs no freeze). That 50,000 visitors then cost one computation a second and CDN hits is a claim
  about a beta CDN: its behaviour at a one-second lifetime is verified before the step is relied on, and
  the lifetime is raised to 5 s if it is not honoured. A spectating or queued player draws craft from
  these documents and holds no socket either.
- **The publisher is one module with one owner.** It is a role of `server/` (`server-persistence`),
  whether it runs inside `game`, inside `dir` or as `ROLES=pub` in a service of its own: the code that
  the "`pub` behind the CDN" step deploys is the code production has been running all along.
- **The endpoint document.** A client never has a server address compiled in. `shell` serves
  `GET /endpoints.json`, sent `no-cache` (a few hundred bytes, never held by the CDN):
  `{ v, build, gate: string[], api: string[], pub: string[], bootPack: { url, hash, bytes } }`, each
  list an **ordered list of candidates**. The values are the `shell` service's configuration; changing
  them is a redeploy of `shell`, which never touches the universe. The client reads the document at
  boot and **reads it again before every reconnect attempt, and on 429, 5xx or a network failure from
  the publisher or the API**; it tries the candidates of a list in order, and a role in standby refuses
  at once with `standby`, so the next candidate is tried without waiting. A stage move therefore lists
  the new service first and the old one second **before** its freeze begins and removes the old one
  afterwards: a pilot in flight during the move loses the socket at the freeze, re-reads the document,
  is refused by the new gateway while it is in standby, and resumes on it inside the resume window as
  soon as it accepts. No page reload is needed and nobody is left holding a dead address. Owners: the
  shell side and the local stack's document, `platform-delivery`; the reader and the candidate logic
  (`src/client/endpoints`), `netcode-client`; its use at boot and by the menu's poller,
  `app-integration-2`. Bots and the test harness find the gateway the same way, never by configuration.

### 13.2 Session

```
Hello { protocol, build, defsHash, cpuScore, resume? }      ->
                                         <- Challenge { nonce, serverId }
Auth { accountId, signature }            ->                     device key, section 25
                                         <- Welcome { session, rulesVersion, liveClock, timeSync }
Spawn { vehicleId, site, pad, slot, name }  or  Attach { vesselId, clock? }   ->
                                         <- Spawned / Attached { vesselId, clock }  or  Refused { reason, alternative }
```

A mismatched build or `defsHash` is refused with "a new version is ready"; a session that is already
flying is kept on its build until it leaves or the server drains, and after a deploy that changes the build
its island is held until the pilot has reloaded and resumed or the build-change grace has ended (15.4).
`Attach { vesselId, clock? }` is validated by U8b: the optional clock is honoured only when its tick is at
or after the vessel's head and the vessel is already solid to it. `TimeSync` round trips with a
minimum-round-trip filter give the client the server's wall clock to a few milliseconds. One session per
account flies at a time; attaching elsewhere takes the flight over (`takenOver`).

### 13.3 Messages

Client to server:

| Message | Content | Rate |
|---|---|---|
| `Input` | `seq, applyTick`, pitch/yaw/roll/translate as `i8`, throttle `u8`, and the SAS hold direction (3 x `f32`) when a maneuver or target mode needs it; each message repeats the changes of the last 250 ms | 30 Hz while flying |
| `Command` | `cmdId, tick, kind, args`: stage, abort, SAS, RCS, legs, lights, fine control, arm or disarm a port, undock, control-from-here, helm request/grant/release, lend policy, transfer, cross-feed, rename, abandon | on press; acknowledged |
| `Time` | set rate (with the stamped tick, U7), warp to tick, jump (tick or clock), hold, link, unlink, follow, meet, reply to a proposal, ask to advance | on press; acknowledged, with the reason and an alternative when refused; rate-limited per account (section 26) |
| `Target` | `TargetRef` (body, vessel, port) | on change |
| `Subscribe` | the relevant-set parameters (target, distance tier), pads, roster page, the worldline of one vessel | on change |
| `Plan` | the pilot's maneuver nodes and target for this ship, opaque to the simulation | on edit, at most 1 Hz |
| `Quick`, `Ping`, `TimeSync` | | |

Server to client:

| Message | Content | Rate |
|---|---|---|
| `ClockState` | the clock of 5.2 with members, proposals, relation and offers | on change |
| `IslandEnter` | island id, epoch, and the complete island state in the island codec (7.2): reference orbit and anchor, every vessel, tiers, nascent and U5 pairs, capture constraints and timers, deflated | on entering or re-forming |
| `IslandOp` | a structural change at a tick as an operation both sides execute: `split`, `merge`, `destroy`, `capture`, `release`, `add`, `remove`, `rebase`, `replace`; with a checksum of the result (part count, craft list, mass to 1e-9) | on event; reliable |
| `IslandKey` | tick, input margin, and per stepped vessel the **exact** pose: position and velocity as float64 offsets from the reference orbit, attitude and rate as float32, applied controls | 1 Hz |
| `InputAck` | for the pilot's own inputs and commands: `seq` and the tick each was applied at (a range when applied as stamped, one entry per late input) | with every delta |
| `IslandDelta` | tick, key tick, and per vessel the groups that changed against the last key: POSE (quantised, 16-22 B), CONTROL, PART-FAST (ignition, gimbal, legs, chutes); a pair in contact is sent exact with its friction anchors and port state | 10 Hz single-owner, 30 Hz shared, 60 Hz for a contact pair |
| `IslandSlow` | resource levels and part temperatures that changed | 2 Hz |
| `Event` | a `SimEvent` with its tick, vessel and epoch | reliable |
| `CommandResult` | `cmdId, ok, appliedTick, reason` | per command |
| `Near` | vessels of the near tier, including debris in the Reduced tier and unattended runs: quantised pose relative to their own island reference, throttle, thrust direction, staging and ignition state; inputs when warm | 10 Hz within 20 km, 2 Hz beyond |
| `RelevantFull` / `RelevantDelta` | the pilot's **relevant set** only (own ships, target, party, stations, craft solid to the pilot within the distance tier): handle, kind, owner, the forecast chain patches with their validity ticks, head, horizon, clock id, reservation flag, radius, expiry time, flags (about 84 B per patch) | on subscribe / on change; 1 Hz osculating elements for thrusting craft **of that set** |
| (HTTP, not the socket) `census/<soi>` | the complete census of one sphere of influence: a snapshot and sequence-numbered deltas, identical for every viewer, built at most once a second per sphere of influence while somebody asks for it, and served by the publisher (13.1; through the CDN once `pub` is its own service). A craft under thrust is flagged and gets one update at burn end | fetched by the map; polled at 1 Hz while the map is open |
| `Worldline` | committed segments and arc samples of one vessel between two ticks | on request |
| `Conjunctions` | the pilot's screened encounters and proximity warnings | on change |
| `Durable` | the tick up to which this pilot's island is durable | 1 Hz |
| `Pads`, `Ships`, `Assembly`, `Roster`, `Prompt`, `Feed`, `Rules`, `Notice` | the view models of section 23 | on change or 1 Hz |

### 13.4 State encoding

- All island state on the wire is relative to the island's reference orbit (ISL). The receiver evaluates
  the conic in float64 at the tick and adds the offset, so 100 ms of delay is not 780 m of error.
- Keys are exact; the client resets its prediction only to exact state or to a delta whose quantisation
  (16 um, 1 um/s, 5e-10 rad) is far below the comparison tolerance (0.2 mm, 0.2 mm/s, 2e-5 rad). Vessels in
  contact are always sent exact.
- A delta is always against the last key, never against the previous delta.
- Structure never rides in a key or a delta. A staging event is tens of bytes (`IslandOp split` with the
  server's ids); the client rolls back to the operation's tick, applies it and replays, and asks for
  `replace` if the checksum differs.
- A shard encodes each island's key and delta once per send tick; gateways forward the same bytes to every
  subscriber and prepend the per-client header.

### 13.5 Prediction and reconciliation

- The client's replica is the island code itself in predict mode, fed by the network. It runs ahead of the
  server's clock by half the round trip plus the jitter buffer, adapted from the input margin the server
  reports and capped at 250 ms; it never predicts further than 500 ms ahead. Beyond that the player sees
  their own inputs lag, never a false world.
- It keeps a ring of its inputs and of the island's dynamic state per tick for the last second (codec
  copies; 8-9 us per 38-part vessel, measured). On each key or delta for tick `k` it compares the stored
  state at `k`. Within tolerance nothing happens. Otherwise it restores `k` with the server's state and
  replays to the present with its own inputs and the other pilots' last reported controls: at 150 ms round
  trip about 24 ticks, 0.4 ms for two vessels and 2 ms for ten (derived).
- After a replay each vessel's visual pose keeps an error offset in the island frame that decays over
  150 ms. Physics state is never smoothed. A correction larger than 5 m shows "RESYNCED".
- Other pilots' vessels in the island are predicted from the server's state with the controls the frames
  report, so everything the player can touch is drawn at one predicted tick. Near-tier vessels are drawn by
  blending between the osculating conics of consecutive samples with a 150 ms delay (exact for a coasting
  craft; about 1 m of error at 4 Hz under thrust).
- On rails, client and server evaluate the same conic at the same clock tick. `untilTick` is sent with the
  schedule and only ever shortens to a tick the client has not yet displayed (U10), so the closed form
  never runs backwards on screen.
- Observed flight has stated bounds (28.4): another pilot's craft in my island is drawn within 0.05 m of
  the server's state at the same tick while coasting and within 0.5 m under main-engine thrust; a
  near-tier craft within 1 m while coasting, 5 m under thrust within 20 km and 50 m beyond; throttle and
  ignition state within 150 ms plus the round trip; each staging event is shown once and never reversed.

### 13.6 Lag, reconnects and simultaneous actions

- Inputs take effect at the tick the pilot stamped (6.2). A pilot with a 250 ms round trip runs further
  ahead of the server than one with 40 ms; neither is disadvantaged at docking speeds. A misprediction of
  another pilot's RCS over 150 ms is 0.4 mm; docking happens with main engines off.
- Capture and hard dock are slow by design (0.5 s of residuals below threshold; an envelope two to three
  times wider than the real standard), so one round trip of event delay is hidden inside the latch
  sequence. Above a 250 ms round trip or 5 % stalled sends for 3 s the HUD shows "UNSTABLE LINK".
- Two pilots pressing undock in one tick are resolved by the canonical order of 6.1 and the second gets
  `CommandResult { ok: false, reason }`. Two craft reaching one port in one step are resolved by the same
  order and the second receives the event `captureLost { reason: 'occupied' }`.
- A stall shorter than the declared-loss time (3 s, U16) changes nothing: controls stay latched and no
  seat is given up.
- The gateway owns the socket. `Hello { resume }` to any gateway inside the grace period returns the pilot
  to the same vessel on the same clock: `ClockState`, `IslandEnter`, census deltas from the client's last
  sequence number. Backoff: 0.5, 1, 2, 4, 8 s, then every 15 s, with jitter; gateways admit resumes before
  new sessions. A returning hidden tab rebuilds its replica from a fresh `IslandEnter`, never by
  fast-forward.
- Every client has a hard downstream budget (6 kB/s by default) spent in priority order: own island, nearest
  near-tier vessels, the relevant set; superseded samples are dropped. The complete census never rides the
  socket. On a pad row the own island plus eight near islands reach the cap, so a launch day is costed at
  the cap, not at the 2.5 kB/s planning average (section 30).

---

## 14. Interest management

Relevance has two axes, space and clock relation. Nothing is broadcast per frame, and nothing that is the
same for every viewer is built per client.

| Tier | Who | What | Rate | Carried by |
|---|---|---|---|---|
| A | Vessels in my island | Exact keys, deltas, operations, others' inputs, events | 10 / 30 / 60 Hz (13.3) | socket |
| B (near) | The 8 nearest integrated islands, Reduced-tier objects and unattended runs on my clock within 300 km, or with a visible plume; warm from `tau <= 60 s` | `Near` states; warm: with inputs | 10 Hz within 20 km, 2 Hz beyond; warm 10 Hz | socket |
| C1 (relevant set) | My ships, my target, my party, stations, craft solid to me within the distance tier (2,000 km by default) | Forecast-chain entries; worldline segments for my target, my party and my own ships; 1 Hz elements while one of them thrusts | on change | socket |
| C2 (census) | Every object in a sphere of influence | The public census: snapshot plus sequence-numbered deltas, the same bytes for everyone | 1 Hz while the map is open | HTTP from the publisher (`pub`, 13.1) |
| D (directory) | Everything else | Paged lists: my ships, roster, stations; counts per body | on demand | socket / API |

- **Solid or echo** is decided on the client from the entry (head, horizon, chain, reservation, clock id)
  and its own clock (U2); that is why the census can be one document for all viewers. The client applies
  distance, line caps and the timeline filter.
- The census is O(N) to build per sphere of influence and costs the gateways nothing. With 1,000 craft
  thrusting in one sphere of influence a per-client feed would be 84 kB/s per subscriber and N x N drop
  decisions; the public census is one 84 kB delta a second in total, built once for everyone and free on
  CDN hits once `pub` is its own service.
- The first sync on a socket is the relevant set only; the full list of a sphere of influence (10,000
  objects is 840 kB) is fetched over HTTP when the map opens.
- The map draws icons for the census by propagation on the client (GPU compute above 500 objects) and
  float64 lines and markers only for a capped relevant set (own ships, target, docked partners, hovered,
  plus 32 others).
- Recorded echoes need history: conic segments are kept for the vessel's lifetime after the live clock,
  including the worldlines of tombstones (section 3); integrated arcs are stored as 1 Hz samples for 24
  wall hours and reduced to their end points afterwards.
- A spent stage stays visible and continuous after it leaves its island: near-tier samples while it is in
  the Reduced tier, the census while it is passive, its fate's sampled worldline to its owner and to
  nearby viewers.
- Near-tier selection and island formation between attended vessels use the directory's spatial hash; a
  gateway receives "islands visible to pilot P" and forwards their frames.
- Presentation applies its own relevance cut on top: full-detail remote vessels up to the "other craft
  detail" setting (2-10), audio and plume emitters for the nearest eight, nameplates for the nearest eight
  plus target, docked partners and own ships.

---

## 15. Persistence, recovery and expiry

### 15.1 What is durable

| Class | Content | Guarantee |
|---|---|---|
| Directory state | Accounts, craft, vessel records, worldlines, clocks, pad timetable, rules, the event log | Written by the directory in one transaction per 250 ms batch |
| Two-owner transitions | Claim commit, dock, undock between owners, ownership and helm-policy changes | The record change, the island checkpoint **and the journal chunk up to the transition tick** are committed in one transaction before the event is released to any client. The island does not wait (the outcome is already decided, U4); only the event does, inside the latch sequence |
| Destructive outcomes between two owners | Collision damage, part destruction, joint breaks, crew loss, an explosion reaching another owner's vessel | Released at once: the latch argument does not cover them, and holding a crash back would show it late. The island flushes a checkpoint and its journal immediately and the directory commits them in their own transaction (typically under 50 ms). Until the `Durable` tick passes the event, the client's ops log marks it provisional; a server crash inside that window may re-run the collision (decision 53 d, stated on the rules screen) |
| Hand-overs and reservations | The epoch flip of a hand-over; a reservation's grant and release | Decided in memory, fenced by epoch, written ahead in the next batch; never on the path of an input (6.1). After a directory restart the holders re-assert them (15.4) |
| Single-owner transitions | Staging splits, destruction, to-rails, own undock | Ride the 250 ms batch; a crash before the batch is repaired by journal replay, by the shard re-sending them, or shown to the one owner as a resync |
| Islands in flight | A checkpoint of the whole island state (island codec) every 60 s and at every structural operation; the input journal in between | At most 250 ms of flight lost in a crash, less when the gateway's input buffer covers it |
| Derivable | Patches, readouts, census, prediction. Forecast chains are derivable and are stored only as a cache | Never the source of truth |

### 15.2 Schema (Postgres on Railway, private network; one schema per lobby)

```
account     (id uuid pk, callsign citext unique, created_at, last_session_at, session_count int,
             settings jsonb, flags)
credential  (id, account_id fk, kind text, public_key bytea, label, added_at, revoked_at)   -- 'deviceKey' today
recovery    (account_id pk, code_hash, rotated_at)
craft       (id text pk, vessel_id fk, owner_account uuid null, slot_account uuid null,   -- whose slot it uses
             vehicle_id text, vehicle_hash text, design jsonb null,
             name, joined_tick float8, policy jsonb, advance_limit_ticks float8, station bool,
             abandoned_at timestamptz null)
vessel      (id text pk, state smallint,            -- passive | reserved | cruising | island | tombstone
             holder text, epoch bigint,             -- authority fence
             reserved_by text null, reserved_epoch bigint null, reserved_tick float8 null,
             merged_into text null, split_into text[] null, lineage_tick float8 null,   -- tombstones
             body_id text, head_tick float8, horizon_tick float8, chain_end_tick float8,
             seg_r0 float8[3], seg_v0 float8[3], seg_t0 float8,   -- head segment, or a body-fixed rest pose
             mass real, bounding_radius real, situation smallint, part_count int,
             anchor_craft text, helm_account uuid null, advance_limit_ticks float8, access smallint,
             clock_id text null, island_id text null, pacing_clock_id text null,
             codec_version int, defs_hash text,     -- what `dyn` was written under
             dyn bytea,                             -- complete dynamic state, vessel codec, deflated
             expires_at timestamptz null, row_version bigint)
worldline   (vessel_id, seq int, tick_start float8, tick_end float8, kind smallint,   -- conic | arc | rest | forecast
             body_id text, data bytea)
clock       (id text pk, kind smallint, tick0 float8, anchor_uptime_ms float8, rate float8, members jsonb)
pad_slot    (site_id, pad_id, tick_from float8, tick_to float8, vessel_id, account_id, state smallint)
island_ckpt (island_id, tick float8, clock_id text, codec_version int, defs_hash text, state bytea,
             terrain_levels jsonb)                  -- insert-only, partitioned by 5 minutes
island_jrnl (island_id, seq bigint, tick_from float8, tick_to float8, data bytea)   -- insert-only, partitioned by hour
plan        (craft_id, account_id, nodes jsonb, target jsonb)
event_log   (seq bigserial, at timestamptz, tick float8, kind text, data jsonb)     -- audit trail and feed source
rules       (version int pk, doc jsonb, activated_at)
report      (id, at, reporter, subject, kind, context jsonb)
lease       (name text pk, holder text, token bigint, renewed_at timestamptz)       -- the directory's writer lease
usage_hour  (hour timestamptz, service text, gb_seconds float8, vcpu_seconds float8,
             egress_bytes jsonb,                    -- per route; what /ops sums for the month to date
             primary key (hour, service))
meta        (key text pk, value bigint)             -- change_seq: see below
```

- **Encoding and locale are pinned, the same everywhere.** The cluster is created with
  `--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8`: on Railway through
  `POSTGRES_INITDB_ARGS`, set before the template's first boot (the locale provider is fixed at creation,
  like the major version); on the local stack through the `initdbFlags` of the embedded package; in the
  compose form through the same variable. Without it the embedded cluster on this Windows machine is
  created as WIN1252 with a Windows collation: a ship name outside that code page fails to insert,
  `citext` uniqueness and ordering follow another collation than production, and a production dump may
  not restore locally. The directory refuses to start on a database whose `server_encoding` is not UTF8
  or whose `datlocprovider` is not the built-in one, at every stage and on the local stack.
- `meta.change_seq` is incremented by every batch that writes anything other than the `lease` row and
  `usage_hour`. It is what "something changed" means for the dump job (15.3): the lease is renewed
  every 5 s, so a test on the WAL position or the transaction counter would never be false.
- `usage_hour` holds the cost accumulators of section 27 for the services that can report them (one
  small row per hour and service, written in the normal batch and read back at start), so the
  month-to-date figure on `/ops` survives a rollout or a crash of `game`.
- An assembly is one `vessel` row with several `craft` rows; links and per-craft stage stacks are inside
  `dyn`. Persisting a docked assembly needs nothing beyond persisting a vessel. Ids, tombstones and
  lineage follow section 3: a `vessel.id` is never held by two live rows, and a craft's own row is
  reopened when it undocks alone.
- A `reserved` row is a passive vessel that one island may touch (U4); the sweep, safing, fates and
  attach read `state` and `reserved_by` in the same transaction that would act.
- `craft.design` is empty today; it is where a builder's `VehicleDef` document will live, and the codec's
  vehicle reference already has that kind (7.2).
- A parked ship is never kept as a live `Vessel` (375 kB of heap each, measured): the directory holds about
  0.5 kB per vessel in memory and loads `dyn` on admission or attach. One hundred thousand parked ships are
  about 50 MB of memory and under 1 GB of table.

### 15.3 Write path

- **The directory is the single writer** of every table, and proves it: it holds a Postgres advisory lock
  and a row in `lease` whose `token` increases with every holder; every write transaction checks the
  token. A second directory process (Railway starts and health-checks a new deployment before it stops the
  old one) passes its health check in standby, loads nothing and writes nothing until it holds the lease;
  the old one's writes fail from the moment the token moves. This is what makes the deploy overlap of the
  combined `game` process safe at stages 0 and 1, exactly as it makes the `dir` service's overlap safe
  from stage 2. Shards send checkpoints, journal chunks and transition requests to the directory over the
  role transport (a `MessagePort` inside `game`, the private network from stage 2); a database worker
  thread writes the batches. **Connections are counted**: a directory process holds at most 4 (the
  lease session with its advisory lock, the batch writer, a reader, one spare) and the dump job 1;
  `max_connections` is 40, of which 3 are reserved. During a rollout two `game` processes, the dump and
  an operator session are connected at once, which is the one moment that must not meet a limit: the
  rollout test asserts a peak of at most 12 connections (28.6) and the capacity report states the peak.
- A journal chunk holds everything needed to replay: tick range, **every tick-stamped input of 7.2** (each
  pilot's input changes with their applied ticks, commands in applied order, admissions, reservation
  results, adds and removes, range-safety and safing actions, helm grants, the inputs derived from timers,
  clock rate changes) and the terrain data level that was resident. Replay on the same runtime image is
  bit-exact (measured). **A journal is valid only for the build that wrote it; checkpoints and `dyn` are
  not build-bound**: they carry their codec version and `defsHash` and are migrated on load (7.2), which
  is what lets a deploy change the build.
- Volumes (derived): about 70 kB/s at 500 players, about 1.3 MB/s on a 5,000-player launch day. Both tables
  that churn are **insert-only and partitioned; partitions are dropped, never vacuumed**: `island_jrnl` by
  the hour, kept for two hours (two checkpoints always exist inside that); `island_ckpt` by five minutes,
  dropping every partition older than the one that holds each live island's second-newest checkpoint (15
  minutes in practice). Nothing is rewritten in place, so there is no dead-tuple growth and daily volume
  backups do not pin churned blocks. `event_log` is partitioned by day and kept 30 days (a deployment
  setting), for the same reason. Volume: 5 GB at stage 0 (the Hobby plan's largest; 0.3-3 GB expected at
  5-50 players with the WAL capped at 256 MB, derived). From stage 1 it is grown only when used space
  passes 4 GB (to 20 GB, and to 100 GB for a launch): a volume grows live but never shrinks, it is
  billed on used space, and a volume above 5 GB cannot go back to the Hobby plan (16.2). Table and WAL
  size are lines of the load-test report. A rules switch turns the journal off (checkpoints every
  10 s, at most 10 s lost).
- **Copies, by stage.** The Hobby plan has no volume backups and no point-in-time recovery, so at stage 0
  the copies are ours: (1) the volume; (2) a compressed logical dump of everything **except**
  `island_jrnl`, `island_ckpt` and `usage_hour` to the Railway bucket `dumps` (a different storage
  system, and a credential no public-facing process holds: 10.4), written by the `dump` job every hour,
  **skipped when `meta.change_seq` has not moved since the last dump** (15.2: an empty universe uploads
  nothing, although its lease row is rewritten every 5 s), and taken once more at the end of every
  rollout's flush; the job keeps 24 hourly, 14 daily and 8 weekly dumps and deletes the rest itself,
  since buckets have no lifecycle rules; (3) a nightly copy of the newest dump to a Modal volume, off
  Railway. **The recovery point at stage 0 is therefore up to about one hour of directory state if the
  volume is lost** (a crash or a deploy loses nothing: the volume survives both). From stage 1 Railway's
  daily, weekly and monthly volume backups and point-in-time recovery (minute-level, WAL archived to a
  bucket) are switched on and the dump moves to every 6 hours. One sampled journal in a hundred is
  archived to the `dumps` bucket for the replay audit. A restore from the dump returns every passive
  ship and assembly; flights that were in progress restart from their last passive record.
- **The dump job is a role of the one image**, not a second Dockerfile: the image installs the PGDG
  `postgresql-client-18` beside Node (about 15 MB), so `ROLES=dump` has a `pg_dump` of the server's
  major and the S3 client it needs to list, prune and decide whether to skip; it refuses to run when
  `pg_dump`'s major differs from the server's. On Railway it is a cron service started from the same
  build as `game`; it exists for seconds and holds one connection.
- **Dump uploads are billed egress and grow with what is stored**, so they have a budget like every
  other byte source (16.2): about 15-30 MB a dump at 5 players (hourly: $0.6-1.1 a month), 60-120 MB
  at 20, 150-300 MB at 50 (about 5,000 accounts inside the retention window, 10-20 thousand vessels of
  5-25 kB each). The job uploads at most 1.5 GB a day at stage 0: it stays hourly while a day's dumps
  fit and lengthens its interval when they do not (2 hours from about 60 MB a dump, 6 hours from about
  180 MB). The interval in force, and the recovery point that follows from it, are shown on `/ops`. A
  lobby that has grown that far is past the point where the Pro plan costs the same (16.2), and
  point-in-time recovery then closes the gap.

### 15.4 Restart and recovery

Every deploy of a simulation role is a restart, so this is a normal path, and it is honest about its cost:
**a deploy that affects the simulation freezes the whole universe for a measured number of seconds**
(target: under 40 s plus the resume window; reported at 20 bots on the deployed stage 0, and at 200 and
2,000 bots in the rehearsals of 28.7). Rolling restarts shard by shard exist only from stage 2 and only
for restarts on the same build, because an island cannot migrate between builds.

The table and the rules below hold at every stage; "shard", "directory" and "gateway" are roles, whether
they are threads of one `game` process or separate services. What the stage decides is which of them can
fail separately, and that is stated after the table.

| Phase | Graceful (the rollout sequence of 16.2) | Crash of everything |
|---|---|---|
| Stop | `Notice restart`; every clock freezes at a tick boundary; shards write final checkpoints through the old directory; it flushes and releases the lease | Nothing |
| Load | The new directory takes the lease, reads rules, clocks, pads and the index columns of every vessel, rebuilds the per-body passive index, runs the decode sweep (7.2) | Same |
| Islands | Restored from the final checkpoints (migrated if the codec or definitions changed) | **Each island is restored at its own durable tick** (latest checkpoint plus journal, replayed un-paced; 60 s of flight is about 0.2 CPU-seconds per vessel, derived), **never earlier** |
| Clocks | Resume at the stored tick; the live clock did not advance | A clock resumes at the minimum durable tick over its islands. An island whose durable tick is ahead of its clock is **held** until the clock reaches it (inputs stamped earlier are discarded). An island more than 1 s behind the rest of its clock does not drag the clock back: it continues `behind` (U18) |
| Pilots | The live and cohort clocks are held for the **resume window** (30 s; 90 s when the build changed and clients must reload). Gateways admit resumes first, with jittered backoff | Same |
| Flights in progress | A non-quiescent island starts **held on its own clock** until every pilot attached before the outage has resumed or the reconnect grace has ended, then steps at 1x from the recovered tick. If that is after the resume window it is `behind` and rejoins by the one-key jump when quiescent. U16's timers start at the pilot's resume or at the end of the grace. Quiescent islands are simply fast-forwarded | Same |
| Result | No committed state lost; no burn flown without its pilot; the pad crowd is one group again after the window, except pilots who came back late | At most 250 ms rolled back per island; a two-owner transition is fully applied or absent, and a committed one is never rolled back because its island is restored at or after it |

- **A single shard dying**: the directory notices the missing heartbeat (2 s) and fences the shard's epoch.
  Another shard restores its islands from checkpoint and journal, then replays the inputs the gateways
  buffered **with their acknowledged ticks, only up to the last tick whose frame a client was sent**: that
  reproduces what the dead shard did and the pilots saw. Past that point the pilots were looking at a
  frozen screen (prediction stops 500 ms after the last server state), so nothing is replayed blind: a
  non-quiescent island is held until its pilots have resumed (as above) and is then `behind` by the length
  of the outage; quiescent islands catch up at once. The live crowd is split for those pilots only, and the
  rejoin is one key.
- **The directory dying while shards live**: shards and gateways notice the missing heartbeat (2 s). Shards
  **freeze** at the next tick boundary and keep their unacknowledged journal chunks, checkpoints,
  single-owner transitions and reservation table; gateways tell clients `Notice recovering`. The restarted
  directory takes the lease, loads Postgres and asks every shard to **re-register** its islands by
  `(island id, epoch, durable tick)`. A shard re-sends everything after that tick; facts are idempotent
  (6.1), so a staging split whose record was in the lost batch is simply written now, with the same ids.
  Reservations are re-asserted by their holders. Only an island whose epoch the directory does not
  recognise is discarded and restored from its checkpoint. Clocks resume at the tick the shards froze at
  (never before the stored value). The universe is frozen for the directory's restart time; nothing is
  rolled back.
- **Postgres restarting under a live directory** (a template update, switching on point-in-time recovery
  at stage 1, a platform move of the volume): the lease session is gone, so the directory freezes every
  clock at the next tick boundary, tells clients `Notice recovering`, keeps the unwritten batch,
  reconnects with backoff, takes the lease again (the token increments; it first checks that no other
  holder wrote in between), writes the kept batch (facts are idempotent) and resumes the clocks at the
  tick they froze at. Nothing is rolled back; the universe is frozen for the database's restart time.
- **At stages 0 and 1 the roles share the `game` process, and this is what that changes.**
  - A **worker isolate** dying is the single-shard case above, unchanged: the directory and the gateway's
    input buffer live in the main thread and survive, another worker isolate restores the islands and
    replays to the last frame tick that was sent.
  - The **`game` process** dying (a crash of the main thread, the replica's memory limit, a platform
    move) takes the "crash of everything" column: Railway restarts it (restart policy Always), it takes
    the lease, and each island is restored at its own durable tick. The input buffer died with the
    process, so the re-run is up to the full 250 ms; two-owner transitions are all or nothing; flights
    are held for their pilots. This meets the crash budget of 29.2. **What the combined process gives up
    is the path "the directory restarts while shards live, nothing rolled back"**: it does not exist
    until stage 2, and it is still built and tested on the split shape of the local stack (28.6) so that
    stage 2 never runs code that production met first.
  - A **graceful deploy** of `game` is the graceful column: the new process passes its health check in
    standby, the old one drains inside its 45 s drain window (freeze, final checkpoints, flush, lease
    release), the new one takes the lease and restores, and the rollout script triggers the `dump` job
    once. Nothing is lost.
- Gateways, the API, `pub`, `shell` and `packs` are stateless. From stage 2 gateways are replaced
  **last** in a rollout, one replica at a time, after the shards are back, so input buffers are not lost
  while they matter; clients of a replaced gateway resume on another.

### 15.5 Expiry and cleanup (wall clock; every number a `UniverseRules` field)

| Object | Kept for | Reset or protected by | Then |
|---|---|---|---|
| A craft with a command part and an owner | 14 days after the owner's last session (shortened under pressure, below) | Any session of the owner renews all of the owner's craft | Becomes unowned |
| Ship slots | 10 craft per account, counting craft the account abandoned while docked for as long as they are still part of an assembly | Abandon one that is not docked, or wait for its assembly to go | An eleventh launch asks which to abandon |
| A craft docked in an assembly | Kept while any craft in the assembly has an unexpired owner | The assembly lives as long as its most recently active owner | A lapsed or abandoned craft becomes **unowned-attached**: it stays physically part of the assembly, reverts to the default lend policy, and its ports can be released by any owner in the assembly. **A docked craft is never removed alone** |
| The anchor of an assembly lapses | - | - | The anchor role and the helm policy pass to the most senior craft with an unexpired owner (7.5) |
| An assembly with no unexpired owner | 48 h after its last owner lapsed | Nobody can re-own it | The whole assembly becomes unowned and is **removed whole** |
| An unowned single craft (abandoned or lapsed, not docked) | 48 h | Nobody can re-own it | Removed |
| Debris (no command part) | 2 h after it leaves every island | Budget of 24 pieces per account and 5,000 unowned objects per sphere of influence; oldest first | Removed |
| Fragments under 50 kg | 60 s of simulation | - | Removed |
| A landed wreck | 2 h | - | Removed |
| A vehicle on a pad | Section 9.4 | - | Rolled back, not expired |
| A vessel escaping beyond 100 AU | - | - | Removed, reason `lost` |
| Sampled arcs in worldlines | 24 h | - | Reduced to end points |
| An account with no ships | 90 days without a session | Any session | Deleted |
| All passive objects | 50,000 per lobby | The pressure rule, then admission back-pressure | See below |

- **Pressure rule: abandoned ships go before any launch is refused.** Above 70 % of the per-lobby cap
  (`pressureStart`) the retention of owned craft shortens for the owners least likely to return: accounts
  with a single session first, then by oldest last session, down to a floor of 24 h for single-session
  accounts and 72 h for others, until the count is back under the threshold. The shortened date is what My
  Ships and the census show, and the rules screen states the rule. A launch is refused for the cap only
  when every remaining object belongs to an account seen inside the floor.
- Only passive, unreserved vessels expire; the sweep (every 60 s) never removes a vessel that is attended,
  in an island or reserved (U4), and never changes the structure of an assembly. Removal deletes the vessel
  at every universe time at once and its whole worldline; it is an out-of-fiction act ("recovered by the
  range") and is shown as such, with its reason (`expired`, `limit`, `pressure`, `rolledBack`, `recovered`,
  `lost`).
- The advance limit of an assembly with owned and unowned craft is the minimum over its owned craft (U2).
- Visible everywhere: every census entry carries its removal time; My Ships shows a countdown and the
  reason a ship is kept; the rules screen lists this table from the live `UniverseRules`.
- **Growth bound**: accounts seen inside the retention time, times 10 slots (docked-abandoned craft
  included, so slots cannot be recycled into unowned hardware), plus the debris budgets, and never above
  the per-lobby cap because of the pressure rule. A front-page week of one-visit accounts therefore
  plateaus under the cap instead of blocking launches for 14 days; the churn test of 28.2 and the soak of
  28.7 assert the plateau.

---

## 16. Server topology and hosting

Platform facts and prices: `docs/research/v2/hosting.md` (the Pro plan and the launch sizes) and
`docs/research/v2/hosting-small.md` (the Hobby plan, the small stage, the idle floor, the local stack).

### 16.1 Roles

One Node program, one image definition (`deploy/Dockerfile`, Node pinned by digest), roles selected by
configuration. A process runs one role or several. Roles talk through one message schema; the transport is
a `MessagePort` inside one process and a length-prefixed TCP stream on Railway's private network,
**batched per control tick** (6.2). Which roles share a process is the only thing that differs between the
stages of 16.2 and between the shapes of the local stack (16.4): there is one execution path.
**Every role has one implementation and one owner.** `gate`, `dir`, `sim`, `api` and `pub` live under
`server/` (`server-persistence`); `shell`, `packs` and `dump` live under `deploy/roles`
(`platform-delivery`; the dump's content is `server-persistence`'s). A role manifest names each role's
entry, and the program's entry starts whichever roles `ROLES` names and hands each the shared services
it needs (the logger, the egress meter of 16.2), so `server/` never imports `deploy/`. The publisher
that runs inside `game` at stage 0 is the module that `ROLES=pub` starts as its own service later.

| Role | Does | Does not | Stages 0 and 1 | Stage 2 | Stage 3 |
|---|---|---|---|---|---|
| **Gateway** (`gate`), stateless | Sockets, the session layer of `src/net`, subscriptions, fan-out of island frames and the relevant set, input routing, the 5 s input buffer **with the acknowledged ticks**, back-pressure, rate limits | Physics, decisions | in `game`, on its main thread | own service, 1 replica | 3 or more replicas |
| **Directory** (`dir`), 1 per lobby, holder of the writer lease | Single writer of the universe: records, clocks, reservations and claims, pads, island placement and epochs, screening and forecast chains (helper threads), expiry, admission, persistence, the public documents (on request, at most once a second) | Stepping | in `game` | own service, carrying `api` and `pub` | own service |
| **Shard** (`sim-k`), one main thread plus one isolate per worker thread | Steps islands, runs unattended runs and the Reduced tier, holds the height authority with one shared tile store (10.5), encodes frames, sends checkpoints and journals, turns timers into stamped inputs | Anything about vessels it does not hold | the worker isolates of `game`, started on demand | `sim-1` | `sim-1..K`, one service each |
| **API** (`api`), stateless, no CDN | Accounts and recovery, lobby list, presigned pack list, the planning endpoint, token-protected metrics and `/ops`, bulk account provisioning with an operator token (rehearsal environments and the local stack only, never production) | Sockets; public polling | in `game` | in `dir` | own service, 2 replicas |
| **Publisher** (`pub`), stateless | Serves what is the same for everyone: `live.json`, `status.json`, rules, the census snapshots and deltas, with explicit cache lifetimes | Anything per player | in `game`, no CDN, bounded (13.1) | in `dir`, or its own service with the CDN on | own service, 2 replicas, CDN on |
| **Static** (`shell`), no volume, CDN on | The client build, the boot pack (loaded from the bucket at start, 10.4) and the endpoint document (13.1), with the cross-origin isolation headers | Anything dynamic; sockets | own service | own service | own service |
| **Mirror** (`packs`), no volume, behind a CDN | The tile mirror (10.4) | Anything dynamic | in `shell` | in `shell` | own service, 4 replicas, own domain |
| **Dump** (`dump`), a cron job | The logical dump to the `dumps` bucket, its retention and its skip rule (15.3) | Anything else | cron service | cron service (every 6 hours from stage 1) | cron service |

- A worker is one isolate because `src/sim` keeps module-level scratch state. Vessels move between workers
  by value.
- From stage 2 each shard is its own service because replicas of one Railway service are not individually
  addressable and not sticky. Gateways connect to every shard and to the directory by private DNS name;
  clients never learn which shard holds them.
- From stage 2 the gateways in one replica are separate processes (the Node cluster module), because
  worker threads cannot share a listening socket. In `game` the gateway runs on the main thread beside the
  directory; if that thread binds before stage 2 is otherwise due, the gateway can move to a child process
  of the same container (about 50 MB) without a new service.
- **What never shares a process**: `shell` and anything that holds sockets (a front-end deploy would
  restart the universe); two directories (one writer per lobby; the lease is what makes a deploy overlap
  safe); Postgres and anything else (a service with a volume cannot overlap its deploys).
- Each stage's wiring is also a named shape of the local stack (16.4): **combined** (stages 0 and 1),
  **split** (stage 2: `gate`, `dir` carrying `api` and `pub`, `sim-1`, and a `sim-2` for migration and
  kills) and **launch** (stage 3: `api` and `pub` as their own processes, two gateways, two shards). The
  suites of 28.4 and 28.6 run the combined and the split shape in full, the moves between them in both
  directions, and a smoke of the launch shape, so no wiring is first exercised in production.

### 16.2 Deployment: a ladder of stages on one codebase

The game starts on the smallest stage and moves up only on measured need. Every stage runs the same
program, the same roles, the same schema and the same data; a move is configuration and a deploy, never a
rewrite. The always-on deployment is stage 0, and what it costs follows use: it adds about $5-15 a month
to the workspace bill with nobody connected and $10-25 at 5 concurrent players (estimates; section 30),
against the user's ceilings of about $30 idle and about $50 at 5 players. "Adds" is the exact word. The
Hobby plan's included $5 is per workspace, and the workspace's other project already uses more than
that: $7.4 projected for the current billing period and $10.2 in the last one (`railway usage`, read
2026-11-10). Every dollar of the game's usage is therefore billed, and every trigger that depends on the
plan is a figure of the **workspace**, not of the game.

| Stage | Plan | Railway services | Holds | Standing cost (section 30) |
|---|---|---|---|---|
| **0 Combined** (always on; where the game starts) | Hobby | `game` (gate, dir, api and pub in one process; up to 2 worker isolates; 256 MB tile store; idle level warm; replica limit 2 vCPU / 2 GB), `shell` (static and `packs`, CDN on; limit 0.5 vCPU / 0.25 GB), `postgres` (Postgres 18; limit 1 vCPU / 0.5 GB; 5 GB volume), `dump` (hourly cron job), two buckets (`packs`, `dumps`) | Admission cap 20: the count the conservative projection puts at about $53 a month for the game if it were held all month. The stage-0 load test replaces it with the measured count | Added to the workspace bill: $5-15 a month idle; $10-25 at 5 concurrent players held all month; about $6-17 for 5 players on four evening hours a day |
| **1 Combined on Pro** | Pro | The same services, with volume backups and point-in-time recovery on, `game` deployed from the CI image by digest, 30-day logs; the volume grown only when used space passes 4 GB; replica limits as measured need says | Admission cap up to the measured limit of the `game` main thread (assumed 150-300 players) | The workspace pays max($20, the usage of both projects): the same bill as stage 0 once the workspace's usage has passed $20 and $0-8 a month more below that, plus about $0.3-1 for the WAL archive |
| **2 Split** | Pro | `gate` x 1, `dir` (carrying `api` and `pub`), `sim-1` (4 workers, 1 GB tile store), `shell`, `postgres`, the buckets | about 300-500 concurrent players (assumed); admission cap 500 until a load test says otherwise | about $3-6 a month more than stage 1 at equal load; 200 concurrent held all month about $130-400 |
| **3 Launch** | Pro | `gate` x 3 or more, `dir`, `sim-1..K` (workers per shard from the measured knee, 22 at most; 2.5 GB tile store; idle level light on the extra shards), `api` x 2, `pub` x 2, `shell`, `packs` x 4, `postgres` (volume up to 100 GB), the scale controller | per shard about 360 integrated objects on the conservative figure and about 2,200 on the derived one, at 50 % headroom | 500 concurrent held all month $420-1,020; a front-page day adds $105-345 |
| Beyond | Pro | a second gateway service at 8,000 connections, directory helpers on their own service, a second lobby as a second copy of the stack | 10,000+ | section 30 |

**Moving between stages.** Every trigger is a measured number, shown with its current value by
`deploy/stage.mjs status` and, for what the game itself can see, on `/ops` (section 27 says which is
which). The lead tells the user before any move that changes the plan or raises the standing spend; the
user's answer is recorded in OPEN_QUESTIONS.

| Move | Trigger | What the move involves | Freeze |
|---|---|---|---|
| 0 to 1 | **The workspace's** projected usage for the month at or above $20, read from `railway usage --json` by `deploy/stage.mjs status` (both plans bill the larger of the fee and the usage, and billing is per workspace: with the other project at $7-10 that is the game alone at about $10-13, which is the idle state on the high estimate and about 5-9 concurrent players on the low one); or the volume above 4 GB; or the user wants platform backups and point-in-time recovery sooner ($0-8 a month more, OPEN_QUESTIONS Q2). A projection from the roles' own metrics cannot see the other project and is never used for this trigger | The user upgrades the workspace (it covers the other project in it too). Then, scripted: backups and point-in-time recovery on (this may restart Postgres: the path of 15.4); the source of `game` set to the CI image by digest (needs a registry credential, OPEN_QUESTIONS Q5), **which takes effect at the next regular rollout**, so the move has no rollout of its own. The volume is not grown | Seconds (the Postgres restart), or none |
| Limits, inside stage 0 or 1 | Admission refusing spawns on step time, or the admission cap reached on several days | The replica limits of `game` (up to 8 vCPU / 8 GB on Hobby, 24 / 24 on Pro), its worker count, its tile-store cap, the admission cap and, with them, the egress budgets are raised: variables and one graceful rollout. This raises the worst-case month, so the lead tells the user first | Under 40 s plus the resume window |
| `pub` behind the CDN, at any stage | The publisher above its request budget for 10 minutes (the `pollAfterS` stretch is active, 13.1), or its daily byte budget spent on two days of a week | `pub` is created as its own stateless service with the CDN on (`ROLES=pub`: the module that has been running inside `game`, 16.1); the endpoint document lists it first and `game` second (13.1); about $1 a month | None |
| 1 to 2 | The `game` main thread above 50 % utilisation at peak (measured); or players within 70 % of its measured limit; or the gateway and the simulation need separate deploys | `deploy/stage.mjs up --to split`: `gate`, `dir` and `sim-1` are created from the same digest and wait in standby; **the endpoint document is changed to list `gate` first and `game` second, and the script waits until the redeployed `shell` serves it** (13.1); the freeze is announced; `game` freezes, writes final checkpoints, flushes and releases the lease; `dir` takes the lease and runs the decode sweep; `sim-1` registers and restores the islands from the checkpoints (same build); `gate` accepts, and clients, which re-read the document before every reconnect attempt, resume on it inside the resume window; `game` is removed and then dropped from the document | One announced freeze: under 40 s plus the 30 s resume window (the rollout budget of 29.2) |
| 2 to 3 | An announced launch, or measured admission queueing at stage 2 | `deploy/stage.mjs up --to launch`: `sim-2..K`, gateway replicas and the `api`, `pub` and `packs` services are added (each listed in the endpoint document before it is relied on), the volume grown when its used space asks for it, the scale controller enabled inside the ceiling of OPEN_QUESTIONS Q6 | None (it adds services and replicas) |
| Down | Usage back under the trigger for a billing cycle | 3 to 2 removes services after their islands have migrated: no freeze. 2 to 1 is the mirrored freeze: `game` is created in standby and listed second in the endpoint document; `gate`, `dir` and `sim-1` freeze, write final checkpoints and release the lease; `game` takes it and restores. It is tested like the move up (28.6). 1 to 0 is offered only while the volume is still 5 GB or smaller: backups and point-in-time recovery off, the source of `game` back to the repository build at the next rollout, then the plan downgrade, which is the user's. **Once the volume has grown past 5 GB, stage 1 is one-way**: a volume never shrinks and 5 GB is the Hobby plan's largest, so going back would mean a dump, a new volume and a restore with a freeze of minutes, and it is not offered | 3 to 2 and 1 to 0: none. 2 to 1: as the move up |

No move loses committed state: each is the graceful column of 15.4 or needs no freeze at all, and each
ends with a dump.

**What stays true at every stage**: one execution path (the island loop, the directory, the session layer
and the role message schema are the same code in one process or in seven services); the single fenced
writer; per-island durability and recovery; the lobby as the unit of deployment (one directory, one shard
set, one schema; a second lobby is a second copy of whatever stage it needs).

**What stage 0 gives up**, said plainly:

- **An unannounced front-page day is not absorbed automatically.** Nothing scales by itself below stage 3
  and, by the user's decision, nothing alerts, so nobody is told. What happens instead: the first 20
  players (the admission cap) play normally. Everyone else still gets the title, the live Earth and the
  menu inside the cold-start budget, because the shell, its CDN, the boot pack and the bucket do not
  depend on `game`; they are given a queue position and watch from the public documents, whose polling
  the publisher stretches and, past its request or byte budget, refuses (13.1): on such a day the
  spectating view runs out within the first hour and the queue shows the last picture with a note.
  Nobody loses a ship, the universe does not slow down, and the day is bounded by the replica limits,
  the cap and the egress budgets below at about $3-5, whatever the CDN does (section 30).
- **How fast a human can move up once somebody looks** (targets; every step is timed in the stage-up drill
  of 28.7): the limits and the cap of `game` raised to what one Hobby replica holds, about 5 minutes with
  one freeze; `pub` behind the CDN, about 10 minutes with no freeze; the Pro upgrade, the user's click;
  stage 2, about 30 minutes of scripted work with one announced freeze; the first extra shards of stage
  3, about 15 minutes with no freeze. From a standing start the launch topology is about an hour of a
  human's time away, most of it waiting for builds. A launch that is announced is moved up the day before.
- A crash of the `game` main thread takes the crash-of-everything path (at most 250 ms re-run per island)
  where stage 2 would restart the directory and roll nothing back (15.4).
- If the Postgres volume itself is lost, up to about one hour of directory state goes with it (15.3);
  stage 1 closes that to minutes.
- The gateway and the directory share one thread, so a socket storm and directory work compete; that
  thread's utilisation is a published metric and the trigger for stage 2.

**Stage 0 in detail.**

- **`game`** is built by Railway from the repository's `release` branch with `deploy/Dockerfile` (the
  Hobby plan cannot pull an image from a private registry); the lead moves that branch to the release
  tag. Autodeploy is off. Its health check passes in standby; `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45`
  (the default of 0 would turn every deploy into a crash); restart policy Always; one replica; no volume;
  no CDN; `ADMISSION_CAP=20`; idle level warm; a 256 MB tile store.
- **`shell`** is the same image in its static role: cross-origin isolation headers, the client build as
  immutable hashed assets, `index.html` and `endpoints.json` (13.1) sent `no-cache` so the CDN does not
  hold them for its default two hours, the boot pack fetched from the `packs` bucket at start and held in
  memory (10.4; the health check waits for it), and the mirror. CDN on. It autodeploys on its own watch
  paths, so a front-end push never restarts the universe.
- **`postgres`** is Railway's template on the Postgres 18 image (the major is chosen at creation and is
  the one the local stack embeds), private network only. Before its first boot `POSTGRES_INITDB_ARGS` is
  set to `--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8`, the same cluster settings
  as the local stack (15.2; they cannot be changed afterwards). `shared_buffers=96MB`,
  `max_wal_size=256MB`, `min_wal_size=64MB` and `max_connections=40` are set through `ALTER SYSTEM` (the
  pools are stated in 15.3). **Its replica limit is 1 vCPU / 0.5 GB.** Railway bills page cache, and the
  lease UPDATE, recycled WAL segments and every dump fill it; the limit is what makes the kernel give
  it back, so the limit is the most that Postgres memory can cost ($5 a month).
- **`dump`** is a cron service that runs the `dump` role of the same image, whose `pg_dump` is of the
  server's major (15.3). It holds the `dumps` credential; `game` and `shell` do not.
- **Buckets**: `packs` and `dumps`, in US East (10.4).
- **Domains**: Railway's own. If the user supplies a domain, the Hobby plan's two custom domains cover
  `shell` and `game`; the endpoint document is what tells a client either.
- **Build identity.** A journal is valid only for the build that wrote it, and at stage 0 the image is
  built by Railway instead of being pulled by digest. The build therefore computes a `buildId` from the
  Node image digest and the hash of the server bundle; CI builds the same Dockerfile at the same commit
  and records its `buildId`; the rollout script refuses a deployment whose `buildId` differs from CI's,
  and the Modal audit builds from the same Dockerfile and checks the id before it replays anything. The
  `buildId` does not cover baked data, so the rollout also checks the boot manifest hash and the client
  build hash that the running `shell` reports against the release commit (10.4). From stage 1 the CI
  image is deployed by digest and one artefact runs everywhere.
- **Nothing in production sleeps.** The time model would allow it (an empty universe is passive, and every
  wall-clock timer can catch up), but Railway's Serverless mode would save a few dollars a month at the
  price of a first visit of 5-15 s that may fail with a 502, on a feature Railway itself calls a poor fit
  for WebSocket servers and databases. The user has said that an idle floor of about $30 is acceptable
  where zero would be complex or fragile, and this is such a place. So `game` and `postgres` stay up and
  the universe goes **idle at the warm level** (6.2): no tick loop, documents only on request, one
  worker isolate and the launch bodies' resident terrain kept. **The first visitor after any quiet
  spell waits for nothing, and so does the first Deploy**: the title comes from the shell's CDN, the
  menu's documents are answered at once, and the worker and the terrain are already there. True scale
  to zero is used where it is simple and robust: Modal (nothing always on; a cold start only delays a
  batch job), the `dump` job (a container that exists for seconds each hour), and rehearsal
  environments, which exist only while a measurement runs.
- **The idle floor: the game adds $5-15 a month to the workspace bill**, all of it usage (memory of
  `game` and Postgres, in that order, is most of it; the warm level is $1-2.50 of it). With the other
  project the workspace then pays about $13-25 a month on the Hobby plan. Both figures are under the $30
  the user named.
- **The bill is bounded by configuration, not by an alert.** No hard usage limit is set: Railway's limit
  is per workspace, so it would stop the other project too, and it suspends the buckets. Two things
  bound the month instead.
  *Compute*: the replica limits (`game` 2 vCPU / 2 GB, `postgres` 1 vCPU / 0.5 GB, `shell` 0.5 vCPU /
  0.25 GB) cap it at about $100 a month even if every service were pegged all month.
  *Egress*: replica limits do not bound bytes, and stage 0 has public byte sources that need no
  admission, so **every route that sends bytes to the internet has a daily budget, counted in process
  from the egress-per-route meters of section 27** and reset at 00:00 UTC:

  | Route | Daily budget (a setting) | If spent every day of a month | When it is spent |
  |---|---|---|---|
  | `shell`: the client build (CDN misses) | 3 GB | $4.50 | 503 with `Retry-After` for misses of hashed assets; CDN hits are unaffected |
  | `shell`: the boot pack (CDN misses) | 1 GB (40 copies) | $1.50 | a redirect to the presigned copy in the bucket, which is free |
  | `shell`: the mirror (CDN misses) | 8 GB | $12 | 429; clients stay on the bucket path (10.4) |
  | `game`: public documents, anonymous | 2 GB | $3 | `pollAfterS` at its maximum from half the budget, then 429 (13.1) |
  | `game`: the API, anonymous routes | 1 GB | $1.50 | 429; requests with a live session are served |
  | `dump`: uploads | 1.5 GB | $2.25 | the dump interval lengthens (15.3) |
  | `game`: sockets | no daily budget: the admission cap of 20 times the 6 kB/s per-client cap | $15.80 | the cap and the per-client budget already hold it |

  The hashed routes of `shell` (`/p/`, `/boot/`, the assets) answer **404 with no body to any request
  that has a query string**, so a cache-busting variant never returns bytes, and origin bytes are also
  limited per client address (300 MB in 10 minutes on the mirror; whether the CDN passes the client's
  address to the origin is checked in wave 3, and the daily budgets do not depend on it). **The worst
  month the game can cost at stage 0 is therefore about $140**: about $100 of pegged compute, which
  takes a runaway bug, plus about $40 of egress if every budget were spent every day; a month in which a
  scraper or a broken client spends every budget every day on otherwise normal compute is about $25
  above a normal month. `deploy/stage.mjs status` prints the workspace's usage and estimated bill from
  `railway usage --json` (both projects, which is what the plan triggers are judged on), the game's
  share, each budget with what was used of it today, and every trigger of the table above; `/ops` shows
  what the game itself can measure (section 27). The lead reads them at every release and writes the
  cost line into `docs/capacity/`.

**Mechanics shared by the stages.**

- **One image definition; one artefact from stage 1.** CI builds the image on every release, runs the
  image smoke test on it (16.4) and records its `buildId`. From stage 1 it also pushes the image to the
  registry and records its digest, every service is deployed by digest, and adding a shard is a pull,
  not a build (Railway allows ten concurrent builds on Pro and three on Hobby, so building per service
  would take longer than the spike).
- **Scale-out is automatic only at stage 3, inside a ceiling.** A controller (a scheduled job of the `api`
  service reading the directory's metrics) calls `deploy/scale.mjs` when the admission queue has been
  above its threshold for three minutes, and scales in after thirty quiet minutes. It never exceeds the
  ceiling of OPEN_QUESTIONS Q6 (maximum shards, maximum dollars per day) and its Railway token is a sealed
  variable (creating services through the API probably needs a workspace-level token: verified in the
  launch rehearsal, before the controller is relied on). It routes no alerts: every action is logged and
  shown on `/ops` (section 27). The same script can be run by hand.
- **The moves are tested**: the stage-up drill of 28.7 walks a rehearsal environment up the ladder under
  load and times every step, and the time from the controller's trigger to K new shards taking islands
  is measured under a 500-bot load, before any launch is announced.
- **Deploys of the simulation are never automatic.** At stages 0 and 1 `deploy/rollout.mjs` triggers one
  deployment of `game` and watches the hand-over: the new process healthy in standby; notice; the old
  one freezes the clocks at a tick boundary, writes final checkpoints, flushes and releases the lease
  inside its drain window; the new one takes the lease (15.3), runs the decode sweep and restores; the
  clocks resume into the resume window; the dump job is triggered. From stage 2 one push would otherwise
  redeploy `dir`, `sim-*` and `gate` at once, in no order, with two directory processes alive, so the
  same script drives the ordered sequence through the Railway API at one image digest: notice; freeze
  clocks; shard checkpoints; directory flush and lease release; the new directory takes the lease and
  runs the decode sweep; shards start and register; clocks resume into the resume window; gateways roll
  last. `shell` (and `api`, `pub` and `packs` where they are services) autodeploy on their own watch
  paths; a front-end push never touches the universe.
- **Releases come from tags.** Nothing deploys from `main`: the lead moves a release tag (and, at stage 0,
  the `release` branch to it), and packages never push `main`. A measured row of a capacity report names
  the build it ran on. At stage 0 Railway builds from the repository through its GitHub App once the
  user has given the App access to the repository (OPEN_QUESTIONS Q5); until then the rollout script
  uploads a clean export of the release tag from the development machine's logged-in CLI, and Railway
  builds the same Dockerfile from it.
- **Shell**: the `shell` service on Railway by default. Netlify is an option for the shell only
  (OPEN_QUESTIONS Q3); its configuration is written and validated when the user chooses it, not kept as an
  untested file.
- **Modal** (own environment `fsp`, app names prefixed `fsp-`; existing apps and volumes untouched;
  nothing always on, so it costs nothing between jobs and the two nightly jobs stay inside the monthly
  credit): `fsp-audit` (nightly replay of archived journals against committed checkpoints, on the build
  that wrote them), `fsp-offsite` (nightly copy of the newest dump from the `dumps` bucket to a Modal
  volume; and, once per pack set, a copy of the packs to a Modal volume through the presigned pack list,
  which needs no credential and makes the development machine's `data/packs` deletable),
  `fsp-bots` (load-test players, 100 or more per 4-core container so that 5,000 bots stay well under the
  workspace's container limit shared with the existing apps), `fsp-bake`, `fsp-probe` (bucket throughput
  tests, expressed as concurrent fetchers per container).
- **Region**: US East. Europe sees roughly 90-120 ms of round trip, Asia and Australia about 250 ms. A
  second region would be a second lobby.
- **Secrets**: run-time secrets as Railway sealed or reference variables; deploy secrets in GitHub
  Actions once they exist (until then rollouts run from the development machine's logged-in CLIs; stage 0
  needs no deploy secret in GitHub at all); the client holds no provider credential. **Three credentials
  exist outside Railway, and they are named**: the `dumps` bucket credential as a Modal secret in
  environment `fsp`, for `fsp-offsite` and `fsp-audit` (it is the full credential of that bucket,
  because Railway cannot issue a read-only one; that is why dumps have a bucket of their own); the
  `packs` bucket credential in the development machine's `.env`, for the upload tool; and the operator
  token of a **rehearsal** environment as a Modal secret for `fsp-bots`, created with the environment
  and deleted with it. A sealed variable cannot be read back, so each of these is generated or read once
  by the deploy script at creation and written to both places in the same run, never to a file or a
  log. The session signing key, the database URL and production's operator token never leave Railway.
- **CI** (GitHub Actions on `sshh12/fable-space-program`): secrets check, a repository scan for `TODO`,
  `FIXME`, `stub` and `placeholder` outside the allowed simple-body data, typecheck (browser and Node
  configurations), boundaries, unit and universe suites, the net suites on synthetic terrain, the
  production build and the image. The repository is private, so Actions minutes are finite and "Wait for
  CI" blocks deploys when they run out: CI stays under 8 minutes per push with path filters, and the
  monthly budget is a line of section 30. Mission proofs and GPU suites run on the development machine
  (they need baked tiles and a GPU).
- **Rehearsal environments, no standing staging.** A rehearsal environment is a second environment of the
  Railway project in the shape of the stage being measured, on `rules/staging.json` or a load-test rule
  set. `deploy/stage.mjs rehearse` creates it, it exists for the run and it is deleted afterwards, so
  nothing stands idle and nothing needs waking. **Storage is the part that needs saying.** Railway
  buckets belong to one environment, so a new environment starts with empty ones, and re-uploading
  14-20 GB of packs for every run is hours at this machine's uplink. `rehearse` therefore gives the
  rehearsal environment the production `packs` credential as a sealed variable: its `game`, its `shell`
  and its bots read the same immutable, content-addressed packs as production, through a pack list
  signed by the rehearsal's own `game`. It is **never** given the `dumps` credential: the rehearsal's
  dumps go to its own `dumps` bucket, which is deleted with it, so nothing a rehearsal writes or prunes
  can touch a production dump. The `packs` credential cannot be made read-only; what protects the packs
  is that no role contains a delete or an overwrite of a pack, that every pack is verified by hash, and
  that a second copy exists off Railway (10.4). A rehearsal environment also has the operator switches
  that production never has: bulk account provisioning, a lifted admission cap and the fault commands
  of 28.7. A rehearsal in the shape of stage 0 fits the Hobby plan and costs a few dollars. A rehearsal
  of stage 2 or 3 needs the Pro plan and is run only after the lead has told the user what it will cost
  (28.7, section 30).

### 16.3 Scaling path

Simulation and network:

1. Stage 0 and 1, vertical: more worker isolates and a higher replica limit on `game`, up to the measured
   limit of its main thread; then the split (stage 2) and more workers on `sim-1`, up to the measured
   knee.
2. More shards and gateway replicas (stage 3, the controller); the directory places islands by clock and
   sphere of influence so likely merges are local.
3. `lagCap > 0` for single-owner islands, on the evidence of 6.2 (fewer shards on the conservative figure:
   about 12 instead of 19 for a launch-heavy 5,000).
4. A second gateway service; ask Railway for more than 10,000 connections per service.
5. Screening helpers on their own service; partition the directory by planetary system.
6. Postgres: pooling, then the HA cluster, then journals on a separate instance.
7. More lobbies.

**Launch slots** bind before any of the above once the deployment is at stage 3 (decision 54); below it
the stage's admission cap binds first. With 30-minute sessions, `f` launches per
session and a 150 s mean cycle, launches per hour are `concurrent x 2 x f` and the pads needed to sustain
them are that divided by 24:

| Concurrent players | Launches per hour (f = 1 / 0.5) | Pads to sustain it | With the release complex (32 pads, 768 per hour, 258,000 in the 14-day reservoir) |
|---|---|---|---|
| 500 | 1,000 / 500 | 42 / 21 | f = 0.5: sustained for ever. f = 1: the reservoir covers the deficit for 46 days |
| 2,000 | 4,000 / 2,000 | 167 / 84 | the reservoir lasts 80 hours / 8.7 days |
| 5,000 | 10,000 / 5,000 | 417 / 209 | the reservoir lasts 28 hours / 61 hours: one front-page day fits, a sustained 5,000 does not |

How more is obtained, in order of cost: (a) `cohortHorizon`, a rules field (more reservoir, players start
further from the live clock); (b) a shorter cycle: the dwell and safing defaults are rules fields, and a 90 s
cycle is 1.67 times the throughput; (c) more pads at a site: the pad generator and one resolve run, up to
about 48 per 100 km of coast at the stated spacing; (d) more sites: one regional bake and a structures file
each. A sustained launch-heavy 5,000 needs about 200-400 pads, that is about ten sites, and is not offered
by the first release; the rules screen says what a player waits at the measured limit, and the load test
makes the wait from Deploy to control-enabled its own service level (28.7).

### 16.4 The local stack

The whole game runs on the development machine with no cloud resource: every server role, persistence,
tile delivery and several clients, from one command. It is how features are built and tested every day,
and where the multi-client acceptance runs. The deployed environment is needed only for the deployed
proofs: the deploy itself, restart recovery on the production database, and measured hosting numbers
(28.7, 31.4).

- **One command.** `npm run stack` (the script wraps `deploy/local/stack.mjs` in
  `node tools/dev/heavy.mjs --class=stack`) starts:
  - a real PostgreSQL 18 from the `embedded-postgres` package, in a directory the stack owns
    (`data/stack/<name>/pg`), created with production's cluster settings through `initdbFlags`
    (`--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8`, 15.2; the package's default
    would create a WIN1252 cluster on this machine). The stack refuses to start on a data directory
    whose encoding or locale provider differs;
  - the roles as host Node processes in a named shape (below);
  - the page a browser loads (below);
  - a small HTTP server over `data/packs` that stands in for the bucket (ranged GET with CORS,
    presigned-style URLs whose expiry it honours, switches that make it answer 403, 404 or 429 for the
    failover tests) and for the mirror in the mode wave 3 chose, so the pack path, the failover, the
    boot pack and the shell's load of it are exercised without a bucket;
  - the stack's own endpoint document (13.1), which is how every client, browser or headless, finds
    the roles: no test is handed a gateway address by configuration;
  - when a test asks for them, the latency injector and N headless clients or Chrome instances.

  Options: `--shape=combined|split|launch`, `--rules=local|staging|default|<a load-test set>`, `--fresh`
  (a new database), `--db=docker` (the Postgres container instead of the embedded one, behind the same
  `DATABASE_URL`), `--page=dev|build`, `--profile=acceptance|load`, `--compose`, and `STACK_NAME`
  (state under `data/stack/<name>`, so one package's database is never another's).
- **The stack lives exactly as long as its launcher, and the launcher holds the one `stack` slot.**
  `heavy.mjs` frees a slot when the wrapped command exits. A stack left running in the background would
  therefore hold no slot, and two packages could start two stacks, or a stack beside the 6 GB Docker
  VM, on the machine that once crashed under load. So there is no background mode.
  `npm run stack -- [options] -- <command>` takes the slot, brings the stack up, hands the command
  `STACK_URL`, `STACK_ENDPOINTS` and `STACK_STATE`, runs it, and brings the stack down when the command
  exits, whatever its exit code, and on a signal. Without a command it stays in the foreground, for hand
  work, until it is interrupted. `npm run stack -- status`, from another terminal, prints what runs with
  its memory; `npm run stack -- down` cleans up after a launcher that died (its slot is reclaimed, as
  for any dead holder). The compose form is the same launcher with `--compose`, in the same slot: the
  host stack and the compose stack never run together, and never two of either; a second launcher
  waits. A package holds the slot for one suite at a time and gives it up between suites, so packages
  that work in the same wave take turns. Since only one stack runs at a time there is one port range;
  `STACK_NAME` only separates the data directories of runs that follow each other.
- **Shapes are the wirings of the stages (16.1), by name.** `combined` (the default; `game` and `shell`:
  stages 0 and 1). `split` (`gate`, `dir` carrying `api` and `pub`, `sim-1`, `sim-2` and `shell`, over
  the TCP transport: stage 2, with the second shard there for cross-shard migration and kills).
  `launch` (two `gate` processes, `dir`, `sim-1`, `sim-2`, `api`, `pub`, `shell` and `packs`, each its
  own process: the stage-3 wiring). The moves between combined and split, in both directions, are
  driven by the harness on a live database (28.6). The table below says which suite runs on which.
- **What page a browser loads.** Two sources, both provided by the lead as root configuration.
  `--page=dev`, the default, for everyday work, the functional specs and the two-browser stories: the
  existing Vite dev server (which also serves the plain-file tiles), started by the launcher with the
  stack's endpoint document, so the unbundled app finds the local roles the way the built one finds
  production's; without a stack the document is absent and the app offers Practice only, as today.
  `--page=build`, for the cold-start and boot-pack rows of 29.2, the whole flights of 31.5 in real
  Chrome and anything that asserts bytes or seconds: the `shell` role serves a production client build
  and the boot pack. `npm run stack:client` (the lead's script, the same Vite configuration as CI's
  build) writes that build to `data/stack/client/<source hash>/`, never to the shared `dist/`, under
  `--class=cpu`, and does nothing when the source hash is unchanged; the launcher runs it when
  `--page=build` is asked for. It is the only client build a package ever runs.
  `tests/browser/globalSetup.ts` (the lead's) starts no server of its own when `STACK_URL` is set and
  points the `functional` and `acceptance` projects at it; without it, it behaves as today.
- **Host processes and an embedded Postgres are the default, on measurements** (`hosting-small.md`
  section 8). There is no daemon to start. Postgres takes about 160 MB, against 1-3 GB for the Docker VM,
  on a machine that once crashed under combined load and whose browser tests need the memory and the GPU.
  Postgres is ready in 0.1-0.3 s (4 s for the first initialisation). The plain-file tile tree is read
  natively, where a bind mount into a container is 36 times slower. No image is rebuilt per edit. And it
  is a real Postgres exactly where the design depends on one (its Windows bundle includes `citext`, and
  with the cluster settings above its encoding and collation are production's): the advisory lock is exclusive between
  sessions, a fenced write with a stale token changes no row, the 250 ms batches are real transactions,
  partitions work, and a committed row survives a hard kill. PGlite is not used for the stack: it has a
  single session, so a second directory "takes" the same advisory lock and the lease cannot be expressed.
- **Docker compose is the high-fidelity form, used where the difference matters**
  (`deploy/local/compose.yml`: the pinned role image, the Postgres 18 image that Railway's template is
  built on, MinIO as the S3 store). It gives real SIGTERM and SIGKILL (a Windows process cannot be sent
  SIGTERM, so the host stack drains by control message), the pinned Linux build that journal replay is
  defined on, `pg_dump` and `pg_restore` of the production major (the embedded Windows bundle has
  neither), container memory as Railway bills it, and an S3 API for the upload and presign scripts. A
  suite that needs it starts the Docker daemon if it is stopped and stops what it started. Tiles reach
  the containers as packs (large files read at 170 MB/s through a bind mount) or over HTTP from a host
  process, never as the plain-file tree through a bind mount.
- **Memory, inside the machine-load rules.** One stack at a time, by the slot above. In the
  **acceptance profile** (the default: up to six headless clients, two worker isolates per shard, a
  256 MB tile store) the host stack's servers stay under 1.5 GB in the combined shape and 2.5 GB in the
  split and launch shapes (Postgres 0.2 GB, `game` 0.4-0.8 GB, the tile servers 0.2 GB); a headless
  client is about 150 MB; Chrome instances stay in the `gpu` class. The **load profile**
  (`--profile=load`: the local runs with 50 to 500 wire-level clients or bots) has its own bound, 4 GB
  for the servers and 2 GB for the clients, and its launcher does not start with less than 16 GB of
  physical memory free; nothing else heavy runs beside it, and it makes no capacity claim. A memory row
  that fits neither these bounds nor the Docker VM is not run on this machine: per-isolate and
  tile-store memory are measured on a shard of two to four workers, the 22-worker figure is derived from
  them, and the shard is measured whole only in the launch rehearsal (28.7). The Docker VM is capped at
  6 GB, 8 processors and 2 GB of swap, with `autoMemoryReclaim=dropCache`, in
  `%UserProfile%\.wslconfig`. That file applies to every WSL 2 distribution and takes effect after
  `wsl --shutdown`, so it is written once, at a moment when nothing runs (OPEN_QUESTIONS, "Small
  things").

| Suite | Runs on | Why |
|---|---|---|
| 28.1 unit, 28.2 universe, 28.3 mission | Nothing: in-process | No database |
| Lane equivalence and migration (`tests/net/server`) | Host stack | Executors only; no signal, no dump |
| 28.4 the latency matrix with two to six headless clients | Host stack, combined shape; the docking, disconnect and warp rows once more in the split shape; the docking row once in the launch shape | Latency is injected per client; drain by control message works on Windows |
| 28.5 the two-browser acceptance stories | Host stack, combined shape, `--page=dev` | Memory and the GPU belong to the browsers |
| The flights of 31.4 and 31.5 through `NetSession` in real Chrome; every cold-start and boot-pack row | Host stack, combined shape, `--page=build` | The page a player gets: the production client build and the boot pack from `shell` |
| 28.6 expiry on the staging rule set with an injected wall clock | Host stack | No signal or dump involved |
| 28.6 restart and recovery (graceful rollout, two overlapping directories, the stage move in both directions, kills of a worker, of `game`, of a shard and of the directory, a Postgres restart, the decode sweep, restore from the dump); replay audits; billed-memory measurements (cgroup `memory.current`) | Compose, the pinned Linux image, combined and split shapes | Signals, the build replay is defined on, `pg_dump` and `pg_restore`, container memory |
| The image smoke test before every deploy | Compose | It is the artefact Railway runs |
| Pack, upload and presign scripts | Host stack for the pack path; compose's MinIO for upload and presign | The real bucket is measured in wave 3 |
| The local load runs (`server-persistence`: 5 to 500 wire-level clients; 28.7: up to about 200 bots; no capacity claim) | Host stack, `--profile=load` | Least memory; its own stated bound |
| The scale controller's dry run | Host stack, launch shape | The stage-3 wiring without a cloud resource |

A local-stack result is never reported as a deployed or a measured-capacity result.

---

## 17. Client structure and runtime data flow

### 17.1 Sessions

`FlightSession` (`src/core/contracts/session.ts`) is what `src/app`, pilots, labs and tests hold:
`advance(realDt, onControlTick?)`, `snapshot()`, `peek()`, `setControls()`, `commands: PlayerCommands`
(flight, target, time, port, helm and transfer commands: everything a pilot does from the seat),
`universe: UniverseCommands` (spawn, attach, detach, subscriptions, rename, abandon),
`stores: ClientStores` (census, pads, ships, assembly, roster, rules, presence, feed, prompts, link state),
`planning: PlanningService` (6.3).

- **`LocalSession`** (`src/session`, headless) runs `src/universe` in process: a directory, islands, no
  sockets, no lag, authoritative state presented directly. It adds `ready`, `terrainPending()`, `step()`,
  `advanceRails()`, `needsIntegration`, `nextEventUt`, `stateHash()`, `debug` and `cheatCounter`. It is the
  headless mission, every lab, the calibration benchmark and offline practice (`rules/local.json`).
  `createSession(defs, scenarioId, { terrain })` returns it. It lives above the universe and not in
  `src/sim` (which may not import its own host) nor in `src/client` (which is not headless); `src/sim`
  exports no session. Until `src/universe` exists (waves 3 and 4) `createSession` returns `World` typed as
  `LocalSession`; the switch is a gated step with an owner (MIGRATION_V2 step 4.3).
- **`NetSession`** (`src/client/net`) is the same interface over a gateway: the session layer of `src/net`,
  the replica of 13.5, the relevant-set and census stores, the clock, the planning providers. It finds
  the gateway, the API and the publisher through the endpoint document (13.1), which it reads again
  before every reconnect attempt, so a stage move or a new `pub` service needs no reload. Commands that
  change state return `{ ok: true, pending: true }` at once and are confirmed by a `commandResult` event;
  planning commands (`addNode`, `setNode`, `removeNode`, `setNavballMode`, `setTarget`) stay synchronous
  because they are local.
- **`FakeSession`** (`src/core/fakes`) keeps the v1 FakeSim's role for labs, with multi-vessel, target,
  docking, echo and time-strip scenes. Because five packages build against it, each of its scenes has a
  **conformance test** against the output of a real `LocalSession` in the same situation (field presence,
  units, frames, value ranges), owned with the fakes by the package that owns them in that wave.
- The app (`src/app`) switches between `LocalSession` (offline practice, labs, calibration) and
  `NetSession` (the lobby). It is built by two packages with gates, not between waves:
  `app-integration-1` (the shell, calibration and the browser mission on `LocalSession`) and
  `app-integration-2` (`NetSession` against the local stack, reconnect states, stores, the pack source).

### 17.2 One frame of the app loop

```
requestAnimationFrame(now)
  realDt   = clamp(now - last, 0, 0.1 s)
  input    = inputSystem.sample()                          per context: menu, transit, flight
  shell.update(input, stores)                              app state machine; menu screens read stores only
  map      = mapView.update(lastSnapshot, lastCamera, session.commands, input.pointer, displaySize, census)
  controls = controller.update(input, lastSnapshot, session.commands, realDt, ctx)     flight context only
  session.setControls(controls)
  session.advance(realDt, onControlTick)                   Local: steps the universe. Net: drains messages,
                                                           predicts whole ticks, sends stamped inputs
  snapshot = session.snapshot()                            immutable; poses interpolated to presentation
                                                           time; drains events exactly once per frame
  camera   = rigs[viewMode].update(snapshot, cameraInput(input, map), realDt)
  hud.update(snapshot, camera, realDt)
  audio.update({ snapshot, listener(camera), realDt, warpFactor })
  renderer.render(snapshot, camera, observers, realDt)
  testApi.frameDone()
```

- **The snapshot is the only thing that flows from the simulation to presentation**; `ControlInputs`,
  `PlayerCommands` and `UniverseCommands` are the only things that flow back. Menu screens read the client
  stores and never the network.
- `SimSnapshot.activeVesselId` is `string | null` (menu, spectating, transit). The singleton blocks
  (`readouts`, `navball`, `staging`, `patches`, `nodes`, `appliedControls`) are always present and hold
  neutral values when there is no active vessel, so their read sites are unchanged.
- `SimSnapshot.revision` (v1's `tick`) counts state changes; the universe tick is `time.myTick`.
- Presentation stays decoupled from the physics rate: whole 1/120 s steps, the remainder carried over,
  integrated vessels interpolated between their last two predicted states; bodies, rails and landed vessels
  evaluated exactly at the presentation time. `peek()` is never interpolated.
- Events are edge-triggered facts scoped by relevance; `vesselId` is on every event. Events of a
  single-owner island's own commands appear when predicted; all others when the server's event arrives.
- Threads: the session and view builders on the main thread (about 0.1 ms per step); terrain tiles in a
  worker pool; heliocentric predictions, closest approaches and the proximity plot behind `PlanningService`
  (a planning worker in the browser, 6.3);
  census icons on the GPU above 500 objects; socket keep-alive in a worker so a hidden tab stays connected;
  audio in the browser's audio thread.
- Time warp never changes this flow.

---

## 18. Rendering

Design: `docs/research/rendering-design.md`. Raw WebGPU + WGSL, no engine. Contracts:
`src/core/contracts/render.ts`. The render core writes `docs/RENDER_API.md` (exact WGSL struct layouts,
bind group 0, helper APIs) for feature authors.

### 18.0 Frame graph

Owned by `src/render/core`; features plug in through `RenderFeature` hooks. "core" rows are not hooks.

| Order | Stage | Hook | Attachments and rules |
|---|---|---|---|
| 0 | CPU prepare | `prepare` | culling, streaming, uniform uploads, light registration |
| 1 | Compute | `compute` | atmosphere LUTs, ocean FFT, particle simulation, env probe. `scene.depth*` still hold the PREVIOUS frame here |
| 2 | Sun shadow cascades | `drawShadow` | depth-only, once per cascade re-rendered this frame; moving casters draw only when `cascade.everyFrame` |
| 3 | G-buffer | `drawGBuffer` | RT0 albedo, RT1 normal, RT2 material, RT3 velocity, RT4 extra, HDR emissive; depth write, compare `greater`. Terrain, far water sheet, vehicles, pad, rocks, cockpit |
| 3a | copy | core | depth -> `scene.depthOpaque` |
| 4 | AO + contact shadows, deferred lighting | core | sun x atmosphere transmittance x eclipse x cloud shadow, sky irradiance, IBL, planetshine, local lights; water pixels through `brdf_water` |
| 4a | copy | core | HDR -> `scene.colorCopy` (only when a feature `requires` it) |
| 5 | Water forward | `drawWater` | HDR (blending) + RT3 velocity; depth writable, compare `greater-equal`. Samples `scene.depthOpaque` / `scene.colorCopy` |
| 5a | copy | core | depth -> `scene.depth`; min/max downsample -> `scene.depthHalf` |
| 6 | Background | `drawBackground` | HDR; depth read-only, compare `equal` (depth == 0): stars, Milky Way, sun disc, far-body impostors |
| 7 | Atmosphere + clouds | `compositeAtmosphere` | the feature's own half-resolution passes, then one blend into HDR; publishes `atmosphere.aerialPerspective`, `clouds.screen`, `clouds.depth` |
| 8 | Offscreen transparents | `preTransparent` | the feature's own passes (half-resolution ray-marched plumes, smoke, plasma) reading `scene.depth` / `scene.depthHalf`; never the HDR target |
| 8a | copy | core | HDR -> `scene.colorCopyTransparent` (only when required) |
| 9 | Transparents | `drawTransparent` | HDR with blending (premultiplied or dual-source); depth read-only, compare `greater-equal`; `applyAtmosphere()` mandatory |
| 10 | TAA/TAAU, bloom, exposure, AgX tonemap | core | dynamic resolution on GPU time; inputs sanitised |
| 11 | LDR overlay | `drawOverlay` | display resolution, no depth: orbit lines, markers |

- Targets and encodings are fixed by `RENDER_FORMATS`; material ids by `MATERIAL_ID`; the meaning of the
  material parameter by `MATERIAL_PARAM`; water depth by `encodeWaterDepth` (`WATER_DEPTH_ENCODE_MAX`).
- A hook never samples a live attachment: it samples the copy the table names. Within a hook, features run
  in ascending `RenderFeature.order`, then registration order (the app registers plumes before cockpit glass).
- Features publish/consume GPU resources through `SharedResources`. The core provides a neutral default
  for every key so each feature runs alone in its lab.
- There is exactly one scene. Cockpit, chase and map are cameras into it. The map view shows the real
  bodies at whatever LOD the distance selects.
- Bodies/vessels are iterated generically; shaders take per-body parameters from uniforms built from
  `BodyDef.render`.
- Every pass has a GPU timestamp query; `window.__perf` exposes `PerfSnapshot`, including a per-feature
  breakdown (`features`) that the budget table of section 29 is enforced against.

### 18.1 Sun shadows

- Up to 8 cascades in one 2048^2 `depth32float` array, logarithmic splits from 12 m to 1500 km.
- **Anchoring.** Each cascade is fitted, anchored and texel-snapped in the body-fixed frame of the body it
  covers (the nearest surface), or in the vessel frame for cascade 0 in cockpit view. The matrix actually
  used, `ShadowCascadeView.viewProj`, is re-derived every frame in float64 as the capture matrix times the
  motion of the anchor frame since capture, and uploaded to `shadow.uniforms`. A cascade that is
  re-rendered only every 2nd, 4th or 8th frame therefore still matches the ground it was rendered from,
  although that ground has moved 7-30 m per frame in ROOT axes.
- **Casters.** Cascades with `everyFrame = true` (the nearest ones, and the cockpit cascade) hold
  everything. Staggered cascades hold body-fixed casters only (terrain, rocks, site structures); vessels,
  debris and canopies never draw into them, so nothing moving is ever shadowed from a stale position.
- **Distant bodies.** When a terrain body lies wholly beyond the last camera-fitted cascade (translunar
  approach, high orbit, map view), the far cascade is refitted to that body's sunlit disc (`fit: 'body'`,
  about 1.7 km per texel for the Moon), one per visible terrain body, so crater and mountain shadows define
  the terminator from any distance. The hand-over to camera-fitted cascades on approach is continuous
  (cross-fade by cascade blend weights; no pop through 1500 km).

### 18.2 Water: far sheet and near field

- Far: the terrain renderer draws a sea-level sheet from its quadtree into the G-buffer with
  `MATERIAL_ID.water`, base colour from imagery and encoded water depth in RT2.a; deferred lighting shades
  it with `brdf_water`. Lakes and rivers that the water mask marks on terrain fragments are also deferred
  water, at every distance.
- Near: the ocean feature publishes `ocean.nearField { bodyIndex, fadeStart, fadeEnd }` (default: none).
  The terrain renderer **discards the sheet where the eye distance is below `fadeStart`**, so inside the
  near field the depth and colour buffers hold the seabed, which is what refraction, shallow-water colour
  and shore foam read (`scene.depthOpaque`, `scene.colorCopy`).
- The forward pass (`drawWater`) draws the displaced surface out to `fadeEnd`. Displacement, refraction
  and depth-based foam are fully faded out by `fadeStart`; between `fadeStart` and `fadeEnd` the forward
  surface is the same flat sea-level surface as the sheet, shaded by the same `brdf_water`, with opacity
  falling from 1 to 0 over the already-lit deferred pixel (depth compare `greater-equal` with a small
  bias). Both representations coincide before the forward one disappears: no ring, no z-fighting.
- With no ocean feature present the default near field is empty and the terrain's water is complete on its own.

### 18.3 Transparents inside the atmosphere

Transparents are drawn after the atmosphere and cloud composite, and clouds are not in scene depth. So
that a plume, an exhaust trail or a canopy behind a cloud deck is hidden by it and distant trails get
aerial perspective, the atmosphere feature publishes a camera-frustum aerial-perspective volume and the
half-resolution cloud radiance/transmittance and mean cloud distance; the core's `applyAtmosphere(uv,
distance, colour, alpha)` chunk applies in-scatter and transmittance up to the fragment, and attenuates
fragments farther than the cloud by the cloud transmittance. Every `drawTransparent` shader calls it
(per fragment, or per march sample for volumes). Defaults are neutral.

### 18.4 HDR range and exposure

- The HDR target is pre-exposed `rgba16float`. Every write goes through `writeHdr()`: clamp to `HDR_MAX`
  (60,000), NaN and negative to 0. The sun disc (1.9e9 cd/m^2) saturates there at any exposure; that is
  intended and still drives bloom. TAA and bloom sanitise their inputs as a second line of defence.
- Auto-exposure builds its histogram from lit geometry only: pixels with depth == 0 (sky, stars) and
  pixels under an absolute luminance floor are excluded. The target keeps the mean of the lit range at
  mid-grey while capping exposure so the 99th percentile of lit pixels stays below about 4x mid-grey
  (highlight protection). When less than 0.5 % of the frame is lit, exposure eases toward a photometric
  prior instead of the histogram: the sunny-16 value scaled by the sun's visibility at the camera when a
  lit body or vessel is in view, and a dark-adapted floor (stars visible) otherwise. `CameraState`
  supplies compensation, `minEv100` and interior metering.

### 18.5 Quality governor

`FrameContext.qualityScale` (0.5-1) falls when measured GPU time nears the budget and recovers with
hysteresis. Cloud, atmosphere, plume and smoke march step counts and particle counts scale with it before
the core lowers the internal resolution. Budgets (section 29) are stated and measured at scale 1 unless
the table says otherwise.

### 18.6 Simple bodies, giants and rings

- A body with a baked tile set is drawn by the terrain renderer exactly as Earth and the Moon are, at
  whatever levels its manifest promises; beyond those levels the generic amplification continues. A body
  far away is a photometric impostor from `render.meanColor` and `geometricAlbedo`, as in v1.
- A body with `surface: 'none'` is drawn by the atmosphere feature as a cloud-top sphere under its
  scattering shell. Rings are a sky-feature pass with analytic shadows both ways.
- Atmosphere parameters are per-body uniforms; several atmospheres never share a LUT set. Only the body
  whose shell the camera is in or near gets the full march; others use the far path.
- The sun disc, penumbrae and the exposure prior scale with the sun's distance.

### 18.7 Many vessels

- The vehicle feature keys presentation state by `craftId/instanceId` and takes cockpit interior, seats and
  engine clusters from the command part and the part list, never from `vehicleId`.
- Full-detail remote vessels are capped by the "other craft detail" setting; the rest draw at reduced LOD by
  projected size. Echoes draw with a dashed outline and never cast shadows into every-frame cascades.
- Presentation-only vessels (the turntable) are flagged `presentation: true`; nameplates, the map, audio
  and the network ignore them.
- Ocean wetness, plume and smoke emitters and local lights take the nearest eight vessels, active first.

### 18.8 Quality profile and UI scrim

- `QualityProfile = { pixelCap, renderScaleMin, targetFps, levels }` replaces the six fixed fields of v1.
  Each `RenderFeature` declares its settings (`FeatureQualityDecl`: levels, parameters, `live` or `rebuild`,
  a cost model, a perceptual weight). `Renderer.setQuality(profile)` applies live settings next frame and
  rebuilds a feature under a 1 s fade for the others, with no page reload. The governor's budget is
  `0.66 x 1000 / targetFps`.
- Every feature creates all of its pipelines during `init`, so nothing compiles at first ignition.
- Menu panels get their blurred backdrop from a core **scrim step** in the tonemap pass that samples the
  bloom pyramid inside rectangles published as `'ui.scrimRects'`. CSS `backdrop-filter` over the canvas is
  banned.
- `CameraState` gains `exposureHint { targetEv100, rateEvPerS }` and `lensShift`.

---

## 19. Controls and input

```
DOM events -> src/input (binding table, event.code) -> InputFrame (AxisAction / ButtonAction)
           -> ActiveController (FlightController) -> ControlInputs + PlayerCommands -> FlightSession
scripted pilot (src/pilot)  ------------------------^   same two interfaces, nothing else
Playwright: real key presses through the binding table, or window.__test.setControls / .commands
```

- `ControlInputs`: pitch, yaw, roll, RCS translation, throttle lever. `PlayerCommands`: stage, abort, SAS
  on/off and mode, RCS, legs, lights, fine control, navball mode, warp level, maneuver-node add/edit/remove,
  target, vessel cycling. Every command is reachable from a key or on-screen control.
- Key bindings are a data table. Defaults (this list supersedes `sim-design.md` section 20): pitch W/S,
  yaw A/D, roll Q/E; throttle up **Shift**, throttle down **F** (0.5 per second), full Z, cut X; Space
  stage, Backspace abort; T SAS, R RCS, G gear, U lights; **digits 1-8** SAS modes (stability, prograde,
  retrograde, normal, antinormal, radial out, radial in, maneuver); I/K J/L H/N translation; CapsLock fine
  control; `.` `,` `/` warp; M map, C camera, Tab navball mode, `[` `]` vessel cycling, F2 HUD;
  9 / 0 / `-` cycle the pages of the three cockpit displays (`mfdCycle:0..2`).
- **Browser-safe by construction.** Chrome and Edge do not let a page cancel Ctrl+W, Ctrl+T, Ctrl+N
  (close tab, new tab, new window) outside keyboard-locked fullscreen, and Alt combinations reach the
  browser menu. Therefore no default binding uses Ctrl, Alt or Meta as a key or as a modifier - a unit
  test over the binding table enforces it. On the first user gesture the input system requests fullscreen
  and `navigator.keyboard.lock()`; `InputFrame.keyboardLocked` reports the result, the HUD shows it, and
  only while it is true is ControlLeft accepted as an alternate throttle-down. Every bound code calls
  `preventDefault` (Tab, Space, Backspace, slash, F2, digits). Wheel events are non-passive and cancelled
  (Ctrl+wheel would zoom the page). The app installs a `beforeunload` confirmation while a flight is in
  progress.
- Pointer modifiers (Shift = fine, Ctrl = coarse in the maneuver-node editor) are part of `PointerState`,
  not of the key bindings, and while the map view owns the pointer (`ControlContext.pointerCaptured`)
  the flight controller ignores the throttle axis: editing a node can never move the throttle.
- The pilot implements `Pilot`; it reads only the snapshot (what the HUD and map show) and plans maneuvers
  by editing nodes and reading the predicted patches, as a player does.
- There is no API that writes vehicle state. `Sim.debug` exists for labs, increments `cheatCounter`, and is
  never reachable from `window.__test`.

Additions for v2:

- Binding tables exist per input context: `menu`, `transit`, `flight`. Only `flight` reaches the flight
  controller; switching context releases all held keys. No table uses Ctrl, Alt or Meta.
- New flight actions: `flightMenu` (Esc, P; replaces `pause`, nothing pauses), `cycleTarget` (B),
  `toggleRoster` (O), `dockingView` (V), `openQuickComms` (Enter), `acceptPrompt` (Y), and a docking control
  mode that puts translation on the main keys.
- `PlayerCommands.setTarget(ref: TargetRef | null)` with `TargetRef = { kind: 'body', id } | { kind:
  'vessel', id } | { kind: 'port', vesselId, portId }`. `NavballMode` gains `target`; `SasMode` gains
  `target`, `antiTarget` and `portAlign`. All are attitude holds.
- `setWarpLevel` is a time request; its refusal names the reason and the players that cause it.
  `cycleActiveVessel` means "take a seat in another craft I may control in my island".
- The scripted pilots drive a `FlightSession`, so the same pilot is the mission proof, the calibration
  flight and a load-test bot.

---

## 20. Views and cameras

`ViewMode` names a camera rig: `'cockpit' | 'chase' | 'map'` today, an open string so that later rigs
(EVA first and third person) need no contract change. Each is a `CameraRig` in `src/camera` producing a
`CameraState` (float64 position in ROOT, orientation, FOV, focus, exposure hints) that also carries
`kind: 'interior' | 'external' | 'map'`. Consumers (audio, HUD, exposure metering, test API) branch on the
kind, never exhaustively on the mode, so an unknown mode behaves as its kind.

- **Cockpit**: eye at the seat of **the viewer's own seated command part** (in a docked assembly each pilot
  looks out of their own craft, whoever holds the helm), free look with the mouse; the interior is ordinary
  scene geometry; `insideVesselId` switches audio to the cabin mix and exposure to interior metering. On a
  command part without a cabin the same view mode is the **sensor camera** of 9.1: never an empty frame,
  never someone else's cabin.
- **Chase**: orbits the active vessel; orientation reference follows the navball mode (surface up near the
  ground, orbit plane in space) and blends between them; never clips into terrain (uses `TerrainProvider`).
- **Map**: detaches and orbits a focus body or vessel from 100 km to 1e13 m with exponential zoom; enables a
  small fill light and an exposure floor. Focus changes come from the map view (`MapUpdateResult.focus`, a
  double click on a body or vessel); the rig receives no pointer input while the map view has consumed it.
- Switching rigs blends position/orientation/FOV over about 0.6 s (`CameraRig.activate(from)`), so the view
  changes without a cut, a loading screen or a second scene.
- LOD observers = the camera plus every vessel near a surface, so terrain under the landing gear is at
  full detail even from a distant camera.

Additions for v2 (open mode strings, no contract change): `menu` (a spectator eye in the Sun-Earth frame
above the dawn terminator), `turntable` (frames the presentation-only display vessel), `transit` (the
menu-to-pad or menu-to-ship flight with gates and exposure hints), `port` (the eye on a docking port's
axis), `spectate` (a chase camera on another player's craft), `sensor` (the first-person view of a command
part without a cabin). The map rig zooms from 1e5 m to 1e13 m. The chase rig takes its distance limits from
the vessel's bounding radius and per-craft hints in the snapshot, never from a vehicle definition, so an
assembly and a later builder design frame correctly.

---

## 21. HUD and map view

- **HUD** (`src/ui`, `Hud`): altitude/speed readouts with surface/orbit toggle, navball with SAS mode
  buttons and all markers, throttle and g meters, stage stack with per-stage delta-v, resource bars, warp
  indicator, MET/UT, heat and chute envelope indicators, node burn info, the landing-target panel
  (distance, bearing, down-range / cross-range, predicted miss) whenever `Readouts.landingTarget` is set,
  the keyboard-capture state, notifications. It renders only from `SimSnapshot` (`Readouts`,
  `NavballState`, `staging`).
- **Navball** (`NavballRenderer`): a textured 3-D sphere rotated by `qVesselToHorizon` with projected
  markers, rendered by WebGPU to a 512 x 512 texture published as `'ui.navball'` for the HUD and the
  cockpit instrument.
- **MFD pages** (`MfdPainter`): Canvas 2D painters used by the cockpit displays; they share formatters with
  the HUD so numbers never disagree.
- **Map view** (`src/map`, `MapView`): samples each `Patch` conic in float64 to sub-pixel chord error,
  draws current and planned trajectories across SOI changes (relative to the patch body's current position,
  or at-intercept using `Patch.bodyPosAtEnd`), Ap/Pe/AN/DN/SOI/impact/closest-approach markers, body orbits
  and SOI shells, surface targets (landing target, recovery-zone circles, launch site) on the bodies, the
  latitude/longitude of predicted impact and entry points, and maneuver nodes with six drag handles plus
  time dragging. All edits go through `PlayerCommands.addNode/setNode/removeNode`; the predicted patches
  come back in the next snapshot. A node may lie any number of revolutions ahead: the predictor follows a
  closed conic to the node (`Patch` contract), so "+1 orbit" never loses the planned trajectory.
- **Cockpit displays**: page selection is cockpit state behind `CockpitControls`; the app forwards the
  `mfdCycle:*` button actions to it.

Additions for v2:

- **Time strip** (top centre): UT, rate, relation to the live clock and offset, what limits the rate and
  who, the clock's members, proposals as prompt cards, and the offered actions of `TimeView`.
- **Target card and docking instrument**: `Readouts.target` (range, range rate, relative velocity in CTL,
  closest approaches, LVLH components) and `Readouts.docking` (axial, lateral, angles, roll, closing, lateral
  speed, rate, per-limit flags, phase). One Canvas-2D painter serves the HUD panel and the cockpit pages
  `target` and `docking`. Phase lamps come from server events.
- **Nameplates** are a `drawOverlay` feature that reuses the map's float64 projector, body occlusion and
  label atlas: callsign, distance, relative speed, status, and the time offset with a dashed outline for an
  echo.
- **Assembly panel, roster, prompts, ops log, quick-comms, link state**: DOM panels fed by the client
  stores. A pilot who is not helm sees who is flying; pending commands show a pending state.
- **Map**: a census layer (icons for every object of the subscribed spheres of influence, clustered),
  filters, vessel and port targets, the next three closest approaches to a target as marker pairs across
  SOI changes, a target ghost, a proximity plot in the target's LVLH frame, a preview-time scrubber, the
  jump, meet and in-phase offers, phase-angle help for an interplanetary target, a breadcrumb, and a zoom
  range to 1e13 m. Committed and forecast parts of a target's trajectory are drawn differently. Planning
  stays client-local; nodes are saved with the ship.
- Every name that is not on the viewer's clock carries its offset and the one action that would make it
  reachable.

---

## 22. Audio

`src/audio` implements `AudioEngine`; it consumes `AudioFrame { snapshot, listener, realDt, warpFactor }`.

- Graph built by a factory that accepts any `BaseAudioContext`, so the same graph renders offline in tests
  (`OfflineAudioContext`) and live in the app. Buses: `engines`, `aero`, `reentry`, `events`, `cabin`, `ui`
  into `master`; an analyser on every bus feeds `AudioProbe`.
- Sources: per-engine layered loops driven by `throttleActual`, thrust and ambient pressure (crackle and
  far-field rumble fade with pressure); aerodynamic wind and transonic buffet from `q` and Mach; reentry
  roar from `plasmaIntensity`; one-shots from events (ignition, shutdown, staging/pyro, fairing, legs,
  chute deploy/inflate, touchdown, splash, RCS pulses, explosions); cabin ambience and structure creaks
  under g-load; UI clicks.
- **Two propagation paths**: airborne (gain and low-pass cutoff scale with ambient pressure at the listener
  and with distance; silent in vacuum) and structure-borne (through the hull; always present inside the
  cabin, heavily low-passed, and faintly for an external camera attached to the vessel:
  `AudioListener.attachedVesselId`, set for rigs that follow a vessel, null for a free or ground-fixed
  camera). This is what makes vacuum "muffled" rather than mute.
- Listener = camera: cockpit vs external, position relative to nozzles (panning, distance attenuation and
  delay), all from `AudioListener`.
- Assets are generated at build time (`tools/audio`, keys from `.env`, never shipped) plus procedural
  synthesis, stored under `public/assets/audio/`, and listed in `data/defs/audio/`.
- Continuous sounds fade out above physics warp; events are suppressed during rails warp.
- The context is created suspended and resumed on the first real user gesture.

Additions for v2: buses `music` and `comms`; UI sounds and an ambient menu score generated by the existing
build-time pipeline; a relevance cut to the nearest eight vessels; sound profiles for the new engines as
data. Nothing plays before the first user gesture.

---

## 23. App shell, menu and spawn flow

Design, wireframes and visual language ("Dawn Line"): `docs/research/v2/frontend-ux.md` sections 3-5.

- **States**: `boot -> gate -> title -> hub(PLAY | HANGAR | MY SHIPS | UNIVERSE | SETTINGS | CREDITS)
  -> deploy -> transit -> flight <-> flightMenu -> leaving -> hub`, with `calibrate`, `queued`,
  `reconnecting`, `practice` and `blocked` as side states. The renderer runs from `title` on, on a preset
  chosen from the adapter class hint; the client polls the public documents from `title` on; the socket
  opens at `deploy`. `calibrate` (section 24) is entered at the first Play, or from Settings, and only when
  its data is resident.
- **Cold start is designed** (budget in 29.2): the title needs only the boot pack (10.4). While it loads
  the page shows the wordmark and a status line with real progress; while the rest streams behind the
  title the status line says what is still loading, and Play is enabled when the hangar's data is in.
- **One scene.** The menu, the turntable, pad selection, the transition and flight are the same renderer,
  loop and scene. The DOM menu sits over the live canvas at the live clock's time. There is never a video,
  a second canvas or a loading screen. Text sits on scrim-pass panels; contrast is checked over the
  brightest backdrop frame.
- **Screens**: title (live Earth at the dawn terminator, presence, feed ticker); identity (first Play
  only, with the ephemeral-profile warning before the first ship exists); hub with the lobby list; hangar
  and vehicle selection on a turntable with computed read-outs (including the first-person view kind and
  the "can reach" ladder) and an exploded stage view; site and pad selection over the live globe with pad
  states, the wait per class, local solar time, the launch-window readout and slot offers (live, cohort
  with its lead stated, window, a friend's clock); briefing and commit; My Ships (where, kept for how long
  and why, resume, track, rename, abandon); Universe ("How this universe works", rendered from
  `UniverseRules`, with the measured capacity report and the wait a player can expect at the measured
  limit); Settings; controls reference; **Credits** (rendered from `visuals/credits.json` plus the audio
  and font licences; reachable from the hub and from the footer of the block pages; a test checks that
  every source in the file appears); **Practice (offline)** (a `LocalSession` on `rules/local.json`,
  offered in the hub and in the `reconnecting` state when the server is unreachable); the flight menu,
  which overlays a live flight and states what happens to the craft if the player leaves (U16: throttle
  closed at the leave tick, then the unattended run or passive).
- **Transit** (about 10 s, skippable to 2.5 s, continuous): pull back from the turntable, dive in log
  altitude to the pad, hand over to the chase rig. Gates: the spawn is acknowledged with the vessel state,
  pad terrain is resident, the vessel's models are ready. An open gate at 3 km turns into a holding drift
  with a status line, never a stall. The path is computed in the site's body-fixed frame; exposure is
  driven by hints along it. A resume flies a log-distance arc to wherever the ship is. A refused spawn
  re-targets to the server's alternative or rises back with an explanation.
- **View models** shared with the protocol (`net.ts`): `UniverseRules`, `LobbySummary`, `PadState`,
  `ShipRecord`, `AssemblyView`, `RosterEntry`, `FeedEvent`, `TimeView`, `CapabilityReport`.
- No pause exists in a shared universe; Esc and P open the flight menu.

---

## 24. Capability gate and graphics settings

Design: `docs/research/v2/frontend-ux.md` section 9.

- **Gate** (`src/gate`, inline in `index.html`, a few KB, before the main bundle and any tile request), in
  order: mobile or tablet (`userAgentData.mobile`, UA patterns, the iPadOS rule, coarse pointer with no
  fine pointer); WebGPU present; an adapter; not a fallback adapter; required features
  (`float32-filterable`, `depth-clip-control`, `texture-compression-bc`); required limits; device creation;
  support APIs. A failure shows a static block page with the reason, what to do, and the live player count;
  the main bundle is never requested. Other desktop browsers that pass continue with a "not tested on this
  browser" banner.
- **Adapter class** is a hint from vendor and architecture only. `acquireGpu` keeps its hard failures and no
  longer throws on `looksIntegrated`.
- **Calibration** (at the first Play, or when the adapter fingerprint changes; skippable; re-runnable
  from Settings): four scripted shots (pad dawn, lift-off, LEO terminator, cockpit) through the real
  renderer, a `LocalSession` and the scripted pilot, with the governor off and per-feature GPU timestamps,
  presented full-screen as a pre-flight check with a progress line. It starts only when the tiles and
  assets its shots need are resident (they stream behind the title), so a slow mirror delays the benchmark,
  never the title. A solver picks the internal pixel cap and per-feature levels that maximise a perceptual
  weight under `0.85 x governor budget`, snaps to a named preset where it can, and confirms with a 3 s
  run. It also yields the `cpuScore` sent in hello. The calibration doubles as the warm-up of every
  pipeline. Until it has run, the title and the menu use the preset of the adapter class hint.
- **Presets** Low, Medium, High, Ultra are internal pixel caps (0.9, 1.6, 2.4, 3.7 MP) plus per-feature
  levels; Ultra keeps the v1 look. Any manual change makes the preset Custom and keeps the predicted cost
  on screen. Settings are stored per adapter fingerprint in `localStorage`; `?safe=1` starts at Low.
- **Below minimum** (Low at 0.9 MP cannot hold 33 ms at lift-off) is a warning with "try anyway", not a
  block.

---

## 25. Identity and lobbies

- **Account**: the first Play generates a non-extractable ECDSA P-256 key in IndexedDB and sends its public
  key with a chosen callsign. The server creates an account record with one `deviceKey` credential. Ships
  belong to the account, never to a credential: a later sign-in provider is one more credential row, with
  no migration and no protocol change. Nothing else is built.
- **Connect**: the server sends a nonce; the client signs `nonce || serverId || build`; the server returns
  a short-lived session token for that socket. No cookies.
- **Recovery code** (100 bits, shown once, stored as a slow hash): entering it on a new device binds that
  device's key and rotates the code. The client asks for persistent storage once the first ship exists and
  warns in an ephemeral profile before that. Ownership hangs on this path when a profile is cleared, so it
  has an acceptance test: park a ship, open a clean profile, enter the code, resume the ship; the old code
  no longer works (28.5).
- **Callsigns**: unique, case-insensitive, 3-14 characters `[A-Z0-9-]` starting with a letter, checked
  against reserved words and a word list on the server; one rename per 30 days.
- **Lobbies**: the client lists `LobbySummary` entries (one today) with region, measured round trip,
  population, rules summary and build compatibility. Admission states: `open`, `queued(position, eta)`,
  `maintenance`, `incompatible`.
- **Roster**: nearby, docked with you, everyone (paged). Block hides a player's quick-comms and name; their
  craft stays physical, and the rules screen says so.

---

## 26. Security and abuse

- A client can send only inputs, commands, time requests and subscriptions. Forged state is impossible by
  construction. Every command is checked against `craft.owner` and the helm on the island.
- Bounds at the gateway: inputs above 60 per second, commands above 20 per second, subscription churn and
  stamps beyond `clock(up) + 0.25 s` are dropped. Account creation is limited per IP address per hour;
  `X-Real-IP` comes from Railway's edge. (Load-test bots share addresses: bulk provisioning with an
  operator token is accepted on rehearsal environments and on the local stack only, never on production;
  the same switch enables the fault commands of 28.7 and the lifted admission cap.)
- Bytes are bounded as well as requests: every route that sends to the internet without admission (the
  client build, the boot pack, the mirror, the public documents, the anonymous API routes) has a daily
  egress budget and a per-address limit, and the hashed routes refuse query strings (16.2). A scraper,
  a looping client or an abuser can use up a budget, which degrades spectating or the tile fallback for
  that day; it cannot run up the bill.
- **Time requests are bounded per account** (all `UniverseRules` fields): six `Time` messages per 10 s;
  one warp proposal per 30 s and one open proposal per clock; one ask-to-advance per group per 5 minutes
  after a refusal, and one open request per group; joining an attended clock at most once per 60 s, and
  once per 30 minutes for a clock whose host forked away from that account (5.2). A client cannot hold a
  group's visitor slot, prompt its pilots continuously or follow a player it is not linked with.
- Object spam is bounded by ship slots, debris budgets, the per-lobby cap and expiry. Uninvited docking
  needs an armed port; a visitor is in free drift and can be released by the port's owner. Range safety
  protects other pads.
- Griefing that remains and is stated: ramming parked ships (allowed by the brief), parking debris near a
  station, forcing 1x for the seconds a predicted contact lasts. Parking inside someone's echo no longer
  works (U5 clears or recovers the intruder within 30 s), and nobody can be held at a rate by a stranger
  (5.2). Input automation cannot be prevented and is not attempted. All state is public by nature.
- Secrets never reach the repository or the client (section 16.2); `node tools/dev/check-secrets.mjs` runs
  in CI and before commits by packages whose tools use keys. Chat is fixed phrases (decision 51).
- The nightly audit replays sampled journals on Modal and compares hashes with committed checkpoints: a
  mismatch is a server determinism bug.

---

## 27. Observability

- Railway caps logs at 500 lines per second per replica and sums metrics across replicas, so every role
  publishes its own numbers to the directory every second: per worker step time p50/p99/max, integrated
  and armed vessel counts, lag distribution, dilated and held islands, encode time; per shard main-thread
  utilisation, resident memory and tile-store size; per gateway connections, bytes per second per tier,
  dropped frames, input lateness; directory main-thread utilisation, transitions per second, screening and
  chain time, batch commit latency, passive object count and its fill fraction, pad queue and wait per
  class, reservations granted and denied; recovery and freeze durations. While the universe is idle
  (6.2) there is nothing to publish every second: a sample is taken every 30 s and on every read of
  `/metrics`, `/ops` or `status.json`.
- **Cost numbers, and who can know which.** Every role meters itself: billed-style memory (the
  container's cgroup `memory.current`, page cache included, where a cgroup exists), vCPU-seconds, and
  egress bytes per route (sockets, public documents, the API, the client build, the boot pack, the
  mirror, dump uploads). The per-route meters are also what the daily egress budgets of 16.2 count.
  `game` writes its own accumulators to `usage_hour` (15.2) in the normal batch and reads them back at
  start, so the month-to-date figure survives rollouts and crashes. **`/ops` shows what `game` can
  measure and says so**: its own memory, CPU and egress at list prices, month to date and projected,
  each egress budget with today's use, and the triggers that are the game's own (main-thread
  utilisation, admission, players against the cap). **It cannot see** Postgres's memory and CPU (the
  second-largest idle line), `shell`, the dump job, the volume, the buckets, or the workspace's other
  project. Those come from Railway: `deploy/stage.mjs status` reads `railway usage --json` and the
  per-project split with the logged-in CLI, prints the workspace's usage and estimated bill beside the
  game's share, evaluates the 0-to-1 trigger on the workspace figure (16.2), and with `--push` posts
  that reading to `/ops` through the operator API, where it is shown with its date. `game` holds no
  Railway token.
- **No alerts are routed** (user decision). Nothing posts to a webhook or an address, and no destination
  is asked for; alerting is a forward seam (section 32). Every threshold an alert would watch (admission
  queue, p99 step time, connections, main-thread utilisation, the passive fill fraction, the projected
  spend, each egress budget, every action of the stage-3 controller) is a named metric with its
  threshold beside it on `/ops`, so a human who looks sees what an alert would have said. Railway's own
  usage e-mail is a switch in the user's account and nothing depends on it. No hard usage limit is set:
  it is per workspace and would take the game, its buckets and the other project offline. The month is
  bounded by replica limits, the admission cap and the per-route egress budgets instead (16.2).
- The API serves them as `GET /status.json` (public: players online, in flight, queue, build, rules
  version) and `GET /metrics` (Prometheus text, token-protected). An operator page under `/ops` (token)
  shows the same live.
- Railway keeps logs and metrics for 7 days on the Hobby plan (30 on Pro), so anything a report needs is
  copied into `docs/capacity/` while the run is in progress.
- Logs are structured JSON lines with island, vessel, epoch and tick; every refusal a player sees has a
  reason code that is also logged.
- `event_log` is the audit trail and the source of the public feed.
- The client's net panel shows round trip, input margin, correction count and size, bytes per tier and the
  durable tick; `window.__test.net()` exposes the same to tests.
- Each load test and each release's cost reading writes `docs/capacity/<date>.md`; the latest numbers are
  published on the rules screen.

---

## 28. Test strategy

### 28.1 Unit (vitest, Node; every commit)

Unit tests next to the code and in `tests/unit/<package>/`; cross-language golden files for the bake
library; `tools/dev/boundaries.test.ts`; the secrets check; the repository scan for stubs. Added by v2:

- Vessel codec round trip exact in every regime (ascent, touchdown with live friction anchors, entry with
  hot parts, a docked assembly), identical continuation for 6,000 steps; a blob written by the previous
  codec version and by a changed part definition decodes through the migration registry; the corpus of
  released builds decodes.
- **Island codec**: checkpoint, restore and continue at a staging tick (nascent pair), in the middle of a
  soft capture, and with a U5 pair, each bit-identical to the uninterrupted run.
- An island of one equals `stepVessel` on the tick-grid `World` bit for bit and never takes the sub-stepped
  path unless v1 would; two craft 20 m apart, in low Earth orbit and at 30 AU, crossing the integrator
  boundary in both directions gain under 0.1 mm/s of relative velocity.
- Merge then undock restores every part pose and conserves linear and angular momentum to 1e-9; every
  stage separation of the existing stack survives with contact on; the clamp weld of held ground
  structures is unchanged; two craft closing at 15.6 km/s never pass through each other at any step phase;
  capture succeeds just inside and fails just outside each envelope limit; a dock at 30 AU keeps relative
  speed noise under 1 mm/s.
- Every body of the 8.1 list within its Horizons tolerance; `validateVehicle` and `analyzeVehicle` against
  hand-computed values; the reachability table has a positive margin for every body; gate classification
  tables; the benchmark solver; each `FakeSession` scene conforms to `LocalSession`.

### 28.2 Universe suites (`tests/universe`, headless, every commit)

- **Rules**: each of U1-U19, U8b and the pad rules has a test that fails when the rule is removed.
- **Fuzz**: a model of the directory driven by thousands of random sequences of spawn, warp, jump, hold,
  attach, link, admit, reserve, claim, dock, undock, logout, crash and expiry, checking after every
  operation: heads never decrease; one holder and at most one reservation per vessel; no interaction
  between vessels on different clocks; no touch without a reservation; no claim outside a solid window or
  past a carry limit; no jump arrival with a predicted approach inside `Ra + Rb + 50 m` within 30 s; **no
  U5 pair overlapping for more than 30 s**; pad slots never overlap; vessel ids unique and never reused
  while live; no vessel solid for a clock while overlapping one that was there first.
- **Replay**: checkpoint plus journal reproduces the island hash, including runs whose journal contains
  reservation results, range-safety actions, helm grants and timer-derived inputs.
- **Lane equivalence and migration** (one input log through the real-time lane, the trailing lane in
  batches of 30 and 240 ticks, and a mid-flight migration between workers: identical island hashes) run
  where the executors live, in `tests/net/server` (`server-persistence`), and are a commit gate from wave
  5 on.
- **Adversarial cases, written failing-first**:
  - park inside a recorded echo and log out: the victim ahead never has an overlapping solid vessel for
    more than 30 s, and the intruder is cleared or recovered;
  - repeated stranger claims do not move a ship beyond `liveTick + advanceLimit`;
  - **carry limit**: dock to a parked ship at +0, take the vacant helm, propose the maximum rate: the
    clock stops at the ship's limit; enter the island of an idle or disconnected pilot and propose
    100,000x: their vessel is carried no further than its limit; ask an idle occupied group to advance
    past its limit: refused;
  - a merged assembly's limit is the minimum of its craft's limits;
  - **two islands at different ticks reach one passive station in the same wall millisecond**, at docking
    speed and as a 1 km/s impact: exactly one touches it, the other has resolved nothing against it and
    is offered a jump (behind) or hold and ask-to-advance (ahead); the same in a replay;
  - the expiry sweep, pad safing, a fate and the owner's attach arriving during a reservation;
  - a fly-by within 1 km without contact leaves the passive head unchanged and releases the reservation;
  - a guest who jumps onto a warping player's clock and requests 1x does not slow the host, and cannot
    rejoin inside the cooldown; an island that splits keeps one clock and its members stay solid;
  - a station-keeping neighbour at 100 m does not block a departure and a ram inside 30 s does;
  - a jump arriving on a crossing path is refused with the latest clean tick as alternative, and the
    chained "jump, pass, jump" completes an in-phase jump through a crowded orbit;
  - two linked pilots on crossing orbits at 100,000x are stopped by screening; a vessel that goes passive
    inside another clock's cleared interval shortens that clearance, never to a displayed tick;
  - a logout 130 s before a live-clock impact still produces the collision; an explicit leave during a
    burn closes the throttle at the leave tick; a socket lost at 10,000,000x holds the clock at the last
    stamped tick;
  - **a stage dropped by pad 1's rocket hits pad 2's rocket launched two minutes later**;
  - **a debris piece on a free-return orbit viewed and claimed at +10 days** (forecast chain across two
    sphere-of-influence changes; a viewer past the chain's end sees "not computed this far ahead");
  - a 65th vessel approaching an island at its budget still collides; fragments beyond the budget are
    merged deterministically;
  - two craft entering one port in one tick resolve identically in a live run and a replay; an SOI
    crossing during a group jump and during an island merge, with an Armed member;
  - dock, undock of the base craft alone and re-dock: ids unique, echoes intact (section 3);
  - every expiry row of 15.5, and **churn**: 50,000 distinct accounts launching once each and never
    returning, on staging rules: the passive count plateaus under the cap and no spawn is refused for the
    cap.

### 28.3 Mission (headless, `tests/mission`)

The Earth-Moon-return flight through `createSession` and the real `TerrainProvider` on real tiles, with the
gates of section 31.1, the golden hash, and zero incomplete terrain queries. The **trajectory guard**
compares attended craft and the six unit fixtures bit-exact against the recording made on the tick-grid
`World`; debris is compared by fate (impact or decay within 2 s and 500 m, or the same orbit), because its
tier changes by design.

### 28.4 Separate processes with injected latency (`tests/net`)

A harness starts the roles as separate processes **on the local stack** (16.4: host Node processes and an
embedded Postgres, in the combined shape that stage 0 deploys), a proxy that injects delay, jitter and
TCP-style stalls per client, and two to six headless `NetSession` clients driven by scripted pilots.
Matrix: 0, 50, 150 and 300 ms round trip; 0 and 5 % stalled sends of 200 ms. The rendezvous and docking,
disconnect and warp rows run once more in the split shape at 150 ms, so the transport between services is
flown before stage 2 ever needs it, and the docking row once in the launch shape (separate `api` and
`pub`, two gateways), so the stage-3 wiring has flown too. Every client finds its gateway through the
stack's endpoint document (13.1), as a browser does. Rows that kill a process or deliver a signal belong
to 28.6 and run in the pinned Linux image.
Every run records whether it started from pad spawns on a fresh database or from **seeded** vessels; a
seeded run is marked in the result table and never counts as a completion proof.

| Scenario | Passes when |
|---|---|
| Concurrent launches from six pads | All reach orbit; no cross-pad interference without contact; pad states cycle; a seventh is offered a slot |
| Rendezvous and docking, **from pad spawns, unseeded, once per latency profile** (warp only through the time requests a player has) | Hard dock within the envelope; both clients report the same port offsets to 1 mm at the event tick; momentum conserved |
| Control sharing | Hand-over prompt round trip; a vacant helm granted at once; non-helm inputs have no effect; a passenger stages their own craft; undock from each side |
| Collision at 2 m/s, 20 m/s and 1 km/s | Both clients receive the same event numbers; neither shows damage before the event; events are provisional until durable |
| **Observed flight** | Client B watches client A's ascent with staging from a neighbouring pad, and a burn at 500 m and at 5 km: B's drawn position of A against the server's state at the same tick within the bounds of 13.5 per tier; throttle and ignition within the stated delay; each staging event shown once and never reversed; each spent stage visible and continuous in chase view to impact or expiry |
| Warp | Private warp leaves the others untouched; proposal, follow, idle accept (within the carry limit), refusal with reason and alternative; in-phase jump to a station; meet at a tick; advance for a visitor; departure notice without delay; echoes never collide; two claimants of one station |
| Disconnect and reconnect | Drop mid-burn (solo: latched 10 s, then throttle closed; beside another owner: 250 ms and 2 s), mid-docking, as helm (seat reserved for the grace), **mid-warp (the clock holds at the last stamped tick)**; an explicit leave during a burn (throttle closed at the leave tick); a 200 ms stall changes nothing; resume inside the grace; the unattended run's outcome after it; a hidden tab keeps flying. Each outcome equals the flight menu's "if you leave" text |
| Prediction quality | Count and size of corrections in ascent, entry and touchdown per latency; no visible correction in solo flight at 150 ms; **zero reversals** at any latency (6.4); a late command is re-timed and counted as a correction |
| **Commit lag** (`lagCap = 2 s` profile) | Solo ascent, entry and touchdown at 150 and 300 ms with stalls: no correction for a stall shorter than the lag; the threshold watch drains the lag before touchdown; a second owner approaching a trailing island sees no pose change above tolerance on either client |
| Abusive client | Altered inputs, a fast clock, stamps in the future, withheld inputs before an encounter, floods of inputs, commands and time requests, **a warp-pinning client** (jumps onto a warping player's clock and requests 1x, re-jumps after every fork), a visitor-slot holder (ask-to-advance every 15 s): each is bounded or refused, and the victim's rate is unaffected |

### 28.5 Real browsers (`tests/acceptance`, Playwright, real Chrome, real GPU)

Two Chrome instances with separate profiles against the local stack, at 150 and 300 ms. The stories are
scripted and assert on **what each player sees** (offset labels, the single offered action, lamps, numbers
that mirror each other, zero reversals), not only on state: (1) first launch with strangers on
neighbouring pads; (2) a station built by several people **from pad spawns on a fresh database**, with a
helm hand-over; (3) two friends meeting in lunar orbit by meet-at-a-tick and by in-phase jump; (4) one
player back from Saturn finding hubs as echoes with their offers; (5) **two strangers who each warped
during ascent to different leads end up docked, and in a second run collided, using only offered
actions**. Stories 3 and 4 may start from seeded ships and say so. Plus: the menu flow by keyboard only;
the gate's block pages (and that the main bundle is not requested); transition continuity; calibration
choosing Ultra on the reference GPU; **account recovery** (park a ship, clean profile, recovery code, the
same ships, the old code dead; the ephemeral-profile warning shown before the first ship); the sensor
camera view on a craft without a cabin and each pilot's own cockpit in a docked assembly; the Credits
screen. **Frame time is asserted**: at the v2 checkpoints of 29.1 the measured browser (one at a time under
the GPU lock) holds rAF p95 under 16.7 ms and GPU p99 at or under 11 ms.

### 28.6 Restart, recovery and expiry

The restart and recovery rows run **in the pinned Linux image through docker compose** (16.4): a host Node
process on Windows cannot receive SIGTERM and is not the build that replay is defined on. They run in both
shapes: the combined `game` process, which is what production runs at stage 0, and the split, so that
stage 2 is never first exercised in production. The expiry row needs neither a signal nor a dump and runs
on the host stack.

- Graceful rollout (16.2) during an ascent, a docking approach and with a three-craft assembly parked, as
  a deploy overlap of `game` and as the ordered sequence of the split: every vessel identical by island
  hash afterwards; the burning island is held until its pilot resumes and the throttle is where the pilot
  left it; clients on the old build are told to reload and resume inside the build-change grace; the
  freeze duration is reported, and so is the peak number of Postgres connections during the overlap
  (at most 12 of the 40, 15.3).
- **The stage move, in both directions**, on a live database: combined to split (`game` drains, `dir`
  takes the lease, `sim-1` restores from the checkpoints) and split back to combined (the mirrored
  freeze). In each: every vessel identical by island hash, flights held for their pilots, the freeze
  duration reported. **The clients are given no address**: they hold the endpoint document, which the
  harness changes before the freeze as the stage script does (the new service first, the old one
  second), and they must resume on the new gateway inside the 30 s resume window. A client that needs a
  reload, or a configured address, to find the new gateway fails the row.
- **Cluster settings**: the stack and the directory refuse a database that is not UTF8 with the
  built-in locale provider; a ship name with characters outside Windows-1252 and outside Latin-1 is
  stored and read back, callsign uniqueness is case-insensitive, and a dump taken in the pinned image
  restores into the host stack's embedded cluster (`pg_restore` run from the image against it).
- **Combined shape**: a worker isolate killed during an ascent (the islands are restored by another
  isolate and replayed to the last sent frame from the surviving input buffer); SIGKILL of the
  `game` process during an ascent, a claim commit and a dock (each island back at its own durable tick,
  at most 250 ms re-run, the transition fully applied or absent).
- **Postgres restarted under a live directory**: the clocks freeze, the lease is taken again, the kept
  batch is written once, nothing is rolled back.
- **Two directory processes overlapping** (the new one started before the old one stops): the standby
  writes nothing; the old one's writes fail once the lease moves; no record is written twice.
- **Split shape**: SIGKILL of a shard during a soft capture, during an ascent, between the directory's commit of a dock and
  its acknowledgement to the shard, and during a soft capture on the live clock: at most 250 ms lost; the
  dock is fully applied or absent and never rolled back once shown; recovered islands in flight are held
  until their pilots resume and rejoin by the one-key jump; the pad crowd is mutually solid except pilots
  who resumed after the window, who are told so.
- **Split shape: SIGKILL of the directory with live shards** during an ascent with a staging split inside the lost
  batch, during a claim and during a dock: shards freeze, re-register and re-send; the split's records
  exist with the same ids; the transition is fully applied or absent; nothing is rolled back.
- A shard frozen for 5 s after its islands were recovered elsewhere has its writes, frames and events
  rejected.
- A deploy that changes a part definition with ships parked: the decode sweep migrates them; a planted
  undecodable row keeps the lobby closed and is named.
- Stop everything, restore Postgres from the bucket dump, start: every passive ship and assembly is where
  its worldline says.
- Expiry on the staging rule set with an injected wall clock: every row of 15.5, including an assembly
  kept alive by one active owner, the anchor role passing when the anchor's owner lapses, a lapsed craft
  staying attached and counting against its former owner's slots, the whole assembly becoming unowned and
  being removed whole 48 h after its last owner lapsed, and the pressure rule; the countdown shown matches
  the removal. Pad dwell, reservations and helm requests do not expire across a 40 s outage.

### 28.7 Load tests with simulated active players

The deployed proof happens on the small stage, and the larger sizes are measured in rehearsals that the
lead announces first. Three programmes, in the order in which they may spend:

| Programme | Where | Needs | What it measures |
|---|---|---|---|
| **1. Stage 0** (always run) | The deployed production stage for the two cost readings, a rollout and the cold start; a rehearsal environment in the stage-0 shape for everything that loads the server | The Hobby plan; a few dollars on Railway; Modal bots are R&D | **The idle floor** (12 hours with nobody connected) and **the cost at 5 players** (5 bots in the normal mix held 6 hours), from Railway's usage figures per service and per project and from the roles' own metrics, projected to a month by the one formula of 29.2: at or under about $30 idle and about $50 at 5 players, or the report says by how much it missed and why. The time from the first Deploy after a quiet spell to control. On the rehearsal environment: ramps of 5, 10, 20, 50, 100 and 200 bots, 15 minutes each, the upper levels with the replica limit raised to what one Hobby replica holds: main-thread utilisation of `game` per connected bot (it sets the admission caps of stages 0 and 1 and the trigger for stage 2), step time with synchronised workers (it replaces the 2.5x derating), memory as billed; **the pad cycle** on a rule set with few pads; a rollout at 20 bots and at the highest level that held; a crash of `game` and of a worker isolate at load; a Postgres restart under load; the churn run; a visitor mix sized for the stage (500 menu clients while 20 bots fly: the publisher's request and byte budgets and its stretch); **the egress budgets under a hostile client**; expiry in real wall-clock time on the staging rules; a cold start from a clean profile. The rules for these rows are below the table |
| **2. The stage-up drill and the split** | A rehearsal environment walked up the ladder | The Pro plan, so only after the lead has told the user the cost (section 30) and the user has agreed (the checkpoint below) | Every move of 16.2 timed under 50 flying bots (0 to 1, the limits, `pub` behind the CDN, 1 to 2, and 2 back to 1), with nothing lost by island hash and with bots that find the new services only through the endpoint document. Ramps of 200 and 500 on stage 2; step time with 8 synchronised workers under load; a rollout under load at 200; a forced shard kill and a directory kill at load |
| **3. The launch rehearsal** | A rehearsal environment at stage 3 | Pro; the lead tells the user first; Railway is told before the 2,000 and 5,000 runs | Ramps of 1,000, 2,000 and 5,000; **the pad-storm and launch-day mixes on the release rule set** (32 pads queueing for real); **scale-out under load** (time from the controller's trigger to K new shards taking islands, at 500 bots); a visitor mix of 5,000 menu clients while 500 bots fly; the mirror's throughput (10.4); step time with 16 and 22 synchronised workers and the memory of a 22-worker shard; a rollout at 2,000; a two-hour soak at the highest level that held |

**The checkpoint between programme 1 and the others.** Programmes 2 and 3 need the user's yes, and the
user is asked with programme 1's numbers, so the sequence is explicit. When programme 1 ends,
`deploy-loadtest` writes `docs/capacity/<date>-stage0.md` and files a request for the lead. The lead
puts OPEN_QUESTIONS Q19 to the user with those numbers and the prices of section 30 and records the
answer and its time under Q19. On a yes (and a Pro workspace) the package goes on with programmes 2
and 3. While it waits it does its other work (the stage scripts and their dry runs, the split and
launch shapes on the local stack, the production acceptance). On a no, or with no answer 48 hours after
the request, it finishes with the estimates wording; a yes that arrives later re-opens the package for
those two programmes before `final-gate` runs.

If programmes 2 and 3 have not run, the capacity report says so in its first lines: the measured limit is
the stage-0 limit, the figures for stages 2 and 3 are estimates, and their correctness rests on the split
and launch shapes of the local stack. That is an honest report and not a blocker; a game that was never
deployed is.

Rules for programme 1's rows:

- **The idle reading is a window with its wake-ups listed, not a claim that nothing happened.**
  Production is reachable by strangers, and by design a fate that falls due flies during idle. The
  report lists every wake-up in the window (fates flown, document requests, sessions) and asserts the
  idle state between them: no tick loop, one worker isolate, only the launch bodies' resident terrain.
  The reading is taken **before any bot has flown on production**, or after the bots' ships and debris
  have been abandoned and removed, so the test does not seed its own fates. An interval in which a
  stranger is connected is excluded and the window is extended to keep 12 hours.
- **Billed memory creeps**, so one reading is not enough: Postgres's page cache fills with the lease
  writes, recycled WAL and dump runs until its replica limit pushes back, and a tile store fills to its
  cap. The idle reading is taken again once every service has been up for at least 72 hours with dump
  runs in the window (by `final-gate` if the package's own window closes sooner); both readings are
  reported, and the cap-derived bound of section 30 is printed beside them.
- **The compute ramps on the rehearsal environment run with the admission cap lifted.** Stage 0 has a cap
  of 20; with it in place every bot above 20 would queue by configuration and the 50 to 200 levels
  would count nothing. Admission then comes from measured step time alone, and each row records the cap
  in force. One run at the cap of 20 shows the queue and the spectating path.
- **Synchronised-worker step time**: with 1, 2, 4 and 8 workers **while the main thread is idle** (a
  Hobby replica has 8 vCPU; eight workers under bot load beside the main thread, the database thread and
  the helpers would measure contention, not the workers), and with 1, 2, 4 and 6 under bot load. Eight
  and more under load belong to programmes 2 and 3.
- **Crashes are injected, not requested from Railway.** A service restart on Railway is a SIGTERM with
  the 45 s drain, which is the graceful path. The crash of `game` and the loss of a worker isolate use
  an operator-token fault command of the API (exit the process without draining; terminate worker k),
  which exists only where bulk provisioning exists: rehearsal environments and the local stack, never
  production.
- **The egress budgets are attacked**: one client loops on the mirror, on the boot pack and the hashed
  assets with changing query strings, and on the public documents; the report gives the bytes each
  route sent against its budget, the answer after the budget, and that players in flight were
  unaffected.

- **Bots** are real `NetSession` clients with scripted pilots, headless in Node on Modal (100 or more per
  4-core container; at most 50 containers at 5,000, leaving the workspace's headroom to the existing
  apps), against a rehearsal environment (16.2), or against production for the cost readings of
  programme 1. Each does what a player does: spawn, fly a real ascent
  with staging, circularise, **warp for coasts and transfers as a player would**; a share rendezvous and
  dock with a parked station; a share re-enter. Idle connections and HTTP requests do not count.
- **Every bot connects through the `src/net` injector** with a stated latency mix (30 % at 40 ms, 40 % at
  100 ms, 20 % at 180 ms, 10 % at 280 ms; 2-5 % stalled sends), so the correction, late-input, jitter-buffer
  and drop-superseded paths are exercised as real players would exercise them.
- **"Active" is a number.** Each level reports integrated objects per connected bot and inputs per second
  per bot, and counts only when the ratio meets the mix's target (0.75 for the normal mix, 1.35 for the
  launch-day mix). At least one bot in ten runs full prediction and checks every correction; the rest may
  replay recorded input logs with jitter, and a replay that crashes early is replaced, not counted.
- Bots read height packs through the pack source, as a browser does, and find every address through the
  endpoint document. A rehearsal environment reads the production `packs` bucket (16.2), so no run
  uploads packs. Accounts are provisioned in bulk with the operator token on rehearsal environments
  only; the five bots of the cost reading on production create ordinary accounts and abandon their
  ships when the reading ends.
- **Pads and compute are measured separately.** The compute ramps run on a load-test rule set with
  synthetic extra pads (`tests/load/rules`), so the CPU, gateway and directory limits are found
  independently of pads, and report the **compute-limited** player count. The **pad-limited** count
  needs pads that queue. The release complex (32 pads, 768 launches an hour) does not queue under the
  200 bots of programme 1 (at most about 400 launches an hour), so programme 1 runs the pad-storm mix
  on a **pad-scarce** rule set: the release cycle, dwell and safing values and 4 pads, which 100 to 200
  bots saturate. It reports the measured launches per pad per hour, the distribution of the wait from
  Deploy to control-enabled, and the bot count at which the p95 wait passes 120 s. The figure for 32
  pads is then stated as **derived** from the measured per-pad cycle, and is measured as such (reservoir
  and sustained launches per wall hour, median and p95 wait per level on the release rule set) only in
  programme 3.
- **Every ramp level** is held 15 minutes. In each programme: a soak at the highest level that held (one
  hour on stage 0, two in the launch rehearsal), with passive-object count, table and WAL size over time;
  a reconnect storm; a rollout under load (freeze duration); the **visitor mix** (menu clients polling the
  public documents and creating accounts while bots fly: publisher and API requests per second,
  connections, `pollAfterS` reached, 429s, CDN hit rate where there is a CDN, billed egress); a **cold
  start** from a clean profile at 50 Mbit/s (bytes and seconds to title and to the end of calibration).
  Mixes: pad storm, cruise-heavy, 20 % in docking pairs, the launch-day mix.
- **The balance is measured**: one ramp level is repeated with `lagCap = 2 s`, and once with 30 % of bots
  reporting a low `cpuScore`; server CPU per player, bytes per player and correction rate are reported for
  each, so `lagCap` and the weak-client threshold are chosen on data.
- **Coherence is measured.** In the launch-day and cruise-heavy mixes: the share of attended vessels that
  are solid to at least one other attended vessel, the distribution of leads, echoes against solid craft
  within 300 km, and the success rates of jump, meet and ask-to-advance. Target: at least half of attended
  vessels solid to another attended vessel in the launch-day mix. If it is missed, the fields to tune are
  the cohort bucket length, the launch range, the default of follow, `advanceLimit` and the in-phase offer;
  the report says which were changed.
- **Measured and published**: usage in dollars per service, idle and at 5 players, projected to a month,
  with the workspace's bill beside it; memory as billed per process, idle and under load, at 12 and at
  72 hours of uptime; bytes sent per route against each egress budget; step time per worker at 1, 2, 4
  and 8 synchronised workers (stage 0) and at 16 and 22 (launch rehearsal); launches per pad per hour
  and the wait distribution; peak Postgres connections during a rollout; integrated objects per worker thread
  at the admission threshold; billed vCPU-seconds per integrated vessel-second and idle CPU; main-thread
  utilisation of `game` per connected bot, and of every shard and the directory from stage 2; dilated and
  held islands; gateway CPU per connection; bytes per second per player per tier as billed; directory
  transitions, screening and chain time; Postgres batch latency; correction rate seen by predicting bots;
  players when admission starts to queue; recovery, freeze and stage-move times; cumulative spend after
  every run.
- The limit reported is the player count at which a service level breaks: more than 1 % of real-time ticks
  over 8.33 ms, a correction rate above one per player-minute, admission queueing, or a p95 wait from
  Deploy to control-enabled above 120 s. If a level fails, the report says so and gives the level that
  held.
- The stage-0 ramps run before anything larger is planned: they replace the 2.5x derating, fix the
  admission caps and the stage-2 trigger, and decide how many shards a launch day would need.
- **A claim covers only what ran.** The Railway project, the Modal environment and the stage-0 spend are
  approved (OPEN_QUESTIONS, "Answered"), so programme 1 is not optional: if the game cannot be deployed
  or the bots cannot run for a reason outside the package, the report is titled local-only, makes no
  capacity statement, and the package reports the unmet completion criteria to the user as a blocker. A
  report that stops at programme 1 makes no front-page statement beyond the estimates and the scaling
  path, and says so: in it every figure of the stage-3 bottleneck list (29.2) is either measured or
  marked "estimate" with the programme that would measure it.

### 28.8 Whole flights

Section 31.

---

## 29. Performance and capacity budgets (client: RTX 5090, 60 fps)

| Budget | Target |
|---|---|
| GPU, sum of pass timestamps at 1440p internal (4K via TAAU) | p99 <= 11 ms |
| rAF delta with vsync | p99 <= 17.5 ms, no delta >= 33 ms in steady flight |
| CPU main thread per frame | p99 <= 6 ms (sim <= 1.5 ms at 4x physics warp, quadtree + cascades <= 1 ms, uploads <= 2 ms, UI <= 0.5 ms) |
| Tile generation | 6-12 ms per tile in workers; <= 8 uploads or 2 ms per frame |
| VRAM | about 3 GB (terrain 1.1, vehicle + materials 0.6, G-buffer/history 0.5, clouds/LUTs 0.2, shadows 0.13, sky 0.1) |
| Headless full mission | < 5 min wall-clock (target 90 s) |
| Baked data on disk | < 22 GB including caches; packs <= 20 GB in their own directory; at least 25 GB of the disk free at all times |

### 29.1 GPU budget per checkpoint

One table for everybody. Milliseconds of GPU time (p99 of timestamp queries) at 1440p internal resolution
with `qualityScale` = 1 unless noted. Each package proves its own lines with a `*.perf.spec.ts` under the
GPU lock in its lab; the lead enforces the sums in the integrated app from `PerfSnapshot.features`.
(These numbers supersede the per-pass estimates in `rendering-design.md` section 13.)

| Line (owner) | Pad lift-off | Ascent 10-40 km | LEO | LEO cockpit | Lunar descent | Reentry | Splashdown |
|---|---|---|---|---|---|---|---|
| Core fixed: AO + contact 0.6, lighting 1.0, TAA 0.55, bloom 0.3, tonemap/exposure 0.2, copies + depth pyramid 0.35 (render-core) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| Terrain G-buffer incl. far water sheet (terrain-render) | 1.5 | 1.5 | 1.5 | 1.0 | 1.8 | 1.2 | 1.5 |
| Terrain shadow casting, amortised over staggered cascades (terrain-render) | 0.5 | 0.5 | 0.4 | 0.3 | 0.6 | 0.4 | 0.4 |
| Rocks, G-buffer + shadow (terrain-render) | 0.15 | 0 | 0 | 0 | 0.3 | 0 | 0 |
| Vehicle G-buffer (vehicle-pad) | 0.8 | 0.8 | 0.6 | 0.3 | 0.5 | 0.3 | 0.3 |
| Vehicle shadows (vehicle-pad) | 0.4 | 0.4 | 0.3 | 0.3 | 0.3 | 0.2 | 0.2 |
| Site structures, G-buffer + shadow (vehicle-pad) | 0.5 | 0.1 | 0 | 0 | 0 | 0 | 0 |
| Cockpit interior G-buffer + shadow + glass + display upload (cockpit) | 0 | 0 | 0 | 1.2 | 0 (1.2 in cockpit view) | 0 (1.2) | 0 (1.2) |
| Atmosphere LUTs + march + composite + aerial volume (atmosphere-clouds) | 0.8 | 0.9 | 0.9 | 0.9 | 0 | 0.9 | 0.8 |
| Clouds (atmosphere-clouds) | 0.9 (governed) | 1.3 | 1.3 | 1.3 | 0 | 1.3 | 1.2 |
| Ocean FFT + near field (ocean) | 0.8 | 0.3 | 0.1 | 0.1 | 0 | 0.1 | 0.9 |
| Sky background + probe + flare (sky-lighting) | 0.2 | 0.2 | 0.3 | 0.3 | 0.3 | 0.2 | 0.2 |
| Plumes, smoke, particles, plasma, canopies (vfx) | 1.3 | 1.0 | 0.6 | 0.6 | 0.9 | 1.2 | 0.9 |
| Navball 0.05 (flight-ui); map overlay up to 0.1, drawn only in map view (map-view) | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 |
| **Sum** (budget 11.0) | **10.95** | **10.1** | **9.1** | **9.4** | **7.8** (9.0 cockpit) | **8.9** (10.1) | **9.5** (10.7) |

"Governed" = at pad lift-off the plume and smoke volumes push the frame to its limit; the cloud march may
run at `qualityScale` down to 0.7 there (0.9 ms), which is invisible behind the smoke. Nothing else relies
on the governor to meet its line. The governor and dynamic resolution hold 60 fps if a checkpoint exceeds
its budget on a slower machine, but budgets are measured at the stated internal resolution.

**v2 checkpoints.** The table above is the single-vehicle flight. The scenes v2 adds have their own
columns, with the same owners and the same 11.0 ms budget at the **Ultra default**. Where several craft
are in view the vehicle, shadow, structure and effect lines are caps: the Ultra value of the "other craft
detail" setting and the nearest-eight emitter budget are whatever fits them, measured by
`fleet-models-pads`, not the other way round.

| Line (owner) | Menu / turntable | Transit | Pad row: 6 stacks, 3 lift-offs | Docking approach, 3-craft station | 600-part assembly | Low Mars orbit | Map, 10,000 census objects |
|---|---|---|---|---|---|---|---|
| Core fixed (render-core) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| Terrain G-buffer incl. far water sheet | 1.5 | 1.5 | 1.5 | 1.5 | 1.5 | 1.5 | 1.2 |
| Terrain shadow casting | 0.4 | 0.5 | 0.5 | 0.4 | 0.4 | 0.4 | 0.3 |
| Rocks | 0 | 0.15 | 0.1 | 0 | 0 | 0 | 0 |
| Vehicles, G-buffer, every craft in view | 0.5 | 0.8 | 1.0 | 1.0 | 1.6 | 0.6 | 0.3 |
| Vehicle shadows | 0.3 | 0.4 | 0.45 | 0.5 | 0.8 | 0.3 | 0.1 |
| Site structures | 0 | 0.5 | 0.55 | 0 | 0 | 0 | 0 |
| Cockpit or sensor-camera console | 0 | 0 | 0 | 0 (1.2 in first person) | 0 | 0 | 0 |
| Atmosphere | 0.9 | 0.9 | 0.8 | 0.9 | 0.9 | 0.7 | 0.9 |
| Clouds | 1.3 | 1.2 | 0.7 (governed) | 1.3 | 1.3 | 0 | 1.3 |
| Ocean | 0.1 | 0.6 | 0.7 | 0.1 | 0.1 | 0 | 0.1 |
| Sky | 0.3 | 0.2 | 0.2 | 0.3 | 0.3 | 0.3 | 0.3 |
| Plumes, smoke, particles for the nearest eight (vfx) | 0 | 0.3 | 1.3 | 0.3 | 0.3 | 0.3 | 0 |
| Navball, nameplates, scrim, map overlay and census icons | 0.25 | 0.15 | 0.2 | 0.2 | 0.2 | 0.15 | 0.4 |
| **Sum** (budget 11.0) | **8.55** | **10.2** | **11.0** | **9.5** (10.7) | **10.4** | **7.25** | **7.9** |

The pad row is at the limit by construction, so it is the scene the lead measures first. These columns are
asserted in the integrated app (`app-integration` packages, `final-gate`) and in `tests/acceptance`: rAF p95
under 16.7 ms and GPU p99 at or under 11 ms, one browser measured at a time under the GPU lock.

### 29.2 Multiplayer, server and delivery budgets

| Budget | Target |
|---|---|
| Real-time island step, per worker | p99 <= 6 ms of the 8.33 ms tick at the admission threshold; utilisation <= 50 % |
| Client session per frame (prediction, replay, view build) | p99 <= 1.5 ms main thread at 1x with two vessels in the island; a 150 ms replay of ten vessels <= 2 ms |
| Snapshot build for a crowded island | <= 1.0 ms p99 for 64 vessels: full part snapshots only for the vessels inside the presentation relevance cut (about 40 us each, measured), pose-only snapshots for the rest (<= 5 us each); nameplates <= 0.2 ms |
| Planning | never on the main thread above 1 ms; a heliocentric prediction up to 20 ms in the worker; the endpoint's p95 reported |
| Corrections, solo flight at 150 ms round trip | none visible; fewer than one per player-minute above tolerance; zero reversals |
| **Monthly cost of the always-on deployment** (stage 0, Hobby plan) | **One formula, used by every report.** `U` is the game's own usage: the sum of its services' lines at list prices, from Railway's per-project usage for the window, cross-checked with the roles' meters, projected to 730 hours. `U` is what the game adds to the workspace bill, because the other project already uses the plan's included $5 (measured), and it is what the estimates of section 30 are compared with: $5-15 idle, $10-25 at 5 players. **The ceilings are judged on `U + $5`**, as if the game paid the whole plan fee itself: at or under about $30 with nobody connected and about $50 at 5 concurrent players held all month. The workspace's bill, max($5, `U` plus the other project's usage), is reported beside them. Read by `platform-delivery` (idle skeleton), `deploy-loadtest` and `final-gate` |
| **Idle** (nobody connected, the last grace ended) | no tick loop; inside the process only the lease UPDATE every 5 s, a metrics sample every 30 s and the timer for the next fate. Warm level (stages 0 to 2): one worker isolate and the launch bodies' resident pyramids; `game` at or under 0.7 GB and 0.02 vCPU averaged over 10 minutes. Light level: no worker isolate and no resident terrain; at or under 0.45 GB. Postgres at or under its 0.5 GB replica limit in either |
| First Deploy after a quiet spell | warm: control-enabled no later than on a busy server (nothing is loaded at that moment); the title and the public documents answer at once, because nothing was asleep. Light (extra shards at stage 3): a worker isolate and the body's resident pyramid within 3 s (assumed 1-3 s, measured in the launch rehearsal) |
| `game` at stage 0 | 0.4-0.75 GB and at most 0.15 vCPU at 5 players (0.75 GB is the sum of the configured caps, 10.5); 0.8-1.6 GB at 50 with the limits raised; replica limit 2 vCPU / 2 GB; tile store 256 MB; main thread at or under 50 % (its measured limit, assumed 150-300 players, is the trigger for stage 2) |
| Postgres at stage 0 | replica limit 1 vCPU / 0.5 GB, so at most $5 a month of memory whatever the page cache does; `max_connections` 40; at most 4 connections per directory process and 1 for the dump; peak during a rollout at or under 12 |
| Egress budgets at stage 0 (16.2) | per day: client build 3 GB, boot pack 1 GB, mirror 8 GB, anonymous public documents 2 GB, anonymous API 1 GB, dump uploads 1.5 GB; sockets bounded by the admission cap times 6 kB/s. Worst month about $40 of egress, about $140 with every service pegged as well |
| Admission cap | 20 at stage 0 (the count the conservative projection puts at about $53 a month for the game if held all month), then the measured count; up to the measured main-thread limit at stage 1; 500 at stage 2 until a load test says otherwise; lifted on rehearsal environments for the compute ramps |
| Downstream per player | planning average 2.5 kB/s (cruise); 6 kB/s hard cap, which a launch day reaches; upstream under 0.6 kB/s. The complete census is HTTP from the publisher and is not in this budget |
| Server CPU per connected player (derived; conservative) | 0.0055 vCPU normal mix, 0.0094 launch-heavy; 0.025 and 0.043 on `hosting.md`'s figure |
| One worker thread at 50 % (derived; conservative) | 100-125 integrated objects; 16. Replaced by the synchronised-worker measurements (1, 2, 4 and 8 on stage 0; 16 and 22 in the launch rehearsal) |
| Shard and directory main threads (from stage 2) | <= 50 % utilisation with per-tick batching (about 48,000 inputs and as many frames a second per shard at 1,600 players would otherwise be most of a core) |
| Shard memory (from stage 2) | 200 MB per worker isolate; tile store 1 GB (stage 2) or 2.5 GB (launch); 7.4 GB for 22 workers (derived from the per-isolate and store figures measured on a shard of two to four workers; measured whole in the launch rehearsal), about 2 GB for the stage-2 shard (10.5) |
| One gateway vCPU (assumed) | 250-500 connections; 10,000 per service |
| Public documents | at most one generation a second, and none while nobody asks; menu clients poll every `pollAfterS` (4 s, stretched to 30 s under load). Without a CDN (the publisher inside `game` or `dir`): a budget of 50 requests a second, 429 beyond 200 (assumed), and 2 GB a day of anonymous bytes, 429 beyond it (13.1). With `pub` as its own service: 5,000 menu tabs are about 1,250 requests a second before the CDN |
| Directory | 10,000 transitions a second; 100,000 vessels in 50 MB (assumed); a reservation answered in under 5 ms |
| Rollout (deploy that affects the simulation) | universe frozen under 40 s plus the resume window (30 s, or 90 s on a build change); no committed state lost; no burn flown without its pilot |
| Crash | at most 250 ms of flight lost per island at every stage (at stages 0 and 1 a crash of the `game` process is the crash of everything, 15.4); islands back within 60 s at 5,000 integrated vessels; flights in progress held for their pilots |
| Loss of the database volume | stage 0: at most about one hour of directory state (hourly dump, off-site copy nightly); from stage 1: minutes (point-in-time recovery) |
| Stage moves | 0 to 1: seconds (a Postgres restart) or none; the switch of `game` to the CI image rides the next regular rollout and adds no freeze. The limits of `game`: one rollout. 1 to 2 and 2 back to 1: one announced freeze inside the rollout budget, and clients resume on the new gateway inside the 30 s resume window through the endpoint document, with no reload. 2 to 3, 3 to 2 and 1 to 0: none. Human time from stage 0 to the launch topology: about an hour (target; timed in the stage-up drill) |
| Scale-out (stage 3) | time from the controller's trigger to new shards taking islands: measured in the launch rehearsal, target under 3 minutes |
| Local stack | one command, one stack at a time (the launcher holds the `stack` slot for the stack's whole life); acceptance profile: servers at or under 1.5 GB in the combined shape and 2.5 GB in the split and launch shapes; load profile: servers at or under 4 GB and clients at or under 2 GB, started only with 16 GB free; Postgres ready in under 1 s after its first initialisation; the Docker VM, when a suite needs it, capped at 6 GB (16.4) |
| **Cold start** (first visit, 50 Mbit/s, cold OPFS, clean profile) | <= 25 MB and <= 8 s to the title; the rest streams behind it; calibration data (<= 150 MB) resident before the benchmark starts; calibration itself under 30 s. Owners: `capability-settings` (ordering, what is deferred), `platform-delivery` (boot pack layout). Measured against the deployed shell and bucket by `deploy-loadtest` |
| Menu DOM | 0.5 ms main thread per frame; scrim pass under 0.1 ms GPU |
| Transit | about 10 s with no frame at or above 33 ms |
| **Launch slots** | 32 pads, 150 s mean cycle: 768 launches per wall hour sustained, 258,000 in the 14-day reservoir, 276,000 in the first day. p95 wait from Deploy to control-enabled <= 120 s at the stated limit |
| Passive objects | plateau under the 50,000 cap under account churn (pressure rule, 15.5) |
| Remote vessels | full detail for as many as fit the pad-row column at Ultra; nameplates for 8 plus target, partners and own ships |

**What binds first on the ladder is money, not a machine.** Every concurrent player held all month adds
about $0.6-1.9 (derived; socket egress is 40-50 % of it and CPU about a third). In order: (a) **the
workspace's** usage reaches $20 a month, from where the Pro plan costs nothing extra and brings backups,
point-in-time recovery and deploys by digest (stage 1). The workspace's other project is $7-10 of that
(measured), so the game's share of the trigger is about $10-13: on the high estimate the game is there
with nobody connected, on the low one at about 5-9 concurrent players held all month. Stage 0 on the
Hobby plan may therefore last weeks, not months, and the user is told so before it is built
(OPEN_QUESTIONS Q2); (b) the game alone at $50 a month at about 18-70 concurrent held all month, which
is why stage 0's admission cap starts at 20; (c) the main
thread of `game` (sockets, directory, documents) at 50 % utilisation, assumed at 150-300 players and
measured by programme 1 of 28.7 (stage 2); (d) the Hobby plan's 5 GB volume, only if a retention rule
were missing; (e) 8 vCPU per Hobby replica, about six worker threads; (f) from there the order below.

Bottlenecks at stage 3, in the order they bind: (1) **launch slots**: the sustained rate is 768 per wall
hour whatever the CPU does; the cohort reservoir absorbs one front-page day and no more, and sustained demand needs pads,
sites or a shorter cycle (16.3); (2) sockets and fan-out (about a third to a half of all CPU on derived
figures); (3) real-time worker threads, only if the conservative figure is true (about 19 shard services
for a launch-heavy 5,000, about 12 with the trailing lane); note that a launch-heavy 5,000 exists only
while the reservoir lasts, so this is a one-day sizing; (4) the shard main thread, if batching is not
enough; (5) egress as a sustained cost, at the cap on a launch day; (6) memory per shard; (7) one crowded
island (single-threaded; per-island dilation and the vessel budget of 7.2); (8) directory screening and
forecast chains against a crowded low-orbit shell (estimated at 1-2 cores at 5,000 players, not measured);
(9) terrain on shards; (10) Postgres batches. The capacity report lists each with its measured number,
or marks it "estimate" and names the programme of 28.7 that would measure it: programme 1 measures the
per-pad cycle (on a pad-scarce rule set), the main thread, the workers up to 8, egress and memory at its
own scale; the 32-pad queue, 16 and 22 workers, shard memory and the directory at 5,000 players are
measured only in programmes 2 and 3.

---

## 30. Cost model

List prices (`hosting.md`, `hosting-small.md`): Railway $20 per vCPU-month, $10 per GB-month (memory is
billed as the container's memory including page cache), $0.15 per GB-month of volume, $0.015 per GB-month
of bucket, $0.05 per GB of service egress (uploads from a service to a bucket included), bucket egress and
private-network traffic free; Modal preemptible CPU $0.0000131 per core-second, with a $30 monthly
credit. The Hobby plan bills `$5 + max(0, usage - $5)`, the Pro plan `$20 + max(0, usage - $20)`: the fee
includes its own amount of usage, **per workspace**. "Low" uses the measured step and memory costs with
the 2.5x derating and the planning-average bit rate; "high" uses 0.025-0.03 vCPU per player or integrated
vessel, the 6 kB/s cap and the memory that the configured caps allow (the 256 MB tile store full, Postgres
at its 0.5 GB replica limit). Every column holds its concurrency for a whole month (730 hours), with
everything in the real-time lane, sleep-scheduled workers and the shell on Railway. Every figure of the
game is an estimate until the load test replaces it.

**What the workspace already pays (measured, `railway usage`, 2026-11-10).** The workspace holds one
other project, `haulpoint-tms`. In the billing period of 2 November to 2 December it had used $4.18 after
8 days and Railway estimates $7.40 for the period; the period before was $10.23, almost all of it memory.
No soft or hard limit is set. So the plan's included $5 is already used, and the game's usage is added to
a workspace bill of $7-10 dollar for dollar.

**Stage 0: the always-on deployment (Hobby plan, combined `game`, idle level warm).**

| Line | Nobody (low / high) | 5 players (low / high) | 50 players (low / high) |
|---|---|---|---|
| `game` memory | 0.3 GB $3.00 / 0.7 GB $7.00 | 0.4 GB $4.00 / 0.75 GB $7.50 | 0.8 GB $8.00 / 1.6 GB $16.00 |
| `game` CPU | $0.10 / $0.40 | $0.80 / $2.90 | $7.90 / $27.40 |
| `shell` memory and CPU (the boot pack is held in memory) | $0.70 / $1.10 | $0.80 / $1.20 | $0.85 / $1.50 |
| Postgres memory (high: its replica limit) | 0.1 GB $1.00 / 0.5 GB $5.00 | 0.15 GB $1.50 / 0.5 GB $5.00 | 0.25 GB $2.50 / 0.5 GB $5.00 |
| Postgres CPU and volume | $0.10 / $0.35 | $0.20 / $0.60 | $0.55 / $2.05 |
| Buckets (packs and dumps, 16-25 GB) | $0.24 / $0.38 | $0.24 / $0.38 | $0.30 / $0.40 |
| Socket egress at 2.5 kB/s / at the 6 kB/s cap | $0 | $1.64 / $3.94 | $16.40 / $39.40 |
| Client build and boot pack through `shell` (CDN all hits / all misses) | $0 / $0.50 | $0 / $1.40 | $0 / $13.80 |
| API and public documents | $0 | $0.10 / $0.50 | $0.50 / $2.00 |
| Dumps (the cron job and upload egress; hourly, every 6 hours at 50) | $0 / $0.20 | $0.60 / $1.20 | $1.00 / $2.00 |
| Modal (nightly audit and off-site copy; inside the credit) | $0 | $0 | $0 |
| **The game's usage = what it adds to the workspace bill** | **$5.1 / $14.9** | **$9.9 / $24.6** | **$38.0 / $109.6** |
| Judged against the ceilings: usage + the $5 plan fee | $10.1 / $19.9 | $14.9 / $29.6 | - |
| The workspace's bill on Hobby, with the other project at $7.4 (low) and $10.2 (high) | $12.5 / $25.1 | $17.3 / $34.8 | $45.4 / $119.8 |
| The workspace's bill on Pro (stage 1) | $20.0 / $25.1 | $20.0 / $34.8 | $45.4 / $119.8 |
| What Pro costs more than Hobby | $7.5 / $0 | $2.7 / $0 | $0 |

- **Against the user's ceilings**: the game adds $5-15 a month idle against about $30, and $10-25 at 5
  players against about $50; counted with the whole plan fee, $10-20 and $15-30. Even the bill of the
  whole workspace, the other project included, is under both ceilings on these estimates ($13-25 idle,
  $17-35 at 5 players). A realistic small pattern (5 players on four evening hours a day, idle
  otherwise) adds about $6-17 a month. The target is met on the estimates with room to spare; what is
  not met is the earlier headline of "$5-10 idle, the plan fee included", which assumed the included $5
  was free to use.
- **The high column is a bound where a cap makes it one.** Postgres memory cannot be billed above its
  0.5 GB replica limit, and `game` at 5 players cannot hold more than the sum of its caps (0.75 GB,
  10.5). The 50-player column is beyond stage 0's admission cap and assumes the limits were raised.
  Billed memory creeps as caches fill, so the idle reading is taken at 12 hours and again at 72 (28.7),
  and a short reading is never projected alone.
- **The Pro plan is close from the first day.** Billing is per workspace: usage passes $20 when the game
  alone reaches about $10-13, that is with nobody connected on the high estimate and at about 5-9
  concurrent players on the low one. Below that point Pro costs $0-8 a month more than Hobby and brings
  volume backups, point-in-time recovery, deploys by digest and 30-day logs; above it, nothing more.
  This is OPEN_QUESTIONS Q2, put to the user with these figures.
- Each concurrent player held all month adds $0.6-1.9. The game alone passes $50 between 18 and 70
  concurrent players held all month; at the admission cap of 20 held all month the conservative
  projection is about $53.
- **Dumps grow with what is stored.** A dump is about 15-30 MB at 5 players and 150-300 MB at 50; hourly
  uploads at 50 players would be 110-215 GB, $5-11 a month, which is why the upload has a daily budget
  and the interval lengthens with the dump (15.3; the 50-player line is priced at every 6 hours).
- **The worst month is bounded by configuration, not by an alert, and the bound includes egress** (16.2).
  Compute at the replica limits: about $100 if every service were pegged all month. Egress at the daily
  budgets: $4.50 for the client build, $1.50 for the boot pack, $12 for the mirror, $3 for public
  documents, $1.50 for the API, $2.25 for dump uploads, and $15.80 for sockets at the admission cap and
  the per-client cap: about $40. **So the game cannot cost more than about $140 in a month at stage 0**,
  and a month in which a scraper, a looping client or an abuser spends every budget every day costs
  about $25 more than a normal one. On the high estimate at 5 players that month is still under $50
  ($24.6, less the $3 of those lines already in it, plus $24.75: about $46). Without the budgets none
  of this would hold: one client pulling mirror misses at 200 Mbit/s is about 2 TB and $108 in a day,
  and public documents inside the request budget alone could reach $200 in a month.
- **If the bucket path cannot be used from a browser**, tiles come through the mirror and are billed:
  about $15 a month at 5 players times the bytes sent per byte needed (10.4), but never more than the
  mirror's budget of $12 a month; past it, tiles stop streaming for new visitors that day. With the
  budget the 5-player bill stays under $50 in that case too; without it, it would not.
- **A front-page day that arrives at stage 0 unannounced** (50,000 visitors, 20 admitted, the rest
  queued): compute pegged at its limits about $3.30, socket egress $0.50, and every egress budget spent,
  $0.80: **about $3-5, whatever the CDN does**. It buys 20 players a normal day and everyone else a
  title and a queue, with a live view for as long as the publisher's byte budget lasts (the first hour
  or less); absorbing the day is what stage 3 is for, and the first step up, `pub` behind the CDN, is
  ten minutes with no freeze.

**Stages 2 and 3: the split and the launch topology (Pro plan).**

| Line | 200 players (stage 2) | 500 players (stage 3) | 5,000 players (stage 3) |
|---|---|---|---|
| Simulation, gateway, directory CPU (low / high) | $30 / $110 | $65 / $260 | $575 / $2,520 |
| Memory, from isolate counts (10.5, 16.2) | $30 / $80 | $120 / $240 | $600 / $1,710 |
| Postgres, volume, backups | $8 / $25 | $46 / $70 | $120 / $250 |
| WebSocket egress at 2.5 kB/s / at the 6 kB/s cap | $65 / $156 | $162 / $389 | $1,620 / $3,890 |
| Dumps to the bucket (billed egress; every 6 hours, a dump of 0.25-1.25 GB once the lobby is near its 50,000-object cap) | $2 / $7 | $2 / $8 | $2 / $8 |
| Buckets, `shell`, `packs`, `pub` | $3 / $15 | $25 | $70 |
| Modal (audits) | $0 (inside the credit) | $0 / $30 | $30 |
| **Total (low / high)** | **about $130 / $400** | **about $420 / $1,020** | **about $3,000 / $8,500** |

- The Railway Pro fee ($20) includes $20 of usage and is not added. The shell on Netlify Pro instead adds
  about $20, $80 and $135-420 at the three levels. A rehearsal environment costs its stage's column for
  the hours it exists and nothing afterwards.
- GitHub Actions: the repository is private, so minutes are finite (2,000 a month on the free plan). CI is
  kept under 8 minutes per push with path filters, about 200 pushes a month; overage is $0.008 a minute.
- With the trailing lane on, solo downstream falls from about 2.2 to 0.4-1.9 kB/s: about $300-800 a month
  less at 5,000. The load test's A/B run replaces this estimate.
- **A front-page day served at stage 3** (5,000 concurrent for 24 hours, launch-heavy, 50,000 visitors, on
  top of a quiet month): CPU $19-143, memory $20-57, socket egress $54 at the planning average and $130
  at the cap, the rest about $10: **about $105-185 on the low CPU figure, $265-345 on the high one**. Tile
  egress is $0 on the bucket path. If that path fails on the day and tiles fall back to billed egress
  through `packs` with every request a miss, the cost is $750 **times the mirror's bytes sent per byte
  needed** (1.0 if it can proxy ranges, up to the 1.5 the pass criterion allows with slices: $750 to
  $1,125), unless the `packs` service's own daily budget, which the lead sets for the launch, stops it
  sooner. The $750 rests on 300 MB of tiles per new visitor, which is an assumption: `platform-delivery`
  measures the bytes and requests of a recorded first session (boot, calibration, title, one launch to
  orbit), on the bucket path and as bytes actually transferred in the mirror's mode, and this figure,
  the 15 TB behind it and the per-visitor figures of 10.4 are recomputed from it. Such a day is spent
  only after the lead has told the user and the deployment has been moved up.
- **Measurements and rehearsals** (28.7). Programme 1 (stage 0) costs a few dollars on Railway: the
  production readings are the deployment's own bill, and a rehearsal environment in the stage-0 shape for
  an afternoon of ramps is about $1-3 of compute and egress (it reads the production pack bucket, so no
  run uploads packs; 16.2). Its bots are tens of bot-hours on Modal (R&D, inside the credit). Programmes
  2 and 3 need the Pro plan (the workspace then pays at least $20 for the month, which is $0-8 more than
  it would have paid on Hobby) and, for one clean pass, about 22,500 bot-hours ($45-100 on Modal,
  R&D), about $30 on Railway and up to $45 of billed mirror egress when the CDN misses: **about $150 with
  no rerun, and a load test exists to fail, be fixed and run again**. The lead tells the user the figure
  before starting either, every run prints the cumulative spend, and the rehearsal environment is deleted
  when the run ends.
- **What the compute split costs**: simulating every attended vessel on the server instead of letting
  clients integrate solo flight costs $1-6 a day at 500 players and $20-100 on a 5,000-player day. The
  split was decided on authority, feel, deadlines and send rate (decision 30).
- **What the user has decided** (`user-decisions.md`; OPEN_QUESTIONS, "Answered"): about $50 a month or
  less, everything included, at about 5 concurrent players on the Hobby plan; about $30 or less when
  nobody plays; more only on measured need and only after the lead has said so. No spike reserve and no
  rehearsal budget is held in advance: each is a figure the lead states at the time. A sustained 5,000
  players is a separate $3,000-8,500 a month decision (OPEN_QUESTIONS Q6), and its launch-heavy form is
  beyond the first release's launch complex in any case (16.3).

---

## 31. Definition of done and acceptance flights

Done means a player can, in one browser session with no loading screens: launch from the pad, reach
orbit, fly to the Moon, land on real lunar terrain, lift off, return, survive reentry and splash down
under parachutes - flying every burn by hand - at 60 fps, with Earth and the Moon photoreal at every
distance (the other bodies may use the simple visuals of section 8.5, as the expansion allows), full
sound, and no placeholder, stub or TODO anywhere else. v2 adds the multiplayer, fleet, solar-system, menu
and capability requirements of 31.4, and ends with the final gate of 31.5, which re-proves all of it on the
final tree and on the deployed game.

### 31.1 Headless mission (vitest, `tests/mission`)

The scripted pilot flies `scenarios/lunar-direct` through a `LocalSession` from `createSession` (the in-process universe; start instant and every rails landing on the tick grid) and the real `TerrainProvider`
(fs tile source, real baked tiles), calling only `await sim.ready`, `await sim.terrainPending()` (whenever
it is non-null, before the next step: the terrain protocol of the `Sim` contract), `step()` /
`advanceRails()` / `peek()` / `setControls()` / `commands`. The run fails on crew loss, loss of the command
part, any NaN, a phase timeout, `cheatCounter > 0`, `scenario.startKind != 'pad'`, or
`terrain.incompleteQueries > 0`. Milestones, in order, with gates
(`sim-design.md` 16.3):

1. `LIFTOFF` - surface speed at clamp release < 0.1 m/s; inertial speed 439 +/- 2 m/s (Earth rotation).
2. `MAX_Q` 20-40 kPa, no structural failure.
3. `STAGE_SEP_1`, `FAIRING_JETTISON` (above 80 km), `STAGE_SEP_2`, each leaving debris vessels.
4. `EARTH_ORBIT` - Pe >= 160 km, Ap <= 400 km; one rails revolution matches Kepler to 1 m.
5. `TLI_COMPLETE` - predicted patches contain a Moon encounter.
6. `MOON_SOI_ENTER` at the predicted time +/- 2 s.
7. `LUNAR_ORBIT` - e < 0.05, Pe > 60 km.
8. `LUNAR_TOUCHDOWN` - inside the baked landing region: within 1,500 m of the scenario's landing target,
   where `residency().availableLevel` equals the deepest regional data level and the data was resident
   for the whole final descent; vertical < 2.5 m/s, horizontal < 1.0 m/s, tilt < 12 deg, all legs intact;
   still landed after 600 s.
9. `LUNAR_LIFTOFF` - descent stage stays behind as landed debris.
10. `MOON_SOI_EXIT`, `EARTH_PERIGEE_TARGETED` (vacuum perigee 30-60 km).
11. `ENTRY_INTERFACE` at 122 km, 10.9-11.1 km/s; peak g < 10; g-dose < 5; ablator remaining > 25 %;
    capsule RCS propellant remaining > 20 % at drogue deployment.
12. `DROGUE_DEPLOY`, `MAIN_DEPLOY` inside their envelopes, no chute failure.
13. `SPLASHDOWN` - on water inside one of the site's recovery zones (distance to the zone centre below
    its radius), vertical speed <= 9.5 m/s, crew alive, floating upright after 30 s.
14. Budgets - mission under 14 days of sim time, no negative propellant, delta-v margins logged; clearance
    between separated vessels positive for 30 s after every stage event; no simulation step above 2 ms in
    the last 60 s before lunar touchdown and before splashdown.

Re-running gives the same state hash (determinism; defined under the terrain protocol). The same pilot
also completes the mission from three perturbed starts (60 s late, 3 % under-performance, sloppy pitch
programme), each ending on water in a recovery zone. Supporting suites: Kepler/SOI/ephemeris/atmosphere
unit tests, per-stage delta-v, ascent-only, reentry corridor sweep, parachute envelope, leg drop tests,
buoyancy, SAS convergence, warp never steps past an event.

### 31.2 Browser mission (Playwright `mission` project)

`/?scenario=lunar-direct&pilot=1` in real Chrome on the RTX 5090: the same pilot, driven through
`FlightSession.advance(realDt, onControlTick)`, in real time with the allowed warp levels (about 20-25 minutes).
Short segments are additionally flown with real key presses to prove the bindings (throttle up, Space to
stage, SAS mode keys, M for the map, a node drag with the mouse - including a Shift-drag on a node handle
that must leave the throttle at 0). Judged on: the same milestone list and
gates read from `window.__test.milestones()`; `cheatCounter == 0`; `window.__test.errors` empty for the
whole flight; per-phase perf (rAF p95 < 16.7 ms, GPU p99 <= 11 ms at checkpoints taken under the GPU
lock); audio bus levels reacting at ignition, in vacuum and during reentry; screenshots at every
milestone in all three views saved for visual QA.

### 31.3 Visual and performance checkpoints

Deterministic screenshots (frozen presentation time, streaming idle) at: pad at noon and at sunset, ascent
through a cloud deck seen from the pad, 10 km, 40 km, LEO day / terminator / night side with city lights
and stars, LEO nadir close-ups over a continent by day and by night, translunar Earth and Moon, the lunar
terminator from 20,000 km and 5,000 km, low lunar orbit at low sun, lunar touchdown, lunar surface from
the cockpit, reentry peak heating, parachute descent, splashdown, a shoreline, and a climb from 2 m to
400 km over open ocean (no ring). Each has an image-statistics assertion, a perf budget, and is reviewed by eye by the
lead. A LOD pop detector flies a scripted camera path with sim time frozen and asserts bounded
frame-to-frame image difference.

**Reference images.** Statistics alone cannot show that three reworks of the renderer (the wave-3 sweep,
the quality plumbing of wave 4, the generic terrain path of wave 5) changed nothing. Before wave 3 the lead
records a reference PNG of every checkpoint in deterministic mode on a fixed site-data snapshot into
`data/baselines/` (git-ignored, with a tracked manifest of hashes), and a compare helper in
`tests/browser/harness.ts` reports mean absolute difference and the 99.9th percentile against a
per-checkpoint tolerance. The comparison is a gate of `presentation-sweep`, of `capability-settings` at
Ultra, of `bodies-activation` and of `planet-render`. Re-recording a checkpoint needs a note signed by the
lead; the pad scenes are re-recorded once, when the new pads and their flatten discs land.

**The new pads.** A player may spawn on any of 32 pads, so the ground is looked at there too: at one pad
per class at each site, in the integrated app: ground level at local noon and at low sun, 300 m up, and the
lift-off perf column; with image-statistics assertions, a flatten-disc seam check, the shoreline and the
near ocean in frame where the pad is coastal, and review by eye. Owners: `planet-render` (terrain, ocean),
`fleet-models-pads` (structures); the lift-off budget must hold at Madrakah on its 30 m data.

**v2 scenes** with screenshots in all three views: a heliocentric cruise at 1,000,000x, a Mars arrival and
capture, the rebase at a sphere-of-influence change (no visible step), the menu and turntable, the pad row,
a docking approach, the sensor-camera view.

### 31.4 Flights and demonstrations added by v2

- **The Earth-Moon-return mission through a socket**: the scripted pilot as a `NetSession` client against
  the local stack at 150 ms, spawning in a launch-window slot, with the same milestone gates evaluated on
  the server as objectives.
- **Interplanetary flights into orbit**, headless, by the transfer pilot: `meridian-albatross` from a pad
  to a bound capture ellipse about Mars under private warp, ending with the server's record showing a
  closed orbit; an arrival at Neptune at 10,000,000x that **ends in a bound capture ellipse on the
  server's record**, proving that the event clamps hold at the top level; and, on `LocalSession`, into
  orbit of one inner planet, one giant's moon (Titan or Callisto), one tiny moon (Phobos), and one
  **refuelled profile** (depot dock, propellant transfer, departure to a body beyond the cruiser's
  unrefuelled reach).
- **The reachability table** (8.1) with a positive margin for every body.
- **Concurrent launches, rendezvous, docking, undocking, collision, warp, disconnect and reconnect between
  separate clients under latency** (28.4, 28.5), with the docking proofs from pad spawns and unseeded;
  **restart recovery and expiry** (28.6); **measured load limits** (28.7).
- **Deployed**: the public lobby on Railway at stage 0, with freely selectable vehicles, persistent ships
  and assemblies, the menu, and automatic graphics setup. Production runs `rules/default.json`. A scripted
  two-browser run **against the production URL** spawns two vehicles from pads, docks them, logs both out,
  rolls a simulation deploy, resumes both and finds the assembly intact (record ids and island hash from
  `/ops`), then undocks; the pack list and tiles load from a clean profile. The URL, build id, rules
  version and results are recorded. Expiry is demonstrated in real wall-clock time on a rehearsal
  environment running the staging rule set. **The deployed stage projects, from measured usage and by the
  formula of 29.2, to about $30 a month or less idle and about $50 or less at 5 concurrent players**
  (28.7, programme 1).

### 31.5 The final gate (wave 7)

Nothing is done until it has been proven on the final tree, after wave 6 has changed the simulation, the
universe, the client and the server. The `final-gate` package:

1. Re-runs 31.1, 31.2 and 31.3 (reference images, pop detector, budgets) on the final tree.
2. Flies the **Earth-Moon mission in real Chrome through `NetSession`** against the local stack at 150 ms,
   with the perf and audio assertions of 31.2: the path a player actually uses.
3. Flies the **Mars transfer in real Chrome** with screenshots in all three views at departure, in
   heliocentric cruise at 1,000,000x, at sphere-of-influence entry and at capture, with the pop detector
   and the frame-time assertions.
4. Runs the production acceptance of 31.4 on the final build, and reads the cost again: two hours idle
   and two hours with 5 bots on production, projected to a month against the two ceilings by the formula
   of 29.2, with the memory lines of services that have been up at least 72 hours beside the earlier
   readings (28.7).
5. Runs the repository scan (`TODO`, `FIXME`, `stub`, `placeholder` outside the allowed simple-body data)
   and the secrets check.
6. Produces one results table with a row per line of `PROMPT.txt`, naming the test or demonstration that
   proves it and its result. A line without proof is reported to the user as not done. If the game is
   not deployed or programme 1 of the load test did not run, the table says "not deployed" and lists the
   completion criteria that are therefore unmet, as a blocker for the user, not as a pass on the local
   stack. The capacity row quotes the measured stage-0 limits, gives the pad limit as the measured
   per-pad cycle with the 32-pad figure marked derived unless programme 3 ran, and states which of the
   larger stages were rehearsed and which are estimates.

---

## 32. Forward seams (named only; nothing here is built)

| Later feature | The seam that exists |
|---|---|
| **Ship builder** | `VehicleDef` is the craft file; `uses`, node kinds, `surfaceAttach`, `symmetry` and `validateVehicle` are the builder's rules; colliders give the overlap check; `analyzeVehicle` gives every read-out; `craft.design` stores a design per craft; the server validates a design with the same functions before spawning it; the hangar's vehicle list takes designs as one more source; stage groups can be derived as the regions between decouplers and closed ports. |
| **EVA** | An astronaut is a vessel of one craft with a suit part (`command` with one seat, an `rcs` module); `command.hatch` is where it appears; `transfer.crew` on ports is the same crew move indoors; islands already hold several small vessels; `ActiveController` takes an `EvaController`; camera rigs are open mode strings; an astronaut is one more LOD observer and one more nameplate. The six v1 seams otherwise stand. |
| **Landing on other bodies** | Legs, probes and contact are data and work on any body with terrain; the planet bake deepens a pyramid with levels and regional rectangles; shards read whatever height packs exist; a site is data with a `bodyId`, so a surface base with pads is a `LaunchSiteDef` on another body. |
| **Science, resources, career** | New `ModuleDef` members and `ResourceDef` entries; flow groups, transfer and cross-feed already move any resource; objectives are generic triggers attached to a craft; the hub takes more tabs. |
| **Low-thrust propulsion** | A rails segment kind beside `conic` and `at rest` in the worldline (constant-acceleration arc), evaluated in closed form by the same clock schedule. |
| **Rovers and surface docking** | Wheels are a module; an assembly can rest on a surface because it is a vessel. |
| **More lobbies and regions** | The lobby is the unit of deployment; the client lists lobbies; a region is a lobby, deployed at whatever stage of 16.2 it needs. |
| **Alerting** | Every number an alert would watch is already a named metric with its threshold: the stage triggers, the service levels, the projected spend, the controller's actions (section 27). A router would read `/metrics` or the directory's per-second numbers and post to a destination. No router, webhook or address exists today, by the user's decision. |
| **Other sign-ins** | A credential row of another kind on the same account. |
| **Client-held authority** | Not a seam. The holder is the directory or an island; nothing else is defined. |
| **Free-text chat** | The `comms` audio bus and the quick-comms channel message; a text channel would be one more message kind with its own moderation tools. No rules flag exists for it today. |
| **Cabins for the Albatross habitat and the Atoll** | `command.cockpit` on the part; the sensor-camera view is replaced per part when an interior exists. |
| **Transfer-window grids, moon-tour searches** | The API's planning endpoint and Modal batch jobs; the same answer for everyone at a tick is computed once and cached. |
| **Gamepad** | The menu's focus model is spatial. |

---

## 33. Work packages

The briefs are in `docs/WORK_PACKAGES_V2.json`; the order that keeps the tree green is in
`docs/MIGRATION_V2.md`. Sub-waves run in order; packages inside one run in parallel on disjoint paths.

| Wave | Packages |
|---|---|
| 3.0 (lead) | `lead-baseline-v2`: the v2 contracts, root configuration and dependencies, boundary rules for every new directory, reference images, the pre-change mission baseline |
| 3.1 | `sim-core-v2` (tick grid, trajectory guard, vessel and craft model, versioned codec, `World` speaking v2, site model), `bodies-ephemeris`, `planet-bake`, `site-bake`, `platform-delivery` (packs, boot pack, CI and the image, the local stack, the stage-0 skeleton on Railway, first cloud measurements) |
| 3.2 | `presentation-sweep` (every presentation consumer once, `FakeSession`, frame rebase, the tile-source seam in workers, the scrim step and exposure hints, `src/app` for the sweep) |
| 4.1 | `island-core`, `wire-protocol` (with the session layer), `solar-system-sim`, `fleet-data`, `shell-menu`, `capability-settings` |
| 4.2 | `universe-directory` (directory, clocks, rules, screening, pads, expiry, `UniverseHost`, `LocalSession`) |
| 4.3 | `session-switch` (gated: `createSession` returns `LocalSession`; `World` is deleted) |
| 4.4 | `bodies-activation` (the Sun-rooted body set goes live) |
| 4.5 | `app-integration-1` (shell, calibration and the browser mission on `LocalSession` in `src/app`) |
| 5.1 | `contact-docking`, `server-persistence`, `netcode-client`, `planet-render`, `fleet-models-pads` |
| 5.2 | `net-joint-gate` (one real client against the real server on the local stack), `map-multiplayer`, `flight-hud-multiplayer` |
| 5.3 | `app-integration-2` (`NetSession`, reconnect states, stores and the pack source in `src/app`) |
| 6 | `deploy-loadtest` (stage 0 deployed, the stage scripts, the cost readings and the load programmes), `acceptance-multiclient` (on the local stack) |
| 7 | `final-gate` (31.5) |

The lead reviews between sub-waves, answers contract requests, applies the root-configuration changes the
next sub-wave needs, reads the platform measurements of wave 3 before the sizing decisions of wave 5,
tells the user before any step that needs the Pro plan or raises the standing spend (16.2), and
play-tests the time rules between waves 5 and 6.

---

## 34. Main risks

| Risk | Mitigation |
|---|---|
| No capacity or cost number is measured | Programme 1 of the load test runs on the deployed stage 0 before anything larger is planned; every figure in sections 29 and 30 carries a low and a high value and the report replaces them; the larger stages are measured in rehearsals the lead announces first, and until then the report calls them estimates |
| The always-on bill exceeds what the user set (about $50 at 5 players, about $30 idle) | Stage 0 on the Hobby plan, idle with one warm worker; the estimates ($5-15 idle, $10-25 at 5 players, added to the workspace bill) leave room under both ceilings; billed memory is the largest line and its caps are what the high estimates assume (a 256 MB tile store, Postgres limited to 0.5 GB), measured as cgroup memory in the pinned image before deployment and on Railway in wave 3, at 12 and at 72 hours; the projection from measured usage, by one formula (29.2), is an acceptance criterion of `deploy-loadtest` and `final-gate` |
| The bill is run up by someone who is not a player (a scraper, a looping client, an abuser), with no alert and no hard limit | Replica limits bound compute; every route that sends bytes without admission has a daily egress budget counted in process, a per-address limit and no query strings on hashed routes; the worst month is stated ($140, of which $40 egress) and the budgets are attacked in the stage-0 load programme (16.2, 28.7) |
| The workspace is shared with another project, so the Hobby plan's included usage is gone and the Pro break-even is near | Measured before building ($7.4-10.2 a month for the other project); every plan trigger is read from the workspace's usage, not from the game's own metrics; the choice between Hobby and Pro from the first day is put to the user with the real premium of $0-8 a month (OPEN_QUESTIONS Q2) |
| Launch slots bind long before CPU | Sized from a launches-per-day target (decision 54): 32 pads, a 14-day cohort reservoir; pad wait is its own service level; the load test finds the pad limit and the compute limit separately; the scaling path names pads, sites and cycle with numbers |
| The sky is mostly echoes after the first warp | Live clock, range rule, cohorts, follow, meet, in-phase jump, U8b; coherence is measured by the load test with a target and named tuning fields; an acceptance story for two strangers at different leads; a play-test with a written result (Q7) |
| A front-page day arrives unannounced while the game is at stage 0 | Accepted and stated (16.2): it is not absorbed automatically and nobody is alerted. The admission cap holds the players, the menu queues and shows the rest for as long as the publisher's byte budget lasts, every public byte source has a daily budget, and the day costs about $3-5. The way up is scripted, rehearsed and timed (about an hour of a human's time to the launch topology); an announced launch is moved up the day before; from stage 3 a controller scales inside a pre-approved ceiling |
| The small stage and the large one drift apart | One program, one role schema, one database schema, one implementation and one owner per role (the publisher included); the combined and the split shapes both run in the suites of 28.4 and 28.6 on every release, with a smoke of the launch shape; the stage move is a tested rollout in both directions (28.6), with clients that find the new gateway only through the endpoint document, and a timed drill (28.7) |
| Touchdown is where client and server can disagree visibly | Threshold watch drains lag; exact contact state on the wire; outcomes only on the server's event; its own tolerance tests |
| The refactor lands on a moving tree | The tick grid moves first, on `World`, in its own guarded step; the guard is bit-exact for attended craft on the tick-grid `World`; contracts are the lead's pre-wave step; the sim side and the presentation sweep are separate packages; `LocalSession` is built beside `World` and the switch is a gated step with the other packages' flight suites as its gate |
| Wave-2 pixels drift through three reworks | Reference images recorded before wave 3 with a compare helper as a gate of every package that touches the renderer |
| Lanes and hand-overs add states | One step loop; `lagCap = 0` first; hand-overs and reservations are fenced in memory and off the input path; no island steps past a pending merge or into an unreserved copy; lane-equivalence and fuzz suites are commit gates; the deferred lane holds no attended vessel |
| The directory is a single writer and a single point of failure | It does event-driven work only; it holds a fenced lease, so a second process cannot write. From stage 2 its crash freezes the universe for its restart time while shards keep their state and re-register, losing nothing. At stages 0 and 1 it shares the `game` process, whose crash re-runs at most 250 ms per island (15.4). Partitioning is on the scaling path |
| The database at stage 0 has no platform backup | Hourly dumps to their own bucket (a different storage system, with a credential no public-facing process holds), a nightly copy off Railway, a restore test from the dump (28.6); the recovery point of about one hour is stated; stage 1 brings backups and point-in-time recovery, and the user may ask for it from the first day (OPEN_QUESTIONS Q2) |
| Stored ships meet changed definitions | Versioned codec with part fingerprints, a migration registry, a decode sweep before the lobby opens, a corpus of every released build in CI |
| Server memory per isolate, and memory billed while idle | Lazy per-body residency, worker isolates on demand, one shared tile store per shard, no disk cache of packs (page cache is billed), a per-worker budget, memory as billed in every load-test report |
| Bucket throughput under concurrent ranged reads is unproven | Measured in wave 3 by a Modal fleet with pass and fail numbers (free on the Railway side); the `packs` mirror behind the shell's CDN is the fallback (ranges or small slices, chosen by measurement and judged on bytes sent per byte needed), with a daily budget so that a broken bucket path degrades tile streaming before it raises the bill; the escalation outside the three providers is written with thresholds; the OPFS cache keeps return visits off the network |
| The first minute of a front-page visitor | A 25 MB first paint and an 8 s title budget; the boot pack reaches `shell` from the bucket at start, verified by hash, with the health check waiting for it; calibration behind the title; neither depends on `game`; measured from a clean profile against the deployed shell and bucket |
| Determinism is tied to one V8 build and CPU architecture | One image definition with Node pinned by digest for shards, tests and audits; a `buildId` checked at every rollout while Railway builds the image (stage 0) and one artefact by digest from stage 1; journals are build-bound and checkpoints are not; a Node upgrade is a re-baseline |
| Railway restarts on every deploy and overlaps old and new | A rollout script (one `game` hand-over at stages 0 and 1, the ordered sequence at one digest from stage 2); a 45 s drain window instead of the default of none; the directory lease; gateways last; the freeze is measured and stated |
| The local stack differs from production | Real Postgres 18 in both, created with the same encoding and locale (UTF8, the built-in C.UTF-8) and refused otherwise; the restart, recovery and replay suites and the image smoke test run in the pinned Linux image; clients find the roles through an endpoint document, as in production; the cold-start rows load a production client build from `shell`; the deployed proofs run on the deployed stage; a local result is never reported as a deployed one |
| The local stack overloads the machine that once crashed | The launcher holds the one `stack` slot for the stack's whole life, so no second stack and no Docker VM starts beside it; stated memory bounds per profile; the Docker VM capped at 6 GB; rows that do not fit (a 22-worker shard) are derived here and measured in a rehearsal |
| WebSocket over TCP in one region | Prediction hides stalls up to 500 ms; docking is slow by design; a quarter second of round trip in Asia and Australia is stated |
| Ground-level realism at 32 pads on two sites; clouds, tiles, corridor, landing data (v1 risks) | Arid coastal sites, landcover-driven detail, one march path, lifting capsule with roll rule, NAC region with calibrated procedural detail; checkpoints at one pad per class per site; the Madrakah fall-back of Q8 |
| Frame over budget with several launches in view | The v2 budget columns sum to 11 ms at the Ultra default with the vehicle lines as caps; other-craft detail is what fits; frame time is asserted in the integrated app and in the two-browser stories |
| Not every body is reachable by the fleet | A generated reachability table that fails the build; the refuelled profile is flown; exceptions go to the user (Q17) |
| Disk space on the development machine | Baked data is capped at 22 GB, packs at 20 GB in a separate deletable directory, 25 GB kept free; raw downloads are deleted after a bake |
| The plan completes without ever deploying | The Railway project, the Modal environment and the stage-0 spend are approved; the stage-0 skeleton is deployed in wave 3; `deploy-loadtest` and `final-gate` report "not deployed" as a blocker, never a local-stack pass |
