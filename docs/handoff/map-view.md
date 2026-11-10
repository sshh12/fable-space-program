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
  now?: () => number;        // ms clock for the handle rate ramp (default performance.now)
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
- Units: `update`'s `displaySize` is CSS px of the canvas (the PointerState space); `FrameContext.displaySize`
  is device px. Pixel constants (2.5 px lines, 10 px hit tolerance, 6 px fade, 1 m/s per 10 px) are CSS px;
  the chord tolerance is in device px.
- `drawOverlay` pipelines are created for `RenderContext.canvasFormat` and write display-referred sRGB with
  premultiplied alpha (`docs/requests/map-view-3.md` item 2). Shader modules come from `ctx.shaders`.
- `setActive(true)` only in map view: when inactive, `update` returns `{ consumed: false }`, nothing is drawn
  and the panel is hidden.
- `MapUpdateResult.consumed` is true while the pointer hovers a node or gizmo handle, during a handle or node
  drag (until release, wherever the pointer goes), while the pointer is over the node panel, and while a panel
  field has focus. Trajectories, bodies and markers do NOT consume on hover, so the camera keeps rotating and
  zooming over them; their click actions fire only on a press-release without movement (more than 4 px of
  movement makes it a camera drag). `focus` is set on the single frame with `pointer.doubleClick` over a body
  (`{ bodyId }`) or a vessel (`{ vesselId }`).
- The panel stops key events in the bubble phase; the input layer must ignore editable targets and report
  `overUi` over DOM UI (`docs/requests/map-view-1.md`).

## Behaviour

Drawing (all from the snapshot; nothing is predicted by the map):
- Current patches (solid; colours per patch along the chain) and planned patches with `afterNodeId` (dashed),
  through every SOI change. Each conic is sampled in eccentric/hyperbolic anomaly (true anomaly in the
  parabolic band) with a rigorous screen-space chord-error bound of 0.29 px (actual errors <= 0.15 px),
  cap 2048 vertices; pieces outside the frustum stay single chords and whole off-screen ellipses are skipped.
  A patch with `nuEnd - nuStart >= 2 pi` is one ellipse; its node sits at `nuEnd mod 2 pi`. Alpha fades with
  time ahead; the current trajectory beyond the first node is dimmed. Lines are relative to the patch body's
  current position, or (toggle) at intercept: each encounter body's patches are drawn around the body's ROOT
  position at its SOI entry, derived exactly from the preceding patch's `bodyPosAtEnd` and conic end, with a
  ghost outline of the body there (`docs/requests/map-view-3.md` item 5).
- Radial patches (`conic.p === 0`, sim-orbits convention) are drawn as a straight, non-interactive segment.
- Other vessels (`conicFromState`, 0.45 alpha) and debris (0.2 alpha): full ellipse, or to the surface for
  suborbital ones, or to the SOI boundary for open ones. Bodies' orbits (`BodySnapshot.orbit`, attractors
  only), SOI silhouettes (orbit-plane great circle when the eye is inside the SOI). Faint lines use a 0.9 px
  bound.
- Body icons + labels when the projected diameter is under 6 px; vessel icons always (active and controllable
  vessels labelled, debris as dots).
- Surface targets in the body-fixed frame (rotate with the body): landing pin, launch-site pad, recovery zones
  as circles of their radius on the sphere; shown once the body is >= 18 px in radius, labels from 70 px.
- Markers: SDF icons at float64 positions, labels "value + time-to" (Ap/Pe altitude, AN/DN relative
  inclination, SOI enter/exit with body, impact lat/lon and miss to the landing target when
  `readouts.landingTarget.predicted` matches, entry speed, closest-approach separation), greedy label
  de-cluttering (8 candidate positions, hidden when none is free), hover tooltip with all details (entry:
  speed, flight-path angle, vacuum periapsis, lat/lon, miss). Impact and entry points also drawn on the ground.
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
- Panel: prograde / normal / radial / UT fields (Enter or blur applies, Escape reverts), total, time to node,
  -1 orbit (disabled when it would be in the past), +1 orbit, delete, previous/next node.
- Click on a body: `setTarget(body)`; on the body being orbited: `setTarget(null)`. Double-click: focus.
- Nodes are located from their `maneuverNode` marker, else a patch ending at `node.ut` (`'maneuver'`), else
  the patch starting after it (frame then approximated from the post-burn velocity, `approximateFrame`).

