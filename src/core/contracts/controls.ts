/**
 * The one and only way to influence the simulation: continuous ControlInputs plus discrete PlayerCommands.
 * The keyboard/mouse layer, the on-screen UI, the scripted test pilot and Playwright tests all go through
 * this API. Nothing here can set vehicle state directly.
 */
import type { Vec3 } from '../math/vec3';
import type { BodyId, ResourceId } from './defs';
import type { LendPolicy } from './net';
import type { ViewKind } from './render';
import type { ManeuverNode, SimSnapshot } from './sim';

/**
 * Continuous inputs, latched by the session until replaced. Sign conventions are in the vessel frame; in an
 * assembly they apply in the CTL frame of the helm's control part (ARCHITECTURE section 3).
 */
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

/**
 * v2 SAS hold modes that need a vessel or port target: hold the direction to the target, away from it, or
 * the own control port's axis anti-parallel to the targeted port's. All are attitude holds.
 *
 * Not yet members of `SasMode`: the input layer and the HUD keep tables with one entry per mode
 * (src/input/bindings.ts, src/ui/hud/hud.ts), so the lead joins this type to `SasMode` at the start of
 * sub-wave 3.2, when their owner adds the entries.
 */
export type SasTargetMode = 'target' | 'antiTarget' | 'portAlign';

/** The eight modes that exist without a vessel or port target, in HUD order. */
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

/** The SAS modes that need a vessel or port target (v2), in HUD order after SAS_MODES. */
export const SAS_TARGET_MODES: readonly SasTargetMode[] = ['target', 'antiTarget', 'portAlign'];

export type NavballMode = 'surface' | 'orbit';

/**
 * v2 navball mode 'target': prograde and retrograde show the velocity relative to the target.
 *
 * Not yet a member of `NavballMode`: the chase rig maps every navball mode to a reference frame
 * (src/camera/chaseRig.ts), so the lead joins this type to `NavballMode` at the start of sub-wave 3.2, when
 * its owner adds the case.
 */
export type NavballModeV2 = 'target';

export interface CommandResult {
  ok: boolean;
  /**
   * Human-readable reason when refused (shown in the HUD), e.g. "Cannot warp while under acceleration". A
   * refused time request names the players that cause it.
   */
  reason?: string;
  /**
   * v2: true when the command was sent and its outcome is not known yet (a network session). The outcome
   * arrives as a `commandResult` event with the same `cmdId`; until then the HUD shows a pending state.
   * Absent = the result is final. Planning commands (addNode, setNode, removeNode, setNavballMode, setTarget)
   * are local and never pending.
   */
  pending?: boolean;
  /** v2: id of a pending command, unique within the session. */
  cmdId?: number;
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
  /**
   * Request an index into WARP_LEVELS; the session may clamp it (result.reason says why). v2: this is a TIME
   * REQUEST for the pilot's clock (ARCHITECTURE U6, U7): on a private clock it takes effect at the stamped
   * tick, on a shared clock a level above 1x is a proposal to the bound members, and a refusal names the
   * reason and the players that cause it.
   */
  setWarpLevel(index: number): CommandResult;
  /** Create a maneuver node on the current trajectory at `ut`; returns its id. */
  addNode(ut: number): string;
  setNode(id: string, edit: NodeEdit): CommandResult;
  removeNode(id: string): CommandResult;
  /**
   * Select the target body, or null for none.
   *
   * v2: the parameter becomes `ref: TargetRef | null` (a body, a vessel or a docking port; a body id `b`
   * is then `{ kind: 'body', id: b }`). The lead changes this signature at the start of sub-wave 3.2,
   * together with the call sites and the implementations; it cannot be widened earlier because
   * implementations forward the argument as a body id. Until then vessel and port targets do not exist.
   */
  setTarget(bodyId: BodyId | null): CommandResult;
  /**
   * Take a seat in another craft the pilot may control in the pilot's island ([ and ]). (v1: cycle the
   * active vessel among controllable vessels in the physics bubble.)
   */
  cycleActiveVessel(direction: 1 | -1): CommandResult;

  // ---- v2 commands (ARCHITECTURE 5.3, 7.5, 13.3). OPTIONAL until the session switch (MIGRATION_V2 step
  // 4.3): v1's World implements none of them; a LocalSession over src/universe and every NetSession
  // implement all. The contract tighten after step 4.3 makes them required. Until then call them as
  // `commands.jump?.(...)` and treat an absent command as unavailable. Ticks are universe ticks
  // (TICKS_PER_SECOND); port and part arguments are part keys `craftId/instanceId`.

