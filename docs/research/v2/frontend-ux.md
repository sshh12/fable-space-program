# Front end of the expanded game (research v2: frontend-ux)

Status: research for the v2 architecture (2026-11-11). Design only; nothing here is built. The binding inputs are
`PROMPT.txt` (including everything below `--- expansion ---`) and `docs/research/v2/user-decisions.md`. Where
they conflict with this file, they win. Where `docs/ARCHITECTURE.md` v1 is silent about the expansion, this file
proposes; the proposals become binding only when the v2 architecture adopts them.

Read before writing this: `PROMPT.txt`, `docs/ARCHITECTURE.md` (sections 1, 5, 10.5, 11-13, 16, 17),
`docs/RENDER_API.md` (sections 13 and 14: exposure, governor, attribution), `docs/handoff/flight-ui.md`,
`docs/handoff/map-view.md`, `docs/handoff/render-core.md`, `docs/handoff/cockpit.md` plus the cockpit brief in
`docs/WORK_PACKAGES.json`, `docs/handoff/sim-vessel.md` (the `public.ts` facade), `docs/research/webgpu-harness.md`
(sections 1 and 5), `src/core/contracts/{ui,controls,render,sim,defs,audio}.ts`, `src/core/gpu/device.ts`,
`src/render/core/post/governor.ts`, `src/render/core/renderer.ts` (default `QualitySettings`).

**Sibling designs this one depends on.** These are decided elsewhere in the v2 workflow: the multiplayer time model,
docking control rules, expiry rules, netcode transport, persistence and hosting. This file does not choose them.
It defines the UI-facing view models (`TimeView`, `ShipRecord`, `PadState`, `AssemblyView`, ...) that any of the
plausible choices can fill, and names the questions in section 15. When a sibling decision lands, only the
copy and the state lists inside these view models change. The screens and components stay as designed.

## 0. Measurements used in this file

Measured on this machine (Node 24, through `tools/dev/heavy.mjs --class=cpu`, with other agents' jobs running,
so these are upper bounds). Method: `makeOrbit` plus `propagateInto` from `src/sim/orbit/kepler.ts` over
seeded random orbits, 60-200 timed repetitions after warm-up, p50 and p95 per repetition.

| Case | p50 | p95 |
|---|---|---|
| 1,000 LEO orbits, one propagation each | 0.18 ms (180 ns per object) | 0.29 ms |
| 10,000 LEO orbits | 1.77 ms (177 ns per object) | 2.61 ms |
| 10,000 mixed orbits (LEO to lunar distance, e up to about 0.6) | 1.40 ms (140 ns per object) | 1.57 ms |
| Closest-approach scan of one pair over about three LEO orbits (2 x 2,000 samples) | 0.69 ms | 0.80 ms |

The timing script was a scratch file and is not committed. It used repo code only.

---

## 1. Decisions this research supports

