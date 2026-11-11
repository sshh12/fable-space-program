# Hand-off: map-view

Map view for the true-scale Earth/Moon simulator: predicted trajectories across SOI changes, markers with
labels and hover details, reference orbits, SOI shells, surface targets on rotating bodies, and maneuver-node
editing with a six-handle gizmo and a numeric panel. Everything is positioned in float64 on the CPU and
narrowed to camera-relative float32 only for drawing; the overlay is one `RenderFeature.drawOverlay`
(LDR, after tonemapping, no depth buffer: occlusion by bodies is analytic).

Owned paths: `src/map/**`, `labs/map-view/**`, `tests/browser/map-view/**`, `tests/unit/map-view/**`, this file.
Imports `src/core` only (boundaries test green).

## Public API (`src/map/index.ts`)

```ts
createMapView(gpu: GpuHandle, defs: DefLibrary, opts?: MapViewOptions): MapViewHandle

interface MapViewOptions {
  uiRoot?: HTMLElement;      // element over the canvas whose CSS px = canvas CSS px (the HUD container);
                             // default document.body with fixed positioning (canvas fills the viewport)
  now?: () => number;        // ms clock for the handle rate ramp and the click timing (default performance.now)
}
interface MapViewHandle { view: MapViewApi; feature: RenderFeature }   // feature.id = 'map', order 100

interface MapViewApi extends MapView {            // MapView = setActive / update / describe (contracts/ui.ts)
  setDrawAtIntercept(on: boolean): void;          // encounter patches at the body's position at intercept
  readonly drawAtIntercept: boolean;
  readonly isActive: boolean;
  readonly selectedNodeId: string | null;
  selectNode(id: string | null): void;            // e.g. after the HUD creates a node
  stats(): MapStats & { gpu: OverlayCounts | null; cpu: { sceneMs; uploadMs; panelMs } };
  cpuTimes(): { sceneMs: number; uploadMs: number; panelMs: number };   // last prepare(), cheap
  readonly panelElement: HTMLElement | null;      // div[data-map-panel]
  readonly controller: MapController;             // CPU half (hit-testing, panel actions) for labs/tests
  dispose(): void;
}
```

Also exported: `MapController` (all CPU logic, runs in vitest), `HANDLES`, `dragDelta`, `modifierFactor`,
`Projector`, `utAtTrueAnomaly`, `forwardTime`, `locateNode`, `nodeFrame`. Test data:
`src/map/testing/syntheticSnapshots.ts` (`createSyntheticFixture(defs, { ut?, correctionNodes? })`,
`createSyntheticSnapshot`), `src/map/testing/camera.ts` (`lookAtCamera`, `orbitCamera`, `mapCamera`),
`src/map/testing/kepler.ts` (fixture-only propagation).

### Integration (app shell)

- Frame order (ARCHITECTURE 5): `view.update(lastSnapshot, lastCamera, sim.commands, input.pointer, cssSize)`
  BEFORE the controller and the camera rig, with the snapshot and camera that were last rendered (pass the
  same objects: the geometry built while drawing them is reused, so hit-testing matches the pixels).
  Then `renderer.addFeature(feature)` once; the core calls `feature.prepare(frame)` and
  `feature.drawOverlay(frame, pass)`. They read only `frame.snapshot`, `frame.camera`, `frame.displaySize`.
  `prepare` builds the scene and uploads it; `drawOverlay` only encodes. The scene's scratch storage is reused
  by the next build, so nothing outside `src/map` may hold on to a `MapScene`.
- Units: `update`'s `displaySize` is CSS px of the canvas (the PointerState space); `FrameContext.displaySize`
  is device px. Pixel constants (2.5 px lines, 10 px hit tolerance, 6 px fade, 1 m/s per 10 px) are CSS px;
  the chord tolerance is in device px.
- `drawOverlay` pipelines are created for `RenderContext.canvasFormat` and write display-referred sRGB with
  premultiplied alpha (`docs/requests/map-view-3.md` item 2). Shader modules come from `ctx.shaders`.
- `setActive(true)` only in map view: when inactive, `update` returns `{ consumed: false }`, nothing is drawn
  and the panel is hidden.
