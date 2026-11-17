/**
 * The data-driven key binding table (docs/ARCHITECTURE.md section 11).
 *
 * Keys are identified by `KeyboardEvent.code` (the physical key: `KeyW`, `ShiftLeft`, `Digit1`), never by
 * `key` or `keyCode`, so the table works on every keyboard layout and with Shift held.
 *
 * Browser safety: Chrome and Edge do not let a page cancel Ctrl+W / Ctrl+T / Ctrl+N (close tab, new tab, new
 * window) outside keyboard-locked fullscreen, and Alt chords reach the browser menu. Therefore no default
 * binding uses Control, Alt or Meta as a key or as a modifier. A binding may be flagged
 * `requiresKeyboardLock`; it is active only while `InputFrame.keyboardLocked` is true. The only such default
 * is ControlLeft as an alternate throttle-down (a lunar landing holds throttle-down and pitch together).
 *
 * Matching rule: a binding without modifiers matches its code with Shift or Alt held or not (Shift is itself
 * the throttle-up key, so Shift+W must still pitch). A binding with modifiers matches only while all of them
 * are held, and the most specific matching binding of a code wins. A key pressed with Control or Meta is a
 * chord of the browser (reload, find, zoom, a new tab) unless a binding of its code names that modifier: the
 * input core then leaves it alone, no action and no preventDefault (inputCore.ts; Control held as the game's
 * own key under keyboard lock is not such a chord).
 *
 * Served actions: the v2 actions are bound here from the first day, so that no key moves when their
 * consumers arrive, but a key that nothing answers is not on the reference card (`ServedActions`,
 * `keyHelpEntries`), and Esc is the game's key only on a page that has a flight menu to open with it.
 */
import { SAS_MODES, SAS_TARGET_MODES, type AxisAction, type ButtonAction, type ButtonActionV2, type SasMode, type SasTargetMode } from '@/core/contracts/controls';

export type ModifierKey = 'Shift' | 'Control' | 'Alt' | 'Meta';

/** Presentation-only actions that have no simulation meaning (handled by the HUD). */
/**
 * Presentation actions (no vessel control: not in the ButtonAction contract), read from `FlightInputFrame.ui`:
 * the key help, the chase camera back to its default framing (`ChaseRig.resetView()`), and the cockpit eye to the
 * next couch (`CockpitRig.cycleSeat()`).
 */
export type UiAction = 'ui:keyHelp' | 'ui:resetCamera' | 'ui:nextSeat';

interface BindingBase {
  /** KeyboardEvent.code of the key. */
  code: string;
  /** Modifiers that must be held (default none). */
  modifiers?: readonly ModifierKey[];
  /** Active only while fullscreen keyboard lock is held (InputFrame.keyboardLocked). */
  requiresKeyboardLock?: boolean;
  /**
   * In the table of an input core only when the page serves the binding's action (`isServed`); on any other
   * page the key is not the game's (no action, no preventDefault) and is off the reference card. The one
   * default is Esc for the flight menu.
   */
  requiresServed?: boolean;
}

/** Held key contributing `value` (-1..1) to a continuous axis while down. */
export interface AxisBinding extends BindingBase {
  kind: 'axis';
  action: AxisAction;
  value: number;
}

/** Key press producing a discrete action once per press (key repeat is suppressed). */
export interface ButtonBinding extends BindingBase {
  kind: 'button';
  action: ButtonAction | UiAction;
}

export type Binding = AxisBinding | ButtonBinding;

/** Every AxisAction of src/core/contracts/controls.ts (compile-time checked below). */
export const ALL_AXIS_ACTIONS = [
  'pitch',
  'yaw',
  'roll',
  'translateX',
  'translateY',
  'translateZ',
  'throttleRate',
  'cameraYaw',
  'cameraPitch',
  'cameraZoom',
] as const satisfies readonly AxisAction[];

/**
 * The member of the contract's ButtonAction that no table lists any more: the flight menu took its key
 * (nothing pauses in a shared universe; MIGRATION_V2 section 4). It stays in the union until the tighten step
 * after sub-wave 3.2, which removes it from the contract and this type with it.
 */
