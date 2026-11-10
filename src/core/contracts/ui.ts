/**
 * Player-facing interface contracts: HUD, navball, cockpit displays and the map view.
 */
import type { PlayerCommands } from './controls';
import type { DefLibrary } from './defs';
import type { CameraState, ViewMode } from './render';
import type { SimSnapshot } from './sim';

/**
 * The navball is a real 3-D sphere rendered with WebGPU into a texture (published as 'ui.navball') that
 * both the HUD and the cockpit instrument display.
 */
export interface NavballRenderer {
  /** 512 x 512 rgba8unorm texture view; alpha = coverage of the ball. */
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
  update(snapshot: SimSnapshot, view: ViewMode, realDt: number): void;
  setVisible(visible: boolean): void;
  /** Transient message line (warp refusals, staging lockout...). */
  notify(message: string): void;
  dispose(): void;
}

/** Map view controller: owns orbit lines, markers and maneuver-node editing (via PlayerCommands only). */
export interface MapView {
  setActive(active: boolean): void;
  /**
   * Per-frame update while active: hit-testing and dragging use the same camera the frame is rendered with.
   * Returns true when the pointer interaction was consumed (so the camera rig ignores it).
   */
  update(snapshot: SimSnapshot, camera: CameraState, commands: PlayerCommands, pointer: MapPointer, displaySize: [number, number]): boolean;
  /** For tests and the pilot HUD: screen positions (CSS px) of interactive elements. */
  describe(): MapElementInfo[];
}

export interface MapPointer {
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: number;
  pressed: boolean;
  released: boolean;
  wheel: number;
  shift: boolean;
  ctrl: boolean;
}

export interface MapElementInfo {
  kind: 'marker' | 'nodeHandle' | 'node' | 'body' | 'vessel';
  id: string;
  x: number;
  y: number;
  visible: boolean;
}
