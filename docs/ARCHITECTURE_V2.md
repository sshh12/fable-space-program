# Architecture (v2)

Definitive architecture for the true-scale, multiplayer solar-system spaceflight simulator. `PROMPT.txt`
(both halves) is the binding requirement; `docs/research/v2/user-decisions.md` records the user's decisions
and overrides any research recommendation. The documents in `docs/research/` and `docs/research/v2/` are the
detailed designs this file builds on. **Where a research document or a proposal disagrees with this file,
this file wins.** Where this file is silent, the research document for that area applies (`sim-design.md`,
`rendering-design.md`, `earth-data.md`, `moon-sky-data.md`, `webgpu-harness.md`, and from v2
`fleet-docking.md`, `solar-system.md`, `frontend-ux.md`, `hosting.md`).

This file replaces `docs/ARCHITECTURE.md` (v1) when wave 2 ends. Until the lead swaps it in, v1 stays binding
for wave 2. `docs/MIGRATION_V2.md` says how the code moves from v1 to this design; the remaining work is in
`docs/WORK_PACKAGES_V2.json`; decisions that are the user's are in `docs/OPEN_QUESTIONS_V2.md`.

How numbers are marked: **measured** = taken from `docs/research/v2/codebase-audit.md`, a hand-off or
`frontend-ux.md` (one Ryzen 9950X3D core, Node 24); **derived** = arithmetic on measured numbers and list
prices; **assumed** = a planning value that the load test (section 28.7) must replace. No capacity or cost
figure in this file has been measured on Railway. The cloud derating used is 2.5x (assumed).

---

## 1. Decisions

### 1.1 Decisions of the v2 design

| # | Topic | Decision | Why |
|---|---|---|---|
| 29 | Authority | The server alone advances and commits vessel state. A client sends stamped control inputs, discrete commands and time requests; it never sends state, a trajectory or a result. There is no client authority holder and no hook for one. | "Server-authoritative state, no client-only outcomes." The three proposals' own numbers put the CPU difference at tens of dollars on the busiest day (section 30); soundness decides, not cost. |
| 30 | Compute balance | One step loop, three schedules. The server simulates every vessel that is not on rails, from the pilot's stamped inputs, in **islands**. Islands that another owner can reach run in real time. A single-owner island may run up to a **commit lag** `L` behind its pilot. `L` is capped at 0 in the first release (everything real time) and raised only after the lane-equivalence tests pass. Work that is the same for everyone (screening, census, pads, fates) runs once on the server; work that is a pure function of replicated state (snapshot, readouts, patches, planning) runs on the client. Section 6. | Gives single-player feel for a pilot alone, full authority, an invisible hand-over when a second player appears, and overload that degrades invisibly first. |
| 31 | Time model | Per-vessel head time on one universe axis, forward only; server-owned clocks (live, cohort, private, shared); a passive vessel is timeless inside its **solid window**; interaction only on one clock; echoes for everything else. Canonical time is an integer tick of 1/120 s. Section 5. | The only family that gives private warp without a global warp control or merged timelines. |
| 32 | Unit of simulation | An **island**: the vessels of one clock that could touch within seconds, stepped together on one thread in one local frame. A vessel alone is an island of one. Single-player flying is an island of one in an in-process universe. | One execution path for tests, offline play, the client replica and the servers. |
| 33 | Vessel model | A vessel is a forest of craft trees joined by dock links: `Vessel.crafts[]`, `Vessel.links[]`, `Vessel.helm`. Parts are addressed `craftId/instanceId`. Stage stacks, abort sequences and lend policies belong to the craft. Section 7.2. | Docking, universe-unique ids, persistence and a later ship builder all need this one change. |
| 34 | Docked control | One helm with explicit hand-over, plus craft sovereignty: every owner keeps their own stage stack, ports, pumps and lend policy, and either side of a port can always release it. Section 7.5. | Clear, predictable, and no docking takes a station from its builders. |
| 35 | Damage | A part is intact or destroyed; a joint is intact or broken. No health values. | One rule on the ground and between vessels; nothing to desynchronise. |
| 36 | Bodies | The body system is rooted at the Sun: Sun, eight planets, 20 moons, Ceres, Pluto and Charon (30 bodies), three levels. Planet elements are JPL mean elements with secular rates; Earth keeps the Almanac formula (inverted) and the Moon its frozen ellipse so the lunar mission's windows are unchanged. Section 8. | "Entire solar system at true scale, real orbits." |
| 37 | Simple bodies | Every solid body enters the existing tile pipeline as a small pyramid baked by one config-driven tool; giants are a cloud-top map plus an atmosphere shell with no surface. No second terrain code path. | Placeholder visuals are allowed off Earth and Moon; landing later is deeper levels from the same tool. |
| 38 | Presentation frame | Positions handed to presentation are relative to the **render root**: axes J2000 equatorial, origin near the viewer (`SimSnapshot.frame`). The field names `rRoot`, `positionRoot`, `posRoot` are kept; "ROOT" now means the render root, never the Sun. Section 3. | A heliocentric float64 origin gives millimetre jitter in a cockpit at Neptune; 543 read sites keep compiling. |
| 39 | Presentation contract | `SimSnapshot` stays the only thing presentation consumes, and is built on the client from replicated island state. `Sim` becomes `FlightSession` with two implementations: `LocalSession` (in-process universe) and `NetSession` (network replica with prediction). `createSim(defs, scenarioId, { terrain })` stays and returns a `LocalSession`. | About 190 singleton read sites and every lab keep working; the app loop is written once. |
| 40 | Warp table | `WARP_LEVELS` gains 1,000,000x and 10,000,000x (nine rails levels). Rails altitude limits default from the body radius. | Neptune is a 2.7 h cruise at 100,000x. |
| 41 | Low thrust | No ion or electric propulsion. The high-Isp stage is nuclear thermal. Thrust on rails is a named seam (section 32). | Patched conics, nodes and rails warp cannot express months of thrust. |
| 42 | Protocol | Binary WebSocket, inputs up, state down. Exact keyframes, deltas against the last keyframe, structural changes as deterministic operations, coasting craft as conic elements on change. Section 13. | Railway has no UDP; latest-wins messages would also survive datagrams. |
| 43 | Persistence | Postgres, written only by the directory, in 250 ms batches. Islands are durable through checkpoints plus an input journal, replayed exactly on one pinned build. Transitions that involve two owners are committed before they are shown. Section 15. | A deploy is a lossless restart; a dock can never be half-stored. |
| 44 | Expiry clock | The wall clock. A ship is kept 14 days after its owner's last session; an assembly lives as long as its most recently active owner. All numbers are fields of `UniverseRules` and are shown to players. | Universe times differ by centuries between vessels; the wall clock is the only one all share. |
| 45 | Hosting | Railway hosts everything at run time (gateways, directory, shards, API, Postgres, buckets, the static shell). Modal hosts bots, bakes, audits and burst batch work in its own environment. Netlify is an optional host for the shell only, configured but not required. One region, US East. Section 16. | Only Railway holds long-lived sockets cheaply; a Railway static service needs no extra credential. |
| 46 | Tile delivery | The bake output and the dev server stay plain files. Production serves content-addressed range-readable **packs** from a Railway bucket through presigned URLs, with a CDN-fronted mirror service as fallback. Revises row 4. | 862,000 files cannot be addressed one presigned URL at a time; 15 TB in a day must not be billed egress. |
| 47 | Identity | Anonymous by default: an account record that a non-extractable device key points at, a callsign, a recovery code. Other sign-ins are more credential rows later. Nothing else is built. | User decision. |
| 48 | Lobbies | The lobby is the unit of deployment (one directory, one shard set, one Postgres schema). One public lobby exists; the client lists lobbies. | "Build around lobbies, one mega-lobby for now." |
| 49 | Front end | One scene, one renderer, one loop from the menu to flight; the menu is DOM over the live canvas; the app shell is a state machine. Section 23. | "Menu over a live Earth and space view, seamless transition." |
| 50 | Capability gate | An inline script blocks mobile and unsupported devices before the main bundle loads; adapter class is judged by a benchmark on the real renderer, not by name. Settings are declared by features. Section 24. | The adapter name is empty in production Chrome. |
| 51 | Chat | Quick-comms (fixed phrases) only. Free-text proximity chat is behind a rules flag that is off (OPEN_QUESTIONS Q9). | An anonymous free-text channel at front-page scale is a moderation job nobody has taken on. |
| 52 | Rules are data | Every number of sections 5, 7.4-7.6, 9.4 and 15.5 is a field of one versioned `UniverseRules` document served to clients, which render the rules screen and every countdown from it. A staging rule set with lifetimes of minutes demonstrates expiry. | "Configurable, visible to players." |
| 53 | Accepted inconsistencies | (a) An object launched at an earlier time is not collided against histories already committed. (b) Two passive vessels never collide with each other. (c) After a private warp a player is alone in their time until someone jumps, holds or arranges a meeting. All three are stated on the rules screen. | They cannot be designed away in any forward-only model; hiding them would be merging timelines. |

### 1.2 Decisions carried over from v1

Rows 1-28 of the v1 table. Rows revised by v2 are marked "(v2)".

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Launch site | **Ka Lae Pacific Spaceport LC-1**, Ka'u coast, Hawai'i, nominal 19.10 N 155.50 W (`data/defs/sites/ka-lae.json`, pad `lc-1`; (v2) the site has eight pads and a second site exists, section 9.3; exact pad coordinates are snapped to real terrain by the Earth bake). The Florida site in `earth-data.md` is dropped. | Latitude below the Moon's 20.9 deg orbital inclination gives a coplanar launch twice a day, so TLI needs no plane change. Arid lava coast looks real at ground level without vegetation geometry. USGS 10 m elevation and Sentinel-2 imagery cover it. |
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
| 15 | Threads (v2) | Client: the session (prediction, about 0.1 ms per step) and the view builders on the main thread; terrain tile generation in a worker pool; long predictions in a planning worker; socket keep-alive in a worker; audio in the audio thread. Server: one isolate per shard worker thread; gateways are separate processes. Section 17.2, 16.1. | Determinism and simplicity on the client; `src/sim` keeps module-level scratch state, so one isolate per thread on the server. |
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

Every directory has exactly one owner per wave. Owners are the work packages of
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
index.html, src/app/           app entry and final wiring (lead)
src/gate/                      inline capability gate and block pages (no imports from the rest of src)
src/core/                      contracts, f64 math, cube mapping, tile codec, def loader and validators,
                               GPU acquire, test-API base, FakeSession
src/sim/orbit|frames|bodies|nav/     orbital mechanics, ephemerides, atmospheres, navigation maths, screening
src/sim/vessel|dynamics|control/     vessel and craft model, codec, forces, staging, thermal, colliders, SAS
src/sim/island/                the island: N vessels on one tick grid; per-vessel state machine, contact and
                               capture pass, structural operations, step modes (authoritative, predict)
src/sim/view/                  pure builders of the presentation blocks (readouts, navball, staging, patches,
                               markers, burn bookkeeping, target and docking readouts)