- `MapUpdateResult.consumed` is true while the pointer hovers a node or gizmo handle, during a handle or node
  drag (until release, wherever the pointer goes), while the pointer is over the node panel, and while a panel
  field has focus. Trajectories, bodies and markers do NOT consume on hover (deviation, see below), so the
  camera keeps rotating and zooming over them; their click actions fire only on a press-release with less
  than 4 px of movement (more is a camera drag).
- `focus` is set on the single frame with `pointer.doubleClick` over a body (`{ bodyId }`) or a vessel
  (`{ vesselId }`). A double click never changes the target: a single click on a body sets the target only
  after 500 ms without a second click (`DOUBLE_CLICK_MS`, the Windows default double-click time).
- The panel stops key events in the bubble phase; the input layer must ignore editable targets and report
  `overUi` over DOM UI (`docs/requests/map-view-1.md`, resolved by flight-ui in 264d8ac).

## Behaviour

Drawing (all from the snapshot; nothing is predicted by the map):
- Current patches (solid; colours per patch along the chain) and planned patches with `afterNodeId` (dashed),
  through every SOI change. Each conic is sampled in eccentric/hyperbolic anomaly (true anomaly in the
  parabolic band), cap 2048 vertices. The chord error of every piece is computed EXACTLY, with no curve
  evaluation beyond the vertices: a conic arc is a rational quadratic Bezier (control point where the end
  tangents meet, weight cos/cosh of half the parameter span), a perspective projection keeps that form with
  the weights scaled by depth, and its greatest distance from the chord is h w'/(1 + w'). Pieces are refined
  greatest-error-first until under 0.29 px, each cut into ceil(sqrt(error / tolerance)) equal parts at once
  (the error shrinks with the square of the span). When the control point projects outside the chord (the hairpin
  of an orbit seen nearly edge-on, where the curve overshoots a vertex) the piece is split until it does not,
  so the bound holds for the distance to the polyline, not only to the chord line. Pieces touching the near
  plane use the angle of the 3-D sagitta. Pieces outside the frustum stay single chords; whole off-screen
  ellipses are skipped. A patch with `nuEnd - nuStart >= 2 pi` is one ellipse; its node sits at
  `nuEnd mod 2 pi`. Alpha fades with time ahead; the current trajectory beyond the first node is dimmed.
- Lines are relative to the patch body's current position, or (toggle) at intercept: every ENCOUNTER (a run
  of consecutive patches about one body in one list) is drawn around the body's ROOT position at that
  encounter's SOI entry, derived exactly from the preceding patch as `prev.bodyPosAtEnd + r(prev.nuEnd) -
  r(p.nuStart)`, so each chain is continuous at its own intercept, with a ghost outline of the body there.
  A planned list that starts inside a current encounter (its first node lies there) shares that encounter's
  anchor. Ghost ids: `<body>@intercept`, then `<body>@intercept#2`, ... (labelled "(encounter)" or
  "(planned encounter)"). The run the vessel is in now and the root body are never anchored.
- Radial patches (`conic.p === 0`, sim-orbits convention) are drawn as a straight, non-interactive segment.
- Other vessels (`conicFromState`, 0.45 alpha) and debris (0.2 alpha): full ellipse, or to the surface for
  suborbital ones, or to the SOI boundary for open ones. Bodies' orbits (`BodySnapshot.orbit`, attractors
  only), SOI silhouettes (orbit-plane great circle when the eye is inside the SOI). Faint lines use a 0.9 px
  tolerance.
- Body icons + labels when the projected diameter is under 6 px; vessel icons always (active and controllable
  vessels labelled, debris as dots).
- Surface targets in the body-fixed frame (rotate with the body): landing pin, launch-site pad, recovery zones
  as circles of their radius on the sphere; shown once the body is >= 18 px in radius, labels from 70 px.
- Markers: SDF icons at float64 positions, labels "value + time-to" (Ap/Pe altitude, AN/DN relative
  inclination, SOI enter/exit with body, impact lat/lon and miss to the landing target when
  `readouts.landingTarget.predicted` matches, entry speed, closest-approach separation), greedy label
  de-cluttering (8 candidate positions; labels keep clear of icons and of the node panel; hidden when no
  position is free), hover tooltip with all details (entry: speed, flight-path angle, vacuum periapsis,
  lat/lon, miss). Impact and entry points also drawn on the ground.
