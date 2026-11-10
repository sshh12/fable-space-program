/**
 * The one and only way to influence the simulation: continuous ControlInputs plus discrete PlayerCommands.
 * The keyboard/mouse layer, the on-screen UI, the scripted test pilot and Playwright tests all go through
 * this API. Nothing here can set vehicle state directly.
 */
import type { Vec3 } from '../math/vec3';
import type { ViewKind } from './render';
import type { ManeuverNode, SimSnapshot } from './sim';

/** Continuous inputs, latched by the sim until replaced. Sign conventions are in the vessel frame. */
export interface ControlInputs {
  /** -1..1, +1 = pitch up (nose toward the vessel's +Z / dorsal side). */
  pitch: number;
  /** -1..1, +1 = yaw right (nose toward +X / starboard). */
  yaw: number;
  /** -1..1, +1 = roll right (clockwise seen from behind, rotation about +Y). */
  roll: number;
  /** -1..1 per axis RCS translation in the vessel frame (+X starboard, +Y forward, +Z dorsal). */
  translate: Vec3;
  /** 0..1 throttle lever position. */
  throttle: number;
}

export const NEUTRAL_CONTROLS: Readonly<ControlInputs> = Object.freeze({
  pitch: 0,
  yaw: 0,
  roll: 0,
  translate: Object.freeze({ x: 0, y: 0, z: 0 }),
  throttle: 0,
});

/**
 * SAS hold modes. 'maneuver' holds the remaining-delta-v direction of the next maneuver node; like every
 * other mode it only steers attitude: SAS never touches throttle, staging or planning.
 */
export type SasMode =
  | 'stability'
  | 'prograde'
  | 'retrograde'
  | 'normal'
  | 'antinormal'
  | 'radialOut'
  | 'radialIn'
  | 'maneuver';

export const SAS_MODES: readonly SasMode[] = [
  'stability',
  'prograde',
  'retrograde',
  'normal',
  'antinormal',
  'radialOut',
  'radialIn',
  'maneuver',
];

export type NavballMode = 'surface' | 'orbit';

export interface CommandResult {
  ok: boolean;
  /** Human-readable reason when refused (shown in the HUD), e.g. "Cannot warp while under acceleration". */
  reason?: string;
}

export interface NodeEdit {
  ut?: number;
  dv?: Partial<ManeuverNode['dv']>;
}

/** Discrete player actions. Every one is reachable from a key or an on-screen control. */
export interface PlayerCommands {
  /** Fire the next entry of the stage stack (Space). */
  stage(): CommandResult;
  /** Launch-escape / abort sequence (Backspace). */
  abort(): CommandResult;
  setSasEnabled(on: boolean): CommandResult;
  setSasMode(mode: SasMode): CommandResult;
  setRcsEnabled(on: boolean): CommandResult;
  /** Toggle landing legs (G). */
  toggleLegs(): CommandResult;
  toggleLights(): CommandResult;
  setFineControl(on: boolean): CommandResult;
  setNavballMode(mode: NavballMode): CommandResult;
  /** Request an index into WARP_LEVELS; the sim may clamp it (result.reason says why). */
  setWarpLevel(index: number): CommandResult;
  /** Create a maneuver node on the current trajectory at `ut`; returns its id. */
  addNode(ut: number): string;
  setNode(id: string, edit: NodeEdit): CommandResult;
  removeNode(id: string): CommandResult;
  setTarget(bodyId: string | null): CommandResult;
  /** Cycle the active vessel among controllable vessels in the physics bubble ([ and ]). */
  cycleActiveVessel(direction: 1 | -1): CommandResult;
}

// ------------------------------------------------------------------------------------------ input layer

/** Continuous actions produced by the binding table from held keys / axes. */
export type AxisAction =
  | 'pitch'
  | 'yaw'
  | 'roll'
  | 'translateX'
  | 'translateY'
  | 'translateZ'
  | 'throttleRate'
  | 'cameraYaw'
  | 'cameraPitch'
  | 'cameraZoom';

/** Discrete actions produced on key press. */
export type ButtonAction =
  | 'stage'
  | 'abort'
  | 'throttleFull'
  | 'throttleCut'
  | 'toggleSas'
  | 'toggleRcs'
  | 'toggleLegs'
  | 'toggleLights'
  | 'toggleFineControl'
  | 'toggleNavballMode'
  | 'warpUp'
  | 'warpDown'
  | 'warpStop'
  | 'toggleMap'
  | 'cycleCamera'
  | 'nextVessel'
  | 'prevVessel'
  | 'toggleHud'
  | 'pause'
  /** Cycle the page of cockpit multi-function display 0 (left), 1 (centre) or 2 (right). */
  | `mfdCycle:${0 | 1 | 2}`
  | `sas:${SasMode}`;

/** Pointer state for one frame, in CSS pixels relative to the canvas. Shared by camera rigs and the map view. */
export interface PointerState {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Bit mask of held buttons (1 = primary, 2 = secondary, 4 = middle). */
  buttons: number;
  /** Edges since the previous frame for the primary button, and a completed double click. */
  pressed: boolean;
  released: boolean;
  doubleClick: boolean;
  /** Wheel steps since the previous frame, normalised to sign (+1 = away from the user). */
  wheel: number;
  /** Modifier keys held (pointer gestures only; they are never bound to browser-reserved chords). */
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** True while the pointer is over an interactive HUD element (the scene must ignore it). */
  overUi: boolean;
}

/** One frame of device-independent input, produced by src/input from DOM events. */
export interface InputFrame {
  axes: Readonly<Record<AxisAction, number>>;
  /** Actions whose key went down since the previous frame. */
  pressed: ReadonlySet<ButtonAction>;
  pointer: PointerState;
  /** True while fullscreen keyboard lock is active (browser shortcuts such as Ctrl+W reach the page). */
  keyboardLocked: boolean;
}

/** What the controller needs to know about the rest of the frame. */
export interface ControlContext {
  /** Kind of the active view. */
  view: ViewKind;
  /**
   * True while the map view owns the pointer (hovering a handle, dragging, typing in the node panel).
   * While set, the controller ignores the throttleRate axis: the Shift/Ctrl drag modifiers of the node
   * editor must never move the throttle.
   */
  pointerCaptured: boolean;
}

/**
 * Maps InputFrames to ControlInputs/PlayerCommands for whatever the player currently controls.
 * `FlightController` is the only implementation today; an `EvaController` (jetpack / surface walking)
 * plugs in here later without touching the sim, the input bindings or the views.
 */
export interface ActiveController {
  readonly kind: string;
  /** Called once per rendered frame before the sim advances (after the map view has seen the pointer). */
  update(input: InputFrame, snapshot: SimSnapshot, commands: PlayerCommands, realDt: number, ctx: ControlContext): ControlInputs;
}

/**
 * A scripted pilot. It may read anything in the snapshot (what the HUD and map show) and may act only
 * through ControlInputs and PlayerCommands. Called at 30 Hz of simulation time.
 */
export interface Pilot {
  update(snapshot: SimSnapshot, commands: PlayerCommands, dt: number): ControlInputs;
  /** Current phase name, for logs and the HUD debug line. */
  readonly phase: string;
  readonly done: boolean;
  /** Non-null when the pilot has given up (with the reason). */
  readonly failure: string | null;
}