src/universe/                  directory (records, worldlines, solid windows, claims), clocks and the time
                               rules, island lifecycle and lanes, pad timetable, expiry, UniverseRules.
                               Pure TypeScript like src/sim: time and storage are injected
src/net/                       wire layer: message codec, framing, transports (WebSocket, loopback), time
                               sync, latency and stall injector
src/client/                    FlightSession implementations (LocalSession, NetSession with prediction),
                               client stores (census, pads, ships, rules, presence, feed), identity key
src/pilot/                     scripted pilots: the mission pilot, generic ascent/rendezvous/docking pilots
src/terrain/                   CPU height authority, tile sources (fs, fetch, pack), amplification, rocks
src/render/core|terrain|atmosphere|sky|ocean|vehicle|cockpit|vfx/    as in v1
src/input/, src/camera/, src/ui/     bindings and controllers, camera rigs, HUD, instruments, nameplates
src/map/                       map view: trajectories, census layer, targets, intercepts, node editing
src/shell/                     app state machine, menu framework and screens, settings models
src/bench/                     calibration shots, solver, quality profiles
src/audio/                     audio engine
server/                        Node roles: gateway, directory host, shard host, API; Postgres writer and
                               schema; bucket access; role wiring. Imports src/core, src/sim, src/terrain,
                               src/universe, src/net