type RetiredButtonAction = Extract<ButtonAction, 'pause'>;

/** Every ButtonAction of src/core/contracts/controls.ts that a table may bind (compile-time checked below). */
export const ALL_BUTTON_ACTIONS = [
  'stage',
  'abort',
  'throttleFull',
  'throttleCut',
  'toggleSas',
  'toggleRcs',
  'toggleLegs',
  'toggleLights',
  'toggleFineControl',
  'toggleNavballMode',
  'warpUp',
  'warpDown',
  'warpStop',
  'toggleMap',
  'cycleCamera',
  'nextVessel',
  'prevVessel',
  'toggleHud',
  'flightMenu',
  'cycleTarget',
  'toggleRoster',
  'dockingView',
  'openQuickComms',
  'acceptPrompt',
  'mfdCycle:0',
  'mfdCycle:1',
  'mfdCycle:2',
  'sas:stability',
  'sas:prograde',
  'sas:retrograde',
  'sas:normal',
  'sas:antinormal',
  'sas:radialOut',
  'sas:radialIn',
  'sas:maneuver',
  'sas:target',
  'sas:antiTarget',
  'sas:portAlign',
] as const satisfies readonly ButtonAction[];

// Exhaustiveness: a member added to the contract unions without being listed above fails to compile here.
type MissingAxis = Exclude<AxisAction, (typeof ALL_AXIS_ACTIONS)[number]>;
type MissingButton = Exclude<ButtonAction, (typeof ALL_BUTTON_ACTIONS)[number] | RetiredButtonAction>;
const axisListIsComplete: MissingAxis extends never ? true : MissingAxis = true;
const buttonListIsComplete: MissingButton extends never ? true : MissingButton = true;
void axisListIsComplete;
void buttonListIsComplete;

/**
 * The v2 actions whose consumers arrive with the shared universe (ARCHITECTURE 19, additions for v2: the
 * target set, the roster, the docking view, quick comms, the prompt cards). No session and no page answers
 * them before wave 4. Their keys are bound all the same; their lines join the reference card when the page
 * says that it serves them.
 */
export const DEFERRED_ACTIONS = ['cycleTarget', 'toggleRoster', 'dockingView', 'openQuickComms', 'acceptPrompt'] as const satisfies readonly ButtonActionV2[];
export type DeferredAction = (typeof DEFERRED_ACTIONS)[number];

/**
 * What a page serves of the actions that not every page serves; the caller of `createInputSystem` /
 * `createInputCore` and of `keyHelpEntries` states it, and states nothing while it serves none of them.
 *
 * The three SAS holds against a target are not here: whether they are served is the session's to say, in
 * `Readouts.sasModesAvailable`, frame by frame (`KeyHelpEntry.sasMode`).
 */
export interface ServedActions {
  /**
   * The page has the shell's flight menu over the live flight, and opens it on `flightMenu`. Without it
   * (the default) the offline game answers `flightMenu` with its local pause, as it answered the retired
   * action before v2: P pauses and its line on the card says so, and Esc is not bound at all (it is the
   * browser's key, which leaves fullscreen and with it the keyboard capture), as before the action existed.
   */
  flightMenu?: boolean;
  /** The deferred actions the page answers (default: none). */
  actions?: readonly DeferredAction[];
}

const isDeferred = (action: string): action is DeferredAction => (DEFERRED_ACTIONS as readonly string[]).includes(action);

/** True when the page serves an action as v2 defines it; every action that is not named in `ServedActions` is served. */
export function isServed(action: AxisAction | ButtonAction | UiAction, served: ServedActions = {}): boolean {
  if (action === 'flightMenu') return served.flightMenu === true;
  if (isDeferred(action)) return served.actions?.includes(action) === true;
  return true;
}

