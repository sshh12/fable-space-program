/**
 * Player-facing interface contracts: HUD, navball, cockpit displays and the map view.
 */
import type { AudioBusName, AudioBusNameV2 } from './audio';
import type { PlayerCommands, PointerState } from './controls';
import type { DefLibrary } from './defs';
import type { CensusEntry, CensusKind } from './net';
import type { CameraState, QualityLevelName, QualityProfile } from './render';
import type { ClientStores } from './session';
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

/**
 * v2 pages: the target card and the docking instrument (`Readouts.target`, `Readouts.docking`), painted by
 * the same Canvas-2D painter as the HUD panels.
 *
 * Not yet members of `MfdPage`: the painter keeps tables with one entry per page (src/ui/mfd/mfdPainter.ts),
 * so the lead joins this type to `MfdPage` at the start of sub-wave 3.2, when their owner adds the entries.
 */
export type MfdPageV2 = 'target' | 'docking';

/** Draws a cockpit multi-function display page with Canvas 2D. Shares formatters with the HUD. */
export interface MfdPainter {
  readonly pages: readonly MfdPage[];
  paint(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, page: MfdPage, snapshot: SimSnapshot, defs: DefLibrary): void;
}

/** The DOM HUD layered over the canvas (flight views) and its hooks for the app shell. */
export interface Hud {
  /** Mount into the given container element (positioned over the canvas). */
  mount(container: HTMLElement): void;
  /**
   * `camera` tells the HUD which view is shown; branch on camera.kind (unknown modes behave as their kind).
   * v2: `stores` are the client stores the DOM panels read (assembly, roster, prompts, feed, link state);
   * absent = a session without them (no such panels are shown).
   */
  update(snapshot: SimSnapshot, camera: CameraState, realDt: number, stores?: ClientStores): void;
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
   *
   * v2: `census` is the census layer for this frame (every object of the subscribed spheres of influence,
   * with the filter state and the preview time); absent = no census layer (a session without a directory).
   */
  update(snapshot: SimSnapshot, camera: CameraState, commands: PlayerCommands, pointer: MapPointer, displaySize: [number, number], census?: MapCensus): MapUpdateResult;
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
  /**
   * Set on the frame the player double-clicks something: the app passes it to the map camera rig. v2: a
   * launch site (`siteId`) or a player (`accountId`: their craft) can be focused too.
   */
  focus?: { bodyId?: string; vesselId?: string; siteId?: string; accountId?: string };
  /** v2: set on the frame the player changed the census filter or the preview time in the map's panel; the app stores it and passes it back in `MapCensus`. */
  filter?: MapFilter;
  previewTick?: number | null;
}

/** Which census objects the map draws (v2). */
export interface MapFilter {
  /** Kinds shown. */
  kinds: Record<CensusKind, boolean>;
  /** Only the pilot's own ships, target, party and docked partners. */
  relevantOnly: boolean;
  /** Draw echoes (objects that are not solid for the viewer). */
  echoes: boolean;
}

/** The census layer of one frame (v2; ARCHITECTURE 21). */
export interface MapCensus {
  /** Objects by vessel id (`ClientStores.census`). */
  entries: ReadonlyMap<string, CensusEntry>;
  filter: MapFilter;
  /** The read-only "view at this time" control: the tick the map shows the census at; null = the viewer's clock. */
  previewTick: number | null;
}

/** Handle the app shell uses to forward `mfdCycle:*` button actions to the cockpit feature. */
export interface CockpitControls {
  readonly displayCount: number;
  page(display: number): MfdPage;
  setPage(display: number, page: MfdPage): void;
  cyclePage(display: number): void;
}

/**
 * The settings screen's model (v2; ARCHITECTURE 23, 24): what the shell stores per adapter fingerprint and
 * hands to the renderer, the audio engine and the input layer. Any manual change of a graphics level makes
 * the preset 'custom' and keeps the predicted cost on screen.
 */
export interface SettingsModel {
  graphics: {
    preset: QualityLevelName | 'custom';
    profile: QualityProfile;
    /** GPU frame time the calibration predicts for `profile`, ms; null before a calibration. */
    predictedGpuMs: number | null;
    /** Wall time of the calibration the profile came from, ms since the Unix epoch; null = the adapter-class preset. */
    calibratedWallMs: number | null;
  };
  audio: {
    master: number;
    /** Volume per bus, 0..1 (a bus that is not listed is at 1): the buses of today and the v2 buses (music, comms). */
    buses: Partial<Record<AudioBusName | AudioBusNameV2, number>>;
  };
  controls: {
    /**
     * Fullscreen and keyboard lock are OPT-IN: the game starts windowed and uncaptured, the bindings work
     * without the lock, and these two say what the player chose on the explicit control.
     */
    fullscreen: boolean;
    keyboardLock: boolean;
    /** Mouse look sensitivity multiplier, and inverted vertical look. */
    lookSensitivity: number;
    invertLook: boolean;
  };
  interface: {
    /** HUD scale multiplier. */
    hudScale: number;
    nameplates: boolean;
    feed: boolean;
    /** Labels that are hidden for footage ("TEST PILOT", the capture hint). */
    footageMode: boolean;
  };
}

export interface MapElementInfo {
  /** v2 adds 'census' (an object of the census layer; `id` is its vessel id) and 'site'. */
  kind: 'marker' | 'nodeHandle' | 'node' | 'body' | 'vessel' | 'surfaceTarget' | 'census' | 'site';
  id: string;
  x: number;
  y: number;
  visible: boolean;
}