- Occlusion: per fragment (lines) and per item (icons, CPU f64) against every body sphere and ghost, with a
  6 px soft fade at the limb; lines lying on a surface carry an exact depth slack for their chords.

Editing (all through `PlayerCommands`):
- Click on a current/planned trajectory: `addNode(ut)` at the clicked point, ut from the true anomaly via
  `timeSincePeriapsis` on the first pass after the patch start (the drawn lap); the new node is selected.
  Occluded parts of a trajectory are not clickable. Hover shows an "Add maneuver T-..." preview.
- Gizmo on the selected node: prograde/retrograde, normal/antinormal, radial out/in handles along the node
  frame's projected axes (foreshortened, at least 38 % of 58 px). Drag: `dv += sign * (d . handleDir) / 10`
  m/s per CSS px, Shift x0.1, Ctrl x10 (per frame, so modifiers may change mid-drag); past 120 px of travel
  the handle sits at its end stop and a rate ramp adds `2 * 2^(t/0.75 s)` m/s per second (max 500). Wheel
  over a handle: 0.1 m/s per step (times the modifiers).
- Dragging the node body slides it along its pre-node conic in time (nearest point on the drawn polyline,
  revolution closest to the previous time, never before now + 1 s).
- Panel (DOM, 232 px wide, placed beside the node and clamped into the viewport): Prograde / Normal / Radial,
  Total (rescales the burn keeping its direction; a zero burn becomes prograde), In (time to the node:
  "1h 30m", "T-90s", "1:02:03", "2d4h", plain seconds) and UT (seconds since J2000). A typed value is applied
  ONCE, on Enter or when the field loses focus (unchanged text sends nothing); Escape restores the node's
  value and sends nothing; text that does not parse or is refused (a time not in the future, a negative
  total) shows the node's value again. Buttons: -1 orbit (disabled when it would be in the past), +1 orbit
  (disabled on open conics), delete, previous/next node.
- Click on a body: `setTarget(body)` (500 ms later, see Integration); on the body being orbited:
  `setTarget(null)`. Double-click: focus only.
- Nodes are located from their `maneuverNode` marker, else a patch ending at `node.ut` (`'maneuver'`), else
  the patch starting after it (frame then approximated from the post-burn velocity, `approximateFrame`).