bots/                          headless bot players (NetSession + pilots) and the Modal fleet app
deploy/                        Railway service definitions, Dockerfile, scale script, Netlify config, CI
labs/<package>/                lab pages
tests/unit/<package>/, tests/browser/<package>/, tests/mission/    as in v1
tests/universe/                headless rule, fuzz and lane-equivalence suites
tests/net/                     separate-process multi-client suites with latency injection
tests/acceptance/              two-browser stories, restart, expiry, whole flights
tests/load/                    load-test scenarios;  tools/net/  the multi-process test harness
tools/bake/common|earth|moon|sky|planet/   bake pipelines;  tools/bodies/  body-definition generator
tools/pack/                    tile packer and uploader;  tools/audio/, tools/sim/, tools/server/, tools/dev/
data/defs/                     JSON definitions (tracked)
data/tiles/, data/sky/, data/cache/, data/packs/     baked data, raw downloads, packs (git-ignored)
public/assets/<area>/          shipped binary assets
```

Import rules (enforced by `tools/dev/boundaries.test.ts`):

- `src/core` imports nothing outside `src/core`. `src/gate` imports nothing at all.
- `src/sim`, `src/terrain`, `src/universe`, `src/pilot` are headless and deterministic: no DOM, no WebGPU,
  no `performance.now`, no `Date.now`, no timers, no `Math.random`, no sockets, no file or database access.
  `sim -> terrain` only through `TerrainProvider`; `universe -> sim` through the public APIs of `src/sim`;
  `pilot` reaches a session only through the `FlightSession` contract.
- `src/net` imports `src/core` only. `src/client` imports `src/core`, `src/sim`, `src/universe` (LocalSession
  only) and `src/net`.
- Render packages import `src/core` and the public API of `src/render/core`; never each other, never
  `src/client` or `src/net`. `src/ui`, `src/map`, `src/audio`, `src/input`, `src/camera`, `src/shell`,
  `src/bench` import `src/core` only (plus `src/render/core` public helpers and, for labs and the turntable,
  the frozen vessel facade `src/sim/vessel/public.ts`).
- Only `src/app` knows every client subsystem. Only `server/` and `bots/` import Node networking, worker
  threads and the database driver. Node builtins elsewhere stay in `fs*.ts`, `*.node.ts` or `node/`.
- `server/` never imports `src/render`, `src/ui`, `src/map`, `src/shell`, `src/audio`.

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
- Wall-clock time is used for presentation, for the clock schedules of section 5 and for every lifetime and
  timer of sections 9.4 and 15.5. Headless code receives it as an argument.
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
site, scenario, milestone or rule value. Runtime ids are issued by the directory and are universe-unique:
`craftId` (never changes), `vesselId` (a single-craft vessel has `vesselId = craftId`; a piece split from it is
`<craftId>~<root part instance id>`; an assembly keeps its base vessel's id), part key `craftId/instanceId`.
The local universe issues ids from a seeded counter, so tests are reproducible.

**Determinism.** `src/sim`, `src/terrain`, `src/universe` and `src/pilot` iterate in defined order (vessels
by id, parts by index, bodies by sorted id) and use only the seeded hash / PRNG of `src/core/math/hash.ts`.
Same build + same runtime image + same inputs at the same ticks = bit-identical state. That holds within
one runtime (measured). It does **not** hold between Node and Chrome (15 of 17 transcendental functions
differ in the last bit, measured), so server and client never compare hashes; they compare state with a
tolerance. Server against server (journal replay, audit) compares hashes, on one pinned Node build and one
CPU architecture.

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
| Worldline | Per vessel: committed conic segments and sampled integrated arcs up to the head. |
| Attended | A connected pilot is aboard, or the server is still carrying the vessel for a pilot inside the reconnect grace. |
| Quiescent | On rails or at rest: no thrust, no contact, not in atmosphere. State is a pure function of the tick. |
| Passive | Not attended and quiescent. A passive vessel is on no clock and is never stepped. |
| Horizon | The tick of a passive vessel's next atmosphere entry or impact; infinite on a stable orbit or at rest. |
| Clock | A server object (5.2). Every attended vessel is on exactly one. |
| Lead | A clock's tick minus the live clock's tick. |
| Island | Vessels of one clock that could touch within seconds; one step loop, one frame, one thread. |
| Party | Pilots who linked on purpose and share a clock at any distance. |
| Solid | Can be touched: collided with, docked to, targeted for contact. |
| Echo | A drawing of a vessel that is not solid for the viewer. A **recorded echo** shows where a vessel that is ahead was at the viewer's time; a **projected echo** shows where a vessel that is behind, or beyond its window, would be if it coasted. Echoes never collide and always carry their offset and the one action that makes the vessel reachable. |
| Holder | The one server component that has authority over a vessel: the directory or an island on a shard. |

### 5.2 Clocks

A clock is `{ id, kind, tick0, anchorWallMs, rate, untilTick, limitedBy, members }` with the schedule
`tick(wall) = min(untilTick, tick0 + floor(rate x 120 x (wall - anchorWallMs) / 1000))`. Server and clients
evaluate the same closed form from the same message; a client never reports time. `untilTick` is the
earliest event of any member (sphere-of-influence crossing, horizon, screened encounter, target approach,
lead cap), so nobody is drawn past an event the server will stop at.

| Kind | Rate | Members |
|---|---|---|
| **Live** | 1, fixed | Everyone who spawned at the default and has not warped. One per lobby. |
| **Cohort** | 1, fixed, at a fixed lead of `k x 5 min` over the live clock | Players who took a future pad slot in that bucket (5.9). |
| **Private** | Set by its one pilot | One pilot's island or cruising vessel. |
| **Shared** | The lowest rate any member requests or is limited to | An island with two or more pilots, an assembly with two or more pilots aboard, or a party. |

The live clock is a **persisted mapping** from directory up-time to ticks. It does not advance while the
universe is down, so after any restart every clock resumes at its stored tick and the pad crowd is still
one group. Cohort clocks follow it. The lobby's epoch (the live tick at first start) is a deployment
setting; the default is the start of the `lunar-direct` scenario (2029-09-24T18:26:58Z).

### 5.3 Rules

Every number below is a field of `UniverseRules`; the values are the defaults.

- **U1. Forward only.** A head never decreases. Nothing committed is recomputed.
- **U2. Solid window.** For a viewer whose clock reads `t`, a vessel is solid when it is on the viewer's
  clock, or when it is passive and `head <= t <= min(horizon, limit)`. `limit` is infinite for the viewer's
  own vessels, party members' vessels, unowned vessels and debris. For anyone else's vessel it is
  `liveTick + advanceLimit`, anchored to the live clock (never to the head, so repeated claims cannot walk a
  ship forward), where `advanceLimit` is the owner's policy: 30 days for a ship, 6 years for an assembly with
  craft of two or more owners or marked public; the owner may set any value up to the cap. A hard guard
  refuses any claim that would carry another owner's vessel past `liveTick + leadCap - 20 years`.
- **U3. Interaction.** Contact, docking, transfer and control exist only between vessels on one clock, or
  between a vessel on a clock and a passive vessel it has claimed inside its solid window.
- **U4. Claim, in two steps.** *Admit*: when a vessel on a clock comes within the join distance
  (`1 km + 2 s x closing speed`) of a solid passive vessel, the passive vessel is loaded into the island in
  the Armed tier (6.2). Its head does not move. *Commit*: the first time a force, a contact, a capture, a
  transfer or a command acts on it, the directory sets its head to the island's tick in one ordered
  transaction. If the island dissolves first, the vessel is released with its old head. The directory is
  the single place where competing commits are ordered; a loser's copy becomes an echo with a jump offer.
- **U5. Materialise.** When a vessel becomes solid for a clock that is already past its head (a release, a
  logout, a returned claim, a wreck of an earlier cohort reached by the live clock), it is not collidable
  toward any vessel whose bounding sphere it overlaps or would reach ballistically within 30 s, until the
  two have first been `Ra + Rb + 5 m` apart. Nothing ever appears inside, or on a collision course seconds
  from, a ship that was there first.
- **U6. Rate.** A private clock may run at any level its vessel's situation allows: 1-4x while anything on
  it is integrated (the ceiling `physicsWarpMax` is a load-aware rules field), the altitude ladder on rails
  up to 10,000,000x, and 1x inside a launch range (within 150 km of a site and below 100 km altitude). The
  clock is clamped at the next sphere-of-influence crossing, at 1x from 10 s before a screened encounter
  (U10), and steps down before the selected target's closest approach (50x at 60 s, 1x at 10 s). A shared
  clock runs at the lowest request; a change above 1x is a proposal with a 15 s ready-check. A pilot may set
  **follow** for a named pilot (their proposals are accepted automatically). A pilot who has given no input
  for 120 s and whose vessel is quiescent or docked counts as accepting. A disconnected member never blocks.
- **U7. Stopping warp.** On a private clock above 4x the committed head trails the schedule by a stop
  window of 0.5 s of wall time. A rate change or stop stamped by the pilot with tick `T` takes effect at
  `max(T, head)`. The warp therefore stops where the pilot saw it, at any rate, and the server still owns
  the clock: nothing can interact with a private rails clock inside that window.
- **U8. Jump, hold, meet.** A quiescent vessel (or a clock whose vessels are all quiescent) may **jump** to
  any later tick, or to another clock, which it then joins. A jump is refused when the interval contains its
  horizon or a screened encounter, when it would pass the lead cap, when the arrival state is within
  `300 m + 3 x (Ra + Rb)` of a vessel that is solid there, or when a ballistic screening of the arrival
  predicts an approach inside `Ra + Rb + 50 m` in the next 30 s. An attended vessel near the arrival point is
  notified. **Hold** is rate 0: the pilot stays seated while the vessel is, for every purpose, passive.
  **Meet** fixes a tick not earlier than two pilots' heads; each warps there privately and they link on
  arrival. The planner offers a jump that arrives **in phase** (the first tick at or after the target's
  time at which the chaser's coast puts it at the wanted phase angle).
- **U9. Advance for a visitor.** A pilot who is ahead of an occupied group may ask it to advance to their
  tick. Granted when every vessel in the group is quiescent, the interval is clean for every member (U8
  checks) and every pilot accepts or is idle (U6). While a request is open the group accepts no further
  visitors, so the wait is bounded by one ready-check.
- **U10. Nothing tunnels through warp.** Before any rate above 4x and before any jump, every member's
  trajectory is screened over the whole interval against the solid predicate as a function of time: passive
  vessels from their heads on, and the other members of the same clock. A predicted miss below
  `Ra + Rb + 10 m` is an **encounter**: the clock is at 1x from 10 s before it, both vessels are in one
  island, and the pass is integrated with swept tests (7.4). Every later conic commit by anyone is
  re-screened against clearances already granted and shortens `untilTick`, never to before the committed
  head.
- **U11. Leaving a shared clock.** A vessel may leave alone (warp, jump or hold) unless it is in contact,
  in soft capture or docked, or a ballistic screening predicts contact (miss below `Ra + Rb + 10 m`) within
  30 s. Other pilots in the island see a 10 s notice; nobody can veto, and proximity alone never blocks. To
  those left behind the departed vessel is a recorded echo.
- **U12. Passive against passive is not simulated.** A passive vessel has no "when" in which to collide.
  The one exception is U13.
- **U13. Fate.** Beyond its horizon a passive vessel is a projected echo labelled "fate pending". It is
  resolved (an unattended run, 6.2) when the live clock reaches the horizon and its owner has not flown it.
  Debris without a command part is resolved at once when it becomes passive.
- **U14. Spheres of influence.** Crossings are exact per vessel on rails. An island crosses as a unit at
  its anchor's crossing tick; a merged island adopts the anchor's frame at the merge tick; a shared clock
  clamps to the earliest event of any member.
- **U15. Burns** run on the vessel's own clock at 1-4x.
- **U16. Disconnect and logout.** While the socket lives, controls stay latched; a hidden tab is not a
  disconnect. When the socket is lost, a solo island keeps the latched controls for 10 s, then closes the
  throttle (SAS keeps its mode). In an island with another owner's vessel the dead-man rule applies
  instead: rotation and translation commands are zeroed after 250 ms without input and the throttle after
  2 s. The reconnect grace is 120 s. After it, or on an explicit leave: a quiescent vessel becomes passive
  at its head; any other is flown to rest by an **unattended run** with no invented input (no stage fired,
  no chute opened), in real time and solid if it was on the live, a cohort or a shared clock, un-paced if it
  was on a private clock. A vessel is never removed from an island during contact. A returning pilot is
  attached at `max(head, liveTick)` on the live clock when no horizon lies between, else at the head on a
  private clock; leads therefore shrink by themselves while a player is away.
- **U17. Lead cap.** No clock may run more than 250 years ahead of the live clock. Hold is always available.
- **U18. Overload.** An island that cannot hold 120 Hz leaves onto its own clock running below 1x and is
  shown as `behind`. It rejoins by a jump (U8) when it is next quiescent. No other island is affected.
- **U19. Wall clock.** Expiry, pad dwell, reconnect grace, ready-checks and rate limits run on the wall
  clock. An outage longer than one hour extends every expiry deadline by its length.

### 5.4 What players at different times see

Each client evaluates bodies, lighting and site daylight at its own clock. The menu shows the live clock.

| The other vessel is | behind me | on my clock | ahead of me |
|---|---|---|---|
| passive, inside its solid window | Solid at my tick; admitted and claimed if I reach it (U4) | (a passive vessel is on no clock) | Recorded echo; "JUMP +3 d 4 h" |
| passive, outside its window | Projected echo: "fate pending" or "not available this far ahead" | | |
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
5. **Arriving ahead of an occupied station**: the station is a projected echo; ASK TO ADVANCE (U9), hold, or
   park and log out (the ship is attached at the live clock on return).

### 5.6 Warp in every situation the brief names

| Situation | What happens |
|---|---|
| Alone, quiescent | Any permitted level at once; stop is instant (U7) |
| Alone, burning or in atmosphere | 1-4x physics warp: more steps, never longer ones |
| On the live clock near the pad | 1x inside the launch range; above it, warping forks a private clock |
| Entering warp near a passive vessel | Allowed; U10 has screened the pair; an encounter forces 1x and an island |
| Inside an island with other pilots | A rate change is a proposal (U6). Leaving alone follows U11 |
| In contact, soft capture or docked | No rate change by one craft; a docked assembly is one vessel on one clock, the helm proposes |
| Dropping out of warp, ending a jump, joining a clock | U8 arrival checks and U5: nothing materialises inside or onto another ship |
| Sphere-of-influence change ahead | The clock clamps to the crossing, then continues if still permitted |
| Logout | U16; the flight menu states the outcome first |
| Cleanup | Section 15.5, on the wall clock |

### 5.7 Paradoxes and how each is excluded

| Paradox | Exclusion |
|---|---|
| Changing something's past | U1; recorded echoes are not solid |
| Touching a future its pilot has not flown | Attended-and-behind vessels are projected echoes |
| A stranger dragging a ship or a station far ahead | U2: the limit is anchored to the live clock and bounded by the owner; the guard band before the cap |
| A fly-by that exiles a parked ship | U4: admission does not move the head; only a first interaction does |
| Two players at different times taking one passive vessel | Commits are ordered by the directory; the head moves once |
| Leaving a collision course by changing time or by logging out | U10 before any encounter; U11 on predicted contact; U16 paces unattended runs on shared clocks in real time |
| Appearing inside or onto another vessel | U8 arrival checks; U5 |
| Being held at 1x by a neighbour | U11: only contact or a predicted contact inside 30 s blocks a departure |
| An absent crew member blocking a visitor | U6 idle rule, follow, and "a disconnected member never blocks" |
| A vessel existing twice or vanishing | One record, one holder, fenced by epoch (6.1); clients never hold state |
| A pad used by two rockets | One timetable of tick intervals per pad across all clocks (5.9) |
| A decaying parked ship seen "already crashed" by someone ahead | U13: beyond the horizon it is a projection, never history |
| Time running backwards after a crash | The live clock is a stored mapping; recovery restores a consistent cut (15.4) |
| Launched earlier, should have hit a committed history; passive against passive | Not excluded (decision 53) |

### 5.8 Why this model

A solo player keeps everything single-player KSP gives, up to 10,000,000x, with no waiting on anyone and
instant stops. The launch site is a shared place by construction (default spawn on the live clock, the range
rule, cohorts). Meeting someone is one action for whoever is behind. Nobody's warp can touch a burn in
progress and nobody can be pinned at 1x. The alternatives fail the brief: one clock makes Mars eight months
away or lets one player's warp wreck every burn; subspaces with client authority duplicate and rewind
ships; timeline repair teleports them. The price is stated to the player, not hidden: an offset next to
every name, echoes that cannot be touched, and a sky that after the first warp is mostly echoes, each one
keypress away for whoever is behind. That last point is the first thing to play-test.

### 5.9 Pads and time

- A spawn is a pad and a tick. Each pad has **one timetable** of non-overlapping tick intervals
  `[t, t + dwell + safing]` across all clocks. There are no per-clock copies of pad state.
- The default slot is the live tick. When the wait for a live pad of the vehicle's class exceeds 60 s the
  menu offers the earliest free **cohort slot**: buckets of 5 minutes, at most 24 h ahead. Everyone in a
  bucket shares one cohort clock and is solid to each other; other cohorts are echoes. A cohort slot uses
  future universe time, so it removes the wall-clock wait during a spike, not the pads' throughput per
  universe hour; pads are added as data.
- The menu also offers a **launch-window slot** ("plane crossing in 46 min", as a cohort) and a friend's
  clock. Waiting for a window is done by choosing the slot; there is no rails warp on a pad.
- Debris and wrecks of an earlier cohort become solid for later clocks under U5; pad safing removes anything
  at rest inside a keep-out radius.

---

## 6. Authority and compute split

### 6.1 Authority

- Every vessel has exactly one **holder**, recorded in the directory with an **epoch** number: the directory
  itself (passive and cruising vessels) or one island on one shard. A hand-over is: serialise at a tick,
  the receiver acknowledges, the directory flips the pointer and increments the epoch. Writes, frames and
  events that carry an old epoch are rejected, so a shard that was presumed dead cannot speak for islands
  that were recovered elsewhere.
- Two vessels exchange force, propellant, crew or control only inside one island: one clock, one step loop,
  one thread.
- Irreversible facts carry `(vesselId, epoch, tick)` and are idempotent: structural operations (split,
  merge, destroy, capture, release), ids of spawned vessels, pad assignments, claims, helm changes, warp
  grants.
- Same-tick ordering is canonical: vessels by id, then parts by index, commands by `(tick, pilot account
  id, sequence)`. The journal records the applied order, so a replay reproduces a live run.

### 6.2 Tiers and lanes

Simulation tiers (what the server does for a vessel):

| Tier | Step | Applies to | Cost (measured, desktop core) |
|---|---|---|---|
| Rails | none; one timer per event | Passive vessels; attended quiescent vessels at any warp | 0 between events; 0.15-0.26 us per Kepler evaluation |
| Armed | none; a swept-sphere test at 10 Hz against the island's other members | A quiescent vessel inside an island that is farther than `200 m + 2 s x closing speed` from every other member (a parked station while a ferry approaches) | under 0.1 us per second |
| Full | 120 Hz, contact sub-steps at 480 Hz | Thrust, RCS translation, atmosphere, contact, soft capture, anything inside the armed margin | 2.6-14.5 us per step; 45 us mean, 244 us p99 at touchdown |
| Reduced | 2 Hz | Unowned debris in atmosphere outside any island | 0.35 us per step |
| Unattended run | Full fidelity, no pilot | A vessel whose pilot left while it was not quiescent; a fate (U13) | as Full; un-paced unless the clock is shared |

Lanes (when the server runs the steps of a Full-tier island). All lanes run the identical loop on the
identical stamped inputs.

| Lane | Tick `k` is stepped | Used for | Worker utilisation target |
|---|---|---|---|
| Real-time | at `wall(k)`, with a jitter buffer of two control ticks | Islands with vessels of two or more owners; any island in contact; every island while `lagCap = 0` | 50 % |
| Trailing | any time before `wall(k) + L`, in batches | Single-owner islands | 85 % |
| Deferred | whenever a core is free | Un-paced unattended runs, crash-recovery replays, audits | whatever is free |

Rules for the commit lag `L` of a single-owner island:

- `L <= min(lagCap, tau / 20)` and `L = 0` once `tau <= 4 s`, where `tau` is the smallest reach time to any
  solid vessel of another owner: `(distance - join distance) / closing speed`, with a worst-case mutual
  acceleration of 60 m/s^2 included, computed by the server from its own state.
- `L = 0` during a **threshold watch**: any part within 10 % of its temperature limit, structural load above
  80 % of a joint limit, a contact probe within 2 s of the ground, or a parachute outside its safe envelope.
- An input stamped for tick `k` is applied at `k` when it arrives before the server steps `k`; later, it is
  applied at the arrival tick and the acknowledgement says so. The window is therefore the jitter buffer in
  the real-time lane and `L` in the trailing lane, so a TCP stall shorter than `L` costs a solo pilot no
  correction. The server never accepts a stamp beyond `clock(wall) + 0.25 s`.
- **`lagCap` is 0 in the first release.** It is raised to 2 s when the lane-equivalence suite (28.2) is green
  and the first load test asks for it. A launch day is provisioned as real time in any case: neighbours 1 to
  2.5 km apart on a pad row hold `L` under 0.35 s for a whole ascent.
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
| Target closest approaches for a weak client (`cpuScore` below threshold in hello) | Computed by the API from the same pure function, cached per (vessel revision, target revision) | Skips the computation; census and near-tier rates are halved | on change |

The chooser for planning work is a table lookup, not an optimiser: local when the estimate is under 50 ms or
the link is down; the cache when the key exists; the service otherwise. Bots, bakes, replay audits and
bucket throughput tests are batch work on Modal.

### 6.4 What a client may show before the server

- Attitude, throttle, translation, contact forces and the soft-capture spring are predicted.
- In a **single-owner island**, command-triggered structural changes of the pilot's own craft (stage, abort,
  legs, chute deployment, undocking two of their own craft) are applied locally at once: client and server
  run the same inputs at the same ticks, and spawned vessel ids are deterministic.
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
4. The scale script adds shard services and gateway replicas (Railway has no autoscaler; this takes a
   minute or two).
5. Dilation: U18, single-owner islands first.
6. Admission: new spawns queue in the menu, which holds no socket; queued players may spectate.

Admission is driven by measurement: the directory admits a pilot only while the fleet's p99 step time is
under 6 ms of the 8.33 ms tick.

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
  orbit, the sub-stepped step loop with the vessel-vessel contact and capture pass, swept tests, structural
  operations, and the two step modes: **authoritative** and **predict** (threshold transitions suppressed).
  It knows no player, no socket and no storage. An island of one with no origin produces exactly the
  numbers of v1's `stepVessel`.
- **View** (`src/sim/view`): pure builders of the presentation blocks from island state plus client-side
  planning state: `SimSnapshot` assembly with presentation interpolation, readouts, navball, staging info,
  patches and markers, burn bookkeeping, target and docking readouts. Never runs on a server.
- **Universe** (`src/universe`): the directory (records, worldlines, solid windows, claims, epochs), clocks
  and the rules of section 5, island lifecycle (materialise, merge, split, to rails, migrate) and lanes,
  screening, the pad timetable, expiry, the milestone observer for optional objectives. Time and storage
  are injected. Its server-facing interface is `UniverseHost` (spawn, attach, detach, input, command, time
  request, subscriptions) which emits the typed messages of section 13.

Key rules carried from v1: point-mass gravity of the current SOI body both on rails and when integrating
(mode switches are exact); rails propagation always from the epoch state; physics warp is more steps, never
a bigger step; contact sub-steps at 480 Hz; terrain only through `TerrainProvider`; the atmosphere
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
  carries the complete dynamic state with definitions by id, non-finite numbers tagged and the sign of zero
  preserved; `stateHash` hashes the codec output. Codec round trip is exact in every regime, including a
  lander mid-touchdown and a capsule in entry. It is used by persistence, hand-over, keyframes and the
  client's rollback ring.
- **Limits**: 32 craft and 600 parts per assembly, 64 vessels per island; a capture that would exceed them
  is refused with a message.

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
  anchor finishes a burn, or at an SOI change.
- A single-owner island's lag is drained before a merge (6.2). Islands migrate between workers and shards by
  value at a tick boundary (codec bytes over the private network); the gateway holds the socket, so the
  client never reconnects. An island is not migrated while any pair is in contact or soft capture.

### 7.4 Contact, collisions and damage

- **Colliders** are convex pieces built from part data: by default what `clearance.ts` builds from
  `PartDef.bounds` (cylinder; deployment-dependent leg cylinder; wedge set for fairing panels); authored
  `PartDef.collision` shapes (cylinder, frustum, capsule, box, hull, shell) only where the bounds cylinder
  is badly wrong. Each vessel keeps a bounding-volume tree of its part colliders in VES. Canopies and lines
  do not collide; parts of one vessel never collide with each other.
- **Nothing tunnels.** Pairs are covered by exactly one mechanism: encounters from screening (rails
  against solid passive, U10); the neighbour list and admission (integrated against passive); islands
  (integrated against integrated). Inside an island, per pair per step: a sphere sweep; speculative
  contacts for slow pairs (relative travel per step below a quarter of the thinnest collider); conservative
  advancement to the time of impact for fast pairs. At 15.6 km/s a craft moves 130 m per step; nothing is
  skipped by step size.
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
  it earlier.
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
  construction. The heavier vessel is the base (equal mass: the lower id). The directory replaces two
  records by one before the `docked` event is released.
- **One helm or none.** The helm's inputs steer the vessel through its own craft and through actuators
  other craft have lent. An arriving craft goes to docked free drift: engines, thrusters and wheels
  inhibited until its owner's policy admits them (`lendAttitude` on by default, `lendEngines` and
  `lendPropellant` off). At dock the base vessel's helm stays. The **anchor** is the craft longest in the
  assembly (never the heaviest); its owner may take the helm at any time; others request it under the
  anchor's helm policy (`crew` by default) and are granted on acceptance or after 30 s without helm input.
  A helm whose socket drops is vacant at once and the throttle goes to zero. Inputs from a pilot who is not
  helm are dropped by the island; their HUD says who is flying.
- **Craft sovereignty.** Each owner's commands for their own craft are always accepted: fire their own
  stage stack, abort, arm and release their own ports, pump out of their own tanks, change their lend
  policy. Staging while docked separates the pieces physically.
- **Joint strength.** A link breaks when the force or torque needed to accelerate the lighter side exceeds
  the port's `hard` limits for 0.2 s. The rule players learn: do not burn hard through a docking port.
- **Undock.** The owner of either port commands it (or a stage action does). At a tick the island removes
  the link, splits the forest, applies the spring impulse equal and opposite at the port point, puts both
  ports in cooldown and marks the pair nascent. The piece with the helm's craft keeps the helm; every other
  piece gets its own connected owner at zero throttle, or none. The directory replaces one record by
  several before the `undocked` event is released.
- **One vessel, one clock.** Every pilot aboard is a member of the assembly's clock; warp is the helm's
  proposal (U6). A passenger who does not want to come along undocks, which is always possible.
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
mission proof; debug mutators exist only in `LocalSession`.

---

## 8. Bodies: the solar system

Design and source data: `docs/research/v2/solar-system.md`.

### 8.1 The set

Sun (root attractor and star); Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune; Moon; Phobos,
Deimos; Io, Europa, Ganymede, Callisto; Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus; Miranda,
Ariel, Umbriel, Titania, Oberon; Triton; Ceres; Pluto and Charon. Thirty bodies, three levels, no moon of a
moon. Every one is an attractor a player can reach and orbit.

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
- Sources are USGS Astrogeology mosaics (public domain) and Solar System Scope textures (CC BY 4.0, credited
  on the credits screen). Maps that forbid redistribution are not used.
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
| `azimuth-pathfinder` | Azimuth 1 + Pathfinder probe | Smallest launch; a probe that can orbit the Moon, Venus or Mars | none |
| `solstice-kestrel` | Solstice + Kestrel LF crew ferry | Low-orbit rendezvous and docking; capsule returns under parachutes | `kestrel` |
| `solstice-atoll` | Solstice + Atoll station core | First module of a station: six ports | none |
| `solstice-pelican` | Solstice + Pelican tug/tanker | Pushes modules, refuels craft | none |
| `meridian-lunar` | Meridian + Heron lander + Kestrel (exists, unchanged) | Direct-ascent lunar landing and return | `kestrel` |
| `meridian-egret` | Meridian + Egret lunar ferry | Reusable lander between lunar orbit and surface | `kestrel` (shared cabin mould line) |
| `meridian-albatross` | Meridian M-1 + M-2 + Albatross cruiser | Nuclear-thermal cruiser, 10.9 km/s from low Earth orbit: capture ellipses at every outer planet | none (remote); crew arrive by ferry |
| `meridian-pelican-heavy` | Meridian + depot | Propellant depot in lunar or Earth orbit (no new parts) | none |

"Orbit" at a giant means a bound capture ellipse (7.0-9.4 km/s from low Earth orbit); low circular orbits
there cost 15-24 km/s and are not on offer. Uncrewed craft have a `command` module flagged `remote`.

### 9.2 Vehicle and part data

- `VehicleDef` stays the flat part graph the simulation reads. Additions are optional: sub-assembly
  includes (`uses`, flattened by the loader from `data/defs/assemblies/<id>.json`), attach-node kinds
  (`stack`, `mount`, `dock`), `surfaceAttach`, `symmetry` tags, `padInterface` (class, umbilicals, crew
  arm), pre-mated ports recorded as dock links. `meridian-lunar.json` stays flat and untouched.
- `PartDef` gains `collision`, `crossfeed`, `crashTolerance`, `resources[].transferable`, the `dockingPort`
  module, `command.remote`, `command.cockpit`, and the categories `dock` and `habitat`.
- `validateVehicle(defs, vehicle): Issue[]` (pure, `src/core/defs`) is run by the loader, by the server on
  every spawn, and later by a builder. `analyzeVehicle(defs, vehicle): VehicleCapabilities` (pure,
  `src/sim/vessel`) computes every read-out the menu shows (delta-v per stage, TWR, crew, ports, RCS,
  entry limit, the "can reach" ladder from the bodies' data); capabilities are never authored.
- Menu text and thumbnails live in `visuals/vehicles/<id>.json`, not in `VehicleDef`.

### 9.3 Sites and pads

- `LaunchSiteDef.pads: PadDef[]` replaces the single pad: id, name, east/north offset, azimuth, class
  (`light`, `medium`, `heavy`; a pad hosts its class and anything smaller), mass and diameter limits, flat
  and blend radii, mount height, keep-out radius, structures. Flatten-disc terrain modifiers are derived
  from the pads at load.
- **Ka Lae** (site id `ka-lae`, the v1 site renamed in one sweep): eight pads inside the existing 100 km
  region (2 heavy, 3 medium, 3 light), heavy pads at least 2.5 km apart, light pads at least 1 km.
- **Madrakah Coast** (site id `madrakah`, a fictional facility on the Arabian Sea coast of Oman near
  19.0 N 57.8 E): eight pads. Same latitude as Ka Lae, 14.2 hours of solar time away, so one of the two
  sites is in daylight at almost any hour. One regional Earth bake.
- Pads are data plus a resolve run; the pad count is the capacity dial of the launch complex (16 pads give
  240-640 launches per universe hour at 90-240 s cycles, computed).

### 9.4 Pad rules (wall-clock timers; all `UniverseRules` fields)

| Rule | Default |
|---|---|
| Reservation hold (briefing and transit) | 90 s |
| Longest stay on a pad | 300 s, one 120 s extension while engines run |
| Grace after a disconnect on the pad | 60 s, then roll-back to the hangar (no debris) |
| Pad cleared when the vehicle is | above 1,500 m and more than 1,000 m away, or destroyed |
| Safing after clearance | 20 s; wreckage inside the keep-out radius is removed |
| Keep-out radius | 600 m heavy, 450 m medium, 300 m light |
| At rest inside a keep-out radius | recovered (removed) after 60 s |
| Range safety | A vehicle below 5 km whose instantaneous impact point enters another pad's keep-out radius is destroyed by the range; a server event shown as such |

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

The simple bodies of section 8.5 and the second site's region (section 9.3) add about 4 GB. Total baked data stays under 22 GB including caches; raw downloads are deleted after a bake.

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
- Tile bytes come from a `TileSource`: fetch-based in the browser and workers, fs-based in vitest and tools.
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

- The bake output and the dev server stay plain files (`TileSource`: fs in tools and tests, fetch against
  the dev server). Production adds one more `TileSource`: **packs**.
- `tools/pack` writes content-addressed packs of 64-256 MB (hash in the name, never rewritten): all layers
  of one tile coordinate adjacent, groups in Morton order per level, height layers in their own packs, small
  bodies one pack per body and layer. The index (`[pack, offset, length]` per tile group) lives beside the
  manifest, which stays the single promise of what exists.
- Clients read packs by HTTP range from an ordered mirror list with failover on 429, 5xx and timeout:
  presigned URLs on a Railway bucket (free egress; signed with a quantised date so every client gets the
  same URL for a week), then the `edge` service with its CDN. Tile bytes are cached by content hash in OPFS,
  so presigned URLs changing does not cause a re-download. Sky data and `public/assets` take the same path.
- The page is cross-origin isolated; every pack response carries CORS headers and exposes `Content-Range`.

### 10.5 Terrain on the servers

Shards need the height layers only (9.65 GB for Earth and Moon today). Each shard reads the height packs by
range from the bucket into an LRU on its ephemeral disk; first touch in a new region stalls only the island
that needs it (7.6). The directory places landings on shards that already hold the region where it can.

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
  bundled, hashed library. `validateLibrary()` checks cross references; `validateVehicle()` checks every
  vehicle; each subsystem validates the sections it consumes.
- `defsHash` (a hash of the bundled library) and the sim build id are part of the session handshake: a
  client whose library or sim differs from the server's is refused before anything else.
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
- The menu holds **no socket**. It polls `GET /live.json` (presence, feed, pads summary, up to 200 markers
  of the menu region), regenerated once a second and cacheable for one second, so 50,000 visitors cost one
  computation a second and none of Railway's 10,000 connections per service.

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
flying is kept on its build until it leaves or the server drains. `TimeSync` round trips with a
minimum-round-trip filter give the client the server's wall clock to a few milliseconds. One session per
account flies at a time; attaching elsewhere takes the flight over (`takenOver`).

### 13.3 Messages

Client to server:

| Message | Content | Rate |
|---|---|---|
| `Input` | `seq, applyTick`, pitch/yaw/roll/translate as `i8`, throttle `u8`, and the SAS hold direction (3 x `f32`) when a maneuver or target mode needs it; each message repeats the changes of the last 250 ms | 30 Hz while flying |
| `Command` | `cmdId, tick, kind, args`: stage, abort, SAS, RCS, legs, lights, fine control, arm or disarm a port, undock, control-from-here, helm request/grant/release, lend policy, transfer, cross-feed, rename, abandon | on press; acknowledged |
| `Time` | set rate (with the stamped tick, U7), warp to tick, jump (tick or clock), hold, link, unlink, follow, meet, reply to a proposal, ask to advance | on press; acknowledged with the reason when refused |
| `Target` | `TargetRef` (body, vessel, port) | on change |
| `Subscribe` | census scopes (spheres of influence, categories), pads, roster page, the worldline of one vessel | on change |
| `Plan` | the pilot's maneuver nodes and target for this ship, opaque to the simulation | on edit, at most 1 Hz |
| `Quick`, `Ping`, `TimeSync` | | |

Server to client:

| Message | Content | Rate |
|---|---|---|
| `ClockState` | the clock of 5.2 with members, proposals, relation and offers | on change |
| `IslandEnter` | island id, epoch, reference orbit, the complete state of every vessel (vessel codec, deflated) | on entering or re-forming |
| `IslandOp` | a structural change at a tick as an operation both sides execute: `split`, `merge`, `destroy`, `capture`, `release`, `add`, `remove`, `rebase`, `replace`; with a checksum of the result (part count, craft list, mass to 1e-9) | on event; reliable |
| `IslandKey` | tick, last own input tick applied, input margin, and per stepped vessel the **exact** pose: position and velocity as float64 offsets from the reference orbit, attitude and rate as float32, applied controls | 1 Hz |
| `IslandDelta` | tick, key tick, and per vessel the groups that changed against the last key: POSE (quantised, 16-22 B), CONTROL, PART-FAST (ignition, gimbal, legs, chutes); a pair in contact is sent exact with its friction anchors and port state | 10 Hz single-owner, 30 Hz shared, 60 Hz for a contact pair |
| `IslandSlow` | resource levels and part temperatures that changed | 2 Hz |
| `Event` | a `SimEvent` with its tick, vessel and epoch | reliable |
| `CommandResult` | `cmdId, ok, appliedTick, reason` | per command |
| `Near` | vessels of the near tier: quantised pose relative to their own island reference, throttle, thrust direction; inputs when warm | 10 Hz within 20 km, 2 Hz beyond |
| `CensusFull` / `CensusDelta` | per sphere of influence: handle, kind, owner, conic, valid-from tick, head, horizon, clock id, radius, expiry time, flags (about 84 B per object) | on subscribe / on change; 1 Hz osculating elements for thrusting craft |
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
- On rails, client and server evaluate the same conic at the same clock tick; `untilTick` is known in
  advance.

### 13.6 Lag, reconnects and simultaneous actions

- Inputs take effect at the tick the pilot stamped (6.2). A pilot with a 250 ms round trip runs further
  ahead of the server than one with 40 ms; neither is disadvantaged at docking speeds. A misprediction of
  another pilot's RCS over 150 ms is 0.4 mm; docking happens with main engines off.
- Capture and hard dock are slow by design (0.5 s of residuals below threshold; an envelope two to three
  times wider than the real standard), so one round trip of event delay is hidden inside the latch
  sequence. Above a 250 ms round trip or 5 % stalled sends for 3 s the HUD shows "UNSTABLE LINK".
- Two pilots pressing undock in one tick, or two craft reaching one port in one step, are resolved by the
  canonical order of 6.1; the second gets `CommandResult { ok: false, reason }`.
- The gateway owns the socket. `Hello { resume }` to any gateway inside the grace period returns the pilot
  to the same vessel on the same clock: `ClockState`, `IslandEnter`, census deltas from the client's last
  sequence number. Backoff: 0.5, 1, 2, 4, 8 s, then every 15 s, with jitter; gateways admit resumes before
  new sessions. A returning hidden tab rebuilds its replica from a fresh `IslandEnter`, never by
  fast-forward.
- Every client has a hard downstream budget (6 kB/s by default) spent in priority order: own island, nearest
  near-tier vessels, census; superseded samples are dropped.

---

## 14. Interest management

Relevance has two axes, space and clock relation. Nothing is broadcast per frame; a parked ship costs its
census subscribers 84 bytes once.

| Tier | Who | What | Rate |
|---|---|---|---|
| A | Vessels in my island | Exact keys, deltas, operations, others' inputs, events | 10 / 30 / 60 Hz (13.3) |
| B (near) | The 8 nearest integrated islands on my clock within 300 km, or with a visible plume; warm from `tau <= 60 s` | `Near` states; warm: with inputs | 10 Hz within 20 km, 2 Hz beyond; warm 10 Hz |
| C (census) | Every object in the subscribed spheres of influence and categories | Conic entries; worldline segments for my target, my party and my own ships | on change; 1 Hz for thrusting craft |
| D (directory) | Everything else | Paged lists: my ships, roster, stations; counts per body | on demand |

- **Solid or echo** is decided on the client from the census entry and its own clock (U2). The server
  applies the sphere-of-influence and category filters to the subscription; the client applies distance,
  line caps and the timeline filter.
- The first census sync is the relevant set only (own ships, target, everything on my clock within 500 km,
  stations); the full list of a sphere of influence (10,000 objects is 840 kB) is sent when the map asks.
- The map draws icons for the census by propagation on the client (GPU compute above 500 objects) and
  float64 lines and markers only for a capped relevant set (own ships, target, docked partners, hovered,
  plus 32 others).
- Recorded echoes need history: conic segments are kept for the vessel's lifetime after the live clock;
  integrated arcs are stored as 1 Hz samples for 24 wall hours and reduced to their end points afterwards.
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
| Two-owner transitions | Claim commit, dock, undock between owners, ownership and helm-policy changes, hand-over between holders | The record change **and the island checkpoint** are committed in one transaction before the event is released to any client |
| Single-owner transitions | Staging splits, destruction, to-rails, own undock | Ride the 250 ms batch; a crash before the batch is repaired by journal replay or shown to the one owner as a resync |
| Islands in flight | A checkpoint every 60 s and at every structural operation; the input journal in between | At most 250 ms of flight lost in a crash, less when the gateway's input buffer covers it |
| Derivable | Patches, readouts, census, prediction | Never stored |

### 15.2 Schema (Postgres on Railway, private network; one schema per lobby)

```
account     (id uuid pk, callsign citext unique, created_at, last_session_at, settings jsonb, flags)
credential  (id, account_id fk, kind text, public_key bytea, label, added_at, revoked_at)   -- 'deviceKey' today
recovery    (account_id pk, code_hash, rotated_at)
craft       (id text pk, vessel_id fk, owner_account uuid null, vehicle_id text, design jsonb null,
             name, joined_tick float8, policy jsonb, abandoned_at timestamptz null)
