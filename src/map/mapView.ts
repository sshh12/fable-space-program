/**
 * createMapView: the map view controller (MapView) and its overlay RenderFeature.
 *
 * Frame protocol (docs/ARCHITECTURE.md section 5): the app calls `view.update(lastSnapshot, lastCamera,
 * sim.commands, input.pointer, cssDisplaySize)` BEFORE the flight controller and the camera rig, with the
 * snapshot and camera of the frame on screen; the renderer then calls `feature.prepare(frame)` and
 * `feature.drawOverlay(frame, pass)` for the new frame. Hit-testing reuses the geometry built when that
 * frame was drawn, so the pointer is tested against exactly what the player sees.
 *
 * Units: `update`'s displaySize and the pointer are CSS pixels of the canvas; FrameContext.displaySize is
 * device pixels. drawOverlay reads only frame.snapshot, frame.camera and frame.displaySize.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, RenderContext, RenderFeature } from '@/core/contracts/render';
import type { MapView } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';
import { defaultTextMetrics, MapController, type MapStats } from './controller';
import { OverlayRenderer, type OverlayCounts } from './gpu/overlayRenderer';
import { NodePanel } from './panel';

export interface MapViewOptions {
  /**
   * Element laid over the canvas whose CSS pixels coincide with the canvas' (the HUD container). The node
   * panel is placed in it. Default: document.body with fixed positioning, which is right when the canvas
   * fills the viewport (the app shell and every lab).
   */
  uiRoot?: HTMLElement;
  /** Milliseconds clock for the handle rate ramp (default performance.now). */
  now?: () => number;
}

export interface MapViewApi extends MapView {
  /** Toggle: draw encounter patches around their body's position at intercept (Patch.bodyPosAtEnd). */
  setDrawAtIntercept(on: boolean): void;
  readonly drawAtIntercept: boolean;
  readonly isActive: boolean;
  readonly selectedNodeId: string | null;
  selectNode(id: string | null): void;
  /** Geometry statistics of the last built scene (labs and tests). */
  stats(): MapStats & { gpu: OverlayCounts | null };
  /** The node panel element (null without a DOM). */
  readonly panelElement: HTMLElement | null;
  /** The CPU controller (hit-testing, panel actions) for labs and tests. */
  readonly controller: MapController;
  dispose(): void;
}

export interface MapViewHandle {
  view: MapViewApi;
  feature: RenderFeature;
}

export function createMapView(gpu: GpuHandle, defs: DefLibrary, opts: MapViewOptions = {}): MapViewHandle {
  let renderer: OverlayRenderer | null = null;
  let counts: OverlayCounts | null = null;
  let drawn = false;
  // Text metrics come from the glyph atlas once the GPU side exists (labels are laid out with real advances).
  const controller = new MapController(defs, {
    now: opts.now,
    textMetrics: (k) => (renderer ? renderer.atlasFor(k).metrics : defaultTextMetrics(k)),
  });

  const hasDom = typeof document !== 'undefined';
  const root = opts.uiRoot ?? (hasDom ? document.body : null);
  const panel = root ? new NodePanel(controller, root, opts.uiRoot === undefined) : null;

  const feature: RenderFeature = {
    id: 'map',
    order: 100,
    init(ctx: RenderContext): void {
      renderer = new OverlayRenderer(gpu.device, ctx.canvasFormat, ctx.shaders);
    },
    prepare(frame: FrameContext): void {
      drawn = false;
      if (!renderer || !controller.isActive) {
        panel?.sync(null);
        return;
      }
      const list = controller.frame(frame.snapshot, frame.camera, frame.displaySize);
      if (!list) return;
      counts = renderer.upload(list);
      drawn = true;
      panel?.sync(controller.panelState());
    },
    drawOverlay(_frame: FrameContext, pass: GPURenderPassEncoder): void {
      if (drawn && renderer) renderer.draw(pass);
    },
    isIdle: () => true,
    dispose(): void {
      renderer?.dispose();
      renderer = null;
      panel?.dispose();
    },
  };

  const view: MapViewApi = {
    setActive(active) {
      controller.setActive(active);
      if (!active) panel?.sync(null);
    },
    update: (snapshot, camera, commands, pointer, displaySize) => controller.update(snapshot, camera, commands, pointer, displaySize),
    describe: () => controller.describe(),
    setDrawAtIntercept: (on) => controller.setDrawAtIntercept(on),
    get drawAtIntercept() {
      return controller.drawAtIntercept;
    },
    get isActive() {
      return controller.isActive;
    },
    get selectedNodeId() {
      return controller.selectedNodeId;
    },
    selectNode: (id) => controller.selectNode(id),
    stats: () => ({ ...controller.stats(), gpu: counts }),
    panelElement: panel?.element ?? null,
    controller,
    dispose: () => feature.dispose?.(),
  };
  return { view, feature };
}
