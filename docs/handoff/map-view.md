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
  setDebrisOrbits(on: boolean): void;             // draw every debris orbit (default off: dots, orbit on hover)
  readonly debrisOrbits: boolean;
  setObstacles(rects: readonly ScreenRect[]): void; // HUD panels etc. (CSS px {x, y, width, height}): labels,
                                                  // the node panel and tooltips keep clear of them
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

Also exported: `MapController` (all CPU logic, runs in vitest; `tooltipRect` = the last draw list's tooltip in
CSS px, `panelNudge(comp, sign, factor)`), `HANDLES`, `dragDelta`, `modifierFactor`, `layoutGizmo`,
`GIZMO_MIN_SEPARATION`, `ScreenRect`, `Projector`, `utAtTrueAnomaly`, `forwardTime`, `locateNode`, `nodeFrame`. Test data:
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
  is device px. Pixel constants (2.5 px lines, 10 px hit tolerance, 1.5 px fade, 1 m/s per 10 px of handle
  drag, label type, icons, the gizmo, the node panel) are INTERFACE px: CSS px at 720p, scaled with the flight
  HUD's unit `min(1vh, 0.5625vw)` above it (`uiScale` in projection.ts, 1.5 at 1920 x 1080 CSS px, steps of
  1/16, floor 0.8), so the map keeps its size relative to the HUD panels at every resolution. The chord
  tolerance is in device px; the click slop (4 px) in CSS px. `Projector.pxScale` = device px per interface px,
  `Projector.cssScale` = device px per CSS px.
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
- HUD panels: pass their rectangles (CSS px of the canvas) to `view.setObstacles([...])` whenever the HUD
  layout changes (the map lab passes its own text boxes; `mountHud` in `tests/browser/map-view/real-planet.spec.ts`
  passes the flight HUD's `.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn,
  .hud .more, .hud .nbchips > div, .hud .toast, .hud .ball` boxes, request map-view-5). Map labels, the node
  panel and tooltips then keep clear of them. Panel ownership: the map's node panel EDITS the selected node (components, total, time,
  orbit steps, delete); the HUD's MANEUVER panel shows the burn EXECUTION figures (delta-v remaining, burn time,
  burn start). The map panel and labels use the interface's shared type and palette (`src/core/ui/theme.ts`,
  request map-view-4, resolved; `src/map/theme.ts` adds only the map's own label weight and opaque fills).

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
  `nuEnd mod 2 pi`. With time ahead a patch fades in alpha alone toward 0.72 (`FADE_FLOOR`; the hue is kept, so
  far laps stay the saturated colour of their patch); the current trajectory beyond the first node is dimmed.
- Coincident patches are drawn once (`SceneBuilder.suppressCoincident`): a 1.5 px occupancy bitmap of what is
  drawn, in priority order (the current trajectory up to the first node, then the planned patches in time
  order, then the current trajectory after the first node); a later segment that runs within about 3 px of
  drawn cells for three quarters of its on-screen length is hidden (`VertexArrays.cover`; it stays clickable and
  a node still slides along it), short flickering runs are evened out (`cleanCover`). A node with no delta-v
  shows one orbit, not interleaved dashes.
- Lines are cut in float64 where they pass behind the eye (`VertexArrays.appendLine`, `CLIP_DEPTH_REL`): a
  vertex counts as in front when its depth exceeds 1e-5 of its distance, and a segment crossing that depth
  gets a new end there. Every segment the GPU draws has both ends safely in front after the float32 narrowing
  (the old GPU clip at the 5 cm near plane could not be resolved for points 1e8 m away and threw mirrored
  chords across the screen). Each line has a dark casing (1.25 px, 0.6 alpha) that keeps it legible over a lit
  planet, drawn in a pass of its own before all line cores (a line crossing another never cuts it); a whole
  ellipse is joined across its seam (two trailing join-only vertices, `LineRecord.seam`), so no end cap shows
  there. Dashes are fixed to the path: every vertex of a planned patch carries its arc length from the node in
  metres (Simpson over the conic parameter, cached per vertex parameter while the patch is unchanged), every
  segment the octave n = floor(log2(20 px x metres per px at its depth)); the fragment shader draws the 12 on /
  8 off patterns of world period 2^n and 2^(n+1) m and cross-fades them by its own depth (like mip levels), so
  dashes never slide when the camera turns, zooms or follows the vessel and stay about 20 px long near and far.
- Lines are relative to the patch body's current position, or (toggle) at intercept: every ENCOUNTER (a run
  of consecutive patches about one body in one list) is drawn around the body's ROOT position at that
  encounter's SOI entry, derived exactly from the preceding patch as `prev.bodyPosAtEnd + r(prev.nuEnd) -
  r(p.nuStart)`, so each chain is continuous at its own intercept, with a ghost outline of the body there.
  A planned list that starts inside a current encounter (its first node lies there) shares that encounter's
  anchor. Ghost ids: `<body>@intercept`, then `<body>@intercept#2`, ... (labelled "(encounter)" or
  "(planned encounter)"). The run the vessel is in now and the root body are never anchored.
- Radial patches (`conic.p === 0`, sim-orbits convention) are drawn as a straight, non-interactive segment.
- Other vessels (`conicFromState`, 0.45 alpha): full ellipse, or to the surface for suborbital ones, or to
  the SOI boundary for open ones; left out while under 60 px across (`ORBIT_MIN_SPAN_PX`) unless hovered.
  Debris are dots (drawn under the label plates); a debris orbit (0.2 alpha) is drawn only for the hovered
  debris or with `setDebrisOrbits(true)` (the perf load case), and like other vessels' orbits only while it
  spans 60 px (twenty rings around an 11 px planet icon were a scribble). The hovered vessel or debris is ringed and its
  orbit drawn in the hover colour, 2 px. Bodies' orbits (`BodySnapshot.orbit`, attractors only), SOI
  silhouettes seen from outside (nothing from inside: a great circle read as a second orbit). Tolerances: other
  vessels' and the hovered debris' orbits 0.9 px, debris orbits drawn in bulk 1.5 px (20 % alpha), zone rings
  and silhouettes the trajectories' 0.29 px.