| # | Topic | Decision | Why |
|---|---|---|---|
| F1 | One scene, one loop | The menu, the vehicle turntable, pad selection, the transition and flight are all the **same renderer, the same frame loop and the same scene**. The DOM menu sits over the live WebGPU canvas. New `CameraRig`s are added: `menu`, `turntable`, `transit`, `port` and `spectate`. They need no contract change because `ViewMode` is an open string. There is never a video, a still image, a second canvas or a loading screen. | PROMPT: "menu over a live Earth and space view", "seamless transition". ARCHITECTURE 10.0 already says "there is exactly one scene". |
| F2 | App shell is a state machine | `boot -> gate -> calibrate -> title -> hub(...) -> deploy -> transit -> flight <-> flightMenu -> leaving -> hub`. Side states are `queued`, `reconnecting` and `blocked`. Screens are DOM views of the state. From `calibrate` on, the renderer runs through every state; from `title` on, the network client does too. | Keeps transitions continuous. Every state has a test hook. |
| F3 | The capability gate runs before the main bundle | A small inline script in `index.html` (a few KB) checks for mobile, WebGPU, the adapter, required features and limits **before** the multi-MB app bundle and any tile data download. A failure shows a static block page. | Mobile and unsupported users must not download the game to learn that it cannot run. |
| F4 | Adapter class is judged by the benchmark, not by name | Production Chrome leaves `adapter.info.device` and `description` empty (webgpu-harness section 1). Only `vendor`, `architecture`, `isFallbackAdapter`, features and limits are reliable. Hard blocks are: mobile, no WebGPU, a fallback/software adapter, a missing required feature or limit. Whether an integrated GPU, an older card or a laptop is enough is decided by a **short benchmark on the real renderer**. | `looksIntegrated()` in `src/core/gpu/device.ts` tests the empty `description` string. In production that means every Intel adapter (Arc discrete included) counts as integrated, and every AMD iGPU passes. |
| F5 | The benchmark is the opening shot | On the first run, and again whenever the adapter fingerprint changes, a 20-25 s calibration flies four scripted shots (pad dawn, lift-off, LEO terminator, cockpit) through the real renderer, a **local-only** `Sim` and the scripted `Pilot`. Timings come from per-feature GPU timestamps (attribution mode). A solver maps them to a named preset and to each individual setting, then a 3 s confirmation run checks the result. The calibration is skippable and can be re-run from Settings. | Uses the per-feature breakdown that already exists (`PerfSnapshot.features`, `perfFeatures: true`). |
| F6 | Settings are declared by features | Each `RenderFeature` declares its quality knobs, their levels and a cost model (`FeatureQualityDecl`). The Settings screen and the benchmark solver are generated from those declarations. Presets are internal-pixel caps plus per-feature levels. The governor budget derives from the target frame rate. Each setting is marked `live` (applies next frame) or `rebuild` (applies after a 1-2 s re-initialisation under a fade, with no page reload). | New features (other planets, a future builder preview) add settings without touching the UI. `QualitySettings` today has six fixed fields. |
| F7 | Identity is an anonymous account behind a device key | Clicking Play for the first time creates an **account record** (the seam that user-decisions.md requires) that a non-extractable WebCrypto **ECDSA P-256** key in IndexedDB points at. Connecting is a signed challenge. The player picks a unique callsign in one field. A **recovery code** (100-bit, shown once, downloadable) and a **device-link code** (6 digits, 5 minutes) let another device bind its own key to the same account. No sign-in provider is built. Others can be linked to the account record later. | user-decisions.md: anonymous by default, sign-ins later through a seam, no ship migration. No cookies are needed, which avoids cross-site cookie problems when the API and the static host sit on different hosts. |
| F8 | Chat | **Quick-comms** (context phrases, works everywhere) plus **proximity text chat** (craft in the same encounter bubble, docked partners, or players on the same pad complex), with rate limits, a filter, mute, block and report. **No global chat at launch.** | At front-page-of-Hacker-News scale an anonymous global chat is a moderation job. Rendezvous coordination needs text, but only between people who are near each other. |
| F9 | No pause in multiplayer | The `pause` action (P) and Esc open the **flight menu**, which overlays a live flight. The craft keeps flying under its latched controls and SAS. The menu header says so ("ENGINES FIRING 100 %", "SUBORBITAL: IMPACT IN 6 MIN"). Leaving a flight first explains what will happen to the craft, computed from the snapshot. | The universe is server-authoritative. A pause that stops nothing would be a lie. |
| F10 | Navball target mode and the target model | `NavballMode` gains `'target'`, and Tab cycles orbit -> surface -> target (target only while one is set). `setTarget` takes a `TargetRef` (body, vessel, or docking port of a vessel). Relative speed, closing rate and relative prograde markers come from the sim's f64 state in the target's frame. | KSP parity. Docking precision anywhere in the solar system needs relative state computed in float64 by the sim, never by subtracting float32 positions in the UI. |
| F11 | One docking painter for HUD and cockpit | The docking alignment instrument and the target page are Canvas-2D painters shared by a HUD panel and new cockpit MFD pages (`MfdPage += 'target' \| 'docking'`). They read one new `Readouts.docking` block. The port camera is a `port` rig (kind `external`, attached to the vessel). | Same rule as v1: HUD and MFD render from shared models, so their numbers never disagree. |
| F12 | Nameplates are an overlay feature | Nameplates, distance markers and off-screen arrows are drawn by a `RenderFeature.drawOverlay` that reuses the map view's float64 `Projector`, analytic body occlusion and label atlas. They are not DOM elements per craft. Only the target card and the docking panel are DOM. | Sub-pixel stability at orbital distances is already proven in `src/map`. Hundreds of DOM transforms per frame would cost the main thread. |
| F13 | The map at mega-lobby scale is a census, not a snapshot | The map gets a server-streamed **element catalogue** per SOI: conic elements, an epoch and flags per object, sent only when they change (burns, staging, docking). Icons are propagated on the client (GPU compute or a worker, float32 is enough for icon pixels). Lines and precise markers are float64 on the CPU, only for a capped **relevant set** (own ships, target, docked partners, hovered, plus at most 32 others). Dense icons cluster. | The measured 140-180 ns per propagation makes 10,000 icons 1.4-2.6 ms per frame on the main thread, against a 0.5 ms UI budget. Broadcasting every object every frame is forbidden by PROMPT. |
| F14 | Map preview time | A timeline scrubber at the bottom of the map shows every body, the target and the relevant set at a chosen future time. It is computed from their conics and labelled PREVIEW until it returns to LIVE. Closest approaches are listed as pairs (own position and target position) with separation and relative speed, for the next three approaches across SOI changes. A **proximity plot** shows the exact relative trajectory in the target's LVLH frame. | Rendezvous with a moving target across SOIs. "Derive trajectories and intercepts from the actual simulation". |
| F15 | Rules are data from the server | The "How this universe works" screen, the expiry countdowns, the warp rules and the pad rules render from a versioned `UniverseRules` document served by the server. The client hard-codes no rule number. | PROMPT: rules are configurable and must be visible to players. |
| F16 | Vehicle capabilities are computed, never authored | Δv per stage (vacuum and sea level), TWR, crew, cockpit, docking ports, RCS Δv, heat-shield entry limit, chutes, legs, and a "can reach" ladder come from one pure function `analyzeVehicle(defs, vehicleOrDesign)` over the part data. The same function runs on the server. | A future ship builder produces designs that need the same read-outs and the same validation. Hand-written capability numbers would go stale. |
| F17 | Frosted panels without `backdrop-filter` | Menu panels that need a blurred backdrop get it from a renderer **UI scrim pass**, which samples the bloom pyramid that is already computed inside rectangles the layout publishes. CSS `backdrop-filter` over the canvas is banned. | `backdrop-filter` over a full-screen canvas runs in Chrome's compositor. Its GPU time is outside WebGPU timestamps, so the governor cannot see it, and at 4K it is costly. The bloom mips already exist, so the scrim costs about one fullscreen sample per panel pixel. |
| F18 | Compute split for UI work | Section 3.6 lists each UI computation with the side it runs on and its cost. In short: interactive predictions run on the client (own trajectory, one target's closest approaches, the proximity plot, launch windows, capability read-outs). Global work runs on the server (conjunction screening, roster, pads, rules, expiry). Shared expensive results (transfer-window grids, spectator feeds) are computed once on the server and cached for everyone. A client CPU score from the calibration shifts target predictions to the server for weak clients. | Required by user-decisions.md ("compute split as a first-class design decision with numbers"). |

---

## 2. Facts a designer must not miss

1. **The adapter name is not available in production.** `adapter.info.description` and `device` are empty
   strings without `--enable-webgpu-developer-features`. `looksIntegrated()` therefore misclassifies today:
   every Intel adapter is treated as integrated (`!/\barc\b/.test('')` is true) and the AMD iGPU regex never
   matches. Move the decision into the gate's classification plus the benchmark (F4). A WebGL
   `WEBGL_debug_renderer_info` string may be read **locally** as a hint for the copy on the block page ("your
   browser is using AMD Radeon(TM) Graphics"). It must never decide alone and never be sent to the server.
2. **`powerPreference` is ignored on Windows** (crbug 369219127). On hybrid laptops Chrome may run on the iGPU.
   The fix is a Windows setting (Settings > System > Display > Graphics > browser > High performance). The
   block page and the "below minimum" page must explain this step by step.
3. **WebGPU exists on phones.** Chrome on Android has shipped WebGPU since version 121. iPadOS Safari 26 has it
   and reports a desktop user agent (`MacIntel` with `maxTouchPoints > 1`). WebGPU being present is **not** a
   desktop check. The mobile test is `navigator.userAgentData.mobile`, plus the iPadOS rule, plus
   `matchMedia('(pointer: coarse)')` with no fine pointer. A missing `texture-compression-bc` (typical of
   mobile GPUs) blocks independently as a missing required feature.
4. **The first real gesture is precious.** The audio context resume, fullscreen and `navigator.keyboard.lock()`
   all need a user activation. The title's "press any key" exists for that reason. The menu is silent until
   then.
5. **Esc and the browser's Back.** While the keyboard lock (no arguments) is held in fullscreen, Esc reaches the
   page and the player leaves fullscreen by holding Esc. Without the lock, Esc leaves fullscreen and the page
   cannot rely on seeing the key. Listen to `fullscreenchange` as well. Mouse buttons 4/5 and the browser Back
   navigate history: trap them (`preventDefault` on their pointer/mouse up) and keep a history entry per menu
   level, so that Back means menu-back and never leaves the page mid-flight (the `beforeunload` guard remains).
6. **No default binding may use Ctrl, Alt or Meta** (ARCHITECTURE row 24, enforced by a unit test). Free keys for
   the multiplayer actions are B, O, V, Y and Enter (section 4.9). Chrome's F-keys are not safe: F5 reloads,
   F6 focuses the address bar, F7 toggles caret browsing, F11 is fullscreen, F12 opens devtools.
7. **Text over a live, HDR-tonemapped Earth is hard to read.** The bright limb and sunlit clouds sit behind the
   type. Every text block needs a scrim, a gradient vignette or a scrim-pass panel (F17), and contrast must be
   checked in the brightest backdrop frame, not the average one.
8. **Exposure cannot follow a fast dive.** Auto-exposure adapts at 2.5 EV/s toward brighter scenes and only
   0.8 EV/s toward darker ones (RENDER_API section 13). A dive from sunlit orbit (EV about 14-15) to a night
   pad lit by floods (EV about 3-6) would sit black for roughly 12-15 s. The transit rig must drive exposure
   explicitly (`CameraState.exposureHint`, section 10), or plan its path across the terminator early.
9. **Live craft are sub-pixel from the menu orbit.** At 800 km with a 60 degree vertical FOV over 1,440 px, one
   pixel is about 580 m across. A 70 m rocket is 0.12 px. "Live player craft" in the menu backdrop must show as
   telemetry markers, plus live events and an optional spectate shot, never as geometry the player is
   supposed to see from orbit.
10. **The snapshot assumes an active vessel.** `SimSnapshot.activeVesselId: string`, the readouts and the navball
    all describe one vessel. The menu, the spectator stream and the transit have none. Either
    `activeVesselId` becomes `string | null` (readouts and navball nullable), or the menu runs on a separate
    spectator view model. This is a contract change (section 10).
11. **Settings differ in when they apply.** Cloud steps and terrain px per quad are read every frame
    (`clouds.ts`, `terrain/feature.ts`), so they are live. `shadowResolution` sizes the `ShadowSystem` at
    construction. Cascade count, ocean FFT size and texture budgets also reallocate. The renderer needs
    `setQuality(profile)` with per-setting apply classes.
12. **Pipelines must exist before the transition.** First-run shader compilation on D3D12 takes seconds (Chrome
    caches the compiled blobs afterwards). Every feature must create all of its pipelines during `init`. A
    plume pipeline created at first ignition would hitch the launch the menu just made seamless. The
    calibration doubles as the warm-up of every pipeline.
13. **The governor budget is fixed at 11 ms** (`DEFAULT_GOVERNOR.budgetMs`). A player on a 120 Hz target, or on a
    weaker GPU that settles for 60 fps, needs the budget derived from the target frame period (about 0.66 x the
    period: 11 ms at 60 fps, 5.5 ms at 120 fps). The presets set ceilings. The governor keeps working inside them.
14. **`renderScaleMax` is relative to the display.** On a 4K display, `renderScaleMax = 1` means a 4K internal
    resolution, while the 5090 budget is stated at 1440p internal (TAAU 0.667). Presets must be **internal
    pixel caps** (a megapixel count), with the scale derived per display. Otherwise "High" means very
    different loads at 1080p and at 4K.
15. **Hidden tabs.** `requestAnimationFrame` stops in a hidden tab, and Chrome throttles chained timers in pages
    hidden for more than 5 minutes to about once a minute. WebSocket messages are still delivered. Keep-alive
    must be driven by the server, or run in a worker, and coming back to the tab is a resync from server state,
    not a client fast-forward.
16. **Irreversible commands need acknowledgement in the UI.** Attitude and throttle can be predicted locally.
    Stage, abort, undock, a control hand-over and accepting a warp proposal are server-confirmed: show a
    pending state ("STAGING...") until the acknowledgement arrives, and never show an outcome the server has
    not decided (PROMPT: no client-only outcomes).
17. **Pad time of day follows the shared clock.** The universe clock is shared, so a chosen pad may be in
    darkness. Every site card shows local solar time and sun elevation. Night launches are a feature, and the
    reason for fact 8.
18. **Version skew.** Client prediction, capability read-outs and the server sim must run the same sim code
    and the same `DefLibrary` (hash it). The hello handshake refuses a mismatch. The client then shows "A new
    version is ready" and reloads at the next hub visit, never in mid-flight.
19. **The current HUD font is a system font** (Bahnschrift with a fallback stack, nothing shipped). The menu
    needs a condensed display face on every platform, and the hand-over from menu type to HUD type should not
    change family. Ship one open-licence family (section 4.3) and move the HUD and the map label atlas to it.
20. **Incognito and site-data clearing destroy anonymous identities.** Ask for `navigator.storage.persist()`,
    detect a likely ephemeral profile (a small `storage.estimate()` quota), and keep nagging gently until the
    recovery code is saved.

---

## 3. Front-end architecture

### 3.1 App states

```
            +--------+   fail    +---------+
  load ---> |  gate  |---------->| blocked |  static page (section 9.7)
            +--------+           +---------+
                | pass
                v
         +-------------+  first run / fingerprint changed
         |  calibrate  |  (skippable; 20-25 s; real renderer, local-only Sim)
         +-------------+
                v
         +-------------+  first gesture: audio resume, fullscreen + keyboard lock request
         |    title    |  spectator connection opens here (read-only, no identity)
         +-------------+
                v
   +-------------------------------------------------------------+
   | hub: PLAY | HANGAR | MY SHIPS | UNIVERSE | SETTINGS          |  <- queued (admission) overlays any hub view
   +-------------------------------------------------------------+
        | Play -> identity (first time only) -> lobby -> deploy
        v
   +---------+  vehicle -> site/pad -> briefing -> COMMIT     (or RESUME a ship)
   | deploy  |
   +---------+
        v
   +---------+  camera transit + spawn handshake + terrain/pipeline gates
   | transit |
   +---------+
        v
   +---------+  <--- Esc / P --->  +------------+  (overlay; sim keeps running)
   | flight  |                     | flightMenu |
   +---------+                     +------------+
        |  leave (explained first)            ^
        v                                     | reconnecting overlays flight or hub
   +---------+                                |
   | leaving | -> hub (camera rises back to the menu orbit, no cut)
   +---------+
```

What runs in each state:

| State | Renderer | Network | Sim on the client | Input context | Audio |
|---|---|---|---|---|---|
| gate | not created | none | none | none | none |
| calibrate | yes, `governor=off`, fixed scale, attribution mode | none | local-only scenario Sim + scripted Pilot (never sent) | Esc = skip | silent until a gesture (no gesture yet) |
| title | yes, auto settings | spectator (1 Hz census of the menu region + ops feed) | spectator replica (rails propagation of the census) | any key/click = begin | after gesture: music bus |
| hub, deploy | yes | spectator, plus account channel once identified | replica + presentation-only display vessel (turntable) | `menu` | music + ui |
| transit | yes | pilot session opening (spawn or resume) | replica switching to pilot replica | `transit` (skip, nothing else) | stinger, then pad ambience |
| flight | yes | pilot session | pilot replica (prediction) | `flight` (v1 binding table + MP actions) | full game mix |
| flightMenu | yes | pilot session | unchanged | `menu`. Flight bindings are released: attitude goes neutral, throttle stays latched | game mix ducked -6 dB |
| reconnecting | yes, keeps predicting | retrying | prediction; rails exact, integrated dead-reckoned and fading | flight inputs disabled with a banner | unchanged |

### 3.2 Camera rigs added by the front end

All are `CameraRig`s with open mode strings (ARCHITECTURE section 12). Unknown modes behave as their kind.

| Mode | Kind | What it does |
|---|---|---|
| `menu` | external | A spectator eye fixed in the **Sun-Earth frame** above the dawn terminator, by default at 800 km over the terminator with the sun 8-15 deg behind the limb (rim light, airglow, city lights on the night side). It drifts slowly (0.2 deg/s yaw, 3 % distance breathing over 40 s). Earth rotates beneath at the real rate, at the universe UT. The eye is not on a Kepler orbit, so the composition holds at any UT. It reframes per screen with 1.2-2.5 s glides in log-polar space (the map rig's smooth step). |
| `turntable` | external | Frames the presentation-only display vessel placed about 3 bounding radii in front of the menu eye, sunlit, with Earth behind it. It orbits the vessel at 6 deg/s. Mouse drag overrides and resumes after 4 s idle. It frames for the layout's free area (lens shift, section 10). |
| `transit` | external | The menu -> pad (or -> resumed ship) flight of section 5.11. Piecewise log-altitude path, look-ahead target, exposure hints, gates. |
| `port` | external, attached to the vessel | The eye on the selected docking port's axis, looking out along it with the port's roll. Narrow FOV presets: 50, 25 and 10 deg. Audio is attached to the vessel. |
| `spectate` | external | Chase camera on another player's craft (read-only), used from the menu's live cam and from the map. It obeys the subject's opt-out. |

The `ViewManager` keeps its 0.6 s blends between flight rigs. The transit hands over to the chase rig with
`CameraRig.activate(from)`, as every v1 view switch does.

### 3.3 Presentation-only objects

The turntable vessel is built with the frozen facade (`assembleVessel` + `vesselPartSnapshots`, the way the
vehicle labs do it) into a presentation snapshot that the app merges into the frame's vessel list, flagged
`presentation: true`. Rules:

- It never reaches the network, the sim replica, collision or the map. Nameplates ignore it.
- Exploded staging view: a key or click walks `splitForStage` and shows the real separated geometry spaced
  along the stack axis with stage labels. This presents the stage stack in the KSP manner without a separate
  diagram.
- Removal happens only when it is off-screen (the transit turns away from it first), so the player never sees
  it fade.

### 3.4 Input contexts and bindings

`src/input` keeps one binding table per context: `menu`, `transit`, `flight`. Only `flight` reaches the
`FlightController`. Switching context releases all held keys, the same release-all as on blur.

Menu context (no Ctrl, Alt or Meta, like everything else):

| Action | Keys | Mouse |
|---|---|---|
| Move focus | arrows, W A S D (spatial navigation) | hover moves focus |
| Activate | Enter, Space | click |
| Back | Esc, Backspace, browser Back, mouse button 4 | right click on empty space |
| Previous / next top tab | Q / E (key caps shown at the ends of the tab bar) | click the tab |
| Secondary action on a card (e.g. "Track in map") | F | button on the card |
| Turntable rotate / zoom | J L / I K, Page Up / Page Down | drag / wheel |
| Exploded stages | X | button |
| Screen-specific actions (rename R, abandon Delete, reset settings R) | as shown in the prompt bar | buttons |

Flight context additions (proposal; `validateBindings` checks for conflicts):

| Action | Key | Notes |
|---|---|---|
| `flightMenu` (replaces the semantics of `pause`) | Esc, P | P stays so a locked or windowed Esc can never trap the player |
| `cycleTarget` | B | nearest relevant craft first; in the `port` view it cycles the target's ports |
| `toggleRoster` | O | player and craft list overlay |
| `dockingView` | V | toggles the `port` rig and the docking panel when the vessel has a port |
| `openChat` | Enter | text field; editable targets already reach no binding (flight-ui section 1) |
| `acceptPrompt` | Y | accepts the top prompt (control request, warp proposal). Declining is a click or the timeout. Y has no other meaning |
| `nameplateMode` | F2 (extended) | F2 cycles: full HUD -> HUD without nameplates -> HUD off |

### 3.5 Data flow additions

```
net client --(census, presence, pads, rules, feed, my ships, time)--> client stores (plain objects, versioned)
           --(pilot session: authoritative vessel states, events, acks)--> pilot replica (src/sim code, predicting)
pilot replica --> SimSnapshot (+ docking, target, time blocks) --> HUD, map, renderer, audio      (as in v1)
client stores --> menu screens (DOM), map census layer, nameplate feature, roster, rules screen
menu layout ---- panel rects ---> renderer UI scrim pass ('ui.scrimRects', section 10)
```

The menu screens read stores and never the network directly, so every screen can be tested against a recorded
store fixture (section 14).

### 3.6 Where front-end computation runs (the compute split)

Numbers are from section 0 (140-180 ns per Kepler propagation, 0.7 ms per 4,000-sample pair scan) and from the
v1 budgets (UI main-thread line 0.5 ms; map overlay CPU 0.39 ms p99 after the breakpoint re-use).

| Computation | Runs on | Cost / volume | Why there |
|---|---|---|---|
| Own trajectory prediction, maneuver-node editing | client main thread (the same `src/sim` predictor) | v1 budget | Instant feedback while dragging. The server re-derives on every executed burn. Nodes are persisted with the ship so a resume restores them (section 15 Q7). |
| Closest approaches of own planned path vs ONE target (3 approaches, across SOIs) | client worker | about 0.7 ms per update for three LEO orbits; recomputed on node drags at up to 30 Hz | Interactive. Needs the target's conic chain, which the census provides. |
| Proximity plot (relative trajectory in target LVLH) | client worker | 2 x 600 samples, under 0.3 ms | Interactive, same data. |
| Conjunction screening, all vs all (collision look-ahead, proximity warnings, interest management) | server | O(n log n) per SOI with sweep-and-prune on time-bounded swept volumes | The server needs it anyway for authoritative collisions and anti-tunnelling. Clients subscribe to their own conjunction list instead of computing n^2. |
| Census icon propagation | client GPU compute (> 500 objects) or main thread (<= 500 objects) | 10,000 objects: 1.4-2.6 ms per frame on the CPU, a single dispatch on the GPU (float32 relative to the focus body: 25 m error at 4e8 m, sub-pixel at map scale) | Too costly on the main thread at scale. Icons only need pixel accuracy. |
| Lines and precise markers for the relevant set (<= 40 objects) | client main thread, float64 | inside the v1 map line (0.39 ms p99 at 8 patches + 20 debris) | Exactness. The 0.3 px sampler is reused. |
| Nameplate projection (<= 64 plates) | client main thread, float64 | under 0.05 ms | Precision near docking. |
| Census delivery | server -> client | about 64 B per object (7 float64 elements + id + flags). Full sync of a 10,000-object SOI is 640 KB on map open. Deltas only on change: 500 players in flight with about 10 % burning gives about 50 updates/s, about 3.2 KB/s per subscriber | Server-side filters by SOI and category keep it bounded. |
| Roster, pad states, rules, expiry, lobby stats | server | small | Global and authoritative. |
| Vehicle capability read-outs (`analyzeVehicle`) | client (pure function), verified by the server | under 1 ms per vehicle | Shared code, so builder designs later are validated identically. |
| Launch windows per site for a target body | client (sim-orbits pure functions) | microseconds | Per player, cheap. |
| Transfer-window grids (Earth -> Mars porkchop, later) | server, computed once per body pair per sim-day and cached at the edge | seconds of CPU, shared by everyone | The same answer for every player at a given UT, so computing it once is the textbook offload. |
| Menu spectator feed | server replica, fanned out at 1 Hz | one stream for all idle menu viewers | Idle menu crowds at Hacker News peak must not load the authoritative sim. |
| Weak-client fallback | the client sends a CPU score (calibration) in hello. Below a threshold, the server returns target closest approaches with the conjunction list and the census rate drops | | "Optimally pick a balance": a 3x slower CPU would spend about 2 ms per closest-approach update. |

---

## 4. Visual language

### 4.1 What makes the Battlefield 1 front end distinctive

Battlefield 1 (DICE, 2016) is the reference the user named. Public writing on its menu is thin (see Sources:
a critique of its clutter, notes that it shipped as a shared front end for several titles, and that its deploy
screen is a live overhead view of the map rather than a static screen). The qualities below come from studying
the game's presentation and should be checked against capture footage before final art:

1. **A full-bleed in-engine backdrop**, slow and cinematic: a staged moment in the world, with a camera that
   drifts, never cuts and never shows its UI chrome.
2. **Large condensed uppercase type** used as an image. Screen titles are huge and tight. Labels are small,
   uppercase and widely tracked. Hierarchy comes from scale contrast, not from colour.
3. **A desaturated palette with one accent.** The backdrop carries the colour. The UI is near-white on dark
   scrims, with a single warm accent for focus and selection.
4. **Tile and card navigation.** Rows of large cards, each a picture with a title. Focus enlarges a card
   slightly and reveals a short description. A thin rule marks selection. Top-level tabs run across the top
   with prev/next key prompts at their ends.
5. **Restrained motion.** Short fades and slides, no bounce, a lot of stillness. The scene moves and the UI
   mostly does not.
6. **Operations-style presentation.** A campaign is shown as a sequence of sectors on a map of the front with
   a narrated briefing. The deploy screen is the live battlefield seen from above.
7. **Persistent key prompts** in a corner ("ESC BACK", "ENTER SELECT") and quiet, weighty UI sounds.
8. Its weakness, which we avoid: too many competing panels on the main screen. The critique cited in Sources
   counts six functional areas on one screen.

### 4.2 Translation into an original design: "Dawn Line"

The idea: the dawn terminator seen from orbit is our trench line. Every menu screen is a composition over
real Earth at its real time of day: the thin blue limb, airglow, city lights on the night side, the sunrise
arc. The UI is a mission-control board laid over that view. Nothing is copied from Battlefield's trade dress
(no fonts, logos, layouts or sounds of the game). The table names what we take and how it changes:

| Battlefield trait | Our version |
|---|---|
| In-engine cinematic backdrop | The live renderer at the universe UT. The subject of each screen (Earth limb, the turntable craft, the site region, a live player's launch) sits in the open right 55 % of the frame. |
| Condensed uppercase titles | Condensed display face, uppercase titles, wide-tracked labels, tabular numerals for every telemetry number |
| One warm accent on desaturated UI | "Terminator amber" (the navball reticle is already orange) on warm white, with a cool limb blue for data |
| Card rows with reveal on focus | Card rows whose image is a **real render of the real model** (thumbnails rendered at build time by the real renderer, reproducible, never painted placeholders) and whose focus state shows computed read-outs |
| Operations map of the front | The Universe tab's **live solar-system board**: bodies with counts of craft, players and stations, recent events as a ticker. The briefing screen shows a flight profile as a phase strip (ascent -> parking orbit -> transfer -> capture -> descent) with a Δv budget bar against the vehicle's Δv. It is informational only, never a prescribed mission. |
| Deploy screen as a live overhead map | Site and pad selection over the live globe, with occupied pads shown live |
| Corner key prompts | A bottom-right prompt bar generated from the active binding context (the same `keyLabel()` as the HUD key help) |

### 4.3 Typography

- **Family**: one open-licence (SIL OFL) superfamily with condensed widths and tabular figures, self-hosted as
  WOFF2 under `public/assets/ui/fonts/` (no font CDN at run time). Barlow plus Barlow Condensed is the first
  candidate (OFL, many weights, tabular figures). Saira and Saira Condensed are the alternative. About 220 KB
  covers Condensed 600/700, Regular 400/500 and Semi Condensed 500. Mono for codes (the recovery code, the
  build id): JetBrains Mono (OFL), about 60 KB, one weight.
- **Roles** (`u` = the HUD's unit, `min(1vh, 0.5625vw)`, 10.8 px at 1080p; every size has a pixel floor):

| Role | Face | Size | Tracking | Case |
|---|---|---|---|---|
| Wordmark | Condensed 700 | 9u | -0.01 em | upper |
| Screen title | Condensed 700 | 5.2u (floor 34 px) | 0 | upper |
| Card title | Condensed 600 | 2.6u (floor 20 px) | +0.01 em | upper |
| Section label | Semi Condensed 500 | 1.25u (floor 12 px) | +0.14 em | upper |
| Body | Regular 400 | 1.5u (floor 14 px) | 0 | sentence |
| Telemetry number | Condensed 600, `font-feature-settings: 'tnum'` | 2.2u / 1.5u | 0 | |
| Key cap | Semi Condensed 600 in a 1.6u rounded box | 1.15u (floor 11 px) | +0.06 em | upper |

- Numbers use the HUD formatters (`formatAltitude`, `formatDeltaV`, `formatDuration`, ...). There is one number
  rule in the whole game.

### 4.4 Layout grid

- **Safe frame**: the largest 16:9 rectangle centred in the viewport. The backdrop is always full bleed
  (ultrawide shows more Earth). UI lives inside the safe frame.
- **12 columns**, gutter 1.6u, outer margins 5u left and right and 4.5u top and bottom.
- **Anchoring**: content is left-anchored in columns 1-5 (screen title, card stack, lists). Columns 6-12 are
  left open for the 3D subject. The camera rig gets the free area's rectangle and frames the subject into it
  (lens shift).
- **Fixed bands**: the top bar (tabs plus status) is 7u tall. The bottom prompt bar is 4.5u. A status line sits
  above the prompt bar on the left (lobby, UT, ping).
- Minimum window 1024 x 600 CSS px. Below that, a "make the window larger" overlay appears. It is not a block.

### 4.5 Colour tokens

| Token | Value | Use |
|---|---|---|
| `--ink` | #ECE6DA | primary text (warm white) |
| `--ink-2` | rgba(236,230,218,0.64) | secondary text |
| `--accent` | #E8A14A | focus, selection, the active tab rule, primary button |
| `--data` | #7FB2E5 | information highlights, own-craft markers |
| `--warn` | #F2C14E | caution (expiring soon, degraded link) |
| `--alert` | #E5484D | danger (impact predicted, collision, block page headline) |
| `--ok` | #4CC38A | used sparingly (docked, saved) |
| `--scrim` | rgba(6,9,13,0.62) plus the scrim pass | panel backgrounds |

Marker classes are distinguished by **shape first, colour second** (colour-blind safe): own craft are chevrons,
other players' craft are diamonds, persisted unoccupied ships are hollow shapes, debris are dots, stations and
docked assemblies are squares, the target gets a bracket ring, and a craft on another timeline gets a dashed
outline.

### 4.6 Components

- **Tab bar**: tabs in Condensed 600 at 1.9u, with a 0.25u amber rule under the active one. Q and E key caps sit
  at the ends. The callsign, link quality and online count are on the right.
- **Card**: 4:5 or 16:9 image area (a live-render thumbnail), title, two lines of read-outs. Focus scales it to
  1.03, brightens the scrim by 8 % and grows a 0.2u amber rule along the left edge. Disabled cards are 40 %
  opacity with the reason as a line of text ("Pad complex full").
- **List row**: a 4.2u row with a left status glyph, primary text, right-aligned telemetry and a hover reveal of
  actions (key caps shown).
- **Read-out block**: a label over a number over a unit and sub-label. It always uses tabular figures.
- **Prompt bar**: generated from the context binding table, max five prompts, right-aligned.
- **Prompt card** (in flight): a top-centre stack under the time strip, at most two visible, with a countdown
  ring, Y key cap and buttons.
- **Panel**: scrim-pass background plus a 1 px hairline at 12 % ink. No rounded corners above 0.3u, no drop
  shadows.

### 4.7 Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `fast` | 120 ms | `cubic-bezier(0.2, 0, 0, 1)` | focus ring, hover |
| `base` | 220 ms | same | card reveal, panel in |
| `exit` | 160 ms | `cubic-bezier(0.4, 0, 1, 1)` | panel out |
| `screen` | 420 ms | same as `base` | screen change: the old content slides 2u left and fades, the new content arrives from 2u right |
| `camera` | 1.2-2.5 s | C-infinity smooth step (the view manager's) | camera reframing between screens |

Rules: animate only `transform` and `opacity` (compositor-only, no layout). Stagger list entries by 30 ms, at
most six. No bounce, no overshoot, no parallax that follows the mouse. The camera moves and the UI keeps still.
With `prefers-reduced-motion`, camera reframes become 0.6 s cross-blends of the same continuous path, the
drift stops, and stagger is off.

### 4.8 Sound

- New buses: `music` and `comms` (the `AudioBusName` contract gains them). UI sounds stay on `ui`.
- UI set: hover tick (about -30 dBFS, 20 ms, never more than one per 40 ms), select (a relay click with a soft
  low thump), back (a release), tab shift, deny, a prompt arrival chime, a chat blip (comms), and a transit
  stinger. Generated at build time with the audio package's existing pipeline (`tools/audio`, keys from `.env`
  in tools only), listed in `data/defs/audio/ui.json`.
- Music: an ambient score in the menu, ducked by 6 dB when a reading-heavy panel (rules, a long ship list) is
  open. It fades out over the last 3 s of the transit, when the pad ambience (wind, venting, pumps, from the
  real audio engine reading the spawned vessel) takes over. In flight music is off by default and can be
  enabled in settings. The licence of any generated or commissioned music is recorded with the asset.
- Nothing plays before the first gesture (fact 4).

### 4.9 Keyboard and mouse navigation model

- Every screen is fully operable with the keyboard alone. Spatial navigation moves focus to the nearest
  focusable element in the pressed direction (geometry from `getBoundingClientRect`, with cones of +-45 deg).
  Tab and Shift+Tab keep the DOM order for assistive technology.
- The mouse hover moves the same focus, so mouse and keyboard never show two highlights.
- A focus memory per screen: Back returns to the element that opened the screen.
- A gamepad is not required. Because the focus model is spatial, the Gamepad API can be added later without
  redesign.

### 4.10 Accessibility

- Text contrast at least 4.5:1 measured over the brightest backdrop frame of each screen (a test renders the
  backdrop at its brightest drift phase and samples behind each text box).
- The menu is real DOM with ARIA roles (tablist, listbox, dialog), so screen readers get the structure.
- UI scale setting 85-130 % (multiplies `u`), colour-blind safe marker shapes (section 4.5), a captions toggle
  for any narrated briefing, and a subtitle line for the prompts.

### 4.11 Performance rules for the menu DOM

- Main-thread budget: 0.5 ms per frame on average in the menu, measured the HUD's way (CDP task time,
  visible minus hidden).
- Text that changes (UT, online counts, countdowns) refreshes at most at `HUD_TEXT_HZ` (10 Hz) inside fixed-size
  boxes with `contain: size layout`.
- No CSS `backdrop-filter`, `filter: blur()` or `mix-blend-mode` over the canvas (F17). Blur comes from the
  scrim pass.
- Card thumbnails are WebP images rendered at build time. The only live 3D in the menu is the backdrop and the
  turntable.

---

## 5. Screens

Wireframes are 16:9 safe-frame sketches. `[K]` is a key cap. The live scene is under everything.

### 5.1 Boot and capability gate

The inline gate script runs before the main bundle loads (F3). The page is black with the wordmark and one
status line. On a pass it lasts 50-400 ms (adapter request, device creation), so the screen usually shows only
the wordmark.

```
+------------------------------------------------------------------------------------+
|                                                                                    |
|                                                                                    |
|                              FABLE SPACE PROGRAM                                   |
|                         checking your graphics hardware                            |
|                                                                                    |
|                                                                                    |
+------------------------------------------------------------------------------------+
```

States: `checking -> pass | blocked(reason)`. Section 9.1 lists the checks in order. On a pass the main
bundle loads, the renderer initialises, every pipeline compiles (fact 12), the boot terrain levels 0-3 and the
cloud map load, and then either the calibration starts or, if the stored result still matches the adapter
fingerprint, the title starts.

### 5.2 First-run calibration

This is the opening shot of the game, and a benchmark at the same time.

```
+------------------------------------------------------------------------------------+
| (live: the pad at dawn from 300 m, a vehicle on the mount, low sun, cloud deck)    |
|                                                                                    |
|                                                                                    |
|                                                                                    |
|                                                                                    |
|  CALIBRATING GRAPHICS FOR YOUR GPU                              [ESC] SKIP          |
|  shot 2 of 4 · lift-off · 14 s                                                     |
+------------------------------------------------------------------------------------+
```

- Shots (section 9.3): pad dawn, lift-off, LEO terminator, cockpit in LEO.
- Skipping uses a conservative seed preset (from the adapter class hint) and lets the governor adapt. The title
  shows "Calibration skipped · Run it in Settings".
- No audio unless a gesture has already happened (the gate page itself might have received a click).
- If the device is lost during a shot (a driver reset on a weak GPU), re-acquire the device, record "lost in
  shot N", and continue at Low with a note. Never loop.

### 5.3 Title

```
+------------------------------------------------------------------------------------+
| (live: Earth limb at the dawn terminator from 800 km; airglow; city lights; drift) |
|                                                                                    |
|  FABLE                                                     ● 1,284 ONLINE          |
|  SPACE PROGRAM                                               312 IN FLIGHT         |
|                                                                                    |
|                                                                                    |
|                          PRESS ANY KEY TO BEGIN                                    |
|                                                                                    |
|  ▸ ORION reached orbit · 412 × 398 km                 UT 2029-10-02 06:14:51       |
+------------------------------------------------------------------------------------+
```

- Live markers: craft in the field of view are small telemetry ticks (fact 9) with a 3-letter callsign on hover.
- Ticker: the ops feed (reached orbit, docked, landed on the Moon, splashdown, record altitude), 1 line,
  changing every 6 s.
- Any key or click starts the audio context, requests fullscreen and the keyboard lock (if the player declined
  fullscreen earlier, it is not asked again), and opens the hub.
- Server data: `presence.summary` (online, in flight), `feed` (last 20 events), spectator census of the menu
  region, `universe.ut`.

### 5.4 Identity (first Play only)

```
+------------------------------------------------------------------------------------+
|  PLAY                                                                              |
|  ____                                                                              |
|  CHOOSE A CALLSIGN                                                                 |
|  +-------------------------------+                                                 |
|  | KESTREL-41                    |  [ GENERATE ]      ✓ available                  |
|  +-------------------------------+                                                 |
|  3-14 letters, digits or hyphens. Shown above your craft to everyone.              |
|                                                                                    |
|  No sign-up, no email. This browser holds a key that is your identity.            |
|                                                                                    |
|                                                      [ENTER] CONFIRM   [ESC] BACK  |
+------------------------------------------------------------------------------------+
```

Then, once:

```
+------------------------------------------------------------------------------------+
|  SAVE YOUR RECOVERY CODE                                                           |
|  ______________________                                                            |
|      7KQ2-M9XD-4TPW-CC8H-R3NV                                                       |
|  [ COPY ]  [ DOWNLOAD .TXT ]                                                       |
|                                                                                    |
|  Lose this browser's data and this code is the only way back to KESTREL-41         |
|  and your ships. We cannot recover it for you.                                     |
|                                                                                    |
|  [ I'VE SAVED IT ]                                  [ LATER ] (reminders stay on)  |
+------------------------------------------------------------------------------------+
```

States: `idle -> checking(name) -> available | taken(suggestions) | invalid(reason) -> creating -> created ->
recoveryShown -> done`. The callsign is checked live after 300 ms of no typing. Server: `account.create(pubKey,
callsign)` returns `{ accountId, recoveryCode }`. The recovery code is shown once. The server stores only a slow
hash of it.

### 5.5 Hub

```
+------------------------------------------------------------------------------------+
| [Q]  PLAY   HANGAR   MY SHIPS   UNIVERSE   SETTINGS  [E]     KESTREL-41  ▮▮▮ 42 ms  |
|------------------------------------------------------------------------------------|
|  PLAY                                                                              |
|  ____                                                                              |
|  +------------------+  +------------------+  +------------------+                  |
|  | (live render)    |  | (map render)     |  | (live cam)       |                  |
|  | LAUNCH           |  | RESUME           |  | SPECTATE         |                  |
|  | Pick a craft and |  | 3 ships waiting  |  | 2 launches now   |                  |
|  | a pad. Fly.      |  | Meridian 3 · LEO |  | ATLAS docking    |                  |
|  +------------------+  +------------------+  +------------------+                  |
|                                                                                    |
|  LOBBIES                                                                           |
|  ● SOL · PUBLIC UNIVERSE 1     1,284 / 5,000 · 312 flying · ships kept 14 d  ▸     |
|                                                                                    |
|  SOL-1 · UT 2029-10-02 06:14 · build 0.9.3              [ENTER] SELECT  [ESC] BACK |
+------------------------------------------------------------------------------------+
```

- Play holds the three entry points and the lobby list (with one entry now; section 6.4). Selecting the lobby
  row opens the lobby details (players, rules summary, region, status). Launch and Resume act on the current
  lobby.
- Hangar is the fleet browser. Its vehicle cards open the same vehicle screen as the deploy flow, without the
  pad step.
- Status line: lobby, UT, build. The online count and the link bars refresh at 1 Hz.

### 5.6 Lobby details and admission queue

```
+------------------------------------------------------------------------------------+
|  SOL · PUBLIC UNIVERSE 1                                                           |
|  _______________________                                                           |
|  STATUS   OPEN            REGION  us-west (42 ms)        BUILD  0.9.3 ✓             |
|  ONLINE   1,284 / 5,000   FLYING  312   SHIPS SAVED  9,412   STATIONS  17            |
|  UT       2029-10-02 06:14:51 (shared clock, real-time rate)                         |
|                                                                                    |
|  RULES AT A GLANCE                                       [F] FULL RULES            |
|  · Ships are kept 14 days after you last fly them; docked to an active station: kept |
|  · Collisions are real; damage is shared and permanent                             |
|  · Time warp: (time-model summary from UniverseRules)                              |
|                                                                                    |
|  PLAYERS (nearby first)                          [O] ALL   search _______          |
|  ORION        flying · LEO 412 km                                                   |
|  VEGA         docked · ATLAS station                                                |
|  ...                                                                               |
|                                                   [ENTER] JOIN   [ESC] BACK        |
+------------------------------------------------------------------------------------+
```

Queued state (admission control when the lobby is at capacity):

```
|  QUEUED FOR SOL-1 · position 214 · about 3 min           [ESC] LEAVE QUEUE          |
|  You can browse the Hangar and Settings while you wait. We will chime when you're in.|
```

States: `open | queued(position, eta) | full-no-queue | maintenance(eta) | incompatible(build)`. Server:
`lobby.list`, `lobby.details(id)`, `lobby.join(id) -> admitted | queued`, `queue.update`, `rules(version)`,
`roster.page(filter, cursor)`.

### 5.7 Deploy: launch or resume

Launch goes to vehicle -> site/pad -> briefing. Resume goes from My Ships (section 5.12) straight to the
transit, with a log-space camera flight to wherever the ship is (section 5.11). Resume is refused with a reason
when the ship is flown from another session, when it is part of an assembly whose pilot in command is
connected (it then joins as crew, section 7.5), or when it is in a time state the time model forbids joining.

### 5.8 Vehicle selection (turntable)

```
+------------------------------------------------------------------------------------+
| [Q]  PLAY   HANGAR   ...                                         KESTREL-41  42 ms  |
|------------------------------------------------------------------------------------|
|  CHOOSE A CRAFT                         |                                          |
|  ______________                         |        (live: the real model,            |
|  [ALL] LAUNCHERS  CREW  LANDERS  CARGO   |         sunlit, Earth behind,            |
|                                         |         turntable at 6 deg/s)            |
|  > MERIDIAN LUNAR        3 crew         |                                          |
|    MERIDIAN ORBITAL      3 crew         |                                          |
|    KITE (single stage)   uncrewed       |                                          |
|    ...                                  |                                          |
|                                         |                                          |
|  MERIDIAN LUNAR                                                                     |
|  Δv 15,240 m/s vac · 11 stages · TWR 1.38 at the pad · 3 crew · cockpit             |
|  ✓ LEO  ✓ Lunar orbit  ✓ Lunar landing and return  ✗ Mars capture                   |
|  Docking: 1 apex port (size M) · RCS Δv 62 m/s · heat shield to 11.2 km/s · chutes  |
|                                       [X] STAGES  [DRAG] ROTATE  [ENTER] CHOOSE      |
+------------------------------------------------------------------------------------+
```

- Data: the `DefLibrary` (the client already has it) plus `analyzeVehicle()` (F16). The "can reach" ladder uses a
  Δv map computed from `BodyDef`s (Hohmann transfer plus fixed loss allowances per body for ascent and descent,
  stated as estimates in a tooltip: "Estimate from a two-impulse transfer with 1,600 m/s ascent losses").
- The explode view (X) walks the stage stack with `splitForStage` (section 3.3).
- The future ship builder slots in here: a `DESIGNS` filter tab whose entries are validated designs. They are
  VehicleDefs too, with `analyzeVehicle` read-outs and a validation badge. The screen does not change.
- Data from the server: optional per-vehicle popularity ("41 flying now") and a server-side availability flag
  (a vehicle may be disabled by `UniverseRules`).

### 5.9 Site and pad selection

The camera glides (2.5 s) from the turntable to about 2,500 km above the site region. The backdrop is now the
live globe. Sites are markers on it.

```
+------------------------------------------------------------------------------------+
|  CHOOSE A PAD                           |      (live globe; site markers; live      |
|  ____________                           |       ticks of craft in ascent nearby)   |
|  KA LAE PACIFIC SPACEPORT · Hawai'i     |                                          |
|  local 06:14 · sun +4° · dawn          |               ◆ LC-1  ◆ LC-2              |
|   LC-1   ● OCCUPIED  ORION · T+ hold 02:10  [F] WATCH                               |
|   LC-2   ○ FREE                                                                     |
|   LC-3   ◌ COOLING DOWN  0:41                                                       |
|  (OTHER SITE) · ...                                                                |
|  local 18:02 · sun +11°                                                            |
|   ...                                                                              |
|  TARGET (optional)  [ MOON ▾ ]  next plane crossing from LC-2: 0:46:12 · az 99.4°   |
|                                                  [ENTER] RESERVE   [ESC] BACK       |
+------------------------------------------------------------------------------------+
```

- Pad states (from the server): `free | reserved(byYou, holdUntil) | reserved(other) | occupied(callsign,
  vesselId, phase: onPad/countdown/liftoff) | coolingDown(until) | closed(reason)`. Watch (F) moves the camera to
  a spectate view of the occupied pad. The spectate shot shows the real vessel standing there.
- The local solar time and sun elevation per site are computed on the client from the universe UT.
- Launch window for the optional target: sim-orbits launch-window maths per pad (client). Setting a target
  here sets it on the spawned vessel (`setTarget` after spawn).
- Reserving a pad starts the prefetch: the pad's position becomes a `LodObserver` (high-detail terrain
  streams while the camera is still in orbit). The vehicle's models are already built by the turntable. The
  reservation holds for the briefing plus the transit (for example 90 s, a `UniverseRules` value). It expires
  with a toast if the player leaves.
- Server: `pads.subscribe(siteIds)` (state stream), `pad.reserve(siteId, padId, vehicleId) -> reserved(holdUntil)
  | refused(reason, alternative)`.

### 5.10 Briefing and commit

```
+------------------------------------------------------------------------------------+
|  BRIEFING · MERIDIAN LUNAR · LC-2                                                  |
|  ________________________________                                                  |
|  CRAFT NAME   [ Meridian 4            ]          CREW  K. Ward · S. Mbeki · J. Ito  |
|  START VIEW   ( ) COCKPIT   (•) CHASE                                              |
|                                                                                    |
|  FLIGHT PROFILE (estimate, for target MOON)                                         |
|  ASCENT ──── PARKING ORBIT ──── TLI ──── LOI ──── DESCENT ──── ... ──── ENTRY       |
|  Δv needed ~12,900 m/s   ▕██████████████████████▏▕███░░░▏ craft 15,240 m/s          |
|                                                                                    |
|  RULES THAT APPLY: pad hold 10 min after spawn · collisions on · ships kept 14 d    |
|                                                                                    |
|                                         [ENTER] LAUNCH   [ESC] BACK                 |
+------------------------------------------------------------------------------------+
```

Commit sends `spawn(vehicleId, padId, name, startView)` and starts the transit at once. The server's spawn
acknowledgement is awaited inside the transit (section 5.11, gate G1).

### 5.11 The transition: menu orbit -> pad -> chase or cockpit

Timeline for a launch (normal speed; skipping compresses it to about 2.5 s, still continuous):

| t (s) | Camera | UI | Audio | Gates |
|---|---|---|---|---|
| 0.0-1.2 | Pull back 30 % from the turntable vessel and turn toward the site. The display vessel leaves the frame and is removed off-screen. | Briefing panels exit (160 ms), the prompt bar shows only `[SPACE] SKIP` | stinger begins, music starts its fade | spawn request in flight |
| 1.2-4.0 | Segment A: 2,500 km -> 100 km over the site. Log altitude with an eased start. The look-ahead target is the site and the horizon stays in frame. | the site name and pad title fade in, lower left | low drone | |
| 4.0-7.0 | Segment B: 100 km -> 3 km, slower in log space so the cloud deck crossing at 1-12 km takes about 1.5 s (volumetric clouds seen from inside) | "LC-2 · PAD CLEAR · WIND 6 m/s" | wind layer through the cloud crossing | **G1**: spawn acknowledged with the vessel state. **G2**: pad terrain resident (`TerrainProvider.residency()` final at the pad). **G3**: the renderer idle for the vessel's models. If any gate is open at 3 km, the camera enters a **holding drift** (a slow 0.5 deg/s orbit of the site at 3-5 km, looking at the pad) with a status line ("Securing range · terrain 87 %"). It is never a loading screen. |
| 7.0-9.5 | Segment C: 3 km -> the chase rig's starting pose (`VehicleDef.cameras.chase.defaultDistance`), decelerating | the HUD fades in over 0.6 s once the camera settles | pad ambience from the real engine (venting, pumps); music gone | |
| 9.5-10.1 | `ViewManager` takes over: `chase.activate(transitCamera)`. If the player chose cockpit, the normal 0.6 s blend to the cockpit runs. | control is enabled; first-flight hint card ("[SHIFT] throttle · [SPACE] stage") | cabin mix if cockpit | |

- **Exposure** (fact 8): the transit rig sets `exposureHint { targetEv100, rateEvPerS }` along the path. It
  ramps from the orbit EV to the EV that the photometric prior predicts at the pad (sunny 16 by day, a
  flood-lit prior at night) over segments B and C, so auto-exposure is already in place when metering takes
  over.
- **Precision**: the path is computed in float64 in the site's body-fixed frame (the pad rotates with Earth at
  439 m/s), then converted to ROOT. That avoids an inertial path that would leave the pad behind.
- **Terrain**: the observer at the pad existed since the reservation (section 5.9). The camera's own observer
  descends with it. Morph-in rules make nothing pop (ARCHITECTURE 7.3).
- **Resume transit**: the same rig flies a log-distance arc from the menu eye to the ship: out to the scale
  that frames both points (for a ship at Mars, up to about 1e11 m: the solar system seen from above for about
  1 s), then in to the ship's chase pose. The duration scales with log(distance ratio), from 3 s for LEO to 9 s
  interplanetary. G1 becomes "session attached to the ship".
- **Failure handling**: a spawn refusal (pad taken in a race) arrives during segment A. The camera re-targets to
  the alternative pad that the server offered, or rises back to the menu with an explanation card. A gate open
  for more than 20 s turns the holding status into "Still waiting for the server · [ESC] back to menu".
- **Leaving** (flight -> hub) is the reverse path: the chase pose -> up the log path -> the menu orbit, with the
  hub UI fading in at the end. Before it starts, the flight menu explains what happens to the craft
  (section 5.16).

### 5.12 My ships

```
+------------------------------------------------------------------------------------+
| [Q]  PLAY   HANGAR   MY SHIPS   UNIVERSE   SETTINGS  [E]                            |
|------------------------------------------------------------------------------------|
|  MY SHIPS                                         7 of 10 slots · debris 12 objects |
|  ________                                                                          |
|  NAME          CRAFT           WHERE                     LAST FLOWN  KEPT FOR       |
|  > Meridian 3  Meridian Lunar  Orbiting Earth 412×398 km  2 h ago     13 d 22 h     |
|    Lander A    (stage of M3)   Landed · Moon · Mare Tranq 3 d ago     11 d 4 h  ⚠   |
|    ATLAS-1     assembly (3)    Orbiting Earth 420 km      docked with active station · KEPT |
|    Kite 2      Kite            Suborbital · impact in 2 min (in flight elsewhere)  |
|                                                                                    |
|  Meridian 3 · 3 crew · Δv left 4,210 m/s · 2 maneuver nodes saved                   |
|  Kept because: you flew it 2 h ago. Kept 14 days after you last fly it.             |
|  [ENTER] RESUME   [F] TRACK IN MAP   [R] RENAME   [DEL] ABANDON                      |
+------------------------------------------------------------------------------------+
```

- `ShipRecord` from the server: `{ vesselId, name, vehicleId, isAssembly, members[], situation, bodyId,
  orbitSummary | surfaceLocation, crew, deltaVRemaining, lastFlownWallMs, expiry: { atWallMs | null,
  ruleId, reasonText, protectedBy?: string }, nodesSaved, sessionState: 'idle' | 'flownHere' |
  'flownElsewhere' | 'inAssemblyFlownBy(callsign)', timelineState }`. The clock that expiry runs on is the one
  the persistence design picks. The UI shows whichever clock `UniverseRules` names, in its words.
- The countdown turns `--warn` in the last 24 h and the row gets a ⚠. A daily digest toast on the title screen
  lists ships that will expire within 48 h.
- Abandon asks for confirmation and states the effect from `UniverseRules` ("becomes debris and is removed in
  48 h" or "is removed now").
- The map view of the ship opens with the map filters set to "My ships" (section 8).

### 5.13 Universe: "How this universe works"

Two halves. On the left, a live solar-system board: bodies with counts of craft and players, stations, and
the ops feed. On the right, the rules as short illustrated sections, rendered from `UniverseRules`:

1. **One shared universe.** The server simulates everything. What you see is what everyone sees.
2. **Time.** The time model in three sentences and one diagram (from the time-model design), plus what warp
   does near other craft. The current limits appear as numbers ("Warp is held within 50 km of another craft").
3. **Your ships stay.** Persistence, the slots, the expiry clock, what resets it, what protects a ship (for
   example docking with an active ship), what becomes debris and when debris is removed.
4. **Collisions are real.** Relative-speed thresholds, damage, and who is told about it.
5. **Docking and shared control.** Who flies a docked assembly, how control is handed over, and what happens
   when the pilot in command disconnects.
6. **Pads.** Reservation hold, the hold on the pad after spawn, the cool-down after lift-off.
7. **Fair play.** No cheats exist. The server decides outcomes. How to report a player.
8. **Capacity and status.** The current lobby load, the queue, maintenance windows. Measured capacity numbers
   are published here honestly.

Every number is a field of `UniverseRules`. Each section shows "Rules version 7 · changed 2 d ago", so players can
see when a rule changed. Server: `rules(version)` (cached) and `universe.board` (1 Hz while open).

### 5.14 Settings

```
+------------------------------------------------------------------------------------+
|  SETTINGS                                                                          |
|  ________                                                                          |
|  GRAPHICS   DISPLAY   AUDIO   CONTROLS   GAMEPLAY   ACCOUNT                        |
|                                                                                    |
|  PRESET   [ LOW ][ MEDIUM ][ HIGH ][•ULTRA ][ CUSTOM ]   chosen by calibration ✓   |
|  TARGET   60 fps   (display 144 Hz)                      [ RUN CALIBRATION ]        |
|                                                                                    |
|  RESOLUTION         2560 × 1440 internal (TAAU to 3840 × 2160)   ◂ ▸   live         |
|  DYNAMIC RES FLOOR  60 %                                         ◂ ▸   live         |
|  CLOUDS             ULTRA   1.3 ms                               ◂ ▸   live         |
|  ATMOSPHERE         ULTRA   0.9 ms                               ◂ ▸   live         |
|  SHADOWS            ULTRA   8 cascades · 2048                    ◂ ▸   restarts view 1 s |
|  TERRAIN DETAIL     ULTRA   1.5 ms                               ◂ ▸   live         |
|  OCEAN              HIGH    0.8 ms                               ◂ ▸   restarts view 1 s |
|  EFFECTS            ULTRA   1.3 ms                               ◂ ▸   live         |
|  OTHER CRAFT DETAIL HIGH    up to 6 nearby at full detail        ◂ ▸   live         |
|                                                                                    |
|  ESTIMATED GPU  ▕███████████████████░░░░▏ 9.6 / 11.0 ms   VRAM ~3.1 GB              |
|                                           [ENTER] APPLY   [R] RESET   [ESC] BACK      |
+------------------------------------------------------------------------------------+
```

- The rows are generated from feature declarations (F6). The ms figures are the solver's predictions from the
  calibration for the heaviest shot. The "estimated GPU" bar is their sum against the governor budget.
- Changes apply live over the menu scene. A "rebuild" setting re-initialises its feature under a 1 s fade of
  the backdrop.
- Display: fullscreen, UI scale, FOV (cockpit and chase defaults), frame-rate target (60 / display refresh),
  brightness (exposure compensation offset), reduced motion.
- Audio: master, music, effects, UI, comms; music in flight on or off.
- Controls: the binding table per context with rebinding (`validateBindings` blocks Ctrl/Alt/Meta and chord
  conflicts, and refuses a binding that would leave an action unreachable), mouse sensitivity, invert.
- Gameplay: nameplate density (all / nearby and targets / target only), chat (proximity on or off, filter
  strength), allow live cam on my flights (default on), units are SI (no imperial option; one number rule).
- Account: callsign (rename once per 30 days), recovery code (regenerate: invalidates the old one), link a
  device (shows a 6-digit code), devices list, delete account and ships (two-step).
- Persistence: graphics and display settings are stored locally per adapter fingerprint (section 9.6).
  Controls, gameplay and audio settings are stored locally and optionally synced to the account record (a
  small JSON blob) so a linked device inherits them.

### 5.15 Controls reference

It is generated from the binding tables (`keyHelpEntries`), grouped (Flight, Attitude, Staging, Views, Map,
Docking, Multiplayer, Menu). A keyboard diagram highlights the keys of the hovered group. The same data feeds
the in-flight key-help overlay (backquote). Keys that need the keyboard lock are marked "fullscreen only".

### 5.16 Flight menu and leaving a flight

```
+------------------------------------------------------------------------------------+
|  (live flight continues under a 40 % scrim)                                        |
|  FLIGHT MENU                                     ● LIVE · your craft keeps flying   |
|  ___________                                                                       |
|  ⚠ ENGINES FIRING 100 % · SAS PROGRADE                                             |
|                                                                                    |
|  > RESUME                                                                          |
|    SETTINGS                                                                        |
|    CONTROLS                                                                        |
|    UNIVERSE RULES                                                                  |
|    LEAVE FLIGHT                                                                    |
|                                                                                    |
|  If you leave now: Meridian 4 is suborbital and will reach the ground in 6 min.    |
|  (from the snapshot: patch endReason 'impact' -> time, location)                   |
|                                              [ENTER] SELECT   [ESC] RESUME          |
+------------------------------------------------------------------------------------+
```

The "If you leave now" line is computed from the snapshot and `UniverseRules`. It covers: a stable orbit (with
its periapsis), suborbital with an impact time, in atmosphere, on the pad (the pad is released), engines firing
(and what logout does to the throttle under the rules), docked (the assembly keeps its pilot in command, or
control passes as the rules say). Leave runs the reverse transit (section 5.11).

### 5.17 Connection states and reconnect

| State | Trigger | UI | Controls |
|---|---|---|---|
| `connected` | normal | link bars in the top bar | normal |
| `degraded` | RTT > 250 ms or loss > 5 % for 3 s | amber pill "UNSTABLE LINK 310 ms" | normal; the prediction-correction rate is shown in the net panel |
| `lost` | no server message for 2 s | banner "CONNECTION LOST · your craft continues on its last commands · reconnecting (2)" | inputs disabled and shown as such; the view keeps predicting (rails exact, integrated dead-reckoned and fading) |
| `reconnecting` | backoff 0.5, 1, 2, 4, 8, then every 15 s | attempt counter; after 60 s: [KEEP TRYING] [BACK TO MENU] | |
| `resynced` | session restored | the camera follows the corrected pose with a 0.3-1.0 s blend. A correction above about 5 m shows "RESYNCED" for 2 s | normal |
| `takenOver` | the same account attached from another tab or device | card "This flight is now flown from another session" [TAKE IT BACK] | none |
| `serverRestart` | server notice | "Universe restarting · your ships are saved · back in about 40 s" with a countdown | none, then resync |
| `versionMismatch` | hello refused | "A new version is ready" [RELOAD] (never forced mid-flight; during a flight the server keeps the old protocol for the session or ends it gracefully, per the netcode design) | |

Same-browser duplicate tabs are detected locally with a `BroadcastChannel` before the server has to arbitrate:
the second tab offers "Flying in another tab · [FLY HERE INSTEAD]".

---

## 6. Identity and lobby

### 6.1 Options considered

| Option | Friction | Persistence | Abuse resistance | Verdict |
|---|---|---|---|---|
| Sign-in only (OAuth/email) | high; loses a large share of Hacker News visitors at the door | strong | strong | no (user-decisions.md: not now) |
| Anonymous bearer token in localStorage | none | lost with site data; an XSS can exfiltrate it | weak | no |
| **Anonymous device key** (non-extractable WebCrypto key in IndexedDB) **+ callsign + recovery code + device link** | one field | lost with site data unless the recovery code is saved | an XSS can use the key while the page is open but cannot copy it | **yes** |

### 6.2 Recommended flow and seams

- First Play: generate an ECDSA P-256 key pair with `extractable: false`, store the `CryptoKey` in IndexedDB
  (structured clone keeps it non-extractable), and send the public key with the callsign. The server creates an
  **account record** `{ accountId, callsign, credentials: [{ kind: 'deviceKey', publicKey, label, addedAt }],
  recoveryHash, createdAt }`. Ships belong to `accountId`, never to a credential. That is the seam: a later
  GitHub or email sign-in is one more `credentials` entry, with no migration.
- Each connect: the server sends a nonce. The client signs `nonce || serverId || clientBuild`. The server
  returns a short-lived session token for that socket. No cookies, so it works when the static host and the API
  host differ.
- Recovery: entering the code on a new device binds its new key, and the server rotates the code (shows the
  new one). Device link: an existing device shows a 6-digit code valid for 5 minutes and the new device enters
  it.
- Ask for `navigator.storage.persist()` once the first ship exists. If the profile looks ephemeral
  (incognito: a small quota), show "This window forgets you when closed · save your recovery code" before
  Launch.
- Rate limits per IP and per key for account creation (Hacker News traffic brings scripts too). The server
  enforces a maximum number of accounts per IP per hour.

### 6.3 Callsigns

- Unique (case-insensitive), 3-14 characters `[A-Z0-9-]`, starting with a letter, shown in uppercase. Reserved
  words and a profanity list are checked on the server. One rename per 30 days, and the old callsign is held
  for 30 days so nobody can impersonate it at once.
- Shown above craft as `CALLSIGN · vessel name`. Player-named vessels go through the same filter.
- No discriminator tags: unique names read better on nameplates and are enough at this scale.

### 6.4 Lobby browser

A list component with one entry today. Each `LobbySummary` has `{ id, name, kind: 'public' | 'private' |
'event', region, rttMs (measured by the client), online, softCap, flying, shipsSaved, stations, ut,
timeModelSummary, rulesVersion, status, buildCompat }`. More lobbies later (regions, private universes, events)
need no layout change. A single entry stays a list row, not a hidden auto-join: players see that the universe
is one place.

### 6.5 Player list (roster)

- In the lobby screen and in flight (O). Sections: **Nearby** (same SOI, sorted by distance), **Docked with
  you**, **Everyone** (paged and searchable, since 5,000 rows are not sent at once).
- Row: callsign, status (`menu | onPad | flying | docked | warping | landed`), location summary ("LEO
  412 km", "Moon · landed"), timeline badge if not synchronised with you, link quality for players nearby.
- Actions: target (if targetable now), spectate (if allowed), mute, block, report.
- Block hides their chat and replaces their nameplate text with "BLOCKED PLAYER". Their craft stays physical:
  a block cannot remove a craft from a shared universe. The rules screen says so.

### 6.6 Chat

- Quick-comms: a list of about 16 phrases at the top of the chat panel. Enter opens the panel, the arrow keys
  pick a phrase and Enter sends it (digits are SAS keys in flight, so phrases have no number shortcuts). A
  click works too. Phrases are contextual ("Requesting docking at port 2", "Hold attitude", "Undocking in
  10 s", "Thanks", "Good luck"), localised, and need no moderation because they are fixed text.
- Proximity text chat: recipients are players with craft in the same encounter bubble (the time model's
  proximity group), docked partners, or players on the same site. 200 characters, 1 message per 2 s, filtered
  and reportable, kept on the server for 24 h for reports only.
- No global chat at launch. The ops feed gives the universe a voice without free text.

### 6.7 Reconnect

Section 5.17. The prediction keeps the world alive on screen, and the UI says plainly what is and is not
reaching the server.

### 6.8 "Your ships"

Section 5.12. On the map, persisted ships carry their expiry on hover. In flight, when a player flies near one
of their own persisted ships, the nameplate shows "YOURS · kept 13 d".

---

## 7. In-flight multiplayer interface

### 7.1 Nameplates and distance markers

Overlay feature `nameplates` (F12): the float64 projector from `src/map`, analytic occlusion by body spheres,
labels from the shared atlas, composited after tonemapping.

| Range to camera | Shown |
|---|---|
| < 2 km | full plate: callsign · vessel name, distance, relative speed with ▲ opening / ▼ closing, status glyph (docked, damaged, warping, other timeline) |
| 2-200 km | compact: callsign + distance |
| 200 km - SOI | diamond only; plate on hover or when targeted |
| off-screen target | edge arrow with distance and relative speed |

- Density cap: the nearest 8, plus the target, docked partners and own ships. Debris never gets a plate, only
  a dot within 5 km. The setting can reduce this to "target only".
- Plates do not occlude the target reticle. The 8-position de-cluttering of the map labels is reused.
- Precision: positions come from `rRoot` in float64 relative to the camera. Distance and relative speed are
  read from the sim's relative-state numbers, not recomputed from narrowed positions.
- A craft hidden behind the planet hides its plate (6 px soft fade at the limb, as on the map).

### 7.2 Target selection

- B cycles relevant craft nearest first. A click on a plate or on a craft in the scene picks it (the CPU picks
  in float64 against bounding spheres). The roster and the map can also target.
- `TargetRef = { kind: 'body', id } | { kind: 'vessel', id } | { kind: 'port', vesselId, portId }`. Targeting a
  port implies its vessel. In the port view, B cycles the target's ports, compatible ones first.
- A target card (DOM, right column) shows name, owner, distance, relative speed, closing rate, the next closest
  approach (T-, separation, relative speed), and the relative inclination for orbital targets.
- Server: target permission (always allowed; there is no stealth in v2) and the target's conic chain from the
  census.

### 7.3 Navball target mode

- Tab cycles orbit -> surface -> target (target only while a vessel or port is targeted). Within 2 km of a
  targeted vessel the mode switches to target automatically once, and the toggle still works afterwards.
- In target mode the speed read-out is the relative speed, the prograde and retrograde markers are relative
  velocity, and the target and anti-target markers keep their meaning. A small "TGT" tag sits on the speed box.
- The sim provides it: `NavballMode += 'target'`, `NavballMarkers.relativePrograde / relativeRetrograde`, and
  `Readouts.target` (section 10).

### 7.4 Docking: alignment instrument and port camera

`Readouts.docking` (computed by the sim in float64 in the own port's frame) = `{ ownPortId, targetVesselId,
targetPortId, compatible, range, rangeRate, lateral: {x, z}, lateralRate: {x, z}, misalign: { pitchDeg,
yawDeg, rollDeg }, corridor: { radiusAtRange, inside }, phase: 'approach' | 'contact' | 'capture' | 'hardDock'
| 'refused', refusedReason? }`.

```
+--------------------- DOCKING · APEX PORT -> ATLAS · PORT 2 (size M ✓) -------------+
|  RANGE  42.6 m        RATE  -0.21 m/s (closing)       CORRIDOR  ✓ 0.31 m of 2.1 m     |
|                                                                                    |
|            .  .  .  .  .  .  .  :  .  .  .  .  .  .  .     ROLL   +3.2°  ◂          |
|            .                    :                    .                              |
|            .          +--------(o)--------+          .     PITCH  -0.8°             |
|  - - - - - - - - - - -|         x    →    |- - - - - - - -  YAW    +1.1°             |
|            .          +---------+---------+          .                              |
|            .                    :                    .     LATERAL  X +0.12  Z -0.30 m |
|            .  .  .  .  .  .  .  :  .  .  .  .  .  .  .     DRIFT    X -0.02  Z +0.01 m/s |
|  o your port axis   x target port axis   → lateral drift (scaled)                   |
|  ● CONTACT   ○ CAPTURE   ○ HARD DOCK                        RCS ON · FINE ON        |
+------------------------------------------------------------------------------------+
```

- The scale of the cross is logarithmic in range (the crosshair box shrinks as the range closes, from 200 m to
  0). The lateral marker scale switches from metres to centimetres below 5 m range, with a label.
- Corridor: the allowed lateral error as a function of range (from the docking design, published in
  `UniverseRules`). It turns `--alert` when outside, together with a rate warning above the allowed contact
  speed.
- Port camera (V): the `port` rig, with a reticle overlay (a crosshair, the target port's projected outline,
  and a range and rate strip), FOV 50/25/10 with the wheel. In the cockpit, the same panel appears as MFD page
  `docking`.
- Phase lamps come from server events (contact, capture, hard dock). A refusal shows its reason ("Contact speed
  0.42 m/s > 0.30 m/s · bounced").

### 7.5 Docked assemblies and control hand-over

The control rule itself comes from the docking design. The UI below supports the likely model: one pilot in
command (PIC) flies the assembly, other owners are crew who can request control, and each owner can undock
their own vessel.

```
+-------------------------- ASSEMBLY · ATLAS-1 (3 vessels) -------------------------+
|  PILOT IN COMMAND  VEGA                                [REQUEST CONTROL]          |
|  ATLAS core        VEGA      (PIC)                                                 |
|  Meridian 3        you       docked at port 2               [UNDOCK]              |
|  Kite 2            ORION     docked at port 1 · offline 4 min                      |
+-----------------------------------------------------------------------------------+
```

- While another player is PIC, the HUD shows "VEGA IS FLYING · your inputs are off" in place of the throttle
  and attitude controls. The stage stack shows only your own vessel's stages (and whether the rules let you
  fire them while docked).
- Control request: a prompt card goes to the PIC: "KESTREL-41 requests control · [Y] GRANT · auto-deny 15 s".
  Granting moves PIC with a server acknowledgement and a toast to everyone in the assembly.
- PIC disconnect: the rule from `UniverseRules` (for example "control passes to the next connected owner after
  30 s"), with a countdown shown to the crew.
- Undock: one click with a confirmation if the assembly is under thrust or the port is under load. The
  separation impulse and momentum are server results. The UI only shows "UNDOCKING..." until the event arrives.

### 7.6 Time and warp indicators

The time model is a sibling decision. The UI defines `TimeView` (in the snapshot or the net layer) and shows
it in a **time strip**, top centre, which replaces the v1 clock/warp panel content (the MET stays):

```ts
interface TimeView {
  /** The clock this craft lives on, s since J2000, and the shared reference clock. */
  myUt: number;
  sharedUt: number;
  /** Current warp factor applied to me, and the highest I may request now with the reason it is limited. */
  rate: number;
  maxRate: number;
  limitedBy: { kind: 'proximity' | 'physics' | 'altitude' | 'rules' | 'group'; text: string; vesselIds?: string[] } | null;
  /** Relation of my timeline to the shared one (whatever the model calls it). */
  relation: 'synced' | 'ahead' | 'behind' | 'catchingUp';
  offset: number;                   // myUt - sharedUt, s
  /** The proximity group whose members must agree, if any. */
  group: { id: string; members: { vesselId: string; callsign: string; requestedRate: number; accepted: boolean }[] } | null;
  /** Pending warp proposals that involve me. */
  proposals: { id: string; from: string; rate: number; durationS: number | null; expiresAtWallMs: number }[];
  /** Action the model offers to get back in sync, if any (e.g. 'syncToShared', 'catchUp'). */
  syncAction: { id: string; label: string; etaS: number | null } | null;
}
```

Strip states:

```
 synced     UT 2029-10-02 06:14:51   ×1        ● IN SYNC · 3 NEARBY
 warping    UT 2029-10-02 09:41:07   ×1000 ▸▸▸  AHEAD OF SHARED TIME +3 h 26 m   [SYNC]
 held       UT 2029-10-02 06:14:51   ×1        WARP HELD · VEGA 12 km, ATLAS 31 km   [PROPOSE ×10]
 proposal   VEGA proposes ×100 for 14 min        [Y] ACCEPT · auto-decline 15 s
 catching   UT ... ×1 · CATCHING UP TO SHARED TIME · 41 s
```

- Every warp refusal names the reason and, if other players cause it, the players
  ("Cannot warp: VEGA is 12 km away and has not agreed").
- Nameplates and map icons of craft on another timeline get a dashed outline and a "+3 h 26 m" or "-12 min"
  tag. They are never drawn as if they were in the same present.
- The strip is a DOM panel at 10 Hz text refresh. The proposal card uses the prompt stack (section 4.6).

### 7.7 Collisions, proximity and damage feedback

- **Proximity warning** from the server's conjunction list (section 3.6): time to closest approach under 30 s,
  closer than the sum of the bounding radii times 3, closing faster than 1 m/s. Display: an amber edge pulse in
  the direction of the other craft, a tone, and "PROXIMITY · VEGA · 14 s · 3.1 m/s".
- **Contact and collision** events (new `SimEvent` kinds, section 10): `collision { otherVesselId, relSpeed,
  partsDamaged[], partsDestroyed[] }`. Display: a hull-silhouette damage panel for 6 s (lost parts red, damaged
  amber), camera shake proportional to the impulse in interior views (the cockpit's vibration channel), the
  audio impact event, and an ops-log line visible to both parties with the same numbers ("COLLISION · VEGA ·
  4.2 m/s · port 2 destroyed").
- Fairness: both players see the server's numbers. Neither client shows an outcome before the event.
- Debris made by a collision gets debris markers and appears in the owner's debris count with its removal time.

### 7.8 Ops log and quick-comms

A bottom-left, 4-line fading log: docking events, collisions, control changes, warp agreements, chat. Expands
to 12 lines on hover. Quick-comms opens from the same bar.

### 7.9 Flight HUD layout with the multiplayer elements

```
+------------------------------------------------------------------------------------+
|  MET 00:41:07            UT 2029-10-02 06:55  ×1  ● IN SYNC · 3 NEARBY   ▮▮▮ 42 ms |
|                          [prompt card: VEGA requests control · [Y] GRANT · 12 s]     |
|                                                                   +--------------+ |
|                         ATLAS-1 · VEGA                            | TARGET       | |
|                          38.2 m ▼0.21 m/s                         | ATLAS-1      | |
|                               [ ]                                 | 38.2 m       | |
|                                                                   | ▼ 0.21 m/s   | |
|  (v1 altitude, orbit, stage stack and resources stay where       | CA T-02:10   | |
|   flight-ui put them)                                             | 0.4 m        | |
|                                                                   +--------------+ |
|  ▸ VEGA: holding attitude                     (navball, SAS, throttle: v1)          |
|  ▸ DOCKED · ORION · port 1                                                          |
|  [ENTER] chat                                                                       |
+------------------------------------------------------------------------------------+
```

Layout rules: the multiplayer elements take the top centre (time strip and prompts), the right column (target
card and the docking panel when V is active), and the bottom left (ops log). Nothing moves the v1 panels. The
cockpit (interior) layout keeps the v1 minimal HUD plus the time strip and prompts. The rest is on the MFDs.

---

## 8. Map

### 8.1 Object classes and filters

Classes: own active vessel, own persisted ships, other players' active craft, persisted unoccupied ships,
stations and assemblies, debris, bodies, surface targets and sites.

Filter panel (left, collapsible):

```
SHOW          [✓] My ships  [✓] Target  [✓] Players flying  [ ] Persisted  [ ] Debris  [✓] Stations
WITHIN        ( ) this SOI   (•) 5,000 km of me   ( ) everything
ORBIT LINES   ( ) none   (•) relevant (cap 32)   ( ) all in SOI (cap 200)
TIMELINE      [✓] only craft in my present
SEARCH        [ Go to: ______________ ]  bodies, players, my ships, sites
```

The server applies the category and SOI filters to the census subscription. The client applies distance,
lines and timeline.

### 8.2 Scale

- The census streams conic elements, epoch and flags per object for the subscribed SOIs (section 3.6 gives the
  bytes and rates). Integrated craft (burning, in atmosphere) are sent as states at a rate set by relevance
  (for example 1 Hz far away and 10 Hz within 50 km), and their predicted conics.
- Icons: GPU-propagated instanced sprites (above 500 objects), clustered when closer than 14 px (a count badge
  that expands on hover and zooms on click). The relevant set is drawn the v1 way (float64, 0.3 px sampler,
  labels).
- Map overlay budget: v1 0.39 ms p99 CPU for 8 patches and 20 debris. The relevant-set cap (32 other lines plus
  own and target) is sized to stay within about 0.5 ms using the breakpoint re-use. The icon dispatch is GPU
  only.

### 8.3 Intercepts and closest approaches

- With a vessel targeted, the map shows the next **three** closest approaches over the planned (else the
  current) trajectory across SOI changes: a pair of markers (own position ● and target position ○ at that
  time) joined by a thin line, labelled "CA1 · T-3 h 12 m · 4.2 km · 31 m/s". The sim computes them (an
  extension of `targetClosestApproach` and of `closestApproaches`) from both conic chains. The target's chain is
  its current trajectory. Its planned nodes are private unless shared by its owner (an option for docking
  partners).
- A **target ghost** at the time of CA1, the way body ghosts are drawn at intercept today.
- While a node is dragged, the closest approaches update from the worker (about 0.7 ms per update, section 0) at
  up to 30 Hz.
- Body encounters keep v1 behaviour (at-intercept anchors per encounter).

### 8.4 Relative-motion view (proximity plot)

An inset (about 280 x 280 px, right side) available when own craft and target share an SOI:

```
+---------------- PROXIMITY · ATLAS-1 (LVLH) ---------------+
|                      R-bar ▲ (up)                         |
|            ·  ·  ·  ·  ·  ·  ┼  ·  ·  ·  ·                |
|                     ╭─────╮ │                             |
|  ◂ V-bar  ─ ─ ─ ─ ─╯ 5 min ╰─┼─ ─ ─ ─ ─ ─  ▸ (ahead)       |
|                     you ●    ○ target                     |
|            ·  ·  ·  ·  ·  ·  ┼  ·  ·  ·  ·                |
|  scale 2 km · ticks 5 min · dashed = after node           |
|  OUT OF PLANE  ▕──●──────▏ +120 m                          |
+-----------------------------------------------------------+
```

It samples both trajectories (2 x 600 samples, under 0.3 ms in the worker) and rotates the relative position
into the target's local vertical/local horizontal frame at each sample time. This is exact, not a
Clohessy-Wiltshire approximation. Auto-zoom runs from 10 m to 1,000 km. The planned trajectory after a node
is dashed.

### 8.5 Rendezvous planning with a moving target across SOIs

- The node editor is unchanged (v1 gizmo and panel). CA markers and the proximity plot react live.
- **Preview time scrubber**, bottom: drag a time cursor up to the end of the predicted chain. Bodies, the target
  ghost and the relevant set move to that time (from conics), and "PREVIEW T+3 h 12 m" replaces the live clock.
  [LIVE] or Esc returns. The prediction is the sim's own, so it is not decorative.
- Phase-angle help for an interplanetary target body: "Phase angle 43.7° · Hohmann ideal 44.3° · window in
  about 41 d", computed on the client (a later porkchop grid comes from the server, section 3.6). It is
  information, never an autopilot.

### 8.6 Solar-system navigation

- Zoom range grows from 1e5..2e9 m to **1e5..1e13 m** (beyond Neptune's orbit, about 4.5e12 m). The float64
  projector is unchanged. Zoom remains exponential and smoothed in log space.
- A breadcrumb at the top left (`SUN › EARTH › MOON`) is clickable. Each entry focuses that body.
- Focus glides scale their duration with the log distance ratio (1.1 s within an SOI, up to 2.5 s between
  planets), so long jumps do not disorient.
- Keys: Home = focus own vessel, End = focus target. "Go to" search (a click on the field; flight keys still
  work outside it). Double-click focus as in v1.
- Planets' orbits and SOI shells are always drawn at system scale. Bodies with placeholder visuals carry no
  special marker: placeholders are allowed by PROMPT and the map treats bodies generically.

### 8.7 Persisted ships on the map

Hollow class icons, a hover card with owner, last flown and kept-for, and actions (target, spectate if
allowed). Own persisted ships offer Resume when the player is in the hub's map. In flight, Resume requires
leaving the current flight first.

---

## 9. Capability gate and graphics settings

### 9.1 Gate checks, in order

| # | Check | Signal | Outcome on failure |
|---|---|---|---|
| 1 | Mobile or tablet | `navigator.userAgentData?.mobile`; UA patterns for iOS and Android; iPadOS (`platform === 'MacIntel' && maxTouchPoints > 1`); `(pointer: coarse)` with no `(any-pointer: fine)` | block: `mobile` |
| 2 | WebGPU present | `'gpu' in navigator` | block: `noWebGPU` (copy depends on the browser: an old Chrome or Edge gets "update", a Chromium with WebGPU off for this driver gets "update your graphics driver, check chrome://gpu", other browsers get "use Chrome or Edge") |
| 3 | An adapter | `requestAdapter({ powerPreference: 'high-performance' })` non-null | block: `noAdapter` |
| 4 | Not a fallback adapter | `adapter.info.isFallbackAdapter` (older Chrome: `adapter.isFallbackAdapter`) | block: `software` |
| 5 | Required features | `REQUIRED_FEATURES` (`float32-filterable`, `depth-clip-control`, `texture-compression-bc`) | block: `missingFeature(list)` |
| 6 | Required limits | `MIN_LIMITS` (2D texture 8192, 2048 array layers, 1 GiB buffer and storage binding, 32 sampled textures, 10 storage buffers, 8 storage textures, 64 colour bytes per sample, 4 bind groups) | block: `limit(name, have, need)` |
| 7 | Device creation | `requestDevice` succeeds | block: `deviceFailed(message)` |
| 8 | Support APIs | `OffscreenCanvas` in workers (terrain workers), `IndexedDB`, `WebSocket` (and `WebTransport` if the netcode uses it), `AudioContext` | block for the first three; audio missing = warning |
| 9 | Window | at least 1024 x 600 CSS px | overlay, not a block |
| 10 | Browser family | Chromium desktop (Chrome, Edge) is the supported target | other desktop browsers that pass 1-8 continue with a "not tested on this browser" banner (designer choice, section 15 Q11) |

The gate produces a `CapabilityReport { pass, reason?, vendor, architecture, features[], limits{}, browser,
mobile, displayPx, dpr, refreshHz (measured later), fingerprint }`. Only coarse fields (vendor, architecture,
browser major, a pass/fail reason) may be sent to the server, for capacity planning, and only as stated in
Settings > Account.

### 9.2 Adapter class

The classes are `discrete-high`, `discrete`, `integrated-likely`, `unknown`. They come from vendor and
architecture tables (for example `nvidia` with `blackwell`/`ada` = discrete-high, `intel` with an Arc
architecture = discrete, `amd` alone = unknown), the limits fingerprint, and optionally the local WebGL renderer
string (fact 1). The class seeds the preset used when the calibration is skipped and picks the block-page copy.
**The benchmark result overrides it.**

Required change: `acquireGpu` keeps its hard failures (no WebGPU, no adapter, fallback, missing features or
limits) but no longer throws on `looksIntegrated`. The gate reports the class instead.

### 9.3 Benchmark

Shots are `ScenarioDef`s (data) run by the **local-only** real `Sim` and the scripted `Pilot` (the lift-off shot
ignites and releases the clamps). The camera paths are scripted. Nothing goes to the network. Settings:
governor off, quality and resolution pinned, attribution mode on (`perfFeatures: true`, exact per-feature GPU
time).

| Shot | Scene | Measures | Settle + measure |
|---|---|---|---|
| S1 pad dawn | chase camera 300 m from the vehicle on the pad, low sun, cloud deck, ocean near field | terrain, rocks, structures, vehicle, ocean, atmosphere, clouds, shadows | 2 s + 3 s |
| S2 lift-off | the same pad at ignition and the first 6 s of flight | plumes, smoke, particles on top of S1 (the 10.95 ms checkpoint on the 5090) | 1 s + 4 s |
| S3 LEO terminator | 400 km over clouds at the terminator, city lights, limb | atmosphere and clouds from orbit, sky, terrain far | 2 s + 3 s |
| S4 cockpit LEO | the commander's seat, Earth in the side window | cockpit interior, glass, MFD uploads (CPU) | 1 s + 3 s |
| confirm | S2 again with the chosen settings, governor on | p95 GPU time against the budget, CPU frame | 3 s |

Total about 25 s (20 s when skipped early). Measurement rules follow RENDER_API section 14: timestamps per
pass, warm-up frames discarded, p95 per feature per shot. Without `timestamp-query`, use per-frame
`queue.onSubmittedWorkDone()` latency for the total and a coarser solver (presets only, no per-feature split).

Reference resolution: the shots run at `R0 = min(display internal, 2560 x 1440)` at Ultra levels. The solver
predicts the cost of each feature at each level and internal pixel count from cost models shipped as data and
measured on the reference GPU in the front-end wave:

```
cost_f(level, px) = measured_f(Ultra, R0) * ratio_f(level) * (px / px(R0))^e_f + c_f
   e_f ~ 1 for screen-space and half-resolution marches, ~0 for geometry-bound passes,
   ratio_f(level) and c_f from the reference-GPU table, refined online by the confirm run
```

The solver picks the internal pixel cap and the per-feature levels that maximise a perceptual weight
(resolution and clouds first, then shadows, terrain, effects, ocean) subject to
`sum_f cost_f(S2) <= 0.85 x governorBudget(targetFps)`. Then it snaps to the nearest named preset if every
setting is within one level of it (Custom otherwise), and runs the confirmation. If confirm p95 exceeds the
budget, it steps the most expensive feature down one level and confirms again (at most twice).

CPU: the main-thread frame p95 during S2 plus a headless run of 1,200 sim steps gives the CPU score (sent in
hello, section 3.6) and sets the CPU-side knobs (terrain worker count, MFD paint rate, nameplate cap).

Floor: if Low at 0.9 MP internal (1280 x 720) cannot hold p95 under 33 ms in S2, the result is
`belowMinimum`. The player gets the page of section 9.7 with "Try anyway (not recommended)". This is a warning,
not a block, because benchmarks are noisy (a laptop on battery, a background download).

### 9.4 Presets and settings

Starting values. The cost ratios are measured on the reference GPU in the front-end wave.

| Setting (code it drives) | Low | Medium | High | Ultra | Apply |
|---|---|---|---|---|---|
| Internal pixel cap -> `renderScaleMax = min(1, sqrt(cap / displayPx))` | 0.9 MP (1280 x 720) | 1.6 MP | 2.4 MP | 3.7 MP (2560 x 1440) | live (targets reallocate in 1/16 steps, as the governor does) |
| Dynamic-resolution floor (`renderScaleMin`) | 0.5 | 0.5 | 0.6 | 0.6 | live |
| Clouds (`cloudSteps`; march resolution) | 48, quarter | 64, half | 80, half | 96, half | live |
| Atmosphere (`atmosphereSteps`; aerial-perspective volume) | 12; 16 slices | 16; 24 | 20; 32 | 24; 32 | live |
| Shadows (cascade count, `shadowResolution`, PCF taps) | 4, 1024, 8 | 6, 1536, 12 | 8, 2048, 12 | 8, 2048, 16 | rebuild |
| Terrain detail (`terrainPxPerQuad`; rock density) | 14; 0.4 | 11; 0.6 | 9; 0.8 | 8; 1.0 | live |
| Ocean (FFT size; cascades) | 128; 2 | 256; 2 | 256; 3 | 512; 3 | rebuild |
| Effects (particle budget; plume and smoke march resolution) | 0.4; quarter | 0.6; half | 0.8; half | 1.0; half | live |
| Ambient occlusion (GTAO slices x steps) | 1 x 4 | 2 x 4 | 2 x 6 | 2 x 6 | live |
| Other craft detail (full-LOD remote vessels nearby) | 2 | 4 | 6 | 10 | live |
| Texture budget (vehicle and cockpit mip bias) | -2 | -1 | 0 | 0 | rebuild |

The v1 terrain default is `terrainPxPerQuad: 8`, so Ultra keeps today's look. The governor still lowers
`qualityScale` (0.5..1) and then the resolution within these ceilings. Its `budgetMs` becomes
`0.66 x 1000 / targetFps`.

### 9.5 Feature-declared quality (contract proposal)

```ts
interface FeatureQualityDecl {
  featureId: string;
  settings: {
    id: string;                     // 'clouds'
    label: string;                  // 'Clouds'
    levels: { name: 'low' | 'medium' | 'high' | 'ultra'; params: Record<string, number> }[];
    apply: 'live' | 'rebuild';
    costModel: { exponent: number; ratios: Record<string, number>; constantMs: number };
    weight: number;                 // perceptual priority for the solver
  }[];
}
// RenderFeature.quality?: FeatureQualityDecl ;  Renderer.setQuality(profile: QualityProfile): Promise<void>
// QualityProfile = { pixelCap, renderScaleMin, targetFps, levels: Record<settingId, levelName> }
```

### 9.6 Overrides, live preview, persistence and re-runs

- Any manual change makes the preset "Custom" and keeps the calibration's predictions on screen, so the player
  sees the cost of each choice.
- Stored in `localStorage['fsp.graphics.v1']` (wrapped in try/catch; private windows may refuse):
  `{ fingerprint, benchVersion, measuredAt, shots: {...per feature p95...}, cpuScore, profile, overrides }`.
- The fingerprint is a hash of vendor, architecture, features, limits, browser major version, display pixel
  count bucket and DPR. A mismatch re-runs the calibration at the next title. So does a bump of the benchmark
  version, a request from Settings, or three sessions in a row in which the governor sat at resolution floor
  for more than 30 % of flight time (a prompt: "Your settings may be too high · Recalibrate?").
- `?safe=1` starts at Low with no calibration (recovery after a crash), and the block page links it.

### 9.7 Block pages

A static page with no WebGPU and no large script, served by the gate at the same URL. One template, copy by
reason:

```
+------------------------------------------------------------------------------------+
|  FABLE SPACE PROGRAM                                                               |
|                                                                                    |
|  THIS NEEDS A DESKTOP COMPUTER                                                     |
|  The universe runs a true-scale solar system and live multiplayer on your GPU     |
|  through WebGPU. It is built for desktop Chrome or Edge with a dedicated            |
|  graphics card. Phones and tablets are not supported.                               |
|                                                                                    |
|  [ COPY LINK ]  [ EMAIL ME THE LINK ]                                              |
|                                                                                    |
|  (three still frames rendered by the game · live: 1,284 players online)            |
|                                                                                    |
|  ▸ Technical details                                                               |
+------------------------------------------------------------------------------------+
```

| Reason | Headline | What to do |
|---|---|---|
| `mobile` | This needs a desktop computer | copy or email the link |
| `noWebGPU` | Your browser has no WebGPU | Chrome or Edge, updated. If already current: update the graphics driver and check chrome://gpu |
| `noAdapter` / `software` | Your browser is not using a graphics card | graphics driver update. On laptops: Windows Settings > System > Display > Graphics > Chrome or Edge > High performance, then restart the browser |
| `missingFeature` / `limit` | Your graphics card is missing something this needs | the list, in plain words ("compressed texture format BC", "large textures"), and a copy-report button |
| `belowMinimum` (warning) | Your graphics card is below the minimum | the measured number ("23 fps at the lowest settings; the minimum is 30"), a plug-in hint for laptops, [TRY ANYWAY] |

"Technical details" lists the `CapabilityReport` and a copy button for bug reports. The page shows server
status (players online) from a public status endpoint, so a blocked visitor still sees that the game is alive.

---

## 10. Contract and data changes this front end needs

Proposals for the v2 contract revision (owners as the v2 architecture assigns them):

1. `SimSnapshot.activeVesselId: string | null`, with readouts, navball and staging nullable, or a separate
   spectator view model for the menu (fact 10).
2. `NavballMode += 'target'`; `NavballMarkers.relativePrograde/relativeRetrograde`;
   `PlayerCommands.setTarget(ref: TargetRef | null)`; `Readouts.target: { ref, name, ownerCallsign,
   distance, relSpeed, closingRate, relInclination, closestApproaches: { ut, distance, relSpeed, ownR, targetR,
   bodyId }[] } | null` (replacing `targetBodyId` and `targetClosestApproach`).
3. `Readouts.docking: DockingReadout | null` (section 7.4); `MfdPage += 'target' | 'docking'`.
4. `CameraState.exposureHint?: { targetEv100: number; rateEvPerS: number }` and `CameraState.lensShift?: [x, y]`
   (NDC offset for subject framing). The core honours both.
5. `QualityProfile`, `FeatureQualityDecl`, `Renderer.setQuality()` and a governor budget from `targetFps`
   (section 9.5). `acquireGpu` reports the adapter class instead of throwing on `looksIntegrated`.
6. `ButtonAction += 'flightMenu' | 'cycleTarget' | 'toggleRoster' | 'dockingView' | 'openChat' | 'acceptPrompt'`;
   binding tables per context (`menu`, `transit`, `flight`).
7. `MarkerKind += 'targetApproach'` with `Marker.otherVesselId` and the pair positions.
8. `SharedResourceMap` key `'ui.scrimRects'` (up to 16 rectangles in CSS px with a blur level and a tint) and a
   core scrim step in the tonemap pass that samples the bloom pyramid.
9. `AudioBusName += 'music' | 'comms'`.
10. `MapView` takes a census view (`update(..., census: CensusView)`), a filter state, a preview time, and a zoom
    range up to 1e13 m. Focus refs include sites and players.
11. `TimeView` (section 7.6) in the snapshot or the net client's store.
12. `SimEvent += collision | docked | undocked | controlTransferred | proximityWarning | padReleased`.
13. `analyzeVehicle(defs, vehicleOrDesign): VehicleCapabilities` as a pure module under `src/sim` (shared with the
    server), with the Δv map from `BodyDef`s.
14. A presentation flag on vessels in the frame's vessel list (section 3.3), so that nameplates, the map and
    audio ignore display vessels.
15. `UniverseRules`, `LobbySummary`, `PadState`, `ShipRecord`, `AssemblyView`, `RosterEntry`, `FeedEvent` as
    shared protocol types (with the netcode design).

---

## 11. Server data per screen

| Screen | Needs from the server | Rate / when |
|---|---|---|
| Title | `presence.summary`, `feed`, spectator census of the menu region, `universe.ut` | 1 Hz stream (fan-out replica) |
| Identity | `account.checkCallsign`, `account.create`, `account.recover`, `account.link` | request/response |
| Hub / lobbies | `lobby.list` (`LobbySummary[]`), `queue.update` | on open + 1 Hz while visible |
| Lobby details | `lobby.details`, `rules(version)`, `roster.page(filter, cursor)` | on open; roster paged |
| Vehicle | optional `fleet.popularity`, `rules.vehicleAvailability` | on open |
| Site and pad | `pads.subscribe(siteIds)` -> `PadState[]` stream, `pad.reserve`, `pad.release` | live while open |
| Briefing / commit | `spawn(vehicleId, padId, name)` -> `spawned(vessel state, session)` or `refused(reason, alternative)` | once |
| Transit / resume | `resume(vesselId)` -> session attached or a reason | once |
| My ships | `ships.list` -> `ShipRecord[]`, `ship.rename`, `ship.abandon`, `ship.nodes` | on open; push on change |
| Universe | `rules(version)`, `universe.board` | on open; board at 1 Hz |
| Settings / account | `account.settings` (sync blob), `account.devices`, `account.rotateRecovery`, `account.delete` | on demand |
| Flight | pilot session (netcode design), `timeView`, `conjunctions(mine)`, `targets.census`, `assembly`, `prompts`, `chat`, `feed` | per netcode design; conjunction list on change |
| Map | `census.subscribe({ sois, categories })` -> elements + deltas, `roster.lookup(ids)` | on change |
| Block page | public `status` endpoint (online count) | once |

---

## 12. Future-proofing (no added scope)

- **Ship builder**: the vehicle screen lists `VehicleDef`s from any source. Capabilities come from
  `analyzeVehicle`, never authored. Card thumbnails for user designs are rendered on the client by the
  turntable path (the build-time renderer pipeline is the same code). The builder would be one more hub tab with
  its own camera rig in the same scene. A design is validated on the server with the same functions.
- **More KSP systems** (science, contracts, career funds, kerbal-style crew rosters): the hub tab bar takes
  more tabs, and the briefing's phase strip takes more information without new layout.
- **EVA**: nameplates already work per vessel and an astronaut is a vessel. The `port` and `spectate` rigs show
  the camera seam working.
- **More lobbies**: the lobby list is already a list.
- **Gamepad**: the spatial focus model (section 4.9).
- **Landing on other bodies**: the site screen generalises to "surface bases" (a `LaunchSiteDef` on any body)
  with the same pad states.

---

## 13. Suggested work packages for the front-end wave

| Package | Owns | Delivers |
|---|---|---|
| `frontend-shell` | `src/shell/**` (state machine, menu DOM framework, focus navigation, prompt bar, motion and sound tokens, history trap), the scrim-pass request to the core | sections 3, 4, 5.1, 5.3, 5.16, 5.17 |
| `menu-screens` | `src/shell/screens/**`, `public/assets/ui/**`, the menu, turntable and transit rigs in `src/camera` (through its owner) | sections 5.4-5.15 |
| `capability-bench` | `src/gate/**` (inline gate entry), `src/bench/**`, benchmark scenarios in `data/defs/scenarios/bench-*.json`, settings models | section 9 |
| `mp-hud` | `src/ui/mp/**`, the nameplate overlay feature, docking and target painters, the time strip, roster and chat UI | section 7 |
| `map-mp` | `src/map/**` extensions | section 8 |

Identity client code goes with the netcode/identity package of the backend design. `analyzeVehicle` goes to the
sim owner.

---

## 14. Verification plan

Headless (vitest):

- Gate classification tables: fake `navigator.gpu` objects lacking each feature or limit -> the right reason.
  Mobile and iPadOS user-agent fixtures -> `mobile`. An Intel adapter with an empty description is not
  classified as integrated.
- Benchmark solver: recorded per-feature timings from the 5090 -> Ultra at 1440p. The same timings scaled x3 ->
  a valid profile within budget. The confirm-run step-down loop terminates.
- Binding tables per context: no Ctrl/Alt/Meta, no chord conflicts, every action reachable, Y and B have no
  second meaning.
- `analyzeVehicle` against hand-computed Δv for the Meridian stack.
- `TimeView` -> strip-state mapping for every relation and limit kind.
- Proximity plot and closest-approach maths against brute-force sampling.

Browser (Playwright, real Chrome, real GPU):

- Gate: block pages render for `mobile` (device emulation), `noWebGPU` (a context script deletes
  `navigator.gpu`) and `missingFeature` (a wrapped adapter), and the main bundle is **not** requested on a block
  (network log).
- Menu: the full deploy flow by keyboard only, with focus assertions per step. The same flow by mouse.
  History back from every screen. Reduced motion. Screenshots at 1280 x 720, 2560 x 1440, 3840 x 2160 and
  3440 x 1440 reviewed by eye.
- Text contrast over the brightest backdrop frame (scrim sampling).
- Menu DOM main-thread cost under 0.5 ms per frame (the HUD's CDP method). The scrim pass under 0.1 ms GPU.
- Transition continuity: the camera position per frame lies within the path's own motion bound (the view
  manager's spec method). No frame at or above 33 ms during the dive. The HUD appears only after the spawn
  acknowledgement. A night pad has its exposure within 1 EV of the settled value at hand-over.
- Gates during the transit: a delayed spawn acknowledgement produces the holding drift, never a stall.
- Two real clients against a local server: nameplates show each other with matching distances. Targeting,
  navball target mode, docking-instrument numbers agree between the two (mirrored). Control hand-over prompt
  round trip. Warp proposal and acceptance. A collision shows the same numbers on both. Disconnect and
  reconnect under 300 ms injected latency and 5 % loss, with the reconnect states in order.
- Calibration on the 5090: completes in under 30 s and chooses Ultra. With `?ballast=` GPU load it chooses
  a lower profile that then holds 60 fps in the S2 confirmation.

---

## 15. Open questions for the sibling designs

1. Time model: which `relation` states exist, what `syncAction` does, how proximity groups form, and whether
   proposals and votes exist at all (section 7.6).
2. Docking control: PIC or another rule. Can crew fire their own stages while docked? What happens on PIC
   disconnect (section 7.5)?
3. Expiry: which clock (wall or universe), what resets it, what protects a ship, slot counts, debris lifetime
   (section 5.12).
4. Contact model: is part damage a health value or only destroyed / intact (the damage panel needs to know)?
5. Spectator stream: rate, region, and whether the menu backdrop's live cam may subscribe to one remote craft
   at full fidelity.
6. Admission control: soft cap, queue, and whether queued players may spectate.
7. Persistence of maneuver nodes with the ship (recommended yes).
8. Pad contention: reservation hold length, on-pad hold limit, cool-down, multi-site list.
9. Identity backend: credential storage, recovery-code hashing, rate limits, account deletion.
10. Logout behaviour of a craft under thrust (needed for the "If you leave now" line).
11. Non-Chromium desktop browsers that pass the gate: allow with a banner (recommended) or block.
12. Whether a player can share planned nodes with docking partners (needed for partner-aware closest approaches).

---

## Sources

- Repository documents and code listed at the top of this file.
- Measured in this research: Kepler propagation and closest-approach scan timings (section 0).
- [Battlefield 1 needs UI help (Medium)](https://medium.com/@nschaden/battlefield-1-needs-ui-help-bcbe7ed21d2c): a critique of the menu's clutter (six functional areas on one screen).
- [Giant Bomb: Battlefield 1](https://giantbomb.com/wiki/Games/Battlefield_1): the deploy screen is a live overhead view of the map.
- [mein-mmo: Battlefield 1 UI, intuitive and social](https://mein-mmo.de/en/battlefield-1-intuitiv-und-sozial-ui,90694): the shared front end across Battlefield titles, and squad-first social design.
- [TweakTown: EA centralising Battlefield games under a single UI](https://www.tweaktown.com/news/53194/ea-centralizing-battlefield-games-under-single-ui/index.html).
- [ArtStation: Battlefield 1 front-end background work (portfolio)](https://zahhibb.artstation.com/projects/L3QbNR): parallax backgrounds with a final engine blur for readability.
- `docs/research/webgpu-harness.md` sections 1 and 5 (adapter info fields, powerPreference on Windows, features and limits).