vessel      (id text pk, state smallint,            -- passive | cruising | island | tombstone
             holder text, epoch bigint,             -- authority fence
             body_id text, head_tick float8, horizon_tick float8,
             seg_r0 float8[3], seg_v0 float8[3], seg_t0 float8,   -- or a body-fixed rest pose
             mass real, bounding_radius real, situation smallint, part_count int,
             anchor_craft text, helm_account uuid null, advance_limit_ticks float8, access smallint,
             clock_id text null, island_id text null,
             dyn bytea,                             -- complete dynamic state, vessel codec, deflated
             expires_at timestamptz null, row_version bigint)
worldline   (vessel_id, seq int, tick_start float8, tick_end float8, kind smallint, body_id text, data bytea)
clock       (id text pk, kind smallint, tick0 float8, anchor_uptime_ms float8, rate float8, members jsonb)
pad_slot    (site_id, pad_id, tick_from float8, tick_to float8, vessel_id, account_id, state smallint)
island_ckpt (island_id, tick float8, clock_id text, reference bytea, state bytea, terrain_levels jsonb)  -- newest two
island_jrnl (island_id, seq bigint, tick_from float8, tick_to float8, data bytea)   -- partitioned by hour
plan        (craft_id, account_id, nodes jsonb, target jsonb)
event_log   (seq bigserial, at timestamptz, tick float8, kind text, data jsonb)     -- audit trail and feed source
rules       (version int pk, doc jsonb, activated_at)
report      (id, at, reporter, subject, kind, context jsonb)
```

- An assembly is one `vessel` row with several `craft` rows; links and per-craft stage stacks are inside
  `dyn`. Persisting a docked assembly needs nothing beyond persisting a vessel.
- `craft.design` is empty today; it is where a builder's `VehicleDef` document will live.
- A parked ship is never kept as a live `Vessel` (375 kB of heap each, measured): the directory holds about
  0.5 kB per vessel in memory and loads `dyn` on admission or attach. One hundred thousand parked ships are
  about 50 MB of memory and under 1 GB of table.

### 15.3 Write path

- **The directory is the single writer** of every table. Shards send checkpoints, journal chunks and
  transition requests to it over the private network; a database worker thread writes the batches.
- A journal chunk holds everything needed to replay: tick range, every pilot's input changes with their
  applied ticks, commands in applied order, clock rate changes, the terrain data level that was resident.
  Replay on the same runtime image is bit-exact (measured). Replays are valid only for the build that wrote
  the journal: a deploy that changes the build always takes the graceful path.
- Volumes (derived): about 70 kB/s at 500 players, about 1.3 MB/s on a 5,000-player launch day.
  `island_jrnl` partitions are dropped, never vacuumed. A rules switch turns the journal off (checkpoints
  every 10 s, at most 10 s lost).
- Copies: Railway volume backups daily; a logical dump and the newest checkpoints to a Railway bucket (a
  different storage system) every hour; one sampled journal in a hundred archived for the replay audit.

### 15.4 Restart and recovery

Every deploy of a simulation role is a restart, so this is the normal path.

| Phase | Graceful (deploy, SIGTERM, 30 s drain) | Crash |
|---|---|---|
| Stop | `Notice restart`; every clock freezes at a tick boundary; shards write final checkpoints; the directory flushes | Nothing |
| Load | The directory reads rules, clocks, pads and the index columns of every vessel; rebuilds the per-body passive index | Same |
| Islands | Restored from the final checkpoints | Restored from the latest checkpoint; the journal is replayed un-paced (60 s of flight is about 0.2 CPU-seconds per vessel, derived) |
| Clocks | Resume at the stored tick; the live clock did not advance | **Consistent cut per clock**: every clock resumes at the minimum durable tick over its islands, and each island is replayed only to that tick |
| Pilots | Reconnect with jittered backoff and resume; the grace period starts when the universe is back | Same |
| Result | Nothing lost | At most 250 ms rolled back; clients reconcile through the normal correction path |

- A single shard dying: the directory notices the missing heartbeat (2 s), fences the shard's epoch, and
  another shard restores its islands from checkpoint and journal, then catches them up to their clocks by
  un-paced replay of the inputs the gateways buffered (5 s per island). An island whose inputs cannot be
  recovered that far continues on its own clock, `behind` (U18).
- Gateways and the API are stateless and roll one replica at a time. Simulation, gateway, API and shell
  have their own watch paths; a front-end push never restarts the universe.
- With several shards, a deploy drains one shard at a time by migrating its islands (7.3).

### 15.5 Expiry and cleanup (wall clock; every number a `UniverseRules` field)

| Object | Kept for | Reset or protected by | Then |
|---|---|---|---|
| A craft with a command part and an owner | 14 days after the owner's last session | Any session of the owner renews all of the owner's craft | Becomes unowned |
| Ship slots | 10 owned craft per account | Abandon one | An eleventh launch asks which to abandon |
| A craft docked in an assembly | Kept while any craft in the assembly has an unexpired owner | The assembly lives as long as its most recently active owner | A lapsed craft becomes unowned but stays attached; the anchor's owner may release it |
| An unowned craft (abandoned, or lapsed and not docked) | 48 h | Nobody can re-own it | Removed |
| Debris (no command part) | 2 h after it leaves every island | Budget of 24 pieces per account and 5,000 unowned objects per sphere of influence; oldest first | Removed |
| Fragments under 50 kg | 60 s of simulation | - | Removed |
| A landed wreck | 2 h | - | Removed |
| A vehicle on a pad | Section 9.4 | - | Rolled back, not expired |
| A vessel escaping beyond 100 AU | - | - | Removed, reason `lost` |
| Sampled arcs in worldlines | 24 h | - | Reduced to end points |
| An account with no ships | 90 days without a session | Any session | Deleted |
| All passive objects | 50,000 per lobby | Admission back-pressure on spawns | Launch refused with the reason |

- Only passive vessels expire; the sweep (every 60 s) never removes a vessel that is attended or in an
  island. Removal deletes the vessel at every universe time at once and its whole worldline; it is an
  out-of-fiction act ("recovered by the range") and is shown as such, with its reason (`expired`, `limit`,
  `rolledBack`, `recovered`, `lost`).
- Visible everywhere: every census entry carries its removal time; My Ships shows a countdown and the
  reason a ship is kept; the rules screen lists this table from the live `UniverseRules`.
- Growth bound: accounts seen in 14 days times 10 craft, plus the unowned caps.

---

## 16. Server topology and hosting

Platform facts and prices: `docs/research/v2/hosting.md`.

### 16.1 Roles

One Node program, one image, roles selected by configuration. Roles talk through one message schema; the
transport is a `MessagePort` inside one process and a length-prefixed TCP stream on Railway's private
network.

| Role | Count | Does | Does not |
|---|---|---|---|
| **Gateway** | N replicas, stateless | Sockets, authentication, subscriptions, fan-out of island frames and census, input routing, the 5 s input buffer, back-pressure, rate limits | Physics, decisions |
| **Directory** | 1 per lobby | Single writer of the universe: records, clocks, claims, pads, island placement and epochs, screening (helper threads), expiry, admission, persistence | Stepping |
| **Shard** | one Railway service each (`sim-1` ... `sim-K`), one main thread plus one isolate per worker thread | Steps islands, runs unattended runs, holds the height authority and its pack cache, encodes frames, sends checkpoints and journals | Anything about vessels it does not hold |
| **API** | 2 replicas, stateless | HTTP: accounts and recovery, lobby list, rules, `live.json`, status and metrics, presigned pack list, weak-client planning | Sockets |

- A worker is one isolate because `src/sim` keeps module-level scratch state. Vessels move between workers
  by value.
- Each shard is its own service because replicas of one Railway service are not individually addressable
  and not sticky. Gateways connect to every shard and to the directory by private DNS name; clients never
  learn which shard holds them.
- Gateways in one replica are separate processes (the Node cluster module), because worker threads cannot
  share a listening socket.

### 16.2 Deployment stages (same code)

| Stage | Railway services | Holds |
|---|---|---|
| A. Development and quiet times | `universe` (all roles in one replica: one gateway process, the directory, worker threads), `api`, `postgres`, `edge` (the static shell and the pack mirror, CDN on), buckets | about 300-500 concurrent players (assumed) |
| B. Announced launch | `gate` x 3 replicas, `dir`, `sim-1..K` (22 worker threads each), `api` x 2, `postgres`, `edge`, buckets | per shard about 360 integrated objects on the conservative figure and about 2,200 on the derived one, at 50 % headroom |
| C. Beyond | a second gateway service at 8,000 connections, directory helpers on their own service, a second lobby as a second copy of the stack | 10,000+ |

- Stage B is entered by `deploy/scale.mjs` against the Railway API before an announcement; idle shards cost
  only their memory because CPU is billed on use.
- **Shell**: the `edge` service on Railway by default. `deploy/netlify.toml` (headers, redirects) is kept
  ready; switching the shell to Netlify is a DNS change once a Pro team with auto-recharge and a token
  exist (OPEN_QUESTIONS Q3). Both send the COOP and COEP headers.
- **Modal** (own environment `fsp`, app names prefixed `fsp-`; existing apps and volumes untouched):
  `fsp-bots` (load-test players), `fsp-bake` (bakes), `fsp-audit` (nightly replay of archived journals
  against committed checkpoints), `fsp-probe` (bucket throughput tests).
- **Region**: US East. Europe sees roughly 90-120 ms of round trip, Asia and Australia about 250 ms. A
  second region would be a second lobby.
- **Secrets**: deploy secrets in GitHub Actions; run-time secrets as Railway sealed or reference variables;
  the client holds no provider credential.
- **CI** (GitHub Actions on `sshh12/fable-space-program`): secrets check, typecheck, boundaries, unit and
  universe suites, the net suites on synthetic terrain. Railway autodeploys per service with watch paths
  and "Wait for CI". Mission proofs and GPU suites run on the development machine (they need baked tiles
  and a GPU).

### 16.3 Scaling path

1. Stage A, vertical: one replica up to 24 vCPU.
2. Split roles (stage B): gateways, directory, shards.
3. More shards; the directory places islands by clock and sphere of influence so likely merges are local.
4. `lagCap > 0` for single-owner islands (fewer shards on the conservative figure: about 12 instead of 19
   for a launch-heavy 5,000).
5. A second gateway service; ask Railway for more than 10,000 connections per service.
6. Screening helpers on their own service; partition the directory by planetary system.
7. Postgres: pooling, then the HA cluster, then journals on a separate instance.
8. More lobbies.

---

## 17. Client structure and runtime data flow

### 17.1 Sessions

`FlightSession` (`src/core/contracts/session.ts`) is what `src/app`, pilots, labs and tests hold:
`advance(realDt, onControlTick?)`, `snapshot()`, `peek()`, `setControls()`, `commands: PlayerCommands`
(flight, target, time, port, helm and transfer commands: everything a pilot does from the seat),
`universe: UniverseCommands` (spawn, attach, detach, subscriptions, rename, abandon),
`stores: ClientStores` (census, pads, ships, assembly, roster, rules, presence, feed, prompts, link state).

- **`LocalSession`** (`src/client/local`) runs `src/universe` in process: a directory, islands, no sockets,
  no lag, authoritative state presented directly. It adds `ready`, `terrainPending()`, `step()`,
  `advanceRails()`, `needsIntegration`, `nextEventUt`, `stateHash()`, `debug` and `cheatCounter`. It is the
  headless mission, every lab, the calibration benchmark and offline play. `createSim(defs, scenarioId,
  { terrain })` returns it.
- **`NetSession`** (`src/client/net`) is the same interface over a gateway: the replica of 13.5, the census
  store, the clock, the stores. Commands that change state return `{ ok: true, pending: true }` at once and
  are confirmed by a `commandResult` event; planning commands (`addNode`, `setNode`, `removeNode`,
  `setNavballMode`, `setTarget`) stay synchronous because they are local.
- **`FakeSession`** (`src/core/fakes`) keeps the v1 FakeSim's role for labs, with multi-vessel, target,
  docking, echo and time-strip scenes.

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
  worker pool; heliocentric predictions, closest approaches and the proximity plot in a planning worker;
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

- **Cockpit**: eye at the commander's seat of the helm's command part, free look with the mouse; the
  interior is ordinary scene geometry; `insideVesselId` switches audio to the cabin mix and exposure to
  interior metering.
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
axis), `spectate` (a chase camera on another player's craft). The map rig zooms from 1e5 m to 1e13 m. The
cockpit eye comes from the helm's command part.

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

- **States**: `boot -> gate -> calibrate -> title -> hub(PLAY | HANGAR | MY SHIPS | UNIVERSE | SETTINGS)
  -> deploy -> transit -> flight <-> flightMenu -> leaving -> hub`, with `queued`, `reconnecting` and
  `blocked` as side states. From `calibrate` on the renderer runs through every state; from `title` on the
  client polls `live.json`; the socket opens at `deploy`.
- **One scene.** The menu, the turntable, pad selection, the transition and flight are the same renderer,
  loop and scene. The DOM menu sits over the live canvas at the live clock's time. There is never a video,
  a second canvas or a loading screen. Text sits on scrim-pass panels; contrast is checked over the
  brightest backdrop frame.
- **Screens**: title (live Earth at the dawn terminator, presence, feed ticker); identity (first Play
  only); hub with the lobby list; hangar and vehicle selection on a turntable with computed read-outs and an
  exploded stage view; site and pad selection over the live globe with pad states, local solar time, the
  launch-window readout and slot offers (live, cohort, window, a friend's clock); briefing and commit; My
  Ships (where, kept for how long and why, resume, track, rename, abandon); Universe ("How this universe
  works", rendered from `UniverseRules`, with the measured capacity report); Settings; controls reference;
  the flight menu, which overlays a live flight and states what happens to the craft if the player leaves.
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
- **Calibration** (first run, or when the adapter fingerprint changes; skippable; re-runnable): four
  scripted shots (pad dawn, lift-off, LEO terminator, cockpit) through the real renderer, a `LocalSession`
  and the scripted pilot, with the governor off and per-feature GPU timestamps. A solver picks the internal
  pixel cap and per-feature levels that maximise a perceptual weight under `0.85 x governor budget`, snaps
  to a named preset where it can, and confirms with a 3 s run. It also yields the `cpuScore` sent in hello.
  The calibration doubles as the warm-up of every pipeline.
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
  warns in an ephemeral profile.
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
  stamps beyond `clock(wall) + 0.25 s` are dropped. Account creation is limited per IP address per hour;
  `X-Real-IP` comes from Railway's edge.
- Object spam is bounded by ship slots, debris budgets, the per-lobby cap and expiry. Uninvited docking
  needs an armed port; a visitor is in free drift and can be released by the port's owner. Range safety
  protects other pads.
- Griefing that remains and is stated: ramming parked ships (allowed by the brief), parking debris near a
  station, forcing 1x for the seconds a predicted contact lasts. Input automation cannot be prevented and
  is not attempted. All state is public by nature.
- Secrets never reach the repository or the client (section 16.2); `node tools/dev/check-secrets.mjs` runs
  in CI and before commits by packages whose tools use keys. Chat is fixed phrases (decision 51).
- The nightly audit replays sampled journals on Modal and compares hashes with committed checkpoints: a
  mismatch is a server determinism bug.

---

## 27. Observability

- Railway caps logs at 500 lines per second per replica and sums metrics across replicas, so every role
  publishes its own numbers to the directory every second: per worker step time p50/p99/max, integrated
  and armed vessel counts, lag distribution, dilated islands, encode time; per gateway connections, bytes
  per second per tier, dropped frames, input lateness; directory transitions per second, screening time,
  batch commit latency, passive object count, pad queue; recovery durations.
- The API serves them as `GET /status.json` (public: players online, in flight, queue, build, rules
  version) and `GET /metrics` (Prometheus text, token-protected). An operator page under `/ops` (token)
  shows the same live.
- Logs are structured JSON lines with island, vessel, epoch and tick; every refusal a player sees has a
  reason code that is also logged.
- `event_log` is the audit trail and the source of the public feed.
- The client's net panel shows round trip, input margin, correction count and size, bytes per tier and the
  durable tick; `window.__test.net()` exposes the same to tests.
- Each load test writes `docs/capacity/<date>.md`; the latest numbers are published on the rules screen.

---

## 28. Test strategy

### 28.1 Unit (vitest, Node; every commit)

Unit tests next to the code and in `tests/unit/<package>/`; cross-language golden files for the bake
library; `tools/dev/boundaries.test.ts`; the secrets check. Added by v2: codec round trip exact in every
regime (ascent, touchdown with live friction anchors, entry with hot parts, a docked assembly), identical
continuation for 6,000 steps; an island of one equals v1's `stepVessel` bit for bit; merge then undock
restores every part pose and conserves linear and angular momentum to 1e-9; every stage separation of the
existing stack survives with contact on; two craft closing at 15.6 km/s never pass through each other at
any step phase; capture succeeds just inside and fails just outside each envelope limit; a dock at 30 AU
keeps relative speed noise under 1 mm/s; every body within its Horizons tolerance; `validateVehicle` and
`analyzeVehicle` against hand-computed values; gate classification tables; the benchmark solver.

### 28.2 Universe suites (`tests/universe`, headless, every commit)

- **Rules**: each of U1-U19 and the pad rules has a test that fails when the rule is removed.
- **Fuzz**: a model of the directory driven by thousands of random sequences of spawn, warp, jump, hold,
  link, admit, claim, dock, undock, logout, crash and expiry, checking after every operation: heads never
  decrease; one holder per vessel; no interaction between vessels on different clocks; no claim outside a
  solid window; no arrival inside the arrival range; pad slots never overlap; no vessel solid for a clock
  while overlapping one that was there first.
- **Lane equivalence**: one recorded input log through the real-time lane, the trailing lane in batches of
  30 and 240 ticks, and a mid-flight migration between workers gives identical state hashes.
- **Replay**: checkpoint plus journal reproduces the island's hash.
- **Adversarial cases, written failing-first**: park inside a recorded echo and log out (the victim ahead
  must not receive an overlapping solid vessel); repeated stranger claims must not move a ship beyond
  `liveTick + advanceLimit`; a fly-by within 1 km without contact leaves the passive head unchanged; a
  station-keeping neighbour at 100 m does not block a departure and a ram inside 30 s does; a jump arriving
  on a crossing path is refused; two linked pilots on crossing orbits at 100,000x are stopped by
  screening; a vessel that goes passive inside another clock's cleared interval shortens that clearance; a
  logout 130 s before a live-clock impact still produces the collision; two craft entering one port in one
  tick resolve identically in a live run and a replay; an SOI crossing during a group jump and during an
  island merge.

### 28.3 Mission (headless, `tests/mission`)

The Earth-Moon-return flight through `LocalSession` and the real `TerrainProvider` on real tiles, with the
gates of section 31.1, the golden hash, and zero incomplete terrain queries.

### 28.4 Separate processes with injected latency (`tests/net`)

A harness starts the roles as separate processes (or one process with all roles), a proxy that injects
delay, jitter and TCP-style stalls per client, and two to six headless `NetSession` clients driven by
scripted pilots. Matrix: 0, 50, 150 and 300 ms round trip; 0 and 5 % stalled sends of 200 ms.

| Scenario | Passes when |
|---|---|
| Concurrent launches from six pads | All reach orbit; no cross-pad interference without contact; pad states cycle; a seventh is offered a slot |
| Rendezvous and docking | Hard dock within the envelope; both clients report the same port offsets to 1 mm at the event tick; momentum conserved |
| Control sharing | Hand-over prompt round trip; non-helm inputs have no effect; a passenger stages their own craft; undock from each side |
| Collision at 2 m/s, 20 m/s and 1 km/s | Both clients receive the same event numbers; neither shows damage before the event |
| Warp | Private warp leaves the others untouched; proposal, follow, idle accept, refusal with reason; in-phase jump to a station; meet at a tick; advance for a visitor; departure notice; echoes never collide |
| Disconnect and reconnect | Drop mid-burn (latched 10 s, then throttle zero), mid-docking, as helm and mid-warp; resume inside the grace; the unattended run's outcome after it; a hidden tab keeps flying |
| Prediction quality | Count and size of corrections in ascent, entry and touchdown per latency; no visible correction in solo flight at 150 ms; no reversed outcome at any latency |
| Abusive client | Altered inputs, a fast clock, stamps in the future, withheld inputs before an encounter, floods: each is bounded or refused |

### 28.5 Real browsers (`tests/acceptance`, Playwright, real Chrome, real GPU)

Two Chrome instances with separate profiles against a local server, at 150 and 300 ms. The four stories are
scripted and assert on **what each player sees** (offset labels, the single offered action, lamps, numbers
that mirror each other, no reversed outcome), not only on state: (1) first launch with strangers on
neighbouring pads; (2) a station built by several people, with a helm hand-over; (3) two friends meeting in
lunar orbit by meet-at-a-tick and by in-phase jump; (4) one player back from Saturn finding hubs as echoes
with their offers. Plus the menu flow by keyboard only, the gate's block pages (and that the main bundle is
not requested), transition continuity, and calibration choosing Ultra on the reference GPU.

### 28.6 Restart, recovery and expiry

- Graceful restart during an ascent, a docking approach and with a three-craft assembly parked: every
  vessel identical by hash afterwards; clients resume.
- SIGKILL of a shard during a soft capture, during an ascent, between the commit of a dock and the island
  checkpoint, and during a soft capture on the live clock (the pad crowd must be mutually solid
  afterwards); SIGKILL of the directory during a claim and a dock (the transition is fully applied or
  absent). A shard frozen for 5 s after its islands were recovered elsewhere has its writes and events
  rejected.
- Stop everything, restore Postgres from the bucket dump, start: every passive ship and assembly is where
  its worldline says.
- Expiry on the staging rule set with an injected wall clock: every row of 15.5, including an assembly
  kept alive by one active owner and released when that owner lapses; the countdown shown matches the
  removal.

### 28.7 Load tests with simulated active players

- **Bots** are real `NetSession` clients with scripted pilots, headless in Node on Modal (about 50 per
  container), against a staged deployment on Railway. Each does what a player does: spawn, fly a real
  ascent with staging, circularise, warp; a share rendezvous and dock with a parked station; a share
  re-enter. Idle connections and HTTP requests do not count. At least one bot in ten runs full prediction
  and checks every correction; the rest may replay recorded input logs of real flights with jitter.
- **Ramps**: 50, 200, 500, 1,000, 2,000, 5,000 concurrent, each held 15 minutes; a two-hour soak at the
  highest level that held; a reconnect storm; a deploy under load; a forced shard kill at load. Mixes: pad
  storm, cruise-heavy, 20 % in docking pairs, the launch-day mix.
- **Measured and published**: step time per worker; integrated objects per worker thread at the admission
  threshold; dilated islands; gateway CPU per connection; bytes per second per player per tier as billed;
  directory transitions and screening time; Postgres batch latency; correction rate seen by predicting
  bots; players per shard when admission starts to queue; recovery time.
- The limit reported is the player count at which a service level breaks: more than 1 % of real-time ticks
  over 8.33 ms, a correction rate above one per player-minute, or admission queueing. If a level fails, the
  report says so and gives the level that held.
- The first load test (50-500 bots on stage A) runs before shard migration is relied on: it replaces the
  2.5x derating and decides how many shards a launch day needs.

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
| Baked data on disk | < 22 GB including caches |

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

### 29.2 Multiplayer and server budgets

| Budget | Target |
|---|---|
| Real-time island step, per worker | p99 <= 6 ms of the 8.33 ms tick at the admission threshold; utilisation <= 50 % |
| Client session per frame (prediction, replay, view build) | p99 <= 1.5 ms main thread at 1x with two vessels in the island; a 150 ms replay of ten vessels <= 2 ms |
| Corrections, solo flight at 150 ms round trip | none visible; fewer than one per player-minute above tolerance |
| Downstream per player | planning average 2.5 kB/s; hard cap 6 kB/s; upstream under 0.6 kB/s |
| Server CPU per connected player (derived; conservative) | 0.0055 vCPU normal mix, 0.0094 launch-heavy; 0.025 and 0.043 on `hosting.md`'s figure |
| One worker thread at 50 % (derived; conservative) | 100-125 integrated objects; 16 |
| One gateway vCPU (assumed) | 250-500 connections; 10,000 per service |
| Directory | 10,000 transitions a second; 100,000 vessels in 50 MB (assumed) |
| Graceful restart | nothing lost; universe back within 40 s |
| Crash | at most 250 ms of flight lost; islands back within 60 s at 5,000 integrated vessels |
| Menu DOM | 0.5 ms main thread per frame; scrim pass under 0.1 ms GPU |
| Calibration | under 30 s; transit about 10 s with no frame at or above 33 ms |
| Launch complex | 16 pads: 240-640 launches per universe hour |
| Remote vessels | full detail for up to 10 (Ultra); nameplates for 8 plus target, partners and own ships |

Bottlenecks in the order they bind: (1) pads, by a factor of 20 to 80 on a front-page day, relieved by
cohort slots and more pads; (2) sockets and fan-out (about a third to a half of all CPU on derived
figures); (3) real-time worker threads, only if the conservative figure is true (about 19 shard services
for a launch-heavy 5,000, about 12 with the trailing lane); (4) egress as a sustained cost; (5) one crowded
island (single-threaded; per-island dilation and the caps of 7.2); (6) directory screening against a
crowded low-orbit shell (estimated at 1-2 cores at 5,000 players, not measured); (7) terrain on shards;
(8) Postgres batches.

---

## 30. Cost model

List prices (`hosting.md`): Railway $20 per vCPU-month, $10 per GB-month, $0.05 per GB of service egress,
bucket egress free; Modal preemptible CPU $0.0000131 per core-second. "Derived" uses the measured step
costs with the 2.5x derating; "conservative" uses 0.03 vCPU per integrated vessel. Both hold the stated
concurrency for a whole month, with everything in the real-time lane and the shell on Railway. Every figure
is an estimate until the load test replaces it.

| Line | 20 players | 500 players | 5,000 players |
|---|---|---|---|
| Simulation, gateway, directory CPU (derived / conservative) | $8 / $16 | $65 / $260 | $575 / $2,520 |
| Memory | $15 | $60 | $290 |
| Postgres, volume, backups | $8 | $46 | $120 |
| WebSocket egress at 2.5 kB/s | $6 | $162 | $1,620 |
| Buckets, `edge` (shell and pack mirror) | $4 | $20 | $60 |
| Modal (audits, rehearsals) | $0 (inside the free credit) | $0-30 | $30 |
| **Total (derived / conservative)** | **about $45 / $50** | **about $355-385 / $550-580** | **about $2,700 / $4,650** |

- The Railway Pro fee ($20) includes $20 of usage and is not added. The shell on Netlify Pro instead adds
  about $20, $80 and $135-420 at the three levels.
- With the trailing lane on, solo downstream falls from about 2.2 to 0.4-1.9 kB/s: about $300-800 a month
  less at 5,000.
- **A front-page day** (5,000 concurrent for 24 hours, launch-heavy, 50,000 visitors, on top of a quiet
  month): about $105-140 derived, $215-255 conservative. Tile egress is $0 on the bucket path and up to
  $750 if that path fails on the day and tiles fall back to billed egress through `edge`.
- **Rehearsals**: a one-hour 5,000-bot run is about $13 on Modal plus about $9 on Railway; the whole
  rehearsal programme is about $100-150.
- **What the compute split costs**: simulating every attended vessel on the server instead of letting
  clients integrate solo flight costs $1-6 a day at 500 players and $20-100 on a 5,000-player day. The
  split was decided on authority, feel, deadlines and send rate (decision 30).
- Budget asked of the user (OPEN_QUESTIONS Q1): $100 a month standing, a $300 spike reserve (plus the $750
  tile worst case), $150 once for rehearsals. A sustained 5,000 players is a separate $2,700-4,650 a month
  decision (OPEN_QUESTIONS Q6).

---

## 31. Definition of done and acceptance flights

Done means a player can, in one browser session with no loading screens: launch from the pad, reach
orbit, fly to the Moon, land on real lunar terrain, lift off, return, survive reentry and splash down
under parachutes - flying every burn by hand - at 60 fps, with Earth and the Moon photoreal at every
distance (the other bodies may use the simple visuals of section 8.5, as the expansion allows), full
sound, and no placeholder, stub or TODO anywhere else. v2 adds the multiplayer, fleet, solar-system, menu
and capability requirements of 31.4.

### 31.1 Headless mission (vitest, `tests/mission`)

The scripted pilot flies `scenarios/lunar-direct` through a `LocalSession` (the in-process universe) and the real `TerrainProvider`
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

### 31.4 Flights and demonstrations added by v2

- **The Earth-Moon-return mission through a socket**: the scripted pilot as a `NetSession` client against a
  local server at 150 ms, spawning in a launch-window slot, with the same milestone gates evaluated on the
  server as objectives.
- **An interplanetary flight into orbit**: `meridian-albatross` flown by a scripted pilot from a pad to a
  bound capture ellipse about Mars under private warp, ending with the server's record showing a closed
  orbit about Mars; and an arrival at Neptune at 10,000,000x proving that the event clamps hold at the top
  level.
- **Concurrent launches, rendezvous, docking, undocking, collision, warp, disconnect and reconnect between
  separate clients under latency** (28.4, 28.5); **restart recovery and expiry** (28.6); **measured load
  limits** (28.7).
- **Deployed**: the public lobby on Railway, reachable from the repository's deploy pipeline, with freely
  selectable vehicles, persistent ships and assemblies, the menu, and automatic graphics setup.

Done for v2 means all of the above pass, the original definition of done still holds, and the capacity
report states honestly which load levels held.

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
| **More lobbies and regions** | The lobby is the unit of deployment; the client lists lobbies; a region is a lobby. |
| **Other sign-ins** | A credential row of another kind on the same account. |
| **Client-held authority** | Not a seam. The holder is the directory or an island; nothing else is defined. |
| **Transfer-window grids, moon-tour searches** | The API's planning endpoint and Modal batch jobs; the same answer for everyone at a tick is computed once and cached. |
| **Gamepad** | The menu's focus model is spatial. |

---

## 33. Work packages

The briefs are in `docs/WORK_PACKAGES_V2.json`; the order that keeps the tree green is in
`docs/MIGRATION_V2.md`.

- **Wave 3**: `core-v2` (contracts, vessel model, codec, the sweep), `world-data-bake` (body definitions,
  planet pyramids, the second site's region), `platform-delivery` (packs, buckets, CI, the Railway and Modal
  skeleton, first cloud measurements).
- **Wave 4**: `universe-core`, `wire-protocol`, `solar-system-sim`, `fleet-data`, `shell-menu`,
  `capability-settings`.
- **Wave 5**: `netcode-client`, `server-persistence`, `contact-docking`, `fleet-models-pads`,
  `planet-render`, `map-multiplayer`, `flight-hud-multiplayer`.
- **Wave 6**: `deploy-loadtest`, `acceptance-multiclient`.

Integration, the browser mission and visual QA are run by the lead between waves in `src/app`, including
the activation of the Sun-rooted body set after wave 4.

---

## 34. Main risks

| Risk | Mitigation |
|---|---|
| No capacity number is measured | The first load test runs on stage A before shards are relied on; every figure in sections 29 and 30 carries both the derived and the conservative value; the report replaces them |
| The sky is mostly echoes after the first warp | Live clock, range rule, cohorts, follow, meet, in-phase jump, attach at the live clock; the four stories are tested for legibility; the rule values are data and expected to move after play |
| Touchdown is where client and server can disagree visibly | Threshold watch drains lag; exact contact state on the wire; outcomes only on the server's event; its own tolerance tests |
| The refactor lands on a moving tree | `core-v2` alone owns the sweep in wave 3; a guard test proves the single-craft trajectory is bit-identical before the golden hash is re-baselined; `LocalSession` keeps every lab and the mission on the multiplayer path |
| Lanes and hand-overs add states | One step loop; `lagCap = 0` first; lane-equivalence and fuzz suites are commit gates; the deferred lane holds no attended vessel |
| The directory is a single writer and a single point of failure | It does event-driven work only; its crash freezes the universe for the recovery time and loses at most one batch; partitioning is on the scaling path |
| Pads saturate long before CPU | Cohort slots, launch-window slots, 16 pads at launch, pads as data |
| Bucket throughput under concurrent ranged reads is unproven | Measured in wave 3 by a Modal fleet; the `edge` mirror with CDN is the fallback; the OPFS cache keeps return visits off the network |
| Determinism is tied to one V8 build and CPU architecture | One pinned image for shards and audits; a build change takes the graceful path; a Node upgrade is a re-baseline |
| Railway has no autoscaler, no sticky routing, a restart on every deploy | Gateways own sockets; shards are services; the scale script; restart recovery is the normal deploy path |
| Server-side terrain | Height packs by range into an LRU; pads analytic; landings placed on warm shards; a stall is lag or dilation for one island |
| WebSocket over TCP in one region | Prediction hides stalls up to 500 ms; docking is slow by design; a quarter second of round trip in Asia and Australia is stated |
| Ground-level realism at two sites; clouds, tiles, corridor, landing data (v1 risks) | Unchanged from v1: arid coastal sites, landcover-driven detail, one march path, lifting capsule with roll rule, NAC region with calibrated procedural detail |
| Frame over budget with several launches in view | Other-craft detail cap, relevance cuts, the summed budget table, the governor before resolution scaling |
| Disk space on the development machine | Baked data is capped at 22 GB including the new bodies and the second region; raw downloads are deleted after a bake; packs are built to a separate, deletable directory |