- Bodies: while the projected radius is under 12 px (`BODY_ICON_MAX_RADIUS_PX`) a body is a shaded disc icon
  above every line (at least 5.5 px; its mean albedo colour from `BodyDef.render.meanColor`, lit from its sun
  with the terminator, a light rim on the night edge, a dark casing) that owns its icon cluster; from 12 px
  the renderer's disc carries a silhouette ring (`limb:<body>`, 1.25 px, no casing; strong on the night side
  where the planet is as black as space, 28 % of that on the lit side), so a line behind a night limb never
  ends in mid-air. Names (under 40 px radius) in tracked capitals without a plate. Vessels: an elongated
  chevron with a deep tail notch along the velocity on screen (the active vessel 9.5 px in its trajectory's
  cyan, others 7 px grey).
- Surface targets in the body-fixed frame (rotate with the body): landing pin, launch-site pad, recovery zones
  as circles of their radius on the sphere; shown once the body is >= 18 px in radius, labels from 70 px.
- Markers: SDF icons at float64 positions with distinct glyphs (Ap ring with an up chevron, Pe with a down
  chevron, SOI entry / exit arrows in / out, impact, entry, closest approach, AN/DN diamond), outline glyphs
  filled with an opaque dark interior (the line a marker sits on stops at it); Ap/Pe in the colour of their
  own patch line (current cyan, planned yellow...). Labels "value + time-to" (Ap/Pe altitude, AN/DN relative
  inclination, SOI enter/exit with body, impact lat/lon and miss to the landing target when
  `readouts.landingTarget.predicted` matches, entry speed, closest-approach separation), first line tinted
  with the marker's colour. Impact and entry points also drawn on the ground (the ground twin is left out
  within 12 px of its marker). A patch in another body's frame than the one before it starts with a small
  entry tick (`<list>/<i>/start`; left out within 12 px of the SOI marker). Apsis and AN/DN markers are left
  out on a patch under 40 px across. The apsis the active vessel sits at (within 11 px) is printed as the
  vessel label's second line ("Pe 200.0 km  now") instead of folding into a "+1". Lengths are written with
  the flight HUD's rule (`formatDistance` mirrors `src/ui/format.ts` formatLength: km with one decimal up
  to 10,000 km for apsides, "180.0 Mm" above), so a label and the HUD panel beside it agree.
- Visibility is binary: an icon, label and plate are drawn at full strength while the anchor is in front and
  not behind a body (hidden < 0.5), else not at all (an unselected node behind a body keeps a dashed ring at
  0.6). Only lines fade over the 1.5 px limb ramp. An anchor under other UI (a `setObstacles` rectangle: the
  navball, a HUD panel) gets neither icon nor label: the HUD covers it, and a label set beside the panel with a
  leader into it pointed at nothing.
- Clutter: icons closer than 11 px (from the edge of a body icon) collapse into one (a body icon wins, then
  the active vessel, then the label priority) with a "+n" badge on the icon's upper-right corner; impact and
  atmosphere-entry labels of folded members are still placed beside the cluster's icon; the hover tooltip lists
  the members ("n objects here", debris counted). Unselected nodes are 5.5 px discs. Labels: HUD type family
  (Bahnschrift 13 px semibold, proportional digits; atlas in gpu/glyphAtlas.ts) on an opaque plate (0.95);
  placed at the cheapest free one of 16 candidates (8 beside the anchor, 8 further out): rank by the side of
  the anchor's own line (the normal of its screen tangent turned away from its body, outer side first), plus
  the drawn trajectory weight the plate would cover (`LineGrid`, 8 px cells, built every draw list), plus a
  penalty when another marker's icon is nearer to the plate than its own anchor; the search stops when no later
  candidate can be cheaper. Free = clear of icons and gizmo arms, other labels, the node panel, the tooltip,
  badges and `setObstacles` rectangles; a label with no free candidate is hidden. A leader ties a label to its
  icon when the plate is more than 11 px from the icon's edge or sits diagonally off a small icon. The selected
  node has no label (its panel names it). Hover tooltip with all details, placed in the quadrant (then further
  out) that covers neither the panel, nor a handle, nor other UI, and keeps 6 px from the trajectories; labels
  then keep clear of it. No tooltip for the selected node or its handles.
- Time to an event is written in the HUD's countdown notation everywhere (labels, tooltips, the panel's In
  field): "T− 1:32:00", "T− 3d 18:51", "T+ 0:12", "now".
- Occlusion: per fragment (lines) and per item (icons, CPU f64) against every body sphere and ghost, with a
  1.5 px soft edge at the limb; lines lying on a surface (zone rings, silhouettes) are tested against the
  sphere shrunk by their chords' deepest point plus 1e-4 R and cut at the limb (no arc along the horizon at
  partial strength). A body with an atmosphere hides every point above its visible limb with that limb: the
  height where the grazing Rayleigh optical depth falls to 0.03 (`visibleAtmosphereHeight`, about 51 km for the
  Earth), so a line behind the planet ends where the glow ends; points inside that shell are tested against
  the solid sphere (the glow is translucent).

Editing (all through `PlayerCommands`):
- Click on a current/planned trajectory: `addNode(ut)` at the clicked point, ut from the true anomaly via
  `timeSincePeriapsis` on the first pass after the patch start (the drawn lap); the new node is selected.
  Occluded parts of a trajectory are not clickable. Hover shows an "Add maneuver T-..." preview.
- Gizmo on the selected node, always at full strength (arms 2 px at 0.85 alpha; a node behind a body shows a
  dashed ring): prograde/retrograde, normal/antinormal, radial out/in handles along the node frame's projected
  axes, laid out by `layoutGizmo` (gizmo.ts): the most foreshortened axis turns toward the middle of the wider
  gap between the other two as its extent falls (seen from above the orbit the normal axis points at the eye
  and would lie on the radial line), all axis lines are kept 40 degrees apart, every handle at least 55 % of
  58 px out. Drag: `dv += sign * (d . handleDir) / 10`
  m/s per CSS px, Shift x0.1, Ctrl x10 (per frame, so modifiers may change mid-drag); past 120 px of travel
  the handle sits at its end stop and a rate ramp adds `2 * 2^(t/0.75 s)` m/s per second (max 500). Wheel
  over a handle: 0.1 m/s per step (times the modifiers).