Per-frame cost: the builder keeps its sampler, vertex arrays, curve objects and the GPU staging views between
frames, caches what depends on the snapshot alone (other vessels' conics, node locations, label text), and
the label de-clutter works on one reusable rectangle buffer.

## Run and verify

Heavy commands go through the machine gate (`docs/PACKAGE_RULES.md`, "Machine load"):

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck:paths -- src/map labs/map-view tests/browser/map-view tests/unit/map-view
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/map tests/unit/map-view tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/map-view --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/map-view --project=perf    # under withGpuLock
```

The functional specs use the default 120 s test timeout again (the Vite cold scan is fixed, request
map-view-2); the perf spec keeps 25 minutes because it may wait for the machine-wide GPU lock.

Lab: `/labs/map-view/?scene=lowOrbit|translunar|lunarOrbit|...|synthetic` with `&paused=1`, `&intercept=1`,
`&perf=1` (synthetic 8-patch load case), `&quiet=1` (no lab text), `&spin=<rad/frame>`,
`&yaw=&pitch=&dist=`. Drag empty space to rotate, wheel to zoom (exponential), click an orbit to add a
node, double-click to focus. `window.__test`: `state()`, `commands`, `map()` (= describe), `camera()`,
`setCameraOrbit(yaw, pitch, distance)`, `setPaused()`. `window.__mapLab`: `view`, `stats()`, `perf()`,
`resetPerf()`, `setIntercept(on)`, `setFocus({ bodyId | vesselId | '<body>@intercept[#n]' })`, `step(dt)` (one
deterministic sim step while paused), `results()`. The synthetic scene is static (no predictor behind it):
node edits are refused there, targeting works.

`describe()` ids: markers `current|planned/<patch>/<kind>[#n]` (+ `/surface` for ground points of impact and
entry), nodes by node id, handles `<nodeId>/<handle>`, bodies by id (`<body>@intercept[#n]` for ghosts),
vessels by id, surface targets by id. Positions in CSS px; `visible` = in front, on screen, not hidden by a
body (and for surface targets: body at least 18 px).

## Acceptance: measured

65 unit tests (7 files incl. boundaries) and 19 functional browser specs pass (2026-11-10, 23.5 s). The 2
perf specs: GPU passes; CPU passes for the overview and fails for the Earth close-up in the last run (below).

| Criterion | Result |
|---|---|
| Sampling within 0.3 px, e 0..0.97 and hyperbolas, several zooms | worst 0.290 px, measured as the distance of exact points to the whole polyline: 58 fixed views, 200 near-edge-on views (\|ray . W\| 1e-4..0.024, where the previous sampler reached 2.05 px) and 1,500 seeded random views (ellipses, hyperbolas to e 5, eye 1 km..2e9 m, half of them grazing; 242,979 points checked) (`src/map/sampler.test.ts`). The error measure is exact, so the worst piece sits near the 0.29 px tolerance |
| Sub-pixel projection at 2e9 m, 1 m resolution near the vessel (float64 asserted) | exact to 1e-9 px; the float32 path is off by > 1 px for 1 m at lunar distance (`projection.test.ts`) |
| Hit-testing nearest element, 10 px tolerance | edge distances, 9.9 px in / 10.1 px out, node beats the line under it (`controller.test.ts`) |
| Drag-to-delta-v incl. modifiers, ramp, wheel | 100 px = 10 m/s exactly, Shift 1, Ctrl 100; ramp monotonic and accelerating; wheel 0.1 |
| Anomaly to time on the right revolution | ellipse laps, apoapsis wrap, unwrapped patch anomalies, drag continuity, hyperbolas (`anomalyTime.test.ts`) |
| Multi-revolution patch: node placement | node B at `nuEnd mod 2 pi` to 1e-6 px; patch drawn as exactly one revolution |
| Surface targets: right pixel, hidden behind the body | centre to 1e-6 px, oblique view to 1e-9 px, antipode hidden |
| `consumed` for the whole drag, false after release | yes; hover over node/handle/panel consumes, over orbit lines and bodies does not (unit test) |
| A double click yields exactly one focus request | yes, and the target is left unchanged (orbited body and another body; unit test) |
| Synthetic fixtures continuous | every patch end meets the next start in ROOT within 1 m; 8-patch load case too (`synthetic.test.ts`) |
| At intercept, per encounter | current and planned chains with arrivals 3.6 h apart: both continuous (< 1e-6 px), two ghosts at the Moon's true positions (< 1 m), planned impact on its own ghost |
| Browser: click adds node, dashed planned patch | yes (FakeSim lowOrbit) |
| Browser: prograde handle 100 px = +10 +/- 0.5 m/s, planned Ap moves out | yes (Ap altitude +34 km, marker > 0.5 px outward) |
| Browser: Shift-drag ten times finer | +1.0 +/- 0.05 m/s |
| Browser: node drag changes ut monotonically | yes, 10 steps |
| Browser: +1 orbit = one period later; delete; typed values | yes (ut + period to 1e-3 s); typed prograde/normal applied once each (setNode call log), Escape sends nothing and restores "25.0", Total 51 rescales (25, 5) keeping direction, "T-1h 30m" sets ut = now + 5400 s, typed UT applied |
| Browser: markers behind a body faded out | hidden Ap leaves the pixels unchanged (< 6/255), visible Pe changes them (> 60) |
| Browser: Moon orbit and SOI in translunar | both drawn on screen |
| Browser: landing target on the Moon, recovery zones on Earth | pin at the screen centre, red pixels found; hidden from the far side; zone circles drawn |
| Browser: 200 km .. 1e9 m without jitter | static camera: consecutive-frame max diff 0 at 2e5, 2e6, 2e7, 2e8, 1e9 m. Moving: the sim steps between frames and the camera follows the vessel from 100 km (low Earth orbit and lunar orbit, 8 steps each); the vessel icon matches an independent f64 projection to 1e-6 px and the rendered line next to it keeps its offset to 0.001 px (Earth) / 0.000 px (Moon), limit 0.08 px. A float32 ROOT path would move by 0.19 px frame to frame in lunar orbit (computed for the same steps), so the spec tells the two apart there |
| Browser: synthetic chain, at-intercept, every marker kind, both nodes | all via describe(); at intercept the impact lies on the ghost Moon, one ghost |
| Browser: panel fields show their whole text | `scrollWidth <= clientWidth` for all six fields in the three synthetic close-ups (multi-day times) |
| Overlay GPU < 0.1 ms (8 patches, 20 debris) | met: p99 <= 0.013 ms in every run (table below) |
| Overlay CPU < 0.5 ms per frame | overview met in the last run (p99 0.475 ms); Earth close-up NOT met, p99 0.560 ms. Provisional: measured with other agents' bakes loading the machine (table below) |

### Overlay cost

`map-view.perf.spec.ts`: the 8-patch synthetic chain plus 20 debris orbits, the camera orbiting every frame
(a full rebuild each frame), 600 frames under withGpuLock. CPU = MapView.update + feature.prepare (scene,
draw list, upload, panel sync) + drawOverlay encoding. Machine load is the whole-machine CPU load sampled
during the run (the Earth bake and other agents' tests were running).

| Run (2026-11-10) | Load | View | CPU p50 / p95 / p99 (ms) | scene + draw list p50 / p99 | upload p50 | update p50 | GPU p99 |
|---|---|---|---|---|---|---|---|
| builder, before the fixes | ~63 % | overview | 0.525 / 0.765 / 0.915 | 0.41 / - | 0.075 | 0.03 | 0.004 |
| | | Earth close-up | 0.655 / 0.905 / 1.03 | 0.52 / - | 0.08 | 0.035 | 0.004 |
| fixes, run 1 | 32-43 % | overview | 0.300 / 0.615 / 0.725 | 0.230 / 0.530 | 0.040 | 0.015 | 0.003 |
| | | Earth close-up | 0.350 / 0.705 / 0.925 | 0.280 / 0.745 | 0.040 | 0.020 | 0.003 |
| fixes, run 2 | 5-85 %, mostly 20-45 % | overview | 0.295 / 0.475 / 0.550 | 0.220 / 0.425 | 0.050 | 0.015 | 0.007 |
| | | Earth close-up | 0.415 / 0.650 / 0.850 | 0.335 / 0.660 | 0.055 | 0.020 | 0.013 |
| + n-part split (final code) | 10-46 %, mostly ~20 % | overview | 0.245 / 0.395 / **0.475** | 0.185 / 0.355 | 0.040 | 0.015 | 0.007 |
| | | Earth close-up | 0.225 / 0.470 / **0.560** | 0.185 / 0.430 | 0.030 | 0.010 | 0.008 |

Why the browser figures are about three times the Node figures for the same code: the lab does about
0.3 ms of map work every 16 ms, so every frame starts on a cold core (caches evicted by the other
processes, clock ramped down), and that grows with the machine load. Node, same code (before the n-part
split), same load (~32 %): a tight loop costs p50 0.082 / 0.143 ms (overview / close-up) for update + scene
+ draw list, one frame every 16 ms costs p50 0.269 / 0.408 ms, p99 0.488 / 0.712 ms. With the final code at
7-26 % load: 0.079 / 0.123 ms tight, 0.251 / 0.342 ms (p99 0.489 / 0.509 ms) one frame per 16 ms. On the
quiet machine (7-11 % load) the tight-loop figure was p50 0.071 / 0.114 ms, p99 0.153 / 0.215 ms.

The lead's quiet-machine re-measurement decides the close-up line. If it still misses, the next lever is the
faint debris orbits: they are 515 of the 787 close-up vertices. Reuse the previous frame's parameter
breakpoints for them (verify each piece's exact error instead of re-refining from scratch), or resample
them less often while the camera moves little.

## Review findings (independent review, 2026-11-10) and what was done

| # | Finding | Done |
|---|---|---|
| 1 major | CPU budget unmet/unproven; allocation churn | Re-measured three times (above): overview now within the line, close-up p99 0.560 ms (from 1.03). Per-frame allocations cut: Projector with plain fields and a cached projection matrix, pooled curve objects and vertex arrays, cached other-vessel conics, node locations and label text, allocation-free label de-clutter, persistent GPU staging views, no sorted copies or spreads in the draw list. Fewer vertices: the exact chord error plus cutting a piece into ceil(sqrt(err/tol)) parts at once (synthetic 8-patch case, vertices per frame: overview 594 -> 447, Earth close-up 1,108 -> 787). Node A/B of the allocation work and the exact error on the same quiet machine, scene + draw list + update: p50 0.113 -> 0.084 ms (overview), 0.163 -> 0.130 ms (close-up). Not met yet: the close-up line under this load (see "Overlay cost" for the cause and the next lever) |
| 2 major | At-intercept anchor shared per body | One anchor per encounter, keyed by list and run; a ghost per distinct anchor; unit test with arrivals 3.6 h apart |
| 3 major | Double click also retargets | The body-click target action waits 500 ms and is cancelled by a double click; unit test that focus leaves `targetBodyId` unchanged |
| 4 minor | Panel: Escape applies, Enter applies twice | Escape restores the shown value before blur; apply() sends nothing for text already applied; browser spec with a setNode call log |
| 5 minor | Chord error > 0.3 px near edge-on | Sampler rewritten with the exact projected-Bezier error and the obtuse-triangle split; grazing and 1,500-view random tests; the previous sampler fails them (2.05 px) |
| 6 minor | Total and time-to-node not editable; consumed deviation unlisted | Total and "In" fields added (unit and browser tests); the hover deviation is listed below and in `docs/requests/map-view-3.md` item 6; a unit test pins the behaviour |
| 7 minor | Jitter spec passes by construction | New spec with the sim stepping and the camera following the vessel, in Earth and lunar orbit (see table) |
| 8 minor | Panel covers labels | The panel rectangle (its real DOM size) is an obstacle for label placement; unit test shows labels there without the panel and none with it; screenshot `synthetic-moon-intercept.png` |

Also fixed while verifying: the "In" field cut off multi-day times (panel widened to 232 px, the unit-less
field spans the unit column, browser check); the panel background is more opaque (0.94) so icons beneath
show through less; the label cache also keys on the landing-target prediction (the impact miss text).

## Deviations from the brief

- `consumed` is not set while hovering trajectories, bodies or markers, although they have click actions
  (`docs/requests/map-view-3.md` item 6): consuming there would block camera rotation and zoom over most of
  the map. Nodes, handles, drags and the panel consume as specified.
- A single click on a body sets the target 500 ms after the click (so that a double click can focus without
  retargeting).
- At-intercept anchors each encounter at the body's position at its SOI ENTRY, derived from the preceding
  patch's `bodyPosAtEnd` plus its conic end, so the chain is continuous at the intercept. Using the encounter
  patch's own `bodyPosAtEnd` leaves a gap of the body's motion during the encounter (about 65,000 km).
- Faint reference lines (not Patch conics: debris and other vessels' orbits, recovery zones) use a 0.9 px
  tolerance instead of 0.3 px.
- `createMapView` takes an optional third argument `{ uiRoot, now }` for the panel and the clock.

## Known limits

- CPU budget: the Earth close-up of the 8-patch load case measured p99 0.560 ms against 0.5 ms (overview
  0.475 ms) with the machine loaded by other agents; unproven on a quiet machine (see "Overlay cost").
- At-intercept drawing still shows a gap at each SOI EXIT: the patches after an encounter are drawn at
  their body's true position, the encounter around the body where it was at the entry, so the jump is the
  body's motion during the encounter (as in KSP). Ghost bodies occlude like real ones. Double-clicking a
  ghost focuses the real body.
- Occlusion uses the reference spheres (`BodyDef.radius`): terrain relief (up to ~10 km) is ignored, and
  lines on a surface rely on the computed chord slack.
- Labels: one monospace font from a Canvas-2D atlas (Consolas or the next available monospace), 12 px CSS;
  hidden labels are only reachable through the hover tooltip. Bodies have no tooltip. Icons (not labels)
  may sit under the node panel.
- The node frame is approximate when a node can only be found from the patch after it (no marker and no
  patch ending at it); the gizmo and drags still work in that frame.
- Gizmo handles fade with the node when it passes behind a body (alpha floor 0.35 so it stays usable).
- The synthetic scene is static; editing is exercised against the FakeSim (single-body patches).
- The panel's time field is frozen while it has focus (typing is not overwritten), so with the sim running
  the shown "In" value ages until the field is left.
- The follow-camera jitter spec discriminates a float32 world-space path only in lunar orbit (in low Earth
  orbit float32 rounding of ROOT positions is about 0.001 px at 100 km).

## Requests filed

- `docs/requests/map-view-1.md` (src/input, flight-ui): ignore key events from editable elements; `overUi`
  over DOM UI. Needed so typing in the node panel never fires SAS/staging keys. Resolved by flight-ui
  (264d8ac): editable targets reach no binding, and `overUi` is true for any pointer target other than the
  canvas. src/map already ignores presses and wheel steps with `overUi` and needs no change for it.
- `docs/requests/map-view-2.md` (vite.config.ts), resolved by the lead (fa1c31b); the map-view specs are back
  on the default timeout.
- `docs/requests/map-view-3.md` (contracts, doc comments only), open: displaySize units, overlay target
  format, optional `MapView.mount`, where `planned` starts, the at-intercept derivation (per encounter), and
  (new) hover consumption of click-only elements.

No contract was changed; no open requests against map-view paths exist.

## Screenshots (out/screens/map-view/, reviewed)

`scene-*.png` (each lab scene, synthetic and at-intercept), `lowOrbit-node.png` (gizmo + panel),
`synthetic-earth.png`, `synthetic-moon*.png` (panel beside node A, labels clear of it),
`synthetic-chain*.png`, `synthetic-8-patches.png`, `hover-impact-details.png`, `hover-add-maneuver.png`,
`accept-*.png` (acceptance steps, including `accept-panel.png` with the total and time fields and
`accept-follow-lowOrbit.png` / `accept-follow-lunarOrbit.png` from the moving-camera spec).

## Changes by the lead between the waves (2026-11-10)

- `map-view-3` resolved (doc comments only): `MapView.update` displaySize = CSS pixels; `drawOverlay`
  target = `RenderContext.canvasFormat` (non-sRGB view), sRGB-encoded values, premultiplied alpha;
  `SimSnapshot.patches.planned` starts AT the first node (`planned[0].tStart = nodes[0].ut`, every planned
  patch has `afterNodeId`); the at-intercept anchor derivation is in the `Patch.bodyPosAtEnd` comment;
  `MapUpdateResult.consumed` documents that click-only elements do not consume on hover. The optional
  `MapView.mount` was not added: the factory option `createMapView(gpu, defs, { uiRoot })` is the sanctioned
  way and is named in the `MapView` comment.
- `sim-orbits-3`: core `timeSincePeriapsis` (used by `anomalyTime.ts` and `scene.ts`) is now the
  cancellation-free relation, exact through e = 1; no change in src/map.

Full list: `docs/handoff/lead-baseline.md`.

## Changes in wave 2 (core-support)

- **Breakpoint re-use (CPU budget of the Earth close-up).** On the quiet machine the 8-patch + 20-debris
  close-up still measured CPU p99 0.525 ms against 0.5 ms. `SceneBuilder` now keeps the breakpoints of every
  sampled line under its id (`BreakpointCache` in `scene.ts`) and, while the conic keeps its shape, draws the
  line from them through the new `Sampler.resample(curve, us, cs, ss, count, proj, tolerancePx)`, which
  evaluates the curve at the kept parameters for the current view and verifies the exact chord error of
  every piece (null when a piece is over the tolerance: the builder then samples afresh). Exactness per
  frame is unchanged (0.3 px patches, 0.9 px faint lines); fresh samplings refine to 0.8 of the tolerance,
  so lines carry 10-12 % more vertices. Measured under the lock: overview p99 0.425 -> 0.340 ms, close-up
  0.525 -> 0.390 ms (p50 0.270 -> 0.200 ms). `SampledCurve` gained `c`, `s`, `maxError`, `initial`;
  `MapStats` gained `reuse: { resampled, fresh }` (lines of the last build per path). Tests:
  `tests/unit/map-view/breakpointReuse.test.ts`. The "Known limits" CPU item above no longer applies.