const axis = (code: string, action: AxisAction, value: number, extra: Partial<AxisBinding> = {}): AxisBinding => ({ kind: 'axis', code, action, value, ...extra });
const button = (code: string, action: ButtonAction | UiAction, extra: Partial<ButtonBinding> = {}): ButtonBinding => ({ kind: 'button', code, action, ...extra });

const SAS_KEYS: readonly SasMode[] = SAS_MODES;

/**
 * Keys of the three SAS modes that hold against a vessel or port target. The digit row is full (1-8 are the
 * modes without a target, 9 0 - the cockpit displays), so they take the three keys right of L, in HUD order.
 */
const SAS_TARGET_KEYS: Readonly<Record<SasTargetMode, string>> = { target: 'Semicolon', antiTarget: 'Quote', portAlign: 'Backslash' };

/** Default bindings (ARCHITECTURE section 11 supersedes sim-design section 20). */
export const DEFAULT_BINDINGS: readonly Binding[] = Object.freeze([
  // Attitude (VES signs: pitch + = nose up, yaw + = nose right, roll + = clockwise seen from behind).
  axis('KeyW', 'pitch', -1),
  axis('KeyS', 'pitch', +1),
  axis('KeyA', 'yaw', -1),
  axis('KeyD', 'yaw', +1),
  axis('KeyQ', 'roll', -1),
  axis('KeyE', 'roll', +1),
  // RCS translation (VES: +X starboard, +Y forward, +Z dorsal).
  axis('KeyI', 'translateY', +1),
  axis('KeyK', 'translateY', -1),
  axis('KeyJ', 'translateX', -1),
  axis('KeyL', 'translateX', +1),
  axis('KeyH', 'translateZ', +1),
  axis('KeyN', 'translateZ', -1),
  // Throttle lever rate (the controller integrates it at 0.5 per second).
  axis('ShiftLeft', 'throttleRate', +1),
  axis('ShiftRight', 'throttleRate', +1),
  axis('KeyF', 'throttleRate', -1),
  axis('ControlLeft', 'throttleRate', -1, { requiresKeyboardLock: true }),
  // Camera orbit / look and zoom (the mouse drives the same CameraInput).
  axis('ArrowLeft', 'cameraYaw', -1),
  axis('ArrowRight', 'cameraYaw', +1),
  axis('ArrowUp', 'cameraPitch', +1),
  axis('ArrowDown', 'cameraPitch', -1),
  axis('PageUp', 'cameraZoom', -1),
  axis('PageDown', 'cameraZoom', +1),
  axis('NumpadAdd', 'cameraZoom', -1),
  axis('NumpadSubtract', 'cameraZoom', +1),
  // Staging and throttle presets.
  button('Space', 'stage'),
  button('Backspace', 'abort'),
  button('KeyZ', 'throttleFull'),
  button('KeyX', 'throttleCut'),
  // Systems.
  button('KeyT', 'toggleSas'),
  button('KeyR', 'toggleRcs'),
  button('KeyG', 'toggleLegs'),
  button('KeyU', 'toggleLights'),
  button('CapsLock', 'toggleFineControl'),
  ...SAS_KEYS.map((mode, i) => button(`Digit${i + 1}`, `sas:${mode}`)),
  ...SAS_TARGET_MODES.map((mode) => button(SAS_TARGET_KEYS[mode], `sas:${mode}`)),
  // Navigation, time and views.
  button('Tab', 'toggleNavballMode'),
  button('Period', 'warpUp'),
  button('Comma', 'warpDown'),
  button('Slash', 'warpStop'),
  button('KeyM', 'toggleMap'),
  button('KeyC', 'cycleCamera'),
  button('BracketRight', 'nextVessel'),
  button('BracketLeft', 'prevVessel'),
  button('F2', 'toggleHud'),
  // The flight menu over the live flight (ARCHITECTURE 19: Esc and P; P stays so that an Esc the browser took
  // to leave fullscreen can never trap the player). Esc waits for the menu (`ServedActions.flightMenu`): until
  // a page has one, P is the offline game's pause, as before v2, and Esc is the browser's alone.
  button('Escape', 'flightMenu', { requiresServed: true }),
  button('KeyP', 'flightMenu'),
  // Targets, the roster, prompts and quick comms (ARCHITECTURE 19).
  button('KeyB', 'cycleTarget'),
  button('KeyO', 'toggleRoster'),
  button('KeyY', 'acceptPrompt'),
  button('Enter', 'openQuickComms'),
  // The view at the control port. ARCHITECTURE 19 proposed V, which the next couch of the cabin has taken since
  // (request core-6, 'ui:nextSeat'), and every letter is bound: it sits right of the three display keys.
  button('Equal', 'dockingView'),
  // Cockpit multi-function displays (left, centre, right).
  button('Digit9', 'mfdCycle:0'),
  button('Digit0', 'mfdCycle:1'),
  button('Minus', 'mfdCycle:2'),
  // Presentation.
  button('Backquote', 'ui:keyHelp'),
  button('Home', 'ui:resetCamera'),
  button('KeyV', 'ui:nextSeat'),
]);

