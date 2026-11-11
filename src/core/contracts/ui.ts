/**
 * Player-facing interface contracts: HUD, navball, cockpit displays and the map view.
 */
import type { PlayerCommands, PointerState } from './controls';
import type { DefLibrary } from './defs';
import type { CameraState } from './render';
import type { SimSnapshot } from './sim';

/**
 * The navball is a real 3-D sphere rendered with WebGPU into a texture (published as 'ui.navball') that
 * both the HUD and the cockpit instrument display.
 */
export interface NavballRenderer {
  /** 512 x 512 rgba8unorm texture view holding sRGB-encoded colour premultiplied by alpha; alpha = coverage of the ball. */
  readonly view: GPUTextureView;
  render(encoder: GPUCommandEncoder, snapshot: SimSnapshot): void;
}

export type MfdPage = 'flight' | 'orbit' | 'systems' | 'staging' | 'entry' | 'landing';

/** Draws a cockpit multi-function display page with Canvas 2D. Shares formatters with the HUD. */
export interface MfdPainter {
  readonly pages: readonly MfdPage[];
  paint(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, page: MfdPage, snapshot: SimSnapshot, defs: DefLibrary): void;
}

/** The DOM HUD layered over the canvas (flight views) and its hooks for the app shell. */
export interface Hud {
  /** Mount into the given container element (positioned over the canvas). */
  mount(container: HTMLElement): void;
  /** `camera` tells the HUD which view is shown; branch on camera.kind (unknown modes behave as their kind). */
  update(snapshot: SimSnapshot, camera: CameraState, realDt: number): void;
  setVisible(visible: boolean): void;
  /** Transient message line (warp refusals, staging lockout...). */
  notify(message: string): void;
  dispose(): void;
}

/**
 * Map view controller: owns orbit lines, markers and maneuver-node editing (via PlayerCommands only).
 *
 * DOM UI: the node editor has a numeric panel (typing needs DOM inputs). The contract has no mount method;
 * the factory takes the element to place it in, `createMapView(gpu, defs, { uiRoot?: HTMLElement })` in
 * src/map: an element laid over the canvas whose CSS pixels coincide with the canvas' (the HUD container).
 * Default: document.body with fixed positioning, which is right when the canvas fills the viewport.
 */
export interface MapView {
  setActive(active: boolean): void;
  /**
   * Per-frame update while active. Called BEFORE the flight controller and the camera rig, with the camera
   * and snapshot of the frame currently on screen (what the player is pointing at), so hit-testing matches
   * what was drawn. The result tells the rest of the frame whether the pointer is taken and whether the
   * player asked to focus something (double click on a body or vessel).
   *
   * `displaySize` is the size of the canvas in CSS pixels: the space of `PointerState` and of
   * `MapElementInfo`. (`FrameContext.displaySize` is in device pixels; the map derives the ratio from the
   * next `drawOverlay` frame.)
   */
  update(snapshot: SimSnapshot, camera: CameraState, commands: PlayerCommands, pointer: MapPointer, displaySize: [number, number]): MapUpdateResult;
  /** For tests and the pilot HUD: screen positions (CSS px) of interactive elements. */
  describe(): MapElementInfo[];
}

/** The map view consumes the input system's pointer state unchanged. */
export type MapPointer = PointerState;

export interface MapUpdateResult {
  /**
   * True while the map owns the pointer: hover over a DRAGGABLE element (a maneuver node, a gizmo handle),
   * a handle or node drag in progress (until release), the pointer over the map's DOM panel, or focus in
   * one of its fields. The camera rig then ignores pointer input and the flight controller ignores the
   * throttle axis (ControlContext.pointerCaptured).
   *
   * Click-only elements (trajectories, bodies, markers) do NOT consume on hover, although a click on them
   * does something (add a node, set the target, double-click to focus): orbit lines and planet discs cover
   * most of the map, and consuming there would stop the camera from rotating and zooming over them. Their
   * actions fire on a press and release with less than a few pixels of movement; a press that moves
   * further belongs to the camera.
   */
  consumed: boolean;
  /** Set on the frame the player double-clicks a body or vessel: the app passes it to the map camera rig. */
  focus?: { bodyId?: string; vesselId?: string };
}

/** Handle the app shell uses to forward `mfdCycle:*` button actions to the cockpit feature. */
export interface CockpitControls {
  readonly displayCount: number;
  page(display: number): MfdPage;
  setPage(display: number, page: MfdPage): void;
  cyclePage(display: number): void;
}

export interface MapElementInfo {
  kind: 'marker' | 'nodeHandle' | 'node' | 'body' | 'vessel' | 'surfaceTarget';
  id: string;
  x: number;
  y: number;
  visible: boolean;
}
