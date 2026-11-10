Status: open
From: map-view
Owner path: src/core/contracts/ui.ts (MapView), src/core/contracts/render.ts (drawOverlay), src/core/contracts/sim.ts (Patch doc comments)
Blocking: no

## Problem
Five points the contracts leave open; src/map implements the reading below, which should be written down
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
   (65,000 km for a 17 h lunar approach).

## Evidence
src/map/mapView.ts (header comment, MapViewOptions), src/map/gpu/overlayRenderer.ts (pipelines on
canvasFormat, premultiplied blend), src/map/scene.ts (`anchors`, `drawPatches`), src/map/nodes.ts
(`locateNode`). Unit test: tests/unit/map-view/controller.test.ts "at intercept, the encounter is drawn around
the body where it was at the SOI entry: the chain is continuous".

## Requested change
Doc comments only: (1) "displaySize: CSS pixels of the canvas, the space of PointerState"; (2) in
drawOverlay: "colour target in RenderContext.canvasFormat (non-sRGB view), display-referred sRGB values,
premultiplied alpha" or the actual format; (3) optionally `MapView.mount?(container: HTMLElement): void`
matching `Hud.mount`, which src/map would implement in place of the factory option; (4) one sentence fixing
where `planned` starts; (5) the at-intercept derivation above in the bodyPosAtEnd comment.
What must NOT change: the existing fields and signatures.