/** Codes that are browser-reserved as keys or modifiers (never bound unless `requiresKeyboardLock`). */
export const BROWSER_RESERVED_CODES: readonly string[] = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
export const BROWSER_RESERVED_MODIFIERS: readonly ModifierKey[] = ['Control', 'Alt', 'Meta'];

/** Canonical chord string of a binding (code + sorted modifiers), used to detect conflicts. */
export function chordOf(b: Pick<Binding, 'code' | 'modifiers'>): string {
  const mods = [...(b.modifiers ?? [])].sort();
  return mods.length > 0 ? `${mods.join('+')}+${b.code}` : b.code;
}

/** Identity of the action a binding produces (axis bindings are distinguished by direction). */
export function actionIdOf(b: Binding): string {
  return b.kind === 'axis' ? `${b.action}${b.value >= 0 ? '+' : '-'}` : b.action;
}

/**
 * Structural problems of a binding table: browser-reserved keys/modifiers without `requiresKeyboardLock`,
 * chords bound to two different actions, out-of-range axis values, bad codes. Empty when the table is valid.
 */
export function validateBindings(table: readonly Binding[]): string[] {
  const problems: string[] = [];
  const byChord = new Map<string, string>();
  for (const b of table) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(b.code)) problems.push(`"${b.code}" is not a KeyboardEvent.code`);
    if (!b.requiresKeyboardLock) {
      if (BROWSER_RESERVED_CODES.includes(b.code)) problems.push(`${b.code} (${actionIdOf(b)}) is browser-reserved and must be flagged requiresKeyboardLock`);
      for (const m of b.modifiers ?? []) {
        if (BROWSER_RESERVED_MODIFIERS.includes(m)) problems.push(`${chordOf(b)} (${actionIdOf(b)}) uses the browser-reserved modifier ${m}`);
      }
    }
    if (b.kind === 'axis' && !(Math.abs(b.value) > 0 && Math.abs(b.value) <= 1)) problems.push(`${b.code}: axis value ${b.value} outside (0, 1]`);
    const chord = chordOf(b);
    const action = actionIdOf(b);
    const prev = byChord.get(chord);
    if (prev !== undefined && prev !== action) problems.push(`chord ${chord} is bound to both ${prev} and ${action}`);
    byChord.set(chord, action);
  }
  return problems;
}

// ------------------------------------------------------------------------------------- descriptions