  /** Time request: run the pilot's clock at the highest permitted rate and stop at `tick` (U6). */
  warpTo?(tick: number): CommandResult;
  /** Jump a quiescent vessel to a later tick or onto another clock (U8). A refusal carries the reason; the alternative arrives as a `TimeOffer`. */
  jump?(to: { tick: number } | { clockId: string }): CommandResult;
  /** Hold (rate 0: the pilot stays seated while the vessel is passive) or leave hold (seated by U8b). */
  hold?(on: boolean): CommandResult;
  /** Form or leave a party with another pilot (a shared clock at any distance). */
  link?(accountId: string): CommandResult;
  unlink?(accountId: string): CommandResult;
  /** Accept a named pilot's warp proposals automatically; null clears it. */
  follow?(accountId: string | null): CommandResult;
  /** Propose to meet another pilot at a tick not earlier than both heads (U8). */
  meet?(accountId: string, atTick: number): CommandResult;
  /** Answer an open proposal on the pilot's clock (a warp proposal, an advance request, a meeting). */
  replyProposal?(proposalId: string, accept: boolean): CommandResult;
  /** Ask the group that holds `vesselId`, or is behind with it, to advance to the pilot's tick (U9). */
  askAdvance?(vesselId: string): CommandResult;
  /** Arm or disarm one of the pilot's own docking ports; persists offline. */
  armPort?(portId: string, armed: boolean): CommandResult;
  /** Release a docked port: the owner of either port may (craft sovereignty, ARCHITECTURE 7.5). */
  undock?(portId: string): CommandResult;
  /** "Control from here": make one of the pilot's own parts (a command part or a docking port) the CTL frame; null = the craft's command part. */
  setControlPoint?(partKey: string | null): CommandResult;
  /** Ask for the helm of the assembly; granted at once when vacant and the policy admits the pilot, else on acceptance or the timeout. */
  requestHelm?(): CommandResult;
  /** Hand the helm to a pilot aboard (answering a request or unasked). */
  grantHelm?(accountId: string): CommandResult;
  /** Leave the helm vacant. */
  releaseHelm?(): CommandResult;
  /** Change what the helm may use of one of the pilot's own craft; absent keys keep their value. */
  setLendPolicy?(craftId: string, policy: Partial<LendPolicy>): CommandResult;
  /** How far ahead of the live clock a visitor may take one of the pilot's craft, in seconds (U2), up to the rules' cap. */
  setAdvanceLimit?(craftId: string, seconds: number): CommandResult;
  /**
   * Pump a resource between two flow groups joined by docked ports that carry it: `from` and `to` are part
   * keys of tanks, `rate` kg/s (0 stops the transfer between that pair). Pumping out of another owner's
   * tank needs their `lendPropellant`.
   */
  transfer?(from: string, to: string, resource: ResourceId, rate: number): CommandResult;
  /** Open or close cross-feed across one of the pilot's own docked ports (it flows only when both owners opened it). */
  setCrossfeed?(portId: string, on: boolean): CommandResult;
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
  /** @deprecated Becomes 'flightMenu' (ButtonActionV2): nothing pauses in a shared universe. Still bound; removed at the tighten step after sub-wave 3.2. */
  | 'pause'
  /** Cycle the page of cockpit multi-function display 0 (left), 1 (centre) or 2 (right). */
  | `mfdCycle:${0 | 1 | 2}`
  | `sas:${SasMode}`;

/**
 * v2 button actions (ARCHITECTURE 19): 'flightMenu' opens or closes the flight menu over the live flight
 * (Esc, P; it replaces 'pause'); 'cycleTarget' selects the next target of the relevant set (B);
 * 'toggleRoster' shows or hides the roster (O); 'dockingView' is the view at the control port (V);
 * 'openQuickComms' opens the quick-comms wheel (Enter); 'acceptPrompt' accepts the oldest open prompt (Y).
 *
 * Not yet members of `ButtonAction`: the binding table and its reference card list every action
 * (src/input/bindings.ts), so the lead joins this type to `ButtonAction` at the start of sub-wave 3.2, when
 * their owner adds the entries.
 */
export type ButtonActionV2 = 'flightMenu' | 'cycleTarget' | 'toggleRoster' | 'dockingView' | 'openQuickComms' | 'acceptPrompt';

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
  /**
   * v2: the input context whose binding table produced this frame (ARCHITECTURE 19). Only 'flight' reaches
   * the flight controller; switching context releases all held keys. Absent = 'flight'.
   */
  context?: InputContext;
}

/** Input contexts with their own binding tables (v2). */
export type InputContext = 'menu' | 'transit' | 'flight';

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
