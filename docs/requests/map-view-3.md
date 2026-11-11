Status: resolved (commit 3d9fcae)
From: map-view
Owner path: src/core/contracts/ui.ts (MapView), src/core/contracts/render.ts (drawOverlay), src/core/contracts/sim.ts (Patch doc comments)
Blocking: no

## Problem
Six points the contracts leave open; src/map implements the reading below, which should be written down
so the app shell, the render core and the sim agree with it.
1. `MapView.update(..., displaySize)`: units unspecified. The pointer is in CSS px of the canvas; FrameContext
   .displaySize is device px. src/map takes update's displaySize in CSS px and derives device px per CSS px
   from the next drawOverlay frame.
2. `RenderFeature.drawOverlay`: the colour format and encoding of the LDR overlay pass are not stated. src/map
   creates its pipelines for `RenderContext.canvasFormat` and writes display-referred sRGB, premultiplied alpha
   (as for a bgra8unorm swap chain). If the core's overlay target is an `-srgb` view or another format, every
   overlay feature needs to know.
3. `MapView` has no way to place DOM UI, but the node editor needs a numeric panel (typing requires DOM inputs).
   src/map takes it as a factory option: `createMapView(gpu, defs, { uiRoot?: HTMLElement })` (default
   document.body with fixed positioning, right when the canvas fills the viewport).
4. `SimSnapshot.patches.planned` "(from the first node on)": does it start AFTER the first node (FakeSim:
   planned[0].afterNodeId = node 1) or with the patch that CONTAINS node 1 (ending at it with endReason
   'maneuver')? src/map draws planned patches only when afterNodeId is set (upstream ones duplicate `current`)
   and locates nodes from maneuverNode markers, a patch ending at node.ut, or the patch starting after it,
   so both readings work; the sim and the pilot should still agree on one.
5. `Patch.bodyPosAtEnd` "lets the map draw encounters at intercept": src/map draws each encounter body's
   patches around the body's ROOT position at the SOI ENTRY, derived from the preceding patch as
   `prev.bodyPosAtEnd + conicPosition(prev.conic, prev.nuEnd) - conicPosition(p.conic, p.nuStart)`, so the
   drawn chain is continuous at the intercept (KSP behaviour). Drawing at the encounter patch's own
   bodyPosAtEnd (the body at SOI exit or impact) leaves a gap of the body's motion during the encounter
   (65,000 km for a 17 h lunar approach). Every encounter gets its own anchor (a planned encounter at
   another time than the current one is drawn around its own ghost).
6. `MapUpdateResult.consumed` "hover over an interactive element": src/map consumes while the pointer
   hovers a maneuver node or a gizmo handle, during a handle or node drag (until release), over the node
   panel and while a panel field has focus. It does NOT consume while hovering trajectories, bodies or
   markers, although clicks on them do something (add a node, set the target, double-click to focus):
   in map view the orbit lines and the planet discs cover most of the screen, so consuming there would stop
   the camera rig from rotating and zooming over them. Their actions fire only on a press-release with
   less than 4 px of movement; a press that moves further is a camera drag (KSP behaviour).

## Evidence
src/map/mapView.ts (header comment, MapViewOptions), src/map/gpu/overlayRenderer.ts (pipelines on
canvasFormat, premultiplied blend), src/map/scene.ts (`anchors`, `drawPatches`), src/map/nodes.ts
(`locateNode`), src/map/controller.ts (`update`: `hoverInteractive`, `CLICK_SLOP_PX`). Unit tests in
tests/unit/map-view/controller.test.ts: "at intercept, the encounter is drawn around the body where it was
at the SOI entry: the chain is continuous", "at intercept, a planned encounter at another time than the
current one gets its own anchor and ghost", and "hover consumes over nodes, handles and the panel, not over
click-only trajectories and bodies".

## Requested change
Doc comments only: (1) "displaySize: CSS pixels of the canvas, the space of PointerState"; (2) in
drawOverlay: "colour target in RenderContext.canvasFormat (non-sRGB view), display-referred sRGB values,
premultiplied alpha" or the actual format; (3) optionally `MapView.mount?(container: HTMLElement): void`
matching `Hud.mount`, which src/map would implement in place of the factory option; (4) one sentence fixing
where `planned` starts; (5) the at-intercept derivation above in the bodyPosAtEnd comment; (6) in
MapUpdateResult.consumed: "hover over a draggable element (node, gizmo handle) or the map's DOM panel;
click-only elements (trajectories, bodies, markers) do not consume on hover, and a press that moves more
than a few pixels over them belongs to the camera".
What must NOT change: the existing fields and signatures.

## Resolution
Lead, doc comments only; no field or signature changed. src/map's readings are confirmed as the contract.

1. `MapView.update` (`src/core/contracts/ui.ts`): `displaySize` is the canvas size in CSS pixels, the space
   of `PointerState` and `MapElementInfo`.
2. `RenderFeature.drawOverlay` (`render.ts`): the pass is the core's tonemap pass onto the canvas - one
   colour target in `RenderContext.canvasFormat` (non-sRGB view, `alphaMode: 'opaque'`), no depth, sample
   count 1; write sRGB-encoded display-referred values with premultiplied-alpha blending. This is what the
   core does (`src/render/core/post/tonemap.ts`, RENDER_API section 2 row 11).
3. `MapView.mount` was NOT added (declined part): the factory option
   `createMapView(gpu, defs, { uiRoot?: HTMLElement })` stays the way to place the node panel; the `MapView`
   comment names it. The app passes the HUD container.
4. `SimSnapshot.patches.planned` (`sim.ts`): starts AT the first future node - `planned[0].tStart =
   nodes[0].ut`, state on the current trajectory plus the node's delta-v; every planned patch carries
   `afterNodeId`; the arc before the first node exists only in `current`. This is what `predictPatches`
   (`src/sim/orbit/patches.ts`) and FakeSim emit; sim-world-pilot publishes it unchanged.
5. `Patch.bodyPosAtEnd`: the at-intercept anchor derivation (SOI entry, per encounter) is in the comment.
6. `MapUpdateResult.consumed`: draggable elements and the DOM panel consume; click-only elements
   (trajectories, bodies, markers) do not consume on hover, and a press that moves more than a few pixels
   over them belongs to the camera.
Also from the flight-ui hand-off: `NavballRenderer.view` is documented as sRGB-encoded, premultiplied.