/** Human-readable label of a KeyboardEvent.code for the key-help overlay and the HUD hints. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    Space: 'Space',
    Backspace: 'Backspace',
    Tab: 'Tab',
    CapsLock: 'Caps Lock',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    Period: '.',
    Comma: ',',
    Slash: '/',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`',
    Quote: "'",
    Semicolon: ';',
    Backslash: '\\',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    PageUp: 'Page Up',
    PageDown: 'Page Down',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num −',
    Enter: 'Enter',
    Escape: 'Esc',
  };
  if (named[code]) return named[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1]!;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
}

const SAS_LABEL: Record<SasMode, string> = {
  stability: 'Stability',
  prograde: 'Prograde',
  retrograde: 'Retrograde',
  normal: 'Normal',
  antinormal: 'Anti-normal',
  radialOut: 'Radial out',
  radialIn: 'Radial in',
  maneuver: 'Maneuver',
  target: 'Target',
  antiTarget: 'Anti-target',
  portAlign: 'Port alignment',
};

export type BindingGroup = 'Attitude' | 'Translation' | 'Throttle & staging' | 'SAS' | 'Systems' | 'Time & navigation' | 'Views' | 'Cockpit displays';

const AXIS_TEXT: Record<AxisAction, { group: BindingGroup; pos: string; neg: string }> = {
  pitch: { group: 'Attitude', pos: 'Pitch up', neg: 'Pitch down' },
  yaw: { group: 'Attitude', pos: 'Yaw right', neg: 'Yaw left' },
  roll: { group: 'Attitude', pos: 'Roll right', neg: 'Roll left' },
  translateX: { group: 'Translation', pos: 'Translate right', neg: 'Translate left' },
  translateY: { group: 'Translation', pos: 'Translate forward', neg: 'Translate back' },
  translateZ: { group: 'Translation', pos: 'Translate up', neg: 'Translate down' },
  throttleRate: { group: 'Throttle & staging', pos: 'Throttle up', neg: 'Throttle down' },
  cameraYaw: { group: 'Views', pos: 'Camera right', neg: 'Camera left' },
  cameraPitch: { group: 'Views', pos: 'Camera up', neg: 'Camera down' },
  cameraZoom: { group: 'Views', pos: 'Zoom out', neg: 'Zoom in' },
};

const BUTTON_TEXT: Record<Exclude<ButtonAction, `sas:${string}` | RetiredButtonAction> | UiAction, { group: BindingGroup; text: string }> = {
  stage: { group: 'Throttle & staging', text: 'Fire next stage' },
  abort: { group: 'Throttle & staging', text: 'Abort' },
  throttleFull: { group: 'Throttle & staging', text: 'Full throttle' },
  throttleCut: { group: 'Throttle & staging', text: 'Cut throttle' },
  toggleSas: { group: 'SAS', text: 'SAS on / off' },
  toggleRcs: { group: 'Systems', text: 'RCS on / off' },
  toggleLegs: { group: 'Systems', text: 'Landing gear' },
  toggleLights: { group: 'Systems', text: 'Lights' },
  toggleFineControl: { group: 'Attitude', text: 'Fine control' },
  toggleNavballMode: { group: 'Time & navigation', text: 'Navball surface / orbit' },
  warpUp: { group: 'Time & navigation', text: 'Faster time warp' },
  warpDown: { group: 'Time & navigation', text: 'Slower time warp' },
  warpStop: { group: 'Time & navigation', text: 'Stop time warp' },
  toggleMap: { group: 'Views', text: 'Map view' },
  cycleCamera: { group: 'Views', text: 'Cockpit / chase camera' },
  nextVessel: { group: 'Views', text: 'Next vessel' },
  prevVessel: { group: 'Views', text: 'Previous vessel' },
  toggleHud: { group: 'Views', text: 'Hide / show HUD' },
  flightMenu: { group: 'Time & navigation', text: 'Flight menu' },
  cycleTarget: { group: 'Time & navigation', text: 'Next target' },
  toggleRoster: { group: 'Views', text: 'Roster' },
  dockingView: { group: 'Views', text: 'Docking view' },
  openQuickComms: { group: 'Systems', text: 'Quick comms' },
  acceptPrompt: { group: 'Systems', text: 'Accept prompt' },
  'mfdCycle:0': { group: 'Cockpit displays', text: 'Left display page' },
  'mfdCycle:1': { group: 'Cockpit displays', text: 'Centre display page' },
  'mfdCycle:2': { group: 'Cockpit displays', text: 'Right display page' },
  'ui:keyHelp': { group: 'Views', text: 'Key help' },
  'ui:resetCamera': { group: 'Views', text: 'Reset camera' },
  'ui:nextSeat': { group: 'Views', text: 'Next couch (cockpit view)' },
};

/** What the offline game does on `flightMenu` while no page has a flight menu (`ServedActions.flightMenu`). */
const LOCAL_PAUSE_TEXT = 'Pause';