## Run and verify

```
npm run typecheck:paths -- src/map labs/map-view tests/browser/map-view tests/unit/map-view
npx vitest run src/map tests/unit/map-view tools/dev/boundaries.test.ts
npx playwright test tests/browser/map-view --project=functional
npx playwright test tests/browser/map-view --project=perf          # under withGpuLock
```

Lab: `/labs/map-view/?scene=lowOrbit|translunar|lunarOrbit|...|synthetic` with `&paused=1`, `&intercept=1`,
`&perf=1` (synthetic 8-patch load case), `&quiet=1` (no lab text), `&spin=<rad/frame>`,
`&yaw=&pitch=&dist=`. Drag empty space to rotate, wheel to zoom (exponential), click an orbit to add a
node, double-click to focus. `window.__test`: `state()`, `commands`, `map()` (= describe), `camera()`,
`setCameraOrbit(yaw, pitch, distance)`, `setPaused()`. `window.__mapLab`: `view`, `stats()`, `perf()`,
`resetPerf()`, `setIntercept(on)`, `setFocus({ bodyId | vesselId | '<body>@intercept' })`, `results()`.
The synthetic scene is static (no predictor behind it): node edits are refused there, targeting works.

`describe()` ids: markers `current|planned/<patch>/<kind>[#n]` (+ `/surface` for ground points of impact and
entry), nodes by node id, handles `<nodeId>/<handle>`, bodies by id (`<body>@intercept` for ghosts), vessels
by id, surface targets by id. Positions in CSS px; `visible` = in front, on screen, not hidden by a body (and
for surface targets: body at least 18 px).

## Acceptance: measured

| Criterion | Result |
|---|---|
| Sampling within 0.3 px, e 0..0.97 and hyperbolas, several zooms | max 0.145 px over 42 ellipse and 16 hyperbola views (`src/map/sampler.test.ts`); bound is rigorous |
| Sub-pixel projection at 2e9 m, 1 m resolution near the vessel (float64 asserted) | exact to 1e-9 px; the float32 path is off by > 1 px for 1 m at lunar distance (`projection.test.ts`) |
| Hit-testing nearest element, 10 px tolerance | edge distances, 9.9 px in / 10.1 px out, node beats the line under it (`controller.test.ts`) |
| Drag-to-delta-v incl. modifiers, ramp, wheel | 100 px = 10 m/s exactly, Shift 1, Ctrl 100; ramp monotonic and accelerating; wheel 0.1 |
| Anomaly to time on the right revolution | ellipse laps, apoapsis wrap, unwrapped patch anomalies, drag continuity, hyperbolas (`anomalyTime.test.ts`) |
| Multi-revolution patch: node placement | node B at `nuEnd mod 2 pi` to 1e-6 px; patch drawn as exactly one revolution |
| Surface targets: right pixel, hidden behind the body | centre to 1e-6 px, oblique view to 1e-9 px, antipode hidden |
| `consumed` for the whole drag, false after release | yes; double click gives exactly one focus |
| Synthetic fixtures continuous | every patch end meets the next start in ROOT within 1 m; 8-patch load case too (`synthetic.test.ts`) |
| Browser: click adds node, dashed planned patch | yes (FakeSim lowOrbit) |
| Browser: prograde handle 100 px = +10 +/- 0.5 m/s, planned Ap moves out | yes (Ap altitude +34 km, marker > 0.5 px outward) |
| Browser: Shift-drag ten times finer | +1.0 +/- 0.05 m/s |
| Browser: node drag changes ut monotonically | yes, 10 steps |
| Browser: +1 orbit = one period later; delete; typed values | yes (ut + period to 1e-3 s; typed prograde and UT applied) |
| Browser: markers behind a body faded out | hidden Ap leaves the pixels unchanged (< 6/255), visible Pe changes them (> 60) |
| Browser: Moon orbit and SOI in translunar | both drawn on screen |
| Browser: landing target on the Moon, recovery zones on Earth | pin at the screen centre, red pixels found; hidden from the far side; zone circles drawn |
| Browser: static camera 200 km .. 1e9 m pixel-stable | consecutive-frame max diff 0 at 2e5, 2e6, 2e7, 2e8, 1e9 m |
| Browser: synthetic chain, at-intercept, every marker kind, both nodes | all via describe(); at intercept the impact lies on the ghost Moon |
| Overlay GPU < 0.1 ms (8 patches, 20 debris) | p99 0.004 ms (timestamp queries around the overlay pass) |
| Overlay CPU < 0.5 ms per frame | NOT MET under the bake load, provisional: see below |