- Dragging the node body slides it along its pre-node conic in time (nearest point on the drawn polyline,
  revolution closest to the previous time, never before now + 1 s).
- Panel (DOM, 248 px wide, opaque, HUD type and palette; placed at the best of eight places around the node
  just outside the gizmo: least drawn line covered (lineGrid.ts, the 12 px occupancy grid of the drawn
  segments, trajectories weighted highest), never over a handle, other UI or the body centre, not toward the
  body, the side kept during a drag; docked top-right while the node is off screen): Prograde /
  Normal / Radial each between its two axis glyphs as 24 px nudge buttons (1 m/s, Shift 0.1, Ctrl 10),
  Total (rescales the burn keeping its direction; a zero burn becomes prograde), In (time to the node in the
  HUD's countdown "T− 1:32:00.5"; typed also as "1h 30m", "T-90s", "1:02:03", "2d 03:04:05", plain seconds)
  and UT (calendar time "2028-03-03 20:51:40" UTC as the HUD clock writes it, J2000 = 2000-01-01 12:00
  treated as UTC; typed in the same form, or seconds since J2000). Every field is editable; the hint is two
  lines ("Drag a handle · Wheel 0.1 m/s" / "Shift fine · Ctrl coarse"). A typed value is applied
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
writes each line in one pass (copy, near cut, links, dash length, statistics). The draw list's icons, texts,
label boxes, point entries and cluster groups are pooled (a `DrawList` is valid until the next one is
built), label widths and node label strings are cached, and the label de-clutter works on one reusable
rectangle buffer.

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
`real-planet.spec.ts` (600 s) opens the integration lab (every render package in the tree, the baked tiles),
mounts the map feature through `window.__integration.app` and the public `createMapView`, and places the lab
camera itself; it fails when another package breaks the lab's console (its `expectClean`).

Lab: `/labs/map-view/?scene=lowOrbit|translunar|lunarOrbit|...|synthetic` with `&paused=1`, `&intercept=1`,
`&perf=1` (synthetic 8-patch load case, every debris orbit drawn), `&debris=1` (every debris orbit drawn),
`&quiet=1` (no lab text), `&spin=<rad/frame>`,
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

106 unit tests (11 files incl. boundaries) and 27 functional browser specs pass (2026-11-11, round 3). The 2
perf specs pass on the quiet machine (round 3: overview CPU p99 0.435 ms, close-up 0.495 ms, GPU p99 0.008 /
0.012 ms; tables in "Visual close-out, round 2" and "round 3"). The rows below are the original acceptance
runs of 2026-11-10.

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
| Overlay GPU < 0.1 ms (8 patches, 20 debris) | met: p99 <= 0.016 ms in every run (round 3: 0.008 / 0.012 ms) |
| Overlay CPU < 0.5 ms per frame | round 3, ~1 % load: overview p99 0.435 ms, Earth close-up p99 0.495 ms (met, the close-up near the line); under the other agents' load the p99 has missed in earlier runs (tables below) |

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
- Faint reference lines (not Patch conics) use a coarser tolerance than 0.3 px: other vessels' orbits and the
  hovered debris' orbit 0.9 px, debris orbits drawn all at once (the debris filter / perf load case) 1.5 px.
  Recovery-zone rings use the 0.29 px trajectory tolerance.
- Debris orbits are not drawn by default (dots; the hovered debris shows its orbit; `setDebrisOrbits(true)`
  draws them all), after the visual QA. The perf load case draws all 20, as the acceptance line states.
- `createMapView` takes an optional third argument `{ uiRoot, now }` for the panel and the clock.

## Known limits

- CPU budget: see "Visual close-out, round 2" for the current numbers: both lines pass on a quiet machine
  (3-7 % load), the close-up exactly at the line (p99 0.4999 ms). Under the other agents' load the p99 grows
  past 0.5 ms (rounds 1 and 2 alike); the next levers are in "Visual close-out, round 2".
- Perspective: seen straight down from close range a low orbit lies just behind the limb (at 24,000 km the
  silhouette in the plane of the Earth's centre is at 237 km altitude), so a 200 km orbit seen exactly from
  above at that distance is drawn only as the 1.5 px soft edge and cannot be clicked; tilt the view or zoom
  out. This is the true geometry (the old 6 px fade hid it).
- At-intercept drawing still shows a gap at each SOI EXIT: the patches after an encounter are drawn at
  their body's true position, the encounter around the body where it was at the entry, so the jump is the
  body's motion during the encounter (as in KSP). Ghost bodies occlude like real ones. Double-clicking a
  ghost focuses the real body.
- Occlusion uses the reference spheres (`BodyDef.radius`) and, above the atmosphere, the visible limb: terrain
  relief (up to ~10 km) is ignored, and lines on a surface rely on the computed radial chord slack (under half
  a pixel at the limb). The silhouette ring is drawn at the solid radius (on the night side the glow is
  absent; on the lit side the ring is faint and lies just inside the renderer's glow).
- Labels: hidden labels are only reachable through the hover tooltip; clustered icons through the cluster
  tooltip. Bodies have no tooltip of their own. A label still lands on a line when every candidate around its
  icon covers one (it prefers the one covering least; the opaque plate masks the line there).
- The node frame is approximate when a node can only be found from the patch after it (no marker and no
  patch ending at it); the gizmo and drags still work in that frame.
- Dashes cross-fade between two octaves of world period by depth: at a depth half-way between octaves a stretch
  shows both patterns at partial strength (a static frame can show it); zooming changes which pattern
  dominates, never where a dash sits on the path.
- Map icons are placed by geometry and are not moved off HUD panels: an object under the navball or a HUD
  panel is simply covered (no icon, no label); the player turns the map camera to see it. The obstacle shapes
  are rectangles, so an icon in the corner of the navball's box (outside the round ball) is left out too.
- `formatDistance` mirrors the HUD's `formatLength` rule by copy (src/map may not import src/ui): if flight-ui
  changes its rule, `src/map/format.ts` must follow (the unit test pins the shared cases).
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

- `docs/requests/map-view-4.md` (src/core, src/ui/hud/hudStyles.ts): the HUD's font stack and palette as
  shared constants. Resolved by core-support (d3134ab): `src/core/ui/theme.ts`; src/map imports it.
- `docs/requests/map-view-5.md` (labs/integration and the app shell's map mode; core-support), open, not
  blocking: mount the map with the flight HUD in map mode and pass the HUD panel rectangles to
  `setObstacles`. Workaround in map-view's own spec (`mountHud` in `real-planet.spec.ts`).
- `docs/requests/map-view-6.md` (atmosphere-clouds, terrain-render, sky-lighting), open, not blocking: the
  planet under the map at map distances (cloud texel blocks and grey tops, sea speckle, the Moon's limb smear,
  no stars in the map camera); routed from the round-1 photo critic's finding 5.

No contract was changed; no open requests against map-view paths exist.

## Screenshots (out/screens/map-view/, reviewed)

`scene-*.png` (each lab scene, synthetic and at-intercept), `lowOrbit-node.png` (gizmo + panel; the node is
behind the limb and its gizmo at full strength, asserted by pixel), `synthetic-earth.png`,
`synthetic-moon*.png` (panel beside node A), `synthetic-chain*.png`, `synthetic-8-patches.png` (the load case
at the overview: debris orbits under 60 px left out) and `synthetic-8-patches-earth.png` (its close-up, all 20
debris orbits drawn), `hover-impact-details.png`, `hover-add-maneuver.png`, `hover-debris-orbit.png`,
`zone-near-limb.png` (a recovery zone 82 degrees off the sub-camera point), `accept-*.png` (acceptance
steps, including `accept-panel.png` and `accept-follow-lowOrbit.png` / `accept-follow-lunarOrbit.png` from
the moving-camera spec), `dpr2-lowOrbit-node.png` and `dpr2-synthetic-moon.png` (1920 x 1080 CSS px at device
pixel ratio 2: interface scale 1.5, so 3 device px per interface px), and over the REAL renderer (the map feature mounted
into the integration lab by `real-planet.spec.ts`, `view.update` driven with the CSS size as the app does):
`real-lowOrbit.png` (with a pixel check that the night limb stands out from the sky), `real-lowOrbit-dayside.png`,
`real-lowOrbit-node.png`, `real-translunar.png`, `real-lunarOrbit.png`, and the frame the player sees, the map
with the real flight HUD (`createHud` from src/ui, panel rectangles as obstacles, node panel asserted clear of
every HUD panel): `real-hud-lowOrbit-node-720p.png`, `real-hud-lowOrbit-node-4k.png` (device pixel ratio 2),
`real-hud-translunar.png`, `real-hud-lunarOrbit.png`.

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

## Visual close-out, round 1 (2026-11-11)

Work list: `out/qa/wave2/map-view.md` (round 0: photo 4/10, artifact 4.5/10; 1 blocker, 8 major, 10 minor).
Commits 3020abc, 4de2513, d7246e8, 5ab653b, b8e3040, 5ea3e91 and the close-out commit. Every item below was
fixed at its cause, regenerated and looked at (Read, crops at 4-5x); the screenshot that shows it is named.

| # | Item | What was done | Evidence |
|---|---|---|---|
| 1 | blocker: false straight line across the frame and the planet | Lines are cut in float64 where they pass behind the eye (`VertexArrays.appendLine`, `CLIP_DEPTH_REL` 1e-5 of the distance): every drawn segment reaches the GPU with both ends safely in front, and the vertex shader no longer clips (it drops a segment with an end behind the near plane, which cannot happen) | `accept-occlusion.png` (one Moon-orbit line, cut at the limb), `accept-recovery-zones.png`; unit tests: 720 orientations at 24,000 km in lowOrbit and translunar, every drawn segment narrowed to float32 has w > near and projects within 1e-5 of its float64 position; the Moon orbit over the Earth disc is always hidden (72 yaws) |
| 2 | tooltip under the panel / over labels | No tooltip for the selected node or its handles (the drag hint moved into the panel footer); a tooltip takes the quadrant around the pointer, then further out, that covers neither the panel, nor a handle, nor `setObstacles` rectangles; labels keep clear of it (none cut through); the panel is opaque | `accept-node-added.png`, `hover-impact-details.png`; unit test (no tooltip on the selected node / handle; tooltips of all markers disjoint from panel and handles); browser check after adding a node (no tooltip, no handle under the panel, handles > 18 px apart) |
| 3 | selected gizmo dimmed behind the limb | The selected node's gizmo is a control: alpha 1, arms 2 px at 0.85; "behind a body" is a dashed ring on the node icon; unselected nodes keep the 0.35 floor | `lowOrbit-node.png`, `real-lowOrbit-node.png`; pixel assertion in `screens.spec.ts` (prograde and normal handle peaks at full colour while `describe()` reports the node hidden); unit test |
| 4 | normal handles on the radial axis | `gizmo.ts` `layoutGizmo`: the most foreshortened axis turns toward the middle of the wider gap between the other two as its extent falls, every pair of axis lines is kept 40 degrees apart, handles at least 55 % of 58 px out | `accept-node-added.png` (top-down: normal on the diagonals), `accept-panel.png`; unit test over 4,000 frames and views (separation, handles a diameter apart, none on another axis' bar) and the top-down controller case |
| 5 | zone rings torn near the limb | Lines on a surface are tested against the sphere shrunk by their chords' depth (radial allowance; shader and CPU twin), zone rings sampled at 0.29 px, closed rings joined across their seam | `zone-near-limb.png`, `scene-lowOrbit.png`, `real-lowOrbit-dayside.png`; unit test (zone 75-88 degrees off the sub-camera point: no hidden sample on the visible side, hidden past the soft edge) |
| 6 | icons pile up, bury the body, no leaders | Icons closer than 11 px collapse into one with a "+n" badge (a speck-sized body wins, then the active vessel, then priority; debris fold silently); the cluster tooltip lists the members; leaders for labels on the outer ring; ground twins within 12 px left out; Ap/Pe/AN/DN left out on patches under 40 px; unselected nodes 5.5 px | `scene-synthetic.png`, `synthetic-8-patches.png`, `accept-zoom-1e9m.png`, `real-translunar.png`; unit test (overview: nothing drawn over the Earth's disc, the Earth named, a badge present) |
| 7 | labels struck through by lines, over other UI | Every label sits on a dark plate that masks what is behind it; it takes the side of its own line (normal of the screen tangent, away from the body; marker / node time looked up on the patch line, vessel heading); `MapViewApi.setObstacles` for HUD panels (the lab passes its text boxes) | `synthetic-earth.png` (no label under the lab text), `synthetic-moon-intercept.png`, `scene-synthetic.png`; unit test (every label on a plate, marker labels off their own line) |
| 8 | weak legibility over a lit body; never shown over the real planet | Target names in the text colour at full alpha; a dark casing on every line; `real-planet.spec.ts` mounts the map feature into the integration lab (terrain, atmosphere and clouds, ocean, sky) and photographs low orbit (day side, terminator, night side, limb), the node editor, the translunar overview and lunar orbit; the lab backdrop's limb is anti-aliased | `real-lowOrbit.png`, `real-lowOrbit-dayside.png`, `real-lowOrbit-node.png`, `real-translunar.png`, `real-lunarOrbit.png` |
| 9 | typeface and panel differ from the HUD | Labels in the HUD family (Bahnschrift 13 px semibold, proportional, tabular digits; the atlas stores one advance per glyph); the node panel rebuilt from the HUD tokens (`src/core/ui/theme.ts`, request map-view-4, resolved): tracked capitals, the gizmo's axis glyphs as nudge buttons per component, icon buttons, opaque; panel ownership with the HUD's MANEUVER panel written down (Integration) | `lowOrbit-node.png`, `accept-panel.png`, `real-lowOrbit-node.png` |
| 10 | centre body unnamed | Bodies are named while their projected radius is under 40 px (priority above markers) | `scene-translunar.png`, `accept-zoom-1e9m.png`, `real-translunar.png` |
| 11 | occluded lines bleed 6 px over the disc | Limb fade 1.5 px | `accept-landing-target.png`, `accept-occlusion.png` |
| 12 | zone rings polygonal | Sampled at 0.29 px | `accept-recovery-zones.png`; unit test (worst chord error < 0.31 px) |
| 13 | debris scribble | Debris are dots; the hovered debris shows its orbit; `setDebrisOrbits(true)` draws all | `synthetic-earth.png`, `hover-debris-orbit.png`; browser test (no debris orbit, then exactly the hovered one) |
| 14 | muddy, zipping dashes | Dashes 12 on / 8 off, phase per vertex anchored at the node end; far-future patches fade toward a lighter tint of their hue at alpha 0.5 | `lowOrbit-node.png`, `synthetic-moon-intercept.png`, `synthetic-earth.png` |
| 15 | panel covers the downstream trajectory | The panel takes the best of eight places around the node just outside the gizmo (least trajectory covered, never over a handle, other UI or the body centre, not toward the body), keeps its side during a drag, docks top-right when the node is off screen | `accept-node-added.png`, `synthetic-moon-intercept.png`, `lowOrbit-node.png` |
| 16 | translucent panel, icons under it | Opaque panel; icons whose centre lies under it are left out | `synthetic-moon-intercept.png` |
| 17 | icons do not say what they are | Ap: ring with an up chevron, Pe: down chevron, SOI entry / exit arrows in / out, the vessel an arrowhead along its screen velocity | `hover-impact-details.png`, `scene-synthetic.png`, `accept-zoom-200km.png` |
| 18 | SOI drawn from inside | Nothing is drawn from inside an SOI | `accept-landing-target.png`, `real-lunarOrbit.png`; unit test |
| 19 | megametres, "T-0.0s" | Distances in km with narrow no-break space grouping ("425 586 km"), "now" within a second | `scene-synthetic.png`; unit test |

Not fixed, or only in part, and why:
- 14, in part: dashes are still laid out in screen length from the node end, so far from the node they slide
  along the line while the camera turns; no moving-camera sequence of a dashed patch was recorded. A
  view-stable dash parameter (arc length scaled by the local pixel scale) was left for lack of time.
- 8, in part: occluders keep `BodyDef.radius` (the atmosphere glow does not hide lines behind it; on the real
  renderer the difference is under 3 px at map distances). The real-renderer spec depends on the other render
  packages: while it ran, the atmosphere, sky and ocean packages were each broken in the tree at some point
  (WGSL errors, failed imports); the lab switches such a feature off, and once a 500 from another package's
  module failed `expectClean`. The last full run passed with everything loaded.
- 19, consistency: the HUD's `formatLength` (src/ui) still writes Mm above 10,000 km; the map writes grouped
  km everywhere. Not changed (not my path); a request was not filed because the item asks for km.
- Line avoidance by labels: the first version placed labels by an occupancy grid of all drawn lines; it cost
  about 0.04 ms per frame in the browser, so labels now take the side of their own line and rely on the
  plate for any other line crossing them (the critics' item 7 offers either). The grid remains for the panel.

### Overlay cost (perf spec, under the GPU lock; machine load sampled around each run)

| Run | Load | Overview CPU p50 / p99 | Close-up CPU p50 / p99 | GPU p99 (ov / cu) |
|---|---|---|---|---|
| 5ab653b | 6-15 % | 0.250 / **0.445** | 0.260 / **0.475** | 0.026 / 0.003 ms |
| 5ea3e91 (labels by own line, closed-ring joins) | 12-31 %, 4 GPU slots busy | 0.265 / 0.510 | 0.310 / 0.520 | 0.003 / 0.003 ms |
| final (debris rings open) | 5-35 %, 4 GPU slots busy | 0.280 / 0.590 | 0.310 / 0.645 | 0.002 / 0.003 ms |

The GPU line (0.1 ms) holds with a wide margin. The CPU p99 line passed in the quiet window and misses under
the concurrent load of the other agents' suites. For scale, the pre-session code (9d04af4) measured side by
side in the same browser session, three interleaved rounds at 15-50 % load: overview p99 0.405-0.450 ms,
close-up 0.460-0.495 ms; the current code 0.470-0.505 and 0.540-0.645 ms (p50 +0.02 / +0.04-0.07 ms). In Node
(tight loop, mean) scene build 0.083 ms (pre-session 0.082) and draw list 0.010-0.017 ms (pre-session
0.007; first version of this round 0.035). What the draw list does now that it did not: clustering, label
sides, plates and leaders, tooltip and panel placement; all of it pooled (no per-frame garbage). Per
PACKAGE_RULES 16 the CPU line is left to the quiet-machine re-measure; if it still misses there, the next
lever is the bulk debris orbits (about half the close-up's vertices, now drawn only with the debris filter).

### Tests

Unit: 87 in 9 files (incl. boundaries), new `tests/unit/map-view/visualQa.test.ts` (14). Browser
(functional): 23 specs, new `real-planet.spec.ts` (2), the zone-near-limb and debris-hover specs, the
pixel assertion on the occluded gizmo, the disjointness check after adding a node. Perf: 2 (above).

### Own assessment

Photo lens about 7: the map now reads over the real planet (cased lines, plates, HUD type) and nothing false
is drawn; the lab backdrop is still a flat shaded sphere in most pictures and the dashes still crawl.
Artifact lens about 7.5: the blocker and the gizmo, tooltip, panel and pile-up defects are gone at their
causes; the CPU p99 line is not reliably met under load.

## Visual close-out, round 2 (2026-11-11)

Work lists: `out/qa/wave2/map-view.r1.photo.json` (photo 6/10) and `out/qa/wave2/map-view.r1.artifact.json`
(artifact 6.5/10). Commits efe7c86, 6efb18b, 0f01eda and the close-out commit. Each item was changed at its
cause, the pictures regenerated and looked at (crops at 4-5x), next to `out/qa/ref/earth-orbit-clouds/limb-panorama.jpg`,
`airglow-red-yellow.jpg` and `moon-surface/earthrise-a17.jpg` for the night limb. New unit tests:
`tests/unit/map-view/visualQa2.test.ts` (12); new browser pictures: `real-hud-*`, `dpr2-*`.

| Item (photo P / artifact A) | What was done | Evidence |
|---|---|---|
| P1, A3 (major): night side as black as space, orbits end in mid-air | Every body whose disc the renderer draws gets a silhouette ring (`addLimbLine`: the solid sphere's outline, 1.25 px, no casing, alpha per vertex from the sun: full on the night side, 28 % on the lit side; tested against the sphere shrunk by its chord depth so the body never hides it). Below 12 px the body is a shaded disc icon. Browser check: on the night stretch the limb pixel is >= 20/255 above the sky 8 px out | `real-lowOrbit.png`, `real-lunarOrbit.png`, `real-hud-lunarOrbit.png`; unit test (ring strong at night, faint by day, never self-hidden) |
| P2, A4 (major): the pad label a 35-40 % ghost over the lit planet | Visibility is binary: icon, plate and label at full strength while hidden < 0.5, else nothing (the soft weight drove their alpha); surface targets no longer fade with body size either | `real-lowOrbit-dayside.png` (the pad 3-5 px inside the limb is now simply absent), `real-lowOrbit.png` (pad label full strength); unit test: no icon, plate or text with partial alpha over 96 views |
| P3 (major): the map never shown with the HUD, no 4K picture | `real-planet.spec.ts` mounts the real flight HUD (`createHud`, updated every frame with the map camera), hands its panel rectangles and the navball box to `setObstacles`, drives `view.update` with the CSS size, and asserts the node panel clear of every HUD panel; 720p (low orbit with a node, translunar, lunar orbit) and 1920 x 1080 at device pixel ratio 2. The app / integration-lab wiring is request map-view-5 | `real-hud-lowOrbit-node-720p.png`, `real-hud-lowOrbit-node-4k.png`, `real-hud-translunar.png`, `real-hud-lunarOrbit.png`, `dpr2-*.png` |
| P4 (major): Earth buried at the overview, badge between icons, a label 37 px from its marker, the mission in 250 px | Bodies under 12 px radius are shaded disc icons (mean albedo colour, terminator from the sun, rim, casing) drawn above every line and owning their cluster (reach from the disc edge); badges sit on the icon's upper-right corner; the impact and entry labels of folded members stay beside the cluster; scored label placement with a penalty for a nearer foreign icon, leaders past 11 px or on a diagonal; other vessels' orbits under 60 px across left out; the lab's overview at 820,000 km (the Moon's orbit fills the height) | `scene-synthetic.png`, `synthetic-chain.png`, `synthetic-8-patches.png`; unit tests (the Earth's disc the only icon on it, lit toward the sun, badge on the corner; small orbits left out) |
| P5 (major, not this package): clouds, sea speckle, the Moon's limb, no stars | Request map-view-6 to atmosphere-clouds, terrain-render and sky-lighting with the critic's coordinates and references; `real-planet.spec.ts` stays the acceptance view | `docs/requests/map-view-6.md` |
| A1, P7 (major / minor): coincident patches interleave (zig-zag, barber pole, candy stripe), muddy colours, dashes slide | (1) Coincident patches drawn once (`suppressCoincident`: occupancy bitmap in priority order; hidden stretches stay clickable; flicker evened out). (2) All casings drawn before all cores (two pipelines). (3) Dashes fixed to the path: arc length in metres from the node (Simpson, cached per vertex parameter), world periods per octave of depth, two octaves cross-faded per fragment: no sliding when the camera turns, zooms or follows, about 20 px near and far. (4) Fade by alpha alone to 0.72, the hue kept | `accept-node-added.png` (zero delta-v: one orbit, cyan to the node, yellow dashes after it), `synthetic-earth.png`, `hover-debris-orbit.png`, `synthetic-8-patches.png`; unit tests (zero-delta-v node: no stretch drawn twice; the dash coordinate of a world point unchanged within 2e-4 over camera yaws 0.30-0.90) |
| A2, P8 (major / minor): debris dots inside label text, see-through plates | Plates opaque (0.95); debris dots drawn in a layer under the plates (dots, plates and leaders, icons, gizmo, then text) | `synthetic-earth.png`, `hover-debris-orbit.png`; unit test (every debris icon precedes every plate) |
| A5, P10 (major / minor): the two Ap labels read crosswise; the current Pe always folded into "+1" | Ap / Pe icons in their own patch's colour (current cyan, planned yellow), each label's first line tinted with its marker's colour; diagonal placements get a short leader; the apsis the active vessel sits at is printed as the vessel label's second line | `accept-panel.png`, `lowOrbit-node.png` ("Fake vessel / Pe 200.0 km now"); unit test |
| A6 (minor): labels on lines, the Node 1 plate over the orbit beside the node | Candidates scored by the trajectory weight they cover (`LineGrid`, every draw list); the selected node has no label (its panel beside it names it) | `synthetic-moon-intercept.png`, `accept-panel.png` |
| A7 (minor): the vessel name 20 px off its glyph, stacked on "Earth" | The same leader rule; the active vessel's label at priority 8.5 in its trajectory colour | `real-translunar.png`, `scene-translunar.png` |
| A8 (minor): outline markers show the line through them | Ring, diamond, pad and handle glyphs have an opaque dark interior | `synthetic-moon-intercept.png`, `accept-occlusion.png` (the zone ring stops at the pad square) |
| A9, P6 (minor): the vessel looks like a mouse pointer | Elongated chevron (length : width 1.6) with a deep tail notch, 9.5 px, in the trajectory's cyan with a dark outline; other vessels 7 px grey | every picture with a vessel, e.g. `accept-zoom-200km.png`; unit test (nose along the projected velocity) |
| A10, P9 (minor): a notch at the zone ring's seam, a pale arc along the horizon, the centre dot half outside, the ring through the pad | Casings in their own pass (no casing over a core); lines lying on a surface are cut at the limb (steep ramp) instead of drawn at partial strength along it; zone centre icons binary; filled pad interior | `zone-near-limb.png`, `real-lowOrbit-dayside.png`, `accept-occlusion.png` |
| A11, P9 (minor): lines run 3 px into the atmosphere rim | Occluders carry a visible-limb radius (grazing Rayleigh optical depth 0.03: 51 km for the Earth): points above that shell are hidden by it, points inside it by the solid sphere only | `real-lowOrbit-dayside.png`; unit test (behind the glow hidden, inside the shell visible) |
| A12, P12 (minor): the hovered debris not highlighted; the tooltip border on the trajectory | The hovered vessel or debris is ringed and its orbit drawn in the hover colour at 2 px; tooltip candidates cost the trajectories under them and within 6 px of their edges | `hover-debris-orbit.png`, `hover-impact-details.png`; unit tests |
| P11 (minor): panel finish | UT as the HUD clock's calendar time (typed back in that form), time to the node in the HUD's countdown, one notation for time-to everywhere ("T− 1:32:00"), two balanced hint lines, 24 px axis buttons. Total and In are editable fields (Total rescales the burn, In sets the time), so they stay boxed | `lowOrbit-node.png`, `accept-panel.png`; unit tests (formats round-trip) |
| P13 (minor): flat type hierarchy, holes around "1", a bare patch start | Body names in tracked capitals without a plate; the active vessel's label in its trajectory colour; proportional digits in labels (the panel keeps tabular ones); a small entry tick where a patch starts in another body's frame | `scene-synthetic.png`, `synthetic-moon-intercept.png` |

Not fixed, or only in part:
- P5: the planet's own rendering at map distances belongs to other packages (request map-view-6).
- P3: the app and the integration lab do not mount the map yet (request map-view-5); the composed frame
  exists only in map-view's spec. Map icons are not moved off HUD panels (an icon under the navball stays there).
- A1: no browser frame sequence of a moving camera was recorded; the path-fixed dash coordinate is checked in a
  unit test (arc length at fixed world points over camera rotation), and the shader reads it per vertex.
- The HUD's Mm and the map's km now meet in one frame (noted in request map-view-5).

### Overlay cost (perf spec under the GPU lock; whole-machine load sampled before and after)

| Run | Load | Overview CPU p50 / p99 | Close-up CPU p50 / p99 | GPU p99 (ov / cu) |
|---|---|---|---|---|
| first round-2 build | 2 % | 0.295 / 0.505 | 0.340 / 0.605 | 0.010 / 0.011 ms |
| + arc cache, clipped coincidence pass | 2 % | 0.290 / **0.480** | 0.325 / 0.555 | 0.010 / 0.015 ms |
| final (unrolled lookups, 12 px label grid, packed cluster radii) | 3-7 % | 0.230 / **0.480** | 0.245 / **0.4999** | 0.010 / 0.009 ms |

Both lines pass on the quiet machine, the close-up exactly at the line. Node, same process, 900 frames with an
orbiting camera (scene + draw list): round-1 code 0.102 / 0.076 ms per frame (close-up / overview), final code
0.148 / 0.109 ms. What the extra time buys: the coincidence pass (about 0.02 ms in the close-up, where the four
nearly identical laps of the load case really do lie on each other), the silhouette rings, the label grid
every frame, the arc lengths (cached; about 0.003 ms once warm). The overview distance of the perf spec is pinned
at 1.15e9 m (the lab's own default overview is closer now). Next levers if the line must hold under load: the
round-1 sampler's exact error per resampled piece (pieceError + resample are a quarter of the close-up), and a
dilated bitmap for the coincidence test.

### Tests

Unit: 94 in 9 files plus boundaries (101 with the boundaries test's 7) (new `visualQa2.test.ts`, formats extended). Browser (functional): 27
specs (new: the HUD composition at 720p and 4K, two device-pixel-ratio-2 lab pictures, the night-limb pixel
check). Perf: 2 (above).

## Visual close-out, round 3 (2026-11-11)

Work list: the round-2 critics' lists (`out/qa/wave2/map-view.r2.photo.json`, `.r2.artifact.json`) were not
produced (the round-2 score is blank and the files do not exist). The package's new owner therefore reviewed
all 37 round-2 pictures as the critics would (crops at 2-6x, next to `out/qa/ref/moon-surface/earthrise-a8.jpg`
and `earth-orbit-clouds/limb-panorama.jpg`), re-checked every open item of the round-1 lists, and worked the
defects found. Commits 7608425, 6fa3894 and the close-out commit.

| Item (own review of the round-2 pictures) | What was done | Evidence |
|---|---|---|
| major (both lenses): at 1080p / 4K the HUD's type and panels scale with `min(1vh, 0.5625vw)` (1.5x at 1920 x 1080 CSS px) but the map's labels, icons, gizmo, lines and node panel stayed at their 720p size: the map read as two thirds of the HUD beside it, the node panel visibly smaller than the HUD's MANEUVER panel (`real-hud-lowOrbit-node-4k.png`, `dpr2-*.png`) | One interface scale for the whole map (`uiScale` in projection.ts: the HUD's unit relative to 720p, steps of 1/16, floor 0.8). `Projector.pxScale` is now device px per INTERFACE px (every pixel constant, the glyph atlas size, hit tolerance), `Projector.cssScale` device px per CSS px (pointer, describe(), DOM panel, obstacles, tooltip rect). The node panel's CSS is written in interface px and multiplied by `--mu`; it re-reports its size when the scale changes. Handle drags count pointer motion in interface px, so the handle stays under the pointer (1 m/s per 10 interface px). At 1280 x 720 nothing changes | `real-hud-lowOrbit-node-4k.png` (map panel, labels and gizmo in proportion with the HUD), `dpr2-lowOrbit-node.png`, `dpr2-synthetic-moon.png`; unit tests `visualQa3.test.ts` (scale steps, 3 device px per interface px at 1080p / DPR 2, describe() in CSS px, handle under the pointer at 1080p) |
| major (artifact): in the composed translunar frame the Moon, the mission's destination, lay under the navball, its SOI circle under the SAS panel (`real-hud-translunar.png`) | (1) Cause in the map: an anchor under a `setObstacles` rectangle now gets neither icon nor label (it is covered by the HUD; before, its label was set beside the panel). (2) The spec's camera turns the view about its axis so the Moon sits upper right (`orbitView` `moonAt`), as a player turns the map camera | `real-hud-translunar.png` (Moon, its SOI and label clear, upper right) |
| minor (artifact): the "Tranquility Base" label stood beside the HUD's ORBIT SPEED plate with a leader pointing into it (the pin was under the plate) (`real-hud-lunarOrbit.png`) | The rule above drops the covered pin and its label; the lunar HUD picture is rolled 180 degrees (space has no up) so the landing target is in view | `real-hud-lunarOrbit.png` (pin and label clear of every HUD plate); unit test (a vessel or surface target under an obstacle: no icon, no label) |
| minor (artifact; round-1 photo P4 / artifact A2 leftovers): in the load case the 11 px Earth icon was wrapped in a scribble of twenty debris rings 10-20 px across (`synthetic-8-patches.png`) | Debris orbits drawn in bulk obey the 60 px minimum span of other vessels' orbits (the hovered one is always drawn). The load case still draws all 20 at the close-up, where the perf spec measures them | `synthetic-8-patches.png` (clean Earth icon), new `synthetic-8-patches-earth.png` (close-up, 20 rings); unit test; browser spec asserts 0 rings at the overview and 20 at the close-up |
| minor (artifact; round-2 hand-off left it to flight-ui): one quantity in two units in the same frame, "180.0 Mm" in the HUD and "180 000 km" on the map (`real-hud-translunar.png`) | The map writes lengths with the HUD's rule (`formatDistance(m, 'distance' / 'apsis' / 'altitude')` mirrors `src/ui/format.ts` formatLength, narrow no-break spaces, true minus): "Ap 180.0 Mm", "Ap 1 839.1 km", "miss 22.70 km". Request map-view-5 item 4 withdrawn | `real-hud-translunar.png`, `real-translunar.png`, `scene-synthetic.png`; unit test (shared cases) |

Re-checked and still fixed (round-1 items): no mirrored chord in any picture; tooltips clear of the panel and of
labels; selected gizmo at full strength behind the limb; axes fanned from above; zone rings continuous to the
limb; clustering with badges on the icon; opaque plates over dots; night limb ring; labels binary; HUD type
and panel style; vessel chevron; Ap/Pe tinted per patch.

Not fixed, or only in part, and why:
- The planet under the map (photo lens): cloud texel blocks and grey cloud tops at 14,000-24,000 km, the
  Moon's limb smear, belong to atmosphere-clouds / terrain-render / sky (request map-view-6, still open; the
  real-planet pictures were re-taken on the current tree and show the same). No stars in the map frames is
  physically right at the exposure of a sunlit planet (`earthrise-a8.jpg`: black sky, no stars).
- The map is still mounted by its own spec, not by the app or the integration lab (request map-view-5, open).
- Most lab pictures still use the lab's analytic sphere (labs/map-view/backdrop.ts); the real-planet pictures
  are the acceptance views for the planet. No licensed global albedo map exists in the tree to texture it.
- Two DIFFERENT planned patches that run 4-6 px apart (synthetic-earth.png, both legs of the return) are drawn
  as two parallel dashed lines with unrelated dash phases; merging lines that far apart would also hide the
  effect of a small burn, so the coincidence threshold stays at 3 px.

### Overlay cost (perf spec under the GPU lock)

| Run | Load | Overview CPU p50 / p99 | Close-up CPU p50 / p99 | GPU p99 (ov / cu) |
|---|---|---|---|---|
| round 3 final (6fa3894) | ~1 %, all GPU slots free after the run | 0.195 / **0.435** | 0.240 / **0.495** | 0.008 / 0.012 ms |

Both lines pass. The interface scale costs nothing at 720p (the perf lab runs at 1280 x 720); the obstacle
test is a loop over the HUD rectangles per point entry.

### Tests

Unit: 99 in 10 files plus boundaries (106 with the boundaries test's 7); new `tests/unit/map-view/visualQa3.test.ts`
(5), the units test rewritten. Browser (functional): 27 specs (the load-case spec checks the close-up too; the
HUD specs frame the Moon and the landing target clear of the HUD). Perf: 2 (above).

### Own assessment

Photo lens about 7: the composed frames now read as one interface at 720p and 4K (one type scale, one unit,
nothing hiding under the HUD), but the planet the overlay sits on still gives the composite away next to a
photograph, and that is outside this package. Artifact lens about 8: no defect of the overlay itself is left
that I could find in the 38 pictures at 2-6x; the open points are the parallel dashed pair and the lab sphere.