/**
 * Group and text of a binding for the key-help overlay, on a page that serves `served`: the line of
 * `flightMenu` names the flight menu where there is one and the pause that answers the key where there is not.
 */
export function describeBinding(b: Binding, served: ServedActions = {}): { group: BindingGroup; text: string } {
  if (b.kind === 'axis') {
    const t = AXIS_TEXT[b.action];
    return { group: t.group, text: b.value >= 0 ? t.pos : t.neg };
  }
  if (b.action.startsWith('sas:')) {
    const mode = b.action.slice(4) as SasMode;
    return { group: 'SAS', text: `Hold ${SAS_LABEL[mode] ?? mode}` };
  }
  if (b.action === 'flightMenu' && !isServed(b.action, served)) return { group: BUTTON_TEXT.flightMenu.group, text: LOCAL_PAUSE_TEXT };
  return BUTTON_TEXT[b.action as keyof typeof BUTTON_TEXT];
}

/** One line of the key-help overlay: every key producing the same action merged. */
export interface KeyHelpEntry {
  group: BindingGroup;
  text: string;
  keys: string[];
  /** Keys that only work while the keyboard is captured (fullscreen keyboard lock). */
  lockedKeys: string[];
  /**
   * Set on the line of a SAS hold against a target: the session serves the hold only while it lists the mode
   * in `Readouts.sasModesAvailable` (a vessel or port target is selected, and the session has such holds at
   * all), and the card shows the line only then, as the HUD's SAS row shows the mode's button. Absent: the
   * line is always shown.
   */
  sasMode?: SasTargetMode;
}

export const BINDING_GROUP_ORDER: readonly BindingGroup[] = ['Attitude', 'Throttle & staging', 'SAS', 'Translation', 'Systems', 'Time & navigation', 'Views', 'Cockpit displays'];

const sasTargetModeOf = (b: Binding): SasTargetMode | null => SAS_TARGET_MODES.find((mode) => b.kind === 'button' && b.action === `sas:${mode}`) ?? null;

/** A binding has a line on the reference card of a page that serves `served`: something answers its key there. */
function onCard(b: Binding, served: ServedActions): boolean {
  if (b.kind === 'axis') return true;
  if (b.requiresServed && !isServed(b.action, served)) return false;
  return !isDeferred(b.action) || isServed(b.action, served);
}

/**
 * Key-help content generated from a binding table, grouped and ordered for display: the reference card.
 * It lists what something serves. A deferred action (`DEFERRED_ACTIONS`) has its line only when `served`
 * names it; a key that waits for its consumer (`requiresServed`: Esc) is on its action's line only then; and
 * the lines of the SAS holds against a target carry `sasMode`, for the card to show them while the session
 * lists the mode. With nothing stated the card is the one of a page without the shared universe.
 */
export function keyHelpEntries(table: readonly Binding[], served: ServedActions = {}): KeyHelpEntry[] {
  const byId = new Map<string, KeyHelpEntry>();
  for (const b of table) {
    if (!onCard(b, served)) continue;
    const id = actionIdOf(b);
    const d = describeBinding(b, served);
    let e = byId.get(id);
    if (!e) {
      const hold = sasTargetModeOf(b);
      e = { group: d.group, text: d.text, keys: [], lockedKeys: [], ...(hold ? { sasMode: hold } : {}) };
      byId.set(id, e);
    }
    const label = [...(b.modifiers ?? []), keyLabel(b.code)].join(' + ');
    (b.requiresKeyboardLock ? e.lockedKeys : e.keys).push(label);
  }
  const out = [...byId.values()];
  out.sort((a, b) => BINDING_GROUP_ORDER.indexOf(a.group) - BINDING_GROUP_ORDER.indexOf(b.group));
  return out;
}