CPU, 8-patch synthetic chain + 20 debris, camera orbiting every frame (full rebuild each frame), browser
(`map-view.perf.spec.ts`, 600 frames under withGpuLock, 2026-11-10, machine CPU load 63 % from the bakes):

| View | total p50 / p95 / p99 | scene build + draw list | GPU upload | update (hit-test) | drawOverlay encode |
|---|---|---|---|---|---|
| overview (1.15e9 m) | 0.525 / 0.765 / 0.915 ms | p50 0.41 | p50 0.075 | p50 0.03 | p50 0.005 |
| Earth close-up (9e7 m) | 0.655 / 0.905 / 1.03 ms | p50 0.52 | p50 0.08 | p50 0.035 | p50 0.005 |

The perf spec asserts p99 < 0.5 ms and therefore FAILS on this loaded machine (GPU assertions pass). Earlier
runs at 50 % load gave p50 0.455 / 0.525 ms, at 90 % load 0.79 / 0.92 ms: the numbers track the load.

The same work in Node (`MapController.frame`, i.e. scene build + draw list, 1,400 frames): minimum
0.15 ms (overview) / 0.22 ms (Earth close-up), p50 0.28 / 0.39 ms at 91 % machine load. The minimum is the
closest available estimate of a quiet machine; the browser adds the GPU upload (0.07-0.12 ms) and update
(0.02-0.05 ms). Cost per frame scales with the drawn vertices: about 600 (overview) and 1,340 (close-up),
one conic evaluation per vertex. The lead's quiet-machine re-measurement decides whether this line holds.

## Known limits

- The CPU budget above is unproven on a quiet machine; the biggest share is sampling ~35 conics every frame
  (debris orbits are 20 of them). If it misses there, the next steps are reusing the previous frame's
  parameter breakpoints when the camera moved little, or sampling faint orbits less often than patches.
- At-intercept drawing anchors each encounter body once (first encounter patch); patches after that body's
  SOI exit are drawn at true positions, so the chain shows a gap at the exit (the body's motion during the
  encounter). Ghost bodies occlude like real ones. Double-clicking a ghost focuses the real body.
- Occlusion uses the reference spheres (`BodyDef.radius`): terrain relief (up to ~10 km) is ignored, and
  lines on a surface rely on the computed chord slack.
- Labels: one monospace font from a Canvas-2D atlas (Consolas or the next available monospace), 12 px CSS;
  hidden labels are only reachable through the hover tooltip. Bodies have no tooltip.
- The node frame is approximate when a node can only be found from the patch after it (no marker and no
  patch ending at it); the gizmo and drags still work in that frame.
- Gizmo handles fade with the node when it passes behind a body (alpha floor 0.35 so it stays usable).
- The synthetic scene is static; editing is exercised against the FakeSim (single-body patches).
- The first page load of a Playwright run currently takes 5-8 minutes (`docs/requests/map-view-2.md`);
  map-view specs therefore use a 15-minute test timeout.

## Requests filed

- `docs/requests/map-view-1.md` (src/input, flight-ui): ignore key events from editable elements; `overUi`
  over DOM UI. Needed so typing in the node panel never fires SAS/staging keys.
- `docs/requests/map-view-2.md` (vite.config.ts, lead): `optimizeDeps.entries` so the dev server does not scan
  data/tiles on cold start.
- `docs/requests/map-view-3.md` (contracts, lead, doc comments): displaySize units, overlay target format,
  optional `MapView.mount`, where `planned` starts, the at-intercept derivation.

No contract was changed; no open requests against map-view paths existed.

## Screenshots (out/screens/map-view/, reviewed)

`scene-*.png` (each lab scene, synthetic and at-intercept), `lowOrbit-node.png` (gizmo + panel),
`synthetic-earth.png`, `synthetic-moon*.png`, `synthetic-chain*.png`, `synthetic-8-patches.png`,
`hover-impact-details.png`, `hover-add-maneuver.png`, `accept-*.png` (acceptance steps).
